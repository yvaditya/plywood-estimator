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

echo [+] Starting Plywood Estimator on http://localhost:5173 ...
start "" "http://localhost:5173/"
call npm run dev

endlocal
