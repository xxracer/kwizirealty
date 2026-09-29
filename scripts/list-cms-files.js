// Audit: every cms_files record — category, year, rowCount, uploadedAt.
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
  const files = snap.docs.map((d) => {
    const v = d.data();
    return {
      id: d.id,
      name: v.name,
      category: v.category,
      year: v.year ?? null,
      rowCount: v.rowCount ?? (Array.isArray(v.rows) ? v.rows.length : null),
      sqlImport: !!v.sqlImport,
      storageUrl: !!v.storageUrl,
      uploadedAt: v.uploadedAt,
    };
  });
  files.sort((a, b) => (a.uploadedAt || 0) - (b.uploadedAt || 0));
  for (const f of files) {
    console.log(
      `${new Date(f.uploadedAt || 0).toISOString()} | ${f.category} | year=${f.year} | rows=${f.rowCount} | ${f.name}`
    );
  }
  // Totals per category
  const byCat = {};
  for (const f of files) {
    byCat[f.category] = (byCat[f.category] || 0) + (f.rowCount || 0);
  }
  console.log('=== rowCounts by category ===');
  console.log(JSON.stringify(byCat, null, 1));
  process.exit(0);
})().catch((e) => {
  console.error('ERR', e.message || e);
  process.exit(1);
});