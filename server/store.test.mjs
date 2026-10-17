import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InventoryStore, HEARTBEAT_TIMEOUT_MS, LIVE_OBSERVATION_MS } from './store.mjs';
import { validateIngest } from './validation.mjs';

const START=1_790_000_000_000;
const item=(quantity,prefab='Wood',name='Древесина')=>({prefab,name,quantity});
function setup(t,{file=':memory:',demo=false}={}) {
  let clock=START,seq=0;
  const store=new InventoryStore(file,{now:()=>clock,demo});
  t.after(()=>store.close());
  const chest=(id='1:1',quantity=10,options={})=>({id,type:'piece_chest',name:'Сундук',x:0,y:4,z:0,items:[item(quantity)],observedAt:clock,...options});
  const packet=(containers=[],options={})=>({sourceId:'host-a',worldId:'world-a',worldName:'Синтетический тестовый мир',mode:'host',coverage:'partial',sessionId:'session-a',sequence:++seq,containers,destroyedIds:[],gameVersion:'1.0.20',...options});
  return {store,chest,packet,advance:ms=>clock+=ms,ingest:(containers,options)=>store.ingest(validateIngest(packet(containers,options)))};
}

test('1. identical items sum across stacks and containers',t=> {
  const {store,chest,ingest}=setup(t);
  ingest([chest('1:1',10,{items:[item(10),item(5)]}),chest('1:2',20)]);
  const state=store.state();assert.equal(state.resources[0].quantity,35);assert.equal(state.stats.totalItems,35);assert.equal(state.resources[0].containerIds.length,2);assert.equal(state.containers[0].items.length,1);
});
test('2. container inventory is replaced, withdrawals are counted',t=> {
  const {store,chest,ingest}=setup(t);ingest([chest('1:1',100)]);ingest([chest('1:1',60)]);assert.equal(store.state().stats.totalItems,60);assert.match(store.state().events[0].text,/-40/);
});
test('3. moving items between containers preserves aggregate',t=> {
  const {store,chest,ingest}=setup(t);ingest([chest('1:1',100),chest('1:2',20)]);ingest([chest('1:1',60),chest('1:2',60)]);assert.equal(store.state().resources[0].quantity,120);
});
test('4. only explicit destruction removes a container; later rediscovery restores it',t=> {
  const {store,chest,ingest,advance}=setup(t);ingest([chest()]);ingest([]);assert.equal(store.state().containers.length,1);ingest([],{destroyedIds:['1:1']});assert.equal(store.state().containers.length,0);advance(1);ingest([chest()]);assert.equal(store.state().containers.length,1);assert.equal(store.state().stats.totalItems,10);
});
test('5. repeated full indexing never accumulates historical totals',t=> {
  const {store,chest,ingest}=setup(t);for(let n=0;n<20;n++)ingest([chest('1:1',40),chest('1:2',60)]);assert.equal(store.state().stats.totalItems,100);assert.equal(store.state().stats.containers,2);
});
test('6. same ZDOID in different worlds stays isolated including tombstones',t=> {
  const {store,chest,ingest}=setup(t);ingest([chest('1:1',10)]);ingest([chest('1:1',80)],{worldId:'world-b',worldName:'Другой мир'});ingest([],{destroyedIds:['1:1']});assert.equal(store.state({worldId:'world-a'}).stats.totalItems,0);assert.equal(store.state({worldId:'world-b'}).stats.totalItems,80);assert.equal(store.state().worlds.length,2);
});
test('7. local labels survive reindex, destruction, rediscovery and SQLite reopen',t=> {
  const directory=mkdtempSync(join(tmpdir(),'vrm-persistence-'));
  const file=join(directory,'inventory.sqlite');let store=new InventoryStore(file,{now:()=>START});
  const packet={sourceId:'host',worldId:'w',worldName:'Мир',mode:'host',coverage:'partial',sessionId:'a',sequence:1,containers:[{id:'1:1',type:'chest',name:'Chest',x:0,y:0,z:0,items:[item(10)],observedAt:START}],destroyedIds:[],gameVersion:'1.0'};
  store.ingest(packet);store.label('w','1:1','Кузница');store.minimum('w','Iron',50);store.ingest({...packet,sequence:2,containers:[],destroyedIds:['1:1']});store.ingest({...packet,sequence:3});packet.sequence=3;store.close();
  store=new InventoryStore(file,{now:()=>START});t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});packet.sequence++;store.ingest(packet);assert.equal(store.state().containers[0].label,'Кузница');assert.equal(store.state().minimums.Iron,50);assert.equal(store.state().stats.shortages,1);
});
test('8. connection timeout/reconnect does not discard inventories',t=> {
  const {store,chest,ingest,advance}=setup(t);ingest([chest()]);assert.equal(store.state().source.connected,true);advance(HEARTBEAT_TIMEOUT_MS+1);assert.equal(store.state().source.connected,false);assert.equal(store.state().containers[0].status,'OFFLINE');assert.equal(store.state().stats.totalItems,10);ingest([chest()]);assert.equal(store.state().containers[0].status,'LIVE');
});
test('9. heartbeat cannot make old or unloaded containers live',t=> {
  const {store,chest,ingest,advance}=setup(t);ingest([chest()]);advance(LIVE_OBSERVATION_MS+1);ingest([]);assert.equal(store.state().source.connected,true);assert.equal(store.state().containers[0].status,'STALE');assert.equal(store.state().containers[0].observedAt,new Date(START).toISOString());
});
test('10. circle X/Z territory filters totals while retaining outside inventory',t=> {
  const {store,chest,ingest}=setup(t);ingest([chest('1:1',10),chest('1:2',20,{x:500,z:0})]);assert.equal(store.state({zoneId:'main'}).stats.totalItems,10);assert.equal(store.state().stats.totalItems,30);assert.equal(store.state().zones[0].proposed,true);store.zone('world-a',{name:'База',x:0,z:0,radius:600,enabled:true},'main');assert.equal(store.state({zoneId:'main'}).stats.totalItems,30);assert.equal(store.state().zones[0].proposed,false);
});
test('sequence replay, old session and transaction rollback cannot overwrite confirmed state',t=> {
  const {store,chest,packet}=setup(t);const first=packet([chest()]);store.ingest(first);const revision=store.revision;assert.equal(store.ingest(first),revision);assert.throws(()=>store.ingest({...first,containers:[chest('1:1',999)]}),error=>error.status===409);assert.equal(store.revision,revision);store.ingest(packet([chest('1:1',20)],{sessionId:'session-b',sequence:1}));assert.throws(()=>store.ingest({...first,sequence:999,containers:[chest('1:1',999)]}),error=>error.status===409);assert.equal(store.state().stats.totalItems,20);
});
test('timestamps from future are capped and delayed older observations are ignored',t=> {
  const {store,chest,ingest,advance}=setup(t);ingest([chest('1:1',10,{observedAt:START+999999999})]);assert.equal(store.state().containers[0].observedAt,new Date(START).toISOString());advance(1000);ingest([chest('1:1',99,{observedAt:START-1})]);assert.equal(store.state().stats.totalItems,10);advance(LIVE_OBSERVATION_MS);ingest([]);assert.equal(store.state().containers[0].status,'STALE');
});
test('large ZDO IDs are exact strings, never numbers',t=> {
  const {store,chest,ingest,packet}=setup(t);const id='9223372036854775807:4294967295';ingest([chest(id)]);assert.equal(store.state().containers[0].zdoId,id);assert.throws(()=>validateIngest(packet([chest(9223372036854775807)])));
});
test('restart recycled/swapped runtime IDs reconcile by stable identity preserving labels',t=> {
  const {store,chest,ingest}=setup(t);ingest([chest('1:1',10,{identityKey:'pos-v1:1:00000000:40800000:00000000'}),chest('1:2',20,{x:10,identityKey:'pos-v1:1:41200000:40800000:00000000'})]);store.label('world-a',store.state().containers[0].id,'Первый склад');ingest([chest('1:2',15,{identityKey:'pos-v1:1:00000000:40800000:00000000'}),chest('1:1',25,{x:10,identityKey:'pos-v1:1:41200000:40800000:00000000'})],{sessionId:'session-b',sequence:1});const state=store.state();assert.equal(state.stats.containers,2);assert.equal(state.stats.totalItems,40);assert.equal(state.containers[0].label,'Первый склад');assert.equal(state.containers[0].zdoId,'1:2');
});
test('stale session tombstone cannot destroy unobserved container after restart',t=> {
  const {store,chest,ingest}=setup(t);ingest([chest('1:1',10,{identityKey:'old'})]);ingest([],{sessionId:'new',sequence:0,destroyedIds:['1:1']});assert.equal(store.state().containers.length,1);assert.equal(store.state().containers[0].status,'STALE');
});
test('identity ambiguity rolls back whole ingest including sequence',t=> {
  const {store,chest,packet}=setup(t);store.ingest(packet([chest('1:1',10,{identityKey:'same'})]));const before=store.revision;const bad=packet([chest('1:2',30,{identityKey:'same',x:40})]);assert.throws(()=>store.ingest(bad),error=>error.code==='IDENTITY_CONFLICT');assert.equal(store.revision,before);bad.containers[0].x=0;store.ingest(bad);assert.equal(store.state().stats.totalItems,30);
});
test('snapshot remains SNAPSHOT and is replaced by newer live observation without duplicates',t=> {
  const {store,chest,ingest,advance}=setup(t);ingest([chest('snapshot:id',10,{identityKey:'stable'})],{mode:'snapshot',sourceId:'save',sessionId:'snapshot'});assert.equal(store.state().source.connected,false);assert.equal(store.state().containers[0].status,'SNAPSHOT');assert.equal(store.state().containers[0].zdoId,null);assert.equal(store.state().source.lastConfirmedAt,new Date(START).toISOString());advance(100);ingest([chest('1:7',20,{identityKey:'stable'})]);assert.equal(store.state().stats.containers,1);assert.equal(store.state().containers[0].status,'LIVE');assert.equal(store.state().containers[0].zdoId,'1:7');ingest([chest('snapshot:id',999,{identityKey:'stable',observedAt:START})],{mode:'snapshot',sourceId:'save',sessionId:'snapshot'});assert.equal(store.state().stats.totalItems,20);
});
test('equal-time or late snapshot cannot downgrade a recent live container',t=> {
  const {store,chest,ingest,advance}=setup(t);ingest([chest('1:1',40,{identityKey:'stable'})]);ingest([chest('snapshot:x',99,{identityKey:'stable'})],{mode:'snapshot',sourceId:'save',sessionId:'snapshot'});assert.equal(store.state().containers[0].status,'LIVE');assert.equal(store.state().stats.totalItems,40);advance(1000);ingest([chest('snapshot:x',99,{identityKey:'stable'})],{mode:'snapshot',sourceId:'save',sessionId:'snapshot'});assert.equal(store.state().containers[0].status,'LIVE');assert.equal(store.state().stats.totalItems,40);
});
test('validation rejects negative, fractional, duplicate and impossible input',t=> {
  const {chest,packet}=setup(t);for(const quantity of [-1,1.5,Infinity,NaN,1_000_000_001])assert.throws(()=>validateIngest(packet([chest('a',quantity)])));assert.throws(()=>validateIngest(packet([chest('a'),chest('a')])));assert.throws(()=>validateIngest(packet([chest('a',1,{observedAt:'bad'})])));assert.throws(()=>validateIngest(packet([chest('a')],{destroyedIds:['a']})));assert.throws(()=>validateIngest(packet([chest('a')],{mode:'client',coverage:'authoritative'})));
});
test('demo fixture is explicit and isolated; +40 and transfer preserve expected totals',t=> {
  const {store}=setup(t,{demo:true});assert.equal(store.state().world,null);store.startDemo();let state=store.state();const baseline=state.stats.totalItems;const wood=state.resources.find(resource=>resource.prefab==='Wood').quantity;state=store.demoStep('add40');assert.equal(state.resources.find(resource=>resource.prefab==='Wood').quantity,wood+40);assert.equal(state.stats.totalItems,baseline+40);state=store.demoStep('move');assert.equal(state.stats.totalItems,baseline+40);store.demoStep('disconnect');store.tickDemo();assert.equal(store.state().source.connected,false);store.demoStep('reconnect');assert.equal(store.state().source.connected,true);
});
test('known English game item names localize to Russian while unknown native names and prefab identity stay exact',t=> {
  const {store,chest,ingest}=setup(t);
  ingest([chest('1:1',0,{items:[item(40,'Wood','Wood'),item(12,'Iron','Iron'),item(7,'Modded_Unknown_Item','Native item name'),item(3,'hash:-12345','Предмет #-12345 (не распознан)'),item(5,'toString','Unusual native prefab')]})]);
  const state=store.state();const byPrefab=new Map(state.resources.map(resource=>[resource.prefab,resource]));
  assert.equal(byPrefab.get('Wood').name,'Древесина');assert.equal(byPrefab.get('Iron').name,'Железо');assert.equal(byPrefab.get('Modded_Unknown_Item').name,'Native item name');assert.equal(byPrefab.get('hash:-12345').name,'Предмет #-12345 (не распознан)');assert.equal(byPrefab.get('toString').name,'Unusual native prefab');assert.equal(state.stats.totalItems,67);assert.equal(state.containers[0].items.find(entry=>entry.prefab==='Iron').name,'Железо');
});
