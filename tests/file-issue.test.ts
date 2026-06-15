import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/server/db';
import { createApp, type AppDeps } from '../src/server/app';
import { READY_LABEL } from '../src/server/adapters';
import { FakeAgent } from '../src/server/fake-agent';
import type { ContainerAdapter, GitHubAdapter, NewIssue } from '../src/server/ports';

// Capture options + return one synthetic FileIssue tool_use so the canUseTool
// interception path runs against a real SdkAgent.
const queryCalls: Array<{ options: Record<string, unknown> }> = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options: { canUseTool: unknown } }) => {
    queryCalls.push(args as { options: Record<string, unknown> });
    return (async function* () {
      // Empty stream — the interception is driven directly via canUseTool below.
    })();
  },
}));

import { SdkAgent } from '../src/server/sdk-agent';

describe('SdkAgent FileIssue interception', () => {
  it('surfaces a file_issue_draft event and allows the tool without prompting', async () => {
    queryCalls.length = 0;
    const agent = new SdkAgent();
    const session = agent.run({ prompt: 'go', cwd: '/tmp' });

    type CanUseTool = (
      name: string,
      input: Record<string, unknown>,
      ctx: { toolUseID: string; signal: AbortSignal },
    ) => Promise<{ behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown> }>;
    const canUseTool = queryCalls[0].options.canUseTool as CanUseTool;
    const result = await canUseTool(
      'FileIssue',
      { title: 'Add a dark mode toggle', body: 'lives in the header' },
      { toolUseID: 'tu_1', signal: new AbortController().signal },
    );
    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: { title: 'Add a dark mode toggle', body: 'lives in the header' },
    });

    const events: Array<{ type: string }> = [];
    for await (const event of session.events) events.push(event);
    expect(events).toContainEqual({
      type: 'file_issue_draft',
      title: 'Add a dark mode toggle',
      body: 'lives in the header',
    });
  });

  it('intercepts the plugin-qualified __FileIssue suffix form too', async () => {
    queryCalls.length = 0;
    const agent = new SdkAgent();
    const session = agent.run({ prompt: 'go', cwd: '/tmp' });

    type CanUseTool = (
      name: string,
      input: Record<string, unknown>,
      ctx: { toolUseID: string; signal: AbortSignal },
    ) => Promise<{ behavior: 'allow' | 'deny' }>;
    const canUseTool = queryCalls[0].options.canUseTool as CanUseTool;
    const result = await canUseTool(
      'mcp__some-plugin__FileIssue',
      { title: 'T', body: 'B' },
      { toolUseID: 'tu_2', signal: new AbortController().signal },
    );
    expect(result.behavior).toBe('allow');

    const events: Array<{ type: string }> = [];
    for await (const event of session.events) events.push(event);
    expect(events.some((e) => e.type === 'file_issue_draft')).toBe(true);
  });
});

function fakeGitHub() {
  const created: Array<{ dir: string; issue: NewIssue }> = [];
  const github: GitHubAdapter = {
    resolveRepo: () => Promise.resolve('davbergen/scratch'),
    listReadyIssues: () => Promise.resolve([]),
    createIssue(dir, issue) {
      created.push({ dir, issue });
      return Promise.resolve({
        number: 88,
        url: 'https://github.com/davbergen/scratch/issues/88',
      });
    },
    ensureLabels: () => Promise.resolve(),
    getPrState: () => Promise.resolve('OPEN'),
    listOpenPrsByIssue: () => Promise.resolve([]),
  };
  return { github, created };
}

const noopContainer: ContainerAdapter = {
  startWorker() {
    throw new Error('no Worker should start in these tests');
  },
};

function makeHarness(github: GitHubAdapter) {
  const deps: AppDeps = { github, container: noopContainer };
  return createApp(openDb(':memory:'), new FakeAgent(), deps);
}

async function startSession(app: ReturnType<typeof makeHarness>): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'sofa-file-issue-'));
  const projectRes = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir }),
  });
  const project = await projectRes.json();
  const res = await app.request(`/api/projects/${project.id}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'Draft an Issue with me' }),
  });
  return (await res.json()).id;
}

function fileIssue(
  app: ReturnType<typeof makeHarness>,
  sessionId: number,
  body: unknown,
) {
  return app.request(`/api/sessions/${sessionId}/file-issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/sessions/:sessionId/file-issue', () => {
  it('files the proposed Issue with the ready-for-agent label and returns its number + URL', async () => {
    const { github, created } = fakeGitHub();
    const app = makeHarness(github);
    const sessionId = await startSession(app);

    const res = await fileIssue(app, sessionId, {
      title: 'Add a dark mode toggle',
      body: 'lives in the header',
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      number: 88,
      url: 'https://github.com/davbergen/scratch/issues/88',
    });
    expect(created).toHaveLength(1);
    expect(created[0].issue).toEqual({
      title: 'Add a dark mode toggle',
      body: 'lives in the header',
      labels: [READY_LABEL],
    });
  });

  it('returns 422 with an actionable error when the ready-for-agent label is missing', async () => {
    const github: GitHubAdapter = {
      resolveRepo: () => Promise.resolve('davbergen/scratch'),
      listReadyIssues: () => Promise.resolve([]),
      createIssue: () =>
        Promise.reject(
          new Error(`gh issue create failed (exit 1): could not add label: '${READY_LABEL}' not found`),
        ),
      ensureLabels: () => Promise.resolve(),
      getPrState: () => Promise.resolve('OPEN'),
      listOpenPrsByIssue: () => Promise.resolve([]),
    };
    const app = makeHarness(github);
    const sessionId = await startSession(app);

    const res = await fileIssue(app, sessionId, { title: 'T', body: 'B' });

    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain(READY_LABEL);
  });

  it('502s with the underlying reason for other gh failures', async () => {
    const github: GitHubAdapter = {
      resolveRepo: () => Promise.resolve('davbergen/scratch'),
      listReadyIssues: () => Promise.resolve([]),
      createIssue: () => Promise.reject(new Error('gh not authenticated')),
      ensureLabels: () => Promise.resolve(),
      getPrState: () => Promise.resolve('OPEN'),
      listOpenPrsByIssue: () => Promise.resolve([]),
    };
    const app = makeHarness(github);
    const sessionId = await startSession(app);

    const res = await fileIssue(app, sessionId, { title: 'T', body: 'B' });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('gh not authenticated');
  });

  it('requires a title', async () => {
    const { github } = fakeGitHub();
    const app = makeHarness(github);
    const sessionId = await startSession(app);

    const res = await fileIssue(app, sessionId, { body: 'B' });
    expect(res.status).toBe(400);
  });

  it('404s for an unknown Session', async () => {
    const { github, created } = fakeGitHub();
    const app = makeHarness(github);

    const res = await fileIssue(app, 12345, { title: 'T', body: 'B' });
    expect(res.status).toBe(404);
    expect(created).toHaveLength(0);
  });
});
