/**
 * /api/boundary-name-map — serves the ZIP-verified polygon→data name map
 * (map_cache/boundary_name_map.json, built by kwizi-python-tools/build_name_map.cjs).
 *
 * The PUBLIC map (anonymous) cannot read private Storage, so the server
 * bridges it with the SA. One ~200KB request per session; the browser caches
 * it hard (the map changes only when the builder re-runs after new uploads).
 */
import { NextResponse } from 'next/server';
import { getAdminStorageBucket, storageWithTimeout } from '@/lib/firebaseAdmin';

export const runtime = 'nodejs';

let cached: {
  entries: Record<string, string>;
  geoAssignments: Record<string, { n: number; close?: number; ppsf?: number; dom?: number; lot?: number; rent?: number }>;
  generated: number;
  /** The geo/zip-assignments file's own generation timestamp — when Storage's
   *  copy is NEWER than the cached one, the cache self-invalidates (the owner
   *  re-runs the builders between deploys; visitors must not wait 15 minutes
   *  for the updated fills). */
  geoGenerated: number;
  at: number;
} | null = null;
/** Short base TTL — the name map changes only after an upload, but the
 *  GEOMETRIC/ZIP assignments file changes independently (the builders run
 *  between deploys), so the cache re-checks Storage every 30s. */
const CACHE_MS = 30_000;

export async function GET() {
  try {
    if (cached && Date.now() - cached.at < CACHE_MS) {
      return NextResponse.json({ entries: cached.entries, geoAssignments: cached.geoAssignments, generated: cached.generated }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    const bucket = getAdminStorageBucket();
    const [nameBuf] = await storageWithTimeout(bucket.file('map_cache/boundary_name_map.json').download());
    const nameParsed = JSON.parse(nameBuf.toString('utf-8')) as { entries: Record<string, string>; generated: number };
    let geoAssignments: Record<string, { n: number; close?: number; ppsf?: number; dom?: number; lot?: number; rent?: number }> = {};
    let geoGenerated = 0;
    try {
      const [geoBuf] = await storageWithTimeout(bucket.file('map_cache/polygon_geo_assignments.json').download());
      const geoParsed = JSON.parse(geoBuf.toString('utf-8')) as { assignments: typeof geoAssignments; generated?: number };
      geoAssignments = geoParsed?.assignments ?? {};
      geoGenerated = geoParsed?.generated ?? 0;
    } catch {
      // the geometric assignments file may not exist yet
    }
    cached = {
      entries: nameParsed?.entries ?? {},
      geoAssignments,
      generated: nameParsed?.generated ?? 0,
      geoGenerated,
      at: Date.now(),
    };
    return NextResponse.json({ entries: cached!.entries, geoAssignments: cached!.geoAssignments, generated: cached!.generated }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    console.warn('[boundary-name-map] unavailable:', err instanceof Error ? err.message : err);
    return NextResponse.json({ entries: {}, geoAssignments: {} });
  }
}