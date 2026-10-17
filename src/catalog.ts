import { Item, Resource, State } from './types';

export const itemCategories=['Древесина и растения','Камень и минералы','Руды и металлы','Строительные материалы','Сельское хозяйство','Сырые продукты','Приготовленная еда','Ингредиенты','Трофеи','Кожа, кости и ткани','Оружие','Броня','Инструменты','Боеприпасы','Зелья и расходники','Ценные предметы','Ключевые и специальные предметы','Прочее','Неопознанные'];
export type SortColumn='name'|'quantity'|'shortage'|'available'|'reserved'|'containers'|'zone'|'status'|'category';
export const itemKey=(item:Pick<Item,'id'|'prefab'>)=>item.id||item.prefab;
export const sameItem=(a:Pick<Item,'id'|'prefab'>,b:Pick<Item,'id'|'prefab'>)=>a.id&&b.id?a.id===b.id:a.prefab===b.prefab;
export const itemMatches=(item:Item,query:string)=>!query.trim()||[item.name,item.nameRu,item.nameEn,item.prefab,item.id,item.prefabHash,item.searchText,item.category,item.subcategory].filter(value=>value!==undefined&&value!==null).join(' ').toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru'));
export const resourceZones=(resource:Resource,state:State)=>{
 const ids=new Set(state.containers.filter(c=>resource.containerIds.includes(c.id)).flatMap(c=>c.zoneIds));
 return state.zones.filter(z=>ids.has(z.id)).map(z=>z.name).sort((a,b)=>a.localeCompare(b,'ru')).join(', ')||'Вне зон';
};
export const resourceAvailable=(resource:Resource)=>typeof resource.availableQuantity==='number'&&Number.isFinite(resource.availableQuantity)?resource.availableQuantity:null;
export const resourceReserved=(resource:Resource)=>resource.reservationsImplemented!==false&&typeof resource.reservedQuantity==='number'&&Number.isFinite(resource.reservedQuantity)?resource.reservedQuantity:null;
export function groupResources(resources:Resource[],grouped:boolean){
 if(!grouped)return [{category:'',items:resources}];
 const categories=[...new Set(resources.map(r=>r.category))].sort((a,b)=>{
  const ai=itemCategories.indexOf(a),bi=itemCategories.indexOf(b);return (ai<0?999:ai)-(bi<0?999:bi)||a.localeCompare(b,'ru');
 });return categories.map(category=>({category,items:resources.filter(r=>r.category===category)}));
}
export function sortResources(items:Resource[],column:SortColumn,direction:'asc'|'desc',state:State){
 const value=(r:Resource):string|number=>column==='name'?r.name:column==='shortage'?r.minimum-r.quantity:column==='available'?resourceAvailable(r)??-1:column==='reserved'?resourceReserved(r)??-1:column==='containers'?r.containerIds.length:column==='zone'?resourceZones(r,state):column==='status'?r.status:column==='category'?r.category:r.quantity;
 return [...items].sort((a,b)=>{const av=value(a),bv=value(b);const comparison=typeof av==='number'&&typeof bv==='number'?av-bv:String(av).localeCompare(String(bv),'ru');return (comparison*(direction==='asc'?1:-1))||itemKey(a).localeCompare(itemKey(b));});
}
export function readPreference<T>(key:string,fallback:T,validate:(value:unknown)=>value is T):T{
 try{const value=JSON.parse(localStorage.getItem(key)||'null');return validate(value)?value:fallback;}catch{return fallback;}
}
export const savePreference=(key:string,value:unknown)=>{try{localStorage.setItem(key,JSON.stringify(value));}catch{/* Panel still works when browser storage is disabled. */}};
