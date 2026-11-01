import './remote.css';
import { PackageViewer } from './packageViewer';
import { cutMeasurement } from './packageCuts';
import { fmtDim } from './units';
import type { PackageModel, PackagePart, PackageSheet } from './packageData';
import { remoteHash, type RemoteBody, type RemoteCommand, type RemoteJob, type RemoteProgress } from './remoteTypes';

/**
 * Shop remote (phone). Mirrors the job published by the desktop app and sends
 * cut-list edits back as commands; the desktop re-plans and republishes.
 * Order follows the shop: inventory → cut list → 3D.
 */
type Tab = 'inventory' | 'cuts' | '3d';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string | number) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const color = (s: string) => /^#[0-9a-f]{6}$/i.test(s) ? s : '#a8957d';

let job: RemoteJob | null = null;
let progress: RemoteProgress = {};
let deskOnline = false;
let connected = false;
let tab: Tab = 'inventory';
let selectedBody: string | null = null;
let viewer: PackageViewer | undefined;
let modelsRev = '';
let viewerRev = '';
let models: PackageModel[] | null = null;
let modelsLoading = false;
let isolated = false;
/** Cabinet (STEP file) the page is limited to, from #section=…; null = whole job. */
let section: string | null = null;
/** Part named by #part=…, opened once the job arrives. */
let linkPart: string | null = null;
/** Step highlighted per sheet number (−1 = overview). */
const stepOf = new Map<number, number>();
/** Optimistic edits not yet reflected by a republished job. */
const pending = new Map<string, RemoteCommand & { type: 'body' }>();
const expanded = new Set<string>();

const dim = (n: number) => fmtDim(n, job?.units ?? 'mm');
const parts = (): PackagePart[] => job?.plan?.parts ?? [];
const partsOf = (bodyId: string) => parts().filter(p => p.bodyId === bodyId);
const inSection = (b: { fileTag: string }) => !section || b.fileTag === section;
const sectionBodies = () => job?.bodies.filter(inSection) ?? [];
const sectionIds = () => new Set(sectionBodies().map(b => b.id));
const sectionParts = () => { const ids = sectionIds(); return parts().filter(p => ids.has(p.bodyId)); };

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  section = h.get('section') || null;
  linkPart = h.get('part') || null;
}
/** Keep the address bar a shareable link to what is on screen. */
function writeHash() {
  const b = job?.bodies.find(x => x.id === selectedBody);
  const hash = remoteHash(section ?? '', b && section && b.fileTag === section ? b.name : '');
  history.replaceState(null, '', location.pathname + location.search + hash);
}
/** Apply #section / #part once the job is known. */
function applyLink() {
  if (!job) return;
  const sections = new Set(job.bodies.map(b => b.fileTag));
  if (section && !sections.has(section)) { toast(`No section called "${section}" in this job.`); section = null; linkPart = null; }
  viewer?.showOnly(section ? [...sectionIds()] : null);
  if (selectedBody && !sectionIds().has(selectedBody)) selectedBody = null;
  if (linkPart) {
    const want = linkPart.toLowerCase();
    const b = sectionBodies().find(x => x.name.toLowerCase() === want) ?? sectionBodies().find(x => x.id === linkPart);
    linkPart = null;
    if (!b) { toast('That part is not in this job any more.'); render(); return; }
    setTab('3d'); selectBody(b.id, true);
    return;
  }
  render();
}
function bodyView(b: RemoteBody): RemoteBody {
  const p = pending.get(b.id);
  return p ? { ...b, ...p.patch } : b;
}

function toast(msg: string) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout((toast as any).timer);
  (toast as any).timer = setTimeout(() => { t.hidden = true; }, 2600);
}

async function send(cmd: RemoteCommand) {
  try {
    const res = await fetch('/__remote/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Error ${res.status}`);
  } catch (err) {
    if (cmd.type === 'body') pending.delete(cmd.id);
    toast(err instanceof Error ? err.message : String(err));
    render();
  }
}
function editBody(id: string, patch: (RemoteCommand & { type: 'body' })['patch']) {
  const prev = pending.get(id);
  const cmd = { type: 'body' as const, id, patch: { ...prev?.patch, ...patch } };
  pending.set(id, cmd);
  render();
  void send({ type: 'body', id, patch });
}
async function setProgress(key: string, field: 'cut' | 'assembled', value: boolean) {
  progress[key] = { ...progress[key], [field]: value };
  render();
  try {
    await fetch('/__remote/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, field, value }) });
  } catch { toast('Could not save progress. Check the Wi-Fi.'); }
}

// ---------------------------------------------------------------- header
function renderHeader() {
  $('jobName').textContent = section ?? job?.jobName ?? 'Shop remote';
  const scoped = sectionParts();
  const all = scoped.filter(p => p.sheet !== null);
  const cut = all.filter(p => progress[p.key]?.cut).length;
  const asm = scoped.filter(p => progress[p.key]?.assembled).length;
  const tags = [...new Set(job?.bodies.map(b => b.fileTag) ?? [])];
  const sel = $<HTMLSelectElement>('section');
  sel.hidden = tags.length < 2;
  sel.innerHTML = `<option value="">All sections</option>${tags.map(t => `<option value="${esc(t)}" ${t === section ? 'selected' : ''}>${esc(t)}</option>`).join('')}`;
  $('jobSub').textContent = !connected ? 'Reconnecting…'
    : !job ? 'Waiting for the computer to share a job…'
    : !job.plan ? 'No cut plan yet. Estimate on the computer or tap Re-plan.'
    : `${section ? `${job.jobName} · ` : ''}${job.plan.sheets.length} sheet${job.plan.sheets.length === 1 ? '' : 's'} · ${cut}/${all.length} cut · ${asm}/${scoped.length} assembled`;
  const conn = $('conn');
  conn.className = 'r-conn ' + (connected && deskOnline ? 'on' : connected ? 'half' : 'off');
  conn.title = connected && deskOnline ? 'Live with the computer' : connected ? 'Computer app is closed — showing the last plan' : 'Reconnecting';
  const banner = $('banner');
  if (job?.busy) { banner.hidden = false; banner.className = 'r-banner busy'; banner.textContent = 'Re-planning on the computer…'; }
  else if (job?.stale || pending.size) {
    banner.hidden = false; banner.className = 'r-banner';
    banner.innerHTML = `<span>${pending.size ? 'Sending your edit…' : 'Cut list changed since this plan.'}</span><button id="replan" type="button">Re-plan</button>`;
    $('replan').onclick = () => void send({ type: 'estimate' });
  } else banner.hidden = true;
}

// ------------------------------------------------------------- inventory
function renderInventory() {
  const el = $('tab-inventory');
  if (!job) { el.innerHTML = `<p class="r-empty">Open the app on the computer and load a job.</p>`; return; }
  const stock = job.stock.length ? job.stock.map(s => `<li class="r-row">
      <span class="r-sheet-icon" aria-hidden="true"></span>
      <span class="r-main"><strong>${esc(dim(s.sheetW))} × ${esc(dim(s.sheetL))}</strong><small>${esc(dim(s.thickness))} sheet</small></span>
      <span class="r-qty">×${s.need}${s.buy > 0 ? `<small class="short">buy ${s.buy}</small>` : s.have ? '<small>in stock</small>' : ''}</span></li>`).join('')
    : `<li class="r-empty">Sheets appear after the first plan.</li>`;
  const inPlan = sectionBodies().map(bodyView).filter(b => b.selected);
  const out = sectionBodies().map(bodyView).filter(b => !b.selected);
  const row = (b: RemoteBody) => {
    const codes = partsOf(b.id).map(p => p.code);
    return `<li><button class="r-row r-panel ${selectedBody === b.id ? 'selected' : ''}" data-body="${esc(b.id)}">
      <span class="r-swatch" style="--c:${color(b.color)}"></span>
      <span class="r-main"><strong>${esc(b.name)}</strong><small>${esc(dim(b.length))} × ${esc(dim(b.width))} × ${esc(dim(b.thickness))}${codes.length ? ` · ${esc(codes.join(' '))}` : ''}</small></span>
      <span class="r-qty">×${b.qty}</span></button></li>`;
  };
  el.innerHTML = `<h2 class="r-h">Sheets${section ? ' <span class="r-hint">whole job</span>' : ''}</h2><ul class="r-list">${stock}</ul>
    <h2 class="r-h">Panels <span class="r-count">${inPlan.reduce((n, b) => n + b.qty, 0)}</span></h2>
    <ul class="r-list">${inPlan.map(row).join('') || '<li class="r-empty">No panels in the plan.</li>'}</ul>
    ${out.length ? `<h2 class="r-h muted">Not in plan</h2><ul class="r-list dim">${out.map(row).join('')}</ul>` : ''}`;
}

// -------------------------------------------------------------- cut list
/** Long edge horizontal on every sheet (landscape), datum stays top-left. */
function sheetSvg(s: PackageSheet) {
  const swap = s.length > s.width;
  const T = (x: number, y: number): [number, number] => swap ? [y, x] : [x, y];
  const W = swap ? s.length : s.width, H = swap ? s.width : s.length;
  const label = Math.max(W, H) / 26;
  const step = s.steps[stepOf.get(s.number) ?? -1];
  const shapes = s.parts.map(p => {
    const part = parts().find(x => x.key === p.key);
    const d = [p.outer, ...p.holes].map(r => r.map(([px, py], i) => { const [a, b] = T(px + p.x, py + p.y); return `${i ? 'L' : 'M'}${a} ${b}`; }).join('') + 'Z').join('');
    const [cx, cy] = T(p.x + p.w / 2, p.y + p.h / 2);
    const done = progress[p.key]?.cut;
    const other = !!section && !!part && !sectionIds().has(part.bodyId);
    const cls = `${done ? 'done' : ''} ${other ? 'other' : ''} ${part && part.bodyId === selectedBody ? 'selected' : ''}`;
    return `<g class="r-part ${cls}" data-body="${esc(part?.bodyId ?? '')}"><path d="${d}" fill="${color(p.color)}" fill-rule="evenodd"/>
      <text x="${cx}" y="${cy}" font-size="${Math.min(label, Math.min(p.w, p.h) * .42)}">${done ? '✓ ' : ''}${esc(part?.code ?? '')}</text></g>`;
  }).join('');
  let overlay = '';
  if (step && job?.plan) {
    const { vertical } = cutMeasurement(step, s, job.plan);
    const x = step.parentX + (vertical ? step.distance : 0), y = step.parentY + (vertical ? 0 : step.distance);
    const [x1, y1] = T(x, y), [x2, y2] = T(vertical ? x : x + step.parentW, vertical ? y + step.parentH : y);
    const [rx, ry] = T(step.parentX, step.parentY), [rw, rh] = swap ? [step.parentH, step.parentW] : [step.parentW, step.parentH];
    overlay = `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" class="r-piece" vector-effect="non-scaling-stroke"/><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="r-cutline" vector-effect="non-scaling-stroke"/>`;
  }
  return `<svg viewBox="-6 -6 ${W + 12} ${H + 12}" class="r-sheet-svg" role="img" aria-label="Sheet ${s.number} layout"><rect width="${W}" height="${H}" class="r-stock"/>${shapes}${overlay}</svg>`;
}
/** Edge names follow the landscape drawing, not the stored orientation. */
function edgeWords(from: string, swap: boolean) {
  if (!swap) return from;
  return from.replace(/left edge|right edge|top edge|bottom edge/, m => ({ 'left edge': 'top edge', 'right edge': 'bottom edge', 'top edge': 'left edge', 'bottom edge': 'right edge' } as Record<string, string>)[m]);
}
function renderCuts() {
  const el = $('tab-cuts');
  if (!job) { el.innerHTML = `<p class="r-empty">Waiting for the computer…</p>`; return; }
  const edit = sectionBodies().map(bodyView).map(b => `<li class="r-edit ${b.selected ? '' : 'off'} ${pending.has(b.id) ? 'pending' : ''}">
    <label class="r-check"><input type="checkbox" data-include="${esc(b.id)}" ${b.selected ? 'checked' : ''} aria-label="Include ${esc(b.name)}"></label>
    <span class="r-swatch" style="--c:${color(b.color)}"></span>
    <button class="r-main" data-expand="${esc(b.id)}"><strong>${esc(b.name)}</strong><small>${esc(dim(b.length))} × ${esc(dim(b.width))} × ${esc(dim(b.thickness))}</small></button>
    <span class="r-stepper"><button data-qty="${esc(b.id)}" data-d="-1" aria-label="One fewer" ${b.qty <= 1 ? 'disabled' : ''}>−</button><output>${b.qty}</output><button data-qty="${esc(b.id)}" data-d="1" aria-label="One more">+</button></span>
    ${expanded.has(b.id) ? `<div class="r-opts">
      <label>Grain <select data-grain="${esc(b.id)}">${[['free', 'Any direction'], ['length', 'Along length'], ['width', 'Along width']].map(([v, t]) => `<option value="${v}" ${b.grain === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label>Rotation <select data-rot="${esc(b.id)}">${[['lock', 'No rotation'], ['flip90', 'Allow 90° flip'], ['any', 'Any']].map(([v, t]) => `<option value="${v}" ${b.rotation === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <span class="r-mat">${esc(b.material)}</span></div>` : ''}</li>`).join('');
  const plan = job.plan;
  const cnc = plan?.strategy.startsWith('cnc');
  const sheets = !plan ? '<p class="r-empty">No plan yet. Tap Re-plan above or Estimate on the computer.</p>'
    : !plan.sheets.length ? '<p class="r-empty">Nothing fits the stock sheets. Check the panels list.</p>'
    : plan.sheets.filter(s => !section || s.parts.some(p => sectionParts().some(x => x.key === p.key))).map(s => {
      const swap = s.length > s.width;
      const cur = stepOf.get(s.number) ?? -1;
      const cuts = s.parts.filter(p => progress[p.key]?.cut).length;
      const mine = section ? s.parts.filter(p => sectionParts().some(x => x.key === p.key)).length : 0;
      const steps = cnc ? '<p class="r-note">CNC layout: follow the part contours, including holes.</p>'
        : `<ol class="r-steps">${s.steps.map((st, i) => {
          const m = cutMeasurement(st, s, plan);
          const kind = st.isTrim ? 'Trim' : st.isDatum ? 'Reference' : st.axis === 'rip' ? 'Rip' : 'Crosscut';
          return `<li><button data-sheet="${s.number}" data-step="${i}" class="${i === cur ? 'active' : ''}"><span class="r-n">${String(i + 1).padStart(2, '0')}</span><span>${kind} <strong>${esc(dim(m.distance))}</strong> ${st.isTrim ? 'from the stock edge' : `from ${esc(edgeWords(m.from, swap))}`}${st.sameSetting ? '<small>same setting</small>' : ''}</span></button></li>`;
        }).join('')}</ol>`;
      return `<article class="r-sheet"><h3>Sheet ${s.number}<small>${esc(dim(s.width))} × ${esc(dim(s.length))} · ${esc(dim(s.thickness))} · ${cuts}/${s.parts.length} cut${mine ? ` · ${mine} from ${esc(section!)}` : ''}</small></h3>
        <div class="r-sheet-draw" data-sheet-draw="${s.number}">${sheetSvg(s)}</div>${steps}</article>`;
    }).join('');
  const unplaced = sectionParts().filter(p => p.sheet === null);
  el.innerHTML = `<h2 class="r-h">Panels <span class="r-hint">tap a name for grain and rotation</span></h2><ul class="r-list r-edits">${edit}</ul>
    <h2 class="r-h">Sheets and cuts</h2>${plan ? `<p class="r-note">Kerf ${esc(dim(plan.kerf))} · margin ${esc(dim(plan.margin))} · ${esc(plan.kerfRef)} reference. Tap a step to see the cut, tap a piece to see what it is.</p>` : ''}${sheets}
    ${unplaced.length ? `<p class="r-warn">${unplaced.length} piece${unplaced.length > 1 ? 's' : ''} did not fit: ${esc(unplaced.map(p => p.name).join(', '))}</p>` : ''}`;
}

// ------------------------------------------------------------------- 3D
async function ensureModels() {
  if (modelsLoading || !modelsRev || (models && viewerRev === modelsRev)) return;
  modelsLoading = true;
  try {
    const res = await fetch('/__remote/models');
    if (!res.ok) throw new Error('No 3D model shared yet.');
    const body = await res.json() as { rev: string; models: PackageModel[] };
    models = body.models;
    viewer?.dispose(); viewer = undefined;
    $('model').querySelector('.r-empty')?.remove();
    try {
      viewer = new PackageViewer($('model'), models, id => { selectBody(id, false); });
      if (section) viewer.showOnly([...sectionIds()]);
      if (selectedBody) viewer.focus(selectedBody);
      viewerRev = body.rev;
    } catch {
      $('model').innerHTML = '<p class="r-empty">3D view needs WebGL. The inventory and cut list still work.</p>';
    }
  } catch (err) {
    if (!$('model').querySelector('.r-empty')) $('model').insertAdjacentHTML('beforeend', `<p class="r-empty">${esc(err instanceof Error ? err.message : String(err))}</p>`);
  } finally {
    modelsLoading = false;
    renderChips();
  }
}
function renderChips() {
  const bodies = sectionBodies().filter(b => b.selected);
  $('chips').innerHTML = bodies.map(b => `<button class="r-chip ${b.id === selectedBody ? 'active' : ''}" data-body="${esc(b.id)}"><span class="r-swatch" style="--c:${color(b.color)}"></span>${esc(b.name)}</button>`).join('');
  $<HTMLButtonElement>('isolate').disabled = !selectedBody || !viewer;
}

// ------------------------------------------------------------------ card
function renderCard() {
  const card = $('card');
  const b = job?.bodies.find(x => x.id === selectedBody);
  if (!b) { card.hidden = true; document.body.classList.remove('has-card'); document.body.style.removeProperty('--card-h'); return; }
  const v = bodyView(b);
  const ps = partsOf(b.id);
  const sheetsOf = [...new Set(ps.map(p => p.sheet).filter((n): n is number => n !== null))];
  card.hidden = false; document.body.classList.add('has-card');
  card.innerHTML = `<div class="r-card-head"><span class="r-swatch big" style="--c:${color(b.color)}"></span>
      <div><strong>${esc(b.name)}</strong><small>${esc(b.fileTag)}</small></div><button id="cardClose" aria-label="Close">×</button></div>
    <dl class="r-facts"><div><dt>Size</dt><dd>${esc(dim(b.length))} × ${esc(dim(b.width))}</dd></div><div><dt>Thick</dt><dd>${esc(dim(b.thickness))}</dd></div>
      <div><dt>Qty</dt><dd>${v.qty}${v.selected ? '' : ' · not in plan'}</dd></div><div><dt>Sheet</dt><dd>${sheetsOf.length ? sheetsOf.join(', ') : '—'}</dd></div></dl>
    ${ps.length ? `<ul class="r-pieces">${ps.map(p => `<li><span class="r-code">${esc(p.code)}</span>
      <label><input type="checkbox" data-prog="cut" data-key="${esc(p.key)}" ${progress[p.key]?.cut ? 'checked' : ''} ${p.sheet === null ? 'disabled' : ''}> Cut</label>
      <label><input type="checkbox" data-prog="assembled" data-key="${esc(p.key)}" ${progress[p.key]?.assembled ? 'checked' : ''}> Assembled</label></li>`).join('')}</ul>` : ''}
    <div class="r-card-actions">${tab !== '3d' ? '<button id="cardShow3d" class="primary">Show in 3D</button>' : '<button id="cardSpin">Spin again</button>'}
      ${sheetsOf.length && tab !== 'cuts' ? '<button id="cardSheet">Show on sheet</button>' : ''}</div>`;
  // The 3D view shrinks to stay clear of the card (viewer refits on resize).
  document.body.style.setProperty('--card-h', `${card.offsetHeight}px`);
  $('cardClose').onclick = () => selectBody(null, false);
  const show3d = document.getElementById('cardShow3d');
  if (show3d) show3d.onclick = () => { setTab('3d'); selectBody(b.id, true); };
  const spin = document.getElementById('cardSpin');
  if (spin) spin.onclick = () => viewer?.focus(b.id);
  const sheet = document.getElementById('cardSheet');
  if (sheet) sheet.onclick = () => { setTab('cuts'); requestAnimationFrame(() => document.querySelector(`[data-sheet-draw="${sheetsOf[0]}"]`)?.scrollIntoView({ block: 'center' })); };
}

// ----------------------------------------------------------------- state
function selectBody(id: string | null, spin: boolean) {
  selectedBody = id;
  if (isolated && !id) { isolated = false; viewer?.isolate(false); $('isolate').setAttribute('aria-pressed', 'false'); }
  if (spin && id) viewer?.focus(id); else viewer?.select(id);
  writeHash();
  render();
}
function render() {
  renderHeader();
  if (tab === 'inventory') renderInventory();
  if (tab === 'cuts') renderCuts();
  if (tab === '3d') renderChips();
  renderCard();
}
function setTab(next: Tab) {
  tab = next;
  for (const t of ['inventory', 'cuts', '3d'] as Tab[]) $(`tab-${t}`).hidden = t !== tab;
  document.querySelectorAll<HTMLButtonElement>('.r-tabs button').forEach(b => {
    const on = b.dataset.tab === tab; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on));
  });
  document.body.dataset.tab = tab;
  if (tab === '3d') { void ensureModels(); requestAnimationFrame(() => viewer?.resize()); }
  render();
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- events
document.querySelectorAll<HTMLButtonElement>('.r-tabs button').forEach(b => b.onclick = () => setTab(b.dataset.tab as Tab));
$('tab-inventory').addEventListener('click', e => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-body]');
  if (row) { setTab('3d'); selectBody(row.dataset.body!, true); }
});
$('tab-cuts').addEventListener('click', e => {
  const t = e.target as HTMLElement;
  const qty = t.closest<HTMLButtonElement>('[data-qty]');
  if (qty) {
    const b = job?.bodies.find(x => x.id === qty.dataset.qty);
    if (b) editBody(b.id, { qty: Math.max(1, bodyView(b).qty + Number(qty.dataset.d)) });
    return;
  }
  const ex = t.closest<HTMLElement>('[data-expand]');
  if (ex) { const id = ex.dataset.expand!; expanded.has(id) ? expanded.delete(id) : expanded.add(id); renderCuts(); return; }
  const step = t.closest<HTMLElement>('[data-step]');
  if (step) {
    const sheet = Number(step.dataset.sheet), i = Number(step.dataset.step);
    stepOf.set(sheet, stepOf.get(sheet) === i ? -1 : i);
    renderCuts();
    document.querySelector(`[data-sheet-draw="${sheet}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return;
  }
  const piece = t.closest<SVGGElement>('.r-part');
  if (piece?.dataset.body) selectBody(piece.dataset.body, false);
});
$('tab-cuts').addEventListener('change', e => {
  const t = e.target as HTMLInputElement | HTMLSelectElement;
  if (t.dataset.include) editBody(t.dataset.include, { selected: (t as HTMLInputElement).checked });
  if (t.dataset.grain) editBody(t.dataset.grain, { grain: t.value as RemoteBody['grain'] });
  if (t.dataset.rot) editBody(t.dataset.rot, { rotation: t.value as RemoteBody['rotation'] });
});
$('card').addEventListener('change', e => {
  const t = e.target as HTMLInputElement;
  if (t.dataset.prog && t.dataset.key) void setProgress(t.dataset.key, t.dataset.prog as 'cut' | 'assembled', t.checked);
});
$('chips').addEventListener('click', e => {
  const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-body]');
  if (chip) selectBody(chip.dataset.body!, true);
});
$<HTMLInputElement>('explode').addEventListener('input', e => viewer?.explode(Number((e.target as HTMLInputElement).value) / 100));
$('isolate').onclick = () => { isolated = !isolated; viewer?.isolate(isolated); $('isolate').setAttribute('aria-pressed', String(isolated)); };
$('resetView').onclick = () => {
  viewer?.reset(); isolated = false; $('isolate').setAttribute('aria-pressed', 'false');
  $<HTMLInputElement>('explode').value = '0'; selectBody(null, false);
};

// ------------------------------------------------------------------ sync
async function loadJob() {
  try {
    const res = await fetch('/__remote/job');
    if (!res.ok) { job = null; render(); return; }
    const body = await res.json() as { job: RemoteJob };
    job = body.job;
    // The republished job carries every edit sent before it.
    pending.clear();
    if (selectedBody && !job.bodies.some(b => b.id === selectedBody)) selectedBody = null;
    for (const [n] of stepOf) if (!job.plan?.sheets.some(s => s.number === n)) stepOf.delete(n);
    applyLink();
  } catch { /* the next event retries */ }
}
function connect() {
  const events = new EventSource('/__remote/events?role=phone');
  events.addEventListener('open', () => { connected = true; renderHeader(); });
  events.addEventListener('error', () => { connected = false; renderHeader(); });
  events.addEventListener('hello', e => {
    const h = JSON.parse((e as MessageEvent).data) as { rev: number; modelsRev: string; progress: RemoteProgress };
    connected = true; progress = h.progress; modelsRev = h.modelsRev;
    if (h.rev) void loadJob(); else render();
    if (tab === '3d') void ensureModels();
  });
  events.addEventListener('job', () => void loadJob());
  events.addEventListener('models', e => {
    modelsRev = JSON.parse((e as MessageEvent).data).rev;
    if (tab === '3d') void ensureModels();
  });
  events.addEventListener('progress', e => { progress = JSON.parse((e as MessageEvent).data); render(); });
  events.addEventListener('presence', e => { deskOnline = JSON.parse((e as MessageEvent).data).desk; renderHeader(); });
}
$<HTMLSelectElement>('section').addEventListener('change', e => {
  section = (e.target as HTMLSelectElement).value || null;
  if (selectedBody && !sectionIds().has(selectedBody)) selectedBody = null;
  viewer?.showOnly(section ? [...sectionIds()] : null);
  viewer?.select(selectedBody);
  writeHash();
  render();
});
window.addEventListener('hashchange', () => { readHash(); applyLink(); });
readHash();
connect();
render();
