import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dotenvValues } from '../src/setup/secrets.js';

const dirs: string[] = [];
const execPath = process.execPath;

afterEach(() => {
  process.execPath = execPath;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('a dotenv read that fails says how, and doesn\'t pass on what Bun printed, which can hold the files\' values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chost-dotenv-read-'));
  dirs.push(dir);
  writeFileSync(join(dir, '.env'), 'READ_SECRET=Zq9-SECRET-77\n');
  const bun = join(dir, 'fake-bun');
  writeFileSync(bun, '#!/bin/sh\necho "error: READ_SECRET=Zq9-SECRET-77 is bad" >&2\nexit 3\n');
  chmodSync(bun, 0o755);
  process.execPath = bun;
  let said = '';
  try {
    dotenvValues(dir, { PATH: process.env.PATH });
  } catch (error) {
    said = (error as Error).message;
  }
  expect(said).toContain(`Bun couldn't read the dotenv files in ${dir} (exit 3)`);
  expect(said).not.toContain('Zq9-SECRET-77');
});
