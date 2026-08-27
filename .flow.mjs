import { chromium } from 'playwright';
const OUT='/tmp/claude-0/-home-user-poker-manager/cb7f7cc5-2da8-571c-a12d-e4df18f0763d/scratchpad';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await b.newPage({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true});
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
await page.goto('http://localhost:8080/',{waitUntil:'load'});
await page.evaluate(()=>localStorage.clear());
await page.reload({waitUntil:'load'});
for (const n of ['דנה','רועי','טל']) { await page.fill('#playerNameInput', n); await page.click('#addPlayerForm button[type=submit]'); }

await page.click('.tab[data-view="round"]');
await page.click('[data-action="start-hand"]');
await page.waitForTimeout(250);
console.log('pot after auto blinds (expect 3):', await page.textContent('.pot-box-value'));
const metas = await page.locator('.bet-row .player-meta').allTextContents();
console.log('rows:', metas.map(m=>m.replace(/\s+/g,' ')));

// דנה calls the big blind
await page.locator('[data-action="call"]').first().click();
await page.waitForTimeout(200);
console.log('pot after call (expect 5):', await page.textContent('.pot-box-value'));

// טל folds
await page.locator('[data-action="fold"]').last().click();
await page.waitForTimeout(200);
console.log('folded rows:', await page.locator('.bet-row.is-folded').count());
await page.screenshot({path:`${OUT}/f1-bets.png`, fullPage:true});

// flop: one picker open, suit then 3 ranks, auto-advancing
await page.click('.board-card[data-slot="0"]');
await page.waitForTimeout(150);
await page.click('[data-action="choose-suit"][data-suit="h"]');
await page.waitForTimeout(150);
await page.screenshot({path:`${OUT}/f2-picker.png`});
await page.click('[data-action="choose-rank"][data-rank="A"]');
await page.waitForTimeout(200);
console.log('picker still open after 1st card (auto-advance):', await page.locator('.card-picker').count() > 0);
await page.click('[data-action="choose-rank"][data-rank="K"]');
await page.waitForTimeout(200);
await page.click('[data-action="choose-rank"][data-rank="7"]');
await page.waitForTimeout(250);
console.log('cards on felt:', await page.locator('.board-card.filled').count());
console.log('street auto-set:', (await page.textContent('.felt-street')).trim());
console.log('picker closed after flop:', await page.locator('.card-picker').count() === 0);
await page.screenshot({path:`${OUT}/f3-flop.png`});

// close hand -> tap winner
await page.click('[data-action="close-hand"]');
await page.waitForTimeout(250);
console.log('winner panels:', await page.locator('.winner-pick').count());
console.log('winner options total:', await page.locator('.winner-option').count());
await page.screenshot({path:`${OUT}/f4-winner.png`});
// pick a winner in every panel that still needs one
const panels = await page.locator('.winner-pick').count();
for (let i = 0; i < panels; i++) {
  const p = page.locator('.winner-pick').nth(i);
  if (await p.locator('.winner-option.is-chosen').count() === 0) {
    await p.locator('[data-action="toggle-winner"]').first().click();
    await page.waitForTimeout(120);
  }
}
await page.click('[data-action="confirm-winner"]');
await page.waitForTimeout(300);
console.log('hand closed:', await page.locator('[data-action="start-hand"]').count() > 0);

// chips conserved
await page.click('.tab[data-view="count"]');
await page.click('[data-action="fill-from-tracking"]');
await page.waitForTimeout(250);
console.log('count:', (await page.textContent('#countStatus')).replace(/\s+/g,' ').slice(0,110));
console.log(errs.length?'ERRORS: '+errs.join(' | '):'no page errors');
await b.close();
