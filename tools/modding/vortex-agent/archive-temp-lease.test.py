"""Native own scratch custody tests; no extractor, Vortex or managed paths."""
import ctypes
import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

HERE = Path(__file__).absolute().parent
ROOT = HERE.parents[2]/'local-state/install-contract-20261031/archive-temp-lease-tests'
if os.name == 'nt':
    spec = importlib.util.spec_from_file_location('archive_temp_lease_test_owner', HERE/'owned-file-transfer.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)


@unittest.skipUnless(os.name == 'nt', 'Windows x64 native handles required')
class ArchiveTempLeaseTests(unittest.TestCase):
    def setUp(self):
        for path in [ROOT, *ROOT.parents]:
            if path.exists():
                self.assertFalse(path.lstat().st_file_attributes & 0x400)
        ROOT.mkdir(parents=True, exist_ok=True)
        self.root = Path(tempfile.mkdtemp(prefix='run-', dir=ROOT))
        self.archives, self.temps, self.final = (self.root/name for name in ('archives', 'temps', 'final'))
        for path in (self.archives, self.temps, self.final):
            path.mkdir()
        self.archive = self.archives/'own.zip'
        with zipfile.ZipFile(self.archive, 'w') as output:
            output.writestr('payload.bin', b'own bounded payload')
        self.binding = {'operationId': 'op_'+'1'*32, 'nativeJobId': 'exec_'+'2'*32,
                        'requestSHA256': '3'*64, 'rendererGeneration': 'renderer_'+'4'*32}
        self.leases = []
        self.addCleanup(self.close_all)

    def close_all(self):
        for lease in reversed(self.leases):
            lease.close()

    def identity(self, path):
        observed = path.stat()
        return {'schema': module.IDENTITY_SCHEMA, 'volumeSerialNumber': str(observed.st_dev), 'fileId': str(observed.st_ino)}

    def lease(self, **changes):
        data = self.archive.read_bytes()
        args = dict(binding=self.binding, archive_parent=str(self.archives), archive_parent_identity=self.identity(self.archives),
                    archive_leaf=self.archive.name, archive_identity=self.identity(self.archive), expected_size=len(data),
                    expected_sha256=hashlib.sha256(data).hexdigest(), temp_parent=str(self.temps),
                    temp_parent_identity=self.identity(self.temps), temp_leaf='Extract')
        args.update(changes)
        lease = module.ArchiveTempLease(**args)
        self.leases.append(lease)
        return lease

    def borrow(self, lease):
        child = lease.begin_transfer(str(self.final), self.identity(self.final), 'Owned')
        self.leases.append(child)
        return child

    def test_inert_closed_binding_and_detached_claims(self):
        lease = self.lease()
        self.binding['operationId'] = 'changed'
        state = lease.status()
        self.assertEqual(state['binding']['operationId'], 'op_'+'1'*32)
        state['binding']['operationId'] = 'changed again'
        self.assertEqual(lease.status()['binding']['operationId'], 'op_'+'1'*32)
        self.assertEqual(set(state['binding']), {'operationId', 'nativeJobId', 'requestSHA256', 'rendererGeneration'})
        self.assertEqual(lease.status()['retainedHandles'], 0)
        self.assertFalse((self.temps/'Extract').exists())
        self.binding['operationId'] = 'op_'+'1'*32
        for key in ('effectsAllowed', 'persistenceVerified', 'nativeInstallAccepted', 'nativeTerminalVerified'):
            self.assertFalse(lease.status()[key])
        for bad in ({}, {'operationId': 'op_'+'1'*32}, {**self.binding, 'extra': True}):
            with self.assertRaisesRegex(module.OwnedTransferError, 'INVALID_BINDING'):
                self.lease(binding=bad)
        with self.assertRaisesRegex(module.OwnedTransferError, 'INVALID_PROOF'):
            self.lease(expected_size=True)
        with self.assertRaisesRegex(module.OwnedTransferError, 'INVALID_PROOF'):
            self.lease(expected_size=64*1024*1024+1)

    def test_archive_and_hardlink_writes_rename_and_ancestors_are_fenced(self):
        alias = self.archives/'alias.zip'
        os.link(self.archive, alias)
        lease = self.lease()
        lease.acquire()
        for path in (self.archive, alias):
            with self.assertRaises(OSError):
                path.write_bytes(b'changed')
        with self.assertRaises(OSError):
            self.archive.rename(self.archive.with_suffix('.moved'))
        for path in (self.temps/'Extract', self.temps, self.archives, self.root):
            with self.assertRaises(OSError):
                path.rename(path.with_name(path.name+'-moved'))
        lease.close()
        alias.write_bytes(b'released')

    def test_bad_archive_proofs_refuse_before_temp_creation(self):
        for changes in ({'expected_sha256': 'a'*64}, {'expected_size': 1},
                        {'archive_identity': self.identity(self.archives)}):
            lease = self.lease(**changes)
            with self.assertRaisesRegex(module.OwnedTransferError, 'ARCHIVE_MISMATCH'):
                lease.acquire()
            self.assertTrue(lease.status()['poisoned'])
            self.assertFalse((self.temps/'Extract').exists())
            lease.close()

    def test_existing_temp_not_adopted_and_never_removed(self):
        target = self.temps/'Extract'
        target.mkdir()
        (target/'keep').write_bytes(b'foreign')
        lease = self.lease()
        with self.assertRaisesRegex(module.OwnedTransferError, 'CREATE_REFUSED'):
            lease.acquire()
        self.assertEqual((target/'keep').read_bytes(), b'foreign')
        self.assertFalse(lease.status()['acquired'])

    def test_borrow_reuses_original_handle_and_keeps_parent_fences(self):
        lease = self.lease()
        lease.acquire()
        (self.temps/'Extract/payload.bin').write_bytes(b'payload')
        observed_paths = []
        original = module.OwnedFileTransfer._existing_root
        def recorded(owner, path, pin):
            observed_paths.append(path)
            return original(owner, path, pin)
        with patch.object(module.OwnedFileTransfer, '_existing_root', recorded):
            child = self.borrow(lease)
        self.assertNotIn(str(self.temps/'Extract'), observed_paths)
        self.assertEqual(child._source_dirs[()], lease._temp_handle)
        self.assertIs(child._pool, lease._pool)
        self.assertIs(child._lock, lease._lock)
        self.assertTrue(set(id(entry) for entry in child._handles).isdisjoint(id(entry) for entry in lease._handles))
        result = child.transfer('payload.bin', 'payload.bin', 7, hashlib.sha256(b'payload').hexdigest())
        self.assertEqual((self.final/'Owned/payload.bin').read_bytes(), b'payload')
        self.assertFalse(result['effectsAllowed'])
        with self.assertRaises(OSError):
            self.archive.write_bytes(b'changed')
        before = lease.status()['retainedHandles']
        with self.assertRaisesRegex(module.OwnedTransferError, 'BORROW_ACTIVE'):
            lease.close()
        self.assertEqual(lease.status()['retainedHandles'], before)
        child.close()
        with self.assertRaises(OSError):
            (self.temps/'Extract').rename(self.temps/'renamed')
        lease.close()
        (self.temps/'Extract').rename(self.temps/'released')

    def test_no_json_terminal_or_serialized_handle_handoff(self):
        lease = self.lease()
        lease.acquire()
        with self.assertRaises(TypeError):
            lease.begin_transfer(str(self.final), self.identity(self.final), 'Owned', terminal=True)
        with self.assertRaisesRegex(module.OwnedTransferError, 'INVALID_IDENTITY'):
            lease.begin_transfer(str(self.final), {'handle': 123}, 'Owned')
        self.assertFalse((self.final/'Owned').exists())

    def test_failed_destination_acquisition_retains_reserved_borrow(self):
        (self.final/'Owned').mkdir()
        lease = self.lease()
        lease.acquire()
        with self.assertRaisesRegex(module.OwnedTransferError, 'CREATE_REFUSED') as raised:
            self.borrow(lease)
        child = raised.exception.lease
        self.assertIs(child, lease._borrow)
        self.leases.append(child)
        self.assertTrue(lease.status()['borrowActive'])
        with self.assertRaisesRegex(module.OwnedTransferError, 'BORROW_ACTIVE'):
            lease.close()
        child.close()
        lease.close()

    def test_partial_transfer_failure_keeps_borrow_and_file(self):
        lease = self.lease()
        lease.acquire()
        (self.temps/'Extract/payload.bin').write_bytes(b'payload')
        child = self.borrow(lease)
        original = module._write
        def partial(handle, data):
            original(handle, data[:2])
            raise OSError('own synthetic failure')
        with patch.object(module, '_write', partial):
            with self.assertRaises(module.OwnedTransferError) as raised:
                child.transfer('payload.bin', 'partial.bin', 7, hashlib.sha256(b'payload').hexdigest())
        self.assertIs(raised.exception.lease, child)
        self.assertEqual((self.final/'Owned/partial.bin').read_bytes(), b'pa')
        self.assertTrue(child.status()['poisoned'])
        with self.assertRaisesRegex(module.OwnedTransferError, 'BORROW_ACTIVE'):
            lease.close()
        child.close()
        lease.close()
        self.assertTrue((self.final/'Owned/partial.bin').exists())

    def test_interrupted_transfer_retains_responsible_borrow(self):
        lease = self.lease()
        lease.acquire()
        (self.temps/'Extract/payload.bin').write_bytes(b'payload')
        child = self.borrow(lease)
        with patch.object(module, '_write', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt) as raised:
                child.transfer('payload.bin', 'partial.bin', 7, hashlib.sha256(b'payload').hexdigest())
        self.assertIs(raised.exception.lease, child)
        self.assertTrue(child.status()['poisoned'])
        with self.assertRaisesRegex(module.OwnedTransferError, 'BORROW_ACTIVE'):
            lease.close()

    def test_shared_pool_cap_and_lock_cover_parent_and_borrow(self):
        lease = self.lease()
        lease.acquire()
        limit = len(lease._handles)
        with patch.object(module, 'MAX_HANDLES', limit):
            with self.assertRaisesRegex(module.OwnedTransferError, 'HANDLE_LIMIT') as raised:
                self.borrow(lease)
        child = raised.exception.lease
        self.leases.append(child)
        self.assertIs(child._pool, lease._pool)
        self.assertTrue(lease._lock.acquire(False))
        try:
            with self.assertRaisesRegex(module.OwnedTransferError, 'BUSY_OR_WRONG_THREAD'):
                child.close()
            with self.assertRaisesRegex(module.OwnedTransferError, 'BUSY_OR_WRONG_THREAD'):
                lease.close()
        finally:
            lease._lock.release()

    def test_post_acquire_interrupt_exposes_borrow_without_losing_parent(self):
        lease = self.lease()
        lease.acquire()
        original = module.OwnedFileTransfer._acquire
        def interrupted(child):
            original(child)
            raise KeyboardInterrupt
        with patch.object(module.OwnedFileTransfer, '_acquire', interrupted):
            with self.assertRaises(KeyboardInterrupt) as raised:
                self.borrow(lease)
        child = raised.exception.lease
        self.assertIs(child, lease._borrow)
        self.leases.append(child)
        self.assertTrue(child.status()['acquired'])
        self.assertTrue(child.status()['poisoned'])
        with self.assertRaisesRegex(module.OwnedTransferError, 'BORROW_ACTIVE'):
            lease.close()
        child.close()
        lease.close()

    def test_renamed_hardlink_alias_is_not_a_namespace_fence(self):
        alias = self.archives/'alias.zip'
        os.link(self.archive, alias)
        lease = self.lease()
        lease.acquire()
        # NTFS can rename an unopened hardlink name despite the canonical seal.
        moved = self.archives/'alias-moved.zip'
        try:
            alias.rename(moved)
        except OSError:
            with self.assertRaises(OSError):
                alias.write_bytes(b'changed')
        else:
            with self.assertRaises(OSError):
                moved.write_bytes(b'changed')
            self.assertEqual(self.archive.read_bytes(), moved.read_bytes())
            with self.assertRaisesRegex(module.OwnedTransferError, 'CUSTODY_CHANGED'):
                self.borrow(lease)
            self.assertFalse((self.final/'Owned').exists())

    def test_uncertain_borrow_close_prevents_parent_release(self):
        lease = self.lease()
        lease.acquire()
        child = self.borrow(lease)
        target = child._handles[-1]
        target.phase = 'close-uncertain'
        with self.assertRaisesRegex(module.OwnedTransferError, 'CLOSE_FAILED'):
            child.close()
        with self.assertRaisesRegex(module.OwnedTransferError, 'BORROW_ACTIVE'):
            lease.close()
        # Injection did not close this real handle: restore its known-owned phase
        # only in this synthetic test so all actual fixture handles are released.
        target.phase = 'open'


if __name__ == '__main__':
    unittest.main()
