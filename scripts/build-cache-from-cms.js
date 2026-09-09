/**
 * Rebuilds the boundary-chunked dataset cache straight from the CSV files the
 * client uploads through the CMS (cms_files/csv/** in Firebase Storage).
 *
 * This replaces the old two-step chain (compile-master-cache.js →
 * build-chunked-json-cache.js) which required a master_cache.csv.gz that no
 * longer exists in Storage, so CSV uploads never reached the map.
 *
 * Pipeline:
 *   1. List every CSV under cms_files/csv/ (recursive), skipping engine
 *      caches (master_cache*, boundary_*, chunk_area_index*) and TEA files.
 *   2. Download, parse and normalize each row exactly like
 *      build-chunked-json-cache.js did (same normalizer, same output shape).
 *   3. SAFETY GATE: the kept-row count must match the currently deployed
 *      dataset (763,868 rows) plus/minus the new uploads. If the count is far
 *      off, abort WITHOUT uploading anything.
 *   4. Group rows per boundary, write + upload chunks, manifest and area
 *      index, and refresh the local public/cache copies.
 *
 * The manifest's `version: Date.now()` makes every browser pick the new
 * dataset on its next load (local /cache manifest is older), while the local
 * copies keep fresh-cache deploys fast.
 *
 * Usage: node scripts/build-cache-from-cms.js [--expected-min N] [--expected-max N]
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const Papa = require('papaparse');
const { initializeApp } = require('firebase/app');
const { getStorage, ref, getDownloadURL, uploadBytes, deleteObject, listAll } = require('firebase/storage');
const firebaseConfig = require('../src/lib/firebase-config-script.js');

const app = initializeApp(firebaseConfig);
const storage = getStorage(app);

const MANIFEST_PATH = 'cms_files/csv/master_cache_chunks.json';
const INDEX_PATH = 'cms_files/csv/chunk_area_index.json.gz';
const TARGET_ROWS_PER_CHUNK = 15_000;

// Rows currently deployed in public/cache/master_cache_chunks.json. The gate
// only lets a rebuild through when the recomputed dataset is the same data
// plus the new CMS rows — not a different composition.
const BASELINE_ROWS = 763_868;

const BOUNDARIES = [
  { key: 'subdivisions', keyFn: (r) => r.subdivisions },
  { key: 'zipcodes', keyFn: (r) => r.zipcodes },
  { key: 'highschools', keyFn: (r) => r.highschools },
  { key: 'elementary', keyFn: (r) => r.elementary },
  { key: 'middle', keyFn: (r) => r.middle },
];

function log(...args) {
  console.log('[build-cache-from-cms]', ...args);
}

function stripBom(str) {
  return str.replace(/^﻿/, '');
}

function cleanNumber(val) {
  if (val == null || val === '') return 0;
  if (typeof val === 'number') return isFinite(val) ? val : 0;
  const cleaned = String(val).replace(/[^0-9.\-]+/g, '');
  const n = Number(cleaned);
  return isFinite(n) ? n : 0;
}

function cleanDate(raw) {
  if (!raw) return { date: '', year: 0, ts: 0 };
  const parts = raw.split('/');
  if (parts.length === 3) {
    const y = parseInt(parts[2], 10);
    const m = parseInt(parts[0], 10);
    const d = parseInt(parts[1], 10);
    const year = isFinite(y) ? y : 0;
    const ts = year && m && d ? new Date(year, m - 1, d).getTime() : 0;
    return { date: raw, year, ts };
  }
  return { date: raw, year: 0, ts: 0 };
}

function cleanBool(raw) {
  const v = String(raw || '').trim().toLowerCase();
  return v === 'yes' || v === 'true' || v === '1' || v === 'y';
}

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
  v = v.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  v = v
    .replace(/\bJUNIOR\s+SENIOR\s+HIGH\s+SCHOOL\b/g, 'HS')
    .replace(/\bSENIOR\s+HIGH\s+SCHOOL\b/g, 'HS')
    .replace(/\bHIGH\s+SCHOOL\b/g, 'HS')
    .replace(/\bJUNIOR\s+HIGH\s+SCHOOL\b/g, 'MS')
    .replace(/\bJUNIOR\s+HIGH\b/g, 'MS')
    .replace(/\bMIDDLE\s+SCHOOL\b/g, 'MS')
    .replace(/\bELEMENTARY\s+SCHOOL\b/g, 'ES')
    .replace(/\bINTERMEDIATE\s+SCHOOL\b/g, 'MS')
    .replace(/\bINTERMEDIATE\b/g, 'MS')
    .replace(/\s+/g, ' ')
    .trim();
  return cleanBoundaryName(v);
}

function cleanDistrictCode(raw) {
  const v = String(raw || '').trim();
  if (!v || v.toUpperCase() === 'NA' || v.toUpperCase() === 'N/A') return '';
  const name = v.replace(/^\d+\s*-\s*/, '').trim();
  if (!name) return '';
  if (/ISD$/i.test(name) || /SCHOOL\s+DISTRICT$/i.test(name)) {
    return cleanBoundaryName(name);
  }
  return cleanBoundaryName(name + ' Independent School District');
}

