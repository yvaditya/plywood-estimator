import type { OcctMesh, OcctResult } from './stepLoader';

type Node = OcctResult['root'];
type V3 = [number, number, number];
interface Record { id: number; start: number; end: number; body: string }

// STEP strings can contain semicolons, entity references and doubled quotes.
// Tokenise those and comments before recognising record boundaries.
function records(text: string): Record[] {
  const result: Record[] = [];
  let current: { id: number; start: number; bodyStart: number } | undefined;
  for (const m of text.matchAll(/'(?:[^']|'')*'|\/\*[\s\S]*?\*\/|#(\d+)\s*=|;/g)) {
    if (m[1]) current = { id: Number(m[1]), start: m.index!, bodyStart: m.index! + m[0].length };
    else if (m[0] === ';' && current) {
      result.push({ ...current, end: m.index! + 1, body: text.slice(current.bodyStart, m.index) });
      current = undefined;
    }
  }
  return result;
}

function refs(body: string): number[] {
  return [...body.matchAll(/'(?:[^']|'')*'|\/\*[\s\S]*?\*\/|#(\d+)/g)]
    .filter(m => m[1]).map(m => Number(m[1]));
}

function meshNodes(node: Node): Node[] {
  return [...(node.meshes.length ? [node] : []), ...node.children.flatMap(meshNodes)];
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const point = (p: number[], i: number): V3 => [p[i], p[i + 1], p[i + 2]];
function basis(a: V3, b: V3): V3[] | null {
  const length = Math.hypot(...a), normal = cross(a, b), height = Math.hypot(...normal);
  if (length < 1e-8 || height < 1e-8) return null;
  const u = a.map(n => n / length) as V3, n = normal.map(n => n / height) as V3;
  return [u, cross(n, u), n];
}

/** Match an entire definition to an occurrence, never just names or mesh order.
 * Every vertex and triangle must agree under one proper rigid transform. */
function sameOccurrence(source: OcctMesh[], target: OcctMesh[]): boolean {
  if (source.length !== target.length) return false;
  if (source.some((m, i) => m.attributes.position.array.length !== target[i].attributes.position.array.length
    || m.index.array.length !== target[i].index.array.length
    || m.index.array.some((n, j) => n !== target[i].index.array[j]))) return false;
  let origins: V3[] | undefined, axes: V3[][] | undefined;
  for (let k = 0; k < source.length && !axes; k++) {
    const a = source[k].attributes.position.array, b = target[k].attributes.position.array;
    if (a.length < 9) continue;
    const o = point(a, 0), t = point(b, 0);
    let j = 3;
    while (j < a.length && Math.hypot(...sub(point(a, j), o)) < 1e-8) j += 3;
    if (j >= a.length) continue;
    for (let i = j + 3; i < a.length; i += 3) {
      const from = basis(sub(point(a, j), o), sub(point(a, i), o));
      if (!from) continue;
      const to = basis(sub(point(b, j), t), sub(point(b, i), t));
      if (!to) return false;
      origins = [o, t]; axes = [from, to]; break;
    }
  }
  if (!axes || !origins) return false;
  for (let k = 0; k < source.length; k++) {
    const a = source[k].attributes.position.array, b = target[k].attributes.position.array;
    for (let i = 0; i < a.length; i += 3) {
      const p = sub(point(a, i), origins[0]), q = sub(point(b, i), origins[1]);
      for (let axis = 0; axis < 3; axis++)
        if (Math.abs(dot(p, axes[0][axis]) - dot(q, axes[1][axis])) > 1e-5) return false;
    }
  }
  return true;
}

/** OCCT 0.0.23 can lose body styles when a solid belongs to a located assembly
 * child. Read an in-memory copy with occurrence metadata detached to recover
 * definition colours. Only metadata is copied; primary geometry stays intact.
 * Unmatched or ambiguous definitions remain uncoloured rather than guessing. */
export function restoreStepBodyColors(bytes: Uint8Array, model: OcctResult,
  read: (bytes: Uint8Array) => OcctResult): void {
  if (!model.meshes.some(m => m.color === undefined)) return;
  const text = new TextDecoder().decode(bytes), entities = records(text);
  const removed = new Set(entities.filter(e => /^\s*NEXT_ASSEMBLY_USAGE_OCCURRENCE\s*\(/i.test(e.body)).map(e => e.id));
  if (!removed.size || !entities.some(e => /^\s*STYLED_ITEM\s*\(/i.test(e.body))) return;
  for (const type of ['PRODUCT_DEFINITION_SHAPE', 'CONTEXT_DEPENDENT_SHAPE_REPRESENTATION']) {
    const pattern = new RegExp(`^\\s*${type}\\s*\\(`, 'i');
    for (const e of entities) if (pattern.test(e.body) && refs(e.body).some(id => removed.has(id))) removed.add(e.id);
  }
  const chunks: string[] = [];
  let start = 0;
  for (const e of entities) if (removed.has(e.id)) { chunks.push(text.slice(start, e.start)); start = e.end; }
  chunks.push(text.slice(start));
  const definitions = read(new TextEncoder().encode(chunks.join('')));
  if (!definitions.success) return;
  const nodes = meshNodes(definitions.root);
  for (const node of meshNodes(model.root)) {
    const target = node.meshes.map(i => model.meshes[i]);
    if (target.every(m => m.color !== undefined)) continue;
    const matches = nodes.filter(n => n.name === node.name && n.meshes.length === node.meshes.length)
      .map(n => n.meshes.map(i => definitions.meshes[i])).filter(source => sameOccurrence(source, target));
    if (!matches.length) continue;
    for (let i = 0; i < target.length; i++) {
      const color = matches[0][i].color;
      if (target[i].color !== undefined || !color) continue;
      if (matches.every(m => m[i].color?.every((c, k) => c === color[k]))) target[i].color = [...color];
    }
  }
}
