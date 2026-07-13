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
  /** Hex color matching the 3D viewer + per-sheet layout panel for this id. */
  color: string;
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
  /** True when this cut uses the SAME axis and distance as the previous
   *  step — with a parallel guide the flip stops are already set, so the
   *  user just slides the stock against them and cuts. */
  sameSetting?: boolean;
  /** Manual override: quote the dimension from the FAR parallel edge of the
   *  parent (R for vertical cuts, B for horizontal) instead of the near
   *  datum edge (L/T). The green measured-from highlight + PDF caption move
   *  with it. */
  fromFar?: boolean;
  /** Manual override: this cut is a REFERENCE (datum) cut — rendered blue
   *  like trims (drawn after the fade) and chipped "REF" in the editor.
   *  Trim cuts are datum by default. */
  isDatum?: boolean;
}

// ---------------------------------------------------------------------------
// Manual cut-sequence overrides (edited in the popup, persisted by main.ts).
// ---------------------------------------------------------------------------

/** Per-cut manual flags keyed by `cutKeyFor(step)`. */
export interface PerCutOverride {
  fromFar?: boolean;
  isDatum?: boolean;
}

/** A user-declared DATUM edge on a piece: the reference edge that cuts on
 *  that piece are measured from by default. `piece` is the rounded-rect key of
 *  the parent region (cutKeyFor's `${x},${y},${w},${h}` format); `side` is
 *  which of the region's four edges is the datum. Persisted so the marking
 *  survives a re-estimate that reproduces the identical layout; re-applied by
 *  replaying the trims/cuts and matching regions geometrically. */
export interface DatumEdge {
  piece: string;                          // "x,y,w,h" rounded (region key)
  side: 'top' | 'bottom' | 'left' | 'right';
}

/** A sheet's full override set: an explicit LAYOUT-cut order (cutKeys, trims
 *  excluded — trims stay pinned at the front) plus per-cut flags. */
export interface SheetOverrides {
  /** Ordered cutKeys for the NON-TRIM steps. Trims are always emitted first
   *  in their engine order and are not listed here. */
  order?: string[];
  perCut?: Record<string, PerCutOverride>;
  /** User-marked datum edges (default measuring edges) per piece. Independent
   *  of `customSteps` — a datum drives the DEFAULT quoted edge for cuts the
   *  user commits parallel to it without arming. */
  datumEdges?: DatumEdge[];
  /** A hand-built FULL layout sequence (trims excluded), used when the user
   *  drew cuts on the diagram that the engine's auto tree doesn't contain —
   *  so the `order` cutKey re-ordering can't express it. When present this
   *  REPLACES the engine's layout tail wholesale: the trims are still emitted
   *  first (engine order), then these steps in the order given. Each step
   *  carries its own parent rect (in the sheet frame) so every downstream
   *  renderer — the PDF cut cards especially — works with no extra plumbing.
   *  `order`/`perCut` are ignored when `customSteps` is set (the steps already
   *  carry their fromFar/isDatum flags baked in). */
  customSteps?: CutStep[];
}

/**
 * Stable identity for a cut step, used as the override map key and the
 * training-log identifier. Axis + rounded parent rect + rounded distance —
 * survives a re-estimate that produces the identical layout. Rounded to 1mm
 * to match the countFreedParts / parent-matching tolerance.
 */
export function cutKeyFor(s: {
  axis: 'rip' | 'cross';
  distance: number;
  parentX: number; parentY: number; parentW: number; parentH: number;
}): string {
  const r = (n: number) => Math.round(n);
  return `${s.axis}|${r(s.parentX)},${r(s.parentY)},${r(s.parentW)},${r(s.parentH)}|${r(s.distance)}`;
}

/**
 * Signature of a sheet LAYOUT (dims + part rects + the auto cut list). The
 * override map is keyed by this so overrides re-apply only when a
 * re-estimate reproduces the identical layout. Independent of margin/kerf so
 * it stays stable while the user is only tweaking the sequence.
 */
