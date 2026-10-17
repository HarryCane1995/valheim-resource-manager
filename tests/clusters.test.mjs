import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source=readFileSync(new URL('../src/clusters.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
const {clusterGroups,clusterSummaries,summarizeResources,clusterKey,categoryKey,legacyCategoryKey,groupIsOpen,toggleCollapsedGroup,visibleClusterResources,isCompactGroupPreferences,compactGroupsKey,defaultGroupPreferences}=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const taxonomy=[
 {id:'construction',name:'Строительство',system:true,categories:[{id:'wood',name:'Древесина'},{id:'stone',name:'Камень'}]},
 {id:'metallurgy',name:'Металлургия',system:true,categories:[{id:'ore',name:'Руды'},{id:'metal',name:'Металлы'}]},
 {id:'unclassified',name:'Неразобранное',system:true,categories:[{id:'unknown',name:'Неопознанные предметы'}]}
];
const resource=(overrides={})=>({id:'prefab:Wood',prefab:'Wood',name:'Древесина',category:'Древесина и растения',clusterId:'construction',clusterName:'Строительство',clusterCategoryId:'wood',clusterCategory:'Древесина',quantity:40,minimum:0,status:'LIVE',containerIds:['north','south'],...overrides});
const wood=resource(),stone=resource({id:'prefab:Stone',prefab:'Stone',name:'Камень',clusterCategoryId:'stone',clusterCategory:'Камень',quantity:100,containerIds:['south']}),iron=resource({id:'prefab:Iron',prefab:'Iron',name:'Железо',clusterId:'metallurgy',clusterName:'Металлургия',clusterCategoryId:'metal',clusterCategory:'Металлы',quantity:3,minimum:10,containerIds:['forge']});

test('hierarchy partitions every resource into exactly one cluster and category',()=>{
 const input=[wood,iron,stone];
 const groups=clusterGroups(input,taxonomy);
 const flattened=groups.flatMap(group=>group.categories.flatMap(category=>category.items));
 assert.equal(flattened.length,input.length);
 assert.equal(new Set(flattened.map(item=>item.id)).size,input.length);
 assert.deepEqual(new Set(flattened.map(item=>item.id)),new Set(input.map(item=>item.id)));
 assert.deepEqual(groups.map(group=>group.id),['construction','metallurgy','unclassified']);
 assert.deepEqual(groups[0].categories.map(category=>category.id),['wood','stone']);
 assert.deepEqual(input,[wood,iron,stone]);
});
test('regrouping retains aggregate quantities and category subtotals',()=>{
 const groups=clusterGroups([wood,stone,iron],taxonomy);
 assert.equal(groups.reduce((sum,group)=>sum+group.summary.totalItems,0),143);
 for(const group of groups)assert.equal(group.categories.reduce((sum,category)=>sum+category.summary.totalItems,0),group.summary.totalItems);
 assert.equal(groups[0].summary.uniqueItems,2);
 assert.equal(groups[1].summary.shortages,1);
});
test('cluster chest counts use the union instead of summing per-item counts',()=>{
 const repeated=resource({...stone,containerIds:['south','south']});
 const summary=summarizeResources([wood,repeated]);
 assert.equal(summary.containers,2);
 assert.equal(summary.totalItems,140);
 assert.equal(clusterGroups([wood,repeated],taxonomy)[0].summary.containers,2);
});
test('shared NORMAL summary and COMPACT hierarchy return identical filtered totals',()=>{
 const filtered=[wood,iron]; // Backend supplies only the chosen world and zone.
 const normal=clusterSummaries(filtered,taxonomy);
 const compact=clusterGroups(filtered,taxonomy);
 assert.deepEqual(normal.map(({id,totalItems,uniqueItems,containers,shortages})=>({id,totalItems,uniqueItems,containers,shortages})),compact.map(({id,summary})=>({id,...Object.fromEntries(['totalItems','uniqueItems','containers','shortages'].map(key=>[key,summary[key]]))})));
 assert.equal(summarizeResources(filtered).totalItems,43);
 assert.equal(compact.reduce((sum,group)=>sum+group.summary.totalItems,0),43);
});
test('mixed source summaries never label the aggregate LIVE',()=>{
 const snapshot=resource({...stone,status:'SNAPSHOT'}),offline=resource({...iron,status:'OFFLINE'});
 const summary=summarizeResources([wood,snapshot,offline]);
 assert.equal(summary.status,'MIXED');
 assert.deepEqual(summary.statusCounts,{LIVE:1,SNAPSHOT:1,OFFLINE:1});
 assert.equal(summarizeResources([wood,stone]).status,'LIVE');
 assert.equal(summarizeResources([snapshot]).status,'SNAPSHOT');
 assert.equal(summarizeResources([resource({status:'STALE'})]).status,'STALE');
});
test('per-resource mixed source counts retain their separate states',()=>{
 const summary=summarizeResources([resource({status:'STALE',statusCounts:{LIVE:2,STALE:1,SNAPSHOT:3}})]);
 assert.equal(summary.status,'MIXED');
 assert.deepEqual(summary.statusCounts,{LIVE:2,STALE:1,SNAPSHOT:3});
 assert.equal(summary.totalItems,40);
});
test('source status chest counts are deduplicated across resources and retain MIXED',()=>{
 const first=resource({status:'STALE',statusCounts:{LIVE:1,STALE:1},statusContainerIds:{LIVE:['north'],STALE:['south']}});
 const second=resource({...stone,status:'STALE',statusCounts:{STALE:1},statusContainerIds:{STALE:['south']}});
 const summary=summarizeResources([first,second]);
 assert.equal(summary.status,'MIXED');
 assert.deepEqual(summary.statusCounts,{LIVE:1,STALE:1});
 assert.equal(summary.containers,2);
 assert.equal(summary.totalItems,140);
});
test('empty and invalid source states stay explicit without fabricated LIVE values',()=>{
 assert.deepEqual(summarizeResources([]),{uniqueItems:0,totalItems:0,containers:0,shortages:0,status:'UNKNOWN',statusCounts:{}});
 assert.equal(summarizeResources([resource({status:'unexpected'})]).status,'UNKNOWN');
 assert.equal(summarizeResources([resource({statusCounts:{LIVE:NaN,SNAPSHOT:-1}})]).status,'LIVE');
});
test('unknown items and future mod clusters remain accessible',()=>{
 const unknown=resource({id:'prefab:hash:42',prefab:'hash:42',clusterId:undefined,clusterName:undefined,clusterCategoryId:undefined,clusterCategory:undefined,diagnostics:['UNKNOWN ITEM'],quantity:0});
 const mod=resource({id:'prefab:ModOre',prefab:'ModOre',clusterId:'mod-ore',clusterName:'Материалы мода',clusterCategoryId:'new',clusterCategory:'Новый материал',quantity:7});
 const groups=clusterGroups([unknown,mod],taxonomy);
 assert.equal(groups.find(group=>group.id==='unclassified').categories.find(category=>category.id==='unknown').items[0],unknown);
 assert.equal(groups.find(group=>group.id==='mod-ore').name,'Материалы мода');
 assert.equal(groups.flatMap(group=>group.items).length,2);
 assert.equal(groups.reduce((sum,group)=>sum+group.summary.totalItems,0),7);
});
test('custom cluster assignment uses stable IDs independently of display names',()=>{
 const custom={id:'custom-1',name:'Первое имя',system:false,categories:[{id:'items',name:'Предметы'}]};
 const assigned=resource({clusterId:custom.id,clusterCategoryId:'items'});
 assert.equal(clusterGroups([assigned],[custom])[0].items[0].prefab,'Wood');
 const renamed=clusterGroups([assigned],[{...custom,name:'Новое имя'}])[0];
 assert.equal(renamed.name,'Новое имя');
 assert.equal(renamed.items[0].id,'prefab:Wood');
 assert.equal(renamed.summary.totalItems,40);
});
test('both collapsed hierarchy levels hide rows without deleting resources',()=>{
 const groups=clusterGroups([wood,stone,iron],taxonomy);
 assert.equal(visibleClusterResources(groups,[]).length,3);
 assert.deepEqual(visibleClusterResources(groups,[clusterKey('construction')]).map(item=>item.prefab),['Iron']);
 assert.deepEqual(visibleClusterResources(groups,[categoryKey('construction','wood')]).map(item=>item.prefab),['Stone','Iron']);
 assert.equal(groups[0].summary.totalItems,140);
});
test('global search temporarily opens every ancestor and leaves saved collapse unchanged',()=>{
 const collapsed=[clusterKey('metallurgy'),categoryKey('metallurgy','metal')];
 const original=[...collapsed];
 const groups=clusterGroups([iron],taxonomy); // Search filtering takes place before grouping.
 assert.equal(visibleClusterResources(groups,collapsed).length,0);
 assert.deepEqual(visibleClusterResources(groups,collapsed,'железо').map(item=>item.prefab),['Iron']);
 assert.deepEqual(collapsed,original);
 assert.equal(visibleClusterResources(groups,collapsed,' ').length,0);
 assert.equal(groupIsOpen(clusterKey('metallurgy'),collapsed,'Iron'),true);
});
test('collision-safe hierarchy keys keep custom IDs and categories independent',()=>{
 assert.notEqual(categoryKey('a:b','c'),categoryKey('a','b:c'));
 assert.notEqual(clusterKey('Категория'),legacyCategoryKey('Категория'));
 assert.notEqual(categoryKey('a','items'),categoryKey('b','items'));
 const saved=[clusterKey('construction')];
 assert.deepEqual(toggleCollapsedGroup(saved,clusterKey('construction')),[]);
 assert.deepEqual(saved,[clusterKey('construction')]);
 assert.deepEqual(toggleCollapsedGroup(saved,categoryKey('construction','wood')),[...saved,categoryKey('construction','wood')]);
});
test('versioned grouping preferences validate persisted mode and collapse states',()=>{
 assert.equal(compactGroupsKey,'vrm.compactGroups.v1');
 assert.deepEqual(defaultGroupPreferences,{version:1,mode:'clusters',collapsed:[]});
 const saved=JSON.parse(JSON.stringify({version:1,mode:'categories',collapsed:[clusterKey('construction'),categoryKey('construction','wood')]}));
 assert.equal(isCompactGroupPreferences(saved),true);
 for(const invalid of [null,{},[],{version:2,mode:'clusters',collapsed:[]},{version:1,mode:'flat',collapsed:[]},{version:1,mode:'clusters',collapsed:[42]}])assert.equal(isCompactGroupPreferences(invalid),false);
});
test('new live state updates the affected cluster while preserving other cluster totals',()=>{
 const before=clusterSummaries([wood,stone,iron],taxonomy);
 const after=clusterSummaries([resource({quantity:80}),stone,iron],taxonomy);
 assert.equal(after.find(group=>group.id==='construction').totalItems-before.find(group=>group.id==='construction').totalItems,40);
 assert.deepEqual(after.find(group=>group.id==='metallurgy'),before.find(group=>group.id==='metallurgy'));
 assert.equal(after.reduce((sum,group)=>sum+group.totalItems,0),183);
 assert.equal(wood.quantity,40);
});
test('a new registry resource with missing classification falls back visibly once',()=>{
 const future=resource({id:'prefab:Future',prefab:'Future',clusterId:undefined,clusterName:undefined,clusterCategoryId:undefined,clusterCategory:undefined,quantity:12});
 const groups=clusterGroups([future],taxonomy);
 const group=groups.find(group=>group.id==='unclassified');
 assert.equal(group.items.length,1);
 assert.equal(group.categories.find(category=>category.id==='other').items[0].prefab,'Future');
 assert.equal(group.summary.totalItems,12);
});
