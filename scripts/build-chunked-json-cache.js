const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Papa = require('papaparse');
const { initializeApp } = require('firebase/app');
const { getStorage, ref, getDownloadURL, uploadBytes, deleteObject, listAll } = require('firebase/storage');
const firebaseConfig = require('../src/lib/firebase-config-script.js');

const app = initializeApp(firebaseConfig);
const storage = getStorage(app);

const CSV_MASTER_PATH = 'cms_files/csv/master_cache.csv.gz';
const MANIFEST_PATH = 'cms_files/csv/master_cache_chunks.json';
const INDEX_PATH = 'cms_files/csv/chunk_area_index.json.gz';
const TARGET_ROWS_PER_CHUNK = 15_000;

const BOUNDARIES = [
  { key: 'subdivisions', keyFn: (r) => r.subdivisions },
  { key: 'zipcodes', keyFn: (r) => r.zipcodes },
  { key: 'highschools', keyFn: (r) => r.highschools },
  { key: 'elementary', keyFn: (r) => r.elementary },
  { key: 'middle', keyFn: (r) => r.middle },
];

function log(...args) {
  console.log('[build-chunked-json-cache]', ...args);
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

async function buildChunkedJsonCache() {
  log('Downloading CSV master...');
  const csvUrl = await getDownloadURL(ref(storage, CSV_MASTER_PATH));
  const res = await fetch(csvUrl);
  if (!res.ok) throw new Error(`Failed to fetch CSV master: ${res.status}`);

  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'kwizi-boundary-chunks-'));
  const csvBuffer = Buffer.from(await res.arrayBuffer());
  const csvText = zlib.gunzipSync(csvBuffer).toString('utf8');
  log(`Decompressed CSV: ${csvText.length} bytes`);

  // Clean up old chunk files first so we don't leave stale boundary_* files behind.
  try {
    const listRef = ref(storage, 'cms_files/csv');
    const listRes = await listAll(listRef);
    const prefixesToDelete = ['master_cache_chunk_', 'boundary_', 'chunk_area_index'];
    for (const item of listRes.items) {
      if (prefixesToDelete.some((p) => item.name.startsWith(p))) {
        await deleteObject(item);
        log('Deleted old file:', item.name);
      }
    }
  } catch (e) {
    log('Could not list/delete old chunks:', e.message);
  }

  const allRows = [];
  let totalRows = 0;
  let keptRows = 0;
  let header = null;

  await new Promise((resolve, reject) => {
    Papa.parse(csvText, {
      header: true,
      skipEmptyLines: true,
      step: (results) => {
        if (!header) header = (results.meta.fields || []).map(stripBom);
        const row = results.data;
        const cleanedRow = {};
        Object.entries(row).forEach(([k, v]) => {
          cleanedRow[stripBom(k)] = v;
        });
        const item = normalizeRow(cleanedRow);
        totalRows++;
        if (item) {
          allRows.push(item);
          keptRows++;
        }
      },
      complete: () => resolve(),
      error: (err) => reject(err),
    });
  });

  log(`Parsed ${totalRows.toLocaleString()} rows, kept ${keptRows.toLocaleString()}`);

  // Group rows by boundary area key.
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
    // Sort keys for deterministic output.
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
      log(`Wrote ${b.key} chunk ${chunkIdx}: ${currentRows.length.toLocaleString()} rows → ${fileName}`);
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
          log(`Wrote ${b.key} chunk ${chunkIdx}: ${slice.length.toLocaleString()} rows → ${fileName} (slice for ${areaKey})`);
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

  // Write manifest, index, and chunk files locally in public/cache as well.
  const cacheDir = path.join(__dirname, '..', 'public', 'cache');
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

  const localManifestPath = path.join(cacheDir, 'master_cache_chunks.json');
  fs.writeFileSync(localManifestPath, JSON.stringify(manifest));
  log('Wrote local manifest:', localManifestPath);

  const indexJson = JSON.stringify(areaIndex);
  const localIndexPath = path.join(cacheDir, 'chunk_area_index.json');
  const localIndexGzPath = `${localIndexPath}.gz`;
  fs.writeFileSync(localIndexPath, indexJson);
  fs.writeFileSync(localIndexGzPath, zlib.gzipSync(Buffer.from(indexJson, 'utf8'), { level: 9 }));
  log('Wrote local area index:', localIndexGzPath);

  for (const fileName of allChunkFileNames) {
    const src = path.join(tmpDir, fileName);
    const dest = path.join(cacheDir, fileName);
    fs.copyFileSync(src, dest);
  }
  log(`Copied ${allChunkFileNames.length} chunk files to ${cacheDir}`);

  // Upload chunks.
  for (const fileName of allChunkFileNames) {
    const localPath = path.join(tmpDir, fileName);
    const buffer = fs.readFileSync(localPath);
    const chunkRef = ref(storage, `cms_files/csv/${fileName}`);
    await uploadBytes(chunkRef, buffer, { contentType: 'application/json' });
    log(`Uploaded ${fileName} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
  }

  // Upload manifest.
  const manifestBuffer = Buffer.from(JSON.stringify(manifest), 'utf8');
  const manifestRef = ref(storage, MANIFEST_PATH);
  await uploadBytes(manifestRef, manifestBuffer, { contentType: 'application/json' });
  log(`Uploaded manifest: ${MANIFEST_PATH}`);

  // Upload area index.
  const indexBuffer = fs.readFileSync(localIndexGzPath);
  const indexRef = ref(storage, INDEX_PATH);
  await uploadBytes(indexRef, indexBuffer, { contentType: 'application/json' });
  log(`Uploaded area index: ${INDEX_PATH}`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  log('Done.');
}

buildChunkedJsonCache().catch((err) => {
  console.error(err);
  process.exit(1);
});
