const { initializeApp } = require('firebase/app');
const { getStorage, ref, getDownloadURL } = require('firebase/storage');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const zlib = require('zlib');

const firebaseConfig = require('../src/lib/firebase-config-script.js');

const BOUNDARY_FILES = [
  { name: 'Mapped Subdivisions.geojson', key: 'subdivisions' },
  { name: 'Zip.geojson', key: 'zipcodes' },
  { name: 'Houston_ISD.geojson', key: 'highschools' },
  { name: 'Elementary School ISD.geojson', key: 'elementary' },
  { name: 'Middle School ISD.geojson', key: 'middle' },
  { name: 'Mapped Subdivisions.geojson', key: 'neighborhoods' },
];

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

  const outDir = path.join(__dirname, '..', 'public', 'geojson');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  // Download each unique file once, then write aliases for keys that share the same source.
  // The GeoJSON is gzip-compressed at build time so Vercel serves a tiny file
  // and the client decompresses it in the browser.
  const downloaded = new Map();
  for (const { name, key } of BOUNDARY_FILES) {
    const dest = path.join(outDir, `${key}.geojson`);
    const gzDest = `${dest}.gz`;
    try {
      if (!downloaded.has(name)) {
        const url = await getDownloadURL(ref(storage, `cms_files/${name}`));
        const tmp = path.join(outDir, `.tmp_${name}`);
        await downloadFile(url, tmp);
        downloaded.set(name, tmp);
      }
      fs.copyFileSync(downloaded.get(name), dest);
      const gzipped = zlib.gzipSync(fs.readFileSync(dest), { level: 9 });
      fs.writeFileSync(gzDest, gzipped);
      fs.unlinkSync(dest);
      const size = fs.statSync(gzDest).size;
      console.log(`✓ ${key}.geojson.gz <- ${name} (${(size / 1024 / 1024).toFixed(2)} MB)`);
    } catch (err) {
      console.error(`✗ ${key}.geojson.gz failed:`, err.message);
      process.exitCode = 1;
    }
  }

  for (const tmp of downloaded.values()) {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
