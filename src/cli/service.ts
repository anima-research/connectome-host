import { randomBytes } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, type Stats,
} from 'node:fs';
import { createServer } from 'node:net';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { ContractError, RESTART_EXIT_CODE, SUPERVISED_ENV, writeTextAtomic } from '../update/contract.js';
import { shellWord } from '../update/launcher.js';
import { lingerOf } from '../setup/linger.js';
import { StoredSecrets, envForm, envLink, readEnvFile, writeEnvValue } from '../setup/secrets.js';
import { readRecipeDocument } from '../recipe-document.js';
import { dataDirOf, openHost, socketOf, type HostClient, type HostReady, type NoHost } from './host-socket.js';
import type { CliCommand, CliContext } from './connectome.js';
import { INSTALL_COMMAND, typedCommand } from './install-command.js';
import { RESTART_PROPERTIES, restartPolicy, systemdUnits } from '../update/systemd-units.js';
import { lastingPath, lookup, serviceBun, type BunLookup } from '../update/service-bun.js';
import {
  type ManagerSystem, agentState, childEnv, fileDirectory, launchctlFailure, ownerOf, readOr, runsFrom, runsHere, showUnit, stateOf, stderrOf, systemctlLine,
} from './service-manager.js';
import { Refusal, plain, plist, serviceUnits, systemdUnit, type Manager, type ServiceUnit } from './service-unit.js';
import { shownToPerson } from './shown.js';

const SHELL_PACKAGE = 'term-sessions-mcp';
const SHELL_BIN = 'session-server';
// term-sessions-mcp's own default port is 3100. Picked ports stay below the platforms' default ephemeral ranges, from
// which the kernel hands out ports for outgoing connections: Linux's from 32768 (ip_local_port_range), macOS's from
// 49152 (net.inet.ip.portrange.first).
const SHELL_PORTS = { first: 3100, last: 32767 };
const SHELL_CLIENT = /(?:^|[/\\\s])(?:terminal-sessions-mcp|term-sessions-mcp)(?:$|[@/\\\s])/;
const SHELL_SETTINGS = ['SESSION_SERVER_TOKEN', 'SESSION_SERVER_PORT'];
// Keep this how long install holds a person before saying its host hasn't answered, not how long a start can take.
const READY_WAIT_MS = 60_000;
// launchctl print shows `exit timeout = 5` for an agent plist() writes, on macOS 26.
const EXIT_TIMEOUT_S = 5;
const UNLOAD_POLL_MS = 100;
const serviceUsage = (cmd: string) => `${cmd} service install <recipe>`;
// Keep this install's own: a unit in one of these states has its process up, or coming up.
const RUNNING = new Set(['active', 'activating', 'reloading']);

