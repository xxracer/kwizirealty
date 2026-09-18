const LEGACY_DB_NAME = 'kwizi-csv-cache-v1';
const DB_NAME = 'kwizi-cache-v2';
const DATASET_STORE = 'dataset';
const GEO_STORE = 'geojson';

/**
 * Version-keyed browser cache. The FIRST browser-cache design stored rows
 * against a key derived from a fixed-name manifest, and one stale manifest
 * fetch (Firebase Storage serves those with a 1-hour HTTP cache) made the key
 * match the old dataset — deleted rows were restored forever. The fix is
 * structural: every cache entry is stored WITH the data version it was built
 * from (the dataset manifest version / the boundary file's uploadedAt), and
 * a read only returns a hit when the version matches EXACTLY. New data always
 * means a new version, so a stale entry can never be served — it is simply a
 * miss, followed by a fresh download that overwrites the entry.
 *
 * The version itself is always fetched with `cache: 'no-store'` (manifest,
 * Firestore metadata), so it can never lie about which data is current.
 */

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(DATASET_STORE);
      req.result.createObjectStore(GEO_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function promisifyTx(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function cacheVersionFor(urls: string[]): Promise<string> {
  // In-memory dataset version digest (no persistence) — used to detect
  // manifest version changes between loads.
  const msgUint8 = new TextEncoder().encode(urls.join('\n'));
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface VersionedEntry<T> {
  version: number;
  data: T;
}

/** Rows for an exact dataset version, or null on miss/version mismatch. */
export async function readDatasetCache<T>(version: number): Promise<T | null> {
  if (!version) return null;
  try {
    const db = await openDb();
    const tx = db.transaction(DATASET_STORE, 'readonly');
    const entry = await promisify<VersionedEntry<T> | undefined>(tx.objectStore(DATASET_STORE).get('rows'));
    return entry && entry.version === version ? entry.data : null;
  } catch {
    return null; // cache must never break the load
  }
}

export async function writeDatasetCache<T>(version: number, data: T): Promise<void> {
  if (!version) return;
  try {
    const db = await openDb();
    const tx = db.transaction(DATASET_STORE, 'readwrite');
    tx.objectStore(DATASET_STORE).put({ version, data } satisfies VersionedEntry<T>, 'rows');
    await promisifyTx(tx);
  } catch {
    // cache write is best-effort
  }
}

/** Parsed GeoJSON for an exact boundary version (uploadedAt), or null. */
export async function readGeoCache<T>(key: string, version: number): Promise<T | null> {
  if (!version) return null;
  try {
    const db = await openDb();
    const tx = db.transaction(GEO_STORE, 'readonly');
    const entry = await promisify<VersionedEntry<T> | undefined>(tx.objectStore(GEO_STORE).get(key));
    return entry && entry.version === version ? entry.data : null;
  } catch {
    return null;
  }
}

export async function writeGeoCache<T>(key: string, version: number, data: T): Promise<void> {
  if (!version) return;
  try {
    const db = await openDb();
    const tx = db.transaction(GEO_STORE, 'readwrite');
    tx.objectStore(GEO_STORE).put({ version, data } satisfies VersionedEntry<T>, key);
    await promisifyTx(tx);
  } catch {
    // cache write is best-effort
  }
}

export async function dropGeoCache(key: string): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(GEO_STORE, 'readwrite');
    tx.objectStore(GEO_STORE).delete(key);
    await promisifyTx(tx);
  } catch {
    // best-effort
  }
}

/**
 * One-time cleanup of the LEGACY (pre-versioning) cache database. A version
 * mismatch in the new DB self-invalidates, but the old DB's entries were
 * keyed by a URL digest and can never match — so the database is deleted
 * outright on map mount.
 */
export async function purgeDatasetCache(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    try {
      const req = indexedDB.deleteDatabase(LEGACY_DB_NAME);
      req.onsuccess = done;
      req.onerror = done;
      req.onblocked = done; // a legacy worker still holds it — proceed anyway
      setTimeout(done, 3000); // never hang the page on cache cleanup
    } catch {
      done();
    }
  });
}