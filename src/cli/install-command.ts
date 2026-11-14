import { join } from 'node:path';
import { writeTextAtomic } from '../update/contract.js';
import { INSTALL_COMMAND, shellWord, typedCommand } from '../update/typed-command.js';
import { SHOWN_FILE } from '../setup/commands-shown.js';

export const CLI_IN_RELEASE = ['node_modules', '@animalabs', 'connectome-host', 'src', 'cli', 'connectome.ts'];

export function installCommandText(): string {
  return [
    '#!/usr/bin/env bun',
    '// Written by this install\'s setup. Link to it rather than move it: it runs the install it sits in.',
    "import { appendFileSync, existsSync, realpathSync } from 'node:fs';",
    "import { dirname, join } from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    '',
    'const root = dirname(realpathSync(fileURLToPath(import.meta.url)));',
    "const word = (path) => /^[\\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\\\''`)}'`;",
    `const cli = join(root, 'current', ${CLI_IN_RELEASE.map((part) => `'${part}'`).join(', ')});`,
    'const refuse = (line) => {',
    '  console.error(line);',
    `  const file = process.env.${SHOWN_FILE};`,
    '  if (!file) return;',
    '  try {',
    '    appendFileSync(file, `${line}\\n`);',
    '  } catch (error) {',
    "    console.error(`connectome: setup's agent named ${file} for what this command prints to reach the person's ` +",
    "      `screen, and it can't be written (${error instanceof Error ? error.message : error}), so the person sees ` +",
    "      'neither the line above nor what it prints after it: tell them what it says.');",
    '  }',
    '};',
    "if (!existsSync(join(root, 'current'))) {",
    "  refuse(`connectome: ${root} has no current release: run setup again in ${dirname(root)}, which says how ` +",
    "    'to put it right.');",
    '  process.exit(1);',
    '}',
    'let main;',
    'try {',
    '  ({ main } = await import(cli));',
    "  if (typeof main !== 'function') throw new Error('it has no main to call');",
    '} catch (error) {',
    "  refuse(`connectome: the release this install runs has no connectome command that loads (${cli}): ` +",
    "    `${error instanceof Error ? error.message : error}. If its host still starts, its /update, in the TUI or ` +",
    "    `the Web UI, updates it. If this release is broken, \\`bun ${word(join(root, 'start.js'))} --go-back\\` asks ` +",
    "    'the next start to go back, when a Go back is offered.');",
    '  process.exit(1);',
    '}',
    'process.exit(await main(root, process.argv.slice(2)));',
    '',
  ].join('\n');
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
