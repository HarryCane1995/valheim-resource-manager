import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderOpen, Gamepad2, LoaderCircle, Maximize2, Minimize2, Radio, TriangleAlert } from 'lucide-react';
import './desktop.css';
import { GameConnection } from './GameConnection';

export type DesktopWorld = { id: string; name: string };
export type DesktopStatus = {
  game: { state: 'running' | 'not-running' | 'unknown' };
  backend: 'owned' | 'attached';
  fullscreen: boolean;
  snapshot: { status: string; message?: string; worldName?: string; worldId?: string };
  activeWorld: DesktopWorld | null;
  integration?: { state: string; autoLaunch: boolean; canLaunch: boolean };
};

declare global {
  interface Window {
    vrmDesktop?: {
      getStatus: () => Promise<DesktopStatus>;
      toggleFullscreen: () => Promise<boolean>;
      chooseSave: () => Promise<void>;
      chooseGame?: () => Promise<void>;
      launchGame?: () => Promise<void>;
      setAutoLaunch?: (enabled: boolean) => Promise<void>;
    };
  }
}

const snapshotLabels: Record<string, string> = {
  idle: 'Сохранение ещё не выбрано',
  unconfigured: 'Выберите папку сохранений',
  watching: 'Следим за сохранением',
  reading: 'Читаем снимок сохранения…',
  live: 'Ресурсы обновляются из игры',
  waiting: 'Ожидаем сохранение мира',
  importing: 'Читаем снимок сохранения…',
  loading: 'Читаем снимок сохранения…',
  imported: 'Снимок сохранения обновлён',
  ready: 'Снимок сохранения доступен',
  error: 'Не удалось прочитать сохранение',
  unsupported: 'Это сохранение пока не поддерживается',
};

export function DesktopControls({ onActiveWorld }: { onActiveWorld: (world: DesktopWorld | null) => void }) {
  const bridge = window.vrmDesktop;
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [actionError, setActionError] = useState('');
  const callback = useRef(onActiveWorld);
  callback.current = onActiveWorld;
  const mounted = useRef(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!bridge) return;
    const request = ++generation.current;
    try {
      const next = await bridge.getStatus();
      if (!mounted.current || request !== generation.current) return;
      setStatus(next);
      setUnavailable(false);
      const snapshotWorld = next.snapshot.worldId && next.snapshot.worldName ? { id: next.snapshot.worldId, name: next.snapshot.worldName } : null;
      callback.current(next.activeWorld || snapshotWorld);
    } catch {
      if (mounted.current && request === generation.current) setUnavailable(true);
    }
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return;
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      mounted.current = false;
      generation.current++;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [bridge, refresh]);

  if (!bridge) return null;
  const gameState = unavailable ? 'unknown' : status?.game.state ?? 'unknown';
  const gameLabel = gameState === 'running' ? 'Valheim запущен' : gameState === 'not-running' ? 'Valheim не запущен' : 'Проверяем Valheim';
  const snapshotState = status?.snapshot.status ?? 'idle';
  const snapshotLabel = snapshotLabels[snapshotState] ?? 'Состояние снимка уточняется';
  const snapshotBusy = ['importing', 'loading', 'reading'].includes(snapshotState);
  const snapshotError = ['error', 'unsupported'].includes(snapshotState);
  const snapshotSelected = !status?.activeWorld && Boolean(status?.snapshot.worldId);
  const shownWorldName = status?.activeWorld?.name || (snapshotSelected ? status?.snapshot.worldName : '') || 'Ожидаем подключение мира';

  return <><GameConnection integration={status?.integration} running={gameState==='running'} onRefresh={refresh}/><section className="desktop-controls" aria-label="Приложение Valheim" data-testid="desktop-controls">
    <div className={`desktop-game desktop-game-${gameState}`}><Gamepad2 size={17} aria-hidden="true"/><span className="desktop-game-dot"/><strong>{gameLabel}</strong></div>
    <div className="desktop-world"><span>{snapshotSelected ? 'ВЫБРАННЫЙ СНИМОК' : 'АКТИВНЫЙ МИР'}</span><strong title={shownWorldName}>{shownWorldName}</strong></div>
    <div className={`desktop-snapshot ${snapshotError ? 'has-error' : ''}`} role="status" title={unavailable ? 'Нет связи с приложением' : snapshotLabel}>
      {unavailable || snapshotError ? <TriangleAlert size={14} aria-hidden="true"/> : snapshotBusy ? <LoaderCircle className="desktop-spinner" size={14} aria-hidden="true"/> : <Radio size={14} aria-hidden="true"/>}
      <span>{unavailable ? 'Нет связи с приложением' : snapshotLabel}</span>
    </div>
    <div className="desktop-actions">
      <button type="button" disabled={choosing} onClick={async () => {
        setChoosing(true); setActionError('');
        try { await bridge.chooseSave(); await refresh(); }
        catch { if (mounted.current) setActionError('Не удалось открыть сохранение. Попробуйте ещё раз.'); }
        finally { if (mounted.current) setChoosing(false); }
      }}><FolderOpen size={14} aria-hidden="true"/><span>{choosing ? 'Выбор сохранения…' : 'Выбрать сохранение'}</span></button>
      <button type="button" disabled={toggling} aria-label={status?.fullscreen ? 'Выйти из полного экрана' : 'На весь экран'} aria-pressed={status?.fullscreen ?? false} title="Полный экран · F11" onClick={async () => {
        setToggling(true); setActionError('');
        try { const fullscreen = await bridge.toggleFullscreen(); if (mounted.current) setStatus(current => current ? { ...current, fullscreen } : current); await refresh(); }
        catch { if (mounted.current) setActionError('Не удалось переключить полный экран.'); }
        finally { if (mounted.current) setToggling(false); }
      }}>{status?.fullscreen ? <Minimize2 size={14} aria-hidden="true"/> : <Maximize2 size={14} aria-hidden="true"/>}<span>Полный экран</span><kbd>F11</kbd></button>
    </div>
    {actionError && <span className="desktop-action-error" role="alert">{actionError}</span>}
  </section></>;
}
