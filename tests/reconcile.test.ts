import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/server/db';
import { createApp, type AppDeps, type Run } from '../src/server/app';
import { FakeAgent } from '../src/server/fake-agent';
import { applyPrState, type RunState } from '../src/server/runs';
import type {
  ContainerAdapter,
  GitHubAdapter,
  StartWorkerOptions,
  WorkerEvent,
} from '../src/server/ports';

type PrState = 'OPEN' | 'MERGED' | 'CLOSED';
type OpenPr = { issue: number; prNumber: number; prUrl: string };

function makeGitHub(
  prStateByUrl: Map<string, PrState | Error>,
  openPrs: OpenPr[] | Error = [],
) {
  const lookups: Array<{ dir: string; prUrl: string }> = [];
  const openPrLookups: string[] = [];
  const github: GitHubAdapter = {
    resolveRepo: () => Promise.resolve('davbergen/scratch'),
    listReadyIssues: () => Promise.resolve([]),
    createIssue: () => Promise.resolve({ number: 1, url: 'https://example.com/issues/1' }),
    ensureLabels: () => Promise.resolve(),
    getPrState(dir, prUrl) {
      lookups.push({ dir, prUrl });
      const result = prStateByUrl.get(prUrl);
      if (result instanceof Error) return Promise.reject(result);
      if (!result) return Promise.reject(new Error(`no fake state for ${prUrl}`));
      return Promise.resolve(result);
    },
    listOpenPrsByIssue(dir) {
      openPrLookups.push(dir);
      if (openPrs instanceof Error) return Promise.reject(openPrs);
      return Promise.resolve(openPrs);
    },
  };
  return { github, lookups, openPrLookups };
}

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

function makeHarness(
  prStateByUrl: Map<string, PrState | Error> = new Map(),
  openPrs: OpenPr[] | Error = [],
) {
  const { github, lookups, openPrLookups } = makeGitHub(prStateByUrl, openPrs);
  const { container, emit } = fakeContainer();
  const deps: AppDeps = { github, container };
  const app = createApp(openDb(':memory:'), new FakeAgent(), deps);
  return { app, lookups, openPrLookups, emit };
}

async function openProject(app: ReturnType<typeof makeHarness>['app']) {
  const dir = mkdtempSync(join(tmpdir(), 'sofa-reconcile-'));
  const res = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir }),
  });
  return { dir, project: await res.json() };
}

async function dispatchAndOpenPr(
  app: ReturnType<typeof makeHarness>['app'],
  emit: ReturnType<typeof makeHarness>['emit'],
  projectId: number,
  issue: number,
  prUrl: string,
): Promise<Run> {
  await app.request(`/api/projects/${projectId}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ issue, title: `Issue ${issue}` }),
  });
  emit({ type: 'succeeded', prUrl });
  const runs = (await (await app.request(`/api/projects/${projectId}/runs`)).json()) as Run[];
  return runs[0];
}

describe('applyPrState', () => {
  it('advances pr_open to pr_merged on MERGED and pr_closed on CLOSED, holds on OPEN', () => {
    expect(applyPrState('pr_open', 'MERGED')).toEqual({ state: 'pr_merged' });
    expect(applyPrState('pr_open', 'CLOSED')).toEqual({ state: 'pr_closed' });
    expect(applyPrState('pr_open', 'OPEN')).toBeNull();
  });

  it('refuses to move any state other than pr_open', () => {
    const others: RunState[] = ['cloning', 'working', 'pushing', 'pr_merged', 'pr_closed', 'failed', 'killed'];
    for (const s of others) {
      expect(applyPrState(s, 'MERGED')).toBeNull();
      expect(applyPrState(s, 'CLOSED')).toBeNull();
      expect(applyPrState(s, 'OPEN')).toBeNull();
    }
  });
});

describe('POST /api/projects/:id/reconcile', () => {
  it('advances pr_open runs to pr_merged or pr_closed based on GitHub PR state', async () => {
    const prStates = new Map<string, PrState>([
      ['https://example.com/pr/7', 'MERGED'],
      ['https://example.com/pr/9', 'CLOSED'],
      ['https://example.com/pr/11', 'OPEN'],
    ]);
    const h = makeHarness(prStates);
    const { project } = await openProject(h.app);
    await dispatchAndOpenPr(h.app, h.emit, project.id, 7, 'https://example.com/pr/7');
    await dispatchAndOpenPr(h.app, h.emit, project.id, 9, 'https://example.com/pr/9');
    await dispatchAndOpenPr(h.app, h.emit, project.id, 11, 'https://example.com/pr/11');

    const res = await h.app.request(`/api/projects/${project.id}/reconcile`, { method: 'POST' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: Run[]; issuesWithOpenPr: OpenPr[] };
    const byIssue = new Map(body.runs.map((r) => [r.issue, r.state]));
    expect(byIssue.get(7)).toBe('pr_merged');
    expect(byIssue.get(9)).toBe('pr_closed');
    expect(byIssue.get(11)).toBe('pr_open');
    // Every pr_open candidate was looked up; reconciling already-terminal records would be wasted.
    expect(h.lookups.map((l) => l.prUrl).sort()).toEqual([
      'https://example.com/pr/11',
      'https://example.com/pr/7',
      'https://example.com/pr/9',
    ]);
  });

  it('only revisits pr_open runs — terminal records are not re-queried on a second pass', async () => {
    const h = makeHarness(new Map<string, PrState>([['https://example.com/pr/7', 'MERGED']]));
    const { project } = await openProject(h.app);
    await dispatchAndOpenPr(h.app, h.emit, project.id, 7, 'https://example.com/pr/7');

    await h.app.request(`/api/projects/${project.id}/reconcile`, { method: 'POST' });
    expect(h.lookups).toHaveLength(1);

    // Second pass: the run is pr_merged now, so reconcile must not call gh again.
    await h.app.request(`/api/projects/${project.id}/reconcile`, { method: 'POST' });
    expect(h.lookups).toHaveLength(1);
  });

  it('502s with a reason when gh fails and leaves run state unchanged (fail-soft)', async () => {
    const failure = new Error('gh not authenticated');
    const h = makeHarness(new Map([['https://example.com/pr/7', failure]]));
    const { project } = await openProject(h.app);
    await dispatchAndOpenPr(h.app, h.emit, project.id, 7, 'https://example.com/pr/7');

    const res = await h.app.request(`/api/projects/${project.id}/reconcile`, { method: 'POST' });

    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('gh not authenticated');
    const runs = (await (await h.app.request(`/api/projects/${project.id}/runs`)).json()) as Run[];
    expect(runs[0].state).toBe('pr_open');
  });

  it('404s for an unknown Project', async () => {
    const h = makeHarness();
    const res = await h.app.request('/api/projects/999/reconcile', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('returns the set of open PRs keyed by issue number so Dispatch can be greyed out', async () => {
    const openPrs: OpenPr[] = [
      { issue: 7, prNumber: 101, prUrl: 'https://example.com/pr/101' },
      { issue: 9, prNumber: 102, prUrl: 'https://example.com/pr/102' },
    ];
    const h = makeHarness(new Map(), openPrs);
    const { project } = await openProject(h.app);

    const res = await h.app.request(`/api/projects/${project.id}/reconcile`, { method: 'POST' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: Run[]; issuesWithOpenPr: OpenPr[] };
    expect(body.issuesWithOpenPr).toEqual(openPrs);
    expect(body.runs).toEqual([]);
    expect(h.openPrLookups).toHaveLength(1);
  });

  it('502s when listing open PRs fails and leaves run state unchanged', async () => {
    // The pr_open run's `getPrState` returns OPEN, so the first pass is a
    // no-op and the failure surfaces from the open-PR list step alone.
    const prStates = new Map<string, PrState>([['https://example.com/pr/7', 'OPEN']]);
    const h = makeHarness(prStates, new Error('gh pr list failed (exit 4)'));
    const { project } = await openProject(h.app);
    await dispatchAndOpenPr(h.app, h.emit, project.id, 7, 'https://example.com/pr/7');

    const res = await h.app.request(`/api/projects/${project.id}/reconcile`, { method: 'POST' });

    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('gh pr list failed');
    const runs = (await (await h.app.request(`/api/projects/${project.id}/runs`)).json()) as Run[];
    expect(runs[0].state).toBe('pr_open');
  });
});
