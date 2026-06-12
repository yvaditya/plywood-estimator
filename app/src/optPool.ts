/**
 * Multicore drivers for the nest optimisers.
 *
 * Both search loops are embarrassingly parallel — every rectangle-packer
 * trial and every CNC raster pass is independent — so they fan out across a
 * pool of Web Workers (one per core, capped) and the main thread merges
 * results with the same strategy-aware objective the sequential drivers use.
 * The post-search squeezes (sheet consolidation, save-last compaction) run
 * once, on the winner: rect on the main thread (cheap), CNC on a worker
 * (rebuilding raster grids is not cheap).
 *
 * Progress callbacks fire per completed trial in ARRIVAL order, so the
 * replay frames and convergence chart keep working; arrival order — and
 * therefore which of two objective-equal layouts wins — can vary run to
 * run. The sequential drivers remain the deterministic fallback, used
 * automatically when Workers are unavailable or a worker errors.
 */

import {
  packMultiAnimated,
  buildTrialSchedule,
  effectiveJob,
  finishPack,
  isBetter,
  type PackJob,
  type PackProgress,
  type MultiSheetResult,
  type CutStrategy,
} from './packRect';
import {
  packCncAnimated,
  cncAttemptCount,
  serialPassBetter,
  type CncInput,
  type CncOptions,
  type CncOrderSpec,
  type CncProgress,
  type CncResult,
  type CncSerialPass,
  type CncSheet,
} from './cncNest';

const makeWorker = () =>
  new Worker(new URL('./optWorker.ts', import.meta.url), { type: 'module' });

function poolSize(jobs: number): number {
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  return Math.max(1, Math.min(cores - 1, 8, jobs));
}

const workersAvailable = () => typeof Worker !== 'undefined';

/** Round-robin split of `items` into `n` chunks. */
function chunk<T>(items: T[], n: number): T[][] {
  const out: T[][] = Array.from({ length: n }, () => []);
  items.forEach((it, i) => out[i % n].push(it));
  return out.filter((c) => c.length > 0);
}

// ---------------------------------------------------------------------------
// Rectangle packer
// ---------------------------------------------------------------------------
export async function packMultiParallel(
  job: PackJob,
  restarts: number,
  onProgress: (p: PackProgress) => void | Promise<void>,
  seedOffset = 0,
): Promise<MultiSheetResult> {
  if (!workersAvailable()) return packMultiAnimated(job, restarts, onProgress, 4, seedOffset);

  const optJob = effectiveJob(job);
  const objective: CutStrategy = job.cutStrategy ?? 'free';
  const specs = buildTrialSchedule(job, restarts, seedOffset).map((t) => ({
    orderIds: t.order.map((o) => o.id),
    heur: t.heur,
  }));
  const total = specs.length;
  const chunks = chunk(specs, poolSize(total));

  let best: MultiSheetResult | null = null;
  let completed = 0;
  try {
    await Promise.all(chunks.map((c) => new Promise<void>((resolve, reject) => {
      const w = makeWorker();
      const fail = (err: unknown) => { w.terminate(); reject(err); };
      w.onerror = fail;
      w.onmessage = async (e) => {
        try {
          if (e.data.kind === 'rect-trial') {
            const current = e.data.result as MultiSheetResult;
            const isNewBest = !best || isBetter(current, best, objective);
            if (isNewBest) best = current;
            await onProgress({ i: completed++, total, current, best: best!, isNewBest });
          } else if (e.data.kind === 'done') {
            w.terminate();
            resolve();
          }
        } catch (err) { fail(err); }
      };
      w.postMessage({ kind: 'rect', job: optJob, trials: c });
    })));
  } catch (err) {
    console.warn('Worker pool failed — falling back to single-core optimiser.', err);
    return packMultiAnimated(job, restarts, onProgress);
  }
  return finishPack(job, best!);
}

// ---------------------------------------------------------------------------
// CNC raster nester
// ---------------------------------------------------------------------------
function serialToSheets(pass: CncSerialPass): CncSheet[] {
  return pass.sheets.map((s) => ({
    placements: s.placements,
    usedArea: s.usedArea,
    largestFree: null,
  }));
}

export async function packCncParallel(
  items: CncInput[],
  sheetW: number,
  sheetH: number,
  kerf: number,
  onProgress: (p: CncProgress) => void | Promise<void>,
  opt: CncOptions = {},
): Promise<CncResult> {
  if (!workersAvailable()) {
    return packCncAnimated(items, sheetW, sheetH, kerf, onProgress, opt);
  }

  // Finer raster than the single-core default — the passes run in parallel,
  // so the extra per-pass cost is hidden, and a tighter grid wastes less
  // material at every part boundary. MUST be identical for the pass and
  // finish messages (masks/grids have to agree on resolution).
  const wopt: CncOptions = {
    ...opt,
    targetCells: opt.targetCells ?? 450,
    maxCells: opt.maxCells ?? 280000,
  };
  const attempts = cncAttemptCount(items.length, opt.restarts ?? 8, opt.extraEffort ?? false);
  const totalSteps = attempts + 1; // +1 = the consolidation step
  const idxChunks = chunk(Array.from({ length: attempts }, (_, i) => i), poolSize(attempts));
  const saveLast = opt.saveLast ?? false;

  let best: CncSerialPass | null = null;
  let completed = 0;
  try {
    await Promise.all(idxChunks.map((idxs) => new Promise<void>((resolve, reject) => {
      const w = makeWorker();
      const fail = (err: unknown) => { w.terminate(); reject(err); };
      w.onerror = fail;
      w.onmessage = async (e) => {
        try {
          if (e.data.kind === 'cnc-pass') {
            const pass = e.data.pass as CncSerialPass;
            const isNewBest = !best || serialPassBetter(pass, best, saveLast);
            if (isNewBest) best = pass;
            await onProgress({
              trial: completed++,
              total: totalSteps,
              current: serialToSheets(pass),
              best: serialToSheets(best!),
              isNewBest,
            });
          } else if (e.data.kind === 'done') {
            w.terminate();
            resolve();
          }
        } catch (err) { fail(err); }
      };
      w.postMessage({ kind: 'cnc-passes', items, sheetW, sheetH, kerf, opt: wopt, attempts, orderingIdxs: idxs });
    })));

    // Consolidation + (save-last) compaction on one worker.
    const result = await new Promise<CncResult>((resolve, reject) => {
      const w = makeWorker();
      const fail = (err: unknown) => { w.terminate(); reject(err); };
      w.onerror = fail;
      w.onmessage = (e) => {
        if (e.data.kind === 'cnc-finished') {
          w.terminate();
          resolve(e.data.result as CncResult);
        }
      };
      w.postMessage({ kind: 'cnc-finish', items, sheetW, sheetH, kerf, opt: wopt, winner: best! });
    });

    await onProgress({
      trial: attempts,
      total: totalSteps,
      current: result.sheets,
      best: result.sheets,
      isNewBest: result.sheets.length < best!.sheets.length,
    });
    return result;
  } catch (err) {
    console.warn('Worker pool failed — falling back to single-core CNC nest.', err);
    return packCncAnimated(items, sheetW, sheetH, kerf, onProgress, opt);
  }
}

// ---------------------------------------------------------------------------
// Deep search — Deepnest-style genetic algorithm over placement orders.
//
// Genome = (placement order, scan direction, placement policy). Each
// generation is evaluated in parallel across the worker pool; the best
// genomes survive (elitism), the rest are bred with order-crossover +
// adjacent-swap mutation. Used by "Optimize further": slower than the
// canonical multi-restart, but the evolution exploits structure in good
// orderings that blind shuffles can't.
// ---------------------------------------------------------------------------
const GA_POP = 14;
const GA_GENS = 6;
const GA_BUDGET_MS = 25000;

export async function packCncDeep(
  items: CncInput[],
  sheetW: number,
  sheetH: number,
  kerf: number,
  onProgress: (p: CncProgress) => void | Promise<void>,
  opt: CncOptions = {},
  seed = 1,
): Promise<CncResult> {
  if (!workersAvailable() || items.length < 2) {
    return packCncAnimated(items, sheetW, sheetH, kerf, onProgress,
      { ...opt, seed, extraEffort: true });
  }
  const wopt: CncOptions = {
    ...opt,
    seed,
    targetCells: opt.targetCells ?? 450,
    maxCells: opt.maxCells ?? 280000,
  };
  const saveLast = opt.saveLast ?? false;
  let s = (0x9e3779b1 ^ Math.imul(seed + 7, 0xc2b2ae35)) >>> 0;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; };

  // Seed population: size-structured orders (the canonical search's best
  // openers) + shuffles, under alternating scan/placement policies.
  const dims = new Map(items.map((it) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of it.outer) {
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
    return [it.id, { w: maxX - minX, h: maxY - minY }] as const;
  }));
  const ids = items.map((it) => it.id);
  const areaById = new Map(items.map((it) => [it.id, it.area] as const));
  const byArea = ids.slice().sort((a, b) => areaById.get(b)! - areaById.get(a)!);
  const byLong = ids.slice().sort((a, b) =>
    Math.max(dims.get(b)!.w, dims.get(b)!.h) - Math.max(dims.get(a)!.w, dims.get(a)!.h));
  const shuffled = (): string[] => {
    const sh = byArea.slice();
    for (let k = sh.length - 1; k > 0; k--) {
      const j = Math.floor(rand() * (k + 1));
      [sh[k], sh[j]] = [sh[j], sh[k]];
    }
    return sh;
  };
  let pop: CncOrderSpec[] = [
    { ids: byArea, leftFirst: false, contact: false },
    { ids: byArea, leftFirst: false, contact: true },
    { ids: byLong, leftFirst: true, contact: false },
    { ids: byLong, leftFirst: false, contact: true },
  ];
  while (pop.length < GA_POP) {
    pop.push({ ids: shuffled(), leftFirst: rand() < 0.5, contact: rand() < 0.5 });
  }

  // Order crossover (OX): keep a slice of parent A, fill the rest in
  // parent B's order. Standard permutation-preserving recombination.
  const crossover = (a: string[], b: string[]): string[] => {
    const n = a.length;
    const i = Math.floor(rand() * n);
    const j = Math.min(n - 1, i + Math.floor(rand() * (n - i)));
    const slice = a.slice(i, j + 1);
    const used = new Set(slice);
    const rest = b.filter((id) => !used.has(id));
    return [...rest.slice(0, i), ...slice, ...rest.slice(i)];
  };
  const mutate = (g: CncOrderSpec): CncOrderSpec => {
    const out = g.ids.slice();
    const swaps = 1 + Math.floor(rand() * 3);
    for (let k = 0; k < swaps; k++) {
      const i = Math.floor(rand() * (out.length - 1));
      [out[i], out[i + 1]] = [out[i + 1], out[i]];
    }
    return {
      ids: out,
      leftFirst: rand() < 0.2 ? !g.leftFirst : g.leftFirst,
      contact: rand() < 0.2 ? !g.contact : g.contact,
    };
  };

  // Evaluate one generation across the pool (contiguous chunks so the
  // worker's pass index maps back to a genome).
  const evalGen = async (genomes: CncOrderSpec[]): Promise<(CncSerialPass | null)[]> => {
    const n = Math.min(poolSize(genomes.length), genomes.length);
    const per = Math.ceil(genomes.length / n);
    const results: (CncSerialPass | null)[] = genomes.map(() => null);
    await Promise.all(Array.from({ length: n }, (_, wi) => new Promise<void>((resolve, reject) => {
      const lo = wi * per;
      const chunkOrders = genomes.slice(lo, lo + per);
      if (chunkOrders.length === 0) { resolve(); return; }
      const w = makeWorker();
      const fail = (err: unknown) => { w.terminate(); reject(err); };
      w.onerror = fail;
      w.onmessage = (e) => {
        if (e.data.kind === 'cnc-pass') {
          results[lo + e.data.idx] = e.data.pass as CncSerialPass;
        } else if (e.data.kind === 'done') {
          w.terminate();
          resolve();
        }
      };
      w.postMessage({ kind: 'cnc-orders', items, sheetW, sheetH, kerf, opt: wopt, orders: chunkOrders });
    })));
    return results;
  };

  const totalSteps = GA_POP * GA_GENS + 1;
  let completed = 0;
  let best: CncSerialPass | null = null;
  const startMs = Date.now();
  try {
    for (let gen = 0; gen < GA_GENS; gen++) {
      const passes = await evalGen(pop);
      const scored: { g: CncOrderSpec; pass: CncSerialPass }[] = [];
      for (let i = 0; i < pop.length; i++) {
        const pass = passes[i];
        if (!pass) continue;
        scored.push({ g: pop[i], pass });
        const isNewBest = !best || serialPassBetter(pass, best, saveLast);
        if (isNewBest) best = pass;
        await onProgress({
          trial: completed++,
          total: totalSteps,
          current: serialToSheets(pass),
          best: serialToSheets(best!),
          isNewBest,
        });
      }
      if (scored.length === 0 || Date.now() - startMs > GA_BUDGET_MS || gen === GA_GENS - 1) break;
      // Breed the next generation: rank, keep the elite, recombine the rest
      // with rank-weighted parents.
      scored.sort((A, B) => (serialPassBetter(A.pass, B.pass, saveLast) ? -1 : 1));
      const pick = (): CncOrderSpec => {
        const r = Math.floor(Math.pow(rand(), 2) * scored.length); // rank-biased
        return scored[Math.min(r, scored.length - 1)].g;
      };
      const next: CncOrderSpec[] = scored.slice(0, 2).map((sc) => sc.g);
      while (next.length < GA_POP) {
        const pa = pick(), pb = pick();
        next.push(mutate({ ids: crossover(pa.ids, pb.ids), leftFirst: pa.leftFirst, contact: pb.contact }));
      }
      pop = next;
    }
    if (!best) throw new Error('GA produced no feasible pass');

    // Final squeeze on a worker, same as the canonical path.
    const result = await new Promise<CncResult>((resolve, reject) => {
      const w = makeWorker();
      const fail = (err: unknown) => { w.terminate(); reject(err); };
      w.onerror = fail;
      w.onmessage = (e) => {
        if (e.data.kind === 'cnc-finished') {
          w.terminate();
          resolve(e.data.result as CncResult);
        }
      };
      w.postMessage({ kind: 'cnc-finish', items, sheetW, sheetH, kerf, opt: wopt, winner: best! });
    });
    await onProgress({
      trial: totalSteps - 1,
      total: totalSteps,
      current: result.sheets,
      best: result.sheets,
      isNewBest: result.sheets.length < best!.sheets.length,
    });
    return result;
  } catch (err) {
    console.warn('GA worker pool failed — falling back to single-core CNC nest.', err);
    return packCncAnimated(items, sheetW, sheetH, kerf, onProgress, { ...opt, seed, extraEffort: true });
  }
}
