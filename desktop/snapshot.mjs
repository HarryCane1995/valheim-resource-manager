/** Read-only adapter for audited Valheim 1.0.20 completed save generations.
 * No game file is opened for writing; private payloads stay with the caller.
 */
import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { RUSSIAN_ITEM_NAMES } from '../server/catalog.mjs';

const GAME_VERSION = '1.0.20 / world42 / inventory108-110';
const utf8 = new TextDecoder('utf-8', { fatal: true });
const completionName = /^_main\.(0|[1-9]\d*)\.ok$/;
const invalid = message => new Error(message);
const sha256 = data => createHash('sha256').update(data).digest('hex');

class Reader {
  constructor(data) { this.data = data; this.pos = 0; }
  take(length) {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.data.length - this.pos) throw invalid('Truncated or invalid package');
    const result = this.data.subarray(this.pos, this.pos + length); this.pos += length; return result;
  }
  u8() { return this.take(1).readUInt8(); }
  u16() { return this.take(2).readUInt16LE(); }
  i16() { return this.take(2).readInt16LE(); }
  u32() { return this.take(4).readUInt32LE(); }
  i32() { return this.take(4).readInt32LE(); }
  i64() { return this.take(8).readBigInt64LE(); }
  f32() { return this.take(4).readFloatLE(); }
  count() { const first = this.u8(); return first & 128 ? ((first & 127) << 8) | this.u8() : first; }
  string() {
    let length = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      const byte = this.u8();
      if (shift === 28 && byte > 7) throw invalid('Invalid .NET signed string length');
      length += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return utf8.decode(this.take(length));
    }
    throw invalid('Invalid .NET string');
  }
  array() { return this.take(this.i32()); }
  end() { if (this.pos !== this.data.length) throw invalid(`Unconsumed package bytes: ${this.data.length - this.pos}`); }
}

function stableHash(value) {
  let a = 5381, b = 5381;
  for (let index = 0; index < value.length; index += 2) {
    a = (Math.imul(a, 33) ^ value.charCodeAt(index)) | 0;
    if (index + 1 < value.length) b = (Math.imul(b, 33) ^ value.charCodeAt(index + 1)) | 0;
  }
  return (a + Math.imul(b, 1566083941)) | 0;
}

const containersByHash = new Map([
  ['piece_chest_wood', 'Деревянный сундук'], ['piece_chest', 'Укреплённый сундук'],
  ['piece_chest_blackmetal', 'Сундук из чёрного металла'], ['piece_chest_private', 'Личный сундук'],
].map(([prefab, name]) => [stableHash(prefab), { prefab, name }]));
// Keep the same conservative item whitelist as scripts/read_snapshot.py.
const itemGroups = [
  ['Древесина', 'Wood RoundLog FineWood ElderBark YggdrasilWood'],
  ['Камень и строительство', 'Stone Coal Flint Obsidian BlackMarble Resin Tar SurtlingCore'],
  ['Металлы и руда', 'Copper CopperOre Tin TinOre Bronze Iron IronScrap Silver SilverOre BlackMetal BlackMetalScrap Flametal FlametalOre'],
  ['Еда и ингредиенты', 'Raspberry Blueberries Cloudberry Mushroom MushroomYellow Honey RawMeat DeerMeat NeckTail FishRaw CookedMeat CookedDeerMeat Entrails Bloodbag Sausages Carrot Turnip Onion BarleyFlour'],
  ['Растения и семена', 'CarrotSeeds TurnipSeeds OnionSeeds Barley Flax Dandelion Thistle BeechSeeds FirCone PineCone'],
  ['Ценности', 'Coins Amber AmberPearl Ruby SilverNecklace'],
  ['Прочее', 'LeatherScraps DeerHide WolfPelt Feathers BoneFragments GreydwarfEye Guck Ooze Chitin LinenThread Chain FreezeGland'],
  ['Трофеи', 'TrophyBoar TrophyDeer TrophyNeck TrophyGreydwarf TrophyTroll TrophySkeleton'],
];
const itemsByHash = new Map(itemGroups.flatMap(([category, prefabs]) => prefabs.split(' ').map(prefab =>
  [stableHash(prefab), { prefab, name: RUSSIAN_ITEM_NAMES[prefab], category }])));
