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
 * 'guillotine'  = "Min cuts" — shelf/SAS packers plus a beam search over
 *                  guillotine cut trees, all edge-to-edge cuts, track-saw and
 *                  panel-saw friendly.
 * 'free'        = "Max utilization" — MaxRects, any cut, highest yield.
 * 'cnc'         = "CNC nest" — true-shape any-angle nesting for router /
 *                  waterjet (handled by cncNest.ts, NOT this rectangle
 *                  packer). Listed here so the strategy type is shared;
 *                  nest.ts dispatches it before the rectangle path runs.
 *
 * Two earlier strategies were folded away rather than kept as options:
 *
 *   'guillotine-exact' — the beam search is now part of 'guillotine'. On the
 *     benchmark it bought 0.10 sheets for 7× the time (506ms vs 75ms), which
 *     is worth spending but not worth asking the user to predict.
 *   'save-last' — clustering the last sheet's parts into one corner so the
 *     remnant is a clean rectangle is now DEFAULT for every strategy, per
 *     thickness group. It is a post-process and costs nothing: measured at
 *     the same +0.75 sheets over the area bound as 'free'.
 */
export type CutStrategy = 'free' | 'guillotine' | 'cnc';

/** Legacy persisted values → the strategy that absorbed them. */
export function migrateCutStrategy(s: string | null | undefined): CutStrategy {
  if (s === 'guillotine' || s === 'free' || s === 'cnc') return s;
  if (s === 'guillotine-exact') return 'guillotine';
  if (s === 'save-last') return 'free';
  return 'guillotine';
}

/** True for the CNC (true-shape) strategy — dispatched to cncNest.ts. */
export function isCncStrategy(s: CutStrategy): boolean {
  return s === 'cnc';
}

