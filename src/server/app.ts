import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { DatabaseSync } from 'node:sqlite';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { Agent, AgentRunInput } from './agent.js';
import { SessionRegistry } from './sessions.js';
import { fsSkillSource, type SkillSource } from './skills.js';
import { ActivityRegistry } from './activity.js';
import { SessionStore } from './session-store.js';
import { FieldNotesStore } from './field-notes-store.js';
import { parseFieldNotes } from './field-notes.js';
import type { ContainerAdapter, GitHubAdapter, WorkerHandle, WorkerPhase } from './ports.js';
import { READY_LABEL } from './adapters.js';
import { ACTIVE_STATES, applyEvent, applyPrState, isActive, type RunState } from './runs.js';
import { readSofaConfig, SofaConfigError } from './sofa-config.js';
import { projectUsage, recordRunUsage, recordSessionUsage, withUsageRecording } from './usage.js';
import { FsBrowseError, listDirectory } from './fs-browse.js';

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
  /**
   * Furthest phase the Worker reached. Survives the terminal `failed`/`killed`
   * event so the UI stepper knows which segment to paint as the death point.
   */
  phase: WorkerPhase | null;
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
  phase: string | null;
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
    phase: row.phase as WorkerPhase | null,
    startedAt: row.started_at,
  };
}

export interface AppDeps {
  github: GitHubAdapter;
  container: ContainerAdapter;
}

export interface AppOptions {
  /** Auto-end an idle interactive Session after this many ms of no activity. Default: 30 min. */
  sessionIdleTimeoutMs?: number;
}

const RUN_COLUMNS =
  'id, project_id, issue_number, issue_title, state, pr_url, failure_reason, phase, started_at';

/** Label applied to every published PRD on the Project's GitHub issue tracker. */
export const PRD_LABEL = 'prd';

