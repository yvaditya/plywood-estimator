/**
 * Cut & assembly instructions derived from a NestResult.
 *
 * - Letter labels (A, B, C, …, Z, AA, AB, …) assigned per UNIQUE part id so
 *   two instances of the same body share one label (matching IKEA's parts
 *   list convention).
 * - Cut steps per sheet: every unique interior X / Y edge becomes one step.
 *   Rip cuts (along sheet length / grain) ordered first; crosscuts second.
 * - Parts overview groups: deduped list of unique parts with quantities.
 */

import type { NestResult, NestSheet } from './nest';

export interface PartLabel {
  partId: string;
  letter: string;       // 'A', 'B', …, 'Z', 'AA', 'AB', …
  partName: string;
  thickness: number;    // mm
  length: number;       // mm
  width: number;        // mm
  totalQty: number;     // total instances across the whole job
}

export interface CutStep {
  index: number;        // 1-based within its sheet
  axis: 'rip' | 'cross';
  /** Distance from the reference edge in mm. Rip = from left edge (X).
   *  Crosscut = from bottom edge (Y). */
  distance: number;
}

export interface SheetCuts {
  sheetIndex: number;   // 1-based within its thickness group
  groupIndex: number;   // 1-based
  thickness: number;
  sheetW: number;
  sheetL: number;
  steps: CutStep[];
}

/**
 * Walk the result and assign A/B/C labels per unique partId. Order is
 * largest-first so prominent panels get the early letters.
 */
export function assignPartLabels(result: NestResult): Map<string, PartLabel> {
  const byId = new Map<string, PartLabel>();
  for (const g of result.groups) {
    for (const s of g.sheets) {
      for (const p of s.parts) {
        const ex = byId.get(p.partId);
        if (ex) {
          ex.totalQty += 1;
        } else {
          byId.set(p.partId, {
            partId: p.partId,
            letter: '',
            partName: p.partName,
            thickness: g.thickness,
            length: Math.max(p.w, p.h),
            width: Math.min(p.w, p.h),
            totalQty: 1,
          });
        }
      }
    }
  }
  // Order by area desc → letter assignment biggest first
  const ordered = Array.from(byId.values()).sort((a, b) => (b.length * b.width) - (a.length * a.width));
  ordered.forEach((p, i) => { p.letter = indexToLetters(i); });
  // Re-key result map by partId to preserve quick lookup
  const out = new Map<string, PartLabel>();
  for (const p of ordered) out.set(p.partId, p);
  return out;
}

/** Convert 0→'A', 25→'Z', 26→'AA', 27→'AB', etc. */
export function indexToLetters(i: number): string {
  let n = i;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/**
 * Cut steps for a single sheet: unique interior X / Y edges, ordered rip
 * cuts first, then crosscuts. Coords snapped to 0.5 mm so float wobble
 * doesn't dup adjacent lines.
 *
 * Rip vs crosscut convention: the sheet's longer dimension is the "length"
 * (the grain direction in stock plywood). Rip cuts run PARALLEL to the
 * length axis — i.e. they have a fixed X coord on a portrait sheet (where
 * length = Y) or a fixed Y coord on a landscape sheet (length = X).
 */
export function cutStepsForSheet(sheet: NestSheet, sheetIndex: number, groupIndex: number): SheetCuts {
  const W = sheet.sheetW;
  const L = sheet.sheetL;
  const lengthIsY = L >= W;

  const xs = new Set<number>();
  const ys = new Set<number>();
  const snap = (n: number) => Math.round(n * 2) / 2;
  for (const p of sheet.parts) {
    if (p.x > 0.5)             xs.add(snap(p.x));
    if (p.x + p.w < W - 0.5)   xs.add(snap(p.x + p.w));
    if (p.y > 0.5)             ys.add(snap(p.y));
    if (p.y + p.h < L - 0.5)   ys.add(snap(p.y + p.h));
  }

  const xList = Array.from(xs).sort((a, b) => a - b);
  const yList = Array.from(ys).sort((a, b) => a - b);

  // Rip cuts parallel to length axis:
  //   - lengthIsY (portrait) → rips have fixed X → X cuts are rips
  //   - landscape           → rips have fixed Y → Y cuts are rips
  const ripCuts = lengthIsY ? xList : yList;
  const crossCuts = lengthIsY ? yList : xList;

  const steps: CutStep[] = [];
  let idx = 1;
  for (const d of ripCuts) steps.push({ index: idx++, axis: 'rip', distance: d });
  for (const d of crossCuts) steps.push({ index: idx++, axis: 'cross', distance: d });

  return {
    sheetIndex,
    groupIndex,
    thickness: sheet.thickness,
    sheetW: W,
    sheetL: L,
    steps,
  };
}

/** Generate cut step lists for every sheet in the job, in order. */
export function allCutSteps(result: NestResult): SheetCuts[] {
  const out: SheetCuts[] = [];
  result.groups.forEach((g, gi) => {
    g.sheets.forEach((s, si) => {
      out.push(cutStepsForSheet(s, si + 1, gi + 1));
    });
  });
  return out;
}
