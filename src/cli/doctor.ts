import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compressionModelOf } from '../framework-strategy.js';
import { effectiveContextBudgetTokens, effectiveMaxTokens, startingTailTokens } from '../recipe-fit.js';
import { withoutHeartbeatMcpl } from '../heartbeat-options.js';
import { composeMcplChildEnv, loadMcplServers, openedBy, readAgentOverlay, serversForRecipe } from '../mcpl-config.js';
import {
  ENV_REFERENCE, loadRecipeDocument, readRecipeDocument, recipeDigest, recipeModel, resolveProvider,
  runningFit, unknownRecipeKeys, type Recipe, type RecipeDocument,
} from '../recipe.js';
import {
  PROVIDER_SECRETS, StoredSecrets, dotenvNames, dotenvReferences, envAssignments, linesKeepingSecrets, readSecrets,
  redactWindow, secretNames, storedSecrets,
  type Secret,
} from '../setup/secrets.js';
import { withSentForms } from '../setup/discord-token.js';
import { AGENT_OVERLAY_FILE_ENV, agentOverlayPath } from '../update/agent-overlay-path.js';
import { INSTALL_ROOT_ENV, SUPERVISED_ENV, realOrResolved } from '../update/contract.js';
import { shellWord } from '../update/launcher.js';
import type { CliContext } from './connectome.js';
import { BEFORE_ENV_FILE, checkDiscord, secretStep, tokenRoute } from './discord-check.js';
import { dataDirOf, openHost, type HostClient, type HostEvent, type NoHost } from './host-socket.js';
import { INSTALL_COMMAND, typedCommand } from './install-command.js';
import { checkUnits, heldWithoutFile, ownerProblem, pathState, servicePid, type ServiceCheck } from './doctor-service.js';
import {
  childEnv as serviceChildEnv, machine, managerOwner, namedElsewhere, recipeHasShell, serviceCommands, serviceLines, stopLine,
  systemctlLine, type ServiceCommands, type ServiceSystem,
} from './service.js';
import {
  managerFor, readUnit, serviceUnits, systemdWorkingDirectory, type Manager, type ServiceUnits,
} from './service-unit.js';

const LADDER = fileURLToPath(new URL('../../scripts/connectome-doctor', import.meta.url));
const LADDER_LIMIT_MS = 60_000;
const FINDINGS = 'connectome-doctor findings: ';
const GATE_DUMP = 'live gate dump (SIGUSR2): ';
const LADDER_WIDTH = 300;
const HOST_ANSWER_LIMIT_MS = 60_000;
const ENV_LIMIT_MS = 60_000;
const RECIPE_LIMIT_MS = 60_000;
const SYSTEM_VARIABLES = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'LANG', 'TMPDIR', 'XDG_RUNTIME_DIR'];
const CHECKS = {
  'count-check': 'the token counts', 'shell-check': 'the shell\'s call', health: 'the counts of its model calls',
} as const;
const SHORT_WORD = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const EMPTY_COMPRESSION = 'The recipe\'s agent.strategy.compressionModel is empty, so context-manager halts memory ' +
  'formation: it refuses an empty model. Leave it out to compress with the agent\'s model, or name one, and restart the ' +
  'service.';

export interface DoctorParts {
  fetch: typeof fetch;
  checkService: (units: ServiceUnits, work: string, shell: boolean | null | 'other', cmd: string, stoppedIsFine: boolean) =>
    Promise<ServiceCheck> | ServiceCheck;
  python: string | null;
  hostLimitMs: number;
  ladderLimitMs: number;
  systemctl: string;
  launchctl: string;
  envLimitMs: number;
  recipeLimitMs: number;
  plutil: string;
  launchdGives: () => Record<string, string>;
  servicePid: (units: ServiceUnits) => Promise<{ pid: string } | { why: string }> | { pid: string } | { why: string };
  platform: NodeJS.Platform;
  home: string;
  uid: number;
  owner: (path: string) => number;
}

type Server = {
  id: string; command?: unknown; args?: unknown; env?: unknown; inheritEnv?: unknown;
  transport?: unknown; url?: unknown; token?: unknown; access?: unknown;
};

class Report {
  problems = 0;

  constructor(
    private readonly print: (line: string) => void,
    readonly redact: (text: string, width?: number) => string,
  ) {}

  section(title: string): void {
    this.print('');
    this.print(this.redact(title));
  }

  line(text: string, width?: number): void {
    this.print(this.redact(`  ${text}`, width === undefined ? undefined : width + 2));
  }

  ok(text: string): void {
    this.line(`✓ ${text}`);
  }

  problem(text: string): void {
    this.problems += 1;
    this.line(`✗ ${text}`);
  }
}

export async function doctor(
  ctx: CliContext,
  parts: DoctorParts = {
    fetch,
    checkService: (units, work, shell, cmd, stoppedIsFine) =>
      checkUnits(units, work, shell, cmd, { ...machine(), run: limitedRun(ENV_LIMIT_MS) }, stoppedIsFine),
    python: Bun.which('python3'),
    hostLimitMs: HOST_ANSWER_LIMIT_MS,
    ladderLimitMs: LADDER_LIMIT_MS,
    systemctl: 'systemctl',
    launchctl: 'launchctl',
    envLimitMs: ENV_LIMIT_MS,
    recipeLimitMs: RECIPE_LIMIT_MS,
    plutil: 'plutil',
    launchdGives,
    servicePid: (units) => servicePid(units, { ...machine(), run: limitedRun(ENV_LIMIT_MS) }),
    platform: process.platform,
    home: homedir(),
    uid: process.getuid?.() ?? -1,
    owner: (path) => statSync(path).uid,
  },
): Promise<number> {
  if (ctx.argv.length > 0) {
    ctx.err('connectome: usage: connectome doctor');
    return 2;
  }
  const root = ctx.root!;
  const typed = typedCommand(root);

  const units = serviceUnits(root, parts.platform, parts.home);
  const base = machine();
  const sys: ServiceSystem = {
    ...base, platform: parts.platform, home: parts.home,
    run: limitedRun(parts.envLimitMs, (command) => command === 'plutil' ? parts.plutil : command === 'systemctl' ? parts.systemctl
      : command === 'launchctl' ? parts.launchctl : command),
  };
  if (asRootOfAnother(ctx, parts, root)) return 1;
  const found = findService(root, typed, units, sys, parts);
  const work = found.service?.work ?? units?.work ?? join(root, '..');
  const recipePath = found.service === null ? null
    : /^https?:\/\//.test(found.service.recipe) ? found.service.recipe : resolve(work, found.service.recipe);
  const r: Run = {
    ctx, parts, root, typed, units, sys, ...found, work, recipePath, recipeRead: await recipeAt(recipePath, parts),
    secrets: [...PROVIDER_SECRETS, 'DISCORD_TOKEN']
      .flatMap((name) => process.env[name] ? [{ name, value: process.env[name]! }] : []).flatMap(withSentForms),
    guessed: [], env: {}, storedNames: null, manager: units?.manager ?? managerFor(parts.platform), managerUnread: null,
    envFiles: [], refusedUnit: null, passedOver: [], recipeWarnings: [], recipeLoad: null, servers: null,
    serversError: null, report: null!, host: { reason: 'it wasn\'t asked', down: false }, stopped: false,
    serviceRuns: false, unitElsewhere: false, unitHere: false, fitUnchecked: false, fitEstimated: false, filesUnread: false,
    pidUntold: false, notTheService: false, uncredentialed: false, unanswered: false, closedTabs: false,
    shellUnchecked: false, shellBarred: false, uncounted: null, commands: null, startCommand: '', recordData: null,
    dataDir: null, dataNamer: '', counting: null, calls: null, recipe: null, uses: null, emptyCompressionSaid: false,
    unknown: '', closed: { closes: [], undecoded: 0 }, ladderRan: false, serviceNodeEnv: undefined,
  };
  if (!readEnvironment(r)) return 1;
  await loadRecipe(r);
  r.report = new Report(ctx.out, (text, width) => redacted(r, text, width));
  placeData(r);
  try {
    await serviceSection(r);
    await hostSection(r);
    ask(r);
    await recipeSection(r);
    await tokenCountsSection(r);
    await modelCallsSection(r);
    await serversSection(r);
    await discordSection(r);
  } finally {
    if (!('reason' in r.host)) r.host.close();
  }
  await channelsSection(r);
  ladderSection(r);
  return closingLine(r);
}

interface Run {
  ctx: CliContext;
  parts: DoctorParts;
  root: string;
  typed: string;
  units: ServiceUnits | null;
  sys: ServiceSystem;
  service: InstalledService | null;
  serviceError: string | null;
  elsewhere: boolean;
  managerSaid: boolean;
  shellElsewhere: string | null;
  work: string;
  recipePath: string | null;
  recipeRead: { document: RecipeDocument } | { error: unknown } | null;
  secrets: Secret[];
  guessed: string[];
  env: Record<string, string | undefined>;
  storedNames: string[] | null;
  manager: Manager | null;
  managerUnread: string | null;
  envFiles: string[];
  refusedUnit: string | null;
  passedOver: string[];
  serviceNodeEnv: string | undefined;
  recipeWarnings: string[];
  recipeLoad: { recipe: Recipe; persistable: Record<string, unknown> } | { error: unknown } | null;
  servers: Server[] | null;
  serversError: unknown;
  report: Report;
  host: HostClient | NoHost;
  stopped: boolean;
  serviceRuns: boolean;
  unitElsewhere: boolean;
  unitHere: boolean;
  fitUnchecked: boolean;
  fitEstimated: boolean;
  filesUnread: boolean;
  pidUntold: boolean;
  notTheService: boolean;
  uncredentialed: boolean;
  unanswered: boolean;
  closedTabs: boolean;
  shellUnchecked: boolean;
  shellBarred: boolean;
  uncounted: string | null;
  commands: ServiceCommands | null;
  startCommand: string;
  recordData: string | null;
  dataDir: string | null;
  dataNamer: string;
  counting: Promise<HostEvent | null> | null;
  calls: Promise<HostEvent | null> | null;
  recipe: Recipe | null;
  uses: Map<string, string[]> | null;
  emptyCompressionSaid: boolean;
  unknown: string;
  closed: { closes: GcClose[]; undecoded: number } | string;
  ladderRan: boolean;
}

type InstalledService = { units: ServiceUnits; recipe: string; work: string; bun: string };

function asRootOfAnother(ctx: CliContext, parts: DoctorParts, root: string): boolean {
  if (parts.uid === 0) {
    const dir = dirname(root);
    let owner: number | null = null;
    try {
      owner = parts.owner(dir);
    } catch {
      owner = null;
    }
    if (owner !== null && owner !== 0) {
      ctx.err(`connectome: ${dir} belongs to uid ${owner}, and doctor runs as root, so it would read root's service and ` +
        `service manager, not those of the user the resident runs as. Run \`${shellWord(join(root, INSTALL_COMMAND))} doctor\` as the ` +
        `user who owns ${dir}, without sudo.`);
      return true;
    }
  }
  return false;
}

