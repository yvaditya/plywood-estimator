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
): Promise<MultiSheetResult> {
  if (!workersAvailable()) return packMultiAnimated(job, restarts, onProgress);

  const optJob = effectiveJob(job);
  const objective: CutStrategy = job.cutStrategy ?? 'free';
  const specs = buildTrialSchedule(job, restarts).map((t) => ({
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
  const attempts = cncAttemptCount(items.length, opt.restarts ?? 8);
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
