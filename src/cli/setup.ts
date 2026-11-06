import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import { constants, tmpdir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { Database } from 'bun:sqlite';
import { bunBelowFloor } from '../bun-floor.js';
import { priceAnthropicCall } from '../call-pricing.js';
import { ANTHROPIC_API, checkKey, originOf, type KeyCheck, type KeyCheckOptions } from '../setup/key-check.js';
import {
  EnvFormError, dotenvNames, dotenvValues, envForm, readEnvFile, unwritableValue, writeEnvValue,
} from '../setup/secrets.js';
import { lingerOf } from '../setup/linger.js';
import { readSetupState, type KeptState, type SetupState } from '../setup/state.js';
import { makeSpawnHelperExecutable, nodePtyDir } from '../setup/node-pty.js';
import { HOST_TRUSTED, defaultTrusted } from '../setup/default-trusted.js';
import { commandsShownNote } from '../modules/setup-module.js';
import { askHidden as askHiddenOn } from '../setup/terminal-secret.js';
import {
  ContractError, EXTRA_STATE_LINE, WRITE_RECORD_AGAIN, keptOutsideLines, readCurrent, readRecord, releaseDir,
  writeJsonAtomic, writeTextAtomic, type InstallRecord,
} from '../update/contract.js';
import { HOST_ENTRY, RELEASE_HOST, isUnder, shellWord } from '../update/launcher.js';
import { bindingOf, mapPath, type Binding, type Place } from '../update/rebind.js';
import type { CliContext } from './connectome.js';
import { INSTALL_COMMAND, SETUP_RECIPE, installCommandOf, typedCommand } from './install-command.js';

export const SETUP_USAGE = 'connectome setup discord';

export { SETUP_RECIPE };
export const SETUP_SUMMARY = 'Sets a resident up on Discord with the host\'s own setup agent, in the directory that ' +
  'holds the install (from bunx, the directory it runs in). ' +
  'Run again, it goes on where it stopped. Unlike the other commands, it runs this package\'s own setup unless ' +
  'the install has its own command and its release a setup agent.';

const PACKAGE = '@animalabs/connectome-host';
const SURFACE = 'discord';
const SERVERS = { discord: '@animalabs/discord-mcpl', shell: 'term-sessions-mcp' } as const;
// term-sessions-mcp 1.7.3's engines: node ">=18.0.0 <25.0.0".
const SHELL_NODE_TOP = 24;
const BOOT_TIMEOUT_MS = 60_000;
// Bun 1.4.3's `bun add --no-env-file` still gives a package's install script the working directory's .env, where
// 1.4.4's gives none (probed), and setup's bun add runs where the resident's secrets are.
export const SETUP_BUN_FLOOR = '>=1.4.4';
const USER_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;
const NOT_FOR_THE_AGENT = [
  'CONNECTOME_INSTALL_ROOT', 'MODEL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_CREDENTIALS_FILE', 'ANTHROPIC_BASE_URL',
  'MCPL_AGENT_OVERLAY_FILE',
];

interface PackageJson {
  version: string;
  engines: { bun: string; node: string };
  bugs: { url: string };
}

function packageJson(): PackageJson {
  return JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'package.json'), 'utf-8')) as PackageJson;
}

export function packageCommand(): string {
  return `bunx ${PACKAGE}@${packageJson().version}`;
}

export function firstLine(): string {
  return `${packageCommand()} setup ${SURFACE}`;
}

const RESIDENT = 'A resident is an agent of yours on Discord, run by an install of connectome-host in a directory of ' +
  'its own, which holds its memory and settings and names the service that keeps it running.';

function homeDirectory(home: string | undefined): string | null {
  if (home === undefined || !isAbsolute(home)) return null;
  try {
    return statSync(home).isDirectory() ? home : null;
  } catch {
    return null;
  }
}

export interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
  startError?: { code?: string; message: string };
  timedOut?: boolean;
  signal?: NodeJS.Signals;
}

export interface RunOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  show?: boolean;
}

