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
import { getAdminStorageBucket, storageWithTimeout } from '@/lib/firebaseAdmin';

const CACHE_PREFIX = 'map_cache/';
/** TTL in hours — data changes rotate the key, this is only a safety net.
 *  30 days (not 24h): every upload rotates the whole key set through the
 *  dataset version, so a long-lived entry can never serve stale data — while
 *  a 24h TTL just GUARANTEED daily cold-computes (8-17s) for whoever visited
 *  between expiry and the next sync's prewarm. */

const CACHE_TTL_HOURS = 24 * 30;

/** In-memory warm-instance cache (the Python app's st.cache_data equivalent):
 *  a Vercel Fluid instance that stays alive serves a repeat /api/query with a
 *  ~50ms memory read instead of a Storage round-trip download (which is why a
 *  cache "hit" still cost 1.5-3.6s). Six entries × ~2.7MB ≈ 16MB — safe under
 *  Fluid's 2GB. */
const MEM_CACHE_CAP = 6;
const memCache = new Map<string, { etag: string; payload: unknown }>();

function memGet(cacheKey: string) {
  const hit = memCache.get(cacheKey);
  if (hit) {
    // refresh LRU recency
    memCache.delete(cacheKey);
    memCache.set(cacheKey, hit);
  }
  return hit || null;
}

function memPut(cacheKey: string, value: { etag: string; payload: unknown }) {
  if (memCache.has(cacheKey)) memCache.delete(cacheKey);
  memCache.set(cacheKey, value);
  while (memCache.size > MEM_CACHE_CAP) {
    const oldest = memCache.keys().next().value;
    if (oldest === undefined) break;
    memCache.delete(oldest);
  }
}

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
  const memHit = memGet(cacheKey);
  if (memHit) return memHit;
  const file = getAdminStorageBucket().file(`${CACHE_PREFIX}${cacheKey}.json`);
  try {
    const [exists] = await storageWithTimeout(file.exists());
    if (!exists) return null;
    const [metadata] = await storageWithTimeout(file.getMetadata());
    const expiresAt = Number(metadata?.metadata?.cacheExpiresAt ?? 0);
    if (expiresAt && Date.now() > expiresAt) return null;
    const [buf] = await storageWithTimeout(file.download());
    const parsed = JSON.parse(buf.toString('utf-8')) as CacheEnvelope | null;
    if (!parsed || typeof parsed.etag !== 'string') return null;
    const hit = { etag: parsed.etag, payload: parsed.payload };
    memPut(cacheKey, hit);
    return hit;
  } catch (err) {
    console.warn('[query-cache] read skipped:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Store a computed response for reuse. Fire-and-forget — never blocks the reply. */
export function writeQueryCache(cacheKey: string, etag: string, payload: unknown): void {
  memPut(cacheKey, { etag, payload });
  void (async () => {
    try {
      const envelope: CacheEnvelope = {
        etag,
        savedAt: Date.now(),
        cacheExpiresAt: Date.now() + CACHE_TTL_HOURS * 3600 * 1000,
        payload,
      };
      await storageWithTimeout(getAdminStorageBucket()
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
        }), 120_000);
    } catch (err) {
      console.warn('[query-cache] write failed:', err instanceof Error ? err.message : err);
    }
  })();
}