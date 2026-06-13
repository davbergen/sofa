import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/server/db';
import { createApp } from '../src/server/app';
import type { Agent } from '../src/server/agent';
import { FakeAgent, fakeAgentSaying, type FakeAgentStep } from '../src/server/fake-agent';
import { docWriteFromToolUse } from '../src/server/doc-writes';

function makeApp(agent: Agent = new FakeAgent()) {
  return createApp(openDb(':memory:'), agent);
}

function makeDir() {
  return mkdtempSync(join(tmpdir(), 'sofa-test-'));
}

async function openProject(app: ReturnType<typeof makeApp>, dir: string) {
  const res = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir }),
  });
  return res.json();
}

async function startSession(app: ReturnType<typeof makeApp>, projectId: number, prompt: string) {
  return app.request(`/api/projects/${projectId}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
}

interface SseEvent {
  event: string;
  data: string;
}

/** Reads the whole SSE stream (the fake Agent finishes, so the stream closes). */
async function readSse(app: ReturnType<typeof makeApp>, sessionId: number): Promise<SseEvent[]> {
  const res = await app.request(`/api/sessions/${sessionId}/events`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const text = await res.text();
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

describe('starting a Session', () => {
  it('starts a Session for an open Project', async () => {
    const app = makeApp();
    const project = await openProject(app, makeDir());

    const res = await startSession(app, project.id, 'Say hello');

    expect(res.status).toBe(201);
    const session = await res.json();
    expect(session).toMatchObject({ projectId: project.id, prompt: 'Say hello' });
    expect(session.id).toBeGreaterThan(0);
    expect(session.startedAt).toBeTruthy();
  });

  it('runs the Agent against the Project working copy', async () => {
    const agent = new FakeAgent();
    const app = makeApp(agent);
    const dir = makeDir();
    const project = await openProject(app, dir);

    await startSession(app, project.id, 'Look around');

    expect(agent.runs).toEqual([{ prompt: 'Look around', cwd: dir }]);
  });

  it('loads a named skill into the Session and records it', async () => {
    const agent = new FakeAgent();
    const app = makeApp(agent);
    const dir = makeDir();
    const project = await openProject(app, dir);

    const res = await app.request(`/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Grill me', skill: 'grilling' }),
    });

    expect(res.status).toBe(201);
    expect((await res.json()).skill).toBe('grilling');
    expect(agent.runs).toEqual([{ prompt: 'Grill me', cwd: dir, skill: 'grilling' }]);
  });

  it('rejects a Session for an unknown Project', async () => {
    const app = makeApp();

    const res = await startSession(app, 999, 'Say hello');

    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain('999');
  });

  it('rejects a Session without a prompt', async () => {
    const app = makeApp();
    const project = await openProject(app, makeDir());

    const res = await app.request(`/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });
});

describe('streaming the Session transcript', () => {
  it('streams scripted assistant messages as SSE events, then done', async () => {
    const app = makeApp(fakeAgentSaying('First message.', 'Second message.'));
    const project = await openProject(app, makeDir());
    const session = await (await startSession(app, project.id, 'Talk to me')).json();

    const events = await readSse(app, session.id);

    const texts = events
      .filter((e) => e.event === 'assistant_text')
      .map((e) => JSON.parse(e.data).text);
    expect(texts).toEqual(['First message.', 'Second message.']);
    expect(events.at(-1)?.event).toBe('done');
  });

  it('replays the full transcript to a late subscriber', async () => {
    const app = makeApp(fakeAgentSaying('One', 'Two'));
    const project = await openProject(app, makeDir());
    const session = await (await startSession(app, project.id, 'Talk to me')).json();

    // First read drains the live stream to completion…
    await readSse(app, session.id);
    // …a second subscriber still gets the whole transcript.
    const replay = await readSse(app, session.id);

    const texts = replay
      .filter((e) => e.event === 'assistant_text')
      .map((e) => JSON.parse(e.data).text);
    expect(texts).toEqual(['One', 'Two']);
    expect(replay.at(-1)?.event).toBe('done');
  });

  it('surfaces Agent errors as agent_error events', async () => {
    const app = makeApp(
      new FakeAgent([
        { type: 'assistant_text', text: 'Starting…' },
        { type: 'agent_error', message: 'something broke' },
      ]),
    );
    const project = await openProject(app, makeDir());
    const session = await (await startSession(app, project.id, 'Fail please')).json();

    const events = await readSse(app, session.id);

    const errors = events.filter((e) => e.event === 'agent_error').map((e) => JSON.parse(e.data).message);
    expect(errors).toEqual(['something broke']);
    expect(events.at(-1)?.event).toBe('done');
  });

  it('returns 404 for an unknown Session', async () => {
    const app = makeApp();

    const res = await app.request('/api/sessions/12345/events');

    expect(res.status).toBe(404);
  });
});

describe('surfacing doc writes', () => {
  it('streams scripted file-write tool calls as file_write events', async () => {
    // A Grilling Session capturing decisions: the fake Agent scripts the
    // file-write tool calls a real Session would make to CONTEXT.md and an ADR.
    const app = makeApp(
      new FakeAgent([
        { type: 'assistant_text', text: 'Capturing the decision…' },
        { type: 'file_write', path: 'CONTEXT.md', toolName: 'Write' },
        { type: 'file_write', path: 'docs/adr/0001-use-sqlite.md', toolName: 'Write' },
        { type: 'assistant_text', text: 'Documented.' },
      ]),
    );
    const project = await openProject(app, makeDir());
    const session = await (await startSession(app, project.id, 'Grill me')).json();

    const events = await readSse(app, session.id);

    const writes = events.filter((e) => e.event === 'file_write').map((e) => JSON.parse(e.data));
    expect(writes).toEqual([
      { type: 'file_write', path: 'CONTEXT.md', toolName: 'Write' },
      { type: 'file_write', path: 'docs/adr/0001-use-sqlite.md', toolName: 'Write' },
    ]);
    expect(events.at(-1)?.event).toBe('done');
  });

  it('derives file_write events from tool-use blocks that touch the living documents', () => {
    expect(docWriteFromToolUse('Write', { file_path: 'C:\\proj\\CONTEXT.md' })).toEqual({
      type: 'file_write',
      path: 'C:\\proj\\CONTEXT.md',
      toolName: 'Write',
    });
    expect(docWriteFromToolUse('Edit', { file_path: '/proj/docs/adr/0002-x.md' })).toMatchObject({
      type: 'file_write',
      path: '/proj/docs/adr/0002-x.md',
    });
    // Writes elsewhere, non-write tools, and malformed input stay silent.
    expect(docWriteFromToolUse('Write', { file_path: '/proj/src/index.ts' })).toBeNull();
    expect(docWriteFromToolUse('Read', { file_path: '/proj/CONTEXT.md' })).toBeNull();
    expect(docWriteFromToolUse('Write', {})).toBeNull();
  });
});

/** Incremental SSE reader that works with a paused (not-yet-finished) Agent. */
function openSse(res: Response) {
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const queue: Array<{ event: string; data: string }> = [];

  async function next(): Promise<{ event: string; data: string }> {
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

  async function until(eventType: string): Promise<{ event: string; data: string }> {
    for (;;) {
      const event = await next();
      if (event.event === eventType) return event;
    }
  }

  return { until };
}

async function postMessage(
  app: ReturnType<typeof makeApp>,
  sessionId: number,
  text: string,
): Promise<Response> {
  return app.request(`/api/sessions/${sessionId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

describe('multi-turn conversation', () => {
  it('delivers a follow-up message and streams both turns in the transcript', async () => {
    const script: FakeAgentStep[] = [
      { type: 'assistant_text', text: 'Turn 1 response.' },
      { type: 'await_message' },
      { type: 'assistant_text', text: 'Turn 2 response.' },
    ];
    const app = makeApp(new FakeAgent(script));
    const project = await openProject(app, makeDir());
    const session = await (await startSession(app, project.id, 'Start')).json();

    const sse = openSse(await app.request(`/api/sessions/${session.id}/events`));

    // Wait for the first turn response, then send a follow-up.
    await sse.until('assistant_text');
    const res = await postMessage(app, session.id, 'Continue please.');
    expect(res.status).toBe(200);

    // The follow-up is echoed as a user_message event, then the second turn arrives.
    const userMsg = await sse.until('user_message');
    expect(JSON.parse(userMsg.data).text).toBe('Continue please.');
    const turn2 = await sse.until('assistant_text');
    expect(JSON.parse(turn2.data).text).toBe('Turn 2 response.');
    await sse.until('done');
  });

  it('supports more than one follow-up in sequence', async () => {
    const script: FakeAgentStep[] = [
      { type: 'assistant_text', text: 'First.' },
      { type: 'await_message' },
      { type: 'assistant_text', text: 'Second.' },
      { type: 'await_message' },
      { type: 'assistant_text', text: 'Third.' },
    ];
    const app = makeApp(new FakeAgent(script));
    const project = await openProject(app, makeDir());
    const session = await (await startSession(app, project.id, 'Go')).json();

    const sse = openSse(await app.request(`/api/sessions/${session.id}/events`));

    await sse.until('assistant_text');
    await postMessage(app, session.id, 'Reply 1');
    await sse.until('user_message');
    await sse.until('assistant_text');
    await postMessage(app, session.id, 'Reply 2');
    await sse.until('user_message');
    const last = await sse.until('assistant_text');
    expect(JSON.parse(last.data).text).toBe('Third.');
    await sse.until('done');
  });
});
