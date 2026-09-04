const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CACHE_DIR = path.join(__dirname, '..', 'public', 'cache');
const MANIFEST_PATH = path.join(CACHE_DIR, 'master_cache_chunks.json');

const BOUNDARIES = ['subdivisions', 'zipcodes', 'highschools', 'elementary', 'middle', 'neighborhoods'];

function cleanBoundaryName(raw) {
  let v = String(raw || '').toUpperCase().trim();
  if (!v || v === 'NA' || v === 'N/A' || v === 'NONE' || v === 'NULL' || v === 'UNKNOWN' || v === 'UNINCORPORATED') return '';
  return v
    .replace(/\s+/g, ' ')
    .replace(/\b(WLDS|WLDNGS|WLNDS)\b/g, 'WOODLANDS')
    .replace(/\b(VLG|VILL|VILLG|VILLAS)\b/g, 'VILLAGE')
    .replace(/\b(EST|ESTS)\b/g, 'ESTATES')
    .replace(/\b(PL|PLAT)\b/g, 'PLACE')
    .replace(/\b(CRE|CRK)\b/g, 'CREEK')
    .replace(/\b(MEADOWS|MEADOW)\b/g, 'MDW')
    .replace(/\b(RANCH|RNCH)\b/g, 'RNCH')
    .replace(/\bGROVE\b/g, 'GRV')
    .replace(/\bHEIGHTS\b/g, 'HTS')
    .replace(/\bSTATION\b/g, 'STA')
    .replace(/\bNORTH\b/g, 'N')
    .replace(/\bSOUTH\b/g, 'S')
    .replace(/\bEAST\b/g, 'E')
    .replace(/\bWEST\b/g, 'W')
    .replace(/\bAT\b/g, '@')
    .replace(/\bOF\b/g, 'OF')
    .replace(/\bTHE\b/g, 'THE')
    .trim();
}

function cleanSchoolName(raw) {
  let v = String(raw || '').toUpperCase().trim();
  if (!v || v === 'NA' || v === 'N/A' || v === 'NONE' || v === 'NULL' || v === 'UNKNOWN') return '';
  return v.replace(/\s+/g, ' ').replace(/\b(ELEMENTARY|MIDDLE|HIGH)\b/g, '').trim();
}

