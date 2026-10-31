"""Fixed internal own-ZIP guardian. Private NDJSON pipes, no install endpoint.

No executable, script, argv, callback, Vortex/game path or backend override.
Custody stays in this process through extraction, copy and explicit release.
Controller EOF holds/cancels; it never releases files or starts another job.
Import is inert. Only the reviewed fixed launcher should execute this file.
"""
import ctypes as C
from ctypes import wintypes as W
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import queue
import re
import secrets
import sys
import threading
import time
import zlib

HERE = Path(__file__).absolute().parent
ROOT = HERE.parents[2]
WORK_BASE = ROOT/'local-state/owned-zip-worker-work'
SOURCE_NAMES = ('owned-file-transfer.py', 'owned-zip-extractor.py', 'owned-zip-worker.py')
MAX_START = 1024*1024+16384
MAX_CONTROL = 4096
MAX_SAFE = 9007199254740991


def need(value, code):
    if not value:
        raise RuntimeError(code)


def exact(value, keys):
    return type(value) is dict and set(value) == set(keys)


def safe_code(error):
    if isinstance(error, (KeyboardInterrupt, SystemExit)):
        return 'INTERRUPTED'
    text = str(error)
    return text if re.fullmatch(r'[A-Z][A-Z0-9_]{0,98}', text) else 'WORKER_OPERATION_FAILED'


def decode(data):
    def unique(pairs):
        result = {}
        for key, item in pairs:
            need(key not in result, 'DUPLICATE_JSON')
            result[key] = item
        return result

    def integer(text):
        value = int(text)
        need(abs(value) <= MAX_SAFE, 'JSON_NUMBER_LIMIT')
        return value

    def forbidden(_):
        raise RuntimeError('JSON_NUMBER_REFUSED')

    value = json.loads(data.decode('utf-8', 'strict'), object_pairs_hook=unique,
                       parse_int=integer, parse_float=forbidden, parse_constant=forbidden)
    remaining = 50128

    def bound(item, depth):
        nonlocal remaining
        remaining -= 1
        need(remaining >= 0 and depth <= 18, 'JSON_LIMIT')
        if type(item) is dict:
            for key, entry in item.items():
                need(type(key) is str, 'JSON_KEY_REFUSED')
                bound(entry, depth+1)
        elif type(item) is list:
            for entry in item:
                bound(entry, depth+1)
    bound(value, 0)
    return value


def check_binding(value):
    fields = {'operationId': r'op_[a-f0-9]{32}', 'nativeJobId': r'exec_[a-f0-9]{32}',
              'requestSHA256': r'[a-f0-9]{64}', 'rendererGeneration': r'renderer_[a-f0-9]{32}'}
    need(exact(value, fields) and all(type(value[key]) is str and re.fullmatch(pattern, value[key])
         for key, pattern in fields.items()), 'BINDING_REFUSED')


