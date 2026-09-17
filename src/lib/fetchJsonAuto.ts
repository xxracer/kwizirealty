/**
 * Fetches a JSON URL that may be raw or gzip-compressed.
 *
 * Boundary/custom-area GeoJSON uploads are gzipped in cmsStore.saveFile (a
 * 44MB FeatureCollection transfers as ~1MB), so every consumer of a CMS
 * storageUrl for geojson must sniff the payload: plain JSON parses directly,
 * gzip payloads are decompressed first (CompressionStream is available in all
 * modern browsers).
 */
export async function fetchJsonAutoGz<T = unknown>(url: string): Promise<T> {
  const res = await fetch(url);
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