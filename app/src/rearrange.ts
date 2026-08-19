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
/** Snap radius, sheet mm. Magnetic: a panel jumps into alignment well before
 *  it is actually touching. */
const SNAP_MM = 40;
/**
 * Candidate preference, in millimetres of "virtual distance" added per rank.
 * Contact (a kerf apart, the cut-tight case) outranks flush alignment, which
 * outranks the margin box — so when two snaps are both in range the panel
 * prefers to touch. Expressed as a distance penalty rather than a hard
 * ordering so a much closer alignment still wins over a far-off contact.
 */
const RANK_BIAS_MM = 8;
const RANK_CONTACT = 0;
const RANK_FLUSH = 1;
const RANK_MARGIN = 2;
/** Cap on cascade work — a pathological push cycle must not spin. */
const MAX_SHOVES = 400;
/** Per-panel move cap; ping-ponging between two blockers bails out. */
const MAX_MOVES_PER_PART = 8;
/** Float slack for edge comparisons (STEP tessellation noise, mm). */
const EPS = 0.05;

/** A panel lifted off the sheets and held aside. Thickness travels with it:
 *  once parked it has no sheet to infer its material from, and it must not be
 *  put back onto stock of a different thickness. */
export interface StagedPart {
  part: PlacedPart;
  thickness: number;
}

export interface RearrangeCtx {
  result: NestResult;
  margin: number;
  kerf: number;
  /** Panels parked out of the sheets. Owned by the caller so it survives the
   *  re-render that every commit triggers; mutated here. */
  staging: StagedPart[];
  /** Re-render the results pane after a committed move. */
  onCommit: () => void;
  /** Show or hide the staging tray mid-drag, without a full re-render. */
  onStagingVisible: (visible: boolean) => void;
}

interface Registered { svg: SVGSVGElement; sheet: NestSheet }

let ctx: RearrangeCtx | null = null;
let registry: Registered[] = [];
/** Rendered panel → its SVG group, so the cascade can move the real elements
 *  live during a drag rather than only previewing where they would land. */
let partEls = new Map<PlacedPart, SVGGElement>();
/** The staging tray element, registered per render while the mode is armed. */
let stagingEl: HTMLElement | null = null;

/**
 * Called once per results render. Pass the context to arm drag mode, or null
 * to disarm. Clears the sheet registry either way — the SVG elements from the
 * previous render are about to be discarded.
 */
export function beginRearrangeRender(next: RearrangeCtx | null) {
  ctx = next;
  registry = [];
  partEls = new Map();
  stagingEl = null;
}

/** Register the staging tray as a drop target for this render. */
export function registerStaging(el: HTMLElement) {
  if (!ctx) return;
  stagingEl = el;
}

/** Make a parked tile draggable back out onto a sheet. */
export function makeStagedDraggable(el: HTMLElement, entry: StagedPart) {
  if (!ctx) return;
  el.addEventListener('pointerdown', (ev) => onPointerDown(ev, null, entry.part, null));
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
  type Cand = { v: number; rank: number };
  const xs: Cand[] = [
    { v: margin, rank: RANK_MARGIN },
    { v: sheet.sheetW - margin - part.w, rank: RANK_MARGIN },
  ];
  const ys: Cand[] = [
    { v: margin, rank: RANK_MARGIN },
    { v: sheet.sheetL - margin - part.h, rank: RANK_MARGIN },
  ];
  for (const o of sheet.parts) {
    if (o === part) continue;
    xs.push({ v: o.x + o.w + kerf, rank: RANK_CONTACT },
            { v: o.x - part.w - kerf, rank: RANK_CONTACT },
            { v: o.x, rank: RANK_FLUSH },
            { v: o.x + o.w - part.w, rank: RANK_FLUSH });
    ys.push({ v: o.y + o.h + kerf, rank: RANK_CONTACT },
            { v: o.y - part.h - kerf, rank: RANK_CONTACT },
            { v: o.y, rank: RANK_FLUSH },
            { v: o.y + o.h - part.h, rank: RANK_FLUSH });
  }
  const nearest = (v: number, cands: Cand[]) => {
    let best = v;
    let bestScore = SNAP_MM;
    for (const c of cands) {
      const d = Math.abs(c.v - v);
      if (d > SNAP_MM) continue;
      const score = d + c.rank * RANK_BIAS_MM;
      if (score < bestScore) { bestScore = score; best = c.v; }
    }
    return best;
  };
  return { x: nearest(x, xs), y: nearest(y, ys) };
}

