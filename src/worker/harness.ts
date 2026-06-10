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
    opts?: { cwd?: string; env?: Record<string, string> },
  ): Promise<CommandResult>;
}

/** The agent that implements the Issue inside the cloned repository. */
export interface Agent {
  implementIssue(opts: { cwd: string; prompt: string }): Promise<void>;
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
}

export interface WorkerFailure {
  outcome: 'failed';
  reason: string;
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
    '',
    `Issue title: ${issueTitle}`,
    '',
    'Issue body:',
    issueBody,
  ].join('\n');
  try {
    await agent.implementIssue({ cwd: workDir, prompt });
  } catch (err) {
    return fail(`agent failed: ${err instanceof Error ? err.message : String(err)}`, env.githubToken);
  }

  // 5. Commit anything the agent left uncommitted, then require real work.
  const status = await git(['status', '--porcelain']);
  if (status.stdout.trim() !== '') {
    await git(['add', '-A']);
    const commit = await git(['commit', '-m', `Implement Issue #${env.issue}: ${issueTitle}`]);
    if (commit.code !== 0) {
      return fail(describe('git commit', commit), env.githubToken);
    }
  }
  const ahead = await git(['rev-list', '--count', '@{upstream}..HEAD']);
  const aheadByBranch = ahead.code === 0 ? ahead : await git(['rev-list', '--count', `origin/HEAD..HEAD`]);
  if (aheadByBranch.code === 0 && aheadByBranch.stdout.trim() === '0') {
    return fail(`agent made no changes for Issue #${env.issue}`, env.githubToken);
  }

  // 6. Output leaves the Worker only as a pushed branch...
  log(`pushing ${branch}`);
  const push = await git(['push', '-u', 'origin', branch]);
  if (push.code !== 0) {
    return fail(describe('git push', push), env.githubToken);
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
    return fail(describe('gh pr create', pr), env.githubToken);
  }
  const prUrl = pr.stdout.trim().split('\n').pop() ?? '';

  log(`opened ${prUrl}`);
  return { outcome: 'succeeded', repo: env.repo, issue: env.issue, branch, prUrl };
}
