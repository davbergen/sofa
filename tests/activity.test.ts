import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/server/db';
import { createApp, type AppDeps } from '../src/server/app';
import { FakeAgent } from '../src/server/fake-agent';
import { ACTIVITY_BUFFER_SIZE } from '../src/server/activity';
import type {
  ContainerAdapter,
  GitHubAdapter,
  StartWorkerOptions,
  WorkerEvent,
} from '../src/server/ports';

const fakeGitHub: GitHubAdapter = {
  resolveRepo: () => Promise.resolve('davbergen/scratch'),
  listReadyIssues: () => Promise.resolve([]),
};

/** Fake Container adapter: the test scripts Worker events through `emit`. */
function fakeContainer() {
  const launches: StartWorkerOptions[] = [];
  let onEvent: ((event: WorkerEvent) => void) | null = null;
  const container: ContainerAdapter = {
    startWorker(opts, handler) {
      launches.push(opts);
      onEvent = handler;
      return { stop: () => Promise.resolve() };
    },
  };
  return { container, launches, emit: (event: WorkerEvent) => onEvent?.(event) };
}

function makeHarness() {
  const { container, emit } = fakeContainer();
  const deps: AppDeps = { github: fakeGitHub, container };
  const app = createApp(openDb(':memory:'), new FakeAgent(), deps);
  return { app, emit };
}

async function dispatchRun(app: ReturnType<typeof makeHarness>['app']): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'sofa-activity-'));
  const projectRes = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir }),
  });
  const project = await projectRes.json();
  const runRes = await app.request(`/api/projects/${project.id}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ issue: 7, title: 'Add a thing' }),
  });
  expect(runRes.status).toBe(201);
  return (await runRes.json()).id;
}

interface SseEvent {
  event: string;
  data: string;
}

function parseSse(text: string): SseEvent[] {
  return text
    .split('\n\n')
    .filter((chunk) => chunk.trim().length > 0)
    .map((chunk) => {
      const lines = chunk.split('\n');
      const event = lines.find((l) => l.startsWith('event:'))?.slice('event:'.length).trim() ?? '';
      const data = lines.find((l) => l.startsWith('data:'))?.slice('data:'.length).trim() ?? '';
      return { event, data };
    });
}

/** Incremental SSE reader for feeds that are still live (not yet done). */
function openFeed(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const seen: SseEvent[] = [];
  return {
    /** Reads until at least `count` SSE events have arrived; returns them all. */
    async readUntil(count: number): Promise<SseEvent[]> {
      while (seen.length < count) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() ?? '';
        seen.push(...parseSse(chunks.join('\n\n')));
      }
      return seen;
    },
    close: () => reader.cancel(),
  };
}

function messages(events: SseEvent[]): string[] {
  return events
    .filter((e) => e.event === 'activity')
    .map((e) => (JSON.parse(e.data) as { message: string }).message);
}

describe('the Worker activity feed', () => {
  it('streams scripted activity events live into an open feed', async () => {
    const h = makeHarness();
    const runId = await dispatchRun(h.app);

    const res = await h.app.request(`/api/runs/${runId}/activity`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const feed = openFeed(res);

    h.emit({ type: 'activity', message: 'Read src/index.ts' });
    h.emit({ type: 'activity', message: 'Bash: npm test' });

    const events = await feed.readUntil(2);
    expect(messages(events)).toEqual(['Read src/index.ts', 'Bash: npm test']);
    await feed.close();
  });

  it('replays recent activity to a viewer who opens the feed mid-run', async () => {
    const h = makeHarness();
    const runId = await dispatchRun(h.app);

    // Activity happens before anyone is watching…
    h.emit({ type: 'phase', phase: 'working' });
    h.emit({ type: 'activity', message: 'Edit src/app.ts' });
    h.emit({ type: 'activity', message: 'Bash: npm run lint' });

    // …then a viewer opens the feed mid-run and still sees it.
    const feed = openFeed(await h.app.request(`/api/runs/${runId}/activity`));
    const replayed = await feed.readUntil(3);
    expect(messages(replayed)).toEqual(['phase: working', 'Edit src/app.ts', 'Bash: npm run lint']);

    // Live events keep flowing after the replay.
    h.emit({ type: 'activity', message: 'Bash: git commit' });
    const events = await feed.readUntil(4);
    expect(messages(events).at(-1)).toBe('Bash: git commit');
    await feed.close();
  });

  it('keeps only the recent tail when activity exceeds the buffer', async () => {
    const h = makeHarness();
    const runId = await dispatchRun(h.app);

    for (let i = 1; i <= ACTIVITY_BUFFER_SIZE + 50; i++) {
      h.emit({ type: 'activity', message: `line ${i}` });
    }

    const feed = openFeed(await h.app.request(`/api/runs/${runId}/activity`));
    const events = await feed.readUntil(ACTIVITY_BUFFER_SIZE);
    const lines = messages(events);
    expect(lines).toHaveLength(ACTIVITY_BUFFER_SIZE);
    expect(lines[0]).toBe('line 51');
    expect(lines.at(-1)).toBe(`line ${ACTIVITY_BUFFER_SIZE + 50}`);
    await feed.close();
  });

  it('closes the feed with done when the Worker reaches a terminal state', async () => {
    const h = makeHarness();
    const runId = await dispatchRun(h.app);
    h.emit({ type: 'activity', message: 'Bash: git push' });

    h.emit({ type: 'succeeded', prUrl: 'https://github.com/davbergen/scratch/pull/12' });

    // The feed is finished, so the whole stream can be read to completion.
    const res = await h.app.request(`/api/runs/${runId}/activity`);
    const events = parseSse(await res.text());
    expect(messages(events)).toEqual([
      'Bash: git push',
      'opened PR https://github.com/davbergen/scratch/pull/12',
    ]);
    expect(events.at(-1)?.event).toBe('done');
  });

  it('records the failure on the feed when the Worker fails', async () => {
    const h = makeHarness();
    const runId = await dispatchRun(h.app);

    h.emit({ type: 'failed', reason: 'agent failed: quota exhausted' });

    const res = await h.app.request(`/api/runs/${runId}/activity`);
    const events = parseSse(await res.text());
    expect(messages(events)).toEqual(['failed: agent failed: quota exhausted']);
    expect(events.at(-1)?.event).toBe('done');
  });

  it('activity events do not disturb the run lifecycle state', async () => {
    const h = makeHarness();
    const runId = await dispatchRun(h.app);
    h.emit({ type: 'phase', phase: 'working' });

    h.emit({ type: 'activity', message: 'Read README.md' });

    const runs = await (await h.app.request('/api/projects/1/runs')).json();
    expect(runs.find((r: { id: number }) => r.id === runId).state).toBe('working');
  });

  it('returns 404 for a run with no activity feed', async () => {
    const h = makeHarness();

    const res = await h.app.request('/api/runs/999/activity');

    expect(res.status).toBe(404);
  });
});
