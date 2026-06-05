/**
 * Plywood-sheet nesting.
 *
 * Cabinet/case parts are overwhelmingly rectangular, so we pack each part's
 * 2D AABB with a MaxRects bin-packer (see packRect.ts) — much tighter than
 * the previous raster greedy. Each placement still carries the original
 * polygon outline (with holes) so SVG / DXF / PDF rendering draws the
 * actual silhouette inside its slot.
 *
 * Parts are partitioned by rounded thickness; each thickness yields its own
 * stack of sheets. Multi-restart (configurable, default 8 tries) shuffles
 * insertion order and sweeps placement heuristics, keeping the best result.
 *
 * Grain / rotation policy:
 *   grain='length'  → preRotate 0°,  allowFlip=false  (length axis along sheet length)
 *   grain='width'   → preRotate 90°, allowFlip=false  (length axis across sheet)
 *   grain='free' & rotation='lock'   → preRotate 0°, allowFlip=false
 *   grain='free' & rotation='flip90' → preRotate 0°, allowFlip=true
 *   grain='free' & rotation='any'    → preRotate 0°, allowFlip=true
 *
 * ('any angle' collapses to flip90 in the rect packer — a non-rect shape's
 * AABB only grows for arbitrary rotation, hurting rect-packing yield.)
 */

import type { Vec2 } from './geometry';
import { packMulti, packMultiAnimated, type PackInput, type PackPlacement, type CutStrategy, type Cut, type PackProgress } from './packRect';
import { packCnc, packCncAnimated, polyArea, type CncInput, type CncSheet } from './cncNest';

export type { CutStrategy, Cut, PackProgress };

export type GrainLock = 'free' | 'length' | 'width';
export type RotationMode = 'lock' | 'flip90' | 'any';

export interface NestPart {
  id: string;
  name: string;
  thickness: number;      // mm
  qty: number;
  grain: GrainLock;
  rotation: RotationMode;
  outer: Vec2[];          // polygon outline (CCW)
  holes: Vec2[][];        // holes (CW)
  color: string;
}

export interface NestConfig {
  sheetW: number;
  sheetL: number;
  margin: number;
  kerf: number;
  resolution: number;     // unused by rect packer; kept for API stability
  restarts?: number;
  /** 'free' = MaxRects (max yield). 'guillotine' = track-saw friendly. */
  cutStrategy?: CutStrategy;
}

export interface PlacedPart {
  partId: string;
  partName: string;
  instance: number;
  rotation: number;       // degrees CCW. Rectangle strategies use 0 or 90;
                          // the 'cnc' strategy may use any angle.
  x: number;              // mm, sheet-relative (includes margin offset)
  y: number;
  w: number;              // mm — bbox width after rotation
  h: number;              // mm — bbox height after rotation
  color: string;
  outer: Vec2[];          // polygon ring, rotated + anchored to (0,0)
  holes: Vec2[][];
  /** Position-based label within the sheet: 'a', 'b', 'c', …
   *  Combined with the sheet's global number (1, 2, 3…) yields the
   *  full panel id used in the PDF and SVG: "1a", "2c", etc. */
  panelLabel: string;
  /** Index of the last cut that fully separates this panel from the
   *  surrounding stock (1-based, within the sheet's cuts[]). 0 means
   *  the panel was already separated by the time of the first cut
   *  (e.g. for sheets with a single part). For visualization: panels
   *  with separatedAt ≤ currentCutIndex are rendered as "cut off". */
  separatedAt: number;
}

export interface NestSheet {
  /** 1-based index WITHIN this thickness group. */
  index: number;
  /** 1-based index across the WHOLE job — sheet labels use this so a
   *  panel reads as "3c" (3rd sheet job-wide, 3rd panel on it) rather
   *  than "2.1c" (group 2, sheet 1, panel c). Set by runNest after all
   *  groups are built. */
  globalIndex: number;
  thickness: number;
  parts: PlacedPart[];
  usedArea: number;       // sum of placed bbox areas (mm²)
  /** Largest remaining free rectangle on this sheet (mm × mm) or null. */
  largestFree: { w: number; h: number } | null;
  /** Sheet width used for this sheet (post-auto-orient choice). */
  sheetW: number;
  /** Sheet length used for this sheet (post-auto-orient choice). */
  sheetL: number;
  /** Physical cuts in dependency order (full-sheet first, then sub-piece
   *  cuts). Coordinates are in the SAME frame as part placements
   *  (post-margin offset). Empty for MaxRects packing. */
  cuts: Cut[];
}

