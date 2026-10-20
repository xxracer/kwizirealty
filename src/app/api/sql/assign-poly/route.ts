/**
 * /api/sql/assign-poly — per-class, paged, resumable point-in-polygon
 * assignment of the live `properties` rows to their boundary polygons.
 *
 * One POST call = ONE page for ONE class: resolve the class's CURRENT Storage
 * boundary file (latest cms_files record), assign that page's rows, write the
 * polygon columns back (ONLY those columns; staged rows and other classes
 * are never touched), and return the next keyset cursor. The caller (admin
 * page, polyAssignClient) loops until nextCursor is null and accumulates the
 * audit. A fresh boundary re-upload re-runs with onlyUnassigned:false.
 */
import { NextResponse } from 'next/server';
import { getAdminDataConnect, getAdminFirestore, dcWithTimeout } from '@/lib/firebaseAdmin';
import { guardPublicRead } from '@/lib/server/requestGuard';
import { buildPolyIndex, assignPoly, type PolyIndex } from '@/lib/polyMatch';
import { BOUNDARY_SOURCES, POLY_ASSIGN_CLASSES, POLY_NAME_SPECS, type PolyAssignClass } from '@/lib/boundaryFiles';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** Rows per page — keeps the backfill UPDATE batches comfortably small. */
const PAGE = 5000;
/** Rows written per backfillPolyColumns call (same chunk rationale as
 *  delete-properties route: small JSON payloads). */
const CHUNK = 5000;

/** class → json key in backfillPolyColumns. */
const COLUMN_KEY: Record<PolyAssignClass, string> = {
  subdivisions: 's',
  zipcodes: 'z',
  highschools: 'h',
  elementary: 'e',
  middle: 'd',
};
const PAGE_OP: Record<PolyAssignClass, string> = {
  subdivisions: 'polyBackfillPageSubdivisions',
  zipcodes: 'polyBackfillPageZipcodes',
  highschools: 'polyBackfillPageHighschools',
  elementary: 'polyBackfillPageElementary',
  middle: 'polyBackfillPageMiddle',
};

interface BackfillRow {
  mls_number: string;
  dataset_year: number;
  lat: number;
  lng: number;
  close_price: number | null;
}

const geoCache = new Map<string, string>(); // cache key → raw geojson text

async function loadBoundaryText(cls: PolyAssignClass): Promise<string> {
  const fileName = BOUNDARY_SOURCES[cls];
  // Equality-only query: (name == file) needs NO composite index. Sort by
  // uploadedAt here — Firebase requires a composite index for orderBy on a
  // filtered group, and a manual index is a step this job should never need.
  const snap = await getAdminFirestore()
    .collection('cms_files')
    .where('name', '==', fileName)
    .get();
  const records = snap.docs
    .map((d) => d.data())
    .filter(Boolean) as { storageUrl?: string; uploadedAt?: number; size?: number }[];
  const record = records
    .sort((a, b) => (b.uploadedAt ?? 0) - (a.uploadedAt ?? 0))[0];
  if (!record?.storageUrl) throw new Error(`No boundary file record for ${fileName} (upload it first)`);
  // Cache per storage URL; refuse to cache records missing size/uploadedAt —
  // a metadata-poor record could otherwise serve stale geometry after a
  // re-upload (warm container keeps tmp alive across calls).
  const cacheKey = `${record.uploadedAt ?? 0}:${record.size ?? 0}:${record.storageUrl}`;
  const cached = record.uploadedAt != null && record.size != null ? geoCache.get(cacheKey) : undefined;
  if (cached !== undefined) return cached;
  const text = await downloadDecompressed(record.storageUrl);
  if (geoCache.size > 8) geoCache.clear(); // tiny LRU — five classes max
  if (record.uploadedAt != null && record.size != null) geoCache.set(cacheKey, text);
  return text;
}

async function downloadDecompressed(url: string): Promise<string> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Boundary download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!(buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b)) {
    return buf.toString('utf8');
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(buf));
      controller.close();
    },
  });
  const streamPipe = stream.pipeThrough(
    new CompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
  );
  const text = await new Response(streamPipe).text();
  return text;
}

function parseFeatures(json: string): GeoJSON.Feature[] {
  const parsed = JSON.parse(json) as
    | GeoJSON.FeatureCollection
    | { features?: unknown };
  if (!parsed || !Array.isArray((parsed as GeoJSON.FeatureCollection).features)) {
    throw new Error('Boundary file is not a GeoJSON FeatureCollection');
  }
  return (parsed as GeoJSON.FeatureCollection).features;
}

