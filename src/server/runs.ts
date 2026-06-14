/**
 * Pure dispatcher logic for Worker run records: lifecycle states and how
 * Worker events advance them. No I/O here — app.ts applies the results to
 * SQLite.
 */
import type { WorkerEvent, WorkerPhase } from './ports.js';

/**
 * Every state a run record can be in. Terminal states: `pr_open`, `pr_merged`,
 * `pr_closed`, `failed`, `killed`. `pr_merged` and `pr_closed` are reachable
 * only through reconciliation (re-reading GitHub PR truth) — Workers never
 * emit them.
 */
export type RunState =
  | 'cloning'
  | 'working'
  | 'pushing'
  | 'pr_open'
  | 'pr_merged'
  | 'pr_closed'
  | 'failed'
  | 'killed';

const TERMINAL_STATES: RunState[] = ['pr_open', 'pr_merged', 'pr_closed', 'failed', 'killed'];

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
  /**
   * Furthest phase reached. Set on every `phase` event and carried through to
   * `failed` so the UI stepper can show where the run died. Undefined when the
   * event leaves phase untouched.
   */
  phase?: WorkerPhase;
}

/**
 * How a Worker event advances a run record. Terminal records never move:
 * a stale event after success/failure is ignored (returns null). `currentPhase`
 * is the furthest phase reached so far; it's carried into the `failed` update
 * so the stepper can paint the death segment red over a frozen Clone→Work→Push
 * trail rather than losing the phase the moment the run died.
 */
export function applyEvent(
  current: RunState,
  event: WorkerEvent,
  currentPhase: WorkerPhase | null = null,
): RunUpdate | null {
  if (!isActive(current)) {
    return null;
  }
  switch (event.type) {
    case 'phase':
      return { state: event.phase, phase: event.phase };
    // Activity is feed-only; it never advances the lifecycle.
    case 'activity':
      return null;
    case 'succeeded':
      return { state: 'pr_open', prUrl: event.prUrl, phase: 'pushing' };
    case 'failed':
      return {
        state: 'failed',
        failureReason: event.reason,
        ...(currentPhase ? { phase: currentPhase } : {}),
      };
  }
}

/** PR state as reported by `gh pr view --json state`. */
export type GitHubPrState = 'OPEN' | 'MERGED' | 'CLOSED';

/**
 * How GitHub's PR state advances a `pr_open` run. Mirrors `applyEvent` but is
 * the sole writer of `pr_merged` / `pr_closed`. Only `pr_open` runs are
 * candidates; anything else (including the new terminals) returns null.
 */
export function applyPrState(current: RunState, prState: GitHubPrState): RunUpdate | null {
  if (current !== 'pr_open') {
    return null;
  }
  switch (prState) {
    case 'OPEN':
      return null;
    case 'MERGED':
      return { state: 'pr_merged' };
    case 'CLOSED':
      return { state: 'pr_closed' };
  }
}
