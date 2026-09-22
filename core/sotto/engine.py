"""The state machine that wires everything together.

    IDLE --key down--> RECORDING --key up--> TRANSCRIBING
      ^                                            |
      |                                            v
      +---- INJECTING <---- POLISHING <------------+

Threading model:
  hook thread   fires on_press/on_release, must never block  -> enqueues
  audio thread  sounddevice callback, must never block       -> ring buffer
  worker thread does all the slow work (GPU, HTTP, SendInput)
  ipc thread    accepts shell connections
"""
from __future__ import annotations

import queue
import threading
import time
from pathlib import Path
from dataclasses import asdict

import numpy as np

from . import audio, inject, log
from .config import Config
from .hotkey import PushToTalkHook, key_name
from .ipc import IpcServer
from .polish import Polisher
from .stt import Transcriber

_log = log.get("engine")

LEVEL_HZ = 20  # UI meter updates per second


class Engine:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.state = "loading"
        self._jobs: queue.Queue = queue.Queue()
        self._mark: int | None = None
        self._press_time = 0.0
        self._last_level_sent = 0.0
        self._stop = threading.Event()
        self._transform_seq = 0
        self._transform_reply: dict[int, str | None] = {}
        self._transform_done = threading.Event()

        self.ipc = IpcServer(cfg.ipc_host, cfg.ipc_port, self._on_command)
        self.recorder = audio.RingRecorder(
            samplerate=cfg.samplerate,
            ring_seconds=cfg.ring_seconds,
            device=cfg.input_device,
            on_level=self._on_level,
        )
        self.stt = Transcriber(cfg)
        self.polisher = Polisher(cfg)
        self.hook = PushToTalkHook(
            cfg.hotkey_vk, self._on_press, self._on_release, cfg.hotkey_suppress
        )

    # -- lifecycle ---------------------------------------------------------
    def run(self) -> None:
        # Log what we actually loaded, not what we assume. A stale process
        # or an unsaved edit is otherwise indistinguishable from a bug.
        import hashlib
        import sotto

        from .config import CONFIG_PATH

        # Identify the code and the exact bytes it read, so a stale package
        # or a shadowed config file cannot masquerade as a logic bug.
        _log.info("package  %s", Path(sotto.__file__).parent)
        if CONFIG_PATH.exists():
            raw = CONFIG_PATH.read_bytes()
            stamp = time.strftime(
                "%Y-%m-%d %H:%M:%S", time.localtime(CONFIG_PATH.stat().st_mtime)
            )
            _log.info(
                "config   %s (%d bytes, written %s, sha %s)",
                CONFIG_PATH, len(raw), stamp,
                hashlib.sha256(raw).hexdigest()[:12],
            )
        else:
            _log.warning("config   %s DOES NOT EXIST - using defaults",
                         CONFIG_PATH)
        _log.info("hotkey   %s (0x%02X)", key_name(self.cfg.hotkey_vk),
                  self.cfg.hotkey_vk)
        _log.info("mic      %s", self.cfg.input_device or "system default")
        _log.info("cleanup  %s / %s", self.cfg.polish_backend,
                  self.cfg.polish_model)

        self.ipc.start()
        self._set_state("loading")

        self.recorder.start()
        self.stt.load()
        self.polisher.warmup()

        threading.Thread(target=self._worker, name="worker", daemon=True).start()
        self.hook.start()

        self._set_state("idle")
        _log.info("ready - hold %s to dictate", key_name(self.cfg.hotkey_vk))
        try:
            while not self._stop.is_set():
                self._stop.wait(0.5)
        except KeyboardInterrupt:
            pass
        finally:
            self.shutdown()

    def shutdown(self) -> None:
        self._stop.set()
        self.hook.stop()
        self.recorder.stop()
        self.ipc.stop()
        _log.info("stopped")

    # -- events from the hook thread (must return immediately) -------------
    def _on_press(self) -> None:
        if self.state not in ("idle", "error"):
            return
        self._mark = self.recorder.mark(preroll_ms=self.cfg.preroll_ms)
        self._press_time = time.perf_counter()
        self._set_state("recording")

    def _on_release(self) -> None:
        if self.state != "recording":
            return
        held_ms = (time.perf_counter() - self._press_time) * 1000
        mark, self._mark = self._mark, None
        if held_ms < self.cfg.min_hold_ms:
            _log.debug("ignoring %.0fms tap", held_ms)
            self._set_state("idle")
            return
        self._jobs.put((mark, held_ms))

    def _on_level(self, rms: float) -> None:
        if self.state != "recording":
            return
        now = time.perf_counter()
        if now - self._last_level_sent < 1 / LEVEL_HZ:
            return
        self._last_level_sent = now
        # Perceptual-ish curve; raw RMS looks dead on a UI meter.
        self.ipc.broadcast({"type": "level", "value": min(1.0, rms * 6) ** 0.5})

    # -- worker thread -----------------------------------------------------
    def _worker(self) -> None:
        while not self._stop.is_set():
            try:
                mark, held_ms = self._jobs.get(timeout=0.25)
            except queue.Empty:
                continue
            try:
                self._process(mark, held_ms)
            except Exception as exc:
                _log.exception("pipeline failed")
                self.ipc.broadcast({"type": "error", "message": str(exc)})
                self._set_state("error")
                time.sleep(1.5)
                self._set_state("idle")

    def _process(self, mark: int, held_ms: float) -> None:
        t0 = time.perf_counter()
        pcm = self.recorder.collect(mark, max_seconds=self.cfg.max_utterance_s)
        if len(pcm) < self.cfg.samplerate * 0.2:
            self._set_state("idle")
            return

        peak = float(np.abs(pcm).max()) if len(pcm) else 0.0
        rms = float(np.sqrt(np.mean(pcm * pcm))) if len(pcm) else 0.0
        _log.info("audio    %.1fs  peak %.3f  rms %.4f", len(pcm) / self.cfg.samplerate,
                  peak, rms)
        if peak < 0.01:
            # Say this where the user can see it. A log line is no use to
            # someone whose only symptom is "it cannot hear me".
            _log.warning(
                "input is essentially silent (peak %.4f) on %r", peak,
                self.cfg.input_device or "system default",
            )
            self.ipc.broadcast({
                "type": "warning",
                "message": "No sound reached the microphone. Check the input "
                           "device in Settings, that the mic is unmuted, and "
                           "the gain.",
            })

        self._set_state("transcribing")
        raw, language, stt_s = self.stt.transcribe(pcm)
        if not raw:
            _log.info("nothing recognised")
            self.ipc.broadcast({"type": "empty"})
            self._set_state("idle")
            return

        self._set_state("polishing")
        text, polish_s = self.polisher.polish(raw, language)
        if self.cfg.trailing_space:
            text += " "

        text = self._shell_transform(text)

        self._set_state("injecting")
        inject.deliver(
            text, self.cfg.inject_method, self.cfg.clipboard_restore_delay_ms
        )

        total = (time.perf_counter() - t0) * 1000
        _log.info(
            "done in %.0fms (audio %.1fs, stt %.0fms, polish %.0fms)",
            total,
            len(pcm) / self.cfg.samplerate,
            stt_s * 1000,
            polish_s * 1000,
        )
        self.ipc.broadcast(
            {
                "type": "result",
                "raw": raw,
                "text": text.strip(),
                "language": language,
                "held_ms": round(held_ms),
                "latency_ms": round(total),
            }
        )
        self._set_state("idle")

    def _shell_transform(self, text: str) -> str:
        """Ask the shell to apply dictionary corrections.

        The shell owns the dictionary, so it owns the rewrite. This is a
        blocking round-trip on the worker thread, bounded hard: a missing,
        slow or broken shell costs at most shell_transform_ms and then the
        original text is used.
        """
        budget = self.cfg.shell_transform_ms / 1000
        if budget <= 0 or self.ipc.client_count == 0:
            return text

        self._transform_seq += 1
        seq = self._transform_seq
        self._transform_done.clear()
        self.ipc.broadcast({"type": "transform", "id": seq, "text": text})

        if not self._transform_done.wait(budget):
            _log.warning("shell did not return corrections in %.0fms; "
                         "injecting uncorrected", budget * 1000)
            self._transform_reply.pop(seq, None)
            return text

        reply = self._transform_reply.pop(seq, None)
        if not reply:
            return text
        if reply != text:
            _log.info("shell applied corrections")
        return reply

    # -- shell commands ----------------------------------------------------
    def _on_command(self, msg: dict) -> dict | None:
        cmd = msg.get("cmd")
        if cmd == "hello":
            return {
                "type": "hello",
                "state": self.state,
                "hotkey": key_name(self.cfg.hotkey_vk),
                "model": self.cfg.stt_model,
                "polish": (
                    self.cfg.polish_backend if self.polisher.available() else "rules"
                ),
            }
        if cmd == "get_config":
            return {"type": "config", "config": asdict(self.cfg)}
        if cmd == "set_config":
            changes = msg.get("config", {})
            for key, value in changes.items():
                if hasattr(self.cfg, key):
                    setattr(self.cfg, key, value)
            self.cfg.save()
            if "hotkey_vk" in changes:
                self.hook.set_key(self.cfg.hotkey_vk)
            # Model/device changes need a restart; the shell says so.
            return {"type": "config", "config": asdict(self.cfg)}
        if cmd == "list_devices":
            # The selectable list, not the raw one: PortAudio reports each
            # physical input once per host API, so the raw list shows the
            # same microphone four or five times.
            return {"type": "devices",
                    "devices": audio.list_selectable_devices()}
        if cmd == "start":
            # UI / global-shortcut transport. Reuses the same path the
            # keyboard hook takes, so there is one recording code path.
            self._on_press()
            return {"type": "ok", "state": self.state}
        if cmd == "stop":
            self._on_release()
            return {"type": "ok", "state": self.state}
        if cmd == "transform_result":
            self._transform_reply[msg.get("id", 0)] = msg.get("text")
            self._transform_done.set()
            return None
        if cmd == "quit":
            threading.Thread(target=self.shutdown, daemon=True).start()
            return {"type": "ok"}
        return {"type": "error", "message": "unknown command: %s" % cmd}

    # -- helpers -----------------------------------------------------------
    def _set_state(self, state: str) -> None:
        if state == self.state:
            return
        self.state = state
        self.ipc.broadcast({"type": "state", "state": state})
