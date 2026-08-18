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
// Emitted once per selectable page size so the chrome scaling (headers, meta
// line, footers, assembly balloons — see cutlistScale in pdf.ts) can be
// compared side by side: the sheet drawing should grow with the page and the
// furniture should stay in proportion to it.
//
// Prereq:  npx --prefix app esbuild app/src/pdf.ts --bundle --format=esm \
//            --platform=node --outfile=tests/_output/pdf_bundle.mjs
// Run:     node tests/cutlist_synthetic.mjs
// Output:  tests/_output/cutlist_synthetic_<paper>.pdf

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Bundle is overridable so the same fixture can be run against a modified
// build (e.g. a pre-fix bundle) to prove a regression check actually catches
// the defect it claims to.
const BUNDLE = process.env.CUTLIST_BUNDLE ?? './_output/pdf_bundle.mjs';
const { buildCutlistPdf, cutlistSnapshotTarget } = await import(BUNDLE);

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
  // (g,h) WIDE THIN drawer-back strips, 685.9 × 63.0 — the real kitchen-job
  // geometry where the horizontal width dim crossed the rotated height value.
  // Above the strip-note threshold (so they take the normal two-dim path) but
  // short enough that the width line's inset lands inside the height value's
  // glyph run: |hy - cy| = |clamp(h*0.18, 8, 16) - h/2| < hTw/2.
  part({
    partId: 'strip1', partName: 'Drawer_back_panel', panelLabel: 'g', color: '#c8b8e8',
    x: 1700, y: 30, w: 686, h: 63, outer: rect(686, 63),
  }),
  part({
    partId: 'strip2', partName: 'Drawer_back_panel', panelLabel: 'h', color: '#e8c8b8',
    x: 1700, y: 130, w: 686, h: 63, outer: rect(686, 63),
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

// 1×1 baseline JPEG standing in for a viewer snapshot. drawCutlistView
// aspect-fits from the declared width/height, not the real pixels, so the
// declared size below is what drives layout — the single pixel just gets
// stretched over the box. Enough to check framing and balloon placement.
const STUB_JPEG =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsL' +
  'DBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwh' +
  'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIA' +
  'AhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQID' +
  'AAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpT' +
  'VFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG' +
  'x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcI' +
  'CQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYk' +
  'NOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOU' +
  'lZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oA' +
  'DAMBAAIRAxEAPwD3+iiigD//2Q==';

/** Assembly view whose balloons sit at fixed fractions of the capture, so
 *  they land in the same relative spots at every page size. */
const view = (shot, ids) => ({
  image: { dataUrl: STUB_JPEG, width: shot.w, height: shot.h },
  labels: ids.map(([fx, fy, text]) => ({ x: fx * shot.w, y: fy * shot.h, text })),
});

const PAPERS = ['cutlist-4-3', 'letter-landscape', 'legal-landscape', 'tabloid-landscape'];

const out = join(here, '_output');
mkdirSync(out, { recursive: true });

for (const cutlistPaper of PAPERS) {
  // The caller sizes its snapshots for the chosen page; mirror that here so
  // the fixture exercises the same aspect the real export produces.
  const shot = cutlistSnapshotTarget(cutlistPaper);
  const opt = {
    sheetW: 2440,
    sheetL: 1220,
    margin: 10,
    kerf: 3,
    units: 'mm',
    jobName: 'Cutlist synthetic fixture',
    cutlistPaper,
    assemblyViews: [{
      front: view(shot, [
        [0.30, 0.28, '1a'], [0.62, 0.34, '1b'], [0.44, 0.55, '1c'],
        [0.70, 0.68, '1d'], [0.26, 0.76, '1e'],
      ]),
      back: view(shot, [
        [0.34, 0.30, '1f'], [0.66, 0.44, '1b'], [0.48, 0.70, '1c'],
      ]),
    }],
  };
  const doc = buildCutlistPdf(result, opt);
  const file = join(out, `${process.env.CUTLIST_TAG ?? 'cutlist_synthetic'}_${cutlistPaper}.pdf`);
  writeFileSync(file, Buffer.from(doc.output('arraybuffer')));
  console.log(`wrote ${file}  (snapshot target ${shot.w}×${shot.h})`);
}
