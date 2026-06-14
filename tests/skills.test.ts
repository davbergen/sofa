import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fsSkillSource, type SkillSource } from '../src/server/skills';
import { openDb } from '../src/server/db';
import { createApp } from '../src/server/app';
import { FakeAgent } from '../src/server/fake-agent';
import { skillEntries } from '../src/server/sdk-agent';

/** Builds a fake ~/.claude layout in a temp dir (the injectable seam). */
function makeClaudeDir() {
  return mkdtempSync(join(tmpdir(), 'sofa-claude-'));
}

function writeSkill(root: string, relDir: string, frontmatter: string) {
  const dir = join(root, relDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\nInstructions here.\n`);
}

describe('skill discovery from a ~/.claude directory', () => {
  it('finds skills under skills/<name>/SKILL.md with frontmatter name and description', async () => {
    const claudeDir = makeClaudeDir();
    writeSkill(claudeDir, 'skills/grilling', 'name: grilling\ndescription: Stress-test a plan.');

    const skills = await fsSkillSource(claudeDir).list();

    expect(skills).toMatchObject([{ name: 'grilling', description: 'Stress-test a plan.' }]);
    expect(skills[0].path).toContain('SKILL.md');
  });

  it('falls back to the directory name when frontmatter has no name', async () => {
    const claudeDir = makeClaudeDir();
    writeSkill(claudeDir, 'skills/tdd', 'description: Red-green-refactor.');

    const skills = await fsSkillSource(claudeDir).list();

    expect(skills).toMatchObject([{ name: 'tdd', description: 'Red-green-refactor.' }]);
  });

  it('finds skills nested inside installed plugins', async () => {
    const claudeDir = makeClaudeDir();
    writeSkill(
      claudeDir,
      'plugins/marketplaces/some-marketplace/some-plugin/skills/grill-with-docs',
      'name: grill-with-docs\ndescription: Grill and update docs.',
    );

    const skills = await fsSkillSource(claudeDir).list();

    expect(skills).toMatchObject([{ name: 'grill-with-docs' }]);
  });

  it('lets a user skill shadow a same-named plugin skill, sorted by name', async () => {
    const claudeDir = makeClaudeDir();
    writeSkill(claudeDir, 'skills/grilling', 'name: grilling\ndescription: User copy.');
    writeSkill(claudeDir, 'plugins/p/skills/grilling', 'name: grilling\ndescription: Plugin copy.');
    writeSkill(claudeDir, 'skills/another', 'name: another\ndescription: Another skill.');

    const skills = await fsSkillSource(claudeDir).list();

    expect(skills).toMatchObject([
      { name: 'another' },
      { name: 'grilling', description: 'User copy.' },
    ]);
  });

  it('returns an empty list when the directory does not exist', async () => {
    const skills = await fsSkillSource(join(makeClaudeDir(), 'nope')).list();

    expect(skills).toEqual([]);
  });
});

describe('GET /api/skills', () => {
  it('lists discoverable skills with name and description', async () => {
    const claudeDir = makeClaudeDir();
    writeSkill(claudeDir, 'skills/grilling', 'name: grilling\ndescription: Stress-test a plan.');
    const app = createApp(openDb(':memory:'), new FakeAgent(), undefined, fsSkillSource(claudeDir));

    const res = await app.request('/api/skills');

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject([
      { name: 'grilling', description: 'Stress-test a plan.' },
    ]);
  });

  it('reports a failing skill source as a 500 with an error message', async () => {
    const failing: SkillSource = {
      list: () => Promise.reject(new Error('disk on fire')),
    };
    const app = createApp(openDb(':memory:'), new FakeAgent(), undefined, failing);

    const res = await app.request('/api/skills');

    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain('disk on fire');
  });
});

describe('skillEntries — feeding a bare skill name to the SDK', () => {
  // Regression for #92: a Grilling Session named `grill-with-docs` silently
  // started with no skill because the plugin-installed copy is registered as
  // `mattpocock-skills:grill-with-docs`, which an exact-name SDK match misses.
  it('expands a bare name to both the exact name and the `:name` suffix form', () => {
    expect(skillEntries('grill-with-docs')).toEqual(['grill-with-docs', ':grill-with-docs']);
  });

  it('passes a pre-qualified `plugin:skill` name through unchanged', () => {
    expect(skillEntries('mattpocock-skills:grill-with-docs')).toEqual([
      'mattpocock-skills:grill-with-docs',
    ]);
  });
});
