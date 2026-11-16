import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRecipeDocument, readRecipeDocument } from '../recipe.js';
import { checkDiscordToken } from '../setup/discord-token.js';
import { DISCORD_TOKEN, readEnvFile, shownByName, storedSecrets, type Secret } from '../setup/secrets.js';
import { installPaths } from '../update/contract.js';
import { RELEASE_HOST, shellWord } from '../update/launcher.js';
import { serviceBun } from '../update/service-bun.js';
import type { CliContext } from './connectome.js';
import { dataDirOf, openHost, type HostClient, type NoHost } from './host-socket.js';
import { INSTALL_COMMAND } from './install-command.js';
import { agentState, childEnv, showUnit, systemctlLine } from './service-manager.js';
import { machine, serviceCommands, type ServiceCommands, type ServiceSystem } from './service.js';
import { readUnit, serviceUnits, type ServiceUnit, type ServiceUnits } from './service-unit.js';

const LADDER = fileURLToPath(new URL('../../scripts/connectome-doctor', import.meta.url));
const HEALTH_WAIT_MS = 10_000;
const RECIPE_LIMIT_MS = 60_000;

export interface DoctorParts {
  sys: ServiceSystem;
  fetch: typeof fetch;
  openHost: (root: string) => Promise<HostClient | NoHost>;
  healthWaitMs: number;
  recipeLimitMs: number;
}

type Mark = '✓' | '✗' | '–';

class Report {
  problems = 0;
  unchecked = 0;

  constructor(private readonly print: (line: string) => void) {}

  line(text: string): void {
    this.print(text);
  }

  check(mark: Mark, text: string, next?: string): void {
    if (mark === '✗') this.problems += 1;
    if (mark === '–') this.unchecked += 1;
    this.print(`${mark} ${text}`);
    if (next !== undefined) this.print(`  Next: ${next}`);
  }
}

export async function doctor(
  ctx: CliContext,
  parts: DoctorParts = {
    sys: machine(),
    fetch,
    openHost: (root) => openHost(root),
    healthWaitMs: HEALTH_WAIT_MS,
    recipeLimitMs: RECIPE_LIMIT_MS,
  },
): Promise<number> {
  if (ctx.argv.length > 0) {
    ctx.err('connectome: usage: connectome doctor');
    return 2;
  }
  const root = ctx.root!;
  const work = dirname(root);
  const { sys } = parts;
  const typed = shellWord(join(root, INSTALL_COMMAND));
  if (sys.uid === 0) {
    let owner: number | null = null;
    try {
      owner = sys.owner(work);
    } catch {
      owner = null;
    }
    if (owner !== null && owner !== 0) {
      ctx.err(`connectome: ${work} belongs to uid ${owner}, and doctor runs as root, so it would read root's service ` +
        `and service manager, not those of the user the resident runs as. Run \`${shellWord(join(root, INSTALL_COMMAND))} ` +
        `doctor\` as the user who owns ${work}, without sudo.`);
      return 1;
    }
  }

  const envFile = join(work, '.env');
  let secrets: Secret[];
  let dotenv: Map<string, string>;
  try {
    secrets = storedSecrets(work, sys.env);
    dotenv = readEnvFile(envFile);
  } catch (error) {
    const report = new Report(ctx.out);
    report.line(`Checking the install at ${root}.`);
    report.check('✗', `Doctor can't read the stored secrets that it hides: ${errorText(error)}.`,
      'put right what it names, then run doctor again.');
    report.line('Doctor stops here and runs no check.');
    return 1;
  }
  const report = new Report((line) => ctx.out(shownByName(line, secrets)));
  report.line(`Checking the install at ${root}.`);

  const units = serviceUnits(root, sys.platform, sys.home);
  const commands = units === null ? null : serviceCommands(root, sys);
  const runs = checkService(report, sys, typed, units, commands);
  const host = await reachHost(report, parts, root, typed, units !== null, commands, runs);
  await checkRecipe(report, parts, root, host, units, commands, dotenv);
  await checkCalls(report, parts, host, units, commands);
  if (host !== null) host.close();
  await checkToken(report, parts, dotenv, typed, work);

  const unchecked = report.unchecked === 0 ? ''
    : ` ${report.unchecked} check${report.unchecked === 1 ? ' wasn\'t' : 's weren\'t'} made, marked –.`;
  report.line(report.problems === 0
    ? `Doctor found no problem.${unchecked}`
    : `Doctor found ${report.problems} problem${report.problems === 1 ? '' : 's'}, marked ✗.${unchecked}`);
  if (report.problems === 0 && units?.manager === 'systemd-user' && commands !== null) {
    report.line(`Where an incoming message stops, the ladder shows: ${ladderLine(sys, root, work, units.host)}`);
  }
  return report.problems === 0 ? 0 : 1;
}

