/**
 * MaxRects bin-packing for rectangular cut-list nesting.
 *
 * Reference: Jukka Jylänki, "A Thousand Ways to Pack the Bin",
 *   https://github.com/juj/RectangleBinPack — the de-facto algorithm
 *   for rectangle packing. We use Best-Short-Side-Fit as the primary
 *   heuristic (good balance of yield + speed for sheet-good stock) and
 *   evaluate Best-Long-Side-Fit and Best-Area-Fit on restarts to escape
 *   local minima.
 *
 * Why this rather than the previous raster greedy: cabinet/case parts are
 * overwhelmingly rectangular, and MaxRects on rectangles routinely hits
 * 85–95% yield for typical jobs, vs. ~60–70% from a bottom-left raster
 * scan. NFP/GA libraries (SVGnest, Deepnest) are designed for irregular
 * shapes (laser/plasma) where their cost is justified — overkill here.
 *
 * Kerf/spacing is folded into the part footprint: each part is inflated
 * by `kerf` in both dimensions before packing, so the resulting positions
 * automatically respect kerf without per-pair checks.
 */

export interface Rect { x: number; y: number; w: number; h: number }

export type Heuristic = 'BSSF' | 'BLSF' | 'BAF' | 'BL';

/**
 * 'free' = MaxRects (any cut, max yield).
 * 'guillotine' = each placement splits its free rect into TWO with
 * edge-to-edge cuts. Resulting layout is producible with a track saw or
 * panel saw — every cut runs all the way across a piece of stock.
 */
export type CutStrategy = 'free' | 'guillotine';

export interface PackInput {
  /** Stable identifier; opaque to the packer. */
  id: string;
  /** Footprint width in mm (BEFORE kerf inflation). */
  w: number;
  /** Footprint height in mm (BEFORE kerf inflation). */
  h: number;
  /** May the packer flip the part 90°? Honour grain/rotation upstream. */
  allowRotate: boolean;
}

export interface PackPlacement {
  id: string;
  x: number;       // lower-left X in mm, sheet-relative (after margin offset)
  y: number;       // lower-left Y in mm
  w: number;       // placed width (after rotation if any)
  h: number;       // placed height (after rotation if any)
  rotated: boolean;
}

export interface PackResult {
  placed: PackPlacement[];
  /** Sum of placed.w * placed.h (NOT inflated). */
  usedArea: number;
}

/**
 * A single physical cut in a guillotine cut tree.
 *
 *   parent{X,Y,W,H} — the rectangle of stock being cut (in sheet coords,
 *     including kerf inflation).
 *   axis            — 'H' = horizontal cut (cut line runs along X),
 *                     'V' = vertical cut (cut line runs along Y).
 *   distance        — distance from the parent's reference edge:
 *                     - H cut: measured from parent's BOTTOM edge (parentY).
 *                     - V cut: measured from parent's LEFT edge (parentX).
 *   depth           — depth of the parent in the cut tree (0 = original sheet).
 *                     Used to order cuts "biggest first": all depth-0 cuts
 *                     (full-sheet rips) come before depth-1 (cuts within
 *                     strips), etc.
 */
export interface Cut {
  parentX: number;
  parentY: number;
  parentW: number;
  parentH: number;
  axis: 'H' | 'V';
  distance: number;
  depth: number;
}

interface FreeRect extends Rect {
  /** Depth in the cut tree — only the GuillotineBin uses this. */
  depth?: number;
}

interface ScoredPlacement {
  x: number;
  y: number;
  w: number;
  h: number;
  rotated: boolean;
  score1: number;
  score2: number;
}

interface BinPacker {
  binW: number;
  binH: number;
  free: FreeRect[];
  /** Cuts recorded so far (only populated by GuillotineBin). */
  cuts: Cut[];
  insert(w: number, h: number, allowRotate: boolean, heur: Heuristic): PackPlacement | null;
}

class MaxRectsBin implements BinPacker {
  binW: number;
  binH: number;
  free: FreeRect[];
  cuts: Cut[] = []; // MaxRects doesn't track a guillotine cut tree

  constructor(w: number, h: number) {
    this.binW = w;
    this.binH = h;
    this.free = [{ x: 0, y: 0, w, h }];
  }

  /**
   * Try to place a rect (w × h) using the given heuristic.
   * Returns null if it doesn't fit.
   */
  insert(w: number, h: number, allowRotate: boolean, heur: Heuristic): PackPlacement | null {
    const cand = this.findBest(w, h, allowRotate, heur);
    if (!cand) return null;
    this.commit(cand);
    return { id: '', x: cand.x, y: cand.y, w: cand.w, h: cand.h, rotated: cand.rotated };
  }

