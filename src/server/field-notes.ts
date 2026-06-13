/**
 * Field Notes parsing: turning the plain-text note David drags in while testing
 * a Project into a list of Field Note Items. Pure and free of HTTP/DB so it can
 * be unit-tested on its own (see tests/field-notes.test.ts).
 *
 * Rule: a line matching `^\s*\d+[.)]\s+` (a number, then `.` or `)`, then
 * whitespace) starts a new Item; the number is a delimiter only, so it may be
 * any value and need not be sequential. An Item runs from its numbered line up
 * to the next numbered line, so Items can be multi-line. Text before the first
 * numbered line is preamble and is ignored. The leading marker is stripped from
 * the Item's displayed text.
 */
const MARKER = /^\s*\d+[.)]\s+/;

export function parseFieldNotes(text: string): string[] {
  const items: string[] = [];
  let current: string[] | null = null;

  for (const line of text.split(/\r?\n/)) {
    if (MARKER.test(line)) {
      if (current) items.push(current.join('\n').trimEnd());
      current = [line.replace(MARKER, '')];
    } else if (current) {
      // Continuation of the current Item; preamble (current === null) is dropped.
      current.push(line);
    }
  }
  if (current) items.push(current.join('\n').trimEnd());

  return items;
}
