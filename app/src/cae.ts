/**
 * Quick CAE — linear structural analysis for plywood panels.
 *
 * Three tiers, cheapest first:
 *   1. MATERIAL CARDS  — orthotropic elastic properties for common ply.
 *   2. FORMULA SCREENING — a beam-strip sag estimate (5qL⁴/384EI) for an
 *      instant "is this shelf going to sag?" verdict on every panel.
 *   3. PLATE SOLVER — a 4-node Mindlin (shear-deformable) plate FE model of
 *      the actual part outline (holes included), point/patch load, per-edge
 *      supports. Solved with Jacobi-preconditioned Conjugate Gradient.
 *
 * All geometry is in millimetres (repo convention). Material moduli are in
 * MPa (N/mm²), so forces are N and the raw displacement result is in mm.
 *
 * The plate formulation is validated against three closed-form cases in
 * tests/cae_check.ts (run `cd app && npx tsx ../tests/cae_check.ts`).
 */

import type { PolygonOutline, Vec2 } from './geometry';

// ---------------------------------------------------------------------------
// Material cards
// ---------------------------------------------------------------------------
export interface MaterialCard {
  id: string;
  name: string;
  /** Young's modulus along the face grain (MPa). */
  eAlong: number;
  /** Young's modulus across the face grain (MPa). */
  eAcross: number;
  /** In-plane shear modulus (MPa). ~E_along/16 is a reasonable ply estimate. */
  gShear: number;
  /** Density (kg/m³) for weight. */
  density: number;
  /** True → isotropic (eAlong == eAcross, no grain direction). */
  isotropic?: boolean;
  /** Characteristic bending strength ALONG the face grain (MPa) — the stress a
   *  panel can carry with the outer plies running with the span. Used for the
   *  utilization % (max bending stress vs strength). */
  fbAlong: number;
  /** Characteristic bending strength ACROSS the face grain (MPa) — weaker
   *  direction (outer plies perpendicular to the span). */
  fbAcross: number;
}

export const MATERIALS: MaterialCard[] = [
  { id: 'baltic-birch', name: 'Baltic birch ply', eAlong: 9500, eAcross: 4500, gShear: 9500 / 16, density: 680, fbAlong: 40, fbAcross: 25 },
  { id: 'softwood-ply', name: 'Softwood ply',     eAlong: 8000, eAcross: 3500, gShear: 8000 / 16, density: 550, fbAlong: 30, fbAcross: 18 },
  { id: 'hardwood-ply', name: 'Hardwood ply',     eAlong: 9000, eAcross: 4200, gShear: 9000 / 16, density: 640, fbAlong: 38, fbAcross: 22 },
  { id: 'mdf',          name: 'MDF',              eAlong: 3200, eAcross: 3200, gShear: 3200 / (2 * (1 + 0.25)), density: 750, isotropic: true, fbAlong: 18, fbAcross: 18 },
];

export const DEFAULT_MATERIAL_ID = 'baltic-birch';

export function materialById(id: string | undefined | null): MaterialCard {
  return MATERIALS.find((m) => m.id === id) ?? MATERIALS[0];
}

/** Poisson's ratio used for the plate D-matrix. Ply is low; keep modest. */
const NU = 0.25;

// ---------------------------------------------------------------------------
// Weight
// ---------------------------------------------------------------------------
function ringArea(ring: Vec2[]): number {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/** Net planar area (outer − holes) of an outline, in mm². */
export function outlineArea(outline: PolygonOutline): number {
  let a = ringArea(outline.outer);
  for (const h of outline.holes) a -= ringArea(h);
  return Math.max(a, 0);
}

/** Panel weight in kilograms. area(mm²)·t(mm)·density(kg/m³). */
export function panelWeightKg(outline: PolygonOutline, thicknessMm: number, mat: MaterialCard): number {
  const volM3 = (outlineArea(outline) * thicknessMm) / 1e9; // mm³ → m³
  return volM3 * mat.density;
}

// ---------------------------------------------------------------------------
// Formula screening — beam-strip sag under a uniform load
// ---------------------------------------------------------------------------
export type Verdict = 'ok' | 'borderline' | 'weak';

export interface ScreenResult {
  /** Predicted mid-span sag (mm) under the default uniform load. */
  sagMm: number;
  /** Free span used for the estimate (mm) — the panel's longer bbox edge. */
  span: number;
  /** Allowable sag (mm) = span / 300 (the "ok" threshold). */
  limit: number;
  verdict: Verdict;
  /** Grain axis used for E along the span (for reporting). */
  eUsed: number;
}

export interface ScreenOptions {
  /** Uniform load spread over the whole panel, kg. Default ~a loaded shelf. */
  loadKg?: number;
  /** Which axis the grain runs — determines E along the span. */
  grain?: 'free' | 'length' | 'width';
}

const G = 9.80665; // m/s²

/**
 * Treat the panel as a simply-supported beam strip spanning its LONGEST free
 * edge L. Uniform load `q` (N/mm run of strip) gives w = 5qL⁴/(384 E I),
 * I = width·t³/12 for the full-width strip. Because q scales with width and
 * I scales with width, width cancels — the sag depends only on L, t, E and
 * the total load. E is taken along the span from the material card.
 */
export function screenPanel(
  length: number,
  width: number,
  thicknessMm: number,
  mat: MaterialCard,
  opts: ScreenOptions = {},
): ScreenResult {
  const loadKg = opts.loadKg ?? 20;
  const grain = opts.grain ?? 'free';
  const L = Math.max(length, width); // longest free span
  const b = Math.min(length, width); // strip width (perpendicular to span)
  const t = thicknessMm;

  // Which E resists bending about the span? The span runs along the panel's
  // long edge. grain='length' → grain runs along the span → stiff E_along.
  // grain='width' → grain runs across → E_across governs the span bending.
  // 'free' assumes the (natural) long-edge grain, i.e. stiff along the span.
  let eSpan: number;
  if (mat.isotropic) eSpan = mat.eAlong;
  else if (grain === 'width') eSpan = mat.eAcross;
  else eSpan = mat.eAlong; // 'length' or 'free'

  // Total weight (N) spread as a UDL over the span. Per-unit-run load
  // q = W / L (N/mm). I = b·t³/12 (mm⁴). E in MPa == N/mm².
  const W = loadKg * G;               // N
  const q = W / L;                    // N/mm
  const I = (b * t * t * t) / 12;     // mm⁴
  const sag = (5 * q * L * L * L * L) / (384 * eSpan * I); // mm

  const limit = L / 300;
  let verdict: Verdict;
  if (sag < L / 300) verdict = 'ok';
  else if (sag < L / 200) verdict = 'borderline';
  else verdict = 'weak';

  return { sagMm: sag, span: L, limit, verdict, eUsed: eSpan };
}

// ---------------------------------------------------------------------------
// Plate solver
// ---------------------------------------------------------------------------
export type EdgeSupport = 'free' | 'simple' | 'fixed';

export interface EdgeSupports {
  /** In outline frame: +Y edge (bbox max Y). */
  top: EdgeSupport;
  /** −Y edge (bbox min Y == 0). */
  bottom: EdgeSupport;
  /** −X edge (bbox min X == 0). */
  left: EdgeSupport;
  /** +X edge (bbox max X). */
  right: EdgeSupport;
}

/** A footprint-sized load. `N` is SIGNED: +N pushes into the face (a downward
 *  force), −N pulls out (a reaction / upward support push). The load is spread
 *  as a uniform pressure over the active nodes inside its footprint. */
export interface PatchLoad {
  /** Position in outline mm coords. */
  x: number;
  y: number;
  /** Signed magnitude in Newtons (+down / −up). */
  N: number;
  /** Footprint shape. */
  shape: 'square' | 'round';
  /** Footprint size in mm — side length (square) or diameter (round). */
  size: number;
}

/** A shelf-pin point support: clamps w=0 on the nearest node patch (rotations
 *  left free). Position in outline mm coords. */
export interface PointSupport {
  x: number;
  y: number;
}

export interface SolveOptions {
  outline: PolygonOutline;
  thicknessMm: number;
  material: MaterialCard;
  /** True → the part's outline X-axis (length) runs along the face grain. */
  grainAlongLength: boolean;
  supports: EdgeSupports;
  /** Footprint-sized point loads. Each is spread over the active nodes inside
   *  its footprint. */
  loads?: PatchLoad[];
  /** Optional uniform load spread over the whole active area, in kilograms. */
  uniform?: { totalKg: number };
  /** Shelf-pin point supports (clamp w=0 near each). */
  pointSupports?: PointSupport[];
  // --- Legacy single-point-load API (validation harness / back-compat). When
  //     `loads` is absent, a single load is synthesised from these. ---
  /** Point load in Newtons, applied at (loadX, loadY) in outline mm coords. */
  forceN?: number;
  loadX?: number;
  loadY?: number;
  /** Target active node count (grid is auto-sized to hit ~this). */
  targetNodes?: number;
}

export interface SolveResult {
  /** Grid columns / rows (nodes). */
  nx: number;
  ny: number;
  /** Node spacing (mm). */
  dx: number;
  dy: number;
  /** Outline bbox origin in outline coords (min corner). */
  originX: number;
  originY: number;
  /** Per-node transverse deflection w (mm). NaN for inactive (outside) nodes. */
  w: Float32Array;
  /** Per-node active flag. */
  active: Uint8Array;
  /** Max |w| (mm) and its location in outline coords. */
  maxAbsW: number;
  maxAt: Vec2;
  activeNodes: number;
  iterations: number;
  converged: boolean;
}

// point-in-polygon (ray cast), ring in mm
function pointInRing(px: number, py: number, ring: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect =
      (yi > py) !== (yj > py) &&
      px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInOutline(px: number, py: number, outline: PolygonOutline): boolean {
  if (!pointInRing(px, py, outline.outer)) return false;
  for (const h of outline.holes) if (pointInRing(px, py, h)) return false;
  return true;
}

/**
 * Orthotropic bending D-matrix (3×3, [Mx My Mxy] = D·[κx κy κxy]).
 * D = t³/12 · Q, where Q is the plane-stress reduced stiffness. For an
 * orthotropic material Ex(=e1)/Ey(=e2)/Gxy with a single ν (ν12).
 */
function bendingD(e1: number, e2: number, g12: number, nu12: number, t: number): number[][] {
  const nu21 = (nu12 * e2) / e1;
  const denom = 1 - nu12 * nu21;
  const q11 = e1 / denom;
  const q22 = e2 / denom;
  const q12 = (nu12 * e2) / denom;
  const f = (t * t * t) / 12;
  return [
    [f * q11, f * q12, 0],
    [f * q12, f * q22, 0],
    [0, 0, f * g12],
  ];
}

/** Exposed for the validation harness (referenced to keep the import live). */
export const bendingDForTest = bendingD;

/** Transverse shear stiffness (2×2). k=5/6 shear correction. */
function shearD(g13: number, g23: number, t: number): [number, number] {
  const k = 5 / 6;
  return [k * g13 * t, k * g23 * t];
}

// 2×2 Gauss points/weights on [-1,1].
const GP2 = [-1 / Math.sqrt(3), 1 / Math.sqrt(3)];

/**
 * Build the 12×12 element stiffness for a rectangular Mindlin plate element
 * of size (a × b), DOF order per node [w, θx, θy], nodes CCW:
 *   0:(0,0) 1:(a,0) 2:(a,b) 3:(0,b).
 *
 * Convention:
 *   θx = rotation about x-axis, θy = rotation about y-axis.
 *   κ  = [ ∂θy/∂x , −∂θx/∂y , ∂θy/∂y − ∂θx/∂x ]
 *   γ  = [ ∂w/∂x + θy , ∂w/∂y − θx ]
 * (Thin limit γ→0 ⇒ θy = −∂w/∂x, θx = ∂w/∂y.)
 *
 * Bending uses full 2×2 integration; shear uses selective reduced 1×1
 * integration (evaluated at the element centre) to avoid shear locking.
 */
function elementK(a: number, b: number, Db: number[][], Ds: [number, number]): number[][] {
  const K: number[][] = Array.from({ length: 12 }, () => new Array(12).fill(0));

  // Shape functions & derivatives at natural coords (xi, eta) ∈ [-1,1].
  // Nodes: 0(-,-) 1(+,-) 2(+,+) 3(-,+)
  const sx = [-1, 1, 1, -1];
  const se = [-1, -1, 1, 1];
  const jinvXi = 2 / a;   // ∂xi/∂x
  const jinvEta = 2 / b;  // ∂eta/∂y
  const jac = (a / 2) * (b / 2); // det J

  // --- Bending: full 2×2 integration ---
  for (const xi of GP2) {
    for (const eta of GP2) {
      // dN/dx, dN/dy for each node
      const dNdx = new Array(4);
      const dNdy = new Array(4);
      for (let i = 0; i < 4; i++) {
        const dNdxi = 0.25 * sx[i] * (1 + se[i] * eta);
        const dNdeta = 0.25 * se[i] * (1 + sx[i] * xi);
        dNdx[i] = dNdxi * jinvXi;
        dNdy[i] = dNdeta * jinvEta;
      }
      // Bending B (3×12). Curvature rows use θx, θy DOFs (cols 1,2 of node).
      // κx =  ∂θy/∂x         → +dNdx on θy
      // κy = −∂θx/∂y         → −dNdy on θx
      // κxy = ∂θy/∂y − ∂θx/∂x→ +dNdy on θy, −dNdx on θx
      const Bb: number[][] = [new Array(12).fill(0), new Array(12).fill(0), new Array(12).fill(0)];
      for (let i = 0; i < 4; i++) {
        const cθx = i * 3 + 1;
        const cθy = i * 3 + 2;
        Bb[0][cθy] = dNdx[i];
        Bb[1][cθx] = -dNdy[i];
        Bb[2][cθy] = dNdy[i];
        Bb[2][cθx] = -dNdx[i];
      }
      accumulateBtDB(K, Bb, Db, jac); // weight 1·1 for 2-pt Gauss
    }
  }

  // --- Shear: reduced 1×1 integration at centre (xi=eta=0) ---
  {
    const xi = 0, eta = 0;
    const N = new Array(4);
    const dNdx = new Array(4);
    const dNdy = new Array(4);
    for (let i = 0; i < 4; i++) {
      N[i] = 0.25 * (1 + sx[i] * xi) * (1 + se[i] * eta);
      const dNdxi = 0.25 * sx[i] * (1 + se[i] * eta);
      const dNdeta = 0.25 * se[i] * (1 + sx[i] * xi);
      dNdx[i] = dNdxi * jinvXi;
      dNdy[i] = dNdeta * jinvEta;
    }
    // γxz = ∂w/∂x + θy , γyz = ∂w/∂y − θx
    const Bs: number[][] = [new Array(12).fill(0), new Array(12).fill(0)];
    for (let i = 0; i < 4; i++) {
      const cw = i * 3;
      const cθx = i * 3 + 1;
      const cθy = i * 3 + 2;
      Bs[0][cw] = dNdx[i];
      Bs[0][cθy] = N[i];
      Bs[1][cw] = dNdy[i];
      Bs[1][cθx] = -N[i];
    }
    // Weight for 1-pt rule over [-1,1]² is 4; det J is jac. Effective area = 4·jac.
    const wgt = 4 * jac;
    for (let r = 0; r < 12; r++) {
      const b0 = Bs[0][r], b1 = Bs[1][r];
      if (b0 === 0 && b1 === 0) continue;
      // Ds·Bs (diagonal shear)
      const d0 = Ds[0] * b0;
      const d1 = Ds[1] * b1;
      for (let c = 0; c < 12; c++) {
        const contrib = (b0 !== 0 || b1 !== 0)
          ? (Bs[0][c] * d0 + Bs[1][c] * d1)
          : 0;
        if (contrib !== 0) K[r][c] += contrib * wgt;
      }
    }
  }

  return K;
}

/** K += Bᵀ·D·B · jac (bending, 2-pt weight = 1). */
function accumulateBtDB(K: number[][], B: number[][], D: number[][], jac: number) {
  // DB = D·B (3×12)
  const DB: number[][] = [new Array(12).fill(0), new Array(12).fill(0), new Array(12).fill(0)];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 12; c++) {
      DB[r][c] = D[r][0] * B[0][c] + D[r][1] * B[1][c] + D[r][2] * B[2][c];
    }
  }
  for (let r = 0; r < 12; r++) {
    for (let c = 0; c < 12; c++) {
      const v = B[0][r] * DB[0][c] + B[1][r] * DB[1][c] + B[2][r] * DB[2][c];
      if (v !== 0) K[r][c] += v * jac;
    }
  }
}

/**
 * Rasterise the outline onto a regular grid, assemble the Mindlin plate
 * system, apply supports + load, and solve with PCG.
 */
/** Common inputs shared by the point-load and uniform-pressure entrypoints. */
interface AssembleOptions {
  outline: PolygonOutline;
  thicknessMm: number;
  material: MaterialCard;
  grainAlongLength: boolean;
  supports: EdgeSupports;
  /** Shelf-pin point supports (clamp w=0 near each). */
  pointSupports?: PointSupport[];
  targetNodes?: number;
}

/** Grid + assembled system context handed to the load builder. */
interface GridCtx {
  nx: number; ny: number; dx: number; dy: number;
  originX: number; originY: number;
  nNodes: number; nDof: number;
  active: Uint8Array;
  dofOf: Int32Array;
  activeCells: [number, number][];
  bboxW: number; bboxH: number;
}

