/**
 * CNC / waterjet true-shape nesting.
 *
 * The rectangle packer (packRect.ts) packs each part's axis-aligned bounding
 * box and only ever rotates by 0°/90°, because a track-saw / panel-saw makes
 * straight edge-to-edge cuts. A CNC router or waterjet cuts a CONTINUOUS
 * contour instead, so none of those constraints apply: a part may be rotated
 * to ANY angle, and a small part may sit inside the concavity — or even the
 * hole — of a larger neighbour. The only objective is material yield.
 *
 * Method: raster bottom-left-fill on the real silhouette.
 *   1. Each part, at each candidate rotation, is rasterised to an occupancy
 *      MASK at a fixed grid resolution. Crucially the part's holes are NOT
 *      marked occupied, so the free-space search may place other parts inside
 *      them — this is what lets parts nest inside curved / hollow parts rather
 *      than just inside bounding boxes.
 *   2. A per-sheet occupancy grid tracks filled cells. For each new part we
 *      scan grid positions bottom→top, left→right and take the first where
 *      the mask hits only free cells. A summed-area table gives an O(1)
 *      "is this window empty?" pre-test so the scan stays fast.
 *   3. The chosen cells (dilated by kerf) are marked filled; the next part
 *      sees them as consumed stock.
 *
 * Resolution trades tightness for speed. The exported CONTOURS are always the
 * exact polygon at the exact angle — only the gaps between parts are quantised
 * to the grid.
 */

import type { Vec2 } from './geometry';

export interface CncInput {
  /** Unique instance id, e.g. "<partId>#3". */
  id: string;
  /** Geometry key shared by instances of the same part (mask cache). */
  geoKey: string;
  /** Outer ring, anchored so its min corner is (0,0), CCW. */
  outer: Vec2[];
  /** Inner rings (holes), CW. */
  holes: Vec2[][];
  /** Candidate rotation angles in degrees (CCW). */
  angles: number[];
  /** True polygon area (outer − holes) in mm² (rotation-invariant). */
  area: number;
}

export interface CncPlaced {
  id: string;
  /** Rotation applied to reach this placement (degrees, CCW). */
  angleDeg: number;
  /** Lower-left of the rotated AABB, in usable-area (pre-margin) coords. */
  x: number;
  y: number;
  /** Rotated AABB dims (mm). */
  w: number;
  h: number;
  /** Rotated + re-anchored rings (origin at 0,0), ready to translate by x/y. */
  outer: Vec2[];
  holes: Vec2[][];
  /** True polygon area (mm²). */
  area: number;
}

export interface CncSheet {
  placements: CncPlaced[];
  /** Sum of true part areas placed (mm²). */
  usedArea: number;
  /** Largest empty axis-aligned rectangle remaining (mm × mm) or null. */
  largestFree: { w: number; h: number } | null;
}

export interface CncResult {
  sheets: CncSheet[];
  /** Instance ids that could not be placed (bigger than an empty sheet). */
  unplaced: string[];
}

export interface CncProgress {
  /** Parts placed so far (this pack call). */
  placed: number;
  /** Total parts to place. */
  total: number;
  /** Snapshot of sheets built so far (safe to keep — placements are copied). */
  sheets: CncSheet[];
}

// ---------------------------------------------------------------------------
// Polygon helpers
// ---------------------------------------------------------------------------
function rotateAnchor(
  outer: Vec2[],
  holes: Vec2[][],
  deg: number,
): { outer: Vec2[]; holes: Vec2[][]; w: number; h: number } {
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const rot = ([x, y]: Vec2): Vec2 => [x * c - y * s, x * s + y * c];
  const ro = outer.map(rot);
  const rh = holes.map((h) => h.map(rot));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ro) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const shift = ([x, y]: Vec2): Vec2 => [x - minX, y - minY];
  return {
    outer: ro.map(shift),
    holes: rh.map((h) => h.map(shift)),
    w: maxX - minX,
    h: maxY - minY,
  };
}

