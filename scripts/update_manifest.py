"""Regenerate or check integrity pins for the reviewed Git source inventory."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def content():
    # Use the index: unreviewed/ignored local state never enters the manifest.
    unstaged = subprocess.check_output(['git', 'diff', '--name-only', '-z'], cwd=ROOT).decode().split('\0')
    if any(name and name != 'recovery-manifest.json' for name in unstaged):
        raise ValueError('Stage or preserve pending source changes before regenerating the manifest')
    names = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    rows = []
    for name in sorted(filter(None, names)):
        if name == 'recovery-manifest.json':
            continue
        path = ROOT / name
        if path.is_symlink() or getattr(path, 'is_junction', lambda: False)() or not path.is_file():
            raise ValueError('Expected ordinary source file: ' + name)
        rows.append({'path': name, 'sha256_lf': hashlib.sha256(path.read_bytes().replace(b'\r\n', b'\n')).hexdigest()})
    if not rows:
        raise ValueError('Stage the reviewed source inventory before generating its manifest')
    return (json.dumps({'schema': 1, 'digest': 'SHA-256 after CRLF-to-LF normalization',
                        'files': rows}, indent=2) + '\n').encode()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true')
    args = parser.parse_args()
    expected = content()
    target = ROOT / 'recovery-manifest.json'
    if args.write:
        target.write_bytes(expected)
    elif not target.exists() or target.read_bytes().replace(b'\r\n', b'\n') != expected:
        raise SystemExit('Recovery manifest differs; review/stage source changes, then use --write')
    print('Recovery manifest matches reviewed source inventory')
