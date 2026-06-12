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
  /** Restart index (0-based). */
  trial: number;
  /** Total restarts that will run. */
  total: number;
  /** Sheets produced by THIS restart (placements copied — safe to keep). */
  current: CncSheet[];
  /** Best (fewest-sheets) layout seen so far. */
  best: CncSheet[];
  /** True iff this restart became the new best. */
  isNewBest: boolean;
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
  /** SOLID cell offsets (dx,dy interleaved) in [0,mw)×[0,mh) — the part itself.
   *  Used for collision tests and placement, so a part as large as the sheet
   *  still fits (kerf spacing is NOT enforced against the sheet edge). */
  cells: Int32Array;
  mw: number;
  mh: number;
  /** DILATED (solid ⊕ kerf) cell offsets, relative to the solid origin (may be
   *  negative). Marked occupied when the part is placed so the NEXT part keeps
   *  a kerf gap; clipped at the sheet edge by the grid. */
  markCells: Int32Array;
  /** Offsets of cells just OUTSIDE the solid (its 4-neighbour fringe, may be
   *  negative / beyond mw,mh). Used by the touching-perimeter placement
   *  score: a fringe cell landing on occupied stock or past the sheet edge
   *  counts as contact. */
  rim: Int32Array;
  /** Rotated+anchored polygon for this angle (origin at 0,0). */
  outer: Vec2[];
  holes: Vec2[][];
  /** True AABB dims of the polygon (mm). */
  w: number;
  h: number;
}

/**
 * Douglas-Peucker simplification of a CLOSED ring. Used ONLY for the raster
 * masks — placements and exports keep the exact fine-tessellated contour
 * (low-quality polylines for optimisation, full quality in the result). At a
 * ~5–8 mm cell size a 0.1 mm-faithful outline is wasted precision: the
 * conservative rasteriser swallows deviations far below one cell anyway.
 */
