import type { AgentEvent, AgentSession, PrdDraftEvent } from './agent.js';

/**
 * The global single host-run slot (ADR 0010): exactly one interactive Session
 * or one Process Notes run may occupy the host Agent at a time. In-memory
 * because the slot is process-scoped — a server restart drops everything that
 * was holding it. Crash-on-acquire prevents the slot from leaking when two
 * callers race.
 */
export class HostRunSlot {
  private holder: 'session' | 'process-notes' | null = null;

  busy(): boolean {
    return this.holder !== null;
  }

  /** Acquires the slot for `holder`. Returns false if the slot is already taken. */
  tryAcquire(holder: 'session' | 'process-notes'): boolean {
    if (this.holder !== null) return false;
    this.holder = holder;
    return true;
  }

  release(holder: 'session' | 'process-notes'): void {
    if (this.holder === holder) this.holder = null;
  }
}

/**
 * The live transcript of one running Session. Buffers every Agent event so
 * late subscribers replay the full transcript, then tail live events.
 */
export class SessionRun {
  private readonly events: AgentEvent[] = [];
  private waiters: Array<() => void> = [];
  private done = false;

  push(event: AgentEvent): void {
    this.events.push(event);
    this.wake();
  }

  finish(): void {
    this.done = true;
    this.wake();
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  /** The latest PRD draft on the transcript, if the Agent has produced one. */
  prdDraft(): PrdDraftEvent | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const event = this.events[i];
      if (event.type === 'prd_draft') return event;
    }
    return undefined;
  }

  /** Replays buffered events, then yields live ones until the Session finishes. */
  async *stream(): AsyncGenerator<AgentEvent> {
    let cursor = 0;
    for (;;) {
      while (cursor < this.events.length) {
        yield this.events[cursor++];
      }
      if (this.done) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

/** Side-channel observers for a run, e.g. persisting events as they stream. */
export interface SessionRunHooks {
  onEvent?: (event: AgentEvent) => void;
  /** Called once the run completes; `errored` is true if anything went wrong. */
  onFinish?: (errored: boolean) => void;
  /** Auto-end the session after this many ms of no agent output or user messages. */
  idleTimeoutMs?: number;
}

/** In-memory registry of running (and finished) Session transcripts. */
export class SessionRegistry {
  private readonly runs = new Map<number, SessionRun>();
  private readonly agents = new Map<number, AgentSession>();
  private readonly idleTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly idleSchedulers = new Map<number, () => void>();

  /** Starts pumping the Agent session's events into a new SessionRun. */
  start(sessionId: number, agentSession: AgentSession, hooks: SessionRunHooks = {}): SessionRun {
    const run = new SessionRun();
    this.runs.set(sessionId, run);
    this.agents.set(sessionId, agentSession);

    if (hooks.idleTimeoutMs != null) {
      const timeoutMs = hooks.idleTimeoutMs;
      const schedule = () => {
        const existing = this.idleTimers.get(sessionId);
        if (existing != null) clearTimeout(existing);
        const timer = setTimeout(() => {
          this.idleTimers.delete(sessionId);
          this.agents.get(sessionId)?.close();
        }, timeoutMs);
        this.idleTimers.set(sessionId, timer);
      };
      this.idleSchedulers.set(sessionId, schedule);
      schedule();
    }

    void (async () => {
      let errored = false;
      try {
        for await (const event of agentSession.events) {
          if (event.type === 'agent_error') errored = true;
          run.push(event);
          hooks.onEvent?.(event);
          this.idleSchedulers.get(sessionId)?.();
        }
      } catch (err) {
        errored = true;
        const event: AgentEvent = {
          type: 'agent_error',
          message: err instanceof Error ? err.message : String(err),
        };
        run.push(event);
        hooks.onEvent?.(event);
      } finally {
        this.idleSchedulers.delete(sessionId);
        const timer = this.idleTimers.get(sessionId);
        if (timer != null) {
          clearTimeout(timer);
          this.idleTimers.delete(sessionId);
        }
        run.finish();
        hooks.onFinish?.(errored);
      }
    })();
    return run;
  }

  get(sessionId: number): SessionRun | undefined {
    return this.runs.get(sessionId);
  }

  /** The Agent-side handle for routing answers and permission decisions into a running Session. */
  agent(sessionId: number): AgentSession | undefined {
    return this.agents.get(sessionId);
  }

  /** Resets the idle timer for a session (call when a user message arrives). */
  heartbeat(sessionId: number): void {
    this.idleSchedulers.get(sessionId)?.();
  }
}
