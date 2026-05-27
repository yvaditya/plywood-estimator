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
}

export interface InventoryCheck {
  thickness: number;
  needed: number;
  available: number;
  label: string;
}

// pt-based page sizes (1 pt = 1/72 in)
const PAPER_DIMS: Record<PdfPaper, { w: number; h: number; format: string; orient: 'landscape' | 'portrait' }> = {
  'letter-landscape':  { w: 792,  h: 612,  format: 'letter', orient: 'landscape' },
  'letter-portrait':   { w: 612,  h: 792,  format: 'letter', orient: 'portrait'  },
  'legal-landscape':   { w: 1008, h: 612,  format: 'legal',  orient: 'landscape' },
  'legal-portrait':    { w: 612,  h: 1008, format: 'legal',  orient: 'portrait'  },
  'tabloid-landscape': { w: 1224, h: 792,  format: 'tabloid', orient: 'landscape' },
  'a4-landscape':      { w: 842,  h: 595,  format: 'a4',     orient: 'landscape' },
};
const PAGE_PAD = 36; // 0.5"

export function buildPdf(result: NestResult, opt: PdfOptions): jsPDF {
  const paper = opt.paper ?? 'letter-landscape';
  const dims = PAPER_DIMS[paper];
  const doc = new jsPDF({ orientation: dims.orient, unit: 'pt', format: dims.format });

  const labels = assignPartLabels(result);

  drawSummary(doc, result, opt, dims);

  // Parts overview (IKEA-style) immediately after the summary
  doc.addPage(dims.format, dims.orient);
  drawPartsOverview(doc, labels, opt, dims);

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

  const cx = ox + (p.x + p.w / 2) * scale;
  const cy = oy + (p.y + p.h / 2) * scale;
  const partPt = Math.min(p.w, p.h) * scale;
  doc.setTextColor(20);

  // Letter label (huge, bold, centered) — primary identifier
  if (letter) {
    const big = Math.max(10, Math.min(36, partPt * 0.36));
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(big);
    doc.text(letter, cx, cy + big * 0.18, { align: 'center' });
  }

  // Dimensions subtitle below the letter
  doc.setFont('helvetica', 'normal');
  const subSize = Math.max(4, Math.min(11, partPt * 0.10));
  doc.setFontSize(subSize);
  doc.setTextColor(60);
  doc.text(
    `${fmtDim(p.w, opt.units)} × ${fmtDim(p.h, opt.units)}`,
    cx,
    cy + (letter ? Math.max(10, Math.min(36, partPt * 0.36)) * 0.55 + subSize : 0),
    { align: 'center' },
  );
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
  const cuts = allCutSteps(result);

  const totalCuts = cuts.reduce((a, sc) => a + sc.steps.length, 0);
  // Header
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.text('Cut instructions', PAGE_PAD, PAGE_PAD + 6);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(60);
  doc.text(`Total cuts to make: ${totalCuts}`, PAGE_PAD, PAGE_PAD + 24);
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(
    'Order: rip cuts (along sheet length / grain) first, then crosscuts. Distances from the named reference edge.',
    PAGE_PAD, PAGE_PAD + 38,
  );
  doc.setTextColor(0);

  let y = PAGE_PAD + 58;
  const lineH = 14;
  const minY = PAGE_H - PAGE_PAD;

  for (const sc of cuts) {
    if (y > minY - 80) {
      doc.addPage();
      y = PAGE_PAD + 6;
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(20);
    doc.text(
      `Sheet ${sc.groupIndex}.${sc.sheetIndex}  ·  ${fmtDim(sc.thickness, opt.units)} thick  ·  ${fmtDim(sc.sheetW, opt.units)} × ${fmtDim(sc.sheetL, opt.units)}`,
      PAGE_PAD, y,
    );
    y += lineH + 2;

    if (sc.steps.length === 0) {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(10);
      doc.setTextColor(120);
      doc.text('No interior cuts (single part fills the sheet).', PAGE_PAD + 14, y);
      doc.setTextColor(0);
      y += lineH + 6;
      continue;
    }

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(40);
    for (const step of sc.steps) {
      if (y > minY - lineH) {
        doc.addPage();
        y = PAGE_PAD + 6;
      }
      const edgeRef = step.axis === 'rip' ? 'left edge' : 'bottom edge';
      const label = step.axis === 'rip' ? 'Rip' : 'Crosscut';
      doc.text(
        `${String(step.index).padStart(2, ' ')}.  ${label}  at  ${fmtDim(step.distance, opt.units)}  from ${edgeRef}`,
        PAGE_PAD + 14, y,
      );
      y += lineH;
    }
    y += 10;
  }
}
