process.env.GOOGLE_CLOUD_PROJECT = 'myreatstat';
process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  `${process.env.APPDATA}\\gcloud\\legacy_credentials\\maijelcancines2@gmail.com\\adc.json`;

const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const app = initializeApp({});
const db = getFirestore(app);

(async () => {
  const totalRows = process.argv[2] ? Number(process.argv[2]) : 101606;
  await db.collection('cms_meta').doc('sql_sync').set(
    {
      version: Date.now(),
      done: true,
      directImport: true,
      totalRows,
      updatedAt: FieldValue.serverTimestamp(),
      importedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  console.log(`Published SQL-first dataset version with ${totalRows.toLocaleString()} rows.`);
  process.exit(0);
})();
