import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync,
  statSync, lstatSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { SETUP_BUN_FLOOR, SETUP_SUMMARY, costLine, firstLine, realWorld, setup, type AgentLaunch, type Ran, type RunOptions, type SetupWorld } from '../src/cli/setup.js';
import { bunBelowFloor } from '../src/bun-floor.js';
import { defaultTrusted } from '../src/setup/default-trusted.js';
import { checkKey, type KeyCheck, type KeyCheckOptions } from '../src/setup/key-check.js';
import { lingerOf } from '../src/setup/linger.js';
import { SetupModule } from '../src/modules/setup-module.js';
import { readEnvFile } from '../src/setup/secrets.js';
import { writeInstallCommand } from '../src/cli/install-command.js';
import { ENTRY_POINT, EXTRA_STATE_LINE, LIST_A_PLACE, WRITE_RECORD_AGAIN, installPaths, keptOutsideLines } from '../src/update/contract.js';
import { entryPointText } from '../src/update/setup.js';
import { machineOps, shellWord, takeLock } from '../src/update/launcher.js';
import { HostUpdate } from '../src/update/update.js';

const REPO = resolve(import.meta.dir, '..');
const BIN = join(REPO, 'src', 'cli', 'connectome.ts');
const VERSION = (JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf-8')) as { version: string }).version;
const NODE_FLOOR = (JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf-8')) as { engines: { node: string } }).engines.node.replace('>=', '');
const SETUP_MODEL = 'claude-opus-5-5';
const made: string[] = [];
const args = (argv: string[]) => argv.slice(argv[1] === '--no-env-file' ? 2 : 1);

const DEFAULT_TRUSTED = ['node-pty', 'puppeteer'];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function directory(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'setup-')));
  made.push(dir);
  return dir;
}

interface Script {
  answers?: string[];
  secrets?: string[];
  keys?: KeyCheck[];
  node?: string | null;
  nodeRan?: Ran;
  boot?: 'real' | Ran;
  host?: string;
  release?: string;
  installSetup?: Ran;
  installSetupSays?: string;
  added?: Ran;
  trusted?: Ran;
  pty?: Ran[];
  atPtyCheck?: (cwd: string) => void;
  installed?: Ran;
  atInstall?: (cwd: string) => void;
  atAdd?: (cwd: string) => void;
  duringBoot?: () => void;
}

interface Seen {
  out: string[];
  err: string[];
  asked: string[];
  ran: string[][];
  options: RunOptions[];
  checked: KeyCheckOptions[];
  launched: AgentLaunch | null;
  outAtLaunch?: number;
  boot?: RunOptions;
}

function world(dir: string, script: Script = {}, over: Partial<SetupWorld> = {}): { world: SetupWorld; seen: Seen } {
  const seen: Seen = { out: [], err: [], asked: [], ran: [], options: [], checked: [], launched: null };
  const answers = [...(script.answers ?? [])];
  const secrets = [...(script.secrets ?? [])];
  const keys = [...(script.keys ?? [])];
  const real = realWorld();
  const run = async (argv: string[], options: RunOptions): Promise<Ran> => {
    seen.ran.push(argv);
    seen.options.push(options);
    if (argv[0] === 'node' && argv[1] === '-e') {
      script.atPtyCheck?.(options.cwd);
      return script.pty?.shift() ?? { status: 0, stdout: '', stderr: '' };
    }
    if (argv[0] === 'node') {
      if (script.nodeRan) return script.nodeRan;
      const node = script.node === undefined ? '22.20.0' : script.node;
      return node === null ? { status: null, stdout: '', stderr: '', startError: { code: 'ENOENT', message: 'Executable not found in $PATH: "node"' } }
        : { status: 0, stdout: `v${node}\n`, stderr: '' };
    }
    if (args(argv)[0] === 'pm' && args(argv)[1] === 'default-trusted') {
      return script.trusted ?? { status: 0, stdout: `Default trusted dependencies (2):\n - ${DEFAULT_TRUSTED.join('\n - ')}\n`, stderr: '' };
    }
    if (args(argv)[0] === 'install') {
      script.atInstall?.(options.cwd);
      return script.installed ?? { status: 0, stdout: '', stderr: '' };
    }
    if (args(argv)[0] === 'add') {
      if (script.added) return script.added;
      const manifestFile = join(options.cwd, 'package.json');
      const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf-8')) as Record<string, unknown> : {};
      const dependencies = (manifest.dependencies ?? {}) as Record<string, string>;
      for (const spec of args(argv).slice(1)) {
        const at = spec.lastIndexOf('@');
        const [name, version] = at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, '1.0.0'];
        mkdirSync(join(options.cwd, 'node_modules', name), { recursive: true });
        writeFileSync(join(options.cwd, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }));
        dependencies[name] = `^${version}`;
      }
      writeFileSync(manifestFile, JSON.stringify({ ...manifest, dependencies }));
      script.atAdd?.(options.cwd);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args(argv)[0]?.endsWith(join('src', 'update', 'setup.ts'))) {
      expect(args(argv)[0]).toBe(join(options.cwd, 'node_modules', '@animalabs', 'connectome-host', 'src', 'update', 'setup.ts'));
      if (script.installSetup) return script.installSetup;
      const at = argv.indexOf('--root');
      const root = at > 0 ? argv[at + 1]! : join(options.cwd, 'connectome-host');
      const dataDir = options.env.DATA_DIR ?? '';
      if (!existsSync(dataDir) || !statSync(dataDir).isDirectory()) {
        return { status: 1, stdout: '', stderr: `connectome-host setup: The data directory ${dataDir} isn't there.\n` };
      }
      const record = join(root, 'install.json');
      let before: string | null = null;
      if (existsSync(record)) {
        const recorded = JSON.parse(readFileSync(record, 'utf-8')) as { dataDir: string; workingDir?: string };
        const here = dirname(realpathSync(root));
        const runs = () => basename(readlinkSync(join(root, 'current')));
        if (recorded.workingDir !== here) {
          writeFileSync(record, JSON.stringify({ ...recorded, dataDir, workingDir: here }));
          before = `Bound the install at ${root} to ${here}, where it serves ${dataDir} and runs ${runs()}.`;
        } else if (realpathSync(recorded.dataDir) !== realpathSync(dataDir)) {
          return { status: 1, stdout: '', stderr: `connectome-host setup: The install at ${root} serves ${recorded.dataDir}, not ${dataDir}.\n` };
        } else {
          before = `The install at ${root} serves ${recorded.dataDir} and runs ${runs()}, as before.`;
        }
      }
      const release = script.release ?? VERSION;
      const scope = join(root, 'releases', release, 'node_modules', '@animalabs');
      if (!existsSync(scope)) {
        mkdirSync(scope, { recursive: true });
        if (script.host === 'copy') {
          const host = join(scope, 'connectome-host');
          for (const part of ['src', 'recipes', 'package.json']) cpSync(join(REPO, part), join(host, part), { recursive: true });
          symlinkSync(join(REPO, 'node_modules'), join(host, 'node_modules'));
        } else {
          symlinkSync(script.host ?? REPO, join(scope, 'connectome-host'));
        }
        symlinkSync(join('releases', release), join(root, 'current'));
        const extraState = keptOutsideLines(script.installSetupSays ?? '').filter((line) => line.startsWith('  ') && line !== '  none')
          .map((line) => line.slice(2));
        writeFileSync(join(root, 'install.json'), JSON.stringify({ v: 1, dataDir, extraState, workingDir: dirname(realpathSync(root)) }));
        writeFileSync(join(root, ENTRY_POINT), entryPointText());
      }
      writeInstallCommand(root, options.env.PATH);
      const first = before ?? `Set up ${root} as the install of ${release} that serves ${dataDir}.`;
      return { status: 0, stdout: `${first}\n${script.installSetupSays ?? ''}`, stderr: '' };
    }
    if (argv[1]?.endsWith(join('src', 'index.ts'))) {
      seen.boot = options;
      script.duringBoot?.();
      if (script.boot === 'real') return real.run(argv, options);
      return script.boot ?? { status: 0, stdout: 'Done.\n', stderr: '' };
    }
    throw new Error(`setup ran something this world doesn't know: ${argv.join(' ')}`);
  };
  return {
    seen,
    world: {
      terminal: true,
      platform: 'linux',
      user: 'alice',
      env: { PATH: '/usr/bin:/bin', HOME: dir },
      cwd: dir,
      execArgv: [],
      bun: { path: process.execPath, version: '1.4.4' },
      hasSudo: true,
      lingerOf: () => true,
      userExists: () => false,
      ask: async (question) => {
        seen.asked.push(question);
        return answers.shift() ?? null;
      },
      askHidden: async (label) => {
        seen.asked.push(label);
        return secrets.shift() ?? null;
      },
      run,
      checkKey: async (options) => {
        seen.checked.push(options);
        return keys.shift() ?? { ok: true };
      },
      startAgent: async (launch) => {
        seen.launched = launch;
        seen.outAtLaunch = seen.out.length;
        return 0;
      },
      ...over,
    },
  };
}

async function runSetup(dir: string, argv: string[], made: { world: SetupWorld; seen: Seen }): Promise<number> {
  return setup({
    root: join(dir, 'connectome-host'), argv,
    out: (line) => { made.seen.out.push(line); },
    err: (line) => { made.seen.err.push(line); },
  }, made.world);
}

const text = (lines: string[]) => lines.join('\n');
const KEY = 'sk-ant-api03-test-key';

test('setup sets up Discord alone, and names it when asked for anything else', async () => {
  const dir = directory();
  for (const argv of [['telegram'], [], ['discord', 'now']]) {
    const made = world(dir);
    expect(await runSetup(dir, argv, made)).toBe(2);
    expect(text(made.seen.err)).toContain(`Usage: ${firstLine()}`);
    expect(text(made.seen.err)).toContain('Discord is the one surface setup sets a resident up on.');
    expect(made.seen.asked).toEqual([]);
  }
  expect(readdirSync(dir)).toEqual([]);
});

test('setup\'s usage line is the command that runs it here: the package\'s first line, or the install\'s own command', async () => {
  const dir = directory();
  const fresh = world(dir);
  expect(await runSetup(dir, ['telegram'], fresh)).toBe(2);
  expect(fresh.seen.err[0]).toBe(`Usage: ${firstLine()}`);
  const root = join(dir, 'connectome-host');
  mkdirSync(root);
  writeInstallCommand(root, '');
  const installed = world(dir);
  expect(await runSetup(dir, ['telegram'], installed)).toBe(2);
  expect(installed.seen.err[0]).toBe(`Usage: ${shellWord(join(root, 'connectome'))} setup discord`);
});

test('a BUN_OPTIONS that holds --env-file is refused before any question, naming the line that runs setup without it', async () => {
  // Each BUN_OPTIONS beside the execArgv Bun 1.4.4 gives under it.
  for (const [options, execArgv] of [
    ['--env-file=/elsewhere/.env', ['--env-file=/elsewhere/.env']],
    ['--smol --env-file /elsewhere/.env', ['--smol', '--env-file', '/elsewhere/.env']],
    ['"--env-file=/else where/.env"', ['--env-file=/else where/.env']],
    ["--env-file='/else where/.env'", ["--env-file='/else where/.env'"]],
  ] as const) {
    const dir = directory();
    const made = world(dir, {}, { env: { PATH: '/usr/bin:/bin', HOME: dir, BUN_OPTIONS: options }, execArgv: [...execArgv] });
    expect(await runSetup(dir, ['discord'], made)).toBe(1);
    expect(text(made.seen.err)).toContain('BUN_OPTIONS holds --env-file');
    expect(text(made.seen.err)).not.toContain('Bun was started');
    expect(made.seen.err).toContain(`  env -u BUN_OPTIONS ${firstLine()}`);
    expect(made.seen.asked).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  }
  const dir = directory();
  const root = join(dir, 'connectome-host');
  mkdirSync(root);
  writeInstallCommand(root, '');
  const installed = world(dir, {}, {
    env: { PATH: '/usr/bin:/bin', HOME: dir, BUN_OPTIONS: '--env-file=/elsewhere/.env' }, execArgv: ['--env-file=/elsewhere/.env'],
  });
  expect(await runSetup(dir, ['discord'], installed)).toBe(1);
  expect(installed.seen.err).toContain(`  env -u BUN_OPTIONS ${shellWord(join(root, 'connectome'))} setup discord`);
  expect(installed.seen.asked).toEqual([]);
  expect(readdirSync(dir)).toEqual(['connectome-host']);
});

test('a Bun started with --env-file is refused before any question, naming setup\'s line to run without it', async () => {
  for (const execArgv of [['--env-file=/elsewhere/.env'], ['--smol', '--env-file', '/elsewhere/.env']]) {
    const dir = directory();
    const made = world(dir, {}, { execArgv });
    expect(await runSetup(dir, ['discord'], made)).toBe(1);
    expect(text(made.seen.err)).toContain('Bun was started with --env-file');
    expect(made.seen.err).toContain(`  ${firstLine()}`);
    expect(text(made.seen.err)).not.toContain('BUN_OPTIONS');
    expect(made.seen.asked).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  }
});

test('a BUN_OPTIONS and a Bun start without --env-file leave setup to ask its questions', async () => {
  const dir = directory();
  const made = world(dir, {}, { env: { PATH: '/usr/bin:/bin', HOME: dir, BUN_OPTIONS: '--smol' }, execArgv: ['--smol'] });
  await runSetup(dir, ['discord'], made);
  expect(made.seen.asked.length).toBeGreaterThan(0);
  expect(text(made.seen.err)).not.toContain('--env-file');
});

test('the package\'s bin, without a terminal, says setup needs a person at one and leaves the directory as it was',
  async () => {
    const dir = directory();
    const child = spawn(process.execPath, [BIN, 'setup', 'discord'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.stdin.end();
    const status = await new Promise<number | null>((done) => child.on('close', done));
    expect(status).toBe(1);
    expect(err).toContain('needs a person at a terminal');
    expect(readdirSync(dir)).toEqual([]);
  });

test('where no user of its own is possible, a directory holding other files and no install is refused before any question, naming the line that makes one', async () => {
  for (const over of [{ hasSudo: false }, { platform: 'darwin' as const }, { lingerOf: () => null }]) {
    const dir = directory();
    writeFileSync(join(dir, '.bashrc'), '# mine\n');
    const made = world(dir, {}, over);
    expect(await runSetup(dir, ['discord'], made)).toBe(1);
    expect(text(made.seen.err)).toContain('Make a new directory for the resident, and run this same version of setup there. Its service takes the directory\'s name, so choose another than resident if you like, or if ~/resident is already there:\n  mkdir ~/resident && cd ~/resident');
    expect(text(made.seen.err)).toContain(`bunx @animalabs/connectome-host@${VERSION} setup discord`);
    expect(made.seen.asked).toEqual([]);
    expect(readdirSync(dir)).toEqual(['.bashrc']);
  }
});

test('a .setup directory that isn\'t setup\'s, holding neither its lock nor its answers, doesn\'t make a directory setup\'s', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.setup', 'config.yml'), 'mine: true\n');
  writeFileSync(join(dir, 'package.json'), '{"name":"mine"}\n');
  const made = world(dir, {}, { hasSudo: false, env: { PATH: '/usr/bin:/bin', HOME: directory() } });
  expect(await runSetup(dir, ['discord'], made)).toBe(1);
  expect(text(made.seen.err)).toContain(`connectome setup: ${dir} holds other files, and no connectome-host install, so setup won't put its own there.`);
  expect(made.seen.asked).toEqual([]);
  expect(readdirSync(dir).sort()).toEqual(['.setup', 'package.json']);
  expect(readdirSync(join(dir, '.setup'))).toEqual(['config.yml']);
});

test('the check for a user by that name runs getent with no variable but PATH, so nothing a dotenv file gave setup reaches it', () => {
  const bin = directory();
  const seen = join(bin, 'seen-env');
  writeFileSync(join(bin, 'getent'), `#!/bin/sh\nenv > ${JSON.stringify(seen)}\nexit 2\n`, { mode: 0o755 });
  const before = { PATH: process.env.PATH, FROM_A_DOTENV_FILE: process.env.FROM_A_DOTENV_FILE };
  process.env.PATH = `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`;
  process.env.FROM_A_DOTENV_FILE = 'a-value';
  try {
    expect(realWorld().userExists('anyone')).toBe(false);
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  const names = readFileSync(seen, 'utf-8').split('\n').filter((line) => line !== '').map((line) => line.slice(0, line.indexOf('=')));
  expect(names.filter((name) => name !== 'PWD' && name !== 'SHLVL' && name !== '_')).toEqual(['PATH']);
});

test('the pty check opens node-pty where term-sessions-mcp\'s own resolution finds it, under a hoisted layout and under an isolated one', async () => {
  const dir = directory();
  const broken = { status: 1, stdout: '', stderr: 'Failed to load native module: pty.node, checked: build/Release\n' };
  const made = world(dir, { answers: ['yes', '2'], secrets: [KEY], pty: [broken, broken] });
  await runSetup(dir, ['discord'], made);
  const check = made.seen.ran.find((argv) => argv[0] === 'node' && argv[1] === '-e')![2]!;
  const pty = 'module.exports = { spawn: () => ({ onData: (f) => setTimeout(() => f(\'pty-ok\\r\\n\'), 0), onExit: (f) => setTimeout(f, 5) }) };\n';
  const layouts = {
    hoisted: ['node_modules/term-sessions-mcp', 'node_modules/node-pty'],
    isolated: ['node_modules/.bun/term-sessions-mcp@1/node_modules/term-sessions-mcp', 'node_modules/.bun/term-sessions-mcp@1/node_modules/node-pty'],
  };
  for (const [layout, [server, nodePty]] of Object.entries(layouts)) {
    const at = directory();
    mkdirSync(join(at, server!), { recursive: true });
    writeFileSync(join(at, server!, 'package.json'), '{"name":"term-sessions-mcp"}\n');
    mkdirSync(join(at, nodePty!), { recursive: true });
    writeFileSync(join(at, nodePty!, 'package.json'), '{"name":"node-pty","main":"index.js"}\n');
    writeFileSync(join(at, nodePty!, 'index.js'), pty);
    if (layout === 'isolated') symlinkSync(join(at, server!), join(at, 'node_modules', 'term-sessions-mcp'));
    const ran = Bun.spawnSync(['node', '-e', check], { cwd: at, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
    expect({ layout, status: ran.exitCode, stderr: ran.stderr.toString() }).toEqual({ layout, status: 0, stderr: '' });
  }
});

test('where a user of its own is possible, a directory holding other files and no install hears who the resident runs as first, then the lines that make its directory and run setup there, and nothing is written', async () => {
  const holding = () => {
    const dir = directory();
    writeFileSync(join(dir, '.bashrc'), '# mine\n');
    writeFileSync(join(dir, '.env'), 'MINE=1\n');
    chmodSync(join(dir, '.env'), 0o644);
    return dir;
  };
  const untouched = (dir: string) => {
    expect(readdirSync(dir).sort()).toEqual(['.bashrc', '.env']);
    expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o644);
  };
  const opening = (dir: string) => `A resident is an agent of yours on Discord, run by an install of connectome-host in a directory of its own, which holds its memory and settings and names the service that keeps it running. ${dir} is your home directory, so setup won't install there. It asks first whether the resident gets a shell and who it runs as, since those say where setup runs next.`;

  const own = holding();
  const ownRun = world(own, { answers: ['yes', '1', ''] });
  expect(await runSetup(own, ['discord'], ownRun)).toBe(0);
  expect(text(ownRun.seen.out)).toContain(opening(own));
  expect(text(ownRun.seen.out)).toContain('id -u connectome >/dev/null 2>&1 || sudo useradd -m -s /bin/bash connectome && sudo loginctl enable-linger connectome');
  expect(text(ownRun.seen.out)).toContain('Nothing was installed here.');
  expect(ownRun.seen.err).toEqual([]);
  expect(ownRun.seen.ran).toEqual([]);
  untouched(own);

  const here = holding();
  const hereRun = world(here, { answers: ['yes', '2'] });
  expect(await runSetup(here, ['discord'], hereRun)).toBe(0);
  expect(hereRun.seen.asked).toEqual(['Does the resident get a shell? (yes/no) ', 'Choose 1 or 2: ']);
  expect(text(hereRun.seen.out)).toContain(opening(here));
  expect(text(hereRun.seen.out)).toContain(`Then make a new directory for the resident in your home, and run this same version of setup there, where its questions come again. Its service takes the directory's name, so choose another than resident if you like, or if ~/resident is already there:\n  mkdir ~/resident && cd ~/resident\n  bunx @animalabs/connectome-host@${VERSION} setup discord\nNothing was installed here.`);
  expect(hereRun.seen.err).toEqual([]);
  expect(hereRun.seen.ran).toEqual([]);
  untouched(here);

  const cut = holding();
  const cutRun = world(cut, { answers: ['no'] });
  expect(await runSetup(cut, ['discord'], cutRun)).toBe(1);
  expect(cutRun.seen.out.at(-1)).toBe('Setup stopped before its questions were answered. Nothing was written here. Run setup again to answer its two questions.');
  expect(cutRun.seen.err).toEqual([]);
  untouched(cut);
});

test('where HOME isn\'t an absolute path to a directory, setup makes no directory for the resident: it sends the person to make one, before any question', async () => {
  for (const home of [undefined, 'relative/home', '/nonexistent-home-for-setup-test']) {
    const dir = directory();
    writeFileSync(join(dir, 'notes.txt'), 'mine\n');
    const made = world(dir, { answers: ['no', '2', ''] }, { env: { PATH: '/usr/bin:/bin', ...(home === undefined ? {} : { HOME: home }) } });
    expect(await runSetup(dir, ['discord'], made), String(home)).toBe(1);
    expect(made.seen.asked, String(home)).toEqual([]);
    expect(text(made.seen.err)).toContain(`connectome setup: ${dir} holds other files, and no connectome-host install, so setup won't put its own there. Make a new directory for the resident where you can write, and run this same version of setup there. Its service takes the directory's name:\n  bunx @animalabs/connectome-host@${VERSION} setup discord`);
    expect(text(made.seen.err)).not.toContain('~/');
    expect(readdirSync(dir)).toEqual(['notes.txt']);
  }
});

test('where setup can\'t check whether a name is an account here, it says so, and that the line uses that account where there is one', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['yes', '1', 'connectome'] }, { userExists: () => null });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(text(made.seen.out)).toContain('Setup couldn\'t check whether this machine already has a user named connectome. The line below makes it only where there\'s none: where there is one, the resident runs as that account.');
  expect(text(made.seen.out)).toContain('id -u connectome >/dev/null 2>&1 || sudo useradd');
});

