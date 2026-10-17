import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InventoryStore, HEARTBEAT_TIMEOUT_MS } from './store.mjs';
import { validateIngest } from './validation.mjs';

const START = 1_790_000_000_000;
const bed = (x = 0, z = 0, y = 7) => ({ status: 'set', x, y, z });
function fixture(t) {
  let clock = START, sequence = 0;
  const store = new InventoryStore(':memory:', { now: () => clock });
  t.after(() => store.close());
  const chest = (id, x, z, quantity = 10, y = 7, options = {}) => ({ id, type: 'piece_chest', name: 'Синтетический сундук', x, y, z, observedAt: clock, items: [{ prefab: 'Wood', name: 'Wood', quantity }], ...options });
  const packet = (containers = [], options = {}) => ({ sourceId: 'synthetic-host', worldId: 'synthetic-world', worldName: 'Синтетический мир', sessionId: 'session-a', mode: 'host', coverage: 'partial', gameVersion: 'test', sequence: ++sequence, containers, destroyedIds: [], ...options });
  const ingest = (containers, options) => store.ingest(validateIngest(packet(containers, options)));
  return { store, chest, packet, ingest, advance: ms => clock += ms };
}

test('host bed pending is explicit and preserves legacy scope until a valid report', t => {
  const { store, chest, ingest } = fixture(t);
  assert.deepEqual(store.state().hostBedArea, { status: 'pending', radius: 500, applied: false });
  ingest([chest('near', 0, 0), chest('far', 2000, 0)], { hostBed: null });
  assert.deepEqual(store.state().hostBedArea, { status: 'pending', radius: 500, applied: false });
  assert.equal(store.state().stats.containers, 2);
  assert.equal(store.state().stats.totalItems, 20);
  assert.equal(store.state().hostBedArea.x, undefined);
});

test('host bed reports reject foreign modes, malformed states and non-finite coordinates', t => {
  const { store, packet } = fixture(t);
  for (const mode of ['client', 'server', 'snapshot']) for (const hostBed of [bed(), { status: 'unset' }, null]) {
    const value = packet([], { mode, hostBed });
    assert.throws(() => validateIngest(value), error => error.status === 400);
    assert.throws(() => store.ingest(value), error => error.status === 400);
  }
  for (const hostBed of [0, [], {}, { status: 'active', x: 0, y: 0, z: 0 }, { status: 'set', x: 0, z: 0 }, { status: 'unset', x: 0 }, { ...bed(), characterId: 'unwanted' }]) assert.throws(() => validateIngest(packet([], { hostBed })), error => error.status === 400);
  for (const coordinate of [NaN, Infinity, -Infinity, '0', 10_000_001]) for (const axis of ['x', 'y', 'z']) assert.throws(() => validateIngest(packet([], { hostBed: { ...bed(), [axis]: coordinate } })), error => error.status === 400);
  assert.equal(store.revision, 0);
  assert.equal(store.state().world, null);
});

test('explicit zero bed is valid; exactly 500 metres is included and farther is excluded', t => {
  const { store, chest, ingest } = fixture(t);
  ingest([chest('zero', 0, 0, 1), chest('boundary', 300, 400, 2), chest('outside', 500.001, 0, 4)], { hostBed: bed(0, 0, 0) });
  const state = store.state();
  assert.deepEqual(state.hostBedArea, { status: 'active', radius: 500, applied: true, x: 0, y: 0, z: 0, observedAt: new Date(START).toISOString() });
  assert.deepEqual(state.containers.map(chest => chest.id), ['zero', 'boundary']);
  assert.equal(state.resources[0].quantity, 3);
  assert.equal(state.stats.totalItems, 3);
  assert.equal(state.clusterStats.reduce((sum, cluster) => sum + cluster.totalItems, 0), 3);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS total FROM containers').get().total, 3);
});

