/**
 * The on-canvas CAE fringe legend.
 *
 * A floating panel over the 3D viewer, in the shape every FE post-processor
 * uses: a vertical colour bar reading high-at-top, a value against each band,
 * the field name and unit above it, and the min/max extremes below. A gear
 * opens the customisation popover — colour map, band count, range, precision —
 * and every change is handed straight back to the caller so the CONTOUR is
 * repainted with it. The legend never describes a scale the geometry isn't
 * painted with, because both read the same `LegendSpec`.
 */

import {
  DEFAULT_LEGEND,
  colorMapOptions,
  formatLegendValue,
  resolveLegendRange,
  sampleColorMap,
  type LegendSpec,
} from './cae';

/** What the legend is currently describing. */
export interface LegendModel {
  /** Field name, e.g. "Deflection". */
  title: string;
  /** Unit shown under the title, e.g. "mm". */
  unit: string;
  /** Actual extremes of the field, for the auto range + the MIN/MAX footer. */
  dataMin: number;
  dataMax: number;
  /** Optional annotation for where the peak sits, e.g. "panel 1p". */
  maxAt?: string;
  /** Extra footer lines (element type, DOF, backend…). */
  info?: string[];
}

export interface CaeLegendHandle {
  /** Redraw for a new model, or pass null to hide the legend. */
  update(model: LegendModel | null): void;
  /** Current spec (the caller owns persistence). */
  spec(): LegendSpec;
  setSpec(spec: LegendSpec): void;
  destroy(): void;
}

const GEAR_SVG =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" '
  + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<circle cx="12" cy="12" r="3"/>'
  + '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.2.51.7.87 1.26.9H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'
  + '</svg>';

/**
 * Mount the legend into `host` (the viewer wrapper — it must be a positioned
 * element). `onChange` fires whenever the user edits the spec.
 */
export function mountCaeLegend(
  host: HTMLElement,
  onChange: (spec: LegendSpec) => void,
  initial?: Partial<LegendSpec>,
): CaeLegendHandle {
  let spec: LegendSpec = { ...DEFAULT_LEGEND, ...initial };
  let model: LegendModel | null = null;
  let popoverOpen = false;

  const root = document.createElement('div');
  root.className = 'cae-legend3d';
  root.hidden = true;
  host.appendChild(root);

  const emit = () => { onChange({ ...spec }); draw(); };

  // ---- the panel -----------------------------------------------------------
  function draw() {
    if (!model) { root.hidden = true; return; }
    root.hidden = false;
    const { lo, hi } = resolveLegendRange(spec, model.dataMin, model.dataMax);
    const bands = spec.bands > 0 ? spec.bands : 0;

    let barHtml: string;
    if (bands > 0) {
      // One row per band, top = highest. The value on a row is that band's
      // UPPER bound, so reading down gives the contour interval boundaries.
      const rows: string[] = [];
      for (let b = bands - 1; b >= 0; b--) {
        const tMid = (b + 0.5) / bands;
        const [r, g, bl] = sampleColorMap({ ...spec, bands: 0 }, quantise(tMid, spec));
        const upper = lo + ((b + 1) / bands) * (hi - lo);
        rows.push(
          `<div class="cae-legend3d-row">`
          + `<span class="cae-legend3d-sw" style="background:rgb(${r},${g},${bl})"></span>`
          + `<span class="cae-legend3d-val">${formatLegendValue(upper, spec)}</span>`
          + `</div>`,
        );
      }
      // The bottom edge of the lowest band.
      rows.push(
        `<div class="cae-legend3d-row cae-legend3d-row--edge">`
        + `<span class="cae-legend3d-sw cae-legend3d-sw--none"></span>`
        + `<span class="cae-legend3d-val">${formatLegendValue(lo, spec)}</span>`
        + `</div>`,
      );
      barHtml = `<div class="cae-legend3d-bands">${rows.join('')}</div>`;
    } else {
      // Continuous: a CSS gradient with 5 tick labels alongside.
      const stops: string[] = [];
      for (let i = 0; i <= 32; i++) {
        const t = i / 32;
        const [r, g, bl] = sampleColorMap({ ...spec, bands: 0 }, t);
        stops.push(`rgb(${r},${g},${bl}) ${t * 100}%`);
      }
      const ticks: string[] = [];
      for (let i = 4; i >= 0; i--) {
        ticks.push(`<span class="cae-legend3d-val">${formatLegendValue(lo + (i / 4) * (hi - lo), spec)}</span>`);
      }
      barHtml =
        `<div class="cae-legend3d-cont">`
        + `<span class="cae-legend3d-grad" style="background:linear-gradient(to top, ${stops.join(',')})"></span>`
        + `<div class="cae-legend3d-ticks">${ticks.join('')}</div>`
        + `</div>`;
    }

    const clipped = (spec.min != null && model.dataMin < lo) || (spec.max != null && model.dataMax > hi);
    const footer: string[] = [
      `<div class="cae-legend3d-ext"><b>max</b> ${formatLegendValue(model.dataMax, spec)}`
      + `${model.maxAt ? ` <span class="cae-legend3d-at">${escapeHtml(model.maxAt)}</span>` : ''}</div>`,
      `<div class="cae-legend3d-ext"><b>min</b> ${formatLegendValue(model.dataMin, spec)}</div>`,
    ];
    if (clipped) footer.push('<div class="cae-legend3d-warn">range clipped — values outside the scale are clamped</div>');
    for (const line of model.info ?? []) footer.push(`<div class="cae-legend3d-info">${escapeHtml(line)}</div>`);

    root.innerHTML =
      `<div class="cae-legend3d-head">`
      + `<div class="cae-legend3d-titles">`
      + `<div class="cae-legend3d-title">${escapeHtml(model.title)}</div>`
      + `<div class="cae-legend3d-unit">${escapeHtml(model.unit)}</div>`
      + `</div>`
      + `<button type="button" class="cae-legend3d-gear" title="Legend settings" aria-label="Legend settings">${GEAR_SVG}</button>`
      + `</div>`
      + barHtml
      + `<div class="cae-legend3d-foot">${footer.join('')}</div>`;

    root.querySelector<HTMLButtonElement>('.cae-legend3d-gear')!
      .addEventListener('click', (e) => { e.stopPropagation(); togglePopover(); });

    if (popoverOpen) root.appendChild(buildPopover());
  }

  /** Match sampleColorMap's band quantisation when pre-resolving a swatch. */
  function quantise(t: number, s: LegendSpec): number {
    if (s.bands <= 0) return s.reverse ? 1 - t : t;
    const b = Math.min(s.bands - 1, Math.floor(t * s.bands));
    const u = (b + 0.5) / s.bands;
    return s.reverse ? 1 - u : u;
  }

  // ---- customisation popover ----------------------------------------------
  function togglePopover() { popoverOpen = !popoverOpen; draw(); }

  function buildPopover(): HTMLElement {
    const pop = document.createElement('div');
    pop.className = 'cae-legend3d-pop';
    pop.addEventListener('click', (e) => e.stopPropagation());

    const maps = colorMapOptions()
      .map((m) => `<option value="${m.id}"${m.id === spec.map ? ' selected' : ''}>${m.label}</option>`)
      .join('');
    const bandOpts = [0, 5, 8, 10, 12, 16, 20, 24]
      .map((b) => `<option value="${b}"${b === spec.bands ? ' selected' : ''}>${b === 0 ? 'Smooth' : `${b} bands`}</option>`)
      .join('');
    const decOpts = [0, 1, 2, 3, 4]
      .map((d) => `<option value="${d}"${d === spec.decimals ? ' selected' : ''}>${d}</option>`)
      .join('');
    const auto = spec.min == null && spec.max == null;
    const { lo, hi } = model
      ? resolveLegendRange(spec, model.dataMin, model.dataMax)
      : { lo: 0, hi: 1 };

    pop.innerHTML =
      `<label>Colour map<select data-lg="map">${maps}</select></label>`
      + `<label>Contours<select data-lg="bands">${bandOpts}</select></label>`
      + `<label class="cae-legend3d-check"><input type="checkbox" data-lg="reverse"${spec.reverse ? ' checked' : ''}/><span>Reverse</span></label>`
      + `<label class="cae-legend3d-check"><input type="checkbox" data-lg="auto"${auto ? ' checked' : ''}/><span>Auto range (data min → max)</span></label>`
      // Round what's shown — a raw float64 auto-range bound fills the field
      // with 17 digits of noise nobody wants to edit around.
      + `<div class="cae-legend3d-range">`
      + `<label>Min<input type="number" step="any" data-lg="min" value="${tidy(lo)}"${auto ? ' disabled' : ''}/></label>`
      + `<label>Max<input type="number" step="any" data-lg="max" value="${tidy(hi)}"${auto ? ' disabled' : ''}/></label>`
      + `</div>`
      + `<div class="cae-legend3d-range">`
      + `<label>Decimals<select data-lg="decimals">${decOpts}</select></label>`
      + `<label class="cae-legend3d-check"><input type="checkbox" data-lg="sci"${spec.scientific ? ' checked' : ''}/><span>Sci</span></label>`
      + `</div>`
      + `<button type="button" class="cae-legend3d-reset" data-lg="reset">Reset</button>`;

    const q = <T extends HTMLElement>(sel: string) => pop.querySelector<T>(sel)!;

    q<HTMLSelectElement>('[data-lg="map"]').addEventListener('change', (e) => {
      spec = { ...spec, map: (e.target as HTMLSelectElement).value as LegendSpec['map'] };
      emit();
    });
    q<HTMLSelectElement>('[data-lg="bands"]').addEventListener('change', (e) => {
      spec = { ...spec, bands: Number((e.target as HTMLSelectElement).value) };
      emit();
    });
    q<HTMLInputElement>('[data-lg="reverse"]').addEventListener('change', (e) => {
      spec = { ...spec, reverse: (e.target as HTMLInputElement).checked };
      emit();
    });
    q<HTMLInputElement>('[data-lg="auto"]').addEventListener('change', (e) => {
      if ((e.target as HTMLInputElement).checked) {
        spec = { ...spec, min: null, max: null };
      } else {
        // Freeze the current auto range as the starting manual one.
        spec = { ...spec, min: lo, max: hi };
      }
      emit();
    });
    q<HTMLInputElement>('[data-lg="min"]').addEventListener('change', (e) => {
      const v = parseFloat((e.target as HTMLInputElement).value);
      spec = { ...spec, min: Number.isFinite(v) ? v : null };
      emit();
    });
    q<HTMLInputElement>('[data-lg="max"]').addEventListener('change', (e) => {
      const v = parseFloat((e.target as HTMLInputElement).value);
      spec = { ...spec, max: Number.isFinite(v) ? v : null };
      emit();
    });
    q<HTMLSelectElement>('[data-lg="decimals"]').addEventListener('change', (e) => {
      spec = { ...spec, decimals: Number((e.target as HTMLSelectElement).value) };
      emit();
    });
    q<HTMLInputElement>('[data-lg="sci"]').addEventListener('change', (e) => {
      spec = { ...spec, scientific: (e.target as HTMLInputElement).checked };
      emit();
    });
    q<HTMLButtonElement>('[data-lg="reset"]').addEventListener('click', () => {
      spec = { ...DEFAULT_LEGEND };
      emit();
    });
    return pop;
  }

  const closeOnOutside = (e: MouseEvent) => {
    if (!popoverOpen) return;
    if (!root.contains(e.target as Node)) { popoverOpen = false; draw(); }
  };
  document.addEventListener('click', closeOnOutside);

  return {
    update(next) { model = next; draw(); },
    spec: () => ({ ...spec }),
    setSpec(next) { spec = { ...next }; draw(); },
    destroy() {
      document.removeEventListener('click', closeOnOutside);
      root.remove();
    },
  };
}

/** Drop float noise from a value that's about to sit in a number input. */
function tidy(v: number): number {
  return Number.isFinite(v) ? Number(v.toPrecision(6)) : 0;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c
  ));
}
