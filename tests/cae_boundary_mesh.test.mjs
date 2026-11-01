import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { build } from '../app/node_modules/esbuild/lib/main.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(root, 'app/src/caeBoundaryMesh.ts');
assert.ok(existsSync(source), 'The boundary-conforming quadrilateral mesher is not implemented');
const outfile = resolve(root, 'tests/_output/cae_boundary_mesh_test.mjs');
await build({ entryPoints: [source], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent' });
const { meshBoundaryQuads } = await import(pathToFileURL(outfile));

const outline = (outer, holes = []) => ({ outer, holes, bbox: { w: 140, h: 140 }, area: 0 });
const circle = (radius, count, cx = radius, cy = radius) => Array.from({ length: count }, (_, i) => {
  const angle = 2 * Math.PI * i / count;
  return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
});
const key = (a, b) => a < b ? `${a}:${b}` : `${b}:${a}`;
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function onSegment(p, a, b) {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return Math.abs(cross(a, b, p)) <= 1e-7 * length
    && (p[0] - a[0]) * (p[0] - b[0]) + (p[1] - a[1]) * (p[1] - b[1]) <= 1e-7;
}
function inRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

// These checks catch an unshared midpoint, a filled hole, an inverted cell,
// a discarded CAD vertex, and an internal crack independently of triangulation.
function checkMesh(mesh, shape, expectedArea, sizeMm) {
  const { uv, quads } = mesh;
  assert.ok(quads.length > 0);
  const edges = new Map(), used = new Set();
  let area = 0, maxEdge = 0, minCornerSine = 1;
  for (const q of quads) {
    assert.equal(new Set(q).size, 4);
    const points = q.map(i => {
      assert.ok(Number.isInteger(i) && i >= 0 && i < uv.length);
      used.add(i);
      assert.ok(uv[i].every(Number.isFinite));
      return uv[i];
    });
    area += (cross(points[0], points[1], points[2]) + cross(points[0], points[2], points[3])) / 2;
    for (let i = 0; i < 4; i++) {
      const a = points[(i + 3) % 4], b = points[i], c = points[(i + 1) % 4];
      // A bilinear Q4 Jacobian is affine in natural coordinates, so positivity
      // at all four corners also covers its interior and Gauss points.
      const jacobian4 = cross(a, b, c);
      assert.ok(jacobian4 > 0, `Nonpositive Q4 corner Jacobian: ${jacobian4}`);
      minCornerSine = Math.min(minCornerSine, jacobian4 / (Math.hypot(a[0] - b[0], a[1] - b[1]) * Math.hypot(c[0] - b[0], c[1] - b[1])));
      maxEdge = Math.max(maxEdge, Math.hypot(c[0] - b[0], c[1] - b[1]));
      const k = key(q[i], q[(i + 1) % 4]);
      const edge = edges.get(k) ?? { a: q[i], b: q[(i + 1) % 4], count: 0, direction: 0 };
      edge.count++;
      edge.direction += q[i] < q[(i + 1) % 4] ? 1 : -1;
      edges.set(k, edge);
    }
    for (const u of [0.05, 0.5, 0.95]) for (const v of [0.05, 0.5, 0.95]) {
      const weights = [(1 - u) * (1 - v), u * (1 - v), u * v, (1 - u) * v];
      const p = [0, 1].map(d => points.reduce((sum, point, i) => sum + weights[i] * point[d], 0));
      assert.ok(inRing(p, shape.outer), 'A cell sample lies outside the outline');
      for (const hole of shape.holes) assert.ok(!inRing(p, hole), 'A cell sample fills a hole');
    }
  }
  assert.equal(used.size, uv.length, 'Orphan nodes must not enter the solver');
  assert.ok(Math.abs(area - expectedArea) < Math.max(1e-7, expectedArea * 1e-10), `Area ${area} instead of ${expectedArea}`);
  assert.ok(maxEdge <= sizeMm * (1 + 1e-10), `Edge ${maxEdge} exceeds size ${sizeMm}`);
  const rings = [shape.outer, ...shape.holes];
  const boundary = new Map();
  for (const edge of edges.values()) {
    assert.ok(edge.count === 1 || edge.count === 2, 'Non-manifold edge');
    if (edge.count === 2) assert.equal(edge.direction, 0, 'Shared faces have inconsistent winding');
    else {
      assert.ok(rings.some(r => r.some((p, i) => onSegment(uv[edge.a], p, r[(i + 1) % r.length]) && onSegment(uv[edge.b], p, r[(i + 1) % r.length]))), 'An unpaired interior edge is a crack or hanging node');
      for (const [a, b] of [[edge.a, edge.b], [edge.b, edge.a]]) {
        const neighbors = boundary.get(a) ?? [];
        neighbors.push(b);
        boundary.set(a, neighbors);
      }
    }
  }
  for (const neighbors of boundary.values()) assert.equal(neighbors.length, 2, 'A boundary must form a closed loop');
  const seen = new Set();
  let loops = 0;
  for (const vertex of boundary.keys()) {
    if (seen.has(vertex)) continue;
    loops++;
    const pending = [vertex];
    while (pending.length) {
      const current = pending.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      pending.push(...boundary.get(current));
    }
  }
  assert.equal(loops, rings.length);
  assert.equal(uv.length - edges.size + quads.length, 1 - shape.holes.length, 'Euler characteristic must preserve all holes');
  for (const ring of rings) for (const p of ring) assert.ok(uv.some(q => q[0] === p[0] && q[1] === p[1]), `Lost boundary vertex ${p}`);
  return { maxEdge, minCornerSine };
}

test('a circular polyline produces positive conforming quads with its exact area', () => {
  const shape = outline(circle(50, 64));
  checkMesh(meshBoundaryQuads(shape, 12), shape, 64 * 50 ** 2 * Math.sin(2 * Math.PI / 64) / 2, 12);
});

test('an annulus keeps both boundary loops without cells spanning its hole', () => {
  const shape = outline(circle(60, 72, 65, 65), [circle(20, 48, 70, 65).reverse()]);
  const expected = 72 * 60 ** 2 * Math.sin(2 * Math.PI / 72) / 2 - 48 * 20 ** 2 * Math.sin(2 * Math.PI / 48) / 2;
  checkMesh(meshBoundaryQuads(shape, 13), shape, expected, 13);
});

test('a rounded concave notch remains open and the mesh is manifold', () => {
  const arc = Array.from({ length: 17 }, (_, i) => [70 + 30 * Math.cos(-i * Math.PI / 16), 50 + 30 * Math.sin(-i * Math.PI / 16)]);
  const shape = outline([[0, 0], [140, 0], [140, 100], [100, 100], ...arc, [40, 100], [0, 100]]);
  checkMesh(meshBoundaryQuads(shape, 14), shape, 11000 - 16 * 30 ** 2 * Math.sin(Math.PI / 16) / 2, 14);
});

test('reversed and explicitly closed oblique rings retain collinear CAD vertices', () => {
  const ring = [[5, 7], [35, 12], [65, 17], [90, 70], [20, 110]].reverse();
  const shape = outline([...ring, [...ring[0]]]);
  const before = structuredClone(shape);
  checkMesh(meshBoundaryQuads(shape, 18), shape, 5370, 18);
  assert.deepEqual(shape, before, 'Meshing must not mutate imported geometry');
});

test('a finer requested edge size increases resolution and respects the bound', () => {
  const shape = outline(circle(50, 48));
  const coarse = meshBoundaryQuads(shape, 22), fine = meshBoundaryQuads(shape, 7);
  assert.ok(fine.quads.length > coarse.quads.length);
  assert.ok(fine.uv.length > coarse.uv.length);
  const expected = 48 * 50 ** 2 * Math.sin(2 * Math.PI / 48) / 2;
  checkMesh(coarse, shape, expected, 22);
  checkMesh(fine, shape, expected, 7);
});

test('shape smoothing cannot leave an edge longer than the requested size', () => {
  const outer = [[91.119298345875, 50], [66.24063297943452, 58.5237417280363], [59.179557954608555, 63.29888562201861], [53.96897965388236, 82.68748828305019], [33.241693018997495, 94.1880239097386], [17.99024060687386, 78.35817226443615], [4.7231312492502795, 61.159745854464106], [2.777761019878888, 38.36076344859442], [26.91134925415951, 29.545240338652796], [36.67847729138362, 14.874031450207283], [52.86448202938007, 26.408868037209647], [66.00601297828428, 26.81128689253689], [64.41110809376777, 42.43646700460273]];
  const size = 11.296562266070396, mesh = meshBoundaryQuads(outline(outer), size);
  for (const q of mesh.quads) for (let i = 0; i < 4; i++) {
    const a = mesh.uv[q[i]], b = mesh.uv[q[(i + 1) % 4]];
    assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) <= size * (1 + 1e-10));
  }
});

test('a coarse request on a dense circle adds interior nodes instead of keeping a sliver fan', () => {
  const shape = outline(circle(50, 128));
  const mesh = meshBoundaryQuads(shape, 1000);
  const quality = checkMesh(mesh, shape, 128 * 50 ** 2 * Math.sin(2 * Math.PI / 128) / 2, 1000);
  assert.ok(quality.minCornerSine > 0.08, `Poor corner shape: ${quality.minCornerSine}`);
  assert.ok(mesh.uv.length < 10000, 'Boundary grading must not fill the disk with the smallest boundary spacing');
});

test('self intersections, outside holes, touching loops, and nested holes are rejected', () => {
  const square = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const invalid = [
    outline([[0, 0], [100, 100], [0, 100], [100, 0]]),
    outline(square, [[[90, 40], [110, 40], [110, 60], [90, 60]]]),
    outline(square, [[[110, 40], [120, 40], [120, 60], [110, 60]]]),
    outline(square, [[[0, 40], [20, 40], [20, 60], [0, 60]]]),
    outline(square, [[[20, 20], [80, 20], [80, 80], [20, 80]], [[30, 30], [40, 30], [40, 40], [30, 40]]]),
    outline(square, [[[20, 20], [60, 20], [60, 60], [20, 60]], [[40, 40], [80, 40], [80, 80], [40, 80]]]),
    outline([[0, 0], [100, 0], [30, 0], [100, 100], [0, 100]]),
  ];
  for (const shape of invalid) assert.throws(() => meshBoundaryQuads(shape, 10), /invalid|intersect|hole|touch|overlap|degenerate/i);
});

test('nonfinite geometry and sizes are refused before allocating a mesh', () => {
  const shape = outline(circle(50, 32));
  for (const size of [0, -1, NaN, Infinity]) assert.throws(() => meshBoundaryQuads(shape, size), /positive|finite|invalid/i);
  assert.throws(() => meshBoundaryQuads(outline([[0, 0], [Infinity, 0], [0, 1]]), 10), /finite|invalid/i);
  assert.throws(() => meshBoundaryQuads(outline([[0, 0], [1, 0], [2, 0]]), 10), /invalid|degenerate/i);
});

test('an impossibly fine request fails at the resource cap without unbounded refinement', () => {
  assert.throws(() => meshBoundaryQuads(outline(circle(50, 32)), 1e-7), /cap|resource|too many|too fine/i);
});
