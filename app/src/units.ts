/**
 * Unit conversion + display helpers.
 *
 * Imperial display uses fractional inches (1/16" precision by default)
 * rounded to the nearest tick — standard for woodworking and cabinetry.
 *
 * Examples (denom = 16):
 *   0.125 in  →  1/16... no, 0.125 → 2/16 → 1/8"
 *   0.25  in  →  1/4"
 *   48     in →  48"
 *   48.25  in →  48-1/4"
 *   1.5    in →  1-1/2"
 */

export type Units = 'mm' | 'in';

export const MM_PER_INCH = 25.4;

export function mmToIn(mm: number): number {
  return mm / MM_PER_INCH;
}
export function inToMm(inches: number): number {
  return inches * MM_PER_INCH;
}

function gcd(a: number, b: number): number {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { [a, b] = [b, a % b]; }
  return a;
}

/**
 * Format a length in inches as a fractional string like  48-1/4"  or  1/8".
 * `denom` is the smallest fraction tick (default 1/16"). Use 32 or 64 for finer.
 */
export function fmtFracInches(inches: number, denom = 16): string {
  const sign = inches < 0 ? '-' : '';
  const abs = Math.abs(inches);
  const whole = Math.floor(abs);
  let frac = Math.round((abs - whole) * denom);
  let wholePart = whole;
  if (frac === denom) { wholePart += 1; frac = 0; }
  if (frac === 0) return `${sign}${wholePart}"`;
  const g = gcd(frac, denom);
  const num = frac / g, den = denom / g;
  if (wholePart === 0) return `${sign}${num}/${den}"`;
  return `${sign}${wholePart}-${num}/${den}"`;
}

/** Format a length given in millimetres in the user's chosen units. */
export function fmtDim(mm: number, units: Units, denom = 16): string {
  if (units === 'in') return fmtFracInches(mmToIn(mm), denom);
  // mm — one decimal place
  return `${mm.toFixed(1)} mm`;
}

/**
 * Format a small deflection/sag length. Fractional-inch rounding (1/16")
 * swallows sub-millimetre sags to 0", so sag gets decimal precision:
 * mm → 1 dp, inches → 2 dp (0.02"), always with the unit suffix.
 */
export function fmtSag(mm: number, units: Units): string {
  if (units === 'in') return `${(mm / MM_PER_INCH).toFixed(2)}"`;
  return `${mm.toFixed(mm < 10 ? 2 : 1)} mm`;
}

/** Format an area given in mm². */
export function fmtArea(mm2: number, units: Units): string {
  if (units === 'in') {
    const sqin = mm2 / (MM_PER_INCH * MM_PER_INCH);
    if (sqin > 144) return `${(sqin / 144).toFixed(2)} ft²`;
    return `${sqin.toFixed(1)} in²`;
  }
  if (mm2 > 1e6) return `${(mm2 / 1e6).toFixed(2)} m²`;
  return `${(mm2 / 100).toFixed(0)} cm²`;
}

/** Convert a value from user units → mm. */
export function toMm(v: number, units: Units): number {
  if (!Number.isFinite(v)) return 0;
  return units === 'in' ? v * MM_PER_INCH : v;
}

/** Convert a value from mm → user units. */
export function fromMm(mm: number, units: Units): number {
  return units === 'in' ? mm / MM_PER_INCH : mm;
}

/** Format a linear length (e.g. edge-banding total) in feet/inches or metres. */
export function fmtLinear(mm: number, units: Units): string {
  if (units === 'in') {
    const inches = mm / MM_PER_INCH;
    if (inches < 12) return `${inches.toFixed(1)}"`;
    const feet = Math.floor(inches / 12);
    const rem = inches - feet * 12;
    return rem < 0.1 ? `${feet} ft` : `${feet} ft ${rem.toFixed(1)}"`;
  }
  if (mm < 1000) return `${mm.toFixed(0)} mm`;
  return `${(mm / 1000).toFixed(2)} m`;
}

