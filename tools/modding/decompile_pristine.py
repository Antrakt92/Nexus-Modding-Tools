"""Pinned pristine API cache: status is read-only; generation requires explicit opt-in."""
from contextlib import contextmanager
import argparse
import codecs
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

MAX_JSON = 1024 * 1024
MAX_FILE = 512 * 1024 * 1024
SCOPE = 'vanilla API reference; not gameplay proof'
REQUIRED_TYPES = ['class ItemModeGridView', 'class InventoryItemModeLogicController']
OPTIONS = {'command': 'decompile', 'mode': 'code', 'timeoutSeconds': 180,
           'recipeVersion': 1, 'requiredTypes': REQUIRED_TYPES, 'rejectErrorDiagnostics': True}


class CacheError(ValueError):
    pass


def require(ok, code):
    if not ok:
        raise CacheError(code)


def identity(s):
    return s.st_dev, s.st_ino


def generation(s):
    return identity(s) + (s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_nlink)


def ordinary(path, directory=False):
    s = path.lstat()
    require(not stat.S_ISLNK(s.st_mode) and not (getattr(s, 'st_file_attributes', 0) & 0x400), 'CACHE_UNSAFE_PATH')
    require((stat.S_ISDIR if directory else stat.S_ISREG)(s.st_mode) and s.st_ino != 0, 'CACHE_UNSAFE_PATH')
    return s


def ancestors(path):
    path = Path(os.path.abspath(path))
    pins = [(p, identity(ordinary(p, True))) for p in reversed((path,) + tuple(path.parents))]
    return pins


def check_dirs(pins):
    for p, node in pins:
        require(identity(ordinary(p, True)) == node, 'CACHE_PATH_CHANGED')


def path_stamp(s):
    # CPython Windows lstat exposes legacy creation-time as ctime while fstat
    # exposes change-time. Compare ctime only between opened descriptors.
    return identity(s) + (s.st_size, s.st_mtime_ns, s.st_nlink)


def stable_file(path, maximum=MAX_FILE, capture=False, validate_types=False):
    path = Path(path)
    pins = ancestors(path.parent)
    before = ordinary(path)
    require(0 <= before.st_size <= maximum, 'CACHE_FILE_LIMIT')
    digest = hashlib.sha256()
    chunks = []
    decoder = codecs.getincrementaldecoder('utf-8')('strict') if validate_types else None
    found, tail = set(), ''
    with path.open('rb') as stream:
        opened = os.fstat(stream.fileno())
        # Windows can finalize a previous writer's change-time on reopen. Admit
        # the same physical file, then pin the full FD/path generation together.
        require(identity(opened) == identity(before) and opened.st_size == before.st_size
                and opened.st_mtime_ns == before.st_mtime_ns and opened.st_nlink == before.st_nlink, 'CACHE_FILE_CHANGED')
        before = opened
        require(path_stamp(ordinary(path)) == path_stamp(before), 'CACHE_FILE_CHANGED')
        total = 0
        while True:
            chunk = stream.read(64 * 1024)
            if not chunk:
                break
            total += len(chunk)
            require(total <= maximum and total <= before.st_size, 'CACHE_FILE_CHANGED')
            digest.update(chunk)
            if decoder:
                text = tail + decoder.decode(chunk)
                found.update(marker for marker in REQUIRED_TYPES if marker in text)
                tail = text[-max(map(len, REQUIRED_TYPES)):]
            if capture:
                chunks.append(chunk)
        if decoder:
            decoder.decode(b'', final=True)
            require(len(found) == len(REQUIRED_TYPES), 'CACHE_REQUIRED_TYPES_MISSING')
        require(total == before.st_size and generation(os.fstat(stream.fileno())) == generation(before), 'CACHE_FILE_CHANGED')
    require(path_stamp(ordinary(path)) == path_stamp(before), 'CACHE_FILE_CHANGED')
    with path.open('rb') as verify:
        require(generation(os.fstat(verify.fileno())) == generation(before), 'CACHE_FILE_CHANGED')
    require(path_stamp(ordinary(path)) == path_stamp(before), 'CACHE_FILE_CHANGED')
    check_dirs(pins)
    result = {'sha256': digest.hexdigest(), 'bytes': total}
    return result, generation(before), b''.join(chunks) if capture else None


