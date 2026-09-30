/**
 * Upload-path test against the DEPLOYED Data Connect connector using the EXACT
 * browser transport: plain fetch + `x-goog-api-key`, NO OAuth token — the
 * "fresh browser, nobody signed in" scenario that failed with
 * "Request had invalid authentication credentials".
 *
 * Real CSV rows, one small batch per category (backup under csv/):
 *   sales / rent / tax / current-sale / current-rent
 *
 * Then: commit pending, publish the sql_sync version in Firestore, and print
 * datasetStatus + rowMixByYear to prove the rows are committed.
 *
 *   node scripts/upload-test-batches.js
 */

const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const Papa = require('papaparse');

const SALE_ROOT =
  'C:/Users/VICTUS/Documents/houston-realestate-main/csv/Sales Data-20260801T175930Z-1-001/Sales Data';

const PROJECT_ID = 'myreatstat';
const LOCATION = 'us-central1';
const SERVICE = 'kwizi-sql';
const CONNECTOR = 'default';

const SESSION_ID = `upload-test-${Date.now()}`;
const TEST_YEAR = 2025;

const API_KEY = fs
  .readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8')
  .split('\n')
  .find((l) => l.startsWith('NEXT_PUBLIC_FIREBASE_API_KEY'))
  .split('=')[1]
  .replace(/"/g, '')
  .trim();

/** Anonymous call — x-goog-api-key ONLY, no Authorization header. */
async function dcCall(method, operationName, variables) {
  const url = `https://firebasedataconnect.googleapis.com/v1beta/projects/${PROJECT_ID}/locations/${LOCATION}/services/${SERVICE}/connectors/${CONNECTOR}:${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
    body: JSON.stringify({ operationName, variables }),
  });
  const json = await res.json();
  if (json.errors?.length) throw new Error(`${operationName}: ${json.errors[0].message}`);
  if (!res.ok) throw new Error(`${operationName}: HTTP ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function getAccessToken() {
  const adcPath = `${process.env.APPDATA}/gcloud/legacy_credentials/maijelcancines2@gmail.com/adc.json`;
  const parsed = JSON.parse(fs.readFileSync(adcPath, 'utf8'));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: parsed.client_id,
      client_secret: parsed.client_secret,
      refresh_token: parsed.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`token refresh failed: HTTP ${res.status}`);
  return (await res.json()).access_token;
}

/**
 * Publish cms_meta/sql_sync via Firestore REST (same thing the admin "Add All"
 * does with publishSqlDatasetVersion).
 */
async function publishSqlVersion(token, totalRows) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/cms_meta/sql_sync`;
  const body = {
    fields: {
      version: { integerValue: String(Date.now()) },
      done: { booleanValue: true },
      directImport: { booleanValue: true },
      totalRows: { integerValue: String(totalRows) },
      updatedAt: { timestampValue: new Date().toISOString() },
      importedAt: { timestampValue: new Date().toISOString() },
    },
  };
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`publish: HTTP ${res.status} ${await res.text()}`);
}

function loadSqlImportModule() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'sqlImport.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', outputText)(module, module.exports, require);
  return module.exports;
}

/** Find the first CSV file, descending into subfolders (e.g. Tax Data/2025/). */
function firstCsv(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      try {
        return firstCsv(full);
      } catch {
        /* no csv here, keep walking */
      }
    } else if (name.toLowerCase().endsWith('.csv')) {
      const text = fs.readFileSync(full, 'utf8');
      const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
      return { file: path.relative(dir, full), rows: parsed.data.slice(0, 3) };
    }
  }
  throw new Error(`no csv under ${dir}`);
}

function toConnectorShape(sqlRows) {
  return sqlRows.map((row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) out[k] = typeof v === 'number' ? String(v) : v;
    return out;
  });
}

(async () => {
  const { csvRowsToSqlPropertyRows } = loadSqlImportModule();

  const before = await dcCall('executeQuery', 'datasetStatus', {});
  console.log('BEFORE:', JSON.stringify(before.data?.status));

  const tests = [
    { label: 'sales 2025', category: 'sales', dir: path.join(SALE_ROOT, 'Sale Data', 'Sale 2025'), year: TEST_YEAR },
    { label: 'rent 2025', category: 'rent', dir: path.join(SALE_ROOT, 'Rent Data', 'Rent 2025'), year: TEST_YEAR },
    { label: 'tax 2025', category: 'tax', dir: path.join(SALE_ROOT, 'Tax Data'), year: TEST_YEAR },
    { label: 'current-sale', category: 'current-sale', dir: path.join(SALE_ROOT, 'Current for Sale Data'), year: null },
    { label: 'current-rent', category: 'current-rent', dir: path.join(SALE_ROOT, 'Current for Rent Data'), year: null },
  ];

  const markers = [];
  for (const t of tests) {
    const { file, rows } = firstCsv(t.dir);
    const sqlRows = csvRowsToSqlPropertyRows(rows, t.category, SESSION_ID, t.year);
    if (!sqlRows.length) {
      console.log(`[${t.label}] no mappable rows in ${file}`);
      continue;
    }
    const shape = toConnectorShape(sqlRows);
    const res = await dcCall('executeMutation', 'stagePropertyRows', { rows: JSON.stringify(shape) });
    console.log(`[${t.label}] STAGED ${sqlRows.length} rows from ${file} → _execute=${res?.data?._execute}`);
    markers.push({ label: t.label, mls: shape[0].mlsNumber, year: shape[0].datasetYear });
  }
  if (!markers.length) {
    console.error('Nothing staged — aborting');
    process.exit(1);
  }

  const mid = await dcCall('executeQuery', 'datasetStatus', {});
  console.log('AFTER STAGE (pending should be > 0):', JSON.stringify(mid.data?.status));

  const commit = await dcCall('executeMutation', 'commitPendingProperties', {});
  console.log('commitPendingProperties →', JSON.stringify(commit.data));

  const token = await getAccessToken();
  const afterCommit = await dcCall('executeQuery', 'datasetStatus', {});
  const status = afterCommit.data?.status ?? {};
  await publishSqlVersion(token, status.committed ?? 0);
  console.log('published sql_sync version with', status.committed, 'total rows');

  const yearMix = await dcCall('executeQuery', 'rowMixByYear', {});
  console.log('\nrowMixByYear (committed):', JSON.stringify(yearMix.data?.rows));
  const saleMix = await dcCall('executeQuery', 'rowMixSaleMix', {});
  console.log('rowMixSaleMix (committed):', JSON.stringify(saleMix.data?.rows));

  console.log('\nMarkers uploaded (all anonymous, no sign-in):');
  for (const m of markers) console.log(`  ${m.label}: mlsNumber=${m.mls} datasetYear=${m.year}`);
  console.log('\nDONE — upload path works in production for a signed-out browser.');
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});