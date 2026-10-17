import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { classifyItem,SYSTEM_CLUSTERS,summarizeClusters } from './clusters.mjs';
import { ItemRegistry,prefabHash } from './registry.mjs';
import { InventoryStore } from './store.mjs';
import { createApp } from './main.mjs';

const NOW=1_790_000_000_000;
const definition=(prefab,metadata={},fields={})=>({id:'prefab:'+prefab,prefab,prefabHash:prefabHash(prefab),nameRu:'Тест '+prefab,nameEn:'Test '+prefab,maxStack:50,metadata,...fields});
const manifest=items=>({schemaVersion:1,gameVersion:'synthetic-cluster-test',source:{kind:'installed-assets'},generatedAt:new Date(NOW).toISOString(),coverage:{definitionsFound:items.length},items});
const stack=(prefab,quantity)=>({prefab,name:prefab,quantity});
const chest=(id,items,x=0)=>({id,type:'chest',name:'SYNTHETIC',x,y:0,z:0,items,observedAt:NOW});
const packet=(containers,fields={})=>({sourceId:'test',worldId:'world-a',worldName:'SYNTHETIC A',sessionId:'session-a',sequence:1,mode:'snapshot',coverage:'partial',gameVersion:'synthetic',containers,destroyedIds:[],...fields});
function fixture(t) {const directory=mkdtempSync(join(tmpdir(),'vrm-clusters-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));return {directory,registry:new ItemRegistry(directory)};}

test('one primary cluster/category for every definition, including all ItemTypes and an equally sized synthetic 1519-item catalog',t=> {
  const {registry}=fixture(t),types=['Material','Consumable','OneHandedWeapon','Bow','Shield','Helmet','Chest','Ammo','Customization','Legs','Hands','Trophy','TwoHandedWeapon','Torch','Misc','Shoulder','Utility','Tool','Attach_Atgeir','Fish','TwoHandedWeaponLeft','AmmoNonEquipable','Trinket'];
  registry.publish(manifest(Array.from({length:1519},(_,i)=>definition('Synthetic_'+i,{itemTypeName:types[i%types.length]}))));
  assert.equal(registry.entries.size,1519);assert.equal(SYSTEM_CLUSTERS.length,9);
  for(const item of registry.entries.values()) {const matches=registry.clusters.filter(cluster=>cluster.id===item.clusterId);assert.equal(matches.length,1);assert.equal(matches[0].categories.filter(category=>category.id===item.clusterCategoryId).length,1);assert.ok(Array.isArray(item.tags));}
  assert.equal(registry.summary().classifiedItems+registry.summary().unclassifiedItems,1519);
});
test('reliable function metadata beats misleading Ore/Armor/Seed names; exact materials and legacy manual overrides retain their priority',()=> {
  const c=(prefab,metadata,override,category)=>classifyItem({prefab,metadata,category},override);
  assert.equal(c('CopperOre',{itemTypeName:'OneHandedWeapon'}).clusterId,'equipment');
  assert.equal(c('Iron',{itemType:19}).clusterCategoryId,'tools');
  assert.equal(c('Barley',{questItem:true}).clusterCategoryId,'quest');
  assert.equal(c('StoneArmorOre',{itemTypeName:'Helmet'}).clusterCategoryId,'armor');
  assert.equal(c('Coins',{itemTypeName:'Fish'}).clusterId,'food');
  assert.equal(c('Iron',{itemTypeName:'Material'}).clusterCategoryId,'metals');
  assert.equal(c('Coal',{itemTypeName:'Material'}).clusterCategoryId,'processing');
  const carrot=c('Carrot',{itemTypeName:'Consumable',foodHealth:10,foodStamina:32});assert.equal(carrot.clusterId,'agriculture');assert.equal(carrot.clusterCategoryId,'crops');assert.ok(carrot.tags.includes('съедобное'));
  assert.equal(c('Carrot',{itemTypeName:'OneHandedWeapon'}).clusterId,'equipment');
  assert.equal(c('Iron',{itemTypeName:'OneHandedWeapon'},{category:'Сельское хозяйство'}).clusterId,'agriculture');
  assert.equal(c('Iron',{itemTypeName:'OneHandedWeapon'},{category:'Сельское хозяйство'}).classificationSource,'manual');
  assert.equal(c('ArmorGoldHeavyChestUncooked',{itemTypeName:'Material'},undefined,'Броня').clusterCategoryId,'processing');
});
test('audited previous unresolved families gain justified categories while untranslated upgrading definitions remain ambiguous',()=> {
  const expected={Hair1:['equipment','appearance'],AskBladder:['loot','materials'],Acorn:['agriculture','seeds'],BarrelRings:['construction','components'],DyrnwynBladeFragment:['valuables','quest'],SpiceAshlands:['food','ingredients'],MeadBaseHealthMinor:['alchemy','potions'],MoldSword:['metallurgy','processing']};
  for(const [prefab,[cluster,category]] of Object.entries(expected)) {const item=classifyItem({prefab,category:'Прочее',metadata:{itemTypeName:prefab==='Hair1'?'Customization':'Material'}});assert.equal(item.clusterId,cluster,prefab);assert.equal(item.clusterCategoryId,category,prefab);}
  for(const prefab of ['Upgrader2Armor','Upgrader4Weapon','GenericMoldUncooked','LastBossGate_RuneTile'])assert.equal(classifyItem({prefab,category:'Броня',metadata:{itemTypeName:'Material'}}).clusterId,'unclassified');
});
test('new mod definitions receive native ItemType or a bounded fallback; opaque unknown hashes never disappear',t=> {
  const {registry}=fixture(t);registry.publish(manifest([definition('OpaqueModWeapon',{itemType:3}),definition('OpaqueUnclearMaterial',{itemType:1}),definition('BrandNewOre',{itemType:1})]));
  assert.equal(registry.resolve('OpaqueModWeapon').clusterId,'equipment');assert.equal(registry.resolve('OpaqueUnclearMaterial').clusterId,'unclassified');
  assert.equal(registry.resolve('BrandNewOre').clusterId,'metallurgy');assert.equal(registry.resolve('BrandNewOre').clusterCategoryId,'ores');
  const unknown=registry.describe({prefab:'hash:-12345',name:'Unknown',quantity:7});assert.equal(unknown.clusterId,'unclassified');assert.equal(unknown.clusterCategoryId,'unknown');assert.equal(unknown.quantity,7);assert.ok(unknown.diagnostics.includes('UNKNOWN ITEM'));
  assert.equal(classifyItem({prefab:'SeedlingUnknownSuffix',metadata:{}}).clusterId,'unclassified');
});
test('known definition without translations shows its exact prefab instead of obsolete raw unknown hash labels',t=> {
  const {registry}=fixture(t);registry.publish(manifest([definition('Upgrader2Armor',{itemTypeName:'Material'},{nameRu:'',nameEn:''})]));
  const token='hash:'+prefabHash('Upgrader2Armor'),item=registry.describe({prefab:token,name:'Unidentified snapshot item',quantity:9});
  assert.equal(item.name,'Upgrader2Armor');assert.equal(item.nameRu,'Upgrader2Armor');assert.equal(item.nameEn,'Upgrader2Armor');assert.deepEqual(item.sourceIds,[token]);assert.equal(item.quantity,9);assert.equal(item.registryKnown,true);assert.equal(item.clusterId,'unclassified');assert.ok(item.searchText.includes(token));
});
test('manual overrides persist for registered and unknown exact IDs across reopen and catalog reindex without rewriting manifest',t=> {
  const {registry,directory}=fixture(t);registry.publish(manifest([definition('Wood',{itemTypeName:'Material'})]));
  const before=readFileSync(registry.file,'utf8');registry.override({prefab:'Wood',clusterId:'valuables',clusterCategoryId:'special'});registry.override({prefab:'Mod_Unknown',clusterId:'construction',clusterCategoryId:'components'});
  assert.equal(readFileSync(registry.file,'utf8'),before);
  const reopened=new ItemRegistry(directory);assert.equal(reopened.resolve('Wood').classificationSource,'manual');assert.equal(reopened.describe({prefab:'Mod_Unknown',name:'X'}).clusterId,'construction');
  reopened.publish(manifest([definition('Wood',{itemTypeName:'Tool'},{nameRu:'Переименовано'}),definition('Mod_Unknown',{itemTypeName:'Trophy'}),definition('NewShield',{itemTypeName:'Shield'})]));
  assert.equal(reopened.resolve('Wood').clusterId,'valuables');assert.equal(reopened.resolve('Mod_Unknown').clusterId,'construction');assert.equal(reopened.resolve('NewShield').clusterId,'equipment');
  reopened.override({prefab:'Wood',reset:true});assert.equal(reopened.resolve('Wood').clusterCategoryId,'tools');assert.equal(reopened.resolve('Wood').classificationSource,'metadata');
});
test('unique raw hash override follows its newly known prefab; canonical reset removes aliases and legacy fields without prototype collisions',t=> {
  const {registry}=fixture(t),alias='hash:'+prefabHash('Wood');registry.override({prefab:alias,clusterId:'loot',clusterCategoryId:'bones'});
  registry.publish(manifest([definition('Wood'),definition('__proto__')]));assert.equal(registry.resolve('Wood').clusterId,'loot');
  registry.override({prefab:alias,category:'Ценные предметы'});assert.equal(registry.resolve('Wood').clusterId,'valuables');assert.equal(registry.resolve('Wood').category,'Ценные предметы');
  registry.override({prefab:'Wood',reset:true});assert.equal(registry.resolve('Wood').clusterId,'construction');assert.equal(registry.resolve('Wood').category,'Древесина и растения');assert.equal(Object.hasOwn(registry.overrides,alias),false);
  registry.override({prefab:'__proto__',clusterId:'equipment',clusterCategoryId:'tools'});assert.equal(registry.resolve('__proto__').clusterCategoryId,'tools');assert.equal(Object.prototype.clusterId,undefined);
});
test('custom clusters persist, rename their existing assignments, reject invalid categories and protect every system cluster',t=> {
  const {registry,directory}=fixture(t),custom=registry.createCluster({name:'Мой проект'});registry.override({prefab:'UnknownModItem',clusterId:custom.id,clusterCategoryId:'items'});
  assert.equal(new ItemRegistry(directory).describe({prefab:'UnknownModItem'}).clusterName,'Мой проект');
  registry.renameCluster(custom.id,{name:'Новый проект'});assert.equal(registry.describe({prefab:'UnknownModItem'}).clusterName,'Новый проект');assert.equal(registry.describe({prefab:'UnknownModItem'}).classificationSource,'manual');
  assert.throws(()=>registry.renameCluster('metallurgy',{name:'Changed'}),error=>error.code==='SYSTEM_CLUSTER');assert.throws(()=>registry.createCluster({name:'  '}));assert.throws(()=>registry.createCluster({name:'металлургия'}),error=>error.code==='CLUSTER_EXISTS');
  assert.throws(()=>registry.override({prefab:'Wood',clusterId:custom.id,clusterCategoryId:'weapons'}),error=>error.code==='INVALID_CLUSTER');
});
test('regrouping conserves all quantities and chest sets, including variants, minimum-only rows and unknowns',t=> {
  const {registry}=fixture(t);registry.publish(manifest([definition('Iron'),definition('CopperOre'),definition('Wood')]));
  const store=new InventoryStore(':memory:',{now:()=>NOW,registry});t.after(()=>store.close());
  store.ingest(packet([chest('one',[stack('Iron',10),stack('CopperOre',20),{...stack('Iron',3),quality:2,variant:1}]),chest('two',[stack('Iron',5),stack('Wood',40),stack('Unknown',2)])]));store.minimum('world-a','Missing',10);
  const state=store.state(),totals=state.clusterStats;assert.equal(state.stats.totalItems,80);assert.equal(totals.reduce((sum,c)=>sum+c.totalItems,0),80);assert.equal(totals.reduce((sum,c)=>sum+c.uniqueItems,0),state.resources.length);
  const metallurgy=totals.find(c=>c.clusterId==='metallurgy');assert.equal(metallurgy.totalItems,38);assert.equal(metallurgy.containers,2);assert.equal(metallurgy.statusCounts.SNAPSHOT,2);
  assert.equal(state.resources.find(i=>i.prefab==='Iron').variants.reduce((sum,v)=>sum+v.quantity,0),18);assert.equal(state.resources.find(i=>i.prefab==='Unknown').clusterId,'unclassified');assert.equal(totals.find(c=>c.clusterId==='unclassified').shortages,1);
});
test('cluster totals isolate worlds and physical zones; repeated containers across metal items count exactly once',t=> {
  const {registry}=fixture(t);registry.publish(manifest([definition('Iron'),definition('CopperOre')]));const store=new InventoryStore(':memory:',{now:()=>NOW,registry});t.after(()=>store.close());
  store.ingest(packet([chest('shared',[stack('Iron',10),stack('CopperOre',20)]),chest('outside',[stack('Iron',30)],500)]));store.ingest(packet([chest('shared',[stack('Iron',999)])],{worldId:'world-b',worldName:'SYNTHETIC B'}));
  const a=store.state({worldId:'world-a'}),zone=store.state({worldId:'world-a',zoneId:'main'}),b=store.state({worldId:'world-b'});
  assert.equal(a.clusterStats.find(c=>c.clusterId==='metallurgy').totalItems,60);assert.equal(a.clusterStats.find(c=>c.clusterId==='metallurgy').containers,2);assert.equal(zone.clusterStats.find(c=>c.clusterId==='metallurgy').totalItems,30);assert.equal(zone.clusterStats.find(c=>c.clusterId==='metallurgy').containers,1);assert.equal(b.clusterStats.find(c=>c.clusterId==='metallurgy').totalItems,999);
});
test('mixed live/snapshot freshness remains explicit even when worst-source resource.status is SNAPSHOT',t=> {
  const {registry}=fixture(t);registry.publish(manifest([definition('Iron'),definition('CopperOre')]));const store=new InventoryStore(':memory:',{now:()=>NOW,registry});t.after(()=>store.close());
  store.ingest(packet([chest('snapshot',[stack('Iron',10)])]));store.ingest(packet([chest('live',[stack('Iron',20),stack('CopperOre',30)])],{sourceId:'live-source',mode:'host'}));
  const state=store.state(),iron=state.resources.find(item=>item.prefab==='Iron'),cluster=state.clusterStats.find(c=>c.clusterId==='metallurgy');assert.equal(iron.status,'SNAPSHOT');assert.deepEqual(iron.statusCounts,{SNAPSHOT:1,LIVE:1});assert.equal(cluster.status,'MIXED');assert.deepEqual(cluster.statusCounts,{SNAPSHOT:1,LIVE:1});assert.equal(cluster.containers,2);assert.equal(cluster.totalItems,60);
});
test('broken custom configuration retains the last valid classified catalog',t=> {
  const {registry}=fixture(t);registry.publish(manifest([definition('Iron')]));const custom=registry.createCluster({name:'Keep'});registry.override({prefab:'Iron',clusterId:custom.id,clusterCategoryId:'items'});writeFileSync(registry.clustersFile,'{}');registry.reload();assert.equal(registry.resolve('Iron').clusterId,custom.id);assert.equal(registry.summary().loadError,'REGISTRY_LOAD_FAILED');
});
test('HTTP manual/custom edits and a live +40 event notify WebSocket clients; refetched cluster totals and filter state agree',{timeout:8000},async t=> {
  const directory=mkdtempSync(join(tmpdir(),'vrm-clusters-http-')),app=createApp({dataDir:join(directory,'db'),localDataDir:join(directory,'local'),port:0,now:()=>NOW,token:'a'.repeat(64),intervals:false}),port=await app.listen(),base=`http://127.0.0.1:${port}`;
  const ws=new WebSocket(`ws://127.0.0.1:${port}/ws`,{origin:base});t.after(async()=>{ws.terminate();await app.close();rmSync(directory,{recursive:true,force:true});});await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  const request=(path,method='GET',body,source=false)=>fetch(base+path,{method,headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(source?{'X-VRM-Token':'a'.repeat(64)}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  app.registry.publish(manifest([definition('Iron')]));
  await request('/api/ingest','POST',packet([chest('live',[stack('Iron',10)])],{mode:'host'}),true);
  const mutateAndWait=async(path,method,body,source=false)=>{const event=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('No state notification')),2000);ws.once('message',raw=>{clearTimeout(timer);resolve(JSON.parse(raw));});});const response=await request(path,method,body,source);assert.ok(response.ok,await response.clone().text());assert.equal((await event).type,'state-changed');return response.json();};
  const created=await mutateAndWait('/api/clusters','POST',{name:'Test project'}),id=created.cluster.id;
  await mutateAndWait('/api/registry/overrides','PUT',{prefab:'Iron',clusterId:id,clusterCategoryId:'items'});
  let state=await(await request('/api/state')).json();assert.equal(state.clusterStats.find(c=>c.clusterId===id).totalItems,10);
  await mutateAndWait('/api/ingest','POST',packet([chest('live',[stack('Iron',50)])],{mode:'host',sequence:2}),true);state=await(await request('/api/state')).json();assert.equal(state.clusterStats.find(c=>c.clusterId===id).totalItems,50);assert.equal(state.stats.totalItems,50);
  await mutateAndWait('/api/clusters/'+id,'PUT',{name:'Renamed'});state=await(await request('/api/state?worldId=world-a&zoneId=main')).json();assert.equal(state.resources[0].clusterName,'Renamed');
  await mutateAndWait('/api/registry/overrides','PUT',{prefab:'Iron',reset:true});state=await(await request('/api/state')).json();assert.equal(state.clusterStats.find(c=>c.clusterId==='metallurgy').totalItems,50);
  assert.equal((await request('/api/clusters/metallurgy','PUT',{name:'Bad'})).status,403);assert.equal((await request('/api/clusters/metallurgy','DELETE')).status,404);assert.equal((await request('/api/registry')).status,200);
});
