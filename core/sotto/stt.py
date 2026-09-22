"""Speech to text via faster-whisper (CTranslate2) on CUDA."""
from __future__ import annotations

import os
import site
import sys
import time
from pathlib import Path

import numpy as np

from . import log
from .config import Config

_log = log.get("stt")

_cuda_registered = False


def register_cuda_dlls() -> None:
    """Put pip-installed CUDA libraries on the Windows DLL search path.

    `nvidia-cublas-cu12` and friends unpack into site-packages/nvidia/*/bin,
    which Windows does not search. CTranslate2 loads cuBLAS/cuDNN lazily, so
    the model appears to load fine and then dies on the first GPU call with
    "Library cublas64_12.dll is not found".

    add_dll_directory covers loads that opt into user dirs; PATH covers the
    plain LoadLibrary calls that do not. Both are needed.
    """
    global _cuda_registered
    if _cuda_registered or os.name != "nt":
        return

    added = []
    roots = []

    # Frozen build: there is no site-packages. The build script flattens the
    # CUDA DLLs into the bundle root, which PyInstaller already has on the
    # DLL search path — so finding them there counts as registered.
    bundle = getattr(sys, "_MEIPASS", None)
    if bundle:
        root = Path(bundle)
        os.add_dll_directory(str(root))
        if any(root.glob("cublas*.dll")):
            added.append("cublas (bundle)")
        nvidia = root / "nvidia"
        if nvidia.is_dir():
            roots.append(nvidia)

    for base in set(site.getsitepackages() + [site.getusersitepackages()]):
        nvidia = Path(base) / "nvidia"
        if nvidia.is_dir():
            roots.append(nvidia)

    for nvidia in roots:
        for bindir in sorted(nvidia.glob("*/bin")):
            if not any(bindir.glob("*.dll")):
                continue
            os.add_dll_directory(str(bindir))
            os.environ["PATH"] = str(bindir) + os.pathsep + os.environ["PATH"]
            added.append(bindir.parent.name)

    if added:
        _log.debug("registered CUDA libs: %s", ", ".join(added))
    else:
        # Only cuBLAS is required — cuDNN and NVRTC were probed and are
        # never loaded for this model. Do not send people hunting for them.
        _log.warning(
            "cuBLAS not found; GPU inference needs nvidia-cublas-cu12 in the "
            "environment, or a system CUDA install on PATH"
        )
    _cuda_registered = True


class Transcriber:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self._model = None

    def load(self) -> None:
        # Must happen before faster_whisper imports ctranslate2.
        register_cuda_dlls()

        from faster_whisper import WhisperModel

        t0 = time.perf_counter()
        # Prefer the cached copy and make no network call at all. Without
        # local_files_only, huggingface_hub revision-checks the repo over
        # HTTPS on every start - harmless in content, but this app promises
        # that nothing leaves the machine, so it should mean it.
        try:
            self._model = WhisperModel(
                self.cfg.stt_model,
                device=self.cfg.stt_device,
                compute_type=self.cfg.stt_compute_type,
                local_files_only=True,
            )
        except Exception:
            # Not cached yet: first run has to download it.
            _log.info("%s is not cached; downloading it once", self.cfg.stt_model)
            self._model = WhisperModel(
                self.cfg.stt_model,
                device=self.cfg.stt_device,
                compute_type=self.cfg.stt_compute_type,
            )
        _log.info(
            "loaded %s on %s in %.1fs",
            self.cfg.stt_model,
            self.cfg.stt_device,
            time.perf_counter() - t0,
        )
        self._warmup()

    def _warmup(self) -> None:
        """First inference pays for CUDA kernel compilation. Pay it now,
        not on the user's first sentence."""
        t0 = time.perf_counter()
        silence = np.zeros(self.cfg.samplerate, dtype=np.float32)
        list(self._model.transcribe(silence, beam_size=1)[0])
        _log.info("warmup %.0fms", (time.perf_counter() - t0) * 1000)

    def _initial_prompt(self) -> str | None:
        """Whisper biases toward words seen in the prompt. This is how the
        personal dictionary makes proper nouns come out spelled right."""
        if not self.cfg.dictionary:
            return None
        return ", ".join(self.cfg.dictionary)

    def transcribe(self, audio: np.ndarray) -> tuple[str, str | None, float]:
        """Return (text, detected_language, elapsed_seconds)."""
        if self._model is None:
            raise RuntimeError("model not loaded")
        t0 = time.perf_counter()
        segments, info = self._model.transcribe(
            audio,
            language=self.cfg.language,
            beam_size=self.cfg.beam_size,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 300},
            initial_prompt=self._initial_prompt(),
            condition_on_previous_text=False,
        )
        text = "".join(s.text for s in segments).strip()
        elapsed = time.perf_counter() - t0
        _log.info(
            "%.0fms  lang=%s  %d chars", elapsed * 1000, info.language, len(text)
        )
        return text, info.language, elapsed
