const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });

  await context.addInitScript(() => {
    window.localStorage.setItem('kwizi-tour-seen', 'true');
    window.localStorage.setItem('kwizi-map-windows', JSON.stringify([]));
  });

  const page = await context.newPage();

  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', err => errors.push(err.message));

  await page.goto('http://localhost:3000/map', { waitUntil: 'networkidle' });
  await page.waitForTimeout(5000);

  // After reload, no floating windows should be visible
  const windowsBefore = await page.$$eval('.absolute.pointer-events-auto.rounded-2xl', els => els.length);
  console.log('Windows visible before report (should be 0):', windowsBefore);

  await page.screenshot({ path: 'verify-initial.png', fullPage: false });

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

  const windowsAfterGenerate = await page.$$eval('.absolute.pointer-events-auto.rounded-2xl', els =>
    els.map(el => el.innerText.slice(0, 40).replace(/\n/g, ' | '))
  );
  console.log('Windows after Generate Report:', windowsAfterGenerate);

  // Check button text in report
  const pinBtns = await page.$$eval('button[class*="bg-white/5"], button[class*="bg-blue-500/20"]', btns =>
    btns.filter(b => b.innerText.includes('map')).map(b => ({ text: b.innerText, title: b.title }))
  );
  console.log('Pin button texts:', pinBtns);

  await page.screenshot({ path: 'verify-after-generate.png', fullPage: false });

  // Reload and verify windows hidden again
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(5000);
  const windowsAfterReload = await page.$$eval('.absolute.pointer-events-auto.rounded-2xl', els => els.length);
  console.log('Windows visible after reload (should be 0):', windowsAfterReload);

  await page.screenshot({ path: 'verify-after-reload.png', fullPage: false });

  console.log('Console errors:', errors);

  await browser.close();
})();
