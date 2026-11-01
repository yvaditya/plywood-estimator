import type { PackageData } from './packageData';
import { cutMeasurement } from './packageCuts';
import { fmtDim } from './units';
export type PackageLayout = 'pc' | 'phone';
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** File previews can block scripts entirely. Put useful job content in the document itself. */
function buildPreview(data: PackageData): string {
  const dim = (value: number) => escape(fmtDim(value, data.units));
  const color = (value: string) => /^#[0-9a-f]{6}$/i.test(value) ? value : '#a8957d';
  const parts = new Map(data.parts.map(part => [part.key, part]));
  const inventory = data.parts.map(part => `<tr>
    <th scope="row"><div class="preview-part"><span class="part-code" style="--part-color:${color(part.color)}">${escape(part.code)}</span><span class="part-name">${escape(part.name)}<small>${escape(part.fileTag)}</small>${part.segment ? `<small>${escape(part.segment)}</small>` : ''}</span></div></th>
    <td class="dimensions">${dim(part.length)}<br>${dim(part.width)}<br><span>${dim(part.thickness)}</span></td>
    <td class="numeric">1</td><td>${part.sheet === null ? 'Unplaced' : `Sheet ${part.sheet}`}</td></tr>`).join('');
  const sheets = data.sheets.map(sheet => {
    const shapes = sheet.parts.map(part => {
      const code = parts.get(part.key)!.code;
      const path = [part.outer, ...part.holes].map(ring => ring.map(([x, y], i) => `${i ? 'L' : 'M'}${x + part.x},${y + part.y}`).join(' ') + 'Z').join(' ');
      const labelSize = Math.min(Math.max(sheet.width, sheet.length) / 32, Math.min(part.w, part.h) * .4);
      return `<g><path d="${path}" fill="${color(part.color)}" fill-rule="evenodd" stroke="#65656d" stroke-width="1" vector-effect="non-scaling-stroke"/><text x="${part.x + part.w / 2}" y="${part.y + part.h / 2}" font-size="${labelSize}" text-anchor="middle" dominant-baseline="middle">${escape(code)}</text></g>`;
    }).join('');
    const steps = data.strategy.startsWith('cnc') ? '<p class="fine-print">Contour cutting layout: follow the part contours, including holes.</p>'
      : sheet.steps.length ? `<h3>Cutting steps</h3><ol class="preview-cut-steps">${sheet.steps.map(step => {
        const measurement = cutMeasurement(step, sheet, data);
        const kind = step.isTrim ? 'Squaring trim' : step.isDatum ? 'Reference cut' : step.axis === 'rip' ? 'Rip cut' : 'Crosscut';
        return `<li><strong>${kind} ${step.index} · ${dim(measurement.distance)}</strong>
          <p>${step.isTrim ? 'Trim' : 'Measure'} from ${escape(measurement.from)} of the workpiece · ${escape(data.kerfRef)} reference${step.sameSetting ? ' · Same setting' : ''}.</p>
          <p class="fine-print">Workpiece: ${dim(step.parentW)} × ${dim(step.parentH)}. Position on sheet: ${dim(step.parentX)} from left, ${dim(step.parentY)} from top.</p></li>`;
      }).join('')}</ol>` : '<p class="fine-print">No straight-cut sequence is available for this sheet.</p>';
    return `<section id="preview-sheet-${sheet.number}" class="panel preview-sheet" aria-label="Sheet ${sheet.number}">
      <div class="panel-heading"><div><p class="eyebrow">CUTTING PLAN</p><h2>Sheet ${sheet.number}</h2></div></div>
      <p class="muted">${dim(sheet.width)} × ${dim(sheet.length)} · ${dim(sheet.thickness)} stock · ${sheet.parts.length} pieces</p>
      <svg class="preview-sheet-drawing" role="img" aria-label="Sheet ${sheet.number} cutting layout" viewBox="-8 -8 ${sheet.width + 16} ${sheet.length + 16}" xmlns="http://www.w3.org/2000/svg"><rect width="${sheet.width}" height="${sheet.length}" fill="#e8dfcb" stroke="#aca18e" stroke-width="2"/>${shapes}</svg>
      <p class="fine-print">Kerf ${dim(data.kerf)} · margin ${dim(data.margin)}.${!data.strategy.startsWith('cnc') && !sheet.isGuillotineTree ? ' Suggested cut lines; check clearance and cutting access before making each cut.' : ''}</p>
      ${steps}</section>`;
  }).join('');
  return `<div id="package-preview">
    <header class="job-header"><div class="job-heading"><p class="eyebrow">WORKSHOP BUILD PACKAGE</p><h1>${escape(data.jobName)}</h1></div><div class="job-meta"><strong>${data.parts.length} pieces · ${data.sheets.length} ${data.sheets.length === 1 ? 'sheet' : 'sheets'}</strong><span>${data.units === 'mm' ? 'Millimetres' : 'Inches'}</span></div></header>
    <main class="preview-content">
      <aside class="panel preview-notice" aria-label="About this preview"><h2>Read-only preview</h2><p>Your cut list, sheet layouts and cutting steps are below. Interactive 3D and saved checklists require a browser or HTML viewer that runs JavaScript.</p></aside>
      <nav class="preview-links" aria-label="Build information"><a href="#preview-inventory">Part inventory</a>${data.sheets.map(sheet => `<a href="#preview-sheet-${sheet.number}">Sheet ${sheet.number}</a>`).join('')}</nav>
      <section id="preview-inventory" class="panel"><div class="panel-heading"><h2>Part inventory</h2><span class="count-badge">${data.parts.length}</span></div>
        <div class="table-scroll"><table class="inventory-table preview-inventory"><caption class="sr-only">Every physical piece with its dimensions and sheet location</caption><thead><tr><th scope="col">Part / code</th><th scope="col">L × W × T</th><th scope="col">Qty</th><th scope="col">Sheet</th></tr></thead><tbody>${inventory}</tbody></table></div>
        <p class="fine-print">Each row is one physical piece. Match its code to the sheet layout.</p></section>
      ${sheets || '<p class="panel">No parts fit the stock sheets. See the unplaced pieces in the inventory.</p>'}
    </main></div>`;
}

export function buildPackageHtml(data: PackageData, layout: PackageLayout, runtime: string, css: string): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<!doctype html>
<html lang="en" data-layout="${layout}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light"><title>${escape(data.jobName)} · Build package</title>
<style>${css.replace(/<\/style/gi, '<\\/style')}</style></head><body>
${buildPreview(data)}
<div id="app" hidden></div>
<script id="package-data" type="application/json">${json}</script>
<script>${runtime.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
}
