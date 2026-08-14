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

const CSV_MASTER_PATH = 'cms_files/csv/master_cache.csv.gz';
const MANIFEST_PATH = 'cms_files/csv/master_cache_chunks.json';
const CHUNK_PREFIX = 'cms_files/csv/master_cache_chunk_';
const ROWS_PER_CHUNK = 200_000;

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

async function buildChunkedJsonCache() {
  log('Downloading CSV master...');
  const csvUrl = await getDownloadURL(ref(storage, CSV_MASTER_PATH));
  const res = await fetch(csvUrl);
  if (!res.ok) throw new Error(`Failed to fetch CSV master: ${res.status}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kwizi-chunked-json-'));
  const csvBuffer = Buffer.from(await res.arrayBuffer());
  const csvText = zlib.gunzipSync(csvBuffer).toString('utf8');
  log(`Decompressed CSV: ${csvText.length} bytes`);

  // Clean up old chunks first.
  try {
    const listRef = ref(storage, 'cms_files/csv');
    const listRes = await listAll(listRef);
    for (const item of listRes.items) {
      if (item.name.startsWith('master_cache_chunk_')) {
        await deleteObject(item);
        log('Deleted old chunk:', item.name);
      }
    }
  } catch (e) {
    log('Could not list/delete old chunks:', e.message);
  }

  const chunkPaths = [];
  let currentChunk = [];
  let totalRows = 0;
  let keptRows = 0;
  let chunkIndex = 0;
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
          currentChunk.push(item);
          keptRows++;
        }

        if (currentChunk.length >= ROWS_PER_CHUNK) {
          const chunkPath = `${CHUNK_PREFIX}${chunkIndex}.json.gz`;
          chunkPaths.push(chunkPath);
          writeChunk(tmpDir, chunkIndex, currentChunk);
          log(`Wrote chunk ${chunkIndex}: ${currentChunk.length.toLocaleString()} rows → ${chunkPath}`);
          currentChunk = [];
          chunkIndex++;
        }
      },
      complete: () => resolve(),
      error: (err) => reject(err),
    });
  });

  if (currentChunk.length > 0) {
    const chunkPath = `${CHUNK_PREFIX}${chunkIndex}.json.gz`;
    chunkPaths.push(chunkPath);
    writeChunk(tmpDir, chunkIndex, currentChunk);
    log(`Wrote chunk ${chunkIndex}: ${currentChunk.length.toLocaleString()} rows → ${chunkPath}`);
  }

  log(`Total rows: ${totalRows.toLocaleString()}, kept: ${keptRows.toLocaleString()}, chunks: ${chunkPaths.length}`);

  // Upload chunks.
  for (let i = 0; i < chunkPaths.length; i++) {
    const localPath = path.join(tmpDir, `chunk_${i}.json.gz`);
    const buffer = fs.readFileSync(localPath);
    const chunkRef = ref(storage, chunkPaths[i]);
    await uploadBytes(chunkRef, buffer, { contentType: 'application/json' });
    log(`Uploaded ${chunkPaths[i]} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
  }

  // Upload manifest.
  const manifest = {
    version: Date.now(),
    totalRows: keptRows,
    chunks: chunkPaths,
  };
  const manifestBuffer = Buffer.from(JSON.stringify(manifest), 'utf8');
  const manifestRef = ref(storage, MANIFEST_PATH);
  await uploadBytes(manifestRef, manifestBuffer, { contentType: 'application/json' });
  log(`Uploaded manifest: ${MANIFEST_PATH}`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  log('Done.');
}

function writeChunk(tmpDir, index, rows) {
  // Store as [header, ...rows] arrays instead of full objects to cut ~50% of
  // the JSON size and reduce browser parse time.
  const header = Object.keys(rows[0]);
  const compact = { header, rows: rows.map((r) => header.map((k) => r[k])) };
  const json = JSON.stringify(compact);
  const gz = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 6 });
  fs.writeFileSync(path.join(tmpDir, `chunk_${index}.json.gz`), gz);
}

buildChunkedJsonCache().catch((err) => {
  console.error(err);
  process.exit(1);
});
