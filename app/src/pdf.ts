/**
 * PDF export of nest results.
 *
 * One PDF per job. First page = summary (sheet count, yield, per-thickness
 * breakdown, inventory check). Subsequent pages = one per cut sheet, drawn
 * to scale-to-fit on Letter landscape, with part outlines, labels and
 * dimensions.
 *
 * Uses jsPDF — small, dependency-free, and the de-facto browser PDF library.
 */

import { jsPDF } from 'jspdf';
import type { NestResult, NestSheet, PlacedPart } from './nest';
import { fmtDim, fmtArea, type Units } from './units';
import { assignPartLabels, allCutSteps, type PartLabel } from './instructions';

export type PdfPaper =
  | 'widescreen-16-9'
  | 'letter-landscape' | 'letter-portrait'
  | 'legal-landscape'  | 'legal-portrait'
  | 'tabloid-landscape'
  | 'a4-landscape';

export interface PdfOptions {
  sheetW: number;       // mm
  sheetL: number;       // mm
  margin: number;       // mm
  kerf: number;         // mm
  units: Units;
  inventoryCheck?: InventoryCheck[];
  jobName?: string;
  paper?: PdfPaper;
  currency?: string;
  jobCost?: number;
  edgeBandingMm?: number;
  /** PNG data URLs from the 3D viewer for the assembly guide page.
   *  DEPRECATED in favor of `cabinets` — kept for backward-compat. */
  assembledPng?: string;
  explodedPng?: string;
  /** One entry per unique STEP file (cabinet). Each is rendered as its
   *  own assembly page so multi-cabinet jobs don't share one snapshot. */
  cabinets?: CabinetSnapshot[];
}

export interface CabinetSnapshot {
  /** Display name (typically the source STEP filename). */
  name: string;
  /** Letter IDs (e.g. "1a", "2c") of every panel that belongs to this
   *  cabinet — drawn as a small inventory list on the assembly page. */
  partIds: string[];
  /** Snapshots showing ONLY this cabinet's panels (others hidden). */
  assembledPng: string;
  explodedPng: string;
}

export interface InventoryCheck {
  thickness: number;
  needed: number;
  available: number;
  label: string;
}

// pt-based page sizes (1 pt = 1/72 in).
// jsPDF accepts either a named format ('letter', 'a4', etc.) or an explicit
// [w, h] tuple for custom sizes — the widescreen size is custom.
const PAPER_DIMS: Record<
  PdfPaper,
  { w: number; h: number; format: string | [number, number]; orient: 'landscape' | 'portrait' }
> = {
  // PowerPoint widescreen 16:9 — 13.33" × 7.5" → 960 × 540 pt
  'widescreen-16-9':   { w: 960,  h: 540,  format: [960, 540], orient: 'landscape' },
  'letter-landscape':  { w: 792,  h: 612,  format: 'letter',   orient: 'landscape' },
  'letter-portrait':   { w: 612,  h: 792,  format: 'letter',   orient: 'portrait'  },
  'legal-landscape':   { w: 1008, h: 612,  format: 'legal',    orient: 'landscape' },
  'legal-portrait':    { w: 612,  h: 1008, format: 'legal',    orient: 'portrait'  },
  'tabloid-landscape': { w: 1224, h: 792,  format: 'tabloid',  orient: 'landscape' },
  'a4-landscape':      { w: 842,  h: 595,  format: 'a4',       orient: 'landscape' },
};
const PAGE_PAD = 36; // 0.5"

export function buildPdf(result: NestResult, opt: PdfOptions): jsPDF {
  const paper = opt.paper ?? 'widescreen-16-9';
  const dims = PAPER_DIMS[paper];
  const doc = new jsPDF({ orientation: dims.orient, unit: 'pt', format: dims.format });

  const labels = assignPartLabels(result);

  // Track which "section" each page belongs to so the post-pass can draw
  // headers like "Cut sheet (2 of 4)" using the section's local page count.
  const sectionPerPage: string[] = [];
  const tagSection = (name: string) => sectionPerPage.push(name);
  const addPage = (section: string) => {
    doc.addPage(dims.format, dims.orient);
    tagSection(section);
  };

  // 1. COVER — job summary (sheets / yield / cost / cabinets list)
  tagSection('Cover');
  drawSummary(doc, result, opt, dims);

  // 2. SHOPPING LIST — what to buy first
  addPage('Shopping list');
  drawShoppingListPage(doc, opt, dims);

  // 3. PARTS OVERVIEW — all panels grouped by unique part, dimensions
  addPage('Parts');
  drawPartsOverview(doc, labels, opt, dims, tagSection);

  // 4. PER SHEET — layout page first, then its cut sequence cards.
  //    Spillover pages within a sheet are tagged "Sheet N" so the
  //    header reads "Sheet 3 (page 2 of 4)".
  for (const group of result.groups) {
    for (const sheet of group.sheets) {
      const sectionName = `Sheet ${sheet.globalIndex}`;
      addPage(sectionName);
      drawSheet(doc, sheet, opt, dims, labels);
      // The sheet's cuts come on the next page(s) — same section so they
      // share the "Sheet 3 (2 of 3)" pagination header.
      drawCutsForSingleSheet(doc, sheet, opt, dims,
        () => { addPage(sectionName); });
    }
  }

  // 5. ASSEMBLY — one page per cabinet (per source STEP file)
  if (opt.cabinets && opt.cabinets.length > 0) {
    for (const cab of opt.cabinets) {
      const sectionName = `Assembly · ${cab.name}`;
      addPage(sectionName);
      drawCabinetAssembly(doc, cab, opt, dims);
    }
  } else if (opt.assembledPng && opt.explodedPng) {
    // Backwards-compat fallback: single all-cabinet assembly page.
    addPage('Assembly');
    drawAssemblyGuide(doc, opt, dims);
  }

  // Post-pass: add header/footer to every page except the cover.
  paginateAndDecorate(doc, dims, opt, sectionPerPage);

  return doc;
}

/**
 * Assembly guide page: assembled 3D view on the left, exploded view on
 * the right. Captions tell the user how to read it (colors → Parts
 * overview letters; exploded arrows = assembly direction).
 */
