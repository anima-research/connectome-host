import { join, sep } from 'node:path';
import { writeTextAtomic } from '../update/contract.js';
import { RELEASE_HOST } from '../update/launcher.js';
import { bindingCheckLines } from '../update/rebind.js';
import { INSTALL_COMMAND, shellWord, typedCommand } from '../update/typed-command.js';
import { SHOWN_FILE } from '../setup/commands-shown.js';

export const CLI_IN_RELEASE = ['node_modules', '@animalabs', 'connectome-host', 'src', 'cli', 'connectome.ts'];

export const SETUP_RECIPE = join(RELEASE_HOST, 'recipes', 'setup.json');

const parts = (path: string[]) => path.map((part) => `'${part}'`).join(', ');

export function installCommandText(release: string | null = null): string {
  return [
    '#!/usr/bin/env bun',
    '// Written by this install\'s setup. Link to it rather than move it: it runs the install it sits in.',
    "import { appendFileSync, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';",
    "import { basename, dirname, isAbsolute, join } from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    '',
    'const root = dirname(realpathSync(fileURLToPath(import.meta.url)));',
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
    ...bindingCheckLines('connectome', true, release, 'refuse'),
    `const fromPackage = process.argv[2] === 'setup' && !existsSync(join(root, 'current', ${parts(SETUP_RECIPE.split(sep))}));`,
    `const cli = join(fromPackage ? dirname(root) : join(root, 'current'), ${parts(CLI_IN_RELEASE)});`,
    "if (!fromPackage && !existsSync(join(root, 'current'))) {",
    "  refuse(`connectome: ${root} has no current release: run setup again in ${dirname(root)}, which says how ` +",
    "    'to put it right.');",
    '  process.exit(1);',
    '}',
    'let main;',
    'try {',
    `  if (fromPackage && !existsSync(join(dirname(root), ${parts(SETUP_RECIPE.split(sep))}))) ` +
      `throw new Error('it has no ${join(...SETUP_RECIPE.split(sep).slice(RELEASE_HOST.split(sep).length))}');`,
    '  ({ main } = await import(cli));',
    "  if (typeof main !== 'function') throw new Error('it has no main to call');",
    '} catch (error) {',
    '  const why = error instanceof Error ? error.message : error;',
    '  refuse(fromPackage',
    "    ? `connectome: the release this install runs has no setup, so setup runs the connectome-host installed in ` +",
    "      `${dirname(root)}, which has none it can run (${cli}): ${why}. ` + (basename(root) === 'connectome-host'",
    "        ? `In ${dirname(root)}, \\`bunx @animalabs/connectome-host@latest setup discord\\` runs setup from the registry.`",
    "        : `The registry's setup takes ${join(dirname(root), 'connectome-host')} for the install root, and this one is ` +",
    "          `${root}, so run ${byHand}.`)",
    "    : `connectome: the release this install runs has no connectome command that loads (${cli}): ${why}. If its ` +",
    "      `host still starts, its /update, in the TUI or the Web UI, updates it. If this release is broken, ` +",
    "      `\\`bun ${quoted(join(root, 'start.js'))} --go-back\\` asks the next start to go back, when a Go back is offered.`);",
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

export function writeInstallCommand(root: string, path: string | undefined = process.env.PATH,
  release: string | null = null): { path: string; pathLine: string | null } {
  writeTextAtomic(join(root, INSTALL_COMMAND), installCommandText(release), 0o755);
  return installCommandOf(root, path);
}
