import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setup, setupDirectory } from '../src/cli/setup.js';
import { packageJson } from '../src/setup/packages.js';
import type { KeyCheck } from '../src/setup/key-check.js';
import { realWorld, type AgentLaunch, type Ran, type RunOptions, type SetupWorld } from '../src/setup/world.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const VERSION = packageJson().version;
const KEY = 'sk-ant-test-0123456789';
const HOST = '@animalabs/connectome-host';

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-setup-'));
  dirs.push(dir);
  return dir;
}

function ownDir(): string {
  const dir = scratch();
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.setup', 'made-by-connectome-setup'), '');
  return dir;
}

function machine(dir: string, opts: {
  answers?: string[]; hidden?: string[]; keys?: KeyCheck[]; env?: Record<string, string>; platform?: NodeJS.Platform;
  sudo?: boolean; linger?: boolean | null; macSession?: string | null; bun?: string; hasNode?: boolean;
  fails?: Partial<Record<'node' | 'add' | 'own-setup' | 'boot', Ran>>; recipe?: string | null;
} = {}) {
  const asked: string[] = [];
  const ran: string[][] = [];
  const envs: Array<Record<string, string>> = [];
  const launched: AgentLaunch[] = [];
  const checked: string[] = [];
  const bases: Array<string | undefined> = [];
  const steps: string[] = [];
  const boots: Array<{ argv: string[]; env: Record<string, string>; timeoutMs?: number; recipe: unknown }> = [];
  const answers = [...opts.answers ?? []];
  const hidden = [...opts.hidden ?? []];
  const keys = [...opts.keys ?? []];
  const ok = (stdout = ''): Ran => ({ status: 0, stdout, stderr: '' });
  const world: SetupWorld = {
    terminal: true,
    platform: opts.platform ?? 'linux',
    user: 'ada',
    env: { PATH: '/usr/bin:/bin', ...opts.env },
    cwd: dir,
    bun: { path: 'bun', version: opts.bun ?? '1.4.4' },
    hasSudo: opts.sudo ?? false,
    hasNode: () => opts.hasNode ?? true,
    lingerOf: () => (opts.linger === undefined ? true : opts.linger),
    macSession: () => (opts.macSession === undefined ? null : opts.macSession),
    timeZone: 'Europe/London',
    userExists: () => false,
    ask: async (question) => { asked.push(question); return answers.shift() ?? null; },
    askHidden: async (label) => { asked.push(label); return hidden.shift() ?? null; },
    run: async (argv: string[], options: RunOptions) => {
      ran.push(argv);
      envs.push(options.env);
      if (argv[0] === 'node') {
        steps.push('node');
        return opts.fails?.node ?? ok('v24.1.0\n');
      }
      if (argv[2] === 'add') {
        steps.push('add');
        if (opts.fails?.add) return opts.fails.add;
        const manifest = join(options.cwd, 'package.json');
        const held = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf-8')) : { dependencies: {} };
        for (const spec of argv.slice(3)) {
          const name = spec.replace(/(?<=.)@[^@]*$/, '');
          held.dependencies[name] = spec;
          mkdirSync(join(options.cwd, 'node_modules', name), { recursive: true });
          writeFileSync(join(options.cwd, 'node_modules', name, 'package.json'), JSON.stringify({ version: VERSION }));
        }
        writeFileSync(manifest, JSON.stringify(held));
        return ok();
      }
      if (argv[2]?.endsWith(join('src', 'update', 'setup.ts'))) {
        steps.push('own setup');
        if (opts.fails?.['own-setup']) return opts.fails['own-setup'];
        const root = argv[4]!;
        const host = join(root, 'releases', VERSION, 'node_modules', '@animalabs', 'connectome-host');
        mkdirSync(join(host, 'recipes'), { recursive: true });
        const recipe = opts.recipe === undefined ? JSON.stringify({ agent: { model: 'claude-opus-5-5' } }) : opts.recipe;
        if (recipe !== null) writeFileSync(join(host, 'recipes', 'setup.json'), recipe);
        if (!existsSync(join(root, 'current'))) symlinkSync(join('releases', VERSION), join(root, 'current'));
        writeFileSync(join(root, 'install.json'), JSON.stringify({ v: 1, dataDir: options.env.DATA_DIR, extraState: [] }));
        return ok(`Set up ${root}.\n`);
      }
      steps.push('boot');
      boots.push({
        argv, env: options.env, timeoutMs: options.timeoutMs,
        recipe: existsSync(argv[2] ?? '') ? JSON.parse(readFileSync(argv[2]!, 'utf-8')) : null,
      });
      return opts.fails?.boot ?? ok();
    },
    checkKey: async ({ key, baseUrl }) => {
      steps.push('key check');
      checked.push(key);
      bases.push(baseUrl);
      return keys.shift() ?? { ok: true };
    },
    startAgent: async (launch) => { steps.push('agent'); launched.push(launch); return 0; },
  };
  return { world, asked, ran, envs, launched, checked, bases, steps, boots };
}

async function runSetup(dir: string, world: SetupWorld, argv = ['discord']) {
  const out: string[] = [];
  const err: string[] = [];
  const status = await setup({ root: join(dir, 'connectome-host'), argv, out: (l) => out.push(l), err: (l) => err.push(l) }, world);
  return { status, out, err };
}

describe('a first setup', () => {
  test('installs, starts the host once, checks the typed key, keeps it, and starts the agent, in that order, showing none of the install\'s own setup lines', async () => {
    const dir = scratch();
    const m = machine(dir, { hidden: [KEY] });
    const { status, out, err } = await runSetup(dir, m.world);
    expect(err).toEqual([]);
    expect(status).toBe(0);
    expect(out[0]).toBe(`The resident will live in ${dir}. Its service will be named after the directory's name, ${dir.split('/').at(-1)}.`);
    const at = (start: string) => out.findIndex((line) => line.startsWith(start));
    const order = ['With the install\'s own copy', 'Setting up', 'This install\'s own command', 'Starting the installed host once',
      'The installed host', 'Checking the key', 'The key works', 'Setup\'s agent runs on', 'Starting setup\'s agent',
      'To go on with setup'].map(at);
    expect(order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1]!))).toBe(true);
    expect(m.ran.find((argv) => argv[2] === 'add')).toEqual(['bun', '--no-env-file', 'add', `${HOST}@${VERSION}`, '@animalabs/discord-mcpl']);
    expect(out).not.toContain(`Set up ${join(dir, 'connectome-host')}.`);
    expect(m.steps).toEqual(['node', 'add', 'own setup', 'boot', 'key check', 'agent']);
    const [boot] = m.boots;
    const bootDir = dirname(boot!.argv[2]!);
    expect(boot!.argv).toEqual(['bun', join(dir, 'connectome-host', 'releases', VERSION, 'node_modules', '@animalabs', 'connectome-host',
      'src', 'index.ts'), join(bootDir, 'boot.json'), '--no-tui']);
    expect(boot!.recipe).toMatchObject({ agent: { provider: 'mock' } });
    expect(boot!.env.DATA_DIR).toBe(join(bootDir, 'data'));
    expect(bootDir.startsWith(`${dir}/`)).toBe(false);
    expect(boot!.timeoutMs).toBe(60_000);
    expect(m.checked).toEqual([KEY]);
    expect(readFileSync(join(dir, '.env'), 'utf-8')).toBe(`ANTHROPIC_API_KEY="${KEY}"\n`);
    expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
    const [launch] = m.launched;
    expect(launch!.argv.slice(0, 2)).toEqual(['bun', '--no-env-file']);
    expect(launch!.cwd).toBe(join(dir, '.setup'));
    expect(launch!.env).toMatchObject({
      ANTHROPIC_API_KEY: KEY, DATA_DIR: join(dir, '.setup'), CONNECTOME_SETUP_DIR: dir, CONNECTOME_SETUP_USER: 'ada',
      CONNECTOME_SETUP_INSTALL: join(dir, 'connectome-host'), CONNECTOME_SETUP_VERSION: VERSION,
      CONNECTOME_SETUP_COMMAND: join(dir, 'connectome-host', 'connectome'), CONNECTOME_SETUP_TIME_ZONE: 'Europe/London',
    });
  });

  test('gives the agent each dotenv file that sets MODEL or MCPL_AGENT_OVERLAY_FILE, in Bun\'s order, and names one it can\'t read', async () => {
    const dir = ownDir();
    writeFileSync(join(dir, '.env.local'), 'OTHER=1\nMCPL_AGENT_OVERLAY_FILE=overlay.json\n');
    mkdirSync(join(dir, '.env.development'));
    writeFileSync(join(dir, '.env'), 'MODEL=""\n');
    const m = machine(dir, { hidden: [KEY] });
    m.world.cwd = scratch();
    expect((await runSetup(dir, m.world)).status).toBe(0);
    expect(readFileSync(join(dir, '.env'), 'utf-8')).toBe(`MODEL=""\nANTHROPIC_API_KEY="${KEY}"\n`);
    expect(m.launched[0]!.env.CONNECTOME_SETUP_DOTENV)
      .toBe('.env.local MCPL_AGENT_OVERLAY_FILE "overlay.json"; .env.development unreadable; .env MODEL ""');
    const none = scratch();
    const plain = machine(none, { hidden: [KEY] });
    expect((await runSetup(none, plain.world)).status).toBe(0);
    expect(plain.launched[0]!.env).not.toHaveProperty('CONNECTOME_SETUP_DOTENV');
  });

  test('stops at an ANTHROPIC_BASE_URL in .env that isn\'t a URL, naming it, before it asks for a key', async () => {
    const dir = ownDir();
    writeFileSync(join(dir, '.env'), 'ANTHROPIC_BASE_URL=not-a-url\n');
    const m = machine(dir, { hidden: [KEY] });
    const { status, err } = await runSetup(dir, m.world);
    expect(status).toBe(1);
    expect(err.join('\n')).toContain(`ANTHROPIC_BASE_URL in ${join(dir, '.env')} is "not-a-url", which isn't a URL. ` +
      'Correct it, or take that line away to use Anthropic\'s own API, then run setup again.');
    expect(m.launched).toEqual([]);
    expect(m.asked).toEqual([]);
  });

  test('stops at an ANTHROPIC_BASE_URL in .env that holds a $, which Bun reads otherwise, before it checks or asks for a key', async () => {
    const dir = ownDir();
    writeFileSync(join(dir, '.env'), 'ANTHROPIC_BASE_URL=https://${GATEWAY}/v1\n');
    const m = machine(dir, { hidden: [KEY] });
    const { status, err } = await runSetup(dir, m.world);
    expect(status).toBe(1);
    expect(err.join('\n')).toContain(`ANTHROPIC_BASE_URL in ${join(dir, '.env')} can't be used: it holds a double quote, a $ ` +
      'or a backslash, which Bun can read in a .env line otherwise than typed.');
    expect(m.checked).toEqual([]);
    expect(m.asked).toEqual([]);
    expect(m.launched).toEqual([]);
  });

  test('gives Bun\'s install, and the agent, no variable that a dotenv file where it was typed sets, whatever its value', async () => {
    const dir = ownDir();
    writeFileSync(join(dir, '.env'), 'DISCORD_TOKEN="from-env-file"\nSHARED="file"\n');
    writeFileSync(join(dir, '.env.local'), 'LOCAL_ONLY="from-local"\n');
    const m = machine(dir, {
      hidden: [KEY], env: { DISCORD_TOKEN: 'from-env-file', LOCAL_ONLY: 'from-local', SHARED: 'exported', OTHER: 'exported' },
    });
    expect((await runSetup(dir, m.world)).status).toBe(0);
    const added = m.envs[m.ran.findIndex((argv) => argv[2] === 'add')]!;
    expect(added).not.toHaveProperty('DISCORD_TOKEN');
    expect(added).not.toHaveProperty('LOCAL_ONLY');
    expect(added).not.toHaveProperty('SHARED');
    expect(added.OTHER).toBe('exported');
    expect(m.launched[0]!.env).not.toHaveProperty('DISCORD_TOKEN');
  });

  test('leaves out each name a dotenv file that Bun loads in some mode sets, a value Bun expanded and NODE_ENV\'s own files included', async () => {
    const dir = ownDir();
    writeFileSync(join(dir, '.env.local'), 'ANTHROPIC_API_KEY=sk-ant-$SUFFIX\n');
    writeFileSync(join(dir, '.env.production.local'), 'PROD_SECRET=from-production\n');
    writeFileSync(join(dir, '.env.example'), 'EXAMPLE_ONLY=placeholder\n');
    const m = machine(dir, {
      hidden: [KEY], env: {
        NODE_ENV: 'production', SUFFIX: 'expanded-0123456789', ANTHROPIC_API_KEY: 'sk-ant-expanded-0123456789',
        PROD_SECRET: 'from-production', EXAMPLE_ONLY: 'exported',
      },
    });
    expect((await runSetup(dir, m.world)).status).toBe(0);
    const added = m.envs[m.ran.findIndex((argv) => argv[2] === 'add')]!;
    expect(added).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(added).not.toHaveProperty('PROD_SECRET');
    expect(added.EXAMPLE_ONLY).toBe('exported');
    expect(m.asked.some((question) => question.includes('exported'))).toBe(false);
    expect(m.checked).toEqual([KEY]);
  });

  test('stops at a dotenv file Bun loads that it can\'t read where it was typed, naming it, before it runs anything', async () => {
    const dir = ownDir();
    mkdirSync(join(dir, '.env.local'));
    const m = machine(dir, { hidden: [KEY] });
    const { status, err } = await runSetup(dir, m.world);
    expect(status).toBe(1);
    expect(err.join('\n')).toContain(`${join(dir, '.env.local')} can't be read (EISDIR)`);
    expect(m.ran).toEqual([]);
  });

  test('gives the agent none of the CONNECTOME_SETUP_ settings the shell it was typed in exports', async () => {
    const dir = scratch();
    const m = machine(dir, { hidden: [KEY], env: { CONNECTOME_SETUP_LINGER_LINE: 'sudo rm -rf /', CONNECTOME_SETUP_X: '1' } });
    expect((await runSetup(dir, m.world)).status).toBe(0);
    expect(m.launched[0]!.env).not.toHaveProperty('CONNECTOME_SETUP_LINGER_LINE');
    expect(m.launched[0]!.env).not.toHaveProperty('CONNECTOME_SETUP_X');
  });

  test('says the least and the most that setup\'s agent cost in five test setups', async () => {
    const dir = scratch();
    const { out } = await runSetup(dir, machine(dir, { hidden: [KEY] }).world);
    expect(out).toContain('Setup\'s agent runs on claude-opus-5-5, and spends from this key. In five test setups, ' +
      'with a tester playing the person, it cost between $0.45 and $2.70 each at Anthropic\'s list prices; the higher ' +
      'figure includes the new resident\'s first calls, which couldn\'t be told apart from setup\'s.');
  });

  test('takes a key already in .env without asking, and an exported one on a yes', async () => {
    const inEnv = ownDir();
    writeFileSync(join(inEnv, '.env'), `ANTHROPIC_API_KEY=${KEY}\n`, { mode: 0o644 });
    const stored = machine(inEnv);
    expect((await runSetup(inEnv, stored.world)).status).toBe(0);
    expect(stored.checked).toEqual([KEY]);
    expect(stored.asked).toEqual([]);
    expect(statSync(join(inEnv, '.env')).mode & 0o777).toBe(0o600);
    const fresh = scratch();
    const exported = machine(fresh, { env: { ANTHROPIC_API_KEY: KEY }, answers: ['yes'] });
    expect((await runSetup(fresh, exported.world)).status).toBe(0);
    expect(exported.checked).toEqual([KEY]);
    expect(exported.asked.some((question) => question.includes('typed hidden'))).toBe(false);
  });

  test('offers no exported key where a base URL is exported and .env sets none, says why, and asks for one', async () => {
    const dir = scratch();
    const m = machine(dir, { hidden: [KEY], env: { ANTHROPIC_API_KEY: 'sk-ant-gateway-0123456789', ANTHROPIC_BASE_URL: 'https://gateway.example' } });
    const { status, out } = await runSetup(dir, m.world);
    expect(status).toBe(0);
    expect(m.asked.some((question) => question.includes('exported'))).toBe(false);
    expect(out.filter((line) => line.startsWith('An ANTHROPIC_BASE_URL is exported'))).toEqual([
      `An ANTHROPIC_BASE_URL is exported in this shell, and ${join(dir, '.env')} sets none. Setup, its agent and the ` +
      `resident take a base URL from ${join(dir, '.env')} alone, so setup offers no exported key, and checks the key it ` +
      `asks for at Anthropic's own API. To go on with that gateway, write ANTHROPIC_BASE_URL into ${join(dir, '.env')}, ` +
      'and run setup again.']);
    expect(m.checked).toEqual([KEY]);
    expect(m.bases).toEqual([undefined]);
    const gateway = ownDir();
    writeFileSync(join(gateway, '.env'), 'ANTHROPIC_BASE_URL=https://gateway.example\n');
    const again = machine(gateway, { answers: ['yes'], env: { ANTHROPIC_API_KEY: 'sk-ant-gateway-0123456789', ANTHROPIC_BASE_URL: 'https://gateway.example' } });
    const rerun = await runSetup(gateway, again.world);
    expect(rerun.status).toBe(0);
    expect(rerun.out.some((line) => line.startsWith('An ANTHROPIC_BASE_URL is exported'))).toBe(false);
    expect(again.checked).toEqual(['sk-ant-gateway-0123456789']);
    expect(again.bases).toEqual(['https://gateway.example']);
  });

  test('asks for no exported key where the key came from a dotenv file where setup was typed', async () => {
    const dir = scratch();
    const project = scratch();
    writeFileSync(join(project, 'package.json'), '{}');
    writeFileSync(join(project, '.env.local'), 'ANTHROPIC_API_KEY=sk-ant-project-0123456789\n');
    const m = machine(dir, { hidden: [KEY], env: { ANTHROPIC_API_KEY: 'sk-ant-project-0123456789' } });
    m.world.cwd = project;
    expect((await runSetup(dir, m.world)).status).toBe(0);
    expect(m.asked.some((question) => question.includes('exported'))).toBe(false);
    expect(m.checked).toEqual([KEY]);
  });

  test('asks again after a key the check refuses, with the house\'s words for its status', async () => {
    const dir = scratch();
    const m = machine(dir, { hidden: ['sk-ant-wrong-0123456', KEY], keys: [{ ok: false, said: 'api.anthropic.com answered 401: the key was refused: check that it was copied whole.' }] });
    const { status, out, err } = await runSetup(dir, m.world);
    expect(status).toBe(0);
    expect(err).toEqual(['api.anthropic.com answered 401: the key was refused: check that it was copied whole.']);
    expect(out).toContain('Type a key, this one again or another, or Enter alone to stop.');
    expect(m.checked).toEqual(['sk-ant-wrong-0123456', KEY]);
  });

  test('stops, with no agent, when Enter alone answers the key', async () => {
    const dir = scratch();
    const m = machine(dir, { hidden: [''] });
    const { status, out } = await runSetup(dir, m.world);
    expect(status).toBe(1);
    expect(out.at(-1)).toBe('Setup stopped. Run it again in this directory to go on.');
    expect(m.launched).toEqual([]);
  });

  test('runs node --version for real when the resident\'s directory doesn\'t exist yet, in its nearest parent, and in the directory once it exists', async () => {
    const home = scratch();
    const typedIn = join(home, 'project');
    mkdirSync(typedIn);
    writeFileSync(join(typedIn, 'notes.txt'), '');
    const dir = join(home, 'resident');
    const withRealNode = (hidden: string[]) => {
      const m = machine(typedIn, { hidden, env: { PATH: process.env.PATH ?? '' } });
      const fake = m.world.run;
      const spawned: string[] = [];
      m.world.run = async (argv, options) => {
        if (argv[0] !== 'node') return fake(argv, options);
        spawned.push(options.cwd);
        return realWorld().run(argv, options);
      };
      return { world: m.world, spawned };
    };
    const first = withRealNode([KEY]);
    const { status, err } = await runSetup(dir, first.world);
    expect(err).toEqual([]);
    expect(status).toBe(0);
    expect(first.spawned).toEqual([home]);
    const again = withRealNode([]);
    expect((await runSetup(dir, again.world)).status).toBe(0);
    expect(again.spawned).toEqual([dir]);
  });
});