export interface ThicknessGroup {
  thickness: number;
  sheets: NestSheet[];
  unplaced: { partId: string; partName: string; instance: number }[];
}

export interface NestResult {
  groups: ThicknessGroup[];
  totalSheets: number;
  totalPartArea: number;
  totalSheetArea: number;
  yield: number;
}

// ---------------------------------------------------------------------------
// Polygon helpers
// ---------------------------------------------------------------------------
function rotatePoly(ring: Vec2[], deg: 0 | 90): Vec2[] {
  if (deg === 0) return ring.map(([x, y]) => [x, y]);
  // 90° CCW: (x, y) → (-y, x)
  return ring.map(([x, y]) => [-y, x]);
}

function anchorRings(rings: Vec2[][]): { outer: Vec2[]; holes: Vec2[][]; w: number; h: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rings) for (const [x, y] of r) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const shift = (r: Vec2[]): Vec2[] => r.map(([x, y]) => [x - minX, y - minY]);
  return {
    outer: shift(rings[0]),
    holes: rings.slice(1).map(shift),
    w: maxX - minX,
    h: maxY - minY,
  };
}

interface PartFootprint {
  /** Anchored polygon at 0° (lower-left at origin) */
  outer0: Vec2[]; holes0: Vec2[][];
  w0: number; h0: number;
  /** Same at 90° */
  outer90: Vec2[]; holes90: Vec2[][];
  w90: number; h90: number;
}

function buildFootprint(p: NestPart): PartFootprint {
  const a0 = anchorRings([p.outer, ...p.holes]);
  const a90 = anchorRings([rotatePoly(p.outer, 90), ...p.holes.map((h) => rotatePoly(h, 90))]);
  return {
    outer0: a0.outer, holes0: a0.holes, w0: a0.w, h0: a0.h,
    outer90: a90.outer, holes90: a90.holes, w90: a90.w, h90: a90.h,
  };
}

interface Policy { preRotate: 0 | 90; allowFlip: boolean; }

/**
 * The cut sheet's "length" axis is the sheet's longer dimension (typically
 * the grain direction of plywood stock — 96" for a 4×8). For a given part,
 * `grain=length` means "the part's long edge runs along the sheet's long
 * axis"; `grain=width` means it runs across.
 *
 * The polygon's bbox already has w0 = width along its own X, h0 = along Y.
 * After packing, the bin's X axis maps to sheet length and bin's Y maps to
 * sheet width (see runNest below — we feed (usableL, usableW) as bin dims).
 * So:
 *   grain=length → want the part's long edge along bin's X
 *   grain=width  → want the part's long edge along bin's Y
 */
