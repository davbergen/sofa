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
  // Field Note acted status: per-Item progress David makes through the list.
  // acted = whether the item has been acted on; action = 'grill' | 'issue';
  // session_id = the Session it spawned (nullable until acted).
  `ALTER TABLE field_note_items ADD COLUMN acted INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE field_note_items ADD COLUMN action TEXT;
  ALTER TABLE field_note_items ADD COLUMN session_id INTEGER`,
  // Give session_id a real foreign key to sessions(id): the earlier migration
  // added it as a plain INTEGER, and SQLite can't add a constraint to an
  // existing column in place. Rebuild the table per SQLite's documented ALTER
  // procedure (https://sqlite.org/lang_altertable.html#otheralter). Foreign
  // keys must be OFF during the rebuild; openDb() turns them back ON afterward,
  // and migrate() wraps each entry so the toggle here is scoped to this step.
  `PRAGMA foreign_keys = OFF;
  CREATE TABLE field_note_items_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id INTEGER NOT NULL REFERENCES field_notes(id),
    position INTEGER NOT NULL,
    text TEXT NOT NULL,
    acted INTEGER NOT NULL DEFAULT 0,
    action TEXT,
    session_id INTEGER REFERENCES sessions(id)
  );
  INSERT INTO field_note_items_new (id, note_id, position, text, acted, action, session_id)
    SELECT id, note_id, position, text, acted, action, session_id FROM field_note_items;
  DROP TABLE field_note_items;
  ALTER TABLE field_note_items_new RENAME TO field_note_items;
  PRAGMA foreign_keys = ON`,
  // Cut a self-contained Field Note Item directly into a ready Issue (#39):
  // record the filed Issue's number and URL on the Item. Unlike session_id
  // these carry no foreign key — the Issue lives on GitHub, not in this DB —
  // and stay nullable (only an Item filed as an Issue has them). `action` now
  // ranges over 'grill' | 'issue'.
  `ALTER TABLE field_note_items ADD COLUMN issue_number INTEGER;
  ALTER TABLE field_note_items ADD COLUMN issue_url TEXT`,
  // Per-Project Worker model selection (ADR 0005): operational preference, stored
  // in Sofa's own store, never written to the Project's sofa.json. NULL = Default
  // (no model override). Curated aliases only: opus, sonnet, haiku, fable.
  `ALTER TABLE open_projects ADD COLUMN worker_model TEXT`,
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