test('the real world asks getent whether a name is an account here: root is, and a name nobody made isn\'t (Linux only)', () => {
  if (process.platform !== 'linux') return;
  expect(realWorld().userExists('root')).toBe(true);
  expect(realWorld().userExists(`nobody-made-${process.pid}`)).toBe(false);
});

test('a name the machine says is already an account isn\'t taken for the resident\'s own user: setup asks for another, saying why', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['yes', '1', 'root', 'connectome'] }, { userExists: (user: string) => user === 'root' });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(made.seen.asked.filter((question) => question.startsWith('Its user'))).toHaveLength(2);
  expect(text(made.seen.out)).toContain('This machine already has a user named root, and the resident gets a user of its own, so choose a name no account here has. If an earlier line of setup\'s made root for the resident, open a shell as root and run setup there instead.');
  expect(text(made.seen.out)).toContain('id -u connectome >/dev/null 2>&1 || sudo useradd');
  expect(text(made.seen.out)).not.toContain('sudo useradd -m -s /bin/bash root');
});

test('setup names what a directory not its own holds: your home, hidden files alone, or other files', async () => {
  const hidden = directory();
  writeFileSync(join(hidden, '.profile'), '# mine\n');
  writeFileSync(join(hidden, '.bashrc'), '# mine\n');
  const hiddenRun = world(hidden, { answers: ['no'] }, { env: { PATH: '/usr/bin:/bin', HOME: directory() } });
  await runSetup(hidden, ['discord'], hiddenRun);
  expect(text(hiddenRun.seen.out)).toContain(`${hidden} holds hidden files, such as .bashrc, so setup won't install there.`);
  const other = directory();
  writeFileSync(join(other, 'notes.txt'), 'mine\n');
  const otherRun = world(other, { answers: ['no'] }, { env: { PATH: '/usr/bin:/bin', HOME: directory() } });
  await runSetup(other, ['discord'], otherRun);
  expect(text(otherRun.seen.out)).toContain(`${other} holds other files, so setup won't install there.`);
  expect(text(otherRun.seen.out)).not.toContain('home directory');
});

test('with a shell, who the resident runs as has no default, so Enter alone asks again; a user of its own gets its root steps as one line and the next ones, and nothing is installed',
  async () => {
    const dir = directory();
    const made = world(dir, { answers: ['yes', '', '1', ''] });
    expect(await runSetup(dir, ['discord'], made)).toBe(0);
    expect(made.seen.asked).toEqual(['Does the resident get a shell? (yes/no) ', 'Choose 1 or 2: ', 'Choose 1 or 2: ',
      'Its user\'s name [connectome]: ']);
    const out = text(made.seen.out);
    for (const line of [
      'Run this line where you can use sudo: it makes its user, unless one by that name is there already, keeps its services running while it\'s logged out, and gives it Bun on its PATH. If a step fails, put right what it names and run the line again.\n' +
        '  id -u connectome >/dev/null 2>&1 || sudo useradd -m -s /bin/bash connectome && sudo loginctl enable-linger connectome && sudo -iu connectome env PATH=/usr/bin:/bin bash -c \'set -o pipefail; curl -fsSL https://bun.sh/install | bash\'\n',
      `Setup needs Node ${NODE_FLOOR} or later there too, and at most Node 24: if this machine's Node is installed for your user alone, as one from nvm is, install Node for connectome as well. \`command -v node\` shows where yours is: one in your home is yours alone.`,
      'Then open a shell as connectome, with `sudo -iu connectome` where you can use sudo, or by whoever ran the line, and run this same version of setup there, in a new directory for the resident. Its service takes the directory\'s name, so choose another than resident if you like, or if ~/resident is already there:\n  mkdir ~/resident && cd ~/resident\n',
      `bunx @animalabs/connectome-host@${VERSION} setup discord`,
      '"this user"',
    ]) expect(`${out}\n`).toContain(line);
    expect(made.seen.ran).toEqual([]);
    expect(readdirSync(dir)).toEqual(['.setup']);
    expect(readdirSync(join(dir, '.setup'))).toEqual(['setup.lock']);
  });

test('without a shell, a user of its own chosen is told it needs Node at the floor, with no maximum', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['no', '1', ''] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(made.seen.out).toContain(`Setup needs Node ${NODE_FLOOR} or later there too: if this machine's Node is installed for your user alone, as one from nvm is, install Node for connectome as well. \`command -v node\` shows where yours is: one in your home is yours alone.`);
  expect(made.seen.ran).toEqual([]);
});

test('where setup can\'t offer a user of its own, it offers this user alone and says what that gives up', async () => {
  const whys = ['There\'s no sudo on this machine', 'On macOS, setup has no root lines for a user of its own',
    'This machine doesn\'t run systemd, which the line for a user of its own needs to keep its services running'];
  for (const [at, over] of [{ hasSudo: false }, { platform: 'darwin' as const }, { lingerOf: () => null }].entries()) {
    const dir = directory();
    const made = world(dir, { answers: ['yes', 'no'] }, over);
    const status = await runSetup(dir, ['discord'], made);
    expect(text(made.seen.out)).toContain(`${whys[at]}, so the resident runs as this user, alice.`);
    expect(made.seen.asked[1]).toContain('Go on as alice?');
    expect(status).toBe(0);
    expect(text(made.seen.out)).toContain('With a shell, the resident can read and change whatever alice can (alice\'s files, keys and other programs), and whoever talks to it on Discord can ask it to.');
    expect(text(made.seen.out)).toContain('Nothing was installed.');
    expect(made.seen.ran).toEqual([]);
    expect(readdirSync(dir)).toEqual(['.setup']);
    expect(readdirSync(join(dir, '.setup'))).toEqual(['setup.lock']);
  }
});

test('on Linux with sudo, a resident with a shell run as this user is told what that gives up, and one without a shell isn\'t', async () => {
  const isolation = 'With a shell, the resident can read and change whatever alice can (alice\'s files, keys and other programs), and whoever talks to it on Discord can ask it to.';
  const dir = directory();
  const withShell = world(dir, { answers: ['yes', '2'], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], withShell)).toBe(0);
  expect(text(withShell.seen.out)).toContain(isolation);
  const other = directory();
  const without = world(other, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(other, ['discord'], without)).toBe(0);
  expect(text(without.seen.out)).not.toContain(isolation);
});

test('before its first question setup says what it does, the choices of who the resident runs as say whom each fits and what 1 takes, the key\'s question says Enter alone stops, and a run after it says first that its answers are kept', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] });
  let outAtFirstQuestion: number | undefined;
  const { ask } = made.world;
  made.world.ask = async (question) => {
    outAtFirstQuestion ??= made.seen.out.length;
    return ask(question);
  };
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  const opening = made.seen.out.indexOf(`A resident is an agent of yours on Discord, run by an install of connectome-host in a directory of its own, which holds its memory and settings and names the service that keeps it running. Its directory here is ${dir}, so its service is named after ${basename(dir)}. Setup asks a few questions first, among them who the resident runs as. When it runs as this user, alice, setup then installs connectome-host ${VERSION} here (about 0.8 GB of disk with the install's own copy of it, or 1.1 GB with a shell for the resident), unless that version is there already, checks an API key, and starts the host's setup agent, which talks with you in this terminal to set up the resident.`);
  expect(opening).toBeGreaterThanOrEqual(0);
  expect(opening).toBeLessThan(outAtFirstQuestion!);
  const shellSaid = made.seen.out.indexOf('A shell lets the resident run commands on this machine as the user it runs as, which setup settles next: it can read and change whatever that user can, and whoever talks to it on Discord can ask it to.');
  expect(shellSaid).toBeGreaterThan(opening);
  expect(shellSaid).toBeLessThan(outAtFirstQuestion!);
  expect(made.seen.asked[0]).toBe('Does the resident get a shell? (yes/no) ');
  expect(made.seen.out).toContain('  1. a user of its own: setup shows the lines that make it, which need sudo, yours if you can use it here or else an admin\'s, and you run setup again as that user, where its questions come again');
  expect(made.seen.out).toContain('  2. this user, alice: for a resident with no shell, or where alice already is the resident\'s own user');
  expect(made.seen.out).toContain(`Making ${join(dir, 'connectome-host')} an install that can take newer releases. Its first release is a copy of what's installed here. Making it can take a minute or more.`);
  expect(made.seen.asked).toContain('An Anthropic API key, from console.anthropic.com\'s API keys, typed hidden (Enter alone stops setup)');
  expect(text(made.seen.out)).not.toContain('Setup keeps its answers here');
  const again = world(dir);
  expect(await runSetup(dir, ['discord'], again)).toBe(0);
  expect(text(again.seen.out)).not.toContain('Setup asks a few questions');
  expect(again.seen.out[0]).toBe('Setup keeps its answers here: the resident doesn\'t get a shell, and runs as this user, alice. They aren\'t asked again; setup\'s agent picks up where it stopped, and can change with you what it set up.');
});

test('setup runs no sudo, for a resident with a shell and a user of its own, or with no shell as this user', async () => {
  for (const answers of [['yes', '1', 'resident'], ['no', '2']]) {
    const dir = directory();
    const made = world(dir, { answers, secrets: [KEY] });
    await runSetup(dir, ['discord'], made);
    expect(made.seen.ran.flat().some((word) => word.includes('sudo'))).toBe(false);
    if (answers[1] === '1') expect(text(made.seen.out)).toContain('id -u resident >/dev/null 2>&1 || sudo useradd');
    if (answers[1] === '2') expect(made.seen.launched).not.toBeNull();
  }
});

test('run as this user, setup says before anything is installed that linger is off, that the service needs it, and who can run the line that turns it on, and goes on; the choice of this user says so too', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['no', '', 'yes'], secrets: [KEY] }, { lingerOf: (user) => (user === 'alice' ? false : true) });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(text(made.seen.out)).toContain('sudo loginctl enable-linger alice');
  expect(text(made.seen.out)).toContain('Linger is off for alice, so a service of alice\'s would stop when alice logs out, and the resident\'s service can\'t be set up until it\'s on. One line turns it on, run once with sudo, by you if you can use sudo here or by whoever administers this machine:\n  sudo loginctl enable-linger alice');
  expect(made.seen.asked).toContain('Can you run it, or have whoever administers this machine run it? (yes/no) ');
  expect(text(made.seen.out)).toContain('Run it any time before the resident\'s service is set up, in a second terminal or by whoever runs it for you; setup goes on here meanwhile.');
  expect(text(made.seen.out)).toContain('  2. this user, alice: for a resident with no shell, or where alice already is the resident\'s own user; linger, which keeps alice\'s services running while alice is logged out, is off, so its service needs one sudo line too, run once, by you or an admin');
  expect(made.seen.launched).not.toBeNull();
});

test('with linger off and nobody to run its line, setup says the resident can\'t go live as a service, and the person stops there or goes on knowingly; a later run of the install says the line and asks neither', async () => {
  const off = { lingerOf: (user: string) => (user === 'alice' ? false : true) };
  const said = 'Without it, the resident can\'t go live as a service. Setup\'s agent can still set up the rest with you, and the service waits until linger is on.';
  const stopping = directory();
  const stopped = world(stopping, { answers: ['no', '', 'no', 'no'], secrets: [KEY] }, off);
  expect(await runSetup(stopping, ['discord'], stopped)).toBe(0);
  expect(text(stopped.seen.out)).toContain(said);
  expect(stopped.seen.out.at(-1)).toBe(`Setup stopped before installing anything, and keeps your answers. Once linger is on, run this same version of setup again here: \`bunx @animalabs/connectome-host@${VERSION} setup discord\`.`);
  expect(stopped.seen.ran.some((argv) => args(argv)[0] === 'add')).toBe(false);
  expect(stopped.seen.launched).toBeNull();
  expect(JSON.parse(readFileSync(join(stopping, '.setup', 'setup-state.json'), 'utf-8'))).toEqual({ v: 1, shell: false });
  const going = directory();
  const went = world(going, { answers: ['no', '', 'no', 'yes'], secrets: [KEY] }, off);
  expect(await runSetup(going, ['discord'], went)).toBe(0);
  expect(text(went.seen.out)).toContain(said);
  expect(went.seen.launched).not.toBeNull();
  const later = world(going, { secrets: [KEY] }, off);
  expect(await runSetup(going, ['discord'], later)).toBe(0);
  expect(later.seen.asked.filter((question) => question.startsWith('Can you run it') || question.startsWith('Go on without it'))).toEqual([]);
  expect(text(later.seen.out)).toContain('Linger is off for alice, so a service of alice\'s would stop when alice logs out, and the resident\'s service can\'t be set up until it\'s on.');
  expect(text(later.seen.out)).toContain('  sudo loginctl enable-linger alice\nRun it any time before the resident\'s service is set up, in a second terminal or by whoever runs it for you; setup goes on here meanwhile.');
  expect(later.seen.launched).not.toBeNull();
});

test('the cost line gives the model\'s list prices and, for the model the test setups ran on, what five of them cost at them', () => {
  expect(costLine('claude-opus-5-5', false)).toBe('Setup\'s agent runs on claude-opus-5-5, at Anthropic\'s list prices per million tokens: $4 input, $20 output, $8 written to the prompt cache, which keeps it an hour, and $0.20 read from it (anthropic-public-2026-10-19). In five test setups, with a tester playing the person, setup\'s agent cost between $0.45 and $2.70 each at these prices; the higher figure includes the new resident\'s first calls, which couldn\'t be told apart from setup\'s.');
  expect(costLine('claude-sonnet-5', false)).toContain('How many turns a setup takes isn\'t measured yet, so neither is what one costs.');
  expect(costLine('claude-sonnet-5', false)).not.toContain('five test setups');
  expect(costLine('no-such-model', false)).toBe('Setup\'s agent runs on no-such-model, which this host has no prices for. How many turns a setup takes isn\'t measured yet, so neither is what one costs.');
});

test('a key typed while .env became unreadable isn\'t checked, and setup says .env can\'t be read', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.setup', 'setup.lock'), '');
  writeFileSync(join(dir, '.env'), 'ANTHROPIC_BASE_URL=https://gateway.example/anthropic\n');
  const made = world(dir, { answers: ['no', ''] }, {
    askHidden: async () => { chmodSync(join(dir, '.env'), 0o000); return KEY; },
  });
  try {
    expect(await runSetup(dir, ['discord'], made)).toBe(1);
  } finally {
    chmodSync(join(dir, '.env'), 0o600);
  }
  expect(made.seen.checked).toEqual([]);
  expect(text(made.seen.err)).toContain(`connectome setup: ${join(dir, '.env')} can't be read (EACCES). Put that right, then run setup again.`);
});

test('a first run with a gateway in .env says the gateway may charge otherwise than the list prices', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.setup', 'setup.lock'), '');
  writeFileSync(join(dir, '.env'), 'ANTHROPIC_BASE_URL=https://gateway.example/anthropic\n');
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(text(made.seen.out)).toContain('A gateway at ANTHROPIC_BASE_URL may charge otherwise.');
});

test('the PATH advice names ~/.zshrc for zsh, ~/.bashrc for bash, ~/.bash_profile for bash on macOS, and the shell\'s own startup file for another', async () => {
  for (const [shell, platform, file] of [['/bin/zsh', 'linux', '~/.zshrc'], ['/bin/bash', 'linux', '~/.bashrc'], ['/bin/bash', 'darwin', '~/.bash_profile'], ['/bin/dash', 'linux', 'your shell\'s startup file']] as const) {
    const dir = directory();
    const answers = platform === 'darwin' ? ['no', 'yes'] : ['no', ''];
    const made = world(dir, { answers, secrets: [KEY] }, { platform, env: { PATH: '/usr/bin:/bin', HOME: dir, SHELL: shell } });
    expect(await runSetup(dir, ['discord'], made), shell).toBe(0);
    expect(text(made.seen.out), `${shell} ${platform}`).toContain(`For that, put it on your PATH, and in ${file} to keep it there:`);
  }
});

test('a shell that isn\'t a Bourne shell, such as fish or tcsh, is told to put the install on its PATH in its own way, with no export line', async () => {
  for (const shell of ['/usr/bin/fish', '/bin/tcsh']) {
    const dir = directory();
    const made = world(dir, { answers: ['no', ''], secrets: [KEY] }, { env: { PATH: '/usr/bin:/bin', HOME: dir, SHELL: shell } });
    expect(await runSetup(dir, ['discord'], made), shell).toBe(0);
    const root = join(dir, 'connectome-host');
    expect(text(made.seen.out), shell).toContain(`For that, put ${root} at the front of your PATH as your shell sets it, and in its startup file to keep it there.`);
    expect(text(made.seen.out), shell).not.toContain('export PATH=');
  }
});

test('a later run of an install says its answers, the install and its version, the boot and key checks, the prices, the commands note and the start line, and not the PATH offer', async () => {
  const dir = directory();
  expect(await runSetup(dir, ['discord'], world(dir, { answers: ['no', ''], secrets: [KEY] }))).toBe(0);
  const later = world(dir, {});
  expect(await runSetup(dir, ['discord'], later)).toBe(0);
  const root = join(dir, 'connectome-host');
  expect(later.seen.out.map((line) => line.split(dir).join('<dir>'))).toEqual(LATER_RUN);
  expect(later.seen.asked).toEqual([]);
  expect(text(later.seen.out)).not.toContain('export PATH=');
  expect(text(later.seen.out)).not.toContain(`This install's own command is ${join(root, 'connectome')}`);
});

test('the install\'s package.json keeps its own mode when setup adds to its trustedDependencies', async () => {
  const dir = directory();
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'theirs' }));
  chmodSync(join(dir, 'package.json'), 0o600);
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.setup', 'setup.lock'), '');
  const made = world(dir, { answers: ['yes', '2'], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect((JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as { trustedDependencies: string[] }).trustedDependencies).toContain('term-sessions-mcp');
  expect(statSync(join(dir, 'package.json')).mode & 0o777).toBe(0o600);
});

test('before its bun add, setup adds the packages whose install scripts the running Bun runs by default to the install\'s package.json, keeping the names already there', async () => {
  const dir = directory();
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ trustedDependencies: ['their-own-server', 'node-pty'] }));
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.setup', 'setup.lock'), '');
  const made = world(dir, { answers: ['yes', '2'], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  const listed = made.seen.ran.findIndex((argv) => args(argv).join(' ') === 'pm default-trusted');
  const added = made.seen.ran.findIndex((argv) => args(argv)[0] === 'add');
  expect(listed).toBeGreaterThanOrEqual(0);
  expect(listed).toBeLessThan(added);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as { trustedDependencies: string[] };
  expect(manifest.trustedDependencies).toEqual(['their-own-server', 'node-pty', 'puppeteer', 'term-sessions-mcp']);
});

test('where the running Bun\'s default trusted list can\'t be read whole, setup writes no field, and goes on', async () => {
  for (const trusted of [
    { status: 1, stdout: '', stderr: 'error: no such command\n' },
    { status: 0, stdout: 'Default trusted dependencies (3):\n - node-pty\n - puppeteer\n', stderr: '' },
  ]) {
    const dir = directory();
    const made = world(dir, { answers: ['no', '2'], secrets: [KEY], trusted });
    expect(await runSetup(dir, ['discord'], made)).toBe(0);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as Record<string, unknown>;
    expect(manifest.trustedDependencies).toBeUndefined();
    expect(text(made.seen.out)).toContain(`Setup couldn't add the packages whose install scripts Bun runs by default to ${join(dir, 'package.json')} (`);
    expect(made.seen.launched).not.toBeNull();
  }
});

test.skipIf(bunBelowFloor(SETUP_BUN_FLOOR, Bun.version) === true)('the Bun running these tests prints a default trusted list setup reads whole, node-pty among it', async () => {
  const read = await defaultTrusted(async (_manager, argv, cwd) => {
    const ran = Bun.spawnSync([process.execPath, '--no-env-file', ...argv], { cwd });
    return { status: ran.exitCode, output: `${ran.stdout}${ran.stderr}` };
  }, directory());
  expect(Array.isArray(read), JSON.stringify(read)).toBe(true);
  expect(read).toContain('node-pty');
});

test('a package a bun add that failed partway left in node_modules, never declared, is added again on the next run', async () => {
  const dir = directory();
  const failed = world(dir, { answers: ['yes', '2'], secrets: [KEY], added: { status: 1, stdout: '', stderr: 'error: install script from "node-pty" exited with 1\n' } });
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.setup', 'setup.lock'), '');
  mkdirSync(join(dir, 'node_modules', 'term-sessions-mcp'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'term-sessions-mcp', 'package.json'), JSON.stringify({ name: 'term-sessions-mcp', version: '1.7.3' }));
  expect(await runSetup(dir, ['discord'], failed)).toBe(1);
  const again = world(dir, { secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], again)).toBe(0);
  const added = again.seen.ran.find((argv) => args(argv)[0] === 'add')!;
  expect(args(added)).toContain('term-sessions-mcp');
});

test('with a shell, a node-pty that opens no pty is installed again, and setup goes on once it does', async () => {
  const dir = directory();
  let leftAtInstall: boolean | null = null;
  const made = world(dir, {
    answers: ['yes', '2'], secrets: [KEY], pty: [{ status: 1, stdout: '', stderr: 'Failed to load native module: pty.node, checked: build/Release\n' }],
    atAdd: (cwd) => { mkdirSync(join(cwd, 'node_modules', 'node-pty'), { recursive: true }); },
    atInstall: (cwd) => { leftAtInstall = existsSync(join(cwd, 'node_modules', 'node-pty')); },
  });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(leftAtInstall).toBe(false);
  expect(made.seen.out).toContain(`The resident's shell runs on node-pty, which doesn't work in ${dir} yet (Failed to load native module: pty.node, checked: build/Release), so setup installs it again, keeping the copy it has at ${join(dir, '.setup', 'node-pty-aside')} until the new one has installed, and putting it back if it doesn't:`);
  expect(made.seen.ran.some((argv) => args(argv)[0] === 'install')).toBe(true);
  expect(existsSync(join(dir, '.setup', 'node-pty-aside'))).toBe(false);
  expect(made.seen.launched).not.toBeNull();
});

test('with a shell, an install again of node-pty that fails stops setup before its agent, naming the install', async () => {
  const dir = directory();
  const broken = { status: 1, stdout: '', stderr: 'Failed to load native module: pty.node, checked: build/Release\n' };
  const made = world(dir, {
    answers: ['yes', '2'], secrets: [KEY], pty: [broken], installed: { status: 1, stdout: '', stderr: 'error: network\n' },
    atAdd: (cwd) => {
      mkdirSync(join(cwd, 'node_modules', 'node-pty'), { recursive: true });
      writeFileSync(join(cwd, 'node_modules', 'node-pty', 'pty.node'), 'the copy setup found');
    },
    atInstall: (cwd) => { writeFileSync(join(cwd, 'node_modules', 'node-pty'), 'what an install that fails left'); },
  });
  expect(await runSetup(dir, ['discord'], made)).toBe(1);
  expect(made.seen.launched).toBeNull();
  expect(text(made.seen.err)).toContain('The resident\'s shell runs on node-pty, and here it doesn\'t work: `bun --no-env-file install` didn\'t finish (');
  expect(readFileSync(join(dir, 'node_modules', 'node-pty', 'pty.node'), 'utf-8')).toBe('the copy setup found');
  expect(existsSync(join(dir, '.setup', 'node-pty-aside'))).toBe(false);
});

