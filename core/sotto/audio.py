"""Always-on WASAPI capture into a ring buffer.

The single most important latency trick in the app: the input stream is
opened once at startup and never closed. Opening a capture device costs
50-200ms, which is exactly long enough to clip the first syllable if you
do it on keypress. Instead the mic is always streaming into a circular
buffer and a "recording" is just a pair of offsets into it.

That also gives pre-roll for free: we can reach *back* in time and include
audio from before the key was pressed.

Capture happens at whatever rate the device actually supports (audio
interfaces are typically 44.1/48k and will refuse 16k outright), and the
buffer is resampled to Whisper's 16k only when a recording is collected.
"""
from __future__ import annotations

import threading
from typing import Callable

import numpy as np
import sounddevice as sd

from . import log

_log = log.get("audio")

WHISPER_RATE = 16000

# Names that almost always mean "system playback", not "a person talking".
# Audio interfaces routinely expose these *and* register one as the Windows
# default, which silently turns a dictation app into a system-audio recorder.
_LOOPBACK_HINTS = (
    "loop-back", "loopback", "stereo mix", "mixage stéréo",
    "what u hear", "wave out",
)


def list_devices() -> list[dict]:
    out = []
    for idx, dev in enumerate(sd.query_devices()):
        if dev["max_input_channels"] > 0:
            out.append(
                {
                    "index": idx,
                    "name": dev["name"],
                    "channels": dev["max_input_channels"],
                    "default_samplerate": dev["default_samplerate"],
                    "hostapi": sd.query_hostapis(dev["hostapi"])["name"],
                }
            )
    return out


def base_name(name: str) -> str:
    """The device name without its host-API-specific bracket.

    PortAudio exposes one physical input several times, once per host API,
    with a different suffix each time. Everything before the first bracket
    is the stable part.
    """
    return str(name).split(" (")[0].strip()


def list_selectable_devices() -> list[dict]:
    """Inputs to offer a user: one row per physical device.

    The raw list contains the same microphone four or five times over (MME,
    DirectSound, WASAPI, WDM-KS). Only WASAPI is offered - it is the modern
    shared-mode API, and the alternatives are either legacy or exclusive.
    """
    devices = list_devices()
    wasapi = [d for d in devices if "wasapi" in d["hostapi"].lower()]
    pool = wasapi or devices

    # Restricting to one host API is the whole fix. Do NOT also collapse on
    # base name: several distinct devices share one ("Microphone (Webcam)",
    # "Microphone (WO Mic Device)"), and merging them hides real inputs.
    seen: set[str] = set()
    out = []
    for d in pool:
        if d["name"] in seen:
            continue
        seen.add(d["name"])
        out.append({**d, "label": d["name"],
                    "loopback": any(h in d["name"].lower()
                                    for h in _LOOPBACK_HINTS)})
    return out


def resolve_device(device: str | int | None) -> int | None:
    """Turn a config value into a sounddevice index.

    An int is used as-is. A string is matched case-insensitively against
    input device names, preferring the WASAPI variant (lowest latency of
    the host APIs Windows exposes). None keeps the system default, with a
    warning if that default looks like a loopback.
    """
    if isinstance(device, int):
        return device

    if device is None:
        try:
            default = sd.query_devices(kind="input")
        except Exception:
            return None
        if not any(h in default["name"].lower() for h in _LOOPBACK_HINTS):
            return None
        # Recording system audio and calling it dictation is worse than any
        # fallback, so refuse the default and hunt for a real microphone.
        for d in list_devices():
            if any(h in d["name"].lower() for h in _LOOPBACK_HINTS):
                continue
            if "wasapi" not in d["hostapi"].lower():
                continue
            _log.warning(
                "default input %r is a loopback (system audio, not a mic); "
                "using %r instead. Set input_device in config.json to choose.",
                default["name"], d["name"],
            )
            return d["index"]
        _log.error(
            "default input %r is a loopback and no microphone was found. "
            "Set input_device - see `python -m sotto --list-devices`.",
            default["name"],
        )
        return None

    devices = list_devices()
    needle = device.lower()
    matches = [d for d in devices if needle in d["name"].lower()]

    if matches:
        for d in matches:  # prefer WASAPI over MME/DirectSound/WDM-KS
            if "wasapi" in d["hostapi"].lower():
                return d["index"]

    # The stored name may be host-API specific. WDM-KS repeats the pin name
    # ("Mic | Line 1/2 (Mic | Line 1/2)") where WASAPI names the interface
    # ("Mic | Line 1/2 (3- Audient EVO4)"), so a literal match can only ever
    # find the kernel-streaming device — which runs in exclusive mode and
    # usually records silence. Retry on the part before the bracket.
    base = base_name(device).lower()
    if base and base != needle:
        for d in devices:
            if "wasapi" not in d["hostapi"].lower():
                continue
            if base_name(d["name"]).lower() == base:
                _log.info(
                    "%r resolves to the %s device; using the WASAPI one, %r",
                    device,
                    matches[0]["hostapi"] if matches else "missing",
                    d["name"],
                )
                return d["index"]

    if matches:
        _log.warning(
            "no WASAPI variant of %r; falling back to %s, which may record "
            "silence", device, matches[0]["hostapi"],
        )
        return matches[0]["index"]

    _log.error("no input device matching %r; falling back to default", device)
    return None


