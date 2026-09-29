/**
 * Repair: rows from "Current for Sale Data" CSVs were staged as
 * listing_type='rent' because detectCategory matched "current".includes("rent")
 * — "cur-RENT" — so every Current-folder file became current-rent.
 *
 * Fix WITHOUT deleting anything: re-stage each affected file from its own
 * Storage CSV backup with the correct 'current-sale' type. stagePropertyRows
 * upserts by (mls_number, dataset_year) and updates listing_type, so the same
 * rows flip bucket in place — the merge semantics the owner demands (uploads
 * never wipe existing data).
 *
 * Steps per file: download backup → gunzip → parse → csvRowsToSqlPropertyRows
 * (transpiled from src/lib/sqlImport.ts so the mapping is IDENTICAL to the
 * browser's) → stagePropertyRows in 500-row batches (staged session) →
 * commitPendingProperties → fix the cms_files doc category → publish version.
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
const SESSION_ID = `repair-current-sale-${Date.now()}`;

/** Transpile src/lib/sqlImport.ts to CommonJS in memory and load it. */
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
  // Data Connect casts every field from its string form (NULLIF(...)::int …),
  // so numbers go over the wire as strings — same as the browser client does.
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
  const status = await dc.executeQuery('datasetStatus', {});
  console.log('Status before repair:', JSON.stringify(status.data.status));

  const { csvRowsToSqlPropertyRows } = loadSqlImportModule();

  const snap = await db.collection('cms_files')
    .where('category', '==', 'current-rent')
    .get();
  const affected = snap.docs.filter((d) => {
    const v = d.data();
    return typeof v.name === 'string' && v.name.startsWith('Current for Sale Data/');
  });
  console.log(`Affected files: ${affected.length}`);
  if (affected.length === 0) {
    console.log('Nothing to repair.');
    process.exit(0);
  }

  let totalStaged = 0;
  for (const docRef of affected) {
    const v = docRef.data();
    const name = v.name;
    try {
      if (!v.storageUrl) {
        console.log(`SKIP (no storage backup): ${name}`);
        continue;
      }
      const csvText = await fetchCsvText(v.storageUrl);
      const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
      const sqlRows = csvRowsToSqlPropertyRows(parsed.data, 'current-sale', SESSION_ID, v.year ?? null);
      console.log(`${name}: ${parsed.data.length} csv rows → ${sqlRows.length} sql rows`);
      for (let i = 0; i < sqlRows.length; i += CLIENT_BATCH) {
        const batch = toConnectorShape(sqlRows.slice(i, i + CLIENT_BATCH));
        await dc.executeMutation('stagePropertyRows', { rows: JSON.stringify(batch) });
      }
      totalStaged += sqlRows.length;
      // The CMS record moves to the correct bucket too.
      await docRef.ref.set({ category: 'current-sale' }, { merge: true });
    } catch (e) {
      console.error(`FAILED ${name}:`, e.message || e);
    }
  }

  console.log(`Staged ${totalStaged} rows under session ${SESSION_ID}. Committing...`);
  await dc.executeMutation('commitPendingProperties', {});

  const after = await dc.executeQuery('datasetStatus', {});
  console.log('Status after repair:', JSON.stringify(after.data.status));

  // Publish the new version so every browser refetches.
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
  process.exit(0);
})().catch((e) => {
  console.error('ERR', e.message || e);
  process.exit(1);
});