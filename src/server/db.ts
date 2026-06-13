import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Append-only list of migrations; each entry runs exactly once per database,
// in order. Never edit or reorder shipped entries — add new ones at the end.
const MIGRATIONS: string[] = [
  `CREATE TABLE open_projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dir TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    opened_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES open_projects(id),
    prompt TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE worker_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES open_projects(id),
    issue_number INTEGER NOT NULL,
    issue_title TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL,
    pr_url TEXT,
    failure_reason TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // Session persistence: transcripts survive restarts, and Sessions carry the
  // resume handle (the SDK session id) plus a lifecycle status.
  `CREATE TABLE session_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX session_events_by_session ON session_events (session_id, id);
  ALTER TABLE sessions ADD COLUMN agent_session_id TEXT;
  ALTER TABLE sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'running'`,
  // Quota meter: one row per usage report from the Agent SDK, attributed to
  // either a Worker run or an interactive Session.
  `CREATE TABLE token_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES open_projects(id),
    run_id INTEGER REFERENCES worker_runs(id),
    session_id INTEGER REFERENCES sessions(id),
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // The skill (from ~/.claude) loaded into the Session, if any.
  `ALTER TABLE sessions ADD COLUMN skill TEXT`,
  // Field Notes: David's pre-pipeline notes, parsed into Items and persisted as
  // operational state per Project (ADR 0004). One note per Project (UNIQUE);
  // dropping a new file replaces it.
  `CREATE TABLE field_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL UNIQUE REFERENCES open_projects(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE field_note_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id INTEGER NOT NULL REFERENCES field_notes(id),
    position INTEGER NOT NULL,
    text TEXT NOT NULL
  )`,
];

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const { applied } = db
    .prepare('SELECT COUNT(*) AS applied FROM migrations')
    .get() as { applied: number };
  for (let i = applied; i < MIGRATIONS.length; i++) {
    db.exec(MIGRATIONS[i]);
    db.prepare('INSERT INTO migrations (id) VALUES (?)').run(i + 1);
  }
}