function findService(root: string, typed: string, units: ServiceUnits | null, sys: ServiceSystem, parts: DoctorParts):
  { service: InstalledService | null; serviceError: string | null; elsewhere: boolean; managerSaid: boolean;
    shellElsewhere: string | null } {
  let service: InstalledService | null = null;
  let serviceError: string | null = null;
  let elsewhere = false;
  let managerSaid = false;
  let shellElsewhere: string | null = null;
  if (units !== null) {
    shellElsewhere = shellOfAnother(units, sys);
    let text: string | null = null;
    try {
      text = readFileSync(units.host.file, 'utf-8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        serviceError = `${units.host.file}, ${units.host.name}'s ${fileWord(units.manager)}, can't be read: ` +
          `${errorText(error).replace(/\.$/, '')}.`;
      }
    }
    if (text !== null) {
      const read = readUnit(units.manager, text);
      const other = namedElsewhere(sys, units.manager, units.host, units.work);
      if (other !== undefined) {
        elsewhere = true;
        serviceError = namesElsewhere(units.host.file, other.runsIn, units.work);
      } else if ('why' in read) {
        serviceError = `${units.host.file} isn't the ${fileWord(units.manager)} service install writes: ${read.why}.`;
      } else {
        const named = units.manager === 'systemd-user' ? systemdWorkingDirectory(text)! : read.workingDirectory;
        const runsIn = named === '~' ? parts.home : named;
        const launcher = join(root, 'start.js');
        if (read.argv[1] === undefined || resolve(runsIn, read.argv[1]) !== launcher || read.argv[2] === undefined) {
          // Bun's own flags before start.js, such as --env-file, change what the service reads, which doctor's
          // read of its environment wouldn't.
          serviceError = `${units.host.file} doesn't run this install's start.js, ${launcher}, right after its Bun, with a ` +
            'recipe after it, as the one service install writes does.';
        } else {
          service = { units, recipe: read.argv[2]!, work: runsIn, bun: read.argv[0]! };
        }
      }
    } else if (serviceError === null) {
      const env = serviceChildEnv(sys);
      const owner = managerOwner(units.host, units.manager, units.work, sys, env, false);
      const install = `\`${typed} service install <recipe>\``;
      const shellFile = pathState(units.shell.file);
      if (owner.kind === 'ok' && shellElsewhere === null && shellFile !== 'there' && shellFile !== 'gone') {
        shellElsewhere = `${units.shell.file}, ${units.shell.name}'s ${fileWord(units.manager)}, can't be looked at, and ` +
          `install reads it whatever the recipe: ${shellFile.why}. ${shellFile.repair}`;
      } else if (owner.kind === 'ok' && shellElsewhere === null && shellFile === 'gone') {
        shellElsewhere = ownerProblem(managerOwner(units.shell, units.manager, units.work, sys, env, false), units.shell,
          units.manager, units.work, sys, install);
      }
      serviceError = owner.kind === 'ok' && owner.held
        ? `${heldWithoutFile(units.host)}${shellElsewhere === null ? `: ${install} writes the file again.` : '.'} ` +
          `\`${systemctlLine(sys, `status ${units.host.name}`)}\` shows it, and \`${stopLine(sys, units.manager, units.host.name)}\` ` +
          'stops it if it runs.'
        : ownerProblem(owner, units.host, units.manager, units.work, sys, install);
      if (owner.kind === 'other') elsewhere = true;
      else managerSaid = serviceError !== null;
    }
  }
  return { service, serviceError, elsewhere, managerSaid, shellElsewhere };
}

async function recipeAt(recipePath: string | null, parts: DoctorParts):
  Promise<{ document: RecipeDocument } | { error: unknown } | null> {
  let recipeRead: { document: RecipeDocument } | { error: unknown } | null = null;
  if (recipePath !== null) {
    try {
      recipeRead = { document: await within(parts.recipeLimitMs, readRecipeDocument(recipePath),
        'the fetch of it didn\'t answer in time') };
    } catch (error) {
      recipeRead = { error };
    }
  }
  return recipeRead;
}

function redacted(r: Run, text: string, width?: number): string {
  const bytes = Buffer.from(text, 'utf-8');
  const replaced = new Set<string>();
  const hid = redactWindow(bytes, 0, bytes.length, r.secrets, replaced).text;
  const points = [...hid];
  const shown = width !== undefined && points.length > width ? `${points.slice(0, width).join('')}…` : hid;
  const hidden = r.guessed.filter((name) => replaced.has(name) || text.includes(`<${name}>`)).sort();
  if (hidden.length === 0) return shown;
  const mark = Buffer.from(` (it holds ${hidden.length === 1 ? 'a value' : 'values'} of ` +
    `${hidden.map((name) => `\`${name}\``).join(' and ')}, which doctor hides while the names list is missing, so it ` +
    'isn\'t shown as a command to run)', 'utf-8');
  return shown + redactWindow(mark, 0, mark.length, r.secrets, new Set()).text;
}

function readEnvironment(r: Run): boolean {
  const { ctx, parts, root, typed, units, sys, service, serviceError, elsewhere, managerSaid, work, recipePath,
    recipeRead, manager } = r;
  const banner = `connectome doctor: the install at ${root}`;
  try {
    r.storedNames = new StoredSecrets(join(work, '.setup')).read();
    const named = secretNames(join(work, '.setup'), join(work, '.env'));
    r.guessed = named.guessed;
    r.secrets = [...r.secrets,
      ...named.names.flatMap((name) => process.env[name] ? withSentForms({ name, value: process.env[name]! }) : [])];
    const known = (from: Record<string, string | undefined>, probes: Record<string, string | undefined>): Secret[] =>
      storedSecrets(work, from, probes);
    r.secrets = [...r.secrets, ...envAssignments(join(work, '.env'))
      .flatMap(({ name, value }) => value && named.names.includes(name) ? withSentForms({ name, value }) : [])];
    r.secrets = [...r.secrets, ...known(process.env, systemVariables()),
      ...readSecrets(named.names, join(work, '.env'), process.env, [])].flatMap(withSentForms);
    const document = recipeRead !== null && 'document' in recipeRead ? recipeRead.document : null;
    const names = [...named.names, 'MODEL', AGENT_OVERLAY_FILE_ENV, 'DISCORD_GUILD_ID', 'DISCORD_FILTERS_FILE', 'NODE_ENV',
      'BUN_OPTIONS', ...dotenvReferences(work), ...(document === null ? [] : namesIn(document))];
    const managedRead: Record<string, string> = {};
    let managed: Record<string, string> = {};
    let unread: unknown = null;
    try {
      managed = managerEnv(manager, names, parts, typed, sys, managedRead);
    } catch (error) {
      unread = error;
    }
    r.secrets = [...r.secrets,
      ...named.names.flatMap((name) => managedRead[name] ? withSentForms({ name, value: managedRead[name] }) : [])];
    if (unread !== null) {
      if (service !== null || (serviceError !== null && !elsewhere)) throw unread;
      r.managerUnread = unread instanceof ManagerUnread ? unread.step : errorText(unread);
    }
    const read = units === null || elsewhere || managerSaid || (service === null && serviceError === null) ? null
      : unitEnv(units, parts);
    const set = read?.env;
    if (set !== undefined) {
      r.secrets = [...r.secrets, ...named.names.flatMap((name) => set[name] ? withSentForms({ name, value: set[name] }) : [])];
    }
    if (read !== null && 'why' in read) {
      const { name, file } = units!.host;
      const why = read.why.replace(/\.$/, '');
      const anew = `${typed} service install ${recipePath === null ? '<recipe>' : shellWord(recipePath)}`;
      throw new Error(units!.manager === 'launchd'
        ? `${file}, ${name}'s plist, couldn't be read for the environment it sets the service (${why}). Fix it ` +
          `(\`plutil -lint ${shellWord(file)}\` says whether it parses), or move it aside and run \`${anew}\`, which writes it ` +
          'anew or says why it can\'t.'
        : `systemd didn't say the environment ${name} sets the service (${why}). Run ${typed} doctor again, or \`${anew}\` writes ` +
          'the unit anew or says why it can\'t.');
    }
    const unit = service === null ? null : read;
    r.envFiles = read === null ? [] : read.files;
    r.refusedUnit = service === null && read !== null ? units!.host.file : null;
    const given = { ...(manager === 'launchd' ? parts.launchdGives() : {}), ...managed };
    const built = serviceEnv(work, root, given, unit === null ? null : unit.env, parts.envLimitMs,
      service?.bun ?? process.execPath, typed, unit === null ? [] : unit.unset);
    r.env = built.env;
    r.serviceNodeEnv = built.base.NODE_ENV;
    r.passedOver = passedOverLines(work, root, given, unit === null ? null : unit.env, unit === null ? [] : unit.unset,
      built, manager, parts.envLimitMs, service?.bun ?? process.execPath, typed);
    const refusedHere = service === null && read !== null
      ? serviceEnv(work, root, given, read.env, parts.envLimitMs, process.execPath, typed, read.unset) : null;
    r.secrets = [...r.secrets, ...known(r.env, built.base), ...(refusedHere === null ? [] : known(refusedHere.env, refusedHere.base))]
      .flatMap(withSentForms)
      .filter((s, i, all) => all.findIndex((t) => t.name === s.name && t.value === s.value) === i);
  } catch (error) {
    ctx.out(redacted(r, banner));
    ctx.out(redacted(r, `  ✗ ${errorText(error)}`));
    ctx.out(redacted(r, 'Doctor stops here: it can\'t tell which values are secret, so it prints no check\'s output.'));
    return false;
  }
  ctx.out(redacted(r, banner));
  return true;
}

async function loadRecipe(r: Run): Promise<void> {
  const { parts, work, recipePath, recipeRead, env, recipeWarnings } = r;
  if (recipePath !== null) {
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { recipeWarnings.push(args.map(String).join(' ')); };
    try {
      if (recipeRead === null || 'error' in recipeRead) throw recipeRead?.error;
      r.recipeLoad = await within(parts.recipeLimitMs, loadRecipeDocument(recipeRead.document, recipePath, { env }),
        'the fetch of its system prompt didn\'t answer in time');
    } catch (error) {
      r.recipeLoad = { error };
    } finally {
      console.warn = warn;
    }
  }
  const recipeLoad = r.recipeLoad;
  if (recipeLoad !== null && !('error' in recipeLoad)) {
    try {
      const loaded = serversForRecipe(recipeLoad.recipe.mcpServers, join(work, 'mcpl-servers.json'), agentOverlayPath(work, env))
        .loaded as Server[];
      const heartbeat = recipeLoad.recipe.modules?.heartbeat;
      r.servers = heartbeat === undefined || heartbeat === false ? loaded
        : withoutHeartbeatMcpl(loaded, (line) => recipeWarnings.push(line));
      r.secrets = [...r.secrets, ...loaded.flatMap((server) => {
        const token = childEnv(server, env).DISCORD_TOKEN;
        return token && !new RegExp(`^${ENV_REFERENCE}$`).test(token)
          ? withSentForms({ name: 'DISCORD_TOKEN', value: token }) : [];
      })];
    } catch (error) {
      r.serversError = error;
    }
  }

}