function simplifyRing(ring: Vec2[], tol: number): Vec2[] {
  const n = ring.length;
  if (tol <= 0 || n <= 16) return ring;
  const keep = new Uint8Array(n);
  // Anchor at two extreme points so the closed ring becomes two open chains.
  let iMin = 0, iMax = 0;
  for (let i = 1; i < n; i++) {
    if (ring[i][0] < ring[iMin][0]) iMin = i;
    if (ring[i][0] > ring[iMax][0]) iMax = i;
  }
  if (iMin === iMax) return ring; // degenerate
  keep[iMin] = keep[iMax] = 1;
  const tol2 = tol * tol;
  // Iterative DP over the index range [a..b] (wrapping), stack-based.
  const stack: [number, number][] = [[iMin, iMax], [iMax, iMin + n]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const [ax, ay] = ring[a % n];
    const [bx, by] = ring[b % n];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-12;
    let worst = -1, worstD = tol2;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = ring[i % n];
      // Perpendicular distance² from the chord (segment-clamped).
      let t = ((px - ax) * dx + (py - ay) * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = px - (ax + t * dx), ey = py - (ay + t * dy);
      const d2 = ex * ex + ey * ey;
      if (d2 > worstD) { worstD = d2; worst = i; }
    }
    if (worst >= 0) {
      keep[worst % n] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(ring[i]);
  return out.length >= 3 ? out : ring;
}

/** Even-odd scanline: sorted x-intersections of (rings) at height py. */
function scanlineX(rings: Vec2[][], py: number): number[] {
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
  xs.sort((a, b) => a - b);
  return xs;
}

/**
 * CONSERVATIVE rasterisation of (outer − holes) into a sw×sh-cell grid: a cell
 * is marked if the polygon overlaps ANY of it. We sample several scanlines
 * across each cell's height and mark every cell the resulting x-spans touch.
 *
 * Why conservative (over-approximate) rather than centre-sampling: a rotated
 * edge can poke a thin sliver into a cell whose CENTRE is outside the polygon;
 * if that cell is left free, two parts' slivers can interpenetrate (a real
 * overlap the cell test misses). Marking every overlapped cell prevents that.
 * For grid-aligned parts whose dimensions are multiples of the cell size this
 * is still exact, so perfect tilings (e.g. identical rectangles) are preserved.
 */
function rasterSolid(outer: Vec2[], holes: Vec2[][], res: number, sw: number, sh: number): Uint8Array {
  const grid = new Uint8Array(sw * sh);
  const rings = [outer, ...holes];
  const SUB = 3; // scanlines per cell height (bottom, thirds, top)
  for (let cy = 0; cy < sh; cy++) {
    const yBase = cy * res;
    const row = cy * sw;
    for (let s = 0; s <= SUB; s++) {
      const py = yBase + (res * s) / SUB;
      const xs = scanlineX(rings, py);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const cxa = Math.max(0, Math.floor(xs[k] / res));
        const cxb = Math.min(sw - 1, Math.ceil(xs[k + 1] / res) - 1);
        for (let cx = cxa; cx <= cxb; cx++) grid[row + cx] = 1;
      }
    }
  }
  return grid;
}

/**
 * Build a placement mask for a rotated polygon. The SOLID (used for collision)
 * is the rasterised silhouette; the MARK set is the solid dilated by `pad`
 * cells (≈ kerf) and is what we stamp into the sheet so the next part keeps a
 * gap. Keeping these separate means a full-sheet-sized part still fits — the
 * kerf halo only applies between parts, not against the sheet edge.
 */
function buildMask(outer: Vec2[], holes: Vec2[][], w: number, h: number, res: number, pad: number): Mask {
  const sw = Math.max(1, Math.ceil(w / res));
  const sh = Math.max(1, Math.ceil(h / res));
  // Raster from a simplified copy of the rings: collision quality is bounded
  // by the cell size, not the curve tessellation. The EXACT rings still go
  // into the returned Mask (and from there into placements / exports).
  const tol = Math.min(0.5, res / 6);
  const sOuter = simplifyRing(outer, tol);
  const sHoles = holes.map((hh) => simplifyRing(hh, tol));
  const solid = rasterSolid(sOuter, sHoles, res, sw, sh);

  // Solid offsets (collision/placement), BOUNDARY cells first: a collision
  // almost always shows up at the mask's rim, so testing rim cells first
  // lets findBottomLeft reject crowded positions in a handful of probes.
  // The outward 4-neighbour fringe is collected alongside for the
  // touching-perimeter score.
  const cells: number[] = [];
  const inner: number[] = [];
  const fringe = new Set<number>();
  const solidAt = (cx: number, cy: number) =>
    cx >= 0 && cx < sw && cy >= 0 && cy < sh && solid[cy * sw + cx] === 1;
  for (let cy = 0; cy < sh; cy++) {
    for (let cx = 0; cx < sw; cx++) {
      if (!solid[cy * sw + cx]) continue;
      let isRim = false;
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        if (!solidAt(cx + dx, cy + dy)) {
          isRim = true;
          // Key with an offset so negative coords pack into one integer.
          fringe.add((cy + dy + 2) * (sw + 4) + (cx + dx + 2));
        }
      }
      if (isRim) cells.push(cx, cy);
      else inner.push(cx, cy);
    }
  }
  for (let i = 0; i < inner.length; i++) cells.push(inner[i]);
  const rim: number[] = [];
  for (const k of fringe) {
    rim.push((k % (sw + 4)) - 2, Math.floor(k / (sw + 4)) - 2);
  }

  // Mark offsets (solid dilated by the kerf halo), relative to the solid origin.
  let markCells: number[];
  if (pad > 0) {
    const pw = sw + 2 * pad, ph = sh + 2 * pad;
    const padded = new Uint8Array(pw * ph);
    for (let i = 0; i < cells.length; i += 2) {
      padded[(cells[i + 1] + pad) * pw + (cells[i] + pad)] = 1;
    }
    const dil = dilate(padded, pw, ph, pad);
    markCells = [];
    for (let cy = 0; cy < ph; cy++)
      for (let cx = 0; cx < pw; cx++)
        if (dil[cy * pw + cx]) markCells.push(cx - pad, cy - pad);
  } else {
    markCells = cells;
  }

  return {
    cells: Int32Array.from(cells),
    mw: sw,
    mh: sh,
    markCells: markCells === cells ? Int32Array.from(cells) : Int32Array.from(markCells),
    rim: Int32Array.from(rim),
    outer, holes, w, h,
  };
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
  /** Number of occupied cells — lets callers cheaply reject obviously-full sheets. */
  occupiedCount = 0;
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

  /** Free cell count. */
  freeCells(): number { return this.gw * this.gh - this.occupiedCount; }

  /**
   * Scan-resume cursors, keyed by mask identity + scan order. Occupancy is
   * MONOTONIC — cells are only ever marked, never cleared — so once a scan
   * position is proven infeasible for a given mask it stays infeasible for
   * the life of this grid. The cursor records how many scan positions are
   * already disproven; the next search for the same mask resumes there.
   * Duplicate instances of a part (the common "qty" case) each skip all the
   * scanning their predecessors already paid for.
   */
  private cursors = new Map<string, number>();

  /** Deep copy (occupancy only; SAT is rebuilt lazily on first query). */
  clone(): SheetGrid {
    const g = new SheetGrid(this.gw, this.gh);
    g.occ.set(this.occ);
    g.occupiedCount = this.occupiedCount;
    g.dirty = true;
    g.cursors = new Map(this.cursors);
    return g;
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
   * Bottom-left search for a mask. Returns the first feasible cell (gx,gy)
   * where every occupied mask cell lands on a free grid cell, or null.
   * Scan order: bottom-first (lowest gy, then gx) by default, or left-first
   * (lowest gx, then gy) when `leftFirst` — the two orders produce different
   * layouts, which the multi-restart optimiser exploits.
   *
   * `key` (mask identity, e.g. 'geo@deg') enables the monotonic resume
   * cursor: scanning restarts where the previous search for the same mask
   * left off instead of at the origin. Pass a stable key or omit for a full
   * scan. Per position the test is: O(1) accept (window empty), O(1) reject
   * (window has fewer free cells than the mask needs), else the cell loop —
   * whose boundary-first ordering fails fast on partial overlaps.
   */
  findBottomLeft(mask: Mask, leftFirst = false, key?: string): { gx: number; gy: number } | null {
    const c = this.findCandidates(mask, leftFirst, key, 1, 0);
    return c.length > 0 ? { gx: c[0].gx, gy: c[0].gy } : null;
  }

  /**
   * Collect up to `maxCand` feasible positions in scan order: the first
   * feasible one, plus any others found within `horizonRows` further
   * rows/columns of the scan. The cursor still records only the PROVEN
   * infeasible prefix (everything before the first feasible position), so
   * resume semantics stay sound regardless of which candidate the caller
   * commits.
   */
  findCandidates(
    mask: Mask,
    leftFirst: boolean,
    key: string | undefined,
    maxCand: number,
    horizonRows: number,
  ): { gx: number; gy: number; i: number }[] {
    const { gw, gh, occ } = this;
    const { mw, mh, cells } = mask;
    if (mw > gw || mh > gh) return [];
    const maxY = gh - mh;
    const maxX = gw - mw;
    const need = cells.length / 2;
    const winArea = mw * mh;
    const fits = (gx: number, gy: number): boolean => {
      const occupied = this.windowSum(gx, gy, gx + mw, gy + mh);
      // O(1) accept: the whole window is empty.
      if (occupied === 0) return true;
      // O(1) reject: not enough free cells left in the window.
      if (winArea - occupied < need) return false;
      for (let i = 0; i < cells.length; i += 2) {
        if (occ[(gy + cells[i + 1]) * gw + (gx + cells[i])]) return false;
      }
      return true;
    };

    // Resume after the last infeasible prefix for this mask + scan order.
    const ck = key ? `${key}${leftFirst ? '|L' : '|B'}` : null;
    const start = ck ? (this.cursors.get(ck) ?? 0) : 0;
    const innerMax = leftFirst ? maxY : maxX;
    const rowLen = innerMax + 1;
    const total = (leftFirst ? maxX + 1 : maxY + 1) * rowLen;

    const out: { gx: number; gy: number; i: number }[] = [];
    let stop = total;
    for (let i = start; i < stop; i++) {
      const outer = (i / rowLen) | 0;
      const inner = i - outer * rowLen;
      const gx = leftFirst ? outer : inner;
      const gy = leftFirst ? inner : outer;
      if (fits(gx, gy)) {
        if (out.length === 0) {
          // Position i may be occupied by this very part next — the NEXT
          // search starts here, fails fast on it and moves on.
          if (ck) this.cursors.set(ck, i);
          stop = Math.min(total, i + horizonRows * rowLen + 1);
        }
        out.push({ gx, gy, i });
        if (out.length >= maxCand) return out;
      }
    }
    if (out.length === 0 && ck) this.cursors.set(ck, total);
    return out;
  }

  /**
   * Touching-perimeter score for a mask at (gx,gy): how many of the mask's
   * outward fringe cells land on occupied stock or past the sheet edge.
   * Higher = the part nests snugly against neighbours/edges instead of
   * leaving slivers of unusable space around it.
   */
  contactScore(mask: Mask, gx: number, gy: number): number {
    const { gw, gh, occ } = this;
    const { rim } = mask;
    let score = 0;
    for (let i = 0; i < rim.length; i += 2) {
      const x = gx + rim[i];
      const y = gy + rim[i + 1];
      if (x < 0 || x >= gw || y < 0 || y >= gh || occ[y * gw + x]) score++;
    }
    return score;
  }

  /** Mark a placed part (solid + kerf halo) as occupied, clipped at the edges. */
  commit(mask: Mask, gx: number, gy: number) {
    const { gw, gh, occ } = this;
    const { markCells } = mask;
    for (let i = 0; i < markCells.length; i += 2) {
      const x = gx + markCells[i];
      const y = gy + markCells[i + 1];
      if (x < 0 || x >= gw || y < 0 || y >= gh) continue; // halo past the sheet edge
      const idx = y * gw + x;
      if (!occ[idx]) { occ[idx] = 1; this.occupiedCount++; }
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
  /** Optimiser effort — drives how many orderings/placements are tried. */
  restarts?: number;
  /**
   * "Save last sheet": after minimising sheet count, prefer layouts whose
   * least-filled sheet is as empty as possible, and compact that sheet's parts
   * into one corner so the remaining material is a clean reusable offcut.
   */
  saveLast?: boolean;
  /** Varies the shuffle stream + pass order so a re-run ("Optimize further")
   *  explores NEW orderings. 0 / undefined = the canonical deterministic run. */
  seed?: number;
  /** Doubles the attempt caps — used by "Optimize further" deep searches. */
  extraEffort?: boolean;
}

function chooseResolution(sheetW: number, sheetH: number, opt: CncOptions): number {
  const long = Math.max(sheetW, sheetH);
  // Finer grid = tighter nesting (less quantisation waste, fewer sheets) at
  // the cost of speed. ~300 cells on the long edge (~8 mm on a 4×8) is the
  // single-core default; the multicore pool (optPool.ts) overrides
  // targetCells/maxCells upward since the passes run in parallel.
  const target = opt.targetCells ?? 300;
  let res = Math.min(25, Math.max(1.5, long / target));
  const cap = opt.maxCells ?? 120000;
  // Bump resolution until the grid fits under the cell cap.
  while ((Math.ceil(sheetW / res) + 1) * (Math.ceil(sheetH / res) + 1) > cap) {
    res *= 1.15;
  }
  return res;
}

// ---------------------------------------------------------------------------
// Multi-restart packing with a fewest-sheets objective
//
// A single greedy pass leaves sheets under-filled and uses more stock than
// necessary. We instead try several part orderings + two scan directions and
// keep the layout with the FEWEST sheets, then run a consolidation pass that
// dissolves the least-filled sheet by redistributing its parts onto the
// others — directly minimising sheet count (the goal here).
// ---------------------------------------------------------------------------
interface LiveSheet { grid: SheetGrid; placements: CncPlaced[]; usedArea: number; }
type MaskFn = (it: CncInput, deg: number) => Mask;
interface PassResult { lives: LiveSheet[]; unplaced: string[] }

function cloneLive(s: LiveSheet): LiveSheet {
  return { grid: s.grid.clone(), placements: s.placements.slice(), usedArea: s.usedArea };
}

/**
 * Place one item on a sheet. Two placement policies:
 *   - bottom-left (default): first feasible position in scan order, lowest
 *     across all angles — the classic raster BLF.
 *   - touching-perimeter (`contact`): collect a few feasible candidates per
 *     angle near the scan frontier and commit the one with the highest
 *     contact score (mask fringe against stock/edges). Trades a bit of
 *     "lowness" for snugness — fewer unusable slivers between parts.
 */
function placeOnSheet(
  live: LiveSheet,
  it: CncInput,
  getMask: MaskFn,
  res: number,
  leftFirst: boolean,
  contact = false,
): boolean {
  let best: { mask: Mask; gx: number; gy: number; deg: number; score: number; i: number } | null = null;
  const free = live.grid.freeCells();
  for (const deg of it.angles) {
    const mask = getMask(it, deg);
    if (mask.cells.length / 2 > free) continue; // can't possibly fit — skip cheaply
    const key = `${it.geoKey}@${deg}`;
    if (contact) {
      const cands = live.grid.findCandidates(mask, leftFirst, key, 5, 2);
      for (const c of cands) {
        const score = live.grid.contactScore(mask, c.gx, c.gy);
        if (!best || score > best.score || (score === best.score && c.i < best.i)) {
          best = { mask, gx: c.gx, gy: c.gy, deg, score, i: c.i };
        }
      }
    } else {
      const spot = live.grid.findBottomLeft(mask, leftFirst, key);
      if (!spot) continue;
      const better = !best || (leftFirst
        ? (spot.gx < best.gx || (spot.gx === best.gx && spot.gy < best.gy))
        : (spot.gy < best.gy || (spot.gy === best.gy && spot.gx < best.gx)));
      if (better) {
        best = { mask, gx: spot.gx, gy: spot.gy, deg, score: 0, i: 0 };
        if (spot.gx === 0 && spot.gy === 0) break; // origin — can't do better
      }
    }
  }
  if (!best) return false;
  live.grid.commit(best.mask, best.gx, best.gy);
  const m = best.mask;
  live.placements.push({
    id: it.id, angleDeg: best.deg,
    x: best.gx * res, y: best.gy * res,
    w: m.w, h: m.h, outer: m.outer, holes: m.holes, area: it.area,
  });
  live.usedArea += it.area;
  return true;
}

/** One full greedy pass over a given order. First-fit across existing sheets
 *  (oldest first, so earlier sheets fill before new stock opens). */
function runPass(
  order: CncInput[],
  gw: number,
  gh: number,
  getMask: MaskFn,
  res: number,
  leftFirst: boolean,
  contact = false,
): PassResult {
  const lives: LiveSheet[] = [];
  const unplaced: string[] = [];
  for (const it of order) {
    let done = false;
    for (const live of lives) {
      if (placeOnSheet(live, it, getMask, res, leftFirst, contact)) { done = true; break; }
    }
    if (!done) {
      const live: LiveSheet = { grid: new SheetGrid(gw, gh), placements: [], usedArea: 0 };
      if (placeOnSheet(live, it, getMask, res, leftFirst, contact)) lives.push(live);
      else unplaced.push(it.id);
    }
  }
  return { lives, unplaced };
}

/** Used area of the least-filled sheet (the "last" / remnant sheet), or 0. */
function leastFilledArea(lives: LiveSheet[]): number {
  if (lives.length === 0) return 0;
  let min = Infinity;
  for (const l of lives) if (l.usedArea < min) min = l.usedArea;
  return min;
}

/**
 * Fewer unplaced → fewer sheets → more material used.
 * Under `saveLast`, once sheet count ties, prefer the layout whose least-filled
 * sheet holds the LEAST material — concentrating leftovers so the final sheet's
 * remnant is the largest, cleanest reusable offcut.
 */
function passBetter(a: PassResult, b: PassResult, saveLast = false): boolean {
  if (a.unplaced.length !== b.unplaced.length) return a.unplaced.length < b.unplaced.length;
  if (a.lives.length !== b.lives.length) return a.lives.length < b.lives.length;
  if (saveLast && a.lives.length > 1) {
    const la = leastFilledArea(a.lives), lb = leastFilledArea(b.lives);
    if (Math.abs(la - lb) > 1e-6) return la < lb;
  }
  const ua = a.lives.reduce((s, l) => s + l.usedArea, 0);
  const ub = b.lives.reduce((s, l) => s + l.usedArea, 0);
  return ua > ub;
}

/**
 * Dissolve sheets: repeatedly take the least-filled sheet and try to re-place
 * ALL of its parts onto the other sheets (on cloned grids, so a failure rolls
 * back). If they all fit, drop that sheet. This is what catches "this part
 * could go on another sheet" and lowers the sheet count.
 */
function consolidate(lives: LiveSheet[], getMask: MaskFn, res: number, byId: Map<string, CncInput>): LiveSheet[] {
  let working = lives;
  let improved = true;
  let guard = 0;
  // Failed dissolve attempts are pure cost, so the widened search (several
  // victim candidates × two scan directions) runs under a wall-clock budget.
  const startMs = Date.now();
  const budgetMs = 4000;
  const VICTIM_CANDIDATES = 3;

  // Try to re-place every part of `victim` onto clones of the other sheets.
  // Returns the new sheet list on success, null when something didn't fit.
  const tryDissolve = (vi: number, leftFirst: boolean, byLongSide: boolean): LiveSheet[] | null => {
    const victim = working[vi];
    const clones = working.filter((_, i) => i !== vi).map(cloneLive);
    // Hardest pieces placed while space is freest — "hard" judged by area
    // or by longest side (a long skinny part can be harder than a big one).
    const parts = victim.placements.slice().sort((a, b) => byLongSide
      ? Math.max(b.w, b.h) - Math.max(a.w, a.h)
      : b.area - a.area);
    for (const p of parts) {
      const it = byId.get(p.id);
      if (!it) return null;
      let placed = false;
      for (const c of clones) {
        if (placeOnSheet(c, it, getMask, res, leftFirst)) { placed = true; break; }
      }
      if (!placed) return null;
    }
    return clones;
  };

  while (improved && working.length > 1 && guard++ < lives.length + 4) {
    improved = false;
    // Victim candidates in fill-ascending order — emptiest sheets are the
    // cheapest to absorb, but a slightly fuller one sometimes dissolves when
    // the emptiest holds one awkward part that fits nowhere else.
    const victims = working
      .map((_, i) => i)
      .sort((a, b) => working[a].usedArea - working[b].usedArea)
      .slice(0, VICTIM_CANDIDATES);
    outer: for (const vi of victims) {
      for (const leftFirst of [false, true]) {
        for (const byLongSide of [false, true]) {
          if (Date.now() - startMs > budgetMs) break outer;
          const dissolved = tryDissolve(vi, leftFirst, byLongSide);
          if (dissolved) { working = dissolved; improved = true; break outer; }
        }
      }
    }
  }
  return working;
}

/**
 * Compact the least-filled ("last") sheet: re-pack its parts from scratch with
 * a bottom-left fill (largest first) so they cluster in one corner, leaving the
 * remaining material as a single clean offcut. Only mutates that one sheet and
 * only if every part still fits; otherwise the original layout is kept.
 */
/**
 * "Shake" defragmentation: re-pack EVERY sheet's own parts from scratch
 * (largest first, bottom-left) so each layout compacts toward the origin.
 * Pockets and slivers scattered by greedy insertion merge into one
 * contiguous free region per sheet — which is exactly what the following
 * consolidation round needs to dissolve an under-filled sheet. A sheet
 * whose re-pack fails (rare: BL ordering differs) keeps its layout.
 */
function shakeSheets(
  lives: LiveSheet[],
  gw: number,
  gh: number,
  getMask: MaskFn,
  res: number,
  byId: Map<string, CncInput>,
): LiveSheet[] {
  return lives.map((live) => {
    const parts = live.placements.slice().sort((a, b) => b.area - a.area);
    const fresh: LiveSheet = { grid: new SheetGrid(gw, gh), placements: [], usedArea: 0 };
    for (const p of parts) {
      const it = byId.get(p.id);
      if (!it || !placeOnSheet(fresh, it, getMask, res, false)) return live;
    }
    return fresh;
  });
}

/**
 * Post-search squeeze shared by the generator and the worker-pool finisher:
 * alternate shake (per-sheet defrag) and consolidation (dissolve the
 * least-filled sheet into the others) until neither changes the sheet
 * count, then optionally corner-pack the last sheet for save-last.
 */
function finalSqueeze(
  lives: LiveSheet[],
  gw: number,
  gh: number,
  getMask: MaskFn,
  res: number,
  byId: Map<string, CncInput>,
  saveLast: boolean,
): LiveSheet[] {
  let working = consolidate(lives, getMask, res, byId);
  for (let round = 0; round < 2; round++) {
    const shaken = shakeSheets(working, gw, gh, getMask, res, byId);
    const after = consolidate(shaken, getMask, res, byId);
    if (after.length >= working.length) {
      // No sheet saved this round. Keep the shaken layout only if it kept
      // the same count (it's denser per sheet); then stop.
      if (after.length === working.length) working = after;
      break;
    }
    working = after;
  }
  if (saveLast) working = compactLastSheet(working, gw, gh, getMask, res, byId);
  return working;
}

function compactLastSheet(
  lives: LiveSheet[], gw: number, gh: number, getMask: MaskFn, res: number, byId: Map<string, CncInput>,
): LiveSheet[] {
  if (lives.length === 0) return lives;
  let vi = 0;
  for (let i = 1; i < lives.length; i++) if (lives[i].usedArea < lives[vi].usedArea) vi = i;
  const victim = lives[vi];
  const parts = victim.placements.slice().sort((a, b) => b.area - a.area);
  const fresh: LiveSheet = { grid: new SheetGrid(gw, gh), placements: [], usedArea: 0 };
  for (const p of parts) {
    const it = byId.get(p.id);
    if (!it) return lives; // can't recover geometry — leave as-is
    if (!placeOnSheet(fresh, it, getMask, res, false)) return lives; // didn't fit — bail
  }
  return lives.map((l, i) => (i === vi ? fresh : l));
}

function bbox0(outer: Vec2[]): { w: number; h: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of outer) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  return { w: maxX - minX, h: maxY - minY };
}

interface Ordering { order: CncInput[]; leftFirst: boolean; contact: boolean }

/** Candidate (ordering × scan-direction × placement-policy) restarts, capped
 *  to `passes`. `seed` varies the shuffle stream so a re-run ("Optimize
 *  further") explores NEW orderings instead of repeating the same search. */
function buildOrderings(items: CncInput[], passes: number, seed = 0): Ordering[] {
  const dims = new Map<string, { w: number; h: number }>();
  for (const it of items) if (!dims.has(it.geoKey)) dims.set(it.geoKey, bbox0(it.outer));
  const d = (it: CncInput) => dims.get(it.geoKey)!;
  const sorted = (cmp: (a: CncInput, b: CncInput) => number) => items.slice().sort(cmp);
  const byArea = (a: CncInput, b: CncInput) => b.area - a.area;
  const byLong = (a: CncInput, b: CncInput) => Math.max(d(b).w, d(b).h) - Math.max(d(a).w, d(a).h);
  const byShort = (a: CncInput, b: CncInput) => Math.min(d(b).w, d(b).h) - Math.min(d(a).w, d(a).h);
  const byPerim = (a: CncInput, b: CncInput) => (d(b).w + d(b).h) - (d(a).w + d(a).h);

  const byWide = (a: CncInput, b: CncInput) => d(b).w - d(a).w;
  const byTall = (a: CncInput, b: CncInput) => d(b).h - d(a).h;

  // Big-small interleave: largest, smallest, 2nd largest, … — small parts
  // get placed while big neighbours still leave pockets to tuck into.
  const interleave = (): CncInput[] => {
    const s = sorted(byArea);
    const mixed: CncInput[] = [];
    for (let lo = 0, hi = s.length - 1; lo <= hi; lo++, hi--) {
      mixed.push(s[lo]);
      if (lo !== hi) mixed.push(s[hi]);
    }
    return mixed;
  };

  const base: { order: CncInput[]; leftFirst: boolean }[] = [
    { order: sorted(byArea), leftFirst: false },
    { order: sorted(byArea), leftFirst: true },
    { order: sorted(byLong), leftFirst: false },
    { order: sorted(byShort), leftFirst: false },
    { order: sorted(byPerim), leftFirst: false },
    { order: sorted(byLong), leftFirst: true },
    { order: sorted(byWide), leftFirst: false },
    { order: sorted(byTall), leftFirst: true },
    { order: interleave(), leftFirst: false },
    { order: interleave(), leftFirst: true },
    { order: sorted(byPerim), leftFirst: true },
    { order: sorted(byShort), leftFirst: true },
  ];
  // Every base entry runs under BOTH placement policies: bottom-left-fill
  // and touching-perimeter. Neither dominates — BL wins on rectangular
  // mixes, contact wins when irregular parts leave pockets.
  const out: Ordering[] = [];
  for (const b of base) out.push({ ...b, contact: false });
  for (const b of base) out.push({ ...b, contact: true });
  // Deterministic shuffles fill any remaining budget (reproducible runs;
  // `seed` shifts the stream for re-runs).
  let s = (0x9e3779b1 ^ Math.imul(seed + 1, 0x85ebca6b)) >>> 0;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; };
  while (out.length < passes) {
    const sh = sorted(byArea);
    for (let k = sh.length - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); [sh[k], sh[j]] = [sh[j], sh[k]]; }
    out.push({ order: sh, leftFirst: out.length % 2 === 1, contact: out.length % 4 >= 2 });
  }
  // A nonzero seed ALSO reorders the deterministic prefix so a re-run's
  // budget isn't spent on the exact same passes.
  if (seed !== 0) {
    for (let k = out.length - 1; k > 0; k--) {
      const j = Math.floor(rand() * (k + 1));
      [out[k], out[j]] = [out[j], out[k]];
    }
  }
  return out.slice(0, Math.max(1, passes));
}

