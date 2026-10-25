"""Opt-in, exact-target CredReadW compatibility with source-pinned nexusmods-cli.

No enumeration, writes, CLI subprocesses, account probes or standalone key output.
"""
import ctypes
from ctypes import wintypes
import os

CLI_PIN = "494f061e9f277414c4df306826b4d92cd1e6b90c"
TARGET = "skill-nexus"


class Credential(ctypes.Structure):
    _fields_ = [("Flags", wintypes.DWORD), ("Type", wintypes.DWORD),
                ("TargetName", wintypes.LPWSTR), ("Comment", wintypes.LPWSTR),
                ("LastWritten", wintypes.FILETIME), ("CredentialBlobSize", wintypes.DWORD),
                ("CredentialBlob", ctypes.c_void_p), ("Persist", wintypes.DWORD),
                ("AttributeCount", wintypes.DWORD), ("Attributes", ctypes.c_void_p),
                ("TargetAlias", wintypes.LPWSTR), ("UserName", wintypes.LPWSTR)]


class CredentialUnavailable(Exception):
    pass


def load(api=None):
    if os.name != "nt":
        raise CredentialUnavailable("Windows Credential Manager is required.")
    if api is None:
        api = ctypes.WinDLL("Advapi32.dll", use_last_error=True)
    read, free = api.CredReadW, api.CredFree
    read.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(ctypes.POINTER(Credential))]
    read.restype = wintypes.BOOL
    free.argtypes = [ctypes.c_void_p]
    free.restype = None
    pointer = ctypes.POINTER(Credential)()
    if not read(TARGET, 1, 0, ctypes.byref(pointer)):
        raise CredentialUnavailable("Shared Nexus credential unavailable; configure it with nexusmods auth set or use the hidden prompt.")
    try:
        item = pointer.contents
        size = item.CredentialBlobSize
        if not item.CredentialBlob or not 0 < size <= 2560 or size % 2:
            raise CredentialUnavailable("Shared Nexus credential has an invalid blob.")
        # Exact pinned Credentials.Load uses counted UTF-16; there is no trailing-NUL assumption.
        value = ctypes.string_at(item.CredentialBlob, size).decode("utf-16-le", errors="strict")
        if not value or any(ord(c) < 32 for c in value):
            raise CredentialUnavailable("Shared Nexus credential has invalid characters.")
        return value
    except (ValueError, UnicodeError):
        raise CredentialUnavailable("Shared Nexus credential could not be decoded.") from None
    finally:
        free(pointer)
