import { CSSProperties, memo, MutableRefObject, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Columns3, TriangleAlert } from 'lucide-react';
import { ResourceIcon } from './ResourceIcon';
import { StockGauge } from './StockGauge';
import { groupResources, itemKey, readPreference, resourceAvailable, resourceReserved, resourceZones, savePreference, SortColumn } from './catalog';
import { categoryKey, clusterGroups, clusterKey, compactGroupsKey, CompactGroupPreferences, defaultGroupPreferences, groupIsOpen, GroupMode, isCompactGroupPreferences, legacyCategoryKey, ResourceSummary, summarizeResources, toggleCollapsedGroup } from './clusters';
import { Resource, State } from './types';
import './clusters.css';

type Column='icon'|'name'|'quantity'|'available'|'reserved'|'containers'|'zone'|'status';
const columns:{id:Column;label:string;sort?:SortColumn;title?:string}[]=[
 {id:'icon',label:'Иконка'}, {id:'name',label:'Предмет',sort:'name'}, {id:'quantity',label:'Всего',sort:'quantity'},
 {id:'available',label:'Доступно',sort:'available',title:'Количество, доступное по данным backend. Резервы не реализованы.'},
 {id:'reserved',label:'Резерв',sort:'reserved',title:'Резервирование пока не реализовано. Прочерк означает отсутствие учёта резервов.'},
 {id:'containers',label:'Сундуки',sort:'containers'}, {id:'zone',label:'Зона',sort:'zone'}, {id:'status',label:'Статус',sort:'status'}
];
const defaultColumns=columns.map(c=>c.id);
const fmt=(n:number)=>new Intl.NumberFormat('ru-RU').format(n);
export const uiStatus=(status:string)=>['LIVE','STALE','OFFLINE','SNAPSHOT','MIXED'].includes(status)?status:'UNKNOWN';
const summaryTitle=(summary:ResourceSummary)=>`${fmt(summary.uniqueItems)} типов · ${fmt(summary.totalItems)} ед. · ${fmt(summary.containers)} сундуков · дефицитных: ${fmt(summary.shortages)}. Состояния: ${Object.entries(summary.statusCounts).map(([status,count])=>`${status}: ${count}`).join(', ')||'нет данных'}`;

