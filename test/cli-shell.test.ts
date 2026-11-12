import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { COMMANDS } from '../src/cli/connectome.js';
import { writeInstallCommand } from '../src/cli/install-command.js';
import type { Ran, RunOptions } from '../src/cli/setup.js';
import { shell, shellCommand, type ShellWorld } from '../src/cli/shell.js';
import { shellWord } from '../src/update/launcher.js';
import { modeTest } from './mode-test.js';

const REPO = resolve(import.meta.dir, '..');
const NODE_FLOOR = (JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf-8')) as { engines: { node: string } }).engines.node.replace('>=', '');
const made: string[] = [];
const args = (argv: string[]) => argv.slice(argv[1] === '--no-env-file' ? 2 : 1);
const text = (lines: string[]) => lines.join('\n');
const OK: Ran = { status: 0, stdout: '', stderr: '' };
const BROKEN: Ran = { status: 1, stdout: '', stderr: 'Failed to load native module: pty.node, checked: build/Release\n' };

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function directory(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'shell-')));
  made.push(dir);
  return dir;
}

function installed(): { dir: string; root: string; line: string } {
  const dir = directory();
  const root = join(dir, 'connectome-host');
  mkdirSync(root);
  writeInstallCommand(root, '');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ trustedDependencies: ['node-pty', 'puppeteer', 'term-sessions-mcp'] }));
  return { dir, root, line: `${shellWord(join(root, 'connectome'))} shell install` };
}

function declare(dir: string, name: string, version: string, declared = true): void {
  mkdirSync(join(dir, 'node_modules', name), { recursive: true });
  writeFileSync(join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }));
  if (!declared) return;
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as Record<string, unknown>;
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ ...manifest, dependencies: { [name]: `^${version}` } }));
}

interface Script {
  node?: string | null;
  added?: Ran;
  addVersion?: string;
  pty?: Ran[];
  ptyCheck?: (cwd: string) => Ran;
  atPtyCheck?: (cwd: string) => void;
  installed?: Ran;
  atInstall?: (cwd: string) => void;
  atAdd?: (cwd: string) => void;
}

interface Seen {
  out: string[];
  err: string[];
  ran: string[][];
  options: RunOptions[];
}

function world(dir: string, script: Script = {}, over: Partial<ShellWorld> = {}): { world: ShellWorld; seen: Seen } {
  const seen: Seen = { out: [], err: [], ran: [], options: [] };
  const run = async (argv: string[], options: RunOptions): Promise<Ran> => {
    seen.ran.push(argv);
    seen.options.push(options);
    if (argv[0] === 'node' && argv[1] === '-e') {
      script.atPtyCheck?.(options.cwd);
      if (script.ptyCheck) return script.ptyCheck(options.cwd);
      return script.pty?.shift() ?? OK;
    }
    if (argv[0] === 'node') {
      const node = script.node === undefined ? '22.20.0' : script.node;
      return node === null ? { status: null, stdout: '', stderr: '', startError: { code: 'ENOENT', message: 'Executable not found in $PATH: "node"' } }
        : { status: 0, stdout: `v${node}\n`, stderr: '' };
    }
    if (args(argv)[0] === 'add') {
      if (script.added) return script.added;
      for (const spec of args(argv).slice(1)) {
        const name = spec.slice(0, spec.lastIndexOf('@'));
        declare(options.cwd, name, script.addVersion ?? '1.7.3');
      }
      script.atAdd?.(options.cwd);
      return OK;
    }
    if (args(argv)[0] === 'install') {
      script.atInstall?.(options.cwd);
      return script.installed ?? OK;
    }
    throw new Error(`shell install ran something this world doesn't know: ${argv.join(' ')}`);
  };
  return {
    seen,
    world: {
      platform: 'linux',
      env: { PATH: '/usr/bin:/bin', HOME: dir },
      cwd: dir,
      execArgv: [],
      bun: { path: process.execPath, version: '1.4.4' },
      hasSudo: true,
      run,
      ...over,
    },
  };
}

async function runShell(root: string, argv: string[], made: { world: ShellWorld; seen: Seen }): Promise<number> {
  return shell({
    root, argv,
    out: (line) => { made.seen.out.push(line); },
    err: (line) => { made.seen.err.push(line); },
  }, made.world);
}

