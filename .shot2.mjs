import { chromium } from 'playwright';
const OUT='/tmp/claude-0/-home-user-poker-manager/cb7f7cc5-2da8-571c-a12d-e4df18f0763d/scratchpad';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors=[];

async function build(page){
  await page.goto('http://localhost:8080/', {waitUntil:'load'});
  await page.evaluate(()=>localStorage.clear());
  await page.reload({waitUntil:'load'});
  for (const n of ['דנה','רועי','טל','מיכל']) { await page.fill('#playerNameInput', n); await page.click('#addPlayerForm button[type=submit]'); }
}

// phone: play a round
let page = await b.newPage({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true});
page.on('pageerror',e=>errors.push('phone: '+e.message));
await build(page);
await page.click('.tab[data-view="round"]');
await page.click('[data-action="start-hand"]');
await page.waitForTimeout(150);
// bets
const adds = page.locator('[data-action="bet-add"][data-amount="10"]');
for (let i=0;i<await adds.count();i++) await adds.nth(i).click();
await page.locator('[data-action="bet-add"][data-amount="25"]').first().click();
await page.waitForTimeout(150);
console.log('pot:', await page.textContent('.pot-box-value'));
// cards
await page.click('.board-card[data-slot="0"]');
await page.click('[data-action="choose-card"][data-card="As"]');
await page.click('.board-card[data-slot="1"]');
await page.click('[data-action="choose-card"][data-card="Kh"]');
await page.click('.board-card[data-slot="2"]');
await page.click('[data-action="choose-card"][data-card="7d"]');
await page.click('[data-action="set-street"][data-street="flop"]');
await page.waitForTimeout(200);
console.log('board:', await page.locator('.board-card.filled').count(), 'cards; street:', await page.textContent('.felt-street'));
await page.screenshot({path:`${OUT}/r1-round-light.png`, fullPage:false});
await page.click('#themeToggle'); await page.waitForTimeout(200);
await page.screenshot({path:`${OUT}/r2-round-dark.png`});
await page.click('#themeToggle');
// close hand -> winner 1
page.on('dialog', async d => { if (d.type()==='prompt') await d.accept('1'); else await d.accept(); });
await page.click('[data-action="close-hand"]');
await page.waitForTimeout(300);
console.log('after close, stacks:', await page.locator('.player-meta').first().textContent().catch(()=>'-'));
await page.click('.tab[data-view="count"]');
await page.waitForTimeout(150);
console.log('fill button present:', await page.locator('[data-action="fill-from-tracking"]').count());
await page.click('[data-action="fill-from-tracking"]');
await page.waitForTimeout(200);
console.log('count status:', (await page.textContent('#countStatus')).replace(/\s+/g,' ').slice(0,120));
await page.screenshot({path:`${OUT}/r3-count-light.png`});
await page.close();

// TV light + dark
for (const theme of ['light','dark']) {
  page = await b.newPage({viewport:{width:1920,height:1080}});
  page.on('pageerror',e=>errors.push('tv: '+e.message));
  await build(page);
  await page.evaluate(t=>localStorage.setItem('poker-manager:theme',t), theme);
  await page.reload({waitUntil:'load'});
  await page.click('[data-action="start-hand"]');
  await page.waitForTimeout(150);
  const a2 = page.locator('[data-action="bet-add"][data-amount="25"]');
  for (let i=0;i<await a2.count();i++) await a2.nth(i).click();
  await page.click('.board-card[data-slot="0"]'); await page.click('[data-action="choose-card"][data-card="As"]');
  await page.click('.board-card[data-slot="1"]'); await page.click('[data-action="choose-card"][data-card="Kh"]');
  await page.click('.board-card[data-slot="2"]'); await page.click('[data-action="choose-card"][data-card="Qs"]');
  await page.click('[data-action="set-street"][data-street="flop"]');
  await page.waitForTimeout(300);
  await page.screenshot({path:`${OUT}/tv-${theme}.png`});
  await page.close();
}
console.log(errors.length? 'ERRORS: '+errors.join(' | ') : 'no page errors');
await b.close();
