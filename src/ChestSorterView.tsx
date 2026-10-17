import { useMemo, useState } from 'react';
import { ArrowDownUp, CheckCircle2, ChevronRight, FolderTree, Search, TriangleAlert, X } from 'lucide-react';
import type { ChestSorterCategory, Resource, State } from './types';
import { itemKey, itemMatches, readPreference, savePreference } from './catalog';
import { summarizeResources } from './clusters';
import { ResourceIcon } from './ResourceIcon';
import { StockGauge } from './StockGauge';
import './chestsorter.css';

const fmt=(value:number)=>new Intl.NumberFormat('ru-RU').format(value);
const unknownKey='unresolved';
const reasonText:Record<string,string>={'missing-prefab':'Нужен точный prefab из реестра','missing-item-type':'В реестре нет типа предмета','missing-food-data':'В реестре нет пищевых свойств','rules-unavailable':'Правила мода недоступны'};
type Group={key:string;category:ChestSorterCategory;items:Resource[]};

export function ChestSorterView({state,onSelect}:{state:State;onSelect:(id:string)=>void}) {
 const [query,setQuery]=useState(''),[category,setCategory]=useState('all'),[shortages,setShortages]=useState(false),[sort,setSort]=useState('name');
 const [columns,setColumns]=useState(()=>readPreference('vrm.chestsorter.columns',2,(v):v is number=>v===1||v===2));
 const [empty,setEmpty]=useState(()=>readPreference('vrm.chestsorter.empty',false,(v):v is boolean=>typeof v==='boolean'));
 const [collapsed,setCollapsed]=useState(()=>readPreference<string[]>('vrm.chestsorter.collapsed',[],(v):v is string[]=>Array.isArray(v)&&v.length<=2000&&v.every(id=>typeof id==='string')));
 const info=state.chestSorter;
 const groups=useMemo(()=>{
  const groups=new Map<string,Group>();
  for(const entry of info?.categories||[])groups.set('id:'+entry.id.toLowerCase(),{key:'id:'+entry.id.toLowerCase(),category:entry,items:[]});
  for(const resource of state.resources){
   const id=resource.chestSorter?.categoryId,key=id?'id:'+id.toLowerCase():unknownKey;
   if(!groups.has(key))groups.set(key,{key,category:{id:id||unknownKey,name:id||'Нужны данные для категории',parentId:null},items:[]});
   groups.get(key)!.items.push(resource);
  }
  return [...groups.values()];
 },[state.resources,info?.categories]);
 const selectedCategory=category==='all'||groups.some(group=>group.key===category)?category:'all';
 const filtered=useMemo(()=>groups.filter(group=>{
  if(selectedCategory==='all'||group.key===selectedCategory)return true;
  let parent=group.category.parentId;const visited=new Set<string>();
  while(parent&&!visited.has(parent.toLowerCase())){visited.add(parent.toLowerCase());const key='id:'+parent.toLowerCase();if(key===selectedCategory)return true;parent=groups.find(entry=>entry.key===key)?.category.parentId||null;}
  return false;
 }).map(group=>{
  const parent=groups.find(entry=>entry.category.id===group.category.parentId)?.category.name||'';
  const categoryMatches=Boolean(query.trim())&&`${group.category.name} ${group.category.id} ${parent}`.toLowerCase().includes(query.trim().toLowerCase());
  const items=group.items.filter(item=>(!shortages||item.quantity<item.minimum)&&(categoryMatches||itemMatches(item,query)));
  items.sort((a,b)=>sort==='quantity'?b.quantity-a.quantity||a.name.localeCompare(b.name,'ru'):sort==='shortage'?(b.minimum-b.quantity)-(a.minimum-a.quantity)||a.name.localeCompare(b.name,'ru'):a.name.localeCompare(b.name,'ru'));
  return {...group,items};
 }).filter(group=>group.items.length||(empty&&!query.trim()&&!shortages)),[groups,query,shortages,sort,empty,selectedCategory]);
 const summary=summarizeResources(filtered.flatMap(group=>group.items));
 const toggleGroup=(key:string)=>{const next=collapsed.includes(key)?collapsed.filter(id=>id!==key):[...collapsed,key];setCollapsed(next);savePreference('vrm.chestsorter.collapsed',next);};
 return <section className="chestsorter-view" data-testid="chestsorter-view">
  <div className={`chestsorter-source ${info?.status==='ready'?'ready':'attention'}`} role="status" data-testid="chestsorter-source" data-status={info?.status||'loading'}>
   {info?.status==='ready'?<CheckCircle2 size={18}/>:<TriangleAlert size={18}/>}
   <div><strong>{info?.status==='ready'?`${info.categories.length} категории ChestSorter`:info?.status==='invalid'?'Не удалось прочитать правила ChestSorter':info?.status==='unavailable'?'Файл категорий ChestSorter не найден':'Читаем категории ChestSorter…'}</strong><p>{info?.status==='ready'?`ChestSorter.categories.txt · правила v${info.version} · обновляются вместе с файлом мода`:info?.status==='invalid'?`Проверьте файл категорий${info.error?.line?`, строка ${info.error.line}`:''}. Предметы остаются в списке без назначения.`:info?.status==='unavailable'?'Нужен установленный ChestSorter в выбранной папке игры. Предметы остаются доступны ниже.':'Подключаем правила установленного мода.'}</p></div>
  </div>
  <div className="chestsorter-toolbar">
   <div className="search-field"><Search size={17}/><input aria-label="Поиск в категориях ChestSorter" placeholder="Предмет или категория ChestSorter…" value={query} onChange={e=>setQuery(e.target.value)}/>{query&&<button aria-label="Очистить поиск ChestSorter" onClick={()=>setQuery('')}><X size={14}/></button>}</div>
   <label className="chestsorter-select"><FolderTree size={15}/><select aria-label="Категория ChestSorter" value={selectedCategory} onChange={e=>setCategory(e.target.value)}><option value="all">Все категории</option>{groups.map(group=><option key={group.key} value={group.key}>{group.category.name}</option>)}</select></label>
   <label className="chestsorter-select"><ArrowDownUp size={15}/><select aria-label="Сортировка ChestSorter" value={sort} onChange={e=>setSort(e.target.value)}><option value="name">По названию</option><option value="quantity">По количеству</option><option value="shortage">По дефициту</option></select></label>
  </div>
  <div className="chestsorter-options"><label><input type="checkbox" checked={shortages} onChange={e=>setShortages(e.target.checked)}/>Только дефицит</label><label><input type="checkbox" checked={empty} onChange={e=>{setEmpty(e.target.checked);savePreference('vrm.chestsorter.empty',e.target.checked);}}/>Пустые категории</label><div role="group" aria-label="Столбцы ChestSorter"><span>Колонки</span>{[1,2].map(value=><button key={value} aria-pressed={columns===value} onClick={()=>{setColumns(value);savePreference('vrm.chestsorter.columns',value);}}>{value}</button>)}</div></div>
  <div className="chestsorter-summary" data-testid="chestsorter-summary" data-total={summary.totalItems} data-count={summary.uniqueItems}><strong>{fmt(summary.totalItems)} ед.</strong><span>{summary.uniqueItems} типов</span><span>{summary.containers} сундуков</span><span>{summary.shortages} ниже минимума</span></div>
  <div className={`chestsorter-groups columns-${columns}`} data-testid="chestsorter-groups">
   {filtered.map(group=>{
    const open=Boolean(query.trim())||!collapsed.includes(group.key),total=group.items.reduce((sum,item)=>sum+item.quantity,0);
    return <section className="chestsorter-group" key={group.key} data-testid="chestsorter-category" data-category={group.category.id}>
     <button className="chestsorter-group-heading" aria-expanded={open} onClick={()=>toggleGroup(group.key)}><ChevronRight size={16} className={open?'expanded':''}/><span><strong>{group.category.name}</strong>{group.category.parentId&&<small>Входит в {groups.find(entry=>entry.category.id===group.category.parentId)?.category.name||group.category.parentId}</small>}</span><span className="chestsorter-group-count">{group.items.length} типов · {fmt(total)} ед.</span></button>
     {open&&<div className="chestsorter-items">{group.items.map(resource=><button className="chestsorter-item" key={itemKey(resource)} data-testid="chestsorter-item" data-item={itemKey(resource)} data-quantity={resource.quantity} onClick={()=>onSelect(itemKey(resource))}>
      <ResourceIcon prefab={resource.prefab} category={resource.category} name={resource.name} iconUrl={resource.iconUrl}/><span className="chestsorter-item-name"><strong title={`${resource.name} · ${resource.prefab}`}>{resource.name}</strong><small title={reasonText[resource.chestSorter?.reason||'']||resource.prefab}>{reasonText[resource.chestSorter?.reason||'']||resource.nameEn||resource.prefab}</small></span><span className="chestsorter-item-stock"><strong>{fmt(resource.quantity)} <small>/ {fmt(resource.minimum)}</small></strong><StockGauge quantity={resource.quantity} minimum={resource.minimum}/></span><span className={`data-status status-${resource.status.toLowerCase()}`} title="Свежесть последних данных"><i/>{resource.status==='SNAPSHOT'?'СНИМОК':resource.status==='STALE'?'УСТАРЕЛО':resource.status==='OFFLINE'?'ОФЛАЙН':resource.status}</span>
     </button>)}{!group.items.length&&<p className="chestsorter-empty-category">В выбранной области нет ресурсов этой категории.</p>}</div>}
    </section>;
   })}
  </div>
  {!filtered.length&&<div className="no-results"><Search size={30}/><h3>{state.resources.length?'Ресурсы не найдены':'В этой области пока нет ресурсов'}</h3><p>{state.resources.length?'Измените поиск, категорию или фильтр дефицита.':'После подтверждения игровым источником они появятся в категориях ChestSorter.'}</p></div>}
  <p className="chestsorter-footnote">Здесь ресурсы сгруппированы по правилам мода. Перемещение между сундуками выполняется через Push в игре. Последние известные количества и область учёта общие с обзором ресурсов.</p>
 </section>;
}