test('with a shell, a repair that finds a copy a stopped repair set aside keeps that copy, and puts it back when its own install fails', async () => {
  const dir = directory();
  const broken = { status: 1, stdout: '', stderr: 'Failed to load native module: pty.node, checked: build/Release\n' };
  const made = world(dir, {
    answers: ['yes', '2'], secrets: [KEY], pty: [broken], installed: { status: 1, stdout: '', stderr: 'error: network\n' },
    atAdd: (cwd) => {
      mkdirSync(join(cwd, '.setup', 'node-pty-aside'), { recursive: true });
      writeFileSync(join(cwd, '.setup', 'node-pty-aside', 'pty.node'), 'the copy setup found');
      mkdirSync(join(cwd, 'node_modules', 'node-pty'), { recursive: true });
      writeFileSync(join(cwd, 'node_modules', 'node-pty', 'pty.node'), 'unpacked by an install that was stopped, and never built');
    },
  });
  expect(await runSetup(dir, ['discord'], made)).toBe(1);
  expect(readFileSync(join(dir, 'node_modules', 'node-pty', 'pty.node'), 'utf-8')).toBe('the copy setup found');
  expect(existsSync(join(dir, '.setup', 'node-pty-aside'))).toBe(false);
});

test('without sudo, the pty stop\'s build-tools line is one for root to run', async () => {
  const dir = directory();
  const broken = { status: 1, stdout: '', stderr: 'Failed to load native module: pty.node, checked: build/Release\n' };
  const made = world(dir, { answers: ['yes', 'yes'], secrets: [KEY], pty: [broken, broken] }, { hasSudo: false, lingerOf: () => true });
  expect(await runSetup(dir, ['discord'], made)).toBe(1);
  expect(text(made.seen.err)).toContain('on Debian and Ubuntu, `apt install build-essential python3` installs them, run as root, by you or by whoever administers this machine.');
  expect(text(made.seen.err)).not.toContain('sudo apt');
});

test('with a shell, a node-pty that still opens no pty once installed again stops setup before its agent, saying why and both ways on', async () => {
  const dir = directory();
  const broken = { status: 1, stdout: '', stderr: 'Failed to load native module: pty.node, checked: build/Release\n' };
  const made = world(dir, { answers: ['yes', '2'], secrets: [KEY], pty: [broken, broken] });
  expect(await runSetup(dir, ['discord'], made)).toBe(1);
  expect(made.seen.launched).toBeNull();
  expect(text(made.seen.err)).toContain(`The resident's shell runs on node-pty, and here it doesn't work: Failed to load native module: pty.node, checked: build/Release. On Linux, its native part is built as it's installed, with python3, make and a C++ compiler; on Debian and Ubuntu, \`sudo apt install build-essential python3\` installs them, run by you if you can use sudo here, or by whoever administers this machine. Then run setup again, which installs node-pty again. Or, for a resident with no shell, remove ${join(dir, '.setup', 'setup-state.json')}, where setup keeps its answers, and run setup again to answer no.`);
});

test('setup writes Bun\'s own list and term-sessions-mcp as trustedDependencies before its add, prints no "Blocked" line of its own, and runs no `bun pm untrusted` after its add', async () => {
  const dir = directory();
  let atAdd: unknown = null;
  const made = world(dir, { answers: ['yes', '2'], secrets: [KEY], atAdd: (cwd) => { atAdd = (JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8')) as { trustedDependencies?: unknown }).trustedDependencies; } });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(atAdd).toEqual(['node-pty', 'puppeteer', 'term-sessions-mcp']);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as { trustedDependencies: string[] };
  expect(manifest.trustedDependencies).toEqual(['node-pty', 'puppeteer', 'term-sessions-mcp']);
  expect(made.seen.ran.some((argv) => args(argv)[0] === 'pm' && args(argv)[1] === 'untrusted')).toBe(false);
  expect(text(made.seen.out)).not.toContain('Blocked');
});

// Bun's isolated linker: term-sessions-mcp is a link into node_modules/.bun, and its node-pty is there beside it.
function isolatedNodePty(cwd: string): string {
  const store = join(cwd, 'node_modules', '.bun');
  const server = join(store, 'term-sessions-mcp@1.7.3', 'node_modules', 'term-sessions-mcp');
  const pty = join(store, 'node-pty@1.1.0', 'node_modules', 'node-pty');
  rmSync(join(cwd, 'node_modules', 'term-sessions-mcp'), { recursive: true, force: true });
  mkdirSync(server, { recursive: true });
  writeFileSync(join(server, 'package.json'), '{"name":"term-sessions-mcp","version":"1.7.3"}');
  mkdirSync(pty, { recursive: true });
  writeFileSync(join(pty, 'package.json'), '{"name":"node-pty","version":"1.1.0","main":"index.js"}');
  writeFileSync(join(pty, 'index.js'), '');
  for (const prebuild of ['darwin-arm64', 'darwin-x64']) {
    const helper = join(pty, 'prebuilds', prebuild, 'spawn-helper');
    mkdirSync(dirname(helper), { recursive: true });
    writeFileSync(helper, '');
    chmodSync(helper, 0o644);
  }
  rmSync(join(dirname(server), 'node-pty'), { force: true });
  symlinkSync(pty, join(dirname(server), 'node-pty'));
  symlinkSync(server, join(cwd, 'node_modules', 'term-sessions-mcp'));
  return pty;
}

test('under Bun\'s isolated linker, the node-pty installed again is the one term-sessions-mcp loads, and on macOS its spawn-helper is made executable', async () => {
  const dir = directory();
  let pty = '';
  let leftAtInstall: boolean | null = null;
  const linux = world(dir, {
    answers: ['yes', '2'], secrets: [KEY], pty: [{ status: 1, stdout: '', stderr: 'Failed to load native module: pty.node\n' }],
    atAdd: (cwd) => { pty = isolatedNodePty(cwd); },
    atInstall: (cwd) => { leftAtInstall = existsSync(pty); isolatedNodePty(cwd); },
  });
  expect(await runSetup(dir, ['discord'], linux)).toBe(0);
  expect(leftAtInstall).toBe(false);
  const mac = directory();
  const modes: number[][] = [];
  let helpers: string[] = [];
  const made = world(mac, {
    answers: ['yes', 'yes'], secrets: [KEY], pty: [{ status: 1, stdout: '', stderr: 'posix_spawnp failed.\n' }],
    atAdd: (cwd) => { const at = isolatedNodePty(cwd); helpers = ['darwin-arm64', 'darwin-x64'].map((prebuild) => join(at, 'prebuilds', prebuild, 'spawn-helper')); },
    atInstall: (cwd) => { isolatedNodePty(cwd); },
    atPtyCheck: () => modes.push(helpers.map((helper) => statSync(helper).mode & 0o777)),
  }, { platform: 'darwin' });
  expect(await runSetup(mac, ['discord'], made)).toBe(0);
  expect(modes).toEqual([[0o755, 0o755], [0o755, 0o755]]);
});

const SPAWN_HELPERS = ['darwin-arm64', 'darwin-x64'];

function shipNodePty(cwd: string): string[] {
  return SPAWN_HELPERS.map((prebuild) => {
    const helper = join(cwd, 'node_modules', 'node-pty', 'prebuilds', prebuild, 'spawn-helper');
    mkdirSync(dirname(helper), { recursive: true });
    writeFileSync(helper, '');
    chmodSync(helper, 0o644);
    return helper;
  });
}

test('on macOS, node-pty\'s prebuilt spawn-helper is made executable after every install of it, its retry included, before each check', async () => {
  const dir = directory();
  const helpers = SPAWN_HELPERS.map((prebuild) => join(dir, 'node_modules', 'node-pty', 'prebuilds', prebuild, 'spawn-helper'));
  const modes: number[][] = [];
  const made = world(dir, {
    answers: ['yes', 'yes'], secrets: [KEY], pty: [{ status: 1, stdout: '', stderr: 'posix_spawnp failed.\n' }],
    atPtyCheck: () => modes.push(helpers.map((helper) => statSync(helper).mode & 0o777)), atAdd: shipNodePty, atInstall: shipNodePty,
  }, { platform: 'darwin' });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(modes).toEqual([[0o755, 0o755], [0o755, 0o755]]);
  expect(made.seen.out).toContain(`The resident's shell runs on node-pty, which doesn't work in ${dir} yet (posix_spawnp failed), so setup installs it again, keeping the copy it has at ${join(dir, '.setup', 'node-pty-aside')} until the new one has installed, and putting it back if it doesn't:`);
});

test('on macOS, a spawn-helper already executable by its owner is left as it is', async () => {
  const dir = directory();
  let helpers: string[] = [];
  const made = world(dir, { answers: ['yes', 'yes'], secrets: [KEY], atAdd: (cwd) => { helpers = shipNodePty(cwd); chmodSync(helpers[0]!, 0o700); } }, { platform: 'darwin' });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(helpers.map((helper) => statSync(helper).mode & 0o777)).toEqual([0o700, 0o755]);
});

test('on Linux, setup leaves node-pty\'s macOS prebuilds as they are', async () => {
  const dir = directory();
  let helpers: string[] = [];
  const made = world(dir, { answers: ['yes', '2'], secrets: [KEY], atAdd: (cwd) => { helpers = shipNodePty(cwd); } });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(helpers.map((helper) => statSync(helper).mode & 0o777)).toEqual([0o644, 0o644]);
});

test('on macOS, setup says the service stops when the user logs out of the Mac\'s graphical session, not when an ssh session ends', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['no', 'yes'], secrets: [KEY] }, { platform: 'darwin' });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(made.seen.out).toContain('On macOS, a service of alice\'s stops when alice logs out of the Mac\'s graphical session, not when an ssh session ends.');
});

test('on macOS, a pty stop names macOS, says setup makes spawn-helper executable, and gives no Linux build lines', async () => {
  const dir = directory();
  const broken = { status: 1, stdout: '', stderr: 'posix_spawnp failed.\n' };
  const made = world(dir, { answers: ['yes', 'yes'], secrets: [KEY], pty: [broken, broken], atAdd: shipNodePty, atInstall: shipNodePty, trusted: { status: 1, stdout: '', stderr: '' } }, { platform: 'darwin' });
  expect(await runSetup(dir, ['discord'], made)).toBe(1);
  const said = text(made.seen.err);
  expect(said).not.toContain('Setup couldn\'t add the packages');
  expect(said).toContain('here it doesn\'t work: posix_spawnp failed. On macOS, node-pty runs from binaries it ships prebuilt rather than building them, and setup makes their spawn-helper executable after each install, which node-pty\'s own install doesn\'t. Or, for a resident with no shell,');
  expect(said).not.toContain('Debian');
  expect(said).not.toContain('failed..');
});

test('on macOS, a spawn-helper setup can\'t make executable is named in the stop, with what to do', async () => {
  const dir = directory();
  const broken = { status: 1, stdout: '', stderr: 'posix_spawnp failed.\n' };
  let shut = '';
  const made = world(dir, {
    answers: ['yes', 'yes'], secrets: [KEY], pty: [broken, broken], atAdd: shipNodePty,
    atInstall: (cwd) => { shipNodePty(cwd); shut = join(cwd, 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64'); chmodSync(shut, 0o600); },
  }, { platform: 'darwin' });
  try {
    expect(await runSetup(dir, ['discord'], made)).toBe(1);
  } finally {
    if (shut) chmodSync(shut, 0o755);
  }
  expect(text(made.seen.err)).toContain(`here it doesn't work: posix_spawnp failed. On macOS, node-pty runs from binaries it ships prebuilt, whose spawn-helper has to be executable, and ${join(shut, 'spawn-helper')} couldn't be made executable (EACCES: permission denied, stat '${join(shut, 'spawn-helper')}'). Run setup again once that's put right, which installs node-pty again. Or, for a resident with no shell,`);
});

test('on a platform that\'s neither Linux nor macOS, a pty stop gives no platform\'s build advice, and keeps the install-script sentence', async () => {
  const dir = directory();
  const broken = { status: 1, stdout: '', stderr: 'Failed to load native module: pty.node\n' };
  const made = world(dir, { answers: ['yes', 'yes'], secrets: [KEY], pty: [broken, broken], trusted: { status: 1, stdout: '', stderr: '' } }, { platform: 'freebsd' });
  expect(await runSetup(dir, ['discord'], made)).toBe(1);
  expect(text(made.seen.err)).toContain(`here it doesn't work: Failed to load native module: pty.node. Setup couldn't add the packages whose install scripts Bun runs by default to ${join(dir, 'package.json')} (\`bun pm default-trusted\` exited 1), so through a mirror or a company registry Bun may not have run node-pty's install script at all. Or, for a resident with no shell, remove ${join(dir, '.setup', 'setup-state.json')}`);
  expect(text(made.seen.err)).not.toContain('On Linux');
});

test('a pty stop where setup couldn\'t add Bun\'s default trusted list says so, with why, before the build tools', async () => {
  const dir = directory();
  const broken = { status: 1, stdout: '', stderr: 'Failed to load native module: pty.node, checked: build/Release\n' };
  const made = world(dir, { answers: ['yes', '2'], secrets: [KEY], pty: [broken, broken], trusted: { status: 1, stdout: '', stderr: '' } });
  expect(await runSetup(dir, ['discord'], made)).toBe(1);
  expect(text(made.seen.err)).toContain(`here it doesn't work: Failed to load native module: pty.node, checked: build/Release. Setup couldn't add the packages whose install scripts Bun runs by default to ${join(dir, 'package.json')} (\`bun pm default-trusted\` exited 1), so through a mirror or a company registry Bun may not have run node-pty's install script at all. On Linux, its native part is built as it's installed, with python3`);
  const fine = directory();
  const told = world(fine, { answers: ['yes', '2'], secrets: [KEY], pty: [broken, broken] });
  expect(await runSetup(fine, ['discord'], told)).toBe(1);
  expect(text(told.seen.err)).not.toContain('Setup couldn\'t add the packages');
});

test('after a stop at the pty check, removing setup-state.json and running setup again asks the questions again, and with no shell goes on to its agent', async () => {
  const dir = directory();
  const broken = { status: 1, stdout: '', stderr: 'Failed to load native module: pty.node, checked: build/Release\n' };
  const stopped = world(dir, { answers: ['yes', '2'], secrets: [KEY], pty: [broken, broken] });
  expect(await runSetup(dir, ['discord'], stopped)).toBe(1);
  rmSync(join(dir, '.setup', 'setup-state.json'));
  const again = world(dir, { answers: ['no', '2'], secrets: [KEY] });
  const status = await runSetup(dir, ['discord'], again);
  expect({ status, err: text(again.seen.err) }).toEqual({ status: 0, err: '' });
  expect(again.seen.asked[0]).toBe('Does the resident get a shell? (yes/no) ');
  expect(again.seen.launched).not.toBeNull();
  expect(again.seen.ran.some((argv) => argv[0] === 'node' && argv[1] === '-e')).toBe(false);

  const installed = directory();
  expect(await runSetup(installed, ['discord'], world(installed, { answers: ['yes', '2'], secrets: [KEY] }))).toBe(0);
  expect(existsSync(join(installed, 'connectome-host', 'install.json'))).toBe(true);
  const later = world(installed, { pty: [broken, broken] });
  expect(await runSetup(installed, ['discord'], later)).toBe(1);
  rmSync(join(installed, '.setup', 'setup-state.json'));
  const answered = world(installed, { answers: ['no', '2'] });
  const after = await runSetup(installed, ['discord'], answered);
  expect({ status: after, err: text(answered.seen.err) }).toEqual({ status: 0, err: '' });
  expect(answered.seen.asked[0]).toBe('Does the resident get a shell? (yes/no) ');
  expect(answered.seen.launched).not.toBeNull();
});

test('without a shell, setup doesn\'t check node-pty', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['no', '2'], secrets: [KEY], pty: [{ status: 1, stdout: '', stderr: 'unreached\n' }] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(made.seen.launched).not.toBeNull();
  expect(made.seen.ran.some((argv) => argv[0] === 'node' && argv[1] === '-e')).toBe(false);
});

test('from an empty directory, setup installs, writes the install\'s command, checks the key, and starts its agent', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['yes', '2'], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  const added = made.seen.ran.find((argv) => args(argv)[0] === 'add')!;
  expect(args(added).slice(1).sort()).toEqual(
    [`@animalabs/connectome-host@${VERSION}`, '@animalabs/discord-mcpl', 'term-sessions-mcp'].sort());
  const root = join(dir, 'connectome-host');
  expect(existsSync(join(root, 'install.json'))).toBe(true);
  expect(statSync(join(dir, 'data')).isDirectory()).toBe(true);
  expect(existsSync(join(root, 'connectome'))).toBe(true);
  expect(text(made.seen.out)).toContain(`This install's own command is ${join(root, 'connectome')}.`);
  expect(text(made.seen.out)).toContain('Nothing setup or its agent does needs its directory on your PATH, so you need it there only to type plain `connectome`. For that, put it on your PATH, and in your shell\'s startup file to keep it there:');
  expect(text(made.seen.out)).toContain(`export PATH=${root}:"$PATH"`);
  const pathAt = made.seen.out.indexOf(`  export PATH=${root}:"$PATH"`);
  const updates = made.seen.out.indexOf('Once the resident runs, these take a newer release, in turn: the first says whether one is out, the second installs it beside the one running, and the third switches the resident to it.');
  expect(updates).toBeGreaterThan(pathAt);
  expect(made.seen.out.slice(updates + 1, updates + 4)).toEqual(['update', 'update install', 'update restart'].map((word) => `  ${join(root, 'connectome')} ${word}`));
  for (const line of made.seen.out.filter((each) => !each.startsWith('  '))) {
    expect(line.split(join(root, 'connectome')).length - 1, line).toBeLessThanOrEqual(1);
  }
  expect(readEnvFile(join(dir, '.env')).get('ANTHROPIC_API_KEY')).toBe(KEY);
  expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
  expect(made.seen.checked).toEqual([{ key: KEY, model: SETUP_MODEL }]);
  expect(statSync(join(dir, 'data')).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, '.setup', 'setup-state.json')).mode & 0o777).toBe(0o600);
  expect(made.seen.launched).not.toBeNull();
});

const resumeLine = (dir: string) =>
  `To go on with setup where it stopped: \`${join(dir, 'connectome-host', 'connectome')} setup discord\`.`;

const keptOutsideBlock = (dir: string) => [
  `${EXTRA_STATE_LINE}: an update copies the data directory, ${join(dir, 'data')}, and outside it only the places listed here:`,
  '  /srv/mcpl-state',
  `${LIST_A_PLACE}, run setup again with every place: \`setup --extra-state /srv/mcpl-state --extra-state PATH\`.`,
];

test('of the install\'s own setup\'s lines, setup shows its first at once, and once its agent has ended, the line that goes on with setup by the install\'s command\'s full path, then its list of the state an update copies from outside the data directory as its last words, not its service\'s, and its own command once', async () => {
  const dir = directory();
  const root = join(dir, 'connectome-host');
  const block = keptOutsideBlock(dir);
  const service = `The service starts the host with \`bun ${join(root, ENTRY_POINT)}\`, followed by the arguments it gives the host now; set that, and restart it.`;
  const command = `This install's own command is ${join(root, 'connectome')}.`;
  const made = world(dir, { answers: ['no', ''], secrets: [KEY], installSetupSays: [...block, service, command, ''].join('\n') });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  const first = made.seen.out.findIndex((line) => line.startsWith(`Set up ${root} as the install of`));
  expect(first).toBeGreaterThanOrEqual(0);
  expect(first).toBeLessThan(made.seen.outAtLaunch!);
  expect(made.seen.out.slice(made.seen.outAtLaunch!)).toEqual([resumeLine(dir), ...block]);
  expect(text(made.seen.out)).not.toContain(service);
  expect(made.seen.out.filter((line) => line === command)).toHaveLength(1);
});

test('once its agent has recorded setup finished in this run, setup says it\'s finished and how to change something, not where to go on; one recorded in an earlier run doesn\'t count', async () => {
  const state = (dir: string) => join(dir, '.setup', 'setup-state.json');
  const finishing = (dir: string, when: () => string) => world(dir, { answers: ['no', ''], secrets: [KEY] }, {
    startAgent: async () => {
      const kept = JSON.parse(readFileSync(state(dir), 'utf-8')) as Record<string, unknown>;
      writeFileSync(state(dir), JSON.stringify({ ...kept, finished: when() }));
      return 0;
    },
  });
  const finishedLine = (dir: string) =>
    `Setup is finished. To change something it set up, run setup again: \`${join(dir, 'connectome-host', 'connectome')} setup discord\`.`;
  const dir = directory();
  const made = finishing(dir, () => new Date().toISOString());
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(made.seen.out).toContain(finishedLine(dir));
  expect(made.seen.out).not.toContain(resumeLine(dir));
  const clockSetBack = directory();
  const finishedEarlier = finishing(clockSetBack, () => '2000-01-01T00:00:00.000Z');
  expect(await runSetup(clockSetBack, ['discord'], finishedEarlier)).toBe(0);
  expect(finishedEarlier.seen.out).toContain(finishedLine(clockSetBack));
  const earlier = directory();
  mkdirSync(join(earlier, '.setup'), { recursive: true });
  writeFileSync(state(earlier), JSON.stringify({ v: 1, shell: false, finished: '2026-10-01T00:00:00.000Z' }));
  const old = world(earlier, { answers: ['yes'], secrets: [KEY] }, { startAgent: async () => 0 });
  expect(await runSetup(earlier, ['discord'], old)).toBe(0);
  expect(old.seen.out).toContain(resumeLine(earlier));
  expect(text(old.seen.out)).not.toContain('Setup is finished');
});