export interface AgentLaunch {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface SetupWorld {
  terminal: boolean;
  platform: NodeJS.Platform;
  user: string;
  env: Record<string, string | undefined>;
  cwd: string;
  execArgv: string[];
  bun: { path: string; version: string };
  hasSudo: boolean;
  lingerOf(user: string): boolean | null;
  userExists(user: string): boolean | null;
  ask(question: string): Promise<string | null>;
  askHidden(label: string): Promise<string | null>;
  run(argv: string[], options: RunOptions): Promise<Ran>;
  checkKey(options: KeyCheckOptions): Promise<KeyCheck>;
  startAgent(launch: AgentLaunch): Promise<number>;
}

interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

export async function setup(ctx: CliContext & { root: string }, world: SetupWorld = realWorld()): Promise<number> {
  const { err } = ctx;
  try {
    return await setupIn(ctx, world);
  } catch (error) {
    err(`connectome setup: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function setupIn(ctx: CliContext & { root: string }, world: SetupWorld): Promise<number> {
  const { out, err } = ctx;
  const root = ctx.root;
  const dir = dirname(root);
  const pkg = packageJson();
  const version = pkg.version;

  const command = existsSync(join(root, INSTALL_COMMAND)) && existsSync(join(root, 'current', SETUP_RECIPE))
    ? `${typedCommand(root, world.env.PATH)} setup ${SURFACE}` : firstLine();
  if (ctx.argv.length !== 1 || ctx.argv[0] !== SURFACE) {
    err(`Usage: ${command}`);
    err('Discord is the one surface setup sets a resident up on.');
    return 2;
  }
  if (!world.terminal) {
    err('connectome setup needs a person at a terminal: it asks questions, and its agent talks with you in this ' +
      'terminal. Run it in one.');
    return 1;
  }
  if (world.env.BUN_OPTIONS?.includes('--env-file')) {
    err('connectome setup: BUN_OPTIONS holds --env-file, and Bun loads the file such a flag names into setup\'s own ' +
      'environment as setup starts, where setup can\'t keep that file\'s values from its agent. Run setup again ' +
      'without BUN_OPTIONS:');
    err(`  env -u BUN_OPTIONS ${command}`);
    err('or with only its --env-file taken out of BUN_OPTIONS.');
    return 1;
  }
  if (world.execArgv.some((word) => word === '--env-file' || word.startsWith('--env-file='))) {
    err('connectome setup: Bun was started with --env-file, and loads the file it names into setup\'s own environment ' +
      'as setup starts, where setup can\'t keep that file\'s values from its agent. Run setup again without it:');
    err(`  ${command}`);
    return 1;
  }
  const setupDir = join(dir, '.setup');
  const statePath = join(setupDir, 'setup-state.json');
  const entries = readdirSync(dir);
  const ours = existsSync(join(setupDir, 'setup.lock')) || existsSync(statePath) || existsSync(join(root, 'install.json'));
  let kept = false;
  const stopped = () => {
    out(kept ? 'Setup stopped. Run it again in this directory to go on.'
      : 'Setup stopped before keeping its answers. Run it again in this directory to answer its questions again.');
    return 1;
  };
  const stoppedElsewhere = () => {
    out('Setup stopped before its questions were answered. Nothing was written here. Run setup again to answer its ' +
      'two questions.');
    return 1;
  };
  if (!ours && entries.length > 0) {
    const home = homeDirectory(world.env.HOME);
    const what = home !== null && dir === home ? `${dir} is your home directory`
      : entries.every((entry) => entry.startsWith('.')) ? `${dir} holds hidden files, such as ${[...entries].sort()[0]}`
        : `${dir} holds other files`;
    const elsewhere = () => {
      if (home === null) {
        err(`connectome setup: ${what}, and no connectome-host install, so setup won't put its own there. Make a new ` +
          'directory for the resident where you can write, and run this same version of setup there. Its service takes ' +
          'the directory\'s name:');
      } else {
        err(`connectome setup: ${what}, and no connectome-host install, so setup won't put its own there. Make a new ` +
          'directory for the resident, and run this same version of setup there. Its service takes the directory\'s ' +
          'name, so choose another than resident if you like, or if ~/resident is already there:');
        err('  mkdir ~/resident && cd ~/resident');
      }
      err(`  ${firstLine()}`);
      return 1;
    };
    if (!ownUserPossible(world) || home === null) return elsewhere();
    out(`${RESIDENT} ${what}, so setup won't install there. It asks first whether the resident gets a shell and who it ` +
      'runs as, since those say where setup runs next.');
    const answered = await askWhoAndShell(world, { out, err });
    if (typeof answered === 'number') return answered === -1 ? stoppedElsewhere() : answered;
    out('Then make a new directory for the resident in your home, and run this same version of setup there, where its ' +
      'questions come again. Its service takes the directory\'s name, so choose another than resident if you like, or ' +
      'if ~/resident is already there:');
    out('  mkdir ~/resident && cd ~/resident');
    out(`  ${firstLine()}`);
    out('Nothing was installed here.');
    return 0;
  }
  mkdirSync(setupDir, { recursive: true, mode: 0o700 });
  const lock = takeSetupLock(join(setupDir, 'setup.lock'));
  if (lock === null) {
    err(`Another setup is running in ${dir}, so this one does nothing. Wait for it to end, or end it, and run ` +
      'setup again.');
    return 1;
  }
  try {
    rmSync(join(dir, '.env.tmp'), { force: true });
    const envFile = join(dir, '.env');
    const envStat = lstatSync(envFile, { throwIfNoEntry: false });
    if (envStat?.isSymbolicLink()) {
      err(`${envFile} is a link to ${readlinkSync(envFile)}. Setup keeps its key and its agent's secrets in .env as a ` +
        `file of its own, readable by ${world.user} alone, so it won't write through the link or over it. Replace the ` +
        'link with the file it leads to, if that\'s there, or take it away, and run setup again.');
      return 1;
    }
    if (envStat?.isFile() && (envStat.mode & 0o077) !== 0) {
      chmodSync(envFile, 0o600);
      out(`${envFile} was open to others than ${world.user}, so setup made it readable by ${world.user} alone.`);
    }
    let outside: EnvFormError | null;
    try {
      outside = envForm(envFile);
    } catch (error) {
      err(`${(error as Error).message}. Setup keeps its key and its agent's secrets there, so it must be a file ` +
        `${world.user} can read: put that right, and run setup again.`);
      return 1;
    }
    if (outside) {
      err(`${outside.message}. Then run setup again.`);
      return 1;
    }
    const read = readSetupState(statePath);
    if ('unreadable' in read) {
      err(`Setup's kept answers in ${statePath} can't be read (${read.unreadable}), so setup doesn't go by them.`);
    }
    let state = 'state' in read ? read.state : null;
    if (state !== null) {
      out(`Setup keeps its answers here: the resident ${state.shell ? 'gets' : 'doesn\'t get'} a shell, ` +
        `and runs as this user, ${world.user}. They aren't asked again; setup's agent picks up where it stopped, and ` +
        'can change with you what it set up.');
    }
    const lost = existsSync(root) ? null
      : state?.finished !== undefined
        ? `This directory's install root, ${root}, is gone, and its record with it: the places of state kept ` +
          'outside the data directory, its releases and its Go back.'
        : 'unreadable' in read
          ? `This directory's install root, ${root}, isn't there, and setup can't tell whether a setup finished here, ` +
            'since its kept answers can\'t be read. If one did, the root\'s record went with it: the places of state ' +
            'kept outside the data directory, its releases and its Go back.'
          : null;
    if (lost !== null) {
      out(lost);
      const fresh = await yesNo(world, `Make a new install on ${join(dir, 'data')}? (yes/no) `);
      if (fresh === null) {
        out('Setup stopped. Run it again in this directory to go on.');
        return 1;
      }
      if (!fresh) {
        out('Put the root\'s backup back, if you have one, and run setup again.');
        return 0;
      }
    }
    if (state === null) {
      out(`${RESIDENT} Its directory here is ${dir}, so its service is named after ${basename(dir)}. Setup asks a few ` +
        `questions first, among them who the resident runs as. When it runs as this user, ${world.user}, setup then ` +
        `installs connectome-host ${version} here (about 0.8 GB of disk with the install's own copy of it, or 1.1 GB ` +
        'with a shell for the resident), unless that version is there already, checks an API key, and starts the ' +
        'host\'s setup agent, which talks with you in this terminal to set up the resident.');
      const answered = await askWhoAndShell(world, { out, err });
      if (typeof answered === 'number') return answered === -1 ? stopped() : answered;
      state = answered;
    }
    writeJsonAtomic(statePath, state, 0o600);
    kept = true;
    let env: Record<string, string | undefined>;
    let shell: Record<string, string>;
    try {
      env = withoutDotEnv(world.env, world.cwd);
      shell = exportedOf(world.env, env, world.cwd);
    } catch (error) {
      err(`${(error as Error).message}. Setup keeps what Bun reads from the dotenv files in ${world.cwd} away from ` +
        'its agent, so it must read them: put that right, and run setup again.');
      return 1;
    }
    return await installAndStart(ctx, world, { dir, root, pkg, version, state, env, shell, stopped });
  } finally {
    lock.release();
  }
}

async function askWhoAndShell(world: SetupWorld, { out }: Io): Promise<SetupState | number> {
  out('A shell lets the resident run commands on this machine as the user it runs as, which setup settles next: it ' +
    'can read and change whatever that user can, and whoever talks to it on Discord can ask it to.');
  const shell = await yesNo(world, 'Does the resident get a shell? (yes/no) ');
  if (shell === null) return -1;
  const isolation = `With a shell, the resident can read and change whatever ${world.user} can (${world.user}'s ` +
    'files, keys and other programs), and whoever talks to it on Discord can ask it to.';
  if (!ownUserPossible(world)) {
    const why = world.platform === 'darwin' ? 'On macOS, setup has no root lines for a user of its own'
      : !world.hasSudo ? 'There\'s no sudo on this machine'
        : 'This machine doesn\'t run systemd, which the line for a user of its own needs to keep its services running';
    out(`${why}, so the resident runs as this user, ${world.user}.${shell ? ` ${isolation}` : ''}`);
    const go = await yesNo(world, `Go on as ${world.user}? (yes/no) `);
    if (go === null) return -1;
    if (!go) {
      out('Nothing was installed.');
      return 0;
    }
    return { v: 1, shell };
  }
  out('Who does the resident run as?');
  out(`  1. a user of its own${shell ? ', as setup recommends with a shell' : ''}: setup shows the lines that make it, ` +
    'which need sudo, yours if you can use it here or else an admin\'s, and you run setup again as that user, where ' +
    'its questions come again');
  out(`  2. this user, ${world.user}: for a resident with no shell, or where ${world.user} already is the resident's ` +
    `own user${world.lingerOf(world.user) === false ? `; linger, which keeps ${world.user}'s services running while ` +
      `${world.user} is logged out, is off, so its service needs one sudo line too, run once, by you or an admin` : ''}`);
  const choice = shell ? await pick(world, 'Choose 1 or 2: ', null) : await pick(world, 'Choose 1 or 2 [2]: ', '2');
  if (choice === null) return -1;
  if (choice === '1') {
    const name = await userName(world, out);
    if (name === null) return -1;
    // One line: with sudo's use_pty, lines pasted after a sudo line go to its command as input, and never run.
    out('Run this line where you can use sudo: it makes its user, unless one by that name is there already, keeps ' +
      'its services running while it\'s logged out, and gives it Bun on its PATH. If a step fails, put right what ' +
      'it names and run the line again.');
    // bun.sh/install exits before adding Bun to PATH, or linking bunx, wherever a bun is on PATH already.
    out(`  id -u ${name} >/dev/null 2>&1 || sudo useradd -m -s /bin/bash ${name} && ` +
      `sudo loginctl enable-linger ${name} && ` +
      `sudo -iu ${name} env PATH=/usr/bin:/bin bash -c 'set -o pipefail; curl -fsSL https://bun.sh/install | bash'`);
    out(`Setup needs Node ${packageJson().engines.node.replace('>=', '')} or later there too` +
      `${shell ? `, and at most Node ${SHELL_NODE_TOP}` : ''}: if this machine's Node is installed for your user ` +
      `alone, as one from nvm is, install Node for ${name} as well. \`command -v node\` shows where yours is: one ` +
      'in your home is yours alone.');
    out(`Then open a shell as ${name}, with \`sudo -iu ${name}\` where you can use sudo, or by whoever ran the line, and ` +
      'run this same version of setup there, in a new directory for the resident. Its service takes the directory\'s ' +
      'name, so choose another than resident if you like, or if ~/resident is already there:');
    out('  mkdir ~/resident && cd ~/resident');
    out(`  ${firstLine()}`);
    out(`There, choose "this user" when setup asks who the resident runs as. Nothing was installed here.`);
    return 0;
  }
  if (shell) out(isolation);
  return { v: 1, shell };
}

async function installAndStart(
  ctx: CliContext & { root: string },
  world: SetupWorld,
  { dir, root, pkg, version, state, env, shell, stopped }: {
    dir: string; root: string; pkg: PackageJson; version: string; state: SetupState;
    env: Record<string, string | undefined>; shell: Record<string, string>; stopped: () => number;
  },
): Promise<number> {
  const { out, err } = ctx;
  const envFile = join(dir, '.env');
  const linger = world.lingerOf(world.user);
  if (linger === null && world.platform === 'linux') {
    out('This machine doesn\'t run systemd, so the resident can\'t run as a systemd user service here, the way its ' +
      'guide sets it up. Another service manager can run it: one that starts the install\'s start.js and restarts it ' +
      'when it exits with 75 or 1, as docs/DEPLOYMENTS.md in the host\'s package says.');
  }
  if (linger === false) {
    out(`Linger is off for ${world.user}, so a service of ${world.user}'s would stop when ${world.user} logs out, and ` +
      'the resident\'s service can\'t be set up until it\'s on. One line turns it on, run once ' +
      `${world.hasSudo ? 'with sudo, by you if you can use sudo here or by whoever administers this machine'
        : 'as root, by you or by whoever administers this machine'}:`);
    out(`  ${world.hasSudo ? 'sudo ' : ''}loginctl enable-linger ${world.user}`);
    const can = existsSync(join(root, 'install.json')) ||
      await yesNo(world, 'Can you run it, or have whoever administers this machine run it? (yes/no) ');
    if (can === null) return stopped();
    if (can) {
      out('Run it any time before the resident\'s service is set up, in a second terminal or by whoever runs it for ' +
        'you; setup goes on here meanwhile.');
    } else {
      out('Without it, the resident can\'t go live as a service. Setup\'s agent can still set up the rest with you, and ' +
        'the service waits until linger is on.');
      const go = await yesNo(world, 'Go on without it? (yes/no) ');
      if (go === null) return stopped();
      if (!go) {
        out('Setup stopped before installing anything, and keeps your answers. Once linger is on, run this same version ' +
          `of setup again here: \`${firstLine()}\`.`);
        return 0;
      }
    }
  } else if (world.platform === 'darwin') {
    out(`On macOS, a service of ${world.user}'s stops when ${world.user} logs out of the Mac's graphical session, not ` +
      'when an ssh session ends.');
  }

  if (bunBelowFloor(pkg.engines.bun, world.bun.version) === true) {
    err(`connectome-host ${version} needs Bun ${pkg.engines.bun.replace('>=', '')} or later, and this is Bun ` +
      `${world.bun.version}. \`bun upgrade\` upgrades it, or the package manager that installed it does; then run setup ` +
      'again.');
    return 1;
  }
  if (bunBelowFloor(SETUP_BUN_FLOOR, world.bun.version) === true) {
    err(`Setup needs Bun ${SETUP_BUN_FLOOR.replace('>=', '')} or later, whose \`bun add --no-env-file\` keeps .env's ` +
      `values from the packages' install scripts, and this is Bun ${world.bun.version}. \`bun upgrade\` upgrades it, or ` +
      'the package manager that installed it does; then run setup again.');
    return 1;
  }
  const programEnv = withoutKeys(env, []);
  const node = await world.run(['node', '--version'], { cwd: dir, env: programEnv });
  const nodeVersion = node.status === 0 ? node.stdout.trim().replace(/^v/, '') : null;
  const nodeFloor = pkg.engines.node.replace('>=', '');
  const getNode = `Install Node ${nodeFloor} or later${state.shell ? `, and at most Node ${SHELL_NODE_TOP}` : ''}, ` +
    'from nodejs.org or your system\'s package manager, and run setup again.';
  if (nodeVersion === null) {
    err(`connectome-host needs Node as well as Bun, and \`node --version\` didn't answer here ` +
      `(${node.startError?.code === 'ENOENT' ? 'there\'s no node on this PATH' : ended(node)}). ${getNode}`);
    return 1;
  }
  if (bunBelowFloor(pkg.engines.node, nodeVersion) !== false) {
    err(`connectome-host needs Node ${nodeFloor} or later, and this is Node ${nodeVersion}. ${getNode}`);
    return 1;
  }
  if (state.shell && Number(nodeVersion.split('.')[0]) > SHELL_NODE_TOP) {
    err(`The resident's shell, ${SERVERS.shell}, runs on Node ${SHELL_NODE_TOP} at most, and this is Node ` +
      `${nodeVersion}. ${getNode}`);
    return 1;
  }

  let record: InstallRecord | null;
  try {
    record = readRecord<InstallRecord>(join(root, 'install.json'), 'install record');
  } catch (error) {
    const why = (error as Error).message.replace(/\.+$/, '');
    const said = `${error instanceof ContractError ? why : `${join(root, 'install.json')} can't be read (${why})`}, so ` +
      'setup can\'t tell which data the install serves';
    let version: unknown;
    try {
      version = (JSON.parse(readFileSync(join(root, 'install.json'), 'utf-8')) as { v?: unknown } | null)?.v;
    } catch {
    }
    if (error instanceof ContractError && (version === undefined || version === 1)) {
      err(`${said}. ${WRITE_RECORD_AGAIN}`);
    } else {
      err(`${said}, and goes no further.`);
    }
    return 1;
  }
  let recorded: { record: InstallRecord; binding: Binding } | null = null;
  if (record !== null) {
    if (typeof record.dataDir !== 'string' || record.dataDir === '') {
      err(`The install record at ${join(root, 'install.json')} names no data directory, so setup can't tell which ` +
        `data the install serves. ${WRITE_RECORD_AGAIN}`);
      return 1;
    }
    try {
      recorded = { record, binding: bindingOf(root, record) };
    } catch (error) {
      err(`connectome setup: ${(error as Error).message}`);
      return 1;
    }
  }

  const trusted = await defaultTrusted(async (_manager, args, cwd) => {
    const ran = await world.run([world.bun.path, '--no-env-file', ...args], { cwd, env: programEnv });
    return { status: ran.status, output: `${ran.stdout}${ran.stderr}` };
  }, dir);
  const untrusted = Array.isArray(trusted)
    ? addTrusted(join(dir, 'package.json'), [...trusted, ...HOST_TRUSTED])
    : trusted.reason;
  if (untrusted !== null) {
    out(`Setup couldn't add the packages whose install scripts Bun runs by default to ${join(dir, 'package.json')} ` +
      `(${untrusted}), so unless it already names ${SERVERS.shell} among its trustedDependencies, Bun runs no install ` +
      `script of ${SERVERS.shell}'s, and through a mirror or a company ` +
      'registry it may run none of the others\'.');
  }

  // A package counts as installed once package.json declares it: a bun add that fails partway leaves packages in
  // node_modules that it never declares (probed with Bun 1.4.4).
  const declared = declaredDependencies(dir);
  const has = (name: string) => declared === null || declared.has(name) ? installedVersion(dir, name) : null;
  const wanted: string[] = [];
  if (has(PACKAGE) !== version) wanted.push(`${PACKAGE}@${version}`);
  if (has(SERVERS.discord) === null) wanted.push(SERVERS.discord);
  if (state.shell && has(SERVERS.shell) === null) wanted.push(SERVERS.shell);
  if (wanted.length > 0) {
    out(`Installing ${wanted.join(', ')} in ${dir}, with Bun:`);
    const added = await world.run([world.bun.path, '--no-env-file', 'add', ...wanted], { cwd: dir, env: programEnv, show: true });
    if (added.status !== 0) {
      err(`\`bun --no-env-file add ${wanted.join(' ')}\` didn't finish (${ended(added)}), so setup stops here.` +
        (added.status === null ? ' Run setup again to try once more.'
          : ' Its own lines above say why. Run setup again once that\'s put right.'));
      return 1;
    }
  }

  if (state.shell) {
    let helper = makeSpawnHelperExecutable(nodePtyDir(dir), world.platform);
    let pty = await ptyWorks(world, dir, programEnv);
    if (pty !== null) {
      const ptyDir = nodePtyDir(dir);
      const aside = join(dir, '.setup', 'node-pty-aside');
      out(`The resident's shell runs on node-pty, which doesn't work in ${dir} yet (${pty.replace(/\.+$/, '')}), so ` +
        `setup installs it again, keeping the copy it has at ${aside} until the new one has installed, and putting it ` +
        'back if it doesn\'t:');
      if (existsSync(aside)) rmSync(ptyDir, { recursive: true, force: true });
      else if (existsSync(ptyDir)) renameSync(ptyDir, aside);
      const again = await world.run([world.bun.path, '--no-env-file', 'install'], { cwd: dir, env: programEnv, show: true });
      if (again.status === 0) rmSync(aside, { recursive: true, force: true });
      else if (existsSync(aside)) {
        rmSync(ptyDir, { recursive: true, force: true });
        renameSync(aside, ptyDir);
      }
      if (again.status === 0) helper = makeSpawnHelperExecutable(nodePtyDir(dir), world.platform);
      pty = again.status === 0 ? await ptyWorks(world, dir, programEnv)
        : `\`bun --no-env-file install\` didn't finish (${ended(again)})`;
    }
    if (pty !== null) {
      const noShell = `Or, for a resident with no shell, remove ${join(dir, '.setup', 'setup-state.json')}, where ` +
        'setup keeps its answers, and run setup again to answer no.';
      const untrustedNote = untrusted === null ? '' : 'Setup couldn\'t add the packages whose install scripts Bun runs ' +
        `by default to ${join(dir, 'package.json')} (${untrusted}), so through a mirror or a company registry Bun may ` +
        'not have run node-pty\'s install script at all. ';
      const linux = world.platform !== 'linux' ? '' : 'On Linux, its native part is built as it\'s ' +
        'installed, with python3, make and a C++ compiler; on Debian and Ubuntu, ' +
        `\`${world.hasSudo ? 'sudo ' : ''}apt install build-essential python3\` installs them, run ` +
        `${world.hasSudo ? 'by you if you can use sudo here, or by whoever administers this machine'
          : 'as root, by you or by whoever administers this machine'}. Then run setup again, which installs node-pty ` +
        'again. ';
      const mac = world.platform !== 'darwin' ? '' : helper === null
        ? 'On macOS, node-pty runs from binaries it ships prebuilt rather than building them, and setup makes their ' +
          'spawn-helper executable after each install, which node-pty\'s own install doesn\'t. '
        : `On macOS, node-pty runs from binaries it ships prebuilt, whose spawn-helper has to be executable, and ` +
          `${helper}. Run setup again once that's put right, which installs node-pty again. `;
      err(`The resident's shell runs on node-pty, and here it doesn't work: ${pty.replace(/\.+$/, '')}. ` +
        `${world.platform === 'darwin' ? '' : untrustedNote}${linux}${mac}` +
        noShell);
      return 1;
    }
  }

  const settingUp = recorded === null;
  let dataDir: string;
  let placeArgs: string[] = [];
  if (recorded === null) {
    dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  } else {
    const bound = await bindingAnswers(world, root, recorded.record, recorded.binding, { out, err });
    if (typeof bound === 'number') return bound === -1 ? stopped() : bound;
    ({ dataDir, placeArgs } = bound);
  }
  const copySetup = join(dir, RELEASE_HOST, 'src', 'update', 'setup.ts');
  out(settingUp
    ? `Making ${root} an install that can take newer releases. Its first release is a copy of what's installed here. ` +
      'Making it can take a minute or more.'
    : `Checking the install at ${root}.`);
  const made = await world.run([world.bun.path, '--no-env-file', copySetup, '--root', root, ...placeArgs], {
    cwd: dir, env: { ...withoutKeys(env, ['CONNECTOME_INSTALL_ROOT']), DATA_DIR: dataDir },
  });
  if (made.status !== 0) {
    err(`The install's own setup (${copySetup}) didn't finish (${ended(made)}):`);
    for (const line of outputLines(made)) err(`  ${line}`);
    err('Once what the lines above say is put right, run setup again.');
    return 1;
  }
  for (const line of made.stdout.split('\n')) {
    if (line.startsWith(EXTRA_STATE_LINE)) break;
    if (line.trim() !== '') out(line);
  }
  const keptOutside = keptOutsideLines(made.stdout);

  const running = readCurrent(root);
  if (running === null) {
    err(`The install at ${root} has no current release after its own setup, so there's nothing to start. Run setup ` +
      'again: the install\'s own setup then says what to do.');
    return 1;
  }
  const release = releaseDir(root, running);
  const host = join(release, RELEASE_HOST);
  const entry = join(release, HOST_ENTRY);
  const setupRecipe = join(release, SETUP_RECIPE);
  const read = setupModel(setupRecipe);
  if (!('model' in read)) {
    if (read.damage === null && running !== version) {
      err(`The release this install runs, ${running}, has no setup agent: there's no ${setupRecipe}. Once the ` +
        `resident's host runs, its /update, in the TUI or the Web UI, updates it to a release that has one, such as ` +
        `${version}; then run setup again.`);
      return 1;
    }
    err(read.damage === null
      ? `The release this install runs, ${running}, is setup's own version, and its copy has no ${setupRecipe}: the ` +
        'copy is damaged.'
      : `${setupRecipe}, the setup agent's recipe in the release this install runs (${running}), ${read.damage}: the ` +
        'copy is damaged.');
    err(`Setup doesn't mend a release it made, so running it again stops here again. Report this, with this output, ` +
      `at ${pkg.bugs.url}.`);
    return 1;
  }
  const { model } = read;

  const command = installCommandOf(root, env.PATH);
  if (settingUp) {
    out(`This install's own command is ${command.path}.`);
    if (command.pathLine !== null) {
      const needs = 'Nothing setup or its agent does needs its directory on your PATH, so you need it there only to ' +
        'type plain `connectome`.';
      // The line is a Bourne shell's; other shells, such as fish and tcsh, set PATH their own way.
      if (env.SHELL === undefined || ['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(basename(env.SHELL))) {
        out(`${needs} For that, put it on your PATH, and in ${startupFile(env.SHELL, world.platform)} to keep it there:`);
        out(`  ${command.pathLine}`);
        out(`That line is for ${env.SHELL === undefined ? 'a Bourne shell, such as sh or bash, since SHELL names no shell'
          : `${basename(env.SHELL)}, the login shell SHELL names`}; another shell sets PATH its own way.`);
      } else {
        out(`${needs} For that, put ${root} at the front of your PATH as your shell sets it, and in its startup file to keep it there.`);
      }
    }
  }
  if (settingUp) {
    const typed = shellWord(command.path);
    out('Once the resident runs, these take a newer release, in turn: the first says whether one is out, the second ' +
      'installs it beside the one running, and the third switches the resident to it.');
    for (const word of ['update', 'update install', 'update restart']) out(`  ${typed} ${word}`);
  }

  out('Starting the installed host once, on a mock recipe, to see that it starts.');
  const scratch = mkdtempSync(join(tmpdir(), 'connectome-setup-boot-'));
  try {
    const recipe = join(scratch, 'boot.json');
    writeFileSync(recipe, JSON.stringify({
      name: 'setup boot check',
      agent: { name: 'boot', provider: 'mock', systemPrompt: 'Setup\'s boot check.' },
      modules: { wake: false, workspace: false, subscriptionGc: false },
    }));
    const boot = await world.run([world.bun.path, entry, recipe, '--no-tui'], {
      cwd: scratch, env: { ...withoutKeys(env, NOT_FOR_THE_AGENT), DATA_DIR: join(scratch, 'data') },
      timeoutMs: BOOT_TIMEOUT_MS,
    });
    if (boot.status !== 0) {
      err(boot.timedOut
        ? `The installed host (${running}, ${entry}) didn't finish booting on a mock recipe in batch mode within ` +
          `${BOOT_TIMEOUT_MS / 1000} s, so setup stopped it.`
        : `The installed host (${running}, ${entry}) doesn't start on a mock recipe in batch mode: ${ended(boot)}.`);
      for (const line of outputLines(boot)) err(`  ${line}`);
      err('Where the host\'s own lines above name something of this machine\'s, such as a file it can\'t read, put ' +
        'that right. Where they name the host\'s code or a package it brings, such as a module it can\'t find, ' +
        `that's for its makers: report them, with this output, at ${pkg.bugs.url}. Once what made its boot fail is ` +
        'put right, run setup again.');
      return 1;
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  out(`The installed host (${running}) starts.`);

  const stored = readEnvFile(envFile);
  const baseIn = (): string | undefined | null => {
    const url = readEnvFile(envFile).get('ANTHROPIC_BASE_URL') || undefined;
    if (url === undefined || originOf(url) !== null) return url;
    err(`ANTHROPIC_BASE_URL, in ${envFile}, isn't an http:// or https:// URL. Set it to one there, or take it out ` +
      'for Anthropic\'s own API, and run setup again.');
    return null;
  };
  let baseUrl = baseIn();
  if (baseUrl === null) return 1;
  const exportedWins = 'A host started from a shell that exports another takes the exported one, since Bun gives an ' +
    'exported variable precedence over .env.';
  if (shell.ANTHROPIC_BASE_URL !== undefined && (shell.ANTHROPIC_BASE_URL || undefined) !== baseUrl) {
    out(`Setup checks the key at, and gives its agent, ${baseUrl === undefined
      ? `Anthropic's own API, since ${envFile} sets no ANTHROPIC_BASE_URL`
      : `the ANTHROPIC_BASE_URL in ${envFile}, which leads to ${originOf(baseUrl)}`}, not the one exported in this ` +
      `shell. ${exportedWins} To use the exported one, put it in ${envFile}.`);
  }
  const storedKey = stored.get('ANTHROPIC_API_KEY') || undefined;
  let key: string | null = storedKey ?? null;
  let fromDotEnv = key !== null;
  if (key === null && shell.ANTHROPIC_API_KEY) {
    const use = await yesNo(world, `An ANTHROPIC_API_KEY is exported in this shell. Use it for setup's agent? Setup ` +
      `writes it to ${envFile}, readable by you alone. (yes/no) `);
    if (use === null) return stopped();
    if (use) key = shell.ANTHROPIC_API_KEY;
  }
  for (;;) {
    if (key === null) {
      key = await world.askHidden(`${baseUrl === undefined ? 'An Anthropic API key, from console.anthropic.com\'s API keys'
        : `An API key that ${originOf(baseUrl)} accepts`}, typed hidden (Enter alone stops setup)`);
      fromDotEnv = false;
      if (!key) return stopped();
    }
    const unwritable = unwritableValue(key);
    if (unwritable !== null) {
      err(fromDotEnv ? `The ANTHROPIC_API_KEY in ${envFile} can't be used: ${unwritable}.`
        : `That key can't be used: ${unwritable}. Check what was copied.`);
      key = null;
      fromDotEnv = false;
      continue;
    }
    try {
      baseUrl = baseIn();
    } catch (error) {
      err(`connectome setup: ${(error as Error).message}. Put that right, then run setup again.`);
      return 1;
    }
    if (baseUrl === null) return 1;
    out(`Checking ${fromDotEnv ? `the ANTHROPIC_API_KEY in ${envFile}` : 'the key'}: one call at ` +
      `${baseUrl === undefined ? ANTHROPIC_API : originOf(baseUrl)} to ${model}, the model setup's agent runs on, which ` +
      'the key\'s account has to be able to use.');
    const checked = await world.checkKey({ key, model, envFile, ...(baseUrl === undefined ? {} : { baseUrl }) });
    if (checked.ok) break;
    err(checked.cause);
    if (checked.anotherKeyMayHelp) {
      out('Type a key, this one again or another, or Enter alone to stop.');
      key = null;
      continue;
    }
    const again = await yesNo(world, 'Try this key again? (yes/no) ');
    if (!again) return stopped();
  }
  let held: Map<string, string>;
  try {
    const onDisk = lstatSync(envFile, { throwIfNoEntry: false });
    held = readEnvFile(envFile);
    if (held.get('ANTHROPIC_API_KEY') !== key || !onDisk?.isFile() || (onDisk.mode & 0o077) !== 0) {
      writeEnvValue(envFile, 'ANTHROPIC_API_KEY', key);
    }
  } catch (error) {
    err(`The key works, but setup couldn't make sure ${envFile} holds it: ${(error as Error).message}. So it starts no ` +
      'agent: put that right, and run setup again.');
    return 1;
  }
  out(`The key works, and it's in ${envFile}.`);
  if (shell.ANTHROPIC_API_KEY !== undefined && shell.ANTHROPIC_API_KEY !== key) {
    out(`The ANTHROPIC_API_KEY exported in this shell isn't the one setup checked and keeps in ${envFile}. ${exportedWins} ` +
      'Unset it in this shell, and in any other you start a host from, so that such a host doesn\'t take it.');
  }
  const oauth = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_CREDENTIALS_FILE'];
  const throughOAuth = 'signs in through OAuth, not with an ANTHROPIC_API_KEY, though setup\'s agent uses the key.';
  const exported = oauth.filter((name) => shell[name]);
  if (exported.length > 0) {
    out(`${exported.join(' and ')} ${exported.length === 1 ? 'is' : 'are'} exported in this shell, so a host started ` +
      `from it ${throughOAuth} Unset ${exported.length === 1 ? 'it' : 'them'} in any shell you start a host from, for ` +
      'such a host to use a key.');
  }
  const inEnv = oauth.filter((name) => held.get(name));
  if (inEnv.length > 0) {
    out(`${envFile} holds ${inEnv.join(' and ')}, so a host started in ${dir} ${throughOAuth} Take ` +
      `${inEnv.length === 1 ? 'it' : 'them'} out of ${envFile}, for such a host to use the key.`);
  }
  out(costLine(model, baseUrl !== undefined));

  const launch: AgentLaunch = {
    argv: [world.bun.path, '--no-env-file', entry, setupRecipe, '--no-tui'],
    cwd: join(dir, '.setup'),
    env: {
      ...withoutKeys(env, NOT_FOR_THE_AGENT),
      ANTHROPIC_API_KEY: key,
      ...(baseUrl === undefined ? {} : { ANTHROPIC_BASE_URL: baseUrl }),
      DATA_DIR: join(dir, '.setup'),
      CONNECTOME_SETUP_VERSION: running,
      CONNECTOME_SETUP_INSTALL: root,
      CONNECTOME_SETUP_DIR: dir,
      CONNECTOME_SETUP_SURFACE: 'Discord',
      CONNECTOME_SETUP_GUIDE: join(host, 'docs', 'AGENT-ONBOARDING.md'),
      CONNECTOME_SETUP_SHELL: state.shell ? 'gets a shell' : 'gets no shell',
      CONNECTOME_SETUP_USER: world.user,
      CONNECTOME_SETUP_COMMAND: shellWord(join(root, INSTALL_COMMAND)),
      CONNECTOME_UPDATE_CHECK: '0',
    },
  };
  out(commandsShownNote(dir));
  out(`Starting setup's agent. It speaks first. /quit leaves the conversation, and ` +
    `\`${shellWord(join(root, INSTALL_COMMAND))} setup ${SURFACE}\` picks it up where it stopped.`);
  const statePath = join(dir, '.setup', 'setup-state.json');
  const finishedAt = (read: KeptState) => 'state' in read ? read.state.finished : undefined;
  const before = finishedAt(readSetupState(statePath));
  const agentStatus = await world.startAgent(launch);
  const readAfter = readSetupState(statePath);
  const after = finishedAt(readAfter);
  const finished = after !== undefined && after !== before;
  out(finished
    ? `Setup is finished. To change something it set up, run setup again: \`${shellWord(join(root, INSTALL_COMMAND))} setup ${SURFACE}\`.`
    : `To go on with setup where it stopped: \`${shellWord(join(root, INSTALL_COMMAND))} setup ${SURFACE}\`.`);
  if (!('state' in readAfter)) {
    out(`Whether setup finished isn't known: ${statePath}, where setup keeps its answers, ` +
      `${'absent' in readAfter ? 'is gone' : `can't be read (${readAfter.unreadable})`}.`);
  }
  const printed = keptOutside.filter((line) => line.startsWith('  ') && line !== '  none').map((line) => line.slice(2));
  const recordPath = join(root, 'install.json');
  let why = '';
  try {
    const now = readRecord<InstallRecord>(recordPath, 'install record');
    if (now === null) why = `${recordPath}, the install record, is gone`;
    else if (!Array.isArray(now.extraState) || now.extraState.some((place) => typeof place !== 'string')) {
      why = `${recordPath}, the install record, holds no list of places under "extraState"`;
    } else if (now.extraState.length !== printed.length || printed.some((place, at) => now.extraState[at] !== place)) {
      why = `they changed during the conversation, and ${recordPath}, the install record, holds them now, under ` +
        '"extraState"';
    }
  } catch (error) {
    why = `${recordPath}, the install record, can't be read: ${(error as Error).message.replace(/\.+$/, '')}`;
  }
  if (why !== '') out(`The places outside the data directory that an update copies aren't listed here: ${why}.`);
  else if (printed.length > 0) for (const line of keptOutside) out(line);
  return agentStatus;
}

async function bindingAnswers(world: SetupWorld, root: string, record: InstallRecord, binding: Binding,
  { out, err }: Io): Promise<{ dataDir: string; placeArgs: string[] } | number> {
  if (binding.kind === 'bound') return { dataDir: record.dataDir, placeArgs: [] };
  if (binding.kind === 'resume') {
    out(`A setup run binding this install to ${binding.plan.to} was cut off before it finished. Setup finishes it from ` +
      'its plan, with the places that run was given, or says what stops it.');
    return { dataDir: binding.plan.record.dataDir, placeArgs: [] };
  }
  const { from, to, ask } = binding;
  let asking = binding;
  const answer = ask.length === 0 ? '' : ' Press Enter where a place is this install\'s, or type the path of this ' +
    'install\'s own, as after a copy.';
  out(from === null
    ? 'This install\'s record is from a release that didn\'t record which directory an install is in. Setup binds it ' +
      `here: each place under ${to}, other than inside another install's directory, stays as it is.` +
      (ask.length === 0 ? '' : ' It asks about each place outside it, or inside another install\'s directory ' +
        'within it, since it can\'t tell whether that came with the install, as after a move, or is still another ' +
        `install's, as after a copy. A place inside another goes with it.${answer}`)
    : `This install's record is bound to ${from}, and the install is in ${to}, so it was moved or copied here. Setup ` +
      `binds it here: each place under ${from} becomes the same place under ${to}.` +
      (ask.length === 0 ? '' : ` It asks about each place outside ${from}, since it can't tell whether that came ` +
        `with the install, as after a move, or is still the other install's, as after a copy. A place inside another ` +
        `goes with it.${answer}`));
  const places: Array<{ from: string; to: string }> = [];
  for (let place: Place | undefined = ask[0]; place !== undefined;
    place = asking.ask.find((one) => !places.some((given) => given.from === one.path))) {
    const what = place.data ? 'its data directory' : place.extra ? 'state kept outside its data directory'
      : 'a place its updates copy';
    for (;;) {
      const typed = await world.ask(`${place.path} (${what}${existsSync(place.path) ? '' : ', not there now'}): `);
      if (typed === null) return -1;
      const path = typed.trim();
      const home = homeDirectory(world.env.HOME);
      const given = path === '' ? place.path
        : resolve(dirname(root), home !== null && (path === '~' || path.startsWith('~/')) ? join(home, path.slice(1)) : path);
      if (place.data) {
        const data = mapPath(record.dataDir, { from: null, to, places: [{ from: place.path, to: given }] })!;
        if (!existsSync(data) || !statSync(data).isDirectory()) {
          out(`${data} isn't a directory, and the data directory has to be one that's there: type where this ` +
            'install\'s data is, or put it there first.');
          continue;
        }
      }
      places.push({ from: place.path, to: given });
      break;
    }
    if (place.data) {
      let again: Binding;
      try {
        again = bindingOf(root, record, places);
      } catch (error) {
        err(`connectome setup: ${(error as Error).message}`);
        return 1;
      }
      if (again.kind === 'bind') {
        asking = again;
        for (const given of places.filter((one) => !again.places.some((place) => place.path === one.from))) {
          const holder = again.places.find((place) => isUnder(given.from, place.path))?.path;
          if (holder !== undefined) {
            out(`${holder} holds ${given.from}, so the answer for ${holder} decides where ${given.from} is, in place ` +
              'of the one given for it.');
          }
        }
        places.splice(0, places.length, ...places.filter((given) => again.places.some((one) => one.path === given.from)));
      }
    }
  }
  return {
    dataDir: mapPath(record.dataDir, { from, to, places: [...places, ...asking.kept] })!,
    placeArgs: places.flatMap((place) => ['--place', place.from, place.to]),
  };
}

function takeSetupLock(file: string): { release(): void } | null {
  let db: Database | undefined;
  try {
    db = new Database(file, { create: true });
    db.exec('PRAGMA busy_timeout = 1000');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    db?.close();
    const { code, message } = error as { code?: string; message?: string };
    if (code === 'SQLITE_BUSY') return null;
    if (code === 'SQLITE_CANTOPEN') {
      throw new Error(`Setup can't make its lock, ${file} (SQLITE_CANTOPEN: ${message}). Check that this user can ` +
        `write to ${dirname(file)}, and can read and write ${file} if it's there, and that it isn't a directory, then ` +
        'run setup again.');
    }
    throw new Error(`${file} isn't a lock setup can take (${code ?? 'no code'}: ${message}). If no setup is running ` +
      'in this directory, take it away and run setup again.');
  }
  const held = db;
  return { release: () => held.close() };
}

// By name, since Bun puts in $NAME as it reads a dotenv file, so a value it read there needn't match the file's text.
function withoutDotEnv(env: Record<string, string | undefined>, cwd: string): Record<string, string | undefined> {
  const names = new Set(dotenvNames(cwd));
  return Object.fromEntries(Object.entries(env).filter(([name]) => !names.has(name)));
}

// Bun keeps an exported value over a dotenv file's, so a name the files give, holding a value none of them gives, was
// exported. A file's value can be built from such a name, so each name judged so is judged again with the others put
// back as exported, until none changes: a name the environment holds isn't read from the files, so each is judged
// without itself.
function exportedOf(given: Record<string, string | undefined>, rest: Record<string, string | undefined>, cwd: string):
  Record<string, string> {
  const fromFiles = dotenvValues(cwd, rest);
  const exported: Record<string, string> = {};
  let fileNamed: string[] = [];
  for (const [name, value] of Object.entries(given)) {
    if (value === undefined) continue;
    if (Object.hasOwn(rest, name)) exported[name] = value;
    else if (!fromFiles.get(name)?.has(value)) fileNamed.push(name);
  }
  for (let pass = 0, passes = fileNamed.length; pass < passes; pass++) {
    const kept = fileNamed.filter((name) => {
      const others = Object.fromEntries(fileNamed.filter((other) => other !== name).map((other) => [other, given[other]]));
      return !dotenvValues(cwd, { ...rest, ...others }).get(name)?.has(given[name]!);
    });
    if (kept.length === fileNamed.length) break;
    fileNamed = kept;
  }
  for (const name of fileNamed) exported[name] = given[name]!;
  return exported;
}

function setupModel(path: string): { model: string } | { damage: string | null } {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    return { damage: code === 'ENOENT' ? null : `can't be read (${code ?? (error as Error).message})` };
  }
  let recipe: { agent?: { model?: unknown } } | null;
  try {
    recipe = JSON.parse(text) as typeof recipe;
  } catch {
    return { damage: 'isn\'t JSON' };
  }
  const model = recipe?.agent?.model;
  return typeof model === 'string' && model !== '' ? { model } : { damage: 'names no agent.model' };
}

async function yesNo(world: SetupWorld, question: string): Promise<boolean | null> {
  for (;;) {
    const answer = await world.ask(question);
    if (answer === null) return null;
    const word = answer.trim().toLowerCase();
    if (word === 'yes' || word === 'y') return true;
    if (word === 'no' || word === 'n') return false;
  }
}

function ownUserPossible(world: SetupWorld): boolean {
  return world.platform === 'linux' && world.hasSudo && world.lingerOf(world.user) !== null;
}

async function pick(world: SetupWorld, question: string, fallback: '1' | '2' | null): Promise<'1' | '2' | null> {
  for (;;) {
    const answer = await world.ask(question);
    if (answer === null) return null;
    const word = answer.trim() || fallback;
    if (word === '1' || word === '2') return word;
  }
}

async function userName(world: SetupWorld, out: (line: string) => void): Promise<string | null> {
  for (;;) {
    const answer = await world.ask('Its user\'s name [connectome]: ');
    if (answer === null) return null;
    const name = answer.trim() || 'connectome';
    if (!USER_NAME.test(name)) {
      out('A user\'s name here is lowercase letters, digits, - and _, starting with a letter or _, at most 32.');
      continue;
    }
    const exists = world.userExists(name);
    if (exists === null) {
      out(`Setup couldn't check whether this machine already has a user named ${name}. The line below makes it only ` +
        'where there\'s none: where there is one, the resident runs as that account.');
    }
    if (exists !== true) return name;
    out(`This machine already has a user named ${name}, and the resident gets a user of its own, so choose a name no ` +
      `account here has. If an earlier line of setup's made ${name} for the resident, open a shell as ${name} and run ` +
      'setup there instead.');
  }
}

function addTrusted(file: string, names: string[]): string | null {
  let manifest: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return `${file} holds no JSON object`;
    manifest = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return `${file} can't be read (${(error as Error).message})`;
  }
  const held = Array.isArray(manifest.trustedDependencies)
    ? manifest.trustedDependencies.filter((name): name is string => typeof name === 'string') : [];
  const added = names.filter((name) => !held.includes(name));
  if (added.length === 0 && Array.isArray(manifest.trustedDependencies)) return null;
  manifest.trustedDependencies = [...held, ...added];
  try {
    const was = lstatSync(file, { throwIfNoEntry: false });
    writeTextAtomic(file, `${JSON.stringify(manifest, null, 2)}\n`, was?.isFile() ? was.mode & 0o777 : 0o644);
  } catch (error) {
    return `${file} can't be written (${(error as Error).message})`;
  }
  return null;
}

function declaredDependencies(dir: string): Set<string> | null {
  let text: string;
  try {
    text = readFileSync(join(dir, 'package.json'), 'utf-8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? new Set() : null;
  }
  try {
    const dependencies = (JSON.parse(text) as { dependencies?: unknown } | null)?.dependencies;
    return new Set(dependencies !== null && typeof dependencies === 'object' ? Object.keys(dependencies) : []);
  } catch {
    return null;
  }
}

const PTY_CHECK = "let p;try{p=require('module').createRequire(require('fs').realpathSync('node_modules/term-sessions-mcp')+'/package.json')('node-pty')" +
  ".spawn('/bin/echo',['pty-ok'],{})}catch(e){console.error(String(e.message)" +
  ".split('\\n')[0]);process.exit(1)}let o='';p.onData(d=>{o+=d});p.onExit(()=>{if(o.includes('pty-ok'))process.exit(0);" +
  "console.error('a pty it opened gave back nothing');process.exit(1)})";

async function ptyWorks(world: SetupWorld, dir: string, env: Record<string, string>): Promise<string | null> {
  const ran = await world.run(['node', '-e', PTY_CHECK], { cwd: dir, env, timeoutMs: 30_000 });
  if (ran.status === 0) return null;
  const said = `${ran.stderr}${ran.stdout}`.trim().split('\n').at(-1);
  return said ? said : `node exited without saying why (${ended(ran)})`;
}

function installedVersion(dir: string, name: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf-8')) as { version?: string })
      .version ?? null;
  } catch {
    return null;
  }
}

function withoutKeys(env: Record<string, string | undefined>, keys: string[]): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined && !keys.includes(name)) kept[name] = value;
  return kept;
}

