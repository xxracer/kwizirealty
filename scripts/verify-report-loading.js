const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const t0 = Date.now();
  await page.goto('http://localhost:3000/map', { waitUntil: 'networkidle', timeout: 60000 });
  console.log('Page loaded', Date.now() - t0, 'ms');

  // Skip tour modal if present.
  await page.evaluate(() => localStorage.setItem('kwizi-tour-seen', 'true'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // Wait for polygons to render.
  await page.waitForFunction(() => {
    return document.querySelectorAll('.leaflet-overlay-pane svg path').length > 100;
  }, { timeout: 15000 });
  console.log('Polygons rendered', Date.now() - t0, 'ms');

  // Click the first visible polygon path to select an area.
  const path = page.locator('.leaflet-overlay-pane svg path').first();
  await path.waitFor({ state: 'visible', timeout: 5000 });
  await path.click({ force: true });
  await page.waitForTimeout(800);

  // Click Generate Report button.
  const generateBtn = page.locator('[data-tour="generate-report"]');
  await generateBtn.waitFor({ state: 'visible', timeout: 10000 });
  await generateBtn.click();
  console.log('Generate Report clicked', Date.now() - t0, 'ms');

  // Wait for the generating report overlay to appear.
  await page.waitForFunction(() => {
    return document.body.innerText.includes('Generating Report...');
  }, { timeout: 10000 });
  console.log('Generating Report overlay visible', Date.now() - t0, 'ms');

  // Wait for overlay to disappear (data loaded).
  await page.waitForFunction(() => {
    return !document.body.innerText.includes('Generating Report...');
  }, { timeout: 120000 });
  console.log('Report data loaded', Date.now() - t0, 'ms');

  // Check summary shows properties.
  const summary = await page.locator('text=/properties/i').first().textContent();
  console.log('Summary:', summary);

  await browser.close();
})();
