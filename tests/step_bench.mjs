// Benchmark a local STEP with the application's geometry and nesting pipeline.
// node tests/step_bench.mjs "path/to/model.stp" [tries=32]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, basename } from 'node:path';
import { build } from '../app/node_modules/esbuild/lib/main.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../app/package.json', import.meta.url));
const file = process.argv[2];
if (!file) throw new Error('Pass a STEP file path.');
const restarts = Number(process.argv[3] || 32);
const out = resolve(root, 'tests/_output');
mkdirSync(out, { recursive: true });
async function bundle(name) {
  const outfile = resolve(out, `${name}_bench.mjs`);
  await build({ entryPoints: [resolve(root, `app/src/${name}.ts`)], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent' });
  return import(pathToFileURL(outfile).href);
}
const { analyzeBody } = await bundle('geometry');
const { runNest } = await bundle('nest');
const current = await bundle('packRect');
const occt = await require('occt-import-js')();
const model = occt.ReadStepFile(new Uint8Array(readFileSync(file)), {
  linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: .1, angularDeflection: .2,
});
if (!model.success) throw new Error('STEP import failed');
const parts = model.meshes.flatMap((mesh, i) => {
  const a = analyzeBody(mesh);
  return a ? [{ id: `p${i}`, name: mesh.name, thickness: a.thickness, qty: 1,
    grain: 'free', rotation: 'lock', outer: a.outline.outer, holes: a.outline.holes, color: '#888' }] : [];
});
const config = { sheetW: 1219.2, sheetL: 2438.4, margin: 12.7, kerf: 1.8, resolution: 5, restarts };
writeFileSync(resolve(out, 'step_bench_input.json'), JSON.stringify({ name: basename(file), parts, config }, null, 2));
console.log(`${basename(file)}: ${model.meshes.length} bodies, ${parts.length} sheet parts; ${restarts} tries; 48x96 in, 1/2 in margin, 1.8 mm kerf; app default rotation policy; cut metrics exclude reference trims`);
const metrics = (sheets, unplaced, ms) => {
  let settings = 0, cuts = 0, repeated = 0, remnant = 0, separated = 0;
  let fullLengthRips = 0, ripSettings = 0, repeatedRips = 0;
  for (const sh of sheets) {
    const rip = current.longRipStats(sh.cuts);
    fullLengthRips += rip.rips; ripSettings += rip.settings; repeatedRips += rip.repeated;
    const root = sh.cuts[0];
    if (root) separated += current.countFreedParts(sh.cuts, sh.parts ?? sh.placements,
      root.parentW, root.parentH, root.parentX, root.parentY);
    else if ((sh.parts ?? sh.placements).length === 1) separated++;
    const seen = [];
    for (let i = 0; i < sh.cuts.length; i++) {
      const c = sh.cuts[i]; cuts++;
      if (!seen.some(s => s.axis === c.axis && Math.abs(s.distance - c.distance) <= .01)) { settings++; seen.push(c); }
      if (i && c.axis === sh.cuts[i-1].axis && Math.abs(c.distance - sh.cuts[i-1].distance) <= .01) repeated++;
    }
    if (sh.largestFree) {
      const f = sh.largestFree, short = Math.min(f.w, f.h);
      remnant = Math.max(remnant, short * Math.min(Math.max(f.w, f.h), 4 * short));
    }
  }
  return { sheets: sheets.length, unplaced, settings, cuts, repeated, separated,
    fullLengthRips, ripSettings, repeatedRips,
    usableOffcutM2: +(remnant / 1e6).toFixed(3), ms: Math.round(ms) };
};
const rows = [];
for (const strategy of ['free', 'guillotine', 'repeated', 'cnc']) {
  const start = performance.now();
  const result = runNest(parts, { ...config, cutStrategy: strategy });
  const row = { version: 'updated', strategy, ...metrics(result.groups.flatMap(g => g.sheets), result.groups.reduce((n, g) => n + g.unplaced.length, 0), performance.now() - start) };
  rows.push(row); console.log(JSON.stringify(row));
  writeFileSync(resolve(out, `step_bench_${strategy}.json`), JSON.stringify(result));
}
// Optional saved baseline bundle, created before editing packRect.ts.
try {
  const baseline = await import(pathToFileURL(resolve(out, 'packrect_baseline.mjs')).href);
  for (const strategy of ['free', 'guillotine']) {
    const start = performance.now(), sheets = [];
    let unplaced = 0;
    for (const thickness of [...new Set(parts.map(p => Math.round(p.thickness * 2) / 2))]) {
      const items = parts.filter(p => Math.round(p.thickness * 2) / 2 === thickness).map(p => ({ id: p.id,
        w: Math.max(...p.outer.map(v => v[0])) - Math.min(...p.outer.map(v => v[0])),
        h: Math.max(...p.outer.map(v => v[1])) - Math.min(...p.outer.map(v => v[1])), allowRotate: strategy !== 'free' }));
      const result = baseline.packMulti({ items, sheetW: config.sheetL - 2 * config.margin,
        sheetH: config.sheetW - 2 * config.margin, kerf: config.kerf, cutStrategy: strategy }, restarts);
      sheets.push(...result.sheets); unplaced += result.unplaced.length;
    }
    const row = { version: 'baseline', strategy, ...metrics(sheets, unplaced, performance.now() - start) };
    rows.push(row); console.log(JSON.stringify(row));
  }
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}
writeFileSync(resolve(out, 'step_bench_summary.json'), JSON.stringify({ model: basename(file), config, rows }, null, 2));
