"""Guarded local runner for the exact official Nexus upload-action bundle (stdlib only)."""
from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from contextlib import contextmanager
from urllib.request import Request, build_opener, HTTPRedirectHandler

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from workspace_paths import workspace_root, context_root, configured_path

PIN = "98532f7670c27cbecc78fae03fa3e278147827e2"
BUNDLE_SHA256 = "9144bb1ed9877ccdae3be52b4d57ec6813c2c300351e109aa68d023ac34e69af"
DEFAULT_ACTION = configured_path("NEXUS_UPLOAD_ACTION_ROOT", context_root() / "nexus-upload-action")
STATE = configured_path("NEXUS_STATE_DIR", workspace_root() / "local-state/nexus-publish-setup")
API = "https://api.nexusmods.com/v3"
HERE = Path(__file__).resolve().parent
ID_RE = re.compile(r"(?:[1-9][0-9]{0,19}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\Z")
ACTION_FIELDS = {"description", "display_name", "category", "archive_existing_version",
                 "primary_mod_manager_download", "allow_mod_manager_download",
                 "show_requirements_pop_up", "update_mod_version", "changelog"}
BOOL_FIELDS = {"archive_existing_version", "primary_mod_manager_download",
               "allow_mod_manager_download", "show_requirements_pop_up", "update_mod_version"}
REQUIRED = {"game", "mod_page_id", "mod_id", "file_id", "existing_file", "archive", "version", "sha256", "expected_user_id"}
RECEIPT_FIELDS = {"schema", "outcome", "uploaded", "action_pin", "time_utc", "game", "mod_page_id", "mod_id",
                  "file_id", "version", "sha256", "effective_display_name", "effective_category", "archive_bytes",
                  "version_id", "metadata_verified", "artifact_verified", "action_complete", "attempt_id",
                  "expected_user_id", "account_verified", "ownership_verified", "target_relationship_verified", "action_running"}
# ECMAScript String.trim whitespace used by the pinned @actions/core getInput().
JS_WHITESPACE = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


class Blocked(Exception):
    """Only fixed, non-secret error messages may cross the command boundary."""