function drawAssemblyGuide(
  doc: jsPDF,
  opt: PdfOptions,
  dims: { w: number; h: number },
) {
  const PAGE_W = dims.w;
  const PAGE_H = dims.h;

  // Header
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.text('Assembly guide', PAGE_PAD, PAGE_PAD + 6);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(120);
  doc.text(
    'Each panel keeps its 3D color — find the matching letter on the Parts overview page. The exploded view shows the direction each panel comes from when assembling.',
    PAGE_PAD, PAGE_PAD + 24, { maxWidth: PAGE_W - 2 * PAGE_PAD },
  );
  doc.setTextColor(0);

  // Two image panels side by side
  const top = PAGE_PAD + 50;
  const bottom = PAGE_H - PAGE_PAD - 26;
  const gutter = 18;
  const innerW = PAGE_W - 2 * PAGE_PAD;
  const panelW = (innerW - gutter) / 2;
  const panelH = bottom - top;

  // Caption labels under each image
  const labelY = bottom + 18;

  if (opt.assembledPng) {
    drawSnapshotPanel(doc, opt.assembledPng, PAGE_PAD, top, panelW, panelH);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(40);
    doc.text('Assembled', PAGE_PAD, labelY, { align: 'left' });
  }
  if (opt.explodedPng) {
    drawSnapshotPanel(doc, opt.explodedPng, PAGE_PAD + panelW + gutter, top, panelW, panelH);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(40);
    doc.text('Exploded', PAGE_PAD + panelW + gutter, labelY, { align: 'left' });
  }
  doc.setTextColor(0);
}

/**
 * Draw an image data URL inside (x, y, w, h), centered + aspect-preserved,
 * with a hairline border and a light background "stage" so transparency
 * (if any) doesn't blow out against the page.
 */
function drawSnapshotPanel(
  doc: jsPDF,
  dataUrl: string,
  x: number, y: number, w: number, h: number,
) {
  // Frame
  doc.setFillColor(247, 246, 243);
  doc.setDrawColor(220);
  doc.setLineWidth(0.6);
  doc.rect(x, y, w, h, 'FD');

  // Aspect-fit the image. jsPDF's addImage needs explicit dims; we don't
  // know the image's native ratio without decoding, so we fit it to the
  // panel with a small inset and let the image's own aspect dominate.
  const inset = 6;
  try {
    // addImage with type 'PNG'. jsPDF will scale to fit (w, h).
    doc.addImage(dataUrl, 'PNG', x + inset, y + inset, w - 2 * inset, h - 2 * inset, undefined, 'FAST');
  } catch (e) {
    // If the image fails to embed, draw a placeholder
    doc.setTextColor(160);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text('Snapshot unavailable', x + w / 2, y + h / 2, { align: 'center' });
    doc.setTextColor(0);
  }
}

// ---------------------------------------------------------------------------
// Summary page
// ---------------------------------------------------------------------------
function drawSummary(doc: jsPDF, result: NestResult, opt: PdfOptions, dims: { w: number; h: number }) {
  const PAGE_W = dims.w;
  const PAGE_H = dims.h;
  let y = PAGE_PAD;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.text(opt.jobName || 'Plywood cut estimate', PAGE_PAD, y + 14);
  y += 36;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(120);
  doc.text(
    `Sheet ${fmtDim(opt.sheetW, opt.units)} × ${fmtDim(opt.sheetL, opt.units)}   ·   margin ${fmtDim(opt.margin, opt.units)}   ·   kerf ${fmtDim(opt.kerf, opt.units)}   ·   generated ${new Date().toLocaleString()}`,
    PAGE_PAD,
    y,
  );
  y += 22;

  // Metrics row
  doc.setTextColor(0);
  doc.setFontSize(12);
  const metrics: [string, string][] = [
    ['Sheets', String(result.totalSheets)],
    ['Yield', `${(result.yield * 100).toFixed(1)}%`],
    ['Waste', fmtArea(result.totalSheetArea - result.totalPartArea, opt.units)],
  ];
  if (opt.edgeBandingMm && opt.edgeBandingMm > 0) {
    metrics.push(['Edge banding', `${(opt.edgeBandingMm / (opt.units === 'in' ? 25.4 * 12 : 1000)).toFixed(1)} ${opt.units === 'in' ? 'ft' : 'm'}`]);
  }
  if (opt.jobCost && opt.jobCost > 0 && opt.currency) {
    try {
      metrics.push(['Job cost', new Intl.NumberFormat(undefined, { style: 'currency', currency: opt.currency }).format(opt.jobCost)]);
    } catch { /* unknown currency */ }
  }
  const colW = (PAGE_W - 2 * PAGE_PAD) / metrics.length;
  metrics.forEach(([k, v], i) => {
    const x = PAGE_PAD + i * colW;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text(k.toUpperCase(), x, y);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.setTextColor(0);
    doc.text(v, x, y + 18);
  });
  y += 50;

  // Per-thickness breakdown
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Per-thickness breakdown', PAGE_PAD, y);
  y += 14;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  const hdr = ['Thickness', 'Sheets', 'Parts placed', 'Unplaced'];
  drawRow(doc, hdr, PAGE_PAD, y, [120, 80, 100, 80], true);
  y += 14;
  for (const g of result.groups) {
    const placed = g.sheets.reduce((acc, s) => acc + s.parts.length, 0);
    drawRow(
      doc,
      [fmtDim(g.thickness, opt.units), String(g.sheets.length), String(placed), String(g.unplaced.length)],
      PAGE_PAD,
      y,
      [120, 80, 100, 80],
    );
    y += 14;
    if (y > PAGE_H - PAGE_PAD - 50) break;
  }

  // Inventory check
  if (opt.inventoryCheck && opt.inventoryCheck.length > 0) {
    y += 14;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('Inventory check', PAGE_PAD, y);
    y += 14;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    drawRow(doc, ['Material', 'Need', 'Have', 'Shortfall'], PAGE_PAD, y, [220, 80, 80, 100], true);
    y += 14;
    for (const ic of opt.inventoryCheck) {
      const shortfall = Math.max(0, ic.needed - ic.available);
      drawRow(
        doc,
        [ic.label, String(ic.needed), String(ic.available), shortfall > 0 ? `Buy ${shortfall}` : 'OK'],
        PAGE_PAD,
        y,
        [220, 80, 80, 100],
      );
      y += 14;
      if (y > PAGE_H - PAGE_PAD) break;
    }
  }
}

function drawRow(doc: jsPDF, cols: string[], x: number, y: number, widths: number[], header = false) {
  if (header) doc.setFont('helvetica', 'bold');
  else doc.setFont('helvetica', 'normal');
  let cx = x;
  for (let i = 0; i < cols.length; i++) {
    doc.text(cols[i], cx, y);
    cx += widths[i];
  }
}

