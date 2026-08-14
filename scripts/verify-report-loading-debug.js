const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const logs = [];
  page.on('console', (msg) => {
    const text = msg.text();
    logs.push({ type: msg.type(), text });
    console.log(`[console ${msg.type()}]`, text);
  });
  page.on('pageerror', (err) => {
    console.log('[pageerror]', err.message);
    logs.push({ type: 'pageerror', text: err.message });
  });

  const t0 = Date.now();
  await page.goto('http://localhost:3000/map', { waitUntil: 'networkidle', timeout: 60000 });
  console.log('Page loaded', Date.now() - t0, 'ms');

  await page.evaluate(() => localStorage.setItem('kwizi-tour-seen', 'true'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  await page.waitForFunction(() => {
    return document.querySelectorAll('.leaflet-overlay-pane svg path').length > 100;
  }, { timeout: 15000 });
  console.log('Polygons rendered', Date.now() - t0, 'ms');

  const path = page.locator('.leaflet-overlay-pane svg path').first();
  await path.waitFor({ state: 'visible', timeout: 5000 });
  await path.click({ force: true });
  await page.waitForTimeout(800);
  const bodyText = await page.evaluate(() => document.body.innerText);
  console.log('Body snippet after click:', bodyText.split('\n').slice(0, 30).join(' | '));

  const generateBtn = page.locator('[data-tour="generate-report"]');
  await generateBtn.waitFor({ state: 'visible', timeout: 10000 });
  await generateBtn.click();
  console.log('Generate Report clicked', Date.now() - t0, 'ms');

  await page.waitForFunction(() => {
    return document.body.innerText.includes('Generating Report...');
  }, { timeout: 10000 });
  console.log('Generating Report overlay visible', Date.now() - t0, 'ms');

  await page.waitForFunction(() => {
    return !document.body.innerText.includes('Generating Report...');
  }, { timeout: 120000 });
  console.log('Report data loaded', Date.now() - t0, 'ms');

  const summary = await page.locator('text=/properties/i').first().textContent();
  console.log('Summary:', summary);

  await page.waitForTimeout(1000);
  await browser.close();
})();
