const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });

  await context.addInitScript(() => {
    window.localStorage.setItem('kwizi-tour-seen', 'true');
  });

  const page = await context.newPage();

  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', err => errors.push(err.message));

  // First load: measure time and progress
  const start1 = Date.now();
  await page.goto('http://localhost:3000/map', { waitUntil: 'networkidle' });

  // Wait until counts appear (not loading)
  await page.waitForFunction(() => {
    const text = document.body.innerText;
    return /\d+\s+properties/.test(text) && !/Loading CSV/.test(text);
  }, { timeout: 120000 });
  const firstLoad = Date.now() - start1;

  // Get final count
  const count1 = await page.evaluate(() => {
    const m = document.body.innerText.match(/([\d,]+)\s+properties/);
    return m ? m[1] : 'not found';
  });

  console.log(`First load: ${firstLoad}ms, properties: ${count1}`);

  // Reload: should use cache
  await page.reload({ waitUntil: 'networkidle' });
  const start2 = Date.now();
  await page.waitForFunction(() => {
    const text = document.body.innerText;
    return /\d+\s+properties/.test(text) && !/Loading CSV/.test(text);
  }, { timeout: 120000 });
  const secondLoad = Date.now() - start2;

  const count2 = await page.evaluate(() => {
    const m = document.body.innerText.match(/([\d,]+)\s+properties/);
    return m ? m[1] : 'not found';
  });

  console.log(`Second load (cached): ${secondLoad}ms, properties: ${count2}`);
  console.log('Console errors:', errors);

  await browser.close();
})();
