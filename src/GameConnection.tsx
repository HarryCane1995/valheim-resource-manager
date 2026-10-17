import { useState } from 'react';
import { CheckCircle2, FolderOpen, LoaderCircle, Play } from 'lucide-react';

const labels:Record<string,string>={
 checking:'Подключаем игру…',
 ready:'Игра готова. Подключение настроено автоматически.',
 'waiting-game-close':'Закройте Valheim один раз — приложение само завершит подключение.',
 'game-not-found':'Укажите папку Valheim для первого подключения.',
 'choose-game':'Найдено несколько установок. Выберите папку Valheim.',
 'loader-missing':'В выбранной папке не найден BepInEx.',
 unsupported:'Эта версия Valheim пока не поддерживается.',
 conflict:'Существующие файлы плагина отличаются. Нужна проверка подключения.',
 'unsafe-path':'Нужна обычная папка игры без ссылок и перенаправлений.',
 disabled:'Сбор ресурсов выключен в настройках плагина.',
 permission:'Нет доступа на запись в папку игры.',
 'local-token-invalid':'Локальное подключение повреждено. Нужна проверка.',
 'bundle-missing':'Для подключения нужна сборка EXE со встроенным плагином.',
 'app-conflict':'Закройте другую копию панели и повторите запуск.',
 'test-mode':'Изолированная проверка приложения.',
 error:'Не удалось подключить игру. Проверьте выбранную папку Valheim.',
};
export function GameConnection({integration,running,onRefresh}:{integration?:{state:string;autoLaunch:boolean;canLaunch:boolean};running:boolean;onRefresh:()=>Promise<void>}){
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 if(!integration)return null;
 const bridge=window.vrmDesktop;
 const act=async(action?:()=>Promise<void>)=>{if(!action)return;setBusy(true);setError('');try{await action();await onRefresh();}catch{setError('Не удалось выполнить действие. Попробуйте ещё раз.');}finally{setBusy(false);}};
 const message=error||labels[integration.state]||labels.error;
 return <section className={`game-connection game-connection-${integration.state}`} aria-label="Подключение игры" data-testid="game-connection">
  <span className="game-connection-message" role="status" title={message}>{integration.state==='ready'?<CheckCircle2 size={17}/>:<LoaderCircle size={17}/>}<span>{message}</span></span>
  <label className="game-auto-launch"><input type="checkbox" checked={integration.autoLaunch} disabled={busy} onChange={event=>void act(()=>bridge?.setAutoLaunch?.(event.target.checked)||Promise.resolve())}/>Запускать игру вместе с приложением</label>
  <button type="button" disabled={busy} onClick={()=>void act(bridge?.chooseGame)} title="Выбрать папку Valheim"><FolderOpen size={14}/><span>Папка игры</span></button>
  <button type="button" className="launch-valheim" disabled={busy||running||!integration.canLaunch} onClick={()=>void act(bridge?.launchGame)}><Play size={14}/>{running?'Игра запущена':'Запустить Valheim'}</button>
 </section>;
}