test('`connectome shell install` is an install\'s own command, and any other words are a usage error that runs nothing', async () => {
  expect(shellCommand.usage).toBe('connectome shell install');
  expect(COMMANDS).toContain(shellCommand);
  const { dir, root, line } = installed();
  for (const argv of [[], ['remove'], ['install', 'now']]) {
    const made = world(dir);
    expect(await runShell(root, argv, made)).toBe(2);
    expect(made.seen.err).toEqual([`Usage: ${line}`]);
    expect(made.seen.ran).toEqual([]);
  }
});

test('shell install adds term-sessions-mcp 1.x in the directory that holds the install, with Bun and no dotenv file, checks that a pty opens there, says so, and writes nothing else', async () => {
  const { dir, root } = installed();
  const made = world(dir);
  expect(await runShell(root, ['install'], made)).toBe(0);
  const add = made.seen.ran.findIndex((argv) => args(argv)[0] === 'add');
  expect(made.seen.ran[add]).toEqual([process.execPath, '--no-env-file', 'add', 'term-sessions-mcp@^1']);
  expect(made.seen.options[add]!.cwd).toBe(dir);
  const check = made.seen.ran.findIndex((argv) => argv[0] === 'node' && argv[1] === '-e');
  expect(check).toBeGreaterThan(add);
  expect(made.seen.options[check]!.cwd).toBe(dir);
  expect(made.seen.out).toEqual([
    `Installing term-sessions-mcp@^1 in ${dir}, with Bun:`,
    `term-sessions-mcp 1.7.3 is installed in ${dir}.`,
    `A pty opens in ${dir}: node-pty ran /bin/echo in one, and what it printed came back. The resident's shell can run here. This command writes no recipe and sets up no service.`,
  ]);
  expect(made.seen.err).toEqual([]);
  expect(readdirSync(dir).sort()).toEqual(['connectome-host', 'node_modules', 'package.json']);
});

test('a term-sessions-mcp 1.x that package.json declares and node_modules holds is left as it is, and the pty is still checked', async () => {
  const { dir, root } = installed();
  declare(dir, 'term-sessions-mcp', '1.7.3');
  const made = world(dir);
  expect(await runShell(root, ['install'], made)).toBe(0);
  expect(made.seen.ran.some((argv) => args(argv)[0] === 'add')).toBe(false);
  expect(made.seen.ran.some((argv) => argv[0] === 'node' && argv[1] === '-e')).toBe(true);
  expect(made.seen.out[0]).toBe(`term-sessions-mcp 1.7.3 is installed in ${dir}.`);
});

test('another version of term-sessions-mcp is named, and 1.x installed in its place; one a failed add left undeclared is added again', async () => {
  const { dir, root } = installed();
  declare(dir, 'term-sessions-mcp', '2.0.0');
  const other = world(dir);
  expect(await runShell(root, ['install'], other)).toBe(0);
  expect(other.seen.ran.find((argv) => args(argv)[0] === 'add')).toEqual([process.execPath, '--no-env-file', 'add', 'term-sessions-mcp@^1']);
  expect(other.seen.out.slice(0, 3)).toEqual([
    `term-sessions-mcp 2.0.0 is in ${dir}, and the resident's shell is term-sessions-mcp 1.x, so this installs 1.x in its place.`,
    `Installing term-sessions-mcp@^1 in ${dir}, with Bun:`,
    `term-sessions-mcp 1.7.3 is installed in ${dir}.`,
  ]);

  const left = installed();
  declare(left.dir, 'term-sessions-mcp', '1.7.3', false);
  const again = world(left.dir);
  expect(await runShell(left.root, ['install'], again)).toBe(0);
  expect(again.seen.ran.some((argv) => args(argv)[0] === 'add')).toBe(true);
});

