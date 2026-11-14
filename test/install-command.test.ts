import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { installCommandOf, typedCommand, writeInstallCommand } from '../src/cli/install-command.js';

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
