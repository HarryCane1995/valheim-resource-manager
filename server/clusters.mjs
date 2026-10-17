// Logical item taxonomy. Physical storage zones are deliberately absent here.
// Rules use stable prefab IDs and native ItemType, never translated display names.
const cluster=(id,name,categories)=>Object.freeze({id,name,system:true,categories:Object.freeze(categories.map(([id,name])=>Object.freeze({id,name})))});
export const SYSTEM_CLUSTERS=Object.freeze([
  cluster('construction','СТРОИТЕЛЬСТВО',[['wood','Древесина и её разновидности'],['minerals','Камень и минеральные материалы'],['components','Строительные компоненты'],['binders','Смолы, дёготь и вспомогательные материалы']]),
  cluster('metallurgy','МЕТАЛЛУРГИЯ',[['ores','Руды'],['scrap','Металлолом'],['metals','Обработанные металлы и сплавы'],['processing','Топливо и материалы обработки']]),
  cluster('agriculture','СЕЛЬСКОЕ ХОЗЯЙСТВО',[['seeds','Семена'],['crops','Урожай'],['plants','Растительное сырьё'],['materials','Сельскохозяйственные материалы']]),
  cluster('food','КУХНЯ И ПРОВИЗИЯ',[['meat-fish','Мясо и рыба'],['berries-mushrooms','Ягоды и грибы'],['ingredients','Кулинарные ингредиенты'],['meals','Готовые блюда'],['other-food','Прочие съедобные продукты']]),
  cluster('alchemy','АЛХИМИЯ И МАГИЯ',[['potions','Зелья и медовуха'],['magic','Магические материалы'],['reagents','Специальные реагенты'],['consumables','Расходники']]),
  cluster('equipment','СНАРЯЖЕНИЕ',[['weapons','Оружие'],['armor','Броня'],['tools','Инструменты'],['ammunition','Боеприпасы'],['accessories','Аксессуары'],['appearance','Внешность (служебные определения)']]),
  cluster('loot','ДОБЫЧА И ТРОФЕИ',[['trophies','Трофеи существ'],['hides','Шкуры'],['bones','Кости'],['materials','Прочие материалы, получаемые с существ']]),
  cluster('valuables','ЦЕННОСТИ И ОСОБЫЕ ПРЕДМЕТЫ',[['treasures','Монеты и сокровища'],['keys','Ключи'],['quest','Сюжетные предметы'],['special','Редкие специальные предметы']]),
  cluster('unclassified','НЕРАЗОБРАННОЕ',[['unknown','Неопознанные предметы'],['ambiguous','Неоднозначные классификации'],['other','Остальные предметы']]),
]);
const TYPES={0:'None',1:'Material',2:'Consumable',3:'OneHandedWeapon',4:'Bow',5:'Shield',6:'Helmet',7:'Chest',9:'Ammo',10:'Customization',11:'Legs',12:'Hands',13:'Trophy',14:'TwoHandedWeapon',15:'Torch',16:'Misc',17:'Shoulder',18:'Utility',19:'Tool',20:'Attach_Atgeir',21:'Fish',22:'TwoHandedWeaponLeft',23:'AmmoNonEquipable',24:'Trinket'};
const exact=new Map();
const LEGACY={'Древесина и растения':['agriculture','plants'],'Камень и минералы':['construction','minerals'],'Руды и металлы':['metallurgy','metals'],'Строительные материалы':['construction','components'],'Сельское хозяйство':['agriculture','materials'],'Сырые продукты':['food','meat-fish'],'Приготовленная еда':['food','meals'],'Ингредиенты':['food','ingredients'],'Трофеи':['loot','trophies'],'Кожа, кости и ткани':['loot','materials'],'Оружие':['equipment','weapons'],'Броня':['equipment','armor'],'Инструменты':['equipment','tools'],'Боеприпасы':['equipment','ammunition'],'Зелья и расходники':['alchemy','potions'],'Ценные предметы':['valuables','treasures'],'Ключевые и специальные предметы':['valuables','special'],'Прочее':['unclassified','other']};
function add(clusterId,category,prefabs) {for(const prefab of prefabs.split(' '))if(prefab)exact.set(prefab,[clusterId,category]);}
add('construction','wood','Wood FineWood RoundLog ElderBark YggdrasilWood Blackwood Frostwood BarkaBranch');
add('construction','minerals','Stone StoneRock Flint Obsidian BlackMarble Grausten Crystal Ice');
add('construction','components','BronzeNails IronNails Chain Thunderstone DvergrNeedle MechanicalSpring BarrelRings CeramicPlate Pot_Shard_Green Pot_Shard_Red CandleWick CharredCogwheel');
add('construction','binders','Resin Tar');
add('metallurgy','ores','CopperOre TinOre IronOre SilverOre FlametalOre FlametalOreNew GoldOre');
add('metallurgy','scrap','CopperScrap BronzeScrap IronScrap BlackMetalScrap');
add('metallurgy','metals','Copper Tin Bronze Iron Silver BlackMetal Flametal FlametalNew Gold');
add('metallurgy','processing','Coal CharcoalResin FrozenFuel SharpeningStone Ironpit MoldSmallParts SmallPartsGoldUncooked');
add('agriculture','seeds','Acorn BeechSeeds BirchSeeds FirCone FirConeFrost PineCone CarrotSeeds TurnipSeeds OnionSeeds KaleSeeds OatSeeds PoteitrSeeds VineGreenSeeds VineberrySeeds');
add('agriculture','crops','Barley Flax Carrot Turnip Onion Kale Oat Poteitr Vineberry');
add('agriculture','plants','Dandelion Thistle FreshSeaweed Root WrithanRoots LinenThread JuteBlue JuteRed NornThread');
add('agriculture','materials','QueenBee AsksvinEgg ChickenEgg VoltureEgg ScytheHandle');
add('food','meat-fish','RawMeat DeerMeat NeckTail FishRaw FishAnglerRaw WolfMeat LoxMeat SerpentMeat HareMeat ChickenMeat BugMeat AsksvinMeat VoltureMeat BjornMeat MooseMeat BoneMawSerpentMeat');
add('food','berries-mushrooms','Raspberry Blueberries Cloudberry Mushroom MushroomYellow MushroomJotunPuffs MushroomMagecap');
add('food','ingredients','Honey BarleyFlour OatFlour Entrails Bloodbag RoyalJelly GiantBloodSack PowderedDragonEgg');
add('alchemy','potions','Pukeberries BarleyWine BarleyWineBase');
add('alchemy','magic','Eitr Sap Wisp SurtlingCore BlackCore FrostCore MoltenCore ShieldCore Ectoplasm Voidplasm OrbFrostFire OrbThunderBlood GemstoneBlue GemstoneGreen GemstoneRed CelestialFeather');
add('alchemy','reagents','GreydwarfEye FreezeGland Guck Ooze OozeMork Bilebag BlobVial Softtissue YmirRemains MorgenHeart ProustitePowder SulfurStone');
add('alchemy','consumables','FragrantBundle PungentPebbles CuredSquirrelHamstring');
add('equipment','accessories','BarberKit SaddleLox SaddleAsksvin SaddleMoose Bell Hook');
add('equipment','ammunition','Catapult_ammo Catapult_Ammo_BloodGold BombSiege');
add('loot','hides','DeerHide TrollHide WolfPelt LoxPelt ScaleHide AskHide BjornHide MooseHide SealHide LeatherScraps Leatherstraps');
add('loot','bones','BoneFragments WitheredBone CharredBone Charredskull AsksvinCarrionNeck AsksvinCarrionPelvic AsksvinCarrionRibcage AsksvinCarrionSkull UndeadBjornRibcage HardAntler');
add('loot','materials','Feathers Chitin Carapace SerpentScale BonemawSerpentScale BonemawSerpentTooth Mandible Needle WolfClaw WolfFang WolfHairBundle ElakingHairBundle MooseSinew MorgenSinew AskBladder BjornPaw MoleClaws SealBlubber');
add('valuables','treasures','Coins Amber AmberPearl Ruby SilverNecklace AncientCoin AncientGemstoneBlack AncientGemstoneGreen AncientGemstoneOrange AncientGemstonePurple CrownJewel');
add('valuables','keys','CryptKey DvergrKey DvergrKeyFragment BloodGoldKey HildirKey_forestcrypt HildirKey_mountaincave HildirKey_plainsfortress');
add('valuables','quest','AncientSeed DragonEgg DragonTear GoblinTotem YagluthDrop QueenDrop FaderDrop FaderEmber FrozenKingDrop HatefulBlood BellFragment DyrnwynBladeFragment DyrnwynHiltFragment DyrnwynTipFragment AxeHead1 AxeHead2 VegvisirShard_Bonemass chest_hildir1 chest_hildir2 chest_hildir3');
add('valuables','special','MemorialCoal');

