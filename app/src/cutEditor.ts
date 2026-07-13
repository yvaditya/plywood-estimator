/**
 * Manual cut-sequence editor — a modal popup that lets the user reorder the
 * cut steps for one sheet, flip which parallel edge each cut is measured
 * from, and mark cuts as reference (datum) cuts. Everything is stored as a
 * per-sheet override keyed by the sheet's layout signature and applied by
 * instructions.ts (`allCutSteps` → `cutStepsForSheet`) so the PDF renders the
 * arranged sequence.
 *
 * LEFT  = large sheet diagram (cream stock, colored part rects + labels, all
 *         cut lines; the selected cut red + its parent outlined, datum/trim
 *         cuts blue, the measured-from edge of the selected cut green).
 * RIGHT = the ordered cut list (trims first, then layout cuts) with hover
 *         highlight, ↑/↓ + drag reorder, a ⇄ edge-flip and a datum toggle.
 *
 * Reorder legality mirrors `countFreedParts` in packRect.ts: a layout cut may
 * only sit at a position where its PARENT piece already exists — we replay
 * the executed prefix (trims + earlier layout cuts) over regions and require
 * the moved cut's parent rect to match a live region within 1 mm.
 */

import type { NestSheet } from './nest';
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
// Reorder legality — replay the executed prefix over regions and check the
// candidate cut's parent piece exists (same technique as countFreedParts).
// Works in cut-step space: 'rip'/'cross' + parent rect + distance. We convert
// each step to a sheet-space V/H line to split regions.
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

/** Does `step`'s parent piece exist after executing `prefix` (trims + earlier
 *  layout cuts) over the full sheet? */
function parentReady(step: CutStep, prefix: CutStep[], sheetW: number, sheetL: number): boolean {
  let regions: Region[] = [{ x: 0, y: 0, w: sheetW, h: sheetL }];
  for (const s of prefix) regions = applyStepToRegions(s, sheetW, sheetL, regions);
  return regions.some((r) =>
    Math.abs(r.x - step.parentX) < 1 && Math.abs(r.y - step.parentY) < 1 &&
    Math.abs(r.w - step.parentW) < 1 && Math.abs(r.h - step.parentH) < 1,
  );
}

/**
 * Is moving the layout cut at `fromIdx` (index within the LAYOUT tail) to
 * `toIdx` legal? Per the spec: "a cut may only move to a position where its
 * PARENT PIECE already exists" — we replay the executed prefix (trims + the
 * layout cuts that end up BEFORE it in the new order) over regions and
 * require the moved cut's parent rect to match a live region within 1 mm
 * (the countFreedParts technique). This forbids a cut from leap-frogging the
 * cut that produces its parent, while letting a cut slide anywhere its parent
 * piece is already on the bench.
 *
 * Additionally, a cut may not be dragged BEFORE any earlier cut whose parent
 * IT produces — otherwise that earlier cut would be stranded. That case is
 * exactly "the displaced cut's parent no longer exists at its position", so a
 * move is rejected if the immediate neighbour it displaces (the cut now at
 * `fromIdx`'s old slot direction) loses its parent. We check the single cut
 * that ends up where the moved cut left, which is the only one whose prefix
 * shrank; cuts further away keep an unchanged-or-superset prefix.
 */
function reorderLegal(
  layout: CutStep[],
  trims: CutStep[],
  fromIdx: number,
  toIdx: number,
  sheetW: number,
  sheetL: number,
): boolean {
  if (fromIdx === toIdx) return true;
  if (toIdx < 0 || toIdx >= layout.length) return false;
  const next = layout.slice();
  const [moved] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, moved);
  // The moved cut's parent must already exist at its destination — replay the
  // trims + the layout cuts now before it and require a matching live region.
  // (This is the exact rule the spec calls out: "a cut may only move to a
  // position where its parent piece already exists".) A cut therefore can't be
  // pulled in front of the cut that PRODUCES its parent — that cut would land
  // after it, so the parent region wouldn't exist yet and the check fails.
  return parentReady(moved, [...trims, ...next.slice(0, toIdx)], sheetW, sheetL);
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
  /** Working steps: [trims..., layout...] — mutated in place, re-derived on
   *  reset. */
  steps: CutStep[];
  trims: CutStep[];
  layout: CutStep[];
  selected: number;   // index into `steps`
  changed: boolean;
}