const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export function createApp(
  db: DatabaseSync,
  agent: Agent,
  deps?: AppDeps,
  skills?: SkillSource,
  options?: AppOptions,
): Hono {
  const app = new Hono();
  // Any handler that throws (e.g. a SQL error from a schema mismatch) returns a
  // legible JSON 500 rather than a bare crash with no body — the browser can
  // then surface the reason instead of a generic "(500)".
  app.onError((err, c) => {
    console.error('request failed:', err);
    return c.json({ error: err instanceof Error ? err.message : 'internal error' }, 500);
  });
  const sessions = new SessionRegistry();
  // Skills come from the user's real ~/.claude by default (one source of
  // truth shared with the CLI); tests inject a temp-dir source instead.
  const skillSource = skills ?? fsSkillSource(join(homedir(), '.claude'));
  const activity = new ActivityRegistry();
  // Live grips on this process's Worker containers, for the kill switch.
  const workerHandles = new Map<number, WorkerHandle>();
  const store = new SessionStore(db);
  const fieldNotes = new FieldNotesStore(db);

  /**
   * Runs one Agent turn for a Session, persisting events as they stream.
   * The quota meter taps the event stream: usage reports are persisted as
   * they stream by; Agents that emit none simply record nothing.
   */
  function runSession(projectId: number, sessionId: number, input: AgentRunInput): void {
    const agentSession = withUsageRecording(agent.run(input), (usage) =>
      recordSessionUsage(db, projectId, sessionId, usage),
    );
    sessions.start(sessionId, agentSession, {
      onEvent: (event) => store.appendEvent(sessionId, event),
      onFinish: (errored) => store.setStatus(sessionId, errored ? 'error' : 'done'),
      idleTimeoutMs: options?.sessionIdleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS,
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

  // Read-only host directory browser feeding the Open-a-Project picker. The
  // browser can't read host paths, but the server can; the UI navigates this
  // one step at a time and writes a chosen absolute path back into the open
  // field. A bad/unreadable path returns a clean 4xx the picker shows inline.
  app.get('/api/fs/list', async (c) => {
    try {
      return c.json(await listDirectory(c.req.query('path')));
    } catch (err) {
      if (err instanceof FsBrowseError) {
        return c.json({ error: err.message }, err.status);
      }
      throw err;
    }
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

    // A freshly opened repo may lack Sofa's convention labels, which filing
    // Issues, publishing PRDs, and listing ready work all depend on. Ensure
    // they exist on open. This is best-effort: a repo without a GitHub remote
    // (or an unauthenticated gh) must still open, so a failure is a warning,
    // not a block.
    if (deps?.github) {
      try {
        await deps.github.ensureLabels(abs, [READY_LABEL, PRD_LABEL]);
      } catch (err) {
        console.warn(
          `could not ensure convention labels for ${abs}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
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

    const modelRow = db
      .prepare('SELECT session_model FROM open_projects WHERE id = ?')
      .get(projectId) as unknown as { session_model: string | null } | undefined;
    const sessionModel = modelRow?.session_model ?? null;

    const session = store.create(projectId, prompt, skill);
    runSession(projectId, session.id, {
      prompt,
      cwd: project.dir,
      ...(skill ? { skill } : {}),
      ...(sessionModel ? { model: sessionModel } : {}),
    });
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

  // Field Notes read path: David drops a plain-text note onto a Project; the
  // browser sends its text, the server parses it into Items and persists them
  // (replacing any prior note). The matching GET serves them back so the list
  // survives a restart and shows up in a different browser.
  app.get('/api/projects/:projectId/field-notes', (c) => {
    const projectId = Number(c.req.param('projectId'));
    const project = db
      .prepare('SELECT id FROM open_projects WHERE id = ?')
      .get(projectId) as unknown as { id: number } | undefined;
    if (!project) {
      return c.json({ error: `no open Project with id ${projectId}` }, 404);
    }
    return c.json(fieldNotes.getForProject(projectId));
  });

  app.post('/api/projects/:projectId/field-notes', async (c) => {
    const projectId = Number(c.req.param('projectId'));
    const project = db
      .prepare('SELECT id FROM open_projects WHERE id = ?')
      .get(projectId) as unknown as { id: number } | undefined;
    if (!project) {
      return c.json({ error: `no open Project with id ${projectId}` }, 404);
    }
    const body = await c.req.json().catch(() => null);
    // An empty note is a valid drop (it just yields no Items); only a missing
    // or non-string `text` is a malformed request.
    if (typeof body?.text !== 'string') {
      return c.json({ error: 'text is required' }, 400);
    }
    return c.json(fieldNotes.replaceForProject(projectId, parseFieldNotes(body.text)), 201);
  });

  // Inline manual append: type a single Item and add it to the Project's note.
  // If no note exists yet, creates it (hasNote flips true on the returned
  // payload). A manually-appended Item is identical to a parsed one — same
  // shape, same actions, same persistence.
  app.post('/api/projects/:projectId/field-notes/items', async (c) => {
    const projectId = Number(c.req.param('projectId'));
    const project = db
      .prepare('SELECT id FROM open_projects WHERE id = ?')
      .get(projectId) as unknown as { id: number } | undefined;
    if (!project) {
      return c.json({ error: `no open Project with id ${projectId}` }, 404);
    }
    const body = await c.req.json().catch(() => null);
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) {
      return c.json({ error: 'text is required' }, 400);
    }
    return c.json(fieldNotes.appendItem(projectId, text), 201);
  });

  // Mark a Field Note Item acted by the Grill action: record the action and the
  // Session id it spawned. The Item must belong to the given Project. (Cutting
  // an Item into an Issue is the separate atomic endpoint below.)
  app.patch('/api/projects/:projectId/field-notes/items/:itemId', async (c) => {
    const projectId = Number(c.req.param('projectId'));
    const itemId = Number(c.req.param('itemId'));
    const project = db
      .prepare('SELECT id FROM open_projects WHERE id = ?')
      .get(projectId) as unknown as { id: number } | undefined;
    if (!project) {
      return c.json({ error: `no open Project with id ${projectId}` }, 404);
    }
    const body = await c.req.json().catch(() => null);
    const action = typeof body?.action === 'string' ? body.action.trim() : '';
    const sessionId = typeof body?.sessionId === 'number' ? body.sessionId : null;
    if (!action || !sessionId) {
      return c.json({ error: 'action and sessionId are required' }, 400);
    }
    const item = fieldNotes.markActed(projectId, itemId, action, sessionId);
    if (!item) {
      return c.json({ error: `no Field Note Item with id ${itemId} for Project ${projectId}` }, 404);
    }
    return c.json(item);
  });

  // Cut a self-contained Field Note Item directly into a ready Issue (#39):
  // file it on the Project's GitHub issue tracker with the ready-for-agent label
  // and mark the Item acted, atomically in one response. No LLM/Session is
  // started — an Item that needs shaping should be Grilled instead. The title
  // and body come from the browser's confirm/edit step (pre-filled from the
  // Item) so David can tweak them before filing.
  app.post('/api/projects/:projectId/field-notes/items/:itemId/issue', async (c) => {
    if (!deps) {
      return c.json({ error: 'GitHub adapter not configured' }, 500);
    }
    const projectId = Number(c.req.param('projectId'));
    const itemId = Number(c.req.param('itemId'));
    // One join verifies the Project exists, the Item belongs to it, and yields
    // the directory to file against — so we never hit GitHub for a bad Item.
    const row = db
      .prepare(
        `SELECT p.dir AS dir FROM field_note_items fni
         JOIN field_notes fn ON fn.id = fni.note_id
         JOIN open_projects p ON p.id = fn.project_id
         WHERE fni.id = ? AND p.id = ?`,
      )
      .get(itemId, projectId) as unknown as { dir: string } | undefined;
    if (!row) {
      return c.json({ error: `no Field Note Item with id ${itemId} for Project ${projectId}` }, 404);
    }
    const body = await c.req.json().catch(() => null);
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    const issueBody = typeof body?.body === 'string' ? body.body : '';
    if (!title) {
      return c.json({ error: 'title is required' }, 400);
    }
    try {
      const created = await deps.github.createIssue(row.dir, {
        title,
        body: issueBody,
        labels: [READY_LABEL],
      });
      // The join above guarantees the Item exists for this Project, so this
      // returns the updated Item rather than null.
      const item = fieldNotes.markActedAsIssue(projectId, itemId, created.number, created.url);
      return c.json(item, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // gh fails to create the Issue when the ready-for-agent label is missing
      // from a fresh repo. Surface that as an actionable error rather than a raw
      // gh dump — label creation is the convention-labels issue's job, not here.
      if (/not found/i.test(message) && message.includes(READY_LABEL)) {
        return c.json(
          {
            error: `the '${READY_LABEL}' label does not exist in this repository; create it and try again`,
          },
          422,
        );
      }
      return c.json({ error: `filing the Issue failed: ${message}` }, 502);
    }
  });

  // Remove a Field Note Item (acted or not): deletes its row so it no longer
  // appears. Mirrors DELETE /api/runs/:id — 204 on success, 404 when the Item
  // does not belong to this Project.
  app.delete('/api/projects/:projectId/field-notes/items/:itemId', (c) => {
    const projectId = Number(c.req.param('projectId'));
    const itemId = Number(c.req.param('itemId'));
    const project = db
      .prepare('SELECT id FROM open_projects WHERE id = ?')
      .get(projectId) as unknown as { id: number } | undefined;
    if (!project) {
      return c.json({ error: `no open Project with id ${projectId}` }, 404);
    }
    const deleted = fieldNotes.deleteItem(projectId, itemId);
    if (!deleted) {
      return c.json({ error: `no Field Note Item with id ${itemId} for Project ${projectId}` }, 404);
    }
    return c.body(null, 204);
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
    runSession(session.projectId, sessionId, {
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

  // Send a follow-up user message into a running Session (e.g. a PRD revision
  // request); it is echoed onto the transcript so all subscribers see it.
  app.post('/api/sessions/:sessionId/message', async (c) => {
    const sessionId = Number(c.req.param('sessionId'));
    const run = sessions.get(sessionId);
    const agentSession = sessions.agent(sessionId);
    if (!run || !agentSession) {
      return c.json({ error: `no running Session with id ${sessionId}` }, 404);
    }
    const body = await c.req.json().catch(() => null);
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) {
      return c.json({ error: 'text is required' }, 400);
    }
    agentSession.sendMessage(text);
    run.push({ type: 'user_message', text });
    sessions.heartbeat(sessionId);
    return c.json({ ok: true });
  });

  // Explicitly end a live interactive Session by closing its input queue, which
  // completes the Agent query and marks the Session done. Idempotent: safe to
  // call on a Session that is already finished.
  app.post('/api/sessions/:sessionId/end', (c) => {
    const sessionId = Number(c.req.param('sessionId'));
    if (!store.get(sessionId)) {
      return c.json({ error: `no Session with id ${sessionId}` }, 404);
    }
    sessions.agent(sessionId)?.close();
    return c.json({ ok: true });
  });

  // Approve the Session's current PRD draft: publish it to the Project's
  // GitHub issue tracker. Nothing reaches GitHub before this explicit action.
  app.post('/api/sessions/:sessionId/prd/approve', async (c) => {
    if (!deps) {
      return c.json({ error: 'GitHub adapter not configured' }, 500);
    }
    const sessionId = Number(c.req.param('sessionId'));
    const run = sessions.get(sessionId);
    if (!run) {
      return c.json({ error: `no running Session with id ${sessionId}` }, 404);
    }
    const draft = run.prdDraft();
    if (!draft) {
      return c.json({ error: 'the Session has no PRD draft to approve' }, 409);
    }
    const project = db
      .prepare(
        'SELECT p.dir AS dir FROM sessions s JOIN open_projects p ON p.id = s.project_id WHERE s.id = ?',
      )
      .get(sessionId) as unknown as { dir: string } | undefined;
    if (!project) {
      return c.json({ error: `no Project for Session ${sessionId}` }, 404);
    }
    try {
      const created = await deps.github.createIssue(project.dir, {
        title: draft.title,
        body: draft.markdown,
        labels: [PRD_LABEL],
      });
      run.push({ type: 'prd_published', issueNumber: created.number, url: created.url });
      return c.json(created, 201);
    } catch (err) {
      return c.json(
        { error: `publishing the PRD failed: ${err instanceof Error ? err.message : String(err)}` },
        502,
      );
    }
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

  // The quota meter: per-run usage plus aggregates over time for one Project.
  app.get('/api/projects/:id/usage', (c) => {
    const project = getProject(c.req.param('id'));
    if (!project) {
      return c.json({ error: 'no such Project' }, 404);
    }
    return c.json(projectUsage(db, project.id));
  });

  const CURATED_MODELS = new Set(['opus', 'sonnet', 'haiku', 'fable']);

  app.get('/api/projects/:id/settings', (c) => {
    const project = getProject(c.req.param('id'));
    if (!project) {
      return c.json({ error: 'no such Project' }, 404);
    }
    const row = db
      .prepare('SELECT worker_model, session_model FROM open_projects WHERE id = ?')
      .get(project.id) as unknown as { worker_model: string | null; session_model: string | null } | undefined;
    return c.json({ workerModel: row?.worker_model ?? null, sessionModel: row?.session_model ?? null });
  });

  app.post('/api/projects/:id/settings', async (c) => {
    const project = getProject(c.req.param('id'));
    if (!project) {
      return c.json({ error: 'no such Project' }, 404);
    }
    const body = await c.req.json().catch(() => null);

    const hasWorkerModel = body !== null && 'workerModel' in body;
    const hasSessionModel = body !== null && 'sessionModel' in body;

    if (hasWorkerModel) {
      const raw = body.workerModel;
      const workerModel = raw === null || raw === undefined || raw === 'Default' ? null : String(raw).trim() || null;
      if (workerModel !== null && !CURATED_MODELS.has(workerModel)) {
        return c.json(
          { error: `workerModel must be one of ${[...CURATED_MODELS].join(', ')} or null` },
          422,
        );
      }
      db.prepare('UPDATE open_projects SET worker_model = ? WHERE id = ?').run(workerModel, project.id);
    }

    if (hasSessionModel) {
      const raw = body.sessionModel;
      const sessionModel = raw === null || raw === undefined || raw === 'Default' ? null : String(raw).trim() || null;
      if (sessionModel !== null && !CURATED_MODELS.has(sessionModel)) {
        return c.json(
          { error: `sessionModel must be one of ${[...CURATED_MODELS].join(', ')} or null` },
          422,
        );
      }
      db.prepare('UPDATE open_projects SET session_model = ? WHERE id = ?').run(sessionModel, project.id);
    }

    const row = db
      .prepare('SELECT worker_model, session_model FROM open_projects WHERE id = ?')
      .get(project.id) as unknown as { worker_model: string | null; session_model: string | null } | undefined;
    return c.json({ workerModel: row?.worker_model ?? null, sessionModel: row?.session_model ?? null });
  });

  // On-demand reconciliation: re-read GitHub PR truth for this Project so both
  // the Worker Runs panel and Ready Issues catch up to what GitHub says.
  //
  // Two passes happen in one trip:
  //   1. Advance every `pr_open` run record to `pr_merged` / `pr_closed` based
  //      on the linked PR's current state (the #81 mechanism).
  //   2. Build the set of open PRs keyed by the Issue number they implement
  //      (via the `issue-<n>-*` branch convention), so the UI can grey out
  //      Dispatch on a Ready Issue that already has a PR in flight.
  //
  // Runs on mount + manual Refresh; never folded into the 2s active-poll.
  // Fail-soft: if any `gh` lookup throws, no record is overwritten and a 502
  // surfaces the reason for the banner.
  app.post('/api/projects/:id/reconcile', async (c) => {
    if (!deps) {
      return c.json({ error: 'GitHub adapter not configured' }, 500);
    }
    const project = getProject(c.req.param('id'));
    if (!project) {
      return c.json({ error: 'no such Project' }, 404);
    }
    const candidates = db
      .prepare(`SELECT id, pr_url FROM worker_runs WHERE project_id = ? AND state = 'pr_open'`)
      .all(project.id) as unknown as Array<{ id: number; pr_url: string | null }>;
    let issuesWithOpenPr: Array<{ issue: number; prNumber: number; prUrl: string }> = [];
    try {
      for (const row of candidates) {
        if (!row.pr_url) continue;
        const prState = await deps.github.getPrState(project.dir, row.pr_url);
        const update = applyPrState('pr_open', prState);
        if (!update) continue;
        db.prepare('UPDATE worker_runs SET state = ? WHERE id = ?').run(update.state, row.id);
      }
      issuesWithOpenPr = await deps.github.listOpenPrsByIssue(project.dir);
    } catch (err) {
      return c.json(
        { error: `reconciling PR state failed: ${err instanceof Error ? err.message : String(err)}` },
        502,
      );
    }
    const rows = db
      .prepare(`SELECT ${RUN_COLUMNS} FROM worker_runs WHERE project_id = ? ORDER BY id DESC`)
      .all(project.id) as unknown as RunRow[];
    return c.json({ runs: rows.map(toRun), issuesWithOpenPr });
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

  // Live Worker activity: replays the buffered tail, then streams until the
  // run reaches a terminal state. Mirrors the Session events endpoint above.
  app.get('/api/runs/:runId/activity', (c) => {
    const runId = Number(c.req.param('runId'));
    const feed = activity.get(runId);
    if (!feed) {
      return c.json({ error: `no activity feed for run ${runId}` }, 404);
    }
    return streamSSE(c, async (stream) => {
      for await (const entry of feed.stream()) {
        await stream.writeSSE({ event: 'activity', data: JSON.stringify(entry) });
      }
      await stream.writeSSE({ event: 'done', data: '{}' });
    });
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

    // An invalid sofa.json rejects the dispatch outright (no run record) —
    // silently falling back to the generic image would mask the problem.
    let workerImage: string | undefined;
    try {
      workerImage = (await readSofaConfig(project.dir)).workerImage;
    } catch (err) {
      if (err instanceof SofaConfigError) {
        return c.json({ error: err.message }, 422);
      }
      throw err;
    }

    let repo: string;
    try {
      repo = await deps.github.resolveRepo(project.dir);
    } catch (err) {
      return c.json({ error: `resolving repository failed: ${err instanceof Error ? err.message : String(err)}` }, 502);
    }

    const projectRow = db
      .prepare('SELECT worker_model FROM open_projects WHERE id = ?')
      .get(project.id) as unknown as { worker_model: string | null } | undefined;
    const workerModel = projectRow?.worker_model ?? null;

    const { lastInsertRowid } = db
      .prepare("INSERT INTO worker_runs (project_id, issue_number, issue_title, state) VALUES (?, ?, ?, 'cloning')")
      .run(project.id, issue, issueTitle);
    const runId = Number(lastInsertRowid);

    const feed = activity.start(runId);
    const handle = deps.container.startWorker(
      {
        repo,
        issue,
        ...(workerImage ? { image: workerImage } : {}),
        ...(workerModel ? { model: workerModel } : {}),
      },
      (event) => {
      // Mirror every event onto the run's live activity feed.
      switch (event.type) {
        case 'activity':
          feed.push(event.message);
          return; // feed-only; never touches the run record
        case 'phase':
          feed.push(`phase: ${event.phase}`);
          break;
        case 'succeeded':
          feed.push(`opened PR ${event.prUrl}`);
          feed.finish();
          break;
        case 'failed':
          feed.push(`failed: ${event.reason}`);
          feed.finish();
          break;
      }
      const row = db
        .prepare('SELECT state, phase FROM worker_runs WHERE id = ?')
        .get(runId) as unknown as { state: RunState; phase: WorkerPhase | null } | undefined;
      if (!row) {
        return;
      }
      const update = applyEvent(row.state, event, row.phase);
      if (!update) {
        return;
      }
      const nextPhase = update.phase ?? row.phase;
      db.prepare(
        'UPDATE worker_runs SET state = ?, pr_url = ?, failure_reason = ?, phase = ? WHERE id = ?',
      ).run(
        update.state,
        update.prUrl ?? null,
        update.failureReason ?? null,
        nextPhase,
        runId,
      );
      // Quota meter: terminal events may carry the run's token usage. Stale
      // events were already filtered above, so a run records at most once.
      if ((event.type === 'succeeded' || event.type === 'failed') && event.usage) {
        recordRunUsage(db, project.id, runId, event.usage);
      }
      if (!isActive(update.state)) {
        workerHandles.delete(runId);
      }
    });
    workerHandles.set(runId, handle);

    const row = db
      .prepare(`SELECT ${RUN_COLUMNS} FROM worker_runs WHERE id = ?`)
      .get(runId) as unknown as RunRow;
    return c.json(toRun(row), 201);
  });

  // The kill switch: stop a running Worker's container and mark its run killed.
  app.post('/api/runs/:id/kill', async (c) => {
    const runId = Number(c.req.param('id'));
    const row = db
      .prepare(`SELECT ${RUN_COLUMNS} FROM worker_runs WHERE id = ?`)
      .get(runId) as unknown as RunRow | undefined;
    if (!row) {
      return c.json({ error: `no run with id ${runId}` }, 404);
    }
    if (!isActive(row.state as RunState)) {
      return c.json({ error: `run ${runId} is not active (state: ${row.state})` }, 409);
    }

    const handle = workerHandles.get(runId);
    if (handle) {
      await handle.stop();
      workerHandles.delete(runId);
    }
    // Terminal `killed` frees the Project's Worker slot; any straggler events
    // from the dying container are ignored by applyEvent.
    db.prepare("UPDATE worker_runs SET state = 'killed', failure_reason = ? WHERE id = ?").run(
      'killed by user',
      runId,
    );
    const feed = activity.get(runId);
    if (feed) {
      feed.push('killed by user');
      feed.finish();
    }

    const updated = db
      .prepare(`SELECT ${RUN_COLUMNS} FROM worker_runs WHERE id = ?`)
      .get(runId) as unknown as RunRow;
    return c.json(toRun(updated));
  });

  // Remove a past run record. Only terminal runs may be removed — an active run
  // must be killed first. token_usage rows keyed to the run go with it; the FK
  // has no ON DELETE CASCADE, so they're deleted explicitly.
  app.delete('/api/runs/:id', (c) => {
    const runId = Number(c.req.param('id'));
    const row = db
      .prepare('SELECT state FROM worker_runs WHERE id = ?')
      .get(runId) as unknown as { state: RunState } | undefined;
    if (!row) {
      return c.json({ error: `no run with id ${runId}` }, 404);
    }
    if (isActive(row.state)) {
      return c.json({ error: `run ${runId} is active (state: ${row.state}) — kill it first` }, 409);
    }
    db.prepare('DELETE FROM token_usage WHERE run_id = ?').run(runId);
    db.prepare('DELETE FROM worker_runs WHERE id = ?').run(runId);
    return c.body(null, 204);
  });

  return app;
}
