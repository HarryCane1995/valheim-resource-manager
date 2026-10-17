import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, rmdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';

export const AUDITED_GAME_SHA256 = '94998885b103d6e5f5480123eaee0a093e82af2ddeeee37536c15bf555f24f3a';
export const LEGACY_PLUGIN_SHA256 = '41092d4a1f9efd0e96c2ab31d5a966d9b390021474f42d854d33490bdb1d0857';
export const PLAYER_KIT_PLUGIN_SHA256 = '4b7106a3017ea7bbad96056aadf3dd26e1cf5f241c14a583a617a55e7025d375';
export const STEAM_GAME_URL = 'steam://rungameid/892970';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { const error = Error(code); error.code = code; throw error; };
const present = path => { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

export function assertPlainPath(path) {
  let current = resolve(path);
  while (true) {
    if (present(current)?.isSymbolicLink()) fail('unsafe-path');
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}
function file(path) {
  assertPlainPath(path);
  const stat = present(path);
  if (!stat) return null;
  if (!stat.isFile()) fail('conflict');
  return readFileSync(path);
}
function boundedText(path) {
  try { const stat = lstatSync(path); return stat.isFile() && stat.size <= 1024 * 1024 ? readFileSync(path, 'utf8') : ''; } catch { return ''; }
}
export function parseSteamLibraries(text) {
  return [...text.matchAll(/"path"\s+"((?:\\.|[^"\\])*)"/g)].map(match => match[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"'));
}
export async function discoverGameDirectories({ env = process.env, registryPath, platform = process.platform } = {}) {
  if (registryPath === undefined && platform === 'win32') registryPath = await new Promise(done => {
    execFile('reg.exe', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { windowsHide: true, timeout: 1500, maxBuffer: 65536, encoding: 'utf8' }, (_error, stdout = '') => done(/SteamPath\s+REG_SZ\s+(.+)/i.exec(stdout)?.[1]?.trim() || ''));
  });
  const steamRoots = [registryPath, env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], 'Steam'), env.ProgramFiles && join(env.ProgramFiles, 'Steam')].filter(Boolean);
  const key = path => process.platform === 'win32' ? path.toLowerCase() : path;
  const libraries = new Map(steamRoots.map(path => [key(resolve(path)), resolve(path)]));
  for (const steam of steamRoots) for (const relative of ['steamapps/libraryfolders.vdf', 'config/libraryfolders.vdf']) {
    for (const path of parseSteamLibraries(boundedText(join(steam, relative)))) if (isAbsolute(path)) libraries.set(key(resolve(path)), resolve(path));
  }
  const candidates = new Map();
  for (const library of libraries.values()) {
    const manifest = boundedText(join(library, 'steamapps', 'appmanifest_892970.acf'));
    const install = /"installdir"\s+"([^"\\/]+)"/.exec(manifest)?.[1] || 'Valheim';
    if (install === '.' || install === '..') continue;
    const path = join(library, 'steamapps', 'common', install);
    if (existsSync(join(path, 'valheim.exe')) && existsSync(join(path, 'valheim_Data', 'Managed', 'assembly_valheim.dll'))) candidates.set(key(resolve(path)), resolve(path));
  }
  return [...candidates.values()];
}
export function parsePluginConfig(bytes) {
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
  if (text.length > 65536 || text.includes('\0')) fail('conflict');
  const allowed = new Set(['Connection.Endpoint', 'Connection.Token', 'Connection.SourceId', 'Indexing.Enabled', 'Indexing.ScanHostPersistedZdos']);
  const values = {}; let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[([^\]]+)\]$/.exec(line); if (header) { section = header[1]; if (!['Connection', 'Indexing'].includes(section)) fail('conflict'); continue; }
    const pair = /^([^=]+?)\s*=\s*(.*)$/.exec(line); if (!pair) fail('conflict');
    const key = section + '.' + pair[1].trim();
    if (!allowed.has(key) || Object.hasOwn(values, key)) fail('conflict');
    values[key] = pair[2].trim();
  }
  for (const key of ['Indexing.Enabled', 'Indexing.ScanHostPersistedZdos']) if (values[key] !== undefined && !/^(true|false)$/i.test(values[key])) fail('conflict');
  const token = values['Connection.Token'] || '';
  if (token && !/^[a-f0-9]{64}$/.test(token)) fail('conflict');
  return { text, values, token, endpoint: values['Connection.Endpoint'] || 'http://127.0.0.1:37841/api/ingest', enabled: values['Indexing.Enabled']?.toLowerCase() !== 'false' };
}
export function inspectGame(gameDir, bundledDll, { auditedHash = AUDITED_GAME_SHA256, port = 37841 } = {}) {
  if (!gameDir || !isAbsolute(gameDir)) fail('game-not-found');
  gameDir = resolve(gameDir); assertPlainPath(gameDir);
  if (!file(join(gameDir, 'valheim.exe'))) fail('game-not-found');
  const assembly = file(join(gameDir, 'valheim_Data', 'Managed', 'assembly_valheim.dll'));
  if (!assembly) fail('game-not-found');
  if (digest(assembly) !== auditedHash) fail('unsupported');
  for (const name of ['BepInEx.dll', '0Harmony.dll']) if (!file(join(gameDir, 'BepInEx', 'core', name))) fail('loader-missing');
  const plugins = join(gameDir, 'BepInEx', 'plugins'), configDir = join(gameDir, 'BepInEx', 'config');
  assertPlainPath(plugins); assertPlainPath(configDir);
  if (!present(plugins)?.isDirectory()) fail('loader-missing');
  const ownedDir = join(plugins, 'ValheimResourceManager');
  const dllPath = join(ownedDir, 'ValheimResourceManager.dll');
  const cfgPath = join(configDir, 'local.valheimresourcemanager.cfg');
  const dll = file(dllPath), cfg = file(cfgPath), bundle = readFileSync(bundledDll);
  const known = new Set([digest(bundle), LEGACY_PLUGIN_SHA256, PLAYER_KIT_PLUGIN_SHA256]);
  if (dll && !known.has(digest(dll))) fail('conflict');
  if (!dll && present(ownedDir) && (!present(ownedDir).isDirectory() || readdirSync(ownedDir).length)) fail('conflict');
  const parsed = cfg ? parsePluginConfig(cfg) : null;
  if (parsed && parsed.endpoint !== `http://127.0.0.1:${port}/api/ingest`) fail('conflict');
  if (parsed && !parsed.enabled) fail('disabled');
  return { gameDir, ownedDir, dllPath, cfgPath, configDir, dll, cfg, parsed, bundle };
}
export function ensureLocalToken(dataDir, inspected) {
  assertPlainPath(dataDir);
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, 'ingest-token.txt');
  const existing = file(path);
  if (existing) { const token = existing.toString('utf8').trim(); if (!/^[a-f0-9]{64}$/.test(token)) fail('local-token-invalid'); return token; }
  // Moving the portable to a fresh folder can reuse an already paired own plugin.
  const token = inspected?.dll && inspected.parsed?.token ? inspected.parsed.token : randomBytes(32).toString('hex');
  writeFileSync(path, token, { flag: 'wx', mode: 0o600 });
  return token;
}
function configText(token, port) {
  return `[Connection]\r\nEndpoint = http://127.0.0.1:${port}/api/ingest\r\nToken = ${token}\r\nSourceId = ${randomUUID().replaceAll('-', '')}\r\n\r\n[Indexing]\r\nEnabled = true\r\nScanHostPersistedZdos = true\r\n`;
}
function replaceToken(parsed, token, port) {
  if (!Object.hasOwn(parsed.values, 'Connection.Token')) return parsed.text.includes('[Connection]') ? parsed.text.replace('[Connection]', '[Connection]\r\nToken = ' + token) : parsed.text + '\r\n[Connection]\r\nToken = ' + token + '\r\n';
  return parsed.text.replace(/^(\s*Token\s*=)[^\r\n]*$/m, '$1 ' + token);
}
function sameFile(path, original) { const current = file(path); return original === null ? current === null : current !== null && digest(current) === digest(original); }

