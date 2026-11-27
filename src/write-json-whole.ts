import { lstatSync, mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
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
  writeFileSync(tmp, JSON.stringify(value, options.replacer, 2) + '\n', options.mode === undefined ? {} : { mode: options.mode });
  renameSync(tmp, target);
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