export function solvePlate(opts: SolveOptions): SolveResult {
  // Normalise the load list: prefer `loads`; else synthesise one point-ish load
  // from the legacy forceN/loadX/loadY API (a tiny footprint ≈ a point load).
  const loads: PatchLoad[] = opts.loads
    ? opts.loads
    : (opts.forceN != null
        ? [{ x: opts.loadX ?? 0, y: opts.loadY ?? 0, N: opts.forceN, shape: 'round', size: 0 }]
        : []);
  const uniform = opts.uniform;

  return assembleAndSolve(opts, (F, g) => {
    // --- Uniform load: spread its total weight over the whole active area as a
    //     pressure, built as consistent nodal loads per active cell ---
    if (uniform && uniform.totalKg > 0) {
      const { activeCells, dofOf, nx, dx, dy } = g;
      const totalArea = activeCells.length * dx * dy; // mm²
      if (totalArea > 0) {
        const totalN = uniform.totalKg * G;
        const pressure = totalN / totalArea;          // N/mm²
        const cellLoad = pressure * dx * dy;          // N per cell
        for (const [ix, iy] of activeCells) {
          const nodes = [iy * nx + ix, iy * nx + ix + 1, (iy + 1) * nx + ix + 1, (iy + 1) * nx + ix];
          for (const n of nodes) {
            const wdof = dofOf[n * 3];
            if (wdof >= 0) F[wdof] += cellLoad / 4;
          }
        }
      }
    }

    // --- Footprint loads: each spread as a UNIFORM pressure over the active
    //     nodes inside its footprint (snap to nearest active node if empty) ---
    const { dofOf, active, nx, ny, nNodes, dx, dy, originX, originY, bboxW, bboxH } = g;
    for (const load of loads) {
      if (!load.N) continue;
      const lx = Math.min(Math.max(load.x - originX, 0), bboxW);
      const ly = Math.min(Math.max(load.y - originY, 0), bboxH);
      // Nodes whose position falls inside the footprint.
      const inFoot: number[] = [];
      const half = load.size / 2;
      const j0x = Math.max(0, Math.floor((lx - half) / dx) - 1);
      const j1x = Math.min(nx - 1, Math.ceil((lx + half) / dx) + 1);
      const j0y = Math.max(0, Math.floor((ly - half) / dy) - 1);
      const j1y = Math.min(ny - 1, Math.ceil((ly + half) / dy) + 1);
      for (let jy = j0y; jy <= j1y; jy++) {
        for (let jx = j0x; jx <= j1x; jx++) {
          const n = jy * nx + jx;
          if (!active[n]) continue;
          const px = jx * dx, py = jy * dy;
          const within = load.shape === 'round'
            ? Math.hypot(px - lx, py - ly) <= half + 1e-6
            : Math.abs(px - lx) <= half + 1e-6 && Math.abs(py - ly) <= half + 1e-6;
          if (within) inFoot.push(n);
        }
      }
      // Fallback: snap to the single nearest active node.
      if (inFoot.length === 0) {
        let best = -1, bestD = Infinity;
        for (let i = 0; i < nNodes; i++) {
          if (!active[i]) continue;
          const jx = i % nx, jy = (i / nx) | 0;
          const d = Math.hypot(jx * dx - lx, jy * dy - ly);
          if (d < bestD) { bestD = d; best = i; }
        }
        if (best >= 0) inFoot.push(best);
      }
      if (inFoot.length === 0) continue;
      const share = load.N / inFoot.length;
      for (const n of inFoot) {
        const wdof = dofOf[n * 3];
        if (wdof >= 0) F[wdof] += share;
      }
    }
  });
}

/** Uniform-pressure variant (used by the validation harness for the SS square
 *  UDL benchmark). Pressure is in N/mm² (== MPa); consistent nodal loads are
 *  built from each active cell (equal 1/4 split of pressure·cellArea). */
export function solvePlateUniform(opts: AssembleOptions & { pressureN: number }): SolveResult {
  return assembleAndSolve(opts, (F, g) => {
    const { activeCells, dofOf, nx, dx, dy } = g;
    const cellLoad = opts.pressureN * dx * dy; // total force on one cell (N)
    for (const [ix, iy] of activeCells) {
      const nodes = [iy * nx + ix, iy * nx + ix + 1, (iy + 1) * nx + ix + 1, (iy + 1) * nx + ix];
      for (const n of nodes) {
        const wdof = dofOf[n * 3];
        if (wdof >= 0) F[wdof] += cellLoad / 4;
      }
    }
  });
}

function assembleAndSolve(
  opts: AssembleOptions,
  buildLoad: (F: Float64Array, g: GridCtx) => void,
): SolveResult {
  const { outline, thicknessMm, material, supports } = opts;
  const t = thicknessMm;
  const bboxW = outline.bbox.w;
  const bboxH = outline.bbox.h;
  const originX = 0;
  const originY = 0;
  const target = opts.targetNodes ?? 4000;
  const cap = 8000;

  // Choose grid resolution so ~target nodes fall inside the bbox. Use the
  // area fraction the part covers so a sparse L-shape still hits the count.
  const areaFrac = Math.max(0.15, outlineArea(outline) / (bboxW * bboxH || 1));
  const aspect = bboxW / bboxH;
  // active ≈ areaFrac·nx·ny, with nx/ny ∝ aspect. Solve for ny.
  let ny = Math.round(Math.sqrt((target / areaFrac) / aspect)) + 1;
  let nx = Math.round(ny * aspect) + 1;
  // clamp so nx·ny ≤ cap/areaFrac (so active ≤ cap)
  while ((nx * ny) * areaFrac > cap && (nx > 6 || ny > 6)) {
    if (nx > ny) nx--; else ny--;
  }
  nx = Math.max(nx, 6);
  ny = Math.max(ny, 6);
  const dx = bboxW / (nx - 1);
  const dy = bboxH / (ny - 1);

  const nodeIdx = (ix: number, iy: number) => iy * nx + ix;
  const nNodes = nx * ny;
  const active = new Uint8Array(nNodes);

  // A node is active if any of its 4 incident cells is (mostly) inside the
  // outline. We test cell centres and mark the 4 corner nodes active.
  const cellInside = (ix: number, iy: number): boolean => {
    const cx = originX + (ix + 0.5) * dx;
    const cy = originY + (iy + 0.5) * dy;
    return pointInOutline(cx, cy, outline);
  };
  const activeCells: [number, number][] = [];
  for (let iy = 0; iy < ny - 1; iy++) {
    for (let ix = 0; ix < nx - 1; ix++) {
      if (cellInside(ix, iy)) {
        activeCells.push([ix, iy]);
        active[nodeIdx(ix, iy)] = 1;
        active[nodeIdx(ix + 1, iy)] = 1;
        active[nodeIdx(ix, iy + 1)] = 1;
        active[nodeIdx(ix + 1, iy + 1)] = 1;
      }
    }
  }
  let activeNodes = 0;
  for (let i = 0; i < nNodes; i++) if (active[i]) activeNodes++;

  // DOF numbering: 3 per active node. -1 for inactive.
  const dofOf = new Int32Array(nNodes * 3).fill(-1);
  let nDof = 0;
  for (let i = 0; i < nNodes; i++) {
    if (active[i]) {
      dofOf[i * 3] = nDof++;
      dofOf[i * 3 + 1] = nDof++;
      dofOf[i * 3 + 2] = nDof++;
    }
  }

  // Material D-matrices. e1 along outline X when grainAlongLength.
  const e1 = material.isotropic ? material.eAlong : (opts.grainAlongLength ? material.eAlong : material.eAcross);
  const e2 = material.isotropic ? material.eAlong : (opts.grainAlongLength ? material.eAcross : material.eAlong);
  const Db = bendingD(e1, e2, material.gShear, NU, t);
  const Ds = shearD(material.gShear, material.gShear, t);

  // One element stiffness (all cells identical size) — reuse it.
  const Ke = elementK(dx, dy, Db, Ds);

  // Assemble sparse system in a map-of-rows, then CSR.
  const rows: Map<number, number>[] = Array.from({ length: nDof }, () => new Map());
  const addK = (gi: number, gj: number, v: number) => {
    if (v === 0) return;
    const r = rows[gi];
    r.set(gj, (r.get(gj) ?? 0) + v);
  };

  // element node order 0:(ix,iy) 1:(ix+1,iy) 2:(ix+1,iy+1) 3:(ix,iy+1)
  for (const [ix, iy] of activeCells) {
    const en = [nodeIdx(ix, iy), nodeIdx(ix + 1, iy), nodeIdx(ix + 1, iy + 1), nodeIdx(ix, iy + 1)];
    // global dof for each of 12 local dofs
    const gdof = new Array(12);
    for (let i = 0; i < 4; i++) {
      gdof[i * 3] = dofOf[en[i] * 3];
      gdof[i * 3 + 1] = dofOf[en[i] * 3 + 1];
      gdof[i * 3 + 2] = dofOf[en[i] * 3 + 2];
    }
    for (let r = 0; r < 12; r++) {
      const gr = gdof[r];
      if (gr < 0) continue;
      const Kr = Ke[r];
      for (let c = 0; c < 12; c++) {
        const gc = gdof[c];
        if (gc < 0) continue;
        const v = Kr[c];
        if (v !== 0) addK(gr, gc, v);
      }
    }
  }

  // --- Load vector: built by the caller-supplied load builder ---
  const F = new Float64Array(nDof);
  buildLoad(F, {
    nx, ny, dx, dy, originX, originY, nNodes, nDof,
    active, dofOf, activeCells, bboxW, bboxH,
  });

  // --- Supports: constrain DOFs on bbox edges ---
  const fixed = new Uint8Array(nDof);
  const tol = Math.min(dx, dy) * 0.5 + 1e-6;
  const constrainNode = (n: number, kind: EdgeSupport) => {
    if (kind === 'free') return;
    const wdof = dofOf[n * 3];
    if (wdof >= 0) fixed[wdof] = 1; // w = 0 for simple & fixed
    if (kind === 'fixed') {
      const rx = dofOf[n * 3 + 1];
      const ry = dofOf[n * 3 + 2];
      if (rx >= 0) fixed[rx] = 1;
      if (ry >= 0) fixed[ry] = 1;
    }
  };
  for (let i = 0; i < nNodes; i++) {
    if (!active[i]) continue;
    const ix = i % nx, iy = (i / nx) | 0;
    const x = originX + ix * dx;
    const y = originY + iy * dy;
    if (y >= bboxH - tol) constrainNode(i, supports.top);
    if (y <= tol) constrainNode(i, supports.bottom);
    if (x <= tol) constrainNode(i, supports.left);
    if (x >= bboxW - tol) constrainNode(i, supports.right);
  }

  // --- Point supports (shelf pins): clamp w=0 on the nearest active node to
  //     each pin (rotations left free — a pin resists lift, not tilt). ---
  for (const pin of opts.pointSupports ?? []) {
    const px = Math.min(Math.max(pin.x - originX, 0), bboxW);
    const py = Math.min(Math.max(pin.y - originY, 0), bboxH);
    let best = -1, bestD = Infinity;
    for (let i = 0; i < nNodes; i++) {
      if (!active[i]) continue;
      const ix = i % nx, iy = (i / nx) | 0;
      const d = Math.hypot(ix * dx - px, iy * dy - py);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0) {
      const wdof = dofOf[best * 3];
      if (wdof >= 0) fixed[wdof] = 1; // w = 0, rotations free
    }
  }

  // Apply Dirichlet BCs by zeroing fixed rows/cols and setting diagonal 1,
  // F=0 (all supports are homogeneous). We also drop fixed entries from F.
  for (let g = 0; g < nDof; g++) {
    if (fixed[g]) { F[g] = 0; rows[g] = new Map([[g, 1]]); }
  }
  // zero the columns of fixed dofs in the remaining rows
  for (let g = 0; g < nDof; g++) {
    if (fixed[g]) continue;
    const r = rows[g];
    for (const fg of r.keys()) {
      if (fixed[fg]) r.delete(fg);
    }
  }

  // Build CSR
  const rowPtr = new Int32Array(nDof + 1);
  let nnz = 0;
  for (let g = 0; g < nDof; g++) { rowPtr[g] = nnz; nnz += rows[g].size; }
  rowPtr[nDof] = nnz;
  const colIdx = new Int32Array(nnz);
  const val = new Float64Array(nnz);
  const diag = new Float64Array(nDof);
  {
    let k = 0;
    for (let g = 0; g < nDof; g++) {
      // deterministic column order
      const entries = [...rows[g].entries()].sort((p, q) => p[0] - q[0]);
      for (const [c, v] of entries) {
        colIdx[k] = c;
        val[k] = v;
        if (c === g) diag[g] = v;
        k++;
      }
      if (diag[g] === 0) diag[g] = 1; // guard
    }
  }

  // --- Jacobi-preconditioned Conjugate Gradient ---
  const x = new Float64Array(nDof);
  const { iterations, converged } = pcg(rowPtr, colIdx, val, diag, F, x, 1e-8, 10000);

  // Scatter w back to nodes.
  const w = new Float32Array(nNodes).fill(NaN);
  let maxAbs = 0;
  let maxAt: Vec2 = [0, 0];
  for (let i = 0; i < nNodes; i++) {
    if (!active[i]) continue;
    const wdof = dofOf[i * 3];
    const val = wdof >= 0 ? x[wdof] : 0;
    w[i] = val;
    if (Math.abs(val) > maxAbs) {
      maxAbs = Math.abs(val);
      const ix = i % nx, iy = (i / nx) | 0;
      maxAt = [originX + ix * dx, originY + iy * dy];
    }
  }

  return {
    nx, ny, dx, dy, originX, originY,
    w, active, maxAbsW: maxAbs, maxAt,
    activeNodes, iterations, converged,
  };
}

/** CSR sparse matrix–vector product y = A·x. */
function spmv(rowPtr: Int32Array, colIdx: Int32Array, val: Float64Array, x: Float64Array, y: Float64Array) {
  const n = rowPtr.length - 1;
  for (let r = 0; r < n; r++) {
    let s = 0;
    for (let k = rowPtr[r]; k < rowPtr[r + 1]; k++) s += val[k] * x[colIdx[k]];
    y[r] = s;
  }
}

/** Jacobi-preconditioned CG. Returns iteration count + convergence flag.
 *  `onIter(iter, relRes)` (optional) fires every 50 iterations for UI progress
 *  — kept coarse so the callback overhead never dominates the loop. */
function pcg(
  rowPtr: Int32Array, colIdx: Int32Array, val: Float64Array, diag: Float64Array,
  b: Float64Array, x: Float64Array, tol: number, maxIter: number,
  onIter?: (iter: number, relRes: number) => void,
): { iterations: number; converged: boolean } {
  const n = b.length;
  const r = new Float64Array(n);
  const z = new Float64Array(n);
  const p = new Float64Array(n);
  const Ap = new Float64Array(n);
  const invDiag = new Float64Array(n);
  for (let i = 0; i < n; i++) invDiag[i] = diag[i] !== 0 ? 1 / diag[i] : 1;

  // r = b - A x  (x starts at 0)
  spmv(rowPtr, colIdx, val, x, Ap);
  let bnorm = 0;
  for (let i = 0; i < n; i++) { r[i] = b[i] - Ap[i]; bnorm += b[i] * b[i]; }
  bnorm = Math.sqrt(bnorm) || 1;

  for (let i = 0; i < n; i++) { z[i] = invDiag[i] * r[i]; p[i] = z[i]; }
  let rz = 0;
  for (let i = 0; i < n; i++) rz += r[i] * z[i];

  let iter = 0;
  for (; iter < maxIter; iter++) {
    spmv(rowPtr, colIdx, val, p, Ap);
    let pAp = 0;
    for (let i = 0; i < n; i++) pAp += p[i] * Ap[i];
    if (pAp === 0) break;
    const alpha = rz / pAp;
    let rnorm = 0;
    for (let i = 0; i < n; i++) {
      x[i] += alpha * p[i];
      r[i] -= alpha * Ap[i];
      rnorm += r[i] * r[i];
    }
    rnorm = Math.sqrt(rnorm);
    if (rnorm / bnorm < tol) { iter++; return { iterations: iter, converged: true }; }
    if (onIter && (iter % 50) === 0) onIter(iter, rnorm / bnorm);
    for (let i = 0; i < n; i++) z[i] = invDiag[i] * r[i];
    let rzNew = 0;
    for (let i = 0; i < n; i++) rzNew += r[i] * z[i];
    const beta = rzNew / rz;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
    rz = rzNew;
  }
  return { iterations: iter, converged: false };
}

// ---------------------------------------------------------------------------
// Convenience: rectangular-outline builder (for the validation harness and
// callers who only have length/width, no polygon).
// ---------------------------------------------------------------------------
export function rectOutline(length: number, width: number): PolygonOutline {
  const outer: Vec2[] = [[0, 0], [length, 0], [length, width], [0, width]];
  return { outer, holes: [], bbox: { w: length, h: width }, area: length * width };
}

// ===========================================================================
// ASSEMBLY solver — a coupled flat-shell FE model of a whole cabinet.
//
// Every selected panel becomes a flat-shell mesh (Mindlin bending — the same
// elementK the per-panel solver uses — PLUS a plane-stress membrane, both with
// selective reduced integration), assembled into ONE global system with 6 DOF
// per node in world 3D (ux uy uz θx θy θz). Panels are stitched where their
// edges touch (joint detection) with penalty springs whose stiffness depends
// on the joint class (rigid / semi-rigid / hinged). Nodes near the floor are
// grounded. The linear system is solved by Eigen's SimplicialLDLT compiled to
// WASM (opts.backend, from solverBackend.ts) when it loads, else the built-in
// Jacobi-PCG fallback — both handed the identical symmetric CSR (==CSC) system.
//
// The per-panel API above is untouched; this section only ADDS exports.
// ===========================================================================

/** A single panel positioned in world space. The local outline (mm, anchored
 *  at its bbox min) is meshed in its own (u,v) plane; `origin` is the world
 *  point where local (0,0) sits and `uAxis`/`vAxis`/`normal` are the world
 *  unit axes local X (length), local Y (width) and the plate normal run along.
 */
export interface AsmPanel {
  /** Stable id (the body id). Used to key results + joints. */
  id: number;
  /** Short label for the UI/PDF, e.g. "1a". */
  label: string;
  outline: PolygonOutline;
  thicknessMm: number;
  material: MaterialCard;
  /** True → the outline X-axis (length) runs along the face grain. */
  grainAlongLength: boolean;
  origin: Vec3World;
  uAxis: Vec3World; // world unit, spans outline width w (local +X)
  vAxis: Vec3World; // world unit, spans outline height h (local +Y)
  normal: Vec3World; // world unit plate normal
}

export type Vec3World = [number, number, number];

export type JointStiffness = 'rigid' | 'semi-rigid' | 'hinged';

/** A detected edge-contact between two panels. */
export interface AsmJoint {
  a: number; // panel id
  b: number; // panel id
  /** Contact segment endpoints in world coords. */
  p0: Vec3World;
  p1: Vec3World;
  /** Segment length (mm). */
  length: number;
  stiffness: JointStiffness;
}

/** A world-space patch load pressed onto a specific panel's face. */
export interface AsmLoad {
  panelId: number;
  /** Position in that panel's local outline mm coords. */
  x: number;
  y: number;
  /** Signed magnitude (N); + acts along −normal (into the face / downward-ish). */
  N: number;
  shape: 'square' | 'round';
  size: number;
}

/** A pluggable sparse-direct linear-solve backend (e.g. Eigen SimplicialLDLT
 *  compiled to WASM — see solverBackend.ts). Injected into solveAssembly; when
 *  absent, the built-in Jacobi-PCG is used. The system handed to it is the
 *  penalty-conditioned SYMMETRIC CSR (== CSC) stiffness matrix. */
export interface DirectLinearSolver {
  readonly name: string;
  factorize(n: number, indptr: Int32Array, indices: Int32Array, data: Float64Array): boolean;
  solve(rhs: Float64Array): Float64Array | null;
  dispose(): void;
}

/** Progress stages surfaced to the UI (Analysis Solve button). The `pct` is a
 *  0..100 hint for the progress bar; PCG reports incremental iteration progress
 *  through the `solving` stage, LDLT reports an atomic factorize pulse. */
export type SolveStage =
  | 'meshing' | 'assembling' | 'factorizing' | 'solving' | 'recovering' | 'done';

export interface SolveProgress {
  stage: SolveStage;
  /** 0..100 progress hint. */
  pct: number;
  /** Optional human detail, e.g. "58320 DOF" or "iter 200 · res 1e-4". */
  detail?: string;
}

export interface AsmSolveOptions {
  panels: AsmPanel[];
  joints: AsmJoint[];
  loads: AsmLoad[];
  /** Join tolerance (mm) — also the floor-contact threshold. */
  tolMm: number;
  /** Target active nodes per panel (mesh auto-coarsens to hold the DOF cap).
   *  Ignored when `elementSizeMm` is set. */
  targetNodesPerPanel?: number;
  /** Absolute target element edge length (mm) — the preferred way to specify
   *  the mesh, since it means the same thing on every panel regardless of size.
   *  Still auto-coarsened to hold `maxDof`. */
  elementSizeMm?: number;
  /** Hard cap on total assembly DOF. */
  maxDof?: number;
  /** Optional sparse-direct backend (Eigen LDLT wasm). When present AND its
   *  factorize succeeds, it replaces PCG for the assembly solve. On any failure
   *  the solve falls back to PCG so a result is always produced. */
  backend?: DirectLinearSolver | null;
  /** Optional progress callback (staged UI feedback). Called synchronously at
   *  each stage boundary; the caller yields to the browser between stages. */
  onProgress?: (p: SolveProgress) => void;
  /** Which element family to build. 'shell' (default) is the 6-DOF flat-shell
   *  path; 'solid' extrudes each cell through the thickness into 8-node hexes
   *  with incompatible modes (3 DOF/node). */
  meshKind?: MeshKind;
  /** Solid only: hex layers through the panel thickness (default 2). */
  solidLayers?: number;
}

/** Which linear backend actually solved the system (for the result/log line). */
export type SolveBackend = 'PyNite (isotropic E_eff)' | 'Eigen LDLT (wasm)' | 'PCG';

/** Per-panel deflection field, in that panel's local grid (like SolveResult). */
export interface AsmPanelResult {
  id: number;
  nx: number; ny: number; dx: number; dy: number;
  /** Per-node transverse deflection magnitude |u·? | — the total translational
   *  displacement magnitude (mm). NaN for inactive nodes. */
  disp: Float32Array;
  /** Per-node von Mises surface stress (MPa), nodally averaged from the
   *  incident elements' worst-face stress. NaN for inactive nodes. */
  vm: Float32Array;
  active: Uint8Array;
  maxAbs: number;
  /** Max nodal von Mises on this panel (MPa). */
  maxVm: number;
}

export interface AsmResult {
  ok: boolean;
  /** When !ok, a human message explaining the refusal. */
  message?: string;
  panels: AsmPanelResult[];
  /** Global max displacement magnitude (mm) across the whole assembly. */
  maxDisp: number;
  /** Panel id + local location where the max occurred. */
  maxPanelId: number;
  maxAt: Vec2;
  /** Free span of the governing panel (mm) — for the verdict. */
  spanMm: number;
  verdict: 'ok' | 'borderline' | 'weak';
  /** Global max von Mises surface stress (MPa) across the whole assembly. */
  maxVm: number;
  /** Panel id + local location where the max von Mises occurred. */
  maxVmPanelId: number;
  maxVmAt: Vec2;
  /** Utilization % = max(σ_along/fbAlong, σ_across/fbAcross) over all panels,
   *  where σ_along/σ_across are the peak bending stresses along/across grain. */
  utilPct: number;
  /** Verdict from the utilization: <50% ok, <100% borderline, ≥100% weak. */
  stressVerdict: 'ok' | 'borderline' | 'weak';
  totalDof: number;
  totalNodes: number;
  iterations: number;
  converged: boolean;
  /** Which linear backend solved the system ('Eigen LDLT (wasm)' or 'PCG'). */
  backend: SolveBackend;
  /** Factorization time (ms) — LDLT only; 0 for PCG. */
  factorMs: number;
  /** Solve time (ms): the LDLT triangular solves, or the whole PCG loop. */
  solveMs: number;
  /** Floor-grounded node count (for the glyph overlay + reporting). */
  groundedNodes: number;
  /** Resolution log line, e.g. "6 panels · 3480 nodes · 20880 DOF". */
  resolutionLog: string;
  /** Grounded node world positions (for glyphs). */
  groundPoints: Vec3World[];
  /** The discretisation this result came from — lets the viewer draw the
   *  result ON the mesh (contoured elements + element edges + deformed shape)
   *  instead of only as a smoothed texture. Null on a refusal. */
  mesh: CaeMeshView | null;
  /** The constraints the solver actually applied (identical to what
   *  previewAssembly reports pre-solve). Null on a refusal. */
  constraints: CaeConstraintView | null;
  /** Nodal translations in MESH NODE ORDER, 3 floats per node (mm, world).
   *  Feeds the deformed-shape display. */
  nodeDisp: Float32Array;
  /** Per-node |u| (mm) in mesh node order — the deflection contour field. */
  nodeDispMag: Float32Array;
  /** Per-node von Mises surface stress (MPa) in mesh node order, nodally
   *  averaged from the incident elements. NaN where nothing was recovered. */
  nodeVm: Float32Array;
}

// ---------------------------------------------------------------------------
// MESH + CONSTRAINT VIEW
//
// The solver's discretisation, in a shape the 3D viewer can draw directly.
// This is deliberately the SAME data preprocessAssembly() hands the assembler
// — not a re-derivation — so "show me the mesh" shows the mesh that is
// actually solved, and the support/joint/load glyphs mark the nodes that are
// actually grounded, coupled and loaded.
// ---------------------------------------------------------------------------

/** Which element family the mesh is built from. */
export type MeshKind = 'shell' | 'solid';

export interface CaeMeshView {
  kind: MeshKind;
  /** World node positions, 3 floats per node, in solver node order. */
  nodes: Float32Array;
  /** Connectivity: `nodesPerElem` node indices per element. */
  elems: Int32Array;
  /** 4 → shell quads (in-plane); 8 → solid hexes (through-thickness). */
  nodesPerElem: 4 | 8;
  /** Owning panel id per element. */
  panelOf: Int32Array;
  nodeCount: number;
  elemCount: number;
  dofPerNode: number;
  dofCount: number;
  /** In-plane element edge size range (mm) — the mesh stats line. */
  minEdgeMm: number;
  maxEdgeMm: number;
  /** Solid only: element layers through the panel thickness. */
  throughLayers: number;
  /** The element size requested (mm), when the mesh was specified by size. */
  requestedSizeMm?: number;
  /** True when the DOF ceiling forced a coarser mesh than requested. */
  coarsened: boolean;
  /** DOF the requested size would have needed — what the ceiling refused. */
  uncappedDof: number;
}

/** One node-pair coupling the solver created for a detected joint. */
export interface CaeJointLink { p0: Vec3World; p1: Vec3World; stiffness: JointStiffness; }

/** One nodal force (N, world) produced by a patch load. */
export interface CaeNodalLoad { at: Vec3World; f: Vec3World; }

export interface CaeConstraintView {
  /** World positions of fully-fixed (floor-grounded) nodes, 3 floats each. */
  grounded: Float32Array;
  groundedCount: number;
  /** The node-pair couplings — one per penalty spring set. */
  jointLinks: CaeJointLink[];
  /** Nodal force vectors from the patch loads. */
  loads: CaeNodalLoad[];
  /** Σ|F| over the loaded nodes (N). */
  totalLoadN: number;
}

export type AsmPreview =
  | { ok: true; mesh: CaeMeshView; constraints: CaeConstraintView; resolutionLog: string }
  | { ok: false; message: string };

// ---------------------------------------------------------------------------
// FRINGE-PLOT COLOUR MAPS + LEGEND SPEC
//
// One place for every CAE display — the 3D mesh contour, the per-panel texture
// overlay, the on-canvas legend and the PDF — so a legend can never describe a
// scale the geometry isn't actually painted with.
// ---------------------------------------------------------------------------

export type ColorMapId = 'rainbow' | 'jet' | 'turbo' | 'viridis' | 'coolwarm' | 'grayscale';

type Stop = [number, [number, number, number]];

const COLOR_MAPS: Record<ColorMapId, { label: string; stops: Stop[] }> = {
  rainbow: {
    label: 'Rainbow',
    stops: [
      [0.0, [40, 90, 220]], [0.34, [40, 190, 120]],
      [0.67, [235, 205, 50]], [1.0, [220, 55, 45]],
    ],
  },
  jet: {
    label: 'Jet',
    stops: [
      [0.0, [0, 0, 127]], [0.125, [0, 0, 255]], [0.375, [0, 255, 255]],
      [0.625, [255, 255, 0]], [0.875, [255, 0, 0]], [1.0, [127, 0, 0]],
    ],
  },
  turbo: {
    label: 'Turbo',
    stops: [
      [0.0, [48, 18, 59]], [0.125, [68, 88, 203]], [0.25, [62, 155, 254]],
      [0.375, [24, 214, 203]], [0.5, [70, 248, 132]], [0.625, [162, 252, 60]],
      [0.75, [225, 221, 55]], [0.875, [253, 165, 49]], [1.0, [122, 4, 3]],
    ],
  },
  viridis: {
    label: 'Viridis',
    stops: [
      [0.0, [68, 1, 84]], [0.25, [59, 82, 139]], [0.5, [33, 145, 140]],
      [0.75, [94, 201, 98]], [1.0, [253, 231, 37]],
    ],
  },
  coolwarm: {
    label: 'Cool → warm',
    stops: [[0.0, [59, 76, 192]], [0.5, [221, 221, 221]], [1.0, [180, 4, 38]]],
  },
  grayscale: {
    label: 'Grayscale',
    stops: [[0.0, [26, 26, 26]], [1.0, [245, 245, 245]]],
  },
};

export function colorMapOptions(): { id: ColorMapId; label: string }[] {
  return (Object.keys(COLOR_MAPS) as ColorMapId[]).map((id) => ({ id, label: COLOR_MAPS[id].label }));
}

/** How a result field is mapped onto colour. Everything the legend shows and
 *  everything the contour paints comes from this one object. */
export interface LegendSpec {
  map: ColorMapId;
  /** Flip the ramp (red at the low end). */
  reverse: boolean;
  /** 0 = smooth/continuous; otherwise the number of discrete contour bands. */
  bands: number;
  /** Manual range. null on either end = take it from the data. */
  min: number | null;
  max: number | null;
  /** Decimal places in the legend labels. */
  decimals: number;
  /** Force scientific notation instead of picking per magnitude. */
  scientific: boolean;
}

export const DEFAULT_LEGEND: LegendSpec = {
  map: 'rainbow', reverse: false, bands: 12, min: null, max: null,
  decimals: 2, scientific: false,
};

function rampAt(stops: Stop[], t: number): [number, number, number] {
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0 || 1);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f),
      ];
    }
  }
  return stops[stops.length - 1][1];
}

/**
 * Colour for a normalised position t ∈ [0,1] under a legend spec.
 *
 * Banding quantises to the BAND CENTRE, so every value inside a band gets
 * exactly the colour the legend's swatch for that band shows — which is the
 * whole point of a banded contour plot, and would be lost if it quantised to
 * the band edge.
 */
export function sampleColorMap(spec: LegendSpec, t: number): [number, number, number] {
  let u = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  if (spec.bands > 0) {
    const b = Math.min(spec.bands - 1, Math.floor(u * spec.bands));
    u = (b + 0.5) / spec.bands;
  }
  if (spec.reverse) u = 1 - u;
  return rampAt(COLOR_MAPS[spec.map]?.stops ?? COLOR_MAPS.rainbow.stops, u);
}

/** Normalise a field value into [0,1] across the legend's resolved range. */
export function legendT(v: number, lo: number, hi: number): number {
  const span = hi - lo;
  if (!(span > 0)) return 0;
  return (v - lo) / span;
}

/**
 * The range the legend and the contour both use: the manual bounds where the
 * user set them, otherwise the ACTUAL data min/max. Auto-scaling between the
 * real extremes — rather than 0…max — is what makes small variations in a field
 * that never approaches zero readable at all.
 */
export function resolveLegendRange(
  spec: LegendSpec, dataMin: number, dataMax: number,
): { lo: number; hi: number } {
  let lo = spec.min ?? dataMin;
  let hi = spec.max ?? dataMax;
  if (!Number.isFinite(lo)) lo = 0;
  if (!Number.isFinite(hi)) hi = lo + 1;
  if (hi <= lo) hi = lo + Math.max(Math.abs(lo) * 1e-6, 1e-9);
  return { lo, hi };
}

/** Min/max of a per-node field, skipping the NaN holes. */
export function fieldExtent(field: Float32Array): { min: number; max: number } {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < field.length; i++) {
    const v = field[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min)) return { min: 0, max: 0 };
  return { min, max };
}

/** Legend tick label, respecting the spec's decimals + notation choice. */
export function formatLegendValue(v: number, spec: LegendSpec): string {
  if (spec.scientific) return v.toExponential(spec.decimals);
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(spec.decimals);
  return v.toFixed(spec.decimals);
}

/**
 * The default rainbow ramp for t ∈ [0,1]. Kept as a thin wrapper over the
 * colour-map table for callers that don't carry a LegendSpec (the PDF pages).
 */
export function heatColor(t: number): [number, number, number] {
  return rampAt(COLOR_MAPS.rainbow.stops, Math.max(0, Math.min(1, t)));
}

// ---------------------------------------------------------------------------
// SIDECAR SERIALIZATION — the SAME preprocessed model (mesh nodes, quads,
// joint node-pair links, floor grounding, nodal loads) that solveAssembly
// builds, in a JSON-able shape a local structural-FE sidecar (server/main.py,
// PyNite) can solve. The sidecar returns a 6-DOF-per-node displacement vector
// in THIS node ordering, which recoverAssembly() feeds into the EXISTING stress
// recovery + verdicts — so the sidecar only replaces the linear solve.
// ---------------------------------------------------------------------------

/** One quad element: node indices (i,j,m,n CCW), thickness, material name. */
export interface SidecarQuad { n: [number, number, number, number]; t: number; mat: string; }
/** A joint node-pair link with its stiffness class. */
export interface SidecarLink { a: number; b: number; stiffness: JointStiffness; }
/** A world nodal force (N). */
export interface SidecarLoad { node: number; fx: number; fy: number; fz: number; }
/** An isotropic material card for the sidecar. E is the EFFECTIVE modulus
 *  (sqrt(eAlong·eAcross) for orthotropic ply) — PyNite plates are isotropic. */
export interface SidecarMaterial { name: string; E: number; G: number; nu: number; rho: number; }

/** The full JSON model handed to the sidecar's POST /solve. */
export interface SidecarModel {
  nodes: [number, number, number][];
  materials: SidecarMaterial[];
  quads: SidecarQuad[];
  links: SidecarLink[];
  supports: number[];
  loads: SidecarLoad[];
  /** The per-DOF soft grounding-spring stiffness the app's OWN solver uses
   *  (repStiff·1e-4). Passing it lets the sidecar regularize residual
   *  rigid-body / weakly-coupled-sub-assembly modes identically to cae.ts —
   *  strong enough to pin an orphan panel, negligible for a constrained DOF. */
  kSoft: number;
}

/** An external async linear solver (e.g. the PyNite sidecar). Given the
 *  serialized model it returns the 6-DOF-per-node displacement vector (mm/rad)
 *  in node order, or null on any failure (caller falls back). `name`/`label`
 *  name the backend for the result line; `backendTag` is the AsmResult.backend
 *  enum value. */
export interface AsyncAssemblySolver {
  readonly name: string;
  solve(model: SidecarModel): Promise<{ disp: Float64Array; solveMs: number; buildMs: number; label: string } | null>;
}

/** Monotonic-ish millisecond clock, usable in both browser and node/tsx. */
const nowMs = (): number =>
  (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

// --- small 3D helpers (local to the assembly solver) ---
const w3sub = (a: Vec3World, b: Vec3World): Vec3World => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const w3dot = (a: Vec3World, b: Vec3World) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const w3len = (a: Vec3World) => Math.hypot(a[0], a[1], a[2]);
const w3add = (a: Vec3World, b: Vec3World): Vec3World => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const w3scale = (a: Vec3World, s: number): Vec3World => [a[0] * s, a[1] * s, a[2] * s];

/** Map a panel's local (ox, oy) mm point to world coords on its mid-surface. */
function panelLocalToWorld(p: AsmPanel, ox: number, oy: number): Vec3World {
  return w3add(w3add(p.origin, w3scale(p.uAxis, ox)), w3scale(p.vAxis, oy));
}

/** Distance (mm) from a world point to a world segment [s0,s1]. */
function pointSegDist(pt: Vec3World, s0: Vec3World, s1: Vec3World): number {
  const d = w3sub(s1, s0);
  const l2 = w3dot(d, d);
  if (l2 < 1e-12) return w3len(w3sub(pt, s0));
  let t = w3dot(w3sub(pt, s0), d) / l2;
  t = Math.max(0, Math.min(1, t));
  const proj = w3add(s0, w3scale(d, t));
  return w3len(w3sub(pt, proj));
}

// ---------------------------------------------------------------------------
// Membrane (plane-stress) element stiffness, Q4, selective reduced
// integration on the shear-coupling term is not needed here; we use full 2×2
// for the normal terms and a reduced 1×1 for the shear term to soften
// in-plane shear locking, mirroring the plate. DOF order per node [u, v].
// ---------------------------------------------------------------------------
function membraneD(e1: number, e2: number, g12: number, nu12: number, t: number): number[][] {
  const nu21 = (nu12 * e2) / e1;
  const denom = 1 - nu12 * nu21;
  const q11 = (e1 / denom) * t;
  const q22 = (e2 / denom) * t;
  const q12 = ((nu12 * e2) / denom) * t;
  const q33 = g12 * t;
  return [
    [q11, q12, 0],
    [q12, q22, 0],
    [0, 0, q33],
  ];
}

/** 8×8 membrane stiffness for a rectangle a×b. DOF order per node [u,v]. */
function membraneK(a: number, b: number, Dm: number[][]): number[][] {
  const K: number[][] = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const sx = [-1, 1, 1, -1];
  const se = [-1, -1, 1, 1];
  const jinvXi = 2 / a;
  const jinvEta = 2 / b;
  const jac = (a / 2) * (b / 2);
  const addBtDB = (B: number[][], wgt: number) => {
    const DB: number[][] = [new Array(8).fill(0), new Array(8).fill(0), new Array(8).fill(0)];
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 8; c++)
        DB[r][c] = Dm[r][0] * B[0][c] + Dm[r][1] * B[1][c] + Dm[r][2] * B[2][c];
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++) {
        const v = (B[0][r] * DB[0][c] + B[1][r] * DB[1][c] + B[2][r] * DB[2][c]) * wgt;
        if (v !== 0) K[r][c] += v;
      }
  };
  // Normal strains (εx, εy) — full 2×2. Shear (γxy) — reduced 1×1 at centre.
  const Bat = (xi: number, eta: number): { dNdx: number[]; dNdy: number[] } => {
    const dNdx = new Array(4), dNdy = new Array(4);
    for (let i = 0; i < 4; i++) {
      dNdx[i] = 0.25 * sx[i] * (1 + se[i] * eta) * jinvXi;
      dNdy[i] = 0.25 * se[i] * (1 + sx[i] * xi) * jinvEta;
    }
    return { dNdx, dNdy };
  };
  // Split D into normal-only and shear-only parts so we can integrate them at
  // different rules while sharing one accumulate.
  for (const xi of GP2) {
    for (const eta of GP2) {
      const { dNdx, dNdy } = Bat(xi, eta);
      const B: number[][] = [new Array(8).fill(0), new Array(8).fill(0), new Array(8).fill(0)];
      for (let i = 0; i < 4; i++) {
        B[0][i * 2] = dNdx[i];      // εx = ∂u/∂x
        B[1][i * 2 + 1] = dNdy[i];  // εy = ∂v/∂y
      }
      // Normal-only D (zero the shear row/col).
      const Dn = [[Dm[0][0], Dm[0][1], 0], [Dm[1][0], Dm[1][1], 0], [0, 0, 0]];
      addBtDBWith(K, B, Dn, jac);
    }
  }
  {
    const { dNdx, dNdy } = Bat(0, 0);
    const B: number[][] = [new Array(8).fill(0), new Array(8).fill(0), new Array(8).fill(0)];
    for (let i = 0; i < 4; i++) {
      B[2][i * 2] = dNdy[i];      // γxy = ∂u/∂y + ∂v/∂x
      B[2][i * 2 + 1] = dNdx[i];
    }
    const Ds = [[0, 0, 0], [0, 0, 0], [0, 0, Dm[2][2]]];
    addBtDBWith(K, B, Ds, 4 * jac);
  }
  return K;
}

/** K += Bᵀ·D·B · wgt for arbitrary square K sized to B's columns. */
function addBtDBWith(K: number[][], B: number[][], D: number[][], wgt: number) {
  const cols = B[0].length;
  const DB: number[][] = [new Array(cols).fill(0), new Array(cols).fill(0), new Array(cols).fill(0)];
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < cols; c++)
      DB[r][c] = D[r][0] * B[0][c] + D[r][1] * B[1][c] + D[r][2] * B[2][c];
  for (let r = 0; r < cols; r++)
    for (let c = 0; c < cols; c++) {
      const v = (B[0][r] * DB[0][c] + B[1][r] * DB[1][c] + B[2][r] * DB[2][c]) * wgt;
      if (v !== 0) K[r][c] += v;
    }
}

// ---------------------------------------------------------------------------
// JOINT DETECTION
// ---------------------------------------------------------------------------
/** The four world edges of a panel's outline bbox, each as [p0,p1,length]. */
function panelBboxEdges(p: AsmPanel): { p0: Vec3World; p1: Vec3World; len: number }[] {
  const w = p.outline.bbox.w, h = p.outline.bbox.h;
  const c = (ox: number, oy: number) => panelLocalToWorld(p, ox, oy);
  const seg = (a: Vec3World, b: Vec3World) => ({ p0: a, p1: b, len: w3len(w3sub(b, a)) });
  return [
    seg(c(0, 0), c(w, 0)),   // bottom
    seg(c(w, 0), c(w, h)),   // right
    seg(c(w, h), c(0, h)),   // top
    seg(c(0, h), c(0, 0)),   // left
  ];
}

/**
 * Detect joints for every panel pair: an edge of one panel that runs within
 * `tol` mm of the other panel's plane AND overlaps its footprint produces a
 * contact segment. We sample each edge; the contiguous run of in-contact
 * samples defines the segment endpoints + length. One joint per pair (the
 * longest contact run) to keep the list readable.
 */
export function detectJoints(panels: AsmPanel[], tolMm: number): AsmJoint[] {
  const joints: AsmJoint[] = [];
  for (let i = 0; i < panels.length; i++) {
    for (let j = i + 1; j < panels.length; j++) {
      const a = panels[i], b = panels[j];
      const seg = bestContact(a, b, tolMm);
      if (seg) {
        joints.push({ a: a.id, b: b.id, p0: seg.p0, p1: seg.p1, length: seg.len, stiffness: 'rigid' });
      }
    }
  }
  // Longest contacts first — the structurally dominant joints lead the list.
  joints.sort((x, y) => y.length - x.length);
  return joints;
}

/**
 * True if world point `pt` — a sample on the mid-surface of a panel whose own
 * half-thickness is `srcHalfT` and whose normal is `srcNormal` — lies close
 * enough to panel `p` for the two SOLIDS to be in contact.
 *
 * Both panels are modelled on their mid-surfaces, so the mid-plane separation
 * at contact depends on how the normals sit relative to each other:
 *   • perpendicular (a butt joint — an edge into a face): the source panel's
 *     thickness runs parallel to the target's plane and adds nothing, so
 *     contact means d ≤ t_dst/2.
 *   • parallel (a face-to-face lap): the source's own half-thickness closes
 *     the gap, so contact means d ≤ t_dst/2 + t_src/2.
 * `|nSrc · nDst|` interpolates between the two exactly, instead of either
 * missing lap joints or inventing butt joints across a 9 mm air gap.
 */
function pointOnPanel(
  pt: Vec3World, p: AsmPanel, tol: number,
  srcHalfT = 0, srcNormal: Vec3World | null = null,
): boolean {
  const rel = w3sub(pt, p.origin);
  const d = Math.abs(w3dot(rel, p.normal));
  const align = srcNormal ? Math.abs(w3dot(srcNormal, p.normal)) : 0;
  if (d > tol + p.thicknessMm / 2 + srcHalfT * align + 0.01) return false;
  const ox = w3dot(rel, p.uAxis);
  const oy = w3dot(rel, p.vAxis);
  // Allow a tol slack around the footprint so an edge that lands just outside
  // still couples.
  if (ox < -tol || oy < -tol || ox > p.outline.bbox.w + tol || oy > p.outline.bbox.h + tol) return false;
  return pointInOutline(
    Math.max(0, Math.min(p.outline.bbox.w, ox)),
    Math.max(0, Math.min(p.outline.bbox.h, oy)),
    p.outline,
  );
}

/** The longest contiguous contact run between a's edges and panel b (or b's
 *  edges and a) within `tol`. Returns the world segment or null. */
function bestContact(a: AsmPanel, b: AsmPanel, tol: number): { p0: Vec3World; p1: Vec3World; len: number } | null {
  const tryDir = (src: AsmPanel, dst: AsmPanel): { p0: Vec3World; p1: Vec3World; len: number } | null => {
    let best: { p0: Vec3World; p1: Vec3World; len: number } | null = null;
    for (const e of panelBboxEdges(src)) {
      if (e.len < 1e-3) continue;
      const steps = Math.max(8, Math.min(200, Math.ceil(e.len / 10)));
      let runStart = -1;
      const closeRun = (endIdx: number) => {
        if (runStart < 0) return;
        const t0 = runStart / steps, t1 = endIdx / steps;
        const p0 = w3add(e.p0, w3scale(w3sub(e.p1, e.p0), t0));
        const p1 = w3add(e.p0, w3scale(w3sub(e.p1, e.p0), t1));
        const len = w3len(w3sub(p1, p0));
        if (len > 1e-3 && (!best || len > best.len)) best = { p0, p1, len };
        runStart = -1;
      };
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const pt = w3add(e.p0, w3scale(w3sub(e.p1, e.p0), t));
        if (pointOnPanel(pt, dst, tol, src.thicknessMm / 2, src.normal)) {
          if (runStart < 0) runStart = s;
        } else {
          closeRun(s - 1);
        }
      }
      closeRun(steps);
    }
    return best;
  };
  const fromA = tryDir(a, b);
  const fromB = tryDir(b, a);
  if (!fromA) return fromB;
  if (!fromB) return fromA;
  return fromA.len >= fromB.len ? fromA : fromB;
}

// ---------------------------------------------------------------------------
// ASSEMBLY MESH + SOLVE
// ---------------------------------------------------------------------------
interface PanelMesh {
  panel: AsmPanel;
  nx: number; ny: number; dx: number; dy: number;
  active: Uint8Array;
  activeCells: [number, number][];
  /** Global node index for each grid node (−1 if inactive). Offset into the
   *  assembly's node table. */
  gnode: Int32Array;
}

/**
 * Rasterise one panel into a grid.
 *
 * `elementSizeMm`, when given, is the ABSOLUTE target element edge — the way a
 * mesh size is normally specified, and the only way an element size means the
 * same thing on a 2.4 m top as on a 300 mm shelf. Falling back to `target`
 * active nodes per panel gives every panel the same node COUNT regardless of
 * size, which silently under-resolves the big ones.
 */
function meshPanel(p: AsmPanel, target: number, elementSizeMm?: number): {
  nx: number; ny: number; dx: number; dy: number;
  active: Uint8Array; activeCells: [number, number][]; activeCount: number;
} {
  const bboxW = p.outline.bbox.w;
  const bboxH = p.outline.bbox.h;
  let nx: number, ny: number;
  if (elementSizeMm && elementSizeMm > 0) {
    // CEIL, not round: the requested size is a MAXIMUM edge length. Rounding
    // lets a panel whose length doesn't divide evenly come out coarser than
    // asked for (a 101 mm rail at "20 mm" rounds to 5 divisions → 20.3 mm
    // elements). Ceiling guarantees every element is ≤ the requested size on
    // both axes, which is what selecting a mesh size is supposed to promise.
    nx = Math.ceil(bboxW / elementSizeMm) + 1;
    ny = Math.ceil(bboxH / elementSizeMm) + 1;
  } else {
    const areaFrac = Math.max(0.15, outlineArea(p.outline) / (bboxW * bboxH || 1));
    const aspect = bboxW / (bboxH || 1);
    ny = Math.round(Math.sqrt((target / areaFrac) / aspect)) + 1;
    nx = Math.round(ny * aspect) + 1;
  }
  nx = Math.max(nx, 4); ny = Math.max(ny, 4);
  const dx = bboxW / (nx - 1);
  const dy = bboxH / (ny - 1);
  const nNodes = nx * ny;
  const active = new Uint8Array(nNodes);
  const activeCells: [number, number][] = [];
  const nodeIdx = (ix: number, iy: number) => iy * nx + ix;
  for (let iy = 0; iy < ny - 1; iy++) {
    for (let ix = 0; ix < nx - 1; ix++) {
      const cx = (ix + 0.5) * dx, cy = (iy + 0.5) * dy;
      if (pointInOutline(cx, cy, p.outline)) {
        activeCells.push([ix, iy]);
        active[nodeIdx(ix, iy)] = 1;
        active[nodeIdx(ix + 1, iy)] = 1;
        active[nodeIdx(ix, iy + 1)] = 1;
        active[nodeIdx(ix + 1, iy + 1)] = 1;
      }
    }
  }
  let activeCount = 0;
  for (let i = 0; i < nNodes; i++) if (active[i]) activeCount++;
  return { nx, ny, dx, dy, active, activeCells, activeCount };
}

// ---------------------------------------------------------------------------
// STRESS RECOVERY — from the converged displacement field.
//
// Per element, evaluate the SAME membrane + bending B-matrices used in the
// assembly at the element CENTRE (ξ=η=0, matching the reduced-integration
// point) against the element's local displacement vector. That gives:
//   membrane force resultants  N  = Dm·ε   (N/mm — Dm already carries ×t)
//   bending moment resultants  M  = Db·κ   (N·mm/mm — Db carries ×t³/12)
// Combine to the two panel-face stresses  σ = N/t ± 6M/t²  (MPa == N/mm²),
// take plane-stress von Mises on each face, keep the worse of the two.
// ---------------------------------------------------------------------------

/** Membrane strain (εx, εy, γxy) at the element centre from local [u,v]×4. */
function membraneStrainCentre(dx: number, dy: number, ul: number[]): [number, number, number] {
  // dN/dx, dN/dy at ξ=η=0. Nodes: 0(-,-) 1(+,-) 2(+,+) 3(-,+).
  const sx = [-1, 1, 1, -1];
  const se = [-1, -1, 1, 1];
  const dNdx = new Array(4), dNdy = new Array(4);
  for (let i = 0; i < 4; i++) {
    dNdx[i] = 0.25 * sx[i] * (2 / dx); // (1 + se·η)=1 at η=0
    dNdy[i] = 0.25 * se[i] * (2 / dy); // (1 + sx·ξ)=1 at ξ=0
  }
  let ex = 0, ey = 0, gxy = 0;
  for (let i = 0; i < 4; i++) {
    const u = ul[i * 2], v = ul[i * 2 + 1];
    ex += dNdx[i] * u;
    ey += dNdy[i] * v;
    gxy += dNdy[i] * u + dNdx[i] * v;
  }
  return [ex, ey, gxy];
}

/** Bending curvature (κx, κy, κxy) at the element centre from local
 *  [w, θu(=θx), θv(=θy)]×4 — matching elementK's curvature convention. */
function bendingCurvatureCentre(dx: number, dy: number, wl: number[]): [number, number, number] {
  const sx = [-1, 1, 1, -1];
  const se = [-1, -1, 1, 1];
  const dNdx = new Array(4), dNdy = new Array(4);
  for (let i = 0; i < 4; i++) {
    dNdx[i] = 0.25 * sx[i] * (2 / dx);
    dNdy[i] = 0.25 * se[i] * (2 / dy);
  }
  // κx = ∂θy/∂x ; κy = −∂θx/∂y ; κxy = ∂θy/∂y − ∂θx/∂x
  let kx = 0, ky = 0, kxy = 0;
  for (let i = 0; i < 4; i++) {
    const thx = wl[i * 3 + 1]; // θu == θx
    const thy = wl[i * 3 + 2]; // θv == θy
    kx += dNdx[i] * thy;
    ky += -dNdy[i] * thx;
    kxy += dNdy[i] * thy - dNdx[i] * thx;
  }
  return [kx, ky, kxy];
}

/** 3×3 · 3-vector. */
function m3v(D: number[][], v: [number, number, number]): [number, number, number] {
  return [
    D[0][0] * v[0] + D[0][1] * v[1] + D[0][2] * v[2],
    D[1][0] * v[0] + D[1][1] * v[1] + D[1][2] * v[2],
    D[2][0] * v[0] + D[2][1] * v[1] + D[2][2] * v[2],
  ];
}

/** Plane-stress von Mises of (σx, σy, τxy) in MPa. */
function vonMises(sx: number, sy: number, txy: number): number {
  return Math.sqrt(sx * sx - sx * sy + sy * sy + 3 * txy * txy);
}

// ---------------------------------------------------------------------------
// PREPROCESSING — the deterministic front half shared by the internal solve,
// the sidecar serializer, and the sidecar-displacement recovery. Meshing, the
// global node table, per-panel D-matrices, joint node-pairing, floor grounding
// and the (pre-BC) world load vector are all a pure function of `opts`, so
// building them ONCE and reusing guarantees the sidecar's returned displacement
// vector maps back into exactly the same node/DOF ordering the internal solve
// and the stress recovery expect.
// ---------------------------------------------------------------------------
interface AsmPreprocess {
  meshes: PanelMesh[];
  panelById: Map<number, PanelMesh>;
  nodePos: Vec3World[];
  totalNodes: number;
  nDof: number;
  resolutionLog: string;
  panelD: Map<number, { Db: number[][]; Dm: number[][] }>;
  panelStiff: Map<number, number>;
  repStiff: number;
  /** Resolved joint couplings: each app joint expanded to nearest a→b node
   *  pairs, with the joint's stiffness class + the per-joint translational
   *  penalty (softer-of-the-two-panels × 1e3). Drives BOTH the internal penalty
   *  springs and the sidecar link members. */
  jointPairs: { gi: number; gj: number; stiffness: JointStiffness; kTrans: number }[];
  grounded: number[];
  groundPoints: Vec3World[];
  /** World load vector (6 DOF/node), before Dirichlet BCs are applied. */
  F: Float64Array;
  /** The element size the caller asked for (mm), if it asked by size. */
  requestedSizeMm?: number;
  /** The element size actually meshed at, after any DOF-cap coarsening. */
  achievedSizeMm?: number;
  /** DOF the requested size would have produced — what the cap refused. */
  uncappedDof: number;
  /** True when the DOF cap forced a coarser mesh than requested. */
  coarsened: boolean;
}

/** Refusal marker when preprocessing can't produce a solvable model. */
interface AsmPreFail { fail: true; message: string; resolutionLog: string; totalNodes: number; nDof: number; }

function preprocessAssembly(opts: AsmSolveOptions, report: (p: SolveProgress) => void): AsmPreprocess | AsmPreFail {
  const { panels, joints, loads, tolMm } = opts;
  const maxDof = opts.maxDof ?? 60000;
  let target = opts.targetNodesPerPanel ?? 600;
  let elementSize = opts.elementSizeMm;

  // --- STAGE: preprocessing (meshing) — OUR TypeScript. ---
  report({ stage: 'meshing', pct: 5, detail: `${panels.length} panel${panels.length === 1 ? '' : 's'}` });

  // Auto-coarsen so total DOF ≈ 6 · Σ activeNodes ≤ maxDof. In element-size
  // mode the coarsening grows the SIZE in gentle steps rather than jumping, so
  // a job that only just exceeds the cap ends up near the size that was asked
  // for instead of several times coarser than it.
  let meshes: PanelMesh[] = [];
  let totalNodes = 0;
  let coarsened = false;
  const requestedSizeMm = elementSize;
  let uncappedDof = 0;

  // PRE-ESTIMATE the node count analytically and coarsen the size BEFORE
  // building anything. A 5 mm request on a 2.4 m cabinet is several hundred
  // thousand nodes; discovering that by materialising the mesh and then
  // throwing it away blocks the main thread for tens of seconds (and can run
  // the tab out of memory) before the cap ever gets a chance to apply.
  if (elementSize && elementSize > 0) {
    const estNodes = (s: number) => {
      let n = 0;
      for (const p of panels) {
        const w = p.outline.bbox.w, h = p.outline.bbox.h;
        const areaFrac = Math.max(0.15, outlineArea(p.outline) / (w * h || 1));
        n += (Math.ceil(w / s) + 1) * (Math.ceil(h / s) + 1) * areaFrac;
      }
      return n;
    };
    uncappedDof = Math.round(estNodes(elementSize) * 6);
    let guard = 0;
    while (estNodes(elementSize) * 6 > maxDof && guard++ < 60) {
      const need = Math.sqrt((estNodes(elementSize) * 6) / maxDof);
      elementSize *= Math.max(1.08, need);
      coarsened = true;
    }
  }

  for (let attempt = 0; attempt < 12; attempt++) {
    meshes = [];
    totalNodes = 0;
    const nodeTable: Vec3World[] = [];
    for (const p of panels) {
      const m = meshPanel(p, target, elementSize);
      const gnode = new Int32Array(m.nx * m.ny).fill(-1);
      for (let iy = 0; iy < m.ny; iy++) {
        for (let ix = 0; ix < m.nx; ix++) {
          const n = iy * m.nx + ix;
          if (m.active[n]) {
            gnode[n] = nodeTable.length;
            nodeTable.push(panelLocalToWorld(p, ix * m.dx, iy * m.dy));
          }
        }
      }
      meshes.push({ panel: p, nx: m.nx, ny: m.ny, dx: m.dx, dy: m.dy, active: m.active, activeCells: m.activeCells, gnode });
      totalNodes += m.activeCount;
    }
    if (attempt === 0 && !uncappedDof) uncappedDof = totalNodes * 6;
    if (totalNodes * 6 <= maxDof) break;
    coarsened = true;
    if (elementSize && elementSize > 0) {
      // Node count scales ~1/size², so this is the step that just clears the
      // cap, floored at +15% so it always makes progress.
      const need = Math.sqrt((totalNodes * 6) / maxDof);
      elementSize *= Math.max(1.15, need);
    } else {
      target = Math.max(120, Math.floor(target * (maxDof / (totalNodes * 6)) * 0.9));
    }
  }

  const nDof = totalNodes * 6;
  const sizeNote = elementSize && elementSize > 0
    ? `${elementSize.toFixed(1)} mm elements`
      + (coarsened ? ` (asked ${requestedSizeMm?.toFixed(0)} mm → ${uncappedDof.toLocaleString()} DOF, over the cap)` : '')
    : `target ${target}/panel`;
  const resolutionLog =
    `${panels.length} panel${panels.length === 1 ? '' : 's'} · ${totalNodes} nodes · ${nDof} DOF · ${sizeNote}`;

  // --- STAGE: assembling the global stiffness — OUR TypeScript. ---
  report({ stage: 'assembling', pct: 25, detail: `${nDof.toLocaleString()} DOF` });

  // Rebuild the global node table (positions) so we can ground + couple.
  const nodePos: Vec3World[] = new Array(totalNodes);
  for (const m of meshes) {
    for (let iy = 0; iy < m.ny; iy++) {
      for (let ix = 0; ix < m.nx; ix++) {
        const g = m.gnode[iy * m.nx + ix];
        if (g >= 0) nodePos[g] = panelLocalToWorld(m.panel, ix * m.dx, iy * m.dy);
      }
    }
  }

  // Per-panel D-matrices (retained for stress recovery) + representative plate
  // stiffness per panel (for joint-penalty scaling).
  const panelStiff = new Map<number, number>();
  let repStiff = 0;
  const panelD = new Map<number, { Db: number[][]; Dm: number[][] }>();
  for (const m of meshes) {
    const p = m.panel;
    const t = p.thicknessMm;
    const e1 = p.material.isotropic ? p.material.eAlong : (p.grainAlongLength ? p.material.eAlong : p.material.eAcross);
    const e2 = p.material.isotropic ? p.material.eAlong : (p.grainAlongLength ? p.material.eAcross : p.material.eAlong);
    const Db = bendingD(e1, e2, p.material.gShear, NU, t);
    const Dm = membraneD(e1, e2, p.material.gShear, NU, t);
    panelD.set(p.id, { Db, Dm });
    const pStiff = Dm[0][0] / (m.dx * m.dy);
    panelStiff.set(p.id, pStiff);
    repStiff = Math.max(repStiff, pStiff);
  }
  if (repStiff <= 0 || !Number.isFinite(repStiff)) repStiff = 1e3;

  // --- JOINT node-pairing: for each app joint, pair each a-node along the
  //     contact segment with its nearest b-node. Shared by the internal penalty
  //     springs and the sidecar link members. ---
  const panelById = new Map<number, PanelMesh>();
  for (const m of meshes) panelById.set(m.panel.id, m);

  const nodesAlong = (m: PanelMesh, s0: Vec3World, s1: Vec3World, tol: number): number[] => {
    const out: number[] = [];
    for (let iy = 0; iy < m.ny; iy++) {
      for (let ix = 0; ix < m.nx; ix++) {
        const g = m.gnode[iy * m.nx + ix];
        if (g < 0) continue;
        if (pointSegDist(nodePos[g], s0, s1) <= tol) out.push(g);
      }
    }
    return out;
  };

  const jointPairs: { gi: number; gj: number; stiffness: JointStiffness; kTrans: number }[] = [];
  for (const j of joints) {
    const ma = panelById.get(j.a), mb = panelById.get(j.b);
    if (!ma || !mb) continue;
    const tol = Math.max(tolMm, Math.min(ma.dx, ma.dy, mb.dx, mb.dy) * 1.5);
    const na = nodesAlong(ma, j.p0, j.p1, tol);
    const nb = nodesAlong(mb, j.p0, j.p1, tol);
    if (na.length === 0 || nb.length === 0) continue;
    // Penalty stiffness ~1e3 × the SOFTER of the two joined panels — a per-joint
    // scale (not the global max) keeps the condition number bounded on mixed-
    // thickness jobs.
    const kTrans = Math.min(panelStiff.get(j.a) ?? repStiff, panelStiff.get(j.b) ?? repStiff) * 1e3;
    for (const gi of na) {
      let bestG = -1, bestD = Infinity;
      for (const gj of nb) {
        const d = w3len(w3sub(nodePos[gi], nodePos[gj]));
        if (d < bestD) { bestD = d; bestG = gj; }
      }
      if (bestG < 0) continue;
      jointPairs.push({ gi, gj: bestG, stiffness: j.stiffness, kTrans });
    }
  }

  // --- GROUNDING: fully-fixed supports on nodes within `groundBand` of the
  //     floor (the assembly's LOWEST world z). ---
  let zMin = Infinity, zMax = -Infinity;
  for (let g = 0; g < totalNodes; g++) {
    const z = nodePos[g][2];
    if (z < zMin) zMin = z;
    if (z > zMax) zMax = z;
  }
  const floorZ = zMin;
  const finestDx = Math.min(...meshes.map((m) => Math.min(m.dx, m.dy)));
  const groundBand = Math.max(tolMm, finestDx * 1.01, (zMax - zMin) * 0.01);
  const grounded: number[] = [];
  const groundPoints: Vec3World[] = [];
  for (let g = 0; g < totalNodes; g++) {
    if (nodePos[g][2] - floorZ <= groundBand) {
      grounded.push(g);
      groundPoints.push(nodePos[g]);
    }
  }
  if (grounded.length < 1) {
    return { fail: true,
      message: 'The assembly has no base on the floor — nothing to ground it. Check that at least one panel reaches the cabinet base.',
      resolutionLog, totalNodes, nDof };
  }

  // --- World load vector (pre-BC): spread each footprint load over the active
  //     nodes inside it, acting along −normal. ---
  const F = new Float64Array(nDof);
  for (const load of loads) {
    if (!load.N) continue;
    const m = panelById.get(load.panelId);
    if (!m) continue;
    const p = m.panel;
    const inFoot: number[] = [];
    const half = load.size / 2;
    for (let iy = 0; iy < m.ny; iy++) {
      for (let ix = 0; ix < m.nx; ix++) {
        const g = m.gnode[iy * m.nx + ix];
        if (g < 0) continue;
        const px = ix * m.dx, py = iy * m.dy;
        const within = load.size <= 0 ? false : (load.shape === 'round'
          ? Math.hypot(px - load.x, py - load.y) <= half + 1e-6
          : Math.abs(px - load.x) <= half + 1e-6 && Math.abs(py - load.y) <= half + 1e-6);
        if (within) inFoot.push(g);
      }
    }
    if (inFoot.length === 0) {
      let best = -1, bestD = Infinity;
      for (let iy = 0; iy < m.ny; iy++) {
        for (let ix = 0; ix < m.nx; ix++) {
          const g = m.gnode[iy * m.nx + ix];
          if (g < 0) continue;
          const d = Math.hypot(ix * m.dx - load.x, iy * m.dy - load.y);
          if (d < bestD) { bestD = d; best = g; }
        }
      }
      if (best >= 0) inFoot.push(best);
    }
    if (inFoot.length === 0) continue;
    const share = load.N / inFoot.length;
    const fWorld: Vec3World = w3scale(p.normal, -share);
    for (const g of inFoot) {
      F[g * 6] += fWorld[0];
      F[g * 6 + 1] += fWorld[1];
      F[g * 6 + 2] += fWorld[2];
    }
  }

  return {
    meshes, panelById, nodePos, totalNodes, nDof, resolutionLog,
    panelD, panelStiff, repStiff, jointPairs, grounded, groundPoints, F,
    requestedSizeMm, achievedSizeMm: elementSize, uncappedDof, coarsened,
  };
}

/**
 * The shell discretisation as a drawable mesh: one quad per active cell,
 * referencing the solver's own global node numbering. Cells touching an
 * inactive corner are skipped — exactly as the assembler skips them — so the
 * drawn mesh and the solved mesh are the same set of elements.
 */
function shellMeshView(pre: AsmPreprocess): CaeMeshView {
  const { meshes, nodePos, totalNodes, nDof } = pre;

  let elemCount = 0;
  for (const m of meshes) elemCount += m.activeCells.length;

  const nodes = new Float32Array(totalNodes * 3);
  for (let g = 0; g < totalNodes; g++) {
    const p = nodePos[g];
    nodes[g * 3] = p[0]; nodes[g * 3 + 1] = p[1]; nodes[g * 3 + 2] = p[2];
  }

  const elems = new Int32Array(elemCount * 4);
  const panelOf = new Int32Array(elemCount);
  let minEdge = Infinity, maxEdge = 0;
  let e = 0;
  for (const m of meshes) {
    minEdge = Math.min(minEdge, m.dx, m.dy);
    maxEdge = Math.max(maxEdge, m.dx, m.dy);
    const nodeIdx = (ix: number, iy: number) => iy * m.nx + ix;
    for (const [ix, iy] of m.activeCells) {
      const g0 = m.gnode[nodeIdx(ix, iy)];
      const g1 = m.gnode[nodeIdx(ix + 1, iy)];
      const g2 = m.gnode[nodeIdx(ix + 1, iy + 1)];
      const g3 = m.gnode[nodeIdx(ix, iy + 1)];
      if (g0 < 0 || g1 < 0 || g2 < 0 || g3 < 0) continue;
      elems[e * 4] = g0; elems[e * 4 + 1] = g1; elems[e * 4 + 2] = g2; elems[e * 4 + 3] = g3;
      panelOf[e] = m.panel.id;
      e++;
    }
  }

  return {
    kind: 'shell',
    nodes,
    elems: elems.subarray(0, e * 4),
    nodesPerElem: 4,
    panelOf: panelOf.subarray(0, e),
    nodeCount: totalNodes,
    elemCount: e,
    dofPerNode: 6,
    dofCount: nDof,
    minEdgeMm: Number.isFinite(minEdge) ? minEdge : 0,
    maxEdgeMm: maxEdge,
    throughLayers: 1,
    requestedSizeMm: pre.requestedSizeMm,
    coarsened: pre.coarsened,
    uncappedDof: pre.uncappedDof,
  };
}

/**
 * The SOLID discretisation: every shell cell extruded through the panel
 * thickness into `layers` 8-node hexahedra. Node numbering is
 * `shellNode * (layers + 1) + level`, so a solid node maps back to its
 * mid-surface shell node by integer division — which is what lets the solid
 * path reuse the shell's joint pairing and grounding.
 *
 * Level 0 sits on the −normal face, level `layers` on the +normal face; the
 * shell node's own position is the mid-surface.
 */
function solidMeshView(pre: AsmPreprocess, layersIn = 2): CaeMeshView {
  const { meshes, nodePos, totalNodes } = pre;
  const layers = Math.max(1, Math.round(layersIn));
  const levels = layers + 1;

  // Owning panel per global shell node (nodes are never shared between panels
  // — joints couple them with penalty springs instead of merging them).
  const ownerThick = new Float64Array(totalNodes);
  const ownerNx = new Float64Array(totalNodes * 3);
  for (const m of meshes) {
    const n = m.panel.normal;
    for (let i = 0; i < m.gnode.length; i++) {
      const g = m.gnode[i];
      if (g < 0) continue;
      ownerThick[g] = m.panel.thicknessMm;
      ownerNx[g * 3] = n[0]; ownerNx[g * 3 + 1] = n[1]; ownerNx[g * 3 + 2] = n[2];
    }
  }

  const nodeCount = totalNodes * levels;
  const nodes = new Float32Array(nodeCount * 3);
  for (let g = 0; g < totalNodes; g++) {
    const p = nodePos[g];
    const t = ownerThick[g];
    const nx = ownerNx[g * 3], ny = ownerNx[g * 3 + 1], nz = ownerNx[g * 3 + 2];
    for (let l = 0; l < levels; l++) {
      const off = (l / layers - 0.5) * t;   // −t/2 … +t/2
      const s = (g * levels + l) * 3;
      nodes[s] = p[0] + nx * off;
      nodes[s + 1] = p[1] + ny * off;
      nodes[s + 2] = p[2] + nz * off;
    }
  }

  let cellCount = 0;
  for (const m of meshes) cellCount += m.activeCells.length;
  const elems = new Int32Array(cellCount * layers * 8);
  const panelOf = new Int32Array(cellCount * layers);
  let minEdge = Infinity, maxEdge = 0;
  let e = 0;
  for (const m of meshes) {
    minEdge = Math.min(minEdge, m.dx, m.dy);
    maxEdge = Math.max(maxEdge, m.dx, m.dy);
    const nodeIdx = (ix: number, iy: number) => iy * m.nx + ix;
    for (const [ix, iy] of m.activeCells) {
      const q = [
        m.gnode[nodeIdx(ix, iy)],
        m.gnode[nodeIdx(ix + 1, iy)],
        m.gnode[nodeIdx(ix + 1, iy + 1)],
        m.gnode[nodeIdx(ix, iy + 1)],
      ];
      if (q.some((g) => g < 0)) continue;
      for (let l = 0; l < layers; l++) {
        const base = e * 8;
        // Standard hex ordering: bottom face 0-3 (level l), top face 4-7.
        for (let k = 0; k < 4; k++) elems[base + k] = q[k] * levels + l;
        for (let k = 0; k < 4; k++) elems[base + 4 + k] = q[k] * levels + l + 1;
        panelOf[e] = m.panel.id;
        e++;
      }
    }
  }

  return {
    kind: 'solid',
    nodes,
    elems: elems.subarray(0, e * 8),
    nodesPerElem: 8,
    panelOf: panelOf.subarray(0, e),
    nodeCount,
    elemCount: e,
    dofPerNode: 3,
    dofCount: nodeCount * 3,
    minEdgeMm: Number.isFinite(minEdge) ? minEdge : 0,
    maxEdgeMm: maxEdge,
    throughLayers: layers,
    requestedSizeMm: pre.requestedSizeMm,
    coarsened: pre.coarsened,
    uncappedDof: pre.uncappedDof,
  };
}

/**
 * The boundary conditions the solver applies, as drawable glyph data:
 * grounded nodes, joint node-pair couplings, and the nodal force vectors the
 * patch loads resolved to. Read straight off the preprocessed model.
 */
function constraintView(pre: AsmPreprocess): CaeConstraintView {
  const { nodePos, groundPoints, jointPairs, F, totalNodes } = pre;

  const grounded = new Float32Array(groundPoints.length * 3);
  for (let i = 0; i < groundPoints.length; i++) {
    const p = groundPoints[i];
    grounded[i * 3] = p[0]; grounded[i * 3 + 1] = p[1]; grounded[i * 3 + 2] = p[2];
  }

  const jointLinks: CaeJointLink[] = jointPairs.map((jp) => ({
    p0: nodePos[jp.gi], p1: nodePos[jp.gj], stiffness: jp.stiffness,
  }));

  const loads: CaeNodalLoad[] = [];
  let totalLoadN = 0;
  for (let g = 0; g < totalNodes; g++) {
    const fx = F[g * 6], fy = F[g * 6 + 1], fz = F[g * 6 + 2];
    if (fx === 0 && fy === 0 && fz === 0) continue;
    loads.push({ at: nodePos[g], f: [fx, fy, fz] });
    totalLoadN += Math.hypot(fx, fy, fz);
  }

  return { grounded, groundedCount: groundPoints.length, jointLinks, loads, totalLoadN };
}

/**
 * Build the model WITHOUT solving it, and hand back the mesh + constraints for
 * display. This is the "show me what you're about to solve" path: it runs the
 * identical preprocessing the solve runs, so the mesh density, the grounded
 * nodes, the joint couplings and the load distribution shown are the ones the
 * solver will use.
 */
export function previewAssembly(opts: AsmSolveOptions): AsmPreview {
  if (opts.panels.length === 0) return { ok: false, message: 'No panels selected.' };
  const pre = preprocessAssembly(opts, opts.onProgress ?? (() => {}));
  if ('fail' in pre) return { ok: false, message: pre.message };
  return {
    ok: true,
    mesh: opts.meshKind === 'solid' ? solidMeshView(pre) : shellMeshView(pre),
    constraints: constraintView(pre),
    resolutionLog: pre.resolutionLog,
  };
}

/**
 * Serialize the preprocessed assembly into the JSON model the local PyNite
 * sidecar solves. Quads reference per-panel isotropic materials with an
 * EFFECTIVE modulus E_eff = sqrt(eAlong·eAcross) (PyNite plates are isotropic —
 * documented fidelity note). Joint node-pairs become link members; floor-
 * grounded nodes become fully-fixed supports; the world load vector becomes
 * nodal forces. `pre` and the returned `context` share node ordering so the
 * sidecar's displacement vector maps straight back through recoverAssembly().
 */
