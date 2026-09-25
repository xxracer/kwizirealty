process.env.GOOGLE_CLOUD_PROJECT = 'myreatstat';
process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  `${process.env.APPDATA}\\gcloud\\legacy_credentials\\maijelcancines2@gmail.com\\adc.json`;

const { initializeApp } = require('firebase-admin/app');
const { getDataConnect } = require('firebase-admin/data-connect');

const app = initializeApp({});
const dc = getDataConnect(
  { location: 'us-central1', serviceId: 'kwizi-sql', connector: 'default' },
  app
);

(async () => {
  try {
    const res = await dc.executeQuery('datasetStatus', {});
    console.log('datasetStatus result:', JSON.stringify(res.data, null, 2));
  } catch (e) {
    console.error('datasetStatus error:', e?.message || e);
  }
  try {
    const res2 = await dc.executeQuery('distinctValues', {});
    console.log('distinctValues result:', JSON.stringify(res2.data, null, 2));
  } catch (e) {
    console.error('distinctValues error:', e?.message || e);
  }
  process.exit(0);
})();
