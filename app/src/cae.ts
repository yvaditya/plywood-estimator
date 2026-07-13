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
}

export const MATERIALS: MaterialCard[] = [
  { id: 'baltic-birch', name: 'Baltic birch ply', eAlong: 9500, eAcross: 4500, gShear: 9500 / 16, density: 680 },
  { id: 'softwood-ply', name: 'Softwood ply',     eAlong: 8000, eAcross: 3500, gShear: 8000 / 16, density: 550 },
  { id: 'hardwood-ply', name: 'Hardwood ply',     eAlong: 9000, eAcross: 4200, gShear: 9000 / 16, density: 640 },
  { id: 'mdf',          name: 'MDF',              eAlong: 3200, eAcross: 3200, gShear: 3200 / (2 * (1 + 0.25)), density: 750, isotropic: true },
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

/** Jacobi-preconditioned CG. Returns iteration count + convergence flag. */
function pcg(
  rowPtr: Int32Array, colIdx: Int32Array, val: Float64Array, diag: Float64Array,
  b: Float64Array, x: Float64Array, tol: number, maxIter: number,
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
