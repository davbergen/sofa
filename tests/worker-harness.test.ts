import { describe, expect, it } from 'vitest';
import {
  parseWorkerEnv,
  redactToken,
  runWorker,
  type Agent,
  type CommandResult,
  type CommandRunner,
  type WorkerFailure,
} from '../src/worker/harness';

const TOKEN = 'ghp_secret123';

const ENV = {
  WORKER_REPO: 'davbergen/scratch',
  WORKER_ISSUE: '7',
  GITHUB_TOKEN: TOKEN,
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-xyz',
};

const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });
const failWith = (stderr: string, code = 1): CommandResult => ({ code, stdout: '', stderr });

/**
 * Fake runner: records every call and answers from a list of rules matched
 * against the joined command line, first match wins. Unmatched calls succeed.
 */
function makeRunner(rules: Array<[pattern: RegExp, result: CommandResult]> = []) {
  const calls: string[] = [];
  const runner: CommandRunner = {
    run(cmd, args) {
      const line = [cmd, ...args].join(' ');
      calls.push(line);
      const rule = rules.find(([pattern]) => pattern.test(line));
      return Promise.resolve(rule ? rule[1] : ok());
    },
  };
  return { runner, calls };
}

const idleAgent: Agent = { implementIssue: () => Promise.resolve() };

/** Default happy-path rules: issue readable, one commit ahead, PR URL out. */
function happyRules(): Array<[RegExp, CommandResult]> {
  return [
    [/^gh issue view/, ok(JSON.stringify({ title: 'Add a thing', body: 'Details.' }))],
    [/^git rev-list --count/, ok('1\n')],
    [/^gh pr create/, ok('https://github.com/davbergen/scratch/pull/12\n')],
    [/^git status --porcelain/, ok('')],
  ];
}

function run(rules: Array<[RegExp, CommandResult]>, agent: Agent = idleAgent) {
  const { runner, calls } = makeRunner(rules);
  const outcome = runWorker(ENV, { runner, agent, workDir: '/work/repo' });
  return { outcome, calls };
}

describe('parseWorkerEnv', () => {
  it('fails listing every missing variable', () => {
    const result = parseWorkerEnv({ WORKER_REPO: 'a/b' }) as WorkerFailure;
    expect(result.outcome).toBe('failed');
    expect(result.reason).toBe(
      'missing required env: WORKER_ISSUE, GITHUB_TOKEN, CLAUDE_CODE_OAUTH_TOKEN',
    );
  });

  it('rejects a repo that is not owner/name', () => {
    const result = parseWorkerEnv({ ...ENV, WORKER_REPO: 'https://github.com/a/b' }) as WorkerFailure;
    expect(result.reason).toContain('owner/name');
  });

  it('rejects a non-numeric issue reference', () => {
    const result = parseWorkerEnv({ ...ENV, WORKER_ISSUE: 'twelve' }) as WorkerFailure;
    expect(result.reason).toContain('positive integer');
  });

  it('accepts a complete environment', () => {
    expect(parseWorkerEnv(ENV)).toMatchObject({ repo: 'davbergen/scratch', issue: 7 });
  });
});

