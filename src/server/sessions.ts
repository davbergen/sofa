import type { AgentEvent, AgentSession, IssueBreakdownEvent, PrdDraftEvent } from './agent.js';

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

  /** The latest proposed Issue breakdown on the transcript, if the Agent has produced one. */
  issueBreakdown(): IssueBreakdownEvent | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const event = this.events[i];
      if (event.type === 'issue_breakdown') return event;
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
}

/** In-memory registry of running (and finished) Session transcripts. */
export class SessionRegistry {
  private readonly runs = new Map<number, SessionRun>();
  private readonly agents = new Map<number, AgentSession>();

  /** Starts pumping the Agent session's events into a new SessionRun. */
  start(sessionId: number, agentSession: AgentSession, hooks: SessionRunHooks = {}): SessionRun {
    const run = new SessionRun();
    this.runs.set(sessionId, run);
    this.agents.set(sessionId, agentSession);
    void (async () => {
      let errored = false;
      try {
        for await (const event of agentSession.events) {
          if (event.type === 'agent_error') errored = true;
          run.push(event);
          hooks.onEvent?.(event);
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
}
