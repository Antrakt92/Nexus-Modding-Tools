"""Internal Windows handle-owned copying; no CLI, installer, deletion or retry API.

Create an inert OwnedFileTransfer, call acquire() once, then transfer() and close().
Failures poison the lease and retain handles/partial output until explicit close.
Root pins use explicitly tagged win-file-id128/1 volume64:file128 identities,
never untagged Python/Node dev:ino strings. This is not a hostile-process sandbox:
siblings, memory mappings, privileged actors, persistence, extractor termination
and integration with Vortex are outside this component's guarantee.
Only fixed local NTFS is admitted. Drive mapping/ACL changes by hostile actors
are not a security boundary; handles do not fence arbitrary directory contents.
Only the explicitly checked Windows x64 ctypes ABI is supported.
The destination namespace becomes visible at acquire(), before copying completes;
this is not atomic publication of a complete payload. New hardlink aliases and
renaming separately opened alias names can remain possible while the canonical
archive name and bytes are held; no cleanup/adoption is authorized after close.
"""
import ctypes as C
from ctypes import wintypes as W
from contextlib import contextmanager
import hashlib
import ntpath
import os
import re
import threading

MAX_FILES = 4096
MAX_TOTAL_BYTES = 256 * 1024 * 1024
MAX_FILE_BYTES = MAX_TOTAL_BYTES
MAX_HANDLES = 16384
CHUNK_BYTES = 65536
IDENTITY_SCHEMA = 'win-file-id128/1'


class OwnedTransferError(Exception):
    def __init__(self, code, lease=None):
        super().__init__('OWNED_TRANSFER_' + code)
        self.lease = lease


def _need(ok, code):
    if not ok:
        raise OwnedTransferError(code)


def _component(value):
    _need(type(value) is str and 0 < len(value) <= 255 and value.isascii()
          and not re.search(r'[<>:"/\\|?*~\x00-\x1f\x7f]', value)
          and value not in ('.', '..') and not value.endswith(('.', ' '))
          and not re.match(r'^(con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\.|$)', value, re.I),
          'INVALID_COMPONENT')
    return value


def _root(value):
    _need(type(value) is str and len(value) <= 512 and re.match(r'^[A-Za-z]:[\\/]', value), 'INVALID_ROOT')
    value = value.replace('/', '\\')
    parts = value[3:].split('\\') if len(value) > 3 else []
    _need(len(parts) <= 32, 'LIMIT')
    for part in parts:
        _component(part)
    return value[:1].upper() + value[1:]


def _relative(value):
    _need(type(value) is str and 0 < len(value) <= 512 and '\\' not in value, 'INVALID_RELATIVE')
    parts = value.split('/')
    _need(len(parts) <= 32, 'LIMIT')
    return tuple(_component(part) for part in parts)


def _identity(value):
    _need(type(value) is dict and set(value) == {'schema', 'volumeSerialNumber', 'fileId'}
          and value['schema'] == IDENTITY_SCHEMA, 'INVALID_IDENTITY')
    for key, maximum in (('volumeSerialNumber', 2**64 - 1), ('fileId', 2**128 - 1)):
        item = value[key]
        _need(type(item) is str and re.fullmatch(r'[1-9][0-9]{0,38}', item) and int(item) <= maximum, 'INVALID_IDENTITY')
    return value['volumeSerialNumber'] + ':' + value['fileId']


def _label(value):
    volume, file = value.split(':')
    return {'schema': IDENTITY_SCHEMA, 'volumeSerialNumber': volume, 'fileId': file}


