import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync,
  renameSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  checkService, installService, loadRecipeAsHost, portFree, readRecipeAsHost, readServiceRecord, runService, serviceLines,
  slugOf,
  type RecipeLoad, type ServiceSystem,
} from '../src/cli/service.js';
import { StoredSecrets, readEnvFile } from '../src/setup/secrets.js';
import { holdFileLock } from './helpers/held-file-lock.js';

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Install {
  home: string;
  work: string;
  root: string;
  data: string;
  recipe: string;
}

function install(name = 'My Resident', options: { shell?: boolean; home?: string; homeName?: string } = {}): Install {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'svc-')));
  made.push(top);
  const home = options.home ?? join(top, options.homeName ?? 'home');
  const work = join(home, name);
  const root = join(work, 'connectome-host');
  const data = join(work, 'data');
  mkdirSync(root, { recursive: true });
  mkdirSync(data, { recursive: true });
  mkdirSync(join(work, 'node_modules', '@animalabs', 'connectome-host'), { recursive: true });
  writeFileSync(join(root, 'install.json'), JSON.stringify({ v: 1, dataDir: data, extraState: [], workingDir: work }));
  writeFileSync(join(root, 'start.js'), '');
  writeFileSync(join(root, 'connectome'), '#!/bin/sh\n', { mode: 0o755 });
  const recipe = join(work, 'resident.json');
  writeFileSync(recipe, JSON.stringify(options.shell
    ? { mcpServers: { shell: { command: 'terminal-sessions-mcp' } } } : {}));
  if (options.shell) shellPackage(work);
  return { home, work, root, data, recipe };
}

function shellPackage(work: string): void {
  const pkg = join(work, 'node_modules', 'term-sessions-mcp');
  mkdirSync(join(pkg, 'dist', 'src', 'server'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({
    name: 'term-sessions-mcp', version: '1.7.3',
    bin: { 'terminal-sessions-mcp': './dist/src/mcp/mcp-stdio-server.js', 'session-server': './dist/src/server/start-session-server.js' },
  }));
}

function xmlPlistFields(path: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [, key, value] of readFileSync(path, 'utf-8').matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)) {
    fields[key!] ??= value!.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'')
      .replace(/&amp;/g, '&');
  }
  return fields;
}

function plistFields(args: string[], fields: Record<string, string | number>, converts = true): Ran {
  if (args[0] === '-convert') return converts ? ok(JSON.stringify(fields))
    : { status: 1, stdout: 'invalid object in plist for destination format\n', stderr: '' };
  if (args[0] === '-lint') return ok('fixture: OK\n');
  const value = fields[args[1]!];
  if (value === undefined) return { status: 1, stdout: 'No value at that key path\n', stderr: '' };
  if (args[0] === '-type') return ok((typeof value === 'string' ? 'string' : 'integer') + '\n');
  return ok(String(value) + '\n');
}

interface Loaded {
  workingDirectory: string;
  restart: string;
  statuses: Record<(typeof EXIT_STATUSES)[number], string>;
  environment: string[];
  execStart: string;
  description: string;
  fragment: string;
}

interface Ran {
  status: number;
  stdout: string;
  stderr: string;
}

const ok = (stdout = ''): Ran => ({ status: 0, stdout, stderr: '' });
const EXIT_STATUSES = ['SuccessExitStatus', 'RestartPreventExitStatus', 'RestartForceExitStatus'] as const;
const STARTED_AT = 1793000000;

type Printed = string | { after: number; line: string };

/** A stand-in for systemd's user manager, as systemd 257 behaved where a verdict depends on it:
 *  - it reads unit files and their drop-ins on daemon-reload, and loads a unit asked for by name from its file;
 *  - a pattern lists only the units it holds in memory: those asked for by name, enabled or started;
 *  - `show` answers only the properties asked for;
 *  - each start is an invocation of its own, whose output journalctl gives by its id and its time, apart from
 *    systemd's own lines;
 *  - a process that exits at once under Restart=on-failure reads as activating (auto-restart) between restarts, with
 *    NRestarts rising and a new invocation at each start;
 *  - a unit still running when its file is gone reads not-found and active after a reload, `disable` refuses it, and
 *    `stop` stops it;
 *  - a unit stopped at its start limit refuses `start` and `restart` until `reset-failed`;
 *  - a unit on its way down reads deactivating until a `stop` has waited for it;
 *  - `stop`, `start` and `restart` each take several units, and `start` leaves a unit that's running as it is;
 *  - `show` gives an enabled unit's UnitFileState as enabled, and another loaded unit's as disabled;
 *  - a unit that has failed keeps its last InvocationID;
 *  - journalctl -o json gives a unit's entries in order, a process's own under _SYSTEMD_INVOCATION_ID and systemd's
 *    own about a start (its "Started" line, and how a crashed start's process exited) under USER_INVOCATION_ID. */
class FakeSystemd {
  loaded = new Map<string, Loaded>();
  foreign = new Map<string, { workingDirectory: string; fragment: string }>();
  referenced = new Set<string>();
  enabled = new Set<string>();
  running = new Map<string, string>();
  latest = new Map<string, string>();
  nrestarts = new Map<string, number>();
  starts: Array<{ unit: string; environment: string[]; execStart: string }> = [];
  onStop: () => void = () => {};
  checkedEnvironment: string[][] = [];
  calls: string[] = [];
  crashing = new Set<string>();
  deactivating = new Set<string>();
  exiting = new Set<string>();
  failOnce = new Map<string, string>();
  startLimited = new Set<string>();
  exitStatus = new Map<string, string>();
  launchctlFailsOnce = new Map<string, string>();
  journal: Array<{ unit: string; invocation: string; own: boolean; after: number; line: string }> = [];
  prints: (unit: string) => Printed[] = () => ['Loaded recipe: resident'];
  envs: Array<Record<string, string>> = [];
  otherUnits: Array<{ id: string; workingDirectory: string; scope?: 'system'; fragment?: string }> = [];
  systemAnswers = true;
  agents = new Map<string, { pid: number | null }>();
  agentsExit = false;
  unloadPolls = 0;
  unloading = new Map<string, number>();
  bootstraps: string[] = [];
  primary = '';
  pids = new Map<string, number>();
  private invocations = 0;

  pidFor(unit: string): number {
    if (!this.pids.has(unit)) this.pids.set(unit, unit === this.primary ? 4242 : 5000 + this.pids.size);
    return this.pids.get(unit)!;
  }

  constructor(private readonly home: string) {}

  dir(): string {
    return join(this.home, '.config', 'systemd', 'user');
  }

  run(command: string, args: string[], env: Record<string, string>): Ran {
    this.calls.push(`${command} ${args.join(' ')}`);
    this.envs.push(env);
    if (command === 'journalctl') return this.journalctl(args);
    if (command === 'launchctl') return this.launchctl(args);
    if (command === 'plutil') return plistFields(args, xmlPlistFields(args.at(-1)!));
    if (command !== 'systemctl') return { status: 1, stdout: '', stderr: `${command}: not found` };
    const user = args[0] === '--user';
    const [verb, ...more] = user ? args.slice(1) : args;
    const unit = more[more.length - 1]!;
    const failing = this.failOnce.get(`${verb} ${unit}`);
    if (failing !== undefined) {
      this.failOnce.delete(`${verb} ${unit}`);
      return { status: 1, stdout: '', stderr: failing };
    }
    const others = (scope: 'user' | 'system') => this.otherUnits.filter((other) => (other.scope ?? 'user') === scope)
      .map((other) => `Id=${other.id}\nWorkingDirectory=${other.workingDirectory}\nUser=\nFragmentPath=${other.fragment ?? ''}\n` +
        'Restart=always\nSuccessExitStatus=\nRestartPreventExitStatus=\nRestartForceExitStatus=');
    if (!user) {
      return verb === 'show' && this.systemAnswers ? ok(`${others('system').join('\n\n')}\n`)
        : { status: 1, stdout: '', stderr: 'Failed to connect to bus' };
    }
    if (verb === 'daemon-reload') {
      this.loaded.clear();
      if (existsSync(this.dir())) {
        for (const name of readdirSync(this.dir())) if (name.endsWith('.service')) this.load(name);
      }
      return ok();
    }
    if (verb === 'show' && unit === '*.service') {
      const blocks = [...this.loaded.entries()].filter(([id]) => this.referenced.has(id)).map(([id, loaded]) =>
        `Id=${id}\nWorkingDirectory=${loaded.workingDirectory}\nUser=\nFragmentPath=${loaded.fragment}\n` +
        `Restart=${loaded.restart}\n${EXIT_STATUSES.map((key) => `${key}=${loaded.statuses[key]}`).join('\n')}`);
      return ok(`${[...blocks, ...others('user')].join('\n\n')}\n`);
    }
    if (verb === 'show') return this.show(unit, more);
    if (verb === 'enable') {
      for (const name of more) {
        this.referenced.add(name);
        this.enabled.add(name);
      }
      return ok();
    }
    if (verb === 'disable') {
      if (!existsSync(join(this.dir(), unit))) {
        return { status: 1, stdout: '', stderr: `Failed to disable unit: Unit ${unit} does not exist` };
      }
      this.enabled.delete(unit);
      if (more.includes('--now')) this.running.delete(unit);
      return ok();
    }
    if (verb === 'stop') {
      for (const name of more) {
        this.running.delete(name);
        this.deactivating.delete(name);
      }
      this.onStop();
      return ok();
    }
    if (verb === 'reset-failed') {
      for (const name of more) this.startLimited.delete(name);
      return ok();
    }
    if (verb === 'start' || verb === 'restart') {
      for (const name of more) {
        if (!this.loaded.has(name)) return { status: 5, stdout: '', stderr: `Unit ${name} not found.` };
        if (this.startLimited.has(name)) {
          return { status: 1, stdout: '', stderr: `Job for ${name} failed because start of the service was attempted too often.` };
        }
        if (verb === 'start' && this.running.has(name)) continue;
        this.referenced.add(name);
        this.nrestarts.set(name, 0);
        this.begin(name);
      }
      return ok();
    }
    return { status: 1, stdout: '', stderr: `unknown verb ${verb}` };
  }

  private begin(unit: string): void {
    const loaded = this.loaded.get(unit)!;
    const invocation = `${++this.invocations}`.padStart(32, '0');
    if (this.exiting.has(unit)) this.running.delete(unit);
    else this.running.set(unit, invocation);
    this.latest.set(unit, invocation);
    this.starts.push({ unit, environment: loaded.environment, execStart: loaded.execStart });
    this.journal.push({ unit, invocation, own: false, after: 0, line: `Started ${unit} - ${loaded.description}.` });
    for (const printed of this.prints(unit)) {
      this.journal.push({ unit, invocation, own: true, ...(typeof printed === 'string' ? { after: 0, line: printed } : printed) });
    }
  }

  private load(name: string): Loaded | undefined {
    const file = join(this.dir(), name);
    if (!existsSync(file)) return undefined;
    const loaded = this.parse(file);
    this.loaded.set(name, loaded);
    return loaded;
  }

  private show(unit: string, args: string[]): Ran {
    const asked = (args.find((arg) => arg.startsWith('--property='))?.slice('--property='.length) ?? '').split(',');
    const loaded = this.loaded.get(unit) ?? this.load(unit);
    if (loaded) {
      this.referenced.add(unit);
      if (!unit.endsWith('-shell.service') && asked.includes('Restart')) this.checkedEnvironment.push(loaded.environment);
    }
    const crashing = loaded !== undefined && this.running.has(unit) && this.crashing.has(unit);
    if (crashing) {
      this.nrestarts.set(unit, (this.nrestarts.get(unit) ?? 0) + 1);
      for (const line of [`${unit}: Main process exited, code=exited, status=1/FAILURE`,
        `${unit}: Scheduled restart job, restart counter is at ${this.nrestarts.get(unit)}.`]) {
        this.journal.push({ unit, invocation: this.running.get(unit)!, own: false, after: 0, line });
      }
      this.begin(unit);
    }
    const foreign = this.foreign.get(unit);
    const running = this.running.has(unit);
    const values: Record<string, string> = loaded || foreign
      ? {
        LoadState: 'loaded',
        WorkingDirectory: loaded?.workingDirectory ?? foreign!.workingDirectory,
        FragmentPath: loaded?.fragment ?? foreign!.fragment,
        Restart: loaded?.restart ?? 'always',
        ...(loaded?.statuses ?? {}),
        ActiveState: this.deactivating.has(unit) ? 'deactivating' : crashing ? 'activating' : running ? 'active'
          : this.exiting.has(unit) ? 'failed' : 'inactive',
        SubState: this.deactivating.has(unit) ? 'stop-sigterm' : crashing ? 'auto-restart' : running ? 'running'
          : this.exiting.has(unit) ? 'failed' : 'dead',
        NRestarts: String(this.nrestarts.get(unit) ?? 0),
        ExecMainStartTimestamp: this.latest.has(unit)
          ? 'Mon ' + new Date(STARTED_AT * 1000).toISOString().slice(0, 19).replace('T', ' ') + ' UTC' : '',
        MainPID: running ? String(this.pidFor(unit)) : '0',
        ExecMainStatus: this.crashing.has(unit) ? '1' : this.exitStatus.get(unit) ?? '0',
        Environment: (loaded?.environment ?? []).join(' '),
        InvocationID: this.running.get(unit) ?? this.latest.get(unit) ?? '',
        UnitFileState: loaded === undefined ? '' : this.enabled.has(unit) ? 'enabled' : 'disabled',
      }
      : {
        LoadState: 'not-found',
        ActiveState: this.deactivating.has(unit) ? 'deactivating' : running ? 'active' : 'inactive',
        SubState: this.deactivating.has(unit) ? 'stop-sigterm' : running ? 'running' : 'dead',
        NRestarts: '0', InvocationID: this.running.get(unit) ?? '', UnitFileState: '',
      };
    return ok(asked.map((key) => `${key}=${values[key] ?? ''}`).join('\n') + '\n');
  }

  private journalctl(args: string[]): Ran {
    const bound = (flag: string, otherwise: number) =>
      args.includes(flag) ? Number(args[args.indexOf(flag) + 1]!.replace(/^@/, '')) : otherwise;
    const within = (entry: { after: number }) =>
      STARTED_AT + entry.after >= bound('--since', -Infinity) && STARTED_AT + entry.after <= bound('--until', Infinity);
    const match = args.find((arg) => arg.startsWith('_SYSTEMD_INVOCATION_ID='));
    if (match !== undefined) {
      const invocation = match.slice('_SYSTEMD_INVOCATION_ID='.length);
      const entries = this.journal.filter((entry) => entry.own && entry.invocation === invocation).filter(within);
      return ok(entries.map((entry) => `${entry.line}\n`).join(''));
    }
    if (!args.includes('-u') || args[args.indexOf('-o') + 1] !== 'json') {
      return { status: 1, stdout: '', stderr: `journalctl: the fake doesn't answer ${args.join(' ')}` };
    }
    const unit = args[args.indexOf('-u') + 1]!;
    const last = args.includes('-n') ? Number(args[args.indexOf('-n') + 1]) : Infinity;
    const entries = this.journal.filter((entry) => entry.unit === unit).filter(within).slice(-last);
    return ok(entries.map((entry) => `${JSON.stringify({ MESSAGE: entry.line,
      [entry.own ? '_SYSTEMD_INVOCATION_ID' : 'USER_INVOCATION_ID']: entry.invocation })}\n`).join(''));
  }

  private launchctl(args: string[]): Ran {
    const [verb, target, file] = args;
    const failing = this.launchctlFailsOnce.get(verb!);
    if (failing !== undefined) {
      this.launchctlFailsOnce.delete(verb!);
      return { status: 5, stdout: '', stderr: failing };
    }
    if (verb === 'print') {
      const label = target!.split('/').at(-1)!;
      const remaining = this.unloading.get(label);
      if (remaining !== undefined) {
        if (remaining === 0) {
          this.unloading.delete(label);
          this.agents.delete(label);
        } else this.unloading.set(label, remaining - 1);
      }
      const agent = this.agents.get(label);
      return agent === undefined
        ? { status: 113, stdout: '', stderr: `Could not find service "${label}" in domain for user gui` }
        : ok(`state = ${remaining === undefined ? 'running' : 'SIGTERMed'}\npid = ${agent.pid}`);
    }
    if (verb === 'list') {
      const agent = this.agents.get(target!);
      if (agent === undefined) return { status: 113, stdout: '', stderr: `Could not find service "${target}" in domain for port` };
      return ok(`{\n\t"Label" = "${target}";\n\t"LastExitStatus" = 0;\n${agent.pid === null ? '' : `\t"PID" = ${agent.pid};\n`}};\n`);
    }
    if (verb === 'bootstrap') {
      const label = basename(file!).replace(/\.plist$/, '');
      if (this.agents.has(label)) return { status: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };
      this.bootstraps.push(label);
      this.agents.set(label, { pid: this.agentsExit ? null : this.pidFor(label) });
      return ok();
    }
    if (verb === 'bootout') {
      const label = target!.split('/').at(-1)!;
      if (this.unloadPolls > 0) this.unloading.set(label, this.unloadPolls);
      else this.agents.delete(label);
      return ok();
    }
    if (verb === 'kickstart') {
      const agent = this.agents.get(target!.split('/').at(-1)!);
      if (agent === undefined) return { status: 113, stdout: '', stderr: 'Could not find service in domain for port' };
      if (!this.agentsExit) agent.pid = this.pidFor(target!.split('/').at(-1)!);
      return ok();
    }
    return { status: 1, stdout: '', stderr: `unknown launchctl verb ${verb}` };
  }

  private parse(file: string): Loaded {
    const text = readFileSync(file, 'utf-8');
    const value = (key: string) => [...text.matchAll(new RegExp(`^${key}=(.*)$`, 'gm'))].map((match) => match[1]!);
    const unescape = (entry: string) => entry.replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1').replace(/%%/g, '%');
    const dropIn = `${file}.d`;
    const texts = [text, ...(existsSync(dropIn) ? readdirSync(dropIn).sort().map((name) => readFileSync(join(dropIn, name), 'utf-8')) : [])];
    const assigned = (key: string) => texts.flatMap((each) => [...each.matchAll(new RegExp(`^${key}=(.*)$`, 'gm'))].map((match) => match[1]!.trim()));
    // A list setting adds to what came before it, and an empty assignment clears it.
    const list = (key: string) => assigned(key).reduce<string[]>((all, each) => (each === '' ? [] : [...all, ...each.split(/\s+/)]), []).join(' ');
    return {
      workingDirectory: (assigned('WorkingDirectory').at(-1) ?? '').replace(/%%/g, '%'),
      restart: assigned('Restart').at(-1) ?? 'no',
      statuses: { SuccessExitStatus: list('SuccessExitStatus'), RestartPreventExitStatus: list('RestartPreventExitStatus'),
        RestartForceExitStatus: list('RestartForceExitStatus') },
      environment: value('Environment').map(unescape),
      execStart: value('ExecStart')[0] ?? '',
      description: (value('Description')[0] ?? '').replace(/%%/g, '%'),
      fragment: file,
    };
  }
}

interface Fake {
  system: ServiceSystem;
  systemd: FakeSystemd;
  out: string[];
  err: string[];
  loads: Array<{ recipe: string; work: string; env: Record<string, string> }>;
  slept: () => number;
  ctx(argv: string[]): { root: string; argv: string[]; out(line: string): void; err(line: string): void };
}

function fake(at: Install, options: {
  platform?: NodeJS.Platform;
  linger?: boolean | null;
  env?: Record<string, string | undefined>;
  taken?: number[];
  ready?: boolean;
  answersAfter?: number;
  node?: string | null;
  cwd?: string;
  cgroup?: string;
  recipeLoad?: RecipeLoad | ((env: Record<string, string>) => RecipeLoad);
} = {}): Fake {
  const systemd = new FakeSystemd(at.home);
  const hostOf = (root: string) => (options.platform === 'darwin' ? 'com.animalabs.connectome.' : 'connectome-') +
    slugOf(basename(dirname(root))) + (options.platform === 'darwin' ? '' : '.service');
  systemd.primary = hostOf(at.root);
  // A test may hand this fake another's systemd; the host's socket answers from whichever systemd runs the units.
  let faked: Fake;
  const out: string[] = [];
  const err: string[] = [];
  const loads: Fake['loads'] = [];
  const taken = new Set(options.taken ?? []);
  let clock = 0;
  let slept = 0;
  let asked = 0;
  const system: ServiceSystem = {
    platform: options.platform ?? 'linux',
    user: 'resident',
    uid: 1001,
    home: at.home,
    cwd: options.cwd ?? at.work,
    env: options.env ?? { PATH: `${at.root}:/usr/bin:/bin` },
    bun: '/opt/bun/bin/bun',
    cgroup: () => options.cgroup ?? null,
    which: (name) => (name === 'node' ? (options.node === undefined ? '/opt/node/bin/node' : options.node) : null),
    run: (command, args, env) => systemd.run(command, args, env),
    readRecipe: (recipe, work, env) => {
      try {
        const document = /^https?:\/\//.test(recipe) ? {} : JSON.parse(readFileSync(recipe, 'utf-8'));
        const text = JSON.stringify(document);
        const shell = /SESSION_SERVER_(TOKEN|PORT)|terminal-sessions-mcp|term-sessions-mcp/.test(text);
        return { loads: true, shell, document };
      } catch {
        return { loads: false, words: `${recipe} isn't valid JSON` };
      }
    },
    loadRecipe: (recipe, work, env) => {
      loads.push({ recipe, work, env });
      const given = options.recipeLoad;
      return given === undefined ? hostLoads(recipe, work, env) : typeof given === 'function' ? given(env) : given;
    },
    linger: () => (options.linger === undefined ? true : options.linger),
    portFree: async (port) => !taken.has(port),
    openHost: async (root) => {
      asked++;
      return options.ready === false || asked <= (options.answersAfter ?? 0)
        ? { reason: 'no host is running', down: true }
        : { ready: { pid: faked.systemd.pidFor(hostOf(root)),
          recipe: root === at.root ? 'Resident' : basename(dirname(root)) }, close() {} } as never;
    },
    sleep: async (ms) => {
      clock += ms;
      slept += ms;
    },
    now: () => clock,
  };
  faked = {
    system, systemd, out, err, loads,
    slept: () => slept,
    ctx: (argv) => ({ root: at.root, argv, out: (line) => out.push(line), err: (line) => err.push(line) }),
  };
  return faked;
}

function hostLoads(recipe: string, work: string, env: Record<string, string>): RecipeLoad {
  if (/^https?:\/\//.test(recipe)) return { loads: true };
  const text = readFileSync(recipe, 'utf-8');
  try {
    JSON.parse(text);
  } catch {
    return { loads: false, words: `${recipe} isn't valid JSON` };
  }
  const dotenv = existsSync(join(work, '.env')) ? readEnvFile(join(work, '.env')) : new Map<string, string>();
  for (const [, name] of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    if (env[name!] === undefined && !dotenv.has(name!)) {
      return { loads: false, words: `Recipe "${recipe}" references environment variable \${${name}} which is not set. ` +
        'Add it to your .env file, supply a default with ${' + name + ':-...}, or delete the section of the recipe that ' +
        'uses it (e.g. remove the mcpServers entry for a source you don\'t have).' };
    }
  }
  return { loads: true };
}

const unitsDir = (at: Install) => join(at.home, '.config', 'systemd', 'user');
const hostUnit = (at: Install) => join(unitsDir(at), 'connectome-my-resident.service');
const shellUnit = (at: Install) => join(unitsDir(at), 'connectome-my-resident-shell.service');
const serviceRepairWords = 'Run connectome service install to check and repair the service for its recorded recipe. ' +
  'If it asks you to stop a loaded unit whose file is gone, follow its conditional stop instruction, then repeat install.';
const HOST = 'connectome-my-resident.service';
const SHELL = 'connectome-my-resident-shell.service';

function nothingWritten(at: Install, unitFile = hostUnit(at)): void {
  expect(existsSync(unitFile)).toBe(false);
  expect(existsSync(shellUnit(at))).toBe(false);
  expect(existsSync(join(at.work, '.env'))).toBe(false);
  expect(existsSync(join(at.work, '.setup', 'stored-secrets.json'))).toBe(false);
  expect(existsSync(join(at.root, 'service.json'))).toBe(false);
}

test('service operations and log excerpts work with systemd 247 timestamp styles', async () => {
  const at = install();
  const f = fake(at);
  const run = f.system.run;
  const stamp = new Date(STARTED_AT * 1000).toISOString().slice(0, 19).replace('T', ' ');
  f.system.run = (cmd, args, env) => {
    if (cmd === 'systemctl' && args.includes('--timestamp=unix')) {
      return { status: 1, stdout: '', stderr: 'Invalid value: unix.' };
    }
    const ran = run(cmd, args, env);
    return cmd === 'systemctl' ? { ...ran,
      stdout: ran.stdout.replace(/ExecMainStartTimestamp=.+/,
        'ExecMainStartTimestamp=Mon ' + stamp + (env.TZ === 'UTC' && env.LC_ALL === 'C' ? ' UTC' : ' EST')) } : ran;
  };
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(f.out).toContain('  | Loaded recipe: resident');
  expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
  expect(await runService(f.ctx(['start']), f.system)).toBe(0);
});

test('a latest invocation that ended is read with a 200-entry cap, not a lifetime read', async () => {
  const at = install();
  const f = fake(at);
  f.systemd.exiting.add(HOST);
  f.systemd.prints = () => Array.from({ length: 350 }, (_, at) => 'report ' + at);
  const run = f.system.run;
  let captured = 0;
  f.system.run = (cmd, args, env) => {
    const ran = run(cmd, args, env);
    if (cmd === 'journalctl' && args.some((arg) => arg.startsWith('_SYSTEMD_INVOCATION_ID='))) {
      const reports = ran.stdout.trimEnd().split('\n');
      const n = args.indexOf('-n');
      const kept = n < 0 ? reports : reports.slice(-Number(args[n + 1]));
      captured = kept.length;
      return { ...ran, stdout: kept.join('\n') + '\n' };
    }
    return ran;
  };
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(captured).toBe(200);
  expect(f.out.join('\n')).toContain('last 200 entries');
  expect(f.out).toContain('  | report 349');
});

test('earlier-start selection reports every journal entry it cannot interpret', async () => {
  const at = install();
  const f = fake(at, { ready: false });
  f.systemd.crashing.add(HOST);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  f.systemd.crashing.delete(HOST);
  const run = f.system.run;
  f.system.run = (cmd, args, env) => {
    const ran = run(cmd, args, env);
    return cmd === 'journalctl' && args.includes('json')
      ? { ...ran, stdout: ran.stdout + '{broken\n' +
        JSON.stringify({ MESSAGE: [255], USER_INVOCATION_ID: 'opaque' }) + '\n' +
        JSON.stringify({ MESSAGE: 'has no invocation' }) + '\n' } : ran;
  };
  const checked = await checkService(at.root, f.system);
  expect(checked.lines.join('\n')).toContain("3 journal entries couldn't be interpreted");
});

for (const verb of ['stop', 'check'] as const) test('launchd query failure is diagnosed as unknown during ' + verb, async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin' });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  f.out.length = 0;
  f.err.length = 0;
  f.systemd.launchctlFailsOnce.set('list', 'manager denied query');
  const result = verb === 'stop' ? await runService(f.ctx(['stop']), f.system)
    : await checkService(at.root, f.system);
  const said = typeof result === 'number' ? f.out.concat(f.err).join('\n') : result.lines.join('\n');
  expect(typeof result === 'number' ? result : Number(!result.passed)).toBe(1);
  expect(said).toContain('manager denied query');
  expect(said).not.toContain("wasn't running");
  expect(said).not.toContain('has no com.animalabs.connectome.my-resident loaded');
});

test('this install\'s launch agent converted to a binary plist is still read as this install\'s', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin' });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  writeFileSync(agentPlist(at), 'bplist00fixture');
  const run = f.system.run;
  f.system.run = (command, args, env) => command === 'plutil' && args.at(-1) === agentPlist(at)
    ? plistFields(args, { Label: 'com.animalabs.connectome.my-resident', WorkingDirectory: at.work })
    : run(command, args, env);
  f.out.length = 0;
  expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
  expect(f.out).toContain('Stopped com.animalabs.connectome.my-resident.');
  expect(f.err).toEqual([]);
});

test('a launch agent with no file whose state launchctl can\'t give is not taken as free', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin' });
  f.systemd.agents.set('com.animalabs.connectome.my-resident', { pid: 999 });
  const run = f.system.run;
  f.system.run = (command, args, env) => command === 'launchctl' && args[0] === 'list'
    ? { status: 5, stdout: '', stderr: 'manager denied query' }
    : run(command, args, env);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('launchctl list com.animalabs.connectome.my-resident failed: manager denied ' +
    'query, so whether it runs another install can\'t be told. Nothing was written.');
  expect(existsSync(agentPlist(at))).toBe(false);
  expect(existsSync(join(at.root, 'service.json'))).toBe(false);
});

for (const platform of ['linux', 'darwin'] as const) test('readiness refuses an answering host outside the ' + platform + ' unit', async () => {
  const at = install();
  const f = fake(at, { platform });
  f.system.openHost = async () => ({ ready: { pid: 9999, recipe: 'Resident' }, close() {} }) as never;
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('9999');
  expect(f.err.join('\n')).toContain('4242');
  expect(f.out.join('\n')).not.toContain('Its host answers:');
});

for (const port of ['0', '65536', '3.1', 'word', '-1']) test('an invalid stored shell port is refused before writing units: ' + port, async () => {
  const at = install('My Resident', { shell: true });
  writeFileSync(join(at.work, '.env'), 'SESSION_SERVER_PORT=' + port + '\n');
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain(`SESSION_SERVER_PORT in ${join(at.work, '.env')} isn't an integer from 1 to 65535.`);
  expect(existsSync(hostUnit(at))).toBe(false);
  expect(existsSync(shellUnit(at))).toBe(false);
});

for (const operation of ['install', 'start']) test('an unknown launchd state includes its reason while ' + operation + ' preserves logs and attempts loading', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin' });
  if (operation === 'start') {
    expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
    expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
  }
  const log = join(at.work, 'logs', 'agent.log');
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(log, 'earlier-load');
  const run = f.system.run;
  let once = true;
  f.system.run = (cmd, args, env) => {
    if (cmd === 'launchctl' && args[0] === 'list' && existsSync(agentPlist(at)) && once) {
      once = false;
      return { status: 77, stdout: '', stderr: 'unknown-state detail' };
    }
    return run(cmd, args, env);
  };
  f.out.length = 0;
  expect(await runService(f.ctx(operation === 'start' ? ['start'] : ['install', at.recipe]), f.system)).toBe(0);
  expect(f.out.join('\n')).toContain('unknown-state detail');
  expect(readFileSync(log, 'utf-8')).toBe('earlier-load');
});

test('an unexpected log-rotation error reports partial effects and releases the lock for retry', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin' });
  const log = join(at.work, 'logs', 'agent.log');
  mkdirSync(log + '.previous', { recursive: true });
  writeFileSync(join(log + '.previous', 'occupied'), 'keep');
  writeFileSync(log, 'earlier-load');
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('may already have changed');
  expect(f.err.join('\n')).toContain('repeat this command');
  rmSync(log + '.previous', { recursive: true });
  expect(await installService(f.ctx(['install']), f.system)).toBe(0);
});

test('an empty external shell token leaves whole-credential diagnostic masking intact', async () => {
  const at = install();
  writeFileSync(join(at.work, '.env'), 'SESSION_SERVER_TOKEN=""\n');
  const f = fake(at, { env: { ANTHROPIC_API_KEY: 'provider-opaque-value' },
    recipeLoad: { loads: false, words: 'credential provider-opaque-value refused' } });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('<ANTHROPIC_API_KEY>');
  expect(f.err.join('\n')).not.toContain('provider-opaque-value');
  expect(f.err.join('\n')).not.toContain('<SESSION_SERVER_TOKEN>');
});

test('service logs mask an external shell token omitted from an existing secret-name list', async () => {
  const at = install();
  mkdirSync(join(at.work, '.setup'));
  writeFileSync(join(at.work, '.setup', 'stored-secrets.json'), '[]');
  writeFileSync(join(at.work, '.env'), 'SESSION_SERVER_TOKEN=external-opaque-value\n');
  const f = fake(at);
  f.systemd.prints = () => ['shell credential=external-opaque-value'];
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(f.out.join('\n')).toContain('<SESSION_SERVER_TOKEN>');
  expect(f.out.join('\n')).not.toContain('external-opaque-value');
});

test('a first no-shell install preserves external settings and names what it kept', async () => {
  const at = install();
  const before = 'SESSION_SERVER_TOKEN=external-value\nSESSION_SERVER_PORT=3200\n';
  writeFileSync(join(at.work, '.env'), before);
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(readFileSync(join(at.work, '.env'), 'utf-8')).toBe(before);
  expect(f.out.join('\n')).toContain('Kept SESSION_SERVER_TOKEN');
  expect(f.out.join('\n')).toContain('SESSION_SERVER_PORT');
  expect(f.out.join('\n')).toContain("isn't recorded as written by this service");
});

test('a managed shell preserves inherited settings when later retired', async () => {
  const at = install('My Resident', { shell: true });
  const before = 'SESSION_SERVER_TOKEN=external-value\nSESSION_SERVER_PORT=3200\n';
  writeFileSync(join(at.work, '.env'), before);
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  writeFileSync(at.recipe, '{}');
  expect(await installService(f.ctx(['install']), f.system)).toBe(0);
  expect(existsSync(shellUnit(at))).toBe(false);
  expect(readFileSync(join(at.work, '.env'), 'utf-8')).toBe(before);
});

test('a re-run carries ownership of generated settings until a later no-shell install removes them', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const before = readFileSync(join(at.work, '.env'), 'utf-8');
  expect(await installService(f.ctx(['install']), f.system)).toBe(0);
  expect(readFileSync(join(at.work, '.env'), 'utf-8')).toBe(before);
  writeFileSync(at.recipe, '{}');
  expect(await installService(f.ctx(['install']), f.system)).toBe(0);
  expect(readEnvFile(join(at.work, '.env')).has('SESSION_SERVER_TOKEN')).toBe(false);
  expect(readEnvFile(join(at.work, '.env')).has('SESSION_SERVER_PORT')).toBe(false);
});

test('retirement keeps a changed token but removes the generated port still owned by the service', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const file = join(at.work, '.env');
  writeFileSync(file, readFileSync(file, 'utf-8').replace(/SESSION_SERVER_TOKEN=.*\n/, 'SESSION_SERVER_TOKEN=independent-value\n'));
  writeFileSync(at.recipe, '{}');
  f.out.length = 0;
  expect(await installService(f.ctx(['install']), f.system)).toBe(0);
  const values = readEnvFile(file);
  expect(values.get('SESSION_SERVER_TOKEN')).toBe('independent-value');
  expect(values.has('SESSION_SERVER_PORT')).toBe(false);
  expect(f.out.join('\n')).toContain('Kept SESSION_SERVER_TOKEN');
  expect(f.out.join('\n')).not.toContain('independent-value');
});

test('macOS refuses another installed agent in this working directory, including a binary plist', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin' });
  const other = join(at.home, 'Library', 'LaunchAgents', 'older.plist');
  mkdirSync(dirname(other), { recursive: true });
  writeFileSync(other, 'bplist00fixture');
  const run = f.system.run;
  f.system.run = (command, args, env) => command === 'plutil' && args.at(-1) === other
    ? plistFields(args, { Label: 'other.resident', WorkingDirectory: at.work })
    : run(command, args, env);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(existsSync(agentPlist(at))).toBe(false);
  expect(f.err.join('\n')).toContain(other);
  expect(f.err.join('\n')).toContain('other.resident');
  expect(f.err.join('\n')).toContain('another working directory');
  expect(f.err.join('\n')).toContain(`launchctl bootout gui/1001 ${other} if launchctl print finds it, ` +
    'then remove that plist.');
});

test('an unreadable LaunchAgents plist is named with its reason rather than ruled out', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin' });
  const other = join(at.home, 'Library', 'LaunchAgents', 'unreadable.plist');
  mkdirSync(dirname(other), { recursive: true });
  writeFileSync(other, 'unreadable fixture');
  const run = f.system.run;
  f.system.run = (command, args, env) => command === 'plutil' && args.at(-1) === other
    ? { status: 1, stdout: '', stderr: 'conversion denied' }
    : run(command, args, env);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(f.out.join('\n')).toContain(other);
  expect(f.out.join('\n')).toContain('conversion denied');
  expect(f.out.join('\n')).toContain("isn't ruled out");
});

test('a converted agent for another working directory leaves this install available', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin' });
  const other = join(at.home, 'Library', 'LaunchAgents', 'unrelated.plist');
  mkdirSync(dirname(other), { recursive: true });
  writeFileSync(other, 'bplist00fixture');
  const run = f.system.run;
  f.system.run = (command, args, env) => command === 'plutil' && args.at(-1) === other
    ? plistFields(args, { Label: 'another.job', WorkingDirectory: at.home })
    : run(command, args, env);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(readFileSync(other, 'utf-8')).toBe('bplist00fixture');
});

test('a Linux same-directory unit that is not a host is offered another working directory', async () => {
  const at = install();
  const f = fake(at);
  f.systemd.otherUnits.push({ id: 'indexer.service', workingDirectory: at.work, fragment: '/indexer.service' });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('indexer.service');
  expect(f.err.join('\n')).toContain('another working directory');
});


for (const platform of ['linux', 'darwin'] as const) for (const form of ['legacy', 'invalid', 'moved', 'copied']) {
  test(platform + ' new service refuses an install record not bound here: ' + form, async () => {
    const at = install();
    const path = join(at.root, 'install.json');
    const installed = JSON.parse(readFileSync(path, 'utf-8'));
    if (form === 'legacy') delete installed.workingDir;
    else installed.workingDir = form === 'invalid' ? 10 : form === 'moved' ? join(at.home, 'gone') : at.home;
    writeFileSync(path, JSON.stringify(installed));
    const f = fake(at, { platform });
    expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
    expect(f.systemd.calls).toEqual([]);
    expect(f.loads).toEqual([]);
    expect(existsSync(join(at.root, 'service.json'))).toBe(false);
    expect(existsSync(join(at.work, '.env'))).toBe(false);
    expect(f.err.join('\n')).toContain(path);
    expect(f.err.join('\n')).toContain('setup');
    expect(f.err.join('\n')).toContain(at.work);
  });
}

for (const platform of ['linux', 'darwin'] as const) for (const action of ['start', 'stop', 'install', 'status', 'check']) {
  test(platform + ' a foreign service record cannot supply ordinary ' + action, async () => {
    const at = install('Original', { shell: true });
    const f = fake(at, { platform });
    expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
    const copy = install('Copy', { home: at.home });
    const bytes = readFileSync(join(at.root, 'service.json'), 'utf-8');
    writeFileSync(join(copy.root, 'service.json'), bytes);
    f.systemd.calls.length = f.out.length = f.err.length = 0;
    let said: string;
    if (action === 'status') {
      let error: unknown;
      try { serviceLines(copy.root); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      said = String(error);
    } else if (action === 'check') {
      const checked = await checkService(copy.root, f.system);
      expect(checked.passed).toBe(false);
      said = checked.lines.join('\n');
    } else {
      expect(await runService({ ...f.ctx([action]), root: copy.root }, f.system)).toBe(1);
      said = [...f.out, ...f.err].join('\n');
    }
    expect(said).toContain(at.work);
    expect(said).toContain(copy.work);
    expect(said).toContain('service install <recipe>');
    expect(f.systemd.calls).toEqual([]);
    expect(readFileSync(join(copy.root, 'service.json'), 'utf-8')).toBe(bytes);
  });
}

for (const platform of ['linux', 'darwin'] as const) test(platform + ' explicit copy install leaves the original service and inherited settings alone', async () => {
  const at = install('Original', { shell: true });
  const f = fake(at, { platform });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const previous = readServiceRecord(at.root)!;
  const units = [previous.units.host, previous.units.shell!];
  const files = units.map((unit) => readFileSync(unit.file, 'utf-8'));
  const settings = readFileSync(join(at.work, '.env'), 'utf-8');
  const copy = install('Copy', { home: at.home });
  writeFileSync(join(copy.root, 'service.json'), readFileSync(join(at.root, 'service.json')));
  writeFileSync(join(copy.work, '.env'), settings);
  f.systemd.calls.length = 0;
  expect(await installService({ ...f.ctx(['install', copy.recipe]), root: copy.root }, f.system)).toBe(0);
  for (const [i, unit] of units.entries()) {
    expect(readFileSync(unit.file, 'utf-8')).toBe(files[i]!);
    expect(platform === 'darwin' ? f.systemd.agents.has(unit.name) : f.systemd.running.has(unit.name)).toBe(true);
    expect(f.systemd.calls.some((line) => /\b(stop|disable|restart|bootout|kickstart)\b/.test(line) && line.includes(unit.name))).toBe(false);
  }
  expect(readFileSync(join(at.work, '.env'), 'utf-8')).toBe(settings);
  expect(readFileSync(join(copy.work, '.env'), 'utf-8')).toBe(settings);
  expect(readServiceRecord(copy.root)!.workingDirectory).toBe(copy.work);
  expect(readServiceRecord(copy.root)!.shellSettings).toBeUndefined();
  const notice = f.out.find((line) => line.includes('This run uses the explicit recipe'))!;
  expect(notice).toContain("It isn't used here. This run uses the explicit recipe");
  expect(notice).not.toContain('Name the recipe');
});

for (const platform of ['linux', 'darwin'] as const) test(platform + ' a moved service waits for explicit native retirement before replacement', async () => {
  const at = install('Original', { shell: true });
  const f = fake(at, { platform });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const previous = readServiceRecord(at.root)!;
  const units = [previous.units.host, previous.units.shell!];
  const moved = join(at.home, 'Moved');
  renameSync(at.work, moved);
  const root = join(moved, 'connectome-host');
  const recipe = join(moved, 'resident.json');
  writeFileSync(join(root, 'install.json'), JSON.stringify({
    v: 1, dataDir: join(moved, 'data'), extraState: [], workingDir: moved,
  }));
  const before = readFileSync(join(root, 'service.json'), 'utf-8');
  f.out.length = f.err.length = 0;
  expect(await installService({ ...f.ctx(['install', recipe]), root }, f.system)).toBe(1);
  expect(readFileSync(join(root, 'service.json'), 'utf-8')).toBe(before);
  const said = [...f.out, ...f.err].join('\n');
  expect(said).toContain(previous.units.host.name);
  expect(said).toContain(platform === 'darwin' ? 'launchctl bootout' : 'systemctl --user');
  expect(said).not.toContain('Name the recipe');
  expect(said.indexOf('Then repeat ')).toBeGreaterThan(said.indexOf('Before replacing its record'));
  expect(said).toEndWith(' service install <recipe>.');
  for (const unit of units) {
    expect(platform === 'darwin' ? f.systemd.agents.has(unit.name) : f.systemd.running.has(unit.name)).toBe(true);
    if (platform === 'darwin') f.system.run('launchctl', ['bootout', 'gui/1001/' + unit.name], {});
    else f.system.run('systemctl', ['--user', 'stop', unit.name], {});
    rmSync(unit.file);
  }
  if (platform === 'linux') f.system.run('systemctl', ['--user', 'daemon-reload'], {});
  expect(await installService({ ...f.ctx(['install', recipe]), root }, f.system)).toBe(0);
  expect(readServiceRecord(root)!.workingDirectory).toBe(moved);
});


for (const platform of ['linux', 'darwin'] as const) test(platform + ' a missing old file does not settle a moved service native state', async () => {
  const at = install('Original');
  const f = fake(at, { platform });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const previous = readServiceRecord(at.root)!;
  const unit = previous.units.host;
  const moved = join(at.home, 'Moved');
  renameSync(at.work, moved);
  const root = join(moved, 'connectome-host');
  const recipe = join(moved, 'resident.json');
  writeFileSync(join(root, 'install.json'), JSON.stringify({
    v: 1, dataDir: join(moved, 'data'), extraState: [], workingDir: moved,
  }));
  rmSync(unit.file);
  const before = readFileSync(join(root, 'service.json'), 'utf-8');
  f.out.length = f.err.length = 0;
  expect(await installService({ ...f.ctx(['install', recipe]), root }, f.system)).toBe(1);
  expect([...f.out, ...f.err].join('\n')).toContain(unit.name);
  expect(readFileSync(join(root, 'service.json'), 'utf-8')).toBe(before);
  expect(platform === 'darwin' ? f.systemd.agents.has(unit.name) : f.systemd.running.has(unit.name)).toBe(true);
  const run = f.system.run;
  let queried = 0;
  f.system.run = (command, args, env) => {
    if ((platform === 'linux' && command === 'systemctl' && args.includes('show') && args.includes(unit.name)) ||
      (platform === 'darwin' && command === 'launchctl' && args[0] === 'list' && args[1] === unit.name)) {
      queried++;
      return { status: 5, stdout: '', stderr: 'original state query denied' };
    }
    return run(command, args, env);
  };
  f.out.length = f.err.length = 0;
  expect(await installService({ ...f.ctx(['install', recipe]), root }, f.system)).toBe(1);
  expect(queried).toBe(1);
  expect([...f.out, ...f.err].join('\n')).toContain('original state query denied');
  expect(readFileSync(join(root, 'service.json'), 'utf-8')).toBe(before);
  f.system.run = run;
  if (platform === 'darwin') f.system.run('launchctl', ['bootout', 'gui/1001/' + unit.name], {});
  else {
    f.system.run('systemctl', ['--user', 'stop', unit.name], {});
    f.system.run('systemctl', ['--user', 'daemon-reload'], {});
  }
  expect(await installService({ ...f.ctx(['install', recipe]), root }, f.system)).toBe(0);
});

test('an uncheckable foreign directory refuses without treating it as a missing old directory', async () => {
  const at = install('Original');
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const previous = readServiceRecord(at.root)!;
  const file = readFileSync(previous.units.host.file, 'utf-8');
  const copy = install('Copy', { home: at.home });
  const loop = join(at.home, 'uncheckable');
  symlinkSync(loop, loop);
  const bytes = JSON.stringify({ ...previous, workingDirectory: loop });
  writeFileSync(join(copy.root, 'service.json'), bytes);
  f.systemd.calls.length = f.out.length = f.err.length = 0;
  expect(await installService({ ...f.ctx(['install', copy.recipe]), root: copy.root }, f.system)).toBe(1);
  expect(f.err.join('\n')).toContain("recorded directory can't be checked");
  expect(f.err.join('\n')).not.toContain('Name the recipe');
  expect(f.err.join('\n')).toEndWith(`Then repeat ${join(copy.root, 'connectome')} service install <recipe>.`);
  expect(f.systemd.calls).toEqual([]);
  expect(readFileSync(join(copy.root, 'service.json'), 'utf-8')).toBe(bytes);
  expect(readFileSync(previous.units.host.file, 'utf-8')).toBe(file);
  expect(f.systemd.running.has(previous.units.host.name)).toBe(true);
});

for (const platform of ['linux', 'darwin'] as const) test(platform + ' existing service start and stop keep legacy install-record compatibility', async () => {
  const at = install();
  const f = fake(at, { platform });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  writeFileSync(join(at.root, 'install.json'), JSON.stringify({ v: 1, dataDir: at.data, extraState: [] }));
  expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
  expect(await runService(f.ctx(['start']), f.system)).toBe(0);
});

test('service identity and new-install binding accept an alias of the same directory', async () => {
  const at = install();
  const alias = join(at.home, 'Alias');
  symlinkSync(at.work, alias);
  writeFileSync(join(at.root, 'install.json'), JSON.stringify({
    v: 1, dataDir: at.data, extraState: [], workingDir: alias,
  }));
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const record = readServiceRecord(at.root)!;
  writeFileSync(join(at.root, 'service.json'), JSON.stringify({ ...record, workingDirectory: alias }));
  expect(serviceLines(join(alias, 'connectome-host'))).not.toBeNull();
  expect((await checkService(join(alias, 'connectome-host'), f.system)).passed).toBe(true);
});

test('a service record path that is a directory names the path before its repair instruction', async () => {
  const at = install();
  const f = fake(at);
  const path = join(at.root, 'service.json');
  mkdirSync(path);
  const checked = await checkService(at.root, f.system);
  expect(checked.passed).toBe(false);
  const line = checked.lines.join('\n');
  expect(line).toContain("The service record at " + path + " can't be read: ");
  expect(line).toContain(" It isn't a file, so no install can write the record there: move it aside or take it " +
    'away, then name the recipe');
  expect(line).toEndWith(' service install <recipe>.');
});

test('a foreign record naming a regular file refuses before its repeat instruction', async () => {
  const at = install('Original');
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const original = readServiceRecord(at.root)!;
  const copy = install('Copy', { home: at.home });
  const path = join(at.home, 'not-a-directory');
  writeFileSync(path, 'file');
  const bytes = JSON.stringify({ ...original, workingDirectory: path });
  writeFileSync(join(copy.root, 'service.json'), bytes);
  f.systemd.calls.length = f.out.length = f.err.length = 0;
  expect(await installService({ ...f.ctx(['install', copy.recipe]), root: copy.root }, f.system)).toBe(1);
  const line = f.err.join('\n');
  expect(line).toContain('not a directory; resolve that before replacing this record.');
  expect(line).not.toContain('Name the recipe');
  expect(line).toEndWith('Then repeat ' + join(copy.root, 'connectome') + ' service install <recipe>.');
  expect(f.systemd.calls).toEqual([]);
  expect(readFileSync(join(copy.root, 'service.json'), 'utf-8')).toBe(bytes);
  expect(f.systemd.running.has(original.units.host.name)).toBe(true);
});

test('a check with a damaged service record gives the explicit-recipe repair instruction', async () => {
  const at = install();
  const f = fake(at);
  writeFileSync(join(at.root, 'service.json'), 'not json');
  const checked = await checkService(at.root, f.system);
  expect(checked.passed).toBe(false);
  expect(checked.lines.join('\n')).toContain(join(at.root, 'service.json'));
  expect(checked.lines.join('\n')).toContain('service install <recipe>');
});

for (const property of ['date', 'data']) test('a valid agent with an unrelated ' + property + ' field still blocks a second host', async () => {
  const at = install('  Résident_日本  ');
  const f = fake(at, { platform: 'darwin' });
  const other = join(at.home, 'Library', 'LaunchAgents', 'typed.plist');
  mkdirSync(dirname(other), { recursive: true });
  writeFileSync(other, 'bplist00 ' + property + ' fixture');
  const run = f.system.run;
  f.system.run = (command, args, env) => command === 'plutil' && args.at(-1) === other
    ? plistFields(args, { Label: 'older.host', WorkingDirectory: at.work }, false)
    : run(command, args, env);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('older.host');
  expect(existsSync(agentPlist(at))).toBe(false);
});

for (const fields of [{ Label: 'unrelated.job' }, { Label: 'unrelated.job', WorkingDirectory: 10 }]) {
  test('an absent or non-string WorkingDirectory is not a matching agent: ' + JSON.stringify(fields), async () => {
    const at = install();
    const f = fake(at, { platform: 'darwin' });
    const other = join(at.home, 'Library', 'LaunchAgents', 'other.plist');
    mkdirSync(dirname(other), { recursive: true });
    writeFileSync(other, 'fixture');
    const run = f.system.run;
    f.system.run = (command, args, env) => command === 'plutil' && args.at(-1) === other
      ? plistFields(args, fields) : run(command, args, env);
    expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
    expect(f.out.join('\n')).not.toContain("isn't ruled out");
  });
}

test('the host unit runs start.js with the recipe from the working directory, with an explicit PATH', async () => {
  const at = install();
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const text = readFileSync(hostUnit(at), 'utf-8');
  expect(text).toContain(`WorkingDirectory=${at.work}\n`);
  expect(text).toContain(`ExecStart="/opt/bun/bin/bun" "${at.root}/start.js" "${at.recipe}" "--headless"\n`);
  expect(text).toContain('Environment="PATH=/opt/bun/bin:/opt/node/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"\n');
  expect(text).toContain('Restart=on-failure\n');
  expect(text).toContain('WantedBy=default.target\n');
  expect(statSync(hostUnit(at)).mode & 0o777).toBe(0o600);
  expect(f.systemd.enabled.has(HOST)).toBe(true);
  expect(f.out).toContain(`Enabled ${HOST}, so systemd starts it at boot.`);
});

test('the host\'s unit gives the host the data directory install.json names', async () => {
  const at = install();
  const kept = join(dirname(at.work), 'kept data');
  mkdirSync(kept);
  writeFileSync(join(at.root, 'install.json'), JSON.stringify({ v: 1, dataDir: kept, extraState: [], workingDir: at.work }));
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(readFileSync(hostUnit(at), 'utf-8')).toContain(`Environment="DATA_DIR=${kept}"\n`);
  expect(f.systemd.starts.find((start) => start.unit === HOST)!.environment).toContain(`DATA_DIR=${kept}`);
});

test('an install without install.json is refused, writing nothing', async () => {
  const at = install('My Resident', { shell: true });
  rmSync(join(at.root, 'install.json'));
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain(join(at.root, 'install.json'));
  nothingWritten(at);
});

test('an install whose install.json names its data directory by no absolute path is refused, writing nothing', async () => {
  const at = install('My Resident', { shell: true });
  writeFileSync(join(at.root, 'install.json'), JSON.stringify({ v: 1, dataDir: 'data', extraState: [], workingDir: at.work }));
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('not an absolute path');
  nothingWritten(at);
});

test('a recipe with a control character is refused without printing it, writing nothing', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', 'https://resident:pass-secret@example.com/r.json\n']), f.system)).toBe(1);
  const said = f.err.join('\n');
  expect(said).toContain('the recipe');
  expect(said).not.toContain('pass-secret');
  nothingWritten(at);
});

test('a relative recipe is resolved from the directory the command runs in', async () => {
  const at = install();
  const f = fake(at, { cwd: at.home });
  expect(await installService(f.ctx(['install', join('My Resident', 'resident.json')]), f.system)).toBe(0);
  expect(readServiceRecord(at.root)!.hostArgs).toEqual([at.recipe, '--headless']);
});

test('the supervised line is added only after the restart check passes, and the host starts with it', async () => {
  const at = install();
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(f.systemd.checkedEnvironment[0]).not.toContain('CONNECTOME_SUPERVISED=1');
  const host = f.systemd.starts.find((start) => start.unit === HOST)!;
  expect(host.environment).toContain('CONNECTOME_SUPERVISED=1');
  expect(readFileSync(hostUnit(at), 'utf-8')).toContain('Environment="CONNECTOME_SUPERVISED=1"\n');
});

test('a drop-in that stops the restart on failure leaves the unit without the line, starts nothing, and says why', async () => {
  const at = install();
  mkdirSync(`${hostUnit(at)}.d`, { recursive: true });
  writeFileSync(join(`${hostUnit(at)}.d`, 'override.conf'), '[Service]\nRestart=no\n');
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(readFileSync(hostUnit(at), 'utf-8')).not.toContain('CONNECTOME_SUPERVISED');
  expect(f.systemd.starts).toEqual([]);
  const said = f.err.join('\n');
  expect(said).toContain('Restart=no');
  expect(said).toContain('left without CONNECTOME_SUPERVISED=1');
});

test('a running host whose restart check fails keeps running, and the next run that passes restarts it', async () => {
  const at = install();
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const startsBefore = f.systemd.starts.length;
  mkdirSync(`${hostUnit(at)}.d`, { recursive: true });
  writeFileSync(join(`${hostUnit(at)}.d`, 'override.conf'), '[Service]\nRestart=no\n');
  expect(await installService(f.ctx(['install']), f.system)).toBe(1);
  expect(f.systemd.starts.length).toBe(startsBefore);
  expect(f.systemd.running.has(HOST)).toBe(true);
  const said = f.err.join('\n');
  expect(said).toContain('keeps what it started with, CONNECTOME_SUPERVISED=1 included');
  expect(said).toContain(`systemctl --user restart ${HOST} restarts it on the unit as it is now: the file this run wrote, ` +
    'with the recipe it was given, and any drop-in over it.');
  expect(said).toContain(`systemctl --user restart ${HOST}`);
  rmSync(`${hostUnit(at)}.d`, { recursive: true });
  expect(await installService(f.ctx(['install']), f.system)).toBe(0);
  expect(f.systemd.starts.slice(startsBefore).map((start) => start.unit)).toEqual([HOST]);
});

test('a drop-in that counts exit 1 as success leaves the unit without the line, and says why', async () => {
  const at = install();
  mkdirSync(`${hostUnit(at)}.d`, { recursive: true });
  writeFileSync(join(`${hostUnit(at)}.d`, 'override.conf'), '[Service]\nSuccessExitStatus=1\n');
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(readFileSync(hostUnit(at), 'utf-8')).not.toContain('CONNECTOME_SUPERVISED');
  expect(f.systemd.starts).toEqual([]);
  expect(f.err.join('\n')).toContain('SuccessExitStatus includes 1');
});

test('a drop-in that keeps exit 75 from restarting the host leaves the unit without the line, and says why', async () => {
  const at = install();
  mkdirSync(`${hostUnit(at)}.d`, { recursive: true });
  writeFileSync(join(`${hostUnit(at)}.d`, 'override.conf'), '[Service]\nRestartPreventExitStatus=75\n');
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(readFileSync(hostUnit(at), 'utf-8')).not.toContain('CONNECTOME_SUPERVISED');
  expect(f.systemd.starts).toEqual([]);
  expect(f.err.join('\n')).toContain('RestartPreventExitStatus includes 75');
  expect(f.err.join('\n')).toContain('Once the unit restarts the host on 75 and 1, repeat this service install command ' +
    'with the same recipe, which sets the line.');
});

test('with linger off it prints the root line, says to run it again, writes nothing, and exits 1', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { linger: false });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  const said = f.err.join('\n');
  expect(said).toContain('sudo loginctl enable-linger resident');
  expect(said).toContain('logs out. Nothing was written. Turn it on as root (or ask whoever administers this machine ' +
    'to), then repeat the same service install command with the same recipe');
  nothingWritten(at);
  expect(f.systemd.enabled.size).toBe(0);
  expect(f.systemd.starts).toEqual([]);
});

test('on a system without systemd or launchd it refuses, writing nothing', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toMatch(/systemd/);
  expect(f.err.join('\n')).toContain('Nothing was written.');
  nothingWritten(at);
});

test('on a platform other than Linux and macOS it refuses, saying nothing was written, and writes nothing', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform: 'freebsd', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err).toEqual(['connectome: service install writes systemd user units on Linux and launch agents on macOS, and ' +
    'this is freebsd. Nothing was written.']);
  nothingWritten(at);
});

test('systemctl and journalctl get XDG_RUNTIME_DIR for this user when the environment lacks it', async () => {
  const at = install();
  const f = fake(at, { env: { PATH: '/usr/bin:/bin' } });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(f.systemd.envs.length).toBeGreaterThan(0);
  for (const env of f.systemd.envs) expect(env.XDG_RUNTIME_DIR).toBe('/run/user/1001');
});

test('an XDG_RUNTIME_DIR already set is kept', async () => {
  const at = install();
  const f = fake(at, { env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: '/run/user/elsewhere' } });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  for (const env of f.systemd.envs) expect(env.XDG_RUNTIME_DIR).toBe('/run/user/elsewhere');
});

test('a systemctl line a refusal gives carries XDG_RUNTIME_DIR when the environment lacks it', async () => {
  const at = install();
  mkdirSync(`${hostUnit(at)}.d`, { recursive: true });
  writeFileSync(join(`${hostUnit(at)}.d`, 'override.conf'), '[Service]\nRestart=no\n');
  const f = fake(at, { env: { PATH: '/usr/bin:/bin' } });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain(`XDG_RUNTIME_DIR=/run/user/1001 systemctl --user cat ${HOST}`);
});

test('a unit file of the same name that runs another install is refused, naming both and the file', async () => {
  const at = install('My Resident', { shell: true });
  mkdirSync(unitsDir(at), { recursive: true });
  writeFileSync(hostUnit(at), '[Service]\nWorkingDirectory=/srv/other/My Resident\n');
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  const said = f.err.join('\n');
  expect(said).toContain('/srv/other/My Resident');
  expect(said).toContain(at.work);
  expect(said).toContain(hostUnit(at));
  expect(readFileSync(hostUnit(at), 'utf-8')).toBe('[Service]\nWorkingDirectory=/srv/other/My Resident\n');
  expect(existsSync(shellUnit(at))).toBe(false);
  expect(existsSync(join(at.work, '.env'))).toBe(false);
  expect(existsSync(join(at.root, 'service.json'))).toBe(false);
});

test('a shell daemon\'s unit of the same name that runs another install is refused, writing nothing', async () => {
  const at = install('My Resident', { shell: true });
  mkdirSync(unitsDir(at), { recursive: true });
  writeFileSync(shellUnit(at), '[Service]\nWorkingDirectory=/srv/other/My Resident\n');
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain(shellUnit(at));
  expect(readFileSync(shellUnit(at), 'utf-8')).toBe('[Service]\nWorkingDirectory=/srv/other/My Resident\n');
  expect(existsSync(hostUnit(at))).toBe(false);
  expect(existsSync(join(at.work, '.env'))).toBe(false);
});

test('a unit of the same name that systemd loads from another file, for another install, is refused naming that file', async () => {
  const at = install();
  const f = fake(at);
  f.systemd.foreign.set(HOST, { workingDirectory: '/srv/other/My Resident', fragment: '/etc/systemd/user/connectome-my-resident.service' });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  const said = f.err.join('\n');
  expect(said).toContain('/etc/systemd/user/connectome-my-resident.service');
  expect(said).toContain('/srv/other/My Resident');
  nothingWritten(at);
});

test('a unit file of the same name with no working directory is refused, as is one that sets it empty', async () => {
  for (const text of ['[Service]\nExecStart=/bin/true\n', '[Service]\nWorkingDirectory=\nExecStart=/bin/true\n']) {
    const at = install();
    mkdirSync(unitsDir(at), { recursive: true });
    writeFileSync(hostUnit(at), text);
    const f = fake(at);
    expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
    expect(f.err.join('\n')).toContain('no working directory set');
    expect(readFileSync(hostUnit(at), 'utf-8')).toBe(text);
  }
});

test('a unit file\'s working directory is read in systemd\'s "~" and "-" forms', async () => {
  const at = install();
  mkdirSync(unitsDir(at), { recursive: true });
  writeFileSync(hostUnit(at), '[Service]\nWorkingDirectory=~\n');
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain(`names ${at.home}, rather than this install in ${at.work}`);
  writeFileSync(hostUnit(at), `[Service]\nWorkingDirectory=-${at.work}\n`);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
});

test('a unit file\'s working directory is its last WorkingDirectory= line, as systemd reads it, also before systemd reloads it', async () => {
  const at = install();
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const ours = readFileSync(hostUnit(at), 'utf-8');
  const text = ours.replace(/^WorkingDirectory=.*$/m, (line) => `${line}\nWorkingDirectory=/srv/other`);
  writeFileSync(hostUnit(at), text);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('/srv/other');
  expect(readFileSync(hostUnit(at), 'utf-8')).toBe(text);
  writeFileSync(hostUnit(at), ours.replace(/^WorkingDirectory=.*$/m, (line) => `WorkingDirectory=/srv/other\n${line}`));
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
});

test('a working directory with no letter or digit in its name is refused', async () => {
  const at = install('···');
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('···');
  expect(existsSync(join(at.root, 'service.json'))).toBe(false);
});

test('another unit that already runs a host from this working directory is refused, naming it, its kind and its file', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  const file = join(unitsDir(at), 'resident\\x2dold.service');
  f.systemd.otherUnits.push({ id: 'resident\\x2dold.service', workingDirectory: at.work, fragment: file });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  const said = f.err.join('\n');
  expect(said).toContain(`resident\\x2dold.service (a user unit, at ${file}) is already set up to run from ${at.work}`);
  expect(said).toContain('both serve its data. XDG_RUNTIME_DIR=/run/user/1001 systemctl --user status ' +
    '\'resident\\x2dold.service\' shows its state, and its process if it\'s running. If that shows nothing uses it, take it ' +
    'away: ');
  expect(said).toContain('take it away: XDG_RUNTIME_DIR=/run/user/1001 systemctl --user stop \'resident\\x2dold.service\', ' +
    'XDG_RUNTIME_DIR=/run/user/1001 systemctl --user disable \'resident\\x2dold.service\', ' +
    `remove '${file}', then XDG_RUNTIME_DIR=/run/user/1001 systemctl --user daemon-reload.`);
  expect(said).toContain('Then repeat this service install command with the same recipe. Nothing was written.');
  expect(said).not.toContain('as root');
  expect(f.systemd.starts).toEqual([]);
  nothingWritten(at);
});

test('a system unit that already runs a host from this working directory is refused with the lines to run as root', async () => {
  const at = install();
  const f = fake(at);
  f.systemd.otherUnits.push({ id: 'old-host.service', workingDirectory: at.work, scope: 'system',
    fragment: '/etc/systemd/system/old-host.service' });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  const said = f.err.join('\n');
  expect(said).toContain('old-host.service (a system unit, at /etc/systemd/system/old-host.service) is already set up ' +
    `to run from ${at.work}`);
  expect(said).toContain('take it away: as root, systemctl stop old-host.service, systemctl disable old-host.service, ' +
    'remove /etc/systemd/system/old-host.service, then systemctl daemon-reload.');
  expect(said).not.toContain('--user');
  nothingWritten(at);
});

test('units of both managers that run a host from this working directory get each manager\'s status line', async () => {
  const at = install();
  const f = fake(at);
  f.systemd.otherUnits.push({ id: 'old-host.service', workingDirectory: at.work, scope: 'system',
    fragment: '/etc/systemd/system/old-host.service' });
  f.systemd.otherUnits.push({ id: 'resident-old.service', workingDirectory: at.work });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('both serve its data. XDG_RUNTIME_DIR=/run/user/1001 systemctl --user status ' +
    'resident-old.service and systemctl status old-host.service shows their states, and their processes if they\'re ' +
    'running. If that shows nothing uses them, take them away: ');
  nothingWritten(at);
});

test('a system unit of the host\'s own name that runs a host from this working directory is refused too', async () => {
  const at = install();
  const f = fake(at);
  f.systemd.otherUnits.push({ id: HOST, workingDirectory: at.work, scope: 'system',
    fragment: `/etc/systemd/system/${HOST}` });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain(`${HOST} (a system unit, at /etc/systemd/system/${HOST}) is already set up to run from`);
  expect(f.err.join('\n')).toContain(`both serve its data. systemctl status ${HOST} shows its state, and its process if it's ` +
    'running. If that shows nothing ' +
    'uses it, take it away: as root, ');
  nothingWritten(at);
});

test('a unit of this install\'s name systemd can\'t be asked about is refused, writing nothing', async () => {
  const at = install();
  const f = fake(at);
  f.systemd.failOnce.set(`show ${HOST}`, 'Failed to connect to bus: No such file or directory');
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('so whether it runs another install can\'t be told. Nothing was written.');
  nothingWritten(at);
});

test('a user unit whose working directory can\'t be resolved is named once, and the install goes on', async () => {
  const at = install();
  const loop = join(dirname(at.home), 'loop');
  symlinkSync(loop, loop);
  const f = fake(at);
  f.systemd.otherUnits.push({ id: 'elsewhere-agent.service', workingDirectory: join(loop, 'srv') });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const named = [...f.out, ...f.err].filter((line) => line.includes('elsewhere-agent.service'));
  expect(named).toHaveLength(1);
  expect(named[0]).toContain('The working directory of elsewhere-agent.service, a user unit, couldn\'t be resolved');
  expect(f.systemd.starts.map((start) => start.unit)).toContain(HOST);
});

test('a system unit whose working directory can\'t be resolved is named once, and the install goes on', async () => {
  const at = install();
  const loop = join(dirname(at.home), 'loop');
  symlinkSync(loop, loop);
  const f = fake(at);
  f.systemd.otherUnits.push({ id: 'elsewhere-agent.service', workingDirectory: join(loop, 'srv'), scope: 'system' });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const named = [...f.out, ...f.err].filter((line) => line.includes('elsewhere-agent.service'));
  expect(named).toHaveLength(1);
  expect(named[0]).toContain('The working directory of elsewhere-agent.service, a system unit, couldn\'t be resolved');
  expect(f.systemd.starts.map((start) => start.unit)).toContain(HOST);
});

test('when another unit refuses the install, the refusal names only the units found, not one whose working directory can\'t be resolved, and nothing says the install goes on', async () => {
  const at = install();
  const loop = join(dirname(at.home), 'loop');
  symlinkSync(loop, loop);
  const f = fake(at);
  f.systemd.otherUnits.push({ id: 'elsewhere-agent.service', workingDirectory: join(loop, 'srv'), scope: 'system' });
  f.systemd.otherUnits.push({ id: 'resident-old.service', workingDirectory: at.work });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('resident-old.service (a user unit, with no unit file) is already set up to run from');
  expect(f.err.join('\n')).toContain('XDG_RUNTIME_DIR=/run/user/1001 systemctl --user status resident-old.service shows its ' +
    'state, and its process if it\'s running.');
  expect(f.err.join('\n')).toContain('take it away: XDG_RUNTIME_DIR=/run/user/1001 systemctl --user stop resident-old.service, ' +
    'then XDG_RUNTIME_DIR=/run/user/1001 systemctl --user daemon-reload.');
  expect([...f.out, ...f.err].join('\n')).not.toContain('elsewhere-agent.service');
  expect([...f.out, ...f.err].join('\n')).not.toContain('the install goes on');
  nothingWritten(at);
});

test('a service manager that can\'t be asked which units run from here is said, and the install goes on', async () => {
  const at = install();
  const f = fake(at);
  f.systemd.systemAnswers = false;
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(f.out.join('\n')).toContain('systemd\'s system manager couldn\'t be asked which of its units run from');
});

test('the first install without a recipe is a usage error', async () => {
  const at = install();
  const f = fake(at);
  expect(await installService(f.ctx(['install']), f.system)).toBe(2);
  expect(f.err.join('\n')).toContain('connectome service install <recipe>');
});

test('a recipe given as a URL is recorded as given', async () => {
  const at = install();
  const f = fake(at);
  expect(await installService(f.ctx(['install', 'https://example.com/resident.json']), f.system)).toBe(0);
  expect(readServiceRecord(at.root)!.hostArgs[0]).toBe('https://example.com/resident.json');
});

test('a recipe that does not exist is refused, naming it', async () => {
  const at = install();
  const f = fake(at);
  expect(await installService(f.ctx(['install', join(at.work, 'nope.json')]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain(join(at.work, 'nope.json'));
});

test('a recipe the host\'s own loader refuses is refused with its words before anything is written', async () => {
  const at = install('My Resident', { shell: true });
  writeFileSync(at.recipe, '{ "name": ');
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err).toEqual(['connectome: the host\'s own recipe loader, run in the working directory with .env, refuses the ' +
    `recipe: ${at.recipe} isn't valid JSON. Nothing was written or restarted.`]);
  nothingWritten(at);
  expect(f.systemd.starts).toEqual([]);
});

test('a re-run with a recipe the host can\'t load leaves the service running as it was, its units and record unchanged', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const files = [hostUnit(at), shellUnit(at), join(at.root, 'service.json'), join(at.work, '.env')];
  const before = files.map((file) => readFileSync(file, 'utf-8'));
  const startsBefore = f.systemd.starts.length;
  const second = join(at.work, 'second.json');
  writeFileSync(second, '{"name": "r", "agent": {"systemPrompt": "${NOT_SET_ANYWHERE}"}}');
  expect(await installService(f.ctx(['install', second]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('references environment variable ${NOT_SET_ANYWHERE} which is not set.');
  expect(files.map((file) => readFileSync(file, 'utf-8'))).toEqual(before);
  expect(f.systemd.starts.length).toBe(startsBefore);
  expect(f.systemd.running.has(HOST)).toBe(true);
});

test('the recipe check gets the unit\'s variables and actual shell settings, not the command\'s environment', async () => {
  const at = install('My Resident', { shell: true });
  writeFileSync(at.recipe, '{"name": "r", "agent": {"systemPrompt": "${SESSION_SERVER_TOKEN} ${FROM_DOTENV}"}}');
  writeFileSync(join(at.work, '.env'), 'FROM_DOTENV="x"\n', { mode: 0o600 });
  const f = fake(at, { env: { PATH: '/usr/bin:/bin', ONLY_IN_THE_SHELL: 'y' } });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const token = /SESSION_SERVER_TOKEN="([0-9a-f]+)"/.exec(readFileSync(join(at.work, '.env'), 'utf-8'))![1]!;
  expect(f.loads).toEqual([{ recipe: at.recipe, work: at.work, env: {
    HOME: at.home, USER: 'resident', LOGNAME: 'resident', PATH: '/opt/bun/bin:/opt/node/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    DATA_DIR: at.data, CONNECTOME_SUPERVISED: '1', CONNECTOME_INSTALL_ROOT: at.root, SESSION_SERVER_PORT: expect.any(String),
    SESSION_SERVER_TOKEN: expect.any(String),
  } }]);
  expect(f.loads[0]!.env.SESSION_SERVER_PORT).toBe(readEnvFile(join(at.work, '.env')).get('SESSION_SERVER_PORT'));
  expect(f.loads[0]!.env.SESSION_SERVER_TOKEN).toBe(token);
  writeFileSync(at.recipe, '{"name": "r", "agent": {"systemPrompt": "${ONLY_IN_THE_SHELL}"}}');
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('references environment variable ${ONLY_IN_THE_SHELL} which is not set.');
});

test('a recipe the host\'s loader couldn\'t be run to the end on is refused, writing nothing', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { recipeLoad: { loads: null, why: 'it hadn\'t loaded after 60 s' } });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err).toEqual(['connectome: whether the host can load the recipe couldn\'t be checked: it hadn\'t loaded after ' +
    '60 s. Nothing was written or restarted. Repeat this service install command with the same recipe once that\'s put right.']);
  nothingWritten(at);
});

test('the loader\'s words show no secret\'s value, and none at all when the secrets can\'t all be kept out of them', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { env: { PATH: '/usr/bin:/bin', ANTHROPIC_API_KEY: 'sk-secret' },
    recipeLoad: (env) => ({ loads: false, words: `bad key sk-secret, token ${env.SESSION_SERVER_TOKEN}` }) });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('refuses the recipe: bad key <ANTHROPIC_API_KEY>, token <SESSION_SERVER_TOKEN>. ' +
    'Nothing was written or restarted.');
  const bare = install();
  mkdirSync(join(bare.work, '.setup'));
  writeFileSync(join(bare.work, '.setup', 'stored-secrets.json'), '{ not json');
  const g = fake(bare, { recipeLoad: { loads: false, words: 'secret words' } });
  expect(await installService(g.ctx(['install', bare.recipe]), g.system)).toBe(1);
  const said = g.err.join('\n');
  expect(said).toContain('the host\'s own recipe loader, run in the working directory with .env, refuses the recipe, ' +
    'and its words aren\'t shown, since the install\'s secrets can\'t all be kept out of them');
  expect(said).not.toContain('secret words');
  expect(existsSync(hostUnit(bare))).toBe(false);
});

test('the actual shell token is replaced whole in the loader\'s words, though a stored secret\'s value lies inside it', async () => {
  const at = install('My Resident', { shell: true });
  writeFileSync(join(at.work, '.env'), 'SESSION_SERVER_PORT="3150"\nSESSION_SERVER_TOKEN="abc123"\nDISCORD_TOKEN="b"\n',
    { mode: 0o600 });
  new StoredSecrets(join(at.work, '.setup')).record('DISCORD_TOKEN');
  const f = fake(at, { recipeLoad: (env) => ({ loads: false, words: `token ${env.SESSION_SERVER_TOKEN} refused` }) });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('refuses the recipe: token <SESSION_SERVER_TOKEN> refused. Nothing was written');
});

test('run from inside the host\'s or the shell daemon\'s unit it refuses, writing nothing, and says who can run it', async () => {
  for (const unit of [HOST, SHELL]) {
    const at = install('My Resident', { shell: true });
    const f = fake(at, { cgroup: `0::/user.slice/user-1001.slice/user@1001.service/app.slice/${unit}\n` });
    expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
    expect(f.err).toEqual([`connectome: connectome service install restarts ${unit}, and this command runs inside it, so ` +
      'that would end this command partway, before its record and its check. Nothing was written. Ask whoever runs ' +
      'this machine to run it from a terminal outside the resident\'s service, such as over ssh.']);
    nothingWritten(at);
  }
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  rmSync(join(at.work, 'node_modules', 'term-sessions-mcp'), { recursive: true });
  f.system.cgroup = () => `0::/user.slice/user-1001.slice/user@1001.service/app.slice/${SHELL}/sessions\n`;
  expect(await installService(f.ctx(['install']), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain(`connectome service install stops ${SHELL}, and this command runs inside it`);
  expect(existsSync(shellUnit(at))).toBe(true);
});

test('run from a login session, another unit, or a system unit of the host\'s name, it installs', async () => {
  for (const cgroup of ['0::/user.slice/user-1001.slice/session-4.scope\n',
    '0::/user.slice/user-1001.slice/user@1001.service/app.slice/connectome-my-resident-two.service\n',
    `0::/system.slice/${HOST}\n`]) {
    const at = install();
    const f = fake(at, { cgroup });
    expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  }
});

test('on macOS, run from inside either of its launch agents, it refuses, writing nothing', async () => {
  for (const label of ['com.animalabs.connectome.my-resident', 'com.animalabs.connectome.my-resident.shell']) {
    const at = install('My Resident', { shell: true });
    const f = fake(at, { platform: 'darwin', linger: null, env: { PATH: '/usr/bin:/bin', XPC_SERVICE_NAME: label } });
    expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
    expect(f.err.join('\n')).toContain(`restarts ${label}, and this command runs inside it`);
    expect(existsSync(agentPlist(at))).toBe(false);
    expect(f.systemd.bootstraps).toEqual([]);
  }
});

test('a service record that can\'t be read is written again when the recipe is given, and named with the way out when not', async () => {
  const at = install();
  const f = fake(at);
  writeFileSync(join(at.root, 'service.json'), 'not json');
  expect(await installService(f.ctx(['install']), f.system)).toBe(1);
  const said = f.err.join('\n');
  expect(said).toContain(join(at.root, 'service.json'));
  expect(said).toContain('connectome service install <recipe>');
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(f.out.join('\n')).toContain(join(at.root, 'service.json'));
  expect(f.out.join('\n')).toContain('This run replaces it with a new record once it has written a unit file.');
  expect(f.out.join('\n')).not.toContain('Name the recipe');
  expect(readServiceRecord(at.root)!.hostArgs[0]).toBe(at.recipe);
});

test('successful re-runs restart the shell daemon and the host on their written units with the recorded recipe', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  for (const run of [1, 2]) {
    const startsBefore = f.systemd.starts.length;
    f.out.length = 0;
    expect(await installService(f.ctx(['install']), f.system)).toBe(0);
    expect(f.systemd.starts.slice(startsBefore).map((start) => start.unit)).toEqual([SHELL, HOST]);
    expect(f.systemd.starts.at(-1)!.execStart).toContain(`"${at.recipe}"`);
    expect(f.out).toContain(`Restarted ${SHELL}.`);
    expect(f.out).toContain(`Restarted ${HOST}.`);
  }
  expect(readServiceRecord(at.root)!.hostArgs[0]).toBe(at.recipe);
});

test('a re-run with another recipe rewrites the unit and restarts the host, saying so', async () => {
  const at = install();
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const startsBefore = f.systemd.starts.length;
  const second = join(at.work, 'second.json');
  writeFileSync(second, '{}');
  f.out.length = 0;
  expect(await installService(f.ctx(['install', second]), f.system)).toBe(0);
  expect(f.systemd.starts.slice(startsBefore).map((start) => start.unit)).toEqual([HOST]);
  expect(f.systemd.starts.at(-1)!.execStart).toContain(`"${second}"`);
  expect(f.out.join('\n')).toContain(`Restarted ${HOST}`);
});

test('a re-run starts a unit that has stopped', async () => {
  const at = install();
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  f.systemd.running.clear();
  const startsBefore = f.systemd.starts.length;
  expect(await installService(f.ctx(['install']), f.system)).toBe(0);
  expect(f.systemd.starts.slice(startsBefore).map((start) => start.unit)).toEqual([HOST]);
});

test('a run restarts a host systemd stopped at its start limit, since the run is the request to start it', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  f.systemd.running.delete(HOST);
  f.systemd.startLimited.add(HOST);
  const startsBefore = f.systemd.starts.length;
  expect(await installService(f.ctx(['install']), f.system)).toBe(0);
  expect(f.systemd.starts.slice(startsBefore).map((start) => start.unit)).toEqual([SHELL, HOST]);
  expect(f.out).toContain(`Started ${HOST}.`);
});

test('a run that rewrote the unit but couldn\'t restart the host leaves the next run to restart it', async () => {
  const at = install();
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const second = join(at.work, 'second.json');
  writeFileSync(second, '{}');
  f.systemd.failOnce.set(`restart ${HOST}`, 'Job for connectome-my-resident.service failed.');
  const startsBefore = f.systemd.starts.length;
  expect(await installService(f.ctx(['install', second]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain(`restart ${HOST} failed: Job for connectome-my-resident.service failed. Run ` +
    'connectome service install again once that\'s put right.');
  expect(f.systemd.starts.length).toBe(startsBefore);
  expect(await installService(f.ctx(['install']), f.system)).toBe(0);
  expect(f.systemd.starts.slice(startsBefore).map((start) => start.unit)).toEqual([HOST]);
  expect(f.systemd.starts.at(-1)!.execStart).toContain(`"${second}"`);
});

test('a refusal before any unit is written leaves the record as it was', async () => {
  const at = install();
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const before = readFileSync(join(at.root, 'service.json'), 'utf-8');
  shellPackage(at.work);
  mkdirSync(join(at.work, '.setup'), { recursive: true });
  writeFileSync(join(at.work, '.setup', 'stored-secrets.json'), '{ not json');
  const second = join(at.work, 'second.json');
  writeFileSync(second, JSON.stringify({ mcpServers: { shell: { command: 'terminal-sessions-mcp' } } }));
  expect(await installService(f.ctx(['install', second]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('stored secrets');
  expect(f.err.join('\n')).toContain('. No unit was written.');
  expect(readFileSync(join(at.root, 'service.json'), 'utf-8')).toBe(before);
  expect(existsSync(shellUnit(at))).toBe(false);
});

test('a shell daemon this install no longer has is stopped, disabled and removed, and said', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  rmSync(join(at.work, 'node_modules', 'term-sessions-mcp'), { recursive: true });
  f.out.length = 0;
  expect(await installService(f.ctx(['install']), f.system)).toBe(0);
  expect(existsSync(shellUnit(at))).toBe(false);
  expect(f.systemd.running.has(SHELL)).toBe(false);
  expect(f.systemd.enabled.has(SHELL)).toBe(false);
  expect(f.out.join('\n')).toContain(`Stopped and removed ${SHELL}`);
  expect(readServiceRecord(at.root)!.units.shell).toBeUndefined();
});

test('a shell daemon this install no longer has, still running with its unit file gone, is left running and named with the line that stops it', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  rmSync(shellUnit(at));
  f.systemd.run('systemctl', ['--user', 'daemon-reload'], {});
  rmSync(join(at.work, 'node_modules', 'term-sessions-mcp'), { recursive: true });
  f.out.length = 0;
  expect(await installService(f.ctx(['install']), f.system)).toBe(1);
  expect(f.systemd.running.has(SHELL)).toBe(true);
  expect(readServiceRecord(at.root)!.units.shell!.name).toBe(SHELL);
  const said = f.out.filter((line) => line.includes(`${SHELL} is still running, but its file, ${shellUnit(at)}, is gone`));
  expect(said).toHaveLength(1);
  expect(said[0]).toContain(`systemctl --user stop ${SHELL}`);
});

test('a file-less shell whose identity is lost after reload stays recorded with its manual stop line', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const before = readFileSync(join(at.work, '.env'), 'utf-8');
  rmSync(shellUnit(at));
  rmSync(join(at.work, 'node_modules', 'term-sessions-mcp'), { recursive: true });
  f.out.length = 0;
  expect(await installService(f.ctx(['install']), f.system)).toBe(1);
  expect(f.systemd.running.has(SHELL)).toBe(true);
  expect(readServiceRecord(at.root)!.units.shell!.name).toBe(SHELL);
  expect(readFileSync(join(at.work, '.env'), 'utf-8')).toBe(before);
  expect(f.out.join('\n')).toContain('still recorded');
  expect(f.out.join('\n')).toContain('retries retiring');
  expect(f.out.join('\n')).toContain('service start includes it');
  expect(f.out.join('\n')).toContain(`${SHELL} is still running, but its file, ${shellUnit(at)}, is gone`);
  expect(f.out.join('\n')).toContain(`systemctl --user stop ${SHELL}`);
});

test('a unit of this install\'s name still running with its unit file gone is refused, naming the line that stops it', async () => {
  const at = install();
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  rmSync(hostUnit(at));
  f.systemd.run('systemctl', ['--user', 'daemon-reload'], {});
  const startsBefore = f.systemd.starts.length;
  expect(await installService(f.ctx(['install']), f.system)).toBe(1);
  const said = f.err.join('\n');
  expect(said).toContain(`${HOST} is still running, but its file, ${hostUnit(at)}, is gone`);
  expect(said).toContain(`systemctl --user stop ${HOST}`);
  expect(existsSync(hostUnit(at))).toBe(false);
  expect(f.systemd.starts.length).toBe(startsBefore);
});

test('a live shell configured for another directory stays tracked until stopped, then leaves that unit alone', async () => {
  const at = install('My Resident', { shell: true, homeName: 'my home' });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  mkdirSync(`${shellUnit(at)}.d`, { recursive: true });
  writeFileSync(join(`${shellUnit(at)}.d`, 'override.conf'), '[Service]\nWorkingDirectory=/srv/other\n');
  f.systemd.run('systemctl', ['--user', 'daemon-reload'], {});
  rmSync(join(at.work, 'node_modules', 'term-sessions-mcp'), { recursive: true });
  f.out.length = 0;
  expect(await installService(f.ctx(['install']), f.system)).toBe(1);
  expect(existsSync(shellUnit(at))).toBe(true);
  expect(f.systemd.running.has(SHELL)).toBe(true);
  expect(f.systemd.enabled.has(SHELL)).toBe(true);
  expect(readServiceRecord(at.root)!.units.shell!.name).toBe(SHELL);
  expect(readEnvFile(join(at.work, '.env')).has('SESSION_SERVER_TOKEN')).toBe(true);
  expect(new StoredSecrets(join(at.work, '.setup')).names()).toContain('SESSION_SERVER_TOKEN');
  expect(f.out.join('\n')).toContain('Its running process may still be this install\'s');
  expect(f.out.join('\n')).toContain('/srv/other');
  expect(f.out.join('\n')).toContain('Shell retirement is incomplete');
  expect(f.out.join('\n')).toContain('shell settings were kept');
  expect(f.out.join('\n')).toContain('Resolve the reported state or ownership problem');
  expect(f.out.join('\n')).not.toContain('to finish cleanup');
  expect(await runService(f.ctx(['stop']), f.system)).toBe(1);
  expect(await runService(f.ctx(['start']), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('config');
  expect(f.err.join('\n')).toContain('Its running process may still be this install\'s');
  f.systemd.running.delete(SHELL);
  expect(await installService(f.ctx(['install']), f.system)).toBe(0);
  expect(readServiceRecord(at.root)!.units.shell).toBeUndefined();
  expect(existsSync(shellUnit(at))).toBe(true);
  expect(f.systemd.enabled.has(SHELL)).toBe(true);
  expect(f.out.join('\n')).toContain('This install no longer tracks it and left it as it is');
});

test('with the record unreadable, a shell daemon of this install\'s name is removed once its package is gone', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  writeFileSync(join(at.root, 'service.json'), 'not json');
  rmSync(join(at.work, 'node_modules', 'term-sessions-mcp'), { recursive: true });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(existsSync(shellUnit(at))).toBe(false);
  expect(f.systemd.running.has(SHELL)).toBe(false);
});

test('a failed obsolete-daemon cleanup leaves the replacement recorded and a retry removes the daemon', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  rmSync(join(at.work, 'node_modules', 'term-sessions-mcp'), { recursive: true });
  f.systemd.failOnce.set(`disable ${SHELL}`, 'Failed to disable unit: Access denied');
  expect(await installService(f.ctx(['install']), f.system)).toBe(1);
  expect(readServiceRecord(at.root)!.units.shell!.name).toBe(SHELL);
  expect(existsSync(shellUnit(at))).toBe(true);
  expect(f.out.join('\n')).toContain('still recorded');
  expect(await installService(f.ctx(['install']), f.system)).toBe(0);
  expect(existsSync(shellUnit(at))).toBe(false);
  expect(readServiceRecord(at.root)!.units.shell).toBeUndefined();
});

test('units an earlier record names under another install\'s names are left alone, and nothing is said of them', async () => {
  const first = install('My Resident', { shell: true });
  const f = fake(first);
  expect(await installService(f.ctx(['install', first.recipe]), f.system)).toBe(0);
  const copy = install('Other Resident', { home: first.home });
  writeFileSync(join(copy.root, 'service.json'), readFileSync(join(first.root, 'service.json')));
  const g = fake(copy);
  g.systemd = f.systemd;
  g.system.run = (command, args, env) => f.systemd.run(command, args, env);
  expect(await installService(g.ctx(['install', copy.recipe]), g.system)).toBe(0);
  expect(existsSync(hostUnit(first))).toBe(true);
  expect(existsSync(shellUnit(first))).toBe(true);
  expect(f.systemd.running.has(HOST)).toBe(true);
  expect(f.systemd.running.has(SHELL)).toBe(true);
  expect([...g.out, ...g.err].join('\n')).not.toContain('connectome-my-resident');
});

test('with terminal-sessions installed, the shell daemon gets its own unit with a free port and a token', async () => {
  const at = install('My Resident', { shell: true });
  writeFileSync(join(at.work, '.env'), 'ANTHROPIC_API_KEY="sk-not-for-the-shell"\n', { mode: 0o600 });
  const f = fake(at, { taken: [3100, 3101] });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const env = readFileSync(join(at.work, '.env'), 'utf-8');
  expect(env).toContain('SESSION_SERVER_PORT="3102"');
  const token = /SESSION_SERVER_TOKEN="([0-9a-f]+)"/.exec(env)?.[1];
  expect(token).toHaveLength(64);
  expect(statSync(join(at.work, '.env')).mode & 0o777).toBe(0o600);
  const text = readFileSync(shellUnit(at), 'utf-8');
  expect(text).toContain(`ExecStart="/opt/node/bin/node" "${at.work}/node_modules/term-sessions-mcp/dist/src/server/start-session-server.js" "--host" "localhost" "--headless"\n`);
  expect(text).toContain('Environment="SESSION_SERVER_PORT=3102"\n');
  expect(text).toContain(`Environment="SESSION_SERVER_TOKEN=${token}"\n`);
  expect(text).not.toContain('--token');
  expect(f.systemd.enabled.has(SHELL)).toBe(true);
  expect(text).not.toContain('sk-not-for-the-shell');
  expect(text).not.toContain('EnvironmentFile');
  expect(statSync(shellUnit(at)).mode & 0o777).toBe(0o600);
  const host = readFileSync(hostUnit(at), 'utf-8');
  expect(host).toContain(`Wants=${SHELL}\n`);
  expect(host).toContain(`After=${SHELL}\n`);
  expect(new StoredSecrets(join(at.work, '.setup')).names()).toContain('SESSION_SERVER_TOKEN');
  expect([...f.out, ...f.err].join('\n')).not.toContain(token!);
  expect(f.out.join('\n')).toContain(`Port 3102 was free when picked, so it's the resident's shell daemon's port, on ` +
    `localhost only: written to ${join(at.work, '.env')} as SESSION_SERVER_PORT.`);
  expect(f.out).toContain(`Enabled ${SHELL} and ${HOST}, so systemd starts them at boot.`);
  expect(readServiceRecord(at.root)!.units.shell!.name).toBe(SHELL);
});

test('a port and token already in .env are kept, in the unit and in .env', async () => {
  const at = install('My Resident', { shell: true });
  writeFileSync(join(at.work, '.env'), 'SESSION_SERVER_PORT="3150"\nSESSION_SERVER_TOKEN="abc123"\n', { mode: 0o600 });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const text = readFileSync(shellUnit(at), 'utf-8');
  expect(text).toContain('Environment="SESSION_SERVER_PORT=3150"\n');
  expect(text).toContain('Environment="SESSION_SERVER_TOKEN=abc123"\n');
  const env = readFileSync(join(at.work, '.env'), 'utf-8');
  expect(env).toContain('SESSION_SERVER_PORT="3150"');
  expect(env).toContain('SESSION_SERVER_TOKEN="abc123"');
});

test('with 3100 to 3199 held, the shell daemon gets the next free port', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { taken: Array.from({ length: 100 }, (_, n) => 3100 + n) });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(readFileSync(join(at.work, '.env'), 'utf-8')).toContain('SESSION_SERVER_PORT="3200"');
});

test('with no port free for the shell daemon below the ephemeral ranges it refuses, writing nothing', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { taken: Array.from({ length: 32768 - 3100 }, (_, n) => 3100 + n) });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('no port from 3100 to 32767 is free for the resident\'s shell daemon: set ' +
    `SESSION_SERVER_PORT in ${join(at.work, '.env')}`);
  nothingWritten(at);
});

test('a stored shell port that isn\'t a port is refused without printing it, writing nothing', async () => {
  const at = install('My Resident', { shell: true });
  writeFileSync(join(at.work, '.env'), 'SESSION_SERVER_PORT="sk-pasted-credential"\n', { mode: 0o600 });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  const said = [...f.out, ...f.err].join('\n');
  expect(said).toContain(`SESSION_SERVER_PORT in ${join(at.work, '.env')} isn't an integer from 1 to 65535.`);
  expect(said).not.toContain('sk-pasted-credential');
  expect(existsSync(hostUnit(at))).toBe(false);
});

test('a .env others can read that gets the shell daemon\'s new token is made readable by its user alone, and said', async () => {
  const at = install('My Resident', { shell: true });
  writeFileSync(join(at.work, '.env'), 'OTHER="x"\n');
  chmodSync(join(at.work, '.env'), 0o644);
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(statSync(join(at.work, '.env')).mode & 0o777).toBe(0o600);
  expect(f.out.join('\n')).toContain('is to hold the shell daemon\'s token and was open to others than resident (mode 644)');
});

test('a .env others can read, holding the shell daemon\'s token, is made readable by its user alone, and said', async () => {
  const at = install('My Resident', { shell: true });
  writeFileSync(join(at.work, '.env'), 'SESSION_SERVER_PORT="3150"\nSESSION_SERVER_TOKEN="abc123"\n');
  chmodSync(join(at.work, '.env'), 0o644);
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(statSync(join(at.work, '.env')).mode & 0o777).toBe(0o600);
  expect(f.out.join('\n')).toContain('holds the shell daemon\'s token and was open to others than resident (mode 644)');
});

test('without terminal-sessions installed there is no shell unit', async () => {
  const at = install();
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(existsSync(shellUnit(at))).toBe(false);
  expect(readFileSync(hostUnit(at), 'utf-8')).not.toContain('Wants=');
  expect(readServiceRecord(at.root)!.units.shell).toBeUndefined();
});

test('a shell with no Node on PATH is refused before anything is written', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { node: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toMatch(/Node/);
  nothingWritten(at);
});

test('a terminal-sessions package.json that isn\'t JSON is refused, naming it, before anything is written', async () => {
  const at = install('My Resident', { shell: true });
  writeFileSync(join(at.work, 'node_modules', 'term-sessions-mcp', 'package.json'), '{ not json');
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  const said = f.err.join('\n');
  expect(said).toContain(join(at.work, 'node_modules', 'term-sessions-mcp', 'package.json'));
  expect(said).not.toContain('    at ');
  nothingWritten(at);
});

test('a terminal-sessions package with no package.json is refused, and its shell daemon\'s unit is kept', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  rmSync(join(at.work, 'node_modules', 'term-sessions-mcp', 'package.json'));
  expect(await installService(f.ctx(['install']), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain(join(at.work, 'node_modules', 'term-sessions-mcp', 'package.json'));
  expect(existsSync(shellUnit(at))).toBe(true);
  expect(f.systemd.running.has(SHELL)).toBe(true);
});

test.skipIf(process.getuid?.() === 0)('a terminal-sessions package that can\'t be read, or can\'t be looked for, is refused, and its shell daemon\'s unit is kept', async () => {
  for (const unreadable of [join('node_modules', 'term-sessions-mcp'), 'node_modules']) {
    const at = install('My Resident', { shell: true });
    const f = fake(at);
    expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
    chmodSync(join(at.work, unreadable), 0o000);
    try {
      expect(await installService(f.ctx(['install']), f.system)).toBe(1);
    } finally {
      chmodSync(join(at.work, unreadable), 0o755);
    }
    expect(f.err.join('\n')).toContain(join(at.work, 'node_modules', 'term-sessions-mcp'));
    expect(existsSync(shellUnit(at))).toBe(true);
    expect(f.systemd.running.has(SHELL)).toBe(true);
  }
});

test('a terminal-sessions package that is a link to nothing is refused, and its shell daemon\'s unit is kept', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const pkg = join(at.work, 'node_modules', 'term-sessions-mcp');
  rmSync(pkg, { recursive: true });
  symlinkSync(join(at.work, 'nowhere'), pkg);
  expect(await installService(f.ctx(['install']), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain(join(pkg, 'package.json'));
  expect(existsSync(shellUnit(at))).toBe(true);
  expect(f.systemd.running.has(SHELL)).toBe(true);
});

test('a .env that can\'t be read is refused, naming it, writing nothing, with or without a shell', async () => {
  for (const shell of [false, true]) {
    const at = install('My Resident', { shell });
    mkdirSync(join(at.work, '.env'));
    const f = fake(at);
    expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
    const said = f.err.join('\n');
    expect(said).toContain(`${join(at.work, '.env')} can't be read`);
    expect(said).not.toContain('    at ');
    expect(f.systemd.starts).toEqual([]);
    expect(existsSync(hostUnit(at))).toBe(false);
    expect(existsSync(shellUnit(at))).toBe(false);
    expect(existsSync(join(at.root, 'service.json'))).toBe(false);
  }
});



test('a .env that is a link is refused at the start, naming where it leads, with or without a shell, writing nothing', async () => {
  const cases: Array<{ shell: boolean; held: string | null; mode: number }> = [
    { shell: true, held: 'OTHER="1"\n', mode: 0o600 },
    { shell: true, held: 'SESSION_SERVER_PORT="3107"\n', mode: 0o600 },
    { shell: true, held: 'SESSION_SERVER_TOKEN="abc123"\n', mode: 0o600 },
    { shell: true, held: 'SESSION_SERVER_PORT="3107"\nSESSION_SERVER_TOKEN="abc123"\n', mode: 0o600 },
    { shell: true, held: 'SESSION_SERVER_PORT="3107"\nSESSION_SERVER_TOKEN="abc123"\n', mode: 0o644 },
    { shell: false, held: 'ANTHROPIC_API_KEY="sk-x"\n', mode: 0o600 },
    { shell: false, held: null, mode: 0o600 },
  ];
  for (const { shell, held, mode } of cases) {
    const at = install('My Resident', { shell });
    const target = join(at.work, 'shared.env');
    if (held !== null) {
      writeFileSync(target, held);
      chmodSync(target, mode);
    }
    symlinkSync(target, join(at.work, '.env'));
    const f = fake(at);
    expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
    const said = f.err.join('\n');
    expect(said).toContain(`${join(at.work, '.env')} is a link to ${target}.`);
    expect(said).toContain('Replace the link with the file it leads to, if that\'s there, or take it away, then repeat this service install command with the same recipe. Nothing was written.');
    if (held !== null) {
      expect(readFileSync(target, 'utf-8')).toBe(held);
      expect(statSync(target).mode & 0o777).toBe(mode);
    }
    expect(lstatSync(join(at.work, '.env')).isSymbolicLink()).toBe(true);
    expect(f.systemd.starts).toEqual([]);
    expect(existsSync(join(at.work, '.setup', 'stored-secrets.json'))).toBe(false);
    expect(existsSync(hostUnit(at))).toBe(false);
    expect(existsSync(shellUnit(at))).toBe(false);
    expect(existsSync(join(at.root, 'service.json'))).toBe(false);
  }
});

test('a .env with a line outside setup\'s form is refused by that line before anything is written, showing none of it', async () => {
  const cases = [
    { held: 'OTHER="1"\nPEM="-----BEGIN KEY-----\nsecret-body-line\n-----END KEY-----"\n',
      hidden: ['PEM', '-----BEGIN KEY-----', 'secret-body-line', '-----END KEY-----'] },
    { held: 'OTHER="1"\nNOTE=two secret words\n', hidden: ['NOTE', 'two secret words'] },
  ];
  for (const { held, hidden } of cases) {
    const at = install('My Resident', { shell: true });
    writeFileSync(join(at.work, '.env'), held, { mode: 0o644 });
    const f = fake(at);
    expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
    const said = [...f.out, ...f.err].join('\n');
    expect(said).toContain(`${join(at.work, '.env')}, line 2,`);
    expect(said).toContain('Then repeat this service install command with the same recipe. Nothing was written.');
    for (const text of hidden) expect(said).not.toContain(text);
    expect(readFileSync(join(at.work, '.env'), 'utf-8')).toBe(held);
    expect(statSync(join(at.work, '.env')).mode & 0o777).toBe(0o644);
    expect(existsSync(join(at.work, '.setup', 'stored-secrets.json'))).toBe(false);
    expect(existsSync(hostUnit(at))).toBe(false);
    expect(existsSync(join(at.root, 'service.json'))).toBe(false);
  }
});

test('a .env outside setup\'s form is refused also with no shell, and with nothing to write to it', async () => {
  for (const shell of [false, true]) {
    const at = install('My Resident', { shell });
    const held = 'SESSION_SERVER_PORT="3107"\nSESSION_SERVER_TOKEN="abc123"\nPEM="first-secret-half\nsecond-secret-half"\n';
    writeFileSync(join(at.work, '.env'), held, { mode: 0o600 });
    const f = fake(at);
    expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
    const said = [...f.out, ...f.err].join('\n');
    expect(said).toContain(`${join(at.work, '.env')}, line 3,`);
    expect(said).toContain('Then repeat this service install command with the same recipe. Nothing was written.');
    for (const text of ['PEM', 'secret-half']) expect(said).not.toContain(text);
    expect(readFileSync(join(at.work, '.env'), 'utf-8')).toBe(held);
    expect(f.systemd.starts).toEqual([]);
    expect(existsSync(join(at.work, '.setup', 'stored-secrets.json'))).toBe(false);
    expect(existsSync(hostUnit(at))).toBe(false);
    expect(existsSync(shellUnit(at))).toBe(false);
    expect(existsSync(join(at.root, 'service.json'))).toBe(false);
  }
});


test.skipIf(process.getuid?.() === 0)('a .env that can\'t be written is refused, naming it, after it\'s made readable by its user alone', async () => {
  const at = install('My Resident', { shell: true });
  writeFileSync(join(at.work, '.env'), 'SESSION_SERVER_TOKEN="abc123"\n');
  chmodSync(join(at.work, '.env'), 0o644);
  mkdirSync(join(at.work, '.setup'));
  const f = fake(at);
  chmodSync(at.work, 0o555);
  try {
    expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  } finally {
    chmodSync(at.work, 0o755);
  }
  const said = f.err.join('\n');
  expect(said).toContain(`SESSION_SERVER_PORT can't be written to ${join(at.work, '.env')}`);
  expect(said).not.toContain('    at ');
  expect(statSync(join(at.work, '.env')).mode & 0o777).toBe(0o600);
  expect(f.out.join('\n')).toContain('mode 644');
  expect(existsSync(hostUnit(at))).toBe(false);
});

test.skipIf(process.getuid?.() === 0)('a unit file that can\'t be written is refused, naming it, and the record stays as it was', async () => {
  const at = install();
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const before = readFileSync(join(at.root, 'service.json'), 'utf-8');
  const second = join(at.work, 'second.json');
  writeFileSync(second, '{}');
  const startsBefore = f.systemd.starts.length;
  chmodSync(unitsDir(at), 0o555);
  try {
    expect(await installService(f.ctx(['install', second]), f.system)).toBe(1);
  } finally {
    chmodSync(unitsDir(at), 0o755);
  }
  const said = f.err.join('\n');
  expect(said).toContain(`${hostUnit(at)} can't be written`);
  expect(said).not.toContain('    at ');
  expect(readFileSync(join(at.root, 'service.json'), 'utf-8')).toBe(before);
  expect(f.systemd.starts.length).toBe(startsBefore);
});

test('a shell daemon that isn\'t active fails the check, which shows its latest start\'s last lines above the line that says to put right what they show', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  f.systemd.exiting.add(SHELL);
  f.systemd.exitStatus.set(SHELL, '2');
  f.systemd.prints = (unit) => unit === SHELL
    ? ['session-server: starting', 'Error: Cannot find module \'node-pty\'']
    : ['Loaded recipe: resident', '[discord-mcpl] Slash command setup failed: Missing Access'];
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  const said = f.out.join('\n');
  expect(said).toContain(`${SHELL} is failed, not active: journalctl --user -u ${SHELL} shows its log`);
  const shown = 'The journal\'s last lines from the shell daemon\'s latest start, which ended (last 200 entries):\n  | session-server: starting\n' +
    '  | Error: Cannot find module \'node-pty\'';
  expect(said).toContain(shown);
  expect(said.indexOf(shown)).toBeLessThan(said.indexOf('Put right what the lines above show'));
  expect(f.out).toContain('  | [discord-mcpl] Slash command setup failed: Missing Access');
  expect(f.out).toContain('systemd hasn\'t restarted it since it was last started, and its process last exited with 2.');
});

test('service.json records the manager, units, host arguments, working directory and logs', async () => {
  const at = install();
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const record = readServiceRecord(at.root)!;
  expect(record).toMatchObject({
    v: 1,
    manager: 'systemd-user',
    units: { host: { name: HOST, file: hostUnit(at) } },
    hostArgs: [at.recipe, '--headless'],
    workingDirectory: at.work,
    logs: { kind: 'journal' },
  });
  expect(statSync(join(at.root, 'service.json')).mode & 0o777).toBe(0o600);
});

test('readServiceRecord is null without a record and names the file for one it cannot read', () => {
  const at = install();
  expect(readServiceRecord(at.root)).toBeNull();
  writeFileSync(join(at.root, 'service.json'), '{"v":1,"manager":"cron"}');
  expect(() => readServiceRecord(at.root)).toThrow(join(at.root, 'service.json'));
  writeFileSync(join(at.root, 'service.json'), 'not json');
  expect(() => readServiceRecord(at.root)).toThrow(join(at.root, 'service.json'));
});

test('the install ends with the check: active, no restarts, restarts on 75 and 1, and the host\'s first log lines', async () => {
  const at = install();
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const said = f.out.join('\n');
  expect(said).toContain(`${HOST} is active`);
  expect(said).toContain('systemd hasn\'t restarted it since it was last started.');
  expect(said).toContain('It restarts the host when it exits with 75 and with 1');
  expect(said).toContain('  | Loaded recipe: resident');
});

test('checkService fails a host unit systemd runs from another directory, naming it', async () => {
  const at = install();
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  mkdirSync(`${hostUnit(at)}.d`, { recursive: true });
  writeFileSync(join(`${hostUnit(at)}.d`, 'override.conf'), '[Service]\nWorkingDirectory=/srv/other\n');
  f.systemd.run('systemctl', ['--user', 'daemon-reload'], {});
  const checked = await checkService(at.root, f.system);
  expect(checked.passed).toBe(false);
  expect(checked.lines.join('\n')).toContain(`systemd runs ${HOST} in /srv/other, not ${at.work}`);
});

test('checkService names the line that stops a recorded unit still running with its file gone', async () => {
  const at = install();
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  rmSync(hostUnit(at));
  f.systemd.run('systemctl', ['--user', 'daemon-reload'], {});
  const checked = await checkService(at.root, f.system);
  expect(checked.passed).toBe(false);
  const said = checked.lines.join('\n');
  expect(said).toContain(`${HOST} is running, but systemd can't load its unit (not-found)`);
  expect(said).toContain(`systemctl --user stop ${HOST}`);
});

test('checkService fails a host unit a drop-in keeps from restarting, saying so', async () => {
  const at = install();
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  mkdirSync(`${hostUnit(at)}.d`, { recursive: true });
  writeFileSync(join(`${hostUnit(at)}.d`, 'override.conf'), '[Service]\nRestart=no\n');
  f.systemd.run('systemctl', ['--user', 'daemon-reload'], {});
  const checked = await checkService(at.root, f.system);
  expect(checked.passed).toBe(false);
  expect(checked.lines.join('\n')).toContain('It doesn\'t restart the host both when it exits with 75 and with 1 (Restart=no)');
});

test('a host that keeps failing fails the install\'s check, with its restarts and its latest start\'s last lines, nothing in them marked', async () => {
  const at = install();
  const f = fake(at, { ready: false });
  f.systemd.crashing.add(HOST);
  f.systemd.prints = () => ['Loaded recipe: resident', 'Fatal error: error: Failed to start server. Is port 7340 in use?'];
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  const said = [...f.out, ...f.err].join('\n');
  expect(said).toContain('The journal\'s last lines from the host\'s latest start, which ended (last 200 entries):\n  | Loaded recipe: resident\n' +
    '  | Fatal error: error: Failed to start server');
  expect(said).not.toContain('  ! ');
  expect(said).toMatch(/restarted it \d+ times? since it was last started, and its process last exited with 1\./);
  expect(existsSync(join(at.root, 'service.json'))).toBe(true);
});

test('a failed check after a recipe change names the recipe its service ran before, and every failed check says what to do next', async () => {
  const at = install();
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  f.systemd.crashing.add(HOST);
  const second = join(at.work, 'second.json');
  writeFileSync(second, '{}');
  f.out.length = 0;
  expect(await installService(f.ctx(['install', second]), f.system)).toBe(1);
  expect(f.out).toContain(`Before this run, service.json recorded the recipe ${at.recipe}: connectome service install ` +
    `'${at.recipe}' puts it back, if the host's recipe loader still takes it.`);
  const next = 'Put right what the lines above show, then run connectome service install again. Until then systemd ' +
    'restarts the host each time it fails, while it has its unit loaded and its start limit allows; the run clears ' +
    'that limit.';
  expect(f.out).toContain(next);
  f.out.length = 0;
  expect(await installService(f.ctx(['install']), f.system)).toBe(1);
  expect(f.out.join('\n')).not.toContain('Before this run');
  expect(f.out).toContain(next);
});

test('the earlier recipe is shown with the install\'s secrets replaced by their names', async () => {
  const at = install();
  const f = fake(at, { env: { PATH: `${at.root}:/usr/bin:/bin`, ANTHROPIC_API_KEY: 'sk-in-the-url' } });
  expect(await installService(f.ctx(['install', 'https://user:sk-in-the-url@example.com/r.json']), f.system)).toBe(0);
  f.systemd.crashing.add(HOST);
  f.out.length = 0;
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  const said = f.out.join('\n');
  expect(f.out).toContain('Before this run, service.json recorded the recipe https://user:<ANTHROPIC_API_KEY>@example.com/r.json, ' +
    'with some values hidden. Use the full original recipe argument with connectome service install ' +
    'to put it back, if the host\'s recipe loader still takes it.');
  expect(said).not.toContain('sk-in-the-url');
  expect(said).not.toMatch(/connectome service install '?https:/);
});

test('the earlier recipe isn\'t shown when the install\'s secrets can\'t all be kept out of it', async () => {
  const at = install();
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  mkdirSync(join(at.work, '.setup'), { recursive: true });
  writeFileSync(join(at.work, '.setup', 'stored-secrets.json'), '{ not json');
  f.systemd.crashing.add(HOST);
  const second = join(at.work, 'second.json');
  writeFileSync(second, JSON.stringify({ mcpServers: { shell: { command: 'terminal-sessions-mcp' } } }));
  f.out.length = 0;
  expect(await installService(f.ctx(['install', second]), f.system)).toBe(1);
  expect(f.out).toContain('Before this run, service.json recorded another recipe, which isn\'t shown, since the install\'s ' +
    'secrets can\'t all be kept out of it.');
  expect(f.out.join('\n')).not.toContain('Before this run, service.json recorded the recipe');
});

test('a host running again after systemd restarted it gives its restart count, and no exit status for the process now running', async () => {
  const at = install();
  const f = fake(at, { ready: false });
  f.systemd.crashing.add(HOST);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  f.systemd.crashing.delete(HOST);
  const checked = await checkService(at.root, f.system);
  const said = checked.lines.join('\n');
  const line = checked.lines.find((each) => each.startsWith(`${HOST} is active (running) again: `));
  expect(line).toMatch(/ again: systemd has restarted it \d+ times? since it was last started\.$/);
  expect(checked.lines).not.toContain(`${HOST} is active (running).`);
  expect(said).not.toContain('last exited');
});

test('a unit that isn\'t active after a start, and that systemd hasn\'t restarted, gives its last exit status and its latest start\'s lines', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  f.systemd.exiting.add(HOST);
  f.systemd.exitStatus.set(HOST, '3');
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.out).toContain('systemd hasn\'t restarted it since it was last started, and its process last exited with 3.');
  expect(f.out).toContain('  | Loaded recipe: resident');
});

test('for a host running again after a restart, the check also shows the journal\'s lines about the start that ended, its own and systemd\'s, none of them marked', async () => {
  const at = install();
  const f = fake(at, { ready: false });
  let start = 0;
  f.systemd.prints = () => [`start ${++start}: Failed to load recipe`];
  f.systemd.crashing.add(HOST);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  f.systemd.crashing.delete(HOST);
  const said = (await checkService(at.root, f.system)).lines.join('\n');
  expect(said).toContain('The journal\'s lines from the host in the first minute of its latest start:\n' +
    `  | start ${start}: Failed to load recipe`);
  const before = said.slice(said.indexOf('The journal\'s last lines about the newest earlier start it holds, which ended:'));
  expect(before).toContain(`Started ${HOST} - `);
  expect(before).toContain(`  | start ${start - 1}: Failed to load recipe`);
  expect(before).not.toContain('  ! ');
  expect(before).toContain(`  | ${HOST}: Main process exited, code=exited, status=1/FAILURE`);
  expect(before).toContain(`  | ${HOST}: Scheduled restart job, restart counter is at `);
  expect(before).not.toContain(`start ${start - 2}:`);
  expect(before).not.toContain(`start ${start}:`);
});

test('the start that ended is shown by its last 40 lines, unmarked, after a count of the earlier ones, redacted whole before the cut', async () => {
  const at = install();
  const f = fake(at, { ready: false, env: { PATH: '/usr/bin:/bin', ANTHROPIC_API_KEY: 'sk-first\nsk-second' } });
  const lines = Array.from({ length: 60 }, (_, at) => `line ${at + 1}`);
  lines[2] = 'line 3 failed';
  lines[21] = 'key sk-first';
  lines[22] = 'sk-second done';
  f.systemd.prints = () => lines;
  f.systemd.crashing.add(HOST);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  f.systemd.crashing.delete(HOST);
  const said = (await checkService(at.root, f.system)).lines.join('\n');
  const before = said.slice(said.indexOf('which ended'));
  expect(before).toContain('  | line 60');
  const count = before.indexOf('  23 earlier lines not shown.');
  expect(count).toBeGreaterThan(-1);
  expect(count).toBeLessThan(before.indexOf('  | '));
  const block = before.split('\n').slice(1);
  const next = block.findIndex((line) => !line.startsWith('  '));
  const shown = block.slice(0, next < 0 ? block.length : next).filter((line) => line.startsWith('  | '));
  expect(shown).toHaveLength(40);
  expect(shown[0]).toBe('  | <ANTHROPIC_API_KEY> done');
  expect(shown.at(-1)).toContain(`  | ${HOST}: Scheduled restart job, restart counter is at `);
  expect(before).not.toContain('line 3 failed');
  expect(before).not.toContain('  ! ');
  expect(before).not.toContain('sk-first');
  expect(before).not.toContain('sk-second');
});

test('when the start before the latest left no lines, the newest earlier start the journal holds is shown, and none when it holds none', async () => {
  const at = install();
  const f = fake(at, { ready: false });
  let start = 0;
  f.systemd.prints = () => [`start ${++start}: Failed to load recipe`];
  f.systemd.crashing.add(HOST);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  f.systemd.crashing.delete(HOST);
  const latest = f.systemd.latest.get(HOST)!;
  const ids = [...new Set(f.systemd.journal.filter((entry) => entry.unit === HOST).map((entry) => entry.invocation))];
  const previous = ids[ids.indexOf(latest) - 1];
  f.systemd.journal = f.systemd.journal.filter((entry) => entry.invocation !== previous);
  const said = (await checkService(at.root, f.system)).lines.join('\n');
  const before = said.slice(said.indexOf('The journal\'s last lines about the newest earlier start it holds, which ended:'));
  expect(before).toContain(`start ${start - 2}: Failed to load recipe`);
  expect(before).not.toContain(`start ${start - 1}:`);
  f.systemd.journal = f.systemd.journal.filter((entry) => entry.invocation === latest);
  expect((await checkService(at.root, f.system)).lines)
    .toContain('Its last 200 journal entries, up to a second past its latest start, hold no earlier start of it.');
});

test('a start newer than the one the check read is never taken as the one that ended', async () => {
  const at = install();
  const f = fake(at, { ready: false });
  let start = 0;
  f.systemd.prints = () => [`start ${++start}: Failed to load recipe`];
  f.systemd.crashing.add(HOST);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  f.systemd.crashing.delete(HOST);
  f.systemd.journal.push({ unit: HOST, invocation: 'f'.repeat(32), own: true, after: 0, line: 'a start newer than the read' });
  const said = (await checkService(at.root, f.system)).lines.join('\n');
  expect(said).toContain(`start ${start - 1}: Failed to load recipe`);
  expect(said).not.toContain('a start newer than the read');
});

test('with none of the latest start\'s entries in the journal, which start ended before it is said to be unknown', async () => {
  const at = install();
  const f = fake(at, { ready: false });
  let start = 0;
  f.systemd.prints = () => [`start ${++start}: Failed to load recipe`];
  f.systemd.crashing.add(HOST);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  f.systemd.crashing.delete(HOST);
  const latest = f.systemd.latest.get(HOST)!;
  f.systemd.journal = f.systemd.journal.filter((entry) => entry.invocation !== latest);
  const said = (await checkService(at.root, f.system)).lines;
  expect(said).toContain('Its last 200 journal entries, up to a second past its latest start, hold none of that start\'s, so ' +
    'which start ended before it can\'t be told.');
  expect(said.join('\n')).not.toContain('which ended');
});

test('a host started once, with no restart, shows only its latest start\'s lines', async () => {
  const at = install();
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(f.out).toContain('  | Loaded recipe: resident');
  expect(f.out.join('\n')).not.toContain('start before the latest');
});

test('a host systemd keeps restarting ends the wait for it at once, not after the minute', async () => {
  const at = install();
  const f = fake(at, { ready: false });
  f.systemd.crashing.add(HOST);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.slept()).toBeLessThan(5_000);
  expect(f.err.join('\n')).toContain(`systemd restarted ${HOST} before its host answered`);
});

test('a host whose unit stops ends the wait for it at once, saying how systemd shows it', async () => {
  const at = install();
  const f = fake(at, { ready: false });
  f.systemd.exiting.add(HOST);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.slept()).toBe(0);
  expect(f.err.join('\n')).toContain(`${HOST} is failed`);
});

test('the wait goes on while the host isn\'t ready yet, and ends once it answers', async () => {
  const at = install();
  const f = fake(at, { answersAfter: 3 });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(f.slept()).toBeGreaterThan(0);
  expect(f.slept()).toBeLessThan(60_000);
  expect(f.out.join('\n')).toContain('Its host answers: pid 4242');
});

test('a host that never answers while its unit stays active is waited for a minute', async () => {
  const at = install();
  const f = fake(at, { ready: false });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.slept()).toBeGreaterThanOrEqual(60_000);
  expect(f.slept()).toBeLessThan(62_000);
  expect(f.err.join('\n')).toContain('no host said it was ready within 60 s');
});

test('word matches inside the first 40 reports are quoted neutrally without a repair instruction', async () => {
  const at = install();
  const f = fake(at);
  f.systemd.prints = () => ['Loaded recipe: resident', '[discord-mcpl] Slash command setup failed: Missing Access'];
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const checked = await checkService(at.root, f.system);
  expect(checked.passed).toBe(true);
  expect(checked.lines).toContain('The journal\'s lines from the host in the first minute of its latest start:');
  expect(checked.lines).toContain('  | [discord-mcpl] Slash command setup failed: Missing Access');
  expect(checked.lines).toContain('  | Loaded recipe: resident');
  expect(checked.lines.join('\n')).not.toContain('lines matching');
  expect(checked.lines.join('\n')).not.toContain('If a marked line is a problem');
  expect(checked.lines.some((line) => line.startsWith('  ! '))).toBe(false);
});

for (const word of ['ERROR', 'fatal', 'failed', 'refused', 'refuses']) test(`a later ${word} report is selected without a judgment mark`, async () => {
  const at = install();
  const f = fake(at);
  f.systemd.prints = () => [...Array.from({ length: 50 }, (_, at) => `line ${at + 1}`), `late ${word} report`];
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const checked = await checkService(at.root, f.system);
  expect(checked.passed).toBe(true);
  expect(checked.lines).toContain('The journal\'s lines from the host in the first minute of its latest start, ' +
    'with later lines matching error, fatal, failed, refused, or refuses:');
  expect(checked.lines).toContain('  | line 40');
  expect(checked.lines).not.toContain('  | line 41');
  expect(checked.lines).toContain(`  | late ${word} report`);
  expect(checked.lines).toContain('  10 more lines not shown.');
  expect(checked.lines.some((line) => line.startsWith('  ! '))).toBe(false);
});

test('the check reads what the host itself wrote in its latest start, not an earlier start or systemd\'s own lines', async () => {
  const at = install('Error Test');
  const f = fake(at);
  f.systemd.prints = () => ['Fatal error: the earlier start'];
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  f.systemd.prints = () => ['Loaded recipe: the latest start'];
  const second = join(at.work, 'second.json');
  writeFileSync(second, '{}');
  expect(await installService(f.ctx(['install', second]), f.system)).toBe(0);
  const checked = await checkService(at.root, f.system);
  expect(checked.passed).toBe(true);
  const said = checked.lines.join('\n');
  expect(said).toContain('  | Loaded recipe: the latest start');
  expect(said).not.toContain('the earlier start');
  expect(said).not.toContain('Started connectome-error-test.service');
});

test('for a host that isn\'t active, the check shows its latest start\'s last lines, past its first minute too, nothing marked', async () => {
  const at = install();
  const f = fake(at, { ready: false });
  f.systemd.exiting.add(HOST);
  f.systemd.prints = () => ['Loaded recipe: resident', { after: 90, line: 'Missing ANTHROPIC_API_KEY. Set one in .env.' }];
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain(`connectome: ${HOST} is failed, and no host answers: `);
  expect(f.out.join('\n')).toContain('The journal\'s last lines from the host\'s latest start, which ended (last 200 entries):\n' +
    '  | Loaded recipe: resident\n  | Missing ANTHROPIC_API_KEY. Set one in .env.');
  expect(f.out.join('\n')).not.toContain('  ! ');
});

test('the check reads an active host\'s first minute only: a later line isn\'t shown', async () => {
  const at = install();
  const f = fake(at);
  f.systemd.prints = () => ['Loaded recipe: resident', { after: 90, line: 'Fatal error: a minute and a half in' }];
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(f.out.join('\n')).toContain('  | Loaded recipe: resident');
  expect(f.out.join('\n')).not.toContain('a minute and a half in');
});

test('a secret whose value spans lines is kept out of the log the check shows', async () => {
  const at = install();
  const f = fake(at, { env: { PATH: '/usr/bin:/bin', ANTHROPIC_API_KEY: 'sk-first-half\nsk-second-half' } });
  f.systemd.prints = () => ['key sk-first-half', 'sk-second-half done'];
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const said = f.out.join('\n');
  expect(said).toContain('<ANTHROPIC_API_KEY>');
  expect(said).not.toContain('sk-first-half');
  expect(said).not.toContain('sk-second-half');
});

test('checkService fails a recorded unit systemd no longer has, naming it', async () => {
  const at = install();
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  f.systemd.run('systemctl', ['--user', 'stop', HOST], {});
  rmSync(hostUnit(at));
  f.systemd.run('systemctl', ['--user', 'daemon-reload'], {});
  const checked = await checkService(at.root, f.system);
  expect(checked.passed).toBe(false);
  expect(checked.lines.join('\n')).toContain(`systemd has no ${HOST} loaded (not-found)`);
});

test('checkService fails a unit that lacks the supervised line, saying to run service install again', async () => {
  const at = install();
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  writeFileSync(hostUnit(at), readFileSync(hostUnit(at), 'utf-8').replace('Environment="CONNECTOME_SUPERVISED=1"\n', ''));
  f.systemd.run('systemctl', ['--user', 'daemon-reload'], {});
  const checked = await checkService(at.root, f.system);
  expect(checked.passed).toBe(false);
  expect(checked.lines).toContain('Its unit doesn\'t set CONNECTOME_SUPERVISED=1: run connectome service install again, ' +
    'which sets it once systemd shows the unit restarts the host on 75 and 1.');
});

test('the log isn\'t shown when the install\'s secrets can\'t all be kept out of it: stored secrets it can\'t read, or a .env outside setup\'s form', async () => {
  const at = install();
  const f = fake(at, { env: { PATH: '/usr/bin:/bin', ANTHROPIC_API_KEY: 'sk-secret' } });
  f.systemd.prints = () => ['key sk-secret'];
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  mkdirSync(join(at.work, '.setup'), { recursive: true });
  writeFileSync(join(at.work, '.setup', 'stored-secrets.json'), '{ not json');
  const checked = await checkService(at.root, f.system);
  expect(checked.passed).toBe(false);
  const said = checked.lines.join('\n');
  expect(said).toContain('isn\'t shown, since the install\'s secrets can\'t all be kept out of it');
  expect(said).toContain('stored-secrets.json');
  expect(said).not.toContain('sk-secret');
  rmSync(join(at.work, '.setup', 'stored-secrets.json'));
  writeFileSync(join(at.work, '.env'), 'ANTHROPIC_API_KEY="sk-secret"\nPEM="a\nb"\n');
  const spanned = await checkService(at.root, f.system);
  expect(spanned.passed).toBe(false);
  const told = spanned.lines.join('\n');
  expect(told).toContain('isn\'t shown, since the install\'s secrets can\'t all be kept out of it');
  expect(told).toContain(`${join(at.work, '.env')}, line 2,`);
  expect(told).not.toContain('sk-secret');
});

test('serviceLines gives the service\'s log line, and connectome service stop and start to stop and start it', async () => {
  const at = install();
  const f = fake(at);
  expect(serviceLines(at.root)).toBeNull();
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(serviceLines(at.root, f.system.env.PATH)).toEqual([`Its service is ${HOST}:`, `  follow its log: journalctl --user -u ${HOST} -f`,
    '  stop it: connectome service stop', '  start it: connectome service start']);
});

test('with a shell daemon, serviceLines says stop stops it with the host, and the host\'s unit wants it', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(serviceLines(at.root, f.system.env.PATH)).toEqual([`Its service is ${HOST}:`, `  follow its log: journalctl --user -u ${HOST} -f`,
    '  stop it and its shell daemon: connectome service stop', '  start it: connectome service start']);
  expect(readFileSync(hostUnit(at), 'utf-8')).toContain(`Wants=${SHELL}\n`);
});

test('every command service prints spells the install\'s own command by its full path, unless the first connectome on the printing process\'s PATH is the install\'s own', async () => {
  const at = install();
  const full = `'${join(at.root, 'connectome')}'`;
  const elsewhere = fake(at, { env: { PATH: '/usr/bin:/bin' } });
  expect(await installService(elsewhere.ctx(['install']), elsewhere.system)).toBe(2);
  expect(elsewhere.err).toEqual([`connectome: the first install needs the recipe: ${full} service install <recipe>`]);
  expect(await runService(elsewhere.ctx(['stop']), elsewhere.system)).toBe(1);
  expect(elsewhere.err.at(-1)).toBe(`connectome: No service is recorded for this install (${join(at.root, 'service.json')}). ` +
    `${full} service install <recipe> sets one up.`);
  expect(await installService(elsewhere.ctx(['install', at.recipe]), elsewhere.system)).toBe(0);
  expect(elsewhere.out).toContain(`  stop it: ${full} service stop`);
  expect(elsewhere.out).toContain(`  start it: ${full} service start`);
  expect(serviceLines(at.root, '/usr/bin:/bin')).toContain(`  stop it: ${full} service stop`);

  const onPath = fake(at);
  expect(await installService(onPath.ctx(['install', at.recipe]), onPath.system)).toBe(0);
  expect(onPath.out).toContain('  stop it: connectome service stop');
  expect(onPath.out).toContain('  start it: connectome service start');
  expect(serviceLines(at.root, onPath.system.env.PATH)).toContain('  stop it: connectome service stop');
});

const agentPlist = (at: Install, label = 'com.animalabs.connectome.my-resident') =>
  join(at.home, 'Library', 'LaunchAgents', `${label}.plist`);

test('on macOS the host gets a launch agent with KeepAlive on failure, the line, and a log file', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const text = readFileSync(agentPlist(at), 'utf-8');
  expect(text).toContain('<key>Label</key>\n  <string>com.animalabs.connectome.my-resident</string>');
  expect(text).toContain(`<string>${at.root}/start.js</string>`);
  expect(text).toContain(`<key>WorkingDirectory</key>\n  <string>${at.work}</string>`);
  expect(text).toContain('<key>CONNECTOME_SUPERVISED</key>\n    <string>1</string>');
  expect(text).toContain(`<key>DATA_DIR</key>\n    <string>${at.data}</string>`);
  expect(text).toContain('<key>PATH</key>\n    <string>/opt/bun/bin:/opt/node/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>');
  expect(text).toContain('<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>');
  expect(text).toContain(`<string>${at.work}/logs/agent.log</string>`);
  expect(f.systemd.calls).toContain(`launchctl bootstrap gui/1001 ${agentPlist(at)}`);
  expect(readServiceRecord(at.root)!.logs).toEqual({ kind: 'file', path: join(at.work, 'logs', 'agent.log') });
  expect(serviceLines(at.root, f.system.env.PATH)).toEqual(['Its service is the launch agent com.animalabs.connectome.my-resident:',
    `  follow its log: tail -f '${join(at.work, 'logs', 'agent.log')}'`, '  stop it: connectome service stop',
    '  start it: connectome service start']);
});

test('on macOS with a shell agent, serviceLines says stop stops it with the host', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(serviceLines(at.root, f.system.env.PATH)).toContain('  stop it and its shell daemon: connectome service stop');
});

test('on macOS a failed check says launchd starts the host again whenever it exits other than with 0', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin', linger: null, ready: false });
  f.systemd.agentsExit = true;
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.out).toContain('Put right what the lines above show, then run connectome service install again. Until then ' +
    'launchd starts the host again each time it exits other than with 0, while it has its agent loaded.');
});

test('on macOS a launch agent of the same name that runs another install is refused, writing nothing', async () => {
  const at = install();
  const other = '<plist><dict><key>WorkingDirectory</key>\n  <string>/srv/other/My Resident</string></dict></plist>\n';
  mkdirSync(dirname(agentPlist(at)), { recursive: true });
  writeFileSync(agentPlist(at), other);
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  const said = f.err.join('\n');
  expect(said).toContain(agentPlist(at));
  expect(said).toContain('/srv/other/My Resident');
  expect(readFileSync(agentPlist(at), 'utf-8')).toBe(other);
  expect(f.systemd.bootstraps).toEqual([]);
  expect(existsSync(join(at.root, 'service.json'))).toBe(false);
});

test('on macOS every re-run boots out and loads each agent again, with the recorded recipe', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(f.out).toContain("launchd loads these agents, and so starts them, each time resident logs in to the Mac's graphical session.");
  for (const run of [1, 2]) {
    f.systemd.calls.length = 0;
    expect(await installService(f.ctx(['install']), f.system)).toBe(0);
    expect(f.systemd.calls.filter((call) => /launchctl (bootout|bootstrap)/.test(call))).toEqual([
      'launchctl bootout gui/1001/com.animalabs.connectome.my-resident.shell',
      `launchctl bootstrap gui/1001 ${agentPlist(at, 'com.animalabs.connectome.my-resident.shell')}`,
      'launchctl bootout gui/1001/com.animalabs.connectome.my-resident',
      `launchctl bootstrap gui/1001 ${agentPlist(at)}`,
    ]);
  }
  expect(readFileSync(agentPlist(at), 'utf-8')).toContain(`<string>${at.recipe}</string>`);
});

test('on macOS a re-run loads again an agent that is loaded but has exited', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  f.systemd.agents.set('com.animalabs.connectome.my-resident', { pid: null });
  expect(await installService(f.ctx(['install']), f.system)).toBe(0);
  expect(f.systemd.bootstraps).toEqual(['com.animalabs.connectome.my-resident', 'com.animalabs.connectome.my-resident']);
});

test('on macOS the check shows its log\'s last lines, which can hold more than one start, with nothing marked, the host running or not', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const log = ['Loaded recipe: resident', 'Fatal error: error: it stopped', 'Loaded recipe: resident',
    ...Array.from({ length: 40 }, (_, at) => `line ${at + 1}`), 'Fatal error: error: it stopped again',
    'Loaded recipe: resident'].join('\n');
  writeFileSync(join(at.work, 'logs', 'agent.log'), log);
  const heading = 'The last lines of the host\'s log file, which can hold earlier loads and more than one start:\n' +
    '  5 earlier lines not shown.\n  | line 3\n';
  const tail = '  | line 40\n  | Fatal error: error: it stopped again\n  | Loaded recipe: resident';
  const running = await checkService(at.root, f.system);
  expect(running.passed).toBe(true);
  expect(running.lines.join('\n')).toContain(heading);
  expect(running.lines.join('\n')).toContain(tail);
  expect(running.lines.join('\n')).not.toContain('it stopped\n');
  expect(running.lines.join('\n')).not.toContain('  ! ');
  f.systemd.agentsExit = true;
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  writeFileSync(join(at.work, 'logs', 'agent.log'), log);
  const stopped = (await checkService(at.root, f.system)).lines.join('\n');
  expect(stopped).toContain(heading);
  expect(stopped).toContain(tail);
  expect(stopped).not.toContain('  ! ');
});


test('the Mac host check reads only a bounded suffix of a large real log and qualifies its line counts', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin' });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const path = join(at.work, 'logs', 'agent.log');
  const old = 'earlier report\n'.repeat(150_000);
  const recent = Array.from({ length: 60 }, (_, i) => 'new report ' + i).join('\n\n   \n') + '\n';
  writeFileSync(path, old + recent);
  const readFile = fs.readFileSync;
  const read = fs.readSync;
  let bytesRead = 0;
  const full = spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (file === path) throw new Error('the log must be read with a bounded suffix');
    return Reflect.apply(readFile, fs, [file, ...args]);
  }) as typeof fs.readFileSync);
  const suffix = spyOn(fs, 'readSync').mockImplementation(((fd: number, buffer: NodeJS.ArrayBufferView,
    offset: number, length: number, position: number | null) => {
    const count = read(fd, buffer, offset, Math.min(length, 997), position);
    bytesRead += count;
    return count;
  }) as typeof fs.readSync);
  let checked: Awaited<ReturnType<typeof checkService>>;
  try {
    checked = await checkService(at.root, f.system);
  } finally {
    full.mockRestore();
    suffix.mockRestore();
  }
  expect(checked.passed).toBe(true);
  expect(bytesRead).toBeGreaterThan(0);
  expect(bytesRead).toBeLessThanOrEqual(40 * 1024 + 1);
  const said = checked.lines.join('\n');
  expect(said).toContain(`${Buffer.byteLength(old + recent) - 40 * 1024} earlier file bytes are outside this window`);
  expect(said).toContain('Line counts below cover only this window');
  expect(checked.lines.filter((line) => line.startsWith('  | '))).toEqual(
    Array.from({ length: 40 }, (_, i) => '  | new report ' + (i + 20)));
});

for (const whose of ['host', 'shell']) test('the Mac ' + whose + ' log bounds an oversized single line and identifies its partial first line', async () => {
  const at = install('My Resident', { shell: whose === 'shell' });
  const f = fake(at, { platform: 'darwin' });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  if (whose === 'shell') f.systemd.agents.get('com.animalabs.connectome.my-resident.shell')!.pid = null;
  const path = join(at.work, 'logs', whose === 'host' ? 'agent.log' : 'shell.log');
  writeFileSync(path, 'earlier prefix' + 'x'.repeat(80 * 1024) + 'visible-end');
  const checked = await checkService(at.root, f.system);
  const said = checked.lines.join('\n');
  expect(said).not.toContain('earlier prefix');
  expect(said).toContain('The first line starts partway through a file line');
  const report = checked.lines.find((line) => line.endsWith('visible-end'))!;
  expect(report).toBeDefined();
  expect(Buffer.byteLength(report.slice('  | '.length))).toBe(40 * 1024);
});

for (const content of [null, '', 'a short report\n']) test('the Mac bounded file view preserves ' +
  (content === null ? 'a missing log' : content === '' ? 'an empty log' : 'a short log'), async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin' });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const path = join(at.work, 'logs', 'agent.log');
  if (content === null) rmSync(path, { force: true });
  else writeFileSync(path, content);
  const checked = await checkService(at.root, f.system);
  expect(checked.passed).toBe(true);
  const said = checked.lines.join('\n');
  if (content === null) expect(said).toContain('isn\'t there yet');
  else if (content === '') expect(said).toContain('nothing.');
  else expect(checked.lines).toContain('  | a short report');
  expect(said).not.toContain('earlier file bytes');
});


test('a Mac file window beginning inside a UTF8 character starts after that character without a replacement glyph', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin' });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const end = 'visible-end';
  const padding = 'q'.repeat(40 * 1024 + 1 - 4 - end.length);
  writeFileSync(join(at.work, 'logs', 'agent.log'), 'p'.repeat(50_000) + '🙂' + padding + end);
  const checked = await checkService(at.root, f.system);
  const report = checked.lines.find((line) => line.endsWith('visible-end'))!;
  expect(report.startsWith('  | q')).toBe(true);
  expect(report.includes('\uFFFD')).toBe(false);
  expect(report.includes('🙂')).toBe(false);
  expect(Buffer.byteLength(report.slice('  | '.length))).toBe(40 * 1024 - 3);
});


test('a Mac byte window on a line boundary reports its skipped bytes without claiming a partial line', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin' });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const prefix = 'earlier\n'.repeat(10_000);
  const recent = 'r'.repeat(40 * 1024 - 1) + '\n';
  writeFileSync(join(at.work, 'logs', 'agent.log'), prefix + recent);
  const checked = await checkService(at.root, f.system);
  expect(checked.lines.join('\n')).toContain(Buffer.byteLength(prefix) + ' earlier file bytes');
  expect(checked.lines.join('\n')).not.toContain('partway through a file line');
  expect(checked.lines).toContain('  | ' + recent.trimEnd());
});

for (const credential of ['first-é-last', 'first\né-second\nlast']) test('the bounded Mac file view masks an edge-crossing ' +
  (credential.includes('\n') ? 'multiline UTF8 credential' : 'UTF8 credential'), async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin', env: { DISCORD_TOKEN: credential } });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const prefix = 'old'.repeat(20_000) + '\ncredential=';
  const cut = Buffer.byteLength(prefix + credential.slice(0, credential.indexOf('é'))) + 1;
  const end = '\nvisible-last\n';
  const padding = 'q'.repeat(40 * 1024 - (Buffer.byteLength(prefix + credential + end) - cut));
  writeFileSync(join(at.work, 'logs', 'agent.log'), prefix + credential + padding + end);
  const checked = await checkService(at.root, f.system);
  expect(checked.passed).toBe(true);
  const reports = checked.lines.filter((line) => line.startsWith('  | ')).join('\n');
  expect(reports.includes('first')).toBe(false);
  expect(reports.includes('last' + padding)).toBe(false);
  expect(reports.includes('é-')).toBe(false);
  expect(reports.includes('\uFFFD')).toBe(false);
  expect(checked.lines).toContain('  | visible-last');
  expect(checked.lines.filter((line) => line.includes('<DISCORD_TOKEN>'))).toHaveLength(credential.split('\n').length);
  expect(checked.lines.filter((line) => line.startsWith('  | '))).toHaveLength(credential.split('\n').length + 1);
});

test('on macOS install rotates the earlier log before loading and checks the replacement log', async () => {
  const at = install();
  const log = join(at.work, 'logs', 'agent.log');
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(log, 'Fatal error: an earlier load\n');
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(readFileSync(`${log}.previous`, 'utf-8')).toContain('an earlier load');
  writeFileSync(log, 'Loaded recipe: resident\n');
  const checked = await checkService(at.root, f.system);
  expect(checked.passed).toBe(true);
  expect(checked.lines.join('\n')).not.toContain('an earlier load');
  expect(checked.lines.join('\n')).toContain('Loaded recipe: resident');
});

test('on macOS a shell agent this install no longer has is booted out and removed', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const shell = agentPlist(at, 'com.animalabs.connectome.my-resident.shell');
  expect(existsSync(shell)).toBe(true);
  rmSync(join(at.work, 'node_modules', 'term-sessions-mcp'), { recursive: true });
  expect(await installService(f.ctx(['install']), f.system)).toBe(0);
  expect(existsSync(shell)).toBe(false);
  expect(f.systemd.agents.has('com.animalabs.connectome.my-resident.shell')).toBe(false);
});

test('on macOS a launch agent launchctl won\'t load reports its failure and how to retry', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const second = join(at.work, 'second.json');
  writeFileSync(second, '{}');
  f.systemd.launchctlFailsOnce.set('bootstrap', 'Bootstrap failed: 5: Input/output error');
  expect(await installService(f.ctx(['install', second]), f.system)).toBe(1);
  const said = f.err.join('\n');
  expect(said).toContain('Bootstrap failed: 5: Input/output error');
  expect(said).toContain("The resident's service isn't running now. Repeat this service install command with the same recipe to load it.");
});

test('on macOS a failed first bootstrap reports that the resident service is not running', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin', linger: null });
  f.systemd.launchctlFailsOnce.set('bootstrap', 'Bootstrap failed: 5: Input/output error');
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain("The resident's service isn't running now. Repeat this service install command with the same recipe to load it.");
});

for (const state of [
  { name: 'loaded without a PID', pid: null, unknown: false, says: "The resident's service isn't running now." },
  { name: 'running', pid: 8181, unknown: false, says: "The resident's service is running: launchd shows pid 8181." },
  { name: 'unreadable', pid: null, unknown: true,
    says: "Whether the resident's service is running can't be told: launchctl list com.animalabs.connectome.my-resident failed: query denied." },
]) {
  test('on macOS a failed bootstrap reports the observed service state: ' + state.name, async () => {
    const at = install();
    const f = fake(at, { platform: 'darwin', linger: null });
    expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
    const host = 'com.animalabs.connectome.my-resident';
    const run = f.system.run;
    let failed = false;
    f.system.run = (command, args, env) => {
      if (command === 'launchctl' && args[0] === 'bootstrap') {
        failed = true;
        if (!state.unknown) f.systemd.agents.set(host, { pid: state.pid });
        return { status: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };
      }
      if (command === 'launchctl' && args[0] === 'list' && args[1] === host && failed && state.unknown) {
        return { status: 1, stdout: '', stderr: 'query denied\nTry re-running the command as root for richer errors.\n' };
      }
      return run(command, args, env);
    };
    expect(await installService(f.ctx(['install']), f.system)).toBe(1);
    const said = f.err.join('\n');
    expect(said).toContain('Bootstrap failed: 5: Input/output error');
    expect(said).toContain(state.says);
    expect(said).toContain('Repeat this service install command with the same recipe to load it.');
    expect(said).not.toContain('re-running the command as root');
  });
}

test('on macOS a failed shell bootstrap names the daemon and leaves the running host service alone', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const host = 'com.animalabs.connectome.my-resident';
  const pid = f.systemd.agents.get(host)!.pid;
  const calls = f.systemd.calls.length;
  f.systemd.launchctlFailsOnce.set('bootstrap', 'Bootstrap failed: 5: Input/output error');
  expect(await installService(f.ctx(['install']), f.system)).toBe(1);
  const said = f.err.join('\n');
  expect(said).toContain("The resident's shell daemon isn't running now.");
  expect(said).toContain("This run hasn't started or restarted the resident's service.");
  expect(said).toContain('Repeat this service install command with the same recipe to load it.');
  expect(f.systemd.agents.get(host)!.pid).toBe(pid);
  expect(f.systemd.calls.slice(calls).some((call) => call === 'launchctl bootout gui/1001/' + host)).toBe(false);
});

test('on macOS start still attempts to load an agent when its list query has an unfamiliar nonzero exit', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await runService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
  const host = 'com.animalabs.connectome.my-resident';
  const run = f.system.run;
  let loaded = false;
  f.system.run = (command, args, env) => {
    if (command === 'launchctl' && args[0] === 'bootstrap') loaded = true;
    return command === 'launchctl' && args[0] === 'list' && args[1] === host && !loaded
      ? { status: 1, stdout: '', stderr: 'unfamiliar response' }
      : run(command, args, env);
  };
  const calls = f.systemd.calls.length;
  expect(await runService(f.ctx(['start']), f.system)).toBe(0);
  expect(f.systemd.calls.slice(calls)).toContain('launchctl bootstrap gui/1001 ' + agentPlist(at));
  expect(f.systemd.agents.get(host)!.pid).toBe(4242);
});

test('on macOS a launch agent launchctl won\'t load leaves written every agent\'s file the record names', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform: 'darwin', linger: null });
  f.systemd.launchctlFailsOnce.set('bootstrap', 'Bootstrap failed: 5: Input/output error');
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  const record = readServiceRecord(at.root)!;
  expect(record.units.shell).toBeDefined();
  for (const unit of [record.units.host, record.units.shell!]) expect(existsSync(unit.file)).toBe(true);
});

test('on macOS the agents\' log directory is readable by its user alone', async () => {
  const at = install();
  mkdirSync(join(at.work, 'logs'));
  chmodSync(join(at.work, 'logs'), 0o755);
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(statSync(join(at.work, 'logs')).mode & 0o777).toBe(0o700);
});

test('on macOS a shell agent this install no longer has, loaded with its plist gone, is left loaded and named with the line that boots it out', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const label = 'com.animalabs.connectome.my-resident.shell';
  rmSync(agentPlist(at, label));
  rmSync(join(at.work, 'node_modules', 'term-sessions-mcp'), { recursive: true });
  f.out.length = 0;
  expect(await installService(f.ctx(['install']), f.system)).toBe(1);
  expect(f.systemd.agents.has(label)).toBe(true);
  expect(readServiceRecord(at.root)!.units.shell!.name).toBe(label);
  expect(f.out.join('\n')).toContain(`launchctl bootout gui/1001/${label}`);
});

test('on macOS a launch agent of this install\'s name loaded with its plist gone is refused, naming the line that boots it out', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  rmSync(agentPlist(at));
  expect(await installService(f.ctx(['install']), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('launchctl bootout gui/1001/com.animalabs.connectome.my-resident');
  expect(existsSync(agentPlist(at))).toBe(false);
  expect(f.systemd.bootstraps).toHaveLength(1);
});

test('on macOS a shell agent that isn\'t running fails the check, which names its log and shows its last lines', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  f.systemd.agents.set('com.animalabs.connectome.my-resident.shell', { pid: null });
  const shellLog = join(at.work, 'logs', 'shell.log');
  expect((await checkService(at.root, f.system)).lines).toContain(`Its log ${shellLog} isn't there.`);
  writeFileSync(shellLog, 'session-server: starting\nError: Cannot find module \'node-pty\'\n');
  const checked = await checkService(at.root, f.system);
  expect(checked.passed).toBe(false);
  const said = checked.lines.join('\n');
  expect(said).toContain('com.animalabs.connectome.my-resident is running');
  expect(said).toContain(`Its log is ${shellLog}`);
  expect(said).toContain('The last lines of the shell daemon\'s log file, which can hold earlier loads and more than one start:\n  | session-server: starting\n  | Error: Cannot find module \'node-pty\'');
});

test('a shell daemon that isn\'t active and whose latest start isn\'t known names the line that shows its log', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  f.systemd.running.delete(SHELL);
  f.systemd.latest.delete(SHELL);
  const checked = await checkService(at.root, f.system);
  expect(checked.passed).toBe(false);
  expect(checked.lines).toContain(`Its latest start isn't known, so its log isn't shown: journalctl --user -u ${SHELL} ` +
    'shows it.');
});

test('on macOS a failed bootout reports the native failure without asserting the agent state', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const second = join(at.work, 'second.json');
  writeFileSync(second, '{}');
  f.systemd.launchctlFailsOnce.set('bootout', 'Boot-out failed: 5: Input/output error');
  expect(await installService(f.ctx(['install', second]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('Boot-out failed: 5: Input/output error');
  expect(f.err.join('\n')).not.toContain('is still loaded as it was');
  expect(f.systemd.bootstraps).toHaveLength(1);
});

test('values written into a plist are escaped', async () => {
  const at = install('R&D <one>');
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const text = readFileSync(agentPlist(at, 'com.animalabs.connectome.r-d-one'), 'utf-8');
  expect(text).toContain(`<string>${dirname(at.work)}/R&amp;D &lt;one&gt;</string>`);
});

test('a path with a quote, a percent sign or a dollar sign is written so systemd reads it back as it is', async () => {
  const at = install('50% "off" $HOME');
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const text = readFileSync(join(unitsDir(at), 'connectome-50-off-home.service'), 'utf-8');
  const top = dirname(at.work);
  expect(text).toContain(`"${top}/50%% \\"off\\" $$HOME/connectome-host/start.js"`);
  expect(text).toContain(`WorkingDirectory=${top}/50%% "off" $HOME\n`);
  expect(text).toContain(`Environment="DATA_DIR=${top}/50%% \\"off\\" $HOME/data"\n`);
  expect(f.systemd.starts.find((start) => start.unit === 'connectome-50-off-home.service')!.environment)
    .toContain(`DATA_DIR=${at.data}`);
});

test('nothing the install prints holds a known or recorded secret\'s value or the shell token, from what it reads or what the host logs', async () => {
  const at = install('My Resident', { shell: true });
  writeFileSync(join(at.work, '.env'),
    'DISCORD_TOKEN="discord-secret-value"\nANTHROPIC_API_KEY="sk-secret"\nSESSION_SERVER_PORT="3150"\n' +
    'SESSION_SERVER_TOKEN="shell-secret-token"\n', { mode: 0o600 });
  new StoredSecrets(join(at.work, '.setup')).record('DISCORD_TOKEN');
  const f = fake(at);
  f.systemd.prints = () => ['Loaded recipe: resident', 'mcpl: token discord-secret-value key sk-secret shell shell-secret-token'];
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const said = [...f.out, ...f.err].join('\n');
  expect(said).toContain('<DISCORD_TOKEN>');
  expect(said).toContain('<SESSION_SERVER_TOKEN>');
  for (const value of ['discord-secret-value', 'sk-secret', 'shell-secret-token']) expect(said).not.toContain(value);
});

test('a .env value with a control character is refused without printing it, writing nothing', async () => {
  const at = install('My Resident', { shell: true });
  const env = 'SESSION_SERVER_PORT="3150"\nSESSION_SERVER_TOKEN="ab\u0001secretpart"\n';
  writeFileSync(join(at.work, '.env'), env, { mode: 0o600 });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  const said = f.err.join('\n');
  expect(said).toContain(`${join(at.work, '.env')}, line 2,`);
  expect(said).not.toContain('secretpart');
  expect(readFileSync(join(at.work, '.env'), 'utf-8')).toBe(env);
  expect(existsSync(hostUnit(at))).toBe(false);
  expect(existsSync(join(at.work, '.setup', 'stored-secrets.json'))).toBe(false);
});

const STOPS_AT_BOOT = 'It\'s still enabled, so it starts again when the machine next boots, or with connectome service start.';

function release(at: Install, version = '0.30.0'): void {
  mkdirSync(join(at.root, 'releases', version), { recursive: true });
  symlinkSync(join('releases', version), join(at.root, 'current'));
}

function journal(at: Install, lines: Array<Record<string, unknown>>): void {
  writeFileSync(join(at.root, 'journal.jsonl'),
    lines.map((line) => `${JSON.stringify({ v: 1, at: '2026-10-29T20:00:00.000Z', ...line })}\n`).join(''));
}

function marked(at: Install, mark: Record<string, unknown>): void {
  writeFileSync(join(at.root, 'mark.json'), JSON.stringify({ v: 1, id: 'm-1', at: '2026-10-29T20:00:00.000Z', ...mark }));
}

test('anything but install, stop or start, or a word after stop or start, is a usage error', async () => {
  const at = install();
  const f = fake(at);
  for (const argv of [[], ['uninstall'], ['install', at.recipe, 'extra'], ['stop', 'now'], ['start', at.recipe]]) {
    f.err.length = 0;
    expect(await runService(f.ctx(argv), f.system)).toBe(2);
    expect(f.err).toEqual(['Usage: connectome service install [<recipe>] | stop | start']);
  }
  expect(f.systemd.calls).toEqual([]);
});

test('stop and start with no service recorded say how to set one up, and run nothing', async () => {
  const at = install();
  const f = fake(at);
  for (const verb of ['stop', 'start']) {
    f.err.length = 0;
    expect(await runService(f.ctx([verb]), f.system)).toBe(1);
    expect(f.err).toEqual([`connectome: No service is recorded for this install (${join(at.root, 'service.json')}). ` +
      'connectome service install <recipe> sets one up.']);
  }
  expect(f.systemd.calls).toEqual([]);
});

test('stop and start with a record that can\'t be read name the file and the way to write it again, and run nothing', async () => {
  const at = install();
  const f = fake(at);
  writeFileSync(join(at.root, 'service.json'), 'not json');
  for (const verb of ['stop', 'start']) {
    f.err.length = 0;
    expect(await runService(f.ctx([verb]), f.system)).toBe(1);
    expect(f.err).toHaveLength(1);
    expect(f.err[0]).toContain(join(at.root, 'service.json'));
    expect(f.err[0]).toEndWith('Name the recipe to write the service and its record again: connectome service install <recipe>.');
  }
  expect(f.systemd.calls).toEqual([]);
});

test('stop and start run from inside the host\'s or the shell daemon\'s unit refuse, stopping and starting nothing', async () => {
  for (const unit of [HOST, SHELL]) {
    const at = install('My Resident', { shell: true });
    const f = fake(at);
    expect(await runService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
    f.system.cgroup = () => `0::/user.slice/user-1001.slice/user@1001.service/app.slice/${unit}/sessions\n`;
    const calls = f.systemd.calls.length;
    f.err.length = 0;
    expect(await runService(f.ctx(['stop']), f.system)).toBe(1);
    expect(f.err).toEqual([`connectome: connectome service stop stops ${unit}, and this command runs inside it, so that ` +
      'would end this command partway, before it says what the service\'s next start does. Nothing was stopped. Ask ' +
      'whoever runs this machine to run it from a terminal outside the resident\'s service, such as over ssh.']);
    f.err.length = 0;
    expect(await runService(f.ctx(['start']), f.system)).toBe(1);
    expect(f.err).toEqual([`connectome: this command runs inside ${unit}, so that unit is running, and connectome ` +
      'service start is refused there, as install and stop are. Nothing was started. If the resident\'s service needs ' +
      'starting, ask whoever runs this machine to run it from a terminal outside it, such as over ssh.']);
    expect(f.systemd.calls.slice(calls)).toEqual([]);
    expect(f.systemd.running.has(HOST) && f.systemd.running.has(SHELL)).toBe(true);
  }
});

test('on macOS, stop and start run from inside either launch agent refuse, stopping and starting nothing', async () => {
  for (const label of ['com.animalabs.connectome.my-resident', 'com.animalabs.connectome.my-resident.shell']) {
    const at = install('My Resident', { shell: true });
    const f = fake(at, { platform: 'darwin', linger: null });
    expect(await runService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
    f.system.env = { PATH: `${at.root}:/usr/bin:/bin`, XPC_SERVICE_NAME: label };
    const calls = f.systemd.calls.length;
    expect(await runService(f.ctx(['stop']), f.system)).toBe(1);
    expect(await runService(f.ctx(['start']), f.system)).toBe(1);
    expect(f.err.join('\n')).toContain(`connectome service stop stops ${label}, and this command runs inside it`);
    expect(f.err.join('\n')).toContain(`this command runs inside ${label}, so that unit is running`);
    expect(f.systemd.calls.slice(calls)).toEqual([]);
  }
});

test('stop stops the host and its shell daemon in one call, says so of each, that it stays enabled, and exits 0', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await runService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const calls = f.systemd.calls.length;
  f.out.length = 0;
  expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
  expect(f.systemd.calls.slice(calls).filter((call) => !call.includes(' show '))).toEqual([`systemctl --user stop ${HOST} ${SHELL}`]);
  expect(f.systemd.running.size).toBe(0);
  expect(f.systemd.enabled).toEqual(new Set([HOST, SHELL]));
  expect(f.out).toEqual([`Stopped ${HOST}.`, `Stopped ${SHELL}.`, STOPS_AT_BOOT]);
  expect(f.err).toEqual([]);
});

test('stop runs no stop for a unit that isn\'t running, says it wasn\'t, and exits 0', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await runService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  f.systemd.running.delete(SHELL);
  f.out.length = 0;
  expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
  expect(f.out).toEqual([`Stopped ${HOST}.`, `${SHELL} wasn't running.`, STOPS_AT_BOOT]);
  const calls = f.systemd.calls.length;
  f.out.length = 0;
  expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
  expect(f.systemd.calls.slice(calls).filter((call) => !call.includes(' show '))).toEqual([]);
  expect(f.out).toEqual([`${HOST} wasn't running.`, `${SHELL} wasn't running.`, STOPS_AT_BOOT]);
});

test('stop stops a unit on its way down and one between restarts, waiting for both, before it reads the update state', async () => {
  const at = install('My Resident', { shell: true });
  release(at);
  const f = fake(at);
  expect(await runService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  f.systemd.running.delete(HOST);
  f.systemd.deactivating.add(HOST);
  f.systemd.crashing.add(SHELL);
  f.systemd.onStop = () => marked(at, { to: '0.31.0', why: 'update' });
  const calls = f.systemd.calls.length;
  f.out.length = 0;
  expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
  expect(f.systemd.calls.slice(calls).filter((call) => !call.includes(' show '))).toEqual([`systemctl --user stop ${HOST} ${SHELL}`]);
  expect(f.out).toEqual([`Stopped ${HOST}.`, `Stopped ${SHELL}.`, STOPS_AT_BOOT, 'A switch to 0.31.0 is marked, so the ' +
    'next start takes it up: it starts 0.31.0 on trial, unless it refuses the switch. The host\'s log says what came of it.']);
});

test('stop and start leave alone a recorded unit that runs another directory, by its file or as systemd has it loaded', async () => {
  const at = install();
  const f = fake(at);
  expect(await runService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const ours = readFileSync(hostUnit(at), 'utf-8');
  const theirs = ours.replace(/^WorkingDirectory=.*$/m, 'WorkingDirectory=/srv/other');
  for (const [file, loaded] of [[theirs, theirs], [ours, theirs], [theirs, ours]]) {
    writeFileSync(hostUnit(at), loaded!);
    f.systemd.run('systemctl', ['--user', 'daemon-reload'], {});
    writeFileSync(hostUnit(at), file!);
    const calls = f.systemd.calls.length;
    for (const verb of ['stop', 'start']) {
      f.err.length = 0;
      expect(await runService(f.ctx([verb]), f.system)).toBe(1);
      expect(f.err).toEqual([`connectome: ${HOST}'s config (${hostUnit(at)}) names /srv/other, rather than this install in ` +
        `${at.work}. Its running process may still be this install's. If so, stop it with ` +
        `XDG_RUNTIME_DIR=/run/user/1001 systemctl --user stop ${HOST}. connectome service ${verb} leaves it alone. ` +
        `Nothing was ${verb === 'stop' ? 'stopped' : 'started'}: ` +
        'connectome service install says how to set this install\'s service up again.']);
    }
    expect(f.systemd.calls.slice(calls).filter((call) => !call.includes(' show '))).toEqual([]);
    expect(f.systemd.running.has(HOST)).toBe(true);
  }
});

test('stop leaves alone a recorded unit still running or on its way down with its file gone once systemd no longer holds it, naming the line that stops it, after which stop stops the rest', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await runService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  rmSync(hostUnit(at));
  f.systemd.run('systemctl', ['--user', 'daemon-reload'], {});
  const calls = f.systemd.calls.length;
  for (const down of [false, true]) {
    if (down) {
      f.systemd.running.delete(HOST);
      f.systemd.deactivating.add(HOST);
    }
    f.err.length = 0;
    expect(await runService(f.ctx(['stop']), f.system)).toBe(1);
    expect(f.err).toEqual([`connectome: ${HOST} is still running, but its file, ${hostUnit(at)}, is gone, so which ` +
      'install it runs can\'t be told. connectome service stop leaves it alone, and nothing was stopped. If it\'s this ' +
      `install's, stop it with XDG_RUNTIME_DIR=/run/user/1001 systemctl --user stop ${HOST}, then run connectome ` +
      'service stop again, which stops the rest of the service; connectome service install sets its service up again ' +
      'when it\'s wanted back.']);
  }
  expect(f.systemd.calls.slice(calls).filter((call) => !call.includes(' show '))).toEqual([]);
  expect(f.systemd.deactivating.has(HOST)).toBe(true);
  f.systemd.run('systemctl', ['--user', 'stop', HOST], {});
  f.out.length = 0;
  expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
  expect(f.out).toEqual([`${HOST} wasn't running.`, `Stopped ${SHELL}.`, `${hostUnit(at)}, ${HOST}'s unit file, is gone, ` +
    `so connectome service start refuses. ${serviceRepairWords}`]);
});

test('stop with only the shell daemon\'s file gone stops both, says whether the host starts again by itself, and that start refuses', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await runService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  rmSync(shellUnit(at));
  const gone = `${shellUnit(at)}, ${SHELL}'s unit file, is gone, so connectome service start refuses. ${serviceRepairWords}`;
  f.out.length = 0;
  expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
  expect(f.out).toEqual([`Stopped ${HOST}.`, `Stopped ${SHELL}.`, `${HOST} is still enabled, so it starts again when ` +
    'the machine next boots.', gone]);
  f.system.linger = () => false;
  f.out.length = 0;
  expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
  expect(f.out.slice(2)).toEqual([`${HOST} is still enabled, but linger isn't on for resident, so it doesn't start at ` +
    'boot.', gone]);
  f.systemd.enabled.delete(HOST);
  f.out.length = 0;
  expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
  expect(f.out.slice(2)).toEqual([`${HOST} isn't enabled (systemd shows it as disabled), so it doesn't start at boot: ` +
    'connectome service install enables it.', gone]);
});

test('a stop that fails gives systemctl\'s words and each unit\'s state after it, says nothing of the next start, and exits 1', async () => {
  const at = install('My Resident', { shell: true });
  release(at);
  marked(at, { to: '0.31.0', why: 'update' });
  const f = fake(at);
  expect(await runService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  f.systemd.failOnce.set(`stop ${SHELL}`, 'Failed to stop units: Access denied');
  f.out.length = 0;
  expect(await runService(f.ctx(['stop']), f.system)).toBe(1);
  expect(f.err).toEqual([`connectome: systemctl --user stop ${HOST} ${SHELL} failed: Failed to stop units: Access denied.`]);
  expect(f.out).toEqual([`${HOST} is still active (running).`, `${SHELL} is still active (running).`]);
});

test('after a stop, it says the service won\'t start at boot when its unit isn\'t enabled or linger isn\'t on, and that start refuses when a recorded file is gone', async () => {
  const at = install();
  const f = fake(at);
  expect(await runService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  f.systemd.enabled.delete(HOST);
  f.out.length = 0;
  expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
  expect(f.out).toEqual([`Stopped ${HOST}.`, 'Its unit isn\'t enabled (systemd shows it as disabled), so it doesn\'t ' +
    'start at boot: connectome service start starts it again, and connectome service install enables it.']);
  f.systemd.enabled.add(HOST);
  f.system.linger = () => false;
  f.out.length = 0;
  expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
  expect(f.out).toEqual([`${HOST} wasn't running.`, 'It\'s still enabled, but linger isn\'t on for resident, so it ' +
    'doesn\'t start at boot: connectome service start starts it again.']);
  rmSync(hostUnit(at));
  f.out.length = 0;
  expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
  expect(f.out).toEqual([`${HOST} wasn't running.`, `${hostUnit(at)}, ${HOST}'s unit file, is gone, so connectome ` +
    `service start refuses. ${serviceRepairWords}`]);
});

test('after the units stop, stop says what the next start does about an update, in the order the launcher takes it', async () => {
  const cases: Array<{ lines?: Array<Record<string, unknown>>; mark?: Record<string, unknown>; said: string | null }> = [
    { said: null },
    { lines: [{ step: 'trial-start', from: '0.30.0', to: '0.31.0', outcome: 'ok', mark: 'm-1' }],
      mark: { to: '0.32.0', why: 'update' },
      said: '0.31.0 was on trial and hadn\'t committed, so the next start falls back to 0.30.0: it puts 0.30.0\'s data ' +
        'back, keeping aside what 0.31.0 left, and starts 0.30.0 once that\'s done. The host\'s log says what came of it.' },
    { lines: [{ step: 'go-back', from: '0.31.0', to: '0.29.0', outcome: 'ok', mark: 'm-1' }],
      mark: { to: '0.32.0', why: 'update' },
      said: 'A Go back to 0.29.0 was cut off partway, so the next start goes on with it. The host\'s log says what came of it.' },
    { mark: { to: '0.31.0', why: 'update' },
      said: 'A switch to 0.31.0 is marked, so the next start takes it up: it starts 0.31.0 on trial, unless it refuses ' +
        'the switch. The host\'s log says what came of it.' },
    { mark: { to: '0.29.0', why: 'go-back', keepData: true },
      said: 'A Go back to 0.29.0 is marked, so the next start takes it up: 0.29.0 starts on the data as it is now, ' +
        'unless it refuses the Go back. The host\'s log says what came of it.' },
    { mark: { to: '0.29.0', why: 'go-back' },
      said: 'A Go back to 0.29.0 is marked, so the next start takes it up: the copy of 0.29.0\'s data is restored, ' +
        'with what came since set aside, and 0.29.0 starts, unless it refuses the Go back. The host\'s log says what came of it.' },
    { lines: [{ step: 'fallback', from: '0.31.0', to: '0.30.0', outcome: 'ok', mark: 'm-1' }],
      mark: { to: '0.31.0', why: 'update' }, said: null },
  ];
  for (const each of cases) {
    const at = install();
    release(at);
    if (each.lines) journal(at, each.lines);
    if (each.mark) marked(at, each.mark);
    const f = fake(at);
    expect(await runService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
    f.out.length = 0;
    expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
    expect(f.out).toEqual([`Stopped ${HOST}.`, STOPS_AT_BOOT, ...(each.said === null ? [] : [each.said])]);
  }
});

test('stop reads the update state after the units have stopped, so a mark written as the host stops is said', async () => {
  const at = install();
  release(at);
  const f = fake(at);
  expect(await runService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  f.systemd.onStop = () => marked(at, { to: '0.31.0', why: 'update' });
  f.out.length = 0;
  expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
  expect(f.out.at(-1)).toBe('A switch to 0.31.0 is marked, so the next start takes it up: it starts 0.31.0 on trial, ' +
    'unless it refuses the switch. The host\'s log says what came of it.');
});

test('a journal or mark stop can\'t read is said, with what the next start does with it, and the stop still exits 0', async () => {
  const at = install();
  release(at);
  writeFileSync(join(at.root, 'journal.jsonl'), 'not json\n');
  const f = fake(at);
  expect(await runService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  f.out.length = 0;
  expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
  expect(f.out.at(-1)).toBe(`Whether an update is under way can't be told: Line 1 of the journal at ` +
    `${join(at.root, 'journal.jsonl')} isn't JSON, so this release can't read it. The next start's launcher reads the ` +
    'same files first, and starts nothing while it can\'t read them.');
  rmSync(join(at.root, 'journal.jsonl'));
  marked(at, { id: 'a/b', to: '0.31.0', why: 'update' });
  f.out.length = 0;
  expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
  expect(f.out.at(-1)).toStartWith(`The mark at ${join(at.root, 'mark.json')} has no id this release can use`);
  expect(f.out.at(-1)).toEndWith(' The next start says so too, and starts 0.30.0 as it was.');
  marked(at, { to: '0.31.0', why: 'sideways' });
  f.out.length = 0;
  expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
  expect(f.out.at(-1)).toBe(`The mark at ${join(at.root, 'mark.json')} asks for a request this release doesn't know, so ` +
    'the next start says so and starts 0.30.0 as it was.');
});

test('start clears the start-limit count of the units that aren\'t running and starts them, then waits for the host and checks it as install does', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await runService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
  f.systemd.startLimited.add(HOST);
  const calls = f.systemd.calls.length;
  f.out.length = 0;
  expect(await runService(f.ctx(['start']), f.system)).toBe(0);
  expect(f.systemd.calls.slice(calls).filter((call) => call.startsWith('systemctl') && !call.includes(' show ')))
    .toEqual([`systemctl --user reset-failed ${HOST} ${SHELL}`, `systemctl --user start ${HOST} ${SHELL}`]);
  expect(f.systemd.running.has(HOST) && f.systemd.running.has(SHELL)).toBe(true);
  expect(f.out.slice(0, 3)).toEqual([`Started ${HOST}.`, `Started ${SHELL}.`, 'Its host answers: pid 4242, recipe Resident.']);
  expect(f.out).toContain(`${HOST} is active (running).`);
  expect(f.out).toContain(`  stop it and its shell daemon: connectome service stop`);
  expect(f.err).toEqual([]);
});

test('start leaves a unit that\'s running as it is, says so, and still checks the service', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await runService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  f.systemd.running.delete(SHELL);
  const host = f.systemd.running.get(HOST);
  let calls = f.systemd.calls.length;
  f.out.length = 0;
  expect(await runService(f.ctx(['start']), f.system)).toBe(0);
  expect(f.systemd.calls.slice(calls).filter((call) => call.startsWith('systemctl') && !call.includes(' show ')))
    .toEqual([`systemctl --user reset-failed ${SHELL}`, `systemctl --user start ${SHELL}`]);
  expect(f.systemd.running.get(HOST)).toBe(host!);
  expect(f.out.slice(0, 2)).toEqual([`${HOST} was already active (running), so it wasn't started again.`, `Started ${SHELL}.`]);
  calls = f.systemd.calls.length;
  f.out.length = 0;
  expect(await runService(f.ctx(['start']), f.system)).toBe(0);
  expect(f.systemd.calls.slice(calls).filter((call) => call.startsWith('systemctl') && !call.includes(' show '))).toEqual([]);
  expect(f.out).toContain(`${HOST} is active (running).`);
});

test('start says what this start does about an update before it starts the host, and nothing of it when the host is running', async () => {
  const at = install();
  release(at);
  const f = fake(at);
  expect(await runService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
  marked(at, { to: '0.31.0', why: 'update' });
  f.out.length = 0;
  expect(await runService(f.ctx(['start']), f.system)).toBe(0);
  expect(f.out.slice(0, 2)).toEqual(['A switch to 0.31.0 is marked, so this start takes it up: it starts 0.31.0 on ' +
    'trial, unless it refuses the switch. The host\'s log says what came of it.', `Started ${HOST}.`]);
  f.out.length = 0;
  expect(await runService(f.ctx(['start']), f.system)).toBe(0);
  expect(f.out.join('\n')).not.toContain('A switch to');
});

test('start waits for a unit on its way down before it reads the update state, and starts nothing when that wait fails', async () => {
  const at = install('My Resident', { shell: true });
  release(at);
  const f = fake(at);
  expect(await runService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  f.systemd.running.delete(HOST);
  f.systemd.deactivating.add(HOST);
  f.systemd.onStop = () => marked(at, { to: '0.31.0', why: 'update' });
  let calls = f.systemd.calls.length;
  f.out.length = 0;
  expect(await runService(f.ctx(['start']), f.system)).toBe(0);
  expect(f.systemd.calls.slice(calls).filter((call) => call.startsWith('systemctl') && !call.includes(' show ')))
    .toEqual([`systemctl --user stop ${HOST}`, `systemctl --user reset-failed ${HOST}`, `systemctl --user start ${HOST}`]);
  expect(f.out.slice(0, 3)).toEqual(['A switch to 0.31.0 is marked, so this start takes it up: it starts 0.31.0 on ' +
    'trial, unless it refuses the switch. The host\'s log says what came of it.', `Started ${HOST}.`,
  `${SHELL} was already active (running), so it wasn't started again.`]);
  f.systemd.onStop = () => {};
  f.systemd.running.delete(HOST);
  f.systemd.deactivating.add(HOST);
  f.systemd.failOnce.set(`stop ${HOST}`, 'Failed to stop units: Access denied');
  calls = f.systemd.calls.length;
  f.out.length = 0;
  f.err.length = 0;
  expect(await runService(f.ctx(['start']), f.system)).toBe(1);
  expect(f.err).toEqual([`connectome: systemctl --user stop ${HOST} failed: Failed to stop units: Access denied. ` +
    'connectome service start runs it to wait for a unit on its way down, and started nothing.']);
  expect(f.systemd.calls.slice(calls).filter((call) => call.startsWith('systemctl') && !call.includes(' show ')))
    .toEqual([`systemctl --user stop ${HOST}`]);
  expect(f.out.join('\n')).not.toContain('A switch to');
});

test('start counts a host between restarts as not running: it says what this start does about an update and starts it', async () => {
  const at = install();
  release(at);
  const f = fake(at);
  expect(await runService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  marked(at, { to: '0.31.0', why: 'update' });
  f.systemd.crashing.add(HOST);
  const calls = f.systemd.calls.length;
  f.out.length = 0;
  await runService(f.ctx(['start']), f.system);
  expect(f.systemd.calls.slice(calls).filter((call) => call.startsWith('systemctl') && !call.includes(' show ')))
    .toEqual([`systemctl --user reset-failed ${HOST}`, `systemctl --user start ${HOST}`]);
  expect(f.out.slice(0, 2)).toEqual(['A switch to 0.31.0 is marked, so this start takes it up: it starts 0.31.0 on ' +
    'trial, unless it refuses the switch. The host\'s log says what came of it.', `Started ${HOST}.`]);
});

test('start with a recorded unit\'s file gone refuses, naming it and the way to write it again, and starts nothing', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await runService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
  rmSync(shellUnit(at));
  const calls = f.systemd.calls.length;
  f.err.length = 0;
  expect(await runService(f.ctx(['start']), f.system)).toBe(1);
  expect(f.err).toEqual([`connectome: ${shellUnit(at)}, ${SHELL}'s unit file, is gone. ${serviceRepairWords} Nothing was started.`]);
  expect(f.systemd.calls.slice(calls)).toEqual([]);
});

test('a start systemctl refuses gives its words and the check\'s lines, and exits 1', async () => {
  const at = install();
  const f = fake(at);
  expect(await runService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
  f.systemd.failOnce.set(`start ${HOST}`, `Job for ${HOST} failed.`);
  f.out.length = 0;
  expect(await runService(f.ctx(['start']), f.system)).toBe(1);
  expect(f.err).toEqual([`connectome: systemctl --user start ${HOST} failed: Job for ${HOST} failed.`]);
  expect(f.out).toContain(`${HOST} is inactive (dead), not active.`);
});

test('a host that doesn\'t answer after start fails it, with the check\'s lines, and exits 1', async () => {
  const at = install();
  const f = fake(at);
  expect(await runService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
  f.systemd.exiting.add(HOST);
  f.system.openHost = async () => ({ reason: 'no host is running', down: true });
  f.err.length = 0;
  expect(await runService(f.ctx(['start']), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain(`connectome: ${HOST} is failed, and no host answers`);
});

test('on macOS stop boots out the host, then its shell agent, says so of each and that each loads again at login, and exits 0', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await runService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const host = 'com.animalabs.connectome.my-resident';
  const shell = `${host}.shell`;
  f.systemd.agents.get(shell)!.pid = null;
  const calls = f.systemd.calls.length;
  f.out.length = 0;
  expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
  expect(f.systemd.calls.slice(calls).filter((call) => !/^(launchctl (list|print)|plutil) /.test(call)))
    .toEqual([`launchctl bootout gui/1001/${host}`, `launchctl bootout gui/1001/${shell}`]);
  expect(f.systemd.agents.size).toBe(0);
  expect(f.out).toEqual([`Stopped ${host}.`, `${shell} wasn't running, and launchd no longer has it loaded.`,
    `Its launch agent stays in ${dirname(agentPlist(at))}, so launchd starts it again when resident next logs in to the Mac's graphical session, or ` +
    'with connectome service start.']);
  f.out.length = 0;
  expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
  expect(f.out.slice(0, 2)).toEqual([`${host} wasn't loaded.`, `${shell} wasn't loaded.`]);
});

test('on macOS stop and start refuse another-directory configuration, and stop refuses a loaded agent with its plist gone', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await runService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const host = 'com.animalabs.connectome.my-resident';
  const ours = readFileSync(agentPlist(at), 'utf-8');
  writeFileSync(agentPlist(at), ours.replace(/(<key>WorkingDirectory<\/key>\s*<string>)[^<]*/, '$1/srv/other'));
  const calls = f.systemd.calls.length;
  for (const verb of ['stop', 'start']) {
    f.err.length = 0;
    expect(await runService(f.ctx([verb]), f.system)).toBe(1);
    expect(f.err).toEqual([`connectome: ${host}'s config (${agentPlist(at)}) names /srv/other, rather than this install in ` +
      `${at.work}. Its running process may still be this install's. If so, stop it with ` +
      `launchctl bootout gui/1001/${host}. connectome service ${verb} leaves it alone. ` +
      `Nothing was ${verb === 'stop' ? 'stopped' : 'started'}: ` +
      'connectome service install says how to set this install\'s service up again.']);
  }
  rmSync(agentPlist(at));
  f.err.length = 0;
  expect(await runService(f.ctx(['stop']), f.system)).toBe(1);
  expect(f.err).toEqual([`connectome: ${host} is still loaded, but its file, ${agentPlist(at)}, is gone, so which ` +
    'install it runs can\'t be told. connectome service stop leaves it alone, and nothing was stopped. If it\'s this ' +
    `install's, stop it with launchctl bootout gui/1001/${host}, then run connectome service stop again, which stops ` +
    'the rest of the service; connectome service install sets its service up again when it\'s wanted back.']);
  expect(f.systemd.calls.slice(calls).filter((call) => !/^(launchctl list|plutil) /.test(call))).toEqual([]);
  expect(f.systemd.agents.has(host)).toBe(true);
});

test('on macOS stop with only the shell agent\'s plist gone says whether the host\'s agent starts again at login, and that start refuses', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await runService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const host = 'com.animalabs.connectome.my-resident';
  const shell = `${host}.shell`;
  expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
  rmSync(agentPlist(at, shell));
  f.out.length = 0;
  expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
  expect(f.out).toEqual([`${host} wasn't loaded.`, `${shell} wasn't loaded.`, `${host}'s launch agent stays in ` +
    `${dirname(agentPlist(at))}, so launchd starts it again when resident next logs in to the Mac's graphical session.`, `${agentPlist(at, shell)}, ` +
    `${shell}'s launch agent's file, is gone, so connectome service start refuses. ${serviceRepairWords}`]);
});

test('on macOS a bootout that fails is said, with the agents stopped before it, and exits 1', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await runService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const host = 'com.animalabs.connectome.my-resident';
  const shell = `${host}.shell`;
  let booted = 0;
  const run = f.system.run;
  f.system.run = (command, args, env) => {
    if (command === 'launchctl' && args[0] === 'bootout' && ++booted === 2) {
      return { status: 5, stdout: '', stderr: 'Boot-out failed: 5: Input/output error' };
    }
    return run(command, args, env);
  };
  f.out.length = 0;
  expect(await runService(f.ctx(['stop']), f.system)).toBe(1);
  expect(f.out).toEqual([`Stopped ${host}.`]);
  expect(f.err).toEqual([`connectome: launchctl bootout gui/1001/${shell} failed: Boot-out failed: 5: Input/output ` +
    'error. Run connectome service stop again to finish stopping its agents.']);
});

test('on macOS start loads the shell agent, then the host\'s, setting each log aside first, starts one loaded but not running, and checks the service', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await runService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const host = 'com.animalabs.connectome.my-resident';
  const shell = `${host}.shell`;
  expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
  writeFileSync(join(at.work, 'logs', 'agent.log'), 'Fatal error: before this start\n');
  writeFileSync(join(at.work, 'logs', 'shell.log'), 'shell: before this start\n');
  let calls = f.systemd.calls.length;
  f.out.length = 0;
  expect(await runService(f.ctx(['start']), f.system)).toBe(0);
  expect(f.systemd.calls.slice(calls).filter((call) => /^launchctl (bootstrap|kickstart)/.test(call)))
    .toEqual([`launchctl bootstrap gui/1001 ${agentPlist(at, shell)}`, `launchctl bootstrap gui/1001 ${agentPlist(at)}`]);
  expect(f.out.slice(0, 2)).toEqual([`Started ${shell}.`, `Started ${host}.`]);
  expect(readFileSync(join(at.work, 'logs', 'agent.log.previous'), 'utf-8')).toContain('before this start');
  expect(readFileSync(join(at.work, 'logs', 'shell.log.previous'), 'utf-8')).toContain('shell: before this start');
  expect(existsSync(join(at.work, 'logs', 'shell.log'))).toBe(false);
  expect(f.out.join('\n')).not.toContain('before this start');
  f.systemd.agents.get(host)!.pid = null;
  calls = f.systemd.calls.length;
  f.out.length = 0;
  expect(await runService(f.ctx(['start']), f.system)).toBe(0);
  expect(f.systemd.calls.slice(calls).filter((call) => /^launchctl (bootstrap|kickstart)/.test(call)))
    .toEqual([`launchctl kickstart gui/1001/${host}`]);
  expect(f.out.slice(0, 2)).toEqual([`${shell} was already running, so it wasn't started again.`, `Started ${host}.`]);
});

const ipv6 = await new Promise<boolean>((done) => {
  const server = createServer();
  server.once('error', () => done(false));
  server.listen(0, '::1', () => server.close(() => done(true)));
});

test('a port held on the IPv4 loopback isn\'t taken as free', async () => {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const port = (server.address() as { port: number }).port;
  try {
    expect(await portFree(port)).toBe(false);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test.skipIf(!ipv6)('a port held on the IPv6 loopback isn\'t taken as free', async () => {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '::1', () => done()));
  const port = (server.address() as { port: number }).port;
  try {
    expect(await portFree(port)).toBe(false);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test('the host\'s own loader refuses a recipe in its own words, and takes nothing from this process\'s environment', () => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'svc-load-')));
  made.push(top);
  const recipe = join(top, 'resident.json');
  writeFileSync(recipe, JSON.stringify({ name: 'r', agent: { provider: 'mock', systemPrompt: '${SERVICE_TEST_VALUE}' } }));
  process.env.SERVICE_TEST_VALUE = 'in this process only';
  try {
    const refused = loadRecipeAsHost(process.execPath, recipe, top, { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: top });
    expect(refused.loads).toBe(false);
    expect((refused as { words: string }).words).toContain(`Recipe "${recipe}" references environment variable ` +
      '${SERVICE_TEST_VALUE} which is not set.');
  } finally {
    delete process.env.SERVICE_TEST_VALUE;
  }
});

test('the host\'s own loader takes a value from the environment it\'s given, and one from .env in its working directory', () => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'svc-load-')));
  made.push(top);
  const work = join(top, 'work');
  const recipe = join(top, 'recipes', 'resident.json');
  mkdirSync(work);
  mkdirSync(dirname(recipe));
  writeFileSync(recipe, JSON.stringify({
    name: 'r', agent: { provider: 'mock', systemPrompt: '${SERVICE_TEST_GIVEN} ${SERVICE_TEST_DOTENV}' },
  }));
  writeFileSync(join(work, '.env'), 'SERVICE_TEST_DOTENV="from the working directory"\n');
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: top, SERVICE_TEST_GIVEN: 'given' };
  expect(loadRecipeAsHost(process.execPath, recipe, work, env)).toEqual({ loads: true });
});

test('the host\'s loader that ends without a refusal, or can\'t be started, gives no verdict', () => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'svc-load-')));
  made.push(top);
  const recipe = join(top, 'resident.json');
  writeFileSync(recipe, '{}');
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: top };
  expect(loadRecipeAsHost('/bin/false', recipe, top, env)).toEqual({ loads: null, why: 'the loader exited with 1' });
  expect(loadRecipeAsHost(join(top, 'no-such-bun'), recipe, top, env).loads).toBeNull();
});

const excerptLead = "Lines starting with | are reports from the process named above each excerpt, not findings of this check. Current known secret values are redacted; older or unrecorded credentials can remain. This check says what it finds in lines of its own.";

test('the service check explains the source once before its current and ended log excerpts', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  f.systemd.prints = (unit) => unit === HOST ? ['host error: original report'] : ['shell: original report'];
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  f.systemd.running.delete(SHELL);
  const { lines } = await checkService(at.root, f.system);
  expect(lines.filter((line) => line === excerptLead)).toHaveLength(1);
  expect(lines.indexOf(excerptLead)).toBeLessThan(lines.findIndex((line) => line.startsWith("The journal's lines")));
  expect(lines).toContain('  | host error: original report');
  expect(lines).toContain('  | shell: original report');
});

test('an empty first log leaves the explanation for the first excerpt that has reports', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  f.systemd.prints = (unit) => unit === HOST ? [] : ['shell: only report'];
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  f.systemd.running.delete(SHELL);
  const { lines } = await checkService(at.root, f.system);
  const empty = lines.findIndex((line) => line.endsWith(': nothing.'));
  expect(empty).toBeGreaterThanOrEqual(0);
  expect(lines.indexOf(excerptLead)).toBeGreaterThan(empty);
  expect(lines.indexOf(excerptLead)).toBeLessThan(lines.indexOf('  | shell: only report'));
  expect(lines.filter((line) => line === excerptLead)).toHaveLength(1);
});

test('the macOS check explains its shell and host log excerpts once, preserving their reports', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  f.systemd.agents.set('com.animalabs.connectome.my-resident.shell', { pid: null });
  writeFileSync(join(at.work, 'logs', 'shell.log'), 'shell error: original report\n');
  writeFileSync(join(at.work, 'logs', 'agent.log'), 'host: original report\n');
  const { lines } = await checkService(at.root, f.system);
  expect(lines.filter((line) => line === excerptLead)).toHaveLength(1);
  expect(lines.indexOf(excerptLead)).toBeLessThan(lines.findIndex((line) => line.startsWith('The last lines')));
  expect(lines).toContain('  | shell error: original report');
  expect(lines).toContain('  | host: original report');
});

test('an empty or withheld log carries no excerpt explanation', async () => {
  const at = install();
  const f = fake(at);
  f.systemd.prints = () => [];
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect((await checkService(at.root, f.system)).lines).not.toContain(excerptLead);
  f.systemd.prints = () => ['host: a report'];
  expect(await installService(f.ctx(['install']), f.system)).toBe(0);
  mkdirSync(join(at.work, '.setup'), { recursive: true });
  writeFileSync(join(at.work, '.setup', 'stored-secrets.json'), 'not JSON');
  const { lines } = await checkService(at.root, f.system);
  expect(lines.some((line) => line.includes("isn't shown"))).toBe(true);
  expect(lines).not.toContain(excerptLead);
});

test('an installed shell package alone gives a no-shell recipe no daemon or settings', async () => {
  const at = install('My Resident', { shell: true });
  writeFileSync(at.recipe, '{}');
  const f = fake(at, { node: null, taken: Array.from({ length: 100 }, (_, n) => 3100 + n) });
  writeFileSync(join(at.work, 'node_modules', 'term-sessions-mcp', 'package.json'), 'invalid JSON');
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(existsSync(shellUnit(at))).toBe(false);
  expect(readServiceRecord(at.root)!.units.shell).toBeUndefined();
  expect(existsSync(join(at.work, '.env'))).toBe(false);
  expect(f.out.join('\n')).not.toContain('To bring it back');
});

test('removing the shell retires its daemon while retaining changed token lines and unrelated settings', async () => {
  const at = install('My Resident', { shell: true });
  writeFileSync(at.recipe, JSON.stringify({ mcpServers: { shell: { command: 'terminal-sessions-mcp' } } }));
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  writeFileSync(join(at.work, '.env'), '# keep this comment\nDISCORD_TOKEN="keep-this"\n' +
    'SESSION_SERVER_TOKEN="old-token"\nSESSION_SERVER_PORT="3100"\nSESSION_SERVER_TOKEN="last-token"\n', { mode: 0o600 });
  new StoredSecrets(join(at.work, '.setup')).record('DISCORD_TOKEN');
  new StoredSecrets(join(at.work, '.setup')).record('SESSION_SERVER_PORT');
  writeFileSync(at.recipe, '{}');
  f.out.length = 0;
  expect(await installService(f.ctx(['install']), f.system)).toBe(0);
  expect(f.systemd.running.has(SHELL)).toBe(false);
  expect(f.systemd.enabled.has(SHELL)).toBe(false);
  expect(existsSync(shellUnit(at))).toBe(false);
  expect(readServiceRecord(at.root)!.units.shell).toBeUndefined();
  const kept = '# keep this comment\nDISCORD_TOKEN="keep-this"\n' +
    'SESSION_SERVER_TOKEN="old-token"\nSESSION_SERVER_TOKEN="last-token"\n';
  expect(readFileSync(join(at.work, '.env'), 'utf-8')).toBe(kept);
  expect(new Set(new StoredSecrets(join(at.work, '.setup')).names()))
    .toEqual(new Set(['DISCORD_TOKEN', 'SESSION_SERVER_TOKEN']));
  expect(f.out.join('\n')).toContain('the recipe source names no shell client or shell setting');
  expect(await installService(f.ctx(['install']), f.system)).toBe(0);
  expect(readFileSync(join(at.work, '.env'), 'utf-8')).toBe(kept);
});

test('a recipe requesting a shell without the package gets an explanation and keeps external daemon settings', async () => {
  const at = install();
  writeFileSync(at.recipe, JSON.stringify({ mcpServers: { shell: { command: 'terminal-sessions-mcp' } } }));
  const before = 'SESSION_SERVER_TOKEN="external-token"\nSESSION_SERVER_PORT="4000"\n';
  writeFileSync(join(at.work, '.env'), before, { mode: 0o600 });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(readServiceRecord(at.root)!.units.shell).toBeUndefined();
  expect(readFileSync(join(at.work, '.env'), 'utf-8')).toBe(before);
  expect(f.out.join('\n')).toContain("term-sessions-mcp isn't installed");
  expect(f.out.join('\n')).toContain('no daemon');
});

test('source discovery identifies client names and setting mentions before recipe resolution', () => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'svc-shell-load-')));
  made.push(top);
  const recipe = join(top, 'resident.json');
  writeFileSync(join(top, '.env'), 'SESSION_SERVER_TOKEN="stale-token"\nSESSION_SERVER_PORT="3101"\n');
  const cases: Array<[Record<string, unknown>, boolean]> = [
    [{}, false],
    [{ agent: { provider: 'mock', systemPrompt: 'The context holds 65536 tokens.' } }, false],
    [{ mcpServers: { other: { command: 'some-other-server', env: { PORT: '3101', KEY: 'stale-token' } } } }, false],
    [{ mcpServers: { shell: { command: '/usr/local/bin/terminal-sessions-mcp' } } }, true],
    [{ mcpServers: { shell: { command: 'bunx', args: ['term-sessions-mcp@1.7.3'] } } }, true],
    [{ mcpServers: { shell: { command: 'wrapper', env: { AUTH: 'Bearer ${SESSION_SERVER_TOKEN}' } } } }, true],
    [{ mcpServers: { shell: { command: 'wrapper', env: { URL: 'http://localhost:${SESSION_SERVER_PORT}/' } } } }, true],
    [{ agent: { name: 'r', provider: 'mock', systemPrompt: 'Uses ${SESSION_SERVER_TOKEN}.' } }, true],
    [{ agent: { name: 'r', provider: 'mock', systemPrompt: 'Uses ${SESSION_SERVER_PORT}.' } }, true],
  ];
  for (const [fields, shell] of cases) {
    writeFileSync(recipe, JSON.stringify({ name: 'r', agent: { provider: 'mock', systemPrompt: 'Test.' }, ...fields }));
    expect(readRecipeAsHost(process.execPath, recipe, top, {
      HOME: top, PATH: process.env.PATH ?? '/usr/bin:/bin',
      SESSION_SERVER_TOKEN: 'stale-token', SESSION_SERVER_PORT: '3101',
    })).toMatchObject({ loads: true, shell });
  }
});

async function serveRecipe(fetcher: string): Promise<{ url: string; close(): Promise<void> }> {
  const script = 'const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: ' + fetcher + ' }); ' +
    'await Bun.stdout.write(server.url.href.slice(0, 5)); await Bun.sleep(10); console.log(server.url.href.slice(5));';
  const server = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'inherit' });
  try {
    const reader = server.stdout.getReader();
    const decoder = new TextDecoder();
    let line = '';
    while (!line.includes('\n')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('recipe server exited before reporting its URL');
      line += decoder.decode(chunk.value, { stream: true });
    }
    reader.releaseLock();
    return {
      url: line.slice(0, line.indexOf('\n')).trim(),
      close: async () => { server.kill(); await server.exited; },
    };
  } catch (error) {
    server.kill();
    await server.exited;
    throw error;
  }
}

test('the real recipe check finds shell settings in a fetched recipe', async () => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'svc-shell-url-')));
  made.push(top);
  const body = JSON.stringify({
    name: 'r', agent: { provider: 'mock', systemPrompt: 'A fetched recipe.' },
    mcpServers: { renamed: { command: 'wrapper', env: { AUTH: 'Bearer ${SESSION_SERVER_TOKEN}' } } },
  });
  const server = await serveRecipe('() => new Response(' + JSON.stringify(body) + ')');
  try {
    const url = server.url;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(readRecipeAsHost(process.execPath, url, top, {
      HOME: top, PATH: process.env.PATH ?? '/usr/bin:/bin',
    })).toMatchObject({ loads: true, shell: true });
  } finally {
    await server.close();
  }
});

test('on macOS a reinstall waits for each old agent to disappear before loading its replacement', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  f.systemd.unloadPolls = 2;
  expect(await installService(f.ctx(['install']), f.system)).toBe(0);
  expect(f.systemd.agents.has('com.animalabs.connectome.my-resident')).toBe(true);
  expect(f.systemd.agents.has('com.animalabs.connectome.my-resident.shell')).toBe(true);
  expect(f.systemd.bootstraps).toHaveLength(4);
});

test('on macOS an agent that stays in teardown gets a bounded, specific reinstall failure', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  f.systemd.unloadPolls = Infinity;
  const before = f.slept();
  expect(await installService(f.ctx(['install']), f.system)).toBe(1);
  expect(f.slept() - before).toBe(60_000);
  expect(f.err.join('\n')).toContain("hasn't finished unloading");
  expect(f.err.join('\n')).toContain('service install command with the same recipe');
  expect(f.systemd.bootstraps).toHaveLength(1);
  expect(f.systemd.agents.has('com.animalabs.connectome.my-resident')).toBe(true);
});

test('on macOS a failed teardown query explains the failure without launchctl root advice', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const run = f.system.run;
  f.system.run = (command, args, env) => command === 'launchctl' && args[0] === 'print'
    ? { status: 1, stdout: '', stderr: 'Print failed: permission denied\nTry re-running the command as root for richer errors.\n' }
    : run(command, args, env);
  expect(await installService(f.ctx(['install']), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('Print failed: permission denied');
  expect(f.err.join('\n')).toContain('service install command with the same recipe');
  expect(f.err.join('\n')).not.toContain('re-running the command as root');
  expect(f.systemd.bootstraps).toHaveLength(1);
});

test('on macOS a bootstrap failure keeps its diagnostic and omits launchctl root advice', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin', linger: null });
  f.systemd.launchctlFailsOnce.set('bootstrap', 'Bootstrap failed: 5: Input/output error\n' +
    'Try re-running the command as root for richer errors.\n');
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('Bootstrap failed: 5: Input/output error');
  expect(f.err.join('\n')).not.toContain('re-running the command as root');
});

test('on macOS stop reports stopped only after both agents have unloaded', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  f.systemd.unloadPolls = 2;
  expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
  expect(f.systemd.agents.size).toBe(0);
  expect(f.systemd.unloading.size).toBe(0);
  expect(f.out).toContain('Stopped com.animalabs.connectome.my-resident.');
  expect(f.out).toContain('Stopped com.animalabs.connectome.my-resident.shell.');
});

test('on macOS removing a shell waits for its agent to unload before reporting removal', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  f.systemd.unloadPolls = 2;
  writeFileSync(at.recipe, '{}');
  expect(await installService(f.ctx(['install']), f.system)).toBe(0);
  expect(f.systemd.agents.has('com.animalabs.connectome.my-resident.shell')).toBe(false);
  expect(f.systemd.unloading.size).toBe(0);
  expect(f.out.join('\n')).toContain('Stopped and removed com.animalabs.connectome.my-resident.shell');
});

test('a port reference only in a server URL loads and installs its requested daemon', async () => {
  const at = install('My Resident', { shell: true });
  writeFileSync(at.recipe, JSON.stringify({
    name: 'r', agent: { provider: 'mock', systemPrompt: 'A URL-only shell reference.' },
    mcpServers: { renamed: { url: 'ws://127.0.0.1:${SESSION_SERVER_PORT}/' } },
  }));
  const f = fake(at);
  f.system.readRecipe = (recipe, work, env) => readRecipeAsHost(process.execPath, recipe, work, env);
  f.system.loadRecipe = (recipe, work, env, document) => loadRecipeAsHost(process.execPath, recipe, work, env, document);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(readServiceRecord(at.root)!.units.shell).toBeDefined();
  expect(existsSync(shellUnit(at))).toBe(true);
  expect(readEnvFile(join(at.work, '.env')).get('SESSION_SERVER_PORT')).toBe('3100');
});

test('on macOS brief unload waits are quiet and a visible pause gets one notice', async () => {
  for (const [polls, notices] of [[2, 0], [12, 1]]) {
    const at = install();
    const f = fake(at, { platform: 'darwin', linger: null });
    expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
    f.systemd.unloadPolls = polls!;
    f.out.length = 0;
    expect(await installService(f.ctx(['install']), f.system)).toBe(0);
    expect(f.out.filter((line) => line.startsWith('Waiting for '))).toHaveLength(notices!);
  }
});



test('without a local daemon, a required missing shell setting is refused before writing the service', async () => {
  const at = install();
  writeFileSync(at.recipe, JSON.stringify({ name: 'r', agent: { provider: 'mock', systemPrompt: '${SESSION_SERVER_TOKEN}' } }));
  const f = fake(at);
  f.system.readRecipe = (recipe, work, env) => readRecipeAsHost(process.execPath, recipe, work, env);
  f.system.loadRecipe = (recipe, work, env, document) => loadRecipeAsHost(process.execPath, recipe, work, env, document);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('SESSION_SERVER_TOKEN');
  nothingWritten(at);
});

test('recipe validation uses the planned numeric shell port, including a validated model endpoint', async () => {
  const at = install('My Resident', { shell: true });
  writeFileSync(at.recipe, JSON.stringify({ name: 'r', agent: {
    provider: 'openai-compatible', model: 'local', baseUrl: 'http://localhost:${SESSION_SERVER_PORT}/v1',
  } }));
  const f = fake(at);
  f.system.readRecipe = (recipe, work, env) => readRecipeAsHost(process.execPath, recipe, work, env);
  f.system.loadRecipe = (recipe, work, env, document) => loadRecipeAsHost(process.execPath, recipe, work, env, document);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(readEnvFile(join(at.work, '.env')).get('SESSION_SERVER_PORT')).toBe('3100');
});

test('a failed no-shell replacement keeps the old shell and token available for restoring its recipe', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const before = readFileSync(join(at.work, '.env'), 'utf-8');
  const next = join(at.work, 'no-shell.json');
  writeFileSync(next, '{}');
  const run = f.system.run;
  f.system.run = (command, args, env) => command === 'systemctl' && args.includes('daemon-reload')
    ? { status: 1, stdout: '', stderr: 'cannot reload' } : run(command, args, env);
  expect(await installService(f.ctx(['install', next]), f.system)).toBe(1);
  expect(f.systemd.running.has(SHELL)).toBe(true);
  expect(existsSync(shellUnit(at))).toBe(true);
  expect(readFileSync(join(at.work, '.env'), 'utf-8')).toBe(before);
  expect(readServiceRecord(at.root)!.units.shell!.name).toBe(SHELL);
  f.system.run = run;
  expect(await installService(f.ctx(['install', next]), f.system)).toBe(0);
  expect(readServiceRecord(at.root)!.units.shell).toBeUndefined();
});

test('invalid cleanup metadata is refused while the old shell service is still intact', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const before = readFileSync(join(at.work, '.env'), 'utf-8');
  const unitBefore = readFileSync(hostUnit(at), 'utf-8');
  const next = join(at.work, 'no-shell.json');
  writeFileSync(next, '{}');
  writeFileSync(join(at.work, '.setup', 'stored-secrets.json'), '{ not JSON');
  expect(await installService(f.ctx(['install', next]), f.system)).toBe(1);
  expect(f.systemd.running.has(SHELL)).toBe(true);
  expect(existsSync(shellUnit(at))).toBe(true);
  expect(readFileSync(hostUnit(at), 'utf-8')).toBe(unitBefore);
  expect(readFileSync(join(at.work, '.env'), 'utf-8')).toBe(before);
});

for (const unitFile of [hostUnit, shellUnit]) test(`an install rechecks ${unitFile.name} after awaiting its shell port`, async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  const foreign = install('Other Resident', { home: at.home });
  const text = '[Unit]\nDescription=another install\n[Service]\nWorkingDirectory=' + foreign.work + '\n';
  f.system.portFree = async () => {
    mkdirSync(unitsDir(at), { recursive: true });
    writeFileSync(unitFile(at), text);
    return true;
  };
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(readFileSync(unitFile(at), 'utf-8')).toBe(text);
  expect(f.systemd.starts).toHaveLength(0);
});

test('an unreadable launchd state keeps a possibly running agent log in place', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const log = join(at.work, 'logs', 'agent.log');
  writeFileSync(log, 'the running agent still writes here\n');
  const run = f.system.run;
  f.system.run = (command, args, env) => command === 'launchctl' && args[0] === 'list'
    ? { status: 1, stdout: '', stderr: 'cannot query launchd' } : run(command, args, env);
  expect(await runService(f.ctx(['start']), f.system)).toBe(1);
  expect(readFileSync(log, 'utf-8')).toBe('the running agent still writes here\n');
  expect(existsSync(log + '.previous')).toBe(false);
  expect(f.out.join('\n')).toContain('kept its log in place');
});



test('an authenticated prompt URL keeps its source dependency and uses the actual external token with one recipe fetch', async () => {
  const at = install();
  const body = { name: 'r', agent: { provider: 'mock', systemPrompt: 'PROMPT' } };
  const fetcher = '(request) => { const url = new URL(request.url); ' +
    'if (url.pathname === "/recipe.json") { ' +
    'if (globalThis.recipeRead) return new Response("recipe fetched twice", { status: 500 }); globalThis.recipeRead = true; ' +
    'const body = ' + JSON.stringify(body) + '; body.agent.systemPrompt = url.origin + "/prompt?token=${SESSION_SERVER_TOKEN}"; ' +
    'return Response.json(body); } ' +
    'return url.searchParams.get("token") === "external-token" ? new Response("Fetched prompt without the marker") ' +
    ': new Response("wrong token", { status: 401 }); }';
  const server = await serveRecipe(fetcher);
  try {
    const before = 'SESSION_SERVER_TOKEN="external-token"\nSESSION_SERVER_PORT="4000"\n';
    writeFileSync(join(at.work, '.env'), before, { mode: 0o600 });
    const f = fake(at);
    f.system.readRecipe = (recipe, work, env) => readRecipeAsHost(process.execPath, recipe, work, env);
    f.system.loadRecipe = (recipe, work, env, document) => loadRecipeAsHost(process.execPath, recipe, work, env, document);
    expect(await installService(f.ctx(['install', server.url + 'recipe.json']), f.system)).toBe(0);
    expect(readFileSync(join(at.work, '.env'), 'utf-8')).toBe(before);
    expect(f.out.join('\n')).toContain("term-sessions-mcp isn't installed");
    expect(readServiceRecord(at.root)!.units.shell).toBeUndefined();
  } finally {
    await server.close();
  }
});

test('source mentions and runtime shell expansion both keep the managed shell settings', async () => {
  for (const fields of [
    { agent: { provider: 'mock', systemPrompt: 'The SESSION_SERVER_TOKEN name is mentioned here.' } },
    { agent: { provider: 'mock' }, mcpServers: {
      worker: { command: 'sh', args: ['-c', 'worker "$SESSION_SERVER_PORT"'], inheritEnv: true },
    } },
  ]) {
    const at = install('My Resident', { shell: true });
    writeFileSync(at.recipe, JSON.stringify({ name: 'r', ...fields }));
    const f = fake(at);
    f.system.readRecipe = (recipe, work, env) => readRecipeAsHost(process.execPath, recipe, work, env);
    f.system.loadRecipe = (recipe, work, env, document) => loadRecipeAsHost(process.execPath, recipe, work, env, document);
    expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
    expect(readServiceRecord(at.root)!.units.shell).toBeDefined();
    expect(readEnvFile(join(at.work, '.env')).get('SESSION_SERVER_PORT')).toBe('3100');
    expect(readEnvFile(join(at.work, '.env')).get('SESSION_SERVER_TOKEN')).toHaveLength(64);
  }
});

test('after awaiting removal, an install leaves a replacement shell unit owned by another directory intact', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const record = readServiceRecord(at.root)!;
  const file = record.units.shell!.file;
  const original = readFileSync(file, 'utf-8');
  const other = install('Another Resident', { home: at.home });
  const replaced = original.replaceAll(at.work, other.work);
  const sleep = f.system.sleep;
  f.system.sleep = async (ms) => {
    await sleep(ms);
    if (f.systemd.unloading.has(record.units.shell!.name)) writeFileSync(file, replaced);
  };
  f.systemd.unloadPolls = 1;
  writeFileSync(at.recipe, '{}');
  expect(await installService(f.ctx(['install']), f.system)).toBe(1);
  expect(readFileSync(file, 'utf-8')).toBe(replaced);
  expect(f.err.join('\n')).toContain(other.work);
  expect(f.err.join('\n')).toContain('service files already written remain in place');
});


test('a replacement host that never answers leaves the previous daemon and settings available', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const before = readFileSync(join(at.work, '.env'), 'utf-8');
  writeFileSync(at.recipe, '{}');
  const openHost = f.system.openHost;
  f.system.openHost = async () => ({ reason: 'no host is running', down: true });
  expect(await installService(f.ctx(['install']), f.system)).toBe(1);
  expect(f.systemd.running.has(SHELL)).toBe(true);
  expect(existsSync(shellUnit(at))).toBe(true);
  expect(readFileSync(join(at.work, '.env'), 'utf-8')).toBe(before);
  expect(readServiceRecord(at.root)!.units.shell!.name).toBe(SHELL);
  expect(f.out.join('\n')).toContain('still recorded');
  expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
  expect(f.systemd.running.has(SHELL)).toBe(false);
  f.system.openHost = openHost;
  expect(await runService(f.ctx(['start']), f.system)).toBe(0);
  expect(f.systemd.running.has(SHELL)).toBe(true);
  expect(await installService(f.ctx(['install']), f.system)).toBe(0);
  expect(readServiceRecord(at.root)!.units.shell).toBeUndefined();
});

test('a start loaded after an unreadable answer keeps and labels earlier-load log lines', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  f.systemd.agents.clear();
  const log = join(at.work, 'logs', 'agent.log');
  writeFileSync(log, 'an earlier load wrote this\n');
  const run = f.system.run;
  let failed = false;
  f.system.run = (command, args, env) => {
    if (!failed && command === 'launchctl' && args[0] === 'list') {
      failed = true;
      return { status: 1, stdout: '', stderr: 'cannot query launchd' };
    }
    return run(command, args, env);
  };
  f.out.length = 0;
  expect(await runService(f.ctx(['start']), f.system)).toBe(0);
  expect(existsSync(log + '.previous')).toBe(false);
  expect(readFileSync(log, 'utf-8')).toBe('an earlier load wrote this\n');
  expect(f.out.join('\n')).toContain('kept its log in place');
  const { lines } = await checkService(at.root, f.system);
  expect(lines.join('\n')).toContain('can hold earlier loads');
  expect(lines).toContain('  | an earlier load wrote this');
});


test('source discovery recognizes a client name supplied by ordinary environment substitution', () => {
  const at = install();
  writeFileSync(at.recipe, JSON.stringify({ agent: { provider: 'mock' },
    mcpServers: { worker: { command: '${CLIENT_COMMAND}', args: [] } } }));
  expect(readRecipeAsHost(process.execPath, at.recipe, at.work, {
    HOME: at.home, PATH: process.env.PATH ?? '/usr/bin:/bin', CLIENT_COMMAND: '/opt/bin/term-sessions-mcp',
  })).toMatchObject({ loads: true, shell: true });
});

test('install keeps a possibly active launchd log when its state cannot be queried', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const log = join(at.work, 'logs', 'agent.log');
  writeFileSync(log, 'the running agent still writes here\n');
  const run = f.system.run;
  f.system.run = (command, args, env) => command === 'launchctl' && args[0] === 'list'
    ? { status: 1, stdout: '', stderr: 'cannot query launchd' } : run(command, args, env);
  expect(await installService(f.ctx(['install']), f.system)).toBe(1);
  expect(existsSync(log)).toBe(true);
  expect(existsSync(log + '.previous')).toBe(false);
  expect(readFileSync(log, 'utf-8')).toBe('the running agent still writes here\n');
  expect(f.out.join('\n')).toContain('kept its log in place');
});

for (const original of ['', 'SESSION_SERVER_TOKEN="old-token"\nSESSION_SERVER_PORT="3100"\n'])
for (const stage of ['source', 'validation']) {
  test(`dotenv edits during ${stage} preflight are kept and refuse the install (${original ? 'existing' : 'new'} settings)`, async () => {
    const at = install('My Resident', { shell: true });
    const f = fake(at);
    writeFileSync(join(at.work, '.env'), original);
    const changed = 'SESSION_SERVER_TOKEN="edited-token"\nSESSION_SERVER_PORT="3200"\n';
    if (stage === 'source') {
      const readRecipe = f.system.readRecipe;
      f.system.readRecipe = (recipe, work, env) => {
        const result = readRecipe(recipe, work, env);
        writeFileSync(join(at.work, '.env'), changed);
        return result;
      };
    } else {
      f.system.loadRecipe = () => {
        writeFileSync(join(at.work, '.env'), changed);
        return { loads: true };
      };
    }
    expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
    expect(readFileSync(join(at.work, '.env'), 'utf-8')).toBe(changed);
    expect(f.err.join('\n')).toContain('.env changed');
    expect(f.err.join('\n')).toContain('same recipe');
    expect(existsSync(hostUnit(at))).toBe(false);
    expect(existsSync(shellUnit(at))).toBe(false);
    expect(existsSync(join(at.root, 'service.json'))).toBe(false);
    expect(existsSync(join(at.work, '.setup', 'stored-secrets.json'))).toBe(false);
  });
}

for (const unitFile of [hostUnit, shellUnit]) test(`ownership is checked after recipe validation for ${unitFile.name}`, async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  const foreign = install('Other Resident', { home: at.home });
  const text = '[Unit]\nDescription=another install\n[Service]\nWorkingDirectory=' + foreign.work + '\n';
  f.system.loadRecipe = () => {
    mkdirSync(unitsDir(at), { recursive: true });
    writeFileSync(unitFile(at), text);
    return { loads: true };
  };
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(readFileSync(unitFile(at), 'utf-8')).toBe(text);
  expect(f.systemd.starts).toHaveLength(0);
  expect(existsSync(join(at.root, 'service.json'))).toBe(false);
});

for (const result of [
  { loads: false, words: 'the source is refused' },
  { loads: null, why: 'source read could not finish' },
] as const) test(`a first-stage recipe read ${result.loads === false ? 'refusal' : 'unknown result'} writes nothing`, async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  f.system.readRecipe = () => result;
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  nothingWritten(at);
  expect(f.loads).toHaveLength(0);
  expect(f.err.join('\n')).toContain(result.loads === false ? result.words : result.why);
});

test('an obsolete failed shell does not block a checked no-shell replacement from retiring it', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  writeFileSync(at.recipe, '{}');
  f.systemd.running.delete(SHELL);
  f.systemd.crashing.add(SHELL);
  expect(await installService(f.ctx(['install']), f.system)).toBe(0);
  expect(existsSync(shellUnit(at))).toBe(false);
  expect(readServiceRecord(at.root)!.units.shell).toBeUndefined();
  expect(readEnvFile(join(at.work, '.env')).has('SESSION_SERVER_TOKEN')).toBe(false);
});


test('a retiring launch agent with unreadable state keeps its record and settings until a successful retry', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const shell = readServiceRecord(at.root)!.units.shell!;
  const before = readFileSync(join(at.work, '.env'), 'utf-8');
  writeFileSync(at.recipe, '{}');
  const run = f.system.run;
  f.system.run = (command, args, env) => command === 'launchctl' && args[0] === 'list' && args[1] === shell.name
    ? { status: 1, stdout: '', stderr: 'cannot query launchd' } : run(command, args, env);
  expect(await installService(f.ctx(['install']), f.system)).toBe(1);
  expect(readServiceRecord(at.root)!.units.shell).toEqual(shell);
  expect(readFileSync(join(at.work, '.env'), 'utf-8')).toBe(before);
  expect(existsSync(shell.file)).toBe(true);
  expect(f.systemd.agents.has(shell.name)).toBe(true);
  expect(f.out.join('\n')).toContain('may still be running; it is still recorded');
  f.system.run = run;
  expect(await installService(f.ctx(['install']), f.system)).toBe(0);
  expect(readServiceRecord(at.root)!.units.shell).toBeUndefined();
  expect(f.systemd.agents.has(shell.name)).toBe(false);
  expect(existsSync(shell.file)).toBe(false);
  expect(readEnvFile(join(at.work, '.env')).has('SESSION_SERVER_TOKEN')).toBe(false);
});




for (const platform of ['linux', 'darwin'] as const) test(platform + ' shell retirement explains how an explicit recipe brings its daemon back', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform });
  const source = readFileSync(at.recipe, 'utf-8');
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  writeFileSync(at.recipe, '{}');
  f.out.length = 0;
  expect(await installService(f.ctx(['install']), f.system)).toBe(0);
  expect(readServiceRecord(at.root)!.units.shell).toBeUndefined();
  expect(f.out).toContain(`A managed shell daemon needs term-sessions-mcp installed in ${at.work}. To bring it back, run ` +
    'connectome service install <recipe> with a recipe that names the shell client or SESSION_SERVER_TOKEN or ' +
    'SESSION_SERVER_PORT in its source.');
  writeFileSync(at.recipe, source);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(readServiceRecord(at.root)!.units.shell).toBeDefined();
  expect(readEnvFile(join(at.work, '.env')).has('SESSION_SERVER_TOKEN')).toBe(true);
});

test('a Mac reinstall ownership refusal says the host was already unloaded', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin' });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const file = agentPlist(at);
  const label = readServiceRecord(at.root)!.units.host.name;
  const run = f.system.run;
  let changed = '';
  f.system.run = (command, args, env) => {
    const ran = run(command, args, env);
    if (command === 'launchctl' && args[0] === 'bootout' && args[1]?.endsWith('/' + label)) {
      changed = readFileSync(file, 'utf-8').replace('<string>' + at.work + '</string>', '<string>/srv/other</string>');
      writeFileSync(file, changed);
    }
    return ran;
  };
  f.err.length = 0;
  expect(await installService(f.ctx(['install']), f.system)).toBe(1);
  expect(f.systemd.agents.has(label)).toBe(false);
  expect(readFileSync(file, 'utf-8')).toBe(changed);
  expect(f.err.join('\n')).toContain(label + ' was already unloaded');
});

for (const platform of ['linux', 'darwin'] as const) test(platform + ' retirement ownership refusal names the shell operation already completed', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const shell = readServiceRecord(at.root)!.units.shell!;
  writeFileSync(at.recipe, '{}');
  const run = f.system.run;
  let changed = '';
  f.system.run = (command, args, env) => {
    const ran = run(command, args, env);
    if ((command === 'launchctl' && args[0] === 'bootout' && args[1]?.endsWith('/' + shell.name)) ||
      (command === 'systemctl' && args.includes('disable') && args.includes(shell.name))) {
      const old = readFileSync(shell.file, 'utf-8');
      changed = platform === 'darwin'
        ? old.replace('<string>' + at.work + '</string>', '<string>/srv/other</string>')
        : old.replace(/^WorkingDirectory=.*$/m, 'WorkingDirectory=/srv/other');
      writeFileSync(shell.file, changed);
    }
    return ran;
  };
  f.out.length = f.err.length = 0;
  expect(await installService(f.ctx(['install']), f.system)).toBe(1);
  expect(readFileSync(shell.file, 'utf-8')).toBe(changed);
  expect(platform === 'darwin' ? f.systemd.agents.has(shell.name) : f.systemd.running.has(shell.name)).toBe(false);
  if (platform === 'linux') expect(f.systemd.enabled.has(shell.name)).toBe(false);
  expect(readServiceRecord(at.root)!.units.shell!.name).toBe(shell.name);
  expect([...f.out, ...f.err].join('\n')).toContain(shell.name +
    (platform === 'darwin' ? ' was already unloaded' : ' was already stopped and disabled'));
});

test('a foreign shell file written during readiness leaves the still-loaded local shell tracked', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  writeFileSync(at.recipe, '{}');
  const foreign = '[Unit]\n[Service]\nWorkingDirectory=/srv/other\n';
  const openHost = f.system.openHost;
  let replaced = false;
  f.system.openHost = async (root) => {
    if (!replaced) {
      replaced = true;
      writeFileSync(shellUnit(at), foreign);
    }
    return openHost(root);
  };
  expect(await installService(f.ctx(['install']), f.system)).toBe(1);
  expect(readFileSync(shellUnit(at), 'utf-8')).toBe(foreign);
  expect(f.systemd.running.has(SHELL)).toBe(true);
  expect(readServiceRecord(at.root)!.units.shell!.name).toBe(SHELL);
  expect(readEnvFile(join(at.work, '.env')).has('SESSION_SERVER_TOKEN')).toBe(true);
  expect(f.out.join('\n')).toContain('Its running process may still be this install\'s');
});


test('a shell-setting name introduced only by an environment value stays outside source discovery', () => {
  const at = install();
  writeFileSync(at.recipe, JSON.stringify({ agent: { provider: 'mock' },
    mcpServers: { worker: { command: 'sh', args: ['-c', '${WRAPPER}'] } } }));
  expect(readRecipeAsHost(process.execPath, at.recipe, at.work, {
    HOME: at.home, PATH: process.env.PATH ?? '/usr/bin:/bin', WRAPPER: 'worker "$SESSION_SERVER_PORT"',
  })).toMatchObject({ loads: true, shell: false });
});


function holdReadiness(f: Fake): { entered: Promise<void>; release(): void } {
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((done) => { entered = done; });
  const blocked = new Promise<void>((done) => { release = done; });
  const open = f.system.openHost;
  let first = true;
  f.system.openHost = async (root) => {
    if (first) { first = false; entered(); await blocked; }
    return open(root);
  };
  return { entered: reached, release };
}

test('an overlapping shell install is refused while a no-shell replacement is waiting, without changing its state', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const noShell = join(at.work, 'no-shell.json');
  writeFileSync(noShell, '{}');
  const gate = holdReadiness(f);
  const first = installService(f.ctx(['install', noShell]), f.system);
  await gate.entered;
  try {
    const record = readFileSync(join(at.root, 'service.json'), 'utf-8');
    const env = readFileSync(join(at.work, '.env'), 'utf-8');
    const calls = f.systemd.calls.length;
    expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
    expect(f.systemd.calls.length).toBe(calls);
    expect(readFileSync(join(at.root, 'service.json'), 'utf-8')).toBe(record);
    expect(readFileSync(join(at.work, '.env'), 'utf-8')).toBe(env);
    expect(f.err.join('\n')).toContain('Another connectome service command');
    expect(f.err.join('\n')).toContain('Nothing was changed');
    expect(f.err.join('\n')).toContain('Wait for it to finish, then repeat this command.');
    expect((await checkService(at.root, f.system)).passed).toBe(true);
  } finally {
    gate.release();
    await first;
  }
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(readServiceRecord(at.root)!.units.shell!.name).toBe(SHELL);
  expect(f.systemd.running.has(SHELL)).toBe(true);
});

for (const verb of ['start', 'stop']) test(`service ${verb} is refused while install owns the same directory`, async () => {
  const at = install();
  const f = fake(at);
  const gate = holdReadiness(f);
  const first = installService(f.ctx(['install', at.recipe]), f.system);
  await gate.entered;
  try {
    const calls = f.systemd.calls.length;
    expect(await runService(f.ctx([verb]), f.system)).toBe(1);
    expect(f.systemd.calls.length).toBe(calls);
    expect(f.err.join('\n')).toContain('Another connectome service command');
  } finally { gate.release(); await first; }
  expect(await runService(f.ctx([verb]), f.system)).toBe(0);
});

test('symlink aliases share the service command guard, while another install can proceed', async () => {
  const at = install();
  const f = fake(at);
  const other = install('Other Resident', { home: at.home });
  const g = fake(other);
  const alias = join(at.home, 'alias');
  symlinkSync(at.work, alias);
  const gate = holdReadiness(f);
  const first = installService(f.ctx(['install', at.recipe]), f.system);
  await gate.entered;
  try {
    const ctx = { ...f.ctx(['install', at.recipe]), root: join(alias, 'connectome-host') };
    expect(await installService(ctx, f.system)).toBe(1);
    expect(f.err.join('\n')).toContain('Another connectome service command');
    expect(await installService(g.ctx(['install', other.recipe]), g.system)).toBe(0);
  } finally { gate.release(); await first; }
});


test('a deactivating shell with a config conflict keeps its reference and settings', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const before = readFileSync(join(at.work, '.env'), 'utf-8');
  writeFileSync(at.recipe, '{}');
  mkdirSync(shellUnit(at) + '.d', { recursive: true });
  writeFileSync(join(shellUnit(at) + '.d', 'override.conf'), '[Service]\nWorkingDirectory=/srv/other\n');
  f.systemd.run('systemctl', ['--user', 'daemon-reload'], {});
  f.systemd.running.delete(SHELL);
  f.systemd.deactivating.add(SHELL);
  expect(await installService(f.ctx(['install']), f.system)).toBe(1);
  expect(readServiceRecord(at.root)!.units.shell!.name).toBe(SHELL);
  expect(readFileSync(join(at.work, '.env'), 'utf-8')).toBe(before);
  expect(f.out.join('\n')).toContain('Its running process may still be this install\'s');
});

test('an unidentified live shell after lost record and unit file refuses cleanup and preserves settings', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const before = readFileSync(join(at.work, '.env'), 'utf-8');
  const names = new StoredSecrets(join(at.work, '.setup')).names();
  writeFileSync(at.recipe, '{}');
  rmSync(join(at.root, 'service.json'));
  rmSync(shellUnit(at));
  f.systemd.run('systemctl', ['--user', 'daemon-reload'], {});
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.systemd.running.has(SHELL)).toBe(true);
  expect(readFileSync(join(at.work, '.env'), 'utf-8')).toBe(before);
  expect(readServiceRecord(at.root)!.units.shell).toBeUndefined();
  expect(new StoredSecrets(join(at.work, '.setup')).names()).toEqual(names);
  expect(f.out.join('\n')).toContain('Shell retirement is incomplete');
  expect(f.out.join('\n')).toContain('shell settings were kept');
  expect(f.out.join('\n')).toContain('repeat this service install command');
  expect(f.out.join('\n')).toContain('If it\'s this install\'s');
  expect(f.out.join('\n')).toContain('systemctl --user stop ' + SHELL);
});

test('install plans and starts the shell named by a client command supplied through dotenv', async () => {
  const at = install('My Resident', { shell: true });
  writeFileSync(at.recipe, JSON.stringify({ name: 'r', agent: { provider: 'mock', systemPrompt: 'A shell client.' },
    mcpServers: { worker: { command: '${CLIENT_COMMAND}', args: [] } } }));
  writeFileSync(join(at.work, '.env'), 'CLIENT_COMMAND="/opt/bin/term-sessions-mcp"\n');
  const f = fake(at);
  f.system.readRecipe = (recipe, work, env) => readRecipeAsHost(process.execPath, recipe, work, env);
  f.system.loadRecipe = (recipe, work, env, document) => loadRecipeAsHost(process.execPath, recipe, work, env, document);
  expect(await installService(f.ctx(['install', at.recipe]), f.system), f.err.join('\n')).toBe(0);
  expect(readServiceRecord(at.root)!.units.shell!.name).toBe(SHELL);
  expect(f.systemd.running.has(SHELL)).toBe(true);
  expect(readEnvFile(join(at.work, '.env')).get('SESSION_SERVER_PORT')).toBe('3100');
});


for (const form of ['not a database', 'directory']) test(`an unusable service lock (${form}) refuses without mutation, naming repair`, async () => {
  const at = install();
  const f = fake(at);
  const lock = join(at.root, 'service.lock');
  if (form === 'directory') mkdirSync(lock);
  else writeFileSync(lock, 'not a database\n');
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  nothingWritten(at);
  expect(f.systemd.calls).toHaveLength(0);
  expect(f.err.join('\n')).toContain(lock);
  expect(f.err.join('\n')).toContain('Nothing was changed');
  expect(f.err.join('\n')).toContain('wait for any service command here to finish');
  rmSync(lock, { recursive: true });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
});

test('an unexpected planning error releases the service guard before a retry', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  const portFree = f.system.portFree;
  f.system.portFree = async () => { throw new Error('port probe interrupted'); };
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('port probe interrupted');
  expect(f.err.join('\n')).toContain('repeat this command');
  nothingWritten(at);
  f.system.portFree = portFree;
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
});


test('setup can hold its own lock while service install takes its separate guard', async () => {
  const at = install();
  const f = fake(at);
  const { takeFileLock } = await import('../src/setup/file-lock.js');
  mkdirSync(join(at.work, '.setup'), { recursive: true });
  const setup = takeFileLock(join(at.work, '.setup', 'setup.lock'));
  expect(setup).not.toBeNull();
  try { expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0); }
  finally { setup?.release(); }
});


test('service start keeps its guard while waiting for the host to answer', async () => {
  const at = install();
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
  const gate = holdReadiness(f);
  const start = runService(f.ctx(['start']), f.system);
  await gate.entered;
  try {
    const calls = f.systemd.calls.length;
    expect(await installService(f.ctx(['install']), f.system)).toBe(1);
    expect(f.systemd.calls.length).toBe(calls);
    expect(f.err.join('\n')).toContain('Wait for it to finish, then repeat this command.');
  } finally { gate.release(); await start; }
  expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
});

for (const operation of ['stop', 'retire']) test(`Mac ${operation} keeps the guard through the shell's unload wait`, async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const label = readServiceRecord(at.root)!.units.shell!.name;
  f.systemd.unloadPolls = 2;
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>((done) => { entered = done; });
  const gate = new Promise<void>((done) => { release = done; });
  const sleep = f.system.sleep;
  let first = true;
  f.system.sleep = async (ms) => {
    if (first && f.systemd.unloading.has(label)) { first = false; entered(); await gate; }
    return sleep(ms);
  };
  if (operation === 'retire') writeFileSync(at.recipe, '{}');
  const active = operation === 'stop' ? runService(f.ctx(['stop']), f.system)
    : installService(f.ctx(['install']), f.system);
  await reached;
  try {
    const calls = f.systemd.calls.length;
    const env = readFileSync(join(at.work, '.env'), 'utf-8');
    expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
    expect(f.systemd.calls.length).toBe(calls);
    expect(readFileSync(join(at.work, '.env'), 'utf-8')).toBe(env);
    expect(f.err.join('\n')).toContain('Wait for it to finish, then repeat this command.');
  } finally { release(); await active; }
  expect(await installService(f.ctx(['install']), f.system)).toBe(0);
});


function missingListWords(at: Install): string {
  return 'The secret-name list ' + join(at.work, '.setup', 'stored-secrets.json') +
    ' is missing, so every name in .env and the dotenv files beside it was treated as potentially secret. ' +
    'For later service checks, write it as a JSON list of the name of every secret in those files, to keep other ' +
    'values visible.';
}

for (const platform of ['linux', 'darwin']) test(`${platform} service excerpts explain missing-list redaction of Discord and short custom values`, async () => {
  const at = install('My Resident', { shell: true });
  writeFileSync(join(at.work, '.env'), 'DISCORD_TOKEN=discord-value\nCUSTOM=4\nPLAIN=visible\n');
  mkdirSync(join(at.work, '.setup'), { recursive: true });
  writeFileSync(join(at.work, '.setup', 'stored-secrets.json'), '["CUSTOM"]');
  const f = fake(at, { platform, linger: platform === 'darwin' ? null : true });
  const report = 'host: discord=discord-value short=4 other=visible';
  f.systemd.prints = () => [report];
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  rmSync(join(at.work, '.setup', 'stored-secrets.json'));
  if (platform === 'darwin') {
    f.systemd.agents.get('com.animalabs.connectome.my-resident.shell')!.pid = null;
    writeFileSync(join(at.work, 'logs', 'agent.log'), report + '\n');
    writeFileSync(join(at.work, 'logs', 'shell.log'), report + '\n');
  } else f.systemd.running.delete(SHELL);
  const checked = await checkService(at.root, f.system);
  expect(checked.passed).toBe(false);
  expect(checked.lines).toContain('  | host: discord=<DISCORD_TOKEN> short=<CUSTOM> other=<PLAIN>');
  expect(checked.lines.filter((line) => line === missingListWords(at))).toHaveLength(1);
  expect(checked.lines.indexOf(missingListWords(at))).toBeLessThan(checked.lines.indexOf('  | host: discord=<DISCORD_TOKEN> short=<CUSTOM> other=<PLAIN>'));
  mkdirSync(join(at.work, '.setup'), { recursive: true });
  writeFileSync(join(at.work, '.setup', 'stored-secrets.json'), '["CUSTOM","SESSION_SERVER_TOKEN"]');
  const restored = await checkService(at.root, f.system);
  expect(restored.lines).toContain('  | host: discord=<DISCORD_TOKEN> short=<CUSTOM> other=visible');
  expect(restored.lines).not.toContain(missingListWords(at));
});

for (const loads of [false, null]) test(`a recipe load ${loads === false ? 'refusal' : 'unknown result'} explains missing-list diagnostic redaction`, async () => {
  const at = install();
  writeFileSync(join(at.work, '.env'), 'CUSTOM=4\n');
  const f = fake(at);
  f.system.loadRecipe = () => loads === false ? { loads: false, words: 'loader short=4' }
    : { loads: null, why: 'loader short=4' };
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('loader short=<CUSTOM>');
  expect(f.err.join('\n')).toContain(missingListWords(at));
  expect(f.err.join('\n')).not.toContain('short=4');
});

test('a redacted previous recipe explains its missing-list fallback', async () => {
  const at = install();
  writeFileSync(join(at.work, '.env'), 'CUSTOM=4\n');
  const f = fake(at);
  const before = 'https://example.com/recipe?short=4';
  expect(await installService(f.ctx(['install', before]), f.system)).toBe(0);
  f.systemd.crashing.add(HOST);
  f.out.length = 0;
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.out).toContain(missingListWords(at));
  expect(f.out.join('\n')).toContain('https://example.com/recipe?short=<CUSTOM>');
  expect(f.out.join('\n')).toContain('Use the full original recipe argument with connectome service install');
  expect(f.out.join('\n')).not.toContain("holds one of the install's secrets");
  expect(f.out.join('\n')).not.toContain(before);
});


test('a first shell-service secret write keeps a manual custom value out of later excerpts', async () => {
  const at = install('My Resident', { shell: true });
  writeFileSync(join(at.work, '.env'), 'CUSTOM_SECRET=manual-private-value\n');
  const f = fake(at);
  f.systemd.prints = () => ['custom=manual-private-value'];
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const checked = await checkService(at.root, f.system);
  expect(checked.lines).toContain('  | custom=<CUSTOM_SECRET>');
  expect(checked.lines.join('\n')).not.toContain('manual-private-value');
});

for (const multiline of [false, true]) test(`service selects matching original reports beyond the excerpt while hiding ${multiline ? 'cross-line known' : 'short guessed'} values`, async () => {
  const at = install();
  const f = fake(at, multiline ? { env: { DISCORD_TOKEN: 'first-half\nerror second-half' } } : {});
  if (!multiline) writeFileSync(join(at.work, '.env'), 'CUSTOM=e\n');
  const reports = Array.from({ length: 64 }, () => 'quiet line');
  reports.push(...(multiline ? ['credential=first-half', 'error second-half tail-visible'] : ['error connecting']));
  f.systemd.prints = () => reports;
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const checked = await checkService(at.root, f.system);
  expect(checked.lines.join('\n')).toContain('with later lines matching error, fatal, failed, refused, or refuses:');
  expect(checked.lines).toContain(multiline ? '  | <DISCORD_TOKEN> tail-visible' : '  | <CUSTOM>rror conn<CUSTOM>cting');
  expect(checked.lines.join('\n')).not.toContain(multiline ? 'second-half' : 'error connecting');
});

test('an install is blocked by another process holding its service lock, then can retry', async () => {
  const at = install();
  const f = fake(at);
  const release = await holdFileLock(join(at.root, 'service.lock'));
  try {
    expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
    expect(f.err.join('\n')).toContain('Another connectome service command');
    expect(existsSync(join(at.root, 'service.json'))).toBe(false);
    expect(existsSync(hostUnit(at))).toBe(false);
    expect(f.systemd.calls).toEqual([]);
  } finally { await release(); }
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
});

test('retirement query refusal after readiness keeps settings and explains incomplete cleanup', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const settings = readFileSync(join(at.work, '.env'), 'utf-8');
  const names = new StoredSecrets(join(at.work, '.setup')).names();
  const run = f.system.run;
  let retirement = false;
  f.system.run = (cmd, args, env) => retirement && cmd === 'systemctl' && args[1] === 'show' && args.at(-1) === SHELL &&
    args.includes('--property=LoadState,ActiveState,WorkingDirectory')
    ? { status: 1, stdout: '', stderr: 'retirement query refused' } : run(cmd, args, env);
  const open = f.system.openHost;
  f.system.openHost = async (root) => { const answer = await open(root); retirement = true; return answer; };
  writeFileSync(at.recipe, '{}');
  f.out.length = 0;
  expect(await installService(f.ctx(['install']), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('retirement query refused');
  expect(f.out.join('\n')).toContain('Shell retirement is incomplete');
  expect(f.out.join('\n')).toContain('shell settings were kept');
  expect(f.out.join('\n')).toContain('repeat this service install command');
  expect(readFileSync(join(at.work, '.env'), 'utf-8')).toBe(settings);
  expect(new StoredSecrets(join(at.work, '.setup')).names()).toEqual(names);
  expect(readServiceRecord(at.root)!.units.shell!.name).toBe(SHELL);
});


for (const overlap of [false, true]) test(`the missing-list explanation states policy for ${overlap ? 'overlapping known-secret' : 'omitted log'} matches`, async () => {
  const at = install();
  const f = fake(at, overlap ? { env: { DISCORD_TOKEN: 'value-hidden' } } : {});
  writeFileSync(join(at.work, '.env'), 'CUSTOM=value-hidden\n');
  f.systemd.prints = () => overlap ? ['credential=value-hidden']
    : [...Array.from({ length: 64 }, () => 'routine'), 'credential=value-hidden'];
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const checked = await checkService(at.root, f.system);
  expect(checked.lines).toContain(missingListWords(at));
  expect(checked.lines.join('\n')).not.toContain('Some values are hidden because');
  if (!overlap) expect(checked.lines.some((line) => line.includes('credential='))).toBe(false);
  expect(checked.lines.join('\n')).not.toContain('value-hidden');
});

test('a placeholder named ERROR does not select a quiet report past the first 40', async () => {
  const at = install();
  writeFileSync(join(at.work, '.env'), 'ERROR=opaque-value\n');
  const f = fake(at);
  f.systemd.prints = () => [...Array.from({ length: 50 }, (_, at) => `quiet ${at}`), 'credential=opaque-value'];
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const checked = await checkService(at.root, f.system);
  expect(checked.lines.join('\n')).not.toContain('credential=<ERROR>');
  expect(checked.lines.join('\n')).not.toContain('with later lines matching');
  expect(checked.lines).toContain('  11 more lines not shown.');
  expect(checked.lines.filter((line) => line.startsWith('  | '))).toHaveLength(40);
});

test('a blank original line inside a masked credential consumes no excerpt slot', async () => {
  const at = install();
  const f = fake(at, { env: { DISCORD_TOKEN: 'first-part\n\nlast-part' } });
  f.systemd.prints = () => ['before first-part', '', 'last-part after',
    ...Array.from({ length: 40 }, (_, at) => 'quiet ' + at)];
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const checked = await checkService(at.root, f.system);
  const reports = checked.lines.filter((line) => line.startsWith('  | '));
  expect(reports).toHaveLength(40);
  expect(reports.slice(0, 2)).toEqual(['  | before <DISCORD_TOKEN>', '  | <DISCORD_TOKEN> after']);
  expect(reports).not.toContain('  | <DISCORD_TOKEN>');
  expect(checked.lines).toContain('  2 more lines not shown.');
  expect(checked.lines.join('\n')).not.toMatch(/first-part|last-part/);
});

test('a unit in its manager\'s default directory, which is this install, and one whose directory can\'t be resolved are each named', async () => {
  const base = install();
  const at = { ...base, home: base.work };
  const f = fake(at);
  const locked = join(base.home, 'locked');
  mkdirSync(locked);
  f.systemd.otherUnits.push({ id: 'old-host.service', workingDirectory: `!${at.work}` });
  f.systemd.otherUnits.push({ id: 'hidden.service', workingDirectory: join(locked, 'inside') });
  chmodSync(locked, 0o000);
  try {
    expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  } finally {
    chmodSync(locked, 0o700);
  }
  const said = f.out.join('\n');
  expect(said).toContain(`old-host.service sets no working directory, so it runs in its systemd manager's default, which is ${at.work}.`);
  expect(said).toContain("The working directory of hidden.service, a user unit, couldn't be resolved");
});

test('a stored shell port held by something other than this install\'s shell daemon is refused, and reused settings are named', async () => {
  const at = install('My Resident', { shell: true });
  writeFileSync(join(at.work, '.env'), 'SESSION_SERVER_PORT="3150"\nSESSION_SERVER_TOKEN="abc123"\n', { mode: 0o600 });
  const held = fake(at, { taken: [3150] });
  expect(await installService(held.ctx(['install', at.recipe]), held.system)).toBe(1);
  expect(held.err.join('\n')).toContain(`SESSION_SERVER_PORT in ${join(at.work, '.env')} is 3150, and something other than this install's shell daemon`);
  expect(existsSync(shellUnit(at))).toBe(false);
  const free = fake(at);
  expect(await installService(free.ctx(['install', at.recipe]), free.system)).toBe(0);
  expect(free.out).toContain(`The shell daemon uses SESSION_SERVER_PORT 3150 and SESSION_SERVER_TOKEN, not shown, as ${join(at.work, '.env')} holds them.`);
  expect(free.out.join('\n')).not.toContain('abc123');
});

test('a service record whose shellSettings hold a name this release doesn\'t know is read, ignoring that name', async () => {
  const at = install();
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const file = join(at.root, 'service.json');
  const record = JSON.parse(readFileSync(file, 'utf-8'));
  record.shellSettings = { ...(record.shellSettings ?? {}), SESSION_SERVER_HOST: 'localhost' };
  writeFileSync(file, JSON.stringify(record));
  expect(await runService(f.ctx(['stop']), f.system)).toBe(0);
  expect(f.err).toEqual([]);
});

test('an install whose record isn\'t bound here is told to run setup discord', async () => {
  const at = install();
  writeFileSync(join(at.root, 'install.json'), JSON.stringify({ v: 1, dataDir: at.data, extraState: [], workingDir: join(at.home, 'Elsewhere') }));
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('setup discord here to confirm each recorded place');
});

test('a systemctl that refuses --timestamp=, as systemd before 247 does, still answers every check', async () => {
  const at = install();
  const f = fake(at);
  const run = f.system.run;
  f.system.run = (command, args, env) => command === 'systemctl' && args.some((arg) => arg.startsWith('--timestamp'))
    ? { status: 1, stdout: '', stderr: "systemctl: unrecognized option '--timestamp=utc'" } : run(command, args, env);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(f.out.join('\n')).not.toContain("couldn't be asked");
  expect(f.systemd.envs.some((env) => env.TZ === 'UTC' && env.LC_ALL === 'C')).toBe(true);
});

test('retiring the shell settings removes only the lines holding the values this service wrote', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const file = join(at.work, '.env');
  writeFileSync(file, 'SESSION_SERVER_TOKEN="personal"\n' + readFileSync(file, 'utf-8'), { mode: 0o600 });
  writeFileSync(at.recipe, JSON.stringify({}));
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(readEnvFile(file).get('SESSION_SERVER_TOKEN')).toBe('personal');
  expect(readEnvFile(file).has('SESSION_SERVER_PORT')).toBe(false);
});

test('retiring the shell settings keeps the token\'s stored-secret name while .env.local still gives it', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  writeFileSync(join(at.work, '.env.local'), 'SESSION_SERVER_TOKEN="local-value"\n', { mode: 0o600 });
  writeFileSync(at.recipe, JSON.stringify({}));
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(new StoredSecrets(join(at.work, '.setup')).names()).toContain('SESSION_SERVER_TOKEN');
  expect(f.out.join('\n')).not.toContain('local-value');
});

test('a retry forgets the recorded shell names whose values an interrupted retirement already removed', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const file = join(at.work, '.env');
  writeFileSync(file, readFileSync(file, 'utf-8').split('\n').filter((line) => !line.startsWith('SESSION_SERVER_')).join('\n'), { mode: 0o600 });
  writeFileSync(at.recipe, JSON.stringify({}));
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(new StoredSecrets(join(at.work, '.setup')).names()).not.toContain('SESSION_SERVER_TOKEN');
});

test('an explicit install over a record it can\'t read in full still refuses one naming another working directory', async () => {
  const at = install();
  const elsewhere = join(at.home, 'Original');
  writeFileSync(join(at.root, 'service.json'), JSON.stringify({ v: 1, manager: 'a-later-manager',
    units: { host: { name: 'connectome-original.service', file: join(at.home, 'connectome-original.service') } },
    hostArgs: [at.recipe, '--headless'], workingDirectory: elsewhere, logs: { kind: 'journal' } }));
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain(`It names another working directory, ${elsewhere}`);
  expect(existsSync(hostUnit(at))).toBe(false);
});

test('macOS retires a same-directory record\'s agents under their recorded labels when the slug has changed', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin' });
  const old = 'com.animalabs.connectome.old-name';
  const dir = join(at.home, 'Library', 'LaunchAgents');
  writeFileSync(join(at.root, 'service.json'), JSON.stringify({ v: 1, manager: 'launchd',
    units: { host: { name: old, file: join(dir, `${old}.plist`) }, shell: { name: `${old}.shell`, file: join(dir, `${old}.shell.plist`) } },
    hostArgs: [at.recipe, '--headless'], workingDirectory: at.work, logs: { kind: 'file', path: join(at.work, 'logs', 'agent.log') } }));
  f.systemd.agents.set(old, { pid: 7001 });
  f.systemd.agents.set(`${old}.shell`, { pid: 7002 });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(f.systemd.agents.has(old)).toBe(false);
  expect(f.systemd.agents.has(`${old}.shell`)).toBe(false);
});

for (const platform of ['linux', 'darwin'] as const) test(platform + ': a record\'s own host unit under its old name, present and loaded here, is retired rather than refused', async () => {
  const at = install();
  const f = fake(at, { platform });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const run = (command: string, args: string[]) => expect(f.system.run(command, args, {}).status).toBe(0);
  const name = platform === 'linux' ? 'connectome-old-name.service' : 'com.animalabs.connectome.old-name';
  const file = platform === 'linux' ? join(unitsDir(at), name) : agentPlist(at, name);
  if (platform === 'linux') {
    run('systemctl', ['--user', 'stop', HOST]);
    renameSync(hostUnit(at), file);
    for (const args of [['daemon-reload'], ['enable', name], ['start', name]]) run('systemctl', ['--user', ...args]);
  } else {
    run('launchctl', ['bootout', 'gui/1001/com.animalabs.connectome.my-resident']);
    writeFileSync(file, readFileSync(agentPlist(at), 'utf-8')
      .replace('<string>com.animalabs.connectome.my-resident</string>', `<string>${name}</string>`));
    rmSync(agentPlist(at));
    run('launchctl', ['bootstrap', 'gui/1001', file]);
  }
  const record = JSON.parse(readFileSync(join(at.root, 'service.json'), 'utf-8'));
  writeFileSync(join(at.root, 'service.json'), JSON.stringify({ ...record, units: { host: { name, file } } }));
  f.err.length = 0;
  expect(await installService(f.ctx(['install']), f.system)).toBe(0);
  expect(f.err).toEqual([]);
  expect(existsSync(file)).toBe(false);
  expect(existsSync(platform === 'linux' ? hostUnit(at) : agentPlist(at))).toBe(true);
});

test('a loader\'s stderr is redacted whole before its last line is shown', async () => {
  const at = install();
  const secret = 'first-half\nsecond-half';
  const f = fake(at, { env: { PATH: `${at.root}:/usr/bin:/bin`, SESSION_SERVER_TOKEN: secret } });
  const loader = join(at.work, 'failing-loader');
  writeFileSync(loader, `#!/bin/sh\nprintf 'loading\\nfirst-half\\nsecond-half\\n' >&2\nexit 3\n`, { mode: 0o755 });
  f.system.loadRecipe = (recipe, work, env, document) => loadRecipeAsHost(loader, recipe, work, env, document);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain("whether the host can load the recipe couldn't be checked");
  expect(f.err.join('\n')).not.toContain('second-half');
});

test('a secret quoted with JSON escapes in the loader\'s words is masked too', async () => {
  const at = install();
  const secret = 'tok"en-value';
  const f = fake(at, { env: { PATH: `${at.root}:/usr/bin:/bin`, SESSION_SERVER_TOKEN: secret },
    recipeLoad: { loads: false, words: `Recipe agent.proseRouting must be 'locus', 'explicit', 'hybrid', or 'disabled', got ${JSON.stringify(secret)}.` } });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('agent.proseRouting');
  expect(f.err.join('\n')).not.toContain('en-value');
});

test('a host that answers with another install\'s process isn\'t taken as this install\'s', async () => {
  const first = install();
  const f = fake(first);
  expect(await installService(f.ctx(['install', first.recipe]), f.system)).toBe(0);
  const copy = install('Copy', { home: first.home });
  const g = fake(copy);
  g.systemd = f.systemd;
  g.system.run = (command, args, env) => f.systemd.run(command, args, env);
  const original = await f.system.openHost(first.root);
  g.system.openHost = async () => original;
  expect(await installService(g.ctx(['install', copy.recipe]), g.system)).toBe(1);
  expect(g.err.join('\n')).toContain(`A host answers with pid 4242, but connectome-copy.service's main process is`);
});

test('a failed state query after the units are written points to service start, which starts only what isn\'t running', async () => {
  const at = install();
  const f = fake(at);
  const run = f.system.run;
  let shows = 0;
  f.system.run = (command, args, env) => {
    if (command === 'systemctl' && args.join(' ') === `--user show --property=ActiveState -- ${HOST}` && ++shows === 1) {
      return { status: 1, stdout: '', stderr: 'Failed to get properties: Connection timed out' };
    }
    return run(command, args, env);
  };
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('service start to start what isn\'t running');
});

test('macOS refuses another plist with this install\'s host label and working directory', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin' });
  const other = join(at.home, 'Library', 'LaunchAgents', 'renamed-copy.plist');
  mkdirSync(dirname(other), { recursive: true });
  writeFileSync(other, 'bplist00fixture');
  const run = f.system.run;
  f.system.run = (command, args, env) => command === 'plutil' && args.at(-1) === other
    ? plistFields(args, { Label: 'com.animalabs.connectome.my-resident', WorkingDirectory: at.work })
    : run(command, args, env);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(existsSync(agentPlist(at))).toBe(false);
  expect(f.err.join('\n')).toContain(`${other} has the label com.animalabs.connectome.my-resident`);
  expect(f.err.join('\n')).toContain(`launchctl bootout gui/1001 ${other} if launchctl print ` +
    'gui/1001/com.animalabs.connectome.my-resident finds it, then remove that plist.');
});

test('a directory at service.json is named, and an explicit install refuses before writing any unit', async () => {
  const at = install();
  mkdirSync(join(at.root, 'service.json'));
  const f = fake(at);
  expect(await runService(f.ctx(['stop']), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain("It isn't a file, so no install can write the record there: move it aside or take it away");
  const g = fake(at);
  expect(await installService(g.ctx(['install', at.recipe]), g.system)).toBe(1);
  expect(existsSync(hostUnit(at))).toBe(false);
  expect(g.err.join('\n')).toContain('Nothing was written.');
});
