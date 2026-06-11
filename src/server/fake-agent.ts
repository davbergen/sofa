import type { Agent, AgentEvent, AgentRunInput } from './agent.js';

export interface FakeAgentOptions {
  /** Agent session handle the fake announces as its first event, enabling resume. */
  agentSessionId?: string;
  /** Scripted continuation: events emitted when run with `resume` set. */
  resumeScript?: AgentEvent[];
  /** If true, the initial run never completes — simulates an interrupted Session. */
  hang?: boolean;
}

/** Test double for the Agent adapter: emits a scripted sequence of messages. */
export class FakeAgent implements Agent {
  readonly runs: AgentRunInput[] = [];

  constructor(
    private readonly script: AgentEvent[] = [{ type: 'assistant_text', text: 'Hello from the fake Agent.' }],
    private readonly options: FakeAgentOptions = {},
  ) {}

  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    this.runs.push(input);
    if (input.resume) {
      yield* this.emit(this.options.resumeScript ?? []);
      return;
    }
    if (this.options.agentSessionId) {
      yield { type: 'agent_session', agentSessionId: this.options.agentSessionId };
    }
    yield* this.emit(this.script);
    if (this.options.hang) {
      await new Promise(() => {}); // interrupted: never finishes
    }
  }

  private async *emit(script: AgentEvent[]): AsyncIterable<AgentEvent> {
    for (const event of script) {
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
