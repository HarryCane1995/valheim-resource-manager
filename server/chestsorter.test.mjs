import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { parseChestSorterRules, classifyChestSorter, chestSorterFoodColor, ChestSorterReader, configuredGameDirectory } from './chestsorter.mjs';
import { createApp } from './main.mjs';
import { ItemRegistry, prefabHash } from './registry.mjs';
import { InventoryStore } from './store.mjs';
import { validateIngest } from './validation.mjs';

// Deliberately small synthetic rules, not a redistributed mod configuration.
const text=`version | 4
category | Wood | Timber
category | Other | Other
category | Food | All food
category | Health | Red meals
category | Stamina | Yellow meals
category | Eitr | Blue meals
category | Balanced | White meals
category | Misc | Miscellaneous
category | Exact | Exact match
category | OldWood | Old timber
alias | OldWood | Wood
parent | Health | Food
foodcolor | Health | Health
foodcolor | Stamina | Stamina
foodcolor | Eitr | Eitr
foodcolor | Balanced | Balanced
itemtype | Material | Misc
itemtype | Consumable | Food
prefix | Material | Test | Other
override | * | TestWood | Exact
suffix | Material | Wood | OldWood`;
const rules=parseChestSorterRules(text);
const item=(prefab,type='Material',extra={})=>({prefab,metadata:{itemType:type,...extra}});
const category=(prefab,type,extra)=>classifyChestSorter(item(prefab,type,extra),rules).categoryId;
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'vrm-sorter-')),game=join(root,'game'),config=join(game,'BepInEx/config/ChestSorter.categories.txt');
 mkdirSync(join(game,'BepInEx/config'),{recursive:true});writeFileSync(config,text);
 const fixture={root,game,config,reader:new ChestSorterReader(()=>game),close:null};
 t.after(async()=>{await fixture.close?.();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));rmSync(root,{recursive:true,force:true});});
 return fixture;
}
const definition=prefab=>({id:'prefab:'+prefab,prefab,prefabHash:prefabHash(prefab),nameRu:'Тест '+prefab,nameEn:'Test '+prefab,maxStack:50,metadata:{itemType:'Material'}});
const manifest=items=>({schemaVersion:1,gameVersion:'synthetic',generatedAt:new Date().toISOString(),source:{kind:'installed-assets'},coverage:{definitionsFound:items.length+2,scope:'installed-assets',runtimeVerified:false},items});
const packet=(items,extra={})=>({sourceId:'synthetic',sessionId:'test',sequence:1,worldId:'one',worldName:'Synthetic one',gameVersion:'synthetic',mode:'host',coverage:'partial',hostBed:{status:'set',x:0,y:0,z:0},destroyedIds:[],containers:[{id:'test:1',type:'chest',name:'Synthetic',x:0,y:0,z:0,observedAt:Date.now(),items}],...extra});
function catalogFixture(t,prefabs){
 const f=fixture(t),registry=new ItemRegistry(join(f.root,'registry')),filename=join(f.root,'stock.sqlite');
 registry.publish(manifest(prefabs.map(definition)));
 let store=new InventoryStore(filename,{registry});f.close=()=>store.close();
 return {...f,registry,get store(){return store;},ingest:(items,extra)=>store.ingest(validateIngest(packet(items,extra))),view:selection=>{const state=store.state(selection);return f.reader.view(state,{registry,observedPrefabs:store.observedPrefabs(state.world?.id)});},reopen:()=>{store.close();store=new InventoryStore(filename,{registry});}};
}

