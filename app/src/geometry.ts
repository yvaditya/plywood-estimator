/**
 * Geometry analysis for solid bodies extracted from STEP files.
 *
 * Pipeline per body:
 *   1. PCA-based oriented bounding box → axes + extents.
 *   2. Smallest extent = thickness. The other two axes define the sheet plane.
 *   3. Filter triangles whose normal is parallel to the thickness axis
 *      and facing the same direction (top face).
 *   4. Extract the boundary edges of that triangle set, walk them into
 *      closed loops, and project to 2D using the sheet-plane axes.
 *   5. Classify loops as outer ring + holes by signed area.
 *
 * Output is suitable for polygon nesting and SVG rendering.
 */

import type { OcctMesh } from './stepLoader';

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

export interface Obb {
  center: Vec3;
  axes: [Vec3, Vec3, Vec3];     // unit vectors
  extents: [number, number, number]; // half-sizes along each axis
}

export interface PolygonOutline {
  /** Outer ring (CCW). Coordinates in millimetres, anchored so min is (0,0). */
  outer: Vec2[];
  /** Inner rings (holes), CW. */
  holes: Vec2[][];
  /** Width (X) and length (Y) of the AABB of the outline in mm. */
  bbox: { w: number; h: number };
  /** Area of (outer - holes) in mm². */
  area: number;
}

export interface BodyAnalysis {
  thickness: number;      // mm
  width: number;          // mm  (smaller of the two non-thickness extents)
  length: number;         // mm  (larger of the two non-thickness extents)
  volume: number;         // mm³ (OBB volume — coarse estimate)
  outline: PolygonOutline;
  /** Centroid of the body's AABB in world coords (for arrow anchors). */
  centerWorld: Vec3;
  /** DEPRECATED: kept for backwards compat with main.ts. Use faceCenter. */
  topZ: number;
  /** DEPRECATED: True if world X is the "length" axis. Use lengthDir instead. */
  lengthAxisIsX: boolean;
  /** Centroid of the part's "front" flat face in world coords. */
  faceCenter: Vec3;
  /** Unit normal to the flat face, in world coords (points outward). */
  faceNormal: Vec3;
  /** Unit world vector along the part's LENGTH (longer in-face edge). */
  lengthDir: Vec3;
  /** Unit world vector along the part's WIDTH (shorter in-face edge). */
  widthDir: Vec3;
}

// ---------------------------------------------------------------------------
// Tiny vector helpers
// ---------------------------------------------------------------------------
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const mulv = (m: number[][], v: Vec3): Vec3 => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];

// ---------------------------------------------------------------------------
// Symmetric 3x3 eigen-decomposition via Jacobi rotations.
// Returns eigenvalues sorted descending and corresponding eigenvectors.
// ---------------------------------------------------------------------------
function jacobiEigen3(a: number[][]): { values: Vec3; vectors: [Vec3, Vec3, Vec3] } {
  const m: number[][] = a.map((r) => r.slice());
  const v: number[][] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let iter = 0; iter < 50; iter++) {
    // find largest off-diagonal
    let p = 0, q = 1, maxOff = Math.abs(m[0][1]);
    if (Math.abs(m[0][2]) > maxOff) { p = 0; q = 2; maxOff = Math.abs(m[0][2]); }
    if (Math.abs(m[1][2]) > maxOff) { p = 1; q = 2; maxOff = Math.abs(m[1][2]); }
    if (maxOff < 1e-12) break;

    const theta = (m[q][q] - m[p][p]) / (2 * m[p][q]);
    const t = Math.sign(theta) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
    const c = 1 / Math.sqrt(1 + t * t);
    const s = t * c;

    const mpp = m[p][p], mqq = m[q][q], mpq = m[p][q];
    m[p][p] = mpp - t * mpq;
    m[q][q] = mqq + t * mpq;
    m[p][q] = 0;
    m[q][p] = 0;
    for (let i = 0; i < 3; i++) {
      if (i !== p && i !== q) {
        const mip = m[i][p], miq = m[i][q];
        m[i][p] = c * mip - s * miq; m[p][i] = m[i][p];
        m[i][q] = s * mip + c * miq; m[q][i] = m[i][q];
      }
    }
    for (let i = 0; i < 3; i++) {
      const vip = v[i][p], viq = v[i][q];
      v[i][p] = c * vip - s * viq;
      v[i][q] = s * vip + c * viq;
    }
  }
  const vals: Vec3 = [m[0][0], m[1][1], m[2][2]];
  const vecs: [Vec3, Vec3, Vec3] = [
    [v[0][0], v[1][0], v[2][0]],
    [v[0][1], v[1][1], v[2][1]],
    [v[0][2], v[1][2], v[2][2]],
  ];
  // sort by eigenvalue desc
  const order = [0, 1, 2].sort((a, b) => vals[b] - vals[a]) as [number, number, number];
  return {
    values: [vals[order[0]], vals[order[1]], vals[order[2]]],
    vectors: [vecs[order[0]], vecs[order[1]], vecs[order[2]]],
  };
}

// ---------------------------------------------------------------------------
// PCA-based OBB.
// ---------------------------------------------------------------------------
function computeObb(positions: number[]): Obb {
  const n = positions.length / 3;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) {
    cx += positions[i * 3];
    cy += positions[i * 3 + 1];
    cz += positions[i * 3 + 2];
  }
  cx /= n; cy /= n; cz /= n;

  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (let i = 0; i < n; i++) {
    const dx = positions[i * 3] - cx;
    const dy = positions[i * 3 + 1] - cy;
    const dz = positions[i * 3 + 2] - cz;
    xx += dx * dx; xy += dx * dy; xz += dx * dz;
    yy += dy * dy; yz += dy * dz;
    zz += dz * dz;
  }
  const cov = [
    [xx / n, xy / n, xz / n],
    [xy / n, yy / n, yz / n],
    [xz / n, yz / n, zz / n],
  ];
  const { vectors } = jacobiEigen3(cov);
  const axes: [Vec3, Vec3, Vec3] = [norm(vectors[0]), norm(vectors[1]), norm(vectors[2])];

  // Re-orient axes to project min/max
  const mins: Vec3 = [Infinity, Infinity, Infinity];
  const maxs: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const p: Vec3 = [
      positions[i * 3] - cx,
      positions[i * 3 + 1] - cy,
      positions[i * 3 + 2] - cz,
    ];
    for (let k = 0; k < 3; k++) {
      const d = dot(p, axes[k]);
      if (d < mins[k]) mins[k] = d;
      if (d > maxs[k]) maxs[k] = d;
    }
  }

  // Shift OBB center so it sits at the midpoint along each axis.
  let centerX = cx, centerY = cy, centerZ = cz;
  for (let k = 0; k < 3; k++) {
    const mid = (mins[k] + maxs[k]) / 2;
    centerX += axes[k][0] * mid;
    centerY += axes[k][1] * mid;
    centerZ += axes[k][2] * mid;
  }
  const extents: [number, number, number] = [
    (maxs[0] - mins[0]) / 2,
    (maxs[1] - mins[1]) / 2,
    (maxs[2] - mins[2]) / 2,
  ];

  return {
    center: [centerX, centerY, centerZ],
    axes,
    extents,
  };
}

// ---------------------------------------------------------------------------
// Boundary loop extraction from a triangle set.
// ---------------------------------------------------------------------------
function edgeKey(a: number, b: number): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

function buildBoundaryLoops(
  triangles: number[][], // each [i0, i1, i2]
): number[][] {
  // Count edge usage. Each edge stored as ordered pair so we can walk it.
  const usage = new Map<string, number>();
  const directed: Array<[number, number]> = [];
  for (const tri of triangles) {
    for (let e = 0; e < 3; e++) {
      const a = tri[e];
      const b = tri[(e + 1) % 3];
      const k = edgeKey(a, b);
      usage.set(k, (usage.get(k) ?? 0) + 1);
      directed.push([a, b]);
    }
  }
  // Boundary directed edges = those whose undirected edge appears once.
  // We must pick the directed orientation that came from a triangle (we have them all).
  const boundary: Array<[number, number]> = [];
  for (const [a, b] of directed) {
    if (usage.get(edgeKey(a, b)) === 1) boundary.push([a, b]);
  }

  // Build adjacency: from -> [to]
  const adj = new Map<number, number[]>();
  for (const [a, b] of boundary) {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a)!.push(b);
  }

  // Walk loops
  const loops: number[][] = [];
  const usedKey = new Set<string>();
  for (const [start] of boundary) {
    const startList = adj.get(start);
    if (!startList || startList.length === 0) continue;
    if (usedKey.has(`${start}_${startList[0]}`)) continue;

    const loop: number[] = [start];
    let cur = start;
    let prev = -1;
    let guard = 0;
    while (guard++ < boundary.length + 2) {
      const outs = adj.get(cur) ?? [];
      // pick first unused outgoing edge that isn't directly back to prev
      let nextIdx = -1;
      for (let i = 0; i < outs.length; i++) {
        const cand = outs[i];
        if (usedKey.has(`${cur}_${cand}`)) continue;
        nextIdx = i;
        break;
      }
      if (nextIdx === -1) break;
      const next = outs[nextIdx];
      usedKey.add(`${cur}_${next}`);
      if (next === start) break;
      loop.push(next);
      prev = cur;
      cur = next;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

// ---------------------------------------------------------------------------
// Polygon helpers (2D, after projection)
// ---------------------------------------------------------------------------
function signedArea(ring: Vec2[]): number {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function simplifyRing(ring: Vec2[], tol: number): Vec2[] {
  if (ring.length < 4) return ring;
  const out: Vec2[] = [];
  for (let i = 0; i < ring.length; i++) {
    const prev = out.length ? out[out.length - 1] : ring[ring.length - 1];
    const cur = ring[i];
    const next = ring[(i + 1) % ring.length];
    // collinearity test by triangle area
    const cross =
      (cur[0] - prev[0]) * (next[1] - prev[1]) - (cur[1] - prev[1]) * (next[0] - prev[0]);
    if (Math.abs(cross) > tol) out.push(cur);
  }
  return out.length >= 3 ? out : ring;
}

// ---------------------------------------------------------------------------
// Main body analysis
//
// Sheet-goods parts are panels: one dimension (thickness) is much smaller
// than the other two (length, width). We detect WHICH world axis is the
// thin one — Z for floor-lying panels, X or Y for upright panels — and
// extract the flat-face outline in the plane perpendicular to it.
//
// Only when the thinnest extent isn't significantly smaller than the others
// (i.e. the part isn't sheet-good shaped) do we fall back to PCA OBB.
// ---------------------------------------------------------------------------
/**
 * Returns null if the body isn't a sheet good (e.g. round legs, blocks,
 * dowels, hardware). Caller should skip these.
 *
 * Sheet-good test:
 *   1. Thinnest extent within stock plywood range (1/8" – 1", ~3–26 mm).
 *   2. Thinnest extent meaningfully smaller than the mid extent (ratio <
 *      0.5) — either along a world axis OR along a PCA-OBB axis (so tilted
 *      panels still qualify).
 */
const SHEET_THICKNESS_MIN_MM = 3.0;  // ~1/8"
const SHEET_THICKNESS_MAX_MM = 26.0; // ~1"  (with slack)

export function analyzeBody(mesh: OcctMesh): BodyAnalysis | null {
  const positions = mesh.attributes.position.array;
  const indices = mesh.index.array;

  const aabb = computeAabb(positions);
  const ext: Vec3 = [
    aabb.max[0] - aabb.min[0],
    aabb.max[1] - aabb.min[1],
    aabb.max[2] - aabb.min[2],
  ];

  // Sort indices by extent ascending → thin, mid, big.
  const idxs: [number, number, number] = [0, 1, 2];
  idxs.sort((a, b) => ext[a] - ext[b]);
  const thinIdx = idxs[0];
  const midIdx = idxs[1];
  const bigIdx = idxs[2];

  const worldThinRatio = ext[thinIdx] / Math.max(ext[midIdx], 1e-6);
  const worldThickness = ext[thinIdx];
  const worldIsSheet =
    worldThinRatio < 0.5 &&
    worldThickness >= SHEET_THICKNESS_MIN_MM &&
    worldThickness <= SHEET_THICKNESS_MAX_MM;

  if (worldIsSheet) {
    return analyzeAxisAligned(positions, indices, aabb, ext, thinIdx, bigIdx, midIdx);
  }

  // World axes don't show a sheet — try PCA-OBB (handles tilted panels).
  const obb = computeObb(positions);
  const obbIdxs = [0, 1, 2].sort((a, b) => obb.extents[a] - obb.extents[b]) as [number, number, number];
  const obbThin = obb.extents[obbIdxs[0]] * 2;
  const obbMid = obb.extents[obbIdxs[1]] * 2;
  const obbRatio = obbThin / Math.max(obbMid, 1e-6);
  const obbIsSheet =
    obbRatio < 0.5 &&
    obbThin >= SHEET_THICKNESS_MIN_MM &&
    obbThin <= SHEET_THICKNESS_MAX_MM;

  if (obbIsSheet) {
    return analyzeObb(positions, indices);
  }

  // Not a sheet good (round leg, dowel, block, hardware, etc.) → skip.
  return null;
}

// ---------------------------------------------------------------------------
// World-Z axis-aligned analysis (the fast/common path).
// ---------------------------------------------------------------------------
function computeAabb(positions: number[]): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
    if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
    if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
  }
  return { min, max };
}

/**
 * Axis-aligned analysis: thin world axis can be 0 (X), 1 (Y), or 2 (Z).
 * Outline is extracted in the plane perpendicular to the thin axis.
 *
 * Indices passed in: thinIdx = thinnest extent; bigIdx = longest extent;
 * midIdx = middle extent. So length = ext[bigIdx], width = ext[midIdx].
 */
function analyzeAxisAligned(
  positions: number[],
  indices: number[],
  aabb: { min: Vec3; max: Vec3 },
  ext: Vec3,
  thinIdx: number,
  bigIdx: number,
  midIdx: number,
): BodyAnalysis {
  const thickness = ext[thinIdx];
  const length = ext[bigIdx];
  const width = ext[midIdx];

  // Build world-axis unit vectors
  const e: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const faceNormal: Vec3 = e[thinIdx];
  const lengthDir: Vec3 = e[bigIdx];
  const widthDir: Vec3 = e[midIdx];

  // Find "front-facing" triangles — normal aligned with +faceNormal
  const topTris: number[][] = [];
  const triCount = indices.length / 3;
  const FLAT_DOT = 0.92;
  for (let t = 0; t < triCount; t++) {
    const i0 = indices[t * 3];
    const i1 = indices[t * 3 + 1];
    const i2 = indices[t * 3 + 2];
    const p0: Vec3 = [positions[i0 * 3], positions[i0 * 3 + 1], positions[i0 * 3 + 2]];
    const p1: Vec3 = [positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]];
    const p2: Vec3 = [positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]];
    const n = norm(cross(sub(p1, p0), sub(p2, p0)));
    if (dot(n, faceNormal) >= FLAT_DOT) topTris.push([i0, i1, i2]);
  }

  let outline: PolygonOutline;
  if (topTris.length < 1) {
    const outer: Vec2[] = [
      [0, 0],
      [length, 0],
      [length, width],
      [0, width],
    ];
    outline = { outer, holes: [], bbox: { w: length, h: width }, area: length * width };
  } else {
    outline = buildOutline(positions, topTris, lengthDir, widthDir);
  }

  // AABB centroid (volume center)
  const cx = (aabb.min[0] + aabb.max[0]) / 2;
  const cy = (aabb.min[1] + aabb.max[1]) / 2;
  const cz = (aabb.min[2] + aabb.max[2]) / 2;
  const centerWorld: Vec3 = [cx, cy, cz];

  // Face centroid = AABB center + half-thickness along faceNormal.
  // This puts the arrow on the "+ face" (e.g. +Z top, +Y back, +X right).
  const faceCenter: Vec3 = [
    cx + faceNormal[0] * thickness / 2,
    cy + faceNormal[1] * thickness / 2,
    cz + faceNormal[2] * thickness / 2,
  ];

  return {
    thickness, width, length,
    volume: thickness * width * length,
    outline,
    centerWorld,
    topZ: aabb.max[2], // legacy
    lengthAxisIsX: bigIdx === 0, // legacy
    faceCenter,
    faceNormal,
    lengthDir,
    widthDir,
  };
}

// ---------------------------------------------------------------------------
// OBB fallback (for parts that aren't aligned with Z up)
// ---------------------------------------------------------------------------
function analyzeObb(positions: number[], indices: number[]): BodyAnalysis {
  const obb = computeObb(positions);
  const idxs = [0, 1, 2].sort((a, b) => obb.extents[a] - obb.extents[b]);
  const tAxisIdx = idxs[0];
  const wAxisIdx = idxs[1];
  const lAxisIdx = idxs[2];

  const tAxis = obb.axes[tAxisIdx];
  const wAxis = obb.axes[wAxisIdx];
  const lAxis = obb.axes[lAxisIdx];

  const thickness = obb.extents[tAxisIdx] * 2;
  const width = obb.extents[wAxisIdx] * 2;
  const length = obb.extents[lAxisIdx] * 2;

  const topTris: number[][] = [];
  const triCount = indices.length / 3;
  const FLAT_DOT = 0.92;
  for (let t = 0; t < triCount; t++) {
    const i0 = indices[t * 3];
    const i1 = indices[t * 3 + 1];
    const i2 = indices[t * 3 + 2];
    const p0: Vec3 = [positions[i0 * 3], positions[i0 * 3 + 1], positions[i0 * 3 + 2]];
    const p1: Vec3 = [positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]];
    const p2: Vec3 = [positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]];
    const n = norm(cross(sub(p1, p0), sub(p2, p0)));
    if (dot(n, tAxis) >= FLAT_DOT) topTris.push([i0, i1, i2]);
  }

  let outline: PolygonOutline;
  if (topTris.length < 1) {
    const outer: Vec2[] = [
      [0, 0],
      [length, 0],
      [length, width],
      [0, width],
    ];
    outline = { outer, holes: [], bbox: { w: length, h: width }, area: length * width };
  } else {
    outline = buildOutline(positions, topTris, lAxis, wAxis);
  }

  // World-axis AABB for arrow placement (OBB axes for face vectors below).
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  const halfThick = thickness / 2;
  return {
    thickness, width, length,
    volume: thickness * width * length,
    outline,
    centerWorld: [cx, cy, cz],
    topZ: maxZ,
    lengthAxisIsX: (maxX - minX) >= (maxY - minY),
    faceCenter: [cx + tAxis[0] * halfThick, cy + tAxis[1] * halfThick, cz + tAxis[2] * halfThick],
    faceNormal: tAxis,
    lengthDir: lAxis,
    widthDir: wAxis,
  };
}

function buildOutline(
  positions: number[],
  topTris: number[][],
  uAxis: Vec3, // becomes 2D X
  vAxis: Vec3, // becomes 2D Y
): PolygonOutline {
  const loops3 = buildBoundaryLoops(topTris);

  // Project each vertex of each loop onto the (u, v) plane.
  const project = (vi: number): Vec2 => {
    const p: Vec3 = [positions[vi * 3], positions[vi * 3 + 1], positions[vi * 3 + 2]];
    return [dot(p, uAxis), dot(p, vAxis)];
  };

  let rings: Vec2[][] = loops3.map((loop) => loop.map(project));
  // Simplify (drop collinear)
  rings = rings.map((r) => simplifyRing(r, 1e-3)).filter((r) => r.length >= 3);

  if (rings.length === 0) {
    return { outer: [], holes: [], bbox: { w: 0, h: 0 }, area: 0 };
  }

  // Choose outer = ring with the largest |signed area|
  let outerIdx = 0;
  let maxAbs = -Infinity;
  const areas = rings.map((r, i) => {
    const a = signedArea(r);
    const abs = Math.abs(a);
    if (abs > maxAbs) { maxAbs = abs; outerIdx = i; }
    return a;
  });

  // Normalize windings: outer CCW (positive), holes CW (negative).
  const outerRaw = rings[outerIdx];
  let outer = areas[outerIdx] > 0 ? outerRaw : outerRaw.slice().reverse();
  let holesNorm: Vec2[][] = rings
    .map((r, i) => ({ r, a: areas[i], i }))
    .filter((x) => x.i !== outerIdx)
    .map((x) => (x.a < 0 ? x.r : x.r.slice().reverse()));

  // Auto-orient: snap polygon so its dominant edge direction is axis-aligned.
  // For a pure rectangle this is a no-op (dominant angle already 0). For a
  // part with angled cuts, this minimizes the count/length of skew edges
  // against the sheet edges — what the user asked for.
  const snapDeg = dominantEdgeAngleMod90(outer);
  // Prefer the smaller-magnitude rotation (closer to 0° or 90° lock-up).
  const rotateBy = snapDeg > 45 ? snapDeg - 90 : snapDeg;
  if (Math.abs(rotateBy) > 0.25 && Math.abs(rotateBy) < 89.75) {
    const rad = -rotateBy * Math.PI / 180;
    outer = rotateRing2(outer, rad);
    holesNorm = holesNorm.map((h) => rotateRing2(h, rad));
  }

  // Shift so outer ring sits in positive quadrant anchored at (0,0).
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of outer) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const shift = ([x, y]: Vec2): Vec2 => [x - minX, y - minY];
  outer = outer.map(shift);
  const shiftedHoles = holesNorm.map((h) => h.map(shift));

  const w = maxX - minX;
  const h = maxY - minY;

  // Area = outer - holes
  let area = Math.abs(signedArea(outer));
  for (const hole of shiftedHoles) area -= Math.abs(signedArea(hole));

  return {
    outer,
    holes: shiftedHoles,
    bbox: { w, h },
    area: Math.max(area, 0),
  };
}

/**
 * Compute the dominant edge direction of a polygon (length-weighted),
 * reduced modulo 90° since X-aligned and Y-aligned are equivalent for
 * sheet packing. Returns degrees in [0, 90).
 *
 * Rectangle → 0° (all four edges are at 0° or 90° → fold to 0°).
 * Triangle with one edge at 17°  → ~17°.
 * Diamond rotated 45° → 45°.
 */
function dominantEdgeAngleMod90(outer: Vec2[]): number {
  const BINS = 180; // 0.5° resolution
  const hist = new Float64Array(BINS);
  const n = outer.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = outer[i];
    const [x2, y2] = outer[(i + 1) % n];
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 0.01) continue;
    let a = Math.atan2(dy, dx) * 180 / Math.PI; // [-180, 180]
    a = ((a % 90) + 90) % 90; // fold to [0, 90)
    const bin = Math.min(BINS - 1, Math.floor(a * (BINS / 90)));
    hist[bin] += len;
  }
  let maxBin = 0;
  for (let i = 1; i < BINS; i++) if (hist[i] > hist[maxBin]) maxBin = i;
  return maxBin * (90 / BINS);
}

function rotateRing2(ring: Vec2[], rad: number): Vec2[] {
  if (rad === 0) return ring;
  const c = Math.cos(rad), s = Math.sin(rad);
  return ring.map(([x, y]) => [x * c - y * s, x * s + y * c]);
}
