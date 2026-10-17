import { execFile as nodeExecFile } from 'node:child_process';
import { get } from 'node:http';
import { resolve } from 'node:path';

export const BACKEND_SERVICE = 'VALHEIM RESOURCE MANAGER';
export const BACKEND_VERSION = '0.3.0';
export const BACKEND_PORT = 37841;

// These directories deliberately match the source checkout. A portable EXE put
// beside an existing installation keeps using its private token, icons and DB.
export function resolvePortablePaths(exeDirectory) {
  if (typeof exeDirectory !== 'string' || !exeDirectory.trim()) throw new TypeError('Не указана папка приложения.');
  const dataDir = resolve(exeDirectory, 'data');
  return { dataDir, localDataDir: resolve(exeDirectory, 'localdata'), profileDir: resolve(dataDir, 'desktop-profile') };
}

function loopbackUrl(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError('Недопустимый локальный порт.');
  return `http://127.0.0.1:${port}`;
}

// Only an actual connection refusal means that the port is available. A timeout,
// truncated response or an unrelated HTTP server is never permission to replace it.
export function probeBackend({ port = BACKEND_PORT, timeoutMs = 1500 } = {}) {
  const url = loopbackUrl(port);
  return new Promise(resolveProbe => {
    let finished = false, deadline;
    const finish = result => { if (!finished) { finished = true; clearTimeout(deadline); resolveProbe(result); } };
    const request = get(`${url}/api/health`, { agent: false }, response => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        raw += chunk;
        if (Buffer.byteLength(raw) > 8192) { finish({ state: 'occupied', reason: 'invalid-health' }); response.destroy(); }
      });
      response.on('error', () => finish({ state: 'occupied', reason: 'invalid-health' }));
      response.on('aborted', () => finish({ state: 'occupied', reason: 'invalid-health' }));
      response.on('end', () => {
        let health;
        try { health = JSON.parse(raw); } catch { finish({ state: 'occupied', reason: 'invalid-health' }); return; }
        if (response.statusCode === 200 && health?.ok === true && health.service === BACKEND_SERVICE && health.version === BACKEND_VERSION && health.localOnly === true) {
          finish({ state: 'compatible' });
        } else finish({ state: 'occupied', reason: health?.service === BACKEND_SERVICE ? 'incompatible-version' : 'foreign-service' });
      });
    });
    deadline = setTimeout(() => { finish({ state: 'occupied', reason: 'timeout' }); request.destroy(); }, timeoutMs);
    request.on('error', error => finish(error.code === 'ECONNREFUSED' ? { state: 'available' } : { state: 'occupied', reason: 'unreachable' }));
  });
}

export async function startBackend({ port = BACKEND_PORT, dataDir, localDataDir, distDir, createApp, probe = probeBackend } = {}) {
  const url = loopbackUrl(port);
  const status = await probe({ port });
  if (status.state === 'compatible') return { ownsBackend: false, url, port, close: async () => {} };
  if (status.state !== 'available') {
    const error = new Error(status.reason === 'incompatible-version'
      ? `На порту ${port} уже работает другая версия Resource Manager. Закройте её обычным способом и повторите запуск.`
      : `Порт ${port} занят либо не отвечает. Приложение не будет останавливать посторонний процесс.`);
    error.code = 'BACKEND_PORT_OCCUPIED';
    throw error;
  }
  if (typeof createApp !== 'function') throw new TypeError('Не передан запуск локального сервера.');
  const runtime = createApp({ port, dataDir, localDataDir, distDir });
  let closePromise;
  const close = () => closePromise ??= Promise.resolve().then(() => runtime.close());
  try {
    const actualPort = await runtime.listen();
    return { ownsBackend: true, url: loopbackUrl(actualPort), port: actualPort, close };
  } catch (error) {
    try { await close(); } catch { /* Keep the original bind/start error. */ }
    throw error;
  }
}

function csvRow(line) {
  const values = [];
  let at = 0;
  while (at < line.length) {
    if (line[at++] !== '"') throw new Error('Invalid tasklist CSV.');
    let value = '', closed = false;
    while (at < line.length) {
      const character = line[at++];
      if (character !== '"') value += character;
      else if (line[at] === '"') { value += '"'; at++; }
      else { closed = true; break; }
    }
    if (!closed) throw new Error('Invalid tasklist CSV.');
    values.push(value);
    if (at === line.length) break;
    if (line[at++] !== ',' || at === line.length) throw new Error('Invalid tasklist CSV.');
  }
  return values;
}

export function parseTasklistCsv(output) {
  if (typeof output !== 'string') throw new TypeError('Invalid tasklist output.');
  const lines = output.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
  if (!lines.length) throw new Error('Empty tasklist output.');
  const matches = [];
  for (const line of lines) {
    const row = csvRow(line.trim());
    if (row.length < 2 || !/^\d+$/.test(row[1]) || !Number.isSafeInteger(Number(row[1]))) throw new Error('Invalid tasklist CSV.');
    if (row[0].toLowerCase() === 'valheim.exe' && Number(row[1]) > 0) matches.push({ image: row[0], pid: Number(row[1]) });
  }
  return matches;
}

export function detectValheimProcess({ platform = process.platform, execFile = nodeExecFile, timeoutMs = 2000 } = {}) {
  if (platform !== 'win32') return Promise.resolve({ state: 'unknown', processes: [] });
  return new Promise(resolveDetection => {
    try {
      // No paths, window titles, command lines, secrets or save files are read.
      execFile('tasklist.exe', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
        if (error) { resolveDetection({ state: 'unknown', processes: [] }); return; }
        try {
          const processes = parseTasklistCsv(stdout);
          resolveDetection({ state: processes.length ? 'running' : 'not-running', processes });
        } catch { resolveDetection({ state: 'unknown', processes: [] }); }
      });
    } catch { resolveDetection({ state: 'unknown', processes: [] }); }
  });
}
