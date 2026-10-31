"""Internal classic ZIP decoder into exclusively created, handle-owned files.

No CLI, subprocess, callbacks, path-based extraction or cleanup. The ORIGINAL
archive HANDLE is read; every new directory/file uses relative NT FILE_CREATE.
The parent retains output writer HANDLEs even after decoder close. Only its
fixed same-handle borrower can consume the sealed output map. No installation,
durability, hostile-privilege or arbitrary namespace-isolation permit is granted.
"""
from contextlib import contextmanager
import hashlib
import re
import struct
import zlib

CHUNK = 65536
MAX_ARCHIVE = MAX_ENTRY = 64*1024*1024
MAX_TOTAL = 256*1024*1024
MAX_ENTRIES = 4096


class OwnedZipError(Exception):
    def __init__(self, code, owner=None):
        self.code = code if type(code) is str and re.fullmatch(r'[A-Z][A-Z0-9_]{0,99}', code) else 'OPERATION_FAILED'
        super().__init__('OWNED_ZIP_' + self.code)
        self.owner = owner
        self.lease = owner._lease if owner is not None else None


def need(ok, code):
    if not ok:
        raise OwnedZipError(code)


def _bind(lease_type, snapshot, hash_file, seek_at, read_handle, write_handle, relative, custody_error_type):
    def parts(value, directory=False):
        need(type(value) is str and 0 < len(value) <= 512 and re.fullmatch(r'[A-Za-z0-9_./ -]+', value), 'UNSAFE_PATH')
        clean = value[:-1] if directory and value.endswith('/') else value
        try:
            result = relative(clean)
        except Exception:
            raise OwnedZipError('UNSAFE_PATH') from None
        need(clean != '__proto__' and all(item.lower() not in ('fomod', '__folder_managed_by_vortex') for item in result)
             and result[-1].lower() != 'vortex_override_instructions.json', 'UNSUPPORTED_INSTALLER')
        return result

    class Owner:
        _backend = 'zip'

        def __init__(self, lease, expected_payload, expected_total):
            need(type(lease) is lease_type, 'FOREIGN_LEASE')
            self._lease = lease
            need(type(expected_payload) is dict and 0 < len(expected_payload) <= MAX_ENTRIES
                 and type(expected_total) is int and 0 <= expected_total <= MAX_TOTAL, 'INVALID_SCOPE')
            self._expected = {}
            for name, digest in expected_payload.items():
                key = parts(name)
                need(type(digest) is str and re.fullmatch(r'[a-f0-9]{64}', digest), 'INVALID_SCOPE')
                self._expected[key] = digest
            need(len(self._expected) == len(expected_payload), 'INVALID_SCOPE')
            self._total = expected_total
            self._start_attempted = self._started = self._completed = False
            self._cancelled = self._poisoned = self._closed = False
            self._error_code = None
            self._created = self._verified = self._written = 0
            self._files, self._directories, self._outputs = [], [], {}
            self._dir_cache = {}
            self._file_index = self._dir_index = 0
            self._current = None
            self._archive_snapshot = None

        @contextmanager
        def _locked(self):
            try:
                with self._lease._operation(closing=True):
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
                if not isinstance(error, Exception):
                    self._error_code = self._error_code or 'INTERRUPTED'
                    error.owner, error.lease = self, self._lease
                    raise
                code = error.code if isinstance(error, OwnedZipError) else 'OPERATION_FAILED'
                if isinstance(error, custody_error_type):
                    for candidate in ('HANDLE_LIMIT', 'CREATE_REFUSED', 'OPEN_REFUSED', 'INFORMATION_FAILED', 'UNSAFE_OBJECT',
                                      'UNEXPECTED_OPEN', 'READ_FAILED', 'WRITE_FAILED', 'SEEK_FAILED', 'SIZE_MISMATCH'):
                        if str(error) == 'OWNED_TRANSFER_'+candidate:
                            code = 'CUSTODY_'+candidate
                            break
                self._error_code = self._error_code or code
                raise OwnedZipError(code, self) from None

        def _entry_handle(self, entry):
            need(entry in self._lease._handles and entry.phase == 'open'
                 and entry.cell.value not in (None, -1), 'CUSTODY_ENTRY_NOT_OPEN')
            return entry.cell.value

        def _exact(self, offset, count):
            need(type(offset) is int and type(count) is int and 0 <= offset <= self._lease._size
                 and 0 <= count <= 65557 and offset+count <= self._lease._size, 'ZIP_BOUNDS')
            seek_at(self._lease._archive_handle, offset)
            result = bytearray()
            while len(result) < count:
                chunk = read_handle(self._lease._archive_handle, min(CHUNK, count-len(result)))
                need(chunk, 'ARCHIVE_TRUNCATED')
                result.extend(chunk)
            return bytes(result)

        def _metadata(self):
            size = self._lease._size
            need(22 <= size <= MAX_ARCHIVE, 'ARCHIVE_LIMIT')
            tail_start = max(0, size-65557)
            tail = self._exact(tail_start, size-tail_start)
            end = None
            for at in range(len(tail)-22, -1, -1):
                if tail[at:at+4] == b'PK\x05\x06' and at+22+struct.unpack_from('<H', tail, at+20)[0] == len(tail):
                    end = tail_start+at
                    break
            need(end is not None, 'UNSUPPORTED_ZIP')
            eocd = self._exact(end, 22)
            disk, central_disk, disk_count, count, central_bytes, central, comment = struct.unpack_from('<4H2IH', eocd, 4)
            need(disk == central_disk == 0 and disk_count == count and 0 < count <= MAX_ENTRIES
                 and central+central_bytes == end, 'UNSUPPORTED_ZIP')
            files, dirs, ranges, names, prefixes = [], set(), [], {}, {}
            cursor, total = central, 0
            for _ in range(count):
                need(cursor+46 <= end, 'ZIP_BOUNDS')
                header = self._exact(cursor, 46)
                need(header[:4] == b'PK\x01\x02', 'UNSUPPORTED_ZIP')
                version, flags, method, mtime, mdate, crc, packed, unpacked, nlen, extra, csize, start_disk, internal, attributes, local = struct.unpack_from('<5H3I5H2I', header, 6)
                next_cursor = cursor+46+nlen+extra+csize
                need(next_cursor <= end and version <= 20 and method in (0, 8) and flags & ~0x0806 == 0
                     and start_disk == 0 and extra == 0 and unpacked <= MAX_ENTRY and nlen <= 512, 'UNSUPPORTED_ZIP')
                raw = self._exact(cursor+46, nlen)
                need(raw and all(value < 128 for value in raw), 'UNSAFE_PATH')
                name = raw.decode('ascii')
                directory = name.endswith('/')
                key = parts(name, directory)
                mode = (attributes >> 16) & 0xf000
                need(mode in (0, 0x4000 if directory else 0x8000)
                     and (not attributes & 0x10 or directory) and not attributes & (0x08|0x40|0x400), 'UNSUPPORTED_ZIP')
                folded = tuple(item.lower() for item in key)
                need(folded not in names, 'DUPLICATE_PATH')
                names[folded] = directory
                for length in range(1, len(key)+1):
                    prefix = key[:length]
                    folded_prefix = tuple(item.lower() for item in prefix)
                    need(folded_prefix not in prefixes or prefixes[folded_prefix] == prefix, 'CASE_COLLISION')
                    prefixes[folded_prefix] = prefix
                    if length < len(key) or directory:
                        dirs.add(prefix)
                        need(len(dirs)+len(self._expected) <= self._lease._remaining_handles(), 'HANDLE_BUDGET')
                need(local+30 <= central, 'ZIP_BOUNDS')
                local_header = self._exact(local, 30)
                need(local_header[:4] == b'PK\x03\x04', 'UNSUPPORTED_ZIP')
                lv, lf, lm, lt, ld, lc, lp, lu, ln, le = struct.unpack_from('<5H3I2H', local_header, 4)
                data = local+30+ln+le
                need((lv,lf,lm,lt,ld,lc,lp,lu,ln,le) == (version,flags,method,mtime,mdate,crc,packed,unpacked,nlen,0)
                     and data+packed <= central and self._exact(local+30, ln) == raw, 'HEADER_DISAGREEMENT')
                need(method != 0 or packed == unpacked, 'STORED_SIZE_MISMATCH')
                if directory:
                    need(method == 0 and packed == unpacked == crc == 0, 'DIRECTORY_DATA')
                else:
                    files.append({'parts': key, 'data': data, 'packed': packed, 'size': unpacked, 'crc': crc, 'method': method})
                    total += unpacked
                    need(total <= MAX_TOTAL, 'TOTAL_LIMIT')
                ranges.append((local, data+packed))
                cursor = next_cursor
            need(cursor == end and files and {row['parts'] for row in files} == set(self._expected)
                 and total == self._total, 'PAYLOAD_SCOPE_MISMATCH')
            ranges.sort()
            need(ranges[0][0] == 0 and ranges[-1][1] == central
                 and all(ranges[n][0] == ranges[n-1][1] for n in range(1,len(ranges))), 'OVERLAPPING_ZIP')
            for folded in names:
                need(all(names.get(folded[:n], True) for n in range(1,len(folded))), 'FILE_DIRECTORY_COLLISION')
            need(len(dirs)+len(files) <= self._lease._remaining_handles(), 'HANDLE_BUDGET')
            return files, sorted(dirs, key=lambda key: (len(key), key))

        def start(self):
            with self._locked():
                need(not self._closed and not self._start_attempted and not self._cancelled and not self._poisoned, 'START_REFUSED')
                need(self._lease._acquired and not self._lease._closed and not self._lease._poisoned, 'LEASE_NOT_ACQUIRED')
                self._start_attempted = True
                with self._faults():
                    need(self._lease._extractor is self and not self._lease._borrow_attempted, 'LEASE_NOT_CURRENT')
                    before = snapshot(self._lease._archive_handle, False)
                    need(before == self._lease._archive_snapshot and hash_file(self._lease._archive_handle, self._lease._size) == self._lease._sha
                         and snapshot(self._lease._archive_handle, False) == before, 'ARCHIVE_CHANGED')
                    self._archive_snapshot = before
                    self._files, self._directories = self._metadata()
                    root = next((entry for entry in self._lease._handles if entry.cell.value == self._lease._temp_handle and entry.phase == 'open'), None)
                    need(root is not None and snapshot(self._entry_handle(root), True)[0] == self._lease._temp_pin, 'TEMP_CHANGED')
                    self._dir_cache[()] = root
                    self._started = True
                    return self.status()

        def _healthy(self):
            need(self._started and not self._closed and not self._cancelled and not self._poisoned
                 and self._lease._acquired and not self._lease._closed and not self._lease._poisoned
                 and self._lease._extractor is self, 'PUMP_REFUSED')

        def pump(self):
            with self._locked():
                self._healthy()
                if self._completed:
                    return self.status()
                with self._faults():
                    if self._dir_index < len(self._directories):
                        key = self._directories[self._dir_index]
                        parent = self._entry_handle(self._dir_cache[key[:-1]])
                        handle, observed = self._lease._open(parent, key[-1], True, create=True)
                        entry = self._lease._handles[-1]
                        need(entry.cell.value == handle and observed[0], 'OUTPUT_CUSTODY_LOST')
                        self._dir_cache[key] = entry
                        self._dir_index += 1
                        return self.status()
                    if self._current is None:
                        row = self._files[self._file_index]
                        handle, observed = self._lease._open(self._entry_handle(self._dir_cache[row['parts'][:-1]]), row['parts'][-1], False, create=True, writable=True)
                        entry = self._lease._handles[-1]
                        need(entry.cell.value == handle and observed[1] == 0 and observed[2] == 1, 'OUTPUT_CUSTODY_LOST')
                        self._outputs[row['parts']] = {'entry': entry, 'identity': observed[0], 'size': row['size'], 'sha': self._expected[row['parts']], 'snapshot': None}
                        self._created += 1
                        self._current = {'row': row, 'handle': entry, 'remaining': row['packed'], 'offset': row['data'],
                                         'pending': b'', 'decoder': zlib.decompressobj(-15) if row['method'] == 8 else None,
                                         'sha': hashlib.sha256(), 'crc': 0, 'written': 0, 'phase': 'data'}
                        return self.status()
                    state = self._current
                    row, handle = state['row'], self._entry_handle(state['handle'])
                    if state['phase'] == 'data':
                        data = state['pending']
                        if not data and state['remaining']:
                            count = min(CHUNK, state['remaining'])
                            data = self._exact(state['offset'], count)
                            state['offset'] += count
                            state['remaining'] -= count
                        if state['decoder'] is None:
                            output, done = data, state['remaining'] == 0
                            state['pending'] = b''
                        else:
                            decoder = state['decoder']
                            output = decoder.decompress(data, CHUNK)
                            state['pending'] = decoder.unconsumed_tail
                            done = decoder.eof
                            if done:
                                need(state['remaining'] == 0 and not decoder.unused_data and not state['pending'], 'TRAILING_DEFLATE')
                            need(output or data or done, 'TRUNCATED_DEFLATE')
                        need(state['written']+len(output) <= row['size'] and self._written+len(output) <= self._total, 'EXPANSION_LIMIT')
                        if output:
                            write_handle(handle, output)
                            state['sha'].update(output)
                            state['crc'] = zlib.crc32(output, state['crc']) & 0xffffffff
                            state['written'] += len(output)
                            self._written += len(output)
                        if done:
                            need(state['written'] == row['size'] and state['crc'] == row['crc']
                                 and state['sha'].hexdigest() == self._expected[row['parts']], 'CONTENT_MISMATCH')
                            observed = snapshot(handle, False)
                            need(observed[0] == self._outputs[row['parts']]['identity'] and observed[1] == row['size'] and observed[2] == 1, 'OUTPUT_CHANGED')
                            state.update({'phase': 'readback', 'readback': row['size'], 'read_hash': hashlib.sha256(), 'before_readback': observed})
                            seek_at(handle, 0)
                        return self.status()
                    if state['readback']:
                        data = read_handle(handle, min(CHUNK, state['readback']))
                        need(data, 'OUTPUT_TRUNCATED')
                        state['read_hash'].update(data)
                        state['readback'] -= len(data)
                        return self.status()
                    need(not read_handle(handle, 1) and state['read_hash'].hexdigest() == self._expected[row['parts']]
                         and snapshot(handle, False) == state['before_readback'], 'READBACK_MISMATCH')
                    self._outputs[row['parts']]['snapshot'] = state['before_readback']
                    self._verified += 1
                    self._file_index += 1
                    self._current = None
                    if self._file_index == len(self._files):
                        need(self._written == self._total and snapshot(self._lease._archive_handle, False) == self._archive_snapshot, 'FINAL_SCOPE_CHANGED')
                        self._completed = True
                    return self.status()

        def cancel(self):
            with self._locked():
                self._cancelled = True
                return self.status()

        def close(self):
            with self._locked():
                if self._closed:
                    return self.status()
                need(not self._start_attempted or self._completed or self._cancelled or self._poisoned, 'EXTRACTION_INCOMPLETE')
                self._current = None
                self._closed = True  # Ends pump only; parent keeps ALL output seals.
                return self.status()

        def _handoff_ready_locked(self):
            return self._closed and self._completed and not self._cancelled and not self._poisoned

        def _source_locked(self, key, expected_size, expected_sha):
            need(self._handoff_ready_locked() and self._lease._extractor is self
                 and self._lease._acquired and not self._lease._closed and not self._lease._poisoned, 'SOURCE_OWNER_NOT_READY')
            record = self._outputs.get(key)
            need(record is not None and record['size'] == expected_size and record['sha'] == expected_sha, 'SOURCE_NOT_OWNED')
            handle = self._entry_handle(record['entry'])
            observed = snapshot(handle, False)
            need(observed == record['snapshot'] and observed[0] == record['identity']
                 and observed[1] == expected_size and observed[2] == 1, 'SOURCE_CHANGED')
            return handle, observed

        def status(self):
            return {'backend': 'zip', 'startAttempted': self._start_attempted, 'started': self._started,
                    'completed': self._completed, 'cancelled': self._cancelled, 'poisoned': self._poisoned,
                    'closed': self._closed, 'errorCode': self._error_code, 'binding': dict(self._lease._binding),
                    'createdFiles': self._created, 'verifiedFiles': self._verified, 'writtenBytes': self._written,
                    'effectsAllowed': False, 'nativeInstallAccepted': False, 'persistenceVerified': False}

    return Owner