test('setup keeps a finished time it recorded with its answers, and calls answers with any other finished unreadable', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'), { recursive: true });
  writeFileSync(join(dir, '.setup', 'setup-state.json'), JSON.stringify({ v: 1, shell: false, finished: '2026-10-01T00:00:00.000Z' }));
  const kept = world(dir, { answers: ['yes'], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], kept)).toBe(0);
  expect(kept.seen.asked.some((question) => question.startsWith('Does the resident get a shell?'))).toBe(false);
  expect(JSON.parse(readFileSync(join(dir, '.setup', 'setup-state.json'), 'utf-8'))).toEqual({ v: 1, shell: false, finished: '2026-10-01T00:00:00.000Z' });
  const other = directory();
  mkdirSync(join(other, '.setup'), { recursive: true });
  writeFileSync(join(other, '.setup', 'setup-state.json'), JSON.stringify({ v: 1, shell: false, finished: 5 }));
  const asked = world(other, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(other, ['discord'], asked)).toBe(0);
  expect(text(asked.seen.err)).toContain('can\'t be read (it isn\'t the answers this setup keeps), so setup doesn\'t go by them');
});

test('the line that goes on with setup, and the list of the state kept outside the data directory, come whatever status the agent\'s run ends with, 1 or 130', async () => {
  for (const status of [1, 130]) {
    const dir = directory();
    const block = keptOutsideBlock(dir);
    const made = world(dir, { answers: ['no', ''], secrets: [KEY], installSetupSays: [...block, ''].join('\n') }, {
      startAgent: async (launch) => {
        made.seen.launched = launch;
        made.seen.outAtLaunch = made.seen.out.length;
        return status;
      },
    });
    expect(await runSetup(dir, ['discord'], made)).toBe(status);
    expect(made.seen.out.slice(made.seen.outAtLaunch!), String(status)).toEqual([resumeLine(dir), ...block]);
  }
});

test('setup doesn\'t repeat the list of the state kept outside the data directory once the install record no longer holds those places, and says why', async () => {
  const dir = directory();
  const root = join(dir, 'connectome-host');
  const record = join(root, 'install.json');
  const block = keptOutsideBlock(dir);
  const changing = (change: () => void) => {
    const made = world(dir, { answers: ['no', ''], secrets: [KEY], installSetupSays: [...block, ''].join('\n') }, {
      startAgent: async (launch) => {
        made.seen.launched = launch;
        made.seen.outAtLaunch = made.seen.out.length;
        change();
        return 0;
      },
    });
    return made;
  };
  let printed = '';
  const added = changing(() => {
    printed = readFileSync(record, 'utf-8');
    const kept = JSON.parse(printed) as { extraState: string[] };
    writeFileSync(record, JSON.stringify({ ...kept, extraState: [...kept.extraState, '/srv/new'] }));
  });
  expect(await runSetup(dir, ['discord'], added)).toBe(0);
  const said = (made: ReturnType<typeof changing>) => made.seen.out.slice(made.seen.outAtLaunch!);
  const notListed = 'The places outside the data directory that an update copies aren\'t listed here: ';
  expect(said(added)).toEqual([resumeLine(dir), `${notListed}they changed during the conversation, and ${record}, the install record, holds them now, under "extraState".`]);
  writeFileSync(record, printed);
  const swapped = changing(() => {
    const kept = JSON.parse(readFileSync(record, 'utf-8')) as { extraState: string[] };
    writeFileSync(record, JSON.stringify({ ...kept, extraState: kept.extraState.map((place, at) => at === 0 ? '/srv/other' : place) }));
  });
  expect(await runSetup(dir, ['discord'], swapped)).toBe(0);
  expect(said(swapped)).toEqual([resumeLine(dir), `${notListed}they changed during the conversation, and ${record}, the install record, holds them now, under "extraState".`]);
  const listless = changing(() => {
    const kept = JSON.parse(readFileSync(record, 'utf-8')) as Record<string, unknown>;
    writeFileSync(record, JSON.stringify({ ...kept, extraState: 'not a list' }));
  });
  expect(await runSetup(dir, ['discord'], listless)).toBe(0);
  expect(said(listless)).toEqual([resumeLine(dir), `${notListed}${record}, the install record, holds no list of places under "extraState".`]);
  const mixed = changing(() => {
    const kept = JSON.parse(readFileSync(record, 'utf-8')) as { extraState: unknown[] };
    writeFileSync(record, JSON.stringify({ ...kept, extraState: [...kept.extraState.slice(0, -1), 5] }));
  });
  expect(await runSetup(dir, ['discord'], mixed)).toBe(0);
  expect(said(mixed)).toEqual([resumeLine(dir), `${notListed}${record}, the install record, holds no list of places under "extraState".`]);
  const gone = changing(() => rmSync(record));
  expect(await runSetup(dir, ['discord'], gone)).toBe(0);
  expect(said(gone)).toEqual([resumeLine(dir), `${notListed}${record}, the install record, is gone.`]);
  const broken = changing(() => writeFileSync(record, 'not json'));
  expect(await runSetup(dir, ['discord'], broken)).toBe(0);
  expect(said(broken)).toEqual([resumeLine(dir), `${notListed}${record}, the install record, can't be read: The install record at ${record} isn't JSON, so this release can't read it.`]);
});

test('a setup whose install kept no state outside the data directory says so once its agent has ended, where the record gained a place meanwhile', async () => {
  const dir = directory();
  const record = join(dir, 'connectome-host', 'install.json');
  const none = [
    `${EXTRA_STATE_LINE}: an update copies the data directory, ${join(dir, 'data')}, and outside it only the places listed here:`,
    '  none',
    `${LIST_A_PLACE}, run setup again with every place: \`setup --extra-state PATH\`.`,
  ];
  const made = world(dir, { answers: ['no', ''], secrets: [KEY], installSetupSays: [...none, ''].join('\n') }, {
    startAgent: async (launch) => {
      made.seen.launched = launch;
      made.seen.outAtLaunch = made.seen.out.length;
      const kept = JSON.parse(readFileSync(record, 'utf-8')) as { extraState: string[] };
      writeFileSync(record, JSON.stringify({ ...kept, extraState: [...kept.extraState, '/srv/new'] }));
      return 0;
    },
  });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(made.seen.out.slice(made.seen.outAtLaunch!)).toEqual([resumeLine(dir), 'The places outside the data directory ' +
    `that an update copies aren't listed here: they changed during the conversation, and ${record}, the install record, ` +
    'holds them now, under "extraState".']);
});

test('where setup\'s kept answers are gone or can\'t be read once its agent has ended, setup says whether it finished isn\'t known, and why', async () => {
  const dir = directory();
  const state = join(dir, '.setup', 'setup-state.json');
  const ending = (change: () => void) => {
    const made = world(dir, { answers: ['no', ''], secrets: [KEY] }, {
      startAgent: async (launch) => {
        made.seen.launched = launch;
        made.seen.outAtLaunch = made.seen.out.length;
        change();
        return 0;
      },
    });
    return made;
  };
  const gone = ending(() => rmSync(state));
  expect(await runSetup(dir, ['discord'], gone)).toBe(0);
  expect(gone.seen.out.slice(gone.seen.outAtLaunch!)).toEqual([resumeLine(dir),
    `Whether setup finished isn't known: ${state}, where setup keeps its answers, is gone.`]);
  const broken = ending(() => writeFileSync(state, 'not json'));
  expect(await runSetup(dir, ['discord'], broken)).toBe(0);
  expect(broken.seen.out.slice(broken.seen.outAtLaunch!)).toEqual([resumeLine(dir),
    `Whether setup finished isn't known: ${state}, where setup keeps its answers, can't be read (it isn't JSON).`]);
});

test('a finished setup whose install root is gone says what went with it and asks before it makes a new install, and on no stops with nothing written', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'), { recursive: true });
  const state = JSON.stringify({ v: 1, shell: false, finished: '2026-10-01T00:00:00.000Z' });
  writeFileSync(join(dir, '.setup', 'setup-state.json'), state);
  const root = join(dir, 'connectome-host');
  const gone = `This directory's install root, ${root}, is gone, and its record with it: the places of state kept ` +
    'outside the data directory, its releases and its Go back.';
  const declined = world(dir, { answers: ['no'], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], declined)).toBe(0);
  expect(declined.seen.out).toContain(gone);
  expect(declined.seen.asked).toEqual([`Make a new install on ${join(dir, 'data')}? (yes/no) `]);
  expect(declined.seen.out.at(-1)).toBe('Put the root\'s backup back, if you have one, and run setup again.');
  expect(existsSync(root)).toBe(false);
  expect(existsSync(join(dir, 'data'))).toBe(false);
  expect(readFileSync(join(dir, '.setup', 'setup-state.json'), 'utf-8')).toBe(state);
  const made = world(dir, { answers: ['yes'], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(existsSync(join(root, 'install.json'))).toBe(true);
});

test('setup answers that can\'t be read, with no install root, say setup can\'t tell whether a setup finished here and ask before a new install, and on no stop with nothing written', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'), { recursive: true });
  writeFileSync(join(dir, '.setup', 'setup-state.json'), 'not json');
  const root = join(dir, 'connectome-host');
  const unknown = `This directory's install root, ${root}, isn't there, and setup can't tell whether a setup finished here, ` +
    'since its kept answers can\'t be read. If one did, the root\'s record went with it: the places of state kept outside ' +
    'the data directory, its releases and its Go back.';
  const declined = world(dir, { answers: ['no'], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], declined)).toBe(0);
  expect(declined.seen.out).toContain(unknown);
  expect(declined.seen.asked).toEqual([`Make a new install on ${join(dir, 'data')}? (yes/no) `]);
  expect(declined.seen.out.at(-1)).toBe('Put the root\'s backup back, if you have one, and run setup again.');
  expect(existsSync(root)).toBe(false);
  expect(readFileSync(join(dir, '.setup', 'setup-state.json'), 'utf-8')).toBe('not json');
  const made = world(dir, { answers: ['yes', 'no', '2'], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(existsSync(join(root, 'install.json'))).toBe(true);
});

test('a setup whose install keeps no state outside the data directory shows no list of it once its agent has ended, only the line that goes on with setup', async () => {
  const dir = directory();
  const none = [
    `${EXTRA_STATE_LINE}: an update copies the data directory, ${join(dir, 'data')}, and outside it only the places listed here:`,
    '  none',
    `${LIST_A_PLACE}, run setup again with every place: \`setup --extra-state PATH\`.`,
  ];
  const made = world(dir, { answers: ['no', ''], secrets: [KEY], installSetupSays: [...none, ''].join('\n') });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(made.seen.launched).not.toBeNull();
  expect(made.seen.out.slice(made.seen.outAtLaunch!)).toEqual([resumeLine(dir)]);
});

test('a run that stops before its agent starts shows no list of the state kept outside the data directory: it didn\'t finish', async () => {
  const dir = directory();
  const block = keptOutsideBlock(dir);
  const made = world(dir, {
    answers: ['no', ''], secrets: [KEY], installSetupSays: [...block, ''].join('\n'),
    boot: { status: 1, stdout: '', stderr: 'the mock recipe fails\n' },
  });
  expect(await runSetup(dir, ['discord'], made)).toBe(1);
  expect(made.seen.ran.some((argv) => args(argv)[0]?.endsWith(join('src', 'update', 'setup.ts')))).toBe(true);
  expect(made.seen.launched).toBeNull();
  expect(text(made.seen.out)).not.toContain(EXTRA_STATE_LINE);
});

test('without a shell, the resident\'s shell isn\'t installed', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  const added = made.seen.ran.find((argv) => args(argv)[0] === 'add')!;
  expect(added).not.toContain('term-sessions-mcp');
  expect(added).toContain('@animalabs/discord-mcpl');
});

test('a no-shell answer is kept as no shell for a run again, and the agent is told it gets no shell; a yes, that it gets one', async () => {
  const dir = directory();
  const first = world(dir, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], first)).toBe(0);
  expect(first.seen.launched!.env.CONNECTOME_SETUP_SHELL).toBe('gets no shell');
  const again = world(dir);
  expect(await runSetup(dir, ['discord'], again)).toBe(0);
  expect(again.seen.asked).toEqual([]);
  expect(again.seen.launched!.env.CONNECTOME_SETUP_SHELL).toBe('gets no shell');
  expect(again.seen.ran.flat().some((word) => word.includes('term-sessions-mcp'))).toBe(false);
  const other = directory();
  const shell = world(other, { answers: ['yes', '2'], secrets: [KEY] });
  expect(await runSetup(other, ['discord'], shell)).toBe(0);
  expect(shell.seen.launched!.env.CONNECTOME_SETUP_SHELL).toBe('gets a shell');
});

test('run again, setup asks nothing it was answered, installs nothing that\'s there, and goes on to its agent', async () => {
  const dir = directory();
  expect(await runSetup(dir, ['discord'], world(dir, { answers: ['yes', '2'], secrets: [KEY] }))).toBe(0);
  const again = world(dir);
  const status = await runSetup(dir, ['discord'], again);
  expect(again.seen.asked).toEqual([]);
  expect(status).toBe(0);
  expect(again.seen.ran.some((argv) => args(argv)[0] === 'add')).toBe(false);
  expect(again.seen.checked.map((each) => each.key)).toEqual([KEY]);
  expect(again.seen.launched).not.toBeNull();
});

test('kept answers setup can\'t read are asked again', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.setup', 'setup-state.json'), '{"v": 1, "sh');
  const made = world(dir, { answers: ['yes', 'no', ''], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(made.seen.asked[0]).toBe(`Make a new install on ${join(dir, 'data')}? (yes/no) `);
  expect(made.seen.asked[1]).toContain('Does the resident get a shell');
  expect(text(made.seen.err)).toContain(`Setup's kept answers in ${join(dir, '.setup', 'setup-state.json')} can't be read`);
});

async function script(body: string): Promise<{ status: number | null; out: string; err: string }> {
  const load = `const { realWorld } = await import(${JSON.stringify(join(REPO, 'src', 'cli', 'setup.ts'))});`;
  const child = spawn(process.execPath, ['-e', `${load}\n${body}`], { cwd: directory(), stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  child.stdin.end();
  const status = await new Promise<number | null>((done) => child.on('close', done));
  return { status, out, err };
}

test('a terminal that closes at a question gives the question no answer', async () => {
  const ran = await script('console.log(JSON.stringify(await realWorld().ask("Does the resident get a shell? ")));');
  expect(ran.status).toBe(0);
  expect(ran.out.trim()).toBe('Does the resident get a shell? null');
});

test('a Ctrl-C to setup while its agent runs leaves setup waiting for the agent, with the agent\'s exit status', async () => {
  const ran = await script(`
    const { existsSync, writeFileSync } = await import('node:fs');
    const sent = setInterval(() => {
      if (!existsSync('running')) return;
      clearInterval(sent);
      process.kill(process.pid, 'SIGINT');
      writeFileSync('signalled', '');
    }, 10);
    const agent = "const fs = require('fs'); fs.writeFileSync('running', ''); setTimeout(() => process.exit(3), 10000); " +
      "setInterval(() => { if (fs.existsSync('signalled')) process.exit(7); }, 10);";
    const status = await realWorld().startAgent({ argv: [process.execPath, '-e', agent], cwd: process.cwd(), env: process.env });
    console.log('the agent ended', status);
  `);
  expect(ran.out).toContain('the agent ended 7');
  expect(ran.status).toBe(0);
}, 30_000);

test('a signal that ends the agent\'s host is named, and setup answers its status', async () => {
  const ran = await script(`
    const status = await realWorld().startAgent({ argv: [process.execPath, '-e', 'process.kill(process.pid, "SIGTERM")'], cwd: process.cwd(), env: process.env });
    console.log('the agent ended', status);
  `);
  expect(ran.out).toContain('the agent ended 143');
  expect(ran.err).toContain('connectome setup: the agent\'s host was ended by SIGTERM. Setup\'s answers and key are kept, so running setup again in this directory goes on.');
}, 30_000);

test('the preflight stops setup before anything is installed, saying what\'s wrong and how to put it right', async () => {
  const cases: Array<{ script: Script; over?: Partial<SetupWorld>; shell: 'yes' | 'no'; says: string[] }> = [
    { script: {}, over: { bun: { path: process.execPath, version: '1.4.2' } }, shell: 'no', says: ['Bun 1.4.2', 'bun upgrade'] },
    {
      script: {}, over: { bun: { path: process.execPath, version: '1.4.3' } }, shell: 'no',
      says: ['Setup needs Bun 1.4.4 or later', 'this is Bun 1.4.3', 'bun upgrade'],
    },
    { script: { node: null }, shell: 'no', says: ['didn\'t answer here (there\'s no node on this PATH)', 'nodejs.org'] },
    {
      script: { nodeRan: { status: null, stdout: '', stderr: '', startError: { code: 'EACCES', message: 'EACCES: permission denied, posix_spawn \'node\'' } } },
      shell: 'no', says: ['didn\'t answer here (it couldn\'t be started (EACCES: permission denied, posix_spawn \'node\'))'],
    },
    { script: { nodeRan: { status: null, stdout: '', stderr: '', signal: 'SIGKILL' } }, shell: 'no', says: ['didn\'t answer here (it was ended by SIGKILL)'] },
    { script: { node: '22.11.0' }, shell: 'no', says: ['Node 22.11.0', 'Node 22.12.0 or later'] },
    { script: { node: '25.1.0' }, shell: 'yes', says: ['Node 24 at most', 'Node 25.1.0'] },
  ];
  for (const { script, over, shell, says } of cases) {
    const dir = directory();
    const made = world(dir, { ...script, answers: [shell, '2'] }, over);
    expect(await runSetup(dir, ['discord'], made)).toBe(1);
    for (const words of says) expect(text(made.seen.err)).toContain(words);
    expect(made.seen.ran.some((argv) => args(argv)[0] === 'add')).toBe(false);
    expect(existsSync(join(dir, 'node_modules'))).toBe(false);
  }
  const dir = directory();
  const later = world(dir, { node: '25.1.0', answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], later)).toBe(0);
});

test('the boot check starts the installed host for real, and a host that doesn\'t start stops setup before the key',
  async () => {
    const dir = directory();
    const made = world(dir, { answers: ['no', ''], secrets: [KEY], boot: 'real' });
    expect(await runSetup(dir, ['discord'], made)).toBe(0);
    expect(text(made.seen.out)).toContain(`The installed host (${VERSION}) starts.`);

    const broken = directory();
    const stub = join(directory(), 'connectome-host');
    mkdirSync(join(stub, 'src'), { recursive: true });
    writeFileSync(join(stub, 'src', 'index.ts'), 'console.error("Cannot find module \'@opentui/core-linux-x64\'");\nprocess.exit(1);\n');
    cpSync(join(REPO, 'recipes'), join(stub, 'recipes'), { recursive: true });
    const failing = world(broken, { answers: ['no', ''], secrets: [KEY], boot: 'real', host: stub });
    expect(await runSetup(broken, ['discord'], failing)).toBe(1);
    expect(text(failing.seen.err)).toContain('doesn\'t start');
    expect(text(failing.seen.err)).toContain('@opentui/core-linux-x64');
    expect(text(failing.seen.err)).toContain('Where the host\'s own lines above name something of this machine\'s, such as a file it can\'t read, put that right. Where they name the host\'s code or a package it brings, such as a module it can\'t find, that\'s for its makers: report them, with this output, at https://github.com/anima-research/connectome-host/issues.');
    expect(text(failing.seen.err)).toContain('Once what made its boot fail is put right, run setup again.');
    expect(failing.seen.asked).toEqual(['Does the resident get a shell? (yes/no) ',
      'Choose 1 or 2 [2]: ']);
    expect(failing.seen.checked).toEqual([]);
  }, 60_000);

test('in a directory whose name needs quoting, the line that picks setup up again quotes the install\'s command', async () => {
  const dir = join(directory(), 'my resident');
  mkdirSync(dir);
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  const line = made.seen.out[made.seen.outAtLaunch! - 1]!;
  expect(line).toContain(`\`'${join(dir, 'connectome-host', 'connectome')}' setup discord\` picks it up where it stopped`);
});

test('setup says where the install\'s own command is, and gives no PATH line where its directory is on PATH', async () => {
  const dir = directory();
  const root = join(dir, 'connectome-host');
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] }, { env: { PATH: `/usr/bin:${root}:/bin`, HOME: dir } });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(text(made.seen.out)).toContain(`This install's own command is ${join(root, 'connectome')}.`);
  expect(text(made.seen.out)).not.toContain('export PATH=');
});

test('an install whose release has no setup agent says so, and asks for no key', async () => {
  const dir = directory();
  const stub = join(directory(), 'connectome-host');
  mkdirSync(join(stub, 'src'), { recursive: true });
  writeFileSync(join(stub, 'src', 'index.ts'), 'console.log("Done.");\n');
  const made = world(dir, { answers: ['no', ''], secrets: [KEY], boot: 'real', host: stub, release: '0.0.1-older' });
  expect(await runSetup(dir, ['discord'], made)).toBe(1);
  expect(text(made.seen.err)).toContain('The release this install runs, 0.0.1-older, has no setup agent');
  expect(text(made.seen.err)).toContain('/update');
  expect(made.seen.asked).toHaveLength(2);
  expect(made.seen.checked).toEqual([]);
});

test('a setup agent\'s recipe that can\'t be read, isn\'t JSON, or names no model, is named as a damaged copy before the boot check and the key', async () => {
  const cases = [[null, 'can\'t be read (EISDIR)'], ['{"agent": {', 'isn\'t JSON'], ['{"agent": {"name": "setup"}}', 'names no agent.model']] as const;
  for (const [recipe, says] of cases) {
    const dir = directory();
    const stub = join(directory(), 'connectome-host');
    mkdirSync(join(stub, 'src'), { recursive: true });
    mkdirSync(join(stub, 'recipes'));
    writeFileSync(join(stub, 'src', 'index.ts'), 'console.log("Done.");\n');
    if (recipe === null) mkdirSync(join(stub, 'recipes', 'setup.json'));
    else writeFileSync(join(stub, 'recipes', 'setup.json'), recipe);
    const made = world(dir, { answers: ['no', ''], secrets: [KEY], host: stub });
    expect(await runSetup(dir, ['discord'], made)).toBe(1);
    const shown = join(dir, 'connectome-host', 'releases', VERSION, 'node_modules', '@animalabs', 'connectome-host', 'recipes', 'setup.json');
    expect(text(made.seen.err)).toContain(`${shown}, the setup agent's recipe in the release this install runs (${VERSION}), ${says}: the copy is damaged.`);
    expect(text(made.seen.err)).toContain('Setup doesn\'t mend a release it made, so running it again stops here again. Report this, with this output, at https://github.com/anima-research/connectome-host/issues.');
    expect(made.seen.boot).toBeUndefined();
    expect(made.seen.checked).toEqual([]);
  }
});

test('an exported key is used with the person\'s yes, and only then', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['no', '', 'yes'] }, { env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: KEY } });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(made.seen.asked.some((question) => question.includes('exported'))).toBe(true);
  expect(readEnvFile(join(dir, '.env')).get('ANTHROPIC_API_KEY')).toBe(KEY);
  expect(text(made.seen.out)).not.toContain('exported in this shell isn\'t');

  const other = directory();
  const declined = world(other, { answers: ['no', '', 'no'], secrets: ['sk-ant-typed'] },
    { env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: KEY } });
  expect(await runSetup(other, ['discord'], declined)).toBe(0);
  expect(readEnvFile(join(other, '.env')).get('ANTHROPIC_API_KEY')).toBe('sk-ant-typed');
  expect(declined.seen.checked.map((each) => each.key)).toEqual(['sk-ant-typed']);
});

test('a key that fails names the cause and asks again, and Enter alone stops with nothing stored', async () => {
  const dir = directory();
  const refused = { ok: false as const, cause: 'api.anthropic.com refused the key (401).', anotherKeyMayHelp: true };
  const made = world(dir, { answers: ['no', ''], secrets: ['sk-ant-wrong', KEY], keys: [refused, { ok: true }] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(text(made.seen.err)).toContain('refused the key (401)');
  expect(readEnvFile(join(dir, '.env')).get('ANTHROPIC_API_KEY')).toBe(KEY);

  const other = directory();
  const stopping = world(other, { answers: ['no', ''], secrets: ['sk-ant-wrong', ''], keys: [refused] });
  expect(await runSetup(other, ['discord'], stopping)).toBe(1);
  expect(existsSync(join(other, '.env'))).toBe(false);
  expect(stopping.seen.launched).toBeNull();
});

test('before its agent starts, setup names its model and prices, and what five test setups cost at them', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  const at = made.seen.out.findIndex((each) => each.includes(`Setup's agent runs on ${SETUP_MODEL}`));
  expect(at).toBeGreaterThanOrEqual(0);
  const line = made.seen.out[at]!;
  expect(line).toContain('$4 input, $20 output');
  // agent-framework caches for an hour unless told otherwise, so the cache's price is its 1-hour write.
  expect(line).toContain('$8 written to the prompt cache');
  expect(line).toContain('$0.20 read from it');
  expect(line).toContain('In five test setups, with a tester playing the person, setup\'s agent cost between $0.45 and $2.70 each at these prices');
  expect(at).toBeLessThan(made.seen.outAtLaunch!);
});

test('the agent runs from the release current named once the install\'s own setup finished, even if current moves meanwhile, on setup\'s recipe and data, with the key setup checked, and starts in .setup, where no mcpl-servers.json or agent overlay is, so the resident\'s servers and overlay don\'t reach it',
  async () => {
    const dir = directory();
    const root = join(dir, 'connectome-host');
    const moveCurrent = () => {
      const scope = join(root, 'releases', '0.0.3-moved', 'node_modules', '@animalabs');
      mkdirSync(scope, { recursive: true });
      symlinkSync(REPO, join(scope, 'connectome-host'));
      unlinkSync(join(root, 'current'));
      symlinkSync(join('releases', '0.0.3-moved'), join(root, 'current'));
    };
    const made = world(dir, { answers: ['yes', '2'], secrets: [KEY], release: '0.0.2-current', duringBoot: moveCurrent }, {
      env: {
        PATH: '/usr/bin', MODEL: 'claude-haiku-4-5', ANTHROPIC_AUTH_TOKEN: 'sk-ant-oat-mine', CONNECTOME_INSTALL_ROOT: '/x',
        ANTHROPIC_OAUTH_CREDENTIALS_FILE: '/home/alice/oauth-copy.json', MCPL_AGENT_OVERLAY_FILE: '/srv/resident-overlay.json',
      },
    });
    expect(await runSetup(dir, ['discord'], made)).toBe(0);
    const launch = made.seen.launched!;
    const host = join(dir, 'connectome-host', 'releases', '0.0.2-current', 'node_modules', '@animalabs', 'connectome-host');
    expect(launch.argv.slice(1)).toEqual(['--no-env-file', join(host, 'src', 'index.ts'), join(host, 'recipes', 'setup.json'), '--no-tui']);
    expect(launch.cwd).toBe(join(dir, '.setup'));
    expect(existsSync(join(dir, '.setup', 'mcpl-servers.json'))).toBe(false);
    expect(existsSync(join(dir, '.setup', 'mcpl-servers.agent.json'))).toBe(false);
    expect(launch.env.CONNECTOME_SETUP_DIR).toBe(dir);
    expect(launch.env.DATA_DIR).toBe(join(dir, '.setup'));
    expect(launch.env.ANTHROPIC_API_KEY).toBe(KEY);
    expect(launch.env.CONNECTOME_SETUP_VERSION).toBe('0.0.2-current');
    expect(launch.env.CONNECTOME_SETUP_COMMAND).toBe(join(dir, 'connectome-host', 'connectome'));
    for (const name of ['MODEL', 'ANTHROPIC_AUTH_TOKEN', 'CONNECTOME_INSTALL_ROOT', 'ANTHROPIC_OAUTH_CREDENTIALS_FILE', 'MCPL_AGENT_OVERLAY_FILE']) {
      expect(launch.env[name], name).toBeUndefined();
    }
    expect(made.seen.boot!.env.MCPL_AGENT_OVERLAY_FILE).toBeUndefined();
    const line = made.seen.out[made.seen.outAtLaunch! - 1]!;
    expect(line).toContain(`/quit leaves the conversation, and \`${join(dir, 'connectome-host', 'connectome')} setup discord\``);
  });

test('just before its agent starts, setup says once how each command the agent runs is shown, naming the directory, and that the agent speaks first, asking the person for nothing', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  const notes = made.seen.out.filter((said) => said.startsWith('Setup\'s agent runs each command'));
  expect(notes).toEqual([
    `Setup's agent runs each command in ${dir}, as you. You'll see each command whole before it runs, each of its lines on a line of its own, any character a terminal would hide or act on shown as a code, such as \\u001b for Escape, and each key or token setup knows of shown by its name in place of its value, such as <ANTHROPIC_API_KEY>.`,
  ]);
  expect(made.seen.out.indexOf(notes[0]!)).toBe(made.seen.outAtLaunch! - 2);
  const launchLine = made.seen.out[made.seen.outAtLaunch! - 1]!;
  expect(launchLine).toStartWith('Starting setup\'s agent. It speaks first. /quit leaves the conversation');
  expect(launchLine).not.toContain('hello');
});

test('setup\'s help names where it works: the directory that holds the install, or from bunx the one it runs in', () => {
  expect(SETUP_SUMMARY).toContain('in the directory that holds the install (from bunx, the directory it runs in)');
});

test('setup\'s agent\'s host checks for no update on its own, whatever the person\'s shell exports: it can\'t take the update a notice would offer', async () => {
  for (const exported of [{}, { CONNECTOME_UPDATE_CHECK: '1' }]) {
    const dir = directory();
    const made = world(dir, { answers: ['no', ''], secrets: [KEY] }, { env: { PATH: '/usr/bin:/bin', HOME: dir, ...exported } });
    expect(await runSetup(dir, ['discord'], made)).toBe(0);
    const update = new HostUpdate();
    update.configure({
      here: null, running: '0.0.0', env: made.seen.launched!.env,
      host: { framework: () => { throw new Error('not reached'); }, fleet: () => null },
    });
    expect(update.checksOn(), JSON.stringify(exported)).toBe(false);
  }
});

test('nothing Bun gave setup from .env reaches the programs it runs or its agent, but for the API key and ANTHROPIC_BASE_URL, which setup reads from .env itself and gives the agent, once .env has changed too, and Bun loads no .env into them',
  async () => {
    const dir = directory();
    mkdirSync(join(dir, '.setup'));
    writeFileSync(join(dir, '.setup', 'setup.lock'), '');
    const envFile = join(dir, '.env');
    writeFileSync(envFile, 'DISCORD_TOKEN="from-dot-env"\n');
    const made = world(dir, { answers: ['no', ''], secrets: [KEY] }, {
      env: { PATH: '/usr/bin:/bin', HOME: dir, DISCORD_TOKEN: 'from-dot-env', KEEP_ME: 'kept' },
      checkKey: async () => {
        writeFileSync(envFile, readFileSync(envFile, 'utf-8').replace('from-dot-env', 'replaced-meanwhile'));
        return { ok: true };
      },
    });
    expect(await runSetup(dir, ['discord'], made)).toBe(0);
    expect(made.seen.ran.some((argv) => args(argv)[0] === 'add')).toBe(true);
    for (const [at, options] of made.seen.options.entries()) {
      const argv = made.seen.ran[at]!;
      expect(options.env.DISCORD_TOKEN, argv.join(' ')).toBeUndefined();
      expect(options.env.KEEP_ME, argv.join(' ')).toBe('kept');
      if (argv[0] === process.execPath && !argv[1]!.endsWith(join('src', 'index.ts'))) {
        expect(argv[1], argv.join(' ')).toBe('--no-env-file');
      }
    }
    const launch = made.seen.launched!;
    expect(launch.env.DISCORD_TOKEN).toBeUndefined();
    expect(launch.env.ANTHROPIC_API_KEY).toBe(KEY);
    expect(launch.env.KEEP_ME).toBe('kept');
    expect(launch.env.PATH).toBe('/usr/bin:/bin');
  });

test('nothing Bun gave setup from any dotenv file of the directory it was started in reaches its programs or its agent, but for the API key and ANTHROPIC_BASE_URL, which setup reads from .env itself and gives the agent, whatever NODE_ENV is', async () => {
  const started = directory();
  const files = ['.env', '.env.local', '.env.development', '.env.development.local', '.env.production', '.env.production.local',
    '.env.test', '.env.test.local'];
  const names = files.map((file) => `FROM${file.toUpperCase().replace(/\./g, '_')}`);
  for (const [at, file] of files.entries()) writeFileSync(join(started, file), `${names[at]}=value-of-${file}\n`);
  for (const mode of [undefined, 'production', 'test']) {
    const ran = Bun.spawnSync([process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.env))'], {
      cwd: started, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...(mode === undefined ? {} : { NODE_ENV: mode }) },
    });
    const given = JSON.parse(ran.stdout.toString()) as Record<string, string>;
    const loaded = names.filter((name) => given[name] !== undefined);
    expect(loaded.length, String(mode)).toBeGreaterThanOrEqual(3);
    const dir = directory();
    const made = world(dir, { answers: ['no', ''], secrets: [KEY] }, { cwd: started, env: { ...given, KEEP_ME: 'kept' } });
    expect(await runSetup(dir, ['discord'], made)).toBe(0);
    for (const env of [...made.seen.options.map((options) => options.env), made.seen.launched!.env]) {
      for (const name of loaded) expect(env[name], `${mode} ${name}`).toBeUndefined();
      expect(env.KEEP_ME).toBe('kept');
    }
  }
});

test('a value Bun expanded from a $NAME in a dotenv file stays away from setup\'s programs and its agent too', async () => {
  const started = directory();
  writeFileSync(join(started, '.env.local'), 'SOURCE=abc\nCOPIED=$SOURCE\nQUOTED=\'${SOURCE}-x\'\n');
  const ran = Bun.spawnSync([process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.env))'], {
    cwd: started, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  });
  const given = JSON.parse(ran.stdout.toString()) as Record<string, string>;
  expect([given.SOURCE, given.COPIED, given.QUOTED]).toEqual(['abc', 'abc', 'abc-x']);
  const dir = directory();
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] }, { cwd: started, env: { ...given, KEEP_ME: 'kept' } });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  for (const env of [...made.seen.options.map((options) => options.env), made.seen.launched!.env]) {
    for (const name of ['SOURCE', 'COPIED', 'QUOTED']) expect(env[name], name).toBeUndefined();
    expect(env.KEEP_ME).toBe('kept');
  }
});

test('a .env in the directory setup was started in is read for its names as Bun reads it, whatever its form, since that .env isn\'t setup\'s', async () => {
  const started = directory();
  writeFileSync(join(started, '.env'), 'OTHER=x\nTOKEN=$OTHER\n');
  const ran = Bun.spawnSync([process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.env))'], {
    cwd: started, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  });
  const given = JSON.parse(ran.stdout.toString()) as Record<string, string>;
  expect([given.OTHER, given.TOKEN]).toEqual(['x', 'x']);
  const dir = directory();
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] }, { cwd: started, env: { ...given, KEEP_ME: 'kept' } });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  for (const env of [...made.seen.options.map((options) => options.env), made.seen.launched!.env]) {
    for (const name of ['OTHER', 'TOKEN']) expect(env[name], name).toBeUndefined();
    expect(env.KEEP_ME).toBe('kept');
  }
});

test('a dotenv value Bun built from a name the shell exports, which a file there also names, is the file\'s, not taken for exported', async () => {
  const started = directory();
  writeFileSync(join(started, '.env.local'), 'NODE_ENV=development\nANTHROPIC_API_KEY=sk-ant-${NODE_ENV}\n');
  const ran = Bun.spawnSync([process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.env))'], {
    cwd: started, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: 'staging' },
  });
  const given = JSON.parse(ran.stdout.toString()) as Record<string, string>;
  expect([given.NODE_ENV, given.ANTHROPIC_API_KEY]).toEqual(['staging', 'sk-ant-staging']);
  const dir = directory();
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] }, { cwd: started, env: given });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(made.seen.asked.some((question) => question.includes('exported'))).toBe(false);
  expect(readEnvFile(join(dir, '.env')).get('ANTHROPIC_API_KEY')).toBe(KEY);
});

test('a name the shell exports that a plain object inherits, such as toString, reaches setup\'s agent like any other', async () => {
  const dir = directory();
  const env = { PATH: '/usr/bin:/bin', HOME: dir, toString: 'exported-to-string', constructor: 'exported-constructor' };
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] }, { env });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(Object.hasOwn(made.seen.launched!.env, 'toString') && made.seen.launched!.env.toString).toBe('exported-to-string');
  expect(Object.hasOwn(made.seen.launched!.env, 'constructor') && made.seen.launched!.env.constructor).toBe('exported-constructor');
});

test('a .env.tmp a write cut off left beside .env is taken away once setup holds its lock, before it asks anything', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.setup', 'setup.lock'), '');
  const tmp = join(dir, '.env.tmp');
  writeFileSync(tmp, 'ANTHROPIC_API_KEY="cut-off-value"\n', { mode: 0o600 });
  const answers = ['no', ''];
  const there: boolean[] = [];
  const asking = world(dir, { secrets: [KEY] }, {
    ask: async () => {
      there.push(existsSync(tmp));
      return answers.shift() ?? null;
    },
  });
  expect(await runSetup(dir, ['discord'], asking)).toBe(0);
  expect(there).toEqual([false, false]);

  writeFileSync(tmp, 'ANTHROPIC_API_KEY="cut-off-value"\n', { mode: 0o600 });
  const atFirstStep: boolean[] = [];
  const again = world(dir, {}, {
    lingerOf: () => {
      atFirstStep.push(existsSync(tmp));
      return true;
    },
  });
  expect(await runSetup(dir, ['discord'], again)).toBe(0);
  expect(atFirstStep).toEqual([false]);
});

test('a release of setup\'s own version whose copy has no setup agent is named as damaged, and setup says to report it',
  async () => {
    const dir = directory();
    const stub = join(directory(), 'connectome-host');
    mkdirSync(join(stub, 'src'), { recursive: true });
    writeFileSync(join(stub, 'src', 'index.ts'), 'console.log("Done.");\n');
    const made = world(dir, { answers: ['no', ''], secrets: [KEY], host: stub });
    expect(await runSetup(dir, ['discord'], made)).toBe(1);
    expect(text(made.seen.err)).toContain('its copy has no');
    expect(text(made.seen.err)).not.toContain('/update');
    expect(text(made.seen.err)).toContain('Setup doesn\'t mend a release it made, so running it again stops here again. Report this');
  });

test('the agent\'s host takes nothing from the working directory\'s .env that setup didn\'t give it', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  writeFileSync(join(dir, '.env'), `${readFileSync(join(dir, '.env'), 'utf-8')}MODEL=claude-haiku-4-5\nCONNECTOME_INSTALL_ROOT=/x\n`);
  const launch = made.seen.launched!;
  const probe = join(directory(), 'probe.ts');
  writeFileSync(probe, 'console.log(JSON.stringify([process.env.MODEL ?? null, process.env.CONNECTOME_INSTALL_ROOT ?? null, process.env.ANTHROPIC_API_KEY ?? null]));\n');
  const argv = launch.argv.map((word) => (word.endsWith(join('src', 'index.ts')) ? probe : word));
  const ran = Bun.spawnSync(argv, { cwd: launch.cwd, env: launch.env });
  expect(JSON.parse(ran.stdout.toString())).toEqual([null, null, KEY]);
});

