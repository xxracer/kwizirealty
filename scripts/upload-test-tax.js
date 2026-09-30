/**
 * Tax-bucket upload test — same anonymous+API-key transport against the
 * deployed connector. Picks the first 2025 Tax Data file with real
 * Tax Amount values, stages 3 rows, commits, prints result.
 */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const Papa = require('papaparse');

const API_KEY = fs
  .readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8')
  .split('\n')
  .find((l) => l.startsWith('NEXT_PUBLIC_FIREBASE_API_KEY'))
  .split('=')[1]
  .replace(/"/g, '')
  .trim();
const SESSION = `upload-test-tax-${Date.now()}`;
const TAX_DIR =
  'C:/Users/VICTUS/Documents/houston-realestate-main/csv/Sales Data-20260801T175930Z-1-001/Sales Data/Tax Data/2025';

function loadSqlImportModule() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'sqlImport.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', outputText)(module, module.exports, require);
  return module.exports;
}

async function dcCall(operationName, variables) {
  const url = 'https://firebasedataconnect.googleapis.com/v1beta/projects/myreatstat/locations/us-central1/services/kwizi-sql/connectors/default:executeMutation';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
    body: JSON.stringify({ operationName, variables }),
  });
  const json = await res.json();
  if (json.errors?.length || !res.ok) throw new Error(`${operationName}: ${JSON.stringify(json.error || json.errors) || res.status}`);
  return json.data;
}

(async () => {
  const map = loadSqlImportModule().csvRowsToSqlPropertyRows;
  const files = fs.readdirSync(TAX_DIR).filter((f) => f.endsWith('.csv'));
  let sqlRows = [];
  for (const f of files) {
    const p = Papa.parse(fs.readFileSync(path.join(TAX_DIR, f), 'utf8'), { header: true, skipEmptyLines: true });
    const rows = p.data
      .filter((r) => { const v = (r['Tax Amount'] ?? r['Taxes'] ?? '').trim(); return v && v !== '0'; })
      .slice(0, 3);
    if (!rows.length) continue;
    sqlRows = map(rows, 'tax', SESSION, 2025);
    if (sqlRows.length) {
      console.log(`using ${f} → mapped ${sqlRows.length} tax rows`);
      break;
    }
  }
  if (!sqlRows.length) throw new Error('no tax file with values found');
  console.log('sample:', JSON.stringify({ ...sqlRows[0], uploadSessionId: '…' }));

  const staged = await dcCall('stagePropertyRows', {
    rows: JSON.stringify(
      sqlRows.map((r) => {
        const o = {};
        for (const [k, v] of Object.entries(r)) o[k] = typeof v === 'number' ? String(v) : v;
        return o;
      })
    ),
  });
  console.log('STAGE tax:', JSON.stringify(staged));
  const committed = await dcCall('commitPendingProperties', {});
  console.log('COMMIT:', JSON.stringify(committed));
  console.log('tax mlsNumber:', sqlRows[0].mlsNumber, 'datasetYear:', sqlRows[0].datasetYear);
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});