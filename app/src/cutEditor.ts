/**
 * Manual cut-sequence editor — a modal popup where the user hand-builds a
 * sheet's ENTIRE breakdown from BARE STOCK by clicking cut lines on the
 * diagram. The user's mental model: "I start with the raw full sheet, click
 * a line, tell it what to measure from, and that becomes the cut."
 *
 * INTERACTION
 *   - The diagram opens as the RAW full sheet with the parts shown — NOTHING
 *     is pre-made, not even the reference trims. The candidate set therefore
 *     includes the TRIM lines (the four margin lines where applicable + the
 *     far-long line at the last part's edge) as well as the part-edge lines,
 *     so the user can hand-build the complete breakdown.
 *   - Hovering a candidate line draws it red-dashed with a live quote (using
 *     the default reference for that cut).
 *   - Clicking a candidate opens a small CONFIG POPUP anchored near the click:
 *       Field 1 "Save as datum" (yes/no, default no) — yes = the cut's fresh
 *         edge becomes a DATUM (blue, reusing the datum-edge machinery).
 *       Field 2 "Measure from" — a radio list of every valid reference for
 *         this cut (near edge / far edge / any parallel datum edge / the most
 *         recent parallel cut on this piece = "Previous cut", chain
 *         dimensioning). The selected reference renders BLUE in the field and
 *         highlighted on the diagram.
 *       Confirm ("Make cut") / Cancel. On confirm the cut commits.
 *
 * DATUM EDGES: a datum is stored as a geometric line SEGMENT so it PROPAGATES
 * to any child piece that retains that same boundary edge after a cut. A
 * datum-saved cut's fresh edge is registered as a datum line. Persisted on
 * SheetOverrides.datumEdges (piece key + side).
 *
 * RIGHT PANE = a READOUT of the sequence built so far. Per row: the cut kind +
 * quoted distance, the reference used ("from R edge" / "from datum" /
 * "from cut 5"), undo-to-here (↩). No drag / reorder.
 *
 * ACTIONS: Undo (last cut), Reset (back to bare stock), Auto-complete (fills
 * the remaining sequence with the engine's order — generating the trims first
 * if the user hasn't made them). Completion summary when every part is freed.
 *
 * PERSISTENCE: the hand-built sequence is stored as `customSteps` on the
 * sheet's SheetOverrides keyed by layoutSignature. Because the trims are no
 * longer pre-made, customSteps may CONTAIN the trim cuts (each marked isTrim);
 * cutStepsForSheet emits customSteps ONLY (no synthetic trims) so nothing is
 * double-emitted.
 */

import type { NestSheet } from './nest';
import { deriveGuillotineCuts, type Cut } from './packRect';
import {
  cutStepsForSheet,
  cutKeyFor,
  layoutSignature,
  type CutStep,
  type SheetOverrides,
  type DatumEdge,
  type KerfRef,
  type SequenceStyle,
} from './instructions';
import { fmtDim, type Units } from './units';
import {
  trainingRecorder,
  sequenceMetrics,
  type SequenceMetrics,
  type SessionStartEvent,
} from './trainingLog';

const STORE_KEY = 'plywood.cutOverrides';

// ---------------------------------------------------------------------------
// Persistence — a map { layoutSignature → SheetOverrides } in localStorage.
// ---------------------------------------------------------------------------

export function loadAllOverrides(): Record<string, SheetOverrides> {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function saveAllOverrides(all: Record<string, SheetOverrides>): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch { /* quota — best effort */ }
}

function getOverrides(sig: string): SheetOverrides | undefined {
  return loadAllOverrides()[sig];
}

function setOverrides(sig: string, ov: SheetOverrides | null): void {
  const all = loadAllOverrides();
  if (ov === null) delete all[sig];
  else all[sig] = ov;
  saveAllOverrides(all);
}

// ---------------------------------------------------------------------------
// Region replay — the pieces produced so far. We now START FROM BARE STOCK
// (the raw full sheet) and replay EVERY hand-made cut, trims included. There
// is no post-trim margin clip anymore: the user's own trim cuts shave the
// margins, so replaying them over the raw sheet is exact (the legacy far-short
// -edge gotcha only applied when the trims were synthetic + pre-made).
// ---------------------------------------------------------------------------

interface Region { x: number; y: number; w: number; h: number }

/** Is a step a vertical (constant-X) line in SHEET space? */
function stepIsVertical(step: CutStep, sheetW: number, sheetL: number): boolean {
  const lengthIsY = sheetL >= sheetW;
  return lengthIsY ? step.axis === 'rip' : step.axis === 'cross';
}

/** Split any region this step's parent matches (within 1 mm). Regions that
 *  don't match pass through unchanged. */
function applyStepToRegions(step: CutStep, sheetW: number, sheetL: number, regions: Region[]): Region[] {
  const out: Region[] = [];
  const vertical = stepIsVertical(step, sheetW, sheetL);
  for (const r of regions) {
    const hit =
      Math.abs(r.x - step.parentX) < 1 && Math.abs(r.y - step.parentY) < 1 &&
      Math.abs(r.w - step.parentW) < 1 && Math.abs(r.h - step.parentH) < 1;
    if (!hit) { out.push(r); continue; }
    if (vertical) {
      const xc = step.parentX + step.distance;
      out.push(
        { x: r.x, y: r.y, w: xc - r.x, h: r.h },
        { x: xc, y: r.y, w: r.x + r.w - xc, h: r.h },
      );
    } else {
      const yc = step.parentY + step.distance;
      out.push(
        { x: r.x, y: r.y, w: r.w, h: yc - r.y },
        { x: r.x, y: yc, w: r.w, h: r.y + r.h - yc },
      );
    }
  }
  return out;
}

/** The starting region: the RAW full sheet (bare stock — nothing pre-made). */
function seedRegions(sheetW: number, sheetL: number): Region[] {
  return [{ x: 0, y: 0, w: sheetW, h: sheetL }];
}

/** Replay a built sequence (trims + layout cuts, in commit order) → the live
 *  pieces, starting from bare stock. */
function liveRegions(built: CutStep[], sheetW: number, sheetL: number): Region[] {
  let regions = seedRegions(sheetW, sheetL);
  for (const s of built) regions = applyStepToRegions(s, sheetW, sheetL, regions);
  return regions;
}

/** Which part indices (into `parts`) fall inside a region. A part counts when
 *  its rect is within the region bounds (tolerant of float noise). */
function partsInRegion(r: Region, parts: NestSheet['parts']): number[] {
  const EPS = 1;
  const out: number[] = [];
  parts.forEach((p, i) => {
    if (p.x >= r.x - EPS && p.y >= r.y - EPS &&
        p.x + p.w <= r.x + r.w + EPS && p.y + p.h <= r.y + r.h + EPS) out.push(i);
  });
  return out;
}

/** A region is FINISHED when it holds ≤1 part and that part fills it (or it's
 *  bare waste). Finished pieces fade back and offer no candidates. */
function regionFinished(r: Region, parts: NestSheet['parts']): boolean {
  const idx = partsInRegion(r, parts);
  if (idx.length === 0) return true;
  if (idx.length > 1) return false;
  const p = parts[idx[0]];
  const EPS = 1;
  return Math.abs(p.x - r.x) < EPS && Math.abs(p.y - r.y) < EPS &&
         Math.abs(p.w - r.w) < EPS && Math.abs(p.h - r.h) < EPS;
}

// ---------------------------------------------------------------------------
// Datum edges — a piece's DEFAULT measuring edge. Stored geometrically as a
// line SEGMENT in sheet space so a datum PROPAGATES to any child piece that
// retains that same edge on its boundary after a cut. A `DatumLine` with
// vertical=true is a constant-X edge (the piece's left/right side); the
// [lo,hi] span is the Y-extent it originally covered.
// ---------------------------------------------------------------------------

interface DatumLine { vertical: boolean; coord: number; lo: number; hi: number }

const DATUM_EPS = 1; // mm — collinear + coverage tolerance (matches region ops)

/** The four edges of a region as datum-line segments, keyed by side. */
function edgeLine(r: Region, side: DatumEdge['side']): DatumLine {
  switch (side) {
    case 'left':  return { vertical: true,  coord: r.x,       lo: r.y, hi: r.y + r.h };
    case 'right': return { vertical: true,  coord: r.x + r.w, lo: r.y, hi: r.y + r.h };
    case 'top':   return { vertical: false, coord: r.y,       lo: r.x, hi: r.x + r.w };
    case 'bottom':return { vertical: false, coord: r.y + r.h, lo: r.x, hi: r.x + r.w };
  }
}

/** The rounded-rect key for a region — matches cutKeyFor's parent format so a
 *  persisted DatumEdge.piece resolves back to the region it was set on. */
