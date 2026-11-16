import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, setupDirectory } from '../src/cli/setup.js';
import { packageJson } from '../src/setup/packages.js';
import type { KeyCheck } from '../src/setup/key-check.js';
import type { AgentLaunch, Ran, RunOptions, SetupWorld } from '../src/setup/world.js';

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

/** A machine for the script: each program it runs answers as the steps below say. */
function machine(dir: string, opts: {
  answers?: string[]; hidden?: string[]; keys?: KeyCheck[]; env?: Record<string, string>; platform?: NodeJS.Platform;
  sudo?: boolean; linger?: boolean | null; macSession?: string | null; bun?: string;
  fails?: Partial<Record<'node' | 'add' | 'own-setup' | 'boot', Ran>>; recipe?: string | null;
} = {}) {
  const asked: string[] = [];
  const ran: string[][] = [];
  const launched: AgentLaunch[] = [];
  const checked: string[] = [];
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
    lingerOf: () => (opts.linger === undefined ? true : opts.linger),
    macSession: () => (opts.macSession === undefined ? null : opts.macSession),
    timeZone: 'Europe/London',
    userExists: () => false,
    ask: async (question) => { asked.push(question); return answers.shift() ?? null; },
    askHidden: async (label) => { asked.push(label); return hidden.shift() ?? null; },
    run: async (argv: string[], options: RunOptions) => {
      ran.push(argv);
      if (argv[0] === 'node') return opts.fails?.node ?? ok('v24.1.0\n');
      if (argv[2] === 'add') {
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
      return opts.fails?.boot ?? ok();
    },
    checkKey: async ({ key }) => { checked.push(key); return keys.shift() ?? { ok: true }; },
    startAgent: async (launch) => { launched.push(launch); return 0; },
  };
  return { world, asked, ran, launched, checked };
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

  test('says the two test setups\' figures for what setup\'s agent spends', async () => {
    const dir = scratch();
    const { out } = await runSetup(dir, machine(dir, { hidden: [KEY] }).world);
    expect(out).toContain('Setup\'s agent runs on claude-opus-5-5, and spends from this key. In five test setups, ' +
      'with a tester playing the person, it cost between $0.45 and $2.70 each at Anthropic\'s list prices; the higher ' +
      'figure includes the new resident\'s first calls, which couldn\'t be told apart from setup\'s.');
  });

  test('takes a key already in .env without asking, and an exported one on a yes', async () => {
    const inEnv = scratch();
    mkdirSync(join(inEnv, '.setup'));
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
});

describe('where the resident lives', () => {
  test('in the directory the line was typed in where it is empty or setup\'s, and in ~/resident otherwise', () => {
    const home = scratch();
    const busy = scratch();
    writeFileSync(join(busy, 'notes.txt'), '');
    const own = scratch();
    mkdirSync(join(own, '.setup'));
    expect(setupDirectory(home, home)).toBe(home);
    expect(setupDirectory(busy, home)).toBe(join(home, 'resident'));
    expect(setupDirectory(own, home)).toBe(own);
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

  test('says first that it goes on where it stopped, in a directory setup ran in, and installs nothing again', async () => {
    const dir = scratch();
    await runSetup(dir, machine(dir, { hidden: [KEY] }).world);
    const again = machine(dir, { sudo: true });
    const { status, out } = await runSetup(dir, again.world);
    expect(status).toBe(0);
    expect(out[0]).toBe(`Setup ran in ${dir} before. Its agent picks up where it stopped, and can change with you what it set up.`);
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
    return { ...(await runSetup(dir, m.world, argv)), m };
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

  test('a Bun below 1.4.4', async () => {
    const { status, err } = await refused({ bun: '1.4.3' });
    expect(status).toBe(1);
    expect(err[0]).toStartWith('Setup needs Bun 1.4.4 or later');
  });

  test('no Node', async () => {
    const { status, err } = await refused({ fails: { node: { status: null, stdout: '', stderr: '', startError: 'spawn node ENOENT' } } });
    expect(status).toBe(1);
    expect(err[0]).toContain('`node --version` didn\'t answer here (it couldn\'t be started (spawn node ENOENT))');
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

  test('a damaged install record, saying what couldn\'t be read', async () => {
    const dir = scratch();
    mkdirSync(join(dir, 'connectome-host'));
    writeFileSync(join(dir, 'connectome-host', 'install.json'), 'not json');
    const { status, err } = await runSetup(dir, machine(dir, { hidden: [KEY] }).world);
    expect(status).toBe(1);
    expect(err[0]).toBe(`connectome setup: The install record at ${join(dir, 'connectome-host', 'install.json')} isn't JSON, so this release can't read it.`);
  });
});
