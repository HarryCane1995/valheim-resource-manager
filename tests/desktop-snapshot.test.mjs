// Synthetic byte fixtures only. These tests never open a game installation/save.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, lstat, rm, open, symlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverCompletedWorlds, readCompletedSnapshot } from '../desktop/snapshot.mjs';

const hash = value => {
  let a = 5381, b = 5381;
  for (let i = 0; i < value.length; i += 2) { a = Math.imul(a, 33) ^ value.charCodeAt(i); if (i + 1 < value.length) b = Math.imul(b, 33) ^ value.charCodeAt(i + 1); }
  return (a + Math.imul(b, 1566083941)) | 0;
};
const concat = (...data) => Buffer.concat(data.flat());
const scalar = (method, size) => value => { const b = Buffer.alloc(size); b[method](value); return b; };
const u8 = scalar('writeUInt8', 1), u16 = scalar('writeUInt16LE', 2), i16 = scalar('writeInt16LE', 2), u32 = scalar('writeUInt32LE', 4), i32 = scalar('writeInt32LE', 4), i64 = scalar('writeBigInt64LE', 8), f32 = scalar('writeFloatLE', 4);
function string(value) {
  const data = Buffer.from(value), prefix = []; let count = data.length;
  while (count >= 128) { prefix.push((count & 127) | 128); count >>= 7; }
  return concat(Buffer.from([...prefix, count]), data);
}
const dictionaryCount = value => value < 128 ? u8(value) : Buffer.from([(value >> 8) | 128, value & 255]);
const byteArray = bytes => concat(i32(bytes.length), bytes);

function inventory({ version = 110, quantity = 40, prefabHash = hash('Wood'), allFlags = false, customCount = 2 } = {}) {
  const flags = 64 | (quantity !== 1 ? 8 : 0) | (allFlags ? 4 | 16 | 32 | 128 | 1 | 2 : 0);
  const bytes = [i32(version), u16(1), i32(10000), Buffer.from([1, 2, 0, flags])];
  if (flags & 4) bytes.push(u16(3));
  if (flags & 8) bytes.push(u16(quantity));
  if (flags & 16) bytes.push(i32(12));
  if (flags & 32) bytes.push(i64(9223372036854775807n), string('Синтетический мастер'));
  bytes.push(i32(prefabHash));
  if (flags & 128) { bytes.push(dictionaryCount(customCount)); for (let index = 0; index < customCount; index++) bytes.push(string(`test:${index}`), string('значение')); }
  if (version >= 109) bytes.push(u8(1));
  return concat(bytes);
}
function record({ prefabHash = hash('piece_chest_wood'), position = [1.25, -0, -20.5], inv = inventory(), flags = 0, generic = false, rotation = null } = {}) {
  if (inv !== null) flags |= 128;
  if (generic) flags |= 1 | 2 | 4 | 8 | 16 | 32 | 64;
  if (rotation !== null) flags |= 0x1000;
  const bytes = [u16(flags), ...(flags & 0x2000 ? [i16(position[0]), i16(position[2])] : position.map(f32)), i32(prefabHash)];
  if (rotation !== null) bytes.push(rotation);
  if (flags & 1) bytes.push(u8(4), i32(-1234));
  for (const [bit, value] of [[2, f32(1.5)], [4, concat([2, 3, 4].map(f32))], [8, concat([0, 0, 0, 1].map(f32))], [16, i32(88)], [32, i64(9223372036854775807n)], [64, string('unrelated')]]) {
    if (flags & bit) bytes.push(dictionaryCount(1), i32(-998877), value);
  }
  if (flags & 128) bytes.push(dictionaryCount(2), i32(hash('unknown-byte-field')), byteArray(Buffer.from('abc')), i32(hash('items')), byteArray(inv));
  return concat(bytes);
}
const chunk = (records, version = 42) => concat(i16(version), i32(records.length), records);

