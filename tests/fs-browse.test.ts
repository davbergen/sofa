import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DRIVE_LIST_ROOT,
  FsBrowseError,
  listDirectory,
  type FsBrowseOptions,
} from '../src/server/fs-browse';

/** A `readdir(..., { withFileTypes: true })` stand-in for the injected reader. */
function dirent(name: string, isDir = true) {
  return { name, isDirectory: () => isDir };
}

/** A fake readdir over a fixed name→listing map; unknown paths throw ENOENT. */
function fakeReaddir(map: Record<string, ReturnType<typeof dirent>[]>) {
  return (path: string) => {
    const entries = map[path];
    if (!entries) {
      const err: NodeJS.ErrnoException = new Error(`ENOENT: ${path}`);
      err.code = 'ENOENT';
      return Promise.reject(err);
    }
    return Promise.resolve(entries);
  };
}

function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'sofa-fs-'));
  mkdirSync(join(root, 'alpha'));
  mkdirSync(join(root, 'beta'));
  mkdirSync(join(root, '.hidden'));
  writeFileSync(join(root, 'a-file.txt'), 'not a dir');
  return root;
}

describe('listDirectory (real filesystem)', () => {
  it('starts at the home directory when no path is given', async () => {
    const home = makeTree();
    const listing = await listDirectory(undefined, { homedir: () => home });

    expect(listing.current).toBe(home);
    expect(listing.parent).toBe(dirname(home));
    expect(listing.entries.map((e) => e.name)).toEqual(['alpha', 'beta']);
  });

  it('omits dot-prefixed directories and non-directories', async () => {
    const home = makeTree();
    const listing = await listDirectory(home, { homedir: () => home });

    const names = listing.entries.map((e) => e.name);
    expect(names).not.toContain('.hidden');
    expect(names).not.toContain('a-file.txt');
    expect(names).toEqual(['alpha', 'beta']);
  });

  it('navigates into a subdirectory and back up', async () => {
    const home = makeTree();
    const child = join(home, 'alpha');
    mkdirSync(join(child, 'gamma'));

    const into = await listDirectory(child, { homedir: () => home });
    expect(into.current).toBe(child);
    expect(into.parent).toBe(home);
    expect(into.entries.map((e) => e.name)).toEqual(['gamma']);

    const back = await listDirectory(into.parent!, { homedir: () => home });
    expect(back.current).toBe(home);
    expect(back.entries.map((e) => e.name)).toContain('alpha');
  });

  it('reports a missing directory as a 404 FsBrowseError, never a crash', async () => {
    await expect(
      listDirectory(join(tmpdir(), 'sofa-fs-does-not-exist-xyz')),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('listDirectory (POSIX semantics)', () => {
  const posix: FsBrowseOptions = { platform: 'linux', readdir: fakeReaddir({ '/': [dirent('etc')] }) };

  it('has no parent at the root', async () => {
    const listing = await listDirectory('/', posix);
    expect(listing.current).toBe('/');
    expect(listing.parent).toBeNull();
    expect(listing.entries.map((e) => e.name)).toEqual(['etc']);
  });
});

describe('listDirectory (Windows semantics)', () => {
  it('goes up from a drive root to the synthetic drive list', async () => {
    const listing = await listDirectory('C:\\', {
      platform: 'win32',
      readdir: fakeReaddir({ 'C:\\': [dirent('Users')] }),
    });
    expect(listing.current).toBe('C:\\');
    expect(listing.parent).toBe(DRIVE_LIST_ROOT);
  });

  it('lists available drives at the synthetic drive-list root', async () => {
    const listing = await listDirectory(DRIVE_LIST_ROOT, {
      platform: 'win32',
      driveExists: (root) => Promise.resolve(root === 'C:\\' || root === 'D:\\'),
    });
    expect(listing.current).toBe(DRIVE_LIST_ROOT);
    expect(listing.parent).toBeNull();
    expect(listing.entries.map((e) => e.path)).toEqual(['C:\\', 'D:\\']);
  });
});

describe('listDirectory error mapping', () => {
  it('maps EACCES to a 403 FsBrowseError', async () => {
    const readdir = () => {
      const err: NodeJS.ErrnoException = new Error('denied');
      err.code = 'EACCES';
      return Promise.reject(err);
    };
    const error = await listDirectory('/locked', { platform: 'linux', readdir }).catch((e) => e);
    expect(error).toBeInstanceOf(FsBrowseError);
    expect(error.status).toBe(403);
  });
});
