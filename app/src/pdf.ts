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
import { fmtDim, fmtArea, fmtSag, type Units } from './units';
import { assignPartLabels, allCutSteps, cutKeyFor, groupPanelsBySize, groupAllPanelsBySize, type CutStep, type PartLabel, type PanelSizeRow, type SheetOverrides, type KerfRef, type SequenceStyle } from './instructions';

export type PdfPaper =
  | 'widescreen-16-9'
  | 'letter-landscape' | 'letter-portrait'
  | 'legal-landscape'  | 'legal-portrait'
  | 'tabloid-landscape'
  | 'a4-landscape'
  /** Phone-portrait pages, one cut per page — for reading the cut sequence
   *  at the saw from a phone. */
  | 'mobile'
  /** PowerPoint 4:3 — the cutlist's default page. */
  | 'cutlist-4-3';

/** Page size for the cutlist export. Any job paper size is valid — the UI's
 *  "Match PDF paper" option feeds whatever `paper` is set to straight through,
 *  including the portrait and phone sizes. makeOrient always lays the sheet
 *  long-edge-horizontal, so a portrait page is legal; it just yields a
 *  smaller drawing. */
export type CutlistPaper = PdfPaper;

/**
 * Optional export sections, driven by the "Options" menu in the Cut Layout
 * header. One set governs BOTH exports; a flag naming a section an export
 * doesn't have is simply inert there.
 *
 * Every field defaults to TRUE when absent (see `wants`) — an option object
 * that omits a key, or no option object at all, yields today's full document.
 * Sections that are already conditional on their data existing (Structure,
 * Assembly analysis, Join split parts) are deliberately not switchable: they
 * appear only when they have something to say, and the join guide is
 * correctness-critical for dovetailed oversize parts.
 */
export interface PdfSections {
  /** Job PDF: per-cabinet assembly overview + step cards, and the legacy
   *  assembled/exploded guide. Cutlist: the front/back balloon pages. */
  assembly?: boolean;
  /** Tabular pages: Quick reference, the job-wide Panels table, and the
   *  per-sheet panel dimension tables. */
  panelLists?: boolean;
  /** Cut-sequence cards, plus the Shopping list and Contents pages. */
  cutSteps?: boolean;
}

/** Section flag lookup — absent means on. */
function wants(opt: PdfOptions, key: keyof PdfSections): boolean {
  return opt.sections?.[key] !== false;
}

export interface PdfOptions {
  sheetW: number;       // mm
  sheetL: number;       // mm
  margin: number;       // mm
  kerf: number;         // mm
  units: Units;
  /** Kerf-reference mode — how each layout cut's dimension is quoted:
   *   - 'keeper'  (default): the KEEPER width = the flip-stop number =
   *     finished part dim (distance − kerf, measured to the near side of the
   *     kerf on the parallel guide's registered edge).
   *   - 'center': the raw kerf-centre distance (no blade compensation).
   *   - 'spacing': spacing only = distance − kerf/2, and the far reference
   *     trim lands exactly at the last part's edge (see cutStepsForSheet). */
  kerfRef?: KerfRef;
  /** Cut-sequencing style — 'row' (learned "easy cut" row-by-row, default) or
   *  'optimized' (parallel-guide fewest-setups). Threaded into every
   *  allCutSteps call so the exported cut pages follow the active style. */
  sequenceStyle?: SequenceStyle;
  /** Manual cut-sequence overrides keyed by each sheet's `layoutSignature`.
   *  Threaded into every allCutSteps call so the exported sequence, measured
   *  edges and datum colors match what the user arranged in the editor. */
  overridesBySig?: Record<string, SheetOverrides>;
  inventoryCheck?: InventoryCheck[];
  jobName?: string;
  paper?: PdfPaper;
  /** Page size for the cutlist export only (buildCutlistPdf). Independent of
   *  `paper`, which drives the full job PDF. Defaults to 4:3. */
  cutlistPaper?: CutlistPaper;
  /** Which optional sections to include. Omitted = everything, so callers
   *  that don't care are unaffected. */
  sections?: PdfSections;
  currency?: string;
  jobCost?: number;
  edgeBandingMm?: number;
  /** PNG data URLs from the 3D viewer for the assembly guide page.
   *  DEPRECATED in favor of `cabinets` — kept for backward-compat. */
  assembledPng?: string;
  explodedPng?: string;
  /** Cutlist assembly views — one entry per cabinet: assembled front/back
   *  3/4 snapshots with per-panel balloon anchors in image pixels. */
  assemblyViews?: CutlistAssemblyViews[];
  /** One entry per unique STEP file (cabinet). Each is rendered as its
   *  own assembly page so multi-cabinet jobs don't share one snapshot. */
  cabinets?: CabinetSnapshot[];
  /** CNC / waterjet job: the machine cuts continuous contours, so the
   *  panel-saw cut-sequence pages are meaningless and are skipped. */
  cnc?: boolean;
  /** Dovetail auto-split join guide — one group per original part that was
   *  split. Renders a section showing how the segments reassemble. */
  splitJoins?: SplitJoinGroup[];
  /** Quick-CAE structural screening rows for the Structure section. One row
   *  per panel size; sag is the formula-screening estimate under the default
   *  uniform load. Only present when the user actually ran an ASSEMBLY solve
   *  this session — otherwise the whole Structure/Analysis feature is absent
   *  from the PDF. */
  structure?: StructureRow[];
  /** The whole-cabinet Assembly analysis page (heatmap + joints + loads +
   *  result). Present only when an assembly was solved this session. */
  assembly?: AssemblyAnalysisPage;
}

/** A load line for the Assembly analysis page. */
export interface AssemblyAnalysisLoad {
  /** Human magnitude, e.g. "50 kg". */
  magDisplay: string;
  shape: 'square' | 'round';
  /** Footprint size in mm. */
  sizeMm: number;
  /** True → downward force (↓); false → upward reaction (↑). */
  down: boolean;
  /** Which panel it sits on, e.g. "1a". */
  panelLabel: string;
}

/** A joint row for the Assembly analysis page. */
export interface AssemblyAnalysisJoint {
  /** Panel pair, e.g. "1a ⟂ 1e". */
  pair: string;
  /** Contact length (mm). */
  length: number;
  /** rigid / semi-rigid / hinged. */
  stiffness: string;
}

/** Everything needed to render the whole-assembly Analysis page. */
export interface AssemblyAnalysisPage {
  /** Cabinet (STEP file) tag. */
  cabinet: string;
  /** Whole-cabinet deflection heatmap snapshot (white bg). */
  image: SnapshotImage;
  /** Whole-cabinet von-Mises stress heatmap snapshot (white bg). Optional —
   *  when present (and there's room) it prints under the deflection map. */
  stressImage?: SnapshotImage;
  panelCount: number;
  joints: AssemblyAnalysisJoint[];
  loads: AssemblyAnalysisLoad[];
  /** Floor-grounded node count. */
  groundedNodes: number;
  /** Max deflection (mm) + which panel + where. */
  maxSagMm: number;
  maxPanelLabel: string;
  maxAt: [number, number];
  /** Governing panel free span (mm), for the verdict. */
  spanMm: number;
  verdict: string;
  /** Max von-Mises surface stress (MPa) + governing panel + location. */
  maxVmMPa?: number;
  maxVmPanelLabel?: string;
  maxVmAt?: [number, number];
  /** Utilization % vs the material bending strengths + its verdict. */
  utilPct?: number;
  stressVerdict?: string;
  /** Combined verdict (worst of deflection + stress). */
  combinedVerdict?: string;
  /** Solver resolution log line. */
  resolutionLog: string;
  iterations: number;
}

export interface StructureRow {
  /** Panel code(s), e.g. "1a, 3b". */
  code: string;
  /** Panel display name. */
  name: string;
  /** Free span used for the estimate (mm). */
  span: number;
  /** Material name. */
  material: string;
  /** Uniform load assumption (kg). */
  loadKg: number;
  /** Predicted mid-span sag (mm). */
  sagMm: number;
  /** 'ok' | 'borderline' | 'weak'. */
  verdict: 'ok' | 'borderline' | 'weak';
}

export interface SplitJoinSegment {
  /** Roman numeral within the parent: 'i', 'ii', … */
  roman: string;
  /** Full sheet panel label, e.g. '1a-i', or null when the segment went
   *  unplaced. */
  label: string | null;
  /** Global sheet number the segment landed on, or null when unplaced. */
  sheetNo: number | null;
  /** Segment outline (anchored at 0,0) + its offset within the parent's
   *  frame — drawing all segments at their offsets reassembles the parent. */
  outer: [number, number][];
  holes: [number, number][][];
  offsetX: number;
  offsetY: number;
  color: string;
}

export interface SplitJoinGroup {
  parentName: string;
  thickness: number;
  segments: SplitJoinSegment[];
}

export interface SnapshotImage {
  dataUrl: string;
  width: number;
  height: number;
}

/** One assembled view for the cutlist Assembly page. */
export interface CutlistView {
  image: SnapshotImage;
  /** Panel-id balloons: position in IMAGE pixels + the id text ("1a"). */
  labels: { x: number; y: number; text: string }[];
}

/** Front + back 3/4 views of one cabinet for the cutlist Assembly page. */
export interface CutlistAssemblyViews {
  /** Cabinet (STEP file) tag — shown in the header on multi-cabinet jobs. */
  name?: string;
  front: CutlistView;
  back: CutlistView;
}

export interface CabinetPanel {
  /** Sheet-relative panel id like "1a", "2c". */
  id: string;
  /** Long edge in mm. */
  length: number;
  /** Short edge in mm. */
  width: number;
  /** Sheet-goods thickness in mm. */
  thickness: number;
  /** Display name (typically derived from STEP body name). */
  name: string;
  /** Hex color matching the 3D viewer + cut layouts. */
  color: string;
}

export interface CabinetSnapshot {
  /** Display name (typically the source STEP filename). */
  name: string;
  /** Letter IDs (e.g. "1a", "2c") of every panel that belongs to this
   *  cabinet — drawn as a small inventory list on the assembly page. */
  partIds: string[];
  /** Detailed per-panel info used to render the parts inventory table on
   *  the cabinet cover page. */
  panels?: CabinetPanel[];
  /** Snapshots showing ONLY this cabinet's panels (others hidden). */
  assembled: SnapshotImage;
  exploded: SnapshotImage;
  /** IKEA-style per-step snapshots — one per body. Each shows the bodies
   *  installed so far at rest, with the newly-installed body floating in
   *  along its face normal. All steps share one camera framing. */
  steps?: SnapshotImage[];
  /** Panel id label for each step (same length as `steps`). */
  stepPanelIds?: string[];
}

export interface InventoryCheck {
  thickness: number;
  needed: number;
  available: number;
  label: string;
}

// ---------------------------------------------------------------------------
// Sheet display orientation.
// Always render with the LONG edge of the plywood along the page horizontal:
// portrait sheets (L > W) get rotated by swapping x↔y / w↔h on every rect.
// In both the rotated and non-rotated cases, the LENGTH axis ends up running
// horizontally in the display, so:
//   - rip cut  (parallel to length) → horizontal LINE in display
//   - crosscut (perpendicular)       → vertical   LINE in display
// ---------------------------------------------------------------------------
interface Orient {
  dispW: number;
  dispH: number;
  rotated: boolean;
  rect(x: number, y: number, w: number, h: number): { x: number; y: number; w: number; h: number };
}

function makeOrient(sheetW: number, sheetL: number): Orient {
  const rotated = sheetL > sheetW;
  if (!rotated) {
    return {
      dispW: sheetW,
      dispH: sheetL,
      rotated: false,
      rect: (x, y, w, h) => ({ x, y, w, h }),
    };
  }
  return {
    dispW: sheetL,
    dispH: sheetW,
    rotated: true,
    // Swap sheet x↔y and w↔h. Reflection across the diagonal — preserves the
    // visual layout of every rect while flipping the long axis to horizontal.
    rect: (x, y, w, h) => ({ x: y, y: x, w: h, h: w }),
  };
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
  // 9:16 phone-portrait — fills a phone screen page-per-swipe.
  'mobile':            { w: 396,  h: 704,  format: [396, 704], orient: 'portrait'  },
  // PowerPoint 4:3 — 10" × 7.5" → 720 × 540 pt. The cutlist's default and the
  // page every cutlist type size was tuned against (see cutlistScale).
  'cutlist-4-3':       { w: 720,  h: 540,  format: [720, 540], orient: 'landscape' },
};
const PAGE_PAD = 36; // 0.5"

/**
 * Cutlist chrome scale. The sheet drawing and its per-panel dimension text
 * already scale off the page (drawSheet's `scale`, drawPart's `partPt`), but
 * the page furniture — headers, the meta line, footers, assembly balloons —
 * is set in absolute points tuned against the 4:3 baseline. Left unscaled it
 * reads progressively smaller as the page grows: correct but lost on 11×17.
 *
 * Capped at 1.7 so the header doesn't start eating drawing area on large
 * pages. The LOWER bound exists because "Match PDF paper" can hand us a page
 * smaller than the 4:3 baseline (phone is 396 × 704): there the tuned sizes
 * would overrun the page width, and overlap — not small type — is the thing
 * to avoid on a doc meant to be zoomed.
 *
 *   phone 0.55 · portrait 0.85 · 4:3 and 16:9 1.00 · Letter 1.10 ·
 *   A4 1.10 · Legal 1.13 · 11×17 1.47
 *
 * PAGE_PAD deliberately does NOT scale — it is a real 0.5" print margin at
 * every size, so bigger pages gain proportionally more drawing area too.
 */
function cutlistScale(dims: { w: number; h: number }): number {
  const base = PAPER_DIMS['cutlist-4-3'];
  return clamp(Math.min(dims.w / base.w, dims.h / base.h), 0.5, 1.7);
}

// ---------------------------------------------------------------------------
// Deferred navigation. Page numbers aren't known while a page is being drawn
// (later sections haven't been laid out yet), so cross-references are
// RECORDED during drawing and RESOLVED in a post-pass once every page exists:
//   - links: invisible click rectangles jumping to a section's first page
//   - notes: small "→ Section p.N" text lines (text needs the resolved page
//     number, so the whole note is drawn in the post-pass)
//   - toc:   entries for the Contents page
// Targets are section names (matched against sectionPerPage).
// ---------------------------------------------------------------------------
interface NavCtx {
  links: { page: number; x: number; y: number; w: number; h: number; target: string }[];
  notes: { page: number; x: number; y: number; label: string; target: string }[];
  toc: { title: string; desc: string; target: string }[];
}

export function buildPdf(result: NestResult, opt: PdfOptions): jsPDF {
  const paper = opt.paper ?? 'widescreen-16-9';
  if (paper === 'mobile') return buildMobilePdf(result, opt);
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
  const nav: NavCtx = { links: [], notes: [], toc: [] };
  const curPage = () => doc.getNumberOfPages();

  // Panel id ("1a") → cabinet name, for the per-sheet cabinet cross-refs.
  const cabinetByPanelId = new Map<string, string>();
  for (const cab of opt.cabinets ?? []) {
    for (const id of cab.partIds) cabinetByPanelId.set(id, cab.name);
  }

  // 1. COVER — job summary (sheets / yield / cost / per-thickness table)
  tagSection('Cover');
  drawSummary(doc, result, opt, dims);

  // 2. CONTENTS — reserved now, filled in the post-pass once every page
  //    number is known. Doubles as the "how to use this document" intro.
  //    Null when the section is switched off; the post-pass then skips it.
  let contentsPage: number | null = null;
  if (wants(opt, 'cutSteps')) {
    addPage('Contents');
    contentsPage = curPage();
  }

  // 3. QUICK REFERENCE — every sheet at a glance; the shop-wall page.
  if (wants(opt, 'panelLists')) {
    addPage('Quick reference');
    nav.toc.push({ title: 'Quick reference', desc: 'Every sheet at a glance — post this at the saw.', target: 'Quick reference' });
    drawQuickReference(doc, result, opt, dims, labels, () => addPage('Quick reference'));
  }

  // 4. SHOPPING LIST — what to buy first
  if (wants(opt, 'cutSteps')) {
    addPage('Shopping list');
    nav.toc.push({ title: 'Shopping list', desc: 'Materials to buy before starting.', target: 'Shopping list' });
    drawShoppingListPage(doc, opt, dims);
  }

  // 5. PANELS — ONE job-wide dimensions table: every placed panel across
  //    all sheets, grouped by identical (length × width × thickness). Same
  //    format as the per-sheet tables; codes ("1a, 3a, 4b") point back at
  //    the sheet layouts. Skipped for CNC jobs (the machine cuts straight
  //    from the sheet contours; the saw-shop dimensions table is dead
  //    weight there).
  if (!opt.cnc && wants(opt, 'panelLists')) {
    addPage('Panels');
    nav.toc.push({ title: 'Panels', desc: 'Every panel size in the job — codes point to the sheet layouts.', target: 'Panels' });
    drawPanelTable(doc, 'Panels', groupAllPanelsBySize(result), opt, dims, () => addPage('Panels'));
  }

  // 5b. STRUCTURE — quick bending screen per panel. Applies to every job
  //     (saw and CNC) since it's about the finished panel, not the cut.
  if (opt.structure && opt.structure.length > 0) {
    addPage('Structure');
    nav.toc.push({ title: 'Structure', desc: 'Predicted sag per panel under a loaded-shelf assumption.', target: 'Structure' });
    drawStructureTable(doc, opt.structure, opt, dims, () => addPage('Structure'));
  }

  // 5c. ASSEMBLY ANALYSIS — one page for the whole solved cabinet (deflection
  //     heatmap across all panels + joints table + loads + result). Present
  //     only when the user ran an assembly solve this session.
  if (opt.assembly) {
    const sectionName = 'Assembly analysis';
    addPage(sectionName);
    nav.toc.push({
      title: 'Assembly analysis',
      desc: 'Whole-cabinet deflection under the placed loads, joints and grounding.',
      target: sectionName,
    });
    drawAssemblyAnalysisPage(doc, opt.assembly, opt, dims);
  }

  // 6. CUT SHEETS grouped by thickness — divider page per group when the job
  //    mixes thicknesses, then one layout page + cut-sequence cards per
  //    sheet. Each group's join-split guide follows ITS sheets, so the guide
  //    sits next to the sheets that carry its segments.
  const multiGroup = result.groups.length > 1;
  const renderedJoins = new Set<SplitJoinGroup>();
  for (const group of result.groups) {
    const firstSheet = group.sheets[0];
    const groupTitle = multiGroup
      ? `Cut sheets — ${fmtDim(group.thickness, opt.units)}`
      : 'Cut sheets';
    if (multiGroup) {
      const dividerSection = `Sheets · ${fmtDim(group.thickness, opt.units)}`;
      addPage(dividerSection);
      nav.toc.push({ title: groupTitle, desc: 'Layout and cut sequence for each sheet.', target: dividerSection });
      drawGroupDivider(doc, group, opt, dims);
    } else if (firstSheet) {
      nav.toc.push({ title: groupTitle, desc: 'Layout and cut sequence for each sheet.', target: `Sheet ${firstSheet.globalIndex}` });
    }
    for (const sheet of group.sheets) {
      const sectionName = `Sheet ${sheet.globalIndex}`;
      // Per-sheet order the reader follows: (a) layout overview, (b) panel
      // dimensions table, (c) cut sequence. All three share the one
      // "Sheet 3 (2 of 3)" pagination section.
      addPage(sectionName);
      drawSheet(doc, sheet, opt, dims, labels, cabinetByPanelId, nav, curPage);
      // (b) Panel dimensions for THIS sheet, grouped by identical size.
      if (sheet.parts.length > 0 && wants(opt, 'panelLists')) {
        drawSheetPanelTable(doc, sheet, opt, dims, () => { addPage(sectionName); });
      }
      // (c) The sheet's cuts. CNC jobs skip the cards entirely: a
      // router/waterjet follows the part contours, so a panel-saw cut
      // sequence would be fiction.
      if (!opt.cnc && wants(opt, 'cutSteps')) {
        drawCutsForSingleSheet(doc, sheet, opt, dims,
          () => { addPage(sectionName); });
      }
    }
    const joins = (opt.splitJoins ?? []).filter((j) => j.thickness === group.thickness);
    if (joins.length > 0) {
      joins.forEach((j) => renderedJoins.add(j));
      addPage('Join split parts');
      if (!nav.toc.some((t) => t.target === 'Join split parts')) {
        nav.toc.push({ title: 'Join split parts', desc: 'How dovetailed oversize-part segments reassemble.', target: 'Join split parts' });
      }
      drawSplitJoins(doc, joins, opt, dims, () => addPage('Join split parts'));
    }
  }
  // Safety net: join groups whose thickness matched no sheet group.
  const leftoverJoins = (opt.splitJoins ?? []).filter((j) => !renderedJoins.has(j));
  if (leftoverJoins.length > 0) {
    addPage('Join split parts');
    if (!nav.toc.some((t) => t.target === 'Join split parts')) {
      nav.toc.push({ title: 'Join split parts', desc: 'How dovetailed oversize-part segments reassemble.', target: 'Join split parts' });
    }
    drawSplitJoins(doc, leftoverJoins, opt, dims, () => addPage('Join split parts'));
  }

  // 7. ASSEMBLY — overview page per cabinet, then step-by-step panel cards
  if (!wants(opt, 'assembly')) {
    // nothing — the caller switched the assembly pages off
  } else if (opt.cabinets && opt.cabinets.length > 0) {
    for (const cab of opt.cabinets) {
      const sectionName = `Assembly · ${cab.name}`;
      addPage(sectionName);
      nav.toc.push({ title: sectionName, desc: 'What is in the box, then step-by-step build order.', target: sectionName });
      drawCabinetAssembly(doc, cab, opt, dims);
      if (cab.steps && cab.steps.length > 0) {
        drawCabinetSteps(doc, cab, opt, dims, () => addPage(sectionName));
      }
    }
  } else if (opt.assembledPng && opt.explodedPng) {
    // Backwards-compat fallback: single all-cabinet assembly page.
    addPage('Assembly');
    nav.toc.push({ title: 'Assembly', desc: 'Assembled and exploded views.', target: 'Assembly' });
    drawAssemblyGuide(doc, opt, dims);
  }

  // Post-passes, in order: fill the Contents page (needs final page
  // numbers), sidebar bookmarks, headers/footers, then deferred notes/links.
  if (contentsPage !== null) drawContents(doc, contentsPage, dims, opt, nav, sectionPerPage);
  addBookmarks(doc, nav, sectionPerPage, result);
  paginateAndDecorate(doc, dims, opt, sectionPerPage);
  resolveNav(doc, nav, sectionPerPage);

  return doc;
}

