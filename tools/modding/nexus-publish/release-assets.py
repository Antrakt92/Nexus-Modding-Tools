"""Download only named GitHub release assets for the inactive manual workflow template."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def main():
    try:
        tag = os.environ["RELEASE_TAG"]
        archive = os.environ["ARCHIVE_ASSET"]
        manifest_name = os.environ["MANIFEST_ASSET"]
        repo = os.environ["GH_REPO"]
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+/-]{0,127}", tag):
            raise ValueError()
        if not all(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,180}", n) for n in (archive, manifest_name)):
            raise ValueError()
        if not archive.lower().endswith(".zip") or not manifest_name.endswith(".json") or not re.fullmatch(r"[\w.-]+/[\w.-]+", repo):
            raise ValueError()
        destination = Path(os.environ["RUNNER_TEMP"]) / "nexus-publish-assets"
        # Reusing a workspace must not silently bind stale assets. Existing directory requires inspection.
        destination.mkdir(exist_ok=False)
        result = subprocess.run(["gh", "release", "download", tag, "--repo", repo, "--dir", str(destination),
                                 "--pattern", archive, "--pattern", manifest_name], capture_output=True, timeout=300)
        if result.returncode:
            raise ValueError()
        manifest = json.loads((destination / manifest_name).read_text(encoding="utf-8"))
        manifest["archive"] = str((destination / archive).resolve())
        # This is user metadata, never credentials. The runner rejects unsupported fields before use.
        from publish import preflight
        manifest = preflight(manifest)
        (destination / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        return 0
    except Exception:
        print("Release-asset preparation blocked; raw CLI/API output suppressed.", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
