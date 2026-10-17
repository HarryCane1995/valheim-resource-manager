import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { BACKEND_SERVICE, BACKEND_VERSION, resolvePortablePaths, probeBackend, startBackend, parseTasklistCsv, detectValheimProcess } from '../desktop/runtime.mjs';

const health = { ok: true, service: BACKEND_SERVICE, version: BACKEND_VERSION, localOnly: true };
async function fixture(t, respond) {
  const server = createServer(respond);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(done)));
  return server.address().port;
}

test('portable data, icon and browser-profile paths remain adjacent to the EXE', () => {
  const root = resolve('portable fixture');
  assert.deepEqual(resolvePortablePaths(root), { dataDir: resolve(root, 'data'), localDataDir: resolve(root, 'localdata'), profileDir: resolve(root, 'data/desktop-profile') });
  assert.throws(() => resolvePortablePaths(''), /папка/);
});

test('only exact compatible health permits reusing an existing backend', async t => {
  const port = await fixture(t, (req, res) => { assert.equal(req.url, '/api/health'); res.end(JSON.stringify(health)); });
  assert.deepEqual(await probeBackend({ port }), { state: 'compatible' });
  const runtime = await startBackend({ port, createApp: () => { throw new Error('Must not create another server.'); } });
  assert.equal(runtime.ownsBackend, false);
  assert.equal(runtime.url, `http://127.0.0.1:${port}`);
  await runtime.close();
  assert.deepEqual(await probeBackend({ port }), { state: 'compatible' }, 'Closing shell preserves externally owned backend.');
});

test('foreign, malformed and incompatible services cannot be reused or replaced', async t => {
  for (const [body, reason] of [
    [{ ...health, service: 'OTHER SERVICE' }, 'foreign-service'],
    [{ ...health, version: '99.0.0' }, 'incompatible-version'],
    [{ ...health, localOnly: false }, 'incompatible-version'],
    ['not JSON', 'invalid-health'],
  ]) {
    const port = await fixture(t, (req, res) => res.end(typeof body === 'string' ? body : JSON.stringify(body)));
    assert.deepEqual(await probeBackend({ port }), { state: 'occupied', reason });
    await assert.rejects(startBackend({ port, createApp: () => { throw new Error('Foreign service must not be touched.'); } }), { code: 'BACKEND_PORT_OCCUPIED' });
  }
});

test('unresponsive occupied port times out and oversized health is rejected', async t => {
  const slowPort = await fixture(t, () => {});
  assert.deepEqual(await probeBackend({ port: slowPort, timeoutMs: 35 }), { state: 'occupied', reason: 'timeout' });
  const largePort = await fixture(t, (req, res) => res.end('x'.repeat(9000)));
  assert.deepEqual(await probeBackend({ port: largePort }), { state: 'occupied', reason: 'invalid-health' });
});

test('health timeout is an absolute deadline even if another service keeps sending bytes', async t => {
  const port = await fixture(t, (req, res) => {
    const timer = setInterval(() => res.write(' '), 10);
    res.on('close', () => clearInterval(timer));
  });
  assert.deepEqual(await probeBackend({ port, timeoutMs: 60 }), { state: 'occupied', reason: 'timeout' });
});

test('a refused connection marks a port available', async () => {
  const server = createServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise(done => server.close(done));
  assert.deepEqual(await probeBackend({ port }), { state: 'available' });
});

test('owned backend receives explicit paths and is closed exactly once', async () => {
  let closed = 0, options;
  const runtime = await startBackend({ port: 37841, dataDir: 'PRIVATE_DATA', localDataDir: 'PRIVATE_ICONS', distDir: 'PACKAGED_UI', probe: async () => ({ state: 'available' }), createApp: value => {
    options = value;
    return { listen: async () => 37841, close: async () => { closed++; } };
  } });
  assert.deepEqual(options, { port: 37841, dataDir: 'PRIVATE_DATA', localDataDir: 'PRIVATE_ICONS', distDir: 'PACKAGED_UI' });
  assert.equal(runtime.ownsBackend, true);
  await Promise.all([runtime.close(), runtime.close()]);
  await runtime.close();
  assert.equal(closed, 1);
});

test('bind race cleans up only the attempted own backend and preserves original error', async () => {
  const original = Object.assign(new Error('Address already in use.'), { code: 'EADDRINUSE' });
  let closed = 0;
  await assert.rejects(startBackend({ probe: async () => ({ state: 'available' }), createApp: () => ({ listen: async () => { throw original; }, close: async () => { closed++; } }) }), error => error === original);
  assert.equal(closed, 1);
});

test('CSV recognizes exact case-insensitive Valheim names and numeric PIDs only', () => {
  const rows = '\uFEFF"System Idle Process","0","Services","0","8 K"\r\n"VALHEIM.EXE","1234","Console","1","15,123 K"\r\n"valheim_server.exe","2222","Console","1","1 K"\r\n"Other, quoted ""name"".exe","3333","Console","1","1 K"\r\n';
  assert.deepEqual(parseTasklistCsv(rows), [{ image: 'VALHEIM.EXE', pid: 1234 }]);
  assert.deepEqual(parseTasklistCsv('"not-valheim.exe","2"'), []);
  for (const value of ['', 'INFO: unavailable', '"valheim.exe","12x"', '"valheim.exe","12', '"valheim.exe","12",']) assert.throws(() => parseTasklistCsv(value));
});

test('process discovery is hidden, bounded and returns no command lines or paths', async () => {
  let argumentsSeen, optionsSeen;
  const result = await detectValheimProcess({ platform: 'win32', timeoutMs: 1234, execFile: (file, args, options, callback) => {
    assert.equal(file, 'tasklist.exe'); argumentsSeen = args; optionsSeen = options;
    callback(null, '"valheim.exe","4321","Console","1","10 K"');
  } });
  assert.deepEqual(argumentsSeen, ['/FO', 'CSV', '/NH']);
  assert.equal(optionsSeen.windowsHide, true);
  assert.equal(optionsSeen.timeout, 1234);
  assert.deepEqual(result, { state: 'running', processes: [{ image: 'valheim.exe', pid: 4321 }] });
  assert.deepEqual(await detectValheimProcess({ platform: 'win32', execFile: (file, args, options, callback) => callback(null, '"explorer.exe","2"') }), { state: 'not-running', processes: [] });
});

test('unsupported platform, process errors and invalid output remain unknown', async () => {
  const unknown = { state: 'unknown', processes: [] };
  assert.deepEqual(await detectValheimProcess({ platform: 'linux', execFile: () => { throw new Error('Must not execute.'); } }), unknown);
  assert.deepEqual(await detectValheimProcess({ platform: 'win32', execFile: (file, args, options, callback) => callback(new Error('timeout')) }), unknown);
  assert.deepEqual(await detectValheimProcess({ platform: 'win32', execFile: (file, args, options, callback) => callback(null, 'unparseable') }), unknown);
});
