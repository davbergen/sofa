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

/** An issue to create on the Project's GitHub issue tracker (e.g. an approved PRD). */
export interface NewIssue {
  title: string;
  body: string;
  labels: string[];
}

/** The issue GitHub created in response to a NewIssue. */
export interface CreatedIssue {
  number: number;
  url: string;
}

/** Wraps the GitHub boundary (gh CLI / API) for a Project directory. */
export interface GitHubAdapter {
  /** Resolves the Project directory's repository as `owner/name`. */
  resolveRepo(dir: string): Promise<string>;
  /** Lists open Issues in the Project's repository that are ready for a Worker. */
  listReadyIssues(dir: string): Promise<ReadyIssue[]>;
  /** Creates an issue in the Project's repository and returns its number and URL. */
  createIssue(dir: string, issue: NewIssue): Promise<CreatedIssue>;
  /**
   * Ensures each named label exists in the Project's repository, creating any
   * that are missing and leaving existing ones untouched. Used to guarantee
   * Sofa's convention labels (ready-for-agent, prd) are present before filing
   * Issues or publishing PRDs against a freshly opened repo.
   */
  ensureLabels(dir: string, labels: string[]): Promise<void>;
}

/** Lifecycle phases a running Worker reports before it finishes. */
export type WorkerPhase = 'cloning' | 'working' | 'pushing';

/** Token usage reported by the Agent SDK for one run or Session turn. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * Events a Worker container emits while it runs. Terminal events may carry
 * the token usage the Worker's agent reported (absent when the Worker died
 * before the agent ran, or on older Worker images).
 */
export type WorkerEvent =
  | { type: 'phase'; phase: WorkerPhase }
  | { type: 'activity'; message: string }
  | { type: 'succeeded'; prUrl: string; usage?: TokenUsage }
  | { type: 'failed'; reason: string; usage?: TokenUsage };

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
  /** Claude model alias (opus/sonnet/haiku/fable) from the Project's stored setting. */
  model?: string;
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
