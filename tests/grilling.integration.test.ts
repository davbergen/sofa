// Opt-in real Grilling smoke: performs a REAL Claude Agent SDK call with a
// skill loaded, and expects the Session to write CONTEXT.md so the doc write
// surfaces as a file_write event. Excluded from the default `npm test` run
// (see vite.config.ts test.exclude); run it explicitly with
// `npm run test:integration`. Requires working Claude credentials on the host.
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '../src/server/agent';
import { SdkAgent } from '../src/server/sdk-agent';

const SKILL = `---
name: sofa-smoke-grilling
description: Record a decision in CONTEXT.md. Use when asked to record a decision.
---

When asked to record a decision, write the decision as a single markdown
bullet into a file named CONTEXT.md in the project root (create the file if
it does not exist), then confirm in one short sentence and stop. Do not ask
any questions.
`;

describe('Grilling Session (real Claude Agent SDK, skill loaded)', () => {
  it('loads a skill and surfaces the CONTEXT.md write as a file_write event', { timeout: 180_000 }, async () => {
    // The skill lives in the project's .claude — discovered by the SDK through
    // the same filesystem mechanism as the user's ~/.claude setup, but hermetic.
    const cwd = mkdtempSync(join(tmpdir(), 'sofa-grilling-smoke-'));
    mkdirSync(join(cwd, '.claude', 'skills', 'sofa-smoke-grilling'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'skills', 'sofa-smoke-grilling', 'SKILL.md'), SKILL);

    const agent = new SdkAgent({ maxTurns: 10 });
    const session = agent.run({
      prompt: 'Record this decision: We will use SQLite for persistence.',
      cwd,
      skill: 'sofa-smoke-grilling',
    });

    // Unattended smoke: approve every gated tool call as it arrives.
    const events: AgentEvent[] = [];
    for await (const event of session.events) {
      events.push(event);
      if (event.type === 'permission_request') {
        session.decidePermission(event.requestId, 'allow');
      }
    }

    const errors = events.filter((e) => e.type === 'agent_error');
    expect(errors).toEqual([]);

    const writes = events.filter((e) => e.type === 'file_write');
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.some((w) => /CONTEXT\.md$/i.test(w.path))).toBe(true);
    expect(existsSync(join(cwd, 'CONTEXT.md'))).toBe(true);
  });
});
