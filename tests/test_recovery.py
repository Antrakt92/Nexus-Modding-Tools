import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('recovery', Path(__file__).resolve().parents[1] / 'scripts/recovery.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class RecoveryTests(unittest.TestCase):
    def make_symlink(self, link, target, directory=False):
        try:
            link.symlink_to(target, target_is_directory=directory)
        except OSError as error:
            self.skipTest('Symlink creation unavailable: ' + str(error))

    def test_dangling_output_symlink_does_not_create_outside_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            outside = root / 'outside.txt'
            link = root / 'output.txt'
            self.make_symlink(link, outside)
            with self.assertRaisesRegex(ValueError, 'reparse'):
                r.write_matching(link, b'private skill content', True)
            self.assertFalse(outside.exists())

    def test_dangling_workspace_symlink_is_not_resolved_for_configuration(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            outside = root / 'outside-workspace'
            link = root / 'workspace'
            self.make_symlink(link, outside, directory=True)
            with self.assertRaisesRegex(ValueError, 'reparse'):
                r.configure(link, True)
            self.assertFalse(outside.exists())

    def test_plan_creates_nothing_then_apply_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'workspace with spaces'
            self.assertEqual(r.configure(target)['mode'], 'plan')
            self.assertFalse(target.exists())
            self.assertEqual(r.configure(target, True)['configuration'], 'created')
            self.assertEqual(r.configure(target, True)['configuration'], 'unchanged')

    def test_changed_config_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            result = r.configure(target, True)
            path = Path(result['path'])
            path.write_text('unrelated existing content')
            with self.assertRaises(ValueError):
                r.configure(target, True)
            self.assertEqual(path.read_text(), 'unrelated existing content')

    def test_manifest_verifies_lf_or_crlf_and_rejects_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'code.py').write_bytes(b'first\r\nsecond\r\n')
            manifest = {'files': [{'path': 'code.py', 'sha256_lf': hashlib.sha256(b'first\nsecond\n').hexdigest()}]}
            (root / 'recovery-manifest.json').write_text(json.dumps(manifest))
            self.assertEqual(r.verify(root)['verified_files'], 1)
            (root / 'code.py').write_text('modified')
            with self.assertRaises(ValueError):
                r.verify(root)

    def test_path_escape_rejected(self):
        for value in ['../outside', '/absolute', 'C:/absolute', 'a\\b', 'a/../b', 'a//b', 'a:stream']:
            with self.assertRaises(ValueError):
                r.relative(value)

    def test_skill_conflict_preflight_preserves_everything(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); snapshot = root / 'snapshot'; dest = root / 'skills'
            (snapshot / 'skills/example').mkdir(parents=True)
            rows = []
            for name in ['first.md', 'second.md']:
                data = name.encode(); p = snapshot / 'skills/example' / name; p.write_bytes(data)
                rows.append({'path': p.relative_to(snapshot).as_posix(), 'sha256': hashlib.sha256(data).hexdigest()})
            (snapshot / 'manifest.json').write_text(json.dumps({'skills': rows}))
            (dest / 'example').mkdir(parents=True); (dest / 'example/second.md').write_text('existing')
            with self.assertRaises(ValueError):
                r.restore_skills(snapshot, dest, True)
            self.assertFalse((dest / 'example/first.md').exists())
            self.assertEqual((dest / 'example/second.md').read_text(), 'existing')


if __name__ == '__main__':
    unittest.main()
