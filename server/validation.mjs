import { ApiError } from './store.mjs';

const fail = message => { throw new ApiError(400,message); };
export function object(value,label='JSON') { if (!value || typeof value!=='object' || Array.isArray(value)) fail(`${label}: ожидается объект.`); return value; }
export function string(value,label,max=200,{empty=false}={}) {
  if(typeof value!=='string' || (!empty && !value.trim()) || value.length>max || /[\u0000-\u001f]/.test(value)) fail(`${label}: недопустимая строка.`);
  return value;
}
export function number(value,label,{min=-10_000_000,max=10_000_000,integer=false}={}) {
  if (typeof value!=='number' || !Number.isFinite(value) || value<min || value>max || (integer && !Number.isSafeInteger(value))) fail(`${label}: недопустимое число.`);
  return value;
}
export function worldBody(value) { object(value); return string(value.worldId,'worldId',160); }
export function validateIngest(value) {
  object(value);
  for(const key of ['sourceId','worldId','sessionId']) string(value[key],key,160);
  string(value.worldName,'worldName',200);
  string(value.gameVersion,'gameVersion',120);
  if(!['client','host','server','snapshot'].includes(value.mode)) fail('mode: ожидается client, host, server или snapshot.');
  if(!['partial','authoritative'].includes(value.coverage)) fail('coverage: ожидается partial или authoritative.');
  // A network role by itself does not prove all-world visibility. The collector
  // must opt in to an explicitly verified authoritative scan, never infer it.
  if(value.coverage==='authoritative' && ['client','snapshot'].includes(value.mode)) fail('Этот источник не может объявлять полный охват.');
  number(value.sequence,'sequence',{min:0,max:Number.MAX_SAFE_INTEGER,integer:true});
  if(!Array.isArray(value.containers) || value.containers.length>5000) fail('containers: требуется массив не более 5000 контейнеров.');
  if(!Array.isArray(value.destroyedIds) || value.destroyedIds.length>5000) fail('destroyedIds: требуется массив.');
  const runtimeIds=new Set(),identities=new Set();
  for(const container of value.containers) {
    object(container,'container');
    for(const key of ['id','type','name']) string(container[key],`container.${key}`,key==='id'?200:240);
    if(runtimeIds.has(container.id)) fail('Повторяющийся ZDOID в одном пакете.');
    runtimeIds.add(container.id);
    if(container.identityKey!==undefined) {
      string(container.identityKey,'identityKey',500);
      if(identities.has(container.identityKey)) fail('Неоднозначные контейнеры с одинаковой identityKey.');
      identities.add(container.identityKey);
    }
    for(const key of ['x','y','z']) number(container[key],`container.${key}`);
    if((typeof container.observedAt!=='string' && typeof container.observedAt!=='number') || !Number.isFinite(typeof container.observedAt==='number'?container.observedAt:Date.parse(container.observedAt))) fail('observedAt: требуется корректное время.');
    const observed=typeof container.observedAt==='number'?container.observedAt:Date.parse(container.observedAt);
    if(observed<0 || observed>8.64e15) fail('observedAt: время вне диапазона.');
    if(!Array.isArray(container.items) || container.items.length>2048) fail('items: требуется массив не более 2048 строк.');
    const totals=new Map();
    for(const item of container.items) {
      object(item,'item'); string(item.prefab,'prefab',200); string(item.name,'item.name',240);
      if(item.category!==undefined) string(item.category,'item.category',100);
      number(item.quantity,'quantity',{min:0,max:1_000_000_000,integer:true});
      const total=(totals.get(item.prefab)||0)+item.quantity;
      if(total>1_000_000_000) fail('Суммарное количество предмета вне диапазона.');
      totals.set(item.prefab,total);
    }
  }
  const destroyed=new Set();
  for(const id of value.destroyedIds) {
    string(id,'destroyedId',200);
    if(runtimeIds.has(id)) fail('Контейнер одновременно обновлён и уничтожен.');
    if(destroyed.has(id)) fail('Повторяющийся destroyedId.');
    destroyed.add(id);
  }
  return value;
}
export function validateZone(value) {
  worldBody(value); string(value.name,'name',120);
  number(value.x,'x');number(value.z,'z');number(value.radius,'radius',{min:1,max:100_000});
  if(typeof value.enabled!=='boolean') fail('enabled: требуется true или false.');
  return value;
}
