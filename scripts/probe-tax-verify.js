process.env.GOOGLE_CLOUD_PROJECT = 'myreatstat';
process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  `${process.env.APPDATA}/gcloud/legacy_credentials/maijelcancines2@gmail.com/adc.json`;
const { initializeApp } = require('firebase-admin/app');
const { getDataConnect } = require('firebase-admin/data-connect');
const app = initializeApp({});
const dc = getDataConnect({ location: 'us-central1', serviceId: 'kwizi-sql', connector: 'default' }, app);
(async () => {
  const vars = {
    saleMin: 0, saleMax: 20000000, sqftMin: 0, sqftMax: 20000,
    yearMin: 0, yearMax: 3000, bedsMin: 0, bedsMax: 100, bathsMin: 0, bathsMax: 100,
    l2sMin: 0, l2sMax: 1000000, domMin: 0, domMax: 1000000,
    lotSizeMin: 0, lotSizeMax: 100000000, ppsfMin: 0, ppsfMax: 100000000,
    rentMin: 0, rentMax: 100000000, startTs: null, endTs: null,
    propertyTypes: [], pool: 'any', schoolDistricts: [], cities: [],
    elementaryExplicit: [], elementaryRating: [], middleExplicit: [], middleRating: [],
    highschoolsExplicit: [], highSchoolRating: [], listingType: 'sale',
  };
  const ov = await dc.executeQuery('overallAggregates', vars);
  console.log('overall:', JSON.stringify(ov.data).slice(0, 800));
})().catch((e) => { console.error('ERR', e.message || e); process.exit(1); });