if os.name == 'nt':
    class _Unicode(C.Structure):
        _fields_ = [('Length', W.USHORT), ('MaximumLength', W.USHORT), ('Buffer', W.LPWSTR)]

    class _Attributes(C.Structure):
        _fields_ = [('Length', W.ULONG), ('RootDirectory', W.HANDLE), ('ObjectName', C.POINTER(_Unicode)),
                    ('Attributes', W.ULONG), ('SecurityDescriptor', C.c_void_p), ('SecurityQualityOfService', C.c_void_p)]

    class _Status(C.Structure):
        _fields_ = [('StatusOrPointer', C.c_void_p), ('Information', C.c_size_t)]

    class _Identity(C.Structure):
        _fields_ = [('volume', C.c_ulonglong), ('file', W.BYTE * 16)]

    class _Basic(C.Structure):
        _fields_ = [('created', C.c_longlong), ('accessed', C.c_longlong), ('written', C.c_longlong),
                    ('changed', C.c_longlong), ('attributes', W.DWORD)]

    class _Standard(C.Structure):
        _fields_ = [('allocation', C.c_longlong), ('size', C.c_longlong), ('links', W.DWORD),
                    ('deletePending', W.BYTE), ('directory', W.BYTE)]

    class _HandleEntry:
        def __init__(self):
            self.cell = W.HANDLE()
            self.phase = 'pending'

    _K = C.WinDLL('kernel32', use_last_error=True)
    _N = C.WinDLL('ntdll')
    _N.NtCreateFile.argtypes = [C.POINTER(W.HANDLE), W.DWORD, C.POINTER(_Attributes), C.POINTER(_Status),
                               C.c_void_p, W.ULONG, W.ULONG, W.ULONG, W.ULONG, C.c_void_p, W.ULONG]
    _N.NtCreateFile.restype = C.c_long
    _K.GetFileInformationByHandleEx.argtypes = [W.HANDLE, C.c_int, C.c_void_p, W.DWORD]
    _K.GetFileInformationByHandleEx.restype = W.BOOL
    _K.CloseHandle.argtypes = [W.HANDLE]
    _K.CloseHandle.restype = W.BOOL
    _K.GetDriveTypeW.argtypes = [W.LPCWSTR]
    _K.GetDriveTypeW.restype = W.UINT
    _K.QueryDosDeviceW.argtypes = [W.LPCWSTR, W.LPWSTR, W.DWORD]
    _K.QueryDosDeviceW.restype = W.DWORD
    _K.GetVolumeInformationByHandleW.argtypes = [W.HANDLE, W.LPWSTR, W.DWORD, C.c_void_p,
                                               C.c_void_p, C.c_void_p, W.LPWSTR, W.DWORD]
    _K.GetVolumeInformationByHandleW.restype = W.BOOL
    _K.ReadFile.argtypes = [W.HANDLE, C.c_void_p, W.DWORD, C.POINTER(W.DWORD), C.c_void_p]
    _K.ReadFile.restype = W.BOOL
    _K.WriteFile.argtypes = [W.HANDLE, C.c_void_p, W.DWORD, C.POINTER(W.DWORD), C.c_void_p]
    _K.WriteFile.restype = W.BOOL
    _K.SetFilePointerEx.argtypes = [W.HANDLE, C.c_longlong, C.c_void_p, W.DWORD]
    _K.SetFilePointerEx.restype = W.BOOL


def _snapshot(handle, directory):
    values = []
    for kind, structure in ((18, _Identity), (0, _Basic), (1, _Standard)):
        value = structure()
        _need(_K.GetFileInformationByHandleEx(handle, kind, C.byref(value), C.sizeof(value)), 'INFORMATION_FAILED')
        values.append(value)
    ident, basic, standard = values
    inode = int.from_bytes(bytes(ident.file), 'little')
    _need(ident.volume > 0 and inode > 0 and bool(standard.directory) == directory
          and not basic.attributes & 0x400 and not standard.deletePending and standard.links > 0, 'UNSAFE_OBJECT')
    return (f'{ident.volume}:{inode}', standard.size, standard.links, basic.written, basic.changed, basic.attributes)


def _abi():
    return all(C.sizeof(kind) == size for kind, size in
               ((C.c_void_p, 8), (C.c_long, 4), (_Unicode, 16), (_Attributes, 48),
                (_Status, 16), (_Identity, 24), (_Basic, 40), (_Standard, 24)))


def _seek(handle):
    _need(_K.SetFilePointerEx(handle, 0, None, 0), 'SEEK_FAILED')


def _read(handle, limit):
    _need(0 < limit <= CHUNK_BYTES, 'LIMIT')
    buffer, used = C.create_string_buffer(limit), W.DWORD()
    _need(_K.ReadFile(handle, buffer, limit, C.byref(used), None), 'READ_FAILED')
    _need(used.value <= limit, 'READ_FAILED')
    return buffer.raw[:used.value]


