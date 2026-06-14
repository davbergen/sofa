import { query, type CanUseTool, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  Agent,
  AgentRunInput,
  AgentSession,
  OneShotResult,
  PermissionDecision,
  QuestionOption,
} from './agent.js';
import { SessionRun } from './sessions.js';
import { docWriteFromToolUse } from './doc-writes.js';

/**
 * Expand a bare skill name to the forms the SDK's `skills` option recognises:
 * the exact name (matches a user skill like `~/.claude/skills/<name>`) and the
 * `:name` suffix (matches a plugin-qualified `<plugin>:<name>`). Pre-qualified
 * inputs (already containing `:`) are passed through unchanged.
 */
export function skillEntries(skill: string): string[] {
  if (skill.includes(':')) return [skill];
  return [skill, `:${skill}`];
}

export interface SdkAgentOptions {
  /** Cap the number of agentic turns (useful for smoke tests). */
  maxTurns?: number;
  /**
   * Absolute path of a Sofa repo-bundled plugin (e.g. `sofa-skills/`) whose
   * `skills/` are made available to the SDK *by name*, independent of the
   * user's `~/.claude`. The SDK loads it as a `{ type: 'local' }` plugin so
   * a bundled skill name like `triage-field-notes` resolves at runtime via
   * the `:name` suffix form `skillEntries` emits. Omit to disable bundled
   * skills (tests that don't exercise them).
   */
  bundledPluginDir?: string;
}

/**
 * A long-lived input queue for the SDK's streaming-input mode. Pass one to
 * `query({ prompt: queue })` so the Session stays open across turns; call
 * `send(text)` to push each follow-up user message without closing the channel.
 * (Contrast: `streamInput(oneUserMessage(...))` closes the channel after one
 * message, ending the Session — hence the switch to this queue.)
 */
class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private readonly pending: SDKUserMessage[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;

  send(text: string): void {
    this.pending.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
    this.waiter?.();
    this.waiter = null;
  }

  close(): void {
    this.closed = true;
    this.waiter?.();
    this.waiter = null;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      if (this.pending.length > 0) {
        yield this.pending.shift()!;
      } else {
        await new Promise<void>((resolve) => {
          this.waiter = resolve;
        });
      }
    }
  }
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
 * - A tool call named PrdDraft (the designated draft channel: the grilling
 *   skill calls it with `{title, markdown}` whenever it has a PRD draft to
 *   show) surfaces as a `prd_draft` event and is allowed without prompting.
 * - Every other tool call surfaces as a `permission_request` event; the
 *   callback blocks until `decidePermission` resolves it, so tool execution
 *   waits on the user's decision.
 */
export class SdkAgent implements Agent {
  constructor(private readonly options: SdkAgentOptions = {}) {}

  run({ prompt, cwd, skill, resume, model }: AgentRunInput): AgentSession {
    // SessionRun doubles as a push-based event buffer here, merging events
    // from the SDK message loop and the canUseTool callback into one stream.
    const out = new SessionRun();
    const pendingAnswers = new Map<string, (answer: string) => void>();
    const pendingDecisions = new Map<string, (decision: PermissionDecision) => void>();

    // Start the Session in streaming-input mode: the prompt becomes the first
    // message in a long-lived queue so the SDK keeps the input channel open
    // across turns. Follow-up messages go through this same queue, not through
    // streamInput(), which closes the channel after one message.
    const inputQueue = new MessageQueue();
    inputQueue.send(prompt);

    // Drives End Session: closing the input queue alone is not enough when the
    // Agent is parked inside canUseTool awaiting an AskUserQuestion answer or
    // a permission decision — the SDK never gets back to the input channel to
    // observe its close. Aborting the query unblocks any in-flight tool
    // callback and tears the SDK loop down.
    const abortController = new AbortController();
    let userClosed = false;

    /**
     * Race a callback Promise with the SDK's per-call abort signal so End
     * Session can unblock the canUseTool callback cleanly. On abort the
     * Promise rejects with AbortError; canUseTool re-throws and the SDK
     * winds the query down.
     */
    const raceAbort = <T>(
      register: (resolve: (value: T) => void) => void,
      signal: AbortSignal,
    ): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException('Session ended', 'AbortError'));
          return;
        }
        const onAbort = () => reject(new DOMException('Session ended', 'AbortError'));
        signal.addEventListener('abort', onAbort, { once: true });
        register((value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        });
      });

    const canUseTool: CanUseTool = async (toolName, input, { toolUseID, signal }) => {
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
          answers[q.question] = await raceAbort<string>(
            (resolve) => pendingAnswers.set(questionId, resolve),
            signal,
          );
        }
        return { behavior: 'allow', updatedInput: { ...input, answers } };
      }

      if (toolName === 'PrdDraft' || toolName.endsWith('__PrdDraft')) {
        const { title, markdown } = input as { title?: string; markdown?: string };
        out.push({ type: 'prd_draft', title: title ?? 'PRD', markdown: markdown ?? '' });
        return { behavior: 'allow', updatedInput: input };
      }

      out.push({ type: 'permission_request', requestId: toolUseID, toolName, input });
      const decision = await raceAbort<PermissionDecision>(
        (resolve) => pendingDecisions.set(toolUseID, resolve),
        signal,
      );
      return decision === 'allow'
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'Denied by the user.' };
    };

    const messages = query({
      prompt: inputQueue,
      options: {
        cwd,
        maxTurns: this.options.maxTurns,
        canUseTool,
        abortController,
        resume,
        // Make Sofa's in-repo bundled skills (see `sofa-skills/`) loadable
        // by name. Without this, only ~/.claude skills are discoverable and
        // a bundled name like `triage-field-notes` would silently no-op.
        ...(this.options.bundledPluginDir
          ? { plugins: [{ type: 'local' as const, path: this.options.bundledPluginDir }] }
          : {}),
        // The SDK discovers skills from the same ~/.claude setup the CLI
        // uses (settingSources defaults to all sources); naming one here
        // enables it and loads its frontmatter into the system prompt.
        // The SDK matches entries as exact name, plugin-qualified name, or
        // `:name` suffix — pass both forms so a bare skill name like
        // `grill-with-docs` loads whether the skill lives in `~/.claude/skills/`
        // (matches exactly) or inside a plugin as `<plugin>:grill-with-docs`
        // (matches via the `:name` suffix). Without the suffix form, plugin
        // skills are silently ignored — the Grilling Session would start with
        // no skill loaded.
        ...(skill ? { skills: skillEntries(skill) } : {}),
        ...(model ? { model } : {}),
      },
    });

    void (async () => {
      try {
        for await (const message of messages) {
          if (message.type === 'system' && message.subtype === 'init') {
            out.push({ type: 'agent_session', agentSessionId: message.session_id });
          } else if (message.type === 'assistant') {
            for (const block of message.message.content) {
              if (block.type === 'text' && block.text) {
                out.push({ type: 'assistant_text', text: block.text });
              } else if (block.type === 'tool_use') {
                // Writes to CONTEXT.md / docs/adr surface as file_write events.
                const docWrite = docWriteFromToolUse(block.name, block.input);
                if (docWrite) out.push(docWrite);
              }
            }
          } else if (message.type === 'result') {
            // Surface the SDK's usage metadata for the quota meter.
            out.push({
              type: 'usage',
              usage: {
                inputTokens: message.usage.input_tokens ?? 0,
                outputTokens: message.usage.output_tokens ?? 0,
                cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
                cacheCreationTokens: message.usage.cache_creation_input_tokens ?? 0,
              },
            });
            if (message.subtype === 'success') {
              out.push({ type: 'turn_boundary' });
            } else if (userClosed && message.subtype.startsWith('aborted')) {
              // End Session aborted the query mid-turn; not a failure.
            } else {
              out.push({
                type: 'agent_error',
                message: `Agent run failed (${message.subtype})${message.errors.length ? `: ${message.errors.join('; ')}` : ''}`,
              });
            }
          }
        }
      } catch (err) {
        // End Session aborts the query; the resulting AbortError is the
        // expected exit path, not a failure to record on the transcript.
        const isAbort = err instanceof Error && err.name === 'AbortError';
        if (!(userClosed && isAbort)) {
          out.push({ type: 'agent_error', message: err instanceof Error ? err.message : String(err) });
        }
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
      sendMessage: (text) => {
        inputQueue.send(text);
      },
      close: () => {
        if (userClosed) return;
        userClosed = true;
        inputQueue.close();
        // Aborts the SDK query and, via the signal threaded through canUseTool,
        // unblocks any in-flight question or permission callback.
        abortController.abort();
      },
    };
  }

  /**
   * One-shot, host-side run (ADR 0010): drive the SDK with the prompt and the
   * named skill, collect every assistant text block until the run completes,
   * and return the concatenated text. No `canUseTool` callback is wired in —
   * the calling endpoint owns the slot and a single-shot triage has no need
   * for question/permission round-trips.
   */
  async runOneShot({ prompt, cwd, skill, model }: AgentRunInput): Promise<OneShotResult> {
    const messages = query({
      prompt,
      options: {
        cwd,
        maxTurns: this.options.maxTurns,
        ...(this.options.bundledPluginDir
          ? { plugins: [{ type: 'local' as const, path: this.options.bundledPluginDir }] }
          : {}),
        ...(skill ? { skills: skillEntries(skill) } : {}),
        ...(model ? { model } : {}),
      },
    });
    const chunks: string[] = [];
    let usage: OneShotResult['usage'];
    for await (const message of messages) {
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text) chunks.push(block.text);
        }
      } else if (message.type === 'result') {
        usage = {
          inputTokens: message.usage.input_tokens ?? 0,
          outputTokens: message.usage.output_tokens ?? 0,
          cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
          cacheCreationTokens: message.usage.cache_creation_input_tokens ?? 0,
        };
        if (message.subtype !== 'success') {
          throw new Error(
            `Agent run failed (${message.subtype})${message.errors.length ? `: ${message.errors.join('; ')}` : ''}`,
          );
        }
      }
    }
    return usage ? { text: chunks.join(''), usage } : { text: chunks.join('') };
  }
}
