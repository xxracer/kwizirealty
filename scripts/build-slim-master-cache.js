const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { finished } = require('stream/promises');
const Papa = require('papaparse');
const { initializeApp } = require('firebase/app');
const { getStorage, ref, getDownloadURL, uploadBytes, deleteObject } = require('firebase/storage');
const firebaseConfig = require('../src/lib/firebase-config-script.js');

const app = initializeApp(firebaseConfig);
const storage = getStorage(app);

const CSV_MASTER_PATH = 'cms_files/csv/master_cache.csv.gz';
const SLIM_MASTER_PATH = 'cms_files/csv/master_cache_slim.csv.gz'; // new slimmer version

const NEEDED_COLUMNS = [
  'MLS Number',
  'Address',
  'City/Location',
  'State Or Province',
  'Zip',
  'Close Price',
  'Original List Price',
  'Price Sq Ft Sold',
  'Prc/SF',
  'SF',
  'Lot Size',
  'BR',
  'FB',
  'HB',
  'YB',
  'DOM',
  'CDOM',
  'Close Date',
  'Maint Fee Amt',
  'Maint Fee Pay Schedule',
  'Tax Rate',
  'Tax Year',
  'Tax Amount',
  'Subdivision',
  'School District',
  'School High',
  'School Elementary',
  'School Middle',
  'Market Area',
  'Area',
  'Property Type',
  'Pool Private',
  'Latitude',
  'Longitude',
];

function log(...args) {
  console.log('[build-slim-master-cache]', ...args);
}

function stripBom(str) {
  return str.replace(/^﻿/, '');
}

function escapeCsvCell(v) {
  const s = String(v ?? '').replace(/"/g, '""');
  return `"${s}"`;
}

async function buildSlimMaster() {
  log('Downloading current CSV master...');
  const csvUrl = await getDownloadURL(ref(storage, CSV_MASTER_PATH));
  const res = await fetch(csvUrl);
  if (!res.ok) throw new Error(`Failed to fetch CSV master: ${res.status}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kwizi-slim-master-'));
  const slimGzPath = path.join(tmpDir, 'master_cache.csv.gz');

  const inputGzBuffer = Buffer.from(await res.arrayBuffer());
  const csvText = zlib.gunzipSync(inputGzBuffer).toString('utf8');
  log(`Decompressed: ${csvText.length} bytes`);

  const gzip = zlib.createGzip({ level: 9 });
  const output = fs.createWriteStream(slimGzPath);
  gzip.pipe(output);

  gzip.write(NEEDED_COLUMNS.map(escapeCsvCell).join(',') + '\n');

  let totalRows = 0;
  let keptRows = 0;
  const batchSize = 50000;

  // Use Papa.parse streaming for lower memory.
  await new Promise((resolve, reject) => {
    let batch = [];
    Papa.parse(csvText, {
      header: true,
      skipEmptyLines: true,
      step: (results) => {
        const row = results.data;
        const cleanedRow = {};
        Object.entries(row).forEach(([k, v]) => {
          cleanedRow[stripBom(k)] = v;
        });

        const line = NEEDED_COLUMNS.map((h) => escapeCsvCell(cleanedRow[h])).join(',') + '\n';
        gzip.write(line);
        totalRows++;
        keptRows++;

        if (totalRows % batchSize === 0) {
          log(`Processed ${totalRows.toLocaleString()} rows...`);
        }
      },
      complete: () => resolve(),
      error: (err) => reject(err),
    });
  });

  gzip.end();
  await finished(output);

  const slimStats = fs.statSync(slimGzPath);
  log(`Slim gzipped master: ${slimStats.size} bytes (${(slimStats.size / 1024 / 1024).toFixed(2)} MB)`);
  log(`Rows: ${keptRows.toLocaleString()}`);

  // Backup the old master first.
  try {
    const oldUrl = await getDownloadURL(ref(storage, CSV_MASTER_PATH));
    const oldRes = await fetch(oldUrl);
    if (oldRes.ok) {
      const oldBuffer = Buffer.from(await oldRes.arrayBuffer());
      const backupRef = ref(storage, 'cms_files/csv/master_cache.csv.gz.backup');
      await uploadBytes(backupRef, oldBuffer, { contentType: 'text/csv' });
      log('Backed up old master to master_cache.csv.gz.backup');
    }
  } catch (e) {
    log('Could not backup old master:', e.message);
  }

  // Upload slim version.
  const slimBuffer = fs.readFileSync(slimGzPath);
  const masterRef = ref(storage, SLIM_MASTER_PATH);
  await uploadBytes(masterRef, slimBuffer, { contentType: 'text/csv' });
  const downloadUrl = await getDownloadURL(masterRef);
  log('Slim master uploaded:', downloadUrl.slice(0, 80) + '...');

  fs.rmSync(tmpDir, { recursive: true, force: true });
  log('Done.');
}

buildSlimMaster().catch((err) => {
  console.error(err);
  process.exit(1);
});
