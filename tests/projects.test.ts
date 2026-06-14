import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { existsSync } from 'node:fs';
import { openDb } from '../src/server/db';
import { createApp, PRD_LABEL, type AppDeps } from '../src/server/app';
import { READY_LABEL } from '../src/server/adapters';
import { FakeAgent } from '../src/server/fake-agent';
import type { ContainerAdapter, GitHubAdapter } from '../src/server/ports';

function makeApp() {
  return createApp(openDb(':memory:'), new FakeAgent());
}

const noopContainer: ContainerAdapter = {
  startWorker() {
    throw new Error('no Worker should start in these tests');
  },
};

/**
 * Fake GitHub adapter that records the labels it was asked to ensure. The
 * `ensure` callback lets a test make the call fail to exercise the non-fatal
 * path.
 */
function fakeGitHub(ensure: (dir: string, labels: string[]) => Promise<void> = () => Promise.resolve()) {
  const ensured: Array<{ dir: string; labels: string[] }> = [];
  const github: GitHubAdapter = {
    resolveRepo: () => Promise.resolve('davbergen/scratch'),
    listReadyIssues: () => Promise.resolve([]),
    createIssue: () => Promise.resolve({ number: 1, url: 'https://github.com/davbergen/scratch/issues/1' }),
    ensureLabels(dir, labels) {
      ensured.push({ dir, labels });
      return ensure(dir, labels);
    },
    getPrState: () => Promise.resolve('OPEN'),
  };
  return { github, ensured };
}

function makeAppWith(github: GitHubAdapter) {
  const deps: AppDeps = { github, container: noopContainer };
  return createApp(openDb(':memory:'), new FakeAgent(), deps);
}

function makeDir(prefix = 'sofa-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function open(app: ReturnType<typeof makeApp>, dir: string) {
  return app.request('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir }),
  });
}

describe('opening a Project', () => {
  it('opens a local directory as a Project', async () => {
    const app = makeApp();
    const dir = makeDir();

    const res = await open(app, dir);

    expect(res.status).toBe(201);
    const project = await res.json();
    expect(project).toMatchObject({ dir, name: basename(dir) });
    expect(project.id).toBeGreaterThan(0);
    expect(project.openedAt).toBeTruthy();
  });

  it('lists open Projects, several at once', async () => {
    const app = makeApp();
    const dirA = makeDir();
    const dirB = makeDir();
    await open(app, dirA);
    await open(app, dirB);

    const res = await app.request('/api/projects');

    expect(res.status).toBe(200);
    const projects = await res.json();
    expect(projects.map((p: { dir: string }) => p.dir)).toEqual([dirA, dirB]);
  });

  it('reopening the same directory is idempotent', async () => {
    const app = makeApp();
    const dir = makeDir();

    const first = await open(app, dir);
    const second = await open(app, dir);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect((await second.json()).id).toBe((await first.json()).id);
    const projects = await (await app.request('/api/projects')).json();
    expect(projects).toHaveLength(1);
  });

  it('rejects a path that is not a directory', async () => {
    const app = makeApp();

    const res = await open(app, join(tmpdir(), 'sofa-does-not-exist-xyz'));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('not a directory');
  });

  it('rejects a missing dir field', async () => {
    const app = makeApp();

    const res = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });
});

describe('ensuring convention labels on open', () => {
  it('ensures the ready-for-agent and prd labels exist when a Project opens', async () => {
    const { github, ensured } = fakeGitHub();
    const app = makeAppWith(github);
    const dir = makeDir();

    const res = await open(app, dir);

    expect(res.status).toBe(201);
    expect(ensured).toEqual([{ dir, labels: [READY_LABEL, PRD_LABEL] }]);
  });

  it('opens the Project even when ensuring labels fails (non-fatal)', async () => {
    const { github, ensured } = fakeGitHub(() => Promise.reject(new Error('gh not authenticated')));
    const app = makeAppWith(github);
    const dir = makeDir();

    const res = await open(app, dir);

    expect(res.status).toBe(201);
    expect((await res.json()).dir).toBe(dir);
    expect(ensured).toHaveLength(1);
  });
});

describe('SQLite store', () => {
  it('creates and migrates the database file on first run, and reopens cleanly', async () => {
    const dbPath = join(makeDir('sofa-db-'), 'nested', 'sofa.db');
    expect(existsSync(dbPath)).toBe(false);

    const db = openDb(dbPath);
    expect(existsSync(dbPath)).toBe(true);

    const projectDir = makeDir();
    await open(createApp(db, new FakeAgent()), projectDir);
    db.close();

    // Second run: migrations are idempotent and data survives.
    const reopened = openDb(dbPath);
    const projects = await (await createApp(reopened, new FakeAgent()).request('/api/projects')).json();
    expect(projects.map((p: { dir: string }) => p.dir)).toEqual([projectDir]);
  });
});