function regionKey(r: Region): string {
  const q = (n: number) => Math.round(n);
  return `${q(r.x)},${q(r.y)},${q(r.w)},${q(r.h)}`;
}

/** Does a region's `side` edge lie ON a datum line (collinear + fully covered
 *  by the datum's span)? This is the propagation test: a child piece inherits
 *  a datum when it retains that same boundary segment. */
function edgeIsDatum(r: Region, side: DatumEdge['side'], datums: DatumLine[]): boolean {
  const e = edgeLine(r, side);
  return datums.some((d) =>
    d.vertical === e.vertical &&
    Math.abs(d.coord - e.coord) < DATUM_EPS &&
    d.lo - DATUM_EPS <= e.lo && e.hi <= d.hi + DATUM_EPS);
}

/** Which datum sides (if any) of a region are valid parallel references for a
 *  cut of the given orientation. A vertical (constant-X) cut measures from a
 *  left/right edge; a horizontal cut from a top/bottom edge. Returns the near
 *  side first (matches the built-in default corner) then the far side. */
function datumSidesFor(r: Region, vertical: boolean, datums: DatumLine[]): DatumEdge['side'][] {
  const near: DatumEdge['side'] = vertical ? 'left' : 'top';
  const far: DatumEdge['side'] = vertical ? 'right' : 'bottom';
  const out: DatumEdge['side'][] = [];
  if (edgeIsDatum(r, near, datums)) out.push(near);
  if (edgeIsDatum(r, far, datums)) out.push(far);
  return out;
}

// ---------------------------------------------------------------------------
// Candidate cut lines — every clean full-span line within a region PLUS the
// trim lines. Part-edge candidates are clean lines on part edges that cross a
// piece edge-to-edge without slicing a part (mirrors pickLine in packRect).
// Trim candidates come from the engine's own trim geometry (cutStepsForSheet)
// so a hand-made cut on a trim line IS that trim.
// ---------------------------------------------------------------------------

export interface Candidate {
  /** Vertical (constant-X) or horizontal (constant-Y) line in SHEET space. */
  vertical: boolean;
  /** Absolute cut coordinate (X for vertical, Y for horizontal). */
  coord: number;
  /** The region (piece) this candidate cuts. */
  region: Region;
  /** True when this candidate sits on a margin/far-long TRIM line — committing
   *  it makes that trim (rendered blue, quotes the strip width). */
  isTrim?: boolean;
}

/** Part-edge candidates within a region — every clean full-span line. */
function partEdgeCandidates(r: Region, parts: NestSheet['parts']): Candidate[] {
  const EPS = 0.5;
  const idx = partsInRegion(r, parts);
  const items = idx.map((i) => parts[i]);
  const vSet = new Set<number>();
  const hSet = new Set<number>();
  for (const it of items) {
    if (it.x       > r.x + EPS && it.x       < r.x + r.w - EPS) vSet.add(it.x);
    if (it.x + it.w > r.x + EPS && it.x + it.w < r.x + r.w - EPS) vSet.add(it.x + it.w);
    if (it.y       > r.y + EPS && it.y       < r.y + r.h - EPS) hSet.add(it.y);
    if (it.y + it.h > r.y + EPS && it.y + it.h < r.y + r.h - EPS) hSet.add(it.y + it.h);
  }
  const out: Candidate[] = [];
  // A candidate is legal when every part lies wholly on one side (no
  // straddler). We also drop lines that only peel a BARE sub-kerf sliver of
  // waste off an edge (one side has zero parts and spans < WASTE_MIN) — those
  // are geometric noise, never a cut a human would make (the trim candidates
  // handle the intended margin peels).
  const WASTE_MIN = 5; // mm
  const legal = (vertical: boolean, coord: number): boolean => {
    let loParts = 0, hiParts = 0;
    for (const it of items) {
      const a = vertical ? it.x : it.y;
      const b = vertical ? it.x + it.w : it.y + it.h;
      if (b <= coord + EPS) { loParts++; continue; }   // wholly below/left
      if (a >= coord - EPS) { hiParts++; continue; }    // wholly above/right
      return false;                                      // straddler → not clean
    }
    const spanLo = vertical ? coord - r.x : coord - r.y;
    const spanHi = vertical ? r.x + r.w - coord : r.y + r.h - coord;
    if (loParts === 0 && spanLo < WASTE_MIN) return false;
    if (hiParts === 0 && spanHi < WASTE_MIN) return false;
    return true;
  };
  vSet.forEach((c) => { if (legal(true, c)) out.push({ vertical: true, coord: c, region: r }); });
  hSet.forEach((c) => { if (legal(false, c)) out.push({ vertical: false, coord: c, region: r }); });
  return out;
}

/** All candidates in a region = trim lines that cross it + part-edge lines.
 *  `trimLines` are the engine's trim lines (constant-X/Y). A trim line is
 *  offered on a region when it lies strictly inside the region and spans it
 *  edge-to-edge — i.e. the region still touches that raw edge. */