export async function POST(req: Request) {
  const blocked = guardPublicRead(req);
  if (blocked) return blocked;

  let body: {
    class?: string;
    cursor?: { m?: string; y?: number };
    onlyUnassigned?: boolean;
    status?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const cls = body.class as PolyAssignClass;
  if (!cls || !POLY_ASSIGN_CLASSES.includes(cls)) {
    return NextResponse.json({ error: 'Unknown boundary class' }, { status: 400 });
  }

  if (body.status) {
    // Audit probe: how far along is this class's assignment right now.
    try {
      const res = await getAdminDataConnect().executeQuery('polyAssignmentStatus', {} as never);
      const status = ((res.data as { status?: Record<string, number> } | undefined)?.status) ?? {};
      return NextResponse.json({ status });
    } catch (err) {
      return NextResponse.json(
        { error: 'Status probe failed', detail: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }
  }
  const onlyUnassigned = body.onlyUnassigned ?? true;

  try {
    const dc = getAdminDataConnect();
    const features = parseFeatures(await loadBoundaryText(cls));
    const index: PolyIndex = buildPolyIndex(features, POLY_NAME_SPECS[cls]);
    if (index.entries.length === 0) {
      // Empty upload (e.g. Zip.geojson currently sits at 42 bytes) OR the
      // file's features carry no usable name property for this class — the
      // class has nothing to assign against; done immediately, no hang, no
      // 140-page silent walk.
      return NextResponse.json({ pagesDone: 0, assigned: 0, nextCursor: null, perPoly: {} });
    }

    const page = await dcWithTimeout(
      dc.executeQuery(PAGE_OP[cls], {
        afterMls: body.cursor?.m ?? '',
        afterYear: body.cursor?.y ?? 0,
        limit: PAGE,
        onlyUnassigned,
      } as never),
    );
    const rows = (((page as { data?: { rows?: unknown } }).data?.rows ?? []) as BackfillRow[]);
    if (rows.length === 0) {
      return NextResponse.json({ pagesDone: 0, assigned: 0, nextCursor: null, perPoly: {} });
    }

    // Assign + collect this page's per-polygon tallies (client sums pages
    // into the audit).
    // - onlyUnassigned mode: rows with no polygon keep their column untouched
    //   (they're the unassigned pool) — write ONLY assigned rows, so the run
    //   doesn't churn every row's updated_at (ETag storms for every visitor).
    // - full mode (boundary re-uploaded / manual re-run): write '' for rows
    //   the NEW geometry no longer contains — a re-assignment must be able to
    //   CLEAR stale ids; '' passes COALESCE and resets the column.
    const perPoly: Record<string, { count: number; prices: number[] }> = {};
    const batchRows: { m: string; y: number; [k: string]: string | number }[] = [];
    for (const row of rows) {
      const name = Number.isFinite(row.lat) && Number.isFinite(row.lng)
        ? assignPoly(row.lat, row.lng, index)
        : '';
      const base = { m: row.mls_number, y: Number(row.dataset_year) };
      if (name) {
        const agg = (perPoly[name] ?? (perPoly[name] = { count: 0, prices: [] }));
        agg.count++;
        if ((row.close_price ?? 0) > 0) agg.prices.push(row.close_price as number);
        batchRows.push({ ...base, [COLUMN_KEY[cls]]: name });
      } else if (!onlyUnassigned) {
        batchRows.push({ ...base, [COLUMN_KEY[cls]]: '' });
      }
      // onlyUnassigned && !name → skip entirely (no UPDATE, no ETag churn).
    }
    const assignedCount = batchRows.filter((r) => r[COLUMN_KEY[cls]] !== '').length;

    for (let i = 0; i < batchRows.length; i += CHUNK) {
      await dc.executeMutation('backfillPolyColumns', {
        rows: JSON.stringify(batchRows.slice(i, i + CHUNK)),
      });
    }

    const last = rows[rows.length - 1];
    return NextResponse.json({
      pagesDone: 1,
      assigned: assignedCount,
      nextCursor: { m: last.mls_number, y: Number(last.dataset_year) },
      perPoly,
    });
  } catch (err) {
    console.error('[api/sql/assign-poly] failed:', err);
    return NextResponse.json(
      { error: 'Polygon assignment failed', detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}