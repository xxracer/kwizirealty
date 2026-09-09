/**
 * aggregateWorker — the map page's data engine.
 *
 * This worker OWNS the ~763k property rows. It materializes them (chunk gzip →
 * JSON.parse → IndexedDB cache), and answers aggregate requests in one or a
 * few passes over the rows — all off the main thread, which keeps the UI
 * responsive while filters/report panels recompute.
 *
 * NOTHING here may import engine.ts / cmsStore.ts / firebase — those modules
 * pull the Firebase SDK into the worker bundle. Only engineCore (pure math +
 * types) and csvCache (IndexedDB + crypto.subtle, both worker-safe) are allowed.
 */
import * as core from '../engineCore';
import { readCache, writeCache } from '../csvCache';
import type {
  AggregateResult,
  DataSourcePlan,
  DatasetUniqueValues,
  WorkerRequest,
} from './protocol';

let rows: core.PropertyData[] = [];
let datasetReady = false;
let loadedCacheVersion: string | null = null;
let teaScores: core.TeaScoreMap = { elementary: {}, middle: {}, high: {} };

let currentJobId = 0;

function post(msg: unknown, transfer?: Transferable[]) {
  (self as unknown as Worker).postMessage(msg, transfer || []);
}

function log(message: string) {
  post({ type: 'log', message });
}

/** Max rows kept in RAM — mirrors engine.memoryRowCap() exactly so the
 *  deterministic hash sample (and therefore every median) matches the
 *  main-thread engine. */
function memoryRowCap(): number {
  try {
    const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
    if (!mem || mem <= 0) return 250000;
    if (mem <= 2) return 100000;
    if (mem <= 4) return 180000;
    return Infinity;
  } catch {
    return 250000;
  }
}

/** Build the candidate URL list for a chunk path (local cache first). */
function chunkUrlCandidates(plan: DataSourcePlan, path: string): string[] {
  const fileName = path.split('/').pop() || path;
  const candidates: string[] = [];
  if (plan.localBase) candidates.push(`${plan.localBase}${fileName}`);
  const encoded = encodeURIComponent(path);
  candidates.push(`https://firebasestorage.googleapis.com/v0/b/${plan.bucket}/o/${encoded}?alt=media`);
  return candidates;
}

async function fetchChunkBytes(candidates: string[]): Promise<ArrayBuffer | null> {
  for (const url of candidates) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.arrayBuffer();
    } catch {
      // try the next candidate
    }
  }
  return null;
}

async function gunzipOrDecode(buf: ArrayBuffer): Promise<string> {
  const isGzip = buf.byteLength >= 2 && new Uint8Array(buf, 0, 2)[0] === 0x1f && new Uint8Array(buf, 0, 2)[1] === 0x8b;
  if (!isGzip) return new TextDecoder().decode(buf);
  const ds = (self as unknown as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (!ds) throw new Error('Browser does not support gzip decompression.');
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buf));
      controller.close();
    },
  });
  return new Response(stream.pipeThrough(new ds('gzip'))).text();
}

function parseChunkRows(text: string): core.PropertyData[] {
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed as core.PropertyData[];
  if (parsed && parsed.header && parsed.rows) {
    const header = parsed.header as (keyof core.PropertyData)[];
    return (parsed.rows as unknown[][]).map((arr) => {
      const obj: Record<string, unknown> = {};
      header.forEach((key, i) => (obj[key as string] = arr[i]));
      return obj as unknown as core.PropertyData;
    });
  }
  throw new Error('Unrecognized chunk format');
}

function uniqueValuesFrom(data: core.PropertyData[]): DatasetUniqueValues {
  const collect = (field: keyof core.PropertyData): string[] => {
    const set = new Set<string>();
    for (const d of data) {
      const v = d[field];
      if (typeof v === 'string' && v.trim()) set.add(v);
    }
    return Array.from(set).sort();
  };
  return {
    propertyType: collect('propertyType'),
    city: collect('city'),
    schoolDistrict: collect('schoolDistrict'),
    elementary: collect('elementary'),
    middle: collect('middle'),
    highschools: collect('highschools'),
  };
}

