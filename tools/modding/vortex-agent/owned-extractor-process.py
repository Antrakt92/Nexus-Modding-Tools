"""Internal fixed Windows x64 extractor owner; import is inert.

Only ArchiveTempLease's fixed sibling loader constructs this owner. No CLI,
MCP/IPC endpoint, executable/argv options, callbacks, retry, destructor or deletion.
Known child/pipe closure is physical custody evidence, never installation,
descendant or persistence authority. Directory contents remain concurrently
insertable; bounded empty-root preflight is not an ACL or no-clobber guarantee.
"""
import ctypes as C
from ctypes import wintypes as W
from contextlib import contextmanager
import os
import re
from pathlib import Path
import subprocess

EXE = Path('C:/Program Files/Vortex/resources/app.asar.unpacked/node_modules/7z-bin/win32/7z.exe')
EXE_SHA256 = 'fcd699098397e8981104c51afe32f4527cb6f02a5b64cbb6b2581f4749808e8c'
DLL_SHA256 = 'bbd705e3b58ca7677c1e9e67473f166a6712da034dcb567d571fbb67507a443f'
CHUNK = 65536
PIPE_BYTES = 65536
TAIL = 4096
OUTPUT_LIMIT = 8 * 1024 * 1024
CUSTODY_CODES = frozenset(('HANDLE_LIMIT', 'HANDLE_NOT_OWNED', 'INFORMATION_FAILED',
    'OPEN_REFUSED', 'UNEXPECTED_OPEN', 'UNSAFE_OBJECT', 'UNSUPPORTED_DRIVE',
    'UNSUPPORTED_DRIVE_MAPPING', 'UNSUPPORTED_FILESYSTEM', 'ROOT_IDENTITY_MISMATCH',
    'READ_FAILED', 'SEEK_FAILED', 'SIZE_MISMATCH', 'LIMIT', 'CLOSE_FAILED',
    'CLOSE_UNCERTAIN', 'IO_FAILED'))


class OwnedExtractorError(Exception):
    def __init__(self, code, owner=None):
        self.code = code if type(code) is str and re.fullmatch(r'[A-Z][A-Z0-9_]{0,99}', code) else 'NATIVE_OPERATION_FAILED'
        super().__init__('OWNED_EXTRACTOR_PROCESS_' + self.code)
        self.owner = owner
        self.lease = owner._lease if owner is not None else None


def need(value, code):
    if not value:
        raise OwnedExtractorError(code)


def win(value, code):
    if not value:
        raise OwnedExtractorError(code + '_WIN' + str(C.get_last_error()))


class Startup(C.Structure):
    _fields_ = [('cb', W.DWORD), ('reserved', W.LPWSTR), ('desktop', W.LPWSTR), ('title', W.LPWSTR),
                ('x', W.DWORD), ('y', W.DWORD), ('xs', W.DWORD), ('ys', W.DWORD),
                ('xc', W.DWORD), ('yc', W.DWORD), ('fill', W.DWORD), ('flags', W.DWORD),
                ('show', W.WORD), ('reservedSize', W.WORD), ('reservedData', C.c_void_p),
                ('stdin', W.HANDLE), ('stdout', W.HANDLE), ('stderr', W.HANDLE)]


class StartupEx(C.Structure):
    _fields_ = [('startup', Startup), ('attributes', C.c_void_p)]


class ProcessInfo(C.Structure):
    _fields_ = [('process', W.HANDLE), ('thread', W.HANDLE), ('pid', W.DWORD), ('tid', W.DWORD)]


class BasicJob(C.Structure):
    _fields_ = [('processTime', C.c_longlong), ('jobTime', C.c_longlong), ('flags', W.DWORD),
                ('minWorking', C.c_size_t), ('maxWorking', C.c_size_t), ('active', W.DWORD),
                ('affinity', C.c_size_t), ('priority', W.DWORD), ('scheduling', W.DWORD)]


class ExtendedJob(C.Structure):
    _fields_ = [('basic', BasicJob), ('io', C.c_ulonglong*6), ('processMemory', C.c_size_t),
                ('jobMemory', C.c_size_t), ('peakProcess', C.c_size_t), ('peakJob', C.c_size_t)]


