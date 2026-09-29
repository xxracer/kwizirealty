// Probe: dump headers of one sales + one rent CSV backup and count tax columns.
process.env.GOOGLE_CLOUD_PROJECT = 'myreatstat';
process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  `${process.env.APPDATA}\\gcloud\\legacy_credentials\\maijelcancines2@gmail.com\\adc.json`;

const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const zlib = require('zlib');
const Papa = require('papaparse');

const app = initializeApp({});
const db = getFirestore(app);

(async () => {
  for (const cat of ['sales', 'current-sale', 'rent']) {
    const snap = await db.collection('cms_files').where('category', '==', cat).limit(2).get();
    for (const doc of snap.docs) {
      const v = doc.data();
      if (!v.storageUrl) continue;
      const res = await fetch(v.storageUrl);
      const buf = Buffer.from(await res.arrayBuffer());
      const text = (buf[0] === 0x1f && buf[1] === 0x8b) ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
      const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
      const taxCols = (parsed.meta.fields || []).filter((f) => /tax/i.test(f));
      console.log(`\n[${cat}] ${v.name}`);
      console.log('tax columns:', JSON.stringify(taxCols));
      if (taxCols.length) {
        const r = parsed.data[0];
        console.log('sample:', taxCols.map((c) => `${c}=${JSON.stringify(r[c])}`).join(' | '));
      }
    }
  }
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });