import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/server/db';
import { createApp, type AppDeps } from '../src/server/app';
import { FakeAgent } from '../src/server/fake-agent';
import type { ContainerAdapter, GitHubAdapter, NewIssue } from '../src/server/ports';

function makeDir() {
  return mkdtempSync(join(tmpdir(), 'sofa-pn-'));
}

const noopContainer: ContainerAdapter = {
  startWorker() {
    throw new Error('no Worker should start in these tests');
  },
};

function noopGithub(): GitHubAdapter {
  const created: Array<{ dir: string; issue: NewIssue }> = [];
  return {
    resolveRepo: () => Promise.resolve('davbergen/scratch'),
    listReadyIssues: () => Promise.resolve([]),
    createIssue(dir, issue) {
      created.push({ dir, issue });
      return Promise.resolve({ number: 1, url: 'https://example/1' });
    },
    ensureLabels: () => Promise.resolve(),
    getPrState: () => Promise.resolve('OPEN'),
    listOpenPrsByIssue: () => Promise.resolve([]),
  };
}

function makeApp(agent: FakeAgent) {
  const deps: AppDeps = { github: noopGithub(), container: noopContainer };
  return createApp(openDb(':memory:'), agent, deps);
}

async function openProject(app: ReturnType<typeof makeApp>, dir: string) {
  const res = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir }),
  });
  return res.json();
}

