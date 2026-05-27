/**
 * Glue layer for the plywood estimator UI.
 * - File handling + STEP parsing
 * - Sidebar: sheet config, bodies, inventory
 * - Viewer + click-selection sync
 * - Estimate → multi-restart nester
 * - Results: detail view + thumbnail strip + DXF/PDF downloads
 */

import './style.css';
import { parseStep, type OcctResult } from './stepLoader';
import { Viewer, bodyColor } from './viewer';
import { analyzeBody, type BodyAnalysis } from './geometry';
import {
  runNest,
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
const thumbStrip = $('thumbStrip');

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
  for (const b of state.bodies) {
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

    // Right-side spacer to balance grid (count cell)
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
    bodyList.appendChild(row);
  }
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
nestBtn.addEventListener('click', () => {
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
  resultsEmpty.textContent = 'Optimizing layout…';
  resultsEmpty.hidden = false;
  resultsDetail.hidden = true;
  thumbStrip.hidden = true;

  setTimeout(() => {
    try {
      const result = runNest(parts, {
        sheetW, sheetL, margin, kerf,
        resolution: estimateResolution(sheetW, sheetL),
        restarts,
        cutStrategy: (cutStrategySelect.value as 'free' | 'guillotine') || 'free',
      });
      state.lastNest = result;
      state.partLabels = assignPartLabels(result);
      state.lastSheet = { w: sheetW, l: sheetL, margin, kerf };
      const firstKey = firstSheetKey(result);
      state.currentSheetKey = firstKey;
      renderResults();
    } catch (err: any) {
      resultsEmpty.textContent = err.message || 'Nesting failed.';
      console.error(err);
    } finally {
      nestBtn.disabled = false;
      nestBtn.textContent = 'Estimate cut sheets';
    }
  }, 30);
});

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
  thumbStrip.hidden = false;

  // Detail view
  if (!state.currentSheetKey) {
    state.currentSheetKey = firstSheetKey(result);
  }
  const sel = findSheetByKey(state.currentSheetKey);
  if (sel) {
    renderDetail(sel.sheet, sel.groupIdx + 1);
  } else {
    detailTitle.textContent = 'No sheets';
    detailSvg.innerHTML = '';
  }

  // Thumbnails — use each sheet's own dims so portrait + landscape both render.
  thumbStrip.innerHTML = '';
  result.groups.forEach((g, gi) => {
    g.sheets.forEach((sh, si) => {
      const key = `g${gi}-s${si}`;
      const t = document.createElement('div');
      t.className = 'thumb' + (key === state.currentSheetKey ? ' active' : '');
      const tw = sh.sheetW, tl = sh.sheetL;
      const fill = sh.parts.length > 0 ? (sh.usedArea / (tw * tl)) * 100 : 0;
      // Aspect-ratio-aware: tall (portrait) sheets get a taller thumb.
      const aspect = tl / tw;
      const wrap = document.createElement('div');
      wrap.className = 'thumb-svg-wrap';
      const svgWrap = document.createElement('div');
      svgWrap.className = 'thumb-svg';
      svgWrap.style.aspectRatio = `${tw} / ${tl}`;
      // Constrain the inner dim that's the long axis so the other auto-sizes
      // from aspect-ratio without overflowing the card.
      if (aspect >= 1) {
        // Portrait: limit height, width derived from aspect
        svgWrap.style.height = '100%';
        svgWrap.style.width = 'auto';
      } else {
        // Landscape: limit width, height derived from aspect
        svgWrap.style.width = '100%';
        svgWrap.style.height = 'auto';
      }
      svgWrap.appendChild(buildSheetSvg(sh, tw, tl, sz.margin, false));
      wrap.appendChild(svgWrap);
      t.appendChild(wrap);
      const label = document.createElement('div');
      label.className = 'thumb-label';
      const orient = aspect > 1.05 ? '↕' : aspect < 0.95 ? '↔' : '□';
      label.textContent = `${orient} #${si + 1} · ${fmtDim(sh.thickness, state.units)} · ${fill.toFixed(0)}%`;
      t.appendChild(label);
      t.addEventListener('click', () => {
        state.currentSheetKey = key;
        renderResults();
      });
      thumbStrip.appendChild(t);
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

function renderDetail(sheet: NestSheet, groupIdx: number) {
  const sz = state.lastSheet!;
  const tw = sheet.sheetW, tl = sheet.sheetL;
  const fill = sheet.parts.length > 0 ? (sheet.usedArea / (tw * tl)) * 100 : 0;
  const orient = tl > tw ? 'portrait' : (tw > tl ? 'landscape' : 'square');
  detailTitle.textContent = `Sheet ${sheet.index} · ${fmtDim(sheet.thickness, state.units)} thick`;
  detailSub.textContent =
    `Group ${groupIdx} · ${sheet.parts.length} parts · ${fill.toFixed(1)}% fill · ` +
    `${fmtDim(tw, state.units)} × ${fmtDim(tl, state.units)} ${orient} · kerf ${fmtDim(sz.kerf, state.units)}`;
  detailSvg.innerHTML = '';
  detailSvg.appendChild(buildSheetSvg(sheet, tw, tl, sz.margin, true));
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
    svg.appendChild(buildPartShape(svgNS, p, withDimensions, Math.max(sheetW, sheetL)));
  }

  // Overall sheet dimensions
  if (withDimensions) {
    svg.appendChild(buildDim(svgNS, 0, sheetL + 10, sheetW, sheetL + 10, fmtDim(sheetW, state.units)));
    svg.appendChild(buildDim(svgNS, -10, 0, -10, sheetL, fmtDim(sheetL, state.units), true));
  }

  return svg;
}

function buildPartShape(
  svgNS: string,
  p: PlacedPart,
  withLabels: boolean,
  sheetScale: number,
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

    // Big letter label (primary identifier — matches PDF Parts overview).
    const letter = state.partLabels.get(p.partId)?.letter;
    const bigSize = Math.max(10, Math.min(36, Math.min(p.w, p.h) * 0.34));
    if (letter) {
      const bigLabel = document.createElementNS(svgNS, 'text');
      bigLabel.setAttribute('class', 'part-label');
      bigLabel.setAttribute('x', String(p.w / 2));
      bigLabel.setAttribute('y', String(p.h / 2 + bigSize * 0.18));
      bigLabel.setAttribute('font-size', String(bigSize));
      bigLabel.setAttribute('font-weight', '700');
      bigLabel.textContent = letter;
      g.appendChild(bigLabel);
    }

    // Dimensions sub-label below
    const labelSize = Math.max(6, Math.min(12, Math.min(p.w, p.h) * 0.10));
    const dimLabel = document.createElementNS(svgNS, 'text');
    dimLabel.setAttribute('class', 'part-label');
    dimLabel.setAttribute('x', String(p.w / 2));
    dimLabel.setAttribute('y', String(p.h / 2 + (letter ? bigSize * 0.55 + labelSize : 0)));
    dimLabel.setAttribute('font-size', String(labelSize));
    dimLabel.setAttribute('font-weight', '400');
    dimLabel.textContent = `${fmtDim(p.w, state.units)} × ${fmtDim(p.h, state.units)}`;
    g.appendChild(dimLabel);
  }

  return g;
}

function buildDim(
  svgNS: string,
  x1: number, y1: number, x2: number, y2: number,
  label: string,
  vertical = false,
): SVGElement {
  const g = document.createElementNS(svgNS, 'g') as SVGGElement;
  const line = document.createElementNS(svgNS, 'line');
  line.setAttribute('class', 'dim-line');
  line.setAttribute('x1', String(x1));
  line.setAttribute('y1', String(y1));
  line.setAttribute('x2', String(x2));
  line.setAttribute('y2', String(y2));
  g.appendChild(line);

  const tickA = document.createElementNS(svgNS, 'line');
  tickA.setAttribute('class', 'dim-line');
  if (vertical) {
    tickA.setAttribute('x1', String(x1 - 3)); tickA.setAttribute('x2', String(x1 + 3));
    tickA.setAttribute('y1', String(y1)); tickA.setAttribute('y2', String(y1));
  } else {
    tickA.setAttribute('x1', String(x1)); tickA.setAttribute('x2', String(x1));
    tickA.setAttribute('y1', String(y1 - 3)); tickA.setAttribute('y2', String(y1 + 3));
  }
  g.appendChild(tickA);

  const tickB = document.createElementNS(svgNS, 'line');
  tickB.setAttribute('class', 'dim-line');
  if (vertical) {
    tickB.setAttribute('x1', String(x2 - 3)); tickB.setAttribute('x2', String(x2 + 3));
    tickB.setAttribute('y1', String(y2)); tickB.setAttribute('y2', String(y2));
  } else {
    tickB.setAttribute('x1', String(x2)); tickB.setAttribute('x2', String(x2));
    tickB.setAttribute('y1', String(y2 - 3)); tickB.setAttribute('y2', String(y2 + 3));
  }
  g.appendChild(tickB);

  const text = document.createElementNS(svgNS, 'text');
  text.setAttribute('class', 'dim-text');
  if (vertical) {
    const tx = x1 - 5;
    const ty = (y1 + y2) / 2;
    text.setAttribute('x', String(tx));
    text.setAttribute('y', String(ty));
    text.setAttribute('transform', `rotate(-90, ${tx}, ${ty})`);
  } else {
    text.setAttribute('x', String((x1 + x2) / 2));
    text.setAttribute('y', String(y1 - 4));
  }
  text.textContent = label;
  g.appendChild(text);
  return g;
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

downloadPdfBtn.addEventListener('click', () => {
  if (!state.lastNest || !state.lastSheet) return;
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
  });
  const safe = (state.jobName || 'plywood_cut_estimate').replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
  downloadPdf(`${safe}.pdf`, doc);
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
