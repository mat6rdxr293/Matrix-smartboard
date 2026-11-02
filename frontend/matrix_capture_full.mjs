import { chromium } from '@playwright/test';
import fs from 'fs';
const OUT='/tmp/matrix_screens'; fs.mkdirSync(OUT,{recursive:true});
const browser=await chromium.launch({headless:true});
async function shot(page,name){ await page.screenshot({path:`${OUT}/${name}.png`, fullPage:false}); console.log('SHOT',name); }
// Android setup screenshots
{
 const ctx=await browser.newContext({viewport:{width:1280,height:800},deviceScaleFactor:1,ignoreHTTPSErrors:true});
 await ctx.addInitScript(()=>{window.CapacitorCustomPlatform={name:'android'};});
 const page=await ctx.newPage();
 await page.goto('http://127.0.0.1:5173/',{waitUntil:'networkidle'});
 await shot(page,'android_setup_language');
 await page.getByText('Русский').click();
 await page.waitForTimeout(700);
 await shot(page,'android_setup_first');
 // try find server screen
 const findBtn=page.getByText(/Найти сервер|Find server|Сервер/).first();
 await findBtn.click().catch(()=>{});
 await page.waitForTimeout(1200);
 await shot(page,'android_setup_find_server');
 // manual entry if exists
 await page.getByText(/Ввести адрес вручную|Enter server manually|қолмен/i).click().catch(()=>{});
 await page.waitForTimeout(500);
 await shot(page,'android_setup_manual');
 await ctx.close();
}
// Web app screenshots
{
 const ctx=await browser.newContext({viewport:{width:1366,height:768},deviceScaleFactor:1,ignoreHTTPSErrors:true});
 const page=await ctx.newPage();
 await page.addInitScript(()=>{localStorage.setItem('matrix.apiBaseUrl','https://127.0.0.1:8443');});
 await page.goto('http://127.0.0.1:5173/',{waitUntil:'networkidle'});
 await shot(page,'web_auth');
 // register a temporary school
 await page.getByText('Регистрация').click().catch(()=>{});
 await page.locator('input').first().fill('Demo Matrix School '+Date.now());
 await page.locator('input').nth(1).fill('matrix-demo-123');
 await page.getByRole('button', {name:/Создать|Зарегистр|Войти|школ/i}).click().catch(async()=>{ await page.locator('button').last().click(); });
 await page.waitForTimeout(1500);
 await shot(page,'room_setup');
 // create/choose room
 const inputs=await page.locator('input').count();
 if(inputs>0){ await page.locator('input').first().fill('Кабинет 28'); }
 await page.getByRole('button').filter({hasText:/Создать|Продолжить|Начать|Далее|Добавить/i}).first().click().catch(()=>{});
 await page.waitForTimeout(1000);
 await shot(page,'grade_picker');
 await page.getByText(/11/).first().click().catch(()=>{});
 await page.waitForTimeout(600);
 await shot(page,'subject_picker');
 await page.getByText(/Алгебра|Математика|Физика/).first().click().catch(()=>{});
 await page.waitForTimeout(600);
 await shot(page,'profile_picker');
 await page.getByText(/Универсальная|Аналитическая|Доска|Начать|Продолжить/i).first().click().catch(()=>{});
 await page.waitForTimeout(1800);
 await shot(page,'main_board');
 // teacher section
 await page.getByText('Учитель').click().catch(()=>{});
 await page.waitForTimeout(800);
 await shot(page,'teacher_panel');
 await page.getByText(/Создать урок с ИИ|урок с ИИ/i).click().catch(()=>{});
 await page.waitForTimeout(800);
 await shot(page,'lesson_generator');
 // presentation tab
 await page.getByText('Презентация').click().catch(()=>{});
 await page.waitForTimeout(800);
 await shot(page,'presentation_empty');
 await ctx.close();
}
await browser.close();
