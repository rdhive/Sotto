"""Global push-to-talk via a WH_KEYBOARD_LL hook.

RegisterHotKey is not usable here: it only reports key-down. Push-to-talk
needs down *and* up, so we install a low-level keyboard hook on a dedicated
thread that owns a message pump.

Hard rules for the hook callback:
  * It must return fast. Windows silently evicts hooks that exceed
    LowLevelHooksTimeout (default 300ms), and the whole OS keyboard feels
    broken while it blocks. So: hand off and return, never do work here.
  * Ignore synthetic events (LLKHF_INJECTED) or our own SendInput paste
    will feed back into us.
"""
from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import threading
from typing import Callable

from . import log

_log = log.get("hotkey")

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

WH_KEYBOARD_LL = 13
WM_KEYDOWN, WM_KEYUP = 0x0100, 0x0101
WM_SYSKEYDOWN, WM_SYSKEYUP = 0x0104, 0x0105
WM_QUIT = 0x0012
LLKHF_INJECTED = 0x10

ULONG_PTR = ctypes.c_ulonglong if ctypes.sizeof(ctypes.c_void_p) == 8 else ctypes.c_ulong


class KBDLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [
        ("vkCode", wt.DWORD),
        ("scanCode", wt.DWORD),
        ("flags", wt.DWORD),
        ("time", wt.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


HOOKPROC = ctypes.WINFUNCTYPE(
    wt.LPARAM, ctypes.c_int, wt.WPARAM, ctypes.POINTER(KBDLLHOOKSTRUCT)
)

user32.SetWindowsHookExW.argtypes = [ctypes.c_int, HOOKPROC, wt.HINSTANCE, wt.DWORD]
user32.SetWindowsHookExW.restype = wt.HHOOK
# lParam arrives at the callback as POINTER(KBDLLHOOKSTRUCT), not an
# integer, so this must be declared as a void* for the pass-through
# call to accept it.
user32.CallNextHookEx.argtypes = [wt.HHOOK, ctypes.c_int, wt.WPARAM,
                                  ctypes.c_void_p]
user32.CallNextHookEx.restype = wt.LPARAM
user32.UnhookWindowsHookEx.argtypes = [wt.HHOOK]
user32.GetMessageW.argtypes = [wt.LPMSG, wt.HWND, wt.UINT, wt.UINT]
user32.PostThreadMessageW.argtypes = [wt.DWORD, wt.UINT, wt.WPARAM, wt.LPARAM]
user32.MapVirtualKeyW.argtypes = [wt.UINT, wt.UINT]
user32.MapVirtualKeyW.restype = wt.UINT


VK_NAMES: dict[int, str] = {
    0xA0: "Left Shift",
    0xA1: "Right Shift",
    0xA2: "Left Ctrl",
    0xA3: "Right Ctrl",
    0xA4: "Left Alt",
    0xA5: "Right Alt",
    0x14: "Caps Lock",
    0x5B: "Left Win",
    0x5C: "Right Win",
}
# F13-F24: what a Stream Deck can emit, and nothing else uses them.
for _i in range(12):
    VK_NAMES[0x7C + _i] = f"F{13 + _i}"


# Filled in for readable output during key detection.
VK_NAMES.update({
    0x08: "Backspace", 0x09: "Tab", 0x0D: "Enter", 0x10: "Shift",
    0x11: "Ctrl", 0x12: "Alt", 0x13: "Pause", 0x1B: "Esc",
    0x20: "Space", 0x21: "Page Up", 0x22: "Page Down", 0x23: "End",
    0x24: "Home", 0x25: "Left", 0x26: "Up", 0x27: "Right", 0x28: "Down",
    0x2C: "Print Screen", 0x2D: "Insert", 0x2E: "Delete",
    0x5D: "Menu", 0x90: "Num Lock", 0x91: "Scroll Lock",
})
for _i in range(12):
    VK_NAMES[0x70 + _i] = f"F{1 + _i}"


MAPVK_VK_TO_CHAR = 2


def printable_char(vk: int) -> str | None:
    """The character this key produces on the *current* layout, if any.

    OEM key codes mean different characters on different layouts (VK_OEM_3
    is backtick on US, but the squared/cubed key on Belgian AZERTY), so ask
    Windows rather than hardcoding a table.
    """
    res = user32.MapVirtualKeyW(vk, MAPVK_VK_TO_CHAR)
    if not res:
        return None
    ch = chr(res & 0xFFFF)
    return ch if ch.isprintable() and not ch.isspace() else None


def key_name(vk: int) -> str:
    if vk in VK_NAMES:
        return VK_NAMES[vk]
    ch = printable_char(vk)
    if ch:
        return f"{ch!r} key"
    return f"VK 0x{vk:02X}"


def is_typing_key(vk: int) -> bool:
    """True if binding this key would cost the user a character they type."""
    return printable_char(vk) is not None


def capture_next_key(timeout: float = 30.0) -> int | None:
    """Block until any key is pressed and return its virtual-key code.

    Runs its own short-lived hook so it can see every key, not just one
    bound code. Esc cancels.
    """
    captured: list[int] = []
    done = threading.Event()

    def on_key(nCode, wParam, lParam):
        if nCode == 0 and wParam in (WM_KEYDOWN, WM_SYSKEYDOWN):
            kb = lParam[0]
            if not (kb.flags & LLKHF_INJECTED):
                captured.append(kb.vkCode)
                done.set()
                user32.PostThreadMessageW(thread_id[0], WM_QUIT, 0, 0)
                return 1  # swallow it so it does not reach the terminal
        return user32.CallNextHookEx(None, nCode, wParam, lParam)

    proc = HOOKPROC(on_key)
    thread_id = [0]

    def pump():
        thread_id[0] = kernel32.GetCurrentThreadId()
        hook = user32.SetWindowsHookExW(WH_KEYBOARD_LL, proc, None, 0)
        if not hook:
            done.set()
            return
        msg = wt.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))
        user32.UnhookWindowsHookEx(hook)

    t = threading.Thread(target=pump, name="key-capture", daemon=True)
    t.start()
    done.wait(timeout)
    if thread_id[0]:
        user32.PostThreadMessageW(thread_id[0], WM_QUIT, 0, 0)
    t.join(timeout=1)

    if not captured or captured[0] == 0x1B:  # Esc
        return None
    return captured[0]


