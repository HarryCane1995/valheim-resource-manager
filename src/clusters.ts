import type { Cluster, Resource } from './types';

export type ResourceSummary = {
 uniqueItems:number; totalItems:number; containers:number; shortages:number;
 status:string; statusCounts:Record<string,number>;
};
export type ResourceCategoryGroup = {id:string;name:string;items:Resource[];summary:ResourceSummary};
export type ResourceClusterGroup = {id:string;name:string;system:boolean;items:Resource[];categories:ResourceCategoryGroup[];summary:ResourceSummary};
export type GroupMode = 'clusters'|'categories'|'none';
export type CompactGroupPreferences = {version:1;mode:GroupMode;collapsed:string[]};
export const compactGroupsKey='vrm.compactGroups.v1';
export const defaultGroupPreferences:CompactGroupPreferences={version:1,mode:'clusters',collapsed:[]};
const sourceStatuses=new Set(['LIVE','STALE','OFFLINE','SNAPSHOT']);
const identity=(resource:Resource)=>resource.id||resource.prefab;

/** Aggregate this already world/zone-filtered resource list; never sum container inventories again. */
export function summarizeResources(resources:Resource[]):ResourceSummary{
 const itemIds=new Set<string>(),containerIds=new Set<string>(),statusCounts:Record<string,number>={};
 const sourceContainers=new Map<string,Set<string>>();
 let totalItems=0,shortages=0;
 for(const resource of resources){
  itemIds.add(identity(resource));
  totalItems+=resource.quantity;
  if(resource.minimum>resource.quantity)shortages++;
  for(const id of resource.containerIds)containerIds.add(id);
  const byStatus=(resource as Resource&{statusContainerIds?:Record<string,string[]>}).statusContainerIds;
  const sourceEntries=byStatus&&Object.entries(byStatus).filter(([,ids])=>Array.isArray(ids)&&ids.length>0);
  if(sourceEntries?.length){
   for(const [rawStatus,ids] of sourceEntries){
    const status=sourceStatuses.has(rawStatus)?rawStatus:'UNKNOWN';
    if(!sourceContainers.has(status))sourceContainers.set(status,new Set());
    for(const id of ids)sourceContainers.get(status)!.add(id);
   }
   continue;
  }
  const counts=(resource as Resource&{statusCounts?:Record<string,number>}).statusCounts;
  const entries=counts&&Object.entries(counts).filter(([,count])=>Number.isFinite(count)&&count>0);
  if(entries?.length){
   for(const [rawStatus,count] of entries){const status=sourceStatuses.has(rawStatus)?rawStatus:'UNKNOWN';statusCounts[status]=(statusCounts[status]||0)+count;}
  }else{
   const status=sourceStatuses.has(resource.status)?resource.status:'UNKNOWN';
   statusCounts[status]=(statusCounts[status]||0)+1;
  }
 }
 for(const [status,ids] of sourceContainers)statusCounts[status]=(statusCounts[status]||0)+ids.size;
 const statuses=Object.keys(statusCounts);
 return {uniqueItems:itemIds.size,totalItems,containers:containerIds.size,shortages,status:statuses.length===1?statuses[0]:statuses.length?'MIXED':'UNKNOWN',statusCounts};
}

/** Taxonomy order comes from the backend. Missing/future/mod IDs remain visible instead of disappearing. */
export function clusterGroups(resources:Resource[],clusters:Cluster[]=[]):ResourceClusterGroup[]{
 const groups=new Map<string,ResourceClusterGroup>();
 const categoryMaps=new Map<string,Map<string,ResourceCategoryGroup>>();
 const addGroup=(id:string,name:string,system:boolean,categories:{id:string;name:string}[]=[])=>{
  const categoryMap=new Map(categories.map(category=>[category.id,{...category,items:[],summary:summarizeResources([])}]));
  const group:ResourceClusterGroup={id,name,system,items:[],categories:[...categoryMap.values()],summary:summarizeResources([])};
  groups.set(id,group);categoryMaps.set(id,categoryMap);return group;
 };
 for(const cluster of clusters)if(!groups.has(cluster.id))addGroup(cluster.id,cluster.name,cluster.system,cluster.categories);
 for(const resource of resources){
  const clusterId=resource.clusterId||'unclassified';
  const cluster=groups.get(clusterId)||addGroup(clusterId,resource.clusterName||(clusterId==='unclassified'?'Неразобранное':clusterId),clusterId==='unclassified');
  const categoryId=resource.clusterCategoryId||(resource.diagnostics?.includes('UNKNOWN ITEM')?'unknown':'other');
  const categories=categoryMaps.get(clusterId)!;
  let category=categories.get(categoryId);
  if(!category){category={id:categoryId,name:resource.clusterCategory||'Остальные предметы',items:[],summary:summarizeResources([])};categories.set(categoryId,category);cluster.categories.push(category);}
  cluster.items.push(resource);category.items.push(resource);
 }
 for(const cluster of groups.values()){
  cluster.summary=summarizeResources(cluster.items);
  for(const category of cluster.categories)category.summary=summarizeResources(category.items);
 }
 return [...groups.values()];
}

export const clusterSummaries=(resources:Resource[],clusters:Cluster[]=[])=>clusterGroups(resources,clusters).map(({id,name,system,summary})=>({id,name,system,...summary}));
export const clusterKey=(clusterId:string)=>`cluster:${JSON.stringify(clusterId)}`;
export const categoryKey=(clusterId:string,categoryId:string)=>`category:${JSON.stringify([clusterId,categoryId])}`;
export const legacyCategoryKey=(category:string)=>`legacy:${JSON.stringify(category)}`;
export const groupIsOpen=(key:string,collapsed:string[],query='')=>Boolean(query.trim())||!collapsed.includes(key);
export const toggleCollapsedGroup=(collapsed:string[],key:string)=>collapsed.includes(key)?collapsed.filter(value=>value!==key):[...collapsed,key];
export const isCompactGroupPreferences=(value:unknown):value is CompactGroupPreferences=>{
 if(!value||typeof value!=='object')return false;
 const candidate=value as Partial<CompactGroupPreferences>;
 return candidate.version===1&&['clusters','categories','none'].includes(candidate.mode||'')&&Array.isArray(candidate.collapsed)&&candidate.collapsed.length<=10000&&candidate.collapsed.every(key=>typeof key==='string'&&key.length<=1024);
};
/** Search temporarily opens ancestors without changing the user's saved collapse preference. */
export function visibleClusterResources(groups:ResourceClusterGroup[],collapsed:string[],query=''){
 return groups.flatMap(cluster=>groupIsOpen(clusterKey(cluster.id),collapsed,query)?cluster.categories.flatMap(category=>groupIsOpen(categoryKey(cluster.id,category.id),collapsed,query)?category.items:[]):[]);
}