function checkService(report: Report, sys: ServiceSystem, typed: string, units: ServiceUnits | null,
  commands: ServiceCommands | null): boolean | 'changing' | null {
  if (units === null) {
    report.check('–', 'Not checked: no service can be installed here.');
    return null;
  }
  if (commands === null) {
    report.check('✗', 'No service is installed for this install.', `\`${typed} service install <recipe>\``);
    return null;
  }
  const env = childEnv(sys);
  let hostRuns: boolean | 'changing' | null = null;
  for (const unit of [...commands.units].reverse()) {
    const state = unitState(sys, env, units, unit);
    const log = unit.name === units.host.name ? commands.log : units.manager === 'systemd-user'
      ? `journalctl --user -u ${unit.name} -f` : `tail -f ${shellWord(join(units.work, 'logs', 'shell.log'))}`;
    if ('unasked' in state) {
      report.check('✗', state.unasked, `ask it yourself, as the user who runs the resident: \`${state.question}\``);
    } else if (state.runs) {
      report.check('✓', `The service ${unit.name} runs.`);
    } else {
      report.check('✗', `The service ${unit.name} is ${state.state}.`, state.changing
        ? `systemd is changing its state now, so read its log with \`${log}\`, and run doctor again in a minute.`
        : `start it with \`${commands.start}\`, and read its log with \`${log}\`.`);
    }
    if (unit.name === units.host.name) hostRuns = 'unasked' in state ? null : state.changing ? 'changing' : state.runs;
  }
  return hostRuns;
}

function unitState(sys: ServiceSystem, env: Record<string, string>, units: ServiceUnits, unit: ServiceUnit):
  { runs: boolean; changing: boolean; state: string } | { unasked: string; question: string } {
  if (units.manager === 'systemd-user') {
    const shown = showUnit(sys, env, unit.name, ['ActiveState', 'SubState']);
    if (typeof shown === 'string') {
      return { unasked: shown, question: systemctlLine(sys, `show --property=ActiveState,SubState -- ${unit.name}`) };
    }
    const active = shown.get('ActiveState') ?? '';
    const sub = shown.get('SubState') ?? '';
    return {
      runs: active === 'active',
      changing: active !== 'active' && active !== 'inactive' && active !== 'failed',
      state: sub === '' ? active : `${active} (${sub})`,
    };
  }
  const state = agentState(sys, env, unit);
  if (state.kind === 'unknown') {
    return { unasked: `launchctl list ${unit.name} failed: ${state.why}`, question: `launchctl list ${unit.name}` };
  }
  if (state.kind === 'running') return { runs: true, changing: false, state: 'running' };
  return {
    runs: false,
    changing: false,
    state: state.kind === 'unloaded' ? 'not loaded'
      : `loaded and not running${state.exit === undefined ? '' : `, its last exit ${state.exit}`}`,
  };
}

async function reachHost(report: Report, parts: DoctorParts, root: string, typed: string, installable: boolean,
  commands: ServiceCommands | null, runs: boolean | 'changing' | null): Promise<HostClient | null> {
  let reached: HostClient | NoHost;
  try {
    reached = await parts.openHost(root);
  } catch (error) {
    reached = { reason: errorText(error), down: false };
  }
  if (!('reason' in reached)) {
    report.check('✓', `The host answers: pid ${reached.ready.pid}, recipe ${reached.ready.recipe}.`);
    return reached;
  }
  const bun = serviceBun(parts.sys.bun, parts.sys.env.PATH ?? '', parts.sys);
  const moved = movedDataDir(root, dirname(root));
  const next = !reached.down
    ? 'put right what that names, then run doctor again, or run it again in a minute if a host is still starting.'
    : !installable
    ? 'no service can be installed here, so start the host as this machine runs a program, from ' +
      `${dirname(root)}: \`${moved === null ? '' : `DATA_DIR=${shellWord(moved)} `}` +
      `${shellWord(bun)} ${shellWord(join(root, 'start.js'))} <recipe> --headless\``
    : commands === null ? `\`${typed} service install <recipe>\``
    : runs === true ? `it may still be starting, so run doctor again in a minute. Its log: \`${commands.log}\``
    : runs === 'changing' ? `it may be starting or stopping, so run doctor again in a minute. Its log: \`${commands.log}\``
    : runs === false ? `start the service with \`${commands.start}\`.`
    : 'its service manager couldn\'t be asked whether the service runs, so ask it as the line for the service says, ' +
      'then run doctor again.';
  report.check('✗', `No host answers: ${reached.reason}.`, next);
  return null;
}

