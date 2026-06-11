import type { DatabaseSync } from 'node:sqlite';
import type { AgentEvent } from './agent.js';

/** Lifecycle of a persisted Session. A 'running' row found after a server
 * restart means the Session was interrupted and is a candidate for resume. */
export type SessionStatus = 'running' | 'done' | 'error';

export interface PersistedSession {
  id: number;
  projectId: number;
  prompt: string;
  startedAt: string;
  status: SessionStatus;
  /** The Agent-side resume handle (SDK session id), once the Agent announced it. */
  agentSessionId: string | null;
}

interface SessionRow {
  id: number;
  project_id: number;
  prompt: string;
  started_at: string;
  status: string;
  agent_session_id: string | null;
}

function toSession(row: SessionRow): PersistedSession {
  return {
    id: row.id,
    projectId: row.project_id,
    prompt: row.prompt,
    startedAt: row.started_at,
    status: row.status as SessionStatus,
    agentSessionId: row.agent_session_id,
  };
}

const SESSION_COLUMNS = 'id, project_id, prompt, started_at, status, agent_session_id';

/**
 * SQLite-backed Session memory: metadata plus the transcript, appended as
 * events stream so nothing is lost if Sofa crashes mid-Session.
 */
export class SessionStore {
  constructor(private readonly db: DatabaseSync) {}

  create(projectId: number, prompt: string): PersistedSession {
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO sessions (project_id, prompt) VALUES (?, ?)')
      .run(projectId, prompt);
    return this.get(Number(lastInsertRowid))!;
  }

  get(sessionId: number): PersistedSession | undefined {
    const row = this.db
      .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`)
      .get(sessionId) as unknown as SessionRow | undefined;
    return row ? toSession(row) : undefined;
  }

  listByProject(projectId: number): PersistedSession[] {
    const rows = this.db
      .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE project_id = ? ORDER BY id`)
      .all(projectId) as unknown as SessionRow[];
    return rows.map(toSession);
  }

  /**
   * Persists one streamed event. An `agent_session` event is the Agent handing
   * us its resume handle, so it lands in the Session metadata instead of the
   * transcript.
   */
  appendEvent(sessionId: number, event: AgentEvent): void {
    if (event.type === 'agent_session') {
      this.db
        .prepare('UPDATE sessions SET agent_session_id = ? WHERE id = ?')
        .run(event.agentSessionId, sessionId);
      return;
    }
    this.db
      .prepare('INSERT INTO session_events (session_id, type, payload) VALUES (?, ?, ?)')
      .run(sessionId, event.type, JSON.stringify(event));
  }

  /** The persisted transcript, in streaming order. */
  transcript(sessionId: number): AgentEvent[] {
    const rows = this.db
      .prepare('SELECT payload FROM session_events WHERE session_id = ? ORDER BY id')
      .all(sessionId) as unknown as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as AgentEvent);
  }

  setStatus(sessionId: number, status: SessionStatus): void {
    this.db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(status, sessionId);
  }
}
