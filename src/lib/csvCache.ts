const DB_NAME = 'kwizi-csv-cache-v1';
const STORE = 'data';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
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

async function digestMessage(message: string): Promise<string> {
  const msgUint8 = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function cacheVersionFor(urls: string[]): Promise<string> {
  return digestMessage(urls.join('\n'));
}

export async function readCache<T>(version: string): Promise<{ data: T | null; syncSignature: string | null }> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const store = tx.objectStore(STORE);
  const savedVersion = await promisify(store.get('version'));
  if (savedVersion !== version) return { data: null, syncSignature: null };
  const data = await promisify<T | undefined>(store.get('data'));
  const syncSignature = await promisify<string | undefined>(store.get('syncSignature'));
  return { data: data ?? null, syncSignature: syncSignature ?? null };
}

export async function writeCache<T>(version: string, data: T, syncSignature?: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  store.put(version, 'version');
  store.put(data, 'data');
  if (syncSignature !== undefined) {
    store.put(syncSignature, 'syncSignature');
  }
  await promisifyTx(tx);
}

export async function clearCache(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  store.delete('version');
  store.delete('data');
  await promisifyTx(tx);
}
