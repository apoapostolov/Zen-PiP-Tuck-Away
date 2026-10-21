"""Register Ctrl+Alt+T with Windows for the PiP Tuck Away mod.

A browser cannot receive a keyboard chord while another application has focus:
Windows only hands that to a process that called RegisterHotKey, and Firefox
exposes no hotkey API to its chrome scripts. This helper does the registration
and writes a sequence number to a small file; the mod reads that file while a
player window exists and runs the same toggle it would run from the keyboard.

It is started by the user, never by the mod. Run it with pythonw.exe so no
console appears (tools/install-autostart.ps1 sets that up).

    %LOCALAPPDATA%\\pip-tuck-away\\toggle.json   {"seq": N, "at": epoch}
    %LOCALAPPDATA%\\pip-tuck-away\\status.json   {"ready": bool, "error": str|None}
    %LOCALAPPDATA%\\pip-tuck-away\\stop          touch this file to make it exit

Exit codes: 0 stopped or already running, 1 the chord could not be registered.
"""

from __future__ import annotations

import ctypes
import json
import os
import socket
import sys
import time
from ctypes import wintypes

MOD_ALT = 0x0001
MOD_CONTROL = 0x0002
MOD_NOREPEAT = 0x4000
VK_T = 0x54
HOTKEY_ID = 1
WM_HOTKEY = 0x0312
WM_QUIT = 0x0012
PM_REMOVE = 0x0001
CHORD_LABEL = "Ctrl+Alt+T"
SINGLE_INSTANCE_PORT = 47811
POLL_SECONDS = 0.05

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

user32.RegisterHotKey.argtypes = (wintypes.HWND, ctypes.c_int, wintypes.UINT, wintypes.UINT)
user32.RegisterHotKey.restype = wintypes.BOOL
user32.UnregisterHotKey.argtypes = (wintypes.HWND, ctypes.c_int)
user32.UnregisterHotKey.restype = wintypes.BOOL
user32.PeekMessageW.argtypes = (
    ctypes.POINTER(wintypes.MSG),
    wintypes.HWND,
    wintypes.UINT,
    wintypes.UINT,
    wintypes.UINT,
)
user32.PeekMessageW.restype = wintypes.BOOL
user32.GetForegroundWindow.restype = wintypes.HWND
user32.GetWindowThreadProcessId.argtypes = (wintypes.HWND, ctypes.POINTER(wintypes.DWORD))
user32.GetWindowThreadProcessId.restype = wintypes.DWORD
kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.QueryFullProcessImageNameW.argtypes = (
    wintypes.HANDLE,
    wintypes.DWORD,
    wintypes.LPWSTR,
    ctypes.POINTER(wintypes.DWORD),
)
kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
kernel32.CloseHandle.restype = wintypes.BOOL


def state_dir() -> str:
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    path = os.path.join(base, "pip-tuck-away")
    os.makedirs(path, exist_ok=True)
    return path


STATE_DIR = state_dir()
TOGGLE_FILE = os.path.join(STATE_DIR, "toggle.json")
STATUS_FILE = os.path.join(STATE_DIR, "status.json")
STOP_FILE = os.path.join(STATE_DIR, "stop")


def write_json(path: str, payload: dict) -> None:
    """Write atomically so a reader never sees half a file."""
    temp = f"{path}.tmp"
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp, path)


def read_seq() -> int:
    try:
        with open(TOGGLE_FILE, encoding="utf-8") as handle:
            return int(json.load(handle).get("seq", 0))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return 0


def announce(ready: bool, error: str | None = None) -> None:
    write_json(
        STATUS_FILE,
        {
            "ready": ready,
            "chord": CHORD_LABEL,
            "pid": os.getpid(),
            "tid": kernel32.GetCurrentThreadId(),
            "error": error,
            "at": time.time(),
        },
    )


def single_instance() -> socket.socket | None:
    """A bound loopback port is the cheapest reliable ownership check."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", SINGLE_INSTANCE_PORT))
        sock.listen(1)
        return sock
    except OSError:
        sock.close()
        return None


def fire(seq: int) -> int:
    seq += 1
    write_json(TOGGLE_FILE, {"seq": seq, "at": time.time(), "chord": CHORD_LABEL})
    return seq


def foreground_process_name() -> str:
    """Name of the executable that owns the foreground window, lowercased."""
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return ""
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    if not pid.value:
        return ""
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
    if not handle:
        return ""
    try:
        size = wintypes.DWORD(1024)
        buffer = ctypes.create_unicode_buffer(size.value)
        if not kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
            return ""
        return os.path.basename(buffer.value).lower()
    finally:
        kernel32.CloseHandle(handle)


def zen_has_focus() -> bool:
    """
    True when a Zen window owns the keyboard.

    The registration is global, so it also swallows the chord inside Zen. There
    the browser can handle it itself, without the file round trip, so this is
    where the helper stands aside. If the mod ever stops listening, the chord
    simply does nothing in Zen, which is the quieter failure.
    """
    return foreground_process_name().startswith("zen")


def register() -> bool:
    return bool(
        user32.RegisterHotKey(None, HOTKEY_ID, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, VK_T)
    )


def main(argv: list[str]) -> int:
    selftest = "--selftest" in argv

    if "--check-foreground" in argv:
        print(json.dumps({"foreground": foreground_process_name(), "zen": zen_has_focus()}))
        return 0

    if not selftest:
        if single_instance() is None:
            return 0  # an earlier copy already owns the chord
        try:
            os.remove(STOP_FILE)
        except OSError:
            pass

    if not register():
        error = ctypes.get_last_error()
        if selftest and error == 1409:  # ERROR_HOTKEY_ALREADY_REGISTERED
            print("another helper already owns Ctrl+Alt+T; nothing to do")
            return 0
        announce(False, f"RegisterHotKey failed with {error}")
        return 1

    seq = read_seq()
    announce(True)

    if selftest:
        fire(seq)
        user32.UnregisterHotKey(None, HOTKEY_ID)
        print(f"registered and wrote a toggle event at seq {seq + 1}")
        return 0

    message = wintypes.MSG()
    try:
        while not os.path.exists(STOP_FILE):
            while user32.PeekMessageW(ctypes.byref(message), None, 0, 0, PM_REMOVE):
                if message.message == WM_QUIT:
                    return 0
                if message.message == WM_HOTKEY and message.wParam == HOTKEY_ID:
                    if not zen_has_focus():
                        seq = fire(seq)
            time.sleep(POLL_SECONDS)
    finally:
        user32.UnregisterHotKey(None, HOTKEY_ID)
        announce(False, "stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
