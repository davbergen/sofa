// The Agent adapter: every Claude interaction goes through this seam so the
// server core stays pure and testable. The real implementation wraps the
// Claude Agent SDK (see sdk-agent.ts); tests inject a fake (see fake-agent.ts).

export interface AssistantTextEvent {
  type: 'assistant_text';
  text: string;
}

export interface AgentErrorEvent {
  type: 'agent_error';
  message: string;
}

/**
 * Announces the Agent-side session handle (the SDK session id). Sofa persists
 * it so an interrupted Session can be resumed after a restart.
 */
export interface AgentSessionEvent {
  type: 'agent_session';
  agentSessionId: string;
}

export type AgentEvent = AssistantTextEvent | AgentErrorEvent | AgentSessionEvent;

export interface AgentRunInput {
  /** The user prompt that starts (or continues) the Session. */
  prompt: string;
  /** The open Project's directory; interactive Sessions run on the host against the real working copy. */
  cwd: string;
  /** Resume an earlier Agent session by its handle (the SDK session id). */
  resume?: string;
}

export interface Agent {
  /** Runs one Session turn; the iterable completes when the Agent is done. */
  run(input: AgentRunInput): AsyncIterable<AgentEvent>;
}
