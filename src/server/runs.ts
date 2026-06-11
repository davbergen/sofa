/**
 * Pure dispatcher logic for Worker run records: lifecycle states and how
 * Worker events advance them. No I/O here — app.ts applies the results to
 * SQLite.
 */
import type { WorkerEvent } from './ports.js';

/** Every state a run record can be in; `pr_open` and `failed` are terminal. */
export type RunState = 'cloning' | 'working' | 'pushing' | 'pr_open' | 'failed';

const TERMINAL_STATES: RunState[] = ['pr_open', 'failed'];

/** A run still occupying the Project's single Worker slot. */
export function isActive(state: RunState): boolean {
  return !TERMINAL_STATES.includes(state);
}

/** SQL fragment matching active states (for the one-Worker-per-Project check). */
export const ACTIVE_STATES = ['cloning', 'working', 'pushing'] as const;

export interface RunUpdate {
  state: RunState;
  prUrl?: string;
  failureReason?: string;
}

/**
 * How a Worker event advances a run record. Terminal records never move:
 * a stale event after success/failure is ignored (returns null).
 */
export function applyEvent(current: RunState, event: WorkerEvent): RunUpdate | null {
  if (!isActive(current)) {
    return null;
  }
  switch (event.type) {
    case 'phase':
      return { state: event.phase };
    // Activity is feed-only; it never advances the lifecycle.
    case 'activity':
      return null;
    case 'succeeded':
      return { state: 'pr_open', prUrl: event.prUrl };
    case 'failed':
      return { state: 'failed', failureReason: event.reason };
  }
}
