/**
 * cacheBuster.ts — automatic client-side cache invalidation on new deploys.
 *
 * Next.js/Vercel serves static JS chunks with long cache headers. When a critical
 * fix ships (e.g. the SQL sync check, the map bounds fix), returning visitors
 * may continue running an old bundle and stale IndexedDB/Firebase-persisted
 * state until they manually clear cache. This module detects a build version
 * change and forces a hard reload after clearing every browser cache layer the
 * app controls.
 *
 * It also implements the GLOBAL cache clear: the owner's "Clear cache & reload"
 * bumps `cms_config/cache-clear` in Firestore, and every visitor's tab watches
 * that doc and wipes + reloads at its next tick.
 */
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from './firebase';

const VERSION_KEY = 'kwizi_app_version';
/** Global cache-clear epoch — the OWNER's "Clear cache & reload" bumps a
 *  Firestore doc (cms_config/cache-clear); every visitor's tab watches it and
 *  wipes + reloads at the next tick. The locally-seen epoch lives in
 *  localStorage and is re-set AFTER the wipe (a wipe erases everything). */
const GLOBAL_EPOCH_KEY = 'kwizi_global_cache_clear';

/** Reads the build version injected by Next.js at build time. */
function getBuildVersion(): string {
  return process.env.NEXT_PUBLIC_APP_VERSION || process.env.NEXT_PUBLIC_GIT_SHA || 'unknown';
}

/** Wipe the app's IndexedDB data. THE OLD WAY (plain deleteDatabase) was the
 *  bug behind the "Clear cache & reload" button doing nothing: csvCache keeps
 *  connections open for the page lifetime, an open connection BLOCKS
 *  deleteDatabase, onblocked returned immediately and the page reloaded before
 *  the deletion could happen.
 *  Now: (1) close the app's own connections, (2) clear every OBJECT STORE of
 *  each database via a readwrite transaction — clearing stores cannot be
 *  blocked by other connections, unlike deleting the database — and only then
 *  (3) best-effort deleteDatabase (harmless when it succeeds, no-op when
 *  blocked). Firebase Auth's firebaseLocalStorageDb is intentionally NOT
 *  touched — clearing stores there would sign the user out. */
async function clearIndexedDbs(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  try {
    const { closeAllCacheConnections } = await import('@/lib/csvCache');
    closeAllCacheConnections();
  } catch {
    // cache module unavailable — proceed with the store wipe anyway
  }
  const APP_DATA_DBS = ['kwizi-cache-v2', 'kwizi-csv-cache-v1'];
  const idb = indexedDB as unknown as { databases?: () => Promise<{ name?: string; version?: number }[]> };
  const existing = new Set<string>();
  if (typeof idb.databases === 'function') {
    try {
      for (const entry of await idb.databases()) {
        if (entry?.name) existing.add(entry.name);
      }
    } catch {
      // enumeration unsupported/failing — the delete-path below still tries
    }
  }
  for (const name of APP_DATA_DBS) {
    if (existing.size > 0 && !existing.has(name)) continue; // never created — nothing to wipe
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      try {
        // `open(name)` with NO version never triggers an upgrade — it cannot
        // create a store-less skeleton that would break the cache module later.
        const openReq = indexedDB.open(name);
        openReq.onupgradeneeded = () => {}; // database never existed — nothing to clear
        openReq.onerror = done;
        openReq.onsuccess = () => {
          const db = openReq.result;
          try {
            const stores = Array.from(db.objectStoreNames);
            const tx = stores.length ? db.transaction(stores, 'readwrite') : null;
            if (tx) {
              for (const store of stores) tx.objectStore(store).clear();
              tx.oncomplete = () => {
                db.close();
                done();
              };
              tx.onerror = () => {
                db.close();
                done();
              };
            } else {
              db.close();
              done();
            }
          } catch {
            try {
              db.close();
            } catch {
              // ignore
            }
            done();
          }
        };
      } catch {
        done();
      }
      setTimeout(done, 3000); // never hang the button
    });
    // Best-effort removal of the now-empty database (a parallel tab holding it
    // open only blocks THIS delete — the stores are already wiped either way).
    try {
      indexedDB.deleteDatabase(name);
    } catch {
      // ignore
    }
  }
}

