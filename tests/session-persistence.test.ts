import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/server/db';
import { createApp } from '../src/server/app';
import type { Agent } from '../src/server/agent';
import { FakeAgent, fakeAgentSaying } from '../src/server/fake-agent';

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

async function startSession(app: ReturnType<typeof createApp>, projectId: number, prompt: string) {
  const res = await app.request(`/api/projects/${projectId}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  return res.json();
}

async function resumeSession(app: ReturnType<typeof createApp>, sessionId: number, prompt: string) {
  return app.request(`/api/sessions/${sessionId}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
}

async function fetchTranscript(app: ReturnType<typeof createApp>, sessionId: number) {
  const res = await app.request(`/api/sessions/${sessionId}/transcript`);
  expect(res.status).toBe(200);
  return res.json();
}

function assistantTexts(events: Array<{ type: string; text?: string }>): string[] {
  return events.filter((e) => e.type === 'assistant_text').map((e) => e.text!);
}

/** Waits until the persisted transcript reaches the expected length. */
async function waitForTranscript(app: ReturnType<typeof createApp>, sessionId: number, length: number) {
  await vi.waitFor(async () => {
    const { events } = await fetchTranscript(app, sessionId);
    expect(events.length).toBeGreaterThanOrEqual(length);
  });
}

/** Drains the live SSE stream so the Session finishes before we "restart". */
async function drainEvents(app: ReturnType<typeof createApp>, sessionId: number) {
  await (await app.request(`/api/sessions/${sessionId}/events`)).text();
}

describe('Session persistence across a simulated restart', () => {
  // The simulated restart: a fresh createApp() (new registry, new Agent) over
  // the SAME SQLite handle, as if Sofa had been stopped and started again.
  function restart(db: DatabaseSync, agent: Agent) {
    return createApp(db, agent);
  }

  it('lists past Sessions per Project and serves their transcripts after a restart', async () => {
    const db = openDb(':memory:');
    const app = createApp(db, fakeAgentSaying('First answer.', 'Second answer.'));
    const project = await openProject(app, makeDir());
    const session = await startSession(app, project.id, 'Grill me');
    await drainEvents(app, session.id);

    const reborn = restart(db, new FakeAgent());

    const list = await (await reborn.request(`/api/projects/${project.id}/sessions`)).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: session.id, prompt: 'Grill me', status: 'done' });

    const { session: persisted, events } = await fetchTranscript(reborn, session.id);
    expect(persisted).toMatchObject({ id: session.id, projectId: project.id, status: 'done' });
    expect(assistantTexts(events)).toEqual(['First answer.', 'Second answer.']);
  });

  it('marks an errored Session and keeps its partial transcript', async () => {
    const db = openDb(':memory:');
    const app = createApp(
      db,
      new FakeAgent([
        { type: 'assistant_text', text: 'Starting…' },
        { type: 'agent_error', message: 'something broke' },
      ]),
    );
    const project = await openProject(app, makeDir());
    const session = await startSession(app, project.id, 'Fail please');
    await drainEvents(app, session.id);

    const reborn = restart(db, new FakeAgent());

    const { session: persisted, events } = await fetchTranscript(reborn, session.id);
    expect(persisted.status).toBe('error');
    expect(events).toEqual([
      { type: 'assistant_text', text: 'Starting…' },
      { type: 'agent_error', message: 'something broke' },
    ]);
  });

  it('resumes an interrupted Session after a restart and continues the conversation', async () => {
    const db = openDb(':memory:');
    // Before the "restart": the Agent announces its resume handle, says one
    // thing, then hangs — Sofa goes down mid-Session.
    const before = createApp(
      db,
      new FakeAgent([{ type: 'assistant_text', text: 'Tell me more about the feature.' }], {
        agentSessionId: 'sdk-session-123',
        hang: true,
      }),
    );
    const project = await openProject(before, makeDir());
    const session = await startSession(before, project.id, 'Grill me about Sofa');
    await waitForTranscript(before, session.id, 1);

    const after = new FakeAgent([], {
      resumeScript: [{ type: 'assistant_text', text: 'Welcome back. Where were we?' }],
    });
    const reborn = restart(db, after);

    // The interrupted Session shows up as still 'running' with its handle persisted.
    const list = await (await reborn.request(`/api/projects/${project.id}/sessions`)).json();
    expect(list[0]).toMatchObject({ id: session.id, status: 'running', agentSessionId: 'sdk-session-123' });

    const res = await resumeSession(reborn, session.id, 'We were discussing Sofa');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: session.id, status: 'running' });

    // The Agent was asked to resume by the persisted SDK session id…
    await drainEvents(reborn, session.id);
    expect(after.runs).toEqual([
      { prompt: 'We were discussing Sofa', cwd: project.dir, resume: 'sdk-session-123' },
    ]);

    // …and the continuation lands in the same persisted transcript.
    const { session: persisted, events } = await fetchTranscript(reborn, session.id);
    expect(persisted.status).toBe('done');
    expect(assistantTexts(events)).toEqual([
      'Tell me more about the feature.',
      'Welcome back. Where were we?',
    ]);
  });
});

describe('resume endpoint validation', () => {
  it('returns 404 for an unknown Session', async () => {
    const app = createApp(openDb(':memory:'), new FakeAgent());

    const res = await resumeSession(app, 12345, 'Hello again');

    expect(res.status).toBe(404);
  });

  it('rejects a resume without a prompt', async () => {
    const app = createApp(openDb(':memory:'), fakeAgentSaying('Hi'));
    const project = await openProject(app, makeDir());
    const session = await startSession(app, project.id, 'Hello');

    const res = await app.request(`/api/sessions/${session.id}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it('rejects a resume when the Agent never provided a handle', async () => {
    const app = createApp(openDb(':memory:'), fakeAgentSaying('Hi'));
    const project = await openProject(app, makeDir());
    const session = await startSession(app, project.id, 'Hello');
    await drainEvents(app, session.id);

    const res = await resumeSession(app, session.id, 'Hello again');

    expect(res.status).toBe(409);
  });

  it('returns 404 for the transcript of an unknown Session', async () => {
    const app = createApp(openDb(':memory:'), new FakeAgent());

    const res = await app.request('/api/sessions/12345/transcript');

    expect(res.status).toBe(404);
  });
});
