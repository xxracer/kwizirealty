/**
 * simplify-boundaries.js
 *
 * Quick win for low-RAM machines: reduce the vertex count of the boundary
 * GeoJSON files (subdivisions, zipcodes, schools, neighborhoods) so Leaflet
 * holds far fewer points per polygon. A 10 MB file can drop to ~1 MB with no
 * visible change at map zoom levels.
 *
 * Reads public/geojson/<key>.geojson.gz, runs @turf/turf simplify on every
 * feature geometry, and writes the result back as <key>.geojson.gz.
 * Feature ids, names and all properties are preserved — only coordinates change.
 *
 * Usage:
 *   node scripts/simplify-boundaries.js                 # default tolerance
 *   node scripts/simplify-boundaries.js --tolerance=0.0008
 *   node scripts/simplify-boundaries.js --dry-run       # report only, no write
 *
 * After running, visually spot-check a couple of polygons on the map, then
 * commit the regenerated files (the user deploys manually).
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { simplify } = require('@turf/turf');

const GEOJSON_DIR = path.join(__dirname, '..', 'public', 'geojson');
const DEFAULT_TOLERANCE = 0.0010; // degrees (~110 m) — ~16% fewer vertices on the
                                  // committed files. Lower (0.0006) for safer corners,
                                  // higher (0.0015) for more savings. Tune per visual check.

const args = process.argv.slice(2);
const tolArg = args.find((a) => a.startsWith('--tolerance='));
const TOLERANCE = tolArg ? Number(tolArg.split('=')[1]) : DEFAULT_TOLERANCE;
const DRY_RUN = args.includes('--dry-run');

function countVertices(geometry) {
  if (!geometry) return 0;
  const rings = geometry.type === 'Polygon'
    ? geometry.coordinates
    : geometry.type === 'MultiPolygon'
      ? geometry.coordinates.flat()
      : [];
  return rings.reduce((sum, ring) => sum + ring.length, 0);
}

function simplifyFeature(feature) {
  if (!feature || !feature.geometry) return { feature, before: 0, after: 0 };
  const before = countVertices(feature.geometry);
  try {
    const simplified = simplify(feature, { tolerance: TOLERANCE, highQuality: true, mutate: false });
    const after = countVertices(simplified.geometry);
    return { feature: simplified, before, after };
  } catch (err) {
    // Some source features are degenerate (rings with <4 points, empty
    // geometry). turf.simplify throws on those — keep the original feature
    // untouched so the boundary file stays valid.
    return { feature, before, after: before };
  }
}

async function main() {
  if (!fs.existsSync(GEOJSON_DIR)) {
    console.error(`✗ ${GEOJSON_DIR} not found. Run download-boundaries.js first.`);
    process.exit(1);
  }

  const files = fs.readdirSync(GEOJSON_DIR).filter((f) => f.endsWith('.geojson.gz'));
  if (files.length === 0) {
    console.error(`✗ No .geojson.gz files in ${GEOJSON_DIR}`);
    process.exit(1);
  }

  let totalBefore = 0;
  let totalAfter = 0;
  let totalBytesBefore = 0;
  let totalBytesAfter = 0;

  for (const file of files) {
    const gzPath = path.join(GEOJSON_DIR, file);
    const raw = zlib.gunzipSync(fs.readFileSync(gzPath));
    const bytesBefore = raw.length;
    let fc;
    try {
      fc = JSON.parse(raw.toString('utf8'));
    } catch (err) {
      console.error(`✗ ${file}: invalid JSON (${err.message}) — skipped`);
      continue;
    }
    if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
      console.error(`✗ ${file}: not a FeatureCollection — skipped`);
      continue;
    }

    let fileBefore = 0;
    let fileAfter = 0;
    const out = { ...fc, features: fc.features.map((f) => {
      const { feature, before, after } = simplifyFeature(f);
      fileBefore += before;
      fileAfter += after;
      return feature;
    }) };

    const outRaw = Buffer.from(JSON.stringify(out), 'utf8');
    const outGz = zlib.gzipSync(outRaw, { level: 9 });

    totalBefore += fileBefore;
    totalAfter += fileAfter;
    totalBytesBefore += bytesBefore;
    totalBytesAfter += outRaw.length;

    const pct = fileBefore > 0 ? ((1 - fileAfter / fileBefore) * 100).toFixed(1) : '0.0';
    const mb = (n) => (n / 1024 / 1024).toFixed(2);
    console.log(
      `${DRY_RUN ? '·' : '✓'} ${file}: ${fileBefore.toLocaleString()} → ${fileAfter.toLocaleString()} vertices ` +
      `(-${pct}%), ${mb(bytesBefore)} → ${mb(outRaw.length)} MB`
    );

    if (!DRY_RUN) {
      fs.writeFileSync(gzPath, outGz);
    }
  }

  const pct = totalBefore > 0 ? ((1 - totalAfter / totalBefore) * 100).toFixed(1) : '0.0';
  console.log(`\nTotal: ${totalBefore.toLocaleString()} → ${totalAfter.toLocaleString()} vertices (-${pct}%)`);
  if (DRY_RUN) {
    console.log('Dry run — nothing written. Re-run without --dry-run to apply.');
  } else {
    console.log('Done. Spot-check a few polygons on the map, then commit the files.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
