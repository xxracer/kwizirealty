/**
 * Fetches a JSON URL that may be raw or gzip-compressed.
 *
 * Boundary/custom-area GeoJSON uploads are gzipped in cmsStore.saveFile (a
 * 44MB FeatureCollection transfers as ~1MB), so every consumer of a CMS
 * storageUrl for geojson must sniff the payload: plain JSON parses directly,
 * gzip payloads are decompressed first (DecompressionStream is available in
 * all modern browsers).
 *
 * DEDUPE (owner's <2s map-load rule): the same boundary file is read by BOTH
 * the map page (name/zip lookup) and MapComponent (draw) at first paint —
 * with no-store that means 1.4MB downloaded and parsed TWICE. In-flight +
 * short-TTL dedupe: concurrent and near-back-to-back callers of the same URL
 * share one download/parse.
 */
interface InFlight {
  promise: Promise<unknown>;
  at: number;
}
const inflight = new Map<string, InFlight>();
const DEDUPE_TTL_MS = 60_000;

export async function fetchJsonAutoGz<T = unknown>(url: string): Promise<T> {
  const hit = inflight.get(url);
  if (hit && Date.now() - hit.at < DEDUPE_TTL_MS) {
    return hit.promise as Promise<T>;
  }
  const promise = fetchJsonAutoGzOnce<T>(url);
  inflight.set(url, { promise, at: Date.now() });
  try {
    return await promise;
  } finally {
    // Keep the entry briefly so the double-fires inside one paint hit it;
    // drop after TTL so a real upload refresh re-downloads.
    setTimeout(() => {
      const cur = inflight.get(url);
      if (cur && cur.promise === promise) inflight.delete(url);
    }, DEDUPE_TTL_MS);
  }
}

async function fetchJsonAutoGzOnce<T = unknown>(url: string): Promise<T> {
  // no-store: CMS data files have fixed names, so a cached copy could serve
  // deleted/stale content after an upload. Firebase is read fresh every time.
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  const buf = await res.arrayBuffer();
  let text: string;
  try {
    text = new TextDecoder().decode(buf);
    JSON.parse(text);
  } catch {
    const ds = (globalThis as any).DecompressionStream as typeof DecompressionStream | undefined;
    if (!ds) throw new Error('Browser does not support gzip decompression.');
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(buf));
        controller.close();
      },
    });
    text = await new Response(stream.pipeThrough(new ds('gzip'))).text();
  }
  return JSON.parse(text) as T;
}