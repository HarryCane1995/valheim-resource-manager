import { useEffect, useState } from 'react';
import { Check, FolderOpen, ListPlus, Pencil, Plus, Search, Star, Trash2, X } from 'lucide-react';
import type { Resource, State } from './types';
import { itemKey, itemMatches } from './catalog';
import { ResourceIcon } from './ResourceIcon';
import { StockGauge } from './StockGauge';
import './resource-lists.css';

type Mutate=(path:string,method:string,body:unknown)=>Promise<boolean>;
const fmt=(value:number)=>new Intl.NumberFormat('ru-RU').format(value);

export function ResourceCollectionControls({resource,state,mutate,busy}:{resource:Resource;state:State;mutate:Mutate;busy:boolean}) {
 const [name,setName]=useState('');
 const lists=state.collections?.lists||[],favorite=Boolean(state.collections?.favorites.includes(resource.prefab));
 const memberships=lists.filter(list=>list.prefabs.includes(resource.prefab)).length;
 const disabled=busy||!state.world;
 return <section className="resource-collection-controls" aria-label="Избранное и списки ресурса">
  <button className={`favorite-resource-button${favorite?' selected':''}`} data-testid="favorite-resource" aria-pressed={favorite} disabled={disabled} onClick={()=>mutate('/api/favorites','PUT',{worldId:state.world?.id,prefab:resource.prefab,favorite:!favorite})}><Star size={17} fill={favorite?'currentColor':'none'}/>{favorite?'В избранном':'В избранное'}</button>
  <details className="resource-list-picker" data-dismiss-on-outside data-testid="resource-list-picker">
   <summary><ListPlus size={16}/>Мои списки{memberships>0&&<span>{memberships}</span>}</summary>
   <div className="resource-list-picker-body">
    {lists.length?<div className="resource-list-memberships">{lists.map(list=><label key={list.id}><input type="checkbox" aria-label={`Добавить в список: ${list.name}`} checked={list.prefabs.includes(resource.prefab)} disabled={disabled} onChange={event=>mutate(`/api/resource-lists/${encodeURIComponent(list.id)}/items`,'PUT',{worldId:state.world?.id,prefab:resource.prefab,included:event.target.checked})}/><span title={list.name}>{list.name}</span></label>)}</div>:<p>Создайте список, например «Для постройки» или «В поход».</p>}
    <form className="resource-list-create" onSubmit={async event=>{event.preventDefault();if(await mutate('/api/resource-lists','POST',{worldId:state.world?.id,name,prefab:resource.prefab}))setName('');}}>
     <input aria-label="Название нового списка в карточке" placeholder="Новый список…" maxLength={80} required value={name} disabled={disabled} onChange={event=>setName(event.target.value)}/>
     <button className="button secondary" disabled={disabled||!name.trim()}><Plus size={13}/>Создать и добавить</button>
    </form>
   </div>
  </details>
  {!state.world&&<p className="resource-collection-scope">Выберите мир, чтобы сохранять избранное и списки.</p>}
 </section>;
}