function placeData(r: Run): void {
  const { root, sys, typed, service, env } = r;
  r.commands = serviceCommands(root, sys);
  r.startCommand = r.commands?.start ?? `${typed} service install <recipe>`;
  try {
    r.recordData = dataDirOf(root);
  } catch {}
  r.dataDir = service === null ? r.recordData : resolve(service.work, env.DATA_DIR || './data');
  r.dataNamer = service === null ? 'The install record names' : env.DATA_DIR ? 'The service\'s DATA_DIR names'
    : 'With no DATA_DIR in the service\'s environment, the host takes';
}

async function serviceSection(r: Run): Promise<void> {
  const { report, parts, typed, units, service, serviceError, elsewhere, managerSaid, shellElsewhere, recipeRead,
    manager, managerUnread, passedOver } = r;
  let { serviceRuns, unitElsewhere, unitHere, stopped } = r;
  if (managerUnread !== null) {
    const asked = manager === 'launchd' ? 'launchd' : 'systemd\'s user manager';
    report.line(`With no service installed, doctor asked ${asked}, which a service installed here would ` +
      `run under, and couldn't read it (${managerUnread.replace(/\.$/, '')}), so a value only that manager gives isn't ` +
      'known to doctor or hidden in what it prints.');
  }

  report.section('Service');
  if (serviceError !== null) {
    report.problem(elsewhere || managerSaid ? serviceError
      : `${serviceError} \`${typed} service install <recipe>\` writes it anew, or says why it can't.`);
  } else if (service === null) {
    report.problem(units === null
      ? `No service is installed for this install: \`${typed} service install\` writes one only on Linux and macOS, ` +
        'for a directory whose name has a letter or digit.'
      : `No service is installed for this install: ${units.host.file} isn't there.` +
        (shellElsewhere === null ? ` \`${typed} service install <recipe>\` writes one and checks it.` : ''));
  } else {
    const installed = service;
    await checked(report, 'The service check', async () => {
      const document = recipeRead !== null && 'document' in recipeRead ? recipeRead.document : null;
      const result = await parts.checkService(installed.units, installed.work, shellElsewhere !== null ? 'other'
        : document === null ? null : recipeHasShell(document.raw), typed, true);
      for (const line of result.lines) report.line(line);
      if (!result.passed) report.problem('The service check above didn\'t pass.');
      serviceRuns = result.passed && result.stopped !== true;
      unitElsewhere = result.elsewhere === true;
      unitHere = result.here === true;
      if (result.stopped === true) {
        stopped = true;
        report.line('It\'s stopped.');
      }
    });
    report.line(installed.units.manager === 'launchd'
      ? `Doctor reads the environment ${installed.units.host.file} gives as the plist is on disk, which launchd takes up ` +
        'only at the agent\'s next load, so a value changed there since then isn\'t what a running host has.'
      : 'Doctor reads the environment the unit gives as systemd last loaded it, so a value a daemon-reload took up ' +
        'after the host started isn\'t what a running host has.');
  }
  for (const line of passedOver) report.line(line);
  if (shellElsewhere !== null) report.problem(shellElsewhere);
  Object.assign(r, { serviceRuns, unitElsewhere, unitHere, stopped });
}

async function hostSection(r: Run): Promise<void> {
  const { report, parts, typed, root, sys, service, recordData, dataDir, dataNamer, serviceRuns, stopped, unitElsewhere,
    startCommand } = r;
  let { host, pidUntold, notTheService } = r;
  report.section('Host');
  if (service !== null && recordData !== null && !sameDirectory(dataDir!, recordData)) {
    report.problem(`The service's host keeps its data in ${dataDir}, not the install record's ${recordData}. The host makes ` +
      'its socket there, and this install\'s commands, doctor\'s host checks among them, look for it in the record\'s ' +
      `directory, so they can't reach it. Set the service's DATA_DIR to ${recordData}, or ask for help.`);
  }
  try {
    host = await openHost(root);
  } catch (error) {
    host = { reason: errorText(error), down: false };
  }
  if ('reason' in host && stopped && host.down) {
    report.line(`No host answers, since its service is stopped: \`${startCommand}\` starts it.`);
  } else if ('reason' in host) {
    report.problem(`No host answers: ${host.reason}.`);
    if (host.down && serviceRuns) {
      report.line(`The service is running, so its host may still be starting: run ${typed} doctor again in a minute. If it ` +
        'still doesn\'t answer then, its log says why.');
    }
    if (host.down && service !== null) {
      await checked(report, 'Naming the service\'s own lines', () => {
        for (const line of serviceLines(root, sys) ?? []) report.line(line);
      });
    }
  } else {
    const answering = host;
    let open = true;
    void answering.closed.then(() => { open = false; });
    const ownPid = async (): Promise<{ pid: string } | { why: string } | null> => {
      if (service === null) return null;
      try {
        return await parts.servicePid(service.units);
      } catch (error) {
        return { why: errorText(error) };
      }
    };
    // A close that comes while a synchronous read of the manager holds the event loop isn't seen until the loop
    // turns.
    const stillAnswers = async (): Promise<boolean> =>
      open && await answering.request({ type: 'describe' }, parts.hostLimitMs) !== null;
    const reread = async (pid: string): Promise<'holds' | 'changed' | { why: string }> => {
      const now = await ownPid();
      if (now !== null && 'why' in now) return now;
      return now !== null && now.pid === pid && await stillAnswers() ? 'holds' : 'changed';
    };
    const changed = () => {
      report.line(`A host answers, pid ${answering.ready.pid}, recipe ${answering.ready.recipe}, but the service's host ` +
        `changed during the check, so whether it's the service's can't be told: run ${typed} doctor again.`);
      pidUntold = true;
    };
    const findThenKill = (pid: number): string | null => service!.units.manager === 'systemd-user'
      ? `Run \`${systemctlLine(sys, `status ${pid}`)}\` first: where the host runs in a unit of this user's systemd, it ` +
        `names that unit. Then \`kill ${pid}\` stops it. If a host answers again, doctor's next run names its pid.`
      : null;
    const untold = (why: string) => {
      report.line(`The host answers: pid ${answering.ready.pid}, recipe ${answering.ready.recipe}. Whether it's the ` +
        `service's host can't be told: ${why.replace(/\.$/, '')}.`);
      pidUntold = true;
    };
    if (unitElsewhere) {
      untold('systemd runs the service\'s unit in another directory, said above, so its main process isn\'t compared with ' +
        'this host');
    } else if (stopped) {
      const now = await reread('0');
      if (now === 'changed') changed();
      else if (now !== 'holds') untold(now.why);
      else {
        notTheService = true;
        report.problem(`A host answers, pid ${answering.ready.pid}, recipe ${answering.ready.recipe}, though the service ` +
          'is stopped, so it isn\'t the service\'s: it was started some other way, such as by hand, and the checks below ' +
          `are of it. Stop it before \`${startCommand}\`, since a host the service starts takes this install's socket ` +
          `from one that holds it. ${findThenKill(answering.ready.pid) ?? `\`kill ${answering.ready.pid}\` stops it.`}`);
      }
    } else {
      const own = await ownPid();
      if (own !== null && 'pid' in own && own.pid !== String(answering.ready.pid)) {
        if (await reread(own.pid) !== 'holds') changed();
        else {
          notTheService = true;
          report.problem(`A host answers, pid ${answering.ready.pid}, recipe ${answering.ready.recipe}, but ` +
            `${own.pid === '0' ? `${service!.units.host.name} has no main process` : `${service!.units.host.name}'s main process is ${own.pid}`}, ` +
            'so it isn\'t the service\'s: it was started some other way, such as by hand, and the checks below are of ' +
            'it. Stop it, since a host the service starts takes this install\'s socket from one that holds it, and the ' +
            'service\'s own host can\'t be reached while it does' +
            (findThenKill(answering.ready.pid) === null ? `: \`kill ${answering.ready.pid}\` stops it.`
              : `. ${findThenKill(answering.ready.pid)}`));
        }
      } else if (own !== null && 'why' in own) {
        untold(own.why);
      } else {
        report.ok(`The host answers: pid ${answering.ready.pid}, recipe ${answering.ready.recipe}.`);
      }
    }
    answering.subscribe([]);
  }
  const dataState = dataDir === null ? null : pathState(dataDir);
  if (dataState === 'gone') {
    report.problem(`${dataNamer} ${dataDir} as the resident's data directory, and it isn't there. It holds ` +
      'the resident\'s history and memory, and a host started now would begin on an empty one, so put it back if you ' +
      'have it, or ask for help, before starting the service.');
  } else if (dataDir !== null && dataState === 'there' && statSync(dataDir, { throwIfNoEntry: false })?.isDirectory() === false) {
    report.problem(`${dataNamer} ${dataDir} as the resident's data directory, and it isn't a directory, so the ` +
      'host can\'t keep the resident\'s history and memory there. Put the data directory back there if you have it, or ask ' +
      'for help, before starting the service.');
  } else if (dataState !== null && dataState !== 'there') {
    report.problem(`${dataNamer} ${dataDir} as the resident's data directory, and it can't be looked at ` +
      `(${dataState.why}), so whether it's there can't be told. ${dataState.repair}`);
  }
  Object.assign(r, { host, pidUntold, notTheService });
}

function ask(r: Run): void {
  r.counting = asked(r, 'count-check');
  r.counting?.catch(() => {});
  r.calls = asked(r, 'health');
  r.calls?.catch(() => {});
}

function asked(r: Run, op: keyof typeof CHECKS): Promise<HostEvent | null> | null {
  const running = r.host;
  return 'reason' in running ? null : running.request({ type: 'panel-request', op }, r.parts.hostLimitMs);
}

