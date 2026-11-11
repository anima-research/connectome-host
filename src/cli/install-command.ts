import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { writeTextAtomic } from '../update/contract.js';
import { shellWord } from '../update/launcher.js';

export const INSTALL_COMMAND = 'connectome';

export const CLI_IN_RELEASE = ['node_modules', '@animalabs', 'connectome-host', 'src', 'cli', 'connectome.ts'];

export function installCommandText(): string {
  return [
    '#!/usr/bin/env bun',
    '// Written by this install\'s setup. Link to it rather than move it: it runs the install it sits in.',
    "import { existsSync, realpathSync } from 'node:fs';",
    "import { dirname, join } from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    '',
    'const root = dirname(realpathSync(fileURLToPath(import.meta.url)));',
    "const word = (path) => /^[\\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\\\''`)}'`;",
    `const cli = join(root, 'current', ${CLI_IN_RELEASE.map((part) => `'${part}'`).join(', ')});`,
    "if (!existsSync(join(root, 'current'))) {",
    "  console.error(`connectome: ${root} has no current release: run setup again in ${dirname(root)}, which says how ` +",
    "    'to put it right.');",
    '  process.exit(1);',
    '}',
    'let main;',
    'try {',
    '  ({ main } = await import(cli));',
    "  if (typeof main !== 'function') throw new Error('it has no main to call');",
    '} catch (error) {',
    "  console.error(`connectome: the release this install runs has no connectome command that loads (${cli}): ` +",
    "    `${error instanceof Error ? error.message : error}. If its host still starts, its /update, in the TUI or ` +",
    "    `the Web UI, updates it. If this release is broken, \\`bun ${word(join(root, 'start.js'))} --go-back\\` asks ` +",
    "    'the next start to go back, when a Go back is offered.');",
    '  process.exit(1);',
    '}',
    'process.exit(await main(root, process.argv.slice(2)));',
    '',
  ].join('\n');
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

export function installCommandOf(root: string, path: string | undefined = process.env.PATH):
  { path: string; pathLine: string | null } {
  const plain = typedCommand(root, path) === INSTALL_COMMAND;
  return { path: join(root, INSTALL_COMMAND), pathLine: plain ? null : `export PATH=${shellWord(root)}:"$PATH"` };
}

export function writeInstallCommand(root: string, path: string | undefined = process.env.PATH):
  { path: string; pathLine: string | null } {
  writeTextAtomic(join(root, INSTALL_COMMAND), installCommandText(), 0o755);
  return installCommandOf(root, path);
}
