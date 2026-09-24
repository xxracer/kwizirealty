/**
 * /api/search — row-level property search over SQL (Data Connect).
 *
 * The map's search box matches address / zip / MLS number / city. With the
 * SQL-primary map the browser holds no property rows, so the search runs in
 * Postgres via the `searchProperties` op and returns just enough of each row
 * for the client to focus + select it.
 */
import { NextResponse } from 'next/server';
import { getAdminDataConnect } from '@/lib/firebaseAdmin';
import { guardPublicRead } from '@/lib/server/requestGuard';
import { getDatasetVersionTag } from '@/lib/server/datasetVersion';
import {
  generateETag,
  isMatch,
  notModifiedResponse,
  withETag,
} from '@/lib/server/etag';

export const runtime = 'nodejs';

const SEARCH_LIMIT = 20;

export async function POST(req: Request) {
  const blocked = guardPublicRead(req);
  if (blocked) return blocked;

  let query = '';
  try {
    const body = await req.json();
    query = typeof body?.query === 'string' ? body.query.trim() : '';
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }
  if (!query) return NextResponse.json({ results: [] });

  // Conditional cache: ETag from the search query + dataset version.
  const cacheKey = { query };
  const datasetVersion = await getDatasetVersionTag();
  const etag = generateETag(cacheKey, datasetVersion);
  if (isMatch(req, etag)) {
    return notModifiedResponse(etag);
  }

  // ILIKE literal: escape the LIKE metacharacters, then wrap in wildcards.
  const escaped = query.replace(/[\\%_]/g, (m) => `\\${m}`);
  const pattern = `%${escaped}%`;

  try {
    const dc = getAdminDataConnect();
    const res = await dc.executeQuery('searchProperties', { q: pattern, limit: SEARCH_LIMIT });
    const rows: any[] = (res.data as any)?.results || [];
    return withETag({
      results: rows.map((r) => ({
        id: r.mls_number ?? '',
        address: r.address ?? '',
        city: r.city ?? '',
        zip: r.zip ?? '',
        lat: r.lat ?? 0,
        lng: r.lng ?? 0,
        closePrice: r.close_price ?? 0,
        subdivisions: r.subdivisions ?? '',
        zipcodes: r.zipcodes ?? '',
        schoolDistrict: r.school_district ?? '',
        marketArea: r.market_area ?? '',
        area: r.area ?? '',
        elementary: r.elementary ?? '',
        middle: r.middle ?? '',
        highschools: r.highschools ?? '',
      })),
    }, etag);
  } catch (err) {
    console.error('[api/search] failed:', err);
    return NextResponse.json({ error: 'Search failed' }, { status: 500 });
  }
}