export function ringArea(ring: Vec2[]): number {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

export function polyArea(outer: Vec2[], holes: Vec2[][]): number {
  let a = ringArea(outer);
  for (const h of holes) a -= ringArea(h);
  return Math.max(0, a);
}

// ---------------------------------------------------------------------------
// Rasterisation
// ---------------------------------------------------------------------------
interface Mask {
  /** Cell offsets (dx,dy interleaved) that are occupied, within [0,mw)×[0,mh). */
  cells: Int32Array;
  mw: number;
  mh: number;
  /** Halo padding (cells) added around the shape to enforce kerf spacing. */
  pad: number;
  /** Rotated+anchored polygon for this angle (origin at 0,0). */
  outer: Vec2[];
  holes: Vec2[][];
  /** True AABB dims of the polygon (mm). */
  w: number;
  h: number;
}

/**
 * Rasterise a rotated polygon (outer − holes) into an occupancy mask.
 * The shape is sampled at cell centres via even-odd scanline fill (holes are
 * carved out automatically because their edges flip the in/out parity), then
 * dilated by `pad` cells so neighbours keep a kerf gap. The shape sits `pad`
 * cells in from the mask's lower-left corner.
 */
function buildMask(outer: Vec2[], holes: Vec2[][], w: number, h: number, res: number, pad: number): Mask {
  const inW = Math.max(1, Math.ceil(w / res));
  const inH = Math.max(1, Math.ceil(h / res));
  const mw = inW + 2 * pad;
  const mh = inH + 2 * pad;
  const grid = new Uint8Array(mw * mh);
  const rings = [outer, ...holes];

  // Even-odd scanline fill. Row cy maps to polygon y = (cy - pad + 0.5)*res.
  for (let cy = 0; cy < mh; cy++) {
    const py = (cy - pad + 0.5) * res;
    const xs: number[] = [];
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % ring.length];
        // Half-open edge test avoids double-counting shared vertices.
        if ((y1 <= py && y2 > py) || (y2 <= py && y1 > py)) {
          const t = (py - y1) / (y2 - y1);
          xs.push(x1 + t * (x2 - x1));
        }
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = xs[k];
      const xb = xs[k + 1];
      const cxa = Math.max(0, Math.floor(xa / res) + pad);
      const cxb = Math.min(mw - 1, Math.ceil(xb / res) + pad);
      for (let cx = cxa; cx <= cxb; cx++) {
        const px = (cx - pad + 0.5) * res;
        if (px >= xa && px < xb) grid[cy * mw + cx] = 1;
      }
    }
  }

  const filled = pad > 0 ? dilate(grid, mw, mh, pad) : grid;

  // Collect occupied offsets and the actual occupied bounds. We TRIM the mask
  // to those bounds: ceil(w/res) can round the mask up to one cell wider than
  // the grid's floor(sheet/res), which would spuriously reject a part that is
  // the full sheet size. Trimming the trailing empty columns/rows fixes that
  // while leaving the kerf halo (which is occupied after dilation) intact.
  let count = 0, maxCx = 0, maxCy = 0;
  for (let cy = 0; cy < mh; cy++) {
    for (let cx = 0; cx < mw; cx++) {
      if (filled[cy * mw + cx]) {
        count++;
        if (cx > maxCx) maxCx = cx;
        if (cy > maxCy) maxCy = cy;
      }
    }
  }
  const cells = new Int32Array(count * 2);
  let j = 0;
  for (let cy = 0; cy < mh; cy++) {
    for (let cx = 0; cx < mw; cx++) {
      if (filled[cy * mw + cx]) {
        cells[j++] = cx;
        cells[j++] = cy;
      }
    }
  }
  const trimW = count > 0 ? maxCx + 1 : 1;
  const trimH = count > 0 ? maxCy + 1 : 1;
  return { cells, mw: trimW, mh: trimH, pad, outer, holes, w, h };
}

