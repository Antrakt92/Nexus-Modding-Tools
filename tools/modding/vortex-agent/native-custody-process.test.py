"""Opt-in Windows x64 live-guardian custody integration test; import is inert.

Set VORTEX_NATIVE_CUSTODY_TEST=1, then python -B this-file.py -v.
Uses fresh own ZIP/scratch and fixed pinned installed 7z only. The surviving
supervisor owns ArchiveTempLease independently of launcher/reader lifetimes.
The launcher intentionally exits after exact process/thread/pipe takeover.
Guardian self-crash, Vortex installation, descendants and durability are NOT
proved. No automatic deletion or release of a failed/uncertain guardian lease.
"""
import ctypes as C
from ctypes import wintypes as W
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import random
import re
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
import unittest

HERE = Path(__file__).absolute().parent
ROOT = HERE.parents[2]
SOURCE = HERE/'owned-file-transfer.py'
INTENT_HELPER = HERE/'native-custody-intent-fixture.mjs'
NODE = Path('C:/Program Files/nodejs/node.exe')
INTENT_SOURCES = ('native-intent-journal.mjs', 'immutable-records.mjs', 'strict-json.cjs',
                  'paths.cjs', 'native-dispatch-contract.cjs', 'install-job-contract.cjs')
TASK = ROOT/'local-state/native-custody-process-tests'
EXE = Path('C:/Program Files/Vortex/resources/app.asar.unpacked/node_modules/7z-bin/win32/7z.exe')
EXE_SHA = 'fcd699098397e8981104c51afe32f4527cb6f02a5b64cbb6b2581f4749808e8c'
DLL_SHA = 'bbd705e3b58ca7677c1e9e67473f166a6712da034dcb567d571fbb67507a443f'


def need(value, code):
    if not value:
        raise RuntimeError(code)


def win(value, code):
    """Capture this thread's native error before cleanup can overwrite it."""
    if not value:
        raise RuntimeError(code+'_WIN'+str(C.get_last_error()))


def sha(path):
    result = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(65536), b''):
            result.update(chunk)
    return result.hexdigest()


def ordinary(path):
    for part in (path, *path.parents):
        if part.exists():
            need(not part.lstat().st_file_attributes & 0x400, 'REPARSE_REFUSED')


def packet(path, value):
    writing = path.with_name(path.name+'.writing')
    with writing.open('x', encoding='utf-8', newline='\n') as output:
        json.dump(value, output, indent=2)
        output.write('\n')
        output.flush()
        os.fsync(output.fileno())
    writing.rename(path)  # Windows same-volume publication refuses existing name.


def validate_run(run):
    run = Path(run).absolute()
    need(run.parent == TASK and re.fullmatch(r'custody-run-[a-z0-9_]+', run.name), 'RUN_SCOPE_REFUSED')
    ordinary(run)
    return run


def prepare(guardian_custody=True, crash_stage=None):
    """Explicit setup only; fresh own data, no process launched."""
    need(type(guardian_custody) is bool, 'INVALID_GUARDIAN_CUSTODY')
    need(crash_stage is None or type(crash_stage) is str and crash_stage in ('suspended', 'running'), 'INVALID_CRASH_STAGE')
    need(crash_stage is None or guardian_custody, 'CRASH_REQUIRES_GUARDIAN')
    check_abi()
    if crash_stage is not None:
        need(INTENT_HELPER.is_file() and NODE.is_file(), 'INTENT_RUNTIME_MISSING')
    need(sha(EXE) == EXE_SHA and sha(EXE.with_name('7z.dll')) == DLL_SHA, 'EXTRACTOR_DRIFT')
    intent_sources = {name: sha(HERE/name) for name in INTENT_SOURCES} if crash_stage else None
    ordinary(TASK)
    TASK.mkdir(parents=True, exist_ok=True)
    ordinary(TASK)
    run = Path(tempfile.mkdtemp(prefix='custody-run-', dir=TASK))
    for name in ('archives', 'temps', 'final'):
        (run/name).mkdir()
    payload = random.Random(31012026).randbytes(32*1024*1024)
    manifest = {'payload.bin': hashlib.sha256(payload).hexdigest()}
    with zipfile.ZipFile(run/'archives/own.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('payload.bin', payload)
        if crash_stage == 'running':
            for index in range(2048):
                name = 'entries/empty%04d.bin' % index
                archive.writestr(name, b'')
                manifest[name] = hashlib.sha256(b'').hexdigest()
    packet(run/'PLAN.json', {'schema': 'own-custody-process-fixture/1', 'guardianCustody': guardian_custody, 'crashStage': crash_stage,
           'payloadManifest': manifest, 'unpackedBytes': len(payload), 'payloadFileCount': len(manifest),
           'scriptSHA256': sha(Path(__file__)), 'moduleSHA256': sha(SOURCE),
           'intentHelperSHA256': sha(INTENT_HELPER) if crash_stage else None,
           'intentSourceSHA256': intent_sources,
           'nodeSHA256': sha(NODE) if crash_stage else None,
           'archiveSHA256': sha(run/'archives/own.zip'),
           'archiveBytes': (run/'archives/own.zip').stat().st_size,
           'payloadSHA256': hashlib.sha256(payload).hexdigest(), 'payloadBytes': len(payload),
           'extractorSHA256': EXE_SHA, 'dllSHA256': DLL_SHA,
           'nativeInstallAccepted': False})
    return run


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
        'GetCurrentProcess': ([], W.HANDLE), 'CloseHandle': ([W.HANDLE], W.BOOL),
        'CreateJobObjectW': ([C.c_void_p, W.LPCWSTR], W.HANDLE),
        'SetInformationJobObject': ([W.HANDLE, C.c_int, C.c_void_p, W.DWORD], W.BOOL),
        'QueryInformationJobObject': ([W.HANDLE, C.c_int, C.c_void_p, W.DWORD, C.c_void_p], W.BOOL),
        'TerminateJobObject': ([W.HANDLE, W.UINT], W.BOOL),
        'DuplicateHandle': ([W.HANDLE, W.HANDLE, W.HANDLE, C.POINTER(W.HANDLE), W.DWORD, W.BOOL, W.DWORD], W.BOOL),
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
        'TerminateProcess': ([W.HANDLE, W.UINT], W.BOOL),
        'GetNamedPipeInfo': ([W.HANDLE, C.c_void_p, C.POINTER(W.DWORD), C.POINTER(W.DWORD), C.c_void_p], W.BOOL),
        'MoveFileExW': ([W.LPCWSTR, W.LPCWSTR, W.DWORD], W.BOOL),
        'RemoveDirectoryW': ([W.LPCWSTR], W.BOOL),
    }
    for name, (arguments, result) in signatures.items():
        function = getattr(k, name)
        function.argtypes, function.restype = arguments, result
    return k


