import { chromium } from 'playwright';
const OUT='/tmp/claude-0/-home-user-poker-manager/cb7f7cc5-2da8-571c-a12d-e4df18f0763d/scratchpad';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await b.newPage({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true});
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
await page.goto('http://localhost:8080/',{waitUntil:'load'});
await page.evaluate(()=>localStorage.clear());
await page.reload({waitUntil:'load'});
for (const n of ['אבי','בני','גדי']) { await page.fill('#playerNameInput', n); await page.click('#addPlayerForm button[type=submit]'); }

// give בני and גדי a second buy-in so they can cover more than אבי
await page.locator('[data-action="buyin-plus"]').nth(1).click();
await page.locator('[data-action="buyin-plus"]').nth(2).click();
await page.click('.tab[data-view="round"]');
await page.click('[data-action="start-hand"]');
await page.waitForTimeout(250);

// אבי all-in short (50), בני and גדי go to 200 each -> main 150, side 300
const setBet = async (i, v) => { const el = page.locator('input[data-action="bet-set"]').nth(i); await el.fill(String(v)); await page.waitForTimeout(120); };
await setBet(0, 100); await setBet(1, 200); await setBet(2, 200);
await page.waitForTimeout(300);
console.log('pot:', await page.textContent('.pot-box-value'));
const slices = await page.locator('.pot-slice').allTextContents();
console.log('live pot slices:', slices.map(s=>s.replace(/\s+/g,' ').trim()));
await page.screenshot({path:`${OUT}/s1-sidepot-live.png`});

await page.click('[data-action="close-hand"]');
await page.waitForTimeout(300);
const panels = await page.locator('.winner-pick').count();
console.log('winner panels (expect 2):', panels);
const opts = await page.locator('.winner-pick').nth(1).locator('.winner-option').allTextContents();
console.log('side pot eligible (expect בני, גדי):', opts.map(o=>o.replace(/\s+/g,' ').trim()));
console.log('confirm disabled before choosing:', await page.locator('[data-action="confirm-winner"]').isDisabled());
await page.screenshot({path:`${OUT}/s2-winner-pots.png`, fullPage:true});

// short stack wins main; בני wins side
await page.locator('.winner-pick').nth(0).locator('[data-action="toggle-winner"]').first().click();
await page.waitForTimeout(150);
await page.locator('.winner-pick').nth(1).locator('[data-action="toggle-winner"]').first().click();
await page.waitForTimeout(150);
console.log('confirm enabled after both:', !(await page.locator('[data-action="confirm-winner"]').isDisabled()));
await page.click('[data-action="confirm-winner"]');
await page.waitForTimeout(300);

// verify stacks: אבי 100+100=200? he paid 50 won 150 => 100+100=200... buyIn 100 chips
await page.click('[data-action="start-hand"]');
await page.waitForTimeout(250);
const metas = await page.locator('.bet-row .player-meta').allTextContents();
console.log('stacks after:', metas.map(m=>m.replace(/\s+/g,' ').trim()));
await page.click('[data-action="cancel-hand"]').catch(()=>{});
page.on('dialog', d=>d.accept());
await page.waitForTimeout(200);

await page.click('.tab[data-view="count"]');
await page.click('[data-action="fill-from-tracking"]');
await page.waitForTimeout(250);
console.log('count:', (await page.textContent('#countStatus')).replace(/\s+/g,' ').slice(0,120));
console.log(errs.length?'ERRORS: '+errs.join(' | '):'no page errors');
await b.close();
