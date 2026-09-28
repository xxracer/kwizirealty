/**
 * /api/sql/clear-listing-types — section-scoped SQL wipe for the admin
 * "Delete all" flow.
 *
 * Deleting the Firestore/Storage file docs alone leaves the rows already
 * upserted into SQL visible on the map forever. This route deletes the SQL
 * rows that belong to the deleted section, using the same listing_type
 * buckets the import mapper writes:
 *   sale → sales/current-sale, rent → rent/current-rent, tax → tax.
 * An empty list wipes the whole table (dashboard "Delete all").
 */
import { NextResponse } from 'next/server';
import { getAdminDataConnect } from '@/lib/firebaseAdmin';
import { guardPublicRead } from '@/lib/server/requestGuard';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const blocked = guardPublicRead(req);
  if (blocked) return blocked;

  try {
    const body = (await req.json().catch(() => ({}))) as { types?: unknown; dateMode?: unknown };
    const types = Array.isArray(body.types)
      ? body.types.filter((t): t is string => typeof t === 'string')
      : [];
    const dateMode = body.dateMode === 'dated' || body.dateMode === 'undated' ? body.dateMode : 'any';

    const dc = getAdminDataConnect();
    await dc.executeMutation('deletePropertiesByListingTypes', { types, dateMode });
    return NextResponse.json({ ok: true, deletedTypes: types, dateMode });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/sql/clear-listing-types] failed:', err);
    return NextResponse.json({ error: 'SQL delete failed', detail: message }, { status: 500 });
  }
}