async function fixture(t, { generation = 7, mappingVersion = 42, worldVersion = 42, chunkVersion = 42, uid = 9223372036854775807n, name = 'Синтетический мир', records = [record()], tail = true, duplicateMapping = false, folder = null } = {}) {
  const root = folder || await mkdtemp(join(tmpdir(), 'vrm-desktop-snapshot-'));
  if (!folder) t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  const entries = duplicateMapping ? 2 : 1, prefix = `_main.${generation}`, chunkName = '00_01__3_1.chunk';
  const mapping = concat(u16(mappingVersion), i32(records.length * entries), i32(entries), Array.from({ length: entries }, () => concat(u16(1), u8(3), u32(1), i32(records.length))));
  const worldBytes = [i32(worldVersion), string(name), string('synthetic-seed'), i32(42), i64(uid)];
  if (tail) worldBytes.push(i32(2), u8(1), i32(1), string('synthetic-key'), i32(1), ...['PRIVATE-USER-FIXTURE', 'PRIVATE-NAME-FIXTURE', 'PRIVATE-PLATFORM-FIXTURE', 'PRIVATE-ID-FIXTURE'].map(string));
  const world = byteArray(concat(worldBytes)), chunkData = chunk(records, chunkVersion);
  await Promise.all([
    writeFile(join(root, `${prefix}.chunks`), mapping), writeFile(join(root, `${prefix}.fwl2`), world),
    writeFile(join(root, `${prefix}.ok`), u32(generation)), writeFile(join(root, chunkName), chunkData),
  ]);
  const markerTime = new Date('2026-01-02T03:04:05.000Z');
  await utimes(join(root, `${prefix}.ok`), markerTime, markerTime);
  return { root, prefix, chunkName, chunkData, world };
}

async function fingerprints(folder) {
  const result = {};
  for (const filename of (await readdir(folder)).sort()) {
    const path = join(folder, filename), stat = await lstat(path, { bigint: true });
    result[filename] = { bytes: createHash('sha256').update(await readFile(path)).digest('hex'), mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs, size: stat.size };
  }
  return result;
}

test('completed snapshot preserves exact UID, signed zero/float identity, count and source bytes', async t => {
  const { root } = await fixture(t), before = await fingerprints(root);
  const { payload, manifest } = await readCompletedSnapshot(root);
  assert.deepEqual(await fingerprints(root), before);
  assert.equal(payload.worldId, '9223372036854775807');
  assert.equal(payload.mode, 'snapshot'); assert.equal(payload.coverage, 'partial');
  assert.equal(payload.sourceId, 'save-snapshot'); assert.equal(payload.sessionId, 'snapshot-7');
  assert.equal(payload.containers[0].identityKey, `pos-v1:${hash('piece_chest_wood')}:3fa00000:80000000:c1a40000`);
  assert.equal(payload.containers[0].items[0].prefab, 'Wood');
  assert.equal(payload.containers[0].items[0].quantity, 40);
  assert.equal(payload.containers[0].observedAt, '2026-01-02T03:04:05.000Z');
  assert.ok(Object.is(payload.containers[0].y, -0));
  assert.deepEqual(payload.destroyedIds, []);
  assert.equal(manifest.sourceUnchangedDuringRead, true); assert.equal(manifest.containers, 1); assert.equal(manifest.zdos, 1);
  assert.equal(Object.keys(manifest.sha256).length, 4);
  for (const [filename, digest] of Object.entries(manifest.sha256)) assert.equal(digest, before[filename].bytes);
  assert.ok(!JSON.stringify({ payload, manifest }).includes('PRIVATE-'));
});

test('inventory 108-110 optional fields, extended counts and UTF-8 offsets are retained', async t => {
  for (const version of [108, 109, 110]) {
    const { root } = await fixture(t, { records: [record({ inv: inventory({ version, allFlags: true, customCount: 128 }) })] });
    const { payload } = await readCompletedSnapshot(root);
    assert.equal(payload.containers[0].items[0].quantity, 40);
    assert.equal(payload.containers[0].items[0].name, 'Древесина');
  }
});

test('empty inventory and default single stack are supported', async t => {
  const { root } = await fixture(t, { records: [record({ inv: concat(i32(110), u16(0)) }), record({ position: [2, 0, 2], inv: inventory({ quantity: 1 }) }), record({ position: [3, 0, 3], inv: null })] });
  const { payload } = await readCompletedSnapshot(root);
  assert.deepEqual(payload.containers.map(item => item.items.length), [0, 1, 0]);
  assert.equal(payload.containers[1].items[0].quantity, 1);
});

test('chunk 40-42 and all unrelated typed fields preserve inventory offsets', async t => {
  for (const chunkVersion of [40, 41, 42]) {
    const { root } = await fixture(t, { chunkVersion, records: [record({ generic: true })] });
    assert.equal((await readCompletedSnapshot(root)).payload.containers[0].items[0].quantity, 40);
  }
});

