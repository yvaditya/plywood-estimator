/**
 * Validation harness for the plate solver in app/src/cae.ts.
 *
 * Run from the app/ directory so the relative import + tsx resolve:
 *   cd app && npx tsx ../tests/cae_check.ts
 *
 * Three closed-form benchmarks (see the design). Prints PASS/FAIL per case
 * and exits non-zero if any case fails.
 */

import {
  solvePlate,
  rectOutline,
  bendingDForTest,
  type MaterialCard,
} from '../app/src/cae';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function iso(E: number, nu = 0.3): MaterialCard {
  const G = E / (2 * (1 + nu));
  return { id: 'test-iso', name: 'iso', eAlong: E, eAcross: E, gShear: G, density: 600, isotropic: true };
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

// A uniform pressure is applied here as a per-node equivalent point load by
// spreading it over all interior nodes. The solver's public API only takes a
// single point load, so for the UDL case we call it once per interior node…
// instead, simpler: for case (a) we use the solver's patch load capability by
// synthesising a UDL through many small solves is wasteful. We instead expose
// a pressure entrypoint via repeated superposition is overkill — so case (a)
// applies the total load as a set of nodal loads through the tiny helper below.

// ---------------------------------------------------------------------------
// Case (a): isotropic square, simply supported 4 edges, uniform pressure.
//   wmax = 0.00406 · q · a⁴ / D,  D = E t³ / (12 (1-ν²))
// We approximate the UDL by superposing point loads at every interior node
// (each carries pressure·cellArea). Because the solver is linear we can sum
// per-node solves — but that is N solves. Instead we drive the assembled
// system directly through a dedicated UDL path exported for the test.
// ---------------------------------------------------------------------------
import { solvePlateUniform } from '../app/src/cae';

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
// Case (b): narrow strip a × a/8, simply supported on the two SHORT ends,
//   centre point load. Beam theory: wmax = P L³ / (48 E I), I = b t³/12.
//   The two long edges are FREE. Span L = a along the long axis (x).
//   Short ends are left/right edges → 'simple'.
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

console.log('=== plate solver validation ===');
void bendingDForTest; // keep the import referenced
caseA();
caseB();
caseC();
console.log(anyFail ? '\nRESULT: FAIL' : '\nRESULT: all cases PASS');
process.exit(anyFail ? 1 : 0);
