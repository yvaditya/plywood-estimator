#!/bin/bash
# ---------------------------------------------------------------------
#  Plywood Estimator launcher (macOS)
#  Double-click in Finder to run. Source lives in ./app.
#  First time: in Terminal, run `chmod +x launch.command` to make it
#  executable. Then it's double-clickable forever after.
# ---------------------------------------------------------------------

set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT/app"

if ! command -v node >/dev/null 2>&1; then
  echo "[!] Node.js is not installed."
  echo "    Install Node 18+ from https://nodejs.org and re-run."
  read -n 1 -s -r -p "Press any key to exit..."
  echo
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "[+] First run: installing dependencies (this can take a minute)..."
  npm install || { echo "[!] npm install failed."; read -n 1 -s -r -p "Press any key to exit..."; exit 1; }
fi

# --- Optional: start the PyNite structural-FE sidecar (primary assembly CAE
#     solver) in the background if PyNite is installed. The app works without
#     it (falls back to the built-in WASM/PCG solver), so a missing sidecar is
#     only a one-line hint, never a launch failure. ---
PY="$(command -v python3 || command -v python || true)"
if [ -n "$PY" ] && "$PY" -c "import Pynite" >/dev/null 2>&1; then
  echo "[+] Starting PyNite sidecar on http://localhost:8642 ..."
  ( cd "$ROOT" && "$PY" -m uvicorn server.main:app --port 8642 >/dev/null 2>&1 ) &
else
  echo "[i] PyNite sidecar not installed — run: python -m pip install -r server/requirements.txt"
fi

echo "[+] Starting Plywood Estimator on http://localhost:5173 ..."
( sleep 2 && open "http://localhost:5173/" ) &

npm run dev