export function serializeAssembly(opts: AsmSolveOptions):
  | { ok: true; model: SidecarModel; pre: AsmPreprocess }
  | { ok: false; message: string } {
  if (opts.panels.length === 0) return { ok: false, message: 'No panels selected.' };
  const pre = preprocessAssembly(opts, () => {});
  if ('fail' in pre) return { ok: false, message: pre.message };

  const nodes: [number, number, number][] = pre.nodePos.map((p) => [p[0], p[1], p[2]]);

  // One isotropic material per panel (keyed by panel id). E_eff = sqrt(E∥·E⊥).
  const materials: SidecarMaterial[] = [];
  const matName = new Map<number, string>();
  for (const m of pre.meshes) {
    const mat = m.panel.material;
    const eEff = mat.isotropic ? mat.eAlong : Math.sqrt(mat.eAlong * mat.eAcross);
    const name = `mat_p${m.panel.id}`;
    matName.set(m.panel.id, name);
    materials.push({ name, E: eEff, G: mat.gShear, nu: NU, rho: mat.density });
  }

  // Quads: every active cell of every panel, as global node indices (CCW).
  const quads: SidecarQuad[] = [];
  for (const m of pre.meshes) {
    const nodeIdx = (ix: number, iy: number) => iy * m.nx + ix;
    for (const [ix, iy] of m.activeCells) {
      const en = [nodeIdx(ix, iy), nodeIdx(ix + 1, iy), nodeIdx(ix + 1, iy + 1), nodeIdx(ix, iy + 1)];
      const g = en.map((n) => m.gnode[n]);
      if (g.some((x) => x < 0)) continue;
      quads.push({ n: [g[0], g[1], g[2], g[3]], t: m.panel.thicknessMm, mat: matName.get(m.panel.id)! });
    }
  }

  const links: SidecarLink[] = pre.jointPairs.map((jp) => ({ a: jp.gi, b: jp.gj, stiffness: jp.stiffness }));

  // Loads: the world load vector as per-node forces (translational DOFs only).
  const loads: SidecarLoad[] = [];
  for (let g = 0; g < pre.totalNodes; g++) {
    const fx = pre.F[g * 6], fy = pre.F[g * 6 + 1], fz = pre.F[g * 6 + 2];
    if (fx || fy || fz) loads.push({ node: g, fx, fy, fz });
  }

  // The app's own soft grounding-spring stiffness — passed so the sidecar
  // regularizes identically (see cae.ts kSoft in solveAssembly).
  const kSoft = pre.repStiff * 1e-4;

  return { ok: true, model: { nodes, materials, quads, links, supports: pre.grounded, loads, kSoft }, pre };
}

/**
 * Recover an AsmResult from a preprocessed model and an externally-supplied
 * 6-DOF-per-node displacement vector `x` (e.g. the PyNite sidecar's). Runs the
 * SAME per-element stress recovery + verdicts the internal solve uses — the
 * only difference is where `x` came from. `backend`/timings are stamped onto
 * the result for the UI/log line.
 */
export function recoverAssembly(
  pre: AsmPreprocess, x: Float64Array, panels: AsmPanel[],
  backend: SolveBackend, factorMs: number, solveMs: number,
): AsmResult {
  return finishAssembly(pre, x, panels, {
    backend, factorMs, solveMs, iterations: 0, converged: true,
  });
}

/**
 * Solve the whole assembly. Returns a refusal (ok:false) when the system is
 * under-constrained (nothing grounded / not enough grounding to prevent rigid
 * body motion) — reusing the guard+backstop pattern from the per-panel path.
 */
export function solveAssembly(opts: AsmSolveOptions): AsmResult {
  const { panels, tolMm } = opts;
  void tolMm;
  const report = opts.onProgress ?? (() => {});

  const empty = (msg: string): AsmResult => ({
    ok: false, message: msg, panels: [], maxDisp: 0, maxPanelId: -1, maxAt: [0, 0],
    spanMm: 0, verdict: 'ok', maxVm: 0, maxVmPanelId: -1, maxVmAt: [0, 0],
    utilPct: 0, stressVerdict: 'ok',
    totalDof: 0, totalNodes: 0, iterations: 0, converged: false,
    backend: 'PCG', factorMs: 0, solveMs: 0,
    groundedNodes: 0, resolutionLog: '', groundPoints: [],
    mesh: null, constraints: null,
    nodeDisp: new Float32Array(0), nodeDispMag: new Float32Array(0), nodeVm: new Float32Array(0),
  });

  if (panels.length === 0) return empty('No panels selected.');

  const pre = preprocessAssembly(opts, report);
  if ('fail' in pre) {
    return { ...empty(pre.message), resolutionLog: pre.resolutionLog, totalNodes: pre.totalNodes, totalDof: pre.nDof };
  }

  // The solid path shares this preprocessed model — the same in-plane grid,
  // joint pairing, grounding and load distribution — and re-discretises it
  // through the thickness into hexes.
  if (opts.meshKind === 'solid') return solveAssemblySolid(pre, opts, panels, report, empty);

  const { meshes, nDof, repStiff, jointPairs, grounded, F } = pre;

  // Assemble the global stiffness in a row-map (6 DOF/node).
  const rows: Map<number, number>[] = Array.from({ length: nDof }, () => new Map());
  const addK = (gi: number, gj: number, v: number) => {
    if (v === 0) return;
    const r = rows[gi];
    r.set(gj, (r.get(gj) ?? 0) + v);
  };

  // Element stiffness assembly (bending + membrane + drilling, rotated global).
  for (const m of meshes) {
    const p = m.panel;
    const t = p.thicknessMm;
    const e1 = p.material.isotropic ? p.material.eAlong : (p.grainAlongLength ? p.material.eAlong : p.material.eAcross);
    const e2 = p.material.isotropic ? p.material.eAlong : (p.grainAlongLength ? p.material.eAcross : p.material.eAlong);
    const Db = bendingD(e1, e2, p.material.gShear, NU, t);
    const Ds = shearD(p.material.gShear, p.material.gShear, t);
    const Dm = membraneD(e1, e2, p.material.gShear, NU, t);
    const Kb = elementK(m.dx, m.dy, Db, Ds);   // 12×12 [w,θx,θy] per node
    const Km = membraneK(m.dx, m.dy, Dm);       // 8×8  [u,v]     per node

    const ux = p.uAxis, vy = p.vAxis, nz = p.normal;
    const drill = (Dm[2][2]) * 1e-3;

    const nodeIdx = (ix: number, iy: number) => iy * m.nx + ix;
    for (const [ix, iy] of m.activeCells) {
      const en = [nodeIdx(ix, iy), nodeIdx(ix + 1, iy), nodeIdx(ix + 1, iy + 1), nodeIdx(ix, iy + 1)];
      const g = en.map((n) => m.gnode[n]);
      if (g.some((x) => x < 0)) continue;

      for (let ni = 0; ni < 4; ni++) {
        for (let nj = 0; nj < 4; nj++) {
          const blk: number[][] = Array.from({ length: 6 }, () => new Array(6).fill(0));
          blk[0][0] += Km[ni * 2][nj * 2];
          blk[0][1] += Km[ni * 2][nj * 2 + 1];
          blk[1][0] += Km[ni * 2 + 1][nj * 2];
          blk[1][1] += Km[ni * 2 + 1][nj * 2 + 1];
          for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 3; c++) {
              blk[2 + r][2 + c] += Kb[ni * 3 + r][nj * 3 + c];
            }
          }
          if (ni === nj) blk[5][5] += drill * m.dx * m.dy;
          rotateAndScatter(rows, blk, g[ni], g[nj], ux, vy, nz);
        }
      }
    }
  }

  // --- JOINT COUPLING: penalty springs between the preprocessed node pairs.
  //     rigid → all 6 DOF at full stiffness; semi-rigid → translational + 5%
  //     rotational; hinged → translational + a 0.1% token rotational stiffness
  //     (regularizes the razor-thin-seam mechanism so PCG converges). ---
  const addSpring = (gi: number, gj: number, dofOff: number, k: number) => {
    const di = gi * 6 + dofOff, dj = gj * 6 + dofOff;
    addK(di, di, k); addK(dj, dj, k);
    addK(di, dj, -k); addK(dj, di, -k);
  };
  for (const jp of jointPairs) {
    const kTrans = jp.kTrans;
    const kRot = jp.stiffness === 'rigid' ? kTrans
      : jp.stiffness === 'semi-rigid' ? kTrans * 0.05
        : kTrans * 0.001;
    for (let dof = 0; dof < 3; dof++) addSpring(jp.gi, jp.gj, dof, kTrans);
    if (kRot > 0) for (let dof = 3; dof < 6; dof++) addSpring(jp.gi, jp.gj, dof, kRot);
  }

  // Fixed DOFs from grounding.
  const fixed = new Uint8Array(nDof);
  for (const g of grounded) {
    for (let dof = 0; dof < 6; dof++) fixed[g * 6 + dof] = 1;
  }

  // Soft regularization on every free DOF (kills residual mechanisms).
  const kSoft = repStiff * 1e-4;
  for (let g = 0; g < nDof; g++) {
    if (fixed[g]) continue;
    const r = rows[g];
    r.set(g, (r.get(g) ?? 0) + kSoft);
  }

  // Copy the (pre-BC) load vector; BCs applied below.
  const Fsolve = new Float64Array(F);

  // Apply Dirichlet BCs (homogeneous).
  for (let g = 0; g < nDof; g++) {
    if (fixed[g]) { Fsolve[g] = 0; rows[g] = new Map([[g, 1]]); }
  }
  for (let g = 0; g < nDof; g++) {
    if (fixed[g]) continue;
    const r = rows[g];
    for (const fg of r.keys()) if (fixed[fg]) r.delete(fg);
  }

  // Build CSR.
  const rowPtr = new Int32Array(nDof + 1);
  let nnz = 0;
  for (let g = 0; g < nDof; g++) { rowPtr[g] = nnz; nnz += rows[g].size; }
  rowPtr[nDof] = nnz;
  const colIdx = new Int32Array(nnz);
  const val = new Float64Array(nnz);
  const diag = new Float64Array(nDof);
  {
    let k = 0;
    for (let g = 0; g < nDof; g++) {
      const entries = [...rows[g].entries()].sort((p, q) => p[0] - q[0]);
      for (const [c, v] of entries) {
        colIdx[k] = c; val[k] = v;
        if (c === g) diag[g] = v;
        k++;
      }
      if (diag[g] === 0) diag[g] = 1;
    }
  }
  const F2 = Fsolve;

  // --- LINEAR SOLVE: the open-source WASM core (Eigen LDLT) when available,
  //     else our built-in Jacobi-PCG. Both solve the same symmetric CSR (==CSC)
  //     penalty-conditioned SPD system. ---
  const x = new Float64Array(nDof);
  let iterations = 0;
  let converged = false;
  let backend: SolveBackend = 'PCG';
  let factorMs = 0;
  let solveMs = 0;

  let usedDirect = false;
  if (opts.backend) {
    // Try the direct sparse solver. factorize builds+factors K (symmetric CSR
    // loads directly as Eigen CSC); solve back-substitutes for x.
    report({ stage: 'factorizing', pct: 55, detail: opts.backend.name });
    const tf0 = nowMs();
    const okFac = opts.backend.factorize(nDof, rowPtr, colIdx, val);
    factorMs = nowMs() - tf0;
    if (okFac) {
      report({ stage: 'solving', pct: 75, detail: opts.backend.name });
      const ts0 = nowMs();
      const sol = opts.backend.solve(F2);
      solveMs = nowMs() - ts0;
      if (sol && sol.length === nDof) {
        x.set(sol);
        usedDirect = true;
        converged = true;   // a direct factor+solve is "converged" by definition
        iterations = 0;
        backend = 'Eigen LDLT (wasm)';
      }
      opts.backend.dispose();
    } else {
      // Factorization failed (singular pivot etc.) — release + fall through.
      opts.backend.dispose();
    }
  }

  if (!usedDirect) {
    // Jacobi-PCG, rel tol 1e-7, cap 20k.
    report({ stage: 'solving', pct: 60, detail: 'PCG' });
    const ts0 = nowMs();
    const pcgRes = pcg(rowPtr, colIdx, val, diag, F2, x, 1e-7, 20000,
      (it, relRes) => report({
        stage: 'solving', pct: Math.min(90, 60 + (it / 20000) * 30),
        detail: `PCG iter ${it} · res ${relRes.toExponential(1)}`,
      }));
    solveMs = nowMs() - ts0;
    iterations = pcgRes.iterations;
    converged = pcgRes.converged;
    backend = 'PCG';
  }

  // --- STAGE: stress recovery / verdicts / result packaging — shared with the
  //     sidecar path via finishAssembly (same recovery over the same x). ---
  return finishAssembly(pre, x, panels, { backend, factorMs, solveMs, iterations, converged }, report);
}

/**
 * From a preprocessed model + a 6-DOF-per-node displacement vector `x`, run the
 * per-element stress recovery, compute verdicts, and package the AsmResult.
 * Shared by the internal solve and the sidecar (PyNite) path so both produce an
 * identical result structure — the ONLY thing a backend changes is `x` and the
 * stamped backend/timing fields.
 */
function finishAssembly(
  pre: AsmPreprocess, x: Float64Array, panels: AsmPanel[],
  info: { backend: SolveBackend; factorMs: number; solveMs: number; iterations: number; converged: boolean },
  report: (p: SolveProgress) => void = () => {},
): AsmResult {
  const { meshes, panelD, totalNodes, nDof, resolutionLog, grounded, groundPoints } = pre;
  const { backend, factorMs, solveMs, iterations, converged } = info;

  const empty = (msg: string): AsmResult => ({
    ok: false, message: msg, panels: [], maxDisp: 0, maxPanelId: -1, maxAt: [0, 0],
    spanMm: 0, verdict: 'ok', maxVm: 0, maxVmPanelId: -1, maxVmAt: [0, 0],
    utilPct: 0, stressVerdict: 'ok',
    totalDof: nDof, totalNodes, iterations: 0, converged: false,
    backend, factorMs, solveMs,
    groundedNodes: grounded.length, resolutionLog, groundPoints,
    mesh: null, constraints: null,
    nodeDisp: new Float32Array(0), nodeDispMag: new Float32Array(0), nodeVm: new Float32Array(0),
  });

  // --- STAGE: stress recovery / post-processing — OUR TypeScript. ---
  report({ stage: 'recovering', pct: 92 });

  // Scatter per-panel translational displacement magnitude + recover stresses.
  const panelResults: AsmPanelResult[] = [];
  let maxDisp = 0, maxPanelId = -1;
  let maxAt: Vec2 = [0, 0];
  let maxVm = 0, maxVmPanelId = -1;
  let maxVmAt: Vec2 = [0, 0];
  // Peak bending stresses along/across the grain over ALL panels (for util%).
  let peakAlong = 0, peakAcross = 0;

  // Per-GLOBAL-node fields, in mesh node order — these drive the mesh-view
  // contour + deformed shape. Built alongside the per-panel grids below so the
  // two stay consistent (same displacements, same recovered element stresses).
  const nodeDisp = new Float32Array(totalNodes * 3);
  const nodeDispMag = new Float32Array(totalNodes);
  const gVmSum = new Float64Array(totalNodes);
  const gVmCnt = new Int32Array(totalNodes);

  for (const m of meshes) {
    const p = m.panel;
    const nNodes = m.nx * m.ny;
    const disp = new Float32Array(nNodes).fill(NaN);
    let pMax = 0;
    // Local displacement extraction: local = Rᵀ·world for both the translation
    // triple and the rotation triple. R columns are (uAxis, vAxis, normal).
    const ux = p.uAxis, vy = p.vAxis, nz = p.normal;
    const toLocal3 = (wx: number, wy: number, wz: number): [number, number, number] => [
      ux[0] * wx + ux[1] * wy + ux[2] * wz,
      vy[0] * wx + vy[1] * wy + vy[2] * wz,
      nz[0] * wx + nz[1] * wy + nz[2] * wz,
    ];
    for (let iy = 0; iy < m.ny; iy++) {
      for (let ix = 0; ix < m.nx; ix++) {
        const g = m.gnode[iy * m.nx + ix];
        if (g < 0) continue;
        const dxv = x[g * 6], dyv = x[g * 6 + 1], dzv = x[g * 6 + 2];
        const mag = Math.hypot(dxv, dyv, dzv);
        disp[iy * m.nx + ix] = mag;
        nodeDisp[g * 3] = dxv; nodeDisp[g * 3 + 1] = dyv; nodeDisp[g * 3 + 2] = dzv;
        nodeDispMag[g] = mag;
        if (mag > pMax) pMax = mag;
        if (mag > maxDisp) {
          maxDisp = mag; maxPanelId = p.id; maxAt = [ix * m.dx, iy * m.dy];
        }
      }
    }

    // --- Stress recovery: per element, worst-face von Mises at the centre,
    //     scattered to its 4 nodes and averaged. Also track grain-axis peaks. ---
    const t = p.thicknessMm;
    const D = panelD.get(p.id)!;
    const vmSum = new Float64Array(nNodes);
    const vmCnt = new Int32Array(nNodes);
    const nodeIdx = (jx: number, jy: number) => jy * m.nx + jx;
    for (const [ix, iy] of m.activeCells) {
      const en = [nodeIdx(ix, iy), nodeIdx(ix + 1, iy), nodeIdx(ix + 1, iy + 1), nodeIdx(ix, iy + 1)];
      const g = en.map((n) => m.gnode[n]);
      if (g.some((gg) => gg < 0)) continue;
      // Build local per-node DOF arrays: membrane [u,v]×4, bending [w,θx,θy]×4.
      const ul: number[] = new Array(8);
      const wl: number[] = new Array(12);
      for (let i = 0; i < 4; i++) {
        const gi = g[i];
        const [lu, lv] = toLocal3(x[gi * 6], x[gi * 6 + 1], x[gi * 6 + 2]);
        const lw = nz[0] * x[gi * 6] + nz[1] * x[gi * 6 + 1] + nz[2] * x[gi * 6 + 2];
        const [ru, rv] = toLocal3(x[gi * 6 + 3], x[gi * 6 + 4], x[gi * 6 + 5]);
        ul[i * 2] = lu; ul[i * 2 + 1] = lv;
        wl[i * 3] = lw; wl[i * 3 + 1] = ru; wl[i * 3 + 2] = rv;
      }
      // N = Dm·ε (N/mm) ; M = Db·κ (N·mm/mm).
      const eps = membraneStrainCentre(m.dx, m.dy, ul);
      const kap = bendingCurvatureCentre(m.dx, m.dy, wl);
      const N = m3v(D.Dm, eps);
      const M = m3v(D.Db, kap);
      // Surface stresses on the two faces: σ = N/t ± 6M/t².
      const smx = N[0] / t, smy = N[1] / t, smxy = N[2] / t;   // membrane σ
      const sbx = (6 * M[0]) / (t * t), sby = (6 * M[1]) / (t * t), sbxy = (6 * M[2]) / (t * t); // bending σ (outer face)
      const top: [number, number, number] = [smx + sbx, smy + sby, smxy + sbxy];
      const bot: [number, number, number] = [smx - sbx, smy - sby, smxy - sbxy];
      const vmTop = vonMises(top[0], top[1], top[2]);
      const vmBot = vonMises(bot[0], bot[1], bot[2]);
      const vm = Math.max(vmTop, vmBot);
      // Grain-axis peak bending stresses (magnitude of the pure-bending part).
      const sAlongX = Math.abs(sbx), sAcrossY = Math.abs(sby);
      const along = p.grainAlongLength ? sAlongX : sAcrossY;
      const across = p.grainAlongLength ? sAcrossY : sAlongX;
      if (along > peakAlong) peakAlong = along;
      if (across > peakAcross) peakAcross = across;
      for (const n of en) { vmSum[n] += vm; vmCnt[n] += 1; }
      for (const gg of g) { gVmSum[gg] += vm; gVmCnt[gg] += 1; }
    }

    // Nodal average → a smooth field.
    const vmField = new Float32Array(nNodes).fill(NaN);
    let pVm = 0;
    for (let iy = 0; iy < m.ny; iy++) {
      for (let ix = 0; ix < m.nx; ix++) {
        const n = nodeIdx(ix, iy);
        if (!m.active[n] || vmCnt[n] === 0) continue;
        const v = vmSum[n] / vmCnt[n];
        vmField[n] = v;
        if (v > pVm) pVm = v;
        if (v > maxVm) { maxVm = v; maxVmPanelId = p.id; maxVmAt = [ix * m.dx, iy * m.dy]; }
      }
    }

    panelResults.push({ id: p.id, nx: m.nx, ny: m.ny, dx: m.dx, dy: m.dy, disp, vm: vmField, active: m.active, maxAbs: pMax, maxVm: pVm });
  }

  // Non-physical / NaN backstop.
  const governing = panels.find((p) => p.id === maxPanelId) ?? panels[0];
  const span = Math.max(governing.outline.bbox.w, governing.outline.bbox.h);
  if (!Number.isFinite(maxDisp) || maxDisp > span * 2) {
    return { ...empty('Solve produced a non-physical result — check the joints and grounding.'), iterations };
  }

  report({ stage: 'done', pct: 100 });

  const limit = span / 200;
  const verdict: 'ok' | 'borderline' | 'weak' =
    maxDisp < span / 300 ? 'ok' : maxDisp < limit ? 'borderline' : 'weak';

  // Utilization: worst grain-axis bending stress vs the material bending
  // strength, over all panels. Use the governing (max-vm) panel's material for
  // the strength card — mixed-material jobs are rare and this keeps it simple.
  const govVm = panels.find((p) => p.id === maxVmPanelId) ?? governing;
  const fbA = govVm.material.fbAlong || 1;
  const fbC = govVm.material.fbAcross || 1;
  const utilPct = Math.max(peakAlong / fbA, peakAcross / fbC) * 100;
  const stressVerdict: 'ok' | 'borderline' | 'weak' =
    utilPct < 50 ? 'ok' : utilPct < 100 ? 'borderline' : 'weak';

  // Nodal-average the recovered element von Mises onto the global node table.
  const nodeVm = new Float32Array(totalNodes).fill(NaN);
  for (let g = 0; g < totalNodes; g++) {
    if (gVmCnt[g] > 0) nodeVm[g] = gVmSum[g] / gVmCnt[g];
  }

  return {
    ok: true, panels: panelResults, maxDisp, maxPanelId, maxAt, spanMm: span, verdict,
    maxVm, maxVmPanelId, maxVmAt, utilPct, stressVerdict,
    totalDof: nDof, totalNodes, iterations, converged,
    backend, factorMs, solveMs,
    groundedNodes: grounded.length, resolutionLog, groundPoints,
    mesh: shellMeshView(pre), constraints: constraintView(pre),
    nodeDisp, nodeDispMag, nodeVm,
  };
}

