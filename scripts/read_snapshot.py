"""Read-only, version-gated Valheim 1.0.20 snapshot importer. Never opens a game file for writing."""
from __future__ import annotations
import argparse, collections, datetime as dt, hashlib, json, math, pathlib, struct, urllib.request

class Reader:
    def __init__(self, data: bytes): self.data, self.pos = data, 0
    def take(self, n):
        if n < 0 or self.pos + n > len(self.data): raise ValueError('Truncated or invalid package')
        b = self.data[self.pos:self.pos+n]; self.pos += n; return b
    def read(self, fmt): return struct.unpack('<'+fmt, self.take(struct.calcsize('<'+fmt)))[0]
    def count(self):
        b = self.read('B'); return ((b & 127) << 8) | self.read('B') if b & 128 else b
    def string(self):
        n = shift = 0
        for _ in range(5):
            b = self.read('B')
            if shift == 28 and b > 7: raise ValueError('Invalid .NET signed string length')
            n |= (b & 127) << shift
            if not b & 128: return self.take(n).decode('utf-8', errors='strict')
            shift += 7
        raise ValueError('Invalid .NET string')
    def array(self): return self.take(self.read('i'))
    def end(self):
        if self.pos != len(self.data): raise ValueError(f'Unconsumed package bytes: {len(self.data)-self.pos}')

def stable_hash(value):
    a = b = 5381
    for i in range(0, len(value), 2):
        a = ((a << 5) + a) ^ ord(value[i]); a &= 0xffffffff
        if i+1 < len(value): b = (((b << 5) + b) ^ ord(value[i+1])) & 0xffffffff
    n = (a + b * 1566083941) & 0xffffffff
    return n if n < 0x80000000 else n - 0x100000000

CONTAINERS = {stable_hash(p): (p, name) for p, name in [
    ('piece_chest_wood', 'Деревянный сундук'), ('piece_chest', 'Укреплённый сундук'),
    ('piece_chest_blackmetal', 'Сундук из чёрного металла'), ('piece_chest_private', 'Личный сундук')
]}
# Only exact known prefab hashes receive a name; unresolved hashes are preserved explicitly.
ITEM_GROUPS = [
    ('Древесина', [('Wood','Древесина'),('RoundLog','Цельная древесина'),('FineWood','Качественная древесина'),('ElderBark','Древняя кора'),('YggdrasilWood','Древесина Иггдрасиля')]),
    ('Камень и строительство', [('Stone','Камень'),('Coal','Уголь'),('Flint','Кремень'),('Obsidian','Обсидиан'),('BlackMarble','Чёрный мрамор'),('Resin','Смола'),('Tar','Дёготь'),('SurtlingCore','Ядро суртлинга')]),
    ('Металлы и руда', [('Copper','Медь'),('CopperOre','Медная руда'),('Tin','Олово'),('TinOre','Оловянная руда'),('Bronze','Бронза'),('Iron','Железо'),('IronScrap','Металлолом'),('Silver','Серебро'),('SilverOre','Серебряная руда'),('BlackMetal','Чёрный металл'),('BlackMetalScrap','Лом чёрного металла'),('Flametal','Пламенный металл'),('FlametalOre','Пламенная руда')]),
    ('Еда и ингредиенты', [('Raspberry','Малина'),('Blueberries','Черника'),('Cloudberry','Морошка'),('Mushroom','Гриб'),('MushroomYellow','Жёлтый гриб'),('Honey','Мёд'),('RawMeat','Сырое мясо'),('DeerMeat','Оленина'),('NeckTail','Хвост никса'),('FishRaw','Сырая рыба'),('CookedMeat','Приготовленное мясо'),('CookedDeerMeat','Приготовленная оленина'),('Entrails','Кишки'),('Bloodbag','Мешок с кровью'),('Sausages','Колбаски'),('Carrot','Морковь'),('Turnip','Репа'),('Onion','Лук'),('BarleyFlour','Ячменная мука')]),
    ('Растения и семена', [('CarrotSeeds','Семена моркови'),('TurnipSeeds','Семена репы'),('OnionSeeds','Семена лука'),('Barley','Ячмень'),('Flax','Лён'),('Dandelion','Одуванчик'),('Thistle','Чертополох'),('BeechSeeds','Семена бука'),('FirCone','Еловая шишка'),('PineCone','Сосновая шишка')]),
    ('Ценности', [('Coins','Монеты'),('Amber','Янтарь'),('AmberPearl','Янтарная жемчужина'),('Ruby','Рубин'),('SilverNecklace','Серебряное ожерелье')]),
    ('Прочее', [('LeatherScraps','Обрывки кожи'),('DeerHide','Оленья шкура'),('WolfPelt','Волчья шкура'),('Feathers','Перья'),('BoneFragments','Обломки костей'),('GreydwarfEye','Глаз грейдворфа'),('Guck','Жижа'),('Ooze','Слизь'),('Chitin','Хитин'),('LinenThread','Льняная нить'),('Chain','Цепь'),('FreezeGland','Морозная железа')]),
    ('Трофеи', [('TrophyBoar','Трофей кабана'),('TrophyDeer','Трофей оленя'),('TrophyNeck','Трофей никса'),('TrophyGreydwarf','Трофей грейдворфа'),('TrophyTroll','Трофей тролля'),('TrophySkeleton','Трофей скелета')]),
]
ITEMS = {stable_hash(prefab): (prefab, name, group) for group, rows in ITEM_GROUPS for prefab, name in rows}