async function read<T>(r: Run, op: keyof typeof CHECKS, answering: Promise<HostEvent | null> | null):
  Promise<{ data: T } | null> {
  const { report, parts, typed, commands } = r;
    if (answering === null) return null;
    const answer = await answering;
    if (answer === null) {
      report.problem(`The host didn't answer ${CHECKS[op]} within ${parts.hostLimitMs / 1000} s, or its connection ` +
        `closed first. Run ${typed} doctor again` + (commands === null ? '.' : `; \`${commands.log}\` follows the host's log.`));
      return null;
    }
    if (answer.ok !== true) {
      const error = String(answer.error ?? 'no reason given');
      report.problem(`The host refused ${CHECKS[op]}: ${error}.` + (!error.startsWith('unknown panel op') ? ''
        : ' The running host is an older release than this command, so it doesn\'t know this check: restarting the ' +
          `${commands === null ? 'host' : `service (\`${commands.stop}\`, then \`${commands.start}\`)`} starts it on this release.`));
      return null;
    }
    return { data: answer.data as T };
}

async function recipeSection(r: Run): Promise<void> {
  const { report, parts, service, recipeLoad, recipePath, recipeWarnings, env, counting } = r;
  let { recipe, uses, fitUnchecked, fitEstimated, emptyCompressionSaid } = r;
  report.section('Recipe');
  if (service === null) {
    report.line('Which recipe the service runs is in its unit, so it isn\'t checked without one.');
  } else if (recipeLoad !== null && !('error' in recipeLoad)) {
    recipe = recipeLoad.recipe;
    uses = namedOutsideServers(recipeLoad.persistable);
    report.ok(`${recipePath} loads.`);
    for (const line of recipeWarnings) report.line(line);
  } else {
    const error = recipeLoad?.error;
    report.problem(error instanceof Late ? `${recipePath} didn't load within ${parts.recipeLimitMs / 1000} s: ${error.message}.`
      : `${recipePath} doesn't load: ${errorText(error)}`);
    for (const line of recipeWarnings) report.line(line);
  }
  const loaded = recipe;
  if (loaded !== null) {
    await checked(report, 'The fit check', async () => {
      const model = recipeModel(loaded, env.MODEL);
      const counted = await besideOf(counting, model, effectiveContextBudgetTokens(loaded, model), startingTailTokens(loaded, model),
        recipeDigest(loaded));
      const fit = runningFit(loaded, env.MODEL, 'tokens' in counted ? counted.tokens : undefined);
      if (!fit.checked) {
        report.line(fit.line);
        fitUnchecked = true;
      } else if (!fit.fits) report.problem(fit.refusal);
      else if ('tokens' in counted && fit.spare !== undefined) {
        report.ok(`It fits ${model}'s window, with about ${n(fit.spare)} tokens left for the reply and for what modules add ` +
          `at each turn, by context-manager's estimate of the conversation: the system prompt and tools the host sends ` +
          `count ${n(counted.tokens)}.`);
        if (fit.spare < effectiveMaxTokens(loaded)) {
          report.line(`That's less than the ${n(effectiveMaxTokens(loaded))} tokens agent.maxTokens lets a reply take, so a ` +
            'reply that long wouldn\'t fit in what\'s left, by this estimate.');
        }
      } else {
        report.ok(`It fits ${model}'s window.`);
        if ('why' in counted) {
          if (counting !== null) fitEstimated = true;
          report.line(`The system prompt and tools the host sends weren't counted (${counted.why}), so this is the check the ` +
            'host makes at load, by estimate.');
        }
      }
    });
    if (compressionModelOf(loaded, recipeModel(loaded, env.MODEL)) === '') {
      report.problem(EMPTY_COMPRESSION);
      emptyCompressionSaid = true;
    }
  }
  Object.assign(r, { recipe, uses, fitUnchecked, fitEstimated, emptyCompressionSaid });
}

async function tokenCountsSection(r: Run): Promise<void> {
  const { report, host, counting, calls, recipe, work, emptyCompressionSaid, typed } = r;
  let { uncredentialed, unanswered } = r;
  report.section('Token counts');
  if ('reason' in host) report.line('count_tokens wasn\'t asked: that needs the host running.');
  else {
    await checked(report, 'The token counts', async () => {
      const answer = await read<CountCheck>(r, 'count-check', counting);
      if (answer !== null) {
        const onAnthropic = recipe !== null && resolveProvider(recipe) === 'anthropic';
        const refused = onAnthropic ? refusedCredential(credentialOf(await calls?.catch(() => null) ?? null))
          : { words: '', problem: true };
        countLines(report, answer.data, work, emptyCompressionSaid, onAnthropic, refused, typed);
        const sources = [answer.data.agent.source, answer.data.compression?.source];
        uncredentialed = sources.includes('count_tokens_no_credential');
        unanswered = sources.some((source) => source === 'count_tokens_timeout' || source === 'count_tokens_error');
      }
    });
  }
  Object.assign(r, { uncredentialed, unanswered });
}

async function modelCallsSection(r: Run): Promise<void> {
  const { report, host, calls, service, commands, notTheService, pidUntold, units, recipe } = r;
  let { uncounted } = r;
  report.section('Model calls');
  if ('reason' in host) report.line('The host\'s counts of its model calls weren\'t asked: that needs the host running.');
  else {
    await checked(report, 'The counts of its model calls', async () => {
      const answer = await read<unknown>(r, 'health', calls);
      const logged = service === null || commands === null || notTheService || pidUntold ? null : units;
      if (answer !== null) uncounted = callLines(report, agentCalls(answer.data), recipe?.agent.name, logged);
    });
  }
  Object.assign(r, { uncounted });
}

async function serversSection(r: Run): Promise<void> {
  const { report, host, commands, serviceError, service, serversError, work, env, servers, uses, storedNames, envFiles,
    refusedUnit } = r;
  let { closedTabs, shellUnchecked, shellBarred, filesUnread, unknown } = r;
  report.section('Servers');
  if ('reason' in host) report.line('The shell\'s real call wasn\'t made: that needs the host running.');
  else {
    await checked(report, 'The shell\'s call', async () => {
      const answer = await read<ShellCheck>(r, 'shell-check', asked(r, 'shell-check'));
      if (answer !== null) {
        shellLines(report, answer.data, commands);
        closedTabs = answer.data.closedTabs.length > 0;
        shellUnchecked = (answer.data.unchecked ?? []).length > 0;
        shellBarred = (answer.data.notAllowed ?? []).length > 0;
      }
    });
  }
  unknown = serviceError !== null
    ? 'which servers run is in the recipe the service\'s unit names, and doctor can\'t use that unit'
    : service === null ? 'which servers run is in the recipe the service\'s unit names, and there\'s no unit'
      : 'which servers run is in the recipe, which didn\'t load';
  if (serversError !== null) {
    report.problem(`The recipe's server list doesn't resolve: ${errorText(serversError)}`);
    unknown = 'the recipe\'s server list doesn\'t resolve';
  }
  await checked(report, 'The stored secrets\' check', () => {
    filesUnread = storedSecretLines(report, work, env, servers, uses, unknown, storedNames, envFiles, refusedUnit);
  });
  Object.assign(r, { closedTabs, shellUnchecked, shellBarred, filesUnread, unknown });
}

async function discordSection(r: Run): Promise<void> {
  const { report, parts, servers, unknown, env, work, typed, recipeRead, recipePath, serviceNodeEnv } = r;
  report.section('Discord');
  if (servers === null) report.line(`Discord isn't checked: ${unknown}.`);
  else {
    const named = servers.filter((s) => [s.command, ...(Array.isArray(s.args) ? s.args : [])]
      .some((part) => typeof part === 'string' && part.includes('discord-mcpl')));
    const discord = named.filter((s) => openedBy(s) === 'spawn');
    for (const server of named) {
      const opened = openedBy(server);
      if (opened === 'dial') {
        report.line(`${server.id} is dialed at its url, not started by the host, so its Discord bot isn't checked here.`);
      } else if (opened === null) report.line(`${server.id} isn't checked here, since the host refuses its entry.`);
    }
    if (named.length === 0) report.line('No server the recipe runs is Discord\'s.');
    const raw = recipeRead !== null && 'document' in recipeRead ? recipeRead.document.raw : null;
    const recipeServers = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as { mcpServers?: unknown }).mcpServers : undefined;
    const files = { recipe: recipePath!, servers: join(work, 'mcpl-servers.json'), overlay: agentOverlayPath(work, env) };
    for (const server of discord) {
      if (discord.length > 1) report.line(`The entry ${server.id}:`);
      try {
        const route = tokenRoute(server.id, {
          ...files,
          recipeServers: recipeServers !== null && typeof recipeServers === 'object' && !Array.isArray(recipeServers)
            ? recipeServers as Record<string, unknown> : {},
          fileServers: loadMcplServers(files.servers) as unknown as Array<{ id: string } & Record<string, unknown>>,
          overlayServers: readAgentOverlay(files.overlay),
          inheritEnv: server.inheritEnv === true,
        });
        const checked = await checkDiscord(childEnv(server, env), {
          fetch: parts.fetch, workingDir: work, command: typed, route, service: env,
          ...(serviceNodeEnv !== undefined ? { nodeEnv: serviceNodeEnv } : {}),
        });
        for (const line of checked.lines) report.line(line);
        report.problems += checked.problems.length;
      } catch (error) {
        report.problem(`The Discord check of ${server.id} failed: ${errorText(error)}`);
      }
    }
  }
}

async function channelsSection(r: Run): Promise<void> {
  const { report, work, typed } = r;
  const closed = await channelsClosed(join(work, 'logs', 'failures.log'));
  if (typeof closed === 'string' || closed.closes.length > 0 || closed.undecoded > 0) {
    report.section('Channels the subscription GC closed (logs/failures.log):');
    if (typeof closed === 'string') {
      report.line(`${join(work, 'logs', 'failures.log')} can't be read (${closed}), so which channels the subscription GC ` +
        `closed isn't shown. To see them, make it a file this user can read, then run ${typed} doctor again.`);
    }
    for (const close of typeof closed === 'string' ? [] : closed.closes) {
      report.line(`Channel ${close.channelId} was auto-closed at ${close.at}, over ${close.limitChars} characters of messages ` +
        'that didn\'t mention the resident since it last ran. If it\'s still closed, ask the resident to run its ' +
        `${close.restore} to reopen it; to stop it closing again, ask the resident to raise or turn off that channel's ` +
        'limit with its agent_settings tool (channel_idle_limits).');
    }
    if (typeof closed !== 'string' && closed.undecoded > 0) {
      report.line(`${closed.undecoded === 1 ? 'A line' : `${closed.undecoded} lines`} there name${closed.undecoded === 1 ? 's' : ''} ` +
        'a subscription-gc-close but can\'t be read as one, cut short or missing a field, so a channel ' +
        `${closed.undecoded === 1 ? 'it' : 'they'} would name may have been closed too.`);
    }
  }
  r.closed = closed;
}

