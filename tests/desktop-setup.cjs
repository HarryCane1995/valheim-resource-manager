// Optional packaged-main acceptance. Requires a free port37841 and local game references.
// Game/process/Steam launch are simulated; real game files are opened only for reading.
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),net=require('node:net'),{tmpdir}=require('node:os'),{join,resolve,dirname}=require('node:path'),{createHash}=require('node:crypto'),assert=require('node:assert/strict');
const hash=path=>createHash('sha256').update(fs.readFileSync(path)).digest('hex');
const wait=async fn=>{const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await new Promise(done=>setTimeout(done,100));}throw Error('Acceptance timed out');};
(async()=>{
 const executable=resolve(process.argv[2]);
 const installed=process.argv[3]||'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Valheim';
 await new Promise((done,reject)=>{const socket=net.connect(37841,'127.0.0.1');socket.once('connect',()=>{socket.destroy();reject(Error('Close the panel before running this isolated test.'));});socket.once('error',error=>error.code==='ECONNREFUSED'?done():reject(error));});
 const home=fs.mkdtempSync(join(tmpdir(),'vrm-onefile-setup-')),game=join(home,'fixture-game'),data=join(home,'data'),checks=[];
 const refs=['valheim_Data/Managed/assembly_valheim.dll','BepInEx/core/BepInEx.dll','BepInEx/core/0Harmony.dll'];const baseline={};
 for(const relative of refs){const source=join(installed,relative);baseline[relative]=hash(source);const target=join(game,relative);fs.mkdirSync(dirname(target),{recursive:true});fs.copyFileSync(source,target);}
 fs.writeFileSync(join(game,'valheim.exe'),'synthetic executable; never run');fs.mkdirSync(join(game,'BepInEx/plugins/OtherMod'),{recursive:true});fs.writeFileSync(join(game,'BepInEx/plugins/OtherMod/sentinel.txt'),'keep');fs.mkdirSync(data);fs.writeFileSync(join(data,'desktop-game.json'),JSON.stringify({gameDirectory:game,autoLaunch:false}));
 const env={...process.env,VRM_DESKTOP_HOME:home,VRM_DESKTOP_PORT:'37841',VRM_DESKTOP_NO_GAME_LAUNCH:'0'};delete env.ELECTRON_RUN_AS_NODE;
 const ea=await _electron.launch({executablePath:executable,env,timeout:30000});
 try{
 const page=await ea.firstWindow();await page.getByTestId('game-connection').waitFor();
 await ea.evaluate(({shell})=>{const cp=process.getBuiltinModule('node:child_process'),original=cp.execFile;cp.execFile=(name,args,options,callback)=>name==='tasklist.exe'?(callback(null,'"fixture.exe","123","Console","1","1 K"\r\n'),{}):original(name,args,options,callback);process.getBuiltinModule('node:module').syncBuiltinESMExports();globalThis.testSteamLaunches=[];const fake=async url=>{globalThis.testSteamLaunches.push(url);};shell.openExternal=fake;if(shell.openExternal!==fake)throw Error('Steam launch mock unavailable');});
 await wait(async()=>(await page.evaluate(()=>window.vrmDesktop.getStatus())).integration.state==='ready');checks.push('packaged bootstrap installs embedded DLL automatically');
 const token=fs.readFileSync(join(data,'ingest-token.txt'),'utf8').trim(),cfg=join(game,'BepInEx/config/local.valheimresourcemanager.cfg'),dll=join(game,'BepInEx/plugins/ValheimResourceManager/ValheimResourceManager.dll');assert.match(token,/^[a-f0-9]{64}$/);assert.ok(fs.readFileSync(cfg,'utf8').includes('Token = '+token));assert.ok(fs.statSync(dll).size>10000);assert.ok(fs.existsSync(join(data,'desktop-integration.json')));checks.push('fresh own token and config paired without manual input');
 assert.equal(fs.readFileSync(join(game,'BepInEx/plugins/OtherMod/sentinel.txt'),'utf8'),'keep');checks.push('other mod sentinel preserved');
 await page.evaluate(()=>window.vrmDesktop.setAutoLaunch(true));await wait(async()=>await ea.evaluate(()=>globalThis.testSteamLaunches.length===1));assert.equal(await ea.evaluate(()=>globalThis.testSteamLaunches[0]),'steam://rungameid/892970');checks.push('automatic launch uses fixed Steam game URI');
 await page.evaluate(()=>window.vrmDesktop.launchGame());assert.equal(await ea.evaluate(()=>globalThis.testSteamLaunches.length),2);checks.push('manual launch uses same bounded action');
 await new Promise(done=>setTimeout(done,5500));assert.equal(await ea.evaluate(()=>globalThis.testSteamLaunches.length),2);checks.push('automatic launch occurs once per app session');
 for(const relative of refs)assert.equal(hash(join(installed,relative)),baseline[relative]);checks.push('real game and loader references unchanged');
 const proof={result:'PASS',simulatedGameProcess:true,simulatedSteamLaunch:true,target:'temporary game folder',realGameWrites:false,checks};fs.mkdirSync('.runtime',{recursive:true});fs.writeFileSync('.runtime/onefile-setup-proof.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof,null,2));
 }finally{await ea.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
