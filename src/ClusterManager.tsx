import { useState } from 'react';
import { Check, Layers3, Plus, Settings2, X } from 'lucide-react';
import { State } from './types';
import './cluster-normal.css';

type Mutate=(path:string,method:string,body:unknown)=>Promise<boolean>;
export function ClusterManager({state,mutate,busy}:{state:State;mutate:Mutate;busy:boolean}){
 const [name,setName]=useState(''),[editing,setEditing]=useState<string|null>(null),[newName,setNewName]=useState('');
 const clusters=state.clusters||[];
 return <section className="settings-card cluster-manager" data-testid="cluster-manager"><span className="settings-icon"><Layers3 size={24}/></span><h2>Логические кластеры</h2><p>Классификация предметов сохраняется локально по prefab ID. Складские зоны определяют расположение и настраиваются отдельно.</p>
  <div className="cluster-manager-list">{clusters.map(cluster=><div className="cluster-manager-row" key={cluster.id}>{editing===cluster.id?<form onSubmit={async event=>{event.preventDefault();if(await mutate(`/api/clusters/${encodeURIComponent(cluster.id)}`,'PUT',{name:newName.trim()}))setEditing(null);}}><input value={newName} onChange={event=>setNewName(event.target.value)} required maxLength={80} aria-label="Новое имя кластера" autoFocus/><button className="icon-button" disabled={busy} aria-label="Сохранить название кластера"><Check size={15}/></button><button type="button" className="icon-button" onClick={()=>setEditing(null)} aria-label="Отменить переименование"><X size={15}/></button></form>:<><strong>{cluster.name}</strong><span>{cluster.system?'Системный':'Пользовательский'}</span>{!cluster.system&&<button type="button" className="icon-button" aria-label={`Переименовать кластер ${cluster.name}`} onClick={()=>{setEditing(cluster.id);setNewName(cluster.name);}}><Settings2 size={14}/></button>}</>}</div>)}</div>
  <form className="cluster-create" onSubmit={async event=>{event.preventDefault();if(await mutate('/api/clusters','POST',{name:name.trim()}))setName('');}}><label htmlFor="new-cluster-name">Новый пользовательский кластер</label><div><input id="new-cluster-name" value={name} onChange={event=>setName(event.target.value)} required maxLength={80} placeholder="Например, подготовка к экспедиции"/><button className="button secondary" disabled={busy||!name.trim()}><Plus size={14}/>Создать</button></div></form><p className="cluster-manager-note">Перенос и возврат к автоматической классификации доступны в карточке любого ресурса. Системные кластеры сохраняются всегда.</p>
 </section>;
}
