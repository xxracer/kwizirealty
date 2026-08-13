const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });

  // Mark tour as seen so it doesn't block interactions
  await context.addInitScript(() => {
    window.localStorage.setItem('kwizi-tour-seen', 'true');
  });

  const page = await context.newPage();

  // Capture console errors
  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', err => errors.push(err.message));

  await page.goto('http://localhost:3000/map', { waitUntil: 'networkidle' });
  await page.waitForTimeout(6000);

  // Screenshot initial state
  await page.screenshot({ path: 'verify-map.png', fullPage: false });

  // Add Time Series via selector (force click in case something overlaps)
  await page.click('[data-tour="map-windows"]', { force: true });
  await page.waitForTimeout(300);
  const timeSeriesBtn = await page.$('button:has-text("Time Series")');
  if (timeSeriesBtn) {
    await timeSeriesBtn.click({ force: true });
    await page.waitForTimeout(600);
  }

  // Screenshot with 3 active
  await page.screenshot({ path: 'verify-map-3.png', fullPage: false });

  // Read floating windows
  const windows = await page.$$eval('.absolute.pointer-events-auto.rounded-2xl', els =>
    els.map(el => {
      const r = el.getBoundingClientRect();
      return { text: el.innerText.slice(0, 80).replace(/\n/g, ' | '), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    })
  );

  // Read card headings
  const headings = await page.$$eval('h3', hs => hs.map(h => h.innerText));

  // Read selector active count
  const activeCount = await page.$eval('.text-\[10px\].text-gray-500', el => el.innerText).catch(() => 'not found');

  console.log('Headings:', headings);
  console.log('Floating windows:', windows);
  console.log('Active count label:', activeCount);
  console.log('Console errors:', errors);

  await browser.close();
})();
