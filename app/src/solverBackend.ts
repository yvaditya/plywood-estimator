/**
 * solverBackend.ts — optional sparse-direct linear-solve backend for the
 * assembly CAE (cae.ts).
 *
 * The heavy lifting is done by Eigen's SimplicialLDLT compiled to WebAssembly
 * (see app/native/solver.cpp + build.ps1). This module lazily loads that WASM
 * once and exposes a small, TS-friendly interface. If the module fails to load
 * (unsupported environment, missing artifact, WASM disabled), `getDirectSolver`
 * resolves to `null` and cae.ts transparently falls back to its pure-TS
 * Jacobi-PCG.
 *
 * Pipeline framing (kept deliberately visible in the UI stage labels):
 *   preprocessing (meshing / joints / materials) → OUR TypeScript
 *   the linear SOLVE                              → this open-source WASM core
 *   post-processing (stress recovery, viewer)     → the browser / our TS
 */

// Resolve the .wasm URL with the standard ESM idiom `new URL(rel,
// import.meta.url)`. Vite statically detects this and bundles + hashes the
// asset (emitting the right production URL); Node understands it natively (it
// resolves to a file:// URL the emscripten glue reads via fs). Passing it as
// `locateFile` makes the glue load the RIGHT wasm regardless of where the JS
// chunk ends up. This works in BOTH the browser app and the node/tsx test
// harness — unlike Vite's `?url` suffix, which node can't parse.
const wasmUrl = new URL('./wasm/eigen-solver.wasm', import.meta.url).href;
// The emscripten ES6 factory (default export). Typed loosely — it's generated.
import createEigenSolver from './wasm/eigen-solver.js';

/** The direct-solver backend surface consumed by cae.ts. */
export interface DirectSolver {
  /** Human name for logs / the result line. */
  readonly name: string;
  /**
   * Factorize a symmetric CSR (== CSC) SPD system. Returns false if the
   * numeric factorization fails (caller should fall back to PCG).
   */
  factorize(n: number, indptr: Int32Array, indices: Int32Array, data: Float64Array): boolean;
  /** Solve K x = rhs with the stored factorization. Returns null on failure. */
  solve(rhs: Float64Array): Float64Array | null;
  /** Release the factorization + matrix. */
  dispose(): void;
}

// Load-once memo. `undefined` = not attempted; a Promise once loading starts.
let loadPromise: Promise<DirectSolver | null> | undefined;

async function loadBackend(): Promise<DirectSolver | null> {
  try {
    const mod = await createEigenSolver({
      locateFile: (path: string) => (path.endsWith('.wasm') ? wasmUrl : path),
      // Swallow the module's own stdout/stderr chatter; we log our own lines.
      print: () => {},
      printErr: () => {},
    });
    if (!mod || typeof mod.factorize !== 'function') return null;

    return {
      name: 'Eigen LDLT (wasm)',
      factorize: (n, indptr, indices, data) => {
        try {
          return mod.factorize(n, indptr, indices, data);
        } catch {
          return false;
        }
      },
      solve: (rhs) => {
        try {
          const out = mod.solve(rhs);
          // A failed solve returns an empty array from the C++ side.
          if (!out || out.length !== rhs.length) return null;
          return out instanceof Float64Array ? out : Float64Array.from(out as ArrayLike<number>);
        } catch {
          return null;
        }
      },
      dispose: () => {
        try { mod.dispose(); } catch { /* ignore */ }
      },
    };
  } catch (err) {
    // Any failure (fetch, instantiate, unsupported) → no backend, use PCG.
    console.warn('[solverBackend] Eigen WASM backend unavailable — using PCG.', err);
    return null;
  }
}

/**
 * Resolve the direct (WASM) solver backend, or null if it can't load. The
 * result is memoized — the WASM is loaded at most once per session.
 *
 * Test/benchmark escape hatch: if `globalThis.__caeForcePcg` is truthy, this
 * resolves to null so the caller uses the PCG fallback — lets asm_bench.py time
 * PCG vs LDLT on the identical in-browser system without shipping a UI toggle.
 */
export function getDirectSolver(): Promise<DirectSolver | null> {
  if ((globalThis as { __caeForcePcg?: boolean }).__caeForcePcg) {
    return Promise.resolve(null);
  }
  if (!loadPromise) loadPromise = loadBackend();
  return loadPromise;
}

// ===========================================================================
// PyNite SIDECAR backend — a LOCAL Python structural-FE service (server/,
// FastAPI + PyNite) on http://localhost:8642. When reachable it is the PRIMARY
// assembly solver: we serialize the SAME preprocessed model cae.ts builds, POST
// it, and map the returned nodal displacements back into our DOF vector for the
// EXISTING stress recovery. Detection is once per session with a short timeout;
// any failure (not running, not installed, solve error) falls back to the WASM
// Eigen LDLT / PCG chain so the app always produces a result.
// ===========================================================================
import type { SidecarModel, AsyncAssemblySolver } from './cae';

/** Sidecar base URL. The launcher starts uvicorn on 8642; override via a global
 *  for tests if ever needed. */
const PYNITE_BASE = (globalThis as { __pyniteBase?: string }).__pyniteBase || 'http://localhost:8642';

let pyniteProbe: Promise<AsyncAssemblySolver | null> | undefined;

/** Fetch with a hard timeout (AbortController) — detection must never hang the
 *  UI when nothing is listening on the port. */
async function fetchTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function probePynite(): Promise<AsyncAssemblySolver | null> {
  // A test escape hatch to force-disable the sidecar (parallels __caeForcePcg).
  if ((globalThis as { __caeNoPynite?: boolean }).__caeNoPynite) return null;
  try {
    const res = await fetchTimeout(`${PYNITE_BASE}/health`, { method: 'GET' }, 800);
    if (!res.ok) return null;
    const info = await res.json().catch(() => null);
    if (!info || info.name !== 'pynite') return null;
    const version = String(info.version ?? '?');

    return {
      name: `PyNite ${version} (local sidecar)`,
      async solve(model: SidecarModel) {
        try {
          const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
          const r = await fetchTimeout(`${PYNITE_BASE}/solve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(model),
          }, 120_000);
          if (!r.ok) return null;
          const out = await r.json().catch(() => null);
          if (!out || !out.ok || !Array.isArray(out.disp)) return null;
          const disp = Float64Array.from(out.disp as number[]);
          const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
          const solveMs = out.stats?.solveMs ?? 0;
          const buildMs = out.stats?.buildMs ?? 0;
          const label = out.stats?.label ?? 'PyNite (isotropic E_eff)';
          void (now - t0);
          return { disp, solveMs, buildMs, label };
        } catch {
          return null;
        }
      },
    };
  } catch {
    // Not running / unreachable / CORS — no sidecar this session.
    return null;
  }
}

/**
 * Resolve the PyNite sidecar backend, or null if it isn't reachable. Memoized —
 * the /health probe runs at most once per session.
 */
export function getPyniteBackend(): Promise<AsyncAssemblySolver | null> {
  if (!pyniteProbe) pyniteProbe = probePynite();
  return pyniteProbe;
}
