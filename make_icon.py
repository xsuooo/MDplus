#!/usr/bin/env python3
"""Generate the desktop icons from src/assets/app-icon.svg using the local Tauri CLI.

Requires Node.js and the project's npm dependencies; uses only Python's standard library.
Run `python make_icon.py`, or pass `--output PATH` to inspect an isolated build.
"""

import argparse
from pathlib import Path
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory


ROOT = Path(__file__).resolve().parent
OUTPUTS = (
    "icon.png",
    "32x32.png",
    "128x128.png",
    "128x128@2x.png",
    "icon.ico",
    "icon.icns",
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "src-tauri" / "icons")
    args = parser.parse_args()

    node = shutil.which("node")
    cli = ROOT / "node_modules" / "@tauri-apps" / "cli" / "tauri.js"
    source = ROOT / "src" / "assets" / "app-icon.svg"
    if not node:
        parser.error("Node.js is required to run the Tauri icon generator.")
    if not cli.is_file():
        parser.error("Local Tauri CLI not found. Run npm install first.")
    if not source.is_file():
        parser.error(f"Icon source not found: {source}")

    with TemporaryDirectory(prefix="mdplus-icons-") as staging:
        result = subprocess.run(
            [node, str(cli), "icon", str(source), "--output", staging],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        if result.returncode:
            print(result.stdout + result.stderr, file=sys.stderr)
            return result.returncode

        generated = [Path(staging) / name for name in OUTPUTS]
        if not all(path.is_file() for path in generated):
            parser.exit(1, "Tauri did not generate every required desktop icon.\n")

        output = args.output.resolve()
        output.mkdir(parents=True, exist_ok=True)
        for path in generated:
            shutil.copyfile(path, output / path.name)

    print(f"Generated {len(OUTPUTS)} desktop icons from {source}")
    print(f"Output: {output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
