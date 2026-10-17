import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { discoverGameDirectories, parseSteamLibraries, parsePluginConfig, ensureGameIntegration, inspectGame, ensureLocalToken } from '../desktop/integration.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const closed=async()=>({state:'not-running'}),running=async()=>({state:'running'});
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'vrm-onefile-')),gameDir=join(root,'game'),dataDir=join(root,'private'),bundledDll=join(root,'own-plugin.bin'),game=Buffer.from('synthetic audited game'),bundle=Buffer.from('synthetic own plugin');
 const put=(relative,bytes)=>{const path=join(gameDir,relative);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,bytes);return path;};
 put('valheim.exe','synthetic executable');put('valheim_Data/Managed/assembly_valheim.dll',game);put('BepInEx/core/BepInEx.dll','synthetic loader');put('BepInEx/core/0Harmony.dll','synthetic harmony');put('BepInEx/plugins/OtherMod/Other.dll','unrelated mod');put('save-sentinel','unchanged');writeFileSync(bundledDll,bundle);
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const options={gameDir,dataDir,bundledDll,auditedHash:hash(game),gameState:closed};
 const dllPath=join(gameDir,'BepInEx/plugins/ValheimResourceManager/ValheimResourceManager.dll'),cfgPath=join(gameDir,'BepInEx/config/local.valheimresourcemanager.cfg');
 return{root,gameDir,dataDir,bundledDll,bundle,options,put,dllPath,cfgPath};
}
const config=(token='a'.repeat(64),extra='')=>`# preserve formatting\r\n[Connection]\r\nEndpoint = http://127.0.0.1:37841/api/ingest\r\nToken = ${token}\r\nSourceId = existing-player-id\r\n[Indexing]\r\nEnabled = true\r\nScanHostPersistedZdos = false\r\n${extra}`;
test('first launch copies only own DLL/config, generates local credentials and records receipt',async t=>{
 const f=fixture(t);assert.deepEqual(await ensureGameIntegration(f.options),{state:'ready',changed:true});
 const token=readFileSync(join(f.dataDir,'ingest-token.txt'),'utf8');assert.match(token,/^[a-f0-9]{64}$/);
 assert.deepEqual(readFileSync(f.dllPath),f.bundle);const cfg=parsePluginConfig(readFileSync(f.cfgPath));assert.equal(cfg.token,token);assert.match(cfg.values['Connection.SourceId'],/^[a-f0-9]{32}$/);
 assert.equal(readFileSync(join(f.gameDir,'BepInEx/plugins/OtherMod/Other.dll'),'utf8'),'unrelated mod');assert.equal(readFileSync(join(f.gameDir,'save-sentinel'),'utf8'),'unchanged');
 const receipt=JSON.parse(readFileSync(join(f.dataDir,'desktop-integration.json')));assert.equal(receipt.configHash,hash(readFileSync(f.cfgPath)));assert.equal(receipt.pluginHash,hash(f.bundle));assert.ok(existsSync(join(receipt.backup,'before.json')));assert.ok(existsSync(join(receipt.backup,'after.json')));assert.deepEqual(readFileSync(join(receipt.backup,'config.after')),readFileSync(f.cfgPath));
});
test('repeat launch is idempotent even while Valheim is running',async t=>{
 const f=fixture(t);await ensureGameIntegration(f.options);const before=[statSync(f.dllPath).mtimeMs,statSync(f.cfgPath).mtimeMs];
 assert.deepEqual(await ensureGameIntegration({...f.options,gameState:running}),{state:'ready',changed:false});assert.deepEqual([statSync(f.dllPath).mtimeMs,statSync(f.cfgPath).mtimeMs],before);
});
test('fresh portable folder adopts the existing own token without changing running-game files',async t=>{
 const f=fixture(t);f.put('BepInEx/plugins/ValheimResourceManager/ValheimResourceManager.dll',f.bundle);f.put('BepInEx/config/local.valheimresourcemanager.cfg',config());const original=readFileSync(f.cfgPath);
 assert.equal((await ensureGameIntegration({...f.options,gameState:running})).state,'ready');assert.equal(readFileSync(join(f.dataDir,'ingest-token.txt'),'utf8'),'a'.repeat(64));assert.deepEqual(readFileSync(f.cfgPath),original);
});
test('existing local token is retained for a new plugin',async t=>{
 const f=fixture(t);mkdirSync(f.dataDir);writeFileSync(join(f.dataDir,'ingest-token.txt'),'b'.repeat(64));await ensureGameIntegration(f.options);assert.equal(parsePluginConfig(readFileSync(f.cfgPath)).token,'b'.repeat(64));
});
test('re-pairing preserves comments, source identity and indexing preference with exact backup',async t=>{
 const f=fixture(t);f.put('BepInEx/plugins/ValheimResourceManager/ValheimResourceManager.dll',f.bundle);f.put('BepInEx/config/local.valheimresourcemanager.cfg',config());mkdirSync(f.dataDir);writeFileSync(join(f.dataDir,'ingest-token.txt'),'b'.repeat(64));
 assert.equal((await ensureGameIntegration(f.options)).state,'ready');const parsed=parsePluginConfig(readFileSync(f.cfgPath));assert.equal(parsed.token,'b'.repeat(64));assert.equal(parsed.values['Connection.SourceId'],'existing-player-id');assert.equal(parsed.values['Indexing.ScanHostPersistedZdos'],'false');assert.ok(parsed.text.startsWith('# preserve formatting'));
 const receipt=JSON.parse(readFileSync(join(f.dataDir,'desktop-integration.json')));assert.equal(readFileSync(join(receipt.backup,'config.before'),'utf8'),config());
});
test('a missing Token entry is filled without resetting existing preferences',async t=>{
 const f=fixture(t);f.put('BepInEx/plugins/ValheimResourceManager/ValheimResourceManager.dll',f.bundle);f.put('BepInEx/config/local.valheimresourcemanager.cfg',config().replace(/^Token.*\r\n/m,''));assert.equal((await ensureGameIntegration(f.options)).state,'ready');const parsed=parsePluginConfig(readFileSync(f.cfgPath));assert.equal(parsed.values['Indexing.ScanHostPersistedZdos'],'false');assert.equal(parsed.values['Connection.SourceId'],'existing-player-id');
});
test('a running game defers first integration without adding game files',async t=>{
 const f=fixture(t);assert.equal((await ensureGameIntegration({...f.options,gameState:running})).state,'waiting-game-close');assert.ok(!existsSync(f.dllPath));assert.ok(!existsSync(f.cfgPath));
});
test('unknown process status also defers game mutations',async t=>{
 const f=fixture(t);assert.equal((await ensureGameIntegration({...f.options,gameState:async()=>({state:'unknown'})})).state,'waiting-game-close');assert.ok(!existsSync(f.dllPath));assert.ok(!existsSync(f.cfgPath));
});
test('starting the game during preparation aborts before commit',async t=>{
 const f=fixture(t);let calls=0;const result=await ensureGameIntegration({...f.options,gameState:async()=>({state:++calls===1?'not-running':'running'})});assert.equal(result.state,'waiting-game-close');assert.equal(calls,2);assert.ok(!existsSync(f.dllPath));assert.ok(!existsSync(f.cfgPath));
});
test('unsupported game assembly prevents any game mutation',async t=>{
 const f=fixture(t);f.put('valheim_Data/Managed/assembly_valheim.dll','different game');assert.equal((await ensureGameIntegration(f.options)).state,'unsupported');assert.ok(!existsSync(f.dllPath));assert.ok(!existsSync(f.cfgPath));
});
test('existing BepInEx and Harmony are required and never installed by the app',async t=>{
 const f=fixture(t);rmSync(join(f.gameDir,'BepInEx/core/0Harmony.dll'));assert.equal((await ensureGameIntegration(f.options)).state,'loader-missing');assert.ok(!existsSync(f.dllPath));assert.ok(!existsSync(join(f.gameDir,'BepInEx/core/0Harmony.dll')));
});
test('unknown existing DLL is preserved byte for byte',async t=>{
 const f=fixture(t);f.put('BepInEx/plugins/ValheimResourceManager/ValheimResourceManager.dll','user custom plugin');assert.equal((await ensureGameIntegration(f.options)).state,'conflict');assert.equal(readFileSync(f.dllPath,'utf8'),'user custom plugin');assert.ok(!existsSync(f.cfgPath));
});
test('unknown files in the target subfolder are preserved',async t=>{
 const f=fixture(t);f.put('BepInEx/plugins/ValheimResourceManager/custom.txt','user file');assert.equal((await ensureGameIntegration(f.options)).state,'conflict');assert.ok(!existsSync(f.dllPath));
});
test('duplicate, unknown and malformed config entries are refused',t=>{
 for(const text of [config('bad token'),config()+ '\n[Connection]\nToken = '+ 'b'.repeat(64),config()+'\nOther = value',config().replace('127.0.0.1','example.invalid')])assert.throws(()=>{const parsed=parsePluginConfig(Buffer.from(text));if(parsed.endpoint!=='http://127.0.0.1:37841/api/ingest')throw Error('endpoint');});
});
test('disabled exporter is preserved instead of silently re-enabled',async t=>{
 const f=fixture(t);const bytes=config().replace('Enabled = true','Enabled = false');f.put('BepInEx/config/local.valheimresourcemanager.cfg',bytes);assert.equal((await ensureGameIntegration(f.options)).state,'disabled');assert.equal(readFileSync(f.cfgPath,'utf8'),bytes);assert.ok(!existsSync(f.dllPath));
});
test('invalid local token cannot overwrite a valid game config',async t=>{
 const f=fixture(t);f.put('BepInEx/config/local.valheimresourcemanager.cfg',config());mkdirSync(f.dataDir);writeFileSync(join(f.dataDir,'ingest-token.txt'),'invalid');assert.equal((await ensureGameIntegration(f.options)).state,'local-token-invalid');assert.equal(readFileSync(f.cfgPath,'utf8'),config());
});
test('destination changes during preparation are preserved',async t=>{
 const f=fixture(t);const result=await ensureGameIntegration({...f.options,beforeCommit:()=>f.put('BepInEx/plugins/ValheimResourceManager/ValheimResourceManager.dll','concurrent file')});assert.equal(result.state,'conflict');assert.equal(readFileSync(f.dllPath,'utf8'),'concurrent file');assert.ok(!existsSync(f.cfgPath));
});
test('a game update during preparation blocks integration',async t=>{
 const f=fixture(t);const result=await ensureGameIntegration({...f.options,beforeCommit:()=>f.put('valheim_Data/Managed/assembly_valheim.dll','updated during preparation')});assert.equal(result.state,'unsupported');assert.ok(!existsSync(f.dllPath));assert.ok(!existsSync(f.cfgPath));
});
test('unrelated files appearing in the target directory during preparation are preserved',async t=>{
 const f=fixture(t);const result=await ensureGameIntegration({...f.options,beforeCommit:()=>f.put('BepInEx/plugins/ValheimResourceManager/custom.txt','concurrent file')});assert.equal(result.state,'conflict');assert.ok(!existsSync(f.dllPath));assert.equal(readFileSync(join(f.gameDir,'BepInEx/plugins/ValheimResourceManager/custom.txt'),'utf8'),'concurrent file');
});
test('failure after DLL creation rolls back only the new own files',async t=>{
 const f=fixture(t);const result=await ensureGameIntegration({...f.options,afterWrite:stage=>{if(stage==='dll')throw Error('injected');}});assert.equal(result.state,'error');assert.ok(!existsSync(f.dllPath));assert.ok(!existsSync(f.cfgPath));assert.equal(readFileSync(join(f.gameDir,'save-sentinel'),'utf8'),'unchanged');
});
test('failure after config replacement restores the exact previous config',async t=>{
 const f=fixture(t);f.put('BepInEx/plugins/ValheimResourceManager/ValheimResourceManager.dll',f.bundle);f.put('BepInEx/config/local.valheimresourcemanager.cfg',config());mkdirSync(f.dataDir);writeFileSync(join(f.dataDir,'ingest-token.txt'),'b'.repeat(64));const result=await ensureGameIntegration({...f.options,afterWrite:stage=>{if(stage==='config')throw Error('injected');}});assert.equal(result.state,'error');assert.equal(readFileSync(f.cfgPath,'utf8'),config());assert.deepEqual(readFileSync(f.dllPath),f.bundle);
});
test('concurrent config edit after commit is preserved on failure',async t=>{
 const f=fixture(t);const result=await ensureGameIntegration({...f.options,afterWrite:stage=>{if(stage==='config'){writeFileSync(f.cfgPath,'concurrent user edit');throw Error('injected');}}});assert.equal(result.state,'error');assert.equal(readFileSync(f.cfgPath,'utf8'),'concurrent user edit');
});
test('junction destinations are rejected before any integration write',async t=>{
 const f=fixture(t);const outside=join(f.root,'outside');mkdirSync(outside);const target=join(f.gameDir,'BepInEx/plugins/ValheimResourceManager');try{symlinkSync(outside,target,'junction');}catch(error){if(error.code==='EPERM'){t.skip('junction unavailable');return;}throw error;}assert.equal((await ensureGameIntegration(f.options)).state,'unsafe-path');assert.deepEqual(readdirSync(outside),[]);
});
test('Steam library parser and discovery handle multiple libraries and custom install names',async t=>{
 const f=fixture(t);const steam=join(f.root,'steam'),library=join(f.root,'library');mkdirSync(join(steam,'steamapps'),{recursive:true});mkdirSync(join(library,'steamapps','common'),{recursive:true});
 const escape=path=>path.replaceAll('\\','\\\\');writeFileSync(join(steam,'steamapps/libraryfolders.vdf'),`"libraryfolders" { "0" { "path" "${escape(library)}" } }`);writeFileSync(join(library,'steamapps/appmanifest_892970.acf'),'"AppState" { "appid" "892970" "installdir" "CustomValheim" }');const candidate=join(library,'steamapps/common/CustomValheim');mkdirSync(join(candidate,'valheim_Data/Managed'),{recursive:true});writeFileSync(join(candidate,'valheim.exe'),'fixture');writeFileSync(join(candidate,'valheim_Data/Managed/assembly_valheim.dll'),'fixture');assert.deepEqual(parseSteamLibraries(`"path" "${escape(library)}"`),[library]);assert.deepEqual(await discoverGameDirectories({registryPath:steam,env:{},platform:'test'}),[candidate]);
});
test('Windows Steam paths differing only by case produce one installation',async t=>{
 if(process.platform!=='win32'){t.skip('Windows path casing');return;}
 const f=fixture(t),steam=join(f.root,'Steam'),candidate=join(steam,'steamapps/common/Valheim');mkdirSync(join(candidate,'valheim_Data/Managed'),{recursive:true});writeFileSync(join(candidate,'valheim.exe'),'fixture');writeFileSync(join(candidate,'valheim_Data/Managed/assembly_valheim.dll'),'fixture');const found=await discoverGameDirectories({registryPath:steam.toUpperCase(),env:{'ProgramFiles(x86)':f.root},platform:'test'});assert.equal(found.length,1);assert.equal(found[0].toLowerCase(),candidate.toLowerCase());
});
