import { describe, expect, it } from 'vitest';
import { parseBlockedBy } from '../src/server/adapters';

// ---------------------------------------------------------------------------
// parseBlockedBy — unit tests
// ---------------------------------------------------------------------------

describe('parseBlockedBy', () => {
  it('parses a single reference', () => {
    expect(parseBlockedBy('Blocked by #12')).toEqual([12]);
  });

  it('parses a comma-separated list', () => {
    expect(parseBlockedBy('Blocked by #12, #15')).toEqual([12, 15]);
  });

  it('returns empty array when no reference is present', () => {
    expect(parseBlockedBy('This is a normal issue body with no blockers.')).toEqual([]);
  });

  it('is case-insensitive', () => {
    expect(parseBlockedBy('blocked by #7')).toEqual([7]);
    expect(parseBlockedBy('BLOCKED BY #7')).toEqual([7]);
    expect(parseBlockedBy('Blocked By #7')).toEqual([7]);
  });

  it('handles mixed prose around the declaration', () => {
    const body = `
## Details

This feature depends on the auth work.
Blocked by #3, #8

Once those land, we can proceed.
    `;
    expect(parseBlockedBy(body)).toEqual([3, 8]);
  });

  it('deduplicates repeated references', () => {
    expect(parseBlockedBy('Blocked by #5, #5')).toEqual([5]);
    expect(parseBlockedBy('Blocked by #5\nBlocked by #5')).toEqual([5]);
  });

  it('handles multiple Blocked by lines, merging all refs', () => {
    const body = 'Blocked by #1, #2\nBlocked by #3';
    expect(parseBlockedBy(body)).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// blockedBy resolution: intersection of parsed refs with open-issue set
// ---------------------------------------------------------------------------

function resolveBlockedBy(body: string, openNumbers: number[]): number[] {
  const openSet = new Set(openNumbers);
  return parseBlockedBy(body).filter((n) => openSet.has(n));
}

describe('blockedBy open-set intersection', () => {
  it('returns refs that are still open', () => {
    expect(resolveBlockedBy('Blocked by #12, #15', [12, 15, 20])).toEqual([12, 15]);
  });

  it('is empty when all blockers are closed', () => {
    // Issue 12 is closed (not in open set)
    expect(resolveBlockedBy('Blocked by #12', [10])).toEqual([]);
  });

  it('is empty when the body has no Blocked by line', () => {
    expect(resolveBlockedBy('No dependencies here.', [1, 2, 3])).toEqual([]);
  });

  it('only includes blockers that are still open', () => {
    // #20 is open, #21 is closed
    expect(resolveBlockedBy('Blocked by #20, #21', [10, 20])).toEqual([20]);
  });
});
