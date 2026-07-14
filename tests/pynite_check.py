"""
CI-style check for the PyNite sidecar + the frontend integration.

Boots the PyNite FastAPI sidecar (server/main.py) as a subprocess on port 8642,
waits for /health, runs the TypeScript validation harness (tests/cae_check.ts)
with the sidecar UP so the PyNite assembly cases (e, f, g) run, then kills the
sidecar. Exits non-zero if the sidecar can't start or cae_check fails.

Run:  python tests/pynite_check.py
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
APP_DIR = REPO / "app"
PORT = 8642
BASE = f"http://localhost:{PORT}"


def wait_health(timeout_s: float = 30.0) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{BASE}/health", timeout=1.5) as r:
                if r.status == 200 and b"pynite" in r.read():
                    return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def main() -> int:
    # Verify PyNite imports at all first (clear message if not installed).
    try:
        import Pynite  # noqa: F401
    except Exception as exc:  # pragma: no cover
        print(f"[pynite_check] PyNite not importable: {exc}")
        print("[pynite_check] install with: python -m pip install -r server/requirements.txt")
        return 1

    print(f"[pynite_check] booting sidecar on {BASE} ...")
    env = dict(os.environ)
    env["PYTHONPATH"] = str(REPO) + os.pathsep + env.get("PYTHONPATH", "")
    sidecar = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "server.main:app", "--port", str(PORT),
         "--log-level", "warning"],
        cwd=str(REPO),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
    )
    try:
        if not wait_health():
            print("[pynite_check] sidecar did not become healthy in time")
            return 1
        print("[pynite_check] sidecar healthy — running cae_check.ts with PyNite UP")

        npx = "npx.cmd" if os.name == "nt" else "npx"
        proc = subprocess.run(
            [npx, "tsx", str(REPO / "tests" / "cae_check.ts")],
            cwd=str(APP_DIR),
            env=dict(env, PYNITE_BASE=BASE),
        )
        if proc.returncode != 0:
            print(f"[pynite_check] cae_check.ts FAILED (exit {proc.returncode})")
            return proc.returncode
        print("[pynite_check] cae_check.ts PASSED with the sidecar up")
        return 0
    finally:
        if sidecar.poll() is None:
            sidecar.terminate()
            try:
                sidecar.wait(timeout=5)
            except subprocess.TimeoutExpired:
                sidecar.kill()
        print("[pynite_check] sidecar stopped")


if __name__ == "__main__":
    raise SystemExit(main())
