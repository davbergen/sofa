/**
 * Worker container entrypoint. Reads its contract from the environment:
 *
 *   WORKER_REPO              owner/name of the GitHub repository
 *   WORKER_ISSUE             Issue number to implement
 *   GITHUB_TOKEN             repo-scoped GitHub token
 *   CLAUDE_CODE_OAUTH_TOKEN  Claude subscription OAuth token
 *   WORKER_BASE_BRANCH       optional PR base branch
 *
 * Always ends with one machine-readable JSON line on stdout and exits 0 on
 * success, 1 on failure. No host volumes; output leaves only via git push.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorker, redactToken, type Agent } from './harness.js';
import { spawnRunner } from './runner.js';

/** Runs the Claude Code CLI non-interactively against the cloned repo. */
const agent: Agent = {
  async implementIssue({ cwd, prompt }) {
    const result = await spawnRunner.run(
      'claude',
      ['-p', prompt, '--permission-mode', 'bypassPermissions'],
      { cwd },
    );
    process.stderr.write(result.stdout + result.stderr);
    if (result.code !== 0) {
      throw new Error(`claude exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
    }
  },
};

const workDir = mkdtempSync(join(process.env.WORKER_WORKDIR ?? tmpdir(), 'sofa-worker-'));
const token = process.env.GITHUB_TOKEN ?? '';

const outcome = await runWorker(process.env, {
  runner: spawnRunner,
  agent,
  workDir: join(workDir, 'repo'),
  log: (line) => process.stderr.write(`[worker] ${line}\n`),
});

process.stdout.write(redactToken(JSON.stringify(outcome), token) + '\n');
process.exit(outcome.outcome === 'succeeded' ? 0 : 1);
