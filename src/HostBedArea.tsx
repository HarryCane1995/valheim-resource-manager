import { MapPin, Target, TriangleAlert } from 'lucide-react';
import { HostBedArea } from './types';
import './host-bed.css';

export function HostBedAreaBanner({area,sourceMode,demo}:{area?:HostBedArea;sourceMode:string;demo:boolean}) {
 const active=area?.status==='active'&&area.applied&&Number.isFinite(area.x)&&Number.isFinite(area.z);
 const unset=area?.status==='unset'&&area.applied;
 const status=active?'active':unset?'unset':'pending';
 const remoteSource=/client|dedicated|server/i.test(sourceMode)&&!/host/i.test(sourceMode);
 return <aside className={`host-bed-area host-bed-area-${status}`} data-testid="host-bed-area" data-status={status} data-applied={active||unset} aria-label="Область учёта ресурсов">
  <span className="host-bed-area-icon" aria-hidden="true">{active?<Target size={18}/>:<TriangleAlert size={18}/>}</span>
  <div className="host-bed-area-copy">
   <strong>{active?'Учёт в радиусе 500 м от сохранённой точки кровати хоста':unset?'Кровать хоста не выбрана. Учёт приостановлен':window.vrmDesktop&&remoteSource?'Учёт доступных сундуков':'Зона 500 м от кровати хоста: ожидаем точку'}</strong>
   {active?<p><span className="host-bed-area-center" data-testid="host-bed-area-center">Центр: X {Math.round(area!.x!)} · Z {Math.round(area!.z!)}</span><span>Выбор «Все зоны» тоже ограничен этим радиусом.</span></p>:unset?<p>Привяжите кровать в игре. После подтверждения хостом здесь появятся ресурсы в радиусе 500 м.</p>:window.vrmDesktop?<p>{remoteSource?'Точка кровати доступна в панели хоста мира. Здесь показаны сундуки, доступные этому источнику.':'После подключения к миру хост передаст точку выбранной кровати. Пока показан доступный охват.'}</p>:<p>Пока показан прежний охват. Для включения закройте игру, запустите UPDATE-GAME-PLUGIN.cmd из папки проекта и снова откройте Valheim.{remoteSource?' Точку передаёт только хост мира; клиент или выделенный сервер её не заменяет.':''}</p>}
   {demo&&<span className="host-bed-area-demo">Демо: синтетическая область, без связи с игровой кроватью.</span>}
  </div>
 </aside>;
}

export function HostBedAreaEmpty({active=false}:{active?:boolean}) {
 return <div className="no-results host-bed-area-empty" data-testid="host-bed-area-empty" data-status={active?'active':'unset'}><MapPin size={32}/><h3>{active?'В выбранной области пока нет данных':'Кровать хоста не выбрана'}</h3><p>{active?'В выбранной области в пределах 500 м пока нет подтверждённых сундуков или ресурсов. Содержимое появится после подтверждения игровым источником.':'Привяжите кровать в игре. Учёт ресурсов приостановлен до получения точки хоста; координаты автоматически не подставляются.'}</p></div>;
}
