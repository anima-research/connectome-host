import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, join, resolve, sep } from 'node:path';
import { writeTextAtomic } from '../update/contract.js';
import { RELEASE_HOST, shellWord } from '../update/launcher.js';
import { bindingCheckLines } from '../update/rebind.js';

export const INSTALL_COMMAND = 'connectome';

export const CLI_IN_RELEASE = ['node_modules', '@animalabs', 'connectome-host', 'src', 'cli', 'connectome.ts'];

export const SETUP_RECIPE = join(RELEASE_HOST, 'recipes', 'setup.json');

const parts = (path: string[]) => path.map((part) => `'${part}'`).join(', ');

export function installCommandText(release: string | null = null): string {
  return [
    '#!/usr/bin/env bun',
    '// Written by this install\'s setup. Link to it rather than move it: it runs the install it sits in.',
    "import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';",
    "import { basename, dirname, join } from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    '',
    'const root = dirname(realpathSync(fileURLToPath(import.meta.url)));',
    ...bindingCheckLines('connectome', true, release),
    `const fromPackage = process.argv[2] === 'setup' && !existsSync(join(root, 'current', ${parts(SETUP_RECIPE.split(sep))}));`,
    `const cli = join(fromPackage ? dirname(root) : join(root, 'current'), ${parts(CLI_IN_RELEASE)});`,
    "if (!fromPackage && !existsSync(join(root, 'current'))) {",
    "  console.error(`connectome: ${root} has no current release: run setup again in ${dirname(root)}, which says how ` +",
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
    '  console.error(fromPackage',
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

export function typedCommand(root: string, path: string | undefined = process.env.PATH): string {
  const own = join(root, INSTALL_COMMAND);
  const first = firstOnPath(INSTALL_COMMAND, path);
  return first !== null && sameFile(first, own) ? INSTALL_COMMAND : shellWord(own);
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

export function writeInstallCommand(root: string, path: string | undefined = process.env.PATH,
  release: string | null = null): { path: string; pathLine: string | null } {
  writeTextAtomic(join(root, INSTALL_COMMAND), installCommandText(release), 0o755);
  return installCommandOf(root, path);
}