test('compressed positions and both compressed rotation encodings are accepted', async t => {
  for (const rotation of [u16(0x8000 | 90), concat(u16(1), u16(0x0300))]) {
    const { root } = await fixture(t, { records: [record({ flags: 0x2000, position: [-23, 0, 17], rotation })] });
    const chest = (await readCompletedSnapshot(root)).payload.containers[0];
    assert.deepEqual([chest.x, chest.y, chest.z], [-23, 0, 17]);
  }
});

test('unknown hashes remain unresolved and unknown inventory objects are counted', async t => {
  const { root } = await fixture(t, { records: [record({ inv: inventory({ quantity: 123, prefabHash: -2147483601 }) }), record({ position: [2, 0, 2], prefabHash: -7654 })] });
  const { payload, manifest } = await readCompletedSnapshot(root);
  assert.equal(payload.containers.length, 1);
  assert.equal(payload.containers[0].items[0].prefab, 'hash:-2147483601');
  assert.equal(payload.containers[0].items[0].quantity, 123);
  assert.equal(manifest.unresolvedItemUnits, 123); assert.equal(manifest.unknownInventoryObjects, 1);
});

test('unsupported inventory, world, chunk and mapping versions fail closed', async t => {
  for (const options of [{ mappingVersion: 43 }, { worldVersion: 43 }, { chunkVersion: 39 }, { chunkVersion: 43 }, ...[0, 107, 111, 999].map(version => ({ records: [record({ inv: inventory({ version }) })] }))]) {
    const { root } = await fixture(t, options);
    await assert.rejects(readCompletedSnapshot(root), /Unsupported/);
  }
});

test('reserved ZDO flags and nonfinite positions are refused', async t => {
  for (const options of [{ flags: 0x4000 }, { flags: 0x8000 }, { position: [NaN, 0, 0] }, { position: [0, Infinity, 0] }]) {
    const { root } = await fixture(t, { records: [record(options)] });
    await assert.rejects(readCompletedSnapshot(root), /Unknown ZDO flags|Nonfinite/);
  }
});

test('truncated inventory, missing prefab, invalid UTF-8 and trailing bytes are refused', async t => {
  for (const inv of [inventory().subarray(0, -1), concat(inventory(), u8(0)), inventory({ prefabHash: 0 }), concat(i32(110), u16(65535)), concat(i32(110), u16(1), Buffer.alloc(7), u8(32), Buffer.alloc(8), u8(1), u8(255))]) {
    const { root } = await fixture(t, { records: [record({ inv })] });
    await assert.rejects(readCompletedSnapshot(root));
  }
});

test('duplicate exact container identities and duplicate mapping entries are refused', async t => {
  const duplicateChest = await fixture(t, { records: [record(), record()] });
  await assert.rejects(readCompletedSnapshot(duplicateChest.root), /Ambiguous duplicate/);
  const duplicateMapping = await fixture(t, { duplicateMapping: true });
  await assert.rejects(readCompletedSnapshot(duplicateMapping.root), /Duplicate chunk mapping/);
});

test('all required world fields, completion marker and mapped chunks must exist', async t => {
  const incompleteWorld = await fixture(t, { tail: false });
  await assert.rejects(readCompletedSnapshot(incompleteWorld.root), /Truncated/);
  const badMarker = await fixture(t); await writeFile(join(badMarker.root, `${badMarker.prefix}.ok`), Buffer.alloc(3));
  await assert.rejects(readCompletedSnapshot(badMarker.root), /completion marker/);
  const missingChunk = await fixture(t); await rm(join(missingChunk.root, missingChunk.chunkName));
  await assert.rejects(readCompletedSnapshot(missingChunk.root), { code: 'ENOENT' });
});

test('mapping and chunk counts, bounds, truncation and extra bytes are checked', async t => {
  for (const mutate of [
    bytes => { bytes.writeInt32LE(123, 2); return bytes; },
    bytes => { bytes.writeInt32LE(-1, 2); return bytes; },
    bytes => { bytes.writeInt32LE(20_000_001, 2); return bytes; },
    bytes => { bytes.writeInt32LE(100_001, 6); return bytes; },
    bytes => { bytes.writeInt32LE(2, 17); return bytes; },
    bytes => { bytes[12] = 4; return bytes; },
    bytes => bytes.subarray(0, -1),
    bytes => concat(bytes, u8(0)),
  ]) {
    const source = await fixture(t), path = join(source.root, `${source.prefix}.chunks`);
    await writeFile(path, mutate(await readFile(path)));
    await assert.rejects(readCompletedSnapshot(source.root));
  }
  for (const mutate of [bytes => bytes.subarray(0, -1), bytes => concat(bytes, u8(0)), bytes => { bytes.writeInt32LE(-1, 2); return bytes; }, bytes => { bytes.writeInt32LE(2_000_001, 2); return bytes; }]) {
    const source = await fixture(t), path = join(source.root, source.chunkName);
    await writeFile(path, mutate(await readFile(path)));
    await assert.rejects(readCompletedSnapshot(source.root));
  }
});

