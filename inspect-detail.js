const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');

const base = path.join(process.cwd(), 'public', 'csv');

function readCsvSample(p, n = 3) {
  const text = fs.readFileSync(p, 'utf8');
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
  const headers = parsed.meta.fields;
  const rows = parsed.data.slice(0, n);
  return { headers, rows, total: parsed.data.length };
}

function readGeoJsonSample(p) {
  const text = fs.readFileSync(p, 'utf8');
  const gj = JSON.parse(text);
  const fc = gj.type === 'FeatureCollection' ? gj : { features: [gj] };
  const first = fc.features[0];
  const count = fc.features.length;
  return {
    type: fc.type,
    featureCount: count,
    geometryType: first?.geometry?.type,
    propertyKeys: first ? Object.keys(first.properties || {}) : [],
    sampleProperties: first?.properties,
  };
}

const geojsons = [
  'Elementary School ISD.geojson',
  'Houston_ISD.geojson',
  'Mapped Subdivisions.geojson',
  'Middle School ISD.geojson',
  'Zip.geojson',
];

console.log('=== GEOJSON SAMPLES ===');
for (const f of geojsons) {
  const p = path.join(base, f);
  if (!fs.existsSync(p)) { console.log(`Missing: ${f}`); continue; }
  const s = readGeoJsonSample(p);
  console.log(`\n${f} (${s.featureCount} features)`);
  console.log('  geometry:', s.geometryType);
  console.log('  property keys:', s.propertyKeys.join(', '));
  console.log('  sample properties:', JSON.stringify(s.sampleProperties).slice(0, 300));
}

const csvSamples = [
  '34_x_40_displayGrid_nonresponsive_ajax_display_dU35329m_show.csv',
  '94_x_40_displayGrid_nonresponsive_ajax_display_dU35329m_show.csv',
  'TEA_Elem_School_Ratings.csv',
  'TEA_High_School_Ratings.csv',
  'TEA_Middle_School_Ratings.csv',
  'Sales Data-20260801T175930Z-1-001\\Sales Data\\Current for Sale Data\\3_x_40_displayGrid_nonresponsive_ajax_display_dU35329m_show.csv',
  'Sales Data-20260801T175930Z-1-001\\Sales Data\\Current for Rent Data\\22_x_40_displayGrid_nonresponsive_ajax_display_dU35329m_show.csv',
  'Sales Data-20260801T175930Z-1-001\\Sales Data\\Sale Data\\Sale 2021\\12_x_40_displayGrid_nonresponsive_ajax_display_dU35329m_show.csv',
  'Sales Data-20260801T175930Z-1-001\\Sales Data\\Rent Data\\Rent 2021\\100_x_40_displayGrid_nonresponsive_ajax_display_dU35329m_show.csv',
  'Sales Data-20260801T175930Z-1-001\\Sales Data\\Rent Data\\Rent 2023\\data1.csv',
];

console.log('\n\n=== CSV SAMPLES ===');
for (const f of csvSamples) {
  const p = path.join(base, f);
  if (!fs.existsSync(p)) { console.log(`Missing: ${f}`); continue; }
  const s = readCsvSample(p);
  console.log(`\n${f} (${s.total} rows)`);
  console.log('  headers:', s.headers.join(', '));
  console.log('  rows:', JSON.stringify(s.rows, null, 2).slice(0, 800));
}