// ---------------------------------------------------------------------------
// CUTLIST PDF — the minimal companion to the full job PDF: ONE page per cut
// sheet and nothing else. Each page is the sheet-overview drawing (layout
// with every panel's id + dimensions on the full sheet, plus the overall
// sheet dim lines). Landscape at the caller's chosen page size (4:3 default,
// Letter / Legal / 11×17) — independent of the job-PDF paper setting.
// ---------------------------------------------------------------------------
export function buildCutlistPdf(result: NestResult, opt: PdfOptions): jsPDF {
  const dims = PAPER_DIMS[opt.cutlistPaper ?? 'cutlist-4-3'];
  const k = cutlistScale(dims);
  const doc = new jsPDF({
    orientation: dims.orient,
    unit: 'pt',
    format: dims.format,
  });
  const sheets = result.groups.flatMap((g) => g.sheets);
  // Panel id → cabinet name (when the caller passes cabinets): renders the
  // per-sheet cabinet cross-ref line on multi-cabinet jobs.
  const cabinetByPanelId = new Map<string, string>();
  for (const cab of opt.cabinets ?? []) {
    for (const id of cab.partIds) cabinetByPanelId.set(id, cab.name);
  }
  sheets.forEach((sheet, i) => {
    if (i > 0) doc.addPage(dims.format, dims.orient);
    drawSheet(doc, sheet, opt, dims, undefined, cabinetByPanelId.size > 0 ? cabinetByPanelId : undefined, undefined, undefined, true);
  });
  // Assembly page(s) — assembled front + back 3/4 views with the panel-id
  // balloons ON the panels, so the reader sees where every numbered panel
  // goes without a legend detour. One page per cabinet.
  if (wants(opt, 'assembly')) {
    for (const views of opt.assemblyViews ?? []) {
      doc.addPage(dims.format, dims.orient);
      drawCutlistAssemblyPage(doc, views, opt, dims);
    }
  }
  // Footer on every page: job name left, page x/y right — just enough to
  // reshuffle a printed stack, no other chrome.
  const n = doc.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8 * k);
    doc.setTextColor(150);
    if (opt.jobName) doc.text(opt.jobName, PAGE_PAD, dims.h - 14 * k);
    doc.text(`${i} / ${n}`, dims.w - PAGE_PAD, dims.h - 14 * k, { align: 'right' });
    doc.setTextColor(0);
  }
  return doc;
}

/**
 * Pixel target for the cutlist's assembly snapshots at a given page size.
 * Matches the aspect of the half-page column each view is drawn into, and
 * grows with the page so a larger page gets a genuinely sharper image rather
 * than the 4:3 capture upscaled. Long side capped at 2000 px — beyond that
 * the composer resize costs more than the print gains.
 *
 * Lives here so the column geometry stays in one file with the page that
 * draws it; main.ts just asks for the size.
 */
export function cutlistSnapshotTarget(paper: CutlistPaper = 'cutlist-4-3'): { w: number; h: number } {
  const dims = PAPER_DIMS[paper];
  const k = cutlistScale(dims);
  // Mirrors drawCutlistAssemblyPage's column box.
  const colW = (dims.w - 2 * PAGE_PAD - 18 * k) / 2;
  const colH = (dims.h - PAGE_PAD - 16 * k) - (PAGE_PAD + 14 * k);
  const PX_PER_PT = 3;
  let w = colW * PX_PER_PT;
  let h = colH * PX_PER_PT;
  const over = Math.max(w, h) / 2000;
  if (over > 1) { w /= over; h /= over; }
  return { w: Math.round(w), h: Math.round(h) };
}

/** Cutlist assembly page: assembled front + back 3/4 views side by side,
 *  panel-id balloons directly on the panels. Minimal chrome, same header
 *  style as the sheet pages. */
function drawCutlistAssemblyPage(
  doc: jsPDF,
  views: CutlistAssemblyViews,
  opt: PdfOptions,
  dims: { w: number; h: number },
) {
  const PAGE_W = dims.w;
  const PAGE_H = dims.h;
  const k = cutlistScale(dims);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14 * k);
  doc.setTextColor(0);
  doc.text('Assembly', PAGE_PAD, PAGE_PAD - 4);
  const sub = views.name ?? opt.jobName;
  if (sub) {
    const w = doc.getTextWidth('Assembly');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11 * k);
    doc.setTextColor(110);
    doc.text(sub, PAGE_PAD + w + 12 * k, PAGE_PAD - 4);
    doc.setTextColor(0);
  }
  const top = PAGE_PAD + 14 * k;
  const bottom = PAGE_H - PAGE_PAD - 16 * k; // caption strip under each view
  const gap = 18 * k;
  const colW = (PAGE_W - 2 * PAGE_PAD - gap) / 2;
  drawCutlistView(doc, views.front, 'Front', PAGE_PAD, top, colW, bottom - top, k);
  drawCutlistView(doc, views.back, 'Back', PAGE_PAD + colW + gap, top, colW, bottom - top, k);
}

/** One assembled view: aspect-fit image + white-pill id balloons at each
 *  panel's projected center, caption underneath. */
function drawCutlistView(
  doc: jsPDF,
  view: CutlistView,
  caption: string,
  x: number, y: number, w: number, h: number,
  /** Cutlist chrome scale — balloons and caption are page furniture, not
   *  drawing, so they scale with the page rather than with the image. */
  k: number,
) {
  const img = view.image;
  const scale = Math.min(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  const dx = x + (w - dw) / 2;
  const dy = y + (h - dh) / 2;
  doc.addImage(img.dataUrl, 'JPEG', dx, dy, dw, dh);
  doc.setFontSize(7.5 * k);
  doc.setLineWidth(0.4 * k);
  doc.setFont('helvetica', 'bold');

  // Balloons sit at each panel's projected centre, which on a 3/4 view can
  // put two of them on the same spot — a thin panel seen edge-on projects to
  // almost the same point as its neighbour. Overlapping pills are unreadable,
  // so each one is nudged along a vertical ladder (down, up, further down, …)
  // until it clears every pill already placed. The nudge is small enough that
  // the balloon still reads as belonging to its panel.
  const pillH = 10 * k;
  const step = pillH + 1.5 * k;
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  const hits = (a: { x: number; y: number; w: number; h: number }) =>
    placed.some((b) => a.x < b.x + b.w && a.x + a.w > b.x
                    && a.y < b.y + b.h && a.y + a.h > b.y);
  for (const l of view.labels) {
    const tw = doc.getTextWidth(l.text);
    const pillW = tw + 6 * k;
    const bx = dx + l.x * scale;
    const by = dy + l.y * scale;
    let box = { x: bx - pillW / 2, y: by - pillH / 2, w: pillW, h: pillH };
    for (let i = 1; i <= 8 && hits(box); i++) {
      const off = Math.ceil(i / 2) * step * (i % 2 === 1 ? 1 : -1);
      box = { x: bx - pillW / 2, y: by - pillH / 2 + off, w: pillW, h: pillH };
    }
    placed.push(box);
    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(...CUT_OBJ_INK);
    doc.roundedRect(box.x, box.y, box.w, box.h, 2 * k, 2 * k, 'FD');
    doc.setTextColor(...CUT_OBJ_INK);
    doc.text(l.text, box.x + box.w / 2, box.y + box.h / 2 + 2.6 * k, { align: 'center' });
  }
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5 * k);
  doc.setTextColor(130);
  doc.text(caption, x + w / 2, y + h + 12 * k, { align: 'center' });
  doc.setTextColor(0);
}

/** First page (1-based) tagged with this section, or null. */
function sectionStartPage(sectionPerPage: string[], target: string): number | null {
  const i = sectionPerPage.indexOf(target);
  return i >= 0 ? i + 1 : null;
}

// ---------------------------------------------------------------------------
// Contents page — filled in the post-pass so page numbers are real. Also
// carries the one-line "how to use" workflow intro.
// ---------------------------------------------------------------------------
function drawContents(
  doc: jsPDF,
  pageNo: number,
  dims: { w: number; h: number },
  opt: PdfOptions,
  nav: NavCtx,
  sectionPerPage: string[],
) {
  doc.setPage(pageNo);
  const PAGE_W = dims.w;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.setTextColor(0);
  doc.text('Contents', PAGE_PAD, PAGE_PAD + 6);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(120);
  doc.text(
    'Work front to back: buy the materials, cut each sheet in order, join any split parts, then assemble.',
    PAGE_PAD, PAGE_PAD + 24, { maxWidth: PAGE_W - 2 * PAGE_PAD },
  );

  let y = PAGE_PAD + 56;
  const lineH = 30;
  for (const e of nav.toc) {
    const page = sectionStartPage(sectionPerPage, e.target);
    if (page === null) continue;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(25);
    doc.text(e.title, PAGE_PAD, y);
    const titleW = doc.getTextWidth(e.title);
    const descX = Math.max(PAGE_PAD + 190, PAGE_PAD + titleW + 16);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(130);
    doc.text(e.desc, descX, y);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(60);
    doc.text(String(page), PAGE_W - PAGE_PAD, y, { align: 'right' });
    // Dotted leader between description and page number.
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    const descW = doc.getTextWidth(e.desc);
    const leadX = descX + descW + 10;
    if (leadX < PAGE_W - PAGE_PAD - 34) {
      doc.setDrawColor(210);
      doc.setLineWidth(0.5);
      doc.setLineDashPattern([1, 3], 0);
      doc.line(leadX, y - 2, PAGE_W - PAGE_PAD - 24, y - 2);
      doc.setLineDashPattern([], 0);
    }
    // Whole row is clickable.
    doc.link(PAGE_PAD, y - 12, PAGE_W - 2 * PAGE_PAD, 18, { pageNumber: page });
    y += lineH;
  }
  doc.setTextColor(0);
}

