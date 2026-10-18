import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { ItemRegistry, prefabHash } from './registry.mjs';
import { InventoryStore } from './store.mjs';
import { validateIngest } from './validation.mjs';
import { createApp } from './main.mjs';
import { ChestSorterReader } from './chestsorter.mjs';

const definition=prefab=>({id:'prefab:'+prefab,prefab,prefabHash:prefabHash(prefab),nameRu:'Тест '+prefab,nameEn:'Test '+prefab,maxStack:50,metadata:{itemType:'Material'}});
const manifest=prefabs=>({schemaVersion:1,gameVersion:'synthetic',generatedAt:new Date().toISOString(),source:{kind:'installed-assets'},coverage:{definitionsFound:prefabs.length,scope:'installed-assets',runtimeVerified:false},items:prefabs.map(definition)});
const packet=(items=[],extra={})=>validateIngest({sourceId:'synthetic',sessionId:'test',sequence:1,worldId:'one',worldName:'Synthetic one',gameVersion:'synthetic',mode:'host',coverage:'partial',hostBed:{status:'set',x:0,y:0,z:0},destroyedIds:[],containers:[{id:'one',type:'chest',name:'Synthetic',x:0,y:0,z:0,observedAt:Date.now(),items}],...extra});
const item=(prefab,quantity=40)=>({prefab,name:prefab,quantity});
function fixture(t,prefabs=['Wood','Iron','Spoiler']) {
 const root=mkdtempSync(join(tmpdir(),'vrm-lists-')),registry=new ItemRegistry(join(root,'registry')),filename=join(root,'stock.sqlite');registry.publish(manifest(prefabs));
 let store=new InventoryStore(filename,{registry});store.ingest(packet([item('Wood')]));store.ingest(packet([],{worldId:'two',worldName:'Synthetic two'}));
 t.after(()=>{store.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));rmSync(root,{recursive:true,force:true});});
 return {root,registry,get store(){return store;},reopen:()=>{store.close();store=new InventoryStore(filename,{registry});}};
}
const stock=store=>{
 const {collections,revision,...state}=store.state({worldId:'one'});
 return {state,observed:store.db.prepare('SELECT * FROM observed_items ORDER BY world_id,prefab').all(),events:store.db.prepare('SELECT * FROM events ORDER BY id').all()};
};

test('favorites and overlapping custom lists persist after SQLite reopen without changing stock or observed history',t=>{
 const f=fixture(t),before=stock(f.store),a=f.store.createResourceList('one','Для стройки'),b=f.store.createResourceList('one','В поход','Wood');
 f.store.setCollectionMembership('one','Wood',true);f.store.setCollectionMembership('one','Wood',true,a.id);f.store.setCollectionMembership('one','Spoiler',true,a.id);f.reopen();
 const saved=f.store.collections('one');assert.deepEqual(saved.favorites,['Wood']);assert.deepEqual(saved.lists.map(list=>list.name),['Для стройки','В поход']);assert.deepEqual(saved.lists.find(list=>list.id===a.id).prefabs,['Wood','Spoiler']);assert.deepEqual(saved.lists.find(list=>list.id===b.id).prefabs,['Wood']);assert.deepEqual(stock(f.store),before);
});

test('membership writes are idempotent; removing a favorite does not remove it from custom lists',t=>{
 const {store}=fixture(t),list=store.createResourceList('one','Build','Wood');store.setCollectionMembership('one','Wood',true);const revision=store.revision;
 store.setCollectionMembership('one','Wood',true);store.setCollectionMembership('one','Wood',true,list.id);assert.equal(store.revision,revision);
 store.setCollectionMembership('one','Wood',false);const next=store.revision;store.setCollectionMembership('one','Wood',false);assert.equal(store.revision,next);assert.deepEqual(store.collections('one').favorites,[]);assert.deepEqual(store.collections('one').lists[0].prefabs,['Wood']);
});

test('rename and delete preserve stable list identity, favorites and membership in other lists',t=>{
 const {store}=fixture(t),list=store.createResourceList('one','Build','Wood'),other=store.createResourceList('one','Travel','Wood');store.setCollectionMembership('one','Wood',true);
 store.renameResourceList('one',list.id,'  Дом  ');assert.equal(store.collections('one').lists[0].id,list.id);assert.equal(store.collections('one').lists[0].name,'Дом');assert.deepEqual(store.collections('one').lists[0].prefabs,['Wood']);
 store.deleteResourceList('one',list.id);assert.equal(store.db.prepare('SELECT count(*) n FROM resource_list_items WHERE list_id=?').get(list.id).n,0);assert.deepEqual(store.collections('one').favorites,['Wood']);assert.deepEqual(store.collections('one').lists.map(l=>l.id),[other.id]);
});

