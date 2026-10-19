/**
 * /api/sql/distinct — dropdown option lists for the SQL-first map path.
 *
 * When the map is served by SQL Connect the browser holds NO property rows,
 * so the worker's datasetReady payload (unique values) is unavailable. This
 * route returns the six dropdown lists + the total row count in ONE round
 * trip (a few KB) instead of downloading the dataset.
 *
 * SPEED (measured 2026-10-18: the distinctValues aggregate = ~4s of Postgres
 * on every fresh map load): the list only changes with the DATA — cache the
 * built response in module memory keyed by the dataset version tag (same
 * tag /api/query uses). A warm instance answers in ~1ms; cold ones recompute
 * once and hold the result.
 */
import { NextResponse } from 'next/server';
import { getAdminAuth, getAdminDataConnect } from '@/lib/firebaseAdmin';
import { getDatasetVersionTag } from '@/lib/server/datasetVersion';
import { guardPublicRead } from '@/lib/server/requestGuard';
import type { DatasetUniqueValues } from '@/lib/engineWorker/protocol';

export const runtime = 'nodejs';

interface DistinctCacheEntry {
  version: string;
  body: { uniqueValues: DatasetUniqueValues; zipcodes: string[]; totalRows: number };
}
let memCache: Map<string, DistinctCacheEntry> = new Map();
const MEM_TTL_MS = 10 * 60_000;
let memAt = 0;

export async function POST(req: Request) {
  // The map is open to signed-out visitors, so the token is optional —
  // same-origin + rate limiting protect this endpoint instead.
  const blocked = guardPublicRead(req);
  if (blocked) return blocked;
  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (token) {
    try {
      await getAdminAuth().verifyIdToken(token);
    } catch {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const version = await getDatasetVersionTag();
    const hit = memCache.get(version);
    if (hit && Date.now() - memAt < MEM_TTL_MS) {
      return NextResponse.json(hit.body);
    }
    const dc = getAdminDataConnect();
    const res = await dc.executeQuery('distinctValues', {});
    const row = (res.data as any)?.values;
    if (!row) {
      // Empty table → empty lists (an empty published dataset is valid).
      const empty: DatasetUniqueValues = {
        propertyType: [],
        city: [],
        schoolDistrict: [],
        elementary: [],
        middle: [],
        highschools: [],
      };
      const body = { uniqueValues: empty, zipcodes: [] as string[], totalRows: 0 };
      memCache.set(version, { version, body });
      memAt = Date.now();
      return NextResponse.json(body);
    }
    const uniqueValues: DatasetUniqueValues = {
      propertyType: row.property_types ?? [],
      city: row.cities ?? [],
      schoolDistrict: row.school_districts ?? [],
      elementary: row.elementary ?? [],
      middle: row.middle ?? [],
      highschools: row.highschools ?? [],
    };
    // Zip codes live with the uploaded data too (owner rule 2026-10-15).
    const zipcodes: string[] = row.zipcodes ?? [];
    const body = { uniqueValues, zipcodes, totalRows: Number(row.total_rows ?? 0) };
    // one entry per dataset version; drop stale versions
    const fresh: Map<string, DistinctCacheEntry> = new Map([[version, { version, body }]]);
    if (hit) fresh.set(hit.version, hit);
    memCache = fresh;
    memAt = Date.now();
    return NextResponse.json(body);
  } catch (err) {
    console.error('[api/sql/distinct] failed:', err);
    return NextResponse.json({ error: 'Query failed' }, { status: 500 });
  }
}