"""Opt-in own scratch ZIP/NT HANDLE regressions; no Vortex or game effects."""
import ctypes
import hashlib
import importlib.util
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import uuid
import zlib

HERE = Path(__file__).absolute().parent
ROOT = HERE.parents[2]/'local-state/install-contract-20261031/owned-zip-extractor/tests'
ENABLED = os.name == 'nt' and ctypes.sizeof(ctypes.c_void_p) == 8 and os.environ.get('VORTEX_OWNED_ZIP_TEST') == '1'
if ENABLED:
    spec = importlib.util.spec_from_file_location('own_zip_test_custody', HERE/'owned-file-transfer.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def own_zip(records):
    """Own classic ZIP writer, with explicit malformed fields for negatives."""
    local, central = bytearray(), bytearray()
    for record in records:
        name = record['name'].encode('ascii')
        data = record.get('data', b'')
        method, flags = record.get('method', 8), record.get('flags', 0)
        compressor = zlib.compressobj(wbits=-15)
        packed = record.get('packed', data if method == 0 else compressor.compress(data)+compressor.flush())
        crc = record.get('crc', zlib.crc32(data))
        size = record.get('size', len(data))
        local_name = record.get('local_name', name)
        extra = record.get('extra', b'')
        offset = len(local)
        local += struct.pack('<IHHHHHIIIHH', 0x04034b50, 20, flags, method, 0, 33,
                             record.get('local_crc', crc), len(packed), size, len(local_name), len(extra))
        local += local_name+extra+packed
        central += struct.pack('<IHHHHHHIIIHHHHHII', 0x02014b50, 20, 20, flags, method, 0, 33,
                               crc, len(packed), size, len(name), len(extra), 0, 0, 0,
                               record.get('attributes', 0x10 if name.endswith(b'/') else 0), offset)
        central += name+extra
    return bytes(local+central+struct.pack('<IHHHHIIH', 0x06054b50, 0, 0, len(records), len(records),
                                           len(central), len(local), 0))


@unittest.skipUnless(ENABLED, 'Opt-in Windows x64: VORTEX_OWNED_ZIP_TEST=1')
class OwnedZipTests(unittest.TestCase):
    def setUp(self):
        for path in (ROOT, *ROOT.parents):
            if path.exists():
                self.assertFalse(path.lstat().st_file_attributes & 0x400)
        ROOT.mkdir(parents=True, exist_ok=True)
        self.root = Path(tempfile.mkdtemp(prefix='zip-', dir=ROOT))
        self.archives, self.temps, self.final = (self.root/name for name in ('archives', 'temps', 'final'))
        for path in (self.archives, self.temps, self.final):
            path.mkdir()
        self.owner = self.lease = self.borrow = None
        self.addCleanup(self.release)

    def identity(self, path):
        stat = path.stat()
        return {'schema': module.IDENTITY_SCHEMA, 'volumeSerialNumber': str(stat.st_dev), 'fileId': str(stat.st_ino)}

    def create(self, records=None, raw=None, payload=None, total=None, acquire=True):
        records = records if records is not None else [{'name': 'nested/own.bin', 'data': b'own payload'*16384}]
        raw = raw if raw is not None else own_zip(records)
        archive = self.archives/'own.zip'
        archive.write_bytes(raw)
        if payload is None:
            payload = {r['name']: digest(r.get('data', b'')) for r in records if not r['name'].endswith('/')}
        total = total if total is not None else sum(len(r.get('data', b'')) for r in records)
        binding = {'operationId': 'op_'+uuid.uuid4().hex, 'nativeJobId': 'exec_'+uuid.uuid4().hex,
                   'requestSHA256': digest(raw), 'rendererGeneration': 'renderer_'+uuid.uuid4().hex}
        self.lease = module.ArchiveTempLease(binding, str(self.archives), self.identity(self.archives),
            'own.zip', self.identity(archive), len(raw), digest(raw), str(self.temps), self.identity(self.temps), 'Extract')
        if acquire:
            self.lease.acquire()
        self.owner = self.lease.create_zip_extractor(payload, total)
        return self.owner

    def release(self):
        if self.borrow is not None:
            self.borrow.close()
        if self.owner is not None and not self.owner.status()['closed']:
            state = self.owner.status()
            if not state['completed'] and not state['cancelled'] and not state['poisoned']:
                self.owner.cancel()
            self.owner.close()
        if self.lease is not None:
            self.lease.close()

    def finish(self):
        limit = time.monotonic()+10
        steps = 0
        while not self.owner.status()['completed']:
            before = self.owner.status()['writtenBytes']
            self.owner.pump()
            advanced = self.owner.status()['writtenBytes']-before
            self.assertGreaterEqual(advanced, 0)
            self.assertLessEqual(advanced, 65536)
            steps += 1
            if steps > 20000 or time.monotonic() > limit:
                self.fail('Bounded own ZIP fixture did not complete')
        return self.owner.status()

    def deny_handoff(self):
        with self.assertRaises(Exception):
            self.lease.begin_transfer(str(self.final), self.identity(self.final), 'Forbidden')
        self.assertFalse((self.final/'Forbidden').exists())

    def no_permit(self):
        state = self.owner.status()
        for name in ('effectsAllowed', 'nativeInstallAccepted', 'persistenceVerified'):
            self.assertIs(state[name], False)
        for name in ('exitCode', 'processTerminalObserved', 'stdoutEOF', 'stderrEOF'):
            self.assertNotIn(name, state)

    def test_inert_detached_factory_and_one_attempt_across_both_backends(self):
        payload = {'nested/own.bin': digest(b'own payload'*16384)}
        owner = self.create(payload=payload, acquire=False)
        payload['nested/own.bin'] = '0'*64
        self.assertFalse((self.temps/'Extract').exists())
        self.assertFalse(owner.status()['startAttempted'])
        state = owner.status()
        state['binding']['operationId'] = 'changed'
        self.assertNotEqual(owner.status()['binding']['operationId'], 'changed')
        for call in (self.lease.create_extractor,
                     lambda: self.lease.create_zip_extractor({}, 1), owner.start):
            with self.assertRaises(Exception):
                call()
        self.lease.acquire()
        owner.start()
        self.finish()
        self.no_permit()

    def test_stored_deflated_empty_and_explicit_dirs_use_original_sealed_handles(self):
        records = [{'name': 'nested/', 'method': 0},
                   {'name': 'nested/one.bin', 'data': b'A'*150000, 'method': 0},
                   {'name': 'nested/two.bin', 'data': b'B'*180000, 'method': 8},
                   {'name': 'zero.bin', 'data': b'', 'method': 0}]
        owner = self.create(records)
        owner.start()
        self.deny_handoff()
        with self.assertRaises(Exception):
            owner.close()
        with self.assertRaises(Exception):
            self.lease.close()
        before = owner.status()['writtenBytes']
        owner.pump()
        self.assertLessEqual(owner.status()['writtenBytes']-before, 65536)
        state = self.finish()
        self.assertEqual(state['verifiedFiles'], 3)
        self.assertEqual(state['writtenBytes'], 330000)
        self.deny_handoff()
        owner.close()
        source = self.temps/'Extract/nested/one.bin'
        with self.assertRaises(PermissionError):
            source.open('r+b')
        with self.assertRaises(OSError):
            source.rename(self.root/'renamed.bin')
        self.borrow = self.lease.begin_transfer(str(self.final), self.identity(self.final), 'Owned')
        # Read-only source reopening would conflict with retained writers.
        # Reject every non-create open during transfer to prove original reuse.
        original = module._HandleCustody._open
        def no_source_reopen(custody, parent, name, directory, create=False, writable=False):
            self.assertTrue(create)
            return original(custody, parent, name, directory, create, writable)
        with patch.object(module._HandleCustody, '_open', no_source_reopen):
            for r in records:
                if r['name'].endswith('/'):
                    continue
                self.borrow.transfer(r['name'], r['name'], len(r.get('data', b'')), digest(r.get('data', b'')))
                self.assertEqual((self.final/'Owned'/r['name']).read_bytes(), r.get('data', b''))
        with self.assertRaises(Exception):
            self.lease.close()
        self.no_permit()

    def test_file_inserted_after_start_is_not_overwritten_or_adopted(self):
        owner = self.create([{'name': 'own.bin', 'data': b'expected'}])
        owner.start()
        foreign = self.temps/'Extract/own.bin'
        foreign.write_bytes(b'foreign must survive')
        with self.assertRaises(Exception):
            self.finish()
        self.assertEqual(foreign.read_bytes(), b'foreign must survive')
        self.assertTrue(owner.status()['poisoned'])
        self.deny_handoff()

    def test_existing_ordinary_directory_is_not_adopted(self):
        owner = self.create([{'name': 'nested/own.bin', 'data': b'expected'}])
        owner.start()
        foreign = self.temps/'Extract/nested'
        foreign.mkdir()
        (foreign/'sentinel.bin').write_bytes(b'foreign')
        with self.assertRaises(Exception):
            self.finish()
        self.assertEqual((foreign/'sentinel.bin').read_bytes(), b'foreign')
        self.assertFalse((foreign/'own.bin').exists())
        self.deny_handoff()

    def test_matching_foreign_hardlink_is_not_accepted_as_our_output(self):
        data = b'expected bytes are not evidence of creation ownership'
        owner = self.create([{'name': 'own.bin', 'data': data}])
        owner.start()
        foreign = self.root/'foreign.bin'
        foreign.write_bytes(data)
        os.link(foreign, self.temps/'Extract/own.bin')
        with self.assertRaises(Exception):
            self.finish()
        self.assertEqual(foreign.read_bytes(), data)
        self.assertEqual(foreign.stat().st_nlink, 2)
        self.deny_handoff()

    def test_archive_extent_multidisk_and_truncation_refuse_before_outputs(self):
        raw = own_zip([{'name': 'own.bin', 'data': b'expected'}])
        variants = []
        split = bytearray(raw)
        struct.pack_into('<H', split, len(split)-22+4, 1)
        variants.append(bytes(split))
        extent = bytearray(raw)
        struct.pack_into('<I', extent, len(extent)-22+12, 0xffffffff)
        variants.append(bytes(extent))
        variants.extend([raw[:-1], raw+b'unaccounted trailer'])
        for archive in variants:
            with self.subTest(bytes=len(archive)):
                self.release()
                self.owner = self.lease = self.borrow = None
                self.archives = self.root/uuid.uuid4().hex
                self.temps = self.root/uuid.uuid4().hex
                self.archives.mkdir()
                self.temps.mkdir()
                owner = self.create(raw=archive, payload={'own.bin': digest(b'expected')}, total=8)
                with self.assertRaises(Exception):
                    owner.start()
                self.assertEqual(list((self.temps/'Extract').iterdir()), [])
                self.deny_handoff()

    def test_directory_crc_must_match_its_empty_declared_content(self):
        owner = self.create([{'name': 'nested/', 'method': 0, 'crc': 1},
                             {'name': 'nested/own.bin', 'data': b'expected'}])
        with self.assertRaises(Exception):
            owner.start()
        self.assertEqual(list((self.temps/'Extract').iterdir()), [])
        self.deny_handoff()

    def test_directory_cannot_claim_deflate_without_a_deflate_stream(self):
        owner = self.create([{'name': 'nested/', 'method': 8, 'packed': b''},
                             {'name': 'nested/own.bin', 'data': b'expected'}])
        with self.assertRaises(Exception):
            owner.start()
        self.assertEqual(list((self.temps/'Extract').iterdir()), [])
        self.deny_handoff()

    def test_budget_includes_implicit_directories_before_any_output_creation(self):
        owner = self.create([{'name': 'one/two/three/own.bin', 'data': b'expected'}])
        held = sum(len(item._handles) for item in self.lease._pool.owners)
        with patch.object(module, 'MAX_HANDLES', held+1):
            with self.assertRaises(Exception):
                owner.start()
        self.assertEqual(list((self.temps/'Extract').iterdir()), [])
        self.deny_handoff()

    def test_wrong_total_is_rejected_before_outputs_and_wrong_sha_never_handoffs(self):
        owner = self.create([{'name': 'own.bin', 'data': b'expected'}], total=9)
        with self.assertRaises(Exception):
            owner.start()
        self.assertEqual(list((self.temps/'Extract').iterdir()), [])
        self.release()
        self.owner = self.lease = self.borrow = None
        self.archives = self.root/'other-archive'
        self.temps = self.root/'other-temp'
        self.archives.mkdir()
        self.temps.mkdir()
        owner = self.create([{'name': 'own.bin', 'data': b'expected'}], payload={'own.bin': '0'*64})
        with self.assertRaises(Exception):
            owner.start()
            self.finish()
        self.assertTrue(owner.status()['poisoned'])
        self.deny_handoff()

    def test_interrupt_after_native_create_keeps_original_output_cell_and_seal(self):
        owner = self.create([{'name': 'own.bin', 'data': b'expected'}])
        owner.start()
        actual, interrupted = module._N.NtCreateFile, []
        target = self.temps/'Extract/own.bin'
        def after_create(*args):
            value = actual(*args)
            if value >= 0 and target.exists() and not interrupted:
                interrupted.append(True)
                raise KeyboardInterrupt()
            return value
        before = self.lease.status()['retainedHandles']
        with patch.object(module._N, 'NtCreateFile', after_create):
            with self.assertRaises(KeyboardInterrupt) as caught:
                self.finish()
        self.assertEqual(interrupted, [True])
        self.assertIs(caught.exception.owner, owner)
        self.assertIs(caught.exception.lease, self.lease)
        self.assertGreater(self.lease.status()['retainedHandles'], before)
        with self.assertRaises(PermissionError):
            target.open('r+b')
        self.assertTrue(owner.status()['poisoned'])
        self.deny_handoff()

    def test_interrupt_after_native_write_retains_partial_output_without_retry(self):
        owner = self.create([{'name': 'own.bin', 'data': b'A'*150000, 'method': 0}])
        owner.start()
        actual, written = module._K.WriteFile, []
        def after_write(*args):
            result = actual(*args)
            if result and not written:
                written.append(True)
                raise KeyboardInterrupt()
            return result
        with patch.object(module._K, 'WriteFile', after_write):
            with self.assertRaises(KeyboardInterrupt) as caught:
                self.finish()
        self.assertEqual(written, [True])
        self.assertIs(caught.exception.owner, owner)
        self.assertGreater((self.temps/'Extract/own.bin').stat().st_size, 0)
        self.assertTrue(owner.status()['poisoned'])
        self.deny_handoff()

    def test_readback_detects_actual_output_corruption_despite_correct_input_hash(self):
        data = b'correct ZIP input does not prove written output'*4096
        owner = self.create([{'name': 'own.bin', 'data': data, 'method': 0}])
        owner.start()
        actual, changed = module._K.WriteFile, []
        def corrupt_written_buffer(*args):
            if not changed:
                ctypes.memmove(args[1], b'\xff', 1)
                changed.append(True)
            return actual(*args)
        with patch.object(module._K, 'WriteFile', corrupt_written_buffer):
            with self.assertRaises(Exception) as caught:
                self.finish()
        self.assertEqual(changed, [True])
        self.assertEqual(caught.exception.code, 'READBACK_MISMATCH')
        self.assertNotEqual((self.temps/'Extract/own.bin').read_bytes(), data)
        self.assertTrue(owner.status()['poisoned'])
        self.deny_handoff()

    def test_parent_partial_close_rejects_before_any_stale_native_access(self):
        owner = self.create([{'name': 'own.bin', 'data': b'expected'}])
        owner.start()
        self.finish()
        owner.close()
        actual, closed = module._K.CloseHandle, []
        def completed_close_then_interrupt(handle):
            result = actual(handle)
            if result and not closed:
                closed.append(handle)
                raise KeyboardInterrupt()
            return result
        try:
            with patch.object(module._K, 'CloseHandle', completed_close_then_interrupt):
                with self.assertRaises(KeyboardInterrupt):
                    self.lease.close()
            self.assertEqual(len(closed), 1)
            with patch.object(module._K, 'ReadFile', side_effect=AssertionError('Stale read')), \
                 patch.object(module._K, 'GetFileInformationByHandleEx', side_effect=AssertionError('Stale snapshot')), \
                 patch.object(module._N, 'NtCreateFile', side_effect=AssertionError('Unexpected reopen')):
                self.deny_handoff()
                with self.assertRaises(Exception):
                    owner.pump()
        finally:
            if closed:
                # Only this fixture witnessed successful native close. Forget
                # that exact closed entry; NEVER retry its old numeric value.
                entry = next(e for e in self.lease._handles if e.phase == 'close-uncertain' and e.cell.value == closed[0])
                self.lease._handles.remove(entry)

    def test_inserted_directory_and_reparse_target_are_not_adopted(self):
        owner = self.create([{'name': 'nested/own.bin', 'data': b'expected'}])
        owner.start()
        outside = self.root/'outside'
        outside.mkdir()
        sentinel = outside/'own.bin'
        sentinel.write_bytes(b'foreign junction target')
        subprocess.run(['node', '-e', "require('node:fs').symlinkSync(process.argv[1],process.argv[2],'junction')",
                        str(outside), str(self.temps/'Extract/nested')], check=True, capture_output=True, timeout=10)
        with self.assertRaises(Exception):
            self.finish()
        self.assertEqual(sentinel.read_bytes(), b'foreign junction target')
        self.deny_handoff()

    def test_cancel_midstream_retains_partial_output_and_blocks_both_factories(self):
        owner = self.create([{'name': 'own.bin', 'data': b'A'*300000, 'method': 0}])
        owner.start()
        while owner.status()['writtenBytes'] == 0:
            owner.pump()
        self.assertFalse(owner.status()['completed'])
        before = owner.status()['writtenBytes']
        owner.cancel()
        try:
            owner.pump()
        except Exception:
            pass
        self.assertEqual(owner.status()['writtenBytes'], before)
        self.assertTrue((self.temps/'Extract/own.bin').exists())
        owner.close()
        self.deny_handoff()
        for call in (self.lease.create_extractor, lambda: self.lease.create_zip_extractor({'own.bin': '0'*64}, 1)):
            with self.assertRaises(Exception):
                call()

    def test_wrong_thread_and_reentrant_calls_fail_before_writes(self):
        owner = self.create()
        errors = []
        def run():
            try:
                owner.start()
            except BaseException as error:
                errors.append(error)
        thread = threading.Thread(target=run)
        thread.start()
        thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(len(errors), 1)
        self.assertFalse(owner.status()['startAttempted'])
        with self.lease._operation():
            with self.assertRaises(Exception):
                owner.start()
        self.assertEqual(list((self.temps/'Extract').iterdir()), [])

    def test_invalid_headers_paths_aliases_and_installers_refuse_before_outputs(self):
        bad = [
            {'name': '../outside.bin', 'data': b'x'}, {'name': 'C:/drive.bin', 'data': b'x'},
            {'name': 'own.bin:ads', 'data': b'x'}, {'name': 'CON.txt', 'data': b'x'},
            {'name': 'LONGFI~1.bin', 'data': b'x'}, {'name': 'a./x.bin', 'data': b'x'},
            {'name': 'fomod/info.xml', 'data': b'x'}, {'name': '__folder_managed_by_vortex', 'data': b'x'},
            {'name': 'vortex_override_instructions.json', 'data': b'x'},
            {'name': 'own.bin', 'data': b'x', 'flags': 1},
            {'name': 'own.bin', 'data': b'x', 'flags': 8},
            {'name': 'own.bin', 'data': b'x', 'method': 12},
            {'name': 'own.bin', 'data': b'x', 'extra': b'\x55\x54\x00\x00'},
            {'name': 'own.bin', 'data': b'x', 'attributes': 0xa000 << 16},
            {'name': 'own.bin', 'data': b'x', 'local_name': b'bad.bin'},
            {'name': 'own.bin', 'data': b'x', 'local_crc': 12345},
        ]
        for record in bad:
            with self.subTest(record=record['name'], flags=record.get('flags'), method=record.get('method')):
                # Each variant gets a distinct lease, root and test-owned archive.
                self.release()
                self.owner = self.lease = self.borrow = None
                self.archives = self.root/uuid.uuid4().hex
                self.temps = self.root/uuid.uuid4().hex
                self.archives.mkdir()
                self.temps.mkdir()
                with self.assertRaises(Exception):
                    owner = self.create([record], total=1)
                    owner.start()
                self.assertEqual(list((self.temps/'Extract').iterdir()), [])
                self.deny_handoff()

    def test_case_duplicate_and_file_prefix_collisions_refuse_before_outputs(self):
        variants = [
            [{'name': 'A/x', 'data': b'x'}, {'name': 'a/y', 'data': b'y'}],
            [{'name': 'own.bin', 'data': b'x'}, {'name': 'OWN.bin', 'data': b'y'}],
            [{'name': 'own', 'data': b'x'}, {'name': 'own/nested', 'data': b'y'}],
        ]
        for records in variants:
            with self.subTest(names=[r['name'] for r in records]):
                self.release()
                self.owner = self.lease = self.borrow = None
                self.archives = self.root/uuid.uuid4().hex
                self.temps = self.root/uuid.uuid4().hex
                self.archives.mkdir()
                self.temps.mkdir()
                with self.assertRaises(Exception):
                    owner = self.create(records, total=2)
                    owner.start()
                self.assertEqual(list((self.temps/'Extract').iterdir()), [])

    def test_corrupt_crc_stream_trailing_bytes_and_bomb_never_handoff(self):
        data = b'B'*200000
        compressor = zlib.compressobj(wbits=-15)
        packed = compressor.compress(data)+compressor.flush()
        variants = [
            {'name': 'own.bin', 'data': data, 'crc': zlib.crc32(data)^1},
            {'name': 'own.bin', 'data': data, 'packed': packed[:-2]},
            {'name': 'own.bin', 'data': data, 'packed': packed+b'trailing'},
            {'name': 'own.bin', 'data': data, 'size': 1},
        ]
        for record in variants:
            with self.subTest(kind=record.keys()):
                self.release()
                self.owner = self.lease = self.borrow = None
                self.archives = self.root/uuid.uuid4().hex
                self.temps = self.root/uuid.uuid4().hex
                self.archives.mkdir()
                self.temps.mkdir()
                owner = self.create([record], total=record.get('size', len(data)))
                with self.assertRaises(Exception):
                    owner.start()
                    self.finish()
                self.assertTrue(owner.status()['poisoned'])
                if record.get('size') == 1:
                    target = self.temps/'Extract/own.bin'
                    self.assertTrue(not target.exists() or target.stat().st_size <= 1,
                                    'Inflated bytes exceeded the declared bound before rejection')
                self.deny_handoff()


if __name__ == '__main__':
    unittest.main()
