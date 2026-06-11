import type {
  Agent,
  AgentEvent,
  AgentRunInput,
  AgentSession,
  PermissionDecision,
} from './agent.js';

/**
 * Test double for the Agent adapter: emits a scripted sequence of events.
 * A scripted `question` pauses the stream until `answerQuestion` arrives;
 * a scripted `permission_request` pauses until `decidePermission` arrives,
 * recording whether the gated tool call would have executed.
 */
export class FakeAgent implements Agent {
  readonly runs: AgentRunInput[] = [];
  /** Answers routed back into the running session, in arrival order. */
  readonly answers: Array<{ questionId: string; answer: string }> = [];
  /** Permission decisions routed back into the running session, in arrival order. */
  readonly decisions: Array<{ requestId: string; decision: PermissionDecision }> = [];
  /** Outcome of each scripted gated tool call: executed on 'allow', skipped on 'deny'. */
  readonly toolOutcomes = new Map<string, 'executed' | 'skipped'>();

  private readonly resolvers = new Map<string, (value: string) => void>();

  constructor(
    private readonly script: AgentEvent[] = [{ type: 'assistant_text', text: 'Hello from the fake Agent.' }],
  ) {}

  run(input: AgentRunInput): AgentSession {
    this.runs.push(input);
    return {
      events: this.emit(),
      answerQuestion: (questionId, answer) => {
        this.answers.push({ questionId, answer });
        this.resolve(`question:${questionId}`, answer);
      },
      decidePermission: (requestId, decision) => {
        this.decisions.push({ requestId, decision });
        this.resolve(`permission:${requestId}`, decision);
      },
    };
  }

  private async *emit(): AsyncGenerator<AgentEvent> {
    for (const event of this.script) {
      // Yield asynchronously so events stream like a real Agent's would.
      await new Promise((resolve) => setImmediate(resolve));
      yield event;
      if (event.type === 'question') {
        await this.wait(`question:${event.questionId}`);
      } else if (event.type === 'permission_request') {
        const decision = await this.wait(`permission:${event.requestId}`);
        this.toolOutcomes.set(event.requestId, decision === 'allow' ? 'executed' : 'skipped');
      }
    }
  }

  private wait(key: string): Promise<string> {
    return new Promise((resolve) => this.resolvers.set(key, resolve));
  }

  private resolve(key: string, value: string): void {
    const resolver = this.resolvers.get(key);
    this.resolvers.delete(key);
    resolver?.(value);
  }
}

/** Convenience: a fake that emits the given assistant messages. */
export function fakeAgentSaying(...texts: string[]): FakeAgent {
  return new FakeAgent(texts.map((text) => ({ type: 'assistant_text', text })));
}