  private findBest(w: number, h: number, allowRotate: boolean, heur: Heuristic): ScoredPlacement | null {
    let best: ScoredPlacement | null = null;
    for (const f of this.free) {
      // Un-rotated
      if (w <= f.w && h <= f.h) {
        const cand = score(f.x, f.y, w, h, f, false, heur);
        if (!best || better(cand, best)) best = cand;
      }
      // Rotated 90°
      if (allowRotate && h <= f.w && w <= f.h) {
        const cand = score(f.x, f.y, h, w, f, true, heur);
        if (!best || better(cand, best)) best = cand;
      }
    }
    return best;
  }

  private commit(r: ScoredPlacement) {
    const placedRect: Rect = { x: r.x, y: r.y, w: r.w, h: r.h };
    const next: FreeRect[] = [];
    for (const f of this.free) {
      const splits = splitFreeRect(f, placedRect);
      if (splits === null) {
        // no overlap — keep as-is
        next.push(f);
      } else {
        for (const s of splits) next.push(s);
      }
    }
    this.free = prune(next);
  }
}

/**
 * Guillotine bin packer.
 * Every part placement creates EXACTLY two child free rectangles via an
 * edge-to-edge "cut" — never a 4-way split. The result is producible with
 * a track saw / panel saw where each cut runs across an entire piece of stock.
 *
 * Uses SAS (Shorter Axis Split): the cut runs along the shorter leftover
 * dimension, which tends to leave the most usable strip for the next part.
 * Reference: Jukka Jylänki, "A Thousand Ways to Pack the Bin", §4.
 */
class GuillotineBin implements BinPacker {
  binW: number;
  binH: number;
  free: FreeRect[];
  cuts: Cut[] = [];

  constructor(w: number, h: number) {
    this.binW = w;
    this.binH = h;
    this.free = [{ x: 0, y: 0, w, h, depth: 0 }];
  }

  insert(w: number, h: number, allowRotate: boolean, heur: Heuristic): PackPlacement | null {
    // Find best-scoring free rect (same heuristic as MaxRects).
    let bestIdx = -1;
    let best: ScoredPlacement | null = null;
    for (let i = 0; i < this.free.length; i++) {
      const f = this.free[i];
      if (w <= f.w && h <= f.h) {
        const cand = score(f.x, f.y, w, h, f, false, heur);
        if (!best || better(cand, best)) { best = cand; bestIdx = i; }
      }
      if (allowRotate && h <= f.w && w <= f.h) {
        const cand = score(f.x, f.y, h, w, f, true, heur);
        if (!best || better(cand, best)) { best = cand; bestIdx = i; }
      }
    }
    if (!best) return null;

    // Remove the chosen free rect, replace with at most two new rects via
    // SAS split, AND record the 1–2 physical cuts that separate the part
    // from the leftover.
    const f = this.free[bestIdx];
    this.free.splice(bestIdx, 1);
    const parentDepth = f.depth ?? 0;
    recordCuts(this.cuts, f, best.w, best.h, parentDepth);
    const splits = guillotineSplit(f, best.w, best.h, parentDepth + 1);
    for (const s of splits) this.free.push(s);

    return { id: '', x: best.x, y: best.y, w: best.w, h: best.h, rotated: best.rotated };
  }
}

/**
 * Record the cuts that separate a (w × h) part placed at (f.x, f.y) corner
 * from the rest of free rect `f`. Follows the SAS (Shorter Axis Split)
 * order so the FIRST recorded cut produces the wider strip — this is also
 * the cut a track-saw user would naturally do first.
 *
 *   leftoverW < leftoverH → horizontal cut first (across the full width of
 *                           the parent), then a vertical cut within the
 *                           bottom strip.
 *   leftoverW ≥ leftoverH → vertical cut first (across full height), then
 *                           horizontal within the left strip.
 *
 * Depending on whether the part fills one dimension exactly, this may emit
 * 0, 1, or 2 cuts.
 */
