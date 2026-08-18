/**
 * Manual layout rearrange — drag panels around a sheet, or onto another one.
 *
 * The optimiser gives a good layout; this is the escape hatch for when the
 * user knows something it doesn't (grain run, a defect in the sheet, keeping
 * one offcut whole). Turning the mode on puts EVERY rendered sheet into drag
 * mode at once, because "move this panel to the next sheet" is half the point
 * and that needs two live drop targets.
 *
 * Coordinates: sheet SVGs use a viewBox in millimetres, so `getScreenCTM()`
 * converts pointer positions straight into sheet mm. Nothing here needs to
 * know the pixel scale except the drag ghost, which reads it from the same
 * matrix.
 *
 * A drop is committed only if it is legal — inside the margin box and at
 * least a kerf away from every other panel on the target sheet. Illegal
 * positions are shown in red and snap back on release, so the layout in
 * `state.lastNest` is always something the saw can actually cut.
 */
import { annotatePlacedParts, type NestResult, type NestSheet, type PlacedPart } from './nest';
import { deriveGuillotineCuts } from './packRect';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Snap radius, sheet mm. Generous: manual placement should land flush. */
const SNAP_MM = 14;
/** Float slack for edge comparisons (STEP tessellation noise, mm). */
const EPS = 0.05;

export interface RearrangeCtx {
  result: NestResult;
  margin: number;
  kerf: number;
  /** Re-render the results pane after a committed move. */
  onCommit: () => void;
}

interface Registered { svg: SVGSVGElement; sheet: NestSheet }

let ctx: RearrangeCtx | null = null;
let registry: Registered[] = [];

/**
 * Called once per results render. Pass the context to arm drag mode, or null
 * to disarm. Clears the sheet registry either way — the SVG elements from the
 * previous render are about to be discarded.
 */
export function beginRearrangeRender(next: RearrangeCtx | null) {
  ctx = next;
  registry = [];
}

export function rearrangeArmed(): boolean {
  return ctx !== null;
}

