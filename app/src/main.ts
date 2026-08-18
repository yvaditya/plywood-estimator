/**
 * Glue layer for the plywood estimator UI.
 * - File handling + STEP parsing
 * - Sidebar: sheet config, bodies, inventory
 * - Viewer + click-selection sync
 * - Estimate → multi-restart nester
 * - Results: detail view + thumbnail strip + DXF/PDF downloads
 */

import './style.css';

import * as THREE from 'three';
import { parseStep, preloadOcct, type OcctResult } from './stepLoader';
import { Viewer, bodyColor } from './viewer';
import { analyzeBody, type BodyAnalysis } from './geometry';
import {
  runNest,
  runNestAnimated,
  type GrainLock,
  type RotationMode,
  type NestPart,
  type NestSheet,
  type NestResult,
  type PlacedPart,
  type CutStrategy,
  isCncStrategy,
} from './nest';
import { sheetToDxf, downloadDxf } from './dxf';
import { buildStep, type StepPart } from './stepExport';
import {
  buildPdf,
  buildAssemblyAnalysisPdf,
  buildCutlistPdf,
  cutlistSnapshotTarget,
  downloadPdf,
  type CutlistPaper,
  type InventoryCheck,
} from './pdf';
import {
  buildShoppingList,
  setHave,
  setPrice,
  totalCost,
  toCsv,
  downloadCsv,
  loadJobName,
  saveJobName,
  type ShoppingRow,
} from './shoppingList';
import { assignPartLabels, type PartLabel, type KerfRef, type SequenceStyle } from './instructions';
import { openCutEditor, loadAllOverrides } from './cutEditor';
import { mountCaeLegend } from './caeLegend';
import { splitOversizeParts, type SegmentGeo } from './splitParts';
import { toRoman } from './nest';
import type { SplitJoinGroup } from './pdf';
import { fmtDim, fmtArea, fmtLinear, fmtMoney, fmtSag, toMm, fromMm, parseDimInput, type Units } from './units';
import {
  MATERIALS,
  DEFAULT_MATERIAL_ID,
  materialById,
  panelWeightKg,
  screenPanel,
  detectJoints,
  solveAssembly,
  serializeAssembly,
  recoverAssembly,
  previewAssembly,
  heatColor,
  fieldExtent,
  resolveLegendRange,
  formatLegendValue,
  DEFAULT_LEGEND,
  type Verdict,
  type CaeMeshView,
  type CaeConstraintView,
  type MeshKind,
  type LegendSpec,
  type AsmPanel,
  type AsmJoint,
  type AsmLoad,
  type AsmPanelResult,
  type AsmSolveOptions,
  type JointStiffness,
  type SolveProgress,
} from './cae';
import { getDirectSolver, getPyniteBackend, launchSidecar } from './solverBackend';

// --------------------------------------------------------------------------
// State
// --------------------------------------------------------------------------
interface BodyState {
  id: number;
  name: string;
  /** Source STEP file (filename without extension). Used to group bodies
   *  per file for per-file exploded views in the PDF. */
  fileTag: string;
  analysis: BodyAnalysis;
  qty: number;
  grain: GrainLock;
  rotation: RotationMode;
  selected: boolean;
  color: string;
  /** Per-body material override id, or null → use the job-default material. */
  material: string | null;
}

/** One footprint load in the Analysis section. Magnitude is entered as
 *  val+unit; `down` toggles between a downward force (↓) and an upward
 *  reaction (↑). `panelId` is the body it's placed on (null until placed).
 *  This is the SAME row UI the per-panel CAE used, now assembly-scoped. */
interface CaeLoad {
  val: number;
  unit: 'N' | 'kg' | 'lbf';
  /** Panel this load sits on + its outline-mm position. null → unplaced. */
  panelId: number | null;
  pt: { x: number; y: number } | null;
  shape: 'square' | 'round';
  /** Footprint size in mm (side length or diameter). */
  sizeMm: number;
  down: boolean;
}

/** A detected joint row in the Analysis section (mirrors cae.AsmJoint plus a
 *  cached label for the list). */
interface JointRow {
  a: number; b: number;
  labelA: string; labelB: string;
  p0: [number, number, number];
  p1: [number, number, number];
  length: number;
  stiffness: JointStiffness;
}

/** Everything the PDF needs to render the Assembly analysis page. Captured
 *  only after a successful assembly solve this session — its presence gates
 *  the Structure table + Assembly analysis page in the job PDF. */
interface AssemblyAnalysis {
  heatmapPng: string;
  imgW: number;
  imgH: number;
  /** Second heatmap: von-Mises stress field (same view). '' if capture failed. */
  stressPng: string;
  stressImgW: number;
  stressImgH: number;
  cabinetTag: string;
  panelCount: number;
  joints: { labelA: string; labelB: string; length: number; stiffness: string }[];
  loads: { magDisplay: string; shape: string; sizeMm: number; down: boolean; panelLabel: string }[];
  groundedNodes: number;
  maxSagMm: number;
  maxPanelLabel: string;
  maxAt: [number, number];
  spanMm: number;
  verdict: string;
  /** Max von-Mises surface stress (MPa) + governing panel + location. */
  maxVmMPa: number;
  maxVmPanelLabel: string;
  maxVmAt: [number, number];
  /** Utilization % vs the material bending strengths + its verdict. */
  utilPct: number;
  stressVerdict: string;
  /** Combined verdict (worst of deflection + stress). */
  combinedVerdict: string;
  resolutionLog: string;
  iterations: number;
}

/** Per-cabinet Analysis-section session state (joints, loads, last result). */
interface AsmState {
  /** fileTag of the cabinet currently targeted by the Analysis section. */
  cabinet: string | null;
  /** Join tolerance in mm. */
  tolMm: number;
  /** Detected joints for the current cabinet (persist per session). */
  joints: JointRow[];
  /** Loads placed across the cabinet's panels. */
  loads: CaeLoad[];
  /** Last solve summary line. */
  solveMsg: string;
  /** Captured analysis for the PDF (gates Structure + Assembly page). */
  analysis: AssemblyAnalysis | null;
  /** True once "Detect joints" has run for the current cabinet. */
  detected: boolean;
  /** Which field the heatmap paints (segmented toggle, post-solve). */
  field: 'deflection' | 'stress';
  /** Cached last solve result + the panel bodies it covered, so the field
   *  toggle can re-texture the overlays WITHOUT re-solving. Cleared whenever
   *  joints/loads change (same lifecycle as `analysis`). */
  lastSolve: { res: ReturnType<typeof solveAssembly>; panelIds: number[]; meshKey: string } | null;
  /** Element family the mesh is built from — 'shell' (fast, 6 DOF/node) or
   *  'solid' (hexes through the thickness, 3 DOF/node). */
  meshKind: MeshKind;
  /** Target element edge length (mm) handed to the mesher. */
  elementSizeMm: number;
  /** Hex layers through the thickness (solid only). */
  solidLayers: number;
  /** The un-solved mesh + constraints from previewAssembly, so the mesh can be
   *  inspected BEFORE committing to a solve. Invalidated with the joints. */
  preview: { mesh: CaeMeshView; constraints: CaeConstraintView; resolutionLog: string } | null;
  /** Which CAE overlays are visible. */
  show: { mesh: boolean; nodes: boolean; supports: boolean; couplings: boolean; loads: boolean };
  /** Deformed-shape exaggeration; 0 = undeformed. 'auto' picks a factor that
   *  makes the peak deflection ≈ 6% of the model diagonal. */
  deformScale: number | 'auto';
  /** Colour map / banding / range for the fringe plot. Shared by the on-canvas
   *  legend and the mesh contour so they can't describe different scales. */
  legend: LegendSpec;
  /** Is the per-joint list expanded? Collapsed by default — a cabinet detects
   *  70+ contacts and the list buries everything below it. */
  jointsOpen: boolean;
}

const state: {
  result: OcctResult | null;
  bodies: BodyState[];
  units: Units;
  lastNest: NestResult | null;
  lastSheet: { w: number; l: number; margin: number; kerf: number } | null;
  /** Cut strategy used for the last estimate (drives CNC-specific UI). */
  lastStrategy: CutStrategy;
  shopping: ShoppingRow[];
  currentSheetKey: string | null;   // "g{groupIdx}-s{sheetIdx}"
  currency: string;
  /** How each cut's dimension is quoted at the saw (persisted). */
  kerfRef: KerfRef;
  /** Cut-sequencing style (persisted). 'row' = learned "easy cut" row-by-row
   *  (default); 'optimized' = parallel-guide fewest-setups scheduler. */
  sequenceStyle: SequenceStyle;
  jobName: string;
  partLabels: Map<string, PartLabel>;
  nonSheetCount: number;
  /** Per-fileTag UI state: collapsed (true) hides the bodies inside this
   *  file group. Defaults to expanded when a new file is loaded. */
  collapsedFiles: Set<string>;
  /** Last optimisation's per-trial captured layouts (current and final).
   *  Replayed on demand via the play button beside the Cut layout title.
   *  Cleared each time a new estimate kicks off. */
  lastTrialFrames: { sheets: NestSheet[]; sheetW: number; sheetL: number; margin: number; trial: number; total: number; isNewBest: boolean }[];
  /** Per-trial metrics for the convergence plot. Captured alongside frames
   *  during the run. `bestCuts`/`bestSheets`/`bestYield` track the running
   *  best so the chart shows monotonic improvement. */
  lastTrialMetrics: { i: number; cuts: number; sheets: number; yieldPct: number; bestCuts: number; bestSheets: number; bestYield: number }[];
  /** Geometry of dovetail segments generated by the CNC auto-split for the
   *  last estimate, keyed by segment part id. Feeds the unplaced STEP export
   *  (segment ids don't resolve to a source body) and the PDF join guide. */
  splitSegmentGeo: Map<string, SegmentGeo>;
  /** "Name → pieces" rows for parts the last estimate auto-split. */
  splitInfo: { name: string; pieces: number }[];
  /** Job-default material card id (per-body overrides fall back to this). */
  jobMaterial: string;
  /** Assembly Analysis-section state (joints, loads, last solve). */
  asm: AsmState;
} = {
  result: null,
  bodies: [],
  units: 'in',
  lastNest: null,
  lastSheet: null,
  lastStrategy: 'guillotine',
  shopping: [],
  currentSheetKey: null,
  currency: 'USD',
  kerfRef: 'keeper',
  sequenceStyle: 'row',
  jobName: '',
  partLabels: new Map(),
  nonSheetCount: 0,
  collapsedFiles: new Set<string>(),
  lastTrialFrames: [],
  lastTrialMetrics: [],
  splitSegmentGeo: new Map(),
  splitInfo: [],
  jobMaterial: DEFAULT_MATERIAL_ID,
  asm: {
    cabinet: null, tolMm: 2, joints: [], loads: [], solveMsg: '', analysis: null,
    detected: false, field: 'deflection', lastSolve: null,
    meshKind: 'shell', elementSizeMm: 30, solidLayers: 2, preview: null,
    show: { mesh: true, nodes: false, supports: true, couplings: true, loads: true },
    deformScale: 'auto',
    legend: { ...DEFAULT_LEGEND },
    jointsOpen: false,
  },
};

// --------------------------------------------------------------------------
// DOM helpers
// --------------------------------------------------------------------------
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const dropzone = $('dropzone');
const fileInput = $<HTMLInputElement>('fileInput');
const pickFileBtn = $('pickFileBtn');
const loadStatus = $('loadStatus');
const loadProgress = $('loadProgress');
const loadProgressFill = $('loadProgressFill');
const loadProgressLabel = $('loadProgressLabel');
const bodyList = $('bodyList');
const bodyCount = $('bodyCount');
// #versionLine is filled server-side by the git-version-line vite plugin
// (see vite.config.ts) — always the repo's current HEAD, no restart needed.
const nestBtn = $<HTMLButtonElement>('nestBtn');
const selectAllBtn = $('selectAllBtn');
const clearAllBtn = $('clearAllBtn');
const selectNoneBtn = $('selectNoneBtn');
const sheetWInput = $<HTMLInputElement>('sheetW');
const sheetLInput = $<HTMLInputElement>('sheetL');
const marginInput = $<HTMLInputElement>('margin');
const kerfInput = $<HTMLInputElement>('kerf');
const unitsSelect = $<HTMLSelectElement>('units');
const presetSelect = $<HTMLSelectElement>('preset');
const presetCustomGroup = $<HTMLOptGroupElement>('presetCustomGroup');
const savePresetBtn = $<HTMLButtonElement>('savePresetBtn');
const deletePresetBtn = $<HTMLButtonElement>('deletePresetBtn');
const restartsSelect = $<HTMLSelectElement>('restarts');
const cutStrategySelect = $<HTMLSelectElement>('cutStrategy');
const thicknessOverrideSelect = $<HTMLSelectElement>('thicknessOverride');
const materialSelect = $<HTMLSelectElement>('material');
const splitOversizeRow = $('splitOversizeRow');
const splitOversizeCheck = $<HTMLInputElement>('splitOversize');
const viewerEl = $('viewer');

// --------------------------------------------------------------------------
// Unit-aware dimension fields (Width / Length / Edge margin / Custom kerf)
//
// Each field is the display-side of a single mm-canonical value stored in the
// element's `dataset.mm`. The user may TYPE in any unit ("24\"", "4mm",
// "1-1/2\"", "2'") — on change/blur we parse to mm via `parseDimInput`, store
// mm, re-render the field in the CURRENT display units, and update a small
// subtext line showing the value in the OTHER unit system. Invalid input
// reverts to the last-good mm (no error churn). Every downstream read goes
// through `readFieldMm`, so Estimate/DXF/PDF always receive the same mm as
// before.
// --------------------------------------------------------------------------
const dimFields: { input: HTMLInputElement; sub: HTMLSpanElement }[] = [
  { input: sheetWInput, sub: $<HTMLSpanElement>('sheetWSub') },
  { input: sheetLInput, sub: $<HTMLSpanElement>('sheetLSub') },
  { input: marginInput, sub: $<HTMLSpanElement>('marginSub') },
  { input: kerfInput,   sub: $<HTMLSpanElement>('kerfSub') },
];
const subFor = (input: HTMLInputElement): HTMLSpanElement | null =>
  dimFields.find((f) => f.input === input)?.sub ?? null;

/** Read a dimension field's canonical mm value. */
function readFieldMm(input: HTMLInputElement): number {
  const v = parseFloat(input.dataset.mm ?? '');
  return Number.isFinite(v) ? v : 0;
}

/** Render the field text (current units) + subtext (the other unit system). */
function renderDimField(input: HTMLInputElement, mm: number) {
  input.dataset.mm = String(mm);
  const disp = fmtDim(mm, state.units);
  input.value = disp;
  // Remember the exact display string so a later change/blur that DIDN'T
  // retype can skip re-parsing — re-parsing the rounded display (e.g. 3/16")
  // would drift the canonical mm away from the value the user actually typed
  // (4 mm → 3/16" → 4.76 mm).
  input.dataset.disp = disp;
  const sub = subFor(input);
  if (sub) {
    const other: Units = state.units === 'in' ? 'mm' : 'in';
    sub.textContent = `= ${fmtDim(mm, other)}`;
  }
}

/** Store a new mm value on a field and re-render it. */
function setFieldMm(input: HTMLInputElement, mm: number) {
  renderDimField(input, mm);
}

/** Re-render every dimension field + subtext in the current units. */
function renderAllDimFields() {
  for (const { input } of dimFields) renderDimField(input, readFieldMm(input));
}

/** Parse the typed value; commit if valid, revert to last-good mm if not. */
function commitDimField(input: HTMLInputElement) {
  // Untouched since the last render (e.g. a blur right after a change) — the
  // canonical mm is authoritative; don't re-parse the rounded display string.
  if (input.value.trim() === (input.dataset.disp ?? '').trim()) return;
  const parsed = parseDimInput(input.value, state.units);
  if (parsed) {
    setFieldMm(input, parsed.mm);
    // The custom-kerf field also persists to localStorage so the choice
    // survives a reload (mirrors the old #kerf 'input' handler).
    if (input === kerfInput) persistKerf();
  } else {
    // Revert silently to the last-good value.
    renderDimField(input, readFieldMm(input));
  }
}

// Seed each field's canonical mm from its initial HTML value (interpreted in
// the startup display units) and paint the first subtext.
for (const { input } of dimFields) {
  const seed = parseDimInput(input.value, state.units);
  renderDimField(input, seed ? seed.mm : 0);
}
for (const { input } of dimFields) {
  input.addEventListener('change', () => commitDimField(input));
  input.addEventListener('blur', () => commitDimField(input));
}

// Thickness override — standard nominal plywood sizes, exact mm.
const STANDARD_THICKNESSES_MM = [6.35, 12.7, 19.05, 25.4]; // 1/4″ 1/2″ 3/4″ 1″
function applyThicknessOverride(measuredMm: number): number {
  const v = thicknessOverrideSelect.value;
  if (!v) return measuredMm;
  if (v === 'snap') {
    return STANDARD_THICKNESSES_MM.reduce((best, t) =>
      Math.abs(t - measuredMm) < Math.abs(best - measuredMm) ? t : best);
  }
  return parseFloat(v);
}

// The dovetail auto-split only makes sense for contour-cutting strategies.
function syncSplitOversizeVisibility() {
  splitOversizeRow.hidden = !isCncStrategy((cutStrategySelect.value as CutStrategy) || 'free');
}
cutStrategySelect.addEventListener('change', syncSplitOversizeVisibility);
syncSplitOversizeVisibility();

// --------------------------------------------------------------------------
// Material — job default (persisted) + per-body override resolution.
// --------------------------------------------------------------------------
const MATERIAL_KEY = 'ply.material';
for (const m of MATERIALS) {
  const opt = document.createElement('option');
  opt.value = m.id;
  opt.textContent = m.name;
  materialSelect.appendChild(opt);
}
{
  const saved = localStorage.getItem(MATERIAL_KEY);
  if (saved && MATERIALS.some((m) => m.id === saved)) state.jobMaterial = saved;
}
materialSelect.value = state.jobMaterial;
materialSelect.addEventListener('change', () => {
  state.jobMaterial = materialSelect.value;
  try { localStorage.setItem(MATERIAL_KEY, state.jobMaterial); } catch {}
  renderBodyList();
  refreshWeakBodies();
});

/** Resolve a body's effective material card (override → job default). */
function bodyMaterial(b: BodyState) {
  return materialById(b.material ?? state.jobMaterial);
}

/** Weight in the user's current unit system, formatted. */
function fmtWeight(kg: number): string {
  if (state.units === 'in') return `${(kg * 2.2046226).toFixed(1)} lb`;
  return `${kg.toFixed(2)} kg`;
}

/** Yield a frame to the browser so heavy work doesn't block paints. */
const yieldFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

const resultsEmpty = $('resultsEmpty');
const resultsDetail = $('resultsDetail');
const detailTitle = $('detailTitle');
const replayBtn = $<HTMLButtonElement>('replayBtn');
const optimizeMoreBtn = $<HTMLButtonElement>('optimizeMoreBtn');
const convergenceChart = $('convergenceChart');
const detailSub = $('detailSub');
const detailSvg = $('detailSvg');
const detailMetrics = $('detailMetrics');
const inventoryCheckEl = $('inventoryCheck');
const unplacedList = $('unplacedList');
const splitNote = $('splitNote');
const downloadDxfBtn = $<HTMLButtonElement>('downloadDxfBtn');
const downloadCutDxfBtn = $<HTMLButtonElement>('downloadCutDxfBtn');
const downloadPdfBtn = $<HTMLButtonElement>('downloadPdfBtn');
const downloadPhonePdfBtn = $<HTMLButtonElement>('downloadPhonePdfBtn');
const downloadCutlistPdfBtn = $<HTMLButtonElement>('downloadCutlistPdfBtn');

const shopList = $('shoppingList');
const shopCount = $('shopCount');
const shopCopyBtn = $<HTMLButtonElement>('shopCopyBtn');
const shopCsvBtn = $<HTMLButtonElement>('shopCsvBtn');
const shopTotals = $('shopTotals');
const jobNameInput = $<HTMLInputElement>('jobName');
const currencySelect = $<HTMLSelectElement>('currency');
const pdfPaperSelect = $<HTMLSelectElement>('pdfPaper');
const cutlistPaperSelect = $<HTMLSelectElement>('cutlistPaper');
// Export options menu (Cut Layout header). One set of switches drives BOTH
// PDF exports; the 3D one is viewport-only.
const optAssembly = $<HTMLInputElement>('optAssembly');
const optPanelLists = $<HTMLInputElement>('optPanelLists');
const optCutSteps = $<HTMLInputElement>('optCutSteps');
const opt3dLabels = $<HTMLInputElement>('opt3dLabels');
const kerfRefSelect = $<HTMLSelectElement>('kerfRef');
const sequenceStyleSelect = $<HTMLSelectElement>('sequenceStyle');
const kerfSelect = $<HTMLSelectElement>('kerfSelect');
const kerfCustomRow = $('kerfCustomRow');

// --------------------------------------------------------------------------
// Viewer
// --------------------------------------------------------------------------
const viewer = new Viewer(viewerEl);
viewer.setSelectionListener(() => {
  for (const b of state.bodies) {
    b.selected = viewer.selection.has(b.id);
  }
  pushAllGrainToViewer();
  refreshWeakBodies();
  renderBodyList();
  updateNestBtn();
});
viewer.setGrainCycleListener((bodyId: number) => {
  const b = state.bodies.find((x) => x.id === bodyId);
  if (!b) return;
  const next: GrainLock =
    b.grain === 'free' ? 'length' :
    b.grain === 'length' ? 'width' : 'free';
  b.grain = next;
  pushGrainToViewer(b);
  renderBodyList();
});

/** Send a body's current grain (and orientation info) to the viewer. */
function pushGrainToViewer(b: BodyState) {
  viewer.setBodyGrain(b.id, b.grain, {
    faceCenter: b.analysis.faceCenter,
    faceNormal: b.analysis.faceNormal,
    lengthDir: b.analysis.lengthDir,
    widthDir: b.analysis.widthDir,
    length: b.analysis.length,
    width: b.analysis.width,
    thickness: b.analysis.thickness,
  });
}
function pushAllGrainToViewer() {
  for (const b of state.bodies) pushGrainToViewer(b);
}

/** Screening verdict for a body under the default uniform load. */
function bodyScreen(b: BodyState) {
  return screenPanel(
    b.analysis.length, b.analysis.width, b.analysis.thickness,
    bodyMaterial(b), { grain: b.grain },
  );
}

/** Recompute which bodies screen as 'weak' and tint them subtly in 3D. */
function refreshWeakBodies() {
  const weak: number[] = [];
  for (const b of state.bodies) {
    if (bodyScreen(b).verdict === 'weak') weak.push(b.id);
  }
  viewer.setWeakBodies(weak);
}

// --------------------------------------------------------------------------
// Pane layout — divider drag + maximize toggles
// The 3D viewer canvas needs a manual resize() poke whenever its column
// width changes, since Three.js doesn't observe the container by itself.
// --------------------------------------------------------------------------
const workArea = $('workArea');
const viewerPane = $('viewerPane');
const layoutPane = $('layoutPane');
const paneDivider = $('paneDivider');
const viewerMaxBtn = $('viewerMaxBtn');
const layoutMaxBtn = $('layoutMaxBtn');
const recenterBtn = $<HTMLButtonElement>('recenterBtn');

function pokeViewerResize() {
  // Defer until next frame so the new column widths are computed.
  requestAnimationFrame(() => viewer.resize(viewerEl));
}

(function wireDivider() {
  let dragging = false;
  let workRect: DOMRect | null = null;

  const onDown = (ev: PointerEvent) => {
    dragging = true;
    workRect = workArea.getBoundingClientRect();
    paneDivider.classList.add('dragging');
    paneDivider.setPointerCapture(ev.pointerId);
    document.body.style.userSelect = 'none';
  };
  const onMove = (ev: PointerEvent) => {
    if (!dragging || !workRect) return;
    const dividerW = 6;
    const x = ev.clientX - workRect.left;
    const min = 200;
    const max = workRect.width - 200 - dividerW;
    const clamped = Math.max(min, Math.min(max, x));
    workArea.style.setProperty('--pane-split', `${clamped}px`);
    pokeViewerResize();
  };
  const onUp = (ev: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    paneDivider.classList.remove('dragging');
    try { paneDivider.releasePointerCapture(ev.pointerId); } catch {}
    document.body.style.userSelect = '';
    workRect = null;
  };
  paneDivider.addEventListener('pointerdown', onDown);
  paneDivider.addEventListener('pointermove', onMove);
  paneDivider.addEventListener('pointerup', onUp);
  paneDivider.addEventListener('pointercancel', onUp);
})();

viewerMaxBtn.addEventListener('click', () => {
  workArea.classList.toggle('viewer-max');
  workArea.classList.remove('layout-max');
  pokeViewerResize();
});
layoutMaxBtn.addEventListener('click', () => {
  workArea.classList.toggle('layout-max');
  workArea.classList.remove('viewer-max');
  pokeViewerResize();
});
recenterBtn.addEventListener('click', () => {
  viewer.frameAll();
});

// --------------------------------------------------------------------------
// File handling
// --------------------------------------------------------------------------
function setStatus(msg: string, kind: 'info' | 'ok' | 'error' = 'info') {
  loadStatus.textContent = msg;
  loadStatus.className = 'status ' + (kind === 'info' ? '' : kind);
}

/**
 * Multi-file STEP loading: bodies from each file APPEND to the model.
 *
 * Globally-unique body ids: a process-lifetime counter (`nextBodyId`) avoids
 * collisions between bodies from different STEP files. Body display names
 * are prefixed with the file name so the body list is browsable.
 *
 * Auto-translate: each file's geometry is shifted along +X so the files lay
 * out in a row instead of stacking on top of each other at world origin.
 * `cumulativeRightX` tracks the right-most extent of everything loaded so
 * far; the next file's left edge is placed at `cumulativeRightX + FILE_GAP`.
 *
 * Use clearAll() to reset between jobs.
 */
let nextBodyId = 0;
let cumulativeRightX = 0;
/** Gap (mm) between auto-laid-out files in the 3D view. */
const FILE_GAP = 100;

/** AABB extents along one axis (0=X, 1=Y, 2=Z) across all meshes. */
function meshesAabbAxis(meshes: any[], axis: 0 | 1 | 2): { min: number; max: number } | null {
  let min = Infinity, max = -Infinity;
  let found = false;
  for (const m of meshes) {
    const arr = m.attributes?.position?.array as number[] | undefined;
    if (!arr) continue;
    for (let i = axis; i < arr.length; i += 3) {
      const v = arr[i];
      if (v < min) min = v;
      if (v > max) max = v;
      found = true;
    }
  }
  return found ? { min, max } : null;
}

/** Translate every mesh's positions by `delta` along the given axis. */
function shiftMeshesAxis(meshes: any[], axis: 0 | 1 | 2, delta: number) {
  if (delta === 0) return;
  for (const m of meshes) {
    const arr = m.attributes?.position?.array as number[] | undefined;
    if (!arr) continue;
    for (let i = axis; i < arr.length; i += 3) arr[i] += delta;
  }
}

// Legacy aliases for the existing X-only callers
const meshesAabbX = (meshes: any[]) => meshesAabbAxis(meshes, 0);
const shiftMeshesX = (meshes: any[], dx: number) => shiftMeshesAxis(meshes, 0, dx);

// --- Import progress bar -----------------------------------------------
// STEP parse (OCCT WASM) and per-body analysis can both take seconds on
// complex models / many bodies; the bar keeps the UI honest meanwhile.
function showLoadProgress(frac: number, label: string) {
  loadProgress.hidden = false;
  loadProgressFill.style.width = `${Math.min(100, Math.max(0, frac * 100)).toFixed(1)}%`;
  loadProgressLabel.textContent = label;
}
function hideLoadProgress() {
  loadProgress.hidden = true;
  loadProgressFill.style.width = '0%';
}
/** Yield to the event loop so the progress bar actually repaints. */
const uiYield = () => new Promise<void>((r) => setTimeout(r, 0));
/** Within one file: fraction of the bar given to parsing vs body analysis. */
const PARSE_SHARE = 0.4;

async function handleFiles(files: FileList | File[]) {
  const list = Array.from(files).filter((f) => {
    const n = f.name.toLowerCase();
    return n.endsWith('.step') || n.endsWith('.stp');
  });
  if (list.length === 0) {
    setStatus('Please drop one or more .step or .stp files.', 'error');
    return;
  }

  setStatus(`Loading ${list.length} file${list.length > 1 ? 's' : ''} …`);
  let totalRaw = 0;
  let totalAdded = 0;
  let totalSkippedNotSheet = 0;
  // Phase timings, logged once at the end (same convention as the pdf log).
  const tLoad0 = performance.now();
  let tParse = 0, tAnalyze = 0, tMesh = 0, tYield = 0;
  let lastYieldMs = 0;
  try {
    for (let fi = 0; fi < list.length; fi++) {
      const file = list[fi];
      const fileBase = fi / list.length;
      const fileTagLabel = list.length > 1 ? `File ${fi + 1}/${list.length} · ` : '';
      showLoadProgress(fileBase, `${fileTagLabel}parsing ${file.name} …`);
      await uiYield(); // paint before the (blocking) WASM parse
      const buf = await file.arrayBuffer();
      const tP0 = performance.now();
      const res = await parseStep(buf);
      tParse += performance.now() - tP0;
      showLoadProgress(fileBase + PARSE_SHARE / list.length,
        `${fileTagLabel}analyzing ${res.meshes.length} bodies …`);
      await uiYield();
      state.result = res; // last file's result kept for legacy reasons
      totalRaw += res.meshes.length;

      // Z-to-floor: shift this file vertically so its lowest point sits at
      // z = 0. Models in a STEP file are often at arbitrary world heights;
      // anchoring them to the floor grid gives a consistent visual base.
      const zBbox = meshesAabbAxis(res.meshes, 2);
      if (zBbox && zBbox.min !== 0) {
        shiftMeshesAxis(res.meshes, 2, -zBbox.min);
      }

      // Auto-translate this file along +X so it sits to the right of any
      // previously-loaded files. We modify the OCCT positions in place
      // BEFORE analyzing/rendering so all downstream code (analysis,
      // viewer, arrows) sees the shifted coords naturally.
      const bbox = meshesAabbX(res.meshes);
      if (bbox) {
        const isFirstLoad = state.bodies.length === 0 && cumulativeRightX === 0;
        if (isFirstLoad) {
          // Leave the first file in its native origin.
          cumulativeRightX = bbox.max;
        } else {
          const dx = (cumulativeRightX + FILE_GAP) - bbox.min;
          if (dx !== 0) shiftMeshesX(res.meshes, dx);
          cumulativeRightX = bbox.max + dx;
        }
      }

      // Strip path/extension for display.
      const tag = file.name.replace(/\.(step|stp)$/i, '');
      // Use the next-color slot per body so each new file's colors continue.
      const colorBase = state.bodies.length;
      // Bodies list starts COLLAPSED at the file level — opens on a click.
      state.collapsedFiles.add(tag);

      let perFileValid = 0;
      for (let meshIdx = 0; meshIdx < res.meshes.length; meshIdx++) {
        const m = res.meshes[meshIdx];
        // Keep the bar moving and the page responsive: analyzeBody +
        // viewer mesh construction are synchronous and can take tens of
        // ms per body on dense tessellations.
        // Time-based, not count-based: each yield lets the browser paint —
        // which includes a full 3D frame of the growing scene — so yielding
        // every N bodies made load time scale with body count. ~8 fps of
        // progress is plenty.
        if (performance.now() - lastYieldMs > 120) {
          const inFile = PARSE_SHARE + (1 - PARSE_SHARE) * (meshIdx / res.meshes.length);
          showLoadProgress(fileBase + inFile / list.length,
            `${fileTagLabel}analyzing body ${meshIdx + 1}/${res.meshes.length} …`);
          const tY0 = performance.now();
          await uiYield();
          tYield += performance.now() - tY0;
          lastYieldMs = performance.now();
        }
        const indices = m.index?.array;
        if (!indices || indices.length < 3) continue;
        try {
          const tA0 = performance.now();
          const analysis = analyzeBody(m);
          tAnalyze += performance.now() - tA0;
          if (!analysis) {
            // Body isn't sheet-good shaped (round leg, dowel, block, …)
            // — still show it in 3D in red dashed so the user knows it
            // was imported but excluded from the cut list.
            viewer.addNonSheetMesh(m);
            totalSkippedNotSheet++;
            state.nonSheetCount++;
            continue;
          }
          const id = nextBodyId++;
          const baseName = m.name && m.name.trim() ? m.name : `Body ${meshIdx + 1}`;
          const displayName = list.length === 1 ? baseName : `${tag} / ${baseName}`;
          const hex = bodyColor(colorBase + perFileValid);
          state.bodies.push({
            id,
            name: displayName,
            fileTag: tag,
            analysis,
            qty: 1,
            grain: 'free',
            rotation: 'lock',
            selected: false,
            color: hex,
            material: null,
          });
          const tM0 = performance.now();
          viewer.addOcctMesh(m, id, hex, displayName);
          tMesh += performance.now() - tM0;
          perFileValid++;
          totalAdded++;
        } catch (e) {
          console.warn(`Failed to analyze body in ${file.name}:`, e);
        }
      }
    }

    viewer.finishLoad();
    console.log(
      `load: parse ${tParse.toFixed(0)}ms · analyze ${tAnalyze.toFixed(0)}ms · mesh ${tMesh.toFixed(0)}ms · yield ${tYield.toFixed(0)}ms · total ${(performance.now() - tLoad0).toFixed(0)}ms (${totalAdded} bodies)`,
    );
    // Auto-select all newly-loaded sheet-good bodies so the user can hit
    // "Estimate" immediately. Non-sheet bodies were already excluded.
    const tT0 = performance.now();
    for (const b of state.bodies) b.selected = true;
    syncViewerSelectionFromState();
    const tT1 = performance.now();
    pushAllGrainToViewer();
    const tT2 = performance.now();
    refreshWeakBodies();
    const tT3 = performance.now();
    renderBodyList();
    const tT4 = performance.now();
    updateNestBtn();
    console.log(
      `load tail: select ${(tT1 - tT0).toFixed(0)}ms · grain ${(tT2 - tT1).toFixed(0)}ms · weak ${(tT3 - tT2).toFixed(0)}ms · list ${(tT4 - tT3).toFixed(0)}ms`,
    );
    const dropped = totalRaw - totalAdded - totalSkippedNotSheet;
    const summary = list.length > 1
      ? `Loaded ${totalAdded} sheet-good bodies from ${list.length} files.`
      : `Loaded ${totalAdded} sheet-good bodies.`;
    const extras: string[] = [];
    if (totalSkippedNotSheet > 0) extras.push(`${totalSkippedNotSheet} non-sheet (round/block)`);
    if (dropped > 0) extras.push(`${dropped} empty/invalid`);
    setStatus(extras.length > 0 ? `${summary} (${extras.join(', ')} skipped)` : summary, 'ok');
  } catch (err: any) {
    console.error(err);
    setStatus(err.message || 'Failed to parse STEP file.', 'error');
  } finally {
    hideLoadProgress();
  }
}

function clearAll() {
  state.bodies = [];
  state.result = null;
  state.nonSheetCount = 0;
  state.partLabels = new Map();
  nextBodyId = 0;
  cumulativeRightX = 0;
  // Keep the user's mesh + display preferences across a Clear; only the model
  // (cabinet, joints, loads, results) resets.
  state.asm = {
    ...state.asm,
    cabinet: null, joints: [], loads: [], solveMsg: '', analysis: null,
    detected: false, lastSolve: null, preview: null,
  };
  viewer.clearAssemblyOverlay();
  viewer.clear();
  renderBodyList();
  updateNestBtn();
  setStatus('');
}

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('drag');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag');
  if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
});
pickFileBtn.addEventListener('click', () => fileInput.click());
// Warm the OCCT WASM (~1s script fetch + compile) shortly after startup so
// the first file open doesn't pay it inside the load path. Delayed so it
// never competes with first paint.
setTimeout(preloadOcct, 500);
fileInput.addEventListener('change', () => {
  if (fileInput.files?.length) handleFiles(fileInput.files);
  // Reset so picking the SAME file(s) again re-fires change.
  fileInput.value = '';
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  if (!(e.target as HTMLElement).closest('#dropzone')) {
    e.preventDefault();
    if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
  }
});

// --------------------------------------------------------------------------
// Body list rendering
// --------------------------------------------------------------------------
function renderBodyList() {
  // "15 sheet / 19 total" when some imports were skipped as non-sheet.
  bodyCount.textContent = state.nonSheetCount > 0
    ? `${state.bodies.length} sheet / ${state.bodies.length + state.nonSheetCount} total`
    : String(state.bodies.length);
  if (state.bodies.length === 0) {
    bodyList.innerHTML = '<div class="empty">No file loaded.</div>';
    renderAnalysisSection();
    return;
  }
  bodyList.innerHTML = '';

  // Group bodies by STEP file (fileTag). The map preserves insertion order so
  // files render in the order they were dropped.
  const byFile = new Map<string, BodyState[]>();
  for (const b of state.bodies) {
    const arr = byFile.get(b.fileTag) ?? [];
    arr.push(b);
    byFile.set(b.fileTag, arr);
  }

  for (const [tag, bodies] of byFile) {
    const group = document.createElement('div');
    group.className = 'file-group';

    const collapsed = state.collapsedFiles.has(tag);
    const selectedCount = bodies.filter((b) => b.selected).length;
    const allSelected = selectedCount === bodies.length;
    const noneSelected = selectedCount === 0;

    // --- File header ---
    const header = document.createElement('div');
    header.className = 'file-header';

    const chevron = document.createElement('button');
    chevron.type = 'button';
    chevron.className = 'file-chevron';
    chevron.setAttribute('aria-label', collapsed ? 'Expand' : 'Collapse');
    chevron.innerHTML = collapsed
      ? '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>'
      : '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
    chevron.addEventListener('click', () => {
      if (collapsed) state.collapsedFiles.delete(tag);
      else state.collapsedFiles.add(tag);
      renderBodyList();
    });
    header.appendChild(chevron);

    const fileCheck = document.createElement('input');
    fileCheck.type = 'checkbox';
    fileCheck.checked = allSelected;
    fileCheck.indeterminate = !allSelected && !noneSelected;
    fileCheck.title = allSelected ? 'Deselect all in this file' : 'Select all in this file';
    fileCheck.addEventListener('change', () => {
      const target = fileCheck.checked;
      for (const b of bodies) b.selected = target;
      syncViewerSelectionFromState();
      renderBodyList();
      updateNestBtn();
    });
    header.appendChild(fileCheck);

    const nameWrap = document.createElement('div');
    nameWrap.className = 'file-name-wrap';
    nameWrap.innerHTML = `
      <div class="file-name">${escapeHtml(tag)}</div>
      <div class="file-sub">${bodies.length} ${bodies.length === 1 ? 'body' : 'bodies'} · ${selectedCount} selected</div>
    `;
    nameWrap.addEventListener('click', () => {
      if (collapsed) state.collapsedFiles.delete(tag);
      else state.collapsedFiles.add(tag);
      renderBodyList();
    });
    header.appendChild(nameWrap);

    group.appendChild(header);

    // --- Body rows (only when expanded) ---
    if (!collapsed) {
      const rows = document.createElement('div');
      rows.className = 'file-bodies';
      for (const b of bodies) rows.appendChild(buildBodyRow(b));
      group.appendChild(rows);
    }

    bodyList.appendChild(group);
  }

  // Keep the Analysis section (cabinet list, joints, loads) in sync with the
  // current selection.
  renderAnalysisSection();
}

/** Render one body row (used inside each file group). Mostly the same UI as
 *  the previous flat list, but with cleaner detail formatting. */
function buildBodyRow(b: BodyState): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'body-row' + (b.selected ? ' selected' : '');

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = b.selected;
  checkbox.addEventListener('change', () => {
    b.selected = checkbox.checked;
    syncViewerSelectionFromState();
    renderBodyList();
    updateNestBtn();
  });
  row.appendChild(checkbox);

  const swatch = document.createElement('div');
  swatch.className = 'swatch';
  swatch.style.background = b.color;
  row.appendChild(swatch);

  const mid = document.createElement('div');
  mid.innerHTML = `
    <div class="body-name">${escapeHtml(b.name)}</div>
    <div class="body-meta">
      ${fmtDim(b.analysis.length, state.units)} × ${fmtDim(b.analysis.width, state.units)} ×
      <strong>${fmtDim(b.analysis.thickness, state.units)}</strong>
    </div>`;
  row.appendChild(mid);

  // Spacer to balance grid
  row.appendChild(document.createElement('span'));

  if (b.selected) {
    const extra = document.createElement('div');
    extra.className = 'body-extra';
    const matOptions = MATERIALS.map((m) =>
      `<option value="${m.id}" ${b.material === m.id ? 'selected' : ''}>${escapeHtml(m.name)}</option>`,
    ).join('');
    extra.innerHTML = `
      <label>Qty
        <input type="number" min="1" step="1" value="${b.qty}" data-field="qty" />
      </label>
      <label>Grain
        <select data-field="grain">
          <option value="free" ${b.grain === 'free' ? 'selected' : ''}>Any direction</option>
          <option value="length" ${b.grain === 'length' ? 'selected' : ''}>Along length</option>
          <option value="width" ${b.grain === 'width' ? 'selected' : ''}>Along width</option>
        </select>
      </label>
      <label>Rotation
        <select data-field="rotation">
          <option value="lock" ${b.rotation === 'lock' ? 'selected' : ''}>No rotation</option>
          <option value="flip90" ${b.rotation === 'flip90' ? 'selected' : ''}>Allow 90° flip</option>
        </select>
      </label>
      <label style="grid-column: 1 / -1">Material
        <select data-field="material">
          <option value="" ${b.material == null ? 'selected' : ''}>Job default</option>
          ${matOptions}
        </select>
      </label>`;
    extra.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-field]').forEach((el) => {
      el.addEventListener('change', () => {
        const field = el.dataset.field!;
        if (field === 'qty') b.qty = Math.max(1, parseInt((el as HTMLInputElement).value) || 1);
        if (field === 'grain') {
          b.grain = (el as HTMLSelectElement).value as GrainLock;
          pushGrainToViewer(b);
          refreshWeakBodies();
          renderBodyList();
        }
        if (field === 'rotation') b.rotation = (el as HTMLSelectElement).value as RotationMode;
        if (field === 'material') {
          const v = (el as HTMLSelectElement).value;
          b.material = v === '' ? null : v;
          refreshWeakBodies();
          renderBodyList();
        }
      });
    });
    row.appendChild(extra);

    // --- Screening / weight line (read-only; the interactive CAE now lives in
    //     the sidebar Analysis section, which works on the whole assembly). ---
    row.appendChild(buildCaeBlock(b));
  }
  return row;
}

/** Build the per-body structure line: panel weight + the formula-screening
 *  bending verdict under the default uniform load. Read-only — the interactive
 *  structural analysis is the whole-assembly Analysis section in the sidebar. */
function buildCaeBlock(b: BodyState): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'body-cae';

  const scr = bodyScreen(b);
  const kg = panelWeightKg(b.analysis.outline, b.analysis.thickness, bodyMaterial(b));
  const verdictLabel: Record<Verdict, string> = { ok: 'OK', borderline: 'borderline', weak: 'weak' };
  const line = document.createElement('div');
  line.className = 'cae-line';
  line.innerHTML = `
    <span class="cae-weight">${escapeHtml(fmtWeight(kg))}</span>
    <span class="cae-sep">·</span>
    <span class="cae-verdict cae-${scr.verdict}">sag ~${fmtSag(scr.sagMm, state.units)} over ${fmtDim(scr.span, state.units)} — ${verdictLabel[scr.verdict]}</span>`;
  wrap.appendChild(line);
  return wrap;
}

// --------------------------------------------------------------------------
// Assembly frame helpers (shared with the Analysis section)
// --------------------------------------------------------------------------
type Vec3 = [number, number, number];
const v3add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const v3scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];

/** The world corner where the part outline's (0,0) sits, plus the world axes
 *  that outline X (length) and outline Y (width) run along. Rectangular parts
 *  map exactly; skew parts are approximated by centring the bbox on the face
 *  centroid. */
function outlineFrame(b: BodyState): { origin: Vec3; uAxis: Vec3; vAxis: Vec3; normal: Vec3 } {
  const a = b.analysis;
  const uAxis = a.lengthDir as Vec3;
  const vAxis = a.widthDir as Vec3;
  const normal = a.faceNormal as Vec3;
  const w = a.outline.bbox.w;
  const h = a.outline.bbox.h;
  // faceCenter is the +face centroid; step back to the (0,0) corner.
  const origin = v3add(
    v3add(a.faceCenter as Vec3, v3scale(uAxis, -w / 2)),
    v3scale(vAxis, -h / 2),
  );
  return { origin, uAxis, vAxis, normal };
}

/**
 * The panel's MID-SURFACE frame — the reference plane a shell/solid FE model
 * has to be built on.
 *
 * `outlineFrame` returns the +FACE plane, which is what the UI wants (heatmap
 * overlays and load markers are painted ON the visible face). Handing that same
 * plane to the solver puts every panel's model half a thickness off its true
 * centre, so a butt joint's edge-to-face distance comes out anywhere from 0 to
 * a full thickness depending on which way each panel's face normal happens to
 * point — and contacts get missed. It also puts a solid extrusion half outside
 * the part.
 */
function panelMidFrame(b: BodyState): { origin: Vec3; uAxis: Vec3; vAxis: Vec3; normal: Vec3 } {
  const f = outlineFrame(b);
  return { ...f, origin: v3add(f.origin, v3scale(f.normal, -b.analysis.thickness / 2)) };
}

function forceToN(val: number, unit: 'N' | 'kg' | 'lbf'): number {
  if (unit === 'kg') return val * 9.80665;
  if (unit === 'lbf') return val * 4.4482216;
  return val;
}

/** Build a CanvasTexture of one panel's result field for the overlay. `field`
 *  selects deflection or von-Mises stress; `denom` is the WHOLE-ASSEMBLY max of
 *  that field so every panel shares one colour scale (a global fringe plot). */
function buildAsmHeatTexture(
  pr: AsmPanelResult, denom: number, field: 'deflection' | 'stress',
): THREE.CanvasTexture {
  const { nx, ny, active } = pr;
  const data = field === 'stress' ? pr.vm : pr.disp;
  const canvas = document.createElement('canvas');
  canvas.width = nx;
  canvas.height = ny;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(nx, ny);
  const d = denom || 1;
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const n = iy * nx + ix;
      // Flip Y so texture V matches outline +Y (canvas is top-down).
      const dst = ((ny - 1 - iy) * nx + ix) * 4;
      if (!active[n] || Number.isNaN(data[n])) {
        img.data[dst + 3] = 0; // transparent outside the part
        continue;
      }
      const [r, g, bl] = heatColor(Math.abs(data[n]) / d);
      img.data[dst] = r;
      img.data[dst + 1] = g;
      img.data[dst + 2] = bl;
      img.data[dst + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

/** Project a world click point onto the outline frame → clamped (ox, oy) mm. */
function worldToOutline(b: BodyState, point: [number, number, number]): { x: number; y: number } {
  const f = outlineFrame(b);
  const rel: Vec3 = [point[0] - f.origin[0], point[1] - f.origin[1], point[2] - f.origin[2]];
  const ox = rel[0] * f.uAxis[0] + rel[1] * f.uAxis[1] + rel[2] * f.uAxis[2];
  const oy = rel[0] * f.vAxis[0] + rel[1] * f.vAxis[1] + rel[2] * f.vAxis[2];
  return {
    x: Math.max(0, Math.min(b.analysis.outline.bbox.w, ox)),
    y: Math.max(0, Math.min(b.analysis.outline.bbox.h, oy)),
  };
}

/** Map an outline (ox, oy) point back to world coords on the +face. */
function outlineToWorld(b: BodyState, ox: number, oy: number): Vec3 {
  const f = outlineFrame(b);
  return v3add(v3add(f.origin, v3scale(f.uAxis, ox)), v3scale(f.vAxis, oy));
}

/** Default footprint size (mm) for a fresh load ≈ 40mm. */
const DEFAULT_FOOTPRINT_MM = 40;

// ==========================================================================
// ASSEMBLY ANALYSIS — the sidebar "Analysis" section. Analyses the whole
// cabinet (all selected bodies of one STEP file) as a coupled shell.
// ==========================================================================
const asmCabinetSelect = $<HTMLSelectElement>('asmCabinet');
const asmDetectBtn = $<HTMLButtonElement>('asmDetectBtn');
const asmTolInput = $<HTMLInputElement>('asmTol');
const asmJointsList = $('asmJointsList');
const asmJointsToggle = $<HTMLButtonElement>('asmJointsToggle');
const asmJointsSetAll = $<HTMLSelectElement>('asmJointsSetAll');
const asmJointsSummary = $('asmJointsSummary');
const asmJointCount = $('asmJointCount');
const asmTiles = $('asmTiles');

asmJointsToggle.addEventListener('click', () => {
  state.asm.jointsOpen = !state.asm.jointsOpen;
  renderAnalysisSection();
});
asmJointsSetAll.addEventListener('change', () => {
  const v = asmJointsSetAll.value as JointStiffness | '';
  asmJointsSetAll.value = '';
  if (!v) return;
  for (const j of state.asm.joints) j.stiffness = v;
  // Joint stiffness is part of the model, so a cached solve no longer applies.
  state.asm.lastSolve = null;
  state.asm.analysis = null;
  paintAssemblyPreview();
  renderAnalysisSection();
});
const asmLoadsList = $('asmLoadsList');
const asmAddLoadBtn = $<HTMLButtonElement>('asmAddLoad');
const asmPreset50 = $<HTMLButtonElement>('asmPreset50');
const asmPresetShelf = $<HTMLButtonElement>('asmPresetShelf');
const asmPresetClear = $<HTMLButtonElement>('asmPresetClear');
const asmSolveBtn = $<HTMLButtonElement>('asmSolveBtn');
const asmClearBtn = $<HTMLButtonElement>('asmClearBtn');
const asmExportBtn = $<HTMLButtonElement>('asmExportBtn');
const asmResult = $('asmResult');
const asmFieldToggle = $('asmFieldToggle');
const asmFieldDefl = $<HTMLButtonElement>('asmFieldDefl');
const asmFieldStress = $<HTMLButtonElement>('asmFieldStress');
const asmMeshKind = $<HTMLSelectElement>('asmMeshKind');
const asmMeshDensity = $<HTMLSelectElement>('asmMeshDensity');
const asmSolidLayers = $<HTMLSelectElement>('asmSolidLayers');
const asmSolidLayersRow = $('asmSolidLayersRow');
const asmMeshStats = $('asmMeshStats');
const asmDeformRow = $('asmDeformRow');
const asmDeformScale = $<HTMLSelectElement>('asmDeformScale');

/** The floating CAE legend over the 3D viewer. Editing it repaints the contour
 *  — the legend and the geometry share one LegendSpec. */
const caeLegend = mountCaeLegend($('viewerWrap'), (spec) => {
  state.asm.legend = spec;
  paintCaeMesh();
  renderCaeLegend();
});
const asmShowMesh = $<HTMLInputElement>('asmShowMesh');
const asmShowNodes = $<HTMLInputElement>('asmShowNodes');
const asmShowSupports = $<HTMLInputElement>('asmShowSupports');
const asmShowCouplings = $<HTMLInputElement>('asmShowCouplings');
const asmShowLoads = $<HTMLInputElement>('asmShowLoads');

/**
 * The solve options for the Analysis section's current cabinet — the single
 * place the model is assembled from UI state. Both the mesh preview and the
 * solve go through here so they can never disagree about the model.
 */
function currentAsmOptions(): { opts: AsmSolveOptions; panels: BodyState[] } | null {
  const panels = cabinetPanels();
  if (panels.length < 1) return null;
  const byId = new Map(panels.map((b) => [b.id, b] as const));
  const asmPanels = panels.map(asmPanelForBody);

  const joints: AsmJoint[] = state.asm.joints
    .filter((j) => byId.has(j.a) && byId.has(j.b))
    .map((j) => ({ a: j.a, b: j.b, p0: j.p0, p1: j.p1, length: j.length, stiffness: j.stiffness }));

  const loads: AsmLoad[] = state.asm.loads
    .filter((l) => l.val > 0 && l.panelId != null && byId.has(l.panelId))
    .map((l) => {
      const b = byId.get(l.panelId!)!;
      const pt = l.pt ?? { x: b.analysis.outline.bbox.w / 2, y: b.analysis.outline.bbox.h / 2 };
      const magN = forceToN(l.val, l.unit);
      return { panelId: l.panelId!, x: pt.x, y: pt.y, N: l.down ? magN : -magN, shape: l.shape, size: l.sizeMm };
    });

  return {
    opts: {
      panels: asmPanels, joints, loads, tolMm: state.asm.tolMm,
      elementSizeMm: state.asm.elementSizeMm,
      // Only a safety ceiling now — the element size sets the density, and the
      // mesher coarsens off it only when a job would blow past what the direct
      // factorization can carry.
      maxDof: asmMaxDof(),
      meshKind: state.asm.meshKind,
      solidLayers: state.asm.solidLayers,
    },
    panels,
  };
}

/**
 * Safety ceiling handed to the mesher, expressed in the mesher's own currency
 * (shell nodes × 6). The element size sets the density; this only stops a
 * 5 mm mesh on a whole kitchen from producing a system the direct
 * factorization can't carry.
 *
 * Solid gets a much lower ceiling than shell: a hex couples 8 nodes over 24
 * DOF (vs a quad's 4 × 6), so both the assembly scatter and the factorization
 * fill grow far faster per DOF — 60k solid DOF costs about the same wall-clock
 * as 150k shell DOF.
 */
// Measured on the workbench sample (14 panels, ~2.4 m top), Eigen LDLT in
// WASM: 58k DOF ≈ 0.3 s to factor, 117k ≈ 6.6 s. Fill grows steeply, so these
// ceilings sit where a solve is still worth waiting through. A finer element
// size than the ceiling allows is honoured as far as it goes and the stats line
// says it was capped — silently meshing at 20 mm when 5 mm was picked would be
// worse than the wait.
const CAE_DOF_CEILING = { shell: 200_000, solid: 90_000 } as const;

function asmMaxDof(): number {
  const solid = state.asm.meshKind === 'solid';
  const dofPerShellNode = solid ? 3 * (state.asm.solidLayers + 1) : 6;
  const shellNodes = CAE_DOF_CEILING[solid ? 'solid' : 'shell'] / dofPerShellNode;
  return Math.ceil(shellNodes * 6);
}

/** A mesh setting changed: the cached solve belongs to a mesh that no longer
 *  exists, so drop it, rebuild the preview and repaint. */
function onMeshSettingsChanged() {
  state.asm.lastSolve = null;
  state.asm.analysis = null;
  if (state.asm.detected) {
    buildCaePreview();
    state.asm.solveMsg = state.asm.preview
      ? `Mesh rebuilt — ${state.asm.preview.resolutionLog}. Solve to get results.`
      : state.asm.solveMsg;
  }
  paintCaeVisuals();
  renderAnalysisSection();
}

asmMeshKind.addEventListener('change', () => {
  state.asm.meshKind = asmMeshKind.value === 'solid' ? 'solid' : 'shell';
  asmSolidLayersRow.hidden = state.asm.meshKind !== 'solid';
  onMeshSettingsChanged();
});
asmMeshDensity.addEventListener('change', () => {
  state.asm.elementSizeMm = Number(asmMeshDensity.value) || 30;
  onMeshSettingsChanged();
});
asmSolidLayers.addEventListener('change', () => {
  state.asm.solidLayers = Number(asmSolidLayers.value) || 2;
  onMeshSettingsChanged();
});
asmDeformScale.addEventListener('change', () => {
  state.asm.deformScale = asmDeformScale.value === 'auto' ? 'auto' : Number(asmDeformScale.value);
  paintCaeVisuals();
});

const bindShow = (el: HTMLInputElement, key: keyof typeof state.asm.show) => {
  el.addEventListener('change', () => {
    state.asm.show[key] = el.checked;
    paintCaeVisuals();
  });
};
bindShow(asmShowMesh, 'mesh');
bindShow(asmShowNodes, 'nodes');
bindShow(asmShowSupports, 'supports');
bindShow(asmShowCouplings, 'couplings');
bindShow(asmShowLoads, 'loads');

/** Switch the heatmap field (Deflection/Stress). Re-textures from the cached
 *  solve — no re-solve. Updates the result line's leading emphasis too. */
function setAsmField(field: 'deflection' | 'stress') {
  if (state.asm.field === field) return;
  state.asm.field = field;
  paintCaeVisuals();
  renderAnalysisSection();
}
asmFieldDefl.addEventListener('click', () => setAsmField('deflection'));
asmFieldStress.addEventListener('click', () => setAsmField('stress'));

/** Distinct cabinet tags that currently have ≥1 selected sheet body. */
function analysisCabinets(): string[] {
  const seen: string[] = [];
  for (const b of state.bodies) {
    if (b.selected && !seen.includes(b.fileTag)) seen.push(b.fileTag);
  }
  return seen;
}

/** The selected bodies of the Analysis section's current cabinet. */
function cabinetPanels(): BodyState[] {
  const cab = state.asm.cabinet;
  return state.bodies.filter((b) => b.selected && b.fileTag === cab);
}

/** Short label for a body within its cabinet: index-letter ("1a", "1e"). The
 *  leading number is the cabinet's 1-based position; the letter walks a..z by
 *  the body's order within the cabinet. */
function panelLabel(b: BodyState): string {
  const cabs = Array.from(new Set(state.bodies.map((x) => x.fileTag)));
  const cabNo = Math.max(1, cabs.indexOf(b.fileTag) + 1);
  const within = state.bodies.filter((x) => x.fileTag === b.fileTag);
  const idx = within.indexOf(b);
  const letter = idx < 26 ? String.fromCharCode(97 + idx) : `z${idx - 25}`;
  return `${cabNo}${letter}`;
}

/** Build a solver AsmPanel from a body using its world outline frame. */
function asmPanelForBody(b: BodyState): AsmPanel {
  const f = panelMidFrame(b);
  return {
    id: b.id,
    label: panelLabel(b),
    outline: b.analysis.outline,
    thicknessMm: b.analysis.thickness,
    material: bodyMaterial(b),
    grainAlongLength: b.grain !== 'width',
    origin: f.origin,
    uAxis: f.uAxis,
    vAxis: f.vAxis,
    normal: f.normal,
  };
}

/** Keep state.asm.cabinet valid; default to the first cabinet with a body. */
function ensureAsmCabinet() {
  const cabs = analysisCabinets();
  if (cabs.length === 0) { state.asm.cabinet = null; return; }
  if (!state.asm.cabinet || !cabs.includes(state.asm.cabinet)) {
    state.asm.cabinet = cabs[0];
    // A cabinet switch invalidates joints/result but keeps loads placed on
    // still-present panels.
    state.asm.joints = [];
    state.asm.detected = false;
  }
}

/** Detect joints for the current cabinet and populate the list. */
function detectAssemblyJoints() {
  // First analysis action — bring the PyNite sidecar up in the background so
  // it's listening by the time Solve asks for it. Detection itself is pure
  // local geometry and must not wait on the spawn.
  void launchSidecar();
  ensureAsmCabinet();
  const panels = cabinetPanels();
  if (panels.length < 2) {
    state.asm.joints = [];
    state.asm.detected = true;
    state.asm.solveMsg = 'Select at least two panels of the cabinet to detect joints.';
    renderAnalysisSection();
    return;
  }
  const asmPanels = panels.map(asmPanelForBody);
  const byId = new Map(panels.map((b) => [b.id, b] as const));
  const raw = detectJoints(asmPanels, state.asm.tolMm);
  state.asm.joints = raw.map((j) => ({
    a: j.a, b: j.b,
    labelA: panelLabel(byId.get(j.a)!),
    labelB: panelLabel(byId.get(j.b)!),
    p0: j.p0, p1: j.p1, length: j.length, stiffness: j.stiffness,
  }));
  state.asm.detected = true;
  state.asm.solveMsg = state.asm.joints.length
    ? `${state.asm.joints.length} joint${state.asm.joints.length === 1 ? '' : 's'} detected — set stiffness, add loads, then Solve.`
    : 'No touching panel edges found. Raise the join tolerance if panels should be joined.';
  // Clear a stale solved overlay/result — joints changed.
  state.asm.analysis = null;
  state.asm.lastSolve = null;
  viewer.clearAssemblyOverlay();
  paintAssemblyPreview();
  renderAnalysisSection();
}

/**
 * Redraw everything the Analysis mode shows in 3D for the current (unsolved or
 * solved) state: the FE mesh, the solver's real boundary conditions, and the
 * load-placement markers.
 *
 * The supports drawn here are the nodes the solver GROUNDS — read back out of
 * the preprocessed model — not an estimate from panel corners. When the model
 * isn't meshable yet we fall back to the app-level joint segments so the joints
 * list still has something to point at.
 */
function paintAssemblyPreview() {
  const built = state.asm.detected ? buildCaePreview() : false;
  if (built) {
    // The node-pair couplings supersede the app-level joint segments (same
    // joints, drawn where the solver actually couples them), and the grounded
    // nodes supersede the corner-derived floor chevrons.
    viewer.clearAssemblyJoints();
    viewer.clearFloorGlyphs();
  } else {
    state.asm.preview = null;
    viewer.showAssemblyJoints(state.asm.joints.map((j) => ({
      p0: j.p0, p1: j.p1, stiffness: j.stiffness,
    })));
    viewer.clearFloorGlyphs();
  }
  paintCaeVisuals();
  repaintAsmLoadMarkers();
}

/**
 * A load changed. The constraint view's nodal force vectors are derived from
 * the loads by the preprocessor, so they have to be rebuilt — and any cached
 * solve now belongs to a different load case, so it's dropped rather than left
 * on screen looking current.
 */
function onAsmLoadsChanged() {
  state.asm.lastSolve = null;
  state.asm.analysis = null;
  paintAssemblyPreview();
}

/** Redraw every assembly load marker (reuses the per-body load marker API). */
function repaintAsmLoadMarkers() {
  // Clear markers for every cabinet body, then repaint placed loads.
  for (const b of cabinetPanels()) viewer.clearLoadMarkers(b.id);
  const grouped = new Map<number, CaeLoad[]>();
  for (const ld of state.asm.loads) {
    if (ld.panelId == null) continue;
    const arr = grouped.get(ld.panelId) ?? [];
    arr.push(ld);
    grouped.set(ld.panelId, arr);
  }
  for (const [pid, lds] of grouped) {
    const b = state.bodies.find((x) => x.id === pid);
    if (!b) continue;
    const f = outlineFrame(b);
    const arrowLen = Math.max(30, Math.min(b.analysis.length, b.analysis.width) * 0.35);
    lds.forEach((ld, i) => {
      const pt = ld.pt ?? { x: b.analysis.outline.bbox.w / 2, y: b.analysis.outline.bbox.h / 2 };
      const world = outlineToWorld(b, pt.x, pt.y);
      viewer.showLoadMarker(b.id, i, world, f.normal, arrowLen,
        { shape: ld.shape, size: ld.sizeMm, uAxis: f.uAxis, vAxis: f.vAxis }, ld.down);
    });
  }
}

/** A fresh load for the Analysis section: 25 kg down, round, unplaced. */
function newAsmLoad(): CaeLoad {
  return { val: 25, unit: 'kg', panelId: null, pt: null, shape: 'round', sizeMm: DEFAULT_FOOTPRINT_MM, down: true };
}

/** Preset: N kg spread evenly as one downward load on the highest panel
 *  ("on top"). Populates the editable loads list. */
function presetOnTop(totalKg: number) {
  const panels = cabinetPanels();
  if (panels.length === 0) return;
  // Highest panel = the one whose face centre has the max world z.
  let top = panels[0], topZ = -Infinity;
  for (const b of panels) {
    const z = b.analysis.faceCenter[2];
    if (z > topZ) { topZ = z; top = b; }
  }
  const l: CaeLoad = {
    val: totalKg, unit: 'kg', panelId: top.id,
    pt: { x: top.analysis.outline.bbox.w / 2, y: top.analysis.outline.bbox.h / 2 },
    shape: 'square', sizeMm: Math.min(top.analysis.length, top.analysis.width) * 0.6, down: true,
  };
  state.asm.loads.push(l);
}

/** Preset: kgPerShelf on every horizontal panel that isn't the top or a
 *  vertical side (a shelf ≈ face normal near ±Z, not the very top). */
function presetPerShelf(kgPerShelf: number) {
  const panels = cabinetPanels();
  const shelves = panels.filter((b) => Math.abs(b.analysis.faceNormal[2]) > 0.7);
  // Drop the single highest (that's the "top", loaded separately if wanted).
  shelves.sort((a, b) => a.analysis.faceCenter[2] - b.analysis.faceCenter[2]);
  const targets = shelves.length > 1 ? shelves.slice(0, shelves.length - 1) : shelves;
  for (const b of targets) {
    state.asm.loads.push({
      val: kgPerShelf, unit: 'kg', panelId: b.id,
      pt: { x: b.analysis.outline.bbox.w / 2, y: b.analysis.outline.bbox.h / 2 },
      shape: 'square', sizeMm: Math.min(b.analysis.length, b.analysis.width) * 0.6, down: true,
    });
  }
}

/** Stage labels for the Solve progress bar. The framing (deliberately) mirrors
 *  the pipeline: preprocessing = our TS, the SOLVE = the WASM core, post =
 *  browser/our TS. `detail` carries the real DOF count / backend / iteration. */
const SOLVE_STAGE_LABEL: Record<SolveProgress['stage'], string> = {
  meshing: 'Meshing panels…',
  assembling: 'Assembling…',
  factorizing: 'Factorizing…',
  solving: 'Solving…',
  recovering: 'Recovering stresses…',
  done: 'Rendering…',
};

/** Run the assembly solve, paint the whole-cabinet heatmap, capture the PDF.
 *  `onStage` (optional) receives staged progress for the Solve button bar. */
async function solveAssemblyForCabinet(
  onStage?: (label: string, pct: number) => void | Promise<void>,
) {
  const stage = onStage ?? (() => {});
  ensureAsmCabinet();
  const panels = cabinetPanels();
  if (panels.length < 1) {
    state.asm.solveMsg = 'No panels selected for this cabinet.';
    renderAnalysisSection();
    return;
  }
  if (!state.asm.detected) {
    state.asm.solveMsg = 'Detect joints first.';
    renderAnalysisSection();
    return;
  }
  const cur = currentAsmOptions();
  if (!cur) {
    state.asm.solveMsg = 'No panels selected for this cabinet.';
    renderAnalysisSection();
    return;
  }
  const asmPanels = cur.opts.panels;
  const loads = cur.opts.loads;
  const byId = new Map(panels.map((b) => [b.id, b] as const));

  if (loads.length === 0) {
    state.asm.solveMsg = 'No load — add a load or apply a preset first.';
    renderAnalysisSection();
    return;
  }

  // Detect the PRIMARY assembly backend: the local PyNite sidecar (once per
  // session, short timeout). When present it solves the SAME serialized model
  // and we recover on OUR B-matrices. Fall back to Eigen LDLT (wasm) → PCG.
  await stage('Loading solver…', 3);
  await yieldFrame();
  const [pynite, backend] = await Promise.all([getPyniteBackend(), getDirectSolver()]);

  // Buffer the latest progress stage from the (synchronous) solve so the button
  // bar can be painted around it. Because solveAssembly runs synchronously, we
  // paint the pre-solve stages with real yields BEFORE the heavy call, let the
  // solve emit its own stage sequence (captured here), then paint the last
  // stage + recovering/rendering with yields AFTER. Fast systems still show the
  // full staged sequence.
  let sawSolving = false;
  const onProgress = (p: SolveProgress) => {
    if (p.stage === 'solving' || p.stage === 'factorizing') sawSolving = true;
  };

  // Pre-solve stages (these paint because we yield between them).
  await stage(SOLVE_STAGE_LABEL.meshing, 10);
  await yieldFrame();
  await stage(SOLVE_STAGE_LABEL.assembling, 25);
  await yieldFrame();

  const solveOpts = cur.opts;
  let res: ReturnType<typeof solveAssembly> | null = null;

  // --- PRIMARY: PyNite local sidecar. Serialize → POST → map displacements
  //     back → run the existing recovery/verdicts. Any failure falls through
  //     to the WASM/PCG path so a result is always produced. ---
  if (pynite) {
    await stage('Solving (PyNite local)…', 55);
    await yieldFrame();
    // PyNite's pure-Python sparse assembly is O(nodes) and slow for dense
    // cabinet meshes, so serialize it at a COARSER density (it's the isotropic-
    // E_eff approximation backend — a coarser grid is consistent with its
    // looser fidelity and keeps the local solve interactive). The recovery runs
    // on this SAME coarse mesh, so displacement→stress stays self-consistent.
    const ser = serializeAssembly({ ...solveOpts, targetNodesPerPanel: 140, maxDof: 18000 });
    if (ser.ok) {
      const sol = await pynite.solve(ser.model);
      if (sol && sol.disp.length === ser.pre.nDof) {
        const pyRes = recoverAssembly(ser.pre, sol.disp, asmPanels, 'PyNite (isotropic E_eff)', sol.buildMs, sol.solveMs);
        if (pyRes.ok) {
          sawSolving = true;
          res = pyRes;
        } else {
          console.warn('[assembly] PyNite recovery rejected the result — falling back to WASM/PCG.', pyRes.message);
        }
      } else {
        console.warn('[assembly] PyNite sidecar solve failed or size mismatch — falling back to WASM/PCG.');
      }
    } else {
      console.warn('[assembly] PyNite serialize refused:', ser.message, '— falling back.');
    }
  }

  // --- FALLBACK: the in-process Eigen LDLT (wasm) → PCG solve. ---
  if (!res || !res.ok) {
    await stage(backend ? SOLVE_STAGE_LABEL.factorizing : SOLVE_STAGE_LABEL.solving, backend ? 55 : 60);
    await yieldFrame();
    res = solveAssembly({ ...solveOpts, backend, onProgress });
  }
  void sawSolving;
  console.log(
    '[assembly]', res.resolutionLog, '→',
    res.ok
      ? `${res.backend} · ${res.iterations} it · factor ${res.factorMs.toFixed(1)}ms · solve ${res.solveMs.toFixed(1)}ms`
      : res.message,
  );

  await stage(SOLVE_STAGE_LABEL.recovering, 92);
  await yieldFrame();

  if (!res.ok) {
    viewer.clearAssemblyOverlay();
    viewer.clearDeflectionOverlay(-1); // no-op safety
    for (const b of panels) viewer.clearDeflectionOverlay(b.id);
    state.asm.analysis = null;
    state.asm.lastSolve = null;
    state.asm.solveMsg = res.message ?? 'Solve failed.';
    renderAnalysisSection();
    return;
  }

  // Cache the result so the Deflection/Stress field toggle can re-texture the
  // overlays without re-solving, then paint the current field.
  state.asm.lastSolve = { res, panelIds: panels.map((b) => b.id), meshKey: meshSettingsKey() };
  paintAssemblyPreview();

  const maxBody = byId.get(res.maxPanelId);
  const maxLabel = maxBody ? panelLabel(maxBody) : '?';
  const vmBody = byId.get(res.maxVmPanelId);
  const vmLabel = vmBody ? panelLabel(vmBody) : '?';
  state.asm.solveMsg = assemblyResultLine(res, maxLabel, vmLabel);

  await stage(SOLVE_STAGE_LABEL.done, 98);
  await captureAssemblyAnalysis(res, panels, maxLabel, vmLabel);
  renderAnalysisSection();
}

/** Combined deflection + stress result line, verdict = worst of the two. Also
 *  names the linear backend + its timing so the user sees whether the fast
 *  Eigen LDLT (wasm) core ran or the PCG fallback did. */
function assemblyResultLine(
  res: ReturnType<typeof solveAssembly>, maxLabel: string, vmLabel: string,
): string {
  const rank: Record<string, number> = { ok: 0, borderline: 1, weak: 2 };
  const worst = rank[res.verdict] >= rank[res.stressVerdict] ? res.verdict : res.stressVerdict;
  const limit = res.spanMm / 200;
  const timing = res.backend === 'PyNite (isotropic E_eff)'
    ? `${res.backend}: build ${res.factorMs.toFixed(0)} ms + solve ${res.solveMs.toFixed(0)} ms`
    : res.backend === 'Eigen LDLT (wasm)'
      ? `${res.backend}: factor ${res.factorMs.toFixed(0)} ms + solve ${res.solveMs.toFixed(0)} ms`
      : `${res.backend}: ${res.iterations} iters, ${res.solveMs.toFixed(0)} ms`;
  return (
    `Max deflection ${fmtSag(res.maxDisp, state.units)} on ${maxLabel} ` +
    `(vs span/200 ${fmtSag(limit, state.units)}). ` +
    `Max stress ${res.maxVm.toFixed(res.maxVm < 10 ? 1 : 0)} MPa on ${vmLabel} ` +
    `(util ${Math.round(res.utilPct)}%). ` +
    `${worst.toUpperCase()} · ${timing}`
  );
}

/** Verdict class (cae-ok/borderline/weak) = worst of deflection + stress. */
function assemblyWorstVerdict(res: ReturnType<typeof solveAssembly>): 'ok' | 'borderline' | 'weak' {
  const rank: Record<string, number> = { ok: 0, borderline: 1, weak: 2 };
  return rank[res.verdict] >= rank[res.stressVerdict] ? res.verdict : res.stressVerdict;
}

/** Paint the cached solve's chosen field onto every cabinet panel overlay. One
 *  shared colour scale (the field's whole-assembly max). No re-solve. */
function paintAsmField(field: 'deflection' | 'stress') {
  const cached = state.asm.lastSolve;
  if (!cached || !cached.res.ok) return;
  const { res } = cached;
  const denom = field === 'stress' ? res.maxVm : res.maxDisp;
  const prById = new Map(res.panels.map((p) => [p.id, p] as const));
  for (const id of cached.panelIds) {
    const b = state.bodies.find((x) => x.id === id);
    const pr = prById.get(id);
    viewer.clearDeflectionOverlay(id);
    if (!b || !pr) continue;
    const tex = buildAsmHeatTexture(pr, denom, field);
    const f = outlineFrame(b);
    viewer.showDeflectionOverlay(id, tex, {
      origin: f.origin, uAxis: f.uAxis, vAxis: f.vAxis, normal: f.normal,
      w: b.analysis.outline.bbox.w, h: b.analysis.outline.bbox.h, thickness: b.analysis.thickness,
    });
  }
}

// --------------------------------------------------------------------------
// MESH + CONSTRAINT VIEW
//
// `previewAssembly` runs the SAME preprocessing the solve runs, so what is
// drawn here — element grid, grounded nodes, joint couplings, nodal force
// vectors — is the model the solver will actually see, not an illustration of
// it. Changing any mesh setting invalidates a cached solve, because the result
// no longer belongs to the mesh on screen.
// --------------------------------------------------------------------------

/** Every mesh-affecting setting, as a comparison key. */
function meshSettingsKey(): string {
  const s = state.asm;
  return `${s.meshKind}:${s.elementSizeMm}:${s.solidLayers}`;
}

/** Build (or rebuild) the un-solved mesh + constraint preview. Cheap enough to
 *  run on any model edit; returns false when the model isn't solvable yet. */
function buildCaePreview(): boolean {
  const cur = currentAsmOptions();
  if (!cur) { state.asm.preview = null; return false; }
  const pv = previewAssembly(cur.opts);
  if (!pv.ok) {
    state.asm.preview = null;
    state.asm.solveMsg = pv.message;
    return false;
  }
  state.asm.preview = { mesh: pv.mesh, constraints: pv.constraints, resolutionLog: pv.resolutionLog };
  return true;
}

/** Resolve the deformed-shape exaggeration. 'auto' scales the peak deflection
 *  to ~6% of the model diagonal, which reads clearly at any zoom. */
function resolveDeformScale(maxDisp: number): number {
  const s = state.asm.deformScale;
  if (s === 0) return 0;
  if (typeof s === 'number') return s;
  if (!(maxDisp > 0)) return 0;
  const diag = viewer.modelDiagonal() || 1000;
  return (diag * 0.06) / maxDisp;
}

/** True when the cached solve was produced from the mesh currently on screen. */
function solveMatchesMesh(): boolean {
  const ls = state.asm.lastSolve;
  return !!ls && ls.res.ok && !!ls.res.mesh && ls.meshKey === meshSettingsKey();
}

/**
 * The per-node field currently being contoured, with its true extent.
 *
 * `scale` converts the field's storage unit into the unit the legend LABELS
 * are in (deflection is stored in mm but shown in inches when the job is
 * imperial; stress is MPa either way). The legend's manual min/max are
 * therefore in DISPLAY units, and `caeContourRange` divides back out — without
 * that, typing a manual range on an inch job would clip the contour at 1/25th
 * of the value the user asked for.
 */
function currentCaeField():
  | { field: Float32Array; min: number; max: number; scale: number }
  | null {
  if (!solveMatchesMesh()) return null;
  const res = state.asm.lastSolve!.res;
  const stress = state.asm.field === 'stress';
  const field = stress ? res.nodeVm : res.nodeDispMag;
  if (!field || field.length === 0) return null;
  const { min, max } = fieldExtent(field);
  const scale = stress ? 1 : fromMm(1, state.units);
  return { field, min, max, scale };
}

/** The contour's low/high bounds in the FIELD's own storage unit. */
function caeContourRange(fld: { min: number; max: number; scale: number }): { lo: number; hi: number } {
  const r = resolveLegendRange(state.asm.legend, fld.min * fld.scale, fld.max * fld.scale);
  return { lo: r.lo / fld.scale, hi: r.hi / fld.scale };
}

/** Draw the FE mesh — contoured + deformed when a matching solve is cached,
 *  plain gray otherwise. */
function paintCaeMesh() {
  const st = state.asm;
  const solved = solveMatchesMesh() ? st.lastSolve!.res : null;
  const mesh = solved?.mesh ?? st.preview?.mesh ?? null;
  if (!st.show.mesh || !mesh) {
    viewer.clearCaeMesh();
    viewer.setCaeMeshFocus(false);
    return;
  }
  const fld = currentCaeField();
  // The contour spans exactly what the legend says it spans.
  const range = fld ? caeContourRange(fld) : null;
  viewer.setCaeMeshFocus(true);
  viewer.showCaeMesh(mesh, {
    faces: true,
    edges: true,
    points: st.show.nodes,
    field: fld?.field ?? null,
    fieldMin: range?.lo ?? 0,
    fieldMax: range?.hi ?? 0,
    legend: st.legend,
    disp: solved?.nodeDisp ?? null,
    dispScale: solved ? resolveDeformScale(solved.maxDisp) : 0,
    opacity: 1,
  });
}

/**
 * MAX / MIN callouts on the contoured mesh.
 *
 * The extreme node is found on the FIELD ITSELF rather than taken from the
 * result summary, so the marker lands on the exact node the colour scale peaks
 * at — including on the solid mesh, where the summary's location is the
 * collapsed mid-surface grid point and not a solid node. The marker sits on the
 * DEFORMED position so it stays on the geometry when the shape is exaggerated.
 */
function paintCaeCallouts() {
  const st = state.asm;
  const solved = solveMatchesMesh() ? st.lastSolve!.res : null;
  const fld = currentCaeField();
  if (!solved || !fld || !st.show.mesh || !solved.mesh) { viewer.clearCaeCallouts(); return; }

  const mesh = solved.mesh;
  let iMax = -1, iMin = -1;
  let vMax = -Infinity, vMin = Infinity;
  for (let i = 0; i < mesh.nodeCount && i < fld.field.length; i++) {
    const v = fld.field[i];
    if (!Number.isFinite(v)) continue;
    if (v > vMax) { vMax = v; iMax = i; }
    if (v < vMin) { vMin = v; iMin = i; }
  }
  if (iMax < 0) { viewer.clearCaeCallouts(); return; }

  const scale = resolveDeformScale(solved.maxDisp);
  const at = (i: number): [number, number, number] => [
    mesh.nodes[i * 3] + (solved.nodeDisp[i * 3] ?? 0) * scale,
    mesh.nodes[i * 3 + 1] + (solved.nodeDisp[i * 3 + 1] ?? 0) * scale,
    mesh.nodes[i * 3 + 2] + (solved.nodeDisp[i * 3 + 2] ?? 0) * scale,
  ];

  const stress = state.asm.field === 'stress';
  const unit = stress ? 'MPa' : (state.units === 'in' ? 'in' : 'mm');
  const fmt = (v: number) => `${formatLegendValue(v * fld.scale, st.legend)} ${unit}`;
  const govBody = state.bodies.find((b) => b.id === (stress ? solved.maxVmPanelId : solved.maxPanelId));

  const marks = [{
    at: at(iMax),
    dir: [0, 0, 1] as [number, number, number],
    tag: 'MAX',
    value: fmt(vMax),
    sub: govBody ? `panel ${panelLabel(govBody)}` : undefined,
    color: '#c92a2a',
  }];
  // A min callout only says something when the field doesn't simply bottom out
  // at zero everywhere the structure is held (which it does for deflection).
  if (iMin >= 0 && iMin !== iMax && vMin > vMax * 0.02) {
    marks.push({
      at: at(iMin),
      dir: [0, 0, -1] as [number, number, number],
      tag: 'MIN',
      value: fmt(vMin),
      sub: undefined,
      color: '#1c5fb0',
    });
  }
  viewer.showCaeCallouts(marks);
}

/** Draw the boundary conditions: fixed nodes, joint couplings, load vectors. */
function paintCaeConstraints() {
  const st = state.asm;
  const solved = solveMatchesMesh() ? st.lastSolve!.res : null;
  const cv = solved?.constraints ?? st.preview?.constraints ?? null;
  if (!cv) { viewer.clearCaeConstraints(); return; }
  const glyphMm = Math.max(5, (viewer.modelDiagonal() || 1000) * 0.006);
  viewer.showCaeConstraints({
    supports: st.show.supports ? cv.grounded : null,
    couplings: st.show.couplings ? cv.jointLinks : null,
    loads: st.show.loads ? cv.loads : null,
  }, { glyphMm });
}

/** Repaint every CAE overlay from current state. The mesh view and the
 *  smoothed per-panel texture are mutually exclusive — drawing both puts two
 *  surfaces at the same depth and neither reads. */
function paintCaeVisuals() {
  const st = state.asm;
  if (st.show.mesh) {
    // Clear EVERY panel's texture overlay, not just the last solve's — the PDF
    // capture and earlier solves both leave quads behind, and they'd hang in
    // front of the deformed mesh as an undeformed ghost.
    for (const b of state.bodies) viewer.clearDeflectionOverlay(b.id);
    paintCaeMesh();
  } else {
    viewer.clearCaeMesh();
    viewer.setCaeMeshFocus(false);
    paintAsmField(st.field);
  }
  paintCaeConstraints();
  paintCaeCallouts();
  renderMeshStats();
  renderCaeLegend();
}

/** Mesh resolution + constraint counts under the Mesh controls. */
function renderMeshStats() {
  const st = state.asm;
  const solved = solveMatchesMesh() ? st.lastSolve!.res : null;
  const mesh = solved?.mesh ?? st.preview?.mesh ?? null;
  const cv = solved?.constraints ?? st.preview?.constraints ?? null;
  if (!mesh) {
    asmMeshStats.innerHTML = '<span class="asm-hint">Detect joints to build the mesh.</span>';
    return;
  }
  const elemWord = mesh.nodesPerElem === 8 ? 'hex' : 'quad';
  // Report what was ACHIEVED against what was asked for — the mesher coarsens
  // off the request when a job would exceed the DOF ceiling, and silently
  // meshing at 40 mm when 5 mm was selected would be misleading.
  const asked = mesh.requestedSizeMm ?? state.asm.elementSizeMm;
  const size = Math.abs(mesh.maxEdgeMm - mesh.minEdgeMm) < 0.05
    ? `${mesh.minEdgeMm.toFixed(1)} mm`
    : `≤ ${mesh.maxEdgeMm.toFixed(1)} mm`;
  const rows = [
    `<b>${mesh.elemCount.toLocaleString()}</b> ${elemWord} · <b>${mesh.nodeCount.toLocaleString()}</b> nodes · <b>${mesh.dofCount.toLocaleString()}</b> DOF`,
    `element ${size}`
    + `${mesh.kind === 'solid' ? ` · ${mesh.throughLayers} layer${mesh.throughLayers === 1 ? '' : 's'} through t` : ''}`,
  ];
  if (mesh.coarsened) {
    rows.push(
      `<span class="asm-mesh-warn">coarsened from ${asked} mm — that needed `
      + `${mesh.uncappedDof.toLocaleString()} DOF, over the ${CAE_DOF_CEILING[mesh.kind].toLocaleString()} cap</span>`,
    );
  }
  if (cv) {
    rows.push(
      `<b>${cv.groundedCount.toLocaleString()}</b> fixed nodes · <b>${cv.jointLinks.length.toLocaleString()}</b> couplings · <b>${cv.loads.length.toLocaleString()}</b> loaded nodes (${cv.totalLoadN.toFixed(0)} N)`,
    );
  }
  asmMeshStats.innerHTML = rows.map((r) => `<div class="asm-mesh-stat">${r}</div>`).join('');
}

/**
 * Refresh the on-canvas CAE legend. It describes whatever the contour is
 * currently painting, and its auto range is the field's REAL extent (not
 * 0 → max) so a field that never approaches zero still uses the whole ramp.
 */
function renderCaeLegend() {
  const solved = solveMatchesMesh() ? state.asm.lastSolve!.res : null;
  const fld = currentCaeField();
  if (!solved || !fld || !state.asm.show.mesh) { caeLegend.update(null); return; }

  const stress = state.asm.field === 'stress';
  const mesh = solved.mesh;
  const info: string[] = [];
  if (mesh) {
    info.push(`${mesh.elemCount.toLocaleString()} ${mesh.nodesPerElem === 8 ? 'hex' : 'quad'} · ${mesh.dofCount.toLocaleString()} DOF`);
  }
  const scale = resolveDeformScale(solved.maxDisp);
  info.push(scale > 0 ? `deformed ×${scale < 10 ? scale.toFixed(1) : Math.round(scale)}` : 'undeformed');

  const govId = stress ? solved.maxVmPanelId : solved.maxPanelId;
  const govBody = state.bodies.find((b) => b.id === govId);

  caeLegend.update({
    title: stress ? 'von Mises stress' : 'Deflection',
    unit: stress ? 'MPa' : (state.units === 'in' ? 'in' : 'mm'),
    dataMin: fld.min * fld.scale,
    dataMax: fld.max * fld.scale,
    maxAt: govBody ? `panel ${panelLabel(govBody)}` : undefined,
    info,
  });
}

/** Snapshot the solved cabinet with BOTH field overlays (deflection + stress)
 *  for the PDF and store the analysis. Restores the on-screen field after. */
async function captureAssemblyAnalysis(
  res: ReturnType<typeof solveAssembly>, panels: BodyState[], maxLabel: string, vmLabel: string,
) {
  await yieldFrame();
  const SHOT = { w: 1400, h: 1000 };
  const visibleIds = new Set(panels.map((b) => b.id));

  // The PDF pages show the smoothed per-panel texture on the shaded solids, so
  // step out of the mesh view for the duration of the capture: the mesh overlay
  // and the texture overlay occupy the same depth, and the texture quads are
  // separate objects that would otherwise keep floating in front of the mesh
  // as an undeformed ghost after the capture restores.
  viewer.clearCaeMesh();
  viewer.clearCaeConstraints();
  viewer.setCaeMeshFocus(false);

  const shotField = (field: 'deflection' | 'stress'): { png: string; w: number; h: number } => {
    paintAsmField(field);
    let png = '', w = SHOT.w, h = SHOT.h;
    viewer.enterPdfBg();
    try {
      viewer.beginSnapshotBatch(SHOT);
      const shot = viewer.snapshotFiltered(visibleIds, null, 0, undefined, SHOT);
      png = shot.dataUrl; w = shot.width; h = shot.height;
    } catch (err) {
      console.warn(`assembly ${field} snapshot failed`, err);
    } finally {
      viewer.endSnapshotBatch();
      viewer.exitPdfBg();
    }
    return { png, w, h };
  };

  const defl = shotField('deflection');
  await yieldFrame();
  const stress = shotField('stress');
  // Back to whatever the user was actually looking at (mesh view or texture).
  paintCaeVisuals();

  const byId = new Map(panels.map((b) => [b.id, b] as const));

  state.asm.analysis = {
    heatmapPng: defl.png, imgW: defl.w, imgH: defl.h,
    stressPng: stress.png, stressImgW: stress.w, stressImgH: stress.h,
    cabinetTag: state.asm.cabinet ?? '',
    panelCount: panels.length,
    joints: state.asm.joints.map((j) => ({
      labelA: j.labelA, labelB: j.labelB, length: j.length, stiffness: j.stiffness,
    })),
    loads: state.asm.loads.filter((l) => l.val > 0 && l.panelId != null).map((l) => ({
      magDisplay: `${l.val} ${l.unit}`, shape: l.shape, sizeMm: l.sizeMm, down: l.down,
      panelLabel: byId.has(l.panelId!) ? panelLabel(byId.get(l.panelId!)!) : '?',
    })),
    groundedNodes: res.groundedNodes,
    maxSagMm: res.maxDisp,
    maxPanelLabel: maxLabel,
    maxAt: [res.maxAt[0], res.maxAt[1]],
    spanMm: res.spanMm,
    verdict: res.verdict,
    maxVmMPa: res.maxVm,
    maxVmPanelLabel: vmLabel,
    maxVmAt: [res.maxVmAt[0], res.maxVmAt[1]],
    utilPct: res.utilPct,
    stressVerdict: res.stressVerdict,
    combinedVerdict: assemblyWorstVerdict(res),
    resolutionLog: res.resolutionLog,
    iterations: res.iterations,
  };
}

/** Clear the assembly analysis: overlay, joints, loads, result. */
function clearAssembly() {
  viewer.clearAssemblyOverlay();
  for (const b of state.bodies) viewer.clearLoadMarkers(b.id);
  for (const b of state.bodies) viewer.clearDeflectionOverlay(b.id);
  state.asm.joints = [];
  state.asm.loads = [];
  state.asm.solveMsg = '';
  state.asm.analysis = null;
  state.asm.lastSolve = null;
  state.asm.detected = false;
  renderAnalysisSection();
}

/** True once an assembly has been solved this session (gates PDF Structure +
 *  Assembly analysis page). */
function assemblySolved(): boolean {
  return !!state.asm.analysis;
}

// --- Analysis section rendering -------------------------------------------
const stiffnessLabel: Record<JointStiffness, string> = {
  rigid: 'rigid', 'semi-rigid': 'semi-rigid', hinged: 'hinged',
};

/** (Re)build the Analysis sidebar section from state.asm. */
function renderAnalysisSection() {
  ensureAsmCabinet();
  const cabs = analysisCabinets();
  const hasBodies = cabs.length > 0;

  // Cabinet select — only meaningful with ≥2 cabinets, but always populated.
  asmCabinetSelect.innerHTML = cabs.map((c) =>
    `<option value="${escapeHtml(c)}" ${c === state.asm.cabinet ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('');
  asmCabinetSelect.parentElement!.style.display = cabs.length > 1 ? '' : 'none';

  asmDetectBtn.disabled = !hasBodies;
  asmTolInput.value = state.units === 'in'
    ? String(Number(fromMm(state.asm.tolMm, 'in').toFixed(3)))
    : String(Number(fromMm(state.asm.tolMm, 'mm').toFixed(1)));

  // --- Joints: a summary line by default. A cabinet routinely detects 70+
  //     contacts, and an un-collapsed list of them pushes the mesh controls,
  //     the loads and the Solve button off the bottom of the sidebar. ---
  const joints = state.asm.joints;
  asmJointCount.textContent = String(joints.length);
  asmJointsToggle.setAttribute('aria-expanded', String(state.asm.jointsOpen));
  asmJointsToggle.classList.toggle('open', state.asm.jointsOpen);
  asmJointsList.hidden = !state.asm.jointsOpen || joints.length === 0;
  asmJointsSetAll.disabled = joints.length === 0;

  if (!state.asm.detected) {
    asmJointsSummary.innerHTML = '<span class="asm-hint">Detect joints to find touching panel edges.</span>';
  } else if (joints.length === 0) {
    asmJointsSummary.innerHTML = '<span class="asm-hint">No joints found. Raise the tolerance if panels should touch.</span>';
  } else {
    const byStiff = { rigid: 0, 'semi-rigid': 0, hinged: 0 } as Record<JointStiffness, number>;
    for (const j of joints) byStiff[j.stiffness]++;
    const parts = (Object.keys(byStiff) as JointStiffness[])
      .filter((k) => byStiff[k] > 0)
      .map((k) => `<b>${byStiff[k]}</b> ${k}`);
    const total = joints.reduce((s, j) => s + j.length, 0);
    asmJointsSummary.innerHTML =
      `${parts.join(' · ')} · ${fmtLinear(total, state.units)} of seam`;
  }

  if (!state.asm.detected) {
    asmJointsList.innerHTML = '<div class="asm-hint">Detect joints to list touching panel edges.</div>';
  } else if (state.asm.joints.length === 0) {
    asmJointsList.innerHTML = '<div class="asm-hint">No joints found. Raise the tolerance if panels should touch.</div>';
  } else {
    asmJointsList.innerHTML = state.asm.joints.map((j, i) => `
      <div class="asm-joint-row" data-joint="${i}">
        <span class="asm-joint-name">${escapeHtml(j.labelA)} ⟂ ${escapeHtml(j.labelB)}</span>
        <span class="asm-joint-len">${fmtDim(j.length, state.units)}</span>
        <select data-jf="stiff">
          <option value="rigid" ${j.stiffness === 'rigid' ? 'selected' : ''}>rigid</option>
          <option value="semi-rigid" ${j.stiffness === 'semi-rigid' ? 'selected' : ''}>semi-rigid</option>
          <option value="hinged" ${j.stiffness === 'hinged' ? 'selected' : ''}>hinged</option>
        </select>
      </div>`).join('');
  }

  // Loads list — the SAME row UI as the per-panel CAE, plus a panel picker via
  // the "Place" button (click a panel in 3D).
  const panels = cabinetPanels();
  const byId = new Map(panels.map((b) => [b.id, b] as const));
  const sizeInUnits = (mm: number) => {
    const v = fromMm(mm, state.units);
    return state.units === 'in' ? Number(v.toFixed(2)) : Math.round(v);
  };
  asmLoadsList.innerHTML = state.asm.loads.map((ld, i) => {
    const where = ld.panelId != null && byId.has(ld.panelId)
      ? `${panelLabel(byId.get(ld.panelId)!)}${ld.pt ? ` @(${fmtDim(ld.pt.x, state.units)}, ${fmtDim(ld.pt.y, state.units)})` : ''}`
      : 'unplaced';
    return `
    <div class="asm-load-row" data-load="${i}">
      <input type="number" min="0" step="1" value="${ld.val}" data-lf="val" title="magnitude" />
      <select data-lf="unit">
        <option value="N" ${ld.unit === 'N' ? 'selected' : ''}>N</option>
        <option value="kg" ${ld.unit === 'kg' ? 'selected' : ''}>kg</option>
        <option value="lbf" ${ld.unit === 'lbf' ? 'selected' : ''}>lbf</option>
      </select>
      <button type="button" class="cae-dir" data-lf="dir" title="direction (down force / up reaction)">${ld.down ? '↓' : '↑'}</button>
      <select data-lf="shape" title="footprint shape">
        <option value="round" ${ld.shape === 'round' ? 'selected' : ''}>○</option>
        <option value="square" ${ld.shape === 'square' ? 'selected' : ''}>□</option>
      </select>
      <input type="number" min="0" step="${state.units === 'in' ? '0.25' : '1'}" value="${sizeInUnits(ld.sizeMm)}" data-lf="size" title="footprint size (${state.units})" />
      <button type="button" class="ghost cae-place-load" data-lf="place" title="place on a panel">Place</button>
      <span class="cae-load-at">${escapeHtml(where)}</span>
      <button type="button" class="cae-x" data-lf="remove" title="remove">×</button>
    </div>`;
  }).join('');

  // Actions state.
  asmSolveBtn.disabled = !hasBodies;
  asmExportBtn.disabled = !state.asm.analysis;

  // Field toggle (Deflection / Stress) — only live after a solve.
  const solved = !!state.asm.lastSolve && state.asm.lastSolve.res.ok;
  asmFieldToggle.hidden = !solved;
  asmFieldDefl.classList.toggle('active', state.asm.field === 'deflection');
  asmFieldStress.classList.toggle('active', state.asm.field === 'stress');
  asmFieldDefl.setAttribute('aria-selected', String(state.asm.field === 'deflection'));
  asmFieldStress.setAttribute('aria-selected', String(state.asm.field === 'stress'));

  // Deformed-shape scale + colour bar — only meaningful on a contoured mesh.
  asmDeformRow.hidden = !solveMatchesMesh();
  renderCaeLegend();
  renderMeshStats();

  // --- Results. A solved run gets metric TILES (the three numbers anyone
  //     actually reads, each carrying its own verdict colour) with the solver
  //     provenance underneath; anything else falls back to the message line. ---
  renderAsmTiles();

  // The sentence stays — it's the accessible/short-form summary, it carries the
  // backend + timing, and the Playwright drives read the solve outcome from it.
  // The tiles sit ABOVE it as the at-a-glance version, not a replacement.
  const verdictClass = state.asm.analysis
    ? `cae-${state.asm.analysis.combinedVerdict}` : '';
  asmResult.className = `asm-result ${verdictClass}`;
  asmResult.innerHTML = state.asm.solveMsg
    ? escapeHtml(state.asm.solveMsg)
    : '<span class="asm-hint">Detect joints, add loads, then Solve assembly.</span>';

  refreshSolvedDot();
  wireAnalysisSection();
}

/**
 * The solved-result tiles: max deflection, max stress, utilisation — each with
 * the limit it is judged against and its own verdict colour, then a provenance
 * line (element type, DOF, backend, timing). Replaces a single run-on sentence
 * that buried all three numbers in prose.
 */
function renderAsmTiles() {
  const cached = state.asm.lastSolve;
  if (!cached || !cached.res.ok) { asmTiles.hidden = true; asmTiles.innerHTML = ''; return; }
  const res = cached.res;
  const stale = !solveMatchesMesh();

  const defLimit = res.spanMm / 200;
  const tile = (
    label: string, value: string, note: string, verdict: 'ok' | 'borderline' | 'weak',
  ) => `
    <div class="asm-tile cae-${verdict}">
      <div class="asm-tile-label">${label}</div>
      <div class="asm-tile-value">${escapeHtml(value)}</div>
      <div class="asm-tile-note">${escapeHtml(note)}</div>
    </div>`;

  const maxBody = state.bodies.find((b) => b.id === res.maxPanelId);
  const vmBody = state.bodies.find((b) => b.id === res.maxVmPanelId);

  asmTiles.hidden = false;
  asmTiles.innerHTML =
    (stale ? '<div class="asm-tiles-stale">Mesh changed since this solve — re-run to update.</div>' : '')
    + '<div class="asm-tiles-row">'
    + tile('Max deflection', fmtSag(res.maxDisp, state.units),
      `limit ${fmtSag(defLimit, state.units)}${maxBody ? ` · ${panelLabel(maxBody)}` : ''}`, res.verdict)
    + tile('Max stress', `${res.maxVm.toFixed(2)} MPa`,
      vmBody ? `panel ${panelLabel(vmBody)}` : 'von Mises', res.stressVerdict)
    + tile('Utilisation', `${res.utilPct.toFixed(0)}%`,
      'of bending strength', res.stressVerdict)
    + '</div>';
}

/** Attach event handlers to the freshly-rendered Analysis section. */
function wireAnalysisSection() {
  // Joint stiffness selects.
  asmJointsList.querySelectorAll<HTMLElement>('.asm-joint-row').forEach((row) => {
    const i = +row.dataset.joint!;
    row.querySelector<HTMLSelectElement>('[data-jf="stiff"]')!.addEventListener('change', (e) => {
      state.asm.joints[i].stiffness = (e.target as HTMLSelectElement).value as JointStiffness;
      // Result is stale once a joint changes.
      state.asm.analysis = null;
      state.asm.lastSolve = null;
      paintAssemblyPreview();
      renderAnalysisSection();
    });
  });

  // Load rows.
  asmLoadsList.querySelectorAll<HTMLElement>('.asm-load-row').forEach((row) => {
    const i = +row.dataset.load!;
    const ld = state.asm.loads[i];
    row.querySelector<HTMLInputElement>('[data-lf="val"]')!.addEventListener('change', (e) => {
      ld.val = Math.max(0, parseFloat((e.target as HTMLInputElement).value) || 0);
      onAsmLoadsChanged();
    });
    row.querySelector<HTMLSelectElement>('[data-lf="unit"]')!.addEventListener('change', (e) => {
      ld.unit = (e.target as HTMLSelectElement).value as CaeLoad['unit'];
      onAsmLoadsChanged();
    });
    row.querySelector<HTMLButtonElement>('[data-lf="dir"]')!.addEventListener('click', () => {
      ld.down = !ld.down; onAsmLoadsChanged(); renderAnalysisSection();
    });
    row.querySelector<HTMLSelectElement>('[data-lf="shape"]')!.addEventListener('change', (e) => {
      ld.shape = (e.target as HTMLSelectElement).value as CaeLoad['shape']; onAsmLoadsChanged();
    });
    row.querySelector<HTMLInputElement>('[data-lf="size"]')!.addEventListener('change', (e) => {
      ld.sizeMm = toMm(Math.max(0, parseFloat((e.target as HTMLInputElement).value) || 0), state.units);
      onAsmLoadsChanged();
    });
    row.querySelector<HTMLButtonElement>('[data-lf="place"]')!.addEventListener('click', (e) => {
      const btn = e.target as HTMLButtonElement;
      btn.classList.add('armed'); btn.textContent = 'Click a panel…';
      // The next click on ANY cabinet panel places the load on that panel.
      viewer.beginAssemblyPlacement((bodyId, point) => {
        const b = state.bodies.find((x) => x.id === bodyId && x.selected && x.fileTag === state.asm.cabinet);
        if (!b) return; // ignore clicks on panels outside this cabinet
        ld.panelId = bodyId;
        ld.pt = worldToOutline(b, point);
        onAsmLoadsChanged();
        renderAnalysisSection();
      });
    });
    row.querySelector<HTMLButtonElement>('[data-lf="remove"]')!.addEventListener('click', () => {
      state.asm.loads.splice(i, 1); onAsmLoadsChanged(); renderAnalysisSection();
    });
  });
}

/** Standalone Assembly-analysis PDF for the current cabinet. */
function exportAssemblyPdf() {
  const an = state.asm.analysis;
  if (!an) return;
  const doc = buildAssemblyAnalysisPdf(toAsmPdf(an), {
    sheetW: state.lastSheet?.w ?? 2440,
    sheetL: state.lastSheet?.l ?? 1220,
    margin: state.lastSheet?.margin ?? 0,
    kerf: state.lastSheet?.kerf ?? 0,
    units: state.units,
    jobName: state.jobName || 'Plywood cut estimate',
    paper: (pdfPaperSelect.value as any) || 'widescreen-16-9',
  });
  const job = (state.jobName || 'plywood').replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
  const tag = (an.cabinetTag || 'assembly').replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
  downloadPdf(`${job}_assembly_${tag}.pdf`, doc);
}

/** Convert captured AssemblyAnalysis → the PDF's AssemblyAnalysisPage input. */
function toAsmPdf(an: AssemblyAnalysis): import('./pdf').AssemblyAnalysisPage {
  return {
    cabinet: an.cabinetTag,
    image: { dataUrl: an.heatmapPng, width: an.imgW, height: an.imgH },
    stressImage: an.stressPng ? { dataUrl: an.stressPng, width: an.stressImgW, height: an.stressImgH } : undefined,
    panelCount: an.panelCount,
    joints: an.joints.map((j) => ({ pair: `${j.labelA} ⟂ ${j.labelB}`, length: j.length, stiffness: j.stiffness })),
    loads: an.loads.map((l) => ({ magDisplay: l.magDisplay, shape: l.shape as 'square' | 'round', sizeMm: l.sizeMm, down: l.down, panelLabel: l.panelLabel })),
    groundedNodes: an.groundedNodes,
    maxSagMm: an.maxSagMm,
    maxPanelLabel: an.maxPanelLabel,
    maxAt: an.maxAt,
    spanMm: an.spanMm,
    verdict: an.verdict,
    maxVmMPa: an.maxVmMPa,
    maxVmPanelLabel: an.maxVmPanelLabel,
    maxVmAt: an.maxVmAt,
    utilPct: an.utilPct,
    stressVerdict: an.stressVerdict,
    combinedVerdict: an.combinedVerdict,
    resolutionLog: an.resolutionLog,
    iterations: an.iterations,
  };
}

// --- Analysis section event wiring (once) ---------------------------------
asmCabinetSelect.addEventListener('change', () => {
  state.asm.cabinet = asmCabinetSelect.value || null;
  state.asm.joints = [];
  state.asm.detected = false;
  state.asm.analysis = null;
  state.asm.lastSolve = null;
  viewer.clearAssemblyOverlay();
  renderAnalysisSection();
});
asmTolInput.addEventListener('change', () => {
  const v = Math.max(0, parseFloat(asmTolInput.value) || 0);
  state.asm.tolMm = toMm(v, state.units);
});
asmDetectBtn.addEventListener('click', () => detectAssemblyJoints());
asmAddLoadBtn.addEventListener('click', () => {
  state.asm.loads.push(newAsmLoad());
  renderAnalysisSection();
});
asmPreset50.addEventListener('click', () => { presetOnTop(50); onAsmLoadsChanged(); renderAnalysisSection(); });
asmPresetShelf.addEventListener('click', () => { presetPerShelf(20); onAsmLoadsChanged(); renderAnalysisSection(); });
asmPresetClear.addEventListener('click', () => {
  state.asm.loads = [];
  onAsmLoadsChanged();
  renderAnalysisSection();
});
asmSolveBtn.addEventListener('click', async () => {
  asmSolveBtn.disabled = true;
  // Progress bar inside the button, matching the PDF export pattern. Each stage
  // yields a frame so the bar actually paints between the (fast) heavy phases.
  const originalLabel = asmSolveBtn.innerHTML;
  asmSolveBtn.classList.add('busy');
  const setStage = async (label: string, pct: number) => {
    asmSolveBtn.innerHTML =
      `<span class="progress-bar"><span class="progress-fill" style="width:${pct.toFixed(0)}%"></span></span>` +
      `<span class="progress-label asm-solve-stage">${escapeHtml(label)}</span>`;
    await yieldFrame();
  };
  await setStage('Starting…', 2);
  try {
    await solveAssemblyForCabinet(setStage);
  } catch (err) {
    console.error('assembly solve failed', err);
    state.asm.solveMsg = 'Solve failed — see console.';
    renderAnalysisSection();
  }
  asmSolveBtn.classList.remove('busy');
  asmSolveBtn.innerHTML = originalLabel;
  asmSolveBtn.textContent = 'Solve assembly';
  asmSolveBtn.disabled = false;
});
asmClearBtn.addEventListener('click', () => clearAssembly());
asmExportBtn.addEventListener('click', () => exportAssemblyPdf());

// --- Sidebar mode switch (Cut planning / Analysis) ------------------------
const sidebarEl = $('sidebar');
const modeCutBtn = $<HTMLButtonElement>('modeCutBtn');
const modeAnalysisBtn = $<HTMLButtonElement>('modeAnalysisBtn');
const modeAnalysisDot = $('modeAnalysisDot');
const MODE_KEY = 'plywood.sidebarMode';
type SidebarMode = 'cut' | 'analysis';

function applySidebarMode(mode: SidebarMode) {
  sidebarEl.classList.toggle('mode-cut', mode === 'cut');
  sidebarEl.classList.toggle('mode-analysis', mode === 'analysis');
  modeCutBtn.classList.toggle('active', mode === 'cut');
  modeAnalysisBtn.classList.toggle('active', mode === 'analysis');
  modeCutBtn.setAttribute('aria-selected', String(mode === 'cut'));
  modeAnalysisBtn.setAttribute('aria-selected', String(mode === 'analysis'));
  // Analysis mode has nothing to say about cut sheets, so the layout half goes
  // away and the 3D view — which is the entire output of this mode — takes the
  // full pane. `#workArea` drives it in CSS; the viewer needs a resize because
  // its canvas dimensions changed.
  workArea.classList.toggle('analysis-full', mode === 'analysis');
  requestAnimationFrame(() => viewer.resize(viewerEl));
  try { localStorage.setItem(MODE_KEY, mode); } catch {}
}

/** Show/hide the green solved-state dot on the Analysis tab. */
function refreshSolvedDot() {
  modeAnalysisDot.hidden = !assemblySolved();
}

modeCutBtn.addEventListener('click', () => applySidebarMode('cut'));
modeAnalysisBtn.addEventListener('click', () => {
  applySidebarMode('analysis');
  // Ensure the section is populated for the current selection.
  renderAnalysisSection();
});
applySidebarMode(((): SidebarMode => {
  try { return localStorage.getItem(MODE_KEY) === 'analysis' ? 'analysis' : 'cut'; } catch { return 'cut'; }
})());

function syncViewerSelectionFromState() {
  viewer.setSelection(state.bodies.filter((b) => b.selected).map((b) => b.id));
}
selectAllBtn.addEventListener('click', () => {
  for (const b of state.bodies) b.selected = true;
  syncViewerSelectionFromState();
  renderBodyList();
  updateNestBtn();
});
selectNoneBtn.addEventListener('click', () => {
  for (const b of state.bodies) b.selected = false;
  syncViewerSelectionFromState();
  renderBodyList();
  updateNestBtn();
});
clearAllBtn.addEventListener('click', () => clearAll());

function updateNestBtn() {
  nestBtn.disabled = !state.bodies.some((b) => b.selected);
  recenterBtn.disabled = state.bodies.length === 0;
}

// --------------------------------------------------------------------------
// Sheet config + units
// --------------------------------------------------------------------------
const PRESETS: Record<string, [number, number]> = {
  '1220x2440': [1220, 2440],
  '1525x1525': [1525, 1525],
  '1525x3050': [1525, 3050],
  '2440x1220': [2440, 1220],
};

// ---- Custom (user-saved) sheet-size presets, persisted in localStorage ----
interface CustomPreset { id: string; name: string; w: number; l: number; } // w/l in mm
const CUSTOM_PRESETS_KEY = 'plywood.customPresets';

function loadCustomPresets(): CustomPreset[] {
  try {
    const raw = localStorage.getItem(CUSTOM_PRESETS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr)
      ? arr.filter((p) => p && typeof p.w === 'number' && typeof p.l === 'number' && p.name)
      : [];
  } catch {
    return [];
  }
}
function persistCustomPresets() {
  try { localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(customPresets)); } catch {}
}
let customPresets = loadCustomPresets();

/** (Re)build the "My presets" optgroup; labels reflect the current units. */
function rebuildCustomPresetOptions() {
  presetCustomGroup.innerHTML = '';
  presetCustomGroup.hidden = customPresets.length === 0;
  for (const p of customPresets) {
    const opt = document.createElement('option');
    opt.value = `custom:${p.id}`;
    opt.textContent = `${p.name} · ${fmtDim(p.w, state.units)} × ${fmtDim(p.l, state.units)}`;
    presetCustomGroup.appendChild(opt);
  }
}
rebuildCustomPresetOptions();

presetSelect.addEventListener('change', () => {
  const v = presetSelect.value;
  let dims: [number, number] | null = null;
  if (v && PRESETS[v]) {
    dims = PRESETS[v];
  } else if (v.startsWith('custom:')) {
    const p = customPresets.find((x) => `custom:${x.id}` === v);
    if (p) dims = [p.w, p.l];
  }
  deletePresetBtn.disabled = !v.startsWith('custom:');
  if (!dims) return;
  setFieldMm(sheetWInput, dims[0]);
  setFieldMm(sheetLInput, dims[1]);
});

savePresetBtn.addEventListener('click', () => {
  const wMm = readFieldMm(sheetWInput);
  const lMm = readFieldMm(sheetLInput);
  if (!Number.isFinite(wMm) || !Number.isFinite(lMm) || wMm <= 0 || lMm <= 0) {
    setStatus('Enter a valid width and length before saving a preset.', 'error');
    return;
  }
  const suggested = `${fmtDim(wMm, state.units)} × ${fmtDim(lMm, state.units)}`;
  const name = (window.prompt('Name this sheet preset:', suggested) || '').trim();
  if (!name) return;
  const id = String(Date.now()) + Math.random().toString(36).slice(2, 6);
  customPresets.push({ id, name, w: wMm, l: lMm });
  persistCustomPresets();
  rebuildCustomPresetOptions();
  presetSelect.value = `custom:${id}`;
  deletePresetBtn.disabled = false;
});

deletePresetBtn.addEventListener('click', () => {
  const v = presetSelect.value;
  if (!v.startsWith('custom:')) return;
  customPresets = customPresets.filter((x) => `custom:${x.id}` !== v);
  persistCustomPresets();
  rebuildCustomPresetOptions();
  presetSelect.value = '';
  deletePresetBtn.disabled = true;
});

unitsSelect.addEventListener('change', () => {
  const next = unitsSelect.value as Units;
  if (state.units === next) return;
  state.units = next;
  // Dimension fields carry canonical mm in dataset.mm, so switching units is
  // a pure re-render: field text flips to the new units, subtext flips to the
  // other unit system. No arithmetic on the display string (which avoids the
  // old round-trip precision drift).
  renderAllDimFields();
  rebuildCustomPresetOptions(); // preset labels show dims in the new units
  renderBodyList();
  renderShoppingList();
  if (state.lastNest && state.lastSheet) renderResults();
});

// --------------------------------------------------------------------------
// Job / currency / PDF paper
// --------------------------------------------------------------------------
state.jobName = loadJobName();
jobNameInput.value = state.jobName;
jobNameInput.addEventListener('input', () => {
  state.jobName = jobNameInput.value;
  saveJobName(state.jobName);
});
currencySelect.addEventListener('change', () => {
  state.currency = currencySelect.value;
  renderShoppingList();
});

// --------------------------------------------------------------------------
// Kerf select — options are labelled in mm regardless of display units; the
// preset values (1.8 / 2.5 mm) are stored in mm. "Custom…" reveals the
// numeric #kerf input, which stays in the user's display units (as before).
// --------------------------------------------------------------------------
const KERFREF_KEY = 'plywood.kerfRef';
const SEQSTYLE_KEY = 'plywood.sequenceStyle';
const KERF_KEY = 'plywood.kerf'; // { mode: 'preset'|'custom', value: mm }

/** Effective kerf in mm from the current select / custom input. */
function readKerfMm(): number {
  if (kerfSelect.value === 'custom') return readFieldMm(kerfInput);
  const mm = parseFloat(kerfSelect.value);
  return Number.isFinite(mm) ? mm : 1.8;
}
function syncKerfCustomVisibility() {
  kerfCustomRow.hidden = kerfSelect.value !== 'custom';
}
function persistKerf() {
  try {
    localStorage.setItem(KERF_KEY, JSON.stringify(
      kerfSelect.value === 'custom'
        ? { mode: 'custom', value: readKerfMm() }
        : { mode: 'preset', value: kerfSelect.value },
    ));
  } catch { /* quota */ }
}
kerfSelect.addEventListener('change', () => { syncKerfCustomVisibility(); persistKerf(); });
// The custom-kerf #kerf field commits (and persists) on change/blur via the
// shared dimension-field handler — no separate 'input' listener needed.
// Restore persisted kerf choice.
try {
  const raw = localStorage.getItem(KERF_KEY);
  if (raw) {
    const saved = JSON.parse(raw);
    if (saved?.mode === 'custom') {
      kerfSelect.value = 'custom';
      setFieldMm(kerfInput, saved.value);
    } else if (saved?.mode === 'preset') {
      kerfSelect.value = String(saved.value);
    }
  }
} catch { /* ignore */ }
syncKerfCustomVisibility();

// Kerf-reference mode (keeper / center / spacing) — persisted like currency.
state.kerfRef = (localStorage.getItem(KERFREF_KEY) as KerfRef) || 'keeper';
kerfRefSelect.value = state.kerfRef;
kerfRefSelect.addEventListener('change', () => {
  state.kerfRef = kerfRefSelect.value as KerfRef;
  try { localStorage.setItem(KERFREF_KEY, state.kerfRef); } catch { /* quota */ }
  if (state.lastNest) renderResults();
});

// Sequence style (row-by-row "easy cut" learned default / optimized parallel
// guide) — persisted. Re-renders so the cut cards + PDF pick up the new order.
state.sequenceStyle = (localStorage.getItem(SEQSTYLE_KEY) as SequenceStyle) || 'row';
sequenceStyleSelect.value = state.sequenceStyle;
sequenceStyleSelect.addEventListener('change', () => {
  state.sequenceStyle = sequenceStyleSelect.value as SequenceStyle;
  try { localStorage.setItem(SEQSTYLE_KEY, state.sequenceStyle); } catch { /* quota */ }
  if (state.lastNest) renderResults();
});

// --------------------------------------------------------------------------
// Shopping list UI — auto-generated from the latest nest result.
// Per row: Material · Need · Have (editable) · Buy · Price (editable) · Cost
// Persisted in localStorage by row signature (have + price).
// --------------------------------------------------------------------------
function renderShoppingList() {
  shopCount.textContent = String(state.shopping.length);
  shopList.innerHTML = '';
  shopCopyBtn.disabled = state.shopping.length === 0;
  shopCsvBtn.disabled = state.shopping.length === 0;

  if (state.shopping.length === 0) {
    shopList.innerHTML = '<div class="empty">Run an estimate to see what to buy.</div>';
    shopTotals.hidden = true;
    return;
  }

  const header = document.createElement('div');
  header.className = 'shop-header';
  header.innerHTML = `
    <div>Material</div>
    <div class="num">Need</div>
    <div class="num">Have</div>
    <div class="num">Buy</div>
    <div class="num">$ / sheet</div>
    <div class="num">Line cost</div>`;
  shopList.appendChild(header);

  for (const row of state.shopping) {
    const el = document.createElement('div');
    el.className = 'shop-row' + (row.buy > 0 ? ' short' : '');
    el.innerHTML = `
      <div class="label">
        ${fmtDim(row.thickness, state.units)}
        <small>${fmtDim(row.sheetW, state.units)} × ${fmtDim(row.sheetL, state.units)}</small>
      </div>
      <div class="num">${row.need}</div>
      <div><input type="number" min="0" step="1" value="${row.have}" data-field="have" /></div>
      <div class="buy ${row.buy > 0 ? 'short' : 'ok'}">${row.buy > 0 ? row.buy : 'OK'}</div>
      <div><input type="number" min="0" step="0.01" value="${row.unitPrice}" data-field="price" /></div>
      <div class="cost">${row.lineCost > 0 ? fmtMoney(row.lineCost, state.currency) : '—'}</div>`;
    el.querySelectorAll<HTMLInputElement>('input[data-field]').forEach((inp) => {
      inp.addEventListener('change', () => {
        const v = Math.max(0, parseFloat(inp.value) || 0);
        if (inp.dataset.field === 'have') {
          row.have = Math.floor(v);
          row.buy = Math.max(0, row.need - row.have);
          setHave(row.key, row.have);
        } else {
          row.unitPrice = v;
          setPrice(row.key, v);
        }
        row.lineCost = row.buy * row.unitPrice;
        renderShoppingList();
      });
    });
    shopList.appendChild(el);
  }

  const tot = totalCost(state.shopping);
  shopTotals.hidden = false;
  shopTotals.innerHTML = `
    <span class="total-label">Job total</span>
    <span class="total-val">${fmtMoney(tot, state.currency)}</span>`;
}

shopCsvBtn.addEventListener('click', () => {
  if (state.shopping.length === 0) return;
  const csv = toCsv(state.shopping, 'mm');
  const safe = (state.jobName || 'shopping_list').replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
  downloadCsv(`${safe}.csv`, csv);
});
shopCopyBtn.addEventListener('click', async () => {
  if (state.shopping.length === 0) return;
  const lines = state.shopping.map((r) =>
    `${fmtDim(r.thickness, state.units)} · ${fmtDim(r.sheetW, state.units)} × ${fmtDim(r.sheetL, state.units)} · Need ${r.need} · Have ${r.have} · Buy ${r.buy} · ${fmtMoney(r.lineCost, state.currency)}`,
  );
  lines.push(`TOTAL: ${fmtMoney(totalCost(state.shopping), state.currency)}`);
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    shopCopyBtn.textContent = 'Copied!';
    setTimeout(() => { shopCopyBtn.textContent = 'Copy'; }, 1200);
  } catch {
    shopCopyBtn.textContent = 'Copy failed';
  }
});

renderShoppingList();

// --------------------------------------------------------------------------
// Nesting + results
// --------------------------------------------------------------------------
/**
 * Run one estimate. `deepSearch` + `seed` drive the "Optimize further"
 * button: a deeper search (GA over placement orders for CNC, fresh shuffle
 * stream for the saw strategies) seeded differently on every click.
 */
async function runEstimate(opts: { seed?: number; deepSearch?: boolean } = {}) {
  const selected = state.bodies.filter((b) => b.selected);
  if (selected.length === 0) return;
  const sheetW = readFieldMm(sheetWInput);
  const sheetL = readFieldMm(sheetLInput);
  const margin = readFieldMm(marginInput);
  const kerf = readKerfMm();
  const restarts = parseInt(restartsSelect.value) || 8;

  const parts: NestPart[] = selected.map((b) => ({
    id: String(b.id),
    name: b.name,
    thickness: applyThicknessOverride(b.analysis.thickness),
    qty: b.qty,
    grain: b.grain,
    rotation: b.rotation,
    outer: b.analysis.outline.outer,
    holes: b.analysis.outline.holes,
    color: b.color,
  }));

  nestBtn.disabled = true;
  nestBtn.textContent = 'Estimating…';
  resultsEmpty.hidden = false;
  resultsEmpty.textContent = 'Optimising layout…';
  resultsDetail.hidden = true;
  downloadDxfBtn.disabled = true;
  downloadCutDxfBtn.disabled = true;
  downloadPdfBtn.disabled = true;
  downloadPhonePdfBtn.disabled = true;
  downloadCutlistPdfBtn.disabled = true;
  replayBtn.disabled = true;

  // Capture trial frames for the replay button. We do NOT paint frames live
  // during the estimate (the user gets a fast 'final state' on completion).
  state.lastTrialFrames = [];
  state.lastTrialMetrics = [];

  const strategy = (cutStrategySelect.value as CutStrategy) || 'free';
  state.lastStrategy = strategy;
  const isCnc = isCncStrategy(strategy);

  // CNC auto-split: replace oversize parts with dovetail-jointed segments
  // that fit the usable sheet, BEFORE the nester sees them. The bin frame
  // matches runCncNest: X = sheet length, Y = sheet width, minus margins.
  let nestParts = parts;
  state.splitSegmentGeo = new Map();
  state.splitInfo = [];
  if (isCnc && splitOversizeCheck.checked) {
    const split = splitOversizeParts(parts, sheetL - 2 * margin, sheetW - 2 * margin);
    nestParts = split.parts;
    state.splitSegmentGeo = split.segmentGeo;
    state.splitInfo = split.splits;
  }

  try {
    const result = await runNestAnimated(nestParts, {
      sheetW, sheetL, margin, kerf,
      resolution: estimateResolution(sheetW, sheetL),
      restarts: opts.deepSearch ? restarts * 2 : restarts,
      cutStrategy: strategy,
      seed: opts.seed,
      deepSearch: opts.deepSearch,
    }, async (info) => {
      const pct = ((info.trial + 1) / info.totalTrials) * 100;
      // CNC reports optimiser passes (orderings + consolidation), not saw trials.
      nestBtn.textContent = isCnc
        ? `Nesting · pass ${info.trial + 1}/${info.totalTrials} · ${pct.toFixed(0)}%`
        : `Trial ${info.trial + 1}/${info.totalTrials} · ${pct.toFixed(0)}%`;
      const yieldNow = sumYield(info.best);
      resultsEmpty.textContent = isCnc
        ? `Nesting · pass ${info.trial + 1} of ${info.totalTrials} · ` +
          `best ${info.best.length} sheet${info.best.length === 1 ? '' : 's'} · ${(yieldNow * 100).toFixed(1)}% yield`
        : `Optimising · trial ${info.trial + 1} of ${info.totalTrials} · ` +
          `best ${info.best.length} sheet${info.best.length === 1 ? '' : 's'} · ${(yieldNow * 100).toFixed(1)}% yield`;
      // Record this trial for later replay.
      state.lastTrialFrames.push({
        sheets: info.current,
        sheetW: info.sheetW,
        sheetL: info.sheetL,
        margin,
        trial: info.trial,
        total: info.totalTrials,
        isNewBest: info.isNewBest,
      });
      // Per-trial metrics for the convergence chart. The "best" series is the
      // ACTUALLY-SELECTED layout so far (info.best), NOT an independent running
      // min/max per metric — the latter showed a phantom solution no single
      // layout achieved (e.g. "2 cuts" borrowed from a sparse, discarded
      // trial). Cut counts use the real recorded tree plus the two margin-trim
      // cuts, so the chart, the metrics panel, and the PDF all agree for every
      // optimisation method.
      state.lastTrialMetrics.push({
        i: info.trial,
        cuts: isCnc ? 0 : info.current.reduce((a, s) => a + sheetCutTotal(s, margin), 0),
        sheets: info.current.length,
        yieldPct: sumYield(info.current) * 100,
        bestCuts: isCnc ? 0 : info.best.reduce((a, s) => a + sheetCutTotal(s, margin), 0),
        bestSheets: info.best.length,
        bestYield: sumYield(info.best) * 100,
      });
    });

    state.lastNest = result;
    state.partLabels = assignPartLabels(result);
    state.lastSheet = { w: sheetW, l: sheetL, margin, kerf };
    state.currentSheetKey = firstSheetKey(result);
    renderResults();
    renderConvergenceChart();
    replayBtn.disabled = state.lastTrialFrames.length === 0;
  } catch (err: any) {
    resultsEmpty.hidden = false;
    resultsDetail.hidden = true;
    resultsEmpty.textContent = err.message || 'Nesting failed.';
    console.error(err);
  } finally {
    nestBtn.disabled = false;
    nestBtn.textContent = 'Estimate cut sheets';
    optimizeMoreBtn.disabled = !state.lastNest;
  }
}

nestBtn.addEventListener('click', () => runEstimate());

// "Optimize further": a deeper, differently-seeded search that only
// replaces the current layout when it actually beats it. Every click
// explores a NEW region of the search space (incrementing seed), so
// repeated clicks keep mining.
let optimizeSeed = 0;
optimizeMoreBtn.addEventListener('click', async () => {
  if (!state.lastNest || nestBtn.disabled) return;
  const prev = {
    nest: state.lastNest,
    labels: state.partLabels,
    sheetKey: state.currentSheetKey,
  };
  const prevUnplaced = totalUnplacedOf(prev.nest);
  optimizeMoreBtn.disabled = true;
  await runEstimate({ seed: ++optimizeSeed, deepSearch: true });
  const next = state.lastNest;
  if (!next || next === prev.nest) return; // estimate failed — nothing to compare
  const better =
    totalUnplacedOf(next) < prevUnplaced ||
    (totalUnplacedOf(next) === prevUnplaced && (
      next.totalSheets < prev.nest.totalSheets ||
      (next.totalSheets === prev.nest.totalSheets && next.yield > prev.nest.yield + 1e-9)));
  if (better) {
    const sheetsMsg = next.totalSheets < prev.nest.totalSheets
      ? `${prev.nest.totalSheets} → ${next.totalSheets} sheets`
      : `yield ${(prev.nest.yield * 100).toFixed(1)}% → ${(next.yield * 100).toFixed(1)}%`;
    detailSub.textContent = `Improved: ${sheetsMsg}`;
  } else {
    // Restore the previous (better or equal) layout.
    state.lastNest = prev.nest;
    state.partLabels = prev.labels;
    state.currentSheetKey = prev.sheetKey;
    state.lastTrialFrames = [];
    state.lastTrialMetrics = [];
    renderResults();
    renderConvergenceChart();
    replayBtn.disabled = true;
    detailSub.textContent = 'No improvement found — kept the current layout. Click again to search elsewhere.';
  }
});

function totalUnplacedOf(r: NestResult): number {
  return r.groups.reduce((s, g) => s + g.unplaced.length, 0);
}

// Replay button: animate the captured trial sequence at 25 fps. While the
// replay runs, the button toggles to "stop" and the final state is restored
// on stop or completion.
let replayHandle: { stop: boolean } | null = null;
replayBtn.addEventListener('click', async () => {
  if (replayHandle) { replayHandle.stop = true; return; }
  if (state.lastTrialFrames.length === 0) return;
  const handle = { stop: false };
  replayHandle = handle;
  replayBtn.classList.add('busy');
  const frames = state.lastTrialFrames;
  const FRAME_MS = 1000 / 25;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  for (let i = 0; i < frames.length; i++) {
    if (handle.stop) break;
    const f = frames[i];
    detailTitle.textContent = `Replay · trial ${i + 1} / ${frames.length}`;
    detailSub.textContent = f.isNewBest ? 'new best ★' : '';
    paintTrialPreview(f.sheets, f.sheetW, f.sheetL, f.margin);
    await sleep(FRAME_MS);
  }
  replayHandle = null;
  replayBtn.classList.remove('busy');
  // Restore the final state.
  if (state.lastNest) renderResults();
});

/** Render a quick stacked preview of trial sheets during animation. */
function paintTrialPreview(sheets: NestSheet[], sheetW: number, sheetL: number, margin: number) {
  detailSvg.innerHTML = '';
  for (let i = 0; i < sheets.length; i++) {
    const sh = sheets[i];
    const entry = document.createElement('section');
    entry.className = 'sheet-entry';
    const head = document.createElement('header');
    head.className = 'sheet-entry-header';
    const fill = sh.parts.length > 0 ? (sh.usedArea / (sheetW * sheetL)) * 100 : 0;
    head.innerHTML = `
      <div class="sheet-entry-title">Sheet ${i + 1}</div>
      <div class="sheet-entry-meta">${sh.parts.length} parts · <strong>${fill.toFixed(1)}%</strong> fill</div>`;
    entry.appendChild(head);
    const svgWrap = document.createElement('div');
    svgWrap.className = 'sheet-entry-svg';
    svgWrap.appendChild(buildSheetSvg(sh, sheetW, sheetL, margin, false));
    entry.appendChild(svgWrap);
    detailSvg.appendChild(entry);
  }
}

/**
 * Render an SVG line chart of the optimiser's per-iteration metrics:
 * - Yield % (running best)
 * - Sheets used (running best)
 * - Total cuts (running best)
 * X axis = trial number. Drawn into #convergenceChart.
 */
function renderConvergenceChart() {
  const data = state.lastTrialMetrics;
  if (data.length === 0) { convergenceChart.hidden = true; return; }
  // CNC has no discrete cut count — drop the cuts series for it.
  const showCuts = !isCncStrategy(state.lastStrategy);
  convergenceChart.hidden = false;
  const W = 880, H = 140, PAD_L = 36, PAD_R = 12, PAD_T = 18, PAD_B = 22;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const N = data.length;
  const xs = (i: number) => PAD_L + (i / Math.max(1, N - 1)) * plotW;

  // Normalise each series into [0, 1] within the plot.
  const maxCuts = Math.max(...data.map((d) => d.cuts));
  const maxSheets = Math.max(...data.map((d) => d.sheets));
  const yScale = (v: number, lo: number, hi: number) =>
    PAD_T + plotH - ((v - lo) / Math.max(1e-6, hi - lo)) * plotH;
  const path = (values: number[], lo: number, hi: number) => {
    let d = '';
    for (let i = 0; i < values.length; i++) {
      d += (i === 0 ? 'M' : 'L') + xs(i).toFixed(1) + ',' + yScale(values[i], lo, hi).toFixed(1);
    }
    return d;
  };

  // Series — best-so-far (monotonic improvement)
  const yieldPath = path(data.map((d) => d.bestYield), 0, 100);
  const sheetsPath = path(data.map((d) => d.bestSheets), 0, maxSheets);
  const cutsPath = showCuts ? path(data.map((d) => d.bestCuts), 0, maxCuts) : '';

  // Final values for legend
  const last = data[data.length - 1];
  const trialLabel = (i: number) => String(i + 1);
  const title = isCncStrategy(state.lastStrategy)
    ? `Nesting convergence (${N} passes)`
    : `Optimiser convergence (${N} trials)`;

  convergenceChart.innerHTML = `
    <div class="conv-header">
      <span class="conv-title">${title}</span>
      <span class="conv-legend">
        <span class="ll yield">Yield ${last.bestYield.toFixed(1)}%</span>
        <span class="ll sheets">Sheets ${last.bestSheets}</span>
        ${showCuts ? `<span class="ll cuts">Cuts ${last.bestCuts}</span>` : ''}
      </span>
    </div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" class="conv-svg">
      <rect x="${PAD_L}" y="${PAD_T}" width="${plotW}" height="${plotH}" class="conv-plot-bg"/>
      <line x1="${PAD_L}" y1="${PAD_T + plotH}" x2="${PAD_L + plotW}" y2="${PAD_T + plotH}" class="conv-axis"/>
      <line x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${PAD_T + plotH}" class="conv-axis"/>
      <path d="${yieldPath}" class="conv-line yield" fill="none"/>
      <path d="${sheetsPath}" class="conv-line sheets" fill="none"/>
      <path d="${cutsPath}" class="conv-line cuts" fill="none"/>
      <text x="${PAD_L}" y="${H - 6}" class="conv-label">trial 1</text>
      <text x="${PAD_L + plotW}" y="${H - 6}" class="conv-label" text-anchor="end">trial ${trialLabel(N - 1)}</text>
    </svg>`;
}

/** True number of physical cuts for one sheet — its recorded guillotine cut
 *  tree (recovered post-pack for MaxRects 'free'/'save-last' layouts, native
 *  for the shelf packer) plus the two margin-trim cuts when there's a sheet
 *  margin. This is exactly the per-sheet count printed on the PDF
 *  cut-sequence cards, so the on-screen metrics, the convergence chart, and
 *  the document agree across every cut strategy. */
function sheetCutTotal(sheet: NestSheet, margin: number): number {
  return (sheet.cuts?.length ?? 0) + (margin > 0 ? 2 : 0);
}

function sumYield(sheets: NestSheet[]): number {
  let used = 0;
  let total = 0;
  for (const s of sheets) {
    used += s.usedArea;
    total += s.sheetW * s.sheetL;
  }
  return total > 0 ? used / total : 0;
}

function estimateResolution(sheetW: number, sheetL: number): number {
  const longer = Math.max(sheetW, sheetL);
  const r = longer / 600;
  return Math.max(1.5, Math.min(6, Math.round(r * 2) / 2));
}

function firstSheetKey(result: NestResult): string | null {
  for (let g = 0; g < result.groups.length; g++) {
    if (result.groups[g].sheets.length > 0) return `g${g}-s0`;
  }
  return null;
}

function findSheetByKey(key: string | null): { sheet: NestSheet; groupIdx: number; sheetIdx: number } | null {
  if (!state.lastNest || !key) return null;
  const m = key.match(/^g(\d+)-s(\d+)$/);
  if (!m) return null;
  const g = parseInt(m[1]);
  const s = parseInt(m[2]);
  const group = state.lastNest.groups[g];
  if (!group) return null;
  const sh = group.sheets[s];
  if (!sh) return null;
  return { sheet: sh, groupIdx: g, sheetIdx: s };
}

function renderResults() {
  const result = state.lastNest;
  const sz = state.lastSheet;
  if (!result || !sz) return;

  resultsEmpty.hidden = true;
  resultsDetail.hidden = false;
  downloadDxfBtn.disabled = false;
  downloadCutDxfBtn.disabled = false;
  downloadPdfBtn.disabled = false;
  downloadPhonePdfBtn.disabled = false;
  downloadCutlistPdfBtn.disabled = false;
  pushPartLabelsToViewer();
  const totalSheets = result.groups.reduce((a, g) => a + g.sheets.length, 0);

  // Stacked sheet list — every sheet rendered one below the other.
  if (!state.currentSheetKey) state.currentSheetKey = firstSheetKey(result);
  detailTitle.textContent = `${totalSheets} ${totalSheets === 1 ? 'sheet' : 'sheets'}`;
  detailSub.textContent = `kerf ${fmtDim(sz.kerf, state.units)} · margin ${fmtDim(sz.margin, state.units)}`;
  detailSvg.innerHTML = '';
  result.groups.forEach((g, gi) => {
    g.sheets.forEach((sh, si) => {
      const key = `g${gi}-s${si}`;
      const entry = document.createElement('section');
      entry.className = 'sheet-entry' + (key === state.currentSheetKey ? ' active' : '');
      entry.id = `sheet-${key}`;
      const tw = sh.sheetW, tl = sh.sheetL;
      const fill = sh.parts.length > 0 ? (sh.usedArea / (tw * tl)) * 100 : 0;
      const head = document.createElement('header');
      head.className = 'sheet-entry-header';
      head.innerHTML = `
        <div class="sheet-entry-title">Sheet ${sh.globalIndex || si + 1}</div>
        <div class="sheet-entry-meta">
          ${fmtDim(sh.thickness, state.units)} thick · ${sh.parts.length} parts ·
          <strong>${fill.toFixed(1)}%</strong> fill ·
          ${fmtDim(tw, state.units)} × ${fmtDim(tl, state.units)}
        </div>`;
      entry.appendChild(head);
      // "Edit cuts" — opens the manual cut-sequence editor for this sheet.
      // Panel-saw / track-saw sheets only (CNC sheets have no cut tree).
      if (!isCncStrategy(state.lastStrategy) && sh.cuts && sh.cuts.length > 0) {
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'edit-cuts-btn';
        editBtn.textContent = 'Edit cuts';
        editBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openCutEditor({
            sheet: sh,
            margin: sz.margin,
            kerf: sz.kerf,
            units: state.units,
            kerfRef: state.kerfRef,
            sequenceStyle: state.sequenceStyle,
            strategy: state.lastStrategy,
            jobName: state.jobName || 'Plywood cut estimate',
            onChange: () => { /* overrides persisted by the editor; PDF reads them */ },
          });
        });
        head.appendChild(editBtn);
      }
      const svgWrap = document.createElement('div');
      svgWrap.className = 'sheet-entry-svg';
      svgWrap.appendChild(buildSheetSvg(sh, tw, tl, sz.margin, true));
      entry.appendChild(svgWrap);
      // Click to select — visual highlight + remembered active key.
      entry.addEventListener('click', () => {
        state.currentSheetKey = key;
        for (const node of detailSvg.querySelectorAll('.sheet-entry')) node.classList.remove('active');
        entry.classList.add('active');
      });
      detailSvg.appendChild(entry);
    });
  });


  // Overall metrics, shopping list, unplaced parts
  renderJobMetrics();
  refreshShoppingFromNest();
  renderUnplaced();
}

function refreshShoppingFromNest() {
  if (!state.lastNest || !state.lastSheet) {
    state.shopping = [];
  } else {
    state.shopping = buildShoppingList(state.lastNest, state.lastSheet.w, state.lastSheet.l);
  }
  renderShoppingList();
}


function renderJobMetrics() {
  const result = state.lastNest!;
  const totalPlaced = result.groups.reduce(
    (a, g) => a + g.sheets.reduce((aa, s) => aa + s.parts.length, 0),
    0,
  );
  const totalUnplaced = result.groups.reduce((a, g) => a + g.unplaced.length, 0);

  // Edge-banding linear total = sum of perimeter of every placed part bbox.
  // (Cabinet edges that get banding are usually the visible outer edges; this
  // is an upper-bound assuming all four edges of every part are banded.)
  let edgeMm = 0;
  for (const g of result.groups) {
    for (const s of g.sheets) {
      for (const p of s.parts) {
        edgeMm += 2 * (p.w + p.h);
      }
    }
  }

  // Largest single offcut anywhere in the job (useful for "what could I
  // save for another job from leftover")
  let bigOff: { w: number; h: number; sheet: string } | null = null;
  result.groups.forEach((g, gi) => {
    g.sheets.forEach((s, si) => {
      if (!s.largestFree) return;
      const a = s.largestFree.w * s.largestFree.h;
      if (!bigOff || a > bigOff.w * bigOff.h) {
        bigOff = { w: s.largestFree.w, h: s.largestFree.h, sheet: `${gi + 1}.${si + 1}` };
      }
    });
  });

  // Total physical cuts across the job — the real recorded cut tree per
  // sheet plus margin trims, the same count shown on the PDF cut cards.
  // (Previously an interior-edge estimate that overcounted and ignored the
  // guillotine tree, so it disagreed with the document.)
  const margin = state.lastSheet?.margin ?? 0;
  let totalCuts = 0;
  for (const g of result.groups) {
    for (const s of g.sheets) totalCuts += sheetCutTotal(s, margin);
  }

  // CNC cuts a continuous contour — a discrete "cuts" count is meaningless, so
  // show the cut method instead.
  const cutsMetric = isCncStrategy(state.lastStrategy)
    ? `<div class="metric"><div class="k">Cut method</div><div class="v">CNC contour</div></div>`
    : `<div class="metric"><div class="k">Cuts</div><div class="v">${totalCuts}</div></div>`;

  detailMetrics.innerHTML = `
    <div class="metric"><div class="k">Total sheets</div><div class="v">${result.totalSheets}</div></div>
    <div class="metric"><div class="k">Parts placed</div><div class="v">${totalPlaced}</div></div>
    <div class="metric"><div class="k">Yield</div><div class="v">${(result.yield * 100).toFixed(1)}%</div></div>
    <div class="metric"><div class="k">Waste</div><div class="v">${fmtArea(result.totalSheetArea - result.totalPartArea, state.units)}</div></div>
    <div class="metric"><div class="k">Edge banding</div><div class="v">${fmtLinear(edgeMm, state.units)}</div></div>
    ${cutsMetric}
    ${bigOff ? `<div class="metric"><div class="k">Biggest offcut</div><div class="v">${fmtDim((bigOff as any).w, state.units)} × ${fmtDim((bigOff as any).h, state.units)}</div></div>` : ''}
    ${totalUnplaced > 0 ? `<div class="metric bad"><div class="k">Unplaced</div><div class="v">${totalUnplaced}</div></div>` : ''}
  `;
}

/* The shopping list lives in the sidebar — the in-result inventory block
 * is no longer rendered. We keep the empty container in place for layout. */
function renderInventoryCheckPlaceholder() {
  inventoryCheckEl.innerHTML = '';
}

function renderUnplaced() {
  const result = state.lastNest!;
  unplacedList.textContent = '';

  // Report what the CNC auto-split did, so a part suddenly appearing as
  // "Side panel 1/2, 2/2" in the cut sheet is explained.
  splitNote.textContent = state.splitInfo.length > 0
    ? 'Auto-split with dovetail joints: ' +
      state.splitInfo.map((s) => `${s.name} → ${s.pieces} pieces`).join(' · ')
    : '';

  const all = result.groups.flatMap((g) => g.unplaced.map((u) => `${u.partName} #${u.instance} (${fmtDim(g.thickness, state.units)})`));
  if (all.length === 0) return;

  const label = document.createElement('span');
  label.textContent = `Could not place: ${all.join(', ')}`;
  unplacedList.appendChild(label);

  // Offer a STEP file containing ONLY the unplaced bodies, so the user can
  // re-machine or re-nest just those parts elsewhere.
  if (unplacedStepParts().length > 0) {
    const btn = document.createElement('button');
    btn.className = 'ghost unplaced-dl';
    btn.textContent = 'Download STEP';
    btn.title = 'Download a STEP file containing only the unplaced parts';
    btn.addEventListener('click', downloadUnplacedSteps);
    unplacedList.appendChild(btn);
  }
}