export function CompactCatalog({resources,state,selected,onSelect,sort,direction,onSort,active,scrollMemory,query=''}:{resources:Resource[];state:State;selected:string|null;onSelect:(id:string)=>void;sort:SortColumn;direction:'asc'|'desc';onSort:(column:SortColumn)=>void;active:boolean;scrollMemory:MutableRefObject<{top:number;left:number}>;query?:string}){
 const [density,setDensity]=useState(()=>readPreference('vrm.rowHeight',32,(v):v is number=>typeof v==='number'&&[30,32,34,40].includes(v)));
 const [preferences,setPreferences]=useState(()=>readPreference(compactGroupsKey,defaultGroupPreferences,isCompactGroupPreferences));
 const [layoutColumns,setLayoutColumns]=useState(()=>readPreference('vrm.compactColumns.v1',1,(value):value is 1|2=>value===1||value===2));
 const [visible,setVisible]=useState(()=>readPreference('vrm.columns',defaultColumns,(v):v is Column[]=>Array.isArray(v)&&v.includes('name')&&v.every(c=>defaultColumns.includes(c))));
 const activeColumns=useMemo(()=>columns.filter(c=>visible.includes(c.id)),[visible]);
 const groups=useMemo(()=>clusterGroups(resources,state.clusters).filter(group=>group.items.length),[resources,state.clusters]);
 const legacyGroups=useMemo(()=>groupResources(resources,true),[resources]);
 const searching=Boolean(query.trim());
 const groupKeys=useMemo(()=>preferences.mode==='clusters'?groups.flatMap(group=>[clusterKey(group.id),...group.categories.filter(category=>category.items.length).map(category=>categoryKey(group.id,category.id))]):legacyGroups.map(group=>legacyCategoryKey(group.category)),[groups,legacyGroups,preferences.mode]);
 const scrollRefs=useRef<(HTMLDivElement|null)[]>([]),hydratedScroll=useRef(false);
 const secondaryScroll=useRef({top:0,left:0});
 const selectRef=useRef(onSelect);
 useLayoutEffect(()=>{selectRef.current=onSelect;},[onSelect]);
 const selectItem=useCallback((id:string)=>selectRef.current(id),[]);
 useLayoutEffect(()=>{
  if(!hydratedScroll.current){
   hydratedScroll.current=true;
   const saved=readPreference('vrm.compactScroll.v1',null,(value):value is {version:1;top:number;left:number}=>Boolean(value&&typeof value==='object'&&(value as {version?:number}).version===1&&Number.isFinite((value as {top?:number}).top)&&Number.isFinite((value as {left?:number}).left)));
   if(saved)scrollMemory.current={top:Math.max(0,saved.top),left:Math.max(0,saved.left)};
   const secondary=readPreference('vrm.compactScroll.secondary.v1',null,(value):value is {top:number;left:number}=>Boolean(value&&typeof value==='object'&&Number.isFinite((value as {top?:number}).top)&&Number.isFinite((value as {left?:number}).left)));
   if(secondary)secondaryScroll.current={top:Math.max(0,secondary.top),left:Math.max(0,secondary.left)};
  }
  if(active)scrollRefs.current.forEach((element,index)=>{if(element){const position=index===0?scrollMemory.current:secondaryScroll.current;element.scrollTop=position.top;element.scrollLeft=position.left;}});
 },[active,resources.length,scrollMemory,layoutColumns]);
 const panes=useMemo(()=>{
  if(layoutColumns===1)return [resources];
  const sections=preferences.mode==='clusters'?groups.map(group=>group.categories.flatMap(category=>category.items)):preferences.mode==='categories'?legacyGroups.map(group=>group.items):[];
  if(sections.length>1){const middle=Math.ceil(sections.length/2);return [sections.slice(0,middle).flat(),sections.slice(middle).flat()];}
  const ordered=sections.length?sections[0]:resources,middle=Math.ceil(ordered.length/2);
  return [ordered.slice(0,middle),ordered.slice(middle)];
 },[layoutColumns,resources,preferences.mode,groups,legacyGroups]);
 const updatePreferences=(next:CompactGroupPreferences)=>{setPreferences(next);savePreference(compactGroupsKey,next);};
 const toggleGroup=(key:string)=>updatePreferences({...preferences,collapsed:toggleCollapsedGroup(preferences.collapsed,key)});
 const changeMode=(mode:GroupMode)=>updatePreferences({...preferences,mode});
 const toggleColumn=(id:Column)=>{if(id==='name')return;setVisible(current=>{const next=current.includes(id)?current.filter(c=>c!==id):[...current,id];savePreference('vrm.columns',next);return next;});};
 const renderRows=(items:Resource[],depth:number)=>items.map(resource=><CompactRow key={itemKey(resource)} resource={resource} columns={activeColumns} depth={depth} selected={itemKey(resource)===selected} zones={resourceZones(resource,state)} onSelect={selectItem}/>);
 const renderHeading=(key:string,name:string,summary:ResourceSummary,level:'cluster'|'category')=>{
  const open=groupIsOpen(key,preferences.collapsed,query);
  return <tr key={key} className={`compact-category-row compact-${level}-row`} data-testid={`compact-${level}-group`} data-group-key={key} data-cluster-id={level==='cluster'?JSON.parse(key.slice('cluster:'.length)):undefined} data-category-key={level==='category'?key:undefined} data-unique-items={summary.uniqueItems} data-total-items={summary.totalItems} data-containers={summary.containers} data-shortages={summary.shortages} data-status={summary.status}>
   <th colSpan={activeColumns.length} scope="rowgroup"><button onClick={()=>toggleGroup(key)} disabled={searching} aria-expanded={open} title={searching?'Родительские группы раскрыты для глобального поиска':summaryTitle(summary)}>
    {open?<ChevronDown size={13}/>:<ChevronRight size={13}/>}<span className="compact-group-name">{name}</span><em>{fmt(summary.uniqueItems)} типов</em>
    <span className="compact-group-total">{fmt(summary.totalItems)} <small>ед.</small></span>
    <span className={`compact-status status-${summary.status.toLowerCase()}`} title={summaryTitle(summary)}>{summary.status}</span>
    {summary.status==='MIXED'&&<span className="compact-group-source-counts">{Object.entries(summary.statusCounts).map(([status,count])=>`${status} ${fmt(count)}`).join(' · ')}</span>}
   </button></th>
  </tr>;
 };
 return <div className="compact-catalog" data-testid="compact-catalog" data-grouping={preferences.mode} data-layout-columns={layoutColumns} style={{'--row-height':`${density}px`} as CSSProperties}>
  <div className="compact-options">
   <label>Группировка<select aria-label="Группировка" data-testid="compact-grouping" value={preferences.mode} onChange={event=>changeMode(event.target.value as GroupMode)}><option value="clusters">Кластеры</option><option value="categories">Категории</option><option value="none">Без группировки</option></select></label>
   <label>Колонки<select aria-label="Количество колонок" data-testid="compact-layout-columns" value={layoutColumns} onChange={event=>{const next=Number(event.target.value) as 1|2;setLayoutColumns(next);savePreference('vrm.compactColumns.v1',next);}}><option value={1}>1</option><option value={2}>2</option></select></label>
   <label>Строка<select aria-label="Высота строки" value={density} onChange={event=>{const next=Number(event.target.value);setDensity(next);savePreference('vrm.rowHeight',next);}}>{[30,32,34,40].map(n=><option key={n} value={n}>{n} px</option>)}</select></label>
   {preferences.mode!=='none'&&<span className="compact-collapse-actions"><button className="compact-link" disabled={searching||!groupKeys.length} onClick={()=>updatePreferences({...preferences,collapsed:[...new Set([...preferences.collapsed,...groupKeys])]})}>Свернуть всё</button><span>·</span><button className="compact-link" disabled={searching||!groupKeys.length} onClick={()=>updatePreferences({...preferences,collapsed:preferences.collapsed.filter(key=>!groupKeys.includes(key))})}>Развернуть всё</button></span>}
   <details className="column-picker" data-dismiss-on-outside><summary><Columns3 size={13}/>Столбцы<ChevronDown size={12}/></summary><div role="group" aria-label="Видимость столбцов">{columns.map(c=><label key={c.id}><input type="checkbox" checked={visible.includes(c.id)} disabled={c.id==='name'} onChange={()=>toggleColumn(c.id)}/>{c.label}</label>)}</div></details>
  </div>
  {searching&&preferences.mode!=='none'&&<div className="compact-search-context" role="status">Группы с результатами поиска раскрыты. Сохранённое сворачивание восстановится после очистки поиска.</div>}
  {layoutColumns===2&&<p className="compact-columns-note">Итоги групп относятся к предметам своей колонки. Прокрутка каждой колонки независима.</p>}
  <div className="compact-columns-grid">{panes.map((items,index)=><div className="compact-pane" key={index} data-testid="compact-pane">
  <div className="compact-table-scroll" data-testid={index===0?'compact-scroll':'compact-scroll-secondary'} ref={element=>{scrollRefs.current[index]=element;}} onScroll={event=>{if(active){const position={top:event.currentTarget.scrollTop,left:event.currentTarget.scrollLeft};if(index===0){scrollMemory.current=position;savePreference('vrm.compactScroll.v1',{version:1,...position});}else{secondaryScroll.current=position;savePreference('vrm.compactScroll.secondary.v1',position);}}}} tabIndex={0} aria-label={`Плотный каталог ресурсов${layoutColumns===2?`, колонка ${index+1}`:''}`}>
   <table className="compact-table" data-testid={index===0?'compact-resource-table':'compact-resource-table-secondary'}><colgroup>{activeColumns.map(c=><col key={c.id} className={`column-${c.id}`}/>)}</colgroup><thead><tr>{activeColumns.map(c=><th key={c.id} scope="col" className={`cell-${c.id}`} title={c.title} aria-sort={c.sort&&sort===c.sort?(direction==='asc'?'ascending':'descending'):c.sort?'none':undefined}>{c.sort?<button onClick={()=>onSort(c.sort!)} aria-label={`Сортировать: ${c.label}`}>{c.label}{sort===c.sort&&(direction==='asc'?<ArrowUp size={11}/>:<ArrowDown size={11}/>)}</button>:<span className="sr-only">{c.label}</span>}</th>)}</tr></thead>
    {preferences.mode==='clusters'&&clusterGroups(items,state.clusters).filter(group=>group.items.length).map(group=><tbody key={group.id} data-cluster-id={group.id}>
     {renderHeading(clusterKey(group.id),group.name,group.summary,'cluster')}
     {groupIsOpen(clusterKey(group.id),preferences.collapsed,query)&&group.categories.filter(category=>category.items.length).map(category=>[
      renderHeading(categoryKey(group.id,category.id),category.name,category.summary,'category'),
      groupIsOpen(categoryKey(group.id,category.id),preferences.collapsed,query)&&renderRows(category.items,2)
     ])}
    </tbody>)}
    {preferences.mode==='categories'&&groupResources(items,true).map(group=><tbody key={group.category}>
     {renderHeading(legacyCategoryKey(group.category),group.category,summarizeResources(group.items),'category')}
     {groupIsOpen(legacyCategoryKey(group.category),preferences.collapsed,query)&&renderRows(group.items,1)}
    </tbody>)}
    {preferences.mode==='none'&&<tbody>{renderRows(items,0)}</tbody>}
   </table>
  </div></div>)}</div>
 </div>;
}

