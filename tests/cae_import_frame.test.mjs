// Run with: node --test tests/cae_import_frame.test.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { build } from '../app/node_modules/esbuild/lib/main.js';
import ts from '../app/node_modules/typescript/lib/typescript.js';
import * as THREE from '../app/node_modules/three/build/three.module.js';

const root = fileURLToPath(new URL('../', import.meta.url));
async function bundle(name) {
  const outfile = resolve(root, `tests/_output/cae_import_frame_${name}.mjs`);
  await build({ entryPoints: [resolve(root, `app/src/${name}.ts`)], bundle: true,
    format: 'esm', platform: 'node', outfile, logLevel: 'silent' });
  return import(pathToFileURL(outfile).href);
}
const { analyzeBody } = await bundle('geometry');
const { buildAssemblyStep } = await bundle('stepExport');
const { Viewer } = await bundle('viewer');
const require = createRequire(new URL('../app/package.json', import.meta.url));
const occt = await require('occt-import-js')();
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const sub = (a, b) => a.map((value, i) => value - b[i]);
const near = (actual, expected, message, tolerance = 1e-4) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} != ${expected}`);

const circle = (x, y, r, count = 24) => Array.from({ length: count }, (_, i) => {
  const angle = -2 * Math.PI * i / count;
  return [x + r * Math.cos(angle), y + r * Math.sin(angle)];
});
// An asymmetric perimeter with a semicircular end, plus an off-centre hole.
const profile = [[0, 0], [150, 0], ...Array.from({ length: 24 }, (_, i) => {
  const angle = -Math.PI / 2 + Math.PI * (i + 1) / 24;
  return [150 + 50 * Math.cos(angle), 50 + 50 * Math.sin(angle)];
}), [70, 130], [0, 90]];
const part = (overrides = {}) => ({ name: 'Curved board', outer: profile,
  holes: [circle(65, 55, 13)], thickness: 18, origin: [317, -142, 58],
  uAxis: [1, 0, 0], vAxis: [0, 1, 0], normal: [0, 0, 1], ...overrides });
function yaw(frame, degrees) {
  const c = Math.cos(degrees * Math.PI / 180), s = Math.sin(degrees * Math.PI / 180);
  return { ...frame, uAxis: frame.uAxis.map((x, i) => c * x + s * frame.vAxis[i]),
    vAxis: frame.vAxis.map((x, i) => c * x - s * frame.uAxis[i]) };
}
function importPart(source) {
  const step = buildAssemblyStep([source], '2026-10-06T12:00:00.000Z', 'Import frame test');
  const model = occt.ReadStepFile(new TextEncoder().encode(step), {
    linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: .1, angularDeflection: .2,
  });
  assert.equal(model.success, true, 'native OCCT import succeeds');
  assert.equal(model.meshes.length, 1);
  return model.meshes[0];
}
function expectSourceBoundary(analysis, source) {
  assert.ok(analysis, 'source is a sheet good');
  assert.equal(analysis.caeUnsupportedReason, undefined, 'flat extrusion supports CAE');
  const frame = analysis.outlineFrame;
  assert.ok(frame, 'analysis retains the exact outline-to-world frame');
  near(analysis.thickness, source.thickness, 'source thickness');
  for (const axis of [frame.uAxis, frame.vAxis, frame.normal]) near(dot(axis, axis), 1, 'unit frame axis');
  near(dot(frame.uAxis, frame.vAxis), 0, 'orthogonal outline axes');
  near(dot(frame.uAxis, frame.normal), 0, 'outline U lies in source face');
  near(dot(frame.vAxis, frame.normal), 0, 'outline V lies in source face');
  const [u, v] = [frame.uAxis, frame.vAxis];
  const handedNormal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  near(dot(handedNormal, frame.normal), 1, 'solver frame is right handed');
  near(Math.abs(dot(frame.normal, source.normal)), 1, 'source face normal');
  const expectedZ = dot(frame.normal, source.normal) > 0 ? source.thickness : 0;
  const rings = [analysis.outline.outer, ...analysis.outline.holes];
  const sourceRings = [source.outer, ...source.holes];
  assert.equal(rings.length, sourceRings.length, 'every hole is preserved');
  rings.forEach((ring, ringIndex) => {
    const expected = sourceRings[ringIndex];
    assert.equal(ring.length, expected.length, 'the curved boundary retains its source vertices');
    const recovered = ring.map(([x, y]) => {
      const world = frame.origin.map((value, i) => value + x * frame.uAxis[i] + y * frame.vAxis[i]);
      const local = sub(world, source.origin);
      near(dot(local, source.normal), expectedZ, 'outline is on the selected outward face');
      const opposite = local.map((value, i) => value - analysis.thickness * frame.normal[i]);
      near(dot(opposite, source.normal), source.thickness - expectedZ, 'extrusion reaches the opposite source face');
      return [dot(local, source.uAxis), dot(local, source.vAxis)];
    });
    for (const point of expected) {
      const distance = Math.min(...recovered.map(p => Math.hypot(p[0] - point[0], p[1] - point[1])));
      near(distance, 0, 'mapped boundary point agrees with source CAD');
    }
  });
}

test('in-plane rotated curved STEP outline maps back without losing its snap rotation or offset', () => {
  const source = yaw(part(), 23.3);
  expectSourceBoundary(analyzeBody(importPart(source)), source);
});

test('tilted asymmetric STEP outline maps every curved outer and hole point onto its source face', () => {
  const source = yaw(part({ uAxis: [.6, .8, 0], vAxis: [-.48, .36, .8], normal: [.64, -.48, .6] }), 19.7);
  expectSourceBoundary(analyzeBody(importPart(source)), source);
});

test('slight panel tilt retains an exact plane even when its world thickness looks sheet-like', () => {
  const angle = .2 * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  const source = part({ uAxis: [c, 0, s], vAxis: [0, 1, 0], normal: [-s, 0, c] });
  expectSourceBoundary(analyzeBody(importPart(source)), source);
});

test('ordinary rectangular STEP import keeps an exact mapping on each world-axis face', () => {
  const outer = [[0, 0], [240, 0], [240, 100], [0, 100]];
  for (const axes of [
    { uAxis: [1, 0, 0], vAxis: [0, 1, 0], normal: [0, 0, 1] },
    { uAxis: [0, 1, 0], vAxis: [0, 0, 1], normal: [1, 0, 0] },
    { uAxis: [1, 0, 0], vAxis: [0, 0, -1], normal: [0, 1, 0] },
  ]) {
    const source = part({ outer, holes: [], ...axes });
    expectSourceBoundary(analyzeBody(importPart(source)), source);
  }
});

// Run the actual main.ts grain/material adapters without booting the DOM and
// WebGL application. Extract declarations through the TS AST, never a copied
// implementation, and let the real Viewer build the displayed arrow geometry.
const mainSource = ts.createSourceFile('main.ts', readFileSync(resolve(root, 'app/src/main.ts'), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const grainFunctions = new Set(['pushGrainToViewer', 'outlineFrame', 'panelMidFrame', 'asmPanelForBody']);
const grainConstants = new Set(['v3add', 'v3scale']);
const grainAdapters = mainSource.statements.filter(statement =>
  (ts.isFunctionDeclaration(statement) && grainFunctions.has(statement.name?.text))
  || (ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration => grainConstants.has(declaration.name.getText(mainSource)))))
  .map(statement => statement.getText(mainSource)).join('\n');
const createGrainAdapters = new Function('viewer', 'panelLabel', 'bodyMaterial',
  ts.transpileModule(`${grainAdapters}\nreturn { pushGrainToViewer, asmPanelForBody };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText);
function grainHarness() {
  const viewer = Object.assign(Object.create(Viewer.prototype), {
    grainStates: new Map(), grainConfigs: new Map(), grainArrows: new Map(),
    grainGroup: new THREE.Group(), selection: new Set([1]), invalidate() {},
  });
  return { viewer, ...createGrainAdapters(viewer, () => 'Test board', () => ({ eAlong: 10000, eAcross: 1000 })) };
}
function expectDisplayedMaterialAxes(analysis) {
  const { viewer, pushGrainToViewer, asmPanelForBody } = grainHarness();
  for (const grain of ['length', 'width']) {
    const body = { id: 1, grain, analysis };
    pushGrainToViewer(body);
    const solverPanel = asmPanelForBody(body);
    const materialAxis = solverPanel.grainAlongLength ? solverPanel.uAxis : solverPanel.vAxis;
    const arrowGroup = viewer.grainArrows.get(body.id);
    arrowGroup.updateMatrixWorld(true);
    const arrowMesh = arrowGroup.children[0].children[0].children[0];
    const displayedAxis = new THREE.Vector3(1, 0, 0).transformDirection(arrowMesh.matrixWorld).toArray();
    near(dot(displayedAxis, materialAxis), 1, `${grain} arrow follows the solver's stiff material axis`, 1e-10);
    const display = viewer.grainConfigs.get(body.id);
    near(display.length, analysis.outline.bbox.w, 'display length matches material U extent');
    near(display.width, analysis.outline.bbox.h, 'display width matches material V extent');
  }
}

test('rotated rectangular STEP grain arrows and material axes follow the true source edges with matching dimensions', () => {
  const source = yaw(part({ outer: [[0, 0], [240, 0], [240, 100], [0, 100]], holes: [] }), 23.3);
  const analysis = analyzeBody(importPart(source));
  expectDisplayedMaterialAxes(analysis);
  near(Math.abs(dot(analysis.outlineFrame.uAxis, source.uAxis)), 1, 'material U follows source length', 1e-10);
  near(Math.abs(dot(analysis.outlineFrame.vAxis, source.vAxis)), 1, 'material V follows source width', 1e-10);
  near(analysis.outline.bbox.w, 240, 'source length is preserved after auto orientation');
  near(analysis.outline.bbox.h, 100, 'source width is preserved after auto orientation');
});

test('curved and tilted outlines display the same grain frame and dimensions used by assembly analysis', () => {
  const source = yaw(part({ uAxis: [.6, .8, 0], vAxis: [-.48, .36, .8], normal: [.64, -.48, .6] }), 19.7);
  expectDisplayedMaterialAxes(analyzeBody(importPart(source)));
});

test('synthesized rectangles without an imported frame retain their existing grain display', () => {
  const source = part({ outer: [[0, 0], [240, 0], [240, 100], [0, 100]], holes: [] });
  const analysis = analyzeBody(importPart(source));
  delete analysis.outlineFrame;
  expectDisplayedMaterialAxes(analysis);
});

// A closed structured solid, with enough face vertices to represent bends.
function griddedBoard(deform = p => p) {
  const positions = [], indices = [], nx = 4, ny = 2;
  const vertex = (i, j, k) => (k * (ny + 1) + j) * (nx + 1) + i;
  for (let k = 0; k < 2; k++) for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++)
    positions.push(...deform([i * 50, j * 40, k * 18]));
  const quad = (a, b, c, d) => indices.push(a, b, c, a, c, d);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    quad(vertex(i, j, 0), vertex(i, j + 1, 0), vertex(i + 1, j + 1, 0), vertex(i + 1, j, 0));
    quad(vertex(i, j, 1), vertex(i + 1, j, 1), vertex(i + 1, j + 1, 1), vertex(i, j + 1, 1));
  }
  for (let i = 0; i < nx; i++) {
    quad(vertex(i, 0, 0), vertex(i + 1, 0, 0), vertex(i + 1, 0, 1), vertex(i, 0, 1));
    quad(vertex(i, ny, 0), vertex(i, ny, 1), vertex(i + 1, ny, 1), vertex(i + 1, ny, 0));
  }
  for (let j = 0; j < ny; j++) {
    quad(vertex(0, j, 0), vertex(0, j, 1), vertex(0, j + 1, 1), vertex(0, j + 1, 0));
    quad(vertex(nx, j, 0), vertex(nx, j + 1, 0), vertex(nx, j + 1, 1), vertex(nx, j, 1));
  }
  return { name: 'Grid board', brep_faces: [], attributes: { position: { array: positions } }, index: { array: indices } };
}

test('beveled and variable-thickness solids are marked unsupported instead of flattened for CAE', () => {
  for (const deform of [
    ([x, y, z]) => [x + (z ? 4 * (1 - x / 100) : 0), y, z],
    ([x, y, z]) => [x, y, z ? z + x * .015 : z],
  ]) {
    const analysis = analyzeBody(griddedBoard(deform));
    assert.ok(analysis, 'nonuniform board remains available for nesting');
    assert.match(analysis.caeUnsupportedReason ?? '', /planar|constant.thickness|bevel/i,
      'CAE receives an explicit unsupported-geometry reason');
  }
});

test('bent and doubly curved solids are marked unsupported instead of reduced to a face projection', () => {
  for (const deform of [
    ([x, y, z]) => [x, y, z + 3 * Math.sin(Math.PI * x / 200)],
    ([x, y, z]) => [x, y, z + 3 * Math.sin(Math.PI * x / 200) * Math.sin(Math.PI * y / 80)],
  ]) {
    const analysis = analyzeBody(griddedBoard(deform));
    assert.ok(analysis, 'bent sheet is still recognized as sheet-shaped');
    assert.match(analysis.caeUnsupportedReason ?? '', /planar|constant.thickness|curv|bent/i,
      'CAE receives an explicit unsupported-geometry reason');
  }
});

test('incomplete solids are rejected even when their two parallel face areas match', () => {
  const mesh = griddedBoard();
  mesh.index.array.splice(-6);
  const analysis = analyzeBody(mesh);
  assert.ok(analysis);
  assert.match(analysis.caeUnsupportedReason ?? '', /closed|incomplete|missing/i);
});

test('ordinary subdivided constant-thickness source triangles remain eligible for CAE', () => {
  const analysis = analyzeBody(griddedBoard());
  assert.ok(analysis);
  assert.equal(analysis.caeUnsupportedReason, undefined);
  near(analysis.outline.area, 16000, 'flat panel area');
});

test('coplanar STEP face seams do not become holes when each face has separate vertex indices', () => {
  const mesh = griddedBoard();
  const original = mesh.attributes.position.array;
  mesh.attributes.position.array = mesh.index.array.flatMap(index => original.slice(index * 3, index * 3 + 3));
  mesh.index.array = mesh.index.array.map((_, i) => i);
  const analysis = analyzeBody(mesh);
  assert.ok(analysis);
  assert.equal(analysis.caeUnsupportedReason, undefined);
  assert.equal(analysis.outline.holes.length, 0, 'seams between adjacent coplanar faces are internal');
  assert.equal(analysis.outline.outer.length, 4);
  near(analysis.outline.area, 16000, 'all coplanar face pieces form one board outline');
});
