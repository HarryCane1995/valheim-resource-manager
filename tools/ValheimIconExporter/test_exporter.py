"""Synthetic-only regression tests; no installed game or copyrighted fixtures required."""
from __future__ import annotations

import importlib.util
import io
import struct
import tempfile
import unittest
from pathlib import Path

from PIL import Image

SPEC = importlib.util.spec_from_file_location('valheim_local_exporter', Path(__file__).with_name('export_items.py'))
exporter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(exporter)


def directory_metadata(names):
    """UnityFS block-info directory with a synthetic uncompressed data block."""
    content = bytearray(b'\0' * 16)
    content.extend(struct.pack('>I', 1))
    content.extend(struct.pack('>IIH', 64, 64, 0))
    content.extend(struct.pack('>I', len(names)))
    for name in names:
        content.extend(struct.pack('>QQI', 0, 1, 0))
        content.extend(name.encode('utf-8') + b'\0')
    return bytes(content)


def synthetic_bundle(names=('CAB-synthetic',), *, version=6, end_metadata=False, compression=0, signature='UnityFS'):
    """Construct a minimal header + directory; the payload contains no real assets."""
    unpacked = directory_metadata(names)
    if compression in (2, 3):
        import lz4.block
        packed = lz4.block.compress(unpacked, store_size=False)
    else:
        packed = unpacked
    flags = compression | (128 if end_metadata else 0)
    prefix = signature.encode('ascii') + b'\0' + struct.pack('>I', version)
    prefix += b'6000.0.0f1\0synthetic-test\0'
    header_size = len(prefix) + struct.calcsize('>QIII')
    padding = b'\0' * ((-header_size) % 16) if version >= 7 else b''
    payload = b'\0' * 64
    size = header_size + len(padding) + len(packed) + len(payload)
    header = prefix + struct.pack('>QIII', size, len(packed), len(unpacked), flags) + padding
    return header + (payload + packed if end_metadata else packed + payload)


class StableHashTests(unittest.TestCase):
    def test_exact_known_values_match_javascript_stable_hash(self):
        # Independently read using server/registry.mjs prefabHash; same public algorithm
        # is implemented in plugin/RegistryAlgorithms.cs. These are identifiers, not assets.
        fixtures = {
            '': 371857150,
            'Wood': -151837501,
            'Stone': -535531945,
            'FineWood': 212315135,
            'Iron': 1400949664,
            'TrophyDeer': 1281967652,
        }
        for text, expected in fixtures.items():
            with self.subTest(prefab=text):
                self.assertEqual(exporter.stable_hash(text), expected)

    def test_utf16_surrogate_pairs_match_dotnet_string_units(self):
        self.assertEqual(exporter.stable_hash('Mod_𐐀_材'), -1342918229)

    def test_known_real_algorithm_collision_does_not_change_prefab_identity(self):
        one, two = 'Mod_pwnzjm_f9u', 'Mod_-cynz70_fh0'
        self.assertNotEqual(one, two)
        self.assertEqual(exporter.stable_hash(one), -87003300)
        self.assertEqual(exporter.stable_hash(two), -87003300)

    def test_case_and_exact_prefab_spelling_are_significant(self):
        self.assertNotEqual(exporter.stable_hash('Wood'), exporter.stable_hash('wood'))
        self.assertNotEqual(exporter.stable_hash('Wood'), exporter.stable_hash('Wood '))


class LocalizationTests(unittest.TestCase):
    def test_utf8_bom_and_token_prefix_are_normalized(self):
        tables, conflicts = exporter.localization_tables([('localization', '\ufeffKEY,English,Russian\n$item_wood,Wood,Древесина\n')])
        self.assertEqual(tables['English']['item_wood'], 'Wood')
        self.assertEqual(tables['Russian']['item_wood'], 'Древесина')
        self.assertEqual(conflicts, set())

    def test_csv_quotes_commas_newlines_and_escaped_quotes_are_preserved(self):
        text = 'KEY,English,Russian\nitem_note,"Line one, with comma\nLine ""two""","Строка один\nСтрока два"\n'
        tables, conflicts = exporter.localization_tables([('localization', text)])
        self.assertEqual(tables['English']['item_note'], 'Line one, with comma\nLine "two"')
        self.assertEqual(tables['Russian']['item_note'], 'Строка один\nСтрока два')
        self.assertEqual(conflicts, set())

    def test_missing_language_and_short_rows_stay_missing(self):
        tables, conflicts = exporter.localization_tables([('localization', 'KEY,English\nitem_a,English only\nitem_b\n')])
        self.assertEqual(tables, {'English': {'item_a': 'English only'}, 'Russian': {}})
        self.assertEqual(conflicts, set())

    def test_main_then_sorted_updates_override_only_nonempty_values(self):
        texts = [
            ('localization_z', 'KEY,English,Russian\nitem_a,Last,Последний\n'),
            ('localization', 'KEY,English,Russian\nitem_a,Base,Основа\nitem_b,Kept,Сохранено\n'),
            ('localization_a', 'KEY,English,Russian\nitem_a,First,Первый\nitem_b,,\n'),
        ]
        tables, conflicts = exporter.localization_tables(texts)
        self.assertEqual(tables['English'], {'item_a': 'Last', 'item_b': 'Kept'})
        self.assertEqual(tables['Russian'], {'item_a': 'Последний', 'item_b': 'Сохранено'})
        self.assertEqual(conflicts, {('English', 'item_a'), ('Russian', 'item_a')})
        self.assertEqual(exporter.localization_tables(list(reversed(texts))), (tables, conflicts))

    def test_identical_repeated_values_are_not_conflicts(self):
        text = 'KEY,English,Russian\nitem_a,Same,Одинаково\nitem_a,Same,Одинаково\n'
        tables, conflicts = exporter.localization_tables([('localization', text)])
        self.assertEqual(tables['English']['item_a'], 'Same')
        self.assertEqual(conflicts, set())

    def test_empty_tables_blank_keys_and_comments_are_ignored(self):
        text = 'KEY,English,Russian\n//comment,ignored,ignored\n,ignored,ignored\n\nitem_a,A,А\n'
        tables, conflicts = exporter.localization_tables([('localization', ''), ('localization_extra', text)])
        self.assertEqual(tables, {'English': {'item_a': 'A'}, 'Russian': {'item_a': 'А'}})
        self.assertEqual(conflicts, set())