export interface ServiceSystem extends ManagerSystem, BunLookup {
  user: string;
  cwd: string;
  bun: string;
  owner(path: string): number;
  cgroup(): string | null;
  readRecipe(recipe: string): Promise<unknown>;
  linger(user: string): boolean | null;
  portFree(port: number): Promise<boolean>;
  openHost(root: string, waitMs?: number): Promise<HostClient | NoHost>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export function machine(): ServiceSystem {
  return {
    platform: process.platform,
    get user() {
      return userInfo().username;
    },
    uid: process.getuid?.() ?? -1,
    home: homedir(),
    get cwd() {
      return process.cwd();
    },
    env: process.env,
    bun: process.execPath,
    owner: (path) => statSync(path).uid,
    cgroup: () => {
      try {
        return readFileSync('/proc/self/cgroup', 'utf-8');
      } catch {
        return null;
      }
    },
    which: lookup.which,
    realpath: lookup.realpath,
    run: (command, args, env) => {
      try {
        const ran = Bun.spawnSync([command, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
        return { status: ran.exitCode, stdout: ran.stdout.toString(), stderr: ran.stderr.toString() };
      } catch (error) {
        return { status: null, stdout: '', stderr: errorText(error) };
      }
    },
    readRecipe: async (recipe) => (await readRecipeDocument(recipe)).raw,
    linger: (user) => lingerOf(user),
    portFree,
    openHost,
    sleep: (ms) => Bun.sleep(ms),
    now: () => performance.now(),
  };
}

export async function portFree(port: number): Promise<boolean> {
  for (const host of ['127.0.0.1', '::1']) {
    const free = await new Promise<boolean>((done) => {
      const server = createServer();
      // A system without IPv6 has no ::1 for anything to hold the port on.
      server.once('error', (error: NodeJS.ErrnoException) =>
        done(host === '::1' && (error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT')));
      server.listen(port, host, () => server.close(() => done(true)));
    });
    if (!free) return false;
  }
  return true;
}

export function recipeHasShell(raw: unknown): boolean {
  if (SHELL_SETTINGS.some((name) => JSON.stringify(raw ?? null).includes(name))) return true;
  const servers = (raw as { mcpServers?: unknown } | null)?.mcpServers;
  if (servers === null || typeof servers !== 'object') return false;
  return Object.values(servers).some((server) => {
    const { command, args } = (server ?? {}) as { command?: unknown; args?: unknown };
    return [command, ...(Array.isArray(args) ? args : [])].some((word) => typeof word === 'string' && SHELL_CLIENT.test(word));
  });
}

export const serviceCommand: CliCommand = {
  name: 'service',
  usage: serviceUsage(INSTALL_COMMAND),
  summary: 'Sets up this install\'s service.',
  words: [
    'install: writes this install\'s service for the recipe, starts it, and waits for its host to answer. Run ' +
      'again, it writes the service again and restarts it.',
  ],
  run: (ctx) => runService(ctx),
};

export async function runService(given: CliContext, sys: ServiceSystem = machine()): Promise<number> {
  const ctx = shownToPerson(given, sys.env);
  const [verb, ...rest] = ctx.argv;
  if (verb === 'install' && rest.length === 1) return installService(ctx, sys);
  ctx.err(`Usage: ${serviceUsage(typedCommand(ctx.root!, sys.env.PATH))}`);
  return 2;
}

export async function installService(ctx: CliContext, sys: ServiceSystem = machine()): Promise<number> {
  const root = ctx.root!;
  const given = ctx.argv[1]!;
  const cmd = typedCommand(root, sys.env.PATH);
  try {
    const recipe = /^https?:\/\//.test(given) ? given : resolve(sys.cwd, given);
    return await install(ctx, sys, root, recipe, cmd);
  } catch (error) {
    ctx.err(`connectome: ${error instanceof Refusal || error instanceof ContractError ? error.message
      : `Service command failed: ${errorText(error)}. Files or units may already have changed. ` +
        "Inspect this install's files and service-manager state, resolve the error, then repeat this command."}`);
    return 1;
  }
}

interface ShellPlan {
  bin: string;
  port: string;
  token: string;
  newPort: boolean;
  newToken: boolean;
}

async function install(ctx: CliContext, sys: ServiceSystem, root: string, recipe: string, cmd: string): Promise<number> {
  plain(recipe, 'the recipe');
  const work = dirname(root);
  if (!/^https?:\/\//.test(recipe)) {
    let stat: Stats | undefined;
    try {
      stat = statSync(recipe);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Refusal(`the recipe at ${recipe} can't be read: ${errorText(error)}. Nothing was written.`);
      }
    }
    if (stat === undefined || !stat.isFile()) throw new Refusal(`there's no recipe at ${recipe}.`);
  }
  const owner = sys.owner(work);
  if (sys.uid === 0 && owner !== 0) {
    throw new Refusal(`${work} belongs to uid ${owner}, and this runs as root, so its service would run the resident as ` +
      `root on files uid ${owner} can change. Run this command as the user who owns ${work}, without sudo. Nothing was ` +
      'written.');
  }
  const manager = managerOf(sys);
  if (manager === 'launchd') {
    const domain = sys.run('launchctl', ['print', `gui/${sys.uid}`], childEnv(sys));
    if (domain.status !== 0) {
      throw new Refusal(`launchctl print gui/${sys.uid} failed: ${launchctlFailure(domain)}. launchd loads this ` +
        `service's agents, which name no session type, only once ${sys.user} has logged in to the Mac's graphical ` +
        `session. Repeat this command once ${sys.user} is logged in to it. Nothing was written.`);
    }
  }
  const names = serviceUnits(root, sys.platform, sys.home);
  if (names === null) {
    throw new Refusal(`a service's name comes from its working directory's name, and ${basename(work)} has no letter ` +
      `or digit to make one from, so nothing was written. Set this resident up again in a directory whose name has one.`);
  }
  const dataDir = dataDirOf(root);
  let raw: unknown;
  try {
    raw = await sys.readRecipe(recipe);
  } catch (error) {
    throw new Refusal(`the recipe can't be read: ${errorText(error).replace(/\.+$/, '')}. Nothing was written.`);
  }
  const wantsShell = recipeHasShell(raw);
  const shellBin = wantsShell ? shellOf(work, sys) : null;
  const units = shellBin === null ? [names.host] : [names.shell, names.host];
  insideNeither(sys, manager, names, units, cmd);
  const env = childEnv(sys);
  for (const unit of [names.shell, names.host]) ownedOrFree(unit, manager, work, sys, env);
  if (manager === 'systemd-user') noOtherUnit(ctx, work, names, sys, env);
  await noOtherHost(root, dataDir, manager, names.host, sys, env);
  const envFile = join(work, '.env');
  if (shellBin !== null) {
    const link = envLink(envFile);
    if (link !== null) {
      throw new Refusal(`${link.message}. Replace the link with the file it leads to, if that's there, or take it away, ` +
        'then repeat this service install command with the same recipe. Nothing was written.');
    }
    let outside: Error | null;
    try {
      outside = envForm(envFile);
    } catch (error) {
      throw new Refusal(`${errorText(error)}. Nothing was written.`);
    }
    if (outside !== null) {
      throw new Refusal(`${outside.message}. Then repeat this service install command with the same recipe. ` +
        'Nothing was written.');
    }
  }
  const shell = shellBin === null ? null : await shellPlan(sys, work, shellBin);
  if (shell !== null) {
    if (!shell.newPort && !(await sys.portFree(Number(shell.port))) && !shellRuns(sys, manager, env, names.shell)) {
      throw new Refusal(`SESSION_SERVER_PORT in ${envFile} is ${shell.port}. Something is listening on it, and ` +
        `${manager === 'launchd' ? 'launchd' : 'systemd'} doesn't show this install's shell daemon, ${names.shell.name}, ` +
        'running, as when another install took that port while this one was down. This install\'s shell clients would ' +
        `reach that listener, with ${shell.newToken ? 'a new' : 'the stored'} token. Give this install a port of its own ` +
        `as SESSION_SERVER_PORT in ${envFile}, or take that line away to have one picked, then repeat this service ` +
        'install command. Nothing was written.');
    }
    if (!shell.newPort || !shell.newToken) {
      const kept = [...(shell.newPort ? [] : [`SESSION_SERVER_PORT ${shell.port}`]),
        ...(shell.newToken ? [] : ['SESSION_SERVER_TOKEN, not shown'])];
      ctx.out(`The shell daemon uses ${kept.join(' and ')}, as ${envFile} holds ${kept.length === 1 ? 'it' : 'them'}.`);
    }
  } else if (wantsShell) {
    ctx.out("The recipe names a shell client or setting, but term-sessions-mcp isn't installed in this directory, " +
      `so this run sets up no shell daemon. To set one up, run ${cmd} shell install, then this service install command ` +
      'again with the same recipe.');
  } else {
    ctx.out('This run sets up no shell daemon: the recipe names no shell client or shell setting.');
  }

  const lasting = lastingPath(sys.env.PATH ?? '', sys.bun, sys);
  const bun = serviceBun(sys.bun, lasting, sys);
  const node = sys.which('node', lasting);
  const path = [...new Set([dirname(bun), ...(node ? [dirname(node)] : []),
    ...lasting.split(':').filter((entry) => isAbsolute(entry)),
    '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
  const logPath = join(work, 'logs', 'agent.log');
  const hostVars: Array<[string, string]> = [['PATH', path], ['DATA_DIR', dataDir]];
  const hostArgv = [bun, join(root, 'start.js'), recipe, '--headless'];
  const shellArgv = shell === null ? [] : [node!, shell.bin, '--host', 'localhost', '--headless'];
  const shellVars: Array<[string, string]> = shell === null ? []
    : [['PATH', path], ['SESSION_SERVER_PORT', shell.port], ['SESSION_SERVER_TOKEN', shell.token]];
  const wants = shell === null ? null : names.shell.name;
  const texts = manager === 'systemd-user'
    ? {
      shell: shell === null ? null
        : systemdUnit(`connectome-host resident's shell daemon in ${work}`, work, shellArgv, shellVars, null),
      host: systemdUnit(`connectome-host resident in ${work}`, work, hostArgv, hostVars, wants, 'mixed'),
      supervised: systemdUnit(`connectome-host resident in ${work}`, work, hostArgv,
        [...hostVars, [SUPERVISED_ENV, '1']], wants, 'mixed'),
    }
    : {
      shell: shell === null ? null : plist(names.shell.name, work, shellArgv, shellVars, join(work, 'logs', 'shell.log')),
      host: plist(names.host.name, work, hostArgv, [...hostVars, [SUPERVISED_ENV, '1']], logPath),
      supervised: '',
    };
  const writeUnit = (unit: ServiceUnit, text: string) => {
    try {
      writeText(unit.file, text);
    } catch (error) {
      throw new Refusal(`${unit.file} can't be written: ${errorText(error)}. Nothing was started or restarted.`);
    }
  };
  if (shell !== null) keepShellSettings(ctx, sys, work, shell);
  const shellLive = () => ctx.out(`With a shell, the resident can read and change whatever ${sys.user} can, and ` +
    'whoever talks to it on Discord can ask it to.');
  let shellStart: string | undefined;
  if (manager === 'systemd-user') {
    if (texts.shell !== null) {
      writeUnit(names.shell, texts.shell);
      ctx.out(`Wrote ${names.shell.file}, the resident's shell daemon's unit.`);
    }
    writeUnit(names.host, texts.host);
    systemctl(sys, env, ['daemon-reload']);
    const loaded = showUnit(sys, env, names.host.name, ['LoadState', 'WorkingDirectory', RESTART_PROPERTIES]);
    if (typeof loaded === 'string') throw new Refusal(`${loaded}. Nothing was started.`);
    if (loaded.get('LoadState') !== 'loaded' || !runsHere(runsFrom(loaded.get('WorkingDirectory') ?? '', sys.home), work)) {
      throw new Refusal(`systemd doesn't show ${names.host.name} loaded with ${work} as its working directory ` +
        `(it shows ${loaded.get('LoadState') || 'no load state'}, in ` +
        `${loaded.get('WorkingDirectory') || 'no set directory'}), so whether it restarts the host can't be checked. ` +
        'Nothing was started.');
    }
    const policy = restartPolicy(loaded);
    if (!policy.restarts) {
      throw new Refusal(`systemd shows ${names.host.name} with ${policy.settings}, so it doesn't restart the host both ` +
        `when it exits with ${RESTART_EXIT_CODE}, as an update's restart does, and with 1, as a failed update does. A ` +
        `drop-in may override the unit: ${systemctlLine(sys, `cat ${names.host.name}`)} shows every file it's read ` +
        `from. Its unit is left without ${SUPERVISED_ENV}=1, and nothing was started or restarted. A host it runs ` +
        `now keeps what it started with, ${SUPERVISED_ENV}=1 included if it started with it, until it starts again: ` +
        `${systemctlLine(sys, `restart ${names.host.name}`)} restarts it on the unit as it is now: the file this run ` +
        `wrote, with the recipe it was given, and any drop-in over it. Once the unit ` +
        `restarts the host on ${RESTART_EXIT_CODE} and 1, repeat this service install command with the same recipe, ` +
        'which sets the line.');
    }
    writeUnit(names.host, texts.supervised);
    systemctl(sys, env, ['daemon-reload']);
    ctx.out(`Wrote ${names.host.file}. systemd restarts it when the host exits with ${RESTART_EXIT_CODE} and with 1 ` +
      `(${policy.settings}), so its unit sets ${SUPERVISED_ENV}=1.`);
    systemctl(sys, env, ['enable', ...units.map((unit) => unit.name)]);
    ctx.out(`Enabled ${units.map((unit) => unit.name).join(' and ')}, so systemd starts ` +
      `${units.length === 1 ? 'it' : 'them'} at boot.`);
    systemctl(sys, env, ['reset-failed', ...units.map((unit) => unit.name)]);
    let shellUp = false;
    const sofar = () => `The units' files are written and enabled${shellUp ? `, and ${names.shell.name} is started` : ''}. ` +
      'The host\'s unit isn\'t started or restarted by this run.';
    for (const unit of units) {
      const shown = showUnit(sys, env, unit.name, ['ActiveState']);
      if (typeof shown === 'string') throw new Refusal(`${shown}. ${sofar()}`);
      const running = RUNNING.has(shown.get('ActiveState') ?? '');
      systemctl(sys, env, ['restart', unit.name]);
      ctx.out(running ? `Restarted ${unit.name}.` : `Started ${unit.name}.`);
      if (unit === names.shell) {
        shellUp = true;
        shellLive();
        const started = showUnit(sys, env, unit.name, ['InvocationID']);
        if (typeof started === 'string') throw new Refusal(`${started}. ${sofar()}`);
        shellStart = started.get('InvocationID') ?? '';
      }
    }
  } else {
    mkdirSync(dirname(logPath), { recursive: true });
    chmodSync(dirname(logPath), 0o700);
    if (texts.shell !== null) writeUnit(names.shell, texts.shell);
    writeUnit(names.host, texts.host);
    ctx.out(`KeepAlive restarts the host whenever it exits other than with 0, so its launch agent sets ${SUPERVISED_ENV}=1.`);
    for (const unit of units) {
      const stateBefore = agentState(sys, env, unit);
      const loaded = stateBefore.kind === 'running' || stateBefore.kind === 'loaded';
      if (loaded) await bootout(ctx, sys, env, unit,
        'Repeat this service install command with the same recipe to load its rewritten agents.');
      ownedOrFree(unit, manager, work, sys, env, loaded ? `${unit.name} was already unloaded. ` : '');
      const ran = sys.run('launchctl', ['bootstrap', `gui/${sys.uid}`, unit.file], env);
      if (ran.status !== 0) {
        const state = agentState(sys, env, unit);
        const subject = unit === names.host ? "resident's service" : "resident's shell daemon";
        const consequence = state.kind === 'running'
          ? `The ${subject} is running: launchd shows pid ${state.pid}.`
          : state.kind === 'unknown'
            ? `Whether the ${subject} is running can't be told: launchctl list ${unit.name} failed: ${state.why}.`
            : `The ${subject} isn't running now.`;
        const host = unit === names.host ? '' : " This run hasn't started or restarted the resident's service.";
        throw new Refusal(`launchctl bootstrap gui/${sys.uid} ${unit.file} failed: ${launchctlFailure(ran)}. ` +
          `${consequence}${host} Repeat this service install command with the same recipe to load it.`);
      }
      ctx.out(`${loaded ? 'Reloaded' : 'Loaded'} ${unit.name} from ${unit.file}.`);
      if (unit === names.shell) {
        shellLive();
        const started = agentState(sys, env, unit);
        shellStart = started.kind === 'running' ? started.pid : undefined;
      }
    }
    ctx.out(`launchd loads ${units.length === 1 ? 'this agent' : 'these agents'}, and so starts ` +
      `${units.length === 1 ? 'it' : 'them'}, each time ${sys.user} logs in to the Mac's graphical session.`);
  }

  ctx.out(`Waiting up to ${READY_WAIT_MS / 1000} s for its host to answer.`);
  const ready = await awaitReady(root, manager, names.host, sys, env);
  const commands = serviceCommands(root, sys);
  const log = commands === null ? '' : `: ${commands.log}`;
  if (typeof ready === 'string') {
    ctx.err(`connectome: ${ready}`);
    ctx.out(`Its log shows what happened${log}. Put that right, then run ${cmd} service ` +
      `install ${shellWord(recipe)} again. Until then ${manager === 'systemd-user'
      ? 'systemd restarts the host each time it fails, while it has its unit loaded and its start limit allows; the ' +
        'run clears that limit'
      : 'launchd starts the host again each time it exits other than with 0, while it has its agent loaded'}.`);
  } else if ('late' in ready) {
    ctx.err(`connectome: ${ready.late}`);
    ctx.out(`Its log shows how its start is going${log}.`);
  }
  const answered = typeof ready === 'string' || 'late' in ready ? null : ready;
  let lost: string | null = null;
  if (answered !== null) {
    ctx.out(`Its host answers: pid ${answered.pid}, recipe ${answered.recipe}.`);
    if (shellBin === null) await removeShell(ctx, sys, env, manager, names.shell, work);
    else lost = shellLost(sys, env, manager, names.shell, shellStart);
  }
  if (lost !== null) {
    ctx.err(`connectome: ${lost} Its log shows what happened: ${manager === 'systemd-user'
      ? `journalctl --user -u ${names.shell.name} -f` : `tail -f ${shellWord(join(work, 'logs', 'shell.log'))}`}. ` +
      `Put that right, then run ${cmd} service install ${shellWord(recipe)} again.`);
  }
  for (const line of serviceLines(root, sys) ?? []) ctx.out(line);
  return answered === null || lost !== null ? 1 : 0;
}

function shellLost(sys: ServiceSystem, env: Record<string, string>, manager: Manager, unit: ServiceUnit,
  started: string | undefined): string | null {
  const daemon = `the resident's shell daemon, ${unit.name},`;
  if (manager === 'systemd-user') {
    const shown = showUnit(sys, env, unit.name, ['ActiveState', 'SubState', 'InvocationID']);
    if (typeof shown === 'string') return `whether ${daemon} still runs can't be told: ${shown}.`;
    const again = shown.get('InvocationID') !== started;
    if (RUNNING.has(shown.get('ActiveState') ?? '') && !again) return null;
    return `${daemon} didn't stay up after this run started it: systemd shows it ${stateOf(shown)}` +
      `${again ? ', in a later start than this run\'s' : ''}.`;
  }
  const state = agentState(sys, env, unit);
  if (state.kind === 'unknown') return `whether ${daemon} still runs can't be told: launchctl list ${unit.name} failed: ${state.why}.`;
  if (state.kind === 'running' && (started === undefined || state.pid === started)) return null;
  return `${daemon} didn't stay up after this run started it: launchd shows it ${state.kind === 'running'
    ? `running as pid ${state.pid}, where this run started pid ${started}` : 'not running'}.`;
}

async function noOtherHost(root: string, dataDir: string, manager: Manager, unit: ServiceUnit, sys: ServiceSystem,
  env: Record<string, string>): Promise<void> {
  let host: HostClient | NoHost;
  try {
    host = await sys.openHost(root);
  } catch (error) {
    throw new Refusal(`whether a host already serves ${dataDir} can't be told: ${errorText(error)}. Nothing was written.`);
  }
  if ('reason' in host) {
    if (host.down) return;
    throw new Refusal(`whether a host already serves ${dataDir} can't be told: ${host.reason}. Nothing was written. ` +
      'Once that is put right, repeat this service install command with the same recipe.');
  }
  const answering = String(host.ready.pid);
  host.close();
  if (answering === mainPid(manager, unit, sys, env)) return;
  throw new Refusal(`a host already serves ${dataDir}, on ${socketOf(root)}: pid ${answering}, which ${unit.name} ` +
    "doesn't run. A second host there would stop at its store's lock. Stop that host, and whatever starts it again, " +
    'then repeat this service install command with the same recipe. Nothing was written.');
}

function mainPid(manager: Manager, unit: ServiceUnit, sys: ServiceSystem, env: Record<string, string>): string {
  if (manager === 'systemd-user') {
    const shown = showUnit(sys, env, unit.name, ['MainPID']);
    if (typeof shown === 'string') throw new Refusal(`${shown}. Nothing was written.`);
    return shown.get('MainPID') ?? '0';
  }
  const state = agentState(sys, env, unit);
  if (state.kind === 'unknown') {
    throw new Refusal(`whether ${unit.name} runs the host that answers can't be told: ${state.why}. Nothing was written.`);
  }
  return state.kind === 'running' ? state.pid : '0';
}

export interface ServiceCommands {
  manager: Manager;
  units: ServiceUnit[];
  log: string;
  stop: string;
  start: string;
}

export function serviceCommands(root: string, sys: ServiceSystem = machine()): ServiceCommands | null {
  const names = serviceUnits(root, sys.platform, sys.home);
  if (names === null || !isFile(names.host.file) || !mayRunHere(sys, names.manager, names.host, names.work)) return null;
  const units = isFile(names.shell.file) && mayRunHere(sys, names.manager, names.shell, names.work)
    ? [names.shell, names.host] : [names.host];
  if (names.manager === 'systemd-user') {
    const ids = units.map((unit) => unit.name).join(' ');
    return { manager: names.manager, units, log: `journalctl --user -u ${names.host.name} -f`,
      stop: systemctlLine(sys, `stop ${ids}`), start: systemctlLine(sys, `start ${ids}`) };
  }
  const files = units.map((unit) => shellWord(unit.file)).join(' ');
  const start = units.map((unit) => `launchctl kickstart gui/${sys.uid}/${unit.name} 2>/dev/null || ` +
    `launchctl bootstrap gui/${sys.uid} ${shellWord(unit.file)}`).join('; ');
  return { manager: names.manager, units, log: `tail -f ${shellWord(join(names.work, 'logs', 'agent.log'))}`,
    stop: `launchctl bootout gui/${sys.uid} ${files}`, start };
}

export function serviceLines(root: string, sys: ServiceSystem = machine()): string[] | null {
  const commands = serviceCommands(root, sys);
  if (commands === null) return null;
  const host = commands.units.at(-1)!;
  const shell = commands.units.length > 1 ? commands.units[0]! : undefined;
  const systemd = commands.manager === 'systemd-user';
  const both = shell === undefined ? '' : ' and its shell daemon';
  return [
    `Its service is ${systemd ? '' : 'the launch agent '}${host.name}, in ${host.file}` +
      `${shell === undefined ? '' : `, with its shell daemon ${shell.name}, in ${shell.file}`}.`,
    `  follow its log: ${commands.log}`,
    `  stop it${both} until the next ${systemd ? 'boot' : 'login'}: ${commands.stop}`,
    `  start it${both}: ${commands.start}`,
    ...(systemd && !sys.env.XDG_RUNTIME_DIR
      ? ['systemctl --user finds this user\'s systemd through XDG_RUNTIME_DIR, which this session doesn\'t set, so ' +
        'those lines set it.']
      : []),
  ];
}

async function awaitReady(root: string, manager: Manager, unit: ServiceUnit, sys: ServiceSystem,
  env: Record<string, string>): Promise<HostReady | { late: string } | string> {
  const until = sys.now() + READY_WAIT_MS;
  const name = unit.name;
  let first: string | undefined;
  let last = 'nothing answered';
  for (;;) {
    let host: HostClient | NoHost;
    try {
      host = await sys.openHost(root, until - sys.now());
    } catch (error) {
      return `its host can't be reached: ${errorText(error)}`;
    }
    if (!('reason' in host)) {
      const ready = host.ready;
      host.close();
      let pid: string;
      if (manager === 'systemd-user') {
        const shown = showUnit(sys, env, name, ['MainPID']);
        if (typeof shown === 'string') return shown;
        pid = shown.get('MainPID') ?? '0';
      } else {
        const state = agentState(sys, env, unit);
        if (state.kind === 'unknown') return `Whether ${name} runs the answering host can't be told: ${state.why}.`;
        pid = state.kind === 'running' ? state.pid : '0';
      }
      return pid === String(ready.pid) ? ready
        : `A host answers with pid ${ready.pid}, but ${name}'s main process is ${pid}. ` +
          "That answer doesn't establish that this service's host is ready.";
    }
    last = host.reason;
    if (manager === 'systemd-user') {
      const shown = showUnit(sys, env, name, ['ActiveState', 'SubState', 'InvocationID']);
      if (typeof shown === 'string') return `${shown}, and no host answers: ${last}.`;
      const state = shown.get('ActiveState') ?? '';
      const invocation = shown.get('InvocationID') ?? '';
      first ??= invocation;
      if (!RUNNING.has(state)) {
        return `${name} is ${state === '' ? `not running (${shown.get('SubState') || '?'})` : stateOf(shown)}, and no host ` +
          `answers: ${last}.`;
      }
      if (invocation !== first) return `systemd restarted ${name} before its host answered: ${last}.`;
    }
    await sys.sleep(Math.min(1_000, Math.max(until - sys.now(), 0)));
    if (sys.now() >= until) {
      return { late: `no host said it was ready within ${READY_WAIT_MS / 1000} s: ${last}. It may still be starting: ` +
        `${typedCommand(root, sys.env.PATH)} alone says whether its host answers.` };
    }
  }
}

function insideNeither(sys: ServiceSystem, manager: Manager,
  names: { host: ServiceUnit; shell: ServiceUnit }, units: ServiceUnit[], cmd: string): void {
  const inside = insideOf(sys, manager, [names.host, names.shell]);
  if (inside === undefined) return;
  throw new Refusal(`${cmd} service install ${units.includes(inside) ? 'restarts' : 'stops'} ${inside.name}, and ` +
    'this command runs inside it, so that would end this command partway, before it knows whether the host ' +
    'answers. Nothing was written. Ask whoever runs this machine to run it from a terminal outside the resident\'s ' +
    'service, such as over ssh.');
}

function noOtherUnit(ctx: CliContext, work: string, names: { host: ServiceUnit; shell: ServiceUnit },
  sys: ServiceSystem, env: Record<string, string>): void {
  const run = (args: string[]) => {
    const ran = sys.run('systemctl', args, env);
    return { exitCode: ran.status, stdout: Buffer.from(ran.stdout) };
  };
  const listed = systemdUnits(work, run as never, sys.home);
  for (const scope of listed.unasked) {
    ctx.out(`systemd's ${scope} manager couldn't be asked which of its units run from ${work}, so one that runs a ` +
      'host there isn\'t ruled out.');
  }
  const others = listed.found.filter((unit) => unit.scope === 'system' ||
    (unit.id !== names.host.name && unit.id !== names.shell.name));
  if (others.length > 0) {
    const steps = (['user', 'system'] as const).flatMap((scope) => {
      const these = others.filter((unit) => unit.scope === scope);
      if (these.length === 0) return [];
      const ids = (units: typeof these) => units.map((unit) => shellWord(unit.id)).join(' ');
      const line = (args: string) => (scope === 'user' ? systemctlLine(sys, args) : `systemctl ${args}`);
      const filed = these.filter((unit) => unit.file !== '');
      const own = scope === 'user' ? join(sys.home, '.config', 'systemd', 'user') : '/etc/systemd/system';
      const removable = filed.filter((unit) => dirname(unit.file) === own);
      return [`${scope === 'system' ? 'as root, ' : ''}${line(`stop ${ids(these)}`)}, ` +
        `${filed.length > 0 ? `${line(`disable ${ids(filed)}`)}, ` : ''}` +
        `${removable.length > 0 ? `remove ${removable.map((unit) => shellWord(unit.file)).join(' and ')}, ` : ''}` +
        `then ${line('daemon-reload')}`];
    });
    const statuses = (['user', 'system'] as const).flatMap((scope) => {
      const ids = others.filter((unit) => unit.scope === scope).map((unit) => shellWord(unit.id)).join(' ');
      return ids === '' ? [] : [scope === 'user' ? systemctlLine(sys, `status ${ids}`) : `systemctl status ${ids}`];
    });
    const them = others.length === 1 ? 'it' : 'them';
    throw new Refusal(`${others.map((unit) => `${unit.id} (a ${unit.scope} unit, ${unit.file === '' ? 'with no unit file'
      : `at ${unit.file}`})`).join(' and ')} ${others.length === 1 ? 'is' : 'are'} already set up to run from ${work}, ` +
      `even if stopped now. Started beside this install's host, as at a boot, one of the two would stop at the store's ` +
      `lock, over and over. ${statuses.join(' and ')} shows ` +
      `${others.length === 1 ? 'its state, and its process if it\'s running' : 'their states, and their processes if ' +
        'they\'re running'}. If that shows nothing uses ${them}, take ${them} away: ` +
      `${steps.join('; and ')}. If ${others.length === 1 ? 'it runs' : 'they run'} something other than a host, give ` +
      `${them} another working directory instead. Then repeat this service install command with the same recipe. Nothing was written.`);
  }
  const few = listed.defaulted.length === 1;
  if (listed.defaulted.length > 0) {
    ctx.out(`${listed.defaulted.join(', ')} ${few ? 'sets' : 'set'} no working directory, so ${few ? 'it runs' :
      'they run'} in ${few ? 'its' : 'their'} systemd manager's default, which is ${work}. Most units that do are no ` +
      `host's, so ${few ? 'it isn\'t' : 'they aren\'t'} checked. If ${few ? 'it runs' : 'one of them runs'} a host, one ` +
      'of two hosts would stop at the store\'s lock: give it a working directory of its own, or take it away.');
  }
  const one = listed.unresolved.length === 1;
  const scoped = (['user', 'system'] as const).flatMap((scope) => {
    const ids = listed.unresolved.filter((unit) => unit.scope === scope).map((unit) => unit.id);
    return ids.length === 0 ? [] : [`the ${scope} unit${ids.length === 1 ? '' : 's'} ${ids.join(', ')}`];
  }).join(' and ');
  if (listed.unresolved.length > 0) {
    ctx.out(`The working director${one ? 'y' : 'ies'} of ${scoped} couldn't be resolved, so whether ` +
      `${one ? 'it runs' : 'one of them runs'} a host from ${work} can't be told, and one that does isn't ruled out.`);
  }
}

async function removeShell(ctx: CliContext, sys: ServiceSystem, env: Record<string, string>, manager: Manager,
  unit: ServiceUnit, work: string): Promise<void> {
  if (readOr(unit.file) === null) return;
  if (manager === 'systemd-user') {
    systemctl(sys, env, ['disable', '--now', unit.name]);
    rmSync(unit.file, { force: true });
    systemctl(sys, env, ['daemon-reload']);
  } else {
    const state = agentState(sys, env, unit);
    if (state.kind === 'unknown') {
      throw new Refusal(`whether ${unit.name} is loaded can't be told: ${state.why}. It was left as it is.`);
    }
    if (state.kind !== 'unloaded') {
      await bootout(ctx, sys, env, unit, 'Repeat this service install command with the same recipe to finish ' +
        'removing the shell daemon.');
    }
    rmSync(unit.file, { force: true });
  }
  ctx.out(`Stopped and removed ${unit.name}: this install has no shell daemon now. Its settings stay in ` +
    `${join(work, '.env')}.`);
}

function managerOf(sys: ServiceSystem): Manager {
  if (sys.platform === 'darwin') return 'launchd';
  if (sys.platform !== 'linux') {
    throw new Refusal('service install writes systemd user units on Linux and launch agents on macOS, and this is ' +
      `${sys.platform}. Nothing was written.`);
  }
  const linger = sys.linger(sys.user);
  if (linger === null) {
    throw new Refusal('this system isn\'t running systemd, and service install writes systemd user units on Linux. ' +
      'Run the host under the service manager this system has, with its working directory and restarts on exit 75 ' +
      'and 1, as docs/DEPLOYMENTS.md says. Nothing was written.');
  }
  if (!linger) {
    throw new Refusal(`linger is off for ${sys.user}, so systemd would stop a user unit when ${sys.user} logs out. ` +
      'Nothing was written. Turn it on as root (or ask whoever administers this machine to), then repeat ' +
      `the same service install command with the same recipe:\n  sudo loginctl enable-linger ${sys.user}`);
  }
  return 'systemd-user';
}

function insideOf(sys: ServiceSystem, manager: Manager, units: ServiceUnit[]): ServiceUnit | undefined {
  const cgroups = (sys.cgroup() ?? '').split('\n').map((line) => line.split('/'))
    .filter((path) => path.includes(`user@${sys.uid}.service`));
  return units.find((unit) => manager === 'systemd-user'
    ? cgroups.some((path) => path.includes(unit.name))
    : sys.env.XPC_SERVICE_NAME === unit.name);
}

function mayRunHere(sys: ServiceSystem, manager: Manager, unit: ServiceUnit, work: string): boolean {
  return namedElsewhere(sys, manager, unit, work) === undefined;
}

function namedElsewhere(sys: ServiceSystem, manager: Manager, unit: ServiceUnit,
  work: string): { runsIn: string | null } | undefined {
  try {
    const text = readOr(unit.file);
    if (text === null) return undefined;
    const runsIn = fileDirectory(sys, childEnv(sys), manager, unit, text);
    return runsHere(runsIn, work) ? undefined : { runsIn };
  } catch {
    return undefined;
  }
}

export function unitElsewhere(root: string, sys: ServiceSystem = machine()): { unit: ServiceUnit; runsIn: string | null } | null {
  const names = serviceUnits(root, sys.platform, sys.home);
  if (names === null) return null;
  for (const unit of [names.host, names.shell]) {
    const named = namedElsewhere(sys, names.manager, unit, names.work);
    if (named !== undefined) return { unit, runsIn: named.runsIn };
  }
  return null;
}

/** systemd shows a unit as activating between its restarts, as when its daemon can't bind its port. */
function shellRuns(sys: ServiceSystem, manager: Manager, env: Record<string, string>, unit: ServiceUnit): boolean {
  if (manager === 'launchd') return agentState(sys, env, unit).kind === 'running';
  const shown = showUnit(sys, env, unit.name, ['ActiveState']);
  return typeof shown !== 'string' && shown.get('ActiveState') === 'active';
}

function ownedOrFree(unit: ServiceUnit, manager: Manager, work: string, sys: ServiceSystem,
  env: Record<string, string>, afterWrite?: string): void {
  const owner = ownerOf(unit, manager, work, sys, env);
  const effect = afterWrite === undefined ? 'Nothing was written.'
    : `The service files already written remain in place. ${afterWrite}No further unit was changed.`;
  if (owner.kind === 'other') {
    throw new Refusal(configConflict(unit, owner.from, owner.runsIn, work, stopLine(sys, manager, unit.name)) +
      (owner.loadedOnly ? ` systemd shows ${unit.name} as it last loaded it, while its file names ${work}: if its file ` +
        `or drop-ins changed since, ${systemctlLine(sys, 'daemon-reload')} loads them again, then repeat this service ` +
        'install command with the same recipe.' : '') +
      ` ${effect} Its name comes from this directory's name. Remove that unit if nothing uses it, or set this ` +
      'install up again in a directory of another name.');
  }
  if (owner.kind === 'unshown') {
    throw new Refusal(`${owner.shown}, so whether it runs another install can't be told. ${effect}`);
  }
  if (owner.kind === 'untold') {
    throw new Refusal(`${untold(sys, manager, unit)}. ${effect} If it's this install's, stop it ` +
      `(${stopLine(sys, manager, unit.name)}), then repeat this service install command with the same recipe.`);
  }
}

function untold(sys: ServiceSystem, manager: Manager, unit: ServiceUnit): string {
  return `${unit.name} is still ${manager === 'systemd-user' ? 'running' : 'loaded'}, but its file, ${unit.file}, is ` +
    'gone, so which install it runs can\'t be told';
}

function stopLine(sys: ServiceSystem, manager: Manager, name: string): string {
  return manager === 'systemd-user' ? systemctlLine(sys, `stop ${name}`) : `launchctl bootout gui/${sys.uid}/${name}`;
}

function configConflict(unit: ServiceUnit, from: string, runsIn: string | null, work: string, stop: string): string {
  return `${unit.name}'s config (${from}) names ${runsIn ?? 'no working directory set'}, rather than this install in ` +
    `${work}. Its running process may still be this install's. If so, stop it with ${stop}.`;
}

async function bootout(ctx: CliContext, sys: ServiceSystem, env: Record<string, string>, unit: ServiceUnit,
  next: string): Promise<void> {
  const target = 'gui/' + sys.uid + '/' + unit.name;
  const before = sys.run('launchctl', ['print', target], env);
  const exitTimeout = /^\s*exit timeout = (\d+)\s*$/m.exec(before.status === 0 ? before.stdout : '')?.[1];
  const unloadMs = Number(exitTimeout ?? EXIT_TIMEOUT_S) * 1000 + UNLOAD_POLL_MS;
  const ran = sys.run('launchctl', ['bootout', target], env);
  if (ran.status !== 0) {
    throw new Refusal('launchctl bootout ' + target + ' failed: ' + launchctlFailure(ran) + '. ' +
      next);
  }
  const started = sys.now();
  const until = started + unloadMs;
  let waiting = false;
  for (;;) {
    const shown = sys.run('launchctl', ['print', target], env);
    if (shown.status === 113) return;
    if (shown.status !== 0) {
      throw new Refusal('launchctl print ' + target + ' failed: ' + launchctlFailure(shown) +
        '. Its stop was requested, but whether ' + unit.name + ' finished unloading cannot be told. ' + next);
    }
    if (sys.now() >= until) {
      throw new Refusal(unit.name + " hasn't finished unloading after " + unloadMs / 1000 +
        ' s. Its stop was requested, but launchd still shows it. ' + next);
    }
    if (!waiting && sys.now() - started >= 1_000) {
      ctx.out('Waiting for ' + unit.name + ' to finish stopping.');
      waiting = true;
    }
    await sys.sleep(UNLOAD_POLL_MS);
  }
}

function shellOf(work: string, sys: ServiceSystem): string | null {
  const pkg = join(work, 'node_modules', SHELL_PACKAGE);
  const file = join(pkg, 'package.json');
  try {
    lstatSync(pkg);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Refusal(`whether ${SHELL_PACKAGE} is installed in ${work}, for the resident's shell, can't be told: ` +
      `${errorText(error)}. Nothing was written.`);
  }
  let bin: unknown;
  try {
    bin = (JSON.parse(readFileSync(file, 'utf-8')) as { bin?: Record<string, unknown> } | null)?.bin?.[SHELL_BIN];
  } catch (error) {
    throw new Refusal(`${SHELL_PACKAGE} is installed in ${work}, for the resident's shell, but ${file} can't be read: ` +
      `${errorText(error)}. Nothing was written.`);
  }
  if (typeof bin !== 'string') {
    throw new Refusal(`${SHELL_PACKAGE} is installed in ${work}, for the resident's shell, but its package.json names no ` +
      `${SHELL_BIN} for its daemon. Nothing was written.`);
  }
  if (sys.which('node', lastingPath(sys.env.PATH ?? '', sys.bun, sys)) === null) {
    throw new Refusal(`${SHELL_PACKAGE} is installed in ${work}, for the resident's shell, and its daemon runs on Node, ` +
      'but no node is on this PATH. Nothing was written.');
  }
  return resolve(pkg, bin);
}

async function shellPlan(sys: ServiceSystem, work: string, bin: string): Promise<ShellPlan> {
  const file = join(work, '.env');
  const known = readEnvFile(file);
  let port = known.get('SESSION_SERVER_PORT');
  if (port && (!/^\d+$/.test(port) || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535)) {
    throw new Refusal(`SESSION_SERVER_PORT in ${file} isn't an integer from 1 to 65535. ` +
      'Set a TCP port in that range, then repeat this service install command. Nothing was written.');
  }
  const newPort = !port;
  for (let candidate = SHELL_PORTS.first; candidate <= SHELL_PORTS.last && !port; candidate++) {
    if (await sys.portFree(candidate)) port = String(candidate);
  }
  if (!port) {
    throw new Refusal(`no port from ${SHELL_PORTS.first} to ${SHELL_PORTS.last} is free for the resident's shell ` +
      `daemon: set SESSION_SERVER_PORT in ${file} and run this again. Nothing was written.`);
  }
  const token = known.get('SESSION_SERVER_TOKEN');
  return token
    ? { bin, port, token, newPort, newToken: false }
    : { bin, port, token: randomBytes(32).toString('hex'), newPort, newToken: true };
}

function keepShellSettings(ctx: CliContext, sys: ServiceSystem, work: string, shell: ShellPlan): void {
  const file = join(work, '.env');
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
  try {
    new StoredSecrets(join(work, '.setup')).record('SESSION_SERVER_TOKEN');
  } catch (error) {
    throw new Refusal('the shell daemon\'s token can\'t be kept out of setup\'s answers, since the names of the stored ' +
      `secrets can't be recorded: ${errorText(error).replace(/\.+$/, '')}. No unit was written.`);
  }
  if ((mode & 0o077) !== 0) {
    try {
      chmodSync(file, 0o600);
    } catch (error) {
      throw new Refusal(`${file} ${shell.newToken ? 'is to hold' : 'holds'} the shell daemon's token and is open to ` +
        `others than ${sys.user} (mode ${mode.toString(8)}), and it can't be made readable by ${sys.user} alone: ` +
        `${errorText(error)}. No unit was written.`);
    }
    ctx.out(`${file} ${shell.newToken ? 'is to hold' : 'holds'} the shell daemon's token and was open to others than ` +
      `${sys.user} (mode ${mode.toString(8)}), so it's now readable by ${sys.user} alone.`);
  }
  const keep = (name: string, value: string) => {
    try {
      writeEnvValue(file, name, value);
    } catch (error) {
      throw new Refusal(`${name} can't be written to ${file}: ${errorText(error)}. No unit was written.`);
    }
  };
  if (shell.newPort) {
    keep('SESSION_SERVER_PORT', shell.port);
    ctx.out(`Port ${shell.port} was free when picked, so it's the resident's shell daemon's port, on localhost only: ` +
      `written to ${file} as SESSION_SERVER_PORT.`);
  }
  if (shell.newToken) {
    keep('SESSION_SERVER_TOKEN', shell.token);
    ctx.out(`Made a token for the resident's shell daemon: written to ${file} as SESSION_SERVER_TOKEN, not shown.`);
  }
}

function systemctl(sys: ServiceSystem, env: Record<string, string>, args: string[]): void {
  const ran = sys.run('systemctl', ['--user', ...args], env);
  if (ran.status !== 0) {
    throw new Refusal(`systemctl --user ${args.join(' ')} failed: ${stderrOf(ran)}. Once that's put right, repeat ` +
      'this service install command with the same recipe.');
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeTextAtomic(path, text, 0o600);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
