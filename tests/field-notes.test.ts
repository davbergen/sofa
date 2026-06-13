import { describe, expect, it } from 'vitest';
import { parseFieldNotes } from '../src/server/field-notes';

describe('parseFieldNotes', () => {
  it('splits a note into Items on numbered lines, stripping the marker', () => {
    expect(parseFieldNotes('1. Fix the header\n2. Align the footer')).toEqual([
      'Fix the header',
      'Align the footer',
    ]);
  });

  it('accepts both `.` and `)` as the number separator', () => {
    expect(parseFieldNotes('1. dot form\n2) paren form')).toEqual(['dot form', 'paren form']);
  });

  it('does not start an Item on a bare number without the separator', () => {
    // No `.`/`)` after the number, or no whitespace after the separator.
    expect(parseFieldNotes('42 is just text\n1.no space here')).toEqual([]);
  });

  it('treats a numbered line with no preceding Item, but text after it, as one Item', () => {
    expect(parseFieldNotes('intro line\n1. real item')).toEqual(['real item']);
  });

  it('includes following non-numbered lines in a multi-line Item', () => {
    const note = '1. First item\n   continues here\n2. Second item';
    expect(parseFieldNotes(note)).toEqual(['First item\n   continues here', 'Second item']);
  });

  it('drops preamble before the first numbered line', () => {
    const note = 'Notes from testing the app:\nlooked at the dashboard\n1. The first real change';
    expect(parseFieldNotes(note)).toEqual(['The first real change']);
  });

  it('delimits Items by non-sequential numbers (the value is ignored)', () => {
    expect(parseFieldNotes('5. five\n2. two\n9. nine')).toEqual(['five', 'two', 'nine']);
  });

  it('handles leading whitespace and CRLF line endings', () => {
    expect(parseFieldNotes('  1. indented\r\n  2. also indented')).toEqual([
      'indented',
      'also indented',
    ]);
  });

  it('returns an empty list when no line matches', () => {
    expect(parseFieldNotes('just some prose\nwith no numbered items')).toEqual([]);
    expect(parseFieldNotes('')).toEqual([]);
  });

  it('trims trailing blank lines from a multi-line Item', () => {
    expect(parseFieldNotes('1. item\n\n\n2. next')).toEqual(['item', 'next']);
  });
});
