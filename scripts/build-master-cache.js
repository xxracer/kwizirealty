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

const MANIFEST_PATH = path.join(__dirname, '..', 'public', 'csv', 'property-manifest.json');
const MASTER_PATH = 'cms_files/csv/master_cache.csv.gz';

const PUBLIC_CSV_ROOT = path.join(__dirname, '..', 'public', 'csv');

function log(...args) {
  console.log('[build-master-cache]', ...args);
}

async function readTextLocalOrFirebase(entry) {
  const localPath = path.join(PUBLIC_CSV_ROOT, ...entry.split('/'));
  if (fs.existsSync(localPath)) {
    return fs.readFileSync(localPath, 'utf8');
  }

  log('Downloading from Firebase:', entry);
  const url = await getDownloadURL(ref(storage, `cms_files/${entry}`));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${entry}: ${res.status}`);
  return res.text();
}

function stripBom(str) {
  return str.replace(/^﻿/, '');
}

function escapeCsvCell(v) {
  const s = String(v ?? '').replace(/"/g, '""');
  return `"${s}"`;
}

function rowToCsv(row, header) {
  return header.map((h) => escapeCsvCell(row[h])).join(',') + '\n';
}

async function buildMaster() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`Manifest not found: ${MANIFEST_PATH}`);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const csvEntries = manifest.filter((entry) => {
    const lower = entry.toLowerCase();
    return lower.endsWith('.csv') && !path.basename(lower).startsWith('tea_');
  });

  log(`Found ${csvEntries.length} CSV entries in manifest.`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kwizi-master-'));
  const gzPath = path.join(tmpDir, 'master_cache.csv.gz');

  const gzip = zlib.createGzip({ level: 6 });
  const output = fs.createWriteStream(gzPath);
  gzip.pipe(output);

  let masterHeader = null;
  let totalRows = 0;
  let processed = 0;

  for (const entry of csvEntries) {
    try {
      const text = await readTextLocalOrFirebase(entry);
      const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });

      if (!parsed.data.length) {
        processed++;
        continue;
      }

      const fileHeader = (parsed.meta.fields || []).map((f) => stripBom(f));

      if (!masterHeader) {
        masterHeader = fileHeader;
        gzip.write(masterHeader.map(escapeCsvCell).join(',') + '\n');
      }

      for (const row of parsed.data) {
        // Strip BOM from the first field name in this file so row values align.
        const cleanedRow = {};
        Object.entries(row).forEach(([k, v]) => {
          cleanedRow[stripBom(k)] = v;
        });
        gzip.write(rowToCsv(cleanedRow, masterHeader));
        totalRows++;
      }

      processed++;
      if (processed % 10 === 0 || processed === csvEntries.length) {
        log(`Processed ${processed}/${csvEntries.length} files, rows so far: ${totalRows}`);
      }
    } catch (err) {
      log('Error processing', entry, err.message);
      // Continue with remaining files so one bad file doesn't kill the build.
    }
  }

  gzip.end();
  await finished(output);

  const gzStats = fs.statSync(gzPath);
  log(`Gzipped master written: ${gzStats.size} bytes (${(gzStats.size / 1024 / 1024).toFixed(2)} MB)`);
  log(`Total rows: ${totalRows}`);

  // Upload to Firebase Storage.
  log(`Uploading to Firebase Storage at ${MASTER_PATH}...`);
  const masterRef = ref(storage, MASTER_PATH);
  const gzBuffer = fs.readFileSync(gzPath);
  // We upload gzip bytes but keep metadata as text/csv so Storage security rules
  // (which only allow specific content types) accept the upload.
  await uploadBytes(masterRef, gzBuffer, { contentType: 'text/csv' });
  const downloadUrl = await getDownloadURL(masterRef);
  log('Master cache uploaded:', downloadUrl.slice(0, 80) + '...');

  // Clean up stale uncompressed/plain master files if they exist.
  for (const stale of ['cms_files/master_cache.csv', 'cms_files/master_cache.json', 'master_cache/master_cache.json']) {
    try {
      await deleteObject(ref(storage, stale));
      log('Deleted stale master file:', stale);
    } catch (e) {
      // Ignore not-found errors.
    }
  }

  // Clean up temp file.
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) {
    log('Could not clean up temp dir:', e.message);
  }

  log('Done.');
}

buildMaster().catch((err) => {
  console.error(err);
  process.exit(1);
});