type RowProps={resource:Resource;columns:typeof columns;depth:number;selected:boolean;zones:string;onSelect:(id:string)=>void};
const rowFields=['id','prefab','name','nameRu','nameEn','quantity','minimum','status','category','iconUrl','availableQuantity','reservedQuantity','reservationsImplemented'] as const;
const CompactRow=memo(function CompactRow({resource:r,columns:activeColumns,depth,selected,zones,onSelect}:RowProps){
 const low=r.minimum>r.quantity,unknown=r.diagnostics?.includes('UNKNOWN ITEM');
 const available=resourceAvailable(r),reserved=resourceReserved(r);
 return <tr data-resource-id={itemKey(r)} data-prefab={r.prefab} data-testid="compact-resource-row" data-depth={depth} className={`${selected?'is-selected':''} ${low?'has-shortage':''}`} tabIndex={0} aria-selected={selected} aria-label={`${r.name}, ${fmt(r.quantity)} единиц, ${uiStatus(r.status)}`} onClick={()=>onSelect(itemKey(r))} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onSelect(itemKey(r));}}}>
  {activeColumns.map(column=><td key={column.id} className={`cell-${column.id}`}>
   {column.id==='icon'&&<ResourceIcon prefab={r.prefab} name={r.name} category={r.category} iconUrl={r.iconUrl}/>}
   {column.id==='name'&&<div className="compact-item-name"><strong title={[r.nameRu,r.nameEn,r.prefab,itemKey(r)].filter(Boolean).join(' · ')}>{r.name}</strong>{unknown&&<span className="unknown-tag" title="UNKNOWN ITEM: исходный идентификатор сохранён">?</span>}{low&&<span className="compact-shortage" title={`Дефицит ${fmt(r.minimum-r.quantity)} · минимум ${fmt(r.minimum)}`}><TriangleAlert size={11}/>{fmt(r.minimum-r.quantity)}</span>}</div>}
   {column.id==='quantity'&&<span className="compact-quantity-stock"><span>{fmt(r.quantity)}</span><StockGauge quantity={r.quantity} minimum={r.minimum} compact showLabel={false}/></span>}
   {column.id==='available'&&(available!==null?fmt(available):<span className="unknown-value" title="Доступный остаток не передан">—</span>)}
   {column.id==='reserved'&&(reserved!==null?fmt(reserved):<span className="unknown-value" title="Резервирование не реализовано">—</span>)}
   {column.id==='containers'&&new Set(r.containerIds).size}
   {column.id==='zone'&&<span title={zones}>{zones}</span>}
   {column.id==='status'&&<span className={`compact-status status-${uiStatus(r.status).toLowerCase()}`}>{uiStatus(r.status)}</span>}
  </td>)}
 </tr>;
},(previous,next)=>previous.columns===next.columns&&previous.depth===next.depth&&previous.selected===next.selected&&previous.zones===next.zones&&previous.onSelect===next.onSelect&&rowFields.every(field=>previous.resource[field]===next.resource[field])&&new Set(previous.resource.containerIds).size===new Set(next.resource.containerIds).size&&previous.resource.diagnostics?.includes('UNKNOWN ITEM')===next.resource.diagnostics?.includes('UNKNOWN ITEM'));
