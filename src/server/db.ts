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
