import { readFileSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Independent reader for ChestSorter's documented text format. No mod code is loaded.
const fold = value => value.toLowerCase();
const kinds = ['override', 'prefix', 'endswith', 'contains', 'suffix'];
const itemTypes = {0:'None',1:'Material',2:'Consumable',3:'OneHandedWeapon',4:'Bow',5:'Shield',6:'Helmet',7:'Chest',9:'Ammo',10:'Customization',11:'Legs',12:'Hands',13:'Trophy',14:'TwoHandedWeapon',15:'Torch',16:'Misc',17:'Shoulder',18:'Utility',19:'Tool',20:'Attach_Atgeir',21:'Fish',22:'TwoHandedWeaponLeft',23:'AmmoNonEquipable',24:'Trinket'};
const invalid = (line, code) => { const error = Error('Invalid category rules'); Object.assign(error, { line, code }); throw error; };

export function parseChestSorterRules(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 256 * 1024 || /[\0\x01-\x08\x0b\x0c\x0e-\x1f]/.test(text)) invalid(0,'RULES_SIZE_OR_ENCODING');
  const categories = new Map(), aliases = new Map(), types = new Map(), colors = new Map(), parents = new Map();
  const rules = Object.fromEntries(kinds.map(kind => [kind, []]));
  let version = 0;
  for (const [index, raw] of text.replace(/^\uFEFF/,'').split('\n').entries()) {
    const line = raw.split('#',1)[0].trim(); if (!line) continue;
    const parts = line.split('|').map(part => part.trim()), kind = fold(parts[0]);
    if (parts.some(part => !part || part.length > 500)) invalid(index+1,'RULE_FIELDS');
    if (kind === 'version' && parts.length === 2 && /^\d+$/.test(parts[1])) { version = Number(parts[1]); continue; }
    if (kind === 'category' && parts.length === 3) { if (!categories.has(fold(parts[1]))) categories.set(fold(parts[1]),{id:parts[1],name:parts[2]}); continue; }
    const maps = { alias:aliases, itemtype:types, foodcolor:colors, parent:parents };
    if (Object.hasOwn(maps,kind) && parts.length === 3) { maps[kind].set(fold(parts[1]),parts[2]); continue; }
    if (kinds.includes(kind) && parts.length === 4) { rules[kind].push({scope:fold(parts[1]),pattern:parts[2],category:parts[3]}); continue; }
    invalid(index+1,'RULE_SYNTAX');
  }
  if (!Number.isInteger(version) || version < 1 || version > 4 || !categories.size || categories.size > 2000) invalid(0,'RULES_VERSION_OR_CATEGORIES');
  for (const id of [...Object.values(rules).flat().map(rule=>rule.category),...aliases.values(),...types.values(),...colors.values(),...parents.keys(),...parents.values()]) if (!categories.has(fold(id))) invalid(0,'UNDECLARED_CATEGORY');
  const resolveId = id => { for(let hops=0;hops<8 && aliases.has(fold(id));hops++) id=aliases.get(fold(id)); return categories.get(fold(id))?.id || id; };
  for (const category of categories.values()) category.parentId = parents.has(fold(resolveId(category.id))) ? resolveId(parents.get(fold(resolveId(category.id)))) : null;
  return {version,categories:[...categories.values()],rules,types,colors,resolveId};
}

export function chestSorterFoodColor(metadata, type) {
  if (fold(type || '') !== 'consumable') return null;
  const h=metadata.foodHealth ?? metadata.food, s=metadata.foodStamina, e=metadata.foodEitr;
  if (![h,s,e].every(value=>typeof value==='number' && Number.isFinite(value))) return undefined;
  if (h<=0 && s<=0 && e<=0) return null;
  if (h<e/2 && s<e/2) return 'Eitr';
  if (s<h/2) return 'Health';
  if (h<s/2) return 'Stamina';
  return 'Balanced';
}