async function loadDataset(
  plan: DataSourcePlan,
  cacheVersion: string,
  schoolScores: core.TeaScoreMap,
  propertyOverrides: core.PropertyOverrideLite[]
) {
  teaScores = schoolScores;

  // 1. IndexedDB cache first (same key scheme as the engine).
  if (cacheVersion) {
    try {
      const cacheResult = await readCache<core.PropertyData[]>(cacheVersion);
      const cached = cacheResult.data;
      if (cached && cached.length > 0) {
        rows = cached;
        core.internStrings(rows);
        loadedCacheVersion = cacheVersion;
        datasetReady = true;
        log(`[Kwizi Worker] Restored ${cached.length.toLocaleString()} rows from IndexedDB cache`);
        const result: { type: 'datasetReady'; count: number; uniqueValues: DatasetUniqueValues } = {
          type: 'datasetReady',
          count: rows.length,
          uniqueValues: uniqueValuesFrom(rows),
        };
        post(result);
        return;
      }
    } catch {
      // fall through to the network path
    }
  }

  // 2. Chunk list for the default boundary (full dataset exactly once).
  let chunkPaths: string[] = [];
  if (plan.boundaries) {
    const defaultInfo = plan.boundaries['subdivisions'];
    if (defaultInfo) chunkPaths = defaultInfo.chunks;
  }
  if (!chunkPaths.length && plan.chunks) chunkPaths = plan.chunks;
  if (!chunkPaths.length) {
    post({ type: 'datasetError', message: 'The data plan has no chunks to load.' });
    return;
  }

  const candidatesPerChunk = chunkPaths.map((p) => chunkUrlCandidates(plan, p));
  const results: (core.PropertyData[] | null)[] = new Array(chunkPaths.length).fill(null);

  // One chunk in flight ahead, processing strictly sequential (memory).
  const fetchOne = (index: number): Promise<ArrayBuffer | null> => {
    if (index >= candidatesPerChunk.length) return Promise.resolve(null);
    return fetchChunkBytes(candidatesPerChunk[index]);
  };

  let inFlight = fetchOne(0);
  for (let index = 0; index < candidatesPerChunk.length; index++) {
    const bufPromise = inFlight;
    inFlight = fetchOne(index + 1);
    const buf = await bufPromise;
    if (!buf) {
      post({ type: 'datasetError', message: `Chunk fetch failed: ${chunkPaths[index]}` });
      return;
    }
    const text = await gunzipOrDecode(buf);
    results[index] = parseChunkRows(text);
    post({ type: 'datasetProgress', loaded: index + 1, total: chunkPaths.length, message: 'Loading map data…' });
  }

  const all: core.PropertyData[] = [];
  for (const part of results) {
    if (part) for (const r of part) all.push(r);
  }

  // Same device-based cap as the engine, so medians match the old path.
  const capped = core.subsampleRows(all, memoryRowCap());
  core.internStrings(capped);

  if (propertyOverrides.length) {
    core.applyPropertyOverrides(capped, propertyOverrides);
  }

  rows = capped;
  datasetReady = true;
  loadedCacheVersion = cacheVersion;
  log(`[Kwizi Worker] Loaded ${rows.length.toLocaleString()} rows from ${chunkPaths.length} chunks`);

  if (cacheVersion) {
    try {
      await writeCache(cacheVersion, rows);
    } catch {
      // cache write is best-effort
    }
  }

  const ready: { type: 'datasetReady'; count: number; uniqueValues: DatasetUniqueValues } = {
    type: 'datasetReady',
    count: rows.length,
    uniqueValues: uniqueValuesFrom(rows),
  };
  post(ready);
}

const RENTAL_METRICS = new Set<string>([
  'Est. Rental Price',
  'Rental Price per Sqft',
  'Rental Days On Market',
  'Rent-to-Sale Ratio',
]);

function computeAggregate(
  boundary: core.BoundaryKey,
  metric: core.MetricKey,
  filters: core.PropertyFilters,
  cmsOverrides: core.MetricOverrideLite[],
  selectedIds: string[]
): AggregateResult {
  const filtered = core.filterProperties(rows, filters, teaScores);

  const mapValues = core.getMapValues(filtered, boundary, metric, teaScores, cmsOverrides);
  const reportStats = core.getStatsForSelection(filtered, boundary, selectedIds);
  const marketHealth = core.getMarketHealth(
    filtered,
    boundary,
    selectedIds,
    RENTAL_METRICS.has(metric) ? 'rental' : 'sale'
  );
  const timeSeries = core.getTimeSeries(filtered, boundary, metric, selectedIds);
  const forecast = core.buildForecast(timeSeries);
  const forecastComparison = core
    .getForecastForSelection(filtered, boundary, metric, selectedIds)
    .sort((a, b) => b.baseline - a.baseline)
    .slice(0, 5);

  // Year-built histogram over the selection (unselected → all filtered rows).
  const buckets: Record<string, number> = {
    'Before 1970': 0,
    '1970–1989': 0,
    '1990–2009': 0,
    '2010+': 0,
  };
  const selectedSet = new Set(selectedIds);
  const points: number[] = [];
  let minLat = 90;
  let maxLat = -90;
  let minLng = 180;
  let maxLng = -180;
  for (const d of filtered) {
    if (selectedIds.length && !selectedSet.has(core.getBoundaryKeyFor(boundary, d))) continue;
    if (d.yearBuilt) {
      if (d.yearBuilt < 1970) buckets['Before 1970']++;
      else if (d.yearBuilt < 1990) buckets['1970–1989']++;
      else if (d.yearBuilt < 2010) buckets['1990–2009']++;
      else buckets['2010+']++;
    }
    if (isFinite(d.lat) && isFinite(d.lng) && (d.lat !== 0 || d.lng !== 0)) {
      points.push(d.lat, d.lng);
      if (d.lat < minLat) minLat = d.lat;
      if (d.lat > maxLat) maxLat = d.lat;
      if (d.lng < minLng) minLng = d.lng;
      if (d.lng > maxLng) maxLng = d.lng;
    }
  }
  const yearBuiltData = Object.entries(buckets)
    .map(([name, value]) => ({ name, value }))
    .filter((d) => d.value > 0);

  return {
    jobId: currentJobId,
    filteredCount: filtered.length,
    mapValues,
    reportStats,
    marketHealth,
    timeSeries,
    forecast,
    forecastComparison,
    yearBuiltData,
    points: Float32Array.from(points),
    pointsCount: points.length / 2,
    pointsBounds: {
      minLat: points.length ? minLat : 0,
      maxLat: points.length ? maxLat : 0,
      minLng: points.length ? minLng : 0,
      maxLng: points.length ? maxLng : 0,
    },
  };
}