test('the machine has a Node only where PATH finds a node that isn\'t the running Bun', () => {
  const bin = scratch();
  const world = realWorld();
  expect(world.hasNode(bin)).toBe(false);
  symlinkSync(process.execPath, join(bin, 'node'));
  expect(world.hasNode(bin)).toBe(false);
  rmSync(join(bin, 'node'));
  writeFileSync(join(bin, 'node'), '#!/bin/sh\n', { mode: 0o755 });
  expect(world.hasNode(bin)).toBe(true);
});

describe('where the resident lives', () => {
  test('in the directory the line was typed in where it is empty or setup\'s, and in ~/resident otherwise', () => {
    const home = scratch();
    const busy = scratch();
    writeFileSync(join(busy, 'notes.txt'), '');
    const own = ownDir();
    expect(setupDirectory(home, home)).toBe(home);
    expect(setupDirectory(busy, home)).toBe(join(home, 'resident'));
    expect(setupDirectory(own, home)).toBe(own);
  });

  test.skipIf(process.getuid?.() === 0)('in the directory the line was typed in where HOME can\'t be searched', () => {
    const locked = scratch();
    const busy = scratch();
    writeFileSync(join(busy, 'notes.txt'), '');
    chmodSync(locked, 0o600);
    try {
      expect(setupDirectory(busy, join(locked, 'home'))).toBe(busy);
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  test('takes a .setup that setup didn\'t make as another program\'s, and puts no resident there', async () => {
    const home = scratch();
    const project = scratch();
    mkdirSync(join(project, '.setup'));
    writeFileSync(join(project, '.setup', 'config.yml'), '');
    writeFileSync(join(project, 'package.json'), '{}');
    expect(setupDirectory(project, home)).toBe(join(home, 'resident'));
    const m = machine(project);
    const { status, err } = await runSetup(project, m.world);
    expect(status).toBe(1);
    expect(err[0]).toContain(`${project} holds other files, and no connectome-host install`);
    expect(m.ran).toEqual([]);
    expect(readFileSync(join(project, 'package.json'), 'utf-8')).toBe('{}');
  });

  test('takes a directory where setup stopped before it made the install as setup\'s', async () => {
    const dir = scratch();
    const first = machine(dir, { fails: { add: { status: 1, stdout: '', stderr: 'error: no registry' } } });
    expect((await runSetup(dir, first.world)).status).toBe(1);
    expect(existsSync(join(dir, 'connectome-host', 'install.json'))).toBe(false);
    expect(setupDirectory(dir, scratch())).toBe(dir);
    const { status, out } = await runSetup(dir, machine(dir, { hidden: [KEY] }).world);
    expect(status).toBe(0);
    expect(out[0]).toBe(`Setup ran in ${dir} before. Its agent can change with you what it set up.`);
  });

  test('asks, with no as the default, before it makes an install on a data directory that holds files and no record', async () => {
    const dir = ownDir();
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'data', 'store.json'), '{}');
    const no = machine(dir, { hidden: [KEY], answers: [''] });
    const { status, out } = await runSetup(dir, no.world);
    expect(status).toBe(0);
    expect(no.asked).toEqual([`Make a new install of ${VERSION} on that data? (yes/no) [no] `]);
    expect(out.join('\n')).toContain(`${join(dir, 'data')} holds a resident's data, and there's no install record`);
    expect(no.ran.some((argv) => argv[2] === 'add' || argv[2]?.endsWith(join('src', 'update', 'setup.ts')))).toBe(false);
    expect(existsSync(join(dir, 'connectome-host'))).toBe(false);
    const yes = machine(dir, { hidden: [KEY], answers: ['yes'] });
    const made = await runSetup(dir, yes.world);
    expect(made.status).toBe(0);
    expect(yes.ran.some((argv) => argv[2]?.endsWith(join('src', 'update', 'setup.ts')))).toBe(true);
    expect(made.out).toContain(`Set up ${join(dir, 'connectome-host')}.`);
    expect(made.out.some((line) => line.startsWith('This install\'s own command is'))).toBe(false);
    const empty = ownDir();
    mkdirSync(join(empty, 'data'));
    const plain = machine(empty, { hidden: [KEY] });
    expect((await runSetup(empty, plain.world)).status).toBe(0);
    expect(plain.asked.some((question) => question.includes('on that data'))).toBe(false);
  });

  test.skipIf(process.getuid?.() === 0)('stops where it can\'t list the directory, naming it, and makes nothing there', async () => {
    const home = scratch();
    const dir = scratch();
    writeFileSync(join(dir, 'notes.txt'), '');
    chmodSync(dir, 0o300);
    try {
      expect(setupDirectory(dir, home)).toBe(dir);
      const m = machine(dir, { hidden: [KEY] });
      const { status, err } = await runSetup(dir, m.world);
      expect(status).toBe(1);
      expect(err.join('\n')).toContain(`${dir} can't be listed (EACCES)`);
      expect(m.ran).toEqual([]);
      expect(existsSync(join(dir, '.setup'))).toBe(false);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test('refuses a directory that holds other files and no install, and makes nothing there', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'notes.txt'), '');
    const m = machine(dir);
    const { status, err } = await runSetup(dir, m.world);
    expect(status).toBe(1);
    expect(err[0]).toContain(`${dir} holds other files, and no connectome-host install`);
    expect(existsSync(join(dir, '.setup'))).toBe(false);
    expect(m.ran).toEqual([]);
  });

  test('says first that setup ran there before, in a directory setup ran in, and installs nothing again', async () => {
    const dir = scratch();
    await runSetup(dir, machine(dir, { hidden: [KEY] }).world);
    const again = machine(dir, { sudo: true });
    const { status, out } = await runSetup(dir, again.world);
    expect(status).toBe(0);
    expect(out[0]).toBe(`Setup ran in ${dir} before. Its agent can change with you what it set up.`);
    expect(out).toContain(`Set up ${join(dir, 'connectome-host')}.`);
    expect(again.ran.some((argv) => argv[2] === 'add')).toBe(false);
    expect(again.asked).toEqual([]);
  });
});

describe('the user the resident runs as', () => {
  test('is asked about first, where sudo and systemd are, and a no says how to go on as a user of its own', async () => {
    const dir = scratch();
    const m = machine(dir, { sudo: true, answers: ['no'] });
    const { status, out } = await runSetup(dir, m.world);
    expect(status).toBe(0);
    expect(m.asked).toEqual(['Go on as ada? (yes/no) [yes] ']);
    expect(out.some((line) => line.startsWith('  id -u connectome >/dev/null 2>&1 || sudo useradd'))).toBe(true);
    expect(out.at(-1)).toBe('Nothing was installed here.');
    expect(existsSync(join(dir, '.setup'))).toBe(false);
    expect(m.ran).toEqual([]);
  });

  test('a yes goes on, and the agent gets the line setup showed', async () => {
    const dir = scratch();
    const m = machine(dir, { sudo: true, answers: [''], hidden: [KEY] });
    expect((await runSetup(dir, m.world)).status).toBe(0);
    expect(m.launched[0]!.env.CONNECTOME_SETUP_OWN_USER_LINE).toStartWith('id -u connectome >/dev/null 2>&1');
  });

  test('on a run after the install was made, the agent gets no such line, since setup showed none', async () => {
    const dir = scratch();
    expect((await runSetup(dir, machine(dir, { hidden: [KEY] }).world)).status).toBe(0);
    const again = machine(dir, { sudo: true });
    expect((await runSetup(dir, again.world)).status).toBe(0);
    expect(again.asked).toEqual([]);
    expect(again.launched[0]!.env).not.toHaveProperty('CONNECTOME_SETUP_OWN_USER_LINE');
  });
});

describe('the service manager', () => {
  test('with linger off, gives the line that turns it on, to the person and to the agent', async () => {
    const dir = scratch();
    const m = machine(dir, { linger: false, hidden: [KEY] });
    const { out } = await runSetup(dir, m.world);
    expect(out).toContain('  loginctl enable-linger ada');
    expect(m.launched[0]!.env.CONNECTOME_SETUP_LINGER_LINE).toBe('loginctl enable-linger ada');
  });

  test('on a Mac, says when a service stops, and gives the agent what the session check gave', async () => {
    const dir = scratch();
    const m = machine(dir, { platform: 'darwin', linger: null, macSession: 'exit 113', hidden: [KEY] });
    const { out } = await runSetup(dir, m.world);
    expect(out.some((line) => line.startsWith('On macOS, a service of ada\'s stops when ada logs out'))).toBe(true);
    expect(m.launched[0]!.env.CONNECTOME_SETUP_MAC_SESSION).toBe('exit 113');
  });
});

describe('refusals', () => {
  const refused = async (opts: Parameters<typeof machine>[1], argv?: string[]) => {
    const dir = scratch();
    const m = machine(dir, { hidden: [KEY], ...opts });
    return { ...(await runSetup(dir, m.world, argv)), m, dir };
  };

  test('another surface gets the usage', async () => {
    const { status, err } = await refused({}, ['slack']);
    expect(status).toBe(2);
    expect(err[0]).toBe('Usage: connectome setup discord');
  });

  test('no terminal', async () => {
    const dir = scratch();
    const m = machine(dir);
    const { status, err } = await runSetup(dir, { ...m.world, terminal: false });
    expect(status).toBe(1);
    expect(err[0]).toStartWith('connectome setup needs a person at a terminal');
  });

  test('a Bun below 1.4.4, leaving the directory as setup found it', async () => {
    const { status, err, dir } = await refused({ bun: '1.4.3' });
    expect(status).toBe(1);
    expect(err[0]).toStartWith('Setup needs Bun 1.4.4 or later');
    expect(existsSync(join(dir, '.setup'))).toBe(false);
  });

  test('no Node on PATH, or only Bun\'s own stand-in for it, said plainly, leaving the directory as setup found it', async () => {
    const { status, err, dir } = await refused({ hasNode: false, fails: { node: { status: 1, stdout: '', stderr: '' } } });
    expect(status).toBe(1);
    expect(err[0]).toStartWith('There\'s no Node on this machine\'s PATH. connectome-host needs Node as well as Bun.');
    expect(existsSync(join(dir, '.setup'))).toBe(false);
  });

  test('a Node of the machine\'s own that doesn\'t answer, with how it ended', async () => {
    const { status, err } = await refused({ fails: { node: { status: 1, stdout: '', stderr: '' } } });
    expect(status).toBe(1);
    expect(err[0]).toContain('`node --version` didn\'t answer here (exit 1)');
  });

  test('an install that doesn\'t finish', async () => {
    const { status, err, m } = await refused({ fails: { add: { status: 1, stdout: '', stderr: '' } } });
    expect(status).toBe(1);
    expect(err[0]).toStartWith('`bun --no-env-file add');
    expect(m.launched).toEqual([]);
  });

  test('the install\'s own setup failing, with its own lines', async () => {
    const { status, out, err } = await refused({ fails: { 'own-setup': { status: 1, stdout: 'the root is taken\n', stderr: '' } } });
    expect(status).toBe(1);
    expect(out).toContain('the root is taken');
    expect(err[0]).toStartWith('The install\'s own setup');
  });

  test('a host that doesn\'t boot, with its own lines', async () => {
    const { status, err } = await refused({ fails: { boot: { status: 1, stdout: '', stderr: 'Cannot find module x\n' } } });
    expect(status).toBe(1);
    expect(err).toContain('  Cannot find module x');
  });

  test('a release with no setup agent', async () => {
    const { status, err } = await refused({ recipe: null });
    expect(status).toBe(1);
    expect(err[0]).toContain('has no setup agent');
  });

  test('a setup recipe that names no model', async () => {
    const { status, err, m } = await refused({ recipe: '{}' });
    expect(status).toBe(1);
    expect(err[0]).toEndWith('setup.json, the setup agent\'s recipe, names no agent.model');
    expect(m.launched).toEqual([]);
  });

  test('an install record whose data directory isn\'t there stops setup, which makes none in its place', async () => {
    const dir = scratch();
    expect((await runSetup(dir, machine(dir, { hidden: [KEY] }).world)).status).toBe(0);
    const record = join(dir, 'connectome-host', 'install.json');
    const data = JSON.parse(readFileSync(record, 'utf-8')).dataDir as string;
    rmSync(data, { recursive: true, force: true });
    const again = machine(dir, { hidden: [KEY] });
    const { status, err } = await runSetup(dir, again.world);
    expect(status).toBe(1);
    expect(err.join('\n')).toContain(`${record} names ${data} as its data directory, and no directory is there`);
    expect(existsSync(data)).toBe(false);
    expect(again.launched).toEqual([]);
  });

  test('an install record that names no data directory stops setup, which says so', async () => {
    const dir = scratch();
    mkdirSync(join(dir, 'connectome-host'));
    const record = join(dir, 'connectome-host', 'install.json');
    writeFileSync(record, JSON.stringify({ v: 1, extraState: [] }));
    const m = machine(dir, { hidden: [KEY] });
    const { status, err } = await runSetup(dir, m.world);
    expect(status).toBe(1);
    expect(err.join('\n')).toContain(`The install record at ${record} names no data directory, so setup stops here.`);
    expect(m.ran.some((argv) => argv[2]?.endsWith(join('src', 'update', 'setup.ts')))).toBe(false);
    expect(existsSync(join(dir, 'data'))).toBe(false);
  });

  test('an install record\'s relative data directory is the one beside the install, from any directory', async () => {
    const dir = scratch();
    expect((await runSetup(dir, machine(dir, { hidden: [KEY] }).world)).status).toBe(0);
    const record = join(dir, 'connectome-host', 'install.json');
    writeFileSync(record, JSON.stringify({ ...JSON.parse(readFileSync(record, 'utf-8')), dataDir: 'data' }));
    const again = machine(dir, { hidden: [KEY] });
    again.world.cwd = scratch();
    const { status, err } = await runSetup(dir, again.world);
    expect(err).toEqual([]);
    expect(status).toBe(0);
    expect(again.envs[again.ran.findIndex((argv) => argv[2]?.endsWith(join('src', 'update', 'setup.ts')))]!.DATA_DIR).toBe(join(dir, 'data'));
  });

  test('a damaged install record, saying what couldn\'t be read', async () => {
    const dir = scratch();
    mkdirSync(join(dir, 'connectome-host'));
    writeFileSync(join(dir, 'connectome-host', 'install.json'), 'not json');
    const { status, err } = await runSetup(dir, machine(dir, { hidden: [KEY] }).world);
    expect(status).toBe(1);
    expect(err[0]).toBe(`connectome setup: The install record at ${join(dir, 'connectome-host', 'install.json')} isn't JSON, so this release can't read it.`);
  });
});
