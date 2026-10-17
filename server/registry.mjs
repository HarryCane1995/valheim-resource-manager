import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RUSSIAN_ITEM_NAMES } from './catalog.mjs';
import { classifyItem, SYSTEM_CLUSTERS } from './clusters.mjs';

export const CATEGORIES = Object.freeze(['Древесина и растения','Камень и минералы','Руды и металлы','Строительные материалы','Сельское хозяйство','Сырые продукты','Приготовленная еда','Ингредиенты','Трофеи','Кожа, кости и ткани','Оружие','Броня','Инструменты','Боеприпасы','Зелья и расходники','Ценные предметы','Ключевые и специальные предметы','Прочее']);
export const ICON_KEY = /^[a-f0-9]{64}$/;
const ITEM_TYPE_NAMES={0:'None',1:'Material',2:'Consumable',3:'OneHandedWeapon',4:'Bow',5:'Shield',6:'Helmet',7:'Chest',9:'Ammo',10:'Customization',11:'Legs',12:'Hands',13:'Trophy',14:'TwoHandedWeapon',15:'Torch',16:'Misc',17:'Shoulder',18:'Utility',19:'Tool',20:'Attach_Atgeir',21:'Fish',22:'TwoHandedWeaponLeft',23:'AmmoNonEquipable',24:'Trinket'};
const PNG_SIGNATURE = Buffer.from([137,80,78,71,13,10,26,10]);
const fail = (message,code='INVALID_REGISTRY',status=400) => { const error=new Error(message);Object.assign(error,{status,code});throw error; };
const validString = (value,max=240) => typeof value==='string' && value.length<=max && !/[\u0000-\u001f]/.test(value);
const nameOrEmpty = value => validString(value) ? value : '';
const signature = file => {try{const stat=statSync(file);return `${stat.mtimeMs}:${stat.size}`;}catch{return '-';}};
const isFile = file => {try{return statSync(file).isFile();}catch{return false;}};
function atomicJson(file,value) {mkdirSync(resolve(file,'..'),{recursive:true});const temp=file+'.tmp';writeFileSync(temp,JSON.stringify(value,null,2)+'\n');renameSync(temp,file);}

// The exact UTF-16 GetStableHashCode algorithm used by Valheim; hash aliases are
// accepted only when exactly one prefab has this signed 32-bit value.
export function prefabHash(value) {
  let first=5381,second=5381;
  for(let i=0;i<value.length;i+=2) {first=((first<<5)+first)^value.charCodeAt(i);if(i+1<value.length)second=((second<<5)+second)^value.charCodeAt(i+1);}
  return (first+Math.imul(second,1566083941))|0;
}

