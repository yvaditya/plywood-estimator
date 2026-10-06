import { analyzeBody, type Vec3 } from './geometry';
import {
  correctThickness, correctionStepParts,
  type CorrectionInput, type CorrectionOptions, type CorrectionProposal,
} from './thicknessCorrection';
import { buildAssemblyStep } from './stepExport';

export interface ThicknessCabinet {
  key: string;
  name: string;
  inputs: CorrectionInput[];
  sourceOffset: Vec3;
  applied: CorrectionProposal | null;
}

interface ThicknessHost {
  getCabinets: () => ThicknessCabinet[];
  isBusy: () => boolean;
  onPreview: (proposal: CorrectionProposal | null) => void;
  onApply: (cabinet: ThicknessCabinet, proposal: CorrectionProposal) => void;
  onReset: (cabinet: ThicknessCabinet) => void;
}

const mm = (n: number) => Number.isFinite(n) ? (Math.abs(n) < 0.0005 ? '0' : Number(n.toFixed(3)).toString()) : '—';
const signedMm = (n: number) => `${n >= 0.0005 ? '+' : ''}${mm(n)}`;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

/** Owns proposal UI only. The host owns immutable imports and applied geometry. */
export function mountThicknessCorrection(host: ThicknessHost): { refresh: () => void; clearPreview: () => void } {
  const get = <T extends HTMLElement>(id: string) => {
    const found = document.getElementById(id);
    if (!found) throw new Error(`Missing thickness correction control: ${id}`);
    return found as T;
  };
  const cabinetSelect = get<HTMLSelectElement>('thicknessCabinet');
  const sourceSelect = get<HTMLSelectElement>('thicknessSource');
  const target = get<HTMLInputElement>('thicknessTarget');
  const tolerance = get<HTMLInputElement>('thicknessTolerance');
  const analyse = get<HTMLButtonElement>('thicknessAnalyseBtn');
  const apply = get<HTMLButtonElement>('thicknessApplyBtn');
  const reset = get<HTMLButtonElement>('thicknessResetBtn');
  const exportStep = get<HTMLButtonElement>('thicknessExportBtn');
  const preview = get<HTMLInputElement>('thicknessPreview');
  const status = get<HTMLDivElement>('thicknessStatus');
  const appliedStatus = get<HTMLDivElement>('thicknessApplied');
  const changes = get<HTMLDivElement>('thicknessChanges');
  const search = get<HTMLInputElement>('thicknessSearch');
  const reportTools = get<HTMLDivElement>('thicknessReportTools');
  const changeCount = get<HTMLSpanElement>('thicknessChangeCount');
  const emptyReview = get<HTMLDivElement>('thicknessReviewEmpty');
  const previewLegend = get<HTMLDivElement>('thicknessPreviewLegend');
  const stockSummary = get<HTMLParagraphElement>('thicknessStockSummary');
  const workspaceTab = get<HTMLButtonElement>('modeThicknessBtn');
  const thicknessCache = new WeakMap<CorrectionInput['mesh'], number | null>();
  let activeKey = '';
  let activeInputs: CorrectionInput[] = [];
  let pending: { proposal: CorrectionProposal; key: string; inputs: CorrectionInput[]; settings: string } | null = null;
  let failure = '';
  let notice = '';
  let analysing = false;

  const selected = () => host.getCabinets().find(c => c.key === cabinetSelect.value);
  const snapshot = (inputs: CorrectionInput[]) => inputs.map(({ id, name, mesh }) => ({ id, name, mesh }));
  const sameInputs = (a: CorrectionInput[], b: CorrectionInput[]) => a.length === b.length
    && a.every((input, i) => input.id === b[i].id && input.name === b[i].name && input.mesh === b[i].mesh);
  const settings = () => JSON.stringify([cabinetSelect.value, sourceSelect.value, target.value, tolerance.value]);
  const options = (): CorrectionOptions | null => {
    const sourceThickness = Number(sourceSelect.value);
    const targetThickness = target.valueAsNumber;
    const contactTolerance = tolerance.valueAsNumber;
    return [sourceThickness, targetThickness, contactTolerance].every(n => Number.isFinite(n) && n > 0)
      && contactTolerance <= 0.5
      ? { sourceThickness, targetThickness, tolerance: contactTolerance } : null;
  };
  const currentProposal = (cabinet: ThicknessCabinet | undefined) => cabinet && pending
    && pending.key === cabinet.key && pending.settings === settings() && sameInputs(pending.inputs, cabinet.inputs)
    ? pending.proposal : null;

  function stopPreview(): void {
    if (!preview.checked) return;
    preview.checked = false;
    previewLegend.hidden = true;
    host.onPreview(null);
  }

  function invalidate(): void {
    stopPreview();
    pending = null;
    failure = '';
    notice = '';
  }

  function setOptions(select: HTMLSelectElement, entries: [string, string][], preferred: string): void {
    if (entries.length !== select.options.length || entries.some(([value, label], i) =>
      select.options[i]?.value !== value || select.options[i]?.textContent !== label)) {
      select.replaceChildren(...entries.map(([value, label]) => {
        const option = element('option', label);
        option.value = value;
        return option;
      }));
    }
    select.value = entries.some(([value]) => value === preferred) ? preferred : (entries[0]?.[0] ?? '');
  }

  function sourceGroups(cabinet: ThicknessCabinet): [string, string][] {
    const groups = new Map<number, number>();
    for (const input of cabinet.inputs) {
      if (!thicknessCache.has(input.mesh)) {
        // This is a menu hint; correctThickness independently validates every solid.
        let thickness: number | null = null;
        try { thickness = analyzeBody(input.mesh)?.thickness ?? null; } catch { /* Solver reports invalid meshes. */ }
        thicknessCache.set(input.mesh, thickness);
      }
      const thickness = thicknessCache.get(input.mesh);
      if (thickness === null || thickness === undefined || !Number.isFinite(thickness) || thickness <= 0.000001) continue;
      const rounded = Math.round(thickness * 1000) / 1000;
      if (rounded > 0) groups.set(rounded, (groups.get(rounded) ?? 0) + 1);
    }
    return [...groups.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])
      .map(([thickness, count]) => [String(thickness), `${mm(thickness)} mm · ${count} ${count === 1 ? 'body' : 'bodies'}`]);
  }

  function renderChanges(report: CorrectionProposal | null, isApplied: boolean): void {
    changes.replaceChildren();
    changes.hidden = !report?.changes.length;
    reportTools.hidden = !report?.changes.length;
    emptyReview.hidden = !!report;
    if (!report?.changes.length) return;
    const query = search.value.trim().toLocaleLowerCase();
    const shown = report.changes.filter(change => change.name.toLocaleLowerCase().includes(query));
    changeCount.textContent = `${shown.length} / ${report.changes.length} ${isApplied ? 'applied' : 'proposed'}`;
    if (!shown.length) { changes.append(element('p', 'No boards match your search.', 'thickness-no-matches')); return; }
    const table = element('table', undefined, 'thickness-table');
    table.append(element('caption', `${isApplied ? 'Applied' : 'Proposed'} board changes. Sizes are length × width × thickness in millimetres.`, 'thickness-visually-hidden'));
    const head = element('thead'), heading = element('tr');
    for (const label of ['Board', 'Old size', 'New size', 'Movement']) {
      const cell = element('th', label); cell.scope = 'col'; heading.append(cell);
    }
    head.append(heading);
    const body = element('tbody');
    table.append(head, body);
    changes.append(table);
    const panels = new Map(report.panels.map(panel => [panel.id, panel]));
    for (const change of shown) {
      const panel = panels.get(change.id);
      const thicknessAxis = panel?.thicknessAxis ?? change.before.indexOf(Math.min(...change.before));
      const planeAxes = [0, 1, 2].filter(axis => axis !== thicknessAxis).sort((a, b) => change.before[b] - change.before[a]);
      const order = [...planeAxes, thicknessAxis];
      const row = element('tr', undefined, 'thickness-change');
      const name = element('th'); name.scope = 'row';
      const detailToggle = element('button', change.name, 'thickness-board-toggle');
      detailToggle.type = 'button';
      detailToggle.setAttribute('aria-expanded', 'false');
      detailToggle.setAttribute('aria-controls', `thickness-board-${change.id}`);
      detailToggle.title = 'Show why this board changes';
      name.append(detailToggle); row.append(name);
      for (const values of [change.before, change.after]) {
        const value = element('td', undefined, 'thickness-table-size');
        order.forEach((axis, index) => {
          if (index) value.append(document.createTextNode(' × '));
          value.append(element('span', mm(values[axis]), values === change.after && Math.abs(values[axis] - change.before[axis]) > 0.0005 ? 'thickness-after' : undefined));
        });
        row.append(value);
      }
      const movement = element('td', undefined, 'thickness-table-movement');
      const axes = ['X', 'Y', 'Z'];
      const shifts = change.translation.flatMap((v, i) => Math.abs(v) >= 0.0005 ? [`${axes[i]} ${signedMm(v)}`] : []);
      if (!shifts.length) movement.append(element('span', '—'));
      else for (const shift of shifts) movement.append(element('div', shift));
      row.append(movement);
      const details = element('tr', undefined, 'thickness-table-details');
      details.id = `thickness-board-${change.id}`; details.hidden = true;
      const reason = element('td'); reason.colSpan = 4;
      reason.append(element('strong', 'Why this board changes'), element('p', change.reasons.join(' · ')));
      details.append(reason);
      detailToggle.addEventListener('click', () => {
        details.hidden = !details.hidden;
        detailToggle.setAttribute('aria-expanded', String(!details.hidden));
      });
      body.append(row, details);
    }
  }

  function renderReport(report: CorrectionProposal): void {
    const metrics = element('dl', undefined, 'thickness-metrics');
    const metric = (label: string, value: string) => {
      const tile = element('div');
      tile.append(element('dt', label), element('dd', value));
      metrics.append(tile);
    };
    metric('Original contacts', `${report.contacts.length}${report.ok ? ' retained' : ' detected'}`);
    metric('Outside outline', report.ok ? 'Unchanged' : 'Not validated');
    metric('Solid collisions', report.ok || report.validation.collisionCount > 0 ? String(report.validation.collisionCount) : 'Not validated');
    if (report.ok) metric('Maximum joint gap change', `${mm(report.validation.maxJointGapError)} mm`);
    status.append(metrics);
    if (report.issues.length) {
      const issues = element('ul');
      for (const issue of report.issues) issues.append(element('li', issue.message, issue.severity === 'warning' ? 'thickness-review-warning' : undefined));
      status.append(issues);
    }
    if (report.excluded.length) {
      const references = element('details', undefined, 'thickness-reference-details');
      references.append(element('summary', `${report.excluded.length} reference surfaces excluded from STEP`));
      const excluded = element('ul');
      for (const item of report.excluded) excluded.append(element('li', `${item.name}: ${item.reason}`));
      references.append(excluded);
      status.append(references);
    }
  }

  function render(): void {
    const cabinet = selected();
    const proposal = currentProposal(cabinet);
    const busy = host.isBusy() || analysing;
    workspaceTab.disabled = busy;
    workspaceTab.title = busy ? 'Available when the current operation finishes' : 'Correct the assembly for your measured stock';
    const validProposal = !!proposal?.ok;
    previewLegend.hidden = !preview.checked;
    const parameters = options();
    const difference = parameters ? parameters.targetThickness - parameters.sourceThickness : 0;
    stockSummary.textContent = !cabinet || !parameters ? 'Measure your stock before applying a correction.'
      : Math.abs(difference) < 0.0005 ? 'Matches the designed stock thickness.'
      : `${mm(Math.abs(difference))} mm ${difference < 0 ? 'thinner' : 'thicker'} per board`;
    cabinetSelect.disabled = busy || !host.getCabinets().length;
    sourceSelect.disabled = busy || !cabinet || !sourceSelect.value;
    target.disabled = tolerance.disabled = busy || !cabinet;
    analyse.disabled = busy || !cabinet || !options();
    preview.disabled = busy || !validProposal;
    apply.disabled = busy || !validProposal || !proposal?.changes.length;
    reset.disabled = busy || !cabinet?.applied;
    exportStep.disabled = busy || !cabinet?.applied?.ok;
    target.setAttribute('aria-invalid', String(!!cabinet && !(target.valueAsNumber > 0 && Number.isFinite(target.valueAsNumber))));
    tolerance.setAttribute('aria-invalid', String(!!cabinet && !(tolerance.valueAsNumber > 0 && tolerance.valueAsNumber <= 0.5)));

    status.replaceChildren();
    status.dataset.state = failure || (proposal && !proposal.ok) ? 'error' : validProposal ? 'ready' : 'idle';
    if (failure) status.append(element('strong', failure));
    else if (!cabinet) status.append(element('p', 'Load a STEP cabinet to begin.'));
    else if (busy) status.append(element('strong', analysing ? 'Analysing imported geometry…' : 'Controls paused while another operation finishes.'));
    else if (proposal) status.append(element('strong', proposal.ok
      ? (proposal.changes.length ? `Ready to apply · ${proposal.changes.length} changed boards` : 'No geometry changes needed.')
      : 'Correction needs review · apply is blocked'));
    else if (!sourceSelect.value) status.append(element('p', 'No measurable solid panels were found in this cabinet.'));
    else if (!options()) status.append(element('p', 'Enter a positive target thickness and a tolerance greater than 0 and no more than 0.5 mm.'));
    else status.append(element('p', 'Analyse these settings from the imported model, then review and apply the changes.'));
    if (notice) status.append(element('p', notice));
    const report = proposal ?? cabinet?.applied ?? null;
    if (report) renderReport(report);
    appliedStatus.replaceChildren();
    appliedStatus.hidden = !cabinet?.applied;
    if (cabinet?.applied) {
      appliedStatus.append(element('strong', `Applied stock: ${mm(cabinet.applied.sourceThickness)} → ${mm(cabinet.applied.targetThickness)} mm`));
      appliedStatus.append(element('p', 'Reset and download use this applied assembly. New settings take effect only after Apply correction.'));
    }
    renderChanges(report, !proposal);
  }

  function refresh(): void {
    const cabinets = host.getCabinets();
    setOptions(cabinetSelect, cabinets.length ? cabinets.map(c => [c.key, c.name]) : [['', 'Load a STEP cabinet']], cabinetSelect.value);
    const cabinet = selected();
    const cabinetChanged = activeKey !== (cabinet?.key ?? '');
    const inputsChanged = !sameInputs(activeInputs, cabinet?.inputs ?? []);
    if (cabinetChanged || inputsChanged) {
      invalidate();
      const groups = cabinet ? sourceGroups(cabinet) : [];
      setOptions(sourceSelect, groups.length ? groups : [['', 'No source panels']], cabinetChanged ? '' : sourceSelect.value);
      activeKey = cabinet?.key ?? '';
      activeInputs = snapshot(cabinet?.inputs ?? []);
      search.value = '';
    }
    if (pending && !currentProposal(cabinet)) invalidate();
    if (host.isBusy()) stopPreview();
    render();
  }

  cabinetSelect.addEventListener('change', refresh);
  search.addEventListener('input', () => {
    const cabinet = selected(), proposal = currentProposal(cabinet);
    renderChanges(proposal ?? cabinet?.applied ?? null, !proposal);
  });
  for (const control of [sourceSelect, target, tolerance]) {
    control.addEventListener('input', () => { invalidate(); render(); });
    control.addEventListener('change', () => { invalidate(); render(); });
  }
  analyse.addEventListener('click', () => {
    const cabinet = selected(), parameters = options();
    if (host.isBusy() || analysing || !cabinet || !parameters) return;
    invalidate();
    analysing = true;
    render();
    try {
      const proposal = correctThickness(cabinet.inputs, parameters);
      pending = { proposal, key: cabinet.key, inputs: snapshot(cabinet.inputs), settings: settings() };
    } catch (error) { failure = `Analysis failed: ${error instanceof Error ? error.message : String(error)}`; }
    finally { analysing = false; render(); }
  });
  preview.addEventListener('change', () => {
    const proposal = currentProposal(selected());
    if (host.isBusy() || !proposal?.ok) { stopPreview(); render(); return; }
    try { host.onPreview(preview.checked ? proposal : null); }
    catch (error) { preview.checked = false; failure = `Preview failed: ${error instanceof Error ? error.message : String(error)}`; }
    render();
  });
  apply.addEventListener('click', () => {
    const cabinet = selected(), proposal = currentProposal(cabinet);
    if (host.isBusy() || !cabinet || !proposal?.ok || !proposal.changes.length) return;
    try {
      stopPreview();
      host.onApply(cabinet, proposal);
      pending = null;
      failure = '';
      notice = 'Correction applied to the model and cutting dimensions.';
    } catch (error) { failure = `Apply failed: ${error instanceof Error ? error.message : String(error)}`; }
    refresh();
  });
  reset.addEventListener('click', () => {
    const cabinet = selected();
    if (host.isBusy() || !cabinet?.applied) return;
    try {
      invalidate();
      host.onReset(cabinet);
      notice = 'Imported geometry restored.';
    } catch (error) { failure = `Reset failed: ${error instanceof Error ? error.message : String(error)}`; }
    refresh();
  });
  exportStep.addEventListener('click', () => {
    const cabinet = selected();
    if (host.isBusy() || !cabinet?.applied?.ok) return;
    try {
      const text = buildAssemblyStep(correctionStepParts(cabinet.applied, cabinet.sourceOffset), new Date().toISOString(), `${cabinet.name} corrected`);
      const url = URL.createObjectURL(new Blob([text], { type: 'application/step' }));
      const link = element('a');
      link.href = url;
      link.download = `${cabinet.name.replace(/\.(step|stp)$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || 'cabinet'}-corrected.step`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      failure = '';
      notice = 'Corrected panel assembly downloaded.';
    } catch (error) { failure = `STEP export failed: ${error instanceof Error ? error.message : String(error)}`; }
    render();
  });
  refresh();
  return { refresh, clearPreview: stopPreview };
}
