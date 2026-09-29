/**
 * One-time repair: the tax CSVs uploaded so far (~103k rows) live in the
 * listing_type='tax' bucket, which no deployed read op serves — so the tax
 * report and the 'Last Year Tax Rate' map metric showed nothing.
 *
 * mergeTaxIntoSaleRows copies each property's latest tax record onto its sale
 * rows (fills empty fields; a newer tax year upgrades an older one; nothing is
 * ever deleted). Run AFTER deploying the connector that defines the op:
 *
 *   node scripts/merge-tax-into-sales.js
 *
 * Verifies with overallAggregates (sale bucket): tax_count > 0 afterwards.
 */
process.env.GOOGLE_CLOUD_PROJECT = 'myreatstat';
process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  `${process.env.APPDATA}\\gcloud\\legacy_credentials\\maijelcancines2@gmail.com\\adc.json`;

const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getDataConnect } = require('firebase-admin/data-connect');

const app = initializeApp({});
const dc = getDataConnect({ location: 'us-central1', serviceId: 'kwizi-sql', connector: 'default' }, app);
const db = getFirestore(app);

/** Default filter frame, identical to buildVariables() in /api/query. */
function saleVariables() {
  return {
    saleMin: 0, saleMax: 20000000,
    sqftMin: 0, sqftMax: 20000,
    yearMin: 0, yearMax: 3000,
    bedsMin: 0, bedsMax: 100,
    bathsMin: 0, bathsMax: 100,
    l2sMin: 0, l2sMax: 1000000,
    domMin: 0, domMax: 1000000,
    lotSizeMin: 0, lotSizeMax: 100000000,
    ppsfMin: 0, ppsfMax: 100000000,
    rentMin: 0, rentMax: 100000000,
    startTs: null, endTs: null,
    propertyTypes: [], pool: 'any',
    schoolDistricts: [], cities: [],
    elementaryExplicit: [], elementaryRating: [],
    middleExplicit: [], middleRating: [],
    highschoolsExplicit: [], highSchoolRating: [],
    listingType: 'sale',
  };
}

async function taxAggregates() {
  const res = await dc.executeQuery('overallAggregates', saleVariables());
  const t = res.data?.totals || {};
  return {
    saleRows: t.n ?? 0,
    avgTaxAmount: Number(t.avg_tax_amount ?? 0),
    avgTaxRate: Number(t.avg_tax_rate ?? 0),
    taxCount: t.tax_count ?? 0,
  };
}

(async () => {
  const before = await taxAggregates();
  console.log('BEFORE merge:', JSON.stringify(before));

  await dc.executeMutation('mergeTaxIntoSaleRows', {});
  console.log('mergeTaxIntoSaleRows executed.');

  const after = await taxAggregates();
  console.log('AFTER merge:', JSON.stringify(after));

  if (after.taxCount > 0) {
    // Publish the new version so every browser refetches the merged data.
    const status = await dc.executeQuery('datasetStatus', {});
    await db.collection('cms_meta').doc('sql_sync').set(
      {
        version: Date.now(),
        done: true,
        directImport: true,
        totalRows: status.data.status.committed,
        updatedAt: FieldValue.serverTimestamp(),
        importedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    console.log(`Published version with ${status.data.status.committed} rows.`);
  } else {
    console.log('No tax data merged — is the connector deployed?');
  }
  process.exit(0);
})().catch((e) => {
  console.error('ERR', e.message || e);
  process.exit(1);
});