class Transport:
    """Reader never touches custody; blocked stdout never blocks the pump."""
    def __init__(self, lifetime, base):
        self.lifetime, self.base = lifetime, base
        self.commands = queue.Queue(maxsize=8)
        self.cancel_seen = threading.Event()
        self.fault = None
        self.binding = None
        self.start_seen = False
        self.slot = None
        self.condition = threading.Condition()
        self.final_written = threading.Event()

    def send(self, value, final=False):
        encoded = (json.dumps(value, separators=(',', ':'), ensure_ascii=True)+'\n').encode('utf-8')
        need(len(encoded) <= 16384, 'STATUS_LIMIT')
        with self.condition:
            self.slot = (encoded, final)
            self.condition.notify()

    def writer(self):
        while True:
            with self.condition:
                while self.slot is None:
                    self.condition.wait()
                data, final = self.slot
                self.slot = None
            try:
                offset = 0
                while offset < len(data):
                    count = os.write(1, data[offset:])
                    need(count > 0, 'STDOUT_NO_PROGRESS')
                    offset += count
                if final:
                    self.final_written.set()
            except BaseException:
                self.fault = self.fault or 'CONTROLLER_OUTPUT_LOST'
                return

    def validate_start(self, value):
        need(exact(value, ('schema', 'workerLifetime', 'binding', 'archive', 'payload', 'total'))
             and value['schema'] == 'owned-zip-worker-start/1'
             and value['workerLifetime'] == self.lifetime, 'START_REFUSED')
        check_binding(value['binding'])
        archive = value['archive']
        need(exact(archive, ('parent', 'parentIdentity', 'leaf', 'identity', 'bytes', 'sha256')), 'ARCHIVE_REFUSED')
        self.base._root(archive['parent'])
        self.base._component(archive['leaf'])
        self.base._identity(archive['parentIdentity'])
        self.base._identity(archive['identity'])
        need(type(archive['bytes']) is int and 0 < archive['bytes'] <= 64*1024*1024
             and type(archive['sha256']) is str and re.fullmatch(r'[a-f0-9]{64}', archive['sha256']), 'ARCHIVE_REFUSED')
        need(type(value['payload']) is dict and 0 < len(value['payload']) <= 4096
             and type(value['total']) is int and 0 <= value['total'] <= 256*1024*1024, 'PAYLOAD_REFUSED')
        for name, digest in value['payload'].items():
            self.base._relative(name)
            need(type(digest) is str and re.fullmatch(r'[a-f0-9]{64}', digest), 'PAYLOAD_REFUSED')

    def accept(self, data):
        value = decode(data)
        if not self.start_seen:
            if exact(value, ('schema', 'workerLifetime')) and value['schema'] == 'owned-zip-worker-abort/1':
                need(value['workerLifetime'] == self.lifetime, 'LIFETIME_MISMATCH')
                self.commands.put_nowait(('abort', None, None))
                self.start_seen = True  # Nothing else may become a start.
                return
            self.validate_start(value)
            self.binding = dict(value['binding'])
            self.commands.put_nowait(('start', value, hashlib.sha256(data).hexdigest()))
            self.start_seen = True
            return
        need(exact(value, ('schema', 'workerLifetime', 'binding', 'command'))
             and value['schema'] == 'owned-zip-worker-control/1'
             and value['workerLifetime'] == self.lifetime and value['binding'] == self.binding,
             'CONTROL_BINDING_MISMATCH')
        check_binding(value['binding'])
        need(value['command'] in ('cancel', 'handoff', 'release'), 'CONTROL_REFUSED')
        if value['command'] == 'cancel':
            self.cancel_seen.set()
        self.commands.put_nowait((value['command'], None, None))

    def reader(self):
        pending = bytearray()
        try:
            while True:
                chunk = os.read(0, 4096)
                if not chunk:
                    self.fault = self.fault or 'CONTROLLER_EOF'
                    return
                pending.extend(chunk)
                while b'\n' in pending:
                    at = pending.index(10)
                    limit = MAX_CONTROL if self.start_seen else MAX_START
                    need(at <= limit, 'FRAME_LIMIT')
                    data = bytes(pending[:at])
                    del pending[:at+1]
                    self.accept(data)
                need(len(pending) <= (MAX_CONTROL if self.start_seen else MAX_START), 'FRAME_LIMIT')
        except BaseException as error:
            self.fault = self.fault or ('CONTROL_QUEUE_LIMIT' if isinstance(error, queue.Full) else safe_code(error))


def bootstrap():
    need(os.name == 'nt' and C.sizeof(C.c_void_p) == 8 and tuple(sys.version_info[:3]) == (3, 14, 8),
         'UNSUPPORTED_RUNTIME')
    need(zlib.__spec__.origin == 'built-in' and zlib.ZLIB_RUNTIME_VERSION == '1.3.1.zlib-ng', 'UNSUPPORTED_ZLIB')
    spec = importlib.util.spec_from_file_location('_owned_zip_worker_custody', HERE/'owned-file-transfer.py')
    base = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(base)

    class Guard(base._HandleCustody):
        def __init__(self):
            self._init_custody()
            self._closed = self._poisoned = False

        def status(self):
            return {'closed': self._closed, 'retainedHandles': len(self._handles)}

    guard = Guard()
    k = C.WinDLL('kernel32', use_last_error=True)
    k.GetCurrentProcess.argtypes, k.GetCurrentProcess.restype = [], W.HANDLE
    k.GetProcessTimes.argtypes = [W.HANDLE, C.POINTER(W.FILETIME), C.POINTER(W.FILETIME), C.POINTER(W.FILETIME), C.POINTER(W.FILETIME)]
    k.GetProcessTimes.restype = W.BOOL
    k.GetModuleFileNameW.argtypes, k.GetModuleFileNameW.restype = [W.HMODULE, W.LPWSTR, W.DWORD], W.DWORD
    core = C.create_unicode_buffer(4096)
    used = k.GetModuleFileNameW(sys.dllhandle, core, len(core))
    need(0 < used < len(core), 'CORE_PATH_REFUSED')

    def seal(file, maximum):
        file = Path(file).absolute()
        parent = guard._root_handle(base._root(str(file.parent)))
        handle, before = guard._open(parent, base._component(file.name), False)
        need(0 < before[1] <= maximum, 'SOURCE_SIZE_REFUSED')
        digest = base._hash(handle, before[1])
        need(base._snapshot(handle, False) == before, 'SOURCE_CHANGED')
        return digest

    sources = {name: seal(HERE/name, 512*1024) for name in SOURCE_NAMES}
    runtime = {'pythonExe': seal(Path(sys.executable), 64*1024*1024),
               'pythonCore': seal(Path(core.value), 64*1024*1024)}
    times = [W.FILETIME() for _ in range(4)]
    need(k.GetProcessTimes(k.GetCurrentProcess(), *(C.byref(value) for value in times)), 'CREATION_TIME_REFUSED')
    created = str((times[0].dwHighDateTime << 32) | times[0].dwLowDateTime)
    return base, guard, {'schema': 'owned-zip-worker-ready/1', 'workerLifetime': 'worker_'+secrets.token_hex(16),
           'pid': os.getpid(), 'creationTime': created, 'sourceSHA256': sources, 'runtimeSHA256': runtime,
           'pythonVersion': [3, 14, 8], 'zlibOrigin': 'built-in', 'zlibVersion': zlib.ZLIB_RUNTIME_VERSION}


