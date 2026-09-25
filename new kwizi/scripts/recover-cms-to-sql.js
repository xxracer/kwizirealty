/**
 * scripts/recover-cms-to-sql.js — EMERGENCY RECOVERY
 *
 * Reads every property CSV currently tracked by the CMS (Firestore metadata
 * under cms_files) and upserts its rows directly into the SQL Connect
 * "properties" table. Use this when the SQL table is empty but the admin panel
 * still shows uploaded CSVs.
 *
 * Run:
 *   node scripts/recover-cms-to-sql.js
 *
 * Env:
 *   GOOGLE_APPLICATION_CREDENTIALS (or default gcloud ADC)
 */
process.env.GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'myreatstat';
process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  `${process.env.APPDATA}\\gcloud\\legacy_credentials\\maijelcancines2@gmail.com\\adc.json`;

const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getDataConnect } = require('firebase-admin/data-connect');
const Papa = require('papaparse');

const UPSERT_BATCH = 250;

const CATEGORIES_TO_IMPORT = new Set([
  'sales',
  'rent',
  'current-sale',
  'current-rent',
  'property',
  'tax',
]);

const app = initializeApp({});
const db = getFirestore(app);
const dc = getDataConnect(
  { location: 'us-central1', serviceId: 'kwizi-sql', connector: 'default' },
  app
);

function cleanNumber(val) {
  if (val == null || val === '') return 0;
  if (typeof val === 'number') return isFinite(val) ? val : 0;
  const n = Number(String(val).replace(/[^0-9.\-]+/g, ''));
  return isFinite(n) ? n : 0;
}

function cleanDate(raw) {
  if (!raw) return { date: '', year: 0, ts: 0 };
  const parts = String(raw).split('/');
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
  if (/ISD$/i.test(name) || /SCHOOL\s+DISTRICT$/i.test(name)) return cleanBoundaryName(name);
  return cleanBoundaryName(name + ' Independent School District');
}

