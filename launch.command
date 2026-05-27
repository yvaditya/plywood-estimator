#!/bin/bash
# ---------------------------------------------------------------------
#  Plywood Estimator launcher (macOS)
#  Double-click in Finder to run. Source lives in ./app.
#  First time: in Terminal, run `chmod +x launch.command` to make it
#  executable. Then it's double-clickable forever after.
# ---------------------------------------------------------------------

set -u
cd "$(dirname "$0")/app"

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

echo "[+] Starting Plywood Estimator on http://localhost:5173 ..."
( sleep 2 && open "http://localhost:5173/" ) &

npm run dev
