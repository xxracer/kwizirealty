process.env.GOOGLE_CLOUD_PROJECT = 'myreatstat';
process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  `${process.env.APPDATA}\\gcloud\\legacy_credentials\\maijelcancines2@gmail.com\\adc.json`;

const { initializeApp } = require('firebase-admin/app');
const { getDataConnect } = require('firebase-admin/data-connect');

const app = initializeApp({});
const dc = getDataConnect({ location: 'us-central1', serviceId: 'kwizi-sql', connector: 'default' }, app);

(async () => {
  const r = await dc.executeQuery('datasetStatus', {});
  console.log('datasetStatus:', JSON.stringify(r.data.status));
  process.exit(0);
})().catch((e) => {
  console.error('ERR', e.message || e);
  process.exit(1);
});