test('setup\'s recipe tells its agent who it is, the version, the install, the surface, its guide and SETUP.md', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['yes', '2'], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  const { env, argv } = made.seen.launched!;
  const recipePath = argv.find((word) => word.endsWith('setup.json'))!;
  const other = directory();
  const noShell = world(other, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(other, ['discord'], noShell)).toBe(0);
  const child = spawn(process.execPath, ['-e', `
    const { loadRecipeDetailed } = await import(${JSON.stringify(join(REPO, 'src', 'recipe.ts'))});
    const rendered = [];
    let before = {};
    for (const { path, env } of ${JSON.stringify([{ path: recipePath, env }, { path: noShell.seen.launched!.argv.find((word) => word.endsWith('setup.json'))!, env: noShell.seen.launched!.env }])}) {
      for (const name of Object.keys(before)) delete process.env[name];
      Object.assign(process.env, env);
      before = env;
      const { recipe } = await loadRecipeDetailed(path);
      rendered.push({ prompt: recipe.agent.systemPrompt, setup: recipe.modules.setup });
    }
    console.log(JSON.stringify(rendered));
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  expect(await new Promise((done) => child.on('close', done))).toBe(0);
  type Rendered = { prompt: string; setup: boolean };
  const [{ prompt, setup: enabled }, without] = JSON.parse(out) as [Rendered, Rendered];
  expect(without.prompt).toContain('the resident gets no shell and runs as alice');
  expect(prompt).toContain('setup--run gives back only the first and last 4 KiB of an output longer than 8 KiB, so read the guide in pieces under 8 KiB, by line range. Follow it, and where it differs from this prompt, this prompt holds.');
  expect(enabled).toBe(true);
  expect(prompt).toContain('setup agent');
  expect(prompt).toContain('aren\'t the resident');
  expect(prompt).toContain(VERSION);
  expect(prompt).toContain(join(dir, 'connectome-host'));
  expect(prompt).toContain('Discord');
  expect(prompt).toContain(join(dirname(recipePath), '..', 'docs', 'AGENT-ONBOARDING.md'));
  expect(prompt).toContain(`SETUP.md in ${dir}`);
  expect(prompt).toContain('At setup\'s questions, the person answered that the resident gets a shell and runs as alice: name both as their answers, not setup\'s.');
  expect(prompt).toContain('Answer it by speaking to the person first, in a sentence or two before any tool call, so that they see your words within seconds and not after your reads; then read what you need.');
});

test('setup\'s recipe lets its agent use the setup module\'s tools and the clock, and none of a resident\'s', () => {
  const recipe = JSON.parse(readFileSync(join(REPO, 'recipes', 'setup.json'), 'utf-8')) as { agent: { allowedTools: string[] } };
  const setups = new SetupModule({ dir: directory(), env: {}, asker: () => null, show: () => {} }).getTools().map((tool) => `setup--${tool.name}`);
  expect([...recipe.agent.allowedTools].sort()).toEqual([...setups, 'time--now'].sort());
});

test('setup\'s recipe runs its agent on claude-opus-5-5', () => {
  const recipe = JSON.parse(readFileSync(join(REPO, 'recipes', 'setup.json'), 'utf-8')) as { agent: { model: string } };
  expect(recipe.agent.model).toBe('claude-opus-5-5');
});

test('linger reads as systemd keeps it: on for a user with its file, off without, unknown with no systemd', () => {
  const root = directory();
  expect(lingerOf('alice', root)).toBeNull();
  mkdirSync(join(root, 'run', 'systemd', 'system'), { recursive: true });
  expect(lingerOf('alice', root)).toBe(false);
  mkdirSync(join(root, 'var', 'lib', 'systemd', 'linger'), { recursive: true });
  writeFileSync(join(root, 'var', 'lib', 'systemd', 'linger', 'alice'), '');
  expect(lingerOf('alice', root)).toBe(true);
  expect(lingerOf('bob', root)).toBe(false);
});

test('the launch setup gives its agent starts the installed host, run here on a mock recipe in place of setup\'s, and leaves the install\'s lock free for its service to start', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['no', ''], secrets: [KEY], host: 'copy' });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  const launch = made.seen.launched!;
  const mock = join(dir, 'mock.json');
  writeFileSync(mock, JSON.stringify({
    name: 'mock', agent: { name: 'mock', provider: 'mock', systemPrompt: 'mock' },
    modules: { wake: false, workspace: false, subscriptionGc: false },
  }));
  const child = spawn(launch.argv[0]!, launch.argv.slice(1).map((word) => (word.endsWith('setup.json') ? mock : word)), {
    cwd: launch.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { out += chunk; });
  const closed = new Promise((done) => child.on('close', done));
  for (const started = Date.now(); !out.includes('[batch]') && Date.now() - started < 30_000;) await Bun.sleep(50);
  expect(out).toContain('[batch]');
  const root = join(dir, 'connectome-host');
  expect(() => takeLock(root, machineOps())).not.toThrow();
  unlinkSync(installPaths(root).lock);
  child.stdin.end();
  expect(await closed).toBe(0);
}, 60_000);

test('a directory holding only setup\'s own .setup/ is setup\'s, so setup goes on there', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.setup', 'setup.lock'), '');
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(made.seen.launched).not.toBeNull();
});

async function holdLock(dir: string, source = `
    const { Database } = await import('bun:sqlite');
    const db = new Database(${JSON.stringify(join(dir, '.setup', 'setup.lock'))}, { create: true });
    db.exec('PRAGMA busy_timeout = 1000');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE');
    console.log('held');
    // Bun closes a Database once nothing refers to it, which lets its lock go.
    setInterval(() => db, 1000);
  `) {
  mkdirSync(join(dir, '.setup'), { recursive: true });
  const holder = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'inherit'] });
  const closed = new Promise<void>((done) => holder.once('close', () => done()));
  const kill = () => {
    holder.kill('SIGKILL');
    return closed;
  };
  let said = '';
  try {
    await new Promise<void>((done, fail) => {
      holder.stdout!.on('data', (chunk) => {
        said += String(chunk);
        if (said.includes('held')) done();
      });
      holder.once('error', fail);
      holder.once('exit', (code, signal) => fail(new Error(`the lock holder ended before it held the lock (${signal ?? `exit ${code}`})`)));
    });
  } catch (error) {
    await kill();
    throw error;
  }
  return { kill };
}

test('the lock holder is waited for until it says it holds the lock, however its output is split, and one that ends first fails the wait, named', async () => {
  const split = await holdLock(directory(), "process.stdout.write('he'); setTimeout(() => process.stdout.write('ld\\n'), 200); setInterval(() => {}, 1000);");
  await split.kill();
  await expect(holdLock(directory(), 'process.exit(3);')).rejects.toThrow('the lock holder ended before it held the lock (exit 3)');
}, 5_000);

test('one setup at a time in a directory: another running refuses this one before it asks anything, and one killed doesn\'t',
  async () => {
    const dir = directory();
    const holder = await holdLock(dir);
    try {
      writeFileSync(join(dir, '.env.tmp'), 'DISCORD_TOKEN="being-written"\n', { mode: 0o600 });
      const refused = world(dir, { answers: ['no', ''], secrets: [KEY] });
      expect(await runSetup(dir, ['discord'], refused)).toBe(1);
      expect(readFileSync(join(dir, '.env.tmp'), 'utf-8')).toBe('DISCORD_TOKEN="being-written"\n');
      expect(text(refused.seen.err)).toContain(`Another setup is running in ${dir}`);
      expect(text(refused.seen.err)).toContain('Wait for it to end, or end it, and run setup again.');
      expect(refused.seen.asked).toEqual([]);
      expect(refused.seen.ran).toEqual([]);
    } finally {
      await holder.kill();
    }
    const after = world(dir, { answers: ['no', ''], secrets: [KEY] });
    expect(await runSetup(dir, ['discord'], after)).toBe(0);
    expect(after.seen.launched).not.toBeNull();
  }, 30_000);

function tryLock(file: string): string {
  const tried = Bun.spawnSync([process.execPath, '-e', `
    const { Database } = await import('bun:sqlite');
    try {
      const db = new Database(${JSON.stringify(file)});
      db.exec('PRAGMA busy_timeout = 1000');
      db.exec('PRAGMA synchronous = NORMAL');
      db.exec('BEGIN EXCLUSIVE');
      console.log('taken');
    } catch (error) {
      console.log(error.code ?? error.message);
    }
  `]);
  return tried.stdout.toString().trim();
}

test('setup holds its lock while it asks its questions and while its agent runs', async () => {
  const dir = directory();
  const lock = join(dir, '.setup', 'setup.lock');
  const tried: string[] = [];
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] });
  const { ask, askHidden, startAgent } = made.world;
  made.world.ask = async (question) => { tried.push(`ask: ${tryLock(lock)}`); return ask(question); };
  made.world.askHidden = async (label) => { tried.push(`askHidden: ${tryLock(lock)}`); return askHidden(label); };
  made.world.startAgent = async (launch) => { tried.push(`agent: ${tryLock(lock)}`); return startAgent(launch); };
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(tried).toEqual(['ask: SQLITE_BUSY', 'ask: SQLITE_BUSY', 'askHidden: SQLITE_BUSY', 'agent: SQLITE_BUSY']);
  expect(tryLock(lock)).toBe('taken');
}, 30_000);

test('a setup that ends early, or stops at a question, leaves the lock free and its lock file in place', async () => {
  const dir = directory();
  const failed = world(dir, { node: null, answers: ['no', ''] });
  expect(await runSetup(dir, ['discord'], failed)).toBe(1);
  expect(readdirSync(join(dir, '.setup')).sort()).toEqual(['setup-state.json', 'setup.lock']);
  const after = world(dir, { secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], after)).toBe(0);
  expect(after.seen.asked.filter((question) => !question.includes('Anthropic API key'))).toEqual([]);
  expect(after.seen.launched).not.toBeNull();

  const fresh = directory();
  const gone = world(fresh, { answers: [] });
  expect(await runSetup(fresh, ['discord'], gone)).toBe(1);
  expect(text(gone.seen.out)).toContain('Setup stopped before keeping its answers. Run it again in this directory to answer its questions again.');
  expect(readdirSync(fresh)).toEqual(['.setup']);
  expect(readdirSync(join(fresh, '.setup'))).toEqual(['setup.lock']);
  const again = world(fresh, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(fresh, ['discord'], again)).toBe(0);
  expect(again.seen.asked[0]).toContain('Does the resident get a shell');
});

test('a setup stopped once its answers are kept says running it again goes on', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['no', ''], secrets: [''] });
  expect(await runSetup(dir, ['discord'], made)).toBe(1);
  expect(text(made.seen.out)).toContain('Setup stopped. Run it again in this directory to go on.');
});

test('setup ends with its agent\'s exit status', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] }, { startAgent: async () => 7 });
  expect(await runSetup(dir, ['discord'], made)).toBe(7);
});

test('a .env that can\'t be read stops setup before it asks or runs anything, naming it and what to do, and changes it not', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.setup', 'setup.lock'), '');
  mkdirSync(join(dir, '.env'), { mode: 0o755 });
  const mode = statSync(join(dir, '.env')).mode & 0o777;
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(1);
  expect(text(made.seen.err)).toContain(`${join(dir, '.env')} can't be read (EISDIR). Setup keeps its key and its agent's secrets there, so it must be a file alice can read: put that right, and run setup again.`);
  expect(made.seen.asked).toEqual([]);
  expect(made.seen.ran).toEqual([]);
  expect(statSync(join(dir, '.env')).mode & 0o777).toBe(mode);
});

test('the key setup checks, keeps and gives its agent is the one .env holds when setup gets to the key, though .env changed during the boot check, and .env is readable by its owner alone after', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.setup', 'setup.lock'), '');
  writeFileSync(join(dir, '.env'), 'ANTHROPIC_API_KEY="sk-ant-before-the-install"\n', { mode: 0o600 });
  const made = world(dir, {
    answers: ['no', ''],
    duringBoot: () => {
      writeFileSync(join(dir, '.env'), `ANTHROPIC_API_KEY="${KEY}"\n`);
      chmodSync(join(dir, '.env'), 0o644);
    },
  });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(made.seen.checked.map((each) => each.key)).toEqual([KEY]);
  expect(made.seen.launched!.env.ANTHROPIC_API_KEY).toBe(KEY);
  expect(readEnvFile(join(dir, '.env')).get('ANTHROPIC_API_KEY')).toBe(KEY);
  expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
});

test('a .env that is a link, to a file or to nothing, stops setup before it asks or runs anything, the link and its target as they were', async () => {
  const target = join(directory(), 'shared.env');
  writeFileSync(target, `ANTHROPIC_API_KEY="${KEY}"\n`);
  chmodSync(target, 0o644);
  for (const to of [target, join(directory(), 'not-there.env')]) {
    const dir = directory();
    mkdirSync(join(dir, '.setup'));
    writeFileSync(join(dir, '.setup', 'setup.lock'), '');
    symlinkSync(to, join(dir, '.env'));
    const made = world(dir, { answers: ['no', ''], secrets: [KEY] });
    expect(await runSetup(dir, ['discord'], made), to).toBe(1);
    expect(text(made.seen.err), to).toContain(`${join(dir, '.env')} is a link to ${to}. Setup keeps its key and its agent's secrets in .env as a file of its own`);
    expect(text(made.seen.err), to).toContain('Replace the link with the file it leads to, if that\'s there, or take it away, and run setup again.');
    expect(made.seen.asked, to).toEqual([]);
    expect(made.seen.ran, to).toEqual([]);
    expect(lstatSync(join(dir, '.env')).isSymbolicLink(), to).toBe(true);
  }
  expect(statSync(target).mode & 0o777).toBe(0o644);
  expect(readFileSync(target, 'utf-8')).toBe(`ANTHROPIC_API_KEY="${KEY}"\n`);
});

test('setup writes the key it checked to .env, though .env changed while the key was checked', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.setup', 'setup.lock'), '');
  writeFileSync(join(dir, '.env'), `ANTHROPIC_API_KEY="${KEY}"\n`, { mode: 0o600 });
  let checks = 0;
  const made = world(dir, { answers: ['no', ''] }, {
    checkKey: async () => {
      checks += 1;
      writeFileSync(join(dir, '.env'), 'ANTHROPIC_API_KEY="sk-ant-written-during-the-check"\n');
      return { ok: true };
    },
  });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(checks).toBe(1);
  expect(readEnvFile(join(dir, '.env')).get('ANTHROPIC_API_KEY')).toBe(KEY);
  expect(made.seen.launched!.env.ANTHROPIC_API_KEY).toBe(KEY);
});

test('an ANTHROPIC_AUTH_TOKEN or ANTHROPIC_OAUTH_CREDENTIALS_FILE exported in this shell is named, one or both in one line, since a host started from it signs in through OAuth', async () => {
  const through = 'signs in through OAuth, not with an ANTHROPIC_API_KEY, though setup\'s agent uses the key.';
  for (const names of [['ANTHROPIC_AUTH_TOKEN'], ['ANTHROPIC_OAUTH_CREDENTIALS_FILE'], ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_CREDENTIALS_FILE']]) {
    const dir = directory();
    const exported = Object.fromEntries(names.map((name) => [name, `exported-credential-${name}`]));
    const made = world(dir, { answers: ['no', ''], secrets: [KEY] }, { env: { PATH: '/usr/bin:/bin', HOME: dir, ...exported } });
    expect(await runSetup(dir, ['discord'], made), names.join()).toBe(0);
    const lines = made.seen.out.filter((line) => line.includes('exported in this shell, so a host started from it'));
    expect(lines, names.join()).toEqual([names.length === 1
      ? `${names[0]} is exported in this shell, so a host started from it ${through} Unset it in any shell you start a host from, for such a host to use a key.`
      : `ANTHROPIC_AUTH_TOKEN and ANTHROPIC_OAUTH_CREDENTIALS_FILE are exported in this shell, so a host started from it ${through} Unset them in any shell you start a host from, for such a host to use a key.`]);
    for (const name of names) expect(made.seen.launched!.env[name], name).toBeUndefined();
    expect(text([...made.seen.out, ...made.seen.err]), names.join()).not.toContain('exported-credential');
  }
});

test('an ANTHROPIC_AUTH_TOKEN or ANTHROPIC_OAUTH_CREDENTIALS_FILE that .env holds is named, since a host started in the directory signs in through OAuth; setup\'s agent gets neither', async () => {
  for (const names of [['ANTHROPIC_AUTH_TOKEN'], ['ANTHROPIC_OAUTH_CREDENTIALS_FILE'], ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_CREDENTIALS_FILE']]) {
    const dir = directory();
    const envFile = join(dir, '.env');
    mkdirSync(join(dir, '.setup'));
    writeFileSync(join(dir, '.setup', 'setup.lock'), '');
    writeFileSync(envFile, `${names.map((name) => `${name}=held-credential-${name}\n`).join('')}ANTHROPIC_API_KEY="${KEY}"\n`, { mode: 0o600 });
    const fromEnv = Object.fromEntries([...names.map((name) => [name, `held-credential-${name}`]), ['ANTHROPIC_API_KEY', KEY]]);
    const made = world(dir, { answers: ['no', ''] }, { env: { PATH: '/usr/bin:/bin', HOME: dir, ...fromEnv } });
    expect(await runSetup(dir, ['discord'], made), names.join()).toBe(0);
    const lines = made.seen.out.filter((line) => line.startsWith(`${envFile} holds`));
    expect(lines, names.join()).toEqual([`${envFile} holds ${names.join(' and ')}, so a host started in ${dir} signs in through OAuth, not with an ANTHROPIC_API_KEY, though setup's agent uses the key. Take ${names.length === 1 ? 'it' : 'them'} out of ${envFile}, for such a host to use the key.`]);
    expect(made.seen.out.some((line) => line.includes('exported in this shell, so a host started from it')), names.join()).toBe(false);
    for (const name of names) expect(made.seen.launched!.env[name], name).toBeUndefined();
    expect(made.seen.launched!.argv).toContain('--no-env-file');
    expect(text([...made.seen.out, ...made.seen.err]), names.join()).not.toContain('held-credential');
  }
});

test('a key that works but can\'t be kept in .env stops setup with no agent, saying so', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'), { mode: 0o700 });
  writeFileSync(join(dir, '.setup', 'setup.lock'), '');
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] }, {
    checkKey: async () => { chmodSync(dir, 0o500); return { ok: true }; },
  });
  try {
    expect(await runSetup(dir, ['discord'], made)).toBe(1);
  } finally {
    chmodSync(dir, 0o700);
  }
  expect(text(made.seen.err)).toContain(`The key works, but setup couldn't make sure ${join(dir, '.env')} holds it: EACCES`);
  expect(text(made.seen.err)).toContain('So it starts no agent: put that right, and run setup again.');
  expect(made.seen.launched).toBeNull();
});

test('a .env made a directory, or a link, while the key is checked stops setup with no agent, saying the key works, and leaves it as it is', async () => {
  const target = join(directory(), 'shared.env');
  writeFileSync(target, 'SHARED=1\n');
  chmodSync(target, 0o644);
  const cases: Array<[string, (envFile: string) => void, string]> = [
    ['a directory', (envFile) => { rmSync(envFile, { force: true }); mkdirSync(envFile); }, "can't be read (EISDIR)"],
    ['a link to a file', (envFile) => { rmSync(envFile, { force: true }); symlinkSync(target, envFile); }, `is a link to ${target}, and it's written only as a file of its own, not through a link or over one`],
  ];
  for (const [what, make, why] of cases) {
    const dir = directory();
    const envFile = join(dir, '.env');
    const made = world(dir, { answers: ['no', ''], secrets: [KEY] }, {
      checkKey: async () => { make(envFile); return { ok: true }; },
    });
    expect(await runSetup(dir, ['discord'], made), what).toBe(1);
    expect(text(made.seen.err), what).toContain(`The key works, but setup couldn't make sure ${envFile} holds it: ${envFile} ${why}. So it starts no agent: put that right, and run setup again.`);
    expect(made.seen.launched, what).toBeNull();
    if (what === 'a directory') expect(lstatSync(envFile).isDirectory(), what).toBe(true);
    else expect(lstatSync(envFile).isSymbolicLink(), what).toBe(true);
  }
  expect(readFileSync(target, 'utf-8')).toBe('SHARED=1\n');
  expect(statSync(target).mode & 0o777).toBe(0o644);
});

test('run again with the key already in .env, readable by its owner alone, setup writes nothing there, so a directory it can\'t write in is no bar', async () => {
  for (const mode of [0o600, 0o400]) {
    const dir = directory();
    expect(await runSetup(dir, ['discord'], world(dir, { answers: ['no', ''], secrets: [KEY] })), mode.toString(8)).toBe(0);
    chmodSync(join(dir, '.env'), mode);
    const before = statSync(join(dir, '.env')).mtimeMs;
    chmodSync(dir, 0o500);
    const again = world(dir);
    try {
      expect(await runSetup(dir, ['discord'], again), mode.toString(8)).toBe(0);
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(again.seen.launched, mode.toString(8)).not.toBeNull();
    expect(statSync(join(dir, '.env')).mtimeMs, mode.toString(8)).toBe(before);
    expect(statSync(join(dir, '.env')).mode & 0o777, mode.toString(8)).toBe(mode);
  }
});

test('an empty ANTHROPIC_AUTH_TOKEN or ANTHROPIC_OAUTH_CREDENTIALS_FILE, in .env or exported, names nothing, as the host takes neither', async () => {
  for (const name of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_CREDENTIALS_FILE']) {
    for (const where of ['.env', 'exported']) {
      const dir = directory();
      mkdirSync(join(dir, '.setup'));
      writeFileSync(join(dir, '.setup', 'setup.lock'), '');
      writeFileSync(join(dir, '.env'), `${where === '.env' ? `${name}=\n` : ''}ANTHROPIC_API_KEY="${KEY}"\n`, { mode: 0o600 });
      const made = world(dir, { answers: ['no', ''] }, { env: { PATH: '/usr/bin:/bin', HOME: dir, ...(where === 'exported' ? { [name]: '' } : {}) } });
      expect(await runSetup(dir, ['discord'], made), `${name} ${where}`).toBe(0);
      expect(made.seen.out.filter((line) => line.includes('OAuth')), `${name} ${where}`).toEqual([]);
      expect(made.seen.launched, `${name} ${where}`).not.toBeNull();
    }
  }
});

test('a .env with a line outside setup\'s form stops setup before it asks or runs anything, naming the line and nothing of it, and changes it not', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.setup', 'setup.lock'), '');
  const before = 'PEM_KEY="-----BEGIN-----\nbody-of-the-key\n-----END-----"\nPORT=8080\n';
  writeFileSync(join(dir, '.env'), before, { mode: 0o600 });
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(1);
  expect(text(made.seen.err)).toBe(`${join(dir, '.env')}, line 1, spells its value in none of the form's three ways, and 2 other lines aren't in setup's form either. Setup reads and writes .env in one form, which Bun reads as it's written: empty lines, comments starting with #, and NAME=value, NAME="value" or NAME='value', each on one line, where NAME is ASCII letters, digits and _, not starting with a digit, a quoted value holds no quote of its own kind, $ or backslash, an unquoted one no quote, backtick, $, backslash, space or #, and no line holds a tab or another ASCII control character. Rewrite such a line in that form, or take it out of this .env, which is setup's: a value the host needs from it then has to reach the host's environment another way. Then run setup again.`);
  expect(text([...made.seen.out, ...made.seen.err])).not.toContain('body-of-the-key');
  expect(made.seen.asked).toEqual([]);
  expect(made.seen.ran).toEqual([]);
  expect(readFileSync(join(dir, '.env'), 'utf-8')).toBe(before);
});

test('a .env no one can read stops setup before it asks or runs anything, naming it, and changes it not', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.setup', 'setup.lock'), '');
  writeFileSync(join(dir, '.env'), `ANTHROPIC_API_KEY="${KEY}"\n`);
  chmodSync(join(dir, '.env'), 0o000);
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(1);
  expect(text(made.seen.err)).toContain(`${join(dir, '.env')} can't be read (EACCES).`);
  expect(made.seen.asked).toEqual([]);
  expect(made.seen.ran).toEqual([]);
  expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o000);
});

test('a .env its owner can\'t read but others can is made readable by its owner alone, and setup goes on', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.setup', 'setup.lock'), '');
  writeFileSync(join(dir, '.env'), `ANTHROPIC_API_KEY="${KEY}"\n`);
  chmodSync(join(dir, '.env'), 0o040);
  const made = world(dir, { answers: ['no', ''] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
  expect(text(made.seen.out)).toContain(`${join(dir, '.env')} was open to others than alice`);
  expect(made.seen.checked.map((each) => each.key)).toEqual([KEY]);
});

test('a .env others can read is made readable by its owner alone, and setup says so', async () => {
  const dir = directory();
  expect(await runSetup(dir, ['discord'], world(dir, { answers: ['no', ''], secrets: [KEY] }))).toBe(0);
  chmodSync(join(dir, '.env'), 0o644);
  const again = world(dir);
  expect(await runSetup(dir, ['discord'], again)).toBe(0);
  expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
  expect(text(again.seen.out)).toContain(`${join(dir, '.env')} was open to others than alice`);
});

test('run again on an install, setup uses the data directory the install records, names the root, and makes no other', async () => {
  const dir = directory();
  expect(await runSetup(dir, ['discord'], world(dir, { answers: ['no', ''], secrets: [KEY] }))).toBe(0);
  const root = join(dir, 'connectome-host');
  const elsewhere = directory();
  writeFileSync(join(root, 'install.json'), JSON.stringify({ v: 1, dataDir: elsewhere, extraState: [], workingDir: dir }));
  rmSync(join(dir, 'data'), { recursive: true });
  const again = world(dir);
  expect(await runSetup(dir, ['discord'], again)).toBe(0);
  const made = again.seen.ran.find((argv) => args(argv)[0]?.endsWith(join('src', 'update', 'setup.ts')))!;
  expect(args(made).slice(1)).toEqual(['--root', root]);
  expect(existsSync(join(dir, 'data'))).toBe(false);
  expect(text(again.seen.out)).not.toContain('first release');
  expect(text(again.seen.out)).toContain(`Checking the install at ${root}.`);
});

const ownSetup = (seen: Seen): { argv: string[]; dataDir: string | undefined } => {
  const at = seen.ran.findIndex((argv) => args(argv)[0]?.endsWith(join('src', 'update', 'setup.ts')));
  return { argv: args(seen.ran[at]!).slice(1), dataDir: seen.options[at]!.env.DATA_DIR };
};
const besideIt = (dir: string, name: string): string => {
  const path = join(dirname(dir), `${basename(dir)}-${name}`);
  made.push(path);
  return path;
};

test('an install moved here whose places were all under its old directory is bound with no question, its own setup given the data directory here', async () => {
  const dir = directory();
  expect(await runSetup(dir, ['discord'], world(dir, { answers: ['no', ''], secrets: [KEY] }))).toBe(0);
  const moved = besideIt(dir, 'moved');
  renameSync(dir, moved);
  const again = world(moved);
  expect(await runSetup(moved, ['discord'], again)).toBe(0);
  expect(again.seen.asked).toEqual([]);
  expect(ownSetup(again.seen)).toEqual({ argv: ['--root', join(moved, 'connectome-host')], dataDir: join(moved, 'data') });
  expect(text(again.seen.out)).toContain(`This install's record is bound to ${dir}, and the install is in ${moved}, so it was moved or copied here. Setup binds it here: each place under ${dir} becomes the same place under ${moved}.`);
});

test('a copy with a place outside its old directory asks where that place is in this install, naming it, and gives its own setup the answer', async () => {
  const dir = directory();
  expect(await runSetup(dir, ['discord'], world(dir, { answers: ['no', ''], secrets: [KEY] }))).toBe(0);
  const outside = join(directory(), 'state.json');
  writeFileSync(outside, 'the original\'s');
  const record = join(dir, 'connectome-host', 'install.json');
  writeFileSync(record, JSON.stringify({ ...JSON.parse(readFileSync(record, 'utf-8')), extraState: [outside] }));
  const copy = besideIt(dir, 'copy');
  expect(Bun.spawnSync(['cp', '-a', dir, copy]).exitCode).toBe(0);
  const own = join(copy, 'state.json');
  const again = world(copy, { answers: ['~/state.json'] });
  expect(await runSetup(copy, ['discord'], again)).toBe(0);
  expect(again.seen.asked).toEqual([`${outside} (state kept outside its data directory): `]);
  expect(ownSetup(again.seen)).toEqual({ argv: ['--root', join(copy, 'connectome-host'), '--place', outside, own], dataDir: join(copy, 'data') });
  expect(text(again.seen.out)).toContain(`It asks about each place outside ${dir}, since it can't tell whether that came with the install, as after a move, or is still the other install's, as after a copy. A place inside another goes with it. Press Enter where a place is this install's, or type the path of this install's own, as after a copy.`);
});

test('a record from before workingDir takes each place under this directory as this install\'s, asking nothing about them; one outside is asked about, Enter keeping it, and a data directory that isn\'t there is asked again', async () => {
  const dir = directory();
  expect(await runSetup(dir, ['discord'], world(dir, { answers: ['no', ''], secrets: [KEY] }))).toBe(0);
  const record = join(dir, 'connectome-host', 'install.json');
  writeFileSync(record, JSON.stringify({ v: 1, dataDir: join(dir, 'data'), extraState: [] }));
  const here = world(dir);
  expect(await runSetup(dir, ['discord'], here)).toBe(0);
  expect(here.seen.asked).toEqual([]);
  expect(ownSetup(here.seen)).toEqual({ argv: ['--root', join(dir, 'connectome-host')], dataDir: join(dir, 'data') });
  expect(text(here.seen.out)).toContain(`This install's record is from a release that didn't record which directory an install is in. Setup binds it here: each place under ${dir}, other than inside another install's directory, stays as it is.`);

  const elsewhere = join(directory(), 'data');
  mkdirSync(elsewhere);
  writeFileSync(record, JSON.stringify({ v: 1, dataDir: elsewhere, extraState: [] }));
  const again = world(dir, { answers: ['nowhere', ''] });
  expect(await runSetup(dir, ['discord'], again)).toBe(0);
  const question = `${elsewhere} (its data directory): `;
  expect(again.seen.asked).toEqual([question, question]);
  expect(text(again.seen.out)).toContain('It asks about each place outside it, or inside another install\'s directory within it, since it can\'t tell whether that came with the install, as after a move, or is still another install\'s, as after a copy. A place inside another goes with it.');
  expect(text(again.seen.out)).toContain(`${join(dir, 'nowhere')} isn't a directory, and the data directory has to be one that's there`);
  expect(ownSetup(again.seen)).toEqual({
    argv: ['--root', join(dir, 'connectome-host'), '--place', elsewhere, elsewhere], dataDir: elsewhere,
  });
});

test('a binding a setup run cut off goes to the install\'s own setup to finish, with no --place and asking nothing, and setup says so', async () => {
  const dir = directory();
  expect(await runSetup(dir, ['discord'], world(dir, { answers: ['no', ''], secrets: [KEY] }))).toBe(0);
  const root = join(dir, 'connectome-host');
  writeFileSync(join(root, 'rebind.json'), JSON.stringify({
    v: 1, id: 'plan-1', from: null, to: dir, places: [],
    record: { v: 1, dataDir: join(dir, 'data'), extraState: [], workingDir: dir },
  }));
  const again = world(dir);
  expect(await runSetup(dir, ['discord'], again)).toBe(0);
  expect(again.seen.asked).toEqual([]);
  expect(text(again.seen.out)).toContain(`A setup run binding this install to ${dir} was cut off before it finished. Setup finishes it from its plan, with the places that run was given, or says what stops it.`);
  expect(ownSetup(again.seen)).toEqual({ argv: ['--root', root], dataDir: join(dir, 'data') });
});

test('setup shows each line its install\'s own setup gives before the list of state kept outside, so a finished binding\'s summary shows too', async () => {
  const dir = directory();
  expect(await runSetup(dir, ['discord'], world(dir, { answers: ['no', ''], secrets: [KEY] }))).toBe(0);
  const root = join(dir, 'connectome-host');
  const says = [
    `Finished binding the install at ${root} to ${dir}, which a setup run cut off had begun, with the places that run was given.`,
    `The install at ${root} serves ${join(dir, 'data')} and runs ${VERSION}, as before.`,
  ];
  const again = world(dir, { installSetup: { status: 0, stdout: `${says.join('\n')}\n${EXTRA_STATE_LINE}: the places listed here:\n  none\n`, stderr: '' } });
  expect(await runSetup(dir, ['discord'], again)).toBe(0);
  for (const line of says) expect(again.seen.out).toContain(line);
  expect(again.seen.out).not.toContain('  none');
});

test('where the install\'s own setup fails, setup shows all its lines, not a last part of them', async () => {
  const dir = directory();
  const lines = Array.from({ length: 25 }, (_, at) => `line ${at + 1} of what went wrong`);
  const made = world(dir, { answers: ['no', ''], secrets: [KEY], installSetup: { status: 1, stdout: '', stderr: `${lines.join('\n')}\n` } });
  expect(await runSetup(dir, ['discord'], made)).toBe(1);
  for (const line of lines) expect(made.seen.err).toContain(`  ${line}`);
});

test('on Linux without systemd, setup says the resident can\'t run as a systemd user service here, and what another service manager must do', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['no', 'yes'], secrets: [KEY] }, { lingerOf: () => null });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(made.seen.out).toContain('This machine doesn\'t run systemd, so the resident can\'t run as a systemd user service here, the way its guide sets it up. Another service manager can run it: one that starts the install\'s start.js and restarts it when it exits with 75 or 1, as docs/DEPLOYMENTS.md in the host\'s package says.');
  const mac = directory();
  const onMac = world(mac, { answers: ['no', 'yes'], secrets: [KEY] }, { platform: 'darwin', lingerOf: () => null });
  expect(await runSetup(mac, ['discord'], onMac)).toBe(0);
  expect(text(onMac.seen.out)).not.toContain('systemd');
});

test('an install whose recorded data directory has gone gets that directory from setup, not a new one, and setup stops where its own setup refuses it', async () => {
  const dir = directory();
  expect(await runSetup(dir, ['discord'], world(dir, { answers: ['no', ''], secrets: [KEY] }))).toBe(0);
  rmSync(join(dir, 'data'), { recursive: true });
  const again = world(dir);
  expect(await runSetup(dir, ['discord'], again)).toBe(1);
  expect(text(again.seen.err)).toContain(`The data directory ${join(dir, 'data')} isn't there`);
  expect(existsSync(join(dir, 'data'))).toBe(false);
  expect(again.seen.launched).toBeNull();
});

test('run again where package.json declares the host and node_modules holds it, setup adds only the packages missing', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.setup', 'setup.lock'), '');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { '@animalabs/connectome-host': VERSION } }));
  mkdirSync(join(dir, 'node_modules', '@animalabs', 'connectome-host'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', '@animalabs', 'connectome-host', 'package.json'),
    JSON.stringify({ name: '@animalabs/connectome-host', version: VERSION }));
  const made = world(dir, { answers: ['yes', '2'], secrets: [KEY] });
  const status = await runSetup(dir, ['discord'], made);
  expect(status, text(made.seen.err)).toBe(0);
  const added = made.seen.ran.find((argv) => args(argv)[0] === 'add')!;
  expect(args(added).slice(1).sort()).toEqual(['@animalabs/discord-mcpl', 'term-sessions-mcp']);
});

test('run again beside another version of the host, setup adds its own version', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.setup', 'setup.lock'), '');
  mkdirSync(join(dir, 'node_modules', '@animalabs', 'connectome-host'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', '@animalabs', 'connectome-host', 'package.json'),
    JSON.stringify({ name: '@animalabs/connectome-host', version: '0.0.1-older' }));
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  const added = made.seen.ran.find((argv) => args(argv)[0] === 'add')!;
  expect(args(added)).toContain(`@animalabs/connectome-host@${VERSION}`);
});

test('without sudo, the line that turns linger on is one for root to run', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['no', 'yes', 'yes'], secrets: [KEY] }, { hasSudo: false, lingerOf: () => false });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  const out = text(made.seen.out);
  expect(out).toContain('One line turns it on, run once as root, by you or by whoever administers this machine:\n  loginctl enable-linger alice\n');
  expect(out).not.toContain('sudo loginctl');
});

test('a check failing for a reason another key can\'t mend offers the same key again, and checks it again on a yes', async () => {
  const dir = directory();
  const down = { ok: false as const, cause: 'api.anthropic.com is overloaded (529).', anotherKeyMayHelp: false };
  const made = world(dir, { answers: ['no', '', 'yes'], secrets: [KEY], keys: [down, { ok: true }] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(made.seen.asked).toContain('Try this key again? (yes/no) ');
  expect(made.seen.checked.map((each) => each.key)).toEqual([KEY, KEY]);
  expect(made.seen.asked.filter((question) => question.includes('Anthropic API key'))).toHaveLength(1);

  const other = directory();
  const stopping = world(other, { answers: ['no', '', 'no'], secrets: [KEY], keys: [down] });
  expect(await runSetup(other, ['discord'], stopping)).toBe(1);
  expect(stopping.seen.launched).toBeNull();
});

test('the key is checked where the resident will call: at the ANTHROPIC_BASE_URL .env has, read again at each try', async () => {
  const dir = directory();
  const envFile = join(dir, '.env');
  expect(await runSetup(dir, ['discord'], world(dir, { answers: ['no', ''], secrets: [KEY] }))).toBe(0);
  writeFileSync(envFile, `${readFileSync(envFile, 'utf-8')}ANTHROPIC_BASE_URL=https://gateway.example/anthropic\n`);
  const fromFile = world(dir);
  expect(await runSetup(dir, ['discord'], fromFile)).toBe(0);
  expect(fromFile.seen.checked).toEqual([{ key: KEY, model: SETUP_MODEL, baseUrl: 'https://gateway.example/anthropic' }]);
  expect(fromFile.seen.launched!.env.ANTHROPIC_BASE_URL).toBe('https://gateway.example/anthropic');
  expect(text(fromFile.seen.out)).toContain('A gateway at ANTHROPIC_BASE_URL may charge otherwise.');

  const down = { ok: false as const, cause: 'gateway.example answered 200, but not with a message.', anotherKeyMayHelp: false };
  const checked: Array<string | undefined> = [];
  const retried = world(dir, { answers: ['yes'] }, {
    checkKey: async (options) => {
      checked.push(options.baseUrl);
      if (checked.length > 1) return { ok: true };
      writeFileSync(envFile, readFileSync(envFile, 'utf-8').replace('https://gateway.example/anthropic', 'https://fixed.example'));
      return down;
    },
  });
  expect(await runSetup(dir, ['discord'], retried)).toBe(0);
  expect(checked).toEqual(['https://gateway.example/anthropic', 'https://fixed.example']);
  expect(retried.seen.launched!.env.ANTHROPIC_BASE_URL).toBe('https://fixed.example');
});

test('a key .env can\'t hold as typed is refused before it is checked or kept, typed, exported or read from .env, and another is asked for', async () => {
  const why = 'it holds a double quote, a $ or a backslash, which Bun can read in a .env line otherwise than typed, so setup doesn\'t write them there';
  const typed = 'sk-ant-"typed';
  const dir1 = directory();
  const declined = world(dir1, { answers: ['no', ''], secrets: [typed, ''] });
  expect(await runSetup(dir1, ['discord'], declined)).toBe(1);
  expect(text(declined.seen.err)).toContain(`That key can't be used: ${why}. Check what was copied.`);
  expect(declined.seen.checked).toEqual([]);
  expect(declined.seen.asked.filter((question) => question.startsWith('An Anthropic API key'))).toHaveLength(2);
  expect(readEnvFile(join(dir1, '.env')).get('ANTHROPIC_API_KEY')).toBeUndefined();
  expect(declined.seen.launched).toBeNull();
  expect(text([...declined.seen.out, ...declined.seen.err])).not.toContain(typed);

  const dir2 = directory();
  const replaced = world(dir2, { answers: ['no', ''], secrets: [typed, KEY] });
  expect(await runSetup(dir2, ['discord'], replaced)).toBe(0);
  expect(replaced.seen.checked.map((each) => each.key)).toEqual([KEY]);
  expect(readEnvFile(join(dir2, '.env')).get('ANTHROPIC_API_KEY')).toBe(KEY);
  expect(replaced.seen.launched!.env.ANTHROPIC_API_KEY).toBe(KEY);

  const dir3 = directory();
  const exported = 'sk-ant-"exported';
  const fromShell = world(dir3, { answers: ['no', '', 'yes'], secrets: [''] }, { env: { PATH: '/usr/bin:/bin', HOME: dir3, ANTHROPIC_API_KEY: exported } });
  expect(await runSetup(dir3, ['discord'], fromShell)).toBe(1);
  expect(text(fromShell.seen.err)).toContain(`That key can't be used: ${why}. Check what was copied.`);
  expect(fromShell.seen.checked).toEqual([]);
  expect(fromShell.seen.asked.filter((question) => question.startsWith('An Anthropic API key'))).toHaveLength(1);
  expect(readEnvFile(join(dir3, '.env')).get('ANTHROPIC_API_KEY')).toBeUndefined();
  expect(text([...fromShell.seen.out, ...fromShell.seen.err])).not.toContain(exported);

  const dir4 = directory();
  mkdirSync(join(dir4, '.setup'));
  writeFileSync(join(dir4, '.setup', 'setup.lock'), '');
  const stored = 'sk-ant-"stored';
  writeFileSync(join(dir4, '.env'), `ANTHROPIC_API_KEY='${stored}'\n`, { mode: 0o600 });
  const fromEnv = world(dir4, { answers: ['no', ''], secrets: [''] });
  expect(await runSetup(dir4, ['discord'], fromEnv)).toBe(1);
  expect(text(fromEnv.seen.err)).toContain(`The ANTHROPIC_API_KEY in ${join(dir4, '.env')} can't be used: ${why}.`);
  expect(fromEnv.seen.checked).toEqual([]);
  expect(fromEnv.seen.asked.filter((question) => question.startsWith('An Anthropic API key'))).toHaveLength(1);
  expect(fromEnv.seen.launched).toBeNull();
  expect(readFileSync(join(dir4, '.env'), 'utf-8')).toBe(`ANTHROPIC_API_KEY='${stored}'\n`);
  expect(text([...fromEnv.seen.out, ...fromEnv.seen.err])).not.toContain(stored);
});

test('a key a request header can\'t carry, typed or read from .env, is refused by the check with no call, the .env one named as .env\'s, and another is asked for', async () => {
  const sent: Array<string | null> = [];
  const answered = (async (_url: string, init: RequestInit) => {
    sent.push(new Headers(init.headers).get('x-api-key'));
    const start = { type: 'message_start', message: { type: 'message', role: 'assistant', content: [], usage: { input_tokens: 5 } } };
    const end = { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 1 } };
    return new Response(`event: message_start\ndata: ${JSON.stringify(start)}\n\nevent: message_delta\ndata: ${JSON.stringify(end)}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
  const real = (options: KeyCheckOptions) => checkKey({ ...options, fetch: answered });
  const bad = 'sk-ant-line\u2028separated';
  const cause = "The key holds a character a request header can't carry, so it can't be sent, and no call was made. Check what was copied.";

  const dir1 = directory();
  const typed = world(dir1, { answers: ['no', ''], secrets: [bad, KEY] }, { checkKey: real });
  expect(await runSetup(dir1, ['discord'], typed)).toBe(0);
  expect(text(typed.seen.out)).toContain(`Checking the key: one call at https://api.anthropic.com to ${SETUP_MODEL}, the model setup's agent runs on, which the key's account has to be able to use.`);
  expect(text(typed.seen.err)).toContain(cause);
  expect(text(typed.seen.out)).toContain('Type a key, this one again or another, or Enter alone to stop.');
  expect(readEnvFile(join(dir1, '.env')).get('ANTHROPIC_API_KEY')).toBe(KEY);
  expect(typed.seen.launched!.env.ANTHROPIC_API_KEY).toBe(KEY);
  expect(text([...typed.seen.out, ...typed.seen.err])).not.toContain(bad);
  expect(sent).toEqual([KEY]);

  const dir2 = directory();
  mkdirSync(join(dir2, '.setup'));
  writeFileSync(join(dir2, '.setup', 'setup.lock'), '');
  writeFileSync(join(dir2, '.env'), `ANTHROPIC_API_KEY=${bad}\n`, { mode: 0o600 });
  const stored = world(dir2, { answers: ['no', ''], secrets: [''] }, { checkKey: real });
  expect(await runSetup(dir2, ['discord'], stored)).toBe(1);
  expect(text(stored.seen.out)).toContain(`Checking the ANTHROPIC_API_KEY in ${join(dir2, '.env')}: one call at https://api.anthropic.com to ${SETUP_MODEL},`);
  expect(text(stored.seen.err)).toContain(cause);
  expect(stored.seen.asked.filter((question) => question.startsWith('An Anthropic API key'))).toHaveLength(1);
  expect(stored.seen.launched).toBeNull();
  expect(readFileSync(join(dir2, '.env'), 'utf-8')).toBe(`ANTHROPIC_API_KEY=${bad}\n`);
  expect(text([...stored.seen.out, ...stored.seen.err])).not.toContain(bad);
  expect(sent).toEqual([KEY]);
});

test('an empty ANTHROPIC_BASE_URL in .env means Anthropic\'s own API, as it does for the host: setup checks the key there and gives its agent none', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.setup', 'setup.lock'), '');
  writeFileSync(join(dir, '.env'), `ANTHROPIC_BASE_URL=\nANTHROPIC_API_KEY="${KEY}"\n`, { mode: 0o600 });
  const made = world(dir, { answers: ['no', ''] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(made.seen.checked).toEqual([{ key: KEY, model: SETUP_MODEL }]);
  expect(text(made.seen.out)).toContain(`Checking the ANTHROPIC_API_KEY in ${join(dir, '.env')}: one call at https://api.anthropic.com to ${SETUP_MODEL},`);
  expect(made.seen.launched!.env.ANTHROPIC_BASE_URL).toBeUndefined();
});

test('an ANTHROPIC_BASE_URL exported in this shell is named, setup checking the key at and giving its agent the one .env sets, or none, and saying a host started from such a shell takes the exported one; setup writes none', async () => {
  const dir = directory();
  const envFile = join(dir, '.env');
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] },
    { env: { PATH: '/usr/bin:/bin', HOME: dir, ANTHROPIC_BASE_URL: 'https://someone:pass-in-url@gateway.example/path?token=in-query' } });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(made.seen.checked).toEqual([{ key: KEY, model: SETUP_MODEL }]);
  expect(made.seen.launched!.env.ANTHROPIC_BASE_URL).toBeUndefined();
  expect(readEnvFile(envFile).has('ANTHROPIC_BASE_URL')).toBe(false);
  expect(text(made.seen.out)).toContain(`Setup checks the key at, and gives its agent, Anthropic's own API, since ${envFile} sets no ANTHROPIC_BASE_URL, not the one exported in this shell.`);
  expect(text(made.seen.out)).toContain('A host started from a shell that exports another takes the exported one');
  const shown = text([...made.seen.out, ...made.seen.err]);
  for (const hidden of ['pass-in-url', 'someone', 'gateway.example', 'in-query']) expect(shown).not.toContain(hidden);

  writeFileSync(envFile, `${readFileSync(envFile, 'utf-8')}ANTHROPIC_BASE_URL=https://gateway.example\n`);
  for (const exported of ['https://other.example', '']) {
    const again = world(dir, {}, { env: { PATH: '/usr/bin:/bin', HOME: dir, ANTHROPIC_BASE_URL: exported } });
    expect(await runSetup(dir, ['discord'], again)).toBe(0);
    expect(again.seen.checked).toEqual([{ key: KEY, model: SETUP_MODEL, baseUrl: 'https://gateway.example' }]);
    expect(again.seen.launched!.env.ANTHROPIC_BASE_URL).toBe('https://gateway.example');
    expect(text(again.seen.out)).toContain(`Setup checks the key at, and gives its agent, the ANTHROPIC_BASE_URL in ${envFile}, which leads to https://gateway.example, not the one exported in this shell.`);
    expect(readEnvFile(envFile).get('ANTHROPIC_BASE_URL')).toBe('https://gateway.example');
  }
});

test('an ANTHROPIC_API_KEY exported in this shell, empty too, that differs from the key setup checked and keeps is named, the one in .env checked', async () => {
  const dir = directory();
  const envFile = join(dir, '.env');
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.setup', 'setup.lock'), '');
  writeFileSync(envFile, `ANTHROPIC_API_KEY="${KEY}"\n`);
  const made = world(dir, { answers: ['no', ''] }, { env: { PATH: '/usr/bin:/bin', HOME: dir, ANTHROPIC_API_KEY: 'sk-ant-exported-other' } });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(made.seen.checked.map((each) => each.key)).toEqual([KEY]);
  expect(made.seen.out.filter((line) => line.includes('exported in this shell'))).toEqual([
    `The ANTHROPIC_API_KEY exported in this shell isn't the one setup checked and keeps in ${envFile}. A host started from a ` +
    'shell that exports another takes the exported one, since Bun gives an exported variable precedence over .env. Unset it ' +
    'in this shell, and in any other you start a host from, so that such a host doesn\'t take it.',
  ]);
  expect(text([...made.seen.out, ...made.seen.err])).not.toContain('sk-ant-exported-other');

  const empty = world(dir, {}, { env: { PATH: '/usr/bin:/bin', HOME: dir, ANTHROPIC_API_KEY: '' } });
  expect(await runSetup(dir, ['discord'], empty)).toBe(0);
  expect(empty.seen.checked.map((each) => each.key)).toEqual([KEY]);
  expect(text(empty.seen.out)).toContain(`The ANTHROPIC_API_KEY exported in this shell isn't the one setup checked and keeps in ${envFile}.`);

  for (const exported of ['sk-ant-declined', '']) {
    const fresh = directory();
    const freshEnv = join(fresh, '.env');
    const first = world(fresh, { answers: exported === '' ? ['no', ''] : ['no', '', 'no'], secrets: [KEY] },
      { env: { PATH: '/usr/bin:/bin', HOME: fresh, ANTHROPIC_API_KEY: exported } });
    expect(await runSetup(fresh, ['discord'], first)).toBe(0);
    expect(readEnvFile(freshEnv).get('ANTHROPIC_API_KEY'), exported).toBe(KEY);
    expect(text(first.seen.out), exported).toContain(`The ANTHROPIC_API_KEY exported in this shell isn't the one setup checked and keeps in ${freshEnv}.`);
  }

  const replacedDir = directory();
  const replacedEnv = join(replacedDir, '.env');
  const refused = { ok: false as const, cause: 'refused the key (401)', anotherKeyMayHelp: true };
  const replaced = world(replacedDir, { answers: ['no', '', 'yes'], secrets: [KEY], keys: [refused, { ok: true }] },
    { env: { PATH: '/usr/bin:/bin', HOME: replacedDir, ANTHROPIC_API_KEY: 'sk-ant-exported-refused' } });
  expect(await runSetup(replacedDir, ['discord'], replaced)).toBe(0);
  expect(replaced.seen.checked.map((each) => each.key)).toEqual(['sk-ant-exported-refused', KEY]);
  expect(readEnvFile(replacedEnv).get('ANTHROPIC_API_KEY')).toBe(KEY);
  expect(text(replaced.seen.out)).toContain(`The ANTHROPIC_API_KEY exported in this shell isn't the one setup checked and keeps in ${replacedEnv}.`);

  const same = world(dir, {}, { env: { PATH: '/usr/bin:/bin', HOME: dir, ANTHROPIC_API_KEY: KEY } });
  expect(await runSetup(dir, ['discord'], same)).toBe(0);
  expect(text(same.seen.out)).not.toContain('exported in this shell');
});

test('an ANTHROPIC_BASE_URL put in .env during a question is checked as a URL before the key is, and names its origin when asking for a key', async () => {
  const dir = directory();
  const envFile = join(dir, '.env');
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.setup', 'setup.lock'), '');
  writeFileSync(envFile, 'ANTHROPIC_BASE_URL=https://gateway.example/anthropic\n');
  const labels: string[] = [];
  const made = world(dir, { answers: ['no', ''] }, {
    askHidden: async (label) => {
      labels.push(label);
      writeFileSync(envFile, 'ANTHROPIC_BASE_URL=localhost:8080\n');
      return KEY;
    },
  });
  expect(await runSetup(dir, ['discord'], made)).toBe(1);
  expect(labels).toEqual(['An API key that https://gateway.example accepts, typed hidden (Enter alone stops setup)']);
  expect(text(made.seen.err)).toContain(`ANTHROPIC_BASE_URL, in ${envFile}, isn't an http:// or https:// URL`);
  expect(made.seen.checked).toEqual([]);
  expect(made.seen.launched).toBeNull();
});

test('setup shows where ANTHROPIC_BASE_URL leads, never a user, password, path or query it carries', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.setup', 'setup.lock'), '');
  writeFileSync(join(dir, '.env'), 'ANTHROPIC_BASE_URL=https://someone:pass-in-url@gateway.example/path?token=in-query\n');
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  const shown = text([...made.seen.out, ...made.seen.err]);
  expect(shown).toContain('one call at https://gateway.example to ');
  for (const hidden of ['pass-in-url', 'someone', '/path', 'in-query']) expect(shown).not.toContain(hidden);
});

test('a host started again on setup\'s data goes on with the conversation it had', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['no', ''], secrets: [KEY], host: 'copy' });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  const launch = made.seen.launched!;
  const mock = join(dir, 'mock.json');
  writeFileSync(mock, JSON.stringify({
    name: 'mock', agent: { name: 'mock', provider: 'mock', systemPrompt: 'mock' },
    modules: { wake: false, workspace: false, subscriptionGc: false },
  }));
  const argv = launch.argv.map((word) => (word.endsWith('setup.json') ? mock : word));
  const session = (input: string) => {
    const ran = Bun.spawnSync(argv, { cwd: launch.cwd, env: launch.env, stdin: Buffer.from(input) });
    expect(ran.exitCode, ran.stderr.toString()).toBe(0);
    const out = ran.stdout.toString();
    return { id: /ID: (\S+)/.exec(out)?.[1], out };
  };
  const first = session('hello-from-the-first-run\n/session\n');
  expect(first.id).toBeDefined();
  const second = session('/session\n/history\n');
  expect(second.id).toBe(first.id);
  expect(second.out).toContain('hello-from-the-first-run');
}, 60_000);

