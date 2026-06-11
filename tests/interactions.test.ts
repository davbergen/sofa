import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/server/db';
import { createApp } from '../src/server/app';
import type { Agent, AgentEvent } from '../src/server/agent';
import { FakeAgent } from '../src/server/fake-agent';

function makeApp(agent: Agent) {
  return createApp(openDb(':memory:'), agent);
}

function makeDir() {
  return mkdtempSync(join(tmpdir(), 'sofa-test-'));
}

async function startSession(app: ReturnType<typeof makeApp>, prompt: string): Promise<number> {
  const projectRes = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir: makeDir() }),
  });
  const project = await projectRes.json();
  const res = await app.request(`/api/projects/${project.id}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  expect(res.status).toBe(201);
  return (await res.json()).id;
}

interface SseEvent {
  event: string;
  data: string;
}

/**
 * Incremental SSE reader: lets a test consume events one at a time while the
 * stream is still open (a pending question/permission blocks the fake Agent,
 * so reading to completion would deadlock).
 */
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

const QUESTION: AgentEvent = {
  type: 'question',
  questionId: 'q1',
  question: 'Which library should we use?',
  options: [
    { label: 'date-fns', description: 'Modular and tree-shakeable' },
    { label: 'dayjs', description: 'Tiny Moment-compatible API' },
  ],
  recommended: 'date-fns',
};

const PERMISSION: AgentEvent = {
  type: 'permission_request',
  requestId: 'p1',
  toolName: 'Bash',
  input: { command: 'rm -rf build' },
};

describe('Agent questions', () => {
  it('streams the question, routes the answer to the Agent, and resumes the Session', async () => {
    const agent = new FakeAgent([QUESTION, { type: 'assistant_text', text: 'Great choice.' }]);
    const app = makeApp(agent);
    const sessionId = await startSession(app, 'Pick a library');

    const sse = openSse(await app.request(`/api/sessions/${sessionId}/events`));
    const question = await sse.until('question');
    expect(JSON.parse(question.data)).toMatchObject({
      questionId: 'q1',
      question: 'Which library should we use?',
      options: [
        { label: 'date-fns', description: 'Modular and tree-shakeable' },
        { label: 'dayjs', description: 'Tiny Moment-compatible API' },
      ],
      recommended: 'date-fns',
    });
    // The Agent is paused on the question: nothing has been answered yet.
    expect(agent.answers).toEqual([]);

    const res = await app.request(`/api/sessions/${sessionId}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: 'q1', answer: 'dayjs' }),
    });
    expect(res.status).toBe(200);
    expect(agent.answers).toEqual([{ questionId: 'q1', answer: 'dayjs' }]);

    // The answer is echoed onto the transcript, then the Agent resumes.
    expect(JSON.parse((await sse.until('question_answer')).data)).toMatchObject({
      questionId: 'q1',
      answer: 'dayjs',
    });
    expect(JSON.parse((await sse.until('assistant_text')).data).text).toBe('Great choice.');
    await sse.until('done');
  });

  it('supports a free-text (Other) answer', async () => {
    const agent = new FakeAgent([QUESTION]);
    const app = makeApp(agent);
    const sessionId = await startSession(app, 'Pick a library');

    const sse = openSse(await app.request(`/api/sessions/${sessionId}/events`));
    await sse.until('question');

    const res = await app.request(`/api/sessions/${sessionId}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: 'q1', answer: 'Just use the built-in Date, no library' }),
    });
    expect(res.status).toBe(200);
    expect(agent.answers).toEqual([
      { questionId: 'q1', answer: 'Just use the built-in Date, no library' },
    ]);
    await sse.until('done');
  });

  it('replays the question and its answer to a late subscriber', async () => {
    const agent = new FakeAgent([QUESTION]);
    const app = makeApp(agent);
    const sessionId = await startSession(app, 'Pick a library');

    const live = openSse(await app.request(`/api/sessions/${sessionId}/events`));
    await live.until('question');
    await app.request(`/api/sessions/${sessionId}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: 'q1', answer: 'date-fns' }),
    });
    await live.until('done');

    const replay = openSse(await app.request(`/api/sessions/${sessionId}/events`));
    await replay.until('question');
    expect(JSON.parse((await replay.until('question_answer')).data).answer).toBe('date-fns');
    await replay.until('done');
  });

  it('rejects an answer without questionId or answer', async () => {
    const agent = new FakeAgent([QUESTION]);
    const app = makeApp(agent);
    const sessionId = await startSession(app, 'Pick a library');

    const res = await app.request(`/api/sessions/${sessionId}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: 'q1' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 answering an unknown Session', async () => {
    const app = makeApp(new FakeAgent());

    const res = await app.request('/api/sessions/12345/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: 'q1', answer: 'x' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('permission requests', () => {
  it('streams the request, waits for the decision, and executes the tool on approve', async () => {
    const agent = new FakeAgent([PERMISSION, { type: 'assistant_text', text: 'Build dir removed.' }]);
    const app = makeApp(agent);
    const sessionId = await startSession(app, 'Clean up');

    const sse = openSse(await app.request(`/api/sessions/${sessionId}/events`));
    const request = await sse.until('permission_request');
    expect(JSON.parse(request.data)).toMatchObject({
      requestId: 'p1',
      toolName: 'Bash',
      input: { command: 'rm -rf build' },
    });
    // Tool execution waits on the decision.
    expect(agent.toolOutcomes.size).toBe(0);

    const res = await app.request(`/api/sessions/${sessionId}/permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'p1', decision: 'allow' }),
    });
    expect(res.status).toBe(200);
    expect(agent.decisions).toEqual([{ requestId: 'p1', decision: 'allow' }]);

    expect(JSON.parse((await sse.until('permission_decision')).data)).toMatchObject({
      requestId: 'p1',
      decision: 'allow',
    });
    expect(JSON.parse((await sse.until('assistant_text')).data).text).toBe('Build dir removed.');
    await sse.until('done');
    expect(agent.toolOutcomes.get('p1')).toBe('executed');
  });

  it('skips the pending tool call on deny', async () => {
    const agent = new FakeAgent([PERMISSION]);
    const app = makeApp(agent);
    const sessionId = await startSession(app, 'Clean up');

    const sse = openSse(await app.request(`/api/sessions/${sessionId}/events`));
    await sse.until('permission_request');

    const res = await app.request(`/api/sessions/${sessionId}/permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'p1', decision: 'deny' }),
    });
    expect(res.status).toBe(200);
    expect(agent.decisions).toEqual([{ requestId: 'p1', decision: 'deny' }]);

    await sse.until('permission_decision');
    await sse.until('done');
    expect(agent.toolOutcomes.get('p1')).toBe('skipped');
  });

  it('rejects a decision that is not allow or deny', async () => {
    const agent = new FakeAgent([PERMISSION]);
    const app = makeApp(agent);
    const sessionId = await startSession(app, 'Clean up');

    const res = await app.request(`/api/sessions/${sessionId}/permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'p1', decision: 'maybe' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 deciding for an unknown Session', async () => {
    const app = makeApp(new FakeAgent());

    const res = await app.request('/api/sessions/12345/permission', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'p1', decision: 'allow' }),
    });
    expect(res.status).toBe(404);
  });
});
