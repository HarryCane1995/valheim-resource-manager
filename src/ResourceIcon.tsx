import { useCallback, useEffect, useState } from 'react';

type IconProps={prefab:string;name?:string;category?:string;iconUrl?:string|null;large?:boolean};
type IconElement=HTMLImageElement|HTMLSpanElement;
const retryDelays=[2000,10000];

function MissingIcon({label,category,large,elementRef}:{label:string;category:string;large:boolean;elementRef?:(node:IconElement|null)=>void}) {
 const abbreviation=label.replace(/^prefab:|^hash:/,'').split(/[\s_\-]+/).filter(Boolean).slice(0,2).map(word=>word[0]).join('').toLocaleUpperCase('ru').slice(0,2)||'?';
 return <span ref={elementRef} className={`resource-art icon-fallback ${large?'large':''}`} role="img" aria-label={`Нет игровой пиктограммы: ${label}`} title={`MISSING ICON · ${label}${category?` · ${category}`:''}`} data-testid="item-icon-fallback">{abbreviation}</span>;
}

function RetryingIcon({url,label,category,large}:{url:string;label:string;category:string;large:boolean}) {
 const [failed,setFailed]=useState(false);
 const [attempt,setAttempt]=useState(0);
 const [element,setElement]=useState<IconElement|null>(null);
 const [visible,setVisible]=useState(false);
 const elementRef=useCallback((node:IconElement|null)=>{setElement(node);},[]);

 // A collapsed cluster or an offscreen row must not poll the server for missing images.
 useEffect(()=>{
  if(!element)return;
  if(typeof IntersectionObserver==='undefined'){setVisible(true);return;}
  const observer=new IntersectionObserver(([entry])=>setVisible(entry.isIntersecting));
  observer.observe(element);
  return ()=>observer.disconnect();
 },[element]);

 useEffect(()=>{
  if(!failed||!visible||attempt>=retryDelays.length)return;
  let retried=false;
  const retry=()=>{if(retried)return;retried=true;setAttempt(value=>value+1);setFailed(false);};
  const timer=window.setTimeout(retry,retryDelays[attempt]);
  window.addEventListener('online',retry,{once:true});
  return ()=>{window.clearTimeout(timer);window.removeEventListener('online',retry);};
 },[failed,visible,attempt]);

 if(failed)return <MissingIcon label={label} category={category} large={large} elementRef={elementRef}/>;
 return <img ref={elementRef} className={`resource-art authentic-icon ${large?'large':''}`} src={attempt?`${url}?retry=${attempt}`:url} alt={`Игровая пиктограмма: ${label}`} loading="lazy" decoding="async" onError={()=>setFailed(true)} data-testid="authentic-item-icon"/>;
}

/** Only registry-provided game sprites are images. Missing sprites stay visibly neutral. */
export function ResourceIcon({prefab,name,category='',iconUrl,large=false}:IconProps) {
 const label=name||prefab;
 if(iconUrl&&/^\/api\/icons\/[a-f0-9]{64}\.png$/.test(iconUrl))return <RetryingIcon key={iconUrl} url={iconUrl} label={label} category={category} large={large}/>;
 return <MissingIcon label={label} category={category} large={large}/>;
}