function recordCuts(cuts: Cut[], f: FreeRect, w: number, h: number, parentDepth: number) {
  const leftoverW = f.w - w;
  const leftoverH = f.h - h;
  if (leftoverW <= 0 && leftoverH <= 0) return; // perfect fit, no cut needed

  if (leftoverW <= 0) {
    // Only horizontal cut needed (part fills the full width)
    cuts.push({
      parentX: f.x, parentY: f.y, parentW: f.w, parentH: f.h,
      axis: 'H', distance: h, depth: parentDepth,
    });
    return;
  }
  if (leftoverH <= 0) {
    // Only vertical cut needed (part fills the full height)
    cuts.push({
      parentX: f.x, parentY: f.y, parentW: f.w, parentH: f.h,
      axis: 'V', distance: w, depth: parentDepth,
    });
    return;
  }

  if (leftoverW < leftoverH) {
    // Horizontal cut first across the full parent width
    cuts.push({
      parentX: f.x, parentY: f.y, parentW: f.w, parentH: f.h,
      axis: 'H', distance: h, depth: parentDepth,
    });
    // Then vertical cut within the resulting BOTTOM strip (width = f.w, height = h)
    cuts.push({
      parentX: f.x, parentY: f.y, parentW: f.w, parentH: h,
      axis: 'V', distance: w, depth: parentDepth + 1,
    });
  } else {
    // Vertical cut first across the full parent height
    cuts.push({
      parentX: f.x, parentY: f.y, parentW: f.w, parentH: f.h,
      axis: 'V', distance: w, depth: parentDepth,
    });
    // Then horizontal cut within the resulting LEFT strip (width = w, height = f.h)
    cuts.push({
      parentX: f.x, parentY: f.y, parentW: w, parentH: f.h,
      axis: 'H', distance: h, depth: parentDepth + 1,
    });
  }
}

/**
 * Split a free rect by a part placed at its (x, y) corner, picking the cut
 * axis with Shorter Axis Split: cut along the shorter leftover dimension so
 * the wider strip stays whole for the next part.
 *
 * The part occupies the (f.x, f.y, w, h) corner. We return up to 2 free
 * rects representing the leftover area, divided by one edge-to-edge cut.
 * Children inherit `childDepth` so the cut tree stays connected.
 */
