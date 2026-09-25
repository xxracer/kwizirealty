process.env.GOOGLE_CLOUD_PROJECT = 'myreatstat';
process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  `${process.env.APPDATA}\\gcloud\\legacy_credentials\\maijelcancines2@gmail.com\\adc.json`;

const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const app = initializeApp({});
const db = getFirestore(app);

(async () => {
  const snap = await db.collection('cms_files').limit(20).get();
  for (const d of snap.docs) {
    const data = d.data();
    console.log(`\nDOC ${d.id}`);
    console.log('  name:', data.name);
    console.log('  category:', data.category);
    console.log('  rowCount:', data.rowCount);
    console.log('  sqlImport:', JSON.stringify(data.sqlImport, null, 2));
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
