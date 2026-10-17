import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { parseChestSorterRules, classifyChestSorter, chestSorterFoodColor, ChestSorterReader, configuredGameDirectory } from './chestsorter.mjs';
import { createApp } from './main.mjs';

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