class PushToTalkHook:
    """Calls on_press()/on_release() when the bound key is held.

    Both callbacks run on the hook thread and must not block.
    """

    def __init__(
        self,
        vk: int,
        on_press: Callable[[], None],
        on_release: Callable[[], None],
        suppress: bool = True,
    ) -> None:
        self._vk = vk
        self._on_press = on_press
        self._on_release = on_release
        self._suppress = suppress
        self._down = False
        self._hook = None
        self._thread_id = 0
        self._thread: threading.Thread | None = None
        self._ready = threading.Event()
        # Must outlive the hook: ctypes will not keep this alive for us.
        self._proc = HOOKPROC(self._callback)

    # -- public ------------------------------------------------------------
    def set_key(self, vk: int) -> None:
        self._vk = vk
        self._down = False
        _log.info("push-to-talk key set to %s", key_name(vk))

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="hotkey", daemon=True)
        self._thread.start()
        self._ready.wait(timeout=5)

    def stop(self) -> None:
        if self._thread_id:
            user32.PostThreadMessageW(self._thread_id, WM_QUIT, 0, 0)
        if self._thread:
            self._thread.join(timeout=2)

    # -- internals ---------------------------------------------------------
    def _callback(self, nCode, wParam, lParam):
        if nCode == 0:
            kb = lParam[0]
            if kb.vkCode == self._vk and not (kb.flags & LLKHF_INJECTED):
                if wParam in (WM_KEYDOWN, WM_SYSKEYDOWN):
                    if not self._down:  # ignore auto-repeat
                        self._down = True
                        try:
                            self._on_press()
                        except Exception:
                            _log.exception("on_press failed")
                    if self._suppress:
                        return 1
                elif wParam in (WM_KEYUP, WM_SYSKEYUP):
                    if self._down:
                        self._down = False
                        try:
                            self._on_release()
                        except Exception:
                            _log.exception("on_release failed")
                    if self._suppress:
                        return 1
        return user32.CallNextHookEx(None, nCode, wParam, lParam)

    def _run(self) -> None:
        self._thread_id = kernel32.GetCurrentThreadId()
        self._hook = user32.SetWindowsHookExW(WH_KEYBOARD_LL, self._proc, None, 0)
        if not self._hook:
            _log.error("SetWindowsHookExW failed (error %s)", ctypes.get_last_error())
            self._ready.set()
            return
        _log.info("hook installed, listening for %s", key_name(self._vk))
        self._ready.set()

        msg = wt.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))

        user32.UnhookWindowsHookEx(self._hook)
        self._hook = None
        _log.info("hook removed")
