/**
 * Minimal DXF R12 ASCII writer.
 *
 * AutoCAD's DWG is a proprietary, version-locked binary format. The friendly
 * ASCII sibling — DXF — is what every CAD/CAM tool reads natively (AutoCAD,
 * Fusion, SolidWorks, LightBurn, Aspire, FreeCAD, etc.). For cut-list
 * fabrication it's the right pick.
 *
 * STRICT R12 ONLY — this is the compatibility contract. Older waterjet /
 * plasma CAM packages parse nothing newer. Specifically:
 *   - polylines are classic POLYLINE + VERTEX + SEQEND chains, NEVER
 *     LWPOLYLINE (that entity arrived in R14 and strict R12 readers reject
 *     the whole file over it);
 *   - the TABLES section declares LTYPE (CONTINUOUS) and STYLE (STANDARD)
 *     before LAYER — the pickiest readers refuse layers that reference an
 *     undeclared linetype/text style;
 *   - $EXTMIN/$EXTMAX are emitted so ancient viewers can zoom-extents.
 *
 * We emit a tiny but valid R12 file with:
 *   - layer SHEET     (sheet border)
 *   - layer MARGIN    (dashed inner safe area)
 *   - layer PARTS     (each part outline + holes)
 *   - layer LABELS    (part name / instance text)
 *   - layer DIMS      (dimension lines + text, drawn as line+arrow primitives —
 *                     not associative DIMENSION entities, but visually correct
 *                     and openable everywhere)
 *
 * Coordinates are written in millimetres (matching the OCCT pipeline). Most
 * CAM software lets you pick mm or inches on import.
 */

import type { NestSheet, PlacedPart } from './nest';
import type { Vec2 } from './geometry';
import { fmtDim as fmtDimUnits, type Units } from './units';

export interface DxfOptions {
  /** Sheet width in mm */
  sheetW: number;
  /** Sheet length in mm */
  sheetL: number;
  /** Edge margin in mm */
  margin: number;
  /** Units to display dimension labels in */
  units: Units;
  /** If true, draws per-part W × L dimension lines */
  partDimensions: boolean;
  /** If true, draws overall sheet dimension lines */
  sheetDimensions: boolean;
  /** "Cut file" mode for CNC routers / waterjet: emit ONLY geometry the
   *  machine cuts — the sheet boundary plus every part outline and hole — with
   *  no labels, no dimensions, and no margin guide. Overrides the label/dim
   *  flags above when set. */
  outlinesOnly?: boolean;
}

const fmtDim = (mm: number, units: Units) => fmtDimUnits(mm, units);

const NL = '\r\n';
const ARROW_LEN = 5;       // mm
const ARROW_W = 1.5;       // mm
const DIM_OFFSET = 15;     // mm — distance from object to dim line
const TEXT_H = 6;          // mm — for labels
const DIM_TEXT_H = 4;      // mm — for dim text

// ---------------------------------------------------------------------------
// Header & footer
// ---------------------------------------------------------------------------
function header(minX: number, minY: number, maxX: number, maxY: number): string {
  // R12-era variables only. $INSUNITS/$MEASUREMENT are NOT emitted — they
  // postdate R12, and while most readers skip unknown header variables, the
  // strictest waterjet importers reject files over them. Coordinates are mm;
  // CAM software lets the operator pick units on import.
  return [
    '0', 'SECTION',
    '2', 'HEADER',
    '9', '$ACADVER',
    '1', 'AC1009',     // R12
    '9', '$EXTMIN',
    '10', f(minX), '20', f(minY), '30', '0',
    '9', '$EXTMAX',
    '10', f(maxX), '20', f(maxY), '30', '0',
    '0', 'ENDSEC',
  ].join(NL);
}

function tables(): string {
  return [
    '0', 'SECTION',
    '2', 'TABLES',
    // LTYPE first — layers below reference CONTINUOUS, and strict readers
    // want it declared before use.
    '0', 'TABLE', '2', 'LTYPE', '70', '1',
    ['0', 'LTYPE', '2', 'CONTINUOUS', '70', '0',
     '3', 'Solid line', '72', '65', '73', '0', '40', '0.0'].join(NL),
    '0', 'ENDTAB',
    '0', 'TABLE', '2', 'LAYER', '70', '5',
    layer('SHEET', 7),
    layer('MARGIN', 8),
    layer('PARTS', 5),
    layer('LABELS', 3),
    layer('DIMS', 1),
    '0', 'ENDTAB',
    // Text style for TEXT entities.
    '0', 'TABLE', '2', 'STYLE', '70', '1',
    ['0', 'STYLE', '2', 'STANDARD', '70', '0', '40', '0.0', '41', '1.0',
     '50', '0.0', '71', '0', '42', '2.5', '3', 'txt', '4', ''].join(NL),
    '0', 'ENDTAB',
    '0', 'ENDSEC',
  ].join(NL);
}

