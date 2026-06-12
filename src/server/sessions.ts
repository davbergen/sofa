import type { AgentEvent, AgentSession, PrdDraftEvent } from './agent.js';

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

/** In-memory registry of running (and finished) Session transcripts. */
export class SessionRegistry {
  private readonly runs = new Map<number, SessionRun>();
  private readonly agents = new Map<number, AgentSession>();

  /** Starts pumping the Agent session's events into a new SessionRun. */
  start(sessionId: number, agentSession: AgentSession): SessionRun {
    const run = new SessionRun();
    this.runs.set(sessionId, run);
    this.agents.set(sessionId, agentSession);
    void (async () => {
      try {
        for await (const event of agentSession.events) {
          run.push(event);
        }
      } catch (err) {
        run.push({ type: 'agent_error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        run.finish();
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
