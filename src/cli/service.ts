import { randomBytes } from 'node:crypto';
import {
  chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync,
  readSync, realpathSync, renameSync, rmSync, statSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ContractError, INSTALL_ROOT_ENV, RESTART_EXIT_CODE, SUPERVISED_ENV, installPaths, pendingGoBack, readCurrent, readJournal, readMark,
  readRecord, realOrResolved, unfinishedTrial, writeJsonAtomic, writeTextAtomic, type JournalLine, type Mark,
} from '../update/contract.js';
import { RESTART_PROPERTIES, restartPolicy, systemdUnits } from '../update/setup.js';
import { shellWord } from '../update/launcher.js';
import { lingerOf } from '../setup/linger.js';
import { takeFileLock } from '../setup/file-lock.js';
import {
  StoredSecrets, envForm, readEnvFile, removeEnvValues, secretValues, storedSecretRedactor, storedSecretWindowRedactor,
  writeEnvValue,
} from '../setup/secrets.js';
import { dataDirOf, openHost, type HostClient, type HostReady, type NoHost } from './host-socket.js';
import type { CliCommand, CliContext } from './connectome.js';
import { INSTALL_COMMAND, typedCommand } from './install-command.js';
import {
  Refusal, plain, plist, serviceUnits, slugOf, systemdUnit, type Manager, type ServiceUnit,
} from './service-unit.js';

const SHELL_PACKAGE = 'term-sessions-mcp';
const SHELL_BIN = 'session-server';
// term-sessions-mcp's own default port is 3100. Picked ports stay below the platforms' default ephemeral ranges, from
// which the kernel hands out ports for outgoing connections: Linux's from 32768 (ip_local_port_range), macOS's from
// 49152 (net.inet.ip.portrange.first).
const SHELL_PORTS = { first: 3100, last: 32767 };
const READY_WAIT_MS = 60_000;
const RECIPE_CHECK_MS = 60_000;
const FIRST_MINUTE_S = 60;
const LOG_LINES = 40;
const TAIL_STEP_BYTES = 64 * 1024;
const INVOCATION_FIELDS = ['_SYSTEMD_INVOCATION_ID', 'USER_INVOCATION_ID', 'INVOCATION_ID'];
export const EXCERPT_LEAD = "Lines starting with | are reports from the process named above each excerpt, " +
  "not findings of this check. Current known secret values are redacted; older or unrecorded credentials can remain. " +
  "This check says what it finds in lines of its own.";
const REPORT_WORDS = /\b(error|fatal|failed|refused|refuses)\b/i;
const serviceUsage = (cmd: string) => `${cmd} service install [<recipe>] | stop | start`;
const RUNNING = new Set(['active', 'activating', 'reloading']);
const STOPPING = new Set([...RUNNING, 'deactivating']);
const recordAgain = (cmd: string) =>
  `Name the recipe to write the service and its record again: ${cmd} service install <recipe>.`;
const guessedSecretsNotice = (work: string) =>
  `The secret-name list ${join(work, '.setup', 'stored-secrets.json')} is missing, so every name in .env and the ` +
  'dotenv files beside it was treated as potentially secret. For later service checks, write it as a JSON list of ' +
  'the name of every secret in those files, to keep other values visible.';
const serviceRepair = (cmd: string) =>
  `Run ${cmd} service install to check and repair the service for its recorded recipe. ` +
  'If it asks you to stop a loaded unit whose file is gone, follow its conditional stop instruction, then repeat install.';

const SHELL_SETTING_NAMES = ['SESSION_SERVER_TOKEN', 'SESSION_SERVER_PORT'] as const;
type ShellSettings = Partial<Record<(typeof SHELL_SETTING_NAMES)[number], string>>;

export interface ServiceRecord {
  v: 1;
  manager: Manager;
  units: { host: ServiceUnit; shell?: ServiceUnit };
  hostArgs: string[];
  workingDirectory: string;
  logs: { kind: 'journal' } | { kind: 'file'; path: string };
  shellSettings?: ShellSettings;
}

export interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type RecipeLoad = { loads: true } | { loads: false; words: string } | { loads: null; why: string };

export type RecipeRead = { loads: true; shell: boolean; document: unknown } | Exclude<RecipeLoad, { loads: true }>;

