// Skill discovery: Sofa reads skills from the user's existing ~/.claude setup
// (the same files the Claude Code CLI uses — one source of truth). Skills live
// in <claudeDir>/skills/**/<name>/SKILL.md and inside installed plugins under
// <claudeDir>/plugins/**/skills/**/<name>/SKILL.md. The directory is an
// injectable seam so tests point at a temp dir instead of the real ~/.claude.
//
// Sofa also ships its own first-party skills in-repo (see `sofa-skills/`),
// surfaced by `repoBundledSkillSource` and composed in front of the user
// source so Sofa's bundled triage skill is available without the user
// installing anything into ~/.claude.
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export interface Skill {
  /** The name the SDK's `skills` option matches: SKILL.md frontmatter `name`, falling back to the directory name. */
  name: string;
  description: string;
  /** Absolute path of the SKILL.md the metadata came from. */
  path: string;
}

/** Where Sofa finds loadable skills; injectable so tests use a temp dir. */
export interface SkillSource {
  list(): Promise<Skill[]>;
}

// The CLI nests plugin skills fairly deep, e.g.
// plugins/marketplaces/<marketplace>/<plugin>/skills/<category>/<name>/SKILL.md.
const MAX_DEPTH = 8;
const SKIPPED_DIRS = new Set(['node_modules']);

export function fsSkillSource(claudeDir: string): SkillSource {
  return {
    async list(): Promise<Skill[]> {
      const byName = new Map<string, Skill>();
      for (const root of [join(claudeDir, 'skills'), join(claudeDir, 'plugins')]) {
        for (const path of await findSkillFiles(root, MAX_DEPTH)) {
          const skill = await parseSkillFile(path);
          // First occurrence wins: a skill in ~/.claude/skills shadows the
          // same-named skill shipped by a plugin, matching SDK name matching.
          if (skill && !byName.has(skill.name)) {
            byName.set(skill.name, skill);
          }
        }
      }
      return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}

/**
 * Lists skills from a single repo-bundled plugin directory laid out as a
 * Claude Code local plugin: `<bundleDir>/skills/<name>/SKILL.md`. The
 * companion `<bundleDir>/.claude-plugin/plugin.json` is what makes the SDK
 * load it as a plugin at runtime (see `SdkAgent`); for the *listing*, only
 * the `skills/` tree matters.
 */
export function repoBundledSkillSource(bundleDir: string): SkillSource {
  return {
    async list(): Promise<Skill[]> {
      const byName = new Map<string, Skill>();
      for (const path of await findSkillFiles(join(bundleDir, 'skills'), MAX_DEPTH)) {
        const skill = await parseSkillFile(path);
        if (skill && !byName.has(skill.name)) {
          byName.set(skill.name, skill);
        }
      }
      return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}

/**
 * Merges several skill sources into one, first-source-wins on name collisions.
 * Sofa passes the user `~/.claude` source first and the in-repo bundled
 * source second so a same-named user skill still shadows the bundled one
 * (matching the user-shadows-plugin precedence inside `fsSkillSource`),
 * while bundled skills remain discoverable when no user override exists.
 */
export function composeSkillSources(...sources: SkillSource[]): SkillSource {
  return {
    async list(): Promise<Skill[]> {
      const byName = new Map<string, Skill>();
      for (const source of sources) {
        for (const skill of await source.list()) {
          if (!byName.has(skill.name)) byName.set(skill.name, skill);
        }
      }
      return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}

async function findSkillFiles(dir: string, depth: number): Promise<string[]> {
  if (depth < 0) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name === 'SKILL.md') {
      found.push(join(dir, entry.name));
    } else if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIPPED_DIRS.has(entry.name)) {
      found.push(...(await findSkillFiles(join(dir, entry.name), depth - 1)));
    }
  }
  return found;
}

async function parseSkillFile(path: string): Promise<Skill | null> {
  const text = await readFile(path, 'utf8').catch(() => null);
  if (text === null) return null;
  const frontmatter = readFrontmatter(text);
  return {
    name: frontmatter.get('name') ?? basename(dirname(path)),
    description: frontmatter.get('description') ?? '',
    path,
  };
}

/** Minimal single-line `key: value` frontmatter reader — all SKILL.md needs. */
function readFrontmatter(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return fields;
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const value = line.slice(colon + 1).trim();
    fields.set(line.slice(0, colon).trim(), value.replace(/^(["'])(.*)\1$/, '$2'));
  }
  return fields;
}