// ---------------------------------------------------------------------------
// PDF sidebar bookmarks (outline). jsPDF ships an outline plugin in its
// standard build; guard anyway so a build without it degrades gracefully.
// ---------------------------------------------------------------------------
function addBookmarks(doc: jsPDF, nav: NavCtx, sectionPerPage: string[], result: NestResult) {
  const outline = (doc as any).outline;
  if (!outline || typeof outline.add !== 'function') return;
  for (const e of nav.toc) {
    const page = sectionStartPage(sectionPerPage, e.target);
    if (page === null) continue;
    const node = outline.add(null, e.title, { pageNumber: page });
    // Child bookmarks: one per sheet under its "Cut sheets" entry.
    if (e.title.startsWith('Cut sheets')) {
      for (const g of result.groups) {
        for (const s of g.sheets) {
          const sp = sectionStartPage(sectionPerPage, `Sheet ${s.globalIndex}`);
          if (sp !== null && sp >= page) outline.add(node, `Sheet ${s.globalIndex}`, { pageNumber: sp });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Resolve deferred cross-references now that all pages exist: draw the
// "→ Section p.N" notes and lay the invisible link rectangles.
// ---------------------------------------------------------------------------
function resolveNav(doc: jsPDF, nav: NavCtx, sectionPerPage: string[]) {
  for (const n of nav.notes) {
    const page = sectionStartPage(sectionPerPage, n.target);
    if (page === null) continue;
    doc.setPage(n.page);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(110);
    const label = `${n.label} p.${page}`;
    doc.text(label, n.x, n.y);
    doc.link(n.x, n.y - 8, doc.getTextWidth(label), 10, { pageNumber: page });
    doc.setTextColor(0);
  }
  for (const l of nav.links) {
    const page = sectionStartPage(sectionPerPage, l.target);
    if (page === null) continue;
    doc.setPage(l.page);
    doc.link(l.x, l.y, l.w, l.h, { pageNumber: page });
  }
}

// ---------------------------------------------------------------------------
// Thickness-group divider page (only for jobs mixing thicknesses).
// ---------------------------------------------------------------------------
function drawGroupDivider(
  doc: jsPDF,
  group: NestResult['groups'][number],
  opt: PdfOptions,
  dims: { w: number; h: number },
) {
  const cx = dims.w / 2;
  const cy = dims.h / 2;
  const partCount = group.sheets.reduce((a, s) => a + s.parts.length, 0);
  const first = group.sheets[0]?.globalIndex;
  const last = group.sheets[group.sheets.length - 1]?.globalIndex;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(34);
  doc.setTextColor(30);
  doc.text(`${fmtDim(group.thickness, opt.units)} sheets`, cx, cy - 10, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(12);
  doc.setTextColor(120);
  const range = first === last ? `Sheet ${first}` : `Sheets ${first}–${last}`;
  doc.text(
    `${range}  ·  ${group.sheets.length} ${group.sheets.length === 1 ? 'sheet' : 'sheets'}  ·  ${partCount} parts`,
    cx, cy + 14, { align: 'center' },
  );
  doc.setTextColor(0);
}

// ---------------------------------------------------------------------------
// Quick-reference page — thumbnail grid of every sheet with job totals on
// top and a color legend underneath. Meant to be printed once and posted
// at the saw.
// ---------------------------------------------------------------------------
function drawQuickReference(
  doc: jsPDF,
  result: NestResult,
  opt: PdfOptions,
  dims: { w: number; h: number },
  labels: Map<string, PartLabel>,
  openNewPage: () => void,
) {
  const PAGE_W = dims.w;
  const PAGE_H = dims.h;
  const innerW = PAGE_W - 2 * PAGE_PAD;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.setTextColor(0);
  doc.text('Quick reference', PAGE_PAD, PAGE_PAD + 6);

  // Totals — one compact line, right-aligned with the title.
  const totals: string[] = [
    `${result.totalSheets} ${result.totalSheets === 1 ? 'sheet' : 'sheets'}`,
    `${(result.yield * 100).toFixed(1)}% yield`,
  ];
  if (opt.jobCost && opt.jobCost > 0 && opt.currency) {
    try {
      totals.push(new Intl.NumberFormat(undefined, { style: 'currency', currency: opt.currency }).format(opt.jobCost));
    } catch { /* unknown currency */ }
  }
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(90);
  doc.text(totals.join('   ·   '), PAGE_W - PAGE_PAD, PAGE_PAD + 6, { align: 'right' });
  doc.setTextColor(0);

  const sheets = result.groups.flatMap((g) => g.sheets.map((s) => ({ s, thickness: g.thickness })));
  if (sheets.length === 0) return;

  // Legend of unique parts (color → name) along the bottom of the FIRST
  // page — colors are the key that connects thumbnails to parts.
  const legendItems = Array.from(labels.values());
  const legendRows = legendItems.length > 0 ? Math.min(2, Math.ceil(legendItems.length / 4)) : 0;
  const legendH = legendRows > 0 ? legendRows * 14 + 10 : 0;

  // Thumbnail grid fills the rest. Thumbs render long-edge-horizontal, so
  // cell aspect comes from the first sheet's dims.
  const top = PAGE_PAD + 26;
  const gutter = 14;
  const captionH = 14;
  const s0 = sheets[0].s;
  const aspect = Math.min(s0.sheetW, s0.sheetL) / Math.max(s0.sheetW, s0.sheetL); // h/w in display
  const availH = PAGE_H - top - PAGE_PAD - legendH;
  // Smallest column count whose grid fits vertically.
  let cols = 2;
  for (; cols <= 8; cols++) {
    const tw = (innerW - gutter * (cols - 1)) / cols;
    const th = tw * aspect + captionH;
    const rows = Math.ceil(sheets.length / cols);
    if (rows * th + (rows - 1) * gutter <= availH) break;
  }
  cols = Math.min(cols, 8);
  const thumbW = (innerW - gutter * (cols - 1)) / cols;
  const thumbH = thumbW * aspect;

  let x = PAGE_PAD;
  let y = top;
  let col = 0;
  for (const { s, thickness } of sheets) {
    if (y + thumbH + captionH > PAGE_H - PAGE_PAD - legendH) {
      openNewPage();
      y = PAGE_PAD + 16;
      col = 0;
      x = PAGE_PAD;
    }
    drawSheetThumb(doc, s, x, y, thumbW, thumbH);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(40);
    doc.text(`Sheet ${s.globalIndex}`, x, y + thumbH + 11);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(130);
    const fill = s.parts.length > 0 ? (s.usedArea / (s.sheetW * s.sheetL)) * 100 : 0;
    doc.text(
      `${fmtDim(thickness, opt.units)} · ${fill.toFixed(0)}%`,
      x + thumbW, y + thumbH + 11, { align: 'right' },
    );
    col++;
    x += thumbW + gutter;
    if (col >= cols) { col = 0; x = PAGE_PAD; y += thumbH + captionH + gutter; }
  }

  // Legend — color swatch + part name (×qty). Two rows max; overflow noted.
  if (legendRows > 0) {
    const ly0 = PAGE_H - PAGE_PAD - legendH + 10;
    doc.setDrawColor(225);
    doc.setLineWidth(0.4);
    doc.line(PAGE_PAD, ly0 - 6, PAGE_W - PAGE_PAD, ly0 - 6);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    let lx = PAGE_PAD;
    let ly = ly0 + 4;
    let shown = 0;
    for (const it of legendItems) {
      const name = it.partName.length > 26 ? it.partName.slice(0, 23) + '…' : it.partName;
      const chip = it.totalQty > 1 ? `${name} ×${it.totalQty}` : name;
      const w = 12 + doc.getTextWidth(chip) + 16;
      if (lx + w > PAGE_W - PAGE_PAD) {
        lx = PAGE_PAD;
        ly += 14;
        if (ly > ly0 + legendH - 8) break;
      }
      const [r, g, b] = hexToRgb(it.color);
      doc.setFillColor(r, g, b);
      doc.rect(lx, ly - 7, 8, 8, 'F');
      doc.setTextColor(70);
      doc.text(chip, lx + 12, ly);
      lx += w;
      shown++;
    }
    if (shown < legendItems.length) {
      doc.setTextColor(140);
      doc.text(`+${legendItems.length - shown} more — see Panels`, lx + 12, ly);
    }
    doc.setTextColor(0);
  }
}

// ---------------------------------------------------------------------------
// MOBILE build — phone-portrait pages designed to be read at the saw:
// swipe page-per-cut. Structure: compact cover → shopping list → per sheet
// (layout + part list, then ONE CUT PER PAGE with a big instruction) →
// join guide → per cabinet (cover + one assembly step per page). Desktop
// niceties (contents, quick reference, parts grid, bookmarks) are dropped —
// on a phone you just swipe.
// ---------------------------------------------------------------------------
function buildMobilePdf(result: NestResult, opt: PdfOptions): jsPDF {
  const dims = PAPER_DIMS['mobile'];
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: dims.format });
  const PAGE_W = dims.w;
  const PAGE_H = dims.h;
  const innerW = PAGE_W - 2 * PAGE_PAD;
  const sectionPerPage: string[] = [];
  const tagSection = (s: string) => sectionPerPage.push(s);
  const addPage = (s: string) => {
    doc.addPage(dims.format, 'portrait');
    tagSection(s);
  };

  // COVER — compact: accent bar, job name, key stats, hero render.
  // Type runs ~30% larger than the desktop build throughout the mobile
  // pages — the page IS the phone screen, no zooming.
  tagSection('Cover');
  {
    let y = PAGE_PAD + 12;
    doc.setFillColor(107, 79, 49);
    doc.rect(PAGE_PAD, y, 34, 4, 'F');
    y += 32;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(24);
    doc.setTextColor(25);
    doc.text(opt.jobName || 'Plywood cut estimate', PAGE_PAD, y, { maxWidth: innerW });
    y += 30;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10.5);
    doc.setTextColor(120);
    doc.text(
      `Sheet ${fmtDim(opt.sheetW, opt.units)} × ${fmtDim(opt.sheetL, opt.units)}  ·  margin ${fmtDim(opt.margin, opt.units)}  ·  kerf ${fmtDim(opt.kerf, opt.units)}`,
      PAGE_PAD, y, { maxWidth: innerW },
    );
    y += 32;
    const metrics: [string, string][] = [
      ['Sheets', String(result.totalSheets)],
      ['Yield', `${(result.yield * 100).toFixed(1)}%`],
    ];
    if (opt.jobCost && opt.jobCost > 0 && opt.currency) {
      try {
        metrics.push(['Job cost', new Intl.NumberFormat(undefined, { style: 'currency', currency: opt.currency }).format(opt.jobCost)]);
      } catch { /* unknown currency */ }
    }
    const colW = innerW / 2;
    metrics.forEach(([k, v], i) => {
      const x = PAGE_PAD + (i % 2) * colW;
      const ry = y + Math.floor(i / 2) * 58;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9.5);
      doc.setTextColor(140);
      doc.text(k.toUpperCase(), x, ry);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(24);
      doc.setTextColor(25);
      doc.text(v, x, ry + 26);
    });
    y += 58 * Math.ceil(metrics.length / 2) + 10;
    const hero = opt.cabinets?.find((c) => c.assembled)?.assembled;
    if (hero) {
      drawSnapshotPanel(doc, hero, PAGE_PAD, y, innerW, PAGE_H - PAGE_PAD - y - 6, { frameless: true });
    }
    doc.setTextColor(0);
  }

  // SHOPPING LIST — big "material · buy N" rows with hairline separators.
  const items = opt.inventoryCheck ?? [];
  if (items.length > 0) {
    addPage('Shopping list');
    let y = PAGE_PAD + 22;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    doc.setTextColor(25);
    doc.text('Shopping list', PAGE_PAD, y);
    y += 32;
    doc.setFontSize(13);
    for (const r of items) {
      const short = Math.max(0, r.needed - r.available);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(40);
      doc.text(r.label, PAGE_PAD, y, { maxWidth: innerW - 76 });
      doc.setFont('helvetica', 'bold');
      if (short > 0) doc.setTextColor(192, 58, 54);
      else doc.setTextColor(80, 132, 110);
      doc.text(short > 0 ? `Buy ${short}` : 'OK', PAGE_W - PAGE_PAD, y, { align: 'right' });
      y += 12;
      doc.setDrawColor(232);
      doc.setLineWidth(0.4);
      doc.line(PAGE_PAD, y, PAGE_W - PAGE_PAD, y);
      y += 18;
      if (y > PAGE_H - PAGE_PAD) { addPage('Shopping list'); y = PAGE_PAD + 22; }
    }
    doc.setTextColor(0);
  }

  // SHEETS — layout page (with a grouped panel table standing in for the
  // desktop Panels section), then one page per cut.
  for (const group of result.groups) {
    for (const sheet of group.sheets) {
      const section = `Sheet ${sheet.globalIndex}`;
      addPage(section);
      drawMobileSheetPage(doc, sheet, opt, dims);
      if (!opt.cnc) {
        const sc = (allCutSteps({ groups: [{ thickness: sheet.thickness, sheets: [sheet], unplaced: [] }] } as any, opt.margin, opt.kerf, opt.overridesBySig, opt.kerfRef, opt.sequenceStyle))[0];
        if (sc) {
          for (let i = 0; i < sc.steps.length; i++) {
            addPage(section);
            drawMobileCutPage(doc, sc, sheet.parts, i, opt, dims);
          }
        }
      }
    }
  }

  // JOIN-SPLIT GUIDE — the desktop renderer is page-size-driven already.
  if (opt.splitJoins && opt.splitJoins.length > 0) {
    addPage('Join split parts');
    drawSplitJoins(doc, opt.splitJoins, opt, dims, () => addPage('Join split parts'));
  }

  // ASSEMBLY — hero + panel list, then one step per page.
  for (const cab of opt.cabinets ?? []) {
    const section = `Assembly · ${cab.name}`;
    addPage(section);
    {
      let y = PAGE_PAD + 22;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(19);
      doc.setTextColor(25);
      doc.text(cab.name, PAGE_PAD, y, { maxWidth: innerW });
      y += 20;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(11);
      doc.setTextColor(120);
      const totalPanels = cab.panels?.length ?? cab.partIds.length;
      doc.text(`${totalPanels} panels`, PAGE_PAD, y);
      y += 12;
      const imgH = Math.min(innerW, PAGE_H - y - PAGE_PAD - 8);
      drawSnapshotPanel(doc, cab.assembled, PAGE_PAD, y, innerW, imgH, { frameless: true });
      doc.setTextColor(0);
    }
    if (cab.steps && cab.steps.length > 0) {
      for (let i = 0; i < cab.steps.length; i++) {
        addPage(section);
        const img = cab.steps[i];
        const ratio = img.width > 0 && img.height > 0 ? img.height / img.width : 9 / 16;
        const h = Math.min(innerW * ratio + 40, PAGE_H - 2 * PAGE_PAD);
        const y = PAGE_PAD + (PAGE_H - 2 * PAGE_PAD - h) / 2;
        drawIkeaStepCard(doc, img, cab.stepPanelIds?.[i] ?? '', i + 1, PAGE_PAD, y, innerW, h);
      }
    }
  }

  paginateAndDecorate(doc, dims, opt, sectionPerPage);
  return doc;
}

/** Mobile sheet page: layout drawing (long edge horizontal, as everywhere)
 *  with a compact part list below it. */
function drawMobileSheetPage(doc: jsPDF, sheet: NestSheet, opt: PdfOptions, dims: { w: number; h: number }) {
  const PAGE_W = dims.w;
  const PAGE_H = dims.h;
  const innerW = PAGE_W - 2 * PAGE_PAD;
  let y = PAGE_PAD + 22;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.setTextColor(25);
  doc.text(`Sheet ${sheet.globalIndex}`, PAGE_PAD, y);
  y += 18;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(120);
  const fill = sheet.parts.length > 0 ? (sheet.usedArea / (sheet.sheetW * sheet.sheetL)) * 100 : 0;
  doc.text(
    `${fmtDim(sheet.sheetW, opt.units)} × ${fmtDim(sheet.sheetL, opt.units)} × ${fmtDim(sheet.thickness, opt.units)}  ·  ${sheet.parts.length} parts  ·  ${fill.toFixed(0)}% fill`,
    PAGE_PAD, y, { maxWidth: innerW },
  );
  y += 16;

  // Layout — same long-edge-horizontal convention as every other view.
  const orient = makeOrient(sheet.sheetW, sheet.sheetL);
  const scale = Math.min(innerW / orient.dispW, (PAGE_H * 0.34) / orient.dispH);
  const dW = orient.dispW * scale;
  const dH = orient.dispH * scale;
  const ox = PAGE_PAD + (innerW - dW) / 2;
  doc.setFillColor(245, 239, 217);
  doc.setDrawColor(180, 162, 112);
  doc.setLineWidth(0.8);
  doc.rect(ox, y, dW, dH, 'FD');
  const sheetBox = { x: ox, y, w: dW, h: dH };
  for (const p of sheet.parts) {
    drawPart(doc, p, ox, y, scale, opt, `${sheet.globalIndex}${p.panelLabel}`, orient, sheetBox);
  }
  y += dH + 22;

  // Panel dimensions table — same grouping as the desktop per-sheet table:
  // identical-size panels collapse into one row with a comma-separated code
  // list, a color thumbnail, qty and long × short. Big rows with hairline
  // separators for reading at the saw.
  const rows = groupPanelsBySize(sheet);
  const thumbCell = 34;
  for (const r of rows) {
    if (y > PAGE_H - PAGE_PAD - 8) break;
    const rowMid = y - 4;
    // Thumbnail — aspect-correct color rectangle, long edge horizontal.
    const aspect = r.width / r.length;
    let tw = thumbCell, th = tw * aspect;
    const thumbMaxH = 23;
    if (th > thumbMaxH) { th = thumbMaxH; tw = th / aspect; }
    const [pr, pg, pb] = hexToRgb(r.color);
    const GS = (doc as any).GState;
    if (GS) (doc as any).setGState(new GS({ opacity: 0.50 }));
    doc.setFillColor(pr, pg, pb);
    doc.rect(PAGE_PAD, rowMid - th / 2, tw, th, 'F');
    if (GS) (doc as any).setGState(new GS({ opacity: 1 }));
    doc.setDrawColor(Math.floor(pr * 0.55), Math.floor(pg * 0.55), Math.floor(pb * 0.55));
    doc.setLineWidth(0.5);
    doc.rect(PAGE_PAD, rowMid - th / 2, tw, th, 'S');
    // Code list + qty
    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30);
    const codeX = PAGE_PAD + thumbCell + 10;
    doc.text(r.codes.join(', '), codeX, y, { maxWidth: innerW - thumbCell - 130 });
    if (r.qty > 1) {
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(120);
      doc.text(`×${r.qty}`, codeX, y + 12);
    }
    // Dims — long × short × thick, right-aligned.
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(40);
    doc.text(
      `${fmtDim(r.length, opt.units)} × ${fmtDim(r.width, opt.units)} × ${fmtDim(r.thickness, opt.units)}`,
      PAGE_W - PAGE_PAD, y, { align: 'right' },
    );
    y += r.qty > 1 ? 20 : 12;
    doc.setDrawColor(235);
    doc.setLineWidth(0.4);
    doc.line(PAGE_PAD, y, PAGE_W - PAGE_PAD, y);
    y += 14;
  }
  doc.setTextColor(0);
}

/** Mobile cut page: one cut, full page — big step header, big instruction,
 *  tall diagram (the sheet keeps its natural orientation so it FILLS a
 *  portrait phone screen). */
function drawMobileCutPage(
  doc: jsPDF,
  sc: ReturnType<typeof allCutSteps>[number],
  parts: NestSheet['parts'],
  cutIdx: number,
  opt: PdfOptions,
  dims: { w: number; h: number },
) {
  const PAGE_W = dims.w;
  const PAGE_H = dims.h;
  const innerW = PAGE_W - 2 * PAGE_PAD;
  const cur = sc.steps[cutIdx];
  let y = PAGE_PAD + 18;

  // Reading order at the saw: where am I (small) → WHAT DO I CUT (huge,
  // the action + distance) → measured from which edge (medium).
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10.5);
  doc.setTextColor(140);
  doc.text(`CUT ${cur.index} OF ${sc.steps.length}`, PAGE_PAD, y);
  y += 28;

  let label: string;
  let edgeRef: string;
  if (cur.isTrim) {
    label = 'Trim';
    edgeRef = 'reference edge';
  } else {
    label = cur.axis === 'rip' ? 'Rip' : 'Crosscut';
    // Distances run from the parent's datum corner (top-left): vertical
    // lines measure from the LEFT edge, horizontal lines from the TOP —
    // unless flipped to the far edge, or chain-dimensioned off a previous cut.
    const vertical = (sc.sheetL >= sc.sheetW) ? cur.axis === 'rip' : cur.axis === 'cross';
    const refCut = cur.measureFromCut ? findCutByKey(sc, cur.measureFromCut) : null;
    edgeRef = refCut
      ? `from cut ${refCut.index}`
      : vertical
        ? (cur.fromFar ? 'from the RIGHT edge' : 'from the LEFT edge')
        : (cur.fromFar ? 'from the BOTTOM edge' : 'from the TOP edge');
  }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(26);
  doc.setTextColor(25);
  doc.text(`${label}  ${fmtDim(quotedDistance(cur, sc, opt), opt.units)}`, PAGE_PAD, y);
  y += 20;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(13.5);
  doc.setTextColor(90);
  doc.text(edgeRef, PAGE_PAD, y, { maxWidth: innerW });
  y += 14;
  if (cur.sameSetting) {
    doc.setFontSize(11);
    doc.setTextColor(140);
    doc.text('same guide setting — slide stock to the stops and cut', PAGE_PAD, y, { maxWidth: innerW });
    y += 14;
  }

  // Diagram fills the rest of the page (same orientation as the desktop
  // cut cards). Sits just under the instruction — not vertically centered —
  // so the eye lands on header → instruction → diagram in one line.
  const aspect = sc.sheetL / sc.sheetW;
  const availH = PAGE_H - PAGE_PAD - y - 4;
  const w = Math.min(innerW, availH / aspect);
  const h = w * aspect;
  drawCutDiagram(doc, sc, parts, cutIdx, PAGE_PAD + (innerW - w) / 2, y + Math.min((availH - h) / 2, 30), w, h, opt);
}

/** Tiny sheet layout: cream stock + colored part bboxes. Long edge always
 *  horizontal, matching every other view. */
function drawSheetThumb(doc: jsPDF, sheet: NestSheet, x: number, y: number, w: number, h: number) {
  const orient = makeOrient(sheet.sheetW, sheet.sheetL);
  const scale = Math.min(w / orient.dispW, h / orient.dispH);
  const dW = orient.dispW * scale;
  const dH = orient.dispH * scale;
  const ox = x + (w - dW) / 2;
  const oy = y + (h - dH) / 2;
  doc.setFillColor(245, 239, 217);
  doc.setDrawColor(180, 162, 112);
  doc.setLineWidth(0.6);
  doc.rect(ox, oy, dW, dH, 'FD');
  const GS = (doc as any).GState;
  if (GS) (doc as any).setGState(new GS({ opacity: 0.55 }));
  for (const p of sheet.parts) {
    const r0 = orient.rect(p.x, p.y, p.w, p.h);
    const [r, g, b] = hexToRgb(p.color);
    doc.setFillColor(r, g, b);
    doc.rect(ox + r0.x * scale, oy + r0.y * scale, r0.w * scale, r0.h * scale, 'F');
  }
  if (GS) (doc as any).setGState(new GS({ opacity: 1 }));
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
    'Each panel keeps its 3D color — find the matching code on the Panels page. The exploded view shows the direction each panel comes from when assembling.',
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
 * Draw a snapshot image inside (x, y, w, h):
 *   - Hairline-bordered "stage" panel
 *   - Image centered AND aspect-fit (letterboxed) using the source canvas
 *     dimensions, so a 16:9 snapshot doesn't get stretched into a 4:3 box
 *     or vice versa.
 *
 * Pass `img` (SnapshotImage) for proper aspect fit; a bare string data URL
 * still works (legacy callers) but will stretch.
 */
function drawSnapshotPanel(
  doc: jsPDF,
  img: SnapshotImage | string,
  x: number, y: number, w: number, h: number,
  opts: { frameless?: boolean } = {},
) {
  if (!opts.frameless) {
    doc.setFillColor(247, 246, 243);
    doc.setDrawColor(220);
    doc.setLineWidth(0.6);
    doc.rect(x, y, w, h, 'FD');
  }
  const inset = opts.frameless ? 0 : 6;
  const innerW = w - 2 * inset;
  const innerH = h - 2 * inset;
  const dataUrl = typeof img === 'string' ? img : img.dataUrl;

  // Compute aspect-fit dims
  let drawW = innerW;
  let drawH = innerH;
  if (typeof img !== 'string' && img.width > 0 && img.height > 0) {
    const imgRatio = img.width / img.height;
    const boxRatio = innerW / innerH;
    if (imgRatio > boxRatio) {
      // image is wider than box → fit width, shrink height
      drawW = innerW;
      drawH = innerW / imgRatio;
    } else {
      // image taller → fit height, shrink width
      drawH = innerH;
      drawW = innerH * imgRatio;
    }
  }
  const ox = x + inset + (innerW - drawW) / 2;
  const oy = y + inset + (innerH - drawH) / 2;

  try {
    // JPEG embeds directly (no JS-side decode) — the fast path. PNG kept
    // for legacy callers.
    const fmt = dataUrl.startsWith('data:image/jpeg') ? 'JPEG' : 'PNG';
    doc.addImage(dataUrl, fmt, ox, oy, drawW, drawH, undefined, 'FAST');
  } catch (e) {
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
  let y = PAGE_PAD + 8;

  // Hero — the first cabinet's assembled render fills the right half of the
  // cover. Text metrics live in the left column; without a hero (CNC-only
  // or no cabinets) the layout stays full-width.
  const hero = opt.cabinets?.find((c) => c.assembled)?.assembled;
  const leftW = hero ? (PAGE_W - 2 * PAGE_PAD) * 0.52 : PAGE_W - 2 * PAGE_PAD;
  if (hero) {
    const hx = PAGE_PAD + leftW + 24;
    drawSnapshotPanel(doc, hero, hx, PAGE_PAD + 6, PAGE_W - PAGE_PAD - hx, PAGE_H - 2 * PAGE_PAD - 12, { frameless: true });
  }

  // Title block — job name with a short warm accent bar above it, the same
  // brown family as the sheet stock so the document opens on-brand.
  doc.setFillColor(107, 79, 49);
  doc.rect(PAGE_PAD, y - 2, 34, 3, 'F');
  y += 24;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(26);
  doc.setTextColor(25);
  doc.text(opt.jobName || 'Plywood cut estimate', PAGE_PAD, y);
  y += 22;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(130);
  doc.text(
    `Sheet ${fmtDim(opt.sheetW, opt.units)} × ${fmtDim(opt.sheetL, opt.units)}   ·   margin ${fmtDim(opt.margin, opt.units)}   ·   kerf ${fmtDim(opt.kerf, opt.units)}   ·   ${new Date().toLocaleDateString()}`,
    PAGE_PAD,
    y,
  );
  y += 36;

  // Metrics row — big stats, small-caps labels.
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
  // With a hero, metrics wrap into a 2-per-row grid inside the left column;
  // full-width covers keep the single row.
  const perRow = hero ? 2 : metrics.length;
  const colW = leftW / perRow;
  metrics.forEach(([k, v], i) => {
    const x = PAGE_PAD + (i % perRow) * colW;
    const ry = y + Math.floor(i / perRow) * 52;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(140);
    doc.text(k.toUpperCase(), x, ry);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(22);
    doc.setTextColor(25);
    doc.text(v, x, ry + 24);
  });
  y += 52 * Math.ceil(metrics.length / perRow);

  // Per-thickness breakdown — only when the job actually mixes thicknesses
  // (for a single group it just repeats the totals above).
  if (result.groups.length > 1) {
    y += 8;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(25);
    doc.text('Per-thickness breakdown', PAGE_PAD, y);
    y += 14;

    doc.setFontSize(10);
    doc.setTextColor(130);
    drawRow(doc, ['Thickness', 'Sheets', 'Parts placed', 'Unplaced'], PAGE_PAD, y, [120, 80, 100, 80], true);
    y += 5;
    doc.setDrawColor(225);
    doc.setLineWidth(0.4);
    doc.line(PAGE_PAD, y, PAGE_PAD + 380, y);
    y += 12;
    doc.setTextColor(40);
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
      if (y > PAGE_H - PAGE_PAD - 130) break;
    }
  }

  // Sheet thumbnail strip along the bottom — a visual preview of the job.
  // Constrained to the left column when the hero occupies the right half.
  const sheets = result.groups.flatMap((g) => g.sheets);
  if (sheets.length > 0) {
    const maxThumbs = hero ? 3 : 5;
    const shown = sheets.slice(0, maxThumbs);
    const gutter = 14;
    const stripH = 96;
    const captionH = 13;
    const stripY = PAGE_H - PAGE_PAD - stripH - captionH;
    const s0 = shown[0];
    const aspect = Math.min(s0.sheetW, s0.sheetL) / Math.max(s0.sheetW, s0.sheetL);
    const thumbW = Math.min(
      (leftW - gutter * (shown.length - 1)) / shown.length,
      stripH / aspect,
    );
    const thumbH = thumbW * aspect;
    let x = PAGE_PAD;
    const ty = stripY + (stripH - thumbH);
    for (const s of shown) {
      drawSheetThumb(doc, s, x, ty, thumbW, thumbH);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(130);
      doc.text(`Sheet ${s.globalIndex}`, x, ty + thumbH + 10);
      x += thumbW + gutter;
    }
    if (sheets.length > maxThumbs) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(140);
      doc.text(`+${sheets.length - maxThumbs} more`, x + 2, ty + thumbH / 2 + 3);
    }
  }
  doc.setTextColor(0);
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
function drawSheet(
  doc: jsPDF,
  sheet: NestSheet,
  opt: PdfOptions,
  dims: { w: number; h: number },
  labels?: Map<string, PartLabel>,
  cabinetByPanelId?: Map<string, string>,
  nav?: NavCtx,
  curPage?: () => number,
  /** Cutlist mode: per-panel in-panel dim lines with arrows (see drawPart). */
  detailDims = false,
) {
  const PAGE_W = dims.w;
  const PAGE_H = dims.h;
  // Page furniture (header, meta line, cross-refs) is set in points tuned
  // against the 4:3 cutlist page; on a larger page it scales so it stays in
  // proportion. The job PDF drives its own paper sizes and its type is
  // already tuned per size, so it pins k to 1 and is unaffected.
  const k = detailDims ? cutlistScale(dims) : 1;
  // Use the sheet's actual chosen dims (auto-orient may have swapped them)
  const swMm = sheet.sheetW;
  const slMm = sheet.sheetL;
  const orient = makeOrient(swMm, slMm);
  // Header — title left; ALL the sheet metadata in one line on the right
  // (dims, thickness, part count, fill, reusable offcut).
  //
  // The meta line is composed and MEASURED first, before anything is drawn:
  // it is right-aligned to the page edge, so its real width is what's left
  // for the job title. Reserving a flat number instead was only correct at
  // one page width.
  const fill = sheet.parts.length > 0
    ? (sheet.usedArea / (swMm * slMm)) * 100
    : 0;
  const meta: string[] = [
    `${fmtDim(swMm, opt.units)} × ${fmtDim(slMm, opt.units)} × ${fmtDim(sheet.thickness, opt.units)}`,
    `${sheet.parts.length} parts`,
    `${fill.toFixed(1)}% fill`,
  ];
  if (sheet.largestFree && Math.min(sheet.largestFree.w, sheet.largestFree.h) >= 50) {
    meta.push(`offcut ${fmtDim(Math.max(sheet.largestFree.w, sheet.largestFree.h), opt.units)} × ${fmtDim(Math.min(sheet.largestFree.w, sheet.largestFree.h), opt.units)}`);
  }
  const metaText = meta.join('   ·   ');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9 * k);
  const metaW = doc.getTextWidth(metaText);
  // Left edge of the meta line — nothing drawn from the left may cross it.
  const metaLeft = PAGE_W - PAGE_PAD - metaW - 18 * k;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14 * k);
  doc.text(`Sheet ${sheet.globalIndex}`, PAGE_PAD, PAGE_PAD - 4);
  // Cutlist pages carry the JOB TITLE in the header next to the sheet
  // number (the job PDF has a cover page for this; the cutlist doesn't).
  if (detailDims && opt.jobName) {
    const shW = doc.getTextWidth(`Sheet ${sheet.globalIndex}`);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11 * k);
    doc.setTextColor(110);
    const budget = metaLeft - (PAGE_PAD + shW + 12 * k);
    let title = opt.jobName;
    if (doc.getTextWidth(title) > budget) {
      while (title.length > 3 && doc.getTextWidth(`${title}…`) > budget) title = title.slice(0, -1);
      title += '…';
    }
    doc.text(title, PAGE_PAD + shW + 12 * k, PAGE_PAD - 4);
    doc.setTextColor(0);
  }
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9 * k);
  doc.setTextColor(120);
  doc.text(metaText, PAGE_W - PAGE_PAD, PAGE_PAD - 4, { align: 'right' });
  doc.setTextColor(0);

  // Cross-references under the title, kept to a single subtle line:
  //   - which cabinet each panel belongs to (only when >1 cabinet);
  //   - a "→ Join split parts p.N" note when the sheet carries dovetail
  //     segments (drawn in the nav post-pass, where the page number exists).
  let refX = PAGE_PAD + 64 * k;
  if (cabinetByPanelId && cabinetByPanelId.size > 0) {
    const byCab = new Map<string, string[]>();
    for (const p of sheet.parts) {
      const cab = cabinetByPanelId.get(`${sheet.globalIndex}${p.panelLabel}`);
      if (cab) {
        if (!byCab.has(cab)) byCab.set(cab, []);
        byCab.get(cab)!.push(p.panelLabel);
      }
    }
    if (byCab.size > 1) {
      const refs = Array.from(byCab.entries())
        .map(([cab, ids]) => `${cab}: ${ids.sort().join(',')}`)
        .join('   ·   ');
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5 * k);
      doc.setTextColor(110);
      // Cutlist stops this line at the measured meta line; the job PDF keeps
      // its flat reserve so its pages render exactly as before.
      doc.text(refs, refX, PAGE_PAD - 4, {
        maxWidth: (detailDims ? metaLeft : PAGE_W - 260) - refX,
      });
      refX += doc.getTextWidth(refs) + 18 * k;
      doc.setTextColor(0);
    }
  }
  if (nav && curPage && sheet.parts.some((p) => /\.s\d+$/.test(p.partId))) {
    nav.notes.push({
      page: curPage(),
      x: refX,
      y: PAGE_PAD - 4,
      label: '→ Join split parts',
      target: 'Join split parts',
    });
  }

  // Available drawing area. The gap under the header scales with the header
  // type so a 20pt title on 11×17 can't crowd the stock outline.
  const drawX = PAGE_PAD;
  const drawY = PAGE_PAD + 10 * k;
  const drawW = PAGE_W - 2 * PAGE_PAD;
  const drawH = PAGE_H - drawY - PAGE_PAD;

  // Reserve room for dimension lines outside the sheet
  const dimRoom = 26 * k;
  const innerW = drawW - dimRoom;
  const innerH = drawH - dimRoom;

  const scale = Math.min(innerW / orient.dispW, innerH / orient.dispH);
  const sheetPtW = orient.dispW * scale;
  const sheetPtH = orient.dispH * scale;

  // Center horizontally, top-align vertically
  const ox = drawX + dimRoom + (innerW - sheetPtW) / 2;
  const oy = drawY + (innerH - sheetPtH) / 2;

  // Sheet — cream plywood fill + warm border so colored parts read clearly.
  // Cutlist mode: the stock boundary is a HEAVY line (drafting line-weight
  // hierarchy — object/stock lines thick, dimension lines thin).
  doc.setFillColor(245, 239, 217);
  doc.setDrawColor(180, 162, 112);
  doc.setLineWidth(detailDims ? CUT_STOCK_W : 1.0);
  doc.rect(ox, oy, sheetPtW, sheetPtH, 'FD');

  // Margin (symmetric, so just insets the sheet on all sides — orientation
  // doesn't change the inset).
  if (opt.margin > 0) {
    doc.setDrawColor(180);
    doc.setLineWidth(0.4);
    doc.setLineDashPattern([3, 3], 0);
    doc.rect(
      ox + opt.margin * scale,
      oy + opt.margin * scale,
      sheetPtW - 2 * opt.margin * scale,
      sheetPtH - 2 * opt.margin * scale,
      'S',
    );
    doc.setLineDashPattern([], 0);
  }

  // Parts — pass the sheet box so per-panel dim leaders can spill into
  // adjacent waste areas (between the panel and the sheet's outer edge).
  // Cutlist mode also threads:
  //   - labelReg: per-PAGE registry of placed dimension-label rects, so any
  //     later dim line breaks around earlier labels (resets per drawSheet);
  //   - each part's neighbours' bboxes, so notch dims can prefer free waste
  //     space outside the feature and fall back inside when it's occupied.
  const sheetBox = { x: ox, y: oy, w: sheetPtW, h: sheetPtH };
  const labelReg: DimRegistry | undefined = detailDims ? { rects: [], segs: [] } : undefined;
  const partRects: LabelRect[] = detailDims
    ? sheet.parts.map((p) => {
        const rr = orient.rect(p.x, p.y, p.w, p.h);
        return { x: ox + rr.x * scale, y: oy + rr.y * scale, w: rr.w * scale, h: rr.h * scale };
      })
    : [];
  sheet.parts.forEach((p, i) => {
    const others = detailDims ? partRects.filter((_, j) => j !== i) : undefined;
    drawPart(doc, p, ox, oy, scale, opt, `${sheet.globalIndex}${p.panelLabel}`, orient, sheetBox, detailDims, labelReg, others);
  });

  // Overall sheet dimensions — labels show the actual (long, short) values
  // in their display positions: long edge along the page horizontal. On
  // cutlist pages these go drafting-red like every other dimension.
  const longLabel = fmtDim(Math.max(swMm, slMm), opt.units);
  const shortLabel = fmtDim(Math.min(swMm, slMm), opt.units);
  const sheetInk = detailDims ? CUT_DIM_INK : undefined;
  const sheetDimW = detailDims ? CUT_DIM_W : undefined;
  // Offset and type size ride the same k as dimRoom, so the sheet dimension
  // stays centred in its reserve at every page size (k is 1 on the job PDF).
  drawDimH(doc, ox, ox + sheetPtW, oy + sheetPtH + 14 * k, longLabel, sheetInk, sheetDimW, DIM_TEXT_PT * k);
  drawDimV(doc, oy, oy + sheetPtH, ox - 14 * k, shortLabel, sheetInk, sheetDimW, DIM_TEXT_PT * k);
}