/**
 * Solve the assembly with 8-node hexahedral solid elements.
 *
 * Reuses the shell preprocessing wholesale — the in-plane grid, the joint node
 * pairing, the floor grounding and the load distribution are all defined on the
 * mid-surface nodes — and lifts each of those to the through-thickness stack of
 * solid nodes that mid-surface node owns. A shell node `g` becomes solid nodes
 * `g·levels + l` for l = 0…layers, which is the same numbering solidMeshView
 * draws, so results map straight onto the displayed mesh.
 */
function solveAssemblySolid(
  pre: AsmPreprocess,
  opts: AsmSolveOptions,
  panels: AsmPanel[],
  report: (p: SolveProgress) => void,
  empty: (msg: string) => AsmResult,
): AsmResult {
  const { meshes, nodePos, totalNodes, jointPairs, grounded, F, repStiff } = pre;
  const layers = Math.max(1, Math.round(opts.solidLayers ?? 2));
  const levels = layers + 1;
  const nNodes = totalNodes * levels;
  const nDof = nNodes * 3;

  const view = solidMeshView(pre, layers);
  const resolutionLog =
    `${panels.length} panel${panels.length === 1 ? '' : 's'} · ${view.elemCount} hex · ${nNodes} nodes · ${nDof} DOF · ${layers} layer${layers === 1 ? '' : 's'}`;

  report({ stage: 'assembling', pct: 25, detail: `${nDof.toLocaleString()} DOF · hex` });

  const rows: Map<number, number>[] = Array.from({ length: nDof }, () => new Map());
  const addK = (i: number, j: number, v: number) => {
    if (v === 0) return;
    const r = rows[i];
    r.set(j, (r.get(j) ?? 0) + v);
  };

  // --- Element assembly. Every hex in a panel is the same rectangular box, so
  //     the local 24×24 is formed once and rotated per element. ---
  let repSolid = 0;
  for (const m of meshes) {
    const p = m.panel;
    const c = p.thicknessMm / layers;
    const D = panelSolidD(p);
    const Kl = hexKIncompatible(m.dx, m.dy, c, D);
    repSolid = Math.max(repSolid, D[0][0] * Math.min(m.dx, m.dy, c));

    // Local→global rotation: columns are the panel's world axes.
    const R = [
      [p.uAxis[0], p.vAxis[0], p.normal[0]],
      [p.uAxis[1], p.vAxis[1], p.normal[1]],
      [p.uAxis[2], p.vAxis[2], p.normal[2]],
    ];
    // Pre-rotate every 3×3 nodal block: Kg = R·Kl·Rᵀ.
    const Kg: number[][] = Array.from({ length: 24 }, () => new Array(24).fill(0));
    for (let ni = 0; ni < 8; ni++) {
      for (let nj = 0; nj < 8; nj++) {
        const blk = [
          [Kl[ni * 3][nj * 3], Kl[ni * 3][nj * 3 + 1], Kl[ni * 3][nj * 3 + 2]],
          [Kl[ni * 3 + 1][nj * 3], Kl[ni * 3 + 1][nj * 3 + 1], Kl[ni * 3 + 1][nj * 3 + 2]],
          [Kl[ni * 3 + 2][nj * 3], Kl[ni * 3 + 2][nj * 3 + 1], Kl[ni * 3 + 2][nj * 3 + 2]],
        ];
        const rot = mat3mul(mat3mul(R, blk), transpose3(R));
        for (let r = 0; r < 3; r++) for (let cc = 0; cc < 3; cc++) Kg[ni * 3 + r][nj * 3 + cc] = rot[r][cc];
      }
    }

    const nodeIdx = (ix: number, iy: number) => iy * m.nx + ix;
    for (const [ix, iy] of m.activeCells) {
      const q = [
        m.gnode[nodeIdx(ix, iy)], m.gnode[nodeIdx(ix + 1, iy)],
        m.gnode[nodeIdx(ix + 1, iy + 1)], m.gnode[nodeIdx(ix, iy + 1)],
      ];
      if (q.some((g) => g < 0)) continue;
      for (let l = 0; l < layers; l++) {
        const en = [
          q[0] * levels + l, q[1] * levels + l, q[2] * levels + l, q[3] * levels + l,
          q[0] * levels + l + 1, q[1] * levels + l + 1, q[2] * levels + l + 1, q[3] * levels + l + 1,
        ];
        for (let ni = 0; ni < 8; ni++) {
          for (let nj = 0; nj < 8; nj++) {
            const gi = en[ni] * 3, gj = en[nj] * 3;
            for (let r = 0; r < 3; r++)
              for (let cc = 0; cc < 3; cc++)
                addK(gi + r, gj + cc, Kg[ni * 3 + r][nj * 3 + cc]);
          }
        }
      }
    }
  }
  if (repSolid <= 0 || !Number.isFinite(repSolid)) repSolid = repStiff;

  // --- Joint coupling. A shell node pair becomes one translational penalty
  //     spring per through-thickness level, so the joined stacks move together
  //     — rotational continuity across the seam emerges from the stack rather
  //     than needing rotational DOF the solid doesn't have. A hinged joint
  //     couples only the mid level, leaving the seam free to rotate. ---
  const addSpring = (a: number, b: number, dof: number, k: number) => {
    const i = a * 3 + dof, j = b * 3 + dof;
    addK(i, i, k); addK(j, j, k);
    addK(i, j, -k); addK(j, i, -k);
  };
  const midLevel = Math.floor(layers / 2);
  for (const jp of jointPairs) {
    const k = jp.kTrans;
    const lvls = jp.stiffness === 'hinged'
      ? [midLevel]
      : Array.from({ length: levels }, (_, l) => l);
    const scale = jp.stiffness === 'semi-rigid' ? 0.05 : 1;
    for (const l of lvls) {
      const a = jp.gi * levels + l, b = jp.gj * levels + l;
      for (let d = 0; d < 3; d++) addSpring(a, b, d, k * scale);
    }
  }

  // --- Grounding: a grounded mid-surface node fixes its whole stack. ---
  const fixed = new Uint8Array(nDof);
  for (const g of grounded) {
    for (let l = 0; l < levels; l++) {
      const s = (g * levels + l) * 3;
      fixed[s] = 1; fixed[s + 1] = 1; fixed[s + 2] = 1;
    }
  }

  // --- Loads: the mid-surface nodal force is shared across the stack. Which
  //     face a patch presses on is below the resolution of an 18 mm panel with
  //     2-3 elements through it, and spreading avoids a spurious contact spike
  //     at a single surface node. ---
  const Fs = new Float64Array(nDof);
  for (let g = 0; g < totalNodes; g++) {
    const fx = F[g * 6], fy = F[g * 6 + 1], fz = F[g * 6 + 2];
    if (fx === 0 && fy === 0 && fz === 0) continue;
    for (let l = 0; l < levels; l++) {
      const s = (g * levels + l) * 3;
      Fs[s] += fx / levels; Fs[s + 1] += fy / levels; Fs[s + 2] += fz / levels;
    }
  }

  // Soft regularization on free DOF, then homogeneous Dirichlet BCs.
  const kSoft = repSolid * 1e-6;
  for (let i = 0; i < nDof; i++) {
    if (fixed[i]) continue;
    rows[i].set(i, (rows[i].get(i) ?? 0) + kSoft);
  }
  for (let i = 0; i < nDof; i++) {
    if (fixed[i]) { Fs[i] = 0; rows[i] = new Map([[i, 1]]); }
  }
  for (let i = 0; i < nDof; i++) {
    if (fixed[i]) continue;
    const r = rows[i];
    for (const cj of r.keys()) if (fixed[cj]) r.delete(cj);
  }

  // CSR.
  const rowPtr = new Int32Array(nDof + 1);
  let nnz = 0;
  for (let i = 0; i < nDof; i++) { rowPtr[i] = nnz; nnz += rows[i].size; }
  rowPtr[nDof] = nnz;
  const colIdx = new Int32Array(nnz);
  const val = new Float64Array(nnz);
  const diag = new Float64Array(nDof);
  {
    let k = 0;
    for (let i = 0; i < nDof; i++) {
      const entries = [...rows[i].entries()].sort((p, q) => p[0] - q[0]);
      for (const [cc, v] of entries) {
        colIdx[k] = cc; val[k] = v;
        if (cc === i) diag[i] = v;
        k++;
      }
      if (diag[i] === 0) diag[i] = 1;
      rows[i] = new Map();   // release as we go — solid rows are memory-heavy
    }
  }

  // --- Linear solve: same two backends as the shell path. ---
  const x = new Float64Array(nDof);
  let iterations = 0, converged = false, factorMs = 0, solveMs = 0;
  let backend: SolveBackend = 'PCG';
  let usedDirect = false;
  if (opts.backend) {
    report({ stage: 'factorizing', pct: 55, detail: opts.backend.name });
    const t0 = nowMs();
    const okFac = opts.backend.factorize(nDof, rowPtr, colIdx, val);
    factorMs = nowMs() - t0;
    if (okFac) {
      report({ stage: 'solving', pct: 75, detail: opts.backend.name });
      const t1 = nowMs();
      const sol = opts.backend.solve(Fs);
      solveMs = nowMs() - t1;
      if (sol && sol.length === nDof) {
        x.set(sol); usedDirect = true; converged = true;
        backend = 'Eigen LDLT (wasm)';
      }
    }
    opts.backend.dispose();
  }
  if (!usedDirect) {
    report({ stage: 'solving', pct: 60, detail: 'PCG' });
    const t0 = nowMs();
    const r = pcg(rowPtr, colIdx, val, diag, Fs, x, 1e-7, 20000,
      (it, rel) => report({
        stage: 'solving', pct: Math.min(90, 60 + (it / 20000) * 30),
        detail: `PCG iter ${it} · res ${rel.toExponential(1)}`,
      }));
    solveMs = nowMs() - t0;
    iterations = r.iterations; converged = r.converged;
  }

  return finishSolid(pre, view, x, panels, layers, {
    backend, factorMs, solveMs, iterations, converged, resolutionLog,
  }, report, empty);
}

/**
 * Stress recovery + result packaging for the solid path.
 *
 * Per hex, evaluate the strain at the element centre from the SAME B-matrix the
 * stiffness used, take σ = D·ε in the panel's local (and therefore material)
 * axes, and reduce to a von Mises value scattered to the element's 8 nodes.
 * Because the material axes ARE the local axes, σ11 and σ22 are directly the
 * along- and across-grain fibre stresses the utilization check wants — no
 * membrane/bending split is needed, the solid carries the real gradient.
 */
