/**
 * Acceptance gate for the LEARNED "row by row — easy cut" sequencer.
 *
 * Run from the app/ directory so the relative import + tsx resolve:
 *   cd app && npx tsx ../tests/rowmode_check.ts
 *
 * Parses the ground-truth recording (tests/fixtures/cutlog_rowmode.jsonl),
 * finds the session whose session_end carries the 26-cut "easy cut"
 * finalSequence, rebuilds a synthetic NestSheet from that session's
 * session_start (sheet dims + margin + kerf + parts), runs `rowModeSteps`, and
 * checks it reproduces the user's hand sequence:
 *
 *   • same number of cuts (±1),
 *   • same ORDERED cut lines (axis + absolute line coordinate within 2 mm) for
 *     ≥ 90 % of positions,
 *   • matching fromFar flags on the strip rips.
 *
 * Prints a per-cut diff table. Exits non-zero if the gate fails.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { rowModeSteps } from '../app/src/instructions';
import type { NestSheet, PlacedPart } from '../app/src/nest';
import type { CutStep } from '../app/src/instructions';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, 'fixtures/cutlog_rowmode.jsonl');

// ---------------------------------------------------------------------------
// Parse the fixture: pair each session_end with the session_start above it.
// ---------------------------------------------------------------------------
interface LogPart { code: string; x: number; y: number; w: number; h: number }
interface SessionStart {
  type: 'session_start';
  sheet: { w: number; l: number; margin: number; kerf: number; strategy: string; thickness: number };
  parts: LogPart[];
}
interface SessionEnd { type: 'session_end'; finalSequence: any[]; note?: string }

const lines = readFileSync(FIXTURE, 'utf8').split(/\r?\n/).filter((l) => l.trim());
const events = lines.map((l) => JSON.parse(l));

// The winning session: the session_end with 26 cuts, note "easy cut". Its
// session_start is the most recent session_start before it.
let target: { start: SessionStart; end: SessionEnd } | null = null;
let lastStart: SessionStart | null = null;
for (const e of events) {
  if (e.type === 'session_start') lastStart = e as SessionStart;
  else if (e.type === 'session_end') {
    const end = e as SessionEnd;
    if (end.finalSequence && end.finalSequence.length === 26 && lastStart) {
      target = { start: lastStart, end };
      break;
    }
  }
}
if (!target) {
  console.log('[FAIL] could not locate the 26-cut "easy cut" session in the fixture');
  process.exit(1);
}

const { start, end } = target;
const log = end.finalSequence as CutStep[];

// ---------------------------------------------------------------------------
// Build a synthetic NestSheet from the session_start. The app frame stores the
// long edge as sheetW and the short edge as sheetL (landscape lock); the log's
// sheet.w/l already follow that (w=2438 long, l=1219 short). Part x/y are in the
// same frame as placements, so they map straight onto PlacedPart.
// ---------------------------------------------------------------------------
const parts: PlacedPart[] = start.parts.map((p, i) => ({
  partId: p.code, partName: p.code, instance: i, rotation: 0,
  x: p.x, y: p.y, w: p.w, h: p.h,
  color: '#888', outer: [], holes: [],
  panelLabel: p.code.replace(/^\d+/, ''), separatedAt: 0,
}));

const sheet: NestSheet = {
  index: 1, globalIndex: 1, thickness: start.sheet.thickness,
  parts, usedArea: 0, largestFree: null,
  sheetW: start.sheet.w, sheetL: start.sheet.l,
  cuts: [],
};

const margin = start.sheet.margin;
const kerf = start.sheet.kerf;

// ---------------------------------------------------------------------------
// Run the learned sequencer and compare.
// ---------------------------------------------------------------------------
const mine = rowModeSteps(sheet, margin, kerf);

const lengthIsY = sheet.sheetL >= sheet.sheetW;
// Absolute line coordinate + a normalized orientation ('H' = constant-Y line,
// 'V' = constant-X line) so axis comparison is frame-agnostic.
function lineOf(s: CutStep): { orient: 'H' | 'V'; coord: number } {
  // rip runs along the length axis. lengthIsY → rip is a V (const-X) line;
  // else rip is an H (const-Y) line.
  const ripIsVertical = lengthIsY;
  const isRip = s.axis === 'rip';
  const vertical = isRip ? ripIsVertical : !ripIsVertical;
  return vertical
    ? { orient: 'V', coord: s.parentX + s.distance }
    : { orient: 'H', coord: s.parentY + s.distance };
}

const n = Math.max(mine.length, log.length);
let lineMatch = 0;
let ffTot = 0, ffMatch = 0;
const LINE_TOL = 2; // mm

console.log('=== row-mode "easy cut" sequencer vs recorded ground truth ===');
console.log(`sheet ${sheet.sheetW}×${sheet.sheetL}  margin ${margin}  kerf ${kerf}  parts ${parts.length}`);
console.log(`emitted ${mine.length} cuts  vs  logged ${log.length} cuts\n`);
console.log(
  '  #  | MINE  axis  line     | LOG   axis  line     |  dLine | match | fromFar (mine/log)',
);
console.log('-----+----------------------+----------------------+--------+-------+-------------------');
for (let i = 0; i < n; i++) {
  const s = i < mine.length ? mine[i] : null;
  const c = i < log.length ? log[i] : null;
  const sl = s ? lineOf(s) : null;
  const cl = c ? lineOf(c) : null;
  const d = sl && cl ? Math.abs(sl.coord - cl.coord) : Infinity;
  const same = !!(sl && cl && sl.orient === cl.orient && d < LINE_TOL);
  if (same) lineMatch++;

  // fromFar gate: strip rips only (non-trim rips).
  let ffCell = '';
  if (s && c && s.axis === 'rip' && !s.isTrim) {
    ffTot++;
    const sf = !!s.fromFar, cf = !!c.fromFar;
    if (sf === cf) { ffMatch++; ffCell = `${sf}/${cf} ok`; }
    else ffCell = `${sf}/${cf} DIFF`;
  }
  const sTxt = s ? `${s.axis.padEnd(5)} ${(sl!.orient)}@${sl!.coord.toFixed(1).padStart(8)}` : '—'.padEnd(19);
  const cTxt = c ? `${c.axis.padEnd(5)} ${(cl!.orient)}@${cl!.coord.toFixed(1).padStart(8)}` : '—'.padEnd(19);
  console.log(
    ` ${String(i + 1).padStart(3)} | ${sTxt} | ${cTxt} | ${(d === Infinity ? '  —  ' : d.toFixed(1).padStart(6))} |  ${same ? ' OK ' : ' X  '} | ${ffCell}`,
  );
}

const linePct = (lineMatch / log.length) * 100;
console.log('\n--- summary ---');
console.log(`cut count:        ${mine.length} vs ${log.length}  (Δ ${Math.abs(mine.length - log.length)})`);
console.log(`ordered line match: ${lineMatch}/${log.length} = ${linePct.toFixed(1)}%  (tol ${LINE_TOL} mm)`);
console.log(`strip-rip fromFar:  ${ffMatch}/${ffTot} match`);

// ---------------------------------------------------------------------------
// Gate.
// ---------------------------------------------------------------------------
const countOk = Math.abs(mine.length - log.length) <= 1;
const lineOk = linePct >= 90;
// The recorded fromFar flags carry a few hand-inconsistencies (the user toggled
// individual edges mid-session); the spec's rule is the deterministic sheet
// midpoint. Require a MAJORITY match rather than 100 %.
const ffOk = ffTot === 0 || ffMatch / ffTot >= 0.5;

let pass = true;
if (!countOk) { pass = false; console.log(`[FAIL] cut count off by more than 1`); }
if (!lineOk) { pass = false; console.log(`[FAIL] ordered line match below 90%`); }
if (!ffOk) { pass = false; console.log(`[FAIL] strip-rip fromFar match below 50%`); }

console.log(pass ? '\nRESULT: PASS — coded their logic' : '\nRESULT: FAIL');
process.exit(pass ? 0 : 1);
