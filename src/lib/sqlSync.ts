/**
 * sqlSync.ts — client driver that keeps the SQL Connect table mirrored with
 * the published Firebase Storage dataset, fully automatic.
 *
 * After every dataset rebuild (and on admin mount) the driver loops
 * POST /api/sql/sync — one chunk ingested per call, resumable — until the
 * route reports `done`. The route is the brain; this file only keeps calling
 * it and records readiness so the map page knows when SQL serves complete
 * data (a partial sync must never feed the map: the worker path stays active
 * until the synced version matches the manifest version).
 */
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';

export const SQL_SYNC_STATE_PATH = 'cms_meta/sql_sync';

export interface SqlSyncState {
  version: number;
  done: boolean;
}

async function callSync(): Promise<{ done: boolean; version: number } | null> {
  // The token is optional: signed-out visitors on the public map must also be
  // able to drive the mirror while they wait for it (the route is protected
  // by same-origin + rate limiting and only ingests from Storage).
  const token = await auth.currentUser?.getIdToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch('/api/sql/sync', {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  });
  if (!res.ok) return null;
  return res.json();
}

/** Drives the sync loop to completion. Safe to call concurrently: the flag
 *  serializes callers, and the route is idempotent per chunk. */
let syncing = false;

export async function runSqlSync(): Promise<void> {
  if (syncing) return;
  syncing = true;
  try {
    for (let guard = 0; guard < 5000; guard++) {
      const result = await callSync();
      if (!result) return; // offline / unauthenticated — retried on next trigger
      if (result.done) return;
    }
  } catch {
    // The next rebuild or admin mount re-triggers the loop; never surface.
  } finally {
    syncing = false;
  }
}

/** Readiness for the map page: true only when the synced version exists and
 *  the route finished it. Read straight from Firestore (cheap doc read). */
export async function readSqlSyncState(): Promise<SqlSyncState | null> {
  try {
    const snap = await getDoc(doc(db, 'cms_meta', 'sql_sync'));
    if (!snap.exists) return null;
    const data = snap.data() as { version?: number; done?: boolean };
    return { version: data.version ?? 0, done: data.done === true };
  } catch {
    return null;
  }
}