/** Square morphological dilation by radius `r` (separable max filter). */
function dilate(grid: Uint8Array, mw: number, mh: number, r: number): Uint8Array {
  const tmp = new Uint8Array(mw * mh);
  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      let v = 0;
      const lo = Math.max(0, x - r);
      const hi = Math.min(mw - 1, x + r);
      for (let xx = lo; xx <= hi; xx++) {
        if (grid[y * mw + xx]) { v = 1; break; }
      }
      tmp[y * mw + x] = v;
    }
  }
  const out = new Uint8Array(mw * mh);
  for (let y = 0; y < mh; y++) {
    const lo = Math.max(0, y - r);
    const hi = Math.min(mh - 1, y + r);
    for (let x = 0; x < mw; x++) {
      let v = 0;
      for (let yy = lo; yy <= hi; yy++) {
        if (tmp[yy * mw + x]) { v = 1; break; }
      }
      out[y * mw + x] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-sheet occupancy grid + summed-area table
// ---------------------------------------------------------------------------
class SheetGrid {
  gw: number;
  gh: number;
  occ: Uint8Array;
  private sat: Int32Array;
  private satW: number;
  private dirty = false;

  constructor(gw: number, gh: number) {
    this.gw = gw;
    this.gh = gh;
    this.occ = new Uint8Array(gw * gh);
    this.satW = gw + 1;
    this.sat = new Int32Array(this.satW * (gh + 1));
  }

  private rebuildSat() {
    const { gw, gh, occ, satW, sat } = this;
    sat.fill(0);
    for (let y = 0; y < gh; y++) {
      let rowSum = 0;
      const above = y * satW;
      const cur = (y + 1) * satW;
      for (let x = 0; x < gw; x++) {
        rowSum += occ[y * gw + x];
        sat[cur + x + 1] = sat[above + x + 1] + rowSum;
      }
    }
    this.dirty = false;
  }

  /** Sum of occupancy over the half-open window [x0,x1)×[y0,y1). */
  private windowSum(x0: number, y0: number, x1: number, y1: number): number {
    if (this.dirty) this.rebuildSat();
    const w = this.satW;
    return (
      this.sat[y1 * w + x1] -
      this.sat[y0 * w + x1] -
      this.sat[y1 * w + x0] +
      this.sat[y0 * w + x0]
    );
  }

  /**
   * Bottom-left search for a mask. Returns the lowest-then-leftmost cell
   * (gx,gy) where every occupied mask cell lands on a free grid cell, or null.
   */
  findBottomLeft(mask: Mask): { gx: number; gy: number } | null {
    const { gw, gh, occ } = this;
    const { mw, mh, cells } = mask;
    if (mw > gw || mh > gh) return null;
    const maxY = gh - mh;
    const maxX = gw - mw;
    for (let gy = 0; gy <= maxY; gy++) {
      for (let gx = 0; gx <= maxX; gx++) {
        // O(1) reject/accept: if the whole window is empty, the mask fits.
        if (this.windowSum(gx, gy, gx + mw, gy + mh) === 0) {
          return { gx, gy };
        }
        // Window has some occupancy — test the exact mask cells.
        let ok = true;
        for (let i = 0; i < cells.length; i += 2) {
          if (occ[(gy + cells[i + 1]) * gw + (gx + cells[i])]) { ok = false; break; }
        }
        if (ok) return { gx, gy };
      }
    }
    return null;
  }

  /** Mark a placed mask as occupied. */
  commit(mask: Mask, gx: number, gy: number) {
    const { gw, occ } = this;
    const { cells } = mask;
    for (let i = 0; i < cells.length; i += 2) {
      occ[(gy + cells[i + 1]) * gw + (gx + cells[i])] = 1;
    }
    this.dirty = true;
  }

  /**
   * Largest empty axis-aligned rectangle in the free space (maximal-rectangle
   * via per-column histograms). Returns its size in CELLS, or null if full.
   */
  largestEmptyRect(): { w: number; h: number } | null {
    const { gw, gh, occ } = this;
    const heights = new Int32Array(gw);
    let best = 0, bestW = 0, bestH = 0;
    const stack: number[] = [];
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        heights[x] = occ[y * gw + x] ? 0 : heights[x] + 1;
      }
      // Largest rectangle in this histogram row.
      stack.length = 0;
      for (let x = 0; x <= gw; x++) {
        const h = x === gw ? 0 : heights[x];
        while (stack.length && heights[stack[stack.length - 1]] >= h) {
          const top = stack.pop()!;
          const height = heights[top];
          const width = stack.length ? x - stack[stack.length - 1] - 1 : x;
          const area = height * width;
          if (area > best) { best = area; bestW = width; bestH = height; }
        }
        stack.push(x);
      }
    }
    return best > 0 ? { w: bestW, h: bestH } : null;
  }
}

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------
export interface CncOptions {
  /** Target number of grid cells along the sheet's long axis (tightness). */
  targetCells?: number;
  /** Hard cap on total grid cells (perf guard). */
  maxCells?: number;
}

function chooseResolution(sheetW: number, sheetH: number, opt: CncOptions): number {
  const long = Math.max(sheetW, sheetH);
  const target = opt.targetCells ?? 280;
  let res = Math.min(25, Math.max(2, long / target));
  const cap = opt.maxCells ?? 90000;
  // Bump resolution until the grid fits under the cell cap.
  while ((Math.ceil(sheetW / res) + 1) * (Math.ceil(sheetH / res) + 1) > cap) {
    res *= 1.15;
  }
  return res;
}

/**
 * Core packer as a generator so the sync and animated drivers share one
 * implementation. Yields a CncProgress snapshot after each placement and
 * returns the final CncResult.
 */
