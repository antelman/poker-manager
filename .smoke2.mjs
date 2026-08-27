import { chromium } from 'playwright';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto('http://localhost:8080/', { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });

for (const name of ['אבי', 'בני', 'גדי']) {
  await page.fill('#playerNameInput', name);
  await page.click('#addPlayerForm button[type=submit]');
}

await page.click('.tab[data-view="count"]');
const inputs = page.locator('input[data-action="cash-out"]');
await inputs.nth(0).fill('100');
await inputs.nth(1).fill('100');
await inputs.nth(2).fill('90');
await page.waitForTimeout(150);

// Apply the even split while all three are counted.
await page.click('[data-action="adjust-even"]');
await page.waitForTimeout(150);
console.log('A) all counted + adjusted:', (await page.textContent('#countStatus')).replace(/\s+/g, ' ').trim());

// Now clear one count - the adjustment must stop being applied.
await inputs.nth(2).fill('');
await page.waitForTimeout(150);
console.log('B) one cleared:', (await page.textContent('#countStatus')).replace(/\s+/g, ' ').trim());

await page.click('.tab[data-view="settle"]');
await page.waitForTimeout(150);
const rows = await page.locator('.result-row').allTextContents();
console.log('C) partial results:', rows.map((r) => r.replace(/\s+/g, ' ').trim()));

// Re-enter the count; the adjustment should apply again.
await page.click('.tab[data-view="count"]');
await page.locator('input[data-action="cash-out"]').nth(2).fill('90');
await page.waitForTimeout(150);
console.log('D) recounted:', (await page.textContent('#countStatus')).replace(/\s+/g, ' ').trim());

// Finish the game and confirm it lands in history.
page.on('dialog', (d) => d.accept());
await page.click('.tab[data-view="settle"]');
await page.waitForTimeout(150);
await page.click('[data-action="finish-game"]');
await page.waitForTimeout(300);
console.log('E) history entries:', await page.locator('.history-item').count());
console.log('E) history text:', (await page.locator('.history-item').first().textContent()).replace(/\s+/g, ' ').trim());
console.log('E) pot reset to:', await page.textContent('#potValue'));

// Settings must carry over to the new game.
await page.click('.tab[data-view="game"]');
console.log('F) settings preview:', await page.textContent('#settingsPreview'));

console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no console errors');
await browser.close();
