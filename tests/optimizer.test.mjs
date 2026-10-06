// Run with: node --test tests/optimizer.test.mjs (no browser or new dependencies).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from '../app/node_modules/esbuild/lib/main.js';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
async function bundle(name) {
  const outfile = resolve(root, `tests/_output/${name}_test.mjs`);
  await build({ entryPoints: [resolve(root, `app/src/${name}.ts`)], bundle: true,
    format: 'esm', platform: 'node', outfile, logLevel: 'silent' });
  return import(pathToFileURL(outfile).href);
}
const rect = await bundle('packRect');
const nest = await bundle('nest');
const cnc = await bundle('cncNest');
const pool = await bundle('optPool');
const instructions = await bundle('instructions');

export function jobFor(seed, strategy = 'free', n = 12) {
  let s = seed;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  return { sheetW: 1200, sheetH: 800, kerf: 3, cutStrategy: strategy,
    items: Array.from({ length: n }, (_, i) => ({ id: String(i),
      w: 50 + Math.floor(rnd() * 650), h: 50 + Math.floor(rnd() * 450), allowRotate: true })) };
}
function rawBest(job, tries = 32) {
  let best;
  for (const t of rect.buildTrialSchedule(job, tries)) {
    const r = rect.packOne(job, t.heur, t.order, t.binKind);
    if (!best || rect.isBetter(r, best, job.cutStrategy)) best = r;
  }
  return best;
}
function legal(job, result) {
  const ids = result.unplaced.map(p => p.id);
  for (const sheet of result.sheets) {
    for (const p of sheet.placements) {
      ids.push(p.id);
      const input = job.items.find(i => i.id === p.id);
      assert.ok(input.allowRotate || !p.rotated);
      assert.ok(Math.abs(p.w - (p.rotated ? input.h : input.w)) < 1e-6);
      assert.ok(Math.abs(p.h - (p.rotated ? input.w : input.h)) < 1e-6);
      assert.ok(p.x >= -1e-6 && p.y >= -1e-6);
      assert.ok(p.x + p.w <= job.sheetW + 1e-6 && p.y + p.h <= job.sheetH + 1e-6);
    }
    for (let i = 0; i < sheet.placements.length; i++) for (let j = i + 1; j < sheet.placements.length; j++) {
      const a = sheet.placements[i], b = sheet.placements[j];
      const gap = Math.max(b.x - a.x - a.w, a.x - b.x - b.w, b.y - a.y - a.h, a.y - b.y - b.h);
      assert.ok(gap >= job.kerf - 1e-6, `kerf clearance ${a.id}/${b.id}: ${gap}`);
    }
    if (rect.isGuillotineStrategy(job.cutStrategy)) {
      assert.equal(sheet.fullySeparated, sheet.placements.length);
      const regions = [{ x: 0, y: 0, w: job.sheetW, h: job.sheetH }];
      for (const c of sheet.cuts) {
        const index = regions.findIndex(r => Math.abs(r.x - c.parentX) < 1e-5 && Math.abs(r.y - c.parentY) < 1e-5
          && Math.abs(r.w - c.parentW) < 1e-5 && Math.abs(r.h - c.parentH) < 1e-5);
        assert.ok(index >= 0, 'each cut acts on stock produced by earlier cuts');
        const r = regions.splice(index, 1)[0];
        assert.ok(c.distance > 0 && c.distance < (c.axis === 'H' ? r.h : r.w));
        for (const p of sheet.placements) {
          const inParent = p.x >= r.x - 1e-5 && p.y >= r.y - 1e-5 && p.x + p.w <= r.x + r.w + 1e-5 && p.y + p.h <= r.y + r.h + 1e-5;
          if (!inParent) continue;
          const start = c.axis === 'H' ? p.y : p.x, end = start + (c.axis === 'H' ? p.h : p.w);
          const line = (c.axis === 'H' ? r.y : r.x) + c.distance;
          assert.ok(line <= start + 1e-5 || line >= end - 1e-5, 'cuts never cross a panel');
        }
        if (c.axis === 'H') regions.push({ ...r, h: c.distance }, { ...r, y: r.y + c.distance, h: r.h - c.distance });
        else regions.push({ ...r, w: c.distance }, { ...r, x: r.x + c.distance, w: r.w - c.distance });
      }
    }
  }
  assert.deepEqual(ids.sort(), job.items.map(i => i.id).sort(), 'every instance occurs exactly once');
}

for (const strategy of ['free', 'guillotine', 'repeated']) {
  test(`${strategy}: finishing preserves the winner and never worsens its objective`, () => {
    for (let seed = 1; seed <= 12; seed++) {
      const job = jobFor(seed, strategy);
      const best = rawBest(job), snapshot = structuredClone(best);
      const result = rect.finishPack(job, best);
      assert.deepEqual(best, snapshot, `finishing mutated search history, seed ${seed}`);
      assert.equal(rect.isBetter(snapshot, result, strategy), false, `finishing regressed, seed ${seed}`);
      legal(job, result);
    }
  });
}

test('floating-point area noise does not override useful offcuts', () => {
  const base = rect.packOne(jobFor(1), 'BSSF', jobFor(1).items);
  const better = structuredClone(base), worse = structuredClone(base);
  better.sheets.forEach(s => { s.largestFree = { w: 600, h: 500 }; });
  worse.sheets.forEach(s => { s.largestFree = { w: 50, h: 500 }; s.usedArea += 1e-8; });
  assert.equal(rect.isBetter(better, worse, 'free'), true);
});

test('sheet order does not affect layout quality', () => {
  const a = rect.packOne(jobFor(7), 'BSSF', jobFor(7).items);
  const b = structuredClone(a); b.sheets.reverse();
  assert.equal(rect.isBetter(a, b), false);
  assert.equal(rect.isBetter(b, a), false);
});

test('sync and animated rectangle searches honor the same seed', async () => {
  const job = jobFor(2);
  const sync = rect.packMulti(job, 48, 7);
  const asyncResult = await rect.packMultiAnimated(job, 48, () => {}, 1000, 7);
  assert.deepEqual(sync, asyncResult);
});

test('invalid dimensions and kerf fail before packing', () => {
  for (const change of [{ sheetW: NaN }, { sheetH: Infinity }, { kerf: -1 }, { kerf: NaN },
    { items: [{ id: 'bad', w: 0, h: 20, allowRotate: false }] }]) {
    assert.throws(() => rect.packMulti({ ...jobFor(1), ...change }, 1), /finite|positive|kerf|dimension/i);
  }
});

test('CNC ranking uses placed area before remnant concentration', () => {
  const a = { unplaced: ['small'], sheets: [{ usedArea: 100 }, { usedArea: 900 }] };
  const b = { unplaced: ['large'], sheets: [{ usedArea: 50 }, { usedArea: 500 }] };
  assert.equal(cnc.serialPassBetter(a, b, true), true);
});

test('Optimize further recognizes same-sheet offcut improvements', () => {
  const sheet = { parts: [], cuts: [], usedArea: 100, fullySeparated: 0, largestFree: { w: 400, h: 500 } };
  const a = { groups: [{ sheets: [sheet], unplaced: [] }], totalSheets: 1, totalPartArea: 100, totalSheetArea: 1000, yield: .1 };
  const b = structuredClone(a); b.groups[0].sheets[0].largestFree = { w: 40, h: 500 };
  assert.equal(typeof nest.isBetterNest, 'function');
  for (const strategy of ['free', 'guillotine', 'cnc']) assert.equal(nest.isBetterNest(a, b, strategy), true);
});

test('Repeated long rips is a saw strategy and prefers fewer settings over a larger offcut', () => {
  assert.equal(rect.migrateCutStrategy('repeated'), 'repeated');
  assert.equal(rect.isGuillotineStrategy('repeated'), true);
  const cut = d => ({ axis: 'H', distance: d, parentW: 1200, parentH: 800, parentX: 0, parentY: 0, depth: 0 });
  const score = (distances, w) => ({ unplaced: [], sheets: [{ usedArea: 100, fullySeparated: 4,
    cuts: distances.map(cut), largestFree: { w, h: 600 } }] });
  const repeated = score([300, 300, 300, 300], 250);
  const mixed = score([200, 250, 300, 350], 600);
  assert.equal(rect.isBetter(repeated, mixed, 'repeated'), true);
  assert.equal(rect.isBetter(mixed, repeated, 'repeated'), false);
});

test('repeated mode rips full-length equal-width strips before crosscutting', () => {
  const items = [[900, 100], [680, 100], [500, 100], [800, 200]]
    .map(([w, h], i) => ({ id: String(i), w, h, allowRotate: true }));
  const job = { items, sheetW: 1200, sheetH: 600, kerf: 3, cutStrategy: 'repeated' };
  const result = rect.packMulti(job, 64);
  assert.equal(result.sheets.length, 1);
  legal(job, result);
  const cuts = result.sheets[0].cuts;
  const firstCrosscut = cuts.findIndex(c => c.axis === 'V');
  assert.ok(firstCrosscut >= 3, 'rip the strips before any crosscut');
  assert.ok(cuts.slice(0, firstCrosscut).every(c => c.axis === 'H' && c.parentW === 1200));
  assert.deepEqual(cuts.slice(0, 2).map(c => c.distance), [103, 103]);
  assert.ok(result.sheets[0].placements.every(p => p.w > p.h), 'long part edges follow the sheet length');
});

test('repeated mode scores long rips before repeated short-axis crosscuts', () => {
  const cut = (axis, distance, parentW = 1200) => ({ axis, distance, parentW, parentH: 800, parentX: 0, parentY: 0, depth: 0 });
  const score = cuts => ({ unplaced: [], sheets: [{ usedArea: 100, fullySeparated: 4, largestFree: null, cuts }] });
  const longRips = score([cut('H', 100), cut('H', 100), cut('V', 500), cut('V', 600), cut('V', 700)]);
  const crosscuts = score([cut('H', 100), cut('H', 200), cut('V', 500), cut('V', 500), cut('V', 500)]);
  assert.equal(rect.isBetter(longRips, crosscuts, 'repeated'), true);
  assert.equal(rect.isBetter(crosscuts, longRips, 'repeated'), false);
});

test('rip offcuts remain separate after full-length cuts, including portrait stock', () => {
  for (const portrait of [false, true]) {
    for (const count of [2, 4]) {
      const job = { sheetW: portrait ? 800 : 1200, sheetH: portrait ? 1200 : 800,
        kerf: 0, cutStrategy: 'repeated', items: Array.from({ length: count }, (_, i) => ({
          id: String(i), w: portrait ? 200 : 700, h: portrait ? 700 : 200, allowRotate: false,
        })) };
      const result = rect.packMulti(job, 16);
      legal(job, result);
      assert.equal(result.sheets.length, 1);
      const offcut = result.sheets[0].largestFree;
      assert.ok(offcut);
      assert.deepEqual([offcut.w, offcut.h].sort((a, b) => a - b), count === 4 ? [200, 500] : [400, 1200],
        'retain the uncut trailing stock or one strip remnant, never merge across rip cuts');
    }
  }
});

test('long rip direction follows the longer edge of portrait stock', () => {
  const items = [[100, 900], [100, 680], [100, 500], [200, 800]]
    .map(([w, h], i) => ({ id: String(i), w, h, allowRotate: false }));
  const job = { items, sheetW: 600, sheetH: 1200, kerf: 3, cutStrategy: 'repeated' };
  const result = rect.packMulti(job, 32);
  legal(job, result);
  assert.equal(result.sheets.length, 1);
  const cuts = result.sheets[0].cuts;
  assert.deepEqual(cuts.slice(0, 2).map(c => [c.axis, c.parentH, c.distance]), [['V', 1200, 103], ['V', 1200, 103]]);
});

