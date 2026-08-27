import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await b.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
await page.goto('http://localhost:8080/',{waitUntil:'load'});
await page.evaluate(()=>localStorage.clear());
await page.reload({waitUntil:'load'});
for (const n of ['דנה','רועי','טל']) { await page.fill('#playerNameInput', n); await page.click('#addPlayerForm button[type=submit]'); }
// open sync panel too
await page.click('#syncToggle');
await page.click('[data-action="host-game"]').catch(()=>{});
await page.waitForTimeout(300);

for (const view of ['game','round','count','settle','history']) {
  await page.click(`.tab[data-view="${view}"]`);
  if (view==='round') { await page.click('[data-action="start-hand"]').catch(()=>{}); await page.waitForTimeout(200);
    await page.click('.board-card[data-slot="0"]').catch(()=>{}); await page.waitForTimeout(200); }
  await page.waitForTimeout(250);
  const r = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const bad = [];
    for (const el of document.querySelectorAll('*')) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) continue;
      // element sticking out past the viewport, or scrolling internally
      if (rect.right > vw + 1 || rect.left < -1 || el.scrollWidth > el.clientWidth + 1) {
        bad.push(`${el.tagName}.${(el.className&&el.className.baseVal!==undefined?el.className.baseVal:el.className||'').toString().split(' ').filter(Boolean).slice(0,2).join('.')} right=${Math.round(rect.right)} sw=${el.scrollWidth} cw=${el.clientWidth}`);
      }
    }
    return { vw, docScroll: document.documentElement.scrollWidth, bodyScroll: document.body.scrollWidth, bad: bad.slice(0,12) };
  });
  console.log(`\n[${view}] vw=${r.vw} docScrollW=${r.docScroll} bodyScrollW=${r.bodyScroll}`);
  r.bad.forEach(x=>console.log('   ', x));
}
await b.close();
