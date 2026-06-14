import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

function makeAppWithTimeout(sessionIdleTimeoutMs: number, agent: Agent = new FakeAgent()) {
  return createApp(openDb(':memory:'), agent, undefined, undefined, { sessionIdleTimeoutMs });
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

async function endSession(
  app: ReturnType<typeof makeApp>,
  sessionId: number,
): Promise<Response> {
  return app.request(`/api/sessions/${sessionId}/end`, { method: 'POST' });
}

describe('ending a Session', () => {
  it('ends a live (hanging) session and marks it done', async () => {
    const agent = new FakeAgent([], { hang: true });
    const app = makeApp(agent);
    const project = await openProject(app, makeDir());
    const session = await (await startSession(app, project.id, 'Stay alive')).json();

    const sse = openSse(await app.request(`/api/sessions/${session.id}/events`));

    const res = await endSession(app, session.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // The stream should close cleanly after the session ends.
    await sse.until('done');

    // The session is persisted as done.
    const stored = await (await app.request(`/api/sessions/${session.id}/transcript`)).json();
    expect(stored.session.status).toBe('done');
  });

  it('ending a session after it finishes is idempotent', async () => {
    const app = makeApp(fakeAgentSaying('Hi.'));
    const project = await openProject(app, makeDir());
    const session = await (await startSession(app, project.id, 'Say hi')).json();

    // Wait for the session to finish naturally.
    await readSse(app, session.id);

    const res = await endSession(app, session.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns 404 for an unknown session', async () => {
    const app = makeApp();
    const res = await endSession(app, 99999);
    expect(res.status).toBe(404);
  });

  it('terminates a session that is awaiting a pending question', async () => {
    const script: FakeAgentStep[] = [
      {
        type: 'question',
        questionId: 'q1',
        question: 'Which colour?',
        options: [{ label: 'red' }, { label: 'blue' }],
      },
      // Never reached: End Session must bail out of the pending wait.
      { type: 'assistant_text', text: 'never spoken' },
    ];
    const app = makeApp(new FakeAgent(script));
    const project = await openProject(app, makeDir());
    const session = await (await startSession(app, project.id, 'Ask me')).json();

    const sse = openSse(await app.request(`/api/sessions/${session.id}/events`));
    await sse.until('question');

    const res = await endSession(app, session.id);
    expect(res.status).toBe(200);

    await sse.until('done');
    const stored = await (await app.request(`/api/sessions/${session.id}/transcript`)).json();
    expect(stored.session.status).toBe('done');
  });

  it('terminates a session that is awaiting a pending permission decision', async () => {
    const script: FakeAgentStep[] = [
      { type: 'permission_request', requestId: 'p1', toolName: 'Bash', input: { cmd: 'rm -rf /' } },
      { type: 'assistant_text', text: 'never spoken' },
    ];
    const app = makeApp(new FakeAgent(script));
    const project = await openProject(app, makeDir());
    const session = await (await startSession(app, project.id, 'Try a tool')).json();

    const sse = openSse(await app.request(`/api/sessions/${session.id}/events`));
    await sse.until('permission_request');

    const res = await endSession(app, session.id);
    expect(res.status).toBe(200);

    await sse.until('done');
    const stored = await (await app.request(`/api/sessions/${session.id}/transcript`)).json();
    expect(stored.session.status).toBe('done');
  });
});

describe('idle-timeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('auto-ends an idle session after the timeout fires', async () => {
    const app = makeAppWithTimeout(1000, new FakeAgent([], { hang: true }));
    const project = await openProject(app, makeDir());
    const session = await (await startSession(app, project.id, 'Stay alive')).json();
    const sse = openSse(await app.request(`/api/sessions/${session.id}/events`));

    await vi.advanceTimersByTimeAsync(1000);

    await sse.until('done');
    const stored = await (await app.request(`/api/sessions/${session.id}/transcript`)).json();
    expect(stored.session.status).toBe('done');
  });

  it('resets the timeout on agent output', async () => {
    const app = makeAppWithTimeout(
      1000,
      new FakeAgent([{ type: 'assistant_text', text: 'Hi.' }], { hang: true }),
    );
    const project = await openProject(app, makeDir());
    const session = await (await startSession(app, project.id, 'Go')).json();
    const sse = openSse(await app.request(`/api/sessions/${session.id}/events`));

    // Let setImmediate fire so the FakeAgent emits its event, resetting the timer.
    await vi.advanceTimersByTimeAsync(0);
    await sse.until('assistant_text');

    // At 999ms from the event (just before the reset timeout would fire): still alive.
    await vi.advanceTimersByTimeAsync(999);
    const mid = await (await app.request(`/api/sessions/${session.id}/transcript`)).json();
    expect(mid.session.status).toBe('running');

    // Now let the reset timeout fire.
    await vi.advanceTimersByTimeAsync(1);
    await sse.until('done');
  });

  it('resets the timeout on user message', async () => {
    const app = makeAppWithTimeout(
      1000,
      new FakeAgent([{ type: 'await_message' }], { hang: true }),
    );
    const project = await openProject(app, makeDir());
    const session = await (await startSession(app, project.id, 'Go')).json();
    openSse(await app.request(`/api/sessions/${session.id}/events`));

    // Advance 500ms (half the timeout), then send a user message to reset the timer.
    await vi.advanceTimersByTimeAsync(500);
    await app.request(`/api/sessions/${session.id}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'still here' }),
    });

    // At 999ms from the message (just under the reset window): still alive.
    await vi.advanceTimersByTimeAsync(999);
    const mid = await (await app.request(`/api/sessions/${session.id}/transcript`)).json();
    expect(mid.session.status).toBe('running');

    // Now the reset timeout fires.
    await vi.advanceTimersByTimeAsync(1);
    const sse2 = openSse(await app.request(`/api/sessions/${session.id}/events`));
    await sse2.until('done');
  });

  it('does not fire if the session ends naturally before the timeout', async () => {
    const app = makeAppWithTimeout(1000, fakeAgentSaying('Hello.'));
    const project = await openProject(app, makeDir());
    const session = await (await startSession(app, project.id, 'Say hi')).json();

    // Let the agent finish naturally (setImmediate + event loop).
    await vi.advanceTimersByTimeAsync(0);

    const events = await readSse(app, session.id);
    expect(events.some((e) => e.event === 'done')).toBe(true);
    const stored = await (await app.request(`/api/sessions/${session.id}/transcript`)).json();
    expect(stored.session.status).toBe('done');
  });
});

describe('Session model selection', () => {
  it('passes the configured session model to the Agent on start', async () => {
    const agent = new FakeAgent();
    const app = makeApp(agent);
    const dir = makeDir();
    const project = await openProject(app, dir);

    await app.request(`/api/projects/${project.id}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionModel: 'haiku' }),
    });

    await startSession(app, project.id, 'Go');

    expect(agent.runs).toEqual([{ prompt: 'Go', cwd: dir, model: 'haiku' }]);
  });

  it('omits the model from the run input when the setting is Default (null)', async () => {
    const agent = new FakeAgent();
    const app = makeApp(agent);
    const project = await openProject(app, makeDir());

    await startSession(app, project.id, 'Go');

    expect(agent.runs[0].model).toBeUndefined();
  });

  it('worker and session models are independent — setting one does not change the other', async () => {
    const agent = new FakeAgent();
    const app = makeApp(agent);
    const project = await openProject(app, makeDir());

    await app.request(`/api/projects/${project.id}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionModel: 'opus' }),
    });

    const res = await app.request(`/api/projects/${project.id}/settings`);
    const settings = await res.json() as { workerModel: string | null; sessionModel: string | null };
    expect(settings.sessionModel).toBe('opus');
    expect(settings.workerModel).toBeNull();
  });

  it('rejects a session model outside the curated alias set and stores nothing', async () => {
    const app = makeApp();
    const project = await openProject(app, makeDir());

    const res = await app.request(`/api/projects/${project.id}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionModel: 'claude-opus-4-7-20251101' }),
    });

    expect(res.status).toBe(422);
    expect((await res.json() as { error?: string }).error).toContain('sessionModel');
    const check = await app.request(`/api/projects/${project.id}/settings`);
    expect((await check.json() as { sessionModel: string | null }).sessionModel).toBeNull();
  });

  it('persists the session model across a server restart', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'sofa-session-model-db-')), 'sofa.db');
    const first = createApp(openDb(dbPath), new FakeAgent());
    const dir = makeDir();
    const project = await (await first.request('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir }),
    })).json();

    await first.request(`/api/projects/${project.id}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionModel: 'sonnet' }),
    });

    const second = createApp(openDb(dbPath), new FakeAgent());
    const res = await second.request(`/api/projects/${project.id}/settings`);
    expect((await res.json() as { sessionModel: string | null }).sessionModel).toBe('sonnet');
  });
});

describe('turn-boundary events', () => {
  it('emits turn_boundary after each scripted turn', async () => {
    const app = makeApp(
      new FakeAgent([
        { type: 'assistant_text', text: 'Hello.' },
        { type: 'turn_boundary' },
      ]),
    );
    const project = await openProject(app, makeDir());
    const session = await (await startSession(app, project.id, 'Go')).json();

    const events = await readSse(app, session.id);
    const types = events.map((e) => e.event);

    expect(types).toContain('turn_boundary');
    const textIdx = types.indexOf('assistant_text');
    const tbIdx = types.indexOf('turn_boundary');
    const doneIdx = types.indexOf('done');
    expect(tbIdx).toBeGreaterThan(textIdx);
    expect(tbIdx).toBeLessThan(doneIdx);
  });

  it('emits turn_boundary between turns in a multi-turn exchange', async () => {
    const script: FakeAgentStep[] = [
      { type: 'assistant_text', text: 'Turn 1.' },
      { type: 'turn_boundary' },
      { type: 'await_message' },
      { type: 'assistant_text', text: 'Turn 2.' },
      { type: 'turn_boundary' },
    ];
    const app = makeApp(new FakeAgent(script));
    const project = await openProject(app, makeDir());
    const session = await (await startSession(app, project.id, 'Start')).json();

    const sse = openSse(await app.request(`/api/sessions/${session.id}/events`));

    await sse.until('assistant_text');
    const tb1 = await sse.until('turn_boundary');
    expect(tb1.event).toBe('turn_boundary');

    await postMessage(app, session.id, 'Continue');
    await sse.until('user_message');
    await sse.until('assistant_text');
    const tb2 = await sse.until('turn_boundary');
    expect(tb2.event).toBe('turn_boundary');

    await sse.until('done');
  });

  it('replays turn_boundary events to a late subscriber', async () => {
    const app = makeApp(
      new FakeAgent([
        { type: 'assistant_text', text: 'Hi.' },
        { type: 'turn_boundary' },
      ]),
    );
    const project = await openProject(app, makeDir());
    const session = await (await startSession(app, project.id, 'Go')).json();

    await readSse(app, session.id);
    const replay = await readSse(app, session.id);

    expect(replay.some((e) => e.event === 'turn_boundary')).toBe(true);
  });
});
