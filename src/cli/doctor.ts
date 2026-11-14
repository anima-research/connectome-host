import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRecipeDocument, readRecipeDocument } from '../recipe.js';
import { checkDiscordToken, sentToken, withSentForms, type TokenCheck } from '../setup/discord-token.js';
import {
  DISCORD_TOKEN, DotenvReadError, EnvFormError, readEnvFile, shownByName, storedSecrets, type Secret,
} from '../setup/secrets.js';
import { serviceBun } from '../update/service-bun.js';
import type { CliContext } from './connectome.js';
import { dataDirOf, openHost, type HostClient, type NoHost } from './host-socket.js';
import { INSTALL_COMMAND, shellWord, typedCommand } from '../update/typed-command.js';
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
  const typed = typedCommand(root, sys.env.PATH);
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
    secrets = storedSecrets(work, sys.env).flatMap(withSentForms);
    dotenv = readEnvFile(envFile);
  } catch (error) {
    const report = new Report(ctx.out);
    report.line(`Checking the install at ${root}.`);
    report.check('✗', `Doctor can't read the stored secrets that it hides: ${errorText(error)}.`, secretsStep(error, work));
    report.line('Doctor stops here and runs no check.');
    return 1;
  }
  const report = new Report((line) => ctx.out(shownByName(line, secrets)));
  report.line(`Checking the install at ${root}.`);

  const units = serviceUnits(root, sys.platform, sys.home);
  const commands = units === null ? null : serviceCommands(root, sys);
  const runs = checkService(report, sys, typed, units, commands);
  const host = await reachHost(report, parts, root, typed, units !== null, commands, runs);
  await checkRecipe(report, parts, host, units, commands, dotenv);
  await checkCalls(report, parts, host, units, commands);
  if (host !== null) host.close();
  await checkToken(report, parts, dotenv, typed, work);

  const unchecked = report.unchecked === 0 ? ''
    : ` ${report.unchecked} check${report.unchecked === 1 ? ' wasn\'t' : 's weren\'t'} made, marked –.`;
  report.line(report.problems === 0
    ? `Doctor found no problem.${unchecked}`
    : `Doctor found ${report.problems} problem${report.problems === 1 ? '' : 's'}, marked ✗.${unchecked}`);
  if (report.problems === 0 && units?.manager === 'systemd-user' && commands !== null) {
    report.line(`Where an incoming message stops, the ladder shows: ${ladderLine(root, work, units.host)}`);
  }
  return report.problems === 0 ? 0 : 1;
}

export function secretsStep(error: unknown, work: string): string {
  if (error instanceof DotenvReadError) {
    return `run \`${error.command}\` in ${work} to see why, correct what it shows, then run doctor again.`;
  }
  if (error instanceof EnvFormError) return `correct ${join(work, '.env')}, then run doctor again.`;
  return 'put right what it names, then run doctor again.';
}

function checkService(report: Report, sys: ServiceSystem, typed: string, units: ServiceUnits | null,
  commands: ServiceCommands | null): boolean | null {
  if (units === null) {
    report.check('–', 'Not checked: no service can be installed here.');
    return null;
  }
  if (commands === null) {
    report.check('✗', 'No service is installed for this install.', `\`${typed} service install <recipe>\``);
    return null;
  }
  const env = childEnv(sys);
  const start = `start it with \`${commands.start}\`, and read its log with \`${commands.log}\`.`;
  let hostRuns: boolean | null = null;
  for (const unit of [...commands.units].reverse()) {
    const state = unitState(sys, env, units, unit);
    if ('unasked' in state) {
      report.check('✗', state.unasked, `ask it yourself, as the user who runs the resident: \`${state.question}\``);
    } else if (state.runs) {
      report.check('✓', `The service ${unit.name} runs.`);
    } else {
      report.check('✗', `The service ${unit.name} is ${state.state}.`, start);
    }
    if (unit.name === units.host.name) hostRuns = 'unasked' in state ? null : state.runs;
  }
  return hostRuns;
}

