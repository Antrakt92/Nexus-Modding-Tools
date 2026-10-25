import contextlib
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile


HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from workspace_paths import workspace_root, context_root


class PortablePathsTests(unittest.TestCase):
    def fixture_installer(self, root):
        spec = importlib.util.spec_from_file_location('fixture_cli_audit', HERE / 'install.py')
        installer = importlib.util.module_from_spec(spec); spec.loader.exec_module(installer)
        target = Path(root) / 'cli'
        target.mkdir()
        archive = target / f'nexusmods-{installer.VERSION}-win-x64.zip'
        with zipfile.ZipFile(archive, 'w') as zipped:
            zipped.writestr('nexusmods.exe', b'Synthetic fixture; never executed')
            zipped.writestr('support/data.txt', b'Synthetic support data')
        data = archive.read_bytes()
        installer.ROOT, installer.SIZE, installer.SHA256 = target, len(data), hashlib.sha256(data).hexdigest()
        return installer

    def directory_link(self, link, destination):
        if sys.platform == 'win32':
            result = subprocess.run(['cmd.exe', '/c', 'mklink', '/J', str(link), str(destination)],
                capture_output=True, text=True, creationflags=subprocess.CREATE_NO_WINDOW)
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            link.symlink_to(destination, target_is_directory=True)

    def test_cli_output_junctions_and_dangling_leaf_are_refused_before_extraction(self):
        for placement in ['destination', 'nested', 'dangling', 'dangling-file-leaf']:
            with self.subTest(placement=placement), tempfile.TemporaryDirectory(prefix='cli link audit ') as root:
                installer = self.fixture_installer(root)
                outside = Path(root) / 'outside'; outside.mkdir()
                destination = installer.ROOT / installer.VERSION
                link = destination
                if placement == 'nested':
                    destination.mkdir(); link = destination / 'support'
                elif placement == 'dangling-file-leaf':
                    destination.mkdir(); link = destination / 'nexusmods.exe'
                self.directory_link(link, outside)
                if placement in ['dangling', 'dangling-file-leaf']:
                    outside.rmdir()
                with patch.object(installer.urllib.request, 'urlopen', side_effect=AssertionError('No download allowed')):
                    with self.assertRaisesRegex(RuntimeError, 'Reparse'):
                        installer.install()
                self.assertFalse((outside / 'nexusmods.exe').exists())
                self.assertFalse((outside / 'data.txt').exists())
                self.assertFalse((installer.ROOT / 'installation.json').exists())
                if placement == 'nested':
                    self.assertFalse((destination / 'nexusmods.exe').exists())

    def test_late_existing_file_mismatch_refuses_before_creating_earlier_missing_files(self):
        with tempfile.TemporaryDirectory(prefix='cli preflight audit ') as root:
            installer = self.fixture_installer(root)
            destination = installer.ROOT / installer.VERSION
            support = destination / 'support/data.txt'
            support.parent.mkdir(parents=True)
            support.write_bytes(b'Unrelated existing content')
            with patch.object(installer.urllib.request, 'urlopen', side_effect=AssertionError('No download allowed')):
                with self.assertRaisesRegex(RuntimeError, 'refusing overwrite'):
                    installer.install()
            self.assertEqual(support.read_bytes(), b'Unrelated existing content')
            self.assertFalse((destination / 'nexusmods.exe').exists())
            self.assertFalse((installer.ROOT / 'installation.json').exists())

    def test_existing_receipt_mismatch_refuses_before_creating_any_installed_files(self):
        with tempfile.TemporaryDirectory(prefix='cli receipt audit ') as root:
            installer = self.fixture_installer(root)
            receipt = installer.ROOT / 'installation.json'
            receipt.write_text('{"other":"installation"}', encoding='utf-8')
            with patch.object(installer.urllib.request, 'urlopen', side_effect=AssertionError('No download allowed')):
                with self.assertRaisesRegex(RuntimeError, 'receipt differs'):
                    installer.install()
            self.assertEqual(receipt.read_text(), '{"other":"installation"}')
            self.assertFalse((installer.ROOT / installer.VERSION).exists())

    def test_defaults_follow_source_and_overrides_preserve_spaces_without_creation(self):
        with tempfile.TemporaryDirectory(prefix="portable nexus ") as root:
            alternate = Path(root) / "another workspace with spaces"
            context = Path(root) / "read only context"
            with patch.dict(os.environ, {"NEXUS_WORKSPACE": str(alternate), "NEXUS_CONTEXT_ROOT": str(context)}):
                self.assertEqual(workspace_root(), alternate.resolve())
                self.assertEqual(context_root(), context.resolve())
                self.assertFalse(alternate.exists())
                self.assertFalse(context.exists())
            with patch.dict(os.environ, {"NEXUS_WORKSPACE": "", "NEXUS_CONTEXT_ROOT": ""}):
                self.assertEqual(workspace_root(), HERE.parents[2])
                self.assertEqual(context_root(), HERE.parents[2] / "local-state/upstream-sources")
            with patch.dict(os.environ, {"NEXUS_WORKSPACE": "relative"}):
                with self.assertRaisesRegex(ValueError, "absolute"):
                    workspace_root()

    def test_cli_and_publisher_imports_use_alternate_workspace_from_another_cwd(self):
        with tempfile.TemporaryDirectory(prefix="nexus alternate workspace ") as root:
            alternate = Path(root) / "runtime files"
            action = Path(root) / "verified action checkout"
            script = """
import importlib.util,json,sys
from pathlib import Path
def load(filename):
    spec=importlib.util.spec_from_file_location('fixture_'+Path(filename).stem,filename)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
cli=load(sys.argv[1]);publisher=load(sys.argv[2])
print(json.dumps({'cli':str(cli.ROOT),'action':str(publisher.DEFAULT_ACTION),'state':str(publisher.STATE)}))
"""
            env = {**os.environ, "NEXUS_WORKSPACE": str(alternate), "NEXUS_CONTEXT_ROOT": "",
                   "NEXUS_UPLOAD_ACTION_ROOT": str(action), "NEXUS_STATE_DIR": ""}
            result = subprocess.run([sys.executable, "-B", "-c", script, str(HERE / "install.py"),
                str(HERE.parent / "nexus-publish/publish.py")], cwd=root, env=env, capture_output=True, text=True, check=True)
            values = json.loads(result.stdout)
            self.assertEqual(Path(values["cli"]), alternate / "local-state/nexus-cli")
            self.assertEqual(Path(values["state"]), alternate / "local-state/nexus-publish-setup")
            self.assertEqual(Path(values["action"]), action)
            self.assertFalse(alternate.exists())
            self.assertFalse(action.exists())

    def test_pinned_cli_reuse_never_overwrites_a_changed_binary_or_receipt(self):
        spec = importlib.util.spec_from_file_location("fixture_cli_install", HERE / "install.py")
        installer = importlib.util.module_from_spec(spec); spec.loader.exec_module(installer)
        with tempfile.TemporaryDirectory(prefix="nexus install fixture ") as root:
            target = Path(root) / "workspace with spaces/local-state/nexus-cli"
            target.mkdir(parents=True)
            archive = target / f"nexusmods-{installer.VERSION}-win-x64.zip"
            with zipfile.ZipFile(archive, "w") as zipped:
                zipped.writestr("nexusmods.exe", b"Synthetic CLI fixture, never executed")
            data = archive.read_bytes()
            with patch.object(installer, "ROOT", target), patch.object(installer, "SIZE", len(data)), \
                 patch.object(installer, "SHA256", hashlib.sha256(data).hexdigest()), \
                 patch.object(installer.urllib.request, "urlopen", side_effect=AssertionError("No download allowed")), \
                 contextlib.redirect_stdout(io.StringIO()):
                installer.install()
                receipt = target / "installation.json"
                original_receipt, original_mtime = receipt.read_bytes(), receipt.stat().st_mtime_ns
                installer.install()
                self.assertEqual(receipt.read_bytes(), original_receipt)
                self.assertEqual(receipt.stat().st_mtime_ns, original_mtime)
                binary = target / installer.VERSION / "nexusmods.exe"
                binary.write_bytes(b"unrelated changed installation")
                with self.assertRaisesRegex(RuntimeError, "refusing overwrite"):
                    installer.install()
                self.assertEqual(binary.read_bytes(), b"unrelated changed installation")
                self.assertEqual(receipt.read_bytes(), original_receipt)
                binary.write_bytes(b"Synthetic CLI fixture, never executed")
                receipt.write_text('{"other":"installation"}', encoding="utf-8")
                with self.assertRaisesRegex(RuntimeError, "receipt differs"):
                    installer.install()
                self.assertEqual(receipt.read_text(encoding="utf-8"), '{"other":"installation"}')

    @unittest.skipUnless(sys.platform == "win32", "Windows PowerShell wrapper")
    def test_powershell_wrapper_resolves_workspace_with_spaces_from_any_cwd(self):
        script = """
function Test-Path {
  param([string]$LiteralPath, [string]$PathType)
  [Console]::WriteLine('EXE=' + [IO.Path]::GetFullPath($LiteralPath))
  return $false
}
& $env:NEXUS_TEST_WRAPPER
"""
        with tempfile.TemporaryDirectory(prefix="nexus wrapper cwd ") as root:
            for override, expected in [(str(Path(root) / "alternate workspace with spaces"), Path(root) / "alternate workspace with spaces"),
                                       ("", HERE.parents[2])]:
                env = {**os.environ, "NEXUS_TEST_WRAPPER": str(HERE / "nexusmods.ps1"), "NEXUS_WORKSPACE": override}
                executable = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
                result = subprocess.run([str(executable), "-NoProfile", "-NonInteractive", "-EncodedCommand",
                    base64.b64encode(script.encode("utf-16le")).decode("ascii")], cwd=root, env=env, capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)  # Test-Path refuses before any executable invocation.
                observed = next(line[4:] for line in result.stdout.splitlines() if line.startswith("EXE="))
                self.assertEqual(Path(observed), expected / "local-state/nexus-cli/1.1.1/nexusmods.exe")


if __name__ == "__main__":
    unittest.main()
