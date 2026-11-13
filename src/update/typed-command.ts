import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

export const INSTALL_COMMAND = 'connectome';

export function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

export function typedCommand(root: string, path: string | undefined = process.env.PATH): string {
  const own = join(root, INSTALL_COMMAND);
  const first = firstOnPath(INSTALL_COMMAND, path);
  return first !== null && sameFile(first, own) ? INSTALL_COMMAND : installCommandAt(root);
}

export function installCommandAt(root: string): string {
  return shellWord(join(root, INSTALL_COMMAND));
}

function firstOnPath(name: string, path: string | undefined): string | null {
  for (const dir of (path ?? '').split(delimiter)) {
    const candidate = resolve(dir === '' ? '.' : dir, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
    }
  }
  return null;
}

function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}