function livesToSheets(lives: LiveSheet[], res: number, withFree: boolean): CncSheet[] {
  return lives.map((l) => {
    let largestFree: { w: number; h: number } | null = null;
    if (withFree) {
      const r = l.grid.largestEmptyRect();
      largestFree = r ? { w: r.w * res, h: r.h * res } : null;
    }
    return { placements: l.placements.slice(), usedArea: l.usedArea, largestFree };
  });
}

/** Optimiser pass budget: follows "Optimize tries" but capped by part count
 *  (each pass is a full raster re-pack). Shared by the generator and the
 *  worker pool so both build the SAME deterministic ordering list. The caps
 *  assume the multicore pool (optPool.ts) — the sequential generator also
 *  carries a hard wall-clock budget that bails out of excess passes. */
export function cncAttemptCount(nItems: number, restarts: number, extraEffort = false): number {
  const boost = extraEffort ? 2 : 1;
  const cap = (nItems <= 12 ? 96 : nItems <= 25 ? 48 : nItems <= 50 ? 24 : 10) * boost;
  // A job with few parts only HAS n!·2·2 distinct (ordering × scan-direction
  // × placement-policy) passes — beyond that re-runs identical layouts.
  let perms = 4;
  for (let i = 2; i <= Math.min(nItems, 8); i++) perms *= i;
  const distinct = nItems > 8 ? Infinity : perms;
  return Math.max(1, Math.min(restarts, cap, distinct));
}

