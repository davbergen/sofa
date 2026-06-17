import { describe, expect, it } from 'vitest';
import { exec } from '../src/server/adapters';

describe('exec', () => {
  // The bug we are guarding against: spawn(..., { shell: true }) on Windows
  // makes cmd.exe re-split each argv entry on whitespace, so `gh --title
  // "two words"` arrives at gh as two arguments and gh errors with
  // "unknown arguments". Spawning without a shell must pass argv verbatim.
  it('passes a multi-word argument to the child as a single argv entry', async () => {
    const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)));';
    const arg = 'two words with spaces';
    const res = await exec(process.execPath, ['-e', script, '--', arg]);
    expect(res.code).toBe(0);
    const argv = JSON.parse(res.stdout) as string[];
    // Node's `-e` consumes everything after `--` as positional argv; the
    // multi-word arg must arrive as one entry, not three.
    expect(argv).toContain(arg);
  });

  it('preserves shell-special characters (quotes, %, &) verbatim', async () => {
    const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)));';
    const arg = 'a "quoted" & %weird% value';
    const res = await exec(process.execPath, ['-e', script, '--', arg]);
    expect(res.code).toBe(0);
    const argv = JSON.parse(res.stdout) as string[];
    expect(argv).toContain(arg);
  });
});
