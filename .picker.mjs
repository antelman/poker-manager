import { chromium } from 'playwright';
const OUT='/tmp/claude-0/-home-user-poker-manager/cb7f7cc5-2da8-571c-a12d-e4df18f0763d/scratchpad';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await b.newPage({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true});
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
await page.goto('http://localhost:8080/',{waitUntil:'load'});
await page.evaluate(()=>localStorage.clear());
await page.reload({waitUntil:'load'});

// hidden fix: sync body must start closed
console.log('sync body visible on load (should be false):', await page.locator('#syncBody').isVisible());

for (const n of ['דנה','רועי','טל']) { await page.fill('#playerNameInput', n); await page.click('#addPlayerForm button[type=submit]'); }
await page.click('.tab[data-view="round"]');
await page.click('[data-action="start-hand"]');
await page.waitForTimeout(200);
await page.click('.board-card[data-slot="0"]');
await page.waitForTimeout(200);
await page.screenshot({path:`${OUT}/p1-picker.png`});

// rank then suit
await page.click('[data-action="choose-rank"][data-rank="A"]');
await page.waitForTimeout(150);
await page.click('[data-action="choose-suit"][data-suit="s"]');
await page.waitForTimeout(250);
console.log('picker closed after both:', !(await page.locator('.card-picker').count()));
console.log('card 0:', await page.locator('.board-card[data-slot="0"]').textContent());

// suit first, then rank
await page.click('.board-card[data-slot="1"]');
await page.click('[data-action="choose-suit"][data-suit="h"]');
await page.waitForTimeout(150);
await page.click('[data-action="choose-rank"][data-rank="10"]');
await page.waitForTimeout(250);
console.log('card 1 (suit-first):', await page.locator('.board-card[data-slot="1"]').textContent());

// duplicate card moves rather than duplicating
await page.click('.board-card[data-slot="2"]');
await page.click('[data-action="choose-rank"][data-rank="A"]');
await page.click('[data-action="choose-suit"][data-suit="s"]');
await page.waitForTimeout(250);
console.log('after duplicate As -> slot0:', JSON.stringify(await page.locator('.board-card[data-slot="0"]').textContent()), 'slot2:', await page.locator('.board-card[data-slot="2"]').textContent());

await page.click('[data-action="set-street"][data-street="flop"]');
await page.waitForTimeout(200);
await page.screenshot({path:`${OUT}/p2-board.png`});

// overflow check with picker open
await page.click('.board-card[data-slot="3"]');
await page.waitForTimeout(250);
const o = await page.evaluate(()=>({doc:document.documentElement.scrollWidth, vw:document.documentElement.clientWidth}));
console.log('overflow with picker open:', JSON.stringify(o));
await page.screenshot({path:`${OUT}/p3-picker-open.png`});
console.log(errs.length?'ERRORS: '+errs.join(' | '):'no page errors');
await b.close();
