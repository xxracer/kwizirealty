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

const testRow = {
  mlsNumber: 'TEST-999999',
  address: '123 Test St',
  city: 'Houston',
  state: 'TX',
  zip: '77001',
  closePrice: 250000,
  listPrice: 260000,
  pricePerSqft: 150,
  sqft: 1667,
  lotSize: 5000,
  br: 3,
  baths: 2,
  yearBuilt: 2005,
  dom: 10,
  cdom: 10,
  closeDate: '01/15/2021',
  closeYear: 2021,
  closeDateTs: new Date(2021, 0, 15).getTime(),
  lat: 29.76,
  lng: -95.37,
  propertyType: 'Single-Family',
  listingType: 'sale',
  datasetYear: 2021,
  uploadSessionId: 'test-session',
  updatedAt: new Date().toISOString(),
};

(async () => {
  try {
    const res = await dc.executeMutation('stagePropertyRows', { rows: JSON.stringify([testRow]) });
    console.log('Stage success:', JSON.stringify(res.data, null, 2));
    const status = await dc.executeQuery('datasetStatus', {});
    console.log('Status after stage:', JSON.stringify(status.data, null, 2));
  } catch (e) {
    console.error('Stage failed:', e?.message || e);
  }
  process.exit(0);
})();
