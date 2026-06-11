import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { DatabaseSync } from 'node:sqlite';
import { stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { Agent, AgentRunInput } from './agent.js';
import { SessionRegistry } from './sessions.js';
import { SessionStore } from './session-store.js';

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

export function createApp(db: DatabaseSync, agent: Agent): Hono {
  const app = new Hono();
  const sessions = new SessionRegistry();
  const store = new SessionStore(db);

  /** Runs one Agent turn for a Session, persisting events as they stream. */
  function runSession(sessionId: number, input: AgentRunInput): void {
    sessions.start(sessionId, agent.run(input), {
      onEvent: (event) => store.appendEvent(sessionId, event),
      onFinish: (errored) => store.setStatus(sessionId, errored ? 'error' : 'done'),
    });
  }

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

    const session = store.create(projectId, prompt);
    runSession(session.id, { prompt, cwd: project.dir });
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
    runSession(sessionId, { prompt, cwd: project.dir, resume: session.agentSessionId });
    return c.json(store.get(sessionId));
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

  return app;
}
