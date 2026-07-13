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
  detectJoints,
  solveAssembly,
  type MaterialCard,
  type AsmPanel,
  type JointStiffness,
} from '../app/src/cae';

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

// ---------------------------------------------------------------------------
// Case (d): same strip, all four edges FREE, but two PINS (point supports) at
//   the mid-height of each short end, centre point load. Two pins at the span
//   ends ≈ a simply-supported beam: wmax = P L³ / (48 E I).
//   Coarser than the edge-supported case (a single node carries each reaction),
//   so allow 20%.
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

// ---------------------------------------------------------------------------
// Case (e): ASSEMBLY — two coplanar strips rigidly joined along their shared
//   seam should behave like one continuous strip. We build a single strip of
//   length L (SS on both short ends via floor grounding of the two end
//   columns) and compare its centre sag to the same strip cut in half at the
//   middle and rigidly re-joined. Rigid coupling ⇒ within 12%.
//
// The assembly solver grounds nodes at z≈floor, so we lay the strip flat and
// ground the two short-end edges by placing tiny "foot" strips? Simpler: we
// exploit that grounding is translational at z=0. We orient the strip in the
// XZ plane won't ground the interior. Instead we validate the JOINT itself:
//   compare a ONE-piece flat panel (grounded along one long edge, tip loaded)
//   to the SAME geometry split into two panels rigidly joined at the seam.
//   Continuous seam ⇒ the split assembly's tip deflection ≈ the one-piece
//   assembly's (within 12%).
// ---------------------------------------------------------------------------
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

function caseE() {
  const L = 800;    // total length (runs along world X)
  const W = 200;    // width (runs along world Y)
  const t = 12;
  const mat = iso(8000, 0.3);
  // Panel lies flat in the XY plane at z=0 (grounded across its whole base row
  // near y=0). Load pushes down (−Z) at the far edge (y=W).
  const normal: [number, number, number] = [0, 0, 1];
  const uAxis: [number, number, number] = [1, 0, 0];
  const vAxis: [number, number, number] = [0, 1, 0];

  // Because grounding is at z≈0 and the flat panel is entirely at z≈0, we tilt
  // the panel to stand upright: vAxis = +Z, so the base edge (v=0) sits on the
  // floor. Load at the top edge along −Z? A cantilever standing up.
  const upV: [number, number, number] = [0, 0, 1];   // width runs UP (Z)
  const upN: [number, number, number] = [0, 1, 0];   // face normal +Y

  // One continuous upright panel L(x) × W(z), base on floor.
  const one = [mkPanel(1, '1', L, W, t, mat, [0, 0, 0], uAxis, upV, upN)];
  const jOne = detectJoints(one, 2);
  const rOne = solveAssembly({
    panels: one, joints: jOne, tolMm: 2,
    loads: [{ panelId: 1, x: L / 2, y: W, N: 200, shape: 'round', size: 0 }],
  });

  // Same panel split at x=L/2 into two panels rigidly joined at the seam.
  const half = L / 2;
  const two = [
    mkPanel(1, '1', half, W, t, mat, [0, 0, 0], uAxis, upV, upN),
    mkPanel(2, '2', half, W, t, mat, [half, 0, 0], uAxis, upV, upN),
  ];
  const jTwo = detectJoints(two, 2).map((j) => ({ ...j, stiffness: 'rigid' as JointStiffness }));
  const rTwo = solveAssembly({
    panels: two, joints: jTwo, tolMm: 2,
    // Load at the seam-top on panel 1's far edge (x=half is the seam).
    loads: [{ panelId: 1, x: half, y: W, N: 200, shape: 'round', size: 0 }],
  });

  const seamJoints = jTwo.length;
  if (!rOne.ok || !rTwo.ok) {
    anyFail = true;
    console.log(`[FAIL] (e) assembly setup — one.ok=${rOne.ok} two.ok=${rTwo.ok}` +
      ` (${rOne.message ?? ''} / ${rTwo.message ?? ''}); seam joints=${seamJoints}`);
    return;
  }
  report(
    `(e) rigid seam ≈ continuous  [${rTwo.totalNodes} nodes, ${rTwo.iterations} it, ${seamJoints} seam joint(s)]`,
    rTwo.maxDisp, rOne.maxDisp, 12,
  );
}

