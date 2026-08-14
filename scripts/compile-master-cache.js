const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { finished } = require('stream/promises');
const Papa = require('papaparse');
const { initializeApp } = require('firebase/app');
const { getStorage, ref, listAll, getDownloadURL, uploadBytes, deleteObject } = require('firebase/storage');
const config = require('../src/lib/firebase-config-script.js');

const app = initializeApp(config);
const storage = getStorage(app);

const MASTER_PATH = 'cms_files/csv/master_cache.csv.gz';

function escapeCsvCell(v) {
  const s = String(v ?? '').replace(/"/g, '""');
  return `"${s}"`;
}

async function compileCache() {
  console.log('Fetching file list from Firebase Storage...');
  async function listAllRecursive(directoryRef) {
    let allItems = [];
    const res = await listAll(directoryRef);
    allItems.push(...res.items);
    for (const folderRef of res.prefixes) {
      const nestedItems = await listAllRecursive(folderRef);
      allItems.push(...nestedItems);
    }
    return allItems;
  }

  const listRef = ref(storage, 'cms_files/csv/');
  const items = await listAllRecursive(listRef);
  const csvRefs = items.filter(item => item.name.toLowerCase().endsWith('.csv') && !item.name.toLowerCase().includes('master_cache'));
  console.log('Found', csvRefs.length, 'CSV files.');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kwizi-compile-master-'));
  const gzPath = path.join(tmpDir, 'master_cache.csv.gz');
  const gzip = zlib.createGzip({ level: 6 });
  const output = fs.createWriteStream(gzPath);
  gzip.pipe(output);

  let masterHeader = null;
  let totalRows = 0;

  for (let i = 0; i < csvRefs.length; i++) {
    const itemRef = csvRefs[i];
    console.log(`Downloading ${i+1}/${csvRefs.length}: ${itemRef.name}`);
    const url = await getDownloadURL(itemRef);
    const fetchRes = await fetch(url);
    const text = await fetchRes.text();

    const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
    if (parsed.data.length === 0) continue;

    const fileHeader = (parsed.meta.fields || []).map(f => f.replace(/^﻿/, ''));
    if (!masterHeader) {
      masterHeader = fileHeader;
      gzip.write(masterHeader.map(escapeCsvCell).join(',') + '\n');
    }

    for (const row of parsed.data) {
      const cleanedRow = {};
      Object.entries(row).forEach(([k, v]) => { cleanedRow[k.replace(/^﻿/, '')] = v; });
      gzip.write(masterHeader.map(h => escapeCsvCell(cleanedRow[h])).join(',') + '\n');
      totalRows++;
    }
  }

  console.log('Total rows combined:', totalRows);
  if (totalRows === 0) {
    gzip.end();
    await finished(output);
    return console.log('No data to compile.');
  }

  gzip.end();
  await finished(output);

  const gzStats = fs.statSync(gzPath);
  console.log(`Gzipped master written: ${(gzStats.size / 1024 / 1024).toFixed(2)} MB`);

  const masterRef = ref(storage, MASTER_PATH);
  const gzBuffer = fs.readFileSync(gzPath);
  await uploadBytes(masterRef, gzBuffer, { contentType: 'text/csv' });
  console.log('Uploaded', MASTER_PATH);

  // Delete the old uncompressed master so it is not picked up accidentally.
  try { await deleteObject(ref(storage, 'cms_files/master_cache.csv')); } catch {}

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('Done!');
}

compileCache().catch(console.error);
