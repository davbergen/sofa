/**
 * Live activity feeds for running Workers. Mirrors the SessionRun replay
 * pattern (sessions.ts): each run buffers its recent activity so a viewer who
 * opens the feed mid-run replays the tail, then follows live events. The
 * buffer is capped — this is a feed, not a durable log.
 */

/** One line of Worker activity (a tool call, a file touched, a test run…). */
export interface ActivityEntry {
  message: string;
  at: string;
}

/** How many recent entries a feed keeps for mid-run replay. */
export const ACTIVITY_BUFFER_SIZE = 200;

/**
 * The activity feed of one Worker run. Late subscribers replay the buffered
 * tail, then follow live entries until the run reaches a terminal state.
 */
export class ActivityFeed {
  private entries: ActivityEntry[] = [];
  /** Absolute index of entries[0]; grows as old entries fall off the cap. */
  private dropped = 0;
  private waiters: Array<() => void> = [];
  private done = false;

  push(message: string): void {
    this.entries.push({ message, at: new Date().toISOString() });
    if (this.entries.length > ACTIVITY_BUFFER_SIZE) {
      this.dropped += this.entries.length - ACTIVITY_BUFFER_SIZE;
      this.entries = this.entries.slice(-ACTIVITY_BUFFER_SIZE);
    }
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

  /** Replays the buffered tail, then yields live entries until the run ends. */
  async *stream(): AsyncGenerator<ActivityEntry> {
    let cursor = this.dropped;
    for (;;) {
      if (cursor < this.dropped) cursor = this.dropped;
      while (cursor - this.dropped < this.entries.length) {
        yield this.entries[cursor - this.dropped];
        cursor += 1;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

/** In-memory registry of activity feeds, keyed by run record id. */
export class ActivityRegistry {
  private readonly feeds = new Map<number, ActivityFeed>();

  start(runId: number): ActivityFeed {
    const feed = new ActivityFeed();
    this.feeds.set(runId, feed);
    return feed;
  }

  get(runId: number): ActivityFeed | undefined {
    return this.feeds.get(runId);
  }
}