// Identical to build-chunked-json-cache.js normalizeRow — the chunk row shape
// must stay byte-compatible with what the engine expects.
function normalizeRow(row) {
  const close = cleanDate(row['Close Date'] || '');
  const baths = cleanNumber(row['FB']) + cleanNumber(row['HB']);
  const closePrice = cleanNumber(row['Close Price'] || row['Original List Price']);
  const sqft = cleanNumber(row['SF']);
  const pricePerSqft = cleanNumber(row['Price Sq Ft Sold'] || row['Prc/SF']);
  const listPrice = cleanNumber(row['Original List Price']);
  const lat = Number(row['Latitude']);
  const lng = Number(row['Longitude']);
  const zipRaw = String(row['Zip'] || '').trim();

  if (!closePrice || !lat || !lng) return null;

  return {
    mlsNumber: String(row['MLS Number'] || ''),
    address: String(row['Address'] || ''),
    city: String(row['City/Location'] || ''),
    state: String(row['State Or Province'] || ''),
    zip: zipRaw,
    closePrice,
    listPrice,
    pricePerSqft: pricePerSqft || (sqft ? closePrice / sqft : 0),
    sqft,
    lotSize: cleanNumber(row['Lot Size']),
    br: cleanNumber(row['BR']),
    baths,
    yearBuilt: cleanNumber(row['YB']),
    dom: cleanNumber(row['DOM']),
    cdom: cleanNumber(row['CDOM']),
    closeDate: close.date,
    closeYear: close.year,
    closeDateTs: close.ts,
    maintFee: cleanNumber(row['Maint Fee Amt']),
    maintFeeSchedule: String(row['Maint Fee Pay Schedule'] || '').toLowerCase(),
    taxRate: cleanNumber(row['Tax Rate']),
    taxYear: cleanNumber(row['Tax Year']),
    taxAmount: cleanNumber(row['Tax Amount']),

    subdivisions: cleanBoundaryName(row['Subdivision']),
    zipcodes: zipRaw,
    highschools: cleanDistrictCode(row['School District']),
    highschoolName: cleanSchoolName(row['School High']),
    elementary: cleanSchoolName(row['School Elementary']),
    middle: cleanSchoolName(row['School Middle']),
    schoolDistrict: String(row['School District'] || '').trim(),
    marketArea: String(row['Market Area'] || '').trim(),
    area: String(row['Area'] || '').trim(),

    lat,
    lng,

    propertyType: String(row['Property Type'] || '').trim(),
    pool: cleanBool(row['Pool Private']),
  };
}

function writeChunk(tmpDir, boundaryKey, index, rows) {
  const header = Object.keys(rows[0]);
  const compact = { header, rows: rows.map((r) => header.map((k) => r[k])) };
  const json = JSON.stringify(compact);
  const gz = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 6 });
  const fileName = `boundary_${boundaryKey}_${index}.json.gz`;
  fs.writeFileSync(path.join(tmpDir, fileName), gz);
  return fileName;
}

