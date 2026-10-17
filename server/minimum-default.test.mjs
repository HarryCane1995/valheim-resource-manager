import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InventoryStore } from './store.mjs';
import { ItemRegistry, prefabHash } from './registry.mjs';
import { createApp } from './main.mjs';
import { validateIngest } from './validation.mjs';

const NOW = 1_790_000_000_000;
const item = (prefab, quantity = 10) => ({ prefab, name: prefab, quantity });
const chest = (id, items, x = 0, z = 0) => ({ id, type: 'piece_chest', name: 'Synthetic chest', x, y: 0, z, items, observedAt: NOW });
const packet = (containers, options = {}) => ({ sourceId: 'synthetic-host', worldId: 'synthetic-world', worldName: 'Synthetic world', mode: 'host', coverage: 'partial', gameVersion: 'synthetic', sessionId: 'synthetic-session', sequence: 1, containers, destroyedIds: [], ...options });
function fixture(t, options = {}) {
  const store = new InventoryStore(':memory:', { now: () => NOW, ...options });
  t.after(() => store.close());
  return store;
}
const resource = (state, prefab) => state.resources.find(value => value.prefab === prefab);

test('unconfigured worlds retain the previous minimum zero without registry-wide zero rows', t => {
  const store = fixture(t);
  assert.equal(store.state().defaultMinimum, 0);
  store.ingest(validateIngest(packet([chest('inside', [item('Wood')])])));
  const state = store.state();
  assert.equal(state.defaultMinimum, 0);
  assert.equal(resource(state, 'Wood').minimum, 0);
  assert.deepEqual(Object.keys(state.minimums), []);
  assert.equal(state.stats.shortages, 0);
});

