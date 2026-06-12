import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/server/db';
import { createApp, READY_LABEL, type AppDeps } from '../src/server/app';
import { FakeAgent, type FakeAgentStep } from '../src/server/fake-agent';
import type { ContainerAdapter, GitHubAdapter, NewIssue } from '../src/server/ports';

/** Fake GitHub adapter: records every issue it is asked to create, numbering them in order. */
function fakeGitHub() {
  const created: Array<{ dir: string; issue: NewIssue }> = [];
  const github: GitHubAdapter = {
    resolveRepo: () => Promise.resolve('davbergen/scratch'),
    listReadyIssues: () => Promise.resolve([]),
    createIssue(dir, issue) {
      created.push({ dir, issue });
      const number = 100 + created.length;
      return Promise.resolve({
        number,
        url: `https://github.com/davbergen/scratch/issues/${number}`,
      });
    },
  };
  return { github, created };
}

const noopContainer: ContainerAdapter = {
  startWorker() {
    throw new Error('no Worker should start in these tests');
  },
};

function makeHarness(agent: FakeAgent) {
  const { github, created } = fakeGitHub();
  const deps: AppDeps = { github, container: noopContainer };
  const app = createApp(openDb(':memory:'), agent, deps);
  return { app, created };
}

async function startSession(app: ReturnType<typeof makeHarness>['app']): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'sofa-issues-'));
  const projectRes = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir }),
  });
  const project = await projectRes.json();
  const res = await app.request(`/api/projects/${project.id}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'Break the PRD into Issues' }),
  });
  expect(res.status).toBe(201);
  return (await res.json()).id;
}

interface SseEvent {
  event: string;
  data: string;
}

/** Incremental SSE reader (the fake Agent may be paused, so never read to completion). */
function openSse(res: Response) {
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const queue: SseEvent[] = [];

  async function next(): Promise<SseEvent> {
    for (;;) {
      const ready = queue.shift();
      if (ready) return ready;
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      let split;
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        if (!chunk.trim()) continue;
        const lines = chunk.split('\n');
        queue.push({
          event: lines.find((l) => l.startsWith('event:'))?.slice('event:'.length).trim() ?? '',
          data: lines.find((l) => l.startsWith('data:'))?.slice('data:'.length).trim() ?? '',
        });
      }
      if (done && queue.length === 0) throw new Error('SSE stream ended unexpectedly');
    }
  }

  async function until(eventType: string): Promise<SseEvent> {
    for (;;) {
      const event = await next();
      if (event.event === eventType) return event;
    }
  }

  return { next, until };
}

const BREAKDOWN: FakeAgentStep = {
  type: 'issue_breakdown',
  issues: [
    { title: 'Lay the data model', body: 'Tables and migrations first.' },
    { title: 'Build the API', body: 'Depends on the data model.' },
    { title: 'Wire the UI', body: 'Depends on the API.' },
  ],
};

const REVISED_BREAKDOWN: FakeAgentStep = {
  type: 'issue_breakdown',
  issues: [
    { title: 'Lay the data model', body: 'Tables and migrations first.' },
    { title: 'Build the API and the UI', body: 'Merged into one vertical slice.' },
  ],
};

function sendMessage(app: ReturnType<typeof makeHarness>['app'], sessionId: number, text: string) {
  return app.request(`/api/sessions/${sessionId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

function approve(app: ReturnType<typeof makeHarness>['app'], sessionId: number) {
  return app.request(`/api/sessions/${sessionId}/issues/approve`, { method: 'POST' });
}

describe('Issue breakdown', () => {
  it('streams the proposed breakdown as an issue_breakdown event carrying the list', async () => {
    const h = makeHarness(
      new FakeAgent([{ type: 'assistant_text', text: 'Here is the breakdown.' }, BREAKDOWN]),
    );
    const sessionId = await startSession(h.app);

    const sse = openSse(await h.app.request(`/api/sessions/${sessionId}/events`));
    const breakdown = await sse.until('issue_breakdown');

    expect(JSON.parse(breakdown.data)).toEqual(BREAKDOWN);
    await sse.until('done');
  });

  it('routes a conversational revision to the Agent and streams the updated breakdown', async () => {
    const agent = new FakeAgent([BREAKDOWN, { type: 'await_message' }, REVISED_BREAKDOWN]);
    const h = makeHarness(agent);
    const sessionId = await startSession(h.app);

    const sse = openSse(await h.app.request(`/api/sessions/${sessionId}/events`));
    await sse.until('issue_breakdown');

    const res = await sendMessage(h.app, sessionId, 'Merge the API and UI issues.');
    expect(res.status).toBe(200);
    expect(agent.messages).toEqual(['Merge the API and UI issues.']);

    // The revision request is echoed onto the transcript, then the revised breakdown arrives.
    expect(JSON.parse((await sse.until('user_message')).data).text).toBe('Merge the API and UI issues.');
    expect(JSON.parse((await sse.until('issue_breakdown')).data).issues).toHaveLength(2);
    await sse.until('done');
  });
});

describe('Approve', () => {
  it('creates the Issues on GitHub, labeled and in dependency order, via the adapter', async () => {
    const h = makeHarness(new FakeAgent([BREAKDOWN]));
    const sessionId = await startSession(h.app);
    const sse = openSse(await h.app.request(`/api/sessions/${sessionId}/events`));
    await sse.until('issue_breakdown');

    const res = await approve(h.app, sessionId);

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      issues: [
        { number: 101, url: 'https://github.com/davbergen/scratch/issues/101' },
        { number: 102, url: 'https://github.com/davbergen/scratch/issues/102' },
        { number: 103, url: 'https://github.com/davbergen/scratch/issues/103' },
      ],
    });
    // One createIssue call per Issue, in dependency order, each labeled ready-for-agent.
    expect(h.created.map((c) => c.issue)).toEqual([
      { title: 'Lay the data model', body: 'Tables and migrations first.', labels: [READY_LABEL] },
      { title: 'Build the API', body: 'Depends on the data model.', labels: [READY_LABEL] },
      { title: 'Wire the UI', body: 'Depends on the API.', labels: [READY_LABEL] },
    ]);

    // Publication is echoed onto the transcript: a late subscriber replays it.
    const replay = openSse(await h.app.request(`/api/sessions/${sessionId}/events`));
    expect(JSON.parse((await replay.until('issues_published')).data).issues).toHaveLength(3);
  });

  it('publishes nothing before Approve is pressed', async () => {
    const h = makeHarness(new FakeAgent([BREAKDOWN, { type: 'await_message' }, REVISED_BREAKDOWN]));
    const sessionId = await startSession(h.app);
    const sse = openSse(await h.app.request(`/api/sessions/${sessionId}/events`));

    // The breakdown arrives, gets revised, and the Session even finishes —
    // still nothing reaches GitHub without an explicit Approve.
    await sse.until('issue_breakdown');
    await sendMessage(h.app, sessionId, 'Tighten the slices.');
    await sse.until('issue_breakdown');
    await sse.until('done');

    expect(h.created).toHaveLength(0);
  });

  it('creates the latest breakdown after a revision', async () => {
    const h = makeHarness(new FakeAgent([BREAKDOWN, { type: 'await_message' }, REVISED_BREAKDOWN]));
    const sessionId = await startSession(h.app);
    const sse = openSse(await h.app.request(`/api/sessions/${sessionId}/events`));
    await sse.until('issue_breakdown');
    await sendMessage(h.app, sessionId, 'Merge the API and UI issues.');
    await sse.until('issue_breakdown');

    const res = await approve(h.app, sessionId);

    expect(res.status).toBe(201);
    expect(h.created).toHaveLength(2);
    expect(h.created[1].issue.title).toBe('Build the API and the UI');
  });

  it('409s when the Session has no Issue breakdown yet', async () => {
    const h = makeHarness(new FakeAgent([{ type: 'assistant_text', text: 'Still thinking…' }]));
    const sessionId = await startSession(h.app);
    const sse = openSse(await h.app.request(`/api/sessions/${sessionId}/events`));
    await sse.until('done');

    const res = await approve(h.app, sessionId);

    expect(res.status).toBe(409);
    expect(h.created).toHaveLength(0);
  });

  it('returns 404 approving an unknown Session', async () => {
    const h = makeHarness(new FakeAgent());

    const res = await approve(h.app, 12345);
    expect(res.status).toBe(404);
    expect(h.created).toHaveLength(0);
  });

  it('502s with a reason when creation fails partway, and records no publication', async () => {
    let calls = 0;
    const github: GitHubAdapter = {
      resolveRepo: () => Promise.resolve('davbergen/scratch'),
      listReadyIssues: () => Promise.resolve([]),
      createIssue: () => {
        calls++;
        if (calls > 1) return Promise.reject(new Error('gh rate limited'));
        return Promise.resolve({ number: 101, url: 'https://github.com/davbergen/scratch/issues/101' });
      },
    };
    const app = createApp(openDb(':memory:'), new FakeAgent([BREAKDOWN]), {
      github,
      container: noopContainer,
    });
    const sessionId = await startSession(app);
    const sse = openSse(await app.request(`/api/sessions/${sessionId}/events`));
    await sse.until('issue_breakdown');

    const res = await approve(app, sessionId);

    expect(res.status).toBe(502);
    const { error } = await res.json();
    expect(error).toContain('gh rate limited');
    expect(error).toContain('1 of 3');
  });
});
