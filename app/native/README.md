# Native WASM solver — Eigen SimplicialLDLT

A minimal [embind](https://emscripten.org/docs/porting/connecting_cpp_and_javascript/embind.html)
wrapper around **Eigen's `SimplicialLDLT`** sparse-direct Cholesky, compiled to
WebAssembly. It is the fast linear-solve backend for the assembly CAE
(`app/src/cae.ts`); the pure-TS Jacobi-PCG is the automatic fallback whenever
this module can't load.

Built once, the artifacts are **committed** so end users never need emsdk:

```
app/src/wasm/eigen-solver.js     # emscripten ES6 glue (MODULARIZE + EXPORT_ES6)
app/src/wasm/eigen-solver.wasm   # ~47 KB
app/src/wasm/eigen-solver.d.ts   # hand-written types for the .js
```

`app/src/solverBackend.ts` loads it lazily (`getDirectSolver()`), resolving the
`.wasm` URL with `new URL('./wasm/eigen-solver.wasm', import.meta.url)` — a
standard ESM idiom that Vite bundles/hashes AND node resolves natively, so the
same code path works in the browser app and the `npx tsx` test harness.

## Why this exists

No maintained npm package exposes a sparse Cholesky over WASM (verified). Eigen
is header-only and MIT/MPL2-licensed, so a tiny embind wrapper is the right
path. The assembly stiffness matrix is a symmetric SPD CSR system up to ~60 000
DOF, penalty-conditioned (soft-grounding regularization can give near-singular
pivots) — `SimplicialLDLT` (not `LLT`) tolerates that.

### The CSR-loads-as-CSC trick

The caller hands us **CSR** (row pointer / column indices / values) — the format
`cae.ts` already builds. Eigen's `SparseMatrix<double>` is **column-major (CSC)**
by default. Because the matrix is **symmetric** (`K = Kᵀ`), its CSC
representation equals its CSR representation, so the caller's CSR arrays load
directly as CSC with no transpose. A debug build (`-UNDEBUG`) cheaply asserts
symmetry on a sample of entries. See the header comment in `solver.cpp`.

## Pinned versions

| Tool  | Version | Notes |
|-------|---------|-------|
| **emscripten (emsdk)** | **6.0.3** (`sdk-releases-9074aa513b501925adb1361e208932ad32a29a5f`) | `latest` at build time; installed to `C:\Users\yerra\emsdk` |
| **Eigen** | **3.4.0** | `https://gitlab.com/libeigen/eigen/-/archive/3.4.0/eigen-3.4.0.zip` |

Eigen archive SHA256 (verified):
`EBA3F3D414D2F8CBA2919C78EC6DAAB08FC71BA2BA4AE502B7E5D4D99FC02CDA`

## Rebuilding (only if you touch `solver.cpp`)

The Eigen source is **not** committed (`.gitignore` excludes `app/native/eigen/`).
Fetch it, then build:

```powershell
# 1. Install + activate emscripten (once). Downloads are large — be patient.
cd C:\Users\yerra\emsdk
.\emsdk.bat install latest
.\emsdk.bat activate latest      # → emcc 6.0.3

# 2. Fetch the pinned Eigen headers (verifies the SHA256).
cd <repo>\app\native
.\fetch-eigen.ps1

# 3. Compile → app/src/wasm/eigen-solver.{js,wasm}
.\build.ps1                       # or set $env:EMCC to the emcc path first
```

`build.ps1` finds `emcc` via `$env:EMCC`, then PATH, then the standard emsdk
location. If none is found it errors with instructions.

### Compile flags (see `build.ps1`)

`-O3 -DNDEBUG -DEIGEN_MPL2_ONLY -fno-exceptions -fno-rtti`
`-DEMSCRIPTEN_HAS_UNBOUND_TYPE_NAMES=0` (required by embind under `-fno-rtti`)
`-lembind -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,node`
`-sALLOW_MEMORY_GROWTH=1 -sEXPORT_NAME=createEigenSolver -sFILESYSTEM=0`
`-sDISABLE_EXCEPTION_CATCHING=1`
`-sSTACK_SIZE=5242880`

**`STACK_SIZE` is load-bearing.** Eigen's `SimplicialLDLT` fill-reducing
ordering (AMD) + elimination-tree traversal use a deep stack; the default 64 KB
WASM stack overflows around n ≈ 3000 DOF with a silent
`RuntimeError: memory access out of bounds`. 5 MB carries the full 60 000-DOF
budget (verified up to n = 60 000).

## Validation & benchmark

```
cd app && npx tsx ../tests/cae_check.ts   # 7 cases × both backends; e-agreement <1e-4
python tests/asm_bench.py                 # PCG vs LDLT timing on the workbench
```

Benchmark (plywood workbench, 50 kg preset, 58 452 DOF, in-browser):

| Backend | Time |
|---------|------|
| Eigen LDLT (wasm) | factorize **263 ms** + solve **6 ms** |
| Jacobi-PCG (fallback) | 348 iterations, **765 ms** |

LDLT is ~2.8× faster overall; re-solves after the factorization are ~6 ms
(vs PCG's full 765 ms), which matters for load-change re-solves.

## API (embind)

```ts
factorize(n, indptr: Int32Array, indices: Int32Array, data: Float64Array): boolean
solve(rhs: Float64Array): Float64Array          // empty array on failure
dispose(): void
```

`factorize` returns `false` (not a throw) on numeric failure, so the JS side
falls back to PCG.