class Worker:
    def __init__(self, base, guard, transport):
        self.base, self.guard, self.transport = base, guard, transport
        self.binding = self.packet_sha = self.work_root = None
        self.lease = self.owner = self.borrower = None
        self.phase, self.error_code = 'ready', None
        self.sequence = self.copied = 0
        self.cancelled = self.explicit_cancel = self.handoff_attempted = False
        self.copy_scope = []
        self.last_emit = 0
        self.op_identity = None

    def emit(self, force=False, final=False):
        if self.binding is None or (not force and time.monotonic()-self.last_emit < 0.1):
            return
        self.sequence += 1
        need(self.sequence <= MAX_SAFE, 'SEQUENCE_LIMIT')
        self.last_emit = time.monotonic()
        self.transport.send({'schema': 'owned-zip-worker-status/1', 'workerLifetime': self.transport.lifetime,
             'binding': dict(self.binding), 'packetSHA256': self.packet_sha, 'sequence': self.sequence,
             'phase': self.phase, 'zipStatus': self.owner.status() if self.owner else None,
             'copiedFiles': self.copied, 'workRoot': str(self.work_root), 'errorCode': self.error_code,
             'effectsAllowed': False, 'nativeInstallAccepted': False, 'persistenceVerified': False}, final)

    def hold(self, code):
        self.error_code = self.error_code or code
        self.cancelled = True
        if self.owner is not None:
            self.owner.cancel()
        self.phase = 'held'
        self.emit(True)

    def start(self, value, packet_sha):
        need(self.binding is None, 'START_ALREADY_SEEN')
        self.binding, self.packet_sha = dict(value['binding']), packet_sha
        self.work_root = WORK_BASE/self.binding['operationId']
        if self.transport.fault:
            self.hold(self.transport.fault)
            return
        if self.transport.cancel_seen.is_set():
            self.cancel()
            return
        # Only accepted packets may create these fixed children, relative to
        # retained ordinary ancestry; never recursively mkdir through a link.
        base_handle = self.guard._root_handle(self.base._root(str(ROOT)))
        for name in ('local-state', 'owned-zip-worker-work'):
            try:
                base_handle, _ = self.guard._open(base_handle, name, True)
            except self.base.OwnedTransferError as error:
                if str(error) != 'OWNED_TRANSFER_OPEN_REFUSED':
                    raise
                base_handle, _ = self.guard._open(base_handle, name, True, create=True)
        op_handle, observed = self.guard._open(base_handle, self.binding['operationId'], True, create=True)
        self.op_identity = self.base._label(observed[0])
        archive = value['archive']
        self.lease = self.base.ArchiveTempLease(self.binding, archive['parent'], archive['parentIdentity'],
             archive['leaf'], archive['identity'], archive['bytes'], archive['sha256'],
             str(self.work_root), self.op_identity, 'Extract')
        self.lease._pool.owners.remove(self.lease)
        self.lease._pool = self.guard._pool
        self.guard._pool.owners.append(self.lease)
        self.lease._lock, self.lease._thread = self.guard._lock, self.guard._thread
        self.owner = self.lease.create_zip_extractor(value['payload'], value['total'])
        self.lease.acquire()
        self.owner.start()
        self.phase = 'extracting'
        self.emit(True)

    def cancel(self):
        self.explicit_cancel = self.cancelled = True
        if self.owner:
            self.owner.cancel()
        self.phase = 'cancelled'  # Keep first error/ZIP poison, acknowledge this control.
        self.emit(True)

    def handoff(self):
        need(not self.handoff_attempted and not self.cancelled and not self.transport.cancel_seen.is_set()
             and not self.transport.fault and self.phase == 'extracted', 'HANDOFF_REFUSED')
        self.handoff_attempted = True
        self.borrower = self.lease.begin_transfer(str(self.work_root), self.op_identity, 'Final')
        # Sizes originate in VERIFIED decoder records, never another input map.
        self.copy_scope = [(key, record['size'], record['sha']) for key, record in sorted(self.owner._outputs.items())]
        self.phase = 'copying'
        self.emit(True)

    def release(self):
        need(not self.transport.fault, 'TRANSPORT_HELD')
        need(self.phase in ('extracted', 'copied', 'cancelled', 'held')
             and (self.explicit_cancel or self.phase in ('extracted', 'copied')), 'RELEASE_REFUSED')
        if self.borrower:
            self.borrower.close()
        if self.owner:
            self.owner.close()
        if self.lease:
            self.lease.close()
        self.guard.close()
        self.phase = 'released'
        self.emit(True, True)
        # No buffered-daemon interpreter teardown; final delivery is bounded.
        self.transport.final_written.wait(5)
        os._exit(0)

    def run(self):
        while True:
            try:
                if self.transport.fault:
                    if self.binding is not None and self.phase != 'held':
                        self.hold(self.transport.fault)
                    time.sleep(0.01)
                    continue  # EOF cannot turn into release or process exit.
                if self.transport.cancel_seen.is_set() and not self.explicit_cancel and self.binding is not None:
                    self.cancel()
                try:
                    command, value, digest = self.transport.commands.get_nowait()
                except queue.Empty:
                    command = None
                if command == 'abort':
                    need(self.binding is None, 'ABORT_AFTER_START_REFUSED')
                    self.guard.close()
                    os._exit(0)
                if command == 'start':
                    self.start(value, digest)
                elif command == 'cancel':
                    self.cancel()
                elif command == 'handoff':
                    self.handoff()
                elif command == 'release':
                    self.release()
                if self.transport.fault:
                    self.hold(self.transport.fault)
                    continue
                if self.transport.cancel_seen.is_set() and not self.explicit_cancel:
                    self.cancel()
                if self.phase == 'extracting' and not self.cancelled:
                    self.owner.pump()
                    if self.owner.status()['completed']:
                        self.owner.close()  # Parent writer seals remain held.
                        self.phase = 'extracted'
                        self.emit(True)
                    else:
                        self.emit()
                elif self.phase == 'copying' and not self.cancelled:
                    if self.copied < len(self.copy_scope):
                        key, size, digest = self.copy_scope[self.copied]
                        name = '/'.join(key)
                        self.borrower.transfer(name, name, size, digest)
                        self.copied += 1
                        self.emit()
                    if self.transport.fault:
                        self.hold(self.transport.fault)
                    elif self.transport.cancel_seen.is_set():
                        self.cancel()
                    elif self.copied == len(self.copy_scope):
                        self.phase = 'copied'
                        self.emit(True)
                else:
                    time.sleep(0.002)
            except BaseException as error:
                # A failed begin_transfer may own a partial borrower before return.
                if self.lease is not None and self.borrower is None:
                    self.borrower = self.lease._borrow
                if self.lease is not None and self.owner is None:
                    self.owner = self.lease._extractor
                try:
                    self.hold(safe_code(error))
                except BaseException:
                    self.error_code = self.error_code or 'HOLD_STATUS_FAILED'
                    self.phase = 'held'
                    time.sleep(0.01)


def main():
    need(len(sys.argv) == 1, 'ARGUMENTS_REFUSED')
    base, guard, ready = bootstrap()
    transport = Transport(ready['workerLifetime'], base)
    threading.Thread(target=transport.writer, name='owned-zip-status', daemon=True).start()
    transport.send(ready)
    threading.Thread(target=transport.reader, name='owned-zip-control', daemon=True).start()
    Worker(base, guard, transport).run()


if __name__ == '__main__':
    try:
        main()
    except BaseException:
        # Startup refusal has no work-directory effects and reveals no paths.
        try:
            os.write(2, b'Owned ZIP worker refused startup.\n')
        finally:
            os._exit(65)
