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

import type { NestResult, NestSheet, Cut } from './nest';

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
  /** Parent piece for THIS cut — the rectangle of stock being cut.
   *  Same as the full sheet for the first cut; a smaller piece for later
   *  cuts that act on strips. Always present (defaults to full sheet for
   *  the legacy fallback path). */
  parentX: number;
  parentY: number;
  parentW: number;
  parentH: number;
  /** Depth in the cut tree (0 = original sheet). */
  depth: number;
  /** True for the initial margin-trim cuts that strip the sheet's perimeter
   *  before the real layout cuts begin. UI may render these differently
   *  (e.g. labelled "Trim L" instead of "Rip"). */
  isTrim?: boolean;
}

export interface SheetCuts {
  sheetIndex: number;   // 1-based within its thickness group
  globalIndex: number;  // 1-based across the whole job ("Sheet 3")
  groupIndex: number;   // 1-based
  thickness: number;
  sheetW: number;
  sheetL: number;
  steps: CutStep[];
  /** True when steps came from the guillotine cut tree (track-saw friendly,
   *  every cut goes edge-to-edge across its parent piece). False when they
   *  were inferred from unique part edges (MaxRects mode) — those cuts may
   *  not be physically realizable as edge-to-edge in one pass. */
  isGuillotineTree: boolean;
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
 * Cut steps for a single sheet.
 *
 *   - GUILLOTINE mode: walks the real cut tree captured by the packer.
 *     Each step references its parent piece and the cut's local distance.
 *     Already ordered "biggest cuts first" by depth.
 *   - MaxRects mode (no tree): falls back to unique interior X/Y edges as
 *     an APPROXIMATION. These cuts may not be physically realizable as
 *     edge-to-edge in one pass, but they describe the cut LINES.
 */
export function cutStepsForSheet(
  sheet: NestSheet,
  sheetIndex: number,
  groupIndex: number,
  margin = 0,
): SheetCuts {
  const W = sheet.sheetW;
  const L = sheet.sheetL;
  const lengthIsY = L >= W;

  // Margin trim cuts come first when margin > 0 — strip the perimeter so the
  // remaining stock matches the bin space the packer used. Four cuts (L, R,
  // B, T), each on the piece left after the previous trim.
  const trimSteps: CutStep[] = [];
  if (margin > 0) {
    const m = margin;
    // After "trim L" the active piece starts at x=m.
    // After "trim R" it ends at x=W-m, so width = W-2m.
    // After "trim B" it starts at y=m.
    // After "trim T" it ends at y=L-m, so height = L-2m.
    trimSteps.push({
      index: 1, axis: lengthIsY ? 'rip' : 'cross', distance: m,
      parentX: 0, parentY: 0, parentW: W, parentH: L, depth: 0, isTrim: true,
    });
    trimSteps.push({
      index: 2, axis: lengthIsY ? 'rip' : 'cross', distance: W - 2 * m,
      parentX: m, parentY: 0, parentW: W - m, parentH: L, depth: 0, isTrim: true,
    });
    trimSteps.push({
      index: 3, axis: lengthIsY ? 'cross' : 'rip', distance: m,
      parentX: m, parentY: 0, parentW: W - 2 * m, parentH: L, depth: 0, isTrim: true,
    });
    trimSteps.push({
      index: 4, axis: lengthIsY ? 'cross' : 'rip', distance: L - 2 * m,
      parentX: m, parentY: m, parentW: W - 2 * m, parentH: L - m, depth: 0, isTrim: true,
    });
  }
  const offset = trimSteps.length;

  // Path 1: guillotine cut tree available — translate Cut → CutStep.
  if (sheet.cuts && sheet.cuts.length > 0) {
    const steps: CutStep[] = sheet.cuts.map((c: Cut, i) => {
      // Axis mapping → user-facing rip/cross terminology.
      //   Rip cuts run parallel to the sheet's LENGTH axis.
      //   - lengthIsY → length runs vertically → rip = vertical cut (V)
      //   - landscape → length runs horizontally → rip = horizontal cut (H)
      const isRip = (lengthIsY && c.axis === 'V') || (!lengthIsY && c.axis === 'H');
      return {
        index: offset + i + 1,
        axis: isRip ? 'rip' : 'cross',
        // For a guillotine cut, the user makes it relative to its parent's
        // reference edge. We pass `distance` as the LOCAL value (from the
        // parent's bottom for H, parent's left for V) — the PDF renderer
        // shows the parent piece highlighted alongside it.
        distance: c.distance,
        parentX: c.parentX,
        parentY: c.parentY,
        parentW: c.parentW,
        parentH: c.parentH,
        depth: c.depth,
      };
    });
    return {
      sheetIndex, globalIndex: sheet.globalIndex || sheetIndex, groupIndex,
      thickness: sheet.thickness, sheetW: W, sheetL: L,
      steps: [...trimSteps, ...steps],
      isGuillotineTree: true,
    };
  }

  // Path 2 (fallback): infer unique interior edges. The "parent piece" for
  // these synthetic steps is just the whole sheet.
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
  const ripCuts = lengthIsY ? xList : yList;
  const crossCuts = lengthIsY ? yList : xList;

  const steps: CutStep[] = [];
  let idx = offset + 1;
  const baseParent = { parentX: 0, parentY: 0, parentW: W, parentH: L, depth: 0 };
  for (const d of ripCuts) steps.push({ index: idx++, axis: 'rip', distance: d, ...baseParent });
  for (const d of crossCuts) steps.push({ index: idx++, axis: 'cross', distance: d, ...baseParent });

  return {
    sheetIndex, globalIndex: sheet.globalIndex || sheetIndex, groupIndex,
    thickness: sheet.thickness, sheetW: W, sheetL: L,
    steps: [...trimSteps, ...steps],
    isGuillotineTree: false,
  };
}

/** Generate cut step lists for every sheet in the job, in order. */
export function allCutSteps(result: NestResult, margin = 0): SheetCuts[] {
  const out: SheetCuts[] = [];
  result.groups.forEach((g, gi) => {
    g.sheets.forEach((s, si) => {
      out.push(cutStepsForSheet(s, si + 1, gi + 1, margin));
    });
  });
  return out;
}