def parse_inventory(data):
    r = Reader(data); version = r.read('i')
    if version not in (108,109,110): raise ValueError(f'Unsupported inventory version {version}; expected 108-110')
    count = r.read('H'); result = []
    for _ in range(count):
        r.take(7); flags = r.read('B') # durability int, grid x/y, world-level
        if flags & 4: r.take(2)
        quantity = r.read('H') if flags & 8 else 1
        if flags & 16: r.take(4)
        if flags & 32: r.take(8); r.string()
        h = r.read('i') if flags & 64 else 0
        if flags & 128:
            for _ in range(r.count()): r.string(); r.string()
        if version >= 109: r.take(1) # ChunksNCheats/NewCheats byte
        if not h: raise ValueError('Inventory item missing prefab hash')
        prefab, name, category = ITEMS.get(h, (f'hash:{h}', f'Предмет #{h} (не распознан)', 'Прочее'))
        result.append(dict(prefab=prefab, name=name, category=category, quantity=quantity))
    r.end(); return result

def parse_chunk(data):
    r = Reader(data); version, count = r.read('h'), r.read('i')
    if version not in (40,41,42): raise ValueError(f'Unsupported chunk world version {version}; expected 40-42')
    if not 0 <= count <= 2000000: raise ValueError('Invalid ZDO count')
    for _ in range(count):
        flags = r.read('H')
        if flags & ~0x3fff: raise ValueError('Unknown ZDO flags; refusing newer format')
        if flags & 0x2000: x, y, z = r.read('h'), 0., r.read('h')
        else: x, y, z = r.read('f'), r.read('f'), r.read('f')
        if not all(math.isfinite(c) for c in (x,y,z)): raise ValueError('Nonfinite position')
        prefab_hash = r.read('i')
        if flags & 0x1000:
            first = r.read('H')
            if not first & 0x8000: r.take(2)
        if flags & 1: r.take(5)
        inventory = None
        for bit, size in [(2,4),(4,12),(8,16),(16,4),(32,8),(64,None),(128,None)]:
            if flags & bit:
                for _ in range(r.count()):
                    key = r.read('i')
                    value = r.string() if bit == 64 else r.array() if bit == 128 else r.take(size)
                    if bit == 128 and key == stable_hash('items'): inventory = value
        yield (prefab_hash, (x,y,z), inventory)
    r.end()

