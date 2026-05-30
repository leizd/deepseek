"""Bundle the DeepSeek Mobile launcher into a single executable.

Usage:

    python -m pip install -r requirements.txt
    python -m pip install -r requirements-build.txt
    python scripts/build_exe.py

The resulting ``dist/DeepSeekMobile.exe`` (or ``DeepSeekMobile`` on macOS /
Linux) bundles ``launch.py``, the entire ``deepseek_mobile`` package, the
``static`` web assets, and KaTeX fonts. The same exe opens the local desktop
app window by default, can launch the legacy GUI with ``--gui``, or run as the
HTTP server with ``--server``.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
ENTRY = PROJECT_ROOT / "launch.py"
APP_NAME = "DeepSeekMobile"
STATIC_DIR = PROJECT_ROOT / "static"
ICON_PATH = PROJECT_ROOT / "static" / "icons" / "favicon.ico"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--onefile",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Bundle into a single file (default). Use --no-onefile for a folder build.",
    )
    parser.add_argument(
        "--clean",
        action="store_true",
        help="Pass --clean to PyInstaller and remove build/ first.",
    )
    parser.add_argument(
        "--name",
        default=APP_NAME,
        help="Name of the resulting executable (default: %(default)s).",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        print(
            "PyInstaller is not installed. Run\n"
            "    python -m pip install -r requirements-build.txt\n"
            "then re-run this script.",
            file=sys.stderr,
        )
        return 1

    if args.clean:
        for sub in ("build", "dist"):
            path = PROJECT_ROOT / sub
            if path.exists():
                shutil.rmtree(path)
        spec = PROJECT_ROOT / f"{args.name}.spec"
        if spec.exists():
            spec.unlink()

    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--windowed",
        "--name",
        args.name,
        f"--add-data={STATIC_DIR}{os.pathsep}static",
        "--collect-data=customtkinter",
        "--collect-all=webview",
        "--collect-all=pythonnet",
        "--collect-all=clr_loader",
    ]
    if args.onefile:
        cmd.append("--onefile")
    if args.clean:
        cmd.append("--clean")
    if ICON_PATH.exists():
        cmd.extend(["--icon", str(ICON_PATH)])
    cmd.append(str(ENTRY))

    print("Running:", " ".join(cmd))
    return subprocess.call(cmd, cwd=str(PROJECT_ROOT))


if __name__ == "__main__":
    raise SystemExit(main())