export function categoryFor(prefab,metadata={}) {
  const rawType=metadata.itemTypeName ?? metadata.itemType ?? metadata.itemTypeValue ?? '';
  const p=prefab.toLowerCase(),type=String(Object.hasOwn(ITEM_TYPE_NAMES,rawType)?ITEM_TYPE_NAMES[rawType]:rawType).toLowerCase();
  if(metadata.questItem===true)return 'Ключевые и специальные предметы';
  if(['helmet','chest','legs','hands','shoulder','utility','trinket'].includes(type))return 'Броня';
  if(type==='tool')return 'Инструменты';
  if(['ammo','ammononequipable'].includes(type))return 'Боеприпасы';
  if(['onehandedweapon','twohandedweapon','twohandedweaponleft','bow','shield','attach_atgeir','torch'].includes(type))return 'Оружие';
  if(type==='fish')return 'Сырые продукты';
  if(/trophy/.test(p+type))return 'Трофеи';
  if(/(arrow|bolt|ammo|bomb|missile)/.test(p+type))return 'Боеприпасы';
  if(/(pickaxe|hammer|cultivator|fishingrod|tool)/.test(p+type) || p==='hoe')return 'Инструменты';
  if(/(helmet|armor|cape|belt|utility|chestarmor|legarmor|shoulder)/.test(p+type))return 'Броня';
  if(/(sword|axe|mace|spear|bow|crossbow|shield|knife|atgeir|staff|fists|weapon|torch)/.test(p+type))return 'Оружие';
  if(metadata.isDrink===true || /(mead|potion|pukeberries)/.test(p+type))return 'Зелья и расходники';
  if(/(seed|sapling|cone$|barley$|flax$|vineberry)/.test(p))return 'Сельское хозяйство';
  if(/(wood|roundlog|elderbark|ancientbark|dandelion|thistle|plant)/.test(p))return 'Древесина и растения';
  if(/(ore$|scrap|copper$|bronze$|iron$|silver$|tin$|blackmetal|flametal)/.test(p) && !/leather/.test(p))return 'Руды и металлы';
  if(/(stone|coal|marble|flint|obsidian|crystal|grausten)/.test(p))return 'Камень и минералы';
  if(/(tar$|resin$|core$|chain$|nails$|blackcore|thunderstone|ironpit|eitr$)/.test(p))return 'Строительные материалы';
  if(/(hide|pelt|leather|bone|feather|thread|jute|chitin)/.test(p))return 'Кожа, кости и ткани';
  if(/(coins|ruby|amber|necklace|pearl|valuable)/.test(p+type))return 'Ценные предметы';
  if(/(key|wishbone|yagluth|dragontear|crypt|quest|dvergerneedle|sealbreaker)/.test(p+type))return 'Ключевые и специальные предметы';
  if(/(cooked|roasted|stew|soup|sausage|bread|pie$|pudding|salad|omelette|jerky|skewer|mash|pottage|platter|misthare|seekeraspic)/.test(p))return 'Приготовленная еда';
  if(/(raw|meat|fish|necktail|hare|egg$)/.test(p))return 'Сырые продукты';
  if(/(berry|berries|mushroom|honey|carrot|turnip|onion|flour|blood|sap$|entrails|royaljelly|gland|greydwarfeye|guck|ooze)/.test(p))return 'Ингредиенты';
  if(Number(metadata.foodHealth)>0 || Number(metadata.foodStamina)>0 || Number(metadata.food)>0)return 'Приготовленная еда';
  if(metadata.buildPieces===true)return 'Инструменты';
  if(Number(metadata.value)>0)return 'Ценные предметы';
  return 'Прочее';
}

function sourceInfo(value,fallback='installed-assets') {
  const kind=typeof value==='string'?value:value?.kind || fallback;
  if(!['installed-assets','runtime-objectdb'].includes(kind))fail('Неподдерживаемый источник реестра.');
  const result={kind};
  for(const key of ['exporter','version','assetFormat','method','assemblyVersion','gameVersion'])if(validString(value?.[key],240))result[key]=value[key];
  return result;
}

