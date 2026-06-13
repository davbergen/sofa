import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/server/db';
import { createApp } from '../src/server/app';
import type { Agent } from '../src/server/agent';
import { FakeAgent } from '../src/server/fake-agent';

function makeDir() {
  return mkdtempSync(join(tmpdir(), 'sofa-test-'));
}

async function openProject(app: ReturnType<typeof createApp>, dir: string) {
  const res = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir }),
  });
  return res.json();
}

async function dropNote(app: ReturnType<typeof createApp>, projectId: number, text: string) {
  return app.request(`/api/projects/${projectId}/field-notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

async function getNotes(app: ReturnType<typeof createApp>, projectId: number) {
  return app.request(`/api/projects/${projectId}/field-notes`);
}

// The simulated restart / "different browser": a fresh createApp() over the
// SAME SQLite handle, mirroring tests/session-persistence.test.ts.
function restart(db: DatabaseSync, agent: Agent) {
  return createApp(db, agent);
}

describe('Field Notes read path', () => {
  it('parses a dropped note and serves its Items back', async () => {
    const db = openDb(':memory:');
    const app = createApp(db, new FakeAgent());
    const project = await openProject(app, makeDir());

    const drop = await dropNote(app, project.id, '1. Fix the header\n2. Align the footer');
    expect(drop.status).toBe(201);
    expect(await drop.json()).toMatchObject({
      hasNote: true,
      items: [{ text: 'Fix the header' }, { text: 'Align the footer' }],
    });

    const read = await getNotes(app, project.id);
    expect(read.status).toBe(200);
    const body = await read.json();
    expect(body.hasNote).toBe(true);
    expect(body.items.map((i: { text: string }) => i.text)).toEqual([
      'Fix the header',
      'Align the footer',
    ]);
  });

  it('persists Items across a restart and a different browser', async () => {
    const db = openDb(':memory:');
    const app = createApp(db, new FakeAgent());
    const project = await openProject(app, makeDir());
    await dropNote(app, project.id, '1. one\n2. two\n3. three');

    const reborn = restart(db, new FakeAgent());
    const read = await getNotes(reborn, project.id);
    expect(read.status).toBe(200);
    const body = await read.json();
    expect(body.hasNote).toBe(true);
    expect(body.items.map((i: { text: string }) => i.text)).toEqual(['one', 'two', 'three']);
  });

  it('replaces the prior note when a new file is dropped', async () => {
    const db = openDb(':memory:');
    const app = createApp(db, new FakeAgent());
    const project = await openProject(app, makeDir());

    await dropNote(app, project.id, '1. old item\n2. another old item');
    await dropNote(app, project.id, '1. brand new item');

    const body = await (await getNotes(app, project.id)).json();
    expect(body.items.map((i: { text: string }) => i.text)).toEqual(['brand new item']);
  });

  it('records a dropped note with no matching lines as an empty Item list', async () => {
    const db = openDb(':memory:');
    const app = createApp(db, new FakeAgent());
    const project = await openProject(app, makeDir());

    const drop = await dropNote(app, project.id, 'just prose, no numbered items');
    expect(drop.status).toBe(201);
    // hasNote distinguishes "a file was dropped" from the initial empty state,
    // so the UI can show clear "no items" feedback.
    expect(await drop.json()).toEqual({ hasNote: true, items: [] });
  });

  it('reports no note for a Project before anything is dropped', async () => {
    const db = openDb(':memory:');
    const app = createApp(db, new FakeAgent());
    const project = await openProject(app, makeDir());

    expect(await (await getNotes(app, project.id)).json()).toEqual({ hasNote: false, items: [] });
  });
});

describe('Field Notes acted status', () => {
  async function startSession(app: ReturnType<typeof createApp>, projectId: number, prompt: string) {
    const res = await app.request(`/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    return res.json();
  }

  async function actItem(
    app: ReturnType<typeof createApp>,
    projectId: number,
    itemId: number,
    action: string,
    sessionId: number,
  ) {
    return app.request(`/api/projects/${projectId}/field-notes/items/${itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, sessionId }),
    });
  }

  it('marks an Item acted with the action taken and the spawned Session id', async () => {
    const db = openDb(':memory:');
    const app = createApp(db, new FakeAgent());
    const project = await openProject(app, makeDir());
    await dropNote(app, project.id, '1. Fix the header\n2. Align the footer');

    const notes = await (await getNotes(app, project.id)).json();
    const item = notes.items[0];
    const session = await startSession(app, project.id, item.text);

    const res = await actItem(app, project.id, item.id, 'grill', session.id);
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated).toMatchObject({ id: item.id, acted: true, action: 'grill', sessionId: session.id });
  });

  it('acted Items appear in the list with their status', async () => {
    const db = openDb(':memory:');
    const app = createApp(db, new FakeAgent());
    const project = await openProject(app, makeDir());
    await dropNote(app, project.id, '1. First\n2. Second');

    const notes = await (await getNotes(app, project.id)).json();
    const [first] = notes.items as Array<{ id: number; text: string }>;
    const session = await startSession(app, project.id, first.text);
    await actItem(app, project.id, first.id, 'implement', session.id);

    const list = await (await getNotes(app, project.id)).json();
    expect(list.items[0]).toMatchObject({ acted: true, action: 'implement', sessionId: session.id });
    expect(list.items[1]).toMatchObject({ acted: false, action: null, sessionId: null });
  });

  it('acted status survives a restart (different browser)', async () => {
    const db = openDb(':memory:');
    const app = createApp(db, new FakeAgent());
    const project = await openProject(app, makeDir());
    await dropNote(app, project.id, '1. The one thing');

    const notes = await (await getNotes(app, project.id)).json();
    const item = notes.items[0];
    const session = await startSession(app, project.id, item.text);
    await actItem(app, project.id, item.id, 'grill', session.id);

    const reborn = createApp(db, new FakeAgent());
    const read = await (await getNotes(reborn, project.id)).json();
    expect(read.items[0]).toMatchObject({ acted: true, action: 'grill', sessionId: session.id });
  });

  it('a fresh note drop resets acted status on the new Items', async () => {
    const db = openDb(':memory:');
    const app = createApp(db, new FakeAgent());
    const project = await openProject(app, makeDir());
    await dropNote(app, project.id, '1. old item');

    const notes = await (await getNotes(app, project.id)).json();
    const item = notes.items[0];
    const session = await startSession(app, project.id, item.text);
    await actItem(app, project.id, item.id, 'implement', session.id);

    await dropNote(app, project.id, '1. brand new item');
    const fresh = await (await getNotes(app, project.id)).json();
    expect(fresh.items).toHaveLength(1);
    expect(fresh.items[0]).toMatchObject({ text: 'brand new item', acted: false });
  });

  it('returns 404 when marking an Item that does not belong to the Project', async () => {
    const db = openDb(':memory:');
    const app = createApp(db, new FakeAgent());
    const project = await openProject(app, makeDir());
    const otherProject = await openProject(app, makeDir());
    await dropNote(app, project.id, '1. item in project A');
    const notes = await (await getNotes(app, project.id)).json();
    const item = notes.items[0];
    const session = await startSession(app, otherProject.id, 'prompt');

    const res = await actItem(app, otherProject.id, item.id, 'grill', session.id);
    expect(res.status).toBe(404);
  });

  it('returns 400 when action or sessionId is missing', async () => {
    const db = openDb(':memory:');
    const app = createApp(db, new FakeAgent());
    const project = await openProject(app, makeDir());
    await dropNote(app, project.id, '1. item');
    const notes = await (await getNotes(app, project.id)).json();
    const item = notes.items[0];

    const missingSession = await app.request(
      `/api/projects/${project.id}/field-notes/items/${item.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'grill' }),
      },
    );
    expect(missingSession.status).toBe(400);

    const missingAction = await app.request(
      `/api/projects/${project.id}/field-notes/items/${item.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 1 }),
      },
    );
    expect(missingAction.status).toBe(400);
  });
});

describe('Field Notes endpoint validation', () => {
  it('returns 404 for an unknown Project on read', async () => {
    const app = createApp(openDb(':memory:'), new FakeAgent());
    expect((await getNotes(app, 12345)).status).toBe(404);
  });

  it('returns 404 for an unknown Project on drop', async () => {
    const app = createApp(openDb(':memory:'), new FakeAgent());
    expect((await dropNote(app, 12345, '1. item')).status).toBe(404);
  });

  it('rejects a drop without text', async () => {
    const app = createApp(openDb(':memory:'), new FakeAgent());
    const project = await openProject(app, makeDir());
    const res = await app.request(`/api/projects/${project.id}/field-notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
