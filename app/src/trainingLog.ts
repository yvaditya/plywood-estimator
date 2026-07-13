/**
 * Training recorder for the manual cut-sequence editor.
 *
 * While "⏺ Record" is on, every edit the user makes in the popup is appended
 * as a JSONL event to a localStorage-backed log. The events carry enough
 * context (full auto sequence + metrics, per-action deltas, final sequence)
 * to later infer good sequencing rules programmatically. "Download log"
 * saves a `cutlog_<jobname>_<ISOdate>.jsonl` file.
 *
 * JSONL = one JSON object per line. We keep the raw lines (strings) so the
 * download is a byte-for-byte concatenation and nothing is re-serialised.
 */

import type { CutStep } from './instructions';

const LOG_KEY = 'plywood.cutTrainingLog';

// ---------------------------------------------------------------------------
// Event payload shapes (documented; not strictly enforced at call sites so
// the recorder can carry extra context without a type churn).
// ---------------------------------------------------------------------------

/** Full context snapshot captured when a recording session opens. */
export interface SessionStartEvent {
  type: 'session_start';
  t: number;
  sheet: {
    /** Sheet WIDTH (short display axis) in mm. */
    w: number;
    /** Sheet LENGTH (long display axis) in mm. */
    l: number;
    margin: number;
    kerf: number;
    strategy: string;
    thickness: number;
  };
  parts: { code: string; x: number; y: number; w: number; h: number }[];
  /** The engine's cut sequence at session open — full CutStep objects. */
  autoSequence: CutStep[];
  autoMetrics: SequenceMetrics;
  /** Layout signature so events can be grouped by the exact layout later. */
  signature: string;
  jobName: string;
}

export interface ActionEvent {
  type:
    | 'reorder' | 'flip_edge' | 'mark_datum' | 'manual_cut' | 'undo'
    | 'auto_complete' | 'set_datum' | 'unset_datum';
  t: number;
  /** Stable cut key + a human-readable summary of the affected cut.
   *  (`manual_cut`/`undo` carry these; `auto_complete` may omit them.) */
  cut?: string;
  summary?: string;
  /** For reorder: source / destination positions in the layout tail. */
  from?: number;
  to?: number;
  /** For flip_edge / mark_datum / manual_cut(fromFar): the new boolean value. */
  value?: boolean;
  /** For manual_cut: whether the cut was quoted from a manually-armed FAR
   *  reference edge. */
  armedFar?: boolean;
  /** For set_datum / unset_datum: the piece (region key) + edge that was
   *  (un)marked as the default measuring edge. */
  piece_key?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  /** For manual_cut: WHICH edge the cut was measured from (near/far in the
   *  cut's own orientation → 'L'/'R'/'T'/'B') and where that edge came from:
   *  an explicit arm, an inherited datum, or the built-in default. */
  measuredFrom?: 'L' | 'R' | 'T' | 'B';
  measuredProvenance?: 'armed' | 'datum' | 'default';
  /** For manual_cut: when the cut was CHAIN-dimensioned off a previous cut,
   *  the cutKey of that referenced cut ("Previous cut" reference). */
  measuredFromCut?: string;
  /** For manual_cut: whether the user saved this cut's fresh edge as a datum
   *  (Field 1 of the config popup). */
  datumSaved?: boolean;
  /** For auto_complete: how many cuts the engine order appended. */
  added?: number;
  /** Piece-breakdown state after the action (live pieces + finished count). */
  piece?: { pieces: number; finished: number };
  /** Cut keys in order AFTER the action (layout tail, trims excluded). */
  sequenceAfter: string[];
  metricsAfter: SequenceMetrics;
}

export interface SessionEndEvent {
  type: 'session_end';
  t: number;
  /** Full steps in final order, carrying fromFar/isDatum. */
  finalSequence: CutStep[];
  finalMetrics: SequenceMetrics;
  /** Optional one-line "why" note the user typed on close. */
  note: string;
}

/** Sequencing quality metrics — cheap to compute, informative for rule
 *  mining: how many times the flip-stop SETTING changed, how many rip↔cross
 *  ROTATIONS, and how many "same setting" runs the order produced. */
export interface SequenceMetrics {
  settingChanges: number;
  rotations: number;
  sameSettingRuns: number;
}

/**
 * Metrics over an ordered step list. A "setting change" = consecutive steps
 * differing in (axis, distance); a "rotation" = consecutive steps differing
 * in axis; a "same-setting run" = a maximal run of ≥2 steps sharing
 * (axis, distance).
 */
export function sequenceMetrics(steps: CutStep[]): SequenceMetrics {
  let settingChanges = 0;
  let rotations = 0;
  let sameSettingRuns = 0;
  let inRun = false;
  for (let i = 1; i < steps.length; i++) {
    const p = steps[i - 1], c = steps[i];
    const sameSetting = c.axis === p.axis && Math.abs(c.distance - p.distance) < 0.5;
    if (!sameSetting) settingChanges++;
    if (c.axis !== p.axis) rotations++;
    if (sameSetting) {
      if (!inRun) { sameSettingRuns++; inRun = true; }
    } else {
      inRun = false;
    }
  }
  return { settingChanges, rotations, sameSettingRuns };
}

// ---------------------------------------------------------------------------
// Recorder — a thin append-only wrapper around a localStorage JSONL buffer.
// ---------------------------------------------------------------------------

export class TrainingRecorder {
  private lines: string[] = [];
  recording = false;

  constructor() {
    this.load();
  }

  private load() {
    try {
      const raw = localStorage.getItem(LOG_KEY);
      this.lines = raw ? raw.split('\n').filter((l) => l.trim().length > 0) : [];
    } catch {
      this.lines = [];
    }
  }

  private persist() {
    try {
      localStorage.setItem(LOG_KEY, this.lines.join('\n'));
    } catch { /* quota — keep the in-memory buffer regardless */ }
  }

  /** Turn recording on/off. Returns the new state. */
  setRecording(on: boolean): boolean {
    this.recording = on;
    return this.recording;
  }

  /** Append one event object as a JSONL line (only while recording). */
  append(ev: SessionStartEvent | ActionEvent | SessionEndEvent): void {
    if (!this.recording) return;
    this.lines.push(JSON.stringify(ev));
    this.persist();
  }

  /** Number of buffered events. */
  get count(): number {
    return this.lines.length;
  }

  /** The full JSONL text (one event per line). */
  text(): string {
    return this.lines.join('\n');
  }

  /** Clear the buffer + localStorage. */
  clear(): void {
    this.lines = [];
    this.persist();
  }

  /** Trigger a browser download of the log as cutlog_<job>_<ISOdate>.jsonl. */
  download(jobName: string): void {
    const safe = (jobName || 'cut').replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
    const date = new Date().toISOString().slice(0, 10);
    const blob = new Blob([this.text()], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cutlog_${safe}_${date}.jsonl`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** Shared singleton — the popup and the header toggle talk to the same log. */
export const trainingRecorder = new TrainingRecorder();
