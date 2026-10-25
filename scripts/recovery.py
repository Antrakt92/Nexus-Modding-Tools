"""Verify source recovery inputs and prepare local configuration without credentials."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def relative(value):
    if not isinstance(value, str):
        raise ValueError('Unsafe recovery path')
    p = PurePosixPath(value)
    if not value or '\\' in value or ':' in value or p.is_absolute() or any(x in ('', '.', '..') for x in value.split('/')):
        raise ValueError('Unsafe recovery path')
    return p


def no_links(path):
    for p in [path, *path.parents]:
        # exists() follows links and hides dangling reparse points.
        try:
            info = p.lstat()
        except FileNotFoundError:
            continue
        except NotADirectoryError as error:
            raise ValueError('Recovery parent is not a directory') from error
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError('Recovery through reparse paths is refused')
        if p != path and not stat.S_ISDIR(info.st_mode):
            raise ValueError('Recovery parent is not a directory')


def absolute(value):
    p = Path(value).expanduser()
    if not p.is_absolute():
        raise ValueError('Choose an absolute path')
    no_links(p)
    return p.resolve()


def verify(root=ROOT):
    manifest = json.loads((root / 'recovery-manifest.json').read_text(encoding='utf-8'))
    seen = set()
    for row in manifest['files']:
        rel = relative(row['path']).as_posix()
        if rel in seen:
            raise ValueError('Duplicate recovery input')
        seen.add(rel)
        p = root / rel
        no_links(p)
        if not p.is_file() or digest(p.read_bytes().replace(b'\r\n', b'\n')) != row['sha256_lf']:
            raise ValueError('Recovery source differs: ' + rel)
    return {'verified_files': len(seen), 'integrity_verified': True}


def write_matching(path, data, apply):
    no_links(path)
    if path.exists():
        if not path.is_file() or path.read_bytes() != data:
            raise ValueError('Existing file differs; refusing overwrite: ' + str(path))
        return 'unchanged'
    if apply:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('xb') as out:
            out.write(data)
    return 'created' if apply else 'would_create'


def configure(workspace, apply=False, source=ROOT):
    workspace = absolute(workspace)
    # Client-local environment only. No global environment, bearer or API key.
    value = {'mcpServers': {'vortex': {'command': 'node',
             'args': [str(source / 'tools/modding/vortex-agent/bridge.mjs')],
             'env': {'NEXUS_WORKSPACE': str(workspace),
                     'NEXUS_CONTEXT_ROOT': str(workspace / 'local-state/upstream-sources')}}}}
    data = (json.dumps(value, indent=2) + '\n').encode()
    target = workspace / 'local-state/nexus-tools-recovery/client-template.json'
    status = write_matching(target, data, apply)
    return {'mode': 'apply' if apply else 'plan', 'configuration': status, 'path': str(target),
            'client_configuration_modified': False, 'credentials_created': False}


def restore_skills(snapshot, destination, apply=False):
    snapshot, destination = absolute(snapshot), absolute(destination)
    manifest = json.loads((snapshot / 'manifest.json').read_text(encoding='utf-8'))
    plan = []
    for row in manifest['skills']:
        rel = relative(row['path'])
        if rel.parts[0] != 'skills' or len(rel.parts) < 3:
            raise ValueError('Unexpected skill snapshot scope')
        src = snapshot / rel
        no_links(src)
        data = src.read_bytes()
        if digest(data) != row['sha256']:
            raise ValueError('Private skill snapshot changed')
        target = destination.joinpath(*rel.parts[1:])
        no_links(target)
        # Validate every destination before creating even one file.
        write_matching(target, data, False)
        plan.append((target, data))
    for target, data in plan:
        write_matching(target, data, apply)
    return {'mode': 'apply' if apply else 'plan', 'skills_files': len(plan),
            'unrelated_files_preserved': True}


def run_git(args, cwd=None):
    return subprocess.check_output(['git', *map(str, args)], cwd=cwd, stderr=subprocess.PIPE,
                                   encoding='utf-8', timeout=120).strip()


def fetch_sources(workspace, archive_dir=None, apply=False):
    workspace = absolute(workspace)
    lock = json.loads((ROOT / 'source-lock.json').read_text(encoding='utf-8'))
    results = []
    for row in lock['upstreams']:
        name = relative(row['name']).as_posix()
        if '/' in name:
            raise ValueError('Invalid upstream name')
        bundle_name = relative(row['bundle']).as_posix()
        if '/' in bundle_name:
            raise ValueError('Invalid recovery bundle name')
        target = workspace / 'local-state/upstream-sources' / name
        no_links(target)
        if target.exists():
            if Path(run_git(['rev-parse', '--show-toplevel'], target)).resolve() != target.resolve():
                raise ValueError('Existing upstream checkout root differs: ' + name)
            if run_git(['rev-parse', 'HEAD'], target) != row['commit'] or run_git(['status', '--porcelain', '--untracked-files=no'], target):
                raise ValueError('Existing upstream checkout differs: ' + name)
            results.append({'name': name, 'state': 'already_verified'})
            continue
        if not apply:
            results.append({'name': name, 'state': 'would_restore'})
            continue
        bundle = (absolute(archive_dir) / bundle_name) if archive_dir else workspace / 'local-state/recovery-downloads' / bundle_name
        no_links(bundle)
        if not bundle.exists():
            if archive_dir:
                raise ValueError('Missing supplied recovery bundle')
            bundle.parent.mkdir(parents=True, exist_ok=True)
            url = row['url']
            if not url.startswith('https://github.com/Antrakt92/Nexus-Modding-Tools/releases/download/'):
                raise ValueError('Unexpected recovery download origin')
            with urllib.request.urlopen(url, timeout=90) as response:
                data = response.read(row['bytes'] + 1)
            if len(data) != row['bytes'] or digest(data) != row['sha256']:
                raise ValueError('Recovery download failed size/hash verification')
            with bundle.open('xb') as out:
                out.write(data)
        if bundle.stat().st_size != row['bytes'] or digest(bundle.read_bytes()) != row['sha256']:
            raise ValueError('Recovery bundle changed')
        # A new empty repository only; no reset/clean against existing work.
        target.mkdir(parents=True, exist_ok=False)
        run_git(['init', '--quiet'], target)
        run_git(['fetch', '--quiet', '--no-tags', bundle, 'HEAD'], target)
        run_git(['checkout', '--quiet', '--detach', row['commit']], target)
        if run_git(['rev-parse', 'HEAD'], target) != row['commit']:
            raise ValueError('Recovered upstream commit mismatch')
        results.append({'name': name, 'state': 'restored'})
    return {'mode': 'apply' if apply else 'plan', 'sources': results,
            'vortex_restarted': False, 'credentials_included': False}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('command', choices=['verify', 'configure', 'sources', 'skills'])
    p.add_argument('--workspace', default=os.environ.get('NEXUS_WORKSPACE', str(ROOT)))
    p.add_argument('--apply', action='store_true')
    p.add_argument('--archive-dir')
    p.add_argument('--snapshot')
    p.add_argument('--skills-home')
    args = p.parse_args()
    if args.command == 'verify':
        result = verify()
    elif args.command == 'configure':
        result = configure(args.workspace, args.apply)
    elif args.command == 'sources':
        result = fetch_sources(args.workspace, args.archive_dir, args.apply)
    else:
        if not args.snapshot or not args.skills_home:
            p.error('skills requires --snapshot and --skills-home')
        result = restore_skills(args.snapshot, args.skills_home, args.apply)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