test('nothing a dotenv file of the directory the command started in gave it reaches Bun\'s add, its install, node or the pty check; what the shell exports does', async () => {
  for (const started of ['the install\'s directory', 'another']) {
    const { dir, root } = installed();
    const cwd = started === 'another' ? directory() : dir;
    writeFileSync(join(cwd, '.env'), 'ANTHROPIC_API_KEY=sk-ant-api03-from-dotenv\nDISCORD_TOKEN=token-from-dotenv\n', { mode: 0o600 });
    writeFileSync(join(cwd, '.env.local'), 'LOCAL_SECRET=local-from-dotenv\n', { mode: 0o600 });
    const made = world(dir, { pty: [BROKEN, OK] }, {
      cwd,
      env: {
        PATH: '/usr/bin:/bin', HOME: dir, EXPORTED: 'kept',
        ANTHROPIC_API_KEY: 'sk-ant-api03-from-dotenv', DISCORD_TOKEN: 'token-from-dotenv', LOCAL_SECRET: 'local-from-dotenv',
      },
    });
    expect(await runShell(root, ['install'], made), started).toBe(0);
    expect(made.seen.ran.map((argv) => argv[0] === 'node' ? argv.slice(0, 2).join(' ') : args(argv)[0])).toEqual(
      ['node --version', 'add', 'node -e', 'install', 'node -e']);
    for (const options of made.seen.options) {
      expect({ started, env: options.env }).toEqual({ started, env: { PATH: '/usr/bin:/bin', HOME: dir, EXPORTED: 'kept' } });
    }
  }
});

test('a dotenv file the command can\'t read stops it before it runs anything, naming the file and what to do', async () => {
  const { dir, root, line } = installed();
  mkdirSync(join(dir, '.env'));
  const made = world(dir);
  expect(await runShell(root, ['install'], made)).toBe(1);
  expect(made.seen.ran).toEqual([]);
  expect(text(made.seen.err)).toContain(`This command keeps what Bun reads from the dotenv files in ${dir} away from the shell's install scripts, so it must read them: put that right, and run \`${line}\` again.`);
});

test('a Bun below 1.4.4 is refused before anything runs, since an older `bun add --no-env-file` gives install scripts the .env', async () => {
  const { dir, root, line } = installed();
  const made = world(dir, {}, { bun: { path: process.execPath, version: '1.4.3' } });
  expect(await runShell(root, ['install'], made)).toBe(1);
  expect(made.seen.ran).toEqual([]);
  expect(made.seen.err).toEqual([`The resident's shell is installed with Bun 1.4.4 or later, whose \`bun add --no-env-file\` keeps .env's values from the packages' install scripts, and this is Bun 1.4.3. \`bun upgrade\` upgrades it, or the package manager that installed it does; then run \`${line}\` again.`]);
});

test('a BUN_OPTIONS that holds --env-file, or a Bun started with --env-file, is refused before anything runs, naming the line that runs it without', async () => {
  const { dir, root, line } = installed();
  const options = world(dir, {}, { env: { PATH: '/usr/bin:/bin', HOME: dir, BUN_OPTIONS: '--smol --env-file /elsewhere/.env' }, execArgv: ['--smol', '--env-file', '/elsewhere/.env'] });
  expect(await runShell(root, ['install'], options)).toBe(1);
  expect(options.seen.ran).toEqual([]);
  expect(options.seen.err).toEqual([
    'connectome shell install: BUN_OPTIONS holds --env-file, and Bun loads the file such a flag names into this command\'s own environment as it starts, where it can\'t keep that file\'s values from the shell\'s install scripts. Run it again without BUN_OPTIONS:',
    `  env -u BUN_OPTIONS ${line}`,
    'or with only its --env-file taken out of BUN_OPTIONS.',
  ]);
  const started = world(dir, {}, { execArgv: ['--env-file=/elsewhere/.env'] });
  expect(await runShell(root, ['install'], started)).toBe(1);
  expect(started.seen.ran).toEqual([]);
  expect(started.seen.err).toEqual([
    'connectome shell install: Bun was started with --env-file, and loads the file it names into this command\'s own environment as it starts, where it can\'t keep that file\'s values from the shell\'s install scripts. Run it again without it:',
    `  ${line}`,
  ]);
});

