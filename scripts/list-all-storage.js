process.env.GOOGLE_CLOUD_PROJECT = 'myreatstat';
process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  `${process.env.APPDATA}\\gcloud\\legacy_credentials\\maijelcancines2@gmail.com\\adc.json`;

const { initializeApp } = require('firebase-admin/app');
const { getStorage } = require('firebase-admin/storage');
const app = initializeApp({ storageBucket: 'myreatstat.firebasestorage.app' });
const storage = getStorage(app);

storage.bucket().getFiles()
  .then(([files]) => {
    for (const f of files) console.log(f.name, f.metadata.size);
    process.exit(0);
  })
  .catch((e) => { console.error(e); process.exit(1); });