async function dropNote(app: ReturnType<typeof makeApp>, projectId: number, text: string) {
  return app.request(`/api/projects/${projectId}/field-notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

async function getNotes(app: ReturnType<typeof makeApp>, projectId: number) {
  return (await app.request(`/api/projects/${projectId}/field-notes`)).json();
}

async function processNotes(app: ReturnType<typeof makeApp>, projectId: number) {
  return app.request(`/api/projects/${projectId}/process-notes`, { method: 'POST' });
}

/** Builds a triage payload keyed by Item ids, optionally with suggested draft fields. */
function triagePayload(
  map: Record<string, {
    recommendation: 'grill' | 'issue';
    rationale: string;
    suggestedTitle?: string;
    suggestedBody?: string;
  }>,
) {
  return JSON.stringify(map);
}

describe('Process Notes — one-shot triage run', () => {
  it('classifies unacted Items and persists Recommendation + rationale', async () => {
    const agent = new FakeAgent([], {
      oneShot: (input) => {
        // Echo the dispatched skill back through the assertion path.
        const items = JSON.parse(input.prompt) as Array<{ id: string; text: string }>;
        const out: Record<string, { recommendation: 'grill' | 'issue'; rationale: string }> = {};
        for (const item of items) {
          out[item.id] = item.text.includes('grill?')
            ? { recommendation: 'grill', rationale: 'ADR-worthy decision hidden in here.' }
            : { recommendation: 'issue', rationale: 'Self-contained — unambiguous slice.' };
        }
        return { text: triagePayload(out) };
      },
    });
    const app = makeApp(agent);
    const project = await openProject(app, makeDir());
    await dropNote(app, project.id, '1. add a dark mode toggle\n2. session ownership — grill?');

    const res = await processNotes(app, project.id);
    expect(res.status).toBe(200);
    const notes = await res.json();
    expect(notes.items).toHaveLength(2);
    expect(notes.items[0]).toMatchObject({
      recommendation: 'issue',
      rationale: 'Self-contained — unambiguous slice.',
    });
    expect(notes.items[1]).toMatchObject({
      recommendation: 'grill',
      rationale: 'ADR-worthy decision hidden in here.',
    });

    // The skill name and Items were dispatched on the host run.
    expect(agent.oneShotRuns).toHaveLength(1);
    expect(agent.oneShotRuns[0].skill).toBe('triage-field-notes');
    expect(agent.oneShotRuns[0].cwd).toBeTruthy();
  });

  it('only classifies unacted Items — acted ones are untouched', async () => {
    let dispatchedItems: Array<{ id: string; text: string }> = [];
    const agent = new FakeAgent([], {
      oneShot: (input) => {
        dispatchedItems = JSON.parse(input.prompt);
        const out: Record<string, { recommendation: 'grill' | 'issue'; rationale: string }> = {};
        for (const item of dispatchedItems) {
          out[item.id] = { recommendation: 'issue', rationale: 'r' };
        }
        return { text: triagePayload(out) };
      },
    });
    const app = makeApp(agent);
    const project = await openProject(app, makeDir());
    await dropNote(app, project.id, '1. done\n2. todo');

    // Mark the first Item acted via the Issue route so its verdict can never
    // be touched by Process Notes.
    const before = await getNotes(app, project.id);
    const acted = before.items[0];
    await app.request(`/api/projects/${project.id}/field-notes/items/${acted.id}/issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'done', body: acted.text }),
    });

    const res = await processNotes(app, project.id);
    expect(res.status).toBe(200);

    // The Agent was only asked about the unacted Item.
    expect(dispatchedItems).toHaveLength(1);
    expect(dispatchedItems[0].text).toBe('todo');

    const after = await res.json();
    const actedRow = after.items.find((i: { id: number }) => i.id === acted.id);
    const unactedRow = after.items.find((i: { id: number }) => i.id !== acted.id);
    expect(actedRow).toMatchObject({ acted: true, recommendation: null, rationale: null });
    expect(unactedRow).toMatchObject({ acted: false, recommendation: 'issue', rationale: 'r' });
  });

  it('re-running overwrites verdicts on currently-unacted Items', async () => {
    let call = 0;
    const agent = new FakeAgent([], {
      oneShot: (input) => {
        const items = JSON.parse(input.prompt) as Array<{ id: string; text: string }>;
        call++;
        const out: Record<string, { recommendation: 'grill' | 'issue'; rationale: string }> = {};
        for (const item of items) {
          out[item.id] = call === 1
            ? { recommendation: 'grill', rationale: 'first' }
            : { recommendation: 'issue', rationale: 'second' };
        }
        return { text: triagePayload(out) };
      },
    });
    const app = makeApp(agent);
    const project = await openProject(app, makeDir());
    await dropNote(app, project.id, '1. only');

    await processNotes(app, project.id);
    const first = await getNotes(app, project.id);
    expect(first.items[0]).toMatchObject({ recommendation: 'grill', rationale: 'first' });

    await processNotes(app, project.id);
    const second = await getNotes(app, project.id);
    expect(second.items[0]).toMatchObject({ recommendation: 'issue', rationale: 'second' });
  });

  it('uses the Project session_model when set', async () => {
    const agent = new FakeAgent([], {
      oneShot: (input) => {
        const items = JSON.parse(input.prompt) as Array<{ id: string; text: string }>;
        const out: Record<string, { recommendation: 'grill'; rationale: string }> = {};
        for (const item of items) out[item.id] = { recommendation: 'grill', rationale: 'r' };
        return { text: triagePayload(out) };
      },
    });
    const app = makeApp(agent);
    const project = await openProject(app, makeDir());
    await app.request(`/api/projects/${project.id}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionModel: 'opus' }),
    });
    await dropNote(app, project.id, '1. thing');

    const res = await processNotes(app, project.id);
    expect(res.status).toBe(200);
    expect(agent.oneShotRuns[0].model).toBe('opus');
  });

  it('writes no verdicts and returns 502 when the JSON is unparseable', async () => {
    const agent = new FakeAgent([], { oneShot: () => ({ text: 'sorry, I have no idea' }) });
    const app = makeApp(agent);
    const project = await openProject(app, makeDir());
    await dropNote(app, project.id, '1. thing');

    const res = await processNotes(app, project.id);
    expect(res.status).toBe(502);
    const notes = await getNotes(app, project.id);
    expect(notes.items[0]).toMatchObject({ recommendation: null, rationale: null });
  });

  it('writes no verdicts when the JSON has an unexpected id or shape', async () => {
    const agent = new FakeAgent([], {
      oneShot: () => ({
        // Wrong id — not one of the dispatched Items.
        text: JSON.stringify({ '999': { recommendation: 'issue', rationale: 'r' } }),
      }),
    });
    const app = makeApp(agent);
    const project = await openProject(app, makeDir());
    await dropNote(app, project.id, '1. thing');

    const res = await processNotes(app, project.id);
    expect(res.status).toBe(502);
    const notes = await getNotes(app, project.id);
    expect(notes.items[0]).toMatchObject({ recommendation: null, rationale: null });
  });

  it('writes no verdicts when a recommendation is outside the enum', async () => {
    const agent = new FakeAgent([], {
      oneShot: (input) => {
        const items = JSON.parse(input.prompt) as Array<{ id: string }>;
        const out: Record<string, { recommendation: string; rationale: string }> = {};
        for (const item of items) out[item.id] = { recommendation: 'maybe', rationale: 'r' };
        return { text: JSON.stringify(out) };
      },
    });
    const app = makeApp(agent);
    const project = await openProject(app, makeDir());
    await dropNote(app, project.id, '1. thing');

    const res = await processNotes(app, project.id);
    expect(res.status).toBe(502);
    const notes = await getNotes(app, project.id);
    expect(notes.items[0]).toMatchObject({ recommendation: null, rationale: null });
  });

  it('returns 502 with the underlying reason when the Agent throws', async () => {
    const agent = new FakeAgent([], {
      oneShot: () => {
        throw new Error('SDK crashed');
      },
    });
    const app = makeApp(agent);
    const project = await openProject(app, makeDir());
    await dropNote(app, project.id, '1. thing');

    const res = await processNotes(app, project.id);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('SDK crashed');
    const notes = await getNotes(app, project.id);
    expect(notes.items[0]).toMatchObject({ recommendation: null, rationale: null });
  });

  it('is a no-op when there are no unacted Items', async () => {
    const agent = new FakeAgent([], {
      oneShot: () => {
        throw new Error('Agent should not be called');
      },
    });
    const app = makeApp(agent);
    const project = await openProject(app, makeDir());
    // No Items at all, no note dropped — Project has zero unacted Items.
    const res = await processNotes(app, project.id);
    expect(res.status).toBe(200);
    expect(agent.oneShotRuns).toHaveLength(0);
  });

  it('is refused while a Session is holding the host-run slot', async () => {
    // The FakeAgent's `hang` option keeps the Session live so the slot stays
    // held while we attempt the Process Notes call.
    const agent = new FakeAgent([], { hang: true, oneShot: () => ({ text: '{}' }) });
    const app = makeApp(agent);
    const project = await openProject(app, makeDir());

    const sessionRes = await app.request(`/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hold the slot' }),
    });
    expect(sessionRes.status).toBe(201);

    await dropNote(app, project.id, '1. thing');
    const res = await processNotes(app, project.id);
    expect(res.status).toBe(409);
    expect(agent.oneShotRuns).toHaveLength(0);
  });

  it('refuses a Session while a Process Notes run is holding the slot', async () => {
    // Use a oneShot that never resolves so the slot stays held while we attempt
    // a Session start. We don't await Process Notes; we race against it.
    let releaseTriage: (() => void) | null = null;
    const triageBlocked = new Promise<void>((resolve) => {
      releaseTriage = resolve;
    });
    const agent = new FakeAgent([], {
      oneShot: async () => {
        await triageBlocked;
        return { text: '{}' };
      },
    });
    const app = makeApp(agent);
    const project = await openProject(app, makeDir());
    await dropNote(app, project.id, '1. thing');

    const pendingTriage = processNotes(app, project.id);
    // Yield so the endpoint reaches its `await agent.runOneShot(...)`.
    await new Promise((r) => setImmediate(r));

    const sessionRes = await app.request(`/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'try to start' }),
    });
    expect(sessionRes.status).toBe(409);

    releaseTriage!();
    await pendingTriage;
  });

  it('returns 404 for an unknown Project', async () => {
    const agent = new FakeAgent();
    const app = makeApp(agent);
    const res = await processNotes(app, 999);
    expect(res.status).toBe(404);
  });

  it('persists suggestedTitle and suggestedBody when the skill includes them', async () => {
    const agent = new FakeAgent([], {
      oneShot: (input) => {
        const items = JSON.parse(input.prompt) as Array<{ id: string; text: string }>;
        const out: Record<string, object> = {};
        for (const item of items) {
          out[item.id] = {
            recommendation: 'issue',
            rationale: 'Self-contained slice.',
            suggestedTitle: 'Add dark mode toggle',
            suggestedBody: 'Add a toggle to switch between light and dark mode in the settings panel.',
          };
        }
        return { text: triagePayload(out as never) };
      },
    });
    const app = makeApp(agent);
    const project = await openProject(app, makeDir());
    await dropNote(app, project.id, '1. dark mode toggle');

    const res = await processNotes(app, project.id);
    expect(res.status).toBe(200);
    const notes = await res.json();
    expect(notes.items[0]).toMatchObject({
      recommendation: 'issue',
      rationale: 'Self-contained slice.',
      suggestedTitle: 'Add dark mode toggle',
      suggestedBody: 'Add a toggle to switch between light and dark mode in the settings panel.',
    });
  });

  it('succeeds and stores null drafts when the skill omits suggestedTitle and suggestedBody', async () => {
    const agent = new FakeAgent([], {
      oneShot: (input) => {
        const items = JSON.parse(input.prompt) as Array<{ id: string }>;
        const out: Record<string, object> = {};
        for (const item of items) {
          out[item.id] = { recommendation: 'grill', rationale: 'Needs design discussion.' };
        }
        return { text: triagePayload(out as never) };
      },
    });
    const app = makeApp(agent);
    const project = await openProject(app, makeDir());
    await dropNote(app, project.id, '1. something vague');

    const res = await processNotes(app, project.id);
    expect(res.status).toBe(200);
    const notes = await res.json();
    expect(notes.items[0]).toMatchObject({
      recommendation: 'grill',
      rationale: 'Needs design discussion.',
      suggestedTitle: null,
      suggestedBody: null,
    });
  });

  it('suggestedTitle and suggestedBody survive a page reload', async () => {
    const db = openDb(':memory:');
    const agent = new FakeAgent([], {
      oneShot: (input) => {
        const items = JSON.parse(input.prompt) as Array<{ id: string }>;
        const out: Record<string, object> = {};
        for (const item of items) {
          out[item.id] = {
            recommendation: 'issue',
            rationale: 'Clear slice.',
            suggestedTitle: 'Fix header alignment',
            suggestedBody: 'The header is misaligned on mobile viewports.',
          };
        }
        return { text: triagePayload(out as never) };
      },
    });
    const deps = { github: noopGithub(), container: noopContainer };
    const app = createApp(db, agent, deps);
    const project = await openProject(app, makeDir());
    await dropNote(app, project.id, '1. fix header');

    await processNotes(app, project.id);

    // Simulate reload: a fresh app over the same DB.
    const reborn = createApp(db, new FakeAgent(), deps);
    const notes = await getNotes(reborn, project.id);
    expect(notes.items[0]).toMatchObject({
      suggestedTitle: 'Fix header alignment',
      suggestedBody: 'The header is misaligned on mobile viewports.',
    });
  });
});