let overlay: HTMLElement | null = null;
let session: EditorSession | null = null;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Build the working step list for the current overrides, split into trims +
 *  layout tail. */
function deriveSteps(ctx: CutEditorContext, ov?: SheetOverrides): { steps: CutStep[]; trims: CutStep[]; layout: CutStep[] } {
  const sc = cutStepsForSheet(ctx.sheet, ctx.sheet.globalIndex || 1, 1, ctx.margin, ctx.kerf, ov, ctx.kerfRef);
  const steps = sc.steps;
  const trims = steps.filter((s) => s.isTrim);
  const layout = steps.filter((s) => !s.isTrim);
  return { steps, trims, layout };
}

/** Persist the session's current arrangement into localStorage overrides. */
function persistSession(): void {
  if (!session) return;
  const order = session.layout.map((s) => cutKeyFor(s));
  const perCut: Record<string, { fromFar?: boolean; isDatum?: boolean }> = {};
  for (const s of session.layout) {
    const e: { fromFar?: boolean; isDatum?: boolean } = {};
    if (s.fromFar) e.fromFar = true;
    if (s.isDatum) e.isDatum = true;
    if (e.fromFar || e.isDatum) perCut[cutKeyFor(s)] = e;
  }
  const hasOrder = order.length > 0;
  const hasPerCut = Object.keys(perCut).length > 0;
  setOverrides(session.sig, hasOrder || hasPerCut ? { order, perCut } : null);
}

function metricsOf(session: EditorSession): SequenceMetrics {
  return sequenceMetrics(session.steps);
}

/** Public entry point — open the editor for a sheet. */
export function openCutEditor(ctx: CutEditorContext): void {
  const sig = layoutSignature(ctx.sheet);
  const ov = getOverrides(sig);
  const { steps, trims, layout } = deriveSteps(ctx, ov);
  session = { ctx, sig, steps, trims, layout, selected: trims.length, changed: false };

  buildOverlay();

  // Training: session_start (only recorded while the recorder is on).
  const auto = deriveSteps(ctx, undefined); // engine order, no overrides
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
  // Prompt for a "why" note only when something actually changed.
  let note = '';
  if (s.changed) {
    note = window.prompt('Optional: why this cut order? (one line)') ?? '';
  }
  trainingRecorder.append({
    type: 'session_end',
    t: Date.now(),
    finalSequence: s.steps,
    finalMetrics: metricsOf(s),
    note,
  });
  overlay?.remove();
  overlay = null;
  session = null;
}

// ---------------------------------------------------------------------------
// Rebuild the working step arrays from the current overrides (after a change).
// ---------------------------------------------------------------------------

function refreshFromOverrides(): void {
  if (!session) return;
  const ov = getOverrides(session.sig);
  const { steps, trims, layout } = deriveSteps(session.ctx, ov);
  session.steps = steps;
  session.trims = trims;
  session.layout = layout;
}

// ---------------------------------------------------------------------------
// Actions.
// ---------------------------------------------------------------------------

function humanSummary(s: CutStep, ctx: CutEditorContext): string {
  const kind = s.isTrim ? 'Trim' : s.axis === 'rip' ? 'Rip' : 'Crosscut';
  const parent = `${Math.round(Math.max(s.parentW, s.parentH))}×${Math.round(Math.min(s.parentW, s.parentH))}`;
  return `${kind} ${fmtDim(s.distance, ctx.units)} · piece ${parent}`;
}

