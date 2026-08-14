const { initializeApp } = require('firebase/app');
const { getStorage, ref, uploadBytes } = require('firebase/storage');
const fs = require('fs');
const path = require('path');
const config = require('../src/lib/firebase-config-script.js');

const app = initializeApp(config);
const storage = getStorage(app);

const CSV_DIR = path.join(__dirname, '../public/csv');
const UPLOAD_CONCURRENCY = 5;

async function walkDir(dir) {
  const files = [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkDir(fullPath)));
    } else if (entry.isFile() && (entry.name.endsWith('.csv') || entry.name.endsWith('.geojson'))) {
      files.push(fullPath);
    }
  }
  return files;
}

async function main() {
  console.log(`Scanning local folder: ${CSV_DIR}`);
  if (!fs.existsSync(CSV_DIR)) {
    console.error(`Folder not found: ${CSV_DIR}`);
    process.exit(1);
  }

  const allFiles = await walkDir(CSV_DIR);
  console.log(`Found ${allFiles.length} files to upload.`);

  const manifest = [];
  
  for (let i = 0; i < allFiles.length; i += UPLOAD_CONCURRENCY) {
    const chunk = allFiles.slice(i, i + UPLOAD_CONCURRENCY);
    const promises = chunk.map(async (localPath) => {
      const relativePath = path.relative(CSV_DIR, localPath).replace(/\\/g, '/');
      if (relativePath === 'property-manifest.json' || relativePath === 'master_cache.json' || relativePath === 'master_cache.csv') {
        return null;
      }
      
      const destination = `cms_files/csv/${relativePath}`;
      const ext = path.extname(localPath).toLowerCase();
      let contentType = 'application/octet-stream';
      if (ext === '.csv') contentType = 'text/csv';
      else if (ext === '.geojson') contentType = 'application/geo+json';
      
      const fileBuffer = fs.readFileSync(localPath);
      const fileRef = ref(storage, destination);
      await uploadBytes(fileRef, new Uint8Array(fileBuffer), { contentType });
      console.log(`Uploaded ${destination}`);
      return relativePath;
    });
    
    const results = await Promise.all(promises);
    manifest.push(...results.filter(Boolean));
  }
  
  const manifestData = JSON.stringify(manifest, null, 2);
  const localManifestPath = path.join(CSV_DIR, 'property-manifest.json');
  fs.writeFileSync(localManifestPath, manifestData);
  
  const manifestRef = ref(storage, 'cms_files/csv/property-manifest.json');
  await uploadBytes(manifestRef, new Uint8Array(fs.readFileSync(localManifestPath)), { contentType: 'application/json' });
  
  console.log('Manifest uploaded successfully.');
  console.log('Done!');
  process.exit(0);
}

main().catch(console.error);
