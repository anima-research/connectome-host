import { afterEach, expect, test } from 'bun:test';
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  installService, portFree, recipeHasShell, runService, serviceCommands, serviceLines, unitElsewhere, type ServiceSystem,
} from '../src/cli/service.js';
import { serviceUnits, slugOf } from '../src/cli/service-unit.js';
import { SHOWN_FILE } from '../src/cli/shown.js';
import { readRecipeDocument } from '../src/recipe-document.js';
import { StoredSecrets, readEnvFile, writeEnvValue } from '../src/setup/secrets.js';

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
  writeFileSync(join(root, 'install.json'), JSON.stringify({ v: 1, dataDir: data, extraState: [] }));
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

/** A plist's string values by key path, as plutil names them: a value in a nested dict is under its dict's key, then
 *  a dot, then its own key. */
function xmlPlistFields(path: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const within: string[] = [];
  let key: string | null = null;
  for (const [token, named, value] of readFileSync(path, 'utf-8')
    .matchAll(/<key>([^<]*)<\/key>|<string>([^<]*)<\/string>|<\/?dict>|<\/?array>/g)) {
    if (named !== undefined) key = named;
    else if (token === '<dict>' || token === '<array>') {
      within.push(key ?? '');
      key = null;
    } else if (token === '</dict>' || token === '</array>') within.pop();
    else if (value !== undefined && key !== null) {
      fields[[...within.slice(1), key].join('.')] = value.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&amp;/g, '&');
      key = null;
    }
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

/** A stand-in for systemd's user manager, as systemd 257 behaved where a verdict depends on it:
 *  - it reads unit files and their drop-ins on daemon-reload, and loads a unit asked for by name from its file;
 *  - a pattern lists only the units it holds in memory: those asked for by name, enabled or started;
 *  - `show` answers only the properties asked for;
 *  - each start is an invocation of its own;
 *  - a process that exits at once under Restart=on-failure reads as activating (auto-restart) between restarts, with
 *    NRestarts rising and a new invocation at each start;
 *  - a unit still running when its file is gone reads not-found and active after a reload, `disable` refuses it, and
 *    `stop` stops it;
 *  - a unit stopped at its start limit refuses `start` and `restart` until `reset-failed`;
 *  - a unit on its way down reads deactivating until a `stop` has waited for it;
 *  - `stop`, `start` and `restart` each take several units, and `start` leaves a unit that's running as it is;
 *  - `show` gives an enabled unit's UnitFileState as enabled, and another loaded unit's as disabled;
 *  - a unit that has failed keeps its last InvocationID;
 *  - a unit's main process keeps the environment it started with, while `show` gives the loaded unit's, which a
 *    daemon-reload changes (systemd 259);
 *  - `launchctl print` gives a loaded agent's environment as it was bootstrapped, which each start of it takes,
 *    whatever its plist says since (macOS 26);
 *  - a second host started from one working directory exits at once, standing in for the store's lock, which is per
 *    data directory: each install here has a data directory of its own. */

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
  envs: Array<Record<string, string>> = [];
  otherUnits: Array<{ id: string; workingDirectory: string; scope?: 'system'; fragment?: string }> = [];
  systemAnswers = true;
  agents = new Map<string, { pid: number | null; environment?: Record<string, string> }>();
  environs = new Map<number, string[]>();
  agentsExit = false;
  unloadPolls = 0;
  exitTimeout: number | null = null;
  unloading = new Map<string, number>();
  bootstraps: string[] = [];
  primary = '';
  pids = new Map<string, number>();
  private invocations = 0;

  pidFor(unit: string): number {
    if (!this.pids.has(unit)) this.pids.set(unit, unit === this.primary ? 4242 : 5000 + this.pids.size);
    return this.pids.get(unit)!;
  }

  private startCount = new Map<string, number>();

  newPid(unit: string): number {
    const started = this.startCount.get(unit) ?? 0;
    this.startCount.set(unit, started + 1);
    if (started > 0) this.pids.set(unit, this.pidFor(unit) + 100);
    return this.pidFor(unit);
  }

  constructor(private readonly home: string) {}

  dir(): string {
    return join(this.home, '.config', 'systemd', 'user');
  }

  run(command: string, args: string[], env: Record<string, string>): Ran {
    this.calls.push(`${command} ${args.join(' ')}`);
    this.envs.push(env);
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
    // As chronicle does, a host's store opens for one process at a time, so a second host on one store exits at once.
    const host = (each: Loaded | undefined) => each !== undefined && each.execStart.includes('start.js');
    const locked = host(loaded) && [...this.running.keys()].some((other) => other !== unit &&
      host(this.loaded.get(other)) && this.loaded.get(other)!.workingDirectory === loaded.workingDirectory);
    if (this.exiting.has(unit) || locked) this.running.delete(unit);
    else {
      this.running.set(unit, invocation);
      this.environs.set(this.newPid(unit), loaded.environment);
    }
    this.latest.set(unit, invocation);
    this.starts.push({ unit, environment: loaded.environment, execStart: loaded.execStart });
  }

  environOf(pid: string): string {
    const environment = this.environs.get(Number(pid));
    if (environment === undefined) throw new Error(`ENOENT: no such file or directory, open '/proc/${pid}/environ'`);
    return environment.map((entry) => `${entry}\0`).join('');
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
      if (!unit.endsWith('.shell.service') && asked.includes('Restart')) this.checkedEnvironment.push(loaded.environment);
    }
    const crashing = loaded !== undefined && this.running.has(unit) && this.crashing.has(unit);
    if (crashing) {
      this.nrestarts.set(unit, (this.nrestarts.get(unit) ?? 0) + 1);
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
        : ok(`\tstate = ${remaining === undefined ? 'running' : 'SIGTERMed'}\n` +
          '\tdefault environment = {\n\t\tPATH => /usr/bin:/bin:/usr/sbin:/sbin\n\t}\n' +
          `\tenvironment = {\n${Object.entries(agent.environment ?? {}).map(([key, value]) => `\t\t${key} => ${value}\n`)
            .join('')}\t}\n` +
          `${this.exitTimeout === null ? '' : `\texit timeout = ${this.exitTimeout}\n`}\tpid = ${agent.pid}\n`);
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
      const environment = Object.fromEntries(Object.entries(xmlPlistFields(file!))
        .filter(([key]) => key.startsWith('EnvironmentVariables.'))
        .map(([key, value]) => [key.slice('EnvironmentVariables.'.length), value]));
      this.agents.set(label, { pid: this.agentsExit ? null : this.newPid(label), environment });
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
      if (!this.agentsExit) agent.pid = this.newPid(target!.split('/').at(-1)!);
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
  read: string[];
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
  other?: number;
  silent?: boolean;
  owner?: number;
} = {}): Fake {
  const systemd = new FakeSystemd(at.home);
  const hostOf = (root: string) => (options.platform === 'darwin' ? 'com.animalabs.connectome.' : 'connectome-') +
    slugOf(basename(dirname(root))) + (options.platform === 'darwin' ? '' : '.service');
  systemd.primary = hostOf(at.root);
  const out: string[] = [];
  const err: string[] = [];
  const read: string[] = [];
  const taken = new Set(options.taken ?? []);
  let clock = 0;
  let slept = 0;
  let asked = 0;
  const running = (root: string) => options.platform === 'darwin'
    ? (systemd.agents.get(hostOf(root))?.pid ?? null) !== null : systemd.running.has(hostOf(root));
  const system: ServiceSystem = {
    platform: options.platform ?? 'linux',
    user: 'resident',
    uid: 1001,
    home: at.home,
    cwd: options.cwd ?? at.work,
    env: options.env ?? { PATH: `${at.root}:/usr/bin:/bin` },
    bun: '/opt/bun/bin/bun',
    owner: () => options.owner ?? 1001,
    cgroup: () => options.cgroup ?? null,
    which: (name) => (name === 'node' ? (options.node === undefined ? '/opt/node/bin/node' : options.node) : null),
    run: (command, args, env) => systemd.run(command, args, env),
    environ: (pid) => systemd.environOf(pid),
    readRecipe: async (recipe) => {
      read.push(recipe);
      return /^https?:\/\//.test(recipe) ? {} : (await readRecipeDocument(recipe)).raw;
    },
    linger: () => (options.linger === undefined ? true : options.linger),
    portFree: async (port) => !taken.has(port),
    openHost: async (root) => {
      const recipe = root === at.root ? 'Resident' : basename(dirname(root));
      if (options.other !== undefined) return { ready: { pid: options.other, recipe }, close() {} } as never;
      if (options.silent) {
        return { reason: `the socket ${join(at.data, 'ipc.sock')} accepted the connection, but no host said it was ` +
          'ready within 5 s', down: false };
      }
      if (!running(root)) return { reason: 'there\'s no socket: no host is running, or one is still starting', down: true };
      asked++;
      return options.ready === false || asked <= (options.answersAfter ?? 0)
        ? { reason: 'no host is running', down: true }
        : { ready: { pid: systemd.pidFor(hostOf(root)), recipe }, close() {} } as never;
    },
    sleep: async (ms) => {
      clock += ms;
      slept += ms;
    },
    now: () => clock,
  };
  return {
    system, systemd, out, err, read,
    slept: () => slept,
    ctx: (argv) => ({ root: at.root, argv, out: (line) => out.push(line), err: (line) => err.push(line) }),
  };
}

