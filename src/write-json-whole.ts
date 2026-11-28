import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Writes `value` as JSON to `path` whole: to a file beside it, then renamed
 * over it, so a host or a machine that stops mid-write leaves what was
 * there, and a reader never sees half a write (#740). A link is followed to
 * its target, which the rename replaces. `mode` is the file's on creation
 * and on overwrite alike, since the renamed file is new. `replacer` is
 * JSON.stringify's. Every JSON file the host rewrites goes through here, by
 * test (test/json-written-whole.test.ts).
 */
export function writeJsonWhole(
  path: string,
  value: unknown,
  options: { mode?: number; replacer?: (key: string, value: unknown) => unknown } = {},
): void {
  const target = isLink(path) ? realpathSync(path) : path;
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w', options.mode ?? 0o666);
  try {
    writeFileSync(fd, JSON.stringify(value, options.replacer, 2) + '\n');
    // Synced before the rename, as lessons' writeShared does, so a machine
    // that goes down finds the old file or this one, whole.
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, target);
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
