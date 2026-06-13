import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, win32, type PlatformPath } from 'node:path';

/**
 * Read-only host-filesystem directory browser backing `GET /api/fs/list`.
 *
 * A browser cannot read host paths, but the Sofa server can. This walks the
 * host's directory tree so a user can navigate to a Project directory without
 * knowing its absolute path in advance. It is deliberately dumb: directories
 * only, no git/repo inspection or badging (cf. CONTEXT.md — only full-pipeline
 * Projects must be GitHub repos, and that check stays in `POST /api/projects`).
 *
 * Platform behaviour is injectable so the Windows drive-list pseudo-root and
 * the POSIX `/` top can both be exercised deterministically regardless of the
 * host the tests run on (local Windows, CI ubuntu).
 */

/** One subdirectory in a listing: its display name and absolute path. */
export interface FsEntry {
  name: string;
  path: string;
}

export interface FsListing {
  /** The absolute path being listed (or {@link DRIVE_LIST_ROOT}). */
  current: string;
  /** The absolute path one level up, or `null` at the top of the tree. */
  parent: string | null;
  /** Subdirectories of `current`, dot-prefixed omitted, sorted by name. */
  entries: FsEntry[];
}

/**
 * Synthetic pseudo-root above the Windows drive roots. Navigating up from a
 * drive root (e.g. `C:\`) lands here; listing it enumerates available drives.
 * POSIX has no equivalent — its top is `/`.
 */
export const DRIVE_LIST_ROOT = ':drives:';

/** A listing failure the UI can show inline; carries the HTTP status to use. */
export class FsBrowseError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404,
  ) {
    super(message);
    this.name = 'FsBrowseError';
  }
}

/** A directory entry as returned by `readdir(..., { withFileTypes: true })`. */
interface DirentLike {
  name: string;
  isDirectory(): boolean;
}

export interface FsBrowseOptions {
  /** Defaults to the host platform; override to test the other path semantics. */
  platform?: NodeJS.Platform;
  /** Injectable directory read for testing; defaults to `node:fs/promises`. */
  readdir?: (path: string) => Promise<DirentLike[]>;
  /** Injectable home directory; defaults to `os.homedir()`. */
  homedir?: () => string;
  /** Probe whether a Windows drive root exists; defaults to a `stat` check. */
  driveExists?: (root: string) => Promise<boolean>;
}

async function defaultReaddir(path: string): Promise<DirentLike[]> {
  return readdir(path, { withFileTypes: true });
}

async function defaultDriveExists(root: string): Promise<boolean> {
  try {
    await stat(root);
    return true;
  } catch {
    return false;
  }
}

const DRIVE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

async function listDrives(exists: (root: string) => Promise<boolean>): Promise<FsEntry[]> {
  const found: FsEntry[] = [];
  for (const letter of DRIVE_LETTERS) {
    const root = `${letter}:\\`;
    if (await exists(root)) {
      found.push({ name: root, path: root });
    }
  }
  return found;
}

/** The path one level up, or the platform's top marker (`null` / drive list). */
function computeParent(abs: string, path: PlatformPath, isWindows: boolean): string | null {
  const up = path.dirname(abs);
  // At a root, `dirname` is a fixed point: `/` → `/`, `C:\` → `C:\`. On Windows
  // the top above a drive root is the synthetic drive list; on POSIX it is null.
  if (up === abs) {
    return isWindows ? DRIVE_LIST_ROOT : null;
  }
  return up;
}

async function readSubdirs(
  abs: string,
  read: (path: string) => Promise<DirentLike[]>,
  path: PlatformPath,
): Promise<FsEntry[]> {
  let dirents: DirentLike[];
  try {
    dirents = await read(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new FsBrowseError(`permission denied: ${abs}`, 403);
    }
    if (code === 'ENOENT') {
      throw new FsBrowseError(`no such directory: ${abs}`, 404);
    }
    if (code === 'ENOTDIR') {
      throw new FsBrowseError(`not a directory: ${abs}`, 400);
    }
    throw err;
  }
  return dirents
    // Directories only; dot-prefixed folders (.git, .config, …) are noise here.
    // An entry whose type can't be resolved is skipped rather than failing the
    // whole listing.
    .filter((entry) => {
      if (entry.name.startsWith('.')) return false;
      try {
        return entry.isDirectory();
      } catch {
        return false;
      }
    })
    .map((entry) => ({ name: entry.name, path: path.join(abs, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * List the subdirectories of `requested` (or the home directory when omitted).
 * Throws {@link FsBrowseError} for an unreadable/missing target so the caller
 * can return a clean 4xx instead of a 500.
 */
export async function listDirectory(
  requested: string | undefined,
  opts: FsBrowseOptions = {},
): Promise<FsListing> {
  const platform = opts.platform ?? process.platform;
  const isWindows = platform === 'win32';
  const path = isWindows ? win32 : posix;
  const read = opts.readdir ?? defaultReaddir;
  const home = (opts.homedir ?? homedir)();

  const target = requested && requested.length > 0 ? requested : home;

  // The Windows drive-list pseudo-root: a top with no parent whose "entries"
  // are the available drives.
  if (isWindows && target === DRIVE_LIST_ROOT) {
    return {
      current: DRIVE_LIST_ROOT,
      parent: null,
      entries: await listDrives(opts.driveExists ?? defaultDriveExists),
    };
  }

  const abs = path.resolve(target);
  const entries = await readSubdirs(abs, read, path);
  return { current: abs, parent: computeParent(abs, path, isWindows), entries };
}
