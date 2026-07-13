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

// ===========================================================================
// ASSEMBLY solver — a coupled flat-shell FE model of a whole cabinet.
//
// Every selected panel becomes a flat-shell mesh (Mindlin bending — the same
// elementK the per-panel solver uses — PLUS a plane-stress membrane, both with
// selective reduced integration), assembled into ONE global system with 6 DOF
// per node in world 3D (ux uy uz θx θy θz). Panels are stitched where their
// edges touch (joint detection) with penalty springs whose stiffness depends
// on the joint class (rigid / semi-rigid / hinged). Nodes near the floor are
// grounded. Solved with Jacobi-PCG.
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

export interface AsmSolveOptions {
  panels: AsmPanel[];
  joints: AsmJoint[];
  loads: AsmLoad[];
  /** Join tolerance (mm) — also the floor-contact threshold. */
  tolMm: number;
  /** Target active nodes per panel (mesh auto-coarsens to hold the DOF cap). */
  targetNodesPerPanel?: number;
  /** Hard cap on total assembly DOF. */
  maxDof?: number;
}

/** Per-panel deflection field, in that panel's local grid (like SolveResult). */
export interface AsmPanelResult {
  id: number;
  nx: number; ny: number; dx: number; dy: number;
  /** Per-node transverse deflection magnitude |u·? | — the total translational
   *  displacement magnitude (mm). NaN for inactive nodes. */
  disp: Float32Array;
  active: Uint8Array;
  maxAbs: number;
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
  totalDof: number;
  totalNodes: number;
  iterations: number;
  converged: boolean;
  /** Floor-grounded node count (for the glyph overlay + reporting). */
  groundedNodes: number;
  /** Resolution log line, e.g. "6 panels · 3480 nodes · 20880 DOF". */
  resolutionLog: string;
  /** Grounded node world positions (for glyphs). */
  groundPoints: Vec3World[];
}

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

/** True if world point `pt` lies within `tol` of panel `p` (plane + footprint). */
function pointOnPanel(pt: Vec3World, p: AsmPanel, tol: number): boolean {
  const rel = w3sub(pt, p.origin);
  const d = Math.abs(w3dot(rel, p.normal));
  if (d > tol + p.thicknessMm / 2 + 0.01) return false;
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
        if (pointOnPanel(pt, dst, tol)) {
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

/** Rasterise one panel into a grid sized to ~target active nodes. */
function meshPanel(p: AsmPanel, target: number): {
  nx: number; ny: number; dx: number; dy: number;
  active: Uint8Array; activeCells: [number, number][]; activeCount: number;
} {
  const bboxW = p.outline.bbox.w;
  const bboxH = p.outline.bbox.h;
  const areaFrac = Math.max(0.15, outlineArea(p.outline) / (bboxW * bboxH || 1));
  const aspect = bboxW / (bboxH || 1);
  let ny = Math.round(Math.sqrt((target / areaFrac) / aspect)) + 1;
  let nx = Math.round(ny * aspect) + 1;
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

/**
 * Solve the whole assembly. Returns a refusal (ok:false) when the system is
 * under-constrained (nothing grounded / not enough grounding to prevent rigid
 * body motion) — reusing the guard+backstop pattern from the per-panel path.
 */
export function solveAssembly(opts: AsmSolveOptions): AsmResult {
  const { panels, joints, loads, tolMm } = opts;
  const maxDof = opts.maxDof ?? 60000;
  let target = opts.targetNodesPerPanel ?? 600;

  const empty = (msg: string): AsmResult => ({
    ok: false, message: msg, panels: [], maxDisp: 0, maxPanelId: -1, maxAt: [0, 0],
    spanMm: 0, verdict: 'ok', totalDof: 0, totalNodes: 0, iterations: 0, converged: false,
    groundedNodes: 0, resolutionLog: '', groundPoints: [],
  });

  if (panels.length === 0) return empty('No panels selected.');

  // Auto-coarsen so total DOF ≈ 6 · Σ activeNodes ≤ maxDof.
  let meshes: PanelMesh[] = [];
  let totalNodes = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    meshes = [];
    totalNodes = 0;
    const nodeTable: Vec3World[] = [];
    for (const p of panels) {
      const m = meshPanel(p, target);
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
    if (totalNodes * 6 <= maxDof) break;
    // Shrink target proportionally (a little aggressive to converge fast).
    target = Math.max(120, Math.floor(target * (maxDof / (totalNodes * 6)) * 0.9));
  }

  const nDof = totalNodes * 6;
  const resolutionLog =
    `${panels.length} panel${panels.length === 1 ? '' : 's'} · ${totalNodes} nodes · ${nDof} DOF · target ${target}/panel`;

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

  // Assemble the global stiffness in a row-map (6 DOF/node).
  const rows: Map<number, number>[] = Array.from({ length: nDof }, () => new Map());
  const addK = (gi: number, gj: number, v: number) => {
    if (v === 0) return;
    const r = rows[gi];
    r.set(gj, (r.get(gj) ?? 0) + v);
  };

  // Track a representative plate stiffness PER PANEL for joint-penalty scaling.
  // Using a per-panel value (not the global max) keeps a joint between two soft
  // panels from being penalised at a stiff panel's scale — a mismatch that
  // wrecks the condition number and stalls PCG on real, mixed-thickness jobs.
  const panelStiff = new Map<number, number>();
  let repStiff = 0;

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

    // Representative stiffness of THIS panel: the membrane diagonal per cell is
    // the dominant in-plane term the translational joint springs act against.
    const pStiff = Dm[0][0] / (m.dx * m.dy);
    panelStiff.set(p.id, pStiff);
    repStiff = Math.max(repStiff, pStiff);

    // World basis columns: uAxis, vAxis, normal. Local dof mapping:
    //   local [ub, vb, wb, θub, θvb, θwb]  (u,v in-plane; w out-of-plane;
    //   θu,θv bending rotations about local u,v; θw drilling).
    const ux = p.uAxis, vy = p.vAxis, nz = p.normal;
    // Drilling stabilization coefficient (small, ∝ membrane stiffness · area).
    const drill = (Dm[2][2]) * 1e-3;

    const nodeIdx = (ix: number, iy: number) => iy * m.nx + ix;
    for (const [ix, iy] of m.activeCells) {
      const en = [nodeIdx(ix, iy), nodeIdx(ix + 1, iy), nodeIdx(ix + 1, iy + 1), nodeIdx(ix, iy + 1)];
      const g = en.map((n) => m.gnode[n]);
      if (g.some((x) => x < 0)) continue;

      // Build the 24×24 local element (6 dof/node) by scattering bending +
      // membrane + drilling into local DOF slots, then rotate to global.
      // Local per-node dof order: [u, v, w, θu, θv, θw].
      for (let ni = 0; ni < 4; ni++) {
        for (let nj = 0; nj < 4; nj++) {
          // 6×6 local block for the (ni,nj) node pair.
          const blk: number[][] = Array.from({ length: 6 }, () => new Array(6).fill(0));
          // membrane: local dof 0,1 ← Km rows [ni*2, ni*2+1]
          blk[0][0] += Km[ni * 2][nj * 2];
          blk[0][1] += Km[ni * 2][nj * 2 + 1];
          blk[1][0] += Km[ni * 2 + 1][nj * 2];
          blk[1][1] += Km[ni * 2 + 1][nj * 2 + 1];
          // bending: local dof 2 (w), 3 (θu==θx), 4 (θv==θy) ← Kb rows [ni*3..]
          for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 3; c++) {
              blk[2 + r][2 + c] += Kb[ni * 3 + r][nj * 3 + c];
            }
          }
          // drilling stabilization on θw (local dof 5), diagonal only.
          if (ni === nj) blk[5][5] += drill * m.dx * m.dy;

          // Rotate the 6×6 local block to global: global = T · local · Tᵀ,
          // where T maps [local xyz] → [world xyz] using (ux,vy,nz) as columns.
          // Both translational (0..2) and rotational (3..5) triples rotate the
          // same way. We do it triple-by-triple.
          rotateAndScatter(rows, blk, g[ni], g[nj], ux, vy, nz);
        }
      }
    }
  }

  if (repStiff <= 0 || !Number.isFinite(repStiff)) repStiff = 1e3;

  // --- JOINT COUPLING: penalty springs between nearest node pairs along each
  //     contact segment. rigid → all 6 DOF; semi-rigid → translational + 5%
  //     rotational; hinged → translational only. ---
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

  const addSpring = (gi: number, gj: number, dofOff: number, k: number) => {
    const di = gi * 6 + dofOff, dj = gj * 6 + dofOff;
    addK(di, di, k); addK(dj, dj, k);
    addK(di, dj, -k); addK(dj, di, -k);
  };

  for (const j of joints) {
    const ma = panelById.get(j.a), mb = panelById.get(j.b);
    if (!ma || !mb) continue;
    const tol = Math.max(tolMm, Math.min(ma.dx, ma.dy, mb.dx, mb.dy) * 1.5);
    const na = nodesAlong(ma, j.p0, j.p1, tol);
    const nb = nodesAlong(mb, j.p0, j.p1, tol);
    if (na.length === 0 || nb.length === 0) continue;
    // Penalty stiffness ~1e3 × the SOFTER of the two joined panels (rigid). A
    // per-joint scale (not the global max) keeps the condition number bounded
    // when the job mixes thick and thin panels.
    const kTrans = Math.min(panelStiff.get(j.a) ?? repStiff, panelStiff.get(j.b) ?? repStiff) * 1e3;
    // rigid → full rotational coupling; semi-rigid → 5%. Hinged transmits
    // translation only, but a razor-thin (1-node-wide) contact line with zero
    // rotational coupling is a numerical mechanism — the jointed panel can spin
    // freely about the seam axis, so PCG never converges. We regularize the
    // hinge with a token rotational stiffness (0.1% — 50× softer than
    // semi-rigid, so it stays unambiguously the floppiest joint) purely to kill
    // that free rotation. Physically this is the tiny friction any real hinge
    // has; structurally it's negligible next to semi-rigid/rigid.
    const kRot = j.stiffness === 'rigid' ? kTrans
      : j.stiffness === 'semi-rigid' ? kTrans * 0.05
        : kTrans * 0.001; // hinged (regularized translational coupling)
    // Pair each a-node with its nearest b-node.
    for (const gi of na) {
      let bestG = -1, bestD = Infinity;
      for (const gj of nb) {
        const d = w3len(w3sub(nodePos[gi], nodePos[gj]));
        if (d < bestD) { bestD = d; bestG = gj; }
      }
      if (bestG < 0) continue;
      for (let dof = 0; dof < 3; dof++) addSpring(gi, bestG, dof, kTrans);
      if (kRot > 0) for (let dof = 3; dof < 6; dof++) addSpring(gi, bestG, dof, kRot);
    }
  }

  // --- GROUNDING: translational supports on nodes within `groundBand` of the
  //     floor. The floor datum is the assembly's LOWEST world z (the base the
  //     cabinet stands on) — the model rarely sits exactly at z=0. We refuse
  //     only when NO panel reaches near that base plane (a physically floating
  //     assembly). The band is generous (max of the tolerance and one node
  //     spacing) so a base panel lands even when the mesh is coarse. ---
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
  // Under-constrained refusal: need at least one grounded node. (A cabinet
  // sitting on the floor is modelled as a FIXED base — all 6 DOF clamped on the
  // floor-contact nodes — so even a single grounded line fully removes the six
  // rigid-body modes.) With floorZ = the lowest node this essentially always
  // finds the base row; the guard remains as a backstop.
  if (grounded.length < 1) {
    return { ...empty(
      'The assembly has no base on the floor — nothing to ground it. Check that at least one panel reaches the cabinet base.'),
      resolutionLog, totalNodes, totalDof: nDof };
  }

  // Fix all 6 DOF of grounded nodes — a panel resting on the floor is clamped
  // there (it can't slide, lift, or tip). A single grounded line then removes
  // every rigid-body mode of the coupled shell.
  const fixed = new Uint8Array(nDof);
  for (const g of grounded) {
    for (let dof = 0; dof < 6; dof++) fixed[g * 6 + dof] = 1;
  }

  // --- Soft regularization: a tiny grounding spring on EVERY free DOF. This
  //     removes any residual rigid-body / drilling mechanism of a panel that
  //     happens to connect to the grounded structure only through a hinge (or
  //     a chain of soft joints), turning a near-singular system into a well-
  //     conditioned SPD one. The stiffness is ~1e-6 of the representative plate
  //     stiffness — utterly negligible for any properly-constrained DOF, but
  //     enough to pin a floating sub-assembly so Jacobi-PCG converges instead
  //     of diverging. Without it a real cabinet (20 panels, mixed joints) does
  //     not converge. ---
  const kSoft = repStiff * 1e-4;
  for (let g = 0; g < nDof; g++) {
    if (fixed[g]) continue;
    const r = rows[g];
    r.set(g, (r.get(g) ?? 0) + kSoft);
  }

  // --- Load vector ---
  const F = new Float64Array(nDof);
  for (const load of loads) {
    if (!load.N) continue;
    const m = panelById.get(load.panelId);
    if (!m) continue;
    const p = m.panel;
    // Spread the load over active nodes inside the footprint (like the plate).
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
      // snap to nearest active node
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
    // The load acts along −normal (into the face). Distribute as a world force
    // vector on each node's 3 translational DOF.
    const share = load.N / inFoot.length;
    const fWorld: Vec3World = w3scale(p.normal, -share);
    for (const g of inFoot) {
      F[g * 6] += fWorld[0];
      F[g * 6 + 1] += fWorld[1];
      F[g * 6 + 2] += fWorld[2];
    }
  }

  // Apply Dirichlet BCs (homogeneous).
  for (let g = 0; g < nDof; g++) {
    if (fixed[g]) { F[g] = 0; rows[g] = new Map([[g, 1]]); }
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

  // Solve — Jacobi-PCG, rel tol 1e-7, cap 20k.
  const x = new Float64Array(nDof);
  const { iterations, converged } = pcg(rowPtr, colIdx, val, diag, F, x, 1e-7, 20000);

  // Scatter per-panel translational displacement magnitude.
  const panelResults: AsmPanelResult[] = [];
  let maxDisp = 0, maxPanelId = -1;
  let maxAt: Vec2 = [0, 0];
  for (const m of meshes) {
    const nNodes = m.nx * m.ny;
    const disp = new Float32Array(nNodes).fill(NaN);
    let pMax = 0;
    for (let iy = 0; iy < m.ny; iy++) {
      for (let ix = 0; ix < m.nx; ix++) {
        const g = m.gnode[iy * m.nx + ix];
        if (g < 0) continue;
        const dxv = x[g * 6], dyv = x[g * 6 + 1], dzv = x[g * 6 + 2];
        const mag = Math.hypot(dxv, dyv, dzv);
        disp[iy * m.nx + ix] = mag;
        if (mag > pMax) pMax = mag;
        if (mag > maxDisp) {
          maxDisp = mag; maxPanelId = m.panel.id; maxAt = [ix * m.dx, iy * m.dy];
        }
      }
    }
    panelResults.push({ id: m.panel.id, nx: m.nx, ny: m.ny, dx: m.dx, dy: m.dy, disp, active: m.active, maxAbs: pMax });
  }

  // Non-physical / NaN backstop.
  const governing = panels.find((p) => p.id === maxPanelId) ?? panels[0];
  const span = Math.max(governing.outline.bbox.w, governing.outline.bbox.h);
  if (!Number.isFinite(maxDisp) || maxDisp > span * 2) {
    return { ...empty('Solve produced a non-physical result — check the joints and grounding.'), resolutionLog, totalNodes, totalDof: nDof, iterations };
  }

  const limit = span / 200;
  const verdict: 'ok' | 'borderline' | 'weak' =
    maxDisp < span / 300 ? 'ok' : maxDisp < limit ? 'borderline' : 'weak';

  return {
    ok: true, panels: panelResults, maxDisp, maxPanelId, maxAt, spanMm: span, verdict,
    totalDof: nDof, totalNodes, iterations, converged,
    groundedNodes: grounded.length, resolutionLog, groundPoints,
  };
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
