// Synthetic-fixture check for the Cutlist PDF detail-dim rendering.
//
// Builds a minimal fake NestResult entirely in JS — no browser, no nesting
// run — and renders it through the REAL buildCutlistPdf:
//   (a) plain rectangle          → W/H gap-in-line dims + id
//   (b) L-shaped part            → notch edge dims (one witness-style in the
//                                  free notch space, one forced INSIDE by the
//                                  strip parked in the notch)
//   (c) part with 45° bevel      → aligned edge dim + two 135° angle arcs
//   (d) thin strip (60mm)        → note dimensioning on the centerline
//
// Prereq:  npx --prefix app esbuild app/src/pdf.ts --bundle --format=esm \
//            --platform=node --outfile=tests/_output/pdf_bundle.mjs
// Run:     node tests/cutlist_synthetic.mjs
// Output:  tests/_output/cutlist_synthetic.pdf

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCutlistPdf } from './_output/pdf_bundle.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** Rectangle ring helper (part-local mm). */
const rect = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]];

const part = (over) => ({
  partId: over.partId ?? 'p',
  partName: over.partName ?? 'part',
  instance: 1,
  rotation: 0,
  holes: [],
  separatedAt: 0,
  ...over,
});

// Sheet space: 2440 along x, 1220 along y (sheetW=2440 > sheetL=1220 → no
// display rotation; part coords map straight onto the page).
const parts = [
  // (a) plain rectangle
  part({
    partId: 'rectA', partName: 'side_left', panelLabel: 'a', color: '#8ecae6',
    x: 30, y: 30, w: 800, h: 500, outer: rect(800, 500),
  }),
  // (b) L-shape — notch cut from its top-right: bbox 700 × 600, notch
  // x∈[400,700] y∈[250,600] (local). The strip (d) parks inside the notch
  // so the VERTICAL notch edge's outside space is occupied → inside
  // fallback, while the HORIZONTAL notch edge keeps free space → witness
  // style outside.
  part({
    partId: 'ell', partName: 'base_notched', panelLabel: 'b', color: '#ffb703',
    x: 900, y: 30, w: 700, h: 600,
    outer: [[0, 0], [700, 0], [700, 250], [400, 250], [400, 600], [0, 600]],
  }),
  // (c) 45° bevel on the top-right corner of a 500 × 400 rectangle.
  part({
    partId: 'bevel', partName: 'shelf_beveled', panelLabel: 'c', color: '#90be6d',
    x: 30, y: 600, w: 500, h: 400,
    outer: [[0, 0], [380, 0], [500, 120], [500, 400], [0, 400]],
  }),
  // (d) thin strip, 280 × 60 → ~15pt across at page scale → note dims.
  part({
    partId: 'strip', partName: 'kick_strip', panelLabel: 'd', color: '#f28482',
    x: 1320, y: 400, w: 280, h: 60, outer: rect(280, 60),
  }),
  // (e) small 60 × 40 corner step — its edges are ~10–15pt on the page, too
  // short for inside arrows → exercises the flipped-outside-arrows path.
  part({
    partId: 'stepped', partName: 'divider_stepped', panelLabel: 'e', color: '#b39ddb',
    x: 1700, y: 700, w: 400, h: 300,
    outer: [[0, 0], [340, 0], [340, 40], [400, 40], [400, 300], [0, 300]],
  }),
  // (f) rectangle with a tall HOLE near its left edge (garage-cabinet hinge
  // cutout pattern) — the default left-inset H dim and top-inset W dim both
  // land inside the hole; exercises the material-scan repositioning.
  part({
    partId: 'holed', partName: 'door_hinged', panelLabel: 'f', color: '#80b8c8',
    x: 560, y: 660, w: 500, h: 300, outer: rect(500, 300),
    holes: [[[40, 30], [100, 30], [100, 270], [40, 270]]],
  }),
];

const sheet = {
  index: 1,
  globalIndex: 1,
  sheetW: 2440,
  sheetL: 1220,
  thickness: 18,
  parts,
  usedArea: parts.reduce((s, p) => s + p.w * p.h, 0),
  largestFree: { w: 780, h: 560 },
  cuts: [],
  layoutSignature: 'synthetic',
};

const result = { groups: [{ thickness: 18, sheets: [sheet] }] };

const opt = {
  sheetW: 2440,
  sheetL: 1220,
  margin: 10,
  kerf: 3,
  units: 'mm',
  jobName: 'Cutlist synthetic fixture',
  // 1×1 PNG placeholder standing in for the viewer's exploded snapshot —
  // exercises the assembly page (image box + panel-number legend).
  explodedPng: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
};

const doc = buildCutlistPdf(result, opt);
const out = join(here, '_output');
mkdirSync(out, { recursive: true });
const file = join(out, 'cutlist_synthetic.pdf');
writeFileSync(file, Buffer.from(doc.output('arraybuffer')));
console.log('wrote', file);
