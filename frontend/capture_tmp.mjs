import { chromium } from '@playwright/test';
const browser = await chromium.launch({headless:true});
const context = await browser.newContext({viewport:{width:1280,height:800}, deviceScaleFactor:1});
await context.addInitScript(() => {
  window.CapacitorCustomPlatform = { name: 'android' };
});
const page = await context.newPage();
await page.goto('http://127.0.0.1:5173/', {waitUntil:'networkidle'});
await page.screenshot({path:'/tmp/matrix_screens/test_setup2.png', fullPage:true});
console.log(await page.locator('body').innerText({timeout:3000}).catch(e=>'ERR '+e));
await browser.close();
