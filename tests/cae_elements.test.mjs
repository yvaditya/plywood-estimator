import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from '../app/node_modules/esbuild/lib/main.js';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const outfile = resolve(root, 'tests/_output/cae_elements_test.mjs');
await build({ entryPoints: [resolve(root, 'app/src/caeElements.ts')], bundle: true,
  format: 'esm', platform: 'node', outfile, logLevel: 'silent' });
const { quadGeometry, quadMembraneK, quadPlateK, extrudedHexK, extrudedHexStrain } =
  await import(pathToFileURL(outfile));

const quads = [
  [[0, 0], [4, 0], [4, 2], [0, 2]],
  [[0, 0], [4, 1], [5, 3], [1, 2]],
  [[-.3, .1], [3.7, -.2], [2.8, 2.4], [.2, 1.7]],
  // A quadrilateral obtained by splitting a triangle at its centroid/midpoints.
  [[0, 0], [2, 0], [4 / 3, 2 / 3], [0, 1]],
];
const gp = [-1 / Math.sqrt(3), 1 / Math.sqrt(3)];
const Dm = [[200, 40, 12], [40, 120, -8], [12, -8, 70]];
const Db = [[18, 3, 1.2], [3, 10, -.8], [1.2, -.8, 6]];
const Ds = [90, 50];
const D3 = [
  [1000, 110, 70, 0, 0, 0], [110, 650, 40, 0, 0, 0], [70, 40, 250, 0, 0, 0],
  [0, 0, 0, 100, 0, 0], [0, 0, 0, 0, 140, 0], [0, 0, 0, 0, 0, 230],
];
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const mul = (A, x) => A.map(row => dot(row, x));
const norm = a => Math.hypot(...a);
const energy = (K, u) => dot(u, mul(K, u)) / 2;
const area = q => q.reduce((s, p, i) => {
  const next = q[(i + 1) % 4]; return s + p[0] * next[1] - p[1] * next[0];
}, 0) / 2;
function near(actual, expected, tol = 2e-10) {
  assert.ok(Math.abs(actual - expected) <= tol * Math.max(1, Math.abs(expected)),
    `expected ${expected}, got ${actual}`);
}
function symmetric(K) {
  const scale = Math.max(...K.flat().map(Math.abs));
  K.forEach((r, i) => r.forEach((v, j) => {
    assert.ok(Number.isFinite(v));
    assert.ok(Math.abs(v - K[j][i]) <= scale * 2e-13);
  }));
}
function rigid(K, u) {
  const scale = Math.max(...K.flat().map(Math.abs));
  assert.ok(norm(mul(K, u)) < scale * norm(u) * 2e-12,
    `rigid motion has residual ${norm(mul(K, u))}`);
}

// A small independent Jacobi eigensolver checks rank without adding a foundation.
function eigenvalues(matrix) {
  const A = matrix.map(row => [...row]);
  const n = A.length;
  const scale = Math.max(...A.flat().map(Math.abs));
  for (let sweep = 0; sweep < 70; sweep++) {
    let max = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      const apq = A[p][q]; max = Math.max(max, Math.abs(apq));
      if (Math.abs(apq) < scale * 1e-15) continue;
      const angle = .5 * Math.atan2(2 * apq, A[q][q] - A[p][p]);
      const c = Math.cos(angle), s = Math.sin(angle);
      const app = A[p][p], aqq = A[q][q];
      A[p][p] = c * c * app - 2 * s * c * apq + s * s * aqq;
      A[q][q] = s * s * app + 2 * s * c * apq + c * c * aqq;
      A[p][q] = A[q][p] = 0;
      for (let r = 0; r < n; r++) if (r !== p && r !== q) {
        const arp = A[r][p], arq = A[r][q];
        A[r][p] = A[p][r] = c * arp - s * arq;
        A[r][q] = A[q][r] = s * arp + c * arq;
      }
    }
    if (max < scale * 1e-13) break;
  }
  return A.map((row, i) => row[i]).sort((a, b) => a - b);
}
function rigidRank(K, nRigid) {
  const eig = eigenvalues(K), max = Math.max(...eig.map(Math.abs));
  assert.equal(eig.filter(v => Math.abs(v) < max * 1e-9).length, nRigid,
    `unexpected zero-energy modes: ${eig}`);
  assert.ok(eig[nRigid] > 0 && eig[0] > -max * 1e-11, `${eig}`);
}