test('host bed radius uses signed X/Z coordinates and ignores vertical distance', t => {
  const { store, chest, ingest } = fixture(t);
  ingest([chest('vertical', -100, -200, 1, 90000), chest('west', -600, -200, 2), chest('south', -100, -700, 4), chest('north-outside', -100, 301, 8), chest('diagonal-outside', 300, 200, 16)], { hostBed: bed(-100, -200, -50) });
  assert.deepEqual(store.state().containers.map(chest => chest.id), ['vertical', 'west', 'south']);
  assert.equal(store.state().stats.totalItems, 7);
});

test('host bed scope intersects selected manual zones without changing their stored geometry', t => {
  const { store, chest, ingest } = fixture(t);
  ingest([chest('left', -400, 0, 1), chest('right', 400, 0, 2), chest('far-right', 600, 0, 4)], { hostBed: bed() });
  store.zone('synthetic-world', { name: 'Ручная зона', x: 500, z: 0, radius: 300, enabled: true }, 'main');
  assert.equal(store.state().stats.totalItems, 3);
  const state = store.state({ zoneId: 'main' });
  assert.deepEqual(state.containers.map(chest => chest.id), ['right']);
  assert.equal(state.stats.totalItems, 2);
  assert.equal(state.zones[0].radius, 300);
  assert.equal(state.hostBedArea.radius, 500);
});

