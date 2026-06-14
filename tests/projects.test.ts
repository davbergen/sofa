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

function makeAppWithDb(agent?: FakeAgent) {
  const db = openDb(':memory:');
  const app = createApp(db, agent ?? new FakeAgent());
  return { app, db };
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
    listOpenPrsByIssue: () => Promise.resolve([]),
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

describe('closing a Project', () => {
  it('removes the Project from the list and returns 204', async () => {
    const app = makeApp();
    const dir = makeDir();
    const opened = await (await open(app, dir)).json();

    const res = await app.request(`/api/projects/${opened.id}`, { method: 'DELETE' });

    expect(res.status).toBe(204);
    const list = await (await app.request('/api/projects')).json();
    expect(list).toHaveLength(0);
  });

  it('returns 404 for a non-existent Project', async () => {
    const app = makeApp();

    const res = await app.request('/api/projects/9999', { method: 'DELETE' });

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBeTruthy();
  });

  it('returns 409 while an active Worker run exists', async () => {
    const { app, db } = makeAppWithDb();
    const dir = makeDir();
    const opened = await (await open(app, dir)).json();

    // Insert an active worker_run directly — avoids needing a real container adapter.
    db
      .prepare("INSERT INTO worker_runs (project_id, issue_number, issue_title, state) VALUES (?, 1, 'test', 'cloning')")
      .run(opened.id);

    const res = await app.request(`/api/projects/${opened.id}`, { method: 'DELETE' });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Worker run/i);
  });

  it('returns 409 while a Session is running', async () => {
    const { app } = makeAppWithDb(new FakeAgent([], { hang: true }));
    const dir = makeDir();
    const opened = await (await open(app, dir)).json();

    // Start a session — hanging FakeAgent keeps status = 'running' indefinitely.
    await app.request(`/api/projects/${opened.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello' }),
    });

    const res = await app.request(`/api/projects/${opened.id}`, { method: 'DELETE' });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Session/i);
  });

  it('deletes all child rows and leaves the DB consistent', async () => {
    const { app, db } = makeAppWithDb();
    const dir = makeDir();
    const opened = await (await open(app, dir)).json();
    const projectId = opened.id as number;

    // Insert representative history directly — terminal states only so close is allowed.
    db
      .prepare("INSERT INTO sessions (project_id, prompt, status) VALUES (?, 'test', 'done')")
      .run(projectId);
    const sessionId = Number(
      (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id,
    );
    db
      .prepare("INSERT INTO session_events (session_id, type, payload) VALUES (?, 'assistant_text', '{}')")
      .run(sessionId);
    db
      .prepare("INSERT INTO worker_runs (project_id, issue_number, issue_title, state) VALUES (?, 1, 'x', 'done')")
      .run(projectId);
    const runId = Number(
      (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id,
    );
    db
      .prepare('INSERT INTO token_usage (project_id, run_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens) VALUES (?, ?, 1, 1, 0, 0)')
      .run(projectId, runId);
    db
      .prepare('INSERT INTO field_notes (project_id) VALUES (?)')
      .run(projectId);
    const noteId = Number(
      (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id,
    );
    db
      .prepare("INSERT INTO field_note_items (note_id, position, text) VALUES (?, 0, 'item')")
      .run(noteId);

    const res = await app.request(`/api/projects/${projectId}`, { method: 'DELETE' });

    expect(res.status).toBe(204);

    // Verify no orphaned child rows remain.
    const count = (table: string, col: string, val: number) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).get(val) as { n: number }).n;

    expect(count('sessions', 'project_id', projectId)).toBe(0);
    expect(count('session_events', 'session_id', sessionId)).toBe(0);
    expect(count('worker_runs', 'project_id', projectId)).toBe(0);
    expect(count('token_usage', 'project_id', projectId)).toBe(0);
    expect(count('field_notes', 'project_id', projectId)).toBe(0);
    expect(count('field_note_items', 'note_id', noteId)).toBe(0);
    expect(count('open_projects', 'id', projectId)).toBe(0);
  });
});
