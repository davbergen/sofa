/**
 * Worker harness (ADR 0001): fresh-clone the repository, implement exactly
 * one Issue by running the agent, push a branch, open a pull request, exit.
 *
 * The orchestration is a pure function over injected CommandRunner/Agent
 * interfaces so it can be unit-tested with fakes; the real wiring lives in
 * src/worker/index.ts.
 */

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs an external command; never throws, failures surface via `code`. */
export interface CommandRunner {
  run(
    cmd: string,
    args: string[],
    opts?: {
      cwd?: string;
      env?: Record<string, string>;
      /**
       * Called with each complete stdout line as it arrives, before the
       * process closes. The full buffer is still returned in `stdout`; this
       * is purely an opt-in observation hook for streaming output.
       */
      onStdoutLine?: (line: string) => void;
    },
  ): Promise<CommandResult>;
}

/**
 * Token usage the agent reported for its run, mirrored from Agent SDK
 * metadata. Field names are part of the Worker's JSON outcome contract
 * (the docker adapter parses them on the server side).
 */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * The agent that implements the Issue inside the cloned repository. May
 * report its token usage; returning nothing means usage is unknown.
 */
export interface Agent {
  implementIssue(opts: { cwd: string; prompt: string }): Promise<AgentUsage | void>;
}

export interface WorkerEnv {
  /** GitHub repository as `owner/name`. */
  repo: string;
  /** Issue number in that repository. */
  issue: number;
  /** Repo-scoped GitHub token (push + PR + issue read). */
  githubToken: string;
  /** Base branch to target; defaults to the repository default branch. */
  baseBranch?: string;
}

export interface WorkerSuccess {
  outcome: 'succeeded';
  repo: string;
  issue: number;
  branch: string;
  prUrl: string;
  /** Token usage the agent reported, when available. */
  usage?: AgentUsage;
}

export interface WorkerFailure {
  outcome: 'failed';
  reason: string;
  /** Token usage the agent reported before the failure, when available. */
  usage?: AgentUsage;
}

export type WorkerOutcome = WorkerSuccess | WorkerFailure;

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

/** Validates env vars; returns a failure (never throws) on bad input. */
export function parseWorkerEnv(env: Record<string, string | undefined>): WorkerEnv | WorkerFailure {
  const missing = ['WORKER_REPO', 'WORKER_ISSUE', 'GITHUB_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'].filter(
    (k) => !env[k]?.trim(),
  );
  if (missing.length > 0) {
    return { outcome: 'failed', reason: `missing required env: ${missing.join(', ')}` };
  }
  const repo = env.WORKER_REPO!.trim();
  if (!REPO_PATTERN.test(repo)) {
    return { outcome: 'failed', reason: `WORKER_REPO must be owner/name, got: ${repo}` };
  }
  const issue = Number(env.WORKER_ISSUE);
  if (!Number.isInteger(issue) || issue <= 0) {
    return { outcome: 'failed', reason: `WORKER_ISSUE must be a positive integer, got: ${env.WORKER_ISSUE}` };
  }
  return {
    repo,
    issue,
    githubToken: env.GITHUB_TOKEN!.trim(),
    baseBranch: env.WORKER_BASE_BRANCH?.trim() || undefined,
  };
}

/** Strips the injected token from any text that might reach logs. */
export function redactToken(text: string, token: string): string {
  return token ? text.split(token).join('***') : text;
}

function countTokens(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0;
}

/** Trims an assistant text block to its first sentence (or first 160 chars). */
function firstSentence(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  const m = cleaned.match(/^(.+?[.!?])\s/);
  const slice = m ? m[1] : cleaned;
  return slice.length > 160 ? `${slice.slice(0, 159)}…` : slice;
}

function shorten(text: string, max = 80): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/**
 * Renders one tool_use block into the activity-feed verb form. Unknown tools
 * fall back to `Working…` so a future SDK addition never leaks raw JSON.
 */
function describeToolUse(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (key: string) => (typeof i[key] === 'string' ? (i[key] as string) : '');
  switch (name) {
    case 'Edit':
    case 'MultiEdit':
      return `Editing ${shorten(str('file_path') || str('path'))}`;
    case 'Write':
      return `Writing ${shorten(str('file_path') || str('path'))}`;
    case 'Read':
    case 'NotebookEdit':
      return `Reading ${shorten(str('file_path') || str('path'))}`;
    case 'Bash':
    case 'PowerShell': {
      const cmd = str('command').split('\n')[0];
      return `Bash: ${shorten(cmd, 100)}`;
    }
    case 'Grep':
      return `Searching for "${shorten(str('pattern'), 60)}"`;
    case 'Glob':
      return `Finding ${shorten(str('pattern'), 60)}`;
    case 'WebFetch':
      return `Fetching ${shorten(str('url'), 80)}`;
    case 'WebSearch':
      return `Searching the web for "${shorten(str('query'), 60)}"`;
    case 'TodoWrite':
      return 'Updating todos';
    case 'Task':
      return `Delegating: ${shorten(str('description') || str('subagent_type'), 60)}`;
    default:
      return name ? `Working… (${name})` : 'Working…';
  }
}