export function layoutSignature(sheet: NestSheet): string {
  const r = (n: number) => Math.round(n);
  const dims = `${r(sheet.sheetW)}x${r(sheet.sheetL)}x${r(sheet.thickness * 10)}`;
  const parts = sheet.parts
    .map((p) => `${r(p.x)},${r(p.y)},${r(p.w)},${r(p.h)}`)
    .sort()
    .join(';');
  const cuts = (sheet.cuts ?? [])
    .map((c) => `${c.axis}${r(c.parentX)},${r(c.parentY)},${r(c.parentW)},${r(c.parentH)},${r(c.distance)}`)
    .join('|');
  return `${dims}#${parts}#${cuts}`;
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
            color: p.color,
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
 *   - CUT-TREE path: walks the real cut tree on the sheet. Every strategy
 *     now carries one — the shelf packer builds it directly, and MaxRects
 *     ('free' / 'save-last') layouts get one recovered by deriveGuillotineCuts
 *     (see packRect.ts). Each step references its parent SUB-PIECE and the
 *     cut's local distance, in depth-first top-to-bottom work order: rip the
 *     top strip off, finish that strip at the bench, move down the sheet.
 *   - FALLBACK path: only if a sheet somehow has no recorded cuts, infer
 *     unique interior X/Y edges as full-sheet lines. This is an
 *     APPROXIMATION — such lines may cross neighbouring panels — kept solely
 *     as a defensive last resort.
 */
/** Kerf-reference mode — how the far reference trim is placed and how cut
 *  dimensions are quoted (the latter lives in pdf.ts quotedDistance). In
 *  'spacing' mode the far long trim lands exactly at the last part's edge
 *  (no +kerf/2), so the quoted spacing lands on the part face. */
export type KerfRef = 'keeper' | 'center' | 'spacing';

export function cutStepsForSheet(
  sheet: NestSheet,
  sheetIndex: number,
  groupIndex: number,
  margin = 0,
  kerf = 0,
  overrides?: SheetOverrides,
  kerfRef: KerfRef = 'keeper',
): SheetCuts {
  const W = sheet.sheetW;
  const L = sheet.sheetL;
  const lengthIsY = L >= W;

  // Margin trim cuts come first when margin > 0. THREE reference edges get
  // trimmed — BOTH long edges plus the short edge nearest the datum — so the
  // parallel-guide stops can register off either long edge, with the main
  // datum at the sheet's top-left corner (the frame origin). The far short
  // edge falls off naturally with the layout cuts.
  //
  // Trim ORDER adapts to the first layout cut: the last trim runs in the
  // same direction as that cut, so the rip↔crosscut rotation isn't paid
  // twice in a row.
  const trimSteps: CutStep[] = [];
  if (margin > 0) {
    const m = margin;
    // Physical line orientation of the first layout cut (V = constant X).
    const firstIsVertical = sheet.cuts && sheet.cuts.length > 0
      ? sheet.cuts[0].axis === 'V'
      : false;
    // Long edges run along the length axis: constant-X lines when the length
    // axis is Y, constant-Y lines otherwise (the usual landscape frame).
    const longVertical = lengthIsY;
    const trim = (vertical: boolean, at: number, k: { x: number; y: number; w: number; h: number }): CutStep => ({
      index: trimSteps.length + 1,
      axis: vertical === lengthIsY ? 'rip' : 'cross',
      distance: vertical ? at - k.x : at - k.y,
      parentX: k.x, parentY: k.y, parentW: k.w, parentH: k.h,
      depth: 0, isTrim: true,
    });
    // Running keeper rect — each trim acts on what the previous one left.
    const k = { x: 0, y: 0, w: W, h: L };
    const addV = (at: number, keepHigh: boolean) => {
      trimSteps.push(trim(true, at, k));
      if (keepHigh) { k.w = k.x + k.w - at; k.x = at; } else { k.w = at - k.x; }
    };
    const addH = (at: number, keepHigh: boolean) => {
      trimSteps.push(trim(false, at, k));
      if (keepHigh) { k.h = k.y + k.h - at; k.y = at; } else { k.h = at - k.y; }
    };
    // The FAR long-edge trim lands right at the last part's edge (kerf into
    // the waste) instead of the sheet's far margin — one cut both frees the
    // whole far leftover for the rack AND establishes the reference edge.
    let farLongAt = longVertical ? W - m : L - m;
    if (sheet.parts.length > 0) {
      const ext = longVertical
        ? Math.max(...sheet.parts.map((p) => p.x + p.w))
        : Math.max(...sheet.parts.map((p) => p.y + p.h));
      // 'spacing' mode registers on the part face itself — the trim lands
      // exactly at the last part's edge (no blade offset); other modes push
      // half a kerf into the waste to square the edge cleanly.
      const off = kerfRef === 'spacing' ? 0 : kerf / 2;
      farLongAt = Math.min(farLongAt, ext + off);
    }
    const longs = () => longVertical
      ? (addV(m, true), addV(farLongAt, false))
      : (addH(m, true), addH(farLongAt, false));
    const short = () => longVertical ? addH(m, true) : addV(m, true);
    // End the trims on the first layout cut's orientation.
    if (firstIsVertical === longVertical) { short(); longs(); }
    else { longs(); short(); }
  }
  const offset = trimSteps.length;

  // Consecutive cuts at the same axis + distance reuse the parallel-guide
  // setting — flag them so the PDF can tell the user the guide is already
  // set (the cut sequence is ordered to maximise these runs).
  const markSameSetting = (all: CutStep[]): CutStep[] => {
    for (let i = 1; i < all.length; i++) {
      const p = all[i - 1], c = all[i];
      if (c.axis === p.axis && Math.abs(c.distance - p.distance) < 0.5) c.sameSetting = true;
    }
    return all;
  };

  // Apply manual overrides to a [trims..., layout...] step list. Trims stay
  // pinned at the front in their engine order; the layout tail is reordered
  // to the saved `order` (any cutKeys not present keep their relative order,
  // appended after). Per-cut fromFar/isDatum flags are stamped on. Trims are
  // datum by default. Step indices + sameSetting are recomputed by the caller
  // via markSameSetting after this returns.
  const applyOverrides = (trims: CutStep[], layout: CutStep[]): CutStep[] => {
    let orderedLayout = layout;
    if (overrides?.order && overrides.order.length > 0) {
      const rank = new Map<string, number>();
      overrides.order.forEach((k, i) => rank.set(k, i));
      // Stable sort by saved rank; unknown keys sink to the end preserving
      // their engine order.
      orderedLayout = layout
        .map((s, i) => ({ s, i }))
        .sort((a, b) => {
          const ra = rank.has(cutKeyFor(a.s)) ? rank.get(cutKeyFor(a.s))! : Number.MAX_SAFE_INTEGER;
          const rb = rank.has(cutKeyFor(b.s)) ? rank.get(cutKeyFor(b.s))! : Number.MAX_SAFE_INTEGER;
          return ra - rb || a.i - b.i;
        })
        .map((e) => e.s);
    }
    const all = [...trims, ...orderedLayout];
    for (const s of all) {
      if (s.isTrim) { s.isDatum = true; continue; }
      const o = overrides?.perCut?.[cutKeyFor(s)];
      if (o) {
        if (o.fromFar) s.fromFar = true;
        if (o.isDatum) s.isDatum = true;
      }
    }
    all.forEach((s, i) => { s.index = i + 1; });
    return all;
  };

  // Custom-sequence path: the user hand-drew a full layout sequence in the
  // editor that the engine's auto tree can't express as a re-ordering. Emit
  // the trims (engine order) then the saved custom steps verbatim. Each step
  // already carries its parent rect + fromFar/isDatum, so nothing else here
  // has to interpret them — just renumber + re-flag same-setting runs.
  if (overrides?.customSteps && overrides.customSteps.length > 0) {
    const custom = overrides.customSteps.map((s) => ({ ...s, isTrim: false }));
    const all = [...trimSteps, ...custom];
    for (const s of all) { if (s.isTrim) s.isDatum = true; }
    all.forEach((s, i) => { s.index = i + 1; });
    return {
      sheetIndex, globalIndex: sheet.globalIndex || sheetIndex, groupIndex,
      thickness: sheet.thickness, sheetW: W, sheetL: L,
      steps: markSameSetting(all),
      isGuillotineTree: true,
    };
  }

  // Cut-tree path: a recorded tree exists (shelf packer, or recovered from a
  // MaxRects layout) — translate each Cut → CutStep within its sub-piece.
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
    // A tree cut that lands exactly on a trim line (typically the far-long
    // trim placed at the last part's edge) is already made — drop it so the
    // trim does double duty and the total cut count goes down.
    const lineOf = (s: CutStep) => {
      const vertical = lengthIsY ? s.axis === 'rip' : s.axis === 'cross';
      return { vertical, coord: vertical ? s.parentX + s.distance : s.parentY + s.distance };
    };
    const trimLines = trimSteps.map(lineOf);
    const deduped = steps.filter((s) => {
      const l = lineOf(s);
      return !trimLines.some((t) => t.vertical === l.vertical && Math.abs(t.coord - l.coord) < 0.75);
    });
    deduped.forEach((s, i) => { s.index = offset + i + 1; });
    return {
      sheetIndex, globalIndex: sheet.globalIndex || sheetIndex, groupIndex,
      thickness: sheet.thickness, sheetW: W, sheetL: L,
      steps: markSameSetting(applyOverrides(trimSteps, deduped)),
      isGuillotineTree: true,
    };
  }

  // Fallback (defensive only — every strategy now records a cut tree): infer
  // unique interior edges as full-sheet lines. The "parent piece" for these
  // synthetic steps is the whole sheet, so they may cross panels.
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
    steps: markSameSetting(applyOverrides(trimSteps, steps)),
    isGuillotineTree: false,
  };
}

