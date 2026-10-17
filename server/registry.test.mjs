import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { WebSocket } from 'ws';
import { ItemRegistry,prefabHash,categoryFor,validateRegistry,CATEGORIES } from './registry.mjs';
import { InventoryStore } from './store.mjs';
import { createApp } from './main.mjs';
import { validateIngest } from './validation.mjs';

const NOW=1_790_000_000_000;
const definition=(prefab,fields={})=>({id:'prefab:'+prefab,prefab,prefabHash:prefabHash(prefab),nameRu:'Тест '+prefab,nameEn:'Test '+prefab,maxStack:50,metadata:{},...fields});
const manifest=(items,fields={})=>({schemaVersion:1,gameVersion:'synthetic-test-build',generatedAt:new Date(NOW).toISOString(),source:{kind:'installed-assets',exporter:'synthetic fixture'},coverage:{definitionsFound:items.length,scope:'installed-assets',runtimeVerified:false},items,...fields});
function fixture(t) {const dir=mkdtempSync(join(tmpdir(),'vrm-registry-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return {dir,registry:new ItemRegistry(dir)};}
const packet=items=>({sourceId:'synthetic-test',worldId:'test-world',worldName:'SYNTHETIC TEST',sessionId:'test-session',sequence:1,mode:'snapshot',coverage:'partial',gameVersion:'synthetic',containers:[{id:'test:1',type:'chest',name:'SYNTHETIC',x:0,y:0,z:0,observedAt:NOW,items}],destroyedIds:[]});

test('partial runtime upload retains last good icon by exact prefab/build across restart without replaying inventory',t=>{
 const {dir,registry}=fixture(t),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8/x8AAwMCAO+jY1sAAAAASUVORK5CYII=','base64'),key=createHash('sha256').update(png).digest('hex'),missing='f'.repeat(64);
 registry.publishIcon(key,png);registry.publish(manifest([definition('Wood',{iconKey:key})]));
 const store=new InventoryStore(':memory:',{now:()=>NOW,registry});t.after(()=>store.close());store.ingest(validateIngest(packet([{prefab:'Wood',name:'Wood',quantity:40}])));
 registry.publish(manifest([definition('Wood',{iconKey:missing,nameRu:'Новое имя'})],{source:{kind:'runtime-objectdb'},coverage:{definitionsFound:1,runtimeVerified:true,itemsWithIcons:1}}));
 assert.equal(registry.resolve('Wood').iconUrl,'/api/icons/'+key+'.png');assert.equal(registry.resolve('Wood').iconKey,missing);assert.equal(registry.resolve('Wood').iconFallback,true);assert.equal(registry.resolve('Wood').nameRu,'Новое имя');assert.equal(store.state().stats.totalItems,40);
 assert.equal(new ItemRegistry(dir).resolve('Wood').iconUrl,'/api/icons/'+key+'.png');
 registry.publish(manifest([definition('Other',{iconKey:missing})]));assert.equal(registry.resolve('Other').iconUrl,null);
 registry.publish(manifest([definition('Wood',{iconKey:missing})],{gameVersion:'another-build'}));assert.equal(registry.resolve('Wood').iconUrl,null);
});

test('installed exact prefab icon bootstrap restores missing runtime bytes, preserving runtime metadata and coverage',t=>{
 const {dir}=fixture(t),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8/x8AAwMCAO+jY1sAAAAASUVORK5CYII=','base64'),key=createHash('sha256').update(png).digest('hex');
 mkdirSync(join(dir,'installed-assets/registry'),{recursive:true});mkdirSync(join(dir,'installed-assets/icons'),{recursive:true});writeFileSync(join(dir,'installed-assets/icons',key+'.png'),png);
 writeFileSync(join(dir,'installed-assets/registry/items.json'),JSON.stringify(manifest([definition('Wood',{iconKey:key,nameRu:'Старое имя'})])));
 const registry=new ItemRegistry(dir);registry.publish(manifest([definition('Wood',{iconKey:'a'.repeat(64),nameRu:'Текущее имя',maxStack:37})],{source:{kind:'runtime-objectdb'},coverage:{definitionsFound:2,runtimeVerified:true,itemsWithIcons:1}}));
 const item=registry.resolve('Wood');assert.equal(item.iconUrl,'/api/icons/'+key+'.png');assert.equal(item.nameRu,'Текущее имя');assert.equal(item.maxStack,37);assert.equal(registry.summary().scope,'runtime-objectdb');assert.equal(registry.summary().registered,1);assert.equal(registry.summary().definitionsFound,2);assert.equal(registry.summary().iconsFound,1);assert.equal(registry.iconFile(key),join(dir,'installed-assets/icons',key+'.png'));
 registry.publish(manifest([definition('Wood',{iconKey:null})]));assert.equal(registry.resolve('Wood').iconUrl,'/api/icons/'+key+'.png');
});

test('icon POST does not rebuild the full registry for every PNG and becomes available on next refresh',t=>{
 const {registry}=fixture(t),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8/x8AAwMCAO+jY1sAAAAASUVORK5CYII=','base64'),key=createHash('sha256').update(png).digest('hex');
 registry.publish(manifest([definition('Wood',{iconKey:key})]));const generation=registry.generation;
 registry.publishIcon(key,png);assert.equal(registry.generation,generation);registry.reload();assert.equal(registry.resolve('Wood').iconUrl,'/api/icons/'+key+'.png');
 const after=registry.generation;for(let i=0;i<10;i++)registry.publishIcon(key,png);assert.equal(registry.reload(),false);assert.equal(registry.generation,after);
});

test('registry accepts every definition in a large synthetic manifest and resolves all exact IDs/hashes',t=> {
  const {registry}=fixture(t),items=Array.from({length:2048},(_,i)=>definition('SyntheticItem_'+i));registry.publish(manifest(items));
  assert.equal(registry.summary().registered,2048);assert.equal(registry.summary().coveragePercent,100);assert.equal(registry.summary().runtimeVerified,false);assert.equal(registry.summary().scope,'installed-assets');
  for(const item of items) {assert.equal(registry.resolve(item.prefab).id,item.id);assert.equal(registry.resolve('hash:'+item.prefabHash).prefab,item.prefab);}
});
test('coverage distinguishes installed assets from runtime verification and never invents absent definitions',t=> {
  const {registry}=fixture(t);assert.equal(registry.summary().coveragePercent,null);assert.equal(registry.summary().registered,0);
  registry.publish(manifest([definition('Wood')],{coverage:{definitionsFound:2,runtimeVerified:true}}));assert.equal(registry.summary().coveragePercent,50);assert.equal(registry.summary().runtimeVerified,false);
  registry.publish(manifest([definition('Wood')],{source:{kind:'runtime-objectdb'},coverage:{definitionsFound:1,runtimeVerified:true}}));assert.equal(registry.summary().runtimeVerified,true);
});
test('duplicate IDs, hash mismatch and incorrect denominator reject a manifest without replacing valid registry',t=> {
  const {registry}=fixture(t);registry.publish(manifest([definition('Wood')]));
  assert.throws(()=>registry.publish(manifest([definition('Iron'),definition('Iron')])),error=>error.code==='DUPLICATE_ID');
  assert.throws(()=>registry.publish(manifest([definition('Iron',{prefabHash:0})])),error=>error.code==='HASH_MISMATCH');
  assert.throws(()=>registry.publish(manifest([definition('Iron')],{coverage:{definitionsFound:0}})));
  assert.equal(registry.resolve('Wood').prefab,'Wood');assert.equal(registry.resolve('Iron'),null);
});
test('real algorithm hash collision stays ambiguous while both distinct prefabs and same display names remain exact',t=> {
  const {registry}=fixture(t),one='Mod_pwnzjm_f9u',two='Mod_-cynz70_fh0';assert.equal(prefabHash(one),prefabHash(two));
  registry.publish(manifest([definition(one,{nameRu:'Одинаковое имя'}),definition(two,{nameRu:'Одинаковое имя'})]));
  assert.equal(registry.summary().hashCollisions,1);assert.equal(registry.resolve('hash:'+prefabHash(one)),null);assert.notEqual(registry.resolve(one).id,registry.resolve(two).id);assert.ok(registry.describe({prefab:'hash:'+prefabHash(one),name:'Unresolved'}).diagnostics.includes('HASH COLLISION'));
});
test('state retroactively normalizes hash aliases once, keeps raw source inventory and metadata variants, sums across chests',t=> {
  const {registry}=fixture(t),store=new InventoryStore(':memory:',{now:()=>NOW,registry});t.after(()=>store.close());
  const hash='hash:'+prefabHash('Wood');const data=packet([{prefab:'Wood',name:'Wood',quantity:10,quality:1,variant:0},{prefab:hash,name:'Unresolved',quantity:5,quality:2,variant:1},{prefab:'Mod_Unknown',name:'Unique mod',quantity:7,modId:'test.mod'}]);
  data.containers.push({...data.containers[0],id:'test:2',items:[{prefab:hash,name:'Unknown',quantity:20}]});store.ingest(validateIngest(data));assert.equal(store.state().stats.uniqueItems,3);
  const before=store.db.prepare('SELECT items FROM containers ORDER BY id').all().map(row=>row.items);
  registry.publish(manifest([definition('Wood',{nameRu:'Древесина',nameEn:'Wood'})]));const state=store.state(),wood=state.resources.find(item=>item.prefab==='Wood');
  assert.equal(state.stats.totalItems,42);assert.equal(state.stats.uniqueItems,2);assert.equal(wood.quantity,35);assert.equal(wood.containerIds.length,2);assert.deepEqual(wood.sourceIds.sort(),['Wood',hash].sort());assert.equal(wood.variants.reduce((sum,item)=>sum+item.quantity,0),35);assert.ok(wood.variants.some(item=>item.quality===2 && item.variant===1 && item.quantity===5));
  assert.ok(wood.searchText.includes(hash));assert.ok(state.containers[0].items.find(item=>item.prefab==='Wood').searchText.includes(hash));
  assert.deepEqual(store.db.prepare('SELECT items FROM containers ORDER BY id').all().map(row=>row.items),before);assert.equal(state.registry.inventoryUnknownItems,1);assert.equal(state.registry.reindexRequested,true);assert.equal(state.resources.find(item=>item.prefab==='Mod_Unknown').category,'Неопознанные');assert.equal(wood.availableQuantity,35);assert.equal(wood.reservedQuantity,0);assert.equal(wood.reservationsImplemented,false);
});
test('Russian, English, prefab and original hash identity all remain available for client search',t=> {
  const {registry}=fixture(t);registry.publish(manifest([definition('Wood',{nameRu:'Древесина',nameEn:'Wood'})]));const item=registry.describe({prefab:'hash:'+prefabHash('Wood'),name:'raw',quantity:40});for(const text of ['древесина','wood','prefab:wood','hash:'+prefabHash('Wood')])assert.ok(item.searchText.includes(text));
});
test('18 categories classify metadata/prefab automatically and local overrides persist without changing source manifest',t=> {
  const {registry,dir}=fixture(t);assert.equal(CATEGORIES.length,18);assert.equal(new Set(CATEGORIES).size,18);assert.equal(categoryFor('CrossbowArbalest'),'Оружие');assert.equal(categoryFor('ArrowIron'),'Боеприпасы');assert.equal(categoryFor('ModdedDrink',{isDrink:true}),'Зелья и расходники');assert.equal(categoryFor('UnknownQuest',{questItem:true}),'Ключевые и специальные предметы');registry.publish(manifest([definition('Mod_Resource')]));const before=readFileSync(registry.file,'utf8');registry.override({prefab:'Mod_Resource',category:'Руды и металлы',subcategory:'Тест'});assert.equal(new ItemRegistry(dir).resolve('Mod_Resource').category,'Руды и металлы');assert.equal(readFileSync(registry.file,'utf8'),before);registry.override({prefab:'Mod_Resource',category:null});assert.equal(registry.resolve('Mod_Resource').category,'Прочее');
});
test('installed ItemType names/numeric values classify opaque mod prefabs without using display names',()=> {
  for(const itemType of ['Chest','Legs','Hands','Utility','Trinket',6,7,11,12,17,18,24])assert.equal(categoryFor('OpaqueModPrefab',{itemType}),'Броня');
  for(const itemType of ['OneHandedWeapon','TwoHandedWeapon','TwoHandedWeaponLeft','Bow','Shield','Attach_Atgeir',3,4,5,14,15,20,22])assert.equal(categoryFor('OpaqueModPrefab',{itemType}),'Оружие');
  for(const itemType of ['Ammo','AmmoNonEquipable',9,23])assert.equal(categoryFor('OpaqueModPrefab',{itemType}),'Боеприпасы');assert.equal(categoryFor('OpaqueModPrefab',{itemTypeValue:21}),'Сырые продукты');assert.equal(categoryFor('OpaqueModPrefab',{itemType:19}),'Инструменты');
});
test('unusual native zero stack limits remain registered with raw value and diagnostic rather than inventing capacity',t=> {
  const {registry}=fixture(t);registry.publish(manifest([definition('Mod_UnusualStack',{maxStack:0})]));const item=registry.resolve('Mod_UnusualStack');assert.equal(item.maxStack,null);assert.equal(item.metadata.rawMaxStack,0);assert.ok(item.diagnostics.includes('INVALID MAX STACK'));assert.equal(registry.summary().registered,1);registry.reload(true);assert.equal(registry.resolve('Mod_UnusualStack').metadata.rawMaxStack,0);
});
test('missing localization/icon diagnostics are explicit, invalid file reload keeps last good manifest',t=> {
  const {registry}=fixture(t);registry.publish(manifest([definition('Wood',{nameRu:'',nameEn:'$untranslated'})]));assert.equal(registry.summary().missingLocalization,1);assert.equal(registry.summary().missingIcons,1);writeFileSync(registry.file,'{broken');assert.equal(registry.reload(),true);assert.equal(registry.summary().loadError,'REGISTRY_LOAD_FAILED');assert.equal(registry.summary().registered,1);assert.equal(registry.reload(),false);
});
test('directory names and coercible non-string icon keys never masquerade as available image files',t=> {
  const {registry}=fixture(t),key='e'.repeat(64);mkdirSync(join(registry.iconDirectory,key+'.png'),{recursive:true});registry.publish(manifest([definition('Wood',{iconKey:key})]));assert.equal(registry.summary().iconsFound,0);assert.equal(registry.iconFile(key),null);assert.equal(registry.iconFile([key]),null);assert.throws(()=>validateRegistry(manifest([definition('Wood',{iconKey:[key]})])));
});
test('registry JSON and synthetic PNG byte endpoints require source token; local reads never expose token or local paths',async t=> {
  const dir=mkdtempSync(join(tmpdir(),'vrm-registry-http-')),token='d'.repeat(64),app=createApp({dataDir:join(dir,'db'),localDataDir:join(dir,'local'),port:0,token,intervals:false});const port=await app.listen();t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});const base=`http://127.0.0.1:${port}`;
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8/x8AAwMCAO+jY1sAAAAASUVORK5CYII=','base64'),key=createHash('sha256').update(png).digest('hex');
  assert.equal((await fetch(base+'/api/registry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(manifest([]))})).status,401);
  assert.equal((await fetch(base+'/api/icons/'+key+'.png',{method:'POST',headers:{'Content-Type':'image/png'},body:png})).status,401);
  const iconResponse=await fetch(base+'/api/icons/'+key+'.png',{method:'POST',headers:{'Content-Type':'image/png','X-VRM-Token':token},body:png});assert.equal(iconResponse.status,200);
  assert.equal((await fetch(base+'/api/registry',{method:'POST',headers:{'Content-Type':'application/json','X-VRM-Token':token},body:JSON.stringify(manifest([definition('Wood',{iconKey:key})]))})).status,200);
  const catalog=await(await fetch(base+'/api/registry')).json();assert.equal(catalog.summary.iconsFound,1);assert.equal(catalog.items[0].iconUrl,'/api/icons/'+key+'.png');assert.ok(!JSON.stringify(catalog).includes(token));assert.ok(!JSON.stringify(catalog).includes(dir));
  const bytes=await fetch(base+catalog.items[0].iconUrl);assert.equal(bytes.status,200);assert.equal(bytes.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await bytes.arrayBuffer()),png);
  for(const path of ['/api/icons/../../data/ingest-token.txt','/api/icons/%2e%2e%2fingest-token.txt','/api/icons/not-a-key.png'])assert.ok((await fetch(base+path)).status>=400);
  assert.equal((await fetch(base+'/api/icons/'+'a'.repeat(64)+'.png',{method:'POST',headers:{'Content-Type':'image/png','X-VRM-Token':token},body:png})).status,400);
});
test('ingest optional instance identity metadata validates independently of display strings',()=> {
  assert.doesNotThrow(()=>validateIngest(packet([{prefab:'Sword',name:'Меч',quantity:1,quality:2,variant:1,customData:{mod:'verified'},metadata:{condition:'worn'}}])));
  for(const field of [{quality:-1},{variant:1.5},{modId:42},{variants:[]}])assert.throws(()=>validateIngest(packet([{prefab:'Sword',name:'Меч',quantity:1,...field}])));
});

test('unusual exact prefab keys support overrides/minimums; canonical minimum edits clear obsolete hash aliases',t=> {
  const {registry}=fixture(t),store=new InventoryStore(':memory:',{now:()=>NOW,registry});t.after(()=>store.close());
  store.ingest(validateIngest(packet([{prefab:'hash:'+prefabHash('Wood'),name:'Unknown',quantity:10},{prefab:'__proto__',name:'Mod prefab',quantity:1}])));
  store.minimum('test-world','hash:'+prefabHash('Wood'),100);registry.publish(manifest([definition('Wood'),definition('__proto__')]));assert.equal(store.state().resources.find(item=>item.prefab==='Wood').minimum,100);store.minimum('test-world','Wood',0);assert.equal(store.state().resources.find(item=>item.prefab==='Wood').minimum,0);
  registry.override({prefab:'__proto__',category:'Инструменты'});assert.equal(registry.resolve('__proto__').category,'Инструменты');store.minimum('test-world','__proto__',4);assert.equal(store.state().minimums.__proto__,4);assert.equal(store.state().resources.find(item=>item.prefab==='__proto__').minimum,4);
});

test('registry reindex notifies existing WebSocket clients and enriches prior API inventory without replaying quantities',async t=> {
  const dir=mkdtempSync(join(tmpdir(),'vrm-reindex-http-')),token='c'.repeat(64),app=createApp({dataDir:join(dir,'db'),localDataDir:join(dir,'local'),port:0,token,intervals:false,now:()=>NOW});const port=await app.listen(),base=`http://127.0.0.1:${port}`;
  const ws=new WebSocket(`ws://127.0.0.1:${port}/ws`,{origin:base});t.after(async()=>{ws.terminate();await app.close();rmSync(dir,{recursive:true,force:true});});await new Promise((done,reject)=>{ws.once('open',done);ws.once('error',reject);});
  const send=(path,value)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-VRM-Token':token},body:JSON.stringify(value)});
  const inventoryNotified=new Promise((done,reject)=> {const timeout=setTimeout(()=>reject(new Error('Ingest change not sent')),2000);const handler=message=> {const value=JSON.parse(message);if(value.demo===false && value.revision>0) {clearTimeout(timeout);ws.off('message',handler);done();}};ws.on('message',handler);});
  const ingest=await(await send('/api/snapshot',packet([{prefab:'hash:'+prefabHash('Wood'),name:'Unidentified snapshot stack',quantity:40}]))).json();assert.equal(ingest.reindexRequested,true);
  await inventoryNotified;
  const received=new Promise((done,reject)=>{const timeout=setTimeout(()=>reject(new Error('Registry change not sent')),2000);ws.once('message',message=>{clearTimeout(timeout);done(JSON.parse(message));});});
  assert.equal((await send('/api/registry',manifest([definition('Wood',{nameRu:'Древесина',nameEn:'Wood'})]))).status,200);const event=await received;assert.equal(event.type,'state-changed');assert.ok(!JSON.stringify(event).includes(token));
  for(let i=0;i<3;i++) {const state=await(await fetch(base+'/api/state')).json();assert.equal(state.resources.length,1);assert.equal(state.resources[0].prefab,'Wood');assert.equal(state.resources[0].quantity,40);assert.equal(state.resources[0].status,'SNAPSHOT');assert.equal(state.registry.inventoryUnknownItems,0);}
});