def sha256(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def bundle_sha256(path):
    # Git for Windows may check out CRLF; accept only that deterministic text checkout conversion.
    return hashlib.sha256(Path(path).read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def valid_id(value):
    return isinstance(value, str) and bool(ID_RE.fullmatch(value))


def preflight(manifest):
    if not isinstance(manifest, dict) or set(manifest) - REQUIRED - ACTION_FIELDS or REQUIRED - set(manifest):
        raise Blocked("Manifest has missing or unsupported fields; keys and API overrides are forbidden.")
    if manifest["existing_file"] is not True:
        raise Blocked("Only a new version of an existing Nexus file is supported.")
    if not all(valid_id(manifest[k]) for k in ("mod_id", "file_id")):
        raise Blocked("mod_id and file_id must be positive decimal strings or canonical UUIDs (v3 IDs).")
    if not isinstance(manifest["mod_page_id"], str) or not re.fullmatch(r"[1-9][0-9]{0,19}", manifest["mod_page_id"]):
        raise Blocked("mod_page_id must be the positive game-scoped ID from the mod page URL.")
    if not isinstance(manifest["game"], str) or not re.fullmatch(r"[a-z0-9]{2,64}", manifest["game"]):
        raise Blocked("Invalid Nexus game domain.")
    if (not isinstance(manifest["expected_user_id"], str)
            or not re.fullmatch(r"[1-9][0-9]{0,15}", manifest["expected_user_id"])
            or int(manifest["expected_user_id"]) > 2**53 - 1):
        raise Blocked("expected_user_id must be the approved positive decimal Nexus account ID.")
    if not isinstance(manifest["version"], str) or not re.fullmatch(r"[A-Za-z0-9.\-]{1,50}", manifest["version"]):
        raise Blocked("Version must contain 1-50 ASCII letters, digits, periods or hyphens.")
    if not isinstance(manifest["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", manifest["sha256"]):
        raise Blocked("Expected SHA256 must be 64 lowercase hex characters.")
    if not isinstance(manifest["archive"], str):
        raise Blocked("Archive must be an absolute ZIP path.")
    archive = Path(manifest["archive"])
    if not archive.is_absolute() or archive.suffix.lower() != ".zip" or not archive.is_file() or archive.is_symlink():
        raise Blocked("Archive must be an existing absolute regular ZIP file, not a symlink.")
    if archive.stat().st_size == 0 or sha256(archive) != manifest["sha256"]:
        raise Blocked("Archive is empty or does not match expected SHA256.")
    # Validate container integrity without extracting or inspecting payload source.
    import zipfile
    try:
        with zipfile.ZipFile(archive) as z:
            if not z.infolist() or z.testzip() is not None:
                raise Blocked("ZIP is empty or fails CRC verification.")
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError):
        raise Blocked("ZIP integrity validation failed.") from None
    for key in BOOL_FIELDS & set(manifest):
        if type(manifest[key]) is not bool:
            raise Blocked("Action boolean options must be JSON booleans.")
    for key in (ACTION_FIELDS - BOOL_FIELDS) & set(manifest):
        value = manifest[key]
        if not isinstance(value, str) or len(value) > 20000 or any(ord(c) < 32 and c not in "\r\n\t" for c in value):
            raise Blocked("Invalid action text metadata.")
        if value != value.strip(JS_WHITESPACE):
            raise Blocked("Action text options must not contain leading/trailing ECMAScript whitespace.")
    if manifest["archive"] != manifest["archive"].strip(JS_WHITESPACE):
        raise Blocked("Archive path must not be altered by action input trimming.")
    if (manifest.get("category") or "main") not in {"main", "optional", "miscellaneous"}:
        raise Blocked("Unsupported new-file category.")
    result = {**manifest, "archive": str(archive.resolve())}
    if not re.fullmatch(r"[A-Za-z0-9 _'().\-]{1,50}", effective_display_name(result)):
        raise Blocked("Effective display name must contain 1-50 ASCII letters, digits, spaces or _'().-.")
    return result


def effective_display_name(manifest):
    # Same getInput().trim() || path.basename(filename) semantics as the official action.
    return manifest.get("display_name", "").strip(JS_WHITESPACE) or Path(manifest["archive"]).name


def verify_action(action):
    try:
        head = subprocess.run(["git", "-C", str(action), "rev-parse", "HEAD"],
                              capture_output=True, check=True, text=True).stdout.strip()
        node = shutil.which("node")
        version = subprocess.run([node or "node", "--version"], capture_output=True,
                                  check=True, text=True).stdout.strip()
        undici = subprocess.run([node or "node", "-p", "process.versions.undici"], capture_output=True,
                                check=True, text=True).stdout.strip()
        if head != PIN or bundle_sha256(action / "dist/index.js") != BUNDLE_SHA256:
            raise Blocked("Official action pin or bundle hash mismatch.")
        if int(version.lstrip("v").split(".")[0]) != 24:
            raise Blocked("Use Node 24 for this pinned action.")
        transport = tuple(int(part) for part in undici.split("."))
        if len(transport) != 3 or transport[0] != 7 or transport < (7, 18, 2):
            raise Blocked("Use reviewed Node 24 with built-in Undici 7.18.2 or later in the 7.x line.")
    except (OSError, subprocess.SubprocessError, ValueError):
        raise Blocked("Pinned action checkout and Node 24 are required.") from None
    return node


def child_environment(manifest, key):
    # Do not inherit NODE_OPTIONS, API overrides, debug flags, GITHUB_OUTPUT or unrelated secrets.
    env = {k: v for k, v in os.environ.items()
           if k.upper() in {"SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP", "HOME", "USERPROFILE"}}
    inputs = {k: manifest[k] for k in ACTION_FIELDS if k in manifest}
    inputs.update(file_id=manifest["file_id"], mod_id=manifest["mod_id"],
                  filename=manifest["archive"], version=manifest["version"], api_key=key)
    inputs.setdefault("archive_existing_version", False)
    inputs.setdefault("update_mod_version", False)
    for name, value in inputs.items():
        env["INPUT_" + name.upper()] = str(value).lower() if type(value) is bool else value
    env["NEXUS_ARCHIVE_BYTES"] = str(Path(manifest["archive"]).stat().st_size)
    env["NEXUS_PYTHON"] = sys.executable
    return env


def invoke_action(manifest, key, action, node):
    try:
        result = subprocess.run([node, str(HERE / "safe-action.mjs"), str(action / "dist/index.js")],
                                env=child_environment(manifest, key), capture_output=True,
                                timeout=2400, check=False)
        # Child stdout is a fixed-schema projection; never relay stdout/stderr or error text.
        if len(result.stdout) > 4096:
            return {"ok": False, "version_id": None}
        report = json.loads(result.stdout)
        version_id = report.get("version_id")
        return {"ok": result.returncode == 0 and report.get("ok") is True,
                "version_id": version_id if valid_id(version_id) else None}
    except (OSError, subprocess.SubprocessError, ValueError, TypeError, AttributeError):
        return {"ok": False, "version_id": None}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise Blocked("Readback redirect refused.")


def api_read(route, key):
    # Only GET readback; upload protocol is exclusively owned by the official action.
    try:
        legacy_account = route == "/v1/users/validate.json"
        legacy_mod = bool(re.fullmatch(r"/v1/games/[a-z0-9]{2,64}/mods/[1-9][0-9]{0,19}\.json", route))
        if route.startswith("/v1/") and not (legacy_account or legacy_mod):
            raise Blocked("Unsupported account or ownership read route.")
        url = "https://api.nexusmods.com" + route if legacy_account or legacy_mod else API + route
        request = Request(url, headers={"apikey": key, "User-Agent": "nexus-publish-preflight",
                                               "Accept": "application/json",
                                               "Application-Name": "Nexus-Agent-Publication",
                                               "Application-Version": "1.0"})
        with build_opener(NoRedirect()).open(request, timeout=30) as response:
            raw = response.read(2_000_001)
        if len(raw) > 2_000_000:
            raise Blocked("Readback response exceeded limit.")
        parsed = json.loads(raw)
        if legacy_account:
            # Validation responses include a key and personal information. Project ONLY this field.
            return {"user_id": parsed["user_id"]}
        if legacy_mod:
            return {"mod_id": parsed["mod_id"], "domain_name": parsed["domain_name"],
                    "user": {"member_id": parsed["user"]["member_id"]}}
        data = parsed["data"]
        if not isinstance(data, dict):
            raise Blocked("Invalid readback schema.")
        return data
    except Blocked:
        raise
    except Exception:
        # HTTP errors include server bodies/URLs; deliberately never expose their text.
        raise Blocked("Official API readback unavailable or malformed.") from None


def validate_relationship(manifest, key, read=api_read):
    try:
        # Mod-file GET returns aggregates, NOT an owning mod. Resolve the page's global v3 mod ID,
        # then prove membership via that mod's file list instead of inventing a response field.
        mod = read("/games/" + manifest["game"] + "/mods/" + manifest["mod_page_id"], key)
        files = read("/mods/" + manifest["mod_id"] + "/files", key)["mod_files"]
        target = read("/mod-files/" + manifest["file_id"], key)
        matches = (mod["id"] == manifest["mod_id"] and mod["game_scoped_id"] == manifest["mod_page_id"]
                   and target["id"] == manifest["file_id"] and isinstance(files, list)
                   and any(f["id"] == manifest["file_id"] for f in files))
        if not matches:
            raise Blocked("Existing file / mod / game relationship could not be verified.")
    except (KeyError, TypeError):
        raise Blocked("Invalid target relationship schema.") from None


def validate_account(manifest, key, read=api_read):
    # Official node-nexus-api da9b8eda... src/types.ts: IValidateKeyResponse and IModInfo/IUser.
    try:
        account = read("/v1/users/validate.json", key)["user_id"]
        mod = read("/v1/games/" + manifest["game"] + "/mods/" + manifest["mod_page_id"] + ".json", key)
        owner = mod["user"]["member_id"]
        if any(type(value) is not int or not 0 < value <= 2**53 - 1 for value in (account, owner, mod["mod_id"])):
            raise Blocked("Account/ownership identity schema unavailable.")
        if str(account) != manifest["expected_user_id"]:
            raise Blocked("Credential does not belong to the approved publishing account.")
        if str(mod["mod_id"]) != manifest["mod_page_id"] or mod["domain_name"] != manifest["game"]:
            raise Blocked("Ownership response identifies another target.")
        if owner != account:
            raise Blocked("Approved account is not the target uploader. Use the uploader's credential; team permission requires separately reviewed official permission evidence.")
    except (KeyError, TypeError):
        raise Blocked("Account/ownership identity schema unavailable; obtain exact uploader evidence before publication.") from None


def validate_target(manifest, key, read=api_read):
    validate_account(manifest, key, read)
    validate_relationship(manifest, key, read)
    try:
        versions = read("/mod-files/" + manifest["file_id"] + "/versions", key)["versions"]
        if not isinstance(versions, list) or not versions:
            raise Blocked("Existing file / mod / game relationship could not be verified.")
        if any(v["version"] == manifest["version"] for v in versions):
            raise Blocked("This version already exists; reconcile instead of uploading again.")
    except (KeyError, TypeError):
        raise Blocked("Invalid target or version-list schema.") from None


def readback(manifest, version_id, key, read=api_read):
    version = read("/mod-file-versions/" + version_id, key)
    try:
        return (version["id"] == version_id and version["file"]["id"] == manifest["file_id"]
                and version["version"] == manifest["version"]
                and version["name"] == effective_display_name(manifest)
                and version["category"] == (manifest.get("category") or "main"))
    except (KeyError, TypeError):
        return False


def receipt_path(manifest, state):
    # Key excludes archive/hash so changing bytes cannot bypass uncertain publication state.
    identity = json.dumps([manifest["game"], manifest["mod_id"], manifest["file_id"], manifest["version"]])
    return state / "receipts" / (hashlib.sha256(identity.encode()).hexdigest() + ".json")


def ledger_root(state):
    state = Path(state)
    if not state.is_absolute():
        raise Blocked("Publication ledger requires an absolute persistent path; relative paths depend on the working directory.")
    return state


def target_lock_path(manifest, state):
    identity = json.dumps([manifest["game"], manifest["mod_id"], manifest["file_id"]])
    return state / "locks" / (hashlib.sha256(identity.encode()).hexdigest() + ".json")


def record(manifest, outcome):
    return {"schema": 2, "outcome": outcome, "uploaded": False if outcome == "dry-run" else None, "action_pin": PIN,
            "time_utc": datetime.now(timezone.utc).isoformat(),
            "game": manifest["game"], "mod_page_id": manifest["mod_page_id"],
            "mod_id": manifest["mod_id"], "file_id": manifest["file_id"],
            "version": manifest["version"], "sha256": manifest["sha256"],
            "effective_display_name": effective_display_name(manifest),
            "effective_category": manifest.get("category") or "main",
            "archive_bytes": Path(manifest["archive"]).stat().st_size,
            "version_id": None, "metadata_verified": False, "artifact_verified": False,
            "action_complete": False, "attempt_id": None if outcome == "dry-run" else uuid.uuid4().hex,
            "expected_user_id": manifest["expected_user_id"], "account_verified": False,
            "ownership_verified": False, "target_relationship_verified": False, "action_running": False}


@contextmanager
def operation_lock(manifest, state):
    # Never unlink this inode: unlinking an OS-held lock lets other processes lock a different inode.
    path = state / "operation-locks" / target_lock_path(manifest, state).with_suffix(".lck").name
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as stream:
        if stream.seek(0, os.SEEK_END) == 0:
            stream.write(b"\0")
            stream.flush()
            os.fsync(stream.fileno())
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise Blocked("Another publication or reconciliation is running for this target.") from None
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def load_receipt(path, manifest):
    try:
        with path.open("rb") as stream:
            raw = stream.read(65537)
        if len(raw) > 65536:
            raise Blocked("Receipt exceeded its schema limit.")
        def unique_object(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError("Duplicate receipt field")
                result[key] = value
            return result
        data = json.loads(raw, object_pairs_hook=unique_object)
        if not isinstance(data, dict):
            raise Blocked("Receipt schema unavailable; blind retry remains forbidden.")
        if data.get("schema") == 1:
            raise Blocked("Legacy receipt: automatic migration/lock clearing refused. Independently review stopped uploader, intended account and original artifact evidence before a deliberate ledger migration.")
        if type(data.get("schema")) is not int or data["schema"] != 2 or set(data) != RECEIPT_FIELDS:
            raise Blocked("Receipt schema unavailable; blind retry remains forbidden.")
        for field in ("game", "mod_page_id", "mod_id", "file_id", "version", "sha256", "expected_user_id"):
            if data[field] != manifest[field]:
                raise Blocked("Receipt identity does not match this manifest.")
        if (data["effective_display_name"] != effective_display_name(manifest)
                or data["effective_category"] != (manifest.get("category") or "main")):
            raise Blocked("Receipt effective metadata does not match this manifest.")
        if (data["action_pin"] != PIN or type(data["archive_bytes"]) is not int
                or data["archive_bytes"] != Path(manifest["archive"]).stat().st_size
                or not isinstance(data["attempt_id"], str) or not re.fullmatch(r"[0-9a-f]{32}", data["attempt_id"])):
            raise Blocked("Receipt artifact/pin/attempt identity mismatch.")
        if not isinstance(data["time_utc"], str) or datetime.fromisoformat(data["time_utc"]).utcoffset() is None:
            raise Blocked("Receipt timestamp unavailable.")
        if data["outcome"] not in {"attempt", "unknown", "done"} or data["version_id"] is not None and not valid_id(data["version_id"]):
            raise Blocked("Receipt outcome unavailable.")
        for field in ("metadata_verified", "artifact_verified", "action_complete", "account_verified", "ownership_verified", "target_relationship_verified", "action_running"):
            if type(data[field]) is not bool:
                raise Blocked("Receipt flags malformed.")
        if not all(data[field] for field in ("account_verified", "ownership_verified", "target_relationship_verified")) or data["artifact_verified"]:
            raise Blocked("Receipt verification evidence malformed.")
        done = data["outcome"] == "done"
        if (data["uploaded"] is not (True if done else None) or data["metadata_verified"] is not done
                or done and (data["action_running"] or not valid_id(data["version_id"]))):
            raise Blocked("Receipt outcome/verification flags inconsistent.")
        return data
    except (OSError, ValueError, KeyError, TypeError, RecursionError):
        raise Blocked("Receipt unavailable or malformed; blind retry remains forbidden.") from None


def update_owned(path, data, manifest):
    if load_receipt(path, manifest)["attempt_id"] != data["attempt_id"]:
        raise Blocked("Attempt ownership changed; ledger mutation refused.")
    write_receipt(path, data)


def unlink_owned(path, data, manifest):
    if load_receipt(path, manifest)["attempt_id"] != data["attempt_id"]:
        raise Blocked("Attempt ownership changed; lock clearing refused.")
    path.unlink()


def write_receipt(path, data, exclusive=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    if exclusive:
        with path.open("x", encoding="utf-8") as stream:
            json.dump(data, stream, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
    else:
        temp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
        with temp.open("x", encoding="utf-8") as stream:
            json.dump(data, stream, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)


@contextmanager
def frozen_archive(path):
    if os.name != "nt":
        raise Blocked("Publication runner requires Windows archive sharing locks.")
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    create = kernel.CreateFileW
    create.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                       wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    create.restype = wintypes.HANDLE
    close = kernel.CloseHandle
    close.argtypes = [wintypes.HANDLE]
    close.restype = wintypes.BOOL
    # Share reads only: action can open the file, but concurrent writes/deletes are refused.
    handle = create(str(path), 0x80000000, 1, None, 3, 0x80, None)
    if handle == ctypes.c_void_p(-1).value:
        raise Blocked("Cannot acquire a read-only archive lock; freeze other writers first.")
    try:
        yield
    finally:
        close(handle)


def execute(manifest, *, publish=False, state=STATE, action=DEFAULT_ACTION,
            credential=None, invoke=invoke_action, read=api_read):
    state = ledger_root(state)
    manifest = preflight(manifest)
    path = receipt_path(manifest, state)
    if not publish:
        data = record(manifest, "dry-run")
        data["target_relationship_verified"] = False
        dry = state / "dry-runs" / (uuid.uuid4().hex + ".json")
        write_receipt(dry, data, exclusive=True)
        return data
    with operation_lock(manifest, state):
        return execute_locked(manifest, path, state, action, credential, invoke, read)


def execute_locked(manifest, path, state, action, credential, invoke, read):
    if path.exists():
        raise Blocked("An attempt/done/unknown receipt already exists. Blind retry refused; reconcile read-only.")
    lock = target_lock_path(manifest, state)
    if lock.exists():
        raise Blocked("This target has an unresolved or concurrent attempt, including another version. Reconcile first.")
    node = verify_action(action)
    if credential is None:
        raise Blocked("No approved credential source configured.")
    key = credential()
    if (not isinstance(key, str) or not key or key != key.strip(JS_WHITESPACE)
            or any(ord(c) < 32 for c in key)):
        raise Blocked("Credential unavailable or invalid.")
    validate_target(manifest, key, read)
    with frozen_archive(manifest["archive"]):
        if sha256(manifest["archive"]) != manifest["sha256"]:
            raise Blocked("Archive changed since preflight.")
        data = record(manifest, "attempt")
        data.update(account_verified=True, ownership_verified=True, target_relationship_verified=True,
                    action_running=True)
        try:
            write_receipt(lock, data, exclusive=True)
            write_receipt(path, data, exclusive=True)
        except FileExistsError:
            raise Blocked("Concurrent attempt detected; retry refused.") from None
        try:
            report = invoke(manifest, key, action, node)
            data["action_running"] = False
            data["action_complete"] = report.get("ok") is True
            data["version_id"] = report.get("version_id") if valid_id(report.get("version_id")) else None
            data["outcome"] = "unknown"
            # Keep a discovered ID durable BEFORE readback can fail or the process can be interrupted.
            update_owned(path, data, manifest)
            update_owned(lock, data, manifest)
            if report.get("ok") and data["version_id"] and readback(manifest, data["version_id"], key, read):
                data.update(outcome="done", uploaded=True, metadata_verified=True)
        except (Exception, KeyboardInterrupt):
            data.update(outcome="unknown", uploaded=None, metadata_verified=False)
        finally:
            key = None
            # Only a returned invocation establishes termination. An interrupted
            # invocation can leave its child alive after the parent releases the OS lock.
            update_owned(path, data, manifest)
            update_owned(lock, data, manifest)
            if data["outcome"] == "done":
                unlink_owned(lock, data, manifest)
    return data


def reconcile(manifest, key=None, *, state=STATE, version_id=None, read=api_read, credential=None):
    state = ledger_root(state)
    manifest = preflight(manifest)
    with operation_lock(manifest, state):
        return reconcile_locked(manifest, key, state, version_id, read, credential)


def reconcile_locked(manifest, key, state, version_id, read, credential):
    path = receipt_path(manifest, state)
    try:
        data = load_receipt(path, manifest)
        lock = target_lock_path(manifest, state)
        if data["action_running"]:
            raise Blocked("Interrupted running attempt: independently establish uploader termination before deliberate ledger recovery; automatic lock clearing refused.")
        if lock.exists():
            locked = load_receipt(lock, manifest)
            if locked["attempt_id"] != data["attempt_id"]:
                raise Blocked("Attempt ownership changed; reconciliation refused.")
            if locked["action_running"]:
                raise Blocked("Interrupted running attempt: automatic lock clearing refused.")
        elif data["outcome"] != "done":
            raise Blocked("Unresolved receipt has no matching durable lock; investigate ledger integrity.")
        identifier = version_id or data.get("version_id")
        if not valid_id(identifier):
            raise Blocked("Supply an independently identified v3 version ID; no upload retry is available.")
        if key is None:
            if credential is None:
                raise Blocked("Reconciliation requires an approved credential source.")
            key = credential()
        if (not isinstance(key, str) or not key or key != key.strip(JS_WHITESPACE)
                or any(ord(c) < 32 for c in key)):
            raise Blocked("Credential unavailable or invalid.")
        validate_account(manifest, key, read)
        validate_relationship(manifest, key, read)
        if not readback(manifest, identifier, key, read):
            raise Blocked("Reconciliation metadata mismatch.")
        data.update(version_id=identifier, outcome="done", uploaded=True, metadata_verified=True,
                    effective_display_name=effective_display_name(manifest), effective_category=manifest.get("category") or "main")
        # Reconciliation proves publication metadata, not a failed optional changelog or remote bytes.
        update_owned(path, data, manifest)
        if lock.exists():
            update_owned(lock, data, manifest)
            unlink_owned(lock, data, manifest)
        return data
    except (OSError, ValueError, KeyError, TypeError):
        raise Blocked("Receipt unavailable or malformed; blind retry remains forbidden.") from None


def hidden_prompt():
    if not sys.stdin.isatty():
        raise Blocked("Key prompt requires an interactive terminal; no plaintext/stdin fallback.")
    return getpass.getpass("Nexus API key (memory only): ")


def shared_windows_credential():
    import importlib.util
    spec = importlib.util.spec_from_file_location("nexus_shared_credential", HERE / "windows-credential.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    try:
        return module.load()
    except module.CredentialUnavailable:
        raise Blocked("Shared skill-nexus credential unavailable or invalid; configure via nexusmods auth set or use --credential prompt.") from None


def workflow_secret():
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise Blocked("GitHub secret source is only available in an explicitly configured workflow.")
    key = os.environ.pop("NEXUS_PUBLISH_KEY", None)
    if not key:
        raise Blocked("Workflow Nexus API secret is unavailable.")
    return key


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--publish", action="store_true", help="External effect; future explicit publication only")
    mode.add_argument("--reconcile", action="store_true", help="GET-only verification of an existing attempt")
    parser.add_argument("--version-id", help="Independently identified v3 ID for GET-only reconciliation")
    parser.add_argument("--credential", choices=["prompt", "windows-cli", "github-secret"], help="Memory-only credential source")
    parser.add_argument("--action-dir", type=Path, default=DEFAULT_ACTION)
    parser.add_argument("--state-dir", type=Path, default=STATE, help="Persistent ledger; do not change to bypass a receipt")
    args = parser.parse_args()
    try:
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
        credential = {"prompt": hidden_prompt, "windows-cli": shared_windows_credential, "github-secret": workflow_secret}.get(args.credential)
        if args.reconcile:
            if credential is None:
                raise Blocked("Reconciliation requires an approved credential source.")
            result = reconcile(manifest, credential=credential, state=args.state_dir, version_id=args.version_id)
        else:
            result = execute(manifest, publish=args.publish, action=args.action_dir, state=args.state_dir,
                             credential=credential)
        print(json.dumps(result, indent=2))
        return 2 if result["outcome"] == "unknown" else 0
    except Blocked as error:
        print(str(error), file=sys.stderr)
        return 2
    except (Exception, KeyboardInterrupt):
        print("Runner stopped; inspect the receipt. Raw exception details suppressed.", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
