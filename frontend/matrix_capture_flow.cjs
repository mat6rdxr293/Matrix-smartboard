const { chromium } = require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:1365,height:768}, ignoreHTTPSErrors:true});
 const page=await context.newPage(); page.setDefaultTimeout(10000);
 await page.addInitScript(()=>{ localStorage.removeItem('matrix.apiBaseUrl'); });
 await page.goto('http://127.0.0.1:5173', {waitUntil:'networkidle', timeout:15000});
 await page.locator('button').filter({hasText:'Регистрация'}).click(); await page.waitForTimeout(300);
 await page.locator('input').nth(0).fill('ОСШГ №11 Demo '+Date.now()); await page.locator('input').nth(1).fill('demo'+'12345');
 await page.locator('button').filter({hasText:'Создать аккаунт'}).click(); await page.waitForTimeout(1500);
 await page.screenshot({path:'/tmp/matrix_s01_room.png'});
 await page.locator('button').filter({hasText:'Новый кабинет'}).click(); await page.waitForTimeout(500);
 console.log((await page.locator('body').innerText()).slice(0,3000));
 console.log('buttons', await page.locator('button').evaluateAll(btns=>btns.map(b=>b.textContent.trim())));
 console.log('inputs', await page.locator('input').evaluateAll(ins=>ins.map(i=>({placeholder:i.placeholder,value:i.value}))));
 await page.screenshot({path:'/tmp/matrix_s02_room_modal.png'});
 await browser.close();
})();