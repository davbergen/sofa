import { describe, expect, it, vi } from 'vitest';

// Capture the options passed into the SDK's `query` so we can assert that
// host Sessions go out with the house-posture appended (ADR-0011).
// createSdkMcpServer and tool pass through unchanged so the sofa MCP server
// can be instantiated at module load time.
const queryCalls: Array<{ options: Record<string, unknown> }> = [];

vi.mock('@anthropic-ai/claude-agent-sdk', async () => {
  const actual = await vi.importActual<typeof import('@anthropic-ai/claude-agent-sdk')>(
    '@anthropic-ai/claude-agent-sdk',
  );
  return {
    ...actual,
    query: (args: { options: Record<string, unknown> }) => {
      queryCalls.push(args);
      return (async function* () {
        // No messages: the SDK stream ends immediately, the Session loop exits
        // through its `finally` and `out.finish()` closes the events iterator.
      })();
    },
  };
});

import { SdkAgent } from '../src/server/sdk-agent';
import { HOUSE_POSTURE } from '../src/server/house-posture';

describe('SdkAgent host Session', () => {
  it('appends the house-posture to the claude_code preset system prompt', async () => {
    queryCalls.length = 0;
    const agent = new SdkAgent();
    const session = agent.run({ prompt: 'hi', cwd: '/tmp' });
    // Drain so the loop exits cleanly.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of session.events) {
      // no-op
    }
    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0].options.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: HOUSE_POSTURE,
    });
  });
});