/** True for the min-cuts (panel-saw) strategy. */
export function isGuillotineStrategy(s: CutStrategy | undefined): boolean {
  return s === 'guillotine';
}

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

  /** Best placement for this rect WITHOUT taking it — used by the global
   *  best-fit selector, which has to score every remaining part against the
   *  bin before choosing one. */
  probe(w: number, h: number, allowRotate: boolean, heur: Heuristic): ScoredPlacement | null {
    return this.findBest(w, h, allowRotate, heur);
  }

  /** Take a placement previously returned by `probe`. */
  take(cand: ScoredPlacement): PackPlacement {
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
    this.occupy({ x: r.x, y: r.y, w: r.w, h: r.h });
  }

  /** Mark an arbitrary rect as used. Public so a finished sheet's layout can
   *  be rebuilt into a live bin (consolidation re-inserts into its free space). */
  occupy(placedRect: Rect) {
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
 * SHELF bin packer — true min-cuts strategy.
 *
 * Parts are packed into horizontal "shelves" (strips) using First-Fit
 * Decreasing Height (FFDH): try each existing shelf in order, open a new
 * one only when none fit. The classic shelf strategy for guillotine
 * cutting (Jylänki §3.2) — produces the fewest cuts because every shelf
 * boundary is a single full-sheet rip, and within each shelf, every part
 * boundary is a single crosscut.
 *
 * Cuts are emitted post-hoc (after all parts are placed) in saw-shop
 * order: all horizontal rips first (separating shelves on the full sheet),
 * then per-shelf vertical crosscuts (separating parts left-to-right). This
 * matches how a panel-saw or track-saw operator actually cuts.
 *
 * Trade-off vs MaxRects/SAS: shelf packing can leave taller-than-needed
 * gaps within a shelf (the "wasted vertical space" problem), so yield
 * tends to be 5–15% lower than MaxRects on heterogeneous height mixes.
 * But cut count drops sharply — exactly what the "Min cuts" strategy
 * promises.
 */
class ShelfBin implements BinPacker {
  binW: number;
  binH: number;
  free: FreeRect[] = []; // synthesized in finalize() for the largestFree report
  cuts: Cut[] = [];      // populated by finalize()
  private shelves: { y: number; h: number; usedW: number }[] = [];
  /** Per-placement: which shelf and (x, w) along it. Used by finalize(). */
  private partsByShelf: { shelf: number; x: number; w: number }[][] = [];

  constructor(w: number, h: number) {
    this.binW = w;
    this.binH = h;
  }

  insert(w: number, h: number, allowRotate: boolean, _heur: Heuristic): PackPlacement | null {
    // 1. Try every existing shelf — First-Fit Decreasing Height.
    //    Prefer the orientation that fits the shelf TIGHTER (smaller wasted
    //    height inside the shelf) — keeps shelves from accidentally locking
    //    in a tall part that wastes vertical space on the rest of the row.
    for (let i = 0; i < this.shelves.length; i++) {
      const sh = this.shelves[i];
      const okUnrot = sh.usedW + w <= this.binW && h <= sh.h;
      const okRot   = allowRotate && sh.usedW + h <= this.binW && w <= sh.h;
      if (!okUnrot && !okRot) continue;
      // When both fit, prefer the orientation that uses LESS shelf width —
      // packs more parts per shelf, reducing per-shelf vertical cuts.
      const preferUnrot = okUnrot && (!okRot || w <= h);
      if (preferUnrot) {
        const x = sh.usedW;
        sh.usedW += w;
        this.partsByShelf[i].push({ shelf: i, x, w });
        return { id: '', x, y: sh.y, w, h, rotated: false };
      }
      const x = sh.usedW;
      sh.usedW += h;
      this.partsByShelf[i].push({ shelf: i, x, w: h });
      return { id: '', x, y: sh.y, w: h, h: w, rotated: true };
    }
    // 2. Open a new shelf above the last one.
    const top = this.shelves.length > 0
      ? this.shelves[this.shelves.length - 1].y + this.shelves[this.shelves.length - 1].h
      : 0;
    const remH = this.binH - top;
    const fitsUnrot = h <= remH && w <= this.binW;
    const fitsRot   = allowRotate && w <= remH && h <= this.binW;
    if (!fitsUnrot && !fitsRot) return null;

    // Rotation preference for a NEW shelf:
    //   - In PORTRAIT bins (binH > binW), put the long edge VERTICAL so the
    //     shelf becomes "tall" and the part eats less binW — leaving room for
    //     more parts in the same shelf. This is the variant that reduces cut
    //     count the most in practice.
    //   - In LANDSCAPE bins (binW > binH), put the long edge HORIZONTAL so
    //     the shelf stays "short" and we can stack more shelves vertically.
    const portraitBin = this.binH > this.binW;
    const longEdgeIsW = w >= h;
    const wantLongVertical = portraitBin;
    const preferRot = allowRotate && (wantLongVertical ? longEdgeIsW : !longEdgeIsW);

    const useRot = preferRot ? fitsRot : !fitsUnrot && fitsRot;
    if (useRot) {
      const shelfIdx = this.shelves.length;
      this.shelves.push({ y: top, h: w, usedW: h });
      this.partsByShelf.push([{ shelf: shelfIdx, x: 0, w: h }]);
      return { id: '', x: 0, y: top, w: h, h: w, rotated: true };
    }
    // Default: un-rotated
    const shelfIdx = this.shelves.length;
    this.shelves.push({ y: top, h, usedW: w });
    this.partsByShelf.push([{ shelf: shelfIdx, x: 0, w }]);
    return { id: '', x: 0, y: top, w, h, rotated: false };
  }

  /**
   * Compute the cut sequence + free-rect snapshot AFTER all parts are placed.
   * Called once by packOne when the bin is closed.
   *
   * Cut order (saw-shop friendly):
   *   1. All horizontal rips on the FULL sheet → produces N strips.
   *      (N rips when there's top waste, N-1 when shelves fill exactly.)
   *   2. For each strip, vertical crosscuts → produces parts + right waste.
   */
  finalize() {
    // ---- Cuts ----
    this.cuts = [];
    const N = this.shelves.length;
    if (N === 0) return;

    const totalShelfH = this.shelves[N - 1].y + this.shelves[N - 1].h;
    const hasTopWaste = totalShelfH < this.binH - 0.001;

    // Phase 1: full-sheet horizontal rips.
    // Parent rect for cut k spans the un-cut portion above shelves[0..k-1].
    let parentY = 0;
    let parentH = this.binH;
    // We emit one rip per gap between shelves. If there's top waste we ALSO
    // need a rip to separate the last shelf from the waste. So the total is
    // N rips if hasTopWaste else N-1.
    const rips = hasTopWaste ? N : N - 1;
    for (let i = 0; i < rips; i++) {
      this.cuts.push({
        parentX: 0, parentY, parentW: this.binW, parentH,
        axis: 'H', distance: this.shelves[i].h, depth: 0,
      });
      parentY += this.shelves[i].h;
      parentH -= this.shelves[i].h;
    }

    // Phase 2: per-shelf vertical crosscuts.
    for (let i = 0; i < N; i++) {
      const sh = this.shelves[i];
      const parts = this.partsByShelf[i].slice().sort((a, b) => a.x - b.x);
      let stripX = 0;
      let stripW = this.binW;
      for (let j = 0; j < parts.length; j++) {
        const p = parts[j];
        const rightEdge = p.x + p.w;
        const isLast = j === parts.length - 1;
        // Last part fills the shelf → no trailing cut needed.
        if (isLast && rightEdge >= this.binW - 0.001) continue;
        this.cuts.push({
          parentX: stripX, parentY: sh.y, parentW: stripW, parentH: sh.h,
          axis: 'V', distance: rightEdge - stripX, depth: 1,
        });
        stripX = rightEdge;
        stripW = this.binW - rightEdge;
      }
    }

    // ---- Free-rect snapshot (largestFree report) ----
    const free: FreeRect[] = [];
    for (const sh of this.shelves) {
      if (sh.usedW < this.binW - 0.001) {
        free.push({ x: sh.usedW, y: sh.y, w: this.binW - sh.usedW, h: sh.h });
      }
    }
    if (hasTopWaste) {
      free.push({ x: 0, y: totalShelfH, w: this.binW, h: this.binH - totalShelfH });
    }
    this.free = free;
  }
}

/**
 * ShelfBin rotated 90° — strips run VERTICALLY (rip cuts along the sheet's
 * short axis) instead of horizontally. A human picks the strip direction to
 * match the parts; the optimiser tries both and keeps the better one.
 *
 * Implemented as a coordinate-transposing wrapper: pack into an inner
 * ShelfBin whose bin is (h × w), then mirror every rect across the x=y
 * diagonal on the way out. A part's real orientation is preserved: the
 * (w, h) footprint goes in as (h, w) and the double swap cancels, so the
 * inner bin's `rotated` flag maps through unchanged.
 */
class ShelfBinV implements BinPacker {
  binW: number;
  binH: number;
  free: FreeRect[] = [];
  cuts: Cut[] = [];
  private inner: ShelfBin;

  constructor(w: number, h: number) {
    this.binW = w;
    this.binH = h;
    this.inner = new ShelfBin(h, w);
  }

  insert(w: number, h: number, allowRotate: boolean, heur: Heuristic): PackPlacement | null {
    const p = this.inner.insert(h, w, allowRotate, heur);
    if (!p) return null;
    return { id: '', x: p.y, y: p.x, w: p.h, h: p.w, rotated: p.rotated };
  }

  finalize() {
    this.inner.finalize();
    this.free = this.inner.free.map((f) => ({ x: f.y, y: f.x, w: f.h, h: f.w, depth: f.depth }));
    this.cuts = this.inner.cuts.map((c) => ({
      parentX: c.parentY, parentY: c.parentX,
      parentW: c.parentH, parentH: c.parentW,
      axis: c.axis === 'H' ? 'V' as const : 'H' as const,
      distance: c.distance,
      depth: c.depth,
    }));
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
 *
 * Kept alongside ShelfBin so packMulti can try both and keep whichever
 * produces fewer cuts for the same sheet count.
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
  recordCutsAxis(cuts, f, w, h, parentDepth, leftoverW < leftoverH ? 'H' : 'V');
}

/** recordCuts with the primary (full-span) cut axis chosen by the CALLER —
 *  the beam search branches on this choice instead of fixing SAS. */
function recordCutsAxis(cuts: Cut[], f: FreeRect, w: number, h: number, parentDepth: number, primary: 'H' | 'V') {
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

  if (primary === 'H') {
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
  return guillotineSplitAxis(f, w, h, childDepth, f.w - w < f.h - h ? 'H' : 'V');
}

/** guillotineSplit with the primary cut axis chosen by the CALLER — must be
 *  paired with recordCutsAxis using the SAME axis so cuts match free rects. */
function guillotineSplitAxis(f: FreeRect, w: number, h: number, childDepth: number, primary: 'H' | 'V'): FreeRect[] {
  const leftoverW = f.w - w; // strip to the right of the part
  const leftoverH = f.h - h; // strip below the part
  const out: FreeRect[] = [];
  if (primary === 'H') {
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

/**
 * Recover a guillotine cut tree from an ARBITRARY set of non-overlapping
 * placed rectangles — i.e. a MaxRects ('free' / 'save-last') layout, which
 * maximises yield but tracks no cut tree of its own. Most such layouts are
 * still fully guillotine-cuttable; we just have to FIND the cut sequence.
 *
 * Why this exists: without it the cut sequence for non-guillotine strategies
 * fell back to "one full-sheet line per unique part edge", which slices
 * straight through any neighbouring panel that doesn't share that edge.
 * Here every cut is edge-to-edge across its OWN sub-piece, so it never
 * crosses a panel (for guillotine-separable layouts — the common case).
 *
 * Algorithm — recursive edge-to-edge decomposition. In each region, pick a
 * full-span line lying on an existing part edge that splits the region in
 * two, then recurse on each half. The line is chosen to
 *   (1) not slice through any part (a "clean" line),
 *   (2) prefer separating two part groups over merely trimming waste,
 *   (3) split as evenly as possible, then sit nearest the reference edge.
 * A region holding a single part that fills it needs no cut — recursion ends.
 *
 * Cuts are ONLY ever placed where they cross no part — so a cut never slices
 * an adjacent panel. Non-guillotine arrangements (e.g. a 4-part pinwheel)
 * have no clean line in some sub-region; we make every clean cut that IS
 * possible (which still peels off everything separable) and stop at the
 * irreducible block, leaving its few interlocked parts joined rather than
 * sawing through one. This is rare for rectangular sheet-good layouts, and
 * 'free' mode is explicitly "any cuts / max yield" — users wanting a fully
 * edge-to-edge sequence pick the 'guillotine' (min-cuts) strategy.
 *
 * `rects` and the returned cuts are in the bin's native (kerf-inflated)
 * frame — the same frame GuillotineBin/ShelfBin use — so callers downstream
 * (margin shift in nest.ts, cutStepsForSheet) treat all strategies alike.
 */
/** Stock narrower than this (~6") is awkward under a track-saw rail — the
 *  rail overhangs and tips. Cut choice and the optimiser both avoid making
 *  the user run the saw over such pieces when an alternative exists. */
const AWKWARD_MM = 150;

/** An empty strip at least this wide (both dimensions) is a REUSABLE offcut —
 *  the sequence frees it first, whole, so it can be racked for a later job. */
const REUSABLE_MM = 200;

/**
 * Put thin strips toward the sheet TOP (bin y=0 renders as the display top):
 * if the thin parts sit below the wide ones, mirror the whole layout
 * vertically. A guillotine layout stays guillotine under a mirror, and the
 * cut sequence then shaves the fiddly strips off the top edge while the
 * stock underneath is still big enough to carry the rail.
 * Mutates `placements` (part frame) and `inflated` (kerf frame) in step.
 */
function thinStripsTop(placements: PackPlacement[], inflated: Rect[], binH: number): void {
  if (placements.length === 0) return;
  let thinA = 0, thinY = 0, wideA = 0, wideY = 0;
  for (const p of placements) {
    const a = p.w * p.h, cy = p.y + p.h / 2;
    if (Math.min(p.w, p.h) < AWKWARD_MM) { thinA += a; thinY += a * cy; }
    else { wideA += a; wideY += a * cy; }
  }
  if (thinA > 0 && wideA > 0 && thinY / thinA > wideY / wideA) {
    for (const p of placements) p.y = binH - p.y - p.h;
    for (const r of inflated) r.y = binH - r.y - r.h;
  }
  // Anchor the layout flush to the reference corner: measurements run from
  // the two trimmed reference edges, so no waste may sit between them and
  // the first parts (a uniform shift keeps any guillotine tree valid).
  let minX = Infinity, minY = Infinity;
  for (const r of inflated) { minX = Math.min(minX, r.x); minY = Math.min(minY, r.y); }
  if (minX > 0.001 || minY > 0.001) {
    for (const p of placements) { p.x -= minX; p.y -= minY; }
    for (const r of inflated) { r.x -= minX; r.y -= minY; }
  }
}

export function deriveGuillotineCuts(rects: Rect[], binW: number, binH: number): Cut[] {
  const EPS = 0.5; // mm — tolerant of STEP-tessellation float noise on edges
  // A clean tree needs < 2·N cuts; cap well above that so a pathological
  // input can never spin (every cut is expected to make progress anyway).
  const maxCuts = rects.length * 6 + 16;
  let nodeCount = 0;

  interface Line {
    axis: 'H' | 'V';
    coord: number;     // absolute cut coordinate (X for V, Y for H)
    separates: boolean; // whole parts on BOTH sides (vs. trimming waste)
    thinBad: boolean;  // creates a piece thinner than AWKWARD_MM that still needs cuts
    offcut: number;    // area of a clean REUSABLE strip this line frees (0 = none)
    thinShave: boolean; // frees a FINISHED thin part in one pass off big stock
    balance: number;   // |partsOnOneSide − partsOnOther|, lower = more even
    pieceMin: number;  // the split's smaller span — bigger = no sliver piece
    dist: number;      // distance from the WORK edge (TOP for H, left for V)
  }

  const betterLine = (a: Line, b: Line): boolean => {
    // Free a big unused strip FIRST — it goes to the offcut rack clean and
    // whole instead of staying attached (or getting crossed) while the parts
    // are broken down. Bigger saved strip wins.
    if ((a.offcut > 0) !== (b.offcut > 0)) return a.offcut > 0;
    if (a.offcut > 0 && Math.abs(a.offcut - b.offcut) > EPS) return a.offcut > b.offcut;
    // Then shave thin finished strips off while the stock is still big — the
    // rail rests on the wide remainder and the strip falls away done. Waiting
    // only shrinks the piece the track has to sit on.
    if (a.thinShave !== b.thinShave) return a.thinShave;
    if (a.separates !== b.separates) return a.separates;               // real splits before trims
    if (a.thinBad !== b.thinBad) return !a.thinBad;                    // don't strand cuts on skinny stock
    if (Math.abs(a.balance - b.balance) > EPS) return a.balance < b.balance; // even split
    if (Math.abs(a.pieceMin - b.pieceMin) > EPS) return a.pieceMin > b.pieceMin; // keep pieces big
    return a.dist < b.dist;                                            // then nearest work edge
  };

  // Best CLEAN full-span line for one region (one that slices no part), or
  // null if none exists — meaning the region is either a single part that
  // fills it, or an irreducible non-guillotine block we leave intact.
  const pickLine = (rx: number, ry: number, rw: number, rh: number, items: Rect[]): Line | null => {
    const vSet = new Set<number>(); // candidate X coords (vertical cuts)
    const hSet = new Set<number>(); // candidate Y coords (horizontal cuts)
    for (const it of items) {
      if (it.x       > rx + EPS && it.x       < rx + rw - EPS) vSet.add(it.x);
      if (it.x + it.w > rx + EPS && it.x + it.w < rx + rw - EPS) vSet.add(it.x + it.w);
      if (it.y       > ry + EPS && it.y       < ry + rh - EPS) hSet.add(it.y);
      if (it.y + it.h > ry + EPS && it.y + it.h < ry + rh - EPS) hSet.add(it.y + it.h);
    }
    let best: Line | null = null;
    const consider = (axis: 'H' | 'V', coord: number) => {
      const loItems: Rect[] = [], hiItems: Rect[] = [];
      for (const it of items) {
        const a = axis === 'V' ? it.x : it.y;
        const b = axis === 'V' ? it.x + it.w : it.y + it.h;
        if (b <= coord + EPS) loItems.push(it);        // wholly below/left
        else if (a >= coord - EPS) hiItems.push(it);   // wholly above/right
        else return;                                   // straddler → not clean
      }
      const spanLo = axis === 'V' ? coord - rx : coord - ry;
      const spanHi = axis === 'V' ? rx + rw - coord : ry + rh - coord;
      // A side "still needs cuts" unless it's pure waste or exactly one part
      // filling it. Cutting a sub-AWKWARD piece again means running the rail
      // on skinny stock — the thing track-saw users avoid.
      const needsCuts = (side: Rect[], sx: number, sy: number, sw: number, sh: number): boolean => {
        if (side.length === 0) return false;
        if (side.length > 1) return true;
        const it = side[0];
        return Math.abs(it.x - sx) > EPS || Math.abs(it.y - sy) > EPS ||
               Math.abs(it.w - sw) > EPS || Math.abs(it.h - sh) > EPS;
      };
      const thinBad =
        (spanLo < AWKWARD_MM && (axis === 'V'
          ? needsCuts(loItems, rx, ry, spanLo, rh)
          : needsCuts(loItems, rx, ry, rw, spanLo))) ||
        (spanHi < AWKWARD_MM && (axis === 'V'
          ? needsCuts(hiItems, coord, ry, spanHi, rh)
          : needsCuts(hiItems, rx, coord, rw, spanHi)));
      // A side with NO parts and a decent width is a reusable offcut — worth
      // freeing before anything else so it can be saved for a later job.
      // Strips narrower than REUSABLE_MM are just waste; don't chase them.
      const crossSpan = axis === 'V' ? rh : rw;
      let offcut = 0;
      if (!thinBad) {
        if (loItems.length === 0 && Math.min(spanLo, crossSpan) >= REUSABLE_MM) offcut = spanLo * crossSpan;
        else if (hiItems.length === 0 && Math.min(spanHi, crossSpan) >= REUSABLE_MM) offcut = spanHi * crossSpan;
      }
      // A thin side holding a FINISHED part (no further cuts needed on it) is
      // a shave: one pass frees the strip while the rail rides the big side.
      const shaveLo = spanLo < AWKWARD_MM && loItems.length > 0 && !(axis === 'V'
        ? needsCuts(loItems, rx, ry, spanLo, rh)
        : needsCuts(loItems, rx, ry, rw, spanLo));
      const shaveHi = spanHi < AWKWARD_MM && hiItems.length > 0 && !(axis === 'V'
        ? needsCuts(hiItems, coord, ry, spanHi, rh)
        : needsCuts(hiItems, rx, coord, rw, spanHi));
      const line: Line = {
        axis, coord,
        separates: loItems.length > 0 && hiItems.length > 0,
        thinBad,
        offcut,
        thinShave: !thinBad && (shaveLo || shaveHi),
        balance: Math.abs(loItems.length - hiItems.length),
        // Both sub-pieces keep the region's other span; the cut only narrows
        // one axis — its smaller side is the sliver risk.
        pieceMin: Math.min(spanLo, spanHi),
        // Track-saw work order runs TOP-to-bottom: for H lines prefer the
        // one nearest the TOP edge; for V lines nearest the left.
        dist: axis === 'V' ? coord - rx : ry + rh - coord,
      };
      if (!best || betterLine(line, best)) best = line;
    };
    vSet.forEach((c) => consider('V', c));
    hSet.forEach((c) => consider('H', c));
    return best;
  };

  // The tree is built with explicit children so the emission pass below can
  // reorder cuts for a parallel-guide workflow without losing the hard
  // constraint that a cut's parent piece must already exist.
  interface CutNode { cut: Cut; children: CutNode[] }

  const decompose = (rx: number, ry: number, rw: number, rh: number, items: Rect[], depth: number): CutNode | null => {
    if (items.length === 0 || nodeCount >= maxCuts) return null;
    const line = pickLine(rx, ry, rw, rh, items);
    // null → a single part fills this region (done), or ≥2 parts interlock
    // with no clean line (irreducible non-guillotine block) — leave intact.
    if (!line) return null;
    nodeCount++;
    let node: CutNode;
    let halves: { x: number; y: number; w: number; h: number; items: Rect[] }[];
    if (line.axis === 'V') {
      const xc = line.coord;
      node = { cut: { parentX: rx, parentY: ry, parentW: rw, parentH: rh, axis: 'V', distance: xc - rx, depth }, children: [] };
      // No straddlers (the line is clean), so an edge test partitions exactly.
      const left: Rect[] = [], right: Rect[] = [];
      for (const it of items) (it.x + it.w <= xc + EPS ? left : right).push(it);
      halves = [
        { x: rx, y: ry, w: xc - rx, h: rh, items: left },
        { x: xc, y: ry, w: rx + rw - xc, h: rh, items: right },
      ];
    } else {
      const yc = line.coord;
      node = { cut: { parentX: rx, parentY: ry, parentW: rw, parentH: rh, axis: 'H', distance: yc - ry, depth }, children: [] };
      const bottom: Rect[] = [], top: Rect[] = [];
      for (const it of items) (it.y + it.h <= yc + EPS ? bottom : top).push(it);
      halves = [
        { x: rx, y: yc, w: rw, h: ry + rh - yc, items: top },
        { x: rx, y: ry, w: rw, h: yc - ry, items: bottom },
      ];
    }
    // Bigger piece first — keeps tie-breaks in the scheduler leaning toward
    // breaking down large stock before fiddling with narrow strips.
    halves.sort((a, b) => b.w * b.h - a.w * a.h);
    for (const s of halves) {
      const child = decompose(s.x, s.y, s.w, s.h, s.items, depth + 1);
      if (child) node.children.push(child);
    }
    return node;
  };

  const root = decompose(0, 0, binW, binH, rects.slice(), 0);

  // Emission order = PARALLEL-GUIDE work order. With flip-stop parallel
  // guides the expensive operations are changing the stop offset and
  // rotating the work 180° between rip and crosscut; repeating a cut at the
  // current setting is just slide-against-the-stops-and-cut. So among the
  // cuts whose parent piece already exists we greedily prefer, in order:
  //   1. same axis AND same distance as the previous cut — the guide is
  //      already set, the cut is nearly free;
  //   2. same axis — no 180° rotation, only the stops move;
  //   3. a child of the previous cut — keep working the piece in hand;
  //   4. the larger parent piece — big breakdown cuts early, while the
  //      stock is manageable; fiddly strips wait until the end.
  // Readiness (parent exists) is the hard constraint the PDF diagrams rely
  // on: every cut acts on a piece an earlier cut produced.
  const cuts: Cut[] = [];
  const ready: CutNode[] = root ? [root] : [];
  let prev: Cut | null = null;
  let prevChildren: CutNode[] = [];
  while (ready.length > 0) {
    let best = 0;
    for (let i = 1; i < ready.length; i++) {
      const a = ready[i].cut, b = ready[best].cut;
      if (prev) {
        const setA = a.axis === prev.axis && Math.abs(a.distance - prev.distance) < EPS;
        const setB = b.axis === prev.axis && Math.abs(b.distance - prev.distance) < EPS;
        if (setA !== setB) { if (setA) best = i; continue; }
        const axA = a.axis === prev.axis, axB = b.axis === prev.axis;
        if (axA !== axB) { if (axA) best = i; continue; }
        const chA = prevChildren.includes(ready[i]), chB = prevChildren.includes(ready[best]);
        if (chA !== chB) { if (chA) best = i; continue; }
      }
      if (a.parentW * a.parentH > b.parentW * b.parentH + EPS) best = i;
    }
    const node = ready.splice(best, 1)[0];
    cuts.push(node.cut);
    prev = node.cut;
    prevChildren = node.children;
    ready.push(...node.children);
  }
  return cuts;
}

/**
 * Replay a (depth-ordered) cut tree over the bin and count parts that end up
 * ALONE in a final piece — i.e. fully freed by the cuts. Equals the part
 * count for a fully guillotine-cuttable layout; lower when parts interlock
 * in a non-guillotine block. Works for any tree (shelf or recovered), so it
 * lets the optimiser compare strategies on a common "cuttability" axis.
 */
function countFreedParts(cuts: Cut[], rects: Rect[], binW: number, binH: number): number {
  const EPS = 0.5;
  interface Reg { x: number; y: number; w: number; h: number; items: number[] }
  let regions: Reg[] = [{ x: 0, y: 0, w: binW, h: binH, items: rects.map((_, i) => i) }];
  for (const c of cuts) {
    const next: Reg[] = [];
    for (const r of regions) {
      // Does this cut act on THIS region? (parent rect matches)
      const hit = Math.abs(r.x - c.parentX) < 1 && Math.abs(r.y - c.parentY) < 1 &&
                  Math.abs(r.w - c.parentW) < 1 && Math.abs(r.h - c.parentH) < 1;
      if (!hit) { next.push(r); continue; }
      if (c.axis === 'V') {
        const xc = c.parentX + c.distance;
        next.push(
          { x: r.x, y: r.y, w: xc - r.x, h: r.h, items: r.items.filter((i) => rects[i].x + rects[i].w <= xc + EPS) },
          { x: xc, y: r.y, w: r.x + r.w - xc, h: r.h, items: r.items.filter((i) => rects[i].x + rects[i].w > xc + EPS) },
        );
      } else {
        const yc = c.parentY + c.distance;
        next.push(
          { x: r.x, y: r.y, w: r.w, h: yc - r.y, items: r.items.filter((i) => rects[i].y + rects[i].h <= yc + EPS) },
          { x: r.x, y: yc, w: r.w, h: r.y + r.h - yc, items: r.items.filter((i) => rects[i].y + rects[i].h > yc + EPS) },
        );
      }
    }
    regions = next;
  }
  let freed = 0;
  for (const r of regions) if (r.items.length === 1) freed++;
  return freed;
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
   *  (depth-sorted: full-sheet cuts first, then sub-piece cuts). Every
   *  strategy records a tree now — MaxRects ('free'/'save-last') gets one
   *  recovered by deriveGuillotineCuts. */
  cuts: Cut[];
  /** How many parts the cut tree fully frees (each alone in a final piece).
   *  Equals placements.length for a fully guillotine-cuttable layout; lower
   *  when some parts interlock in a non-guillotine block. Used as a safe
   *  tiebreaker so 'free' prefers cleanly-cuttable layouts at equal yield. */
  fullySeparated: number;
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
export function packOne(job: PackJob, heur: Heuristic, order: PackInput[], binKind?: BinKind): MultiSheetResult {
  const guillotine = isGuillotineStrategy(job.cutStrategy);
  const kind: BinKind = binKind ?? (guillotine ? 'shelf' : 'maxrects');
  if (kind.startsWith('beam')) {
    return packBeam(job, order, parseInt(kind.slice(4), 10) || 24);
  }
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

  // The shelf packer (guillotine / Min cuts) places parts in the ORDER given
  // and ignores `heur`, so its layout is fully determined by insertion order.
  // We therefore let the multi-restart wrapper explore orders here too. This
  // was previously force-sorted to one fixed longest-side-descending order,
  // which made every restart identical — the optimiser was a no-op for Min
  // cuts (256 trials, one unique result, a flat convergence chart). That same
  // First-Fit-Decreasing-Height order is still always tried (it's the `bySide`
  // order in packMulti/packMultiAnimated), so the FFDH-quality candidate is
  // preserved while shuffles hunt for layouts with fewer cuts; the min-cuts
  // objective in isBetter keeps the best, so this can only match or improve.
  // (MaxRects 'free'/'save-last' already honoured the passed order.)

  while (remaining.length > 0) {
    const bin: BinPacker =
      kind === 'shelf'   ? new ShelfBin(job.sheetW, job.sheetH) :
      kind === 'shelf-v' ? new ShelfBinV(job.sheetW, job.sheetH) :
      kind === 'sas'     ? new GuillotineBin(job.sheetW, job.sheetH) :
                           // 'maxrects' and 'maxrects-g' share the bin; only
                           // the selection order over parts differs.
                           new MaxRectsBin(job.sheetW, job.sheetH);
    const cur: PackedSheet = { placements: [], usedArea: 0, largestFree: null, cuts: [], fullySeparated: 0 };
    const carry: PackInput[] = []; // didn't fit on THIS bin → try next bin
    let anyPlacedThisBin = false;
    // Kerf-inflated footprints in bin coords — fed to the MaxRects cut-tree
    // recovery so its cuts land in the same frame as the guillotine path.
    const placedInflated: Rect[] = [];

    /**
     * Global best-fit (Jylänki): rather than walking the order and giving each
     * part the best spot left for it, score EVERY remaining part against every
     * free rectangle and place whichever pair fits best, repeatedly.
     *
     * MEASURED WORSE HERE — do not put it back in the default trial schedule.
     * `tests/bin_compare.mjs`, single ordering, no search: maxrects +0.85
     * sheets over the area bound, maxrects-g +1.25, and the gap widens with
     * size (+1.4 vs +2.4 at n=160). Adding it to the 256-trial pool moved the
     * mean not at all.
     *
     * Jylänki measured it ahead of order-based insertion, but on ONLINE
     * packing of many small rectangles into a single bin. Cabinet jobs are
     * few large parts across many bins, already fed largest-area-first —
     * and greedy tightest-fit spends the good space on small parts early,
     * then strands the big ones, which is exactly what a decreasing-size
     * order exists to prevent. Kept because bin_compare exercises it and it
     * is the evidence for that call.
     */
    const globalFill = () => {
      const mr = bin as MaxRectsBin;
      const pool = remaining.slice();
      for (;;) {
        let pick = -1;
        let pickCand: ScoredPlacement | null = null;
        for (let i = 0; i < pool.length; i++) {
          const it = pool[i];
          const c = mr.probe(it.w + job.kerf, it.h + job.kerf, it.allowRotate, heur);
          if (c && (!pickCand || better(c, pickCand))) { pickCand = c; pick = i; }
        }
        if (pick < 0 || !pickCand) break;
        const item = pool.splice(pick, 1)[0];
        const placed = mr.take(pickCand);
        const halfKerf = job.kerf / 2;
        const actualW = placed.w - job.kerf;
        const actualH = placed.h - job.kerf;
        cur.placements.push({
          id: item.id,
          x: placed.x + halfKerf, y: placed.y + halfKerf,
          w: actualW, h: actualH, rotated: placed.rotated,
        });
        placedInflated.push({ x: placed.x, y: placed.y, w: placed.w, h: placed.h });
        cur.usedArea += actualW * actualH;
        anyPlacedThisBin = true;
      }
      carry.push(...pool);
    };

    if (kind === 'maxrects-g') globalFill();
    else for (const item of remaining) {
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
      placedInflated.push({ x: placed.x, y: placed.y, w: placed.w, h: placed.h });
      cur.usedArea += actualW * actualH;
      anyPlacedThisBin = true;
    }

    if (anyPlacedThisBin) {
      if (bin instanceof ShelfBin || bin instanceof ShelfBinV) {
        // Shelf bins defer free-rect computation until all parts placed.
        bin.finalize();
      }
      // Recover the cut tree from the placements with the recursive
      // decomposer — for every bin kind. For MaxRects it's the only tree
      // there is; for the shelf/SAS bins it REPLACES their fixed emission
      // order: the decomposer prefers full-span separating lines, so edges
      // that align across strips become one through-cut and adjacent waste
      // merges into one fragment (fewer cuts, the human sequence).
      thinStripsTop(cur.placements, placedInflated, job.sheetH);
      bin.cuts = deriveGuillotineCuts(placedInflated, job.sheetW, job.sheetH);
      // Snapshot the largest remaining free rectangle (by area).
      let best: { w: number; h: number; a: number } | null = null;
      for (const f of bin.free) {
        const a = f.w * f.h;
        if (!best || a > best.a) best = { w: f.w, h: f.h, a };
      }
      cur.largestFree = best ? { w: best.w, h: best.h } : null;
      // Keep the derived tree's depth-first order — it IS the physical
      // top-to-bottom work sequence (see deriveGuillotineCuts).
      cur.cuts = bin.cuts.slice();
      cur.fullySeparated = countFreedParts(cur.cuts, placedInflated, job.sheetW, job.sheetH);
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

// ---------------------------------------------------------------------------
// Beam search over guillotine cut trees ('guillotine-exact')
//
// The greedy bins (shelf / SAS) commit to one placement at a time with a
// fixed split rule. The beam instead keeps the K most promising partial
// layouts and branches on the three choices a human juggles at the saw:
// WHICH part to cut next, in which ORIENTATION, and which AXIS the primary
// full-span cut takes. Regions that fit nothing (or are better saved) are
// discarded to waste — that branch is what lets waste consolidate.
//
// One sheet is searched at a time (maximise area placed, then fewest cuts);
// the winner's leftover parts roll into the next sheet. Sheet count
// dominates the objective upstream, so per-sheet area-first is the right
// local goal, and the exact strategy also runs the full greedy trial pool —
// the beam only has to beat it, never carry it.
// ---------------------------------------------------------------------------
interface BeamState {
  free: FreeRect[];
  waste: Rect[];            // discarded regions — remnants, counted for largestFree
  used: Uint8Array;         // per-item flag into the items array
  usedCount: number;
  placements: PackPlacement[]; // bin frame, kerf-inflated
  placedInflated: Rect[];
  cuts: Cut[];
  usedInflated: number;     // Σ inflated placement area — beam ranking proxy
}

function packBeam(job: PackJob, order: PackInput[], beamWidth: number): MultiSheetResult {
  const sheets: PackedSheet[] = [];
  const unplaced: PackInput[] = [];

  // Oversize filter — identical to packOne's.
  const items = order.filter((item) => {
    const w = item.w + job.kerf;
    const h = item.h + job.kerf;
    const fits = (w <= job.sheetW && h <= job.sheetH) ||
      (item.allowRotate && h <= job.sheetW && w <= job.sheetH);
    if (!fits) unplaced.push(item);
    return fits;
  });

  // Identical parts are interchangeable — branch once per distinct footprint.
  const typeKey = (it: PackInput) => `${it.w.toFixed(1)}x${it.h.toFixed(1)}:${it.allowRotate ? 1 : 0}`;
  const keys = items.map(typeKey);

  const W = items.length > 60 ? Math.min(beamWidth, 8) : beamWidth;

  // Largest surviving rectangle, counting discarded regions — a human's
  // "keep the offcut in one piece". Tiebreaker after area and cut count.
  const maxRemnant = (s: BeamState): number => {
    let m = 0;
    for (const f of s.free) m = Math.max(m, f.w * f.h);
    for (const f of s.waste) m = Math.max(m, f.w * f.h);
    return m;
  };
  // Two beam rankings, both run per sheet and arbitrated afterwards:
  //  'debt' — cuts already spent + a lower bound on cuts still owed (≥1 per
  //           unplaced part). Comparable across depths, and it rewards the
  //           placements a human hunts for: a part that lands flush with a
  //           region edge costs 0–1 cuts and pays off its own debt.
  //  'area' — pack the sheet as full as possible, cuts second. Wins when the
  //           job is tight and an extra sheet would swamp any cut savings.
  const rankDebt = (a: BeamState, b: BeamState): number => {
    const as = a.cuts.length + (items.length - a.usedCount);
    const bs = b.cuts.length + (items.length - b.usedCount);
    if (as !== bs) return as - bs;
    if (a.usedInflated !== b.usedInflated) return b.usedInflated - a.usedInflated;
    return maxRemnant(b) - maxRemnant(a);
  };
  const rankArea = (a: BeamState, b: BeamState): number => {
    if (a.usedInflated !== b.usedInflated) return b.usedInflated - a.usedInflated;
    if (a.cuts.length !== b.cuts.length) return a.cuts.length - b.cuts.length;
    return maxRemnant(b) - maxRemnant(a);
  };

  let used: Uint8Array = new Uint8Array(items.length);
  let usedCount = 0;
  let totalUsed = 0;

  // One beam pass over a single sheet under the given ranking. Returns the
  // best finished state by (area desc, then fewest DERIVED cuts among the
  // fullest) — through-cut merging can reorder close candidates.
  const searchSheet = (
    startUsed: Uint8Array,
    startCount: number,
    rank: (a: BeamState, b: BeamState) => number,
  ): { state: BeamState; derived: number } | null => {
    const init: BeamState = {
      free: [{ x: 0, y: 0, w: job.sheetW, h: job.sheetH, depth: 0 }],
      waste: [],
      used: startUsed,
      usedCount: startCount,
      placements: [],
      placedInflated: [],
      cuts: [],
      usedInflated: 0,
    };
    let states: BeamState[] = [init];
    const done: BeamState[] = [];
    let guard = items.length * 4 + 64;

    while (states.length > 0 && guard-- > 0) {
      const next: BeamState[] = [];
      for (const s of states) {
        if (s.usedCount >= items.length || s.free.length === 0) { done.push(s); continue; }
        // Work the lowest-leftmost open region — i.e. finish the strip the
        // last rip opened before starting a new one, like a human at the saw.
        let ri = 0;
        for (let i = 1; i < s.free.length; i++) {
          const f = s.free[i], g = s.free[ri];
          if (f.y < g.y - 0.001 || (Math.abs(f.y - g.y) <= 0.001 && f.x < g.x)) ri = i;
        }
        const region = s.free[ri];

        const clone = (): BeamState => ({
          free: s.free.filter((_, i) => i !== ri),
          waste: s.waste,
          used: s.used,
          usedCount: s.usedCount,
          placements: s.placements,
          placedInflated: s.placedInflated,
          cuts: s.cuts,
          usedInflated: s.usedInflated,
        });

        const seenTypes = new Set<string>();
        for (let i = 0; i < items.length; i++) {
          if (s.used[i] || seenTypes.has(keys[i])) continue;
          seenTypes.add(keys[i]);
          const it = items[i];
          const w = it.w + job.kerf;
          const h = it.h + job.kerf;
          const orients: [number, number, boolean][] = [[w, h, false]];
          if (it.allowRotate && w !== h) orients.push([h, w, true]);
          for (const [pw, ph, rot] of orients) {
            if (pw > region.w + 0.001 || ph > region.h + 0.001) continue;
            // Single-leftover placements make both axes equivalent — emit once.
            const axes: ('H' | 'V')[] =
              region.w - pw <= 0 || region.h - ph <= 0 ? ['H'] : ['H', 'V'];
            for (const axis of axes) {
              const c = clone();
              c.used = s.used.slice();
              c.used[i] = 1;
              c.usedCount = s.usedCount + 1;
              c.cuts = s.cuts.slice();
              const depth = region.depth ?? 0;
              recordCutsAxis(c.cuts, region, pw, ph, depth, axis);
              c.free = c.free.concat(guillotineSplitAxis(region, pw, ph, depth + 1, axis));
              c.placements = s.placements.concat([{ id: it.id, x: region.x, y: region.y, w: pw, h: ph, rotated: rot }]);
              c.placedInflated = s.placedInflated.concat([{ x: region.x, y: region.y, w: pw, h: ph }]);
              c.usedInflated = s.usedInflated + pw * ph;
              next.push(c);
            }
          }
        }
        // Discard branch: write the region off as waste. Forced when nothing
        // fits; optional otherwise (sometimes saving the region loses to
        // freeing the beam slot for a layout with consolidated waste).
        const skip = clone();
        skip.waste = s.waste.concat([{ x: region.x, y: region.y, w: region.w, h: region.h }]);
        next.push(skip);
      }
      if (next.length === 0) break;
      next.sort(rank);
      states = next.slice(0, W);
    }
    done.push(...states); // guard exhaustion — keep whatever is in flight

    done.sort((a, b) => b.usedInflated - a.usedInflated || a.cuts.length - b.cuts.length);
    let picked: BeamState | null = null;
    let pickedDerived = Infinity;
    for (const d of done.slice(0, 12)) {
      if (picked && d.usedInflated < picked.usedInflated - 0.001) break;
      const n = deriveGuillotineCuts(d.placedInflated, job.sheetW, job.sheetH).length;
      if (!picked || n < pickedDerived) {
        picked = d;
        pickedDerived = n;
      }
    }
    return picked ? { state: picked, derived: pickedDerived } : null;
  };

  while (usedCount < items.length) {
    // Run the sheet under both rankings and keep the better sheet: fuller
    // wins (sheet count dominates upstream), fewer derived cuts breaks ties.
    const byArea = searchSheet(used, usedCount, rankArea);
    const byDebt = searchSheet(used, usedCount, rankDebt);
    let pick = byArea;
    if (byDebt && (!pick ||
      byDebt.state.usedInflated > pick.state.usedInflated + 0.001 ||
      (byDebt.state.usedInflated > pick.state.usedInflated - 0.001 && byDebt.derived < pick.derived))) {
      pick = byDebt;
    }
    const best = pick?.state ?? null;
    if (!best || best.placements.length === 0) {
      for (let i = 0; i < items.length; i++) if (!used[i]) unplaced.push(items[i]);
      break;
    }

    // Materialise the sheet in the same frame packOne uses.
    const halfKerf = job.kerf / 2;
    const placements: PackPlacement[] = best.placements.map((p) => ({
      id: p.id,
      x: p.x + halfKerf,
      y: p.y + halfKerf,
      w: p.w - job.kerf,
      h: p.h - job.kerf,
      rotated: p.rotated,
    }));
    const usedArea = placements.reduce((a, p) => a + p.w * p.h, 0);
    thinStripsTop(placements, best.placedInflated, job.sheetH);
    const cuts = deriveGuillotineCuts(best.placedInflated, job.sheetW, job.sheetH);
    let bigFree: { w: number; h: number; a: number } | null = null;
    for (const f of [...best.free, ...best.waste]) {
      const a = f.w * f.h;
      if (!bigFree || a > bigFree.a) bigFree = { w: f.w, h: f.h, a };
    }
    sheets.push({
      placements,
      usedArea,
      largestFree: bigFree ? { w: bigFree.w, h: bigFree.h } : null,
      cuts,
      fullySeparated: countFreedParts(cuts, best.placedInflated, job.sheetW, job.sheetH),
    });
    totalUsed += usedArea;
    used = best.used;
    usedCount = best.usedCount;
  }

  return { sheets, unplaced, totalUsed };
}

/**
 * Repack the LAST sheet's parts into a fresh bin using strict Bottom-Left
 * placement so they cluster in one corner. The rest of the sheet becomes
 * a single large contiguous remnant the user can save for another job.
 *
 * If the BL repack fails to fit everything (shouldn't, since these parts
 * already fit on this sheet before), keeps the original layout.
 */
function repackLastSheetCorner(
  last: PackedSheet,
  job: PackJob,
  meta: Map<string, { id: string; w: number; h: number; allowRotate: boolean }>,
): PackedSheet | null {
  const items: { id: string; w: number; h: number; allowRotate: boolean }[] = [];
  for (const p of last.placements) {
    const m = meta.get(p.id);
    if (!m) return null;
    items.push(m);
  }
  // Sort by area desc — same first-fit-decreasing convention.
  items.sort((a, b) => (b.w * b.h) - (a.w * a.h));

  const bin = new MaxRectsBin(job.sheetW, job.sheetH);
  const placements: PackPlacement[] = [];
  const placedInflated: Rect[] = [];
  let usedArea = 0;
  for (const item of items) {
    const w = item.w + job.kerf;
    const h = item.h + job.kerf;
    const placed = bin.insert(w, h, item.allowRotate, 'BL');
    if (!placed) return null; // bail — keep the original
    const halfKerf = job.kerf / 2;
    const actualW = placed.w - job.kerf;
    const actualH = placed.h - job.kerf;
    placements.push({
      id: item.id,
      x: placed.x + halfKerf,
      y: placed.y + halfKerf,
      w: actualW,
      h: actualH,
      rotated: placed.rotated,
    });
    placedInflated.push({ x: placed.x, y: placed.y, w: placed.w, h: placed.h });
    usedArea += actualW * actualH;
  }
  let best: { w: number; h: number; a: number } | null = null;
  for (const f of bin.free) {
    const a = f.w * f.h;
    if (!best || a > best.a) best = { w: f.w, h: f.h, a };
  }
  // Recover a guillotine cut tree from the corner-clustered layout so its
  // cut sequence is edge-to-edge per sub-piece (not full-sheet lines).
  // (A vertical mirror keeps the cluster in a corner, so the remnant stays
  // one clean rectangle — save-last's promise is unaffected.)
  thinStripsTop(placements, placedInflated, job.sheetH);
  const cuts = deriveGuillotineCuts(placedInflated, job.sheetW, job.sheetH);
  return {
    placements,
    usedArea,
    largestFree: best ? { w: best.w, h: best.h } : null,
    cuts,
    fullySeparated: countFreedParts(cuts, placedInflated, job.sheetW, job.sheetH),
  };
}

/**
 * Dissolve under-filled sheets in a finished MaxRects result: take the
 * least-filled sheet and try to re-place ALL of its parts into the free
 * space remaining on the other sheets. If everything fits, that sheet is
 * dropped — one fewer sheet of stock to buy.
 *
 * Why this can succeed even though packOne is first-fit: a sheet is only
 * "closed" against the parts remaining AT THAT TIME. A sparse sheet in the
 * middle of the stack may hold parts that comfortably fit on a LATER sheet
 * that opened afterwards. The multi-restart search rarely finds those
 * layouts on its own because it never revisits a closed bin.
 *
 * Skipped for the 'guillotine' (shelf) strategy — inserting into arbitrary
 * free rects would break the shelf cut structure the strategy promises.
 */
function consolidateSheets(result: MultiSheetResult, job: PackJob): MultiSheetResult {
  if (isGuillotineStrategy(job.cutStrategy)) return result;
  if (result.sheets.length <= 1) return result;
  const byId = new Map(job.items.map((it) => [it.id, it] as const));
  const halfKerf = job.kerf / 2;

  // Re-inflate a placement back to the kerf-padded rect the bin frame uses.
  const inflate = (p: PackPlacement): Rect =>
    ({ x: p.x - halfKerf, y: p.y - halfKerf, w: p.w + job.kerf, h: p.h + job.kerf });

  // Rebuild a live MaxRects bin whose free space matches a finished sheet.
  const rebuild = (sheet: PackedSheet): MaxRectsBin => {
    const bin = new MaxRectsBin(job.sheetW, job.sheetH);
    for (const p of sheet.placements) bin.occupy(inflate(p));
    return bin;
  };

  const finalizeSheet = (placements: PackPlacement[], bin: MaxRectsBin): PackedSheet => {
    const placedInflated = placements.map(inflate);
    thinStripsTop(placements, placedInflated, job.sheetH);
    const cuts = deriveGuillotineCuts(placedInflated, job.sheetW, job.sheetH);
    let bestFree: { w: number; h: number; a: number } | null = null;
    for (const f of bin.free) {
      const a = f.w * f.h;
      if (!bestFree || a > bestFree.a) bestFree = { w: f.w, h: f.h, a };
    }
    return {
      placements,
      usedArea: placements.reduce((s, p) => s + p.w * p.h, 0),
      largestFree: bestFree ? { w: bestFree.w, h: bestFree.h } : null,
      cuts,
      fullySeparated: countFreedParts(cuts, placedInflated, job.sheetW, job.sheetH),
    };
  };

  let working = result.sheets.slice();
  let improved = true;
  let guard = 0;
  while (improved && working.length > 1 && guard++ < result.sheets.length + 4) {
    improved = false;
    // Try victims emptiest-first — the cheapest sheet to absorb elsewhere.
    const victims = working
      .map((_, i) => i)
      .sort((a, b) => working[a].usedArea - working[b].usedArea);
    for (const vi of victims) {
      const victim = working[vi];
      const items = victim.placements.map((p) => byId.get(p.id));
      if (items.some((it) => !it)) continue;
      // Largest first — hard parts placed while the hosts' space is freest.
      const sorted = (items as PackInput[]).slice().sort((a, b) => b.w * b.h - a.w * a.h);

      const hosts = working
        .filter((_, i) => i !== vi)
        .map((s) => ({ placements: s.placements.slice(), bin: rebuild(s) }));
      let allFit = true;
      for (const item of sorted) {
        let placed = false;
        for (const h of hosts) {
          const ins = h.bin.insert(item.w + job.kerf, item.h + job.kerf, item.allowRotate, 'BSSF');
          if (ins) {
            h.placements.push({
              id: item.id,
              x: ins.x + halfKerf,
              y: ins.y + halfKerf,
              w: ins.w - job.kerf,
              h: ins.h - job.kerf,
              rotated: ins.rotated,
            });
            placed = true;
            break;
          }
        }
        if (!placed) { allFit = false; break; }
      }
      if (!allFit) continue;
      working = hosts.map((h) => finalizeSheet(h.placements, h.bin));
      improved = true;
      break;
    }
  }

  if (working.length === result.sheets.length) return result;
  return { sheets: working, unplaced: result.unplaced, totalUsed: result.totalUsed };
}

/**
 * Trial schedule shared by every multi-restart driver (sync, animated and
 * the worker pool): every heuristic × (area-desc, longest-side-desc) orders,
 * then deterministic random shuffles up to the restarts budget.
 *
 * The min-cuts strategies get a richer schedule: every trial also picks a
 * BIN KIND (horizontal shelves, vertical shelves, or the stacking SAS
 * guillotine bin) plus dimension-grouped orders — same-height parts adjacent
 * in the order land in the same strip, the "rip one strip, crosscut four
 * identical parts" pattern a human uses. 'guillotine-exact' adds beam-search
 * trials on top (see packBeam).
 */
export type BinKind = 'maxrects' | 'maxrects-g' | 'shelf' | 'shelf-v' | 'sas' | `beam${number}`;

export interface PackTrial { order: PackInput[]; heur: Heuristic; binKind?: BinKind }

export function buildTrialSchedule(job: PackJob, restarts: number, seedOffset = 0): PackTrial[] {
  const heuristics: Heuristic[] = ['BSSF', 'BLSF', 'BAF', 'BL'];
  const baseline = job.items.slice().sort((a, b) => b.w * b.h - a.w * a.h);
  const bySide = job.items.slice().sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h));
  const trials: PackTrial[] = [];

  let seed = (0x9e3779b1 ^ Math.imul(seedOffset + 1, 0x85ebca6b)) >>> 0;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
  const shuffle = (): PackInput[] => {
    const shuffled = baseline.slice();
    for (let k = shuffled.length - 1; k > 0; k--) {
      const j = Math.floor(rand() * (k + 1));
      [shuffled[k], shuffled[j]] = [shuffled[j], shuffled[k]];
    }
    return shuffled;
  };

  if (isGuillotineStrategy(job.cutStrategy)) {
    // Dimension-grouped orders: equal heights (or widths) adjacent → they
    // share a strip and a single rip sizes them all.
    const byHeight = job.items.slice().sort((a, b) => b.h - a.h || b.w - a.w);
    const byWidth = job.items.slice().sort((a, b) => b.w - a.w || b.h - a.h);
    const orders = [baseline, bySide, byHeight, byWidth];
    const kinds: BinKind[] = ['shelf', 'shelf-v', 'sas'];
    for (const order of orders) {
      trials.push({ order, heur: 'BSSF', binKind: 'shelf' });
      trials.push({ order, heur: 'BSSF', binKind: 'shelf-v' });
      trials.push({ order, heur: 'BSSF', binKind: 'sas' });
      trials.push({ order, heur: 'BAF', binKind: 'sas' });
    }
    // Beam search over guillotine cut trees. Used to be the separate
    // 'guillotine-exact' strategy; it is always on now — 0.10 sheets better
    // for 7× the time on the benchmark, which is a trade worth making once
    // rather than a choice worth surfacing.
    trials.push({ order: baseline, heur: 'BSSF', binKind: 'beam48' });
    trials.push({ order: byHeight, heur: 'BSSF', binKind: 'beam48' });
    trials.push({ order: byWidth, heur: 'BSSF', binKind: 'beam24' });
    trials.push({ order: bySide, heur: 'BSSF', binKind: 'beam24' });
    const budget = Math.max(0, restarts - trials.length);
    for (let i = 0; i < budget; i++) {
      const kind = kinds[i % kinds.length];
      trials.push({ order: shuffle(), heur: kind === 'sas' ? heuristics[i % heuristics.length] : 'BSSF', binKind: kind });
    }
    return trials;
  }

  for (const h of heuristics) trials.push({ order: baseline, heur: h });
  for (const h of heuristics) trials.push({ order: bySide, heur: h });
  // `seedOffset` shifts the shuffle stream so an "Optimize further" re-run
  // explores NEW orderings rather than repeating the canonical search.
  const phase3 = Math.max(0, restarts - heuristics.length * 2);
  for (let i = 0; i < phase3; i++) {
    trials.push({ order: shuffle(), heur: heuristics[i % heuristics.length] });
  }
  return trials;
}

/** Kept as the single place packing-vs-objective strategy could diverge.
 *  Nothing diverges now that 'save-last' is a default post-process rather
 *  than a strategy that packed as 'free'. */
export function effectiveJob(job: PackJob): PackJob {
  return job;
}

/**
 * Post-search finishing shared by all drivers: dissolve consolidatable
 * sheets, then (save-last) corner-cluster the last sheet.
 */
export function finishPack(job: PackJob, best: MultiSheetResult): MultiSheetResult {
  const result = consolidateSheets(best, effectiveJob(job));
  // Cluster the LAST sheet's parts into one corner so what is left over is a
  // clean rectangle worth keeping. Default for every strategy now, not an
  // option: it is pure post-processing — the parts and the sheet count are
  // unchanged, only their arrangement on that one sheet — so it cannot cost
  // anything. `nest.ts` packs each thickness group separately, so this lands
  // on the last sheet OF EACH SIZE.
  if (result.sheets.length > 0) {
    // Put the EMPTIEST sheet last first. Which sheet ends up last is an
    // artefact of the objective — 'free' and 'cnc' happen to leave the
    // slack there, min-cuts optimises cuts and leaves it on sheet 1, where
    // clustering it does the user no good. Sheet order carries no meaning
    // for the saw (each sheet owns its own cut tree, and they are cut
    // independently), so reordering is free and makes the remnant land
    // where it can actually be saved.
    let leanest = 0;
    for (let i = 1; i < result.sheets.length; i++) {
      if (result.sheets[i].usedArea < result.sheets[leanest].usedArea) leanest = i;
    }
    if (leanest !== result.sheets.length - 1) {
      const [s] = result.sheets.splice(leanest, 1);
      result.sheets.push(s);
    }
    const meta = new Map<string, { id: string; w: number; h: number; allowRotate: boolean }>();
    for (const it of job.items) meta.set(it.id, { id: it.id, w: it.w, h: it.h, allowRotate: it.allowRotate });
    const repacked = repackLastSheetCorner(result.sheets[result.sheets.length - 1], job, meta);
    if (repacked) result.sheets[result.sheets.length - 1] = repacked;
  }
  return result;
}

/**
 * Multi-restart optimizer: shuffles insertion order + tries different
 * heuristics, keeps the best result by (fewest unplaced → fewest sheets
 * → highest fill on last sheet).
 */
export function packMulti(job: PackJob, restarts: number): MultiSheetResult {
  const optJob = effectiveJob(job);
  const objectiveStrategy: CutStrategy = job.cutStrategy ?? 'free';
  let best: MultiSheetResult | null = null;
  for (const t of buildTrialSchedule(job, restarts)) {
    const r = packOne(optJob, t.heur, t.order, t.binKind);
    if (!best || isBetter(r, best, objectiveStrategy)) best = r;
  }
  return finishPack(job, best!);
}

export interface PackProgress {
  /** 0-based iteration index. */
  i: number;
  /** Total iterations the optimiser will run. */
  total: number;
  /** The layout produced by THIS iteration. */
  current: MultiSheetResult;
  /** The best layout seen so far. */
  best: MultiSheetResult;
  /** True iff this iteration BECAME the new best. */
  isNewBest: boolean;
}

/**
 * Async, observable multi-restart optimiser. Same search space + objective
 * as `packMulti`, but yields control back to the browser between batches so
 * the UI can animate panel shuffling, update a progress bar, etc. Calls
 * `onProgress` per trial and yields with `await`.
 */
export async function packMultiAnimated(
  job: PackJob,
  restarts: number,
  onProgress: (p: PackProgress) => void | Promise<void>,
  yieldEvery = 4,
  seedOffset = 0,
): Promise<MultiSheetResult> {
  const optJob = effectiveJob(job);
  const objectiveStrategy: CutStrategy = job.cutStrategy ?? 'free';
  const trials = buildTrialSchedule(job, restarts, seedOffset);

  const total = trials.length;
  let best: MultiSheetResult | null = null;
  for (let i = 0; i < total; i++) {
    const t = trials[i];
    const current = packOne(optJob, t.heur, t.order, t.binKind);
    const isNewBest = !best || isBetter(current, best, objectiveStrategy);
    if (isNewBest) best = current;
    await onProgress({ i, total, current, best: best!, isNewBest });
    if (i % yieldEvery === 0) await new Promise<void>((r) => setTimeout(r, 0));
  }

  return finishPack(job, best!);
}

/**
 * Strategy-aware "is A better than B" comparator. Each strategy has a
 * distinct OBJECTIVE the multi-restart optimiser should actually optimise
 * for. Two-tier prelude is the same for all: fewer unplaced → fewer
 * sheets. The tiebreaker differs per strategy.
 */
export function isBetter(a: MultiSheetResult, b: MultiSheetResult, strategy: CutStrategy = 'free'): boolean {
  if (a.unplaced.length !== b.unplaced.length) return a.unplaced.length < b.unplaced.length;
  if (a.sheets.length !== b.sheets.length) return a.sheets.length < b.sheets.length;

  const totalUsed = (r: MultiSheetResult) => r.sheets.reduce((s, sh) => s + sh.usedArea, 0);
  const lastUsed = (r: MultiSheetResult) => (r.sheets.length ? r.sheets[r.sheets.length - 1].usedArea : 0);
  const totalCuts = (r: MultiSheetResult) => r.sheets.reduce((s, sh) => s + (sh.cuts?.length ?? 0), 0);
  // Parts the cut tree fully frees, job-wide. Higher = more cleanly
  // guillotine-cuttable (fewer parts left joined in a non-guillotine block).
  const freed = (r: MultiSheetResult) => r.sheets.reduce((s, sh) => s + (sh.fullySeparated ?? 0), 0);

  // Applied at the BOTTOM of every strategy: prefer the layout leaving less
  // on the last sheet, so the remnant is a bigger reusable piece. Lowest
  // priority by construction — it can never cost a sheet, a cut or yield,
  // which is what makes "save more on the last sheet" safe as a default
  // rather than a strategy of its own.
  const leavesMore = () => lastUsed(a) < lastUsed(b);

  switch (strategy) {
    case 'guillotine': {
      // Min cuts, track-saw practical: first minimise AWKWARD cuts (saw run
      // over stock narrower than a rail can sit on — the thing users hate),
      // then total cuts, then yield, then the widest narrowest-piece.
      const awkward = (r: MultiSheetResult) => {
        let n = 0;
        for (const sh of r.sheets) for (const c of sh.cuts) {
          if (Math.min(c.parentW, c.parentH) < AWKWARD_MM) n++;
        }
        return n;
      };
      const aa = awkward(a), ba = awkward(b);
      if (aa !== ba) return aa < ba;
      const ac = totalCuts(a), bc = totalCuts(b);
      if (ac !== bc) return ac < bc;
      const at = totalUsed(a), bt = totalUsed(b);
      if (at !== bt) return at > bt;
      const narrowest = (r: MultiSheetResult) => {
        let m = Infinity;
        for (const sh of r.sheets) for (const c of sh.cuts) m = Math.min(m, c.parentW, c.parentH);
        return m;
      };
      const an = narrowest(a), bn = narrowest(b);
      if (an !== bn) return an > bn;
      return leavesMore();
    }
    case 'free':
    default: {
      // Max yield: prefer HIGHER total used area (= highest overall fill).
      const at = totalUsed(a), bt = totalUsed(b);
      if (at !== bt) return at > bt;
      // At equal yield (the common case when everything fits), prefer the
      // layout that's most cleanly guillotine-cuttable — this steers 'free'
      // away from pinwheel/staircase nests whose cut sequence can't separate
      // every panel, at ZERO cost to yield or sheet count.
      const af = freed(a), bf = freed(b);
      if (af !== bf) return af > bf;
      // Then leave as much of the last sheet whole as possible. This used to
      // prefer the OPPOSITE — more on the last sheet, "packing parts as early
      // as possible" — which fights the save-the-remnant default now that it
      // applies to every strategy.
      return leavesMore();
    }
  }
}