class SpriteCanvasTests(unittest.TestCase):
    def test_transparent_canvas_and_exact_alpha_are_preserved(self):
        source = Image.new('RGBA', (2, 3), (230, 90, 10, 127))
        source.putpixel((1, 2), (20, 80, 150, 0))
        canvas = exporter.restore_canvas(source, 5, 7, 1, 2)
        self.assertEqual(canvas.mode, 'RGBA')
        self.assertEqual(canvas.size, (5, 7))
        self.assertEqual(canvas.getpixel((1, 2)), (230, 90, 10, 127))
        self.assertEqual(canvas.getpixel((2, 4)), (20, 80, 150, 0))
        self.assertEqual(canvas.getpixel((0, 0)), (0, 0, 0, 0))
        self.assertEqual(canvas.getpixel((4, 6)), (0, 0, 0, 0))

    def test_unity_bottom_left_offset_becomes_top_down_without_flipping(self):
        source = Image.new('RGBA', (2, 3), (1, 2, 3, 255))
        source.putpixel((0, 0), (255, 0, 0, 255))
        source.putpixel((0, 2), (0, 0, 255, 255))
        canvas = exporter.restore_canvas(source, 8, 9, 3, 1)
        self.assertEqual(canvas.getpixel((3, 5)), (255, 0, 0, 255))
        self.assertEqual(canvas.getpixel((3, 7)), (0, 0, 255, 255))
        self.assertEqual(canvas.getbbox(), (3, 5, 5, 8))

    def test_non_square_sprite_is_never_resized_or_stretched(self):
        source = Image.new('RGB', (3, 7), (20, 30, 40))
        canvas = exporter.restore_canvas(source, 11, 13, 2, 3)
        self.assertEqual(canvas.getbbox(), (2, 3, 5, 10))
        self.assertEqual(canvas.crop((2, 3, 5, 10)).tobytes(), source.convert('RGBA').tobytes())
        self.assertEqual(source.size, (3, 7))

    def test_dimensions_and_offsets_round_without_changing_source_pixels(self):
        source = Image.new('RGBA', (2, 2), (1, 2, 3, 255))
        canvas = exporter.restore_canvas(source, 5.1, 7.2, 1.1, 2.1)
        self.assertEqual(canvas.size, (5, 7))
        self.assertEqual(canvas.getbbox(), (1, 3, 3, 5))

    def test_invalid_canvas_dimensions_fail_closed(self):
        for width, height in [(0, 2), (2, 0), (-1, 2), (2049, 2), (2, 2049)]:
            with self.subTest(size=(width, height)), self.assertRaises(ValueError):
                exporter.restore_canvas(Image.new('RGBA', (1, 1)), width, height)


class BundleDirectoryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='vrm-synthetic-bundle-')
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / 'synthetic.bundle'

    def nodes(self, content):
        self.path.write_bytes(content)
        return exporter.bundle_nodes(self.path)

    def test_version6_normal_header_reads_only_directory_names(self):
        self.assertEqual(self.nodes(synthetic_bundle(('CAB-one', 'CAB-two.resS'))), ['CAB-one', 'CAB-two.resS'])

    def test_version7_aligned_header(self):
        self.assertEqual(self.nodes(synthetic_bundle(('CAB-aligned',), version=7)), ['CAB-aligned'])

    def test_metadata_at_end_with_and_without_alignment(self):
        for version in (6, 7):
            with self.subTest(version=version):
                self.assertEqual(self.nodes(synthetic_bundle(('CAB-at-end',), version=version, end_metadata=True)), ['CAB-at-end'])

    def test_lz4_and_lz4hc_compressed_metadata(self):
        for compression in (2, 3):
            with self.subTest(compression=compression):
                self.assertEqual(self.nodes(synthetic_bundle(('CAB-lz4',), version=7, end_metadata=True, compression=compression)), ['CAB-lz4'])

    def test_unsupported_signature_and_compression_fail_closed(self):
        for content in [synthetic_bundle(signature='UnityRaw'), synthetic_bundle(compression=1)]:
            with self.subTest(header=content[:12]), self.assertRaises(ValueError):
                self.nodes(content)

    def test_truncated_headers_and_strings_fail_closed(self):
        valid = synthetic_bundle()
        for content in [b'', b'UnityFS', b'UnityFS\0', valid[:20], valid[:-1]]:
            with self.subTest(length=len(content)), self.assertRaises((ValueError, struct.error, EOFError)):
                self.nodes(content)

    def test_unterminated_oversized_string_is_rejected(self):
        with self.assertRaises(ValueError):
            exporter.cstring(io.BytesIO(b'a' * 4097 + b'\0'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