test('Q4 mapping reproduces coordinates and has positive Jacobians at all corners', () => {
  for (const q of quads) for (const xi of [-1, ...gp, 0, 1]) for (const eta of [-1, 0, 1]) {
    const g = quadGeometry(q, xi, eta);
    assert.ok(g.det > 0 && Number.isFinite(g.det));
    near(g.N.reduce((a, b) => a + b, 0), 1);
    near(g.dx.reduce((a, b) => a + b, 0), 0);
    near(g.dy.reduce((a, b) => a + b, 0), 0);
    near(dot(g.dx, q.map(p => p[0])), 1);
    near(dot(g.dx, q.map(p => p[1])), 0);
    near(dot(g.dy, q.map(p => p[0])), 0);
    near(dot(g.dy, q.map(p => p[1])), 1);
  }
  for (const q of quads) {
    const integral = gp.reduce((s, x) => s + gp.reduce((t, y) => t + quadGeometry(q, x, y).det, 0), 0);
    near(integral, area(q));
  }
});

test('element stiffness is invariant to translation and isotropic coordinate rotation', () => {
  const q = quads[1], translated = q.map(([x, y]) => [x + 1e8, y - 2e8]);
  const g = quadGeometry(q, .7, -.6), translatedG = quadGeometry(translated, .7, -.6);
  g.dx.forEach((v, i) => near(translatedG.dx[i], v));
  g.dy.forEach((v, i) => near(translatedG.dy[i], v));
  near(translatedG.det, g.det);
  const c = Math.cos(.713), s = Math.sin(.713);
  const rotate = ([x, y]) => [c * x - s * y, s * x + c * y];
  const distorted = quads[2], rotated = distorted.map(rotate);
  const D2 = [[1, .3, 0], [.3, 1, 0], [0, 0, .35]];
  const D = Array.from({ length: 6 }, (_, i) => Array.from({ length: 6 }, (_, j) =>
    i < 3 && j < 3 ? (i === j ? 700 : 100) : i === j ? 300 : 0));
  const membrane = distorted.flatMap((_, i) => [Math.sin(i), Math.cos(i)]);
  const rotatedMembrane = distorted.flatMap((_, i) => rotate(membrane.slice(i * 2, i * 2 + 2)));
  near(energy(quadMembraneK(rotated, D2), rotatedMembrane), energy(quadMembraneK(distorted, D2), membrane));
  const plate = distorted.flatMap((_, i) => [.3 * Math.sin(i * 1.2), .2 * Math.cos(i), .1 * Math.sin(i)]);
  const rotatedPlate = distorted.flatMap((_, i) => [plate[i * 3], ...rotate(plate.slice(i * 3 + 1, i * 3 + 3))]);
  near(energy(quadPlateK(rotated, D2, [80, 80]), rotatedPlate), energy(quadPlateK(distorted, D2, [80, 80]), plate));
  const solid = Array.from({ length: 24 }, (_, i) => .1 * Math.sin(i * 1.7));
  const rotatedSolid = Array.from({ length: 8 }, (_, i) => [...rotate(solid.slice(i * 3, i * 3 + 2)), solid[i * 3 + 2]]).flat();
  near(energy(extrudedHexK(rotated, .7, D), rotatedSolid), energy(extrudedHexK(distorted, .7, D), solid));
});

test('invalid Q4s are refused even when a folded element has a positive centre Jacobian', () => {
  for (const q of [
    [[0, 0], [0, 1], [1, 1], [1, 0]],
    [[0, 0], [1, 0], [.2, .2], [0, 1]],
    [[0, 0], [1, 1], [1, 0], [0, 1]],
    [[0, 0], [1, 0], [1, 0], [0, 1]],
    [[0, 0], [Infinity, 0], [1, 1], [0, 1]],
  ]) {
    assert.throws(() => quadGeometry(q), /quadrilateral|Jacobian|finite|inverted|convex/i);
    assert.throws(() => quadMembraneK(q, Dm));
    assert.throws(() => quadPlateK(q, Db, Ds));
    assert.throws(() => extrudedHexK(q, 1, D3));
  }
  for (const t of [0, -1, NaN, Infinity]) assert.throws(() => extrudedHexK(quads[0], t, D3), /thickness/i);
});

test('general membrane stiffness is symmetric with exactly three rigid-body modes', () => {
  for (const q of quads) {
    const K = quadMembraneK(q, Dm); symmetric(K); rigidRank(K, 3);
    for (const u of [q.flatMap(() => [1, 0]), q.flatMap(() => [0, 1]), q.flatMap(([x, y]) => [-y, x])]) rigid(K, u);
  }
});

test('general membranes pass the affine strain energy and edge-traction patch tests', () => {
  const eps = [.012, -.003, .024], sigma = mul(Dm, eps);
  for (const q of quads) {
    const u = q.flatMap(([x, y]) => [.012 * x + .005 * y + .1, .019 * x - .003 * y - .3]);
    const K = quadMembraneK(q, Dm);
    near(energy(K, u), area(q) * dot(eps, sigma) / 2);
    const traction = new Array(8).fill(0);
    q.forEach(([x, y], i) => {
      const j = (i + 1) % 4, dx = q[j][0] - x, dy = q[j][1] - y;
      for (const n of [i, j]) {
        traction[2 * n] += (sigma[0] * dy - sigma[2] * dx) / 2;
        traction[2 * n + 1] += (sigma[2] * dy - sigma[1] * dx) / 2;
      }
    });
    mul(K, u).forEach((v, i) => near(v, traction[i]));
  }
});

test('MITC4 plates are symmetric with exactly three rigid-body modes, without hourglass stiffness', () => {
  for (const q of quads) {
    const K = quadPlateK(q, Db, Ds); symmetric(K); rigidRank(K, 3);
    for (const u of [q.flatMap(() => [1, 0, 0]), q.flatMap(([x]) => [x, 0, -1]), q.flatMap(([, y]) => [y, 1, 0])]) rigid(K, u);
  }
});

test('MITC4 covariant shear interpolation reproduces constant physical shear on distorted quads', () => {
  for (const q of quads) {
    const u = q.flatMap(([x, y]) => [.02 * x - .03 * y, .013, .015]);
    const expected = area(q) * (Ds[0] * .035 ** 2 + Ds[1] * .043 ** 2) / 2;
    near(energy(quadPlateK(q, Db, Ds), u), expected);
  }
});

test('MITC4 reproduces constant-curvature bending without thin-plate shear locking', () => {
  const k = [.018, -.009, .011];
  for (const q of quads) {
    const u = q.flatMap(([x, y]) => [
      -(k[0] * x * x + k[1] * y * y + k[2] * x * y) / 2,
      -k[1] * y - k[2] * x / 2, k[0] * x + k[2] * y / 2,
    ]);
    const expected = area(q) * dot(k, mul(Db, k)) / 2;
    near(energy(quadPlateK(q, Db, [1e6, 2e6]), u), expected, 3e-8);
  }
});

const hexPoints = (q, t) => [-t / 2, t / 2].flatMap(z => q.map(([x, y]) => [x, y, z]));
test('extruded H8 elements are symmetric with exactly six rigid-body modes', () => {
  for (const q of quads) {
    const t = .7, xyz = hexPoints(q, t), K = extrudedHexK(q, t, D3);
    symmetric(K); rigidRank(K, 6);
    for (const u of [
      ...[0, 1, 2].map(d => xyz.flatMap(() => [0, 1, 2].map(i => +(i === d)))),
      xyz.flatMap(([x, y]) => [-y, x, 0]),
      xyz.flatMap(([x, , z]) => [z, 0, -x]),
      xyz.flatMap(([, y, z]) => [0, -z, y]),
    ]) rigid(K, u);
  }
});

test('extruded H8 enhanced modes preserve every constant-strain component on distorted quads', () => {
  const eps = [.012, -.003, .006, -.005, .014, .024], t = .7;
  for (const q of quads) {
    const u = hexPoints(q, t).flatMap(([x, y, z]) => [
      .012 * x + .005 * y + .010 * z + .1,
      .019 * x - .003 * y - .002 * z - .3,
      .004 * x - .003 * y + .006 * z + .2,
    ]);
    const K = extrudedHexK(q, t, D3);
    near(energy(K, u), area(q) * t * dot(eps, mul(D3, eps)) / 2);
    for (const xi of [0, ...gp]) for (const eta of [0, ...gp]) for (const zeta of [0, ...gp]) {
      extrudedHexStrain(q, t, u, D3, [xi, eta, zeta]).forEach((v, i) => near(v, eps[i]));
    }
    extrudedHexStrain(q, t, u).forEach((v, i) => near(v, eps[i]));
  }
});

test('H8 stress recovery uses the same condensed enhanced strains as the stiffness', () => {
  for (const q of quads) {
    const t = .7, u = Array.from({ length: 24 }, (_, i) => .1 * Math.sin(i * 1.7));
    let integratedEnergy = 0;
    for (const xi of gp) for (const eta of gp) for (const zeta of gp) {
      const eps = extrudedHexStrain(q, t, u, D3, [xi, eta, zeta]);
      integratedEnergy += dot(eps, mul(D3, eps)) * quadGeometry(q, xi, eta).det * t / 4;
    }
    near(integratedEnergy, energy(extrudedHexK(q, t, D3), u));
  }
  assert.throws(() => extrudedHexStrain(quads[0], 1, Array(24).fill(0), undefined, [.5, 0, 0]), /material|constitutive|matrix/i);
});

test('general H8 stiffness matches the existing rectangular incompatible element', async () => {
  const legacyPath = resolve(root, 'tests/_output/cae_elements_reference.mjs');
  await build({ entryPoints: [resolve(root, 'app/src/cae.ts')], bundle: true,
    format: 'esm', platform: 'node', outfile: legacyPath, logLevel: 'silent' });
  const { hexKForTest } = await import(pathToFileURL(legacyPath));
  for (const [a, b, t] of [[4, 2, .7], [30, 40, 1], [.1, .3, .2]]) {
    const actual = extrudedHexK([[0, 0], [a, 0], [a, b], [0, b]], t, D3);
    const expected = hexKForTest(a, b, t, D3);
    const scale = Math.max(...expected.flat().map(Math.abs));
    actual.forEach((row, i) => row.forEach((v, j) => assert.ok(Math.abs(v - expected[i][j]) < 2e-12 * scale)));
  }
});

// Dense reference solve used only by small, independently assembled benchmarks.
function solveReduced(K, rhs, fixed) {
  const free = rhs.map((_, i) => i).filter(i => !fixed.has(i));
  const A = free.map(i => free.map(j => K[i][j]));
  const b = free.map(i => rhs[i]), n = free.length;
  for (let k = 0; k < n; k++) {
    let p = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(A[i][k]) > Math.abs(A[p][k])) p = i;
    assert.ok(Math.abs(A[p][k]) > 1e-16, 'singular benchmark stiffness');
    [A[k], A[p]] = [A[p], A[k]]; [b[k], b[p]] = [b[p], b[k]];
    for (let i = k + 1; i < n; i++) {
      const f = A[i][k] / A[k][k];
      for (let j = k + 1; j < n; j++) A[i][j] -= f * A[k][j];
      b[i] -= f * b[k]; A[i][k] = 0;
    }
  }
  const x = new Array(rhs.length).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let v = b[i];
    for (let j = i + 1; j < n; j++) v -= A[i][j] * x[free[j]];
    x[free[i]] = v / A[i][i];
  }
  return x;
}
function scatter(K, element, indices) {
  element.forEach((row, i) => row.forEach((v, j) => { K[indices[i]][indices[j]] += v; }));
}

function sinusoidalPlate(n, thickness) {
  const nu = .3, bend = [[1, nu, 0], [nu, 1, 0], [0, 0, (1 - nu) / 2]];
  // Scale E so D=1; then S=(5/6)*G*t=5*(1-nu)/t².
  const shear = 5 * (1 - nu) / thickness ** 2;
  const nodes = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const interior = i > 0 && j > 0 && i < n && j < n;
    nodes.push([(i + (interior ? .14 * Math.sin(1.7 * i + .3 * j) : 0)) / n,
      (j + (interior ? .14 * Math.cos(.9 * i + 2.5 * j) : 0)) / n]);
  }
  const dofs = nodes.length * 3, K = Array.from({ length: dofs }, () => Array(dofs).fill(0));
  const rhs = Array(dofs).fill(0), fixed = new Set();
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const node = j * (n + 1) + i;
    if (i === 0 || i === n || j === 0 || j === n) fixed.add(3 * node);
    if (i === 0 || i === n) fixed.add(3 * node + 1);
    if (j === 0 || j === n) fixed.add(3 * node + 2);
  }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const p = j * (n + 1) + i, ids = [p, p + 1, p + n + 2, p + n + 1], q = ids.map(i => nodes[i]);
    scatter(K, quadPlateK(q, bend, [shear, shear]), ids.flatMap(i => [3 * i, 3 * i + 1, 3 * i + 2]));
    for (const xi of gp) for (const eta of gp) {
      const { N, det } = quadGeometry(q, xi, eta);
      const x = dot(N, q.map(p => p[0])), y = dot(N, q.map(p => p[1]));
      const pressure = 4 * Math.PI ** 4 * Math.sin(Math.PI * x) * Math.sin(Math.PI * y);
      ids.forEach((id, k) => { rhs[id * 3] += N[k] * pressure * det; });
    }
  }
  const displacement = solveReduced(K, rhs, fixed);
  const centre = (n / 2) * (n + 1) + n / 2, [x, y] = nodes[centre];
  // Navier's single-sine Mindlin solution, including the transverse shear term.
  const expected = (1 + 2 * Math.PI ** 2 / shear) * Math.sin(Math.PI * x) * Math.sin(Math.PI * y);
  return { value: displacement[3 * centre], expected, error: Math.abs(displacement[3 * centre] / expected - 1) };
}

test('a distorted MITC4 mesh converges to the sinusoidal plate solution and remains accurate as thickness falls', t => {
  const coarse = sinusoidalPlate(4, .01), fine = sinusoidalPlate(8, .01), thin = sinusoidalPlate(8, .001);
  t.diagnostic(`plate relative errors: 4×4=${coarse.error}, 8×8=${fine.error}, thin 8×8=${thin.error}`);
  assert.ok(fine.error < coarse.error * .5);
  assert.ok(fine.error < .035);
  assert.ok(thin.error < .035);
  assert.ok(Math.abs(thin.value / fine.value - 1) < .002);
});

function solidBending(n, distorted) {
  const L = 10, width = 1, thickness = .5, E = 1000, moment = .001;
  const D = Array.from({ length: 6 }, (_, i) => Array.from({ length: 6 }, (_, j) => i === j ? (i < 3 ? E : E / 2) : 0));
  const uv = [];
  for (let i = 0; i <= n; i++) for (let j = 0; j < 2; j++)
    uv.push([i * L / n + (distorted ? (2 * j - 1) * .18 * L / n * Math.sin(Math.PI * i / n) : 0), j * width]);
  const dofs = uv.length * 2 * 3, K = Array.from({ length: dofs }, () => Array(dofs).fill(0));
  const rhs = Array(dofs).fill(0), fixed = new Set();
  for (let i = 0; i < 12; i++) fixed.add(i);
  for (let i = 0; i < n; i++) {
    const ids = [2 * i, 2 * i + 2, 2 * i + 3, 2 * i + 1], q = ids.map(i => uv[i]);
    const hex = [0, 1].flatMap(layer => ids.map(id => id * 2 + layer));
    scatter(K, extrudedHexK(q, thickness, D), hex.flatMap(id => [3 * id, 3 * id + 1, 3 * id + 2]));
  }
  for (const j of [0, 1]) for (const layer of [0, 1]) {
    const id = (2 * n + j) * 2 + layer;
    rhs[id * 3] = (layer === 0 ? 1 : -1) * moment / (2 * thickness);
  }
  const u = solveReduced(K, rhs, fixed);
  const value = [0, 1, 2, 3].reduce((sum, k) => sum + u[((2 * n) * 2 + k) * 3 + 2], 0) / 4;
  const expected = moment * L * L / (2 * E * width * thickness ** 3 / 12);
  return { value, expected, error: Math.abs(value / expected - 1) };
}

test('extruded nonrectangular solid bending converges while rectangular pure bending is exact', t => {
  const rect = solidBending(2, false), coarse = solidBending(4, true);
  const medium = solidBending(8, true), fine = solidBending(16, true);
  t.diagnostic(`solid bending relative errors: rectangle=${rect.error}, 4=${coarse.error}, 8=${medium.error}, 16=${fine.error}`);
  assert.ok(rect.error < 1e-8);
  assert.ok(medium.error < coarse.error);
  assert.ok(fine.error < medium.error);
  assert.ok(fine.error < .035);
});