// ---------------------------------------------------------------------------
// Push-aside cascade
// ---------------------------------------------------------------------------

/**
 * Shove every panel out of the dragged one's way, cascading into their own
 * neighbours, and return the resulting positions — or null if some panel has
 * nowhere legal to go.
 *
 * `anchor` is immovable: you dropped it there, so everything else yields to
 * it. Each blocked panel escapes along whichever of the four axes needs the
 * least travel while keeping it inside the margin box; moving it can block
 * someone else, so it re-queues.
 *
 * The whole thing runs on a COPY. Callers commit only on success, so a
 * cascade that cannot resolve leaves the sheet untouched rather than half
 * rearranged. Both the total work and the per-panel move count are capped:
 * two panels can otherwise shove each other back and forth forever.
 */
export function planReshuffle(
  sheet: NestSheet, anchor: PlacedPart, ax: number, ay: number,
  margin: number, kerf: number,
): Map<PlacedPart, { x: number; y: number }> | null {
  const pos = new Map<PlacedPart, { x: number; y: number }>();
  for (const p of sheet.parts) pos.set(p, { x: p.x, y: p.y });
  pos.set(anchor, { x: ax, y: ay });
  // The anchor must be inside the sheet on its own account.
  if (ax < margin - EPS || ay < margin - EPS
      || ax + anchor.w > sheet.sheetW - margin + EPS
      || ay + anchor.h > sheet.sheetL - margin + EPS) return null;

  const moves = new Map<PlacedPart, number>();
  const queue: PlacedPart[] = sheet.parts.filter((p) => p !== anchor);
  const inBox = (p: PlacedPart, x: number, y: number) =>
    x >= margin - EPS && y >= margin - EPS
    && x + p.w <= sheet.sheetW - margin + EPS
    && y + p.h <= sheet.sheetL - margin + EPS;
  /** Would `p`, placed at (x, y), foul `q` where it currently sits? */
  const foulsAt = (p: PlacedPart, x: number, y: number, q: PlacedPart) => {
    const Q = pos.get(q)!;
    const gx = Math.max(Q.x - (x + p.w), x - (Q.x + q.w));
    const gy = Math.max(Q.y - (y + p.h), y - (Q.y + q.h));
    return Math.max(gx, gy) < kerf - EPS;
  };
  const firstFoul = (p: PlacedPart, x: number, y: number) =>
    sheet.parts.find((q) => q !== p && foulsAt(p, x, y, q));

  /**
   * Slide `p` in one direction until it is clear of EVERYTHING, not just the
   * first thing in its way. Resolving against a single blocker at a time makes
   * a panel boxed in by several ping-pong between them and burn its move
   * budget, which is what made crowded sheets report "no room" when there was
   * plenty. Returns null if it runs off the margin box.
   */
  const slide = (p: PlacedPart, dir: 0 | 1 | 2 | 3) => {
    const P = pos.get(p)!;
    let { x, y } = P;
    for (let i = 0; i <= sheet.parts.length + 1; i++) {
      const hit = firstFoul(p, x, y);
      if (!hit) return { x, y };
      const H = pos.get(hit)!;
      if (dir === 0) x = H.x - kerf - p.w;
      else if (dir === 1) x = H.x + hit.w + kerf;
      else if (dir === 2) y = H.y - kerf - p.h;
      else y = H.y + hit.h + kerf;
      if (!inBox(p, x, y)) return null;
    }
    return null;
  };

  for (let guard = 0; queue.length > 0; guard++) {
    if (guard > MAX_SHOVES) return null;
    const p = queue.shift()!;
    if (p === anchor) continue;
    const P = pos.get(p)!;
    if (!firstFoul(p, P.x, P.y)) continue;

    const options = ([0, 1, 2, 3] as const)
      .map((d) => slide(p, d))
      .filter((o): o is { x: number; y: number } => o !== null);
    if (options.length === 0) return null;
    options.sort((a, b) =>
      (Math.abs(a.x - P.x) + Math.abs(a.y - P.y))
      - (Math.abs(b.x - P.x) + Math.abs(b.y - P.y)));

    const n = (moves.get(p) ?? 0) + 1;
    if (n > MAX_MOVES_PER_PART) return null;
    moves.set(p, n);
    pos.set(p, options[0]);
    // This panel moved, so it may now foul others.
    for (const q of sheet.parts) {
      if (q !== p && q !== anchor && !queue.includes(q)
          && foulsAt(q, pos.get(q)!.x, pos.get(q)!.y, p)) {
        queue.push(q);
      }
    }
  }
  return pos;
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
// Rotation
// ---------------------------------------------------------------------------

type Ring = [number, number][];

/** Rotate a ring by a multiple of 90°. Screen coords are y-down, so a visual
 *  clockwise turn is (x, y) → (−y, x). */
function rotateRing(ring: Ring, quarter: number): Ring {
  const q = ((quarter % 4) + 4) % 4;
  return ring.map(([x, y]): [number, number] => (
    q === 1 ? [-y, x] : q === 2 ? [-x, -y] : q === 3 ? [y, -x] : [x, y]
  ));
}

/**
 * Turn a placed panel by a multiple of 90°, in place.
 *
 * Rings are re-anchored to (0, 0) afterwards because PlacedPart.outer is
 * defined as rotated-and-anchored, and w/h are recomputed FROM the ring
 * rather than swapped, so the bbox can never drift away from the geometry
 * it is supposed to describe. Holes shift by the outer ring's offset, which
 * is the combined minimum since holes lie inside it.
 */
export function rotatePart(p: PlacedPart, quarter: number) {
  p.outer = rotateRing(p.outer as Ring, quarter);
  p.holes = p.holes.map((h) => rotateRing(h as Ring, quarter));
  let minX = Infinity, minY = Infinity;
  for (const [x, y] of p.outer) { minX = Math.min(minX, x); minY = Math.min(minY, y); }
  if (!Number.isFinite(minX)) return;
  for (const r of [p.outer, ...p.holes]) {
    for (const pt of r) { pt[0] -= minX; pt[1] -= minY; }
  }
  let maxX = 0, maxY = 0;
  for (const [x, y] of p.outer) { maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  p.w = maxX;
  p.h = maxY;
  p.rotation = (((p.rotation + quarter * 90) % 360) + 360) % 360;
}

/** Everything a drag may mutate, so an abandoned drag can be undone. */
interface PartSnapshot {
  x: number; y: number; w: number; h: number; rotation: number;
  outer: Ring; holes: Ring[];
}

function snapshotPart(p: PlacedPart): PartSnapshot {
  return {
    x: p.x, y: p.y, w: p.w, h: p.h, rotation: p.rotation,
    outer: (p.outer as Ring).map(([a, b]): [number, number] => [a, b]),
    holes: p.holes.map((h) => (h as Ring).map(([a, b]): [number, number] => [a, b])),
  };
}

function restorePart(p: PlacedPart, s: PartSnapshot) {
  p.x = s.x; p.y = s.y; p.w = s.w; p.h = s.h; p.rotation = s.rotation;
  p.outer = s.outer.map(([a, b]): [number, number] => [a, b]);
  p.holes = s.holes.map((h) => h.map(([a, b]): [number, number] => [a, b]));
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
  /** Sheet the panel came from, or null when it was lifted out of staging. */
  from: NestSheet | null;
  /** Grab point measured from the panel's top-left, in mm. */
  offX: number;
  offY: number;
  ghost: HTMLElement;
  /** px per mm at pickup — the ghost is a screen-space element, so it needs
   *  the scale to place the grab point under the cursor. */
  scale: number;
  /** Outline showing where the dragged panel itself will land. */
  previews: SVGElement[];
  /** Where it will land: a sheet position, or the staging tray. */
  drop: { sheet: NestSheet; x: number; y: number } | { staged: true } | null;
  /** Positions the cascade will apply on commit. */
  plan: Map<PlacedPart, { x: number; y: number }> | null;
  /** Panels currently displaced on screen, so they can be put back when the
   *  pointer moves on. */
  live: Set<PlacedPart>;
  group: SVGGElement | null;
  /** Geometry as it was at pickup — restored if the drag is abandoned, so an
   *  arrow-key rotation cannot leak out of a cancelled drag. */
  origin: PartSnapshot;
  /** Last pointer position, so a rotation can re-run placement without the
   *  pointer having moved. */
  clientX: number;
  clientY: number;
  /** Pending animation frame — pointermove fires far more often than the
   *  cascade needs to run. */
  raf: number;
}

let drag: DragState | null = null;

/** Make one rendered panel draggable. No-op unless the mode is armed. */
export function makePartDraggable(g: SVGGElement, part: PlacedPart, sheet: NestSheet) {
  if (!ctx) return;
  g.classList.add('part--draggable');
  partEls.set(part, g);
  g.addEventListener('pointerdown', (ev) => onPointerDown(ev, g, part, sheet));
}

/**
 * Start a drag. `g`/`sheet` are null when the panel is being lifted out of the
 * staging tray, where there is no SVG to measure against — the grab point is
 * taken as the panel's centre and the scale from whichever sheet is on screen,
 * so the ghost still matches the size it will be when dropped.
 */
function onPointerDown(
  ev: PointerEvent, g: SVGGElement | null, part: PlacedPart, sheet: NestSheet | null,
) {
  if (!ctx || drag || ev.button !== 0) return;
  let offX: number, offY: number, scale: number;
  if (g && sheet) {
    const svg = g.ownerSVGElement;
    if (!svg) return;
    const at = toSheetMm(svg, ev.clientX, ev.clientY);
    if (!at) return;
    offX = at.x - part.x;
    offY = at.y - part.y;
    scale = at.scale;
  } else {
    const ref = registry[0];
    const m = ref?.svg.getScreenCTM();
    scale = m?.a || 1;
    offX = part.w / 2;
    offY = part.h / 2;
  }
  // The sheet click handler selects the sheet; a drag is not a selection.
  ev.preventDefault();
  ev.stopPropagation();

  const ghost = document.createElement('div');
  ghost.className = 'rearrange-ghost';
  ghost.style.width = `${part.w * scale}px`;
  ghost.style.height = `${part.h * scale}px`;
  ghost.textContent = sheet ? `${sheet.globalIndex}${part.panelLabel}` : part.panelLabel;
  document.body.appendChild(ghost);

  g?.classList.add('part--dragging');
  // The tray is a drop target for the whole drag, so it has to be on screen
  // from the moment a panel is picked up — that IS the "drag a panel out and
  // a box appears" behaviour.
  ctx.onStagingVisible(true);
  drag = {
    part, from: sheet, offX, offY,
    ghost, scale, previews: [], drop: null, plan: null,
    live: new Set(), group: g,
    origin: snapshotPart(part), clientX: ev.clientX, clientY: ev.clientY, raf: 0,
  };
  positionGhost(ev.clientX, ev.clientY);
  updateDrag(ev.clientX, ev.clientY);

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp, { once: true });
  window.addEventListener('keydown', onKeyDown);
}

/**
 * Arrow keys turn the panel mid-drag: ← / → by a quarter each way, ↑ / ↓ by a
 * half. The ghost is resized and placement re-tested against the pointer
 * where it already is, so a panel can be spun until it fits without letting
 * go. preventDefault stops the page scrolling under the drag.
 */
function onKeyDown(ev: KeyboardEvent) {
  if (!drag) return;
  const quarter = ev.key === 'ArrowRight' ? 1
    : ev.key === 'ArrowLeft' ? -1
    : (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') ? 2
    : 0;
  if (quarter === 0) return;
  ev.preventDefault();
  rotatePart(drag.part, quarter);
  // The grab offset was measured against the old orientation; re-centre it so
  // the panel doesn't leap out from under the cursor as it turns.
  drag.offX = drag.part.w / 2;
  drag.offY = drag.part.h / 2;
  drag.ghost.style.width = `${drag.part.w * drag.scale}px`;
  drag.ghost.style.height = `${drag.part.h * drag.scale}px`;
  updateDrag(drag.clientX, drag.clientY);
  positionGhost(drag.clientX, drag.clientY);
}

function positionGhost(clientX: number, clientY: number) {
  if (!drag) return;
  // Put the grab point back under the cursor: the panel appears to be held
  // exactly where it was picked up, not by its corner.
  drag.ghost.style.left = `${clientX - drag.offX * drag.scale}px`;
  drag.ghost.style.top = `${clientY - drag.offY * drag.scale}px`;
}

function onPointerMove(ev: PointerEvent) {
  if (!drag) return;
  drag.clientX = ev.clientX;
  drag.clientY = ev.clientY;
  // The ghost must track the cursor at full rate; the cascade only needs to
  // keep up with the display.
  positionGhost(ev.clientX, ev.clientY);
  if (drag.raf) return;
  drag.raf = requestAnimationFrame(() => {
    if (!drag) return;
    drag.raf = 0;
    updateDrag(drag.clientX, drag.clientY);
  });
}

/**
 * Push the cascade's positions onto the REAL panel elements, so neighbours
 * slide out of the way live while the pointer is still down. A CSS transform
 * overrides the element's own `transform` attribute wholesale, so each value
 * is the panel's absolute planned position, not an offset. Panels no longer
 * displaced are released back to their attribute position.
 */
function applyLive(plan: Map<PlacedPart, { x: number; y: number }> | null) {
  if (!drag) return;
  const next = new Set<PlacedPart>();
  if (plan) {
    for (const [p, np] of plan) {
      if (p === drag.part) continue;
      if (Math.abs(np.x - p.x) < EPS && Math.abs(np.y - p.y) < EPS) continue;
      const el = partEls.get(p);
      if (!el) continue;
      el.style.transform = `translate(${np.x}px, ${np.y}px)`;
      next.add(p);
    }
  }
  for (const p of drag.live) {
    if (next.has(p)) continue;
    const el = partEls.get(p);
    if (el) el.style.transform = '';
  }
  drag.live = next;
}

/**
 * Work out where the panel would land from the current pointer position, and
 * show it. A spot counts as legal if it is either already clear OR the
 * surrounding panels can be shoved out of the way — so the red state now
 * means genuinely impossible, not merely occupied.
 */
function updateDrag(clientX: number, clientY: number) {
  if (!drag || !ctx) return;
  clearPreview();
  drag.drop = null;
  drag.plan = null;

  // The tray wins over the sheets: it is drawn above them, so a pointer
  // inside it is aiming at it.
  if (stagingEl && overElement(stagingEl, clientX, clientY)) {
    stagingEl.classList.add('staging--hot');
    applyLive(null);
    // Parking is always possible; there is nothing to collide with.
    drag.drop = { staged: true };
    drag.ghost.classList.remove('rearrange-ghost--bad');
    return;
  }
  stagingEl?.classList.remove('staging--hot');

  const target = sheetAt(clientX, clientY);
  let plan: Map<PlacedPart, { x: number; y: number }> | null = null;
  if (target) {
    const at = toSheetMm(target.svg, clientX, clientY);
    // A panel may only go back onto stock of its own thickness — off its
    // original sheet it has no other way to know what it is cut from.
    const sameStock = !drag.from || drag.from.thickness === target.sheet.thickness;
    if (at && sameStock) {
      // Clamp into the margin box BEFORE snapping. Dragging a panel wider than
      // the space to one side would otherwise put its corner off the sheet and
      // simply refuse — pinning it against the margin is what you meant.
      const maxX = target.sheet.sheetW - ctx.margin - drag.part.w;
      const maxY = target.sheet.sheetL - ctx.margin - drag.part.h;
      const cx = Math.min(Math.max(at.x - drag.offX, ctx.margin), Math.max(ctx.margin, maxX));
      const cy = Math.min(Math.max(at.y - drag.offY, ctx.margin), Math.max(ctx.margin, maxY));
      const s = snap(target.sheet, drag.part, cx, cy, ctx.margin, ctx.kerf);
      // On a cross-sheet move the panel isn't in the target's list yet, so it
      // has to be considered alongside them for the cascade to see it.
      const scratch: NestSheet = target.sheet.parts.includes(drag.part)
        ? target.sheet
        : { ...target.sheet, parts: [...target.sheet.parts, drag.part] };
      plan = planReshuffle(scratch, drag.part, s.x, s.y, ctx.margin, ctx.kerf);
      showPreview(target.svg, s.x, s.y, drag.part.w, drag.part.h, plan !== null);
      if (plan) { drag.drop = { sheet: target.sheet, x: s.x, y: s.y }; drag.plan = plan; }
    } else if (at) {
      // Wrong thickness — show where it would go, in red, and refuse.
      showPreview(target.svg, at.x - drag.offX, at.y - drag.offY,
                  drag.part.w, drag.part.h, false);
    }
  }
  // Neighbours slide aside for real, right now, rather than being previewed.
  applyLive(plan);
  drag.ghost.classList.toggle('rearrange-ghost--bad', !drag.drop);
}

/** Is the pointer inside this element's box? */
function overElement(el: HTMLElement, x: number, y: number): boolean {
  if (el.hidden) return false;
  const b = el.getBoundingClientRect();
  return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
}

function previewRect(svg: SVGSVGElement, cls: string, x: number, y: number, w: number, h: number) {
  if (!drag) return;
  const r = document.createElementNS(SVG_NS, 'rect');
  r.setAttribute('class', cls);
  r.setAttribute('x', String(x));
  r.setAttribute('y', String(y));
  r.setAttribute('width', String(w));
  r.setAttribute('height', String(h));
  svg.appendChild(r);
  drag.previews.push(r);
}

function showPreview(
  svg: SVGSVGElement, x: number, y: number, w: number, h: number, legal: boolean,
) {
  previewRect(svg, `rearrange-preview${legal ? '' : ' rearrange-preview--bad'}`, x, y, w, h);
}

function clearPreview() {
  if (!drag) return;
  for (const p of drag.previews) p.remove();
  drag.previews = [];
}

function onPointerUp() {
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('keydown', onKeyDown);
  if (!drag || !ctx) return;
  const { part, from, drop, plan, ghost, group, origin } = drag;
  if (drag.raf) cancelAnimationFrame(drag.raf);
  clearPreview();
  releaseLive();
  ghost.remove();
  group?.classList.remove('part--dragging');
  stagingEl?.classList.remove('staging--hot');
  drag = null;

  // Nowhere legal to land — undo everything the drag touched, including any
  // rotation, so an abandoned drag leaves no trace.
  if (!drop) { restorePart(part, origin); syncStagingVisible(); return; }

  // Parked: lift it off its sheet and hold it aside. Thickness comes from the
  // sheet it left, which is the only place that knows.
  if ('staged' in drop) {
    if (from) {
      from.parts.splice(from.parts.indexOf(part), 1);
      ctx.staging.push({ part, thickness: from.thickness });
      refreshSheet(from, ctx.margin, ctx.kerf);
      ctx.onCommit();
    }
    return;
  }
  if (!plan) { restorePart(part, origin); syncStagingVisible(); return; }

  // Coming back out of staging.
  const staged = ctx.staging.findIndex((s) => s.part === part);
  if (staged >= 0) ctx.staging.splice(staged, 1);

  const rotated = part.rotation !== origin.rotation;
  const sameSpot = drop.sheet === from && staged < 0
    && Math.abs(drop.x - origin.x) < EPS && Math.abs(drop.y - origin.y) < EPS;
  const shoved = [...plan].some(([p, np]) =>
    p !== part && (Math.abs(np.x - p.x) > EPS || Math.abs(np.y - p.y) > EPS));
  if (sameSpot && !rotated && !shoved) { syncStagingVisible(); return; }

  if (drop.sheet !== from) {
    from?.parts.splice(from.parts.indexOf(part), 1);
    drop.sheet.parts.push(part);
  }
  // Apply the cascade: the dragged panel to its drop spot, everyone the plan
  // moved to wherever they were pushed.
  for (const [p, np] of plan) { p.x = np.x; p.y = np.y; }
  part.x = drop.x;
  part.y = drop.y;

  refreshSheet(drop.sheet, ctx.margin, ctx.kerf);
  if (from && drop.sheet !== from) refreshSheet(from, ctx.margin, ctx.kerf);
  // NOTE: empty sheets are deliberately NOT pruned here. Parking every panel
  // off a sheet would delete the sheet and leave nowhere to put them back.
  // pruneEmptySheets runs when the mode is switched off instead.
  ctx.onCommit();
}

/** Put every live-displaced panel back where its attribute says it is. */
function releaseLive() {
  if (!drag) return;
  for (const p of drag.live) {
    const el = partEls.get(p);
    if (el) el.style.transform = '';
  }
  drag.live.clear();
}

/** The tray is shown while a drag is in flight, and stays while it holds
 *  anything. */
function syncStagingVisible() {
  if (ctx) ctx.onStagingVisible(ctx.staging.length > 0);
}

/** Abandon any drag in flight — called when the mode is switched off or the
 *  results pane re-renders under us. */
export function cancelDrag() {
  if (!drag) return;
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('keydown', onKeyDown);
  if (drag.raf) cancelAnimationFrame(drag.raf);
  clearPreview();
  releaseLive();
  drag.ghost.remove();
  drag.group?.classList.remove('part--dragging');
  stagingEl?.classList.remove('staging--hot');
  // Undo any mid-drag rotation — the panel was never dropped.
  restorePart(drag.part, drag.origin);
  drag = null;
  syncStagingVisible();
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
