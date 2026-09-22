/**
 * /api/sql/import — direct CSV → SQL Connect ingestion.
 *
 * The admin panel POSTs parsed CSV rows here instead of sending them to
 * Firebase Storage. The endpoint upserts them into the `properties` table
 * (keyed by mls_number) and bumps the dataset version in Firestore
 * (cms_meta/sql_sync) so the map picks up the change immediately.
 */
import { NextResponse } from 'next/server';
import { getAdminAuth, getAdminDataConnect } from '@/lib/firebaseAdmin';
import { guardPublicRead } from '@/lib/server/requestGuard';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { csvRowsToSqlPropertyRows, type SqlImportType } from '@/lib/sqlImport';

export const runtime = 'nodejs';
export const maxDuration = 300; // large uploads need time

const UPSERT_BATCH = 250;
const STATE_DOC = { collection: 'cms_meta', id: 'sql_sync' };

interface ImportBody {
  rows: Record<string, string>[];
  type: SqlImportType;
  fileName?: string;
  mode?: 'upsert' | 'replace';
}

export async function POST(req: Request) {
  // Same auth model as /api/sql/sync: Firebase token, CRON secret, or
  // same-origin public call from the admin/map.
  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const cronSecret = process.env.CRON_SECRET || '';
  if (!token || (cronSecret && token !== cronSecret)) {
    if (token) {
      try {
        await getAdminAuth().verifyIdToken(token);
      } catch {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    } else {
      const blocked = guardPublicRead(req);
      if (blocked) return blocked;
    }
  }

  let body: ImportBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }

  const { rows, type, mode = 'upsert' } = body;
  if (!Array.isArray(rows) || rows.length === 0 || !type) {
    return NextResponse.json({ error: 'Bad request: rows and type required' }, { status: 400 });
  }
  if (mode !== 'upsert' && mode !== 'replace') {
    return NextResponse.json({ error: 'Bad request: mode must be upsert or replace' }, { status: 400 });
  }

  let sqlRows: Record<string, unknown>[];
  try {
    sqlRows = csvRowsToSqlPropertyRows(rows, type);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Import mapping failed: ${message}` }, { status: 400 });
  }

  if (sqlRows.length === 0) {
    return NextResponse.json({ error: 'No valid rows found in the upload.' }, { status: 400 });
  }

  const dc = getAdminDataConnect();
  const db = getFirestore();
  const stateRef = db.collection(STATE_DOC.collection).doc(STATE_DOC.id);

  // Replace mode: clear the table first. Use with care — intended for a
  // complete dataset re-upload, not a single file.
  if (mode === 'replace') {
    await dc.executeMutation('clearProperties', {});
  }

  for (let i = 0; i < sqlRows.length; i += UPSERT_BATCH) {
    await dc.upsertMany('Property', sqlRows.slice(i, i + UPSERT_BATCH));
  }

  // Count live rows and publish the new dataset version.
  // (distinctValues already exists in the deployed connector and returns the
  // total row count as total_rows, so no new Data Connect deploy is required.)
  const countRes = await dc.executeQuery('distinctValues', {});
  const totalRows = Number((countRes.data as any)?.values?.total_rows ?? 0);
  const version = Date.now();
  await stateRef.set(
    {
      version,
      syncedChunks: [],
      done: true,
      totalRows,
      updatedAt: FieldValue.serverTimestamp(),
      importedAt: FieldValue.serverTimestamp(),
      importedFile: body.fileName || '',
    },
    { merge: true }
  );

  return NextResponse.json({
    ok: true,
    imported: sqlRows.length,
    totalRows,
    version,
    mode,
  });
}