test('moving host bed changes totals and can reveal stored outside inventories again', t => {
  const { store, chest, ingest } = fixture(t);
  ingest([chest('home', 0, 0, 1), chest('new-home', 1000, 0, 2)], { hostBed: bed() });
  assert.equal(store.state().stats.totalItems, 1);
  ingest([], { hostBed: bed(1000, 0) });
  assert.equal(store.state().stats.totalItems, 2);
  ingest([], { hostBed: bed() });
  assert.equal(store.state().stats.totalItems, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS total FROM containers WHERE destroyed=0').get().total, 2);
});

test('unset bed produces explicit empty accounting, including configured minima, without deleting inventories', t => {
  const { store, chest, ingest } = fixture(t);
  ingest([chest('home', 0, 0)], { hostBed: bed() });
  store.minimum('synthetic-world', 'Iron', 50);
  ingest([], { hostBed: { status: 'unset' } });
  const state = store.state();
  assert.deepEqual(state.hostBedArea, { status: 'unset', radius: 500, applied: true, observedAt: new Date(START).toISOString() });
  assert.deepEqual(state.containers, []);
  assert.deepEqual(state.resources, []);
  assert.deepEqual(state.stats, { totalItems: 0, uniqueItems: 0, containers: 0, shortages: 0 });
  assert.equal(state.source.lastConfirmedAt, null);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS total FROM containers').get().total, 1);
  ingest([], { hostBed: bed() });
  assert.equal(store.state().stats.totalItems, 10);
  assert.equal(store.state().minimums.Iron, 50);
});

test('host bed remains last known after disconnect, legacy omission and null reports', t => {
  const { store, chest, ingest, advance } = fixture(t);
  ingest([chest('home', 0, 0), chest('outside', 1000, 0)], { hostBed: bed() });
  const anchor = store.state().hostBedArea;
  advance(HEARTBEAT_TIMEOUT_MS + 1);
  assert.equal(store.state().source.connected, false);
  assert.deepEqual(store.state().hostBedArea, anchor);
  assert.equal(store.state().stats.containers, 1);
  ingest([]);
  ingest([], { hostBed: null });
  assert.deepEqual(store.state().hostBedArea, anchor);
  assert.equal(store.state().stats.containers, 1);
});

test('world bed anchors stay isolated and non-host observations cannot replace them', t => {
  const { store, chest, ingest } = fixture(t);
  ingest([chest('same-id', 0, 0, 1)], { hostBed: bed() });
  ingest([chest('same-id', 2000, 0, 2)], { worldId: 'second-world', hostBed: bed(2000, 0) });
  ingest([chest('snapshot', 9000, 0, 4)], { sourceId: 'snapshot', sessionId: 'snapshot', mode: 'snapshot' });
  ingest([], { sourceId: 'client', sessionId: 'client', mode: 'client' });
  assert.equal(store.state({ worldId: 'synthetic-world' }).stats.totalItems, 1);
  assert.equal(store.state({ worldId: 'synthetic-world' }).hostBedArea.x, 0);
  assert.equal(store.state({ worldId: 'second-world' }).stats.totalItems, 2);
  assert.equal(store.state({ worldId: 'second-world' }).hostBedArea.x, 2000);
});

test('host session/source replacement persists provenance and rejects superseded-session reports', t => {
  const { store, chest, packet } = fixture(t);
  const first = packet([chest('home', 0, 0), chest('other', 2000, 0)], { hostBed: bed() });
  store.ingest(first);
  store.ingest(packet([], { sessionId: 'session-b', sequence: 0, hostBed: bed(2000, 0) }));
  assert.throws(() => store.ingest({ ...first, sequence: 100 }), error => error.code === 'REPLAY');
  assert.equal(store.state().hostBedArea.x, 2000);
  store.ingest(packet([], { sourceId: 'new-host', sessionId: 'new-session', sequence: 0, hostBed: bed(100, 0) }));
  const provenance = store.db.prepare('SELECT source_id,session_id FROM host_beds WHERE world_id=?').get('synthetic-world');
  assert.equal(provenance.source_id, 'new-host');
  assert.equal(provenance.session_id, 'new-session');
  assert.equal(store.state().hostBedArea.x, 100);
});

test('host bed retries are idempotent and a conflicting container transaction rolls back its bed change', t => {
  const { store, chest, packet, advance } = fixture(t);
  const first = packet([chest('home', 0, 0, 10, 7, { identityKey: 'stable-home' })], { hostBed: bed() });
  store.ingest(first);
  const revision = store.revision;
  advance(1000);
  assert.equal(store.ingest(first), revision);
  assert.equal(store.state().hostBedArea.observedAt, new Date(START).toISOString());
  assert.throws(() => store.ingest({ ...first, hostBed: bed(2000, 0) }), error => error.code === 'REPLAY');
  const conflict = packet([chest('different-runtime-id', 1, 0, 10, 7, { identityKey: 'stable-home' })], { hostBed: bed(2000, 0) });
  assert.throws(() => store.ingest(conflict), error => error.code === 'IDENTITY_CONFLICT');
  assert.equal(store.revision, revision);
  assert.equal(store.state().hostBedArea.x, 0);
  conflict.containers[0].x = 0;
  store.ingest(conflict);
  assert.equal(store.state().hostBedArea.x, 2000);
});

test('host bed anchor and provenance survive SQLite reopen with last-known offline quantities', t => {
  const directory = mkdtempSync(join(tmpdir(), 'vrm-synthetic-host-bed-'));
  const filename = join(directory, 'inventory.sqlite');
  let store = new InventoryStore(filename, { now: () => START });
  const packet = { sourceId: 'synthetic-host', worldId: 'synthetic-world', worldName: 'Синтетический мир', sessionId: 'synthetic-session', mode: 'host', coverage: 'partial', gameVersion: 'test', sequence: 0, hostBed: bed(-100, -200), containers: [{ id: 'inside', type: 'chest', name: 'Synthetic', x: -100, y: 0, z: -200, observedAt: START, items: [{ prefab: 'Wood', name: 'Wood', quantity: 7 }] }, { id: 'outside', type: 'chest', name: 'Synthetic', x: 900, y: 0, z: -200, observedAt: START, items: [{ prefab: 'Wood', name: 'Wood', quantity: 99 }] }], destroyedIds: [] };
  store.ingest(validateIngest(packet));
  store.close();
  store = new InventoryStore(filename, { now: () => START + HEARTBEAT_TIMEOUT_MS + 1 });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(store.state().hostBedArea.x, -100);
  assert.equal(store.state().hostBedArea.z, -200);
  assert.equal(store.state().source.connected, false);
  assert.equal(store.state().stats.totalItems, 7);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS total FROM containers').get().total, 2);
  assert.equal(store.db.prepare('SELECT session_id FROM host_beds').get().session_id, 'synthetic-session');
});
