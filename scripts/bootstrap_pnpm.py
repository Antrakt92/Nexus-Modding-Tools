"""Verify and unpack the pinned local build tool; no global install or scripts."""
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import tarfile
import tempfile
import urllib.request

from recovery import no_links, relative as recovery_relative

ROOT = Path(__file__).resolve().parents[1]


def entries(data, lock):
    if len(data) != lock['archiveBytes']:
        raise ValueError('Build-tool archive size differs')
    actual = base64.b64encode(hashlib.sha512(data).digest()).decode()
    if lock['integrity'] != 'sha512-' + actual:
        raise ValueError('Build-tool archive integrity differs')
    files = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for member in archive.getmembers():
            path = PurePosixPath(member.name)
            if path.is_absolute() or '\\' in member.name or ':' in member.name or '..' in path.parts or path.parts[0] != 'package':
                raise ValueError('Unsafe archive path')
            if member.isdir():
                continue
            if not member.isfile() or len(path.parts) < 2:
                raise ValueError('Archive links/special entries refused')
            relative = path.relative_to('package').as_posix()
            if relative in files:
                raise ValueError('Duplicate archive entry')
            files[relative] = archive.extractfile(member).read()
    if len(files) != lock['fileCount'] or sum(map(len, files.values())) != lock['unpackedBytes']:
        raise ValueError('Build-tool content inventory differs')
    return files


def bootstrap(apply=False, archive_path=None):
    vendor = ROOT / 'dependencies/vortex-mcp'
    no_links(vendor / 'PNPM-BOOTSTRAP.json')
    lock = json.loads((vendor / 'PNPM-BOOTSTRAP.json').read_text())
    target = vendor / recovery_relative(lock['retainedUnderIgnored'])
    version = lock.get('version')
    if (lock.get('package') != 'pnpm' or not isinstance(version, str)
            or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version)
            or lock.get('registryMetadata') != f'https://registry.npmjs.org/pnpm/{version}'
            or lock.get('tarball') != f'https://registry.npmjs.org/pnpm/-/pnpm-{version}.tgz'
            or lock['retainedUnderIgnored'] != f'.tooling/pnpm-{version}'):
        raise ValueError('Inconsistent pinned build-tool metadata')
    no_links(vendor / 'package.json')
    package = json.loads((vendor / 'package.json').read_text())
    if package.get('packageManager') != f'pnpm@{version}':
        raise ValueError('Pinned build-tool version differs from packageManager')
    no_links(target)
    if not apply:
        return {'mode': 'plan', 'target': str(target), 'network_accessed': False}
    if archive_path:
        no_links(Path(archive_path).absolute())
        data = Path(archive_path).read_bytes()
    else:
        with urllib.request.urlopen(lock['tarball'], timeout=45) as response:
            data = response.read(lock['archiveBytes'] + 1)
    files = entries(data, lock)
    if target.exists():
        actual = set()
        for path in target.rglob('*'):
            no_links(path)
            if path.is_file():
                relative = path.relative_to(target).as_posix()
                actual.add(relative)
                if files.get(relative) != path.read_bytes():
                    raise ValueError('Existing local build tool differs')
        if actual != set(files):
            raise ValueError('Existing local build-tool inventory differs')
        return {'mode': 'apply', 'state': 'already_verified', 'files': len(files)}
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='pnpm-verified-', dir=target.parent) as tmp:
        unpacked = Path(tmp) / 'package'
        unpacked.mkdir()
        for relative, content in files.items():
            path = unpacked / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        unpacked.rename(target)
    return {'mode': 'apply', 'state': 'unpacked', 'files': len(files)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--archive', type=Path)
    args = parser.parse_args()
    print(json.dumps(bootstrap(args.apply, args.archive), indent=2))
