import { realpathSync } from 'node:fs';
import { join } from 'node:path';

export interface BunLookup {
  which(name: string, path: string): string | null;
  realpath(path: string): string | null;
}

export const lookup: BunLookup = {
  which: (name, path) => Bun.which(name, { PATH: path }),
  realpath: (path) => {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  },
};

// bunx and bun run, with no node on PATH or with --bun, put a temporary directory first on PATH whose node and bun
// link to the running bun.
export function lastingPath(path: string, execPath: string, look: BunLookup = lookup): string {
  const runs = look.realpath(execPath);
  return path.split(':').filter((entry) => runs === null || look.realpath(join(entry, 'node')) !== runs).join(':');
}

// Homebrew's execPath is its versioned Cellar file, which an upgrade removes, while its link on PATH stays.
export function serviceBun(execPath: string, path: string, look: BunLookup = lookup): string {
  const onPath = look.which('bun', lastingPath(path, execPath, look));
  const runs = look.realpath(execPath);
  return onPath !== null && runs !== null && look.realpath(onPath) === runs ? onPath : execPath;
}
