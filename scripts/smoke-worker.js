/**
 * One-off smoke test: boot the BUILT worker bundle (public/workers/
 * aggregateWorker.js) in Node, feed it a loadDataset + aggregate request via
 * the real message protocol, and print what comes back.
 *
 * Usage: node scripts/smoke-worker.js
 */
const path = require('path');
const vm = require('vm');

let posted = [];
const sandbox = {
  console,
  navigator: { deviceMemory: 8 },
  fetch: async (url) => {
    // Serve local /cache/ files directly off disk (same mapping as the engine:
    // manifest paths like cms_files/csv/x.gz → public/cache/x.gz).
    const fs = require('fs');
    const rel = url.replace('http://localhost', '').split('?')[0];
    const fileName = rel.split('/').pop();
    const file = path.join(__dirname, '..', 'public', 'cache', fileName);
    try {
      const buf = fs.readFileSync(file);
      return { ok: true, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    } catch {
      return { ok: false };
    }
  },
  setTimeout,
  TextDecoder,
  Response,
  ReadableStream,
  DecompressionStream,
  indexedDB: undefined, // no cache in node — exercises the chunk fetch path
  performance,
};
sandbox.self = sandbox; // the worker bundle uses self.postMessage / self.onmessage
vm.createContext(sandbox);

const code = require('fs').readFileSync(
  path.join(__dirname, '..', 'public', 'workers', 'aggregateWorker.js'),
  'utf8'
);
vm.runInContext(code, sandbox, { filename: 'aggregateWorker.js' });

// Collect worker output
const origPost = sandbox.postMessage;
// The bundle closes over `self` from the sandbox; replace postMessage there.
sandbox.postMessage = (msg, transfer) => {
  posted.push(msg);
  if (msg.type === 'log') console.log('[worker log]', msg.message);
  if (msg.type === 'datasetError') console.error('[worker datasetError]', msg.message);
  if (msg.type === 'datasetReady') console.log('[worker datasetReady]', msg.count, 'rows');
  if (msg.type === 'result') {
    console.log('[worker result] jobId', msg.result.jobId);
    console.log('  filteredCount:', msg.result.filteredCount);
    console.log('  mapValues keys:', Object.keys(msg.result.mapValues.values).length, 'names:', Object.keys(msg.result.mapValues.names).length);
    console.log('  reportStats:', JSON.stringify(msg.result.reportStats));
    console.log('  marketHealth:', msg.result.marketHealth ? `score=${msg.result.marketHealth.score}` : 'null');
    console.log('  timeSeries points:', msg.result.timeSeries.length);
    console.log('  forecast:', msg.result.forecast ? `periods=${msg.result.forecast.periods.length}` : 'null');
    console.log('  forecastComparison:', msg.result.forecastComparison.length);
    console.log('  yearBuiltData:', JSON.stringify(msg.result.yearBuiltData));
    console.log('  points:', msg.result.pointsCount);
  }
  if (msg.type === 'jobError') console.error('[worker jobError]', msg.jobId, msg.message);
};

// Wait for the manifest plan to resolve — build it the same way resolveDataSource does.
(async () => {
  const fs = require('fs');
  const candidates = [
    path.join(__dirname, '..', 'public', 'cache', 'boundary_chunks_manifest.json'),
    path.join(__dirname, '..', 'public', 'cache', 'master_cache_chunks.json'),
  ];
  let plan = null;
  for (const c of candidates) {
    try {
      const m = JSON.parse(fs.readFileSync(c, 'utf8'));
      plan = {
        bucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || 'myreatstat.firebasestorage.app',
        localBase: '/cache/',
        boundaries: m.boundaries,
        chunks: m.chunks,
        totalRows: m.totalRows,
        version: m.version ?? 0,
      };
      console.log('[smoke] manifest:', c, 'version:', m.version);
      break;
    } catch { /* next */ }
  }
  if (!plan) {
    console.error('[smoke] No local chunk manifest found in public/cache — cannot smoke test the chunk path.');
    process.exit(1);
  }

  sandbox.onmessage({
    data: { type: 'loadDataset', plan, cacheVersion: '', schoolScores: { elementary: {}, middle: {}, high: {} }, propertyOverrides: [] },
  });

  // wait for datasetReady then fire an aggregate
  const waitReady = setInterval(() => {
    if (posted.some((m) => m.type === 'datasetReady' || m.type === 'datasetError')) {
      clearInterval(waitReady);
      posted.length = 0;
      sandbox.onmessage({
        data: {
          type: 'aggregate',
          jobId: 1,
          boundary: 'subdivisions',
          metric: 'Close Price',
          filters: {
            bedsMin: 0, bedsMax: 20, bathsMin: 0, bathsMax: 20, sqftMin: 0, sqftMax: 20000,
            saleMin: 0, saleMax: 20000000, rentMin: 0, rentMax: 50000, pricePerSqftMin: 0, pricePerSqftMax: 5000,
            lotSizeMin: 0, lotSizeMax: 1000000, domMin: 0, domMax: 2000, l2sMin: 50, l2sMax: 150,
            yearMin: 1920, yearMax: new Date().getFullYear(), period: 'all',
            propertyTypes: [], pool: 'any', schoolDistricts: [], cities: [],
            elementary: [], middle: [], highschools: [], elementaryRating: [], middleRating: [], highRating: [],
          },
          cmsOverrides: [],
          selectedIds: [],
        },
      });
      setTimeout(() => {
        if (!posted.some((m) => m.type === 'result' || m.type === 'jobError')) {
          console.error('[smoke] aggregate never answered (timeout)');
        }
        process.exit(0);
      }, 60000);
    }
  }, 200);
})();