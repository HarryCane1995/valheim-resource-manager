"""Synthetic byte fixtures derived from the installed 1.0.20 decompiled serializers.

These tests never open an installed game file. They test save-format boundaries,
not the completeness of a running world's inventory or its in-game behaviour.
"""
import hashlib
import pathlib
import struct
import tempfile
import unittest

import read_snapshot as snapshot


def pack(fmt, *values):
    return struct.pack('<' + fmt, *values)


def dotnet_string(value):
    data = value.encode('utf-8')
    count = len(data)
    prefix = bytearray()
    while count >= 128:
        prefix.append((count & 127) | 128)
        count >>= 7
    return bytes(prefix) + bytes([count]) + data


def num_items(value):
    return bytes([value]) if value < 128 else bytes([(value >> 8) | 128, value & 255])


def inventory(version=110, quantity=40, prefab_hash=None, all_flags=False):
    """ItemDrop.ItemData.Save: durability/grid/world, flags, optional values."""
    if prefab_hash is None:
        prefab_hash = snapshot.stable_hash('Wood')
    flags = 0x40 | (8 if quantity != 1 else 0)
    if all_flags:
        flags |= 4 | 16 | 32 | 128 | 1 | 2
    data = pack('iH', version, 1) + pack('iBBBB', 10000, 1, 2, 0, flags)
    if flags & 4:
        data += pack('H', 3)
    if flags & 8:
        data += pack('H', quantity)
    if flags & 16:
        data += pack('i', 12)
    if flags & 32:
        data += pack('q', 9223372036854775807) + dotnet_string('Мастер')
    data += pack('i', prefab_hash)
    if flags & 128:
        data += num_items(2) + dotnet_string('mod:unknown') + dotnet_string('значение')
        data += dotnet_string('other') + dotnet_string('extra data')
    if version >= 109:
        data += b'\x01'
    return data


def record(prefab_hash=None, position=(1.25, -0.0, -20.5), inv=None, flags=0, generic=False, rotation=None):
    if prefab_hash is None:
        prefab_hash = snapshot.stable_hash('piece_chest_wood')
    if inv is not None:
        flags |= 128
    if generic:
        flags |= 1 | 2 | 4 | 8 | 16 | 32 | 64
    if rotation is not None:
        flags |= 0x1000
    data = pack('H', flags)
    data += pack('hh', position[0], position[2]) if flags & 0x2000 else pack('fff', *position)
    data += pack('i', prefab_hash)
    if rotation is not None:
        data += rotation
    if flags & 1:
        data += pack('Bi', 4, -1234)
    for bit, value in [(2, pack('f', 1.5)), (4, pack('fff', 2, 3, 4)),
                       (8, pack('ffff', 0, 0, 0, 1)), (16, pack('i', 88)),
                       (32, pack('q', 9223372036854775807)),
                       (64, dotnet_string('unrelated string'))]:
        if flags & bit:
            data += num_items(1) + pack('i', -998877) + value
    if flags & 128:
        data += num_items(2) + pack('i', snapshot.stable_hash('unknown-byte-field'))
        data += pack('i', 3) + b'abc'
        data += pack('ii', snapshot.stable_hash('items'), len(inv)) + inv
    return data


