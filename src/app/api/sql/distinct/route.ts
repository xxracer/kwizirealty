/**
 * /api/sql/distinct — dropdown option lists for the SQL-first map path.
 *
 * When the map is served by SQL Connect the browser holds NO property rows,
 * so the worker's datasetReady payload (unique values) is unavailable. This
 * route returns the six dropdown lists + the total row count in ONE round
 * trip (a few KB) instead of downloading the dataset.
 */
import { NextResponse } from 'next/server';
import { getAdminAuth, getAdminDataConnect } from '@/lib/firebaseAdmin';
import { guardPublicRead } from '@/lib/server/requestGuard';
import type { DatasetUniqueValues } from '@/lib/engineWorker/protocol';

export const runtime = 'nodejs';

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
      return NextResponse.json({ uniqueValues: empty, totalRows: 0 });
    }
    const uniqueValues: DatasetUniqueValues = {
      propertyType: row.property_types ?? [],
      city: row.cities ?? [],
      schoolDistrict: row.school_districts ?? [],
      elementary: row.elementary ?? [],
      middle: row.middle ?? [],
      highschools: row.highschools ?? [],
    };
    return NextResponse.json({ uniqueValues, totalRows: Number(row.total_rows ?? 0) });
  } catch (err) {
    console.error('[api/sql/distinct] failed:', err);
    return NextResponse.json({ error: 'Query failed' }, { status: 500 });
  }
}