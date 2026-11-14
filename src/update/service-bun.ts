import { realpathSync } from 'node:fs';

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

// Homebrew's execPath is its versioned Cellar file, which an upgrade removes, while its link on PATH stays.
export function serviceBun(execPath: string, path: string, look: BunLookup = lookup): string {
  const onPath = look.which('bun', path);
  const runs = look.realpath(execPath);
  return onPath !== null && runs !== null && look.realpath(onPath) === runs ? onPath : execPath;
}