test('category file retains declared names/order/parents and resolves aliases case-insensitively',()=>{
 assert.equal(rules.version,4);assert.deepEqual(rules.categories.slice(0,3).map(c=>c.name),['Timber','Other','All food']);
 assert.equal(rules.categories.find(c=>c.id==='Health').parentId,'Food');assert.equal(rules.resolveId('oldwood'),'Wood');
 assert.deepEqual(parseChestSorterRules('\uFEFF'+text+'\n # ignored').categories,rules.categories);
});
test('exact override beats prefix regardless of file order; item type scopes remain exact',()=>{
 assert.equal(category('TestWood'),'Exact');assert.equal(category('TestPlank'),'Other');assert.equal(category('TestPlank','Tool'),'Tool');
 assert.equal(category('FineWood','mATERIAL'),'Wood');assert.equal(category('tESTwOOD'),'Exact');assert.equal(category('PineWoodExtra'),'Misc');
});
test('name rules honor prefix/endswith/contains/suffix priority and PascalCase last words',()=>{
 const r=parseChestSorterRules(text+'\ncontains | Material | Wood | Other\nendswith | Material | Wood | Exact');
 assert.equal(classifyChestSorter(item('OakWood'),r).categoryId,'Exact');assert.equal(classifyChestSorter(item('WoodPlank'),r).categoryId,'Other');
 assert.equal(category('OakWood2'),'Misc');assert.equal(category('Oak_Wood'),'Wood');
});
test('numeric item type and both registry food metadata shapes classify without translated-name guessing',()=>{
 assert.equal(category('PineWood',1),'Wood');assert.equal(category('Meal',2,{food:100,foodStamina:20,foodEitr:0}),'Health');
 assert.equal(category('Meal',2,{foodHealth:20,foodStamina:100,foodEitr:0}),'Stamina');
 assert.equal(classifyChestSorter({prefab:'NotWood',name:'Wood',metadata:{itemType:'Tool'}},rules).categoryId,'Tool');
});
test('food colors use strict game ratios, Eitr priority, balanced boundaries and non-food fallback',()=>{
 for(const [h,s,e,expected] of [[20,20,100,'Eitr'],[100,49,0,'Health'],[49,100,0,'Stamina'],[100,50,0,'Balanced'],[50,100,0,'Balanced'],[0,0,0,null]])assert.equal(chestSorterFoodColor({food:h,foodStamina:s,foodEitr:e},'Consumable'),expected);
 assert.equal(chestSorterFoodColor({},'Material'),null);assert.equal(category('Meal','Consumable',{food:0,foodStamina:0,foodEitr:0}),'Food');
});
test('missing prefab/type/food properties remain explicit; wildcard rules still work when sufficient',()=>{
 assert.equal(classifyChestSorter({prefab:'hash:123',metadata:{itemType:'Material'}},rules).reason,'missing-prefab');
 assert.equal(classifyChestSorter({prefab:'PineWood'},rules).categoryId,null);
 assert.equal(classifyChestSorter({prefab:'TestWood'},rules).categoryId,'Exact');
 assert.equal(classifyChestSorter(item('Meal','Consumable'),rules).reason,'missing-food-data');
 const scoped=parseChestSorterRules(text+'\noverride | Material | Unknown | Other\noverride | * | Unknown | Exact');
 assert.equal(classifyChestSorter({prefab:'Unknown'},scoped).categoryId,null);
});
test('future rules, malformed lines, unknown targets, control characters and huge inputs are rejected',()=>{
 for(const bad of [text.replace('version | 4','version | 5'),text+'\nbroken | value',text+'\nitemtype | Tool | Undefined',text+'\0','x'.repeat(256*1024+1)])assert.throws(()=>parseChestSorterRules(bad));
 try{parseChestSorterRules('version | 4\ninvalid');assert.fail();}catch(error){assert.equal(error.line,2);assert.equal(error.code,'RULE_SYNTAX');}
});
test('reader reloads current rules and preserves resource quantities, private files and timestamps',t=>{
 const f=fixture(t),resource={...item('PineWood'),id:'prefab:PineWood',quantity:240,minimum:200,containerIds:['a']},state={resources:[resource],stats:{totalItems:240}};
 const before=readFileSync(f.config),mtime=statSync(f.config).mtimeMs;
 let view=f.reader.view(state);assert.equal(view.chestSorter.status,'ready');assert.equal(view.resources[0].chestSorter.categoryId,'Wood');assert.equal(view.resources[0].quantity,240);
 assert.deepEqual(state.resources,[resource]);assert.deepEqual(readFileSync(f.config),before);assert.equal(statSync(f.config).mtimeMs,mtime);
 writeFileSync(f.config,text+'\noverride | * | PineWood | Other');view=f.reader.view(state);assert.equal(view.resources[0].chestSorter.categoryId,'Other');
 writeFileSync(f.config,text+'\nbroken');view=f.reader.view(state);assert.equal(view.chestSorter.status,'invalid');assert.equal(view.resources[0].chestSorter.categoryId,null);
 assert.equal(JSON.stringify(view).includes(f.game),false);
});
test('missing/removed file retains all items and never applies stale cached categories',t=>{
 const f=fixture(t),state={resources:[item('PineWood'),item('TestWood')]};assert.equal(f.reader.view(state).chestSorter.status,'ready');
 rmSync(f.config);const next=f.reader.view(state);assert.equal(next.chestSorter.status,'unavailable');assert.equal(next.resources.length,2);assert.ok(next.resources.every(r=>r.chestSorter.categoryId===null));
 assert.equal(new ChestSorterReader(()=>null).view(state).chestSorter.status,'unavailable');
});
test('symlink/junction in the rules path prevents file import',t=>{
 const f=fixture(t),outside=join(f.root,'outside');mkdirSync(outside);writeFileSync(join(outside,'ChestSorter.categories.txt'),text);
 rmSync(join(f.game,'BepInEx/config'),{recursive:true});
 try{symlinkSync(outside,join(f.game,'BepInEx/config'),'junction');}catch(error){if(error.code==='EPERM'){t.skip('junction unavailable');return;}throw error;}
 assert.equal(f.reader.view({resources:[]}).chestSorter.status,'invalid');
});
test('standalone server uses only its private desktop game preference',t=>{
 const f=fixture(t);assert.equal(configuredGameDirectory(f.root),null);writeFileSync(join(f.root,'desktop-game.json'),JSON.stringify({gameDirectory:f.game}));assert.equal(configuredGameDirectory(f.root),f.game);
 writeFileSync(join(f.root,'desktop-game.json'),'broken');assert.equal(configuredGameDirectory(f.root),null);
});
test('HTTP categories retain normal world/500m/zone/minimum semantics and isolate demo',async t=>{
 const f=fixture(t),token='b'.repeat(64),app=createApp({dataDir:join(f.root,'data'),port:0,token,intervals:false,gameDirectory:()=>f.game});
 const port=await app.listen(),base=`http://127.0.0.1:${port}`;f.close=()=>app.close();
 const post=(path,value)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-VRM-Token':token},body:JSON.stringify(value)});
 const packet={sourceId:'synthetic',sessionId:'session',sequence:1,worldId:'one',worldName:'Synthetic one',gameVersion:'synthetic',mode:'host',coverage:'partial',hostBed:{status:'set',x:0,y:0,z:0},destroyedIds:[],containers:[0,200,501].map((x,i)=>({id:'chest-'+i,name:'Synthetic',type:'chest',x,y:0,z:0,observedAt:new Date().toISOString(),items:[{prefab:'TestWood',name:'Test',quantity:(i+1)*10}]}))};
 assert.equal((await post('/api/ingest',packet)).status,200);assert.equal((await post('/api/ingest',{...packet,sourceId:'second',worldId:'two',worldName:'Synthetic two',containers:packet.containers.slice(0,1)})).status,200);
 for(const world of ['one','two']){const normal=await(await fetch(base+'/api/state?worldId='+world)).json(),view=await(await fetch(base+'/api/chestsorter?worldId='+world+'&file=ignored')).json();assert.deepEqual(view.stats,normal.stats);assert.deepEqual(view.containers,normal.containers);assert.equal(view.resources[0].quantity,normal.resources[0].quantity);assert.equal(view.resources[0].chestSorter.categoryId,'Exact');}
 const response=await post('/api/zones',{worldId:'one',name:'Small',x:0,z:0,radius:50,enabled:true}),zoned=await response.json(),zone=zoned.zones.find(z=>z.name==='Small');
 const selected=await(await fetch(base+'/api/chestsorter?worldId=one&zoneId='+zone.id)).json();assert.equal(selected.resources[0].quantity,10);
 assert.equal((await fetch(base+'/api/chestsorter',{headers:{Origin:'https://example.invalid'}})).status,403);
 assert.equal((await post('/api/chestsorter',{})).status,404);
 await post('/api/demo/start',{});const demo=await(await fetch(base+'/api/chestsorter?demo=1')).json();assert.equal(demo.demo,true);assert.notEqual(demo.world.id,'one');
 assert.deepEqual(readFileSync(f.config,'utf8'),text);
});

