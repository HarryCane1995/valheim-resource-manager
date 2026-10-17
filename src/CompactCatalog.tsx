import { CSSProperties, MutableRefObject, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Columns3, TriangleAlert } from 'lucide-react';
import { ResourceIcon } from './ResourceIcon';
import { groupResources, itemKey, readPreference, resourceAvailable, resourceReserved, resourceZones, savePreference, SortColumn } from './catalog';
import { Resource, State } from './types';

type Column='icon'|'name'|'quantity'|'available'|'reserved'|'containers'|'zone'|'status';
const columns:{id:Column;label:string;sort?:SortColumn;title?:string}[]=[
 {id:'icon',label:'Иконка'}, {id:'name',label:'Предмет',sort:'name'}, {id:'quantity',label:'Всего',sort:'quantity'},
 {id:'available',label:'Доступно',sort:'available',title:'Количество, доступное по данным backend. Резервы не реализованы.'},
 {id:'reserved',label:'Резерв',sort:'reserved',title:'Резервирование пока не реализовано. Прочерк означает отсутствие учёта резервов.'},
 {id:'containers',label:'Сундуки',sort:'containers'}, {id:'zone',label:'Зона',sort:'zone'}, {id:'status',label:'Статус',sort:'status'}
];
const defaultColumns=columns.map(c=>c.id);
const fmt=(n:number)=>new Intl.NumberFormat('ru-RU').format(n);
export const uiStatus=(status:string)=>['LIVE','STALE','OFFLINE','SNAPSHOT'].includes(status)?status:'UNKNOWN';

