import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shell, type ShellWorld } from '../src/cli/shell.js';
import { SHOWN_FILE } from '../src/setup/commands-shown.js';
import type { Ran } from '../src/setup/world.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ok = (stdout = ''): Ran => ({ status: 0, stdout, stderr: '' });
const DEFAULT_TRUSTED = 'Default trusted dependencies (2):\n - esbuild\n - node-pty\n';

function machine(opts: {
  node?: string; installed?: string; pty?: Ran[]; env?: Record<string, string>; noNode?: boolean; addFails?: Ran;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cli-shell-'));
  dirs.push(dir);
  const manifest = { dependencies: {} as Record<string, string> };
  if (opts.installed !== undefined) {
    manifest.dependencies['term-sessions-mcp'] = opts.installed;
    mkdirSync(join(dir, 'node_modules', 'term-sessions-mcp'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'term-sessions-mcp', 'package.json'), JSON.stringify({ version: opts.installed }));
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
  const ran: string[][] = [];
  const envs: Array<Record<string, string>> = [];
  const pty = [...opts.pty ?? [ok()]];
  const world: ShellWorld = {
    platform: 'linux',
    env: { PATH: '/usr/bin:/bin', ...opts.env },
    cwd: dir,
    bun: { path: 'bun', version: '1.4.4' },
    hasSudo: false,
    hasNode: () => !opts.noNode,
    run: async (argv, options) => {
      ran.push(argv);
      envs.push(options.env);
      if (argv[0] === 'node' && argv[1] === '--version') {
        return opts.noNode ? { status: 1, stdout: '', stderr: '' } : ok(`v${opts.node ?? '24.1.0'}\n`);
      }
      if (argv[0] === 'node') return pty.shift() ?? ok();
      if (argv[2] === 'pm') return ok(DEFAULT_TRUSTED);
      if (argv[2] === 'add') {
        if (opts.addFails) return opts.addFails;
        const held = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
        held.dependencies['term-sessions-mcp'] = '^1';
        writeFileSync(join(dir, 'package.json'), JSON.stringify(held));
        mkdirSync(join(dir, 'node_modules', 'term-sessions-mcp'), { recursive: true });
        writeFileSync(join(dir, 'node_modules', 'term-sessions-mcp', 'package.json'), JSON.stringify({ version: '1.7.3' }));
      }
      return ok();
    },
  };
  return { dir, world, ran, envs };
}

async function install(m: ReturnType<typeof machine>) {
  const out: string[] = [];
  const err: string[] = [];
  const root = join(m.dir, 'connectome-host');
  const status = await shell({ root, argv: ['install'], out: (l) => out.push(l), err: (l) => err.push(l) }, m.world);
  return { status, out, err };
}

test('installs the shell where it is missing, with Bun\'s default trusted packages and the shell\'s own listed, and checks a pty opens', async () => {
  const m = machine();
  const { status, out, err } = await install(m);
  expect(err).toEqual([]);
  expect(status).toBe(0);
  expect(JSON.parse(readFileSync(join(m.dir, 'package.json'), 'utf-8')).trustedDependencies)
    .toEqual(['esbuild', 'node-pty', 'term-sessions-mcp']);
  expect(m.ran).toContainEqual(['bun', '--no-env-file', 'add', 'term-sessions-mcp@^1']);
  expect(out.at(-1)).toStartWith(`A pty opens in ${m.dir}`);
});

test('gives Bun\'s install no variable that a dotenv file where the command runs sets, whatever its value', async () => {
  const m = machine({ env: { DISCORD_TOKEN: 'from-env-file', SHARED: 'exported', OTHER: 'exported' } });
  writeFileSync(join(m.dir, '.env'), 'DISCORD_TOKEN="from-env-file"\nSHARED="file"\n');
  expect((await install(m)).status).toBe(0);
  const added = m.envs[m.ran.findIndex((argv) => argv[2] === 'add')]!;
  expect(added).not.toHaveProperty('DISCORD_TOKEN');
  expect(added).not.toHaveProperty('SHARED');
  expect(added.OTHER).toBe('exported');
});

test('says, under setup\'s agent, that the agent has Bun\'s lines when the install fails', async () => {
  const failed: Ran = { status: 1, stdout: '', stderr: 'error: no registry' };
  const plain = await install(machine({ addFails: failed }));
  expect(plain.err.join('\n')).toContain('Bun\'s own lines say why.');
  const shownDir = mkdtempSync(join(tmpdir(), 'cli-shell-shown-'));
  dirs.push(shownDir);
  const shownTo = join(shownDir, 'said');
  const underSetup = await install(machine({ addFails: failed, env: { [SHOWN_FILE]: shownTo } }));
  expect(underSetup.err.join('\n')).toContain('Setup\'s agent has Bun\'s own lines, which say why.');
});

test('leaves a 1.x shell as it is', async () => {
  const m = machine({ installed: '1.7.3' });
  expect((await install(m)).status).toBe(0);
  expect(m.ran.some((argv) => argv[2] === 'add')).toBe(false);
});

test('installs node-pty once more where a pty doesn\'t open, and says what to install where it still doesn\'t', async () => {
  const mended = machine({ pty: [{ status: 1, stdout: '', stderr: 'Error: no prebuilt binary\n' }, ok()] });
  const fixed = await install(mended);
  expect(fixed.status).toBe(0);
  expect(fixed.out).toContain(`The resident's shell runs on node-pty, which doesn't work in ${mended.dir} yet (Error: no prebuilt binary), so this installs it again.`);
  expect(mended.ran).toContainEqual(['bun', '--no-env-file', 'install']);
  const broken = machine({ pty: [{ status: 1, stdout: '', stderr: 'Error: no prebuilt binary\n' }, { status: 1, stdout: '', stderr: 'gyp ERR!\n' }] });
  const still = await install(broken);
  expect(still.status).toBe(1);
  expect(still.err[0]).toContain('`apt install build-essential python3`');
});

test('takes a node-pty under a directory whose name starts with two dots for one inside the install\'s directory', async () => {
  const m = machine({ installed: '1.7.3', pty: [{ status: 1, stdout: '', stderr: 'Error: no prebuilt binary\n' }, ok()] });
  const shellDir = join(m.dir, '..pkgs', 'term-sessions-mcp');
  mkdirSync(join(shellDir, 'node_modules', 'node-pty'), { recursive: true });
  writeFileSync(join(shellDir, 'package.json'), JSON.stringify({ version: '1.7.3' }));
  writeFileSync(join(shellDir, 'node_modules', 'node-pty', 'package.json'), '{}');
  rmSync(join(m.dir, 'node_modules', 'term-sessions-mcp'), { recursive: true });
  symlinkSync(shellDir, join(m.dir, 'node_modules', 'term-sessions-mcp'));
  const { status, err } = await install(m);
  expect(err).toEqual([]);
  expect(status).toBe(0);
  expect(m.ran).toContainEqual(['bun', '--no-env-file', 'install']);
});

test('says plainly where there\'s no Node on PATH, or only Bun\'s own stand-in for it', async () => {
  const { status, err } = await install(machine({ noNode: true }));
  expect(status).toBe(1);
  expect(err[0]).toStartWith('There\'s no Node on this machine\'s PATH. The resident\'s shell runs on Node.');
});

test('refuses a Node newer than the shell runs on', async () => {
  const { status, err } = await install(machine({ node: '25.0.0' }));
  expect(status).toBe(1);
  expect(err[0]).toStartWith('The resident\'s shell, term-sessions-mcp, runs on Node 24 at most, and this is Node 25.0.0.');
});

test('under setup\'s agent, what it says reaches the person\'s file too', async () => {
  const file = join(tmpdir(), `cli-shell-shown-${process.pid}`);
  writeFileSync(file, '');
  try {
    const m = machine({ env: { [SHOWN_FILE]: file } });
    await install(m);
    expect(readFileSync(file, 'utf-8')).toContain(`A pty opens in ${m.dir}`);
  } finally {
    if (existsSync(file)) rmSync(file);
  }
});
