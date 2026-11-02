const { chromium } = require('playwright');
const fs = require('fs');
const out = '/Users/matveysazhnov/Desktop/дарын/screens';
fs.mkdirSync(out, {recursive:true});
const screens = [
  ['android_setup_language','/screenshot.html?screen=setup-language'],
  ['android_setup_connect','/screenshot.html?screen=setup-connect'],
  ['android_setup_offline','/screenshot.html?screen=setup-offline'],
  ['workspace_board','/screenshot.html?screen=lesson'],
  ['workspace_presentation','/screenshot.html?screen=presentation'],
  ['teacher_dashboard_home','/screenshot.html?screen=teacher'],
  ['teacher_ai_lesson','/screenshot.html?screen=teacher-direct'],
];
(async()=>{
 const browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:1280,height:800}, deviceScaleFactor:1, ignoreHTTPSErrors:true});
 const page=await context.newPage();
 page.setDefaultTimeout(12000);
 page.on('pageerror', e => console.log('PAGEERROR', e.message));
 page.on('console', m => { if (['error','warning'].includes(m.type())) console.log('CONSOLE', m.type(), m.text().slice(0,300)); });
 for (const [name,path] of screens) {
   const url = 'http://127.0.0.1:5173'+path+'&v='+Date.now();
   console.log('capture', name);
   await page.goto(url, {waitUntil:'networkidle', timeout:20000});
   await page.waitForTimeout(1600);
   if (name==='teacher_ai_lesson') {
     const btn = page.locator('button, a').filter({hasText:/Создать урок с ИИ|ИИ|Сгенерировать/}).first();
     if (await btn.count()) { await btn.click().catch(()=>{}); await page.waitForTimeout(900); }
   }
   await page.screenshot({path:`${out}/${name}.png`, fullPage:false});
 }
 await browser.close();
})();
