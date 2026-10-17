import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { WebSocket } from 'ws';
import { createServer } from 'vite';
import { createApp } from './main.mjs';
import { createDevProxy } from '../scripts/vite-proxy.mjs';

function postInvalidJson(base, origin, host) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}/api/zones`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', ...(host ? { Host: host } : {}) },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (error) { reject(error); }
      });
    });
    req.setTimeout(3000, () => req.destroy(new Error('HTTP proxy test timed out')));
    req.on('error', reject);
    req.end('{');
  });
}

function websocketResult(url, origin, sockets) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin, handshakeTimeout: 3000 });
    sockets.add(ws);
    ws.on('error', reject);
    ws.once('message', raw => resolve({ status: 101, body: JSON.parse(raw.toString()) }));
    ws.once('unexpected-response', (_req, res) => {
      res.resume();
      ws.terminate();
      resolve({ status: res.statusCode });
    });
  });
}

test('Vite HTTP and WebSocket proxy accepts its own loopback Origin and preserves rejection of foreign Origins', { timeout: 15000 }, async t => {
  const temporaryRoot = realpathSync(tmpdir());
  const dir = mkdtempSync(join(temporaryRoot, 'vrm-dev-proxy-'));
  const app = createApp({ dataDir: dir, port: 0, intervals: false });
  const sockets = new Set();
  let vite;
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    try { await vite?.close(); }
    finally {
      await app.close();
      const cleanupTarget = realpathSync(dir);
      assert.equal(dirname(cleanupTarget).toLowerCase(), temporaryRoot.toLowerCase(), 'cleanup must remain within the intended temporary root');
      assert.ok(basename(cleanupTarget).startsWith('vrm-dev-proxy-'), 'cleanup must target this test directory');
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const backendPort = await app.listen();
  vite = await createServer({
    configFile: false,
    root: dir,
    logLevel: 'silent',
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
    // Permit the forged test Host through Vite to exercise the proxy's own guard.
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null, allowedHosts: ['attacker.example'], proxy: createDevProxy(`http://127.0.0.1:${backendPort}`) },
  });
  await vite.listen();
  const port = vite.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;

  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
    const response = await postInvalidJson(base, `http://${host}`, host);
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'INVALID_JSON', 'same-Origin request must reach business request parsing');
  }
  for (const [origin, host] of [
    ['https://attacker.example', undefined],
    [`http://localhost:${port}`, undefined],
    [`http://attacker.example:${port}`, `attacker.example:${port}`],
    ['http://localhost:65536', 'localhost:65536'],
    ['http://localhost', 'localhost'],
  ]) {
    const response = await postInvalidJson(base, origin, host);
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'ORIGIN_REJECTED');
  }

  const accepted = await websocketResult(`ws://127.0.0.1:${port}/ws`, base, sockets);
  assert.equal(accepted.status, 101);
  assert.equal(accepted.body.type, 'state-changed');
  const rejected = await websocketResult(`ws://127.0.0.1:${port}/ws`, 'https://attacker.example', sockets);
  assert.equal(rejected.status, 403);
  assert.equal(app.real.state().world, null, 'malformed test requests must leave the isolated live store empty');
});