const unitsDir = (at: Install) => join(at.home, '.config', 'systemd', 'user');
const hostUnit = (at: Install) => join(unitsDir(at), 'connectome-my-resident.service');
const shellUnit = (at: Install) => join(unitsDir(at), 'connectome-my-resident.shell.service');
const agentPlist = (at: Install, label = 'com.animalabs.connectome.my-resident') =>
  join(at.home, 'Library', 'LaunchAgents', `${label}.plist`);
const HOST = 'connectome-my-resident.service';
const SHELL = 'connectome-my-resident.shell.service';

function nothingWritten(at: Install, unitFile = hostUnit(at)): void {
  expect(existsSync(unitFile)).toBe(false);
  expect(existsSync(shellUnit(at))).toBe(false);
  expect(existsSync(join(at.work, '.env'))).toBe(false);
  expect(existsSync(join(at.work, '.setup', 'stored-secrets.json'))).toBe(false);
}

test('the host unit runs start.js with the recipe from the working directory, with a PATH of bun\'s and node\'s directories, then install\'s own PATH but its relative entries, then the system\'s', async () => {
  const at = install();
  const f = fake(at, { env: { PATH: `${at.root}:bin::/usr/bin:/opt/tools/bin` } });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const text = readFileSync(hostUnit(at), 'utf-8');
  expect(text).toContain(`WorkingDirectory=${at.work}\n`);
  expect(text).toContain(`ExecStart="/opt/bun/bin/bun" "${at.root}/start.js" "${at.recipe}" "--headless"\n`);
  expect(text).toContain(`Environment="PATH=/opt/bun/bin:/opt/node/bin:${at.root}:/usr/bin:/opt/tools/bin:/usr/local/bin:/bin:/usr/sbin:/sbin"\n`);
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
  writeFileSync(join(at.root, 'install.json'), JSON.stringify({ v: 1, dataDir: kept, extraState: [] }));
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
  writeFileSync(join(at.root, 'install.json'), JSON.stringify({ v: 1, dataDir: 'data', extraState: [] }));
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
  expect(readFileSync(hostUnit(at), 'utf-8')).toContain(`"${at.root}/start.js" "${at.recipe}" "--headless"`);
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

test('under setup\'s agent, every line service install prints also goes to the file the person is shown, in the order printed', async () => {
  const cases: { recipe: boolean; options: Parameters<typeof fake>[1]; code: number }[] = [
    { recipe: true, options: {}, code: 0 },
    { recipe: true, options: { linger: false }, code: 1 },
    { recipe: false, options: {}, code: 2 },
  ];
  for (const { recipe, options, code } of cases) {
    const at = install('My Resident', { shell: true });
    const shown = join(at.home, 'shown.txt');
    writeFileSync(shown, '', { mode: 0o600 });
    const f = fake(at, { ...options, env: { PATH: `${at.root}:/usr/bin:/bin`, [SHOWN_FILE]: shown } });
    const said: string[] = [];
    const ctx = { root: at.root, argv: recipe ? ['install', at.recipe] : ['install'],
      out: (line: string) => said.push(line), err: (line: string) => said.push(line) };
    expect(await runService(ctx, f.system)).toBe(code);
    expect(said.length).toBeGreaterThan(0);
    expect(readFileSync(shown, 'utf-8')).toBe(said.map((line) => `${line}\n`).join(''));
  }
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

test('a working directory with no letter or digit in its name is refused', async () => {
  const at = install('···');
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('···');
  expect(readdirSync(at.home)).toEqual(['···']);
});

test('run from inside the host\'s or the shell daemon\'s unit it refuses, writing nothing, and says who can run it', async () => {
  for (const unit of [HOST, SHELL]) {
    const at = install('My Resident', { shell: true });
    const f = fake(at, { cgroup: `0::/user.slice/user-1001.slice/user@1001.service/app.slice/${unit}\n` });
    expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
    expect(f.err).toEqual([`connectome: connectome service install restarts ${unit}, and this command runs inside it, so ` +
      'that would end this command partway, before it knows whether the host answers. Nothing was written. Ask ' +
      'whoever runs ' +
      'this machine to run it from a terminal outside the resident\'s service, such as over ssh.']);
    nothingWritten(at);
  }
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  rmSync(join(at.work, 'node_modules', 'term-sessions-mcp'), { recursive: true });
  f.system.cgroup = () => `0::/user.slice/user-1001.slice/user@1001.service/app.slice/${SHELL}/sessions\n`;
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
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
  expect(text).toContain(`<key>PATH</key>\n    <string>/opt/bun/bin:/opt/node/bin:${at.root}:/usr/bin:/bin:/usr/local/bin:/usr/sbin:/sbin</string>`);
  expect(text).toContain('<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>');
  expect(text).toContain(`<string>${at.work}/logs/agent.log</string>`);
  expect(f.systemd.calls).toContain(`launchctl bootstrap gui/1001 ${agentPlist(at)}`);
  expect(serviceLines(at.root, f.system)).toEqual([
    `Its service is the launch agent com.animalabs.connectome.my-resident, in ${agentPlist(at)}.`,
    `  follow its log: tail -f '${join(at.work, 'logs', 'agent.log')}'`,
    `  stop it until the next login: launchctl bootout gui/1001 ${agentPlist(at)}`,
    `  start it: launchctl kickstart gui/1001/com.animalabs.connectome.my-resident 2>/dev/null || launchctl bootstrap ` +
      `gui/1001 ${agentPlist(at)}`]);
});

test('on macOS the agents\' log directory is readable by its user alone', async () => {
  const at = install();
  mkdirSync(join(at.work, 'logs'));
  chmodSync(join(at.work, 'logs'), 0o755);
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(statSync(join(at.work, 'logs')).mode & 0o777).toBe(0o700);
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
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(f.out).toContain(`Reloaded com.animalabs.connectome.my-resident from ${agentPlist(at)}.`);
  expect(f.err).toEqual([]);
});

test('a launch agent with no file whose state launchctl can\'t give is not taken as free', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin' });
  f.systemd.agents.set('com.animalabs.connectome.my-resident', { pid: 999 });
  const run = f.system.run;
  f.system.run = (command, args, env) => command === 'launchctl' && args[0] === 'list' &&
    args[1] === 'com.animalabs.connectome.my-resident'
    ? { status: 5, stdout: '', stderr: 'manager denied query' }
    : run(command, args, env);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('launchctl list com.animalabs.connectome.my-resident failed: manager denied ' +
    'query, so whether it runs another install can\'t be told. Nothing was written.');
  expect(existsSync(agentPlist(at))).toBe(false);
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

test('a unit of this install\'s name systemd can\'t be asked about is refused, writing nothing', async () => {
  const at = install();
  const f = fake(at);
  f.systemd.failOnce.set(`show ${HOST}`, 'Failed to connect to bus: No such file or directory');
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('so whether it runs another install can\'t be told. Nothing was written.');
  nothingWritten(at);
});

test('a unit of this install\'s name still running with its unit file gone is refused, naming the line that stops it', async () => {
  const at = install();
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  rmSync(hostUnit(at));
  f.systemd.run('systemctl', ['--user', 'daemon-reload'], {});
  const startsBefore = f.systemd.starts.length;
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  const said = f.err.join('\n');
  expect(said).toContain(`${HOST} is still running, but its file, ${hostUnit(at)}, is gone`);
  expect(said).toContain(`systemctl --user stop ${HOST}`);
  expect(existsSync(hostUnit(at))).toBe(false);
  expect(f.systemd.starts.length).toBe(startsBefore);
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
});

test('on macOS a launch agent of this install\'s name loaded with its plist gone is refused, naming the line that boots it out', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  rmSync(agentPlist(at));
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('launchctl bootout gui/1001/com.animalabs.connectome.my-resident');
  expect(existsSync(agentPlist(at))).toBe(false);
  expect(f.systemd.bootstraps).toHaveLength(1);
});

test('a Linux same-directory unit that is not a host is offered another working directory', async () => {
  const at = install();
  const f = fake(at);
  f.systemd.otherUnits.push({ id: 'indexer.service', workingDirectory: at.work, fragment: '/indexer.service' });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('indexer.service');
  expect(f.err.join('\n')).toContain('another working directory');
});

test('another unit that already runs a host from this working directory is refused, naming it, its kind and its file', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  const file = join(unitsDir(at), 'resident\\x2dold.service');
  f.systemd.otherUnits.push({ id: 'resident\\x2dold.service', workingDirectory: at.work, fragment: file });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  const said = f.err.join('\n');
  expect(said).toContain(`resident\\x2dold.service (a user unit, at ${file}) is already set up to run from ${at.work}`);
  expect(said).toContain('the store\'s lock, over and over. XDG_RUNTIME_DIR=/run/user/1001 systemctl --user status ' +
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
  expect(f.err.join('\n')).toContain('the store\'s lock, over and over. XDG_RUNTIME_DIR=/run/user/1001 systemctl --user status ' +
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
  expect(f.err.join('\n')).toContain(`the store's lock, over and over. systemctl status ${HOST} shows its state, and its process if it's ` +
    'running. If that shows nothing ' +
    'uses it, take it away: as root, ');
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
  expect(named[0]).toContain('The working directory of the user unit elsewhere-agent.service couldn\'t be resolved');
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
  expect(named[0]).toContain('The working directory of the system unit elsewhere-agent.service couldn\'t be resolved');
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

test('a unit in its manager\'s default directory, which is this install, is named, and units whose directory can\'t be resolved get one note', async () => {
  const base = install();
  const at = { ...base, home: base.work };
  const f = fake(at);
  const loop = join(dirname(base.home), 'loop');
  symlinkSync(loop, loop);
  f.systemd.otherUnits.push({ id: 'old-host.service', workingDirectory: `!${at.work}` });
  f.systemd.otherUnits.push({ id: 'hidden.service', workingDirectory: join(loop, 'inside') });
  f.systemd.otherUnits.push({ id: 'hidden-two.service', workingDirectory: join(loop, 'other') });
  f.systemd.otherUnits.push({ id: 'system-hidden.service', workingDirectory: join(loop, 'srv'), scope: 'system' });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(f.out.join('\n')).toContain(`old-host.service sets no working directory, so it runs in its systemd manager's default, which is ${at.work}.`);
  expect(f.out.filter((line) => line.includes('hidden'))).toEqual([`The working directories of the user units hidden.service, ` +
    `hidden-two.service and the system unit system-hidden.service couldn't be resolved, so whether one of them runs a host ` +
    `from ${at.work} can't be told, and one that does isn't ruled out.`]);
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

test('a host unit that systemd shows with another working directory, once written, is refused: nothing is started', async () => {
  const at = install();
  mkdirSync(`${hostUnit(at)}.d`, { recursive: true });
  writeFileSync(join(`${hostUnit(at)}.d`, 'override.conf'), '[Service]\nWorkingDirectory=/srv/elsewhere\n');
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(existsSync(hostUnit(at))).toBe(true);
  expect(readFileSync(hostUnit(at), 'utf-8')).not.toContain('CONNECTOME_SUPERVISED');
  expect(f.systemd.starts).toEqual([]);
  expect(f.err.join('\n')).toContain(`systemd doesn't show ${HOST} loaded with ${at.work} as its working directory ` +
    '(it shows loaded, in /srv/elsewhere)');
});

test('a running host whose restart check fails keeps running, and the next run that passes restarts it', async () => {
  const at = install();
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const startsBefore = f.systemd.starts.length;
  mkdirSync(`${hostUnit(at)}.d`, { recursive: true });
  writeFileSync(join(`${hostUnit(at)}.d`, 'override.conf'), '[Service]\nRestart=no\n');
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.systemd.starts.length).toBe(startsBefore);
  expect(f.systemd.running.has(HOST)).toBe(true);
  const said = f.err.join('\n');
  expect(said).toContain('keeps what it started with, CONNECTOME_SUPERVISED=1 included');
  expect(said).toContain(`systemctl --user restart ${HOST} restarts it on the unit as it is now: the file this run wrote, ` +
    'with the recipe it was given, and any drop-in over it.');
  expect(said).toContain(`systemctl --user restart ${HOST}`);
  rmSync(`${hostUnit(at)}.d`, { recursive: true });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
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

test('systemctl gets XDG_RUNTIME_DIR for this user when the environment lacks it', async () => {
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

for (const platform of ['linux', 'darwin'] as const) test('readiness refuses an answering host outside the ' + platform + ' unit', async () => {
  const at = install();
  const f = fake(at, { platform });
  const open = f.system.openHost;
  f.system.openHost = async (root) => {
    const answer = await open(root);
    return 'reason' in answer ? answer : { ready: { pid: 9999, recipe: 'Resident' }, close() {} } as never;
  };
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('9999');
  expect(f.err.join('\n')).toContain('4242');
  expect(f.out.join('\n')).not.toContain('Its host answers:');
});

test('a host systemd keeps restarting ends the wait for it at once, not at the wait\'s bound', async () => {
  const at = install();
  writeFileSync(at.recipe, JSON.stringify({ mcpServers: { a: { command: 'a' } } }));
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
  writeFileSync(at.recipe, JSON.stringify({ mcpServers: { a: { command: 'a' } } }));
  const f = fake(at, { answersAfter: 3 });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(f.slept()).toBeGreaterThan(0);
  expect(f.slept()).toBeLessThan(60_000);
  expect(f.out.join('\n')).toContain('Its host answers: pid 4242');
});

test('a host that never answers while its unit stays active, on a recipe that names no server, is waited for 61.756 s: its start and its model check', async () => {
  const at = install();
  const f = fake(at, { ready: false });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.slept()).toBeGreaterThanOrEqual(61_756);
  expect(f.slept()).toBeLessThan(63_756);
  expect(f.err.join('\n')).toContain('no host said it was ready within 61 s');
});

test('each server the recipe or the agent overlay names adds 90 s to the wait for a host that never answers', async () => {
  const at = install();
  writeFileSync(at.recipe, JSON.stringify({ mcpServers: { a: { command: 'a' } } }));
  writeFileSync(join(at.work, 'mcpl-servers.agent.json'), JSON.stringify({ mcplServers: { b: { command: 'b' } } }));
  const f = fake(at, { ready: false });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.slept()).toBeGreaterThanOrEqual(241_756);
  expect(f.slept()).toBeLessThan(243_756);
  expect(f.err.join('\n')).toContain('no host said it was ready within 241 s');
});

test('an install whose data directory\'s socket answers with a host its unit doesn\'t run, as a copy\'s original would, is refused, naming that pid, before anything is written', async () => {
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
  expect(g.err.join('\n')).toContain('pid 4242, which connectome-copy.service doesn\'t run');
  expect(existsSync(join(unitsDir(copy), 'connectome-copy.service'))).toBe(false);
});

test('successful re-runs restart the shell daemon and the host on their written units', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  for (const run of [1, 2]) {
    const startsBefore = f.systemd.starts.length;
    f.out.length = 0;
    expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
    expect(f.systemd.starts.slice(startsBefore).map((start) => start.unit)).toEqual([SHELL, HOST]);
    expect(f.systemd.starts.at(-1)!.execStart).toContain(`"${at.recipe}"`);
    expect(f.out).toContain(`Restarted ${SHELL}.`);
    expect(f.out).toContain(`Restarted ${HOST}.`);
  }
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
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(f.systemd.starts.slice(startsBefore).map((start) => start.unit)).toEqual([HOST]);
});

test('a run restarts a host systemd stopped at its start limit, since the run is the request to start it', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  f.systemd.running.delete(HOST);
  f.systemd.startLimited.add(HOST);
  const startsBefore = f.systemd.starts.length;
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
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
  expect(f.err.join('\n')).toContain(`restart ${HOST} failed: Job for connectome-my-resident.service failed. Once ` +
    'that\'s put right, repeat this service install command with the same recipe.');
  expect(f.systemd.starts.length).toBe(startsBefore);
  expect(await installService(f.ctx(['install', second]), f.system)).toBe(0);
  expect(f.systemd.starts.slice(startsBefore).map((start) => start.unit)).toEqual([HOST]);
  expect(f.systemd.starts.at(-1)!.execStart).toContain(`"${second}"`);
});

test('on macOS every re-run boots out and loads each agent again, with the recorded recipe', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(f.out).toContain("launchd loads these agents, and so starts them, each time resident logs in to the Mac's graphical session.");
  for (const run of [1, 2]) {
    f.systemd.calls.length = 0;
    expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
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
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(f.systemd.bootstraps).toEqual(['com.animalabs.connectome.my-resident', 'com.animalabs.connectome.my-resident']);
});

test('on macOS install sets the earlier log aside before it loads the agent', async () => {
  const at = install();
  const log = join(at.work, 'logs', 'agent.log');
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(log, 'Fatal error: an earlier load\n');
  const f = fake(at, { platform: 'darwin', linger: null });
  const run = f.system.run;
  let logAtLoad: boolean | undefined;
  f.system.run = (command, args, env) => {
    if (command === 'launchctl' && args[0] === 'bootstrap' && args[2] === agentPlist(at)) logAtLoad = existsSync(log);
    return run(command, args, env);
  };
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(logAtLoad).toBe(false);
  expect(readFileSync(`${log}.previous`, 'utf-8')).toContain('an earlier load');
  expect(existsSync(log)).toBe(false);
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
    expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
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
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  const said = f.err.join('\n');
  expect(said).toContain("The resident's shell daemon isn't running now.");
  expect(said).toContain("This run hasn't started or restarted the resident's service.");
  expect(said).toContain('Repeat this service install command with the same recipe to load it.');
  expect(f.systemd.agents.get(host)!.pid).toBe(pid);
  expect(f.systemd.calls.slice(calls).some((call) => call === 'launchctl bootout gui/1001/' + host)).toBe(false);
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

test('on macOS a reinstall waits for each old agent to disappear before loading its replacement', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  f.systemd.unloadPolls = 2;
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(f.systemd.agents.has('com.animalabs.connectome.my-resident')).toBe(true);
  expect(f.systemd.agents.has('com.animalabs.connectome.my-resident.shell')).toBe(true);
  expect(f.systemd.bootstraps).toHaveLength(4);
});

test('on macOS an agent that stays in teardown past the exit timeout launchctl shows, plus one poll, gets a specific reinstall failure', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  f.systemd.unloadPolls = Infinity;
  f.systemd.exitTimeout = 7;
  const before = f.slept();
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.slept() - before).toBe(7_100);
  expect(f.err.join('\n')).toContain("com.animalabs.connectome.my-resident hasn't finished unloading after 7.1 s.");
  expect(f.err.join('\n')).toContain('service install command with the same recipe');
  expect(f.systemd.bootstraps).toHaveLength(1);
  expect(f.systemd.agents.has('com.animalabs.connectome.my-resident')).toBe(true);
});

test('on macOS an agent whose print shows no exit timeout is waited for 5 s, plus one poll', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  f.systemd.unloadPolls = Infinity;
  const before = f.slept();
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.slept() - before).toBe(5_100);
  expect(f.err.join('\n')).toContain("com.animalabs.connectome.my-resident hasn't finished unloading after 5.1 s.");
});

test('on macOS a failed teardown query explains the failure without launchctl root advice', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const run = f.system.run;
  f.system.run = (command, args, env) => command === 'launchctl' && args[0] === 'print'
    ? { status: 1, stdout: '', stderr: 'Print failed: permission denied\nTry re-running the command as root for richer errors.\n' }
    : run(command, args, env);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
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

test('on macOS brief unload waits are quiet and a visible pause gets one notice', async () => {
  for (const [polls, notices] of [[2, 0], [12, 1]]) {
    const at = install();
    const f = fake(at, { platform: 'darwin', linger: null });
    expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
    f.systemd.unloadPolls = polls!;
    f.out.length = 0;
    expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
    expect(f.out.filter((line) => line.startsWith('Waiting for '))).toHaveLength(notices!);
  }
});

test('an unknown launchd state includes its reason while install keeps the log in place and loads the agent', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin' });
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
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(f.out.join('\n')).toContain('unknown-state detail');
  expect(readFileSync(log, 'utf-8')).toBe('earlier-load');
});

test('a re-run that can\'t read launchd\'s state refuses before it touches the agent or its log', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const log = join(at.work, 'logs', 'agent.log');
  writeFileSync(log, 'the running agent still writes here\n');
  const run = f.system.run;
  f.system.run = (command, args, env) => command === 'launchctl' && args[0] === 'list' &&
    args[1] === 'com.animalabs.connectome.my-resident'
    ? { status: 1, stdout: '', stderr: 'cannot query launchd' } : run(command, args, env);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(existsSync(log + '.previous')).toBe(false);
  expect(readFileSync(log, 'utf-8')).toBe('the running agent still writes here\n');
  expect(f.err.join('\n')).toContain('runs the host that answers can\'t be told: cannot query launchd. Nothing was written.');
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
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain(join(at.work, 'node_modules', 'term-sessions-mcp', 'package.json'));
  expect(existsSync(shellUnit(at))).toBe(true);
  expect(f.systemd.running.has(SHELL)).toBe(true);
});

test('a terminal-sessions package that is a link to nothing is refused, and its shell daemon\'s unit is kept', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const pkg = join(at.work, 'node_modules', 'term-sessions-mcp');
  rmSync(pkg, { recursive: true });
  symlinkSync(join(at.work, 'nowhere'), pkg);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain(join(pkg, 'package.json'));
  expect(existsSync(shellUnit(at))).toBe(true);
  expect(f.systemd.running.has(SHELL)).toBe(true);
});

for (const platform of ['linux', 'darwin'] as const) test(platform + ' a stored shell port held by something other than this install\'s shell daemon is refused, and reused settings are named', async () => {
  const at = install('My Resident', { shell: true });
  writeFileSync(join(at.work, '.env'), 'SESSION_SERVER_PORT="3150"\nSESSION_SERVER_TOKEN="abc123"\n', { mode: 0o600 });
  const held = fake(at, { platform, taken: [3150] });
  expect(await installService(held.ctx(['install', at.recipe]), held.system)).toBe(1);
  expect(held.err.join('\n')).toContain(`SESSION_SERVER_PORT in ${join(at.work, '.env')} is 3150, and something other than this install's shell daemon`);
  expect(existsSync(platform === 'darwin' ? agentPlist(at, 'com.animalabs.connectome.my-resident.shell') : shellUnit(at)))
    .toBe(false);
  const free = fake(at, { platform });
  expect(await installService(free.ctx(['install', at.recipe]), free.system)).toBe(0);
  expect(free.out).toContain(`The shell daemon uses SESSION_SERVER_PORT 3150 and SESSION_SERVER_TOKEN, not shown, as ${join(at.work, '.env')} holds them.`);
  expect(free.out.join('\n')).not.toContain('abc123');
});

test('a .env that can\'t be read is refused with a shell, naming it, writing nothing, and left alone without one', async () => {
  for (const shell of [false, true]) {
    const at = install('My Resident', { shell });
    mkdirSync(join(at.work, '.env'));
    const f = fake(at);
    if (!shell) {
      expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
      continue;
    }
    expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
    const said = f.err.join('\n');
    expect(said).toContain(`${join(at.work, '.env')} can't be read`);
    expect(said).not.toContain('    at ');
    expect(f.systemd.starts).toEqual([]);
    expect(existsSync(hostUnit(at))).toBe(false);
    expect(existsSync(shellUnit(at))).toBe(false);
  }
});

test('with a shell, a .env that is a link is refused, naming where it leads, writing nothing; without one it is left alone', async () => {
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
    if (!shell) {
      expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
      expect(lstatSync(join(at.work, '.env')).isSymbolicLink()).toBe(true);
      if (held !== null) expect(readFileSync(target, 'utf-8')).toBe(held);
      continue;
    }
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
  }
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

test('a shell daemon whose package is gone is stopped, disabled and removed, and said', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  rmSync(join(at.work, 'node_modules', 'term-sessions-mcp'), { recursive: true });
  f.out.length = 0;
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(existsSync(shellUnit(at))).toBe(false);
  expect(f.systemd.running.has(SHELL)).toBe(false);
  expect(f.systemd.enabled.has(SHELL)).toBe(false);
  expect(f.out.join('\n')).toContain(`Stopped and removed ${SHELL}`);
});

test('on macOS a shell agent this install no longer has is booted out and removed', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const shell = agentPlist(at, 'com.animalabs.connectome.my-resident.shell');
  expect(existsSync(shell)).toBe(true);
  rmSync(join(at.work, 'node_modules', 'term-sessions-mcp'), { recursive: true });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(existsSync(shell)).toBe(false);
  expect(f.systemd.agents.has('com.animalabs.connectome.my-resident.shell')).toBe(false);
});

test('on macOS removing a shell waits for its agent to unload before reporting removal', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  f.systemd.unloadPolls = 2;
  writeFileSync(at.recipe, '{}');
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(f.systemd.agents.has('com.animalabs.connectome.my-resident.shell')).toBe(false);
  expect(f.systemd.unloading.size).toBe(0);
  expect(f.out.join('\n')).toContain('Stopped and removed com.animalabs.connectome.my-resident.shell');
});

test('an install without a recipe is a usage error, every time', async () => {
  const at = install();
  const f = fake(at);
  expect(await runService(f.ctx(['install']), f.system)).toBe(2);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(await runService(f.ctx(['install']), f.system)).toBe(2);
  expect(f.err.join('\n')).toContain('connectome service install <recipe>');
});

test('a recipe given as a URL goes to the recipe reader as given, and into the unit as given', async () => {
  const at = install();
  const f = fake(at);
  expect(await installService(f.ctx(['install', 'https://example.com/resident.json']), f.system)).toBe(0);
  expect(readFileSync(hostUnit(at), 'utf-8')).toContain('"https://example.com/resident.json" "--headless"');
  expect(f.read).toContain('https://example.com/resident.json');
});

test('a recipe that does not exist is refused, naming it', async () => {
  const at = install();
  const f = fake(at);
  expect(await installService(f.ctx(['install', join(at.work, 'nope.json')]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain(join(at.work, 'nope.json'));
});

test('a recipe the host\'s own reader can\'t parse is refused with its words before anything is written', async () => {
  const at = install('My Resident', { shell: true });
  writeFileSync(at.recipe, '{ "name": ');
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err).toEqual([`connectome: the recipe can't be read: ${at.recipe} isn't valid JSON. Nothing was written.`]);
  nothingWritten(at);
  expect(f.systemd.starts).toEqual([]);
});

test('a recipe has a shell when its text names a shell setting, or a server\'s command or arguments name the shell client', () => {
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
    [{ mcpServers: { worker: { command: 'sh', args: ['-c', '${WRAPPER}'] } } }, false],
  ];
  for (const [fields, shell] of cases) {
    expect(recipeHasShell({ name: 'r', agent: { provider: 'mock', systemPrompt: 'Test.' }, ...fields })).toBe(shell);
  }
});

test('a shell client named only through an environment reference gets no daemon, and install says the recipe names no shell', async () => {
  const at = install('My Resident', { shell: true });
  writeFileSync(at.recipe, JSON.stringify({ agent: { provider: 'mock' },
    mcpServers: { worker: { command: '${CLIENT_COMMAND}', args: [] } } }));
  const f = fake(at, { env: { PATH: `${at.root}:/usr/bin:/bin`, CLIENT_COMMAND: '/opt/bin/term-sessions-mcp' } });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(existsSync(shellUnit(at))).toBe(false);
  expect(f.out).toContain('This run sets up no shell daemon: the recipe names no shell client or shell setting.');
});

test('a shell setting named only in a server URL gets the resident a shell daemon', async () => {
  const at = install('My Resident', { shell: true });
  writeFileSync(at.recipe, JSON.stringify({
    name: 'r', agent: { provider: 'mock', systemPrompt: 'A URL-only shell reference.' },
    mcpServers: { renamed: { url: 'ws://127.0.0.1:${SESSION_SERVER_PORT}/' } },
  }));
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(existsSync(shellUnit(at))).toBe(true);
  expect(readEnvFile(join(at.work, '.env')).get('SESSION_SERVER_PORT')).toBe('3100');
});

test('an installed shell package alone gives a no-shell recipe no daemon or settings', async () => {
  const at = install('My Resident', { shell: true });
  writeFileSync(at.recipe, '{}');
  const f = fake(at, { node: null, taken: Array.from({ length: 100 }, (_, n) => 3100 + n) });
  writeFileSync(join(at.work, 'node_modules', 'term-sessions-mcp', 'package.json'), 'invalid JSON');
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(existsSync(shellUnit(at))).toBe(false);
  expect(existsSync(join(at.work, '.env'))).toBe(false);
  expect(f.out.join('\n')).not.toContain('To bring it back');
});

test('a recipe requesting a shell without the package gets an explanation and keeps external daemon settings', async () => {
  const at = install();
  writeFileSync(at.recipe, JSON.stringify({ mcpServers: { shell: { command: 'terminal-sessions-mcp' } } }));
  const before = 'SESSION_SERVER_TOKEN="external-token"\nSESSION_SERVER_PORT="4000"\n';
  writeFileSync(join(at.work, '.env'), before, { mode: 0o600 });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(existsSync(shellUnit(at))).toBe(false);
  expect(readFileSync(join(at.work, '.env'), 'utf-8')).toBe(before);
  expect(f.out.join('\n')).toContain("term-sessions-mcp isn't installed");
  expect(f.out.join('\n')).toContain('so this run sets up no shell daemon');
});

test('serviceLines names the unit and its file, and gives systemd\'s own lines to follow its log, stop it and start it', async () => {
  const at = install();
  const f = fake(at, { env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: '/run/user/1001' } });
  expect(serviceLines(at.root, f.system)).toBeNull();
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const lines = [`Its service is ${HOST}, in ${hostUnit(at)}.`, `  follow its log: journalctl --user -u ${HOST} -f`,
    `  stop it until the next boot: systemctl --user stop ${HOST}`, `  start it: systemctl --user start ${HOST}`];
  expect(serviceLines(at.root, f.system)).toEqual(lines);
  expect(f.out.slice(-4)).toEqual(lines);
});

test('without XDG_RUNTIME_DIR, serviceLines\' systemctl lines set it, and one line says why', async () => {
  const at = install();
  const f = fake(at, { env: { PATH: '/usr/bin:/bin' } });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(serviceLines(at.root, f.system)).toEqual([`Its service is ${HOST}, in ${hostUnit(at)}.`,
    `  follow its log: journalctl --user -u ${HOST} -f`,
    `  stop it until the next boot: XDG_RUNTIME_DIR=/run/user/1001 systemctl --user stop ${HOST}`,
    `  start it: XDG_RUNTIME_DIR=/run/user/1001 systemctl --user start ${HOST}`,
    'systemctl --user finds this user\'s systemd through XDG_RUNTIME_DIR, which this session doesn\'t set, so those ' +
      'lines set it.']);
});

test('with a shell daemon, serviceLines names it and stops and starts it with the host, and the host\'s unit wants it', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: '/run/user/1001' } });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(serviceLines(at.root, f.system)).toEqual([
    `Its service is ${HOST}, in ${hostUnit(at)}, with its shell daemon ${SHELL}, in ${shellUnit(at)}.`,
    `  follow its log: journalctl --user -u ${HOST} -f`,
    `  stop it and its shell daemon until the next boot: systemctl --user stop ${SHELL} ${HOST}`,
    `  start it and its shell daemon: systemctl --user start ${SHELL} ${HOST}`]);
  expect(readFileSync(hostUnit(at), 'utf-8')).toContain(`Wants=${SHELL}\n`);
});