function layer(name: string, color: number): string {
  return ['0', 'LAYER', '2', name, '70', '0', '62', String(color), '6', 'CONTINUOUS'].join(NL);
}

function footer(): string {
  // Just the EOF marker. The caller closes ENTITIES with its own ENDSEC —
  // emitting another here produced a stray ENDSEC that strict readers
  // (several waterjet CAM importers) rejected the whole file over.
  return ['0', 'EOF'].join(NL);
}

// ---------------------------------------------------------------------------
// Entity helpers
// ---------------------------------------------------------------------------
function line(layer: string, x1: number, y1: number, x2: number, y2: number): string {
  return [
    '0', 'LINE',
    '8', layer,
    '10', f(x1), '20', f(y1), '30', '0',
    '11', f(x2), '21', f(y2), '31', '0',
  ].join(NL);
}

/**
 * Classic R12 polyline: POLYLINE header + one VERTEX entity per point +
 * SEQEND. LWPOLYLINE would be ~3× smaller but is an R14 entity — strict R12
 * readers (old waterjet/plasma CAM) reject the whole file over it.
 */
function polyline(layer: string, points: Vec2[], closed = true): string {
  const out: string[] = [
    '0', 'POLYLINE',
    '8', layer,
    '66', '1',                    // vertices follow
    '70', closed ? '1' : '0',
    '10', '0', '20', '0', '30', '0', // dummy point, required by the spec
  ];
  for (const [x, y] of points) {
    out.push('0', 'VERTEX', '8', layer, '10', f(x), '20', f(y), '30', '0');
  }
  out.push('0', 'SEQEND', '8', layer);
  return out.join(NL);
}

function text(layer: string, x: number, y: number, height: number, str: string, hAlign: 0 | 1 | 2 = 1): string {
  // group 72 = 1 → centered horizontally; we also need group 11 anchor for non-zero alignment
  return [
    '0', 'TEXT',
    '8', layer,
    '10', f(x), '20', f(y), '30', '0',
    '40', f(height),
    '1', str,
    '72', String(hAlign),
    '11', f(x), '21', f(y), '31', '0',
  ].join(NL);
}

function f(n: number): string {
  return Number.isFinite(n) ? n.toFixed(4) : '0';
}

// ---------------------------------------------------------------------------
// Dimension primitive: line with arrow caps + label centered above the line.
// Works for horizontal or vertical dims (orientation derived from endpoints).
// ---------------------------------------------------------------------------
function dimension(
  ax: number, ay: number,
  bx: number, by: number,
  extOff: number,
  label: string,
): string {
  // Extension lines go perpendicular to the dimension line.
  // For horizontal (ay == by) dim, extension lines run in -Y.
  // For vertical   (ax == bx) dim, extension lines run in -X.
  const out: string[] = [];
  const isHorizontal = Math.abs(ay - by) < Math.abs(ax - bx);
  if (isHorizontal) {
    // dim line is at y = ay; extensions drop down by extOff
    out.push(line('DIMS', ax, ay - extOff, bx, ay - extOff));
    out.push(line('DIMS', ax, ay, ax, ay - extOff - 2));
    out.push(line('DIMS', bx, by, bx, by - extOff - 2));
    // arrows
    const sign = bx > ax ? 1 : -1;
    out.push(arrowHead(ax + sign * 0, ay - extOff, sign, true));
    out.push(arrowHead(bx - sign * 0, by - extOff, -sign, true));
    // text centered above dim line
    out.push(text('DIMS', (ax + bx) / 2, ay - extOff + 1, DIM_TEXT_H, label));
  } else {
    out.push(line('DIMS', ax - extOff, ay, bx - extOff, by));
    out.push(line('DIMS', ax, ay, ax - extOff - 2, ay));
    out.push(line('DIMS', bx, by, bx - extOff - 2, by));
    const sign = by > ay ? 1 : -1;
    out.push(arrowHead(ax - extOff, ay + sign * 0, sign, false));
    out.push(arrowHead(bx - extOff, by - sign * 0, -sign, false));
    out.push(text('DIMS', ax - extOff - 1, (ay + by) / 2, DIM_TEXT_H, label, 2));
  }
  return out.join(NL);
}

