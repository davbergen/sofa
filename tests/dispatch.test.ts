import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/server/db';
import { createApp, type AppDeps, type Run } from '../src/server/app';
import type {
  ContainerAdapter,
  GitHubAdapter,
  ReadyIssue,
  StartWorkerOptions,
  WorkerEvent,
} from '../src/server/ports';

const ISSUES: ReadyIssue[] = [
  { number: 7, title: 'Add a thing', url: 'https://github.com/davbergen/scratch/issues/7' },
  { number: 9, title: 'Fix the thing', url: 'https://github.com/davbergen/scratch/issues/9' },
];

function fakeGitHub(issues: ReadyIssue[] = ISSUES) {
  const calls: string[] = [];
  const github: GitHubAdapter = {
    resolveRepo(dir) {
      calls.push(`resolveRepo ${dir}`);
      return Promise.resolve('davbergen/scratch');
    },
    listReadyIssues(dir) {
      calls.push(`listReadyIssues ${dir}`);
      return Promise.resolve(issues);
    },
  };
  return { github, calls };
}

/**
 * Fake Container adapter: records what it was asked to launch and lets the
 * test script lifecycle events through `emit`. Nothing happens until the test
 * says so.
 */
function fakeContainer() {
  const launches: StartWorkerOptions[] = [];
  let onEvent: ((event: WorkerEvent) => void) | null = null;
  const container: ContainerAdapter = {
    startWorker(opts, handler) {
      launches.push(opts);
      onEvent = handler;
    },
  };
  return { container, launches, emit: (event: WorkerEvent) => onEvent?.(event) };
}

function makeHarness(db: DatabaseSync = openDb(':memory:')) {
  const { github, calls: githubCalls } = fakeGitHub();
  const { container, launches, emit } = fakeContainer();
  const deps: AppDeps = { github, container };
  const app = createApp(db, deps);
  return { app, db, githubCalls, launches, emit };
}

async function openProject(app: ReturnType<typeof makeHarness>['app']) {
  const dir = mkdtempSync(join(tmpdir(), 'sofa-dispatch-'));
  const res = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir }),
  });
  const project = await res.json();
  return { dir, project };
}

function dispatch(app: ReturnType<typeof makeHarness>['app'], projectId: number, issue = 7) {
  return app.request(`/api/projects/${projectId}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ issue, title: 'Add a thing' }),
  });
}

async function runs(app: ReturnType<typeof makeHarness>['app'], projectId: number): Promise<Run[]> {
  return (await app.request(`/api/projects/${projectId}/runs`)).json();
}

describe('ready Issues', () => {
  it('lists ready Issues for a Project via the GitHub adapter', async () => {
    const h = makeHarness();
    const { dir, project } = await openProject(h.app);

    const res = await h.app.request(`/api/projects/${project.id}/issues`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(ISSUES);
    expect(h.githubCalls).toContain(`listReadyIssues ${dir}`);
  });

  it('404s for an unknown Project', async () => {
    const h = makeHarness();

    const res = await h.app.request('/api/projects/999/issues');

    expect(res.status).toBe(404);
  });

  it('502s with a reason when the GitHub adapter fails', async () => {
    const failing: GitHubAdapter = {
      resolveRepo: () => Promise.reject(new Error('gh not authenticated')),
      listReadyIssues: () => Promise.reject(new Error('gh not authenticated')),
    };
    const app = createApp(openDb(':memory:'), { github: failing, container: fakeContainer().container });
    const { project } = await openProject(app);

    const res = await app.request(`/api/projects/${project.id}/issues`);

    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('gh not authenticated');
  });
});

describe('dispatching a Worker', () => {
  it('launches a Worker container for the chosen Issue via the Container adapter', async () => {
    const h = makeHarness();
    const { project } = await openProject(h.app);

    const res = await dispatch(h.app, project.id);

    expect(res.status).toBe(201);
    const run = await res.json();
    expect(run).toMatchObject({
      projectId: project.id,
      issue: 7,
      issueTitle: 'Add a thing',
      state: 'cloning',
      prUrl: null,
      failureReason: null,
    });
    expect(run.startedAt).toBeTruthy();
    expect(h.launches).toEqual([{ repo: 'davbergen/scratch', issue: 7 }]);
  });

  it('rejects a non-numeric Issue', async () => {
    const h = makeHarness();
    const { project } = await openProject(h.app);

    const res = await h.app.request(`/api/projects/${project.id}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issue: 'seven' }),
    });

    expect(res.status).toBe(400);
    expect(h.launches).toHaveLength(0);
  });

  it('rejects a second dispatch while a Worker is running, allows one after it finishes', async () => {
    const h = makeHarness();
    const { project } = await openProject(h.app);
    await dispatch(h.app, project.id, 7);

    const second = await dispatch(h.app, project.id, 9);
    expect(second.status).toBe(409);
    expect((await second.json()).error).toContain('already running');
    expect(h.launches).toHaveLength(1);

    h.emit({ type: 'failed', reason: 'agent failed: quota exhausted' });

    const third = await dispatch(h.app, project.id, 9);
    expect(third.status).toBe(201);
    expect(h.launches).toHaveLength(2);
  });

  it('does not record a run when the repository cannot be resolved', async () => {
    const failing: GitHubAdapter = {
      resolveRepo: () => Promise.reject(new Error('no origin remote')),
      listReadyIssues: () => Promise.resolve([]),
    };
    const app = createApp(openDb(':memory:'), { github: failing, container: fakeContainer().container });
    const { project } = await openProject(app);

    const res = await dispatch(app, project.id);

    expect(res.status).toBe(502);
    expect(await runs(app, project.id)).toHaveLength(0);
  });
});

