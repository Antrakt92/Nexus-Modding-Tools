"""Cross-process modeled publication; never accesses a credential or a real API."""
import contextlib
import json
import os
from pathlib import Path
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import publish as p


def read(route, key):
    if route == "/v1/users/validate.json": return {"user_id": 42}
    if route == "/v1/games/examplegame/mods/12.json":
        return {"mod_id": 12, "domain_name": "examplegame", "user": {"member_id": 42}}
    return {"/games/examplegame/mods/12": {"id": "456", "game_scoped_id": "12"},
            "/mods/456/files": {"mod_files": [{"id": "123"}]},
            "/mod-files/123": {"id": "123"},
            "/mod-files/123/versions": {"versions": [{"version": "1.0"}]},
            "/mod-file-versions/987": {"id": "987", "file": {"id": "123"},
                                      "version": "1.2.3", "name": "fixture.zip", "category": "main"}}[route]


def invoke(*args):
    print("READY", flush=True)
    sys.stdin.readline()
    return {"ok": False, "version_id": "987"}


manifest = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
with patch.object(p, "verify_action", return_value="modeled-node"):
    lock = contextlib.nullcontext() if os.name == "nt" else patch.object(p, "frozen_archive", lambda _: contextlib.nullcontext())
    with lock:
        if sys.argv[2] == "execute":
            try:
                p.execute(manifest, publish=True, state=Path(sys.argv[3]), credential=lambda: "mock-secret-never-log", invoke=invoke, read=read)
            except p.Blocked:
                print("BLOCKED")
        else:
            try:
                p.reconcile(manifest, "mock-secret-never-log", state=Path(sys.argv[3]), version_id="987", read=read)
                print("RECONCILED")
            except p.Blocked:
                print("BLOCKED")