test('bulk minimum resets existing overrides atomically without modifying inventories or filling all registered items', t => {
  const directory = mkdtempSync(join(tmpdir(), 'vrm-synthetic-default-registry-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const registry = new ItemRegistry(directory);
  const definitions = ['Wood', 'Iron', ...Array.from({ length: 1517 }, (_, index) => 'SyntheticUnused_' + index)].map(prefab => ({ id: 'prefab:' + prefab, prefab, prefabHash: prefabHash(prefab), nameRu: prefab, nameEn: prefab, maxStack: 50, metadata: {} }));
  registry.publish({ schemaVersion: 1, gameVersion: 'synthetic', generatedAt: new Date(NOW).toISOString(), source: { kind: 'installed-assets', exporter: 'synthetic fixture' }, coverage: { definitionsFound: definitions.length, scope: 'installed-assets', runtimeVerified: false }, items: definitions });
  const store = fixture(t, { registry });
  store.ingest(validateIngest(packet([chest('inside', [item('Wood', 100), item('Iron', 300), item('ModdedUnknown', 5)])])));
  store.minimum('synthetic-world', 'Wood', 500);
  store.minimum('synthetic-world', 'Iron', 0);
  store.minimum('synthetic-world', 'AbsentConfigured', 42);
  // Simulate an existing database created before the observed-items table.
  store.db.exec('DELETE FROM observed_items');
  const before = store.db.prepare('SELECT * FROM containers').all(), revision = store.revision;
  const state = store.defaultMinimum('synthetic-world', 200, { resetOverrides: true });
  assert.equal(state.defaultMinimum, 200);
  assert.deepEqual(Object.keys(state.minimums), []);
  assert.equal(state.resources.length, 4);
  assert.ok(state.resources.every(value => value.minimum === 200));
  assert.equal(state.stats.shortages, 3);
  assert.equal(state.registry.inventoryUnknownItems, 2);
  assert.equal(resource(state, 'AbsentConfigured').quantity, 0);
  assert.equal(state.registry.registered, 1519);
  assert.equal(store.revision, revision + 1);
  assert.deepEqual(store.db.prepare('SELECT * FROM containers').all(), before);
});

test('future observed items inherit the default and individual minimum zero remains an explicit override', t => {
  const store = fixture(t);
  store.ingest(validateIngest(packet([chest('inside', [item('Wood', 10)])])));
  store.defaultMinimum('synthetic-world', 200);
  store.minimum('synthetic-world', 'Wood', 0);
  store.ingest(validateIngest(packet([chest('inside', [item('Wood', 10), item('NewUnknownItem', 7)])], { sequence: 2 })));
  let state = store.state();
  assert.equal(resource(state, 'Wood').minimum, 0);
  assert.equal(state.minimums.Wood, 0);
  assert.equal(resource(state, 'NewUnknownItem').minimum, 200);
  assert.equal(state.stats.shortages, 1);
  store.defaultMinimum('synthetic-world', 300);
  state = store.state();
  assert.equal(resource(state, 'Wood').minimum, 0);
  assert.equal(resource(state, 'NewUnknownItem').minimum, 300);
  store.minimum('synthetic-world', 'NewUnknownItem', 500);
  assert.equal(resource(store.state(), 'NewUnknownItem').minimum, 500);
  store.ingest(validateIngest(packet([chest('inside', [item('NewUnknownItem', 7)])], { sequence: 3 })));
  assert.equal(resource(store.state(), 'Wood'), undefined);
});

test('watched resources remain zero deficits after full withdrawal and destruction without inventing unobserved definitions', t => {
  const store = fixture(t);
  store.ingest(validateIngest(packet([chest('inside', [item('Wood', 300), item('ModdedUnknown', 5)])])));
  store.defaultMinimum('synthetic-world', 200, { resetOverrides: true });
  store.ingest(validateIngest(packet([chest('inside', [])], { sequence: 2 })));
  let state = store.state();
  assert.equal(state.resources.length, 2);
  assert.ok(state.resources.every(value => value.quantity === 0 && value.minimum === 200));
  assert.equal(state.stats.shortages, 2);
  assert.equal(state.stats.uniqueItems, 0);
  assert.equal(state.stats.totalItems, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM observed_items').get().count, 2);
  store.ingest(validateIngest(packet([chest('inside', [item('FutureUnknown', 20)])], { sequence: 3 })));
  store.ingest(validateIngest(packet([], { sequence: 4, destroyedIds: ['inside'] })));
  state = store.state();
  assert.equal(state.resources.length, 3);
  assert.ok(state.resources.every(value => value.quantity === 0 && value.minimum === 200));
  assert.equal(state.stats.shortages, 3);
  assert.equal(state.stats.containers, 0);
  assert.deepEqual(Object.keys(state.minimums), []);
});

test('setting the default to zero restores legacy behavior while explicit configured shortages remain visible', t => {
  const store = fixture(t);
  store.ingest(validateIngest(packet([chest('inside', [item('Wood', 10)])])));
  store.defaultMinimum('synthetic-world', 200);
  store.minimum('synthetic-world', 'AbsentConfigured', 50);
  const state = store.defaultMinimum('synthetic-world', 0);
  assert.equal(resource(state, 'Wood').minimum, 0);
  assert.equal(resource(state, 'AbsentConfigured').quantity, 0);
  assert.equal(resource(state, 'AbsentConfigured').minimum, 50);
  assert.equal(state.stats.shortages, 1);
});

test('failed bulk reset rolls back the preference, overrides, event and revision together', t => {
  const store = fixture(t);
  store.ingest(validateIngest(packet([chest('inside', [item('Wood')])])));
  store.defaultMinimum('synthetic-world', 100);
  store.minimum('synthetic-world', 'Wood', 75);
  const before = store.state();
  store.db.exec("CREATE TRIGGER synthetic_abort_minimum_reset BEFORE DELETE ON minimums BEGIN SELECT RAISE(ABORT, 'synthetic reset failure'); END");
  assert.throws(() => store.defaultMinimum('synthetic-world', 200, { resetOverrides: true }), /synthetic reset failure/);
  const after = store.state();
  assert.equal(after.defaultMinimum, 100);
  assert.deepEqual(after.minimums, before.minimums);
  assert.deepEqual(after.events, before.events);
  assert.equal(after.revision, before.revision);
});

test('default and zero overrides persist on SQLite reopen, isolated by world', t => {
  const directory = mkdtempSync(join(tmpdir(), 'vrm-synthetic-default-persistence-'));
  const filename = join(directory, 'inventory.sqlite');
  let store = new InventoryStore(filename, { now: () => NOW });
  store.ingest(validateIngest(packet([chest('same-id', [item('Wood')])])));
  store.ingest(validateIngest(packet([chest('same-id', [item('Wood')])], { worldId: 'other-world' })));
  store.defaultMinimum('synthetic-world', 200);
  store.minimum('synthetic-world', 'Wood', 0);
  store.ingest(validateIngest(packet([chest('same-id', [item('FutureUnknown', 5)])], { sequence: 2 })));
  store.ingest(validateIngest(packet([chest('same-id', [])], { sequence: 3 })));
  store.close();
  store = new InventoryStore(filename, { now: () => NOW });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(store.state({ worldId: 'synthetic-world' }).defaultMinimum, 200);
  assert.equal(resource(store.state({ worldId: 'synthetic-world' }), 'Wood'), undefined);
  assert.equal(store.state({ worldId: 'synthetic-world' }).minimums.Wood, 0);
  assert.equal(resource(store.state({ worldId: 'synthetic-world' }), 'FutureUnknown').quantity, 0);
  assert.equal(resource(store.state({ worldId: 'synthetic-world' }), 'FutureUnknown').minimum, 200);
  assert.equal(store.state({ worldId: 'other-world' }).defaultMinimum, 0);
  assert.equal(resource(store.state({ worldId: 'other-world' }), 'Wood').minimum, 0);
});

test('default follows the current 500 metre area and manual zone, including items revealed by a moved bed', t => {
  const store = fixture(t);
  store.ingest(validateIngest(packet([chest('left', [item('Wood', 100)], -400), chest('right', [item('Iron', 300)], 400), chest('outside', [item('OutsideOnly', 50)], 1000)], { hostBed: { status: 'set', x: 0, y: 0, z: 0 } })));
  store.defaultMinimum('synthetic-world', 200);
  let state = store.state();
  assert.deepEqual(state.resources.map(value => value.prefab).sort(), ['Iron', 'OutsideOnly', 'Wood']);
  assert.equal(resource(state, 'OutsideOnly').quantity, 0);
  assert.equal(state.stats.shortages, 2);
  store.zone('synthetic-world', { name: 'Synthetic zone', x: 500, z: 0, radius: 300, enabled: true }, 'main');
  state = store.state({ zoneId: 'main' });
  assert.equal(resource(state, 'Iron').quantity, 300);
  assert.equal(resource(state, 'Wood').quantity, 0);
  assert.equal(resource(state, 'OutsideOnly').quantity, 0);
  assert.equal(state.stats.shortages, 2);
  store.ingest(validateIngest(packet([], { sequence: 2, hostBed: { status: 'set', x: 1000, y: 0, z: 0 } })));
  state = store.state();
  assert.equal(resource(state, 'OutsideOnly').quantity, 50);
  assert.equal(resource(state, 'OutsideOnly').minimum, 200);
  assert.equal(resource(state, 'Wood').quantity, 0);
  assert.equal(resource(state, 'Iron').quantity, 0);
  assert.equal(state.stats.shortages, 3);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM containers').get().count, 3);
});

test('an explicitly unset bed remains empty even with a default and configured minima', t => {
  const store = fixture(t);
  store.ingest(validateIngest(packet([chest('inside', [item('Wood')])], { hostBed: { status: 'unset' } })));
  store.minimum('synthetic-world', 'Iron', 50);
  const state = store.defaultMinimum('synthetic-world', 200);
  assert.equal(state.defaultMinimum, 200);
  assert.deepEqual(state.resources, []);
  assert.equal(state.stats.shortages, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM containers').get().count, 1);
});

test('demo restart clears its preference without changing any other store', t => {
  const real = fixture(t), demo = fixture(t, { demo: true });
  real.ingest(validateIngest(packet([chest('inside', [item('Wood')])])));
  real.defaultMinimum('synthetic-world', 200);
  demo.startDemo();
  demo.defaultMinimum('demo-midgard', 350, { resetOverrides: true });
  assert.equal(demo.state().defaultMinimum, 350);
  demo.startDemo();
  assert.equal(demo.state().defaultMinimum, 0);
  assert.equal(demo.state().minimums.Wood, 300);
  assert.equal(real.state().defaultMinimum, 200);
});

test('observed hash aliases converge to one canonical zero deficit when the registry becomes available', t => {
  const directory = mkdtempSync(join(tmpdir(), 'vrm-synthetic-default-alias-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const registry = new ItemRegistry(directory), store = fixture(t, { registry }), alias = 'hash:' + prefabHash('Wood');
  store.ingest(validateIngest(packet([chest('inside', [item(alias, 5), item('Wood', 10), item('UnknownStill', 1)])])));
  store.defaultMinimum('synthetic-world', 200);
  store.ingest(validateIngest(packet([chest('inside', [])], { sequence: 2 })));
  assert.equal(store.state().resources.length, 3);
  const definition = { id: 'prefab:Wood', prefab: 'Wood', prefabHash: prefabHash('Wood'), nameRu: 'Synthetic Wood', nameEn: 'Wood', maxStack: 50, metadata: {} };
  registry.publish({ schemaVersion: 1, gameVersion: 'synthetic', generatedAt: new Date(NOW).toISOString(), source: { kind: 'installed-assets', exporter: 'synthetic fixture' }, coverage: { definitionsFound: 1, scope: 'installed-assets', runtimeVerified: false }, items: [definition] });
  let state = store.state();
  assert.equal(state.resources.length, 2);
  assert.equal(resource(state, 'Wood').quantity, 0);
  assert.equal(resource(state, 'Wood').minimum, 200);
  assert.equal(resource(state, 'UnknownStill').minimum, 200);
  store.minimum('synthetic-world', alias, 0);
  state = store.state();
  assert.equal(state.minimums.Wood, 0);
  assert.equal(resource(state, 'Wood'), undefined);
  assert.equal(resource(state, 'UnknownStill').minimum, 200);
});

test('HTTP default minimum validates input and writes only the selected real or demo world', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'vrm-synthetic-default-http-'));
  const app = createApp({ dataDir: directory, port: 0, token: 'a'.repeat(64), intervals: false });
  const port = await app.listen(), base = `http://127.0.0.1:${port}`;
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const request = (path, value, headers = {}) => fetch(base + path, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });
  app.real.ingest(validateIngest(packet([chest('inside', [item('Wood')])])));
  app.demo.startDemo();
  app.real.minimum('synthetic-world', 'Wood', 999);
  for (const minimum of [-1, 0.5, '200', null, 1_000_000_001]) assert.equal((await request('/api/minimums/default', { worldId: 'synthetic-world', minimum })).status, 400);
  assert.equal((await request('/api/minimums/default', { worldId: 'synthetic-world', minimum: 200, resetOverrides: 'true' })).status, 400);
  assert.equal((await request('/api/minimums/default', { worldId: 'unknown', minimum: 200 })).status, 404);
  assert.equal((await request('/api/minimums/default', { minimum: 200 })).status, 400);
  assert.equal((await request('/api/minimums/default', { worldId: 'synthetic-world', minimum: 200 }, { Origin: 'https://invalid.example' })).status, 403);
  assert.equal(app.real.state().defaultMinimum, 0);
  assert.equal(app.real.state().minimums.Wood, 999);
  let response = await request('/api/minimums/default', { worldId: 'synthetic-world', minimum: 200, resetOverrides: true });
  assert.equal(response.status, 200);
  let state = await response.json();
  assert.equal(state.defaultMinimum, 200);
  assert.deepEqual(state.minimums, {});
  assert.equal(resource(state, 'Wood').minimum, 200);
  assert.equal(app.demo.state().defaultMinimum, 0);
  response = await request('/api/minimums/default?demo=1', { worldId: 'demo-midgard', minimum: 400, resetOverrides: true });
  assert.equal(response.status, 200);
  state = await response.json();
  assert.equal(state.defaultMinimum, 400);
  assert.ok(state.resources.every(value => value.minimum === 400));
  assert.equal(app.real.state().defaultMinimum, 200);
});
