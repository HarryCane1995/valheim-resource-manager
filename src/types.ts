export type Item = {prefab:string;name:string;category:string;quantity:number};
export type Container = {id:string;zdoId?:string|null;type:string;name:string;label:string;x:number;y:number;z:number;items:Item[];observedAt:string;status:string;zoneIds:string[]};
export type Resource = Item & {containerIds:string[];minimum:number;status:string};
export type Zone = {id:string;name:string;x:number;z:number;radius:number;enabled:boolean;proposed?:boolean};
export type State = {worlds:{id:string;name:string}[];world:{id:string;name:string}|null;source:{connected:boolean;mode:string;coverage:string;lastSeenAt:string|null;lastConfirmedAt?:string|null;gameVersion:string|null};containers:Container[];resources:Resource[];zones:Zone[];minimums:Record<string,number>;events:{id:string;at:string;text:string}[];stats:{totalItems:number;uniqueItems:number;containers:number;shortages:number};revision:number};
export const emptyState:State={worlds:[],world:null,source:{connected:false,mode:'OFFLINE',coverage:'',lastSeenAt:null,gameVersion:null},containers:[],resources:[],zones:[],minimums:{},events:[],stats:{totalItems:0,uniqueItems:0,containers:0,shortages:0},revision:0};