function ladderSection(r: Run): void {
  const { report, parts, serviceError, service, unitHere, unitElsewhere, dataDir, work, secrets } = r;
  let tooOld: string | null = null;
  if (serviceError !== null) {
    report.section('The ladder reads the service\'s unit, so it doesn\'t run while doctor can\'t use that unit.');
  } else if (service === null) {
    report.section('The ladder reads the service\'s unit and log, so it runs once a service is installed.');
  } else if (service.units.manager !== 'systemd-user') {
    report.section('The ladder reads systemd\'s units and journal, so it doesn\'t run for this install, whose service ' +
      'runs under launchd.');
  } else if (!unitHere) {
    report.section('The ladder reads the service\'s journal and signals its main process, so it doesn\'t run while systemd ' +
      (unitElsewhere ? 'runs the service in another directory, said above: that process isn\'t this install\'s host.'
        : 'isn\'t seen running the service in this install\'s directory, said above: that process may not be this ' +
          'install\'s host.'));
  } else if (parts.python === null) {
    report.section('The pipeline ladder needs python3, which isn\'t on PATH. The checks above don\'t.');
  } else if ((tooOld = pythonOlderThan37(parts.python, parts.ladderLimitMs)) !== null) {
    report.section(`The pipeline ladder needs Python 3.7 or later, and python3 on PATH is ${tooOld}. The checks above don't.`);
  } else {
    report.section('Where an incoming message got to (scripts/connectome-doctor):');
    const ran = spawnSync(parts.python, [LADDER, '--findings-json', '--data-dir', dataDir!, work, service.units.host.name], {
      encoding: 'utf-8',
      timeout: parts.ladderLimitMs,
      env: {
        ...process.env,
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}`,
      },
    });
    r.ladderRan = true;
    const cut = ran.error !== undefined || ran.signal !== null;
    const breaks = Math.max(0, ...secrets.map(({ value }) => value.split('\n').length - 1));
    let dropped = 0;
    const linesOf = (text: string): string[] => {
      const lines = linesKeepingSecrets(text, secrets);
      if (cut) dropped += lines.splice(-(breaks + 1)).filter((line) => line !== '').length;
      return lines;
    };
    const said = linesOf(ran.stdout ?? '');
    const at = said.map((line) => line.startsWith(FINDINGS)).lastIndexOf(true);
    const findings = at < 0 ? null : said.splice(at, 1)[0].slice(FINDINGS.length);
    for (const line of [...said, ...linesOf(ran.stderr ?? '')]) {
      if (line !== '') report.line(line, line.startsWith(GATE_DUMP) ? undefined : LADDER_WIDTH);
    }
    if (dropped > 0) {
      report.line(`The ladder was ended, and doctor doesn't show ${dropped === 1 ? 'the line' : `the ${dropped} lines`} it ` +
        'printed last: a secret cut short there couldn\'t be hidden.');
    }
    if (ran.error !== undefined) {
      const timedOut = (ran.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
      report.problem(`The ladder didn't finish${timedOut ? ` within ${parts.ladderLimitMs / 1000} s` : `: ${ran.error.message}`}, ` +
        'so what it would have shown after the lines above isn\'t known.');
    } else if (ran.signal !== null) {
      report.problem(`The ladder was ended by ${ran.signal}, so what it would have shown after the lines above isn't known.`);
    } else if (ran.status !== 0) {
      report.problem(`The ladder stopped (exit ${ran.status}) before it finished, so what it would have shown after ` +
        'the lines above isn\'t known.');
    } else {
      try {
        for (const { text, counts } of ladderFindings(findings)) {
          if (counts) report.problem(text);
          else report.line(text);
        }
      } catch (error) {
        report.problem(`The ladder finished, but its findings can't be read: ${errorText(error)}.`);
      }
    }
  }
}

function closingLine(r: Run): number {
  const { ctx, report, host, uncounted, ladderRan, storedNames, filesUnread, fitUnchecked, fitEstimated, closed,
    uncredentialed, unanswered, closedTabs, pidUntold, shellUnchecked, shellBarred } = r;
  const unmade = [
    ...('reason' in host ? ['the host\'s checks weren\'t made'] : []),
    ...(uncounted === null ? [] : [`${uncounted}'s model calls weren't checked`]),
    ...(ladderRan ? [] : ['the ladder didn\'t run']),
    ...(storedNames === null ? ['it couldn\'t check the stored secrets'] : []),
    ...(filesUnread ? ['the files its unit reads its environment from weren\'t read'] : []),
    ...(fitUnchecked ? ['the fit wasn\'t checked'] : []),
    ...(fitEstimated ? ['the system prompt and tools weren\'t counted for the fit'] : []),
    ...(typeof closed === 'string' ? ['the channels the subscription GC closed couldn\'t be read'] : []),
    ...(typeof closed !== 'string' && closed.undecoded > 0
      ? ['a line naming a channel the subscription GC closed couldn\'t be read'] : []),
    ...(uncredentialed ? ['count_tokens had no credential to count with'] : []),
    ...(unanswered ? ['a count_tokens count got no answer it could read'] : []),
    ...(closedTabs ? ['a closed tab\'s connection wasn\'t checked'] : []),
    ...(pidUntold ? ['whether the host that answers is the service\'s couldn\'t be told'] : []),
    ...(shellUnchecked ? ['a shell server the host\'s session switch left unchecked'] : []),
    ...(shellBarred ? ['a shell server whose listSessions the recipe\'s agent may not call wasn\'t checked'] : []),
  ];
  ctx.out('');
  ctx.out(report.redact(report.problems > 0
    ? `Doctor found ${report.problems} problem${report.problems === 1 ? '' : 's'}, marked ✗.`
    : unmade.length === 0 ? 'Doctor found no problem.'
      : `Doctor found no problem, though ${unmade.length === 1 ? unmade[0] : `${unmade.slice(0, -1).join(', ')} and ` +
        unmade.at(-1)}, as said above.`));
  return report.problems === 0 ? 0 : 1;
}

interface GcClose { channelId: string; at: string; limitChars: number; restore: string }

async function channelsClosed(file: string): Promise<{ closes: GcClose[]; undecoded: number } | string> {
  const latest = new Map<string, GcClose>();
  let undecoded = 0;
  let handle;
  try {
    handle = await open(file, 'r');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { closes: [], undecoded } : errorText(error);
  }
  try {
    for await (const line of handle.readLines()) {
      if (!line.includes('"subscription-gc-close"')) continue;
      let record: Partial<Record<keyof GcClose | 'kind', unknown>>;
      try {
        record = JSON.parse(line);
      } catch {
        undecoded += 1;
        continue;
      }
      if (record?.kind === 'subscription-gc-close' && typeof record.channelId === 'string' && record.channelId !== '' &&
        typeof record.at === 'string' && typeof record.restore === 'string' && typeof record.limitChars === 'number') {
        latest.set(record.channelId, record as GcClose);
      } else if (record?.kind === 'subscription-gc-close') {
        undecoded += 1;
      }
    }
  } catch (error) {
    return errorText(error);
  } finally {
    await handle.close().catch(() => {});
  }
  return { closes: [...latest.values()], undecoded };
}

function ladderFindings(line: string | null): { text: string; counts: boolean }[] {
  if (line === null) throw new Error('it printed none');
  const findings: unknown = JSON.parse(line);
  if (!Array.isArray(findings) || !findings.every((f) => typeof f?.text === 'string' && typeof f.counts === 'boolean')) {
    throw new Error('they aren\'t a list of findings');
  }
  return findings;
}

async function checked(report: Report, what: string, body: () => Promise<void> | void): Promise<void> {
  try {
    await body();
  } catch (error) {
    report.problem(`${what} failed: ${errorText(error)}`);
  }
}

interface AgentCalls {
  name: string;
  failures: number;
  failedAt: number | undefined;
  startedAt: number | undefined;
  refusals: { total: number; lastAt: number; lastCategory: string } | null;
}

function agentCalls(data: unknown): AgentCalls[] {
  const agents = (data as { agents?: unknown } | null)?.agents;
  if (!Array.isArray(agents)) throw new Error('its answer has no list of agents');
  const time = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  return agents.map((agent: unknown) => {
    const { name, consecutiveInferenceFailures: failures, lastInference, refusalStats } = (agent ?? {}) as Record<string, unknown>;
    if (typeof name !== 'string' || typeof failures !== 'number' || !Number.isInteger(failures) || failures < 0) {
      throw new Error('an agent in its answer has no name or no count of failed turns');
    }
    const last = (lastInference ?? {}) as Record<string, unknown>;
    let refusals: AgentCalls['refusals'] = null;
    if (refusalStats !== null && refusalStats !== undefined) {
      const { total, lastAt, lastCategory } = refusalStats as Record<string, unknown>;
      if (typeof total !== 'number' || time(lastAt) === undefined || typeof lastCategory !== 'string') {
        throw new Error(`${name}'s refusal counts aren't of the form doctor reads`);
      }
      refusals = { total, lastAt: lastAt as number, lastCategory };
    }
    return { name, failures, failedAt: time(last.failedAt), startedAt: time(last.startedAt), refusals };
  });
}

function callLines(report: Report, agents: AgentCalls[], recipeAgent: string | undefined, logged: ServiceUnits | null): string | null {
  const named = recipeAgent || agents[0]?.name;
  const unlisted = named !== undefined && !agents.some((agent) => agent.name === named) ? named : null;
  if (unlisted !== null) report.line(`The host's counts list no agent named ${unlisted}.`);
  for (const agent of agents) {
    const refusals = agent.refusals !== null && agent.refusals.total > 0 ? agent.refusals : null;
    if (agent.name !== named && agent.failures === 0 && refusals === null) continue;
    if (agent.failures > 0) {
      const line = `[inference-failed] agent=${agent.name} consecutive=`;
      report.problem(`${agent.name}'s last turn's model call failed` +
        `${agent.failedAt === undefined ? '' : ` at ${new Date(agent.failedAt).toISOString()}`}, ${agent.failures} in a row. ` +
        `Each failure's reason is in a line of the host's stderr that starts \`${line}\`.` +
        (logged === null ? '' : ` The service keeps its host's stderr in its log, and \`${failureSearch(logged, line)}\` ` +
          'lists those lines.'));
    } else {
      report.ok(`${agent.name}: no failed turns in a row, by the host's counts.`);
    }
    if (refusals === null) continue;
    report.line(`${agent.name} was refused ${refusals.total} time${refusals.total === 1 ? '' : 's'} since this host started or ` +
      `last switched session, the last at ${new Date(refusals.lastAt).toISOString()}, ` +
      (refusals.lastCategory === 'unknown' ? 'with no category given.'
        : SHORT_WORD.test(refusals.lastCategory) ? `in the category ${refusals.lastCategory}.`
          : 'in a category the provider gave in other words.'));
    if (agent.startedAt !== undefined && refusals.lastAt >= agent.startedAt) {
      report.line(`${agent.name}'s newest turn met a refusal, and the host's counts don't show whether a retry in that turn then ` +
        'answered.');
    }
  }
  return unlisted;
}

function failureSearch(units: ServiceUnits, line: string): string {
  return units.manager === 'systemd-user'
    ? `journalctl --user -u ${shellWord(units.host.name)} | grep -F -- ${shellWord(line)}`
    : `grep -F -- ${shellWord(line)} ${shellWord(join(units.work, 'logs', 'agent.log'))}`;
}

interface CountCheck {
  agent: { model: string | null; countModel: string | null; source: string };
  compression: { model: string; countModel: string | null; source: string } | null;
  beside?: { tokens: number | null; source: string; error?: string };
  budget?: number | null;
  tail?: number | null;
  recipeDigest?: string;
}

interface ShellCheck {
  shells: Array<{ server: string; answered: true; sessions: number | null } | { server: string; answered: false; error: string }>;
  unchecked?: string[];
  notAllowed?: string[];
  notConnected: Array<{ id: string; retrying: boolean; refused: string | null }>;
  closedTabs: string[];
}

const REPLACE_CREDENTIAL = ' Replace that credential where the service gets it, and restart the service.';

type HostCredential =
  | { refused: { line: string; mends: boolean } }
  | { rotatable: boolean; expiresAt?: number }
  | { unread: string }
  | null;

function credentialOf(answer: HostEvent | null): HostCredential {
  if (answer === null) return { unread: 'the host didn\'t answer for its health' };
  if (answer.ok !== true) return { unread: `the host refused its health: ${String(answer.error ?? 'no reason given')}` };
  const data = answer.data as { credential?: Record<string, unknown>; credentialFailure?: unknown } | null;
  if (typeof data?.credentialFailure === 'string') return { unread: `reading it on the host failed: ${data.credentialFailure}` };
  const credential = data?.credential;
  if (credential === undefined) return null;
  const refused = credential?.refused as { line?: unknown; mends?: unknown } | undefined;
  if (typeof refused?.line === 'string' && typeof refused.mends === 'boolean') {
    return { refused: { line: refused.line, mends: refused.mends } };
  }
  if (typeof credential?.rotatable !== 'boolean') return { unread: 'the host\'s answer doesn\'t say' };
  const { rotatable, expiresAt } = credential;
  return { rotatable, ...(typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? { expiresAt } : {}) };
}

const AUTH_REFRESH = 'the host\'s `/auth refresh`, in its terminal or the Web UI\'s command box';

function refusedCredential(credential: HostCredential): { words: string; problem: boolean } {
  if (credential === null) return { words: REPLACE_CREDENTIAL, problem: true };
  if ('refused' in credential) return { words: ` ${credential.refused.line}`, problem: !credential.refused.mends };
  if ('unread' in credential) {
    return {
      words: ` Whether the host's credential can be refreshed can't be told, since ${credential.unread}. A credential with no ` +
        'refresh token needs replacing where the service gets it, and a restart of the service.',
      problem: true,
    };
  }
  if (!credential.rotatable) return { words: REPLACE_CREDENTIAL, problem: true };
  const expiry = credential.expiresAt === undefined ? ''
    : ` The host has its access token ${credential.expiresAt < Date.now() ? 'expired' : 'expiring'} at ` +
      `${new Date(credential.expiresAt).toISOString()}.`;
  return {
    words: ' The host\'s credential has a refresh token, but the host\'s answer doesn\'t say whether it refreshes it by itself, ' +
      `so whether its next model call is refused too can't be told. ${AUTH_REFRESH[0].toUpperCase()}${AUTH_REFRESH.slice(1)}, ` +
      `refreshes it.${expiry}`,
    problem: true,
  };
}
const NO_CREDENTIAL = 'count_tokens had no Anthropic credential to send: the host looks for its subscription login, ' +
  'then ANTHROPIC_AUTH_TOKEN, then ANTHROPIC_API_KEY, and has none.';

function countFailure(source: string): string {
  if (source === 'count_tokens_failed_401') {
    return 'count_tokens refused the credential the host sent (401): its subscription login when it has one, else ' +
      'ANTHROPIC_AUTH_TOKEN, else ANTHROPIC_API_KEY';
  }
  const status = /^count_tokens_failed_(\d+)$/.exec(source)?.[1];
  if (status !== undefined) return `count_tokens answered ${status}`;
  if (source === 'count_tokens_timeout') return 'the count_tokens request didn\'t answer within 30 s';
  if (source === 'count_tokens_error') {
    return 'the count_tokens request failed, or answered with what couldn\'t be read or with no count';
  }
  return source;
}

function countLines(report: Report, check: CountCheck, work: string, emptyCompressionSaid: boolean,
  onAnthropic: boolean, refused: { words: string; problem: boolean }, typed: string): void {
  const passes = (source: string) => (passesBy(source) ? ` That can pass by itself: run ${typed} doctor again later.` : '');
  const { agent, compression } = check;
  if (agent.source === 'count_tokens') report.ok(`count_tokens counts with ${agent.countModel}.`);
  else if (agent.source === 'count_tokens_no_credential') report.line(`${NO_CREDENTIAL} So the context's makeup shows no exact total.`);
  else if (agent.source === 'count_tokens_unsupported_model') {
    report.line(`count_tokens isn't asked: ${agent.model === null ? 'the agent names no model'
      : `${agent.model} isn't a Claude model it counts`}.`);
  } else {
    const said = `count_tokens couldn't count with ${agent.countModel}: ${countFailure(agent.source)}. So the ` +
      'context\'s makeup shows no exact total.' + (agent.source === 'count_tokens_failed_401' ? refused.words : '') +
      (agent.source !== 'count_tokens_failed_404' ? '' : ' A retired ' +
      'model answers 404, and the endpoint count_tokens asks (Anthropic\'s API, or the one ANTHROPIC_BASE_URL names) ' +
      'may answer it for a model it doesn\'t serve: set COUNT_TOKENS_MODEL in ' +
      `${join(work, '.env')} to a current Claude model, and restart the service, since the host reads it when it starts. ` +
      `${BEFORE_ENV}: where one sets it, set it there instead.`) + passes(agent.source);
    if (onAnthropic && agent.source === 'count_tokens_failed_401' && refused.problem) report.problem(said);
    else report.line(said);
  }
  if (compression === null) {
    report.line('No compression model is checked: the agent\'s strategy is passthrough, or an extension\'s that chooses its own.');
  } else if (compression.model === '') {
    if (!emptyCompressionSaid) report.problem(EMPTY_COMPRESSION);
  } else if (compression.source === 'count_tokens') report.ok(`count_tokens knows the compression model, ${compression.model}.`);
  else if (compression.source === 'count_tokens_no_credential') report.line(`${NO_CREDENTIAL} So the compression model, ${compression.model}, isn't checked.`);
  else if (compression.source === 'count_tokens_unsupported_model') {
    report.line(`The compression model, ${compression.model}, isn't a Claude model count_tokens counts, so it isn't checked.`);
  } else {
    report.line(`count_tokens couldn't count with the compression model, ${compression.model}: ` +
      `${countFailure(compression.source)}.` + (compression.source === 'count_tokens_failed_401' ? refused.words : '') +
      (compression.source !== 'count_tokens_failed_404' ? '' : ' A retired ' +
      'model answers 404, and with a retired compression model folding stalls and the context can\'t compress under ' +
      'the window: change the recipe\'s agent.strategy.compressionModel to a current model' +
      (agent.source !== 'count_tokens' || agent.countModel !== agent.model || compression.model === agent.model ? ''
        : ', or leave it out to compress with the agent\'s model,') +
      ' and restart the service. The endpoint count_tokens asks (Anthropic\'s API, or the one ANTHROPIC_BASE_URL names) ' +
      'may answer 404 for a model it doesn\'t serve too, and then the 404 doesn\'t mean it\'s retired.') +
      passes(compression.source));
  }
}

function passesBy(source: string): boolean {
  const status = Number(/^count_tokens_failed_(\d+)$/.exec(source)?.[1]);
  return source === 'count_tokens_timeout' || status === 429 || (status >= 500 && status < 600);
}

function shellLines(report: Report, shell: ShellCheck, commands: ServiceCommands | null): void {
  for (const server of shell.notConnected) {
    report.problem(`The server ${server.id} isn't connected` + (server.refused !== null
      ? `: the host refuses its configuration: ${server.refused}.`
      : `${server.retrying ? '; the host is still retrying it.' : ', and the host isn\'t retrying it.'} Its stderr is in the data ` +
        `directory, in sessions/<session>/mcpl-stderr/${basename(server.id)}.log.`));
  }
  for (const id of shell.closedTabs) {
    report.line(`The server ${id} is a closed tab: the host connects it when an agent opens it, so its connection isn't checked.`);
  }
  for (const id of shell.unchecked ?? []) {
    report.line(`The server ${id} wasn't checked: the host switched sessions during the check.`);
  }
  for (const id of shell.notAllowed ?? []) {
    report.line(`The server ${id} offers listSessions, but the recipe's agent may not call it, since its allowedTools ` +
      'leave it out, so its daemon wasn\'t checked.');
  }
  if (shell.shells.length === 0 && (shell.unchecked ?? []).length === 0 && (shell.notAllowed ?? []).length === 0) {
    const unchecked = [
      ...(shell.notConnected.length > 0 ? ['a server that isn\'t connected'] : []),
      ...(shell.closedTabs.length > 0 ? ['a closed tab'] : []),
    ];
    report.line(unchecked.length === 0
      ? 'No server offers listSessions, so there\'s no shell to call.'
      : `No connected server offers listSessions, so there's no shell to call; ${unchecked.join(' or ')} may be the shell.`);
  }
  for (const row of shell.shells) {
    if (row.answered) {
      report.ok(`${row.server} reached its daemon` + (row.sessions === null ? '.' : `: ${row.sessions} session${row.sessions === 1 ? '' : 's'}.`));
    } else if (row.error.includes('Connection lost') || row.error.includes('Connection timeout')) {
      report.problem(`${row.server} didn't reach its daemon: ${row.error}. On terminal-sessions 1.7.3, "Connection lost" ` +
        'is what a missing or wrong SESSION_SERVER_TOKEN in the server\'s env gives, and "Connection timeout" a daemon ' +
        'that isn\'t running.' + (row.error.includes('Connection lost')
        ? ' Where setup stored SESSION_SERVER_TOKEN, the stored-secrets lines below say whether a server is given it. Once ' +
          `the server's env names it, restart the service${commands === null ? '' : `: \`${commands.stop}\`, then \`${commands.start}\``}.`
        : commands !== null && commands.units.length > 1 ? ` \`${commands.start}\` starts the shell daemon with the host.` : ''));
    } else {
      report.problem(`${row.server}'s listSessions call failed: ${row.error}.`);
    }
  }
}

function storedSecretLines(
  report: Report,
  work: string,
  env: Record<string, string | undefined>,
  servers: Server[] | null,
  uses: Map<string, string[]> | null,
  unknown: string,
  names: string[] | null,
  envFiles: string[],
  refusedUnit: string | null,
): boolean {
  if (names === null) {
    const { guessed } = secretNames(join(work, '.setup'), join(work, '.env'));
    report.line(`There's no ${new StoredSecrets(join(work, '.setup')).file}, so which secrets setup stored isn't known and ` +
      'doctor can\'t check them' +
      (guessed.length === 0 ? '' : `, and it hides every value of a name setup doesn't know: ${[...guessed].sort().join(', ')}`) +
      '. Write it as a JSON list of the name of every secret, those in .env and any the host is given through its ' +
      'environment, and doctor checks them' +
      (guessed.length === 0 ? '.' : ' and shows the other values.'));
  }
  const inDotenv = new Set(dotenvNames(work));
  const provider: readonly string[] = PROVIDER_SECRETS;
  const mapped: string[] = [];
  let filesUnread = false;
  if (envFiles.length > 0) {
    report.line(`The service's unit also reads ${envFiles.join(' and ')}, whose values doctor can't see. Where one sets a ` +
      'stored secret that the unit\'s `UnsetEnvironment=` doesn\'t name, the service gets that value, not the unit\'s own ' +
      'or .env\'s, so doctor neither checks nor hides it.');
    filesUnread = true;
  }
  for (const name of names ?? []) {
    if (!env[name] && envFiles.length > 0) {
      report.line(`${name} is in setup's list of stored secrets and has no value in what doctor reads of the service's ` +
        `environment, but its unit also reads ${envFiles.join(' and ')}, whose values doctor can't see, so whether the ` +
        'service has one isn\'t known.');
      filesUnread = true;
    } else if (!env[name] && refusedUnit !== null) {
      report.line(`${name} is in setup's list of stored secrets and has no value in what doctor reads of the service's ` +
        `environment, but ${refusedUnit}, which doctor can't use, may set it, so whether the service has one isn't known.`);
    } else if (!env[name] && !inDotenv.has(name)) {
      report.problem(`${name} is in setup's list of stored secrets (${join(work, '.setup', 'stored-secrets.json')}), and ` +
        `no file Bun reads for the service gives it a value, ${join(work, '.env')} included: put it in ` +
        `${join(work, '.env')} and restart the service, or, if it isn't a secret, take it out of that list. ${BEFORE_ENV}: ` +
        'where one sets it empty, give it its value there.');
    } else if (!env[name]) {
      report.problem(`${name} is in setup's list of stored secrets and is empty in the service's environment: give it ` +
        `its value in ${join(work, '.env')} and restart the service. ${BEFORE_ENV}: where one sets it empty, give it its ` +
        'value there.');
    } else if (!provider.includes(name)) {
      mapped.push(name);
    }
  }
  const unchecked: string[] = [];
  for (const name of mapped) {
    const at = uses?.get(name) ?? [];
    if (at.length > 0) report.ok(`${name} is named in the recipe, at ${at.join(', ')}.`);
    if (servers === null) {
      if (at.length === 0) unchecked.push(name);
      continue;
    }
    const value = env[name];
    const reached = !value ? [] : servers.filter((s) => reaches(s, value, env));
    if (reached.length > 0) {
      report.ok(`${name} reaches ${reached.map((s) => s.id).join(', ')}.`);
    } else if (at.length === 0) {
      report.line(`${name} is in setup's list of stored secrets, and doctor finds no server given it: no server the host ` +
        `starts is given it in its env or args, no server it dials names it in its token or url, and the recipe names it ` +
        `nowhere outside its servers. ` + secretStep(name, name === 'DISCORD_TOKEN'));
    }
  }
  if (unchecked.length > 0) report.line(`Which servers see ${unchecked.join(', ')} isn't checked: ${unknown}.`);
  return filesUnread;
}

function namedOutsideServers(raw: Record<string, unknown>): Map<string, string[]> {
  const uses = new Map<string, string[]>();
  const ignored = new Set(unknownRecipeKeys(raw).map((key) => key.split(' (')[0]));
  const walk = (value: unknown, at: string): void => {
    if (ignored.has(at)) return;
    if (typeof value === 'string') {
      for (const [, name] of value.matchAll(new RegExp(ENV_REFERENCE, 'g'))) {
        const list = uses.get(name!) ?? [];
        if (!list.includes(at)) list.push(at);
        uses.set(name!, list);
      }
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${at}[${i}]`));
    } else if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) walk(item, `${at}.${key}`);
    }
  };
  for (const [key, value] of Object.entries(raw)) if (key !== 'mcpServers') walk(value, key);
  return uses;
}

function reaches(server: Server, value: string, env: Record<string, string | undefined>): boolean {
  const opened = openedBy(server);
  if (opened === 'spawn') {
    return [...Object.values(childEnv(server, env)), ...(Array.isArray(server.args) ? server.args : [])]
      .some((s) => typeof s === 'string' && s.includes(value));
  }
  if (opened !== 'dial') return false;
  return [server.token, server.url].some((s) => typeof s === 'string' && s.includes(value));
}

function childEnv(server: Server, env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(server.inheritEnv === true ? env : {})) {
    if (value !== undefined) out[name] = value;
  }
  return { ...out, ...composeMcplChildEnv(stringValues(server.env), '') };
}

const BEFORE_ENV = BEFORE_ENV_FILE[0]!.toUpperCase() + BEFORE_ENV_FILE.slice(1);

class Late extends Error {}

async function within<T>(limitMs: number, work: Promise<T>, late: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Late(late)), limitMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function namesIn(document: RecipeDocument): string[] {
  return [...JSON.stringify(document.raw).matchAll(new RegExp(ENV_REFERENCE, 'g'))].map(([, name]) => name!);
}

function failure(ran: SpawnSyncReturns<string>, limitMs: number): string | null {
  if (ran.error !== undefined) {
    return (ran.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? `it didn't answer within ${limitMs / 1000} s`
      : ran.error.message;
  }
  if (ran.status === 0) return null;
  return (ran.stderr ?? '').trim() || (ran.status === null ? `it was ended by ${ran.signal}` : `exit ${ran.status}`);
}

function limitedRun(limitMs: number, route: (command: string) => string = (command) => command): ServiceSystem['run'] {
  return (command, args, env) => {
    const ran = spawnSync(route(command), args, { encoding: 'utf-8', env, timeout: limitMs });
    return ran.error === undefined ? { status: ran.status, stdout: ran.stdout, stderr: ran.stderr }
      : { status: null, stdout: '', stderr: failure(ran, limitMs)! };
  };
}

class ManagerUnread extends Error {
  constructor(message: string, readonly step: string) {
    super(message);
  }
}

function managerEnv(manager: Manager | null, names: string[], parts: DoctorParts, typed: string,
  sys: Pick<ServiceSystem, 'env' | 'uid'>, out: Record<string, string> = {}): Record<string, string> {
  if (manager === 'systemd-user') {
    const ran = spawnSync(parts.systemctl, ['--user', 'show-environment'], {
      encoding: 'utf-8',
      timeout: parts.envLimitMs,
      env: { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}` },
    });
    const failed = failure(ran, parts.envLimitMs);
    if (failed !== null) {
      throw new ManagerUnread('systemctl --user show-environment failed, so what the user manager gives the service ' +
        `can't be read: ${failed}. Run \`${systemctlLine(sys, 'show-environment')}\` as this user to see why: it needs the user's ` +
        `manager running and XDG_RUNTIME_DIR naming its directory, as a login session sets it. Then run ${typed} doctor again.`,
        `\`systemctl --user show-environment\` failed: ${failed}`);
    }
    for (const line of ran.stdout.split('\n')) {
      const at = line.indexOf('=');
      if (at <= 0) continue;
      const value = line.slice(at + 1);
      out[line.slice(0, at)] = value.startsWith('$\'') && value.endsWith('\'') && value.length >= 3
        ? unquoted(value.slice(2, -1)) : value;
    }
  } else if (manager === 'launchd') {
    for (const name of new Set(names)) {
      const ran = spawnSync(parts.launchctl, ['getenv', name], { encoding: 'utf-8', timeout: parts.envLimitMs });
      const failed = failure(ran, parts.envLimitMs);
      if (failed !== null) {
        throw new ManagerUnread(`launchctl getenv ${name} failed, so what launchd gives the service can't be read: ${failed}. ` +
          `Run \`launchctl getenv ${name}\` as this user to see why, then run ${typed} doctor again.`,
          `\`launchctl getenv ${name}\` failed: ${failed}`);
      }
      if (ran.stdout !== '') out[name] = ran.stdout.endsWith('\n') ? ran.stdout.slice(0, -1) : ran.stdout;
    }
  }
  return out;
}

// systemctl show-environment prints a value holding a space, or a character the shell gives a meaning, as $'…', with a
// backslash before \ and ', and a control character, or a byte that isn't UTF-8, as C escapes it, \ooo where C has no
// letter for it (systemd v257, shell_maybe_quote and cescape_char in src/basic/escape.c).
function unquoted(text: string, also: Record<string, number> = {}): string {
  const named: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34, '\'': 39, ...also };
  const chars = Array.from(text);
  const bytes: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    const next = chars[i + 1];
    if (chars[i] === '\\' && next !== undefined && next in named) {
      bytes.push(named[next]!);
      i += 1;
    } else if (chars[i] === '\\' && /^[0-7]{3}$/.test(chars.slice(i + 1, i + 4).join(''))) {
      bytes.push(parseInt(chars.slice(i + 1, i + 4).join(''), 8));
      i += 3;
    } else {
      bytes.push(...Buffer.from(chars[i]!, 'utf-8'));
    }
  }
  return Buffer.from(bytes).toString('utf-8');
}

