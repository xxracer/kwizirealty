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
  console.log('Committing test session...');
  await dc.executeMutation('commitPendingSession', { sessionId: 'test-session' });
  const status = await dc.executeQuery('datasetStatus', {});
  console.log('Status after commit:', JSON.stringify(status.data, null, 2));

  // Delete the test row so the user starts from a clean table.
  await dc.executeMutation('deletePendingSession', { sessionId: 'test-session' });
  const status2 = await dc.executeQuery('datasetStatus', {});
  console.log('Status after cleanup:', JSON.stringify(status2.data, null, 2));
  process.exit(0);
})();
