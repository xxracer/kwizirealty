const { initializeApp } = require('firebase/app');
const { getStorage, ref, getDownloadURL } = require('firebase/storage');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const firebaseConfig = require('../src/lib/firebase-config-script.js');

const MANIFEST_PATH = 'cms_files/csv/master_cache_chunks.json';

async function downloadFile(url, dest) {
  const client = url.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    client
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close(resolve);
        });
      })
      .on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
  });
}

async function main() {
  initializeApp(firebaseConfig);
  const storage = getStorage();

  const outDir = path.join(__dirname, '..', 'public', 'cache');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const manifestUrl = await getDownloadURL(ref(storage, MANIFEST_PATH));
  const manifestRes = await fetch(manifestUrl);
  if (!manifestRes.ok) throw new Error(`Could not fetch manifest: ${manifestRes.status}`);
  const manifest = await manifestRes.json();
  if (!Array.isArray(manifest.chunks) || manifest.chunks.length === 0) {
    throw new Error('Invalid manifest: missing chunks array');
  }

  const manifestDest = path.join(outDir, 'master_cache_chunks.json');
  fs.writeFileSync(manifestDest, JSON.stringify(manifest));
  console.log(`✓ manifest written (${manifest.chunks.length} chunks, ${(manifest.totalRows || 0).toLocaleString()} rows)`);

  for (const chunkPath of manifest.chunks) {
    const fileName = chunkPath.split('/').pop();
    const dest = path.join(outDir, fileName);
    try {
      const url = await getDownloadURL(ref(storage, chunkPath));
      await downloadFile(url, dest);
      const size = fs.statSync(dest).size;
      console.log(`✓ ${fileName} (${(size / 1024 / 1024).toFixed(2)} MB)`);
    } catch (err) {
      console.error(`✗ ${fileName} failed:`, err.message);
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
