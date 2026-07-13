# fetch-eigen.ps1 — download + unpack the pinned Eigen release (headers only).
#
# The archive and unpacked tree are NOT committed (see .gitignore). Only this
# script + the version pin (below, also in README.md) live in git, so a fresh
# clone can reproduce the exact headers used to build the WASM solver.
#
# Usage:  cd app/native ; ./fetch-eigen.ps1

$ErrorActionPreference = 'Stop'

# --- PIN ---------------------------------------------------------------------
$version = '3.4.0'
$url      = "https://gitlab.com/libeigen/eigen/-/archive/$version/eigen-$version.zip"
# SHA256 of eigen-3.4.0.zip from the gitlab archive endpoint (verified).
$sha256   = 'EBA3F3D414D2F8CBA2919C78EC6DAAB08FC71BA2BA4AE502B7E5D4D99FC02CDA'
# -----------------------------------------------------------------------------

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$dir  = Join-Path $here 'eigen'
$zip  = Join-Path $dir "eigen-$version.zip"
$dest = Join-Path $dir "eigen-$version"

New-Item -ItemType Directory -Force -Path $dir | Out-Null

if (Test-Path (Join-Path $dest 'Eigen\Sparse')) {
  Write-Host "Eigen $version already unpacked at $dest"
  exit 0
}

Write-Host "Downloading Eigen $version from $url ..."
Invoke-WebRequest -Uri $url -OutFile $zip

$got = (Get-FileHash -Algorithm SHA256 $zip).Hash
if ($got -ne $sha256) {
  throw "SHA256 mismatch!`n  expected $sha256`n  got      $got"
}
Write-Host "SHA256 OK: $got"

Write-Host "Unpacking to $dest ..."
Expand-Archive -Path $zip -DestinationPath $dir -Force

if (-not (Test-Path (Join-Path $dest 'Eigen\Sparse'))) {
  throw "Unpack did not produce $dest\Eigen\Sparse"
}
Write-Host "Done. Eigen headers at $dest"
