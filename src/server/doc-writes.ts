// Doc-write detection: a Grilling Session captures decisions by updating
// CONTEXT.md and ADRs. Tool-use blocks that write those documents become
// `file_write` events so the UI surfaces doc updates as they happen.
import type { FileWriteEvent } from './agent.js';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** True for the living documents a Grilling Session maintains: CONTEXT.md and files under docs/adr/. */
function isDocPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  return /(^|\/)CONTEXT\.md$/i.test(normalized) || /(^|\/)docs\/adr\/./i.test(normalized);
}

/**
 * Derives a `file_write` event from a tool-use block, or null when the tool
 * call is not a write to one of the Project's living documents.
 */
export function docWriteFromToolUse(toolName: string, input: unknown): FileWriteEvent | null {
  if (!WRITE_TOOLS.has(toolName)) return null;
  const filePath = (input as { file_path?: unknown } | null)?.file_path;
  if (typeof filePath !== 'string' || !isDocPath(filePath)) return null;
  return { type: 'file_write', path: filePath, toolName };
}
