import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/server/db';
import { createApp, type AppDeps, type Run } from '../src/server/app';
import { FakeAgent } from '../src/server/fake-agent';
import type {
  ContainerAdapter,
  GitHubAdapter,
  StartWorkerOptions,
  WorkerEvent,
} from '../src/server/ports';

const github: GitHubAdapter = {
  resolveRepo: () => Promise.resolve('davbergen/scratch'),
  listReadyIssues: () => Promise.resolve([]),
  createIssue: () => Promise.resolve({ number: 1, url: 'https://github.com/davbergen/scratch/issues/1' }),
  ensureLabels: () => Promise.resolve(),
};

function fakeContainer() {
  const launches: StartWorkerOptions[] = [];
  let onEvent: ((event: WorkerEvent) => void) | null = null;
  const container: ContainerAdapter = {
    startWorker(opts, handler) {
      launches.push(opts);
      onEvent = handler;
      return { stop: () => Promise.resolve() };
    },
  };
  return { container, launches, emit: (event: WorkerEvent) => onEvent?.(event) };
}

function makeHarness() {
  const { container, emit } = fakeContainer();
  const deps: AppDeps = { github, container };
  const db = openDb(':memory:');
  const app = createApp(db, new FakeAgent(), deps);
  return { app, db, emit };
}

async function openProject(app: ReturnType<typeof makeHarness>['app']) {
  const dir = mkdtempSync(join(tmpdir(), 'sofa-remove-'));
  const res = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir }),
  });
  return (await res.json()) as { id: number };
}

function dispatch(app: ReturnType<typeof makeHarness>['app'], projectId: number, issue = 7) {
  return app.request(`/api/projects/${projectId}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ issue, title: 'Add a thing' }),
  });
}

function remove(app: ReturnType<typeof makeHarness>['app'], runId: number) {
  return app.request(`/api/runs/${runId}`, { method: 'DELETE' });
}

async function runs(app: ReturnType<typeof makeHarness>['app'], projectId: number): Promise<Run[]> {
  return (await app.request(`/api/projects/${projectId}/runs`)).json();
}

const SUCCESS_USAGE = {
  inputTokens: 10,
  outputTokens: 20,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

describe('removing a past Worker run', () => {
  it('deletes a terminal pr_open run and its usage row', async () => {
    const h = makeHarness();
    const project = await openProject(h.app);
    const run = (await (await dispatch(h.app, project.id)).json()) as Run;
    h.emit({ type: 'succeeded', prUrl: 'https://example.com/pr/1', usage: SUCCESS_USAGE });

    const res = await remove(h.app, run.id);

    expect(res.status).toBe(204);
    expect(await runs(h.app, project.id)).toEqual([]);
    const usageRows = h.db
      .prepare('SELECT COUNT(*) AS n FROM token_usage WHERE run_id = ?')
      .get(run.id) as { n: number };
    expect(usageRows.n).toBe(0);
  });

  it('deletes a failed run', async () => {
    const h = makeHarness();
    const project = await openProject(h.app);
    const run = (await (await dispatch(h.app, project.id)).json()) as Run;
    h.emit({ type: 'failed', reason: 'something blew up' });

    const res = await remove(h.app, run.id);

    expect(res.status).toBe(204);
    expect(await runs(h.app, project.id)).toEqual([]);
  });

  it('deletes a killed run', async () => {
    const h = makeHarness();
    const project = await openProject(h.app);
    const run = (await (await dispatch(h.app, project.id)).json()) as Run;
    await h.app.request(`/api/runs/${run.id}/kill`, { method: 'POST' });

    const res = await remove(h.app, run.id);

    expect(res.status).toBe(204);
    expect(await runs(h.app, project.id)).toEqual([]);
  });

  it('survives across an app restart (record is gone from disk, not just memory)', async () => {
    const h = makeHarness();
    const project = await openProject(h.app);
    const run = (await (await dispatch(h.app, project.id)).json()) as Run;
    h.emit({ type: 'succeeded', prUrl: 'https://example.com/pr/1' });
    await remove(h.app, run.id);

    // A fresh app over the same DB sees no record.
    const app2 = createApp(h.db, new FakeAgent(), { github, container: fakeContainer().container });
    const remaining = (await (await app2.request(`/api/projects/${project.id}/runs`)).json()) as Run[];
    expect(remaining).toEqual([]);
  });

  it('refuses to remove an active run (409) and leaves the record intact', async () => {
    const h = makeHarness();
    const project = await openProject(h.app);
    const run = (await (await dispatch(h.app, project.id)).json()) as Run;
    h.emit({ type: 'phase', phase: 'working' });

    const res = await remove(h.app, run.id);

    expect(res.status).toBe(409);
    expect((await runs(h.app, project.id))[0]).toMatchObject({ id: run.id, state: 'working' });
  });

  it('404s for an unknown run', async () => {
    const h = makeHarness();
    const res = await remove(h.app, 999);
    expect(res.status).toBe(404);
  });

  it('only removes the targeted run — other Projects and runs are untouched', async () => {
    const h = makeHarness();
    const a = await openProject(h.app);
    const b = await openProject(h.app);
    const runA = (await (await dispatch(h.app, a.id, 7)).json()) as Run;
    h.emit({ type: 'succeeded', prUrl: 'https://example.com/pr/a', usage: SUCCESS_USAGE });
    const runB = (await (await dispatch(h.app, b.id, 8)).json()) as Run;
    h.emit({ type: 'succeeded', prUrl: 'https://example.com/pr/b', usage: SUCCESS_USAGE });

    const res = await remove(h.app, runA.id);
    expect(res.status).toBe(204);

    expect(await runs(h.app, a.id)).toEqual([]);
    expect((await runs(h.app, b.id))[0]).toMatchObject({ id: runB.id, state: 'pr_open' });
    const usageRows = h.db
      .prepare('SELECT COUNT(*) AS n FROM token_usage WHERE run_id = ?')
      .get(runB.id) as { n: number };
    expect(usageRows.n).toBe(1);
  });
});
