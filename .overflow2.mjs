import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
for (const w of [320,360,375,390,414,430]) {
  const page = await b.newPage({viewport:{width:w,height:844},isMobile:true,hasTouch:true});
  await page.goto('http://localhost:8080/',{waitUntil:'load'});
  await page.evaluate(()=>localStorage.clear());
  await page.reload({waitUntil:'load'});
  for (const n of ['אלכסנדר הגדול','רועי','מיכל-אנה']) { await page.fill('#playerNameInput', n); await page.click('#addPlayerForm button[type=submit]'); }
  await page.click('#syncToggle');
  await page.click('[data-action="host-game"]').catch(()=>{});
  await page.waitForTimeout(250);
  const out = [];
  for (const view of ['game','round','count','settle']) {
    await page.click(`.tab[data-view="${view}"]`);
    if (view==='round') { await page.click('[data-action="start-hand"]').catch(()=>{}); await page.waitForTimeout(200); }
    await page.waitForTimeout(200);
    const r = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const bad = [];
      for (const el of document.querySelectorAll('body *')) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0) continue;
        if (rect.right > vw + 1 || rect.left < -1) {
          const cls = (el.className && el.className.baseVal!==undefined? el.className.baseVal : el.className||'').toString().split(' ').filter(Boolean).slice(0,2).join('.');
          bad.push(`${el.tagName}.${cls} L=${Math.round(rect.left)} R=${Math.round(rect.right)}`);
        }
      }
      return { doc: document.documentElement.scrollWidth, vw, bad: bad.slice(0,6) };
    });
    if (r.doc > r.vw || r.bad.length) out.push(`  [${view}] docW=${r.doc} vw=${r.vw} ${r.bad.join(' | ')}`);
  }
  console.log(`w=${w}: ${out.length? '\n'+out.join('\n') : 'clean'}`);
  await page.close();
}
await b.close();
