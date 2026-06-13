/**
 * Real adapters for Sofa's external boundaries.
 *
 * - GitHub: shells out to the `gh` CLI inside the Project directory, so it
 *   uses the directory's origin remote and the host's gh authentication.
 * - Container: `docker run`s the Worker image from worker/Dockerfile with the
 *   env-var contract from docs/worker-setup.md and no host mounts. Lifecycle
 *   phases are derived from the harness's `[worker] ...` stderr lines and the
 *   outcome from its final machine-readable JSON stdout line.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ContainerAdapter, GitHubAdapter, ReadyIssue, WorkerEvent } from './ports.js';
import { coerceUsage } from './usage.js';

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command without a shell; never throws, failures surface via code. */
function exec(cmd: string, args: string[], cwd?: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err) => resolve({ code: 127, stdout, stderr: String(err) }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** The label that marks an Issue as ready for a Worker. */
const READY_LABEL = process.env.SOFA_READY_LABEL ?? 'ready-for-agent';

export function ghGitHubAdapter(): GitHubAdapter {
  return {
    async resolveRepo(dir) {
      const res = await exec('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], dir);
      if (res.code !== 0) {
        throw new Error(`gh repo view failed (exit ${res.code}): ${res.stderr.trim().slice(0, 300)}`);
      }
      return res.stdout.trim();
    },

    async listReadyIssues(dir) {
      const res = await exec(
        'gh',
        ['issue', 'list', '--state', 'open', '--label', READY_LABEL, '--json', 'number,title,url'],
        dir,
      );
      if (res.code !== 0) {
        throw new Error(`gh issue list failed (exit ${res.code}): ${res.stderr.trim().slice(0, 300)}`);
      }
      return JSON.parse(res.stdout) as ReadyIssue[];
    },

    async createIssue(dir, issue) {
      const args = ['issue', 'create', '--title', issue.title, '--body', issue.body];
      for (const label of issue.labels) {
        args.push('--label', label);
      }
      const res = await exec('gh', args, dir);
      if (res.code !== 0) {
        throw new Error(`gh issue create failed (exit ${res.code}): ${res.stderr.trim().slice(0, 300)}`);
      }
      // gh prints the new issue's URL as the last stdout line.
      const url = res.stdout.trim().split('\n').pop() ?? '';
      const number = Number(/\/issues\/(\d+)/.exec(url)?.[1]);
      if (!Number.isInteger(number)) {
        throw new Error(`gh issue create returned an unexpected URL: ${url || '(empty)'}`);
      }
      return { number, url };
    },
  };
}

/** Maps the harness's stderr log lines onto lifecycle phases. */
const PHASE_PATTERNS: Array<[RegExp, 'cloning' | 'working' | 'pushing']> = [
  [/\[worker\] cloning/, 'cloning'],
  [/\[worker\] implementing/, 'working'],
  [/\[worker\] pushing/, 'pushing'],
];

/** Parses the Worker's final JSON outcome line into a terminal event. */
export function parseOutcomeLine(stdout: string, exitCode: number): WorkerEvent {
  const lastLine = stdout.trim().split('\n').pop() ?? '';
  try {
    const outcome = JSON.parse(lastLine) as {
      outcome: string;
      prUrl?: string;
      reason?: string;
      usage?: unknown;
    };
    const usage = coerceUsage(outcome.usage);
    if (outcome.outcome === 'succeeded' && outcome.prUrl) {
      return { type: 'succeeded', prUrl: outcome.prUrl, ...(usage ? { usage } : {}) };
    }
    return {
      type: 'failed',
      reason: outcome.reason ?? 'worker reported failure without a reason',
      ...(usage ? { usage } : {}),
    };
  } catch {
    return { type: 'failed', reason: `worker exited ${exitCode} without a parseable outcome line` };
  }
}

export function dockerContainerAdapter(image = process.env.SOFA_WORKER_IMAGE ?? 'sofa-worker'): ContainerAdapter {
  return {
    startWorker(opts, onEvent) {
      // Named so the kill switch can `docker rm -f` this exact container.
      const name = `sofa-worker-${randomUUID().slice(0, 8)}`;
      // Secrets are passed through from the server's environment by name
      // (`-e NAME` with no value) so tokens never appear in the argv.
      const args = [
        'run', '--rm', '--name', name,
        '-e', `WORKER_REPO=${opts.repo}`,
        '-e', `WORKER_ISSUE=${opts.issue}`,
        '-e', 'GITHUB_TOKEN',
        '-e', 'CLAUDE_CODE_OAUTH_TOKEN',
      ];
      if (opts.baseBranch) {
        args.push('-e', `WORKER_BASE_BRANCH=${opts.baseBranch}`);
      }
      args.push(opts.image ?? image);

      const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      let stdout = '';
      let stderrBuffer = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => {
        const text = d.toString();
        for (const [pattern, phase] of PHASE_PATTERNS) {
          if (pattern.test(text)) {
            onEvent({ type: 'phase', phase });
          }
        }
        // Every complete stderr line is Worker activity (the harness mirrors
        // the agent's output onto stderr): tool calls, files touched, tests.
        stderrBuffer += text;
        const lines = stderrBuffer.split('\n');
        stderrBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const message = line.trim();
          if (message) {
            onEvent({ type: 'activity', message });
          }
        }
      });
      child.on('error', (err) => {
        onEvent({ type: 'failed', reason: `failed to launch docker: ${String(err)}` });
      });
      child.on('close', (code) => {
        onEvent(parseOutcomeLine(stdout, code ?? 1));
      });

      return {
        async stop() {
          // Force-remove kills the container; exec never throws and a missing
          // container (already finished) is fine — stop is idempotent.
          await exec('docker', ['rm', '-f', name]);
        },
      };
    },
  };
}