// ---------------------------------------------------------------------------
// Worker-pool entry points. A pass result crosses the thread boundary, so it
// is reduced to plain data (placements + usedArea per sheet); grids and masks
// stay worker-local and are rebuilt where needed.
// ---------------------------------------------------------------------------
export interface CncSerialSheet { placements: CncPlaced[]; usedArea: number }
export interface CncSerialPass { sheets: CncSerialSheet[]; unplaced: string[] }

/** Mirror of passBetter for serialized passes (main-thread merge). */
export function serialPassBetter(a: CncSerialPass, b: CncSerialPass, saveLast = false): boolean {
  if (a.unplaced.length !== b.unplaced.length) return a.unplaced.length < b.unplaced.length;
  if (a.sheets.length !== b.sheets.length) return a.sheets.length < b.sheets.length;
  const least = (p: CncSerialPass) => p.sheets.reduce((m, s) => Math.min(m, s.usedArea), Infinity);
  if (saveLast && a.sheets.length > 1) {
    const la = least(a), lb = least(b);
    if (Math.abs(la - lb) > 1e-6) return la < lb;
  }
  const used = (p: CncSerialPass) => p.sheets.reduce((s, sh) => s + sh.usedArea, 0);
  return used(a) > used(b);
}

interface CncSetup { res: number; gw: number; gh: number; getMask: MaskFn; byId: Map<string, CncInput> }