export async function ensureGameIntegration({ gameDir, dataDir, bundledDll, gameState, auditedHash = AUDITED_GAME_SHA256, port = 37841, beforeCommit, afterWrite } = {}) {
  let inspect;
  try {
    inspect = inspectGame(gameDir, bundledDll, { auditedHash, port });
    const token = ensureLocalToken(dataDir, inspect);
    if (inspect.dll && inspect.parsed?.token === token) return { state: 'ready', changed: false };
    if ((await gameState()).state !== 'not-running') return { state: 'waiting-game-close', changed: false };
    const cfg = Buffer.from(inspect.parsed ? replaceToken(inspect.parsed, token, port) : configText(token, port), 'utf8');
    const backup = join(dataDir, 'integration-backup', 'desktop-' + randomUUID());
    assertPlainPath(backup);
    mkdirSync(backup, { recursive: true });
    if (inspect.dll) writeFileSync(join(backup, 'plugin.before'), inspect.dll, { flag: 'wx' });
    if (inspect.cfg) writeFileSync(join(backup, 'config.before'), inspect.cfg, { flag: 'wx' });
    writeFileSync(join(backup, 'config.after'), cfg, { flag: 'wx' });
    const before = { version: 1, gameDir: inspect.gameDir, dllExisted: Boolean(inspect.dll), cfgExisted: Boolean(inspect.cfg), dllHash: inspect.dll && digest(inspect.dll), cfgHash: inspect.cfg && digest(inspect.cfg) };
    writeFileSync(join(backup, 'before.json'), JSON.stringify(before), { flag: 'wx' });
    await beforeCommit?.();
    // Recheck process and every destination immediately before the synchronous commit.
    if ((await gameState()).state !== 'not-running') return { state: 'waiting-game-close', changed: false };
    inspectGame(gameDir, bundledDll, { auditedHash, port });
    for (const path of [inspect.gameDir, inspect.ownedDir, inspect.configDir, inspect.dllPath, inspect.cfgPath]) assertPlainPath(path);
    if (!sameFile(inspect.dllPath, inspect.dll) || !sameFile(inspect.cfgPath, inspect.cfg)) fail('conflict');
    let addedDll = false, changedCfg = false, madeDirectory = false;
    const tmp = inspect.cfgPath + '.vrm-' + randomUUID() + '.tmp';
    try {
      if (!present(inspect.ownedDir)) { mkdirSync(inspect.ownedDir); madeDirectory = true; }
      if (!present(inspect.configDir)) mkdirSync(inspect.configDir);
      if (!inspect.dll) { writeFileSync(inspect.dllPath, inspect.bundle, { flag: 'wx' }); addedDll = true; afterWrite?.('dll'); }
      if (inspect.cfg) { writeFileSync(tmp, cfg, { flag: 'wx' }); renameSync(tmp, inspect.cfgPath); }
      else writeFileSync(inspect.cfgPath, cfg, { flag: 'wx' });
      changedCfg = true; afterWrite?.('config');
      if (digest(file(inspect.dllPath)) !== digest(inspect.dll || inspect.bundle) || digest(file(inspect.cfgPath)) !== digest(cfg)) fail('write-failed');
      const receipt = { version: 1, gameDir: inspect.gameDir, pluginHash: digest(inspect.dll || inspect.bundle), configHash: digest(cfg), backup, installedAt: new Date().toISOString() };
      writeFileSync(join(backup, 'after.json'), JSON.stringify(receipt), { flag: 'wx' });
      writeFileSync(join(dataDir, 'desktop-integration.json'), JSON.stringify(receipt));
      return { state: 'ready', changed: true };
    } catch (error) {
      // Restore only bytes owned by this attempt. Concurrent edits remain untouched.
      if (changedCfg && sameFile(inspect.cfgPath, cfg)) {
        if (inspect.cfg) { writeFileSync(tmp, inspect.cfg, { flag: 'wx' }); renameSync(tmp, inspect.cfgPath); }
        else unlinkSync(inspect.cfgPath);
      }
      if (addedDll && sameFile(inspect.dllPath, inspect.bundle)) unlinkSync(inspect.dllPath);
      if (present(tmp) && [digest(cfg), inspect.cfg && digest(inspect.cfg)].includes(digest(file(tmp)))) unlinkSync(tmp);
      if (madeDirectory && readdirSync(inspect.ownedDir).length === 0) rmdirSync(inspect.ownedDir);
      throw error;
    }
  } catch (error) {
    const state = ['EACCES', 'EPERM', 'EROFS'].includes(error.code) ? 'permission' : ['unsafe-path', 'conflict', 'unsupported', 'loader-missing', 'game-not-found', 'disabled', 'local-token-invalid'].includes(error.code) ? error.code : 'error';
    return { state, changed: false };
  }
}