/** Register a rendered sheet SVG as a drag source and drop target. */
export function registerSheet(svg: SVGSVGElement, sheet: NestSheet) {
  if (!ctx) return;
  svg.classList.add('sheet-svg--rearrange');
  registry.push({ svg, sheet });
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Gap between two axis-aligned rects — negative when they overlap. A pair is
 *  cuttable when they are clear by at least a kerf along ONE axis. */
function separation(
  x: number, y: number, w: number, h: number, o: PlacedPart,
): number {
  const gapX = Math.max(o.x - (x + w), x - (o.x + o.w));
  const gapY = Math.max(o.y - (y + h), y - (o.y + o.h));
  return Math.max(gapX, gapY);
}

/** Is (x, y) a legal home for `part` on `sheet`, ignoring `part` itself? */
export function placementLegal(
  sheet: NestSheet, part: PlacedPart, x: number, y: number,
  margin: number, kerf: number,
): boolean {
  if (x < margin - EPS || y < margin - EPS) return false;
  if (x + part.w > sheet.sheetW - margin + EPS) return false;
  if (y + part.h > sheet.sheetL - margin + EPS) return false;
  for (const o of sheet.parts) {
    if (o === part) continue;
    if (separation(x, y, part.w, part.h, o) < kerf - EPS) return false;
  }
  return true;
}

/**
 * Pull a loose drag position onto a meaningful edge: the margin box, a
 * neighbour's far edge one kerf away (the cut-tight case), or a neighbour's
 * near edge (flush alignment, which keeps a guillotine line straight).
 * Each axis snaps independently.
 */
function snap(
  sheet: NestSheet, part: PlacedPart, x: number, y: number,
  margin: number, kerf: number,
): { x: number; y: number } {
  const xs = [margin, sheet.sheetW - margin - part.w];
  const ys = [margin, sheet.sheetL - margin - part.h];
  for (const o of sheet.parts) {
    if (o === part) continue;
    xs.push(o.x, o.x + o.w - part.w, o.x + o.w + kerf, o.x - part.w - kerf);
    ys.push(o.y, o.y + o.h - part.h, o.y + o.h + kerf, o.y - part.h - kerf);
  }
  const nearest = (v: number, cands: number[]) => {
    let best = v, bestD = SNAP_MM;
    for (const c of cands) {
      const d = Math.abs(c - v);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  };
  return { x: nearest(x, xs), y: nearest(y, ys) };
}

/**
 * Largest empty axis-aligned rectangle inside the margin box.
 *
 * Built on the coordinate grid induced by the parts' own edges (at most
 * 2n+2 lines per axis), so every maximal empty rectangle is representable.
 * Occupied cells are marked, then the classic largest-rectangle-in-histogram
 * sweep runs over the rows with per-column widths. n is tens of panels, so
 * the O(n²) grid is nothing.
 */
export function largestFreeRect(
  sheet: NestSheet, margin: number, kerf: number,
): { w: number; h: number } | null {
  const x0 = margin, y0 = margin;
  const x1 = sheet.sheetW - margin, y1 = sheet.sheetL - margin;
  if (x1 <= x0 || y1 <= y0) return null;

  const uniq = (vals: number[], lo: number, hi: number) =>
    [...new Set(vals.filter((v) => v > lo + EPS && v < hi - EPS).concat([lo, hi]))]
      .sort((a, b) => a - b);
  // A part blocks its own extent plus half a kerf of saw path on each side:
  // material closer than that can't be recovered as a usable offcut.
  const k = kerf / 2;
  const xsRaw: number[] = [];
  const ysRaw: number[] = [];
  for (const p of sheet.parts) {
    xsRaw.push(p.x - k, p.x + p.w + k);
    ysRaw.push(p.y - k, p.y + p.h + k);
  }
  const xs = uniq(xsRaw, x0, x1);
  const ys = uniq(ysRaw, y0, y1);
  const nx = xs.length - 1, ny = ys.length - 1;
  if (nx <= 0 || ny <= 0) return null;

  // occupied[row][col]
  const occ: boolean[][] = [];
  for (let r = 0; r < ny; r++) {
    const cy = (ys[r] + ys[r + 1]) / 2;
    const row: boolean[] = [];
    for (let c = 0; c < nx; c++) {
      const cx = (xs[c] + xs[c + 1]) / 2;
      row.push(sheet.parts.some(
        (p) => cx > p.x - k && cx < p.x + p.w + k && cy > p.y - k && cy < p.y + p.h + k,
      ));
    }
    occ.push(row);
  }

  const colW = Array.from({ length: nx }, (_, c) => xs[c + 1] - xs[c]);
  const heights = new Array<number>(nx).fill(0);
  let best: { w: number; h: number } | null = null;
  let bestArea = 0;
  for (let r = 0; r < ny; r++) {
    const rowH = ys[r + 1] - ys[r];
    for (let c = 0; c < nx; c++) heights[c] = occ[r][c] ? 0 : heights[c] + rowH;
    // Widest run at each height, evaluated per column as the anchor.
    for (let c = 0; c < nx; c++) {
      if (heights[c] === 0) continue;
      let h = heights[c];
      let w = 0;
      for (let d = c; d < nx && heights[d] > 0; d++) {
        h = Math.min(h, heights[d]);
        w += colW[d];
        const area = w * h;
        if (area > bestArea) { bestArea = area; best = { w, h }; }
      }
    }
  }
  return best && bestArea > 1 ? best : null;
}

/** Recompute everything derived from a sheet's part positions. */
export function refreshSheet(sheet: NestSheet, margin: number, kerf: number) {
  sheet.usedArea = sheet.parts.reduce((a, p) => a + p.w * p.h, 0);
  sheet.largestFree = largestFreeRect(sheet, margin, kerf);
  // Cuts are position-derived; a moved panel invalidates the tree. A manual
  // layout may not be guillotine-cuttable at all, in which case this returns
  // an empty list and the cut pages simply have nothing to show for it —
  // which is honest, and better than printing a stale sequence.
  try {
    sheet.cuts = deriveGuillotineCuts(
      sheet.parts.map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h })),
      sheet.sheetW, sheet.sheetL,
    );
  } catch {
    sheet.cuts = [];
  }
  annotatePlacedParts(sheet);
}

// ---------------------------------------------------------------------------
// Drag
// ---------------------------------------------------------------------------

/** Pointer position in a sheet SVG's user units (mm). */
function toSheetMm(svg: SVGSVGElement, clientX: number, clientY: number) {
  const m = svg.getScreenCTM();
  if (!m) return null;
  const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
  return { x: p.x, y: p.y, scale: m.a || 1 };
}

/** The registered sheet whose SVG is under the pointer, if any. */
function sheetAt(clientX: number, clientY: number): Registered | null {
  for (const r of registry) {
    const b = r.svg.getBoundingClientRect();
    if (clientX >= b.left && clientX <= b.right && clientY >= b.top && clientY <= b.bottom) {
      return r;
    }
  }
  return null;
}

interface DragState {
  part: PlacedPart;
  from: NestSheet;
  /** Grab point measured from the panel's top-left, in mm. */
  offX: number;
  offY: number;
  ghost: HTMLElement;
  /** px per mm at pickup — the ghost is a screen-space element, so it needs
   *  the scale to place the grab point under the cursor. */
  scale: number;
  preview: SVGRectElement | null;
  previewSvg: SVGSVGElement | null;
  /** Last legal landing spot, or null when the pointer is over nothing. */
  drop: { sheet: NestSheet; x: number; y: number } | null;
  group: SVGGElement;
}

let drag: DragState | null = null;

/** Make one rendered panel draggable. No-op unless the mode is armed. */
export function makePartDraggable(g: SVGGElement, part: PlacedPart, sheet: NestSheet) {
  if (!ctx) return;
  g.classList.add('part--draggable');
  g.addEventListener('pointerdown', (ev) => onPointerDown(ev, g, part, sheet));
}

