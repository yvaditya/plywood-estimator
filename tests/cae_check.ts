/**
 * Validation harness for the plate + assembly solver in app/src/cae.ts.
 *
 * Run from the app/ directory so the relative import + tsx resolve:
 *   cd app && npx tsx ../tests/cae_check.ts
 *
 * SEVEN closed-form / consistency benchmarks (see the design). Prints PASS/FAIL
 * per case and exits non-zero if any case fails.
 *
 * BACKENDS: the assembly cases (e, f, g) run against BOTH linear backends when
 * the Eigen SimplicialLDLT WASM module loads under node:
 *   • PCG               — the built-in Jacobi-preconditioned CG (always run)
 *   • Eigen LDLT (wasm) — the sparse-direct core (run when it loads)
 * Every case must PASS on every available backend. Case (e) additionally
 * asserts the two backends agree numerically (max |w_LDLT − w_PCG| relative
 * difference < 1e-4). The per-panel cases (a–d) use the pure-TS per-panel PCG
 * path (tiny systems, no direct backend) and run once.
 */

import {
  solvePlate,
  rectOutline,
  bendingDForTest,
  detectJoints,
  solveAssembly,
  serializeAssembly,
  recoverAssembly,
  type MaterialCard,
  type AsmPanel,
  type AsmResult,
  type AsmSolveOptions,
  type JointStiffness,
  type DirectLinearSolver,
} from '../app/src/cae';
import { getDirectSolver } from '../app/src/solverBackend';

// A pluggable assembly solver: the in-process backends wrap solveAssembly; the
// PyNite path serializes → POSTs → recovers. All three cases run against each.
type AsmSolveFn = (opts: AsmSolveOptions) => Promise<AsmResult>;

const PYNITE_BASE = process.env.PYNITE_BASE || 'http://localhost:8642';

/** Is the PyNite sidecar reachable? (node's global fetch, short timeout.) */
async function pyniteReachable(): Promise<{ ok: boolean; version?: string }> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1000);
    const r = await fetch(`${PYNITE_BASE}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return { ok: false };
    const j = await r.json();
    return j && j.name === 'pynite' ? { ok: true, version: String(j.version) } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** Solve one assembly through the PyNite sidecar: serialize the SAME model,
 *  POST, map displacements back, recover on OUR B-matrices. */
async function solveViaPynite(opts: AsmSolveOptions): Promise<AsmResult> {
  const ser = serializeAssembly(opts);
  const empty = (msg: string): AsmResult => ({
    ok: false, message: msg, panels: [], maxDisp: 0, maxPanelId: -1, maxAt: [0, 0],
    spanMm: 0, verdict: 'ok', maxVm: 0, maxVmPanelId: -1, maxVmAt: [0, 0],
    utilPct: 0, stressVerdict: 'ok', totalDof: 0, totalNodes: 0, iterations: 0,
    converged: false, backend: 'PyNite (isotropic E_eff)', factorMs: 0, solveMs: 0,
    groundedNodes: 0, resolutionLog: '', groundPoints: [],
  });
  if (!ser.ok) return empty(ser.message);
  const r = await fetch(`${PYNITE_BASE}/solve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ser.model),
  });
  if (!r.ok) return empty(`sidecar HTTP ${r.status}`);
  const out = await r.json();
  if (!out || !out.ok || !Array.isArray(out.disp)) return empty(out?.message ?? 'sidecar solve failed');
  const disp = Float64Array.from(out.disp as number[]);
  if (disp.length !== ser.pre.nDof) return empty(`disp size ${disp.length} ≠ nDof ${ser.pre.nDof}`);
  return recoverAssembly(ser.pre, disp, opts.panels, 'PyNite (isotropic E_eff)',
    out.stats?.buildMs ?? 0, out.stats?.solveMs ?? 0);
}

