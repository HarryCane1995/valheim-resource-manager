import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { startBackend, resolvePortablePaths, detectValheimProcess } from './runtime.mjs';
import { createApp } from '../server/main.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Overrides are for isolated acceptance tests; ordinary launch needs no arguments.
const HOME = resolve(process.env.VRM_DESKTOP_HOME || process.env.PORTABLE_EXECUTABLE_DIR || (app.isPackaged ? dirname(process.execPath) : ROOT));
const PORT = Number(process.env.VRM_DESKTOP_PORT || 37841);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw Error('Invalid desktop port');
const paths = resolvePortablePaths(HOME);
mkdirSync(paths.profileDir, { recursive: true });
app.setPath('userData', paths.profileDir);
app.setAppUserModelId('HarryCane1995.ValheimResourceManager');
const locked = app.requestSingleInstanceLock();
let win, backend, timer, busy = false, choosing = false, quitting = false, worker;
let sourceConfig;
let snapshot = { status: 'unconfigured' };
let game = { state: 'unknown' };
let activeWorld = null;
let retryAfter = 0;
const configFile = join(paths.dataDir, 'snapshot-source.json');
const checkpointFile = join(paths.dataDir, 'snapshot-checkpoint.json');
let checkpoint = {};
function readJSON(path) { try { return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } }
function writeJSON(path, value) { const temp = path + '.desktop-tmp'; writeFileSync(temp, JSON.stringify(value, null, 2)); renameSync(temp, path); }
function status() { return { game: { state: game.state }, backend: backend?.ownsBackend ? 'owned' : 'attached', fullscreen: win?.isFullScreen() || false, snapshot, activeWorld }; }
function trusted(event) {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || new URL(event.senderFrame.url).origin !== backend.url) throw Error('Untrusted desktop request');
}
async function json(path, options = {}) {
  const response = await fetch(backend.url + path, { ...options, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw Error('LOCAL_API_' + response.status);
  return response.json();
}
function snapshotJob(action, folder) {
  return new Promise((done, reject) => {
    const current = new Worker(new URL('./snapshot-worker.mjs', import.meta.url), { workerData: { action, folder } });
    worker = current;
    let settled = false;
    current.once('message', result => { settled = true; result.ok ? done(result.value) : reject(Error('SNAPSHOT_UNSUPPORTED')); });
    current.once('error', reject);
    current.once('exit', () => { if (worker === current) worker = null; if (!settled) reject(Error('SNAPSHOT_WORKER_EXIT')); });
  });
}
async function refreshStatus() {
  if (busy || choosing || quitting) return;
  busy = true;
  try {
    game = await detectValheimProcess();
    const first = await json('/api/state');
    const states = [first];
    for (const world of first.worlds) if (world.id !== first.world?.id) states.push(await json('/api/state?worldId=' + encodeURIComponent(world.id)));
    const live = states.filter(state => state.source.connected && state.source.mode !== 'snapshot').sort((a, b) => Date.parse(b.source.lastSeenAt) - Date.parse(a.source.lastSeenAt));
    activeWorld = live[0]?.world || null;
    if (activeWorld) { snapshot = { status: 'live' }; return; }
    if (!sourceConfig) { snapshot = { status: 'unconfigured' }; return; }
    if (Date.now() < retryAfter) return;
    const names = readdirSync(sourceConfig.worldFolder);
    const generation = Math.max(0, ...names.map(name => /^_main\.(\d+)\.ok$/.exec(name)).filter(Boolean).map(match => Number(match[1])));
    if (!generation) throw Error('NO_COMPLETE_SAVE');
    if (checkpoint.worldId === sourceConfig.worldId && checkpoint.generation >= generation) { snapshot = { status: 'watching', worldId: checkpoint.worldId, worldName: checkpoint.worldName }; return; }
    snapshot = { status: 'reading' };
    const { payload, manifest } = await snapshotJob('read', sourceConfig.worldFolder);
    if (payload.worldId !== sourceConfig.worldId) throw Error('WORLD_UID_MISMATCH');
    const serialized = JSON.stringify(payload);
    if (payload.containers.length > 5000 || Buffer.byteLength(serialized) > 3 * 1024 * 1024) throw Error('SNAPSHOT_TOO_LARGE');
    // A live source may have connected while the save was being parsed.
    const current = await json('/api/state?worldId=' + encodeURIComponent(sourceConfig.worldId)).catch(() => null);
    if (!current?.source?.connected) {
      const token = readFileSync(join(paths.dataDir, 'ingest-token.txt'), 'utf8').trim();
      await json('/api/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-VRM-Token': token }, body: serialized });
      checkpoint = { worldId: payload.worldId, worldName: payload.worldName, generation: manifest.generation, observedAt: manifest.observedAt };
      writeJSON(checkpointFile, checkpoint);
    }
    snapshot = { status: 'watching', worldId: payload.worldId, worldName: payload.worldName };
  } catch { snapshot = { status: 'error' }; retryAfter = Date.now() + 60_000; }
  finally { busy = false; }
}
async function chooseSave() {
  if (choosing || quitting) return;
  choosing = true;
  try {
    if (worker) await worker.terminate();
    while (busy && !quitting) await delay(50);
    if (!quitting) await pickSave();
  } finally { choosing = false; void refreshStatus(); }
}
async function pickSave() {
  const base = process.env.USERPROFILE ? join(process.env.USERPROFILE, 'AppData', 'LocalLow', 'IronGate', 'Valheim') : HOME;
  const picked = await dialog.showOpenDialog(win, { title: 'Выберите папку сохранения Valheim', defaultPath: existsSync(base) ? base : HOME, properties: ['openDirectory'] });
  if (picked.canceled) return;
  snapshot = { status: 'reading' };
  try {
    const worlds = await snapshotJob('discover', picked.filePaths[0]);
    if (!worlds.length) {
      snapshot = { status: 'error' };
      await dialog.showMessageBox(win, { type: 'info', title: 'Сохранение не найдено', message: 'Здесь нет поддерживаемого завершённого сохранения.', detail: 'Выберите папку мира или worlds_local. Поддерживается исследованный chunk-формат Valheim 1.0.20; старые .db и облачные файлы, не загруженные на диск, не читаются.' });
      return;
    }
    let chosen = worlds[0];
    if (worlds.length > 1) {
      const options = worlds.slice(0, 12);
      const answer = await dialog.showMessageBox(win, { type: 'question', title: 'Выберите мир', message: 'Найдено несколько миров. Какой отслеживать при отсутствии live-связи?', buttons: [...options.map(world => world.worldName), 'Отмена'], cancelId: options.length, noLink: true });
      if (answer.response >= options.length) { snapshot = sourceConfig ? { status: 'watching' } : { status: 'unconfigured' }; return; }
      chosen = options[answer.response];
    }
    sourceConfig = { worldFolder: chosen.folder, worldId: chosen.worldId };
    retryAfter = 0;
    writeJSON(configFile, sourceConfig);
    checkpoint = {};
    snapshot = { status: 'watching', worldId: chosen.worldId, worldName: chosen.worldName };
    await refreshStatus();
  } catch {
    snapshot = { status: 'error' };
    await dialog.showMessageBox(win, { type: 'warning', title: 'Не удалось прочитать сохранение', message: 'Формат не поддерживается или сохранение изменилось во время чтения.', detail: 'Игровые файлы не изменялись. Дождитесь завершения сохранения и попробуйте ещё раз.' });
  }
}
async function openWindow() {
  win = new BrowserWindow({ width: 1280, height: 850, minWidth: 760, minHeight: 550, backgroundColor: '#10191d', title: 'Valheim Resource Manager', show: false, icon: join(ROOT, 'desktop', 'icon.ico'), autoHideMenuBar: true, webPreferences: { preload: join(ROOT, 'desktop', 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  Menu.setApplicationMenu(null);
  const toggle = () => { win.setFullScreen(!win.isFullScreen()); return win.isFullScreen(); };
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11' && !input.isAutoRepeat) { event.preventDefault(); toggle(); }
    if (input.type === 'keyDown' && input.key === 'Escape' && win.isFullScreen()) { event.preventDefault(); win.setFullScreen(false); }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== backend.url) event.preventDefault(); });
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  win.webContents.session.setPermissionCheckHandler(() => false);
  ipcMain.handle('vrm:status', event => { trusted(event); return status(); });
  ipcMain.handle('vrm:fullscreen', event => { trusted(event); return toggle(); });
  ipcMain.handle('vrm:save', async event => { trusted(event); await chooseSave(); });
  await win.loadURL(backend.url);
  win.show();
}
if (!locked) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault(); quitting = true;
    clearInterval(timer);
    Promise.resolve(worker?.terminate()).then(() => backend?.close()).finally(() => app.quit());
  });
  app.whenReady().then(async () => {
    backend = await startBackend({ ...paths, distDir: join(ROOT, 'dist'), port: PORT, createApp });
    sourceConfig = readJSON(configFile);
    if (typeof sourceConfig?.worldFolder !== 'string' || typeof sourceConfig?.worldId !== 'string') sourceConfig = null;
    checkpoint = readJSON(checkpointFile) || {};
    await openWindow();
    void refreshStatus();
    timer = setInterval(() => void refreshStatus(), 5000);
  }).catch(async () => {
    await dialog.showMessageBox({ type: 'error', title: 'Valheim Resource Manager', message: 'Не удалось открыть приложение.', detail: 'Проверьте, что папка доступна для записи, а порт панели не занят другой программой. Приложение не останавливает посторонние процессы.' });
    app.quit();
  });
}
