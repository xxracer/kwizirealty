const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });

  // Skip tour and pre-select 3 report windows
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

  await page.screenshot({ path: 'verify-map.png', fullPage: false });

  // Open selector and check it has no Map Layers
  await page.click('[data-tour="map-windows"]', { force: true });
  await page.waitForTimeout(300);
  const selectorItems = await page.$$eval('button[class*="rounded-xl"]', btns => btns.map(b => b.innerText.replace(/\n/g, ' ')));
  console.log('Selector items:', selectorItems);
  await page.screenshot({ path: 'verify-selector.png', fullPage: false });

  // Select area and generate report
  await page.click('button[title="Box"]');
  await page.waitForTimeout(200);
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

  await page.screenshot({ path: 'verify-report.png', fullPage: true });

  const headings = await page.$$eval('h3', hs => hs.map(h => h.innerText));
  console.log('Headings (should NOT include MAP LAYERS in report):', headings);

  const hasMapLayersInReport = await page.evaluate(() => {
    const reportSection = document.querySelector('[data-tour="report"]');
    if (!reportSection) return false;
    return reportSection.innerText.includes('MAP LAYERS');
  });
  console.log('Map Layers in report section:', hasMapLayersInReport);

  console.log('Console errors:', errors);

  await browser.close();
})();