def _write(handle, data):
    _need(0 < len(data) <= CHUNK_BYTES, 'LIMIT')
    buffer, used = C.create_string_buffer(data), W.DWORD()
    _need(_K.WriteFile(handle, buffer, len(data), C.byref(used), None) and used.value == len(data), 'WRITE_FAILED')


def _hash(handle, size):
    _seek(handle)
    result, remaining = hashlib.sha256(), size
    while remaining:
        data = _read(handle, min(remaining, CHUNK_BYTES))
        _need(data, 'SIZE_MISMATCH')
        result.update(data)
        remaining -= len(data)
    _need(not _read(handle, 1), 'SIZE_MISMATCH')
    return result.hexdigest()


class _HandlePool:
    def __init__(self):
        self.lock = threading.Lock()
        self.thread = threading.get_ident()
        self.owners = []


class _HandleCustody:
    def _init_custody(self, pool=None):
        self._pool = pool or _HandlePool()
        self._handles = []
        self._pool.owners.append(self)
        self._lock, self._thread = self._pool.lock, self._pool.thread

    def _open(self, parent, name, directory, create=False, writable=False):
        _need(sum(len(owner._handles) for owner in self._pool.owners) < MAX_HANDLES, 'HANDLE_LIMIT')
        storage = C.create_unicode_buffer(name)
        text = _Unicode(len(name.encode('utf-16-le')), (len(name) + 1) * 2, C.cast(storage, W.LPWSTR))
        # OBJ_DONT_REPARSE + OBJ_CASE_INSENSITIVE, including the drive open.
        attrs = _Attributes(C.sizeof(_Attributes), parent, C.pointer(text), 0x1040, None, None)
        entry, status = _HandleEntry(), _Status()
        access = 0x100081 if directory else (0xC0100000 if writable else 0x80100000)
        options = (0x1 if directory else 0x40) | 0x20 | 0x00200000
        sharing = 3 if directory else 1
        # The output cell is retained BEFORE crossing ctypes/kernel boundaries.
        # An interrupt after kernel creation must not lose the returned handle.
        self._handles.append(entry)
        code = _N.NtCreateFile(C.byref(entry.cell), access, C.byref(attrs), C.byref(status), None,
                               0x10 if directory else 0x80, sharing, 2 if create else 1, options, None, 0)
        _need(code >= 0, 'CREATE_REFUSED' if create else 'OPEN_REFUSED')
        _need(entry.cell.value not in (None, C.c_void_p(-1).value) and status.Information == (2 if create else 1), 'UNEXPECTED_OPEN')
        entry.phase = 'open'
        snapshot = _snapshot(entry.cell.value, directory)
        return entry.cell.value, snapshot

    def _existing_root(self, value, pin):
        _need(_K.GetDriveTypeW(value[:3]) == 3, 'UNSUPPORTED_DRIVE')
        mapping = C.create_unicode_buffer(2048)
        _need(_K.QueryDosDeviceW(value[:2], mapping, len(mapping))
              and re.fullmatch(r'\\Device\\HarddiskVolume[1-9][0-9]*', mapping.value), 'UNSUPPORTED_DRIVE_MAPPING')
        handle, _ = self._open(None, '\\??\\' + value[:3], True)
        filesystem = C.create_unicode_buffer(32)
        _need(_K.GetVolumeInformationByHandleW(handle, None, 0, None, None, None, filesystem, len(filesystem))
              and filesystem.value == 'NTFS', 'UNSUPPORTED_FILESYSTEM')
        for component in value[3:].split('\\') if len(value) > 3 else []:
            handle, _ = self._open(handle, component, True)
        _need(_snapshot(handle, True)[0] == pin, 'ROOT_IDENTITY_MISMATCH')
        return handle

    @contextmanager
    def _operation(self, closing=False):
        _need(self._lock.acquire(False), 'BUSY_OR_WRONG_THREAD')
        try:
            _need(threading.get_ident() == self._thread, 'BUSY_OR_WRONG_THREAD')
            if not closing:
                _need(not self._closed and not self._poisoned, 'HELD')
            yield
        finally:
            self._lock.release()

    def _error(self, error):
        if isinstance(error, OwnedTransferError):
            error.lease = self
            return error
        return OwnedTransferError('IO_FAILED', self)

    def close(self):
        with self._operation(closing=True):
            borrow = getattr(self, '_borrow', None)
            _need(borrow is None or (borrow._closed and not borrow._handles), 'BORROW_ACTIVE')
            return self._close()

    def _close(self):
        failed = False
        try:
            for index in range(len(self._handles)-1, -1, -1):
                entry = self._handles[index]
                handle = entry.cell.value
                if handle in (None, C.c_void_p(-1).value):
                    self._handles.pop(index)
                    continue
                if entry.phase == 'close-uncertain':
                    failed = True
                    continue
                # Premark BEFORE the native call. An interrupt anywhere between
                # native close and forgetting the entry can never cause an ABA retry.
                entry.phase = 'close-uncertain'
                success = _K.CloseHandle(handle)
                if success:
                    self._handles.pop(index)
                else:
                    entry.phase = 'open'
                    failed = True
            if failed:
                self._poisoned = True
                raise OwnedTransferError('CLOSE_FAILED', self)
            self._closed = not self._handles
            return self.status()
        except BaseException as error:
            self._poisoned = True
            if not isinstance(error, Exception):
                error.lease = self
                raise
            if isinstance(error, OwnedTransferError):
                raise
            raise OwnedTransferError('CLOSE_UNCERTAIN', self) from None
        finally:
            self._closed = not self._handles