/** One row of the per-sheet panel-dimensions table: all panels ON A SINGLE
 *  SHEET that share the same (length, width, thickness) collapse into one
 *  row. `codes` lists every instance's full panel id ("1a", "3b") so the
 *  reader can find each one in the layout. */
export interface PanelSizeRow {
  /** Full panel ids for every instance in this group, e.g. ['1a', '1c']. */
  codes: string[];
  qty: number;
  length: number;      // mm, long edge
  width: number;       // mm, short edge
  thickness: number;   // mm
  /** Hex color of the panels (all instances share a partId → same color). */
  color: string;
  partName: string;
}

/** Accumulate one sheet's panels into a size-keyed row map (shared by the
 *  per-sheet and job-wide groupings). */
function accumulatePanelSizes(byKey: Map<string, PanelSizeRow>, sheet: NestSheet): void {
  for (const p of sheet.parts) {
    const longMm = Math.max(p.w, p.h);
    const shortMm = Math.min(p.w, p.h);
    // Round to 0.1mm so float noise doesn't split identical panels.
    const key = `${Math.round(longMm * 10)}|${Math.round(shortMm * 10)}|${Math.round(sheet.thickness * 10)}`;
    const code = `${sheet.globalIndex}${p.panelLabel}`;
    const ex = byKey.get(key);
    if (ex) {
      ex.codes.push(code);
      ex.qty += 1;
    } else {
      byKey.set(key, {
        codes: [code],
        qty: 1,
        length: longMm,
        width: shortMm,
        thickness: sheet.thickness,
        color: p.color,
        partName: p.partName,
      });
    }
  }
}

