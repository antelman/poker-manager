import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await b.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
const errs=[]; page.on('pageerror',e=>errs.push(e.message)); page.on('console',m=>{if(m.type()==='error')errs.push('c:'+m.text());});
await page.goto('http://localhost:8080/',{waitUntil:'load'});
await page.evaluate(()=>localStorage.clear());
await page.reload({waitUntil:'load'});
for (const n of ['דנה','רועי']) { await page.fill('#playerNameInput', n); await page.click('#addPlayerForm button[type=submit]'); }
await page.click('.tab[data-view="round"]');
await page.waitForTimeout(300);
console.log('errors:', errs);
console.log('roundContent:', (await page.locator('#roundContent').innerHTML()).slice(0,400));
await b.close();
