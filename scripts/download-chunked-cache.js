const { initializeApp } = require('firebase/app');
const { getStorage, ref, getDownloadURL } = require('firebase/storage');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const firebaseConfig = require('../src/lib/firebase-config-script.js');

const MANIFEST_PATH = 'cms_files/csv/master_cache_chunks.json';
const INDEX_PATH = 'cms_files/csv/chunk_area_index.json.gz';

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

async function downloadOne(storageInstance, storagePath, dest) {
  const fileName = storagePath.split('/').pop();
  try {
    const url = await getDownloadURL(ref(storageInstance, storagePath));
    await downloadFile(url, dest);
    const size = fs.statSync(dest).size;
    console.log(`✓ ${fileName} (${(size / 1024 / 1024).toFixed(2)} MB)`);
    return true;
  } catch (err) {
    console.error(`✗ ${fileName} failed:`, err.message);
    return false;
  }
}

async function main() {
  initializeApp(firebaseConfig);
  const storage = getStorage();

  const outDir = path.join(__dirname, '..', 'public', 'cache');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  let manifest;
  try {
    const manifestUrl = await getDownloadURL(ref(storage, MANIFEST_PATH));
    const manifestRes = await fetch(manifestUrl);
    if (!manifestRes.ok) throw new Error(`Could not fetch manifest: ${manifestRes.status}`);
    manifest = await manifestRes.json();
  } catch (err) {
    // Manifest may be missing from Storage (e.g. data re-upload pending).
    // If a manifest is already committed in public/cache, reuse it and skip
    // the downloads instead of failing the build.
    const localManifest = path.join(outDir, 'master_cache_chunks.json');
    if (fs.existsSync(localManifest)) {
      console.warn(`⚠ Using committed master_cache_chunks.json (download failed: ${err.message})`);
      return;
    }
    throw err;
  }

  const manifestDest = path.join(outDir, 'master_cache_chunks.json');
  fs.writeFileSync(manifestDest, JSON.stringify(manifest));

  // Support both the legacy flat chunk list and the new per-boundary format.
  let chunkPaths = [];
  if (manifest.format === 'boundary-chunks' && manifest.boundaries) {
    chunkPaths = Object.values(manifest.boundaries).flatMap((b) => b.chunks || []);
    console.log(`✓ manifest written (boundary-chunks, ${chunkPaths.length} chunks, ${(manifest.totalRows || 0).toLocaleString()} rows)`);
  } else if (Array.isArray(manifest.chunks) && manifest.chunks.length > 0) {
    chunkPaths = manifest.chunks;
    console.log(`✓ manifest written (legacy flat, ${chunkPaths.length} chunks, ${(manifest.totalRows || 0).toLocaleString()} rows)`);
  } else {
    throw new Error('Invalid manifest: missing chunks array or boundaries object');
  }

  let failed = false;
  for (const chunkPath of chunkPaths) {
    const fileName = chunkPath.split('/').pop();
    const dest = path.join(outDir, fileName);
    const ok = (await downloadOne(storage, chunkPath, dest)) || fs.existsSync(dest);
    if (!ok) failed = true;
    else if (!fs.statSync(dest).size) failed = true;
  }

  // Also download the area->chunk index used by the engine for selective loading.
  const indexDest = path.join(outDir, 'chunk_area_index.json.gz');
  const indexOk =
    (await downloadOne(storage, INDEX_PATH, indexDest)) ||
    (fs.existsSync(indexDest) && fs.statSync(indexDest).size > 0);
  if (!indexOk) {
    // The index is required for fast selection; fail if missing.
    console.error('Area index download failed; selective chunk loading will not work.');
    failed = true;
  }

  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
