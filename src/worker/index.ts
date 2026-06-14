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
import { runWorker, redactToken, makeClaudeAgent } from './harness.js';
import { spawnRunner } from './runner.js';

const workDir = mkdtempSync(join(process.env.WORKER_WORKDIR ?? tmpdir(), 'sofa-worker-'));
const token = process.env.GITHUB_TOKEN ?? '';

// Redact the GitHub token from every stream-formatted activity line before it
// reaches stderr — the docker adapter reads those lines verbatim into the
// activity SSE feed, and any leak would surface to the UI.
const agent = makeClaudeAgent(
  spawnRunner,
  process.env.WORKER_MODEL?.trim() || undefined,
  (text) => process.stderr.write(redactToken(text, token)),
);

const outcome = await runWorker(process.env, {
  runner: spawnRunner,
  agent,
  workDir: join(workDir, 'repo'),
  log: (line) => process.stderr.write(`[worker] ${line}\n`),
});

process.stdout.write(redactToken(JSON.stringify(outcome), token) + '\n');
process.exit(outcome.outcome === 'succeeded' ? 0 : 1);