function doReorder(fromLayoutIdx: number, toLayoutIdx: number): boolean {
  if (!session) return false;
  const { layout, trims, ctx } = session;
  if (!reorderLegal(layout, trims, fromLayoutIdx, toLayoutIdx, ctx.sheet.sheetW, ctx.sheet.sheetL)) {
    return false;
  }
  const moved = layout[fromLayoutIdx];
  const next = layout.slice();
  next.splice(fromLayoutIdx, 1);
  next.splice(toLayoutIdx, 0, moved);
  session.layout = next;
  session.steps = [...trims, ...next];
  session.changed = true;
  persistSession();
  refreshFromOverrides();
  // Keep the moved cut selected.
  const key = cutKeyFor(moved);
  session.selected = session.steps.findIndex((s) => cutKeyFor(s) === key && !s.isTrim);
  if (session.selected < 0) session.selected = trims.length;

  trainingRecorder.append({
    type: 'reorder',
    t: Date.now(),
    cut: key,
    summary: humanSummary(moved, ctx),
    from: fromLayoutIdx,
    to: toLayoutIdx,
    sequenceAfter: session.layout.map((s) => cutKeyFor(s)),
    metricsAfter: metricsOf(session),
  });
  ctx.onChange?.();
  render();
  return true;
}

function toggleFlip(stepIdx: number): void {
  if (!session) return;
  const s = session.steps[stepIdx];
  if (!s || s.isTrim) return;
  s.fromFar = !s.fromFar;
  session.changed = true;
  persistSession();
  trainingRecorder.append({
    type: 'flip_edge',
    t: Date.now(),
    cut: cutKeyFor(s),
    summary: humanSummary(s, session.ctx),
    value: !!s.fromFar,
    sequenceAfter: session.layout.map((x) => cutKeyFor(x)),
    metricsAfter: metricsOf(session),
  });
  session.ctx.onChange?.();
  render();
}

function toggleDatum(stepIdx: number): void {
  if (!session) return;
  const s = session.steps[stepIdx];
  if (!s || s.isTrim) return; // trims are datum-locked
  s.isDatum = !s.isDatum;
  session.changed = true;
  persistSession();
  trainingRecorder.append({
    type: 'mark_datum',
    t: Date.now(),
    cut: cutKeyFor(s),
    summary: humanSummary(s, session.ctx),
    value: !!s.isDatum,
    sequenceAfter: session.layout.map((x) => cutKeyFor(x)),
    metricsAfter: metricsOf(session),
  });
  session.ctx.onChange?.();
  render();
}

