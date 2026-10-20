/**
 * polyStageAssign — assigns `polyIdSubdivisions` to staged SQL rows IN THE
 * BROWSER at CSV upload time, against the CURRENT `Mapped Subdivisions.geojson`
 * in Firebase Storage (so every new upload starts with its polygon ids set
 * and lands on the map correctly at its "Add All" commit).
 *
 * The index is cached on the browser for the file's identity (name +
 * uploadedAt + size), so repeated staging per upload batch is cheap. The
 * other classes (zip/schools) are filled after commit by the resumable
 * /api/sql/assign-poly run — their files are far too big to parse on every
 * upload.
 */
import { cmsStore } from '@/lib/cmsStore';
import { buildPolyIndex, assignPoly, type PolyIndex } from '@/lib/polyMatch';
import { POLY_NAME_SPECS } from '@/lib/boundaryFiles';

const SUBDIVISIONS_SPEC = POLY_NAME_SPECS.subdivisions; // nameProps + clean (map exact mirror)
const SRC_FILE = 'Mapped Subdivisions.geojson';
const INDEX_CACHE_KEY = 'kwizi-poly-stage-index:v1';

let cached: { identity: string; index: PolyIndex } | null = null;

async function loadIndex(): Promise<PolyIndex> {
  const records = await cmsStore.listFilesMetadataByCategory('boundary');
  const record = records
    .filter((r) => r.name === SRC_FILE)
    .sort((a, b) => (b.uploadedAt ?? 0) - (a.uploadedAt ?? 0))[0];
  if (!record?.storageUrl) return buildPolyIndex([]);
  const identity = `${record.uploadedAt ?? 0}:${record.size ?? 0}`;
  if (cached?.identity === identity) return cached.index;
  try {
    const text = await fetchBoundaryText(record.storageUrl);
    const parsed = JSON.parse(text) as GeoJSON.FeatureCollection;
    const index = buildPolyIndex(parsed.features ?? [], SUBDIVISIONS_SPEC);
    cached = { identity, index };
    return index;
  } catch {
    // Don't block staging forever on a bad/unreachable file — an empty index
    // leaves the staging column empty; the after-commit job fills it.
    return buildPolyIndex([]);
  }
}

async function fetchBoundaryText(url: string): Promise<string> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Boundary fetch failed (${res.status})`);
  const buf = await res.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 2));
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const ds = (globalThis as unknown as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
    if (!ds) throw new Error('Browser does not support gzip decompression.');
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(buf));
        c.close();
      },
    });
    return new Response(stream.pipeThrough(new ds('gzip'))).text();
  }
  return new TextDecoder().decode(buf);
}

/** Stamps row.polyIdSubdivisions in place; returns how many rows got a polygon. */
export async function assignStagedSubdivisions(
  rows: { lat?: number | string; lng?: number | string; polyIdSubdivisions?: string }[]
): Promise<number> {
  const index = await loadIndex();
  if (index.entries.length === 0) return 0;
  let assigned = 0;
  for (const row of rows) {
    const lat = Number(row.lat);
    const lng = Number(row.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const name = assignPoly(lat, lng, index);
    if (name) {
      row.polyIdSubdivisions = name;
      assigned++;
    }
  }
  return assigned;
}

export { INDEX_CACHE_KEY };