test('world ownership prevents cross-world reads, changes and deletes, while equal names in different worlds are allowed',t=>{
 const {store}=fixture(t),list=store.createResourceList('one','Build','Wood');store.setCollectionMembership('one','Wood',true);store.createResourceList('two','Build','Iron');
 assert.deepEqual(store.collections('two').favorites,[]);assert.deepEqual(store.collections('two').lists[0].prefabs,['Iron']);
 for(const action of [()=>store.renameResourceList('two',list.id,'Other'),()=>store.deleteResourceList('two',list.id),()=>store.setCollectionMembership('two','Wood',true,list.id)])assert.throws(action,error=>error.status===404);
 assert.throws(()=>store.setCollectionMembership('missing','Wood',true),error=>error.status===404);assert.deepEqual(store.collections('one').lists[0].prefabs,['Wood']);
});

test('invalid names, duplicate normalized names, malformed membership and initial-item failure do not partially write',t=>{
 const {store}=fixture(t);store.createResourceList('one','Дом');const before=store.collections('one'),revision=store.revision;
 for(const name of ['', ' ', 'x'.repeat(81), 'Build\nNow',null,22])assert.throws(()=>store.createResourceList('one',name),error=>error.status===400);
 assert.throws(()=>store.createResourceList('one',' ДОМ '),error=>error.code==='LIST_EXISTS');assert.throws(()=>store.createResourceList('one','New',''),error=>error.status===400);
 for(const bad of ['yes',1,null,undefined])assert.throws(()=>store.setCollectionMembership('one','Wood',bad),error=>error.status===400);
 assert.throws(()=>store.setCollectionMembership('one','Wood\0',true),error=>error.status===400);assert.deepEqual(store.collections('one'),before);assert.equal(store.revision,revision);
});

test('list count is bounded and SQL-looking text stays literal data',t=>{
 const {store}=fixture(t);store.createResourceList('one',"O'Brien'); DROP TABLE worlds; --",'Wood');
 for(let i=1;i<100;i++)store.createResourceList('one','List '+i);assert.throws(()=>store.createResourceList('one','Over limit'),error=>error.status===400);assert.equal(store.collections('one').lists.length,100);assert.equal(store.state().worlds.length,2);
});

test('unknown hash favorites resolve after registry reindex and can be removed by canonical prefab without duplicate aliases',t=>{
 const f=fixture(t,[]),hash='hash:'+prefabHash('Iron'),list=f.store.createResourceList('one','Build',hash);f.store.setCollectionMembership('one',hash,true);
 f.registry.publish(manifest(['Wood','Iron']));assert.deepEqual(f.store.collections('one').favorites,['Iron']);assert.deepEqual(f.store.collections('one').lists[0].prefabs,['Iron']);
 f.store.setCollectionMembership('one','Iron',true);f.store.setCollectionMembership('one','Iron',true,list.id);assert.equal(f.store.collections('one').favorites.length,1);
 f.store.setCollectionMembership('one',hash,false);f.store.setCollectionMembership('one','Iron',false,list.id);assert.deepEqual(f.store.collections('one').favorites,[]);assert.deepEqual(f.store.collections('one').lists[0].prefabs,[]);
});

test('hash collisions and equal display names retain distinct exact prefab memberships',t=>{
 const a='Mod_pwnzjm_f9u',b='Mod_-cynz70_fh0',f=fixture(t,[a,b]);assert.equal(prefabHash(a),prefabHash(b));
 const hash='hash:'+prefabHash(a),list=f.store.createResourceList('one','Collision',hash);for(const prefab of [a,b])f.store.setCollectionMembership('one',prefab,true,list.id);
 assert.deepEqual(new Set(f.store.collections('one').lists[0].prefabs),new Set([hash,a,b]));f.store.setCollectionMembership('one',a,false,list.id);assert.deepEqual(new Set(f.store.collections('one').lists[0].prefabs),new Set([hash,b]));
});

test('saving a spoiler definition does not invent inventory, minima, shortages or discovery history',t=>{
 const f=fixture(t),before=stock(f.store);f.store.defaultMinimum('one',200);const stats=f.store.state({worldId:'one'}).stats;
 f.store.setCollectionMembership('one','Spoiler',true);f.store.createResourceList('one','Later','Spoiler');const view=f.store.collectionsView({worldId:'one'}),entry=view.collections.items[0];
 assert.equal(entry.prefab,'Spoiler');assert.equal(entry.catalogOnly,true);assert.equal(entry.newToWorld,true);assert.equal(entry.availableQuantity,null);assert.equal(entry.minimum,0);assert.equal(entry.status,'CATALOG');assert.deepEqual(view.stats,stats);assert.equal(view.resources.length,1);assert.deepEqual(f.store.observedPrefabs('one'),new Set(['Wood']));assert.deepEqual(stock(f.store).observed,before.observed);
 const game=join(f.root,'game');mkdirSync(join(game,'BepInEx/config'),{recursive:true});writeFileSync(join(game,'BepInEx/config/ChestSorter.categories.txt'),'version | 4\ncategory | Misc | Misc\nitemtype | Material | Misc');
 const state=f.store.state({worldId:'one'}),chestsorter=new ChestSorterReader(()=>game).view(state,{registry:f.registry,observedPrefabs:f.store.observedPrefabs('one')});assert.equal(chestsorter.chestSorter.catalog.find(i=>i.prefab==='Spoiler').newToWorld,true);
});

