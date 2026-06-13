import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/server/db';
import { createApp } from '../src/server/app';
import { FakeAgent } from '../src/server/fake-agent';

function makeApp() {
  return createApp(openDb(':memory:'), new FakeAgent());
}

describe('GET /api/fs/list', () => {
  it('lists the subdirectories of a given directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sofa-fs-ep-'));
    mkdirSync(join(root, 'pkg'));

    const res = await makeApp().request(`/api/fs/list?path=${encodeURIComponent(root)}`);

    expect(res.status).toBe(200);
    const listing = await res.json();
    expect(listing.current).toBe(root);
    expect(listing.entries.map((e: { name: string }) => e.name)).toContain('pkg');
  });

  it('returns a clean 4xx for an unreadable path, not a 500', async () => {
    const res = await makeApp().request(
      `/api/fs/list?path=${encodeURIComponent(join(tmpdir(), 'sofa-fs-missing-xyz'))}`,
    );

    expect(res.status).toBe(404);
    expect(res.status).not.toBe(500);
    expect((await res.json()).error).toBeTruthy();
  });
});

describe('pick-to-open flow', () => {
  it('opens a directory discovered via fs/list through the unchanged POST /api/projects', async () => {
    const app = makeApp();
    const root = mkdtempSync(join(tmpdir(), 'sofa-fs-pick-'));
    mkdirSync(join(root, 'my-project'));

    // The picker lists the parent, the user navigates into a subdirectory…
    const listing = await (await app.request(`/api/fs/list?path=${encodeURIComponent(root)}`)).json();
    const picked = listing.entries.find((e: { name: string }) => e.name === 'my-project');
    expect(picked).toBeTruthy();

    // …and "Select this folder" feeds that absolute path into the open endpoint.
    const open = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: picked.path }),
    });

    expect(open.status).toBe(201);
    expect((await open.json()).dir).toBe(picked.path);
  });

  it('allows selecting and opening a non-git directory', async () => {
    const app = makeApp();
    const dir = mkdtempSync(join(tmpdir(), 'sofa-fs-nongit-'));

    // No .git anywhere — opening must still succeed (only full-pipeline
    // Projects must be repos, per CONTEXT.md).
    const listing = await (await app.request(`/api/fs/list?path=${encodeURIComponent(dir)}`)).json();
    expect(listing.current).toBe(dir);

    const open = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir }),
    });

    expect(open.status).toBe(201);
  });
});