export function classifyChestSorter(item, rules) {
  const metadata=item.metadata || {}, rawType=metadata.itemTypeName ?? metadata.itemType ?? metadata.itemTypeValue;
  const type=typeof rawType==='string' && !/^\d+$/.test(rawType) ? rawType : itemTypes[rawType];
  const prefab=item.prefab || '', name=fold(prefab), words=prefab.match(/[A-Z][a-z0-9]*|[a-z0-9]+/g), last=fold(words?.at(-1) || prefab);
  const result=(id,reason)=>({categoryId:rules.resolveId(id),reason});
  const unresolved=reason=>({categoryId:null,reason});
  if (/^hash:/.test(prefab)) return unresolved('missing-prefab');
  const matches={override:pattern=>name===pattern,prefix:pattern=>name.startsWith(pattern),endswith:pattern=>name.endsWith(pattern),contains:pattern=>name.includes(pattern),suffix:pattern=>last===pattern};
  for (const kind of kinds) for (const rule of rules.rules[kind]) {
    if (!matches[kind](fold(rule.pattern))) continue;
    if (rule.scope!=='*' && !type) return unresolved('missing-item-type');
    if (rule.scope==='*' || rule.scope===fold(type)) return result(rule.category,kind);
  }
  if (!type || /^unknown$/i.test(type)) return unresolved('missing-item-type');
  const color=chestSorterFoodColor(metadata,type);
  if (color===undefined && rules.colors.size) return unresolved('missing-food-data');
  if (color && rules.colors.has(fold(color))) return result(rules.colors.get(fold(color)),'foodcolor');
  if (rules.types.has(fold(type))) return result(rules.types.get(fold(type)),'itemtype');
  return result(fold(type)==='material'?'Misc':type,'fallback');
}

function plainFile(path) {
  for(let at=resolve(path);;at=dirname(at)) { if(lstatSync(at).isSymbolicLink()) throw Error('Link'); if(dirname(at)===at) break; }
  const before=lstatSync(path); if(!before.isFile() || before.size>256*1024) throw Error('Bounds');
  const bytes=readFileSync(path),after=lstatSync(path);
  if(before.size!==after.size || before.mtimeMs!==after.mtimeMs || before.ino!==after.ino || bytes.length!==after.size) throw Error('Changed');
  return bytes;
}

export class ChestSorterReader {
  constructor(gameDirectory) { this.gameDirectory=gameDirectory; }
  view(state, {registry, observedPrefabs=new Set()}={}) {
    let rules, info;
    try {
      const directory=this.gameDirectory?.();
      if(!directory || !isAbsolute(directory)) throw Object.assign(Error('Missing'),{code:'ENOENT'});
      const bytes=plainFile(join(directory,'BepInEx','config','ChestSorter.categories.txt'));
      const sha256=createHash('sha256').update(bytes).digest('hex');
      if(this.hash!==sha256) { this.parsed=parseChestSorterRules(new TextDecoder('utf-8',{fatal:true}).decode(bytes));this.hash=sha256; }
      rules=this.parsed;
      info={status:'ready',version:rules.version,sha256,categories:rules.categories};
    } catch(error) {
      info={status:error.code==='ENOENT'?'unavailable':'invalid',categories:[],error:error.line===undefined?null:{line:error.line,code:error.code}};
    }
    const decorate=item=>({...item,chestSorter:rules?classifyChestSorter(item,rules):{categoryId:null,reason:'rules-unavailable'}});
    const resources=state.resources.map(decorate);
    // The full definition catalog is separate from stock, thresholds and source freshness.
    // History is world-wide: consumption, zone changes and the 500m boundary do not reset it.
    const catalog=new Map(resources.map(item=>[item.prefab,{...item,catalogOnly:false,newToWorld:false}]));
    const seen=new Set([...observedPrefabs].map(prefab=>registry?.resolve(prefab)?.prefab || prefab));
    for(const prefab of new Set([...(registry?.entries.keys() || []),...seen])) {
      if(catalog.has(prefab)) continue;
      const definition=registry?.describe({prefab,name:prefab}) || {id:'prefab:'+prefab,prefab,name:prefab};
      catalog.set(prefab,decorate({...definition,catalogOnly:true,newToWorld:Boolean(state.world && !seen.has(prefab)),quantity:0,minimum:0,containerIds:[],variants:[],availableQuantity:null,reservedQuantity:null,reservationsImplemented:false,status:'CATALOG'}));
    }
    const items=[...catalog.values()],registered=registry?.entries.size || 0,definitionsFound=registry?.manifest?.coverage?.definitionsFound || 0;
    return {...state,resources,chestSorter:{...info,catalog:items,catalogSummary:{registered,definitionsFound,unresolvedDefinitions:Math.max(0,definitionsFound-registered),totalItems:items.length,newItems:items.filter(item=>item.newToWorld).length,trackedItems:state.world?items.filter(item=>!item.newToWorld).length:null}}};
  }
}

export function configuredGameDirectory(dataDir) {
  try {
    const value=JSON.parse(readFileSync(join(dataDir,'desktop-game.json'),'utf8').replace(/^\uFEFF/,''));
    return typeof value?.gameDirectory==='string'?value.gameDirectory:null;
  } catch { return null; }
}
