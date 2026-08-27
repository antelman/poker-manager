import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await b.newPage({viewport:{width:1920,height:1080}});
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
await page.goto('http://localhost:8080/',{waitUntil:'load'});
await page.evaluate(()=>localStorage.clear());
await page.reload({waitUntil:'load'});
for (const n of ['דנה','רועי','טל']) { await page.fill('#playerNameInput', n); await page.click('#addPlayerForm button[type=submit]'); }
await page.waitForTimeout(300);
for (const v of ['game','round','count','settle','history']) {
  console.log(`view-${v} visible on board:`, await page.locator(`#view-${v}`).isVisible());
}
console.log('tabbar hidden on board:', !(await page.locator('.tabbar').isVisible()));
console.log('sync body still closed:', !(await page.locator('#syncBody').isVisible()));
const o = await page.evaluate(()=>({doc:document.documentElement.scrollWidth, vw:document.documentElement.clientWidth}));
console.log('overflow:', JSON.stringify(o));
console.log(errs.length?'ERRORS: '+errs.join(' | '):'no page errors');
await b.close();
