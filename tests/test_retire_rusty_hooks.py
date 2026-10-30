import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('retire_hooks', Path(__file__).parents[1] / 'tools/modding/retire-rusty-hooks.py')
m = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(m)


class RetireRustyHooksTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name); self.git = self.root / '.git'; self.hooks = self.git / 'hooks'
        self.hooks.mkdir(parents=True); (self.git / 'config').write_text('[core]\nrepositoryformatversion = 0\n')
        self.content = {name: ('own synthetic fixture ' + name + '\n').encode() for name in m.CATALOG}
        catalog = {name: hashlib.sha256(data).hexdigest() for name, data in self.content.items()}
        self.pins = patch.object(m, 'CATALOG', catalog); self.pins.start(); self.addCleanup(self.pins.stop)
        for name, data in self.content.items(): (self.hooks / name).write_bytes(data)
        (self.hooks / 'custom-gate').write_bytes(b'foreign useful hook')
        (self.hooks / 'pre-commit.sample').write_bytes(b'preserved sample')
        (self.root / '.rusty-hook.toml').write_bytes(b'preserve untracked user config')

    def tree(self):
        return {str(p.relative_to(self.root)): p.read_bytes() if p.is_file() else None for p in self.root.rglob('*')}

    def test_production_catalog_is_fixed_nineteen_stubs_two_helpers(self):
        self.assertEqual(len(m.STUB_NAMES), 19)
        self.assertEqual(len(self.content), 21)
        self.assertEqual(m.STUB_SHA, '011a2a98b8c0361de91597a939c9dd9c0373487e962969e27ca696834305109f')
        self.assertEqual(m.MINIMAL_HOOK.splitlines()[-1], b'exec git diff --cached --check')

    def test_default_plan_is_exact_and_zero_write(self):
        before = self.tree()
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(m.main(['--repository', str(self.root)]), 0)
        value = json.loads(out.getvalue())
        self.assertFalse(value['effectsPerformed']); self.assertEqual(len(value['retire']), 21)
        self.assertEqual(before, self.tree()); self.assertFalse((self.git / m.LEDGER).exists())

    def test_apply_preserves_original_bytes_unknown_hooks_samples_config_and_evidence(self):
        result = m.apply(self.root); backup = Path(result['backup'])
        self.assertEqual(result['retiredFiles'], 21)
        for name, data in self.content.items():
            self.assertEqual((backup / name).read_bytes(), data)
            self.assertEqual((self.hooks / name).exists(), name == 'pre-commit')
        self.assertEqual((self.hooks / 'pre-commit').read_bytes(), m.MINIMAL_HOOK)
        self.assertEqual((self.hooks / 'custom-gate').read_bytes(), b'foreign useful hook')
        self.assertEqual((self.hooks / 'pre-commit.sample').read_bytes(), b'preserved sample')
        self.assertEqual((self.root / '.rusty-hook.toml').read_bytes(), b'preserve untracked user config')
        self.assertTrue((backup / 'manifest.json').is_file()); self.assertTrue((backup / 'completed.json').is_file())
        self.assertEqual(json.loads((backup / 'manifest.json').read_bytes())['backup'], backup.name)
        with self.assertRaisesRegex(m.RetirementError, 'HOOK_RETIREMENT_ALREADY_ATTEMPTED'): m.apply(self.root)

    def test_unknown_or_missing_known_hook_refuses_before_write(self):
        hook = self.hooks / 'pre-push'; hook.write_bytes(b'useful different implementation')
        before = self.tree()
        with self.assertRaisesRegex(m.RetirementError, 'HOOK_PIN_MISMATCH'): m.apply(self.root)
        self.assertEqual(before, self.tree())
        hook.unlink(); before = self.tree()
        with self.assertRaisesRegex(m.RetirementError, 'HOOK_CATALOG_INCOMPLETE'): m.plan(self.root)
        self.assertEqual(before, self.tree())

    def test_reparse_hook_and_root_refused_without_write(self):
        hook = self.hooks / 'pre-push'; hook.unlink(); os.symlink(self.hooks / 'custom-gate', hook)
        with self.assertRaisesRegex(m.RetirementError, 'HOOK_UNSAFE_PATH'): m.plan(self.root)
        hook.unlink(); hook.write_bytes(self.content['pre-push'])
        alias = self.root / 'alias'; os.symlink(self.git, alias, target_is_directory=True)
        moved = self.root / '.git-ordinary'; self.git.rename(moved)
        # A .git reparse path is rejected, never resolved away.
        os.symlink(moved, self.git, target_is_directory=True)
        with self.assertRaisesRegex(m.RetirementError, 'HOOK_UNSAFE_PATH'): m.plan(self.root)

    def test_local_hooks_path_or_included_config_is_not_guessed(self):
        for text in ['[core]\nhooksPath = somewhere\n', '[include]\npath = ../foreign\n', '[includeIf "gitdir:somewhere"]\npath = ../foreign\n']:
            (self.git / 'config').write_text(text); before = self.tree()
            with self.assertRaisesRegex(m.RetirementError, 'HOOK_PATH_OVERRIDE|HOOK_CONFIG_UNSUPPORTED'): m.plan(self.root)
            self.assertEqual(before, self.tree())

    def test_mutation_after_backup_prevents_removal_and_keeps_held_evidence(self):
        write = m.new_file
        def mutate(path, data, mode=0o600):
            result = write(path, data, mode)
            if path.name == 'pre-commit.replacement': (self.hooks / 'pre-push').write_bytes(b'concurrent useful update')
            return result
        with patch.object(m, 'new_file', side_effect=mutate):
            with self.assertRaisesRegex(m.RetirementError, 'HOOK_FILE_CHANGED'): m.apply(self.root)
        self.assertEqual((self.hooks / 'pre-push').read_bytes(), b'concurrent useful update')
        self.assertTrue((self.git / m.LEDGER).is_file())
        backup = next(self.git.glob('rusty-hook-backup-*'))
        self.assertEqual((backup / 'pre-push').read_bytes(), self.content['pre-push'])
        self.assertFalse((backup / 'completed.json').exists())
        with self.assertRaisesRegex(m.RetirementError, 'HOOK_RETIREMENT_ALREADY_ATTEMPTED'): m.apply(self.root)

    def test_partial_unlink_failure_is_held_no_retry_no_backup_loss(self):
        unlink = Path.unlink; removed = []
        def fail(path, *args, **kwargs):
            if path.parent == self.hooks:
                if len(removed) == 1: raise OSError('injected private failure')
                removed.append(path.name)
            return unlink(path, *args, **kwargs)
        with patch.object(Path, 'unlink', fail):
            with self.assertRaises(OSError): m.apply(self.root)
        self.assertEqual(len(removed), 1)
        backup = next(self.git.glob('rusty-hook-backup-*'))
        for name, data in self.content.items(): self.assertEqual((backup / name).read_bytes(), data)
        with self.assertRaisesRegex(m.RetirementError, 'HOOK_RETIREMENT_ALREADY_ATTEMPTED'): m.apply(self.root)

    def test_publication_race_never_overwrites_foreign_precommit(self):
        link = os.link
        def race(source, destination, *args, **kwargs):
            Path(destination).write_bytes(b'foreign newly installed gate')
            return link(source, destination, *args, **kwargs)
        with patch.object(m.os, 'link', side_effect=race):
            with self.assertRaises(FileExistsError): m.apply(self.root)
        self.assertEqual((self.hooks / 'pre-commit').read_bytes(), b'foreign newly installed gate')
        self.assertTrue((self.git / m.LEDGER).is_file())
        self.assertFalse(next(self.git.glob('rusty-hook-backup-*')).joinpath('completed.json').exists())

    def test_fsync_failure_before_any_active_change_preserves_hooks(self):
        before = {name: (self.hooks / name).read_bytes() for name in self.content}
        with patch.object(m.os, 'fsync', side_effect=OSError('injected disk failure')):
            with self.assertRaises(OSError): m.apply(self.root)
        self.assertEqual(before, {name: (self.hooks / name).read_bytes() for name in self.content})
        self.assertTrue((self.git / m.LEDGER).exists())

    def test_cli_reports_only_safe_code_for_private_error(self):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(m.main(['--repository', str(self.root / 'private-absent')]), 1)
        self.assertNotIn('private', out.getvalue()); self.assertEqual(json.loads(out.getvalue())['code'], 'HOOK_RETIREMENT_FAILED')


if __name__ == '__main__': unittest.main()