test('exported instructions retain long rips first and same-setting labels', () => {
  const parts = [[900, 100], [680, 100], [500, 100], [800, 200]].map(([w, h], i) => ({
    id: String(i), name: String(i), thickness: 18, qty: 1, grain: 'free', rotation: 'flip90',
    outer: [[0, 0], [w, 0], [w, h], [0, h]], holes: [], color: '#888',
  }));
  const result = nest.runNest(parts, { sheetW: 620, sheetL: 1220, margin: 10, kerf: 3, resolution: 5,
    cutStrategy: 'repeated', restarts: 32 });
  const sheet = result.groups[0].sheets[0];
  const plan = instructions.cutStepsForSheet(sheet, 1, 1, 10, 3, undefined, 'keeper', 'optimized');
  const cuts = plan.steps.filter(c => !c.isTrim);
  assert.equal(cuts[0].axis, 'rip');
  assert.equal(cuts[1].axis, 'rip');
  assert.equal(cuts[1].sameSetting, true);
  assert.ok(cuts[0].parentW >= 1200 && cuts[1].parentW >= 1200);
  assert.ok(cuts.findIndex(c => c.axis === 'cross') >= 2);
});

test('worker failure terminates the whole pool and preserves the search seed', async () => {
  const workers = [];
  class FailingWorker {
    constructor() { workers.push(this); this.dead = false; }
    postMessage() { if (workers.length === 1) setTimeout(() => this.onerror?.(new Error('test worker failure')), 0); }
    terminate() { this.dead = true; }
  }
  const original = globalThis.Worker;
  globalThis.Worker = FailingWorker;
  const warn = console.warn; console.warn = () => {};
  try {
    const job = jobFor(2);
    const result = await pool.packMultiParallel(job, 48, () => {}, 7);
    assert.ok(workers.every(w => w.dead), 'all workers are stopped before fallback');
    assert.deepEqual(result, await rect.packMultiAnimated(job, 48, () => {}, 1000, 7));
  } finally { globalThis.Worker = original; console.warn = warn; }
});

test('worker completion waits for asynchronous progress callbacks', async () => {
  class FakeWorker {
    dead = false;
    postMessage(msg) {
      setTimeout(() => {
        for (const t of msg.trials) {
          if (this.dead) break;
          const order = t.orderIds.map(id => msg.job.items.find(p => p.id === id));
          this.onmessage?.({ data: { kind: 'rect-trial', idx: t.idx, result: rect.packOne(msg.job, t.heur, order, t.binKind) } });
        }
        this.onmessage?.({ data: { kind: 'done' } });
      }, 0);
    }
    terminate() { this.dead = true; }
  }
  const original = globalThis.Worker; globalThis.Worker = FakeWorker;
  try {
    let pending = 0, completed = 0, overlap = false;
    const job = jobFor(3);
    const result = await pool.packMultiParallel(job, 8, async () => {
      if (pending) overlap = true;
      pending++;
      await new Promise(r => setTimeout(r, 2));
      pending--; completed++;
    });
    assert.equal(pending, 0);
    assert.equal(overlap, false, 'callbacks run sequentially');
    assert.equal(completed, rect.buildTrialSchedule(job, 8).length);
    assert.deepEqual(result, rect.packMulti(job, 8));
  } finally { globalThis.Worker = original; }
});

test('worker fallback drains an in-flight callback before restarting progress', async () => {
  let count = 0;
  class InterruptedWorker {
    constructor() { this.index = count++; }
    postMessage(msg) {
      if (!this.index) setTimeout(() => {
        const t = msg.trials[0], order = t.orderIds.map(id => msg.job.items.find(p => p.id === id));
        this.onmessage?.({ data: { kind: 'rect-trial', idx: t.idx, result: rect.packOne(msg.job, t.heur, order, t.binKind) } });
      }, 0);
      else if (this.index === 1) setTimeout(() => this.onerror?.(new Error('interrupted')), 5);
    }
    terminate() {}
  }
  const original = globalThis.Worker, warn = console.warn;
  globalThis.Worker = InterruptedWorker; console.warn = () => {};
  try {
    let pending = 0, overlap = false;
    await pool.packMultiParallel(jobFor(3), 8, async () => {
      if (pending) overlap = true;
      pending++;
      await new Promise(r => setTimeout(r, 15));
      pending--;
    });
    assert.equal(overlap, false);
    assert.equal(pending, 0);
  } finally { globalThis.Worker = original; console.warn = warn; }
});

