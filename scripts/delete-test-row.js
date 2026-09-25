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
    // Use a raw SQL mutation to delete the test row by MLS number and year.
    await dc.executeMutation('deletePropertyByMls', { mlsNumber: 'TEST-999999', datasetYear: 2021 });
  } catch (e) {
    console.warn('deletePropertyByMls mutation not found, leaving test row:', e?.message || e);
  }
  const status = await dc.executeQuery('datasetStatus', {});
  console.log('Status:', JSON.stringify(status.data, null, 2));
  process.exit(0);
})();