test('full catalog includes every registered definition without inventing stock, thresholds or unresolved definitions',t=>{
 const prefabs=Array.from({length:2048},(_,i)=>'Synthetic_'+i),f=catalogFixture(t,prefabs);
 f.ingest([{prefab:prefabs[0],name:'Stock',quantity:40,quality:2},{prefab:'UnknownModItem',name:'Unknown',quantity:5}]);f.store.defaultMinimum('one',200);
 const before=f.store.state(),view=f.view(),catalog=view.chestSorter.catalog;
 assert.deepEqual(view.stats,before.stats);assert.deepEqual(view.containers,before.containers);assert.deepEqual(view.minimums,before.minimums);
 assert.equal(view.resources.length,2);assert.equal(catalog.length,2049);assert.equal(new Set(catalog.map(i=>i.prefab)).size,2049);
 assert.equal(catalog.reduce((sum,i)=>sum+i.quantity,0),45);assert.equal(catalog.find(i=>i.prefab===prefabs[0]).variants[0].quality,2);
 for(const entry of catalog.filter(i=>i.catalogOnly)){assert.equal(entry.newToWorld,true);assert.equal(entry.status,'CATALOG');assert.equal(entry.minimum,0);assert.equal(entry.availableQuantity,null);assert.equal(entry.reservedQuantity,null);assert.deepEqual(entry.containerIds,[]);}
 assert.deepEqual(view.chestSorter.catalogSummary,{registered:2048,definitionsFound:2050,unresolvedDefinitions:2,totalItems:2049,newItems:2047,trackedItems:2});
 assert.equal(catalog.some(i=>i.prefab.includes('UNRESOLVED')),false);assert.equal(f.store.state().resources.length,2);
});

