import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { DatabaseSync } from 'node:sqlite';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { Agent, AgentRunInput } from './agent.js';
import { SessionRegistry } from './sessions.js';
import { fsSkillSource, type SkillSource } from './skills.js';
import { SessionStore } from './session-store.js';
import type { ContainerAdapter, GitHubAdapter } from './ports.js';
import { ACTIVE_STATES, applyEvent, type RunState } from './runs.js';

export interface Project {
  id: number;
  dir: string;
  name: string;
  openedAt: string;
}

export type { PersistedSession as Session } from './session-store.js';

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

export function createApp(
  db: DatabaseSync,
  agent: Agent,
  deps?: AppDeps,
  skills?: SkillSource,
): Hono {
  const app = new Hono();
  const sessions = new SessionRegistry();
  // Skills come from the user's real ~/.claude by default (one source of
  // truth shared with the CLI); tests inject a temp-dir source instead.
  const skillSource = skills ?? fsSkillSource(join(homedir(), '.claude'));
  const store = new SessionStore(db);

  /** Runs one Agent turn for a Session, persisting events as they stream. */
  function runSession(sessionId: number, input: AgentRunInput): void {
    sessions.start(sessionId, agent.run(input), {
      onEvent: (event) => store.appendEvent(sessionId, event),
      onFinish: (errored) => store.setStatus(sessionId, errored ? 'error' : 'done'),
    });
  }

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

  // Skills discoverable from the user's ~/.claude setup, loadable into a Session.
  app.get('/api/skills', async (c) => {
    try {
      return c.json(await skillSource.list());
    } catch (err) {
      return c.json(
        { error: `listing skills failed: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }
  });

  // Start an interactive Session against an open Project.
  app.post('/api/projects/:projectId/sessions', async (c) => {
    const projectId = Number(c.req.param('projectId'));
    const project = db
      .prepare('SELECT id, dir, name, opened_at FROM open_projects WHERE id = ?')
      .get(projectId) as unknown as ProjectRow | undefined;
    if (!project) {
      return c.json({ error: `no open Project with id ${projectId}` }, 404);
    }

    const body = await c.req.json().catch(() => null);
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) {
      return c.json({ error: 'prompt is required' }, 400);
    }
    // Optionally load a skill from the user's ~/.claude setup into the Session.
    const skill = typeof body?.skill === 'string' && body.skill.trim() ? body.skill.trim() : null;

    const session = store.create(projectId, prompt, skill);
    runSession(session.id, { prompt, cwd: project.dir, ...(skill ? { skill } : {}) });
    return c.json(session, 201);
  });

  // Past (and running) Sessions for a Project, from the SQLite store.
  app.get('/api/projects/:projectId/sessions', (c) => {
    const projectId = Number(c.req.param('projectId'));
    const project = db
      .prepare('SELECT id FROM open_projects WHERE id = ?')
      .get(projectId) as unknown as { id: number } | undefined;
    if (!project) {
      return c.json({ error: `no open Project with id ${projectId}` }, 404);
    }
    return c.json(store.listByProject(projectId));
  });

  // The persisted transcript: survives restarts, unlike the live event stream.
  app.get('/api/sessions/:sessionId/transcript', (c) => {
    const sessionId = Number(c.req.param('sessionId'));
    const session = store.get(sessionId);
    if (!session) {
      return c.json({ error: `no Session with id ${sessionId}` }, 404);
    }
    return c.json({ session, events: store.transcript(sessionId) });
  });

  // Resume an interrupted Session (e.g. after a Sofa restart): continues the
  // Agent conversation via its persisted resume handle and streams new events
  // on the usual /events endpoint.
  app.post('/api/sessions/:sessionId/resume', async (c) => {
    const sessionId = Number(c.req.param('sessionId'));
    const session = store.get(sessionId);
    if (!session) {
      return c.json({ error: `no Session with id ${sessionId}` }, 404);
    }

    const body = await c.req.json().catch(() => null);
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) {
      return c.json({ error: 'prompt is required' }, 400);
    }
    if (!session.agentSessionId) {
      return c.json({ error: `Session ${sessionId} has no resume handle from the Agent` }, 409);
    }

    const project = db
      .prepare('SELECT dir FROM open_projects WHERE id = ?')
      .get(session.projectId) as unknown as { dir: string };
    store.setStatus(sessionId, 'running');
    runSession(sessionId, {
      prompt,
      cwd: project.dir,
      resume: session.agentSessionId,
      ...(session.skill ? { skill: session.skill } : {}),
    });
    return c.json(store.get(sessionId));
  });

  // Answer a pending Agent question; the answer flows back into the running Session
  // and is echoed onto the transcript so all subscribers see the question resolved.
  app.post('/api/sessions/:sessionId/answer', async (c) => {
    const sessionId = Number(c.req.param('sessionId'));
    const run = sessions.get(sessionId);
    const agentSession = sessions.agent(sessionId);
    if (!run || !agentSession) {
      return c.json({ error: `no running Session with id ${sessionId}` }, 404);
    }
    const body = await c.req.json().catch(() => null);
    const questionId = typeof body?.questionId === 'string' ? body.questionId : '';
    const answer = typeof body?.answer === 'string' ? body.answer.trim() : '';
    if (!questionId || !answer) {
      return c.json({ error: 'questionId and answer are required' }, 400);
    }
    agentSession.answerQuestion(questionId, answer);
    run.push({ type: 'question_answer', questionId, answer });
    return c.json({ ok: true });
  });

  // Decide a pending permission request; the gated tool runs only on 'allow'.
  app.post('/api/sessions/:sessionId/permission', async (c) => {
    const sessionId = Number(c.req.param('sessionId'));
    const run = sessions.get(sessionId);
    const agentSession = sessions.agent(sessionId);
    if (!run || !agentSession) {
      return c.json({ error: `no running Session with id ${sessionId}` }, 404);
    }
    const body = await c.req.json().catch(() => null);
    const requestId = typeof body?.requestId === 'string' ? body.requestId : '';
    const decision = body?.decision;
    if (!requestId || (decision !== 'allow' && decision !== 'deny')) {
      return c.json({ error: "requestId and a decision of 'allow' or 'deny' are required" }, 400);
    }
    agentSession.decidePermission(requestId, decision);
    run.push({ type: 'permission_decision', requestId, decision });
    return c.json({ ok: true });
  });

  // Live transcript: replays buffered events, then streams until the Session is done.
  app.get('/api/sessions/:sessionId/events', (c) => {
    const sessionId = Number(c.req.param('sessionId'));
    const run = sessions.get(sessionId);
    if (!run) {
      return c.json({ error: `no running Session with id ${sessionId}` }, 404);
    }
    return streamSSE(c, async (stream) => {
      for await (const event of run.stream()) {
        await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
      }
      await stream.writeSSE({ event: 'done', data: '{}' });
    });
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
