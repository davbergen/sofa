import type { DatabaseSync } from 'node:sqlite';

/** One actionable change parsed out of a Project's Field Notes. */
export interface FieldNoteItem {
  id: number;
  text: string;
  acted: boolean;
  action: string | null;
  sessionId: number | null;
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
    const check = this.db
      .prepare(
        `SELECT fni.id FROM field_note_items fni
         JOIN field_notes fn ON fn.id = fni.note_id
         WHERE fni.id = ? AND fn.project_id = ?`,
      )
      .get(itemId, projectId) as unknown as { id: number } | undefined;
    if (!check) return null;

    this.db
      .prepare('UPDATE field_note_items SET acted = 1, action = ?, session_id = ? WHERE id = ?')
      .run(action, sessionId, itemId);

    const row = this.db
      .prepare('SELECT id, text, acted, action, session_id FROM field_note_items WHERE id = ?')
      .get(itemId) as unknown as ItemRow;
    return {
      id: row.id,
      text: row.text,
      acted: row.acted !== 0,
      action: row.action,
      sessionId: row.session_id,
    };
  }

  getForProject(projectId: number): FieldNotes {
    const note = this.db
      .prepare('SELECT id FROM field_notes WHERE project_id = ?')
      .get(projectId) as unknown as { id: number } | undefined;
    if (!note) {
      return { hasNote: false, items: [] };
    }
    const rows = this.db
      .prepare('SELECT id, text, acted, action, session_id FROM field_note_items WHERE note_id = ? ORDER BY position')
      .all(note.id) as unknown as ItemRow[];
    return {
      hasNote: true,
      items: rows.map((row) => ({
        id: row.id,
        text: row.text,
        acted: row.acted !== 0,
        action: row.action,
        sessionId: row.session_id,
      })),
    };
  }
}
