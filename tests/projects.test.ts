import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { existsSync } from 'node:fs';
import { openDb } from '../src/server/db';
import { createApp } from '../src/server/app';

function makeApp() {
  return createApp(openDb(':memory:'));
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

describe('SQLite store', () => {
  it('creates and migrates the database file on first run, and reopens cleanly', async () => {
    const dbPath = join(makeDir('sofa-db-'), 'nested', 'sofa.db');
    expect(existsSync(dbPath)).toBe(false);

    const db = openDb(dbPath);
    expect(existsSync(dbPath)).toBe(true);

    const projectDir = makeDir();
    await open(createApp(db), projectDir);
    db.close();

    // Second run: migrations are idempotent and data survives.
    const reopened = openDb(dbPath);
    const projects = await (await createApp(reopened).request('/api/projects')).json();
    expect(projects.map((p: { dir: string }) => p.dir)).toEqual([projectDir]);
  });
});
