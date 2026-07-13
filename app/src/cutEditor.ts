/**
 * Manual cut-sequence editor — a modal popup where the user builds a sheet's
 * cut sequence by DIRECTLY CUTTING on the diagram, rather than reordering a
 * list. The user's mental model: "I click on the edge and the reference edge
 * where it's measured, and that becomes the cut."
 *
 * INTERACTION
 *   - The diagram shows the sheet mid-breakdown: the three reference trims are
 *     pre-made (blue), pieces produced so far are live, and finished (freed)
 *     pieces fade back.
 *   - Hovering a live piece shows the LEGAL full-span candidate cut lines
 *     within it (clean lines on part edges that cross the piece edge-to-edge
 *     without slicing any part — the same candidates the engine considers,
 *     enumerated via candidateLinesInRegion, a fan-out of pickLine's logic).
 *     The hovered candidate draws red-dashed.
 *   - Clicking a candidate commits it as the NEXT cut, measured from the
 *     piece's datum edge (left for vertical, top for horizontal) by default.
 *   - Clicking a piece's PARALLEL EDGE first (within a snap band) arms it as
 *     the measured-from edge; the next cut on that piece is quoted from it
 *     (fromFar when it's the far edge). The armed edge highlights green.
 *
 * RIGHT PANE = a READOUT of the sequence built so far (trims first, then the
 * hand-built layout cuts). Per row: undo-to-here (↩), flip measured edge (⇄),
 * REF datum toggle. No drag / reorder.
 *
 * ACTIONS: Undo (last cut), Reset (back to just trims), Auto-complete (fill the
 * remaining sequence with the engine's order for pieces not yet finished).
 *
 * PERSISTENCE: a hand-built sequence is stored as `customSteps` on the sheet's
 * SheetOverrides (full layout replacement, trims excluded) keyed by
 * layoutSignature. When the built sequence exactly matches lines the engine's
 * own tree contains we could express it as an `order` override, but the direct
 * cutting model lets the user pick lines the tree never enumerated — so we
 * always persist `customSteps` and let instructions.cutStepsForSheet honour it.
 * cutStepsForSheet validates nothing extra: the steps carry parent rects, so
 * the PDF diagrams (and every other renderer) work as-is.
 *
 * LEGALITY: each committed cut's parent must be a LIVE region at its turn —
 * we replay the executed prefix (trims + earlier built cuts) over regions
 * (seedRegions / applyStepToRegions, mind the far-short-edge margin clip) and
 * only offer candidates within live regions.
 */

