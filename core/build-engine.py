"""Build the frozen engine, then remove the duplicated CUDA payload.

Why this is a script and not just a spec:

CTranslate2 loads cuBLAS lazily through LoadLibrary, which PyInstaller's
static analysis cannot see — so the DLLs have to be added explicitly. But
once added, PyInstaller also traces *their* dependencies and copies the
whole set a second time under `nvidia/`, preserving the source layout. That
is 736 MB shipped twice.

Deleting the nvidia/ tree afterwards is safe because the bundle root is on
the DLL search path, which is where the explicit copies land.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
DIST = HERE.parent / "shell" / "engine-dist"
WORK = HERE.parent / "build" / "pyi"
BUNDLE = DIST / "engine" / "_internal"


def size_mb(path: Path) -> float:
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file()) / 1048576


def main() -> int:
    if DIST.exists():
        shutil.rmtree(DIST, ignore_errors=True)

    result = subprocess.run(
        [sys.executable, "-m", "PyInstaller", "--noconfirm",
         "--distpath", str(DIST), "--workpath", str(WORK),
         str(HERE / "sotto-engine.spec")],
        cwd=HERE,
    )
    if result.returncode:
        return result.returncode

    root_dlls = sorted(p.name for p in BUNDLE.glob("cublas*.dll"))
    if not root_dlls:
        print("ERROR: cuBLAS is not in the bundle root — GPU inference would "
              "fail. Check the spec.")
        return 1
    print("cuBLAS at bundle root:", ", ".join(root_dlls))

    duplicate = BUNDLE / "nvidia"
    if duplicate.is_dir():
        freed = size_mb(duplicate)
        shutil.rmtree(duplicate)
        print("removed duplicate nvidia/ tree (%.0f MB)" % freed)

    print("engine bundle: %.0f MB" % size_mb(DIST / "engine"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