describe('run lifecycle', () => {
  it('tracks each lifecycle state as the Worker progresses to an open PR', async () => {
    const h = makeHarness();
    const { project } = await openProject(h.app);
    await dispatch(h.app, project.id);

    const seen: string[] = [(await runs(h.app, project.id))[0].state];
    for (const phase of ['working', 'pushing'] as const) {
      h.emit({ type: 'phase', phase });
      seen.push((await runs(h.app, project.id))[0].state);
    }
    h.emit({ type: 'succeeded', prUrl: 'https://github.com/davbergen/scratch/pull/12' });

    const final = (await runs(h.app, project.id))[0];
    expect(seen).toEqual(['cloning', 'working', 'pushing']);
    expect(final.state).toBe('pr_open');
    expect(final.prUrl).toBe('https://github.com/davbergen/scratch/pull/12');
    expect(final.failureReason).toBeNull();
  });

  it('records the failure reason when the Worker fails', async () => {
    const h = makeHarness();
    const { project } = await openProject(h.app);
    await dispatch(h.app, project.id);
    h.emit({ type: 'phase', phase: 'working' });

    h.emit({ type: 'failed', reason: 'git push failed (exit 128): remote: permission denied' });

    const run = (await runs(h.app, project.id))[0];
    expect(run.state).toBe('failed');
    expect(run.failureReason).toBe('git push failed (exit 128): remote: permission denied');
    expect(run.prUrl).toBeNull();
  });

  it('ignores stale events after a run reaches a terminal state', async () => {
    const h = makeHarness();
    const { project } = await openProject(h.app);
    await dispatch(h.app, project.id);
    h.emit({ type: 'failed', reason: 'docker died' });

    h.emit({ type: 'phase', phase: 'pushing' });
    h.emit({ type: 'succeeded', prUrl: 'https://example.com/pr/1' });

    const run = (await runs(h.app, project.id))[0];
    expect(run.state).toBe('failed');
    expect(run.failureReason).toBe('docker died');
  });

  it('lists runs newest-first per Project', async () => {
    const h = makeHarness();
    const { project } = await openProject(h.app);
    await dispatch(h.app, project.id, 7);
    h.emit({ type: 'succeeded', prUrl: 'https://example.com/pr/1' });
    await dispatch(h.app, project.id, 9);

    const list = await runs(h.app, project.id);

    expect(list.map((r) => r.issue)).toEqual([9, 7]);
  });
});

describe('persistence across restarts', () => {
  it('run records survive a server restart; interrupted runs are marked failed and free the slot', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'sofa-runs-db-')), 'sofa.db');
    const first = makeHarness(openDb(dbPath));
    const { project } = await openProject(first.app);
    await dispatch(first.app, project.id, 7);
    first.emit({ type: 'phase', phase: 'working' });
    first.db.close();

    // "Restart": a fresh app over the same database file.
    const second = makeHarness(openDb(dbPath));
    const survived = await runs(second.app, project.id);
    expect(survived).toHaveLength(1);
    expect(survived[0]).toMatchObject({
      issue: 7,
      state: 'failed',
      failureReason: 'interrupted by server restart',
    });

    // The orphaned run no longer blocks dispatch.
    const res = await dispatch(second.app, project.id, 9);
    expect(res.status).toBe(201);
  });

  it('terminal runs keep their outcome across restarts', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'sofa-runs-db-')), 'sofa.db');
    const first = makeHarness(openDb(dbPath));
    const { project } = await openProject(first.app);
    await dispatch(first.app, project.id, 7);
    first.emit({ type: 'succeeded', prUrl: 'https://github.com/davbergen/scratch/pull/12' });
    first.db.close();

    const second = makeHarness(openDb(dbPath));
    const survived = await runs(second.app, project.id);

    expect(survived[0]).toMatchObject({
      state: 'pr_open',
      prUrl: 'https://github.com/davbergen/scratch/pull/12',
    });
  });
});
