"""Explicit clipboard-to-Credential-Manager setup; no plaintext arguments/logs/files."""
import argparse
import ctypes
from ctypes import wintypes
import json
import os
import re
import urllib.error
import urllib.request

TARGET = 'skill-nexus'
VALIDATE_URL = 'https://api.nexusmods.com/v1/users/validate.json'

class SetupError(Exception):
    pass

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise SetupError('API_REDIRECT_REFUSED')

def normalize_key(text):
    value = text.strip()
    # The Nexus page's warning can be copied together with its encrypted personal
    # key. Accept exactly one distinctive three-part token, never arbitrary prose.
    if not re.fullmatch(r'[A-Za-z0-9+/=_\-]{40,1024}', value):
        candidates = re.findall(r'(?<![A-Za-z0-9+/=_\-])([A-Za-z0-9+/]+={0,2}--[A-Za-z0-9+/]+={0,2}--[A-Za-z0-9+/]+={0,2})(?![A-Za-z0-9+/=_\-])', value)
        if len(candidates) == 1:
            value = candidates[0]
    if not re.fullmatch(r'[A-Za-z0-9+/=_\-]{40,1024}', value):
        raise SetupError('CLIPBOARD_NOT_AN_API_KEY_COPY_ONLY_THE_KEY')
    return value

def clipboard_key():
    if os.name != 'nt':
        raise SetupError('WINDOWS_REQUIRED')
    user = ctypes.WinDLL('user32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    user.GetClipboardData.argtypes = [wintypes.UINT]
    user.GetClipboardData.restype = wintypes.HANDLE
    kernel.GlobalLock.argtypes = [wintypes.HANDLE]
    kernel.GlobalLock.restype = ctypes.c_void_p
    kernel.GlobalSize.argtypes = [wintypes.HANDLE]
    kernel.GlobalSize.restype = ctypes.c_size_t
    kernel.GlobalUnlock.argtypes = [wintypes.HANDLE]
    if not user.OpenClipboard(None):
        raise SetupError('CLIPBOARD_BUSY')
    try:
        handle = user.GetClipboardData(13)  # CF_UNICODETEXT
        if not handle:
            raise SetupError('CLIPBOARD_HAS_NO_TEXT')
        size = kernel.GlobalSize(handle)
        if size < 2 or size > 4096 or size % 2:
            raise SetupError('CLIPBOARD_NOT_AN_API_KEY_COPY_ONLY_THE_KEY')
        pointer = kernel.GlobalLock(handle)
        if not pointer:
            raise SetupError('CLIPBOARD_UNAVAILABLE')
        try:
            raw = ctypes.string_at(pointer, size)
            text = raw.decode('utf-16-le').split('\0', 1)[0]
            return normalize_key(text)
        except UnicodeError:
            raise SetupError('CLIPBOARD_INVALID_TEXT') from None
        finally:
            kernel.GlobalUnlock(handle)
    finally:
        user.CloseClipboard()

def validate_key(key, opener=None):
    opener = opener or urllib.request.build_opener(NoRedirect())
    request = urllib.request.Request(VALIDATE_URL, headers={
        'Accept': 'application/json', 'apikey': key,
        'Application-Name': 'Nexus-Agent-Local', 'Application-Version': '1.0',
        'User-Agent': 'Nexus-Agent-Local/1.0',
    })
    try:
        with opener.open(request, timeout=30) as response:
            if response.geturl() != VALIDATE_URL:
                raise SetupError('API_REDIRECT_REFUSED')
            body = response.read(65537)
        if len(body) > 65536:
            raise SetupError('API_RESPONSE_TOO_LARGE')
        data = json.loads(body)
        if not isinstance(data, dict) or not isinstance(data.get('is_premium'), bool):
            raise SetupError('API_VALIDATION_SHAPE_INVALID')
        return {'validated': True, 'premium': data['is_premium']}
    except urllib.error.HTTPError as error:
        raise SetupError('API_KEY_REJECTED' if error.code in (401, 403) else 'API_VALIDATION_HTTP_FAILURE') from None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        raise SetupError('API_VALIDATION_UNAVAILABLE') from None

class Credential(ctypes.Structure):
    _fields_ = [
        ('Flags', wintypes.DWORD), ('Type', wintypes.DWORD),
        ('TargetName', wintypes.LPWSTR), ('Comment', wintypes.LPWSTR),
        ('LastWritten', wintypes.FILETIME), ('CredentialBlobSize', wintypes.DWORD),
        ('CredentialBlob', ctypes.POINTER(ctypes.c_ubyte)), ('Persist', wintypes.DWORD),
        ('AttributeCount', wintypes.DWORD), ('Attributes', ctypes.c_void_p),
        ('TargetAlias', wintypes.LPWSTR), ('UserName', wintypes.LPWSTR),
    ]

def store_key(key):
    if os.name != 'nt':
        raise SetupError('WINDOWS_REQUIRED')
    library = ctypes.WinDLL('Advapi32', use_last_error=True)
    library.CredWriteW.argtypes = [ctypes.POINTER(Credential), wintypes.DWORD]
    library.CredWriteW.restype = wintypes.BOOL
    encoded = bytearray(key.encode('utf-16-le'))
    blob = (ctypes.c_ubyte * len(encoded)).from_buffer(encoded)
    credential = Credential(Type=1, TargetName=TARGET, Comment='Nexus Mods personal API key',
                            CredentialBlobSize=len(encoded), CredentialBlob=blob,
                            Persist=2, UserName='default')
    try:
        if not library.CredWriteW(ctypes.byref(credential), 0):
            raise SetupError('CREDENTIAL_MANAGER_WRITE_FAILED')
    finally:
        ctypes.memset(ctypes.addressof(blob), 0, len(encoded))

def setup(reader=clipboard_key, validator=validate_key, writer=store_key):
    key = reader()
    status = validator(key)
    writer(key)
    return {'configured': True, 'source': 'windows-credential-manager', **status}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--from-clipboard', action='store_true', required=True,
                        help='Read only the key intentionally copied into the Windows clipboard')
    parser.parse_args()
    try:
        print(json.dumps(setup()))
    except SetupError as error:
        print(json.dumps({'configured': False, 'error': str(error)}))
        raise SystemExit(2)
    except Exception:
        print(json.dumps({'configured': False, 'error': 'CREDENTIAL_SETUP_FAILED'}))
        raise SystemExit(2)