function candidatesInRegion(r: Region, parts: NestSheet['parts'], trimLines: TrimLine[]): Candidate[] {
  const EPS = 0.5;
  const out: Candidate[] = [];
  for (const t of trimLines) {
    const inside = t.vertical
      ? t.coord > r.x + EPS && t.coord < r.x + r.w - EPS
      : t.coord > r.y + EPS && t.coord < r.y + r.h - EPS;
    if (inside) out.push({ vertical: t.vertical, coord: t.coord, region: r, isTrim: true });
  }
  for (const c of partEdgeCandidates(r, parts)) {
    // Don't double-list a part-edge candidate that coincides with a trim line.
    if (out.some((o) => o.vertical === c.vertical && Math.abs(o.coord - c.coord) < 0.75)) continue;
    out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Trim lines — reuse the engine's trim geometry from cutStepsForSheet so a
// hand-made cut on a trim line IS that trim (same coordinate, same strip
// quoting). We take the trim CutSteps the auto path produces and reduce them
// to bare sheet-space lines (vertical + coord).
// ---------------------------------------------------------------------------

interface TrimLine { vertical: boolean; coord: number }

function trimLinesFor(ctx: CutEditorContext): TrimLine[] {
  const auto = deriveAuto(ctx);
  const W = ctx.sheet.sheetW, L = ctx.sheet.sheetL;
  return auto.trims.map((s) => {
    const vertical = stepIsVertical(s, W, L);
    return { vertical, coord: vertical ? s.parentX + s.distance : s.parentY + s.distance };
  });
}

/** Build the CutStep for a committed candidate. `fromFar` flips the quoted
 *  edge to the far parallel edge; `measureFromCut` (a cutKey) chain-dimensions
 *  off a previous cut; `isTrim` marks a trim-line cut; `isDatum` a datum-saved
 *  cut. */
function candidateToStep(
  c: Candidate, sheetW: number, sheetL: number,
  opts: { fromFar?: boolean; measureFromCut?: string; isTrim?: boolean; isDatum?: boolean },
): CutStep {
  const lengthIsY = sheetL >= sheetW;
  // A vertical (constant-X) line is a rip when the length axis is Y.
  const axis: 'rip' | 'cross' = c.vertical
    ? (lengthIsY ? 'rip' : 'cross')
    : (lengthIsY ? 'cross' : 'rip');
  const distance = c.vertical ? c.coord - c.region.x : c.coord - c.region.y;
  return {
    index: 0,
    axis,
    distance,
    parentX: c.region.x, parentY: c.region.y, parentW: c.region.w, parentH: c.region.h,
    depth: 0,
    fromFar: opts.fromFar || undefined,
    measureFromCut: opts.measureFromCut || undefined,
    isTrim: opts.isTrim || undefined,
    isDatum: opts.isDatum || undefined,
  };
}

// ---------------------------------------------------------------------------
// Auto-complete — fill the remaining sequence with the engine's order for the
// pieces the user hasn't finished. If the user hasn't made the trims yet, we
// GENERATE THE TRIMS FIRST (over the raw sheet), then decompose each live,
// unfinished piece with the engine's own min-cuts search. Rather than replay
// the fixed auto layout (whose parent rects no longer match once the user cuts
// lines the auto tree never used), we re-run deriveGuillotineCuts on each live
// piece so the order matches exactly the pieces the user hasn't finished.
// ---------------------------------------------------------------------------

/** Convert a bin-frame Cut (from deriveGuillotineCuts, anchored at region
 *  origin) into a sheet-frame CutStep, shifted by (ox, oy). */
function cutToStep(c: Cut, ox: number, oy: number, sheetW: number, sheetL: number): CutStep {
  const lengthIsY = sheetL >= sheetW;
  const isRip = (lengthIsY && c.axis === 'V') || (!lengthIsY && c.axis === 'H');
  return {
    index: 0,
    axis: isRip ? 'rip' : 'cross',
    distance: c.distance,
    parentX: c.parentX + ox, parentY: c.parentY + oy,
    parentW: c.parentW, parentH: c.parentH,
    depth: c.depth,
  };
}

/** The engine trim CutSteps that the user has NOT yet made — offered as the
 *  head of the auto-complete remainder. Matched by line coordinate. */
function missingTrimSteps(ctx: CutEditorContext, built: CutStep[]): CutStep[] {
  const auto = deriveAuto(ctx);
  const W = ctx.sheet.sheetW, L = ctx.sheet.sheetL;
  const builtLines = built.map((s) => {
    const v = stepIsVertical(s, W, L);
    return { vertical: v, coord: v ? s.parentX + s.distance : s.parentY + s.distance };
  });
  return auto.trims
    .filter((t) => {
      const v = stepIsVertical(t, W, L);
      const coord = v ? t.parentX + t.distance : t.parentY + t.distance;
      return !builtLines.some((b) => b.vertical === v && Math.abs(b.coord - coord) < 0.75);
    })
    .map((s) => ({ ...s }));
}

function autoRemainder(
  ctx: CutEditorContext,
  built: CutStep[],
): CutStep[] {
  const W = ctx.sheet.sheetW, L = ctx.sheet.sheetL;
  const parts = ctx.sheet.parts;
  const add: CutStep[] = [];
  // 1. Generate any trims the user hasn't made, over the current stock.
  const trims = missingTrimSteps(ctx, built);
  add.push(...trims);
  // 2. Decompose each live, unfinished piece (after the trims) with the engine.
  const regions = liveRegions([...built, ...trims], W, L);
  for (const r of regions) {
    if (regionFinished(r, parts)) continue;
    const idx = partsInRegion(r, parts);
    if (idx.length < 1) continue;
    const localRects = idx.map((i) => ({
      x: parts[i].x - r.x, y: parts[i].y - r.y, w: parts[i].w, h: parts[i].h,
    }));
    const cuts = deriveGuillotineCuts(localRects, r.w, r.h);
    for (const c of cuts) add.push(cutToStep(c, r.x, r.y, W, L));
  }
  return add;
}

// ---------------------------------------------------------------------------
// Editor state + open/close.
// ---------------------------------------------------------------------------

export interface CutEditorContext {
  sheet: NestSheet;
  margin: number;
  kerf: number;
  units: Units;
  kerfRef: KerfRef;
  /** Active sequence style — the editor auto-completes in THIS style so the
   *  suggested sequence matches what the PDF will emit. */
  sequenceStyle: SequenceStyle;
  strategy: string;
  jobName: string;
  /** Called after any change so the caller can re-render / persist externally
   *  if it wants (overrides are already saved to localStorage by the editor). */
  onChange?: () => void;
}

interface EditorSession {
  ctx: CutEditorContext;
  sig: string;
  /** The hand-built cut sequence, in commit order — trims INCLUDED (they are
   *  no longer pre-made). */
  built: CutStep[];
  /** Engine trim lines (bare sheet-space lines) offered as candidates. */
  trimLines: TrimLine[];
  /** User-declared datum edges, geometric line segments so they propagate to
   *  child pieces. Starts EMPTY — the user creates datums by saving a cut's
   *  fresh edge (or, retained, by a datum-saved trim). */
  datums: DatumLine[];
  changed: boolean;
  /** The session_start event, buffered so it's only written to the log once
   *  the user actually makes a change (no-change sessions leave no entry).
   *  Recording is ALWAYS ON for the editor — there is no toggle. */
  startEvent: SessionStartEvent | null;
}

let overlay: HTMLElement | null = null;
let session: EditorSession | null = null;
/** Currently hovered candidate (drawn red-dashed) — transient, not persisted. */
let hovered: Candidate | null = null;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Trims + auto layout for the current sheet (engine order, no overrides). */
function deriveAuto(ctx: CutEditorContext): { trims: CutStep[]; layout: CutStep[]; steps: CutStep[] } {
  const sc = cutStepsForSheet(ctx.sheet, ctx.sheet.globalIndex || 1, 1, ctx.margin, ctx.kerf, undefined, ctx.kerfRef, ctx.sequenceStyle);
  const trims = sc.steps.filter((s) => s.isTrim);
  const layout = sc.steps.filter((s) => !s.isTrim);
  return { trims, layout, steps: sc.steps };
}

/** The full working step list = built, renumbered + same-setting run flags
 *  applied (matches how cutStepsForSheet finishes a sequence). Datum-saved
 *  and trim cuts are marked isDatum so they render blue. */
function workingSteps(): CutStep[] {
  if (!session) return [];
  const all = session.built.map((s) => ({ ...s }));
  all.forEach((s, i) => { s.index = i + 1; if (s.isTrim) s.isDatum = true; });
  for (let i = 1; i < all.length; i++) {
    const p = all[i - 1], c = all[i];
    c.sameSetting = c.axis === p.axis && Math.abs(c.distance - p.distance) < 0.5;
  }
  return all;
}

/** Persist the built sequence as customSteps + the user datum edges. Clears
 *  the override entirely only when NOTHING is set (no built cuts, no datums). */
function persistSession(): void {
  if (!session) return;
  const datumEdges = userDatumEdges();
  if (session.built.length === 0 && datumEdges.length === 0) {
    setOverrides(session.sig, null);
    return;
  }
  const ov: SheetOverrides = {};
  if (session.built.length > 0) ov.customSteps = session.built.map((s) => ({ ...s }));
  if (datumEdges.length > 0) ov.datumEdges = datumEdges;
  setOverrides(session.sig, ov);
}

function metricsOf(steps: CutStep[]): SequenceMetrics {
  return sequenceMetrics(steps);
}

/** Reconstruct the built sequence from a saved customSteps override (if any). */
function builtFromOverrides(ov: SheetOverrides | undefined): CutStep[] {
  if (ov?.customSteps && ov.customSteps.length > 0) return ov.customSteps.map((s) => ({ ...s }));
  return [];
}

/** Reconstruct user datum lines from a persisted DatumEdge[] by REPLAYING the
 *  built cuts and matching each entry's piece key to a live region. A datum
 *  whose region no longer exists (layout changed) is dropped. */
function userDatumsFromOverrides(
  ov: SheetOverrides | undefined,
  built: CutStep[], sheetW: number, sheetL: number,
): DatumLine[] {
  if (!ov?.datumEdges || ov.datumEdges.length === 0) return [];
  const regions = liveRegions(built, sheetW, sheetL);
  const byKey = new Map<string, Region>();
  for (const r of regions) byKey.set(regionKey(r), r);
  const out: DatumLine[] = [];
  for (const de of ov.datumEdges) {
    const r = byKey.get(de.piece);
    if (r) out.push(edgeLine(r, de.side));
  }
  return out;
}

/** Serialise the session's user datum lines as DatumEdge[] keyed by the live
 *  region they currently sit on. */
function userDatumEdges(): DatumEdge[] {
  if (!session) return [];
  const { built, ctx } = session;
  const regions = liveRegions(built, ctx.sheet.sheetW, ctx.sheet.sheetL);
  const out: DatumEdge[] = [];
  const seen = new Set<string>();
  for (const d of session.datums) {
    for (const r of regions) {
      const side = (['left', 'right', 'top', 'bottom'] as DatumEdge['side'][])
        .find((s) => {
          const e = edgeLine(r, s);
          return e.vertical === d.vertical && Math.abs(e.coord - d.coord) < DATUM_EPS &&
                 e.lo >= d.lo - DATUM_EPS && e.hi <= d.hi + DATUM_EPS;
        });
      if (side) {
        const key = `${regionKey(r)}|${side}`;
        if (!seen.has(key)) { seen.add(key); out.push({ piece: regionKey(r), side }); }
      }
    }
  }
  return out;
}

/** Public entry point — open the editor for a sheet. */
export function openCutEditor(ctx: CutEditorContext): void {
  const sig = layoutSignature(ctx.sheet);
  const ov = getOverrides(sig);
  const auto = deriveAuto(ctx);
  const built = builtFromOverrides(ov);
  // Recording is ALWAYS ON for editor sessions — there is no toggle. We buffer
  // the session_start and flush it lazily on the first change so a session the
  // user just looks at (no edits) leaves no log entry.
  const startEvent: SessionStartEvent = {
    type: 'session_start',
    t: Date.now(),
    sheet: {
      w: ctx.sheet.sheetW, l: ctx.sheet.sheetL,
      margin: ctx.margin, kerf: ctx.kerf,
      strategy: ctx.strategy, thickness: ctx.sheet.thickness,
    },
    parts: ctx.sheet.parts.map((p) => ({
      code: `${ctx.sheet.globalIndex || ''}${p.panelLabel}`,
      x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.w), h: Math.round(p.h),
    })),
    autoSequence: auto.steps,
    autoMetrics: sequenceMetrics(auto.steps),
    signature: sig,
    jobName: ctx.jobName,
  };
  session = {
    ctx, sig,
    built,
    trimLines: trimLinesFor(ctx),
    datums: userDatumsFromOverrides(ov, built, ctx.sheet.sheetW, ctx.sheet.sheetL),
    changed: false,
    startEvent,
  };
  hovered = null;
  trainingRecorder.recording = true;

  buildOverlay();
  render();
}

/** Flush the buffered session_start once (on the first change of a session)
 *  so no-change sessions leave no log entry. */
function ensureSessionLogged(): void {
  if (!session || !session.startEvent) return;
  trainingRecorder.append(session.startEvent);
  session.startEvent = null;
}

function closeEditor(): void {
  if (!session) return;
  const s = session;
  // Only log a session_end when the session was actually changed (and thus
  // its session_start was flushed) — a no-change session leaves no entry.
  if (s.changed) {
    const note = window.prompt('Optional: why this cut order? (one line)') ?? '';
    const steps = workingSteps();
    trainingRecorder.append({
      type: 'session_end',
      t: Date.now(),
      finalSequence: steps,
      finalMetrics: metricsOf(steps),
      note,
    });
  }
  closeCutPopup();
  overlay?.remove();
  overlay = null;
  session = null;
  hovered = null;
}

// ---------------------------------------------------------------------------
// Actions.
// ---------------------------------------------------------------------------

function humanSummary(s: CutStep, ctx: CutEditorContext): string {
  const kind = s.isTrim ? 'Trim' : s.axis === 'rip' ? 'Rip' : 'Crosscut';
  const parent = `${Math.round(Math.max(s.parentW, s.parentH))}×${Math.round(Math.min(s.parentW, s.parentH))}`;
  return `${kind} ${fmtDim(s.distance, ctx.units)} · piece ${parent}`;
}

/** Piece-state snapshot for the training log: how many parts remain unfreed. */
function pieceState(): { pieces: number; finished: number } {
  if (!session) return { pieces: 0, finished: 0 };
  const { built, ctx } = session;
  const regions = liveRegions(built, ctx.sheet.sheetW, ctx.sheet.sheetL);
  let finished = 0;
  for (const r of regions) if (regionFinished(r, ctx.sheet.parts)) finished++;
  return { pieces: regions.length, finished };
}

/** The most recent PARALLEL cut whose fresh edge lies ON this candidate's
 *  piece — the "Previous cut" chain-dimensioning reference. With a parallel
 *  guide you register the stops off the FRESH-CUT edge, so a strip cut off the
 *  same parent chains off the prior cut. After a cut splits a piece, its line
 *  becomes the child's near/far BOUNDARY edge — that's where the previous cut
 *  now lives — so we accept a prior parallel cut whose line coincides with the
 *  candidate region's near or far parallel edge (or lies in its interior). We
 *  ignore the candidate's own line. Walks built in reverse (most recent first). */
function previousParallelCut(c: Candidate): { step: CutStep; builtIdx: number } | null {
  if (!session) return null;
  const { built, ctx } = session;
  const W = ctx.sheet.sheetW, L = ctx.sheet.sheetL;
  const EPS = 0.5;
  const lo = c.vertical ? c.region.x : c.region.y;
  const hi = c.vertical ? c.region.x + c.region.w : c.region.y + c.region.h;
  for (let i = built.length - 1; i >= 0; i--) {
    const s = built[i];
    if (s.isTrim) continue; // a trim is a stock-edge datum, not a chain link
    const v = stepIsVertical(s, W, L);
    if (v !== c.vertical) continue; // must be parallel to this cut
    const line = (v ? s.parentX : s.parentY) + s.distance;
    // Must lie on this piece: within its span (interior OR on a parallel edge).
    if (line < lo - EPS || line > hi + EPS) continue;
    if (Math.abs(line - c.coord) < EPS) continue; // not the candidate itself
    return { step: s, builtIdx: i };
  }
  return null;
}

/** Commit a candidate with an explicit reference resolution. */
function commitCandidate(c: Candidate, ref: CutRef, saveDatum: boolean): void {
  if (!session) return;
  const { ctx } = session;
  const W = ctx.sheet.sheetW, L = ctx.sheet.sheetL;

  let fromFar = false;
  let measureFromCut: string | undefined;
  let provenance: 'armed' | 'datum' | 'default' = 'default';
  if (ref.kind === 'far') { fromFar = true; provenance = 'default'; }
  else if (ref.kind === 'datum') {
    fromFar = ref.side === 'right' || ref.side === 'bottom';
    provenance = 'datum';
  } else if (ref.kind === 'prevCut') {
    measureFromCut = cutKeyFor(ref.step);
    provenance = 'armed'; // chained off a fresh-cut edge — an explicit choice
  }
  // 'near' → defaults (fromFar false, no chain).

  ensureSessionLogged();
  const step = candidateToStep(c, W, L, {
    fromFar, measureFromCut, isTrim: c.isTrim, isDatum: saveDatum,
  });
  session.built.push(step);
  session.changed = true;
  hovered = null;

  // A datum-saved cut registers its FRESH edge as a datum line so later cuts
  // can measure from it (and it propagates to children retaining that edge).
  if (saveDatum) {
    const v = c.vertical;
    const line: DatumLine = v
      ? { vertical: true, coord: c.coord, lo: c.region.y, hi: c.region.y + c.region.h }
      : { vertical: false, coord: c.coord, lo: c.region.x, hi: c.region.x + c.region.w };
    session.datums.push(line);
  }
  persistSession();

  const measuredFrom: 'L' | 'R' | 'T' | 'B' = c.vertical
    ? (fromFar ? 'R' : 'L')
    : (fromFar ? 'B' : 'T');
  trainingRecorder.append({
    type: 'manual_cut',
    t: Date.now(),
    cut: cutKeyFor(step),
    summary: humanSummary(step, ctx),
    value: fromFar,
    armedFar: provenance === 'armed' && fromFar,
    measuredFrom,
    measuredProvenance: provenance,
    measuredFromCut: measureFromCut,
    datumSaved: saveDatum,
    piece: pieceState(),
    sequenceAfter: session.built.map((s) => cutKeyFor(s)),
    metricsAfter: metricsOf(workingSteps()),
  });
  ctx.onChange?.();
  render();
}

function sameRegion(a: Region, b: Region): boolean {
  return Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 &&
         Math.abs(a.w - b.w) < 1 && Math.abs(a.h - b.h) < 1;
}

function undoLast(): void {
  if (!session || session.built.length === 0) return;
  ensureSessionLogged();
  const removed = session.built.pop()!;
  session.changed = true;
  hovered = null;
  // Drop any datum line whose fresh edge belonged to the removed cut.
  pruneOrphanDatums();
  persistSession();
  trainingRecorder.append({
    type: 'undo',
    t: Date.now(),
    cut: cutKeyFor(removed),
    summary: humanSummary(removed, session.ctx),
    piece: pieceState(),
    sequenceAfter: session.built.map((s) => cutKeyFor(s)),
    metricsAfter: metricsOf(workingSteps()),
  });
  session.ctx.onChange?.();
  render();
}

/** Truncate the built sequence back to `keep` cuts (undo-to-here). */
function undoToHere(keep: number): void {
  if (!session) return;
  if (keep >= session.built.length) return;
  ensureSessionLogged();
  session.built = session.built.slice(0, keep);
  session.changed = true;
  hovered = null;
  pruneOrphanDatums();
  persistSession();
  trainingRecorder.append({
    type: 'undo',
    t: Date.now(),
    cut: `truncate:${keep}`,
    summary: `Undo to ${keep} built cut(s)`,
    piece: pieceState(),
    sequenceAfter: session.built.map((s) => cutKeyFor(s)),
    metricsAfter: metricsOf(workingSteps()),
  });
  session.ctx.onChange?.();
  render();
}

/** Drop datum lines that no longer coincide with any live piece edge (their
 *  originating cut was undone). */
function pruneOrphanDatums(): void {
  if (!session) return;
  const { built, ctx } = session;
  const regions = liveRegions(built, ctx.sheet.sheetW, ctx.sheet.sheetL);
  session.datums = session.datums.filter((d) =>
    regions.some((r) =>
      (['left', 'right', 'top', 'bottom'] as DatumEdge['side'][]).some((s) => {
        const e = edgeLine(r, s);
        return e.vertical === d.vertical && Math.abs(e.coord - d.coord) < DATUM_EPS;
      })));
}

function resetToBareStock(): void {
  if (!session) return;
  const { ctx } = session;
  if (session.built.length > 0 || session.datums.length > 0) ensureSessionLogged();
  session.built = [];
  session.datums = [];
  session.changed = true;
  hovered = null;
  setOverrides(session.sig, null);
  ctx.onChange?.();
  render();
}

function autoComplete(): void {
  if (!session) return;
  const { ctx } = session;
  const remainder = autoRemainder(ctx, session.built);
  if (remainder.length === 0) { render(); return; }
  ensureSessionLogged();
  session.built.push(...remainder);
  session.changed = true;
  hovered = null;
  persistSession();
  trainingRecorder.append({
    type: 'auto_complete',
    t: Date.now(),
    added: remainder.length,
    piece: pieceState(),
    sequenceAfter: session.built.map((s) => cutKeyFor(s)),
    metricsAfter: metricsOf(workingSteps()),
  });
  ctx.onChange?.();
  render();
}

/** Flip the measured-from edge (fromFar) of a built cut by index. Clears any
 *  chain reference. */
function toggleFlip(builtIdx: number): void {
  if (!session) return;
  const s = session.built[builtIdx];
  if (!s) return;
  ensureSessionLogged();
  s.fromFar = !s.fromFar;
  s.measureFromCut = undefined;
  session.changed = true;
  persistSession();
  trainingRecorder.append({
    type: 'flip_edge',
    t: Date.now(),
    cut: cutKeyFor(s),
    summary: humanSummary(s, session.ctx),
    value: !!s.fromFar,
    sequenceAfter: session.built.map((x) => cutKeyFor(x)),
    metricsAfter: metricsOf(workingSteps()),
  });
  session.ctx.onChange?.();
  render();
}

/** Toggle the datum (REF) flag of a built cut by index. */
function toggleDatum(builtIdx: number): void {
  if (!session) return;
  const s = session.built[builtIdx];
  if (!s) return;
  ensureSessionLogged();
  s.isDatum = !s.isDatum;
  session.changed = true;
  persistSession();
  trainingRecorder.append({
    type: 'mark_datum',
    t: Date.now(),
    cut: cutKeyFor(s),
    summary: humanSummary(s, session.ctx),
    value: !!s.isDatum,
    sequenceAfter: session.built.map((x) => cutKeyFor(x)),
    metricsAfter: metricsOf(workingSteps()),
  });
  session.ctx.onChange?.();
  render();
}

// ---------------------------------------------------------------------------
// DOM — overlay skeleton (built once per open) + render (rebuilt each change).
// ---------------------------------------------------------------------------

function buildOverlay(): void {
  overlay?.remove();
  overlay = document.createElement('div');
  overlay.className = 'cut-editor-overlay';
  overlay.innerHTML = `
    <div class="cut-editor-modal" role="dialog" aria-modal="true" aria-label="Edit cut sequence">
      <header class="cut-editor-head">
        <div class="cut-editor-title"></div>
        <div class="cut-editor-head-actions">
          <button type="button" class="ghost cut-editor-download" data-role="download">Download log</button>
          <button type="button" class="ghost" data-role="undo">↶ Undo</button>
          <button type="button" class="ghost" data-role="auto">Auto-complete</button>
          <button type="button" class="ghost cut-editor-reset" data-role="reset">Reset</button>
          <button type="button" class="ghost cut-editor-close" data-role="close" aria-label="Close">✕</button>
        </div>
      </header>
      <div class="cut-editor-body">
        <div class="cut-editor-diagram" data-role="diagram"></div>
        <div class="cut-editor-list" data-role="list"></div>
      </div>
    </div>`;

  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) closeEditor();
  });
  overlay.querySelector('[data-role="close"]')?.addEventListener('click', closeEditor);
  overlay.querySelector('[data-role="reset"]')?.addEventListener('click', resetToBareStock);
  overlay.querySelector('[data-role="undo"]')?.addEventListener('click', undoLast);
  overlay.querySelector('[data-role="auto"]')?.addEventListener('click', autoComplete);
  overlay.querySelector('[data-role="download"]')?.addEventListener('click', () => {
    if (session) trainingRecorder.download(session.ctx.jobName);
  });

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (cutPopup) { closeCutPopup(); return; }
      closeEditor(); document.removeEventListener('keydown', onKey);
    }
    else if ((e.key === 'z' && (e.ctrlKey || e.metaKey)) && session) { e.preventDefault(); undoLast(); }
  };
  document.addEventListener('keydown', onKey);

  document.body.appendChild(overlay);
}

