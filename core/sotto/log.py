"""Logging to console + a rotating file under %APPDATA%\\Sotto\\logs."""
from __future__ import annotations

import logging
import sys
from logging.handlers import RotatingFileHandler

from .config import APP_DIR

_FMT = "%(asctime)s %(levelname)-7s %(name)-14s %(message)s"


def setup(level: int = logging.INFO) -> None:
    log_dir = APP_DIR / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)

    root = logging.getLogger()
    root.setLevel(level)
    root.handlers.clear()

    # A French/Belgian Windows console defaults to cp1252, which raises
    # UnicodeEncodeError on anything outside Latin-1 - and this app handles
    # 100+ languages. Force UTF-8, and degrade instead of crashing if the
    # terminal cannot represent a character.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(logging.Formatter(_FMT, datefmt="%H:%M:%S"))
    root.addHandler(console)

    fileh = RotatingFileHandler(
        log_dir / "sotto.log", maxBytes=2_000_000, backupCount=3, encoding="utf-8"
    )
    fileh.setFormatter(logging.Formatter(_FMT))
    root.addHandler(fileh)

    # These are chatty and rarely useful. huggingface_hub/httpx in
    # particular emit a line per HTTP request during a model download,
    # which buries our own logging entirely.
    for noisy in ("httpx", "httpcore", "huggingface_hub", "urllib3",
                  "filelock", "faster_whisper"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def get(name: str) -> logging.Logger:
    return logging.getLogger(name)
