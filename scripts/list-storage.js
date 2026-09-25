process.env.GOOGLE_CLOUD_PROJECT = 'myreatstat';
process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  `${process.env.APPDATA}\\gcloud\\legacy_credentials\\maijelcancines2@gmail.com\\adc.json`;

const { initializeApp } = require('firebase-admin/app');
const { getStorage } = require('firebase-admin/storage');
const app = initializeApp({ storageBucket: 'myreatstat.firebasestorage.app' });
const storage = getStorage(app);

async function walk(prefix) {
  const [files, , apiResponse] = await storage.bucket().getFiles({ prefix, delimiter: '/' });
  for (const f of files) {
    if (f.name.endsWith('/')) continue;
    console.log(f.name, 'size=' + f.metadata.size);
  }
  const prefixes = apiResponse?.prefixes || [];
  for (const p of prefixes) {
    console.log('DIR ' + p);
    await walk(p);
  }
}

walk('cms_files/')
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
