/**
 * cacheBuster.ts — automatic client-side cache invalidation on new deploys.
 *
 * Next.js/Vercel serves static JS chunks with long cache headers. When a critical
 * fix ships (e.g. the SQL sync check, the map bounds fix), returning visitors
 * may continue running an old bundle and stale IndexedDB/Firebase-persisted
 * state until they manually clear cache. This module detects a build version
 * change and forces a hard reload after clearing every browser cache layer the
 * app controls.
 */

const VERSION_KEY = 'kwizi_app_version';

/** Reads the build version injected by Next.js at build time. */
function getBuildVersion(): string {
  return process.env.NEXT_PUBLIC_APP_VERSION || process.env.NEXT_PUBLIC_GIT_SHA || 'unknown';
}

/** Clear every IndexedDB database the app uses. */
async function clearIndexedDbs(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const databases = ['kwizi-cache-v2', 'kwizi-csv-cache-v1'];
  for (const name of databases) {
    try {
      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
        setTimeout(resolve, 1000);
      });
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

/** Clear local/session storage except the version marker we just wrote. */
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
