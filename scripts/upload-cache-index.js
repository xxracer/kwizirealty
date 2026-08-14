const { initializeApp } = require('firebase/app');
const { getStorage, ref, uploadBytes } = require('firebase/storage');
const fs = require('fs');
const path = require('path');

const firebaseConfig = require('../src/lib/firebase-config-script.js');

const app = initializeApp(firebaseConfig);
const storage = getStorage(app);

const CACHE_DIR = path.join(__dirname, '..', 'public', 'cache');

async function main() {
  // Upload the corrected area index and the current manifest so Vercel prebuild
  // downloads the matching set.
  const files = [
    { local: 'chunk_area_index.json.gz', remote: 'cms_files/csv/chunk_area_index.json.gz', contentType: 'application/json' },
    { local: 'master_cache_chunks.json', remote: 'cms_files/csv/master_cache_chunks.json', contentType: 'application/json' },
  ];

  for (const { local, remote, contentType } of files) {
    const buffer = fs.readFileSync(path.join(CACHE_DIR, local));
    await uploadBytes(ref(storage, remote), buffer, { contentType });
    console.log(`Uploaded ${local} → ${remote} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
