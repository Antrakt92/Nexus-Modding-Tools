import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

scripts = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(scripts))
spec = importlib.util.spec_from_file_location('bootstrap', scripts / 'bootstrap_pnpm.py')
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)


def fixture(name='package/bin/tool.cjs', link=False):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w:gz') as archive:
        member = tarfile.TarInfo(name)
        data = b'example'
        if link:
            member.type = tarfile.SYMTYPE
            member.linkname = '/outside'
            archive.addfile(member)
        else:
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
    value = stream.getvalue()
    lock = {'archiveBytes': len(value),
            'integrity': 'sha512-' + base64.b64encode(hashlib.sha512(value).digest()).decode(),
            'fileCount': 1, 'unpackedBytes': len(data)}
    return value, lock


class BootstrapTests(unittest.TestCase):
    def test_plan_rejects_inconsistent_source_and_destination_without_network(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            vendor = root / 'dependencies/vortex-mcp'; vendor.mkdir(parents=True)
            version = '10.34.9'
            lock = {'package': 'pnpm', 'version': version,
                    'registryMetadata': f'https://registry.npmjs.org/pnpm/{version}',
                    'tarball': f'https://registry.npmjs.org/pnpm/-/pnpm-{version}.tgz',
                    'retainedUnderIgnored': f'.tooling/pnpm-{version}'}
            (vendor / 'package.json').write_text(json.dumps({'packageManager': f'pnpm@{version}'}))
            lock_file = vendor / 'PNPM-BOOTSTRAP.json'
            for patch in [{'tarball': 'https://example.com/tool.tgz'},
                          {'registryMetadata': 'https://example.com/metadata'},
                          {'retainedUnderIgnored': 'src'}, {'version': '../outside'},
                          {'package': 'other'}, {'version': '9.15.0'}]:
                lock_file.write_text(json.dumps({**lock, **patch}))
                with self.subTest(patch=patch), mock.patch.object(b, 'ROOT', root), \
                        mock.patch.object(b.urllib.request, 'urlopen') as network:
                    with self.assertRaisesRegex(ValueError, 'build-tool'):
                        b.bootstrap()
                    network.assert_not_called()
            lock_file.write_text(json.dumps(lock))
            with mock.patch.object(b, 'ROOT', root), mock.patch.object(b.urllib.request, 'urlopen') as network:
                self.assertEqual(b.bootstrap()['mode'], 'plan')
                network.assert_not_called()
            self.assertFalse((vendor / '.tooling').exists())

    def test_retained_build_tool_path_cannot_escape_vendor_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            vendor = root / 'dependencies/vortex-mcp'; vendor.mkdir(parents=True)
            for value in ['../../../outside', str(root / 'outside')]:
                (vendor / 'PNPM-BOOTSTRAP.json').write_text(json.dumps({'retainedUnderIgnored': value}))
                with mock.patch.object(b, 'ROOT', root):
                    with self.assertRaisesRegex(ValueError, 'recovery path'):
                        b.bootstrap()
            self.assertFalse((root / 'outside').exists())

    def test_pinned_content(self):
        data, lock = fixture()
        self.assertEqual(b.entries(data, lock), {'bin/tool.cjs': b'example'})

    def test_reject_corruption(self):
        data, lock = fixture()
        with self.assertRaises(ValueError):
            b.entries(data[:-1] + bytes([data[-1] ^ 1]), lock)

    def test_reject_paths_and_links_even_with_matching_hash(self):
        for name, link in [('package/../outside', False), ('package/bin/link', True), ('/absolute', False)]:
            data, lock = fixture(name, link)
            with self.assertRaises(ValueError):
                b.entries(data, lock)


if __name__ == '__main__':
    unittest.main()
