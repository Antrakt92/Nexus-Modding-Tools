"""Synthetic own-package safety tests; no installed games or mod archives."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

SCRIPT = Path('C:/Users/Dima/.codex/skills/nexus-mod-workflow/scripts/audit_package.py')
spec = importlib.util.spec_from_file_location('package_audit', SCRIPT)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class PackageAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.package = self.root / 'package'
        self.package.mkdir()
        (self.package / 'readme.txt').write_bytes(b'own original payload')
        self.archive = self.root / 'own.zip'

    def make_zip(self, members=None):
        members = members if members is not None else [('readme.txt', b'own original payload')]
        with zipfile.ZipFile(self.archive, 'w', compression=zipfile.ZIP_STORED) as archive:
            for name, content in members:
                archive.writestr(name, content)

    def test_exact_payload_and_cli_bounded_report(self):
        self.make_zip()
        output = self.root / 'audit.json'
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            code = audit.main(['--package', str(self.package), '--archive', str(self.archive), '--output', str(output)])
        self.assertEqual(code, 0)
        result = json.loads(stdout.getvalue())
        self.assertEqual(result, json.loads(output.read_text()))
        self.assertEqual(result['files'], 1)
        self.assertTrue(result['archiveCompared'])
        self.assertFalse(result['runtimeVerified'])
        self.assertFalse(result['licenseVerified'])
        self.assertLess(len(stdout.getvalue()), 1024)
        self.assertEqual(list(self.package.iterdir()), [self.package / 'readme.txt'])

    def test_changed_missing_and_extra_archive_members(self):
        for members in [[('readme.txt', b'changed')], [('other.txt', b'own original payload')],
                        [('readme.txt', b'own original payload'), ('extra.txt', b'')]]:
            with self.subTest(members=members):
                self.make_zip(members)
                with self.assertRaises(audit.AuditError):
                    audit.audit(self.package, self.archive)

    def test_unsafe_windows_names(self):
        for name in ['../escape', '/absolute', 'C:/drive', 'C:drive', 'x:stream',
                     r'a\b', 'a//b', 'a/./b', 'name.', 'name ', 'CON.txt',
                     'lpt1', 'COM².txt', 'nul/child', 'a\x00b', '?bad']:
            with self.subTest(name=name), self.assertRaises(audit.AuditError):
                audit.safe_name(name)

    def test_private_build_and_debug_exclusions(self):
        for name in ['.env', '.env.production', '.git/config', 'src/__pycache__/x.pyc',
                     'receipts/done.json', 'toolchain/wolvenkit.dll', 'private.pem',
                     'id_ed25519', 'scc.exe', 'report.log', 'TEMP-DEBUG.reds']:
            with self.subTest(name=name), self.assertRaises(audit.AuditError):
                audit.safe_name(name)
        self.assertEqual(audit.safe_name('red4ext/plugins/OwnMod.dll'), 'red4ext/plugins/OwnMod.dll')

    def test_aliases_duplicates_and_file_directory_collisions(self):
        cases = [[('A.txt', b'x'), ('a.txt', b'y')], [('A/x.txt', b'x'), ('a/y.txt', b'y')],
                 [('a', b'x'), ('a/b', b'y')], [('a/b', b'x'), ('a', b'y')]]
        for members in cases:
            with self.subTest(members=members):
                self.make_zip(members)
                with self.assertRaises(audit.AuditError):
                    audit.scan_zip(self.archive, 100, 1000)
        seen = {}
        audit.register('same', False, seen)
        with self.assertRaises(audit.AuditError):
            audit.register('same', False, seen)

    def test_explicit_directory_after_child_is_valid(self):
        self.make_zip([('dir/file.txt', b'x'), ('dir/', b'')])
        self.assertEqual(set(audit.scan_zip(self.archive, 100, 1000)), {'dir/file.txt'})

    def test_zip_symlink_is_rejected_without_extraction(self):
        member = zipfile.ZipInfo('link')
        member.create_system = 3
        member.external_attr = (stat.S_IFLNK | 0o777) << 16
        self.make_zip([(member, b'../outside')])
        with self.assertRaises(audit.AuditError):
            audit.scan_zip(self.archive, 100, 1000)
        self.assertFalse((self.root / 'outside').exists())

    def test_reparse_attribute_rejected(self):
        fake = SimpleNamespace(st_mode=stat.S_IFREG, st_file_attributes=0x400)
        with patch.object(Path, 'lstat', return_value=fake), self.assertRaises(audit.AuditError):
            audit.ordinary(self.package / 'readme.txt')

    def test_limits_and_empty_package(self):
        with self.assertRaises(audit.AuditError):
            audit.audit(self.package, max_bytes=1)
        with self.assertRaises(audit.AuditError):
            audit.audit(self.package, max_entries=0)
        (self.package / 'second.txt').write_bytes(b'x')
        with self.assertRaises(audit.AuditError):
            audit.audit(self.package, max_entries=1)
        empty = self.root / 'empty'
        empty.mkdir()
        with self.assertRaises(audit.AuditError):
            audit.audit(empty)
        self.make_zip([('many.txt', b'x' * 100)])
        with self.assertRaises(audit.AuditError):
            audit.scan_zip(self.archive, 10, 10)

    def test_bad_crc_is_rejected(self):
        self.make_zip()
        data = bytearray(self.archive.read_bytes())
        at = data.index(b'own original payload')
        data[at] ^= 1
        self.archive.write_bytes(data)
        with self.assertRaises(zipfile.BadZipFile):
            audit.scan_zip(self.archive, 100, 1000)

    def test_temp_debug_marker_in_source_is_rejected(self):
        (self.package / 'own.reds').write_bytes(b'// TEMP-DEBUG must not ship')
        with self.assertRaises(audit.AuditError):
            audit.audit(self.package)

    def test_reshade_debug_marker_rejected_in_folder_and_archive(self):
        for suffix in ('.fx', '.fxh', '.FX', '.cs', '.redscript', '.cpp', '.hpp', '.hlsl', '.mjs'):
            with self.subTest(suffix=suffix):
                source = self.package / ('own' + suffix)
                source.write_bytes(b'// TEMP-DEBUG overlay still active')
                with self.assertRaises(audit.AuditError):
                    audit.audit(self.package)
                source.unlink()
                self.make_zip([('own' + suffix, b'// TEMP-DEBUG overlay still active')])
                with self.assertRaises(audit.AuditError):
                    audit.scan_zip(self.archive, 100, 1000)

    def test_private_key_rejected_even_with_innocent_filename(self):
        (self.package / 'readme.txt').write_bytes(b'-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic')
        with self.assertRaises(audit.AuditError):
            audit.audit(self.package)

    def test_zip_entry_limit_and_empty_zip(self):
        self.make_zip([('one', b''), ('two', b'')])
        with self.assertRaises(audit.AuditError):
            audit.scan_zip(self.archive, 1, 100)
        self.make_zip([])
        with self.assertRaises(audit.AuditError):
            audit.scan_zip(self.archive, 10, 100)

    def test_report_cannot_overwrite_or_enter_package_or_staging(self):
        existing = self.root / 'existing.json'
        existing.write_text('preserve')
        stage = self.root / 'staging'
        stage.mkdir()
        for target in [existing, self.package / 'report.json', stage / 'report.json']:
            with self.subTest(target=target), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(audit.main(['--package', str(self.package), '--output', str(target)]), 1)
        self.assertEqual(existing.read_text(), 'preserve')
        self.assertFalse((stage / 'report.json').exists())


if __name__ == '__main__':
    unittest.main()
