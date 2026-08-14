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
  let totalRows = 0;

  for (const chunkPath of manifest.chunks) {
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
    for (const row of rows) {
      for (const b of BOUNDARIES) {
        const key = b === 'elementary' || b === 'middle' ? cleanSchoolName(row[b]) : cleanBoundaryName(row[b]);
        if (!key) continue;
        const bucket = groups[b];
        if (!bucket[key]) bucket[key] = [];
        const price = Number(row.closePrice);
        if (price > 0) bucket[key].push(price);
      }
    }
  }

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
  console.log(
    `[build-initial-metrics] built snapshots from ${totalRows.toLocaleString()} rows`
  );
}

main();
