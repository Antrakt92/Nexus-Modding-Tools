"""Opt-in actual fixed-extractor tests; only new own ZIP/scratch paths.

Set VORTEX_OWNED_EXTRACTOR_TEST=1. No Vortex application or managed files,
installation endpoint, automatic retry, deletion or game launch is involved.
"""
import ctypes
import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import uuid
import zipfile

HERE = Path(__file__).absolute().parent
ROOT = HERE.parents[2]/'local-state/owned-extractor-process-tests'
ENABLED = os.name == 'nt' and ctypes.sizeof(ctypes.c_void_p) == 8 and os.environ.get('VORTEX_OWNED_EXTRACTOR_TEST') == '1'
if ENABLED:
    spec = importlib.util.spec_from_file_location('owned_extractor_test_custody', HERE/'owned-file-transfer.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)


@unittest.skipUnless(ENABLED, 'Opt-in Windows x64: VORTEX_OWNED_EXTRACTOR_TEST=1')
class OwnedExtractorProcessTests(unittest.TestCase):
    def setUp(self):
        for node in (ROOT, *ROOT.parents):
            if node.exists():
                self.assertFalse(node.lstat().st_file_attributes & 0x400)
        ROOT.mkdir(parents=True, exist_ok=True)
        self.run = Path(tempfile.mkdtemp(prefix='run-', dir=ROOT))
        self.archives, self.temps, self.final = (self.run/name for name in ('archives', 'temps', 'final'))
        for directory in (self.archives, self.temps, self.final):
            directory.mkdir()
        self.payload = b'own process fixture payload\n'*4096
        self.archive = self.archives/'own.zip'
        with zipfile.ZipFile(self.archive, 'x', zipfile.ZIP_DEFLATED) as output:
            output.writestr('payload.bin', self.payload)
        self.binding = {'operationId': 'op_'+uuid.uuid4().hex, 'nativeJobId': 'exec_'+uuid.uuid4().hex,
                        'requestSHA256': hashlib.sha256(self.archive.read_bytes()).hexdigest(),
                        'rendererGeneration': 'renderer_'+uuid.uuid4().hex}
        self.lease = module.ArchiveTempLease(self.binding, str(self.archives), self.identity(self.archives),
            'own.zip', self.identity(self.archive), self.archive.stat().st_size,
            hashlib.sha256(self.archive.read_bytes()).hexdigest(), str(self.temps), self.identity(self.temps), 'Extract')
        self.owner = None
        self.borrow = None
        self.addCleanup(self.release_own_resources)

    def identity(self, file):
        observed = file.stat()
        return {'schema': module.IDENTITY_SCHEMA, 'volumeSerialNumber': str(observed.st_dev), 'fileId': str(observed.st_ino)}

    def finish(self):
        deadline = time.monotonic()+10
        while True:
            status = self.owner.poll()
            if status['terminalObserved']:
                return status
            if time.monotonic() >= deadline:
                self.fail('Exact own process/pipes did not reach observed terminal; owner retained')
            time.sleep(0.001)

    def release_own_resources(self):
        if self.borrow is not None:
            self.borrow.close()
        if self.owner is not None and not self.owner.status()['closed']:
            try:
                self.owner.close()
            except Exception:
                # Only this opaque owner's own Job can be terminated. No PID/name
                # selection, replacement owner, retry or partial-output deletion.
                self.owner.terminate()
                self.finish()
                self.owner.close()
        self.lease.close()

    def create(self, acquire=True):
        if acquire:
            self.lease.acquire()
        self.owner = self.lease.create_extractor()
        return self.owner

    def no_permit(self, status):
        for field in ('effectsAllowed', 'persistenceVerified', 'nativeInstallAccepted'):
            self.assertIs(status[field], False)

    def test_factory_is_inert_single_use_and_status_binding_is_detached(self):
        with patch.object(module, '_EXTRACTOR_FACTORY', None), \
             patch.object(ctypes, 'WinDLL', side_effect=AssertionError('Factory called WinDLL')):
            owner = self.create(acquire=False)
            status = owner.status()
        self.assertFalse((self.temps/'Extract').exists())
        self.assertFalse(status['startAttempted'])
        self.assertEqual(status['retainedHandles'], 0)
        self.no_permit(status)
        status['binding']['operationId'] = 'changed'
        self.assertEqual(owner.status()['binding'], self.binding)
        with self.assertRaises(Exception):
            self.lease.create_extractor()
        owner.close()
        with self.assertRaises(Exception):
            owner.start()

    def test_actual_extraction_retains_custody_until_process_close_then_borrows_root(self):
        owner = self.create()
        owner.start()
        self.assertTrue(owner.status()['startAttempted'])
        self.assertFalse(owner.status()['resumed'])
        with self.assertRaises(Exception):
            self.lease.close()
        with self.assertRaises(Exception):
            owner.close()
        self.assertFalse(owner.status()['cancelled'])
        self.assertFalse(owner.status()['poisoned'])
        self.assertIsNone(owner.status()['errorCode'])
        owner.resume()
        status = self.finish()
        self.assertEqual(status['exitCode'], 0)
        self.assertTrue(status['processTerminalObserved'])
        self.assertTrue(status['stdoutEOF'] and status['stderrEOF'])
        self.no_permit(status)
        self.assertEqual((self.temps/'Extract/payload.bin').read_bytes(), self.payload)
        with self.assertRaises(Exception):
            self.lease.close()
        owner.close()
        self.assertTrue(owner.status()['closed'])
        self.assertEqual(owner.status()['retainedHandles'], 0)
        self.borrow = self.lease.begin_transfer(str(self.final), self.identity(self.final), 'Owned')
        self.borrow.transfer('payload.bin', 'payload.bin', len(self.payload), hashlib.sha256(self.payload).hexdigest())
        self.assertEqual((self.final/'Owned/payload.bin').read_bytes(), self.payload)

    def test_cancelled_suspended_owner_never_qualifies_for_transfer_or_retry(self):
        owner = self.create()
        owner.start()
        owner.terminate()
        status = self.finish()
        self.assertTrue(status['cancelled'])
        self.assertFalse(status['resumed'])
        self.no_permit(status)
        owner.close()
        for action in (owner.start, owner.resume, self.lease.create_extractor):
            with self.assertRaises(Exception):
                action()
        with self.assertRaises(Exception):
            self.lease.begin_transfer(str(self.final), self.identity(self.final), 'Foreign')
        self.assertFalse((self.final/'Foreign').exists())

    def test_inert_closed_owner_cannot_fall_back_to_external_handoff(self):
        owner = self.create()
        owner.close()
        (self.temps/'Extract/payload.bin').write_bytes(self.payload)
        with self.assertRaises(Exception):
            self.lease.begin_transfer(str(self.final), self.identity(self.final), 'Foreign')
        self.assertFalse((self.final/'Foreign').exists())

    def test_existing_foreign_temp_file_refuses_before_extraction(self):
        owner = self.create()
        target = self.temps/'Extract/payload.bin'
        target.write_bytes(b'foreign bytes must survive')
        with self.assertRaises(Exception) as caught:
            owner.start()
        self.assertIs(caught.exception.owner, owner)
        self.assertIs(caught.exception.lease, self.lease)
        self.assertEqual(target.read_bytes(), b'foreign bytes must survive')
        self.assertTrue(owner.status()['poisoned'])
        self.assertEqual(owner.status()['errorCode'], 'TEMP_NOT_EMPTY')
        owner.close()
        with self.assertRaises(Exception):
            self.lease.begin_transfer(str(self.final), self.identity(self.final), 'Foreign')

    def test_wrong_thread_fails_before_start_without_acquiring_native_resources(self):
        owner = self.create()
        errors = []
        def attempt():
            try:
                owner.start()
            except BaseException as error:
                errors.append(error)
        worker = threading.Thread(target=attempt)
        worker.start()
        worker.join(timeout=2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(errors), 1)
        self.assertFalse(owner.status()['startAttempted'])
        self.assertEqual(owner.status()['retainedHandles'], 0)

    def test_interruption_after_kernel_process_create_retains_exact_child_for_abort(self):
        owner = self.create()
        scope = owner.start.__func__.__globals__
        kernel = scope['api']()
        actual_create = kernel.CreateProcessW
        created = []
        def interrupted(*args):
            result = actual_create(*args)
            if result:
                created.append(True)
                raise KeyboardInterrupt()
            return result
        with patch.object(kernel, 'CreateProcessW', interrupted), patch.dict(scope, {'api': lambda: kernel}):
            with self.assertRaises(KeyboardInterrupt) as caught:
                owner.start()
        self.assertEqual(created, [True])
        self.assertIs(caught.exception.owner, owner)
        self.assertIs(caught.exception.lease, self.lease)
        self.assertTrue(owner.status()['poisoned'])
        self.assertTrue(owner.status()['processCreationAttempted'])
        self.assertEqual(owner.status()['errorCode'], 'INTERRUPTED')
        self.assertGreater(owner.status()['retainedHandles'], 0)
        with self.assertRaises(Exception):
            self.lease.close()
        owner.terminate()
        self.assertTrue(self.finish()['terminalObserved'])
        owner.close()
        self.assertEqual(owner.status()['errorCode'], 'INTERRUPTED')
        with self.assertRaises(Exception):
            self.lease.begin_transfer(str(self.final), self.identity(self.final), 'Foreign')
        self.assertFalse((self.final/'Foreign').exists())

    def test_interrupted_writer_close_still_releases_later_known_writer_copies(self):
        owner = self.create()
        original, calls = module._K.CloseHandle, []
        def interrupted_once(handle):
            calls.append(handle)
            if len(calls) == 1:
                raise KeyboardInterrupt()  # Native close was NOT called.
            return original(handle)
        uncertain = None
        try:
            with patch.object(module._K, 'CloseHandle', interrupted_once):
                with self.assertRaises(KeyboardInterrupt):
                    owner.start()
                uncertain = next(entry for entry in owner._handles if entry.phase == 'close-uncertain')
                owner.terminate()
                deadline = time.monotonic()+10
                while True:
                    status = owner.poll()
                    if status['processTerminalObserved'] and status['stderrEOF']:
                        break
                    if time.monotonic() >= deadline:
                        self.fail('Later known stderr writer was not released after first writer interruption')
                    time.sleep(0.001)
                self.assertFalse(status['stdoutEOF'])  # The intentionally held writer is still really open.
                self.assertTrue(status['closeUncertain'])
                self.assertEqual(calls.count(uncertain.cell.value), 1)
        finally:
            if uncertain is not None:
                # Test-only recovery is valid solely because this injection did
                # NOT invoke the first native close. Production cannot make it.
                uncertain.phase = 'open'
        self.assertTrue(self.finish()['terminalObserved'])
        owner.close()

    def test_partial_close_never_polls_or_terminates_through_stale_handle_cells(self):
        owner = self.create()
        owner.start()
        owner.resume()
        self.finish()
        original, failed = module._K.CloseHandle, []
        def interrupted_once(handle):
            if not failed:
                failed.append(handle)
                raise KeyboardInterrupt()  # Native close was NOT called.
            return original(handle)
        uncertain = None
        try:
            with patch.object(module._K, 'CloseHandle', interrupted_once):
                with self.assertRaises(KeyboardInterrupt):
                    owner.close()
            uncertain = next(entry for entry in owner._handles if entry.phase == 'close-uncertain')
            self.assertTrue(owner.status()['closeUncertain'])
            with patch.object(owner._kernel, 'WaitForSingleObject', side_effect=AssertionError('Stale process wait')), \
                 patch.object(owner._kernel, 'PeekNamedPipe', side_effect=AssertionError('Stale pipe peek')), \
                 patch.object(owner._kernel, 'ReadFile', side_effect=AssertionError('Stale pipe read')), \
                 patch.object(owner._kernel, 'TerminateJobObject', side_effect=AssertionError('Stale job termination')):
                self.assertTrue(owner.poll()['terminalObserved'])
                self.assertTrue(owner.terminate()['cancelled'])
            with self.assertRaises(Exception):
                self.lease.close()
        finally:
            if uncertain is not None:
                # No native close occurred in the injected call; this does not
                # acknowledge an ambiguous real close or retry a reused handle.
                uncertain.phase = 'open'
        owner.close()

    def test_uncaptured_scalar_handle_refuses_close_and_never_grants_handoff(self):
        owner = self.create()
        scope = owner.start.__func__.__globals__
        kernel = scope['api']()
        actual_create = kernel.CreateJobObjectW
        observed = []
        def lost_return(*args):
            handle = actual_create(*args)
            self.assertTrue(handle)
            observed.append(handle)  # Fixture-only witness; production loses it.
            raise KeyboardInterrupt()
        try:
            with patch.object(kernel, 'CreateJobObjectW', lost_return), patch.dict(scope, {'api': lambda: kernel}):
                with self.assertRaises(KeyboardInterrupt):
                    owner.start()
            self.assertEqual(len(observed), 1)
            self.assertTrue(owner.status()['closeUncertain'])
            self.assertFalse(owner.status()['processCreationAttempted'])
            self.assertEqual(owner.status()['errorCode'], 'INTERRUPTED')
            for action in (owner.start, owner.resume, owner.close, self.lease.close):
                with self.assertRaises(Exception):
                    action()
            self.no_permit(owner.status())
            with self.assertRaises(Exception):
                self.lease.begin_transfer(str(self.final), self.identity(self.final), 'Foreign')
        finally:
            if observed:
                # Only this fixture witnessed the exact successful return. Do
                # not retry a lost allocation or acknowledge it in production.
                entry = owner._allocation_pending
                entry.cell.value = observed[0]
                entry.phase = 'open'
                owner._allocation_pending = None
                owner._unknown_allocation = False
        owner.close()

    def test_completed_attribute_delete_interruption_never_retries_native_delete(self):
        owner = self.create()
        scope = owner.start.__func__.__globals__
        kernel = scope['api']()
        actual_delete = kernel.DeleteProcThreadAttributeList
        completed = []
        def interrupted_delete(*args):
            actual_delete(*args)
            completed.append(True)
            raise KeyboardInterrupt()
        try:
            with patch.object(kernel, 'DeleteProcThreadAttributeList', interrupted_delete), patch.dict(scope, {'api': lambda: kernel}):
                with self.assertRaises(KeyboardInterrupt):
                    owner.start()
            owner.terminate()
            self.assertTrue(self.finish()['terminalObserved'])
            with patch.object(kernel, 'DeleteProcThreadAttributeList', side_effect=AssertionError('Repeated ambiguous delete')):
                with self.assertRaises(Exception):
                    owner.close()
            self.assertEqual(completed, [True])
            self.assertTrue(owner.status()['closeUncertain'])
            self.assertIsNotNone(owner._inherit_storage)
            self.assertIsNotNone(owner._jobs_storage)
            self.no_permit(owner.status())
        finally:
            if completed:
                # Exact native completion is known only to this fault fixture.
                # Production retains the uncertain list and its value buffers.
                owner._attributes_initialized = False
                owner._attributes_uncertain = False
                owner._attributes = None
                owner._inherit_storage = owner._jobs_storage = None
        owner.close()

    def test_actual_pipe_overflow_poisons_owner_and_requires_explicit_abort(self):
        owner = self.create()
        owner.start()
        owner.resume()
        scope = owner.start.__func__.__globals__
        with patch.dict(scope, {'OUTPUT_LIMIT': 1}):
            with self.assertRaises(Exception) as caught:
                self.finish()
        self.assertEqual(caught.exception.code, 'OUTPUT_LIMIT')
        self.assertTrue(owner.status()['stdoutOutputLimitExceeded'] or owner.status()['stderrOutputLimitExceeded'])
        self.assertTrue(owner.status()['poisoned'])
        self.assertFalse(owner.status()['cancelled'])
        owner.terminate()
        self.assertTrue(self.finish()['terminalObserved'])
        owner.close()
        self.assertEqual(owner.status()['errorCode'], 'OUTPUT_LIMIT')
        with self.assertRaises(Exception):
            self.lease.begin_transfer(str(self.final), self.identity(self.final), 'Foreign')

    def test_attribute_value_buffers_survive_interrupted_update_until_confirmed_delete(self):
        owner = self.create()
        scope = owner.start.__func__.__globals__
        kernel = scope['api']()
        actual_update = kernel.UpdateProcThreadAttribute
        retained = []
        def interrupted_update(*args):
            result = actual_update(*args)
            if result and args[2] == 0x20002:
                retained.extend((owner._inherit_storage, owner._jobs_storage))
                raise KeyboardInterrupt()
            return result
        with patch.object(kernel, 'UpdateProcThreadAttribute', interrupted_update), patch.dict(scope, {'api': lambda: kernel}):
            with self.assertRaises(KeyboardInterrupt):
                owner.start()
        self.assertEqual(len(retained), 2)
        self.assertIs(owner._inherit_storage, retained[0])
        self.assertIs(owner._jobs_storage, retained[1])
        self.assertFalse(owner.status()['processCreationAttempted'])
        actual_delete = kernel.DeleteProcThreadAttributeList
        deleted = []
        def delete_with_live_values(*args):
            self.assertIs(owner._inherit_storage, retained[0])
            self.assertIs(owner._jobs_storage, retained[1])
            deleted.append(True)
            return actual_delete(*args)
        with patch.object(kernel, 'DeleteProcThreadAttributeList', delete_with_live_values):
            owner.close()
        self.assertEqual(deleted, [True])
        self.assertIsNone(owner._inherit_storage)
        self.assertIsNone(owner._jobs_storage)
        self.assertTrue(owner.status()['closed'])


if __name__ == '__main__':
    unittest.main()
