"""Retire one exact legacy Rusty-hook installation; default is a read-only plan."""
import argparse
import configparser
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys

STUB_SHA = '011a2a98b8c0361de91597a939c9dd9c0373487e962969e27ca696834305109f'
STUB_NAMES = ('applypatch-msg', 'commit-msg', 'post-applypatch', 'post-checkout', 'post-commit',
              'post-merge', 'post-receive', 'post-rewrite', 'post-update', 'pre-applypatch',
              'pre-auto-gc', 'pre-commit', 'pre-push', 'pre-rebase', 'pre-receive',
              'prepare-commit-msg', 'push-to-checkout', 'sendemail-validate', 'update')
CATALOG = {**dict.fromkeys(STUB_NAMES, STUB_SHA),
           'cli.sh': '770c6b3b4d063feaa084aae64219d9a898a4a097c237887ef540aa797acf0266',
           'semver.sh': 'bfcbf5129726d2071bf78ea8d506c8b198ab30c981ce2df11b51644c8392b07c'}
MINIMAL_HOOK = b'#!/bin/sh\n# Staged whitespace checks only; no installs or runtime effects.\nexec git diff --cached --check\n'
LEDGER = 'rusty-hook-retirement.json'
MAX_FILE = 128 * 1024


class RetirementError(ValueError):
    pass


def require(ok, code):
    if not ok:
        raise RetirementError(code)


def identity(s):
    return s.st_dev, s.st_ino


def generation(s):
    return identity(s) + (s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_nlink)


def ordinary(path, directory=False):
    s = path.lstat()
    require(not stat.S_ISLNK(s.st_mode) and not (getattr(s, 'st_file_attributes', 0) & 0x400)
            and (stat.S_ISDIR if directory else stat.S_ISREG)(s.st_mode) and s.st_ino != 0, 'HOOK_UNSAFE_PATH')
    return s


def directory_pins(path):
    return [(p, identity(ordinary(p, True))) for p in reversed((path,) + tuple(path.parents))]


def check_dirs(pins):
    for p, node in pins:
        require(identity(ordinary(p, True)) == node, 'HOOK_PATH_CHANGED')


def exists(path):
    return os.path.lexists(path)


def read_file(path):
    pins = directory_pins(path.parent)
    before = ordinary(path)
    require(before.st_size <= MAX_FILE, 'HOOK_FILE_LIMIT')
    with path.open('rb') as stream:
        opened = os.fstat(stream.fileno())
        # Windows lstat/fstat can expose different ctime semantics; compare full
        # descriptor generations to each other, path generations to each other.
        require(identity(opened) == identity(before) and opened.st_size == before.st_size
                and opened.st_mtime_ns == before.st_mtime_ns and opened.st_nlink == before.st_nlink, 'HOOK_FILE_CHANGED')
        content = stream.read(MAX_FILE + 1)
        require(len(content) == opened.st_size and generation(os.fstat(stream.fileno())) == generation(opened), 'HOOK_FILE_CHANGED')
    after = ordinary(path)
    require(generation(after) == generation(before), 'HOOK_FILE_CHANGED')
    check_dirs(pins)
    return {'sha256': hashlib.sha256(content).hexdigest(), 'bytes': len(content),
            'generation': generation(after), 'data': content, 'mode': stat.S_IMODE(after.st_mode)}


def check_file(path, expected):
    current = read_file(path)
    require(current['generation'] == expected['generation'] and current['data'] == expected['data'], 'HOOK_FILE_CHANGED')


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8')


def new_file(path, content, mode=0o600):
    pins = directory_pins(path.parent)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(fd, 'wb') as out:
        node = identity(os.fstat(out.fileno()))
        out.write(content); out.flush(); os.fsync(out.fileno())
    proof = read_file(path)
    require(proof['generation'][:2] == node and proof['data'] == content, 'HOOK_FILE_CHANGED')
    check_dirs(pins)
    return proof