def duplicate(k, source_process, handle, inheritable=False):
    output = W.HANDLE()
    need(k.DuplicateHandle(source_process, handle, k.GetCurrentProcess(), C.byref(output),
                           0, inheritable, 2), 'DUPLICATE_FAILED')
    return output.value


def identity(path):
    stat = path.stat()
    return {'schema': 'win-file-id128/1', 'volumeSerialNumber': str(stat.st_dev), 'fileId': str(stat.st_ino)}


def process_identity(k, process, thread, job=None):
    times = [W.FILETIME() for _ in range(4)]
    need(k.GetProcessTimes(process, *(C.byref(value) for value in times)), 'PROCESS_TIMES_FAILED')
    image, length, inside = C.create_unicode_buffer(1024), W.DWORD(1024), W.BOOL()
    need(k.QueryFullProcessImageNameW(process, 0, image, C.byref(length)), 'PROCESS_IMAGE_FAILED')
    if job is not None:
        need(k.IsProcessInJob(process, job, C.byref(inside)) and inside.value, 'JOB_MEMBERSHIP_FAILED')
    pid, tid = k.GetProcessId(process), k.GetThreadId(thread)
    need(pid and tid and k.GetProcessIdOfThread(thread) == pid and Path(image.value) == EXE, 'PROCESS_IDENTITY_FAILED')
    return {'pid': pid, 'tid': tid, 'created': (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime,
            'image': image.value, 'inOwnJob': bool(inside.value) if job is not None else None}



def verify_intent_sources(plan):
    pins = plan.get('intentSourceSHA256')
    need(type(pins) is dict and set(pins) == set(INTENT_SOURCES), 'INTENT_SOURCE_SET_REFUSED')
    need(all(type(pins[name]) is str and re.fullmatch(r'[a-f0-9]{64}', pins[name])
             and sha(HERE/name) == pins[name] for name in INTENT_SOURCES), 'INTENT_SOURCE_DRIFT')

def load_plan(run):
    plan = json.loads((run/'PLAN.json').read_text('utf-8'))
    need(type(plan.get('guardianCustody')) is bool, 'INVALID_GUARDIAN_CUSTODY')
    need(plan.get('crashStage') in (None, 'suspended', 'running'), 'INVALID_CRASH_STAGE')
    need(sha(Path(__file__)) == plan['scriptSHA256'] and sha(SOURCE) == plan['moduleSHA256'], 'SOURCE_DRIFT')
    need(sha(EXE) == EXE_SHA and sha(EXE.with_name('7z.dll')) == DLL_SHA, 'EXTRACTOR_DRIFT')
    need(sha(run/'archives/own.zip') == plan['archiveSHA256'], 'ARCHIVE_DRIFT')
    if plan['crashStage'] is not None:
        verify_intent_sources(plan)
        need(sha(INTENT_HELPER) == plan['intentHelperSHA256'] and sha(NODE) == plan['nodeSHA256'], 'INTENT_HELPER_DRIFT')
    return plan


def keeper(run, job):
    """Private fixed-role subprocess. No arbitrary executable or command option."""
    run, k = validate_run(run), api()
    plan = load_plan(run)
    need(k.SetHandleInformation(job, 1, 0), 'JOB_INHERIT_CLEAR_FAILED')
    context = json.loads((run/'CONTEXT.json').read_text('utf-8'))
    need(identity(run/'temps/Extract') == context['tempIdentity'], 'LAUNCH_TEMP_IDENTITY_MISMATCH')
    archive = run/'archives/own.zip'
    child_handles, reads = [], []
    attributes = None
    attributes_initialized = False
    process = ProcessInfo()  # Retain native output cells before CreateProcessW.
    try:
        sa = Security(C.sizeof(Security), None, True)
        for _ in range(2):
            read, write = W.HANDLE(), W.HANDLE()
            need(k.CreatePipe(C.byref(read), C.byref(write), C.byref(sa), 0), 'PIPE_CREATE_FAILED')
            reads.append(read.value)
            child_handles.append(write.value)
            need(k.SetHandleInformation(read, 1, 0), 'PIPE_INHERIT_CLEAR_FAILED')
        nul = k.CreateFileW('NUL', 0x80000000, 3, C.byref(sa), 3, 0, None)
        need(nul not in (None, C.c_void_p(-1).value), 'NUL_OPEN_FAILED')
        child_handles.append(nul)
        count = C.c_size_t()
        k.InitializeProcThreadAttributeList(None, 2, 0, C.byref(count))
        need(0 < count.value <= 65536, 'ATTR_SIZE_REFUSED')
        attributes = C.create_string_buffer(count.value)
        need(k.InitializeProcThreadAttributeList(attributes, 2, 0, C.byref(count)), 'ATTR_INIT_FAILED')
        attributes_initialized = True
        handles = (W.HANDLE*len(child_handles))(*child_handles)
        jobs = (W.HANDLE*1)(job)
        need(job not in child_handles, 'JOB_MUST_NOT_BE_INHERITED')
        win(k.UpdateProcThreadAttribute(attributes, 0, 0x20002, handles, C.sizeof(handles), None, None), 'HANDLE_LIST_FAILED')
        win(k.UpdateProcThreadAttribute(attributes, 0, 0x2000D, jobs, C.sizeof(jobs), None, None), 'JOB_LIST_FAILED')
        startup = StartupEx()
        startup.startup.cb = C.sizeof(startup)
        startup.startup.flags = 0x100
        startup.startup.stdin, startup.startup.stdout, startup.startup.stderr = nul, child_handles[-3], child_handles[-2]
        startup.attributes = C.cast(attributes, C.c_void_p)
        argv = [str(EXE), 'x', str(archive), '-o'+str(run/'temps/Extract'), '-bb3', '-ssc-', '-y', '-bsp1']
        command = C.create_unicode_buffer(subprocess.list2cmdline(argv))
        environment = C.create_unicode_buffer('SystemRoot='+os.environ['SystemRoot']+'\0TEMP='+str(run)+'\0TMP='+str(run)+'\0\0')
        created = k.CreateProcessW(str(EXE), command, None, None, True, 0x4 | 0x80000 | 0x08000000 | 0x400,
             environment, str(run), C.byref(startup), C.byref(process))
        create_error = C.get_last_error() if not created else 0
        if not created:
            packet(run/'FAILURE.json', {'code': 'ATOMIC_CHILD_CREATE_FAILED', 'winError': create_error,
                   'childReturned': bool(process.process), 'environmentAPIRefusal': not bool(process.process)})
        need(created, 'ATOMIC_CHILD_CREATE_FAILED_WIN'+str(create_error))
        # Job membership was established atomically, before any child instruction.
        need(k.CloseHandle(job), 'KEEPER_JOB_CLOSE_FAILED')
        job = None
        # Job handle is intentionally gone: supervisor validates membership anew.
        times = [W.FILETIME() for _ in range(4)]
        need(k.GetProcessTimes(process.process, *(C.byref(value) for value in times)), 'ACK_TIMES_FAILED')
        image, image_length = C.create_unicode_buffer(1024), W.DWORD(1024)
        need(k.QueryFullProcessImageNameW(process.process, 0, image, C.byref(image_length))
             and Path(image.value) == EXE and k.GetProcessId(process.process) == process.pid
             and k.GetThreadId(process.thread) == process.tid
             and k.GetProcessIdOfThread(process.thread) == process.pid, 'ACK_IDENTITY_FAILED')
        packet(run/'ACK.json', {'pid': process.pid, 'tid': process.tid,
               'processHandle': process.process, 'threadHandle': process.thread, 'readHandles': reads,
               'created': (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime,
               'image': image.value, 'tempIdentity': context['tempIdentity'],
               'inheritedSealHandleCount': 0,
               'jobDuplicateClosed': True, 'sealHandleValuesPersisted': False})
        # Wait only for the surviving supervisor's fixed handoff/abort marker.
        while not (run/'TAKEOVER.json').exists() and not (run/'ABORT.json').exists():
            time.sleep(0.01)
        os._exit(73)  # Deliberate launcher crash; it never owned file seals.
    finally:
        if process.process:
            if job:
                k.TerminateJobObject(job, 92)
            # Retain launcher handles while this child
            # lives. If our job copy is already gone, supervisor owns abort;
            # its last job close also kills the child. WAIT_FAILED remains held.
            while k.WaitForSingleObject(process.process, 1000) != 0:
                time.sleep(0.01)
        if attributes_initialized:
            k.DeleteProcThreadAttributeList(attributes)
        # Before ACK failure, retain no orphan child: supervisor owns the job and
        # will terminate it. This keeper owns only process/stdio handles, never file seals.
        for handle in child_handles + reads:
            k.CloseHandle(handle)
        if process.thread:
            k.CloseHandle(process.thread)
        if process.process:
            k.CloseHandle(process.process)
        if job:
            k.CloseHandle(job)


def fence_probe(k, run, timings=None):
    output = {}
    for key, path, access, flags in (
        ('archiveWriteError', run/'archives/own.zip', 0x40000000, 0),
        ('archiveDeleteAccessError', run/'archives/own.zip', 0x10000, 0),
        ('tempDeleteAccessError', run/'temps/Extract', 0x10000, 0x02000000),
        ('archiveParentDeleteAccessError', run/'archives', 0x10000, 0x02000000),
        ('tempParentDeleteAccessError', run/'temps', 0x10000, 0x02000000),
    ):
        probe_started = time.monotonic() if timings is not None else None
        handle = k.CreateFileW(str(path), access, 7, None, 3, flags, None)
        output[key] = C.get_last_error() if handle == C.c_void_p(-1).value else 0
        if handle not in (None, C.c_void_p(-1).value):
            k.CloseHandle(handle)
        if timings is not None:
            timings.append({'probe': key, 'started': probe_started, 'finished': time.monotonic(), 'error': output[key]})
    return output  # No write, truncate, rename or deletion is performed.


def drain_pipe(k, handle, output, stop_readers):
    buffer, used, available = C.create_string_buffer(65536), W.DWORD(), W.DWORD()
    try:
        while not stop_readers.is_set():
            if not k.PeekNamedPipe(handle, None, 0, None, C.byref(available), None):
                output['error'] = C.get_last_error()
                output['eof'] = output['error'] == 109
                return
            if not available.value:
                stop_readers.wait(0.001)
                continue
            # Sole reader, no concurrent consumer: do not block asking
            # for bytes which have not actually arrived in this pipe.
            if not k.ReadFile(handle, buffer, min(available.value, len(buffer)), C.byref(used), None):
                output['error'] = C.get_last_error()
                output['eof'] = output['error'] == 109
                return
            need(used.value > 0, 'PIPE_NO_PROGRESS')
            output['bytes'] += used.value
        output['stoppedWithoutEOF'] = True
    except BaseException as error:
        output['exception'] = type(error).__name__


def supervise(run):
    run, k = validate_run(run), api()
    plan = load_plan(run)
    packet(run/'INTENT.json', {'scope': 'surviving-guardian-controlled-launcher-crash', 'nativeInstallAccepted': False})
    job = k.CreateJobObjectW(None, None)
    need(job, 'JOB_CREATE_FAILED')
    limits = ExtendedJob()
    limits.basic.flags = 0x2000
    handles, threads, logs, process = [], [], [], None
    reader_handles = []
    stop_readers = threading.Event()
    keeper_process = None
    guardian = None
    retained_process_handles = []
    result = {'nativeInstallAccepted': False, 'persistenceVerified': False, 'descendantsVerified': False,
              'scope': 'standalone surviving live guardian, deliberate launcher os._exit only'}
    try:
        win(k.SetInformationJobObject(job, 9, C.byref(limits), C.sizeof(limits)), 'JOB_LIMIT_FAILED')
        observed_limits = ExtendedJob()
        need(k.QueryInformationJobObject(job, 9, C.byref(observed_limits), C.sizeof(observed_limits), None)
             and observed_limits.basic.flags & 0x2000, 'JOB_KILL_FLAG_NOT_VERIFIED')
        result['beforeLease'] = fence_probe(k, run)
        need(result['beforeLease']['archiveWriteError'] == 0
             and result['beforeLease']['archiveDeleteAccessError'] == 0, 'NEGATIVE_BASELINE_NOT_OPEN')
        if plan['guardianCustody']:
            spec = importlib.util.spec_from_file_location('own_custody_fixture_module', SOURCE)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            archive = run/'archives/own.zip'
            if plan['crashStage'] is not None:
                binding = json.loads((run/'EXPECTED-BINDING.json').read_text('utf-8'))
            else:
                binding = {'operationId': 'op_'+'1'*32, 'nativeJobId': 'exec_'+'2'*32,
                           'requestSHA256': sha(run/'PLAN.json'), 'rendererGeneration': 'renderer_'+'3'*32}
            guardian = module.ArchiveTempLease(binding, str(archive.parent), identity(archive.parent), archive.name,
                       identity(archive), plan['archiveBytes'], plan['archiveSHA256'],
                       str(run/'temps'), identity(run/'temps'), 'Extract')
            guardian.acquire()
        else:
            (run/'temps/Extract').mkdir()  # Fresh control namespace, no held seals.
        packet(run/'CONTEXT.json', {'tempIdentity': identity(run/'temps/Extract'),
               'guardianCustody': plan['guardianCustody'], 'sealHandlesExported': False})
        inherited = duplicate(k, k.GetCurrentProcess(), job, True)
        try:
            startup = subprocess.STARTUPINFO()
            startup.lpAttributeList = {'handle_list': [inherited]}
            env = {'SystemRoot': os.environ['SystemRoot'], 'TEMP': str(run), 'TMP': str(run)}
            keeper_process = subprocess.Popen([sys.executable, '-B', str(Path(__file__)), '--keeper', str(run), str(inherited)],
                   env=env, close_fds=True, startupinfo=startup, creationflags=0x08000000)
        finally:
            k.CloseHandle(inherited)
        deadline = time.monotonic()+15
        while not (run/'ACK.json').exists():
            need(keeper_process.poll() is None and time.monotonic() < deadline, 'ACK_MISSING_OR_KEEPER_FAILED')
            time.sleep(0.01)
        ack = json.loads((run/'ACK.json').read_text('utf-8'))
        # Duplicate FROM the retained keeper PROCESS_DUP_HANDLE capability,
        # never reopen a PID; launcher has no seal handles to duplicate.
        for key in ('processHandle', 'threadHandle'):
            handles.append(duplicate(k, int(keeper_process._handle), ack[key]))
        process, thread = handles
        evidence = process_identity(k, process, thread, job)
        need(all(evidence[key] == ack[key] for key in ('pid', 'tid', 'created', 'image')), 'ACK_IDENTITY_MISMATCH')
        need(k.WaitForSingleObject(process, 0) == 258, 'CHILD_NOT_SUSPENDED_ALIVE')
        # Drain both real pipes BEFORE resuming. Only the bounded tail is kept.
        for original in ack['readHandles']:
            read = duplicate(k, int(keeper_process._handle), original)
            handles.append(read)
            reader_handles.append(read)
            output = {'bytes': 0, 'error': None, 'eof': False}
            logs.append(output)
            if plan['crashStage'] is None:
                worker = threading.Thread(target=drain_pipe, args=(k, read, output, stop_readers), daemon=True)
                worker.start()
                threads.append(worker)
        packet(run/'TAKEOVER.json', {'identity': evidence, 'guardianHoldsSealHandles': plan['guardianCustody'],
               'sealHandlesExported': False})
        need(keeper_process.wait(timeout=5) == 73, 'KEEPER_CRASH_NOT_OBSERVED')
        result['keeperExitCode'] = 73
        result['guardianCustody'] = plan['guardianCustody']
        result['inheritedSealHandleCount'] = ack['inheritedSealHandleCount']
        need(ack['inheritedSealHandleCount'] == 0, 'NO_SEAL_HANDLES_MAY_BE_EXPORTED')
        need(identity(run/'temps/Extract') == ack['tempIdentity'], 'TEMP_IDENTITY_MISMATCH')
        result['suspendedAfterKeeperCrash'] = fence_probe(k, run)
        expected_error = 32 if plan['guardianCustody'] else 0
        need(all(value == expected_error for value in result['suspendedAfterKeeperCrash'].values()),
             'FENCES_NOT_RETAINED' if plan['guardianCustody'] else 'CONTROL_EXTERNAL_FENCE_PRESENT')
        if plan['crashStage'] is not None:
            # The outer observer receives only process/thread/stdio capabilities.
            # Neither the Job handle nor any file/directory seal is exported.
            packet(run/'GUARDIAN-READY.json', {'identity': evidence,
                   'processHandle': process, 'threadHandle': thread, 'readHandles': reader_handles,
                   'binding': guardian.status()['binding'], 'bindingFileSHA256': sha(run/'EXPECTED-BINDING.json'),
                   'scriptSHA256': plan['scriptSHA256'], 'moduleSHA256': plan['moduleSHA256'],
                   'tempIdentity': ack['tempIdentity'], 'killOnJobCloseVerified': True,
                   'jobMembershipVerified': True, 'jobOrSealHandlesExported': False})
            outer_deadline = time.monotonic()+30
            while not (run/'OUTER-ACK.json').exists():
                need(not (run/'OUTER-ABORT.json').exists(), 'OUTER_ABORTED')
                need(time.monotonic() < outer_deadline, 'OUTER_ACK_DEADLINE')
                time.sleep(0.005)
            os._exit(75)  # Only the dedicated guardian subprocess may do this.
        need(k.ResumeThread(thread) == 1, 'RESUME_COUNT_MISMATCH')
        live_samples, live_rows = [], []
        reader_started = time.monotonic()
        reader_deadline = reader_started+10
        last_wait = None
        try:
            while True:
                before_wait = k.WaitForSingleObject(process, 0)
                last_wait = before_wait
                if before_wait != 258:
                    break
                need(time.monotonic() < reader_deadline, 'READER_DEADLINE')
                started, timings = time.monotonic(), []
                sample = fence_probe(k, run, timings)
                after_wait = k.WaitForSingleObject(process, 0)
                last_wait = after_wait
                finished = time.monotonic()
                row = {'beforeWait': before_wait, 'afterWait': after_wait,
                       'aliveBracket': before_wait == 258 and after_wait == 258,
                       'startedElapsedMs': round((started-reader_started)*1000, 3),
                       'finishedElapsedMs': round((finished-reader_started)*1000, 3),
                       'accessErrors': sample,
                       'probeOffsets': [{'probe': value['probe'], 'error': value['error'],
                                         'startedOffsetMs': round((value['started']-started)*1000, 3),
                                         'finishedOffsetMs': round((value['finished']-started)*1000, 3)}
                                        for value in timings]}
                live_rows.append(row)
                if after_wait == 258:
                    live_samples.append(sample)
                need(len(live_samples) <= 10000, 'LIVE_SAMPLE_LIMIT')
                time.sleep(0.001)
        finally:
            # Diagnostics precede every acceptance assertion, including failures.
            result['liveSamples'] = len(live_samples)
            result['liveProbeObservationCount'] = len(live_rows)
            result['liveProbeObservations'] = live_rows[:32]
            result['liveProbeObservationTail'] = live_rows[-32:] if len(live_rows) > 32 else []
            result['liveProbeObservationsTruncated'] = len(live_rows) > 64
            result['liveFirstElapsedMs'] = live_rows[0]['startedElapsedMs'] if live_rows else None
            result['liveLastElapsedMs'] = live_rows[-1]['finishedElapsedMs'] if live_rows else None
            result['readerElapsedMs'] = round((time.monotonic()-reader_started)*1000, 3)
            result['readerLastWait'] = last_wait
            observed_exit = W.DWORD()
            result['readerExitQueryOk'] = bool(k.GetExitCodeProcess(process, C.byref(observed_exit)))
            result['readerObservedExitCode'] = observed_exit.value if result['readerExitQueryOk'] else None
        final_wait = k.WaitForSingleObject(process, 1000)
        result['readerFinalWait'] = final_wait
        need(final_wait == 0, 'CHILD_TERMINAL_UNCERTAIN')
        exit_code = W.DWORD()
        exit_ok = bool(k.GetExitCodeProcess(process, C.byref(exit_code)))
        result['readerExitQueryOk'] = exit_ok
        result['readerExitCode'] = exit_code.value if exit_ok else None
        need(exit_ok and exit_code.value == 0, 'CHILD_EXIT_NOT_ZERO')
        for worker in threads:
            worker.join(timeout=5)
            need(not worker.is_alive(), 'PIPE_DRAIN_UNCERTAIN')
        need(all(log['eof'] for log in logs), 'PIPE_EOF_NOT_OBSERVED')
        if plan['guardianCustody']:
            need(live_samples, 'NO_LIVE_SAMPLE')
            need(all(all(value[key] == 32 for key in
                 ('archiveWriteError', 'archiveDeleteAccessError', 'tempDeleteAccessError',
                  'archiveParentDeleteAccessError', 'tempParentDeleteAccessError'))
                 for value in live_samples), 'LIVE_FENCE_RELEASED')
        result['payloadVerified'] = (sha(run/'temps/Extract/payload.bin') == plan['payloadSHA256']
             and (run/'temps/Extract/payload.bin').stat().st_size == plan['payloadBytes'])
        need(result['payloadVerified'], 'PAYLOAD_MISMATCH')
        need(identity(run/'temps/Extract') == ack['tempIdentity'], 'FINAL_TEMP_IDENTITY_MISMATCH')
        # The guardian remains alive independently of reader ExitProcess.
        # Even AFTER exact child0 and both pipe EOFs, custody must still hold.
        result['afterReaderBeforeGuardianClose'] = fence_probe(k, run)
        need(all(value == expected_error for value in result['afterReaderBeforeGuardianClose'].values()),
             'GUARDIAN_CUSTODY_LOST_BEFORE_CLOSE' if plan['guardianCustody'] else 'CONTROL_EXTERNAL_FENCE_PRESENT')
        if guardian is not None:
            guardian.close()  # Normal terminal + EOF established above; never in finally.
        result['afterGuardianClose'] = fence_probe(k, run)
        need(all(value == 0 for value in result['afterGuardianClose'].values()), 'FENCES_NOT_RELEASED')
        need(sha(SOURCE) == plan['moduleSHA256'] and sha(EXE) == EXE_SHA and sha(EXE.with_name('7z.dll')) == DLL_SHA,
             'FINAL_SOURCE_DRIFT')
        need(sha(run/'archives/own.zip') == plan['archiveSHA256']
             and (run/'archives/own.zip').stat().st_size == plan['archiveBytes'], 'FINAL_ARCHIVE_DRIFT')
        result.update({'process': evidence, 'allReaderPipesDrained': True, 'pipeObservations': logs,
                       'archiveFenceReleased': True, 'rootFenceReleased': True,
                       'sourcePinsUnchanged': True, 'passed': True})
    except BaseException as error:
        result.update({'passed': False, 'code': str(error) if isinstance(error, RuntimeError) else type(error).__name__})
        if (run/'FAILURE.json').exists():
            result['keeperFailure'] = json.loads((run/'FAILURE.json').read_text('utf-8'))
        k.TerminateJobObject(job, 91)  # Own unnamed job only; never PID/name kills.
        if not (run/'ABORT.json').exists():
            try:
                packet(run/'ABORT.json', {'abort': True})
            except BaseException:
                result['keeperAbortSignalUncertain'] = True
        if process:
            result['abortedChildJoined'] = k.WaitForSingleObject(process, 5000) == 0
        if keeper_process is not None:
            try:
                result['keeperFinalExitCode'] = keeper_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                result['keeperStillUncertain'] = True
        for worker in threads:
            worker.join(timeout=5)
    finally:
        stop_readers.set()
        for worker in threads:
            worker.join(timeout=2)
        # Never close an I/O HANDLE underneath a still-running synchronous
        # reader. Preserve that own handle/thread and report uncertainty.
        active_reads = {handle for handle, worker in zip(reader_handles, threads) if worker.is_alive()}
        if active_reads:
            result.update({'passed': False, 'readerResourcesHeld': True})
        terminal_known = process is not None and k.WaitForSingleObject(process, 0) == 0
        result['exactReaderTerminalAtCleanup'] = terminal_known
        for handle in reversed(handles):
            if handle in active_reads or (not terminal_known and handle in handles[:2]):
                retained_process_handles.append(handle)
                result.update({'passed': False, 'processResourcesHeld': True})
            elif not k.CloseHandle(handle):
                retained_process_handles.append(handle)
                result.update({'passed': False, 'closeUncertain': True})
        if not k.CloseHandle(job):
            result.update({'passed': False, 'jobCloseUncertain': True})
        if guardian is not None and not guardian.status()['closed']:
            result['guardianHeld'] = True
            result['guardianStatus'] = guardian.status()
        try:
            packet(run/'REPORT.json', result)
        except BaseException as error:
            error.lease, error.result, error.run = guardian, result, run
            error.retained_process_handles = tuple(retained_process_handles)
            error.keeper_process = keeper_process
            raise
    if not result.get('passed'):
        error = RuntimeError('CUSTODY_FIXTURE_HELD: '+str(run/'REPORT.json'))
        error.lease, error.result, error.run = guardian, result, run
        error.retained_process_handles = tuple(retained_process_handles)
        error.keeper_process = keeper_process
        raise error
    return result



def intent_fixture(run, mode, binding=None):
    """Fixed real journal fixture CLI, never a generic script/command input."""
    plan = load_plan(run)
    need(mode in ('begin', 'read'), 'INTENT_MODE_REFUSED')
    argv = [str(NODE), str(INTENT_HELPER), mode, str(run)]
    if mode == 'read':
        argv.extend((binding['operationId'], binding['requestSHA256']))
    output = subprocess.run(argv, cwd=ROOT, env={'SystemRoot': os.environ['SystemRoot'],
             'TEMP': str(run), 'TMP': str(run)}, capture_output=True, timeout=15, creationflags=0x08000000)
    need(output.returncode == 0 and len(output.stdout) <= 8192, 'INTENT_HELPER_REFUSED')
    def unique(pairs):
        value = {}
        for key, item in pairs:
            need(key not in value, 'INTENT_DUPLICATE_JSON')
            value[key] = item
        return value
    value = json.loads(output.stdout.decode('utf-8'), object_pairs_hook=unique)
    need(type(value) is dict, 'INTENT_OUTPUT_REFUSED')
    if mode == 'begin':
        fields = {'operationId': r'op_[a-f0-9]{32}', 'nativeJobId': r'exec_[a-f0-9]{32}',
                  'requestSHA256': r'[a-f0-9]{64}', 'rendererGeneration': r'renderer_[a-f0-9]{32}'}
        need(set(value) == set(fields) and all(type(value[key]) is str and re.fullmatch(pattern, value[key])
             for key, pattern in fields.items()), 'INTENT_BINDING_REFUSED')
    else:
        need(value.get('operationId') == binding['operationId']
             and value.get('requestSHA256') == binding['requestSHA256']
             and value.get('state') == 'intent_observed' and value.get('dispatchState') == 'unknown'
             and value.get('reconcileRequired') is True and value.get('canReplay') is False
             and value.get('effectsAllowed') is False and value.get('powerLossPersistenceVerified') is False,
             'INTENT_STATUS_NOT_HELD')
    need(sha(INTENT_HELPER) == plan['intentHelperSHA256'] and sha(NODE) == plan['nodeSHA256'], 'INTENT_HELPER_DRIFT')
    verify_intent_sources(plan)
    return value


def running_backpressure(k, process, stdout, evidence):
    """Observe actual own extraction output, then a full unread stdout pipe.

    This is a bounded fixture signal with known remaining output, not a generic
    Windows thread-state or universal scheduler proof.
    """
    outgoing, incoming = W.DWORD(), W.DWORD()
    win(k.GetNamedPipeInfo(stdout, None, C.byref(outgoing), C.byref(incoming), None), 'PIPE_INFO_FAILED')
    capacity = outgoing.value or incoming.value
    evidence.update({'stdoutBufferBytes': capacity, 'outgoingBufferBytes': outgoing.value,
                     'incomingBufferBytes': incoming.value, 'noReaderThreadsStarted': True,
                     'ownEntryOutputObserved': False, 'consumedBytes': 0})
    need(0 < capacity <= 65536, 'PIPE_CAPACITY_REFUSED')
    buffer, used, available = C.create_string_buffer(65536), W.DWORD(), W.DWORD()
    observed = bytearray()
    deadline = time.monotonic()+10
    while b'entries/' not in observed and b'entries\\' not in observed:
        need(time.monotonic() < deadline and k.WaitForSingleObject(process, 0) == 258, 'RUNNING_OUTPUT_NOT_OBSERVED')
        win(k.PeekNamedPipe(stdout, None, 0, None, C.byref(available), None), 'OUTPUT_PEEK_FAILED')
        if available.value:
            win(k.ReadFile(stdout, buffer, min(available.value, 4096), C.byref(used), None), 'OUTPUT_READ_FAILED')
            need(used.value > 0, 'OUTPUT_NO_PROGRESS')
            observed.extend(buffer.raw[:used.value])
            evidence['consumedBytes'] = len(observed)
            need(len(observed) <= 128*1024, 'OUTPUT_LIMIT')
        else:
            time.sleep(0.001)
    evidence['ownEntryOutputObserved'] = True
    # Stop consuming stdout. The known 2048 entry lines exceed its real capacity.
    samples = []
    while len(samples) < 8:
        need(time.monotonic() < deadline, 'BACKPRESSURE_NOT_OBSERVED')
        before = k.WaitForSingleObject(process, 0)
        win(k.PeekNamedPipe(stdout, None, 0, None, C.byref(available), None), 'BACKPRESSURE_PEEK_FAILED')
        after = k.WaitForSingleObject(process, 0)
        evidence['lastPipeObservation'] = {'availableBytes': available.value, 'beforeWait': before, 'afterWait': after}
        need(before == 258 and after == 258, 'CHILD_EXITED_BEFORE_CRASH_ACK')
        if available.value >= capacity:
            samples.append({'availableBytes': available.value, 'beforeWait': before, 'afterWait': after,
                            'monotonic': time.monotonic()})
        else:
            samples.clear()
        evidence['unreadFullPipeSamples'] = list(samples)
        time.sleep(0.005)
    return evidence


def observe_guardian_crash(run):
    """Outer observer never receives a Job or file/directory seal handle."""
    run, k = validate_run(run), api()
    plan = load_plan(run)
    need(plan['guardianCustody'] and plan['crashStage'] in ('suspended', 'running'), 'CRASH_SCOPE_REFUSED')
    binding = intent_fixture(run, 'begin')  # Exactly once, BEFORE guardian launch.
    held_binding_sha = sha(run/'EXPECTED-BINDING.json')
    packet(run/'OUTER-INTENT.json', {'binding': binding, 'scope': 'own guardian self-crash fixture',
           'jobOrSealHandlesReceived': False, 'nativeInstallAccepted': False})
    handles, readers, workers, logs = [], [], [], []
    stop = threading.Event()
    guardian_process = None
    process = thread = None
    verified_reader = False
    retained = []
    result = {'nativeInstallAccepted': False, 'effectsAllowed': False, 'persistenceVerified': False,
              'descendantsVerified': False, 'crashStage': plan['crashStage'],
              'jobOrSealHandlesReceived': False, 'scope': 'own guardian self-crash qualification only'}
    try:
        guardian_process = subprocess.Popen([sys.executable, '-B', str(Path(__file__)), '--crash-guardian', str(run)],
             env={'SystemRoot': os.environ['SystemRoot'], 'TEMP': str(run), 'TMP': str(run)},
             close_fds=True, creationflags=0x08000000)
        deadline = time.monotonic()+20
        while not (run/'GUARDIAN-READY.json').exists():
            need(guardian_process.poll() is None and time.monotonic() < deadline, 'GUARDIAN_READY_MISSING')
            time.sleep(0.005)
        ready = json.loads((run/'GUARDIAN-READY.json').read_text('utf-8'))
        need(ready['binding'] == binding and ready['bindingFileSHA256'] == held_binding_sha
             and ready['scriptSHA256'] == plan['scriptSHA256'] and ready['moduleSHA256'] == plan['moduleSHA256']
             and ready['killOnJobCloseVerified'] is True and ready['jobMembershipVerified'] is True
             and ready['jobOrSealHandlesExported'] is False, 'GUARDIAN_READY_BINDING_REFUSED')
        for key in ('processHandle', 'threadHandle'):
            handles.append(duplicate(k, int(guardian_process._handle), ready[key]))
        process, thread = handles
        actual = process_identity(k, process, thread)  # Deliberately no Job capability.
        need(all(actual[key] == ready['identity'][key] for key in ('pid', 'tid', 'created', 'image')),
             'GUARDIAN_CHILD_IDENTITY_MISMATCH')
        verified_reader = True
        for original in ready['readHandles']:
            read = duplicate(k, int(guardian_process._handle), original)
            handles.append(read)
            readers.append(read)
        need(len(readers) == 2 and k.WaitForSingleObject(process, 0) == 258, 'CRASH_CHILD_NOT_SUSPENDED_ALIVE')
        result['processIdentity'] = actual
        result['guardianVerifiedJobMembership'] = ready['jobMembershipVerified']
        result['guardianVerifiedKillOnJobClose'] = ready['killOnJobCloseVerified']
        result['resumeCount'] = 0
        if plan['crashStage'] == 'running':
            need(k.ResumeThread(thread) == 1, 'CRASH_RESUME_COUNT_MISMATCH')
            result['resumeCount'] = 1
            result['runningEvidence'] = {}
            running_backpressure(k, process, readers[0], result['runningEvidence'])
        else:
            result['suspendedEvidence'] = {'childWait': k.WaitForSingleObject(process, 0), 'neverResumed': True}
            need(result['suspendedEvidence']['childWait'] == 258, 'SUSPENDED_CHILD_NOT_ALIVE')
        need(k.WaitForSingleObject(process, 0) == 258, 'CHILD_EXITED_BEFORE_GUARDIAN_CRASH')
        packet(run/'OUTER-ACK.json', {'binding': binding, 'childIdentity': actual,
               'stage': plan['crashStage'], 'physicalEvidenceObserved': True})
        need(guardian_process.wait(timeout=5) == 75, 'GUARDIAN_SELF_CRASH_NOT_OBSERVED')
        result['guardianExitCode'] = 75
        result['readerFinalWait'] = k.WaitForSingleObject(process, 5000)
        need(result['readerFinalWait'] == 0, 'READER_SURVIVED_GUARDIAN_CRASH')
        exit_code = W.DWORD()
        win(k.GetExitCodeProcess(process, C.byref(exit_code)), 'CRASH_EXIT_QUERY_FAILED')
        result['readerExitCode'] = exit_code.value
        # ExitProcess status is diagnostic. Even an unresumed reader can receive
        # zero from Job termination; it is never native completion evidence.
        result['readerExitCodeIsSuccessProof'] = False
        result['ownerLost'] = True
        result['nativeCompletionAccepted'] = False
        need(not (run/'REPORT.json').exists(), 'UNEXPECTED_NORMAL_GUARDIAN_RECEIPT')
        result['normalGuardianReceiptAbsent'] = True
        for handle in readers:
            log = {'bytes': 0, 'error': None, 'eof': False}
            logs.append(log)
            worker = threading.Thread(target=drain_pipe, args=(k, handle, log, stop), daemon=True)
            worker.start()
            workers.append(worker)
        for worker in workers:
            worker.join(timeout=5)
            need(not worker.is_alive(), 'CRASH_PIPE_DRAIN_UNCERTAIN')
        need(len(logs) == 2 and all(log['eof'] for log in logs), 'CRASH_PIPE_EOF_NOT_OBSERVED')
        result['pipeObservations'] = logs
        # Fresh process/read with the independently retained original digest.
        result['journalStatus'] = intent_fixture(run, 'read', binding)
        result.update({'passed': True, 'allReaderPipesDrained': True,
                       'filesystemSuccessOrTransferClaimed': False, 'nativeAdmissionVerified': False})
    except BaseException as error:
        result.update({'passed': False, 'code': str(error) if isinstance(error, RuntimeError) else type(error).__name__})
        try:
            if not (run/'OUTER-ABORT.json').exists():
                packet(run/'OUTER-ABORT.json', {'abort': True})
        except BaseException:
            result['guardianAbortSignalUncertain'] = True
        # No name/PID kills: only the exact retained own reader capability.
        if verified_reader and process and k.WaitForSingleObject(process, 0) == 258:
            result['emergencyTerminateExactReader'] = bool(k.TerminateProcess(process, 94))
            result['emergencyReaderJoined'] = k.WaitForSingleObject(process, 5000) == 0
        if guardian_process is not None:
            try:
                result['guardianFinalExitCode'] = guardian_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                result['guardianStillHeld'] = True
    finally:
        stop.set()
        for worker in workers:
            worker.join(timeout=2)
        active_reads = {handle for handle, worker in zip(readers, workers) if worker.is_alive()}
        terminal = process is not None and k.WaitForSingleObject(process, 0) == 0
        for handle in reversed(handles):
            if handle in active_reads or (not terminal and handle in handles[:2]):
                retained.append(handle)
                result.update({'passed': False, 'resourcesHeld': True})
            elif not k.CloseHandle(handle):
                retained.append(handle)
                result.update({'passed': False, 'closeUncertain': True})
        try:
            packet(run/'OUTER-REPORT.json', result)
        except BaseException as error:
            error.guardian_process, error.retained_process_handles = guardian_process, tuple(retained)
            raise
    if not result.get('passed'):
        error = RuntimeError('GUARDIAN_CRASH_FIXTURE_HELD: '+str(run/'OUTER-REPORT.json'))
        error.guardian_process, error.retained_process_handles, error.result = guardian_process, tuple(retained), result
        raise error
    return result

def _keeper_main():
    # This fixed child branch intentionally needs no opt-in environment flag:
    # its supervisor passes only a minimal stdlib environment.
    need(len(sys.argv) == 4 and sys.argv[1] == '--keeper', 'PRIVATE_KEEPER_ONLY')
    try:
        keeper(sys.argv[2], int(sys.argv[3]))
    except BaseException as error:
        # Do not dump tracebacks, process arguments or any native seal values.
        run = validate_run(sys.argv[2])
        code = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        if not re.fullmatch(r'[A-Za-z_0-9]{1,100}', code):
            code = 'KEEPER_FAILED'
        if not (run/'FAILURE.json').exists():
            try:
                packet(run/'FAILURE.json', {'code': code,
                       'environmentAPIRefusal': code.startswith(('JOB_LIST_FAILED_WIN', 'HANDLE_LIST_FAILED_WIN'))})
            except BaseException:
                pass  # Existing .writing/INTENT is held evidence, never replay.
        sys.exit(74)


def _crash_guardian_main():
    need(len(sys.argv) == 3 and sys.argv[1] == '--crash-guardian', 'PRIVATE_GUARDIAN_ONLY')
    run = validate_run(sys.argv[2])
    try:
        need(load_plan(run)['crashStage'] in ('suspended', 'running'), 'PRIVATE_CRASH_SCOPE_REFUSED')
        supervise(run)
        raise RuntimeError('GUARDIAN_CRASH_NOT_REACHED')
    except BaseException as error:
        code = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        if not re.fullmatch(r'[A-Za-z_0-9]{1,100}', code):
            code = 'GUARDIAN_FAILED'
        try:
            packet(run/'GUARDIAN-FAILURE.json', {'code': code, 'nativeInstallAccepted': False})
        except BaseException:
            pass
        sys.exit(74)


@unittest.skipUnless(os.name == 'nt' and C.sizeof(C.c_void_p) == 8
                     and os.environ.get('VORTEX_NATIVE_CUSTODY_TEST') == '1',
                     'Opt-in Windows x64 native test: set VORTEX_NATIVE_CUSTODY_TEST=1')
class NativeCustodyProcessTest(unittest.TestCase):
    def test_live_guardian_retains_custody_after_launcher_and_reader_exit(self):
        run = prepare(guardian_custody=True)
        result = supervise(run)
        self.assertTrue(result.get('passed'), str(run/'REPORT.json')+': '+str(result.get('code', 'held')))
        self.assertEqual(result['inheritedSealHandleCount'], 0)
        self.assertTrue(all(value == 32 for value in result['afterReaderBeforeGuardianClose'].values()))
        self.assertFalse(result['nativeInstallAccepted'])

    def test_control_without_guardian_has_no_custody_before_reader_runs(self):
        # Same job, stdio, launcher crash and suspended reader. Only a separate
        # surviving custodian differs; child handle inheritance is identical.
        run = prepare(guardian_custody=False)
        result = supervise(run)
        self.assertTrue(result.get('passed'), str(run/'REPORT.json')+': '+str(result.get('code', 'held')))
        self.assertEqual(result['inheritedSealHandleCount'], 0)
        self.assertTrue(all(value == 0 for value in result['suspendedAfterKeeperCrash'].values()))
        self.assertTrue(all(value == 0 for value in result['afterReaderBeforeGuardianClose'].values()))
        self.assertFalse(result['nativeInstallAccepted'])

    def test_guardian_self_crash_terminates_exact_suspended_reader(self):
        result = observe_guardian_crash(prepare(crash_stage='suspended'))
        self.assertTrue(result['passed'])
        self.assertEqual(result['resumeCount'], 0)
        self.assertTrue(result['ownerLost'])
        self.assertFalse(result['readerExitCodeIsSuccessProof'])
        self.assertFalse(result['nativeCompletionAccepted'])
        self.assertEqual(result['journalStatus']['dispatchState'], 'unknown')
        self.assertTrue(result['journalStatus']['reconcileRequired'])
        self.assertFalse(result['journalStatus']['canReplay'])
        self.assertFalse(result['journalStatus']['effectsAllowed'])

    def test_guardian_self_crash_terminates_exact_running_backpressured_reader(self):
        result = observe_guardian_crash(prepare(crash_stage='running'))
        self.assertTrue(result['passed'])
        self.assertTrue(result['runningEvidence']['ownEntryOutputObserved'])
        self.assertTrue(result['ownerLost'])
        self.assertFalse(result['readerExitCodeIsSuccessProof'])
        self.assertFalse(result['nativeCompletionAccepted'])
        self.assertEqual(result['journalStatus']['dispatchState'], 'unknown')
        self.assertTrue(result['journalStatus']['reconcileRequired'])
        self.assertFalse(result['journalStatus']['canReplay'])
        self.assertFalse(result['journalStatus']['effectsAllowed'])


if __name__ == '__main__':
    if sys.argv[1:2] == ['--keeper']:
        _keeper_main()
    elif sys.argv[1:2] == ['--crash-guardian']:
        _crash_guardian_main()
    else:
        unittest.main()