/** Unregister any service worker so it stops intercepting requests. */
async function unregisterServiceWorkers(): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((r) => r.unregister()));
  } catch {
    // ignore
  }
}

/** Clear local/session storage COMPLETELY. The one-time-choice preservation
 *  (tour, cookie consent) was removed per the owner: stale entries kept
 *  "reappearing" after a cache clear, so every clear now is a full reset. The
 *  Firebase Auth IndexedDB (the actual sign-in) is still owned elsewhere and
 *  is not touched by this function. */
function clearWebStorage(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.clear();
    if (typeof sessionStorage !== 'undefined') sessionStorage.clear();
  } catch {
    // ignore
  }
}

function setVersionMarker(version: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(VERSION_KEY, version);
    }
  } catch {
    // ignore
  }
}

function readVersionMarker(): string | null {
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem(VERSION_KEY);
    }
  } catch {
    // ignore
  }
  return null;
}

/** Reusable one-stop cache clear used by the admin "Clear cache & reload"
 *  button AND the global cache-clear watcher: wipes web storage (fully), data
 *  IndexedDBs, the HTTP Cache API and all service workers. Firebase Auth's
 *  IndexedDB (the sign-in session) survives so nobody gets logged out. */
export async function clearAppDataCaches(): Promise<void> {
  clearWebStorage();
  await clearIndexedDbs();
  await clearHttpCacheApi();
  await unregisterServiceWorkers();
}

/** Delete every entry of the browser's HTTP Cache API (caches.*). Service
 *  workers were already unregistered; this catches precached responses they
 *  may have left behind. */
async function clearHttpCacheApi(): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const keys = await caches.keys();
    for (const key of keys) await caches.delete(key);
  } catch {
    // ignore
  }
}

/* ── Global cache clear (owner → every visitor) ──────────────────────────── */

async function readGlobalCacheEpoch(): Promise<number> {
  try {
    const snap = await getDoc(doc(db, 'cms_config', 'cache-clear'));
    return snap.exists() ? Number((snap.data() as { epoch?: number }).epoch ?? 0) : 0;
  } catch {
    // Rules/offline — 0 means "no global clear available"
    return 0;
  }
}

function seenGlobalCacheEpoch(): number {
  try {
    return Number(localStorage.getItem(GLOBAL_EPOCH_KEY) ?? '0');
  } catch {
    return 0;
  }
}

function markGlobalCacheEpochSeen(epoch: number): void {
  try {
    localStorage.setItem(GLOBAL_EPOCH_KEY, String(epoch));
  } catch {
    // ignore
  }
}

/** Owner action: bump the epoch in Firestore so EVERY user's tab clears and
 *  reloads at its next watch tick. Returns the new epoch (0 on failure). */
export async function bumpGlobalCacheClear(): Promise<number> {
  try {
    const ref = doc(db, 'cms_config', 'cache-clear');
    const snap = await getDoc(ref);
    const epoch = (snap.exists() ? Number((snap.data() as { epoch?: number }).epoch ?? 0) : 0) + 1;
    await setDoc(ref, { epoch, at: Date.now() });
    return epoch;
  } catch {
    return 0;
  }
}

/** The owner's "Clear cache & reload": bump the GLOBAL epoch first (so every
 *  visitor's tab wipes at its next watch tick), then wipe THIS browser, then
 *  re-mark the epoch (the wipe erases the marker — must be re-set after). */
export async function clearCacheForEveryone(): Promise<void> {
  const epoch = await bumpGlobalCacheClear();
  await clearAppDataCaches();
  if (epoch > 0) markGlobalCacheEpochSeen(epoch);
}

/** Every visitor's tab polls the global epoch every 60 s (visibility-gated):
 *  when the owner bumps it, this tab wipes its caches/cookies/storage and
 *  reloads once. Markers are set AFTER the wipe, which erases everything. */