function finishSolid(
  pre: AsmPreprocess,
  view: CaeMeshView,
  x: Float64Array,
  panels: AsmPanel[],
  layers: number,
  info: {
    backend: SolveBackend; factorMs: number; solveMs: number;
    iterations: number; converged: boolean; resolutionLog: string;
  },
  report: (p: SolveProgress) => void,
  empty: (msg: string) => AsmResult,
): AsmResult {
  const { meshes, totalNodes, grounded, groundPoints } = pre;
  const levels = layers + 1;
  const nNodes = totalNodes * levels;

  report({ stage: 'recovering', pct: 92 });

  const nodeDisp = new Float32Array(nNodes * 3);
  const nodeDispMag = new Float32Array(nNodes);
  for (let i = 0; i < nNodes; i++) {
    const dx = x[i * 3], dy = x[i * 3 + 1], dz = x[i * 3 + 2];
    nodeDisp[i * 3] = dx; nodeDisp[i * 3 + 1] = dy; nodeDisp[i * 3 + 2] = dz;
    nodeDispMag[i] = Math.hypot(dx, dy, dz);
  }

  const vmSum = new Float64Array(nNodes);
  const vmCnt = new Int32Array(nNodes);
  let peakAlong = 0, peakAcross = 0;
  let maxDisp = 0, maxPanelId = -1;
  let maxAt: Vec2 = [0, 0];
  let maxVm = 0, maxVmPanelId = -1;
  let maxVmAt: Vec2 = [0, 0];

  const panelResults: AsmPanelResult[] = [];

  for (const m of meshes) {
    const p = m.panel;
    const c = p.thicknessMm / layers;
    const D = panelSolidD(p);
    // Centre-point B (ξ=η=ζ=0) for a rectangular box.
    const jx = 2 / m.dx, jy = 2 / m.dy, jz = 2 / c;
    const Bc: number[][] = Array.from({ length: 6 }, () => new Array(24).fill(0));
    for (let i = 0; i < 8; i++) {
      const [xi, eta, zeta] = HEX_NAT[i];
      const dNdx = 0.125 * xi * jx, dNdy = 0.125 * eta * jy, dNdz = 0.125 * zeta * jz;
      const cu = i * 3, cv = cu + 1, cw = cu + 2;
      Bc[0][cu] = dNdx; Bc[1][cv] = dNdy; Bc[2][cw] = dNdz;
      Bc[3][cv] = dNdz; Bc[3][cw] = dNdy;
      Bc[4][cu] = dNdz; Bc[4][cw] = dNdx;
      Bc[5][cu] = dNdy; Bc[5][cv] = dNdx;
    }
    // World→local rotation (rows are the panel axes).
    const toLocal = (gx: number, gy: number, gz: number): [number, number, number] => [
      p.uAxis[0] * gx + p.uAxis[1] * gy + p.uAxis[2] * gz,
      p.vAxis[0] * gx + p.vAxis[1] * gy + p.vAxis[2] * gz,
      p.normal[0] * gx + p.normal[1] * gy + p.normal[2] * gz,
    ];

    const gridNodes = m.nx * m.ny;
    const disp = new Float32Array(gridNodes).fill(NaN);
    const vmGrid = new Float32Array(gridNodes).fill(NaN);
    let pMax = 0, pVm = 0;

    const nodeIdx = (ix: number, iy: number) => iy * m.nx + ix;
    for (const [ix, iy] of m.activeCells) {
      const q = [
        m.gnode[nodeIdx(ix, iy)], m.gnode[nodeIdx(ix + 1, iy)],
        m.gnode[nodeIdx(ix + 1, iy + 1)], m.gnode[nodeIdx(ix, iy + 1)],
      ];
      if (q.some((g) => g < 0)) continue;
      for (let l = 0; l < layers; l++) {
        const en = [
          q[0] * levels + l, q[1] * levels + l, q[2] * levels + l, q[3] * levels + l,
          q[0] * levels + l + 1, q[1] * levels + l + 1, q[2] * levels + l + 1, q[3] * levels + l + 1,
        ];
        // Local displacement vector for the element.
        const ue = new Array(24).fill(0);
        for (let i = 0; i < 8; i++) {
          const n = en[i];
          const [lu, lv, lw] = toLocal(x[n * 3], x[n * 3 + 1], x[n * 3 + 2]);
          ue[i * 3] = lu; ue[i * 3 + 1] = lv; ue[i * 3 + 2] = lw;
        }
        const eps = new Array(6).fill(0);
        for (let r = 0; r < 6; r++) {
          let s = 0;
          for (let k = 0; k < 24; k++) s += Bc[r][k] * ue[k];
          eps[r] = s;
        }
        const sig = new Array(6).fill(0);
        for (let r = 0; r < 6; r++) {
          let s = 0;
          for (let k = 0; k < 6; k++) s += D[r][k] * eps[k];
          sig[r] = s;
        }
        const vm = Math.sqrt(Math.max(0,
          0.5 * ((sig[0] - sig[1]) ** 2 + (sig[1] - sig[2]) ** 2 + (sig[2] - sig[0]) ** 2)
          + 3 * (sig[3] ** 2 + sig[4] ** 2 + sig[5] ** 2)));
        // Local axis 1 is the grain axis when grainAlongLength, else axis 2.
        const along = Math.abs(p.grainAlongLength ? sig[0] : sig[1]);
        const across = Math.abs(p.grainAlongLength ? sig[1] : sig[0]);
        if (along > peakAlong) peakAlong = along;
        if (across > peakAcross) peakAcross = across;
        for (const n of en) { vmSum[n] += vm; vmCnt[n] += 1; }
      }
    }

    // Collapse the through-thickness stack back onto the in-plane grid so the
    // per-panel texture overlay + PDF pages keep working unchanged: each
    // mid-surface node takes the worst value over its stack.
    for (let iy = 0; iy < m.ny; iy++) {
      for (let ix = 0; ix < m.nx; ix++) {
        const gi = nodeIdx(ix, iy);
        const g = m.gnode[gi];
        if (g < 0) continue;
        let dMax = 0, vMax = 0, sawVm = false;
        for (let l = 0; l < levels; l++) {
          const n = g * levels + l;
          if (nodeDispMag[n] > dMax) dMax = nodeDispMag[n];
          if (vmCnt[n] > 0) {
            const v = vmSum[n] / vmCnt[n];
            if (v > vMax) vMax = v;
            sawVm = true;
          }
        }
        disp[gi] = dMax;
        if (sawVm) vmGrid[gi] = vMax;
        if (dMax > pMax) pMax = dMax;
        if (vMax > pVm) pVm = vMax;
        if (dMax > maxDisp) { maxDisp = dMax; maxPanelId = p.id; maxAt = [ix * m.dx, iy * m.dy]; }
        if (sawVm && vMax > maxVm) { maxVm = vMax; maxVmPanelId = p.id; maxVmAt = [ix * m.dx, iy * m.dy]; }
      }
    }

    panelResults.push({
      id: p.id, nx: m.nx, ny: m.ny, dx: m.dx, dy: m.dy,
      disp, vm: vmGrid, active: m.active, maxAbs: pMax, maxVm: pVm,
    });
  }

  const nodeVm = new Float32Array(nNodes).fill(NaN);
  for (let n = 0; n < nNodes; n++) if (vmCnt[n] > 0) nodeVm[n] = vmSum[n] / vmCnt[n];

  const governing = panels.find((p) => p.id === maxPanelId) ?? panels[0];
  const span = Math.max(governing.outline.bbox.w, governing.outline.bbox.h);
  if (!Number.isFinite(maxDisp) || maxDisp > span * 2) {
    return { ...empty('Solid solve produced a non-physical result — check the joints and grounding.'), resolutionLog: info.resolutionLog };
  }

  report({ stage: 'done', pct: 100 });

  const verdict: 'ok' | 'borderline' | 'weak' =
    maxDisp < span / 300 ? 'ok' : maxDisp < span / 200 ? 'borderline' : 'weak';
  const govVm = panels.find((p) => p.id === maxVmPanelId) ?? governing;
  const utilPct = Math.max(peakAlong / (govVm.material.fbAlong || 1), peakAcross / (govVm.material.fbAcross || 1)) * 100;
  const stressVerdict: 'ok' | 'borderline' | 'weak' =
    utilPct < 50 ? 'ok' : utilPct < 100 ? 'borderline' : 'weak';

  return {
    ok: true, panels: panelResults, maxDisp, maxPanelId, maxAt, spanMm: span, verdict,
    maxVm, maxVmPanelId, maxVmAt, utilPct, stressVerdict,
    totalDof: nNodes * 3, totalNodes: nNodes,
    iterations: info.iterations, converged: info.converged,
    backend: info.backend, factorMs: info.factorMs, solveMs: info.solveMs,
    groundedNodes: grounded.length, resolutionLog: info.resolutionLog, groundPoints,
    mesh: view, constraints: constraintView(pre),
    nodeDisp, nodeDispMag, nodeVm,
  };
}

/** Transpose of a 3×3. */
function transpose3(M: number[][]): number[][] {
  return [
    [M[0][0], M[1][0], M[2][0]],
    [M[0][1], M[1][1], M[2][1]],
    [M[0][2], M[1][2], M[2][2]],
  ];
}

// ===========================================================================
// SOLID (HEXAHEDRAL) ELEMENT PATH
//
// The shell path models each panel as a surface with a bending stiffness. The
// solid path models the actual VOLUME: every in-plane cell is extruded through
// the panel thickness into `layers` 8-node hexahedra with 3 translational DOF
// per node, so through-thickness effects the plate theory cannot express —
// rolling shear, local crushing under a load patch, the real stress gradient
// across the plies — come out of the solve instead of being assumed away.
//
// TWO things make this work on plywood panels:
//
//  1. INCOMPATIBLE MODES. A plain trilinear hex in bending suffers shear
//     locking: its edges must stay straight, so pure bending generates
//     spurious shear energy and the element comes out wildly over-stiff —
//     unusable at the 2-3 elements through an 18 mm panel we can afford.
//     Adding Wilson's three quadratic bubble modes per direction (9 internal
//     DOF, statically condensed out per element) restores the linear strain
//     field bending needs. On a rectangular box the Jacobian is constant, so
//     ∫Ba dV = 0 holds exactly and the element passes the patch test.
//
//  2. FULL ORTHOTROPY. Wood is far weaker through the panel than in it, and
//     its rolling-shear modulus is a fraction of the in-plane one. A 3D
//     isotropic solid would hide exactly the failure modes a solid model is
//     worth running for.
//
// Every hex in a panel is the same rectangular box (dx × dy × t/layers), so
// the 24×24 element stiffness is formed ONCE per panel and reused.
// ===========================================================================

/**
 * Orthotropic 3D constitutive matrix (6×6) in material axes, ordered
 * σ = [σ11, σ22, σ33, σ23, σ13, σ12].
 *
 * Built by inverting the compliance matrix, which is the form the elastic
 * constants are actually measured in and keeps the Maxwell symmetry
 * νij/Ei = νji/Ej exact.
 */
function orthotropic3D(
  e1: number, e2: number, e3: number,
  g12: number, g13: number, g23: number,
  nu12: number, nu13: number, nu23: number,
): number[][] {
  // Minor Poisson ratios follow from symmetry.
  const nu21 = nu12 * e2 / e1;
  const nu31 = nu13 * e3 / e1;
  const nu32 = nu23 * e3 / e2;

  // Normal-strain compliance block, then invert it (3×3, closed form).
  const S = [
    [1 / e1, -nu21 / e2, -nu31 / e3],
    [-nu12 / e1, 1 / e2, -nu32 / e3],
    [-nu13 / e1, -nu23 / e2, 1 / e3],
  ];
  const det =
    S[0][0] * (S[1][1] * S[2][2] - S[1][2] * S[2][1])
    - S[0][1] * (S[1][0] * S[2][2] - S[1][2] * S[2][0])
    + S[0][2] * (S[1][0] * S[2][1] - S[1][1] * S[2][0]);
  const inv = (r: number, c: number) => {
    const m = [0, 1, 2].filter((i) => i !== c).map((i) => [0, 1, 2].filter((j) => j !== r).map((j) => S[i][j]));
    const cof = m[0][0] * m[1][1] - m[0][1] * m[1][0];
    return ((r + c) % 2 === 0 ? cof : -cof) / det;
  };

  const D: number[][] = Array.from({ length: 6 }, () => new Array(6).fill(0));
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) D[r][c] = inv(r, c);
  D[3][3] = g23;
  D[4][4] = g13;
  D[5][5] = g12;
  return D;
}

/**
 * Through-thickness and rolling-shear properties, derived from the card's
 * in-plane numbers. Plywood is dramatically softer perpendicular to the panel
 * than within it, and its rolling-shear modulus (shear in a plane containing
 * the panel normal, which rolls the cross-plies) is a fraction of the in-plane
 * value — the ratios below are the standard engineering estimates for
 * cross-laminated veneer, and they are what makes a solid model of a panel
 * behave like plywood instead of like a plastic slab.
 */
const E_THROUGH_RATIO = 0.15;   // E3 / E_across
const ROLLING_SHEAR_RATIO = 0.2; // G13, G23 / G12
const NU_THROUGH = 0.35;

/** The 6×6 D-matrix for a panel, in its LOCAL (uAxis, vAxis, normal) axes. */
function panelSolidD(p: AsmPanel): number[][] {
  const m = p.material;
  if (m.isotropic) {
    const e = m.eAlong, nu = NU;
    const g = e / (2 * (1 + nu));
    return orthotropic3D(e, e, e, g, g, g, nu, nu, nu);
  }
  // Local X is the outline length axis; the grain runs along it unless the
  // body's grain is set across.
  const e1 = p.grainAlongLength ? m.eAlong : m.eAcross;
  const e2 = p.grainAlongLength ? m.eAcross : m.eAlong;
  const e3 = Math.max(50, Math.min(e1, e2) * E_THROUGH_RATIO);
  const g12 = m.gShear;
  const gRoll = g12 * ROLLING_SHEAR_RATIO;
  return orthotropic3D(e1, e2, e3, g12, gRoll, gRoll, NU, NU_THROUGH, NU_THROUGH);
}

/** Exposed for tests/cae_check.ts — the hex element is validated directly
 *  against beam theory, since an element that shear-locks still reports
 *  roughly correct stresses (equilibrium fixes those) and only gives itself
 *  away in the displacements. */
export const hexKForTest = hexKIncompatible;
export const orthotropic3DForTest = orthotropic3D;

/** Natural coordinates of the 8 hex nodes, in the order solidMeshView emits. */
const HEX_NAT: [number, number, number][] = [
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
];
const GAUSS2 = [-1 / Math.sqrt(3), 1 / Math.sqrt(3)];

/**
 * 24×24 stiffness of a rectangular hexahedron a×b×c with the 9 Wilson
 * incompatible modes statically condensed out.
 *
 * K = Kuu − Kua · Kaa⁻¹ · Kuaᵀ
 */
function hexKIncompatible(a: number, b: number, c: number, D: number[][]): number[][] {
  const Kuu: number[][] = Array.from({ length: 24 }, () => new Array(24).fill(0));
  const Kua: number[][] = Array.from({ length: 24 }, () => new Array(9).fill(0));
  const Kaa: number[][] = Array.from({ length: 9 }, () => new Array(9).fill(0));
  const detJ = (a * b * c) / 8;
  // Constant Jacobian: ∂/∂x = (2/a)·∂/∂ξ and so on.
  const jx = 2 / a, jy = 2 / b, jz = 2 / c;

  for (const gx of GAUSS2) {
    for (const gy of GAUSS2) {
      for (const gz of GAUSS2) {
        // --- compatible (nodal) B, 6×24 ---
        const Bu: number[][] = Array.from({ length: 6 }, () => new Array(24).fill(0));
        for (let i = 0; i < 8; i++) {
          const [xi, eta, zeta] = HEX_NAT[i];
          const dNdx = 0.125 * xi * (1 + eta * gy) * (1 + zeta * gz) * jx;
          const dNdy = 0.125 * eta * (1 + xi * gx) * (1 + zeta * gz) * jy;
          const dNdz = 0.125 * zeta * (1 + xi * gx) * (1 + eta * gy) * jz;
          const cu = i * 3, cv = cu + 1, cw = cu + 2;
          Bu[0][cu] = dNdx;
          Bu[1][cv] = dNdy;
          Bu[2][cw] = dNdz;
          Bu[3][cv] = dNdz; Bu[3][cw] = dNdy;   // γyz
          Bu[4][cu] = dNdz; Bu[4][cw] = dNdx;   // γxz
          Bu[5][cu] = dNdy; Bu[5][cv] = dNdx;   // γxy
        }

        // --- incompatible B, 6×9. Modes M1 = 1−ξ², M2 = 1−η², M3 = 1−ζ²,
        //     each applied to all three displacement components. Only one
        //     derivative of each mode is non-zero. ---
        const dM = [-2 * gx * jx, -2 * gy * jy, -2 * gz * jz]; // dM_k / d(x_k)
        const Ba: number[][] = Array.from({ length: 6 }, () => new Array(9).fill(0));
        for (let k = 0; k < 3; k++) {
          const g = [0, 0, 0];
          g[k] = dM[k];                      // ∇M_k
          for (let d = 0; d < 3; d++) {
            const col = k * 3 + d;
            if (d === 0) { Ba[0][col] = g[0]; Ba[4][col] = g[2]; Ba[5][col] = g[1]; }
            if (d === 1) { Ba[1][col] = g[1]; Ba[3][col] = g[2]; Ba[5][col] = g[0]; }
            if (d === 2) { Ba[2][col] = g[2]; Ba[3][col] = g[1]; Ba[4][col] = g[0]; }
          }
        }

        // D·Bu and D·Ba once, then the three products.
        const DBu = matMul6(D, Bu, 24);
        const DBa = matMul6(D, Ba, 9);
        accumulate(Kuu, Bu, DBu, 24, 24, detJ);
        accumulate(Kua, Bu, DBa, 24, 9, detJ);
        accumulate(Kaa, Ba, DBa, 9, 9, detJ);
      }
    }
  }

  // Static condensation of the internal modes.
  const KaaInv = invertSquare(Kaa);
  if (!KaaInv) return Kuu;   // degenerate: fall back to the locking element
  const KuaInv: number[][] = Array.from({ length: 24 }, () => new Array(9).fill(0));
  for (let r = 0; r < 24; r++)
    for (let c = 0; c < 9; c++) {
      let s = 0;
      for (let k = 0; k < 9; k++) s += Kua[r][k] * KaaInv[k][c];
      KuaInv[r][c] = s;
    }
  for (let r = 0; r < 24; r++)
    for (let c = 0; c < 24; c++) {
      let s = 0;
      for (let k = 0; k < 9; k++) s += KuaInv[r][k] * Kua[c][k];
      Kuu[r][c] -= s;
    }
  return Kuu;
}

/** D (6×6) · B (6×n) → 6×n. */
function matMul6(D: number[][], B: number[][], n: number): number[][] {
  const out: number[][] = Array.from({ length: 6 }, () => new Array(n).fill(0));
  for (let r = 0; r < 6; r++)
    for (let c = 0; c < n; c++) {
      let s = 0;
      for (let k = 0; k < 6; k++) s += D[r][k] * B[k][c];
      out[r][c] = s;
    }
  return out;
}

/** K += Aᵀ·B · w, with A (6×rows) and B (6×cols). */
function accumulate(K: number[][], A: number[][], B: number[][], rows: number, cols: number, w: number) {
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      let s = 0;
      for (let k = 0; k < 6; k++) s += A[k][r] * B[k][c];
      K[r][c] += s * w;
    }
}

/** Gauss-Jordan inverse of a small dense matrix; null if singular. */
function invertSquare(M: number[][]): number[][] | null {
  const n = M.length;
  const a = M.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    if (Math.abs(a[piv][col]) < 1e-14) return null;
    if (piv !== col) { const t = a[piv]; a[piv] = a[col]; a[col] = t; }
    const d = a[col][col];
    for (let c = 0; c < 2 * n; c++) a[col][c] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col];
      if (f === 0) continue;
      for (let c = 0; c < 2 * n; c++) a[r][c] -= f * a[col][c];
    }
  }
  return a.map((row) => row.slice(n));
}

/** Rotate a 6×6 local block (translation triple + rotation triple) to global
 *  and scatter into the assembly rows. Basis columns are the world axes. */
function rotateAndScatter(
  rows: Map<number, number>[], blk: number[][], gi: number, gj: number,
  ux: Vec3World, vy: Vec3World, nz: Vec3World,
) {
  // T is the 3×3 whose ROWS are (ux, vy, nz): it maps a world vector to local.
  // The global block is Tᵀ·blk_local·T applied per 3×3 sub-block. We build the
  // rotation R = [ux vy nz] as columns (local→world) and compute R·blk·Rᵀ.
  const R = [
    [ux[0], vy[0], nz[0]],
    [ux[1], vy[1], nz[1]],
    [ux[2], vy[2], nz[2]],
  ];
  // For each of the 2×2 arrangement of 3×3 sub-blocks (trans/rot):
  for (let bi = 0; bi < 2; bi++) {
    for (let bj = 0; bj < 2; bj++) {
      // local 3×3
      const L = [
        [blk[bi * 3][bj * 3], blk[bi * 3][bj * 3 + 1], blk[bi * 3][bj * 3 + 2]],
        [blk[bi * 3 + 1][bj * 3], blk[bi * 3 + 1][bj * 3 + 1], blk[bi * 3 + 1][bj * 3 + 2]],
        [blk[bi * 3 + 2][bj * 3], blk[bi * 3 + 2][bj * 3 + 1], blk[bi * 3 + 2][bj * 3 + 2]],
      ];
      // G = R · L · Rᵀ
      const RL = mat3mul(R, L);
      const G = mat3mulT(RL, R);
      const rowBase = gi * 6 + bi * 3;
      const colBase = gj * 6 + bj * 3;
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          const v = G[r][c];
          if (v !== 0) {
            const gr = rowBase + r, gc = colBase + c;
            const m = rows[gr];
            m.set(gc, (m.get(gc) ?? 0) + v);
          }
        }
      }
    }
  }
}

function mat3mul(A: number[][], B: number[][]): number[][] {
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      C[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
  return C;
}
/** A · Bᵀ */
function mat3mulT(A: number[][], B: number[][]): number[][] {
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      C[i][j] = A[i][0] * B[j][0] + A[i][1] * B[j][1] + A[i][2] * B[j][2];
  return C;
}
