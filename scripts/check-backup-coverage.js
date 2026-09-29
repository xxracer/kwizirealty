// Check: how many cms_files docs per SQL-backed category have a Storage backup
// (needed to re-stage sale/rent rows with their own tax columns).
process.env.GOOGLE_CLOUD_PROJECT = 'myreatstat';
process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  `${process.env.APPDATA}\\gcloud\\legacy_credentials\\maijelcancines2@gmail.com\\adc.json`;

const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const app = initializeApp({});
const db = getFirestore(app);

(async () => {
  const snap = await db.collection('cms_files').get();
  const byCat = {};
  for (const d of snap.docs) {
    const v = d.data();
    const c = v.category || '(none)';
    byCat[c] = byCat[c] || { files: 0, rows: 0, withBackup: 0, rowsWithBackup: 0 };
    byCat[c].files++;
    byCat[c].rows += v.rowCount || 0;
    if (v.storageUrl) { byCat[c].withBackup++; byCat[c].rowsWithBackup += v.rowCount || 0; }
  }
  console.log(JSON.stringify(byCat, null, 1));
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });