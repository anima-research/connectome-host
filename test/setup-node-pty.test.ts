import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { nodePtyDir } from '../src/setup/node-pty.js';

const MODULE = resolve(import.meta.dir, '..', 'src', 'setup', 'node-pty.ts');
const HELPERS = ['darwin-arm64', 'darwin-x64'];
const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function directory(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

function nodePty(at: string): void {
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, 'package.json'), JSON.stringify({ name: 'node-pty', version: '1.1.0', main: 'index.js' }));
  for (const prebuild of HELPERS) {
    const helper = join(at, 'prebuilds', prebuild, 'spawn-helper');
    mkdirSync(dirname(helper), { recursive: true });
    writeFileSync(helper, '');
    chmodSync(helper, 0o644);
  }
}

function termSessions(at: string): void {
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, 'package.json'), JSON.stringify({ name: 'term-sessions-mcp', version: '1.7.3', dependencies: { 'node-pty': '1.1.0' } }));
}

const modes = (at: string) => HELPERS.map((prebuild) => statSync(join(at, 'prebuilds', prebuild, 'spawn-helper')).mode & 0o777);

test('the node-pty made executable is the copy node loads from term-sessions-mcp, not the one in Bun\'s global cache, in a Bun process that started before the directory had node_modules', () => {
  const dir = directory('node-pty-');
  const cache = directory('bun-cache-');
  nodePty(join(cache, 'node-pty@1.1.0@@@1'));
  const brought = directory('brought-');
  termSessions(join(brought, 'node_modules', 'term-sessions-mcp'));
  nodePty(join(brought, 'node_modules', 'node-pty'));
  const script = `
    const { cpSync } = await import('node:fs');
    cpSync(${JSON.stringify(join(brought, 'node_modules'))}, ${JSON.stringify(join(dir, 'node_modules'))}, { recursive: true });
    const { makeSpawnHelperExecutable, nodePtyDir } = await import(${JSON.stringify(MODULE)});
    const dir = ${JSON.stringify(dir)};
    const found = nodePtyDir(dir);
    console.log(JSON.stringify({ found, chmod: makeSpawnHelperExecutable(found, 'darwin') }));
  `;
  const ran = Bun.spawnSync([process.execPath, '-e', script], {
    cwd: dir, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, BUN_INSTALL_CACHE_DIR: cache },
  });
  expect({ status: ran.exitCode, stderr: ran.stderr.toString() }).toEqual({ status: 0, stderr: '' });
  expect(JSON.parse(ran.stdout.toString())).toEqual({ found: join(dir, 'node_modules', 'node-pty'), chmod: null });
  expect(modes(join(dir, 'node_modules', 'node-pty'))).toEqual([0o755, 0o755]);
  expect(modes(join(cache, 'node-pty@1.1.0@@@1'))).toEqual([0o644, 0o644]);
});

test('node-pty is found as node finds it from term-sessions-mcp: its own nested copy first, then the hoisted one, and through Bun\'s isolated layout to the store', () => {
  const nested = directory('node-pty-');
  termSessions(join(nested, 'node_modules', 'term-sessions-mcp'));
  nodePty(join(nested, 'node_modules', 'term-sessions-mcp', 'node_modules', 'node-pty'));
  nodePty(join(nested, 'node_modules', 'node-pty'));
  expect(nodePtyDir(nested)).toBe(join(nested, 'node_modules', 'term-sessions-mcp', 'node_modules', 'node-pty'));

  const hoisted = directory('node-pty-');
  termSessions(join(hoisted, 'node_modules', 'term-sessions-mcp'));
  nodePty(join(hoisted, 'node_modules', 'node-pty'));
  expect(nodePtyDir(hoisted)).toBe(join(hoisted, 'node_modules', 'node-pty'));

  const isolated = directory('node-pty-');
  const store = join(isolated, 'node_modules', '.bun');
  const server = join(store, 'term-sessions-mcp@1.7.3', 'node_modules', 'term-sessions-mcp');
  termSessions(server);
  nodePty(join(store, 'node-pty@1.1.0', 'node_modules', 'node-pty'));
  symlinkSync(join(store, 'node-pty@1.1.0', 'node_modules', 'node-pty'), join(dirname(server), 'node-pty'));
  symlinkSync(server, join(isolated, 'node_modules', 'term-sessions-mcp'));
  expect(nodePtyDir(isolated)).toBe(join(store, 'node-pty@1.1.0', 'node_modules', 'node-pty'));

  const none = directory('node-pty-');
  termSessions(join(none, 'node_modules', 'term-sessions-mcp'));
  expect(nodePtyDir(none)).toBe(join(none, 'node_modules', 'node-pty'));
});
