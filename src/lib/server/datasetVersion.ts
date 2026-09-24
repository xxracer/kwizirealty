/**
 * datasetVersion.ts — builds a cache-busting tag for conditional HTTP caching.
 *
 * The tag combines:
 *   - the latest `updated_at` from the SQL `properties` table,
 *   - the published `cms_meta/sql_sync` version,
 *   - the latest CMS metric override timestamp,
 *   - the latest CMS property override timestamp.
 *
 * Any change to data or overrides changes the tag, which changes the ETag and
 * forces the browser to re-fetch. Unchanged data returns 304 Not Modified.
 */
import { getAdminDataConnect } from '@/lib/firebaseAdmin';
import { getFirestore } from 'firebase-admin/firestore';

const SQL_SYNC_DOC = { collection: 'cms_meta', id: 'sql_sync' };
const OVERRIDES_COLLECTION = 'cms_overrides';
const PROPERTY_OVERRIDES_COLLECTION = 'cms_property_overrides';

export async function getDatasetVersionTag(): Promise<string> {
  const dc = getAdminDataConnect();
  const db = getFirestore();

  // 1. SQL side: max(updated_at) of committed rows.
  let sqlUpdatedAt = '';
  let sqlTotalRows = 0;
  try {
    const res = await dc.executeQuery('datasetVersion', {});
    const version = (res.data as any)?.version ?? {};
    sqlUpdatedAt = String(version.updated_at ?? '');
    sqlTotalRows = Number(version.total_rows ?? 0);
  } catch (err) {
    console.warn('[datasetVersion] SQL version query failed:', err);
  }

  // 2. Firestore published dataset version.
  let syncVersion = '';
  try {
    const snap = await db.collection(SQL_SYNC_DOC.collection).doc(SQL_SYNC_DOC.id).get();
    if (snap.exists) {
      const data = snap.data();
      syncVersion = String(data?.version ?? data?.updatedAt?.toMillis?.() ?? '');
    }
  } catch (err) {
    console.warn('[datasetVersion] sql_sync read failed:', err);
  }

  // 3. Last CMS metric override.
  let lastOverride = '';
  try {
    const q = await db
      .collection(OVERRIDES_COLLECTION)
      .orderBy('updatedAt', 'desc')
      .limit(1)
      .get();
    if (!q.empty) {
      lastOverride = String(q.docs[0].data().updatedAt ?? '');
    }
  } catch (err) {
    console.warn('[datasetVersion] override read failed:', err);
  }

  // 4. Last CMS single-property override.
  let lastPropertyOverride = '';
  try {
    const q = await db
      .collection(PROPERTY_OVERRIDES_COLLECTION)
      .orderBy('updatedAt', 'desc')
      .limit(1)
      .get();
    if (!q.empty) {
      lastPropertyOverride = String(q.docs[0].data().updatedAt ?? '');
    }
  } catch (err) {
    console.warn('[datasetVersion] property override read failed:', err);
  }

  return [sqlUpdatedAt, sqlTotalRows, syncVersion, lastOverride, lastPropertyOverride].join('|');
}