const itemsHash = stableHash('items');

function parseInventory(data) {
  const r = new Reader(data), version = r.i32();
  if (![108, 109, 110].includes(version)) throw invalid(`Unsupported inventory version ${version}; expected 108-110`);
  const count = r.u16(), items = [];
  for (let index = 0; index < count; index++) {
    r.take(7); const flags = r.u8();
    if (flags & 4) r.take(2);
    const quantity = flags & 8 ? r.u16() : 1;
    if (flags & 16) r.take(4);
    if (flags & 32) { r.take(8); r.string(); }
    const hash = flags & 64 ? r.i32() : 0;
    if (flags & 128) { const fields = r.count(); for (let field = 0; field < fields; field++) { r.string(); r.string(); } }
    if (version >= 109) r.take(1);
    if (!hash) throw invalid('Inventory item missing prefab hash');
    const definition = itemsByHash.get(hash) || { prefab: `hash:${hash}`, name: `Предмет #${hash} (не распознан)`, category: 'Прочее' };
    items.push({ ...definition, quantity });
  }
  r.end(); return items;
}

function* parseChunk(data) {
  const r = new Reader(data), version = r.i16(), count = r.i32();
  if (![40, 41, 42].includes(version)) throw invalid(`Unsupported chunk world version ${version}; expected 40-42`);
  if (count < 0 || count > 2_000_000) throw invalid('Invalid ZDO count');
  for (let index = 0; index < count; index++) {
    const flags = r.u16();
    if (flags & ~0x3fff) throw invalid('Unknown ZDO flags; refusing newer format');
    const position = flags & 0x2000 ? [r.i16(), 0, r.i16()] : [r.f32(), r.f32(), r.f32()];
    if (!position.every(Number.isFinite)) throw invalid('Nonfinite position');
    const hash = r.i32();
    if (flags & 0x1000) { const first = r.u16(); if (!(first & 0x8000)) r.take(2); }
    if (flags & 1) r.take(5);
    let inventory = null;
    for (const [bit, size] of [[2, 4], [4, 12], [8, 16], [16, 4], [32, 8], [64, null], [128, null]]) {
      if (!(flags & bit)) continue;
      const fields = r.count();
      for (let field = 0; field < fields; field++) {
        const key = r.i32();
        const value = bit === 64 ? r.string() : bit === 128 ? r.array() : r.take(size);
        if (bit === 128 && key === itemsHash) inventory = value;
      }
    }
    yield { hash, position, inventory };
  }
  r.end();
}

function parseMapping(data) {
  const r = new Reader(data);
  if (r.u16() !== 42) throw invalid('Unsupported chunks mapping version');
  const expectedZdos = r.i32(), count = r.i32();
  if (expectedZdos < 0 || expectedZdos > 20_000_000) throw invalid('Invalid total ZDO count');
  if (count < 0 || count > 100_000) throw invalid('Invalid chunk mapping');
  const chunks = [], seen = new Set();
  for (let index = 0; index < count; index++) {
    const chunkIndex = r.u16(), size = r.u8(), revision = r.u32(), zdos = r.i32();
    if (size > 3 || zdos < 0 || zdos > 2_000_000) throw invalid('Invalid chunk size or ZDO count');
    const key = `${chunkIndex}:${size}`;
    if (seen.has(key)) throw invalid('Duplicate chunk mapping entry');
    seen.add(key);
    const hex = value => value.toString(16).padStart(2, '0');
    chunks.push({ filename: `${hex(chunkIndex >> 8)}_${hex(chunkIndex & 255)}__${size}_${revision}.chunk`, zdos });
  }
  r.end(); return { expectedZdos, chunks };
}