def _pick_capture_rate(index: int | None, preferred: int) -> int:
    """Capture at `preferred` if the device allows it, else its native rate."""
    try:
        sd.check_input_settings(
            device=index, samplerate=preferred, channels=1, dtype="float32"
        )
        return preferred
    except Exception:
        info = sd.query_devices(index if index is not None else None, "input")
        native = int(info["default_samplerate"])
        _log.info("device refuses %d Hz, capturing at %d Hz", preferred, native)
        return native


def resample(x: np.ndarray, src: int, dst: int) -> np.ndarray:
    """Rate-convert mono float32 audio.

    Uses soxr when available (fast, properly band-limited). The fallback is
    linear interpolation behind a box pre-filter - noticeably worse, but
    still intelligible, and it keeps the app running if soxr is missing.
    """
    if src == dst or x.size == 0:
        return x
    try:
        import soxr

        return soxr.resample(x, src, dst, quality="HQ").astype(np.float32)
    except ImportError:
        ratio = src / dst
        if ratio > 1:  # decimating: crude anti-alias before we throw samples away
            width = int(ratio)
            trimmed = x[: len(x) - len(x) % width]
            x = trimmed.reshape(-1, width).mean(axis=1)
            src = src / width
            if src == dst:
                return x.astype(np.float32)
        n = int(len(x) * dst / src)
        idx = np.linspace(0, len(x) - 1, n)
        return np.interp(idx, np.arange(len(x)), x).astype(np.float32)


class RingRecorder:
    def __init__(
        self,
        samplerate: int = WHISPER_RATE,
        ring_seconds: int = 120,
        device: str | int | None = None,
        on_level: Callable[[float], None] | None = None,
    ) -> None:
        self.target_rate = samplerate
        self.device = device
        self._on_level = on_level
        self._ring_seconds = ring_seconds
        self.capture_rate = samplerate  # replaced in start()
        self._size = samplerate * ring_seconds
        self._buf = np.zeros(self._size, dtype=np.float32)
        self._written = 0  # monotonic frame counter, never wraps
        self._lock = threading.Lock()
        self._stream: sd.InputStream | None = None

    # -- lifecycle ---------------------------------------------------------
    def start(self) -> None:
        index = resolve_device(self.device)
        self.capture_rate = _pick_capture_rate(index, self.target_rate)

        self._size = self.capture_rate * self._ring_seconds
        self._buf = np.zeros(self._size, dtype=np.float32)
        self._written = 0

        self._stream = sd.InputStream(
            samplerate=self.capture_rate,
            channels=1,
            dtype="float32",
            device=index,
            blocksize=int(self.capture_rate * 0.02),  # 20ms
            callback=self._callback,
        )
        self._stream.start()
        name = sd.query_devices(self._stream.device, "input")["name"]
        _log.info("capturing from %r @ %d Hz", name, self.capture_rate)

    def stop(self) -> None:
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None

    # -- capture -----------------------------------------------------------
    def _callback(self, indata, frames, time_info, status) -> None:
        if status:
            _log.debug("stream status: %s", status)
        mono = indata[:, 0]
        with self._lock:
            start = self._written % self._size
            end = start + frames
            if end <= self._size:
                self._buf[start:end] = mono
            else:
                split = self._size - start
                self._buf[start:] = mono[:split]
                self._buf[: end - self._size] = mono[split:]
            self._written += frames
        if self._on_level is not None:
            # RMS -> rough 0..1 for the UI meter. Cheap enough for the
            # audio thread; the callback must stay non-blocking.
            self._on_level(float(np.sqrt(np.mean(mono * mono))))

    # -- read back ---------------------------------------------------------
    def mark(self, preroll_ms: int = 0) -> int:
        """Return a start offset, reaching back `preroll_ms` into the past."""
        with self._lock:
            written = self._written
        back = int(self.capture_rate * preroll_ms / 1000)
        return max(0, written - back)

    def collect(self, start: int, max_seconds: int | None = None) -> np.ndarray:
        """Return audio from `start` to now, resampled for Whisper."""
        with self._lock:
            written = self._written
            n = written - start
            if n <= 0:
                return np.zeros(0, dtype=np.float32)
            if n > self._size:  # caller held the key longer than the ring
                _log.warning("ring overrun, dropping %d oldest frames", n - self._size)
                n = self._size
                start = written - n
            idx = (start + np.arange(n)) % self._size
            out = self._buf[idx].copy()

        if max_seconds is not None:
            limit = self.capture_rate * max_seconds
            if len(out) > limit:
                out = out[-limit:]
        return resample(out, self.capture_rate, self.target_rate)