function computeChatStats(
  boundary: core.BoundaryKey,
  filters: core.PropertyFilters,
  ids: string[] | undefined,
  marketType: 'sale' | 'rental' | undefined
): {
  stats: {
    count: number;
    avgSale: number;
    avgSqft: number;
    avgDom: number;
    totalVolume: number;
    avgList: number;
    avgLotSize: number;
  };
  health?: core.MarketHealthResult | null;
  topAreas?: { id: string; count: number }[];
} {
  const filtered = core.filterProperties(rows, filters, teaScores);
  const stats = core.getStatsForSelection(filtered, boundary, ids || []);
  if (ids && ids.length) {
    // Area-query preview: stats + market health for those areas.
    return { stats, health: core.getMarketHealth(filtered, boundary, ids, marketType || 'sale') };
  }
  // Filter preview: top 5 areas by match count.
  const counts: Record<string, number> = {};
  for (const d of filtered) {
    const pid = core.getBoundaryKeyFor(boundary, d);
    if (!pid) continue;
    counts[pid] = (counts[pid] || 0) + 1;
  }
  const topAreas = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, count]) => ({ id, count }));
  return { stats, topAreas };
}

function computeSearch(boundary: core.BoundaryKey, query: string): string[] {
  const q = query.trim().toUpperCase();
  if (!q) return [];
  const matches = new Set<string>();
  for (const d of rows) {
    const pid = core.getBoundaryKeyFor(boundary, d);
    if (pid && pid.toUpperCase().includes(q)) matches.add(pid);
    else if (d.address.toUpperCase().includes(q) && pid) matches.add(pid);
    else if (d.zip.toUpperCase().includes(q) && pid) matches.add(pid);
    else if (d.city.toUpperCase().includes(q) && pid) matches.add(pid);
    else if (pid && d.subdivisions.toUpperCase().includes(q)) matches.add(pid);
    if (matches.size >= 5000) break;
  }
  return Array.from(matches);
}

self.onmessage = (event: MessageEvent) => {
  const msg = event.data as WorkerRequest;
  switch (msg.type) {
    case 'loadDataset':
      loadDataset(msg.plan, msg.cacheVersion, msg.schoolScores, msg.propertyOverrides || []).catch((err) => {
        console.error('[Kwizi Worker] loadDataset failed:', err);
        post({ type: 'datasetError', message: err instanceof Error ? err.message : String(err) });
      });
      break;
    case 'aggregate': {
      if (!datasetReady) {
        post({ type: 'jobError', jobId: msg.jobId, message: 'The dataset is not loaded yet.' });
        break;
      }
      currentJobId = msg.jobId;
      const jobId = msg.jobId;
      // Yield to the microtask queue first so a burst of filter changes can be
      // superseded before the expensive pass starts.
      setTimeout(() => {
        if (jobId !== currentJobId) {
          // Superseded — skip the expensive pass, but answer so the client's
          // promise doesn't dangle (the client resolves stale jobs as null).
          post({ type: 'jobError', jobId, message: 'superseded' });
          return;
        }
        try {
          const result = computeAggregate(msg.boundary, msg.metric, msg.filters, msg.cmsOverrides, msg.selectedIds);
          post({ type: 'result', result }, [result.points.buffer]);
        } catch (err) {
          post({
            type: 'jobError',
            jobId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }, 0);
      break;
    }
    case 'search': {
      if (!datasetReady) {
        post({ type: 'jobError', jobId: msg.jobId, message: 'The dataset is not loaded yet.' });
        break;
      }
      try {
        post({ type: 'searchResult', result: { jobId: msg.jobId, ids: computeSearch(msg.boundary, msg.query) } });
      } catch (err) {
        post({
          type: 'jobError',
          jobId: msg.jobId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }
    case 'chatStats': {
      if (!datasetReady) {
        post({ type: 'jobError', jobId: msg.jobId, message: 'The dataset is not loaded yet.' });
        break;
      }
      try {
        post({
          type: 'chatStatsResult',
          result: {
            jobId: msg.jobId,
            ...computeChatStats(msg.boundary, msg.filters, msg.ids, msg.marketType),
          },
        });
      } catch (err) {
        post({
          type: 'jobError',
          jobId: msg.jobId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }
    case 'cancelStale':
      // Job ids are monotonic; an older job simply can't be current anymore.
      if (msg.jobId >= currentJobId) currentJobId = msg.jobId;
      break;
  }
};