function parseWorld(data) {
  const wrapper = new Reader(data), r = new Reader(wrapper.array()); wrapper.end();
  if (r.i32() !== 42) throw invalid('Unsupported world metadata version');
  const worldName = r.string(); r.string(); r.i32();
  const worldId = r.i64().toString();
  r.i32();
  if (r.u8() > 1) throw invalid('Invalid needsDB boolean');
  const keys = r.i32();
  if (keys < 0 || keys > 100_000) throw invalid('Invalid global-key count');
  for (let index = 0; index < keys; index++) r.string();
  const history = r.i32();
  if (history < 0 || history > 100_000) throw invalid('Invalid player-history count');
  // Player metadata is deliberately discarded and never returned to the UI.
  for (let index = 0; index < history; index++) for (let field = 0; field < 4; field++) r.string();
  r.end(); return { worldId, worldName };
}

function generationFromEntries(entries) {
  const generations = entries.filter(entry => entry.isFile() && completionName.test(entry.name))
    .map(entry => BigInt(completionName.exec(entry.name)[1]));
  if (!generations.length) throw invalid('No completed generation (.ok) found');
  const latest = generations.reduce((a, b) => a > b ? a : b);
  if (latest > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid('Completed generation exceeds safe integer range');
  return Number(latest);
}

const sameStat = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
async function readInput(folder, filename, receipts) {
  const path = join(folder, filename), pathStat = await lstat(path, { bigint: true });
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) throw invalid('Snapshot input must be a regular file');
  const handle = await open(path, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (!sameStat(pathStat, before)) throw invalid('Inputs changed during read; refusing import');
    const data = await handle.readFile(), after = await handle.stat({ bigint: true });
    if (!sameStat(before, after) || BigInt(data.length) !== before.size) throw invalid('Inputs changed during read; refusing import');
    const digest = sha256(data), previous = receipts.get(filename);
    if (previous && (!sameStat(previous.stat, after) || previous.sha256 !== digest)) throw invalid('Inputs changed during read; refusing import');
    receipts.set(filename, { sha256: digest, stat: after });
    return data;
  } finally { await handle.close(); }
}

async function readMetadata(folder, entries = null) {
  const stat = await lstat(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid('Snapshot source must be a regular directory');
  const listing = entries || await readdir(folder, { withFileTypes: true });
  const generation = generationFromEntries(listing), prefix = `_main.${generation}`, receipts = new Map();
  const mapping = parseMapping(await readInput(folder, `${prefix}.chunks`, receipts));
  const world = parseWorld(await readInput(folder, `${prefix}.fwl2`, receipts));
  const marker = await readInput(folder, `${prefix}.ok`, receipts);
  if (marker.length !== 4) throw invalid('Invalid completion marker');
  const observedAt = new Date(Number(receipts.get(`${prefix}.ok`).stat.mtimeNs / 1_000_000n)).toISOString();
  return { generation, prefix, receipts, ...mapping, ...world, observedAt };
}

async function verifyReceipts(folder, receipts) {
  for (const filename of [...receipts.keys()]) await readInput(folder, filename, receipts);
}

/** Discover candidates only. The caller must select a UID explicitly; no mtime guessing.
 * Traversal is bounded and skips symlinks/junctions. Chunk contents are validated on import.
 */
export async function discoverCompletedWorlds(roots, { maxDepth = 3, maxFolders = 2000 } = {}) {
  if (!Array.isArray(roots) || roots.some(root => typeof root !== 'string')) throw new TypeError('Snapshot roots must be an array of directory paths');
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 10 || !Number.isInteger(maxFolders) || maxFolders < 1 || maxFolders > 100_000) throw new TypeError('Invalid snapshot discovery bounds');
  const candidates = [], visited = new Set(), queue = roots.map(folder => ({ folder: resolve(folder), depth: 0 }));
  for (let cursor = 0; cursor < queue.length && visited.size < maxFolders; cursor++) {
    const { folder, depth } = queue[cursor];
    let entries;
    try {
      const stat = await lstat(folder);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      const canonical = await realpath(folder), key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
      if (visited.has(key)) continue;
      visited.add(key);
      entries = await readdir(folder, { withFileTypes: true });
    } catch { continue; }
    if (entries.some(entry => entry.isFile() && completionName.test(entry.name))) {
      try {
        const metadata = await readMetadata(folder, entries);
        const files = new Set(entries.filter(entry => entry.isFile() && !entry.isSymbolicLink()).map(entry => entry.name));
        if (!metadata.chunks.every(chunk => files.has(chunk.filename))) throw invalid('Missing completed chunk');
        await verifyReceipts(folder, metadata.receipts);
        candidates.push({ folder, worldId: metadata.worldId, worldName: metadata.worldName, generation: metadata.generation, observedAt: metadata.observedAt, gameVersion: GAME_VERSION });
      } catch { /* Unsupported or incomplete candidates are never selected implicitly. */ }
    }
    if (depth < maxDepth) for (const entry of entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).sort((a, b) => a.name.localeCompare(b.name))) {
      if (queue.length >= maxFolders) break;
      queue.push({ folder: join(folder, entry.name), depth: depth + 1 });
    }
  }
  return candidates;
}

