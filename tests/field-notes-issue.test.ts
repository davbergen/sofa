import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/server/db';
import { createApp, type AppDeps } from '../src/server/app';
import { READY_LABEL } from '../src/server/adapters';
import { FakeAgent } from '../src/server/fake-agent';
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
        number: 77,
        url: 'https://github.com/davbergen/scratch/issues/77',
      });
    },
    ensureLabels: () => Promise.resolve(),
    getPrState: () => Promise.resolve('OPEN'),
  };
  return { github, created };
}

const noopContainer: ContainerAdapter = {
  startWorker() {
    throw new Error('no Worker should start in these tests');
  },
};

function makeDir() {
  return mkdtempSync(join(tmpdir(), 'sofa-fn-issue-'));
}

function makeHarness(github: GitHubAdapter) {
  const deps: AppDeps = { github, container: noopContainer };
  const app = createApp(openDb(':memory:'), new FakeAgent(), deps);
  return app;
}

async function openProject(app: ReturnType<typeof makeHarness>, dir: string) {
  const res = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir }),
  });
  return res.json();
}

async function dropNote(app: ReturnType<typeof makeHarness>, projectId: number, text: string) {
  return app.request(`/api/projects/${projectId}/field-notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

async function getNotes(app: ReturnType<typeof makeHarness>, projectId: number) {
  return (await app.request(`/api/projects/${projectId}/field-notes`)).json();
}

function fileIssue(
  app: ReturnType<typeof makeHarness>,
  projectId: number,
  itemId: number,
  body: unknown,
) {
  return app.request(`/api/projects/${projectId}/field-notes/items/${itemId}/issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('Cut a Field Note Item directly into a ready Issue', () => {
  // The headline acceptance: from a parsed Item to a filed, ready-labeled Issue,
  // with the Item marked acted in the same response. No Session is involved.
  it('files the Item as a ready-for-agent Issue and marks the Item acted atomically', async () => {
    const { github, created } = fakeGitHub();
    const app = makeHarness(github);
    const project = await openProject(app, makeDir());
    await dropNote(app, project.id, '1. Add a dark mode toggle\nlives in the header\n2. Fix the footer');

    const item = (await getNotes(app, project.id)).items[0];
    const res = await fileIssue(app, project.id, item.id, {
      title: item.text.split('\n')[0],
      body: item.text,
    });

    expect(res.status).toBe(201);
    // The Issue is filed with the ready-for-agent label, body = the full Item text.
    expect(created).toHaveLength(1);
    expect(created[0].issue).toEqual({
      title: 'Add a dark mode toggle',
      body: 'Add a dark mode toggle\nlives in the header',
      labels: [READY_LABEL],
    });

    // The same response marks the Item acted as an Issue, carrying the filed
    // Issue's number and URL and no Session link.
    const updated = await res.json();
    expect(updated).toMatchObject({
      id: item.id,
      acted: true,
      action: 'issue',
      sessionId: null,
      issueNumber: 77,
      issueUrl: 'https://github.com/davbergen/scratch/issues/77',
    });
  });

  it('persists the filed Item across a restart (different browser)', async () => {
    const { github } = fakeGitHub();
    const db = openDb(':memory:');
    const deps: AppDeps = { github, container: noopContainer };
    const app = createApp(db, new FakeAgent(), deps);
    const project = await (
      await app.request('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: makeDir() }),
      })
    ).json();
    await dropNote(app, project.id, '1. The one thing');

    const item = (await getNotes(app, project.id)).items[0];
    await fileIssue(app, project.id, item.id, { title: 'The one thing', body: item.text });

    const reborn = createApp(db, new FakeAgent(), deps);
    const list = await getNotes(reborn, project.id);
    expect(list.items[0]).toMatchObject({
      acted: true,
      action: 'issue',
      issueNumber: 77,
      issueUrl: 'https://github.com/davbergen/scratch/issues/77',
    });
  });

  it('returns a clear, actionable error and files nothing when the ready label is missing', async () => {
    const created: NewIssue[] = [];
    const github: GitHubAdapter = {
      resolveRepo: () => Promise.resolve('davbergen/scratch'),
      listReadyIssues: () => Promise.resolve([]),
      createIssue(_dir, issue) {
        created.push(issue);
        // Mirrors gh's failure when the label doesn't exist in the repo.
        return Promise.reject(
          new Error(`gh issue create failed (exit 1): could not add label: '${READY_LABEL}' not found`),
        );
      },
      ensureLabels: () => Promise.resolve(),
      getPrState: () => Promise.resolve('OPEN'),
    };
    const app = makeHarness(github);
    const project = await openProject(app, makeDir());
    await dropNote(app, project.id, '1. Something');

    const item = (await getNotes(app, project.id)).items[0];
    const res = await fileIssue(app, project.id, item.id, { title: 'Something', body: item.text });

    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain(READY_LABEL);
    // The Item stays unacted — nothing was filed durably.
    const after = await getNotes(app, project.id);
    expect(after.items[0]).toMatchObject({ acted: false, action: null });
  });

  it('502s with the underlying reason when filing fails for another cause', async () => {
    const github: GitHubAdapter = {
      resolveRepo: () => Promise.resolve('davbergen/scratch'),
      listReadyIssues: () => Promise.resolve([]),
      createIssue: () => Promise.reject(new Error('gh not authenticated')),
      ensureLabels: () => Promise.resolve(),
      getPrState: () => Promise.resolve('OPEN'),
    };
    const app = makeHarness(github);
    const project = await openProject(app, makeDir());
    await dropNote(app, project.id, '1. Something');
    const item = (await getNotes(app, project.id)).items[0];

    const res = await fileIssue(app, project.id, item.id, { title: 'Something', body: item.text });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('gh not authenticated');
  });

  it('requires a title', async () => {
    const { github } = fakeGitHub();
    const app = makeHarness(github);
    const project = await openProject(app, makeDir());
    await dropNote(app, project.id, '1. Something');
    const item = (await getNotes(app, project.id)).items[0];

    const res = await fileIssue(app, project.id, item.id, { body: item.text });
    expect(res.status).toBe(400);
  });

  it('returns 404 (and files nothing) for an Item not in the Project', async () => {
    const { github, created } = fakeGitHub();
    const app = makeHarness(github);
    const project = await openProject(app, makeDir());
    const otherProject = await openProject(app, makeDir());
    await dropNote(app, project.id, '1. item in project A');
    const item = (await getNotes(app, project.id)).items[0];

    const res = await fileIssue(app, otherProject.id, item.id, { title: 'x', body: 'x' });
    expect(res.status).toBe(404);
    expect(created).toHaveLength(0);
  });
});
