import { query, type CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type {
  Agent,
  AgentRunInput,
  AgentSession,
  PermissionDecision,
  QuestionOption,
} from './agent.js';
import { SessionRun } from './sessions.js';

export interface SdkAgentOptions {
  /** Cap the number of agentic turns (useful for smoke tests). */
  maxTurns?: number;
}

/** Shape of the SDK's AskUserQuestion tool input (see sdk-tools.d.ts). */
interface AskUserQuestionInput {
  questions: Array<{
    question: string;
    options: Array<{ label: string; description?: string }>;
  }>;
}

/**
 * The real Agent adapter: a thin wrapper around the Claude Agent SDK.
 * Runs on the host against the Project's real working copy.
 *
 * Structured interaction maps onto the SDK's canUseTool callback:
 * - AskUserQuestion tool calls surface as `question` events; the callback
 *   blocks until `answerQuestion` supplies each answer, then allows the tool
 *   with the answers folded into its input.
 * - Every other tool call surfaces as a `permission_request` event; the
 *   callback blocks until `decidePermission` resolves it, so tool execution
 *   waits on the user's decision.
 */
export class SdkAgent implements Agent {
  constructor(private readonly options: SdkAgentOptions = {}) {}

  run({ prompt, cwd }: AgentRunInput): AgentSession {
    // SessionRun doubles as a push-based event buffer here, merging events
    // from the SDK message loop and the canUseTool callback into one stream.
    const out = new SessionRun();
    const pendingAnswers = new Map<string, (answer: string) => void>();
    const pendingDecisions = new Map<string, (decision: PermissionDecision) => void>();

    const canUseTool: CanUseTool = async (toolName, input, { toolUseID }) => {
      if (toolName === 'AskUserQuestion') {
        const { questions } = input as unknown as AskUserQuestionInput;
        const answers: Record<string, string> = {};
        for (const [index, q] of (questions ?? []).entries()) {
          const questionId = `${toolUseID}:${index}`;
          const options: QuestionOption[] = (q.options ?? []).map((o) => ({
            label: o.label,
            description: o.description,
          }));
          out.push({ type: 'question', questionId, question: q.question, options });
          answers[q.question] = await new Promise<string>((resolve) =>
            pendingAnswers.set(questionId, resolve),
          );
        }
        return { behavior: 'allow', updatedInput: { ...input, answers } };
      }

      out.push({ type: 'permission_request', requestId: toolUseID, toolName, input });
      const decision = await new Promise<PermissionDecision>((resolve) =>
        pendingDecisions.set(toolUseID, resolve),
      );
      return decision === 'allow'
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'Denied by the user.' };
    };

    void (async () => {
      try {
        const messages = query({
          prompt,
          options: { cwd, maxTurns: this.options.maxTurns, canUseTool },
        });
        for await (const message of messages) {
          if (message.type === 'assistant') {
            for (const block of message.message.content) {
              if (block.type === 'text' && block.text) {
                out.push({ type: 'assistant_text', text: block.text });
              }
            }
          } else if (message.type === 'result' && message.subtype !== 'success') {
            out.push({
              type: 'agent_error',
              message: `Agent run failed (${message.subtype})${message.errors.length ? `: ${message.errors.join('; ')}` : ''}`,
            });
          }
        }
      } catch (err) {
        out.push({ type: 'agent_error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        out.finish();
      }
    })();

    return {
      events: out.stream(),
      answerQuestion: (questionId, answer) => {
        const resolve = pendingAnswers.get(questionId);
        pendingAnswers.delete(questionId);
        resolve?.(answer);
      },
      decidePermission: (requestId, decision) => {
        const resolve = pendingDecisions.get(requestId);
        pendingDecisions.delete(requestId);
        resolve?.(decision);
      },
    };
  }
}
