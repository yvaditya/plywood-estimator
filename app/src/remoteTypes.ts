import type { PackageData } from './packageData';
import type { Units } from './units';
import type { GrainLock, RotationMode } from './nest';

/** One editable cut-list row: a source body and its nesting options. */
export interface RemoteBody {
  id: string; name: string; fileTag: string; color: string;
  length: number; width: number; thickness: number;
  qty: number; selected: boolean;
  grain: GrainLock; rotation: RotationMode;
  material: string;
}
export interface RemoteStock {
  thickness: number; sheetW: number; sheetL: number; need: number; have: number; buy: number;
}
/** Everything the phone shows, minus meshes (sent once per model change). */
export interface RemoteJob {
  jobName: string; units: Units; publishedAt: string;
  busy: boolean; status: string;
  /** True when the cut list changed after the last plan. */
  stale: boolean;
  bodies: RemoteBody[];
  stock: RemoteStock[];
  plan: Omit<PackageData, 'models'> | null;
}
export type RemoteCommand =
  | { type: 'body'; id: string; patch: Partial<Pick<RemoteBody, 'qty' | 'selected' | 'grain' | 'rotation'>> }
  | { type: 'estimate' };
export type RemoteProgress = Record<string, { cut?: boolean; assembled?: boolean }>;

/** Deep link into the phone page: a whole job, one section (STEP file), or one part. */
export function remoteHash(section: string, part: string): string {
  if (!section) return '';
  return `#section=${encodeURIComponent(section)}${part ? `&part=${encodeURIComponent(part)}` : ''}`;
}
