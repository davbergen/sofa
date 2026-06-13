// The Agent adapter: every Claude interaction goes through this seam so the
// server core stays pure and testable. The real implementation wraps the
// Claude Agent SDK (see sdk-agent.ts); tests inject a fake (see fake-agent.ts).

import type { TokenUsage } from './ports.js';

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

export interface QuestionOption {
  label: string;
  description?: string;
}

/** The Agent asks the user a question with structured options; the Session pauses until answered. */
export interface QuestionEvent {
  type: 'question';
  questionId: string;
  question: string;
  options: QuestionOption[];
  /** Label of the recommended option, if the Agent has one. */
  recommended?: string;
}

/** The user's answer, echoed into the transcript so late subscribers see resolved questions. */
export interface QuestionAnswerEvent {
  type: 'question_answer';
  questionId: string;
  answer: string;
}

/** The Agent wants to run a risky tool; execution waits on the user's decision. */
export interface PermissionRequestEvent {
  type: 'permission_request';
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  description?: string;
}

export type PermissionDecision = 'allow' | 'deny';

/** The user's decision, echoed into the transcript so late subscribers see resolved requests. */
export interface PermissionDecisionEvent {
  type: 'permission_decision';
  requestId: string;
  decision: PermissionDecision;
}

/** The Agent produced (or revised) a PRD draft; the UI renders it as a document panel. */
export interface PrdDraftEvent {
  type: 'prd_draft';
  title: string;
  markdown: string;
}

/** A follow-up user message sent into the running Session (e.g. a PRD revision request), echoed for replay. */
export interface UserMessageEvent {
  type: 'user_message';
  text: string;
}

/** The approved PRD was published to the Project's GitHub issue tracker, echoed for replay. */
export interface PrdPublishedEvent {
  type: 'prd_published';
  issueNumber: number;
  url: string;
}

/**
 * The Agent wrote or updated one of the Project's living documents
 * (CONTEXT.md or a file under docs/adr/), derived from tool-use messages.
 */
export interface FileWriteEvent {
  type: 'file_write';
  /** The written file's path as reported by the tool call. */
  path: string;
  /** The tool that performed the write (Write, Edit, ...). */
  toolName: string;
}

/** Token usage the SDK reported for the turn, for the quota meter. Optional: not every Agent emits one. */
export interface UsageEvent {
  type: 'usage';
  usage: TokenUsage;
}

/** Emitted when the agent completes a turn and is ready for user input. */
export interface TurnBoundaryEvent {
  type: 'turn_boundary';
}

export type AgentEvent =
  | AssistantTextEvent
  | AgentErrorEvent
  | AgentSessionEvent
  | QuestionEvent
  | QuestionAnswerEvent
  | PermissionRequestEvent
  | PermissionDecisionEvent
  | PrdDraftEvent
  | UserMessageEvent
  | PrdPublishedEvent
  | FileWriteEvent
  | UsageEvent
  | TurnBoundaryEvent;

export interface AgentRunInput {
  /** The user prompt that starts (or continues) the Session. */
  prompt: string;
  /** The open Project's directory; interactive Sessions run on the host against the real working copy. */
  cwd: string;
  /** Name of a skill from the user's ~/.claude setup to load into the Session. */
  skill?: string;
  /** Resume an earlier Agent session by its handle (the SDK session id). */
  resume?: string;
}

/** A handle on one running Session turn: its event stream plus the back-channel for answers. */
export interface AgentSession {
  /** The event stream; completes when the Agent is done. */
  events: AsyncIterable<AgentEvent>;
  /** Answers a pending QuestionEvent so the Agent can continue. */
  answerQuestion(questionId: string, answer: string): void;
  /** Resolves a pending PermissionRequestEvent; the gated tool runs only on 'allow'. */
  decidePermission(requestId: string, decision: PermissionDecision): void;
  /** Sends a follow-up user message into the running Session (conversational revision). */
  sendMessage(text: string): void;
}

export interface Agent {
  /** Starts one Session turn and returns a handle for streaming events and sending answers. */
  run(input: AgentRunInput): AgentSession;
}
