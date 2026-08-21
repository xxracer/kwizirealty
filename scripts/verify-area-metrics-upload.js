/* eslint-disable @typescript-eslint/no-require-imports */
// Verifies the Area Metrics upload flow: drop zone accepts GeoJSON+CSV, the
// staging card surfaces the diff stats (total / new / already-exists) and the
// two action buttons ("Add N new" + "Replace all (M)") render for the areas
// section. We do NOT actually upload; this is purely the staging/diff UI.

const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

function makeGeoJson(name, lat, lng, props = {}) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lng, lat] },
    properties: { name, ...props },
  };
}

async function readTmpFile(page, selector) {
  return page.$eval(selector, (el) => el.files?.[0]?.name || null).catch(() => null);
}

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kwizi-area-'));

  // Two GeoJSON files: one brand-new area, one overlapping name.
  const geo1Path = path.join(tmpDir, 'custom-areas-new.geojson');
  fs.writeFileSync(
    geo1Path,
    JSON.stringify({
      type: 'FeatureCollection',
      features: [
        makeGeoJson('Memorial Area', 29.78, -95.55, { pop: 12345 }),
        makeGeoJson('Rice Village', 29.71, -95.41),
      ],
    })
  );

  // CSV with name + lat + lng columns. The current code converts this in the
  // browser — we just want to confirm the staging branch accepts .csv.
  const csv1Path = path.join(tmpDir, 'custom-areas-mix.csv');
  fs.writeFileSync(
    csv1Path,
    'name,lat,lng,notes\nTest Subdivision,29.760,-95.370,via-csv\nLone Star,29.420,-95.080,\n'
  );

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();

  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  console.log('1) Loading /admin…');
  await page.goto('http://localhost:3000/admin', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('text=Upload', { timeout: 60_000 });

  // Click on the Area Metrics section so its drop zone is on screen.
  console.log('2) Locating Area Metrics upload card…');
  // Open the Area Metrics sidebar entry if the design uses accordions.
  const areaMetricsTab = await page.locator('text=Area Metrics').first();
  if (await areaMetricsTab.count()) {
    await areaMetricsTab.click().catch(() => {});
  }

  // The file input is hidden; trigger it by looking for the active dropzone.
  // We rely on the rendering that "Upload Area Metrics" appears above the file input.
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.waitFor({ state: 'attached', timeout: 30_000 });

  console.log('3) Uploading GeoJSON…');
  await fileInput.setInputFiles(geo1Path);

  // The staging card surfaces Total Areas / New Areas / Already Exists counts.
  console.log('4) Waiting for staging card…');
  await page.waitForSelector('text=Staging Area', { timeout: 30_000 });
  await page.waitForSelector('text=Total Areas', { timeout: 30_000 });
  await page.waitForSelector('text=Add ', { timeout: 30_000 });
  await page.waitForSelector('text=Replace all', { timeout: 30_000 });

  // Capture the rendered counts.
  const counts = await page.evaluate(() => {
    const grab = (label) => {
      const el = [...document.querySelectorAll('div')].find(
        (n) => n.textContent && n.textContent.trim().toLowerCase().startsWith(label.toLowerCase())
      );
      if (!el) return null;
      const numEl = el.parentElement?.querySelector('div.text-xs, div.text-sm');
      return numEl?.textContent?.trim() || null;
    };
    return {
      total: grab('Total Areas'),
      new: grab('New Areas'),
      exists: grab('Already Exists'),
    };
  });
  console.log('GeoJSON staging counts:', counts);

  console.log('5) Uploading CSV…');
  const fileInputs = page.locator('input[type="file"]');
  const newInput = fileInputs.nth(0); // still the same one for the active section
  // Discard the previous staged card so we can stage the CSV.
  const discardBtn = page.locator('button:has-text("Discard")').first();
  if (await discardBtn.count()) await discardBtn.click().catch(() => {});
  await page.waitForTimeout(300);
  await newInput.setInputFiles(csv1Path);

  await page.waitForSelector('text=Total Areas', { timeout: 30_000 });
  const csvCounts = await page.evaluate(() => {
    const grab = (label) => {
      const el = [...document.querySelectorAll('div')].find(
        (n) => n.textContent && n.textContent.trim().toLowerCase().startsWith(label.toLowerCase())
      );
      if (!el) return null;
      const numEl = el.parentElement?.querySelector('div.text-xs, div.text-sm');
      return numEl?.textContent?.trim() || null;
    };
    return {
      total: grab('Total Areas'),
      new: grab('New Areas'),
      exists: grab('Already Exists'),
    };
  });
  console.log('CSV staging counts:', csvCounts);

  // The diff details disclosure should appear once we have any names/skipped.
  const hasDiffDetails = await page.locator('text=View diff details').count();
  console.log('Diff details disclosure present:', hasDiffDetails > 0);

  console.log('Console errors:', errors);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  await browser.close();

  const fail =
    errors.length > 0 ||
    !counts.total ||
    !counts.new ||
    !csvCounts.total ||
    !csvCounts.new ||
    !hasDiffDetails;
  console.log(fail ? 'VERIFY FAILED' : 'VERIFY OK');
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('verify-area-metrics-upload error:', err);
  process.exit(1);
});