function arrowHead(x: number, y: number, sign: number, horizontal: boolean): string {
  // Simple solid triangle arrow drawn as a closed LWPOLYLINE.
  let pts: Vec2[];
  if (horizontal) {
    pts = [[x, y], [x + sign * ARROW_LEN, y + ARROW_W], [x + sign * ARROW_LEN, y - ARROW_W]];
  } else {
    pts = [[x, y], [x + ARROW_W, y + sign * ARROW_LEN], [x - ARROW_W, y + sign * ARROW_LEN]];
  }
  return polyline('DIMS', pts, true);
}

// ---------------------------------------------------------------------------
// Build DXF for one sheet
// ---------------------------------------------------------------------------
export function sheetToDxf(sheet: NestSheet, opt: DxfOptions): string {
  const ents: string[] = [];

  // Sheet border
  ents.push(polyline('SHEET', [
    [0, 0],
    [opt.sheetW, 0],
    [opt.sheetW, opt.sheetL],
    [0, opt.sheetL],
  ]));

  // Margin (dashed-look — we just stroke a closed poly on its own layer).
  // Omitted in cut-file mode — it isn't a contour the machine cuts.
  if (opt.margin > 0 && !opt.outlinesOnly) {
    const m = opt.margin;
    ents.push(polyline('MARGIN', [
      [m, m],
      [opt.sheetW - m, m],
      [opt.sheetW - m, opt.sheetL - m],
      [m, opt.sheetL - m],
    ]));
  }

  // Parts
  for (const p of sheet.parts) {
    ents.push(partEntities(p, opt));
  }

  // Sheet dimensions
  if (opt.sheetDimensions && !opt.outlinesOnly) {
    ents.push(dimension(0, 0, opt.sheetW, 0, DIM_OFFSET + 5, fmtDim(opt.sheetW, opt.units)));
    ents.push(dimension(0, 0, 0, opt.sheetL, DIM_OFFSET + 5, fmtDim(opt.sheetL, opt.units)));
  }

  // Extents pad out past the dimension lines drawn below/left of the sheet.
  const pad = DIM_OFFSET + 25;
  return [
    header(-pad, -pad, opt.sheetW + pad, opt.sheetL + pad),
    tables(),
    // Empty BLOCKS section — part of the canonical R12 skeleton; some strict
    // readers treat its absence as a malformed file.
    '0', 'SECTION', '2', 'BLOCKS', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES', ...ents, '0', 'ENDSEC',
    footer(),
  ].join(NL);
}

function partEntities(p: PlacedPart, opt: DxfOptions): string {
  const out: string[] = [];

  // Outer ring translated to sheet coords
  const outerWorld: Vec2[] = p.outer.map(([x, y]) => [x + p.x, y + p.y]);
  out.push(polyline('PARTS', outerWorld));

  // Holes
  for (const h of p.holes) {
    out.push(polyline('PARTS', h.map(([x, y]) => [x + p.x, y + p.y])));
  }

  // Cut-file mode stops here — outlines + holes only, nothing else.
  if (opt.outlinesOnly) return out.join(NL);

  // Label centered on AABB
  const cx = p.x + p.w / 2;
  const cy = p.y + p.h / 2;
  out.push(text('LABELS', cx, cy + TEXT_H * 0.4, TEXT_H, `${p.partName} #${p.instance}`));
  out.push(text('LABELS', cx, cy - TEXT_H * 0.8, TEXT_H * 0.7, `${fmtDim(p.w, opt.units)} x ${fmtDim(p.h, opt.units)}`));

  // Per-part dimensions on outside of part AABB
  if (opt.partDimensions) {
    out.push(dimension(p.x, p.y, p.x + p.w, p.y, DIM_OFFSET, fmtDim(p.w, opt.units)));
    out.push(dimension(p.x, p.y, p.x, p.y + p.h, DIM_OFFSET, fmtDim(p.h, opt.units)));
  }

  return out.join(NL);
}

// ---------------------------------------------------------------------------
// Trigger a download for a single DXF string
// ---------------------------------------------------------------------------
export function downloadDxf(filename: string, dxf: string) {
  const blob = new Blob([dxf], { type: 'application/dxf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}
