/**
 * /api/sql/status — diagnostic endpoint for the SQL dataset.
 *
 * Returns committed vs pending row counts so the admin can see whether uploaded
 * CSVs are stuck in staging (upload_session_id IS NOT NULL) and invisible to
 * the map.
 */
import { NextResponse } from 'next/server';
import { getAdminDataConnect } from '@/lib/firebaseAdmin';
import { guardPublicRead } from '@/lib/server/requestGuard';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const blocked = guardPublicRead(req);
  if (blocked) return blocked;

  try {
    const dc = getAdminDataConnect();
    const res = await dc.executeQuery('datasetStatus', {});
    const row = (res.data as any)?.status;
    return NextResponse.json({
      total: Number(row?.total ?? 0),
      committed: Number(row?.committed ?? 0),
      pending: Number(row?.pending ?? 0),
      lastUpdated: row?.last_updated ?? null,
    });
  } catch (err) {
    console.error('[api/sql/status] failed:', err);
    return NextResponse.json({ error: 'Status query failed' }, { status: 500 });
  }
}
