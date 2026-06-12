/**
 * Web Worker entry for the multicore optimiser (see optPool.ts).
 *
 * Three job kinds, all pure CPU over structured-cloneable data:
 *   'rect'        — run a chunk of rectangle-packer trials, posting each
 *                   trial's MultiSheetResult as it completes.
 *   'cnc-passes'  — run a chunk of CNC raster passes (by ordering index),
 *                   posting each serialized pass as it completes.
 *   'cnc-finish'  — rebuild the winning CNC layout's grids and run the
 *                   consolidation + save-last squeeze, posting the final
 *                   CncResult.
 */

import { packOne, type PackJob, type PackInput, type Heuristic } from './packRect';
import {
  cncRunPasses,
  cncRunExplicitOrders,
  cncFinish,
  type CncInput,
  type CncOptions,
  type CncSerialPass,
  type CncOrderSpec,
} from './cncNest';

export interface RectJobMsg {
  kind: 'rect';
  job: PackJob;
  trials: { orderIds: string[]; heur: Heuristic }[];
}
export interface CncPassesMsg {
  kind: 'cnc-passes';
  items: CncInput[];
  sheetW: number;
  sheetH: number;
  kerf: number;
  opt: CncOptions;
  attempts: number;
  orderingIdxs: number[];
}
export interface CncOrdersMsg {
  kind: 'cnc-orders';
  items: CncInput[];
  sheetW: number;
  sheetH: number;
  kerf: number;
  opt: CncOptions;
  orders: CncOrderSpec[];
}
export interface CncFinishMsg {
  kind: 'cnc-finish';
  items: CncInput[];
  sheetW: number;
  sheetH: number;
  kerf: number;
  opt: CncOptions;
  winner: CncSerialPass;
}
export type OptWorkerMsg = RectJobMsg | CncPassesMsg | CncOrdersMsg | CncFinishMsg;

self.onmessage = (e: MessageEvent<OptWorkerMsg>) => {
  const msg = e.data;
  if (msg.kind === 'rect') {
    const byId = new Map(msg.job.items.map((it) => [it.id, it] as const));
    for (const t of msg.trials) {
      const order = t.orderIds.map((id) => byId.get(id)).filter(Boolean) as PackInput[];
      const result = packOne(msg.job, t.heur, order);
      self.postMessage({ kind: 'rect-trial', result });
    }
    self.postMessage({ kind: 'done' });
  } else if (msg.kind === 'cnc-passes') {
    cncRunPasses(
      msg.items, msg.sheetW, msg.sheetH, msg.kerf, msg.opt, msg.attempts, msg.orderingIdxs,
      (idx, pass) => self.postMessage({ kind: 'cnc-pass', idx, pass }),
    );
    self.postMessage({ kind: 'done' });
  } else if (msg.kind === 'cnc-orders') {
    cncRunExplicitOrders(
      msg.items, msg.sheetW, msg.sheetH, msg.kerf, msg.opt, msg.orders,
      (idx, pass) => self.postMessage({ kind: 'cnc-pass', idx, pass }),
    );
    self.postMessage({ kind: 'done' });
  } else if (msg.kind === 'cnc-finish') {
    const result = cncFinish(msg.items, msg.sheetW, msg.sheetH, msg.kerf, msg.opt, msg.winner);
    self.postMessage({ kind: 'cnc-finished', result });
  }
};