/** Wrap the in-process solveAssembly as an AsmSolveFn (backend baked in). */
function inProcess(backend: DirectLinearSolver | null): AsmSolveFn {
  return async (opts) => solveAssembly({ ...opts, backend });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function iso(E: number, nu = 0.3): MaterialCard {
  const G = E / (2 * (1 + nu));
  return { id: 'test-iso', name: 'iso', eAlong: E, eAcross: E, gShear: G, density: 600, isotropic: true, fbAlong: 40, fbAcross: 40 };
}

let anyFail = false;
function report(name: string, got: number, want: number, tolPct: number, extra = '') {
  const err = Math.abs(got - want) / Math.abs(want) * 100;
  const pass = err <= tolPct;
  if (!pass) anyFail = true;
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(
    `[${tag}] ${name}\n` +
    `        got   = ${got.toExponential(5)}\n` +
    `        theory= ${want.toExponential(5)}\n` +
    `        error = ${err.toFixed(2)}%  (tol ${tolPct}%)${extra ? '  ' + extra : ''}`,
  );
}

import { solvePlateUniform } from '../app/src/cae';

// ---------------------------------------------------------------------------
// Case (a): isotropic square, simply supported 4 edges, uniform pressure.
//   wmax = 0.00406 · q · a⁴ / D,  D = E t³ / (12 (1-ν²))
// ---------------------------------------------------------------------------
function caseA() {
  const a = 1000;      // mm square
  const t = 12;        // mm
  const E = 8000;      // MPa
  const nu = 0.3;
  const q = 0.01;      // N/mm² pressure (== MPa)
  const D = (E * t * t * t) / (12 * (1 - nu * nu));
  const theory = 0.00406 * q * Math.pow(a, 4) / D;

  const res = solvePlateUniform({
    outline: rectOutline(a, a),
    thicknessMm: t,
    material: iso(E, nu),
    grainAlongLength: true,
    supports: { top: 'simple', bottom: 'simple', left: 'simple', right: 'simple' },
    pressureN: q,
    targetNodes: 4500,
  });
  report(`(a) SS square, UDL  [${res.activeNodes} nodes, ${res.iterations} it]`, res.maxAbsW, theory, 8);
}

// ---------------------------------------------------------------------------
// Case (b): narrow strip a × a/8, SS on the two SHORT ends, centre point load.
//   Beam theory: wmax = P L³ / (48 E I), I = b t³/12.
// ---------------------------------------------------------------------------
function caseB() {
  const L = 1000;      // span (long axis)
  const b = L / 8;     // width
  const t = 12;
  const E = 8000;
  const P = 200;       // N
  const I = (b * t * t * t) / 12;
  const theory = (P * L * L * L) / (48 * E * I);

  const res = solvePlate({
    outline: rectOutline(L, b),
    thicknessMm: t,
    material: iso(E, 0.3),
    grainAlongLength: true,
    supports: { top: 'free', bottom: 'free', left: 'simple', right: 'simple' },
    forceN: P,
    loadX: L / 2,
    loadY: b / 2,
    targetNodes: 4500,
  });
  report(`(b) SS strip, centre P  [${res.activeNodes} nodes, ${res.iterations} it]`, res.maxAbsW, theory, 15);
}

// ---------------------------------------------------------------------------
// Case (c): same strip, FIXED both short ends, centre point load.
//   wmax = P L³ / (192 E I).
// ---------------------------------------------------------------------------
function caseC() {
  const L = 1000;
  const b = L / 8;
  const t = 12;
  const E = 8000;
  const P = 200;
  const I = (b * t * t * t) / 12;
  const theory = (P * L * L * L) / (192 * E * I);

  const res = solvePlate({
    outline: rectOutline(L, b),
    thicknessMm: t,
    material: iso(E, 0.3),
    grainAlongLength: true,
    supports: { top: 'free', bottom: 'free', left: 'fixed', right: 'fixed' },
    forceN: P,
    loadX: L / 2,
    loadY: b / 2,
    targetNodes: 4500,
  });
  report(`(c) Fixed strip, centre P  [${res.activeNodes} nodes, ${res.iterations} it]`, res.maxAbsW, theory, 20);
}

// ---------------------------------------------------------------------------
// Case (d): same strip, all four edges FREE, two PINS at the mid-height of each
//   short end, centre point load. wmax = P L³ / (48 E I).
// ---------------------------------------------------------------------------
function caseD() {
  const L = 1000;
  const b = L / 8;
  const t = 12;
  const E = 8000;
  const P = 200;
  const I = (b * t * t * t) / 12;
  const theory = (P * L * L * L) / (48 * E * I);

  const res = solvePlate({
    outline: rectOutline(L, b),
    thicknessMm: t,
    material: iso(E, 0.3),
    grainAlongLength: true,
    supports: { top: 'free', bottom: 'free', left: 'free', right: 'free' },
    pointSupports: [{ x: 0, y: b / 2 }, { x: L, y: b / 2 }],
    loads: [{ x: L / 2, y: b / 2, N: P, shape: 'round', size: 0 }],
    targetNodes: 4500,
  });
  report(`(d) Two-pin strip, centre P  [${res.activeNodes} nodes, ${res.iterations} it]`, res.maxAbsW, theory, 20);
}

function mkPanel(
  id: number, label: string, L: number, W: number, t: number, mat: MaterialCard,
  origin: [number, number, number],
  uAxis: [number, number, number], vAxis: [number, number, number], normal: [number, number, number],
): AsmPanel {
  return {
    id, label, outline: rectOutline(L, W), thicknessMm: t, material: mat,
    grainAlongLength: true, origin, uAxis, vAxis, normal,
  };
}

// ---------------------------------------------------------------------------
// Case (e): ASSEMBLY — a continuous upright panel vs the same panel split at
//   its middle and rigidly re-joined. Rigid coupling ⇒ within 12%.
//   Returns rTwo.maxDisp (for the cross-backend agreement check on (e)).
// ---------------------------------------------------------------------------
async function caseE(solve: AsmSolveFn, label: string, tolPct: number): Promise<number> {
  const L = 800;    // total length (runs along world X)
  const W = 200;    // width (runs along world Y)
  const t = 12;
  const mat = iso(8000, 0.3);
  const uAxis: [number, number, number] = [1, 0, 0];
  const upV: [number, number, number] = [0, 0, 1];   // width runs UP (Z)
  const upN: [number, number, number] = [0, 1, 0];   // face normal +Y

  const one = [mkPanel(1, '1', L, W, t, mat, [0, 0, 0], uAxis, upV, upN)];
  const jOne = detectJoints(one, 2);
  const rOne = await solve({
    panels: one, joints: jOne, tolMm: 2,
    loads: [{ panelId: 1, x: L / 2, y: W, N: 200, shape: 'round', size: 0 }],
  });

  const half = L / 2;
  const two = [
    mkPanel(1, '1', half, W, t, mat, [0, 0, 0], uAxis, upV, upN),
    mkPanel(2, '2', half, W, t, mat, [half, 0, 0], uAxis, upV, upN),
  ];
  const jTwo = detectJoints(two, 2).map((j) => ({ ...j, stiffness: 'rigid' as JointStiffness }));
  const rTwo = await solve({
    panels: two, joints: jTwo, tolMm: 2,
    loads: [{ panelId: 1, x: half, y: W, N: 200, shape: 'round', size: 0 }],
  });

  const seamJoints = jTwo.length;
  if (!rOne.ok || !rTwo.ok) {
    anyFail = true;
    console.log(`[FAIL] (e)[${label}] assembly setup — one.ok=${rOne.ok} two.ok=${rTwo.ok}` +
      ` (${rOne.message ?? ''} / ${rTwo.message ?? ''}); seam joints=${seamJoints}`);
    return NaN;
  }
  report(
    `(e)[${label}] rigid seam ≈ continuous  [${rTwo.totalNodes} nodes, ${rTwo.backend}, ${seamJoints} seam joint(s)]`,
    rTwo.maxDisp, rOne.maxDisp, tolPct,
  );
  return rTwo.maxDisp;
}

// ---------------------------------------------------------------------------
// Case (f): MONOTONICITY — L-config, tip load. Must satisfy
//   hinged > semi-rigid > rigid, all finite.
// ---------------------------------------------------------------------------
async function caseF(solve: AsmSolveFn, label: string) {
  const t = 12;
  const mat = iso(8000, 0.3);
  const H = 500;   // vertical panel height (Z)
  const Wv = 400;  // vertical panel width (X)
  const D = 350;   // shelf depth (Y)

  const vert = mkPanel(1, 'V', Wv, H, t, mat, [0, 0, 0], [1, 0, 0], [0, 0, 1], [0, 1, 0]);
  const shelf = mkPanel(2, 'S', Wv, D, t, mat, [0, 0, H], [1, 0, 0], [0, 1, 0], [0, 0, 1]);

  const run = async (stiff: JointStiffness) => {
    const panels = [vert, shelf];
    const joints = detectJoints(panels, 3).map((j) => ({ ...j, stiffness: stiff }));
    const res = await solve({
      panels, joints, tolMm: 3,
      loads: [{ panelId: 2, x: Wv / 2, y: D, N: 300, shape: 'round', size: 0 }],
    });
    return { res, joints: joints.length };
  };

  const rig = await run('rigid');
  const semi = await run('semi-rigid');
  const hin = await run('hinged');

  const jc = rig.joints;
  const all = [rig.res, semi.res, hin.res];
  if (all.some((r) => !r.ok || !Number.isFinite(r.maxDisp))) {
    anyFail = true;
    console.log(`[FAIL] (f)[${label}] L-config setup — ok=[${all.map((r) => r.ok)}] ` +
      `msgs=[${all.map((r) => r.message ?? '').join(' | ')}]  joints=${jc}`);
    return;
  }
  const dr = rig.res.maxDisp, ds = semi.res.maxDisp, dh = hin.res.maxDisp;
  const mono = dh > ds && ds > dr;
  if (!mono) anyFail = true;
  console.log(
    `[${mono ? 'PASS' : 'FAIL'}] (f)[${label}] L monotonicity  [${jc} joint(s), ${rig.res.backend}]\n` +
    `        rigid      = ${dr.toExponential(4)} mm\n` +
    `        semi-rigid = ${ds.toExponential(4)} mm\n` +
    `        hinged     = ${dh.toExponential(4)} mm\n` +
    `        require hinged > semi-rigid > rigid  → ${mono ? 'ok' : 'VIOLATED'}`,
  );
}

// ---------------------------------------------------------------------------
// Case (g): STRESS RECOVERY — SS strip, centre point load. Recovered surface
//   von Mises at the strip centre ≈ 1.5·P·L/(w·t²).
// ---------------------------------------------------------------------------
async function caseG(solve: AsmSolveFn, label: string, tolPct: number) {
  const L = 240;    // support spacing = SS span (world X); L/t ≈ 12
  const w = 120;    // strip width (world Y)
  const t = 20;     // thickness
  const H = 80;     // leg height
  const ov = 20;    // small strip overhang beyond each support
  const E = 8000;
  const P = 600;    // N, centre point load
  const mat = iso(E, 0.3);

  const theory = (1.5 * P * L) / (w * t * t);

  const strip = mkPanel(1, 'S', L + 2 * ov, w, t, mat, [-ov, 0, H], [1, 0, 0], [0, 1, 0], [0, 0, 1]);
  const legL = mkPanel(2, 'L', w, H, t, mat, [0, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0, 0]);
  const legR = mkPanel(3, 'R', w, H, t, mat, [L, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0, 0]);

  const panels = [strip, legL, legR];
  const joints = detectJoints(panels, 3).map((j) => ({ ...j, stiffness: 'hinged' as JointStiffness }));
  const res = await solve({
    panels, joints, tolMm: 3,
    loads: [{ panelId: 1, x: L / 2 + ov, y: w / 2, N: P, shape: 'round', size: 0 }],
  });

  if (!res.ok || !Number.isFinite(res.maxVm)) {
    anyFail = true;
    console.log(`[FAIL] (g)[${label}] SS strip stress setup — ok=${res.ok} maxVm=${res.maxVm} ` +
      `msg=${res.message ?? ''} joints=${joints.length}`);
    return;
  }
  report(
    `(g)[${label}] SS strip, centre P — surface stress  [${res.totalNodes} nodes, ${res.backend}, ${joints.length} joint(s)]`,
    res.maxVm, theory, tolPct,
    `util=${res.utilPct.toFixed(0)}%`,
  );
}

async function main() {
  console.log('=== plate + assembly solver validation ===');
  void bendingDForTest; // keep the import referenced

  // Per-panel plate cases (a–d): pure-TS per-panel PCG, backend-agnostic.
  caseA();
  caseB();
  caseC();
  caseD();

  // Try to load the sparse-direct WASM backend. null → only the PCG pass runs.
  const wasm = await getDirectSolver();

  // In-process backends (Eigen/PCG): case (e) 12%, case (g) 15% (tight).
  const backends: { solve: AsmSolveFn; label: string; eTol: number; gTol: number }[] = [
    { solve: inProcess(null), label: 'PCG', eTol: 12, gTol: 15 },
  ];
  if (wasm) {
    backends.push({ solve: inProcess(wasm), label: 'LDLT', eTol: 12, gTol: 15 });
    console.log(`\n--- Eigen LDLT (wasm) backend loaded: running assembly cases on BOTH backends ---`);
  } else {
    console.log(`\n--- Eigen LDLT (wasm) backend NOT available under node: PCG only ---`);
  }

  // The PyNite sidecar, when reachable, is the PRIMARY assembly solver. Its
  // isotropic-E_eff quad + different element → looser tolerances per the design:
  //   case (e) 15% (vs Eigen 12%), case (g) 20% (vs Eigen 15%), (f) monotonic.
  const py = await pyniteReachable();
  if (py.ok) {
    backends.push({ solve: solveViaPynite, label: 'PyNite', eTol: 15, gTol: 20 });
    console.log(`--- PyNite sidecar reachable (v${py.version}): running assembly cases through it too ---`);
  } else {
    console.log(`--- PyNite sidecar NOT reachable at ${PYNITE_BASE}: skipping PyNite assembly cases ---`);
  }

  // Assembly cases (e, f, g) on every available backend.
  const caseE_disp: Record<string, number> = {};
  for (const { solve, label, eTol, gTol } of backends) {
    console.log(`\n[backend: ${label}]`);
    caseE_disp[label] = await caseE(solve, label, eTol);
    await caseF(solve, label);
    await caseG(solve, label, gTol);
  }

  // Cross-backend numerical agreement on case (e): the direct LDLT solve and
  // the PCG solve of the SAME split-panel system must agree to < 1e-4 relative.
  if (wasm && Number.isFinite(caseE_disp['PCG']) && Number.isFinite(caseE_disp['LDLT'])) {
    const rel = Math.abs(caseE_disp['LDLT'] - caseE_disp['PCG']) / Math.abs(caseE_disp['PCG']);
    const pass = rel < 1e-4;
    if (!pass) anyFail = true;
    console.log(
      `\n[${pass ? 'PASS' : 'FAIL'}] (e) cross-backend agreement (LDLT vs PCG)\n` +
      `        w_PCG  = ${caseE_disp['PCG'].toExponential(8)} mm\n` +
      `        w_LDLT = ${caseE_disp['LDLT'].toExponential(8)} mm\n` +
      `        rel diff = ${rel.toExponential(3)}  (tol 1e-4)`,
    );
  }

  // PyNite-vs-Eigen agreement on case (e) (REPORT ONLY — different element +
  // isotropic approximation, so we don't gate on it).
  if (py.ok && Number.isFinite(caseE_disp['PyNite']) && Number.isFinite(caseE_disp['PCG'])) {
    const rel = Math.abs(caseE_disp['PyNite'] - caseE_disp['PCG']) / Math.abs(caseE_disp['PCG']);
    console.log(
      `\n[report] (e) PyNite vs Eigen/PCG (informational)\n` +
      `        w_PCG    = ${caseE_disp['PCG'].toExponential(6)} mm\n` +
      `        w_PyNite = ${caseE_disp['PyNite'].toExponential(6)} mm\n` +
      `        rel diff = ${(rel * 100).toFixed(2)}%`,
    );
  }

  // Workbench-style box model — max-deflection delta PyNite vs Eigen + solve
  // times (REPORT ONLY, never gates). A 5-panel loaded cabinet is representative
  // of the real workbench assembly the app solves.
  if (py.ok && wasm) {
    await workbenchDelta(inProcess(wasm), solveViaPynite);
  }

  console.log(anyFail ? '\nRESULT: FAIL' : '\nRESULT: all cases PASS');
  process.exit(anyFail ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Workbench-style cabinet — a floor-grounded box (2 sides, back, bottom, top)
// with a load on the top. Reports the PyNite-vs-Eigen max-deflection delta and
// each backend's solve time. Informational only.
// ---------------------------------------------------------------------------
async function workbenchDelta(eigen: AsmSolveFn, pynite: AsmSolveFn) {
  const t = 18;
  const mat = iso(9000, 0.3);
  const Wd = 800, Dp = 600, Ht = 900; // width, depth, height (mm)
  // Two sides (X-const planes), a back (Y-const), bottom + top (Z-const).
  const left = mkPanel(1, 'L', Dp, Ht, t, mat, [0, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0, 0]);
  const right = mkPanel(2, 'R', Dp, Ht, t, mat, [Wd, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0, 0]);
  const back = mkPanel(3, 'B', Wd, Ht, t, mat, [0, Dp, 0], [1, 0, 0], [0, 0, 1], [0, 1, 0]);
  const bottom = mkPanel(4, 'Bo', Wd, Dp, t, mat, [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]);
  const top = mkPanel(5, 'T', Wd, Dp, t, mat, [0, 0, Ht], [1, 0, 0], [0, 1, 0], [0, 0, 1]);
  const panels = [left, right, back, bottom, top];
  const joints = detectJoints(panels, 4).map((j) => ({ ...j, stiffness: 'rigid' as JointStiffness }));
  const loads = [{ panelId: 5, x: Wd / 2, y: Dp / 2, N: 500, shape: 'square' as const, size: 300 }];

  const optsBase: AsmSolveOptions = { panels, joints, loads, tolMm: 4 };
  const rE = await eigen(optsBase);
  const rP = await pynite(optsBase);
  if (!rE.ok || !rP.ok) {
    console.log(`\n[report] workbench box delta — setup failed (eigen.ok=${rE.ok} pynite.ok=${rP.ok})`);
    return;
  }
  const rel = Math.abs(rP.maxDisp - rE.maxDisp) / Math.abs(rE.maxDisp || 1) * 100;
  console.log(
    `\n[report] workbench box (5 panels, ${rE.totalNodes} nodes) — max-deflection PyNite vs Eigen\n` +
    `        Eigen  maxDisp = ${rE.maxDisp.toExponential(4)} mm  (factor ${rE.factorMs.toFixed(0)} + solve ${rE.solveMs.toFixed(0)} ms)\n` +
    `        PyNite maxDisp = ${rP.maxDisp.toExponential(4)} mm  (build ${rP.factorMs.toFixed(0)} + solve ${rP.solveMs.toFixed(0)} ms)\n` +
    `        delta = ${rel.toFixed(2)}%  (informational — isotropic E_eff + different element)`,
  );
}

void main();