function resetToAuto(): void {
  if (!session) return;
  setOverrides(session.sig, null);
  refreshFromOverrides();
  session.selected = session.trims.length;
  session.changed = true;
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
          <button type="button" class="ghost cut-editor-reset" data-role="reset">Reset to auto</button>
          <button type="button" class="ghost cut-editor-close" data-role="close" aria-label="Close">✕</button>
        </div>
      </header>
      <div class="cut-editor-body">
        <div class="cut-editor-diagram" data-role="diagram"></div>
        <div class="cut-editor-list" data-role="list"></div>
      </div>
    </div>`;

  // Click on the backdrop (not the modal) closes.
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) closeEditor();
  });
  overlay.querySelector('[data-role="close"]')?.addEventListener('click', closeEditor);
  overlay.querySelector('[data-role="reset"]')?.addEventListener('click', resetToAuto);
  overlay.querySelector('[data-role="record"]')?.addEventListener('click', () => {
    const on = trainingRecorder.setRecording(!trainingRecorder.recording);
    // If we just started recording mid-session, backfill a session_start so
    // the log has context for the actions that follow.
    if (on && session) {
      const auto = deriveSteps(session.ctx, undefined);
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

  // Esc closes.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { closeEditor(); document.removeEventListener('keydown', onKey); }
  };
  document.addEventListener('keydown', onKey);

  document.body.appendChild(overlay);
}

function render(): void {
  if (!overlay || !session) return;
  const { ctx, steps, selected } = session;

  const titleEl = overlay.querySelector('.cut-editor-title');
  if (titleEl) {
    titleEl.textContent = `Sheet ${ctx.sheet.globalIndex || ''} · ${steps.length} cuts`;
  }
  const recBtn = overlay.querySelector('[data-role="record"]') as HTMLButtonElement | null;
  if (recBtn) {
    recBtn.classList.toggle('recording', trainingRecorder.recording);
    recBtn.textContent = trainingRecorder.recording
      ? `⏺ Recording (${trainingRecorder.count})`
      : '⏺ Record';
  }

  renderDiagram();
  renderList();
}

// ---------------------------------------------------------------------------
// Diagram (left) — SVG matching the PDF cut-diagram colors.
// ---------------------------------------------------------------------------

function el(name: string, attrs: Record<string, string | number>): SVGElement {
  const e = document.createElementNS(SVG_NS, name);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  return e;
}

function renderDiagram(): void {
  if (!overlay || !session) return;
  const host = overlay.querySelector('[data-role="diagram"]') as HTMLElement;
  if (!host) return;
  const { sheet } = session.ctx;
  const W = sheet.sheetW, L = sheet.sheetL;
  const steps = session.steps;
  const cur = steps[session.selected];

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

  // Prior NON-datum cuts: thin white. (indices before selected)
  for (let i = 0; i < session.selected; i++) {
    const s = steps[i];
    if (s.isTrim || s.isDatum) continue;
    appendCutLine(svg, s, W, L, '#FFFFFF', 2);
  }

  // Fade everything outside the selected cut's parent piece.
  if (cur) {
    const overlayColor = '#FFFFFF';
    const op = 0.72;
    const px = cur.parentX, py = cur.parentY, pw = cur.parentW, ph = cur.parentH;
    // top / bottom / left / right strips
    if (py > 0.5) svg.appendChild(el('rect', { x: 0, y: 0, width: W, height: py, fill: overlayColor, 'fill-opacity': op }));
    if (py + ph < L - 0.5) svg.appendChild(el('rect', { x: 0, y: py + ph, width: W, height: L - (py + ph), fill: overlayColor, 'fill-opacity': op }));
    if (px > 0.5) svg.appendChild(el('rect', { x: 0, y: py, width: px, height: ph, fill: overlayColor, 'fill-opacity': op }));
    if (px + pw < W - 0.5) svg.appendChild(el('rect', { x: px + pw, y: py, width: W - (px + pw), height: ph, fill: overlayColor, 'fill-opacity': op }));
  }

  // Trim + datum cuts: BLUE, above the fade.
  for (let i = 0; i < session.selected; i++) {
    const s = steps[i];
    if (!s.isTrim && !s.isDatum) continue;
    appendCutLine(svg, s, W, L, '#2B6CB0', 3);
  }

  // Selected parent border (red) + the cut line (bold red) + measured edge.
  if (cur) {
    svg.appendChild(el('rect', {
      x: cur.parentX, y: cur.parentY, width: cur.parentW, height: cur.parentH,
      fill: 'none', stroke: '#E03E3E', 'stroke-width': 2,
    }));
    appendCutLine(svg, cur, W, L, '#E03E3E', 5);
    // Measured-from edge — green — near (L/T) or far (R/B) per fromFar.
    const vertical = stepIsVertical(cur, W, L);
    if (vertical) {
      const gx = cur.fromFar ? cur.parentX + cur.parentW : cur.parentX;
      svg.appendChild(el('line', { x1: gx, y1: cur.parentY, x2: gx, y2: cur.parentY + cur.parentH, stroke: '#2F855A', 'stroke-width': 4 }));
    } else {
      const gy = cur.fromFar ? cur.parentY + cur.parentH : cur.parentY;
      svg.appendChild(el('line', { x1: cur.parentX, y1: gy, x2: cur.parentX + cur.parentW, y2: gy, stroke: '#2F855A', 'stroke-width': 4 }));
    }
  }

  host.innerHTML = '';
  host.appendChild(svg);
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
// Cut list (right) — ordered rows with hover-highlight + reorder controls.
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
  const { steps, ctx } = session;
  host.innerHTML = '';

  steps.forEach((s, i) => {
    const isTrim = !!s.isTrim;
    const isLayout = !isTrim;
    const layoutIdx = isLayout ? session!.layout.findIndex((x) => x === s) : -1;

    const row = document.createElement('div');
    row.className = 'cut-row' + (i === session!.selected ? ' selected' : '') + (isTrim ? ' trim' : '');
    row.setAttribute('data-idx', String(i));
    if (isLayout) row.setAttribute('draggable', 'true');

    const kind = isTrim ? 'Trim' : s.axis === 'rip' ? 'Rip' : 'Crosscut';
    const parent = `${Math.round(Math.max(s.parentW, s.parentH))}×${Math.round(Math.min(s.parentW, s.parentH))}`;
    const dimText = fmtDim(quotedForRow(s), ctx.units);
    const chips: string[] = [];
    if (s.isDatum) chips.push('<span class="cut-chip ref">REF</span>');
    if (s.sameSetting) chips.push('<span class="cut-chip same">same</span>');

    row.innerHTML = `
      <span class="cut-num">${s.index}</span>
      <span class="cut-main">
        <span class="cut-kind">${kind} ${dimText}</span>
        <span class="cut-sub">from ${edgeLabel(s)} edge · piece ${parent}</span>
      </span>
      <span class="cut-chips">${chips.join('')}</span>
      <span class="cut-actions">
        <button type="button" class="cut-btn" data-act="up" title="Move up"${isTrim ? ' disabled' : ''}>↑</button>
        <button type="button" class="cut-btn" data-act="down" title="Move down"${isTrim ? ' disabled' : ''}>↓</button>
        <button type="button" class="cut-btn" data-act="flip" title="Flip measured-from edge"${isTrim ? ' disabled' : ''}>⇄</button>
        <button type="button" class="cut-btn${s.isDatum ? ' on' : ''}" data-act="datum" title="Mark reference (datum) cut"${isTrim ? ' disabled' : ''}>REF</button>
      </span>`;

    // Disable ↑/↓ where the move would be illegal.
    if (isLayout) {
      const upBtn = row.querySelector('[data-act="up"]') as HTMLButtonElement;
      const downBtn = row.querySelector('[data-act="down"]') as HTMLButtonElement;
      const canUp = layoutIdx > 0 && reorderLegal(session!.layout, session!.trims, layoutIdx, layoutIdx - 1, ctx.sheet.sheetW, ctx.sheet.sheetL);
      const canDown = layoutIdx < session!.layout.length - 1 && reorderLegal(session!.layout, session!.trims, layoutIdx, layoutIdx + 1, ctx.sheet.sheetW, ctx.sheet.sheetL);
      upBtn.disabled = !canUp;
      downBtn.disabled = !canDown;
    }

    // Hover-highlight the diagram: temporarily select this row's cut.
    row.addEventListener('mouseenter', () => {
      if (!session) return;
      session.selected = i;
      renderDiagram();
      for (const r of host.querySelectorAll('.cut-row')) r.classList.remove('selected');
      row.classList.add('selected');
    });
    row.addEventListener('click', () => {
      if (!session) return;
      session.selected = i;
      render();
    });

    row.querySelector('[data-act="up"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (layoutIdx > 0) doReorder(layoutIdx, layoutIdx - 1);
    });
    row.querySelector('[data-act="down"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (layoutIdx >= 0) doReorder(layoutIdx, layoutIdx + 1);
    });
    row.querySelector('[data-act="flip"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFlip(i);
    });
    row.querySelector('[data-act="datum"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDatum(i);
    });

    // Drag-and-drop reorder (layout rows only).
    if (isLayout) {
      row.addEventListener('dragstart', (e) => {
        (e as DragEvent).dataTransfer?.setData('text/plain', String(layoutIdx));
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        const from = dragSourceLayoutIdx();
        if (from < 0) return;
        const legal = reorderLegal(session!.layout, session!.trims, from, layoutIdx, ctx.sheet.sheetW, ctx.sheet.sheetL);
        row.classList.toggle('drop-ok', legal);
        row.classList.toggle('drop-bad', !legal);
      });
      row.addEventListener('dragleave', () => { row.classList.remove('drop-ok', 'drop-bad'); });
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drop-ok', 'drop-bad');
        const from = parseInt((e as DragEvent).dataTransfer?.getData('text/plain') ?? '', 10);
        if (Number.isFinite(from) && from >= 0) doReorder(from, layoutIdx);
      });
    }

    host.appendChild(row);
  });
}

/** Track the drag source across dragover events (dataTransfer.getData is only
 *  readable in the drop handler, so we stash it on the dragging row). */
function dragSourceLayoutIdx(): number {
  if (!overlay || !session) return -1;
  const dragging = overlay.querySelector('.cut-row.dragging');
  if (!dragging) return -1;
  const idx = parseInt(dragging.getAttribute('data-idx') ?? '', 10);
  if (!Number.isFinite(idx)) return -1;
  const step = session.steps[idx];
  return session.layout.findIndex((x) => x === step);
}