test('the usage spells the install\'s own command by its full path, unless the first connectome on the printing process\'s PATH is the install\'s own', async () => {
  const at = install();
  const full = `'${join(at.root, 'connectome')}'`;
  const elsewhere = fake(at, { env: { PATH: '/usr/bin:/bin' } });
  expect(await runService(elsewhere.ctx(['install']), elsewhere.system)).toBe(2);
  expect(elsewhere.err).toEqual([`Usage: ${full} service install <recipe>`]);
  const onPath = fake(at);
  expect(await runService(onPath.ctx(['install']), onPath.system)).toBe(2);
  expect(onPath.err).toEqual(['Usage: connectome service install <recipe>']);
});

test('on macOS with a shell agent, serviceLines stops and starts it with the host', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform: 'darwin', linger: null });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const shell = agentPlist(at, 'com.animalabs.connectome.my-resident.shell');
  expect(serviceLines(at.root, f.system)!.slice(2)).toEqual([
    `  stop it and its shell daemon until the next login: launchctl bootout gui/1001 ${shell} ${agentPlist(at)}`,
    `  start it and its shell daemon: launchctl kickstart gui/1001/com.animalabs.connectome.my-resident.shell 2>/dev/null || ` +
      `launchctl bootstrap gui/1001 ${shell}; launchctl kickstart gui/1001/com.animalabs.connectome.my-resident 2>/dev/null ` +
      `|| launchctl bootstrap gui/1001 ${agentPlist(at)}`]);
});

test('anything but install with one recipe is a usage error, and stop and start are no longer words of it', async () => {
  const at = install();
  const f = fake(at);
  for (const argv of [[], ['uninstall'], ['install', at.recipe, 'extra'], ['stop'], ['start']]) {
    f.err.length = 0;
    expect(await runService(f.ctx(argv), f.system)).toBe(2);
    expect(f.err).toEqual(['Usage: connectome service install <recipe>']);
  }
  expect(f.systemd.calls).toEqual([]);
});

test('a successful install prints none of the values .env holds for a known or recorded secret, nor the shell token', async () => {
  const at = install('My Resident', { shell: true });
  writeFileSync(join(at.work, '.env'),
    'DISCORD_TOKEN="discord-secret-value"\nANTHROPIC_API_KEY="sk-secret"\nSESSION_SERVER_PORT="3150"\n' +
    'SESSION_SERVER_TOKEN="shell-secret-token"\n', { mode: 0o600 });
  new StoredSecrets(join(at.work, '.setup')).record('DISCORD_TOKEN');
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const said = [...f.out, ...f.err].join('\n');
  for (const value of ['discord-secret-value', 'sk-secret', 'shell-secret-token']) expect(said).not.toContain(value);
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

for (const platform of ['linux', 'darwin'] as const) test(platform + ' a host that already answers on the data directory\'s socket, not this unit\'s, is refused by its pid before anything is written', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform, other: 31337 });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  const said = f.err.join('\n');
  expect(said).toContain(`a host already serves ${at.data}, on ${join(at.data, 'ipc.sock')}: pid 31337`);
  expect(said).toContain('Stop that host, and whatever starts it again, then repeat this service install command with the ' +
    'same recipe. Nothing was written.');
  nothingWritten(at, platform === 'darwin' ? agentPlist(at) : hostUnit(at));
  expect(existsSync(agentPlist(at))).toBe(false);
  expect(f.systemd.starts).toEqual([]);
  expect(f.systemd.bootstraps).toEqual([]);
});

