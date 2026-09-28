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
  // Harmless probe: a listing_type bucket that matches nothing.
  await dc.executeMutation('deletePropertiesByListingTypes', { types: ['__no_such_type__'], dateMode: 'any' });
  console.log('deletePropertiesByListingTypes: OK');

  // Empty-key probe: deletes nothing but proves the SQL is valid.
  await dc.executeMutation('deletePropertiesByKeys', { keys: '[]' });
  console.log('deletePropertiesByKeys: OK');

  const status = await dc.executeQuery('datasetStatus', {});
  console.log('Status (must be unchanged):', JSON.stringify(status.data.status));
  process.exit(0);
})();