export function validateRegistry(value) {
  if(!value || typeof value!=='object' || value.schemaVersion!==1 || !Array.isArray(value.items) || value.items.length>20_000)fail('Ожидается manifest schemaVersion=1 и массив items (до 20000).');
  if(!validString(value.gameVersion,120) || !value.gameVersion.trim())fail('gameVersion отсутствует.');
  if(!validString(value.generatedAt,80) || !Number.isFinite(Date.parse(value.generatedAt)))fail('generatedAt: требуется ISO-время.');
  const source=sourceInfo(value.source),seen=new Set();
  const items=value.items.map(entry=> {
    if(!entry || !validString(entry.prefab,200) || !entry.prefab.trim())fail('Недопустимый prefab.');
    const id='prefab:'+entry.prefab;
    if(entry.id!==id || seen.has(id))fail('DUPLICATE ID или id не соответствует prefab.','DUPLICATE_ID');seen.add(id);
    const hash=prefabHash(entry.prefab);
    if(entry.prefabHash!==undefined && entry.prefabHash!==hash)fail(`Хеш prefab не соответствует алгоритму Valheim: ${entry.prefab}.`,'HASH_MISMATCH');
    if(entry.maxStack!==null && (!Number.isInteger(entry.maxStack) || Math.abs(entry.maxStack)>1_000_000_000))fail(`maxStack: ${entry.prefab}.`);
    if(entry.iconKey!==undefined && entry.iconKey!==null && (typeof entry.iconKey!=='string' || !ICON_KEY.test(entry.iconKey)))fail('Недопустимый ключ пиктограммы.');
    const metadata=entry.metadata && typeof entry.metadata==='object' && !Array.isArray(entry.metadata)?{...entry.metadata}:{};
    if(Buffer.byteLength(JSON.stringify(metadata))>32_768)fail('Метаданные предмета слишком велики.');
    const category=CATEGORIES.includes(entry.category)?entry.category:categoryFor(entry.prefab,metadata);
    const diagnostics=new Set((Array.isArray(entry.diagnostics)?entry.diagnostics:[]).filter(entry=>validString(entry,100)));
    if(entry.maxStack===null || entry.maxStack<=0) {diagnostics.add('INVALID MAX STACK');if(!Object.hasOwn(metadata,'rawMaxStack'))metadata.rawMaxStack=entry.maxStack;}
    const nameRu=nameOrEmpty(entry.nameRu),nameEn=nameOrEmpty(entry.nameEn);
    if(!nameRu || !nameEn || nameRu.startsWith('$') || nameEn.startsWith('$'))diagnostics.add('MISSING LOCALIZATION');
    if(category==='Прочее')diagnostics.add('CATEGORY UNRESOLVED');
    return {id,prefab:entry.prefab,prefabHash:hash,nameRu,nameEn,category,subcategory:nameOrEmpty(entry.subcategory),maxStack:entry.maxStack>0?entry.maxStack:null,iconKey:entry.iconKey || null,source:sourceInfo(entry.source,source.kind),metadata,diagnostics:[...diagnostics]};
  });
  const definitionsFound=value.coverage?.definitionsFound;
  if(!Number.isInteger(definitionsFound) || definitionsFound<items.length || definitionsFound>1_000_000)fail('coverage.definitionsFound меньше числа items или вне диапазона.');
  const runtimeVerified=source.kind==='runtime-objectdb' && value.coverage?.runtimeVerified===true;
  const coverage={definitionsFound,registered:items.length,scope:source.kind,runtimeVerified};
  for(const key of ['recognizedItemDrops','invalidObjectDbEntries','duplicateIds','hashCollisions','itemsWithIcons','iconVariantsFound','iconVariantsExported','assetsScanned','itemDropDefinitionsFound','unresolvedObjectDbReferences','missingEnglish','missingRussian','missingIcons'])if(value.coverage?.[key]!==undefined) {const count=value.coverage[key];if(!Number.isSafeInteger(count) || count<0 || count>1_000_000)fail(`coverage.${key}: недопустимый счётчик.`);coverage[key]=count;}
  coverage.complete=value.coverage?.complete===true && items.length===definitionsFound && !(coverage.invalidObjectDbEntries || coverage.duplicateIds || coverage.unresolvedObjectDbReferences);
  if(Array.isArray(value.coverage?.limitations))coverage.limitations=value.coverage.limitations.filter(value=>validString(value,500)).slice(0,40);
  return {schemaVersion:1,gameVersion:value.gameVersion,source,generatedAt:value.generatedAt,items,coverage};
}

