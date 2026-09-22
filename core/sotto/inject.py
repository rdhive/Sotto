"""Put text into whatever window has focus.

Two strategies:

  paste  Stash the text on the clipboard, send Ctrl+V, restore the old
         clipboard. Ugly, but it is the only approach that works in
         essentially every Windows app, which is why every dictation tool
         ships it. We save/restore CF_UNICODETEXT only.

  type   SendInput with KEYEVENTF_UNICODE, one event per character. Leaves
         the clipboard alone, but it is ~40x slower and some apps drop
         characters when fed too fast.

UI Automation's TextPattern would be the "correct" mechanism but only a
fraction of apps implement it, so it is not viable as the primary path.
"""
from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import time

from . import log

_log = log.get("inject")

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002

INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
VK_CONTROL = 0x11
VK_V = 0x56

# Tags our own synthetic events so the hook can tell them apart.
SOTTO_EXTRAINFO = 0x50770001

ULONG_PTR = ctypes.c_ulonglong if ctypes.sizeof(ctypes.c_void_p) == 8 else ctypes.c_ulong


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wt.WORD),
        ("wScan", wt.WORD),
        ("dwFlags", wt.DWORD),
        ("time", wt.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class _INPUTUNION(ctypes.Union):
    # The union is as large as its biggest member, MOUSEINPUT (32 bytes on
    # x64), which makes sizeof(INPUT) 40. Sizing it to KEYBDINPUT instead
    # yields 32, and SendInput rejects the whole batch with ERROR_INVALID
    # _PARAMETER (87) - silently, since it just returns 0.
    _fields_ = [("ki", KEYBDINPUT), ("_pad", ctypes.c_byte * 32)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wt.DWORD), ("u", _INPUTUNION)]


user32.SendInput.argtypes = [wt.UINT, ctypes.POINTER(INPUT), ctypes.c_int]

# These all traffic in HANDLEs. Without explicit prototypes ctypes assumes
# C int and silently truncates 64-bit handles.
user32.OpenClipboard.argtypes = [wt.HWND]
user32.OpenClipboard.restype = wt.BOOL
user32.CloseClipboard.restype = wt.BOOL
user32.EmptyClipboard.restype = wt.BOOL
user32.IsClipboardFormatAvailable.argtypes = [wt.UINT]
user32.IsClipboardFormatAvailable.restype = wt.BOOL
user32.GetClipboardData.argtypes = [wt.UINT]
user32.GetClipboardData.restype = wt.HANDLE
user32.SetClipboardData.argtypes = [wt.UINT, wt.HANDLE]
user32.SetClipboardData.restype = wt.HANDLE

kernel32.GlobalAlloc.argtypes = [wt.UINT, ctypes.c_size_t]
kernel32.GlobalAlloc.restype = wt.HGLOBAL
kernel32.GlobalLock.argtypes = [wt.HGLOBAL]
kernel32.GlobalLock.restype = ctypes.c_void_p
kernel32.GlobalUnlock.argtypes = [wt.HGLOBAL]
kernel32.GlobalUnlock.restype = wt.BOOL


def _send(inputs: list[INPUT]) -> None:
    arr = (INPUT * len(inputs))(*inputs)
    sent = user32.SendInput(len(inputs), arr, ctypes.sizeof(INPUT))
    if sent != len(inputs):
        _log.warning("SendInput sent %d/%d (error %s)", sent, len(inputs),
                     ctypes.get_last_error())


def _key(vk: int, up: bool) -> INPUT:
    inp = INPUT(type=INPUT_KEYBOARD)
    inp.ki = KEYBDINPUT(
        wVk=vk, wScan=0,
        dwFlags=KEYEVENTF_KEYUP if up else 0,
        time=0, dwExtraInfo=SOTTO_EXTRAINFO,
    )
    return inp


def _unicode(code: int, up: bool) -> INPUT:
    inp = INPUT(type=INPUT_KEYBOARD)
    inp.ki = KEYBDINPUT(
        wVk=0, wScan=code,
        dwFlags=KEYEVENTF_UNICODE | (KEYEVENTF_KEYUP if up else 0),
        time=0, dwExtraInfo=SOTTO_EXTRAINFO,
    )
    return inp


# -- clipboard -------------------------------------------------------------
def _open_clipboard(retries: int = 12) -> bool:
    """Another app may hold the clipboard open; back off and retry."""
    for _ in range(retries):
        if user32.OpenClipboard(None):
            return True
        time.sleep(0.01)
    _log.warning("could not open clipboard")
    return False


def get_clipboard_text() -> str | None:
    if not _open_clipboard():
        return None
    try:
        if not user32.IsClipboardFormatAvailable(CF_UNICODETEXT):
            return None
        handle = user32.GetClipboardData(CF_UNICODETEXT)
        if not handle:
            return None
        ptr = kernel32.GlobalLock(handle)
        try:
            return ctypes.c_wchar_p(ptr).value
        finally:
            kernel32.GlobalUnlock(handle)
    finally:
        user32.CloseClipboard()


def set_clipboard_text(text: str) -> bool:
    if not _open_clipboard():
        return False
    try:
        user32.EmptyClipboard()
        data = ctypes.create_unicode_buffer(text)
        size = ctypes.sizeof(data)
        handle = kernel32.GlobalAlloc(GMEM_MOVEABLE, size)
        ptr = kernel32.GlobalLock(handle)
        ctypes.memmove(ptr, ctypes.byref(data), size)
        kernel32.GlobalUnlock(handle)
        # Ownership transfers to the clipboard; do not free `handle`.
        user32.SetClipboardData(CF_UNICODETEXT, handle)
        return True
    finally:
        user32.CloseClipboard()


# -- public ----------------------------------------------------------------
def paste(text: str, restore_delay_ms: int = 150) -> None:
    previous = get_clipboard_text()
    if not set_clipboard_text(text):
        _log.error("clipboard unavailable, falling back to typing")
        type_text(text)
        return
    _send([_key(VK_CONTROL, False), _key(VK_V, False),
           _key(VK_V, True), _key(VK_CONTROL, True)])
    if previous is not None:
        # The target app reads the clipboard asynchronously; restoring too
        # early makes it paste the *old* contents.
        time.sleep(restore_delay_ms / 1000)
        set_clipboard_text(previous)


def type_text(text: str, chunk_delay: float = 0.001) -> None:
    events: list[INPUT] = []
    for ch in text:
        code = ord(ch)
        if code > 0xFFFF:  # outside the BMP: needs a surrogate pair
            code -= 0x10000
            for half in (0xD800 + (code >> 10), 0xDC00 + (code & 0x3FF)):
                events += [_unicode(half, False), _unicode(half, True)]
        else:
            events += [_unicode(code, False), _unicode(code, True)]
    # Send in batches so a long dictation does not overflow the input queue.
    for i in range(0, len(events), 64):
        _send(events[i : i + 64])
        time.sleep(chunk_delay)


def deliver(text: str, method: str = "paste", restore_delay_ms: int = 150) -> None:
    if not text:
        return
    t0 = time.perf_counter()
    if method == "type":
        type_text(text)
    else:
        paste(text, restore_delay_ms)
    _log.info("delivered %d chars via %s in %.0fms", len(text), method,
              (time.perf_counter() - t0) * 1000)