/**
 * Parse a free-typed dimension string into millimetres.
 *
 * Accepts, case-insensitively and whitespace-tolerantly:
 *   - plain numbers ("24", "0.5", ".5")   → interpreted in `fallbackUnits`
 *   - explicit imperial: 24", 24in, 24 in, 24inch, 24 inches
 *   - feet:              2', 2ft, 2 ft, 2 foot, 2 feet
 *   - metric:            4mm, 4 mm, 1.2cm, 0.5m
 *   - imperial fractions: 3/4", 1-1/2", 24 1/2", 3/4 in  (dash OR space sep)
 *
 * Returns `{ mm }` on success, or `null` for anything unparseable
 * (never NaN). Feet+inches like  2' 6"  is also supported.
 */
export function parseDimInput(
  raw: string,
  fallbackUnits: Units,
): { mm: number } | null {
  if (raw == null) return null;
  let s = String(raw).trim().toLowerCase();
  if (s === '') return null;

  // Normalise unicode prime/quote glyphs to plain ASCII.
  s = s
    .replace(/[′ʹ’‘]/g, "'")   // ′ ʹ ' ' → '
    .replace(/[″ʺ“”]/g, '"');  // ″ ʺ " " → "

  // Compound feet + inches:  2' 6",  2ft 6in,  2' 6-1/2"
  const ftIn = s.match(
    /^(\d+(?:\.\d+)?)\s*(?:'|ft|foot|feet)\s*(.+?)\s*(?:"|in|inch|inches)?$/,
  );
  if (ftIn && /['f]/.test(ftIn[0])) {
    const feet = parseFloat(ftIn[1]);
    const inchPart = parseInchScalar(ftIn[2]);
    if (Number.isFinite(feet) && inchPart != null) {
      return { mm: (feet * 12 + inchPart) * MM_PER_INCH };
    }
  }

  // Feet only:  2',  2ft,  2 feet
  const ft = s.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft|foot|feet)$/);
  if (ft) {
    const v = parseFloat(ft[1]);
    return Number.isFinite(v) ? { mm: v * 12 * MM_PER_INCH } : null;
  }

  // Metric with explicit unit.
  const metric = s.match(/^(-?\d+(?:\.\d+)?)\s*(mm|cm|m)$/);
  if (metric) {
    const v = parseFloat(metric[1]);
    if (!Number.isFinite(v)) return null;
    const mm = metric[2] === 'mm' ? v : metric[2] === 'cm' ? v * 10 : v * 1000;
    return { mm };
  }

  // Explicit inches (incl. fractions), with " or in/inch(es) suffix.
  const inMatch = s.match(/^(.+?)\s*(?:"|in|inch|inches)$/);
  if (inMatch) {
    const inch = parseInchScalar(inMatch[1]);
    return inch == null ? null : { mm: inch * MM_PER_INCH };
  }

  // No explicit unit — could still be a bare fraction ("3/4", "1-1/2").
  const scalar = parseInchScalar(s);
  if (scalar == null) return null;
  // Interpret the bare number in the app's current display units.
  return { mm: fallbackUnits === 'in' ? scalar * MM_PER_INCH : scalar };
}

/**
 * Parse a scalar that may be a plain decimal, a fraction, or a
 * whole+fraction ("24", "0.5", "3/4", "1-1/2", "24 1/2"). Returns the
 * numeric value (in whatever unit the caller assigns) or null.
 */
function parseInchScalar(raw: string): number | null {
  const s = raw.trim();
  if (s === '') return null;

  // whole + fraction:  "1-1/2", "24 1/2"  (dash or whitespace separator)
  const wf = s.match(/^(\d+(?:\.\d+)?)[\s-]+(\d+)\s*\/\s*(\d+)$/);
  if (wf) {
    const whole = parseFloat(wf[1]);
    const num = parseFloat(wf[2]);
    const den = parseFloat(wf[3]);
    if (den === 0) return null;
    const v = whole + num / den;
    return Number.isFinite(v) ? v : null;
  }

  // bare fraction:  "3/4"
  const fr = s.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (fr) {
    const num = parseFloat(fr[1]);
    const den = parseFloat(fr[2]);
    if (den === 0) return null;
    const v = num / den;
    return Number.isFinite(v) ? v : null;
  }

  // plain decimal (allow leading dot ".5" and a leading sign)
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(s)) {
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : null;
  }

  return null;
}

/** Format a money amount. Cents-precise when small. */
export function fmtMoney(n: number, currency = 'USD'): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(n);
}
