import { join } from 'node:path';

export const INSTALL_COMMAND = 'connectome';

export function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

export function installCommandAt(root: string): string {
  return shellWord(join(root, INSTALL_COMMAND));
}