import type { NestSheet } from './nest';
import { deriveGuillotineCuts, type Cut } from './packRect';
import {
  cutStepsForSheet,
  cutKeyFor,
  layoutSignature,
  type CutStep,
  type SheetOverrides,
  type KerfRef,
} from './instructions';
import { fmtDim, type Units } from './units';
import {
  trainingRecorder,
  sequenceMetrics,
  type SequenceMetrics,
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
// Region replay — the pieces produced so far. Layout-cut parents live in the
// USABLE frame (both margins removed), but the trims never cut the FAR short
// edge, so a region touching the raw far edge is one margin too wide until we
// shave it (the cut-editor legality gotcha, see docs/CLAUDE.md).
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

/** Region state after the trims, in the LAYOUT frame (see the gotcha above). */
function seedRegions(trims: CutStep[], sheetW: number, sheetL: number, margin: number): Region[] {
  let regions: Region[] = [{ x: 0, y: 0, w: sheetW, h: sheetL }];
  for (const s of trims) regions = applyStepToRegions(s, sheetW, sheetL, regions);
  if (margin > 0) {
    const lengthIsY = sheetL >= sheetW;
    for (const r of regions) {
      if (!lengthIsY && Math.abs(r.x + r.w - sheetW) < 0.5) r.w -= margin;
      if (lengthIsY && Math.abs(r.y + r.h - sheetL) < 0.5) r.h -= margin;
    }
  }
  return regions;
}

/** Replay trims + a built layout tail → the live pieces. */
function liveRegions(trims: CutStep[], built: CutStep[], sheetW: number, sheetL: number, margin: number): Region[] {
  let regions = seedRegions(trims, sheetW, sheetL, margin);
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
// Candidate cut lines — ALL clean full-span lines within a region (the engine
// only keeps the single best; the editor enumerates every legal one). A line
// is clean when every part lies wholly on one side of it (no straddlers).
// This mirrors the pickLine candidate-generation pattern in packRect.ts.
// ---------------------------------------------------------------------------

export interface Candidate {
  /** Vertical (constant-X) or horizontal (constant-Y) line in SHEET space. */
  vertical: boolean;
  /** Absolute cut coordinate (X for vertical, Y for horizontal). */
  coord: number;
  /** The region (piece) this candidate cuts. */
  region: Region;
}

function candidateLinesInRegion(r: Region, parts: NestSheet['parts']): Candidate[] {
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
  // are geometric noise from the margin/kerf, never a cut a human would make.
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

/** Build the CutStep for a committed candidate. `armedFar` flips the quoted
 *  edge to the far parallel edge (fromFar). */
function candidateToStep(c: Candidate, sheetW: number, sheetL: number, armedFar: boolean): CutStep {
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
    fromFar: armedFar || undefined,
  };
}

// ---------------------------------------------------------------------------
// Auto-complete — fill the remaining sequence with the engine's order for the
// pieces the user hasn't finished. Rather than replay the fixed auto layout
// (whose parent rects no longer match once the user cuts lines the auto tree
// never used), we re-run the ENGINE'S OWN decomposition (deriveGuillotineCuts,
// the human-style min-cuts search) on each LIVE, unfinished piece: translate
// the piece + its parts to a local origin, derive a fresh cut tree, then shift
// the resulting cuts back into the sheet frame. This gives the engine's order
// for exactly the pieces the user hasn't finished, whatever the user cut first.
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

function autoRemainder(
  trims: CutStep[],
  built: CutStep[],
  parts: NestSheet['parts'],
  sheetW: number,
  sheetL: number,
  margin: number,
): CutStep[] {
  const regions = liveRegions(trims, built, sheetW, sheetL, margin);
  const add: CutStep[] = [];
  for (const r of regions) {
    if (regionFinished(r, parts)) continue;
    // Parts inside this piece, translated to the piece's local origin.
    const idx = partsInRegion(r, parts);
    if (idx.length < 1) continue;
    const localRects = idx.map((i) => ({
      x: parts[i].x - r.x, y: parts[i].y - r.y, w: parts[i].w, h: parts[i].h,
    }));
    const cuts = deriveGuillotineCuts(localRects, r.w, r.h);
    for (const c of cuts) add.push(cutToStep(c, r.x, r.y, sheetW, sheetL));
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
  strategy: string;
  jobName: string;
  /** Called after any change so the caller can re-render / persist externally
   *  if it wants (overrides are already saved to localStorage by the editor). */
  onChange?: () => void;
}

interface EditorSession {
  ctx: CutEditorContext;
  sig: string;
  /** Fixed reference trims (engine order). */
  trims: CutStep[];
  /** The hand-built layout cuts, in commit order. */
  built: CutStep[];
  /** Armed measured-from edge for the NEXT cut: the region + which parallel
   *  edge (near/far) + orientation. null = default datum edge. */
  armed: { region: Region; vertical: boolean; far: boolean } | null;
  changed: boolean;
}

let overlay: HTMLElement | null = null;
let session: EditorSession | null = null;
/** Currently hovered candidate (drawn red-dashed) — transient, not persisted. */
let hovered: Candidate | null = null;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Trims + auto layout for the current sheet (engine order, no overrides). */
function deriveAuto(ctx: CutEditorContext): { trims: CutStep[]; layout: CutStep[]; steps: CutStep[] } {
  const sc = cutStepsForSheet(ctx.sheet, ctx.sheet.globalIndex || 1, 1, ctx.margin, ctx.kerf, undefined, ctx.kerfRef);
  const trims = sc.steps.filter((s) => s.isTrim);
  const layout = sc.steps.filter((s) => !s.isTrim);
  return { trims, layout, steps: sc.steps };
}

/** The full working step list = trims + built, renumbered + same-setting run
 *  flags applied (matches how cutStepsForSheet finishes a sequence). */
function workingSteps(): CutStep[] {
  if (!session) return [];
  const all = [...session.trims.map((s) => ({ ...s })), ...session.built.map((s) => ({ ...s }))];
  all.forEach((s, i) => { s.index = i + 1; if (s.isTrim) s.isDatum = true; });
  for (let i = 1; i < all.length; i++) {
    const p = all[i - 1], c = all[i];
    c.sameSetting = c.axis === p.axis && Math.abs(c.distance - p.distance) < 0.5;
  }
  return all;
}

/** Persist the built sequence as customSteps (null when nothing is built). */
function persistSession(): void {
  if (!session) return;
  if (session.built.length === 0) { setOverrides(session.sig, null); return; }
  const customSteps = session.built.map((s) => ({ ...s }));
  setOverrides(session.sig, { customSteps });
}

function metricsOf(steps: CutStep[]): SequenceMetrics {
  return sequenceMetrics(steps);
}

/** Reconstruct the built tail from a saved customSteps override (if any). */
function builtFromOverrides(ov: SheetOverrides | undefined): CutStep[] {
  if (ov?.customSteps && ov.customSteps.length > 0) return ov.customSteps.map((s) => ({ ...s }));
  return [];
}

/** Public entry point — open the editor for a sheet. */
export function openCutEditor(ctx: CutEditorContext): void {
  const sig = layoutSignature(ctx.sheet);
  const ov = getOverrides(sig);
  const auto = deriveAuto(ctx);
  session = {
    ctx, sig,
    trims: auto.trims,
    built: builtFromOverrides(ov),
    armed: null,
    changed: false,
  };
  hovered = null;

  buildOverlay();

  // Training: session_start (only recorded while the recorder is on).
  trainingRecorder.append({
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
  });

  render();
}

function closeEditor(): void {
  if (!session) return;
  const s = session;
  let note = '';
  if (s.changed) {
    note = window.prompt('Optional: why this cut order? (one line)') ?? '';
  }
  const steps = workingSteps();
  trainingRecorder.append({
    type: 'session_end',
    t: Date.now(),
    finalSequence: steps,
    finalMetrics: metricsOf(steps),
    note,
  });
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
  const { trims, built, ctx } = session;
  const regions = liveRegions(trims, built, ctx.sheet.sheetW, ctx.sheet.sheetL, ctx.margin);
  let finished = 0;
  for (const r of regions) if (regionFinished(r, ctx.sheet.parts)) finished++;
  return { pieces: regions.length, finished };
}

function commitCandidate(c: Candidate): void {
  if (!session) return;
  const { ctx } = session;
  const armedFar = !!(session.armed && sameRegion(session.armed.region, c.region) && session.armed.far);
  const step = candidateToStep(c, ctx.sheet.sheetW, ctx.sheet.sheetL, armedFar);
  session.built.push(step);
  session.armed = null;
  session.changed = true;
  hovered = null;
  persistSession();

  trainingRecorder.append({
    type: 'manual_cut',
    t: Date.now(),
    cut: cutKeyFor(step),
    summary: humanSummary(step, ctx),
    value: armedFar,
    armedFar,
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

/** Arm (or disarm) a piece's parallel edge as the measured-from reference. */
function armEdge(region: Region, vertical: boolean, far: boolean): void {
  if (!session) return;
  const a = session.armed;
  if (a && sameRegion(a.region, region) && a.vertical === vertical && a.far === far) {
    session.armed = null; // toggle off
  } else {
    session.armed = { region, vertical, far };
  }
  render();
}

function undoLast(): void {
  if (!session || session.built.length === 0) return;
  const removed = session.built.pop()!;
  session.armed = null;
  session.changed = true;
  hovered = null;
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

/** Truncate the built tail back to `keepLayoutCount` cuts (undo-to-here). */
function undoToHere(keepLayoutCount: number): void {
  if (!session) return;
  if (keepLayoutCount >= session.built.length) return;
  session.built = session.built.slice(0, keepLayoutCount);
  session.armed = null;
  session.changed = true;
  hovered = null;
  persistSession();
  trainingRecorder.append({
    type: 'undo',
    t: Date.now(),
    cut: `truncate:${keepLayoutCount}`,
    summary: `Undo to ${keepLayoutCount} built cut(s)`,
    piece: pieceState(),
    sequenceAfter: session.built.map((s) => cutKeyFor(s)),
    metricsAfter: metricsOf(workingSteps()),
  });
  session.ctx.onChange?.();
  render();
}

function resetToTrims(): void {
  if (!session) return;
  session.built = [];
  session.armed = null;
  session.changed = true;
  hovered = null;
  setOverrides(session.sig, null);
  session.ctx.onChange?.();
  render();
}

function autoComplete(): void {
  if (!session) return;
  const { ctx } = session;
  const remainder = autoRemainder(
    session.trims, session.built, ctx.sheet.parts,
    ctx.sheet.sheetW, ctx.sheet.sheetL, ctx.margin,
  );
  if (remainder.length === 0) { render(); return; }
  session.built.push(...remainder);
  session.armed = null;
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

/** Flip the measured-from edge (fromFar) of a built layout cut by index. */
function toggleFlip(builtIdx: number): void {
  if (!session) return;
  const s = session.built[builtIdx];
  if (!s) return;
  s.fromFar = !s.fromFar;
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

/** Toggle the datum (REF) flag of a built layout cut by index. */
function toggleDatum(builtIdx: number): void {
  if (!session) return;
  const s = session.built[builtIdx];
  if (!s) return;
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
          <button type="button" class="ghost cut-editor-record" data-role="record">⏺ Record</button>
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
  overlay.querySelector('[data-role="reset"]')?.addEventListener('click', resetToTrims);
  overlay.querySelector('[data-role="undo"]')?.addEventListener('click', undoLast);
  overlay.querySelector('[data-role="auto"]')?.addEventListener('click', autoComplete);
  overlay.querySelector('[data-role="record"]')?.addEventListener('click', () => {
    const on = trainingRecorder.setRecording(!trainingRecorder.recording);
    if (on && session) {
      const auto = deriveAuto(session.ctx);
      trainingRecorder.append({
        type: 'session_start', t: Date.now(),
        sheet: {
          w: session.ctx.sheet.sheetW, l: session.ctx.sheet.sheetL,
          margin: session.ctx.margin, kerf: session.ctx.kerf,
          strategy: session.ctx.strategy, thickness: session.ctx.sheet.thickness,
        },
        parts: session.ctx.sheet.parts.map((p) => ({
          code: `${session!.ctx.sheet.globalIndex || ''}${p.panelLabel}`,
          x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.w), h: Math.round(p.h),
        })),
        autoSequence: auto.steps, autoMetrics: sequenceMetrics(auto.steps),
        signature: session.sig, jobName: session.ctx.jobName,
      });
    }
    render();
  });
  overlay.querySelector('[data-role="download"]')?.addEventListener('click', () => {
    if (session) trainingRecorder.download(session.ctx.jobName);
  });

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { closeEditor(); document.removeEventListener('keydown', onKey); }
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
  const recBtn = overlay.querySelector('[data-role="record"]') as HTMLButtonElement | null;
  if (recBtn) {
    recBtn.classList.toggle('recording', trainingRecorder.recording);
    recBtn.textContent = trainingRecorder.recording
      ? `⏺ Recording (${trainingRecorder.count})`
      : '⏺ Record';
  }
  const undoBtn = overlay.querySelector('[data-role="undo"]') as HTMLButtonElement | null;
  if (undoBtn) undoBtn.disabled = session.built.length === 0;
  const autoBtn = overlay.querySelector('[data-role="auto"]') as HTMLButtonElement | null;
  if (autoBtn) autoBtn.disabled = countFreedParts() >= session.ctx.sheet.parts.length;

  renderDiagram();
  renderList();
}

/** How many parts are alone in a live region (fully freed). */
function countFreedParts(): number {
  if (!session) return 0;
  const { trims, built, ctx } = session;
  const regions = liveRegions(trims, built, ctx.sheet.sheetW, ctx.sheet.sheetL, ctx.margin);
  let freed = 0;
  for (const r of regions) {
    const idx = partsInRegion(r, ctx.sheet.parts);
    if (idx.length === 1) freed++;
  }
  return freed;
}

// ---------------------------------------------------------------------------
// Diagram (left) — SVG matching the PDF cut-diagram colors, plus interactive
// candidate lines + arm-able parallel edges.
// ---------------------------------------------------------------------------

function el(name: string, attrs: Record<string, string | number>): SVGElement {
  const e = document.createElementNS(SVG_NS, name);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  return e;
}

const SNAP_BAND = 14; // mm — click within this of a parallel edge arms it

function renderDiagram(): void {
  if (!overlay || !session) return;
  const host = overlay.querySelector('[data-role="diagram"]') as HTMLElement;
  if (!host) return;
  const { sheet } = session.ctx;
  const W = sheet.sheetW, L = sheet.sheetL;
  const trims = session.trims;
  const built = session.built;
  const regions = liveRegions(trims, built, W, L, session.ctx.margin);

  const pad = 12;
  const svg = el('svg', {
    viewBox: `${-pad} ${-pad} ${W + pad * 2} ${L + pad * 2}`,
    preserveAspectRatio: 'xMidYMid meet',
    class: 'cut-editor-svg',
  }) as SVGSVGElement;

  // Cream sheet.
  svg.appendChild(el('rect', { x: 0, y: 0, width: W, height: L, fill: '#F5EFD9', stroke: '#B4A270', 'stroke-width': 1 }));

  // Parts at 50% opacity + labels.
  for (const p of sheet.parts) {
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

  // Fade FINISHED pieces (freed part / bare waste) back so the live pieces
  // stand out as the ones still to break down.
  for (const r of regions) {
    if (regionFinished(r, sheet.parts)) {
      svg.appendChild(el('rect', { x: r.x, y: r.y, width: r.w, height: r.h, fill: '#FFFFFF', 'fill-opacity': 0.6 }));
    }
  }

  // Committed layout cuts: solid white lines (prior cuts), datum ones blue.
  for (const s of built) {
    if (s.isDatum) continue;
    appendCutLine(svg, s, W, L, '#FFFFFF', 2.4);
  }

  // Reference edges — trims + user datum cuts — BLUE, above the fade.
  for (const s of trims) appendCutLine(svg, s, W, L, '#2B6CB0', 3);
  for (const s of built) { if (s.isDatum) appendCutLine(svg, s, W, L, '#2B6CB0', 3); }

  // Armed measured-from edge — GREEN.
  if (session.armed) {
    const a = session.armed;
    if (a.vertical) {
      const gx = a.far ? a.region.x + a.region.w : a.region.x;
      svg.appendChild(el('line', { x1: gx, y1: a.region.y, x2: gx, y2: a.region.y + a.region.h, stroke: '#2F855A', 'stroke-width': 5 }));
    } else {
      const gy = a.far ? a.region.y + a.region.h : a.region.y;
      svg.appendChild(el('line', { x1: a.region.x, y1: gy, x2: a.region.x + a.region.w, y2: gy, stroke: '#2F855A', 'stroke-width': 5 }));
    }
  }

  // Candidate lines for every LIVE (unfinished) region — faint gray, each an
  // interactive hit target. The hovered one draws red-dashed with a live quote.
  const liveCandidates: Candidate[] = [];
  for (const r of regions) {
    if (regionFinished(r, sheet.parts)) continue;
    for (const c of candidateLinesInRegion(r, sheet.parts)) liveCandidates.push(c);
  }
  for (const c of liveCandidates) {
    const isHover = hovered != null && candEq(hovered, c);
    const color = isHover ? '#E03E3E' : '#9A8F73';
    const wid = isHover ? 4 : 1.4;
    const line = el('line', {
      ...candLineCoords(c, W, L),
      stroke: color, 'stroke-width': wid,
      'stroke-dasharray': isHover ? '10 7' : '4 6',
      class: 'cut-candidate',
      'data-cand': candKey(c),
    });
    (line as SVGElement).style.cursor = 'pointer';
    line.addEventListener('mouseenter', () => { hovered = c; renderDiagram(); });
    line.addEventListener('mouseleave', () => { if (hovered && candEq(hovered, c)) { hovered = null; renderDiagram(); } });
    line.addEventListener('click', (e) => { e.stopPropagation(); commitCandidate(c); });
    // Fat transparent hit line under the visible one for easier clicking.
    const hit = el('line', {
      ...candLineCoords(c, W, L),
      stroke: 'transparent', 'stroke-width': 22,
      class: 'cut-candidate-hit', 'data-cand': candKey(c),
    });
    (hit as SVGElement).style.cursor = 'pointer';
    hit.addEventListener('mouseenter', () => { hovered = c; renderDiagram(); });
    hit.addEventListener('click', (e) => { e.stopPropagation(); commitCandidate(c); });
    svg.appendChild(hit);
    svg.appendChild(line);
  }

  // The hovered candidate's live quote (respecting kerfRef + armed edge).
  if (hovered) {
    const q = quoteForCandidate(hovered);
    const { x1, y1, x2, y2 } = candLineCoords(hovered, W, L) as any;
    const mx = (Number(x1) + Number(x2)) / 2, my = (Number(y1) + Number(y2)) / 2;
    const t = el('text', {
      x: mx + 8, y: my - 8,
      'font-size': Math.max(16, Math.min(34, Math.max(W, L) * 0.02)),
      fill: '#E03E3E', 'font-weight': 700, 'paint-order': 'stroke',
      stroke: '#fff', 'stroke-width': 3,
    });
    t.textContent = fmtDim(q, session.ctx.units);
    svg.appendChild(t);
  }

  // Arm-able parallel edges: clicking near a live piece's edge (within the
  // snap band) arms it as the measured-from reference. We add invisible band
  // rects along each piece's four inner edges; a click that isn't on a
  // candidate line lands here.
  for (const r of regions) {
    if (regionFinished(r, sheet.parts)) continue;
    addEdgeBand(svg, r, true, false);  // left
    addEdgeBand(svg, r, true, true);   // right
    addEdgeBand(svg, r, false, false); // top
    addEdgeBand(svg, r, false, true);  // bottom
  }

  host.innerHTML = '';
  host.appendChild(svg);
}

/** An invisible clickable band along one edge of a live piece → arms it. */
function addEdgeBand(svg: SVGSVGElement, r: Region, vertical: boolean, far: boolean): void {
  const band = SNAP_BAND;
  let rect: Record<string, number>;
  if (vertical) {
    const x = far ? r.x + r.w - band / 2 : r.x - band / 2;
    rect = { x, y: r.y, width: band, height: r.h };
  } else {
    const y = far ? r.y + r.h - band / 2 : r.y - band / 2;
    rect = { x: r.x, y, width: r.w, height: band };
  }
  const el2 = el('rect', { ...rect, fill: 'transparent', class: 'cut-edge-band' });
  (el2 as SVGElement).style.cursor = 'crosshair';
  el2.addEventListener('click', (e) => { e.stopPropagation(); armEdge(r, vertical, far); });
  svg.appendChild(el2);
}

function candLineCoords(c: Candidate, _W: number, _L: number): { x1: number; y1: number; x2: number; y2: number } {
  if (c.vertical) {
    return { x1: c.coord, y1: c.region.y, x2: c.coord, y2: c.region.y + c.region.h };
  }
  return { x1: c.region.x, y1: c.coord, x2: c.region.x + c.region.w, y2: c.coord };
}

function candKey(c: Candidate): string {
  return `${c.vertical ? 'V' : 'H'}|${Math.round(c.coord)}|${Math.round(c.region.x)},${Math.round(c.region.y)},${Math.round(c.region.w)},${Math.round(c.region.h)}`;
}
function candEq(a: Candidate, b: Candidate): boolean { return candKey(a) === candKey(b); }

/** Quote a hovered candidate the way the PDF would (kerfRef + armed edge). */
function quoteForCandidate(c: Candidate): number {
  if (!session) return 0;
  const armedFar = !!(session.armed && sameRegion(session.armed.region, c.region) && session.armed.far);
  const span = c.vertical ? c.region.w : c.region.h;
  const distance = c.vertical ? c.coord - c.region.x : c.coord - c.region.y;
  const mode = session.ctx.kerfRef;
  const allowance = mode === 'keeper' ? session.ctx.kerf : mode === 'spacing' ? session.ctx.kerf / 2 : 0;
  const base = armedFar ? span - distance : distance;
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
// ---------------------------------------------------------------------------

function quotedForRow(s: CutStep): number {
  if (!session) return s.distance;
  const span = stepIsVertical(s, session.ctx.sheet.sheetW, session.ctx.sheet.sheetL) ? s.parentW : s.parentH;
  if (s.isTrim) return Math.min(s.distance, span - s.distance);
  const mode = session.ctx.kerfRef;
  const allowance = mode === 'keeper' ? session.ctx.kerf : mode === 'spacing' ? session.ctx.kerf / 2 : 0;
  const base = s.fromFar ? span - s.distance : s.distance;
  return Math.max(0, base - allowance);
}

function edgeLabel(s: CutStep): string {
  if (!session) return '';
  const vertical = stepIsVertical(s, session.ctx.sheet.sheetW, session.ctx.sheet.sheetL);
  return vertical
    ? (s.fromFar ? 'R' : 'L')
    : (s.fromFar ? 'B' : 'T');
}

function renderList(): void {
  if (!overlay || !session) return;
  const host = overlay.querySelector('[data-role="list"]') as HTMLElement;
  if (!host) return;
  const { ctx } = session;
  const steps = workingSteps();
  const trimCount = session.trims.length;
  host.innerHTML = '';

  if (session.built.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'cut-hint';
    hint.textContent = 'Click a dashed line on the diagram to make the next cut. Click a piece edge first to measure the cut from that edge.';
    host.appendChild(hint);
  }

  steps.forEach((s, i) => {
    const isTrim = !!s.isTrim;
    const builtIdx = isTrim ? -1 : i - trimCount;

    const row = document.createElement('div');
    row.className = 'cut-row' + (isTrim ? ' trim' : '');
    row.setAttribute('data-idx', String(i));

    const kind = isTrim ? 'Trim' : s.axis === 'rip' ? 'Rip' : 'Crosscut';
    const parent = `${Math.round(Math.max(s.parentW, s.parentH))}×${Math.round(Math.min(s.parentW, s.parentH))}`;
    const dimText = fmtDim(quotedForRow(s), ctx.units);
    const chips: string[] = [];
    if (s.isDatum && !isTrim) chips.push('<span class="cut-chip ref">REF</span>');
    if (isTrim) chips.push('<span class="cut-chip ref">datum</span>');
    if (s.sameSetting) chips.push('<span class="cut-chip same">same</span>');

    const actions = isTrim ? '' : `
        <button type="button" class="cut-btn" data-act="truncate" title="Undo back to here">↩</button>
        <button type="button" class="cut-btn" data-act="flip" title="Flip measured-from edge">⇄</button>
        <button type="button" class="cut-btn${s.isDatum ? ' on' : ''}" data-act="datum" title="Mark reference (datum) cut">REF</button>`;

    row.innerHTML = `
      <span class="cut-num">${s.index}</span>
      <span class="cut-main">
        <span class="cut-kind">${kind} ${dimText}</span>
        <span class="cut-sub">from ${edgeLabel(s)} edge · piece ${parent}</span>
      </span>
      <span class="cut-chips">${chips.join('')}</span>
      <span class="cut-actions">${actions}</span>`;

    if (!isTrim) {
      row.querySelector('[data-act="truncate"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        undoToHere(builtIdx); // keep [0..builtIdx) → truncates this row + all after
      });
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
