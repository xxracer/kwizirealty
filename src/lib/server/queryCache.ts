/**
 * queryCache.ts — server-side result cache for the map's /api/query.
 *
 * A single map request runs FOUR Postgres aggregate queries over ~500k rows
 * (per-area percentiles, overall stats, monthly series, map points). Even on a
 * healthy Cloud SQL box that is tens of seconds of compute — far too slow for
 * "the map flies on every request". This cache stores the FINAL response
 * payload in Storage (map_cache/<etag>.json, private, server-only) keyed
 * by the request's ETag — which already encodes the request body AND the
 * dataset version — so:
 *   - every identical request (same filters/metric/boundary/period) is an
 *     instant Storage download instead of a fresh Postgres workout,
 *   - ANY data change (upload, commit, delete, override) produces a new
 *     datasetVersion → new key → automatic invalidation,
 *   - the response payload served is byte-identical to the computed one.
 *
 * IMPORTANT: the prefix is deliberately OUTSIDE cms_files/ — the CMS walker
 * (cmsStore.importExistingStorageFiles) registers every cms_files/* object
 * a real upload, and the first deployment of this cache polluted the admin
 * file lists with phantom "cache/…json" entries.
 *
 * A TTL guards against entries outliving their purpose; data changes already
 * rotate the key, so in practice entries just age out unused.
 */
import { getAdminStorageBucket } from '@/lib/firebaseAdmin';

const CACHE_PREFIX = 'map_cache/';
/** TTL in hours — data changes rotate the key, this is only a safety net. */
const CACHE_TTL_HOURS = 24;

interface CacheEnvelope {
  etag: string;
  savedAt: number;
  cacheExpiresAt: number;
  payload: unknown;
}

/** Fetch a cached response. Returns null on any miss/error/expiry. */
export async function readQueryCache(
  cacheKey: string
): Promise<{ etag: string; payload: unknown } | null> {
  const file = getAdminStorageBucket().file(`${CACHE_PREFIX}${cacheKey}.json`);
  try {
    const [exists] = await file.exists();
    if (!exists) return null;
    const [metadata] = await file.getMetadata();
    const expiresAt = Number(metadata?.metadata?.cacheExpiresAt ?? 0);
    if (expiresAt && Date.now() > expiresAt) return null;
    const [buf] = await file.download();
    const parsed = JSON.parse(buf.toString('utf-8')) as CacheEnvelope | null;
    if (!parsed || typeof parsed.etag !== 'string') return null;
    return { etag: parsed.etag, payload: parsed.payload };
  } catch (err) {
    console.warn('[query-cache] read skipped:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Store a computed response for reuse. Fire-and-forget — never blocks the reply. */
export function writeQueryCache(cacheKey: string, etag: string, payload: unknown): void {
  void (async () => {
    try {
      const envelope: CacheEnvelope = {
        etag,
        savedAt: Date.now(),
        cacheExpiresAt: Date.now() + CACHE_TTL_HOURS * 3600 * 1000,
        payload,
      };
      await getAdminStorageBucket()
        .file(`${CACHE_PREFIX}${cacheKey}.json`)
        .save(Buffer.from(JSON.stringify(envelope), 'utf-8'), {
          contentType: 'application/json',
          metadata: { cacheExpiresAt: String(Date.now() + CACHE_TTL_HOURS * 3600 * 1000) },
          // PROD FAILURE CAUGHT (2026-10-15 21:00): firebase-admin's save()
          // uses the RESUMABLE upload protocol by default, and Google's
          // resumable session "socket hang up"s from Vercel's runtime (the
          // same trap the restore hit: intermediate 308 + dropped sockets).
          // One-shot non-resumable upload always completes.
          resumable: false,
        });
    } catch (err) {
      console.warn('[query-cache] write failed:', err instanceof Error ? err.message : err);
    }
  })();
}