# build.ps1 — compile solver.cpp (Eigen SimplicialLDLT) to WebAssembly.
#
# Prereqs (see README.md):
#   1. emsdk installed + activated  (emcc on PATH, or set $env:EMCC below)
#   2. Eigen 3.4.0 headers unpacked at app/native/eigen/eigen-3.4.0/
#      (run fetch-eigen.ps1 first — the archive is NOT committed)
#
# Output (COMMITTED so end users never need emsdk):
#   app/src/wasm/eigen-solver.js
#   app/src/wasm/eigen-solver.wasm
#
# Usage:  cd app/native ; ./build.ps1
#         (or from anywhere: powershell -File app/native/build.ps1)

$ErrorActionPreference = 'Stop'

$here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$eigen   = Join-Path $here 'eigen\eigen-3.4.0'
$src     = Join-Path $here 'solver.cpp'
$outDir  = Resolve-Path (Join-Path $here '..\src\wasm') -ErrorAction SilentlyContinue
if (-not $outDir) {
  $outDir = Join-Path $here '..\src\wasm'
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
  $outDir = Resolve-Path $outDir
}
$outJs = Join-Path $outDir 'eigen-solver.js'

if (-not (Test-Path $eigen)) {
  throw "Eigen headers not found at $eigen. Run fetch-eigen.ps1 first."
}
if (-not (Test-Path $src)) {
  throw "solver.cpp not found at $src"
}

# Locate emcc. Prefer $env:EMCC, then PATH, then the standard emsdk location.
$emcc = $env:EMCC
if (-not $emcc) {
  $cmd = Get-Command emcc -ErrorAction SilentlyContinue
  if ($cmd) { $emcc = $cmd.Source }
}
if (-not $emcc) {
  $guess = 'C:\Users\yerra\emsdk\upstream\emscripten\emcc.exe'
  if (Test-Path $guess) { $emcc = $guess }
}
if (-not $emcc) {
  throw "emcc not found. Activate emsdk (emsdk_env) or set `$env:EMCC to the emcc path."
}
Write-Host "emcc: $emcc"
Write-Host "eigen: $eigen"
Write-Host "out:  $outJs"

# --- Compile flags ---
# -O3                     optimised
# -DNDEBUG                release (drops the debug symmetry assert)
# -DEIGEN_MPL2_ONLY       keep only MPL2-licensed Eigen modules (MIT-compatible)
# -fno-exceptions -fno-rtti  smaller binary; Eigen is fine without them here
#   (with -fno-rtti, embind needs -DEMSCRIPTEN_HAS_UNBOUND_TYPE_NAMES=0)
# -sMODULARIZE -sEXPORT_ES6  ES-module factory (import default, call to init)
# -sENVIRONMENT=web,node  cae_check runs under node/tsx; app runs in the browser
# -sALLOW_MEMORY_GROWTH   grow the heap for up to ~60k-DOF systems
# -sSTACK_SIZE=5MB        Eigen LDLT ordering needs a deep stack (see below)
# -sEXPORTED_RUNTIME_METHODS  convertJSArrayToNumberVector / typed_memory_view
# -sMODULARIZE names the factory; default export is the init function.
$args = @(
  $src,
  '-I', $eigen,
  '-O3',
  '-DNDEBUG',
  '-DEIGEN_MPL2_ONLY',
  '-fno-exceptions',
  '-fno-rtti',
  '-DEMSCRIPTEN_HAS_UNBOUND_TYPE_NAMES=0',
  '-std=c++17',
  '-lembind',
  '-sMODULARIZE=1',
  '-sEXPORT_ES6=1',
  '-sENVIRONMENT=web,node',
  '-sALLOW_MEMORY_GROWTH=1',
  '-sEXPORT_NAME=createEigenSolver',
  '-sFILESYSTEM=0',
  '-sDISABLE_EXCEPTION_CATCHING=1',
  # Eigen's SimplicialLDLT fill-reducing ordering (AMD) + elimination-tree
  # traversal use a deep stack; the default 64 KB WASM stack overflows around
  # n≈3000 DOF (silent "memory access out of bounds"). 5 MB carries 60k DOF.
  '-sSTACK_SIZE=5242880',
  '-o', $outJs
)

Write-Host "`nemcc $($args -join ' ')`n"
& $emcc @args
if ($LASTEXITCODE -ne 0) { throw "emcc failed with exit code $LASTEXITCODE" }

$wasm = Join-Path $outDir 'eigen-solver.wasm'
$sz = (Get-Item $wasm).Length
Write-Host ("`nBuilt eigen-solver.wasm  =  {0:N0} bytes  ({1:N1} KB)" -f $sz, ($sz / 1KB))
Write-Host "Built eigen-solver.js    =  $((Get-Item $outJs).Length) bytes"