export class ItemRegistry {
  constructor(localDataDir) {
    this.directory=resolve(localDataDir);this.file=resolve(this.directory,'registry/items.json');this.overridesFile=resolve(this.directory,'registry/overrides.json');this.clustersFile=resolve(this.directory,'registry/clusters.json');this.iconDirectory=resolve(this.directory,'icons');
    this.iconCacheFile=resolve(this.directory,'registry/icon-cache.json');this.installedFile=resolve(this.directory,'installed-assets/registry/items.json');this.installedIconDirectory=resolve(this.directory,'installed-assets/icons');this.iconCache=new Map();this.iconCacheError=null;this.iconCacheDirty=false;
    try {if(existsSync(this.iconCacheFile)){const saved=JSON.parse(readFileSync(this.iconCacheFile,'utf8'));if(saved.schemaVersion!==1 || !Array.isArray(saved.items) || saved.items.length>100000)throw Error();for(const item of saved.items)if(validString(item.prefab,200)&&validString(item.gameVersion,120)&&ICON_KEY.test(item.iconKey))this.iconCache.set(JSON.stringify([item.gameVersion,item.prefab]),item);}}
    catch{this.iconCacheError='ICON_CACHE_LOAD_FAILED';}
    this.generation=0;this.filesSignature='';this.manifest=null;this.entries=new Map();this.hashes=new Map();this.overrides={};this.customClusters=[];this.clusters=[...SYSTEM_CLUSTERS];this.loadError=null;this.reload();
  }
  reload(force=false) {
    const fingerprint=signature(this.file)+'|'+signature(this.overridesFile)+'|'+signature(this.clustersFile)+'|'+signature(this.installedFile);
    if(!force && fingerprint===this.filesSignature)return false;
    let manifest=null,overrides={},customClusters=[];
    try {if(existsSync(this.file))manifest=validateRegistry(JSON.parse(readFileSync(this.file,'utf8')));if(existsSync(this.overridesFile))overrides=JSON.parse(readFileSync(this.overridesFile,'utf8'));if(!overrides || typeof overrides!=='object' || Array.isArray(overrides))throw new Error('Invalid overrides');if(existsSync(this.clustersFile))customClusters=JSON.parse(readFileSync(this.clustersFile,'utf8'));if(!Array.isArray(customClusters) || customClusters.length>100 || customClusters.some(value=>!/^custom-[a-f0-9-]{36}$/.test(value?.id) || !validString(value.name,80) || !value.name.trim()) || new Set(customClusters.map(value=>value.id)).size!==customClusters.length)throw new Error('Invalid clusters');customClusters=customClusters.map(value=>({id:value.id,name:value.name,system:false,categories:[{id:'items',name:'Предметы'}]}));}
    catch(error){this.loadError=error.code || 'REGISTRY_LOAD_FAILED';this.filesSignature=fingerprint;this.generation++;return true;}
    try {if(existsSync(this.installedFile)){const installed=validateRegistry(JSON.parse(readFileSync(this.installedFile,'utf8')));for(const entry of installed.items)this.rememberIcon(installed.gameVersion,entry.prefab,entry.iconKey,'installed-assets');}}
    catch{this.iconCacheError='INSTALLED_ICON_CACHE_LOAD_FAILED';}
    this.manifest=manifest;this.overrides=overrides;this.customClusters=customClusters;this.clusters=[...SYSTEM_CLUSTERS,...customClusters];this.entries=new Map();this.hashes=new Map();this.loadError=null;
    for(const entry of manifest?.items || []) {
      const override=Object.hasOwn(overrides,entry.prefab)?overrides[entry.prefab]:undefined;
      const item={...entry,...(CATEGORIES.includes(override?.category)?{category:override.category,subcategory:nameOrEmpty(override.subcategory),categoryOverridden:true}:{})};
      const sourceKey=item.iconKey,version=manifest.gameVersion;
      const direct=!!sourceKey && !!this.iconFile(sourceKey);
      if(direct)this.rememberIcon(version,item.prefab,sourceKey,manifest.source.kind);
      const cached=this.iconCache.get(JSON.stringify([version,item.prefab]));
      const effectiveKey=direct?sourceKey:cached&&this.iconFile(cached.iconKey)?cached.iconKey:null;
      const iconAvailable=!!effectiveKey;
      item.iconUrl=iconAvailable?'/api/icons/'+effectiveKey+'.png':null;
      item.iconSource=direct?manifest.source.kind:effectiveKey?'last-known-good':null;
      item.iconFallback=!!effectiveKey&&!direct;
      item.diagnostics=item.diagnostics.filter(value=>value!=='MISSING ICON');
      if(!iconAvailable)item.diagnostics.push('MISSING ICON');
      if(item.categoryOverridden)item.diagnostics=item.diagnostics.filter(value=>value!=='CATEGORY UNRESOLVED');
      this.entries.set(item.prefab,item);
      const matches=this.hashes.get(item.prefabHash) || [];matches.push(item);this.hashes.set(item.prefabHash,matches);
    }
    for(const item of this.entries.values()) {
      const hashAlias='hash:'+item.prefabHash;
      const override=Object.hasOwn(overrides,item.prefab)?overrides[item.prefab]:(this.hashes.get(item.prefabHash)?.length===1 && Object.hasOwn(overrides,hashAlias)?overrides[hashAlias]:undefined);
      Object.assign(item,classifyItem(item,override,this.clusters));
      if(item.clusterId==='unclassified')item.diagnostics.push('CLUSTER UNRESOLVED');
    }
    for(const matches of this.hashes.values())if(matches.length>1)for(const item of matches)item.diagnostics=[...new Set([...item.diagnostics,'HASH COLLISION'])];
    if(this.iconCacheDirty){atomicJson(this.iconCacheFile,{schemaVersion:1,items:[...this.iconCache.values()]});this.iconCacheDirty=false;}
    this.filesSignature=fingerprint;this.generation++;return true;
  }
  rememberIcon(gameVersion,prefab,iconKey,source) {
    if(!iconKey || !ICON_KEY.test(iconKey) || !gameVersion || /^unknown/i.test(gameVersion) || !this.iconFile(iconKey))return;
    const key=JSON.stringify([gameVersion,prefab]),previous=this.iconCache.get(key);
    if(previous?.iconKey===iconKey)return;
    // The installed bootstrap must not replace a newer successful runtime image.
    if(source==='installed-assets' && previous?.source==='runtime-objectdb' && this.iconFile(previous.iconKey))return;
    this.iconCache.set(key,{gameVersion,prefab,iconKey,source});this.iconCacheDirty=true;
  }
  resolve(token) {
    if(this.entries.has(token))return this.entries.get(token);
    const match=/^hash:(-?\d+)$/.exec(token);
    if(match) {const entries=this.hashes.get(Number(match[1]));if(entries?.length===1)return entries[0];}
    return null;
  }
  describe(item) {
    const definition=this.resolve(item.prefab),prefab=definition?.prefab || item.prefab;
    const hashCollision=/^hash:/.test(prefab) && (this.hashes.get(Number(prefab.slice(5)))?.length || 0)>1;
    const translated=value=>typeof value==='string' && value.trim() && !value.startsWith('$')?value:null;
    const nameRu=definition?(translated(definition.nameRu) || RUSSIAN_ITEM_NAMES[prefab] || translated(definition.nameEn) || prefab):(RUSSIAN_ITEM_NAMES[prefab] || item.name || prefab);
    const nameEn=definition?(translated(definition.nameEn) || prefab):(item.name || prefab);
    const override=Object.hasOwn(this.overrides,prefab)?this.overrides[prefab]:undefined;
    const classification=definition || classifyItem(item,override,this.clusters,{known:false});
    return {...item,...(definition || {}),id:definition?.id || 'prefab:'+prefab,prefab,name:nameRu,nameRu,nameEn,category:definition?.category || (CATEGORIES.includes(override?.category)?override.category:'Неопознанные'),subcategory:definition?.subcategory || override?.subcategory || '',clusterId:classification.clusterId,clusterName:classification.clusterName,clusterCategoryId:classification.clusterCategoryId,clusterCategory:classification.clusterCategory,classificationSource:classification.classificationSource,tags:classification.tags,iconUrl:definition?.iconUrl || null,maxStack:definition?.maxStack || null,diagnostics:definition?.diagnostics || ['UNKNOWN ITEM',...(hashCollision?['HASH COLLISION']:[]),...(classification.clusterId==='unclassified'?['CLUSTER UNRESOLVED']:[])],registryKnown:!!definition,sourceIds:[...new Set([...(item.sourceIds || []),item.prefab])],searchText:[prefab,definition?.id || 'prefab:'+prefab,nameRu,nameEn,definition?.prefabHash,item.prefab,classification.clusterName,classification.clusterCategory,...classification.tags].filter(value=>value!==undefined).join(' ').toLowerCase()};
  }
  summary() {
    const entries=[...this.entries.values()],coverage=this.manifest?.coverage;
    return {registered:entries.length,definitionsFound:coverage?.definitionsFound || 0,coveragePercent:coverage?.definitionsFound?Math.round(entries.length/coverage.definitionsFound*10000)/100:null,scope:coverage?.scope || 'unavailable',runtimeVerified:coverage?.runtimeVerified || false,iconsFound:entries.filter(item=>item.iconUrl).length,missingIcons:entries.filter(item=>!item.iconUrl).length,missingLocalization:entries.filter(item=>item.diagnostics.includes('MISSING LOCALIZATION')).length,unresolvedCategories:entries.filter(item=>item.diagnostics.includes('CATEGORY UNRESOLVED')).length,unclassifiedItems:entries.filter(item=>item.clusterId==='unclassified').length,classifiedItems:entries.filter(item=>item.clusterId!=='unclassified').length,manualClassifications:entries.filter(item=>item.classificationSource==='manual').length,hashCollisions:[...this.hashes.values()].filter(items=>items.length>1).length,loadError:this.loadError,generation:this.generation,gameVersion:this.manifest?.gameVersion || null};
  }
  state() {return {...(this.manifest || {schemaVersion:1,gameVersion:null,source:null,generatedAt:null,coverage:{definitionsFound:0,registered:0,scope:'unavailable',runtimeVerified:false}}),items:[...this.entries.values()],summary:this.summary(),categories:CATEGORIES,clusters:this.clusters};}
  publish(value) {const manifest=validateRegistry(value);atomicJson(this.file,manifest);this.reload(true);return this.summary();}
  override(value) {
    this.reload();
    if(!value || !validString(value.prefab,200) || !value.prefab.trim())fail('Недопустимый prefab.');
    if(value.reset!==undefined && typeof value.reset!=='boolean')fail('reset: ожидается boolean.');
    const reset=value.reset===true || value.category===null;
    if(value.category!==undefined && value.category!==null && !CATEGORIES.includes(value.category))fail('Категория не поддерживается.');
    if(value.subcategory!==undefined && !validString(value.subcategory,240))fail('Недопустимая подкатегория.');
    const target=value.clusterId===undefined?null:this.clusters.find(cluster=>cluster.id===value.clusterId);
    if(!reset && value.clusterId!==undefined && (!target || !target.categories.some(category=>category.id===value.clusterCategoryId)))fail('Кластер или категория не поддерживается.','INVALID_CLUSTER');
    if(!reset && value.clusterId===undefined && value.category===undefined)fail('Не задано переопределение.');
    const canonical=this.resolve(value.prefab)?.prefab || value.prefab,overrides=Object.assign(Object.create(null),this.overrides);
    if(reset) {delete overrides[canonical];if(canonical!==value.prefab)delete overrides[value.prefab];const definition=this.resolve(canonical);if(definition && this.hashes.get(definition.prefabHash)?.length===1)delete overrides['hash:'+definition.prefabHash];}
    else overrides[canonical]={...(Object.hasOwn(overrides,canonical)?overrides[canonical]:{}),...(value.category!==undefined?{category:value.category,subcategory:value.subcategory || ''}:{}),...(target?{clusterId:target.id,clusterCategoryId:value.clusterCategoryId}:{})};
    atomicJson(this.overridesFile,overrides);this.reload(true);return this.resolve(canonical) || this.describe({prefab:canonical,name:canonical});
  }
  createCluster(value) {
    this.reload();const name=value?.name;
    if(!validString(name,80) || !name.trim())fail('Название кластера: от 1 до 80 символов.');
    if(this.customClusters.length>=100)fail('Достигнут предел 100 пользовательских кластеров.');
    if(this.clusters.some(cluster=>cluster.name.toLocaleLowerCase('ru')===name.trim().toLocaleLowerCase('ru')))fail('Кластер с таким названием уже существует.','CLUSTER_EXISTS',409);
    const cluster={id:'custom-'+randomUUID(),name:name.trim(),system:false,categories:[{id:'items',name:'Предметы'}]};atomicJson(this.clustersFile,[...this.customClusters,cluster]);this.reload(true);return cluster;
  }
  renameCluster(id,value) {
    this.reload();const target=this.clusters.find(cluster=>cluster.id===id);
    if(!target)fail('Кластер не найден.','CLUSTER_NOT_FOUND',404);
    if(target.system)fail('Системный кластер нельзя переименовать.','SYSTEM_CLUSTER',403);
    const name=value?.name;if(!validString(name,80) || !name.trim())fail('Название кластера: от 1 до 80 символов.');
    if(this.clusters.some(cluster=>cluster.id!==id && cluster.name.toLocaleLowerCase('ru')===name.trim().toLocaleLowerCase('ru')))fail('Кластер с таким названием уже существует.','CLUSTER_EXISTS',409);
    atomicJson(this.clustersFile,this.customClusters.map(cluster=>cluster.id===id?{...cluster,name:name.trim()}:cluster));this.reload(true);return this.clusters.find(cluster=>cluster.id===id);
  }
  iconFile(key) {if(typeof key!=='string' || !ICON_KEY.test(key))return null;for(const directory of [this.iconDirectory,this.installedIconDirectory]){const file=resolve(directory,key+'.png');if(isFile(file))return file;}return null;}
  publishIcon(key,bytes) {
    if(!ICON_KEY.test(key))fail('Недопустимый ключ пиктограммы.','INVALID_ICON_KEY');
    if(bytes.length<33 || bytes.length>512*1024 || !bytes.subarray(0,8).equals(PNG_SIGNATURE) || bytes.toString('ascii',12,16)!=='IHDR')fail('Ожидается PNG до 512 КиБ.','INVALID_PNG');
    const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
    if(width<1 || height<1 || width>2048 || height>2048)fail('Размер PNG вне диапазона.','INVALID_PNG');
    if(createHash('sha256').update(bytes).digest('hex')!==key)fail('PNG не соответствует ключу SHA-256.','ICON_HASH_MISMATCH');
    mkdirSync(this.iconDirectory,{recursive:true});const file=resolve(this.iconDirectory,key+'.png');if(!existsSync(file)) {writeFileSync(file+'.tmp',bytes);renameSync(file+'.tmp',file);this.filesSignature='';}return {key,width,height};
  }
}
