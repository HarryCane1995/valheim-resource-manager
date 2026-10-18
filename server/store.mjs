import { DatabaseSync } from 'node:sqlite';
import { randomUUID,createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { RUSSIAN_ITEM_NAMES } from './catalog.mjs';
import { categoryFor, ItemRegistry } from './registry.mjs';
import { summarizeClusters } from './clusters.mjs';
import { hostBedReport, hostBedArea, withinHostBedArea } from './host-bed.mjs';
export { categoryFor } from './registry.mjs';

export const HEARTBEAT_TIMEOUT_MS = 12_000;
export const LIVE_OBSERVATION_MS = 15_000;
export class ApiError extends Error {
  constructor(status, message, code = 'INVALID_REQUEST') { super(message); this.status = status; this.code = code; }
}
const iso = value => new Date(value).toISOString();
const statusRank = { LIVE: 0, SNAPSHOT: 1, STALE: 2, OFFLINE: 3 };

export function normalizedItems(items,registry) {
  const byPrefab = new Map();
  for (const original of items) {
    const item=registry?registry.describe(original):original;
    if (item.quantity === 0) continue;
    const existing = byPrefab.get(item.prefab);
    const variants=original.variants || [{quantity:original.quantity,...Object.fromEntries(['quality','variant','modId','customData','metadata'].filter(key=>original[key]!==undefined).map(key=>[key,original[key]]))}];
    if (existing) {existing.quantity+=item.quantity;existing.variants.push(...variants);if(registry) {existing.sourceIds=[...new Set([...existing.sourceIds,...item.sourceIds])];existing.searchText=[existing.searchText,...existing.sourceIds].join(' ').toLowerCase();}}
    else byPrefab.set(item.prefab,{...item,name:registry?item.name:RUSSIAN_ITEM_NAMES[item.prefab] || item.name,category:item.category || categoryFor(item.prefab),variants:[...variants]});
  }
  for(const item of byPrefab.values()) {const variants=new Map();for(const entry of item.variants) {const {quantity,...identity}=entry,key=JSON.stringify(identity);const existing=variants.get(key);if(existing)existing.quantity+=quantity;else variants.set(key,{...identity,quantity});}item.variants=[...variants.values()];}
  return [...byPrefab.values()].sort((a, b) => a.prefab.localeCompare(b.prefab));
}

export class InventoryStore {
  constructor(filename, { now = () => Date.now(), demo = false, registry } = {}) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.now = now;
    this.demo = demo;
    this.registry=registry || new ItemRegistry(filename===':memory:'?join(tmpdir(),'vrm-empty-registry-'+randomUUID()):dirname(filename)+'/localdata');
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO meta VALUES ('revision','0');
      CREATE TABLE IF NOT EXISTS worlds (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sources (world_id TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT NOT NULL, mode TEXT NOT NULL, coverage TEXT NOT NULL, last_seen INTEGER NOT NULL, game_version TEXT NOT NULL, force_offline INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(world_id,id));
      CREATE TABLE IF NOT EXISTS sessions (world_id TEXT NOT NULL, source_id TEXT NOT NULL, session_id TEXT NOT NULL, sequence INTEGER NOT NULL, PRIMARY KEY(world_id,source_id,session_id));
      CREATE TABLE IF NOT EXISTS containers (world_id TEXT NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', x REAL NOT NULL,y REAL NOT NULL,z REAL NOT NULL,items TEXT NOT NULL, observed_at INTEGER NOT NULL,source_id TEXT NOT NULL,destroyed INTEGER NOT NULL DEFAULT 0,destroyed_at INTEGER, PRIMARY KEY(world_id,id));
      CREATE TABLE IF NOT EXISTS zones (world_id TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,x REAL NOT NULL,z REAL NOT NULL,radius REAL NOT NULL,enabled INTEGER NOT NULL, proposed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(world_id,id));
      CREATE TABLE IF NOT EXISTS minimums (world_id TEXT NOT NULL,prefab TEXT NOT NULL,minimum INTEGER NOT NULL, PRIMARY KEY(world_id,prefab));
      CREATE TABLE IF NOT EXISTS world_preferences (world_id TEXT PRIMARY KEY,default_minimum INTEGER NOT NULL CHECK(default_minimum>=0 AND default_minimum<=1000000000));
      CREATE TABLE IF NOT EXISTS observed_items (world_id TEXT NOT NULL,prefab TEXT NOT NULL,name TEXT NOT NULL, PRIMARY KEY(world_id,prefab));
      CREATE TABLE IF NOT EXISTS resource_favorites (world_id TEXT NOT NULL,prefab TEXT NOT NULL, PRIMARY KEY(world_id,prefab));
      CREATE TABLE IF NOT EXISTS resource_lists (world_id TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,created_at INTEGER NOT NULL, PRIMARY KEY(world_id,id));
      CREATE TABLE IF NOT EXISTS resource_list_items (world_id TEXT NOT NULL,list_id TEXT NOT NULL,prefab TEXT NOT NULL, PRIMARY KEY(world_id,list_id,prefab), FOREIGN KEY(world_id,list_id) REFERENCES resource_lists(world_id,id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT,world_id TEXT NOT NULL,at INTEGER NOT NULL,text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_beds (world_id TEXT PRIMARY KEY,source_id TEXT NOT NULL,session_id TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('set','unset')),x REAL,y REAL,z REAL,observed_at INTEGER NOT NULL);
    `);
    const columns = new Set(this.db.prepare('PRAGMA table_info(containers)').all().map(column=>column.name));
    for (const [name,type] of [['runtime_id',"TEXT NOT NULL DEFAULT ''"],['identity_key',"TEXT NOT NULL DEFAULT ''"],['session_id',"TEXT NOT NULL DEFAULT ''"]]) if (!columns.has(name)) this.db.exec(`ALTER TABLE containers ADD COLUMN ${name} ${type}`);
    this.db.exec("UPDATE containers SET runtime_id=id WHERE runtime_id=''");
    if(!this.db.prepare('PRAGMA table_info(sessions)').all().some(column=>column.name==='digest')) this.db.exec("ALTER TABLE sessions ADD COLUMN digest TEXT NOT NULL DEFAULT ''");
  }
  close() { this.db.close(); }
  get revision() { return Number(this.db.prepare("SELECT value FROM meta WHERE key='revision'").get().value); }
  bump() { this.db.prepare("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run(); return this.revision; }
  transact(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  event(worldId, text) {
    this.db.prepare('INSERT INTO events(world_id,at,text) VALUES(?,?,?)').run(worldId, this.now(), text);
    this.db.prepare('DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 500)').run();
  }
  requireWorld(id) {
    if (!this.db.prepare('SELECT id FROM worlds WHERE id=?').get(id)) throw new ApiError(404, 'Мир ещё не был обнаружен.', 'WORLD_NOT_FOUND');
  }
  rememberObservedItems(worldId,items) {
    const insert=this.db.prepare('INSERT INTO observed_items(world_id,prefab,name) VALUES(?,?,?) ON CONFLICT(world_id,prefab) DO UPDATE SET name=excluded.name WHERE observed_items.name<>excluded.name');
    for(const item of items) if(item.quantity>0) insert.run(worldId,item.prefab,item.name);
  }
  observedPrefabs(worldId) {
    if(!worldId) return new Set();
    return new Set(this.db.prepare('SELECT prefab FROM observed_items WHERE world_id=?').all(worldId).map(item=>this.registry.resolve(item.prefab)?.prefab || item.prefab));
  }
  collectionPrefab(prefab) {
    if(typeof prefab!=='string' || !prefab.trim() || prefab.length>200 || /[\u0000-\u001f]/.test(prefab)) throw new ApiError(400,'Недопустимый prefab.');
    return this.registry.resolve(prefab)?.prefab || prefab;
  }
  collections(worldId) {
    if(!worldId) return {favorites:[],lists:[]};
    const canonical=rows=>[...new Set(rows.map(row=>this.collectionPrefab(row.prefab)))];
    const members=new Map();
    for(const row of this.db.prepare('SELECT list_id,prefab FROM resource_list_items WHERE world_id=? ORDER BY rowid').all(worldId)) {
      if(!members.has(row.list_id)) members.set(row.list_id,[]);
      members.get(row.list_id).push(row);
    }
    return {favorites:canonical(this.db.prepare('SELECT prefab FROM resource_favorites WHERE world_id=? ORDER BY rowid').all(worldId)),lists:this.db.prepare('SELECT id,name FROM resource_lists WHERE world_id=? ORDER BY created_at,rowid').all(worldId).map(list=>({...list,prefabs:canonical(members.get(list.id)||[])}))};
  }
  listName(worldId,name,exceptId) {
    if(typeof name!=='string' || !name.trim() || name.trim().length>80 || /[\u0000-\u001f]/.test(name)) throw new ApiError(400,'Название списка: от 1 до 80 символов без переносов строк.');
    const trimmed=name.trim();
    if(this.collections(worldId).lists.some(list=>list.id!==exceptId && list.name.toLocaleLowerCase('ru')===trimmed.toLocaleLowerCase('ru'))) throw new ApiError(409,'Список с таким названием уже есть.','LIST_EXISTS');
    return trimmed;
  }
  requireList(worldId,id) {
    this.requireWorld(worldId);
    const list=this.db.prepare('SELECT id,name FROM resource_lists WHERE world_id=? AND id=?').get(worldId,id);
    if(!list) throw new ApiError(404,'Список не найден в выбранном мире.','LIST_NOT_FOUND');
    return list;
  }
  // Canonicalize aliases on a write; reads never migrate inventory or mark items as observed.
  setCollectionMembership(worldId,prefab,included,listId) {
    if(listId===undefined) this.requireWorld(worldId); else this.requireList(worldId,listId);
    if(typeof included!=='boolean') throw new ApiError(400,'Состояние отметки должно быть true или false.');
    this.registry.reload();const canonical=this.collectionPrefab(prefab);
    return this.transact(()=>{
      const where=listId===undefined?'world_id=?':'world_id=? AND list_id=?',values=listId===undefined?[worldId]:[worldId,listId],table=listId===undefined?'resource_favorites':'resource_list_items';
      const rows=this.db.prepare(`SELECT prefab FROM ${table} WHERE ${where}`).all(...values),aliases=rows.filter(row=>this.collectionPrefab(row.prefab)===canonical);
      if((!included&&!aliases.length)||(included&&aliases.length===1&&aliases[0].prefab===canonical)) return this.collections(worldId);
      if(included&&!aliases.length&&rows.length>=20_000) throw new ApiError(400,'В одном списке может быть не более 20 000 предметов.');
      for(const row of aliases) this.db.prepare(`DELETE FROM ${table} WHERE ${where} AND prefab=?`).run(...values,row.prefab);
      if(included) this.db.prepare(`INSERT INTO ${table} (${listId===undefined?'world_id,prefab':'world_id,list_id,prefab'}) VALUES(${values.map(()=>'?').join(',')},?)`).run(...values,canonical);
      this.bump();return this.collections(worldId);
    });
  }
  createResourceList(worldId,name,prefab) {
    this.requireWorld(worldId);this.registry.reload();
    const trimmed=this.listName(worldId,name),canonical=prefab===undefined?undefined:this.collectionPrefab(prefab);
    if(this.collections(worldId).lists.length>=100) throw new ApiError(400,'В одном мире может быть не более 100 списков.');
    return this.transact(()=>{
      const id=randomUUID();this.db.prepare('INSERT INTO resource_lists(world_id,id,name,created_at) VALUES(?,?,?,?)').run(worldId,id,trimmed,this.now());
      if(canonical!==undefined) this.db.prepare('INSERT INTO resource_list_items(world_id,list_id,prefab) VALUES(?,?,?)').run(worldId,id,canonical);
      this.bump();return {id,name:trimmed,prefabs:canonical===undefined?[]:[canonical]};
    });
  }
  renameResourceList(worldId,id,name) {
    const list=this.requireList(worldId,id),trimmed=this.listName(worldId,name,id);
    if(list.name!==trimmed) this.transact(()=>{this.db.prepare('UPDATE resource_lists SET name=? WHERE world_id=? AND id=?').run(trimmed,worldId,id);this.bump();});
    return this.collections(worldId);
  }
  deleteResourceList(worldId,id) {
    this.requireList(worldId,id);
    return this.transact(()=>{this.db.prepare('DELETE FROM resource_lists WHERE world_id=? AND id=?').run(worldId,id);this.bump();return this.collections(worldId);});
  }
  ingest(payload) {
    const now = this.now();
    let bedReport;
    try { bedReport = hostBedReport(payload); } catch (error) { throw new ApiError(400, error.message); }
    return this.transact(() => {
      const digest=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      const last = this.db.prepare('SELECT sequence,digest FROM sessions WHERE world_id=? AND source_id=? AND session_id=?').get(payload.worldId, payload.sourceId, payload.sessionId);
      const source = this.db.prepare('SELECT session_id FROM sources WHERE world_id=? AND id=?').get(payload.worldId, payload.sourceId);
      if(last && source?.session_id===payload.sessionId && payload.sequence===last.sequence && last.digest===digest) return this.revision;
      if (last && (payload.sequence <= last.sequence || source?.session_id !== payload.sessionId)) throw new ApiError(409, 'Повторный либо устаревший пакет синхронизации.', 'REPLAY');
      this.db.prepare('INSERT INTO worlds(id,name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name').run(payload.worldId, payload.worldName);
      this.db.prepare('INSERT INTO sessions(world_id,source_id,session_id,sequence,digest) VALUES(?,?,?,?,?) ON CONFLICT(world_id,source_id,session_id) DO UPDATE SET sequence=excluded.sequence,digest=excluded.digest').run(payload.worldId,payload.sourceId,payload.sessionId,payload.sequence,digest);
      this.db.prepare('INSERT INTO sources(world_id,id,session_id,mode,coverage,last_seen,game_version,force_offline) VALUES(?,?,?,?,?,?,?,0) ON CONFLICT(world_id,id) DO UPDATE SET session_id=excluded.session_id,mode=excluded.mode,coverage=excluded.coverage,last_seen=excluded.last_seen,game_version=excluded.game_version,force_offline=0').run(payload.worldId,payload.sourceId,payload.sessionId,payload.mode,payload.coverage,now,payload.gameVersion);
      if (bedReport) this.db.prepare('INSERT INTO host_beds(world_id,source_id,session_id,status,x,y,z,observed_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(world_id) DO UPDATE SET source_id=excluded.source_id,session_id=excluded.session_id,status=excluded.status,x=excluded.x,y=excluded.y,z=excluded.z,observed_at=excluded.observed_at').run(payload.worldId,payload.sourceId,payload.sessionId,bedReport.status,bedReport.x ?? null,bedReport.y ?? null,bedReport.z ?? null,now);
      for (const container of payload.containers) {
        const internalId = container.identityKey ? `stable:${container.identityKey}` : container.id;
        const observed = Math.min(now, typeof container.observedAt === 'number' ? container.observedAt : Date.parse(container.observedAt));
        const previous = this.db.prepare('SELECT * FROM containers WHERE world_id=? AND id=?').get(payload.worldId,internalId);
        if (previous && container.identityKey && ['x','y','z'].some(axis=>Math.fround(previous[axis])!==Math.fround(container[axis]))) throw new ApiError(409,'Неоднозначная идентичность контейнера. Пакет отклонён.','IDENTITY_CONFLICT');
        if (previous && (observed < previous.observed_at || (previous.destroyed && observed < previous.destroyed_at))) continue;
        if(previous && payload.mode==='snapshot') {
          const oldSource=this.db.prepare('SELECT mode,last_seen,force_offline FROM sources WHERE world_id=? AND id=?').get(payload.worldId,previous.source_id);
          if(oldSource && oldSource.mode!=='snapshot' && (observed<=previous.observed_at || (!oldSource.force_offline && now-oldSource.last_seen<HEARTBEAT_TIMEOUT_MS && now-previous.observed_at<=LIVE_OBSERVATION_MS))) continue;
        }
        const items = normalizedItems(container.items);
        this.rememberObservedItems(payload.worldId,items);
        const json = JSON.stringify(items);
        this.db.prepare(`INSERT INTO containers(world_id,id,type,name,x,y,z,items,observed_at,source_id,destroyed,runtime_id,identity_key,session_id) VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?,?)
          ON CONFLICT(world_id,id) DO UPDATE SET type=excluded.type,name=excluded.name,x=excluded.x,y=excluded.y,z=excluded.z,items=excluded.items,observed_at=excluded.observed_at,source_id=excluded.source_id,destroyed=0,destroyed_at=NULL,runtime_id=excluded.runtime_id,identity_key=excluded.identity_key,session_id=excluded.session_id`).run(payload.worldId,internalId,container.type,container.name,container.x,container.y,container.z,json,observed,payload.sourceId,container.id,container.identityKey || '',payload.sessionId);
        if (!previous || previous.destroyed) this.event(payload.worldId, `Обнаружен контейнер: ${container.name}`);
        else if (previous.items !== json) {
          const oldItems = new Map(JSON.parse(previous.items).map(item => [item.prefab,item.quantity]));
          const deltas = items.map(item => ({name:item.name,delta:item.quantity - (oldItems.get(item.prefab)||0)}));
          const current = new Set(items.map(item=>item.prefab));
          for (const item of JSON.parse(previous.items)) if (!current.has(item.prefab)) deltas.push({name:item.name,delta:-item.quantity});
          const summary = deltas.filter(item=>item.delta).slice(0,3).map(item=>`${item.name} ${item.delta > 0 ? '+' : ''}${item.delta}`).join(', ');
          this.event(payload.worldId, `${previous.label || container.name}: ${summary || 'состав обновлён'}`);
        }
      }
      for (const id of payload.destroyedIds) {
        const matches = this.db.prepare('SELECT id,name,label,destroyed FROM containers WHERE world_id=? AND runtime_id=? AND source_id=? AND session_id=?').all(payload.worldId,id,payload.sourceId,payload.sessionId);
        if (matches.length>1) throw new ApiError(409,'Неоднозначный ZDOID уничтоженного контейнера.','IDENTITY_CONFLICT');
        const previous = matches[0];
        if (previous && !previous.destroyed) {
          this.db.prepare("UPDATE containers SET destroyed=1,destroyed_at=?,items='[]' WHERE world_id=? AND id=?").run(now,payload.worldId,previous.id);
          this.event(payload.worldId, `Уничтожен контейнер: ${previous.label || previous.name}`);
        }
      }
      const first = payload.containers[0];
      if (first && !this.db.prepare('SELECT id FROM zones WHERE world_id=? LIMIT 1').get(payload.worldId)) {
        this.db.prepare('INSERT INTO zones VALUES(?,?,?,?,?,?,1,1)').run(payload.worldId,'main','Основная база',first.x,first.z,100);
        this.event(payload.worldId, 'Предложена зона основной базы: первый обнаруженный контейнер, радиус 100 м. Уточните центр в настройках.');
      }
      return this.bump();
    });
  }
  state({worldId, zoneId = 'all'} = {}) {
    this.registry.reload();
    const worlds = this.db.prepare('SELECT id,name FROM worlds ORDER BY rowid').all();
    const selected = worldId ? worlds.find(world=>world.id===worldId) : worlds[0];
    if (worldId && !selected) throw new ApiError(404, 'Мир не найден.', 'WORLD_NOT_FOUND');
    const empty = { demo:this.demo,worlds,world:selected || null,collections:this.collections(selected?.id),defaultMinimum:selected ? this.db.prepare('SELECT default_minimum FROM world_preferences WHERE world_id=?').get(selected.id)?.default_minimum ?? 0 : 0,hostBedArea:hostBedArea(selected && this.db.prepare('SELECT * FROM host_beds WHERE world_id=?').get(selected.id)),registry:{...this.registry.summary(),inventoryUnknownItems:0,reindexRequested:false},clusters:this.registry.clusters,clusterStats:summarizeClusters([],this.registry.clusters),reservationsImplemented:false,source:{connected:false,mode:null,coverage:'partial',scope:'UNKNOWN',lastSeenAt:null,lastConfirmedAt:null,gameVersion:null},containers:[],resources:[],zones:[],minimums:{},events:[],stats:{totalItems:0,uniqueItems:0,containers:0,shortages:0},revision:this.revision };
    if (!selected) return empty;
    const now = this.now();
    const rawSources = this.db.prepare('SELECT * FROM sources WHERE world_id=? ORDER BY last_seen DESC').all(selected.id);
    const connected = source => !!source && source.mode!=='snapshot' && !source.force_offline && now - source.last_seen < HEARTBEAT_TIMEOUT_MS;
    const modeRank = {server:0,host:1,client:2,snapshot:3};
    const preferred = [...rawSources].sort((a,b)=>Number(connected(b))-Number(connected(a)) || (connected(a) ? modeRank[a.mode]-modeRank[b.mode] : b.last_seen-a.last_seen))[0];
    const sourceById = new Map(rawSources.map(source=>[source.id,source]));
    const zones = this.db.prepare('SELECT * FROM zones WHERE world_id=? ORDER BY rowid').all(selected.id).map(zone=>({id:zone.id,name:zone.name,x:zone.x,z:zone.z,radius:zone.radius,enabled:!!zone.enabled,proposed:!!zone.proposed}));
    if (zoneId !== 'all' && !zones.some(zone=>zone.id===zoneId)) throw new ApiError(404, 'Складская зона не найдена.', 'ZONE_NOT_FOUND');
    let containers = this.db.prepare('SELECT * FROM containers WHERE world_id=? AND destroyed=0 ORDER BY rowid').all(selected.id).map(container=> {
      const source = sourceById.get(container.source_id);
      const status = source?.mode==='snapshot' ? 'SNAPSHOT' : !connected(source) ? 'OFFLINE' : container.session_id!==source.session_id || now-container.observed_at>LIVE_OBSERVATION_MS ? 'STALE' : 'LIVE';
      return {id:container.id,zdoId:source?.mode==='snapshot'?null:container.runtime_id,identityKey:container.identity_key || null,type:container.type,name:container.name,label:container.label,x:container.x,y:container.y,z:container.z,items:normalizedItems(JSON.parse(container.items),this.registry),observedAt:iso(container.observed_at),status,zoneIds:zones.filter(zone=>zone.enabled && Math.hypot(container.x-zone.x,container.z-zone.z)<=zone.radius).map(zone=>zone.id)};
    });
    containers = containers.filter(container => withinHostBedArea(container, empty.hostBedArea));
    if (zoneId !== 'all') containers = containers.filter(container=>container.zoneIds.includes(zoneId));
    const minimums=Object.create(null);for(const row of this.db.prepare('SELECT prefab,minimum FROM minimums WHERE world_id=?').all(selected.id)) {const prefab=this.registry.resolve(row.prefab)?.prefab || row.prefab;minimums[prefab]=Math.max(minimums[prefab] || 0,row.minimum);}
    const byPrefab = new Map();
    for (const container of containers) for (const item of container.items) {
      let resource = byPrefab.get(item.prefab);
      if (!resource) { resource = {...item,variants:[],quantity:0,containerIds:[],statusCounts:{},statusContainerIds:{},minimum:minimums[item.prefab] ?? empty.defaultMinimum,status:container.status}; byPrefab.set(item.prefab,resource); }
      resource.quantity += item.quantity;
      resource.variants.push(...item.variants);
      resource.sourceIds=[...new Set([...resource.sourceIds,...item.sourceIds])];
      resource.containerIds.push(container.id);
      resource.statusCounts[container.status]=(resource.statusCounts[container.status] || 0)+1;
      (resource.statusContainerIds[container.status] ||= []).push(container.id);
      if (statusRank[container.status]>statusRank[resource.status]) resource.status = container.status;
    }
    for (const [prefab,minimum] of Object.entries(minimums)) if (empty.hostBedArea.status !== 'unset' && !byPrefab.has(prefab) && minimum>0) byPrefab.set(prefab,{...this.registry.describe({prefab,name:RUSSIAN_ITEM_NAMES[prefab] || prefab}),quantity:0,variants:[],containerIds:[],minimum,status:preferred && connected(preferred) ? 'STALE' : 'OFFLINE'});
    // A resource that was actually observed stays watchable after its last
    // stack is withdrawn or its chest disappears. The catalog alone never
    // creates zero rows; explicit zero minima disable this watch behavior.
    if(empty.hostBedArea.status !== 'unset' && empty.defaultMinimum>0) for(const observed of this.db.prepare('SELECT prefab,name FROM observed_items WHERE world_id=? ORDER BY rowid').all(selected.id)) {
      const described=this.registry.describe(observed),minimum=minimums[described.prefab] ?? empty.defaultMinimum;
      if(minimum>0 && !byPrefab.has(described.prefab)) byPrefab.set(described.prefab,{...described,quantity:0,variants:[],containerIds:[],minimum,status:preferred && connected(preferred) ? 'STALE' : 'OFFLINE'});
    }
    const resources = [...byPrefab.values()].map(resource=>({...resource,searchText:[resource.searchText,...resource.sourceIds].join(' ').toLowerCase(),availableQuantity:resource.quantity,reservedQuantity:0,reservationsImplemented:false})).sort((a,b)=>b.quantity-a.quantity || a.name.localeCompare(b.name,'ru'));
    empty.registry.inventoryUnknownItems=resources.filter(resource=>!resource.registryKnown).length;
    empty.registry.reindexRequested=empty.registry.inventoryUnknownItems>0;
    const lastConfirmed=containers.reduce((latest,container)=>latest===null?Date.parse(container.observedAt):Math.max(latest,Date.parse(container.observedAt)),null);
    return {...empty,clusterStats:summarizeClusters(resources,this.registry.clusters),source:preferred ? {connected:connected(preferred),mode:preferred.mode,coverage:preferred.coverage,scope:preferred.coverage==='authoritative' ? 'authoritative' : 'partial',lastSeenAt:iso(preferred.last_seen),lastConfirmedAt:lastConfirmed===null?null:iso(lastConfirmed),gameVersion:preferred.game_version} : empty.source,containers,resources,zones,minimums,events:this.db.prepare('SELECT id,at,text FROM events WHERE world_id=? ORDER BY id DESC LIMIT 60').all(selected.id).map(event=>({...event,at:iso(event.at)})),stats:{totalItems:resources.reduce((sum,resource)=>sum+resource.quantity,0),uniqueItems:resources.filter(resource=>resource.quantity>0).length,containers:containers.length,shortages:resources.filter(resource=>resource.quantity<resource.minimum).length}};
  }
  collectionsView(selection) {
    const state=this.state(selection),current=new Map(state.resources.map(item=>[item.prefab,item])),seen=this.observedPrefabs(state.world?.id);
    const prefabs=new Set([...state.collections.favorites,...state.collections.lists.flatMap(list=>list.prefabs)]);
    const items=[...prefabs].map(prefab=>current.get(prefab)||({...this.registry.describe({prefab,name:prefab}),catalogOnly:true,newToWorld:Boolean(state.world&&!seen.has(prefab)),quantity:0,minimum:0,containerIds:[],variants:[],availableQuantity:null,reservedQuantity:null,reservationsImplemented:false,status:'CATALOG'}));
    return {...state,collections:{...state.collections,items}};
  }
  label(worldId,id,label) {
    this.requireWorld(worldId);
    const result = this.db.prepare('UPDATE containers SET label=? WHERE world_id=? AND id=?').run(label,worldId,id);
    if (!result.changes) throw new ApiError(404, 'Контейнер не найден.', 'CONTAINER_NOT_FOUND');
    this.event(worldId,`Локальная метка: ${label || 'удалена'}`);
    this.bump();
    return this.state({worldId});
  }
  minimum(worldId,prefab,minimum) {
    this.requireWorld(worldId);
    this.registry.reload();
    const canonical=this.registry.resolve(prefab)?.prefab || prefab;
    this.transact(()=> {
      for(const row of this.db.prepare('SELECT prefab FROM minimums WHERE world_id=?').all(worldId))if((this.registry.resolve(row.prefab)?.prefab || row.prefab)===canonical)this.db.prepare('DELETE FROM minimums WHERE world_id=? AND prefab=?').run(worldId,row.prefab);
      this.db.prepare('INSERT INTO minimums VALUES(?,?,?)').run(worldId,canonical,minimum);this.bump();
    });
    return this.state({worldId});
  }
  defaultMinimum(worldId,minimum,{resetOverrides=false}={}) {
    this.requireWorld(worldId);
    if (!Number.isSafeInteger(minimum) || minimum<0 || minimum>1_000_000_000 || typeof resetOverrides!=='boolean') throw new ApiError(400,'Недопустимые параметры общего порога.');
    this.transact(()=> {
      // Existing databases gain a bounded watch set from saved observations
      // and deliberate prior minima, never from every item in the registry.
      for(const container of this.db.prepare('SELECT items FROM containers WHERE world_id=?').all(worldId)) this.rememberObservedItems(worldId,JSON.parse(container.items));
      for(const row of this.db.prepare('SELECT prefab FROM minimums WHERE world_id=?').all(worldId)) this.db.prepare('INSERT OR IGNORE INTO observed_items(world_id,prefab,name) VALUES(?,?,?)').run(worldId,row.prefab,RUSSIAN_ITEM_NAMES[row.prefab] || row.prefab);
      this.db.prepare('INSERT INTO world_preferences(world_id,default_minimum) VALUES(?,?) ON CONFLICT(world_id) DO UPDATE SET default_minimum=excluded.default_minimum').run(worldId,minimum);
      if(resetOverrides) this.db.prepare('DELETE FROM minimums WHERE world_id=?').run(worldId);
      this.event(worldId,`Общий минимальный запас: ${minimum}${resetOverrides ? '; индивидуальные пороги сброшены' : ''}.`);
      this.bump();
    });
    return this.state({worldId});
  }
  zone(worldId,zone,id) {
    this.requireWorld(worldId);
    if (id && !this.db.prepare('SELECT id FROM zones WHERE world_id=? AND id=?').get(worldId,id)) throw new ApiError(404,'Складская зона не найдена.','ZONE_NOT_FOUND');
    const zoneId = id || randomUUID();
    this.db.prepare('INSERT INTO zones VALUES(?,?,?,?,?,?,?,0) ON CONFLICT(world_id,id) DO UPDATE SET name=excluded.name,x=excluded.x,z=excluded.z,radius=excluded.radius,enabled=excluded.enabled,proposed=0').run(worldId,zoneId,zone.name,zone.x,zone.z,zone.radius,zone.enabled?1:0);
    this.bump(); return this.state({worldId});
  }
  startDemo() {
    if (!this.demo) throw new Error('Demo is isolated from real inventory.');
    this.db.exec('DELETE FROM resource_list_items; DELETE FROM resource_lists; DELETE FROM resource_favorites; DELETE FROM worlds; DELETE FROM sources; DELETE FROM sessions; DELETE FROM containers; DELETE FROM zones; DELETE FROM minimums; DELETE FROM world_preferences; DELETE FROM observed_items; DELETE FROM events; DELETE FROM host_beds;');
    this.ingest({sourceId:'demo-fixture',worldId:'demo-midgard',worldName:'Мидгард · ДЕМО',mode:'client',coverage:'partial',sessionId:randomUUID(),sequence:0,gameVersion:'DEMO — синтетические данные',containers:[
      {id:'demo:main-chest',type:'piece_chest',name:'Деревянный сундук',x:120,y:12,z:-48,observedAt:this.now(),items:[{prefab:'Wood',name:'Древесина',quantity:160},{prefab:'Stone',name:'Камень',quantity:285},{prefab:'Resin',name:'Смола',quantity:36}]},
      {id:'demo:forge-chest',type:'piece_chest_private',name:'Укреплённый сундук',x:136,y:12,z:-42,observedAt:this.now(),items:[{prefab:'Wood',name:'Древесина',quantity:80},{prefab:'Iron',name:'Железо',quantity:42},{prefab:'Copper',name:'Медь',quantity:68},{prefab:'Coal',name:'Уголь',quantity:110}]},
      {id:'demo:food-chest',type:'piece_chest',name:'Деревянный сундук',x:112,y:12,z:-61,observedAt:this.now(),items:[{prefab:'Honey',name:'Мёд',quantity:48},{prefab:'Carrot',name:'Морковь',quantity:62},{prefab:'Raspberry',name:'Малина',quantity:84},{prefab:'CarrotSeeds',name:'Семена моркови',quantity:34}]},
      {id:'demo:remote-chest',type:'piece_chest',name:'Дальний сундук',x:1120,y:5,z:-61,observedAt:this.now()-120_000,items:[{prefab:'FineWood',name:'Качественная древесина',quantity:65},{prefab:'TrophyDeer',name:'Трофей: олень',quantity:8},{prefab:'Coins',name:'Монеты',quantity:120}]}
    ],destroyedIds:[]});
    for (const [id,label] of [['demo:main-chest','Главный склад'],['demo:forge-chest','Кузница'],['demo:food-chest','Продовольствие'],['demo:remote-chest','Пристань · последнее известное']]) this.db.prepare('UPDATE containers SET label=? WHERE id=?').run(label,id);
    for (const [prefab,min] of [['Wood',300],['Stone',300],['Iron',50]]) this.db.prepare('INSERT INTO minimums VALUES(?,?,?)').run('demo-midgard',prefab,min);
    this.event('demo-midgard','ДЕМО: синтетические контейнеры. Игровые данные не используются.');
    this.bump(); return this.state();
  }
  demoStep(action) {
    if (!this.demo) throw new Error('Demo only');
    this.requireWorld('demo-midgard');
    const source = this.db.prepare("SELECT * FROM sources WHERE world_id='demo-midgard'").get();
    if (action==='disconnect' || action==='reconnect') {
      this.db.prepare('UPDATE sources SET force_offline=?,last_seen=? WHERE world_id=?').run(action==='disconnect'?1:0,this.now(),'demo-midgard');
      if (action==='reconnect') this.db.prepare("UPDATE containers SET observed_at=? WHERE world_id='demo-midgard' AND id!='demo:remote-chest'").run(this.now());
      this.event('demo-midgard',action==='disconnect'?'ДЕМО: источник отключён, последние остатки сохранены.':'ДЕМО: источник подключён заново.');
      this.bump(); return this.state();
    }
    const main = this.db.prepare("SELECT * FROM containers WHERE id='demo:main-chest'").get();
    const forge = this.db.prepare("SELECT * FROM containers WHERE id='demo:forge-chest'").get();
    const mainItems = JSON.parse(main.items), forgeItems=JSON.parse(forge.items);
    if (action==='add40') mainItems.find(item=>item.prefab==='Wood').quantity+=40;
    if (action==='move') { const amount=Math.min(20,mainItems.find(item=>item.prefab==='Wood').quantity); mainItems.find(item=>item.prefab==='Wood').quantity-=amount; forgeItems.find(item=>item.prefab==='Wood').quantity+=amount; }
    const containers = [main,forge].map((container,index)=>({id:container.id,type:container.type,name:container.name,x:container.x,y:container.y,z:container.z,items:index===0?mainItems:forgeItems,observedAt:this.now()}));
    const sequence=this.db.prepare('SELECT sequence FROM sessions WHERE world_id=? AND source_id=? AND session_id=?').get(source.world_id,source.id,source.session_id).sequence+1;
    this.ingest({worldId:source.world_id,worldName:'Мидгард · ДЕМО',sourceId:source.id,sessionId:source.session_id,sequence,mode:source.mode,coverage:source.coverage,gameVersion:source.game_version,containers,destroyedIds:[]});
    if(source.force_offline) this.db.prepare('UPDATE sources SET force_offline=1 WHERE world_id=?').run(source.world_id);
    return this.state();
  }
  tickDemo() {
    if (!this.demo) return;
    const source = this.db.prepare("SELECT * FROM sources WHERE world_id='demo-midgard'").get();
    if (!source || source.force_offline) return;
    this.db.prepare('UPDATE sources SET last_seen=? WHERE world_id=?').run(this.now(),'demo-midgard');
    this.db.prepare("UPDATE containers SET observed_at=? WHERE world_id='demo-midgard' AND id!='demo:remote-chest'").run(this.now());
  }
}
