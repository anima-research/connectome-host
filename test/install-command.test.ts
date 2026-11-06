import { afterEach, expect, test } from 'bun:test';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { CLI_IN_RELEASE, installCommandOf, typedCommand, writeInstallCommand } from '../src/cli/install-command.js';

const SETUP_RECIPE = join('node_modules', '@animalabs', 'connectome-host', 'recipes', 'setup.json');

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function install() {
  const dir = mkdtempSync(join(tmpdir(), 'install-command-'));
  dirs.push(dir);
  const root = join(dir, "the resident's install");
  mkdirSync(root);
  writeInstallCommand(root, '');
  return { dir, root, quoted: `'${join(root, 'connectome').replace(/'/g, `'\\''`)}'` };
}

const pathOf = (...entries: string[]) => entries.join(delimiter);

test('plain `connectome` only where the first one a shell finds on PATH is the install\'s own command', () => {
  const { dir, root, quoted } = install();
  expect(typedCommand(root, pathOf(root, '/usr/bin'))).toBe('connectome');
  expect(typedCommand(root, pathOf('/usr/bin'))).toBe(quoted);
  expect(typedCommand(root, undefined)).toBe(quoted);

  const other = join(dir, 'other');
  mkdirSync(other);
  writeFileSync(join(other, 'connectome'), '#!/bin/sh\necho another package\n', { mode: 0o755 });
  expect(typedCommand(root, pathOf(other, root))).toBe(quoted);

  const linked = join(dir, 'linked');
  mkdirSync(linked);
  symlinkSync(join(root, 'connectome'), join(linked, 'connectome'));
  expect(typedCommand(root, pathOf(linked, other))).toBe('connectome');
});

test('a `connectome` a shell can\'t run, or a directory of that name, earlier on PATH is passed over as a shell passes it', () => {
  const { dir, root } = install();
  const unrunnable = join(dir, 'unrunnable');
  mkdirSync(join(unrunnable, 'connectome'), { recursive: true });
  const plainFile = join(dir, 'plain-file');
  mkdirSync(plainFile);
  writeFileSync(join(plainFile, 'connectome'), 'not a program\n');
  chmodSync(join(plainFile, 'connectome'), 0o644);
  expect(typedCommand(root, pathOf(unrunnable, plainFile, root))).toBe('connectome');
});

function withCommands(recipe: boolean, packageRecipe = true) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'install-command-')));
  dirs.push(dir);
  const root = join(dir, 'connectome-host');
  const marker = join(dir, 'ran.json');
  const cli = (at: string, who: string) => {
    mkdirSync(join(at, ...CLI_IN_RELEASE.slice(0, -1)), { recursive: true });
    writeFileSync(join(at, ...CLI_IN_RELEASE), "import { writeFileSync } from 'node:fs';\n" +
      `export async function main(root, argv) { writeFileSync(process.env.MARKER, JSON.stringify({ who: '${who}', root, argv })); return 0; }\n`);
  };
  const release = join(root, 'releases', '1.0.0');
  cli(release, 'current');
  cli(dir, 'package');
  if (packageRecipe) {
    mkdirSync(dirname(join(dir, SETUP_RECIPE)), { recursive: true });
    writeFileSync(join(dir, SETUP_RECIPE), '{}');
  }
  if (recipe) {
    mkdirSync(dirname(join(release, SETUP_RECIPE)), { recursive: true });
    writeFileSync(join(release, SETUP_RECIPE), '{}');
  }
  symlinkSync(join('releases', '1.0.0'), join(root, 'current'));
  writeFileSync(join(root, 'install.json'), JSON.stringify({ v: 1, dataDir: join(dir, 'data'), extraState: [], workingDir: dir }));
  writeInstallCommand(root, '');
  const run = (...argv: string[]) => {
    rmSync(marker, { force: true });
    const ran = Bun.spawnSync([process.execPath, join(root, 'connectome'), ...argv], {
      env: { ...process.env, MARKER: marker }, stderr: 'pipe',
    });
    return {
      exitCode: ran.exitCode, stderr: ran.stderr.toString(),
      ran: existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf-8')) as { who: string; root: string; argv: string[] } : null,
    };
  };
  return { dir, root, run };
}

test('the command sends setup to current\'s CLI when its release has the setup agent\'s recipe, and otherwise to the working directory\'s package\'s; update to current\'s', () => {
  const has = withCommands(true);
  expect(has.run('setup', 'discord').ran).toEqual({ who: 'current', root: has.root, argv: ['setup', 'discord'] });
  const lacks = withCommands(false);
  expect(lacks.run('setup', 'discord').ran).toEqual({ who: 'package', root: lacks.root, argv: ['setup', 'discord'] });
  expect(lacks.run('update').ran).toEqual({ who: 'current', root: lacks.root, argv: ['update'] });
});

test('setup refuses, before any CLI loads, where neither current\'s release nor the working directory\'s package has the setup agent\'s recipe', () => {
  const { dir, run } = withCommands(false, false);
  const refused = run('setup', 'discord');
  expect(refused.exitCode).toBe(1);
  expect(refused.ran).toBeNull();
  expect(refused.stderr).toContain(`connectome: the release this install runs has no setup, so setup runs the connectome-host installed in ${dir}, which has none it can run (${join(dir, ...CLI_IN_RELEASE)}): it has no recipes/setup.json.`);
  expect(refused.stderr).toContain(`In ${dir}, \`bunx @animalabs/connectome-host setup discord\` runs setup from the registry.`);
});