function unitState(sys: ServiceSystem, env: Record<string, string>, units: ServiceUnits, unit: ServiceUnit):
  { runs: boolean; state: string } | { unasked: string; question: string } {
  if (units.manager === 'systemd-user') {
    const shown = showUnit(sys, env, unit.name, ['ActiveState', 'SubState']);
    if (typeof shown === 'string') {
      return { unasked: shown, question: systemctlLine(sys, `show --property=ActiveState,SubState -- ${unit.name}`) };
    }
    const active = shown.get('ActiveState') ?? '';
    const sub = shown.get('SubState') ?? '';
    return { runs: active === 'active', state: sub === '' ? active : `${active} (${sub})` };
  }
  const state = agentState(sys, env, unit);
  if (state.kind === 'unknown') {
    return { unasked: `launchctl list ${unit.name} failed: ${state.why}`, question: `launchctl list ${unit.name}` };
  }
  if (state.kind === 'running') return { runs: true, state: 'running' };
  return {
    runs: false,
    state: state.kind === 'unloaded' ? 'not loaded'
      : `loaded and not running${state.exit === undefined ? '' : `, its last exit ${state.exit}`}`,
  };
}

async function reachHost(report: Report, parts: DoctorParts, root: string, typed: string, installable: boolean,
  commands: ServiceCommands | null, runs: boolean | null): Promise<HostClient | null> {
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
  const next = !installable
    ? 'no service can be installed here, so start the host as this machine runs a program, from ' +
      `${dirname(root)}: \`${moved === null ? '' : `DATA_DIR=${shellWord(moved)} `}` +
      `${shellWord(bun)} ${shellWord(join(root, 'start.js'))} <recipe> --headless\``
    : commands === null ? `\`${typed} service install <recipe>\``
    : runs === true ? `it may still be starting, so run doctor again in a minute. Its log: \`${commands.log}\``
      : `start the service with \`${commands.start}\`.`;
  report.check('✗', `No host answers: ${reached.reason}.`, next);
  return null;
}

async function checkRecipe(report: Report, parts: DoctorParts, host: HostClient | null, units: ServiceUnits | null,
  commands: ServiceCommands | null, dotenv: Map<string, string>): Promise<void> {
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
  const recipe = resolve(read.workingDirectory === '~' ? parts.sys.home : read.workingDirectory, named);
  const env = { ...Object.fromEntries(dotenv), ...parts.sys.env };
  try {
    await within(parts.recipeLimitMs, (async () => {
      const document = await readRecipeDocument(recipe);
      await loadRecipeDocument(document, recipe, { env });
    })());
    report.check('✓', `${recipe} loads.`);
  } catch (error) {
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
    ? `: \`journalctl --user -u ${units.host.name} -g ${shellWord(line.replace(/[[\]]/g, '\\$&'))}\` lists them.`
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
  const check = await checkDiscordToken(sentToken(token), { fetch: parts.fetch });
  if (check.kind === 'accepted') report.check('✓', `Discord accepts the token: the bot is ${check.name}.`);
  else if (check.kind === 'refused') report.check('✗', 'Discord refuses the token.', store);
  else if (check.kind === 'unsendable') {
    report.check('✗', 'The token in .env can\'t be sent: it holds a character that a header can\'t carry.', store);
  } else report.check('–', `Discord gave no answer that doctor could read (${unread(check)}).`);
}

function unread(check: Exclude<TokenCheck, { kind: 'accepted' | 'refused' | 'unsendable' }>): string {
  if (check.kind === 'unanswered') return check.why;
  if (check.kind === 'redirected') return `a redirect, ${check.status}`;
  return `an answer of ${check.status}`;
}

/** The install record's data directory where it isn't `<work>/data`, the host's own default from `work`. */
function movedDataDir(root: string, work: string): string | null {
  let dataDir: string;
  try {
    dataDir = dataDirOf(root);
  } catch {
    return null;
  }
  return resolve(dataDir) !== join(work, 'data') ? dataDir : null;
}

function ladderLine(root: string, work: string, unit: ServiceUnit): string {
  const dataDir = movedDataDir(root, work);
  const args = [LADDER, work, unit.name, ...(dataDir !== null ? ['--data-dir', dataDir] : [])];
  return `python3 ${args.map(shellWord).join(' ')}`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

async function within<T>(limitMs: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`it didn't load within ${limitMs / 1000} s`)), limitMs);
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
