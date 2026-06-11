/**
 * Oversize-part auto-splitting with dovetail joints (CNC strategies only).
 *
 * A part whose footprint cannot fit on the usable sheet at any allowed
 * orientation is split into segments that CAN fit, and the mating edges get
 * interlocking dovetail (puzzle-joint) geometry so the segments re-assemble
 * into the original panel. A CNC router cuts the dovetail contour for free —
 * this is the standard trick for batching oversized panels out of stock
 * sheets.
 *
 * Splitting is "logical":
 *   - the cut runs PERPENDICULAR to the part's longest bbox axis, so the
 *     joint is as short as possible and segments stay as wide as the part;
 *   - the part is divided into the MINIMUM number of equal segments such
 *     that each segment (including its protruding tails) fits the sheet;
 *   - a segment that still doesn't fit (both dimensions oversize) is split
 *     again along its other axis, recursively.
 *
 * Dovetail layout per joint:
 *   - the joint span is divided into (2·n + 1) equal slots; slots
 *     1, 3, 5, … carry tails, so tails and gaps alternate with a half-slot
 *     shoulder at each end;
 *   - n — the number of dovetails — is a function of the joint length:
 *     one tail per ~TAIL_PITCH of joint, minimum 1;
 *   - tail depth scales with stock thickness (clamped), and the tail flares
 *     wider at the tip (classic dovetail) so the joint locks in-plane and is
 *     assembled by dropping the mating piece in from above.
 *
 * Geometry is computed with polygon booleans (polygon-clipping), so holes
 * and non-rectangular outlines survive the split: each clipped fragment
 * becomes its own segment.
 */

import type { Vec2 } from './geometry';
import type { NestPart } from './nest';
import * as pcNs from 'polygon-clipping';

// The published .d.ts declares named exports but the ESM build ships a single
// default-exported object — unwrap whichever shape the bundler hands us.
const pc = ((pcNs as unknown as { default?: typeof pcNs }).default ??
  pcNs) as typeof pcNs;

type Ring = Vec2[];
type Poly = Ring[]; // [outer, ...holes]

/** Target joint length per dovetail — n = max(1, round(jointLen / PITCH)). */
const TAIL_PITCH = 120; // mm
/** Tail depth = thickness × this, clamped below. */
const DEPTH_PER_THICKNESS = 1.5;
const DEPTH_MIN = 10; // mm
const DEPTH_MAX = 30; // mm
/** Dovetail flare angle (how much wider the tip is than the base, per side). */
const FLARE_DEG = 9;
/** Joints shorter than this get a plain straight cut — a dovetail needs room
 *  for a tail plus two shoulders to mean anything structurally. */
const MIN_DOVETAIL_JOINT = 24; // mm
/** Clearance kept between a segment's bbox (tails included) and the bin. */
const FIT_SLACK = 5; // mm
/** Recursion guard — a part is never split into more than ~2^4 generations. */
const MAX_SPLIT_DEPTH = 4;

export interface SplitInfo {
  name: string;
  pieces: number;
}

export interface SegmentGeo {
  outer: Vec2[];
  holes: Vec2[][];
  thickness: number;
  /** Segment's anchored-origin position within the ORIGINAL part's frame —
   *  drawing every segment at its offset reassembles the parent silhouette
   *  (the PDF join guide does exactly that). */
  offsetX: number;
  offsetY: number;
  parentId: string;
  parentName: string;
  /** 1-based segment index and total count within the parent. */
  segIndex: number;
  segCount: number;
  color: string;
}

export interface SplitResult {
  parts: NestPart[];
  /** Geometry + provenance of generated segments by part id. Used by the
   *  unplaced STEP export (segment ids don't resolve to a source body) and
   *  by the PDF's "join split parts" guide. */
  segmentGeo: Map<string, SegmentGeo>;
  /** One entry per original part that was split. */
  splits: SplitInfo[];
}

