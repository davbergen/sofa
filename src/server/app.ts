import { Hono } from 'hono';
import type { DatabaseSync } from 'node:sqlite';
import { stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { ContainerAdapter, GitHubAdapter } from './ports.js';
import { ACTIVE_STATES, applyEvent, type RunState } from './runs.js';

export interface Project {
  id: number;
  dir: string;
  name: string;
  openedAt: string;
}

interface ProjectRow {
  id: number;
  dir: string;
  name: string;
  opened_at: string;
}

function toProject(row: ProjectRow): Project {
  return { id: row.id, dir: row.dir, name: row.name, openedAt: row.opened_at };
}

export interface Run {
  id: number;
  projectId: number;
  issue: number;
  issueTitle: string;
  state: RunState;
  prUrl: string | null;
  failureReason: string | null;
  startedAt: string;
}

interface RunRow {
  id: number;
  project_id: number;
  issue_number: number;
  issue_title: string;
  state: string;
  pr_url: string | null;
  failure_reason: string | null;
  started_at: string;
}

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    projectId: row.project_id,
    issue: row.issue_number,
    issueTitle: row.issue_title,
    state: row.state as RunState,
    prUrl: row.pr_url,
    failureReason: row.failure_reason,
    startedAt: row.started_at,
  };
}

export interface AppDeps {
  github: GitHubAdapter;
  container: ContainerAdapter;
}

const RUN_COLUMNS =
  'id, project_id, issue_number, issue_title, state, pr_url, failure_reason, started_at';

export function createApp(db: DatabaseSync, deps?: AppDeps): Hono {
  const app = new Hono();

  // A previous server process can no longer report on its Workers: any run it
  // left in flight is marked failed so it stops occupying the Worker slot.
  // The record itself survives, per ADR 0002 (SQLite holds operational state).
  db.prepare(
    `UPDATE worker_runs SET state = 'failed', failure_reason = ?
     WHERE state IN (${ACTIVE_STATES.map(() => '?').join(', ')})`,
  ).run('interrupted by server restart', ...ACTIVE_STATES);

  app.get('/api/projects', (c) => {
    const rows = db
      .prepare('SELECT id, dir, name, opened_at FROM open_projects ORDER BY id')
      .all() as unknown as ProjectRow[];
    return c.json(rows.map(toProject));
  });

  app.post('/api/projects', async (c) => {
    const body = await c.req.json().catch(() => null);
    const dir = typeof body?.dir === 'string' ? body.dir.trim() : '';
    if (!dir) {
      return c.json({ error: 'dir is required' }, 400);
    }
    const abs = resolve(dir);
    const stats = await stat(abs).catch(() => null);
    if (!stats?.isDirectory()) {
      return c.json({ error: `not a directory: ${abs}` }, 400);
    }

    const existing = db
      .prepare('SELECT id, dir, name, opened_at FROM open_projects WHERE dir = ?')
      .get(abs) as unknown as ProjectRow | undefined;
    if (existing) {
      return c.json(toProject(existing), 200);
    }

    const { lastInsertRowid } = db
      .prepare('INSERT INTO open_projects (dir, name) VALUES (?, ?)')
      .run(abs, basename(abs));
    const row = db
      .prepare('SELECT id, dir, name, opened_at FROM open_projects WHERE id = ?')
      .get(lastInsertRowid) as unknown as ProjectRow;
    return c.json(toProject(row), 201);
  });

  function getProject(id: string): Project | null {
    const row = db
      .prepare('SELECT id, dir, name, opened_at FROM open_projects WHERE id = ?')
      .get(Number(id)) as unknown as ProjectRow | undefined;
    return row ? toProject(row) : null;
  }

  app.get('/api/projects/:id/issues', async (c) => {
    if (!deps) {
      return c.json({ error: 'GitHub adapter not configured' }, 500);
    }
    const project = getProject(c.req.param('id'));
    if (!project) {
      return c.json({ error: 'no such Project' }, 404);
    }
    try {
      return c.json(await deps.github.listReadyIssues(project.dir));
    } catch (err) {
      return c.json({ error: `listing ready Issues failed: ${err instanceof Error ? err.message : String(err)}` }, 502);
    }
  });

  app.get('/api/projects/:id/runs', (c) => {
    const project = getProject(c.req.param('id'));
    if (!project) {
      return c.json({ error: 'no such Project' }, 404);
    }
    const rows = db
      .prepare(`SELECT ${RUN_COLUMNS} FROM worker_runs WHERE project_id = ? ORDER BY id DESC`)
      .all(project.id) as unknown as RunRow[];
    return c.json(rows.map(toRun));
  });

  app.post('/api/projects/:id/runs', async (c) => {
    if (!deps) {
      return c.json({ error: 'Container adapter not configured' }, 500);
    }
    const project = getProject(c.req.param('id'));
    if (!project) {
      return c.json({ error: 'no such Project' }, 404);
    }
    const body = await c.req.json().catch(() => null);
    const issue = Number(body?.issue);
    if (!Number.isInteger(issue) || issue <= 0) {
      return c.json({ error: 'issue must be a positive integer' }, 400);
    }
    const issueTitle = typeof body?.title === 'string' ? body.title : '';

    // One Worker at a time per Project.
    const active = db
      .prepare(
        `SELECT id FROM worker_runs WHERE project_id = ? AND state IN (${ACTIVE_STATES.map(() => '?').join(', ')})`,
      )
      .get(project.id, ...ACTIVE_STATES) as unknown as { id: number } | undefined;
    if (active) {
      return c.json({ error: 'a Worker is already running for this Project' }, 409);
    }

    let repo: string;
    try {
      repo = await deps.github.resolveRepo(project.dir);
    } catch (err) {
      return c.json({ error: `resolving repository failed: ${err instanceof Error ? err.message : String(err)}` }, 502);
    }

    const { lastInsertRowid } = db
      .prepare("INSERT INTO worker_runs (project_id, issue_number, issue_title, state) VALUES (?, ?, ?, 'cloning')")
      .run(project.id, issue, issueTitle);
    const runId = Number(lastInsertRowid);

    deps.container.startWorker({ repo, issue }, (event) => {
      const row = db
        .prepare('SELECT state FROM worker_runs WHERE id = ?')
        .get(runId) as unknown as { state: RunState } | undefined;
      if (!row) {
        return;
      }
      const update = applyEvent(row.state, event);
      if (!update) {
        return;
      }
      db.prepare('UPDATE worker_runs SET state = ?, pr_url = ?, failure_reason = ? WHERE id = ?').run(
        update.state,
        update.prUrl ?? null,
        update.failureReason ?? null,
        runId,
      );
    });

    const row = db
      .prepare(`SELECT ${RUN_COLUMNS} FROM worker_runs WHERE id = ?`)
      .get(runId) as unknown as RunRow;
    return c.json(toRun(row), 201);
  });

  return app;
}
