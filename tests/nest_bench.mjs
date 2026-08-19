// Nesting benchmark: run the real packer over generated cabinet-like jobs and
// measure sheet count against the area lower bound.
//
// The four sample models are too small to tell us anything — each already hits
// its lower bound — so this generates harder instances with realistic part
// mixes and sizes.
//
// Prereq:  npx --prefix app esbuild app/src/packRect.ts --bundle --format=esm \
//            --platform=node --outfile=tests/_output/packrect_bundle.mjs
// Run:     node tests/nest_bench.mjs [restarts]

import { packMulti, effectiveJob, finishPack } from './_output/packrect_bundle.mjs';

const RESTARTS = Number(process.argv[2] || 256);
const SHEET_W = 2438, SHEET_L = 1219, MARGIN = 12.7, KERF = 1.8;

/** Deterministic PRNG so runs are comparable. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

/**
 * Cabinet-like part mix: carcass sides/tops (big), shelves (medium), rails and
 * drawer parts (small/thin). Proportions roughly match the sample jobs.
 */
function genJob(seed, n) {
  const r = rng(seed);
  const items = [];
  for (let i = 0; i < n; i++) {
    const roll = r();
    let w, h;
    if (roll < 0.28) {              // carcass panel
      w = 500 + Math.floor(r() * 700);
      h = 600 + Math.floor(r() * 500);
    } else if (roll < 0.62) {       // shelf / door
      w = 300 + Math.floor(r() * 600);
      h = 250 + Math.floor(r() * 450);
    } else if (roll < 0.85) {       // drawer side
      w = 300 + Math.floor(r() * 500);
      h = 90 + Math.floor(r() * 130);
    } else {                        // rail / kick strip
      w = 600 + Math.floor(r() * 1400);
      h = 50 + Math.floor(r() * 90);
    }
    items.push({ id: `p${i}`, w, h, allowRotate: r() < 0.75 });
  }
  return items;
}

function areaLowerBound(items) {
  const usable = (SHEET_W - 2 * MARGIN) * (SHEET_L - 2 * MARGIN);
  // Kerf-inflate each part: that material really is consumed.
  const a = items.reduce((s, p) => s + (p.w + KERF) * (p.h + KERF), 0);
  return Math.ceil(a / usable - 1e-9);
}

function run(strategy, items) {
  // PackJob takes the USABLE sheet — the edge margin is already removed.
  const job = {
    items,
    sheetW: SHEET_W - 2 * MARGIN,
    sheetH: SHEET_L - 2 * MARGIN,
    kerf: KERF,
    cutStrategy: strategy,
  };
  const t0 = performance.now();
  const res = finishPack(job, packMulti(effectiveJob(job), RESTARTS));
  const ms = performance.now() - t0;
  const sheets = res.sheets.length;
  const used = res.sheets.reduce((s, sh) => s + sh.placements.reduce((t, p) => t + p.w * p.h, 0), 0);
  const cap = sheets * (SHEET_W - 2 * MARGIN) * (SHEET_L - 2 * MARGIN);
  return { sheets, yield: used / cap, ms, unplaced: res.unplaced?.length ?? 0 };
}

const STRATEGIES = ['free', 'guillotine'];
const SIZES = [20, 40, 80, 160];
const SEEDS = [1, 2, 3, 4, 5];

console.log(`restarts=${RESTARTS}  sheet ${SHEET_W}x${SHEET_L}  margin ${MARGIN}  kerf ${KERF}\n`);
const totals = {};
for (const strategy of STRATEGIES) {
  console.log(`--- ${strategy} ---`);
  let excessSum = 0, cases = 0, msSum = 0;
  for (const n of SIZES) {
    const row = [];
    for (const seed of SEEDS) {
      const items = genJob(seed * 7919 + n, n);
      const lb = areaLowerBound(items);
      const r = run(strategy, items);
      const excess = r.sheets - lb;
      excessSum += excess; cases++; msSum += r.ms;
      row.push(`${r.sheets}/${lb}${excess ? `(+${excess})` : ''}`);
      if (r.unplaced) row[row.length - 1] += `!${r.unplaced}`;
    }
    console.log(`  n=${String(n).padStart(3)}  sheets/LB: ${row.join('  ')}`);
  }
  totals[strategy] = { excess: excessSum / cases, ms: msSum / cases };
  console.log(`  mean excess over area LB: ${totals[strategy].excess.toFixed(2)} sheets`
    + `   mean time ${totals[strategy].ms.toFixed(0)}ms\n`);
}
console.log(JSON.stringify(totals));
