import { spawn } from 'node:child_process';
import type { CommandResult, CommandRunner } from './harness.js';

/** Real CommandRunner backed by child_process.spawn; never throws. */
export const spawnRunner: CommandRunner = {
  run(cmd, args, opts) {
    return new Promise<CommandResult>((resolvePromise) => {
      const child = spawn(cmd, args, {
        cwd: opts?.cwd,
        env: { ...process.env, ...opts?.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
      let stdout = '';
      let stderr = '';
      // When the caller wants stdout line-by-line (the Worker uses this to
      // parse the agent's `stream-json` output as it arrives) we still
      // accumulate the full buffer — the run-end contract is unchanged.
      const onLine = opts?.onStdoutLine;
      if (onLine) {
        let pending = '';
        child.stdout.on('data', (d: Buffer) => {
          const text = d.toString();
          stdout += text;
          pending += text;
          const lines = pending.split('\n');
          pending = lines.pop() ?? '';
          for (const line of lines) {
            if (line.length > 0) onLine(line);
          }
        });
        child.stdout.on('end', () => {
          if (pending.length > 0) onLine(pending);
        });
      } else {
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      }
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', (err) => resolvePromise({ code: 127, stdout, stderr: String(err) }));
      child.on('close', (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
    });
  },
};
