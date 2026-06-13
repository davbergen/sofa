import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/server/db';
import { createApp, PRD_LABEL, type AppDeps } from '../src/server/app';
import { FakeAgent, type FakeAgentStep } from '../src/server/fake-agent';
import type { ContainerAdapter, GitHubAdapter, NewIssue } from '../src/server/ports';

/** Fake GitHub adapter: records every issue it is asked to create. */
function fakeGitHub() {
  const created: Array<{ dir: string; issue: NewIssue }> = [];
  const github: GitHubAdapter = {
    resolveRepo: () => Promise.resolve('davbergen/scratch'),
    listReadyIssues: () => Promise.resolve([]),
    createIssue(dir, issue) {
      created.push({ dir, issue });
      return Promise.resolve({
        number: 41,
        url: 'https://github.com/davbergen/scratch/issues/41',
      });
    },
    ensureLabels: () => Promise.resolve(),
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
  const dir = mkdtempSync(join(tmpdir(), 'sofa-prd-'));
  const projectRes = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir }),
  });
  const project = await projectRes.json();
  const res = await app.request(`/api/projects/${project.id}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'Grill me about the feature' }),
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

const DRAFT: FakeAgentStep = {
  type: 'prd_draft',
  title: 'PRD: Frobnicator',
  markdown: '# Frobnicator\n\nIt frobnicates.',
};

const REVISED_DRAFT: FakeAgentStep = {
  type: 'prd_draft',
  title: 'PRD: Frobnicator',
  markdown: '# Frobnicator\n\nIt frobnicates, now with undo.',
};

function sendMessage(app: ReturnType<typeof makeHarness>['app'], sessionId: number, text: string) {
  return app.request(`/api/sessions/${sessionId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

function approve(app: ReturnType<typeof makeHarness>['app'], sessionId: number) {
  return app.request(`/api/sessions/${sessionId}/prd/approve`, { method: 'POST' });
}

describe('PRD draft', () => {
  it('streams the draft as a prd_draft event carrying the document', async () => {
    const h = makeHarness(new FakeAgent([{ type: 'assistant_text', text: 'Here is the PRD.' }, DRAFT]));
    const sessionId = await startSession(h.app);

    const sse = openSse(await h.app.request(`/api/sessions/${sessionId}/events`));
    const draft = await sse.until('prd_draft');

    expect(JSON.parse(draft.data)).toEqual({
      type: 'prd_draft',
      title: 'PRD: Frobnicator',
      markdown: '# Frobnicator\n\nIt frobnicates.',
    });
    await sse.until('done');
  });

  it('routes a conversational revision to the Agent and streams the updated draft', async () => {
    const agent = new FakeAgent([DRAFT, { type: 'await_message' }, REVISED_DRAFT]);
    const h = makeHarness(agent);
    const sessionId = await startSession(h.app);

    const sse = openSse(await h.app.request(`/api/sessions/${sessionId}/events`));
    await sse.until('prd_draft');

    const res = await sendMessage(h.app, sessionId, 'Add an undo section.');
    expect(res.status).toBe(200);
    expect(agent.messages).toEqual(['Add an undo section.']);

    // The revision request is echoed onto the transcript, then the revised draft arrives.
    expect(JSON.parse((await sse.until('user_message')).data).text).toBe('Add an undo section.');
    expect(JSON.parse((await sse.until('prd_draft')).data).markdown).toContain('now with undo');
    await sse.until('done');
  });

  it('rejects an empty revision message', async () => {
    const h = makeHarness(new FakeAgent([DRAFT, { type: 'await_message' }]));
    const sessionId = await startSession(h.app);

    const res = await sendMessage(h.app, sessionId, '   ');
    expect(res.status).toBe(400);
  });

  it('returns 404 messaging an unknown Session', async () => {
    const h = makeHarness(new FakeAgent());

    const res = await sendMessage(h.app, 12345, 'hello?');
    expect(res.status).toBe(404);
  });
});

describe('Approve', () => {
  it('publishes the PRD as a labeled GitHub issue via the GitHub adapter', async () => {
    const h = makeHarness(new FakeAgent([DRAFT]));
    const sessionId = await startSession(h.app);
    const sse = openSse(await h.app.request(`/api/sessions/${sessionId}/events`));
    await sse.until('prd_draft');

    const res = await approve(h.app, sessionId);

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      number: 41,
      url: 'https://github.com/davbergen/scratch/issues/41',
    });
    expect(h.created).toHaveLength(1);
    expect(h.created[0].issue).toEqual({
      title: 'PRD: Frobnicator',
      body: '# Frobnicator\n\nIt frobnicates.',
      labels: [PRD_LABEL],
    });

    // Publication is echoed onto the transcript for the document panel.
    expect(JSON.parse((await sse.until('prd_published')).data)).toMatchObject({
      issueNumber: 41,
      url: 'https://github.com/davbergen/scratch/issues/41',
    });
  });

  it('publishes nothing before Approve is pressed', async () => {
    const h = makeHarness(new FakeAgent([DRAFT, { type: 'await_message' }, REVISED_DRAFT]));
    const sessionId = await startSession(h.app);
    const sse = openSse(await h.app.request(`/api/sessions/${sessionId}/events`));

    // The draft arrives, gets revised, and the Session even finishes —
    // still nothing reaches GitHub without an explicit Approve.
    await sse.until('prd_draft');
    await sendMessage(h.app, sessionId, 'Tighten the scope.');
    await sse.until('prd_draft');
    await sse.until('done');

    expect(h.created).toHaveLength(0);
  });

  it('publishes the latest draft after a revision', async () => {
    const h = makeHarness(new FakeAgent([DRAFT, { type: 'await_message' }, REVISED_DRAFT]));
    const sessionId = await startSession(h.app);
    const sse = openSse(await h.app.request(`/api/sessions/${sessionId}/events`));
    await sse.until('prd_draft');
    await sendMessage(h.app, sessionId, 'Add an undo section.');
    await sse.until('prd_draft');

    const res = await approve(h.app, sessionId);

    expect(res.status).toBe(201);
    expect(h.created).toHaveLength(1);
    expect(h.created[0].issue.body).toContain('now with undo');
  });

  it('409s when the Session has no PRD draft yet', async () => {
    const h = makeHarness(new FakeAgent([{ type: 'assistant_text', text: 'Still grilling…' }]));
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

  it('502s with a reason when publishing fails, and records no publication', async () => {
    const github: GitHubAdapter = {
      resolveRepo: () => Promise.resolve('davbergen/scratch'),
      listReadyIssues: () => Promise.resolve([]),
      createIssue: () => Promise.reject(new Error('gh not authenticated')),
      ensureLabels: () => Promise.resolve(),
    };
    const app = createApp(openDb(':memory:'), new FakeAgent([DRAFT]), {
      github,
      container: noopContainer,
    });
    const sessionId = await startSession(app);
    const sse = openSse(await app.request(`/api/sessions/${sessionId}/events`));
    await sse.until('prd_draft');

    const res = await approve(app, sessionId);

    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('gh not authenticated');
  });
});