def read_snapshot(folder: pathlib.Path, output: pathlib.Path, retain_bytes=True):
    completed = sorted((int(p.name.split('.')[1]) for p in folder.glob('_main.*.ok')), reverse=True)
    if not completed: raise ValueError('No completed generation (.ok) found')
    generation = completed[0]; prefix = f'_main.{generation}'
    meta = (folder / (prefix+'.chunks')).read_bytes(); r = Reader(meta)
    if r.read('H') != 42: raise ValueError('Unsupported chunks mapping version')
    expected_zdos, num_chunks = r.read('i'), r.read('i')
    if not 0 <= expected_zdos <= 20_000_000: raise ValueError('Invalid total ZDO count')
    if not 0 <= num_chunks <= 100000: raise ValueError('Invalid chunk mapping')
    chunks = []; chunk_keys = set()
    for _ in range(num_chunks):
        index, size, rev, n = r.read('H'), r.read('B'), r.read('I'), r.read('i')
        if not 0 <= size <= 3 or not 0 <= n <= 2_000_000: raise ValueError('Invalid chunk size or ZDO count')
        if (index,size) in chunk_keys: raise ValueError('Duplicate chunk mapping entry')
        chunk_keys.add((index,size))
        chunks.append((f'{index >> 8:02x}_{index & 255:02x}__{size}_{rev}.chunk', n))
    r.end()
    fwl_data = (folder / (prefix+'.fwl2')).read_bytes(); fwl = Reader(fwl_data)
    f = Reader(fwl.array()); fwl.end()
    if f.read('i') != 42: raise ValueError('Unsupported world metadata version')
    world_name = f.string(); f.string(); f.read('i'); world_id = str(f.read('q'))
    f.read('i') # worldGenVersion
    if f.read('B') not in (0,1): raise ValueError('Invalid needsDB boolean')
    keys = f.read('i')
    if not 0 <= keys <= 100000: raise ValueError('Invalid global-key count')
    for _ in range(keys): f.string()
    history = f.read('i')
    if not 0 <= history <= 100000: raise ValueError('Invalid player-history count')
    for _ in range(history):
        for _ in range(4): f.string() # private user fields are discarded, never exposed
    f.end()
    if len((folder/(prefix+'.ok')).read_bytes()) != 4: raise ValueError('Invalid completion marker')
    observed = dt.datetime.fromtimestamp((folder/(prefix+'.ok')).stat().st_mtime, dt.timezone.utc).isoformat()
    # Copy bytes and hash all inputs before import. Only output/ receives new files.
    output.mkdir(parents=True, exist_ok=False)
    files = [prefix+'.chunks', prefix+'.fwl2', prefix+'.ok'] + [n for n,_ in chunks]
    hashes = {}; data_by_name = {}
    for filename in files:
        data = (folder/filename).read_bytes()
        if retain_bytes: (output/filename).write_bytes(data)
        hashes[filename] = hashlib.sha256(data).hexdigest()
        data_by_name[filename] = data
    if data_by_name[prefix+'.chunks'] != meta or data_by_name[prefix+'.fwl2'] != fwl_data:
        raise ValueError('Metadata changed while snapshotting; retry')
    containers = []; seen = set(); total_zdos = unknown_candidates = unknown_items = 0
    for filename, expected_count in chunks:
        chunk_count = 0
        for h, pos, inv in parse_chunk(data_by_name[filename]):
            total_zdos += 1; chunk_count += 1
            if h not in CONTAINERS:
                if inv is not None: unknown_candidates += 1
                continue
            prefab, name = CONTAINERS[h]; x,y,z = pos
            key = 'pos-v1:'+str(h)+':'+':'.join(f'{struct.unpack("<I",struct.pack("<f",v))[0]:08x}' for v in pos)
            if key in seen: raise ValueError('Ambiguous duplicate chest prefab and exact position; refusing import')
            seen.add(key)
            items = parse_inventory(inv) if inv else []
            unknown_items += sum(i['quantity'] for i in items if i['prefab'].startswith('hash:'))
            containers.append(dict(id='snapshot:'+key,identityKey=key,type=prefab,name=name,x=x,y=y,z=z,items=items,observedAt=observed))
        if chunk_count != expected_count: raise ValueError('Chunk ZDO count differs from mapping')
    if total_zdos != expected_zdos: raise ValueError('Total ZDO count differs from completed mapping')
    unchanged = all(hashlib.sha256((folder/n).read_bytes()).hexdigest() == h for n,h in hashes.items())
    if not unchanged: raise ValueError('Inputs changed during read; refusing import')
    manifest = dict(generation=generation,worldId=world_id,worldName=world_name,observedAt=observed,chunks=len(chunks),zdos=total_zdos,containers=len(containers),unknownInventoryObjects=unknown_candidates,unresolvedItemUnits=unknown_items,sourceUnchangedDuringRead=True,sha256=hashes)
    payload = dict(sourceId='save-snapshot',worldId=world_id,worldName=world_name,mode='snapshot',coverage='partial',sessionId=f'snapshot-{generation}',sequence=1,gameVersion='1.0.20 / world42 / inventory108-110',containers=containers,destroyedIds=[])
    (output/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    (output/'payload.json').write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding='utf-8')
    return payload, manifest

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--world-folder',required=True,type=pathlib.Path)
    parser.add_argument('--output',required=True,type=pathlib.Path)
    parser.add_argument('--import-url',default=None)
    parser.add_argument('--token-file',type=pathlib.Path)
    args = parser.parse_args()
    payload, manifest = read_snapshot(args.world_folder.resolve(), args.output.resolve())
    if args.import_url:
        if args.import_url != 'http://127.0.0.1:37841/api/snapshot': raise ValueError('Only fixed local snapshot endpoint supported')
        if not args.token_file: raise ValueError('--token-file required')
        request = urllib.request.Request(args.import_url,data=json.dumps(payload).encode(),headers={'Content-Type':'application/json','X-VRM-Token':args.token_file.read_text().strip()})
        with urllib.request.urlopen(request,timeout=20) as response: response.read()
        manifest['imported'] = True
    print(json.dumps({k:v for k,v in manifest.items() if k != 'sha256'},ensure_ascii=False,indent=2))
