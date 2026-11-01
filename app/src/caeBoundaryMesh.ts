/** Conforming Q4 meshes of planar polygonal CAD boundaries, including holes. */
import { ShapeUtils, Vector2 } from 'three';
import type { PolygonOutline, Vec2 } from './geometry';

type Triangle = [number, number, number];
type Quad = [number, number, number, number];
interface Edge { a: number; b: number; faces: number[] }

export interface BoundaryQuadMesh {
  uv: Vec2[];
  quads: Quad[];
}

// These are allocation/work limits, independent of the caller's stricter DOF
// cap. They also apply when mandatory CAD boundary detail is extremely dense.
const MAX_BOUNDARY_VERTICES = 12000;
const MAX_TRIANGLES = 40000;
const MAX_INTERSECTION_CHECKS = 2000000;
const COORD_TOL = 1e-12;
const edgeKey = (a: number, b: number): string => a < b ? `${a}:${b}` : `${b}:${a}`;
const orient = (a: Vec2, b: Vec2, c: Vec2): number =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const distanceSq = (a: Vec2, b: Vec2): number => (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
const orientRoundoff = (a: Vec2, b: Vec2, c: Vec2): number => 32 * Number.EPSILON *
  (Math.abs((b[0] - a[0]) * (c[1] - a[1])) + Math.abs((b[1] - a[1]) * (c[0] - a[0]))) + 1e-28;
const positive = (a: Vec2, b: Vec2, c: Vec2): boolean => orient(a, b, c) > orientRoundoff(a, b, c);
const capError = (): Error => new Error('Boundary mesh exceeds its resource cap. Increase the element size or simplify the CAD boundary.');

function ringArea(ring: Vec2[]): number {
  const base = ring[0];
  let twice = 0;
  for (let i = 1; i + 1 < ring.length; i++) twice += orient(base, ring[i], ring[i + 1]);
  return twice / 2;
}

function onSegment(p: Vec2, a: Vec2, b: Vec2): boolean {
  return Math.abs(orient(a, b, p)) <= COORD_TOL * Math.sqrt(distanceSq(a, b))
    && p[0] >= Math.min(a[0], b[0]) - COORD_TOL && p[0] <= Math.max(a[0], b[0]) + COORD_TOL
    && p[1] >= Math.min(a[1], b[1]) - COORD_TOL && p[1] <= Math.max(a[1], b[1]) + COORD_TOL;
}

function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const abc = orient(a, b, c), abd = orient(a, b, d), cda = orient(c, d, a), cdb = orient(c, d, b);
  if (((abc > 0 && abd < 0) || (abc < 0 && abd > 0)) && ((cda > 0 && cdb < 0) || (cda < 0 && cdb > 0))) return true;
  return onSegment(a, c, d) || onSegment(b, c, d) || onSegment(c, a, b) || onSegment(d, a, b);
}

function insideRing(p: Vec2, ring: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function validateRings(rings: Vec2[][]): void {
  const segments: { a: Vec2; b: Vec2; ring: number; index: number; minX: number; maxX: number; minY: number; maxY: number }[] = [];
  rings.forEach((ring, r) => ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length], previous = ring[(i + ring.length - 1) % ring.length];
    if (distanceSq(a, b) <= COORD_TOL ** 2) throw new Error('Invalid boundary: duplicate or numerically coincident vertices.');
    if (Math.abs(orient(previous, a, b)) <= COORD_TOL * Math.sqrt(distanceSq(previous, b))
      && (previous[0] - a[0]) * (b[0] - a[0]) + (previous[1] - a[1]) * (b[1] - a[1]) > 0) {
      throw new Error('Invalid boundary: adjacent segments overlap or backtrack.');
    }
    segments.push({ a, b, ring: r, index: i, minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]), minY: Math.min(a[1], b[1]), maxY: Math.max(a[1], b[1]) });
  }));
  // A bounding-box sweep avoids an all-pairs check on ordinary detailed curves.
  // Pathological overlapping boxes still have an explicit work cap.
  segments.sort((a, b) => a.minX - b.minX);
  let checks = 0;
  for (let i = 0; i < segments.length; i++) {
    const a = segments[i];
    for (let j = i + 1; j < segments.length && segments[j].minX <= a.maxX + COORD_TOL; j++) {
      if (++checks > MAX_INTERSECTION_CHECKS) throw capError();
      const b = segments[j];
      if (b.minY > a.maxY + COORD_TOL || b.maxY < a.minY - COORD_TOL) continue;
      if (a.ring === b.ring) {
        const gap = Math.abs(a.index - b.index);
        if (gap === 1 || gap === rings[a.ring].length - 1) continue;
      }
      if (segmentsIntersect(a.a, a.b, b.a, b.b)) throw new Error('Invalid boundary: rings self-intersect, overlap, or touch.');
    }
  }
  for (const ring of rings) if (Math.abs(ringArea(ring)) < 1e-18) throw new Error('Invalid boundary: a ring has degenerate area.');
  for (let i = 1; i < rings.length; i++) {
    if (!insideRing(rings[i][0], rings[0])) throw new Error('Invalid boundary: a hole lies outside the outer ring.');
    for (let j = 1; j < i; j++) {
      if (insideRing(rings[i][0], rings[j]) || insideRing(rings[j][0], rings[i])) throw new Error('Invalid boundary: holes overlap or are nested.');
    }
  }
}

/** Mutable triangle topology. Every split updates both incident faces. */
class TriangleMesh {
  readonly triangles: Triangle[] = [];
  readonly edges = new Map<string, Edge>();

  constructor(readonly points: Vec2[]) {}

  addTriangle(input: Triangle, index = this.triangles.length): void {
    const triangle: Triangle = [...input];
    let [a, b, c] = triangle.map(i => this.points[i]);
    if (orient(a, b, c) < 0) { [triangle[1], triangle[2]] = [triangle[2], triangle[1]]; [b, c] = [c, b]; }
    if (!positive(a, b, c)) throw new Error('Invalid boundary mesh: a triangle is numerically degenerate.');
    if (index >= MAX_TRIANGLES) throw capError();
    this.triangles[index] = triangle;
    for (let k = 0; k < 3; k++) {
      const a = triangle[k], b = triangle[(k + 1) % 3], key = edgeKey(a, b);
      const edge = this.edges.get(key) ?? { a, b, faces: [] };
      edge.faces.push(index);
      if (edge.faces.length > 2) throw new Error('Invalid boundary mesh: a non-manifold edge was created.');
      this.edges.set(key, edge);
    }
  }

  replace(faces: number[], replacements: Triangle[]): void {
    if (this.triangles.length + replacements.length - faces.length > MAX_TRIANGLES) throw capError();
    for (const face of faces) {
      const triangle = this.triangles[face];
      for (let i = 0; i < 3; i++) {
        const key = edgeKey(triangle[i], triangle[(i + 1) % 3]), edge = this.edges.get(key)!;
        edge.faces.splice(edge.faces.indexOf(face), 1);
        if (edge.faces.length === 0) this.edges.delete(key);
      }
    }
    replacements.forEach((triangle, i) => this.addTriangle(triangle, i < faces.length ? faces[i] : this.triangles.length));
  }

  splitEdge(key: string, existingPoint?: number): void {
    const edge = this.edges.get(key);
    if (!edge) throw new Error('Invalid boundary mesh: a constrained edge is missing.');
    const { a, b } = edge, faces = [...edge.faces];
    const p = existingPoint ?? this.points.length;
    if (existingPoint === undefined) {
      if (this.points.length >= MAX_TRIANGLES) throw capError();
      this.points.push([(this.points[a][0] + this.points[b][0]) / 2, (this.points[a][1] + this.points[b][1]) / 2]);
    }
    const replacements: Triangle[] = [];
    for (const face of faces) {
      const c = this.triangles[face].find(i => i !== a && i !== b)!;
      replacements.push([a, p, c], [p, b, c]);
    }
    this.replace(faces, replacements);
  }
}

/** Strict incircle test, with a scale-aware roundoff bound to avoid flip cycles. */
function inCircumcircle(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const ax = a[0] - d[0], ay = a[1] - d[1], bx = b[0] - d[0], by = b[1] - d[1], cx = c[0] - d[0], cy = c[1] - d[1];
  const x = (ax * ax + ay * ay) * (bx * cy - by * cx);
  const y = (bx * bx + by * by) * (cx * ay - cy * ax);
  const z = (cx * cx + cy * cy) * (ax * by - ay * bx);
  return x + y + z > 64 * Number.EPSILON * (Math.abs(x) + Math.abs(y) + Math.abs(z));
}

/** Lawson flips improve angles without changing any boundary segment. */
function improveDelaunay(mesh: TriangleMesh, startingEdges?: string[]): void {
  const queue = startingEdges ?? [...mesh.edges.keys()];
  const workCap = Math.max(10000, mesh.triangles.length * 150);
  for (let head = 0; head < queue.length; head++) {
    if (head > workCap) throw new Error('Boundary mesh edge improvement exceeded its resource cap.');
    const edge = mesh.edges.get(queue[head]);
    if (!edge || edge.faces.length !== 2) continue;
    let { a, b } = edge;
    const [f0, f1] = edge.faces;
    const c = mesh.triangles[f0].find(i => i !== a && i !== b)!;
    const d = mesh.triangles[f1].find(i => i !== a && i !== b)!;
    if (orient(mesh.points[a], mesh.points[b], mesh.points[c]) < 0) [a, b] = [b, a];
    if (!positive(mesh.points[c], mesh.points[d], mesh.points[b]) || !positive(mesh.points[d], mesh.points[c], mesh.points[a])) continue;
    if (mesh.edges.has(edgeKey(c, d)) || !inCircumcircle(mesh.points[a], mesh.points[b], mesh.points[c], mesh.points[d])) continue;
    const replacements: Triangle[] = [[c, d, b], [d, c, a]];
    mesh.replace([f0, f1], replacements);
    for (const t of replacements) for (let i = 0; i < 3; i++) queue.push(edgeKey(t[i], t[(i + 1) % 3]));
  }
}

/**
 * Seed the interior before bisecting a curved earcut fan. Its skinny boundary
 * ears have circumcentres in the body interior; splitting their chords first
 * would instead introduce fixed layers of almost-collinear interior points.
 * Point location in the existing constrained mesh also prevents insertion in
 * holes or outside a concave outline.
 */
function seedInteriorPoints(mesh: TriangleMesh): void {
  const candidates: Vec2[] = [], seen = new Set<string>();
  for (const t of mesh.triangles) {
    const [a, b, c] = t.map(i => mesh.points[i]);
    const longest = Math.max(distanceSq(a, b), distanceSq(b, c), distanceSq(c, a));
    if (longest <= 5 * orient(a, b, c)) continue;
    const bx = b[0] - a[0], by = b[1] - a[1], cx = c[0] - a[0], cy = c[1] - a[1];
    const denominator = 2 * (bx * cy - by * cx), bl = bx * bx + by * by, cl = cx * cx + cy * cy;
    const p: Vec2 = [a[0] + (cy * bl - by * cl) / denominator, a[1] + (bx * cl - cx * bl) / denominator];
    if (!p.every(Number.isFinite) || p.some(v => v < 0 || v > 1)) continue;
    const key = `${Math.round(p[0] / COORD_TOL)}:${Math.round(p[1] / COORD_TOL)}`;
    if (!seen.has(key)) { seen.add(key); candidates.push(p); }
  }
  let locationWork = 0;
  for (const p of candidates) {
    if (mesh.triangles.length + 2 > MAX_TRIANGLES) return;
    for (let f = 0; f < mesh.triangles.length; f++) {
      if (++locationWork > MAX_INTERSECTION_CHECKS * 2) return;
      const t = mesh.triangles[f];
      const sides = t.map((v, i) => orient(mesh.points[v], mesh.points[t[(i + 1) % 3]], p));
      if (sides.some((v, i) => v < -orientRoundoff(mesh.points[t[i]], mesh.points[t[(i + 1) % 3]], p))) continue;
      if (t.some(i => distanceSq(mesh.points[i], p) <= COORD_TOL ** 2)) break;
      const oldCount = mesh.triangles.length;
      const edgeIndex = sides.findIndex((v, i) => Math.abs(v) <= orientRoundoff(mesh.points[t[i]], mesh.points[t[(i + 1) % 3]], p));
      let affected: number[];
      if (edgeIndex >= 0) {
        const key = edgeKey(t[edgeIndex], t[(edgeIndex + 1) % 3]), edge = mesh.edges.get(key)!;
        // Never seed a point on an original material boundary for shape alone.
        if (edge.faces.length === 1) break;
        affected = [...edge.faces];
        mesh.points.push(p);
        mesh.splitEdge(key, mesh.points.length - 1);
      } else {
        const index = mesh.points.length;
        mesh.points.push(p);
        mesh.replace([f], [[t[0], t[1], index], [t[1], t[2], index], [t[2], t[0], index]]);
        affected = [f];
      }
      for (let i = oldCount; i < mesh.triangles.length; i++) affected.push(i);
      improveDelaunay(mesh, affected.flatMap(i => mesh.triangles[i].map((v, j, t) => edgeKey(v, t[(j + 1) % 3]))));
      break;
    }
  }
}

function restoreBoundaryVertices(mesh: TriangleMesh, ringIds: number[][]): void {
  const used = new Set(mesh.triangles.flat());
  for (const ring of ringIds) {
    const start = ring.findIndex(i => used.has(i));
    if (start < 0) throw new Error('Invalid boundary mesh: a hole or outline ring disappeared.');
    let a = ring[start];
    for (let step = 1; step <= ring.length;) {
      const missing: number[] = [];
      while (!used.has(ring[(start + step) % ring.length])) {
        missing.push(ring[(start + step) % ring.length]);
        step++;
      }
      const b = ring[(start + step) % ring.length];
      for (const p of missing) {
        mesh.splitEdge(edgeKey(a, b), p);
        used.add(p);
        a = p;
      }
      a = b;
      step++;
    }
  }
  const boundary = new Set<string>();
  for (const ring of ringIds) for (let i = 0; i < ring.length; i++) {
    const key = edgeKey(ring[i], ring[(i + 1) % ring.length]);
    boundary.add(key);
    if (mesh.edges.get(key)?.faces.length !== 1) throw new Error('Invalid boundary mesh: triangulation did not preserve a boundary segment.');
  }
  for (const [key, edge] of mesh.edges) if (edge.faces.length === 1 && !boundary.has(key)) throw new Error('Invalid boundary mesh: triangulation left an interior crack.');
}

/** Move only free interior vertices, accepting strictly better local shapes. */
function smoothInterior(mesh: TriangleMesh): void {
  const boundary = new Set<number>(), neighbors = mesh.points.map(() => [] as number[]), faces = mesh.points.map(() => [] as number[]);
  for (const edge of mesh.edges.values()) {
    neighbors[edge.a].push(edge.b);
    neighbors[edge.b].push(edge.a);
    if (edge.faces.length === 1) { boundary.add(edge.a); boundary.add(edge.b); }
  }
  mesh.triangles.forEach((t, f) => t.forEach(i => faces[i].push(f)));
  const quality = (star: number[]): number => {
    let worst = Infinity;
    for (const f of star) {
      const [a, b, c] = mesh.triangles[f].map(i => mesh.points[i]);
      if (!positive(a, b, c)) return -Infinity;
      worst = Math.min(worst, orient(a, b, c) / (distanceSq(a, b) + distanceSq(b, c) + distanceSq(c, a)));
    }
    return worst;
  };
  for (let pass = 0; pass < 3; pass++) for (let v = 0; v < mesh.points.length; v++) {
    if (boundary.has(v) || neighbors[v].length === 0) continue;
    const old = mesh.points[v], average: Vec2 = [0, 0];
    for (const n of neighbors[v]) { average[0] += mesh.points[n][0] / neighbors[v].length; average[1] += mesh.points[n][1] / neighbors[v].length; }
    let best = old, bestQuality = quality(faces[v]);
    for (const step of [1, 0.5, 0.25]) {
      const candidate: Vec2 = [old[0] + (average[0] - old[0]) * step, old[1] + (average[1] - old[1]) * step];
      mesh.points[v] = candidate;
      const nextQuality = quality(faces[v]);
      if (nextQuality > bestQuality * (1 + 1e-6)) { best = candidate; bestQuality = nextQuality; }
    }
    mesh.points[v] = best;
  }
}

function refine(mesh: TriangleMesh, ringIds: number[][], edgeLimit: number, area: number): void {
  const limitSq = edgeLimit * edgeLimit;
  // Acute material corners impose an unavoidable small angle. Refining those
  // corners for shape alone cannot remove it and would create unlimited nodes.
  const acute = new Set<number>();
  for (const ring of ringIds) for (let i = 0; i < ring.length; i++) {
    const a = mesh.points[ring[(i + ring.length - 1) % ring.length]], b = mesh.points[ring[i]], c = mesh.points[ring[(i + 1) % ring.length]];
    const turn = Math.atan2(orient(a, b, c), (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]));
    if (Math.PI - turn < Math.PI / 9) acute.add(ring[i]);
  }
  const idealCount = area / (Math.sqrt(3) * limitSq / 4);
  if (idealCount > MAX_TRIANGLES) throw capError();
  const qualityBudget = Math.min(MAX_TRIANGLES, Math.max(mesh.triangles.length * 10, idealCount * 6));
  for (let round = 0; round < 40; round++) {
    const split = new Set<string>();
    let nextCount = mesh.triangles.length;
    for (const [key, edge] of mesh.edges) {
      if (distanceSq(mesh.points[edge.a], mesh.points[edge.b]) > limitSq * (1 + 1e-12)) {
        split.add(key);
        nextCount += edge.faces.length;
      }
    }
    if (nextCount > MAX_TRIANGLES) throw capError();
    for (const key of split) mesh.splitEdge(key);
    if (split.size > 0) improveDelaunay(mesh);
    if (round < 12) { smoothInterior(mesh); improveDelaunay(mesh); }
    let improved = false;
    // Shape refinement is adaptive: update local Delaunay topology after EACH
    // insertion. Splitting a whole fan simultaneously would retain every ray
    // and create concentric layers with ever-smaller angles at their centre.
    // Boundary edges are split for size only, allowing thin CAD ligaments to
    // retain their necessary anisotropy instead of refining without a bound.
    const faceCount = mesh.triangles.length;
    if (round < 12) for (let f = 0; f < faceCount; f++) {
      const t = mesh.triangles[f];
      if (t.some(i => acute.has(i))) continue;
      const lengths = t.map((v, i) => distanceSq(mesh.points[v], mesh.points[t[(i + 1) % 3]]));
      const longest = Math.max(...lengths), shortest = Math.min(...lengths);
      const area2 = orient(mesh.points[t[0]], mesh.points[t[1]], mesh.points[t[2]]);
      if (longest <= shortest * 9 && longest <= area2 * 5) continue;
      const i = lengths.indexOf(longest), key = edgeKey(t[i], t[(i + 1) % 3]), edge = mesh.edges.get(key)!;
      if (edge.faces.length === 2 && mesh.triangles.length + 2 <= qualityBudget) {
        const affected = [...edge.faces], oldCount = mesh.triangles.length;
        mesh.splitEdge(key);
        for (let i = oldCount; i < mesh.triangles.length; i++) affected.push(i);
        improveDelaunay(mesh, affected.flatMap(i => mesh.triangles[i].map((v, j, t) => edgeKey(v, t[(j + 1) % 3]))));
        improved = true;
      }
    }
    // Smoothing and flips can lengthen an edge after the size pass. Test the
    // final topology, rather than the pre-smoothing split list, before exiting.
    if (split.size === 0 && !improved && [...mesh.edges.values()].every(edge =>
      distanceSq(mesh.points[edge.a], mesh.points[edge.b]) <= limitSq * (1 + 1e-12))) return;
  }
  throw new Error('Boundary mesh refinement exceeded its resource cap. Increase the element size.');
}

/**
 * Mesh a simple planar outline and disjoint strictly interior holes. Curves
 * are represented by their supplied CAD polylines, without rasterization.
 * Every triangle becomes three convex Q4s using shared edge midpoints and a
 * centroid. Returned nodes/connectivity are ready for shell solve or extrusion.
 */
export function meshBoundaryQuads(outline: PolygonOutline, sizeMm: number): BoundaryQuadMesh {
  if (!(Number.isFinite(sizeMm) && sizeMm > 0)) throw new Error('Boundary mesh size must be positive and finite.');
  if (!outline || !Array.isArray(outline.outer) || !Array.isArray(outline.holes)) throw new Error('Invalid boundary outline.');
  const inputRings = [outline.outer, ...outline.holes];
  if (inputRings.reduce((sum, ring) => sum + (Array.isArray(ring) ? ring.length : 0), 0) > MAX_BOUNDARY_VERTICES) throw capError();
  const originalRings = inputRings.map(input => {
    if (!Array.isArray(input)) throw new Error('Invalid boundary ring.');
    const ring = input.map(p => {
      if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite)) throw new Error('Boundary coordinates must be finite two-dimensional points.');
      return [...p] as Vec2;
    });
    if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
    if (ring.length < 3) throw new Error('Invalid boundary: every ring needs at least three vertices.');
    return ring;
  });
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of originalRings) for (const [x, y] of ring) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  const scale = Math.max(maxX - minX, maxY - minY);
  if (!(Number.isFinite(scale) && scale > 0)) throw new Error('Invalid boundary: coordinate extent is degenerate or nonfinite.');
  const rings = originalRings.map(ring => ring.map(([x, y]): Vec2 => [(x - minX) / scale, (y - minY) / scale]));
  validateRings(rings);
  // Keep material on the left of every ring for corner classification. Reverse
  // copies together so exact input coordinates remain paired with their IDs.
  rings.forEach((ring, i) => {
    if ((ringArea(ring) > 0) !== (i === 0)) { ring.reverse(); originalRings[i].reverse(); }
  });
  const area = rings.reduce((sum, ring) => sum + ringArea(ring), 0);
  if (!(area > 1e-18)) throw new Error('Invalid boundary: holes leave no material area.');
  const edgeLimit = 2 * sizeMm / scale;
  if (area / (Math.sqrt(3) * edgeLimit * edgeLimit / 4) > MAX_TRIANGLES) throw capError();
  const points: Vec2[] = [], ringIds: number[][] = [];
  for (const ring of rings) ringIds.push(ring.map(p => { points.push(p); return points.length - 1; }));
  const originalPoints = originalRings.flat();
  const vectorRings = rings.map(ring => ring.map(p => new Vector2(p[0], p[1])));
  const mesh = new TriangleMesh(points);
  for (const triangle of ShapeUtils.triangulateShape(vectorRings[0], vectorRings.slice(1))) mesh.addTriangle(triangle as Triangle);
  if (mesh.triangles.length === 0) throw new Error('Invalid boundary: triangulation produced no material cells.');
  restoreBoundaryVertices(mesh, ringIds);
  improveDelaunay(mesh);
  seedInteriorPoints(mesh);
  refine(mesh, ringIds, edgeLimit, area);
  const meshedArea = mesh.triangles.reduce((sum, t) => sum + orient(points[t[0]], points[t[1]], points[t[2]]) / 2, 0);
  if (Math.abs(meshedArea - area) > Math.max(1e-13, area * 1e-9)) throw new Error('Invalid boundary mesh: triangulation changed the material area.');

  // Restore original CAD coordinates verbatim; newly inserted coordinates use
  // the same affine frame. Each undirected edge receives exactly one midpoint.
  const uv: Vec2[] = points.map((p, i) => i < originalPoints.length ? [...originalPoints[i]] : [minX + p[0] * scale, minY + p[1] * scale]);
  const midpoints = new Map<string, number>();
  for (const [key, edge] of mesh.edges) {
    const a = uv[edge.a], b = uv[edge.b];
    midpoints.set(key, uv.length);
    uv.push([a[0] + (b[0] - a[0]) / 2, a[1] + (b[1] - a[1]) / 2]);
  }
  const quads: Quad[] = [];
  for (const [a, b, c] of mesh.triangles) {
    const center = uv.length, pa = uv[a], pb = uv[b], pc = uv[c];
    uv.push([pa[0] + ((pb[0] - pa[0]) + (pc[0] - pa[0])) / 3, pa[1] + ((pb[1] - pa[1]) + (pc[1] - pa[1])) / 3]);
    const ab = midpoints.get(edgeKey(a, b))!, bc = midpoints.get(edgeKey(b, c))!, ca = midpoints.get(edgeKey(c, a))!;
    const cells: Quad[] = [[a, ab, center, ca], [b, bc, center, ab], [c, ca, center, bc]];
    for (const q of cells) {
      for (let i = 0; i < 4; i++) if (!positive(uv[q[(i + 3) % 4]], uv[q[i]], uv[q[(i + 1) % 4]])) throw new Error('Invalid boundary mesh: a quadrilateral has a nonpositive corner Jacobian.');
      quads.push(q);
    }
  }
  return { uv, quads };
}