test('seen history survives consumption, destroyed chests and SQLite reopen; depleted tracked stock is not new',t=>{
 const f=catalogFixture(t,['Wood','Iron','Spoiler']);f.ingest([{prefab:'Wood',name:'Wood',quantity:40},{prefab:'Iron',name:'Iron',quantity:3}]);f.store.defaultMinimum('one',200);
 f.ingest([],{sequence:2});let view=f.view();assert.equal(view.chestSorter.catalog.find(i=>i.prefab==='Wood').newToWorld,false);assert.equal(view.resources.find(i=>i.prefab==='Wood').quantity,0);
 f.ingest([],{sequence:3,containers:[],destroyedIds:['test:1']});f.reopen();view=f.view();
 for(const prefab of ['Wood','Iron']){const entry=view.chestSorter.catalog.find(i=>i.prefab===prefab);assert.equal(entry.newToWorld,false);assert.equal(entry.catalogOnly,false);assert.equal(entry.minimum,200);}
 assert.equal(view.chestSorter.catalog.find(i=>i.prefab==='Spoiler').newToWorld,true);
});

test('history is isolated per world and survives zones, 500m exclusion, disabled minima and unset host bed',t=>{
 const f=catalogFixture(t,['Wood','Iron','Spoiler']);
 const far={id:'far',type:'chest',name:'Far',x:501,y:0,z:0,observedAt:Date.now(),items:[{prefab:'Iron',name:'Iron',quantity:3}]};
 f.ingest([],{containers:[...packet([{prefab:'Wood',name:'Wood',quantity:40}]).containers,far]});
 f.ingest([{prefab:'Spoiler',name:'Spoiler',quantity:1}],{worldId:'two',worldName:'Synthetic two'});f.store.defaultMinimum('one',200);f.store.minimum('one','Iron',0);
 for(const zoneId of ['all','main']){const view=f.view({worldId:'one',zoneId}),iron=view.chestSorter.catalog.find(i=>i.prefab==='Iron');assert.equal(iron.newToWorld,false);assert.equal(iron.catalogOnly,true);assert.equal(iron.availableQuantity,null);assert.equal(view.chestSorter.catalog.find(i=>i.prefab==='Spoiler').newToWorld,true);assert.equal(view.stats.totalItems,40);}
 const second=f.view({worldId:'two'});assert.equal(second.chestSorter.catalog.find(i=>i.prefab==='Wood').newToWorld,true);assert.equal(second.chestSorter.catalog.find(i=>i.prefab==='Spoiler').newToWorld,false);
 f.ingest([],{sequence:2,containers:[],hostBed:{status:'unset'}});const paused=f.view({worldId:'one'});assert.equal(paused.resources.length,0);assert.equal(paused.chestSorter.catalog.find(i=>i.prefab==='Wood').newToWorld,false);assert.equal(paused.chestSorter.catalog.find(i=>i.prefab==='Spoiler').newToWorld,true);
});

