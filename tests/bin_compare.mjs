// Head-to-head of the constructive packers, ONE ordering each, no search.
// Answers "is this a better packer?" separately from "does one more trial in
// a 256-trial pool help?" — a pool can hide a better algorithm entirely.
//
// Run: node tests/bin_compare.mjs
import { packOne } from './_output/packrect_bundle.mjs';

const SHEET_W = 2438, SHEET_L = 1219, MARGIN = 12.7, KERF = 1.8;

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}
function genJob(seed, n) {
  const r = rng(seed);
  const items = [];
  for (let i = 0; i < n; i++) {
    const roll = r();
    let w, h;
    if (roll < 0.28) { w = 500 + ((r() * 700) | 0); h = 600 + ((r() * 500) | 0); }
    else if (roll < 0.62) { w = 300 + ((r() * 600) | 0); h = 250 + ((r() * 450) | 0); }
    else if (roll < 0.85) { w = 300 + ((r() * 500) | 0); h = 90 + ((r() * 130) | 0); }
    else { w = 600 + ((r() * 1400) | 0); h = 50 + ((r() * 90) | 0); }
    items.push({ id: `p${i}`, w, h, allowRotate: r() < 0.75 });
  }
  return items;
}
const lb = (items) => Math.ceil(
  items.reduce((s, p) => s + (p.w + KERF) * (p.h + KERF), 0)
  / ((SHEET_W - 2 * MARGIN) * (SHEET_L - 2 * MARGIN)) - 1e-9);

const KINDS = ['maxrects', 'maxrects-g', 'shelf', 'shelf-v', 'sas'];
const SIZES = [20, 40, 80, 160];
const SEEDS = [1, 2, 3, 4, 5];

const tot = Object.fromEntries(KINDS.map((k) => [k, { ex: 0, ms: 0, n: 0 }]));
for (const n of SIZES) {
  const line = [];
  for (const kind of KINDS) {
    let ex = 0, ms = 0;
    for (const seed of SEEDS) {
      const items = genJob(seed * 7919 + n, n);
      // One canonical ordering for everyone: largest area first.
      const order = items.slice().sort((a, b) => b.w * b.h - a.w * a.h);
      const job = {
        items, sheetW: SHEET_W - 2 * MARGIN, sheetH: SHEET_L - 2 * MARGIN,
        kerf: KERF, cutStrategy: kind.startsWith('maxrects') ? 'free' : 'guillotine',
      };
      const t0 = performance.now();
      const r = packOne(job, 'BSSF', order, kind);
      ms += performance.now() - t0;
      ex += r.sheets.length - lb(items);
      if (r.unplaced.length) ex += 100; // loud failure
    }
    ex /= SEEDS.length; ms /= SEEDS.length;
    tot[kind].ex += ex; tot[kind].ms += ms; tot[kind].n++;
    line.push(`${kind} ${ex >= 0 ? '+' : ''}${ex.toFixed(1)}`);
  }
  console.log(`n=${String(n).padStart(3)}  ${line.join('   ')}`);
}
console.log('\nmean excess over area LB (single ordering, no search):');
for (const k of KINDS) {
  const t = tot[k];
  console.log(`  ${k.padEnd(11)} ${(t.ex / t.n).toFixed(2)} sheets   ${(t.ms / t.n).toFixed(1)}ms`);
}