// ---------------------------------------------------------------------------
// One sheet page
// ---------------------------------------------------------------------------
function drawSheet(doc: jsPDF, sheet: NestSheet, opt: PdfOptions, dims: { w: number; h: number }, labels?: Map<string, PartLabel>) {
  const PAGE_W = dims.w;
  const PAGE_H = dims.h;
  // Use the sheet's actual chosen dims (auto-orient may have swapped them)
  const swMm = sheet.sheetW;
  const slMm = sheet.sheetL;
  // Header
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text(
    `Sheet ${sheet.index} · ${fmtDim(sheet.thickness, opt.units)} thick · ${sheet.parts.length} parts`,
    PAGE_PAD,
    PAGE_PAD - 4,
  );
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(120);
  const fill = sheet.parts.length > 0
    ? (sheet.usedArea / (swMm * slMm)) * 100
    : 0;
  doc.text(
    `Sheet ${fmtDim(swMm, opt.units)} × ${fmtDim(slMm, opt.units)}   ·   ${fill.toFixed(1)}% fill`,
    PAGE_W - PAGE_PAD,
    PAGE_PAD - 4,
    { align: 'right' },
  );
  doc.setTextColor(0);

  // Available drawing area
  const drawX = PAGE_PAD;
  const drawY = PAGE_PAD + 10;
  const drawW = PAGE_W - 2 * PAGE_PAD;
  const drawH = PAGE_H - drawY - PAGE_PAD;

  // Reserve room for dimension lines outside the sheet
  const dimRoom = 26;
  const innerW = drawW - dimRoom;
  const innerH = drawH - dimRoom;

  const scale = Math.min(innerW / swMm, innerH / slMm);
  const sheetPtW = swMm * scale;
  const sheetPtH = slMm * scale;

  // Center horizontally, top-align vertically
  const ox = drawX + dimRoom + (innerW - sheetPtW) / 2;
  const oy = drawY + (innerH - sheetPtH) / 2;

  // Sheet — cream plywood fill + warm border so colored parts read clearly
  doc.setFillColor(245, 239, 217);
  doc.setDrawColor(180, 162, 112);
  doc.setLineWidth(1.0);
  doc.rect(ox, oy, sheetPtW, sheetPtH, 'FD');

  // Margin
  if (opt.margin > 0) {
    doc.setDrawColor(180);
    doc.setLineWidth(0.4);
    doc.setLineDashPattern([3, 3], 0);
    doc.rect(
      ox + opt.margin * scale,
      oy + opt.margin * scale,
      (swMm - 2 * opt.margin) * scale,
      (slMm - 2 * opt.margin) * scale,
      'S',
    );
    doc.setLineDashPattern([], 0);
  }

  // Parts
  for (const p of sheet.parts) {
    drawPart(doc, p, ox, oy, scale, opt, `${sheet.globalIndex}${p.panelLabel}`);
  }

  // Overall sheet dimensions outside the sheet
  drawDimH(doc, ox, ox + sheetPtW, oy + sheetPtH + 14, fmtDim(swMm, opt.units));
  drawDimV(doc, oy, oy + sheetPtH, ox - 14, fmtDim(slMm, opt.units));
}

function drawPart(
  doc: jsPDF,
  p: PlacedPart,
  ox: number,
  oy: number,
  scale: number,
  opt: PdfOptions,
  letter?: string,
) {
  const [r, g, b] = hexToRgb(p.color);
  const GS = (doc as any).GState;
  doc.setFillColor(r, g, b);
  doc.setDrawColor(Math.floor(r * 0.55), Math.floor(g * 0.55), Math.floor(b * 0.55));
  doc.setLineWidth(0.7);

  // Outer ring fill at 50% transparency so the cream sheet shows through —
  // matches the cut-card overlay convention.
  if (GS) (doc as any).setGState(new GS({ opacity: 0.50 }));
  drawPolygon(doc, p.outer, p.x, p.y, ox, oy, scale, 'F');
  if (GS) (doc as any).setGState(new GS({ opacity: 1 }));
  // Stroke (solid darker) sits on top for a crisp panel boundary.
  drawPolygon(doc, p.outer, p.x, p.y, ox, oy, scale, 'S');

  // Holes: fill white then stroke
  doc.setFillColor(255, 255, 255);
  for (const hole of p.holes) {
    drawPolygon(doc, hole, p.x, p.y, ox, oy, scale, 'F');
    doc.setDrawColor(Math.floor(r * 0.55), Math.floor(g * 0.55), Math.floor(b * 0.55));
    drawPolygon(doc, hole, p.x, p.y, ox, oy, scale, 'S');
  }

  const px = ox + p.x * scale;
  const py = oy + p.y * scale;
  const pwPt = p.w * scale;
  const phPt = p.h * scale;
  const cx = px + pwPt / 2;
  const cy = py + phPt / 2;
  const partPt = Math.min(pwPt, phPt);
  doc.setTextColor(20);

  // Per-sheet panel id ("1a", "2c") + tiny dim subtitle. ANSI policy:
  // per-part dimensions live in the Parts overview cards, not stamped on
  // every panel in the layout (which got noisy fast). The layout shows
  // the id; the user looks up sizes in the Parts overview.
  if (letter) {
    const big = Math.max(10, Math.min(36, partPt * 0.36));
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(big);
    doc.text(letter, cx, cy + big * 0.18, { align: 'center' });

    const subSize = Math.max(4, Math.min(10, partPt * 0.085));
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(subSize);
    doc.setTextColor(80);
    doc.text(
      `${fmtDim(p.w, opt.units)} × ${fmtDim(p.h, opt.units)}`,
      cx,
      cy + big * 0.55 + subSize,
      { align: 'center' },
    );
    doc.setTextColor(0);
  }
}

/**
 * Draw width + height dimension marks on the bottom and left edges of a
 * part rectangle. Lives INSIDE the part bounds so it never bleeds into
 * adjacent panels. Tick lines + value text only — no extension lines, to
 * keep it clean and Notion-like.
 */
function drawPartDims(
  doc: jsPDF,
  px: number,
  py: number,
  pwPt: number,
  phPt: number,
  realW: number,
  realH: number,
  opt: PdfOptions,
) {
  const inset = 6;
  const tickLen = 4;
  const textSize = 8.5;
  doc.setDrawColor(60);
  doc.setLineWidth(0.5);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(textSize);
  doc.setTextColor(60);

  // BOTTOM (width) — horizontal dim line just above the part's bottom edge
  const by = py + phPt - inset;
  doc.line(px + inset, by, px + pwPt - inset, by);
  doc.line(px + inset, by - tickLen / 2, px + inset, by + tickLen / 2);
  doc.line(px + pwPt - inset, by - tickLen / 2, px + pwPt - inset, by + tickLen / 2);
  // Background nub behind text to keep it readable on top of the fill
  doc.setFillColor(255, 255, 255);
  const wText = fmtDim(realW, opt.units);
  const wWidth = doc.getTextWidth(wText) + 6;
  doc.rect(px + pwPt / 2 - wWidth / 2, by - textSize * 0.95, wWidth, textSize + 4, 'F');
  doc.text(wText, px + pwPt / 2, by - 2, { align: 'center' });

  // LEFT (height) — vertical dim line just inside the part's left edge
  const lx = px + inset;
  doc.line(lx, py + inset, lx, py + phPt - inset);
  doc.line(lx - tickLen / 2, py + inset, lx + tickLen / 2, py + inset);
  doc.line(lx - tickLen / 2, py + phPt - inset, lx + tickLen / 2, py + phPt - inset);
  const hText = fmtDim(realH, opt.units);
  const hWidth = doc.getTextWidth(hText) + 6;
  // Rotated text — paint a background rect rotated to match
  doc.setFillColor(255, 255, 255);
  const ty = py + phPt / 2;
  doc.rect(lx + 2, ty - hWidth / 2, textSize + 4, hWidth, 'F');
  doc.text(hText, lx + 4 + textSize, ty, { align: 'center', angle: 90 });
  doc.setTextColor(0);
}

