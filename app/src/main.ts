/**
 * Glue layer for the plywood estimator UI.
 * - File handling + STEP parsing
 * - Sidebar: sheet config, bodies, inventory
 * - Viewer + click-selection sync
 * - Estimate → multi-restart nester
 * - Results: detail view + thumbnail strip + DXF/PDF downloads
 */

import './style.css';

// Build-time-injected git info (see vite.config.ts `define`).
declare const __GIT_SHA__: string;
declare const __GIT_AUTHOR__: string;
declare const __GIT_DATE__: string;

import { parseStep, type OcctResult } from './stepLoader';
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
} from './nest';
import { sheetToDxf, downloadDxf } from './dxf';
import { buildPdf, downloadPdf, type InventoryCheck } from './pdf';
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
import { assignPartLabels, type PartLabel } from './instructions';
import { fmtDim, fmtArea, fmtLinear, fmtMoney, toMm, fromMm, type Units } from './units';

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
}

const state: {
  result: OcctResult | null;
  bodies: BodyState[];
  units: Units;
  lastNest: NestResult | null;
  lastSheet: { w: number; l: number; margin: number; kerf: number } | null;
  shopping: ShoppingRow[];
  currentSheetKey: string | null;   // "g{groupIdx}-s{sheetIdx}"
  currency: string;
  jobName: string;
  partLabels: Map<string, PartLabel>;
  nonSheetCount: number;
  /** Per-fileTag UI state: collapsed (true) hides the bodies inside this
   *  file group. Defaults to expanded when a new file is loaded. */
  collapsedFiles: Set<string>;
} = {
  result: null,
  bodies: [],
  units: 'in',
  lastNest: null,
  lastSheet: null,
  shopping: [],
  currentSheetKey: null,
  currency: 'USD',
  jobName: '',
  partLabels: new Map(),
  nonSheetCount: 0,
  collapsedFiles: new Set<string>(),
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
const bodyList = $('bodyList');
const bodyCount = $('bodyCount');
const versionLine = $('versionLine');
// Inject git build info from vite define. Keep it terse: "0123abc · author · 2026-05-27"
if (versionLine) {
  const parts = [__GIT_SHA__, __GIT_AUTHOR__, __GIT_DATE__].filter(Boolean);
  versionLine.textContent = parts.join(' · ');
}
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
const restartsSelect = $<HTMLSelectElement>('restarts');
const cutStrategySelect = $<HTMLSelectElement>('cutStrategy');
const viewerEl = $('viewer');

const resultsEmpty = $('resultsEmpty');
const resultsDetail = $('resultsDetail');
const detailTitle = $('detailTitle');
const detailSub = $('detailSub');
const detailSvg = $('detailSvg');
const detailMetrics = $('detailMetrics');
const inventoryCheckEl = $('inventoryCheck');
const unplacedList = $('unplacedList');
const downloadDxfBtn = $<HTMLButtonElement>('downloadDxfBtn');
const downloadPdfBtn = $<HTMLButtonElement>('downloadPdfBtn');

const shopList = $('shoppingList');
const shopCount = $('shopCount');
const shopCopyBtn = $<HTMLButtonElement>('shopCopyBtn');
const shopCsvBtn = $<HTMLButtonElement>('shopCsvBtn');
const shopTotals = $('shopTotals');
const jobNameInput = $<HTMLInputElement>('jobName');
const currencySelect = $<HTMLSelectElement>('currency');
const pdfPaperSelect = $<HTMLSelectElement>('pdfPaper');

// --------------------------------------------------------------------------
// Viewer
// --------------------------------------------------------------------------
const viewer = new Viewer(viewerEl);
viewer.setSelectionListener(() => {
  for (const b of state.bodies) {
    b.selected = viewer.selection.has(b.id);
  }
  pushAllGrainToViewer();
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
  try {
    for (const file of list) {
      const buf = await file.arrayBuffer();
      const res = await parseStep(buf);
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
      res.meshes.forEach((m, meshIdx) => {
        const indices = m.index?.array;
        if (!indices || indices.length < 3) return;
        try {
          const analysis = analyzeBody(m);
          if (!analysis) {
            // Body isn't sheet-good shaped (round leg, dowel, block, …)
            // — still show it in 3D in red dashed so the user knows it
            // was imported but excluded from the cut list.
            viewer.addNonSheetMesh(m);
            totalSkippedNotSheet++;
            state.nonSheetCount++;
            return;
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
          });
          viewer.addOcctMesh(m, id, hex, displayName);
          perFileValid++;
          totalAdded++;
        } catch (e) {
          console.warn(`Failed to analyze body in ${file.name}:`, e);
        }
      });
    }

    viewer.finishLoad();
    // Auto-select all newly-loaded sheet-good bodies so the user can hit
    // "Estimate" immediately. Non-sheet bodies were already excluded.
    for (const b of state.bodies) b.selected = true;
    syncViewerSelectionFromState();
    pushAllGrainToViewer();
    renderBodyList();
    updateNestBtn();
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
  }
}

function clearAll() {
  state.bodies = [];
  state.result = null;
  state.nonSheetCount = 0;
  state.partLabels = new Map();
  nextBodyId = 0;
  cumulativeRightX = 0;
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
      </label>`;
    extra.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-field]').forEach((el) => {
      el.addEventListener('change', () => {
        const field = el.dataset.field!;
        if (field === 'qty') b.qty = Math.max(1, parseInt((el as HTMLInputElement).value) || 1);
        if (field === 'grain') {
          b.grain = (el as HTMLSelectElement).value as GrainLock;
          pushGrainToViewer(b);
        }
        if (field === 'rotation') b.rotation = (el as HTMLSelectElement).value as RotationMode;
      });
    });
    row.appendChild(extra);
  }
  return row;
}

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
presetSelect.addEventListener('change', () => {
  const v = presetSelect.value;
  if (!v || !PRESETS[v]) return;
  const [w, l] = PRESETS[v];
  sheetWInput.value = formatInput(fromMm(w, state.units));
  sheetLInput.value = formatInput(fromMm(l, state.units));
});

unitsSelect.addEventListener('change', () => {
  const next = unitsSelect.value as Units;
  if (state.units === next) return;
  const factor = next === 'in' ? 1 / 25.4 : 25.4;
  sheetWInput.value = formatInput(parseFloat(sheetWInput.value) * factor);
  sheetLInput.value = formatInput(parseFloat(sheetLInput.value) * factor);
  marginInput.value = formatInput(parseFloat(marginInput.value) * factor);
  kerfInput.value = formatInput(parseFloat(kerfInput.value) * factor);
  state.units = next;
  renderBodyList();
  renderShoppingList();
  if (state.lastNest && state.lastSheet) renderResults();
});

function formatInput(v: number): string {
  if (!Number.isFinite(v)) return '0';
  // Trim trailing zeros while keeping precision useful for both units
  return parseFloat(v.toFixed(state.units === 'in' ? 4 : 1)).toString();
}

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
nestBtn.addEventListener('click', async () => {
  const selected = state.bodies.filter((b) => b.selected);
  if (selected.length === 0) return;
  const sheetW = toMm(parseFloat(sheetWInput.value), state.units);
  const sheetL = toMm(parseFloat(sheetLInput.value), state.units);
  const margin = toMm(parseFloat(marginInput.value), state.units);
  const kerf = toMm(parseFloat(kerfInput.value), state.units);
  const restarts = parseInt(restartsSelect.value) || 8;

  const parts: NestPart[] = selected.map((b) => ({
    id: String(b.id),
    name: b.name,
    thickness: b.analysis.thickness,
    qty: b.qty,
    grain: b.grain,
    rotation: b.rotation,
    outer: b.analysis.outline.outer,
    holes: b.analysis.outline.holes,
    color: b.color,
  }));

  nestBtn.disabled = true;
  nestBtn.textContent = 'Estimating…';
  resultsEmpty.hidden = true;
  resultsDetail.hidden = false;
  downloadDxfBtn.disabled = true;
  downloadPdfBtn.disabled = true;

  // 25 fps target → 1000/25 = 40ms per frame. We can't slow packOne down, but
  // we can SHOW frames at a steady pace by only rendering on the next frame
  // tick. Below the optimiser ticks faster than 25fps, the UI just shows the
  // most recent state; above, it limits paint to one frame per 40ms.
  const FRAME_MS = 1000 / 25;
  let lastPaint = 0;
  detailTitle.textContent = 'Optimising…';
  detailSub.textContent = '';
  detailSvg.innerHTML = '';

  try {
    const result = await runNestAnimated(parts, {
      sheetW, sheetL, margin, kerf,
      resolution: estimateResolution(sheetW, sheetL),
      restarts,
      cutStrategy: (cutStrategySelect.value as 'free' | 'guillotine' | 'save-last') || 'free',
    }, async (info) => {
      const now = performance.now();
      // Always update text counters so the user sees granular progress.
      const pct = ((info.trial + 1) / info.totalTrials) * 100;
      const yieldNow = sumYield(info.best);
      detailTitle.textContent = `Optimising · trial ${info.trial + 1} / ${info.totalTrials}`;
      detailSub.textContent =
        `Group ${info.groupIdx + 1} / ${info.totalGroups} · best ${info.best.length} sheet${info.best.length === 1 ? '' : 's'} · ${(yieldNow * 100).toFixed(1)}% yield`;
      nestBtn.textContent = `Trial ${info.trial + 1}/${info.totalTrials} · ${pct.toFixed(0)}%`;
      // Throttle the heavy SVG paint to 15fps OR repaint immediately on a
      // new best so the user always sees the latest improvement.
      if (info.isNewBest || now - lastPaint >= FRAME_MS) {
        lastPaint = now;
        paintTrialPreview(info.current, info.sheetW, info.sheetL, margin);
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
      }
    });

    state.lastNest = result;
    state.partLabels = assignPartLabels(result);
    state.lastSheet = { w: sheetW, l: sheetL, margin, kerf };
    state.currentSheetKey = firstSheetKey(result);
    renderResults();
  } catch (err: any) {
    resultsEmpty.hidden = false;
    resultsDetail.hidden = true;
    resultsEmpty.textContent = err.message || 'Nesting failed.';
    console.error(err);
  } finally {
    nestBtn.disabled = false;
    nestBtn.textContent = 'Estimate cut sheets';
  }
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
  downloadPdfBtn.disabled = false;
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

  // Cut-count estimate: count unique X edges + unique Y edges across all
  // placed parts on each sheet. Snaps coords to 0.5mm so float wobble
  // doesn't inflate the count.
  let totalCuts = 0;
  for (const g of result.groups) {
    for (const s of g.sheets) {
      const xs = new Set<number>();
      const ys = new Set<number>();
      const snap = (n: number) => Math.round(n * 2) / 2;
      for (const p of s.parts) {
        // Skip the outer sheet edges — those aren't "cuts" the user makes.
        if (p.x > 0.5)         xs.add(snap(p.x));
        if (p.x + p.w < s.sheetW - 0.5) xs.add(snap(p.x + p.w));
        if (p.y > 0.5)         ys.add(snap(p.y));
        if (p.y + p.h < s.sheetL - 0.5) ys.add(snap(p.y + p.h));
      }
      totalCuts += xs.size + ys.size;
    }
  }

  detailMetrics.innerHTML = `
    <div class="metric"><div class="k">Total sheets</div><div class="v">${result.totalSheets}</div></div>
    <div class="metric"><div class="k">Parts placed</div><div class="v">${totalPlaced}</div></div>
    <div class="metric"><div class="k">Yield</div><div class="v">${(result.yield * 100).toFixed(1)}%</div></div>
    <div class="metric"><div class="k">Waste</div><div class="v">${fmtArea(result.totalSheetArea - result.totalPartArea, state.units)}</div></div>
    <div class="metric"><div class="k">Edge banding</div><div class="v">${fmtLinear(edgeMm, state.units)}</div></div>
    <div class="metric"><div class="k">Cuts</div><div class="v">${totalCuts}</div></div>
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
  const all = result.groups.flatMap((g) => g.unplaced.map((u) => `${u.partName} #${u.instance} (${fmtDim(g.thickness, state.units)})`));
  if (all.length === 0) {
    unplacedList.textContent = '';
    return;
  }
  unplacedList.textContent = `Could not place: ${all.join(', ')}`;
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

downloadPdfBtn.addEventListener('click', async () => {
  if (!state.lastNest || !state.lastSheet) return;
  // Mark the button busy + show a progress indicator so the user knows the
  // (multi-second) snapshot capture + PDF assembly is running. We yield to
  // the browser between phases via requestAnimationFrame + await so the
  // progress bar actually updates between heavy synchronous work.
  const originalLabel = downloadPdfBtn.innerHTML;
  downloadPdfBtn.disabled = true;
  downloadPdfBtn.classList.add('busy');
  const setProgress = (label: string, pct: number) => {
    downloadPdfBtn.innerHTML = `<span class="progress-bar"><span class="progress-fill" style="width:${pct.toFixed(0)}%"></span></span><span class="progress-label">${label}</span>`;
  };
  const yieldFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
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

  // Use a clean WHITE scene background + faint shadow floor for all PDF
  // snapshots — the dark studio backdrop the live viewer uses prints
  // poorly. exitPdfBg restores the live look at the end.
  viewer.enterPdfBg();
  const cabinets: import('./pdf').CabinetSnapshot[] = [];
  let assembledPng: string | undefined;
  let explodedPng: string | undefined;
  try {
    // Two render targets — cover gets a near-square aspect to fill the
    // half-page snapshot box; IKEA step cards are wide (2:1-ish) and use a
    // 16:9 target so the cabinet fills the card horizontally.
    const SHOT_COVER = { w: 1200, h: 1100 };
    const SHOT_STEP  = { w: 1600, h: 900 };
    const fileCount = byFile.size;
    let fileIdx = 0;
    for (const [tag, bodies] of byFile) {
      fileIdx++;
      setProgress(`Capturing ${tag}…`, 10 + (70 * (fileIdx - 1) / Math.max(1, fileCount)));
      await yieldFrame();
      const visibleIds = new Set(bodies.map((b) => b.id));
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
    // Backwards-compat fallback: combined all-cabinet snapshots (used
    // when a future caller doesn't populate `cabinets`).
    assembledPng = viewer.snapshot().dataUrl;
    explodedPng = viewer.snapshotExploded(directions, explodeDist).dataUrl;
  } catch (err) {
    console.warn('Per-cabinet snapshot failed; assembly pages skipped.', err);
  } finally {
    viewer.exitPdfBg();
  }

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
    paper: pdfPaperSelect.value as any,
    currency: state.currency,
    jobCost: totalCost(state.shopping),
    edgeBandingMm: edgeMm,
    assembledPng,
    explodedPng,
    cabinets,
  });
  setProgress('Saving…', 98);
  await yieldFrame();
  const safe = (state.jobName || 'plywood_cut_estimate').replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
  downloadPdf(`${safe}.pdf`, doc);
  // Restore button
  downloadPdfBtn.innerHTML = originalLabel;
  downloadPdfBtn.classList.remove('busy');
  downloadPdfBtn.disabled = false;
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
