// Optional acceptance of the actual single-file portable, with isolated fake data.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { spawn } = require('node:child_process');
const { mkdtempSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const assert = require('node:assert/strict');
const pause = ms => new Promise(done => setTimeout(done, ms));
async function until(action, timeout = 45000) { const end = Date.now() + timeout; let last; while (Date.now() < end) { try { return await action(); } catch (error) { last = error; await pause(200); } } throw last || Error('Timed out'); }
(async () => {
  mkdirSync('.runtime', { recursive: true });
  const executable = resolve(process.argv[2] || 'ValheimResourceManager.exe');
  const home = mkdtempSync(join(tmpdir(), 'vrm-portable-acceptance-'));
  const env = { ...process.env, VRM_DESKTOP_HOME: home, VRM_DESKTOP_PORT: '37846' }; delete env.ELECTRON_RUN_AS_NODE;
  const base = 'http://127.0.0.1:37846', checks = [];
  let browser, child;
  const launch = async () => {
    child = spawn(executable, ['--remote-debugging-port=9471'], { env, windowsHide: true, stdio: 'ignore' });
    await until(async () => { const response = await fetch('http://127.0.0.1:9471/json/version', { signal: AbortSignal.timeout(1000) }); assert.equal(response.status, 200); });
    browser = await chromium.connectOverCDP('http://127.0.0.1:9471');
    const page = await until(async () => { const found = browser.contexts()[0]?.pages().find(candidate => candidate.url().startsWith(base)); assert.ok(found); return found; });
    await page.getByTestId('desktop-controls').waitFor();
    return page;
  };
  const close = async page => { await page.close(); await browser.close().catch(() => {}); browser = null; await until(async () => { let up = false; try { const response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(1000) }); up = response.ok; } catch {} assert.equal(up, false); }); await until(async () => assert.notEqual(child.exitCode, null)); };
  try {
    let page = await launch(); checks.push('single-file portable starts real window without installer');
    const status = await page.evaluate(() => window.vrmDesktop.getStatus()); assert.equal(status.backend, 'owned'); checks.push('packaged embedded SQLite and backend start');
    assert.equal(await page.evaluate(() => typeof require), 'undefined'); checks.push('packaged renderer is isolated');
    const token = readFileSync(join(home, 'data', 'ingest-token.txt'), 'utf8').trim();
    const payload = { worldId: 'portable-fixture', worldName: 'Portable — тестовый мир', sourceId: 'portable-test', sessionId: 'portable-test', sequence: 1, mode: 'host', coverage: 'partial', gameVersion: 'SYNTHETIC', hostBed: { status: 'set', x: 0, y: 0, z: 0 }, containers: [{ id: 'fixture-chest', type: 'piece_chest', name: 'Тестовый сундук', x: 0, y: 0, z: 0, observedAt: new Date().toISOString(), items: [{ prefab: 'Wood', name: 'Wood', quantity: 100 }] }], destroyedIds: [] };
    assert.equal((await fetch(base + '/api/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-VRM-Token': token }, body: JSON.stringify(payload) })).status, 200);
    await page.waitForFunction(() => document.querySelector('.desktop-world')?.textContent.includes('Portable — тестовый мир')); checks.push('packaged automatic world discovery');
    await page.getByRole('button', { name: 'На весь экран', exact: true }).click(); await page.waitForFunction(async () => (await window.vrmDesktop.getStatus()).fullscreen); checks.push('portable native fullscreen button');
    await page.keyboard.press('Escape'); await page.waitForFunction(async () => !(await window.vrmDesktop.getStatus()).fullscreen);
    await page.keyboard.press('F11'); await page.waitForFunction(async () => (await window.vrmDesktop.getStatus()).fullscreen);
    await page.keyboard.press('F11'); await page.waitForFunction(async () => !(await window.vrmDesktop.getStatus()).fullscreen); checks.push('portable F11 and Escape');
    const second = spawn(executable, [], { env, windowsHide: true, stdio: 'ignore' }); await until(async () => assert.notEqual(second.exitCode, null));
    assert.equal(browser.contexts()[0].pages().length, 1); checks.push('portable second launch uses existing window');
    assert.equal((await fetch(base + '/api/minimums/default', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ worldId: payload.worldId, minimum: 200, resetOverrides: true }) })).status, 200);
    await close(page); checks.push('portable close releases backend and wrapper exits');
    page = await launch(); const state = await (await fetch(base + '/api/state')).json(); assert.equal(state.defaultMinimum, 200); assert.equal(state.resources[0].quantity, 100); checks.push('portable restart retains private SQLite data');
    await close(page); checks.push('portable restart closes cleanly');
    const proof = { result: 'PASS', synthetic: true, checks };
    writeFileSync('.runtime/desktop-portable-proof.json', JSON.stringify(proof, null, 2)); console.log(JSON.stringify(proof, null, 2));
  } finally { if (browser) { const page = browser.contexts()[0]?.pages()[0]; await page?.close().catch(() => {}); await browser.close().catch(() => {}); } }
})().catch(error => { console.error(error); process.exitCode = 1; });