class Security(C.Structure):
    _fields_ = [('size', W.DWORD), ('descriptor', C.c_void_p), ('inherit', W.BOOL)]


def check_abi():
    need(os.name == 'nt' and all(C.sizeof(kind) == size for kind, size in
         ((C.c_void_p, 8), (Startup, 104), (StartupEx, 112), (ProcessInfo, 24),
          (BasicJob, 64), (ExtendedJob, 144))), 'WINDOWS_X64_ABI_REFUSED')


def api():
    check_abi()
    k = C.WinDLL('kernel32', use_last_error=True)
    signatures = {
        'CreateJobObjectW': ([C.c_void_p, W.LPCWSTR], W.HANDLE),
        'SetInformationJobObject': ([W.HANDLE, C.c_int, C.c_void_p, W.DWORD], W.BOOL),
        'QueryInformationJobObject': ([W.HANDLE, C.c_int, C.c_void_p, W.DWORD, C.c_void_p], W.BOOL),
        'TerminateJobObject': ([W.HANDLE, W.UINT], W.BOOL),
        'SetHandleInformation': ([W.HANDLE, W.DWORD, W.DWORD], W.BOOL),
        'CreatePipe': ([C.POINTER(W.HANDLE), C.POINTER(W.HANDLE), C.POINTER(Security), W.DWORD], W.BOOL),
        'CreateFileW': ([W.LPCWSTR, W.DWORD, W.DWORD, C.POINTER(Security), W.DWORD, W.DWORD, W.HANDLE], W.HANDLE),
        'ReadFile': ([W.HANDLE, C.c_void_p, W.DWORD, C.POINTER(W.DWORD), C.c_void_p], W.BOOL),
        'PeekNamedPipe': ([W.HANDLE, C.c_void_p, W.DWORD, C.c_void_p, C.POINTER(W.DWORD), C.c_void_p], W.BOOL),
        'InitializeProcThreadAttributeList': ([C.c_void_p, W.DWORD, W.DWORD, C.POINTER(C.c_size_t)], W.BOOL),
        'UpdateProcThreadAttribute': ([C.c_void_p, W.DWORD, C.c_size_t, C.c_void_p, C.c_size_t, C.c_void_p, C.c_void_p], W.BOOL),
        'DeleteProcThreadAttributeList': ([C.c_void_p], None),
        'CreateProcessW': ([W.LPCWSTR, W.LPWSTR, C.c_void_p, C.c_void_p, W.BOOL, W.DWORD,
                           C.c_void_p, W.LPCWSTR, C.POINTER(StartupEx), C.POINTER(ProcessInfo)], W.BOOL),
        'GetProcessId': ([W.HANDLE], W.DWORD), 'GetThreadId': ([W.HANDLE], W.DWORD),
        'GetProcessIdOfThread': ([W.HANDLE], W.DWORD),
        'GetProcessTimes': ([W.HANDLE, C.POINTER(W.FILETIME), C.POINTER(W.FILETIME),
                             C.POINTER(W.FILETIME), C.POINTER(W.FILETIME)], W.BOOL),
        'QueryFullProcessImageNameW': ([W.HANDLE, W.DWORD, W.LPWSTR, C.POINTER(W.DWORD)], W.BOOL),
        'IsProcessInJob': ([W.HANDLE, W.HANDLE, C.POINTER(W.BOOL)], W.BOOL),
        'ResumeThread': ([W.HANDLE], W.DWORD), 'WaitForSingleObject': ([W.HANDLE, W.DWORD], W.DWORD),
        'GetExitCodeProcess': ([W.HANDLE, C.POINTER(W.DWORD)], W.BOOL),
    }
    for name, (arguments, result) in signatures.items():
        function = getattr(k, name)
        function.argtypes, function.restype = arguments, result
    return k