// ---------------------------------------------------------------------------
// Small polygon utilities
// ---------------------------------------------------------------------------
function ringSignedArea(ring: Ring): number {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/** Outer ring CCW, holes CW — the convention the rest of the app uses. */
function normalizeWinding(poly: Poly): Poly {
  return poly.map((ring, i) => {
    const ccw = ringSignedArea(ring) > 0;
    const wantCcw = i === 0;
    return ccw === wantCcw ? ring : ring.slice().reverse();
  });
}

/** polygon-clipping closes its rings (first point repeated) — drop the dup. */
function openRing(ring: Ring): Ring {
  if (ring.length > 1) {
    const [fx, fy] = ring[0];
    const [lx, ly] = ring[ring.length - 1];
    if (Math.abs(fx - lx) < 1e-9 && Math.abs(fy - ly) < 1e-9) {
      return ring.slice(0, -1);
    }
  }
  return ring;
}

function bbox(rings: Ring[]): { minX: number; minY: number; maxX: number; maxY: number; w: number; h: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rings) for (const [x, y] of r) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

function transposePoly(poly: Poly): Poly {
  return poly.map((r) => r.map(([x, y]): Vec2 => [y, x]));
}

function anchorPoly(poly: Poly): Poly {
  const b = bbox(poly);
  return poly.map((r) => r.map(([x, y]): Vec2 => [x - b.minX, y - b.minY]));
}

/** Drop degenerate fragments — e.g. the tip of a dovetail flare clipped off
 *  by a perpendicular cut through the joint. Anything smaller than ~3×3 cm is
 *  not a panel piece worth cutting; the reassembled panel just gets a tiny
 *  relieved corner where two joints cross. */
function isRealPiece(poly: Poly): boolean {
  if (poly.length === 0 || poly[0].length < 3) return false;
  return Math.abs(ringSignedArea(poly[0])) > 1000;
}

// ---------------------------------------------------------------------------
// Fit test
// ---------------------------------------------------------------------------
/**
 * Can a (w × h) footprint sit on the usable bin (binX = sheet length axis,
 * binY = sheet width axis)? Grain-locked parts only get their grain-preserving
 * orientation; free parts may rotate 90°. (The CNC nester also tries
 * intermediate angles, but the axis-aligned test is the conservative gate.)
 */
function fitsBin(w: number, h: number, grain: NestPart['grain'], binX: number, binY: number): boolean {
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  if (grain === 'length') return long <= binX && short <= binY;
  if (grain === 'width') return long <= binY && short <= binX;
  return (w <= binX && h <= binY) || (h <= binX && w <= binY);
}

// ---------------------------------------------------------------------------
// Dovetail joint profile
// ---------------------------------------------------------------------------
/**
 * Region polygon covering everything LEFT of a vertical dovetail cut at
 * x = cx. Its right boundary is the joint profile: a straight line at cx
 * interrupted by `nTails` trapezoidal tails protruding to cx + depth, flared
 * wider at the tip so the joint interlocks. Intersecting a part with this
 * region yields the tail side; subtracting it yields the matching socket side.
 *
 * The region rectangle spans [regY0, regY1] — the part's FULL vertical
 * extent — so everything left of the cut ends up in the left piece even where
 * the part is taller than the joint. The tails are laid out only within
 * [jointY0, jointY1], the material actually present at the cut line.
 */
function dovetailRegion(
  cx: number,
  regY0: number,
  regY1: number,
  jointY0: number,
  jointY1: number,
  farLeftX: number,
  depth: number,
  nTails: number,
  flare: number,
): Poly {
  const seg = (jointY1 - jointY0) / (2 * nTails + 1);
  const ring: Ring = [
    [farLeftX, regY0],
    [cx, regY0],
  ];
  for (let i = 0; i < nTails; i++) {
    const a = jointY0 + (2 * i + 1) * seg;
    const b = a + seg;
    ring.push([cx, a], [cx + depth, a - flare], [cx + depth, b + flare], [cx, b]);
  }
  ring.push([cx, regY1], [farLeftX, regY1]);
  return [ring];
}

/** Number of dovetails for a joint of this length: one per TAIL_PITCH, min 1. */
export function tailCountFor(jointLen: number): number {
  return Math.max(1, Math.round(jointLen / TAIL_PITCH));
}

function tailDepthFor(thickness: number): number {
  return Math.min(DEPTH_MAX, Math.max(DEPTH_MIN, thickness * DEPTH_PER_THICKNESS));
}

/**
 * Actual material span along the cut line at x = cx: the min/max Y of the
 * part's intersection with a thin vertical band there. The part's global
 * bbox is wrong for shaped parts — an L-shaped panel cut through its narrow
 * arm would get tails laid out over empty space and clipped to fragments.
 * Returns null when the band misses the material entirely.
 */
function jointSpanAt(material: Poly[], cx: number, y0: number, y1: number): { jy0: number; jy1: number } | null {
  const band: Poly = [[
    [cx - 0.5, y0],
    [cx + 0.5, y0],
    [cx + 0.5, y1],
    [cx - 0.5, y1],
  ]];
  const hit = pc.intersection(material as pcNs.MultiPolygon, [band] as pcNs.MultiPolygon) as Poly[];
  let minY = Infinity, maxY = -Infinity;
  for (const poly of hit) for (const ring of poly) for (const [, y] of ring) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return Number.isFinite(minY) ? { jy0: minY, jy1: maxY } : null;
}

// ---------------------------------------------------------------------------
// Recursive split
// ---------------------------------------------------------------------------
/**
 * Split one polygon into segments that fit the bin, joining cut edges with
 * dovetails. Cuts always run perpendicular to the polygon's longest bbox
 * axis; fragments that still don't fit recurse (next call picks THEIR longest
 * axis, so a doubly-oversize part ends up split in both directions).
 */
function splitPoly(
  poly: Poly,
  thickness: number,
  grain: NestPart['grain'],
  binX: number,
  binY: number,
  depthGuard: number,
): Poly[] {
  const b = bbox(poly);
  if (fitsBin(b.w, b.h, grain, binX, binY)) return [poly];
  if (depthGuard <= 0) return [poly]; // give up — reported as unplaced later

  // Always cut across the longest axis. Transpose so the cut is vertical.
  const vertical = b.w >= b.h;
  const work = vertical ? poly : transposePoly(poly);
  const wb = vertical ? b : bbox(work);

  const depth = tailDepthFor(thickness);
  // Longest bin run available to a segment given its cross dimension; if the
  // cross dimension itself is oversize, recursion will cut it next round.
  const cross = wb.h;
  const limit = cross <= binY ? binX : cross <= binX ? binY : Math.max(binX, binY);
  const maxSeg = limit - depth - FIT_SLACK;
  const k = Math.max(2, Math.ceil(wb.w / Math.max(1, maxSeg)));

  const farLeft = wb.minX - depth - 20;

  // Peel segments off left-to-right with successive boolean cuts. Each
  // joint is sized from the material ACTUALLY present at its cut line, so
  // shaped and skinny parts get tails that sit fully on the joint:
  //   - tail count scales with the real joint length;
  //   - tail depth never exceeds the tail width (no fragile fingers);
  //   - joints too short for a meaningful dovetail fall back to a straight
  //     cut rather than a clipped sliver of a tail.
  const pieces: Poly[] = [];
  let remaining: Poly[] = [work];
  const regY0 = wb.minY - depth - 10;
  const regY1 = wb.maxY + depth + 10;
  for (let i = 1; i < k; i++) {
    const cx = wb.minX + (wb.w * i) / k;
    const span = jointSpanAt(remaining, cx, regY0, regY1)
      ?? { jy0: wb.minY, jy1: wb.maxY };
    const jointLen = span.jy1 - span.jy0;
    let region: Poly;
    if (jointLen < MIN_DOVETAIL_JOINT) {
      region = dovetailRegion(cx, regY0, regY1, span.jy0, span.jy1, farLeft, 0, 0, 0); // straight cut
    } else {
      const nTails = tailCountFor(jointLen);
      const seg = jointLen / (2 * nTails + 1);
      const depthJ = Math.min(depth, seg);
      const flare = Math.min(depthJ * Math.tan((FLARE_DEG * Math.PI) / 180), seg * 0.45);
      region = dovetailRegion(cx, regY0, regY1, span.jy0, span.jy1, farLeft, depthJ, nTails, flare);
    }
    const left = pc.intersection(remaining as pcNs.MultiPolygon, [region] as pcNs.MultiPolygon);
    remaining = pc.difference(remaining as pcNs.MultiPolygon, [region] as pcNs.MultiPolygon) as Poly[];
    for (const p of left as Poly[]) pieces.push(p);
  }
  for (const p of remaining) pieces.push(p);

  // Clean fragments, restore orientation, recurse on anything still oversize.
  const out: Poly[] = [];
  for (const raw of pieces) {
    const cleaned = raw.map(openRing);
    if (!isRealPiece(cleaned)) continue;
    const restored = vertical ? cleaned : transposePoly(cleaned);
    for (const sub of splitPoly(restored, thickness, grain, binX, binY, depthGuard - 1)) {
      out.push(sub);
    }
  }
  return out.length > 0 ? out : [poly];
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------
/**
 * Map a part list through the splitter. Parts that fit pass through
 * untouched; oversize parts are replaced by their dovetailed segments
 * (`<id>.s1`, `<id>.s2`, … — qty/grain/rotation/color inherited).
 */
export function splitOversizeParts(parts: NestPart[], binX: number, binY: number): SplitResult {
  const outParts: NestPart[] = [];
  const segmentGeo = new Map<string, SegmentGeo>();
  const splits: SplitInfo[] = [];

  for (const p of parts) {
    const b = bbox([p.outer]);
    if (fitsBin(b.w, b.h, p.grain, binX, binY)) {
      outParts.push(p);
      continue;
    }
    const segs = splitPoly([p.outer, ...p.holes], p.thickness, p.grain, binX, binY, MAX_SPLIT_DEPTH);
    if (segs.length <= 1) {
      outParts.push(p); // could not be split — flows through as unplaced
      continue;
    }
    splits.push({ name: p.name, pieces: segs.length });
    // Join order reads naturally when segments march across the parent —
    // sort by bbox min along the parent's longer axis.
    const pb = bbox([p.outer]);
    const axis = pb.w >= pb.h ? 0 : 1;
    const ordered = segs
      .map((seg) => ({ seg, b: bbox(seg) }))
      .sort((a, b) => (axis === 0 ? a.b.minX - b.b.minX : a.b.minY - b.b.minY));
    ordered.forEach(({ seg, b }, i) => {
      const anchored = normalizeWinding(anchorPoly(seg));
      const id = `${p.id}.s${i + 1}`;
      const outer = anchored[0];
      const holes = anchored.slice(1);
      outParts.push({
        id,
        name: `${p.name} ${i + 1}/${segs.length}`,
        thickness: p.thickness,
        qty: p.qty,
        grain: p.grain,
        rotation: p.rotation,
        outer,
        holes,
        color: p.color,
      });
      segmentGeo.set(id, {
        outer, holes, thickness: p.thickness,
        offsetX: b.minX, offsetY: b.minY,
        parentId: p.id, parentName: p.name,
        segIndex: i + 1, segCount: segs.length,
        color: p.color,
      });
    });
  }

  return { parts: outParts, segmentGeo, splits };
}
