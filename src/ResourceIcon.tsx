import { useState } from 'react';

/** Only registry-provided game sprites are images. Missing sprites stay visibly neutral. */
export function ResourceIcon({prefab,name,category='',iconUrl,large=false}:{prefab:string;name?:string;category?:string;iconUrl?:string|null;large?:boolean}) {
 const [failedUrl,setFailedUrl]=useState<string|null>(null);
 const label=name||prefab;
 const abbreviation=label.replace(/^prefab:|^hash:/,'').split(/[\s_\-]+/).filter(Boolean).slice(0,2).map(word=>word[0]).join('').toLocaleUpperCase('ru').slice(0,2)||'?';
 if(iconUrl&&failedUrl!==iconUrl)return <img className={`resource-art authentic-icon ${large?'large':''}`} src={iconUrl} alt={`Игровая пиктограмма: ${label}`} loading="lazy" decoding="async" onError={()=>setFailedUrl(iconUrl)} data-testid="authentic-item-icon"/>;
 return <span className={`resource-art icon-fallback ${large?'large':''}`} role="img" aria-label={`Нет игровой пиктограммы: ${label}`} title={`MISSING ICON · ${label}${category?` · ${category}`:''}`} data-testid="item-icon-fallback">{abbreviation}</span>;
}