function render(): void {
  if (!overlay || !session) return;
  const steps = workingSteps();

  const titleEl = overlay.querySelector('.cut-editor-title');
  if (titleEl) {
    const total = session.ctx.sheet.parts.length;
    const freedParts = countFreedParts();
    titleEl.textContent =
      `Sheet ${session.ctx.sheet.globalIndex || ''} · ${steps.length} cuts · ${freedParts}/${total} parts freed`;
  }
  const undoBtn = overlay.querySelector('[data-role="undo"]') as HTMLButtonElement | null;
  if (undoBtn) undoBtn.disabled = session.built.length === 0;
  const autoBtn = overlay.querySelector('[data-role="auto"]') as HTMLButtonElement | null;
  if (autoBtn) autoBtn.disabled = countFreedParts() >= session.ctx.sheet.parts.length;

  renderStack();
  renderList();
}

/** How many parts are alone in a live region (fully freed). */
function countFreedParts(): number {
  if (!session) return 0;
  const { built, ctx } = session;
  const regions = liveRegions(built, ctx.sheet.sheetW, ctx.sheet.sheetL);
  let freed = 0;
  for (const r of regions) {
    const idx = partsInRegion(r, ctx.sheet.parts);
    if (idx.length === 1) freed++;
  }
  return freed;
}