export function ResourceListsView({state,onSelect,mutate,busy}:{state:State;onSelect:(id:string)=>void;mutate:Mutate;busy:boolean}) {
 const [selected,setSelected]=useState('favorites'),[query,setQuery]=useState(''),[creating,setCreating]=useState(false),[name,setName]=useState(''),[pendingName,setPendingName]=useState('');
 const [renaming,setRenaming]=useState(false),[rename,setRename]=useState(''),[deleting,setDeleting]=useState(false);
 const collections=state.collections||{favorites:[],lists:[]},list=collections.lists.find(entry=>entry.id===selected);
 const isFavorites=!list,title=list?.name||'Избранное',prefabs=list?.prefabs||collections.favorites;
 const items=new Map((collections.items||state.resources).map(item=>[item.prefab,item]));
 const resources=prefabs.flatMap(prefab=>items.has(prefab)?[items.get(prefab)!]:[]).filter(item=>itemMatches(item,query)).sort((a,b)=>a.name.localeCompare(b.name,'ru')||a.prefab.localeCompare(b.prefab));
 const disabled=busy||!state.world;
 useEffect(()=>{if(!pendingName)return;const created=collections.lists.find(list=>list.name===pendingName);if(created){setSelected(created.id);setPendingName('');setCreating(false);setQuery('');}},[pendingName,collections.lists]);
 const choose=(id:string)=>{setSelected(id);setQuery('');setRenaming(false);setDeleting(false);};
 return <section className="resource-lists-view" data-testid="resource-lists-view">
  <div className="resource-lists-intro"><Star size={18}/><p>Сохраняйте важные ресурсы и собирайте свои подборки. Списки принадлежат выбранному миру; остатки учитывают текущую складскую зону.</p></div>
  <div className="resource-lists-layout">
   <aside className="resource-lists-sidebar" aria-label="Ваши списки ресурсов">
    <button className={`resource-list-tab${isFavorites?' active':''}`} aria-pressed={isFavorites} onClick={()=>choose('favorites')}><Star size={16}/><span>Избранное</span><strong>{collections.favorites.length}</strong></button>
    <div className="resource-lists-label">МОИ СПИСКИ <span>{collections.lists.length}</span></div>
    {collections.lists.map(entry=><button key={entry.id} className={`resource-list-tab${selected===entry.id?' active':''}`} aria-label={`Список: ${entry.name}`} aria-pressed={selected===entry.id} onClick={()=>choose(entry.id)}><FolderOpen size={16}/><span title={entry.name}>{entry.name}</span><strong>{entry.prefabs.length}</strong></button>)}
    <button className="resource-list-new" aria-expanded={creating} disabled={disabled} onClick={()=>setCreating(!creating)}><Plus size={15}/>Создать список</button>
    {creating&&<form className="resource-list-new-form" onSubmit={async event=>{event.preventDefault();const trimmed=name.trim();if(await mutate('/api/resource-lists','POST',{worldId:state.world?.id,name:trimmed})){setPendingName(trimmed);setName('');}}}><input autoFocus aria-label="Название нового списка" placeholder="Название списка" value={name} maxLength={80} required onChange={event=>setName(event.target.value)}/><div><button className="button secondary" disabled={disabled||!name.trim()}><Check size={13}/>Создать</button><button type="button" className="icon-button" aria-label="Отменить создание списка" onClick={()=>setCreating(false)}><X size={15}/></button></div></form>}
   </aside>
   <section className="resource-list-content" data-testid="selected-resource-list">
    <div className="resource-list-heading"><div>{isFavorites?<Star size={20}/>:<FolderOpen size={20}/>}<h2 title={title}>{title}</h2><span>{prefabs.length}</span></div>{list&&<div className="resource-list-actions"><button className="icon-button" aria-label="Переименовать список" disabled={disabled} onClick={()=>{setRename(list.name);setRenaming(!renaming);setDeleting(false);}}><Pencil size={15}/></button><button className="icon-button" aria-label="Удалить список" disabled={disabled} onClick={()=>{setDeleting(!deleting);setRenaming(false);}}><Trash2 size={15}/></button></div>}</div>
    {renaming&&list&&<form className="resource-list-rename" onSubmit={async event=>{event.preventDefault();if(await mutate(`/api/resource-lists/${encodeURIComponent(list.id)}`,'PUT',{worldId:state.world?.id,name:rename}))setRenaming(false);}}><input autoFocus aria-label="Новое название списка" maxLength={80} required value={rename} onChange={event=>setRename(event.target.value)}/><button className="button secondary" disabled={disabled||!rename.trim()}>Сохранить</button><button type="button" className="icon-button" aria-label="Отменить переименование" onClick={()=>setRenaming(false)}><X size={15}/></button></form>}
    {deleting&&list&&<div className="resource-list-delete-confirm" role="group" aria-label="Подтверждение удаления списка"><p>Удалить «{list.name}»? Избранное и ресурсы в других списках сохранятся.</p><button className="button secondary" disabled={disabled} onClick={async()=>{if(await mutate(`/api/resource-lists/${encodeURIComponent(list.id)}`,'DELETE',{worldId:state.world?.id})){setDeleting(false);setSelected('favorites');}}}>Да, удалить список</button><button className="button text-button" onClick={()=>setDeleting(false)}>Отмена</button></div>}
    <div className="search-field resource-list-search"><Search size={16}/><input aria-label="Поиск в списке" placeholder="Название RU / EN, prefab или ID…" value={query} onChange={event=>setQuery(event.target.value)}/>{query&&<button aria-label="Очистить поиск в списке" onClick={()=>setQuery('')}><X size={14}/></button>}</div>
    <div className="saved-resource-rows">{resources.map(resource=><article className="saved-resource-row" key={itemKey(resource)} data-testid="saved-resource-row" data-item={itemKey(resource)}>
     <button className="saved-resource-main" onClick={()=>onSelect(itemKey(resource))}>
      <ResourceIcon prefab={resource.prefab} category={resource.category} name={resource.name} iconUrl={resource.iconUrl}/>
      <span className={`saved-resource-name${resource.newToWorld?' is-new':''}`}><strong>{resource.name}{collections.favorites.includes(resource.prefab)&&<Star size={11} fill="currentColor" aria-label="В избранном"/>}</strong><small>{resource.nameEn||resource.prefab}</small></span>
      <span className="saved-resource-stock">{resource.catalogOnly?<strong title="Подтверждённых остатков в выбранной области нет">—</strong>:<><strong>{fmt(resource.quantity)} <small>ед.</small></strong><StockGauge quantity={resource.quantity} minimum={resource.minimum} compact showLabel={false}/></>}</span>
     </button>
     <button className="icon-button saved-resource-remove" aria-label={`Убрать ${resource.name} из ${title}`} disabled={disabled} onClick={()=>mutate(isFavorites?'/api/favorites':`/api/resource-lists/${encodeURIComponent(list!.id)}/items`,'PUT',{worldId:state.world?.id,prefab:resource.prefab,...(isFavorites?{favorite:false}:{included:false})})}><X size={15}/></button>
    </article>)}</div>
    {!resources.length&&<div className="resource-list-empty">{isFavorites?<Star size={32}/>:<FolderOpen size={32}/>}<h3>{!state.world?'Сначала выберите мир':query.trim()?'Предметы не найдены':isFavorites?'Ваши любимые ресурсы будут здесь':'Список пока пуст'}</h3><p>{query.trim()?'Измените поисковый запрос.':isFavorites?'Откройте любой ресурс и нажмите «В избранное».':'Откройте ресурс в любом разделе и отметьте этот список в меню «Мои списки».'}</p></div>}
   </section>
  </div>
 </section>;
}
