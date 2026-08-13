const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });

  await context.addInitScript(() => {
    window.localStorage.setItem('kwizi-tour-seen', 'true');
    window.localStorage.setItem('kwizi-map-windows', JSON.stringify(['quick-stats', 'market-health']));
  });

  const page = await context.newPage();

  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', err => errors.push(err.message));

  await page.goto('http://localhost:3000/map', { waitUntil: 'networkidle' });
  await page.waitForTimeout(6000);

  const mapBefore = await page.evaluate(() => {
    const mapPane = document.querySelector('.leaflet-map-pane');
    if (!mapPane) return null;
    const style = window.getComputedStyle(mapPane);
    return { transform: style.transform };
  });

  const windowBefore = await page.$eval('.absolute.pointer-events-auto.rounded-2xl', el => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y };
  });

  // Drag the first floating window
  await page.hover('.absolute.pointer-events-auto.rounded-2xl');
  await page.mouse.down();
  await page.mouse.move(windowBefore.x + 300, windowBefore.y + 200, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(500);

  const windowAfter = await page.$eval('.absolute.pointer-events-auto.rounded-2xl', el => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y };
  });

  const mapAfterDrag = await page.evaluate(() => {
    const mapPane = document.querySelector('.leaflet-map-pane');
    if (!mapPane) return null;
    const style = window.getComputedStyle(mapPane);
    return { transform: style.transform };
  });

  console.log('Window before:', windowBefore);
  console.log('Window after:', windowAfter);
  console.log('Window moved:', Math.abs(windowAfter.x - windowBefore.x) > 50 || Math.abs(windowAfter.y - windowBefore.y) > 50);
  console.log('Map before drag:', mapBefore);
  console.log('Map after drag:', mapAfterDrag);
  console.log('Map unchanged during drag:', mapBefore?.transform === mapAfterDrag?.transform);

  await page.screenshot({ path: 'verify-drag.png', fullPage: false });

  // Test wheel over window
  await page.mouse.move(windowAfter.x + 50, windowAfter.y + 50);
  await page.mouse.wheel(0, 500);
  await page.waitForTimeout(500);

  const mapAfterWheel = await page.evaluate(() => {
    const mapPane = document.querySelector('.leaflet-map-pane');
    if (!mapPane) return null;
    const style = window.getComputedStyle(mapPane);
    return { transform: style.transform };
  });
  console.log('Map after wheel over window:', mapAfterWheel);
  console.log('Map unchanged after wheel:', mapAfterDrag?.transform === mapAfterWheel?.transform);

  console.log('Console errors:', errors);

  await browser.close();
})();
