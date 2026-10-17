import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Execute the same frontend helpers through the project's existing TypeScript compiler.
// No duplicated search, sorting, grouping, identity or preference implementation lives here.
const source=readFileSync(new URL('../src/catalog.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
const {itemCategories,itemKey,sameItem,itemMatches,resourceZones,resourceAvailable,resourceReserved,groupResources,sortResources,readPreference,savePreference}=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

const resource=(overrides={})=>({id:'prefab:Wood',prefab:'Wood',prefabHash:357827036,name:'Древесина',nameRu:'Древесина',nameEn:'Wood',category:'Древесина и растения',quantity:40,minimum:60,status:'SNAPSHOT',containerIds:['north','south'],availableQuantity:40,reservedQuantity:0,reservationsImplemented:false,...overrides});
const wood=resource(),stone=resource({id:'prefab:Stone',prefab:'Stone',name:'Камень',nameRu:'Камень',nameEn:'Stone',category:'Камень и минералы',quantity:100,minimum:0,containerIds:['south'],availableQuantity:100});
const state={containers:[{id:'north',zoneIds:['base']},{id:'south',zoneIds:['base','harbor']},{id:'unrelated',zoneIds:['other']}],zones:[{id:'base',name:'Главная база'},{id:'harbor',name:'Пристань'},{id:'other',name:'Чужая зона'}]};

test('Russian search is case insensitive and ignores outer spaces',()=>{
 assert.equal(itemMatches(wood,' ДРЕВЕСИНА '),true);
 assert.equal(itemMatches(wood,'Камень'),false);
});
test('English search uses the English localized name independently of Russian display',()=>{
 assert.equal(itemMatches(resource({prefab:'FineWood',name:'Тонкая древесина',nameEn:'Fine wood'}),'fine WOOD'),true);
 assert.equal(itemMatches(wood,'Stone'),false);
});
test('prefab and stable internal ID are independently searchable',()=>{
 const item=resource({prefab:'ModFineWood',id:'prefab:ModFineWood',name:'Материал',nameRu:'Материал',nameEn:'Material'});
 assert.equal(itemMatches(item,'ModFineWood'),true);
 assert.equal(itemMatches(item,'prefab:modfinewood'),true);
});
test('raw snapshot hashes and backend aliases remain searchable after resolution',()=>{
 assert.equal(itemMatches(wood,'357827036'),true);
 assert.equal(itemMatches(resource({searchText:'Wood prefab:Wood hash:-12345'}),'hash:-12345'),true);
 assert.equal(itemMatches(resource({prefabHash:0}),'0'),true);
});
test('empty search preserves zero quantity and unknown items',()=>{
 const items=[wood,resource({id:'prefab:hash:42',prefab:'hash:42',name:'Неизвестный предмет',quantity:0,diagnostics:['UNKNOWN ITEM']})];
 assert.equal(items.filter(item=>itemMatches(item,' ')).length,2);
});
test('cluster names, hierarchical categories and mod tags are searchable globally',()=>{
 const item=resource({clusterName:'Металлургия',clusterCategory:'Обработанные металлы и сплавы',tags:['modded','Сплав']});
 assert.equal(itemMatches(item,'МЕТАЛЛУРГИЯ'),true);
 assert.equal(itemMatches(item,'обработанные металлы'),true);
 assert.equal(itemMatches(item,'modded'),true);
 assert.equal(itemMatches(item,'несуществующий тег'),false);
});
test('stable IDs keep same-name mod and vanilla definitions separate',()=>{
 const mod=resource({id:'prefab:ModWood',prefab:'ModWood',name:wood.name});
 assert.notEqual(itemKey(wood),itemKey(mod));
 assert.equal(sameItem(wood,mod),false);
 assert.equal(new Set([wood,mod].map(itemKey)).size,2);
});
test('unknown hashes keep separate identities without fabricated localization',()=>{
 const first=resource({id:'prefab:hash:11',prefab:'hash:11',name:'UNKNOWN ITEM',nameRu:null,nameEn:null,category:'Неопознанные'});
 const second=resource({...first,id:'prefab:hash:12',prefab:'hash:12'});
 assert.notEqual(itemKey(first),itemKey(second));
 assert.equal(itemMatches(first,'hash:11'),true);
 assert.equal(itemMatches(first,'hash:12'),false);
});
test('legacy prefab-only container rows match canonical items but conflicting IDs do not',()=>{
 assert.equal(itemKey({prefab:'Wood'}),'Wood');
 assert.equal(sameItem(wood,{prefab:'Wood'}),true);
 assert.equal(sameItem(wood,{id:'prefab:ModWood',prefab:'Wood'}),false);
});
test('quantity sorting is numeric, reversible, and does not mutate backend order',()=>{
 const original=[wood,stone,resource({id:'prefab:Zero',prefab:'Zero',quantity:0})];
 assert.deepEqual(sortResources(original,'quantity','desc',state).map(r=>r.quantity),[100,40,0]);
 assert.deepEqual(sortResources(original,'quantity','asc',state).map(r=>r.quantity),[0,40,100]);
 assert.deepEqual(original.map(r=>r.quantity),[40,100,0]);
});
test('Russian name sorting and stable ID tie-breaker prevent update jitter',()=>{
 assert.deepEqual(sortResources([stone,wood],'name','asc',state).map(r=>r.prefab),['Wood','Stone']);
 const a=resource({id:'prefab:A',prefab:'A'}),b=resource({id:'prefab:B',prefab:'B'});
 assert.deepEqual(sortResources([b,a],'quantity','desc',state).map(itemKey),['prefab:A','prefab:B']);
 assert.deepEqual(sortResources([a,b],'quantity','desc',state).map(itemKey),['prefab:A','prefab:B']);
});
test('shortage sorting uses the actual minimum and aggregate quantity',()=>{
 const small=resource({id:'prefab:Small',prefab:'Small',quantity:1,minimum:3});
 assert.deepEqual(sortResources([stone,small,wood],'shortage','desc',state).map(r=>r.prefab),['Wood','Small','Stone']);
});
test('container counts and zone labels use only this resource containers',()=>{
 assert.equal(resourceZones(wood,state),'Главная база, Пристань');
 assert.equal(resourceZones(resource({containerIds:[]}),state),'Вне зон');
 assert.equal(resourceZones(wood,state).includes('Чужая зона'),false);
 assert.deepEqual(sortResources([stone,wood],'containers','desc',state).map(r=>r.prefab),['Wood','Stone']);
});
test('availability distinguishes confirmed zero from missing values',()=>{
 assert.equal(resourceAvailable(resource({availableQuantity:0})),0);
 assert.equal(resourceAvailable(resource({availableQuantity:undefined})),null);
 assert.equal(resourceAvailable(resource({availableQuantity:null})),null);
 assert.equal(resourceAvailable(resource({availableQuantity:NaN})),null);
 assert.deepEqual(sortResources([resource({id:'missing',availableQuantity:null}),resource({id:'zero',availableQuantity:0})],'available','desc',state).map(itemKey),['zero','missing']);
});
test('unimplemented reservations never become an invented zero',()=>{
 assert.equal(resourceReserved(wood),null);
 assert.equal(resourceReserved(resource({reservationsImplemented:false,reservedQuantity:42})),null);
 assert.equal(resourceReserved(resource({reservationsImplemented:true,reservedQuantity:0})),0);
 assert.equal(resourceReserved(resource({reservationsImplemented:true,reservedQuantity:12})),12);
 assert.equal(resourceReserved(resource({reservationsImplemented:true,reservedQuantity:undefined})),null);
});
test('reservation sorting uses only provided implemented values',()=>{
 const missing=resource({id:'missing'}),zero=resource({id:'zero',reservationsImplemented:true,reservedQuantity:0}),reserved=resource({id:'reserved',reservationsImplemented:true,reservedQuantity:10});
 assert.deepEqual(sortResources([missing,zero,reserved],'reserved','desc',state).map(itemKey),['reserved','zero','missing']);
});
test('category grouping preserves quantities, identities and intra-group sort order',()=>{
 const secondWood=resource({id:'prefab:FineWood',prefab:'FineWood',quantity:3});
 const items=[stone,secondWood,wood];
 const groups=groupResources(items,true);
 assert.deepEqual(groups.map(g=>g.category),['Древесина и растения','Камень и минералы']);
 assert.deepEqual(groups[0].items.map(r=>r.prefab),['FineWood','Wood']);
 assert.equal(groups.flatMap(g=>g.items).reduce((sum,r)=>sum+r.quantity,0),143);
 assert.equal(new Set(groups.flatMap(g=>g.items).map(itemKey)).size,3);
 assert.deepEqual(items.map(r=>r.prefab),['Stone','FineWood','Wood']);
});
test('unknown and future mod categories are retained in separate groups',()=>{
 const unknown=resource({id:'hash:1',prefab:'hash:1',category:'Неопознанные',diagnostics:['UNKNOWN ITEM']});
 const mod=resource({id:'mod:1',prefab:'ModItem',category:'Материалы мода'});
 const groups=groupResources([mod,unknown,wood],true);
 assert.deepEqual(groups.map(g=>g.category),['Древесина и растения','Неопознанные','Материалы мода']);
 assert.equal(groups.flatMap(g=>g.items).length,3);
 assert.equal(itemCategories.length,19); // 18 required categories + explicit unknowns.
});
test('ungrouped layout retains exact resource order, including empty lists',()=>{
 assert.deepEqual(groupResources([stone,wood],false),[{category:'',items:[stone,wood]}]);
 assert.deepEqual(groupResources([],true),[]);
 assert.deepEqual(groupResources([],false),[{category:'',items:[]}]);
});

function withStorage(storage,callback){
 const previous=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:storage});
 try{return callback();}finally{if(previous)Object.defineProperty(globalThis,'localStorage',previous);else delete globalThis.localStorage;}
}
test('display mode preference survives a save/read cycle',()=>{
 const memory=new Map();
 withStorage({getItem:key=>memory.get(key)||null,setItem:(key,value)=>memory.set(key,value)},()=>{
  const valid=value=>value==='normal'||value==='compact';
  assert.equal(readPreference('vrm.displayMode','normal',valid),'normal');
  savePreference('vrm.displayMode','compact');
  assert.equal(readPreference('vrm.displayMode','normal',valid),'compact');
  savePreference('vrm.displayMode','normal');
  assert.equal(readPreference('vrm.displayMode','compact',valid),'normal');
 });
});
test('damaged preferences and disabled browser storage leave the panel usable',()=>{
 withStorage({getItem:()=>'{bad-json',setItem:()=>{throw Error('storage disabled');}},()=>{
  assert.equal(readPreference('vrm.displayMode','normal',value=>value==='compact'),'normal');
  assert.doesNotThrow(()=>savePreference('vrm.displayMode','compact'));
 });
 withStorage({getItem:()=>{throw Error('storage disabled');}},()=>assert.equal(readPreference('key',32,value=>typeof value==='number'),32));
 withStorage({getItem:()=>JSON.stringify('unexpected-mode')},()=>assert.equal(readPreference('key','normal',value=>value==='compact'),'normal'));
});