function setupCnc(items: CncInput[], sheetW: number, sheetH: number, kerf: number, opt: CncOptions): CncSetup {
  const res = chooseResolution(sheetW, sheetH, opt);
  const pad = kerf > 0 ? Math.max(1, Math.round(kerf / res)) : 0;
  const maskCache = new Map<string, Mask>();
  const getMask: MaskFn = (it, deg) => {
    const key = `${it.geoKey}@${deg}`;
    let m = maskCache.get(key);
    if (!m) {
      const r = rotateAnchor(it.outer, it.holes, deg);
      m = buildMask(r.outer, r.holes, r.w, r.h, res, pad);
      maskCache.set(key, m);
    }
    return m;
  };
  return {
    res,
    gw: Math.floor(sheetW / res),
    gh: Math.floor(sheetH / res),
    getMask,
    byId: new Map(items.map((it) => [it.id, it] as const)),
  };
}

/**
 * Run a subset of the deterministic ordering list (chosen by index) and
 * report each pass through `onPass`. Workers share nothing — each rebuilds
 * its own mask cache, amortised across the passes it is assigned.
 */
export function cncRunPasses(
  items: CncInput[],
  sheetW: number,
  sheetH: number,
  kerf: number,
  opt: CncOptions,
  attempts: number,
  orderingIdxs: number[],
  onPass: (orderingIdx: number, pass: CncSerialPass) => void,
): void {
  const { res, gw, gh, getMask } = setupCnc(items, sheetW, sheetH, kerf, opt);
  const orderings = buildOrderings(items, attempts, opt.seed ?? 0);
  // Per-worker wall-clock budget: with the raised attempt caps a worker may
  // hold a dozen passes; never let a heavyweight job pin a core for long.
  const startMs = Date.now();
  const budgetMs = 20000;
  for (const idx of orderingIdxs) {
    const o = orderings[idx];
    if (!o) continue;
    const r = runPass(o.order, gw, gh, getMask, res, o.leftFirst, o.contact);
    onPass(idx, {
      sheets: r.lives.map((l) => ({ placements: l.placements, usedArea: l.usedArea })),
      unplaced: r.unplaced,
    });
    if (Date.now() - startMs > budgetMs) break;
  }
}

