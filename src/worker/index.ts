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
import { runWorker, redactToken, type Agent, type AgentUsage } from './harness.js';
import { spawnRunner } from './runner.js';

/**
 * Pulls the token usage out of the CLI's `--output-format json` result.
 * Best-effort: unparseable output just means usage stays unknown.
 */
function parseAgentUsage(stdout: string): AgentUsage | undefined {
  try {
    const result = JSON.parse(stdout.trim()) as {
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    };
    if (typeof result !== 'object' || result === null || typeof result.usage !== 'object' || result.usage === null) {
      return undefined;
    }
    const count = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0);
    return {
      inputTokens: count(result.usage.input_tokens),
      outputTokens: count(result.usage.output_tokens),
      cacheReadTokens: count(result.usage.cache_read_input_tokens),
      cacheCreationTokens: count(result.usage.cache_creation_input_tokens),
    };
  } catch {
    return undefined;
  }
}

/** Runs the Claude Code CLI non-interactively against the cloned repo. */
const agent: Agent = {
  async implementIssue({ cwd, prompt }) {
    const result = await spawnRunner.run(
      'claude',
      ['-p', prompt, '--permission-mode', 'bypassPermissions', '--output-format', 'json'],
      { cwd },
    );
    process.stderr.write(result.stdout + result.stderr);
    if (result.code !== 0) {
      throw new Error(`claude exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
    }
    // The JSON result carries the SDK's usage metadata for the quota meter.
    return parseAgentUsage(result.stdout);
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