test('hash history resolves by exact canonical prefab after reindex without duplicates or false discoveries',t=>{
 const f=catalogFixture(t,[]),hash='hash:'+prefabHash('Wood');f.ingest([{prefab:hash,name:'Legacy',quantity:40}]);f.ingest([],{sequence:2});
 f.registry.publish(manifest(['Wood','Unseen'].map(definition)));const view=f.view();assert.equal(view.resources.length,0);assert.deepEqual([...f.store.observedPrefabs('one')],['Wood']);
 assert.equal(view.chestSorter.catalog.length,2);assert.equal(view.chestSorter.catalog.find(i=>i.prefab==='Wood').newToWorld,false);assert.equal(view.chestSorter.catalog.find(i=>i.prefab==='Unseen').newToWorld,true);assert.equal(view.chestSorter.catalog.some(i=>i.prefab===hash),false);
});

test('ambiguous hash history does not mark either colliding definition as discovered and retains unknown history',t=>{
 const a='Mod_pwnzjm_f9u',b='Mod_-cynz70_fh0',f=catalogFixture(t,[a,b]),hash='hash:'+prefabHash(a);assert.equal(prefabHash(a),prefabHash(b));
 f.ingest([{prefab:hash,name:'Unknown collision',quantity:2}]);f.ingest([],{sequence:2});const view=f.view();
 assert.equal(view.chestSorter.catalog.length,3);assert.equal(view.chestSorter.catalog.find(i=>i.prefab===hash).newToWorld,false);assert.equal(view.chestSorter.catalog.find(i=>i.prefab===a).newToWorld,true);assert.equal(view.chestSorter.catalog.find(i=>i.prefab===b).newToWorld,true);
});

test('catalog remains available without rules or world and never manufactures character progress',t=>{
 const f=catalogFixture(t,['Wood','Spoiler']);let view=f.view();assert.equal(view.world,null);assert.equal(view.chestSorter.catalog.length,2);assert.ok(view.chestSorter.catalog.every(i=>!i.newToWorld));assert.equal(view.chestSorter.catalogSummary.trackedItems,null);
 f.ingest([{prefab:'Wood',name:'Wood',quantity:1}]);rmSync(f.config);view=f.view();assert.equal(view.chestSorter.status,'unavailable');assert.equal(view.chestSorter.catalog.length,2);assert.ok(view.chestSorter.catalog.every(i=>i.chestSorter.categoryId===null));assert.equal(view.chestSorter.catalog.find(i=>i.prefab==='Spoiler').newToWorld,true);
});

test('HTTP full-catalog reads do not mutate inventory, history, thresholds or revision and isolate DEMO progress',async t=>{
 const f=fixture(t),app=createApp({dataDir:join(f.root,'data'),port:0,token:'c'.repeat(64),intervals:false,gameDirectory:()=>f.game});f.close=()=>app.close();app.registry.publish(manifest(['Wood','Spoiler'].map(definition)));
 app.real.ingest(validateIngest(packet([{prefab:'Wood',name:'Wood',quantity:40}])));app.real.defaultMinimum('one',200);const base=`http://127.0.0.1:${await app.listen()}`;
 const database=()=>['containers','minimums','observed_items','events'].map(table=>app.real.db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all());
 const before=app.real.state(),rows=database();for(let i=0;i<3;i++){const view=await(await fetch(base+'/api/chestsorter?worldId=one')).json();assert.equal(view.chestSorter.catalog.length,2);assert.equal(view.chestSorter.catalog.find(i=>i.prefab==='Spoiler').newToWorld,true);assert.deepEqual(view.stats,before.stats);assert.equal(view.resources.length,1);}
 assert.deepEqual(app.real.state(),before);assert.deepEqual(database(),rows);assert.equal((await(await fetch(base+'/api/state?worldId=one')).json()).chestSorter,undefined);
 app.demo.startDemo();const demo=await(await fetch(base+'/api/chestsorter?demo=1')).json();assert.equal(demo.demo,true);assert.equal(demo.chestSorter.catalog.find(i=>i.prefab==='Spoiler').newToWorld,true);assert.equal(app.real.revision,before.revision);assert.deepEqual(database(),rows);
});
