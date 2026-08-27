import { chromium } from 'playwright';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

for (const target of ['file:///home/user/poker-manager/dist/poker.html', 'http://localhost:8080/']) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(target, { waitUntil: 'load' });
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'load' });

  for (const name of ['אורי', 'מיכל']) {
    await page.fill('#playerNameInput', name);
    await page.click('#addPlayerForm button[type=submit]');
  }
  await page.click('.tab[data-view="count"]');
  const inputs = page.locator('input[data-action="cash-out"]');
  await inputs.nth(0).fill('160');
  await inputs.nth(1).fill('40');
  await page.waitForTimeout(150);
  await page.click('.tab[data-view="settle"]');
  await page.waitForTimeout(150);

  const t = await page.locator('.transfer').allTextContents();
  const dir = await page.evaluate(() => document.documentElement.dir);
  console.log(`${target}\n  dir=${dir} pot=${await page.textContent('#potValue')} transfers=${JSON.stringify(t.map((x) => x.replace(/\s+/g, ' ').trim()))}`);
  console.log('  ' + (errors.length ? 'ERRORS: ' + errors.join(' | ') : 'no console errors'));
  await page.close();
}

await browser.close();