function drawPolygon(
  doc: jsPDF,
  ring: [number, number][],
  offX: number,
  offY: number,
  ox: number,
  oy: number,
  scale: number,
  mode: 'S' | 'F' | 'FD',
) {
  if (ring.length < 3) return;
  const pts: [number, number][] = ring.map(([x, y]) => [
    ox + (x + offX) * scale,
    oy + (y + offY) * scale,
  ]);
  // jsPDF.lines takes deltas — use moveTo + lineTo via custom path through 'lines'.
  const lines: [number, number][] = [];
  for (let i = 1; i < pts.length; i++) {
    lines.push([pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]]);
  }
  // close
  lines.push([pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]]);
  doc.lines(lines, pts[0][0], pts[0][1], [1, 1], mode, true);
}

// ---------------------------------------------------------------------------
// Dimension primitives
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// ANSI dimension helpers — consistent everywhere.
// Convention:
//   - Witness lines extend from the object edge across the dim line, with
//     a 1pt gap from the edge.
//   - Dim line spans between witness lines with filled triangular
//     arrowheads pointing inward.
//   - Text is HORIZONTAL (unidirectional), centered above the dim line
//     (or beside it for vertical dims), in a fixed font size for the whole
//     drawing — readers can scan the values consistently.
// ---------------------------------------------------------------------------
const DIM_COLOR: [number, number, number] = [110, 110, 110];
const DIM_LINE_W = 0.5;
const DIM_ARROW_LEN = 5;
const DIM_ARROW_W = 1.8;
const DIM_TEXT_PT = 8;
const DIM_WITNESS_OVER = 5;
const DIM_WITNESS_GAP = 1.5;

function drawDimH(doc: jsPDF, x1: number, x2: number, y: number, label: string) {
  doc.setDrawColor(...DIM_COLOR);
  doc.setLineWidth(DIM_LINE_W);
  // Witness lines from the object edge across the dim line
  doc.line(x1, y - DIM_WITNESS_OVER - 2, x1, y + DIM_WITNESS_GAP);
  doc.line(x2, y - DIM_WITNESS_OVER - 2, x2, y + DIM_WITNESS_GAP);
  // Dim line
  doc.line(x1, y, x2, y);
  // Inward-pointing triangular arrowheads
  doc.setFillColor(...DIM_COLOR);
  drawDimTri(doc, x1, y, +1, 0);
  drawDimTri(doc, x2, y, -1, 0);
  // Horizontal label centered above the dim line
  doc.setTextColor(...DIM_COLOR);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(DIM_TEXT_PT);
  doc.text(label, (x1 + x2) / 2, y - 3, { align: 'center' });
  doc.setTextColor(0);
}

function drawDimV(doc: jsPDF, y1: number, y2: number, x: number, label: string) {
  doc.setDrawColor(...DIM_COLOR);
  doc.setLineWidth(DIM_LINE_W);
  // Witness lines
  doc.line(x - DIM_WITNESS_GAP, y1, x + DIM_WITNESS_OVER + 2, y1);
  doc.line(x - DIM_WITNESS_GAP, y2, x + DIM_WITNESS_OVER + 2, y2);
  doc.line(x, y1, x, y2);
  doc.setFillColor(...DIM_COLOR);
  drawDimTri(doc, x, y1, 0, +1);
  drawDimTri(doc, x, y2, 0, -1);
  // Vertical text: rotated 90° beside the dim line
  doc.setTextColor(...DIM_COLOR);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(DIM_TEXT_PT);
  doc.text(label, x - 4, (y1 + y2) / 2, { align: 'center', angle: 90 });
  doc.setTextColor(0);
}