interface StreamFormatter {
  /** Parses one raw `stream-json` line and emits zero or more activity lines. */
  handle(line: string, emit: (message: string) => void): void;
  /** Usage captured from the final `result` event, when present. */
  readonly usage: AgentUsage | undefined;
}

/**
 * Stateful formatter for the Claude CLI's `--output-format stream-json` lines.
 * Emits one activity line per tool_use, condenses assistant prose to its first
 * sentence, drops tool_result bodies (the firehose) except errors, and picks
 * the token usage out of the final `result` event.
 *
 * Why this lives in the harness (not the adapter): the harness owns the agent
 * contract — same place `parseAgentUsage` used to live — so downstream
 * (adapter, SSE, UI) keeps receiving plain `activity` strings exactly as it
 * did when the agent's output was one end-of-run blob.
 */
export function makeStreamFormatter(): StreamFormatter {
  const toolNames = new Map<string, string>();
  let usage: AgentUsage | undefined;
  return {
    get usage() {
      return usage;
    },
    handle(line, emit) {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: unknown;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (typeof event !== 'object' || event === null) return;
      const e = event as { type?: string; message?: unknown; usage?: unknown };

      if (e.type === 'result') {
        const u = (e.usage ?? {}) as Record<string, unknown>;
        usage = {
          inputTokens: countTokens(u.input_tokens),
          outputTokens: countTokens(u.output_tokens),
          cacheReadTokens: countTokens(u.cache_read_input_tokens),
          cacheCreationTokens: countTokens(u.cache_creation_input_tokens),
        };
        return;
      }

      if (e.type === 'assistant' && typeof e.message === 'object' && e.message !== null) {
        const content = (e.message as { content?: unknown[] }).content ?? [];
        for (const block of content) {
          if (typeof block !== 'object' || block === null) continue;
          const b = block as { type?: string; text?: unknown; name?: unknown; id?: unknown; input?: unknown };
          if (b.type === 'text' && typeof b.text === 'string') {
            const sentence = firstSentence(b.text);
            if (sentence) emit(sentence);
          } else if (b.type === 'tool_use' && typeof b.name === 'string') {
            if (typeof b.id === 'string') toolNames.set(b.id, b.name);
            emit(describeToolUse(b.name, b.input));
          }
        }
        return;
      }

      if (e.type === 'user' && typeof e.message === 'object' && e.message !== null) {
        const content = (e.message as { content?: unknown[] }).content ?? [];
        for (const block of content) {
          if (typeof block !== 'object' || block === null) continue;
          const b = block as { type?: string; is_error?: unknown; tool_use_id?: unknown };
          // Only surface tool errors — never the raw tool_result body.
          if (b.type === 'tool_result' && b.is_error === true) {
            const id = typeof b.tool_use_id === 'string' ? b.tool_use_id : '';
            const toolName = toolNames.get(id) ?? 'tool';
            emit(`⚠ ${toolName} failed`);
          }
        }
      }
    },
  };
}

/**
 * Creates an Agent that invokes the Claude CLI non-interactively. The argv
 * construction is the unit-testable seam: inject a fake runner and assert on
 * which flags appear, including `--model` when a model alias is given.
 *
 * The agent uses `--output-format stream-json --verbose` so the harness can
 * surface live activity as the agent works (per ADR 0007) — token usage is
 * read off the stream's final `result` event, not from a buffered blob.
 */