// systemctl show prints an Environment= entry holding a space, or a character the shell gives a meaning, in double
// quotes, with a backslash before \, ", $ and `, and a control character C-escaped (systemd 257, probed).
function shownWords(text: string): string[] {
  const words: string[] = [];
  for (let i = 0; i < text.length;) {
    if (text[i] === ' ') {
      i += 1;
    } else if (text[i] === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      words.push(unquoted(text.slice(i + 1, j), { $: 36, '`': 96 }));
      i = j + 1;
    } else {
      const end = text.indexOf(' ', i);
      words.push(text.slice(i, end < 0 ? text.length : end));
      i = end < 0 ? text.length : end;
    }
  }
  return words;
}

function unitEnv(service: ServiceUnits, parts: DoctorParts):
  { env: Record<string, string>; files: string[]; unset: string[] } | { why: string; env?: Record<string, string> } {
  const name = service.host.name;
  let ran: SpawnSyncReturns<string>;
  try {
    ran = service.manager === 'systemd-user'
      ? spawnSync(parts.systemctl, ['--user', 'show', '--property=Environment', '--property=UnsetEnvironment', '--', name], {
        encoding: 'utf-8',
        timeout: parts.envLimitMs,
        env: { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}` },
      })
      : spawnSync(parts.plutil, ['-extract', 'EnvironmentVariables', 'json', '-o', '-', service.host.file],
        { encoding: 'utf-8', timeout: parts.envLimitMs });
  } catch (error) {
    return { why: errorText(error) };
  }
  const failed = failure(ran, parts.envLimitMs);
  if (failed !== null) return { why: failed };
  if (service.manager === 'systemd-user') {
    // systemd 257 prints each property as its own `Name=value` line, in its own order, whatever the order asked.
    const out: Record<string, string> = {};
    const unset: string[] = [];
    for (const line of ran.stdout.split('\n')) {
      const at = line.indexOf('=');
      const words = at < 0 ? [] : shownWords(line.slice(at + 1).trim());
      if (line.startsWith('Environment=')) {
        for (const word of words) {
          const eq = word.indexOf('=');
          if (eq > 0) out[word.slice(0, eq)] = word.slice(eq + 1);
        }
      } else if (line.startsWith('UnsetEnvironment=')) unset.push(...words);
    }
    let listed: SpawnSyncReturns<string>;
    try {
      listed = spawnSync(parts.systemctl, ['--user', 'show', '--property=EnvironmentFiles', '--value', '--', name], {
        encoding: 'utf-8',
        timeout: parts.envLimitMs,
        env: { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}` },
      });
    } catch (error) {
      return { why: errorText(error), env: out };
    }
    const unlisted = failure(listed, parts.envLimitMs);
    if (unlisted !== null) return { why: unlisted, env: out };
    // systemd 257 prints each file on a line of its own, as `<path> (ignore_errors=no)`.
    const files = listed.stdout.split('\n').map((line) => line.replace(/ \(ignore_errors=(?:yes|no)\)$/, ''))
      .filter((line) => line !== '');
    return { env: out, files, unset };
  }
  try {
    return { env: stringValues(JSON.parse(ran.stdout)), files: [], unset: [] };
  } catch {
    return { why: 'plutil\'s answer wasn\'t JSON' };
  }
}