test('the host refuses modules.setup headless, in the TUI, or with stdin or stdout off a terminal, so its agent runs only in readline mode on one', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['no', ''], secrets: [KEY], host: 'copy' });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  const launch = made.seen.launched!;
  const refusal = 'modules.setup runs only in readline mode with stdin and stdout on a terminal';
  const ran = Bun.spawnSync(launch.argv, { cwd: launch.cwd, env: launch.env, stdin: Buffer.from('') });
  expect(ran.exitCode).not.toBe(0);
  expect(ran.stdout.toString() + ran.stderr.toString()).toContain(refusal);
  expect(ran.stderr.toString(), 'a refusal, not a crash with its stack').not.toContain('Fatal error');

  // script(1) gives the host a terminal on stdin; the redirect inside takes stdout off it.
  const out = join(directory(), 'out.txt');
  const word = (each: string) => `'${each.replace(/'/g, `'\\''`)}'`;
  const line = `${launch.argv.map(word).join(' ')} > ${word(out)} 2>&1`;
  const redirected = Bun.spawnSync([Bun.which('script') ?? 'script', '-qec', line, '/dev/null'], {
    cwd: launch.cwd, env: launch.env, stdin: Buffer.from(''), timeout: 20_000,
  });
  expect(redirected.exitCode).not.toBe(0);
  expect(readFileSync(out, 'utf-8')).toContain(refusal);

  const onTerminal = (argv: string[], redirect: string) => Bun.spawnSync(
    [Bun.which('script') ?? 'script', '-qec', `${argv.map(word).join(' ')}${redirect}`, '/dev/null'],
    { cwd: launch.cwd, env: launch.env, stdin: Buffer.from(''), timeout: 20_000 },
  );
  const cases = [
    ['headless', [...launch.argv, '--headless'], ''],
    ['in the TUI', launch.argv.filter((each) => each !== '--no-tui'), ''],
    ['with stdin off the terminal', launch.argv, ' < /dev/null'],
  ] as const;
  for (const [how, argv, redirect] of cases) {
    const ran = onTerminal([...argv], redirect);
    expect(ran.exitCode, how).not.toBe(0);
    expect(ran.stdout.toString(), how).toContain(refusal);
  }
}, 120_000);

test('an install\'s own command takes setup to this release\'s setup, and the package\'s bin names the versioned line', async () => {
  const dir = directory();
  expect(await runSetup(dir, ['discord'], world(dir, { answers: ['no', ''], secrets: [KEY] }))).toBe(0);
  const command = join(dir, 'connectome-host', 'connectome');
  const routed = Bun.spawnSync([process.execPath, command, 'setup', 'discord'], { cwd: directory(), stdin: Buffer.from('') });
  expect(routed.exitCode).toBe(1);
  expect(routed.stderr.toString()).toContain('needs a person at a terminal');

  const empty = directory();
  const none = Bun.spawnSync([process.execPath, BIN], { cwd: empty, stdin: Buffer.from('') });
  expect(none.exitCode).toBe(1);
  expect(none.stderr.toString()).toContain(`In a new directory, \`bunx @animalabs/connectome-host@${VERSION} setup discord\` sets one up.`);
});

test('the package\'s bin runs its own setup for an install with no current release, which its own command can\'t run', async () => {
  const dir = directory();
  expect(await runSetup(dir, ['discord'], world(dir, { answers: ['no', ''], secrets: [KEY] }))).toBe(0);
  unlinkSync(join(dir, 'connectome-host', 'current'));
  const routed = Bun.spawnSync([process.execPath, BIN, 'setup', 'discord'], { cwd: dir, stdin: Buffer.from('') });
  expect(routed.exitCode).toBe(1);
  expect(routed.stderr.toString()).toContain('connectome setup needs a person at a terminal');
  expect(routed.stderr.toString()).not.toContain('has no current release');
});

test('the package\'s bin runs its own setup for an install whose current release has no setup agent, whose own command has no setup', async () => {
  const dir = directory();
  expect(await runSetup(dir, ['discord'], world(dir, { answers: ['no', ''], secrets: [KEY] }))).toBe(0);
  const root = join(dir, 'connectome-host');
  const release = join(root, 'releases', '0.0.1-before-setup', 'node_modules', '@animalabs', 'connectome-host');
  mkdirSync(join(release, 'src', 'cli'), { recursive: true });
  writeFileSync(join(release, 'src', 'cli', 'connectome.ts'),
    'export async function main() { console.error("connectome: there\'s no command setup."); return 2; }\n');
  unlinkSync(join(root, 'current'));
  symlinkSync(join('releases', '0.0.1-before-setup'), join(root, 'current'));
  const routed = Bun.spawnSync([process.execPath, BIN, 'setup', 'discord'], { cwd: dir, stdin: Buffer.from('') });
  expect(routed.stderr.toString()).not.toContain('there\'s no command setup');
  expect(routed.exitCode).toBe(1);
  expect(routed.stderr.toString()).toContain('connectome setup needs a person at a terminal');
});

test('a boot that doesn\'t finish within 60 s is stopped there, and said so', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['no', ''], secrets: [KEY], boot: { status: null, stdout: '', stderr: '', timedOut: true } });
  expect(await runSetup(dir, ['discord'], made)).toBe(1);
  expect(made.seen.boot!.timeoutMs).toBe(60_000);
  expect(text(made.seen.err)).toContain('didn\'t finish booting on a mock recipe in batch mode within 60 s');
});

test('where the install\'s own setup fails, setup shows its lines and says to run setup again once they\'re put right', async () => {
  const dir = directory();
  const made = world(dir, { answers: ['no', ''], installSetup: { status: 1, stdout: '', stderr: 'error: disk full' } });
  expect(await runSetup(dir, ['discord'], made)).toBe(1);
  expect(text(made.seen.err)).toContain('error: disk full');
  expect(text(made.seen.err)).toContain('Once what the lines above say is put right, run setup again.');
});

test('an install record that can\'t be read is named, one that isn\'t JSON or names no version with how to write it again, one naming another version as another release\'s, which setup won\'t write again since that would lose its fields, and nothing more is done', async () => {
  const dir = directory();
  expect(await runSetup(dir, ['discord'], world(dir, { answers: ['no', ''], secrets: [KEY] }))).toBe(0);
  writeFileSync(join(dir, 'connectome-host', 'install.json'), '{"v": 1, "dataD');
  const again = world(dir);
  expect(await runSetup(dir, ['discord'], again)).toBe(1);
  expect(text(again.seen.err)).toContain(join(dir, 'connectome-host', 'install.json'));
  expect(text(again.seen.err)).toContain(WRITE_RECORD_AGAIN);
  expect(again.seen.ran.some((argv) => args(argv)[0]?.endsWith(join('src', 'update', 'setup.ts')))).toBe(false);
  expect(again.seen.launched).toBeNull();

  const record = join(dir, 'connectome-host', 'install.json');
  writeFileSync(record, JSON.stringify({ v: 1, extraState: [] }));
  const noData = world(dir);
  expect(await runSetup(dir, ['discord'], noData)).toBe(1);
  expect(text(noData.seen.err)).toContain(`The install record at ${record} names no data directory`);
  expect(text(noData.seen.err)).toContain(`names no data directory, so setup can't tell which data the install serves. ${WRITE_RECORD_AGAIN}`);
  expect(text(noData.seen.err)).not.toContain(`(setup makes it as ${join(dir, 'data')})`);
  expect(noData.seen.launched).toBeNull();
  writeFileSync(record, JSON.stringify({ v: 1, dataDir: '', extraState: [] }));
  const emptyData = world(dir);
  expect(await runSetup(dir, ['discord'], emptyData)).toBe(1);
  expect(text(emptyData.seen.err)).toContain(`The install record at ${record} names no data directory`);
  expect(emptyData.seen.ran.some((argv) => args(argv)[0]?.endsWith(join('src', 'update', 'setup.ts')))).toBe(false);
  expect(readFileSync(record, 'utf-8')).toBe(JSON.stringify({ v: 1, dataDir: '', extraState: [] }));
  writeFileSync(record, JSON.stringify({ dataDir: join(dir, 'data'), extraState: [] }));
  const noVersion = world(dir);
  expect(await runSetup(dir, ['discord'], noVersion)).toBe(1);
  expect(text(noVersion.seen.err)).toContain(`has version undefined, and this release reads only version 1, so setup can't tell which data the install serves. ${WRITE_RECORD_AGAIN}`);
  expect(readFileSync(record, 'utf-8')).toBe(JSON.stringify({ dataDir: join(dir, 'data'), extraState: [] }));
  expect(noVersion.seen.ran.some((argv) => args(argv)[0]?.endsWith(join('src', 'update', 'setup.ts')))).toBe(false);
  for (const notAnObject of ['null', '[]']) {
    writeFileSync(record, notAnObject);
    const plain = world(dir);
    expect(await runSetup(dir, ['discord'], plain)).toBe(1);
    expect(text(plain.seen.err), notAnObject).toContain(`The install record at ${record} isn't an object, so this release can't read it, so setup can't tell which data the install serves. ${WRITE_RECORD_AGAIN}`);
    expect(readFileSync(record, 'utf-8'), notAnObject).toBe(notAnObject);
  }
  for (const v of [null, 0, '1', true]) {
    const kept = JSON.stringify({ v, dataDir: join(dir, 'data'), extraState: [] });
    writeFileSync(record, kept);
    const other = world(dir);
    expect(await runSetup(dir, ['discord'], other)).toBe(1);
    expect(text(other.seen.err)).toContain(`has version ${JSON.stringify(v)}, and this release reads only version 1, so setup can't tell which data the install serves, and goes no further.`);
    expect(text(other.seen.err), JSON.stringify(v)).not.toContain(WRITE_RECORD_AGAIN);
    expect(readFileSync(record, 'utf-8')).toBe(kept);
    expect(other.seen.ran.some((argv) => args(argv)[0]?.endsWith(join('src', 'update', 'setup.ts')))).toBe(false);
  }
  writeFileSync(record, JSON.stringify({ v: 2, dataDir: join(dir, 'data'), extraState: [], kept: 'by a newer release' }));
  const newer = world(dir);
  expect(await runSetup(dir, ['discord'], newer)).toBe(1);
  expect(text(newer.seen.err)).toBe(`The install record at ${record} has version 2, and this release reads only version 1, so setup can't tell which data the install serves, and goes no further.`);
  expect(text(newer.seen.err)).not.toContain(WRITE_RECORD_AGAIN);
  expect(readFileSync(record, 'utf-8')).toBe(JSON.stringify({ v: 2, dataDir: join(dir, 'data'), extraState: [], kept: 'by a newer release' }));
  expect(newer.seen.ran.some((argv) => args(argv)[0]?.endsWith(join('src', 'update', 'setup.ts')))).toBe(false);
  writeFileSync(record, JSON.stringify({ v: 1, dataDir: join(dir, 'data'), extraState: [] }));
  chmodSync(record, 0o000);
  try {
    const closed = world(dir);
    expect(await runSetup(dir, ['discord'], closed)).toBe(1);
    expect(text(closed.seen.err)).toContain('EACCES');
    expect(text(closed.seen.err)).toContain(record);
    expect(text(closed.seen.err)).toContain(', so setup can\'t tell which data the install serves, and goes no further.');
    expect(closed.seen.ran.some((argv) => args(argv)[0]?.endsWith(join('src', 'update', 'setup.ts')))).toBe(false);
  } finally {
    chmodSync(record, 0o600);
  }
  rmSync(record);
  mkdirSync(record);
  const folder = world(dir);
  expect(await runSetup(dir, ['discord'], folder)).toBe(1);
  expect(text(folder.seen.err)).toContain(`${record} can't be read (`);
  expect(text(folder.seen.err)).toContain(', so setup can\'t tell which data the install serves, and goes no further.');
});

test('an ANTHROPIC_BASE_URL in .env that isn\'t a URL is named before any key is asked for', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.setup', 'setup.lock'), '');
  writeFileSync(join(dir, '.env'), 'ANTHROPIC_BASE_URL=localhost:8080\n');
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(1);
  expect(text(made.seen.err)).toContain(`ANTHROPIC_BASE_URL, in ${join(dir, '.env')}, isn't an http:// or https:// URL`);
  expect(made.seen.checked).toEqual([]);
  expect(made.seen.asked.filter((question) => /\bkey\b/i.test(question))).toEqual([]);
});

test('a .setup this user can\'t write in is named, with what to do, and nothing is asked', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.setup', 'setup-state.json'), JSON.stringify({ v: 1, shell: false }));
  chmodSync(join(dir, '.setup'), 0o555);
  try {
    const made = world(dir, { answers: ['no', ''], secrets: [KEY] });
    expect(await runSetup(dir, ['discord'], made)).toBe(1);
    expect(text(made.seen.err)).toContain(`Setup can't make its lock, ${join(dir, '.setup', 'setup.lock')} (SQLITE_CANTOPEN`);
    expect(text(made.seen.err)).toContain(`Check that this user can write to ${join(dir, '.setup')}, and can read and write ${join(dir, '.setup', 'setup.lock')} if it's there`);
    expect(text(made.seen.err)).not.toContain('take it away');
    expect(made.seen.asked).toEqual([]);
  } finally {
    chmodSync(join(dir, '.setup'), 0o755);
  }
});

test('a setup.lock that isn\'t setup\'s lock is named, with what to do, and nothing is asked', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.setup', 'setup.lock'), '');
  writeFileSync(join(dir, '.setup', 'setup.lock'), '12345\n');
  const made = world(dir, { answers: ['no', ''], secrets: [KEY] });
  expect(await runSetup(dir, ['discord'], made)).toBe(1);
  expect(text(made.seen.err)).toContain(`${join(dir, '.setup', 'setup.lock')} isn't a lock setup can take`);
  expect(text(made.seen.err)).toContain('take it away and run setup again');
  expect(made.seen.asked).toEqual([]);
});

function running(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return false;
  }
}

test('setup\'s runner stops a program still running at its limit, and says so', async () => {
  const dir = directory();
  const started = Date.now();
  const marker = `60.${process.pid}${Date.now() % 1000}`;
  const left = () => readdirSync('/proc').filter((pid) => /^\d+$/.test(pid) && running(Number(pid)) && (() => {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf-8').includes(marker);
    } catch {
      return false;
    }
  })());
  const pending = realWorld().run(['sh', '-c', `echo started > started; exec sleep ${marker}`], { cwd: dir, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, timeoutMs: 3_000 });
  try {
    if (process.platform === 'linux') {
      let seen = left();
      for (const until = performance.now() + 5_000; seen.length === 0 && performance.now() < until;) seen = left();
      expect(seen).not.toEqual([]);
    }
  } finally {
    await pending;
  }
  const ran = await pending;
  expect(ran.timedOut).toBe(true);
  expect(ran.status).toBeNull();
  expect(Date.now() - started).toBeGreaterThanOrEqual(2_950);
  expect(Date.now() - started).toBeLessThan(60_000);
  expect(readFileSync(join(dir, 'started'), 'utf-8')).toBe('started\n');
  if (process.platform !== 'linux') return;
  expect(left()).toEqual([]);
}, 70_000);

test('a program setup can\'t start is named with what the system said', async () => {
  const dir = directory();
  writeFileSync(join(dir, 'not-a-program'), 'nothing to run\n', { mode: 0o644 });
  const ran = await realWorld().run([join(dir, 'not-a-program')], { cwd: dir, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
  expect(ran.status).toBeNull();
  expect(ran.startError?.code).toBe('EACCES');
  expect(ran.startError?.message).toContain('EACCES');
  expect(ran.startError?.message).toContain(join(dir, 'not-a-program'));

  const fresh = directory();
  const made = world(fresh, { answers: ['no', ''], added: ran });
  expect(await runSetup(fresh, ['discord'], made)).toBe(1);
  expect(text(made.seen.err)).toContain(`\`bun --no-env-file add @animalabs/connectome-host@${VERSION} @animalabs/discord-mcpl\` didn't finish (it couldn't be started (${ran.startError!.message})), so setup stops here.`);
});

test('setup\'s runner and its agent\'s launcher give a program exactly the environment they\'re given', async () => {
  const dir = directory();
  process.env.SETUP_TEST_NOT_GIVEN = 'not-given';
  try {
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', ONLY_THIS: 'given' };
    const ran = await realWorld().run(['env'], { cwd: dir, env });
    const lines = ran.stdout.trim().split('\n');
    expect(Object.fromEntries(lines.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))).toEqual(env);
    const agent = 'require("fs").writeFileSync("agent-env.json", JSON.stringify(process.env))';
    expect(await realWorld().startAgent({ argv: [process.execPath, '-e', agent], cwd: dir, env })).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'agent-env.json'), 'utf-8'))).toEqual(env);
  } finally {
    delete process.env.SETUP_TEST_NOT_GIVEN;
  }
});

test('a program setup runs that a signal ends is named by that signal', async () => {
  const ran = await realWorld().run(['sh', '-c', 'kill -TERM $$'], { cwd: directory(), env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
  expect(ran.status).toBeNull();
  expect(ran.signal).toBe('SIGTERM');

  const dir = directory();
  const made = world(dir, { answers: ['no', ''], added: { status: null, stdout: '', stderr: '', signal: 'SIGKILL' } });
  expect(await runSetup(dir, ['discord'], made)).toBe(1);
  expect(text(made.seen.err)).toContain('didn\'t finish (it was ended by SIGKILL), so setup stops here.');
  expect(text(made.seen.err)).not.toContain('lines above');
});

test('an empty ANTHROPIC_API_KEY line in .env counts as no key, so an exported one is offered', async () => {
  const dir = directory();
  mkdirSync(join(dir, '.setup'));
  writeFileSync(join(dir, '.setup', 'setup.lock'), '');
  writeFileSync(join(dir, '.env'), 'ANTHROPIC_API_KEY=\n');
  const made = world(dir, { answers: ['no', '', 'yes'] }, { env: { PATH: '/usr/bin:/bin', HOME: dir, ANTHROPIC_API_KEY: KEY } });
  expect(await runSetup(dir, ['discord'], made)).toBe(0);
  expect(made.seen.asked.some((question) => question.includes('exported'))).toBe(true);
  expect(readEnvFile(join(dir, '.env')).get('ANTHROPIC_API_KEY')).toBe(KEY);
});

const LATER_RUN = [
  'Setup keeps its answers here: the resident doesn\'t get a shell, and runs as this user, alice. They aren\'t asked again; setup\'s agent picks up where it stopped, and can change with you what it set up.',
  'Checking the install at <dir>/connectome-host.',
  `The install at <dir>/connectome-host serves <dir>/data and runs ${VERSION}, as before.`,
  'Starting the installed host once, on a mock recipe, to see that it starts.',
  `The installed host (${VERSION}) starts.`,
  'Checking the ANTHROPIC_API_KEY in <dir>/.env: one call at https://api.anthropic.com to claude-opus-5-5, the model setup\'s agent runs on, which the key\'s account has to be able to use.',
  'The key works, and it\'s in <dir>/.env.',
  costLine('claude-opus-5-5', false),
  'Setup\'s agent runs each command in <dir>, as you. You\'ll see each command whole before it runs, each of its lines on a line of its own, any character a terminal would hide or act on shown as a code, such as \\u001b for Escape, and each key or token setup knows of shown by its name in place of its value, such as <ANTHROPIC_API_KEY>.',
  'Starting setup\'s agent. It speaks first. /quit leaves the conversation, and `<dir>/connectome-host/connectome setup discord` picks it up where it stopped.',
  'To go on with setup where it stopped: `<dir>/connectome-host/connectome setup discord`.',
];
