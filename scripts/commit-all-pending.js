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
  const before = await dc.executeQuery('datasetStatus', {});
  console.log('Before commit:', JSON.stringify(before.data, null, 2));

  console.log('Committing all pending rows...');
  await dc.executeMutation('commitPendingProperties', {});

  const after = await dc.executeQuery('datasetStatus', {});
  console.log('After commit:', JSON.stringify(after.data, null, 2));
  process.exit(0);
})();
