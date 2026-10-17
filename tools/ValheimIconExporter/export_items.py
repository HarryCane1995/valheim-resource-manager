"""Read-only installed Unity assets -> PRIVATE registry and authentic PNGs.

No game modules are executed and no game files are written. Requires a user's
own installation. Generated data is copyrighted game content, not source code.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import re
import struct
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ITEM_TYPES = dict(enumerate(["None", "Material", "Consumable", "OneHandedWeapon", "Bow", "Shield", "Helmet", "Chest"]))
ITEM_TYPES.update({9: "Ammo", 10: "Customization", 11: "Legs", 12: "Hands", 13: "Trophy", 14: "TwoHandedWeapon", 15: "Torch", 16: "Misc", 17: "Shoulder", 18: "Utility", 19: "Tool", 20: "Attach_Atgeir", 21: "Fish", 22: "TwoHandedWeaponLeft", 23: "AmmoNonEquipable", 24: "Trinket"})


def stable_hash(text):
    units = struct.unpack('<' + 'H' * (len(text.encode('utf-16-le')) // 2), text.encode('utf-16-le'))
    first = second = 5381
    for i, value in enumerate(units):
        if i % 2:
            second = ((second * 33) ^ value) & 0xffffffff
        else:
            first = ((first * 33) ^ value) & 0xffffffff
    result = (first + second * 1566083941) & 0xffffffff
    return result if result < 0x80000000 else result - 0x100000000


def cstring(stream):
    result = bytearray()
    while True:
        value = stream.read(1)
        if not value:
            raise ValueError('Truncated UnityFS string')
        if value == b'\0':
            return result.decode('utf-8')
        result.extend(value)
        if len(result) > 4096:
            raise ValueError('UnityFS string too long')


def bundle_nodes(path):
    """Read only UnityFS directory metadata, never decompress the asset payload."""
    with path.open('rb') as stream:
        if cstring(stream) != 'UnityFS':
            raise ValueError('Unsupported bundle signature')
        version, = struct.unpack('>I', stream.read(4))
        if version not in (6, 7, 8):
            raise ValueError('Unsupported UnityFS version')
        cstring(stream)
        cstring(stream)
        size, compressed, unpacked, flags = struct.unpack('>QIII', stream.read(20))
        if size != path.stat().st_size or unpacked > 64 * 1024 * 1024 or compressed > size:
            raise ValueError('Invalid UnityFS metadata size')
        if version >= 7:
            stream.seek((stream.tell() + 15) & ~15)
        if flags & 128:
            stream.seek(size - compressed)
        data = stream.read(compressed)
        compression = flags & 63
        if compression in (2, 3):
            import lz4.block
            data = lz4.block.decompress(data, uncompressed_size=unpacked)
        elif compression != 0:
            raise ValueError('Unsupported UnityFS metadata compression')
        if len(data) != unpacked:
            raise ValueError('Truncated UnityFS metadata')
        stream = io.BytesIO(data)
        stream.read(16)
        blocks, = struct.unpack('>I', stream.read(4))
        stream.seek(10 * blocks, 1)
        count, = struct.unpack('>I', stream.read(4))
        if count > 100000:
            raise ValueError('Invalid UnityFS directory count')
        result = []
        for _ in range(count):
            stream.read(20)
            result.append(cstring(stream))
        return result


def localization_tables(texts):
    tables = {'English': {}, 'Russian': {}}
    conflicts = set()
    # Main table first; updates then override only nonempty translations.
    for name, text in sorted(texts, key=lambda pair: (pair[0] != 'localization', pair[0])):
        rows = csv.reader(io.StringIO(text.lstrip('\ufeff')))
        try:
            header = next(rows)
        except StopIteration:
            continue
        columns = {language: header.index(language) for language in tables if language in header}
        for row in rows:
            if not row or not row[0].strip() or row[0].startswith('//'):
                continue
            key = row[0].strip().lstrip('$')
            for language, column in columns.items():
                if column < len(row) and row[column].strip():
                    value = row[column].strip()
                    old = tables[language].get(key)
                    if old and old != value:
                        conflicts.add((language, key))
                    tables[language][key] = value
    return tables, conflicts


def restore_canvas(image, width, height, offset_x=0, offset_y=0):
    """Sprite image is top-down; Unity textureRectOffset is bottom-left."""
    from PIL import Image
    width, height = round(width), round(height)
    if not 0 < width <= 2048 or not 0 < height <= 2048:
        raise ValueError('Sprite canvas outside safety limits')
    canvas = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    canvas.paste(image.convert('RGBA'), (round(offset_x), height - round(offset_y) - image.height))
    return canvas


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    temp.replace(path)


def file_hash(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def extract(game, output, game_version='UNKNOWN'):
    import UnityPy
    from UnityPy.classes import PPtr
    from UnityPy.helpers.TypeTreeGenerator import TypeTreeGenerator

    game, output = game.resolve(), output.resolve()
    if output == game or game in output.parents:
        raise ValueError('Output must be outside the game installation')
    base = game / 'valheim_Data'
    bundles = base / 'StreamingAssets' / 'SoftRef' / 'Bundles'
    manifest = (bundles.parent / 'manifest_extended').read_text(encoding='utf-8-sig')
    locations = re.findall(r' bundle: ([^\r\n]+)\s+path in bundle: ([^\r\n]+)', manifest)
    candidates = Counter(bundle.strip() for bundle, path in locations if '/Items/' in path and path.endswith('.prefab'))
    if not candidates:
        raise ValueError('No Item prefab bundle locations in SoftRef manifest')
    cab_index = {}
    unsupported = 0
    for path in sorted(bundles.iterdir()):
        if not path.is_file():
            continue
        try:
            for name in bundle_nodes(path):
                cab_index[name.lower()] = path
        except (ValueError, struct.error, EOFError):
            unsupported += 1
    initial = [bundles / name for name in candidates]
    initial += [base / 'resources.assets', base / 'globalgamemanagers.assets']
    source_hashes = {path.resolve(): file_hash(path) for path in initial}
    for path in [bundles.parent / 'manifest_extended', base / 'Managed' / 'assembly_valheim.dll']:
        source_hashes[path.resolve()] = file_hash(path)
    env = UnityPy.load(*(str(path) for path in initial))
    loaded = {path.resolve() for path in initial}

    def deref(pointer, asset):
        try:
            return PPtr(m_FileID=pointer['m_FileID'], m_PathID=pointer['m_PathID'], assetsfile=asset).deref()
        except (FileNotFoundError, KeyError):
            index = pointer['m_FileID'] - 1
            if index < 0 or index >= len(asset.externals):
                raise
            name = str(asset.externals[index].path).replace('\\', '/').split('/')[-1].lower()
            path = cab_index.get(name)
            if path is None:
                raise
            source_hashes[path.resolve()] = file_hash(path)
            env.load_file(str(path))
            loaded.add(path.resolve())
            return PPtr(m_FileID=pointer['m_FileID'], m_PathID=pointer['m_PathID'], assetsfile=asset).deref()

    script_cache = {}
    drops, databases = {}, []
    unity_version = next(asset.unity_version for asset in env.assets if hasattr(asset, 'unity_version'))
    generator = TypeTreeGenerator(unity_version)
    generator.load_local_dll_folder(str(base / 'Managed'))
    print('Reading serialized ItemDrop and ObjectDB definitions...', flush=True)
    for obj in list(env.objects):
        if obj.type.name != 'MonoBehaviour':
            continue
        raw = obj.get_raw_data()
        file_id, path_id = struct.unpack_from('<iq', raw, 16)
        if path_id == 0:
            continue
        key = (obj.assets_file.name, file_id, path_id)
        if key not in script_cache:
            script = deref({'m_FileID': file_id, 'm_PathID': path_id}, obj.assets_file).read()
            script_cache[key] = (script.m_ClassName, script.m_AssemblyName, script.m_Namespace)
        class_name, assembly, namespace = script_cache[key]
        if class_name not in ('ItemDrop', 'ObjectDB'):
            continue
        nodes = generator.get_nodes_up(assembly, (namespace + '.' if namespace else '') + class_name)
        if class_name == 'ObjectDB':
            databases.append((obj, obj.read_typetree(nodes=nodes)))
        else:
            go_file, go_id = struct.unpack_from('<iq', raw, 0)
            drops[(obj.assets_file.name, go_file, go_id)] = (obj, nodes)
    if len(databases) != 1:
        raise ValueError(f'Expected exactly one serialized ObjectDB, found {len(databases)}')
    db, db_data = databases[0]
    texts = []
    for obj in list(env.objects):
        if obj.type.name == 'TextAsset':
            text = obj.read()
            if text.m_Name.startswith('localization'):
                content = text.m_Script
                texts.append((text.m_Name, content.decode('utf-8-sig') if isinstance(content, bytes) else content))
    translations, conflicts = localization_tables(texts)
    items, invalid, duplicates, errors, icon_cache = {}, [], [], [], {}
    variant_count = variant_exported = missing_ru = missing_en = 0
    icon_dir = output / 'icons'
    icon_dir.mkdir(parents=True, exist_ok=True)

    def icon(pointer, asset):
        sprite_obj = deref(pointer, asset)
        key = (sprite_obj.assets_file.name, sprite_obj.path_id)
        if key in icon_cache:
            return icon_cache[key]
        sprite = sprite_obj.read()
        # Load external texture/atlas metadata only if referenced by this Sprite.
        if sprite.m_SpriteAtlas:
            atlas = deref({'m_FileID': sprite.m_SpriteAtlas.m_FileID, 'm_PathID': sprite.m_SpriteAtlas.m_PathID}, sprite.assets_file).read()
            atlas_data = next(value for key, value in atlas.m_RenderDataMap if key == sprite.m_RenderDataKey)
        else:
            atlas_data = sprite.m_RD
        if sprite.m_RD.texture:
            deref({'m_FileID': sprite.m_RD.texture.m_FileID, 'm_PathID': sprite.m_RD.texture.m_PathID}, sprite.assets_file)
        image = sprite.image
        rect, offset = sprite.m_Rect, atlas_data.textureRectOffset
        image = restore_canvas(image, rect.width, rect.height, offset.x, offset.y)
        buffer = io.BytesIO()
        image.save(buffer, format='PNG')
        content = buffer.getvalue()
        digest = hashlib.sha256(content).hexdigest()
        if len(content) > 512 * 1024:
            raise ValueError('PNG exceeds API limit')
        target = icon_dir / (digest + '.png')
        if not target.exists():
            target.write_bytes(content)
        result = {'key': digest, 'width': image.width, 'height': image.height, 'spriteName': sprite.m_Name}
        icon_cache[key] = result
        return result

    for index, pointer in enumerate(db_data['m_items']):
        prefab = None
        try:
            go = deref(pointer, db.assets_file)
            prefab = go.read().m_Name
            drop, nodes = drops[(go.assets_file.name, 0, go.path_id)]
            shared = drop.read_typetree(nodes=nodes)['m_itemData']['m_shared']
        except Exception as error:
            invalid.append({'index': index, 'prefab': prefab, 'reason': type(error).__name__})
            continue
        if prefab in items:
            duplicates.append(prefab)
            continue
        name = shared.get('m_name', '')
        language_names = [translations[language].get(name.lstrip('$'), '') if name.startswith('$') else name for language in ('Russian', 'English')]
        diagnostics = []
        if not language_names[0]:
            missing_ru += 1
            diagnostics.append('MISSING RUSSIAN LOCALIZATION')
        if not language_names[1]:
            missing_en += 1
            diagnostics.append('MISSING ENGLISH LOCALIZATION')
        if any((language, name.lstrip('$')) in conflicts for language in ('Russian', 'English')):
            diagnostics.append('LOCALIZATION CONFLICT')
        exported = []
        for variant, pointer in enumerate(shared.get('m_icons', [])):
            variant_count += 1
            try:
                exported.append({'variant': variant, **icon(pointer, drop.assets_file)})
                variant_exported += 1
            except Exception as error:
                errors.append({'prefab': prefab, 'variant': variant, 'reason': type(error).__name__})
        if not exported:
            diagnostics.append('MISSING ICON')
        fields = {'m_itemType': 'itemType', 'm_maxQuality': 'maxQuality', 'm_variants': 'variants', 'm_weight': 'weight', 'm_value': 'value', 'm_food': 'foodHealth', 'm_foodStamina': 'foodStamina', 'm_foodEitr': 'foodEitr', 'm_toolTier': 'toolTier', 'm_description': 'descriptionToken', 'm_name': 'nameToken'}
        metadata = {target: shared[source] for source, target in fields.items() if source in shared}
        metadata.update({target: bool(shared.get(source)) for source, target in [('m_questItem', 'questItem'), ('m_isDrink', 'isDrink'), ('m_teleportable', 'teleportable')]})
        metadata['buildPieces'] = bool(shared.get('m_buildPieces', {}).get('m_PathID'))
        metadata['itemTypeName'] = ITEM_TYPES.get(shared.get('m_itemType'), 'Unknown')
        metadata['iconVariants'] = exported
        metadata['modAttribution'] = 'UNKNOWN: static base installation; runtime mods not observed'
        items[prefab] = {'id': 'prefab:' + prefab, 'prefab': prefab, 'prefabHash': stable_hash(prefab), 'nameRu': language_names[0], 'nameEn': language_names[1], 'subcategory': metadata['itemTypeName'], 'maxStack': shared.get('m_maxStackSize'), 'iconKey': exported[0]['key'] if exported else None, 'source': {'kind': 'installed-assets', 'exporter': 'ValheimIconExporter', 'version': '0.2.0'}, 'metadata': metadata, 'diagnostics': diagnostics}
    hashes = Counter(item['prefabHash'] for item in items.values())
    coverage = {'definitionsFound': len(db_data['m_items']), 'registered': len(items), 'scope': 'installed-assets', 'runtimeVerified': False, 'recognizedItemDrops': len(items), 'itemDropDefinitionsFound': len(drops), 'invalidObjectDbEntries': len(invalid), 'unresolvedObjectDbReferences': len(invalid), 'duplicateIds': len(duplicates), 'hashCollisions': sum(count > 1 for count in hashes.values()), 'itemsWithIcons': sum(bool(item['iconKey']) for item in items.values()), 'iconVariantsFound': variant_count, 'iconVariantsExported': variant_exported, 'missingRussian': missing_ru, 'missingEnglish': missing_en, 'missingIcons': sum(not item['iconKey'] for item in items.values()), 'assetsScanned': len(loaded), 'complete': len(items) == len(db_data['m_items']) and not invalid and not duplicates, 'limitations': ['Static serialized ObjectDB from installed assets; runtime mod additions are not verified.', 'Internal NPC/effect definitions are retained, including entries with no icon.', 'Localization tables merged deterministically; conflicting nonempty translations are diagnosed.', 'Game images are local-only; extraction grants no redistribution permission.']}
    result = {'schemaVersion': 1, 'gameVersion': game_version, 'generatedAt': datetime.now(timezone.utc).isoformat(), 'source': {'kind': 'installed-assets', 'exporter': 'ValheimIconExporter', 'version': '0.2.0', 'assetFormat': unity_version, 'method': 'UnityPy serialized ObjectDB/ItemDrop; local-only'}, 'items': sorted(items.values(), key=lambda item: item['prefab']), 'coverage': coverage}
    changed = [path.name for path, digest in source_hashes.items() if file_hash(path) != digest]
    if changed:
        raise ValueError('Source files changed during extraction; registry not replaced')
    write_json(output / 'registry' / 'items.json', result)
    report = {'coverage': coverage, 'uniquePngFiles': len({variant['key'] for item in items.values() for variant in item['metadata']['iconVariants']}), 'invalidEntries': invalid, 'duplicatePrefabs': duplicates, 'iconErrors': errors, 'localizationConflicts': len(conflicts), 'localizationTables': len(texts), 'unsupportedBundleHeaders': unsupported, 'sourceFilesVerified': len(source_hashes), 'sourceFilesUnchanged': True}
    write_json(output / 'registry' / 'extraction-report.json', report)
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--game', type=Path, required=True, help='Directory containing valheim_Data')
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[2] / 'localdata')
    parser.add_argument('--game-version', default='UNKNOWN', help='Version independently read from the game; never inferred from Unity version')
    arguments = parser.parse_args()
    extract(arguments.game, arguments.output, arguments.game_version)