async function checkRecipe(report: Report, parts: DoctorParts, root: string, host: HostClient | null,
  units: ServiceUnits | null, commands: ServiceCommands | null, dotenv: Map<string, string>): Promise<void> {
  if (host !== null) {
    report.check('✓', `The host loaded ${host.ready.recipe} when it started.`);
    return;
  }
  if (units === null || commands === null) {
    report.check('–', 'Not checked: the service\'s unit names the recipe, and no service is installed.');
    return;
  }
  let text: string;
  try {
    text = readFileSync(units.host.file, 'utf-8');
  } catch (error) {
    report.check('–', `Not checked: the service's unit isn't one that doctor can read the recipe from: ${errorText(error)}.`);
    return;
  }
  const read = readUnit(units.manager, text);
  const named = 'why' in read ? undefined : read.argv[2];
  if ('why' in read || named === undefined) {
    report.check('–', 'Not checked: the service\'s unit isn\'t one that doctor can read the recipe from: ' +
      `${'why' in read ? read.why : 'it names no recipe after start.js'}.`);
    return;
  }
  const recipe = /^https?:\/\//.test(named) ? named
    : resolve(read.workingDirectory === '~' ? parts.sys.home : read.workingDirectory, named);
  let dataDir: string;
  try {
    dataDir = dataDirOf(root);
  } catch {
    report.check('–', 'Not checked: the install record can\'t be read, as the host\'s line says, so the data directory the ' +
      'service starts the host with isn\'t known.');
    return;
  }
  const env = { ...Object.fromEntries(dotenv), ...parts.sys.env, DATA_DIR: dataDir };
  try {
    await within(parts.recipeLimitMs, (async () => {
      const document = await readRecipeDocument(recipe);
      await loadRecipeDocument(document, recipe, { env });
    })());
    report.check('✓', `${recipe} loads.`);
  } catch (error) {
    if (error instanceof TooLong) {
      report.check('–', `Not checked: ${recipe} ${error.message}, so whether it loads isn't known.`,
        'run doctor again: the recipe, or a system prompt it names by URL, may be slow to answer.');
      return;
    }
    report.check('✗', `${recipe} doesn't load: ${errorText(error)}.`,
      `correct it, then start the service with \`${commands.start}\`.`);
  }
}

interface AgentCounts {
  name: string;
  failures: number;
  lastCall: number | null;
  failedAt: number | null;
  refusals: { total: number; lastAt: number } | null;
}

async function checkCalls(report: Report, parts: DoctorParts, host: HostClient | null, units: ServiceUnits | null,
  commands: ServiceCommands | null): Promise<void> {
  if (host === null) {
    report.check('–', 'Not checked: the model calls need the host running.');
    return;
  }
  host.subscribe([]);
  const answer = await host.request({ type: 'panel-request', op: 'health' }, parts.healthWaitMs);
  let agents: AgentCounts[];
  try {
    if (answer === null) throw new Error(`no answer came within ${parts.healthWaitMs / 1000} s`);
    if (answer.ok !== true) throw new Error(String(answer.error ?? 'the host gave no reason'));
    agents = countsOf(answer.data);
  } catch (error) {
    report.check('–', `Not checked: the host didn't give its counts of model calls: ${errorText(error)}.`);
    return;
  }
  const named = host.ready.agent ?? agents[0]?.name;
  if (named === undefined || !agents.some((agent) => agent.name === named)) {
    report.check('–', named === undefined ? 'Not checked: the host\'s counts list no agent.'
      : `Not checked: the host's counts list no agent named ${named}.`);
  }
  for (const agent of agents) {
    if (agent.name !== named && agent.failures === 0 && agent.refusals === null) continue;
    if (agent.failures > 0) {
      const at = agent.failedAt === null ? '' : `, the latest at ${iso(agent.failedAt)}`;
      report.check('✗', agent.failures === 1
        ? `${agent.name}'s last turn failed at the model call${at}.`
        : `${agent.name}'s last ${agent.failures} turns failed at the model call${at}.`,
        `each failure's reason is in the host's log, in a line that starts \`[inference-failed] agent=${agent.name}\`. ` +
        'They can quote the model provider, so doctor doesn\'t print them' + failureSearch(units, commands, agent.name));
    } else if (agent.lastCall === null) {
      report.check('–', `${agent.name} has made no model call since this host started or last switched session.`);
    } else {
      report.check('✓', `${agent.name}: no failed model call in a row.`);
    }
    if (agent.refusals !== null) {
      report.line(`  ${agent.name} was refused ${agent.refusals.total} time${agent.refusals.total === 1 ? '' : 's'} since ` +
        `this host started or last switched session, the last at ${iso(agent.refusals.lastAt)}.`);
    }
  }
}

