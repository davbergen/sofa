import { describe, expect, it } from 'vitest';
import { applyEvent } from '../src/server/runs';

describe('applyEvent phase retention', () => {
  it('records the new phase on each phase event', () => {
    expect(applyEvent('cloning', { type: 'phase', phase: 'working' }, 'cloning')).toEqual({
      state: 'working',
      phase: 'working',
    });
    expect(applyEvent('working', { type: 'phase', phase: 'pushing' }, 'working')).toEqual({
      state: 'pushing',
      phase: 'pushing',
    });
  });

  it('retains the furthest phase reached when a failed event arrives', () => {
    const update = applyEvent('working', { type: 'failed', reason: 'agent error' }, 'working');
    expect(update).toEqual({ state: 'failed', failureReason: 'agent error', phase: 'working' });
  });

  it('omits phase on failed when no phase has been reached yet', () => {
    const update = applyEvent('cloning', { type: 'failed', reason: 'no docker' }, null);
    expect(update).toEqual({ state: 'failed', failureReason: 'no docker' });
  });

  it('ignores events on a terminal run', () => {
    expect(applyEvent('failed', { type: 'phase', phase: 'pushing' }, 'working')).toBeNull();
    expect(applyEvent('pr_open', { type: 'failed', reason: 'stale' }, 'pushing')).toBeNull();
  });
});
