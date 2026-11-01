import { allCutSteps, type CutStep, type KerfRef, type SequenceStyle, type SheetOverrides } from './instructions';
import type { NestResult, PlacedPart, CutStrategy } from './nest';
import type { Units } from './units';
import type { Vec2 } from './geometry';

export interface PackageBody {
  id: string; name: string; fileTag: string; color: string;
  length: number; width: number; thickness: number;
  positions: number[]; indices: number[]; normals?: number[];
}
export interface PackageModel {
  id: string; name: string; fileTag: string; color: string;
  positions: string; indices: string; normals?: string;
}
export interface PackagePart {
  key: string; partId: string; bodyId: string; instance: number; code: string;
  name: string; fileTag: string; color: string; length: number; width: number;
  thickness: number; sheet: number | null; segment?: string;
}
export interface PackageSheet {
  number: number; width: number; length: number; thickness: number;
  parts: (PlacedPart & { key: string })[]; steps: CutStep[]; isGuillotineTree: boolean;
}
export interface PackageData {
  version: 1; id: string; jobName: string; createdAt: string; units: Units;
  margin: number; kerf: number; kerfRef: KerfRef; strategy: CutStrategy;
  parts: PackagePart[]; sheets: PackageSheet[]; models: PackageModel[];
}
interface Segment {
  parentId: string; segIndex: number; segCount: number; outer: Vec2[]; thickness: number;
}
export interface PackageInput {
  jobName: string; createdAt?: string; units: Units; margin: number; kerf: number;
  kerfRef: KerfRef; sequenceStyle: SequenceStyle; strategy: CutStrategy;
  nest: NestResult; bodies: PackageBody[]; segments?: Map<string, Segment>;
  overrides?: Record<string, SheetOverrides>;
  /** False skips mesh encoding (the shop remote sends meshes separately). */
  withModels?: boolean;
}

/** Typed data keeps large STEP meshes smaller than decimal JSON arrays. */
export function encodeArray(values: Float32Array | Uint32Array): string {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(binary);
}
export function decodeArray(value: string, type: 'float' | 'index'): Float32Array | Uint32Array {
  const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
  return type === 'float' ? new Float32Array(bytes.buffer) : new Uint32Array(bytes.buffer);
}
function occurrence(partId: string, instance: number): string { return JSON.stringify([partId, instance]); }

export function buildPackageData(input: PackageInput): PackageData {
  const bodies = new Map(input.bodies.map(b => [b.id, b]));
  const parts: PackagePart[] = [];
  const seen = new Set<string>();
  const cuts = allCutSteps(input.nest, input.margin, input.kerf, input.overrides, input.kerfRef, input.sequenceStyle);
  const add = (partId: string, instance: number, name: string, sheet: number | null, code: string, thickness: number) => {
    const segment = input.segments?.get(partId);
    const bodyId = segment?.parentId ?? partId;
    const b = bodies.get(bodyId);
    if (!b) throw new Error(`Missing source body for ${name}. Estimate the job again before exporting.`);
    const key = occurrence(partId, instance);
    if (seen.has(key)) throw new Error(`Duplicate part occurrence: ${name} (${instance}).`);
    seen.add(key);
    let w = b.width, h = b.length;
    if (segment) {
      const xs = segment.outer.map(p => p[0]), ys = segment.outer.map(p => p[1]);
      w = Math.max(...xs) - Math.min(...xs); h = Math.max(...ys) - Math.min(...ys);
    }
    parts.push({ key, partId, bodyId, instance, name, sheet, code, fileTag: b.fileTag,
      color: b.color, length: Math.max(w, h),
      width: Math.min(w, h), thickness,
      ...(segment ? { segment: `Segment ${segment.segIndex} of ${segment.segCount}; 3D highlights the source panel` } : {}) });
    return key;
  };
  let cutIndex = 0;
  const sheets: PackageSheet[] = [];
  for (const group of input.nest.groups) {
    for (const sheet of group.sheets) {
      const sc = cuts[cutIndex++];
      sheets.push({ number: sheet.globalIndex, width: sheet.sheetW, length: sheet.sheetL,
        thickness: sheet.thickness, steps: input.strategy.startsWith('cnc') ? [] : sc.steps, isGuillotineTree: sc.isGuillotineTree,
        parts: sheet.parts.map(p => ({ ...p, key: add(p.partId, p.instance, p.partName, sheet.globalIndex,
          `${sheet.globalIndex}${p.panelLabel}`, sheet.thickness) })) });
    }
    for (const p of group.unplaced) add(p.partId, p.instance, p.partName, null, 'Unplaced', group.thickness);
  }
  if (!parts.length) throw new Error('There are no parts to export.');
  const usedBodies = new Set(parts.map(p => p.bodyId));
  const models = input.withModels === false ? [] : encodeModels(input.bodies.filter(b => usedBodies.has(b.id)));
  const content = { version: 1 as const, jobName: input.jobName || 'Workshop job', units: input.units,
    margin: input.margin, kerf: input.kerf, kerfRef: input.kerfRef, strategy: input.strategy, parts, sheets, models };
  const json = JSON.stringify(content);
  // Two independent 32-bit accumulators: deterministic browser-local progress identity.
  let a = 2166136261, b = 5381;
  for (let i = 0; i < json.length; i++) { a = Math.imul(a ^ json.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ json.charCodeAt(i); }
  return { ...JSON.parse(json), id: `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`,
    createdAt: input.createdAt ?? new Date().toISOString() };
}

export function encodeModels(bodies: PackageBody[]): PackageModel[] {
  return bodies.map(b => {
    if (!b.positions.length || b.positions.length % 3 || !b.indices.length || b.indices.length % 3
      || b.positions.some(v => !Number.isFinite(v))
      || b.indices.some(v => !Number.isInteger(v) || v < 0 || v >= b.positions.length / 3)) {
      throw new Error(`Invalid model geometry for ${b.name}.`);
    }
    return { id: b.id, name: b.name, fileTag: b.fileTag, color: b.color,
      positions: encodeArray(new Float32Array(b.positions)), indices: encodeArray(new Uint32Array(b.indices)),
      ...(b.normals?.length === b.positions.length ? { normals: encodeArray(new Float32Array(b.normals)) } : {}) };
  });
}
