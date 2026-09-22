"""Frozen entry point for the engine.

PyInstaller needs a real script, not `python -m sotto`. Keeping this as a
thin shim means the module entry point stays the source of truth.
"""
import multiprocessing
import sys

from sotto.__main__ import main

if __name__ == "__main__":
    multiprocessing.freeze_support()
    sys.exit(main())
