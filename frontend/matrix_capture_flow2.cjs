const { chromium } = require('playwright');
async function txt(page,label){ console.log('\n--- '+label+' ---'); console.log((await page.locator('body').innerText()).slice(0,3000)); console.log('buttons', await page.locator('button').evaluateAll(btns=>btns.map(b=>b.textContent.trim()).slice(0,30))); }
(async()=>{
 const browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:1365,height:768}, ignoreHTTPSErrors:true});
 const page=await context.newPage(); page.setDefaultTimeout(10000);
 await page.addInitScript(()=>{ localStorage.removeItem('matrix.apiBaseUrl'); });
 await page.goto('http://127.0.0.1:5173', {waitUntil:'networkidle', timeout:15000});
 await page.locator('button').filter({hasText:'Регистрация'}).click(); await page.waitForTimeout(250);
 await page.locator('input').nth(0).fill('ОСШГ №11 Demo '+Date.now()); await page.locator('input').nth(1).fill('demo'+'12345');
 await page.locator('button').filter({hasText:'Создать аккаунт'}).click(); await page.waitForTimeout(1200);
 await page.screenshot({path:'/tmp/matrix_s01_room.png', type:'jpeg', quality:72});
 await page.locator('button').filter({hasText:'Новый кабинет'}).first().click(); await page.waitForTimeout(300);
 await page.locator('input').first().fill('28'); await page.locator('button').filter({hasText:'Создать'}).click(); await page.waitForTimeout(1500);
 await page.screenshot({path:'/tmp/matrix_s02_grade.png', type:'jpeg', quality:72}); await txt(page,'grade');
 // pick 11 grade if visible
 const gradeBtn = page.locator('button').filter({hasText:/11|11 класс|11 сынып|11th/}).first();
 if (await gradeBtn.count()) await gradeBtn.click(); else await page.locator('button').nth(0).click();
 await page.waitForTimeout(1000); await page.screenshot({path:'/tmp/matrix_s03_subject.png', type:'jpeg', quality:72}); await txt(page,'subject');
 let subj = page.locator('button').filter({hasText:/Алгебра|Математика|Mathematics|Algebra/}).first();
 if (await subj.count()) await subj.click(); else await page.locator('button').nth(0).click();
 await page.waitForTimeout(1000); await page.screenshot({path:'/tmp/matrix_s04_profile.png', type:'jpeg', quality:72}); await txt(page,'profile');
 let prof = page.locator('button').filter({hasText:/Интерактив|Универс|Доска|Начать|Выбрать/}).first();
 if (await prof.count()) await prof.click(); else await page.locator('button').nth(0).click();
 await page.waitForTimeout(2500); await page.screenshot({path:'/tmp/matrix_s05_lesson.png', type:'jpeg', quality:72}); await txt(page,'lesson');
 // open teacher panel tab
 const teacher = page.locator('button').filter({hasText:'Учитель'}).first(); if (await teacher.count()) await teacher.click(); await page.waitForTimeout(800);
 await page.screenshot({path:'/tmp/matrix_s06_teacher.png', type:'jpeg', quality:72});
 // open create lesson ai if available
 const createAi = page.locator('button, a').filter({hasText:/Создать урок с ИИ|ИИ|Сгенерировать/}).first(); if (await createAi.count()) { await createAi.click(); await page.waitForTimeout(800); }
 await page.screenshot({path:'/tmp/matrix_s07_lesson_ai.png', type:'jpeg', quality:72});
 await browser.close();
})();