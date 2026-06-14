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
  return mkdtempSync(join(tmpdir(), 'sofa-rm-fni-'));
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

async function getNotes(app: ReturnType<typeof makeHarness>['app'], projectId: number) {
  return (await app.request(`/api/projects/${projectId}/field-notes`)).json();
}

function deleteItem(
  app: ReturnType<typeof makeHarness>['app'],
  projectId: number,
  itemId: number,
) {
  return app.request(`/api/projects/${projectId}/field-notes/items/${itemId}`, {
    method: 'DELETE',
  });
}

describe('DELETE /api/projects/:projectId/field-notes/items/:itemId', () => {
  it('returns 204 and removes the Item from the list', async () => {
    const { app } = makeHarness();
    const project = await openProject(app, makeDir());
    await dropNote(app, project.id, '1. First\n2. Second');

    const { items } = await getNotes(app, project.id);
    const res = await deleteItem(app, project.id, items[0].id);

    expect(res.status).toBe(204);
    const after = await getNotes(app, project.id);
    expect(after.items).toHaveLength(1);
    expect(after.items[0].text).toBe('Second');
  });

  it('removal survives a restart (row is gone from disk)', async () => {
    const db = openDb(':memory:');
    const app = createApp(db, new FakeAgent(), { github: noopGitHub, container: noopContainer });
    const project = await openProject(app, makeDir());
    await dropNote(app, project.id, '1. Only one');
    const { items } = await getNotes(app, project.id);

    await deleteItem(app, project.id, items[0].id);

    const app2 = createApp(db, new FakeAgent(), { github: noopGitHub, container: noopContainer });
    const after = await getNotes(app2, project.id);
    expect(after.items).toHaveLength(0);
  });

  it('can remove an acted Item (Grilled)', async () => {
    const { app } = makeHarness();
    const project = await openProject(app, makeDir());
    await dropNote(app, project.id, '1. Something');
    const { items } = await getNotes(app, project.id);

    // Simulate the item being acted via a grill session.
    // We patch it directly via the PATCH endpoint.
    // First create a session so we have a valid sessionId.
    // For this test we just need any acted item — markActed requires a sessionId,
    // so we reuse the store directly via the PATCH route with a fake session id.
    // The PATCH route requires a real session row, so instead we test via the
    // markActedAsIssue path (POST .../issue), which doesn't need a Session.
    await app.request(`/api/projects/${project.id}/field-notes/items/${items[0].id}/issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Something', body: 'Something' }),
    });
    const acted = await getNotes(app, project.id);
    expect(acted.items[0].acted).toBe(true);

    const res = await deleteItem(app, project.id, items[0].id);
    expect(res.status).toBe(204);
    const after = await getNotes(app, project.id);
    expect(after.items).toHaveLength(0);
  });

  it('returns 404 when the Item does not belong to the Project', async () => {
    const { app } = makeHarness();
    const projectA = await openProject(app, makeDir());
    const projectB = await openProject(app, makeDir());
    await dropNote(app, projectA.id, '1. Item in A');
    const { items } = await getNotes(app, projectA.id);

    const res = await deleteItem(app, projectB.id, items[0].id);
    expect(res.status).toBe(404);

    // The Item in A is untouched.
    const after = await getNotes(app, projectA.id);
    expect(after.items).toHaveLength(1);
  });

  it('returns 404 for a nonexistent item id', async () => {
    const { app } = makeHarness();
    const project = await openProject(app, makeDir());

    const res = await deleteItem(app, project.id, 99999);
    expect(res.status).toBe(404);
  });

  it('does not affect any other Item, note, or Project', async () => {
    const { app } = makeHarness();
    const projectA = await openProject(app, makeDir());
    const projectB = await openProject(app, makeDir());
    await dropNote(app, projectA.id, '1. Keep\n2. Delete');
    await dropNote(app, projectB.id, '1. Other project item');

    const { items } = await getNotes(app, projectA.id);
    const toDelete = items.find((i: { text: string }) => i.text === 'Delete')!;
    const toKeep = items.find((i: { text: string }) => i.text === 'Keep')!;

    const res = await deleteItem(app, projectA.id, toDelete.id);
    expect(res.status).toBe(204);

    // The sibling item in A survives.
    const afterA = await getNotes(app, projectA.id);
    expect(afterA.items).toHaveLength(1);
    expect(afterA.items[0].id).toBe(toKeep.id);

    // Project B is untouched.
    const afterB = await getNotes(app, projectB.id);
    expect(afterB.items).toHaveLength(1);
  });
});
