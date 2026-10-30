import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import types
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('pristine_cache', Path(__file__).parents[1] / 'tools/modding/decompile_pristine.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


class PristineCacheTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.work = self.root / 'workspace'; self.work.mkdir()
        self.game = self.root / 'game'; (self.game / 'r6/cache').mkdir(parents=True)
        self.source = self.game / 'r6/cache/final.redscripts'; self.source.write_bytes(b'own synthetic input')
        self.digest = hashlib.sha256(self.source.read_bytes()).hexdigest()
        tools = self.work / 'cyberpunk-tools/toolchain'; tools.mkdir(parents=True)
        self.tool = tools / 'tool.exe'; self.tool.write_bytes(b'own fake executable bytes, never executed')
        self.manifest = tools / 'toolchain.json'
        self.manifest.write_text(json.dumps({'tools': {'redscript_cli': {'relative_executable': 'tool.exe', 'sha256': m.sha(self.tool)}}}))
        self.calls = 0

    def runner(self, command, **kwargs):
        self.calls += 1
        self.assertEqual(command, [str(self.tool), 'decompile', '-i', str(self.source), '-o', command[5], '-m', 'code'])
        self.assertEqual(kwargs['timeout'], 180)
        self.assertEqual(kwargs['cwd'], Path(command[5]).parent)
        self.assertEqual(kwargs['stdin'], subprocess.DEVNULL)
        self.assertEqual(kwargs['creationflags'], getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        kwargs['stdout'].write(b'own fake decompiler successful\n')
        Path(command[5]).write_bytes(b'class ItemModeGridView {}\nclass InventoryItemModeLogicController {}\n')
        return types.SimpleNamespace(returncode=0)

    def snap(self):
        return m.snapshot(self.work, self.game, self.digest)

    def tree(self):
        return {str(p.relative_to(self.root)): (p.read_bytes() if p.is_file() else None) for p in self.root.rglob('*')}

    def test_default_and_explicit_status_are_zero_write_and_do_not_execute(self):
        before = self.tree()
        for flag in [[], ['--status']]:
            with patch.object(m, 'generate_cache', side_effect=AssertionError('generation')), contextlib.redirect_stdout(io.StringIO()) as out:
                code = m.main(['--workspace', str(self.work), '--game', str(self.game)] + flag)
            value = json.loads(out.getvalue()); self.assertEqual(code, 2)
            self.assertFalse(value['baselineMatched']); self.assertFalse(value['cacheReusable'])
            self.assertNotIn('source', value); self.assertEqual(self.tree(), before)
        self.assertEqual(m.inspect_cache(self.work)['code'], 'PRISTINE_GAME_REQUIRED')

    def test_explicit_baseline_matches_but_is_not_independently_proven(self):
        value = m.inspect_cache(self.work, self.game, self.digest)
        self.assertEqual(value['state'], 'absent'); self.assertTrue(value['baselineMatched'])
        self.assertTrue(value['generationAllowed']); self.assertFalse(value['cacheReusable'])
        self.assertEqual(m.inspect_cache(self.work, self.game, '0' * 64)['code'], 'PRISTINE_BASELINE_MISMATCH')
        with self.assertRaisesRegex(m.CacheError, 'PRISTINE_BASELINE_REQUIRED'):
            m.generate_cache(self.work, self.game, None, _run=self.runner)
        self.assertEqual(self.calls, 0)

    def test_success_receipt_reuse_and_unknown_baseline_never_returns_reference(self):
        first = m.generate_cache(self.work, self.game, self.digest, _run=self.runner)
        self.assertFalse(first['reused']); self.assertEqual(self.calls, 1)
        second = m.generate_cache(self.work, self.game, self.digest, _run=lambda *a, **k: self.fail('rerun'))
        self.assertTrue(second['reused']); self.assertEqual(first['source'], second['source'])
        status = m.inspect_cache(self.work, self.game, self.digest)
        self.assertEqual(status['state'], 'verified'); self.assertTrue(status['cacheReusable'])
        self.assertEqual(status['source'], first['source']); self.assertEqual(status['receipt'], first['receipt'])
        self.assertEqual(len(status['cacheKey']), 64); self.assertTrue(status['requiredTypesVerified']); self.assertFalse(status['coverageVerified'])
        untrusted = m.inspect_cache(self.work, self.game)
        self.assertFalse(untrusted['cacheReusable']); self.assertNotIn('source', untrusted)
        self.assertEqual(json.loads(Path(first['receipt']).read_text())['coverageVerified'], False)

    def test_legacy_failed_log_only_is_preserved_and_blocks_new_slot(self):
        s = self.snap(); s['legacy'].mkdir(parents=True)
        log = s['legacy'] / 'decompile.log'; original = b'Failed to load the script cache\nfailed to fill whole buffer\n'; log.write_bytes(original)
        before = self.tree(); value = m.inspect_cache(self.work, self.game, self.digest)
        self.assertEqual(value['state'], 'held'); self.assertEqual(value['failureClass'], 'decoder_input_failure')
        with self.assertRaisesRegex(m.CacheError, 'CACHE_ATTEMPT_HELD'):
            m.generate_cache(self.work, self.game, self.digest, _run=self.runner)
        self.assertEqual(self.tree(), before); self.assertEqual(self.calls, 0)
        self.assertFalse(s['slot'].exists()); self.assertEqual(log.read_bytes(), original)

    def test_legacy_complete_receipt_requires_size_exit_scope_and_current_hash(self):
        s = self.snap(); slot = s['legacy']; slot.mkdir(parents=True)
        output = slot / 'vanilla.reds'; output.write_bytes(b'class ItemModeGridView {}\nclass InventoryItemModeLogicController {}')
        receipt = {'input': str(self.source), 'inputSHA256': self.digest, 'toolSHA256': m.sha(self.tool),
                   'outputSHA256': m.sha(output), 'outputBytes': output.stat().st_size, 'exitCode': 0, 'scope': m.SCOPE}
        target = slot / 'receipt.json'; target.write_text(json.dumps(receipt))
        self.assertTrue(m.generate_cache(self.work, self.game, self.digest, _run=self.runner)['reused'])
        for key, wrong in [('outputBytes', 0), ('exitCode', 1), ('scope', 'unverified'), ('inputSHA256', '0' * 64)]:
            target.write_text(json.dumps({**receipt, key: wrong}))
            self.assertFalse(m.inspect_cache(self.work, self.game, self.digest)['cacheReusable'])
        self.assertEqual(self.calls, 0)

    def test_failed_timeout_and_interrupted_runs_hold_attempt_without_log_overwrite(self):
        for failure in ['exit', 'timeout', 'exception']:
            with self.subTest(failure=failure):
                # Distinct independently pinned synthetic input for each attempt.
                self.source.write_bytes(failure.encode()); self.digest = m.sha(self.source)
                def fail(command, **kwargs):
                    self.calls += 1; kwargs['stdout'].write(b'unique failure evidence')
                    if failure == 'timeout': raise subprocess.TimeoutExpired(command, 180)
                    if failure == 'exception': raise OSError('private path')
                    return types.SimpleNamespace(returncode=1)
                with self.assertRaises((m.CacheError, OSError, subprocess.TimeoutExpired)):
                    m.generate_cache(self.work, self.game, self.digest, _run=fail)
                slot = self.snap()['slot']; self.assertTrue((slot / 'intent.json').is_file())
                self.assertFalse((slot / 'receipt.json').exists()); old = (slot / 'decompile.log').read_bytes()
                with self.assertRaisesRegex(m.CacheError, 'CACHE_ATTEMPT_HELD'):
                    m.generate_cache(self.work, self.game, self.digest, _run=self.runner)
                self.assertEqual((slot / 'decompile.log').read_bytes(), old)
        self.assertEqual(self.calls, 3)

    def test_source_tool_manifest_mutations_before_receipt_are_rejected(self):
        for name in ['source', 'tool', 'manifest']:
            # Reset tool spec when testing independently.
            with self.subTest(name=name):
                target = getattr(self, name); before = target.read_bytes()
                def changed(command, **kwargs):
                    result = self.runner(command, **kwargs); target.write_bytes(before + b'x'); return result
                with self.assertRaises(m.CacheError):
                    m.generate_cache(self.work, self.game, self.digest, _run=changed)
                target.write_bytes(before)
                slot = self.snap()['slot']; self.assertFalse((slot / 'receipt.json').exists())
                # Don't retry same key. Next case has genuinely distinct synthetic input.
                self.source.write_bytes(self.source.read_bytes() + b'x'); self.digest = m.sha(self.source)

    def test_output_change_lock_unknown_entry_and_json_duplicates_hold(self):
        result = m.generate_cache(self.work, self.game, self.digest, _run=self.runner)
        output = Path(result['source']); saved = output.read_bytes(); output.write_bytes(saved + b'bad')
        self.assertFalse(m.inspect_cache(self.work, self.game, self.digest)['cacheReusable']); output.write_bytes(saved)
        slot = output.parent
        for name in ['writer.lock', 'foreign']:
            (slot / name).write_bytes(b'held')
            self.assertFalse(m.inspect_cache(self.work, self.game, self.digest)['cacheReusable']); (slot / name).unlink()
        (slot / 'receipt.json').write_bytes(b'{"schema":1,"schema":2}')
        self.assertEqual(m.inspect_cache(self.work, self.game, self.digest)['code'], 'CACHE_INVALID_JSON')

    def test_physical_mutations_and_reparse_paths_are_rejected(self):
        s = self.snap(); original = self.source.read_bytes()
        self.source.write_bytes(original + b'x')
        with self.assertRaisesRegex(m.CacheError, 'CACHE_INPUT_CHANGED'): m.recheck(s)
        self.source.write_bytes(original)
        alias = self.root / 'work-alias'; os.symlink(self.work, alias, target_is_directory=True)
        self.assertEqual(m.inspect_cache(alias, self.game, self.digest)['code'], 'CACHE_UNSAFE_PATH')
        self.assertEqual(self.calls, 0)

    def test_owned_locks_release_on_exception_but_replacements_are_preserved(self):
        with self.assertRaisesRegex(RuntimeError, 'fake'):
            with m.exclusive_cache(self.work): raise RuntimeError('fake')
        self.assertFalse((self.work / 'writer.lock').exists())
        with self.assertRaisesRegex(m.CacheError, 'CACHE_LOCKED'):
            with m.exclusive_cache(self.work):
                with m.exclusive_cache(self.work): self.fail('second writer')
        with self.assertRaisesRegex(m.CacheError, 'CACHE_LOCK_CHANGED'):
            with m.exclusive_cache(self.work):
                lock = self.work / 'writer.lock'; lock.rename(self.work / 'old-lock'); lock.write_bytes(b'foreign')
        self.assertEqual((self.work / 'writer.lock').read_bytes(), b'foreign')

    def test_removed_lock_is_not_treated_as_success(self):
        with self.assertRaisesRegex(m.CacheError, 'CACHE_LOCK_CHANGED'):
            with m.exclusive_cache(self.work):
                (self.work / 'writer.lock').unlink()

    def test_fsync_failure_before_tool_call_holds_reserved_slot(self):
        with patch.object(m.os, 'fsync', side_effect=OSError('private disk failure')):
            with self.assertRaises(OSError): m.generate_cache(self.work, self.game, self.digest, _run=self.runner)
        self.assertEqual(self.calls, 0); self.assertTrue(self.snap()['slot'].is_dir())
        self.assertFalse(m.inspect_cache(self.work, self.game, self.digest)['cacheReusable'])

    def test_modern_receipt_json_scalar_types_are_exact(self):
        result = m.generate_cache(self.work, self.game, self.digest, _run=self.runner)
        path = Path(result['receipt']); receipt = json.loads(path.read_text())
        for key, value in [('exitCode', False), ('coverageVerified', 0)]:
            path.write_text(json.dumps({**receipt, key: value}))
            self.assertEqual(m.inspect_cache(self.work, self.game, self.digest)['code'], 'CACHE_RECEIPT_MISMATCH')
        receipt['binding']['options']['timeoutSeconds'] = 180.0
        path.write_text(json.dumps(receipt))
        self.assertEqual(m.inspect_cache(self.work, self.game, self.digest)['code'], 'CACHE_RECEIPT_MISMATCH')

    def test_same_inode_lock_modification_is_preserved(self):
        with self.assertRaisesRegex(m.CacheError, 'CACHE_LOCK_CHANGED'):
            with m.exclusive_cache(self.work):
                (self.work / 'writer.lock').write_bytes(b'foreign content')
        self.assertEqual((self.work / 'writer.lock').read_bytes(), b'foreign content')

    def test_exit_zero_error_missing_types_and_invalid_utf8_cannot_be_reused(self):
        for mode in ['error', 'types', 'utf8']:
            with self.subTest(mode=mode):
                self.source.write_bytes(mode.encode()); self.digest = m.sha(self.source)
                def bad(command, **kwargs):
                    result = self.runner(command, **kwargs)
                    if mode == 'error': kwargs['stdout'].write(b'ERROR [redscript_cli] own synthetic failure\n')
                    if mode == 'types': Path(command[5]).write_bytes(b'own invalid output')
                    if mode == 'utf8':
                        with Path(command[5]).open('ab') as out: out.write(b'\xff')
                    return result
                with self.assertRaises((m.CacheError, UnicodeError)):
                    m.generate_cache(self.work, self.game, self.digest, _run=bad)
                self.assertFalse((self.snap()['slot'] / 'receipt.json').exists())
                self.assertFalse(m.inspect_cache(self.work, self.game, self.digest)['cacheReusable'])

    def test_unknown_baseline_status_never_decodes_generated_reference(self):
        m.generate_cache(self.work, self.game, self.digest, _run=self.runner)
        before = self.tree(); original = m.stable_file
        def hash_only(*args, **kwargs):
            self.assertFalse(kwargs.get('validate_types', False))
            return original(*args, **kwargs)
        with patch.object(m, 'stable_file', side_effect=hash_only), patch.object(m, 'generate_cache', side_effect=AssertionError('process')):
            result = m.inspect_cache(self.work, self.game)
        self.assertFalse(result['baselineMatched']); self.assertFalse(result['cacheReusable'])
        self.assertNotIn('source', result); self.assertNotIn('receipt', result)
        self.assertNotIn('requiredTypesVerified', result); self.assertEqual(before, self.tree())

    def test_source_default_workspace_uses_environment_then_project_root(self):
        for environment, expected in [({'NEXUS_WORKSPACE': str(self.work)}, self.work), ({'NEXUS_WORKSPACE': ''}, Path(m.__file__).absolute().parents[2])]:
            with patch.dict(os.environ, environment), patch.object(m, 'inspect_cache', return_value={'state': 'absent'}) as inspect, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(m.main([]), 0)
            self.assertEqual(inspect.call_args.args[0], expected)

    def test_missing_context_inputs_have_specific_safe_zero_write_status(self):
        for target, code, category in [
                (self.work, 'PRISTINE_WORKSPACE_UNAVAILABLE', 'workspace_missing'),
                (self.game, 'PRISTINE_GAME_UNAVAILABLE', 'game_missing'),
                (self.source, 'PRISTINE_INPUT_UNAVAILABLE', 'input_missing'),
                (self.manifest, 'CACHE_TOOL_MANIFEST_UNAVAILABLE', 'tool_manifest_missing'),
                (self.tool, 'CACHE_TOOL_UNAVAILABLE', 'tool_missing')]:
            with self.subTest(code=code):
                saved = target.with_name(target.name + '-held')
                target.rename(saved)
                try:
                    before = self.tree()
                    value = m.inspect_cache(self.work, self.game, self.digest)
                    self.assertEqual(value['code'], code); self.assertEqual(value['failureClass'], category)
                    self.assertFalse(value['cacheReusable']); self.assertNotIn('source', value)
                    self.assertEqual(before, self.tree()); self.assertEqual(self.calls, 0)
                finally:
                    saved.rename(target)
        original = self.manifest.read_bytes()
        for content in [b'{}', b'{"tools":', b'{"tools":{},"tools":{}}', b'\xff']:
            self.manifest.write_bytes(content); before = self.tree()
            value = m.inspect_cache(self.work, self.game, self.digest)
            self.assertEqual(value['code'], 'CACHE_TOOL_MANIFEST_INVALID')
            self.assertEqual(value['failureClass'], 'tool_manifest_invalid'); self.assertEqual(before, self.tree())
        self.manifest.write_bytes(original)

    def test_receipted_missing_output_has_distinct_readonly_status(self):
        result = m.generate_cache(self.work, self.game, self.digest, _run=self.runner)
        Path(result['source']).unlink(); before = self.tree(); calls = self.calls
        value = m.inspect_cache(self.work, self.game, self.digest)
        self.assertEqual(value['code'], 'CACHE_OUTPUT_MISSING'); self.assertEqual(value['failureClass'], 'output_missing')
        self.assertFalse(value['cacheReusable']); self.assertNotIn('source', value)
        self.assertEqual(len(value['observedCacheKey']), 64)
        self.assertEqual(before, self.tree()); self.assertEqual(calls, self.calls)

    def test_cli_errors_do_not_expose_private_paths(self):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            code = m.main(['--workspace', str(self.work), '--game', str(self.root / 'private-absent-game'), '--generate', '--expected-sha256', self.digest])
        self.assertEqual(code, 1); self.assertNotIn('private', out.getvalue()); self.assertEqual(json.loads(out.getvalue())['code'], 'PRISTINE_GAME_UNAVAILABLE')


if __name__ == '__main__':
    unittest.main()
