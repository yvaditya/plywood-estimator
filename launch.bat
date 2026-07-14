@echo off
REM ---------------------------------------------------------------------
REM  Plywood Estimator launcher (Windows)
REM  Double-click to run. Source lives in .\app.
REM ---------------------------------------------------------------------

setlocal
cd /d "%~dp0app"

where node >nul 2>nul
if errorlevel 1 (
    echo [!] Node.js is not on PATH. Install Node 18+ from https://nodejs.org and re-run.
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo [+] First run: installing dependencies...
    call npm install
    if errorlevel 1 (
        echo [!] npm install failed.
        pause
        exit /b 1
    )
)

REM --- Optional: start the PyNite structural-FE sidecar (primary assembly
REM     CAE solver) in the background if PyNite is installed. The app works
REM     fine without it (falls back to the built-in WASM/PCG solver), so a
REM     missing sidecar is only a one-line hint, never a launch failure. ---
python -c "import Pynite" >nul 2>nul
if errorlevel 1 (
    echo [i] PyNite sidecar not installed — run: python -m pip install -r server/requirements.txt
) else (
    echo [+] Starting PyNite sidecar on http://localhost:8642 ...
    start "PyNite sidecar" /min /d "%~dp0" python -m uvicorn server.main:app --port 8642
)

echo [+] Starting Plywood Estimator on http://localhost:5173 ...
start "" "http://localhost:5173/"
call npm run dev

endlocal
