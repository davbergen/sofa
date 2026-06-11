import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Agent, AgentEvent, AgentRunInput } from './agent.js';

export interface SdkAgentOptions {
  /** Cap the number of agentic turns (useful for smoke tests). */
  maxTurns?: number;
}

/**
 * The real Agent adapter: a thin wrapper around the Claude Agent SDK.
 * Runs on the host against the Project's real working copy.
 */
export class SdkAgent implements Agent {
  constructor(private readonly options: SdkAgentOptions = {}) {}

  async *run({ prompt, cwd }: AgentRunInput): AsyncIterable<AgentEvent> {
    const messages = query({
      prompt,
      options: { cwd, maxTurns: this.options.maxTurns },
    });
    for await (const message of messages) {
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text) {
            yield { type: 'assistant_text', text: block.text };
          }
        }
      } else if (message.type === 'result' && message.subtype !== 'success') {
        yield {
          type: 'agent_error',
          message: `Agent run failed (${message.subtype})${message.errors.length ? `: ${message.errors.join('; ')}` : ''}`,
        };
      }
    }
  }
}