def inspect(repository):
    root = Path(os.path.abspath(repository))
    git, hooks = root / '.git', root / '.git/hooks'
    pins = directory_pins(hooks)
    require(not exists(git / LEDGER), 'HOOK_RETIREMENT_ALREADY_ATTEMPTED')
    config = git / 'config'
    config_proof = read_file(config) if exists(config) else None
    if config_proof:
        parser = configparser.RawConfigParser(strict=True)
        try:
            parser.read_string(config_proof['data'].decode('utf-8'))
        except (UnicodeError, configparser.Error) as error:
            raise RetirementError('HOOK_CONFIG_UNSUPPORTED') from error
        require(not any(s.lower() == 'include' or s.lower().startswith('includeif ') for s in parser.sections()), 'HOOK_CONFIG_UNSUPPORTED')
        require(not any(s.lower() == 'core' and any(k.lower() == 'hookspath' for k in parser[s]) for s in parser.sections()), 'HOOK_PATH_OVERRIDE')
    files = {}
    for name, digest in CATALOG.items():
        require(exists(hooks / name), 'HOOK_CATALOG_INCOMPLETE')
        proof = read_file(hooks / name)
        require(proof['sha256'] == digest, 'HOOK_PIN_MISMATCH')
        files[name] = proof
    check_dirs(pins)
    for name, proof in files.items():
        check_file(hooks / name, proof)
    if config_proof:
        check_file(config, config_proof)
    return {'root': root, 'git': git, 'hooks': hooks, 'pins': pins, 'files': files, 'config': config_proof}


def plan(repository):
    inspected = inspect(repository)
    return {'schema': 'rusty-hook-retirement-plan/1', 'mode': 'plan', 'ready': True,
            'retire': [{'name': name, 'sha256': p['sha256'], 'bytes': p['bytes']} for name, p in inspected['files'].items()],
            'replacement': {'name': 'pre-commit', 'sha256': hashlib.sha256(MINIMAL_HOOK).hexdigest()},
            'preservesUnknownHooks': True, 'preservesRustyConfig': True, 'effectsPerformed': False}


def apply(repository):
    state = inspect(repository)
    git, hooks, pins = state['git'], state['hooks'], state['pins']
    nonce = secrets.token_hex(16)
    backup = git / ('rusty-hook-backup-' + nonce)
    intent = {'schema': 'rusty-hook-retirement-intent/1', 'backup': backup.name,
              'files': [{'name': name, 'sha256': p['sha256'], 'bytes': p['bytes']} for name, p in state['files'].items()]}
    check_dirs(pins)
    # A permanent no-overwrite reservation survives success and all failures.
    ledger = new_file(git / LEDGER, encoded(intent))
    check_dirs(pins); backup.mkdir()
    backup_pins = directory_pins(backup)
    for name, proof in state['files'].items():
        check_dirs(pins + backup_pins)
        new_file(backup / name, proof['data'], proof['mode'])
    manifest = new_file(backup / 'manifest.json', encoded(intent))
    replacement = new_file(backup / 'pre-commit.replacement', MINIMAL_HOOK, 0o755)
    # Finish all admission and backup verification before changing active hooks.
    check_dirs(pins + backup_pins); check_file(git / LEDGER, ledger)
    if state['config']:
        check_file(git / 'config', state['config'])
    for name, proof in state['files'].items():
        check_file(hooks / name, proof)
        require(read_file(backup / name)['data'] == proof['data'], 'HOOK_BACKUP_CHANGED')
    check_file(backup / 'manifest.json', manifest)
    for name, proof in state['files'].items():
        check_dirs(pins + backup_pins); check_file(git / LEDGER, ledger)
        check_file(hooks / name, proof)
        hooks.joinpath(name).unlink()  # Exact admitted regular leaf only; never recursive.
    check_dirs(pins + backup_pins); check_file(backup / 'pre-commit.replacement', replacement)
    # link is atomic and refuses an existing destination on Windows and POSIX.
    os.link(backup / 'pre-commit.replacement', hooks / 'pre-commit')
    require(read_file(hooks / 'pre-commit')['data'] == MINIMAL_HOOK, 'HOOK_REPLACEMENT_CHANGED')
    for name in CATALOG:
        require(name == 'pre-commit' or not exists(hooks / name), 'HOOK_RETIREMENT_CHANGED')
    check_dirs(pins + backup_pins); check_file(git / LEDGER, ledger)
    for name, proof in state['files'].items():
        require(read_file(backup / name)['data'] == proof['data'], 'HOOK_BACKUP_CHANGED')
    new_file(backup / 'completed.json', encoded({'schema': 'rusty-hook-retirement-completed/1',
             'retiredFiles': len(CATALOG), 'preCommitSHA256': hashlib.sha256(MINIMAL_HOOK).hexdigest()}))
    return {'schema': 'rusty-hook-retirement-result/1', 'completed': True, 'backup': str(backup),
            'retiredFiles': len(CATALOG), 'effectsPerformed': True}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', type=Path, required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args(argv)
    try:
        value = apply(args.repository) if args.apply else plan(args.repository)
        print(json.dumps(value, sort_keys=True))
        return 0
    except (OSError, ValueError, TypeError) as error:
        message = str(error)
        code = message if re.fullmatch('HOOK_[A-Z_]+', message) else 'HOOK_RETIREMENT_FAILED'
        print(json.dumps({'code': code, 'effectsMayBePartial': args.apply}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