function countsOf(data: unknown): AgentCounts[] {
  const agents = (data as { agents?: unknown } | null)?.agents;
  if (!Array.isArray(agents)) throw new Error('its answer has no list of agents');
  const time = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
  return agents.map((agent: unknown) => {
    const { name, consecutiveInferenceFailures: failures, lastInference, refusalStats } = (agent ?? {}) as Record<string, unknown>;
    if (typeof name !== 'string' || typeof failures !== 'number' || !Number.isInteger(failures) || failures < 0) {
      throw new Error('an agent in its answer has no name or no count of failed turns');
    }
    const last = lastInference !== null && typeof lastInference === 'object' ? lastInference as Record<string, unknown> : null;
    const refused = refusalStats !== null && typeof refusalStats === 'object' ? refusalStats as Record<string, unknown> : null;
    const total = refused?.total;
    const lastAt = time(refused?.lastAt);
    return {
      name,
      failures,
      lastCall: last === null ? null : time(last.startedAt),
      failedAt: last === null ? null : time(last.failedAt),
      refusals: typeof total === 'number' && total > 0 && lastAt !== null ? { total, lastAt } : null,
    };
  });
}

function failureSearch(units: ServiceUnits | null, commands: ServiceCommands | null, agent: string): string {
  if (units === null || commands === null) return '.';
  const line = `[inference-failed] agent=${agent} `;
  return units.manager === 'systemd-user'
    ? `: \`journalctl --user -u ${units.host.name} --no-pager | grep -F -- ${shellWord(line)}\` lists them.`
    : `: \`grep -F -- ${shellWord(line)} ${shellWord(join(units.work, 'logs', 'agent.log'))}\` lists them.`;
}

async function checkToken(report: Report, parts: DoctorParts, dotenv: Map<string, string>, typed: string,
  work: string): Promise<void> {
  const token = dotenv.get(DISCORD_TOKEN) ?? '';
  if (token === '') {
    report.check('–', `Not checked: .env holds no ${DISCORD_TOKEN}.`);
    return;
  }
  const store = 'store the bot token from the Developer Portal\'s Bot page with ' +
    `\`${typed} setup discord\`, which stores it in ${join(work, '.env')}, then restart the service and run ` +
    `\`${typed} doctor\` again.`;
  const check = await checkDiscordToken(token, parts.fetch);
  if (check.kind === 'accepted') report.check('✓', 'Discord accepts the token.');
  else if (check.kind === 'refused') report.check('✗', `The token in .env isn't accepted: ${check.why}.`, store);
  else report.check('–', `Discord gave no answer that doctor could read: ${check.why}.`);
}

function movedDataDir(root: string, work: string): string | null {
  let dataDir: string;
  try {
    dataDir = dataDirOf(root);
  } catch {
    return null;
  }
  return resolve(dataDir) !== join(work, 'data') ? dataDir : null;
}

function ladderLine(sys: ServiceSystem, root: string, work: string, unit: ServiceUnit): string {
  const dataDir = movedDataDir(root, work);
  const current = installPaths(root).current;
  const ladder = existsSync(current) ? join(current, RELEASE_HOST, 'scripts', 'connectome-doctor') : LADDER;
  const args = [ladder, work, unit.name, ...(dataDir !== null ? ['--data-dir', dataDir] : [])];
  return `${sys.env.XDG_RUNTIME_DIR ? '' : `XDG_RUNTIME_DIR=/run/user/${sys.uid} `}python3 ${args.map(shellWord).join(' ')}`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

class TooLong extends Error {}

async function within<T>(limitMs: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TooLong(`didn't load within ${limitMs / 1000} s`)), limitMs);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\.$/, '');
}