function drawPart(
  doc: jsPDF,
  p: PlacedPart,
  ox: number,
  oy: number,
  scale: number,
  opt: PdfOptions,
  letter: string | undefined,
  orient: Orient,
  /** Sheet bounding box in display pt — used to detect free margin around
   *  the panel so dim leaders can spill outside the panel into waste area. */
  sheetBox?: { x: number; y: number; w: number; h: number },
  /** Cutlist detail mode: in-panel ANSI dimension lines with arrows on both
   *  axes instead of the plain text label. Drawn for EVERY panel regardless
   *  of size — the cutlist targets tablet viewing, so the reader zooms. */
  detailDims = false,
  /** Cutlist per-PAGE registry of placed label rects + drawn dim segments
   *  (page pt). Dim lines break around every rect already in it; each label
   *  placed here pushes its own rect. Owned and reset by drawSheet. */
  labelReg?: DimRegistry,
  /** Bboxes (page pt) of the OTHER parts on the sheet — used to decide
   *  whether the waste space outside a notch edge is free for a witness-line
   *  dim or occupied by a neighbouring panel. */
  otherRects?: LabelRect[],
) {
  const [r, g, b] = hexToRgb(p.color);
  const GS = (doc as any).GState;
  doc.setFillColor(r, g, b);
  // Cutlist mode reads like a mechanical drawing: faint identifying tint,
  // HEAVY near-black object lines (ASME line-weight hierarchy — the color
  // stroke would dilute the thick/thin contrast against the red dims).
  if (detailDims) {
    doc.setDrawColor(...CUT_OBJ_INK);
    doc.setLineWidth(CUT_OBJ_W);
  } else {
    doc.setDrawColor(Math.floor(r * 0.55), Math.floor(g * 0.55), Math.floor(b * 0.55));
    doc.setLineWidth(0.7);
  }

  // Cutlist mode draws OUTLINES ONLY — no fill tint and no white hole
  // fill (split-line slots on a body rendered as glaring white strips
  // otherwise). The job-PDF path keeps the 50%-opacity color fill.
  if (!detailDims) {
    if (GS) (doc as any).setGState(new GS({ opacity: 0.50 }));
    drawPolygon(doc, p.outer, p.x, p.y, ox, oy, scale, 'F', orient);
    if (GS) (doc as any).setGState(new GS({ opacity: 1 }));
  }
  drawPolygon(doc, p.outer, p.x, p.y, ox, oy, scale, 'S', orient);

  // Holes: white fill + stroke on the job PDF; stroke only on the cutlist.
  doc.setFillColor(255, 255, 255);
  for (const hole of p.holes) {
    if (!detailDims) drawPolygon(doc, hole, p.x, p.y, ox, oy, scale, 'F', orient);
    if (detailDims) doc.setDrawColor(...CUT_OBJ_INK);
    else doc.setDrawColor(Math.floor(r * 0.55), Math.floor(g * 0.55), Math.floor(b * 0.55));
    drawPolygon(doc, hole, p.x, p.y, ox, oy, scale, 'S', orient);
  }

  const r0 = orient.rect(p.x, p.y, p.w, p.h);

  const px = ox + r0.x * scale;
  const py = oy + r0.y * scale;
  const pwPt = r0.w * scale;
  const phPt = r0.h * scale;
  const cx = px + pwPt / 2;
  const cy = py + phPt / 2;
  const partPt = Math.min(pwPt, phPt);
  // Always show the LONG side first so the readout matches the layout
  const longMm = Math.max(p.w, p.h);
  const shortMm = Math.min(p.w, p.h);
  doc.setTextColor(20);

  if (detailDims) {
    // Mechanical-drawing dimensioning (SolidWorks-style): thin drafting-RED
    // dim lines INSIDE the part spanning its display extents, slender 3:1
    // arrowheads with tips on the part edges, and the value set in a GAP
    // broken into the line — width text unidirectional, height text aligned
    // with its line — so nothing strikes through and it reads over any
    // fill. Every panel gets dims regardless of size: the export targets
    // tablet viewing, so type may go tiny and the reader zooms.
    // Every value registers its rect in `reg`; every line goes through
    // brokenLine(reg) — that's what makes the gaps AND breaks any line that
    // would strike through an earlier label on the page.
    const reg: DimRegistry = labelReg ?? { rects: [], segs: [] };
    const wLabel = fmtDim(r0.w, opt.units);
    const hLabel = fmtDim(r0.h, opt.units);
    doc.setDrawColor(...CUT_DIM_INK);
    doc.setFillColor(...CUT_DIM_INK);
    doc.setTextColor(...CUT_DIM_INK);
    doc.setLineWidth(CUT_DIM_W);
    doc.setFont('helvetica', 'normal');
    // Type scales with the part; shrink further until neither value spills
    // past its span into a neighbouring panel.
    let fs = clamp(partPt * 0.16, 3.5, 8);
    doc.setFontSize(fs);
    while (fs > 2.6 && (doc.getTextWidth(wLabel) > pwPt - 4 || doc.getTextWidth(hLabel) > phPt - 4)) {
      fs -= 0.4;
      doc.setFontSize(fs);
    }
    const aLen = Math.min(4.5, pwPt * 0.22, phPt * 0.22);
    const aW = aLen / 3;
    // Strips too thin for a dim band per axis get NOTE dimensioning: the
    // id + "W × H" set together in one gap on the strip's centerline, with
    // the arrows spanning the long way. Standard practice for features too
    // small to dimension in place.
    const STRIP = 22;
    const shortStrip = phPt < STRIP && pwPt >= phPt;
    const narrowStrip = pwPt < STRIP && phPt > pwPt;
    if (shortStrip || narrowStrip) {
      const note = `${wLabel} × ${hLabel}`;
      const runPt = shortStrip ? pwPt : phPt;   // extent along the strip
      const acrossPt = shortStrip ? phPt : pwPt; // extent across the strip
      let sfs = clamp(acrossPt * 0.55, 3, 7.5);
      const idText = letter ?? '';
      const measure = () => {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(sfs);
        const idW = idText ? doc.getTextWidth(idText) + 6 : 0;
        doc.setFont('helvetica', 'normal');
        return { idW, noteW: doc.getTextWidth(note) };
      };
      let m = measure();
      while (sfs > 2.6 && m.idW + m.noteW > runPt - 2 * aLen - 6) {
        sfs -= 0.4;
        m = measure();
      }
      const total = m.idW + m.noteW;
      if (shortStrip) {
        // Register the combined id+note rect FIRST — brokenLine then leaves
        // the gap and skips any earlier label the run would strike through.
        const noteRect = { x: cx - total / 2, y: cy - sfs * 0.55, w: total, h: sfs * 1.1 };
        reg.rects.push(noteRect);
        maskDimText(doc, noteRect);
        brokenLine(doc, px, cy, px + pwPt, cy, reg);
        drawDimTri(doc, px, cy, +1, 0, aLen, aW);
        drawDimTri(doc, px + pwPt, cy, -1, 0, aLen, aW);
        const startX = cx - total / 2;
        if (idText) {
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(...CUT_OBJ_INK);
          doc.text(idText, startX, cy + sfs * 0.35);
        }
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...CUT_DIM_INK);
        doc.text(note, startX + m.idW, cy + sfs * 0.35);
      } else {
        // Rotated run reads bottom-to-top along the vertical centerline.
        const noteRectV = { x: cx - sfs * 0.6, y: cy - total / 2, w: sfs * 1.1, h: total };
        reg.rects.push(noteRectV);
        maskDimText(doc, noteRectV);
        brokenLine(doc, cx, py, cx, py + phPt, reg);
        drawDimTri(doc, cx, py, 0, +1, aLen, aW);
        drawDimTri(doc, cx, py + phPt, 0, -1, aLen, aW);
        const startY = cy + total / 2;
        if (idText) {
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(...CUT_OBJ_INK);
          doc.text(idText, cx + sfs * 0.34, startY, { angle: 90 });
        }
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...CUT_DIM_INK);
        doc.text(note, cx + sfs * 0.34, startY - m.idW, { angle: 90 });
      }
      doc.setTextColor(0);
      return;
    }
    const narrow = pwPt < 48;
    // Simplified outline + holes in page pt — drive the dim-line material
    // scan, the id-in-void guard and the concave/angle extras below.
    const ring = partRingPt(p, ox, oy, scale, orient);
    const isRect = ringIsRect(ring);
    const holesPt = p.holes.map((h) => ringToPt(h, p.x, p.y, ox, oy, scale, orient));
    const inMat = (x: number, y: number) =>
      pointInRing(ring, x, y) && !holesPt.some((hh) => pointInRing(hh, x, y));
    let hy = py + clamp(phPt * 0.18, 8, 16);
    // Height dim runs down the CENTER of narrow panels — there is no room
    // for a left-inset line plus rotated text without touching the edges.
    let vx = narrow ? cx : px + clamp(pwPt * 0.18, 8, 16);
    // Parts with notches or holes: the fixed inset can land the dim line
    // (and its value) inside a hinge hole or a notch void — scan for the
    // nearest position whose whole run sits on solid material. First pass
    // demands clearance for the VALUE's glyph band too (so the label never
    // lies on a hole/notch edge); tight parts fall back to line-only.
    if (!isRect || holesPt.length > 0) {
      const bandC = fs * 0.8;
      const hyDef = hy;
      const vxDef = vx;
      const scoreH = (yy: number) =>
        segMaterialScore(px + 2, yy, px + pwPt - 2, yy, ring, holesPt);
      const scoreHBand = (yy: number) =>
        Math.min(scoreH(yy - bandC), scoreH(yy), scoreH(yy + bandC));
      const scoreV = (xx: number) =>
        segMaterialScore(xx, py + 2, xx, py + phPt - 2, ring, holesPt);
      const scoreVBand = (xx: number) =>
        Math.min(scoreV(xx - bandC), scoreV(xx), scoreV(xx + bandC));
      hy = bestDimLinePos(hyDef, py + 4, py + phPt - 4, scoreHBand);
      if (scoreHBand(hy) < DIM_SCAN_SAMPLES) hy = bestDimLinePos(hyDef, py + 4, py + phPt - 4, scoreH);
      vx = bestDimLinePos(vxDef, px + 4, px + pwPt - 4, scoreVBand);
      if (scoreVBand(vx) < DIM_SCAN_SAMPLES) vx = bestDimLinePos(vxDef, px + 4, px + pwPt - 4, scoreV);
    }
    // BOTH values are registered before EITHER line is drawn. brokenLine only
    // breaks around rects already in the registry, so registering per-dim (W
    // rect → W line → H rect → H line) left the width line striking the
    // height value, which had not been registered yet — the break was
    // one-directional. On a narrow strip the two cross at right angles and
    // the width line ran straight through the rotated "63.0 mm".
    const wTw = doc.getTextWidth(wLabel);
    const hTw = doc.getTextWidth(hLabel);
    const wRect = labelRectAt(cx, hy, wTw, fs, 0);
    const hRect = labelRectAt(vx, cy, hTw, fs, 90);
    reg.rects.push(wRect, hRect);
    maskDimText(doc, wRect);
    maskDimText(doc, hRect);
    // Width dim
    brokenLine(doc, px, hy, px + pwPt, hy, reg);
    drawDimTri(doc, px, hy, +1, 0, aLen, aW);
    drawDimTri(doc, px + pwPt, hy, -1, 0, aLen, aW);
    doc.text(wLabel, cx, hy + fs * 0.35, { align: 'center' });
    // Height dim — vertical line broken around the rotated value.
    brokenLine(doc, vx, py, vx, py + phPt, reg);
    drawDimTri(doc, vx, py, 0, +1, aLen, aW);
    drawDimTri(doc, vx, py + phPt, 0, -1, aLen, aW);
    // Default (left) align: with angle 90 the run starts at the anchor and
    // reads upward, so start it at cy + textW/2 to center on the gap.
    // NEVER pair align:'center' with angle — jsPDF shifts the rotated text
    // by -textW/2 along the UNROTATED x-axis, dragging it off the line.
    doc.text(hLabel, vx + fs * 0.34, cy + hTw / 2, { angle: 90 });
    // Panel id — bold near-black (a part LABEL, not a dimension), kept clear
    // of both dim bands: centered for wide panels; upper-middle for narrow
    // ones (their height dim owns the vertical centerline).
    if (letter) {
      doc.setTextColor(...CUT_OBJ_INK);
      doc.setFont('helvetica', 'bold');
      const idFs = clamp(partPt * 0.2, 5, 12);
      doc.setFontSize(idFs);
      let idX = cx;
      let idY = narrow
        ? clamp(py + phPt * 0.30, hy + idFs + 2, cy - hTw / 2 - 4)
        : cy + idFs * 0.34;
      // Concave/holed outlines: the bbox center may fall in a notch void or
      // a hole — move the id to the polygon centroid when it does (fail
      // soft if the centroid is off material too, e.g. extreme L's).
      if ((!isRect || holesPt.length > 0) && !inMat(idX, idY - idFs * 0.35)) {
        const c = ringCentroid(ring);
        if (inMat(c[0], c[1])) {
          idX = c[0];
          idY = c[1] + idFs * 0.35;
        }
      }
      doc.text(letter, idX, idY, { align: 'center' });
      reg.rects.push(labelRectAt(idX, idY - idFs * 0.35, doc.getTextWidth(letter), idFs, 0));
      // Panel NAME under the id — tells the reader where this piece goes in
      // the finished build ("side_left", "top", …). Skipped on narrow/short
      // panels (no room; the panel tables carry the name there).
      const name = (p.partName ?? '').trim();
      if (name && !narrow && phPt >= 30) {
        doc.setFont('helvetica', 'normal');
        let nfs = clamp(idFs * 0.55, 3, 7);
        doc.setFontSize(nfs);
        const ny = () => idY + nfs + 3;
        // Must fit the panel width AND, on concave/holed outlines, stay on
        // material (not stretch across a notch void or a hole).
        const fits = () => {
          const w = doc.getTextWidth(name);
          if (w > pwPt - 6) return false;
          if (isRect && holesPt.length === 0) return true;
          const yq = ny() - nfs * 0.35;
          return inMat(idX - w / 2, yq) && inMat(idX + w / 2, yq);
        };
        while (nfs > 2.6 && !fits()) {
          nfs -= 0.4;
          doc.setFontSize(nfs);
        }
        if (fits()) {
          doc.setTextColor(90);
          doc.text(name, idX, ny(), { align: 'center' });
          reg.rects.push(labelRectAt(idX, ny() - nfs * 0.35, doc.getTextWidth(name), nfs, 0));
          doc.setTextColor(...CUT_OBJ_INK);
        }
        doc.setFont('helvetica', 'bold');
      }
    }
    // Non-rectangular outlines (L-shapes, notches, bevels) additionally get
    // per-edge dims on every edge off the bbox perimeter and angle dims at
    // every non-square corner.
    if (!isRect) drawOutlineDetailDims(doc, ring, scale, opt, fs, aLen, reg, otherRects, sheetBox);
    doc.setTextColor(0);
    return;
  }

  // One label block INSIDE the part: panel id ("1a") with the dimensions
  // stacked underneath — same convention as the cut cards. No dim lines or
  // leader callouts; everything the reader needs sits on the part itself.
  if (letter) {
    const big = clamp(partPt * 0.30, 8, 30);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(big);
    const dimText = `${fmtDim(longMm, opt.units)} × ${fmtDim(shortMm, opt.units)}`;
    doc.setFontSize(clamp(big * 0.45, 6, 10));
    const dimsFit = partPt >= 34 && doc.getTextWidth(dimText) <= pwPt - 6;
    doc.setFontSize(big);
    if (dimsFit) {
      doc.text(letter, cx, cy - big * 0.10, { align: 'center' });
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(clamp(big * 0.45, 6, 10));
      doc.setTextColor(80);
      doc.text(dimText, cx, cy + big * 0.62, { align: 'center' });
      doc.setTextColor(20);
    } else {
      doc.text(letter, cx, cy + big * 0.34, { align: 'center' });
    }
  }
  void sheetBox;
}

