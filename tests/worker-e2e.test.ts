/**
 * Opt-in end-to-end run of the Worker harness against a real scratch repo.
 * Excluded from the default test run; enable it with:
 *
 *   SOFA_WORKER_E2E=1
 *   WORKER_E2E_REPO=<owner/scratch-repo>   (a throwaway repo you own)
 *   WORKER_E2E_ISSUE=<open issue number in that repo>
 *   GITHUB_TOKEN=<fine-grained PAT scoped to that repo>
 *
 * It exercises the real pipeline (fresh clone, branch, push, PR) with a
 * scripted agent that appends to a file, so no Claude quota is consumed.
 * The pushed branch and PR are left behind for manual inspection.
 */
import { describe, expect, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorker, type Agent } from '../src/worker/harness';
import { spawnRunner } from '../src/worker/runner';

const enabled = process.env.SOFA_WORKER_E2E === '1';

describe.runIf(enabled)('Worker harness end-to-end (scratch repo)', () => {
  it('clones fresh, pushes a branch, and opens a PR', async () => {
    const env = {
      WORKER_REPO: process.env.WORKER_E2E_REPO,
      WORKER_ISSUE: process.env.WORKER_E2E_ISSUE,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      // The scripted agent below stands in for Claude; any value satisfies
      // env validation without consuming subscription quota.
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? 'unused-by-scripted-agent',
    };
    const scriptedAgent: Agent = {
      implementIssue: ({ cwd }) => {
        appendFileSync(join(cwd, 'worker-e2e.log'), `worker e2e ran at ${new Date().toISOString()}\n`);
        return Promise.resolve();
      },
    };

    const outcome = await runWorker(env, {
      runner: spawnRunner,
      agent: scriptedAgent,
      workDir: join(mkdtempSync(join(tmpdir(), 'sofa-worker-e2e-')), 'repo'),
      log: (line) => console.log(`[worker-e2e] ${line}`),
    });

    expect(outcome).toMatchObject({
      outcome: 'succeeded',
      branch: `issue-${env.WORKER_ISSUE}-worker`,
      prUrl: expect.stringContaining('/pull/'),
    });
  }, 120_000);
});

describe.runIf(!enabled)('Worker harness end-to-end', () => {
  it.skip('set SOFA_WORKER_E2E=1 (plus WORKER_E2E_REPO, WORKER_E2E_ISSUE, GITHUB_TOKEN) to run', () => {});
});
