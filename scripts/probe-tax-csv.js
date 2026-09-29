// Probe: dump the headers + first rows of one tax CSV backup.
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
  const snap = await db.collection('cms_files').where('category', '==', 'tax').limit(1).get();
  const v = snap.docs[0].data();
  console.log('FILE:', v.name);
  const res = await fetch(v.storageUrl);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = (buf[0] === 0x1f && buf[1] === 0x8b) ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
  console.log('HEADERS:', JSON.stringify(parsed.meta.fields));
  console.log('ROW1:', JSON.stringify(parsed.data[0]));
  console.log('ROW2:', JSON.stringify(parsed.data[1]));
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });