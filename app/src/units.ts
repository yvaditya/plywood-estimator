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

/** Format a money amount. Cents-precise when small. */
export function fmtMoney(n: number, currency = 'USD'): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(n);
}
