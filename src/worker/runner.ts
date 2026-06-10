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
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', (err) => resolvePromise({ code: 127, stdout, stderr: String(err) }));
      child.on('close', (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
    });
  },
};
