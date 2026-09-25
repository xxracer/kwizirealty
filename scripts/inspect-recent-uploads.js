process.env.GOOGLE_CLOUD_PROJECT = 'myreatstat';
process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  `${process.env.APPDATA}\\gcloud\\legacy_credentials\\maijelcancines2@gmail.com\\adc.json`;

const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const app = initializeApp({});
const db = getFirestore(app);

(async () => {
  const snap = await db.collection('cms_files').orderBy('uploadedAt', 'desc').limit(30).get();
  for (const d of snap.docs) {
    const data = d.data();
    console.log(`\nDOC ${d.id}`);
    console.log('  name:', data.name);
    console.log('  category:', data.category);
    console.log('  rowCount:', data.rowCount);
    console.log('  sqlImport:', data.sqlImport);
    console.log('  has rows:', Array.isArray(data.rows) ? `${data.rows.length} rows` : 'none');
    console.log('  has rawContent:', data.rawContent ? `yes (${data.rawContent.length} chars)` : 'no');
    console.log('  has storageUrl:', data.storageUrl ? 'yes' : 'no');
    console.log('  has storagePath:', data.storagePath ? 'yes' : 'no');
    if (Array.isArray(data.rows) && data.rows.length > 0) {
      console.log('  sample row:', JSON.stringify(data.rows[0]).slice(0, 200));
    }
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
