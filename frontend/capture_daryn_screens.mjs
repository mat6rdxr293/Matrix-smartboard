import { chromium } from '@playwright/test';
import fs from 'fs';
const OUT='/Users/matveysazhnov/Desktop/дарын/screens_fresh'; fs.mkdirSync(OUT,{recursive:true});
const BASE='http://127.0.0.1:5175/screenshot.html';
const browser=await chromium.launch({headless:true});
async function capture(name, screen, viewport={width:1280,height:800}, platformAndroid=false){
  const ctx=await browser.newContext({viewport, deviceScaleFactor:1, ignoreHTTPSErrors:true});
  if(platformAndroid) await ctx.addInitScript(()=>{ window.CapacitorCustomPlatform={name:'android'}; });
  const page=await ctx.newPage();
  await page.goto(`${BASE}?screen=${screen}`, {waitUntil:'networkidle'});
  await page.waitForTimeout(1000);
  await page.screenshot({path:`${OUT}/${name}.png`, fullPage:false});
  await ctx.close();
  console.log('SHOT', name);
}
await capture('android_setup_language','setup-language',{width:1280,height:800},true);
await capture('android_setup_connect','setup-connect',{width:1280,height:800},true);
await capture('android_setup_offline','setup-offline',{width:1280,height:800},true);
await capture('teacher_dashboard','teacher-direct',{width:1366,height:768});
await capture('workspace_board','lesson',{width:1366,height:768});
await capture('workspace_presentation','presentation',{width:1366,height:768});
await browser.close();