function guillotineSplit(f: FreeRect, w: number, h: number, childDepth: number): FreeRect[] {
  const leftoverW = f.w - w; // strip to the right of the part
  const leftoverH = f.h - h; // strip below the part
  const out: FreeRect[] = [];
  if (leftoverW < leftoverH) {
    // Horizontal cut below the part — bottom strip spans the full width.
    if (leftoverW > 0) {
      out.push({ x: f.x + w, y: f.y, w: leftoverW, h, depth: childDepth + 1 });
    }
    if (leftoverH > 0) {
      out.push({ x: f.x, y: f.y + h, w: f.w, h: leftoverH, depth: childDepth });
    }
  } else {
    // Vertical cut right of the part — right strip spans the full height.
    if (leftoverH > 0) {
      out.push({ x: f.x, y: f.y + h, w, h: leftoverH, depth: childDepth + 1 });
    }
    if (leftoverW > 0) {
      out.push({ x: f.x + w, y: f.y, w: leftoverW, h: f.h, depth: childDepth });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------
function score(
  x: number,
  y: number,
  w: number,
  h: number,
  f: FreeRect,
  rotated: boolean,
  heur: Heuristic,
): ScoredPlacement {
  const leftoverW = f.w - w;
  const leftoverH = f.h - h;
  let s1: number, s2: number;
  switch (heur) {
    case 'BSSF':
      s1 = Math.min(leftoverW, leftoverH);
      s2 = Math.max(leftoverW, leftoverH);
      break;
    case 'BLSF':
      s1 = Math.max(leftoverW, leftoverH);
      s2 = Math.min(leftoverW, leftoverH);
      break;
    case 'BAF':
      // Real wasted area: free-rect area minus part area (lower is better).
      // The earlier "leftoverW * leftoverH" was a corner-sliver proxy that
      // tied 0 whenever the part filled either dimension exactly — losing
      // the heuristic's discrimination on snug fits.
      s1 = f.w * f.h - w * h;
      s2 = Math.min(leftoverW, leftoverH);
      break;
    case 'BL':
    default:
      s1 = y + h;          // bottom edge — lower is better
      s2 = x;              // then leftmost
      break;
  }
  return { x, y, w, h, rotated, score1: s1, score2: s2 };
}

function better(a: ScoredPlacement, b: ScoredPlacement): boolean {
  if (a.score1 !== b.score1) return a.score1 < b.score1;
  return a.score2 < b.score2;
}

// ---------------------------------------------------------------------------
// Free-rect maintenance
// ---------------------------------------------------------------------------
function splitFreeRect(f: FreeRect, used: Rect): FreeRect[] | null {
  if (used.x >= f.x + f.w || used.x + used.w <= f.x ||
      used.y >= f.y + f.h || used.y + used.h <= f.y) {
    return null;
  }
  const out: FreeRect[] = [];
  // Sliver below
  if (used.y > f.y && used.y < f.y + f.h) {
    out.push({ x: f.x, y: f.y, w: f.w, h: used.y - f.y });
  }
  // Sliver above
  if (used.y + used.h < f.y + f.h && used.y + used.h > f.y) {
    out.push({ x: f.x, y: used.y + used.h, w: f.w, h: f.y + f.h - (used.y + used.h) });
  }
  // Sliver left
  if (used.x > f.x && used.x < f.x + f.w) {
    out.push({ x: f.x, y: f.y, w: used.x - f.x, h: f.h });
  }
  // Sliver right
  if (used.x + used.w < f.x + f.w && used.x + used.w > f.x) {
    out.push({ x: used.x + used.w, y: f.y, w: f.x + f.w - (used.x + used.w), h: f.h });
  }
  return out;
}

function prune(rects: FreeRect[]): FreeRect[] {
  // Drop any rect fully contained inside another.
  const kept: FreeRect[] = [];
  for (let i = 0; i < rects.length; i++) {
    let dominated = false;
    for (let j = 0; j < rects.length; j++) {
      if (i === j) continue;
      if (contains(rects[j], rects[i])) { dominated = true; break; }
    }
    if (!dominated) kept.push(rects[i]);
  }
  return kept;
}

function contains(a: FreeRect, b: FreeRect): boolean {
  return b.x >= a.x && b.y >= a.y &&
         b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;
}

// ---------------------------------------------------------------------------
// Public API: pack a list of items into 1+ sheets
// ---------------------------------------------------------------------------
export interface PackJob {
  items: PackInput[];      // each = ONE instance (expand qty upstream)
  sheetW: number;          // usable sheet width (after edge margin)
  sheetH: number;          // usable sheet height
  kerf: number;            // mm — added to each item's footprint
  /** Default 'free' (MaxRects). 'guillotine' = track-saw friendly cuts. */
  cutStrategy?: CutStrategy;
}

export interface PackedSheet {
  placements: PackPlacement[];
  usedArea: number;        // actual part area (un-kerfed)
  /** Largest remaining free rectangle on this sheet, in mm. Useful as
   *  "what could I cut from the leftover" for the user. */
  largestFree: { w: number; h: number } | null;
  /** Physical cuts that produced this layout, in dependency order
   *  (depth-sorted: full-sheet cuts first, then sub-piece cuts).
   *  Empty for MaxRects packing (which isn't guaranteed guillotine). */
  cuts: Cut[];
}

export interface MultiSheetResult {
  sheets: PackedSheet[];
  unplaced: PackInput[];
  totalUsed: number;
}

/**
 * Pack until everything fits, opening new sheets as needed.
 *
 * Key insight (from SVGnest's placement worker — Jack Qiao's
 * placementworker.js): when a part doesn't fit on the current bin, SKIP
 * IT and try the NEXT part — do NOT close the bin. A bin is only closed
 * when no remaining part can be placed on it. A single tall part shouldn't
 * end a sheet that still has plenty of room for shorter parts.
 *
 * This fixes the dominant "uses too many sheets" symptom in the previous
 * implementation, which closed the bin on the very first non-fit.
 *
 * Heuristic + initial order are deterministic for a given input; the
 * multi-restart wrapper varies both to explore the solution space.
 */
export function packOne(job: PackJob, heur: Heuristic, order: PackInput[]): MultiSheetResult {
  const sheets: PackedSheet[] = [];
  const unplaced: PackInput[] = [];
  let totalUsed = 0;

  // Items that haven't been placed yet — we keep refilling bins from this pool.
  let remaining = order.slice();

  // Items that are physically larger than even an empty bin (even rotated).
  remaining = remaining.filter((item) => {
    const w = item.w + job.kerf;
    const h = item.h + job.kerf;
    const fitsAsIs = w <= job.sheetW && h <= job.sheetH;
    const fitsRotated = item.allowRotate && h <= job.sheetW && w <= job.sheetH;
    if (!fitsAsIs && !fitsRotated) {
      unplaced.push(item);
      return false;
    }
    return true;
  });

  while (remaining.length > 0) {
    const bin: BinPacker = job.cutStrategy === 'guillotine'
      ? new GuillotineBin(job.sheetW, job.sheetH)
      : new MaxRectsBin(job.sheetW, job.sheetH);
    const cur: PackedSheet = { placements: [], usedArea: 0, largestFree: null, cuts: [] };
    const carry: PackInput[] = []; // didn't fit on THIS bin → try next bin
    let anyPlacedThisBin = false;

    for (const item of remaining) {
      const w = item.w + job.kerf;
      const h = item.h + job.kerf;
      const placed = bin.insert(w, h, item.allowRotate, heur);
      if (!placed) {
        carry.push(item);
        continue;
      }
      const halfKerf = job.kerf / 2;
      const actualW = placed.w - job.kerf;
      const actualH = placed.h - job.kerf;
      cur.placements.push({
        id: item.id,
        x: placed.x + halfKerf,
        y: placed.y + halfKerf,
        w: actualW,
        h: actualH,
        rotated: placed.rotated,
      });
      cur.usedArea += actualW * actualH;
      anyPlacedThisBin = true;
    }

    if (anyPlacedThisBin) {
      // Snapshot the largest remaining free rectangle (by area).
      let best: { w: number; h: number; a: number } | null = null;
      for (const f of bin.free) {
        const a = f.w * f.h;
        if (!best || a > best.a) best = { w: f.w, h: f.h, a };
      }
      cur.largestFree = best ? { w: best.w, h: best.h } : null;
      // Capture cut tree, ordered by depth (big cuts on the full sheet
      // first → smaller cuts within strips). Stable order within a depth.
      cur.cuts = bin.cuts.slice().sort((a, b) => {
        if (a.depth !== b.depth) return a.depth - b.depth;
        // Tiebreak by position so multiple cuts at the same depth read
        // left-to-right, top-to-bottom.
        if (a.parentY !== b.parentY) return a.parentY - b.parentY;
        return a.parentX - b.parentX;
      });
      sheets.push(cur);
      totalUsed += cur.usedArea;
    } else {
      // No item from `remaining` could be placed on a fresh empty bin —
      // they're all unplaceable. (Shouldn't reach here because we filtered
      // truly-too-big items above; defensive guard against infinite loop.)
      for (const item of remaining) unplaced.push(item);
      break;
    }
    remaining = carry;
  }

  return { sheets, unplaced, totalUsed };
}

/**
 * Multi-restart optimizer: shuffles insertion order + tries different
 * heuristics, keeps the best result by (fewest unplaced → fewest sheets
 * → highest fill on last sheet).
 */
export function packMulti(job: PackJob, restarts: number): MultiSheetResult {
  const heuristics: Heuristic[] = ['BSSF', 'BLSF', 'BAF', 'BL'];

  // Baseline: area-descending — the standard first-fit-decreasing order.
  const baseline = job.items.slice().sort((a, b) => b.w * b.h - a.w * a.h);

  let best: MultiSheetResult | null = null;
  const tryOrder = (order: PackInput[], heur: Heuristic) => {
    const r = packOne(job, heur, order);
    if (!best || isBetter(r, best)) best = r;
  };

  // Phase 1: try every heuristic with the baseline order
  for (const h of heuristics) tryOrder(baseline, h);

  // Phase 2: also try longest-side-descending order
  const bySide = job.items.slice().sort(
    (a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h),
  );
  for (const h of heuristics) tryOrder(bySide, h);

  // Phase 3: random shuffles, capped by restarts budget.
  let seed = 0x9e3779b1;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
  const phase3 = Math.max(0, restarts - heuristics.length * 2);
  for (let i = 0; i < phase3; i++) {
    const shuffled = baseline.slice();
    for (let k = shuffled.length - 1; k > 0; k--) {
      const j = Math.floor(rand() * (k + 1));
      [shuffled[k], shuffled[j]] = [shuffled[j], shuffled[k]];
    }
    const heur = heuristics[i % heuristics.length];
    tryOrder(shuffled, heur);
  }

  return best!;
}

function isBetter(a: MultiSheetResult, b: MultiSheetResult): boolean {
  if (a.unplaced.length !== b.unplaced.length) return a.unplaced.length < b.unplaced.length;
  if (a.sheets.length !== b.sheets.length) return a.sheets.length < b.sheets.length;
  // More fill on the last sheet = tighter pack
  const aLast = a.sheets.length ? a.sheets[a.sheets.length - 1].usedArea : 0;
  const bLast = b.sheets.length ? b.sheets[b.sheets.length - 1].usedArea : 0;
  return aLast > bLast;
}
