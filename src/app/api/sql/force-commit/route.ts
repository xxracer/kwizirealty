/**
 * /api/sql/force-commit — emergency utility to promote all staged rows.
 *
 * When CSV uploads are stuck pending (upload_session_id IS NOT NULL) and the
 * map shows 0 properties, calling this route makes every staged row visible
 * immediately by setting upload_session_id to NULL.
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
    await dc.executeMutation('commitPendingProperties', {});
    return NextResponse.json({ ok: true, message: 'All pending properties are now visible on the map.' });
  } catch (err) {
    console.error('[api/sql/force-commit] failed:', err);
    return NextResponse.json({ error: 'Force commit failed' }, { status: 500 });
  }
}
