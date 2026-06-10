// Opt-in integration smoke: performs a REAL Claude Agent SDK call.
// Excluded from the default `npm test` run (see vite.config.ts test.exclude);
// run it explicitly with `npm run test:integration`. Requires working Claude
// credentials on the host (e.g. a logged-in Claude Code install).
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '../src/server/agent';
import { SdkAgent } from '../src/server/sdk-agent';

describe('SdkAgent (real Claude Agent SDK)', () => {
  it('streams at least one assistant message for a trivial prompt', { timeout: 180_000 }, async () => {
    const agent = new SdkAgent({ maxTurns: 1 });
    const cwd = mkdtempSync(join(tmpdir(), 'sofa-sdk-smoke-'));

    const events: AgentEvent[] = [];
    for await (const event of agent.run({ prompt: 'Reply with the single word: pong', cwd })) {
      events.push(event);
    }

    const errors = events.filter((e) => e.type === 'agent_error');
    expect(errors).toEqual([]);
    const texts = events.filter((e) => e.type === 'assistant_text');
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.map((e) => e.text).join(' ')).toMatch(/pong/i);
  });
});
