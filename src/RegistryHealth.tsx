import { BookOpen, Database, TriangleAlert } from 'lucide-react';
import { State } from './types';

/** Asset indexing and a confirmed running ObjectDB are different kinds of coverage. */
export function RegistryHealth({state}:{state:State}){
 const registry=state.registry||{};
 const number=(key:string)=>typeof registry[key]==='number'?new Intl.NumberFormat('ru-RU').format(registry[key] as number):'Не передано';
 const registered=typeof registry.registered==='number'?registry.registered:0;
 const scope=registry.scope==='runtime-objectdb'?'ObjectDB запущенной игры':registry.scope==='installed-assets'?'Ассеты установленной игры':'Источник ещё не подключён';
 const unknown=state.resources.filter(r=>r.diagnostics?.includes('UNKNOWN ITEM')).length;
 return <section className="settings-card registry-health" data-testid="registry-health"><span className="settings-icon"><BookOpen size={24}/></span><h2>Игровой реестр предметов</h2><p>Определения и пиктограммы связаны со стабильными prefab ID.</p><dl>
  <div><dt>Источник каталога</dt><dd>{scope}</dd></div>
  <div><dt>Версия игры</dt><dd>{typeof registry.gameVersion==='string'?registry.gameVersion:'Не подтверждена'}</dd></div>
  <div><dt>Зарегистрировано определений</dt><dd>{number('registered')} / {number('definitionsFound')}</dd></div>
  <div><dt>Покрытие указанного источника</dt><dd>{typeof registry.coveragePercent==='number'?`${registry.coveragePercent}%`:'Не подтверждено'}</dd></div>
  <div><dt>Настоящих пиктограмм доступно</dt><dd>{number('iconsFound')}</dd></div>
  <div><dt>Без пиктограммы</dt><dd>{number('missingIcons')}</dd></div>
  <div><dt>Неполная локализация RU / EN</dt><dd>{number('missingLocalization')}</dd></div>
  <div><dt>Классифицировано по кластерам</dt><dd>{number('classifiedItems')}</dd></div>
  <div><dt>В «Неразобранном» в каталоге</dt><dd>{number('unclassifiedItems')}</dd></div>
  <div><dt>Ручных назначений в каталоге</dt><dd>{number('manualClassifications')}</dd></div>
  <div><dt>Старая категория «Прочее»</dt><dd>{number('unresolvedCategories')}</dd></div>
  <div><dt>Неопознанных позиций в запасах</dt><dd className={unknown?'text-amber':''}>{unknown}</dd></div>
  <div><dt>Переиндексация</dt><dd>{registry.reindexRequested?'Запрошена; ожидается источник':'Нет ожидающего запроса'}</dd></div>
 </dl><div className={`registry-verification ${registry.runtimeVerified?'verified':''}`}>{registry.runtimeVerified?<><Database size={15}/><span>Реестр ObjectDB подтверждён игровым источником.</span></>:<><TriangleAlert size={15}/><span>{registered?'Индекс установленной игры загружен. ':''}Полнота текущего ObjectDB и предметов модов не подтверждена запуском плагина.</span></>}</div>
 {typeof registry.loadError==='string'&&<p className="registry-error">Не удалось загрузить локальный каталог: {registry.loadError}</p>}
 <a className="button secondary registry-json" href="/api/registry" target="_blank" rel="noreferrer">Открыть реестр JSON<BookOpen size={14}/></a>
 </section>;
}