test('a Node above 24, or none, stops the command before its add, saying which Node the shell runs on', async () => {
  const { dir, root, line } = installed();
  const above = world(dir, { node: '25.0.0' });
  expect(await runShell(root, ['install'], above)).toBe(1);
  expect(above.seen.ran.map((argv) => argv[0])).toEqual(['node']);
  expect(above.seen.err).toEqual([`The resident's shell, term-sessions-mcp, runs on Node 24 at most, and this is Node 25.0.0. Install Node ${NODE_FLOOR} or later, and at most Node 24, from nodejs.org or your system's package manager, and run \`${line}\` again.`]);
  const none = world(dir, { node: null });
  expect(await runShell(root, ['install'], none)).toBe(1);
  expect(none.seen.err).toEqual([`The resident's shell runs on Node, and \`node --version\` didn't answer here (there's no node on this PATH). Install Node ${NODE_FLOOR} or later, and at most Node 24, from nodejs.org or your system's package manager, and run \`${line}\` again.`]);
  const top = world(dir, { node: '24.11.1' });
  expect(await runShell(root, ['install'], top)).toBe(0);
});

test('the command takes no setup lock, so it runs while setup holds its own through the agent\'s conversation', async () => {
  const { dir, root } = installed();
  mkdirSync(join(dir, '.setup'), { mode: 0o700 });
  const lock = new Database(join(dir, '.setup', 'setup.lock'), { create: true });
  lock.exec('PRAGMA locking_mode = EXCLUSIVE');
  lock.exec('BEGIN EXCLUSIVE');
  try {
    const made = world(dir);
    expect(await runShell(root, ['install'], made)).toBe(0);
    expect(made.seen.err).toEqual([]);
  } finally {
    lock.close();
  }
});

test('where package.json doesn\'t name term-sessions-mcp in trustedDependencies, the command says what Bun then runs, and goes on', async () => {
  const { dir, root } = installed();
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ trustedDependencies: ['node-pty'] }));
  const made = world(dir);
  expect(await runShell(root, ['install'], made)).toBe(0);
  expect(made.seen.out[0]).toBe(`${join(dir, 'package.json')} doesn't name term-sessions-mcp in its trustedDependencies, so Bun runs no install script of term-sessions-mcp's, and through a mirror or a company registry it may run none of the others', node-pty's among them. Setup tries to write that list each time it runs, and says so when it can't.`);
  const named = installed();
  const fine = world(named.dir);
  expect(await runShell(named.root, ['install'], fine)).toBe(0);
  expect(text(fine.seen.out)).not.toContain('trustedDependencies');
});