def sha(path):
    return stable_file(path)[0]['sha256']


def strict_json(path):
    return strict_json_bytes(stable_file(path, MAX_JSON, True)[2])


def strict_json_bytes(raw):
    def pairs(items):
        out = {}
        for key, value in items:
            require(key not in out, 'CACHE_INVALID_JSON')
            out[key] = value
        return out
    # Bound nesting before json.loads, including strings with escaped quotes.
    depth, quoted, escaped = 0, False, False
    for char in raw.decode('utf-8', errors='strict'):
        if quoted:
            if escaped:
                escaped = False
            elif char == '\\':
                escaped = True
            elif char == '"':
                quoted = False
        elif char == '"':
            quoted = True
        elif char in '[{':
            depth += 1
            require(depth <= 32, 'CACHE_INVALID_JSON')
        elif char in ']}':
            depth -= 1
    try:
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(CacheError('CACHE_INVALID_JSON')))
    except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise CacheError('CACHE_INVALID_JSON') from error


def encode(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode('utf-8')


def exists(path):
    return os.path.lexists(path)


def contextual_read(callback, code):
    try:
        return callback()
    except OSError as error:
        raise CacheError(code) from error


def snapshot(workspace, game, expected=None):
    require(game is not None, 'PRISTINE_GAME_REQUIRED')
    if expected is not None:
        require(isinstance(expected, str) and re.fullmatch('[a-fA-F0-9]{64}', expected), 'PRISTINE_INVALID_BASELINE')
        expected = expected.lower()
    workspace = Path(os.path.abspath(workspace))
    game = Path(os.path.abspath(game))
    wpins = contextual_read(lambda: ancestors(workspace), 'PRISTINE_WORKSPACE_UNAVAILABLE')
    gpins = contextual_read(lambda: ancestors(game), 'PRISTINE_GAME_UNAVAILABLE')
    source = game / 'r6/cache/final.redscripts'
    inp, igen, _ = contextual_read(lambda: stable_file(source), 'PRISTINE_INPUT_UNAVAILABLE')
    require(expected is None or expected == inp['sha256'], 'PRISTINE_BASELINE_MISMATCH')
    tools = workspace / 'cyberpunk-tools/toolchain'
    manifest = tools / 'toolchain.json'
    manifest_pin, _, manifest_bytes = contextual_read(lambda: stable_file(manifest, MAX_JSON, True), 'CACHE_TOOL_MANIFEST_UNAVAILABLE')
    try:
        spec = strict_json_bytes(manifest_bytes)['tools']['redscript_cli']
        relative = spec['relative_executable']
        require(isinstance(spec.get('sha256'), str) and re.fullmatch('[a-f0-9]{64}', spec['sha256']), 'CACHE_TOOL_MANIFEST_INVALID')
    except CacheError as error:
        if str(error) != 'CACHE_INVALID_JSON':
            raise
        raise CacheError('CACHE_TOOL_MANIFEST_INVALID') from error
    except (KeyError, TypeError, AttributeError, UnicodeError) as error:
        raise CacheError('CACHE_TOOL_MANIFEST_INVALID') from error
    require(isinstance(relative, str) and relative and not Path(relative).is_absolute()
            and not any(p in ('', '.', '..') for p in re.split(r'[\\/]', relative)) and ':' not in relative, 'CACHE_TOOL_PATH')
    tool = tools / relative
    require(tool.is_relative_to(tools), 'CACHE_TOOL_PATH')
    toolpin, tgen, _ = contextual_read(lambda: stable_file(tool), 'CACHE_TOOL_UNAVAILABLE')
    require(toolpin['sha256'] == spec['sha256'], 'CACHE_TOOL_MISMATCH')
    cache = workspace / 'local-state/vanilla-api'
    require(not cache.is_relative_to(game) and not game.is_relative_to(cache), 'CACHE_UNSAFE_OUTPUT')
    binding = {'schema': 'pristine-cache-input/1', 'input': inp, 'tool': toolpin, 'options': OPTIONS}
    key = hashlib.sha256(encode(binding)).hexdigest()
    return {'workspace': workspace, 'game': game, 'source': source, 'tool': tool, 'manifest': manifest,
            'manifestPin': manifest_pin, 'input': inp, 'toolPin': toolpin, 'inputGen': igen, 'toolGen': tgen,
            'pins': wpins + gpins, 'cache': cache, 'slot': cache / key,
            'legacy': cache / (inp['sha256'][:16] + '-' + toolpin['sha256'][:12]), 'binding': binding,
            'baselineMatched': expected is not None}


def recheck(s):
    check_dirs(s['pins'])
    for name, pin, gen in [('source', s['input'], s['inputGen']), ('tool', s['toolPin'], s['toolGen'])]:
        actual, physical, _ = stable_file(s[name])
        require(actual == pin and physical == gen, 'CACHE_INPUT_CHANGED')
    require(stable_file(s['manifest'])[0] == s['manifestPin'], 'CACHE_TOOL_MISMATCH')


def check_log(slot, required=False):
    log = slot / 'decompile.log'
    require(not required or exists(log), 'CACHE_LOG_MISSING')
    if exists(log):
        data = stable_file(log, MAX_JSON, True)[2].decode('utf-8', errors='strict')
        require(not re.search(r'(?im)^\s*(?:ERROR\b|Error:|FATAL\b|panic\b)|\[ERROR\]|Failed to load the script cache', data), 'CACHE_DECOMPILER_DIAGNOSTIC')


def failure_class(slot):
    log = slot / 'decompile.log'
    if exists(log):
        try:
            data = stable_file(log, 1024 * 1024, True)[2]
            if b'Failed to load the script cache' in data and b'failed to fill whole buffer' in data:
                return 'decoder_input_failure'
        except (OSError, ValueError, UnicodeError):
            pass
    return 'unreceipted_attempt'


def slot_files(slot):
    names = []
    with os.scandir(slot) as listing:
        for entry in listing:
            names.append(entry.name)
            require(len(names) <= 8, 'CACHE_UNKNOWN_ENTRY')
    return {name: generation(ordinary(slot / name)) for name in names}


def validate_slot(s, slot, modern):
    pins = ancestors(slot)
    files = slot_files(slot)
    require(not exists(slot / 'writer.lock'), 'CACHE_LOCKED')
    allowed = {'receipt.json', 'vanilla.reds', 'decompile.log'} | ({'intent.json'} if modern else set())
    require(set(files) <= allowed, 'CACHE_UNKNOWN_ENTRY')
    receipt = slot / 'receipt.json'
    require(exists(receipt), 'CACHE_ATTEMPT_HELD')
    r = strict_json(receipt)
    output = slot / 'vanilla.reds'
    try:
        proof = stable_file(output, validate_types=s['baselineMatched'])[0]
    except FileNotFoundError as error:
        raise CacheError('CACHE_OUTPUT_MISSING') from error
    check_log(slot, required=modern)
    require(proof['bytes'] > 0, 'CACHE_OUTPUT_MISMATCH')
    if modern:
        require(encode(r) == encode({'schema': 'pristine-cache-receipt/1', 'binding': s['binding'], 'output': proof,
                      'exitCode': 0, 'scope': SCOPE, 'requiredTypesVerified': True, 'coverageVerified': False}), 'CACHE_RECEIPT_MISMATCH')
        require(encode(strict_json(slot / 'intent.json')) == encode({'schema': 'pristine-cache-attempt/1', 'binding': s['binding']}), 'CACHE_RECEIPT_MISMATCH')
    else:
        require(isinstance(r, dict) and r.get('inputSHA256') == s['input']['sha256']
                and r.get('toolSHA256') == s['toolPin']['sha256'] and r.get('outputSHA256') == proof['sha256']
                and type(r.get('outputBytes')) is int and r['outputBytes'] == proof['bytes']
                and type(r.get('exitCode')) is int and r['exitCode'] == 0 and r.get('scope') == SCOPE
                and r.get('input') == str(s['source']), 'CACHE_RECEIPT_MISMATCH')
    recheck(s); check_dirs(pins)
    require(slot_files(slot) == files, 'CACHE_FILE_CHANGED')
    return slot


def inspect_snapshot(s):
    selected = None
    # Existing old attempts cannot be evaded by selecting a new full-key format.
    for slot, modern in [(s['legacy'], False), (s['slot'], True)]:
        if exists(slot):
            selected = validate_slot(s, slot, modern)
    recheck(s)
    return selected


def inspect_cache(workspace, game=None, expected_sha256=None):
    result = {'schema': 'pristine-cache-status/1', 'mode': 'status', 'state': 'blocked', 'code': 'PRISTINE_BASELINE_REQUIRED',
              'failureClass': 'baseline_missing', 'baselineMatched': False, 'cacheReusable': False, 'generationAllowed': False}
    s = None
    try:
        s = snapshot(workspace, game, expected_sha256)
        result['input'] = s['input']; result['tool'] = s['toolPin']; result['baselineMatched'] = s['baselineMatched']
        result['observedCacheKey'] = s['slot'].name
        selected = inspect_snapshot(s)
        if not s['baselineMatched']:
            return result
        result.update(state='verified' if selected else 'absent', code='CACHE_VERIFIED' if selected else 'CACHE_ABSENT',
                      failureClass=None, cacheReusable=bool(selected), generationAllowed=not bool(selected))
        if selected:
            result.update(source=str(selected / 'vanilla.reds'), receipt=str(selected / 'receipt.json'),
                          cacheKey=s['slot'].name, requiredTypesVerified=True, coverageVerified=False)
    except (OSError, ValueError, KeyError, TypeError, UnicodeError) as error:
        code = safe_code(error)
        category = {'PRISTINE_BASELINE_MISMATCH': 'input_changed', 'CACHE_TOOL_MISMATCH': 'tool_changed',
                    'CACHE_RECEIPT_MISMATCH': 'invalid_receipt', 'CACHE_OUTPUT_MISMATCH': 'output_changed',
                    'CACHE_REQUIRED_TYPES_MISSING': 'output_invalid', 'CACHE_UNSAFE_PATH': 'unsafe_path',
                    'CACHE_LOCKED': 'locked', 'PRISTINE_GAME_REQUIRED': 'input_missing',
                    'PRISTINE_WORKSPACE_UNAVAILABLE': 'workspace_missing', 'PRISTINE_GAME_UNAVAILABLE': 'game_missing',
                    'PRISTINE_INPUT_UNAVAILABLE': 'input_missing', 'CACHE_TOOL_MANIFEST_UNAVAILABLE': 'tool_manifest_missing',
                    'CACHE_TOOL_MANIFEST_INVALID': 'tool_manifest_invalid', 'CACHE_TOOL_UNAVAILABLE': 'tool_missing',
                    'CACHE_OUTPUT_MISSING': 'output_missing', 'CACHE_INVALID_JSON': 'invalid_receipt'}.get(code, 'incomplete')
        result.update(state='held' if s else 'blocked', code=code, failureClass=category)
        if s and code == 'CACHE_ATTEMPT_HELD':
            result['failureClass'] = failure_class(s['legacy'] if exists(s['legacy']) else s['slot'])
    return result


def safe_code(error):
    message = str(error)
    return message if re.fullmatch(r'(?:CACHE|PRISTINE)_[A-Z_]+', message) else 'CACHE_INSPECTION_FAILED'


def durable_new(path, data):
    pins = ancestors(path.parent)
    with path.open('xb') as stream:
        node = identity(os.fstat(stream.fileno()))
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    proof, physical, actual = stable_file(path, max(MAX_JSON, len(data)), True)
    require(physical[:2] == node and actual == data, 'CACHE_FILE_CHANGED')
    check_dirs(pins)


@contextmanager
def exclusive_cache(output):
    lock = Path(output) / 'writer.lock'
    pins = ancestors(Path(output))
    data = b'Exclusive decompiler writer; inspect attempts before retry.\n'
    try:
        claim = lock.open('xb')
    except FileExistsError as error:
        raise CacheError('CACHE_LOCKED') from error
    with claim:
        node = identity(os.fstat(claim.fileno()))
        claim.write(data)
        claim.flush(); os.fsync(claim.fileno())
    _, stamp, actual = stable_file(lock, MAX_JSON, True)
    require(stamp[:2] == node and actual == data, 'CACHE_LOCK_CHANGED')
    try:
        yield
    finally:
        check_dirs(pins)
        require(exists(lock), 'CACHE_LOCK_CHANGED')
        if exists(lock):
            _, current, actual = stable_file(lock, MAX_JSON, True)
            require(current == stamp and actual == data, 'CACHE_LOCK_CHANGED')
            lock.unlink()


def generate_cache(workspace, game, expected_sha256, *, _run=subprocess.run):
    require(expected_sha256 is not None, 'PRISTINE_BASELINE_REQUIRED')
    s = snapshot(workspace, game, expected_sha256)
    selected = inspect_snapshot(s)
    if selected:
        return {'reused': True, 'source': str(selected / 'vanilla.reds'), 'receipt': str(selected / 'receipt.json')}
    # Only create new ordinary ancestors; never touch an existing attempted slot.
    for folder in [s['workspace'] / 'local-state', s['cache']]:
        if not exists(folder):
            folder.mkdir()
        ordinary(folder, True)
    cpins = ancestors(s['cache']); recheck(s)
    s['slot'].mkdir()  # Atomic exclusive reservation; no stale takeover or cleanup.
    slotpins = ancestors(s['slot'])
    durable_new(s['slot'] / 'intent.json', encode({'schema': 'pristine-cache-attempt/1', 'binding': s['binding']}))
    with exclusive_cache(s['slot']):
        result, log = s['slot'] / 'vanilla.reds', s['slot'] / 'decompile.log'
        recheck(s); check_dirs(cpins + slotpins)
        require(not exists(s['legacy']), 'CACHE_LEGACY_CHANGED')
        require(set(slot_files(s['slot'])) == {'intent.json', 'writer.lock'}, 'CACHE_UNKNOWN_ENTRY')
        with log.open('xb') as stream:
            lognode = identity(os.fstat(stream.fileno()))
            proc = _run([str(s['tool']), 'decompile', '-i', str(s['source']), '-o', str(result), '-m', 'code'],
                        cwd=s['slot'], stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT,
                        timeout=OPTIONS['timeoutSeconds'], creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            stream.flush(); os.fsync(stream.fileno())
        require(identity(ordinary(log)) == lognode, 'CACHE_LOG_CHANGED')
        require(type(proc.returncode) is int and proc.returncode == 0, 'CACHE_DECOMPILER_FAILED')
        check_dirs(cpins + slotpins); recheck(s)
        check_log(s['slot'], required=True)
        output = stable_file(result, validate_types=True)[0]; require(output['bytes'] > 0, 'CACHE_OUTPUT_MISMATCH')
        durable_new(s['slot'] / 'receipt.json', encode({'schema': 'pristine-cache-receipt/1', 'binding': s['binding'],
                    'output': output, 'exitCode': 0, 'scope': SCOPE, 'requiredTypesVerified': True, 'coverageVerified': False}))
    validate_slot(s, s['slot'], True)
    return {'reused': False, 'source': str(result), 'receipt': str(s['slot'] / 'receipt.json'), 'bytes': output['bytes']}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', type=Path, default=Path(os.environ.get('NEXUS_WORKSPACE') or Path(__file__).absolute().parents[2]))
    parser.add_argument('--game', type=Path)
    parser.add_argument('--expected-sha256')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--status', action='store_true')
    mode.add_argument('--generate', action='store_true')
    args = parser.parse_args(argv)
    try:
        if args.generate:
            value = generate_cache(args.workspace, args.game, args.expected_sha256)
        else:
            value = inspect_cache(args.workspace, args.game, args.expected_sha256)
        print(json.dumps(value, sort_keys=True))
        return 0 if value.get('state') in (None, 'verified', 'absent') else 2
    except (OSError, ValueError, TypeError, KeyError, UnicodeError, subprocess.SubprocessError) as error:
        print(json.dumps({'code': safe_code(error)}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
