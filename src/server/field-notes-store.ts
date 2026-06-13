import type { DatabaseSync } from 'node:sqlite';

/** One actionable change parsed out of a Project's Field Notes. */
export interface FieldNoteItem {
  id: number;
  text: string;
  acted: boolean;
  action: string | null;
  sessionId: number | null;
  /** When filed directly as an Issue (action === 'issue'): the GitHub Issue it became. */
  issueNumber: number | null;
  issueUrl: string | null;
}

export interface FieldNotes {
  /**
   * Whether a note has been dropped for this Project at all — distinct from a
   * note that was dropped but parsed to zero Items, so the UI can tell "no note
   * yet" apart from "that file had no items".
   */
  hasNote: boolean;
  items: FieldNoteItem[];
}

interface ItemRow {
  id: number;
  text: string;
  acted: number;
  action: string | null;
  session_id: number | null;
  issue_number: number | null;
  issue_url: string | null;
}

const ITEM_COLUMNS = 'id, text, acted, action, session_id, issue_number, issue_url';

function toItem(row: ItemRow): FieldNoteItem {
  return {
    id: row.id,
    text: row.text,
    acted: row.acted !== 0,
    action: row.action,
    sessionId: row.session_id,
    issueNumber: row.issue_number,
    issueUrl: row.issue_url,
  };
}

/**
 * SQLite-backed Field Notes memory, mirroring {@link SessionStore}: the parsed
 * note and its Items persist as operational state per Project (ADR 0004), so
 * David's place in the list survives restarts and a different browser. One note
 * per Project — dropping a new file replaces the prior one.
 */
export class FieldNotesStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Replaces the Project's note with a freshly parsed list of Item texts. */
  replaceForProject(projectId: number, items: string[]): FieldNotes {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'DELETE FROM field_note_items WHERE note_id IN (SELECT id FROM field_notes WHERE project_id = ?)',
        )
        .run(projectId);
      this.db.prepare('DELETE FROM field_notes WHERE project_id = ?').run(projectId);
      const { lastInsertRowid } = this.db
        .prepare('INSERT INTO field_notes (project_id) VALUES (?)')
        .run(projectId);
      const noteId = Number(lastInsertRowid);
      const insertItem = this.db.prepare(
        'INSERT INTO field_note_items (note_id, position, text) VALUES (?, ?, ?)',
      );
      items.forEach((text, position) => insertItem.run(noteId, position, text));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.getForProject(projectId);
  }

  /**
   * Records that David acted on an Item. Verifies the Item belongs to the given
   * Project so callers need not do a separate ownership check. Returns the
   * updated Item, or null if no matching Item is found for that Project.
   */
  markActed(projectId: number, itemId: number, action: string, sessionId: number): FieldNoteItem | null {
    if (!this.belongsToProject(projectId, itemId)) return null;

    this.db
      .prepare('UPDATE field_note_items SET acted = 1, action = ?, session_id = ? WHERE id = ?')
      .run(action, sessionId, itemId);

    return this.get(itemId);
  }

  /**
   * Records that David cut an Item directly into a GitHub Issue (action
   * 'issue'): no Session is spawned, so session_id stays null; instead the
   * filed Issue's number and URL are stored. Verifies the Item belongs to the
   * Project. Returns the updated Item, or null if no matching Item is found.
   */
  markActedAsIssue(
    projectId: number,
    itemId: number,
    issueNumber: number,
    issueUrl: string,
  ): FieldNoteItem | null {
    if (!this.belongsToProject(projectId, itemId)) return null;

    this.db
      .prepare(
        `UPDATE field_note_items
         SET acted = 1, action = 'issue', session_id = NULL, issue_number = ?, issue_url = ?
         WHERE id = ?`,
      )
      .run(issueNumber, issueUrl, itemId);

    return this.get(itemId);
  }

  private belongsToProject(projectId: number, itemId: number): boolean {
    const check = this.db
      .prepare(
        `SELECT fni.id FROM field_note_items fni
         JOIN field_notes fn ON fn.id = fni.note_id
         WHERE fni.id = ? AND fn.project_id = ?`,
      )
      .get(itemId, projectId) as unknown as { id: number } | undefined;
    return !!check;
  }

  private get(itemId: number): FieldNoteItem {
    const row = this.db
      .prepare(`SELECT ${ITEM_COLUMNS} FROM field_note_items WHERE id = ?`)
      .get(itemId) as unknown as ItemRow;
    return toItem(row);
  }

  getForProject(projectId: number): FieldNotes {
    const note = this.db
      .prepare('SELECT id FROM field_notes WHERE project_id = ?')
      .get(projectId) as unknown as { id: number } | undefined;
    if (!note) {
      return { hasNote: false, items: [] };
    }
    const rows = this.db
      .prepare(`SELECT ${ITEM_COLUMNS} FROM field_note_items WHERE note_id = ? ORDER BY position`)
      .all(note.id) as unknown as ItemRow[];
    return {
      hasNote: true,
      items: rows.map(toItem),
    };
  }
}
