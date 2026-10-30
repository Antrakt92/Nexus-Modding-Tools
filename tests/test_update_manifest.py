import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location('update_manifest', SCRIPTS / 'update_manifest.py')
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)


class UpdateManifestTests(unittest.TestCase):
    def test_manifest_rejects_non_utf8_maintained_source_before_pinning_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'tools' / 'scope.cjs'
            source.parent.mkdir()
            source.write_bytes(b"const value = 'COM\xb9';\n")
            with mock.patch.object(u, 'ROOT', root), mock.patch.object(u.subprocess, 'check_output', side_effect=[b'', b'tools/scope.cjs\0']):
                with self.assertRaisesRegex(ValueError, 'not valid UTF-8: tools/scope.cjs'):
                    u.content()
            self.assertEqual(source.read_bytes(), b"const value = 'COM\xb9';\n")

    def test_manifest_accepts_unicode_source_and_preserves_opaque_upstream_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            maintained = root / 'tools' / 'scope.cjs'
            upstream = root / 'dependencies' / 'pinned.cjs'
            maintained.parent.mkdir()
            upstream.parent.mkdir()
            maintained.write_bytes("const value = 'COM\u00b9';\n".encode('utf-8'))
            upstream.write_bytes(b'opaque pinned upstream \xb9\r\n')
            with mock.patch.object(u, 'ROOT', root), mock.patch.object(u.subprocess, 'check_output', side_effect=[b'', b'tools/scope.cjs\0dependencies/pinned.cjs\0']):
                result = json.loads(u.content())
            self.assertEqual(len(result['files']), 2)
            self.assertEqual(upstream.read_bytes(), b'opaque pinned upstream \xb9\r\n')

    def test_manifest_symlink_cannot_redirect_write_or_check(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); repo = root / 'repo'; (repo / 'scripts').mkdir(parents=True)
            for name in ['update_manifest.py', 'recovery.py']:
                shutil.copyfile(SCRIPTS / name, repo / 'scripts' / name)
            source = repo / 'source.txt'; source.write_bytes(b'reviewed source\n')
            subprocess.run(['git', 'init', '--quiet'], cwd=repo, check=True, capture_output=True)
            subprocess.run(['git', 'add', 'source.txt'], cwd=repo, check=True, capture_output=True)
            sentinel = root / 'outside.json'; sentinel.write_bytes(b'preserve unrelated content')
            try:
                (repo / 'recovery-manifest.json').symlink_to(sentinel)
            except OSError as error:
                self.skipTest('Symlink creation unavailable: ' + str(error))
            for args in [['--write'], []]:
                with self.subTest(args=args):
                    result = subprocess.run([sys.executable, '-B', str(repo / 'scripts/update_manifest.py'), *args],
                                            cwd=repo, capture_output=True, text=True)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('reparse', result.stderr)
                    self.assertEqual(sentinel.read_bytes(), b'preserve unrelated content')
                    self.assertEqual(source.read_bytes(), b'reviewed source\n')

    def test_atomic_write_preserves_existing_manifest_if_replace_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / 'recovery-manifest.json'; target.write_bytes(b'previous manifest')
            with mock.patch.object(u, 'ROOT', root), mock.patch.object(u, 'content', return_value=b'new manifest'):
                with mock.patch.object(u.os, 'replace', side_effect=OSError('Simulated interrupted replacement')):
                    with self.assertRaisesRegex(OSError, 'Simulated interrupted replacement'):
                        u.update(True)
                self.assertEqual(target.read_bytes(), b'previous manifest')
                self.assertEqual(list(root.glob('*.tmp')), [])
                u.update(True)
                self.assertEqual(target.read_bytes(), b'new manifest')
                u.update()
                self.assertEqual(list(root.glob('*.tmp')), [])


if __name__ == '__main__':
    unittest.main()
