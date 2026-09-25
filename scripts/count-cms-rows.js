process.env.GOOGLE_CLOUD_PROJECT = 'myreatstat';
process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  `${process.env.APPDATA}\\gcloud\\legacy_credentials\\maijelcancines2@gmail.com\\adc.json`;

const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const app = initializeApp({});
const db = getFirestore(app);

(async () => {
  const cats = ['sales', 'rent', 'current-sale', 'current-rent', 'property', 'tax'];
  const snap = await db.collection('cms_files').where('category', 'in', cats).get();
  let total = 0;
  let sqlImport = 0;
  for (const d of snap.docs) {
    const data = d.data();
    total += Number(data.rowCount || 0);
    if (data.sqlImport === true) sqlImport += Number(data.rowCount || 0);
  }
  console.log('Files:', snap.size);
  console.log('Total rows in cms_files:', total.toLocaleString());
  console.log('SQL import rows:', sqlImport.toLocaleString());
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
