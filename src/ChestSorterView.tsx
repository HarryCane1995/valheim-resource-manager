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

function ChestSetupCheckbox({worldId,categoryKey,name}:{worldId?:string;categoryKey:string;name:string}) {
 const storageKey=`vrm.chestsorter.chestReady.v1.${JSON.stringify([worldId,categoryKey])}`;
 const [checked,setChecked]=useState(()=>readPreference(storageKey,false,(value):value is boolean=>typeof value==='boolean'));
 return <label className={`chestsorter-chest-ready${checked?' checked':''}`} title={worldId?'Ваша пометка для этой категории в выбранном мире':'Сначала выберите мир'}>
  <input type="checkbox" aria-label={`Сундук настроен: ${name}`} checked={checked} disabled={!worldId} onChange={event=>{setChecked(event.target.checked);savePreference(storageKey,event.target.checked);}}/>Сундук настроен
 </label>;
}

export function ChestSorterView({state,onSelect}:{state:State;onSelect:(id:string)=>void}) {
 const [query,setQuery]=useState(''),[category,setCategory]=useState('all'),[shortages,setShortages]=useState(false),[sort,setSort]=useState('name');
 const [columns,setColumns]=useState(()=>readPreference('vrm.chestsorter.columns',2,(v):v is number=>v===1||v===2));
 const [empty,setEmpty]=useState(()=>readPreference('vrm.chestsorter.empty',false,(v):v is boolean=>typeof v==='boolean'));
 const [collapsed,setCollapsed]=useState(()=>readPreference<string[]>('vrm.chestsorter.collapsed',[],(v):v is string[]=>Array.isArray(v)&&v.length<=2000&&v.every(id=>typeof id==='string')));
 const info=state.chestSorter;
 const catalog=info?.catalog||state.resources;
 const groups=useMemo(()=>{
  const groups=new Map<string,Group>();
  for(const entry of info?.categories||[])groups.set('id:'+entry.id.toLowerCase(),{key:'id:'+entry.id.toLowerCase(),category:entry,items:[]});
  for(const resource of catalog){
   const id=resource.chestSorter?.categoryId,key=id?'id:'+id.toLowerCase():unknownKey;
   if(!groups.has(key))groups.set(key,{key,category:{id:id||unknownKey,name:id||'Нужны данные для категории',parentId:null},items:[]});
   groups.get(key)!.items.push(resource);
  }
  return [...groups.values()];
 },[catalog,info?.categories]);
 const selectedCategory=category==='all'||groups.some(group=>group.key===category)?category:'all';
 const filtered=useMemo(()=>groups.filter(group=>{
  if(selectedCategory==='all'||group.key===selectedCategory)return true;
  let parent=group.category.parentId;const visited=new Set<string>();
  while(parent&&!visited.has(parent.toLowerCase())){visited.add(parent.toLowerCase());const key='id:'+parent.toLowerCase();if(key===selectedCategory)return true;parent=groups.find(entry=>entry.key===key)?.category.parentId||null;}
  return false;
 }).map(group=>{
  const parent=groups.find(entry=>entry.category.id===group.category.parentId)?.category.name||'';
  const categoryMatches=Boolean(query.trim())&&`${group.category.name} ${group.category.id} ${parent}`.toLowerCase().includes(query.trim().toLowerCase());
  const items=group.items.filter(item=>(!shortages||(!item.catalogOnly&&item.quantity<item.minimum))&&(categoryMatches||itemMatches(item,query)));
  items.sort((a,b)=>sort==='quantity'?b.quantity-a.quantity||a.name.localeCompare(b.name,'ru'):sort==='shortage'?(b.minimum-b.quantity)-(a.minimum-a.quantity)||a.name.localeCompare(b.name,'ru'):a.name.localeCompare(b.name,'ru'));
  return {...group,items};
 }).filter(group=>group.items.length||(empty&&!query.trim()&&!shortages)),[groups,query,shortages,sort,empty,selectedCategory]);
 const visibleItems=filtered.flatMap(group=>group.items);
 const summary=summarizeResources(visibleItems.filter(item=>!item.catalogOnly));
 const toggleGroup=(key:string)=>{const next=collapsed.includes(key)?collapsed.filter(id=>id!==key):[...collapsed,key];setCollapsed(next);savePreference('vrm.chestsorter.collapsed',next);};
 return <section className="chestsorter-view" data-testid="chestsorter-view">
  <div className={`chestsorter-source ${info?.status==='ready'?'ready':'attention'}`} role="status" data-testid="chestsorter-source" data-status={info?.status||'loading'}>
   {info?.status==='ready'?<CheckCircle2 size={18}/>:<TriangleAlert size={18}/>}
   <div><strong>{info?.status==='ready'?`${info.categories.length} категории ChestSorter`:info?.status==='invalid'?'Не удалось прочитать правила ChestSorter':info?.status==='unavailable'?'Файл категорий ChestSorter не найден':'Читаем категории ChestSorter…'}</strong><p>{info?.status==='ready'?`ChestSorter.categories.txt · правила v${info.version} · обновляются вместе с файлом мода`:info?.status==='invalid'?`Проверьте файл категорий${info.error?.line?`, строка ${info.error.line}`:''}. Предметы остаются в списке без назначения.`:info?.status==='unavailable'?'Нужен установленный ChestSorter в выбранной папке игры. Предметы остаются доступны ниже.':'Подключаем правила установленного мода.'}</p></div>
  </div>
  <div className="chestsorter-catalog-note" data-testid="chestsorter-catalog-note"><span>Весь реестр: <strong>{fmt(info?.catalogSummary?.registered||0)}</strong> предметов, включая спойлерные.</span><span className="chestsorter-new-legend"><i/>Красный — ещё не встречался в учёте этого мира{state.world?` · ${fmt(info?.catalogSummary?.newItems||0)}`:''}.</span><span>«—» — нет подтверждённых остатков.{!state.world&&' Выберите мир для пометок новых предметов.'}{Boolean(info?.catalogSummary?.unresolvedDefinitions)&&` Не распознано записей: ${fmt(info!.catalogSummary!.unresolvedDefinitions)}.`}</span></div>
  <div className="chestsorter-toolbar">
   <div className="search-field"><Search size={17}/><input aria-label="Поиск в категориях ChestSorter" placeholder="Предмет или категория ChestSorter…" value={query} onChange={e=>setQuery(e.target.value)}/>{query&&<button aria-label="Очистить поиск ChestSorter" onClick={()=>setQuery('')}><X size={14}/></button>}</div>
   <label className="chestsorter-select"><FolderTree size={15}/><select aria-label="Категория ChestSorter" value={selectedCategory} onChange={e=>setCategory(e.target.value)}><option value="all">Все категории</option>{groups.map(group=><option key={group.key} value={group.key}>{group.category.name}</option>)}</select></label>
   <label className="chestsorter-select"><ArrowDownUp size={15}/><select aria-label="Сортировка ChestSorter" value={sort} onChange={e=>setSort(e.target.value)}><option value="name">По названию</option><option value="quantity">По количеству</option><option value="shortage">По дефициту</option></select></label>
  </div>
  <div className="chestsorter-options"><label><input type="checkbox" checked={shortages} onChange={e=>setShortages(e.target.checked)}/>Только дефицит</label><label><input type="checkbox" checked={empty} onChange={e=>{setEmpty(e.target.checked);savePreference('vrm.chestsorter.empty',e.target.checked);}}/>Пустые категории</label><div role="group" aria-label="Столбцы ChestSorter"><span>Колонки</span>{[1,2].map(value=><button key={value} aria-pressed={columns===value} onClick={()=>{setColumns(value);savePreference('vrm.chestsorter.columns',value);}}>{value}</button>)}</div></div>
  <div className="chestsorter-summary" data-testid="chestsorter-summary" data-total={summary.totalItems} data-count={visibleItems.length} data-stock-count={summary.uniqueItems}><strong>{fmt(summary.totalItems)} ед.</strong><span>{fmt(visibleItems.length)} предметов</span><span>{summary.containers} сундуков</span><span>{summary.shortages} ниже минимума</span></div>
  <div className={`chestsorter-groups columns-${columns}`} data-testid="chestsorter-groups">
   {filtered.map(group=>{
    const open=Boolean(query.trim())||!collapsed.includes(group.key),stockItems=group.items.filter(item=>!item.catalogOnly),total=stockItems.reduce((sum,item)=>sum+item.quantity,0);
    return <section className="chestsorter-group" key={group.key} data-testid="chestsorter-category" data-category={group.category.id}>
     <div className="chestsorter-group-header"><button className="chestsorter-group-heading" aria-expanded={open} onClick={()=>toggleGroup(group.key)}><ChevronRight size={16} className={open?'expanded':''}/><span><strong>{group.category.name}</strong>{group.category.parentId&&<small>Входит в {groups.find(entry=>entry.category.id===group.category.parentId)?.category.name||group.category.parentId}</small>}</span><span className="chestsorter-group-count">{group.items.length} предм. · {stockItems.length?`${fmt(total)} ед.`:'каталог'}</span></button><ChestSetupCheckbox key={JSON.stringify([state.world?.id,group.key])} worldId={state.world?.id} categoryKey={group.key} name={group.category.name}/></div>
     {open&&<div className="chestsorter-items">{group.items.map(resource=><button className={`chestsorter-item${resource.newToWorld?' is-new':''}`} key={itemKey(resource)} data-testid="chestsorter-item" data-item={itemKey(resource)} data-quantity={resource.catalogOnly?undefined:resource.quantity} data-catalog-only={Boolean(resource.catalogOnly)} data-new={Boolean(resource.newToWorld)} onClick={()=>onSelect(itemKey(resource))}>
      <ResourceIcon prefab={resource.prefab} category={resource.category} name={resource.name} iconUrl={resource.iconUrl}/><span className="chestsorter-item-name"><strong title={`${resource.name} · ${resource.prefab}`}>{resource.name}</strong><small title={reasonText[resource.chestSorter?.reason||'']||resource.prefab}>{reasonText[resource.chestSorter?.reason||'']||resource.nameEn||resource.prefab}</small></span><span className="chestsorter-item-stock">{resource.catalogOnly?<strong className="chestsorter-no-stock" title="Определение из реестра; подтверждённых остатков в выбранной области нет">—</strong>:<><strong>{fmt(resource.quantity)} <small>/ {fmt(resource.minimum)}</small></strong><StockGauge quantity={resource.quantity} minimum={resource.minimum}/></>}</span>{resource.catalogOnly?<span className={`chestsorter-catalog-badge${resource.newToWorld?' is-new':''}`} title={resource.newToWorld?'Ещё не встречался менеджеру в этом мире':'Определение из реестра; данные об остатках в выбранной области отсутствуют'}>{resource.newToWorld?'НОВЫЙ':'КАТАЛОГ'}</span>:<span className={`data-status status-${resource.status.toLowerCase()}`} title="Свежесть последних данных"><i/>{resource.status==='SNAPSHOT'?'СНИМОК':resource.status==='STALE'?'УСТАРЕЛО':resource.status==='OFFLINE'?'ОФЛАЙН':resource.status}</span>}
     </button>)}{!group.items.length&&<p className="chestsorter-empty-category">В выбранной области нет ресурсов этой категории.</p>}</div>}
    </section>;
   })}
  </div>
  {!filtered.length&&<div className="no-results"><Search size={30}/><h3>{catalog.length?'Предметы не найдены':'Реестр предметов пока не получен'}</h3><p>{catalog.length?'Измените поиск, категорию или фильтр дефицита.':'Подключите игровой источник или создайте локальный реестр из установленной игры.'}</p></div>}
  <p className="chestsorter-footnote">Здесь показаны все распознанные определения из реестра, включая служебные, по правилам ChestSorter. Красная пометка отражает историю менеджера, а не открытые рецепты персонажа. Остатки и дефицит учитывают только отслеживаемые ресурсы выбранной области. Перемещение между сундуками выполняется через Push в игре.</p>
 </section>;
}
