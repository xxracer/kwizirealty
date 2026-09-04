/**
 * import-properties-to-sql.js
 *
 * Bulk-imports the master property CSV into the Firebase SQL Connect (Data
 * Connect) Postgres table "properties" using firebase-admin's upsertMany
 * (ON CONFLICT (mls_number) DO UPDATE). No direct Postgres connection needed —
 * no IP whitelisting, no `pg` dependency.
 *
 * The row conversion replicates src/lib/engine.ts normalizeRows() + its
 * cleaning helpers so the SQL rows match exactly what the browser engine
 * produces (same boundary names, same derived fields, same closeDateTs ms).
 *
 * Usage (run AFTER `firebase deploy --only dataconnect` has created the table):
 *   set FIREBASE_SERVICE_ACCOUNT=<path-to-service-account.json>   (or GOOGLE_APPLICATION_CREDENTIALS)
 *   npm run import:sql
 *
 * Options:
 *   --file=path/to/master.csv.gz   use a local file instead of downloading from Storage
 *   --limit=1000                   import only the first N rows (test run)
 *   --batch=250                    rows per upsertMany call
 *   --dry-run                      parse + count only, no writes
 *
 * Idempotent: re-running upserts the same mlsNumbers in place, never deletes.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Papa = require('papaparse');

const BUCKET = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || '';
const MASTER_CANDIDATES = [
  'cms_files/csv/master_cache_slim.csv.gz', // preferred: same data, fewer columns
  'cms_files/csv/master_cache.csv.gz',
  'cms_files/csv/master_cache.json.gz',
  'cms_files/master_cache_slim.csv.gz',
  'cms_files/master_cache.csv.gz',
];

const args = process.argv.slice(2);
const argVal = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : null;
};
const FILE = argVal('file');
const LIMIT = argVal('limit') ? Number(argVal('limit')) : Infinity;
const BATCH = argVal('batch') ? Number(argVal('batch')) : 250;
const DRY_RUN = args.includes('--dry-run');

// ---- Cleaning helpers (copied from src/lib/engine.ts) ----------------------

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
  const v = String(raw || '').toUpperCase().trim();
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

// ---- Row conversion (mirrors engine.normalizeRows) ------------------------

function rowToSql(row) {
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

// ---- Source file resolution -------------------------------------------------

async function downloadMaster() {
  if (!BUCKET) throw new Error('NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET is not set');
  for (const candidate of MASTER_CANDIDATES) {
    const encoded = encodeURIComponent(candidate).replace(/%2F/g, '%2F');
    const url = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encoded}?alt=media`;
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      console.log(`✓ Downloaded ${candidate} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
      return buf;
    } catch {
      // try next candidate
    }
  }
  throw new Error('Could not find a master cache file in Firebase Storage');
}

function parseBuffer(buf) {
  let text;
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    text = zlib.gunzipSync(buf).toString('utf8');
  } else {
    text = buf.toString('utf8');
  }
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
  return parsed.data;
}

// ---- Main ------------------------------------------------------------------

async function main() {
  const { initializeApp, cert, applicationDefault } = require('firebase-admin/app');
  const { getDataConnect } = require('firebase-admin/data-connect');

  const location = process.env.DATACONNECT_LOCATION || 'us-central1';
  const serviceId = process.env.DATACONNECT_SERVICE_ID || 'kwizi-sql';
  const connector = process.env.DATACONNECT_CONNECTOR || 'default';

  let app;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const saPath = process.env.FIREBASE_SERVICE_ACCOUNT;
    const sa = fs.existsSync(saPath) ? JSON.parse(fs.readFileSync(saPath, 'utf8')) : JSON.parse(saPath);
    app = initializeApp({ credential: cert(sa) });
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    app = initializeApp({ credential: applicationDefault() });
  } else {
    throw new Error(
      'No admin credentials. Set FIREBASE_SERVICE_ACCOUNT=<path-to-service-account.json> or GOOGLE_APPLICATION_CREDENTIALS.'
    );
  }

  const dc = getDataConnect(app, { location, serviceId, connector });

  // Load source rows.
  let rows;
  if (FILE) {
    const buf = fs.readFileSync(FILE);
    rows = parseBuffer(buf);
    console.log(`✓ Read local file ${FILE}`);
  } else {
    const buf = await downloadMaster();
    rows = parseBuffer(buf);
  }
  console.log(`Parsed ${rows.length.toLocaleString()} CSV rows`);

  // Convert to SQL row shape.
  const sqlRows = [];
  for (const row of rows) {
    const r = rowToSql(row);
    if (r) sqlRows.push(r);
    if (sqlRows.length >= LIMIT) break;
  }
  console.log(`Converted ${sqlRows.length.toLocaleString()} valid rows (${rows.length - sqlRows.length} skipped: missing price/coords)`);

  if (DRY_RUN) {
    console.log('Dry run — nothing written. Re-run without --dry-run to import.');
    return;
  }

  // Upsert in batches.
  let done = 0;
  const started = Date.now();
  for (let i = 0; i < sqlRows.length; i += BATCH) {
    const batch = sqlRows.slice(i, i + BATCH);
    await dc.upsertMany('properties', batch);
    done += batch.length;
    const pct = ((done / sqlRows.length) * 100).toFixed(1);
    const rate = done / Math.max(1, (Date.now() - started) / 1000);
    console.log(`  ${done.toLocaleString()}/${sqlRows.length.toLocaleString()} (${pct}%) — ${rate.toFixed(0)} rows/s`);
  }

  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`\n✓ Imported ${done.toLocaleString()} rows in ${secs}s. Re-run anytime to upsert changes.`);
}

main().catch((err) => {
  console.error('✗ Import failed:', err.message || err);
  process.exit(1);
});
