import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('decompile_pristine', Path(__file__).parents[1] / 'decompile_pristine.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CacheOwnershipTests(unittest.TestCase):
    def test_second_writer_cannot_enter_or_remove_first_claim(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            with module.exclusive_cache(path):
                with self.assertRaises(ValueError):
                    with module.exclusive_cache(path):
                        self.fail('Concurrent writer entered')
                self.assertTrue((path / 'writer.lock').exists())
            self.assertFalse((path / 'writer.lock').exists())

    def test_failed_writer_releases_claim(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            with self.assertRaises(RuntimeError):
                with module.exclusive_cache(path):
                    raise RuntimeError('Compiler failed')
            with module.exclusive_cache(path):
                self.assertTrue((path / 'writer.lock').exists())

    def test_stale_claim_requires_inspection(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            (path / 'writer.lock').write_text('old interrupted writer')
            with self.assertRaises(ValueError):
                with module.exclusive_cache(path):
                    self.fail('Stale claim bypassed')
            self.assertEqual((path / 'writer.lock').read_text(), 'old interrupted writer')
