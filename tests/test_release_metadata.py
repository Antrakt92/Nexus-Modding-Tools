"""Keep the distributed version aligned with its newest dated changelog entry."""
from datetime import date
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ReleaseMetadataTests(unittest.TestCase):
    def test_version_matches_latest_dated_release(self):
        version = (ROOT / 'VERSION').read_text(encoding='utf-8').strip()
        self.assertRegex(version, r'^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$')
        changelog = (ROOT / 'CHANGELOG.md').read_text(encoding='utf-8')
        releases = re.findall(r'^## (\d+\.\d+\.\d+) — (\d{4}-\d{2}-\d{2})$', changelog, re.M)
        self.assertTrue(releases, 'A source release needs a dated changelog entry')
        self.assertEqual(version, releases[0][0], 'VERSION differs from the newest release')
        self.assertEqual(len(releases), len({v for v, _ in releases}), 'Duplicate release version')
        for _, released in releases:
            date.fromisoformat(released)


if __name__ == '__main__':
    unittest.main()
