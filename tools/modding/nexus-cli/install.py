"""Install the pinned official release asset of the community Nexus CLI."""
import hashlib
import json
from pathlib import Path
import sys
import urllib.request
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from workspace_paths import workspace_root

ROOT = workspace_root() / 'local-state/nexus-cli'
VERSION = '1.1.1'
SHA256 = '4790715ab94847757eb405c6442dae8dcc73c2f656ec43c367038b7b79c5812d'
SIZE = 377388
URL = f'https://github.com/vadimtrifonov/nexusmods-cli/releases/download/v{VERSION}/nexusmods-{VERSION}-win-x64.zip'

def install():
    ROOT.mkdir(parents=True, exist_ok=True)
    archive = ROOT / f'nexusmods-{VERSION}-win-x64.zip'
    if not archive.exists():
        request = urllib.request.Request(URL, headers={'User-Agent': 'Nexus-Agent-Setup/1'})
        with urllib.request.urlopen(request, timeout=90) as response:
            data = response.read(SIZE + 1)
        if len(data) != SIZE or hashlib.sha256(data).hexdigest() != SHA256:
            raise RuntimeError('Release size/SHA256 mismatch')
        with archive.open('xb') as output:
            output.write(data)
    data = archive.read_bytes()
    if len(data) != SIZE or hashlib.sha256(data).hexdigest() != SHA256:
        raise RuntimeError('Cached release size/SHA256 mismatch')
    destination = ROOT / VERSION
    with zipfile.ZipFile(archive) as zipped:
        if zipped.testzip() is not None:
            raise RuntimeError('Release CRC failure')
        for item in zipped.infolist():
            target = (destination / item.filename).resolve()
            if not target.is_relative_to(destination.resolve()):
                raise RuntimeError('Release path escape')
            if item.is_dir():
                continue
            expected = zipped.read(item)
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                if target.read_bytes() != expected:
                    raise RuntimeError('Existing installation differs; refusing overwrite')
            else:
                with target.open('xb') as output:
                    output.write(expected)
    executables = list(destination.rglob('nexusmods.exe'))
    if len(executables) != 1:
        raise RuntimeError('Expected one CLI executable')
    receipt = {'version': VERSION, 'source_commit': '494f061e9f277414c4df306826b4d92cd1e6b90c',
               'release_sha256': SHA256, 'release_size': SIZE, 'crc_verified': True,
               'executable': str(executables[0]), 'exe_sha256': hashlib.sha256(executables[0].read_bytes()).hexdigest()}
    receipt_path = ROOT / 'installation.json'
    if receipt_path.exists():
        if json.loads(receipt_path.read_text(encoding='utf-8')) != receipt:
            raise RuntimeError('Existing installation receipt differs; refusing overwrite')
    else:
        with receipt_path.open('x', encoding='utf-8') as output:
            output.write(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))

if __name__ == '__main__':
    install()