// ---------------------------------------------------------------------------
// Case (f): MONOTONICITY — an L: a vertical panel standing on the floor, a
//   horizontal shelf jointed to its top edge, tip load on the shelf's free
//   edge. Tip deflection must satisfy hinged > semi-rigid > rigid, all finite.
// ---------------------------------------------------------------------------
function caseF() {
  const t = 12;
  const mat = iso(8000, 0.3);
  const H = 500;   // vertical panel height (Z)
  const Wv = 400;  // vertical panel width (X)
  const D = 350;   // shelf depth (Y)

  // Vertical panel: spans X (u) × Z (v), face normal +Y, base at z=0.
  const vert = mkPanel(1, 'V', Wv, H, t, mat, [0, 0, 0], [1, 0, 0], [0, 0, 1], [0, 1, 0]);
  // Horizontal shelf: spans X (u) × Y (v), face normal +Z, sitting at z=H,
  // jointed to the vertical panel's TOP edge (z=H, y=0).
  const shelf = mkPanel(2, 'S', Wv, D, t, mat, [0, 0, H], [1, 0, 0], [0, 1, 0], [0, 0, 1]);

  const run = (stiff: JointStiffness) => {
    const panels = [vert, shelf];
    const joints = detectJoints(panels, 3).map((j) => ({ ...j, stiffness: stiff }));
    const res = solveAssembly({
      panels, joints, tolMm: 3,
      // Load at the shelf's free front edge (y=D), pushing down.
      loads: [{ panelId: 2, x: Wv / 2, y: D, N: 300, shape: 'round', size: 0 }],
    });
    return { res, joints: joints.length };
  };

  const rig = run('rigid');
  const semi = run('semi-rigid');
  const hin = run('hinged');

  const jc = rig.joints;
  const all = [rig.res, semi.res, hin.res];
  if (all.some((r) => !r.ok || !Number.isFinite(r.maxDisp))) {
    anyFail = true;
    console.log(`[FAIL] (f) L-config setup — ok=[${all.map((r) => r.ok)}] ` +
      `msgs=[${all.map((r) => r.message ?? '').join(' | ')}]  joints=${jc}`);
    return;
  }
  const dr = rig.res.maxDisp, ds = semi.res.maxDisp, dh = hin.res.maxDisp;
  const mono = dh > ds && ds > dr;
  if (!mono) anyFail = true;
  console.log(
    `[${mono ? 'PASS' : 'FAIL'}] (f) L monotonicity  [${jc} joint(s)]\n` +
    `        rigid      = ${dr.toExponential(4)} mm\n` +
    `        semi-rigid = ${ds.toExponential(4)} mm\n` +
    `        hinged     = ${dh.toExponential(4)} mm\n` +
    `        require hinged > semi-rigid > rigid  → ${mono ? 'ok' : 'VIOLATED'}`,
  );
}

// ---------------------------------------------------------------------------
// Case (g): STRESS RECOVERY — simply-supported strip, centre point load. The
//   assembly solver's recovered surface von Mises at the strip centre should
//   match beam theory:
//     σ = M·c/I = (P·L/4)·(t/2)/(w·t³/12) = 1.5·P·L/(w·t²).
//   For pure uniaxial bending von Mises == |σ|. The centre moment P·L/4 is a
//   STATICS result (independent of stiffness), so the recovered stress matches
//   theory even though the solver's soft grounding regularization perturbs
//   absolute deflection magnitudes.
//
// Geometry: a horizontal strip (span L along X, width w along Y) rests at z=H
// on two thin vertical legs at each span end. The legs stand on the floor
// (grounded) and are HINGE-jointed to the strip → simple supports (no end
// moment). A SHORT, THICK strip (L/t≈12) keeps the strip's own deflection tiny
// so the distributed soft-grounding springs steal negligible load from the two
// end reactions — the centre moment stays P·L/4 and the recovered surface
// stress lands on theory. Centre point load pushes the strip down.
// ---------------------------------------------------------------------------
function caseG() {
  const L = 240;    // support spacing = SS span (world X); L/t ≈ 12
  const w = 120;    // strip width (world Y)
  const t = 20;     // thickness
  const H = 80;     // leg height
  const ov = 20;    // small strip overhang beyond each support (keeps leg-top
                    // contacts in the strip INTERIOR, robust joint detection).
  const E = 8000;
  const P = 600;    // N, centre point load
  const mat = iso(E, 0.3);

  // σ_theory = 1.5·P·L / (w·t²)   (MPa == N/mm²). L is the support spacing;
  // symmetric overhangs don't change the centre moment (M = P·L/4).
  const theory = (1.5 * P * L) / (w * t * t);

  // Strip: local u=X, v=Y, normal +Z; spans x∈[−ov, L+ov] at z=H.
  const strip = mkPanel(1, 'S', L + 2 * ov, w, t, mat, [-ov, 0, H], [1, 0, 0], [0, 1, 0], [0, 0, 1]);
  // Legs: thin vertical panels, span Z (v = +Z, height H), width Y (u = +Y),
  // face normal +X. Tops (z=H) touch the strip's underside at x=0 and x=L —
  // interior points of the overhanging strip, so both joints detect cleanly.
  const legL = mkPanel(2, 'L', w, H, t, mat, [0, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0, 0]);
  const legR = mkPanel(3, 'R', w, H, t, mat, [L, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0, 0]);

  const panels = [strip, legL, legR];
  // Hinged joints at both ends → simple supports (legs push up, no end moment).
  const joints = detectJoints(panels, 3).map((j) => ({ ...j, stiffness: 'hinged' as JointStiffness }));
  const res = solveAssembly({
    panels, joints, tolMm: 3,
    // Load at mid-span. Strip-local x = world x + ov (origin at world x=−ov).
    loads: [{ panelId: 1, x: L / 2 + ov, y: w / 2, N: P, shape: 'round', size: 0 }],
  });

  if (!res.ok || !Number.isFinite(res.maxVm)) {
    anyFail = true;
    console.log(`[FAIL] (g) SS strip stress setup — ok=${res.ok} maxVm=${res.maxVm} ` +
      `msg=${res.message ?? ''} joints=${joints.length}`);
    return;
  }
  report(
    `(g) SS strip, centre P — surface stress  [${res.totalNodes} nodes, ${res.iterations} it, ${joints.length} joint(s)]`,
    res.maxVm, theory, 15,
    `util=${res.utilPct.toFixed(0)}%`,
  );
}

console.log('=== plate solver validation ===');
void bendingDForTest; // keep the import referenced
caseA();
caseB();
caseC();
caseD();
caseE();
caseF();
caseG();
console.log(anyFail ? '\nRESULT: FAIL' : '\nRESULT: all cases PASS');
process.exit(anyFail ? 1 : 0);