// ---------------------------------------------------------------------------
// Diagram (left) — SVG matching the PDF cut-diagram colors, plus interactive
// candidate lines. Clicking a candidate opens the config popup.
// ---------------------------------------------------------------------------

function el(name: string, attrs: Record<string, string | number>): SVGElement {
  const e = document.createElementNS(SVG_NS, name);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  return e;
}

/** Rebuild the whole LEFT pane — a vertically-scrollable STACK of diagram
 *  sections. First section is the original BOARD (full sheet + all committed
 *  cuts + parts + fades). When a cut splits the board, each LIVE, UNFINISHED
 *  split-off piece becomes its OWN section below, cuttable independently. The
 *  board section is itself interactive while nothing has been split off yet
 *  (so the very first cuts are made on it); once split, interaction moves to
 *  the per-piece sections and the board stays as the overview. */
function renderStack(): void {
  if (!overlay || !session) return;
  const host = overlay.querySelector('[data-role="diagram"]') as HTMLElement;
  if (!host) return;
  const { sheet } = session.ctx;
  const W = sheet.sheetW, L = sheet.sheetL;
  const regions = liveRegions(session.built, W, L);
  const unfinished = regions.filter((r) => !regionFinished(r, sheet.parts));
  const board: Region = { x: 0, y: 0, w: W, h: L };

  // The board section is interactive only when nothing has been split off yet
  // (a single live region covering the whole sheet) — otherwise the per-piece
  // sections own the interaction.
  const boardInteractive = unfinished.length <= 1 &&
    (unfinished.length === 0 || sameRegion(unfinished[0], board));

  host.innerHTML = '';

  // Section 1 — the original board (overview + committed cuts).
  const boardSec = buildSection(board, `Board — ${dimLabel(W, L)}`, boardInteractive, 0);
  host.appendChild(boardSec);

  // A per-piece section for every live, unfinished split-off piece — but not
  // the whole-sheet region (that IS the board section above). Numbered in the
  // reading order top-to-bottom, left-to-right.
  if (!boardInteractive) {
    const pieces = unfinished
      .filter((r) => !sameRegion(r, board))
      .sort((a, b) => (a.y - b.y) || (a.x - b.x));
    pieces.forEach((r, i) => {
      host.appendChild(buildSection(r, `Piece ${i + 2} — ${dimLabel(r.w, r.h)}`, true, i + 1));
    });
  }
}

function dimLabel(w: number, h: number): string {
  const lo = Math.round(Math.min(w, h)), hi = Math.round(Math.max(w, h));
  return `${hi}×${lo}`;
}

/** Build one diagram SECTION: a titled SVG scoped to `region`. When `region`
 *  is the whole sheet it's the board overview; otherwise it's a cropped
 *  sub-diagram of one split-off piece. `interactive` gates candidate hit
 *  targets so only the active piece(s) accept clicks. */
function buildSection(region: Region, title: string, interactive: boolean, _idx: number): HTMLElement {
  const sec = document.createElement('section');
  sec.className = 'cut-piece-section' + (interactive ? '' : ' overview');

  const head = document.createElement('div');
  head.className = 'cut-piece-title';
  head.textContent = title;
  sec.appendChild(head);

  const svg = buildRegionSvg(region, interactive);
  sec.appendChild(svg);
  return sec;
}

