import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/server/db';
import { createApp } from '../src/server/app';
import { FakeAgent } from '../src/server/fake-agent';
import type { ContainerAdapter, GitHubAdapter } from '../src/server/ports';

const noopGitHub: GitHubAdapter = {
  resolveRepo: () => Promise.resolve('davbergen/scratch'),
  listReadyIssues: () => Promise.resolve([]),
  createIssue: () => Promise.resolve({ number: 1, url: 'https://github.com/davbergen/scratch/issues/1' }),
  ensureLabels: () => Promise.resolve(),
  getPrState: () => Promise.resolve('OPEN'),
  listOpenPrsByIssue: () => Promise.resolve([]),
};

const noopContainer: ContainerAdapter = {
  startWorker() {
    throw new Error('no Worker should start in these tests');
  },
};

function makeHarness() {
  const db = openDb(':memory:');
  const app = createApp(db, new FakeAgent(), { github: noopGitHub, container: noopContainer });
  return { app, db };
}

function makeDir() {
  return mkdtempSync(join(tmpdir(), 'sofa-append-fni-'));
}

async function openProject(app: ReturnType<typeof makeHarness>['app'], dir: string) {
  const res = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir }),
  });
  return res.json() as Promise<{ id: number }>;
}

async function dropNote(app: ReturnType<typeof makeHarness>['app'], projectId: number, text: string) {
  return app.request(`/api/projects/${projectId}/field-notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

async function appendItem(
  app: ReturnType<typeof makeHarness>['app'],
  projectId: number,
  text: string,
) {
  return app.request(`/api/projects/${projectId}/field-notes/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

async function getNotes(app: ReturnType<typeof makeHarness>['app'], projectId: number) {
  return (await app.request(`/api/projects/${projectId}/field-notes`)).json();
}

describe('POST /api/projects/:projectId/field-notes/items', () => {
  it('appends an Item to an existing note as a normal unacted Item', async () => {
    const { app } = makeHarness();
    const project = await openProject(app, makeDir());
    await dropNote(app, project.id, '1. First\n2. Second');

    const res = await appendItem(app, project.id, 'Third');
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.hasNote).toBe(true);
    expect(body.items.map((i: { text: string }) => i.text)).toEqual([
      'First',
      'Second',
      'Third',
    ]);
    // The appended Item is shaped like any other: unacted, with no action,
    // sessionId, or issue link.
    const appended = body.items[2];
    expect(appended).toMatchObject({
      text: 'Third',
      acted: false,
      action: null,
      sessionId: null,
      issueNumber: null,
      issueUrl: null,
    });
    expect(typeof appended.id).toBe('number');
  });

  it('appending when no note exists creates the note (hasNote flips true)', async () => {
    const { app } = makeHarness();
    const project = await openProject(app, makeDir());

    // No drop yet — the read path reports `hasNote: false`.
    expect(await getNotes(app, project.id)).toEqual({ hasNote: false, items: [] });

    const res = await appendItem(app, project.id, 'first ever Item');
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.hasNote).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ text: 'first ever Item', acted: false });
  });

  it('preserves drop order and tails new appends after existing Items', async () => {
    const { app } = makeHarness();
    const project = await openProject(app, makeDir());
    await dropNote(app, project.id, '1. A\n2. B');
    await appendItem(app, project.id, 'C');
    await appendItem(app, project.id, 'D');

    const body = await getNotes(app, project.id);
    expect(body.items.map((i: { text: string }) => i.text)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('an appended Item survives a restart (persisted)', async () => {
    const db = openDb(':memory:');
    const app = createApp(db, new FakeAgent(), { github: noopGitHub, container: noopContainer });
    const project = await openProject(app, makeDir());
    await appendItem(app, project.id, 'persists');

    const reborn = createApp(db, new FakeAgent(), { github: noopGitHub, container: noopContainer });
    const body = await getNotes(reborn, project.id);
    expect(body.hasNote).toBe(true);
    expect(body.items.map((i: { text: string }) => i.text)).toEqual(['persists']);
  });

  it('returns 404 for an unknown Project', async () => {
    const { app } = makeHarness();
    const res = await appendItem(app, 99999, 'orphan');
    expect(res.status).toBe(404);
  });

  it('returns 400 when text is missing or empty', async () => {
    const { app } = makeHarness();
    const project = await openProject(app, makeDir());

    const noBody = await app.request(`/api/projects/${project.id}/field-notes/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(noBody.status).toBe(400);

    const emptyText = await appendItem(app, project.id, '   ');
    expect(emptyText.status).toBe(400);

    // No note row should have been created by either rejected request.
    expect(await getNotes(app, project.id)).toEqual({ hasNote: false, items: [] });
  });

  it('isolates appends between Projects', async () => {
    const { app } = makeHarness();
    const projectA = await openProject(app, makeDir());
    const projectB = await openProject(app, makeDir());
    await dropNote(app, projectA.id, '1. A only');

    await appendItem(app, projectA.id, 'still A only');
    await appendItem(app, projectB.id, 'B only');

    const a = await getNotes(app, projectA.id);
    const b = await getNotes(app, projectB.id);
    expect(a.items.map((i: { text: string }) => i.text)).toEqual(['A only', 'still A only']);
    expect(b.items.map((i: { text: string }) => i.text)).toEqual(['B only']);
  });

  it('an appended Item is identical in shape to a parsed one (same actions apply)', async () => {
    const { app } = makeHarness();
    const project = await openProject(app, makeDir());

    // Append an Item with no prior drop, then file it as an Issue via the
    // existing markActedAsIssue path. Success proves the appended Item plugs
    // into the same actions a parsed Item supports.
    const appended = await (await appendItem(app, project.id, 'file me')).json();
    const itemId = appended.items[0].id;

    const fileRes = await app.request(
      `/api/projects/${project.id}/field-notes/items/${itemId}/issue`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'file me', body: 'file me' }),
      },
    );
    expect(fileRes.status).toBe(201);

    const after = await getNotes(app, project.id);
    expect(after.items[0]).toMatchObject({ acted: true, action: 'issue' });
  });
});