export function* packCncGen(
  items: CncInput[],
  sheetW: number,
  sheetH: number,
  kerf: number,
  opt: CncOptions = {},
): Generator<CncProgress, CncResult, void> {
  const res = chooseResolution(sheetW, sheetH, opt);
  const pad = kerf > 0 ? Math.max(1, Math.round(kerf / res)) : 0;
  const gw = Math.floor(sheetW / res);
  const gh = Math.floor(sheetH / res);

  // Largest parts first — the standard first-fit-decreasing heuristic.
  const order = items.slice().sort((a, b) => b.area - a.area);

  // Mask cache keyed by geometry + angle (instances of a part share geometry).
  const maskCache = new Map<string, Mask>();
  const getMask = (it: CncInput, deg: number): Mask => {
    const key = `${it.geoKey}@${deg}`;
    let m = maskCache.get(key);
    if (!m) {
      const r = rotateAnchor(it.outer, it.holes, deg);
      m = buildMask(r.outer, r.holes, r.w, r.h, res, pad);
      maskCache.set(key, m);
    }
    return m;
  };

  const grids: SheetGrid[] = [];
  const sheets: CncSheet[] = [];
  const unplaced: string[] = [];
  const total = items.length;
  let placed = 0;
  // Cap the number of progress snapshots so replay frames / snapshot copies
  // stay O(total) rather than O(total²) on very large jobs.
  const yieldStep = Math.max(1, Math.floor(total / 120));

  const snapshot = (): CncSheet[] =>
    sheets.map((s) => ({
      placements: s.placements.slice(),
      usedArea: s.usedArea,
      largestFree: s.largestFree,
    }));

  const tryPlaceOnSheet = (grid: SheetGrid, sheet: CncSheet, it: CncInput): boolean => {
    // Across candidate angles, keep the lowest (then leftmost) placement.
    let best: { mask: Mask; gx: number; gy: number; deg: number } | null = null;
    for (const deg of it.angles) {
      const mask = getMask(it, deg);
      const spot = grid.findBottomLeft(mask);
      if (!spot) continue;
      if (
        !best ||
        spot.gy < best.gy ||
        (spot.gy === best.gy && spot.gx < best.gx)
      ) {
        best = { mask, gx: spot.gx, gy: spot.gy, deg };
        if (spot.gy === 0 && spot.gx === 0) break; // can't beat origin
      }
    }
    if (!best) return false;
    grid.commit(best.mask, best.gx, best.gy);
    const m = best.mask;
    sheet.placements.push({
      id: it.id,
      angleDeg: best.deg,
      x: (best.gx + m.pad) * res,
      y: (best.gy + m.pad) * res,
      w: m.w,
      h: m.h,
      outer: m.outer,
      holes: m.holes,
      area: it.area,
    });
    sheet.usedArea += it.area;
    return true;
  };

  for (const it of order) {
    let done = false;
    // First-fit across existing sheets (oldest first) so holes / leftover
    // pockets on earlier sheets get reused before opening fresh stock.
    for (let s = 0; s < grids.length; s++) {
      if (tryPlaceOnSheet(grids[s], sheets[s], it)) { done = true; break; }
    }
    if (!done) {
      const grid = new SheetGrid(gw, gh);
      const sheet: CncSheet = { placements: [], usedArea: 0, largestFree: null };
      if (tryPlaceOnSheet(grid, sheet, it)) {
        grids.push(grid);
        sheets.push(sheet);
        done = true;
      } else {
        // Doesn't fit even an empty sheet (too big at every angle).
        unplaced.push(it.id);
      }
    }
    if (done) placed++;
    if (placed % yieldStep === 0 || placed === total) {
      yield { placed, total, sheets: snapshot() };
    }
  }

  // Finalise per-sheet largest offcut (in mm).
  for (let s = 0; s < grids.length; s++) {
    const r = grids[s].largestEmptyRect();
    sheets[s].largestFree = r ? { w: r.w * res, h: r.h * res } : null;
  }

  return { sheets, unplaced };
}

/** Synchronous driver — drains the generator. */
export function packCnc(
  items: CncInput[],
  sheetW: number,
  sheetH: number,
  kerf: number,
  opt: CncOptions = {},
): CncResult {
  const gen = packCncGen(items, sheetW, sheetH, kerf, opt);
  let step = gen.next();
  while (!step.done) step = gen.next();
  return step.value;
}

/**
 * Animated driver — reports progress and yields to the event loop so the UI
 * can repaint while a large nest is computed.
 */
export async function packCncAnimated(
  items: CncInput[],
  sheetW: number,
  sheetH: number,
  kerf: number,
  onProgress: (p: CncProgress) => void | Promise<void>,
  opt: CncOptions = {},
  yieldEvery = 3,
): Promise<CncResult> {
  const gen = packCncGen(items, sheetW, sheetH, kerf, opt);
  let step = gen.next();
  let i = 0;
  while (!step.done) {
    await onProgress(step.value);
    if (i++ % yieldEvery === 0) await new Promise<void>((r) => setTimeout(r, 0));
    step = gen.next();
  }
  return step.value;
}
