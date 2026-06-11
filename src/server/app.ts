import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { DatabaseSync } from 'node:sqlite';
import { stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { Agent } from './agent.js';
import { SessionRegistry } from './sessions.js';

export interface Project {
  id: number;
  dir: string;
  name: string;
  openedAt: string;
}

export interface Session {
  id: number;
  projectId: number;
  prompt: string;
  startedAt: string;
}

interface ProjectRow {
  id: number;
  dir: string;
  name: string;
  opened_at: string;
}

interface SessionRow {
  id: number;
  project_id: number;
  prompt: string;
  started_at: string;
}

function toProject(row: ProjectRow): Project {
  return { id: row.id, dir: row.dir, name: row.name, openedAt: row.opened_at };
}

function toSession(row: SessionRow): Session {
  return { id: row.id, projectId: row.project_id, prompt: row.prompt, startedAt: row.started_at };
}

export function createApp(db: DatabaseSync, agent: Agent): Hono {
  const app = new Hono();
  const sessions = new SessionRegistry();

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

    const { lastInsertRowid } = db
      .prepare('INSERT INTO sessions (project_id, prompt) VALUES (?, ?)')
      .run(projectId, prompt);
    const row = db
      .prepare('SELECT id, project_id, prompt, started_at FROM sessions WHERE id = ?')
      .get(lastInsertRowid) as unknown as SessionRow;

    sessions.start(row.id, agent.run({ prompt, cwd: project.dir }));
    return c.json(toSession(row), 201);
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

  return app;
}