/** One genome of the Deepnest-style GA: a placement order + pass policy. */
export interface CncOrderSpec { ids: string[]; leftFirst: boolean; contact: boolean }

/**
 * Run passes for EXPLICIT orders (the worker side of the genetic search in
 * optPool.packCncDeep — genomes are placement orders bred between
 * generations, unlike the blind ordering list of cncRunPasses).
 */
export function cncRunExplicitOrders(
  items: CncInput[],
  sheetW: number,
  sheetH: number,
  kerf: number,
  opt: CncOptions,
  orders: CncOrderSpec[],
  onPass: (orderIdx: number, pass: CncSerialPass) => void,
): void {
  const { res, gw, gh, getMask, byId } = setupCnc(items, sheetW, sheetH, kerf, opt);
  const startMs = Date.now();
  const budgetMs = 20000;
  for (let idx = 0; idx < orders.length; idx++) {
    const o = orders[idx];
    const order = o.ids.map((id) => byId.get(id)).filter(Boolean) as CncInput[];
    const r = runPass(order, gw, gh, getMask, res, o.leftFirst, o.contact);
    onPass(idx, {
      sheets: r.lives.map((l) => ({ placements: l.placements, usedArea: l.usedArea })),
      unplaced: r.unplaced,
    });
    if (Date.now() - startMs > budgetMs) break;
  }
}

