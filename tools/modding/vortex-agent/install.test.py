"""Synthetic installation paths only; never touches the active plugin/processes."""
import hashlib
import importlib.util
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
        'pluginSha256': digest, 'sources': {}, 'maintainedSource': str(directory), 'installSupported': False}
    if not historical:
        (directory / 'THIRD-PARTY-NOTICES.md').write_text('Synthetic dependency notice', encoding='utf-8')
        provenance.update(packageSchemaVersion=2,
            licenseFileSHA256={name: upgrade.sha(directory / name) for name in ['LICENSE.md', 'THIRD-PARTY-NOTICES.md']},
            sourceOffer={'repository': 'https://github.com/Antrakt92/Nexus-Modding-Tools'})
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
        value = json.loads(metadata.read_text()); value['sourceOffer']['repository'] = 'https://example.invalid/foreign'
        metadata.write_text(json.dumps(value))
        with self.assertRaisesRegex(RuntimeError, 'source repository contract'):
            upgrade.install(self.new, self.old)

    def test_metadata_sync_refuses_foreign_plugin_identity(self):
        receipt = self.matching_target()
        original = receipt.read_bytes()
        info = self.plugins / 'vortex-agent/info.json'
        info.write_text(json.dumps({'id': 'foreign-plugin', 'version': '1.0.4'}))
        with self.assertRaisesRegex(RuntimeError, 'identity'):
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


if __name__ == '__main__':
    unittest.main()
