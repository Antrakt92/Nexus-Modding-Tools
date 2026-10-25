import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('credential_setup', Path(__file__).with_name('credential_setup.py'))
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)

class CredentialsTests(unittest.TestCase):
    def test_validation_before_storage_and_safe_output(self):
        synthetic = 'synthetic-test-not-a-real-key-' + 'A' * 40
        calls = []
        result = setup.setup(lambda: synthetic,
                             lambda key: calls.append(('validate', key)) or {'validated': True, 'premium': False},
                             lambda key: calls.append(('store', key)))
        self.assertEqual([name for name, _ in calls], ['validate', 'store'])
        self.assertNotIn(synthetic, repr(result))

    def test_failed_validation_never_stores(self):
        def reject(key):
            raise setup.SetupError('API_KEY_REJECTED')
        with self.assertRaises(setup.SetupError):
            setup.setup(lambda: 'A' * 60, reject, lambda _: self.fail('Stored rejected credential'))

    def test_key_parser_rejects_paragraphs_and_control_chars(self):
        for invalid in ('', 'Personal API Key warning ' + 'A' * 60, 'A' * 60 + '\nB', 'A' * 1025):
            with self.assertRaises(setup.SetupError):
                setup.normalize_key(invalid)
        self.assertEqual(setup.normalize_key('  ' + 'A' * 60 + '\n'), 'A' * 60)

    def test_redirect_refused(self):
        with self.assertRaises(setup.SetupError):
            setup.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://example.com')

    def test_page_warning_with_exactly_one_personal_token(self):
        synthetic = 'A' * 44 + '=--' + 'B' * 16 + '--' + 'C' * 24 + '=='
        self.assertEqual(setup.normalize_key('Personal API Key\nWarning: account information.' + synthetic), synthetic)
        with self.assertRaises(setup.SetupError):
            setup.normalize_key('Warning ' + synthetic + '\n' + synthetic)

if __name__ == '__main__':
    unittest.main()