export function watchGlobalCacheClear(): () => void {
  if (typeof window === 'undefined') return () => {};
  let stopped = false;
  let running = false;
  const check = async () => {
    if (stopped || running || document.visibilityState !== 'visible') return;
    const epoch = await readGlobalCacheEpoch();
    if (stopped || epoch === 0 || epoch <= seenGlobalCacheEpoch()) return;
    running = true;
    try {
      await clearAppDataCaches();
      markGlobalCacheEpochSeen(epoch);
      // sessionStorage was just wiped — this flag lives only until reload.
      sessionStorage.setItem('kwizi:global-clear-done', String(epoch));
      window.location.reload();
    } catch {
      running = false;
    }
  };
  check();
  const id = setInterval(check, 60000);
  return () => {
    stopped = true;
    clearInterval(id);
  };
}

/* ── Env-free deployment watchdog ──────────────────────────────────────────
 * The deployment-id watchdog in map/page.tsx relies on
 * NEXT_PUBLIC_VERCEL_DEPLOYMENT_ID, which this Vercel project does NOT have
 * set — `enforceFreshBuild` is inert too (no NEXT_PUBLIC_APP_VERSION either).
 * Result: a tab parked on /admin kept running its old bundle forever and
 * repeatedly failed uploads with "invalid authentication credentials" even
 * after the fix was deployed.
 *
 * This watcher needs NO build-time env: every deploy changes the content-
 * hashed chunk filenames. A stale tab's loaded scripts reference only OLD
 * chunk names; the fresh HTML of the same route references the CURRENT ones.
 * Any chunk name in the fresh HTML that this tab hasn't loaded = new deploy
 * → hard reload (once per deploy, guarded by sessionStorage).
 * ────────────────────────────────────────────────────────────────────────── */

function chunkNamesFrom(text: string): string[] {
  const names: string[] = [];
  const re = /\/_next\/static\/chunks\/([^"'?#\s]+\.js)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) names.push(m[1]);
  return names;
}

function collectLoadedChunkNames(): Set<string> {
  const names = new Set<string>();
  try {
    for (const script of Array.from(document.scripts)) {
      const src = (script as HTMLScriptElement).src || '';
      const m = src.match(/\/_next\/static\/chunks\/([^"'?#\s]+\.js)$/);
      if (m) names.add(m[1]);
    }
  } catch {
    // ignore
  }
  return names;
}

function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return String(h);
}

/** Periodically compare this tab's loaded chunks against the fresh HTML of the
 *  same route; reload once when a new deployment ships chunks this tab has
 *  never heard of. Returns a React cleanup function. */
export function watchFreshDeployments(): () => void {
  if (typeof window === 'undefined') return () => {};
  let stopped = false;
  let checking = false;
  const check = async () => {
    if (stopped || checking || document.visibilityState !== 'visible') return;
    checking = true;
    try {
      // Dynamic imports keep adding scripts after mount — resnapshot each tick.
      const loaded = collectLoadedChunkNames();
      if (!loaded.size) return;
      const res = await fetch(window.location.pathname, { cache: 'no-store' });
      if (!res.ok) return;
      const fresh = chunkNamesFrom(await res.text());
      const novelty = fresh.find((n) => !loaded.has(n));
      if (!novelty) return;
      const key = 'kwizi:reloaded-build';
      const marker = hashString(fresh.join('|'));
      if (sessionStorage.getItem(key) === marker) return;
      sessionStorage.setItem(key, marker);
      window.location.reload();
    } catch {
      /* network hiccup — the next tick retries */
    } finally {
      checking = false;
    }
  };
  check();
  const id = setInterval(check, 60000);
  return () => {
    stopped = true;
    clearInterval(id);
  };
}

/**
 * Call once at app boot (before any heavy work). If the deployed build version
 * differs from what this browser last ran, clear caches and reload. Returns true
 * when a reload was triggered — the caller should stop further rendering.
 */
export async function enforceFreshBuild(): Promise<boolean> {
  const current = getBuildVersion();
  if (!current || current === 'unknown') return false;

  const previous = readVersionMarker();
  if (!previous || previous === current) {
    setVersionMarker(current);
    return false;
  }

  // Version changed — nuke caches and hard-reload.
  clearWebStorage();
  await clearIndexedDbs();
  await unregisterServiceWorkers();
  setVersionMarker(current);

  if (typeof window !== 'undefined') {
    const url = new URL(window.location.href);
    url.searchParams.set('_v', current);
    url.searchParams.delete('_v_old');
    window.location.replace(url.toString());
    return true;
  }
  return false;
}