function ended(ran: Ran): string {
  if (ran.startError) return `it couldn't be started (${ran.startError.message})`;
  if (ran.signal) return `it was ended by ${ran.signal}`;
  return `exit ${ran.status}`;
}

function outputLines(ran: Ran): string[] {
  return `${ran.stdout}\n${ran.stderr}`.split('\n').filter((line) => line.trim() !== '');
}

function dollars(amount: number): string {
  return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}

function startupFile(shell: string | undefined, platform: NodeJS.Platform): string {
  const name = shell === undefined ? '' : basename(shell);
  if (name === 'zsh') return '~/.zshrc';
  if (name === 'bash') return platform === 'darwin' ? '~/.bash_profile' : '~/.bashrc';
  return 'your shell\'s startup file';
}

export function costLine(model: string, gateway: boolean): string {
  const zero = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0,
    unclassifiedCacheWriteTokens: 0,
  };
  const priced = priceAnthropicCall(model, new Date().toISOString(), zero);
  const length = 'How many turns a setup takes isn\'t measured yet, so neither is what one costs.';
  if (priced === undefined) return `Setup's agent runs on ${model}, which this host has no prices for. ${length}`;
  const { rates } = priced;
  const cost = (tokens: WalkTokens) => priceAnthropicCall(model, new Date().toISOString(), {
    ...zero, inputTokens: tokens.input, outputTokens: tokens.output, cacheReadTokens: tokens.cacheRead,
    cacheWrite1hTokens: tokens.cacheWrite,
  })?.total ?? 0;
  const walks = model === WALKS_MODEL
    ? `In five test setups, with a tester playing the person, setup's agent cost between ${dollars(cost(CHEAPEST_TEST_SETUP))} ` +
      `and ${dollars(cost(COSTLIEST_TEST_SETUP))} each at these prices; the higher figure includes the new resident's first calls, ` +
      'which couldn\'t be told apart from setup\'s.'
    : length;
  // agent-framework's Agent caches for an hour when its config sets no cacheTtl, as setup.json's doesn't.
  return `Setup's agent runs on ${model}, at Anthropic's list prices per million tokens: ` +
    `${dollars(rates.inputPerMillion)} input, ${dollars(rates.outputPerMillion)} output, ` +
    `${dollars(rates.cacheWrite1hPerMillion)} written to the prompt cache, which keeps it an hour, and ` +
    `${dollars(rates.cacheReadPerMillion)} read from it (${priced.pricingVersion}).` +
    `${gateway ? ' A gateway at ANTHROPIC_BASE_URL may charge otherwise.' : ''} ${walks}`;
}

