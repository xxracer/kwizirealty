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

async function runStatus() {
  const dc = getAdminDataConnect();
  const res = await dc.executeQuery('datasetStatus', {});
  const row = (res.data as any)?.status;
  return {
    total: Number(row?.total ?? 0),
    committed: Number(row?.committed ?? 0),
    pending: Number(row?.pending ?? 0),
    lastUpdated: row?.last_updated ?? null,
  };
}

export async function POST(req: Request) {
  const blocked = guardPublicRead(req);
  if (blocked) return blocked;

  try {
    return NextResponse.json(await runStatus());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/sql/status] failed:', err);
    return NextResponse.json({ error: 'Status query failed', detail: message }, { status: 500 });
  }
}

export async function GET(req: Request) {
  const blocked = guardPublicRead(req);
  if (blocked) return blocked;

  try {
    return NextResponse.json(await runStatus());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/sql/status] failed:', err);
    return NextResponse.json({ error: 'Status query failed', detail: message }, { status: 500 });
  }
}