class OwnedFileTransfer(_HandleCustody):
    """One explicitly acquired destination root; partial failures never roll back.

    Caller retains this object even after failure; errors also expose error.lease.
    close() releases handles only. It never deletes any created object, proves
    durability, or grants permission to release an unrelated extractor's seals.
    """
    def __init__(self, source_root, source_identity, destination_parent, parent_identity, destination_leaf):
        _need(os.name == 'nt', 'UNSUPPORTED_PLATFORM')
        _need(_abi(), 'UNSUPPORTED_ABI')
        self._source_path, self._parent_path = _root(source_root), _root(destination_parent)
        self._leaf = _component(destination_leaf)
        source_identity, parent_identity = _identity(source_identity), _identity(parent_identity)
        target = ntpath.join(self._parent_path, self._leaf).lower()
        source = self._source_path.lower()
        inside = lambda a, b: a == b or a.startswith(b.rstrip('\\') + '\\')
        _need(not inside(source, target) and not inside(target, source) and source_identity != parent_identity, 'ROOT_OVERLAP')
        self._source_pin, self._parent_pin = source_identity, parent_identity
        self._init_custody()
        self._source_dirs, self._destination_dirs = {}, {}
        self._borrow_parent = None
        self._attempted = self._acquired = self._poisoned = self._closed = False
        self._files = self._total = 0
        self._destinations = set()

    def acquire(self):
        with self._operation():
            return self._acquire()

    def _acquire(self):
        _need(not self._attempted, 'ALREADY_ATTEMPTED')
        self._attempted = True
        try:
            if self._borrow_parent is None:
                source = self._existing_root(self._source_path, self._source_pin)
            else:
                _need(self._borrow_parent._acquired and not self._borrow_parent._closed
                      and not self._borrow_parent._poisoned, 'BORROW_HELD')
                source = self._borrow_parent._temp_handle
                _need(_snapshot(source, True)[0] == self._source_pin, 'ROOT_IDENTITY_MISMATCH')
            parent = self._existing_root(self._parent_path, self._parent_pin)
            _need(_snapshot(source, True)[0] != _snapshot(parent, True)[0], 'ROOT_OVERLAP')
            destination, _ = self._open(parent, self._leaf, True, create=True)
            self._source_dirs[()] = source
            self._destination_dirs[()] = destination
            self._acquired = True
            return self.status()
        except BaseException as error:
            self._poisoned = True
            if not isinstance(error, Exception):
                error.lease = self
                raise
            raise self._error(error) from None

    def _directory(self, parts, source):
        cache = self._source_dirs if source else self._destination_dirs
        key = ()
        for part in parts:
            next_key = (*key, part)
            if next_key not in cache:
                handle, _ = self._open(cache[key], part, True, create=not source)
                cache[next_key] = handle
            key = next_key
        return cache[key]

    def transfer(self, source_relative, destination_relative, expected_size, expected_sha256):
        with self._operation():
            return self._transfer(source_relative, destination_relative, expected_size, expected_sha256)

    def _transfer(self, source_relative, destination_relative, expected_size, expected_sha256):
        try:
            _need(self._acquired, 'NOT_ACQUIRED')
            source_parts, destination_parts = _relative(source_relative), _relative(destination_relative)
            _need(type(expected_size) is int and 0 <= expected_size <= MAX_FILE_BYTES
                  and type(expected_sha256) is str and re.fullmatch(r'[a-f0-9]{64}', expected_sha256), 'INVALID_PROOF')
            folded = destination_relative.lower()
            _need(folded not in self._destinations and self._files < MAX_FILES
                  and self._total + expected_size <= MAX_TOTAL_BYTES, 'LIMIT')
            self._files += 1
            self._total += expected_size
            self._destinations.add(folded)
            source_parent = self._directory(source_parts[:-1], True)
            source, before = self._open(source_parent, source_parts[-1], False)
            _need(before[1] == expected_size and _hash(source, expected_size) == expected_sha256
                  and _snapshot(source, False) == before, 'SOURCE_MISMATCH')
            destination_parent = self._directory(destination_parts[:-1], False)
            destination, initial = self._open(destination_parent, destination_parts[-1], False, create=True, writable=True)
            _need(initial[1] == 0 and initial[2] == 1, 'UNSAFE_DESTINATION')
            _seek(source)
            copied, remaining = hashlib.sha256(), expected_size
            while remaining:
                data = _read(source, min(remaining, CHUNK_BYTES))
                _need(data, 'SIZE_MISMATCH')
                _write(destination, data)
                copied.update(data)
                remaining -= len(data)
            _need(not _read(source, 1) and copied.hexdigest() == expected_sha256
                  and _snapshot(source, False) == before, 'SOURCE_CHANGED')
            finished = _snapshot(destination, False)
            _need(finished[2] == 1 and _hash(destination, expected_size) == expected_sha256
                  and _snapshot(destination, False) == finished, 'DESTINATION_MISMATCH')
            return {'sourceIdentity': _label(before[0]), 'destinationIdentity': _label(finished[0]), 'bytes': expected_size,
                    'sha256': expected_sha256, 'effectsAllowed': False, 'persistenceVerified': False}
        except BaseException as error:
            self._poisoned = True
            if not isinstance(error, Exception):
                error.lease = self
                raise
            raise self._error(error) from None

    def status(self):
        return {'acquired': self._acquired, 'poisoned': self._poisoned, 'closed': self._closed,
                'closeUncertain': any(entry.phase == 'close-uncertain' for entry in self._handles),
                'retainedHandles': len(self._handles), 'attemptedFiles': self._files, 'attemptedBytes': self._total,
                'effectsAllowed': False, 'persistenceVerified': False, 'nativeInstallAccepted': False}



