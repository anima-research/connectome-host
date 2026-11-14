import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCall } from '@animalabs/agent-framework';
import { SetupModule } from '../src/modules/setup-module.js';
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
  expect(said).toContain(`Bun couldn't read the dotenv files in ${dir} in its development mode (exit 3)`);
  expect(said).toContain(`\`env -u BUN_OPTIONS -u NODE_ENV ${bun} --config=/dev/null -e 0\`, run in that directory`);
  expect(said).not.toContain('Zq9-SECRET-77');
});

test('a dotenv read that fails in one mode names that mode, and the command to see it runs that Bun with that mode\'s NODE_ENV', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chost-dotenv-read-'));
  dirs.push(dir);
  writeFileSync(join(dir, '.env'), 'READ_SECRET=Zq9-SECRET-77\n');
  const bun = join(dir, 'fake-bun');
  writeFileSync(bun, '#!/bin/sh\nif [ "$NODE_ENV" = production ]; then echo "READ_SECRET=Zq9-SECRET-77" >&2; exit 3; fi\necho "{}"\n');
  chmodSync(bun, 0o755);
  process.execPath = bun;
  let said = '';
  try {
    dotenvValues(dir, { PATH: process.env.PATH });
  } catch (error) {
    said = (error as Error).message;
  }
  expect(said).toContain(`Bun couldn't read the dotenv files in ${dir} in its production mode (exit 3)`);
  expect(said).toContain(`\`env -u BUN_OPTIONS NODE_ENV=production ${bun} --config=/dev/null -e 0\``);
  expect(said).not.toContain('Zq9-SECRET-77');
});

test('setup\'s agent, given a dotenv read that fails, is told to ask the person to run Bun\'s read in their terminal, and isn\'t given what Bun printed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chost-dotenv-read-'));
  dirs.push(dir);
  writeFileSync(join(dir, '.env'), 'READ_SECRET=Zq9-SECRET-77\n', { mode: 0o600 });
  const bun = join(dir, 'fake-bun');
  writeFileSync(bun, '#!/bin/sh\necho "error: READ_SECRET=Zq9-SECRET-77 is bad" >&2\nexit 3\n');
  chmodSync(bun, 0o755);
  process.execPath = bun;
  const module = new SetupModule({
    dir, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir }, asker: () => null, show: () => {},
  });
  const result = await module.handleToolCall({ id: 'r1', name: 'run', input: { command: 'true' } } as ToolCall);
  expect(result.success).toBe(false);
  expect(result.error).toContain(`Bun couldn't read the dotenv files in ${dir} in its development mode (exit 3)`);
  expect(result.error).toContain(`Ask the person to run \`env -u BUN_OPTIONS -u NODE_ENV ${bun} --config=/dev/null -e 0\` in that directory, in their terminal`);
  expect(result.error).not.toContain('Zq9-SECRET-77');
});