function systemVariables(): Record<string, string> {
  const base: Record<string, string> = {};
  for (const name of SYSTEM_VARIABLES) if (process.env[name] !== undefined) base[name] = process.env[name]!;
  return base;
}

// launchd gives each job HOME, USER, LOGNAME and SHELL from the user's account, whatever the environment of the shell
// that loads it, and TMPDIR as the user's own temporary directory (macOS 26). It gives a job others too, such as
// SSH_AUTH_SOCK, XPC_FLAGS and XPC_SERVICE_NAME, and a PATH, which install's plist sets over.
function launchdGives(): Record<string, string> {
  const user = userInfo();
  const gives: Record<string, string> = { HOME: user.homedir, USER: user.username, LOGNAME: user.username };
  if (user.shell) gives.SHELL = user.shell;
  const temporary = spawnSync('getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf-8' });
  if (temporary.status === 0 && temporary.stdout.trim() !== '') gives.TMPDIR = temporary.stdout.trim();
  return gives;
}

const relaunchedEnv = (root: string): string =>
  'const ran = Bun.spawnSync([process.execPath, "-e", "process.stdout.write(JSON.stringify(process.env))"], ' +
  `{ env: { ...process.env, ${JSON.stringify(INSTALL_ROOT_ENV)}: ${JSON.stringify(root)} }, stdout: "pipe", ` +
  'stderr: "inherit" }); require("node:fs").writeSync(1, ran.stdout); process.exit(ran.exitCode ?? 1);';