/** Build the SVG for a region — draws only the parts/cuts/candidates within
 *  the region's bounds. The board region draws the whole sheet. */
function buildRegionSvg(region: Region, interactive: boolean): SVGSVGElement {
  const { sheet } = session!.ctx;
  const W = sheet.sheetW, L = sheet.sheetL;
  const built = session!.built;
  const isBoard = region.x === 0 && region.y === 0 &&
    Math.abs(region.w - W) < 1 && Math.abs(region.h - L) < 1;
  const regions = liveRegions(built, W, L);

  const pad = 12;
  const svg = el('svg', {
    viewBox: `${region.x - pad} ${region.y - pad} ${region.w + pad * 2} ${region.h + pad * 2}`,
    preserveAspectRatio: 'xMidYMid meet',
    class: 'cut-editor-svg',
    'data-region': regionKey(region),
  }) as SVGSVGElement;

  // Cream stock for this region.
  svg.appendChild(el('rect', { x: region.x, y: region.y, width: region.w, height: region.h, fill: '#F5EFD9', stroke: '#B4A270', 'stroke-width': 1 }));

  // Parts within (or overlapping) this region at 50% opacity + labels.
  for (const p of sheet.parts) {
    if (p.x + p.w <= region.x + 0.5 || p.x >= region.x + region.w - 0.5 ||
        p.y + p.h <= region.y + 0.5 || p.y >= region.y + region.h - 0.5) continue;
    svg.appendChild(el('rect', { x: p.x, y: p.y, width: p.w, height: p.h, fill: p.color, 'fill-opacity': 0.5 }));
    const minPx = Math.min(p.w, p.h);
    if (minPx > 60) {
      const t = el('text', {
        x: p.x + p.w / 2, y: p.y + p.h / 2,
        'text-anchor': 'middle', 'dominant-baseline': 'central',
        'font-size': Math.max(14, Math.min(40, minPx * 0.28)),
        fill: '#333', 'font-weight': 600,
      });
      t.textContent = `${sheet.globalIndex || ''}${p.panelLabel}`;
      svg.appendChild(t);
    }
  }

  // On the BOARD overview, fade finished pieces so the live ones stand out.
  if (isBoard) {
    for (const r of regions) {
      if (regionFinished(r, sheet.parts)) {
        svg.appendChild(el('rect', { x: r.x, y: r.y, width: r.w, height: r.h, fill: '#FFFFFF', 'fill-opacity': 0.6 }));
      }
    }
  }

  // Committed cuts whose line crosses this region: white for plain cuts, BLUE
  // for trim + datum cuts (drawn after, on top).
  for (const s of built) {
    if (s.isTrim || s.isDatum) continue;
    if (cutTouchesRegion(s, region, W, L)) appendCutLine(svg, s, W, L, '#FFFFFF', 2.4);
  }
  for (const s of built) {
    if (!(s.isTrim || s.isDatum)) continue;
    if (cutTouchesRegion(s, region, W, L)) appendCutLine(svg, s, W, L, '#2B6CB0', 3);
  }

  // Datum EDGES on this region (and, on the board, all live pieces) — BLUE.
  const datumRegions = isBoard ? regions : [region];
  for (const r of datumRegions) {
    for (const side of ['left', 'right', 'top', 'bottom'] as DatumEdge['side'][]) {
      if (!edgeIsDatum(r, side, session!.datums)) continue;
      const e = edgeLine(r, side);
      if (e.vertical) {
        svg.appendChild(el('line', { x1: e.coord, y1: e.lo, x2: e.coord, y2: e.hi, stroke: '#2B6CB0', 'stroke-width': 4, class: 'cut-datum-edge' }));
      } else {
        svg.appendChild(el('line', { x1: e.lo, y1: e.coord, x2: e.hi, y2: e.coord, stroke: '#2B6CB0', 'stroke-width': 4, class: 'cut-datum-edge' }));
      }
    }
  }

  // Green reference highlight while the config popup is open, if its candidate
  // belongs to THIS region.
  if (cutPopup && cutPopupState && sameRegion(cutPopupState.candidate.region, region)) {
    drawPopupReference(svg);
  }

  if (!interactive) return svg;

  // Candidate lines for THIS region — faint gray (trim = faint blue-gray).
  const cands = candidatesInRegion(region, sheet.parts, session!.trimLines);
  for (const c of cands) {
    const isHover = hovered != null && candEq(hovered, c);
    const color = isHover ? '#E03E3E' : (c.isTrim ? '#7B93B8' : '#9A8F73');
    const wid = isHover ? 4 : 1.4;
    const line = el('line', {
      ...candLineCoords(c),
      stroke: color, 'stroke-width': wid,
      'stroke-dasharray': isHover ? '10 7' : '4 6',
      class: 'cut-candidate' + (c.isTrim ? ' trim' : ''),
      'data-cand': candKey(c),
    });
    (line as SVGElement).style.cursor = 'pointer';
    // Only re-render when the hover actually CHANGES — an unconditional
    // renderStack() here replaces the node under the cursor, which re-fires
    // mouseenter in a loop and destroys the click target between mousedown
    // and mouseup (real clicks never land; synthetic dispatch hid this).
    const hoverTo = () => {
      if (!hovered || !candEq(hovered, c)) { hovered = c; renderStack(); }
    };
    line.addEventListener('mouseenter', hoverTo);
    line.addEventListener('mouseleave', () => { if (hovered && candEq(hovered, c)) { hovered = null; renderStack(); } });
    line.addEventListener('click', (e) => { e.stopPropagation(); openCutPopup(e as MouseEvent, c); });
    const hit = el('line', {
      ...candLineCoords(c),
      stroke: 'transparent', 'stroke-width': 22,
      // A transparent stroke is invisible to the default 'visiblePainted'
      // hit-testing — events must be taken on the stroke geometry itself.
      'pointer-events': 'stroke',
      class: 'cut-candidate-hit', 'data-cand': candKey(c),
    });
    (hit as SVGElement).style.cursor = 'pointer';
    hit.addEventListener('mouseenter', hoverTo);
    hit.addEventListener('mouseleave', () => { if (hovered && candEq(hovered, c)) { hovered = null; renderStack(); } });
    hit.addEventListener('click', (e) => { e.stopPropagation(); openCutPopup(e as MouseEvent, c); });
    svg.appendChild(hit);
    svg.appendChild(line);
    // The hovered candidate's live quote (default reference).
    if (isHover) {
      const q = quoteForCandidate(c, defaultRefFor(c));
      const { x1, y1, x2, y2 } = candLineCoords(c) as any;
      const mx = (Number(x1) + Number(x2)) / 2, my = (Number(y1) + Number(y2)) / 2;
      const t = el('text', {
        x: mx + 8, y: my - 8,
        'font-size': Math.max(16, Math.min(34, Math.max(region.w, region.h) * 0.02)),
        fill: '#E03E3E', 'font-weight': 700, 'paint-order': 'stroke',
        stroke: '#fff', 'stroke-width': 3,
      });
      t.textContent = fmtDim(q, session!.ctx.units);
      svg.appendChild(t);
    }
  }

  return svg;
}

/** Does a committed cut's line lie within (touch the interior of) a region? */
function cutTouchesRegion(s: CutStep, region: Region, W: number, L: number): boolean {
  const v = stepIsVertical(s, W, L);
  const line = (v ? s.parentX : s.parentY) + s.distance;
  const EPS = 0.5;
  if (v) return line > region.x - EPS && line < region.x + region.w + EPS &&
                 s.parentY < region.y + region.h + EPS && s.parentY + s.parentH > region.y - EPS;
  return line > region.y - EPS && line < region.y + region.h + EPS &&
             s.parentX < region.x + region.w + EPS && s.parentX + s.parentW > region.x - EPS;
}

/** Draw the green highlight for the reference currently selected in the popup. */
function drawPopupReference(svg: SVGSVGElement): void {
  if (!session || !cutPopupState) return;
  const { candidate: c, ref } = cutPopupState;
  const green = '#2F855A';
  if (ref.kind === 'near' || ref.kind === 'far') {
    if (c.vertical) {
      const gx = ref.kind === 'far' ? c.region.x + c.region.w : c.region.x;
      svg.appendChild(el('line', { x1: gx, y1: c.region.y, x2: gx, y2: c.region.y + c.region.h, stroke: green, 'stroke-width': 5 }));
    } else {
      const gy = ref.kind === 'far' ? c.region.y + c.region.h : c.region.y;
      svg.appendChild(el('line', { x1: c.region.x, y1: gy, x2: c.region.x + c.region.w, y2: gy, stroke: green, 'stroke-width': 5 }));
    }
  } else if (ref.kind === 'datum') {
    const e = edgeLine(c.region, ref.side);
    if (e.vertical) svg.appendChild(el('line', { x1: e.coord, y1: e.lo, x2: e.coord, y2: e.hi, stroke: green, 'stroke-width': 5 }));
    else svg.appendChild(el('line', { x1: e.lo, y1: e.coord, x2: e.hi, y2: e.coord, stroke: green, 'stroke-width': 5 }));
  } else if (ref.kind === 'prevCut') {
    const s = ref.step;
    const v = stepIsVertical(s, session.ctx.sheet.sheetW, session.ctx.sheet.sheetL);
    if (v) {
      const gx = s.parentX + s.distance;
      svg.appendChild(el('line', { x1: gx, y1: s.parentY, x2: gx, y2: s.parentY + s.parentH, stroke: green, 'stroke-width': 5 }));
    } else {
      const gy = s.parentY + s.distance;
      svg.appendChild(el('line', { x1: s.parentX, y1: gy, x2: s.parentX + s.parentW, y2: gy, stroke: green, 'stroke-width': 5 }));
    }
  }
}