class ArchiveTempLease(_HandleCustody):
    """Physical custody only; no child-terminal, installation or cleanup authority.

    The trusted caller must independently seal its actual extractor owner and
    observe every child/pipe before begin_transfer. No JSON proof is accepted.
    Root handles cannot fence descendant insertion or 7z's overwrite policy.
    """
    def __init__(self, binding, archive_parent, archive_parent_identity, archive_leaf,
                 archive_identity, expected_size, expected_sha256,
                 temp_parent, temp_parent_identity, temp_leaf):
        _need(os.name == 'nt', 'UNSUPPORTED_PLATFORM')
        _need(_abi(), 'UNSUPPORTED_ABI')
        fields = {'operationId': r'op_[a-f0-9]{32}', 'nativeJobId': r'exec_[a-f0-9]{32}',
                  'requestSHA256': r'[a-f0-9]{64}', 'rendererGeneration': r'renderer_[a-f0-9]{32}'}
        _need(type(binding) is dict and set(binding) == set(fields), 'INVALID_BINDING')
        _need(all(type(binding[key]) is str and re.fullmatch(pattern, binding[key])
                  for key, pattern in fields.items()), 'INVALID_BINDING')
        self._binding = dict(binding)
        self._archive_parent, self._temp_parent = _root(archive_parent), _root(temp_parent)
        self._archive_leaf, self._temp_leaf = _component(archive_leaf), _component(temp_leaf)
        self._archive_pin, self._archive_parent_pin = _identity(archive_identity), _identity(archive_parent_identity)
        self._temp_parent_pin = _identity(temp_parent_identity)
        self._temp_path = _root(ntpath.join(self._temp_parent, self._temp_leaf))
        archive_path = _root(ntpath.join(self._archive_parent, self._archive_leaf)).lower()
        temp_path = self._temp_path.lower()
        inside = lambda a, b: a == b or a.startswith(b.rstrip('\\') + '\\')
        _need(not inside(archive_path, temp_path) and not inside(temp_path, archive_path), 'ROOT_OVERLAP')
        _need(type(expected_size) is int and 0 <= expected_size <= 64 * 1024 * 1024
              and type(expected_sha256) is str and re.fullmatch(r'[a-f0-9]{64}', expected_sha256), 'INVALID_PROOF')
        self._size, self._sha = expected_size, expected_sha256
        self._init_custody()
        self._attempted = self._acquired = self._poisoned = self._closed = False
        self._archive_handle = self._temp_handle = None
        self._archive_snapshot = self._temp_pin = None
        self._borrow = None
        self._borrow_attempted = False

    def acquire(self):
        with self._operation():
            _need(not self._attempted, 'ALREADY_ATTEMPTED')
            self._attempted = True
            try:
                parent = self._existing_root(self._archive_parent, self._archive_parent_pin)
                archive, observed = self._open(parent, self._archive_leaf, False)
                self._archive_handle = archive
                _need(observed[0] == self._archive_pin and observed[1] == self._size
                      and _hash(archive, self._size) == self._sha
                      and _snapshot(archive, False) == observed, 'ARCHIVE_MISMATCH')
                self._archive_snapshot = observed
                temp_parent = self._existing_root(self._temp_parent, self._temp_parent_pin)
                temp, observed_temp = self._open(temp_parent, self._temp_leaf, True, create=True)
                self._temp_handle, self._temp_pin = temp, observed_temp[0]
                self._acquired = True
                return self.status()
            except BaseException as error:
                self._poisoned = True
                if not isinstance(error, Exception):
                    error.lease = self
                    raise
                raise self._error(error) from None

    def begin_transfer(self, destination_parent, parent_identity, new_leaf):
        with self._operation():
            _need(self._acquired and not self._borrow_attempted, 'BORROW_UNAVAILABLE')
            try:
                _need(_snapshot(self._archive_handle, False) == self._archive_snapshot
                      and _hash(self._archive_handle, self._size) == self._sha
                      and _snapshot(self._archive_handle, False) == self._archive_snapshot
                      and _snapshot(self._temp_handle, True)[0] == self._temp_pin, 'CUSTODY_CHANGED')
                borrow = OwnedFileTransfer(self._temp_path, _label(self._temp_pin),
                                           destination_parent, parent_identity, new_leaf)
                # Reserve before native acquisition; retained even if it fails.
                self._borrow_attempted = True
                self._borrow = borrow
                borrow._pool.owners.remove(borrow)
                borrow._pool = self._pool
                self._pool.owners.append(borrow)
                borrow._lock, borrow._thread = self._lock, self._thread
                borrow._borrow_parent = self
                borrow._acquire()
                return borrow
            except BaseException as error:
                self._poisoned = True
                if not isinstance(error, Exception):
                    if self._borrow is not None:
                        self._borrow._poisoned = True
                    error.lease = self._borrow if self._borrow is not None else self
                    raise
                if self._borrow is not None:
                    self._borrow._poisoned = True
                    if isinstance(error, OwnedTransferError):
                        error.lease = self._borrow
                        raise
                    raise OwnedTransferError('IO_FAILED', self._borrow) from None
                raise self._error(error) from None

    def status(self):
        return {'binding': dict(self._binding), 'acquired': self._acquired, 'poisoned': self._poisoned, 'closed': self._closed,
                'closeUncertain': any(entry.phase == 'close-uncertain' for entry in self._handles),
                'retainedHandles': len(self._handles), 'borrowAttempted': self._borrow_attempted,
                'borrowActive': self._borrow is not None and not self._borrow._closed,
                'effectsAllowed': False, 'persistenceVerified': False,
                'nativeInstallAccepted': False, 'nativeTerminalVerified': False}