test('where its release has no setup and the directory\'s package has none it can run, setup is sent to the registry for a root named connectome-host, and otherwise to the setup of the release whose setup wrote the command, or by hand once that\'s gone', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'install-command-')));
  dirs.push(dir);
  const refusal = (name: string, withSetup: boolean) => {
    const root = join(dir, name);
    const release = join(root, 'releases', '1.0.0');
    mkdirSync(join(release, ...CLI_IN_RELEASE.slice(0, -1)), { recursive: true });
    writeFileSync(join(release, ...CLI_IN_RELEASE), 'export async function main() { return 0; }\n');
    const ownSetup = join(release, 'node_modules', '@animalabs', 'connectome-host', 'src', 'update', 'setup.ts');
    if (withSetup) {
      mkdirSync(dirname(ownSetup), { recursive: true });
      writeFileSync(ownSetup, '// setup\n');
    }
    symlinkSync(join('releases', '1.0.0'), join(root, 'current'));
    writeFileSync(join(root, 'install.json'), JSON.stringify({ v: 1, dataDir: join(dir, 'data'), extraState: [], workingDir: dir }));
    writeInstallCommand(root, '', '1.0.0');
    const ran = Bun.spawnSync([process.execPath, join(root, 'connectome'), 'setup', 'discord'], { stderr: 'pipe' });
    return { exitCode: ran.exitCode, stderr: ran.stderr.toString(), root, ownSetup };
  };
  const named = refusal('connectome-host', true);
  expect(named.exitCode).toBe(1);
  expect(named.stderr).toContain(`In ${dir}, \`bunx @animalabs/connectome-host setup discord\` runs setup from the registry.`);
  const other = refusal('custom-root', true);
  expect(other.exitCode).toBe(1);
  expect(other.stderr).toContain(`The registry's setup takes ${join(dir, 'connectome-host')} for the install root, and this ` +
    `one is ${other.root}, so run the setup of 1.0.0, the release whose setup wrote this file, from ${dir} with this ` +
    `install's own DATA_DIR: \`bun --no-env-file ${other.ownSetup} --root ${other.root}\`.`);
  const gone = refusal('another-root', false);
  expect(gone.stderr).toContain(`and this one is ${gone.root}, so run its setup by hand again, as docs/DEPLOYMENTS.md shows.`);
});

test('a record bound to another directory refuses the bare command, update and send, and a binding\'s plan standing refuses update, each before any CLI loads, while setup runs in both', () => {
  const { dir, root, run } = withCommands(true);
  const elsewhere = join(dirname(dir), 'elsewhere');
  writeFileSync(join(root, 'install.json'), JSON.stringify({ v: 1, dataDir: join(elsewhere, 'data'), extraState: [], workingDir: elsewhere }));
  for (const argv of [[], ['update'], ['send', 'hi']]) {
    const refused = run(...argv);
    expect(refused.exitCode).toBe(1);
    expect(refused.ran).toBeNull();
    expect(refused.stderr).toContain(`connectome: nothing runs in this install, since its record is bound to ${elsewhere}, and it's in ${dir}, so it was moved or copied here`);
  }
  expect(run('setup', 'discord').ran?.argv).toEqual(['setup', 'discord']);
  writeFileSync(join(root, 'install.json'), JSON.stringify({ v: 1, dataDir: join(dir, 'data'), extraState: [], workingDir: dir }));
  writeFileSync(join(root, 'rebind.json'), '{}');
  const refused = run('update');
  expect(refused.ran).toBeNull();
  expect(refused.stderr).toContain(`connectome: nothing runs in this install, since a setup binding this install was cut off before it finished (${join(root, 'rebind.json')} is its plan), so the places it names may be half bound. Setup, run again, finishes it from its plan without asking about its places again, or says what stops it`);
  expect(run('setup', 'discord').ran?.who).toBe('current');
});

test('a record from before workingDir runs update as it did', () => {
  const { dir, root, run } = withCommands(true);
  writeFileSync(join(root, 'install.json'), JSON.stringify({ v: 1, dataDir: join(dir, 'data'), extraState: [] }));
  expect(run('update').ran?.who).toBe('current');
});

test('setup\'s line that puts the install\'s directory on PATH is shown exactly where plain `connectome` wouldn\'t run it', () => {
  const { dir, root } = install();
  const other = join(dir, 'other');
  mkdirSync(other);
  writeFileSync(join(other, 'connectome'), '#!/bin/sh\n', { mode: 0o755 });
  const line = `export PATH='${root.replace(/'/g, `'\\''`)}':"$PATH"`;
  expect(installCommandOf(root, pathOf(root)).pathLine).toBeNull();
  expect(installCommandOf(root, pathOf('/usr/bin')).pathLine).toBe(line);
  expect(installCommandOf(root, pathOf(other, root)).pathLine).toBe(line);
});