function rotationPolicy(grain: GrainLock, mode: RotationMode, w0: number, h0: number): Policy {
  const isLandscapePart = w0 >= h0; // long edge along part's own X
  if (grain === 'length') {
    // Long edge along bin X. Already landscape → no rotation; else flip 90.
    return { preRotate: isLandscapePart ? 0 : 90, allowFlip: false };
  }
  if (grain === 'width') {
    // Long edge along bin Y. Need portrait → flip if currently landscape.
    return { preRotate: isLandscapePart ? 90 : 0, allowFlip: false };
  }
  if (mode === 'lock') return { preRotate: 0, allowFlip: false };
  // free + flip allowed → packer picks best
  return { preRotate: 0, allowFlip: true };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------
interface InstanceMeta {
  part: NestPart;
  foot: PartFootprint;
  policy: Policy;
  instance: number;
}

export function runNest(parts: NestPart[], config: NestConfig): NestResult {
  if (config.cutStrategy === 'cnc') return runCncNest(parts, config);
  const { sheetW, sheetL, margin, kerf } = config;
  const usableW = sheetW - 2 * margin;
  const usableL = sheetL - 2 * margin;
  if (usableW <= 0 || usableL <= 0) {
    throw new Error('Sheet margin leaves no usable area.');
  }
  const restarts = Math.max(4, config.restarts ?? 8);

  // Group by rounded thickness — 0.5 mm bucket.
  // STEP tessellation introduces sub-millimetre float noise, so a tighter
  // bucket (e.g. 0.1 mm) splits parts that are physically the same ply
  // into separate groups and forces each to its own stack of sheets.
  // 0.5 mm is robust against that noise without merging distinct stock
  // (plywood thicknesses are spaced ≥ ~3 mm apart in practice).
  const buckets = new Map<number, NestPart[]>();
  for (const p of parts) {
    const k = Math.round(p.thickness * 2) / 2;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(p);
  }
  const thicknesses = Array.from(buckets.keys()).sort((a, b) => a - b);

  const groups: ThicknessGroup[] = [];
  let totalPartArea = 0;
  let totalSheetArea = 0;
  let totalSheets = 0;

  for (const t of thicknesses) {
    const bucket = buckets.get(t)!;

    const items: PackInput[] = [];
    const meta = new Map<string, InstanceMeta>();

    for (const p of bucket) {
      const foot = buildFootprint(p);
      const policy = rotationPolicy(p.grain, p.rotation, foot.w0, foot.h0);
      // Min-cuts strategy needs rotational flexibility on free-grain parts
      // to actually pack into wide shelves. The user said "I don't care
      // about grain direction" by leaving grain='free', so honour that by
      // unlocking the part's flip even if the rotation UI was set to
      // 'lock' (which is the default). For parts with an explicit grain
      // direction we leave the original policy untouched.
      const allowFlip = (config.cutStrategy === 'guillotine' && p.grain === 'free')
        ? true
        : policy.allowFlip;
      for (let inst = 1; inst <= p.qty; inst++) {
        const id = `${p.id}#${inst}`;
        const w = policy.preRotate === 0 ? foot.w0 : foot.w90;
        const h = policy.preRotate === 0 ? foot.h0 : foot.h90;
        items.push({ id, w, h, allowRotate: allowFlip });
        meta.set(id, { part: p, foot, policy, instance: inst });
      }
    }

    // Sheet orientation is LOCKED to landscape — long edge runs along
    // the bin's X axis. This keeps the full plywood sheet's orientation
    // constant across the per-sheet overview, the cut-sequence cards,
    // the SVG/DXF, and the PDF. Some jobs would yield slightly tighter
    // packing in portrait, but the user explicitly wants a consistent
    // visual orientation in the documents.
    const winner = packMulti(
      { items, sheetW: usableL, sheetH: usableW, kerf, cutStrategy: config.cutStrategy },
      restarts,
    );
    const winnerSheetW = sheetL;
    const winnerSheetL = sheetW;

    const sheets: NestSheet[] = winner.sheets.map((ps, idx) => ({
      index: idx + 1,
      globalIndex: 0, // populated after all groups are built
      thickness: t,
      parts: ps.placements.map((pl) => placementToPart(pl, meta, margin)),
      usedArea: ps.usedArea,
      largestFree: ps.largestFree,
      sheetW: winnerSheetW,
      sheetL: winnerSheetL,
      // Shift cuts by `margin` so they're in the same sheet-coord frame as
      // the placed parts (which were also shifted by `margin` in placementToPart).
      cuts: ps.cuts.map((c) => ({
        parentX: c.parentX + margin,
        parentY: c.parentY + margin,
        parentW: c.parentW,
        parentH: c.parentH,
        axis: c.axis,
        distance: c.distance,
        depth: c.depth,
      })),
    }));

    // Now that each sheet has both its parts and its cuts, fill in
    // per-sheet panel labels (a, b, c…) and the cut-step at which each
    // panel is fully separated from the surrounding stock.
    for (const sh of sheets) annotatePlacedParts(sh);

    const unplaced = winner.unplaced.map((u) => {
      const m = meta.get(u.id)!;
      return { partId: m.part.id, partName: m.part.name, instance: m.instance };
    });

    const groupSheetArea = sheets.length * winnerSheetW * winnerSheetL;
    const groupPartArea = sheets.reduce((acc, s) => acc + s.usedArea, 0);
    totalSheetArea += groupSheetArea;
    totalPartArea += groupPartArea;
    totalSheets += sheets.length;

    groups.push({ thickness: t, sheets, unplaced });
  }

  // Now that all groups exist, assign continuous global sheet indices.
  let gIdx = 1;
  for (const g of groups) {
    for (const s of g.sheets) s.globalIndex = gIdx++;
  }

  return {
    groups,
    totalSheets,
    totalPartArea,
    totalSheetArea,
    yield: totalSheetArea > 0 ? totalPartArea / totalSheetArea : 0,
  };
}

/**
 * Animated/observable variant of `runNest`. Runs each thickness bucket
 * through `packMultiAnimated` so the optimiser yields back to the browser
 * between trials. `onTrial` is invoked with a per-trial preview of the
 * current and best-so-far layouts so the UI can animate panel shuffling
 * at the requested frame rate.
 */
export async function runNestAnimated(
  parts: NestPart[],
  config: NestConfig,
  onTrial: (info: {
    groupIdx: number;
    totalGroups: number;
    trial: number;
    totalTrials: number;
    current: NestSheet[];
    best: NestSheet[];
    isNewBest: boolean;
    sheetW: number;
    sheetL: number;
  }) => void | Promise<void>,
): Promise<NestResult> {
  if (config.cutStrategy === 'cnc') return runCncNestAnimated(parts, config, onTrial);
  const { sheetW, sheetL, margin, kerf } = config;
  const usableW = sheetW - 2 * margin;
  const usableL = sheetL - 2 * margin;
  if (usableW <= 0 || usableL <= 0) throw new Error('Sheet margin leaves no usable area.');
  const restarts = Math.max(4, config.restarts ?? 8);

  const buckets = new Map<number, NestPart[]>();
  for (const p of parts) {
    const k = Math.round(p.thickness * 2) / 2;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(p);
  }
  const thicknesses = Array.from(buckets.keys()).sort((a, b) => a - b);

  const groups: ThicknessGroup[] = [];
  let totalPartArea = 0;
  let totalSheetArea = 0;
  let totalSheets = 0;
  const totalGroups = thicknesses.length;

  for (let gi = 0; gi < totalGroups; gi++) {
    const t = thicknesses[gi];
    const bucket = buckets.get(t)!;
    const items: PackInput[] = [];
    const meta = new Map<string, InstanceMeta>();
    for (const p of bucket) {
      const foot = buildFootprint(p);
      const policy = rotationPolicy(p.grain, p.rotation, foot.w0, foot.h0);
      const allowFlip = (config.cutStrategy === 'guillotine' && p.grain === 'free')
        ? true
        : policy.allowFlip;
      for (let inst = 1; inst <= p.qty; inst++) {
        const id = `${p.id}#${inst}`;
        const w = policy.preRotate === 0 ? foot.w0 : foot.w90;
        const h = policy.preRotate === 0 ? foot.h0 : foot.h90;
        items.push({ id, w, h, allowRotate: allowFlip });
        meta.set(id, { part: p, foot, policy, instance: inst });
      }
    }

    // Convert a packMulti result into the per-group NestSheet[] the UI uses.
    const winnerSheetW = sheetL;  // landscape locked (see runNest)
    const winnerSheetL = sheetW;
    const toNestSheets = (winner: { sheets: { placements: PackPlacement[]; usedArea: number; largestFree: { w: number; h: number } | null; cuts: Cut[] }[] }): NestSheet[] =>
      winner.sheets.map((ps, idx) => {
        const sh: NestSheet = {
          index: idx + 1,
          globalIndex: 0,
          thickness: t,
          parts: ps.placements.map((pl) => placementToPart(pl, meta, margin)),
          usedArea: ps.usedArea,
          largestFree: ps.largestFree,
          sheetW: winnerSheetW,
          sheetL: winnerSheetL,
          cuts: ps.cuts.map((c) => ({
            parentX: c.parentX + margin,
            parentY: c.parentY + margin,
            parentW: c.parentW,
            parentH: c.parentH,
            axis: c.axis,
            distance: c.distance,
            depth: c.depth,
          })),
        };
        annotatePlacedParts(sh);
        return sh;
      });

    const winner = await packMultiAnimated(
      { items, sheetW: usableL, sheetH: usableW, kerf, cutStrategy: config.cutStrategy },
      restarts,
      async (p) => {
        await onTrial({
          groupIdx: gi,
          totalGroups,
          trial: p.i,
          totalTrials: p.total,
          current: toNestSheets(p.current),
          best: toNestSheets(p.best),
          isNewBest: p.isNewBest,
          sheetW: winnerSheetW,
          sheetL: winnerSheetL,
        });
      },
    );

    const sheets: NestSheet[] = toNestSheets(winner);
    const unplaced = winner.unplaced.map((u) => {
      const m = meta.get(u.id)!;
      return { partId: m.part.id, partName: m.part.name, instance: m.instance };
    });
    const groupSheetArea = sheets.length * winnerSheetW * winnerSheetL;
    const groupPartArea = sheets.reduce((acc, s) => acc + s.usedArea, 0);
    totalSheetArea += groupSheetArea;
    totalPartArea += groupPartArea;
    totalSheets += sheets.length;
    groups.push({ thickness: t, sheets, unplaced });
  }

  let gIdx = 1;
  for (const g of groups) for (const s of g.sheets) s.globalIndex = gIdx++;
  return {
    groups, totalSheets, totalPartArea, totalSheetArea,
    yield: totalSheetArea > 0 ? totalPartArea / totalSheetArea : 0,
  };
}

function placementToPart(
  pl: PackPlacement,
  meta: Map<string, InstanceMeta>,
  margin: number,
): PlacedPart {
  const m = meta.get(pl.id)!;
  // Visual rotation: pre-rotation, plus any packer-induced flip
  let deg: 0 | 90 = m.policy.preRotate;
  if (pl.rotated) deg = deg === 0 ? 90 : 0;

  const outer = deg === 90 ? m.foot.outer90 : m.foot.outer0;
  const holes = deg === 90 ? m.foot.holes90 : m.foot.holes0;

  return {
    partId: m.part.id,
    partName: m.part.name,
    instance: m.instance,
    rotation: deg,
    x: pl.x + margin,
    y: pl.y + margin,
    w: pl.w,
    h: pl.h,
    color: m.part.color,
    outer,
    holes,
    panelLabel: '',          // populated after the sheet is assembled
    separatedAt: 0,          // populated after cuts are known
  };
}

/**
 * After a sheet's parts and cuts are known, fill in:
 *   - panelLabel: 'a', 'b', 'c', … by top-to-bottom, then left-to-right.
 *   - separatedAt: index (1-based) of the LAST cut that completes the
 *     panel's separation from the surrounding stock. A panel is considered
 *     fully separated when all of its interior edges have been cut.
 */
function annotatePlacedParts(sheet: NestSheet) {
  // Sort by position for stable per-sheet labels.
  const sorted = sheet.parts.slice().sort((a, b) => {
    if (Math.abs(a.y - b.y) > 0.5) return a.y - b.y;
    return a.x - b.x;
  });
  sorted.forEach((p, i) => {
    p.panelLabel = positionToLetter(i);
  });

  // Map cut → absolute coord (for V cuts this is the X line; for H cuts the Y).
  const cutLine = (c: typeof sheet.cuts[number]) =>
    c.axis === 'V' ? c.parentX + c.distance : c.parentY + c.distance;

  for (const p of sheet.parts) {
    let lastIdx = 0;
    // For each interior edge of the panel, find a cut whose abs coord matches.
    const eps = 0.5;
    const xs: number[] = [];
    const ys: number[] = [];
    if (p.x > eps)                xs.push(p.x);
    if (p.x + p.w < sheet.sheetW - eps) xs.push(p.x + p.w);
    if (p.y > eps)                ys.push(p.y);
    if (p.y + p.h < sheet.sheetL - eps) ys.push(p.y + p.h);

    for (let i = 0; i < sheet.cuts.length; i++) {
      const c = sheet.cuts[i];
      const v = cutLine(c);
      const matches = c.axis === 'V'
        ? xs.some((x) => Math.abs(x - v) < eps)
        : ys.some((y) => Math.abs(y - v) < eps);
      if (matches) lastIdx = i + 1;
    }
    p.separatedAt = lastIdx;
  }
}

/** 0 → 'a', 25 → 'z', 26 → 'aa', etc. */
function positionToLetter(i: number): string {
  let n = i;
  let s = '';
  do {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/**
 * Pick the better of two pack tries:
 *   1. fewer unplaced wins
 *   2. fewer sheets wins
 *   3. higher fill on the last sheet wins
 * Returns true if A is at least as good as B.
 */
function compareTries(
  a: { sheets: { usedArea: number }[]; unplaced: unknown[] },
  b: { sheets: { usedArea: number }[]; unplaced: unknown[] },
): boolean {
  if (a.unplaced.length !== b.unplaced.length) return a.unplaced.length < b.unplaced.length;
  if (a.sheets.length !== b.sheets.length) return a.sheets.length < b.sheets.length;
  const aLast = a.sheets.length ? a.sheets[a.sheets.length - 1].usedArea : 0;
  const bLast = b.sheets.length ? b.sheets[b.sheets.length - 1].usedArea : 0;
  return aLast >= bLast;
}

// ---------------------------------------------------------------------------
// CNC / waterjet true-shape nesting path
//
// Bypasses the rectangle packer entirely (see cncNest.ts). Parts may rotate to
// ANY angle and nest inside each other's concavities and holes; there is no
// guillotine cut tree (a router/waterjet cuts continuous contours), so
// NestSheet.cuts is left empty. We keep the same thickness grouping, landscape
// orientation lock, and margin frame as the rectangle path so every downstream
// renderer (SVG / DXF / PDF) treats CNC sheets like any other.
// ---------------------------------------------------------------------------

/** Candidate rotation angles (deg, CCW) for a part under the CNC strategy. */
const CNC_ANGLE_STEP = 15;

function cncAnglesFor(grain: GrainLock, w0: number, h0: number): number[] {
  if (grain === 'free') {
    const out: number[] = [];
    for (let a = 0; a < 360; a += CNC_ANGLE_STEP) out.push(a);
    return out;
  }
  // Respect an explicit grain lock: keep the part's length (grain) axis aligned
  // to the chosen sheet axis. Only the grain-preserving 180° flip is allowed.
  const isLandscape = w0 >= h0;
  if (grain === 'length') {
    const base = isLandscape ? 0 : 90;
    return [base, base + 180];
  }
  // grain === 'width'
  const base = isLandscape ? 90 : 0;
  return [base, base + 180];
}

function ringBbox(ring: Vec2[]): { w: number; h: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { w: maxX - minX, h: maxY - minY };
}

function bucketByThickness(parts: NestPart[]): Map<number, NestPart[]> {
  const buckets = new Map<number, NestPart[]>();
  for (const p of parts) {
    const k = Math.round(p.thickness * 2) / 2;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(p);
  }
  return buckets;
}

interface CncMeta { part: NestPart; instance: number; }

function buildCncItems(bucket: NestPart[]): { items: CncInput[]; meta: Map<string, CncMeta> } {
  const items: CncInput[] = [];
  const meta = new Map<string, CncMeta>();
  for (const p of bucket) {
    const bb = ringBbox(p.outer);
    const angles = cncAnglesFor(p.grain, bb.w, bb.h);
    const area = polyArea(p.outer, p.holes);
    for (let inst = 1; inst <= p.qty; inst++) {
      const id = `${p.id}#${inst}`;
      items.push({ id, geoKey: p.id, outer: p.outer, holes: p.holes, angles, area });
      meta.set(id, { part: p, instance: inst });
    }
  }
  return { items, meta };
}

function cncSheetToNest(
  cs: CncSheet,
  idx: number,
  thickness: number,
  margin: number,
  sheetW: number,
  sheetL: number,
  meta: Map<string, CncMeta>,
): NestSheet {
  const sh: NestSheet = {
    index: idx + 1,
    globalIndex: 0,
    thickness,
    parts: cs.placements.map((pl) => {
      const m = meta.get(pl.id)!;
      return {
        partId: m.part.id,
        partName: m.part.name,
        instance: m.instance,
        rotation: pl.angleDeg,
        x: pl.x + margin,
        y: pl.y + margin,
        w: pl.w,
        h: pl.h,
        color: m.part.color,
        outer: pl.outer,
        holes: pl.holes,
        panelLabel: '',
        separatedAt: 0,
      };
    }),
    usedArea: cs.usedArea,
    largestFree: cs.largestFree,
    sheetW,
    sheetL,
    cuts: [], // CNC = continuous contour cutting, no guillotine cut tree
  };
  annotatePlacedParts(sh);
  return sh;
}

export function runCncNest(parts: NestPart[], config: NestConfig): NestResult {
  const { sheetW, sheetL, margin, kerf } = config;
  const usableW = sheetW - 2 * margin;
  const usableL = sheetL - 2 * margin;
  if (usableW <= 0 || usableL <= 0) throw new Error('Sheet margin leaves no usable area.');

  const buckets = bucketByThickness(parts);
  const thicknesses = Array.from(buckets.keys()).sort((a, b) => a - b);
  // Landscape lock (matches the rectangle path): bin X = sheet length.
  const winnerSheetW = sheetL;
  const winnerSheetL = sheetW;

  const groups: ThicknessGroup[] = [];
  let totalPartArea = 0, totalSheetArea = 0, totalSheets = 0;

  for (const t of thicknesses) {
    const { items, meta } = buildCncItems(buckets.get(t)!);
    const res = packCnc(items, usableL, usableW, kerf);
    const sheets = res.sheets.map((cs, idx) =>
      cncSheetToNest(cs, idx, t, margin, winnerSheetW, winnerSheetL, meta));
    const unplaced = res.unplaced.map((id) => {
      const m = meta.get(id)!;
      return { partId: m.part.id, partName: m.part.name, instance: m.instance };
    });
    totalSheetArea += sheets.length * winnerSheetW * winnerSheetL;
    totalPartArea += sheets.reduce((a, s) => a + s.usedArea, 0);
    totalSheets += sheets.length;
    groups.push({ thickness: t, sheets, unplaced });
  }

  let gIdx = 1;
  for (const g of groups) for (const s of g.sheets) s.globalIndex = gIdx++;
  return {
    groups, totalSheets, totalPartArea, totalSheetArea,
    yield: totalSheetArea > 0 ? totalPartArea / totalSheetArea : 0,
  };
}

export async function runCncNestAnimated(
  parts: NestPart[],
  config: NestConfig,
  onTrial: (info: {
    groupIdx: number; totalGroups: number; trial: number; totalTrials: number;
    current: NestSheet[]; best: NestSheet[]; isNewBest: boolean;
    sheetW: number; sheetL: number;
  }) => void | Promise<void>,
): Promise<NestResult> {
  const { sheetW, sheetL, margin, kerf } = config;
  const usableW = sheetW - 2 * margin;
  const usableL = sheetL - 2 * margin;
  if (usableW <= 0 || usableL <= 0) throw new Error('Sheet margin leaves no usable area.');

  const buckets = bucketByThickness(parts);
  const thicknesses = Array.from(buckets.keys()).sort((a, b) => a - b);
  const totalGroups = thicknesses.length;
  const winnerSheetW = sheetL;
  const winnerSheetL = sheetW;
  const totalParts = parts.reduce((a, p) => a + p.qty, 0);

  const groups: ThicknessGroup[] = [];
  let totalPartArea = 0, totalSheetArea = 0, totalSheets = 0;
  let placedBefore = 0;

  for (let gi = 0; gi < totalGroups; gi++) {
    const t = thicknesses[gi];
    const { items, meta } = buildCncItems(buckets.get(t)!);
    const groupBase = placedBefore;

    const toSheets = (css: CncSheet[]): NestSheet[] => {
      const sheets = css.map((cs, idx) =>
        cncSheetToNest(cs, idx, t, margin, winnerSheetW, winnerSheetL, meta));
      let gx = 1;
      for (const s of sheets) s.globalIndex = gx++; // provisional, for live preview
      return sheets;
    };

    const res = await packCncAnimated(items, usableL, usableW, kerf, async (p) => {
      const sheets = toSheets(p.sheets);
      await onTrial({
        groupIdx: gi,
        totalGroups,
        trial: Math.max(0, groupBase + p.placed - 1),
        totalTrials: Math.max(1, totalParts),
        current: sheets,
        best: sheets,
        isNewBest: true,
        sheetW: winnerSheetW,
        sheetL: winnerSheetL,
      });
    });

    placedBefore = groupBase + items.length;
    const sheets = res.sheets.map((cs, idx) =>
      cncSheetToNest(cs, idx, t, margin, winnerSheetW, winnerSheetL, meta));
    const unplaced = res.unplaced.map((id) => {
      const m = meta.get(id)!;
      return { partId: m.part.id, partName: m.part.name, instance: m.instance };
    });
    totalSheetArea += sheets.length * winnerSheetW * winnerSheetL;
    totalPartArea += sheets.reduce((a, s) => a + s.usedArea, 0);
    totalSheets += sheets.length;
    groups.push({ thickness: t, sheets, unplaced });
  }

  let gIdx = 1;
  for (const g of groups) for (const s of g.sheets) s.globalIndex = gIdx++;
  return {
    groups, totalSheets, totalPartArea, totalSheetArea,
    yield: totalSheetArea > 0 ? totalPartArea / totalSheetArea : 0,
  };
}
