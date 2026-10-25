import json
from pathlib import Path
import subprocess
import sys
import uuid
import unittest
from unittest.mock import patch

import test_publish as base
p = base.p


class RepairTests(unittest.TestCase):
    setUp = base.RunnerTests.setUp
    tearDown = base.RunnerTests.tearDown
    read = base.RunnerTests.read
    execute = base.RunnerTests.execute

    def test_creation_schema_rejects_invalid_before_key_or_action(self):
        for change in [{"version": "1_2"}, {"version": "1.2+build"}, {"version": "A" * 51},
                       {"display_name": "A" * 51}, {"display_name": "Invalid: name"},
                       {"display_name": "\u0085name\u0085"}, {"category": "update"}]:
            with self.subTest(field=next(iter(change))), self.assertRaises(p.Blocked):
                p.execute({**self.m, **change}, state=self.root,
                          credential=lambda: self.fail("key accessed"), invoke=lambda *a: self.fail("action invoked"))

    def test_account_is_bound_and_non_owner_blocks(self):
        self.m["expected_user_id"] = "42"
        def wrong(route, key):
            if route == "/v1/users/validate.json": return {"user_id": 42, "key": "must-not-escape"}
            if route.startswith("/v1/games/"):
                return {"mod_id": 12, "domain_name": "examplegame", "user": {"member_id": 99}}
            return self.read(route, key)
        with self.assertRaises(p.Blocked):
            p.validate_target(self.m, "mock-secret-never-log", wrong)

    def worker(self, mode):
        return [sys.executable, "-B", str(Path(__file__).with_name("lock-worker.py")),
                str(self.root / "manifest.json"), mode, str(self.root)]

    def start_worker(self):
        (self.root / "manifest.json").write_text(json.dumps(self.m), encoding="utf-8")
        child = subprocess.Popen(self.worker("execute"), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: child.kill() if child.poll() is None else None)
        self.assertEqual(child.stdout.readline().strip(), "READY")
        return child

    def test_real_process_reconciliation_cannot_unlock_running_action(self):
        child = self.start_worker()
        try:
            result = subprocess.run(self.worker("reconcile"), capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout.strip(), "BLOCKED")
            self.assertTrue(p.target_lock_path(self.m, self.root).exists())
        finally:
            child.communicate("finish\n", timeout=10)

    def test_real_process_crash_preserves_durable_uncertainty(self):
        child = self.start_worker()
        child.kill()
        child.communicate(timeout=10)
        self.assertTrue(p.target_lock_path(self.m, self.root).exists())
        with p.operation_lock(self.m, self.root):
            pass  # OS released the dead process's lock; durable uncertainty still blocks below.
        with patch.object(p, "verify_action", return_value="modeled-node"), self.assertRaises(p.Blocked):
            p.execute({**self.m, "version": "2.0"}, publish=True, state=self.root,
                      credential=lambda: self.fail("key accessed"), invoke=lambda *a: self.fail("action invoked"))
        result = subprocess.run(self.worker("reconcile"), capture_output=True, text=True, timeout=10)
        self.assertEqual(result.stdout.strip(), "BLOCKED")

    def test_real_process_publish_competitor_blocks_and_finished_action_reconciles(self):
        child = self.start_worker()
        try:
            competitor = subprocess.run(self.worker("execute"), capture_output=True, text=True, timeout=10)
            self.assertEqual(competitor.stdout.strip(), "BLOCKED")
        finally:
            child.communicate("finish\n", timeout=10)
        result = subprocess.run(self.worker("reconcile"), capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), "RECONCILED")
        self.assertFalse(p.target_lock_path(self.m, self.root).exists())
        self.assertTrue((self.root / "operation-locks").is_dir())

    def test_receipt_owner_comparison_preserves_changed_lock_and_receipt(self):
        self.execute({"ok": False, "version_id": "987"})
        path = p.receipt_path(self.m, self.root)
        lock = p.target_lock_path(self.m, self.root)
        original = p.load_receipt(path, self.m)
        changed = {**original, "attempt_id": uuid.uuid4().hex}
        p.write_receipt(lock, changed)
        with self.assertRaises(p.Blocked): p.unlink_owned(lock, original, self.m)
        with self.assertRaises(p.Blocked): p.update_owned(lock, original, self.m)
        with self.assertRaises(p.Blocked): p.reconcile(self.m, "mock-secret-never-log", state=self.root, read=self.read)
        self.assertEqual(p.load_receipt(lock, self.m), changed)
        self.assertEqual(p.load_receipt(path, self.m), original)

    def test_receipt_schema_identity_flags_and_legacy_fail_closed(self):
        self.execute({"ok": False, "version_id": "987"})
        path = p.receipt_path(self.m, self.root)
        original = p.load_receipt(path, self.m)
        for change in [{"schema": 1}, {"schema": True}, {"expected_user_id": "99"}, {"mod_page_id": "13"},
                       {"attempt_id": "invalid"}, {"archive_bytes": True}, {"account_verified": False},
                       {"action_running": "false"}, {"metadata_verified": True}, {"uploaded": False},
                       {"artifact_verified": True}, {"unexpected": "field"}, {"time_utc": "bad"}]:
            with self.subTest(field=next(iter(change))):
                p.write_receipt(path, {**original, **change})
                with self.assertRaises(p.Blocked): p.load_receipt(path, self.m)
        p.write_receipt(path, original)
        p.target_lock_path(self.m, self.root).unlink()  # Synthetic corruption only.
        with self.assertRaises(p.Blocked): p.reconcile(self.m, "mock-secret-never-log", state=self.root, read=self.read)

    def test_reconcile_invalid_manifest_legacy_and_running_marker_never_read_key(self):
        with self.assertRaises(p.Blocked):
            p.reconcile({**self.m, "version": "bad+version"}, state=self.root,
                        credential=lambda: self.fail("key accessed"))
        self.execute({"ok": False, "version_id": "987"})
        path = p.receipt_path(self.m, self.root)
        original = p.load_receipt(path, self.m)
        for change in ({"schema": 1}, {"action_running": True}):
            p.write_receipt(path, {**original, **change})
            with self.assertRaises(p.Blocked):
                p.reconcile(self.m, state=self.root, credential=lambda: self.fail("key accessed"))
        path.write_text('{"schema":', encoding="utf-8")
        with self.assertRaises(p.Blocked):
            p.reconcile(self.m, state=self.root, credential=lambda: self.fail("key accessed"))
        path.write_text('{"schema":2,"schema":2}', encoding="utf-8")
        with self.assertRaises(p.Blocked): p.load_receipt(path, self.m)

    def test_cancellation_preserves_unknown_owner_and_releases_only_os_lock(self):
        with patch.object(p, "verify_action", return_value="modeled-node"):
            def cancel(*args): raise KeyboardInterrupt()
            result = p.execute(self.m, publish=True, state=self.root, credential=lambda: "mock-secret-never-log",
                               invoke=cancel, read=self.read)
        self.assertEqual(result["outcome"], "unknown")
        self.assertIsNone(result["uploaded"])
        self.assertFalse(result["action_running"])
        self.assertEqual(p.load_receipt(p.target_lock_path(self.m, self.root), self.m)["attempt_id"], result["attempt_id"])
        with p.operation_lock(self.m, self.root):
            with self.assertRaises(p.Blocked):
                with p.operation_lock(self.m, self.root): self.fail("nested operation acquired")

    def test_account_wrong_identity_missing_owner_types_and_target_fail_closed(self):
        for account, owner, mod_id, domain in [(99, 42, 12, "examplegame"), (42, None, 12, "examplegame"),
                                               (True, 42, 12, "examplegame"), ("42", 42, 12, "examplegame"),
                                               (42, "42", 12, "examplegame"), (42, 42, 13, "examplegame"),
                                               (42, 42, 12, "othergame")]:
            def read(route, key):
                if route == "/v1/users/validate.json": return {"user_id": account}
                return {"mod_id": mod_id, "domain_name": domain, "user": {"member_id": owner}}
            with self.subTest(account_type=type(account).__name__, owner_type=type(owner).__name__), self.assertRaises(p.Blocked):
                p.validate_account(self.m, "mock-secret-never-log", read)

    def test_basename_fallback_and_schema_boundaries(self):
        for field, value in [("version", "A" * 50), ("display_name", "A" * 50), ("display_name", "Named _'().- version")]:
            self.assertEqual(p.preflight({**self.m, field: value})[field], value)
        invalid = self.root / "invalid+name.zip"
        invalid.write_bytes(self.archive.read_bytes())
        with self.assertRaises(p.Blocked): p.preflight({**self.m, "archive": str(invalid)})
        p.preflight({**self.m, "archive": str(invalid), "display_name": "Valid name"})

    def test_legacy_account_response_is_projected_without_key_or_personal_info(self):
        import io
        from contextlib import closing
        from types import SimpleNamespace
        account = {"user_id": 42, "key": "never-escape", "name": "private", "email": "private"}
        with patch.object(p, "build_opener", return_value=SimpleNamespace(open=lambda *a, **kw: closing(io.BytesIO(json.dumps(account).encode())))):
            self.assertEqual(p.api_read("/v1/users/validate.json", "synthetic"), {"user_id": 42})

    def test_atomic_replace_failure_preserves_original_receipt(self):
        self.execute({"ok": False, "version_id": "987"})
        path = p.receipt_path(self.m, self.root)
        original = path.read_bytes()
        with patch.object(p.os, "replace", side_effect=OSError("modeled failure")), self.assertRaises(OSError):
            p.write_receipt(path, {"different": "data"})
        self.assertEqual(path.read_bytes(), original)

    def test_real_bundle_geometry_and_completion_errors_stop_before_finalise(self):
        for case in ("bad-geometry", "completion-error"):
            with self.subTest(case=case):
                result, report = base.RunnerTests.mocked_bundle(self, self.m, case)
                self.assertEqual(result.returncode, 1)  # 73 signals unintended storage/finalise in mock.
                self.assertFalse(report["ok"])
                self.assertIsNone(report["version_id"])

    def test_readback_interruption_preserves_discovered_version_before_reconciliation(self):
        def interrupted(route, key):
            if route.startswith("/mod-file-versions/"): raise KeyboardInterrupt()
            return self.read(route, key)
        with patch.object(p, "verify_action", return_value="modeled-node"):
            result = p.execute(self.m, publish=True, state=self.root, credential=lambda: "mock-secret-never-log",
                               invoke=lambda *a: {"ok": True, "version_id": "987"}, read=interrupted)
        self.assertEqual(result["outcome"], "unknown")
        self.assertEqual(p.load_receipt(p.receipt_path(self.m, self.root), self.m)["version_id"], "987")
        self.assertTrue(p.target_lock_path(self.m, self.root).exists())
        reconciled = p.reconcile(self.m, "mock-secret-never-log", state=self.root, read=self.read)
        self.assertEqual(reconciled["outcome"], "done")


if __name__ == "__main__": unittest.main()
