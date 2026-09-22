# PyInstaller spec for the Sotto engine.
#
# Produces a standalone sotto-engine.exe so the installed app needs no
# Python. Windowed (no console) because it runs as a background service.
#
# CUDA: only cuBLAS is bundled. Probed on 2026-08-31 — CTranslate2 runs
# large-v3-turbo on GPU with cuBLAS alone; cuDNN (1.0 GB) and NVRTC
# (179 MB) are never loaded. Do not add them back without re-probing.

from pathlib import Path
import site

from PyInstaller.utils.hooks import collect_all, collect_data_files

datas, binaries, hiddenimports = [], [], []

for pkg in ("faster_whisper", "ctranslate2", "av", "onnxruntime",
            "tokenizers", "sounddevice", "soxr"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

# CTranslate2 loads cuBLAS through LoadLibrary at runtime, which static
# analysis cannot see, so the DLLs must be added by hand. Only cuBLAS: see
# the header note about cuDNN and NVRTC. PyInstaller will additionally trace
# these DLLs' own dependencies into an `nvidia/` tree — build-engine.py
# deletes that duplicate afterwards.
for base in set(site.getsitepackages()):
    cublas = Path(base) / "nvidia" / "cublas" / "bin"
    if cublas.is_dir():
        for dll in cublas.glob("*.dll"):
            binaries.append((str(dll), "."))
        break
else:
    raise SystemExit("nvidia-cublas-cu12 is not installed in this environment")

hiddenimports += ["sotto", "sotto.engine", "sotto.audio", "sotto.stt",
                  "sotto.polish", "sotto.inject", "sotto.hotkey",
                  "sotto.ipc", "sotto.config", "sotto.log"]

a = Analysis(
    ["sotto_engine_main.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=[
        # Never needed at runtime, and each drags in a lot.
        "tkinter", "matplotlib", "PIL", "pytest", "IPython", "pip",
        "setuptools", "wheel",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="sotto-engine",
    debug=False,
    strip=False,
    upx=False,
    console=False,          # background service: no console window, ever
    icon="../shell/assets/icon.ico",
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="engine",
)
