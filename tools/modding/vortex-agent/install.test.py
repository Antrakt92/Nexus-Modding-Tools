"""Synthetic installation paths only; never touches the active plugin/processes."""
import hashlib
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).with_name('manage-install.py')
spec = importlib.util.spec_from_file_location('isolated_upgrade', MODULE)
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)
ROOT = upgrade.ROOT / 'local-state/vortex-agent-build/tests'
ROOT.mkdir(parents=True, exist_ok=True)


def package(directory, version, content, historical=False):
    directory.mkdir(parents=True)
    digest = hashlib.sha256(content).hexdigest()
    (directory / 'index.js').write_bytes(content)
    (directory / 'LICENSE.md').write_text('Synthetic fixture license', encoding='utf-8')
    (directory / 'info.json').write_text(json.dumps({'id': 'vortex-agent', 'version': version}), encoding='utf-8')
    provenance = {'protocol': 'vortex-agent/1', 'version': version,
        'pluginSha256': digest, 'sources': {}, 'maintainedSource': str(directory), 'installSupported': False,
        'workspaceRoot': str(upgrade.ROOT)}
    if not historical:
        (directory / 'THIRD-PARTY-NOTICES.md').write_text('Synthetic dependency notice', encoding='utf-8')
        provenance.update(packageSchemaVersion=2,
            licenseFileSHA256={name: upgrade.sha(directory / name) for name in ['LICENSE.md', 'THIRD-PARTY-NOTICES.md']},
            sourceOffer={'repository': 'https://github.com/Antrakt92/vortex-nexus-modding-mcp'})
    (directory / 'provenance.json').write_text(json.dumps(provenance), encoding='utf-8')
    return digest


class UpgradeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.plugins = self.root / 'userdata/plugins'
        self.receipts = self.root / 'receipts'
        self.receipts.mkdir()
        self.marker = self.receipts / 'unresolved.json'
        self.marker.write_bytes(b'{"requestId":"uncertain-original"}')
        self.old = package(self.plugins / 'vortex-agent', '1.0.3', b'synthetic old bundle', historical=True)
        self.new = package(self.source, '1.0.4', b'synthetic new bundle')
        other = self.plugins / 'unrelated'
        other.mkdir()
        (other / 'sentinel').write_bytes(b'untouched')
        self.patches = [patch.object(upgrade, 'SOURCE', self.source), patch.object(upgrade, 'PLUGINS', self.plugins),
                       patch.object(upgrade, 'RECEIPTS', self.receipts), patch.object(upgrade, 'UPGRADES', self.root / 'upgrades'),
                       patch.object(upgrade, 'stopped', lambda: None)]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def test_upgrade_keeps_old_bundle_unresolved_marker_and_unrelated_plugin(self):
        original = self.marker.read_bytes()
        upgrade.install(self.new, self.old)
        self.assertEqual(upgrade.sha(self.plugins / 'vortex-agent/index.js'), self.new)
        backups = list((self.root / 'upgrades').glob('*/old-plugin/index.js'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(upgrade.sha(backups[0]), self.old)
        self.assertEqual(self.marker.read_bytes(), original)
        self.assertEqual((self.plugins / 'unrelated/sentinel').read_bytes(), b'untouched')

    def test_wrong_prior_bundle_pin_refuses_upgrade(self):
        with self.assertRaisesRegex(RuntimeError, 'pin mismatch'):
            upgrade.install(self.new, '0' * 64)
        self.assertEqual(upgrade.sha(self.plugins / 'vortex-agent/index.js'), self.old)

    def test_sibling_plan_journal_does_not_break_flat_receipt_preservation(self):
        journal = self.root / 'plan-journals' / ('a' * 64)
        journal.mkdir(parents=True)
        record = journal / 'plan.json'
        record.write_bytes(b'{"synthetic":"immutable plan"}')
        before = upgrade.receipt_pins()
        upgrade.install(self.new, self.old)
        self.assertEqual(upgrade.receipt_pins(), before)
        self.assertEqual(record.read_bytes(), b'{"synthetic":"immutable plan"}')

    def test_wrong_runtime_workspace_refuses_before_swap_and_preserves_receipts(self):
        metadata = self.source / 'provenance.json'
        value = json.loads(metadata.read_text())
        value['workspaceRoot'] = str(self.root / 'different-workspace')
        metadata.write_text(json.dumps(value))
        before = self.marker.read_bytes()
        with self.assertRaisesRegex(RuntimeError, 'runtime workspace differs'):
            upgrade.install(self.new, self.old)
        self.assertEqual(upgrade.sha(self.plugins / 'vortex-agent/index.js'), self.old)
        self.assertEqual(self.marker.read_bytes(), before)
        self.assertFalse((self.root / 'upgrades').exists())

    def test_explicit_package_root_keeps_runtime_receipts_in_original_workspace(self):
        before = self.marker.read_bytes()
        with patch.object(upgrade, 'SOURCE', self.root / 'absent-default-source'):
            upgrade.install(self.new, self.old, str(self.source))
        self.assertEqual(upgrade.sha(self.plugins / 'vortex-agent/index.js'), self.new)
        self.assertEqual(self.marker.read_bytes(), before)

    def test_relative_package_root_is_refused(self):
        with self.assertRaisesRegex(RuntimeError, 'absolute path'):
            upgrade.install(self.new, self.old, 'relative/package')
        self.assertEqual(upgrade.sha(self.plugins / 'vortex-agent/index.js'), self.old)

    def test_failed_post_swap_validation_restores_exact_old_plugin(self):
        actual = upgrade.package
        def validate(directory, expected, version=None, **kwargs):
            if directory == self.plugins / 'vortex-agent' and expected == self.new:
                raise RuntimeError('synthetic post-swap failure')
            return actual(directory, expected, version, **kwargs)
        with patch.object(upgrade, 'package', validate):
            with self.assertRaisesRegex(RuntimeError, 'post-swap'):
                upgrade.install(self.new, self.old)
        self.assertEqual(upgrade.sha(self.plugins / 'vortex-agent/index.js'), self.old)
        self.assertTrue(self.marker.exists())

    def test_keyboard_interrupt_after_swap_restores_old_plugin(self):
        actual = upgrade.package
        def validate(directory, expected, version=None, **kwargs):
            if directory == self.plugins / 'vortex-agent' and expected == self.new:
                raise KeyboardInterrupt('synthetic interruption')
            return actual(directory, expected, version, **kwargs)
        with patch.object(upgrade, 'package', validate):
            with self.assertRaises(KeyboardInterrupt):
                upgrade.install(self.new, self.old)
        self.assertEqual(upgrade.sha(self.plugins / 'vortex-agent/index.js'), self.old)
        self.assertTrue(self.marker.exists())

    def test_failed_swap_preserves_concurrent_foreign_target_in_place(self):
        actual = Path.rename
        target = self.plugins / 'vortex-agent'
        def rename(source, destination):
            if source.name.startswith('vortex-agent-upgrade-') and destination == target:
                target.mkdir()
                (target / 'foreign-sentinel').write_bytes(b'preserve in place')
                raise OSError('synthetic concurrent target')
            return actual(source, destination)
        with patch.object(Path, 'rename', rename):
            with self.assertRaisesRegex((RuntimeError, OSError), 'rollback refused|concurrent target'):
                upgrade.install(self.new, self.old)
        self.assertEqual((target / 'foreign-sentinel').read_bytes(), b'preserve in place')
        retained = list((self.plugins.parent / 'temp').glob('vortex-agent-old-*/index.js'))
        self.assertEqual(len(retained), 1)
        self.assertEqual(upgrade.sha(retained[0]), self.old)
        self.assertTrue(self.marker.exists())

    def test_unexpected_owned_plugin_file_is_preserved_and_refused(self):
        extra = self.plugins / 'vortex-agent/primary-added'
        extra.write_bytes(b'preserve')
        with self.assertRaisesRegex(RuntimeError, 'Unexpected plugin contents'):
            upgrade.install(self.new, self.old)
        self.assertEqual(extra.read_bytes(), b'preserve')

    def matching_target(self):
        for name in ['index.js', 'info.json', 'LICENSE.md', 'THIRD-PARTY-NOTICES.md', 'provenance.json']:
            (self.plugins / 'vortex-agent' / name).write_bytes((self.source / name).read_bytes())
        return self.plugins / 'vortex-agent/provenance.json'

    def test_current_package_requires_third_party_notices_before_any_swap(self):
        (self.source / 'THIRD-PARTY-NOTICES.md').unlink()
        with self.assertRaisesRegex(RuntimeError, 'requires pinned third-party notices'):
            upgrade.install(self.new, self.old)
        self.assertEqual(upgrade.sha(self.plugins / 'vortex-agent/index.js'), self.old)
        self.assertTrue(self.marker.exists())

    def test_license_bytes_are_verified_even_when_runtime_bundle_is_unchanged(self):
        (self.source / 'THIRD-PARTY-NOTICES.md').write_bytes(b'changed notice')
        with self.assertRaisesRegex(RuntimeError, 'License file pin mismatch'):
            upgrade.install(self.new, self.old)
        self.assertEqual(upgrade.sha(self.plugins / 'vortex-agent/index.js'), self.old)

    def test_four_file_package_is_only_accepted_as_explicit_pinned_historical_target(self):
        old = self.plugins / 'vortex-agent'
        with self.assertRaisesRegex(RuntimeError, 'requires pinned third-party notices'):
            upgrade.package(old, self.old)
        upgrade.package(old, self.old, allow_historical=True)
        metadata = old / 'provenance.json'
        value = json.loads(metadata.read_text()); value['packageSchemaVersion'] = 2
        metadata.write_text(json.dumps(value))
        with self.assertRaisesRegex(RuntimeError, 'requires pinned third-party notices'):
            upgrade.package(old, self.old, allow_historical=True)

    def test_source_repository_offer_must_match_package_source_project(self):
        metadata = self.source / 'provenance.json'
        value = json.loads(metadata.read_text())
        for repository in ['https://example.invalid/foreign',
                           'https://github.com/Antrakt92/vortex-nexus-modding-mcp-extra',
                           'https://github.com/Other/vortex-nexus-modding-mcp', None, [], {}]:
            with self.subTest(repository=repository):
                value['sourceOffer']['repository'] = repository
                metadata.write_text(json.dumps(value))
                with self.assertRaisesRegex(RuntimeError, 'source repository contract'):
                    upgrade.install(self.new, self.old)
                self.assertEqual(upgrade.sha(self.plugins / 'vortex-agent/index.js'), self.old)

    def test_renamed_and_previous_repository_offers_identify_the_same_package(self):
        metadata = self.source / 'provenance.json'
        value = json.loads(metadata.read_text())
        for repository in ['https://github.com/Antrakt92/vortex-nexus-modding-mcp',
                           'https://github.com/Antrakt92/Nexus-Modding-Tools']:
            with self.subTest(repository=repository):
                value['sourceOffer']['repository'] = repository
                metadata.write_text(json.dumps(value))
                self.assertEqual(upgrade.package(self.source, self.new)['sourceOffer']['repository'], repository)

    def test_metadata_sync_migrates_previous_repository_offer_without_bundle_change(self):
        receipt = self.matching_target()
        previous = json.loads(receipt.read_text())
        previous['sourceOffer']['repository'] = 'https://github.com/Antrakt92/Nexus-Modding-Tools'
        receipt.write_text(json.dumps(previous))
        metadata = self.source / 'provenance.json'
        current = json.loads(metadata.read_text())
        current['sourceOffer']['repository'] = 'https://github.com/Antrakt92/vortex-nexus-modding-mcp'
        metadata.write_text(json.dumps(current))
        marker = self.marker.read_bytes()
        upgrade.sync_provenance(self.new)
        self.assertEqual(json.loads(receipt.read_text())['sourceOffer'], current['sourceOffer'])
        self.assertEqual(upgrade.sha(receipt.parent / 'index.js'), self.new)
        self.assertEqual(self.marker.read_bytes(), marker)

    def test_metadata_sync_refuses_foreign_plugin_identity(self):
        receipt = self.matching_target()
        original = receipt.read_bytes()
        info = self.plugins / 'vortex-agent/info.json'
        info.write_text(json.dumps({'id': 'foreign-plugin', 'version': '1.0.4'}))
        with self.assertRaisesRegex(RuntimeError, 'identity'):
            upgrade.sync_provenance(self.new)
        self.assertEqual(receipt.read_bytes(), original)

    def test_metadata_sync_refuses_different_runtime_workspace(self):
        receipt = self.matching_target()
        original = receipt.read_bytes()
        source = self.source / 'provenance.json'
        value = json.loads(source.read_text())
        value['workspaceRoot'] = str(self.root / 'foreign-workspace')
        source.write_text(json.dumps(value))
        with self.assertRaisesRegex(RuntimeError, 'runtime workspace differs'):
            upgrade.sync_provenance(self.new)
        self.assertEqual(receipt.read_bytes(), original)

    def test_metadata_sync_refuses_source_contract_and_source_hash_drift(self):
        receipt = self.matching_target()
        original = receipt.read_bytes()
        provenance = self.source / 'provenance.json'
        data = json.loads(provenance.read_text())
        data['protocol'] = 'foreign-protocol'
        provenance.write_text(json.dumps(data))
        with self.assertRaisesRegex(RuntimeError, 'contract'):
            upgrade.sync_provenance(self.new)
        data['protocol'] = 'vortex-agent/1'
        maintained = self.root / 'maintained'
        maintained.mkdir()
        (maintained / 'bridge.mjs').write_bytes(b'changed source')
        data.update(maintainedSource=str(maintained), sources={'bridge.mjs': '0' * 64})
        provenance.write_text(json.dumps(data))
        with self.assertRaisesRegex(RuntimeError, 'source provenance'):
            upgrade.sync_provenance(self.new)
        self.assertEqual(receipt.read_bytes(), original)

    def test_metadata_sync_atomic_replace_failure_preserves_exact_old_metadata(self):
        receipt = self.matching_target()
        original = receipt.read_bytes()
        source = self.source / 'provenance.json'
        data = json.loads(source.read_text())
        data['evidence'] = 'new synthetic metadata'
        source.write_text(json.dumps(data))
        with patch.object(upgrade.os, 'replace', side_effect=OSError('synthetic replace failure')):
            with self.assertRaisesRegex(OSError, 'replace failure'):
                upgrade.sync_provenance(self.new)
        self.assertEqual(receipt.read_bytes(), original)
        self.assertEqual({p.name for p in receipt.parent.iterdir()}, {'index.js', 'LICENSE.md', 'THIRD-PARTY-NOTICES.md', 'info.json', 'provenance.json'})

    def test_metadata_sync_rechecks_maintained_sources_after_staging_metadata(self):
        receipt = self.matching_target()
        original = receipt.read_bytes()
        maintained = self.root / 'maintained'
        maintained.mkdir()
        source = maintained / 'bridge.mjs'
        source.write_bytes(b'original source')
        metadata = self.source / 'provenance.json'
        value = json.loads(metadata.read_text())
        value.update(maintainedSource=str(maintained), sources={'bridge.mjs': upgrade.sha(source)})
        metadata.write_text(json.dumps(value))
        actual = upgrade.os.fsync
        calls = 0
        def fsync(descriptor):
            nonlocal calls
            calls += 1
            actual(descriptor)
            if calls == 2:
                source.write_bytes(b'changed during metadata staging')
        with patch.object(upgrade.os, 'fsync', fsync):
            with self.assertRaisesRegex(RuntimeError, 'source provenance'):
                upgrade.sync_provenance(self.new)
        self.assertEqual(receipt.read_bytes(), original)

    def test_metadata_sync_refuses_concurrent_installer_and_preserves_its_lock(self):
        receipt = self.matching_target()
        original = receipt.read_bytes()
        locks = self.root / 'upgrades'
        locks.mkdir()
        lock = locks / 'install.lock'
        lock.write_bytes(b'synthetic other owner')
        with self.assertRaises(FileExistsError):
            upgrade.sync_provenance(self.new)
        self.assertEqual(lock.read_bytes(), b'synthetic other owner')
        self.assertEqual(receipt.read_bytes(), original)

    def test_metadata_sync_success_preserves_receipts_bundle_and_unrelated_files(self):
        receipt = self.matching_target()
        marker = self.marker.read_bytes()
        data = json.loads((self.source / 'provenance.json').read_text())
        data['evidence'] = 'new verified metadata'
        (self.source / 'provenance.json').write_text(json.dumps(data))
        upgrade.sync_provenance(self.new)
        self.assertEqual(receipt.read_bytes(), (self.source / 'provenance.json').read_bytes())
        self.assertEqual(upgrade.sha(receipt.parent / 'index.js'), self.new)
        self.assertEqual(self.marker.read_bytes(), marker)
        self.assertEqual((self.plugins / 'unrelated/sentinel').read_bytes(), b'untouched')
        self.assertFalse((self.root / 'upgrades/install.lock').exists())

    def test_external_metadata_sync_uses_exact_matching_bundle_and_original_runtime(self):
        target = self.matching_target()
        metadata = self.source / 'provenance.json'
        data = json.loads(metadata.read_text()); data['evidence'] = 'external verified source package'
        metadata.write_text(json.dumps(data))
        before = {str(p): p.read_bytes() for p in self.plugins.rglob('*') if p.is_file()}
        receipts = upgrade.receipt_pins()
        # The default build is a different historical bundle. It must not be
        # copied, inspected as our source or used to select a receipt workspace.
        historical = self.root / 'historical-build'
        package(historical, '1.0.4', b'different historical default bundle')
        with patch.object(upgrade, 'SOURCE', historical), patch.object(upgrade, 'stopped', side_effect=AssertionError('metadata-only')):
            upgrade.sync_provenance(self.new, package_root=str(self.source))
        self.assertEqual(target.read_bytes(), metadata.read_bytes())
        self.assertEqual(upgrade.receipt_pins(), receipts)
        for filename, raw in before.items():
            if Path(filename) != target:
                self.assertEqual(Path(filename).read_bytes(), raw)
        self.assertEqual(upgrade.sha(target.parent / 'index.js'), self.new)
        self.assertFalse((self.root / 'upgrades/install.lock').exists())

    def test_external_metadata_sync_refuses_wrong_runtime_bundle_sources_or_reparse(self):
        target = self.matching_target(); original = target.read_bytes(); receipts = upgrade.receipt_pins()
        external = self.root / 'external'
        package(external, '1.0.4', b'synthetic new bundle')
        metadata = external / 'provenance.json'; valid = json.loads(metadata.read_text())
        maintained = self.root / 'external-maintained'; maintained.mkdir()
        (maintained / 'bridge.mjs').write_bytes(b'changed maintained source')
        for name in ['runtime', 'source', 'bundle', 'schema']:
            with self.subTest(name=name):
                value = json.loads(json.dumps(valid)); metadata.write_text(json.dumps(value))
                (external / 'index.js').write_bytes(b'synthetic new bundle')
                if name == 'runtime': value['workspaceRoot'] = str(self.root / 'wrong-runtime')
                elif name == 'source': value.update(maintainedSource=str(maintained), sources={'bridge.mjs': '0' * 64})
                elif name == 'bundle': (external / 'index.js').write_bytes(b'other bundle')
                elif name == 'schema': value['packageSchemaVersion'] = 1
                metadata.write_text(json.dumps(value))
                with self.assertRaises((RuntimeError, FileNotFoundError)):
                    upgrade.sync_provenance(self.new, package_root=str(external))
                self.assertEqual(target.read_bytes(), original); self.assertEqual(upgrade.receipt_pins(), receipts)
        metadata.write_text(json.dumps(valid)); (external / 'index.js').write_bytes(b'synthetic new bundle')
        alias = self.root / 'external-alias'; alias.symlink_to(external, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, 'Reparse'):
            upgrade.sync_provenance(self.new, package_root=str(alias))
        self.assertEqual(target.read_bytes(), original); self.assertEqual(upgrade.receipt_pins(), receipts)
        with self.assertRaisesRegex(RuntimeError, 'absolute path'):
            upgrade.sync_provenance(self.new, package_root='relative/package')

    def test_external_metadata_sync_still_refuses_installed_bundle_mismatch(self):
        target = self.plugins / 'vortex-agent/provenance.json'
        original = target.read_bytes(); receipts = upgrade.receipt_pins()
        with self.assertRaisesRegex(RuntimeError, 'bundle pin mismatch'):
            upgrade.sync_provenance(self.new, package_root=str(self.source))
        self.assertEqual(target.read_bytes(), original); self.assertEqual(upgrade.receipt_pins(), receipts)

    def test_package_root_cli_scope_includes_metadata_sync_only_with_install_and_upgrade(self):
        with patch.object(upgrade, 'sync_provenance') as sync:
            upgrade.main(['sync-provenance', '--expected-sha', self.new, '--package-root', str(self.source)])
        sync.assert_called_once_with(self.new, package_root=str(self.source))
        for operation, labels in [('snapshot', ['one']), ('compare', ['one', 'two'])]:
            for root in [str(self.source), '']:
                with self.subTest(operation=operation, root=root), patch.object(upgrade, operation) as invoke:
                    with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
                        upgrade.main([operation, *labels, '--package-root', root])
                    self.assertEqual(error.exception.code, 2); invoke.assert_not_called()

    def test_installer_lock_cleanup_does_not_delete_a_replacement_owner(self):
        with self.assertRaisesRegex(RuntimeError, 'ownership changed'):
            with upgrade.install_lock():
                (self.root / 'upgrades/install.lock').write_bytes(b'synthetic replacement owner')
        self.assertEqual((self.root / 'upgrades/install.lock').read_bytes(), b'synthetic replacement owner')

    def test_maintained_source_changed_during_staging_refuses_swap(self):
        maintained = self.root / 'maintained'
        maintained.mkdir()
        source = maintained / 'bridge.mjs'
        source.write_bytes(b'original source')
        data = json.loads((self.source / 'provenance.json').read_text())
        data.update(maintainedSource=str(maintained), sources={'bridge.mjs': upgrade.sha(source)})
        (self.source / 'provenance.json').write_text(json.dumps(data))
        calls = 0
        def stopped():
            nonlocal calls
            calls += 1
            if calls == 2:
                source.write_bytes(b'changed source')
        with patch.object(upgrade, 'stopped', stopped):
            with self.assertRaisesRegex(RuntimeError, 'source provenance'):
                upgrade.install(self.new, self.old)
        self.assertEqual(upgrade.sha(self.plugins / 'vortex-agent/index.js'), self.old)


class ProcessGuardTests(unittest.TestCase):
    def result(self, names=None):
        names = ['explorer.exe'] if names is None else names
        return upgrade.subprocess.CompletedProcess([], 0,
            json.dumps({'schema': 1, 'complete': True, 'count': len(names), 'names': names}), '')

    def invoke(self, result):
        with patch.object(upgrade.shutil, 'which', return_value=str(MODULE.with_name('node.exe'))), \
            patch.object(upgrade.subprocess, 'run', return_value=result) as run:
            upgrade.stopped()
            return run

    def test_uses_absolute_maintained_guard_in_hidden_bounded_node_process(self):
        run = self.invoke(self.result())
        args, kwargs = run.call_args
        self.assertTrue(Path(args[0][0]).is_absolute())
        self.assertEqual(args[0][-1], str(MODULE.resolve().with_name('guard.cjs')))
        self.assertIn('.processNames()', args[0][2])
        self.assertEqual(kwargs['timeout'], 15)
        self.assertEqual(kwargs['creationflags'], upgrade.subprocess.CREATE_NO_WINDOW if upgrade.os.name == 'nt' else 0)

    def test_all_protected_processes_are_refused_case_insensitively(self):
        for name in ['Vortex.exe', 'Cyberpunk2077.exe', 'REDprelauncher.exe', 'ACU.exe', 'SkyrimSE.exe',
            'SkyrimVR.exe', 'skse64_loader.exe', 'sksevr_loader.exe', 'Fallout4.exe', 'f4se_loader.exe']:
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, 'still running'):
                self.invoke(self.result([name.swapcase()]))

    def test_each_call_enumerates_fresh_instead_of_caching_absence(self):
        with patch.object(upgrade.shutil, 'which', return_value=str(MODULE.with_name('node.exe'))), \
            patch.object(upgrade.subprocess, 'run', side_effect=[self.result(), self.result(['Vortex.exe'])]) as run:
            upgrade.stopped()
            with self.assertRaisesRegex(RuntimeError, 'still running'):
                upgrade.stopped()
        self.assertEqual(run.call_count, 2)

    def test_malformed_or_incomplete_snapshot_is_never_proof_of_stopped_processes(self):
        valid = json.loads(self.result().stdout)
        snapshots = [None, [], {}, {**valid, 'schema': True}, {**valid, 'schema': 2},
            {**valid, 'complete': False}, {**valid, 'complete': 1}, {**valid, 'count': True},
            {**valid, 'count': 0}, {**valid, 'count': 2}, {**valid, 'extra': True},
            {**valid, 'names': 'explorer.exe'}, {**valid, 'names': [None]},
            {**valid, 'names': ['']}, {**valid, 'names': ['a' * 261]},
            {**valid, 'names': ['C:/Vortex.exe']}, {**valid, 'names': ['Vortex.exe\n']}]
        for value in snapshots:
            with self.subTest(snapshot=value), self.assertRaisesRegex(RuntimeError, 'Unverifiable'):
                self.invoke(upgrade.subprocess.CompletedProcess([], 0, json.dumps(value), ''))
        for value in ['', '{bad json', ' ' * (1024 * 1024 + 1)]:
            with self.subTest(output_length=len(value)), self.assertRaisesRegex(RuntimeError, 'Unverifiable'):
                self.invoke(upgrade.subprocess.CompletedProcess([], 0, value, ''))

    def test_nonzero_exit_or_stderr_refuses_even_with_plausible_snapshot(self):
        for code, stderr in [(1, ''), (0, 'warning'), (-1, 'failure')]:
            with self.subTest(code=code, stderr=stderr), self.assertRaisesRegex(RuntimeError, 'Unverifiable'):
                self.invoke(upgrade.subprocess.CompletedProcess([], code, self.result().stdout, stderr))

    def test_missing_node_or_failed_timed_out_process_refuses(self):
        with patch.object(upgrade.shutil, 'which', return_value=None), \
            patch.object(upgrade.subprocess, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'Unverifiable'):
                upgrade.stopped()
            run.assert_not_called()
        for failure in [OSError('unavailable'), upgrade.subprocess.TimeoutExpired('node', 15),
            UnicodeDecodeError('utf-8', b'\xff', 0, 1, 'invalid')]:
            with self.subTest(failure=type(failure).__name__), \
                patch.object(upgrade.shutil, 'which', return_value=str(MODULE.with_name('node.exe'))), \
                patch.object(upgrade.subprocess, 'run', side_effect=failure):
                with self.assertRaisesRegex(RuntimeError, 'Unverifiable'):
                    upgrade.stopped()


if __name__ == '__main__':
    unittest.main()
