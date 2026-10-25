import base64
import hashlib
import importlib.util
import io
from pathlib import Path
import sys
import tarfile
import unittest

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