for (const platform of ['linux', 'darwin'] as const) test(platform + ' a re-run whose own host answers on the socket goes on, and waits for the host its restart started', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  f.out.length = f.err.length = 0;
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(f.err).toEqual([]);
  expect(f.out.join('\n')).toContain('Its host answers: pid 4342');
});

test('a socket that takes the connection but has no host say it\'s ready is refused, since whether a host serves the data directory can\'t be told', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { silent: true });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain(`whether a host already serves ${at.data} can't be told: the socket ` +
    `${join(at.data, 'ipc.sock')} accepted the connection, but no host said it was ready within 5 s. Nothing was written.`);
  nothingWritten(at);
});

test('on systemd another unit that runs this directory is named before the socket is asked', async () => {
  const at = install();
  const f = fake(at, { other: 31337 });
  f.systemd.otherUnits.push({ id: 'old-resident.service', workingDirectory: at.work, fragment: '/old-resident.service' });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  const said = f.err.join('\n');
  expect(said).toContain('old-resident.service (a user unit, at /old-resident.service) is already set up to run from');
  expect(said).not.toContain('pid 31337');
  nothingWritten(at);
});

for (const platform of ['linux', 'darwin'] as const) test(platform + ' a recipe that drops its shell stops and removes this install\'s shell unit, and its settings stay in .env', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const unit = platform === 'darwin' ? agentPlist(at, 'com.animalabs.connectome.my-resident.shell') : shellUnit(at);
  const name = platform === 'darwin' ? 'com.animalabs.connectome.my-resident.shell' : SHELL;
  expect(existsSync(unit)).toBe(true);
  const env = readFileSync(join(at.work, '.env'), 'utf-8');
  writeFileSync(at.recipe, '{}');
  f.out.length = 0;
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(existsSync(unit)).toBe(false);
  if (platform === 'darwin') expect(f.systemd.agents.has(name)).toBe(false);
  else {
    expect(f.systemd.running.has(SHELL)).toBe(false);
    expect(f.systemd.enabled.has(SHELL)).toBe(false);
  }
  expect(readFileSync(join(at.work, '.env'), 'utf-8')).toBe(env);
  expect(f.out).toContain('This run sets up no shell daemon: the recipe names no shell client or shell setting.');
  expect(f.out).toContain(`Stopped and removed ${name}: this install has no shell daemon now. Its settings stay in ` +
    `${join(at.work, '.env')}.`);
});

