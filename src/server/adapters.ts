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
import type {
  ContainerAdapter,
  GitHubAdapter,
  OpenPrForIssue,
  WorkerEvent,
} from './ports.js';
import { coerceUsage } from './usage.js';

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command without a shell; never throws, failures surface via code. */
export function exec(cmd: string, args: string[], cwd?: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    // shell: false on every platform — including Windows — so Node passes argv
    // entries to the child verbatim. With shell: true, cmd.exe re-splits each
    // argument on whitespace, which breaks any `gh --title "two words"` /
    // `--body "with spaces"` invocation (and quotes, %, &). Windows
    // CreateProcess auto-appends `.exe` and walks PATH, so `gh`/`git`/`docker`
    // still resolve without a shell — do not "fix" this back to shell: true.
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
export const READY_LABEL = process.env.SOFA_READY_LABEL ?? 'ready-for-agent';

/**
 * Parses all issue numbers from `Blocked by #N` declarations in an issue body.
 * Case-insensitive; handles comma/space-separated lists; deduplicates.
 */
export function parseBlockedBy(body: string): number[] {
  const seen = new Set<number>();
  // Match "Blocked by" followed by one or more #N references separated by commas/spaces.
  const lineRe = /blocked\s+by\s+(#\d+(?:\s*,\s*#\d+)*)/gi;
  let lineMatch: RegExpExecArray | null;
  while ((lineMatch = lineRe.exec(body)) !== null) {
    const refs = lineMatch[1];
    const numRe = /#(\d+)/g;
    let numMatch: RegExpExecArray | null;
    while ((numMatch = numRe.exec(refs)) !== null) {
      seen.add(Number(numMatch[1]));
    }
  }
  return [...seen];
}

/**
 * Label that marks a GitHub issue as a PRD. PRDs aren't dispatchable, so they
 * must never appear in Ready Issues even if mislabelled `ready-for-agent`.
 * Mirrors PRD_LABEL in app.ts; duplicated here to avoid a server→app import.
 */
const PRD_LABEL = 'prd';

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
      const [res, openRes] = await Promise.all([
        exec(
          'gh',
          ['issue', 'list', '--state', 'open', '--label', READY_LABEL, '--json', 'number,title,url,labels,body'],
          dir,
        ),
        exec('gh', ['issue', 'list', '--state', 'open', '--json', 'number', '--limit', '1000'], dir),
      ]);
      if (res.code !== 0) {
        throw new Error(`gh issue list failed (exit ${res.code}): ${res.stderr.trim().slice(0, 300)}`);
      }
      if (openRes.code !== 0) {
        throw new Error(`gh issue list (open set) failed (exit ${openRes.code}): ${openRes.stderr.trim().slice(0, 300)}`);
      }
      const openSet = new Set<number>(
        (JSON.parse(openRes.stdout) as Array<{ number: number }>).map((r) => r.number),
      );
      const rows = JSON.parse(res.stdout) as Array<{
        number: number;
        title: string;
        url: string;
        labels: Array<{ name: string }>;
        body: string;
      }>;
      return rows
        .filter((row) => !row.labels.some((l) => l.name === PRD_LABEL))
        .map(({ number, title, url, body }) => ({
          number,
          title,
          url,
          blockedBy: parseBlockedBy(body ?? '').filter((n) => openSet.has(n)),
        }));
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

    async getPrState(dir, prUrl) {
      const res = await exec('gh', ['pr', 'view', prUrl, '--json', 'state', '--jq', '.state'], dir);
      if (res.code !== 0) {
        throw new Error(`gh pr view failed (exit ${res.code}): ${res.stderr.trim().slice(0, 300)}`);
      }
      const state = res.stdout.trim();
      if (state !== 'OPEN' && state !== 'MERGED' && state !== 'CLOSED') {
        throw new Error(`gh pr view returned unexpected state: ${state || '(empty)'}`);
      }
      return state;
    },

    async listOpenPrsByIssue(dir) {
      const res = await exec(
        'gh',
        ['pr', 'list', '--state', 'open', '--json', 'number,headRefName,url'],
        dir,
      );
      if (res.code !== 0) {
        throw new Error(`gh pr list failed (exit ${res.code}): ${res.stderr.trim().slice(0, 300)}`);
      }
      const rows = JSON.parse(res.stdout) as Array<{
        number: number;
        headRefName: string;
        url: string;
      }>;
      const out: OpenPrForIssue[] = [];
      for (const row of rows) {
        const match = /^issue-(\d+)-/.exec(row.headRefName);
        if (!match) continue;
        out.push({ issue: Number(match[1]), prNumber: row.number, prUrl: row.url });
      }
      return out;
    },

    async ensureLabels(dir, labels) {
      // Read what's already there so existing labels are left untouched — we
      // only create the ones that are missing (no `--force`, no overwrite).
      const list = await exec('gh', ['label', 'list', '--json', 'name', '--jq', '.[].name'], dir);
      if (list.code !== 0) {
        throw new Error(`gh label list failed (exit ${list.code}): ${list.stderr.trim().slice(0, 300)}`);
      }
      const existing = new Set(list.stdout.split('\n').map((s) => s.trim()).filter(Boolean));
      for (const label of labels) {
        if (existing.has(label)) continue;
        const create = await exec('gh', ['label', 'create', label], dir);
        // A concurrent create (or a label added between the list and now) makes
        // gh exit non-zero with "already exists" — that's the desired end state,
        // so tolerate it; anything else is a real failure.
        if (create.code !== 0 && !/already exists/i.test(create.stderr)) {
          throw new Error(
            `gh label create ${label} failed (exit ${create.code}): ${create.stderr.trim().slice(0, 300)}`,
          );
        }
      }
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
      if (opts.model) {
        args.push('-e', `WORKER_MODEL=${opts.model}`);
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
