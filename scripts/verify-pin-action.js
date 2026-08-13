const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });

  // Skip tour and have only 1 floating window so we can pin others
  await context.addInitScript(() => {
    window.localStorage.setItem('kwizi-tour-seen', 'true');
    window.localStorage.setItem('kwizi-map-windows', JSON.stringify(['quick-stats']));
  });

  const page = await context.newPage();

  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', err => errors.push(err.message));

  await page.goto('http://localhost:3000/map', { waitUntil: 'networkidle' });
  await page.waitForTimeout(6000);

  // Select area and generate report
  await page.click('button[title="Box"]');
  await page.waitForTimeout(300);
  const mapBounds = await page.$eval('[data-tour="map"]', el => {
    const r = el.getBoundingClientRect();
    return { x1: r.left + r.width * 0.4, y1: r.top + r.height * 0.4, x2: r.left + r.width * 0.6, y2: r.top + r.height * 0.6 };
  });
  await page.mouse.move(mapBounds.x1, mapBounds.y1);
  await page.mouse.down();
  await page.mouse.move(mapBounds.x2, mapBounds.y2);
  await page.mouse.up();
  await page.waitForTimeout(1000);
  await page.click('button:has-text("Generate Report")');
  await page.waitForTimeout(1500);

  // Click the first "Pin to map" button (should be Market Health, the first unpinned card)
  const pinBtn = await page.$('button[title="Pin to map"]');
  if (pinBtn) {
    await pinBtn.click();
    await page.waitForTimeout(800);
  }

  await page.screenshot({ path: 'verify-after-pin.png', fullPage: false });

  const windows = await page.$$eval('.absolute.pointer-events-auto.rounded-2xl', els =>
    els.map(el => {
      const r = el.getBoundingClientRect();
      return { text: el.innerText.slice(0, 40).replace(/\n/g, ' | '), x: Math.round(r.x), y: Math.round(r.y) };
    })
  );
  const saved = await page.evaluate(() => JSON.parse(window.localStorage.getItem('kwizi-map-windows') || '[]'));

  console.log('Floating windows after pin:', windows);
  console.log('Saved windows:', saved);
  console.log('Console errors:', errors);

  await browser.close();
})();