function onPointerDown(ev: PointerEvent, g: SVGGElement, part: PlacedPart, sheet: NestSheet) {
  if (!ctx || drag || ev.button !== 0) return;
  const svg = g.ownerSVGElement;
  if (!svg) return;
  const at = toSheetMm(svg, ev.clientX, ev.clientY);
  if (!at) return;
  // The sheet click handler selects the sheet; a drag is not a selection.
  ev.preventDefault();
  ev.stopPropagation();

  const ghost = document.createElement('div');
  ghost.className = 'rearrange-ghost';
  ghost.style.width = `${part.w * at.scale}px`;
  ghost.style.height = `${part.h * at.scale}px`;
  ghost.textContent = `${sheet.globalIndex}${part.panelLabel}`;
  document.body.appendChild(ghost);

  g.classList.add('part--dragging');
  drag = {
    part, from: sheet,
    offX: at.x - part.x, offY: at.y - part.y,
    ghost, scale: at.scale, preview: null, previewSvg: null, drop: null, group: g,
  };
  positionGhost(ev.clientX, ev.clientY);

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp, { once: true });
}

function positionGhost(clientX: number, clientY: number) {
  if (!drag) return;
  // Put the grab point back under the cursor: the panel appears to be held
  // exactly where it was picked up, not by its corner.
  drag.ghost.style.left = `${clientX - drag.offX * drag.scale}px`;
  drag.ghost.style.top = `${clientY - drag.offY * drag.scale}px`;
}

function onPointerMove(ev: PointerEvent) {
  if (!drag || !ctx) return;
  const target = sheetAt(ev.clientX, ev.clientY);
  clearPreview();
  drag.drop = null;

  if (target) {
    const at = toSheetMm(target.svg, ev.clientX, ev.clientY);
    if (at) {
      const raw = { x: at.x - drag.offX, y: at.y - drag.offY };
      // Snapping ignores the dragged panel itself; on a cross-sheet move it
      // isn't in the target's list anyway.
      const s = snap(target.sheet, drag.part, raw.x, raw.y, ctx.margin, ctx.kerf);
      const legal = placementLegal(target.sheet, drag.part, s.x, s.y, ctx.margin, ctx.kerf);
      showPreview(target.svg, s.x, s.y, drag.part.w, drag.part.h, legal);
      if (legal) drag.drop = { sheet: target.sheet, x: s.x, y: s.y };
    }
  }
  drag.ghost.classList.toggle('rearrange-ghost--bad', !drag.drop);
  positionGhost(ev.clientX, ev.clientY);
}

function showPreview(
  svg: SVGSVGElement, x: number, y: number, w: number, h: number, legal: boolean,
) {
  if (!drag) return;
  const r = document.createElementNS(SVG_NS, 'rect');
  r.setAttribute('class', `rearrange-preview${legal ? '' : ' rearrange-preview--bad'}`);
  r.setAttribute('x', String(x));
  r.setAttribute('y', String(y));
  r.setAttribute('width', String(w));
  r.setAttribute('height', String(h));
  svg.appendChild(r);
  drag.preview = r;
  drag.previewSvg = svg;
}

function clearPreview() {
  if (drag?.preview) drag.preview.remove();
  if (drag) { drag.preview = null; drag.previewSvg = null; }
}

function onPointerUp() {
  window.removeEventListener('pointermove', onPointerMove);
  if (!drag || !ctx) return;
  const { part, from, drop, ghost, group } = drag;
  clearPreview();
  ghost.remove();
  group.classList.remove('part--dragging');
  drag = null;

  // No legal landing spot → the panel stays exactly where it was.
  if (!drop) return;
  if (drop.sheet === from && Math.abs(drop.x - part.x) < EPS && Math.abs(drop.y - part.y) < EPS) {
    return;
  }

  if (drop.sheet !== from) {
    from.parts.splice(from.parts.indexOf(part), 1);
    drop.sheet.parts.push(part);
  }
  part.x = drop.x;
  part.y = drop.y;

  refreshSheet(drop.sheet, ctx.margin, ctx.kerf);
  if (drop.sheet !== from) {
    refreshSheet(from, ctx.margin, ctx.kerf);
    // Emptying a sheet should remove it from the job, not leave a blank page.
    pruneEmptySheets(ctx.result);
  }
  ctx.onCommit();
}

/** Abandon any drag in flight — called when the mode is switched off or the
 *  results pane re-renders under us. */
export function cancelDrag() {
  if (!drag) return;
  window.removeEventListener('pointermove', onPointerMove);
  clearPreview();
  drag.ghost.remove();
  drag.group.classList.remove('part--dragging');
  drag = null;
}

/**
 * Drop every sheet that ended up with no panels on it, and renumber what's
 * left so sheet ids stay contiguous. Moving the last panel off a sheet should
 * remove the sheet, not leave a blank one in the job.
 */
export function pruneEmptySheets(result: NestResult): boolean {
  let removed = false;
  for (const g of result.groups) {
    const kept = g.sheets.filter((s) => s.parts.length > 0);
    if (kept.length !== g.sheets.length) { removed = true; g.sheets = kept; }
  }
  result.groups = result.groups.filter((g) => g.sheets.length > 0);
  let global = 0;
  for (const g of result.groups) {
    g.sheets.forEach((s, i) => { s.index = i + 1; s.globalIndex = ++global; });
  }
  return removed;
}
