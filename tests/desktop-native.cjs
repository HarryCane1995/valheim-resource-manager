const { _electron }=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {mkdtempSync,readFileSync,mkdirSync,writeFileSync}=require('node:fs');
const {tmpdir}=require('node:os');const{join,resolve}=require('node:path');const assert=require('node:assert/strict');
const{spawn}=require('node:child_process');
// Optional real-window acceptance. Requires Playwright; uses isolated synthetic data.
(async()=>{
 mkdirSync('.runtime',{recursive:true});
 const home=mkdtempSync(join(tmpdir(),'vrm-desktop-native-')),port=37845,base=`http://127.0.0.1:${port}`,checks=[];
 const env={...process.env,VRM_DESKTOP_HOME:home,VRM_DESKTOP_PORT:String(port)};delete env.ELECTRON_RUN_AS_NODE;
 const electronApp=await _electron.launch({executablePath:resolve('node_modules/electron/dist/electron.exe'),args:[resolve('desktop/main.mjs')],env,timeout:30000});
 try{
  const page=await electronApp.firstWindow();await page.getByTestId('desktop-controls').waitFor();checks.push('actual native window and bridge');
  const status=await page.evaluate(()=>window.vrmDesktop.getStatus());assert.equal(status.backend,'owned');checks.push('embedded backend owned');
  assert.equal(await page.evaluate(()=>typeof require),'undefined');checks.push('renderer has no Node require');
  const token=readFileSync(join(home,'data','ingest-token.txt'),'utf8').trim();
  const ingest=async(id,sequence=1)=>{const r=await fetch(base+'/api/ingest',{method:'POST',headers:{'Content-Type':'application/json','X-VRM-Token':token},body:JSON.stringify({worldId:id,worldName:id==='synthetic-one'?'Первый тестовый мир':'Активный тестовый мир',sourceId:'desktop-fixture',sessionId:'desktop-fixture-'+id,sequence,mode:'host',coverage:'partial',gameVersion:'SYNTHETIC',hostBed:{status:'set',x:0,y:0,z:0},containers:[{id:'fixture-chest',type:'piece_chest',name:'Тестовый сундук',x:0,y:0,z:0,observedAt:new Date().toISOString(),items:[{prefab:'Wood',name:'Wood',quantity:100}]}],destroyedIds:[]})});assert.equal(r.status,200);};
  await ingest('synthetic-one');await new Promise(r=>setTimeout(r,50));await ingest('synthetic-two');
  await page.waitForFunction(async()=> (await window.vrmDesktop.getStatus()).activeWorld?.id==='synthetic-two',{timeout:15000});
  await page.waitForFunction(()=>document.querySelector('.desktop-world')?.textContent.includes('Активный тестовый мир'));checks.push('active world detected from authenticated ingest');
  await page.getByRole('button',{name:'На весь экран',exact:true}).click();
  await page.waitForFunction(async()=> (await window.vrmDesktop.getStatus()).fullscreen);assert.equal(await electronApp.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isFullScreen()),true);checks.push('button enters actual native fullscreen');
  await page.keyboard.press('Escape');await page.waitForFunction(async()=>!(await window.vrmDesktop.getStatus()).fullscreen);checks.push('Escape exits native fullscreen');
  await page.keyboard.press('F11');await page.waitForFunction(async()=>(await window.vrmDesktop.getStatus()).fullscreen);await page.keyboard.press('F11');await page.waitForFunction(async()=>!(await window.vrmDesktop.getStatus()).fullscreen);checks.push('F11 toggles native fullscreen');
  const second=spawn(resolve('node_modules/electron/dist/electron.exe'),[resolve('desktop/main.mjs')],{env,windowsHide:true,stdio:'ignore'});
  await new Promise((done,reject)=>{const timer=setTimeout(()=>reject(Error('second instance did not exit')),15000);second.once('exit',()=>{clearTimeout(timer);done();});});
  assert.equal(await electronApp.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length),1);checks.push('second launch focuses single existing window');
  mkdirSync('output/playwright',{recursive:true});await page.screenshot({path:'output/playwright/desktop-native.png'});
  await page.close();await new Promise(r=>setTimeout(r,1500));
  await assert.rejects(fetch(base+'/api/health',{signal:AbortSignal.timeout(1500)}));checks.push('closing window releases owned backend port');
  writeFileSync('.runtime/desktop-native-proof.json',JSON.stringify({result:'PASS',synthetic:true,checks},null,2));
  console.log(JSON.stringify({result:'PASS',synthetic:true,checks},null,2));
 }finally{await electronApp.close().catch(()=>{});}
})().catch(error=>{console.error(error);process.exitCode=1;});
