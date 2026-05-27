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
  /** PNG data URLs from the 3D viewer for the assembly guide page. */
  assembledPng?: string;
  explodedPng?: string;
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

  drawSummary(doc, result, opt, dims);

  // Parts overview (IKEA-style) immediately after the summary
  doc.addPage(dims.format, dims.orient);
  drawPartsOverview(doc, labels, opt, dims);

  // Assembly guide (3D viewer snapshots) — only if both PNGs were provided
  if (opt.assembledPng && opt.explodedPng) {
    doc.addPage(dims.format, dims.orient);
    drawAssemblyGuide(doc, opt, dims);
  }

  // One page per cut sheet, with letter labels overlaid on parts
  for (const group of result.groups) {
    for (const sheet of group.sheets) {
      doc.addPage(dims.format, dims.orient);
      drawSheet(doc, sheet, opt, dims, labels);
    }
  }

  // Cut instructions at the end so they're easy to print as a checklist
  doc.addPage(dims.format, dims.orient);
  drawCutInstructions(doc, result, opt, dims, labels);

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

  // Sheet border
  doc.setDrawColor(120, 100, 60);
  doc.setLineWidth(1.2);
  doc.rect(ox, oy, sheetPtW, sheetPtH, 'S');

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
    drawPart(doc, p, ox, oy, scale, opt, labels?.get(p.partId)?.letter);
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
  doc.setFillColor(r, g, b);
  doc.setDrawColor(Math.floor(r * 0.55), Math.floor(g * 0.55), Math.floor(b * 0.55));
  doc.setLineWidth(0.6);

  // Outer ring as polygon
  drawPolygon(doc, p.outer, p.x, p.y, ox, oy, scale, 'F');
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

  // Letter label (huge, bold, centered) — primary identifier
  if (letter) {
    const big = Math.max(10, Math.min(36, partPt * 0.36));
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(big);
    doc.text(letter, cx, cy + big * 0.18, { align: 'center' });
  }

  // Smart dimensions:
  //   - LARGE parts (≥110pt in shorter dim): draw external dimension
  //     ticks along the part's bottom and left edges, with the value
  //     inset from the edge. Reads like a real shop drawing.
  //   - SMALL parts: fall back to a centered subtitle so it still fits.
  const big = Math.max(10, Math.min(36, partPt * 0.36));
  if (partPt >= 110) {
    drawPartDims(doc, px, py, pwPt, phPt, p.w, p.h, opt);
  } else {
    doc.setFont('helvetica', 'normal');
    const subSize = Math.max(4, Math.min(11, partPt * 0.10));
    doc.setFontSize(subSize);
    doc.setTextColor(60);
    doc.text(
      `${fmtDim(p.w, opt.units)} × ${fmtDim(p.h, opt.units)}`,
      cx,
      cy + (letter ? big * 0.55 + subSize : 0),
      { align: 'center' },
    );
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
function drawDimH(doc: jsPDF, x1: number, x2: number, y: number, label: string) {
  doc.setDrawColor(180, 60, 60);
  doc.setLineWidth(0.4);
  doc.line(x1, y, x2, y);
  // extension lines / arrows
  doc.line(x1, y - 4, x1, y + 4);
  doc.line(x2, y - 4, x2, y + 4);
  doc.setTextColor(180, 60, 60);
  doc.setFontSize(9);
  doc.text(label, (x1 + x2) / 2, y + 11, { align: 'center' });
  doc.setTextColor(0);
}

function drawDimV(doc: jsPDF, y1: number, y2: number, x: number, label: string) {
  doc.setDrawColor(180, 60, 60);
  doc.setLineWidth(0.4);
  doc.line(x, y1, x, y2);
  doc.line(x - 4, y1, x + 4, y1);
  doc.line(x - 4, y2, x + 4, y2);
  doc.setTextColor(180, 60, 60);
  doc.setFontSize(9);
  doc.text(label, x - 4, (y1 + y2) / 2, { align: 'right', angle: 90 });
  doc.setTextColor(0);
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
      y = TOP_NEW;
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(20);
    doc.text(
      `Sheet ${sc.groupIndex}.${sc.sheetIndex}  ·  ${fmtDim(sc.thickness, opt.units)} thick  ·  ${fmtDim(sc.sheetW, opt.units)} × ${fmtDim(sc.sheetL, opt.units)}  ·  ${sc.steps.length} cuts`,
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

  // Sheet background (dark plywood)
  doc.setFillColor(107, 79, 49);
  doc.setDrawColor(46, 31, 15);
  doc.setLineWidth(0.7);
  doc.rect(ox, oy, dW, dH, 'FD');

  // Part overlays — uniform LIGHT BIRCH (#E8D6B0), translucent. Reads as
  // "this is wood you're cutting" without competing with the cut lines
  // or the colored 3D view. (Previously used per-body colors; user asked
  // for a single light wood tone here.)
  const gs = (doc as any).GState ? new (doc as any).GState({ opacity: 0.60 }) : null;
  if (gs) (doc as any).setGState(gs);
  doc.setFillColor(232, 214, 176);
  for (const p of parts) {
    doc.rect(ox + p.x * scale, oy + p.y * scale, p.w * scale, p.h * scale, 'F');
  }
  if (gs) (doc as any).setGState(new (doc as any).GState({ opacity: 1 }));

  // Per-part letter labels — centered inside each part rectangle.
  // Skipped when the cell is too small for the text to read.
  if (labels) {
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(50);
    for (const p of parts) {
      const letter = labels.get(p.partId)?.letter;
      if (!letter) continue;
      const cellW = p.w * scale;
      const cellH = p.h * scale;
      const minPx = Math.min(cellW, cellH);
      if (minPx < 10) continue;
      const fs = Math.max(6, Math.min(14, minPx * 0.35));
      doc.setFontSize(fs);
      doc.text(
        letter,
        ox + (p.x + p.w / 2) * scale,
        oy + (p.y + p.h / 2) * scale + fs * 0.32,
        { align: 'center' },
      );
    }
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
