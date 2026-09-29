// Diagnose the tax merge miss: for every tax CSV backup, count rows with
// Tax Amount / Tax Rate / Tax Year values, collect their MLS # set, and
// compare the MLS formats against a sample of sale rows (filteredProperties).
process.env.GOOGLE_CLOUD_PROJECT = 'myreatstat';
process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  `${process.env.APPDATA}\\gcloud\\legacy_credentials\\maijelcancines2@gmail.com\\adc.json`;

const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getDataConnect } = require('firebase-admin/data-connect');
const zlib = require('zlib');
const Papa = require('papaparse');

const app = initializeApp({});
const db = getFirestore(app);
const dc = getDataConnect({ location: 'us-central1', serviceId: 'kwizi-sql', connector: 'default' }, app);

function num(v) {
  if (v == null || v === '') return 0;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return isFinite(n) ? n : 0;
}

(async () => {
  const snap = await db.collection('cms_files').where('category', '==', 'tax').get();
  const files = snap.docs.map((d) => d.data()).filter((v) => v.storageUrl);
  console.log(`Tax backup files: ${files.length}`);

  let totalRows = 0, withAmount = 0, withRate = 0, withYear = 0, keptByMapper = 0;
  const taxMls = new Set();
  const mlsLengths = {};
  for (const v of files) {
    const res = await fetch(v.storageUrl);
    const buf = Buffer.from(await res.arrayBuffer());
    const text = (buf[0] === 0x1f && buf[1] === 0x8b) ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
    const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
    for (const row of parsed.data) {
      totalRows++;
      const mls = String(row['MLS #'] || row['MLS Number'] || row['MLS'] || '').trim();
      const amount = num(row['Tax Amount'] || row['Taxes']);
      const rate = num(row['Tax Rate'] || row['Tax Rate %']);
      const year = num(row['Tax Year']);
      if (amount > 0) withAmount++;
      if (rate > 0) withRate++;
      if (year > 0) withYear++;
      if (mls) {
        if (amount > 0 || rate > 0 || year > 0) { keptByMapper++; taxMls.add(mls); }
        mlsLengths[String(mls).length] = (mlsLengths[String(mls).length] || 0) + 1;
      }
    }
  }
  console.log(`CSV rows total=${totalRows} | withAmount=${withAmount} withRate=${withRate} withYear=${withYear}`);
  console.log(`Rows the mapper would keep (any tax value): ${keptByMapper} | unique MLSs: ${taxMls.size}`);
  console.log('Tax MLS digit lengths:', JSON.stringify(mlsLengths));

  // Sample of committed sale rows (md5-ordered deterministic sample).
  const vars = {
    saleMin: 0, saleMax: 20000000, sqftMin: 0, sqftMax: 20000,
    yearMin: 0, yearMax: 3000, bedsMin: 0, bedsMax: 100, bathsMin: 0, bathsMax: 100,
    l2sMin: 0, l2sMax: 1000000, domMin: 0, domMax: 1000000,
    lotSizeMin: 0, lotSizeMax: 100000000, ppsfMin: 0, ppsfMax: 100000000,
    rentMin: 0, rentMax: 100000000, startTs: null, endTs: null,
    propertyTypes: [], pool: 'any', schoolDistricts: [], cities: [],
    elementaryExplicit: [], elementaryRating: [], middleExplicit: [], middleRating: [],
    highschoolsExplicit: [], highSchoolRating: [], listingType: 'sale', limit: 30000,
  };
  const res = await dc.executeQuery('filteredProperties', vars);
  const props = (res.data?.properties || []);
  const saleMlsLens = {};
  let hits = 0;
  for (const p of props) {
    const mls = String(p.mls_number || '').trim();
    saleMlsLens[mls.length] = (saleMlsLens[mls.length] || 0) + 1;
    if (taxMls.has(mls)) hits++;
  }
  console.log(`Sale sample: ${props.length} rows | match tax MLSs: ${hits}`);
  console.log('Sale MLS digit lengths:', JSON.stringify(saleMlsLens));
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });