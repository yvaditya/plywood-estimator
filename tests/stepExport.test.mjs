// Run with: node --test tests/stepExport.test.mjs (uses the real OCCT importer).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from '../app/node_modules/esbuild/lib/main.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const outfile = resolve(root, 'tests/_output/stepExport_test.mjs');
await build({ entryPoints: [resolve(root, 'app/src/stepExport.ts')], bundle: true,
  format: 'esm', platform: 'node', outfile, logLevel: 'silent' });
const exporter = await import(pathToFileURL(outfile).href);
const require = createRequire(new URL('../app/package.json', import.meta.url));
const occt = await require('occt-import-js')();
const date = '2026-10-05T12:00:00.000Z';
const rectangle = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]];
const panel = (overrides = {}) => ({ name: 'Panel', outer: rectangle(100, 50), holes: [], thickness: 18,
  origin: [0, 0, 0], uAxis: [1, 0, 0], vAxis: [0, 1, 0], normal: [0, 0, 1], ...overrides });

function assembly(parts, name) {
  assert.equal(typeof exporter.buildAssemblyStep, 'function', 'placed assembly export is available');
  return exporter.buildAssemblyStep(parts, date, name);
}
function readStep(step) {
  const model = occt.ReadStepFile(new TextEncoder().encode(step), {
    linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: .01, angularDeflection: .1,
  });
  assert.equal(model.success, true, 'OCCT imports the generated STEP');
  return model;
}
function close(actual, expected, message = '') {
  assert.ok(Math.abs(actual - expected) <= 1e-4, `${message}: ${actual} != ${expected}`);
}
function bounds(mesh) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const values = mesh.attributes.position.array;
  for (let i = 0; i < values.length; i++) {
    min[i % 3] = Math.min(min[i % 3], values[i]);
    max[i % 3] = Math.max(max[i % 3], values[i]);
  }
  return [min, max];
}
function expectBounds(mesh, expected) {
  const actual = bounds(mesh);
  for (let side = 0; side < 2; side++) for (let axis = 0; axis < 3; axis++)
    close(actual[side][axis], expected[side][axis], `${mesh.name} bound ${side}/${axis}`);
}
function volume(mesh) {
  const p = mesh.attributes.position.array, triangles = mesh.index.array;
  let result = 0;
  for (let i = 0; i < triangles.length; i += 3) {
    const a = triangles[i] * 3, b = triangles[i + 1] * 3, c = triangles[i + 2] * 3;
    result += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      + p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return result / 6;
}

test('assembly round trip keeps three panel orientations, negative positions, and butt contacts', () => {
  const parts = [
    panel({ name: 'Base', origin: [-80, 30, -100] }),
    panel({ name: 'Side', origin: [20, -50, -100], uAxis: [0, 1, 0], vAxis: [0, 0, 1], normal: [1, 0, 0] }),
    panel({ name: 'Back', origin: [-80, 80, -50], uAxis: [1, 0, 0], vAxis: [0, 0, -1], normal: [0, 1, 0] }),
  ];
  const original = structuredClone(parts);
  const model = readStep(assembly(parts));
  assert.equal(model.meshes.length, 3);
  const meshes = { Base: model.meshes[0], Side: model.meshes[1], Back: model.meshes[2] };
  expectBounds(meshes.Base, [[-80, 30, -100], [20, 80, -82]]);
  expectBounds(meshes.Side, [[20, -50, -100], [38, 50, -50]]);
  expectBounds(meshes.Back, [[-80, 80, -100], [20, 98, -50]]);
  close(bounds(meshes.Base)[1][0], bounds(meshes.Side)[0][0], 'side contact remains closed');
  close(bounds(meshes.Base)[1][1], bounds(meshes.Back)[0][1], 'back contact remains closed');
  for (const mesh of model.meshes) close(volume(mesh), 90000, 'outward closed solid volume');
  assert.deepEqual(parts, original, 'export does not mutate its inputs');
});

test('assembly round trip supports a tilted orthonormal frame', () => {
  const part = panel({ outer: rectangle(10, 20), thickness: 5, origin: [-17, -31, -47],
    uAxis: [.6, .8, 0], vAxis: [-.48, .36, .8], normal: [.64, -.48, .6] });
  const model = readStep(assembly([part]));
  assert.equal(model.meshes.length, 1);
  const mesh = model.meshes[0];
  expectBounds(mesh, [[-26.6, -33.4, -47], [-7.8, -15.8, -28]]);
  close(volume(mesh), 1000, 'tilted panel volume');
  const positions = mesh.attributes.position.array;
  for (const [axis, extent] of [[part.uAxis, 10], [part.vAxis, 20], [part.normal, 5]]) {
    const projections = [];
    for (let i = 0; i < positions.length; i += 3)
      projections.push(axis.reduce((sum, value, j) => sum + value * (positions[i + j] - part.origin[j]), 0));
    close(Math.min(...projections), 0, 'local minimum');
    close(Math.max(...projections), extent, 'local maximum');
  }
});

test('assembly round trip preserves a through hole after placement', () => {
  const model = readStep(assembly([panel({ outer: rectangle(100, 80), thickness: 6,
    holes: [[[30, 20], [30, 50], [50, 50], [50, 20]]], origin: [-60, -50, -40],
    uAxis: [0, 1, 0], vAxis: [0, 0, 1], normal: [1, 0, 0] })]));
  assert.equal(model.meshes.length, 1);
  expectBounds(model.meshes[0], [[-60, -50, -40], [-54, 50, 40]]);
  close(volume(model.meshes[0]), 44400, 'hole is removed from the solid');
});

test('legacy round trip retains the original side-by-side layout and metadata', () => {
  const step = exporter.buildStep([
    { name: 'First', outer: [[-20, 3], [80, 3], [80, 53], [-20, 53]], holes: [], thickness: 18 },
    { name: 'Second', outer: rectangle(40, 60), holes: [], thickness: 12 },
  ], date);
  const model = readStep(step);
  assert.equal(model.meshes.length, 2);
  expectBounds(model.meshes[0], [[0, 3, 0], [100, 53, 18]]);
  expectBounds(model.meshes[1], [[150, 0, 0], [190, 60, 12]]);
  close(volume(model.meshes[0]), 90000);
  close(volume(model.meshes[1]), 28800);
  assert.match(step, /FILE_NAME\('unplaced-parts\.step'/);
  assert.equal(model.root.children[0].name, 'unplaced_parts');
});

test('assembly metadata identifies corrected panels and safely quotes user names', () => {
  const step = assembly([panel({ name: "Shelf 'A'\\\nENDSEC;" }), panel({ origin: [200, 0, 0] })], "Cabinet 'one'\\\r\nENDSEC;");
  const model = readStep(step);
  assert.equal(model.meshes.length, 2);
  assert.equal(model.root.children[0].name, "Cabinet 'one'   ENDSEC;");
  assert.match(step, /MANIFOLD_SOLID_BREP\('Shelf ''A''  ENDSEC;',#/);
  assert.match(step, /FILE_DESCRIPTION\(\('Corrected panel assembly/);
  assert.match(step, /FILE_NAME\('corrected-assembly\.step'/);
  assert.equal(readStep(assembly([panel()])).root.children[0].name, 'corrected_assembly');
});

test('assembly rejects invalid frames instead of silently distorting geometry', () => {
  for (const invalid of [
    { origin: [0, Infinity, 0] }, { origin: [0, 0] },
    { uAxis: [2, 0, 0] }, { uAxis: [NaN, 0, 0] },
    { vAxis: [.6, .8, 0] }, { normal: [0, 0, -1] }, { normal: [0, 0, 0] },
  ]) assert.throws(() => assembly([panel(invalid)]), /finite|frame|orthonormal|right-handed/i);
});

test('assembly rejects non-finite, non-positive, and degenerate panel geometry', () => {
  for (const invalid of [
    { thickness: 0 }, { thickness: -1 }, { thickness: NaN }, { thickness: Infinity },
    { outer: [] }, { outer: [[0, 0], [1, 0]] }, { outer: [[0, 0], [1, 0], [2, 0]] },
    { outer: [[0, 0], [100, Infinity], [0, 50]] },
    { outer: [[0, 0], [100, 0], [100, 0], [0, 50]] },
    { holes: [[[10, 10], [10, NaN], [20, 20]]] },
    { holes: [[[10, 10], [20, 10], [30, 10]]] },
  ]) assert.throws(() => assembly([panel(invalid)]), /finite|positive|ring|thickness|geometry/i);
  assert.throws(() => assembly([]), /part|empty|panel/i);
});
