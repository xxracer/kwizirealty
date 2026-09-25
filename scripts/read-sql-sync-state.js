process.env.GOOGLE_CLOUD_PROJECT = 'myreatstat';
process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  `${process.env.APPDATA}\\gcloud\\legacy_credentials\\maijelcancines2@gmail.com\\adc.json`;

const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const app = initializeApp({});
const db = getFirestore(app);

(async () => {
  const snap = await db.collection('cms_meta').doc('sql_sync').get();
  if (!snap.exists) {
    console.log('sql_sync doc does not exist');
  } else {
    console.log('sql_sync state:', JSON.stringify(snap.data(), null, 2));
  }
  process.exit(0);
})();
