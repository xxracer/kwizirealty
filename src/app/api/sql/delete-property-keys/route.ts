/**
 * /api/sql/delete-property-keys — deletes exactly the SQL rows a single
 * removed CSV file contributed.
 *
 * The browser sends the (mlsNumber, datasetYear) pairs it recomputed from the
 * file's own CSV backup with the same mapper used at staging time, so the
 * deleted keys match the staged keys exactly. Rows arrive chunked because one
 * file can hold tens of thousands of them.
 */
import { NextResponse } from 'next/server';
import { getAdminDataConnect } from '@/lib/firebaseAdmin';
import { guardPublicRead } from '@/lib/server/requestGuard';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** Keys per mutation call — keeps each JSON payload comfortably small. */
const CHUNK = 5000;

export async function POST(req: Request) {
  const blocked = guardPublicRead(req);
  if (blocked) return blocked;

  try {
    const body = (await req.json().catch(() => ({}))) as { keys?: unknown };
    const keys = (Array.isArray(body.keys) ? body.keys : []).filter(
      (k): k is { m: string; y: number } =>
        !!k && typeof (k as any).m === 'string' && Number.isFinite(Number((k as any).y))
    );
    if (keys.length === 0) {
      return NextResponse.json({ ok: true, deletedKeys: 0 });
    }

    const dc = getAdminDataConnect();
    let deletedKeys = 0;
    for (let i = 0; i < keys.length; i += CHUNK) {
      const chunk = keys.slice(i, i + CHUNK).map((k) => ({ m: k.m, y: Number(k.y) }));
      await dc.executeMutation('deletePropertiesByKeys', { keys: JSON.stringify(chunk) });
      deletedKeys += chunk.length;
    }
    return NextResponse.json({ ok: true, deletedKeys });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/sql/delete-property-keys] failed:', err);
    return NextResponse.json({ error: 'SQL delete failed', detail: message }, { status: 500 });
  }
}