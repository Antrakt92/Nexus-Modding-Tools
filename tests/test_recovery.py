import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

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
            manifest = {'schema': 1, 'digest': 'SHA-256 after CRLF-to-LF normalization',
                        'files': [{'path': 'code.py', 'sha256_lf': hashlib.sha256(b'first\nsecond\n').hexdigest()}]}
            (root / 'recovery-manifest.json').write_text(json.dumps(manifest))
            self.assertEqual(r.verify(root)['verified_files'], 1)
            (root / 'code.py').write_text('modified')
            with self.assertRaises(ValueError):
                r.verify(root)

    def test_manifest_requires_supported_schema_and_nonempty_file_inventory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            valid = {'schema': 1, 'digest': 'SHA-256 after CRLF-to-LF normalization',
                     'files': [{'path': 'code.py', 'sha256_lf': r.digest(b'code')}]}
            (root / 'code.py').write_bytes(b'code')
            variants = [None, [], {}, {'files': []}, {**valid, 'schema': True},
                        {**valid, 'schema': 2}, {**valid, 'digest': 'different algorithm'},
                        {**valid, 'files': []}, {**valid, 'files': {}},
                        {**valid, 'unexpected': True}]
            for manifest in variants:
                with self.subTest(manifest=manifest):
                    (root / 'recovery-manifest.json').write_text(json.dumps(manifest))
                    with self.assertRaisesRegex(ValueError, 'manifest'):
                        r.verify(root)

    def test_manifest_rows_have_exact_fields_and_lowercase_sha256_pins(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'code.py').write_bytes(b'code')
            good = {'path': 'code.py', 'sha256_lf': r.digest(b'code')}
            rows = [None, [], {}, {**good, 'extra': 1},
                    {**good, 'path': 1}, {**good, 'sha256_lf': None},
                    {**good, 'sha256_lf': 'a' * 63},
                    {**good, 'sha256_lf': good['sha256_lf'].upper()}]
            for row in rows:
                with self.subTest(row=row):
                    manifest = {'schema': 1, 'digest': 'SHA-256 after CRLF-to-LF normalization', 'files': [row]}
                    (root / 'recovery-manifest.json').write_text(json.dumps(manifest))
                    with self.assertRaisesRegex(ValueError, 'manifest'):
                        r.verify(root)

    def test_path_escape_rejected(self):
        for value in ['../outside', '/absolute', 'C:/absolute', 'a\\b', 'a/../b', 'a//b', 'a:stream']:
            with self.assertRaises(ValueError):
                r.relative(value)

    def test_source_bundle_name_cannot_escape_the_supplied_archive_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / 'archives'; archive.mkdir()
            outside = root / 'outside.bundle'; outside.write_bytes(b'fixture')
            lock = {'upstreams': [{'name': 'fixture', 'bundle': '../outside.bundle',
                                  'bytes': 7, 'sha256': r.digest(b'fixture'), 'commit': 'fixture'}]}
            (root / 'source-lock.json').write_text(json.dumps(lock))
            workspace = root / 'workspace'
            with mock.patch.object(r, 'ROOT', root), mock.patch.object(r, 'run_git') as git:
                with self.assertRaisesRegex(ValueError, 'recovery path'):
                    r.fetch_sources(workspace, archive, True)
                git.assert_not_called()
            self.assertFalse(workspace.exists())

    def test_source_bundle_roundtrip_is_idempotent_and_preserves_modified_checkout(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); source = root / 'source'; source.mkdir()
            archive = root / 'archives'; archive.mkdir()
            hooks = root / 'empty-hooks'; hooks.mkdir()
            r.run_git(['init', '--quiet'], source)
            (source / 'code.py').write_text('original source\n')
            r.run_git(['add', 'code.py'], source)
            r.run_git(['-c', 'user.name=Recovery Test', '-c', 'user.email=recovery@example.invalid',
                       '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=' + str(hooks),
                       'commit', '--quiet', '-m', 'Fixture source'], source)
            commit = r.run_git(['rev-parse', 'HEAD'], source)
            bundle = archive / 'source.bundle'
            r.run_git(['bundle', 'create', bundle, 'HEAD'], source)
            data = bundle.read_bytes()
            (root / 'source-lock.json').write_text(json.dumps({'upstreams': [{
                'name': 'fixture', 'bundle': bundle.name, 'commit': commit,
                'bytes': len(data), 'sha256': r.digest(data)}]}))
            workspace = root / 'workspace with spaces Юникод'
            with mock.patch.object(r, 'ROOT', root):
                empty_nested = source / 'local-state/upstream-sources/fixture'
                empty_nested.mkdir(parents=True)
                with self.assertRaisesRegex(ValueError, 'checkout root differs'):
                    r.fetch_sources(source, archive, True)
                self.assertEqual(list(empty_nested.iterdir()), [])
                self.assertEqual(r.fetch_sources(workspace, archive)['sources'][0]['state'], 'would_restore')
                self.assertFalse(workspace.exists())
                real_git = r.run_git
                target = workspace / 'local-state/upstream-sources/fixture'
                for failing_command in ['fetch', 'checkout']:
                    def fail_recovery(args, cwd=None):
                        if args[0] == failing_command:
                            raise RuntimeError('Simulated Git failure')
                        return real_git(args, cwd)
                    with self.subTest(command=failing_command), mock.patch.object(r, 'run_git', side_effect=fail_recovery):
                        with self.assertRaisesRegex(RuntimeError, 'Simulated Git failure'):
                            r.fetch_sources(workspace, archive, True)
                    self.assertFalse(target.exists(), 'failed recovery must not occupy the final checkout path')
                    self.assertEqual(list(target.parent.iterdir()), [], 'temporary checkout must be cleaned')
                self.assertEqual(r.fetch_sources(workspace, archive, True)['sources'][0]['state'], 'restored')
                self.assertEqual(r.fetch_sources(workspace, archive, True)['sources'][0]['state'], 'already_verified')
                target = workspace / 'local-state/upstream-sources/fixture'
                self.assertEqual(r.run_git(['rev-parse', 'HEAD'], target), commit)
                (target / 'code.py').write_text('keep my modification\n')
                with self.assertRaisesRegex(ValueError, 'Existing upstream checkout differs'):
                    r.fetch_sources(workspace, archive, True)
                self.assertEqual((target / 'code.py').read_text(), 'keep my modification\n')

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

    def test_skill_parent_file_conflict_is_rejected_before_any_restore(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); snapshot = root / 'snapshot'; dest = root / 'skills'
            (snapshot / 'skills/example/nested').mkdir(parents=True)
            rows = []
            for rel in ['skills/example/first.md', 'skills/example/nested/second.md']:
                data = rel.encode(); (snapshot / rel).write_bytes(data)
                rows.append({'path': rel, 'sha256': r.digest(data)})
            (snapshot / 'manifest.json').write_text(json.dumps({'skills': rows}))
            (dest / 'example').mkdir(parents=True)
            (dest / 'example/nested').write_text('preserve this file')
            with self.assertRaisesRegex(ValueError, 'parent is not a directory'):
                r.restore_skills(snapshot, dest, True)
            self.assertFalse((dest / 'example/first.md').exists())
            self.assertEqual((dest / 'example/nested').read_text(), 'preserve this file')

    def test_skill_manifest_reparse_is_rejected_before_any_restore(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); snapshot = root / 'snapshot'; dest = root / 'skills'
            (snapshot / 'skills/example').mkdir(parents=True)
            data = b'example skill'
            (snapshot / 'skills/example/SKILL.md').write_bytes(data)
            outside_manifest = root / 'outside-manifest.json'
            outside_manifest.write_text(json.dumps({'skills': [
                {'path': 'skills/example/SKILL.md', 'sha256': r.digest(data)}]}))
            self.make_symlink(snapshot / 'manifest.json', outside_manifest)
            with self.assertRaisesRegex(ValueError, 'reparse'):
                r.restore_skills(snapshot, dest, True)
            self.assertFalse(dest.exists())


if __name__ == '__main__':
    unittest.main()
