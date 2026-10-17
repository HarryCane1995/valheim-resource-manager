import { useEffect, useState } from 'react';
import { Check, Clock3, MapPin, Search, ShieldCheck, SlidersHorizontal, TriangleAlert, Warehouse, X } from 'lucide-react';
import { itemKey, sameItem } from './catalog';
import { ResourceIcon } from './ResourceIcon';
import { uiStatus } from './CompactCatalog';
import { Container, Resource, State } from './types';

type Mutate=(path:string,method:string,body:unknown)=>Promise<boolean>;
const fmt=(n:number)=>new Intl.NumberFormat('ru-RU').format(n);
const chestName=(c:Container)=>c.label||c.name||'Сундук без метки';
const Status=({status}:{status:string})=><span className={`data-status status-${uiStatus(status).toLowerCase()}`}><i/>{uiStatus(status)}</span>;

export function ResourceDrawer({resource:r,state,onClose,mutate,busy}:{resource:Resource;state:State;onClose:()=>void;mutate:Mutate;busy:boolean}){
 const [minimum,setMinimum]=useState(String(r.minimum||0)),[saved,setSaved]=useState(false),[containerQuery,setContainerQuery]=useState('');
 useEffect(()=>{setMinimum(String(r.minimum||0));setSaved(false);},[r.id,r.prefab,r.minimum]);
 useEffect(()=>{setContainerQuery('');},[r.id,r.prefab]);
 useEffect(()=>{const handler=(e:KeyboardEvent)=>{if(e.key==='Escape')onClose();};document.addEventListener('keydown',handler);return()=>document.removeEventListener('keydown',handler);},[onClose]);
 const containers=state.containers.filter(c=>c.items.some(i=>sameItem(i,r)));
 const matchingContainers=containers.filter(c=>`${chestName(c)} ${c.id} ${c.zdoId||''} ${Math.round(c.x)} ${Math.round(c.z)} ${c.zoneIds.map(id=>state.zones.find(z=>z.id===id)?.name||'').join(' ')}`.toLocaleLowerCase('ru').includes(containerQuery.toLocaleLowerCase('ru')));
 const low=r.minimum>r.quantity;
 return <div className="drawer-overlay" onClick={onClose}><aside className="resource-drawer" role="dialog" aria-label={`Ресурс: ${r.name}`} data-testid="resource-drawer" onClick={e=>e.stopPropagation()}>
  <div className="drawer-top"><span>РЕСУРС · МЕСТА ХРАНЕНИЯ</span><button className="icon-button" onClick={onClose} aria-label="Закрыть карточку"><X size={20}/></button></div>
  <div className="drawer-resource-head"><span className="drawer-art"><ResourceIcon prefab={r.prefab} name={r.name} iconUrl={r.iconUrl} category={r.category} large/></span><div><span className="resource-category">{r.category}{r.subcategory?` / ${r.subcategory}`:''}</span><h2>{r.name}</h2>{r.nameEn&&r.nameEn!==r.name&&<p className="drawer-english">{r.nameEn}</p>}<Status status={r.status}/></div></div>
  <dl className="drawer-item-metadata"><div><dt>ID</dt><dd title={itemKey(r)}>{itemKey(r)}</dd></div><div><dt>Prefab</dt><dd>{r.prefab}</dd></div><div><dt>Стопка</dt><dd>{r.maxStack??'Не подтверждена'}</dd></div>{r.quality!==undefined&&<div><dt>Качество</dt><dd>{r.quality}</dd></div>}{r.variant!==undefined&&<div><dt>Вариант</dt><dd>{r.variant}</dd></div>}</dl>
  {!!r.diagnostics?.length&&<div className="item-diagnostics" aria-label="Диагностика предмета">{r.diagnostics.map(diagnostic=><span key={diagnostic}>{diagnostic}</span>)}</div>}
  {!!r.variants?.length&&<details className="drawer-variants"><summary>Качество и варианты · {r.variants.length}</summary><div>{r.variants.map((variant,index)=><p key={`${variant.quality??'?'}:${variant.variant??'?'}:${variant.modId??''}:${index}`}><span>{variant.quality===undefined?'Качество не передано':`Качество ${variant.quality}`}{variant.variant!==undefined?` · вариант ${variant.variant}`:''}{variant.modId?` · мод ${variant.modId}`:''}</span><strong>{fmt(variant.quantity)}</strong></p>)}</div></details>}
  <div className="drawer-total"><div><span>Всего в выбранной области</span><strong data-testid="drawer-resource-total">{fmt(r.quantity)}<small>ед.</small></strong></div><span><Warehouse size={16}/>{containers.length} мест</span></div>
  {r.status!=='LIVE'&&<div className="drawer-notice"><Clock3 size={16}/><p>{r.status==='SNAPSHOT'?'Снимок сохранения. Это не live-остатки.':'Показано последнее подтверждённое состояние контейнеров.'}</p></div>}
  <section className="minimum-panel"><div><h3><SlidersHorizontal size={16}/>Минимальный запас</h3><p>Порог предупреждения в приложении.</p></div><form onSubmit={async e=>{e.preventDefault();if(await mutate('/api/minimums','PUT',{worldId:state.world?.id,prefab:r.prefab,minimum:Number(minimum)})){setSaved(true);setTimeout(()=>setSaved(false),2200);}}}><input type="number" min="0" max="2147483647" step="1" required value={minimum} onChange={e=>setMinimum(e.target.value)} aria-label="Минимальный запас"/><button className="button secondary" disabled={busy}>{saved?<><Check size={14}/>Сохранено</>:'Сохранить'}</button></form>{low&&<div className="shortage-hint"><TriangleAlert size={14}/>До минимума: {fmt(r.minimum-r.quantity)} ед.</div>}</section>
  <div className="drawer-section-title"><h3>Где хранится</h3><span>{matchingContainers.length} из {containers.length}</span></div>
  <div className="search-field drawer-container-search"><Search size={14}/><input placeholder="Сундук, зона, ID…" aria-label="Поиск сундуков предмета" value={containerQuery} onChange={e=>setContainerQuery(e.target.value)}/></div>
  <div className="drawer-container-list" data-testid="drawer-container-list">{matchingContainers.map(c=><article className="drawer-container" key={c.id}><div><span className="container-icon"><Warehouse size={18}/></span><div><h4>{chestName(c)}</h4><span>{c.zoneIds.map(id=>state.zones.find(z=>z.id===id)?.name).filter(Boolean).join(', ')||'Вне складских зон'}</span></div><strong>{fmt(c.items.filter(i=>sameItem(i,r)).reduce((sum,i)=>sum+i.quantity,0))}<small>ед.</small></strong></div><div className="drawer-container-meta"><span><MapPin size={12}/>{Math.round(c.x)} / {Math.round(c.y)} / {Math.round(c.z)}</span><Status status={c.status}/></div><p><Clock3 size={12}/>{new Date(c.observedAt).toLocaleString('ru-RU')}<span title={c.id}>{c.zdoId&&!c.zdoId.startsWith('snapshot:')?c.zdoId:'Снимок контейнера'}</span></p></article>)}{!matchingContainers.length&&<p className="drawer-empty">{containers.length?'По этому запросу сундуков нет.':'Предмет отсутствует в текущем списке контейнеров.'}</p>}</div>
  <div className="drawer-bottom"><ShieldCheck size={14}/>Запасы и игровые сохранения не изменяются.</div>
 </aside></div>;
}