def chunk(*records, version=42):
    return pack('hi', version, len(records)) + b''.join(records)


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='vrm-snapshot-tests-')
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.source = self.root / 'source'
        self.source.mkdir()

    def fixture(self, records=None, mapping_version=42, world_version=42, tail=True, duplicate_mapping=False):
        records = records if records is not None else [record(inv=inventory())]
        data = chunk(*records)
        (self.source / '00_01__3_1.chunk').write_bytes(data)
        entries = 2 if duplicate_mapping else 1
        metadata = pack('Hii', mapping_version, len(records) * entries, entries)
        metadata += pack('HBIi', 1, 3, 1, len(records)) * entries
        (self.source / '_main.7.chunks').write_bytes(metadata)
        world = pack('i', world_version) + dotnet_string('Тестовый мир')
        world += dotnet_string('seed') + pack('iq', 42, 9223372036854775807)
        if tail:
            world += pack('iBii', 2, 1, 0, 0)  # worldGenVersion, needsDB, global keys, player history
        (self.source / '_main.7.fwl2').write_bytes(pack('i', len(world)) + world)
        (self.source / '_main.7.ok').write_bytes(pack('I', 7))

    def run_snapshot(self):
        return snapshot.read_snapshot(self.source, self.root / 'output')

    def test_inventory_108_109_110_all_optional_flags_have_correct_offsets(self):
        for version in (108, 109, 110):
            with self.subTest(version=version):
                items = snapshot.parse_inventory(inventory(version, all_flags=True))
                self.assertEqual(items[0]['prefab'], 'Wood')
                self.assertEqual(items[0]['quantity'], 40)
                self.assertEqual(items[0]['name'], 'Древесина')

    def test_inventory_single_stack_default_and_empty_inventory(self):
        self.assertEqual(snapshot.parse_inventory(inventory(quantity=1))[0]['quantity'], 1)
        self.assertEqual(snapshot.parse_inventory(pack('iH', 110, 0)), [])

    def test_inventory_109_and_110_require_trailing_cheat_byte(self):
        for version in (109, 110):
            with self.subTest(version=version), self.assertRaises(ValueError):
                snapshot.parse_inventory(inventory(version)[:-1])

    def test_inventory_unknown_hash_preserves_exact_quantity_and_identity(self):
        items = snapshot.parse_inventory(inventory(prefab_hash=-2147483601, quantity=123))
        self.assertEqual(items[0]['prefab'], 'hash:-2147483601')
        self.assertEqual(items[0]['quantity'], 123)
        self.assertIn('не распознан', items[0]['name'])

    def test_inventory_unsupported_versions_fail_closed(self):
        for version in (0, 107, 111, 999):
            with self.subTest(version=version), self.assertRaises(ValueError):
                snapshot.parse_inventory(pack('iH', version, 0))

    def test_inventory_count_truncation_trailing_bytes_and_missing_prefab_fail(self):
        for data in [pack('iH', 110, 65535), inventory()[:-2], inventory()+b'x',
                     pack('iH', 110, 1) + pack('iBBBBB', 1000, 0, 0, 0, 0, 0)]:
            with self.subTest(length=len(data)), self.assertRaises(ValueError):
                snapshot.parse_inventory(data)

    def test_chunk_40_41_42_and_generic_unknown_key_fields_preserve_inventory(self):
        for version in (40, 41, 42):
            with self.subTest(version=version):
                parsed = list(snapshot.parse_chunk(chunk(record(inv=inventory(), generic=True), version=version)))
                self.assertEqual(snapshot.parse_inventory(parsed[0][2])[0]['quantity'], 40)

    def test_chunk_small_position_and_both_small_rotation_encodings(self):
        for rotation in (pack('H', 0x8000 | 90), pack('HH', 0x0001, 0x0300)):
            with self.subTest(rotation=rotation):
                parsed = list(snapshot.parse_chunk(chunk(record(position=(-23, 0, 17), flags=0x2000, rotation=rotation))))
                self.assertEqual(parsed[0][1], (-23, 0.0, 17))

    def test_chunk_unsupported_version_count_bounds_truncation_and_nonfinite_position(self):
        data = [pack('hi', 39, 0), pack('hi', 43, 0), pack('hi', 42, -1),
                pack('hi', 42, 2000001), chunk(record())[:-1], chunk(record())+b'x',
                chunk(record(position=(float('nan'), 0, 0))),
                chunk(record(position=(0, float('inf'), 0)))]
        for value in data:
            with self.subTest(length=len(value)), self.assertRaises(ValueError):
                list(snapshot.parse_chunk(value))

    def test_reserved_chunk_flags_are_not_silently_accepted(self):
        for flags in (0x4000, 0x8000):
            with self.subTest(flags=flags), self.assertRaises(ValueError):
                list(snapshot.parse_chunk(chunk(record(flags=flags))))

    def test_reader_bounds_dotnet_utf8_and_extended_dictionary_count(self):
        self.assertEqual(snapshot.Reader(dotnet_string('ё' * 200)).string(), 'ё' * 200)
        for count in (0, 127, 128, 255, 32767):
            self.assertEqual(snapshot.Reader(num_items(count)).count(), count)
        for data in (pack('i', -1), pack('i', 999)):
            with self.assertRaises(ValueError):
                snapshot.Reader(data).array()
        with self.assertRaises(ValueError):
            snapshot.Reader(b'\x80' * 5).string()

    def test_snapshot_uses_exact_float_bits_hash_and_world_id_and_never_changes_source(self):
        self.fixture()
        before = {path.name: (hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mtime_ns)
                  for path in self.source.iterdir()}
        payload, manifest = self.run_snapshot()
        after = {path.name: (hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mtime_ns)
                 for path in self.source.iterdir()}
        self.assertEqual(before, after)
        self.assertEqual(payload['worldId'], '9223372036854775807')
        self.assertEqual(payload['mode'], 'snapshot')
        self.assertEqual(payload['coverage'], 'partial')
        identity = f"pos-v1:{snapshot.stable_hash('piece_chest_wood')}:3fa00000:80000000:c1a40000"
        self.assertEqual(payload['containers'][0]['identityKey'], identity)
        self.assertEqual(payload['containers'][0]['id'], 'snapshot:' + identity)
        self.assertTrue(manifest['sourceUnchangedDuringRead'])

    def test_snapshot_unresolved_items_and_unknown_inventory_objects_reported(self):
        self.fixture([record(inv=inventory(prefab_hash=-12345, quantity=7)),
                      record(prefab_hash=-7654, position=(20, 0, 30), inv=inventory())])
        payload, manifest = self.run_snapshot()
        self.assertEqual(len(payload['containers']), 1)
        self.assertEqual(manifest['unresolvedItemUnits'], 7)
        self.assertEqual(manifest['unknownInventoryObjects'], 1)

    def test_duplicate_exact_stationary_container_identity_fails_closed(self):
        self.fixture([record(), record()])
        with self.assertRaisesRegex(ValueError, 'Ambiguous'):
            self.run_snapshot()

    def test_duplicate_mapping_even_without_chests_fails_closed(self):
        self.fixture([], duplicate_mapping=True)
        with self.assertRaises(ValueError):
            self.run_snapshot()

    def test_mapping_and_world_metadata_version_gates(self):
        for mapping_version, world_version in ((43, 42), (42, 43)):
            with self.subTest(mapping=mapping_version, world=world_version):
                self.fixture(mapping_version=mapping_version, world_version=world_version)
                with self.assertRaises(ValueError):
                    self.run_snapshot()

    def test_required_world_metadata_truncation_after_uid_is_rejected(self):
        self.fixture(tail=False)
        with self.assertRaises(ValueError):
            self.run_snapshot()

    def test_mapping_count_disagreement_and_missing_completed_generation(self):
        with self.assertRaises(ValueError):
            self.run_snapshot()
        self.fixture()
        path = self.source / '_main.7.chunks'
        data = bytearray(path.read_bytes())
        data[2:6] = pack('i', 123)
        path.write_bytes(data)
        with self.assertRaisesRegex(ValueError, 'count'):
            self.run_snapshot()


if __name__ == '__main__':
    unittest.main(verbosity=2)
