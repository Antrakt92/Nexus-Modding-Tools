"""Check the shared credential through the approved validation API; never upload."""
import importlib.util
import json
from pathlib import Path
import publish

path = Path(__file__).resolve().parents[1] / 'nexus-cli/credential_setup.py'
spec = importlib.util.spec_from_file_location('nexus_credential_validation', path)
validation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validation)
try:
    status = validation.validate_key(publish.shared_windows_credential())
    print(json.dumps({'shared_credential_verified': True, 'upload_requested': False, **status}))
except Exception:
    print(json.dumps({'shared_credential_verified': False, 'upload_requested': False,
                      'error': 'Credential absent, rejected, or validation unavailable; inspect auth status.'}))
    raise SystemExit(2)