/** Sort codes within each row + order rows large-to-small; shared finisher. */
function finishPanelSizeRows(byKey: Map<string, PanelSizeRow>): PanelSizeRow[] {
  const rows = Array.from(byKey.values());
  for (const r of rows) r.codes.sort(comparePanelCode);
  rows.sort((a, b) => (b.length * b.width) - (a.length * a.width) || (b.length - a.length));
  return rows;
}

/**
 * Group ONE sheet's placed panels by identical (length, width, thickness).
 * Returns rows sorted large-to-small (by area, then long edge). Panel codes
 * within a row are the app's existing "{globalIndex}{panelLabel}" ids
 * ("1a", "3b"), sorted naturally. Used by the per-sheet panel table.
 */
export function groupPanelsBySize(sheet: NestSheet): PanelSizeRow[] {
  const byKey = new Map<string, PanelSizeRow>();
  accumulatePanelSizes(byKey, sheet);
  return finishPanelSizeRows(byKey);
}

/**
 * Job-wide version: group EVERY placed panel across all sheets/groups by
 * identical (length, width, thickness). A row's codes span sheets
 * ("1a, 3a, 4b"). Used by the front-matter Panels table.
 */
export function groupAllPanelsBySize(result: NestResult): PanelSizeRow[] {
  const byKey = new Map<string, PanelSizeRow>();
  for (const g of result.groups) {
    for (const s of g.sheets) accumulatePanelSizes(byKey, s);
  }
  return finishPanelSizeRows(byKey);
}

/** Natural-ish sort for panel ids like "1a", "2b", "10c": numeric sheet part
 *  first, then the letter suffix. */
function comparePanelCode(a: string, b: string): number {
  const pa = /^(\d+)(.*)$/.exec(a);
  const pb = /^(\d+)(.*)$/.exec(b);
  if (pa && pb) {
    const na = parseInt(pa[1], 10), nb = parseInt(pb[1], 10);
    if (na !== nb) return na - nb;
    return pa[2].localeCompare(pb[2]);
  }
  return a.localeCompare(b);
}

/** Generate cut step lists for every sheet in the job, in order.
 *  `overridesBySig` maps a sheet's `layoutSignature` → its manual overrides;
 *  when a sheet's signature is present the saved order/edges/datum flags are
 *  applied (see cutStepsForSheet). */
export function allCutSteps(
  result: NestResult,
  margin = 0,
  kerf = 0,
  overridesBySig?: Record<string, SheetOverrides>,
  kerfRef: KerfRef = 'keeper',
): SheetCuts[] {
  const out: SheetCuts[] = [];
  result.groups.forEach((g, gi) => {
    g.sheets.forEach((s, si) => {
      const ov = overridesBySig?.[layoutSignature(s)];
      out.push(cutStepsForSheet(s, si + 1, gi + 1, margin, kerf, ov, kerfRef));
    });
  });
  return out;
}