// ---------------------------------------------------------------------------
// Cut config popup — opens when a candidate line is clicked. Fields: save as
// datum (yes/no) + measure-from (radio list). Confirm commits; cancel closes.
// ---------------------------------------------------------------------------

/** A resolved measure-from reference for a cut. */
type CutRef =
  | { kind: 'near' }                                   // near parallel edge (default)
  | { kind: 'far' }                                    // far parallel edge (fromFar)
  | { kind: 'datum'; side: DatumEdge['side'] }         // a parallel datum edge on the piece
  | { kind: 'prevCut'; step: CutStep; builtIdx: number }; // chain off a previous cut

interface CutPopupState {
  candidate: Candidate;
  ref: CutRef;
  saveDatum: boolean;
  refs: { ref: CutRef; label: string }[];
}

let cutPopup: HTMLElement | null = null;
let cutPopupState: CutPopupState | null = null;

function closeCutPopup(): void {
  cutPopup?.remove();
  cutPopup = null;
  cutPopupState = null;
  document.removeEventListener('mousedown', onCutPopupOutside, true);
  if (session && overlay) renderStack(); // clear any green reference
}

function onCutPopupOutside(e: MouseEvent): void {
  if (cutPopup && !cutPopup.contains(e.target as Node)) closeCutPopup();
}

/** The DEFAULT reference for a candidate: a near/far parallel datum if one
 *  exists (near preferred), else the built-in near edge. */
function defaultRefFor(c: Candidate): CutRef {
  if (!session) return { kind: 'near' };
  const sides = datumSidesFor(c.region, c.vertical, session.datums);
  if (sides.length > 0) return { kind: 'datum', side: sides[0] };
  return { kind: 'near' };
}

/** Enumerate every valid measure-from reference for a candidate, in the order
 *  the popup lists them: near edge, far edge, each parallel datum edge, and
 *  the most recent parallel cut on this piece ("Previous cut"). */
function refsForCandidate(c: Candidate): { ref: CutRef; label: string }[] {
  if (!session) return [];
  // A TRIM candidate sits on a stock edge — its quote is always the strip
  // width coming off; a "measure from" choice is meaningless, so offer none.
  if (c.isTrim) return [];
  const list: { ref: CutRef; label: string }[] = [];
  const nearLbl = c.vertical ? 'Left edge' : 'Top edge';
  const farLbl = c.vertical ? 'Right edge' : 'Bottom edge';
  list.push({ ref: { kind: 'near' }, label: nearLbl });
  list.push({ ref: { kind: 'far' }, label: farLbl });
  for (const side of datumSidesFor(c.region, c.vertical, session.datums)) {
    // Don't duplicate the near/far plain-edge entries — a datum edge that sits
    // on the near/far side is listed as a distinct "datum" option.
    list.push({ ref: { kind: 'datum', side }, label: `Datum ${side} edge` });
  }
  const prev = previousParallelCut(c);
  if (prev) list.push({ ref: { kind: 'prevCut', step: prev.step, builtIdx: prev.builtIdx }, label: 'Previous cut' });
  return list;
}

function refEq(a: CutRef, b: CutRef): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'datum' && b.kind === 'datum') return a.side === b.side;
  if (a.kind === 'prevCut' && b.kind === 'prevCut') return a.builtIdx === b.builtIdx;
  return true;
}

function openCutPopup(ev: MouseEvent, c: Candidate): void {
  closeCutPopup();
  if (!session) return;
  hovered = c;
  const refs = refsForCandidate(c);
  cutPopupState = {
    candidate: c,
    ref: defaultRefFor(c),
    saveDatum: false,
    refs,
  };
  buildCutPopup(ev);
  renderStack(); // draw the green reference for the default selection
}

function buildCutPopup(ev: MouseEvent): void {
  if (!session || !cutPopupState) return;
  const units = session.ctx.units;
  const st = cutPopupState;
  const c = st.candidate;

  const menu = document.createElement('div');
  menu.className = 'cut-config-popup';

  const kind = c.isTrim ? 'Trim' : c.vertical
    ? (session.ctx.sheet.sheetL >= session.ctx.sheet.sheetW ? 'Rip' : 'Crosscut')
    : (session.ctx.sheet.sheetL >= session.ctx.sheet.sheetW ? 'Crosscut' : 'Rip');
  const q = quoteForCandidate(c, st.ref);
  // Trims quote the strip width and have no measure-from choice.
  const measureField = st.refs.length > 0 ? `
    <div class="cut-config-field measure">
      <span class="cut-config-label">Measure from</span>
      <div class="cut-config-refs" data-role="refs"></div>
    </div>` : '';
  menu.innerHTML = `
    <div class="cut-config-head">
      <span class="cut-config-kind">${kind}</span>
      <span class="cut-config-quote" data-role="quote">${fmtDim(q, session.ctx.units)}</span>
    </div>
    <label class="cut-config-field">
      <span class="cut-config-label">Save as datum</span>
      <span class="cut-config-toggle">
        <button type="button" class="cut-config-yn" data-yn="no">No</button>
        <button type="button" class="cut-config-yn" data-yn="yes">Yes</button>
      </span>
    </label>
    ${measureField}
    <div class="cut-config-actions">
      <button type="button" class="cut-config-btn cancel" data-role="cancel">Cancel</button>
      <button type="button" class="cut-config-btn make" data-role="make">Make cut</button>
    </div>`;

  // Save-as-datum yes/no.
  const ynNo = menu.querySelector('[data-yn="no"]') as HTMLButtonElement;
  const ynYes = menu.querySelector('[data-yn="yes"]') as HTMLButtonElement;
  const paintYn = () => {
    ynNo.classList.toggle('on', !st.saveDatum);
    ynYes.classList.toggle('on', st.saveDatum);
  };
  ynNo.addEventListener('click', (e) => { e.stopPropagation(); st.saveDatum = false; paintYn(); });
  ynYes.addEventListener('click', (e) => { e.stopPropagation(); st.saveDatum = true; paintYn(); });
  paintYn();

  // Measure-from radio list. Each row highlights the reference on the diagram
  // when hovered/selected; the selected reference row + quote render blue.
  // Absent for trims (they quote the strip width, no measure-from choice).
  const refsHost = menu.querySelector('[data-role="refs"]') as HTMLElement | null;
  const quoteEl = menu.querySelector('[data-role="quote"]') as HTMLElement;
  const paintRefs = () => {
    if (refsHost) {
      for (const row of Array.from(refsHost.children) as HTMLElement[]) {
        const idx = Number(row.dataset.idx);
        row.classList.toggle('sel', refEq(st.refs[idx].ref, st.ref));
      }
    }
    quoteEl.textContent = fmtDim(quoteForCandidate(c, st.ref), units);
  };
  if (refsHost) {
    st.refs.forEach((r, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'cut-config-ref';
      row.dataset.idx = String(i);
      row.innerHTML = `<span class="cut-config-radio"></span><span class="cut-config-ref-label">${r.label}</span>`;
      row.addEventListener('mouseenter', () => {
        // Preview this reference on the diagram without committing the selection.
        const prev = st.ref;
        st.ref = r.ref;
        renderStack();
        st.ref = prev;
      });
      row.addEventListener('mouseleave', () => { renderStack(); });
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        st.ref = r.ref;
        paintRefs();
        renderStack();
      });
      refsHost.appendChild(row);
    });
  }
  paintRefs();

  menu.querySelector('[data-role="cancel"]')?.addEventListener('click', (e) => {
    e.stopPropagation(); closeCutPopup();
  });
  menu.querySelector('[data-role="make"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const st2 = cutPopupState!;
    const cand = st2.candidate, ref = st2.ref, save = st2.saveDatum;
    closeCutPopup();
    commitCandidate(cand, ref, save);
  });

  document.body.appendChild(menu);

  // Position near the click, clamped to the viewport.
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let x = ev.clientX + 8, y = ev.clientY + 8;
  if (x + mw > window.innerWidth - 8) x = ev.clientX - mw - 8;
  if (y + mh > window.innerHeight - 8) y = window.innerHeight - mh - 8;
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;

  cutPopup = menu;
  setTimeout(() => document.addEventListener('mousedown', onCutPopupOutside, true), 0);
}