async function listAllRecursive(directoryRef) {
  const res = await listAll(directoryRef);
  const items = [...res.items];
  for (const prefix of res.prefixes) {
    items.push(...(await listAllRecursive(prefix)));
  }
  return items;
}

async function main() {
  // CLI overrides for the gate window.
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? Number(args[i + 1]) : null;
  };
  const expectedMin = flag('--expected-min') ?? BASELINE_ROWS - 20;
  const expectedMax = flag('--expected-max') ?? BASELINE_ROWS + 200_000;

  log('Listing CSVs under cms_files/csv ...');
  const listRef = ref(storage, 'cms_files/csv');
  const allItems = await listAllRecursive(listRef);

  const skipPattern = /(master_cache|property-manifest|chunk_area_index|^boundary_|^master_cache_chunk_)/i;
  const csvRefs = allItems.filter(
    (item) =>
      item.name.toLowerCase().endsWith('.csv') &&
      !skipPattern.test(item.name) &&
      !item.name.toLowerCase().startsWith('tea_')
  );
  log(`Found ${csvRefs.length} CSV files (${allItems.length} total items).`);

  // 2. Download + parse + normalize.
  const allRows = [];
  let rawRows = 0;
  let keptRows = 0;
  let failedFiles = 0;

  for (let i = 0; i < csvRefs.length; i++) {
    const itemRef = csvRefs[i];
    try {
      const url = await getDownloadURL(itemRef);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      await new Promise((resolve, reject) => {
        Papa.parse(text, {
          header: true,
          skipEmptyLines: true,
          step: (results) => {
            const row = {};
            Object.entries(results.data).forEach(([k, v]) => {
              row[stripBom(k)] = v;
            });
            const item = normalizeRow(row);
            rawRows++;
            if (item) {
              allRows.push(item);
              keptRows++;
            }
          },
          complete: () => resolve(),
          error: reject,
        });
      });
    } catch (err) {
      failedFiles++;
      log(`WARN failed ${itemRef.fullPath}: ${err.message}`);
    }
    if ((i + 1) % 25 === 0) log(`Parsed ${i + 1}/${csvRefs.length} files (kept ${keptRows.toLocaleString()} rows)`);
  }

  log(`Parsed ${rawRows.toLocaleString()} raw rows → ${keptRows.toLocaleString()} kept (failed files: ${failedFiles})`);

  // 3. Safety gate.
  if (keptRows < expectedMin || keptRows > expectedMax) {
    log(`GATE FAILED: kept ${keptRows.toLocaleString()} rows, expected between ${expectedMin.toLocaleString()} and ${expectedMax.toLocaleString()}.`);
    log('NOT uploading anything. Inspect the CSV list above for new/deleted files before retrying.');
    process.exit(1);
  }
  log(`Gate passed (${keptRows.toLocaleString()} rows within [${expectedMin.toLocaleString()}, ${expectedMax.toLocaleString()}]).`);

  // 4. Clean old chunk files in Storage, then build + upload the new ones.
  try {
    const listRes = await listAll(ref(storage, 'cms_files/csv'));
    const prefixesToDelete = ['master_cache_chunk_', 'boundary_', 'chunk_area_index'];
    for (const item of listRes.items) {
      if (prefixesToDelete.some((p) => item.name.startsWith(p))) {
        await deleteObject(item);
      }
    }
    log('Deleted old chunk files.');
  } catch (e) {
    log('Could not delete old chunks:', e.message);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kwizi-cms-cache-'));
  const boundaryGroups = Object.fromEntries(BOUNDARIES.map((b) => [b.key, new Map()]));
  for (const row of allRows) {
    for (const b of BOUNDARIES) {
      const key = b.keyFn(row);
      if (!key) continue;
      let arr = boundaryGroups[b.key].get(key);
      if (!arr) {
        arr = [];
        boundaryGroups[b.key].set(key, arr);
      }
      arr.push(row);
    }
  }

  const manifestBoundaries = {};
  const areaIndex = { version: Date.now(), boundaries: {} };
  const allChunkFileNames = [];

  for (const b of BOUNDARIES) {
    const groupsMap = boundaryGroups[b.key];
    const groups = Array.from(groupsMap.entries()).sort((a, c) => a[0].localeCompare(c[0]));
    const chunks = [];
    const boundaryIndex = {};
    let currentRows = [];

    const flush = () => {
      if (currentRows.length === 0) return;
      const chunkIdx = chunks.length;
      const fileName = writeChunk(tmpDir, b.key, chunkIdx, currentRows);
      chunks.push(`cms_files/csv/${fileName}`);
      allChunkFileNames.push(fileName);
      currentRows = [];
    };

    for (const [areaKey, rows] of groups) {
      if (rows.length > TARGET_ROWS_PER_CHUNK) {
        if (currentRows.length) flush();
        for (let i = 0; i < rows.length; i += TARGET_ROWS_PER_CHUNK) {
          const slice = rows.slice(i, i + TARGET_ROWS_PER_CHUNK);
          const chunkIdx = chunks.length;
          const fileName = writeChunk(tmpDir, b.key, chunkIdx, slice);
          chunks.push(`cms_files/csv/${fileName}`);
          allChunkFileNames.push(fileName);
          boundaryIndex[areaKey] = boundaryIndex[areaKey] || [];
          boundaryIndex[areaKey].push(chunkIdx);
        }
      } else {
        if (currentRows.length && currentRows.length + rows.length > TARGET_ROWS_PER_CHUNK) {
          flush();
        }
        const chunkIdx = chunks.length;
        currentRows.push(...rows);
        boundaryIndex[areaKey] = boundaryIndex[areaKey] || [];
        boundaryIndex[areaKey].push(chunkIdx);
      }
    }
    flush();

    manifestBoundaries[b.key] = { chunks };
    areaIndex.boundaries[b.key] = boundaryIndex;
    log(`${b.key}: ${groups.length.toLocaleString()} areas → ${chunks.length} chunks`);
  }

  const manifest = {
    version: areaIndex.version,
    totalRows: keptRows,
    format: 'boundary-chunks',
    defaultBoundary: 'subdivisions',
    boundaries: manifestBoundaries,
  };

  // Local copies (kept in sync for fast-cache deploys).
  const cacheDir = path.join(__dirname, '..', 'public', 'cache');
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'master_cache_chunks.json'), JSON.stringify(manifest));
  const indexJson = JSON.stringify(areaIndex);
  fs.writeFileSync(path.join(cacheDir, 'chunk_area_index.json'), indexJson);
  fs.writeFileSync(path.join(cacheDir, 'chunk_area_index.json.gz'), zlib.gzipSync(Buffer.from(indexJson, 'utf8'), { level: 9 }));
  for (const fileName of allChunkFileNames) {
    fs.copyFileSync(path.join(tmpDir, fileName), path.join(cacheDir, fileName));
  }
  log(`Wrote local manifest + ${allChunkFileNames.length} chunks to public/cache`);

  for (const fileName of allChunkFileNames) {
    const buffer = fs.readFileSync(path.join(tmpDir, fileName));
    await uploadBytes(ref(storage, `cms_files/csv/${fileName}`), buffer, { contentType: 'application/json' });
  }
  log(`Uploaded ${allChunkFileNames.length} chunks`);

  await uploadBytes(ref(storage, MANIFEST_PATH), Buffer.from(JSON.stringify(manifest), 'utf8'), { contentType: 'application/json' });
  log(`Uploaded manifest: ${MANIFEST_PATH} (version ${manifest.version})`);

  await uploadBytes(ref(storage, INDEX_PATH), fs.readFileSync(path.join(cacheDir, 'chunk_area_index.json.gz')), { contentType: 'application/json' });
  log(`Uploaded area index: ${INDEX_PATH}`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  log('Done.');
}

main().catch((err) => {
  console.error('[build-cache-from-cms] FAILED:', err);
  process.exit(1);
});