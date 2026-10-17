import { useMemo, useState } from 'react';
import { Boxes, ChevronDown, ChevronRight, Coins, FlaskConical, Hammer, HelpCircle, Leaf, Shield, Skull, Utensils, Warehouse } from 'lucide-react';
import { itemKey, readPreference, savePreference } from './catalog';
import { clusterGroups } from './clusters';
import { ResourceIcon } from './ResourceIcon';
import { StockGauge } from './StockGauge';
import { Resource, State } from './types';
import './cluster-normal.css';

const fmt=(n:number)=>new Intl.NumberFormat('ru-RU').format(n);
const symbols={construction:Hammer,metallurgy:Boxes,agriculture:Leaf,food:Utensils,alchemy:FlaskConical,equipment:Shield,loot:Skull,valuables:Coins,unclassified:HelpCircle};
const statusLabels:Record<string,string>={LIVE:'LIVE',SNAPSHOT:'СНИМОК',STALE:'УСТАРЕЛО',OFFLINE:'ОФЛАЙН',MIXED:'СМЕШАННЫЕ ДАННЫЕ',UNKNOWN:'НЕТ ДАННЫХ'};
type NormalColumns='auto'|'1'|'2';

export function ClusterOverview({resources,state,query,clusterId='all',onSelect}:{resources:Resource[];state:State;query:string;clusterId?:string;onSelect:(id:string)=>void}){
 const groups=useMemo(()=>clusterGroups(resources,state.clusters).filter(group=>(clusterId==='all'||group.id===clusterId)&&(!query.trim()||group.items.length>0)),[resources,state.clusters,clusterId,query]);
 const [expanded,setExpanded]=useState<string[]>(()=>readPreference('vrm.normalClusterOpen.v1',[],(v):v is string[]=>Array.isArray(v)&&v.every(x=>typeof x==='string')));
 const [columns,setColumns]=useState<NormalColumns>(()=>readPreference('vrm.normalColumns.v1','auto',(v):v is NormalColumns=>v==='auto'||v==='1'||v==='2'));
 const searching=Boolean(query.trim());
 const open=(key:string)=>searching||expanded.includes(key);
 const toggle=(key:string)=>setExpanded(previous=>{const next=previous.includes(key)?previous.filter(x=>x!==key):[...previous,key];savePreference('vrm.normalClusterOpen.v1',next);return next;});
 return <div className="cluster-overview" data-testid="cluster-overview" data-layout-columns={columns}>
  <div className="cluster-overview-actions"><span>Кластер → категория → предмет</span><label className="normal-layout-columns">Столбцы<select aria-label="Количество колонок в обзоре" data-testid="normal-layout-columns" value={columns} onChange={event=>{const next=event.target.value as NormalColumns;setColumns(next);savePreference('vrm.normalColumns.v1',next);}}><option value="auto">Авто</option><option value="1">1</option><option value="2">2</option></select></label><button type="button" onClick={()=>{const next=groups.flatMap(g=>[g.id,...g.categories.map(c=>`${g.id}/${c.id}`)]);setExpanded(next);savePreference('vrm.normalClusterOpen.v1',next);}}>Развернуть всё</button><button type="button" onClick={()=>{setExpanded([]);savePreference('vrm.normalClusterOpen.v1',[]);}}>Свернуть всё</button></div>
  <div className="cluster-overview-grid">{groups.map(group=>{
   const Icon=symbols[group.id as keyof typeof symbols]||Boxes;
   const summary=group.summary;
   const status=summary.status||'UNKNOWN';
   return <article className={`cluster-block ${open(group.id)?'expanded':''}`} key={group.id} data-testid="cluster-card" data-cluster-id={group.id} data-total={summary.totalItems}>
    <button type="button" className="cluster-block-toggle" aria-expanded={open(group.id)} onClick={()=>toggle(group.id)}>
     <span className={`cluster-symbol cluster-${group.id}`}><Icon size={20}/></span><span className="cluster-block-heading"><strong>{group.name}</strong><span className={`cluster-data-status ${status.toLowerCase()}`} title={Object.entries(summary.statusCounts).map(([key,count])=>`${statusLabels[key]||key}: ${count}`).join(', ')}>{statusLabels[status]||status}</span></span>{open(group.id)?<ChevronDown size={17}/>:<ChevronRight size={17}/>}</button>
    <div className="cluster-metrics"><span><strong>{fmt(summary.uniqueItems)}</strong>типов</span><span><strong data-testid="cluster-total">{fmt(summary.totalItems)}</strong>единиц</span><span><strong>{fmt(summary.containers)}</strong>сундуков</span><span className={summary.shortages?'has-shortages':''}><strong>{summary.shortages}</strong>дефицитных</span></div>
    {open(group.id)&&<div className="cluster-categories">{group.categories.filter(category=>category.items.length>0).map(category=>{const key=`${group.id}/${category.id}`;return <section className="cluster-category" key={key}><button type="button" className="cluster-category-toggle" aria-expanded={open(key)} onClick={()=>toggle(key)}>{open(key)?<ChevronDown size={13}/>:<ChevronRight size={13}/>}<strong>{category.name}</strong><span>{category.items.length}</span></button>{open(key)&&<div className="cluster-category-items">{category.items.map(resource=><button type="button" className="cluster-item" key={itemKey(resource)} data-testid="normal-cluster-item" data-prefab={resource.prefab} onClick={()=>onSelect(itemKey(resource))}><ResourceIcon prefab={resource.prefab} name={resource.name} category={resource.category} iconUrl={resource.iconUrl}/><span className="cluster-item-name"><strong title={resource.name}>{resource.name}</strong><small>{resource.prefab}</small></span>{resource.minimum>resource.quantity&&<span className="cluster-shortage" title={`До минимума: ${resource.minimum-resource.quantity}`}>!</span>}<span className="cluster-item-quantity"><span>{fmt(resource.quantity)}</span><StockGauge quantity={resource.quantity} minimum={resource.minimum} compact showLabel={false}/></span><span className="cluster-item-chests" title="Уникальных сундуков"><Warehouse size={11}/>{new Set(resource.containerIds).size}</span></button>)}</div>}</section>;})}{!group.items.length&&<p className="cluster-status-note">В выбранной области предметов нет.</p>}</div>}
   </article>;
  })}</div>
 </div>;
}