function result(clusters,clusterId,categoryId,source,tags=[]) {
  const target=clusters.find(value=>value.id===clusterId) || SYSTEM_CLUSTERS.at(-1);
  const category=target.categories.find(value=>value.id===categoryId) || target.categories.at(-1);
  return {clusterId:target.id,clusterName:target.name,clusterCategoryId:category.id,clusterCategory:category.name,classificationSource:source,tags:[...new Set(tags)]};
}

export function classifyItem(item,override,clusters=SYSTEM_CLUSTERS,{known=true}={}) {
  const metadata=item.metadata || {},rawType=metadata.itemTypeName ?? metadata.itemType ?? metadata.itemTypeValue;
  const type=TYPES[rawType] || rawType,prefab=item.prefab || '';
  const tags=[];
  if(type==='Customization')tags.push('служебное определение','внешность');
  if((metadata.maxQuality || 0)>1)tags.push('качество');
  if((metadata.variants || 0)>1)tags.push('варианты');
  if(!known)tags.push('нет в реестре');
  const finish=(clusterId,category,source)=>result(clusters,clusterId,category,source,tags);
  const manual=clusters.find(value=>value.id===override?.clusterId);
  if(manual?.categories.some(value=>value.id===override.clusterCategoryId))return finish(manual.id,override.clusterCategoryId,'manual');
  if(override?.category && Object.hasOwn(LEGACY,override.category))return finish(...LEGACY[override.category],'manual');
  // Metadata that describes an item's function outranks every lexical rule.
  if(metadata.questItem===true)return finish('valuables','quest','metadata');
  if(['Helmet','Chest','Legs','Hands','Shoulder'].includes(type))return finish('equipment','armor','metadata');
  if(['Utility','Trinket'].includes(type))return finish('equipment','accessories','metadata');
  if(type==='Customization')return finish('equipment','appearance','metadata');
  if(type==='Tool' || metadata.buildPieces===true)return finish('equipment','tools','metadata');
  if(['Ammo','AmmoNonEquipable'].includes(type))return finish('equipment','ammunition','metadata');
  if(['OneHandedWeapon','TwoHandedWeapon','TwoHandedWeaponLeft','Bow','Shield','Attach_Atgeir','Torch'].includes(type))return finish('equipment','weapons','metadata');
  if(type==='Trophy')return finish('loot','trophies','metadata');
  if(type==='Fish')return finish('food','meat-fish','metadata');
  if(metadata.isDrink===true)return finish('alchemy','potions','metadata');
  // Edibility alone does not decide the logical destination of a harvested crop.
  // Its exact native prefab identifies agriculture; retain ingestion as a tag.
  if(exact.get(prefab)?.[0]==='agriculture' && (type==='Consumable' || Number(metadata.foodHealth)>0 || Number(metadata.foodStamina)>0)) {tags.push('съедобное');return finish(...exact.get(prefab),'exact-prefab');}
  if(type==='Material' && /^(?:Upgrader\d+(?:Armor|Weapon)|GenericMoldUncooked|LastBossGate_RuneTile)$/.test(prefab))return finish('unclassified','ambiguous','unclassified');
  // Consumable indicates ingestion, but cannot alone distinguish meals from mead.
  if(type==='Consumable' && !/^(Mead|BarleyWine|Pukeberries)/.test(prefab))return finish('food',exact.get(prefab)?.[0]==='food'?exact.get(prefab)[1]:/^(Cooked|Roasted|Feast)|(?:Stew|Soup|Bread|Pie|Pudding|Salad|Omelette|Jerky|Skewer|Mash|Pottage|Platter|Supreme|Aspic|Cake|Sausages)/.test(prefab)?'meals':'other-food','metadata');
  if(Number(metadata.foodHealth)>0 || Number(metadata.foodStamina)>0 || Number(metadata.foodEitr)>0)return finish('food',exact.get(prefab)?.[0]==='food'?exact.get(prefab)[1]:'other-food','metadata');
  if(Number(metadata.value)>0 && ['Material','Misc',undefined].includes(type))return finish('valuables','treasures','metadata');
  const precise=exact.get(prefab);
  if(precise)return finish(...precise,'exact-prefab');
  // This exact family is a native manufacturing definition, not wearable armor.
  if(type==='Material' && (/^Mold[A-Z]/.test(prefab) || /^(?:Armor|Atgeir|Axe|Battleaxe|Bow|Crossbow|Fist|Keys|Knife|Mace|Shield|Sledge|SmallParts|Spear|Staff|Sword|THSword).*Uncooked$/.test(prefab)))return finish('metallurgy','processing','exact-prefab-family');
  if(/^Spice(?:Ashlands|DeepNorth|Forests|Mistlands|Mountains|Oceans|Plains)$/.test(prefab))return finish('food','ingredients','exact-prefab-family');
  if(/^Feast(?:Ashlands|Blackforest|DeepNorth|Meadows|Mistlands|Mountains|Oceans|Plains|Swamps)_Material$/.test(prefab))return finish('food','meals','exact-prefab-family');
  if(/^FireworksRocket_(?:Blue|Cyan|Green|Purple|Red|White|Yellow)$/.test(prefab))return finish('alchemy','consumables','exact-prefab-family');
  const legacy=override?.category || item.category;
  // Legacy lexical weapon/armor guesses conflict with a definite native Material.
  const incompatible=type==='Material' && ['Оружие','Броня','Инструменты','Боеприпасы'].includes(legacy);
  if(legacy==='Руды и металлы' && !incompatible)return finish('metallurgy',/Ore(?:New)?$/.test(prefab)?'ores':/Scrap$/.test(prefab)?'scrap':'metals','legacy-category');
  if(legacy!=='Прочее' && Object.hasOwn(LEGACY,legacy) && !incompatible)return finish(...LEGACY[legacy],'legacy-category');
  if(/^hash:-?\d+$/.test(prefab))return finish('unclassified','unknown','unclassified');
  // Bounded prefix/suffix fallbacks allow obvious new/mod items without arbitrary
  // substring matches ("OreSword" with native weapon metadata was handled above).
  if(/(?:Seeds|Sapling|Cone)$/.test(prefab))return finish('agriculture','seeds','heuristic');
  if(/Ore(?:New)?$/.test(prefab))return finish('metallurgy','ores','heuristic');
  if(/Scrap$/.test(prefab))return finish('metallurgy','scrap','heuristic');
  if(/^(?:Mead|BarleyWine)/.test(prefab))return finish('alchemy','potions','heuristic');
  if(/Uncooked$/.test(prefab) && type==='Material')return finish('food','ingredients','heuristic');
  if(/(?:Hide|Pelt)$/.test(prefab))return finish('loot','hides','heuristic');
  if(/^(?:Trophy)/.test(prefab))return finish('loot','trophies','heuristic');
  return finish('unclassified',known?'ambiguous':'unknown','unclassified');
}

// Accepts already world/zone-filtered aggregate rows. Never scans raw stacks,
// never adds cluster chest counts together: every cluster uses its own ID union.
export function summarizeClusters(resources,clusters=SYSTEM_CLUSTERS) {
  return clusters.map(cluster=> {
    const items=resources.filter(resource=>resource.clusterId===cluster.id),containerIds=new Set();
    const statusSets=new Map(),statusCounts={};
    for(const item of items) {
      for(const id of item.containerIds || [])containerIds.add(id);
      for(const [status,ids] of Object.entries(item.statusContainerIds || {[item.status || 'OFFLINE']:item.containerIds || []})) {
        const set=statusSets.get(status) || new Set();for(const id of ids)set.add(id);statusSets.set(status,set);
      }
    }
    for(const [status,ids] of statusSets)if(ids.size)statusCounts[status]=ids.size;
    const statuses=Object.keys(statusCounts);
    return {clusterId:cluster.id,uniqueItems:items.length,totalItems:items.reduce((sum,item)=>sum+item.quantity,0),containers:containerIds.size,shortages:items.filter(item=>item.quantity<item.minimum).length,status:statuses.length>1?'MIXED':statuses[0] || 'EMPTY',statusCounts};
  });
}