test('a source mutation during reading is detected before returning any payload', async t => {
  const source = await fixture(t), path = join(source.root, source.chunkName);
  const probe = await open(path, 'r'), prototype = Object.getPrototypeOf(probe), original = prototype.readFile;
  await probe.close();
  let mutated = false;
  prototype.readFile = async function (...args) {
    const data = await original.apply(this, args);
    if (!mutated && Buffer.isBuffer(data) && data.equals(source.chunkData)) {
      mutated = true; await writeFile(join(source.root, `${source.prefix}.fwl2`), concat(source.world, u8(0)));
    }
    return data;
  };
  try { await assert.rejects(readCompletedSnapshot(source.root), /Inputs changed during read/); assert.equal(mutated, true); }
  finally { prototype.readFile = original; }
});

test('only an exact completed generation is selected, never a newer unfinished generation', async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, '_main.8.chunks'), Buffer.alloc(0));
  await writeFile(join(root, '_main.999.ok.partial'), u32(999));
  assert.equal((await readCompletedSnapshot(root)).manifest.generation, 7);
  await writeFile(join(root, '_main.8.ok'), u32(8));
  await assert.rejects(readCompletedSnapshot(root), /Truncated/);
});

test('discovery returns multiple exact UIDs without guessing by save modification time', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vrm-snapshot-discovery-')); t.after(() => rm(root, { recursive: true, force: true }));
  const older = await fixture(t, { folder: join(root, 'older'), uid: -9223372036854775808n, name: 'Явный мир A' });
  const newer = await fixture(t, { folder: join(root, 'newer'), uid: 7n, name: 'Явный мир B', generation: 9 });
  await utimes(join(newer.root, `${newer.prefix}.ok`), new Date(), new Date());
  const before = await fingerprints(older.root), found = await discoverCompletedWorlds([root, older.root, join(root, 'missing')]);
  assert.deepEqual(new Set(found.map(candidate => candidate.worldId)), new Set(['-9223372036854775808', '7']));
  assert.equal(found.length, 2); assert.equal(found.find(item => item.worldId === '7').worldName, 'Явный мир B');
  assert.deepEqual(await fingerprints(older.root), before);
  assert.ok(!JSON.stringify(found).includes('PRIVATE-'));
});

test('discovery skips unsupported, missing-chunk and malformed latest completed generations', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vrm-snapshot-rejected-')); t.after(() => rm(root, { recursive: true, force: true }));
  await fixture(t, { folder: join(root, 'unsupported'), worldVersion: 43 });
  const missing = await fixture(t, { folder: join(root, 'missing') }); await rm(join(missing.root, missing.chunkName));
  const changed = await fixture(t, { folder: join(root, 'latest-incomplete') }); await writeFile(join(changed.root, '_main.8.ok'), u32(8));
  assert.deepEqual(await discoverCompletedWorlds([root]), []);
});

test('discovery traversal is bounded and symlink sources are not followed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vrm-snapshot-bounds-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = await fixture(t, { folder: join(root, 'level-one', 'level-two') });
  assert.deepEqual(await discoverCompletedWorlds([root], { maxDepth: 1 }), []);
  assert.equal((await discoverCompletedWorlds([root], { maxDepth: 2 })).length, 1);
  assert.deepEqual(await discoverCompletedWorlds([root], { maxFolders: 1 }), []);
  const link = join(root, 'junction');
  await symlink(source.root, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await discoverCompletedWorlds([link]), []);
  await assert.rejects(readCompletedSnapshot(link), /regular directory/);
});

test('missing completion, noncanonical marker and unsafe generation fail closed', async t => {
  const source = await fixture(t); await rm(join(source.root, `${source.prefix}.ok`));
  await writeFile(join(source.root, '_main.007.ok'), u32(7));
  await assert.rejects(readCompletedSnapshot(source.root), /No completed generation/);
  await writeFile(join(source.root, '_main.9007199254740992.ok'), u32(0));
  await assert.rejects(readCompletedSnapshot(source.root), /safe integer range/);
});
