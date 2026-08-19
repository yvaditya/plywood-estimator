// Unit checks for the manual-rearrange geometry: the push-aside cascade and
// the mid-drag rotation. Both are pure functions over plain part records, so
// they can be exercised without a browser.
//
// Prereq:  npx --prefix app esbuild app/src/rearrange.ts --bundle --format=esm \
//            --platform=node --outfile=tests/_output/rearrange_bundle.mjs
// Run:     node tests/rearrange_unit.mjs

import { planReshuffle, rotatePart, placementLegal, largestFreeRect }
  from './_output/rearrange_bundle.mjs';

const KERF = 3;
const MARGIN = 10;
let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${name}`); }
  else { console.log(`  FAIL ${name} ${detail}`); failures++; }
};

const rect = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]];
const part = (id, x, y, w, h) => ({
  partId: id, partName: id, instance: 1, rotation: 0, holes: [],
  separatedAt: 0, panelLabel: id, color: '#888',
  x, y, w, h, outer: rect(w, h),
});
const sheet = (parts) => ({
  index: 1, globalIndex: 1, thickness: 18, parts,
  usedArea: 0, largestFree: null, sheetW: 1000, sheetL: 600, cuts: [],
});

/** Every pair on the sheet must clear by a kerf on at least one axis. */
function overlaps(parts, pos) {
  const bad = [];
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const A = parts[i], B = parts[j];
      const a = pos.get(A), b = pos.get(B);
      const gx = Math.max(b.x - (a.x + A.w), a.x - (b.x + B.w));
      const gy = Math.max(b.y - (a.y + A.h), a.y - (b.y + B.h));
      if (Math.max(gx, gy) < KERF - 0.01) bad.push([A.partId, B.partId]);
    }
  }
  return bad;
}

console.log('planReshuffle');
{
  // A at left, B in the middle. Drop D right on top of B.
  const A = part('A', 10, 10, 200, 200);
  const B = part('B', 300, 10, 200, 200);
  const D = part('D', 700, 300, 150, 150);
  const s = sheet([A, B, D]);
  const plan = planReshuffle(s, D, 320, 30, MARGIN, KERF);
  check('resolves a drop onto an occupied spot', plan !== null);
  if (plan) {
    check('anchor lands exactly where dropped',
      plan.get(D).x === 320 && plan.get(D).y === 30,
      JSON.stringify(plan.get(D)));
    const moved = plan.get(B);
    check('the blocked neighbour moved', moved.x !== 300 || moved.y !== 10,
      JSON.stringify(moved));
    check('the untouched panel stayed put',
      plan.get(A).x === 10 && plan.get(A).y === 10, JSON.stringify(plan.get(A)));
    const bad = overlaps(s.parts, plan);
    check('no overlaps survive the cascade', bad.length === 0, JSON.stringify(bad));
    for (const p of s.parts) {
      const q = plan.get(p);
      check(`${p.partId} stays inside the margin box`,
        q.x >= MARGIN - 0.01 && q.y >= MARGIN - 0.01
        && q.x + p.w <= s.sheetW - MARGIN + 0.01
        && q.y + p.h <= s.sheetL - MARGIN + 0.01, JSON.stringify(q));
    }
  }
}
{
  // Cascade: dropping on B must push B into C, and C onward.
  const B = part('B', 300, 10, 200, 200);
  const C = part('C', 510, 10, 200, 200);
  const D = part('D', 10, 400, 150, 150);
  const s = sheet([B, C, D]);
  const plan = planReshuffle(s, D, 300, 10, MARGIN, KERF);
  check('cascade resolves', plan !== null);
  if (plan) {
    check('no overlaps after a cascade',
      overlaps(s.parts, plan).length === 0,
      JSON.stringify(overlaps(s.parts, plan)));
  }
}
{
  // A sheet with no room left cannot absorb another panel.
  const big = part('BIG', 10, 10, 960, 560);
  const D = part('D', 0, 0, 400, 400);
  const s = sheet([big, D]);
  const plan = planReshuffle(s, D, 100, 100, MARGIN, KERF);
  check('rejects when there is genuinely no room', plan === null);
}
{
  // Anchor itself outside the margin box is refused outright.
  const A = part('A', 10, 10, 100, 100);
  const D = part('D', 500, 300, 100, 100);
  const s = sheet([A, D]);
  check('rejects an anchor outside the margin box',
    planReshuffle(s, D, -5, 300, MARGIN, KERF) === null);
  check('rejects an anchor past the far edge',
    planReshuffle(s, D, 950, 300, MARGIN, KERF) === null);
}

console.log('rotatePart');
{
  const p = part('P', 10, 20, 300, 100);
  rotatePart(p, 1);
  check('90° swaps the bbox', p.w === 100 && p.h === 300, `${p.w}x${p.h}`);
  check('90° records the angle', p.rotation === 90, String(p.rotation));
  const xs = p.outer.map(([x]) => x), ys = p.outer.map(([, y]) => y);
  check('ring is re-anchored to (0,0)',
    Math.min(...xs) === 0 && Math.min(...ys) === 0,
    `min ${Math.min(...xs)},${Math.min(...ys)}`);
  check('ring bbox matches w/h',
    Math.max(...xs) === p.w && Math.max(...ys) === p.h,
    `max ${Math.max(...xs)},${Math.max(...ys)}`);
  rotatePart(p, 1); rotatePart(p, 1); rotatePart(p, 1);
  check('four quarter turns return to the start',
    p.w === 300 && p.h === 100 && p.rotation === 0, `${p.w}x${p.h}@${p.rotation}`);
}
{
  // Holes must travel with the outline.
  const p = part('H', 0, 0, 400, 200);
  p.holes = [[[50, 50], [100, 50], [100, 150], [50, 150]]];
  rotatePart(p, 1);
  const hx = p.holes[0].map(([x]) => x), hy = p.holes[0].map(([, y]) => y);
  check('hole stays inside the rotated outline',
    Math.min(...hx) >= 0 && Math.min(...hy) >= 0
    && Math.max(...hx) <= p.w && Math.max(...hy) <= p.h,
    `hole ${Math.min(...hx)},${Math.min(...hy)}..${Math.max(...hx)},${Math.max(...hy)} in ${p.w}x${p.h}`);
  rotatePart(p, 2);
  check('180° keeps the bbox', p.w === 200 && p.h === 400, `${p.w}x${p.h}`);
}

console.log('placementLegal / largestFreeRect');
{
  const A = part('A', 10, 10, 200, 200);
  const B = part('B', 300, 10, 200, 200);
  const s = sheet([A, B]);
  check('touching closer than a kerf is illegal',
    !placementLegal(s, B, 210, 10, MARGIN, KERF));
  check('exactly a kerf apart is legal',
    placementLegal(s, B, 213, 10, MARGIN, KERF));
  const free = largestFreeRect(s, MARGIN, KERF);
  check('finds free material', free !== null && free.w > 0 && free.h > 0,
    JSON.stringify(free));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