function candLineCoords(c: Candidate): { x1: number; y1: number; x2: number; y2: number } {
  if (c.vertical) {
    return { x1: c.coord, y1: c.region.y, x2: c.coord, y2: c.region.y + c.region.h };
  }
  return { x1: c.region.x, y1: c.coord, x2: c.region.x + c.region.w, y2: c.coord };
}

function candKey(c: Candidate): string {
  return `${c.vertical ? 'V' : 'H'}|${Math.round(c.coord)}|${Math.round(c.region.x)},${Math.round(c.region.y)},${Math.round(c.region.w)},${Math.round(c.region.h)}`;
}
function candEq(a: Candidate, b: Candidate): boolean { return candKey(a) === candKey(b); }

/** Quote a candidate for a given reference, the way the PDF would (kerfRef +
 *  reference edge / chained line). */
function quoteForCandidate(c: Candidate, ref: CutRef): number {
  if (!session) return 0;
  const span = c.vertical ? c.region.w : c.region.h;
  const distance = c.vertical ? c.coord - c.region.x : c.coord - c.region.y;
  const mode = session.ctx.kerfRef;
  const allowance = mode === 'keeper' ? session.ctx.kerf : mode === 'spacing' ? session.ctx.kerf / 2 : 0;
  if (c.isTrim) return Math.min(distance, span - distance);
  if (ref.kind === 'prevCut') {
    const s = ref.step;
    const v = stepIsVertical(s, session.ctx.sheet.sheetW, session.ctx.sheet.sheetL);
    const refLine = (v ? s.parentX : s.parentY) + s.distance;
    return Math.max(0, Math.abs(c.coord - refLine) - allowance);
  }
  let fromFar = false;
  if (ref.kind === 'far') fromFar = true;
  else if (ref.kind === 'datum') fromFar = ref.side === 'right' || ref.side === 'bottom';
  const base = fromFar ? span - distance : distance;
  return Math.max(0, base - allowance);
}

function appendCutLine(svg: SVGSVGElement, step: CutStep, W: number, L: number, color: string, width: number): void {
  const vertical = stepIsVertical(step, W, L);
  if (vertical) {
    const dx = step.parentX + step.distance;
    svg.appendChild(el('line', { x1: dx, y1: step.parentY, x2: dx, y2: step.parentY + step.parentH, stroke: color, 'stroke-width': width }));
  } else {
    const dy = step.parentY + step.distance;
    svg.appendChild(el('line', { x1: step.parentX, y1: dy, x2: step.parentX + step.parentW, y2: dy, stroke: color, 'stroke-width': width }));
  }
}

// ---------------------------------------------------------------------------
// Cut list (right) — READOUT of the sequence built so far. Per built row:
// undo-to-here (↩), flip measured edge (⇄), REF datum toggle. No reorder.
// Trim rows are shown but not editable.
// ---------------------------------------------------------------------------

function quotedForRow(s: CutStep): number {
  if (!session) return s.distance;
  const span = stepIsVertical(s, session.ctx.sheet.sheetW, session.ctx.sheet.sheetL) ? s.parentW : s.parentH;
  if (s.isTrim) return Math.min(s.distance, span - s.distance);
  const mode = session.ctx.kerfRef;
  const allowance = mode === 'keeper' ? session.ctx.kerf : mode === 'spacing' ? session.ctx.kerf / 2 : 0;
  // Chain dimensioning: quote against the referenced cut's line.
  if (s.measureFromCut) {
    const ref = session.built.find((x) => cutKeyFor(x) === s.measureFromCut);
    if (ref) {
      const v = stepIsVertical(s, session.ctx.sheet.sheetW, session.ctx.sheet.sheetL);
      const thisLine = (v ? s.parentX : s.parentY) + s.distance;
      const rv = stepIsVertical(ref, session.ctx.sheet.sheetW, session.ctx.sheet.sheetL);
      const refLine = (rv ? ref.parentX : ref.parentY) + ref.distance;
      return Math.max(0, Math.abs(thisLine - refLine) - allowance);
    }
  }
  const base = s.fromFar ? span - s.distance : s.distance;
  return Math.max(0, base - allowance);
}

/** The reference caption for a built row: "from cut N" when chained,
 *  "from datum" when measured from a datum edge, else "from L/R/T/B edge". */
function refLabel(s: CutStep, allSteps: CutStep[]): string {
  if (!session) return '';
  if (s.measureFromCut) {
    const ref = allSteps.find((x) => cutKeyFor(x) === s.measureFromCut);
    if (ref) return `from cut ${ref.index}`;
  }
  const vertical = stepIsVertical(s, session.ctx.sheet.sheetW, session.ctx.sheet.sheetL);
  const edge = vertical ? (s.fromFar ? 'R' : 'L') : (s.fromFar ? 'B' : 'T');
  return `from ${edge} edge`;
}

function renderList(): void {
  if (!overlay || !session) return;
  const host = overlay.querySelector('[data-role="list"]') as HTMLElement;
  if (!host) return;
  const { ctx } = session;
  const steps = workingSteps();
  host.innerHTML = '';

  if (session.built.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'cut-hint';
    hint.textContent = 'You start with the bare full sheet. Click a dashed line to make a cut — blue-gray lines are the edge trims, tan lines are part edges. A popup lets you save the cut as a datum and choose what to measure from.';
    host.appendChild(hint);
  }

  steps.forEach((s, i) => {
    const isTrim = !!s.isTrim;
    const builtIdx = i; // built and steps are 1:1 now (no pre-made trims)

    const row = document.createElement('div');
    row.className = 'cut-row' + (isTrim ? ' trim' : '');
    row.setAttribute('data-idx', String(i));

    const kind = isTrim ? 'Trim' : s.axis === 'rip' ? 'Rip' : 'Crosscut';
    const parent = `${Math.round(Math.max(s.parentW, s.parentH))}×${Math.round(Math.min(s.parentW, s.parentH))}`;
    const dimText = fmtDim(quotedForRow(s), ctx.units);
    const chips: string[] = [];
    if (s.isDatum && !isTrim) chips.push('<span class="cut-chip ref">datum</span>');
    if (isTrim) chips.push('<span class="cut-chip ref">trim</span>');
    if (s.sameSetting) chips.push('<span class="cut-chip same">same</span>');

    const sub = isTrim ? `strip · piece ${parent}` : `${refLabel(s, steps)} · piece ${parent}`;

    const actions = isTrim
      ? `<button type="button" class="cut-btn" data-act="truncate" title="Undo back to here">↩</button>`
      : `
        <button type="button" class="cut-btn" data-act="truncate" title="Undo back to here">↩</button>
        <button type="button" class="cut-btn" data-act="flip" title="Flip measured-from edge">⇄</button>
        <button type="button" class="cut-btn${s.isDatum ? ' on' : ''}" data-act="datum" title="Mark reference (datum) cut">REF</button>`;

    row.innerHTML = `
      <span class="cut-num">${s.index}</span>
      <span class="cut-main">
        <span class="cut-kind">${kind} ${dimText}</span>
        <span class="cut-sub">${sub}</span>
      </span>
      <span class="cut-chips">${chips.join('')}</span>
      <span class="cut-actions">${actions}</span>`;

    row.querySelector('[data-act="truncate"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      undoToHere(builtIdx); // keep [0..builtIdx) → truncates this row + all after
    });
    if (!isTrim) {
      row.querySelector('[data-act="flip"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFlip(builtIdx);
      });
      row.querySelector('[data-act="datum"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleDatum(builtIdx);
      });
    }

    host.appendChild(row);
  });

  // Completion summary — when every part is freed, show cuts / rotations vs
  // the auto sequence + any settings changes.
  if (countFreedParts() >= ctx.sheet.parts.length && ctx.sheet.parts.length > 0) {
    const auto = deriveAuto(ctx);
    const autoM = metricsOf(auto.steps);
    const mineM = metricsOf(steps);
    const box = document.createElement('div');
    box.className = 'cut-summary';
    box.innerHTML = `
      <div class="cut-summary-title">All parts freed ✓</div>
      <div class="cut-summary-row">${steps.length} cuts (auto ${auto.steps.length})</div>
      <div class="cut-summary-row">${mineM.rotations} rip↔cross rotations (auto ${autoM.rotations})</div>
      <div class="cut-summary-row">${mineM.settingChanges} setting changes (auto ${autoM.settingChanges})</div>`;
    host.appendChild(box);
  }
}
