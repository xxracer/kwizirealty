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
  try {
    await page.waitForFunction(
      () => !document.body.innerText.includes('Loading Boundary Data'),
      { timeout: 30000 }
    );
    console.log('Boundary overlay hidden', Date.now() - start, 'ms');
  } catch {}

  try {
    await page.waitForFunction(
      () => !/Loading CSV/i.test(document.body.innerText),
      { timeout: 120000 }
    );
    console.log('Full CSV loaded', Date.now() - start, 'ms');
  } catch {
    console.log('Full CSV still loading after 120s');
  }

  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 300));
  console.log('Body:', bodyText.replace(/\n/g, ' | '));
  console.log('Logs:');
  logs.forEach((l) => console.log(l));
  await browser.close();
})();
