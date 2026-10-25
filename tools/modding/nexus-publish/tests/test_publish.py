import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

HERE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("nexus_publish", HERE / "publish.py")
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
asset_spec = importlib.util.spec_from_file_location("release_assets", HERE / "release-assets.py")
assets = importlib.util.module_from_spec(asset_spec)
asset_spec.loader.exec_module(assets)
credential_spec = importlib.util.spec_from_file_location("windows_credential", HERE / "windows-credential.py")
credential = importlib.util.module_from_spec(credential_spec)
credential_spec.loader.exec_module(credential)


class RunnerTests(unittest.TestCase):
    def setUp(self):
        test_cache = Path(os.environ["NEXUS_TEST_STATE"]) if os.environ.get("NEXUS_TEST_STATE") else None
        if test_cache is not None:
            test_cache.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="nexus publication ", dir=test_cache)
        self.root = Path(self.temp.name)
        self.archive = self.root / "fixture.zip"
        with zipfile.ZipFile(self.archive, "w") as z:
            z.writestr("fixture.txt", "Synthetic publication test, not a mod package.")
        self.m = dict(game="examplegame", mod_page_id="12", mod_id="456", file_id="123", existing_file=True,
                      archive=str(self.archive), version="1.2.3", sha256=p.sha256(self.archive), expected_user_id="42")
        self.target = {"id": "123", "versions_count": 1}
        self.mod = {"id": "456", "game_scoped_id": "12", "game_id": "1"}
        self.files = {"mod_files": [{"id": "123"}]}
        self.version = dict(id="987", file={"id": "123"}, version="1.2.3", name="fixture.zip", category="main")

    def tearDown(self):
        self.temp.cleanup()

    def read(self, route, key):
        self.assertEqual(key, "mock-secret-never-log")
        if route == "/v1/users/validate.json": return {"user_id": 42}
        if route == "/v1/games/examplegame/mods/12.json":
            return {"mod_id": 12, "domain_name": "examplegame", "user": {"member_id": 42}}
        return {"/games/examplegame/mods/12": self.mod, "/mods/456/files": self.files,
                "/mod-files/123": self.target, "/mod-files/123/versions": {"versions": [{"version": "1.0.0"}]},
                "/mod-file-versions/987": self.version}[route]

    def execute(self, report):
        with patch.object(p, "verify_action", return_value="node"):
            return p.execute(self.m, publish=True, state=self.root, credential=lambda: "mock-secret-never-log",
                             invoke=lambda *a: report, read=self.read)

    def test_dry_run_never_reads_key_or_invokes_action_network(self):
        with patch.object(p, "verify_action", side_effect=AssertionError), patch.object(p, "api_read", side_effect=AssertionError):
            result = p.execute(self.m, state=self.root, credential=lambda: self.fail("key read"),
                               invoke=lambda *a: self.fail("action run"))
        self.assertEqual(result["outcome"], "dry-run")
        self.assertFalse(result["uploaded"])
        self.assertFalse(result["target_relationship_verified"])
        self.assertFalse(p.receipt_path(self.m, self.root).exists())

    def test_invalid_manifest_variants(self):
        for change in [{"file_id": "0"}, {"mod_id": "../../other"}, {"existing_file": False},
                       {"archive": "fixture.zip"}, {"sha256": "0" * 64}, {"version": "1\n2"},
                       {"archive_existing_version": "false"}, {"category": "removed"},
                       {"api_key": "forbidden"}, {"NEXUSMODS_API_BASE": "https://invalid"}]:
            with self.subTest(change=change), self.assertRaises(p.Blocked):
                p.preflight({**self.m, **change})

    def test_not_zip(self):
        self.archive.write_bytes(b"not a zip")
        self.m["sha256"] = p.sha256(self.archive)
        with self.assertRaises(p.Blocked): p.preflight(self.m)

    def test_correct_done_requires_independent_metadata_readback(self):
        result = self.execute({"ok": True, "version_id": "987"})
        self.assertEqual(result["outcome"], "done")
        self.assertTrue(result["uploaded"])
        self.assertTrue(result["metadata_verified"])
        self.assertFalse(result["artifact_verified"])
        text = p.receipt_path(self.m, self.root).read_text()
        self.assertNotIn("mock-secret", text)
        self.assertNotIn("https://", text)

    def test_readback_mismatch_is_unknown(self):
        self.version["version"] = "wrong"
        result = self.execute({"ok": True, "version_id": "987"})
        self.assertEqual(result["outcome"], "unknown")
        self.assertFalse(result["uploaded"])

    def test_failure_after_version_creation_is_unknown_reconcile_preserves_partial_action(self):
        result = self.execute({"ok": False, "version_id": "987"})
        self.assertEqual(result["outcome"], "unknown")
        result = p.reconcile(self.m, "mock-secret-never-log", state=self.root, read=self.read)
        self.assertEqual(result["outcome"], "done")
        self.assertFalse(result["action_complete"])

    def test_attempt_survives_crash_and_hash_change_cannot_bypass(self):
        path = p.receipt_path(self.m, self.root)
        p.write_receipt(path, p.record(self.m, "attempt"), exclusive=True)
        with zipfile.ZipFile(self.archive, "a") as z: z.writestr("changed.txt", "changed")
        self.m["sha256"] = p.sha256(self.archive)
        with self.assertRaisesRegex(p.Blocked, "Blind retry"):
            self.execute({"ok": True, "version_id": "987"})

    def test_unknown_and_done_both_block_retries(self):
        self.execute({"ok": False, "version_id": None})
        with self.assertRaisesRegex(p.Blocked, "Blind retry"): self.execute({"ok": True, "version_id": "987"})
        with self.assertRaises(p.Blocked): p.reconcile(self.m, "mock-secret-never-log", state=self.root, read=self.read)

    def test_version_bump_cannot_bypass_uncertain_target_lock(self):
        self.execute({"ok": False, "version_id": None})
        self.m["version"] = "2.0.0"
        with self.assertRaisesRegex(p.Blocked, "unresolved"): self.execute({"ok": True, "version_id": "987"})

    def test_done_unlocks_target_for_new_versions_but_keeps_exact_attempt_receipt(self):
        self.execute({"ok": True, "version_id": "987"})
        self.assertFalse(p.target_lock_path(self.m, self.root).exists())
        with self.assertRaisesRegex(p.Blocked, "Blind retry"): self.execute({"ok": True, "version_id": "987"})
        self.m["version"] = "2.0.0"
        self.version["version"] = "2.0.0"
        self.assertEqual(self.execute({"ok": True, "version_id": "987"})["outcome"], "done")

    def test_readback_errors_are_sanitized_and_redirects_refused(self):
        with patch.object(p, "build_opener", side_effect=RuntimeError("mock-secret https://signed.invalid")):
            with self.assertRaises(p.Blocked) as error: p.api_read("/mod-files/123", "mock-secret")
        self.assertNotIn("mock-secret", str(error.exception))
        self.assertNotIn("https://", str(error.exception))
        with self.assertRaises(p.Blocked): p.NoRedirect().redirect_request(None, None, 302, "x", {}, "https://other")

    def test_wrong_target_and_duplicate_block_before_attempt(self):
        self.mod["id"] = "other"
        with self.assertRaises(p.Blocked): self.execute({"ok": True, "version_id": "987"})
        self.assertFalse(p.receipt_path(self.m, self.root).exists())
        self.mod["id"] = "456"
        def duplicate(route, key):
            return {"versions": [{"version": "1.2.3"}]} if route.endswith("/versions") else self.read(route, key)
        with self.assertRaises(p.Blocked):
            p.validate_target(self.m, "mock-secret-never-log", duplicate)

    def test_exclusive_attempt_receipt(self):
        path = p.receipt_path(self.m, self.root)
        p.write_receipt(path, p.record(self.m, "attempt"), exclusive=True)
        with self.assertRaises(FileExistsError): p.write_receipt(path, {}, exclusive=True)

    def test_environment_is_allowlisted(self):
        with patch.dict(os.environ, {"NODE_OPTIONS": "--import evil", "NEXUSMODS_API_BASE": "https://evil",
                                     "GITHUB_OUTPUT": "private.txt", "ACTIONS_STEP_DEBUG": "true", "OTHER_SECRET": "private"}):
            env = p.child_environment(self.m, "mock-secret-never-log")
        for k in ["NODE_OPTIONS", "NEXUSMODS_API_BASE", "GITHUB_OUTPUT", "ACTIONS_STEP_DEBUG", "OTHER_SECRET"]:
            self.assertNotIn(k, env)
        self.assertEqual(env["INPUT_ARCHIVE_EXISTING_VERSION"], "false")

    def test_release_assets_binds_archive_and_keeps_default_preflight_offline(self):
        env = {"RELEASE_TAG": "v1.2.3", "ARCHIVE_ASSET": "fixture.zip", "MANIFEST_ASSET": "publication.json",
               "GH_REPO": "example/mod", "RUNNER_TEMP": str(self.root)}
        def download(command, **kwargs):
            self.assertIn("--pattern", command)
            destination = Path(command[command.index("--dir") + 1])
            (destination / "fixture.zip").write_bytes(self.archive.read_bytes())
            (destination / "publication.json").write_text(json.dumps(self.m))
            return subprocess.CompletedProcess(command, 0, b"", b"")
        with patch.dict(os.environ, env), patch.object(assets.subprocess, "run", side_effect=download), patch.dict(sys.modules, {"publish": p}):
            self.assertEqual(assets.main(), 0)
        result = json.loads((self.root / "nexus-publish-assets/manifest.json").read_text())
        self.assertEqual(result["archive"], str((self.root / "nexus-publish-assets/fixture.zip").resolve()))
        self.assertEqual(result["sha256"], self.m["sha256"])

    def test_release_assets_rejects_argument_injection_and_suppresses_gh_errors(self):
        import contextlib
        import io
        env = {"RELEASE_TAG": "--delete", "ARCHIVE_ASSET": "fixture.zip", "MANIFEST_ASSET": "publication.json",
               "GH_REPO": "example/mod", "RUNNER_TEMP": str(self.root)}
        stderr = io.StringIO()
        with patch.dict(os.environ, env), patch.object(assets.subprocess, "run") as call, contextlib.redirect_stderr(stderr):
            self.assertEqual(assets.main(), 2)
            call.assert_not_called()
        env["RELEASE_TAG"] = "v1.2.3"
        with patch.dict(os.environ, env), contextlib.redirect_stderr(stderr), patch.object(assets.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, b"mock-secret", b"https://private.invalid")):
            self.assertEqual(assets.main(), 2)
        self.assertNotIn("mock-secret", stderr.getvalue())
        self.assertNotIn("https://", stderr.getvalue())

    def test_windows_archive_lock_blocks_mutation_but_allows_action_read(self):
        with p.frozen_archive(self.archive):
            self.assertEqual(p.sha256(self.archive), self.m["sha256"])
            with self.assertRaises(PermissionError): self.archive.write_bytes(b"changed")
            with self.assertRaises(PermissionError): self.archive.unlink()
        self.archive.write_bytes(b"released")

    def test_bundle_pin_accepts_only_git_eol_conversion_and_rejects_tampering(self):
        original = p.DEFAULT_ACTION / "dist/index.js"
        copied = self.root / "bundle.js"
        content = original.read_bytes().replace(b"\r\n", b"\n")
        copied.write_bytes(content.replace(b"\n", b"\r\n"))
        self.assertEqual(p.bundle_sha256(copied), p.BUNDLE_SHA256)
        copied.write_bytes(content + b"//tampered")
        self.assertNotEqual(p.bundle_sha256(copied), p.BUNDLE_SHA256)
        with patch.object(p, "bundle_sha256", return_value="0" * 64):
            with self.assertRaisesRegex(p.Blocked, "pin or bundle hash"): p.verify_action(p.DEFAULT_ACTION)

    def test_official_bundle_end_to_end_mock_network(self):
        node = p.verify_action(p.DEFAULT_ACTION)
        for case, expected in [("success", True), ("upload-failure", False), ("changelog-failure", False)]:
            with self.subTest(case=case):
                manifest = {**self.m, "changelog": "Modeled changelog"}
                env = p.child_environment(manifest, "mock-secret-never-log")
                env["MOCK_CASE"] = case
                result = subprocess.run([node, "--import", (HERE / "tests/mock-network.mjs").as_uri(),
                                         str(HERE / "safe-action.mjs"), str(p.DEFAULT_ACTION / "dist/index.js")],
                                        env=env, capture_output=True, timeout=30)
                combined = result.stdout + result.stderr
                self.assertNotIn(b"mock-secret", combined)
                self.assertNotIn(b"signature", combined)
                self.assertNotIn(b"https://", combined)
                self.assertEqual(result.stderr, b"")
                report = json.loads(result.stdout)
                self.assertEqual(report["ok"], expected)
                self.assertEqual(report["version_id"], None if case == "upload-failure" else "987")
                self.assertEqual(result.returncode, 0 if expected else 1)

    def mocked_bundle(self, manifest, case="success", **options):
        env = p.child_environment(manifest, "mock-secret-never-log")
        env.update(MOCK_CASE=case, **options)
        result = subprocess.run([p.verify_action(p.DEFAULT_ACTION), "--import", (HERE / "tests/mock-network.mjs").as_uri(),
                                 str(HERE / "safe-action.mjs"), str(p.DEFAULT_ACTION / "dist/index.js")],
                                env=env, capture_output=True, timeout=30)
        self.assertEqual(result.stderr, b"")
        for forbidden in [b"mock-secret", b"signature", b"https://"]:
            self.assertNotIn(forbidden, result.stdout + result.stderr)
        return result, json.loads(result.stdout)

    def test_bundle_redirect_302_307_never_forwards_api_key(self):
        for code in (302, 307):
            with self.subTest(code=code):
                result, report = self.mocked_bundle(self.m, f"redirect-{code}")
                self.assertEqual(result.returncode, 1)  # 73 means fake native fetch forwarded the key.
                self.assertFalse(report["ok"])
                self.assertIsNone(report["version_id"])

    def test_bundle_storage_denies_unsafe_destinations_before_any_storage_request(self):
        for url in ["http://fixture.s3.eu-west-1.amazonaws.com/part", "https://localhost/part",
                    "https://127.0.0.1/part", "https://[::1]/part", "https://10.0.0.1/part",
                    "https://attacker.invalid/part", "https://fixture.s3.eu-west-1.amazonaws.com.evil.invalid/part",
                    "https://fixture.s3.eu-west-1.amazonaws.com:444/part", "https://user:pass@fixture.s3.eu-west-1.amazonaws.com/part"]:
            with self.subTest(url=url):
                result, report = self.mocked_bundle(self.m, "storage-denied", MOCK_STORAGE_URL=url)
                self.assertEqual(result.returncode, 1)  # 73 means unsafe storage reached the transport.
                self.assertFalse(report["ok"])
                self.assertIsNone(report["version_id"])

    def test_real_bundle_empty_display_name_readback_uses_filename_fallback(self):
        self.m["display_name"] = ""
        result, report = self.mocked_bundle(self.m, MOCK_EXPECTED_NAME="fixture.zip")
        self.assertEqual(result.returncode, 0)
        receipt = self.execute(report)
        self.assertEqual(receipt["outcome"], "done")
        self.assertEqual(receipt["effective_display_name"], "fixture.zip")

    def test_padded_action_options_are_rejected_before_action_or_key_access(self):
        options = ["display_name", "description", "category", "changelog", "version", "mod_id", "file_id"]
        for field in options:
            for padding in [" ", "\t", "\n", "\u00a0", "\ufeff", "\u2028", "\u3000"]:
                with self.subTest(field=field, padding=repr(padding)):
                    manifest = {**self.m, field: padding + (self.m.get(field) or "name") + padding}
                    with self.assertRaises(p.Blocked):
                        p.execute(manifest, state=self.root, credential=lambda: self.fail("credential accessed"),
                                  invoke=lambda *a: self.fail("action invoked"))
        with self.assertRaises(p.Blocked): p.preflight({**self.m, "display_name": "   "})

    def test_real_bundle_effective_name_defaults_and_all_optional_metadata_semantics(self):
        for name in ["A named version", "Named _'().- version", ""]:
            with self.subTest(name=repr(name)):
                manifest = {**self.m, "display_name": name, "category": "", "description": "", "changelog": "",
                            "primary_mod_manager_download": False, "allow_mod_manager_download": True,
                            "show_requirements_pop_up": False, "archive_existing_version": False, "update_mod_version": False}
                manifest = p.preflight(manifest)
                expected_name = name or "fixture.zip"
                expected = {"name": expected_name, "file_category": "main", "primary_mod_manager_download": False,
                            "allow_mod_manager_download": True, "show_requirements_pop_up": False,
                            "archive_existing_file": False, "update_mod_version": False}
                result, report = self.mocked_bundle(manifest, MOCK_EXPECTED_NAME=expected_name, MOCK_METADATA=json.dumps(expected))
                self.assertEqual(result.returncode, 0)
                self.assertTrue(report["ok"])
                self.version["name"] = expected_name
                self.assertTrue(p.readback(manifest, "987", "mock-secret-never-log", self.read))
                self.assertEqual(p.record(manifest, "dry-run")["effective_display_name"], expected_name)
                self.assertEqual(p.record(manifest, "dry-run")["effective_category"], "main")

    def test_reconcile_cannot_change_effective_display_name_in_existing_receipt(self):
        self.execute({"ok": False, "version_id": "987"})
        self.m["display_name"] = "Changed later"
        self.version["name"] = "Changed later"
        with self.assertRaisesRegex(p.Blocked, "effective metadata"):
            p.reconcile(self.m, "mock-secret-never-log", state=self.root, read=self.read)

    def fake_credential_api(self, blob, reported_size=None, success=True):
        import ctypes
        from types import SimpleNamespace
        allocation = ctypes.create_string_buffer(blob)
        item = credential.Credential()
        item.Type = 1
        item.CredentialBlob = ctypes.addressof(allocation)
        item.CredentialBlobSize = len(blob) if reported_size is None else reported_size
        reads, frees = [], []
        class Call:
            def __init__(self, function): self.function = function
            def __call__(self, *args): return self.function(*args)
        def read(target, kind, flags, out):
            reads.append((target, kind, flags))
            if success:
                ctypes.cast(out, ctypes.POINTER(ctypes.POINTER(credential.Credential)))[0] = ctypes.pointer(item)
            return success
        api = SimpleNamespace(CredReadW=Call(read), CredFree=Call(lambda pointer: frees.append(bool(pointer))))
        return api, reads, frees, (allocation, item)

    def test_shared_credential_reads_only_verified_target_counted_utf16_and_frees(self):
        api, reads, frees, keepalive = self.fake_credential_api("synthetic-credential".encode("utf-16-le"))
        self.assertEqual(credential.load(api), "synthetic-credential")
        self.assertEqual(reads, [("skill-nexus", 1, 0)])
        self.assertEqual(frees, [True])

    def test_shared_credential_missing_malformed_and_empty_remain_safe_and_free(self):
        for blob, size, success in [(b"", 0, True), (b"aa", 1, True), (b"aa", 2562, True),
                                    (b"\x00\xd8", 2, True), (b"\x00\x00", 2, True), (b"", 0, False)]:
            with self.subTest(size=size, success=success):
                api, reads, frees, keepalive = self.fake_credential_api(blob, size, success)
                with self.assertRaises(credential.CredentialUnavailable): credential.load(api)
                self.assertEqual(reads, [("skill-nexus", 1, 0)])
                self.assertEqual(frees, [True] if success else [])

    def test_dry_run_windows_cli_mode_does_not_read_real_credentials(self):
        with patch.object(p, "shared_windows_credential", side_effect=AssertionError("must not access")):
            self.assertEqual(p.execute(self.m, state=self.root, credential=p.shared_windows_credential)["outcome"], "dry-run")


if __name__ == "__main__":
    unittest.main()