/** One StepPart per unplaced INSTANCE, resolved back to its body geometry. */
function unplacedStepParts(): StepPart[] {
  const result = state.lastNest;
  if (!result) return [];
  const parts: StepPart[] = [];
  for (const g of result.groups) {
    for (const u of g.unplaced) {
      // Dovetail segments from the CNC auto-split don't map back to a body —
      // their geometry was captured when the split ran.
      const seg = state.splitSegmentGeo.get(u.partId);
      if (seg) {
        if (seg.outer.length < 3) continue;
        parts.push({
          name: `${u.partName} #${u.instance}`,
          outer: seg.outer,
          holes: seg.holes,
          thickness: seg.thickness,
        });
        continue;
      }
      const body = state.bodies.find((b) => String(b.id) === u.partId);
      if (!body) continue;
      const o = body.analysis.outline;
      if (!o.outer || o.outer.length < 3) continue;
      parts.push({
        name: `${u.partName} #${u.instance}`,
        outer: o.outer,
        holes: o.holes,
        thickness: g.thickness,
      });
    }
  }
  return parts;
}

/**
 * Assemble the PDF's "join split parts" guide from the last estimate: one
 * group per auto-split parent, segments in join order with the sheet panel
 * label ('1a-i') each one was nested under.
 */
/** Build the PDF Structure rows: one per selected body that placed at least
 *  one panel, screened under the default 20 kg uniform load. `idByBodyPartId`
 *  maps a body's partId → the panel codes it placed (e.g. ["1a", "3b"]). */
function buildStructureRows(idByBodyPartId: Map<string, string[]>): import('./pdf').StructureRow[] {
  const rows: import('./pdf').StructureRow[] = [];
  for (const b of state.bodies) {
    const codes = idByBodyPartId.get(String(b.id));
    if (!codes || codes.length === 0) continue;
    const mat = bodyMaterial(b);
    const scr = screenPanel(b.analysis.length, b.analysis.width, b.analysis.thickness, mat, { grain: b.grain, loadKg: 20 });
    rows.push({
      code: codes.join(', '),
      name: b.name,
      span: scr.span,
      material: mat.name,
      loadKg: 20,
      sagMm: scr.sagMm,
      verdict: scr.verdict,
    });
  }
  // Weakest first so the risky panels lead the table.
  const rank: Record<string, number> = { weak: 0, borderline: 1, ok: 2 };
  rows.sort((a, b) => (rank[a.verdict] - rank[b.verdict]) || (b.sagMm - a.sagMm));
  return rows;
}

function buildSplitJoins(): SplitJoinGroup[] {
  if (!state.lastNest || state.splitSegmentGeo.size === 0) return [];
  // First placement of each segment id → its sheet + label.
  const placed = new Map<string, { label: string; sheetNo: number }>();
  for (const g of state.lastNest.groups) {
    for (const s of g.sheets) {
      for (const p of s.parts) {
        if (!placed.has(p.partId)) {
          placed.set(p.partId, { label: `${s.globalIndex}${p.panelLabel}`, sheetNo: s.globalIndex });
        }
      }
    }
  }
  const byParent = new Map<string, SplitJoinGroup>();
  const entries = Array.from(state.splitSegmentGeo.entries()).sort((a, b) =>
    a[1].parentId === b[1].parentId
      ? a[1].segIndex - b[1].segIndex
      : a[1].parentId.localeCompare(b[1].parentId));
  for (const [id, seg] of entries) {
    let grp = byParent.get(seg.parentId);
    if (!grp) {
      grp = { parentName: seg.parentName, thickness: seg.thickness, segments: [] };
      byParent.set(seg.parentId, grp);
    }
    const hit = placed.get(id);
    grp.segments.push({
      roman: toRoman(seg.segIndex),
      label: hit?.label ?? null,
      sheetNo: hit?.sheetNo ?? null,
      outer: seg.outer,
      holes: seg.holes,
      offsetX: seg.offsetX,
      offsetY: seg.offsetY,
      color: seg.color,
    });
  }
  return Array.from(byParent.values());
}

function downloadUnplacedSteps() {
  const parts = unplacedStepParts();
  if (parts.length === 0) return;
  const step = buildStep(parts, new Date().toISOString());
  const blob = new Blob([step], { type: 'application/step' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'unplaced-parts.step';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// --------------------------------------------------------------------------
// SVG rendering — used by both detail and thumbnails
// --------------------------------------------------------------------------
function buildSheetSvg(
  sheet: NestSheet,
  sheetW: number,
  sheetL: number,
  margin: number,
  withDimensions: boolean,
): SVGSVGElement {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  const dimPad = withDimensions ? 30 : 4;
  svg.setAttribute(
    'viewBox',
    `${-dimPad} ${-dimPad} ${sheetW + dimPad * 2} ${sheetL + dimPad * 2}`,
  );
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  // Sheet border
  const border = document.createElementNS(svgNS, 'rect');
  border.setAttribute('class', 'sheet-border');
  border.setAttribute('x', '0'); border.setAttribute('y', '0');
  border.setAttribute('width', String(sheetW));
  border.setAttribute('height', String(sheetL));
  svg.appendChild(border);

  // Margin
  if (margin > 0) {
    const mr = document.createElementNS(svgNS, 'rect');
    mr.setAttribute('class', 'margin-rect');
    mr.setAttribute('x', String(margin));
    mr.setAttribute('y', String(margin));
    mr.setAttribute('width', String(sheetW - 2 * margin));
    mr.setAttribute('height', String(sheetL - 2 * margin));
    svg.appendChild(mr);
  }

  // Parts
  for (const p of sheet.parts) {
    svg.appendChild(buildPartShape(svgNS, p, withDimensions, sheet.globalIndex));
  }

  // Overall sheet dimensions (ANSI: dim lines OUTSIDE the sheet with
  // triangular arrowheads + small witness lines from the sheet corners).
  if (withDimensions) {
    svg.appendChild(buildAnsiDimH(svgNS, 0, sheetW, sheetL + 12, fmtDim(sheetW, state.units)));
    svg.appendChild(buildAnsiDimV(svgNS, 0, sheetL, -12, fmtDim(sheetL, state.units)));
  }

  return svg;
}

function buildPartShape(
  svgNS: string,
  p: PlacedPart,
  withLabels: boolean,
  sheetGlobalIndex: number,
): SVGElement {
  const g = document.createElementNS(svgNS, 'g') as SVGGElement;
  g.setAttribute('transform', `translate(${p.x}, ${p.y})`);

  // Parts use their per-body color so the 2D layout maps 1:1 to the 3D view.
  // Sheet background is dark plywood (set in CSS) so the colored parts pop
  // as distinct chunks taken out of the sheet.
  const path = document.createElementNS(svgNS, 'path');
  let d = ringToPath(p.outer);
  for (const h of p.holes) d += ' ' + ringToPath(h);
  path.setAttribute('d', d);
  path.setAttribute('fill-rule', 'evenodd');
  path.setAttribute('fill', p.color);
  path.setAttribute('fill-opacity', '0.95');
  path.setAttribute('stroke', darken(p.color));
  path.setAttribute('stroke-width', '0.8');
  g.appendChild(path);

  if (withLabels) {
    // Grain / orientation arrow along the AABB's longer side
    const cx = p.w / 2, cy = p.h / 2;
    const half = Math.min(p.w, p.h) * 0.22;
    const arrow = document.createElementNS(svgNS, 'path');
    if (p.w >= p.h) {
      arrow.setAttribute('d',
        `M ${cx - half},${cy} L ${cx + half},${cy} M ${cx + half - 5},${cy - 4} L ${cx + half},${cy} L ${cx + half - 5},${cy + 4}`);
    } else {
      arrow.setAttribute('d',
        `M ${cx},${cy - half} L ${cx},${cy + half} M ${cx - 4},${cy + half - 5} L ${cx},${cy + half} L ${cx + 4},${cy + half - 5}`);
    }
    arrow.setAttribute('class', 'grain-arrow');
    g.appendChild(arrow);

    // Per-sheet panel label: "1a", "2c", etc. Matches the cut list and
    // PDF references. Dimensions live in the Parts overview table only
    // (ANSI-clean: don't clutter the layout with per-part dim arrows).
    const panelId = `${sheetGlobalIndex}${p.panelLabel}`;
    const bigSize = Math.max(10, Math.min(36, Math.min(p.w, p.h) * 0.34));
    const bigLabel = document.createElementNS(svgNS, 'text');
    bigLabel.setAttribute('class', 'part-label');
    bigLabel.setAttribute('x', String(p.w / 2));
    bigLabel.setAttribute('y', String(p.h / 2 + bigSize * 0.18));
    bigLabel.setAttribute('font-size', String(bigSize));
    bigLabel.setAttribute('font-weight', '700');
    bigLabel.textContent = panelId;
    g.appendChild(bigLabel);

    // Compact dimensions sub-label (just a quick visual reference).
    const labelSize = Math.max(6, Math.min(11, Math.min(p.w, p.h) * 0.08));
    const dimLabel = document.createElementNS(svgNS, 'text');
    dimLabel.setAttribute('class', 'part-label');
    dimLabel.setAttribute('x', String(p.w / 2));
    dimLabel.setAttribute('y', String(p.h / 2 + bigSize * 0.55 + labelSize));
    dimLabel.setAttribute('font-size', String(labelSize));
    dimLabel.setAttribute('font-weight', '400');
    dimLabel.textContent = `${fmtDim(p.w, state.units)} × ${fmtDim(p.h, state.units)}`;
    g.appendChild(dimLabel);
  }

  return g;
}

/**
 * ANSI-style HORIZONTAL dimension between (x1) and (x2) at vertical
 * coordinate `y`. Witness lines drop from the sheet edge to the dim
 * line; triangular arrowheads point INWARD at each end; text is
 * horizontal, centered ABOVE the dim line.
 *
 * Constants tuned for the SVG viewBox in mm (we use ~10-mm-tall text
 * so it stays readable when the SVG scales down to fit a card).
 */
function buildAnsiDimH(
  svgNS: string,
  x1: number, x2: number, y: number,
  label: string,
): SVGElement {
  const g = document.createElementNS(svgNS, 'g') as SVGGElement;
  // Witness lines from sheet edge → dim line (with a small gap from the edge)
  const witnessOver = 4;
  const witnessGap = 1.5;
  const wA = document.createElementNS(svgNS, 'line');
  wA.setAttribute('class', 'dim-line');
  wA.setAttribute('x1', String(x1)); wA.setAttribute('x2', String(x1));
  wA.setAttribute('y1', String(y - witnessOver - 2));
  wA.setAttribute('y2', String(y + witnessGap));
  g.appendChild(wA);
  const wB = document.createElementNS(svgNS, 'line');
  wB.setAttribute('class', 'dim-line');
  wB.setAttribute('x1', String(x2)); wB.setAttribute('x2', String(x2));
  wB.setAttribute('y1', String(y - witnessOver - 2));
  wB.setAttribute('y2', String(y + witnessGap));
  g.appendChild(wB);
  // Dim line
  const line = document.createElementNS(svgNS, 'line');
  line.setAttribute('class', 'dim-line');
  line.setAttribute('x1', String(x1)); line.setAttribute('x2', String(x2));
  line.setAttribute('y1', String(y));  line.setAttribute('y2', String(y));
  g.appendChild(line);
  // Arrowheads (pointing inward)
  g.appendChild(svgArrow(svgNS, x1, y, 1, 0));
  g.appendChild(svgArrow(svgNS, x2, y, -1, 0));
  // Text — horizontal, centered above the dim line
  const text = document.createElementNS(svgNS, 'text');
  text.setAttribute('class', 'dim-text');
  text.setAttribute('x', String((x1 + x2) / 2));
  text.setAttribute('y', String(y - 4));
  text.setAttribute('text-anchor', 'middle');
  text.textContent = label;
  g.appendChild(text);
  return g;
}

/** ANSI vertical dim — same conventions, rotated. */
function buildAnsiDimV(
  svgNS: string,
  y1: number, y2: number, x: number,
  label: string,
): SVGElement {
  const g = document.createElementNS(svgNS, 'g') as SVGGElement;
  const witnessOver = 4;
  const witnessGap = 1.5;
  const wA = document.createElementNS(svgNS, 'line');
  wA.setAttribute('class', 'dim-line');
  wA.setAttribute('x1', String(x - witnessGap)); wA.setAttribute('x2', String(x + witnessOver + 2));
  wA.setAttribute('y1', String(y1)); wA.setAttribute('y2', String(y1));
  g.appendChild(wA);
  const wB = document.createElementNS(svgNS, 'line');
  wB.setAttribute('class', 'dim-line');
  wB.setAttribute('x1', String(x - witnessGap)); wB.setAttribute('x2', String(x + witnessOver + 2));
  wB.setAttribute('y1', String(y2)); wB.setAttribute('y2', String(y2));
  g.appendChild(wB);
  const line = document.createElementNS(svgNS, 'line');
  line.setAttribute('class', 'dim-line');
  line.setAttribute('x1', String(x)); line.setAttribute('x2', String(x));
  line.setAttribute('y1', String(y1)); line.setAttribute('y2', String(y2));
  g.appendChild(line);
  g.appendChild(svgArrow(svgNS, x, y1, 0, 1));
  g.appendChild(svgArrow(svgNS, x, y2, 0, -1));
  // Rotated text, centered along dim line
  const text = document.createElementNS(svgNS, 'text');
  text.setAttribute('class', 'dim-text');
  const tx = x - 4;
  const ty = (y1 + y2) / 2;
  text.setAttribute('x', String(tx));
  text.setAttribute('y', String(ty));
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('transform', `rotate(-90, ${tx}, ${ty})`);
  text.textContent = label;
  g.appendChild(text);
  return g;
}

/**
 * Small filled triangle arrowhead in SVG, pointing in (dx, dy) direction.
 * Used by the ANSI dim helpers.
 */
function svgArrow(svgNS: string, x: number, y: number, dx: number, dy: number): SVGElement {
  const len = 4.5;
  const w = 1.6;
  // Build a triangle: tip at (x, y), base perpendicular to (dx, dy)
  let p1: [number, number], p2: [number, number], p3: [number, number];
  if (dx !== 0) {
    p1 = [x, y];
    p2 = [x - dx * len, y - w];
    p3 = [x - dx * len, y + w];
  } else {
    p1 = [x, y];
    p2 = [x - w, y - dy * len];
    p3 = [x + w, y - dy * len];
  }
  const poly = document.createElementNS(svgNS, 'polygon') as SVGPolygonElement;
  poly.setAttribute('class', 'dim-arrow');
  poly.setAttribute('points', `${p1[0]},${p1[1]} ${p2[0]},${p2[1]} ${p3[0]},${p3[1]}`);
  return poly;
}

function ringToPath(ring: [number, number][]): string {
  if (ring.length === 0) return '';
  let d = `M ${ring[0][0]},${ring[0][1]}`;
  for (let i = 1; i < ring.length; i++) d += ` L ${ring[i][0]},${ring[i][1]}`;
  return d + ' Z';
}

function darken(hex: string): string {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return '#000';
  const n = parseInt(m[1], 16);
  const r = Math.max(0, Math.floor(((n >> 16) & 255) * 0.55));
  const g = Math.max(0, Math.floor(((n >> 8) & 255) * 0.55));
  const b = Math.max(0, Math.floor((n & 255) * 0.55));
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

// --------------------------------------------------------------------------
// Downloads
// --------------------------------------------------------------------------
downloadDxfBtn.addEventListener('click', () => {
  const sel = findSheetByKey(state.currentSheetKey);
  if (!sel || !state.lastSheet) return;
  const dxf = sheetToDxf(sel.sheet, {
    sheetW: sel.sheet.sheetW,
    sheetL: sel.sheet.sheetL,
    margin: state.lastSheet.margin,
    units: state.units,
    partDimensions: true,
    sheetDimensions: true,
  });
  downloadDxf(`sheet_${sel.groupIdx + 1}_${sel.sheetIdx + 1}.dxf`, dxf);
});

// "Cut DXF" — outlines + sheet boundary only (no labels/dims), for feeding
// straight into a CNC router / waterjet program.
downloadCutDxfBtn.addEventListener('click', () => {
  const sel = findSheetByKey(state.currentSheetKey);
  if (!sel || !state.lastSheet) return;
  const dxf = sheetToDxf(sel.sheet, {
    sheetW: sel.sheet.sheetW,
    sheetL: sel.sheet.sheetL,
    margin: state.lastSheet.margin,
    units: state.units,
    partDimensions: false,
    sheetDimensions: false,
    outlinesOnly: true,
  });
  downloadDxf(`sheet_${sel.groupIdx + 1}_${sel.sheetIdx + 1}_cut.dxf`, dxf);
});

// Shared by the PDF button (paper format from the settings dropdown) and the
// Phone PDF button (forces the one-cut-per-page mobile format).
async function exportPdf(btn: HTMLButtonElement, paper: string) {
  if (!state.lastNest || !state.lastSheet) return;
  // Mark the button busy + show a progress indicator so the user knows the
  // (multi-second) snapshot capture + PDF assembly is running. We yield to
  // the browser between phases via requestAnimationFrame + await so the
  // progress bar actually updates between heavy synchronous work.
  const originalLabel = btn.innerHTML;
  downloadPdfBtn.disabled = true;
  downloadPhonePdfBtn.disabled = true;
  downloadCutlistPdfBtn.disabled = true;
  btn.classList.add('busy');
  const setProgress = (label: string, pct: number) => {
    btn.innerHTML = `<span class="progress-bar"><span class="progress-fill" style="width:${pct.toFixed(0)}%"></span></span><span class="progress-label">${label}</span>`;
  };
  setProgress('Preparing…', 5);
  await yieldFrame();

  // Pass the shopping list rows to the PDF as the "inventoryCheck" section
  // (the PDF module renders them as Need / Have / Shortfall).
  const invChecks: InventoryCheck[] = state.shopping.map((r) => ({
    thickness: r.thickness,
    needed: r.need,
    available: r.have,
    label: `${fmtDim(r.thickness, state.units)} · ${fmtDim(r.sheetW, state.units)} × ${fmtDim(r.sheetL, state.units)}`,
  }));
  // Sum edge banding for the PDF header
  let edgeMm = 0;
  for (const g of state.lastNest.groups) {
    for (const s of g.sheets) {
      for (const p of s.parts) edgeMm += 2 * (p.w + p.h);
    }
  }
  // Capture viewer snapshots — one assembly diagram PER STEP FILE since
  // each STEP file is treated as a unique cabinet / furniture piece.
  // Group selected sheet-good bodies by their fileTag, then for each
  // cabinet generate (1) assembled snapshot of just its bodies and
  // (2) exploded snapshot pulling each panel along an OUTWARD-FROM-CENTER
  // direction. Panel face normals are unreliable here (a shelf normal can
  // point INTO another panel); using outward-from-center guarantees the
  // explode direction is clear of the rest of the assembly.
  const explodeDist = Math.max(20, viewer.modelDiagonal() * 0.28);

  const byFile = new Map<string, BodyState[]>();
  for (const b of state.bodies.filter((x) => x.selected)) {
    const arr = byFile.get(b.fileTag) ?? [];
    arr.push(b);
    byFile.set(b.fileTag, arr);
  }

  // Per-cabinet center → per-body outward direction. Falls back to faceNormal
  // for the rare case where the body sits AT the cabinet center.
  const directions = new Map<number, [number, number, number]>();
  for (const bodies of byFile.values()) {
    let cx = 0, cy = 0, cz = 0;
    for (const b of bodies) {
      cx += b.analysis.centerWorld[0];
      cy += b.analysis.centerWorld[1];
      cz += b.analysis.centerWorld[2];
    }
    cx /= bodies.length; cy /= bodies.length; cz /= bodies.length;
    for (const b of bodies) {
      const dx = b.analysis.centerWorld[0] - cx;
      const dy = b.analysis.centerWorld[1] - cy;
      const dz = b.analysis.centerWorld[2] - cz;
      const len = Math.hypot(dx, dy, dz);
      if (len > 1e-3) {
        directions.set(b.id, [dx / len, dy / len, dz / len]);
      } else {
        directions.set(b.id, b.analysis.faceNormal);
      }
    }
  }

  // Build per-panel id ("3a") from the lastNest so PDF panel ids match.
  // Also build a panel-detail map for the step-by-step assembly cards.
  const idByBodyPartId = new Map<string, string[]>();
  const panelById = new Map<string, import('./pdf').CabinetPanel>();
  if (state.lastNest) {
    for (const g of state.lastNest.groups) {
      for (const s of g.sheets) {
        for (const p of s.parts) {
          const id = `${s.globalIndex}${p.panelLabel}`;
          const arr = idByBodyPartId.get(p.partId) ?? [];
          arr.push(id);
          idByBodyPartId.set(p.partId, arr);
          panelById.set(id, {
            id,
            length: Math.max(p.w, p.h),
            width: Math.min(p.w, p.h),
            thickness: g.thickness,
            name: p.partName,
            color: p.color,
          });
        }
      }
    }
  }

  // Structure + Assembly analysis are ONLY included when the user actually ran
  // an ASSEMBLY solve this session. If nobody solved, the job PDF has no
  // Structure table, no Assembly analysis page, and no TOC entries for them —
  // as if the feature didn't exist. The live sidebar screening line + weak
  // badges are unaffected (that screening is always on, read-only).
  const caeRan = assemblySolved();
  const structure = caeRan ? buildStructureRows(idByBodyPartId) : undefined;
  const assembly = caeRan && state.asm.analysis ? toAsmPdf(state.asm.analysis) : undefined;

  // Use a clean WHITE scene background + faint shadow floor for all PDF
  // snapshots — the dark studio backdrop the live viewer uses prints
  // poorly. exitPdfBg restores the live look at the end.
  const tCapture0 = performance.now();
  const cabinets: import('./pdf').CabinetSnapshot[] = [];
  let assembledPng: string | undefined;
  let explodedPng: string | undefined;
  // Assembly pages off → skip the capture entirely rather than rendering
  // snapshots the document will discard. This is the slow half of the export
  // (two full composer passes per cabinet), so the toggle is also the fastest
  // way to get a PDF out.
  if (!optAssembly.checked) {
    setProgress('Building PDF…', 80);
    await yieldFrame();
  } else {
    viewer.enterPdfBg();
    try {
      // Two render targets — cover gets a near-square aspect to fill the
      // half-page snapshot box; IKEA step cards are wide (2:1-ish) and use a
      // 16:9 target so the cabinet fills the card horizontally. Step cards
      // print at ~6 × 3.4in — 1280×720 is ~180 dpi there, plenty.
      const SHOT_COVER = { w: 1200, h: 1100 };
      const SHOT_STEP  = { w: 1280, h: 720 };
      const fileCount = byFile.size;
      let fileIdx = 0;
      for (const [tag, bodies] of byFile) {
        fileIdx++;
        setProgress(`Capturing ${tag}…`, 10 + (70 * (fileIdx - 1) / Math.max(1, fileCount)));
        await yieldFrame();
        const visibleIds = new Set(bodies.map((b) => b.id));
        viewer.beginSnapshotBatch(SHOT_COVER);
        const assembled = viewer.snapshotFiltered(visibleIds, null, 0, undefined, SHOT_COVER);
        const exploded = viewer.snapshotFiltered(visibleIds, directions, explodeDist, undefined, SHOT_COVER);
        const ids: string[] = [];
        for (const b of bodies) {
          const arr = idByBodyPartId.get(String(b.id));
          if (arr) ids.push(...arr);
        }
        const panels = ids
          .map((id) => panelById.get(id))
          .filter((p): p is import('./pdf').CabinetPanel => p !== undefined);

        // IKEA-style per-step snapshots: install one body at a time. For step i
        // we render bodies[0..i] visible, with body i alone floating along its
        // face-normal so the user sees where it's being installed. All steps
        // share one camera (frameIds = the full cabinet) so the scale doesn't
        // jump between steps. The final step is the fully-assembled state so
        // the user clearly sees the "done" position.
        const stepDist = Math.max(15, explodeDist * 0.28);
        const steps: import('./pdf').SnapshotImage[] = [];
        const stepPanelIds: string[] = [];
        viewer.beginSnapshotBatch(SHOT_STEP); // switch batch size once for all steps
        for (let i = 0; i < bodies.length; i++) {
          const installed = new Set<number>();
          for (let j = 0; j <= i; j++) installed.add(bodies[j].id);
          const stepDirs = new Map<number, [number, number, number]>();
          const dir = directions.get(bodies[i].id);
          if (dir) stepDirs.set(bodies[i].id, dir);
          const img = viewer.snapshotFiltered(installed, stepDirs, stepDist, visibleIds, SHOT_STEP);
          steps.push(img);
          const arr = idByBodyPartId.get(String(bodies[i].id)) ?? [];
          stepPanelIds.push(arr[0] ?? `body ${bodies[i].id}`);
        }
        // Final "done" frame — every panel back in its rest position, nothing
        // exploded. Reuses the same camera so it visually matches the previous
        // step but with the last panel settled.
        if (bodies.length > 0) {
          const doneImg = viewer.snapshotFiltered(visibleIds, null, 0, visibleIds, SHOT_STEP);
          steps.push(doneImg);
          stepPanelIds.push('done');
        }

        cabinets.push({
          name: tag, partIds: ids, panels,
          assembled, exploded,
          steps, stepPanelIds,
        });
      }
      // Backwards-compat fallback: combined all-cabinet snapshots — only
      // captured when no per-cabinet snapshots exist (the PDF ignores them
      // otherwise, so rendering them would be two wasted full-scene passes).
      if (cabinets.length === 0) {
        viewer.endSnapshotBatch();
        assembledPng = viewer.snapshot().dataUrl;
        explodedPng = viewer.snapshotExploded(directions, explodeDist).dataUrl;
      }
    } catch (err) {
      console.warn('Per-cabinet snapshot failed; assembly pages skipped.', err);
    } finally {
      viewer.endSnapshotBatch();
      viewer.exitPdfBg();
    }
  }

  const tBuild0 = performance.now();
  setProgress('Building PDF…', 85);
  await yieldFrame();
  const doc = buildPdf(state.lastNest, {
    sheetW: state.lastSheet.w,
    sheetL: state.lastSheet.l,
    margin: state.lastSheet.margin,
    kerf: state.lastSheet.kerf,
    units: state.units,
    inventoryCheck: invChecks,
    jobName: state.jobName || 'Plywood cut estimate',
    paper: paper as any,
    kerfRef: state.kerfRef,
    sequenceStyle: state.sequenceStyle,
    overridesBySig: loadAllOverrides(),
    currency: state.currency,
    jobCost: totalCost(state.shopping),
    edgeBandingMm: edgeMm,
    assembledPng,
    explodedPng,
    cabinets,
    cnc: isCncStrategy(state.lastStrategy),
    splitJoins: buildSplitJoins(),
    structure,
    assembly,
    sections: currentSections(),
  });
  setProgress('Saving…', 98);
  await yieldFrame();
  const tSave0 = performance.now();
  const safe = (state.jobName || 'plywood_cut_estimate').replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
  downloadPdf(`${safe}${paper === 'mobile' ? '_phone' : ''}.pdf`, doc);
  console.log(
    `pdf: snapshots ${(tBuild0 - tCapture0).toFixed(0)}ms · build ${(tSave0 - tBuild0).toFixed(0)}ms · save ${(performance.now() - tSave0).toFixed(0)}ms`,
  );
  // Restore buttons
  btn.innerHTML = originalLabel;
  btn.classList.remove('busy');
  downloadPdfBtn.disabled = false;
  downloadPhonePdfBtn.disabled = false;
  downloadCutlistPdfBtn.disabled = false;
}

downloadPdfBtn.addEventListener('click', () => exportPdf(downloadPdfBtn, pdfPaperSelect.value));
downloadPhonePdfBtn.addEventListener('click', () => exportPdf(downloadPhonePdfBtn, 'mobile'));

/**
 * Push each body's sheet panel id ("1a", or "1a,2c" when a part is split
 * across sheets) to the 3D view. `partId` IS the source body id, which is
 * what lets a body in the viewport be matched to its code on the cut sheets.
 * Called after every estimate; the viewer only materialises the DOM labels
 * while the toggle is on.
 */
function pushPartLabelsToViewer() {
  const byBody = new Map<number, string[]>();
  for (const g of state.lastNest?.groups ?? []) {
    for (const s of g.sheets) {
      for (const p of s.parts) {
        const id = Number(p.partId);
        if (!Number.isFinite(id)) continue;
        const arr = byBody.get(id) ?? [];
        arr.push(`${s.globalIndex}${p.panelLabel}`);
        byBody.set(id, arr);
      }
    }
  }
  viewer.setPartLabels(
    [...byBody].map(([id, ids]) => ({ id, text: [...new Set(ids)].sort().join(',') })),
  );
}

opt3dLabels.addEventListener('change', () => {
  viewer.setPartLabelsVisible(opt3dLabels.checked);
});

/** Current state of the export Options menu, shared by both PDF exports. */
function currentSections(): import('./pdf').PdfSections {
  return {
    assembly: optAssembly.checked,
    panelLists: optPanelLists.checked,
    cutSteps: optCutSteps.checked,
  };
}

// Cutlist PDF — one sheet-overview page per cut sheet (layout + panel
// dimensions only) at the page size chosen in "Cutlist page", plus an
// assembly page per cabinet: front + back 3/4 snapshots with panel-id
// balloons on the panels. The snapshots are synchronous captures — none of
// the job PDF's per-cabinet progress plumbing.
downloadCutlistPdfBtn.addEventListener('click', () => {
  if (!state.lastNest || !state.lastSheet) return;
  // Panel ids per source body — partId IS the source body id, so the
  // balloons on the assembly views carry the same "1a" codes as the sheets.
  const idsByPartId = new Map<string, string[]>();
  for (const g of state.lastNest.groups) {
    for (const s of g.sheets) {
      for (const p of s.parts) {
        const arr = idsByPartId.get(p.partId) ?? [];
        arr.push(`${s.globalIndex}${p.panelLabel}`);
        idsByPartId.set(p.partId, arr);
      }
    }
  }
  // "Match PDF paper" (the default) tracks the job-PDF paper select, so
  // changing ONE size control changes both exports. The explicit entries
  // below it still let the cutlist differ from the job PDF.
  const cutlistPaper: CutlistPaper = cutlistPaperSelect.value === 'match'
    ? ((pdfPaperSelect.value as CutlistPaper) || 'widescreen-16-9')
    : ((cutlistPaperSelect.value as CutlistPaper) || 'cutlist-4-3');
  const selectedBodies = state.bodies.filter((b) => b.selected);
  const assemblyViews: import('./pdf').CutlistAssemblyViews[] = [];
  // Same rule as the job PDF: assembly off → don't render snapshots that the
  // document is going to drop.
  if (selectedBodies.length > 0 && optAssembly.checked) {
    try {
      viewer.enterPdfBg();
      const byFile = new Map<string, BodyState[]>();
      for (const b of selectedBodies) {
        const arr = byFile.get(b.fileTag) ?? [];
        arr.push(b);
        byFile.set(b.fileTag, arr);
      }
      // Portrait-ish target matching the half-page column each view lands in
      // ON THE CHOSEN PAGE — a bigger page gets a bigger capture instead of
      // an upscaled one. snapshotFiltered refits the camera and hides
      // live-view overlays.
      const SHOT = cutlistSnapshotTarget(cutlistPaper);
      for (const [tag, bodies] of byFile) {
        const vis = new Set(bodies.map((b) => b.id));
        const labelText = new Map<number, string>();
        for (const b of bodies) {
          labelText.set(b.id, (idsByPartId.get(String(b.id)) ?? []).join(','));
        }
        const mkView = (dir: [number, number, number]): import('./pdf').CutlistView => {
          const shot = viewer.snapshotFiltered(vis, null, 0, undefined, SHOT, dir);
          return {
            image: shot,
            labels: shot.anchors
              .map((a) => ({ x: a.x, y: a.y, text: labelText.get(a.id) ?? '' }))
              .filter((l) => l.text),
          };
        };
        assemblyViews.push({
          name: byFile.size > 1 ? tag : undefined,
          front: mkView([1.0, -1.2, 0.9]),
          back: mkView([-1.0, 1.2, 0.9]),
        });
      }
    } catch (err) {
      console.warn('Cutlist assembly snapshots failed; assembly pages skipped.', err);
    } finally {
      viewer.exitPdfBg();
    }
  }
  const doc = buildCutlistPdf(state.lastNest, {
    sheetW: state.lastSheet.w,
    sheetL: state.lastSheet.l,
    margin: state.lastSheet.margin,
    kerf: state.lastSheet.kerf,
    units: state.units,
    jobName: state.jobName || 'Plywood cut estimate',
    cutlistPaper,
    sections: currentSections(),
    assemblyViews: assemblyViews.length > 0 ? assemblyViews : undefined,
  });
  const safe = (state.jobName || 'plywood_cut_estimate').replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
  downloadPdf(`${safe}_cutlist.pdf`, doc);
});

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
  ));
}
function escapeHtmlAttr(s: string): string {
  return escapeHtml(s);
}