test('the pty check opens node-pty where term-sessions-mcp\'s own resolution finds it, under a hoisted layout and under an isolated one', async () => {
  const { dir, root } = installed();
  const made = world(dir, { pty: [BROKEN, BROKEN] });
  await runShell(root, ['install'], made);
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

test('a node-pty that opens no pty is installed again, its copy kept aside meanwhile in a .setup the command makes where it\'s gone, and the command goes on with the new one once it works', async () => {
  const { dir, root } = installed();
  const built = (cwd: string) => join(cwd, 'node_modules', 'node-pty', 'pty.node');
  let leftAtInstall: boolean | null = null;
  const made = world(dir, {
    ptyCheck: (cwd) => existsSync(built(cwd)) && readFileSync(built(cwd), 'utf-8') === 'built by the install' ? OK : BROKEN,
    atAdd: (cwd) => {
      mkdirSync(join(cwd, 'node_modules', 'node-pty'), { recursive: true });
      writeFileSync(built(cwd), 'the copy the command found');
    },
    atInstall: (cwd) => {
      leftAtInstall = existsSync(join(cwd, 'node_modules', 'node-pty'));
      mkdirSync(join(cwd, 'node_modules', 'node-pty'), { recursive: true });
      writeFileSync(built(cwd), 'built by the install');
    },
  });
  expect(existsSync(join(dir, '.setup'))).toBe(false);
  expect(await runShell(root, ['install'], made)).toBe(0);
  expect(leftAtInstall).toBe(false);
  expect(made.seen.out).toContain(`The resident's shell runs on node-pty, which doesn't work in ${dir} yet (Failed to load native module: pty.node, checked: build/Release), so this installs it again, keeping the copy it has at ${join(dir, '.setup', 'node-pty-aside')} until the new one works, and putting it back if it doesn't:`);
  expect(made.seen.ran.find((argv) => args(argv)[0] === 'install')).toEqual([process.execPath, '--no-env-file', 'install']);
  expect(existsSync(join(dir, '.setup', 'node-pty-aside'))).toBe(false);
  expect(readFileSync(built(dir), 'utf-8')).toBe('built by the install');
  expect(made.seen.out.at(-1)).toContain(`A pty opens in ${dir}`);
});

test('an install again of node-pty that fails puts back the copy the command found, and says why', async () => {
  const { dir, root } = installed();
  const made = world(dir, {
    pty: [BROKEN], installed: { status: 1, stdout: '', stderr: 'error: network\n' },
    atAdd: (cwd) => {
      mkdirSync(join(cwd, 'node_modules', 'node-pty'), { recursive: true });
      writeFileSync(join(cwd, 'node_modules', 'node-pty', 'pty.node'), 'the copy the command found');
    },
    atInstall: (cwd) => { writeFileSync(join(cwd, 'node_modules', 'node-pty'), 'what an install that fails left'); },
  });
  expect(await runShell(root, ['install'], made)).toBe(1);
  expect(text(made.seen.err)).toContain('The resident\'s shell runs on node-pty, and here it doesn\'t work: `bun --no-env-file install` didn\'t finish (exit 1).');
  expect(readFileSync(join(dir, 'node_modules', 'node-pty', 'pty.node'), 'utf-8')).toBe('the copy the command found');
  expect(existsSync(join(dir, '.setup', 'node-pty-aside'))).toBe(false);
});

test('an install again of node-pty that finishes but leaves one that still doesn\'t work puts back the copy the command found', async () => {
  const { dir, root } = installed();
  const made = world(dir, {
    pty: [BROKEN, BROKEN],
    atAdd: (cwd) => {
      mkdirSync(join(cwd, 'node_modules', 'node-pty'), { recursive: true });
      writeFileSync(join(cwd, 'node_modules', 'node-pty', 'pty.node'), 'the copy the command found');
    },
    atInstall: (cwd) => {
      mkdirSync(join(cwd, 'node_modules', 'node-pty'), { recursive: true });
      writeFileSync(join(cwd, 'node_modules', 'node-pty', 'pty.node'), 'unpacked by an install that finished, and never built');
    },
  });
  expect(await runShell(root, ['install'], made)).toBe(1);
  expect(text(made.seen.err)).toContain('The resident\'s shell runs on node-pty, and here it doesn\'t work: Failed to load native module: pty.node, checked: build/Release.');
  expect(readFileSync(join(dir, 'node_modules', 'node-pty', 'pty.node'), 'utf-8')).toBe('the copy the command found');
  expect(existsSync(join(dir, '.setup', 'node-pty-aside'))).toBe(false);
});

test('a repair that finds a copy a stopped repair set aside keeps that copy, and puts it back when its own install fails', async () => {
  const { dir, root } = installed();
  const made = world(dir, {
    pty: [BROKEN], installed: { status: 1, stdout: '', stderr: 'error: network\n' },
    atAdd: (cwd) => {
      mkdirSync(join(cwd, '.setup', 'node-pty-aside'), { recursive: true });
      writeFileSync(join(cwd, '.setup', 'node-pty-aside', 'pty.node'), 'the copy the command found');
      mkdirSync(join(cwd, 'node_modules', 'node-pty'), { recursive: true });
      writeFileSync(join(cwd, 'node_modules', 'node-pty', 'pty.node'), 'unpacked by an install that was stopped, and never built');
    },
  });
  expect(await runShell(root, ['install'], made)).toBe(1);
  expect(readFileSync(join(dir, 'node_modules', 'node-pty', 'pty.node'), 'utf-8')).toBe('the copy the command found');
  expect(existsSync(join(dir, '.setup', 'node-pty-aside'))).toBe(false);
});

test('a first pty check that passes removes a copy a stopped repair left aside, says so, and leaves the working copy as it is', async () => {
  const { dir, root } = installed();
  const aside = join(dir, '.setup', 'node-pty-aside');
  mkdirSync(aside, { recursive: true });
  writeFileSync(join(aside, 'pty.node'), 'the copy a stopped repair set aside');
  const made = world(dir, {
    atAdd: (cwd) => {
      mkdirSync(join(cwd, 'node_modules', 'node-pty'), { recursive: true });
      writeFileSync(join(cwd, 'node_modules', 'node-pty', 'pty.node'), 'the copy that works');
    },
  });
  expect(await runShell(root, ['install'], made)).toBe(0);
  expect(existsSync(aside)).toBe(false);
  expect(readFileSync(join(dir, 'node_modules', 'node-pty', 'pty.node'), 'utf-8')).toBe('the copy that works');
  expect(made.seen.out).toContain(`node-pty works in ${dir}, so this removed the copy a stopped repair had set aside at ${aside}.`);
  expect(made.seen.ran.some((argv) => args(argv)[0] === 'install')).toBe(false);
  const none = installed();
  const clean = world(none.dir);
  expect(await runShell(none.root, ['install'], clean)).toBe(0);
  expect(text(clean.seen.out)).not.toContain('set aside');
});

test('a pty check stopped at its 30 s limit says so, in the repair\'s line and in the stop, whatever it printed first', async () => {
  for (const printed of ['', '(node:4242) Warning: something slow\n']) {
    const { dir, root } = installed();
    const stopped: Ran = { status: null, stdout: '', stderr: printed, timedOut: true };
    const made = world(dir, { pty: [stopped, stopped] });
    expect(await runShell(root, ['install'], made)).toBe(1);
    const check = made.seen.ran.findIndex((argv) => argv[0] === 'node' && argv[1] === '-e');
    expect(made.seen.options[check]!.timeoutMs).toBe(30_000);
    expect(made.seen.out).toContain(`The resident's shell runs on node-pty, which doesn't work in ${dir} yet (its check ran past its 30 s limit and was stopped), so this installs it again, keeping the copy it has at ${join(dir, '.setup', 'node-pty-aside')} until the new one works, and putting it back if it doesn't:`);
    expect(made.seen.err[0]).toStartWith('The resident\'s shell runs on node-pty, and here it doesn\'t work: its check ran past its 30 s limit and was stopped. ');
  }
});

test('on Linux, a node-pty that still opens no pty once installed again stops the command, naming the build tools and the line that tries again', async () => {
  const { dir, root, line } = installed();
  const made = world(dir, { pty: [BROKEN, BROKEN] });
  expect(await runShell(root, ['install'], made)).toBe(1);
  expect(made.seen.err).toEqual([`The resident's shell runs on node-pty, and here it doesn't work: Failed to load native module: pty.node, checked: build/Release. On Linux, its native part is built as it's installed, with python3, make and a C++ compiler; on Debian and Ubuntu, \`sudo apt install build-essential python3\` installs them, run by you if you can use sudo here, or by whoever administers this machine. Then run \`${line}\` again, which installs node-pty again. A resident without a shell needs none of this.`]);
  const root2 = installed();
  const rootOnly = world(root2.dir, { pty: [BROKEN, BROKEN] }, { hasSudo: false });
  expect(await runShell(root2.root, ['install'], rootOnly)).toBe(1);
  expect(text(rootOnly.seen.err)).toContain('on Debian and Ubuntu, `apt install build-essential python3` installs them, run as root, by you or by whoever administers this machine.');
  expect(text(rootOnly.seen.err)).not.toContain('sudo apt');
});

test('a pty stop where package.json doesn\'t name term-sessions-mcp in trustedDependencies says Bun may not have run node-pty\'s install script, before the build tools', async () => {
  const { dir, root } = installed();
  writeFileSync(join(dir, 'package.json'), '{}');
  const made = world(dir, { pty: [BROKEN, BROKEN] });
  expect(await runShell(root, ['install'], made)).toBe(1);
  expect(text(made.seen.err)).toContain(`here it doesn't work: Failed to load native module: pty.node, checked: build/Release. ${join(dir, 'package.json')} doesn't name term-sessions-mcp in its trustedDependencies, so Bun may not have run node-pty's install script at all. On Linux, its native part is built as it's installed, with python3`);
});

test('on a platform that\'s neither Linux nor macOS, a pty stop gives no platform\'s build advice, and keeps the install-script sentence', async () => {
  const { dir, root } = installed();
  writeFileSync(join(dir, 'package.json'), '{}');
  const made = world(dir, { pty: [BROKEN, BROKEN] }, { platform: 'freebsd' });
  expect(await runShell(root, ['install'], made)).toBe(1);
  expect(made.seen.err).toEqual([`The resident's shell runs on node-pty, and here it doesn't work: Failed to load native module: pty.node, checked: build/Release. ${join(dir, 'package.json')} doesn't name term-sessions-mcp in its trustedDependencies, so Bun may not have run node-pty's install script at all. A resident without a shell needs none of this.`]);
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
  const linux = installed();
  let pty = '';
  let leftAtInstall: boolean | null = null;
  const onLinux = world(linux.dir, {
    pty: [{ status: 1, stdout: '', stderr: 'Failed to load native module: pty.node\n' }],
    atAdd: (cwd) => { pty = isolatedNodePty(cwd); },
    atInstall: (cwd) => { leftAtInstall = existsSync(pty); isolatedNodePty(cwd); },
  });
  expect(await runShell(linux.root, ['install'], onLinux)).toBe(0);
  expect(leftAtInstall).toBe(false);
  const mac = installed();
  const modes: number[][] = [];
  let helpers: string[] = [];
  const onMac = world(mac.dir, {
    pty: [{ status: 1, stdout: '', stderr: 'posix_spawnp failed.\n' }],
    atAdd: (cwd) => { const at = isolatedNodePty(cwd); helpers = ['darwin-arm64', 'darwin-x64'].map((prebuild) => join(at, 'prebuilds', prebuild, 'spawn-helper')); },
    atInstall: (cwd) => { isolatedNodePty(cwd); },
    atPtyCheck: () => modes.push(helpers.map((helper) => statSync(helper).mode & 0o777)),
  }, { platform: 'darwin' });
  expect(await runShell(mac.root, ['install'], onMac)).toBe(0);
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
  const { dir, root } = installed();
  const helpers = SPAWN_HELPERS.map((prebuild) => join(dir, 'node_modules', 'node-pty', 'prebuilds', prebuild, 'spawn-helper'));
  const modes: number[][] = [];
  const made = world(dir, {
    pty: [{ status: 1, stdout: '', stderr: 'posix_spawnp failed.\n' }],
    atPtyCheck: () => modes.push(helpers.map((helper) => statSync(helper).mode & 0o777)), atAdd: shipNodePty, atInstall: shipNodePty,
  }, { platform: 'darwin' });
  expect(await runShell(root, ['install'], made)).toBe(0);
  expect(modes).toEqual([[0o755, 0o755], [0o755, 0o755]]);
});

test('on macOS, a spawn-helper already executable by its owner is left as it is; on Linux, the macOS prebuilds are left as they are', async () => {
  const mac = installed();
  let helpers: string[] = [];
  const onMac = world(mac.dir, { atAdd: (cwd) => { helpers = shipNodePty(cwd); chmodSync(helpers[0]!, 0o700); } }, { platform: 'darwin' });
  expect(await runShell(mac.root, ['install'], onMac)).toBe(0);
  expect(helpers.map((helper) => statSync(helper).mode & 0o777)).toEqual([0o700, 0o755]);
  const linux = installed();
  const onLinux = world(linux.dir, { atAdd: (cwd) => { helpers = shipNodePty(cwd); } });
  expect(await runShell(linux.root, ['install'], onLinux)).toBe(0);
  expect(helpers.map((helper) => statSync(helper).mode & 0o777)).toEqual([0o644, 0o644]);
});

test('on macOS, a pty stop names macOS, says the command makes spawn-helper executable, and gives no Linux build lines', async () => {
  const { dir, root } = installed();
  const broken = { status: 1, stdout: '', stderr: 'posix_spawnp failed.\n' };
  writeFileSync(join(dir, 'package.json'), '{}');
  const made = world(dir, { pty: [broken, broken], atAdd: shipNodePty, atInstall: shipNodePty }, { platform: 'darwin' });
  expect(await runShell(root, ['install'], made)).toBe(1);
  expect(made.seen.err).toEqual(['The resident\'s shell runs on node-pty, and here it doesn\'t work: posix_spawnp failed. On macOS, node-pty runs from binaries it ships prebuilt rather than building them, and this command makes their spawn-helper executable after each install, which node-pty\'s own install doesn\'t. A resident without a shell needs none of this.']);
});

modeTest('on macOS, a spawn-helper the command can\'t make executable in the copy it leaves in place is named in the stop, with what to do', async () => {
  const { dir, root, line } = installed();
  const broken = { status: 1, stdout: '', stderr: 'posix_spawnp failed.\n' };
  let shut = '';
  const made = world(dir, {
    pty: [broken, broken], atInstall: shipNodePty,
    atAdd: (cwd) => { shipNodePty(cwd); shut = join(cwd, 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64'); chmodSync(shut, 0o600); },
  }, { platform: 'darwin' });
  try {
    expect(await runShell(root, ['install'], made)).toBe(1);
  } finally {
    if (shut) chmodSync(shut, 0o755);
  }
  expect(text(made.seen.err)).toContain(`here it doesn't work: posix_spawnp failed. On macOS, node-pty runs from binaries it ships prebuilt, whose spawn-helper has to be executable, and ${join(shut, 'spawn-helper')} couldn't be made executable (EACCES: permission denied, stat '${join(shut, 'spawn-helper')}'). Run \`${line}\` again once that's put right, which installs node-pty again. A resident without a shell needs none of this.`);
});

modeTest('on macOS, a prebuilds directory the command can\'t list is named in the stop, with its error and what to do', async () => {
  const { dir, root, line } = installed();
  const broken = { status: 1, stdout: '', stderr: 'posix_spawnp failed.\n' };
  let shut = '';
  const made = world(dir, {
    pty: [broken, broken], atInstall: shipNodePty,
    atAdd: (cwd) => { shipNodePty(cwd); shut = join(cwd, 'node_modules', 'node-pty', 'prebuilds'); chmodSync(shut, 0o000); },
  }, { platform: 'darwin' });
  try {
    expect(await runShell(root, ['install'], made)).toBe(1);
  } finally {
    if (shut) chmodSync(shut, 0o755);
  }
  expect(text(made.seen.err)).toContain(`here it doesn't work: posix_spawnp failed. On macOS, node-pty runs from binaries it ships prebuilt, whose spawn-helper has to be executable, and ${shut} couldn't be read (EACCES: permission denied, scandir '${shut}'). Run \`${line}\` again once that's put right, which installs node-pty again. A resident without a shell needs none of this.`);
});

test('on macOS, a node-pty with no prebuilt binaries gets no word about them in the stop, and the note on the trusted list when Bun may not have built it', async () => {
  const { dir, root } = installed();
  const broken = { status: 1, stdout: '', stderr: 'posix_spawnp failed.\n' };
  writeFileSync(join(dir, 'package.json'), '{}');
  const made = world(dir, { pty: [broken, broken] }, { platform: 'darwin' });
  expect(await runShell(root, ['install'], made)).toBe(1);
  expect(made.seen.err).toEqual([`The resident's shell runs on node-pty, and here it doesn't work: posix_spawnp failed. ${join(dir, 'package.json')} doesn't name term-sessions-mcp in its trustedDependencies, so Bun may not have run node-pty's install script at all. A resident without a shell needs none of this.`]);
});

test('an add that fails stops the command, saying its own lines say why and how to try again', async () => {
  const { dir, root, line } = installed();
  const failed = world(dir, { added: { status: 1, stdout: '', stderr: 'error: install script from "node-pty" exited with 1\n' } });
  expect(await runShell(root, ['install'], failed)).toBe(1);
  expect(failed.seen.err).toEqual([`\`bun --no-env-file add term-sessions-mcp@^1\` didn't finish (exit 1), so the resident's shell isn't installed. Its own lines above say why. Once that's put right, run \`${line}\` again.`]);
  expect(failed.seen.ran.some((argv) => argv[0] === 'node' && argv[1] === '-e')).toBe(false);
  const cut = world(dir, { added: { status: null, stdout: '', stderr: '', signal: 'SIGTERM' } });
  expect(await runShell(root, ['install'], cut)).toBe(1);
  expect(cut.seen.err).toEqual([`\`bun --no-env-file add term-sessions-mcp@^1\` didn't finish (it was ended by SIGTERM), so the resident's shell isn't installed. Run \`${line}\` again to try once more.`]);
});
