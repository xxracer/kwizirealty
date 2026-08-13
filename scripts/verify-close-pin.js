const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });

  // Skip tour and pre-select 3 floating windows
  await context.addInitScript(() => {
    window.localStorage.setItem('kwizi-tour-seen', 'true');
    window.localStorage.setItem('kwizi-map-windows', JSON.stringify(['quick-stats', 'market-health', 'time-series']));
  });

  const page = await context.newPage();

  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', err => errors.push(err.message));

  await page.goto('http://localhost:3000/map', { waitUntil: 'networkidle' });
  await page.waitForTimeout(6000);

  // Close Quick Stats via its close button (title="Close window")
  const closeBtns = await page.$$('button[title="Close window"]');
  console.log('Close buttons found:', closeBtns.length);
  if (closeBtns.length > 0) {
    await closeBtns[0].click();
    await page.waitForTimeout(800);
  }

  await page.screenshot({ path: 'verify-after-close.png', fullPage: false });

  const windows = await page.$$eval('.absolute.pointer-events-auto.rounded-2xl', els =>
    els.map(el => {
      const r = el.getBoundingClientRect();
      return { text: el.innerText.slice(0, 40).replace(/\n/g, ' | '), x: Math.round(r.x), y: Math.round(r.y) };
    })
  );

  const saved = await page.evaluate(() => JSON.parse(window.localStorage.getItem('kwizi-map-windows') || '[]'));
  console.log('Windows after close:', windows);
  console.log('Saved windows:', saved);
  console.log('Console errors:', errors);

  await browser.close();
})();