test('saved items remain in collections after consumption, chest destruction and zone/500m exclusion',t=>{
 const {store}=fixture(t),list=store.createResourceList('one','Build','Wood');store.setCollectionMembership('one','Iron',true);
 store.ingest(packet([item('Iron',3)],{sequence:2,containers:[{id:'far',type:'chest',name:'Far',x:501,y:0,z:0,observedAt:Date.now(),items:[item('Iron',3)]}]}));
 store.ingest(packet([],{sequence:3,containers:[],destroyedIds:['one']}));
 for(const zoneId of ['all','main']){const view=store.collectionsView({worldId:'one',zoneId});assert.equal(view.collections.items.length,2);assert.ok(view.collections.items.every(i=>i.catalogOnly&&!i.newToWorld&&i.availableQuantity===null));assert.equal(view.stats.totalItems,0);assert.equal(view.collections.lists[0].id,list.id);}
});

test('legacy databases migrate with empty collections, retaining inventory; DEMO reset is isolated',t=>{
 const f=fixture(t),before=stock(f.store);f.store.db.exec('DROP TABLE resource_list_items; DROP TABLE resource_lists; DROP TABLE resource_favorites;');f.reopen();assert.deepEqual(f.store.collections('one'),{favorites:[],lists:[]});assert.deepEqual(stock(f.store),before);
 const demo=new InventoryStore(':memory:',{registry:f.registry,demo:true});t.after(()=>demo.close());demo.startDemo();demo.createResourceList('demo-midgard','Demo','Wood');demo.setCollectionMembership('demo-midgard','Wood',true);f.store.createResourceList('one','Real','Wood');demo.startDemo();assert.deepEqual(demo.collections('demo-midgard'),{favorites:[],lists:[]});assert.equal(f.store.collections('one').lists[0].name,'Real');
});

test('HTTP favorites/list API supports CRUD, enforces origin and owner, and GET never modifies revision',async t=>{
 const root=mkdtempSync(join(tmpdir(),'vrm-lists-http-')),app=createApp({dataDir:root,port:0,token:'a'.repeat(64),intervals:false});t.after(async()=>{await app.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));rmSync(root,{recursive:true,force:true});});
 app.registry.publish(manifest(['Wood','Spoiler']));app.real.ingest(packet([item('Wood')]));app.real.ingest(packet([],{worldId:'two',worldName:'Synthetic two'}));const base=`http://127.0.0.1:${await app.listen()}`;
 const request=(path,method,body,headers={})=>fetch(base+path,{method,headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 assert.equal((await request('/api/favorites','PUT',{worldId:'one',prefab:'Wood',favorite:true})).status,200);
 const created=await request('/api/resource-lists','POST',{worldId:'one',name:'Plan',prefab:'Spoiler'});assert.equal(created.status,201);const {list}=await created.json();
 assert.equal((await request('/api/resource-lists/'+list.id+'/items','PUT',{worldId:'one',prefab:'Wood',included:true})).status,200);
 assert.equal((await request('/api/resource-lists/'+list.id,'PUT',{worldId:'one',name:'Renamed'})).status,200);
 const revision=app.real.revision,view=await(await fetch(base+'/api/collections?worldId=one')).json();assert.equal(view.collections.items.length,2);assert.equal(view.collections.lists[0].name,'Renamed');assert.equal(view.resources.length,1);assert.equal(app.real.revision,revision);
 assert.equal((await request('/api/favorites','PUT',{worldId:'one',prefab:'Wood',favorite:false},{Origin:'https://example.invalid'})).status,403);
 assert.equal((await request('/api/resource-lists/'+list.id,'DELETE',{worldId:'two'})).status,404);
 assert.equal((await request('/api/favorites','PUT',{worldId:'one',prefab:'Wood',favorite:'yes'})).status,400);
 assert.equal((await request('/api/resource-lists/'+list.id,'DELETE',{worldId:'one'})).status,200);assert.deepEqual(app.real.collections('one').favorites,['Wood']);
 app.demo.startDemo();const demo=await(await fetch(base+'/api/collections?demo=1')).json();assert.deepEqual(demo.collections.favorites,[]);assert.deepEqual(demo.collections.lists,[]);
});
