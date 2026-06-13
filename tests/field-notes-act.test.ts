import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/server/db';
import { createApp } from '../src/server/app';
import { FakeAgent } from '../src/server/fake-agent';
import type { Agent } from '../src/server/agent';

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
  const res = await app.request(`/api/projects/${projectId}/field-notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  return res.json();
}

async function actOnItem(
  app: ReturnType<typeof createApp>,
  projectId: number,
  itemId: number,
  action: string,
) {
  return app.request(`/api/projects/${projectId}/field-notes/items/${itemId}/act`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
}

function restart(db: DatabaseSync, agent: Agent) {
  return createApp(db, agent);
}

describe('acting on a Field Note Item', () => {
  it('creates a Session with grill-with-docs skill for the grill action', async () => {
    const agent = new FakeAgent();
    const db = openDb(':memory:');
    const app = createApp(db, agent);
    const project = await openProject(app, makeDir());
    const notes = await dropNote(app, project.id, '1. Tighten the footer layout');
    const item = notes.items[0];

    const res = await actOnItem(app, project.id, item.id, 'grill');

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.session).toMatchObject({
      projectId: project.id,
      prompt: 'Tighten the footer layout',
      skill: 'grill-with-docs',
    });
    expect(body.session.id).toBeGreaterThan(0);
    expect(agent.runs).toEqual([
      { prompt: 'Tighten the footer layout', cwd: project.dir, skill: 'grill-with-docs' },
    ]);
  });

  it('creates a Session with no skill for the implement action', async () => {
    const agent = new FakeAgent();
    const db = openDb(':memory:');
    const app = createApp(db, agent);
    const project = await openProject(app, makeDir());
    const notes = await dropNote(app, project.id, '1. Fix the nav highlight');
    const item = notes.items[0];

    const res = await actOnItem(app, project.id, item.id, 'implement');

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.session).toMatchObject({
      projectId: project.id,
      prompt: 'Fix the nav highlight',
      skill: null,
    });
    expect(agent.runs).toEqual([{ prompt: 'Fix the nav highlight', cwd: project.dir }]);
  });

  it('marks the Item as acted and links it to the Session', async () => {
    const db = openDb(':memory:');
    const app = createApp(db, new FakeAgent());
    const project = await openProject(app, makeDir());
    const notes = await dropNote(app, project.id, '1. Update the colour tokens');
    const item = notes.items[0];

    const res = await actOnItem(app, project.id, item.id, 'grill');
    const { session, item: actedItem } = await res.json();

    expect(actedItem).toMatchObject({
      id: item.id,
      text: 'Update the colour tokens',
      actedAction: 'grill',
      sessionId: session.id,
    });
  });

  it('persists the acted status and session link across a restart', async () => {
    const db = openDb(':memory:');
    const app = createApp(db, new FakeAgent());
    const project = await openProject(app, makeDir());
    const notes = await dropNote(app, project.id, '1. Improve keyboard nav\n2. Adjust spacing');
    const [first] = notes.items;

    const actRes = await actOnItem(app, project.id, first.id, 'implement');
    const { session } = await actRes.json();

    const reborn = restart(db, new FakeAgent());
    const readRes = await reborn.request(`/api/projects/${project.id}/field-notes`);
    const reloaded = await readRes.json();

    const reloadedFirst = reloaded.items.find((i: { id: number }) => i.id === first.id);
    expect(reloadedFirst).toMatchObject({
      actedAction: 'implement',
      sessionId: session.id,
    });
    // The second item should remain unacted.
    const reloadedSecond = reloaded.items.find((i: { id: number }) => i.id !== first.id);
    expect(reloadedSecond).toMatchObject({ actedAction: null, sessionId: null });
  });

  it('can be re-triggered after a prior act (replaces the session link)', async () => {
    const db = openDb(':memory:');
    const app = createApp(db, new FakeAgent());
    const project = await openProject(app, makeDir());
    const notes = await dropNote(app, project.id, '1. Re-triggerable item');
    const item = notes.items[0];

    const first = await (await actOnItem(app, project.id, item.id, 'implement')).json();
    const second = await (await actOnItem(app, project.id, item.id, 'grill')).json();

    expect(second.item.actedAction).toBe('grill');
    expect(second.item.sessionId).toBe(second.session.id);
    expect(second.session.id).not.toBe(first.session.id);
  });

  it('returns 404 for an unknown Project', async () => {
    const app = createApp(openDb(':memory:'), new FakeAgent());
    const res = await actOnItem(app, 9999, 1, 'grill');
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain('9999');
  });

  it('returns 404 for an unknown Item id', async () => {
    const db = openDb(':memory:');
    const app = createApp(db, new FakeAgent());
    const project = await openProject(app, makeDir());
    await dropNote(app, project.id, '1. Some item');

    const res = await actOnItem(app, project.id, 9999, 'grill');
    expect(res.status).toBe(404);
  });

  it('returns 404 when the Item belongs to a different Project', async () => {
    const db = openDb(':memory:');
    const app = createApp(db, new FakeAgent());
    const p1 = await openProject(app, makeDir());
    const p2 = await openProject(app, makeDir());
    const notes = await dropNote(app, p1.id, '1. Item on project 1');
    const item = notes.items[0];

    const res = await actOnItem(app, p2.id, item.id, 'grill');
    expect(res.status).toBe(404);
  });

  it('rejects an invalid action', async () => {
    const db = openDb(':memory:');
    const app = createApp(db, new FakeAgent());
    const project = await openProject(app, makeDir());
    const notes = await dropNote(app, project.id, '1. Any item');
    const item = notes.items[0];

    const res = await actOnItem(app, project.id, item.id, 'frobulate');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("action must be 'grill' or 'implement'");
  });

  it('sends the Item text verbatim as the Session prompt', async () => {
    const agent = new FakeAgent();
    const db = openDb(':memory:');
    const app = createApp(db, agent);
    const project = await openProject(app, makeDir());
    const notes = await dropNote(
      app,
      project.id,
      '1. Rename `isActive` to `isVisible` everywhere',
    );
    const item = notes.items[0];

    await actOnItem(app, project.id, item.id, 'implement');

    expect(agent.runs[0].prompt).toBe('Rename `isActive` to `isVisible` everywhere');
  });
});