/** Bun loads .env, .env.local and the like in the working directory itself, filling only what the process doesn't
 *  have (Bun 1.4.4), so the host's environment is asked of Bun. */
function serviceEnv(work: string, root: string, manager: Record<string, string>, unit: Record<string, string> | null,
  limitMs: number, bun: string, typed: string, unset: string[] = []): { env: Record<string, string | undefined>; base: Record<string, string> } {
  const base = { ...manager };
  if (unit !== null) Object.assign(base, unit);
  else {
    base[SUPERVISED_ENV] = '1';
    try {
      base.DATA_DIR = dataDirOf(root);
    } catch {}
  }
  // UnsetEnvironment= takes a name, or one NAME=VALUE assignment, out of what the manager and the unit give, last.
  for (const entry of unset) {
    const eq = entry.indexOf('=');
    if (eq < 0) delete base[entry];
    else if (base[entry.slice(0, eq)] === entry.slice(eq + 1)) delete base[entry.slice(0, eq)];
  }
  const ran = spawnSync(bun, ['-e', relaunchedEnv(root)], {
    cwd: work,
    env: base,
    encoding: 'utf-8',
    timeout: limitMs,
  });
  if ((ran.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
    throw new Error(`Bun didn't finish reading the service's environment in ${work} within ${limitMs / 1000} s: something ` +
      `it runs as it starts, such as a bunfig.toml preload, didn't end. \`${shellWord(bun)} -e 0\`, run there, shows whether it ends, ` +
      'though with your shell\'s environment, not the service\'s.');
  }
  if (ran.error !== undefined) {
    throw new Error(`${bun === process.execPath ? 'Bun' : `${bun}, the Bun the service's unit runs,`} couldn't be run in ` +
      `${work} to read the service's environment: ${ran.error.message}.`);
  }
  if (ran.status !== 0) {
    throw new Error(`Bun ${ran.status === null ? `was ended by ${ran.signal}` : `exited ${ran.status}`} in ${work} as it read ` +
      `the service's environment, and its error isn't shown, since it can hold .env's values: run \`${shellWord(bun)} -e 0\` there to ` +
      'see it, though it runs with your shell\'s environment, not the service\'s.');
  }
  let env: Record<string, string>;
  try {
    env = JSON.parse(ran.stdout) as Record<string, string>;
  } catch {
    throw new Error(`Bun's answer in ${work} wasn't an environment doctor could read: something else wrote to its ` +
      `output, as a bunfig.toml preload can. \`${shellWord(bun)} -e 0\`, run there, shows what writes, though with your shell's ` +
      `environment, not the service's; once nothing does, run ${typed} doctor again.`);
  }
  env[INSTALL_ROOT_ENV] = root;
  base[INSTALL_ROOT_ENV] = root;
  return { env, base };
}

function passedOverLines(work: string, root: string, given: Record<string, string>, unit: Record<string, string> | null,
  unset: string[], built: { env: Record<string, string | undefined>; base: Record<string, string> }, manager: Manager | null,
  limitMs: number, bun: string, typed: string): string[] {
  const launchd = manager === 'launchd';
  const by = (name: string): string | null => !(name in built.base) ? null
    : unit !== null && name in unit ? (launchd ? 'the service\'s plist' : 'the service\'s unit')
    : name in given ? (launchd ? 'launchd\'s environment for this user' : 'the user manager\'s environment')
    : null;
  const without = (map: Record<string, string>, name: string) =>
    Object.fromEntries(Object.entries(map).filter(([each]) => each !== name));
  return dotenvNames(work).filter((name) => by(name) !== null).flatMap((name) => {
    let dotenv: Record<string, string | undefined>;
    try {
      dotenv = serviceEnv(work, root, without(given, name), unit === null ? null : without(unit, name), limitMs, bun, typed,
        unset).env;
    } catch {
      return [`${name} is set by ${by(name)} and by the dotenv files in ${work}, and whether the two values differ can't ` +
        'be told: doctor\'s read of those files without it failed.'];
    }
    return dotenv[name] === undefined || dotenv[name] === built.env[name] ? []
      : [`${name} is set by ${by(name)}, so the service gets that value, not the one the dotenv files in ${work} give it.`];
  });
}

function stringValues(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value === null || typeof value !== 'object') return out;
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
  }
  return out;
}

const n = (value: number): string => value.toLocaleString('en-US');

async function besideOf(
  counting: Promise<HostEvent | null> | null,
  model: string,
  budget: number,
  tail: number | undefined,
  digest: string,
): Promise<{ tokens: number } | { why: string }> {
  if (counting === null) return { why: 'no host answers' };
  let answer: HostEvent | null;
  try {
    answer = await counting;
  } catch (error) {
    return { why: `asking the host failed: ${errorText(error)}` };
  }
  if (answer === null) return { why: 'the host didn\'t answer its token counts' };
  if (answer.ok !== true) {
    return { why: String(answer.error ?? '').startsWith('unknown panel op')
      ? 'the running host is an older release than this command, so it doesn\'t count them'
      : 'the host refused its token counts' };
  }
  const data = answer.data as CountCheck;
  const beside = data.beside!;
  if (beside.source === 'count_tokens' && typeof beside.tokens === 'number') {
    if (typeof data?.agent?.model === 'string' && data.agent.model !== model) {
      return { why: `the running host runs ${data.agent.model}, not ${model}, so its count isn't of this recipe as it runs` };
    }
    if (typeof data?.budget === 'number' && data.budget !== budget) {
      return { why: `the running host's budget is ${n(data.budget)}, not the ${n(budget)} this recipe gives it, as agent ` +
        'settings or a change since its start can leave it' };
    }
    if (tail !== undefined && typeof data?.tail === 'number' && data.tail !== tail) {
      return { why: `the running host's recent window is ${n(data.tail)}, not the ${n(tail)} this recipe gives it, as agent ` +
        'settings or a change since its start can leave it' };
    }
    if (data?.recipeDigest !== digest) {
      return { why: 'the recipe doesn\'t load for doctor as it did for the running host: an edit since its start, a system ' +
        'prompt its URL now serves differently, or a value doctor\'s rebuilt environment gives otherwise can each leave it so' };
    }
    return { tokens: beside.tokens };
  }
  if (beside.source === 'preview_failed') {
    return { why: `the request a turn sends couldn't be built: ${beside.error ?? 'no reason given'}` };
  }
  if (beside.source === 'count_tokens_no_credential') return { why: 'count_tokens had no Anthropic credential to send' };
  if (beside.source === 'count_tokens_unsupported_model') return { why: 'count_tokens doesn\'t count with the agent\'s model' };
  if (beside.source === 'session_switched') {
    return { why: 'the host was switching sessions while it counted, or had switched since, so which session its count is of ' +
      'can\'t be told' };
  }
  return { why: countFailure(beside.source) };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameDirectory(a: string, b: string): boolean {
  try {
    return realOrResolved(a) === realOrResolved(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

function namesElsewhere(file: string, directory: string | null, work: string): string {
  return (directory === null
    ? `${file} names no directory it runs in, where install writes this install's, ${work}, so install takes it as ` +
      'another\'s, and doctor reads nothing from it.'
    : `${file} names ${directory} as the directory it runs in, not this install's, ${work}: it's another install's, ` +
      'or this one\'s from before it moved, and doctor reads nothing in that directory.') +
    ' Its name comes from this directory\'s name. Remove that unit if nothing uses it, or set this install up again in a ' +
    'directory of another name.';
}

function shellOfAnother(units: ServiceUnits, sys: ServiceSystem): string | null {
  const other = namedElsewhere(sys, units.manager, units.shell, units.work);
  return other === undefined ? null : namesElsewhere(units.shell.file, other.runsIn, units.work);
}

function pythonOlderThan37(python: string, limitMs: number): string | null {
  const ran = spawnSync(python, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf-8', timeout: limitMs });
  const version = ran.status === 0 ? /^(\d+)\.(\d+)$/.exec(ran.stdout.trim()) : null;
  if (version === null) return null;
  const [major, minor] = [Number(version[1]), Number(version[2])];
  return major < 3 || (major === 3 && minor < 7) ? `${major}.${minor}` : null;
}

function fileWord(manager: Manager): string {
  return manager === 'systemd-user' ? 'unit file' : 'plist';
}
