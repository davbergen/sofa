import type { Agent, AgentEvent, AgentRunInput } from './agent.js';

/** Test double for the Agent adapter: emits a scripted sequence of messages. */
export class FakeAgent implements Agent {
  readonly runs: AgentRunInput[] = [];

  constructor(private readonly script: AgentEvent[] = [{ type: 'assistant_text', text: 'Hello from the fake Agent.' }]) {}

  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    this.runs.push(input);
    for (const event of this.script) {
      // Yield asynchronously so events stream like a real Agent's would.
      await new Promise((resolve) => setImmediate(resolve));
      yield event;
    }
  }
}

/** Convenience: a fake that emits the given assistant messages. */
export function fakeAgentSaying(...texts: string[]): FakeAgent {
  return new FakeAgent(texts.map((text) => ({ type: 'assistant_text', text })));
}
