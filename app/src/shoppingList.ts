/**
 * Shopping list (formerly "inventory"): the list of plywood sheets needed
 * to cut this job, by thickness. Auto-generated from a NestResult.
 *
 * The user can override "have on hand" per row to compute "buy" quantity;
 * those overrides are persisted in localStorage keyed by the row signature
 * (thickness + sheet dims) so they survive between sessions.
 */

import type { NestResult } from './nest';

export interface ShoppingRow {
  /** Signature used as the dedupe / persistence key. */
  key: string;
  thickness: number;       // mm
  sheetW: number;          // mm
  sheetL: number;          // mm
  need: number;            // sheets required (from nester)
  have: number;            // override (user-edited)
  buy: number;             // max(0, need - have)
  unitPrice: number;       // user-edited, persisted
  lineCost: number;        // buy * unitPrice
}

const HAVE_KEY = 'plywood-estimator:have:v1';
const PRICE_KEY = 'plywood-estimator:price:v1';
const JOBNAME_KEY = 'plywood-estimator:jobname:v1';

interface NumberStore { [signature: string]: number; }

function loadStore(key: string): NumberStore {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}
function saveStore(key: string, store: NumberStore) {
  localStorage.setItem(key, JSON.stringify(store));
}
const loadHaveStore = () => loadStore(HAVE_KEY);
const savePriceStore = (s: NumberStore) => saveStore(PRICE_KEY, s);
const loadPriceStore = () => loadStore(PRICE_KEY);

export function loadJobName(): string {
  return localStorage.getItem(JOBNAME_KEY) || '';
}
export function saveJobName(name: string) {
  localStorage.setItem(JOBNAME_KEY, name);
}

/**
 * Build a signature for a row — used both as a dedup key and as the
 * persistence key for the user's "have" override.
 *
 * Quantized to 0.1mm to absorb tiny FP noise between sessions.
 */
export function rowKey(thickness: number, sheetW: number, sheetL: number): string {
  const q = (n: number) => Math.round(n * 10) / 10;
  return `t${q(thickness)}|${q(sheetW)}x${q(sheetL)}`;
}

/**
 * Derive the shopping list from a nest result.
 * Note that the nester assumes all sheets in a thickness group share the
 * same dimensions (whatever the user picked in the sheet config). If we
 * ever support mixed sheet sizes per thickness, this needs to slice further.
 */
export function buildShoppingList(
  result: NestResult,
  sheetW: number,
  sheetL: number,
): ShoppingRow[] {
  const haveStore = loadHaveStore();
  const priceStore = loadPriceStore();
  const rows: ShoppingRow[] = [];
  for (const g of result.groups) {
    if (g.sheets.length === 0) continue;
    const key = rowKey(g.thickness, sheetW, sheetL);
    const have = haveStore[key] ?? 0;
    const unitPrice = priceStore[key] ?? 0;
    const buy = Math.max(0, g.sheets.length - have);
    rows.push({
      key,
      thickness: g.thickness,
      sheetW,
      sheetL,
      need: g.sheets.length,
      have,
      buy,
      unitPrice,
      lineCost: buy * unitPrice,
    });
  }
  return rows;
}

export function setHave(key: string, have: number) {
  const store = loadHaveStore();
  if (have <= 0) delete store[key];
  else store[key] = have;
  saveStore(HAVE_KEY, store);
}
export function setPrice(key: string, price: number) {
  const store = loadPriceStore();
  if (price <= 0) delete store[key];
  else store[key] = price;
  savePriceStore(store);
}
export function totalCost(rows: ShoppingRow[]): number {
  return rows.reduce((a, r) => a + r.lineCost, 0);
}

/**
 * CSV with a header row + one row per item, plus a trailing TOTAL row.
 * Includes thickness, sheet dims, need, have, buy, unit price, line cost.
 */
export function toCsv(rows: ShoppingRow[], unitLabel: string): string {
  const head = [
    'Thickness',
    'Sheet width',
    'Sheet length',
    'Units',
    'Sheets needed',
    'On hand',
    'To buy',
    'Unit price',
    'Line cost',
  ];
  const out: string[] = [head.join(',')];
  for (const r of rows) {
    out.push([
      r.thickness.toFixed(2),
      r.sheetW.toFixed(2),
      r.sheetL.toFixed(2),
      unitLabel,
      r.need,
      r.have,
      r.buy,
      r.unitPrice.toFixed(2),
      r.lineCost.toFixed(2),
    ].join(','));
  }
  out.push(['', '', '', '', '', '', 'TOTAL', '', totalCost(rows).toFixed(2)].join(','));
  return out.join('\r\n');
}

export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}