/**
 * Final squeeze for the pool: rebuild live grids from the winning pass's
 * placements, then run the same consolidation (+ optional save-last
 * compaction) the generator applies, returning display-ready sheets.
 */
export function cncFinish(
  items: CncInput[],
  sheetW: number,
  sheetH: number,
  kerf: number,
  opt: CncOptions,
  winner: CncSerialPass,
): CncResult {
  const { res, gw, gh, getMask, byId } = setupCnc(items, sheetW, sheetH, kerf, opt);
  const lives: LiveSheet[] = winner.sheets.map((sh) => {
    const live: LiveSheet = { grid: new SheetGrid(gw, gh), placements: [], usedArea: 0 };
    for (const p of sh.placements) {
      const it = byId.get(p.id);
      if (!it) continue;
      const mask = getMask(it, p.angleDeg);
      live.grid.commit(mask, Math.round(p.x / res), Math.round(p.y / res));
      live.placements.push(p);
      live.usedArea += p.area;
    }
    return live;
  });
  const squeezed = finalSqueeze(lives, gw, gh, getMask, res, byId, opt.saveLast ?? false);
  return { sheets: livesToSheets(squeezed, res, true), unplaced: winner.unplaced };
}

/**
 * Multi-restart packer as a generator (yields once per restart, then once
 * after consolidation) so the sync and animated drivers share one body.
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

  // Mask cache shared across ALL restarts (masks depend only on geometry,
  // angle, resolution + kerf) — the big perf win that makes restarts affordable.
  const maskCache = new Map<string, Mask>();
  const getMask: MaskFn = (it, deg) => {
    const key = `${it.geoKey}@${deg}`;
    let m = maskCache.get(key);
    if (!m) {
      const r = rotateAnchor(it.outer, it.holes, deg);
      m = buildMask(r.outer, r.holes, r.w, r.h, res, pad);
      maskCache.set(key, m);
    }
    return m;
  };
  const byId = new Map(items.map((it) => [it.id, it] as const));

  // The optimiser tries this many orderings, keeping the fewest-sheets result.
  // It follows the "Optimize tries" setting, but each pass is a full raster
  // re-pack (far heavier than a rectangle trial), so the count is capped by
  // part count to keep wall-clock time sane, and a hard time budget backs that.
  const attempts = cncAttemptCount(items.length, opt.restarts ?? 8, opt.extraEffort ?? false);
  const orderings = buildOrderings(items, attempts, opt.seed ?? 0);
  const totalSteps = orderings.length + 1; // +1 = the consolidation step
  const startMs = Date.now();
  const budgetMs = 15000;

  const saveLast = opt.saveLast ?? false;
  let best: PassResult | null = null;
  for (let i = 0; i < orderings.length; i++) {
    const { order, leftFirst, contact } = orderings[i];
    const result = runPass(order, gw, gh, getMask, res, leftFirst, contact);
    const isNewBest = !best || passBetter(result, best, saveLast);
    if (isNewBest) best = result;
    yield {
      trial: i,
      total: totalSteps,
      current: livesToSheets(result.lives, res, false),
      best: livesToSheets(best!.lives, res, false),
      isNewBest,
    };
    // Safety: bail out of the restart loop if we've blown the time budget.
    // The consolidation step below still runs, so the bar still completes.
    if (Date.now() - startMs > budgetMs) break;
  }

  // Final squeeze: shake-defrag + dissolve under-filled sheets (+ save-last
  // corner packing) — see finalSqueeze.
  const consolidated = finalSqueeze(best!.lives, gw, gh, getMask, res, byId, saveLast);
  const finalSheets = livesToSheets(consolidated, res, true);
  yield {
    trial: orderings.length,
    total: totalSteps,
    current: finalSheets,
    best: finalSheets,
    isNewBest: consolidated.length < best!.lives.length,
  };
  return { sheets: finalSheets, unplaced: best!.unplaced };
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
  yieldEvery = 1, // restarts are coarse-grained — repaint after each
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
