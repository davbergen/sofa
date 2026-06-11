import type { AgentEvent } from './agent.js';

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

  /** Starts pumping the Agent's events into a new SessionRun. */
  start(sessionId: number, events: AsyncIterable<AgentEvent>): SessionRun {
    const run = new SessionRun();
    this.runs.set(sessionId, run);
    void (async () => {
      try {
        for await (const event of events) {
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
}
