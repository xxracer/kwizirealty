/**
 * Repair: sale/rent CSVs carry their own Tax Year / Tax Amount / Tax Rate
 * columns (the legacy engine read them — engineCore.normalizeRow), but
 * csvRowsToSqlPropertyRows used to ignore them, so NO sale row in SQL has tax
 * data → the tax report showed "No tax data yet" and the tax polygons never
 * painted. The dedicated 'tax' uploads use a different MLS namespace
 * (CoreLogic parcels: 0 matches in a 30k sale sample), so mergeTaxIntoSaleRows
 * alone can't fix it.
 *
 * Fix WITHOUT deleting anything: re-stage every SQL-backed property file from
 * its own Storage backup with the mapper that now maps the tax columns.
 * stagePropertyRows upserts by (mls_number, dataset_year) and every column
 * comes from the same CSV, so the rows are rewritten identically PLUS the tax
 * values. The upsert COALESCEs tax fields, so rows whose backup has empty tax
 * cells keep whatever they already had.
 *
 *   node scripts/reimport-with-tax.js
 *
 * ~671k rows in 500-row batches — takes a while; progress prints per file.
 * Run while no one else is committing uploads (a staged session is committed
 * globally at the end).
 */
process.env.GOOGLE_CLOUD_PROJECT = 'myreatstat';
process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  `${process.env.APPDATA}\\gcloud\\legacy_credentials\\maijelcancines2@gmail.com\\adc.json`;

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ts = require('typescript');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getDataConnect } = require('firebase-admin/data-connect');
const Papa = require('papaparse');

const app = initializeApp({});
const dc = getDataConnect({ location: 'us-central1', serviceId: 'kwizi-sql', connector: 'default' }, app);
const db = getFirestore(app);

const CLIENT_BATCH = 500;
const SESSION_ID = `reimport-with-tax-${Date.now()}`;
const CATEGORIES = ['sales', 'current-sale', 'rent', 'current-rent'];

function loadSqlImportModule() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'sqlImport.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', outputText)(module, module.exports, require);
  return module.exports;
}

function toConnectorShape(sqlRows) {
  return sqlRows.map((row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = typeof v === 'number' ? String(v) : v;
    }
    return out;
  });
}

async function fetchCsvText(storageUrl) {
  const res = await fetch(storageUrl);
  if (!res.ok) throw new Error(`backup download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const isGzip = buf[0] === 0x1f && buf[1] === 0x8b;
  return isGzip ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
}

(async () => {
  const before = await dc.executeQuery('datasetStatus', {});
  console.log('Before:', JSON.stringify(before.data.status));

  const { csvRowsToSqlPropertyRows } = loadSqlImportModule();

  const snap = await db.collection('cms_files')
    .where('category', 'in', CATEGORIES)
    .get();
  const files = snap.docs.map((d) => d.data()).filter((v) => v.storageUrl && v.name);
  console.log(`Property files to re-stage: ${files.length}`);

  let totalStaged = 0;
  let done = 0;
  for (const v of files) {
    done++;
    try {
      const csvText = await fetchCsvText(v.storageUrl);
      const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
      const sqlRows = csvRowsToSqlPropertyRows(parsed.data, v.category, SESSION_ID, v.year ?? null);
      for (let i = 0; i < sqlRows.length; i += CLIENT_BATCH) {
        const batch = toConnectorShape(sqlRows.slice(i, i + CLIENT_BATCH));
        await dc.executeMutation('stagePropertyRows', { rows: JSON.stringify(batch) });
      }
      totalStaged += sqlRows.length;
      const withTax = sqlRows.filter((r) => Number(r.taxAmount) > 0 || Number(r.taxRate) > 0).length;
      console.log(`[${done}/${files.length}] ${v.name}: ${sqlRows.length} rows (${withTax} with tax)`);
    } catch (e) {
      console.error(`FAILED ${v.name}:`, e.message || e);
    }
  }

  console.log(`Staged ${totalStaged} rows under session ${SESSION_ID}. Committing...`);
  await dc.executeMutation('commitPendingProperties', {});
  // Re-merge the dedicated tax bucket too (idempotent, may catch a few MLSs).
  try {
    await dc.executeMutation('mergeTaxIntoSaleRows', {});
  } catch (e) {
    console.warn('mergeTaxIntoSaleRows failed (skipped):', e.message || e);
  }

  const after = await dc.executeQuery('datasetStatus', {});
  console.log('After:', JSON.stringify(after.data.status));

  if (String(after.data.status.committed) === String(before.data.status.committed)) {
    await db.collection('cms_meta').doc('sql_sync').set(
      {
        version: Date.now(),
        done: true,
        directImport: true,
        totalRows: after.data.status.committed,
        updatedAt: FieldValue.serverTimestamp(),
        importedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    console.log(`Published version with ${after.data.status.committed} rows.`);
  } else {
    console.log(`ROW COUNT CHANGED (${before.data.status.committed} → ${after.data.status.committed}) — version NOT published, inspect manually.`);
  }
  process.exit(0);
})().catch((e) => {
  console.error('ERR', e.message || e);
  process.exit(1);
});