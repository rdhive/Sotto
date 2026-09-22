"""Configuration: load/save JSON at %APPDATA%\\Sotto\\config.json."""
from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path

APP_NAME = "Sotto"
APP_DIR = Path(os.environ.get("APPDATA", Path.home())) / APP_NAME
CONFIG_PATH = APP_DIR / "config.json"


@dataclass
class Config:
    # --- hotkey -------------------------------------------------------------
    # Virtual-key code held to dictate. 0xA3 = Right Ctrl.
    # Fn is NOT usable: it is handled in keyboard firmware and never reaches
    # Windows. Good alternatives: 0xA3 RCtrl, 0xA5 RAlt, 0x14 CapsLock,
    # 0x7C-0x87 F13-F24 (a Stream Deck can emit these).
    hotkey_vk: int = 0xA3
    # Swallow the key so it never reaches the focused app.
    hotkey_suppress: bool = True
    # Ignore presses shorter than this (stray taps).
    min_hold_ms: int = 180

    # --- audio --------------------------------------------------------------
    samplerate: int = 16000
    # None = default input device. Use `python -m sotto --list-devices`.
    input_device: str | int | None = None
    ring_seconds: int = 120
    # Capture this much audio from *before* the keypress so the first
    # syllable is never clipped.
    preroll_ms: int = 300
    max_utterance_s: int = 90

    # --- speech to text -----------------------------------------------------
    stt_model: str = "large-v3-turbo"
    stt_device: str = "cuda"
    stt_compute_type: str = "float16"
    # None => autodetect. Pin it ("fr", "en", "nl") for lower latency and
    # fewer misdetections on short clips.
    language: str | None = None
    beam_size: int = 1

    # --- cleanup ------------------------------------------------------------
    # "ollama" | "rules" | "off"
    polish_backend: str = "ollama"
    # A non-reasoning instruct model. Reasoning models (qwen3, deepseek-r1)
    # emit their chain of thought as the answer and are 5-10x slower.
    polish_model: str = "qwen2.5:3b-instruct"
    ollama_url: str = "http://127.0.0.1:11434"
    polish_timeout_s: float = 6.0

    # --- injection ----------------------------------------------------------
    # "paste" (clipboard + Ctrl+V, works nearly everywhere) or
    # "type" (SendInput unicode, slower, no clipboard clobber)
    inject_method: str = "paste"
    clipboard_restore_delay_ms: int = 150
    trailing_space: bool = True

    # --- ipc ----------------------------------------------------------------
    ipc_host: str = "127.0.0.1"
    ipc_port: int = 8765
    # How long to wait for a connected shell to apply dictionary corrections
    # before injecting the text as-is. 0 disables the round-trip entirely.
    shell_transform_ms: int = 250

    # --- vocabulary ---------------------------------------------------------
    # Proper nouns / jargon fed to Whisper as an initial prompt.
    dictionary: list[str] = field(default_factory=list)

    @classmethod
    def load(cls) -> "Config":
        if not CONFIG_PATH.exists():
            cfg = cls()
            cfg.save()
            return cfg
        raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        known = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in raw.items() if k in known})

    def save(self) -> None:
        APP_DIR.mkdir(parents=True, exist_ok=True)
        CONFIG_PATH.write_text(
            json.dumps(asdict(self), indent=2, ensure_ascii=False), encoding="utf-8"
        )