for (const platform of ['linux', 'darwin'] as const) test(platform + ' an install with no shell daemon refuses a shell unit of its name that runs another directory, writing nothing and leaving that unit as it is', async () => {
  const at = install();
  const other = install('my resident', { shell: true, home: at.home });
  const f = fake(at, { platform });
  expect(await installService({ root: other.root, argv: ['install', other.recipe], out: () => {}, err: () => {} },
    f.system)).toBe(0);
  const label = 'com.animalabs.connectome.my-resident';
  if (platform === 'darwin') f.systemd.run('launchctl', ['bootout', `gui/1001/${label}`], {});
  else f.systemd.run('systemctl', ['--user', 'stop', HOST], {});
  rmSync(platform === 'darwin' ? agentPlist(at, label) : hostUnit(at));
  if (platform === 'linux') f.systemd.run('systemctl', ['--user', 'daemon-reload'], {});
  const unit = platform === 'darwin' ? agentPlist(at, `${label}.shell`) : shellUnit(at);
  const text = readFileSync(unit, 'utf-8');
  f.systemd.calls.length = 0;
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain(`${unit}) names ${other.work}, rather than this install in ${at.work}`);
  expect(existsSync(platform === 'darwin' ? agentPlist(at, label) : hostUnit(at))).toBe(false);
  expect(existsSync(join(at.work, '.env'))).toBe(false);
  expect(readFileSync(unit, 'utf-8')).toBe(text);
  expect(f.out.join('\n')).not.toContain('Stopped and removed');
  expect(JSON.stringify(serviceLines(at.root, f.system))).not.toContain(platform === 'darwin' ? `${label}.shell` : SHELL);
  expect(f.systemd.calls.filter((call) => !call.startsWith('plutil ') &&
    call.includes(platform === 'darwin' ? `${label}.shell` : SHELL))).toEqual([]);
});

for (const platform of ['linux', 'darwin'] as const) test(platform + ' a unit of this directory\'s name that runs another directory, as a same-name copy\'s original does, gives this install no service lines', async () => {
  const original = install();
  const f = fake(original, { platform });
  expect(await installService(f.ctx(['install', original.recipe]), f.system)).toBe(0);
  const work = join(original.home, 'elsewhere', 'My Resident');
  mkdirSync(dirname(work), { recursive: true });
  cpSync(original.work, work, { recursive: true });
  const copy: Install = { home: original.home, work, root: join(work, 'connectome-host'), data: join(work, 'data'),
    recipe: join(work, 'resident.json') };
  const g = fake(copy, { platform });
  expect(serviceCommands(copy.root, g.system)).toBeNull();
  expect(serviceLines(copy.root, g.system)).toBeNull();
  expect(unitElsewhere(copy.root, g.system)).toEqual({
    unit: platform === 'darwin' ? { name: 'com.animalabs.connectome.my-resident', file: agentPlist(copy) }
      : { name: HOST, file: hostUnit(copy) },
    runsIn: realpathSync(original.work),
  });
  expect(serviceLines(original.root, g.system)![0]).toContain(platform === 'darwin'
    ? 'com.animalabs.connectome.my-resident' : HOST);
  expect(unitElsewhere(original.root, f.system)).toBeNull();
});

test('with no host unit of its name, a shell unit of its name that names another working directory, or names none, is the one named', async () => {
  const at = install();
  const f = fake(at);
  mkdirSync(unitsDir(at), { recursive: true });
  writeFileSync(shellUnit(at), '[Service]\nWorkingDirectory=/srv/elsewhere\n');
  expect(unitElsewhere(at.root, f.system)).toEqual({ unit: { name: SHELL, file: shellUnit(at) }, runsIn: '/srv/elsewhere' });
  writeFileSync(shellUnit(at), '[Service]\nExecStart=/bin/true\n');
  expect(unitElsewhere(at.root, f.system)).toEqual({ unit: { name: SHELL, file: shellUnit(at) }, runsIn: null });
});

test('with no host unit of its name, a shell unit of its name that runs this directory names nothing', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  rmSync(hostUnit(at));
  expect(serviceLines(at.root, f.system)).toBeNull();
  expect(unitElsewhere(at.root, f.system)).toBeNull();
});

test('a launch agent whose working directory plutil can\'t read still gives its lines, with no throw', async () => {
  const at = install();
  const f = fake(at, { platform: 'darwin' });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  writeFileSync(agentPlist(at), 'not a plist');
  const run = f.system.run;
  f.system.run = (command, args, env) => command === 'plutil'
    ? { status: 1, stdout: '', stderr: `${args.at(-1)}: Unexpected character n at line 1` }
    : run(command, args, env);
  expect(serviceLines(at.root, f.system)![0]).toContain('com.animalabs.connectome.my-resident');
});

test.skipIf(process.getuid?.() === 0)('a host unit file this user can\'t read still gives its lines, with no throw', async () => {
  const at = install();
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  chmodSync(hostUnit(at), 0o000);
  try {
    expect(serviceLines(at.root, f.system)![0]).toContain(HOST);
  } finally {
    chmodSync(hostUnit(at), 0o644);
  }
});

for (const platform of ['linux', 'darwin'] as const) test(platform + ' a stored port another process holds is refused, though this install\'s shell daemon runs on another one', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const envFile = join(at.work, '.env');
  writeFileSync(envFile, readFileSync(envFile, 'utf-8').replace(/^SESSION_SERVER_PORT=.*$/m, 'SESSION_SERVER_PORT=3200'));
  const unit = platform === 'darwin' ? agentPlist(at, 'com.animalabs.connectome.my-resident.shell') : shellUnit(at);
  const before = readFileSync(unit, 'utf-8');
  f.system.portFree = async (port) => port !== 3200;
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain(`SESSION_SERVER_PORT in ${envFile} is 3200, and something other than this install's`);
  expect(readFileSync(unit, 'utf-8')).toBe(before);
});

for (const platform of ['linux', 'darwin'] as const) test(platform + ' a re-run while this install\'s shell daemon holds its stored port goes through', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const port = Number(readEnvFile(join(at.work, '.env')).get('SESSION_SERVER_PORT'));
  f.system.portFree = async (each) => each !== port;
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(f.err).toEqual([]);
});

const shellUnitOf = (at: Install, platform: 'linux' | 'darwin') =>
  (platform === 'darwin' ? agentPlist(at, 'com.animalabs.connectome.my-resident.shell') : shellUnit(at));

for (const platform of ['linux', 'darwin'] as const) test(platform + ' a stored port another process holds is refused while this install\'s shell daemon runs on the port it started with, though its unit now names the stored one', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const envFile = join(at.work, '.env');
  const port = readEnvFile(envFile).get('SESSION_SERVER_PORT')!;
  writeEnvValue(envFile, 'SESSION_SERVER_PORT', '3200');
  const unit = shellUnitOf(at, platform);
  const before = readFileSync(unit, 'utf-8');
  const rewritten = before.replace(new RegExp(`(SESSION_SERVER_PORT(?:=|</key>\\s*<string>))${port}\\b`), '$13200');
  expect(rewritten).not.toBe(before);
  writeFileSync(unit, rewritten);
  if (platform === 'linux') f.systemd.run('systemctl', ['--user', 'daemon-reload'], {});
  f.system.portFree = async (each) => each !== 3200;
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain(`SESSION_SERVER_PORT in ${envFile} is 3200, and something other than this install's`);
  expect(readFileSync(unit, 'utf-8')).toBe(rewritten);
});

for (const platform of ['linux', 'darwin'] as const) test(platform + ' a stored port held while the port this install\'s shell daemon runs on can\'t be read is refused as untold, not as another process\'s', async () => {
  const label = 'com.animalabs.connectome.my-resident.shell';
  const cases: Array<{ name: string; break(f: Fake): void; why: string }> = platform === 'linux'
    ? [
      {
        name: 'systemd can\'t be asked',
        break: (f) => {
          const run = f.system.run;
          f.system.run = (command, args, env) => (args.includes('--property=MainPID') && args.at(-1) === SHELL
            ? { status: 1, stdout: '', stderr: 'Failed to connect to bus' } : run(command, args, env));
        },
        why: `systemd couldn't be asked about ${SHELL}: Failed to connect to bus`,
      },
      {
        name: 'its process\'s environment can\'t be read',
        break: (f) => {
          f.system.environ = () => {
            throw new Error('EACCES: permission denied');
          };
        },
        why: 'EACCES: permission denied',
      },
      {
        name: 'its process\'s environment has no port',
        break: (f) => {
          f.system.environ = () => 'PATH=/usr/bin\0';
        },
        why: 'has no SESSION_SERVER_PORT',
      },
    ]
    : [
      {
        name: 'launchctl print fails',
        break: (f) => f.systemd.launchctlFailsOnce.set('print', 'Could not print it'),
        why: 'Could not print it',
      },
      {
        name: 'its loaded environment has no port',
        break: (f) => {
          f.systemd.agents.get(label)!.environment = {};
        },
        why: 'no SESSION_SERVER_PORT',
      },
    ];
  for (const each of cases) {
    const at = install('My Resident', { shell: true });
    const f = fake(at, { platform });
    expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
    const port = Number(readEnvFile(join(at.work, '.env')).get('SESSION_SERVER_PORT'));
    const before = readFileSync(shellUnitOf(at, platform), 'utf-8');
    f.system.portFree = async (other) => other !== port;
    each.break(f);
    expect(await installService(f.ctx(['install', at.recipe]), f.system), each.name).toBe(1);
    const said = f.err.join('\n');
    expect(said, each.name).toContain('can\'t be told');
    expect(said, each.name).toContain(each.why);
    expect(said, each.name).not.toContain('something other than this install\'s shell daemon');
    expect(readFileSync(shellUnitOf(at, platform), 'utf-8'), each.name).toBe(before);
  }
});

for (const platform of ['linux', 'darwin'] as const) test(platform + ' a stored port spelt with a leading zero, which this install\'s shell daemon holds, goes through', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const envFile = join(at.work, '.env');
  const port = readEnvFile(envFile).get('SESSION_SERVER_PORT')!;
  writeEnvValue(envFile, 'SESSION_SERVER_PORT', `0${port}`);
  f.system.portFree = async (each) => each !== Number(port);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(f.err).toEqual([]);
});

for (const platform of ['linux', 'darwin'] as const) test(platform + ' with a recipe that names no shell, a shell daemon\'s unit of its name whose install can\'t be told is refused, writing nothing', async () => {
  const label = 'com.animalabs.connectome.my-resident.shell';
  const cases: Array<{ name: string; set(f: Fake): void; says: (at: Install) => string }> = [
    {
      name: 'it runs with its file gone',
      set: (f) => {
        if (platform === 'darwin') f.systemd.agents.set(label, { pid: 777 });
        else f.systemd.running.set(SHELL, 'x');
      },
      says: (at) => `${shellUnitOf(at, platform)}, is gone`,
    },
    {
      name: 'its manager can\'t be asked about it',
      set: (f) => {
        if (platform === 'linux') f.systemd.failOnce.set(`show ${SHELL}`, 'Failed to connect to bus');
        else {
          const run = f.system.run;
          f.system.run = (command, args, env) => (command === 'launchctl' && args[0] === 'list' && args[1] === label
            ? { status: 5, stdout: '', stderr: 'Could not list it' } : run(command, args, env));
        }
      },
      says: () => (platform === 'darwin' ? 'Could not list it' : 'Failed to connect to bus'),
    },
  ];
  for (const each of cases) {
    const at = install();
    const f = fake(at, { platform });
    each.set(f);
    expect(await installService(f.ctx(['install', at.recipe]), f.system), each.name).toBe(1);
    expect(f.err.join('\n'), each.name).toContain(each.says(at));
    expect(existsSync(platform === 'darwin' ? agentPlist(at) : hostUnit(at)), each.name).toBe(false);
    expect(existsSync(join(at.work, '.env')), each.name).toBe(false);
    expect(existsSync(shellUnitOf(at, platform)), each.name).toBe(false);
  }
});

test('a run as root on a directory another account owns, as under sudo, is refused before anything is written, and needs no user name', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { owner: 1000 });
  f.system.uid = 0;
  Object.defineProperty(f.system, 'user', { get: () => { throw new Error('user id 0 has no passwd entry'); } });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err).toEqual([`connectome: ${at.work} belongs to uid 1000, and this runs as root, so its service would run ` +
    `the resident as root on files uid 1000 can change. Run this command as the user who owns ${at.work}, without sudo. ` +
    'Nothing was written.']);
  nothingWritten(at);
  expect(f.systemd.calls).toEqual([]);
});

test('a run as a user other than the directory\'s owner, not as root, goes on', async () => {
  const at = install();
  const f = fake(at, { owner: 1000 });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(f.err).toEqual([]);
});

test('a run as root on a directory root owns goes on', async () => {
  const at = install();
  const f = fake(at, { owner: 0 });
  f.system.uid = 0;
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(f.err).toEqual([]);
});

test('on Linux, the shell daemon\'s unit of an install in alice and the host\'s unit of an install in alice-shell have different names', () => {
  const alice = serviceUnits('/srv/alice/connectome-host', 'linux', '/home/r')!;
  const aliceShell = serviceUnits('/srv/alice-shell/connectome-host', 'linux', '/home/r')!;
  expect(alice.shell.name).not.toBe(aliceShell.host.name);
  expect(alice.shell.file).not.toBe(aliceShell.host.file);
});

test('a no-shell run whose host isn\'t ready leaves the shell daemon\'s unit as it is', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const plain = join(at.work, 'plain.json');
  writeFileSync(plain, '{}');
  const text = readFileSync(shellUnit(at), 'utf-8');
  f.systemd.exiting.add(HOST);
  const startsBefore = f.systemd.starts.filter((start) => start.unit === HOST).length;
  expect(await installService(f.ctx(['install', plain]), f.system)).toBe(1);
  expect(f.systemd.starts.filter((start) => start.unit === HOST).length).toBe(startsBefore + 1);
  expect(f.err.join('\n')).toContain(`${HOST} is failed, and no host answers`);
  expect(readFileSync(shellUnit(at), 'utf-8')).toBe(text);
  expect(f.systemd.calls.filter((call) => call.includes('disable') && call.includes(SHELL))).toEqual([]);
});

test('a unit that runs this directory from a file outside the user\'s own unit directory is named with no line that removes that file', async () => {
  const at = install();
  const f = fake(at);
  f.systemd.otherUnits.push({ id: 'vendor@resident.service', workingDirectory: at.work,
    fragment: '/usr/lib/systemd/user/vendor@.service' });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  const said = f.err.join('\n');
  expect(said).toContain('disable vendor@resident.service');
  expect(said).not.toContain('remove /usr/lib/systemd/user/vendor@.service');
});

test('a control character in the data directory is refused before .env or any unit is written', async () => {
  const at = install('My Resident', { shell: true });
  writeFileSync(join(at.root, 'install.json'), JSON.stringify({ v: 1, dataDir: `${at.data}\nx`, extraState: [] }));
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('DATA_DIR holds a line break or another control character');
  nothingWritten(at);
});

test.skipIf(process.getuid?.() === 0)('a recipe whose directory can\'t be searched is refused with why, not as missing', async () => {
  const at = install();
  const dir = join(at.work, 'locked');
  mkdirSync(dir);
  const recipe = join(dir, 'resident.json');
  writeFileSync(recipe, '{}');
  chmodSync(dir, 0o000);
  try {
    const f = fake(at);
    expect(await installService(f.ctx(['install', recipe]), f.system)).toBe(1);
    expect(f.err.join('\n')).toContain(`the recipe at ${recipe} can't be read:`);
    expect(f.err.join('\n')).not.toContain('there\'s no recipe');
  } finally {
    chmodSync(dir, 0o755);
  }
});

test('serviceCommands is null until the host\'s unit file is there, and names the shell daemon only while its file is', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: '/run/user/1001' } });
  expect(serviceCommands(at.root, f.system)).toBeNull();
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(serviceCommands(at.root, f.system)!.start).toBe(`systemctl --user start ${SHELL} ${HOST}`);
  rmSync(shellUnit(at));
  expect(serviceCommands(at.root, f.system)!.start).toBe(`systemctl --user start ${HOST}`);
});

for (const platform of ['linux', 'darwin'] as const) test(platform + ' a host that doesn\'t answer fails the install, which gives the line that shows its log and the command to run again', async () => {
  const at = install();
  const f = fake(at, { platform, ready: false });
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain('no host said it was ready within 61 s');
  expect(f.err.join('\n')).toContain('It may still be starting: connectome alone says whether its host answers.');
  const log = platform === 'darwin' ? `tail -f '${join(at.work, 'logs', 'agent.log')}'` : `journalctl --user -u ${HOST} -f`;
  expect(f.out).toContain(`Its log shows what happened: ${log}. Put that right, then run connectome service install ` +
    `'${at.recipe}' again. Until then ${platform === 'darwin'
      ? 'launchd starts the host again each time it exits other than with 0, while it has its agent loaded'
      : 'systemd restarts the host each time it fails, while it has its unit loaded and its start limit allows; the run ' +
        'clears that limit'}.`);
});

test('a unit of this install\'s name written through a link to this directory is taken as this install\'s', async () => {
  const at = install();
  const alias = join(at.home, 'Alias');
  symlinkSync(at.work, alias);
  mkdirSync(unitsDir(at), { recursive: true });
  writeFileSync(hostUnit(at), `[Service]\nWorkingDirectory=${alias}\n`);
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(f.err).toEqual([]);
});

test('an install reached through a link to its directory runs again through it', async () => {
  const at = install();
  const alias = join(at.home, 'Alias');
  symlinkSync(at.work, alias);
  const root = join(alias, 'connectome-host');
  const f = fake({ ...at, root, work: alias });
  for (const run of [1, 2]) {
    expect(await installService({ ...f.ctx(['install', at.recipe]), root }, f.system)).toBe(0);
    expect(f.err).toEqual([]);
  }
  expect(readFileSync(join(unitsDir(at), 'connectome-alias.service'), 'utf-8')).toContain(`WorkingDirectory=${alias}\n`);
});

const shellSentence = (user: string) => `With a shell, the resident can read and change whatever ${user} can, and whoever ` +
  'talks to it on Discord can ask it to.';

for (const platform of ['linux', 'darwin'] as const) test(platform + ' where install starts a shell daemon, it says once, as the shell goes live, what a shell lets the resident and its Discord reach', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform });
  f.system.user = 'ana';
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(f.out.filter((line) => line === shellSentence('ana'))).toHaveLength(1);
  const live = platform === 'darwin'
    ? `Loaded com.animalabs.connectome.my-resident.shell from ${agentPlist(at, 'com.animalabs.connectome.my-resident.shell')}.`
    : `Started ${SHELL}.`;
  expect(f.out.indexOf(shellSentence('ana'))).toBe(f.out.indexOf(live) + 1);
});

test('without a shell daemon, install says nothing of what a shell reaches', async () => {
  const at = install();
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(f.out.join('\n')).not.toContain('With a shell');
});

test('a recipe that names a shell, without the shell\'s package here, gets the command that installs it and the run to repeat', async () => {
  const at = install();
  writeFileSync(at.recipe, JSON.stringify({ mcpServers: { shell: { command: 'terminal-sessions-mcp' } } }));
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  expect(f.out).toContain("The recipe names a shell client or setting, but term-sessions-mcp isn't installed in this " +
    'directory, so this run sets up no shell daemon. To set one up, run connectome shell install, then this service install ' +
    'command again with the same recipe.');
});

test('a refusal after the shell\'s settings are kept, such as the restart policy\'s, starts nothing and says nothing of what a shell reaches', async () => {
  const at = install('My Resident', { shell: true });
  mkdirSync(`${hostUnit(at)}.d`, { recursive: true });
  writeFileSync(join(`${hostUnit(at)}.d`, 'override.conf'), '[Service]\nRestart=no\n');
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(readEnvFile(join(at.work, '.env')).has('SESSION_SERVER_TOKEN')).toBe(true);
  expect(f.systemd.starts).toEqual([]);
  expect([...f.out, ...f.err].join('\n')).not.toContain('With a shell');
});

for (const platform of ['linux', 'darwin'] as const) test(platform + ' a shell daemon that has stopped by the time its host answers fails the install, which names the shell\'s log', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform });
  const label = 'com.animalabs.connectome.my-resident.shell';
  if (platform === 'linux') f.systemd.exiting.add(SHELL);
  else {
    const open = f.system.openHost;
    f.system.openHost = async (root) => {
      const agent = f.systemd.agents.get(label);
      if (agent !== undefined) agent.pid = null;
      return open(root);
    };
  }
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  const said = f.err.join('\n');
  expect(said).toContain(`the resident's shell daemon, ${platform === 'linux' ? SHELL : label}, didn't stay up after this ` +
    'run started it');
  expect(said).toContain(platform === 'linux' ? `journalctl --user -u ${SHELL} -f`
    : `tail -f '${join(at.work, 'logs', 'shell.log')}'`);
  expect(f.out.join('\n')).toContain('Its host answers');
});

for (const platform of ['linux', 'darwin'] as const) test(platform + ' a shell daemon started again before its host answers fails the install', async () => {
  const at = install('My Resident', { shell: true });
  const f = fake(at, { platform });
  const label = 'com.animalabs.connectome.my-resident.shell';
  const open = f.system.openHost;
  f.system.openHost = async (root) => {
    if (platform === 'linux') f.systemd.run('systemctl', ['--user', 'restart', SHELL], {});
    else f.systemd.run('launchctl', ['kickstart', `gui/1001/${label}`], {});
    return open(root);
  };
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain(`the resident's shell daemon, ${platform === 'linux' ? SHELL : label}, didn't stay ` +
    'up after this run started it');
});

test('a run from a current directory that\'s gone fails with a message rather than a throw', async () => {
  const at = install();
  const f = fake(at);
  Object.defineProperty(f.system, 'cwd', {
    get() {
      throw Object.assign(new Error('ENOENT: no such file or directory, uv_cwd'), { code: 'ENOENT' });
    },
  });
  expect(await installService(f.ctx(['install', 'resident.json']), f.system)).toBe(1);
  expect(f.err).toHaveLength(1);
  expect(f.err[0]).toContain('uv_cwd');
});

for (const name of ['resident ', 'resident\\']) test(`on Linux, a working directory whose name ends in ${JSON.stringify(name.at(-1))} is refused before anything is written`, async () => {
  const at = install(name, { shell: true });
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  expect(f.err.join('\n')).toContain(`The working directory ${JSON.stringify(at.work)} ends in a space or a backslash`);
  expect(existsSync(join(unitsDir(at), 'connectome-resident.service'))).toBe(false);
  expect(existsSync(join(unitsDir(at), 'connectome-resident.shell.service'))).toBe(false);
  expect(existsSync(join(at.work, '.env'))).toBe(false);
  expect(f.systemd.calls.filter((call) => call.includes('daemon-reload'))).toEqual([]);
});

test('a unit whose file names this directory while systemd shows an earlier load in another is refused with the reload that reads its files again', async () => {
  const at = install();
  const f = fake(at);
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(0);
  const dropIn = `${hostUnit(at)}.d`;
  mkdirSync(dropIn);
  writeFileSync(join(dropIn, 'elsewhere.conf'), '[Service]\nWorkingDirectory=/srv/elsewhere\n');
  f.systemd.run('systemctl', ['--user', 'daemon-reload'], {});
  rmSync(dropIn, { recursive: true });
  f.err.length = 0;
  expect(await installService(f.ctx(['install', at.recipe]), f.system)).toBe(1);
  const said = f.err.join('\n');
  expect(said).toContain(`systemd shows ${HOST} as it last loaded it, while its file names ${at.work}`);
  expect(said).toContain('XDG_RUNTIME_DIR=/run/user/1001 systemctl --user daemon-reload');
});