function pickFirst(row, headers) {
  for (const h of headers) {
    const v = row[h];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

function detectYear(name, rows) {
  const m = name.match(/(?:^|\D)(19\d{2}|20\d{2})(?:\D|$)/);
  if (m) return parseInt(m[1], 10);
  const sample = rows.slice(0, 20);
  const yearHeaders = ['Close Year', 'Year', 'CloseDate', 'Close Date', 'List Year', 'Sale Year', 'Tax Year'];
  for (const header of yearHeaders) {
    const values = sample.map((r) => Number(r[header])).filter((n) => n >= 1900 && n <= 2099);
    if (values.length > 0) return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  }
  const dateHeaders = ['Close Date', 'CloseDate', 'List Date', 'Sale Date', 'Date', 'Tax Date'];
  for (const header of dateHeaders) {
    const years = [];
    for (const r of sample) {
      const raw = r[header];
      if (!raw) continue;
      const mm = String(raw).match(/\b(19\d{2}|20\d{2})\b/);
      if (mm) years.push(parseInt(mm[1], 10));
    }
    if (years.length > 0) return Math.round(years.reduce((a, b) => a + b, 0) / years.length);
  }
  return 0;
}

function csvRowToSql(row, category, defaultYear) {
  const isTax = category === 'tax';
  if (isTax) {
    const mlsHeaders = ['MLS #', 'MLS Number', 'MLS'];
    const yearHeaders = ['Tax Year', 'Year'];
    const rateHeaders = ['Tax Rate', 'Tax Rate %'];
    const amountHeaders = ['Tax Amount', 'Taxes'];
    const mls = pickFirst(row, mlsHeaders);
    if (!mls) return null;
    const taxRate = cleanNumber(pickFirst(row, rateHeaders));
    const taxYear = cleanNumber(pickFirst(row, yearHeaders));
    const taxAmount = cleanNumber(pickFirst(row, amountHeaders));
    if (!taxRate && !taxYear && !taxAmount) return null;
    return {
      mlsNumber: mls,
      listingType: 'tax',
      taxRate,
      taxYear,
      taxAmount,
      datasetYear: taxYear || defaultYear || 0,
      uploadSessionId: null,
      updatedAt: new Date().toISOString(),
    };
  }

  const close = cleanDate(row['Close Date'] || '');
  const baths = cleanNumber(row['FB']) + cleanNumber(row['HB']);
  const sqft = cleanNumber(row['SF']);
  const closePrice = cleanNumber(row['Close Price'] || row['Original List Price']);
  const listPrice = cleanNumber(row['Original List Price']);
  const pricePerSqft = cleanNumber(row['Price Sq Ft Sold'] || row['Prc/SF']) || (sqft ? closePrice / sqft : 0);
  const lat = Number(row['Latitude']);
  const lng = Number(row['Longitude']);
  const zipRaw = String(row['Zip'] || '').trim();

  if (!row['MLS Number'] || !closePrice || !lat || !lng) return null;

  const year = close.year || defaultYear || 0;
  const rentMode = category === 'rent' || category === 'current-rent';

  return {
    mlsNumber: String(row['MLS Number'] || ''),
    address: String(row['Address'] || ''),
    city: String(row['City/Location'] || ''),
    state: String(row['State Or Province'] || ''),
    zip: zipRaw,
    closePrice,
    listPrice,
    pricePerSqft,
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
    listingType: rentMode ? 'rent' : 'sale',
    datasetYear: year,
    uploadSessionId: null,
    updatedAt: new Date().toISOString(),
  };
}

(async () => {
  const started = Date.now();
  console.log('Loading CMS file list from Firestore...');
  const snap = await db.collection('cms_files').get();
  const files = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((f) => CATEGORIES_TO_IMPORT.has(f.category));
  console.log(`Found ${files.length} importable CSV files`);

  let skippedFiles = 0;
  const sqlRows = [];

  for (const file of files) {
    if (!file.storageUrl) {
      console.log(`SKIP (no storageUrl): ${file.name}`);
      skippedFiles++;
      continue;
    }
    try {
      const res = await fetch(file.storageUrl);
      if (!res.ok) {
        console.error(`FETCH_FAIL ${file.name}: ${res.status}`);
        skippedFiles++;
        continue;
      }
      const csvText = await res.text();
      const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
      const defaultYear = detectYear(file.name, parsed.data);
      let fileRows = 0;
      for (const row of parsed.data) {
        const sqlRow = csvRowToSql(row, file.category, defaultYear);
        if (sqlRow) {
          sqlRows.push(sqlRow);
          fileRows++;
        }
      }
      console.log(`PARSED ${file.name}: ${fileRows.toLocaleString()} valid rows (year=${defaultYear})`);
    } catch (err) {
      console.error(`ERROR ${file.name}:`, err.message || err);
      skippedFiles++;
    }
  }

  console.log(`\nTotal valid SQL rows to upsert: ${sqlRows.length.toLocaleString()}`);
  if (sqlRows.length === 0) {
    console.log('Nothing to import.');
    process.exit(0);
  }

  console.log('Clearing SQL properties table before recovery...');
  await dc.executeMutation('clearProperties', {});

  let done = 0;
  for (let i = 0; i < sqlRows.length; i += UPSERT_BATCH) {
    const batch = sqlRows.slice(i, i + UPSERT_BATCH);
    await dc.upsertMany('Property', batch);
    done += batch.length;
    const pct = ((done / sqlRows.length) * 100).toFixed(1);
    const elapsed = Math.round((Date.now() - started) / 1000);
    console.log(`  UPSERT ${done.toLocaleString()}/${sqlRows.length.toLocaleString()} (${pct}%) — ${elapsed}s`);
  }

  const check = await dc.executeQuery('distinctValues', {});
  const finalRows = Number(check.data?.values?.total_rows ?? 0);
  const elapsed = Math.round((Date.now() - started) / 1000);
  console.log(`\n✓ RECOVERY COMPLETE: ${finalRows.toLocaleString()} rows in SQL (${elapsed}s). ${skippedFiles} file(s) skipped.`);

  await db.collection('cms_meta').doc('sql_sync').set(
    { version: Date.now(), syncedChunks: [], done: true, totalRows: finalRows, updatedAt: new Date() },
    { merge: true }
  );

  process.exit(0);
})().catch((err) => {
  console.error('FATAL', err?.message || err);
  process.exit(1);
});
