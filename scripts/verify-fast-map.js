const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  await context.addInitScript(() => {
    window.localStorage.setItem('kwizi-tour-seen', 'true');
  });
  const page = await context.newPage();
  const logs = [];
  page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));

  const start = Date.now();
  await page.goto('http://localhost:3000/map', { waitUntil: 'load' });
  console.log('HTML loaded', Date.now() - start, 'ms');

  await page.waitForSelector('.leaflet-container', { timeout: 15000 });
  console.log('Leaflet ready', Date.now() - start, 'ms');

  try {
    await page.waitForFunction(
      () => !document.body.innerText.includes('Loading Boundary Data'),
      { timeout: 30000 }
    );
    console.log('Boundary overlay hidden', Date.now() - start, 'ms');
  } catch (e) {
    console.log('Overlay still visible after 30s');
  }

  await page.waitForTimeout(500);
  const pathCount = await page.evaluate(() => {
    const pane = document.querySelector('.leaflet-overlay-pane');
    return pane ? pane.querySelectorAll('path').length : 0;
  });
  console.log('Polygon paths:', pathCount);

  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500));
  console.log('Body snippet:', bodyText.replace(/\n/g, ' | '));

  await page.screenshot({ path: 'verify-fast-map.png', fullPage: false });
  console.log('\nLogs:');
  logs.forEach((l) => console.log(l));
  await browser.close();
})();