// ---------------------------------------------------------------------------
// Cutlist extras for NON-RECTANGULAR outlines (L-shapes, notches, bevels):
//   - every simplified outline edge NOT lying on the part's bbox perimeter
//     gets its own aligned length dim (the bbox W/H dims stay);
//   - every corner whose interior angle isn't square (90°, or 270° at an
//     inside notch corner) gets a small angle arc + degree value.
// All in the thin red dim ink. Dims prefer the free waste space just OUTSIDE
// the feature (classic witness-line style); when a neighbouring panel sits
// there, they fall back to a gap-in-line dim INSIDE the material.
// ---------------------------------------------------------------------------
function drawOutlineDetailDims(
  doc: jsPDF,
  ring: [number, number][],
  scale: number,
  opt: PdfOptions,
  fs: number,
  aLen: number,
  reg: DimRegistry,
  otherRects?: LabelRect[],
  sheetBox?: { x: number; y: number; w: number; h: number },
) {
  const n = ring.length;
  if (n < 3) return;
  const xs = ring.map((q) => q[0]);
  const ys = ring.map((q) => q[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const EPS = 0.35;

  doc.setFont('helvetica', 'normal');
  doc.setDrawColor(...CUT_DIM_INK);
  doc.setFillColor(...CUT_DIM_INK);
  doc.setTextColor(...CUT_DIM_INK);
  doc.setLineWidth(CUT_DIM_W);
  const efs = clamp(fs, 2.8, 6.5);

  // ---- Edge dims for every edge off the bbox perimeter -------------------
  for (let i = 0; i < n; i++) {
    const [axP, ayP] = ring[i];
    const [bxP, byP] = ring[(i + 1) % n];
    const onPerim =
      (Math.abs(axP - minX) < EPS && Math.abs(bxP - minX) < EPS) ||
      (Math.abs(axP - maxX) < EPS && Math.abs(bxP - maxX) < EPS) ||
      (Math.abs(ayP - minY) < EPS && Math.abs(byP - minY) < EPS) ||
      (Math.abs(ayP - maxY) < EPS && Math.abs(byP - maxY) < EPS);
    if (onPerim) continue;
    const ex = bxP - axP;
    const ey = byP - ayP;
    const eLen = Math.hypot(ex, ey);
    if (eLen < 2.5) continue; // invisible at page scale — skip
    const ux = ex / eLen;
    const uy = ey / eLen;
    const mx = (axP + bxP) / 2;
    const my = (ayP + byP) / 2;
    // Material side via point-in-ring probe just off the edge midpoint.
    let inx = -uy;
    let iny = ux;
    const probe = Math.max(0.8, Math.min(2, eLen * 0.2));
    if (!pointInRing(ring, mx + inx * probe, my + iny * probe)) {
      inx = -inx;
      iny = -iny;
    }
    const outx = -inx;
    const outy = -iny;
    const label = fmtDim(eLen / scale, opt.units);
    let lfs = efs;
    doc.setFontSize(lfs);
    while (lfs > 2.6 && doc.getTextWidth(label) > eLen - 2) {
      lfs -= 0.4;
      doc.setFontSize(lfs);
    }
    // Reading angle along the edge, normalized so text is never upside-down.
    let A = (Math.atan2(-ey, ex) * 180) / Math.PI;
    if (A > 90) A -= 180;
    else if (A <= -90) A += 180;
    // Keep arrowheads legible: full size when they fit between the ends,
    // flipped OUTSIDE (standard small-dimension practice) when they don't —
    // never shrunk into invisibility.
    const aE = aLen;
    const arrW = aE / 3;
    const arrowsInside = eLen >= 2 * aE + 4;
    // Is the waste band just outside the edge actually free? (inside sheet,
    // no neighbouring panel bbox in the way)
    const OFF = clamp(eLen * 0.35, 5, 8);
    const bandR = OFF + lfs + 3;
    const bandPts = [
      [axP + outx, ayP + outy],
      [bxP + outx, byP + outy],
      [axP + outx * bandR, ayP + outy * bandR],
      [bxP + outx * bandR, byP + outy * bandR],
    ];
    const bMinX = Math.min(...bandPts.map((q) => q[0]));
    const bMaxX = Math.max(...bandPts.map((q) => q[0]));
    const bMinY = Math.min(...bandPts.map((q) => q[1]));
    const bMaxY = Math.max(...bandPts.map((q) => q[1]));
    const band: LabelRect = { x: bMinX, y: bMinY, w: bMaxX - bMinX, h: bMaxY - bMinY };
    const inSheet =
      !sheetBox ||
      (band.x >= sheetBox.x && band.y >= sheetBox.y &&
        band.x + band.w <= sheetBox.x + sheetBox.w &&
        band.y + band.h <= sheetBox.y + sheetBox.h);
    const free = inSheet && !(otherRects ?? []).some((rct) => rectsOverlap(band, rct));
    if (free) {
      // Witness-line style in the waste: short extension lines off the edge
      // (1.5pt clear of it, 2pt past the dim line), thin red dim line with
      // small arrows between them, value above the line.
      doc.line(axP + outx * 1.5, ayP + outy * 1.5, axP + outx * (OFF + 2), ayP + outy * (OFF + 2));
      doc.line(bxP + outx * 1.5, byP + outy * 1.5, bxP + outx * (OFF + 2), byP + outy * (OFF + 2));
      reg.segs.push({ x1: axP + outx * 1.5, y1: ayP + outy * 1.5, x2: axP + outx * (OFF + 2), y2: ayP + outy * (OFF + 2) });
      reg.segs.push({ x1: bxP + outx * 1.5, y1: byP + outy * 1.5, x2: bxP + outx * (OFF + 2), y2: byP + outy * (OFF + 2) });
      const a2x = axP + outx * OFF;
      const a2y = ayP + outy * OFF;
      const b2x = bxP + outx * OFF;
      const b2y = byP + outy * OFF;
      // Value sits on the far side of the dim line (its ascent side),
      // slid further along it if something already occupies the spot.
      const rad = (A * Math.PI) / 180;
      const defX = (a2x + b2x) / 2 - Math.sin(rad) * (lfs * 0.62 + 1);
      const defY = (a2y + b2y) / 2 - Math.cos(rad) * (lfs * 0.62 + 1);
      const tPos = slideLabelClear(
        reg, defX, defY, doc.getTextWidth(label), lfs, A,
        -Math.sin(rad), -Math.cos(rad),
      );
      // placeAlignedText DRAWS the value, so the mask has to go down first —
      // masking afterwards would paint over the number.
      const edgeRect = labelRectAt(tPos.x, tPos.y, doc.getTextWidth(label), lfs, A);
      reg.rects.push(edgeRect);
      maskDimText(doc, edgeRect);
      placeAlignedText(doc, label, tPos.x, tPos.y, lfs, A);
      // When the value had to move well away from its line, tie it back
      // with a thin leader (clips out of the label rect automatically).
      if (Math.hypot(tPos.x - defX, tPos.y - defY) > lfs * 2.5) {
        brokenLine(doc, tPos.x, tPos.y, (a2x + b2x) / 2, (a2y + b2y) / 2, reg);
      }
      brokenLine(doc, a2x, a2y, b2x, b2y, reg);
      // Standard drafting: arrows go between the extension lines when they
      // fit; on small dimensions they flip OUTSIDE, pointing inward, with
      // short tails past the extension lines.
      if (arrowsInside) {
        drawDimTriDir(doc, a2x, a2y, ux, uy, aE, arrW);
        drawDimTriDir(doc, b2x, b2y, -ux, -uy, aE, arrW);
      } else {
        const tail = aE + 2.5;
        doc.line(a2x, a2y, a2x - ux * tail, a2y - uy * tail);
        doc.line(b2x, b2y, b2x + ux * tail, b2y + uy * tail);
        reg.segs.push({ x1: a2x, y1: a2y, x2: a2x - ux * tail, y2: a2y - uy * tail });
        reg.segs.push({ x1: b2x, y1: b2y, x2: b2x + ux * tail, y2: b2y + uy * tail });
        drawDimTriDir(doc, a2x, a2y, -ux, -uy, aE, arrW);
        drawDimTriDir(doc, b2x, b2y, ux, uy, aE, arrW);
      }
    } else {
      // Inside fallback: aligned dim line inset into the material with the
      // value in a gap broken into the line — same idiom as the W/H dims.
      // If the midpoint is taken (earlier label/line), the value slides
      // ALONG the line so the gap-in-line look survives.
      const OFFIN = clamp(eLen * 0.18, 3.5, 7);
      const a2x = axP + inx * OFFIN;
      const a2y = ayP + iny * OFFIN;
      const b2x = bxP + inx * OFFIN;
      const b2y = byP + iny * OFFIN;
      const tw = doc.getTextWidth(label);
      const tPos = slideLabelClear(reg, (a2x + b2x) / 2, (a2y + b2y) / 2, tw, lfs, A, ux, uy);
      const insideRect = labelRectAt(tPos.x, tPos.y, tw, lfs, A);
      reg.rects.push(insideRect);
      maskDimText(doc, insideRect);
      brokenLine(doc, a2x, a2y, b2x, b2y, reg);
      if (arrowsInside) {
        drawDimTriDir(doc, a2x, a2y, ux, uy, aE, arrW);
        drawDimTriDir(doc, b2x, b2y, -ux, -uy, aE, arrW);
      } else {
        const tail = aE + 2.5;
        doc.line(a2x, a2y, a2x - ux * tail, a2y - uy * tail);
        doc.line(b2x, b2y, b2x + ux * tail, b2y + uy * tail);
        reg.segs.push({ x1: a2x, y1: a2y, x2: a2x - ux * tail, y2: a2y - uy * tail });
        reg.segs.push({ x1: b2x, y1: b2y, x2: b2x + ux * tail, y2: b2y + uy * tail });
        drawDimTriDir(doc, a2x, a2y, -ux, -uy, aE, arrW);
        drawDimTriDir(doc, b2x, b2y, ux, uy, aE, arrW);
      }
    }
  }

  // ---- Angle dims at non-square corners -----------------------------------
  for (let i = 0; i < n; i++) {
    const [pxP, pyP] = ring[(i - 1 + n) % n];
    const [vx, vy] = ring[i];
    const [nxP, nyP] = ring[(i + 1) % n];
    const lenA = Math.hypot(pxP - vx, pyP - vy);
    const lenB = Math.hypot(nxP - vx, nyP - vy);
    if (Math.min(lenA, lenB) < 4) continue; // too tiny to annotate
    const uax = (pxP - vx) / lenA;
    const uay = (pyP - vy) / lenA;
    const ubx = (nxP - vx) / lenB;
    const uby = (nyP - vy) / lenB;
    const raw = (Math.acos(clamp(uax * ubx + uay * uby, -1, 1)) * 180) / Math.PI;
    // Bisector of the raw (≤180°) angle; interior is whichever side of the
    // corner the material actually lies on.
    let bx = uax + ubx;
    let by = uay + uby;
    const bl = Math.hypot(bx, by);
    if (bl < 1e-6) continue; // straight edge — simplify removed these anyway
    bx /= bl;
    by /= bl;
    const probe = Math.max(0.6, Math.min(1.5, Math.min(lenA, lenB) * 0.1));
    let interior = raw;
    if (!pointInRing(ring, vx + bx * probe, vy + by * probe)) {
      interior = 360 - raw;
      bx = -bx;
      by = -by;
    }
    // Square corners — plain 90° or a square inside-notch corner (270°) —
    // get nothing, per drafting convention.
    if (Math.abs(interior - 90) <= 0.5 || Math.abs(interior - 270) <= 0.5) continue;
    const rArc = clamp(Math.min(lenA, lenB) * 0.4, 3.5, 10);
    // Degree value just outside the arc's midpoint, along the bisector.
    const afs = clamp(efs * 0.9, 2.8, 6);
    doc.setFontSize(afs);
    const angLabel =
      Math.abs(interior - Math.round(interior)) < 0.05
        ? `${Math.round(interior)}°`
        : `${interior.toFixed(1)}°`;
    // Slide the value further along the bisector when the first spot is
    // already taken by an earlier label or dim line.
    const defLx = vx + bx * (rArc + afs * 0.8 + 1.5);
    const defLy = vy + by * (rArc + afs * 0.8 + 1.5);
    const lPos = slideLabelClear(reg, defLx, defLy, doc.getTextWidth(angLabel), afs, 0, bx, by);
    // Mask before drawing, as above.
    const angRect = labelRectAt(lPos.x, lPos.y, doc.getTextWidth(angLabel), afs, 0);
    reg.rects.push(angRect);
    maskDimText(doc, angRect);
    placeAlignedText(doc, angLabel, lPos.x, lPos.y, afs, 0);
    // Far-slid value → leader back to the arc midpoint.
    if (Math.hypot(lPos.x - defLx, lPos.y - defLy) > afs * 2.5) {
      brokenLine(doc, lPos.x, lPos.y, vx + bx * rArc, vy + by * rArc, reg);
    }
    // Arc between the two edges, swept through the interior bisector.
    const TWO_PI = 2 * Math.PI;
    const angA = Math.atan2(uay, uax);
    const angB = Math.atan2(uby, ubx);
    const angM = Math.atan2(by, bx);
    const ccw = (angB - angA + TWO_PI) % TWO_PI;
    const mOff = (angM - angA + TWO_PI) % TWO_PI;
    const sweep = mOff <= ccw ? ccw : -(TWO_PI - ccw);
    const steps = Math.max(6, Math.ceil(Math.abs((sweep * 180) / Math.PI) / 12));
    let prevX = vx + Math.cos(angA) * rArc;
    let prevY = vy + Math.sin(angA) * rArc;
    for (let s = 1; s <= steps; s++) {
      const t = angA + (sweep * s) / steps;
      const cxA = vx + Math.cos(t) * rArc;
      const cyA = vy + Math.sin(t) * rArc;
      brokenLine(doc, prevX, prevY, cxA, cyA, reg);
      prevX = cxA;
      prevY = cyA;
    }
    // Arrowheads at both arc ends, tangent to the arc (standard angular
    // dimensioning) — skipped on arcs too small to carry them.
    const sgn = sweep >= 0 ? 1 : -1;
    const aA = Math.min(aLen * 0.9, rArc * 0.55, Math.abs(sweep) * rArc * 0.4);
    if (aA >= 1.6) {
      const angE = angA + sweep;
      drawDimTriDir(
        doc,
        vx + Math.cos(angA) * rArc, vy + Math.sin(angA) * rArc,
        -Math.sin(angA) * sgn, Math.cos(angA) * sgn,
        aA, aA / 3,
      );
      drawDimTriDir(
        doc,
        vx + Math.cos(angE) * rArc, vy + Math.sin(angE) * rArc,
        Math.sin(angE) * sgn, -Math.cos(angE) * sgn,
        aA, aA / 3,
      );
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
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
  orient?: Orient,
) {
  if (ring.length < 3) return;
  const pts: [number, number][] = ring.map(([x, y]) => {
    const sx = x + offX;
    const sy = y + offY;
    if (orient && orient.rotated) {
      return [ox + sy * scale, oy + sx * scale];
    }
    return [ox + sx * scale, oy + sy * scale];
  });
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

// Cutlist (detailDims) drawing palette — SolidWorks-style mechanical drawing:
// every dimension element (lines, witness lines, arrowheads, arcs, values)
// in drafting RED over near-BLACK object lines. The faint per-part fill
// tint keeps carrying panel identity; strokes don't.
// EXTRA-FINE line weights (user preference): the thick-thin drafting
// hierarchy survives (object ≈ 2.8 × dim), but everything is much lighter
// than classic print weights — the iPad reader zooms anyway.
const CUT_DIM_INK: [number, number, number] = [200, 30, 30];
const CUT_OBJ_INK: [number, number, number] = [25, 25, 25];
const CUT_OBJ_W = 0.4;   // part outline (object line) weight — near-hairline
const CUT_STOCK_W = 0.8; // sheet (stock boundary) weight
const CUT_DIM_W = 0.25;  // dimension line weight
/** Cream plywood fill of the stock rectangle. */
const SHEET_FILL: [number, number, number] = [245, 239, 217];

/**
 * Background mask behind a dimension value — the drafting "text mask".
 *
 * brokenLine keeps DIMENSION lines out of a value's box, but it cannot help
 * with the panel OUTLINES: those are object lines, drawn per part before any
 * dimension exists, and breaking a part boundary to let a number through
 * would misrepresent the part. A notch or bevel value that lands on an edge
 * therefore sat directly on top of it.
 *
 * Masking is what CAD does here. In cutlist mode panels are stroke-only — no
 * fill tint — so everything behind a value is the stock rectangle's cream.
 * Painting that colour into the value's box is invisible against the sheet
 * and hides whatever crosses it, whichever pass drew it.
 *
 * Call between registering the rect and drawing the value: dimension lines
 * are broken around the box anyway, so they are unaffected. Restores the dim
 * ink as the fill colour, since the arrowheads that follow are filled with it.
 */
function maskDimText(doc: jsPDF, r: LabelRect, pad = 0.6) {
  doc.setFillColor(...SHEET_FILL);
  doc.rect(r.x - pad, r.y - pad, r.w + pad * 2, r.h + pad * 2, 'F');
  doc.setFillColor(...CUT_DIM_INK);
}

function drawDimH(
  doc: jsPDF, x1: number, x2: number, y: number, label: string,
  ink: [number, number, number] = DIM_COLOR, lineW = DIM_LINE_W,
  /** Value type size. Overridable so the cutlist's overall-sheet dimension
   *  can scale with the page like the rest of its chrome. */
  textPt = DIM_TEXT_PT,
) {
  doc.setDrawColor(...ink);
  doc.setLineWidth(lineW);
  // Witness lines from the object edge across the dim line
  doc.line(x1, y - DIM_WITNESS_OVER - 2, x1, y + DIM_WITNESS_GAP);
  doc.line(x2, y - DIM_WITNESS_OVER - 2, x2, y + DIM_WITNESS_GAP);
  // Dim line
  doc.line(x1, y, x2, y);
  // Inward-pointing triangular arrowheads
  doc.setFillColor(...ink);
  drawDimTri(doc, x1, y, +1, 0);
  drawDimTri(doc, x2, y, -1, 0);
  // Horizontal label centered above the dim line
  doc.setTextColor(...ink);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(textPt);
  doc.text(label, (x1 + x2) / 2, y - 3, { align: 'center' });
  doc.setTextColor(0);
}

function drawDimV(
  doc: jsPDF, y1: number, y2: number, x: number, label: string,
  ink: [number, number, number] = DIM_COLOR, lineW = DIM_LINE_W,
  textPt = DIM_TEXT_PT,
) {
  doc.setDrawColor(...ink);
  doc.setLineWidth(lineW);
  // Witness lines
  doc.line(x - DIM_WITNESS_GAP, y1, x + DIM_WITNESS_OVER + 2, y1);
  doc.line(x - DIM_WITNESS_GAP, y2, x + DIM_WITNESS_OVER + 2, y2);
  doc.line(x, y1, x, y2);
  doc.setFillColor(...ink);
  drawDimTri(doc, x, y1, 0, +1);
  drawDimTri(doc, x, y2, 0, -1);
  // Vertical text: rotated 90° beside the dim line
  doc.setTextColor(...ink);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(textPt);
  doc.text(label, x - 4, (y1 + y2) / 2, { align: 'center', angle: 90 });
  doc.setTextColor(0);
}

/** Small filled triangle at (x, y) pointing in (dx, dy). Arrow size is
 *  overridable so in-panel dims on tiny parts can shrink to fit. */
function drawDimTri(
  doc: jsPDF, x: number, y: number, dx: number, dy: number,
  len = DIM_ARROW_LEN, w = DIM_ARROW_W,
) {
  let p1: [number, number], p2: [number, number], p3: [number, number];
  if (dx !== 0) {
    p1 = [x, y];
    p2 = [x + dx * len, y - w];
    p3 = [x + dx * len, y + w];
  } else {
    p1 = [x, y];
    p2 = [x - w, y + dy * len];
    p3 = [x + w, y + dy * len];
  }
  // jsPDF.lines uses relative coords + close=true
  const lines: [number, number][] = [
    [p2[0] - p1[0], p2[1] - p1[1]],
    [p3[0] - p2[0], p3[1] - p2[1]],
    [p1[0] - p3[0], p1[1] - p3[1]],
  ];
  doc.lines(lines, p1[0], p1[1], [1, 1], 'F', true);
}

/** Like drawDimTri but for an ARBITRARY direction: filled triangle with the
 *  tip at (x, y), body extending along unit vector (ux, uy). Used by the
 *  aligned edge dims on angled outline edges. */
function drawDimTriDir(
  doc: jsPDF, x: number, y: number, ux: number, uy: number, len: number, w: number,
) {
  const bx = x + ux * len;
  const by = y + uy * len;
  const px = -uy; // perpendicular
  const py = ux;
  const p2: [number, number] = [bx + px * w, by + py * w];
  const p3: [number, number] = [bx - px * w, by - py * w];
  const lines: [number, number][] = [
    [p2[0] - x, p2[1] - y],
    [p3[0] - p2[0], p3[1] - p2[1]],
    [x - p3[0], y - p3[1]],
  ];
  doc.lines(lines, x, y, [1, 1], 'F', true);
}

// ---------------------------------------------------------------------------
// Cutlist label registry + broken dimension lines.
// Every dimension VALUE (and panel id) placed on a cutlist page registers the
// page-pt rectangle it occupies; every dimension line is then drawn through
// brokenLine(), which skips the stretch crossing any registered rect (plus a
// small pad). Registering a label BEFORE drawing its own line is what creates
// the classic gap-in-line look — and lines of later panels automatically
// break around labels of earlier ones. The registry lives per drawSheet call,
// i.e. resets on every cutlist page.
// ---------------------------------------------------------------------------
type LabelRect = { x: number; y: number; w: number; h: number };
type DimSeg = { x1: number; y1: number; x2: number; y2: number };
/** Per-PAGE record of what dimensioning already sits on the page: label
 *  rects (dim values, panel ids, strip notes) and drawn dim-line segments.
 *  Lines break around earlier rects; later labels slide clear of earlier
 *  rects AND lines (a line already on the page can't retro-break). */
type DimRegistry = { rects: LabelRect[]; segs: DimSeg[] };

const LABEL_PAD = 2; // pt of clear space kept around each label

/** Liang–Barsky: [t0, t1] parameter interval where the segment crosses the
 *  rect inflated by pad, or null if it misses. */
function segRectInterval(
  x1: number, y1: number, dx: number, dy: number, r: LabelRect, pad: number,
): [number, number] | null {
  const q = [x1 - (r.x - pad), (r.x + r.w + pad) - x1, y1 - (r.y - pad), (r.y + r.h + pad) - y1];
  const p = [-dx, dx, -dy, dy];
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > t1) return null;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return null;
        if (t < t1) t1 = t;
      }
    }
  }
  return t1 > t0 ? [t0, t1] : null;
}

function segHitsRect(s: DimSeg, r: LabelRect, pad: number): boolean {
  return segRectInterval(s.x1, s.y1, s.x2 - s.x1, s.y2 - s.y1, r, pad) !== null;
}

/** Slide a prospective label (centered at cx,cy, reading angle A) along
 *  (dx, dy) until it clears every registered rect and drawn dim line. */
function slideLabelClear(
  reg: DimRegistry, cx: number, cy: number, tw: number, fs: number, A: number,
  dx: number, dy: number,
): { x: number; y: number } {
  const step = Math.max(2, fs * 0.9);
  for (let k = 0; k < 8; k++) {
    const r = labelRectAt(cx, cy, tw, fs, A);
    const hit =
      reg.rects.some((q) => rectsOverlap(r, q)) ||
      reg.segs.some((s) => segHitsRect(s, r, 1));
    if (!hit) break;
    cx += dx * step;
    cy += dy * step;
  }
  return { x: cx, y: cy };
}

/** Draw segment (x1,y1)→(x2,y2) minus its intersections with the inflated
 *  label rects (Liang–Barsky clip per rect, intervals merged), and record
 *  the ORIGINAL segment so later labels can dodge it. */
function brokenLine(
  doc: jsPDF, x1: number, y1: number, x2: number, y2: number,
  reg?: DimRegistry, pad = LABEL_PAD,
) {
  if (!reg) { doc.line(x1, y1, x2, y2); return; }
  reg.segs.push({ x1, y1, x2, y2 });
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 0.01) return;
  const cuts: [number, number][] = [];
  for (const r of reg.rects) {
    const iv = segRectInterval(x1, y1, dx, dy, r, pad);
    if (iv) cuts.push(iv);
  }
  if (cuts.length === 0) { doc.line(x1, y1, x2, y2); return; }
  cuts.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const c of cuts) {
    const last = merged[merged.length - 1];
    if (last && c[0] <= last[1]) last[1] = Math.max(last[1], c[1]);
    else merged.push([c[0], c[1]]);
  }
  const MIN_SEG = 0.6; // pt — drop invisible slivers
  let t = 0;
  for (const [a, b] of merged) {
    if ((a - t) * len > MIN_SEG) doc.line(x1 + dx * t, y1 + dy * t, x1 + dx * a, y1 + dy * a);
    t = Math.max(t, b);
  }
  if ((1 - t) * len > MIN_SEG) doc.line(x1 + dx * t, y1 + dy * t, x2, y2);
}

/** AABB occupied by a label of text-width tw / font-size fs whose glyph run
 *  is CENTERED at (cx, cy) reading at jsPDF angle A (degrees, visually CCW).
 *  A = 0 → horizontal, A = 90 → reads bottom-to-top. */
function labelRectAt(cx: number, cy: number, tw: number, fs: number, A: number): LabelRect {
  const rad = (A * Math.PI) / 180;
  // Reading direction and ascent direction in page (y-down) coords.
  const dx = Math.cos(rad);
  const dy = -Math.sin(rad);
  const axx = -Math.sin(rad);
  const axy = -Math.cos(rad);
  const hw = tw / 2;
  const hh = fs * 0.55;
  const ex = Math.abs(dx) * hw + Math.abs(axx) * hh;
  const ey = Math.abs(dy) * hw + Math.abs(axy) * hh;
  return { x: cx - ex, y: cy - ey, w: 2 * ex, h: 2 * ey };
}

/** Set `label` so its glyph run is centered at (cx, cy) reading at angle A.
 *  Uses DEFAULT (left) align with a hand-computed anchor — NEVER pair
 *  align:'center' with angle: jsPDF shifts rotated text by -textW/2 along
 *  the UNROTATED x-axis (see the vertical-dim comment in drawPart). The
 *  baseline sits 0.35·fs on the descent side so glyphs center on the line. */
function placeAlignedText(
  doc: jsPDF, label: string, cx: number, cy: number, fs: number, A: number,
): LabelRect {
  const tw = doc.getTextWidth(label);
  const rad = (A * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = -Math.sin(rad);
  const ax = cx - dx * (tw / 2) + Math.sin(rad) * fs * 0.35;
  const ay = cy - dy * (tw / 2) + Math.cos(rad) * fs * 0.35;
  if (Math.abs(A) < 0.01) doc.text(label, cx - tw / 2, cy + fs * 0.35);
  else doc.text(label, ax, ay, { angle: A });
  return labelRectAt(cx, cy, tw, fs, A);
}

/** Drop duplicate + collinear points from a polygon ring (page-pt coords). */
function simplifyRing(pts: [number, number][]): [number, number][] {
  const EPS_DUP = 0.1;
  const EPS_COL = 0.3; // max perpendicular deviation counted as collinear
  let out = pts.slice();
  if (out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < EPS_DUP) out = out.slice(0, -1);
  }
  // Dedup consecutive
  out = out.filter((p, i) => {
    const prev = out[(i - 1 + out.length) % out.length];
    return i === 0 || Math.hypot(p[0] - prev[0], p[1] - prev[1]) >= EPS_DUP;
  });
  // Drop collinear vertices (perp distance from the vertex to prev→next chord)
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const p = out[(i - 1 + out.length) % out.length];
      const v = out[i];
      const n = out[(i + 1) % out.length];
      const cx = n[0] - p[0];
      const cy = n[1] - p[1];
      const clen = Math.hypot(cx, cy);
      if (clen < EPS_DUP) continue;
      const d = Math.abs((v[0] - p[0]) * cy - (v[1] - p[1]) * cx) / clen;
      if (d < EPS_COL) {
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/** Even-odd ray-cast point-in-polygon. */
function pointInRing(pts: [number, number][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function rectsOverlap(a: LabelRect, b: LabelRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** A part-local ring transformed to page pt (same mapping as drawPolygon),
 *  simplified (duplicates + collinear points dropped). */
function ringToPt(
  ring: [number, number][], offX: number, offY: number,
  ox: number, oy: number, scale: number, orient: Orient,
): [number, number][] {
  const raw: [number, number][] = ring.map(([x, y]) => {
    const sx = x + offX;
    const sy = y + offY;
    return orient.rotated
      ? [ox + sy * scale, oy + sx * scale]
      : [ox + sx * scale, oy + sy * scale];
  });
  return simplifyRing(raw);
}

function partRingPt(
  p: PlacedPart, ox: number, oy: number, scale: number, orient: Orient,
): [number, number][] {
  return ringToPt(p.outer, p.x, p.y, ox, oy, scale, orient);
}

/** How much of a segment lies on solid material: -1 (unusable) when the run
 *  crosses any hole (exact bbox test — point sampling can miss a narrow
 *  hinge slot), else the count of sample points inside the outline. */
const DIM_SCAN_SAMPLES = 9;
function segMaterialScore(
  x1: number, y1: number, x2: number, y2: number,
  outer: [number, number][], holes: [number, number][][],
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  for (const h of holes) {
    const hx = h.map((q) => q[0]);
    const hyv = h.map((q) => q[1]);
    const r: LabelRect = {
      x: Math.min(...hx),
      y: Math.min(...hyv),
      w: Math.max(...hx) - Math.min(...hx),
      h: Math.max(...hyv) - Math.min(...hyv),
    };
    if (segRectInterval(x1, y1, dx, dy, r, 1) !== null) return -1;
  }
  let hits = 0;
  for (let i = 0; i < DIM_SCAN_SAMPLES; i++) {
    const t = (i + 0.5) / DIM_SCAN_SAMPLES;
    if (pointInRing(outer, x1 + dx * t, y1 + dy * t)) hits++;
  }
  return hits;
}

/** Pick a dimension-line position: keep the default when its whole run is
 *  on material; otherwise walk outward (forward first, then backward) and
 *  return the first fully-on-material position, or the best-scoring one. */
function bestDimLinePos(
  def: number, lo: number, hi: number, score: (v: number) => number,
): number {
  let bestV = def;
  let bestS = score(def);
  if (bestS >= DIM_SCAN_SAMPLES) return def;
  const STEP = 3;
  for (let v = def + STEP; v <= hi; v += STEP) {
    const s = score(v);
    if (s > bestS) {
      bestS = s;
      bestV = v;
      if (s >= DIM_SCAN_SAMPLES) return v;
    }
  }
  for (let v = def - STEP; v >= lo; v -= STEP) {
    const s = score(v);
    if (s > bestS) {
      bestS = s;
      bestV = v;
      if (s >= DIM_SCAN_SAMPLES) return v;
    }
  }
  return bestV;
}

/** True when the simplified ring is a plain axis-aligned rectangle: exactly
 *  4 vertices, each sitting on a corner of its own bbox (small epsilon). */
function ringIsRect(ring: [number, number][]): boolean {
  if (ring.length !== 4) return false;
  const xs = ring.map((q) => q[0]);
  const ys = ring.map((q) => q[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const EPS = 0.35;
  return ring.every(
    (q) =>
      Math.min(Math.abs(q[0] - minX), Math.abs(q[0] - maxX)) < EPS &&
      Math.min(Math.abs(q[1] - minY), Math.abs(q[1] - maxY)) < EPS,
  );
}

/** Area centroid of a polygon ring. */
function ringCentroid(ring: [number, number][]): [number, number] {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const w = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += w;
    cx += (ring[j][0] + ring[i][0]) * w;
    cy += (ring[j][1] + ring[i][1]) * w;
  }
  if (Math.abs(a) < 1e-9) return ring[0];
  return [cx / (3 * a), cy / (3 * a)];
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
// PANEL DIMENSIONS table — shared renderer for the per-sheet tables and the
// job-wide front-matter "Panels" section. Panels of identical size
// (length × width × thickness) collapse into ONE row: the qty column shows
// the count and the code cell lists every instance's id ("1a, 1c, 3b").
// Columns: image (color thumbnail, aspect-correct) · code · qty · length ·
// width · thickness. Rows sorted large-to-small.
// ---------------------------------------------------------------------------

/** Per-sheet wrapper: its own page, sitting between the sheet's layout
 *  overview and its cut sequence. */
function drawSheetPanelTable(
  doc: jsPDF,
  sheet: NestSheet,
  opt: PdfOptions,
  dims: { w: number; h: number },
  openNewPage: () => void,
) {
  const rows = groupPanelsBySize(sheet);
  if (rows.length === 0) return;
  // Fresh page — keeps the layout page clean and matches the cut-sequence
  // page starting on its own page too.
  openNewPage();
  drawPanelTable(doc, `Sheet ${sheet.globalIndex} panels`, rows, opt, dims, openNewPage);
}

/** Draw a panel-dimensions table starting on the CURRENT page (title +
 *  header + rows), spilling to `openNewPage()` pages with a repeated
 *  column header when the rows overflow. */
function drawPanelTable(
  doc: jsPDF,
  title: string,
  rows: PanelSizeRow[],
  opt: PdfOptions,
  dims: { w: number; h: number },
  openNewPage: () => void,
) {
  const PAGE_W = dims.w;
  const PAGE_H = dims.h;
  if (rows.length === 0) return;

  // Header — title left; part totals right.
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(20);
  doc.text(title, PAGE_PAD, PAGE_PAD + 10);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(120);
  const uniqueN = rows.length;
  const totalN = rows.reduce((a, r) => a + r.qty, 0);
  doc.text(
    `${totalN} ${totalN === 1 ? 'panel' : 'panels'}  ·  ${uniqueN} unique size${uniqueN === 1 ? '' : 's'}`,
    PAGE_W - PAGE_PAD, PAGE_PAD + 10, { align: 'right' },
  );
  doc.setTextColor(0);

  // Column geometry. The table is bounded to a comfortable reading width
  // (it does NOT span the whole widescreen page — that would scatter the
  // columns into far-apart clusters). Image cell on the left, then code,
  // then the right-aligned numeric columns (qty · length · width · thick).
  const left = PAGE_PAD;
  const imgColW = 62;                 // thumbnail cell width
  const rowH = 34;                    // generous rows — the thumbnail needs height
  const tableW = Math.min(PAGE_W - 2 * PAGE_PAD, 620);
  const right = left + tableW;        // table's right edge (numeric column anchor)
  const cImg   = left;
  const cCode  = left + imgColW + 14; // code column left edge
  // Right-aligned numeric columns, evenly spaced from the table's right edge.
  const cThick = right;               // right-aligned at table edge
  const cWid   = right - 110;
  const cLen   = right - 220;
  const cQty   = right - 330;         // qty right edge

  const drawHeader = (y: number): number => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(110);
    doc.text('PANEL', cImg, y);
    doc.text('CODE', cCode, y);
    doc.text('QTY', cQty, y, { align: 'right' });
    doc.text('LENGTH', cLen, y, { align: 'right' });
    doc.text('WIDTH', cWid, y, { align: 'right' });
    doc.text('THICK', cThick, y, { align: 'right' });
    doc.setDrawColor(215);
    doc.setLineWidth(0.5);
    doc.line(left, y + 5, right, y + 5);
    doc.setTextColor(0);
    return y + 5 + 16;
  };

  const TOP = PAGE_PAD + 24;
  const BOTTOM = PAGE_H - PAGE_PAD;
  let y = drawHeader(TOP);

  for (const r of rows) {
    if (y + rowH > BOTTOM) {
      openNewPage();
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(13);
      doc.setTextColor(20);
      doc.text(`${title} (cont.)`, PAGE_PAD, PAGE_PAD + 10);
      doc.setTextColor(0);
      y = drawHeader(TOP);
    }
    drawPanelRow(doc, r, opt, {
      rowTop: y - 12, rowH, cImg, imgColW, cCode, cQty, cLen, cWid, cThick,
    });
    // Hairline divider under the row.
    doc.setDrawColor(235);
    doc.setLineWidth(0.4);
    doc.line(left, y + rowH - 12, right, y + rowH - 12);
    y += rowH;
  }
  doc.setTextColor(0);
}

/** One row of the panel table: aspect-correct color thumbnail + code list +
 *  qty + length + width + thickness, all vertically centered in the row
 *  band. */
function drawPanelRow(
  doc: jsPDF,
  r: PanelSizeRow,
  opt: PdfOptions,
  g: {
    rowTop: number; rowH: number; cImg: number; imgColW: number;
    cCode: number; cQty: number; cLen: number; cWid: number; cThick: number;
  },
) {
  const midY = g.rowTop + g.rowH / 2;
  const textY = midY + 3; // optical baseline for helvetica ~10pt

  // Thumbnail — the panel rectangle in its color, aspect-correct, long edge
  // horizontal (matching every other view), letterboxed inside the image
  // cell. Filled at 50% opacity with a darker border, same convention as the
  // layout panels.
  const thumbMaxW = g.imgColW;
  const thumbMaxH = g.rowH - 5;
  const aspect = r.width / r.length; // h/w with long edge horizontal
  let tw = thumbMaxW;
  let th = tw * aspect;
  if (th > thumbMaxH) { th = thumbMaxH; tw = th / aspect; }
  const tx = g.cImg + (g.imgColW - tw) / 2;
  const ty = midY - th / 2;
  const [pr, pg, pb] = hexToRgb(r.color);
  const GS = (doc as any).GState;
  if (GS) (doc as any).setGState(new GS({ opacity: 0.50 }));
  doc.setFillColor(pr, pg, pb);
  doc.rect(tx, ty, tw, th, 'F');
  if (GS) (doc as any).setGState(new GS({ opacity: 1 }));
  doc.setDrawColor(Math.floor(pr * 0.55), Math.floor(pg * 0.55), Math.floor(pb * 0.55));
  doc.setLineWidth(0.6);
  doc.rect(tx, ty, tw, th, 'S');

  // Code list — bold, comma-separated. Wraps within the code column width if
  // there are many instances (stops short of the qty column).
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(30);
  const codeText = r.codes.join(', ');
  const codeMaxW = g.cQty - 40 - g.cCode;
  doc.text(codeText, g.cCode, textY, { maxWidth: Math.max(40, codeMaxW) });

  // Qty · Length · Width · Thickness — right-aligned numeric columns.
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(40);
  doc.text(String(r.qty), g.cQty, textY, { align: 'right' });
  doc.text(fmtDim(r.length, opt.units), g.cLen, textY, { align: 'right' });
  doc.text(fmtDim(r.width, opt.units), g.cWid, textY, { align: 'right' });
  doc.text(fmtDim(r.thickness, opt.units), g.cThick, textY, { align: 'right' });
  doc.setTextColor(0);
}

// ---------------------------------------------------------------------------
// Structure section — quick bending screen per panel size. One compact table
// mirroring the panel-table hairline style: code · span · material · load ·
// predicted sag · verdict. Sag comes from the beam-strip screen in cae.ts.
// ---------------------------------------------------------------------------
function drawStructureTable(
  doc: jsPDF,
  rows: StructureRow[],
  opt: PdfOptions,
  dims: { w: number; h: number },
  openNewPage: () => void,
) {
  const PAGE_W = dims.w;
  const PAGE_H = dims.h;
  if (rows.length === 0) return;

  // Header — title + subtitle explaining the load assumption.
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(20);
  doc.text('Structure', PAGE_PAD, PAGE_PAD + 10);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(
    'Predicted mid-span sag under a uniform load (a loaded shelf). OK if sag < span/300.',
    PAGE_W - PAGE_PAD, PAGE_PAD + 10, { align: 'right' },
  );
  doc.setTextColor(0);

  const left = PAGE_PAD;
  const tableW = Math.min(PAGE_W - 2 * PAGE_PAD, 700);
  const right = left + tableW;
  const rowH = 22;
  const cCode = left;
  const cName = left + 70;
  // right-aligned numeric columns
  const cVerdict = right;
  const cSag = right - 90;
  const cLoad = right - 175;
  const cMat = right - 250;   // left-aligned material, but anchor here
  const cSpan = right - 370;

  const drawHeader = (y: number): number => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(110);
    doc.text('CODE', cCode, y);
    doc.text('PANEL', cName, y);
    doc.text('SPAN', cSpan, y, { align: 'right' });
    doc.text('MATERIAL', cMat - 30, y);
    doc.text('LOAD', cLoad, y, { align: 'right' });
    doc.text('SAG', cSag, y, { align: 'right' });
    doc.text('VERDICT', cVerdict, y, { align: 'right' });
    doc.setDrawColor(215);
    doc.setLineWidth(0.5);
    doc.line(left, y + 5, right, y + 5);
    doc.setTextColor(0);
    return y + 5 + 15;
  };

  const TOP = PAGE_PAD + 24;
  const BOTTOM = PAGE_H - PAGE_PAD;
  let y = drawHeader(TOP);

  const verdictColor: Record<StructureRow['verdict'], [number, number, number]> = {
    ok: [15, 123, 108],
    borderline: [217, 115, 13],
    weak: [192, 57, 43],
  };

  for (const r of rows) {
    if (y + rowH > BOTTOM) {
      openNewPage();
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(13);
      doc.setTextColor(20);
      doc.text('Structure (cont.)', PAGE_PAD, PAGE_PAD + 10);
      doc.setTextColor(0);
      y = drawHeader(TOP);
    }
    const textY = y + 2;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(30);
    doc.text(r.code, cCode, textY, { maxWidth: cName - cCode - 6 });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(60);
    doc.text(clip(doc, r.name, cSpan - cName - 30), cName, textY);
    doc.setTextColor(40);
    doc.text(fmtDim(r.span, opt.units), cSpan, textY, { align: 'right' });
    doc.text(clip(doc, r.material, cLoad - (cMat - 30) - 6), cMat - 30, textY);
    doc.text(`${r.loadKg.toFixed(0)} kg`, cLoad, textY, { align: 'right' });
    doc.text(fmtSag(r.sagMm, opt.units), cSag, textY, { align: 'right' });
    const [vr, vg, vb] = verdictColor[r.verdict];
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(vr, vg, vb);
    doc.text(r.verdict.toUpperCase(), cVerdict, textY, { align: 'right' });
    doc.setTextColor(0);

    doc.setDrawColor(235);
    doc.setLineWidth(0.4);
    doc.line(left, y + rowH - 12, right, y + rowH - 12);
    y += rowH;
  }
  doc.setTextColor(0);
}

// ---------------------------------------------------------------------------
// Assembly analysis page — whole-cabinet deflection heatmap + joints table +
// loads + result, in the same hairline table style as Structure.
// ---------------------------------------------------------------------------
function drawAssemblyAnalysisPage(
  doc: jsPDF,
  an: AssemblyAnalysisPage,
  opt: PdfOptions,
  dims: { w: number; h: number },
) {
  const PAGE_W = dims.w;
  const PAGE_H = dims.h;

  // Header
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(20);
  const title = an.cabinet ? `Assembly analysis — ${an.cabinet}` : 'Assembly analysis';
  doc.text(clip(doc, title, PAGE_W - 2 * PAGE_PAD - 220), PAGE_PAD, PAGE_PAD + 10);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text('Coupled-shell deflection across the whole cabinet under the placed loads.', PAGE_W - PAGE_PAD, PAGE_PAD + 10, { align: 'right' });
  doc.setTextColor(0);

  const TOP = PAGE_PAD + 30;
  const BOTTOM = PAGE_H - PAGE_PAD;
  const gutter = 20;
  const imgColW = Math.min((PAGE_W - 2 * PAGE_PAD) * 0.56, 700);
  const imgLeft = PAGE_PAD;
  const tableLeft = imgLeft + imgColW + gutter;
  const tableRight = PAGE_W - PAGE_PAD;

  // Heatmap image(s), aspect-fit into the image column. With a stress map we
  // stack two labeled panels (deflection on top, stress below); otherwise the
  // single deflection map fills the column.
  const drawLabeledImage = (
    img: SnapshotImage, label: string, top: number, availH: number,
  ): number => {
    const aspect = img.width / img.height || 4 / 3;
    const labelH = 12;
    let iw = imgColW;
    let ih = iw / aspect;
    if (ih > availH - labelH) { ih = availH - labelH; iw = ih * aspect; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
    doc.setTextColor(110);
    doc.text(label.toUpperCase(), imgLeft, top + 8);
    doc.setTextColor(0);
    const iy = top + labelH;
    doc.setDrawColor(225); doc.setLineWidth(0.5);
    doc.rect(imgLeft, iy, iw, ih);
    try { doc.addImage(img.dataUrl, 'JPEG', imgLeft, iy, iw, ih); } catch { /* table still prints */ }
    return iy + ih; // bottom y
  };

  if (an.image && an.image.dataUrl) {
    const hasStress = !!(an.stressImage && an.stressImage.dataUrl);
    const availH = BOTTOM - TOP;
    if (hasStress) {
      const gap = 14;
      const half = (availH - gap) / 2;
      const b1 = drawLabeledImage(an.image, 'Deflection', TOP, half);
      drawLabeledImage(an.stressImage!, 'Von Mises stress', b1 + gap, availH - (b1 - TOP) - gap);
    } else {
      drawLabeledImage(an.image, 'Deflection', TOP, availH);
    }
  }

  // Inputs / results block — hairline rows: LABEL … VALUE.
  let y = TOP + 4;
  const rowH = 18;
  const line = () => {
    doc.setDrawColor(235); doc.setLineWidth(0.4);
    doc.line(tableLeft, y + 4, tableRight, y + 4);
  };
  const section = (t: string) => {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(110);
    doc.text(t.toUpperCase(), tableLeft, y);
    doc.setDrawColor(215); doc.setLineWidth(0.5);
    doc.line(tableLeft, y + 4, tableRight, y + 4);
    doc.setTextColor(0);
    y += rowH;
  };
  const kv = (k: string, v: string, color?: [number, number, number]) => {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(90);
    doc.text(k, tableLeft, y);
    doc.setFont('helvetica', 'bold');
    if (color) doc.setTextColor(...color); else doc.setTextColor(30);
    doc.text(clip(doc, v, tableRight - tableLeft - 120), tableRight, y, { align: 'right' });
    doc.setTextColor(0);
    line();
    y += rowH;
  };

  section('Model');
  kv('Panels', `${an.panelCount}`);
  kv('Joints', `${an.joints.length}`);
  kv('Floor supports', `${an.groundedNodes} nodes`);
  kv('Resolution', an.resolutionLog.replace(/ · target.*$/, ''));

  // Joints sub-list (ASCII — jsPDF core font has no ⟂ glyph). Cap the number of
  // rows so the LOADS + RESULT sections below always fit above BOTTOM — the
  // Result verdict (and stress block) must never fall off the page.
  if (an.joints.length > 0) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(110);
    doc.text('JOINTS', tableLeft, y);
    doc.setDrawColor(235); doc.setLineWidth(0.4); doc.line(tableLeft, y + 4, tableRight, y + 4);
    doc.setTextColor(0); y += rowH;
    // Reserve: LOADS header + rows, plus RESULT (header + up to 9 kv rows).
    const stressRows = an.maxVmMPa != null ? 4 : 0;
    const loadsBlock = an.loads.length > 0 ? rowH + an.loads.length * (rowH - 3) + 4 : 0;
    const resultBlock = rowH + (5 + stressRows) * rowH + 12;
    const reserve = loadsBlock + resultBlock;
    const roomForJoints = Math.max(0, (BOTTOM - y - reserve));
    const fit = Math.max(2, Math.floor(roomForJoints / (rowH - 3)) - 1);
    const maxJoints = Math.min(an.joints.length, 12, fit);
    for (let i = 0; i < maxJoints; i++) {
      const j = an.joints[i];
      const label = j.pair.replace('⟂', 'x');
      const detail = `${fmtDim(j.length, opt.units)} · ${j.stiffness}`;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(60);
      doc.text(clip(doc, label, (tableRight - tableLeft) * 0.5), tableLeft, y);
      doc.text(clip(doc, detail, (tableRight - tableLeft) * 0.45), tableRight, y, { align: 'right' });
      doc.setDrawColor(240); doc.setLineWidth(0.35); doc.line(tableLeft, y + 4, tableRight, y + 4);
      y += rowH - 3;
    }
    if (an.joints.length > maxJoints) {
      doc.setFont('helvetica', 'italic'); doc.setFontSize(8.5); doc.setTextColor(130);
      doc.text(`+ ${an.joints.length - maxJoints} more`, tableLeft, y);
      y += rowH - 3;
    }
    y += 4;
  }

  // Loads sub-list.
  if (an.loads.length > 0) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(110);
    doc.text('LOADS', tableLeft, y);
    doc.setDrawColor(235); doc.setLineWidth(0.4); doc.line(tableLeft, y + 4, tableRight, y + 4);
    doc.setTextColor(0); y += rowH;
    an.loads.forEach((ld, i) => {
      const dir = ld.down ? 'down' : 'up';
      const shape = ld.shape === 'round' ? 'round' : 'square';
      const label = `${i + 1}. ${ld.magDisplay} ${dir} on ${ld.panelLabel}`;
      const detail = `${shape} ${fmtDim(ld.sizeMm, opt.units)}`;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(60);
      doc.text(clip(doc, label, (tableRight - tableLeft) * 0.62), tableLeft, y);
      doc.text(clip(doc, detail, (tableRight - tableLeft) * 0.35), tableRight, y, { align: 'right' });
      doc.setDrawColor(240); doc.setLineWidth(0.35); doc.line(tableLeft, y + 4, tableRight, y + 4);
      y += rowH - 3;
    });
    y += 4;
  }

  y += 6;
  section('Result');
  const verdictColor: Record<string, [number, number, number]> = {
    ok: [15, 123, 108], OK: [15, 123, 108],
    borderline: [217, 115, 13], weak: [192, 57, 43],
  };
  kv('Max deflection', fmtSag(an.maxSagMm, opt.units));
  kv('On panel', an.maxPanelLabel);
  kv('At', `(${fmtDim(an.maxAt[0], opt.units)}, ${fmtDim(an.maxAt[1], opt.units)})`);
  kv('Span', fmtDim(an.spanMm, opt.units));
  // Stress block — only when the solver reported it (older captures may not).
  if (an.maxVmMPa != null) {
    const vm = an.maxVmMPa;
    kv('Max von Mises', `${vm.toFixed(vm < 10 ? 1 : 0)} MPa`);
    if (an.maxVmPanelLabel) kv('On panel', an.maxVmPanelLabel);
    if (an.maxVmAt) kv('At', `(${fmtDim(an.maxVmAt[0], opt.units)}, ${fmtDim(an.maxVmAt[1], opt.units)})`);
    if (an.utilPct != null) {
      kv('Utilization', `${Math.round(an.utilPct)}%`, verdictColor[an.stressVerdict ?? ''] ?? [30, 30, 30]);
    }
  }
  const finalVerdict = an.combinedVerdict ?? an.verdict;
  kv('Verdict', finalVerdict.toUpperCase(), verdictColor[finalVerdict] ?? [30, 30, 30]);
  doc.setTextColor(0);
}

/** Standalone one-page Assembly analysis PDF for the current cabinet. */
export function buildAssemblyAnalysisPdf(an: AssemblyAnalysisPage, opt: PdfOptions): jsPDF {
  const paper = opt.paper ?? 'widescreen-16-9';
  const dims = PAPER_DIMS[paper === 'mobile' ? 'widescreen-16-9' : paper];
  const doc = new jsPDF({ orientation: dims.orient, unit: 'pt', format: dims.format });
  drawAssemblyAnalysisPage(doc, an, opt, dims);
  return doc;
}

/** Truncate `text` to fit `maxW` pt, appending an ellipsis if clipped. */
function clip(doc: jsPDF, text: string, maxW: number): string {
  if (doc.getTextWidth(text) <= maxW) return text;
  let s = text;
  while (s.length > 1 && doc.getTextWidth(s + '…') > maxW) s = s.slice(0, -1);
  return s + '…';
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
  const sc = (allCutSteps({ groups: [{ thickness: sheet.thickness, sheets: [sheet], unplaced: [] }] } as any, opt.margin, opt.kerf, opt.overridesBySig, opt.kerfRef, opt.sequenceStyle))[0];
  if (!sc || sc.steps.length === 0) return;

  // Start a new page for the cut cards — keeps the sheet layout page clean.
  openNewPage();

  const cardGutter = 14;
  const cardCaptionH = 26;
  const sheetAspect = sc.sheetL / sc.sheetW;
  const innerW = PAGE_W - 2 * PAGE_PAD;
  // Tightened top: the cut-sequence page only needs the section header
  // (drawn at y = PAGE_PAD+10). That leaves more vertical room for big cards.
  const TOP = PAGE_PAD + 14;
  const BOTTOM = PAGE_H - PAGE_PAD;
  const availableH = BOTTOM - TOP;
  // Pick the smallest col count that keeps each card from overflowing the
  // page vertically — gives the BIGGEST cards that still fit at least one
  // row. For shorter (wider) sheets the result is fewer, bigger cards;
  // for tall (portrait) sheets we end up with smaller cards but they fit.
  const maxCardW = (availableH - cardCaptionH) / sheetAspect;
  const minCols = Math.ceil((innerW + cardGutter) / (maxCardW + cardGutter));
  const cols = Math.max(3, minCols);
  const cardW = (innerW - cardGutter * (cols - 1)) / cols;
  const cardDiagH = cardW * sheetAspect;
  const cardH = cardDiagH + cardCaptionH;

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
// Split-part JOIN GUIDE — for parts the CNC auto-split broke into
// dovetailed segments. One card per original part: the segments drawn at
// their original positions (so the parent silhouette reassembles before the
// reader's eyes), each labelled with its roman numeral + the sheet panel id
// ('1a-i') it was cut from, plus a one-line assembly instruction.
// ---------------------------------------------------------------------------
function drawSplitJoins(
  doc: jsPDF,
  groups: SplitJoinGroup[],
  opt: PdfOptions,
  dims: { w: number; h: number },
  openNewPage: () => void,
) {
  const innerW = dims.w - 2 * PAGE_PAD;
  const TOP = PAGE_PAD + 14;
  const BOTTOM = dims.h - PAGE_PAD;
  const TITLE_H = 18;
  const CAPTION_H = 30;
  const MAX_DIAG_H = 170;

  // Page intro (drawn once per page via the header post-pass; here we add a
  // standfirst on the first page only).
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(20);
  doc.text('Join split parts', PAGE_PAD, PAGE_PAD + 10);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(95);
  doc.text(
    'These parts were larger than the sheet and were auto-split with interlocking dovetail joints. ' +
    'Cut every piece, then glue the joints and press the pieces together flat, in order (i, ii, …).',
    PAGE_PAD, PAGE_PAD + 24, { maxWidth: innerW },
  );
  let y = TOP + 28;

  const segBbox = (s: SplitJoinSegment) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, yy] of s.outer) {
      if (x < minX) minX = x;
      if (yy < minY) minY = yy;
      if (x > maxX) maxX = x;
      if (yy > maxY) maxY = yy;
    }
    return { w: maxX - minX, h: maxY - minY };
  };

  for (const g of groups) {
    // Parent extent = union of segments at their offsets.
    let pw = 0, ph = 0;
    for (const s of g.segments) {
      const b = segBbox(s);
      pw = Math.max(pw, s.offsetX + b.w);
      ph = Math.max(ph, s.offsetY + b.h);
    }
    if (pw <= 0 || ph <= 0) continue;
    const scale = Math.min(innerW / pw, MAX_DIAG_H / ph);
    const diagW = pw * scale;
    const diagH = ph * scale;
    const cardH = TITLE_H + diagH + CAPTION_H;
    if (y + cardH > BOTTOM) {
      openNewPage();
      y = TOP;
    }

    // Card title
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(20);
    doc.text(
      `${g.parentName}  ·  ${g.segments.length} pieces  ·  ${fmtDim(g.thickness, opt.units)}`,
      PAGE_PAD, y + 10,
    );
    y += TITLE_H;

    // Diagram — segments at their original offsets. Alternate the fill tint
    // so adjacent segments (and the dovetail joint line between them) read
    // clearly even though they share the parent's color.
    const ox = PAGE_PAD + (innerW - diagW) / 2;
    const [r, gg, b] = hexToRgb(g.segments[0]?.color ?? '#999999');
    g.segments.forEach((s, i) => {
      const tint = i % 2 === 0 ? 0 : 0.35; // mix toward white on odd segments
      doc.setFillColor(
        Math.round(r + (255 - r) * tint),
        Math.round(gg + (255 - gg) * tint),
        Math.round(b + (255 - b) * tint),
      );
      doc.setDrawColor(60);
      doc.setLineWidth(0.8);
      drawPolygon(doc, s.outer, s.offsetX, s.offsetY, ox, y, scale, 'FD');
      for (const h of s.holes) {
        doc.setFillColor(255, 255, 255);
        drawPolygon(doc, h, s.offsetX, s.offsetY, ox, y, scale, 'FD');
      }
      // Labels at the segment's bbox centre: roman numeral + panel id.
      const sb = segBbox(s);
      const cx = ox + (s.offsetX + sb.w / 2) * scale;
      const cy = y + (s.offsetY + sb.h / 2) * scale;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(Math.min(13, Math.max(8, diagH * 0.12)));
      doc.setTextColor(25);
      doc.text(s.roman, cx, cy - 1, { align: 'center' });
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(60);
      doc.text(s.label ? `panel ${s.label}` : 'not placed', cx, cy + 8, { align: 'center' });
    });
    y += diagH;

    // Caption: where each piece lives.
    const refs = g.segments.map((s) =>
      `${s.roman} = ${s.label ? `panel ${s.label} (sheet ${s.sheetNo})` : 'NOT PLACED'}`);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(80);
    doc.text(refs.join('   ·   '), PAGE_PAD + (innerW - diagW) / 2 + 0, y + 12, { maxWidth: innerW });
    y += CAPTION_H;
  }
}

// ---------------------------------------------------------------------------
// Per-cabinet COVER page — IKEA "What you have" layout:
//   - LEFT: large assembled snapshot of the finished cabinet
//   - RIGHT: parts inventory TABLE (id, name, L × W, thickness, qty)
//
// Step pages with IKEA-style build-sequence snapshots come after this on
// subsequent pages — see drawCabinetSteps.
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
  const totalPanels = cab.panels?.length ?? cab.partIds.length;
  doc.text(
    `${totalPanels} panels — what's in the box`,
    PAGE_PAD, PAGE_PAD + 22,
  );
  doc.setTextColor(0);

  // Two-column layout: assembled snapshot (left, ~50%) + parts table (right).
  const top = PAGE_PAD + 42;
  const bottom = PAGE_H - PAGE_PAD - 8;
  const gutter = 24;
  const leftW = (PAGE_W - 2 * PAGE_PAD - gutter) * 0.50;
  const rightX = PAGE_PAD + leftW + gutter;
  const rightW = PAGE_W - PAGE_PAD - rightX;
  const diagramH = bottom - top;

  // Left: assembled snapshot (no "ASSEMBLED" label — the image speaks for itself)
  drawSnapshotPanel(doc, cab.assembled, PAGE_PAD, top, leftW, diagramH, { frameless: true });

  // Right: parts inventory TABLE
  drawCabinetPartsTable(doc, cab, opt, rightX, top, rightW, diagramH);
}

/**
 * Parts inventory table: ID · Name · L × W · Thickness · Qty. De-duped by
 * panel id so two instances of the same panel collapse into one row with
 * "× 2" qty. Drawn inside the (x, y, w, h) box.
 */
function drawCabinetPartsTable(
  doc: jsPDF,
  cab: CabinetSnapshot,
  opt: PdfOptions,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  // Aggregate panels by id (panels is preferred; fall back to partIds)
  type Row = { id: string; name: string; longMm: number; shortMm: number; thickness: number; qty: number; color: string };
  const rowsById = new Map<string, Row>();
  if (cab.panels && cab.panels.length > 0) {
    for (const p of cab.panels) {
      const ex = rowsById.get(p.id);
      if (ex) ex.qty += 1;
      else rowsById.set(p.id, {
        id: p.id,
        name: p.name,
        longMm: Math.max(p.length, p.width),
        shortMm: Math.min(p.length, p.width),
        thickness: p.thickness,
        qty: 1,
        color: p.color,
      });
    }
  } else {
    for (const id of cab.partIds) {
      const ex = rowsById.get(id);
      if (ex) ex.qty += 1;
      else rowsById.set(id, { id, name: '', longMm: 0, shortMm: 0, thickness: 0, qty: 1, color: '#cccccc' });
    }
  }
  const rows = Array.from(rowsById.values()).sort((a, b) => a.id.localeCompare(b.id));

  // Column layout
  const cols = [
    { key: 'ID',        x: x + 0,    align: 'left'  as const, w: 36 },
    { key: 'NAME',      x: x + 44,   align: 'left'  as const, w: w * 0.30 },
    { key: 'L × W',     x: x + 44 + w * 0.30 + 8, align: 'left' as const, w: w * 0.34 },
    { key: 'THICK',     x: x + 44 + w * 0.30 + 8 + w * 0.34 + 8, align: 'left' as const, w: w * 0.16 },
    { key: 'QTY',       x: x + w,    align: 'right' as const, w: 0 },
  ];

  // Header row
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(110);
  let hy = y + 10;
  for (const c of cols) doc.text(c.key, c.x, hy, { align: c.align });
  doc.setDrawColor(225);
  doc.setLineWidth(0.4);
  doc.line(x, hy + 4, x + w, hy + 4);

  // Rows
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(40);
  const lineH = 16;
  let ry = hy + 18;
  const bottomY = y + h;
  for (const r of rows) {
    if (ry > bottomY - 4) {
      doc.setTextColor(140);
      doc.setFontSize(9);
      doc.text(`… and ${rows.length - rows.indexOf(r)} more`, x, ry);
      break;
    }
    // Color swatch + id badge
    const [cr, cg, cb] = hexToRgb(r.color);
    doc.setFillColor(cr, cg, cb);
    doc.rect(cols[0].x, ry - 8, 8, 10, 'F');
    doc.setTextColor(40);
    doc.setFont('helvetica', 'bold');
    doc.text(r.id, cols[0].x + 12, ry);

    doc.setFont('helvetica', 'normal');
    const name = r.name.length > 28 ? r.name.slice(0, 25) + '…' : r.name;
    doc.text(name, cols[1].x, ry);
    doc.text(
      r.longMm > 0 ? `${fmtDim(r.longMm, opt.units)} × ${fmtDim(r.shortMm, opt.units)}` : '—',
      cols[2].x, ry,
    );
    doc.text(r.thickness > 0 ? fmtDim(r.thickness, opt.units) : '—', cols[3].x, ry);
    doc.setFont('helvetica', 'bold');
    doc.text(`× ${r.qty}`, cols[4].x, ry, { align: 'right' });
    doc.setFont('helvetica', 'normal');
    ry += lineH;
  }
  doc.setTextColor(0);
}

// ---------------------------------------------------------------------------
// IKEA-style step-by-step assembly pages.
// Each step renders a snapshot of the assembly state with the new panel
// floating in along its face normal. No dimensions on each card — those
// live in the parts table on the cabinet cover page. Numbered badge +
// panel id chip is all the extra UI per step.
// ---------------------------------------------------------------------------
function drawCabinetSteps(
  doc: jsPDF,
  cab: CabinetSnapshot,
  opt: PdfOptions,
  dims: { w: number; h: number },
  openNewPage: () => void,
) {
  if (!cab.steps || cab.steps.length === 0) return;
  const PAGE_W = dims.w;
  const PAGE_H = dims.h;

  // 2 × 2 grid → 4 large step images per page on widescreen. Each card is
  // mostly image — IKEA-style, almost no text. Step number + panel id only.
  const cols = 2;
  const rows = 2;
  const cardGutter = 18;
  const top = PAGE_PAD + 32;
  const bottom = PAGE_H - PAGE_PAD;
  const innerW = PAGE_W - 2 * PAGE_PAD;
  const cardW = (innerW - cardGutter * (cols - 1)) / cols;
  const cardH = (bottom - top - cardGutter * (rows - 1)) / rows;
  const perPage = cols * rows;

  for (let i = 0; i < cab.steps.length; i++) {
    const onPage = i % perPage;
    if (i === 0 || onPage === 0) {
      // Always start step grids on a fresh page — the cover page sits
      // ahead of us (assembled snapshot + parts table), and within the
      // sequence each `perPage`-sized batch gets its own page.
      openNewPage();
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(16);
      doc.setTextColor(20);
      doc.text(`${cab.name} — assembly`, PAGE_PAD, PAGE_PAD + 6);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9.5);
      doc.setTextColor(120);
      const pageNum = Math.floor(i / perPage) + 1;
      const pageCount = Math.ceil(cab.steps.length / perPage);
      doc.text(
        `Steps ${i + 1}–${Math.min(i + perPage, cab.steps.length)} of ${cab.steps.length}  ·  page ${pageNum} of ${pageCount}`,
        PAGE_W - PAGE_PAD, PAGE_PAD + 6, { align: 'right' },
      );
      doc.setTextColor(0);
    }
    const col = onPage % cols;
    const row = Math.floor(onPage / cols);
    const x = PAGE_PAD + col * (cardW + cardGutter);
    const y = top + row * (cardH + cardGutter);
    drawIkeaStepCard(doc, cab.steps[i], cab.stepPanelIds?.[i] ?? '', i + 1, x, y, cardW, cardH);
  }
}

/**
 * One IKEA-style step card: large snapshot fills most of the area; a
 * numbered circle badge sits in the top-left, and the panel id chip
 * sits in the top-right. No dimensions, no name, no clutter — same
 * principle as IKEA's almost-wordless step diagrams.
 */
function drawIkeaStepCard(
  doc: jsPDF,
  img: SnapshotImage,
  panelId: string,
  stepNum: number,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  // Hairline outer border + frameless snapshot lets the 3D image breathe.
  doc.setDrawColor(225);
  doc.setLineWidth(0.5);
  doc.rect(x, y, w, h, 'S');
  drawSnapshotPanel(doc, img, x + 1, y + 1, w - 2, h - 2, { frameless: true });

  // Step badge — large dark circle with white step number, top-left
  const isDone = panelId === 'done';
  const badgeR = 16;
  const bx = x + 14 + badgeR;
  const by = y + 14 + badgeR;
  doc.setFillColor(isDone ? 80 : 30, isDone ? 132 : 30, isDone ? 110 : 30);
  doc.circle(bx, by, badgeR, 'F');
  doc.setTextColor(255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.text(String(stepNum), bx, by + 6, { align: 'center' });
  doc.setTextColor(0);

  // Panel id chip — top-right. "done" frame gets a different chip label.
  const chipText = isDone ? 'Assembled' : panelId;
  if (chipText) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(isDone ? 11 : 13);
    const tw = doc.getTextWidth(chipText) + 18;
    const px = x + w - 14 - tw;
    const py = y + 14;
    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(60);
    doc.setLineWidth(0.6);
    doc.roundedRect(px, py, tw, 24, 6, 6, 'FD');
    doc.setTextColor(30);
    doc.text(chipText, px + tw / 2, py + 16, { align: 'center' });
    doc.setTextColor(0);
  }
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
  const toBuy = items.reduce((a, x) => a + Math.max(0, x.needed - x.available), 0);
  doc.text(
    items.length > 0
      ? `${toBuy} ${toBuy === 1 ? 'sheet' : 'sheets'} to buy.`
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
  doc.text('woodworking-companion', PAGE_PAD, fy);
  doc.text(`Page ${pageNum} of ${pageTotal}`, PAGE_W / 2, fy, { align: 'center' });
  doc.text(dateStr, PAGE_W - PAGE_PAD, fy, { align: 'right' });
  doc.setTextColor(0);
}

/**
 * Draw one cut-step card: caption above, sheet diagram below with
 * placed parts overlaid in their colors, the active parent piece
 * highlighted, and the surrounding cut-off stock faded to 20% opacity.
 *
 * Orientation: the sheet's LONG edge is always horizontal in display.
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
  _labels?: Map<string, PartLabel>,
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
  let label: string;
  let edgeRef: string;
  if (cur.isTrim) {
    label = 'Trim';
    edgeRef = '(reference edge)';
  } else {
    label = cur.axis === 'rip' ? 'Rip' : 'Crosscut';
    // Distances run from the parent's datum corner (top-left): vertical
    // lines measure from the LEFT edge, horizontal lines from the TOP —
    // unless flipped to the FAR edge (R for vertical, B for horizontal).
    // A `measureFromCut` chain-dimensions off a PREVIOUS cut's fresh edge:
    // caption reads "from cut N" (N = that cut's index in the final sequence).
    const vertical = (sc.sheetL >= sc.sheetW) ? cur.axis === 'rip' : cur.axis === 'cross';
    const refCut = cur.measureFromCut ? findCutByKey(sc, cur.measureFromCut) : null;
    edgeRef = refCut
      ? `from cut ${refCut.index}`
      : vertical
        ? (cur.fromFar ? 'from R edge' : 'from L edge')
        : (cur.fromFar ? 'from B edge' : 'from T edge');
  }
  const refChip = cur.isDatum && !cur.isTrim ? '  ·  REF' : '';
  const settingNote = cur.sameSetting ? '  ·  same setting' : '';
  doc.text(`${label}  ${fmtDim(quotedDistance(cur, sc, opt), opt.units)}  ${edgeRef}${refChip}${settingNote}`, x, y + 20);
  doc.setTextColor(0);

  drawCutDiagram(doc, sc, parts, cutIdx, x, y + 24, cardW, diagH, opt);
}

/**
 * The dimension quoted to the user for a cut step.
 *   - Trim cuts: always the margin width (a far-long-edge trim's raw
 *     distance is nearly the whole span — the meaningful number is the
 *     sliver coming off).
 *   - Layout cuts: the kerf allowance follows the kerf-reference mode
 *       'keeper'  → distance − kerf  (keeper width / flip-stop number)
 *       'center'  → distance          (kerf-centre, no blade comp)
 *       'spacing' → distance − kerf/2 (spacing only)
 *   - `fromFar`: the dimension is quoted from the FAR parallel edge, so the
 *     value is parentSpan − distance − kerfAllowance.
 */
function quotedDistance(
  cur: CutStep,
  sc: { sheetW: number; sheetL: number; steps: CutStep[] },
  opt: PdfOptions,
): number {
  const lengthIsY = sc.sheetL >= sc.sheetW;
  const vertical = lengthIsY ? cur.axis === 'rip' : cur.axis === 'cross';
  const span = vertical ? cur.parentW : cur.parentH;
  if (cur.isTrim) return Math.min(cur.distance, span - cur.distance);
  const mode = opt.kerfRef ?? 'keeper';
  const allowance = mode === 'keeper' ? opt.kerf : mode === 'spacing' ? opt.kerf / 2 : 0;
  // Chain dimensioning: quote from a PREVIOUS parallel cut's fresh edge —
  // |this line − that line| minus the kerf allowance (the parallel-guide
  // flip-stop registers off the fresh-cut edge, same kerf comp as any keeper).
  if (cur.measureFromCut) {
    const ref = findCutByKey(sc, cur.measureFromCut);
    if (ref) {
      const thisLine = (vertical ? cur.parentX : cur.parentY) + cur.distance;
      const refVertical = lengthIsY ? ref.axis === 'rip' : ref.axis === 'cross';
      const refLine = (refVertical ? ref.parentX : ref.parentY) + ref.distance;
      return Math.max(0, Math.abs(thisLine - refLine) - allowance);
    }
  }
  const base = cur.fromFar ? span - cur.distance : cur.distance;
  return Math.max(0, base - allowance);
}

/** Find a step in the sheet's final sequence by its cutKeyFor() key — used to
 *  resolve a `measureFromCut` reference to the actual referenced cut (for its
 *  index in the caption + its line coordinate in the green highlight). */
function findCutByKey(sc: { steps: CutStep[] }, key: string): CutStep | null {
  return sc.steps.find((s) => cutKeyFor(s) === key) ?? null;
}

/**
 * The cut-step DIAGRAM alone (sheet + parts + prior cuts + active cut),
 * without the caption — shared by the desktop cut cards and the mobile
 * one-cut-per-page layout.
 */
function drawCutDiagram(
  doc: jsPDF,
  sc: ReturnType<typeof allCutSteps>[number],
  parts: NestSheet['parts'],
  cutIdx: number,
  x: number,
  diagY: number,
  cardW: number,
  diagH: number,
  opt: PdfOptions,
) {
  const cur = sc.steps[cutIdx];
  // Keep the SHEET's original orientation (the per-sheet overview page is
  // the one that rotates long-edge-horizontal). Identity orient = no swap.
  const orient: Orient = {
    dispW: sc.sheetW,
    dispH: sc.sheetL,
    rotated: false,
    rect: (x, y, w, h) => ({ x, y, w, h }),
  };
  const scale = Math.min(cardW / orient.dispW, diagH / orient.dispH);
  const dW = orient.dispW * scale;
  const dH = orient.dispH * scale;
  const ox = x + (cardW - dW) / 2;
  const oy = diagY;

  // Sheet background — LIGHT CREAM wood. Light enough that colored
  // panels read clearly on top, but warm enough to feel like wood.
  doc.setFillColor(245, 239, 217);
  doc.setDrawColor(180, 162, 112);
  doc.setLineWidth(0.6);
  doc.rect(ox, oy, dW, dH, 'FD');

  // Part overlays — per-body COLOR at 50% opacity. Cut lines render on
  // top of them so they stay readable. The "cut-off vs remaining" focus
  // comes from the white fade overlay applied below, not from per-part
  // alpha.
  const GS = (doc as any).GState;
  if (GS) (doc as any).setGState(new GS({ opacity: 0.50 }));
  for (const p of parts) {
    const r0 = orient.rect(p.x, p.y, p.w, p.h);
    const [r, g, b] = hexToRgb(p.color);
    doc.setFillColor(r, g, b);
    doc.rect(ox + r0.x * scale, oy + r0.y * scale, r0.w * scale, r0.h * scale, 'F');
  }
  if (GS) (doc as any).setGState(new GS({ opacity: 1 }));

  // Per-panel callouts — id + size when there's room ("3a · 24"×18""),
  // id-only when the cell is mid-sized, nothing when tiny.
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(50);
  for (const p of parts) {
    const r0 = orient.rect(p.x, p.y, p.w, p.h);
    const cellW = r0.w * scale;
    const cellH = r0.h * scale;
    const minPx = Math.min(cellW, cellH);
    if (minPx < 10) continue;
    const id = `${sc.globalIndex}${p.panelLabel}`;
    const cx = ox + (r0.x + r0.w / 2) * scale;
    const cy = oy + (r0.y + r0.h / 2) * scale;
    const longMm = Math.max(p.w, p.h);
    const shortMm = Math.min(p.w, p.h);
    const dimText = `${fmtDim(longMm, opt.units)} × ${fmtDim(shortMm, opt.units)}`;
    const fs = Math.max(6, Math.min(14, minPx * 0.32));
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(fs);
    if (minPx >= 28) {
      // Room for id + size on two lines
      doc.text(id, cx, cy - fs * 0.05, { align: 'center' });
      const subSize = Math.max(5, Math.min(9, fs * 0.55));
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(subSize);
      doc.setTextColor(95);
      doc.text(dimText, cx, cy + fs * 0.65, { align: 'center' });
      doc.setTextColor(50);
    } else {
      doc.text(id, cx, cy + fs * 0.32, { align: 'center' });
    }
  }

  // Prior cuts as thin white lines. Trim AND datum (reference) cuts are
  // drawn separately in BLUE after the fade overlay, so the datum edges stay
  // visible — skip them here.
  doc.setLineWidth(0.4);
  doc.setDrawColor(255, 255, 255);
  for (let i = 0; i < cutIdx; i++) {
    if (sc.steps[i].isTrim || sc.steps[i].isDatum) continue;
    drawCutLineInParent(doc, sc.steps[i], sc.sheetW, sc.sheetL, orient, ox, oy, scale);
  }

  // White fade overlay over EVERYTHING outside the current parent piece —
  // emphasises the piece the user is about to cut, fading already-cut
  // stock to 20% remaining opacity (paint white at 80% opacity).
  const parentRect = orient.rect(cur.parentX, cur.parentY, cur.parentW, cur.parentH);
  const pX = ox + parentRect.x * scale;
  const pY = oy + parentRect.y * scale;
  const pW = parentRect.w * scale;
  const pH = parentRect.h * scale;
  if (GS) (doc as any).setGState(new GS({ opacity: 0.80 }));
  doc.setFillColor(255, 255, 255);
  // Top strip
  if (pY > oy + 0.5) doc.rect(ox, oy, dW, pY - oy, 'F');
  // Bottom strip
  if (pY + pH < oy + dH - 0.5) doc.rect(ox, pY + pH, dW, (oy + dH) - (pY + pH), 'F');
  // Left strip (between top + bottom strips)
  if (pX > ox + 0.5) doc.rect(ox, pY, pX - ox, pH, 'F');
  // Right strip
  if (pX + pW < ox + dW - 0.5) doc.rect(pX + pW, pY, (ox + dW) - (pX + pW), pH, 'F');
  if (GS) (doc as any).setGState(new GS({ opacity: 1 }));

  // Reference edges — trim cuts AND user-marked datum cuts — in BLUE, on top
  // of the fade so the datums are always identifiable at the saw.
  doc.setLineWidth(0.7);
  doc.setDrawColor(43, 108, 176);
  for (let i = 0; i < cutIdx; i++) {
    if (!sc.steps[i].isTrim && !sc.steps[i].isDatum) continue;
    drawCutLineInParent(doc, sc.steps[i], sc.sheetW, sc.sheetL, orient, ox, oy, scale);
  }

  // Highlight the active parent piece with a thin red border.
  doc.setDrawColor(224, 62, 62);
  doc.setLineWidth(0.7);
  doc.rect(pX, pY, pW, pH, 'S');

  // Current cut as bold red line with arrow caps, drawn inside the parent.
  doc.setLineWidth(2.0);
  doc.setDrawColor(224, 62, 62);
  drawCutLineInParent(doc, cur, sc.sheetW, sc.sheetL, orient, ox, oy, scale, true);

  // The edge the distance is MEASURED FROM, in green — mirrors the caption
  // ("from L/T" near edge, or "from R/B" far edge when fromFar). Left/top for
  // vertical/horizontal cuts by default; the opposite edge when flipped. This
  // is where the parallel-guide stops register.
  //
  // Chain dimensioning (`measureFromCut`): the reference is a PREVIOUS cut's
  // fresh edge, not a piece edge — draw the green highlight on that CUT LINE
  // (within its own parent piece) instead.
  const measVertical = (sc.sheetL >= sc.sheetW) ? cur.axis === 'rip' : cur.axis === 'cross';
  doc.setDrawColor(47, 133, 90);
  doc.setLineWidth(1.6);
  const refCut = cur.measureFromCut ? findCutByKey(sc, cur.measureFromCut) : null;
  if (refCut) {
    const refVertical = (sc.sheetL >= sc.sheetW) ? refCut.axis === 'rip' : refCut.axis === 'cross';
    if (refVertical) {
      const rx = ox + (refCut.parentX + refCut.distance) * scale;
      doc.line(rx, oy + refCut.parentY * scale, rx, oy + (refCut.parentY + refCut.parentH) * scale);
    } else {
      const ry = oy + (refCut.parentY + refCut.distance) * scale;
      doc.line(ox + refCut.parentX * scale, ry, ox + (refCut.parentX + refCut.parentW) * scale, ry);
    }
  } else if (measVertical) {
    const gx = cur.fromFar ? pX + pW : pX;
    doc.line(gx, pY, gx, pY + pH);
  } else {
    const gy = cur.fromFar ? pY + pH : pY;
    doc.line(pX, gy, pX + pW, gy);
  }
}

/**
 * Draw a single cut step's line INSIDE its parent piece's rectangle.
 *
 * Cut-axis mapping (rip = parallel to sheet's length axis, cross = across):
 *   - Sheet space: rip is V (constant X) when sheetL>=sheetW, else H.
 *   - Display space: applying the orient swap flips V↔H.
 *
 * `step.distance` is the offset from the parent's reference edge in sheet
 * coords; after `orient.rect` swaps parent (x,y), the same distance value
 * lands on the right display axis automatically.
 */
function drawCutLineInParent(
  doc: jsPDF,
  step: { axis: 'rip' | 'cross'; distance: number; parentX: number; parentY: number; parentW: number; parentH: number },
  sheetW: number,
  sheetL: number,
  orient: Orient,
  ox: number,
  oy: number,
  scale: number,
  withArrows = false,
) {
  const pr = orient.rect(step.parentX, step.parentY, step.parentW, step.parentH);
  const px = ox + pr.x * scale;
  const py = oy + pr.y * scale;
  const pw = pr.w * scale;
  const ph = pr.h * scale;

  const lengthIsY = sheetL >= sheetW;
  const isVerticalInSheet = lengthIsY ? step.axis === 'rip' : step.axis === 'cross';
  const isVerticalInDisplay = orient.rotated ? !isVerticalInSheet : isVerticalInSheet;

  if (isVerticalInDisplay) {
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