describe('runWorker', () => {
  it('clones fresh, runs the agent, pushes a branch, and opens a PR', async () => {
    const seen: string[] = [];
    const agent: Agent = {
      implementIssue: ({ cwd, prompt }) => {
        seen.push(cwd, prompt);
        return Promise.resolve();
      },
    };
    const { outcome, calls } = run(happyRules(), agent);

    expect(await outcome).toEqual({
      outcome: 'succeeded',
      repo: 'davbergen/scratch',
      issue: 7,
      branch: 'issue-7-worker',
      prUrl: 'https://github.com/davbergen/scratch/pull/12',
    });
    expect(calls[0]).toBe(
      `git clone https://x-access-token:${TOKEN}@github.com/davbergen/scratch.git /work/repo`,
    );
    expect(calls).toContainEqual(expect.stringContaining('git checkout -b issue-7-worker'));
    expect(calls).toContainEqual(expect.stringContaining('git push -u origin issue-7-worker'));
    const prCall = calls.find((c) => c.startsWith('gh pr create'));
    expect(prCall).toContain('--head issue-7-worker');
    expect(prCall).toContain('Closes #7');
    // The agent saw the clone and the one Issue it must implement.
    expect(seen[0]).toBe('/work/repo');
    expect(seen[1]).toContain('issue #7');
    expect(seen[1]).toContain('Add a thing');
    expect(seen[1]).toContain('Details.');
  });

  it('commits work the agent left uncommitted before pushing', async () => {
    const rules = happyRules().filter(([p]) => String(p) !== String(/^git status --porcelain/));
    rules.push([/^git status --porcelain/, ok(' M src/thing.ts\n')]);
    const { outcome, calls } = run(rules);

    expect((await outcome).outcome).toBe('succeeded');
    expect(calls).toContainEqual(expect.stringContaining('git commit -m Implement Issue #7'));
  });

  it('targets the requested base branch when one is given', async () => {
    const { runner, calls } = makeRunner(happyRules());
    await runWorker({ ...ENV, WORKER_BASE_BRANCH: 'develop' }, { runner, agent: idleAgent, workDir: '/work/repo' });

    expect(calls.find((c) => c.startsWith('gh pr create'))).toContain('--base develop');
  });

  it('fails with a readable reason when the clone fails', async () => {
    const { outcome } = run([[/^git clone/, failWith('fatal: repository not found', 128)]]);

    expect(await outcome).toEqual({
      outcome: 'failed',
      reason: 'git clone failed (exit 128): fatal: repository not found',
    });
  });

  it('fails when the Issue cannot be read', async () => {
    const { outcome } = run([[/^gh issue view/, failWith('GraphQL: Could not resolve')]]);

    expect((await outcome) as WorkerFailure).toMatchObject({
      outcome: 'failed',
      reason: expect.stringContaining('reading Issue #7'),
    });
  });

  it('fails when the agent throws', async () => {
    const agent: Agent = { implementIssue: () => Promise.reject(new Error('quota exhausted')) };
    const { outcome } = run(happyRules(), agent);

    expect(await outcome).toEqual({ outcome: 'failed', reason: 'agent failed: quota exhausted' });
  });

  it('fails when the agent made no changes instead of opening an empty PR', async () => {
    const rules = happyRules().filter(([p]) => String(p) !== String(/^git rev-list --count/));
    rules.push([/^git rev-list --count/, ok('0\n')]);
    const { outcome, calls } = run(rules);

    expect(await outcome).toEqual({
      outcome: 'failed',
      reason: 'agent made no changes for Issue #7',
    });
    expect(calls.find((c) => c.startsWith('git push'))).toBeUndefined();
  });

  it('fails when the push is rejected', async () => {
    const rules = happyRules();
    rules.unshift([/^git push/, failWith('remote: permission denied', 128)]);
    const { outcome } = run(rules);

    expect((await outcome) as WorkerFailure).toMatchObject({
      outcome: 'failed',
      reason: expect.stringContaining('git push failed'),
    });
  });

  it('never leaks the GitHub token in failure reasons', async () => {
    const { outcome } = run([
      [/^git clone/, failWith(`fatal: unable to access https://x-access-token:${TOKEN}@github.com/`, 128)],
    ]);

    const result = (await outcome) as WorkerFailure;
    expect(result.reason).not.toContain(TOKEN);
    expect(result.reason).toContain('***');
  });
});

describe('redactToken', () => {
  it('replaces every occurrence and tolerates an empty token', () => {
    expect(redactToken(`a ${TOKEN} b ${TOKEN}`, TOKEN)).toBe('a *** b ***');
    expect(redactToken('untouched', '')).toBe('untouched');
  });
});
