import { chromium } from 'playwright';
const OUT = '/tmp/claude-0/-home-user-poker-manager/cb7f7cc5-2da8-571c-a12d-e4df18f0763d/scratchpad';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

async function setup(page) {
  await page.goto('http://localhost:8080/', { waitUntil: 'load' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });
  for (const n of ['דנה', 'רועי', 'טל', 'מיכל']) {
    await page.fill('#playerNameInput', n);
    await page.click('#addPlayerForm button[type=submit]');
  }
  await page.click('[data-action="buyin-plus"][data-id]');
  if (await page.locator('.tabbar').isVisible()) await page.click('.tab[data-view="count"]');
  const inputs = page.locator('input[data-action="cash-out"]');
  const n = await inputs.count();
  const vals = ['40', '260', '100', '120'];
  for (let i = 0; i < Math.min(n, 4); i++) await inputs.nth(i).fill(vals[i]);
  await page.waitForTimeout(250);
}

const errors = [];
// phone
let page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
page.on('pageerror', e => errors.push('phone ' + e.message));
await setup(page);
await page.screenshot({ path: `${OUT}/m1-game.png` });
await page.click('.tab[data-view="settle"]');
await page.waitForTimeout(200);
await page.screenshot({ path: `${OUT}/m2-settle.png`, fullPage: true });
await page.close();

// TV
page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', e => errors.push('tv ' + e.message));
await setup(page);
await page.screenshot({ path: `${OUT}/tv.png` });
console.log('tabbar visible on TV:', await page.locator('.tabbar').isVisible());
await page.close();

// laptop
page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await setup(page);
await page.screenshot({ path: `${OUT}/laptop.png` });
await page.close();

console.log(errors.length ? 'ERRORS: ' + errors.join(' | ') : 'no page errors');
await browser.close();