export interface ServiceSystem {
  platform: NodeJS.Platform;
  user: string;
  uid: number;
  home: string;
  cwd: string;
  env: Record<string, string | undefined>;
  bun: string;
  cgroup(): string | null;
  which(name: string): string | null;
  run(command: string, args: string[], env: Record<string, string>): Ran;
  readRecipe(recipe: string, work: string, env: Record<string, string>): RecipeRead;
  loadRecipe(recipe: string, work: string, env: Record<string, string>, document?: unknown): RecipeLoad;
  linger(user: string): boolean | null;
  portFree(port: number): Promise<boolean>;
  openHost(root: string): Promise<HostClient | NoHost>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export function machine(): ServiceSystem {
  const me = userInfo();
  return {
    platform: process.platform,
    user: me.username,
    uid: me.uid,
    home: homedir(),
    cwd: process.cwd(),
    env: process.env,
    bun: process.execPath,
    cgroup: () => {
      try {
        return readFileSync('/proc/self/cgroup', 'utf-8');
      } catch {
        return null;
      }
    },
    which: (name) => Bun.which(name),
    run: (command, args, env) => {
      try {
        const ran = Bun.spawnSync([command, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
        return { status: ran.exitCode, stdout: ran.stdout.toString(), stderr: ran.stderr.toString() };
      } catch (error) {
        return { status: null, stdout: '', stderr: errorText(error) };
      }
    },
    readRecipe: (recipe, work, env) => readRecipeAsHost(process.execPath, recipe, work, env),
    loadRecipe: (recipe, work, env, document) => loadRecipeAsHost(process.execPath, recipe, work, env, document),
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

const RECIPE_LOADER = fileURLToPath(new URL('../recipe.js', import.meta.url));
const RECIPE_DOCUMENT = fileURLToPath(new URL('../recipe-document.js', import.meta.url));

export function readRecipeAsHost(bun: string, recipe: string, work: string, env: Record<string, string>): RecipeRead {
  return recipeCheck(bun, recipe, work, env, { from: RECIPE_DOCUMENT, names: ['readRecipeDocument', 'substituteEnvVars'] }, [
    'const usesShell = (document) => {',
    '  if (["SESSION_SERVER_TOKEN", "SESSION_SERVER_PORT"].some((name) => JSON.stringify(document).includes(name))) return true;',
    '  const value = substituteEnvVars(document, source);',
    '  return Object.values(value?.mcpServers ?? {}).some((server) =>',
    '    [server?.command, ...(Array.isArray(server?.args) ? server.args : [])].some((word) => typeof word === "string" &&',
    '      /(?:^|[/\\\\\\s])(?:terminal-sessions-mcp|term-sessions-mcp)(?:$|[@/\\\\\\s])/.test(word)));',
    '};',
    'const document = await readRecipeDocument(source);',
    'console.log("\\n" + JSON.stringify({ shell: usesShell(document.raw), document }));',
  ], (result) => typeof result.shell === 'boolean' && 'document' in result
    ? { loads: true, shell: result.shell, document: result.document } : null);
}

export function loadRecipeAsHost(bun: string, recipe: string, work: string, env: Record<string, string>,
  document?: unknown): RecipeLoad {
  return recipeCheck(bun, recipe, work, env, { from: RECIPE_LOADER, names: ['loadRecipeDocument', 'loadRecipeDetailed'] }, [
    document === undefined ? 'await loadRecipeDetailed(source);'
      : 'await loadRecipeDocument(JSON.parse(await Bun.stdin.text()), source);',
    'console.log("\\n" + JSON.stringify({ loaded: true }));',
  ], (result) => result.loaded === true ? { loads: true } : null, document);
}

function recipeCheck<T extends { loads: true }>(bun: string, recipe: string, work: string, env: Record<string, string>,
  imports: { from: string; names: string[] }, body: string[], decode: (result: Record<string, unknown>) => T | null,
  document?: unknown): T | Exclude<RecipeLoad, { loads: true }> {
  const script = [
    `const { ${imports.names.join(', ')} } = await import(${JSON.stringify(imports.from)});`,
    'const source = ' + JSON.stringify(recipe) + ';',
    'try {',
    ...body,
    '} catch (error) {',
    '  console.log("\\n" + JSON.stringify({ refused: error instanceof Error ? error.message : String(error) }));',
    '  process.exit(1);',
    '}',
    'process.exit(0);',
  ].join('\n');
  let ran: Bun.SyncSubprocess<'pipe', 'pipe'>;
  try {
    ran = Bun.spawnSync([bun, '-e', script], { cwd: work, env,
      ...(document === undefined ? {} : { stdin: Buffer.from(JSON.stringify(document)) }),
      stdout: 'pipe', stderr: 'pipe', timeout: RECIPE_CHECK_MS });
  } catch (error) {
    return { loads: null, why: errorText(error) };
  }
  const result = recipeResult(ran.stdout.toString());
  if (ran.exitCode === 0) return (result === null ? null : decode(result)) ??
    { loads: null, why: 'the loader exited without reporting its recipe result' };
  if (ran.exitedDueToTimeout) return { loads: null, why: "it hadn't loaded after " + RECIPE_CHECK_MS / 1000 + ' s' };
  if (ran.exitCode === 1 && typeof result?.refused === 'string') return { loads: false, words: result.refused };
  const said = ran.stderr.toString().trim();
  return { loads: null, why: said || 'the loader exited with ' + (ran.exitCode ?? ran.signalCode) };
}

function recipeResult(stdout: string): Record<string, unknown> | null {
  try {
    const result: unknown = JSON.parse(stdout.trim().split('\n').at(-1) ?? '');
    return result !== null && typeof result === 'object' ? result as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export const serviceCommand: CliCommand = {
  name: 'service',
  usage: serviceUsage(INSTALL_COMMAND),
  summary: 'Sets up, stops and starts this install\'s service.',
  words: [
    'install: writes and starts this install\'s service, then checks it. The first install names the recipe; run ' +
      'again, it keeps the recorded one.',
    'stop: stops the service install set up, and says what its next start does about an update under way or ' +
      'marked. It stays installed.',
    'start: starts what of that service isn\'t running, then waits for its host and checks it, as install does.',
  ],
  run: (ctx) => runService(ctx),
};

export async function runService(ctx: CliContext, sys: ServiceSystem = machine()): Promise<number> {
  const [verb, ...rest] = ctx.argv;
  if (verb === 'install' && rest.length <= 1) return installService(ctx, sys);
  if ((verb === 'stop' || verb === 'start') && rest.length === 0) {
    return serviceRun(ctx, () => (verb === 'stop' ? stopService : startService)(ctx, sys));
  }
  ctx.err(`Usage: ${serviceUsage(typedCommand(ctx.root!, sys.env.PATH))}`);
  return 2;
}

export async function installService(ctx: CliContext, sys: ServiceSystem = machine()): Promise<number> {
  return serviceRun(ctx, () => installWithRecord(ctx, sys));
}

async function serviceRun(ctx: CliContext, run: () => Promise<number>): Promise<number> {
  try {
    return await withServiceLock(ctx, run);
  } catch (error) {
    ctx.err(`connectome: ${error instanceof Refusal || error instanceof ContractError ? error.message
      : `Service command failed: ${errorText(error)}. Files or units may already have changed. ` +
        "Inspect this install's files and service-manager state, resolve the error, then repeat this command."}`);
    return 1;
  }
}

async function withServiceLock(ctx: CliContext, run: () => Promise<number>): Promise<number> {
  const file = join(ctx.root!, 'service.lock');
  let lock: { release(): void } | null;
  try {
    lock = takeFileLock(file);
  } catch (error) {
    throw new Refusal(`The service command can't take its lock, ${file}: ${errorText(error)}. Nothing was changed. ` +
      'Check that its directory and lock file are readable and writable by this user. If the lock file is damaged, ' +
      'wait for any service command here to finish, then take that file away and repeat this command.');
  }
  if (lock === null) {
    throw new Refusal('Another connectome service command is running for this install. Nothing was changed. ' +
      'Wait for it to finish, then repeat this command.');
  }
  try { return await run(); } finally { lock.release(); }
}

async function installWithRecord(ctx: CliContext, sys: ServiceSystem): Promise<number> {
  const given = ctx.argv[1];
  const root = ctx.root!;
  const cmd = typedCommand(root, sys.env.PATH);
  let old: ServiceRecord | null = null;
  try {
    old = readServiceRecordFile(root, cmd, given === undefined);
  } catch (error) {
    if (given === undefined) {
      ctx.err(`connectome: ${errorText(error)}`);
      return 1;
    }
    if (!(lstatSync(join(root, 'service.json'), { throwIfNoEntry: false })?.isFile() ?? true)) {
      throw new Refusal(`${errorText(error)} Nothing was written.`);
    }
    const elsewhere = recordedDirectory(join(root, 'service.json'));
    if (elsewhere !== null && !sameDirectory(elsewhere, workingDirOf(root))) {
      throw new Refusal(`${errorText(error).replace(/\.+$/, '')}. It names another working directory, ${elsewhere}, ` +
        'whose units this release can\'t check from it. Take that install\'s units away there, or move this record ' +
        'aside if they\'re gone, then repeat this service install command. Nothing was written.');
    }
    ctx.out(`${errorText(error).replace(/\.+$/, '')}. This run replaces it with a new record once it has written a unit file.`);
  }
  if (old !== null && !sameDirectory(old.workingDirectory, workingDirOf(root))) {
    if (given === undefined) throw new Refusal(`${foreignServiceWords(root, old)} ${recordAgain(cmd)}`);
    foreignRecordReplaceable(root, old, sys, cmd);
    ctx.out(`${foreignServiceWords(root, old)} This run uses the explicit recipe and records only this directory's units.`);
    old = null;
  }
  if (given === undefined && old === null) {
    ctx.err(`connectome: the first install needs the recipe: ${cmd} service install <recipe>`);
    return 2;
  }
  const recipe = given === undefined ? old!.hostArgs[0]! : /^https?:\/\//.test(given) ? given : resolve(sys.cwd, given);
  return install(ctx, sys, root, recipe, old, cmd);
}

function foreignServiceWords(root: string, record: ServiceRecord): string {
  return `The service record at ${join(root, 'service.json')} names ${record.workingDirectory}, which can't be shown ` +
    `to be this working directory, ${workingDirOf(root)}. It isn't used here.`;
}

function foreignRecordReplaceable(root: string, record: ServiceRecord, sys: ServiceSystem, cmd: string): void {
  let directory: ReturnType<typeof statSync> | undefined;
  try {
    directory = statSync(record.workingDirectory, { throwIfNoEntry: false });
  } catch (error) {
    throw new Refusal(`${foreignServiceWords(root, record)} Its recorded directory can't be checked: ${errorText(error)}. ` +
      `Resolve that access problem. Then repeat ${cmd} service install <recipe>.`);
  }
  if (directory !== undefined) {
    if (!directory.isDirectory()) throw new Refusal(`${foreignServiceWords(root, record)} ` +
      'The recorded working-directory path is not a directory; resolve that before replacing this record. ' +
      `Then repeat ${cmd} service install <recipe>.`);
    return;
  }
  const env = childEnv(sys);
  for (const unit of unitsOf(record)) {
    const next = record.manager === 'systemd-user'
      ? `${stopLine(sys, record.manager, unit.name)}, remove ${shellWord(unit.file)} if present, then ` +
        systemctlLine(sys, 'daemon-reload')
      : `${stopLine(sys, record.manager, unit.name)} and remove ${shellWord(unit.file)} if present`;
    const refuse = (why: string): never => {
      throw new Refusal(`${foreignServiceWords(root, record)} The recorded directory isn't present, and ${why}. ` +
        `Before replacing its record, retire ${unit.name} with its native manager and remove its file. ` +
        `If it belongs to the original install: ${next}. Then repeat ${cmd} service install <recipe>.`);
    };
    try {
      if (lstatSync(unit.file, { throwIfNoEntry: false }) !== undefined) refuse(`its file ${unit.file} is still there`);
    } catch (error) {
      if (error instanceof Refusal) throw error;
      refuse(`its file ${unit.file} can't be checked: ${errorText(error)}`);
    }
    if (record.manager === 'systemd-user') {
      const shown = showUnit(sys, env, unit.name, ['LoadState', 'ActiveState']);
      if (typeof shown === 'string') return refuse(shown);
      if (shown.get('LoadState') !== 'not-found' || !['inactive', 'failed'].includes(shown.get('ActiveState') ?? '')) {
        refuse(`systemd still holds ${unit.name} (${stateOf(shown)})`);
      }
    } else {
      const state = agentState(sys, env, unit);
      if (state.kind === 'unknown') refuse(`its loaded state can't be read: ${state.why}`);
      if (state.kind !== 'unloaded') refuse(`launchd still has ${unit.name} loaded`);
    }
  }
}

interface ShellPlan {
  bin: string;
  port: string;
  token: string;
  newPort: boolean;
  newToken: boolean;
}

async function install(ctx: CliContext, sys: ServiceSystem, root: string, recipe: string,
  old: ServiceRecord | null, cmd: string): Promise<number> {
  plain(recipe, 'the recipe');
  const work = dirname(root);
  if (!/^https?:\/\//.test(recipe) && !isFile(recipe)) {
    throw new Refusal(`there's no recipe at ${recipe}.`);
  }
  const manager = managerOf(sys);
  const slug = slugOf(basename(work));
  if (slug === '') {
    throw new Refusal(`a service's name comes from its working directory's name, and ${basename(work)} has no letter ` +
      `or digit to make one from, so nothing was written. Set this resident up again in a directory whose name has one.`);
  }
  const dataDir = dataDirOf(root);
  const envFile = join(work, '.env');
  if (lstatSync(envFile, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Refusal(`${envFile} is a link to ${readlinkSync(envFile)}. The install's .env is a file of its own, as ` +
      'setup keeps it, so service install won\'t write through the link or over it. Replace the link with the file it ' +
      "leads to, if that's there, or take it away, then repeat this service install command with the same recipe. " +
      'Nothing was written.');
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
  const env = childEnv(sys);
  const names = serviceUnits(root, sys.platform, sys.home)!;
  const node = sys.which('node');
  const path = [...new Set([dirname(sys.bun), ...(node ? [dirname(node)] : []), '/usr/local/bin', '/usr/bin', '/bin',
    '/usr/sbin', '/sbin'])].join(':');
  const hostArgs = [recipe, '--headless'];
  const logPath = join(work, 'logs', 'agent.log');
  const hostVars: Array<[string, string]> = [['PATH', path], ['DATA_DIR', dataDir]];
  const hostEnv: Array<[string, string]> = [...hostVars, [SUPERVISED_ENV, '1'], [INSTALL_ROOT_ENV, realOrResolved(root)]];
  const loaderEnv = { HOME: sys.home, USER: sys.user, LOGNAME: sys.user, ...Object.fromEntries(hostEnv) };
  const envBefore = readOr(envFile);
  const knownSettings = readEnvFile(envFile);
  const externalToken = knownSettings.get('SESSION_SERVER_TOKEN');
  const unknownSettings: ShellSettings = old !== null && sameDirectory(old.workingDirectory, work) ? Object.fromEntries(
    Object.entries(old.shellSettings ?? {}).filter(([name]) => !SHELL_SETTING_NAMES.includes(name as keyof ShellSettings)))
    : {};
  const ownedSettings: ShellSettings = { ...unknownSettings };
  for (const name of SHELL_SETTING_NAMES) {
    const value = old?.shellSettings?.[name];
    if (value !== undefined && value === knownSettings.get(name)) ownedSettings[name] = value;
  }
  const source = sys.readRecipe(recipe, work, loaderEnv);
  if (source.loads !== true) recipeProblem(source, work, sys, externalToken);
  const wantsShell = source.shell;
  const shellBin = wantsShell ? shellOf(work, sys) : null;
  const units = shellBin === null ? [names.host] : [names.shell, names.host];
  insideNeither(sys, manager, names, units, cmd);
  for (const unit of units) ownedOrFree(unit, manager, work, sys, env);
  const renamed = old !== null && sameDirectory(old.workingDirectory, work)
    ? [old.units.host, ...(old.units.shell ? [old.units.shell] : [])].filter((unit) =>
      unit.name !== names.host.name && unit.name !== names.shell.name)
    : [];
  for (const unit of renamed) {
    const host = unit.name === old!.units.host.name;
    if (host || shellBin !== null) renamedStopped(sys, manager, env, unit, host);
  }
  const shell = shellBin === null ? null : await shellPlan(sys, work, shellBin);
  if (shell !== null && !shell.newPort && !(await sys.portFree(Number(shell.port))) &&
    !shellRunning(sys, manager, env, names.shell)) {
    throw new Refusal(`SESSION_SERVER_PORT in ${envFile} is ${shell.port}, and something other than this install's ` +
      `shell daemon, ${names.shell.name}, is listening on it, as a copied install's original daemon would be. This ` +
      `install's shell clients would reach that process, with ${shell.newToken ? 'a new' : 'the stored'} token. Give ` +
      `this install a port of its own as SESSION_SERVER_PORT in ${envFile}, or take that line away to have one ` +
      'picked, then repeat this service install command. Nothing was written.');
  }
  if (shell !== null && (!shell.newPort || !shell.newToken)) {
    const kept = [...(shell.newPort ? [] : [`SESSION_SERVER_PORT ${shell.port}`]),
      ...(shell.newToken ? [] : ['SESSION_SERVER_TOKEN, not shown'])];
    ctx.out(`The shell daemon uses ${kept.join(' and ')}, as ${envFile} holds ${kept.length === 1 ? 'it' : 'them'}.`);
  }
  if (wantsShell && shellBin === null) {
    ctx.out("The recipe names a shell client or setting, but term-sessions-mcp isn't installed in this directory, " +
      'so no daemon was set up. Doctor can check whether the shell is served.');
  }

  const shellArgv = shell === null ? [] : [node!, shell.bin, '--host', 'localhost', '--headless'];
  const shellSettings: Array<[string, string]> = shell === null ? []
    : [['SESSION_SERVER_PORT', shell.port], ['SESSION_SERVER_TOKEN', shell.token]];
  const shellVars: Array<[string, string]> = shell === null ? [] : [['PATH', path], ...shellSettings];
  const checked = sys.loadRecipe(recipe, work, { ...loaderEnv, ...Object.fromEntries(shellSettings) }, source.document);
  if (checked.loads !== true) recipeProblem(checked, work, sys, shell?.token ?? externalToken);
  if (readOr(envFile) !== envBefore) {
    throw new Refusal(`${envFile} changed while the recipe was checked. Nothing was written or restarted. ` +
      'Repeat this service install command with the same recipe so it uses that file as it is now.');
  }
  for (const unit of units) ownedOrFree(unit, manager, work, sys, env);
  if (manager === 'systemd-user') noOtherHost(ctx, work, names, renamed, sys, env, cmd);
  else noOtherAgent(ctx, work, names, renamed, sys, env);
  if (!wantsShell) {
    try {
      new StoredSecrets(join(work, '.setup')).names();
    } catch (error) {
      throw new Refusal("the shell settings can't be removed: " + errorText(error) + '. Nothing was written or restarted.');
    }
  }
  const hostArgv = [sys.bun, join(root, 'start.js'), ...hostArgs];
  const texts = manager === 'systemd-user'
    ? {
      shell: shell === null ? null : systemdUnit(`connectome-host resident's shell daemon in ${work}`, work, shellArgv,
        shellVars, null),
      host: systemdUnit(`connectome-host resident in ${work}`, work, hostArgv, [...hostVars, [SUPERVISED_ENV, '1']],
        shell === null ? null : names.shell.name),
      unchecked: systemdUnit(`connectome-host resident in ${work}`, work, hostArgv, hostVars,
        shell === null ? null : names.shell.name),
    }
    : {
      shell: shell === null ? null : plist(names.shell.name, work, shellArgv, shellVars, join(work, 'logs', 'shell.log')),
      host: plist(names.host.name, work, hostArgv, [...hostVars, [SUPERVISED_ENV, '1']], logPath),
      unchecked: null,
    };
  const dropped = [...(shell === null ? [names.shell] : []), ...renamed];

  const record: ServiceRecord = {
    v: 1,
    manager,
    units: { host: names.host, ...(shell === null ? {} : { shell: names.shell }) },
    hostArgs,
    workingDirectory: work,
    logs: manager === 'systemd-user' ? { kind: 'journal' } : { kind: 'file', path: logPath },
    shellSettings: ownedSettings,
  };
  const previousShell = old?.units.shell;
  const shellText = readOr(names.shell.file);
  const retiring = shell === null && (previousShell?.name === names.shell.name ||
    (shellText !== null && runsHere(fileDirectory(sys, env, manager, names.shell, shellText), work)))
    ? names.shell : undefined;
  const recorded: ServiceRecord = { ...record,
    units: { ...record.units, ...(retiring === undefined ? {} : { shell: retiring }) } };
  let retained = retiring !== undefined;
  let persisted = false;
  let touched = false;
  try {
    const writeUnit = (unit: ServiceUnit, text: string) => {
      try {
        writeText(unit.file, text);
      } catch (error) {
        throw new Refusal(`${unit.file} can't be written: ${errorText(error)}. Nothing was started or restarted.`);
      }
      touched = true;
    };
    try {
      if (shell !== null) keepShellSettings(ctx, sys, work, shell, ownedSettings);
      if (manager === 'systemd-user') {
        if (texts.shell !== null) {
          writeUnit(names.shell, texts.shell);
          ctx.out(`Wrote ${names.shell.file}, the resident's shell daemon's unit.`);
        }
        writeUnit(names.host, texts.unchecked!);
        systemctl(sys, env, cmd, ['daemon-reload']);
        const loaded = showUnit(sys, env, names.host.name, ['LoadState', 'WorkingDirectory', RESTART_PROPERTIES]);
        if (typeof loaded === 'string') throw new Refusal(`${loaded}. Nothing was started.`);
        if (loaded.get('LoadState') !== 'loaded' ||
          !runsHere(runsFrom(loaded.get('WorkingDirectory') ?? '', sys.home), work)) {
          throw new Refusal(`systemd didn't load ${names.host.name} from ${names.host.file} with ${work} as its working ` +
            `directory (it shows ${loaded.get('LoadState') || 'no load state'}, in ` +
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
        writeUnit(names.host, texts.host);
        systemctl(sys, env, cmd, ['daemon-reload']);
        ctx.out(`Wrote ${names.host.file}. systemd restarts it when the host exits with ${RESTART_EXIT_CODE} and with 1 ` +
          `(${policy.settings}), so its unit sets ${SUPERVISED_ENV}=1.`);
        systemctl(sys, env, cmd, ['enable', ...units.map((unit) => unit.name)]);
        ctx.out(`Enabled ${units.map((unit) => unit.name).join(' and ')}, so systemd starts ` +
          `${units.length === 1 ? 'it' : 'them'} at boot.`);
        systemctl(sys, env, cmd, ['reset-failed', ...units.map((unit) => unit.name)]);
        for (const unit of units) {
          const shown = showUnit(sys, env, unit.name, ['ActiveState']);
          if (typeof shown === 'string') {
            throw new Refusal(`${shown}. The units' files are written and enabled, and recorded: run ${cmd} service ` +
              'start to start what isn\'t running.');
          }
          const running = RUNNING.has(shown.get('ActiveState') ?? '');
          systemctl(sys, env, cmd, ['restart', unit.name]);
          ctx.out(running ? `Restarted ${unit.name}.` : `Started ${unit.name}.`);
        }
      } else {
        mkdirSync(dirname(logPath), { recursive: true });
        chmodSync(dirname(logPath), 0o700);
        for (const unit of units) writeUnit(unit, unit === names.host ? texts.host : texts.shell!);
        ctx.out(`KeepAlive restarts the host whenever it exits other than with 0, so its launch agent sets ${SUPERVISED_ENV}=1.`);
        for (const unit of units) {
          const stateBefore = agentState(sys, env, unit);
          const loaded = stateBefore.kind === 'running' || stateBefore.kind === 'loaded';
          if (loaded) await bootout(ctx, sys, env, unit,
            'Repeat this service install command with the same recipe to load its rewritten agents.');
          ownedOrFree(unit, manager, work, sys, env, loaded ? `${unit.name} was already unloaded. ` : '');
          const rotate = loaded || stateBefore.kind === 'unloaded';
          if (stateBefore.kind === 'unknown') ctx.out(`The state of ${unit.name} couldn't be read: ${stateBefore.why}. ` +
            'This run kept its log in place; it can hold earlier loads.');
          const ran = loadAgent(sys, env, unit, unit === names.host ? logPath : join(work, 'logs', 'shell.log'), rotate);
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
        }
        ctx.out(`launchd loads ${units.length === 1 ? 'this agent' : 'these agents'}, and so starts ` +
          `${units.length === 1 ? 'it' : 'them'}, each time ${sys.user} logs in to the Mac's graphical session.`);
      }
    } finally {
      if (touched) {
        writeJsonAtomic(join(root, 'service.json'), recorded, 0o600);
        persisted = true;
        ctx.out(`Recorded it in ${join(root, 'service.json')}.`);
      }
    }

    const passed = await readyAndChecked(ctx, root, record, sys, env);
    if (passed) {
      for (const unit of dropped) {
        let removed = false;
        try {
          removed = await removeUnit(ctx, sys, env, manager, unit, work, cmd, renamed.includes(unit));
          if (!removed) return 1;
        } finally {
          if (!removed) ctx.out(`${renamed.includes(unit) ? `Retiring ${unit.name}, which this install's record named, is incomplete.`
            : 'Shell retirement is incomplete.'} Any existing shell settings were kept. ` +
            'Resolve the reported state or ownership problem, then repeat this service install command. ' +
            'Use a native stop instruction only if that unit belongs to this install.');
        }
      }
      if (retiring !== undefined) {
        ctx.out(`A managed shell daemon needs term-sessions-mcp installed in ${work}. ` +
          `To bring it back, run ${cmd} service install <recipe> with a recipe that names the shell client or ` +
          'SESSION_SERVER_TOKEN or SESSION_SERVER_PORT in its source.');
      }
      if (retained) {
        const withoutShell = { ...recorded, units: { host: recorded.units.host } };
        writeJsonAtomic(join(root, 'service.json'), withoutShell, 0o600);
        retained = false;
      }
      if (!wantsShell) {
        dropShellSettings(ctx, work, ownedSettings, sys.env, old?.shellSettings ?? {});
        const withoutSettings: ServiceRecord = { ...record, shellSettings: unknownSettings };
        if (Object.keys(unknownSettings).length === 0) delete withoutSettings.shellSettings;
        writeJsonAtomic(join(root, 'service.json'), withoutSettings, 0o600);
      }
    }
    if (!passed) {
      const before = old?.hostArgs[0];
      if (before !== undefined && before !== recipe) {
        let shown: string | null;
        let guessed = false;
        try {
          const redacted = installRedactor(work, sys)(before);
          shown = redacted.text;
          guessed = redacted.guessed.length > 0;
        } catch {
          shown = null;
        }
        if (guessed) ctx.out(guessedSecretsNotice(work));
        ctx.out(shown === null
          ? 'Before this run, service.json recorded another recipe, which isn\'t shown, since the install\'s secrets can\'t ' +
            'all be kept out of it.'
          : shown === before
            ? `Before this run, service.json recorded the recipe ${before}: ${cmd} service install ${shellWord(before)} ` +
              'puts it back, if the host\'s recipe loader still takes it.'
            : `Before this run, service.json recorded the recipe ${shown}, with some values hidden. Use the full original ` +
              `recipe argument with ${cmd} service install to put it back, ` +
              'if the host\'s recipe loader still takes it.');
      }
      ctx.out(`Put right what the lines above show, then run ${cmd} service install again. Until then ${manager === 'systemd-user'
        ? 'systemd restarts the host each time it fails, while it has its unit loaded and its start limit allows; the ' +
          'run clears that limit'
        : 'launchd starts the host again each time it exits other than with 0, while it has its agent loaded'}.`);
    }
    for (const line of serviceLines(root, sys.env.PATH) ?? []) ctx.out(line);
    return passed ? 0 : 1;
  } finally {
    if (persisted && retained) retainedShellNotice(ctx, root, sys, env, manager, retiring!, cmd);
  }
}

async function readyAndChecked(ctx: CliContext, root: string, record: ServiceRecord, sys: ServiceSystem,
  env: Record<string, string>): Promise<boolean> {
  const ready = await awaitReady(root, record, sys, env);
  if (typeof ready === 'string') ctx.err(`connectome: ${ready}`);
  else ctx.out(`Its host answers: pid ${ready.pid}, recipe ${ready.recipe}.`);
  const checked = await checkRecord(root, record, sys);
  for (const line of checked.lines) ctx.out(line);
  return checked.passed && typeof ready !== 'string';
}

function recordOf(root: string, cmd: string): ServiceRecord {
  const record = readServiceRecord(root, cmd);
  if (record === null) {
    throw new Refusal(`No service is recorded for this install (${join(root, 'service.json')}). ` +
      `${cmd} service install <recipe> sets one up.`);
  }
  return record;
}

function unitsOf(record: ServiceRecord): ServiceUnit[] {
  return [record.units.host, ...(record.units.shell === undefined ? [] : [record.units.shell])];
}

function fileOf(manager: Manager): string {
  return manager === 'launchd' ? 'launch agent\'s file' : 'unit file';
}

function thisInstalls(record: ServiceRecord, sys: ServiceSystem, env: Record<string, string>,
  verb: 'stop' | 'start', cmd: string): void {
  const done = verb === 'stop' ? 'stopped' : 'started';
  for (const unit of unitsOf(record)) {
    const owner = ownerOf(unit, record.manager, record.workingDirectory, sys, env);
    if (owner.kind === 'unshown') throw new Refusal(`${owner.shown}. Nothing was ${done}.`);
    if (owner.kind === 'untold') {
      const stopIt = stopLine(sys, record.manager, unit.name);
      const remedy = verb === 'stop'
        ? `stop it with ${stopIt}, then run ${cmd} service stop again, which stops the rest of the service; ` +
          `${cmd} service install sets its service up again when it's wanted back.`
        : `stop it (${stopIt}), then run ${cmd} service install again.`;
      throw new Refusal(`${untold(sys, record.manager, unit)}. ${cmd} service ${verb} leaves it alone, and nothing ` +
        `was ${done}. If it's this install's, ${remedy}`);
    }
    if (owner.kind === 'other') {
      throw new Refusal(configConflict(unit, owner.from, owner.runsIn, record.workingDirectory,
        stopLine(sys, record.manager, unit.name)) + ` ${cmd} service ${verb} leaves it alone. ` +
        `Nothing was ${done}: ${cmd} service install says how to set this install's service up again.`);
    }
  }
}

async function stopService(ctx: CliContext, sys: ServiceSystem): Promise<number> {
  const root = ctx.root!;
  const cmd = typedCommand(root, sys.env.PATH);
  const record = recordOf(root, cmd);
  const units = unitsOf(record);
  const inside = insideOf(sys, record.manager, units);
  if (inside !== undefined) {
    throw new Refusal(`${cmd} service stop stops ${inside.name}, and this command runs inside it, so that would end ` +
      'this command partway, before it says what the service\'s next start does. Nothing was stopped. Ask whoever runs ' +
      'this machine to run it from a terminal outside the resident\'s service, such as over ssh.');
  }
  const env = childEnv(sys);
  thisInstalls(record, sys, env, 'stop', cmd);
  if (record.manager === 'systemd-user') {
    if (!stopUnits(ctx, sys, env, units)) return 1;
  } else {
    for (const unit of units) {
      const state = agentState(sys, env, unit);
      if (state.kind === 'unknown') {
        throw new Refusal(`Whether ${unit.name} is loaded can't be told: ${state.why}. ` +
          `Run ${cmd} service stop again once the query succeeds.`);
      }
      if (state.kind === 'unloaded') {
        ctx.out(`${unit.name} wasn't loaded.`);
        continue;
      }
      await bootout(ctx, sys, env, unit, `Run ${cmd} service stop again to finish stopping its agents.`);
      ctx.out(state.kind === 'loaded' ? `${unit.name} wasn't running, and launchd no longer has it loaded.`
        : `Stopped ${unit.name}.`);
    }
  }
  for (const line of startsAgain(record, sys, env, cmd)) ctx.out(line);
  for (const line of updateState(root, 'the next start')) ctx.out(line);
  return 0;
}

function stopUnits(ctx: CliContext, sys: ServiceSystem, env: Record<string, string>, units: ServiceUnit[]): boolean {
  const before = units.map((unit) => {
    const shown = showUnit(sys, env, unit.name, ['ActiveState']);
    if (typeof shown === 'string') throw new Refusal(`${shown}. Nothing was stopped.`);
    return STOPPING.has(shown.get('ActiveState') ?? '');
  });
  const running = units.filter((_, at) => before[at]);
  let stopped = true;
  if (running.length > 0) {
    const ran = sys.run('systemctl', ['--user', 'stop', ...running.map((unit) => unit.name)], env);
    if (ran.status !== 0) {
      ctx.err(`connectome: systemctl --user stop ${running.map((unit) => unit.name).join(' ')} failed: ${stderrOf(ran)}.`);
      stopped = false;
    }
  }
  units.forEach((unit, at) => {
    const shown = showUnit(sys, env, unit.name, ['ActiveState', 'SubState']);
    if (typeof shown === 'string') {
      ctx.err(`connectome: ${shown}, so whether ${unit.name} stopped can't be told.`);
      stopped = false;
    } else if (STOPPING.has(shown.get('ActiveState') ?? '')) {
      ctx.out(`${unit.name} is ${before[at] ? 'still ' : ''}${stateOf(shown)}.`);
      stopped = false;
    } else {
      ctx.out(before[at] ? `Stopped ${unit.name}.` : `${unit.name} wasn't running.`);
    }
  });
  return stopped;
}

function startsAgain(record: ServiceRecord, sys: ServiceSystem, env: Record<string, string>, cmd: string): string[] {
  const gone = unitsOf(record).find((unit) => pathState(unit.file) === 'gone');
  if (gone === undefined) return [startsByItself(record, sys, env, true, cmd)];
  const refuses = `${gone.file}, ${gone.name}'s ${fileOf(record.manager)}, is gone, so ${cmd} service start ` +
    `refuses. ${serviceRepair(cmd)}`;
  return gone === record.units.host ? [refuses] : [startsByItself(record, sys, env, false, cmd), refuses];
}

export function pathState(path: string): 'there' | 'gone' | { why: string; repair: string } {
  try {
    statSync(path);
    return 'there';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'gone';
    return {
      why: errorText(error).replace(/\.$/, ''),
      repair: code === 'EACCES' || code === 'EPERM'
        ? 'Give this user search on each directory on the way to it, and run this again.'
        : 'Repair what that path runs through, and run this again.',
    };
  }
}

function startsByItself(record: ServiceRecord, sys: ServiceSystem, env: Record<string, string>,
  startsToo: boolean, cmd: string): string {
  const host = record.units.host;
  const orStart = startsToo ? `, or with ${cmd} service start` : '';
  if (record.manager === 'launchd') {
    return `${startsToo ? 'Its' : `${host.name}'s`} launch agent stays in ${dirname(host.file)}, so launchd starts it ` +
      `again when ${sys.user} next logs in to the Mac's graphical session${orStart}.`;
  }
  const shown = showUnit(sys, env, host.name, ['UnitFileState']);
  if (typeof shown === 'string') {
    return `Whether ${startsToo ? 'it' : host.name} starts at boot can't be told: ${shown}.` +
      `${startsToo ? ` ${cmd} service start starts it again.` : ''}`;
  }
  const state = shown.get('UnitFileState') ?? '';
  if (state !== 'enabled') {
    return `${startsToo ? 'Its unit' : host.name} isn't enabled (systemd shows it as ${state || 'having no unit file ' +
      'state'}), so it doesn't start at boot: ${startsToo ? `${cmd} service start starts it again, and ` : ''}` +
      `${cmd} service install enables it.`;
  }
  const enabled = startsToo ? 'It\'s still enabled' : `${host.name} is still enabled`;
  return sys.linger(sys.user) === true
    ? `${enabled}, so it starts again when the machine next boots${orStart}.`
    : `${enabled}, but linger isn't on for ${sys.user}, so it doesn't start at boot` +
      `${startsToo ? `: ${cmd} service start starts it again` : ''}.`;
}

function updateState(root: string, which: 'the next start' | 'this start'): string[] {
  const Which = `${which[0]!.toUpperCase()}${which.slice(1)}`;
  let lines: JournalLine[];
  let current: string | null;
  try {
    lines = readJournal(root);
    current = readCurrent(root);
  } catch (error) {
    return [`Whether an update is under way can't be told: ${errorText(error).replace(/\.?$/, '.')} ${Which}'s ` +
      'launcher reads the same files first, and starts nothing while it can\'t read them.'];
  }
  if (current === null) return [];
  const outcome = 'The host\'s log says what came of it.';
  const trial = unfinishedTrial(lines, current);
  if (trial !== null) {
    return [`${trial.to} was on trial and hadn't committed, so ${which} falls back to ${current}: it puts ` +
      `${current}'s data back, keeping aside what ${trial.to} left, and starts ${current} once that's done. ${outcome}`];
  }
  const pending = pendingGoBack(lines);
  if (pending !== null) {
    return [`A Go back to ${pending.to} was cut off partway, so ${which} goes on with it. ${outcome}`];
  }
  let mark: Mark | null;
  try {
    mark = readMark(root);
  } catch (error) {
    const why = error instanceof ContractError ? error.message
      : `The mark at ${installPaths(root).mark} couldn't be read: ${errorText(error)}.`;
    return [`${why} ${Which} says so too, and starts ${current} as it was.`];
  }
  if (mark === null) return [];
  if (mark.why === 'update') {
    return [`A switch to ${mark.to} is marked, so ${which} takes it up: it starts ${mark.to} on trial, unless it refuses ` +
      `the switch. ${outcome}`];
  }
  if (mark.why === 'go-back') {
    return [`A Go back to ${mark.to} is marked, so ${which} takes it up: ${mark.keepData
      ? `${mark.to} starts on the data as it is now`
      : `the copy of ${mark.to}'s data is restored, with what came since set aside, and ${mark.to} starts`}, unless it ` +
      `refuses the Go back. ${outcome}`];
  }
  return [`The mark at ${installPaths(root).mark} asks for a request this release doesn't know, so ${which} says so and ` +
    `starts ${current} as it was.`];
}

async function startService(ctx: CliContext, sys: ServiceSystem): Promise<number> {
  const root = ctx.root!;
  const cmd = typedCommand(root, sys.env.PATH);
  const record = recordOf(root, cmd);
  const units = unitsOf(record);
  const inside = insideOf(sys, record.manager, units);
  if (inside !== undefined) {
    throw new Refusal(`this command runs inside ${inside.name}, so that unit is running, and ${cmd} service start is ` +
      'refused there, as install and stop are. Nothing was started. If the resident\'s service needs starting, ask ' +
      'whoever runs this machine to run it from a terminal outside it, such as over ssh.');
  }
  for (const unit of units) {
    const state = pathState(unit.file);
    if (state === 'gone') {
      throw new Refusal(`${unit.file}, ${unit.name}'s ${fileOf(record.manager)}, is gone. ${serviceRepair(cmd)} ` +
        'Nothing was started.');
    }
    if (state !== 'there') {
      throw new Refusal(`${unit.file}, ${unit.name}'s ${fileOf(record.manager)}, can't be looked at (${state.why}), so ` +
        `whether it's there can't be told. Nothing was started. ${state.repair}`);
    }
  }
  const env = childEnv(sys);
  thisInstalls(record, sys, env, 'start', cmd);
  const started = record.manager === 'systemd-user'
    ? startUnits(ctx, sys, env, root, units, cmd)
    : startAgents(ctx, sys, env, root, record);
  if (!started) {
    for (const line of (await checkService(root, sys)).lines) ctx.out(line);
    return 1;
  }
  const passed = await readyAndChecked(ctx, root, record, sys, env);
  for (const line of serviceLines(root, sys.env.PATH) ?? []) ctx.out(line);
  return passed ? 0 : 1;
}

function startUnits(ctx: CliContext, sys: ServiceSystem, env: Record<string, string>, root: string,
  units: ServiceUnit[], cmd: string): boolean {
  const states = () => units.map((unit) => {
    const each = showUnit(sys, env, unit.name, ['ActiveState', 'SubState']);
    if (typeof each === 'string') throw new Refusal(`${each}. Nothing was started.`);
    return each;
  });
  let shown = states();
  const down = units.filter((_, at) => shown[at]!.get('ActiveState') === 'deactivating');
  if (down.length > 0) {
    const ran = sys.run('systemctl', ['--user', 'stop', ...down.map((unit) => unit.name)], env);
    if (ran.status !== 0) {
      ctx.err(`connectome: systemctl --user stop ${down.map((unit) => unit.name).join(' ')} failed: ${stderrOf(ran)}. ` +
        `${cmd} service start runs it to wait for a unit on its way down, and started nothing.`);
      return false;
    }
    shown = states();
  }
  const idle = units.filter((_, at) => !RUNNING.has(shown[at]!.get('ActiveState') ?? '') ||
    shown[at]!.get('SubState') === 'auto-restart');
  if (idle.includes(units[0]!)) for (const line of updateState(root, 'this start')) ctx.out(line);
  if (idle.length > 0) {
    for (const verb of ['reset-failed', 'start']) {
      const args = [verb, ...idle.map((unit) => unit.name)];
      const ran = sys.run('systemctl', ['--user', ...args], env);
      if (ran.status !== 0) {
        ctx.err(`connectome: systemctl --user ${args.join(' ')} failed: ${stderrOf(ran)}.`);
        return false;
      }
    }
  }
  units.forEach((unit, at) => ctx.out(idle.includes(unit) ? `Started ${unit.name}.`
    : `${unit.name} was already ${stateOf(shown[at]!)}, so it wasn't started again.`));
  return true;
}

function startAgents(ctx: CliContext, sys: ServiceSystem, env: Record<string, string>, root: string,
  record: ServiceRecord): boolean {
  const order = [...(record.units.shell === undefined ? [] : [record.units.shell]), record.units.host];
  const states = order.map((unit) => agentState(sys, env, unit));
  if (states.at(-1)!.kind !== 'running') for (const line of updateState(root, 'this start')) ctx.out(line);
  for (const [at, unit] of order.entries()) {
    const state = states[at]!;
    if (state.kind === 'running') {
      ctx.out(`${unit.name} was already running, so it wasn't started again.`);
      continue;
    }
    if (state.kind === 'unknown') {
      ctx.out(`${unit.name}'s state couldn't be read from launchd: ${state.why}. This start kept its log in place. ` +
        "It may hold lines from an earlier load.");
    }
    const ran = states[at]!.kind === 'loaded'
      ? sys.run('launchctl', ['kickstart', `gui/${sys.uid}/${unit.name}`], env)
      : loadAgent(sys, env, unit, unit === record.units.host && record.logs.kind === 'file' ? record.logs.path
        : join(record.workingDirectory, 'logs', unit === record.units.host ? 'agent.log' : 'shell.log'),
      states[at]!.kind === 'unloaded');
    if (ran.status !== 0) {
      ctx.err(`connectome: ${states[at]!.kind === 'loaded' ? `launchctl kickstart gui/${sys.uid}/${unit.name}`
        : `launchctl bootstrap gui/${sys.uid} ${unit.file}`} failed: ${launchctlFailure(ran)}.`);
      return false;
    }
    ctx.out(`Started ${unit.name}.`);
  }
  return true;
}

type AgentState = { kind: 'unloaded' } | { kind: 'loaded'; exit?: string } |
  { kind: 'running'; pid: string } | { kind: 'unknown'; why: string };

export function agentState(sys: ServiceSystem, env: Record<string, string>, unit: ServiceUnit): AgentState {
  const listed = sys.run('launchctl', ['list', unit.name], env);
  if (listed.status === 113) return { kind: 'unloaded' };
  if (listed.status !== 0) return { kind: 'unknown', why: launchctlFailure(listed) };
  const pid = pidOf(listed.stdout);
  return pid === undefined
    ? { kind: 'loaded', exit: /"LastExitStatus"\s*=\s*(-?\d+);/.exec(listed.stdout)?.[1] }
    : { kind: 'running', pid };
}

function loadAgent(sys: ServiceSystem, env: Record<string, string>, unit: ServiceUnit, log: string, rotate: boolean): Ran {
  if (rotate && existsSync(log)) renameSync(log, `${log}.previous`);
  return sys.run('launchctl', ['bootstrap', `gui/${sys.uid}`, unit.file], env);
}

function insideOf(sys: ServiceSystem, manager: Manager, units: ServiceUnit[]): ServiceUnit | undefined {
  const cgroups = (sys.cgroup() ?? '').split('\n').map((line) => line.split('/'))
    .filter((path) => path.includes(`user@${sys.uid}.service`));
  return units.find((unit) => manager === 'systemd-user'
    ? cgroups.some((path) => path.includes(unit.name))
    : sys.env.XPC_SERVICE_NAME === unit.name);
}

function insideNeither(sys: ServiceSystem, manager: Manager,
  names: { host: ServiceUnit; shell: ServiceUnit }, units: ServiceUnit[], cmd: string): void {
  const inside = insideOf(sys, manager, [names.host, names.shell]);
  if (inside === undefined) return;
  throw new Refusal(`${cmd} service install ${units.includes(inside) ? 'restarts' : 'stops'} ${inside.name}, and ` +
    'this command runs inside it, so that would end this command partway, before its record and its check. Nothing ' +
    'was written. Ask whoever runs this machine to run it from a terminal outside the resident\'s service, such as ' +
    'over ssh.');
}

function installRedactor(work: string, sys: ServiceSystem, token?: string): ReturnType<typeof storedSecretRedactor> {
  return storedSecretRedactor(work, token ? { ...sys.env, SESSION_SERVER_TOKEN: token } : sys.env,
    false, ['SESSION_SERVER_TOKEN']);
}

function recipeProblem(loaded: Exclude<RecipeLoad, { loads: true }>, work: string, sys: ServiceSystem,
  token: string | undefined): never {
  let redact: ReturnType<typeof storedSecretRedactor>;
  try {
    redact = installRedactor(work, sys, token);
  } catch (error) {
    throw new Refusal(`${loaded.loads === false
      ? 'the host\'s own recipe loader, run in the working directory with .env, refuses the recipe, and its words'
      : 'whether the host can load the recipe couldn\'t be checked, and why'} aren't ` +
      `shown, since the install's secrets can't all be kept out of them: ${errorText(error).replace(/\.+$/, '')}. ` +
      `Nothing was written or restarted. Put that right, then repeat this service install command with the same recipe.`);
  }
  const whole = redact(loaded.loads === false ? loaded.words : loaded.why);
  const redacted = loaded.loads === false ? whole
    : { ...whole, text: whole.text.trim().split('\n').at(-1)?.trim() ?? '' };
  throw new Refusal((loaded.loads === false
    ? 'the host\'s own recipe loader, run in the working directory with .env, refuses the recipe: ' +
      `${redacted.text.replace(/\.+$/, '')}. Nothing was written or restarted.`
    : `whether the host can load the recipe couldn't be checked: ${redacted.text.replace(/\.+$/, '')}. Nothing ` +
      `was written or restarted. Repeat this service install command with the same recipe once that's put right.`) +
    (redacted.guessed.length > 0 ? ` ${guessedSecretsNotice(work)}` : ''));
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

function fileDirectory(sys: ServiceSystem, env: Record<string, string>, manager: Manager,
  unit: ServiceUnit, text: string): string | null {
  const set = manager === 'systemd-user'
    ? [...text.matchAll(/^WorkingDirectory=(.*)$/gm)].at(-1)?.[1]?.replace(/^-/, '').replace(/%%/g, '%') ?? null
    : plistField(sys, env, unit.file, 'WorkingDirectory');
  return set === null || set === '' ? null : realOrResolved(set === '~' ? sys.home : set);
}

function plistField(sys: ServiceSystem, env: Record<string, string>, path: string, key: string): string | null {
  const type = sys.run('plutil', ['-type', key, path], env);
  if (type.status !== 0) {
    const lint = sys.run('plutil', ['-lint', path], env);
    if (lint.status !== 0) throw new Error(lint.stderr.trim() || lint.stdout.trim() || `plutil exited with ${lint.status}`);
    return null;
  }
  if (type.stdout !== 'string\n') return null;
  const raw = sys.run('plutil', ['-extract', key, 'raw', '-o', '-', path], env);
  if (raw.status !== 0) throw new Error(raw.stderr.trim() || raw.stdout.trim() || `plutil exited with ${raw.status}`);
  // plutil raw adds one LF; spaces and any newline in the value itself remain part of that value.
  return raw.stdout.replace(/\n$/, '');
}

export function runsHere(directory: string | null, work: string): boolean {
  return directory !== null && sameDirectory(directory, work);
}

/** systemctl show (systemd 257) gives WorkingDirectory=-/x as !/x, ~ as ~, and an unset one under the user manager as
 *  ! and the home, its default. */
export function runsFrom(shown: string, home: string): string | null {
  const set = shown.replace(/^[-!+@:]+/, '');
  if (set === '' || (shown.startsWith('!') && realOrResolved(set) === realOrResolved(home))) return null;
  return realOrResolved(set === '~' ? home : set);
}

type Owner = { kind: 'ok' } | { kind: 'other'; runsIn: string | null; from: string } | { kind: 'untold' }
  | { kind: 'unshown'; shown: string };

function ownerOf(unit: ServiceUnit, manager: Manager, work: string, sys: ServiceSystem,
  env: Record<string, string>): Owner {
  const text = readOr(unit.file);
  if (text !== null) {
    const runsIn = fileDirectory(sys, env, manager, unit, text);
    if (!runsHere(runsIn, work)) return { kind: 'other', runsIn, from: unit.file };
  }
  if (manager !== 'systemd-user') {
    if (text !== null) return { kind: 'ok' };
    const state = agentState(sys, env, unit);
    if (state.kind === 'unknown') return { kind: 'unshown', shown: `launchctl list ${unit.name} failed: ${state.why}` };
    return state.kind === 'unloaded' ? { kind: 'ok' } : { kind: 'untold' };
  }
  const shown = showUnit(sys, env, unit.name, ['LoadState', 'ActiveState', 'WorkingDirectory', 'FragmentPath']);
  if (typeof shown === 'string') return { kind: 'unshown', shown };
  if (shown.get('LoadState') === 'not-found') {
    return STOPPING.has(shown.get('ActiveState') ?? '') ? { kind: 'untold' } : { kind: 'ok' };
  }
  const runsIn = runsFrom(shown.get('WorkingDirectory') ?? '', sys.home);
  return runsHere(runsIn, work) ? { kind: 'ok' }
    : { kind: 'other', runsIn, from: shown.get('FragmentPath') || unit.file };
}

function ownedOrFree(unit: ServiceUnit, manager: Manager, work: string, sys: ServiceSystem,
  env: Record<string, string>, afterWrite?: string): void {
  const owner = ownerOf(unit, manager, work, sys, env);
  const effect = afterWrite === undefined ? 'Nothing was written.'
    : `The service files already written remain in place. ${afterWrite}No further unit was changed.`;
  if (owner.kind === 'other') {
    throw new Refusal(configConflict(unit, owner.from, owner.runsIn, work, stopLine(sys, manager, unit.name)) +
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

function renamedStopped(sys: ServiceSystem, manager: Manager, env: Record<string, string>,
  unit: ServiceUnit, host: boolean): void {
  const whose = `${unit.name}, this install's own ${host ? 'host' : 'shell daemon'} under its earlier name,`;
  let live: boolean;
  if (manager === 'launchd') {
    const state = agentState(sys, env, unit);
    if (state.kind === 'unknown') {
      throw new Refusal(`Whether ${whose} is loaded can't be told: ${state.why}. Nothing was written.`);
    }
    live = state.kind !== 'unloaded';
  } else {
    const shown = showUnit(sys, env, unit.name, ['ActiveState']);
    if (typeof shown === 'string') {
      throw new Refusal(`${shown}, so whether ${whose} is running can't be told. Nothing was written.`);
    }
    live = RUNNING.has(shown.get('ActiveState') ?? '') || shown.get('ActiveState') === 'deactivating';
  }
  if (!live) return;
  throw new Refusal(`${whose} is ${manager === 'launchd' ? 'loaded' : 'running'}, and ${host
    ? "a host started beside it couldn't open the install's store, which it holds"
    : "a shell daemon started beside it couldn't take the stored port, which it holds"}. Stop it when it suits you: ` +
    `${stopLine(sys, manager, unit.name)}. Then repeat this service install command with the same recipe, which ` +
    'retires its files once the new host passes its checks. Nothing was written.');
}

function stopLine(sys: ServiceSystem, manager: Manager, name: string): string {
  return manager === 'systemd-user' ? systemctlLine(sys, `stop ${name}`) : `launchctl bootout gui/${sys.uid}/${name}`;
}

function configConflict(unit: ServiceUnit, from: string, runsIn: string | null, work: string, stop: string): string {
  return `${unit.name}'s config (${from}) names ${runsIn ?? 'no working directory set'}, rather than this install in ` +
    `${work}. Its running process may still be this install's. If so, stop it with ${stop}.`;
}

function noOtherHost(ctx: CliContext, work: string, names: { host: ServiceUnit; shell: ServiceUnit },
  recorded: ServiceUnit[], sys: ServiceSystem, env: Record<string, string>, cmd: string): void {
  const run = (args: string[]) => {
    const ran = sys.run('systemctl', args, env);
    return { exitCode: ran.status, stdout: Buffer.from(ran.stdout) };
  };
  const listed = systemdUnits(work, run as never, sys.home, undefined, (directory) => sameDirectory(directory, work));
  for (const scope of listed.unasked) {
    ctx.out(`systemd's ${scope} manager couldn't be asked which of its units run from ${work}, so one that runs a ` +
      'host there isn\'t ruled out.');
  }
  const others = listed.found.filter((unit) => unit.scope === 'system' ||
    (unit.id !== names.host.name && unit.id !== names.shell.name && !recorded.some((own) => own.name === unit.id)));
  if (others.length > 0) {
    const steps = (['user', 'system'] as const).flatMap((scope) => {
      const these = others.filter((unit) => unit.scope === scope);
      if (these.length === 0) return [];
      const ids = (units: typeof these) => units.map((unit) => shellWord(unit.id)).join(' ');
      const line = (args: string) => (scope === 'user' ? systemctlLine(sys, args) : `systemctl ${args}`);
      const filed = these.filter((unit) => unit.file !== '');
      return [`${scope === 'system' ? 'as root, ' : ''}${line(`stop ${ids(these)}`)}, ` +
        `${filed.length > 0 ? `${line(`disable ${ids(filed)}`)}, remove ${filed.map((unit) => shellWord(unit.file))
          .join(' and ')}, ` : ''}then ${line('daemon-reload')}`];
    });
    const statuses = (['user', 'system'] as const).flatMap((scope) => {
      const ids = others.filter((unit) => unit.scope === scope).map((unit) => shellWord(unit.id)).join(' ');
      return ids === '' ? [] : [scope === 'user' ? systemctlLine(sys, `status ${ids}`) : `systemctl status ${ids}`];
    });
    const them = others.length === 1 ? 'it' : 'them';
    throw new Refusal(`${others.map((unit) => `${unit.id} (a ${unit.scope} unit, ${unit.file === '' ? 'with no unit file'
      : `at ${unit.file}`})`).join(' and ')} ${others.length === 1 ? 'is' : 'are'} already set up to run from ${work}, ` +
      `and two hosts on one install would both serve its data. ${statuses.join(' and ')} shows ` +
      `${others.length === 1 ? 'its state, and its process if it\'s running' : 'their states, and their processes if ' +
        'they\'re running'}. If that shows nothing uses ${them}, take ${them} away: ` +
      `${steps.join('; and ')}. If ${others.length === 1 ? 'it runs' : 'they run'} something other than a host, give ` +
      `${them} another working directory instead. Then repeat this service install command with the same recipe. Nothing was written.`);
  }
  const few = listed.defaulted.length === 1;
  if (listed.defaulted.length > 0) {
    ctx.out(`${listed.defaulted.join(', ')} ${few ? 'sets' : 'set'} no working directory, so ${few ? 'it runs' :
      'they run'} in ${few ? 'its' : 'their'} systemd manager's default, which is ${work}. Most units that do are no ` +
      `host's, so ${few ? 'it isn\'t' : 'they aren\'t'} checked. If ${few ? 'it runs' : 'one of them runs'} a host, two ` +
      'hosts would serve this install\'s data: give it a working directory of its own, or take it away.');
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

function noOtherAgent(ctx: CliContext, work: string, names: { host: ServiceUnit; shell: ServiceUnit },
  recorded: ServiceUnit[], sys: ServiceSystem, env: Record<string, string>): void {
  const dir = join(sys.home, 'Library', 'LaunchAgents');
  const warn = (file: string, why: string) => ctx.out(`${file} couldn't be checked: ${why}. ` +
    `Another agent running a host from ${work} isn't ruled out.`);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn(dir, errorText(error));
    return;
  }
  for (const file of files.filter((file) => file.endsWith('.plist'))) {
    const path = join(dir, file);
    if (path === names.host.file || path === names.shell.file || recorded.some((own) => own.file === path)) continue;
    let label: string | null;
    try {
      const directory = plistField(sys, env, path, 'WorkingDirectory');
      if (directory === null || !sameDirectory(directory, work)) continue;
      label = plistField(sys, env, path, 'Label');
    } catch (error) {
      warn(path, errorText(error));
      continue;
    }
    if (label === null || label === '') {
      warn(path, 'no launch-agent Label');
      continue;
    }
    if (label === names.host.name || label === names.shell.name) {
      const own = label === names.host.name ? names.host.file : names.shell.file;
      throw new Refusal(`${path} has the label ${label} and runs from ${work}, as this install's agent, ${own}, is to: ` +
        'with two plists of one label, launchd loads either at login. If it\'s an old copy of this install\'s agent, ' +
        `unload it with launchctl bootout gui/${sys.uid} ${shellWord(path)} if launchctl print ` +
        `gui/${sys.uid}/${shellWord(label)} finds it, then remove that plist. Then repeat this service install command ` +
        'with the same recipe. Nothing was written.');
    }
    throw new Refusal(`${label} (${path}) is already set up to run from ${work}, and two hosts there would both ` +
      `serve its data. Inspect it with launchctl print gui/${sys.uid}/${shellWord(label)}. If it's an obsolete host, ` +
      `unload it with launchctl bootout gui/${sys.uid} ${shellWord(path)} if launchctl print finds it, then remove ` +
      'that plist. If it runs something other than a host, give it another working directory. Then repeat this ' +
      'service install command with the same recipe. Nothing was written.');
  }
}

async function removeUnit(ctx: CliContext, sys: ServiceSystem, env: Record<string, string>, manager: Manager,
  unit: ServiceUnit, work: string, cmd: string, recordedHere = false): Promise<boolean> {
  const text = readOr(unit.file);
  let runsIn = text === null ? (recordedHere ? realOrResolved(work) : undefined) : fileDirectory(sys, env, manager, unit, text);
  let live: boolean;
  if (manager === 'systemd-user') {
    const shown = showUnit(sys, env, unit.name, ['LoadState', 'ActiveState', 'WorkingDirectory']);
    if (typeof shown === 'string') throw new Refusal(`${shown}, so whether it runs another install can't be told.`);
    if ((runsIn === undefined || runsHere(runsIn, work)) && shown.get('LoadState') === 'loaded') {
      runsIn = runsFrom(shown.get('WorkingDirectory') ?? '', sys.home);
    }
    live = STOPPING.has(shown.get('ActiveState') ?? '');
  } else {
    const state = agentState(sys, env, unit);
    if (state.kind === 'unknown') {
      throw new Refusal(`Whether ${unit.name} is loaded can't be told: ${state.why}. It was left as it is.`);
    }
    live = state.kind !== 'unloaded';
  }
  if (runsIn === undefined) {
    if (live) {
      ctx.out(`${untold(sys, manager, unit)}, so it was left as it is. If it's this install's: ` +
        `${stopLine(sys, manager, unit.name)}.`);
    }
    return !live;
  }
  if (!runsHere(runsIn, work)) {
    if (live) {
      ctx.out(configConflict(unit, unit.file, runsIn, work, stopLine(sys, manager, unit.name)));
      return false;
    }
    ctx.out(`${unit.name} is stopped, and its config names ${runsIn ?? 'no working directory'}. ` +
      'This install no longer tracks it and left it as it is.');
    return true;
  }
  if (text === null && !live) return true;
  if (manager === 'systemd-user') {
    systemctl(sys, env, cmd, text === null ? ['stop', unit.name] : ['disable', '--now', unit.name]);
  } else if (live) {
    await bootout(ctx, sys, env, unit, `Repeat this service install command with the same recipe to finish removing the shell daemon.`);
  }
  if (text !== null) {
    ownedOrFree(unit, manager, work, sys, env, manager === 'systemd-user'
      ? `${unit.name} was already stopped and disabled. ` : live ? `${unit.name} was already unloaded. ` : '');
    rmSync(unit.file, { force: true });
  }
  ctx.out(text === null
    ? `Stopped ${unit.name}, which this install's service no longer has. Its unit file was already gone.`
    : `Stopped and removed ${unit.name}, which this install's service no longer has.`);
  return true;
}

function retainedShellNotice(ctx: CliContext, root: string, sys: ServiceSystem, env: Record<string, string>,
  manager: Manager, unit: ServiceUnit, cmd: string): void {
  let state = 'may still be running';
  if (manager === 'systemd-user') {
    const shown = showUnit(sys, env, unit.name, ['ActiveState']);
    if (typeof shown !== 'string') {
      const active = shown.get('ActiveState') ?? '';
      if (STOPPING.has(active)) state = 'is still running';
      else if (active === 'inactive' || active === 'failed') state = 'is not running now';
    }
  } else {
    const shown = agentState(sys, env, unit);
    if (shown.kind === 'running') state = 'is still running';
    else if (shown.kind !== 'unknown') state = 'is not running now';
  }
  ctx.out(`The shell unit ${unit.name} ${state}; it is still recorded in ${join(root, 'service.json')}. ` +
    `If it belongs to this install, stop it with ${stopLine(sys, manager, unit.name)}. ` +
    `${cmd} service start includes it while it remains recorded. Another ${cmd} service install retries retiring it.`);
}

async function bootout(ctx: CliContext, sys: ServiceSystem, env: Record<string, string>, unit: ServiceUnit,
  next: string): Promise<void> {
  const target = 'gui/' + sys.uid + '/' + unit.name;
  const ran = sys.run('launchctl', ['bootout', target], env);
  if (ran.status !== 0) {
    throw new Refusal('launchctl bootout ' + target + ' failed: ' + launchctlFailure(ran) + '. ' +
      next);
  }
  const started = sys.now();
  const until = started + READY_WAIT_MS;
  let waiting = false;
  for (;;) {
    const shown = sys.run('launchctl', ['print', target], env);
    if (shown.status === 113) return;
    if (shown.status !== 0) {
      throw new Refusal('launchctl print ' + target + ' failed: ' + launchctlFailure(shown) +
        '. Its stop was requested, but whether ' + unit.name + ' finished unloading cannot be told. ' + next);
    }
    if (sys.now() >= until) {
      throw new Refusal(unit.name + " hasn't finished unloading after " + READY_WAIT_MS / 1000 +
        ' s. Its stop was requested, but launchd still shows it. ' + next);
    }
    if (!waiting && sys.now() - started >= 1_000) {
      ctx.out('Waiting for ' + unit.name + ' to finish stopping.');
      waiting = true;
    }
    await sys.sleep(100);
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
  if (sys.which('node') === null) {
    throw new Refusal(`${SHELL_PACKAGE} is installed in ${work}, for the resident's shell, and its daemon runs on Node, ` +
      'but no node is on this PATH. Nothing was written.');
  }
  return resolve(pkg, bin);
}

function shellRunning(sys: ServiceSystem, manager: Manager, env: Record<string, string>,
  unit: ServiceUnit): boolean {
  if (manager === 'launchd') {
    const state = agentState(sys, env, unit);
    if (state.kind === 'unknown') {
      throw new Refusal(`Whether ${unit.name} is running, and so holds the stored SESSION_SERVER_PORT, can't be told: ` +
        `${state.why}. Nothing was written.`);
    }
    return state.kind === 'running';
  }
  const shown = showUnit(sys, env, unit.name, ['ActiveState']);
  if (typeof shown === 'string') {
    throw new Refusal(`${shown}, so whether it holds the stored SESSION_SERVER_PORT can't be told. Nothing was written.`);
  }
  return RUNNING.has(shown.get('ActiveState') ?? '');
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

function keepShellSettings(ctx: CliContext, sys: ServiceSystem, work: string, shell: ShellPlan,
  owned: ShellSettings): void {
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
  const keep = (name: keyof ShellSettings, value: string) => {
    try {
      writeEnvValue(file, name, value);
      owned[name] = value;
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

function dropShellSettings(ctx: CliContext, work: string, owned: ShellSettings,
  env: Record<string, string | undefined>, recorded: ShellSettings): void {
  const stored = new StoredSecrets(join(work, '.setup'));
  try {
    const current = readEnvFile(join(work, '.env'));
    const remove = SHELL_SETTING_NAMES.filter((name) => owned[name] !== undefined && current.get(name) === owned[name]);
    const keep = SHELL_SETTING_NAMES.filter((name) => current.has(name) && !remove.includes(name));
    const listed = stored.names();
    removeEnvValues(join(work, '.env'), remove, owned);
    const gone = SHELL_SETTING_NAMES.filter((name) => recorded[name] !== undefined && !current.has(name));
    const forgetting = [...new Set([...remove, ...gone])];
    const still = new Set(secretValues(forgetting, join(work, '.env'), env).map((secret) => secret.name));
    const forgot = forgetting.filter((name) => !still.has(name) && listed.includes(name));
    stored.forget(forgot);
    ctx.out('No shell daemon was set up: the recipe source names no shell client or shell setting.');
    if (remove.length > 0) ctx.out(`Removed ${remove.join(' and ')} from .env.`);
    for (const name of forgot) {
      ctx.out(`Forgot ${name} among setup's stored-secret names: no .env line, dotenv file beside it or environment ` +
        'value gives it now.');
    }
    for (const name of forgetting.filter((each) => still.has(each) && listed.includes(each))) {
      ctx.out(`Kept ${name} among setup's stored-secret names: another .env line, a dotenv file beside it or the ` +
        'environment still gives it.');
    }
    for (const name of keep) ctx.out(`Kept ${name} in .env: its current value isn't recorded as written by this service.`);
  } catch (error) {
    throw new Refusal("No shell daemon was requested, but its recorded settings couldn't be removed from .env and " +
      "setup's stored secrets: " + errorText(error));
  }
}

export function childEnv(sys: ServiceSystem): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(sys.env)) if (value !== undefined) env[key] = value;
  if (sys.platform === 'linux' && !env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = `/run/user/${sys.uid}`;
  return env;
}

function launchctlFailure(ran: Ran): string {
  return stderrOf({ ...ran, stderr: ran.stderr.split('\n').filter((line) =>
    line.trim() !== 'Try re-running the command as root for richer errors.').join('\n') });
}

function stderrOf(ran: Ran): string {
  return (ran.stderr.trim() || `exit ${ran.status}`).replace(/\.$/, '');
}

function systemctlLine(sys: ServiceSystem, args: string): string {
  return `${sys.env.XDG_RUNTIME_DIR ? '' : `XDG_RUNTIME_DIR=/run/user/${sys.uid} `}systemctl --user ${args}`;
}

function systemctl(sys: ServiceSystem, env: Record<string, string>, cmd: string, args: string[]): void {
  const ran = sys.run('systemctl', ['--user', ...args], env);
  if (ran.status !== 0) {
    throw new Refusal(`systemctl --user ${args.join(' ')} failed: ${stderrOf(ran)}. Run ` +
      `${cmd} service install again once that's put right.`);
  }
}

function pidOf(listed: string): string | undefined {
  return /"PID"\s*=\s*(\d+);/.exec(listed)?.[1];
}

export function servicePid(record: ServiceRecord, sys: ServiceSystem = machine(), env: Record<string, string> = childEnv(sys)):
  { pid: string } | { why: string } {
  if (record.manager === 'systemd-user') {
    const shown = showUnit(sys, env, record.units.host.name, ['MainPID']);
    return typeof shown === 'string' ? { why: shown } : { pid: shown.get('MainPID') ?? '0' };
  }
  const state = agentState(sys, env, record.units.host);
  if (state.kind === 'unknown') return { why: state.why };
  return { pid: state.kind === 'running' ? state.pid : '0' };
}

async function awaitReady(root: string, record: ServiceRecord, sys: ServiceSystem,
  env: Record<string, string>): Promise<HostReady | string> {
  const until = sys.now() + READY_WAIT_MS;
  const name = record.units.host.name;
  let first: string | undefined;
  let last = 'nothing answered';
  for (;;) {
    let host: HostClient | NoHost;
    try {
      host = await sys.openHost(root);
    } catch (error) {
      return `its host can't be reached: ${errorText(error)}`;
    }
    if (!('reason' in host)) {
      const ready = host.ready;
      host.close();
      const own = servicePid(record, sys, env);
      if ('why' in own) {
        return record.manager === 'systemd-user' ? own.why : `Whether ${name} runs the answering host can't be told: ${own.why}.`;
      }
      return own.pid === String(ready.pid) ? ready
        : `A host answers with pid ${ready.pid}, but ${name}'s main process is ${own.pid}. ` +
          "That answer doesn't establish that this service's host is ready.";
    }
    last = host.reason;
    if (record.manager === 'systemd-user') {
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
    if (sys.now() >= until) return `no host said it was ready within ${READY_WAIT_MS / 1000} s: ${last}.`;
    await sys.sleep(1_000);
  }
}

export function readServiceRecord(root: string, cmd = typedCommand(root)): ServiceRecord | null {
  const record = readServiceRecordFile(root, cmd);
  if (record !== null && !sameDirectory(record.workingDirectory, workingDirOf(root))) {
    throw new ContractError(`${foreignServiceWords(root, record)} ${recordAgain(cmd)}`);
  }
  return record;
}

function recordedDirectory(path: string): string | null {
  try {
    const value = (JSON.parse(readFileSync(path, 'utf-8')) as { workingDirectory?: unknown }).workingDirectory;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

function readServiceRecordFile(root: string, cmd: string, repair = true): ServiceRecord | null {
  const path = join(root, 'service.json');
  try {
    const record = readRecord<ServiceRecord>(path, 'service record');
    if (record === null) return null;
    const unit = (value: unknown) => typeof value === 'object' && value !== null &&
      typeof (value as ServiceUnit).name === 'string' && typeof (value as ServiceUnit).file === 'string';
    const logs = record.logs as { kind?: unknown; path?: unknown } | undefined;
    const fits = (record.manager === 'systemd-user' || record.manager === 'launchd') &&
      unit(record.units?.host) && (record.units.shell === undefined || unit(record.units.shell)) &&
      Array.isArray(record.hostArgs) && record.hostArgs.length > 0 && record.hostArgs.every((arg) => typeof arg === 'string') &&
      typeof record.workingDirectory === 'string' &&
      (logs?.kind === 'journal' || (logs?.kind === 'file' && typeof logs.path === 'string'));
    const settings = record.shellSettings;
    const settingsFit = settings === undefined || (settings !== null && typeof settings === 'object' && !Array.isArray(settings) &&
      SHELL_SETTING_NAMES.every((name) => settings[name] === undefined || typeof settings[name] === 'string'));
    if (!fits || !settingsFit) throw new ContractError(`The service record at ${path} doesn't hold a service record's fields.`);
    return record;
  } catch (error) {
    const why = error instanceof ContractError ? errorText(error)
      : `The service record at ${path} can't be read: ${errorText(error).replace(/\.+$/, '')}.`;
    const kind = lstatSync(path, { throwIfNoEntry: false });
    if (kind !== undefined && !kind.isFile()) {
      throw new ContractError(`${why} It isn't a file, so no install can write the record there: move it aside or ` +
        `take it away${repair ? `, then ${recordAgain(cmd).replace(/^N/, 'n').replace(/\.$/, '')}` : ''}.`);
    }
    throw new ContractError(`${why}${repair ? ' ' + recordAgain(cmd) : ''}`);
  }
}

export function serviceLines(root: string, path: string | undefined = process.env.PATH): string[] | null {
  const cmd = typedCommand(root, path);
  const record = readServiceRecord(root, cmd);
  if (record === null) return null;
  const host = record.units.host;
  const log = record.logs.kind === 'file' ? record.logs.path : join(record.workingDirectory, 'logs', 'agent.log');
  const systemd = record.manager === 'systemd-user';
  return [
    systemd ? `Its service is ${host.name}:` : `Its service is the launch agent ${host.name}:`,
    `  follow its log: ${systemd ? `journalctl --user -u ${host.name} -f` : `tail -f ${shellWord(log)}`}`,
    `  stop it${record.units.shell === undefined ? '' : ' and its shell daemon'}: ${cmd} service stop`,
    `  start it: ${cmd} service start`,
  ];
}

export async function checkService(root: string, sys: ServiceSystem = machine(), stoppedIsFine = false):
  Promise<{ passed: boolean; lines: string[]; stopped?: true }> {
  let record: ServiceRecord | null;
  try {
    record = readServiceRecord(root, typedCommand(root, sys.env.PATH));
  } catch (error) {
    return { passed: false, lines: [errorText(error)] };
  }
  if (record === null) {
    return { passed: false, lines: [`No service is recorded for this install (${join(root, 'service.json')}).`] };
  }
  return checkRecord(root, record, sys, stoppedIsFine);
}

async function checkRecord(root: string, record: ServiceRecord, sys: ServiceSystem, stoppedIsFine = false):
  Promise<{ passed: boolean; lines: string[]; stopped?: true }> {
  const cmd = typedCommand(root, sys.env.PATH);
  const lines: string[] = [];
  let passed = true;
  let stopped = false;
  const fail = (line: string) => {
    passed = false;
    lines.push(line);
  };
  const env = childEnv(sys);
  const workingDirectory = record.workingDirectory;
  let explained = false;
  let explainedGuess = false;
  const explain = () => {
    if (explained) return;
    lines.push(EXCERPT_LEAD);
    explained = true;
  };
  const showLog = (original: string, rendered: { text: string; guessed: string[] }, what: string,
    ended: boolean, scope?: string) => {
    if (rendered.guessed.length > 0 && !explainedGuess) {
      lines.push(guessedSecretsNotice(workingDirectory));
      explainedGuess = true;
    }
    logLines(original, rendered.text, what, lines, ended, explain, scope);
  };
  const log = (text: string, what: string, ended = false) => {
    let redact: ReturnType<typeof storedSecretRedactor>;
    try {
      redact = storedSecretRedactor(workingDirectory, sys.env, true, ['SESSION_SERVER_TOKEN']);
    } catch (error) {
      fail(`${what} isn't shown, since the install's secrets can't all be kept out of it: ${errorText(error)}`);
      return;
    }
    showLog(text, redact(text), what, ended);
  };
  const fileLog = (path: string, what: string, missing: string) => {
    let fd: number;
    try {
      fd = openSync(path, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      lines.push(missing);
      return;
    }
    try {
      let window: ReturnType<typeof storedSecretWindowRedactor>;
      try {
        window = storedSecretWindowRedactor(workingDirectory, sys.env, true, ['SESSION_SERVER_TOKEN']);
      } catch (error) {
        fail(`${what} isn't shown, since the install's secrets can't all be kept out of it: ${errorText(error)}`);
        return;
      }
      const { bytes, from, offset } = readLogTail(fd, window.contextBytes);
      const rendered = window.redact(bytes, from, bytes.length);
      const before = offset + rendered.start;
      const scope = before === 0 ? undefined : `${before} earlier file bytes are outside this window.`;
      showLog(bytes.toString('utf-8', rendered.start, rendered.end), rendered, what, true, scope);
    } finally {
      closeSync(fd);
    }
  };
  const secretLines = (what: string): number | null => {
    try {
      return storedSecretWindowRedactor(workingDirectory, sys.env, true, ['SESSION_SERVER_TOKEN']).contextLines;
    } catch (error) {
      fail(`${what} isn't shown, since the install's secrets can't all be kept out of it: ${errorText(error)}`);
      return null;
    }
  };
  const tail = (text: string, what: string, whole: boolean) => {
    if (whole) {
      log(text, what, true);
      return;
    }
    let window: ReturnType<typeof storedSecretWindowRedactor>;
    try {
      window = storedSecretWindowRedactor(workingDirectory, sys.env, true, ['SESSION_SERVER_TOKEN']);
    } catch (error) {
      fail(`${what} isn't shown, since the install's secrets can't all be kept out of it: ${errorText(error)}`);
      return;
    }
    const bytes = Buffer.from(text, 'utf-8');
    const rendered = window.redact(bytes, Math.max(0, linesStart(bytes, LOG_LINES, false)), bytes.length);
    showLog(bytes.toString('utf-8', rendered.start, rendered.end), rendered, what, true, 'Its earlier lines aren\'t shown.');
  };
  const latestStart = (unit: ServiceUnit, shown: Map<string, string>, active: boolean, whose: string):
    { invocation: string; started: string } | null => {
    const invocation = shown.get('InvocationID') ?? '';
    const stamp = shown.get('ExecMainStartTimestamp') ?? '';
    const utc = /^\w{3} (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/.exec(stamp);
    const seconds = utc === null ? NaN : Date.parse(`${utc[1]}T${utc[2]}Z`) / 1000;
    const started = Number.isFinite(seconds) ? String(seconds) : undefined;
    if (invocation === '' || started === undefined) {
      lines.push(`Its latest start isn't known, so its log isn't shown: journalctl --user -u ${unit.name} shows it.`);
      return null;
    }
    const read = (more: string[]) => sys.run('journalctl', ['--user', `_SYSTEMD_INVOCATION_ID=${invocation}`, '--since',
      `@${started}`, ...more, '-o', 'cat', '--no-pager'], env);
    if (active) {
      const logged = read(['--until', `@${Number(started) + FIRST_MINUTE_S}`]);
      if (logged.status !== 0) {
        fail(`Its log couldn't be read: journalctl --user failed: ${stderrOf(logged)}.`);
        return null;
      }
      log(logged.stdout, `The journal's lines from ${whose} in the first minute of its latest start`);
      return { invocation, started };
    }
    const what = `The journal's last lines from ${whose}'s latest start, which ended`;
    const context = secretLines(what);
    if (context === null) return { invocation, started };
    for (let asked = LOG_LINES + context; ; asked *= 2) {
      const logged = read(['-n', String(asked)]);
      if (logged.status !== 0) {
        fail(`Its log couldn't be read: journalctl --user failed: ${stderrOf(logged)}.`);
        return null;
      }
      const whole = (logged.stdout === '' ? 0 : logged.stdout.replace(/\n$/, '').split('\n').length) < asked;
      if (whole || tailHolds(logged.stdout, context)) {
        tail(logged.stdout, what, whole);
        return { invocation, started };
      }
    }
  };
  const units = unitsOf(record);
  let unseen = 0;
  for (const unit of units) {
    const state = pathState(unit.file);
    if (state === 'there') continue;
    unseen += 1;
    fail(state === 'gone' ? `${unit.file}, ${unit.name}'s ${fileOf(record.manager)}, is gone. ${serviceRepair(cmd)}`
      : `${unit.file}, ${unit.name}'s ${fileOf(record.manager)}, can't be looked at, so whether it's there can't be told: ` +
        `${state.why}. ${state.repair}`);
  }
  if (record.manager === 'systemd-user') {
    const shownAll = units.map((unit) => showUnit(sys, env, unit.name, ['LoadState', 'ActiveState', 'SubState',
      'NRestarts', 'ExecMainStartTimestamp', 'ExecMainStatus', 'Environment', 'WorkingDirectory', 'InvocationID',
      'ConditionResult', 'ConditionTimestamp', RESTART_PROPERTIES]));
    const skipped = (shown: Map<string, string>): boolean =>
      shown.get('ConditionResult') === 'no' && (shown.get('ConditionTimestamp') ?? '') !== '';
    stopped = stoppedIsFine && unseen === 0 && shownAll.every((shown) => typeof shown !== 'string' &&
      shown.get('LoadState') === 'loaded' && shown.get('ActiveState') === 'inactive' && !skipped(shown));
    for (const [index, unit] of units.entries()) {
      const shown = shownAll[index]!;
      if (typeof shown === 'string') {
        fail(`${shown}.`);
        continue;
      }
      if (shown.get('LoadState') !== 'loaded') {
        fail(RUNNING.has(shown.get('ActiveState') ?? '')
          ? `${unit.name} is running, but systemd can't load its unit (${shown.get('LoadState') ?? 'no load state'}), so ` +
            `which install it runs can't be told. If it's this install's, stop it ` +
            `(${stopLine(sys, record.manager, unit.name)}), then run ${cmd} service install again.`
          : `systemd has no ${unit.name} loaded (${shown.get('LoadState') ?? 'no load state'}): its unit file may be ` +
            `gone. Run ${cmd} service install again.`);
        continue;
      }
      const state = stateOf(shown);
      const active = shown.get('ActiveState') === 'active';
      const restarts = Number(shown.get('NRestarts') ?? '0');
      const restarted = `systemd has restarted it ${restarts} time${restarts === 1 ? '' : 's'} since it was last started`;
      if (active && restarts > 0) {
        lines.push(`${unit.name} is ${state} again: ${restarted}.`);
      } else {
        if (active) lines.push(`${unit.name} is ${state}.`);
        else if (skipped(shown)) {
          fail(`${unit.name} is ${state}: systemd skipped its last start, since a condition its unit or a drop-in sets ` +
            `wasn't met: \`systemctl --user status ${unit.name}\` names it.`);
        } else if (stopped) lines.push(`${unit.name} is stopped: systemd shows it ${state}.`);
        else if (unit === record.units.host) fail(`${unit.name} is ${state}, not active.`);
        else fail(`${unit.name} is ${state}, not active: journalctl --user -u ${unit.name} shows its log.`);
        const exited = active || (shown.get('ExecMainStartTimestamp') ?? '') === '' ? ''
          : `, and its process last exited with ${shown.get('ExecMainStatus') ?? '?'}`;
        lines.push(restarts > 0 ? `${restarted}${exited}.` : `systemd hasn't restarted it since it was last started${exited}.`);
      }
      if (unit !== record.units.host) {
        if (!active) latestStart(unit, shown, false, 'the shell daemon');
        continue;
      }
      const policy = restartPolicy(shown);
      if (!runsHere(runsFrom(shown.get('WorkingDirectory') ?? '', sys.home), record.workingDirectory)) {
        fail(`systemd runs ${unit.name} in ${shown.get('WorkingDirectory') || 'no set directory'}, not ${record.workingDirectory}.`);
      } else if (policy.restarts) {
        lines.push(`It restarts the host when it exits with ${RESTART_EXIT_CODE} and with 1 (${policy.settings}).`);
      } else {
        fail(`It doesn't restart the host both when it exits with ${RESTART_EXIT_CODE} and with 1 (${policy.settings}).`);
      }
      if (new RegExp(`(^|\\s)${SUPERVISED_ENV}=1(\\s|$)`).test(shown.get('Environment') ?? '')) {
        lines.push(`Its unit sets ${SUPERVISED_ENV}=1.`);
      } else {
        fail(`Its unit doesn't set ${SUPERVISED_ENV}=1: run ${cmd} service install again, which sets it once systemd ` +
          `shows the unit restarts the host on ${RESTART_EXIT_CODE} and 1.`);
      }
      const start = latestStart(unit, shown, active, 'the host');
      if (start !== null && restarts > 0 && active) {
        const context = secretLines('The journal\'s last lines about the newest earlier start it holds, which ended');
        if (context !== null) endedStart(sys, env, unit.name, start.invocation, start.started, context, lines, tail);
      }
    }
  } else {
    const states = units.map((unit) => agentState(sys, env, unit));
    stopped = stoppedIsFine && unseen === 0 && states.every((state) => state.kind === 'unloaded');
    for (const [index, unit] of units.entries()) {
      const state = states[index]!;
      if (stopped) {
        lines.push(`${unit.name} is stopped: launchd has it unloaded.`);
        continue;
      }
      if (state.kind === 'unknown') {
        fail(`Whether launchd has ${unit.name} loaded can't be told: ${state.why}.`);
        continue;
      }
      if (state.kind === 'unloaded') {
        fail(`launchd has no ${unit.name} loaded.`);
        continue;
      }
      const exit = state.kind === 'loaded' ? state.exit : undefined;
      if (state.kind === 'running') lines.push(`${unit.name} is running, pid ${state.pid}.`);
      else if (unit === record.units.host) {
        fail(`${unit.name} is loaded but not running${exit === undefined ? '' : `; it last exited with ${exit}`}.`);
      } else {
        const shellLog = join(record.workingDirectory, 'logs', 'shell.log');
        fail(`${unit.name} is loaded but not running${exit === undefined ? '' : `; it last exited with ${exit}`}. ` +
          `Its log is ${shellLog}.`);
        fileLog(shellLog, 'The last lines of the shell daemon\'s log file, which can hold earlier loads and more than one start',
          `Its log ${shellLog} isn't there.`);
      }
    }
    if (record.logs.kind === 'file') {
      fileLog(record.logs.path, 'The last lines of the host\'s log file, which can hold earlier loads and more than one start',
        `Its log ${record.logs.path} isn't there yet.`);
    }
  }
  return { passed, lines, ...(stopped && passed ? { stopped: true as const } : {}) };
}

function stateOf(shown: Map<string, string>): string {
  const [active, sub] = [shown.get('ActiveState') || '?', shown.get('SubState') || '?'];
  return sub === active ? active : `${active} (${sub})`;
}

export function showUnit(sys: ServiceSystem, env: Record<string, string>, name: string,
  properties: string[]): Map<string, string> | string {
  const timestamp = properties.includes('ExecMainStartTimestamp');
  // TZ and LC_ALL give show's default timestamp style in UTC, in C's words. systemctl's --timestamp= only exists
  // from systemd 247, which ignores it for show, and on 257 it changes nothing under them.
  const ran = sys.run('systemctl', ['--user', 'show', `--property=${properties.join(',')}`, '--', name],
    timestamp ? { ...env, TZ: 'UTC', LC_ALL: 'C' } : env);
  if (ran.status !== 0) {
    return `systemd couldn't be asked about ${name}: ${stderrOf(ran)} ` +
      `(${systemctlLine(sys, `show ${name}`)})`;
  }
  return new Map(ran.stdout.split('\n').filter((line) => line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
}

function endedStart(sys: ServiceSystem, env: Record<string, string>, name: string, invocation: string, started: string,
  context: number, lines: string[], tail: (text: string, what: string, whole: boolean) => void): void {
  for (let asked = LOG_LINES + context + 1; ; asked *= 2) {
    // --all: without it, journalctl's json gives a field over 4096 bytes as null.
    const ran = sys.run('journalctl', ['--user', '-u', name, '--until', `@${Number(started) + 1}`, '-n', String(asked),
      '-o', 'json', '--all', `--output-fields=MESSAGE,${INVOCATION_FIELDS.join(',')}`, '--no-pager'], env);
    if (ran.status !== 0) {
      lines.push(`Its start before the latest isn't shown: journalctl --user failed: ${stderrOf(ran)}.`);
      return;
    }
    const given = ran.stdout.split('\n').filter((line) => line.trim() !== '');
    const all = given.length < asked;
    let unread = 0;
    const entries = given.flatMap((line) => {
      try {
        const entry = JSON.parse(line) as Record<string, unknown> | null;
        const id = entry && INVOCATION_FIELDS.map((field) => entry[field]).find((value) => typeof value === 'string');
        if (typeof id === 'string' && typeof entry!.MESSAGE === 'string') return [{ id, message: entry!.MESSAGE }];
      } catch {}
      unread++;
      return [];
    });
    const latest = entries.findIndex((entry) => entry.id === invocation);
    const earlier = latest === -1 ? [] : entries.slice(0, latest);
    const ended = earlier.at(-1)?.id;
    const whole = all || earlier.some((entry) => entry.id !== ended);
    const its = earlier.filter((entry) => entry.id === ended).map((entry) => entry.message).join('\n');
    if (latest !== -1 && !all && (ended === undefined || (!whole && !tailHolds(its, context)))) continue;
    if (unread > 0) lines.push(`${unread} journal entr${unread === 1 ? 'y' : 'ies'} couldn't be interpreted; ` +
      'the earlier-start selection uses only the remaining entries.');
    const held = 'Its journal entries up to a second past its latest start';
    if (latest === -1) {
      lines.push(`${held} hold none of that start's, so which start ended before it can't be told.`);
      return;
    }
    if (ended === undefined) {
      lines.push(`${held} hold no earlier start of it.`);
      return;
    }
    tail(its, 'The journal\'s last lines about the newest earlier start it holds, which ended', whole);
    return;
  }
}

function tailHolds(text: string, context: number): boolean {
  const bytes = Buffer.from(text, 'utf-8');
  const at = linesStart(bytes, LOG_LINES, false);
  return at >= 0 && bytes.subarray(0, at).toString('utf-8').split('\n').length - 1 >= context;
}

function linesStart(bytes: Buffer, count: number, cut: boolean): number {
  let seen = 0;
  for (let end = bytes.length; ;) {
    const newline = end === 0 ? -1 : bytes.lastIndexOf(0x0a, end - 1);
    if (newline === -1 && cut) return -1;
    if (bytes.toString('utf-8', newline + 1, end).trim() !== '') seen++;
    if (seen === count) return newline + 1;
    if (newline === -1) return -1;
    end = newline;
  }
}

function logLines(original: string, text: string, what: string, lines: string[], ended: boolean,
  beforeExcerpt: () => void, scope?: string): void {
  const rendered = text.split('\n');
  const logged = original.split('\n').map((line, at) => ({ original: line, text: rendered[at]!,
    matches: REPORT_WORDS.test(line) })).filter(({ original }) => original.trim() !== '');
  if (logged.length === 0) {
    lines.push(`${what}: nothing.`);
    if (scope !== undefined) lines.push(`  ${scope}`);
    return;
  }
  beforeExcerpt();
  if (ended) {
    const hidden = Math.max(0, logged.length - LOG_LINES);
    lines.push(`${what}:`);
    if (scope !== undefined) lines.push(`  ${scope}`);
    if (hidden > 0) lines.push(`  ${hidden} earlier line${hidden === 1 ? '' : 's'} not shown.`);
    for (const line of logged.slice(hidden)) lines.push(`  | ${line.text}`);
    return;
  }
  const laterMatches = logged.slice(LOG_LINES).some((line) => line.matches);
  lines.push(laterMatches
    ? `${what}, with later lines matching error, fatal, failed, refused, or refuses:` : `${what}:`);
  const shown = logged.map((line, at) => at < LOG_LINES || line.matches);
  logged.forEach((line, at) => {
    if (shown[at]) lines.push(`  | ${line.text}`);
  });
  const hidden = shown.filter((each) => !each).length;
  if (hidden > 0) lines.push(`  ${hidden} more line${hidden === 1 ? '' : 's'} not shown.`);
}

function readLogTail(fd: number, contextBytes: number): { bytes: Buffer; from: number; offset: number } {
  const size = fstatSync(fd).size;
  let windowStart = 0;
  for (let step = TAIL_STEP_BYTES; ; step *= 2) {
    const start = Math.max(0, size - step);
    const at = linesStart(readAt(fd, start, size), LOG_LINES, start > 0);
    if (at >= 0) {
      windowStart = start + at;
      break;
    }
    if (start === 0) break;
  }
  const offset = Math.max(0, windowStart - contextBytes - 1);
  return { bytes: readAt(fd, offset, size), from: windowStart - offset, offset };
}

function readAt(fd: number, from: number, to: number): Buffer {
  const buffer = Buffer.alloc(to - from);
  let read = 0;
  while (read < buffer.length) {
    const count = readSync(fd, buffer, read, buffer.length - read, from + read);
    if (count === 0) break;
    read += count;
  }
  return buffer.subarray(0, read);
}

function readOr(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
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

function workingDirOf(root: string): string {
  return dirname(realpathSync(root));
}

function sameDirectory(a: string, b: string): boolean {
  try {
    const one = statSync(a, { bigint: true });
    const other = statSync(b, { bigint: true });
    return one.dev === other.dev && one.ino === other.ino;
  } catch {
    return false;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