/** Import the latest completed generation. All parsing is version gated; source bytes
 * and file identity/timestamps are checked again before any payload is returned.
 */
export async function readCompletedSnapshot(folder) {
  folder = resolve(folder);
  const metadata = await readMetadata(folder), containers = [], identities = new Set();
  let totalZdos = 0, unknownInventoryObjects = 0, unresolvedItemUnits = 0;
  for (const { filename, zdos } of metadata.chunks) {
    const data = await readInput(folder, filename, metadata.receipts);
    let count = 0;
    for (const { hash, position, inventory } of parseChunk(data)) {
      count++; totalZdos++;
      const definition = containersByHash.get(hash);
      if (!definition) { if (inventory !== null) unknownInventoryObjects++; continue; }
      const bits = position.map(value => { const bytes = Buffer.allocUnsafe(4); bytes.writeFloatLE(value); return bytes.readUInt32LE().toString(16).padStart(8, '0'); });
      const identityKey = `pos-v1:${hash}:${bits.join(':')}`;
      if (identities.has(identityKey)) throw invalid('Ambiguous duplicate chest prefab and exact position; refusing import');
      identities.add(identityKey);
      const items = inventory?.length ? parseInventory(inventory) : [];
      unresolvedItemUnits += items.filter(item => item.prefab.startsWith('hash:')).reduce((sum, item) => sum + item.quantity, 0);
      const [x, y, z] = position;
      containers.push({ id: `snapshot:${identityKey}`, identityKey, type: definition.prefab, name: definition.name, x, y, z, items, observedAt: metadata.observedAt });
    }
    if (count !== zdos) throw invalid('Chunk ZDO count differs from mapping');
  }
  if (totalZdos !== metadata.expectedZdos) throw invalid('Total ZDO count differs from completed mapping');
  await verifyReceipts(folder, metadata.receipts);
  const manifest = { generation: metadata.generation, worldId: metadata.worldId, worldName: metadata.worldName, observedAt: metadata.observedAt, chunks: metadata.chunks.length, zdos: totalZdos, containers: containers.length, unknownInventoryObjects, unresolvedItemUnits, sourceUnchangedDuringRead: true, sha256: Object.fromEntries([...metadata.receipts].map(([filename, receipt]) => [filename, receipt.sha256])) };
  const payload = { sourceId: 'save-snapshot', worldId: metadata.worldId, worldName: metadata.worldName, mode: 'snapshot', coverage: 'partial', sessionId: `snapshot-${metadata.generation}`, sequence: 1, gameVersion: GAME_VERSION, containers, destroyedIds: [] };
  return { payload, manifest };
}