test('largest offcut agrees with exhaustive rectangle enumeration', () => {
  assert.equal(typeof rect.largestEmptyRect, 'function');
  for (let seed = 1; seed <= 15; seed++) {
    const rects = jobFor(seed, 'free', 4).items.map((p, i) => ({ x: i * 170, y: i * 60, w: p.w / 3, h: p.h / 3 }));
    const xs = [...new Set([0, 1200, ...rects.flatMap(r => [r.x, r.x + r.w])])].sort((a, b) => a - b);
    const ys = [...new Set([0, 800, ...rects.flatMap(r => [r.y, r.y + r.h])])].sort((a, b) => a - b);
    let area = 0;
    for (let l = 0; l < xs.length; l++) for (let r = l + 1; r < xs.length; r++)
      for (let t = 0; t < ys.length; t++) for (let b = t + 1; b < ys.length; b++) {
        if (!rects.some(q => q.x < xs[r] - 1e-6 && q.x + q.w > xs[l] + 1e-6 && q.y < ys[b] - 1e-6 && q.y + q.h > ys[t] + 1e-6))
          area = Math.max(area, (xs[r] - xs[l]) * (ys[b] - ys[t]));
      }
    const best = rect.largestEmptyRect(rects, 1200, 800);
    assert.ok(Math.abs(best.w * best.h - area) < 1e-6);
  }
});

test('restart budgets are respected, including one-trial and seeded searches', () => {
  for (const strategy of ['free', 'guillotine', 'repeated']) for (const budget of [1, 4, 8, 32, 64, 1024, 2048]) {
    const job = jobFor(1, strategy);
    assert.equal(rect.buildTrialSchedule(job, budget).length, budget);
    assert.notDeepEqual(rect.buildTrialSchedule(job, budget, 1), rect.buildTrialSchedule(job, budget, 2));
  }
});

test('similar but different widths require distinct saw settings', () => {
  const cut = distance => ({ axis: 'H', distance, parentW: 1200, parentH: 800, parentX: 0, parentY: 0, depth: 0 });
  const score = widths => ({ unplaced: [], sheets: [{ cuts: widths.map(cut), usedArea: 100, largestFree: null, fullySeparated: 4 }] });
  assert.equal(rect.isBetter(score([300, 300, 300, 300]), score([300, 300.4, 300, 300.4]), 'repeated'), true);
});

test('CNC finishing preserves its best offcut and moves the leanest sheet last', () => {
  const outline = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]];
  const items = jobFor(12, 'free', 10).items.map(p => ({ id: p.id, geoKey: p.id, outer: outline(p.w, p.h), holes: [], angles: [0, 90], area: p.w * p.h }));
  const passes = [];
  const opt = { restarts: 4, saveLast: true, targetCells: 120 };
  cnc.cncRunPasses(items, 1200, 800, 3, opt, 4, [0, 1, 2, 3], (_, pass) => passes.push(pass));
  const winner = passes.reduce((a, b) => cnc.serialPassBetter(b, a, true) ? b : a);
  winner.sheets.sort((a, b) => a.usedArea - b.usedArea);
  const result = cnc.cncFinish(items, 1200, 800, 3, opt, winner);
  assert.equal(result.sheets.at(-1).usedArea, Math.min(...result.sheets.map(s => s.usedArea)));
  assert.deepEqual(result.sheets.flatMap(s => s.placements.map(p => p.id)).sort(), items.map(p => p.id).sort());
});

test('CNC compaction cannot replace a larger reusable panel with a smaller one', () => {
  const outer = [[0, 0], [300, 0], [300, 600], [0, 600]];
  const item = { id: 'a', geoKey: 'a', outer, holes: [], angles: [0, 90], area: 180000 };
  const winner = { unplaced: [], sheets: [{ usedArea: item.area, placements: [
    { id: 'a', x: 0, y: 0, w: 300, h: 600, angleDeg: 0, outer, holes: [], area: item.area },
  ] }] };
  const result = cnc.cncFinish([item], 1200, 800, 0, { saveLast: true, targetCells: 120 }, winner);
  const f = result.sheets[0].largestFree;
  assert.ok(f.w * f.h >= 900 * 800, `offcut regressed to ${f.w} x ${f.h}`);
});