interface WalkTokens { input: number; output: number; cacheRead: number; cacheWrite: number }

const WALKS_MODEL = 'claude-opus-5-5';

const CHEAPEST_TEST_SETUP: WalkTokens = { input: 27505, output: 6594, cacheRead: 208026, cacheWrite: 20223 };
const COSTLIEST_TEST_SETUP: WalkTokens = { input: 199250, output: 27589, cacheRead: 1854547, cacheWrite: 122949 };

export function realWorld(): SetupWorld {
  // One interface a question: readline holds the terminal raw while it's open, so Ctrl-C between questions, as
  // during an install, reaches setup as a signal.
  const question = async (asking: (rl: Interface) => Promise<string>): Promise<string | null> => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const gone = new Promise<null>((done) => rl.once('close', () => done(null)));
    try {
      return await Promise.race([asking(rl), gone]);
    } finally {
      rl.close();
    }
  };
  return {
    terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    platform: process.platform,
    user: userInfo().username,
    env: process.env,
    cwd: process.cwd(),
    execArgv: process.execArgv,
    bun: { path: process.execPath, version: Bun.version },
    hasSudo: Bun.which('sudo') !== null,
    lingerOf: (user) => lingerOf(user),
    userExists: (user) => {
      const found = spawnSync('getent', ['passwd', user], { stdio: 'ignore', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
      return found.status === 0 ? true : found.status === 2 ? false : null;
    },
    ask: (text) => question((rl) => new Promise((done) => rl.question(text, done))),
    askHidden: (label) => question((rl) => askHiddenOn(rl, process.stdout, label)),
    run: runProgram,
    checkKey,
    startAgent,
  };
}

function runProgram(argv: string[], options: RunOptions): Promise<Ran> {
  return new Promise((done) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd, env: options.env, stdio: ['ignore', options.show ? 'inherit' : 'pipe', options.show ? 'inherit' : 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    let timedOut = false;
    const limit = options.timeoutMs === undefined ? null : setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, options.timeoutMs);
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (limit) clearTimeout(limit);
      done({ status: null, stdout, stderr, startError: { code: error.code, message: error.message } });
    });
    child.on('close', (code, signal) => {
      if (limit) clearTimeout(limit);
      done({
        status: timedOut ? null : code, stdout, stderr,
        ...(timedOut ? { timedOut } : signal === null ? {} : { signal }),
      });
    });
  });
}

function startAgent(launch: AgentLaunch): Promise<number> {
  return new Promise((done) => {
    // The terminal's Ctrl-C reaches every process in its foreground group, this one too.
    const keep = () => {};
    process.on('SIGINT', keep);
    const child = spawn(launch.argv[0]!, launch.argv.slice(1), { cwd: launch.cwd, env: launch.env, stdio: 'inherit' });
    child.on('error', (error) => {
      process.off('SIGINT', keep);
      process.stderr.write(`connectome setup: the agent's host couldn't be started: ${error.message}\n`);
      done(1);
    });
    child.on('close', (code, signal) => {
      process.off('SIGINT', keep);
      if (signal !== null) {
        process.stderr.write(`connectome setup: the agent's host was ended by ${signal}. Setup's answers and key are kept, ` +
          'so running setup again in this directory goes on.\n');
      }
      done(code ?? (signal === null ? 1 : 128 + (constants.signals[signal] ?? 0)));
    });
  });
}
