import type {
  Agent,
  AgentEvent,
  AgentRunInput,
  AgentSession,
  PermissionDecision,
} from './agent.js';

export interface FakeAgentOptions {
  /** Agent session handle the fake announces as its first event, enabling resume. */
  agentSessionId?: string;
  /** Scripted continuation: events emitted when run with `resume` set. */
  resumeScript?: AgentEvent[];
  /** If true, the initial run never completes — simulates an interrupted Session. */
  hang?: boolean;
}

/**
 * A scripted step for the FakeAgent: either an event to emit, or the
 * `await_message` marker, which pauses the stream until the next follow-up
 * user message arrives via `sendMessage` (how tests script conversational
 * revision: draft, await the revision request, then emit the revised draft).
 */
export type FakeAgentStep = AgentEvent | { type: 'await_message' };

/**
 * Test double for the Agent adapter: emits a scripted sequence of events.
 * A scripted `question` pauses the stream until `answerQuestion` arrives;
 * a scripted `permission_request` pauses until `decidePermission` arrives,
 * recording whether the gated tool call would have executed; an
 * `await_message` step pauses until `sendMessage` arrives.
 */
export class FakeAgent implements Agent {
  readonly runs: AgentRunInput[] = [];
  /** Answers routed back into the running session, in arrival order. */
  readonly answers: Array<{ questionId: string; answer: string }> = [];
  /** Permission decisions routed back into the running session, in arrival order. */
  readonly decisions: Array<{ requestId: string; decision: PermissionDecision }> = [];
  /** Follow-up user messages routed into the running session, in arrival order. */
  readonly messages: string[] = [];
  /** Outcome of each scripted gated tool call: executed on 'allow', skipped on 'deny'. */
  readonly toolOutcomes = new Map<string, 'executed' | 'skipped'>();

  private readonly resolvers = new Map<string, (value: string) => void>();
  private readonly messageWaiters: Array<() => void> = [];
  private undeliveredMessages = 0;
  private closed = false;
  private readonly closeWaiters: Array<() => void> = [];
  /** Sentinel returned from `wait` when the session is closed mid-await. */
  private static readonly CLOSED = '__fake_agent_closed__';

  constructor(
    private readonly script: FakeAgentStep[] = [{ type: 'assistant_text', text: 'Hello from the fake Agent.' }],
    private readonly options: FakeAgentOptions = {},
  ) {}

  run(input: AgentRunInput): AgentSession {
    this.runs.push(input);
    return {
      events: this.emitFor(input),
      answerQuestion: (questionId, answer) => {
        this.answers.push({ questionId, answer });
        this.resolve(`question:${questionId}`, answer);
      },
      decidePermission: (requestId, decision) => {
        this.decisions.push({ requestId, decision });
        this.resolve(`permission:${requestId}`, decision);
      },
      sendMessage: (text) => {
        this.messages.push(text);
        const waiter = this.messageWaiters.shift();
        if (waiter) {
          waiter();
        } else {
          this.undeliveredMessages++;
        }
      },
      close: () => {
        this.closed = true;
        // Wake any pending question/permission waits so the emit loop can exit
        // — closing a Session must terminate it even if a scripted step is
        // blocked awaiting an answer or decision.
        for (const resolver of this.resolvers.values()) resolver(FakeAgent.CLOSED);
        this.resolvers.clear();
        // Wake message waiters too, in case the script is paused on await_message.
        for (const w of this.messageWaiters) w();
        this.messageWaiters.length = 0;
        for (const w of this.closeWaiters) w();
        this.closeWaiters.length = 0;
      },
    };
  }

  private async *emitFor(input: AgentRunInput): AsyncGenerator<AgentEvent> {
    if (input.resume) {
      yield* this.emit(this.options.resumeScript ?? []);
      return;
    }
    if (this.options.agentSessionId) {
      yield { type: 'agent_session', agentSessionId: this.options.agentSessionId };
    }
    yield* this.emit(this.script);
    if (this.options.hang) {
      if (!this.closed) {
        await new Promise<void>((resolve) => this.closeWaiters.push(resolve));
      }
    }
  }

  private async *emit(script: FakeAgentStep[]): AsyncGenerator<AgentEvent> {
    for (const step of script) {
      // Yield asynchronously so events stream like a real Agent's would.
      await new Promise((resolve) => setImmediate(resolve));
      if (this.closed) return;
      if (step.type === 'await_message') {
        if (this.undeliveredMessages > 0) {
          this.undeliveredMessages--;
        } else {
          await new Promise<void>((resolve) => this.messageWaiters.push(resolve));
        }
        if (this.closed) return;
        continue;
      }
      yield step;
      if (step.type === 'question') {
        const answer = await this.wait(`question:${step.questionId}`);
        if (answer === FakeAgent.CLOSED) return;
      } else if (step.type === 'permission_request') {
        const decision = await this.wait(`permission:${step.requestId}`);
        if (decision === FakeAgent.CLOSED) return;
        this.toolOutcomes.set(step.requestId, decision === 'allow' ? 'executed' : 'skipped');
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
