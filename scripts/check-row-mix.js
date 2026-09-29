// One-off probe: row counts by listing_type / year via the rowMix connector op.
process.env.GOOGLE_CLOUD_PROJECT = 'myreatstat';
process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  `${process.env.APPDATA}\\gcloud\\legacy_credentials\\maijelcancines2@gmail.com\\adc.json`;

const { initializeApp } = require('firebase-admin/app');
const { getDataConnect } = require('firebase-admin/data-connect');

const app = initializeApp({});
const dc = getDataConnect({ location: 'us-central1', serviceId: 'kwizi-sql', connector: 'default' }, app);

(async () => {
  const res = { data: {} };
  for (const op of ['rowMixByType', 'rowMixByYear', 'rowMixSaleMix']) {
    try {
      res.data[op] = (await dc.executeQuery(op, {})).data.rows;
    } catch (e) {
      console.error(`${op} failed:`, e.message || e);
      res.data[op] = [];
    }
  }
  console.log(JSON.stringify(res.data, null, 1));
  process.exit(0);
})().catch((e) => {
  console.error('ERR', e.message || e);
  process.exit(1);
});