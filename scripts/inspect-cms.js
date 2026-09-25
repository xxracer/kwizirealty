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
  for (const cat of cats) {
    const snap = await db.collection('cms_files').where('category', '==', cat).limit(2).get();
    console.log(`\n=== CATEGORY: ${cat} (${snap.size}) ===`);
    for (const d of snap.docs) {
      const data = d.data();
      const keys = Object.keys(data).sort();
      console.log(`DOC ${d.id}: keys=[${keys.join(', ')}]`);
      console.log('  name:', data.name);
      console.log('  category:', data.category);
      console.log('  rowCount:', data.rowCount);
      console.log('  rows sample:', data.rows ? `${data.rows.length} rows, first=${JSON.stringify(data.rows[0]).slice(0, 200)}` : 'none');
      console.log('  rawContent length:', data.rawContent ? data.rawContent.length : 'none');
      console.log('  storageUrl:', data.storageUrl ? 'yes' : 'no');
      console.log('  storagePath:', data.storagePath || 'none');
    }
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
