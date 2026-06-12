/**
 * Per-Project Sofa configuration: an optional `sofa.json` at the Project's
 * repo root. Today it carries a single setting, `workerImage`, which overrides
 * the generic Worker container image for Projects that need another toolchain.
 * Zero config is the norm — a missing file means "use the defaults".
 *
 * An invalid file is a hard dispatch error, never a silent fallback: a typo'd
 * override that quietly launched the generic image would be much harder to
 * diagnose than an upfront rejection.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Name of the config file looked up at the Project's repo root. */
export const SOFA_CONFIG_FILE = 'sofa.json';

export interface SofaConfig {
  /** Alternative Worker container image; omitted means the generic image. */
  workerImage?: string;
}

/** A present-but-unusable `sofa.json`; the message is safe to show the user. */
export class SofaConfigError extends Error {}

/**
 * Reads the Project's `sofa.json`. Returns `{}` when the file does not exist;
 * throws {@link SofaConfigError} when it exists but is malformed JSON, is not
 * an object, or carries a `workerImage` that is not a non-empty string.
 */
export async function readSofaConfig(dir: string): Promise<SofaConfig> {
  let raw: string;
  try {
    raw = await readFile(join(dir, SOFA_CONFIG_FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw new SofaConfigError(
      `${SOFA_CONFIG_FILE} could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SofaConfigError(
      `${SOFA_CONFIG_FILE} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SofaConfigError(`${SOFA_CONFIG_FILE} must contain a JSON object`);
  }

  const { workerImage } = parsed as Record<string, unknown>;
  if (workerImage === undefined) {
    return {};
  }
  if (typeof workerImage !== 'string' || workerImage.trim() === '') {
    throw new SofaConfigError(`${SOFA_CONFIG_FILE}: workerImage must be a non-empty string`);
  }
  return { workerImage: workerImage.trim() };
}