function median(arr) {
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function main() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.warn('[build-initial-metrics] No chunked cache manifest found; skipping.');
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const groups = Object.fromEntries(BOUNDARIES.map((b) => [b, {}]));
  // area -> Set(chunkIndex) for each boundary, so we can load only the chunks
  // that contain a selected area when generating a report.
  const chunkIndex = Object.fromEntries(BOUNDARIES.map((b) => [b, new Map()]));
  let totalRows = 0;

  // Support both the legacy flat chunk list and the new per-boundary format.
  const boundaryChunks = [];
  if (manifest.format === 'boundary-chunks' && manifest.boundaries) {
    for (const b of BOUNDARIES) {
      const chunks = (manifest.boundaries[b] && manifest.boundaries[b].chunks) || [];
      boundaryChunks.push({ boundary: b, chunks });
    }
  } else if (Array.isArray(manifest.chunks)) {
    boundaryChunks.push({ boundary: null, chunks: manifest.chunks });
  } else {
    throw new Error('Invalid manifest: no chunks or boundaries found');
  }

  for (const { boundary: currentBoundary, chunks } of boundaryChunks) {
    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
      const chunkPath = chunks[chunkIdx];
      const fileName = chunkPath.split('/').pop();
      const chunkFile = path.join(CACHE_DIR, fileName);
      if (!fs.existsSync(chunkFile)) {
        throw new Error(`Missing chunk file: ${chunkFile}`);
      }
      const raw = zlib.gunzipSync(fs.readFileSync(chunkFile));
      const parsed = JSON.parse(raw.toString('utf8'));
      let rows;
      if (Array.isArray(parsed)) {
        rows = parsed;
      } else {
        const header = parsed.header;
        rows = parsed.rows.map((arr) => {
          const obj = {};
          header.forEach((key, i) => (obj[key] = arr[i]));
          return obj;
        });
      }
      totalRows += rows.length;
      // With per-boundary chunks, every partition of the same rows is visited
      // once per boundary — a row must only feed the metric bucket of the
      // boundary that owns this chunk list, otherwise every count is inflated
      // by the number of boundary partitions (x5). Legacy flat chunks are
      // global, so they feed all buckets.
      const rowBoundaries = currentBoundary ? [currentBoundary] : BOUNDARIES;
      for (const row of rows) {
        for (const b of rowBoundaries) {
          // 'neighborhoods' shares its data column with 'subdivisions' (see
          // engine.getBoundaryKey), so read the same column for both.
          const column = b === 'neighborhoods' ? 'subdivisions' : b;
          const key = b === 'elementary' || b === 'middle' ? cleanSchoolName(row[column]) : cleanBoundaryName(row[column]);
          if (!key) continue;
          const bucket = groups[b];
          if (!bucket[key]) bucket[key] = [];
          const price = Number(row.closePrice);
          if (price > 0) bucket[key].push(price);

          const idxMap = chunkIndex[b];
          if (!idxMap.has(key)) idxMap.set(key, new Set());
          idxMap.get(key).add(chunkIdx);
        }
      }
    }
  }

  // 'neighborhoods' has no chunk partition of its own in the manifest — it
  // shares the 'subdivisions' data column (see engine.getBoundaryKey), so
  // mirror the subdivisions buckets into it. For legacy flat chunks this is a
  // no-op over already-populated buckets.
  groups['neighborhoods'] = { ...groups['subdivisions'] };
  chunkIndex['neighborhoods'] = new Map(chunkIndex['subdivisions']);

  // Write per-boundary initial metric snapshots.
  for (const b of BOUNDARIES) {
    const values = {};
    const counts = {};
    for (const [key, prices] of Object.entries(groups[b])) {
      if (!prices.length) continue;
      // Round medians to whole dollars to keep the snapshot compact and avoid
      // noisy precision in the initial map coloring.
      values[key] = Math.round(median(prices));
      counts[key] = prices.length;
    }
    const snapshot = { values, counts };
    const outPath = path.join(CACHE_DIR, `initial_metrics_${b}.json`);
    const gzPath = `${outPath}.gz`;
    fs.writeFileSync(outPath, JSON.stringify(snapshot));
    fs.writeFileSync(gzPath, zlib.gzipSync(JSON.stringify(snapshot), { level: 9 }));
    const plainSize = fs.statSync(outPath).size;
    const gzSize = fs.statSync(gzPath).size;
    console.log(
      `[build-initial-metrics] ${b}: ${Object.keys(values).length.toLocaleString()} areas, plain ${(plainSize / 1024 / 1024).toFixed(2)} MB, gzip ${(gzSize / 1024 / 1024).toFixed(2)} MB`
    );
  }

  // Write area -> chunk index so the engine can load only relevant chunks
  // when generating a report for selected areas.
  const indexOut = { version: manifest.version || 0, boundaries: {} };
  for (const b of BOUNDARIES) {
    const obj = {};
    for (const [key, set] of chunkIndex[b]) {
      const arr = Array.from(set);
      arr.sort((a, b) => a - b);
      obj[key] = arr;
    }
    indexOut.boundaries[b] = obj;
  }
  const indexPath = path.join(CACHE_DIR, 'chunk_area_index.json');
  const indexGzPath = `${indexPath}.gz`;
  fs.writeFileSync(indexPath, JSON.stringify(indexOut));
  fs.writeFileSync(indexGzPath, zlib.gzipSync(JSON.stringify(indexOut), { level: 9 }));
  const indexPlainSize = fs.statSync(indexPath).size;
  const indexGzSize = fs.statSync(indexGzPath).size;
  console.log(
    `[build-initial-metrics] chunk index: ${Object.keys(indexOut.boundaries).length} boundaries, plain ${(indexPlainSize / 1024 / 1024).toFixed(2)} MB, gzip ${(indexGzSize / 1024 / 1024).toFixed(2)} MB`
  );

  console.log(
    `[build-initial-metrics] built snapshots from ${totalRows.toLocaleString()} rows`
  );
}

main();