export function makeClaudeAgent(
  runner: CommandRunner,
  model?: string,
  log?: (text: string) => void,
): Agent {
  return {
    async implementIssue({ cwd, prompt }) {
      const args = [
        '-p', prompt,
        '--permission-mode', 'bypassPermissions',
        '--output-format', 'stream-json',
        '--verbose',
      ];
      if (model) {
        args.push('--model', model);
      }
      const formatter = makeStreamFormatter();
      const result = await runner.run('claude', args, {
        cwd,
        onStdoutLine: (line) =>
          formatter.handle(line, (message) => log?.(`${message}\n`)),
      });
      if (result.stderr) {
        log?.(result.stderr);
      }
      if (result.code !== 0) {
        throw new Error(`claude exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
      }
      return formatter.usage;
    },
  };
}

function fail(reason: string, token: string): WorkerFailure {
  return { outcome: 'failed', reason: redactToken(reason, token) };
}

function describe(step: string, result: CommandResult): string {
  const detail = (result.stderr || result.stdout).trim().slice(0, 500);
  return `${step} failed (exit ${result.code})${detail ? `: ${detail}` : ''}`;
}

export interface RunWorkerDeps {
  runner: CommandRunner;
  agent: Agent;
  /** Directory the repository is cloned into. */
  workDir: string;
  log?: (line: string) => void;
}

/**
 * The whole Worker lifecycle. Returns an outcome instead of throwing so the
 * entrypoint can always emit one final machine-readable JSON line.
 */
export async function runWorker(
  rawEnv: Record<string, string | undefined>,
  deps: RunWorkerDeps,
): Promise<WorkerOutcome> {
  const parsed = parseWorkerEnv(rawEnv);
  if ('outcome' in parsed) {
    return parsed;
  }
  const env = parsed;
  const { runner, agent, workDir } = deps;
  const log = (line: string) => deps.log?.(redactToken(line, env.githubToken));
  const ghEnv = { GH_TOKEN: env.githubToken };

  const git = (args: string[]) => runner.run('git', args, { cwd: workDir });
  const gh = (args: string[]) => runner.run('gh', args, { cwd: workDir, env: ghEnv });

  // 1. Fresh clone (the token travels only in the remote URL, in-container).
  log(`cloning ${env.repo}`);
  const cloneUrl = `https://x-access-token:${env.githubToken}@github.com/${env.repo}.git`;
  const clone = await runner.run('git', ['clone', cloneUrl, workDir]);
  if (clone.code !== 0) {
    return fail(describe('git clone', clone), env.githubToken);
  }
  await git(['config', 'user.name', 'Sofa Worker']);
  await git(['config', 'user.email', 'sofa-worker@users.noreply.github.com']);

  // 2. Read the one Issue this Worker exists for.
  const issueView = await gh([
    'issue', 'view', String(env.issue),
    '--repo', env.repo,
    '--json', 'title,body',
  ]);
  if (issueView.code !== 0) {
    return fail(describe(`reading Issue #${env.issue}`, issueView), env.githubToken);
  }
  let issueTitle: string;
  let issueBody: string;
  try {
    const json = JSON.parse(issueView.stdout) as { title: string; body: string };
    issueTitle = json.title;
    issueBody = json.body ?? '';
  } catch {
    return fail(`reading Issue #${env.issue} failed: unparseable gh output`, env.githubToken);
  }

  // 3. Work on a dedicated branch.
  const branch = `issue-${env.issue}-worker`;
  const checkout = await git(['checkout', '-b', branch]);
  if (checkout.code !== 0) {
    return fail(describe('git checkout -b', checkout), env.githubToken);
  }

  // 4. Let the agent implement exactly this one Issue.
  log(`implementing Issue #${env.issue}: ${issueTitle}`);
  const prompt = [
    `Implement GitHub issue #${env.issue} of ${env.repo}. You are already on branch ${branch}`,
    'in a fresh clone of the repository. Implement exactly this one issue — nothing else —',
    'and commit your work with a clear message. Do not push and do not open a pull request;',
    'the harness does that. Run the project lint/test gates if present and make them pass.',
    "Follow the repository's conventions in CLAUDE.md and match existing patterns and components; do not invent new UI or styling where an existing pattern exists.",
    '',
    `Issue title: ${issueTitle}`,
    '',
    'Issue body:',
    issueBody,
  ].join('\n');
  let usage: AgentUsage | undefined;
  try {
    usage = (await agent.implementIssue({ cwd: workDir, prompt })) as AgentUsage | undefined;
  } catch (err) {
    return fail(`agent failed: ${err instanceof Error ? err.message : String(err)}`, env.githubToken);
  }
  // Tokens were spent even if a later step fails, so every outcome past this
  // point carries the agent's reported usage (when it reported any).
  const withUsage = <T extends WorkerOutcome>(outcome: T): T =>
    usage ? { ...outcome, usage } : outcome;

  // 5. Commit anything the agent left uncommitted, then require real work.
  const status = await git(['status', '--porcelain']);
  if (status.stdout.trim() !== '') {
    await git(['add', '-A']);
    const commit = await git(['commit', '-m', `Implement Issue #${env.issue}: ${issueTitle}`]);
    if (commit.code !== 0) {
      return withUsage(fail(describe('git commit', commit), env.githubToken));
    }
  }
  const ahead = await git(['rev-list', '--count', '@{upstream}..HEAD']);
  const aheadByBranch = ahead.code === 0 ? ahead : await git(['rev-list', '--count', `origin/HEAD..HEAD`]);
  if (aheadByBranch.code === 0 && aheadByBranch.stdout.trim() === '0') {
    return withUsage(fail(`agent made no changes for Issue #${env.issue}`, env.githubToken));
  }

  // 6. Output leaves the Worker only as a pushed branch...
  log(`pushing ${branch}`);
  const push = await git(['push', '-u', 'origin', branch]);
  if (push.code !== 0) {
    return withUsage(fail(describe('git push', push), env.githubToken));
  }

  // 7. ...and a pull request.
  const prArgs = [
    'pr', 'create',
    '--repo', env.repo,
    '--head', branch,
    '--title', issueTitle,
    '--body', `Closes #${env.issue}\n\nOpened by a Sofa Worker.`,
  ];
  if (env.baseBranch) {
    prArgs.push('--base', env.baseBranch);
  }
  const pr = await gh(prArgs);
  if (pr.code !== 0) {
    return withUsage(fail(describe('gh pr create', pr), env.githubToken));
  }
  const prUrl = pr.stdout.trim().split('\n').pop() ?? '';

  log(`opened ${prUrl}`);
  return withUsage({ outcome: 'succeeded', repo: env.repo, issue: env.issue, branch, prUrl });
}
