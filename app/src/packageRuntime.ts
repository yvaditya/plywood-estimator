import type { PackageData, PackagePart, PackageSheet } from './packageData';
import { PackageViewer } from './packageViewer';
import { fmtDim } from './units';
import { cutMeasurement } from './packageCuts';

const data: PackageData = JSON.parse(document.getElementById('package-data')!.textContent!);
const phone = document.documentElement.dataset.layout === 'phone';
const app = document.getElementById('app')!;
const esc = (s: string | number) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const color = (s: string) => /^#[0-9a-f]{6}$/i.test(s) ? s : '#a8957d';
const dim = (n: number) => fmtDim(n, data.units);
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
type Progress = Record<string, { cut: boolean; assembled: boolean }>;
let progress: Progress = {};
const storageKey = `woodworking-package-v1-${data.id}`;
let persistent = true;
try {
  const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
  for (const p of data.parts) if (saved[p.key]) progress[p.key] = { cut: saved[p.key].cut === true, assembled: saved[p.key].assembled === true };
  localStorage.setItem(storageKey, JSON.stringify(progress));
} catch { persistent = false; }
let stage: 'cutting' | 'assembly' = 'cutting';
let mobileView: 'cuts' | 'parts' = 'cuts';
let selected: PackagePart | undefined;
let sheetIndex = 0;
let cutIndex = -1;
let sheetZoom = 1;
let viewer: PackageViewer | undefined;
let viewerAttempted = false;
let isolated = false;

app.innerHTML = `
  <header class="job-header"><div class="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M16 3 28 10v13l-12 7L4 23V10Z"/><path d="m4 10 12 7 12-7M16 17v13M10 6.5l12 7v7"/></svg></div>
    <div class="job-heading"><p class="eyebrow">WORKSHOP BUILD PACKAGE</p><h1 id="job-title">${esc(data.jobName)}</h1></div>
    <div class="job-meta"><strong>${data.parts.length} pieces <span>·</span> ${data.sheets.length} ${data.sheets.length===1?'sheet':'sheets'}</strong><span>${phone ? 'Phone' : 'PC / tablet'} edition · ${esc(data.units === 'mm' ? 'Millimetres' : 'Inches')}</span></div>
  </header>
  <nav class="workflow" aria-label="Build stages">
    <button data-stage="cutting" class="stage active" aria-pressed="true"><span class="stage-number">01</span><span><strong>Cut & check</strong><small>Cut sheets · inventory</small></span></button>
    <span class="stage-arrow" aria-hidden="true">→</span>
    <button data-stage="assembly" class="stage" aria-pressed="false"><span class="stage-number">02</span><span><strong>Assemble</strong><small>Explore the 3D model</small></span></button>
    <div class="job-progress"><span id="progress-text" aria-live="polite"></span><progress id="build-progress" max="${data.parts.length * 2}" value="0" aria-label="Build progress"></progress></div>
  </nav>
  <div class="stage-intro"><div><p class="eyebrow" id="stage-kicker">STEP 01 / PREPARE YOUR PARTS</p><h2 id="stage-title">Cut. Label. Check.</h2></div><p id="stage-help">Follow the sheet layout, label each piece with its code, then check it off in the inventory.</p></div>
  <nav class="mobile-switch" aria-label="Cutting views"><button data-view="cuts" class="active" aria-pressed="true">Cut sheets</button><button data-view="parts" aria-pressed="false">Inventory table</button></nav>
  <main id="workspace" data-stage="cutting" data-mobile-view="cuts">
    <section id="cuts-panel" class="panel drawing-panel" aria-label="Cut sheets">
      <div class="panel-heading"><div><p class="eyebrow">CUTTING PLAN</p><h3>Sheet layouts</h3></div><select id="sheet-select" aria-label="Choose sheet">${data.sheets.map((s,i)=>`<option value="${i}">Sheet ${s.number} · ${esc(dim(s.thickness))}</option>`).join('')}</select></div>
      <p id="sheet-meta" class="muted"></p><div class="drawing-tools"><button id="sheet-zoom-out" aria-label="Zoom out sheet">−</button><span id="sheet-zoom-label">100%</span><button id="sheet-zoom-in" aria-label="Zoom in sheet">+</button><button id="sheet-fit">Fit sheet</button><span>Tap a piece to find it in the inventory</span></div>
      <div id="sheet-scroll"><div id="sheet-drawing"></div></div>
      <div id="cut-step" class="cut-step"></div>
      <div class="cut-controls"><button id="previous-cut">← Previous</button><select id="cut-select" aria-label="Choose cutting step"></select><button id="next-cut">Next →</button></div>
      <p id="cut-note" class="fine-print"></p>
    </section>
    <section id="assembly-panel" class="panel drawing-panel" aria-label="Assembly model">
      <div class="panel-heading"><div><p class="eyebrow">ASSEMBLY REFERENCE</p><h3>See how it fits</h3></div><button id="reset-view">Reset view</button></div>
      <div id="model"><span class="model-hint">Drag to rotate · pinch or scroll to zoom · tap a part</span></div>
      <div class="model-controls"><label for="explode">Explode assembly</label><input id="explode" type="range" min="0" max="100" value="0"><output id="explode-value" for="explode">0%</output></div>
      <div class="model-actions"><button id="isolate" aria-pressed="false" disabled>Isolate selected</button><button id="restore-all">Show all parts</button></div>
      <p class="fine-print">Select a part in the model or inventory to see its identity and sheet location. The exploded view shows positions, not a prescribed assembly order.</p>
    </section>
    <aside id="inventory-panel" class="panel" aria-label="Part inventory">
      <div class="panel-heading"><div><p class="eyebrow">EVERY PIECE ACCOUNTED FOR</p><h3>Part inventory</h3></div><span class="count-badge">${data.parts.length}</span></div>
      <div class="inventory-tools"><input id="part-search" type="search" placeholder="Find part, code or cabinet…" aria-label="Search inventory"><select id="part-filter" aria-label="Filter inventory"><option value="all">All parts</option><option value="uncut">Still to cut</option><option value="unassembled">Still to assemble</option><option value="unplaced">Unplaced</option></select></div>
      <div class="table-scroll"><table class="inventory-table"><caption class="sr-only">Part inventory with dimensions, quantities, sheet locations and build progress</caption><thead><tr><th scope="col">Part / code</th><th scope="col">L × W × T</th><th scope="col">Qty</th><th scope="col">Sheet</th><th scope="col">Cut</th><th scope="col">Assembled</th></tr></thead><tbody id="inventory-body"></tbody></table></div>
      <p id="inventory-empty" class="empty" hidden>No parts match this filter.</p><p class="fine-print">Each row is one physical piece. Use the panel code to match it to the sheet and model.</p>
    </aside>
    <section id="selected-details" class="panel selected-details" aria-label="Selected part" aria-live="polite"></section>
  </main>
  <footer class="package-footer"><span id="storage-note"></span><span>Snapshot · ${esc(new Date(data.createdAt).toLocaleDateString())}</span></footer>`;

function saveProgress() {
  if (persistent) try { localStorage.setItem(storageKey, JSON.stringify(progress)); } catch { persistent = false; }
  const cuts = data.parts.filter(p => progress[p.key]?.cut).length;
  const assembled = data.parts.filter(p => progress[p.key]?.assembled).length;
  $('progress-text').textContent = `${cuts} cut · ${assembled} assembled / ${data.parts.length}`;
  $<HTMLProgressElement>('build-progress').value = cuts + assembled;
  $('storage-note').textContent = persistent ? 'Checklist saved in this browser. Other devices keep their own progress.' : 'Checklist lasts for this session. Browser storage is unavailable.';
}
function renderInventory() {
  const query = $<HTMLInputElement>('part-search').value.toLowerCase().trim();
  const filter = $<HTMLSelectElement>('part-filter').value;
  const parts = data.parts.filter(p => `${p.code} ${p.name} ${p.fileTag}`.toLowerCase().includes(query)
    && (filter === 'all' || filter === 'uncut' && !progress[p.key]?.cut || filter === 'unassembled' && !progress[p.key]?.assembled || filter === 'unplaced' && p.sheet === null));
  $('inventory-body').innerHTML = parts.map(p => `<tr data-part-key="${esc(p.key)}" class="${p.key === selected?.key ? 'selected' : ''}">
    <th scope="row"><button class="part-select" data-key="${esc(p.key)}" aria-pressed="${p.key===selected?.key}"><span class="part-code" style="--part-color:${color(p.color)}">${esc(p.code)}</span><span class="part-name">${esc(p.name)}<small>${esc(p.fileTag)}</small></span></button></th>
    <td class="dimensions">${esc(dim(p.length))}<br>${esc(dim(p.width))}<br><span>${esc(dim(p.thickness))}</span></td><td class="numeric">1</td><td class="numeric">${p.sheet ?? '—'}</td>
    <td><input type="checkbox" class="cut-check" data-key="${esc(p.key)}" aria-label="Cut ${esc(p.code)} ${esc(p.name)}" ${progress[p.key]?.cut ? 'checked' : ''}></td>
    <td><input type="checkbox" class="assembled-check" data-key="${esc(p.key)}" aria-label="Assembled ${esc(p.code)} ${esc(p.name)}" ${progress[p.key]?.assembled ? 'checked' : ''}></td></tr>`).join('');
  $('inventory-empty').hidden = parts.length > 0;
}
function renderDetails() {
  const el = $('selected-details');
  if (!selected) { el.innerHTML = '<p class="eyebrow">PART FINDER</p><h3>Select a piece to connect the dots.</h3><p class="muted">Its code connects the cut sheet, inventory and assembled model.</p>'; return; }
  const p = selected;
  const quantity = data.parts.filter(x => x.partId === p.partId).length;
  el.innerHTML = `<div class="detail-title"><span class="part-code" style="--part-color:${color(p.color)}">${esc(p.code)}</span><div><p class="eyebrow">SELECTED PIECE</p><h3>${esc(p.name)}</h3><p class="muted">${esc(p.fileTag)}</p></div></div>
    <dl class="part-facts"><div><dt>Length</dt><dd>${esc(dim(p.length))}</dd></div><div><dt>Width</dt><dd>${esc(dim(p.width))}</dd></div><div><dt>Thickness</dt><dd>${esc(dim(p.thickness))}</dd></div><div><dt>Quantity</dt><dd>${quantity} of this part</dd></div><div><dt>Location</dt><dd>${p.sheet === null ? 'Unplaced — no cut sheet' : `Sheet ${p.sheet}`}</dd></div></dl>
    ${p.segment ? `<p class="segment-note">${esc(p.segment)}</p>` : ''}
    <div class="detail-actions"><button id="show-model" class="primary">Show in model →</button><button id="show-sheet" ${p.sheet===null?'disabled':''}>Show on sheet</button><button id="clear-selection">Clear selection</button></div>`;
  $('show-model').onclick = () => { setStage('assembly'); if (phone) $('assembly-panel').scrollIntoView({ block: 'start' }); };
  $('show-sheet').onclick = () => { if (p.sheet !== null) { setStage('cutting'); setMobileView('cuts'); sheetIndex = data.sheets.findIndex(s => s.number === p.sheet); cutIndex=-1; renderSheet(); $('cuts-panel').scrollIntoView({block:'start'}); } };
  $('clear-selection').onclick = () => selectPart(undefined);
}
function selectPart(p: PackagePart | undefined) {
  selected = p; viewer?.select(p?.bodyId ?? null);
  if (isolated) { isolated = false; viewer?.isolate(false); }
  $<HTMLButtonElement>('isolate').disabled = !p;
  $('isolate').setAttribute('aria-pressed','false');
  if (p?.sheet !== null && p?.sheet !== undefined && data.sheets[sheetIndex]?.number !== p.sheet) {
    sheetIndex = data.sheets.findIndex(s => s.number === p.sheet); cutIndex = -1;
  }
  renderInventory(); renderDetails(); renderSheet();
}
function setMobileView(view: 'cuts' | 'parts') {
  mobileView = view; $('workspace').dataset.mobileView = view;
  document.querySelectorAll<HTMLElement>('[data-view]').forEach(el => { const on = el.dataset.view === view; el.classList.toggle('active',on); el.setAttribute('aria-pressed',String(on)); });
}
function setStage(next: 'cutting' | 'assembly') {
  stage = next; $('workspace').dataset.stage = stage; document.body.dataset.stage = stage;
  document.querySelectorAll<HTMLElement>('[data-stage].stage').forEach(el => { const on=el.dataset.stage===stage;el.classList.toggle('active',on);el.setAttribute('aria-pressed',String(on)); });
  $('stage-kicker').textContent = stage === 'cutting' ? 'STEP 01 / PREPARE YOUR PARTS' : 'STEP 02 / PUT IT TOGETHER';
  $('stage-title').textContent = stage === 'cutting' ? 'Cut. Label. Check.' : 'A place for every piece.';
  $('stage-help').textContent = stage === 'cutting' ? 'Follow the sheet layout, label each piece with its code, then check it off in the inventory.' : 'Rotate the assembly, pull it apart, and select a piece to understand where it belongs.';
  if (stage === 'assembly' && !viewerAttempted) {
    viewerAttempted = true;
    try { viewer = new PackageViewer($('model'),data.models,id => selectPart(data.parts.find(p=>p.bodyId===id && p.key===selected?.key) ?? data.parts.find(p=>p.bodyId===id))); viewer.select(selected?.bodyId ?? null); }
    catch (err) { $('model').querySelector('canvas')?.remove(); $('model').insertAdjacentHTML('beforeend','<p class="model-error"><strong>3D view unavailable</strong><br>Open this file in a browser with WebGL enabled. Your inventory and cut sheets are still available.</p>'); for (const id of ['explode','isolate','reset-view','restore-all']) ($<HTMLButtonElement | HTMLInputElement>(id)).disabled=true; }
  }
  if (stage === 'assembly') requestAnimationFrame(()=>viewer?.resize());
}
function path(rings: [number,number][][], x: number, y: number) {
  return rings.map(ring=>ring.map(([px,py],i)=>`${i?'L':'M'}${px+x},${py+y}`).join(' ')+'Z').join(' ');
}
function renderSheet() {
  const s = data.sheets[sheetIndex];
  if (!s) { $('sheet-drawing').innerHTML='<p class="empty">No parts fit the stock sheets. See the unplaced pieces in the inventory.</p>'; $('sheet-meta').textContent='No cut layouts'; $('cut-step').innerHTML=''; $('cut-select').innerHTML=''; $<HTMLButtonElement>('previous-cut').disabled=true; $<HTMLButtonElement>('next-cut').disabled=true; return; }
  $<HTMLSelectElement>('sheet-select').value=String(sheetIndex);
  $('sheet-meta').textContent=`${dim(s.width)} × ${dim(s.length)} · ${dim(s.thickness)} stock · ${s.parts.length} pieces`;
  const labelSize = Math.max(s.width,s.length) / (phone ? 23 : 42);
  const svgParts = s.parts.map(p=>{
    const linked = data.parts.find(x=>x.key===p.key)!;
    const selectedBody=selected?.bodyId === linked.bodyId;
    return `<g class="sheet-part ${selected?.key===p.key?'selected':selectedBody?'related':''}" tabindex="0" role="button" aria-label="${esc(linked.code)} ${esc(linked.name)}" data-key="${esc(p.key)}"><path d="${path([p.outer,...p.holes],p.x,p.y)}" fill="${color(p.color)}" fill-rule="evenodd"/><text x="${p.x+p.w/2}" y="${p.y+p.h/2}" font-size="${Math.min(labelSize,Math.min(p.w,p.h)*.4)}" text-anchor="middle" dominant-baseline="middle">${esc(linked.code)}</text></g>`;
  }).join('');
  let overlay='';
  const cur=s.steps[cutIndex];
  if (cur) {
    const { vertical }=cutMeasurement(cur,s,data);
    const x=cur.parentX+(vertical?cur.distance:0),y=cur.parentY+(vertical?0:cur.distance);
    overlay=`<g class="cut-overlay"><rect x="${cur.parentX}" y="${cur.parentY}" width="${cur.parentW}" height="${cur.parentH}" fill="none" stroke="#265f5a" stroke-width="3" vector-effect="non-scaling-stroke" stroke-dasharray="6 5"/><line x1="${x}" y1="${y}" x2="${vertical?x:x+cur.parentW}" y2="${vertical?y+cur.parentH:y}" stroke="#d94824" stroke-width="4" vector-effect="non-scaling-stroke"/></g>`;
  }
  $('sheet-drawing').innerHTML=`<svg viewBox="-8 -8 ${s.width+16} ${s.length+16}" aria-label="Sheet ${s.number} cutting layout"><rect width="${s.width}" height="${s.length}" fill="#e8dfcb" stroke="#aca18e" stroke-width="2"/>${svgParts}${overlay}</svg>`;
  updateZoom();
  $('cut-select').innerHTML=`<option value="-1">Full sheet overview</option>${s.steps.map((c,i)=>`<option value="${i}">${c.isTrim?'Trim':'Cut'} ${i+1} of ${s.steps.length}</option>`).join('')}`;
  $<HTMLSelectElement>('cut-select').value=String(cutIndex);
  if (cur) {
    const m=cutMeasurement(cur,s,data);
    $('cut-step').innerHTML=`<span class="cut-number">${cur.index.toString().padStart(2,'0')}</span><div><p class="eyebrow">${cur.isTrim?'SQUARING TRIM':cur.isDatum?'REFERENCE CUT':cur.axis==='rip'?'RIP CUT':'CROSSCUT'} ${cur.sameSetting?'· SAME SETTING':''}</p><strong>${esc(dim(m.distance))}</strong><p>${cur.isTrim ? 'Trim from the stock edge' : `Measure from ${esc(m.from)} of the outlined piece`} · ${esc(data.kerfRef)} reference</p></div>`;
  } else $('cut-step').innerHTML='<span class="cut-number">→</span><div><p class="eyebrow">START WITH THE FULL SHEET</p><strong>Check the layout before cutting.</strong><p>Use Next to walk through the cut sequence.</p></div>';
  $('cut-note').textContent=`Kerf ${dim(data.kerf)} · margin ${dim(data.margin)}. `+(data.strategy.startsWith('cnc')?'CNC layout: follow the part contours, including holes.':s.isGuillotineTree?'Red line = current cut. Dashed outline = the piece on your bench.':'Suggested cut lines; check clearance and cutting access before making each cut.');
  if (data.strategy.startsWith('cnc')) { $('cut-step').innerHTML='<p>Contour cutting layout — select a part to inspect its shape and holes.</p>'; $('cut-select').innerHTML='<option>No straight-cut sequence</option>'; }
  $<HTMLButtonElement>('previous-cut').disabled=cutIndex<0;
  $<HTMLButtonElement>('next-cut').disabled=cutIndex>=s.steps.length-1 || data.strategy.startsWith('cnc');
}
function updateZoom() {
  $('sheet-drawing').style.width=`${sheetZoom*100}%`;
  $('sheet-zoom-label').textContent=`${Math.round(sheetZoom*100)}%`;
}
document.querySelectorAll<HTMLElement>('.stage').forEach(el=>el.onclick=()=>setStage(el.dataset.stage as typeof stage));
document.querySelectorAll<HTMLElement>('[data-view]').forEach(el=>el.onclick=()=>setMobileView(el.dataset.view as typeof mobileView));
$('inventory-body').addEventListener('click',e=>{
  const button=(e.target as HTMLElement).closest<HTMLElement>('.part-select');
  if(button) selectPart(data.parts.find(p=>p.key===button.dataset.key));
});
$('inventory-body').addEventListener('change',e=>{
  const check=e.target as HTMLInputElement;
  if (!check.matches('input[type=checkbox]'))return;
  const key=check.dataset.key!; const value=progress[key]??{cut:false,assembled:false};
  if (check.classList.contains('cut-check')) value.cut=check.checked; else value.assembled=check.checked;
  progress[key]=value;saveProgress();
  if($<HTMLSelectElement>('part-filter').value!=='all')renderInventory();
});
$('part-search').addEventListener('input',renderInventory);$('part-filter').addEventListener('change',renderInventory);
function pickSheet(e: Event) {
  const part=(e.target as HTMLElement).closest<HTMLElement>('.sheet-part');
  if(part)selectPart(data.parts.find(p=>p.key===part.dataset.key));
}
$('sheet-drawing').addEventListener('click',pickSheet);
$('sheet-drawing').addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();pickSheet(e);}});
$('sheet-select').addEventListener('change',()=>{sheetIndex=Number($<HTMLSelectElement>('sheet-select').value);cutIndex=-1;sheetZoom=1;renderSheet();});
$('cut-select').addEventListener('change',()=>{cutIndex=Number($<HTMLSelectElement>('cut-select').value);renderSheet();});
$('next-cut').onclick=()=>{cutIndex++;renderSheet();};$('previous-cut').onclick=()=>{cutIndex--;renderSheet();};
$('sheet-zoom-in').onclick=()=>{sheetZoom=Math.min(4,sheetZoom+.5);updateZoom();};$('sheet-zoom-out').onclick=()=>{sheetZoom=Math.max(1,sheetZoom-.5);updateZoom();};$('sheet-fit').onclick=()=>{sheetZoom=1;updateZoom();};
$('explode').addEventListener('input',()=>{const v=Number($<HTMLInputElement>('explode').value);$('explode-value').textContent=`${v}%`;viewer?.explode(v/100);});
$('reset-view').onclick=()=>{viewer?.reset();isolated=false;$('isolate').setAttribute('aria-pressed','false');$<HTMLInputElement>('explode').value='0';$('explode-value').textContent='0%';};
$('isolate').onclick=()=>{isolated=!isolated;viewer?.isolate(isolated);$('isolate').setAttribute('aria-pressed',String(isolated));};
$('restore-all').onclick=()=>{isolated=false;viewer?.isolate(false);selectPart(undefined);};
saveProgress();renderInventory();renderDetails();renderSheet();setStage('cutting');
// Keep the readable preview if parsing or startup fails in an attachment viewer.
app.hidden = false;
document.getElementById('package-preview')?.remove();
