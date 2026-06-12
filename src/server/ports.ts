/**
 * Thin adapter interfaces over Sofa's external boundaries (GitHub, Docker).
 * The real implementations live in adapters.ts; tests inject fakes through
 * the app factory. This module is pure types — no I/O.
 */

/** An open Issue that is ready for a Worker to pick up. */
export interface ReadyIssue {
  number: number;
  title: string;
  url: string;
}

/** Wraps the GitHub boundary (gh CLI / API) for a Project directory. */
export interface GitHubAdapter {
  /** Resolves the Project directory's repository as `owner/name`. */
  resolveRepo(dir: string): Promise<string>;
  /** Lists open Issues in the Project's repository that are ready for a Worker. */
  listReadyIssues(dir: string): Promise<ReadyIssue[]>;
}

/** Lifecycle phases a running Worker reports before it finishes. */
export type WorkerPhase = 'cloning' | 'working' | 'pushing';

/** Events a Worker container emits while it runs. */
export type WorkerEvent =
  | { type: 'phase'; phase: WorkerPhase }
  | { type: 'succeeded'; prUrl: string }
  | { type: 'failed'; reason: string };

export interface StartWorkerOptions {
  /** GitHub repository as `owner/name`. */
  repo: string;
  /** Issue number the Worker must implement. */
  issue: number;
  /** Optional PR base branch. */
  baseBranch?: string;
  /**
   * Worker container image override from the Project's sofa.json; when
   * omitted the adapter launches its generic default image.
   */
  image?: string;
}

/** A grip on one launched Worker container, used for the kill switch. */
export interface WorkerHandle {
  /** Stops the Worker's container immediately. Idempotent; never throws. */
  stop(): Promise<void>;
}

/** Wraps the Docker boundary: launches throwaway Worker containers. */
export interface ContainerAdapter {
  /**
   * Starts a Worker container and reports lifecycle events until a terminal
   * `succeeded` or `failed` event. Never throws; launch errors surface as a
   * `failed` event. The returned handle can stop the container mid-run.
   */
  startWorker(opts: StartWorkerOptions, onEvent: (event: WorkerEvent) => void): WorkerHandle;
}