def _bind(custody_type, lease_type, snapshot, hash_file, custody_error_type):
    """Private fixed-loader binding, retaining the ORIGINAL loaded lease class.

    This is a trusted in-process module boundary, not a Python sandbox. There is
    no caller-supplied bridge on any returned owner's public methods.
    """
    class Owner(custody_type):
        def __init__(self, lease):
            need(type(lease) is lease_type, 'FOREIGN_LEASE')
            self._lease = lease
            self._init_custody(lease._pool)
            self._kernel = None
            self._start_attempted = self._resume_attempted = self._resumed = False
            self._cancelled = self._poisoned = self._closed = False
            self._close_attempted = False
            self._error_code = None
            self._creation_attempted = False
            self._creation_result = None
            self._allocation_pending = None
            self._unknown_allocation = False
            self._attributes = None
            self._inherit_storage = self._jobs_storage = None
            self._attributes_initialized = False
            self._attributes_uncertain = False
            self._pi = ProcessInfo()
            self._process_entry = self._thread_entry = self._job_entry = None
            self._reads, self._writes = [], []
            self._writer_close_attempted = False
            self._process_terminal = False
            self._exit_code = None
            self._identity = None
            self._pipes = [{'eof': False, 'bytes': 0, 'tail': b'', 'error': None, 'overflow': False}
                           for _ in range(2)]

        @contextmanager
        def _locked(self):
            try:
                with self._operation(closing=True):
                    yield
            except BaseException as error:
                error.owner, error.lease = self, self._lease
                raise

        @contextmanager
        def _faults(self):
            try:
                yield
            except BaseException as error:
                self._poisoned = self._lease._poisoned = True
                if self._allocation_pending is not None:
                    self._unknown_allocation = True
                if not isinstance(error, Exception):
                    self._error_code = self._error_code or 'INTERRUPTED'
                    error.owner, error.lease = self, self._lease
                    raise
                if isinstance(error, OwnedExtractorError):
                    self._error_code = self._error_code or error.code
                    error.owner, error.lease = self, self._lease
                    raise
                code = 'NATIVE_OPERATION_FAILED'
                if isinstance(error, custody_error_type):
                    text = str(error)
                    for candidate in CUSTODY_CODES:
                        if text == 'OWNED_TRANSFER_' + candidate:
                            code = 'CUSTODY_' + candidate
                            break
                self._error_code = self._error_code or code
                raise OwnedExtractorError(code, self) from None

        def _returned_handle(self, function, code):
            # Return-value APIs have an unavoidable async interruption window.
            # Premark it; an uncaptured return permanently holds, never succeeds.
            entry = self._reserve_handle()
            entry.phase = 'allocation-uncertain'
            self._allocation_pending = entry
            value = function()
            entry.cell.value = value
            entry.phase = 'open'
            self._allocation_pending = None
            win(value not in (None, C.c_void_p(-1).value), code)
            return entry

        def _current_custody(self):
            lease = self._lease
            need(lease._extractor is self and lease._acquired and not lease._closed
                 and not lease._poisoned and not lease._borrow_attempted, 'LEASE_NOT_CURRENT')
            need(snapshot(lease._archive_handle, False) == lease._archive_snapshot
                 and hash_file(lease._archive_handle, lease._size) == lease._sha
                 and snapshot(lease._archive_handle, False) == lease._archive_snapshot,
                 'ARCHIVE_CHANGED')
            before = snapshot(lease._temp_handle, True)
            need(before[0] == lease._temp_pin, 'TEMP_IDENTITY_CHANGED')
            # Held ancestry/root anchors this pathname. Only one entry is read.
            with os.scandir(lease._temp_path) as contents:
                need(next(contents, None) is None, 'TEMP_NOT_EMPTY')
            need(snapshot(lease._temp_handle, True) == before, 'TEMP_CHANGED')

        def _runtime_files(self):
            root = self._root_handle(str(EXE.parent))
            for name, digest in ((EXE.name, EXE_SHA256), ('7z.dll', DLL_SHA256)):
                handle, before = self._open(root, name, False)
                need(0 < before[1] <= 32*1024*1024 and hash_file(handle, before[1]) == digest
                     and snapshot(handle, False) == before, 'EXTRACTOR_SOURCE_MISMATCH')

        def _process_identity(self):
            k, pi = self._kernel, self._pi
            times = [W.FILETIME() for _ in range(4)]
            win(k.GetProcessTimes(pi.process, *(C.byref(value) for value in times)), 'PROCESS_TIMES_FAILED')
            image, length, member = C.create_unicode_buffer(1024), W.DWORD(1024), W.BOOL()
            win(k.QueryFullProcessImageNameW(pi.process, 0, image, C.byref(length)), 'PROCESS_IMAGE_FAILED')
            win(k.IsProcessInJob(pi.process, self._job_entry.cell.value, C.byref(member)), 'PROCESS_JOB_QUERY_FAILED')
            need(k.GetProcessId(pi.process) == pi.pid and k.GetThreadId(pi.thread) == pi.tid
                 and k.GetProcessIdOfThread(pi.thread) == pi.pid and pi.pid > 0 and pi.tid > 0
                 and Path(image.value) == EXE and member.value, 'PROCESS_IDENTITY_MISMATCH')
            return {'processId': pi.pid, 'threadId': pi.tid,
                    'creationTime': (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime,
                    'image': image.value, 'jobMembershipVerified': True}

        def _drop_writer_copies(self):
            self._writer_close_attempted = True
            failure = None
            for entry in self._writes:
                # Closing one copy must not strand later known-open writers.
                # An uncertain raw value is NEVER queried or closed again.
                if entry not in self._handles or entry.phase == 'close-uncertain':
                    continue
                try:
                    if not self._release_handle(entry) and failure is None:
                        failure = OwnedExtractorError('PARENT_PIPE_CLOSE_FAILED')
                except BaseException as error:
                    if failure is None:
                        failure = error
            if failure is not None:
                raise failure

        def _delete_attributes(self):
            need(not self._attributes_uncertain, 'ATTRIBUTE_CLEANUP_UNCERTAIN')
            if self._attributes_initialized:
                self._attributes_uncertain = True
                self._kernel.DeleteProcThreadAttributeList(self._attributes)
                self._attributes_initialized = False
                self._attributes = None
                self._inherit_storage = self._jobs_storage = None
                self._attributes_uncertain = False

        def start(self):
            with self._locked():
                need(not self._closed and not self._close_attempted and not self._start_attempted and not self._cancelled
                     and not self._poisoned, 'START_REFUSED')
                need(self._lease._acquired and not self._lease._closed and not self._lease._poisoned,
                     'LEASE_NOT_ACQUIRED')
                self._start_attempted = True
                with self._faults():
                    self._current_custody()
                    self._runtime_files()
                    if self._kernel is None:
                        self._kernel = api()
                    k = self._kernel
                    self._job_entry = self._returned_handle(lambda: k.CreateJobObjectW(None, None), 'JOB_CREATE_FAILED')
                    limits = ExtendedJob()
                    limits.basic.flags = 0x2000
                    win(k.SetInformationJobObject(self._job_entry.cell.value, 9, C.byref(limits), C.sizeof(limits)), 'JOB_LIMIT_FAILED')
                    actual_limits = ExtendedJob()
                    win(k.QueryInformationJobObject(self._job_entry.cell.value, 9, C.byref(actual_limits), C.sizeof(actual_limits), None), 'JOB_QUERY_FAILED')
                    need(actual_limits.basic.flags & 0x2000, 'JOB_KILL_FLAG_MISSING')
                    security = Security(C.sizeof(Security), None, True)
                    for _ in range(2):
                        read, write = self._reserve_handle(), self._reserve_handle()
                        self._reads.append(read)
                        self._writes.append(write)
                        win(k.CreatePipe(C.byref(read.cell), C.byref(write.cell), C.byref(security), PIPE_BYTES), 'PIPE_CREATE_FAILED')
                        read.phase = write.phase = 'open'
                        win(k.SetHandleInformation(read.cell.value, 1, 0), 'PIPE_INHERIT_CLEAR_FAILED')
                    nul = self._returned_handle(lambda: k.CreateFileW('NUL', 0x80000000, 3, C.byref(security), 3, 0, None), 'NUL_OPEN_FAILED')
                    self._writes.append(nul)
                    size = C.c_size_t()
                    k.InitializeProcThreadAttributeList(None, 2, 0, C.byref(size))
                    need(0 < size.value <= 65536, 'ATTRIBUTE_SIZE_REFUSED')
                    self._attributes = C.create_string_buffer(size.value)
                    # Unknown init completion holds this allocation, not a retry.
                    self._attributes_uncertain = True
                    win(k.InitializeProcThreadAttributeList(self._attributes, 2, 0, C.byref(size)), 'ATTRIBUTE_INIT_FAILED')
                    self._attributes_initialized = True
                    self._attributes_uncertain = False
                    self._inherit_storage = (W.HANDLE*3)(*(entry.cell.value for entry in self._writes))
                    self._jobs_storage = (W.HANDLE*1)(self._job_entry.cell.value)
                    win(k.UpdateProcThreadAttribute(self._attributes, 0, 0x20002, self._inherit_storage, C.sizeof(self._inherit_storage), None, None), 'HANDLE_LIST_FAILED')
                    win(k.UpdateProcThreadAttribute(self._attributes, 0, 0x2000D, self._jobs_storage, C.sizeof(self._jobs_storage), None, None), 'JOB_LIST_FAILED')
                    startup = StartupEx()
                    startup.startup.cb = C.sizeof(startup)
                    startup.startup.flags = 0x100
                    startup.startup.stdin, startup.startup.stdout, startup.startup.stderr = nul.cell.value, self._writes[0].cell.value, self._writes[1].cell.value
                    startup.attributes = C.cast(self._attributes, C.c_void_p)
                    archive = str(Path(self._lease._archive_parent)/self._lease._archive_leaf)
                    argv = [str(EXE), 'x', archive, '-o'+self._lease._temp_path, '-bb3', '-ssc-', '-y', '-bsp1']
                    command = C.create_unicode_buffer(subprocess.list2cmdline(argv))
                    environment = C.create_unicode_buffer('SystemRoot='+os.environ['SystemRoot']+'\0TEMP='+self._lease._temp_path+'\0TMP='+self._lease._temp_path+'\0\0')
                    self._process_entry = self._reserve_handle(W.HANDLE.from_buffer(self._pi, ProcessInfo.process.offset))
                    self._thread_entry = self._reserve_handle(W.HANDLE.from_buffer(self._pi, ProcessInfo.thread.offset))
                    self._creation_attempted = True
                    self._creation_result = bool(k.CreateProcessW(str(EXE), command, None, None, True,
                         0x4 | 0x80000 | 0x08000000 | 0x400, environment, self._lease._temp_path,
                         C.byref(startup), C.byref(self._pi)))
                    win(self._creation_result, 'PROCESS_CREATE_FAILED')
                    self._process_entry.phase = self._thread_entry.phase = 'open'
                    self._identity = self._process_identity()
                    self._delete_attributes()
                    self._drop_writer_copies()
                    return self.status()

        def resume(self):
            with self._locked():
                need(not self._closed and not self._close_attempted and not self._poisoned and not self._cancelled
                     and self._identity is not None and not self._resume_attempted, 'RESUME_REFUSED')
                self._resume_attempted = True
                with self._faults():
                    need(self._kernel.ResumeThread(self._pi.thread) == 1, 'RESUME_COUNT_MISMATCH')
                    self._resumed = True
                    return self.status()

        def _read_pipe(self, index):
            pipe = self._pipes[index]
            if pipe['eof']:
                return
            available, used = W.DWORD(), W.DWORD()
            k, handle = self._kernel, self._reads[index].cell.value
            if not k.PeekNamedPipe(handle, None, 0, None, C.byref(available), None):
                pipe['error'] = C.get_last_error()
                need(pipe['error'] == 109, 'PIPE_PEEK_FAILED')
                pipe['eof'] = True
                return
            if not available.value:
                return
            buffer = C.create_string_buffer(min(available.value, CHUNK))
            win(k.ReadFile(handle, buffer, len(buffer), C.byref(used), None), 'PIPE_READ_FAILED')
            need(0 < used.value <= len(buffer), 'PIPE_NO_PROGRESS')
            pipe['tail'] = (pipe['tail']+buffer.raw[:used.value])[-TAIL:]
            pipe['bytes'] = min(OUTPUT_LIMIT+1, pipe['bytes']+used.value)
            if pipe['bytes'] > OUTPUT_LIMIT and not pipe['overflow']:
                pipe['overflow'] = True
                raise OwnedExtractorError('OUTPUT_LIMIT')

        def poll(self):
            with self._locked():
                if self._closed or self._close_attempted or not self._creation_attempted or not self._pi.process:
                    return self.status()
                with self._faults():
                    self._drop_writer_copies()
                    wait = self._kernel.WaitForSingleObject(self._pi.process, 0)
                    need(wait in (0, 258), 'PROCESS_WAIT_FAILED')
                    if wait == 0:
                        code = W.DWORD()
                        win(self._kernel.GetExitCodeProcess(self._pi.process, C.byref(code)), 'EXIT_QUERY_FAILED')
                        self._process_terminal, self._exit_code = True, code.value
                    for index in range(2):
                        self._read_pipe(index)
                    return self.status()

        def terminate(self):
            with self._locked():
                self._cancelled = True  # Sticky BEFORE any native termination call.
                if (self._closed or self._close_attempted or self._job_entry is None
                        or self._job_entry not in self._handles or self._job_entry.phase != 'open'
                        or not self._job_entry.cell.value):
                    return self.status()
                with self._faults():
                    win(self._kernel.TerminateJobObject(self._job_entry.cell.value, 91), 'JOB_TERMINATE_FAILED')
                    return self.status()

        def close(self):
            with self._locked():
                if self._closed:
                    return self.status()
                need(not self._unknown_allocation and self._allocation_pending is None, 'ALLOCATION_UNCERTAIN')
                if self._creation_attempted:
                    if self._pi.process:
                        need(self._process_terminal and all(pipe['eof'] for pipe in self._pipes), 'PROCESS_OR_PIPES_ACTIVE')
                    else:
                        need(self._creation_result is False, 'PROCESS_CREATION_UNCERTAIN')
                self._close_attempted = True
                with self._faults():
                    self._delete_attributes()
                    self._close()  # SAME shared premarked CloseHandle/ABA ledger.
                    return self.status()

        def _handoff_ready_locked(self):
            return (self._closed and self._start_attempted and self._resumed
                    and not self._cancelled and not self._poisoned and not self._unknown_allocation
                    and self._process_terminal and self._exit_code == 0
                    and all(pipe['eof'] for pipe in self._pipes))

        def status(self):
            return {'binding': dict(self._lease._binding), 'startAttempted': self._start_attempted,
                    'resumeAttempted': self._resume_attempted, 'resumed': self._resumed,
                    'cancelled': self._cancelled, 'poisoned': self._poisoned, 'closed': self._closed,
                    'closeAttempted': self._close_attempted, 'errorCode': self._error_code,
                    'processCreationAttempted': self._creation_attempted,
                    'processTerminalObserved': self._process_terminal, 'stdoutEOF': self._pipes[0]['eof'],
                    'stderrEOF': self._pipes[1]['eof'], 'terminalObserved': self._process_terminal and all(pipe['eof'] for pipe in self._pipes),
                    'exitCode': self._exit_code, 'retainedHandles': len(self._handles),
                    'closeUncertain': self._unknown_allocation or self._attributes_uncertain
                         or any(entry.phase == 'close-uncertain' for entry in self._handles),
                    'processIdentity': dict(self._identity) if self._identity else None,
                    'stdoutBytes': self._pipes[0]['bytes'], 'stderrBytes': self._pipes[1]['bytes'],
                    'stdoutOutputLimitExceeded': self._pipes[0]['overflow'],
                    'stderrOutputLimitExceeded': self._pipes[1]['overflow'],
                    'effectsAllowed': False, 'persistenceVerified': False, 'nativeInstallAccepted': False,
                    'descendantsVerified': False}

    return Owner