/** Small filled triangle at (x, y) pointing in (dx, dy). */
function drawDimTri(doc: jsPDF, x: number, y: number, dx: number, dy: number) {
  let p1: [number, number], p2: [number, number], p3: [number, number];
  if (dx !== 0) {
    p1 = [x, y];
    p2 = [x + dx * DIM_ARROW_LEN, y - DIM_ARROW_W];
    p3 = [x + dx * DIM_ARROW_LEN, y + DIM_ARROW_W];
  } else {
    p1 = [x, y];
    p2 = [x - DIM_ARROW_W, y + dy * DIM_ARROW_LEN];
    p3 = [x + DIM_ARROW_W, y + dy * DIM_ARROW_LEN];
  }
  // jsPDF.lines uses relative coords + close=true
  const lines: [number, number][] = [
    [p2[0] - p1[0], p2[1] - p1[1]],
    [p3[0] - p2[0], p3[1] - p2[1]],
    [p1[0] - p3[0], p1[1] - p3[1]],
  ];
  doc.lines(lines, p1[0], p1[1], [1, 1], 'F', true);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function hexToRgb(hex: string): [number, number, number] {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return [200, 200, 200];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function downloadPdf(filename: string, doc: jsPDF) {
  doc.save(filename);
}

// ---------------------------------------------------------------------------
// Cut cards for ONE sheet, starting on the current page (after the layout
// has been drawn at the top, the cards flow below it). Calls `openNewPage`
// to spillover so the caller can tag the new page with the right section.
// ---------------------------------------------------------------------------
function drawCutsForSingleSheet(
  doc: jsPDF,
  sheet: NestSheet,
  opt: PdfOptions,
  dims: { w: number; h: number },
  openNewPage: () => void,
) {
  const PAGE_W = dims.w;
  const PAGE_H = dims.h;
  // Generate a SheetCuts wrapper (cutStepsForSheet handles guillotine vs
  // fallback). We need the same shape drawCutCard expects.
  const sc = (allCutSteps({ groups: [{ thickness: sheet.thickness, sheets: [sheet], unplaced: [] }] } as any))[0];
  if (!sc || sc.steps.length === 0) return;

  // Start a new page for the cut cards — keeps the sheet layout page clean.
  openNewPage();

  const cardGutter = 12;
  const cardCaptionH = 22;
  const cols = PAGE_W > 1000 ? 6 : PAGE_W > 750 ? 5 : 4;
  const innerW = PAGE_W - 2 * PAGE_PAD;
  const cardW = (innerW - cardGutter * (cols - 1)) / cols;
  const sheetAspect = sc.sheetL / sc.sheetW;
  const cardDiagH = cardW * sheetAspect;
  const cardH = cardDiagH + cardCaptionH;
  const TOP = PAGE_PAD + 28;
  const BOTTOM = PAGE_H - PAGE_PAD;

  // Header
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(20);
  doc.text(
    `Sheet ${sc.globalIndex} cut sequence  ·  ${sc.steps.length} cuts`,
    PAGE_PAD, PAGE_PAD + 10,
  );

  let y = TOP;
  let col = 0;
  for (let i = 0; i < sc.steps.length; i++) {
    if (y + cardH > BOTTOM) {
      openNewPage();
      y = TOP;
      col = 0;
    }
    const x = PAGE_PAD + col * (cardW + cardGutter);
    drawCutCard(doc, sc, sheet.parts, i, x, y, cardW, cardDiagH, opt);
    col++;
    if (col >= cols) { col = 0; y += cardH + cardGutter; }
  }
}

// ---------------------------------------------------------------------------
// Per-cabinet (per STEP file) assembly page — IKEA-inspired:
//   - Cabinet name as the page title
//   - Parts inventory on the left (panel IDs with quantities)
//   - Big exploded view on the right with the assembled view below
//   - Caption: match colors / IDs to the per-sheet layouts
// ---------------------------------------------------------------------------
function drawCabinetAssembly(
  doc: jsPDF,
  cab: CabinetSnapshot,
  opt: PdfOptions,
  dims: { w: number; h: number },
) {
  const PAGE_W = dims.w;
  const PAGE_H = dims.h;

  // Header
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(20);
  doc.text(cab.name, PAGE_PAD, PAGE_PAD + 4);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(120);
  doc.text(
    `${cab.partIds.length} panels — match each panel id to the layout pages`,
    PAGE_PAD, PAGE_PAD + 22,
  );
  doc.setTextColor(0);

  // Two-column layout: parts inventory (left, 25%) + diagrams (right, 75%)
  const top = PAGE_PAD + 42;
  const bottom = PAGE_H - PAGE_PAD - 8;
  const gutter = 18;
  const inventoryW = Math.min(180, (PAGE_W - 2 * PAGE_PAD) * 0.22);
  const diagramX = PAGE_PAD + inventoryW + gutter;
  const diagramW = PAGE_W - PAGE_PAD - diagramX;
  const diagramH = bottom - top;

  // Left: parts inventory list
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.setTextColor(120);
  doc.text('PANELS', PAGE_PAD, top + 4);
  doc.setLineWidth(0.4);
  doc.setDrawColor(225);
  doc.line(PAGE_PAD, top + 9, PAGE_PAD + inventoryW, top + 9);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(40);
  let iy = top + 26;
  // Count duplicates so we can show "× 2" instead of two rows
  const counts = new Map<string, number>();
  for (const id of cab.partIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const [id, n] of counts) {
    if (iy > bottom - 12) break;
    doc.text(id, PAGE_PAD, iy);
    if (n > 1) {
      doc.setTextColor(140);
      doc.text(`× ${n}`, PAGE_PAD + 40, iy);
      doc.setTextColor(40);
    }
    iy += 14;
  }

  // Right: exploded above + assembled below, sharing the column.
  const halfH = (diagramH - gutter) / 2;
  drawSnapshotPanel(doc, cab.explodedPng, diagramX, top, diagramW, halfH);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.setTextColor(120);
  doc.text('EXPLODED', diagramX, top + halfH + 14);

  drawSnapshotPanel(doc, cab.assembledPng, diagramX, top + halfH + 20, diagramW, halfH - 20);
  doc.text('ASSEMBLED', diagramX, top + halfH + halfH + 14);
  doc.setTextColor(0);
}

// ---------------------------------------------------------------------------
// Shopping list page — same data the sidebar Shopping list shows.
// We don't have direct access to the ShoppingRow[] here, so the page renders
// the `inventoryCheck` array the caller already populates. Header + table.
// ---------------------------------------------------------------------------
function drawShoppingListPage(doc: jsPDF, opt: PdfOptions, dims: { w: number; h: number }) {
  const PAGE_W = dims.w;
  const items = opt.inventoryCheck ?? [];
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.text('Shopping list', PAGE_PAD, PAGE_PAD + 6);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(120);
  doc.text(
    items.length > 0
      ? `${items.reduce((a, x) => a + Math.max(0, x.needed - x.available), 0)} sheets to buy.`
      : 'No materials needed (empty job).',
    PAGE_W - PAGE_PAD, PAGE_PAD + 6, { align: 'right' },
  );
  doc.setTextColor(0);

  let y = PAGE_PAD + 38;
  const lineH = 18;
  // Table header — hairline under
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(110);
  const cols = [
    { key: 'Material',  x: PAGE_PAD,           w: PAGE_W - PAGE_PAD - 380, align: 'left'  as const },
    { key: 'Need',      x: PAGE_W - PAGE_PAD - 360, w: 70,  align: 'right' as const },
    { key: 'Have',      x: PAGE_W - PAGE_PAD - 280, w: 70,  align: 'right' as const },
    { key: 'Buy',       x: PAGE_W - PAGE_PAD - 200, w: 70,  align: 'right' as const },
    { key: 'Status',    x: PAGE_W - PAGE_PAD - 120, w: 120, align: 'right' as const },
  ];
  for (const c of cols) doc.text(c.key.toUpperCase(), c.x + (c.align === 'right' ? c.w : 0), y, { align: c.align });
  y += 6;
  doc.setDrawColor(220);
  doc.setLineWidth(0.5);
  doc.line(PAGE_PAD, y, PAGE_W - PAGE_PAD, y);
  y += 14;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(40);
  for (const r of items) {
    const short = Math.max(0, r.needed - r.available);
    const status = short > 0 ? `Buy ${short}` : 'OK';
    doc.text(r.label, cols[0].x, y);
    doc.text(String(r.needed), cols[1].x + cols[1].w, y, { align: 'right' });
    doc.text(String(r.available), cols[2].x + cols[2].w, y, { align: 'right' });
    doc.text(String(short), cols[3].x + cols[3].w, y, { align: 'right' });
    if (short > 0) doc.setTextColor(192, 58, 54);
    else            doc.setTextColor(80, 132, 110);
    doc.text(status, cols[4].x + cols[4].w, y, { align: 'right' });
    doc.setTextColor(40);
    y += lineH;
  }

  // Total
  y += 4;
  doc.setLineWidth(0.4);
  doc.setDrawColor(220);
  doc.line(PAGE_PAD, y, PAGE_W - PAGE_PAD, y);
  y += 18;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(40);
  doc.text('JOB COST', cols[0].x, y);
  if (opt.jobCost && opt.jobCost > 0 && opt.currency) {
    try {
      doc.text(
        new Intl.NumberFormat(undefined, { style: 'currency', currency: opt.currency }).format(opt.jobCost),
        PAGE_W - PAGE_PAD, y, { align: 'right' },
      );
    } catch { /* unknown currency */ }
  } else {
    doc.text('—', PAGE_W - PAGE_PAD, y, { align: 'right' });
  }
  doc.setTextColor(0);
}

// ---------------------------------------------------------------------------
// Cut list summary — text-mode rip-then-crosscut steps per sheet.
// (Visual versions are on the "Cut sheet" pages.)
// ---------------------------------------------------------------------------
function drawCutListSummary(
  doc: jsPDF,
  result: NestResult,
  opt: PdfOptions,
  dims: { w: number; h: number },
  tagSection?: (s: string) => void,
) {
  const PAGE_W = dims.w;
  const PAGE_H = dims.h;
  const cuts = allCutSteps(result);
  const total = cuts.reduce((a, sc) => a + sc.steps.length, 0);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.text('Cut list', PAGE_PAD, PAGE_PAD + 6);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(120);
  doc.text(
    `${total} cuts across ${cuts.length} sheets. Larger cuts first; then cut to length.`,
    PAGE_PAD, PAGE_PAD + 24, { maxWidth: PAGE_W - 2 * PAGE_PAD },
  );
  doc.setTextColor(0);

  let y = PAGE_PAD + 46;
  const lineH = 13;
  const bottom = PAGE_H - PAGE_PAD;

  for (const sc of cuts) {
    if (y > bottom - 40) { doc.addPage(); tagSection?.('Cut list'); y = PAGE_PAD + 6; }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(20);
    doc.text(
      `Sheet ${sc.globalIndex}  ·  ${fmtDim(sc.thickness, opt.units)} thick  ·  ${sc.steps.length} cuts`,
      PAGE_PAD, y,
    );
    y += 14;

    if (sc.steps.length === 0) {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(10);
      doc.setTextColor(120);
      doc.text('No interior cuts.', PAGE_PAD + 14, y);
      doc.setTextColor(0);
      y += lineH + 4;
      continue;
    }

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(40);
    for (const st of sc.steps) {
      if (y > bottom - lineH) { doc.addPage(); tagSection?.('Cut list'); y = PAGE_PAD + 6; }
      const edgeRef = st.axis === 'rip' ? 'from L of parent' : 'from B of parent';
      const label   = st.axis === 'rip' ? 'Rip' : 'Crosscut';
      doc.text(
        `${String(st.index).padStart(2, ' ')}.  ${label}  at  ${fmtDim(st.distance, opt.units)}  ${edgeRef}`,
        PAGE_PAD + 14, y,
      );
      y += lineH;
    }
    y += 6;
  }
}

// ---------------------------------------------------------------------------
// Header + footer pass.
// Skips the cover (page 1). On every other page:
//   Header (top):   left = job name           right = section · N of M
//   Footer (bot):   left = doc id (sha)       center = Page X of Y   right = date
//
// Section labels come from `sectionPerPage[i]` (1 entry per page in order).
// "N of M" within section: precomputed from sectionPerPage.
// ---------------------------------------------------------------------------
function paginateAndDecorate(
  doc: jsPDF,
  dims: { w: number; h: number },
  opt: PdfOptions,
  sectionPerPage: string[],
) {
  const PAGE_W = dims.w;
  const PAGE_H = dims.h;
  const total = doc.getNumberOfPages();
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10) + ' ' + now.toTimeString().slice(0, 5);
  const jobName = opt.jobName || 'Plywood cut estimate';

  // Per-section running counts
  const sectionTotals = new Map<string, number>();
  for (const s of sectionPerPage) sectionTotals.set(s, (sectionTotals.get(s) ?? 0) + 1);
  const sectionSoFar = new Map<string, number>();

  for (let i = 1; i <= total; i++) {
    if (i === 1) continue; // cover stays clean
    doc.setPage(i);
    const section = sectionPerPage[i - 1] ?? '';
    const idx = (sectionSoFar.get(section) ?? 0) + 1;
    sectionSoFar.set(section, idx);
    const sectionTotal = sectionTotals.get(section) ?? 1;
    drawHeaderFooter(
      doc, dims, jobName, section, idx, sectionTotal, i, total, dateStr,
    );
  }
}

function drawHeaderFooter(
  doc: jsPDF,
  dims: { w: number; h: number },
  jobName: string,
  section: string,
  sectionIdx: number,
  sectionTotal: number,
  pageNum: number,
  pageTotal: number,
  dateStr: string,
) {
  const PAGE_W = dims.w;
  const PAGE_H = dims.h;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(140);

  // HEADER — top of page, with a hairline under it
  doc.text(jobName, PAGE_PAD, 18);
  const sectionLabel = sectionTotal > 1
    ? `${section} (${sectionIdx} of ${sectionTotal})`
    : section;
  doc.text(sectionLabel, PAGE_W - PAGE_PAD, 18, { align: 'right' });
  doc.setDrawColor(225);
  doc.setLineWidth(0.4);
  doc.line(PAGE_PAD, 22, PAGE_W - PAGE_PAD, 22);

  // FOOTER — page X of Y · date
  const fy = PAGE_H - 14;
  doc.setDrawColor(225);
  doc.line(PAGE_PAD, fy - 8, PAGE_W - PAGE_PAD, fy - 8);
  doc.setTextColor(140);
  doc.text('plywood-estimator', PAGE_PAD, fy);
  doc.text(`Page ${pageNum} of ${pageTotal}`, PAGE_W / 2, fy, { align: 'center' });
  doc.text(dateStr, PAGE_W - PAGE_PAD, fy, { align: 'right' });
  doc.setTextColor(0);
}

// ---------------------------------------------------------------------------
// Parts overview (IKEA-style)
//   - Header: "Parts" + total piece count
//   - Grid of cards, each: big letter • silhouette • name • dimensions • qty
//   - Sized to fit ~6-12 cards/page depending on paper size
// ---------------------------------------------------------------------------
function drawPartsOverview(
  doc: jsPDF,
  labels: Map<string, PartLabel>,
  opt: PdfOptions,
  dims: { w: number; h: number },
  tagSection?: (s: string) => void,
) {
  const PAGE_W = dims.w;
  const PAGE_H = dims.h;
  const items = Array.from(labels.values());

  // Header
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.text('Parts overview', PAGE_PAD, PAGE_PAD + 6);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(120);
  const totalPieces = items.reduce((a, x) => a + x.totalQty, 0);
  doc.text(
    `${items.length} unique parts · ${totalPieces} pieces total`,
    PAGE_W - PAGE_PAD, PAGE_PAD + 6, { align: 'right' },
  );
  doc.setTextColor(0);

  // Grid layout
  const cols = PAGE_W > 800 ? 4 : 3;
  const gutter = 18;
  const top = PAGE_PAD + 28;
  const bottom = PAGE_PAD;
  const innerW = PAGE_W - 2 * PAGE_PAD;
  const cardW = (innerW - gutter * (cols - 1)) / cols;
  const cardH = 140;
  const rowsPerPage = Math.max(1, Math.floor((PAGE_H - top - bottom) / (cardH + gutter)));
  const perPage = cols * rowsPerPage;

  for (let i = 0; i < items.length; i++) {
    const onPage = i % perPage;
    if (i > 0 && onPage === 0) {
      doc.addPage(dims === PAPER_DIMS['letter-portrait'] ? 'letter' : undefined as any);
      tagSection?.('Parts');
    }
    const col = onPage % cols;
    const row = Math.floor(onPage / cols);
    const x = PAGE_PAD + col * (cardW + gutter);
    const y = top + row * (cardH + gutter);
    drawPartCard(doc, items[i], x, y, cardW, cardH, opt);
  }
}

function drawPartCard(
  doc: jsPDF,
  p: PartLabel,
  x: number,
  y: number,
  w: number,
  h: number,
  opt: PdfOptions,
) {
  // Card border (hairline, Notion-style)
  doc.setDrawColor(230);
  doc.setLineWidth(0.6);
  doc.rect(x, y, w, h, 'S');

  // Letter — big bold in top-left corner
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(32);
  doc.setTextColor(40);
  doc.text(p.letter, x + 12, y + 32);

  // Qty pill top-right
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(120);
  doc.text(`× ${p.totalQty}`, x + w - 12, y + 18, { align: 'right' });

  // Silhouette — scaled to fit the lower-right of the card
  const silX = x + 60;
  const silY = y + 12;
  const silMaxW = w - 60 - 14;
  const silMaxH = h - 60;
  const scale = Math.min(silMaxW / p.length, silMaxH / p.width);
  const drawW = p.length * scale;
  const drawH = p.width * scale;
  doc.setDrawColor(180);
  doc.setLineWidth(0.5);
  doc.setFillColor(248, 245, 230);
  doc.rect(silX, silY, drawW, drawH, 'FD');

  // Name + dims at the bottom
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(60);
  const name = p.partName.length > 36 ? p.partName.slice(0, 33) + '…' : p.partName;
  doc.text(name, x + 12, y + h - 20);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(20);
  doc.text(
    `${fmtDim(p.length, opt.units)} × ${fmtDim(p.width, opt.units)} × ${fmtDim(p.thickness, opt.units)}`,
    x + 12, y + h - 8,
  );
}

// ---------------------------------------------------------------------------
// Cut instructions
//   - Per sheet: numbered list of cut steps (rips first, then crosscuts)
//   - Shows distance from reference edge
// ---------------------------------------------------------------------------
function drawCutInstructions(
  doc: jsPDF,
  result: NestResult,
  opt: PdfOptions,
  dims: { w: number; h: number },
  _labels: Map<string, PartLabel>,
  tagSection?: (s: string) => void,
) {
  const PAGE_W = dims.w;
  const PAGE_H = dims.h;
  // Pair each SheetCuts with its source NestSheet so the cut cards can
  // overlay the placed parts (color-tinted under the cut lines).
  const pairs: { sc: ReturnType<typeof allCutSteps>[number]; parts: NestSheet['parts'] }[] = [];
  const cuts = allCutSteps(result);
  let pi = 0;
  for (const g of result.groups) {
    for (const s of g.sheets) {
      pairs.push({ sc: cuts[pi++], parts: s.parts });
    }
  }

  const totalCuts = cuts.reduce((a, sc) => a + sc.steps.length, 0);

  // Cover header
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.text('Cut sequence', PAGE_PAD, PAGE_PAD + 6);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(60);
  doc.text(`Total cuts to make: ${totalCuts}`, PAGE_PAD, PAGE_PAD + 24);
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(
    'For each sheet, follow the cuts in order. The bold red line is the current cut; thin gray lines are cuts already made.',
    PAGE_PAD, PAGE_PAD + 38,
  );
  doc.setTextColor(0);

  // Constants for the per-cut grid
  const TOP0 = PAGE_PAD + 58;          // y for the first row of diagrams on the cover page
  const TOP_NEW = PAGE_PAD + 28;       // y for the first row on subsequent pages (less header)
  const BOTTOM_PAD = PAGE_PAD;
  const cardGutter = 12;
  const cardCaptionH = 22;
  // Choose card width so 4–5 cards fit per row on most paper sizes
  const cols = PAGE_W > 1000 ? 6 : PAGE_W > 750 ? 5 : 4;
  const innerW = PAGE_W - 2 * PAGE_PAD;
  const cardW = (innerW - cardGutter * (cols - 1)) / cols;

  for (let sIdx = 0; sIdx < pairs.length; sIdx++) {
    const { sc, parts } = pairs[sIdx];

    // Sheet header — break to a new page if there isn't room for at least
    // one row of cards underneath it.
    const sheetAspect = sc.sheetL / sc.sheetW;
    const cardDiagH = cardW * sheetAspect;
    const cardH = cardDiagH + cardCaptionH;
    const headerH = 22;

    let y = sIdx === 0 ? TOP0 : TOP_NEW;
    if (sIdx > 0) {
      doc.addPage();
      tagSection?.('Cut sheet');
      y = TOP_NEW;
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(20);
    doc.text(
      `Sheet ${sc.globalIndex}  ·  ${fmtDim(sc.thickness, opt.units)} thick  ·  ${fmtDim(sc.sheetW, opt.units)} × ${fmtDim(sc.sheetL, opt.units)}  ·  ${sc.steps.length} cuts`,
      PAGE_PAD, y,
    );
    y += headerH;

    if (sc.steps.length === 0) {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(10);
      doc.setTextColor(120);
      doc.text('No interior cuts — single part fills the sheet.', PAGE_PAD, y + 4);
      doc.setTextColor(0);
      continue;
    }

    let col = 0;
    for (let i = 0; i < sc.steps.length; i++) {
      // Card sits at (x, y); start a new row when col fills; start a new
      // page when we'd run off the bottom.
      if (y + cardH > PAGE_H - BOTTOM_PAD) {
        doc.addPage();
        tagSection?.('Cut sheet');
        y = TOP_NEW;
        col = 0;
      }
      const x = PAGE_PAD + col * (cardW + cardGutter);
      drawCutCard(doc, sc, parts, i, x, y, cardW, cardDiagH, opt, _labels);
      col++;
      if (col >= cols) {
        col = 0;
        y += cardH + cardGutter;
      }
    }
  }
}

/**
 * Draw one cut-step card: caption above, sheet diagram below with
 * placed parts overlaid in their colors (heavily transparent), prior
 * cuts in thin white, and the current cut highlighted in red.
 */
function drawCutCard(
  doc: jsPDF,
  sc: ReturnType<typeof allCutSteps>[number],
  parts: NestSheet['parts'],
  cutIdx: number,
  x: number,
  y: number,
  cardW: number,
  diagH: number,
  opt: PdfOptions,
  labels?: Map<string, PartLabel>,
) {
  const cur = sc.steps[cutIdx];

  // Caption (above the diagram)
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(40);
  doc.text(`Cut ${cur.index}`, x, y + 9);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(90);
  const edgeRef = cur.axis === 'rip' ? 'from L edge' : 'from B edge';
  const label = cur.axis === 'rip' ? 'Rip' : 'Crosscut';
  doc.text(`${label}  ${fmtDim(cur.distance, opt.units)}  ${edgeRef}`, x, y + 20);
  doc.setTextColor(0);

  // Diagram: sheet rectangle + parts + cuts
  const diagY = y + 24;
  const scale = Math.min(cardW / sc.sheetW, diagH / sc.sheetL);
  const dW = sc.sheetW * scale;
  const dH = sc.sheetL * scale;
  const ox = x + (cardW - dW) / 2;
  const oy = diagY;

  // Sheet background — LIGHT CREAM wood. Light enough that colored
  // panels read clearly on top, but warm enough to feel like wood.
  doc.setFillColor(245, 239, 217);
  doc.setDrawColor(180, 162, 112);
  doc.setLineWidth(0.6);
  doc.rect(ox, oy, dW, dH, 'FD');

  // Part overlays — per-body COLOR at 50% opacity, or 15% if the panel
  // has already been fully separated by an earlier cut (visually "removed"
  // from the stock). Cut lines render on top so they stay readable.
  const GS = (doc as any).GState;
  for (const p of parts) {
    const isCutOff = p.separatedAt > 0 && p.separatedAt <= cutIdx;
    const alpha = isCutOff ? 0.15 : 0.50;
    if (GS) (doc as any).setGState(new GS({ opacity: alpha }));
    const [r, g, b] = hexToRgb(p.color);
    doc.setFillColor(r, g, b);
    doc.rect(ox + p.x * scale, oy + p.y * scale, p.w * scale, p.h * scale, 'F');
  }
  if (GS) (doc as any).setGState(new GS({ opacity: 1 }));

  // Per-panel labels ("3a", "3b" — sheet global index + panel letter).
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(50);
  for (const p of parts) {
    const id = `${sc.globalIndex}${p.panelLabel}`;
    const cellW = p.w * scale;
    const cellH = p.h * scale;
    const minPx = Math.min(cellW, cellH);
    if (minPx < 10) continue;
    const fs = Math.max(6, Math.min(14, minPx * 0.32));
    doc.setFontSize(fs);
    doc.text(
      id,
      ox + (p.x + p.w / 2) * scale,
      oy + (p.y + p.h / 2) * scale + fs * 0.32,
      { align: 'center' },
    );
  }

  const lengthIsY = sc.sheetL >= sc.sheetW;
  // Prior cuts as thin white lines (above the overlay). Each cut is drawn
  // WITHIN its parent piece, not across the whole sheet — that's how the
  // real cut actually happens after earlier cuts have split the stock.
  doc.setLineWidth(0.4);
  doc.setDrawColor(255, 255, 255);
  for (let i = 0; i < cutIdx; i++) {
    drawCutLineInParent(doc, sc.steps[i], lengthIsY, ox, oy, scale);
  }

  // Highlight the PARENT PIECE of the current cut with a thin red border
  // so the user sees what piece they're cutting.
  doc.setDrawColor(224, 62, 62);
  doc.setLineWidth(0.7);
  doc.rect(
    ox + cur.parentX * scale,
    oy + cur.parentY * scale,
    cur.parentW * scale,
    cur.parentH * scale,
    'S',
  );

  // Current cut as bold red line with arrow caps, drawn inside the parent.
  doc.setLineWidth(2.0);
  doc.setDrawColor(224, 62, 62);
  drawCutLineInParent(doc, cur, lengthIsY, ox, oy, scale, true);
}

/**
 * Draw a single cut step's line INSIDE its parent piece's rectangle.
 * Rip cuts run parallel to the sheet's length axis; crosscuts run across.
 * `step.distance` is measured from:
 *   - parent's LEFT edge for vertical cuts
 *   - parent's BOTTOM edge for horizontal cuts
 */
function drawCutLineInParent(
  doc: jsPDF,
  step: { axis: 'rip' | 'cross'; distance: number; parentX: number; parentY: number; parentW: number; parentH: number },
  lengthIsY: boolean,
  ox: number,
  oy: number,
  scale: number,
  withArrows = false,
) {
  // Convert rip/cross → vertical/horizontal in screen orientation.
  const isVertical = lengthIsY ? step.axis === 'rip' : step.axis === 'cross';
  const px = ox + step.parentX * scale;
  const py = oy + step.parentY * scale;
  const pw = step.parentW * scale;
  const ph = step.parentH * scale;

  if (isVertical) {
    const dx = px + step.distance * scale;
    doc.line(dx, py, dx, py + ph);
    if (withArrows) {
      doc.setFillColor(224, 62, 62);
      drawTri(doc, dx, py - 1, 'down');
      drawTri(doc, dx, py + ph + 1, 'up');
    }
  } else {
    const dy = py + step.distance * scale;
    doc.line(px, dy, px + pw, dy);
    if (withArrows) {
      doc.setFillColor(224, 62, 62);
      drawTri(doc, px - 1, dy, 'right');
      drawTri(doc, px + pw + 1, dy, 'left');
    }
  }
}

function drawTri(doc: jsPDF, x: number, y: number, dir: 'up' | 'down' | 'left' | 'right') {
  const s = 3.5;
  let pts: [number, number][];
  if (dir === 'down')      pts = [[x - s, y], [x + s, y], [x, y + s]];
  else if (dir === 'up')   pts = [[x - s, y], [x + s, y], [x, y - s]];
  else if (dir === 'right')pts = [[x, y - s], [x, y + s], [x + s, y]];
  else                      pts = [[x, y - s], [x, y + s], [x - s, y]];
  const lines: [number, number][] = [];
  for (let i = 1; i < pts.length; i++) lines.push([pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]]);
  lines.push([pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]]);
  doc.lines(lines, pts[0][0], pts[0][1], [1, 1], 'F', true);
}
