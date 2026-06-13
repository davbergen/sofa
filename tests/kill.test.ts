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

/**
 * Fake Container adapter for the kill switch: records each launch's stop()
 * calls so tests can assert the container was actually stopped, and lets the
 * test script lifecycle events through `emit`.
 */
function fakeContainer() {
  const launches: StartWorkerOptions[] = [];
  const stops: number[] = [];
  let onEvent: ((event: WorkerEvent) => void) | null = null;
  const container: ContainerAdapter = {
    startWorker(opts, handler) {
      const launchIndex = launches.length;
      launches.push(opts);
      onEvent = handler;
      return {
        stop() {
          stops.push(launchIndex);
          return Promise.resolve();
        },
      };
    },
  };
  return { container, launches, stops, emit: (event: WorkerEvent) => onEvent?.(event) };
}

function makeHarness() {
  const { container, launches, stops, emit } = fakeContainer();
  const deps: AppDeps = { github, container };
  const app = createApp(openDb(':memory:'), new FakeAgent(), deps);
  return { app, launches, stops, emit };
}

async function openProject(app: ReturnType<typeof makeHarness>['app']) {
  const dir = mkdtempSync(join(tmpdir(), 'sofa-kill-'));
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

function kill(app: ReturnType<typeof makeHarness>['app'], runId: number) {
  return app.request(`/api/runs/${runId}/kill`, { method: 'POST' });
}

async function runs(app: ReturnType<typeof makeHarness>['app'], projectId: number): Promise<Run[]> {
  return (await app.request(`/api/projects/${projectId}/runs`)).json();
}

describe('killing a running Worker', () => {
  it('stops the container and marks the run killed by user', async () => {
    const h = makeHarness();
    const project = await openProject(h.app);
    const run = (await (await dispatch(h.app, project.id)).json()) as Run;
    h.emit({ type: 'phase', phase: 'working' });

    const res = await kill(h.app, run.id);

    expect(res.status).toBe(200);
    expect(h.stops).toEqual([0]);
    expect(await res.json()).toMatchObject({
      id: run.id,
      state: 'killed',
      failureReason: 'killed by user',
      prUrl: null,
    });
    expect((await runs(h.app, project.id))[0]).toMatchObject({
      state: 'killed',
      failureReason: 'killed by user',
    });
  });

  it('frees the Worker slot: the Project is dispatchable again after a kill', async () => {
    const h = makeHarness();
    const project = await openProject(h.app);
    const run = (await (await dispatch(h.app, project.id, 7)).json()) as Run;

    const blocked = await dispatch(h.app, project.id, 9);
    expect(blocked.status).toBe(409);

    await kill(h.app, run.id);

    const after = await dispatch(h.app, project.id, 9);
    expect(after.status).toBe(201);
    expect(h.launches.map((l) => l.issue)).toEqual([7, 9]);
  });

  it('ignores straggler events from the dying container after a kill', async () => {
    const h = makeHarness();
    const project = await openProject(h.app);
    const run = (await (await dispatch(h.app, project.id)).json()) as Run;
    await kill(h.app, run.id);

    h.emit({ type: 'failed', reason: 'worker exited 137 without a parseable outcome line' });
    h.emit({ type: 'succeeded', prUrl: 'https://example.com/pr/1' });

    expect((await runs(h.app, project.id))[0]).toMatchObject({
      state: 'killed',
      failureReason: 'killed by user',
      prUrl: null,
    });
  });

  it('404s for an unknown run', async () => {
    const h = makeHarness();

    const res = await kill(h.app, 999);

    expect(res.status).toBe(404);
  });

  it('409s when the run is already terminal and does not stop anything', async () => {
    const h = makeHarness();
    const project = await openProject(h.app);
    const run = (await (await dispatch(h.app, project.id)).json()) as Run;
    h.emit({ type: 'succeeded', prUrl: 'https://example.com/pr/1' });

    const res = await kill(h.app, run.id);

    expect(res.status).toBe(409);
    expect(h.stops).toEqual([]);
    expect((await runs(h.app, project.id))[0].state).toBe('pr_open');
  });
});