export function CompactCatalog({resources,state,selected,onSelect,sort,direction,onSort,active,scrollMemory}:{resources:Resource[];state:State;selected:string|null;onSelect:(id:string)=>void;sort:SortColumn;direction:'asc'|'desc';onSort:(column:SortColumn)=>void;active:boolean;scrollMemory:MutableRefObject<{top:number;left:number}>}){
 const [density,setDensity]=useState(()=>readPreference('vrm.rowHeight',32,(v):v is number=>typeof v==='number'&&[30,32,34,40].includes(v)));
 const [grouped,setGrouped]=useState(()=>readPreference('vrm.grouped',false,(v):v is boolean=>typeof v==='boolean'));
 const [visible,setVisible]=useState(()=>readPreference('vrm.columns',defaultColumns,(v):v is Column[]=>Array.isArray(v)&&v.includes('name')&&v.every(c=>defaultColumns.includes(c))));
 const [collapsed,setCollapsed]=useState<string[]>(()=>readPreference('vrm.collapsed',[],(v):v is string[]=>Array.isArray(v)&&v.every(c=>typeof c==='string')));
 const activeColumns=columns.filter(c=>visible.includes(c.id));
 const groups=useMemo(()=>groupResources(resources,grouped),[resources,grouped]);
 const scrollRef=useRef<HTMLDivElement>(null);
 useLayoutEffect(()=>{if(active&&scrollRef.current){scrollRef.current.scrollTop=scrollMemory.current.top;scrollRef.current.scrollLeft=scrollMemory.current.left;}},[active,resources.length,scrollMemory]);
 const toggleColumn=(id:Column)=>{if(id==='name')return;setVisible(current=>{const next=current.includes(id)?current.filter(c=>c!==id):[...current,id];savePreference('vrm.columns',next);return next;});};
 const toggleGroup=(category:string)=>setCollapsed(current=>{const next=current.includes(category)?current.filter(c=>c!==category):[...current,category];savePreference('vrm.collapsed',next);return next;});
 return <div className="compact-catalog" data-testid="compact-catalog" style={{'--row-height':`${density}px`} as CSSProperties}>
  <div className="compact-options">
   <label>Строка<select aria-label="Высота строки" value={density} onChange={e=>{const next=Number(e.target.value);setDensity(next);savePreference('vrm.rowHeight',next);}}>{[30,32,34,40].map(n=><option key={n} value={n}>{n} px</option>)}</select></label>
   <label className="compact-group-label"><input type="checkbox" checked={grouped} onChange={e=>{setGrouped(e.target.checked);savePreference('vrm.grouped',e.target.checked);}}/>По категориям</label>
   {grouped&&<button className="compact-link" onClick={()=>{const next=collapsed.length?[]:groups.map(g=>g.category);setCollapsed(next);savePreference('vrm.collapsed',next);}}>{collapsed.length?'Развернуть все':'Свернуть все'}</button>}
   <span className="compact-legend"><span className="shortage-dot"/>Дефицит<span className="legend-separator">·</span>Резервы: не реализованы</span>
   <details className="column-picker"><summary><Columns3 size={13}/>Столбцы<ChevronDown size={12}/></summary><div role="group" aria-label="Видимость столбцов">{columns.map(c=><label key={c.id}><input type="checkbox" checked={visible.includes(c.id)} disabled={c.id==='name'} onChange={()=>toggleColumn(c.id)}/>{c.label}</label>)}</div></details>
  </div>
  <div className="compact-table-scroll" data-testid="compact-scroll" ref={scrollRef} onScroll={e=>{if(active)scrollMemory.current={top:e.currentTarget.scrollTop,left:e.currentTarget.scrollLeft};}} tabIndex={0} aria-label="Плотный каталог ресурсов">
   <table className="compact-table" data-testid="compact-resource-table"><colgroup>{activeColumns.map(c=><col key={c.id} className={`column-${c.id}`}/>)}</colgroup><thead><tr>{activeColumns.map(c=><th key={c.id} scope="col" className={`cell-${c.id}`} title={c.title} aria-sort={c.sort&&sort===c.sort?(direction==='asc'?'ascending':'descending'):c.sort?'none':undefined}>{c.sort?<button onClick={()=>onSort(c.sort!)} aria-label={`Сортировать: ${c.label}`}>{c.label}{sort===c.sort&&(direction==='asc'?<ArrowUp size={11}/>:<ArrowDown size={11}/>)}</button>:<span className="sr-only">{c.label}</span>}</th>)}</tr></thead>
    {groups.map(group=><tbody key={group.category||'all'}>{grouped&&<tr className="compact-category-row"><th colSpan={activeColumns.length} scope="rowgroup"><button onClick={()=>toggleGroup(group.category)} aria-expanded={!collapsed.includes(group.category)}>{collapsed.includes(group.category)?<ChevronRight size={13}/>:<ChevronDown size={13}/>}<span>{group.category}</span><em>{group.items.length}</em></button></th></tr>}{(!grouped||!collapsed.includes(group.category))&&group.items.map(r=>{
     const low=r.minimum>r.quantity;const unknown=r.diagnostics?.includes('UNKNOWN ITEM');const zones=resourceZones(r,state);
     return <tr key={itemKey(r)} data-resource-id={itemKey(r)} data-prefab={r.prefab} data-testid="compact-resource-row" className={`${itemKey(r)===selected?'is-selected':''} ${low?'has-shortage':''}`} tabIndex={0} aria-selected={itemKey(r)===selected} aria-label={`${r.name}, ${fmt(r.quantity)} единиц, ${uiStatus(r.status)}`} onClick={()=>onSelect(itemKey(r))} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onSelect(itemKey(r));}}}>
      {activeColumns.map(c=><td key={c.id} className={`cell-${c.id}`}>
       {c.id==='icon'&&<ResourceIcon prefab={r.prefab} name={r.name} category={r.category} iconUrl={r.iconUrl}/>}
       {c.id==='name'&&<div className="compact-item-name"><strong title={[r.nameRu,r.nameEn,r.prefab,itemKey(r)].filter(Boolean).join(' · ')}>{r.name}</strong>{unknown&&<span className="unknown-tag" title="UNKNOWN ITEM: исходный идентификатор сохранён">?</span>}{low&&<span className="compact-shortage" title={`Дефицит ${fmt(r.minimum-r.quantity)} · минимум ${fmt(r.minimum)}`}><TriangleAlert size={11}/>{fmt(r.minimum-r.quantity)}</span>}</div>}
       {c.id==='quantity'&&fmt(r.quantity)}
       {c.id==='available'&&(resourceAvailable(r)!==null?fmt(resourceAvailable(r)!):<span className="unknown-value" title="Доступный остаток не передан">—</span>)}
       {c.id==='reserved'&&(resourceReserved(r)!==null?fmt(resourceReserved(r)!):<span className="unknown-value" title="Резервирование не реализовано">—</span>)}
       {c.id==='containers'&&r.containerIds.length}
       {c.id==='zone'&&<span title={zones}>{zones}</span>}
       {c.id==='status'&&<span className={`compact-status status-${uiStatus(r.status).toLowerCase()}`}>{uiStatus(r.status)}</span>}
      </td>)}
     </tr>;
    })}</tbody>)}
   </table>
  </div>
 </div>;
}
