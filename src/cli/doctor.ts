import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compressionModelOf } from '../framework-strategy.js';
import { effectiveContextBudgetTokens } from '../recipe-fit.js';
import { composeMcplChildEnv, openedBy, serversForRecipe } from '../mcpl-config.js';
import {
  ENV_REFERENCE, loadRecipeDocument, readRecipeDocument, recipeDigest, recipeModel, runningFit, unknownRecipeKeys,
  type Recipe, type RecipeDocument,
} from '../recipe.js';
import {
  PROVIDER_SECRETS, StoredSecrets, dotenvReferences, readEnvFile, redactWindow, secretNames, storedSecrets, type Secret,
} from '../setup/secrets.js';
import { AGENT_OVERLAY_FILE_ENV, agentOverlayPath } from '../update/agent-overlay-path.js';
import { INSTALL_ROOT_ENV } from '../update/contract.js';
import type { CliContext } from './connectome.js';
import { BEFORE_ENV_FILE, checkDiscord, mappingRemedy, sentToken } from './discord-check.js';
import { dataDirOf, openHost, type HostClient, type HostEvent, type NoHost } from './host-socket.js';
import { typedCommand } from './install-command.js';
import { SUPERVISED_ENV, checkService, readServiceRecord, serviceLines, type ServiceRecord } from './service.js';

const LADDER = fileURLToPath(new URL('../../scripts/connectome-doctor', import.meta.url));
const LADDER_LIMIT_MS = 60_000;
const FINDINGS = 'connectome-doctor findings: ';
const HOST_ANSWER_LIMIT_MS = 60_000;
const ENV_LIMIT_MS = 60_000;
const RECIPE_LIMIT_MS = 60_000;
const SYSTEM_VARIABLES = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'LANG', 'TMPDIR', 'XDG_RUNTIME_DIR'];
const CHECKS = { 'count-check': 'the token counts', 'shell-check': 'the shell\'s call' } as const;
const EMPTY_COMPRESSION = 'The recipe\'s agent.strategy.compressionModel is empty, so context-manager halts memory ' +
  'formation: it refuses an empty model. Leave it out to compress with the agent\'s model, or name one, and restart the ' +
  'service.';

export interface DoctorParts {
  fetch: typeof fetch;
  checkService: typeof checkService;
  python: string | null;
  hostLimitMs: number;
  ladderLimitMs: number;
  systemctl: string;
  launchctl: string;
  envLimitMs: number;
  recipeLimitMs: number;
}

type Server = {
  id: string; command?: unknown; args?: unknown; env?: unknown; inheritEnv?: unknown;
  transport?: unknown; url?: unknown; token?: unknown; access?: unknown;
};

class Report {
  problems = 0;

  constructor(
    private readonly print: (line: string) => void,
    readonly redact: (text: string) => string,
  ) {}

  section(title: string): void {
    this.print('');
    this.print(this.redact(title));
  }

  line(text: string): void {
    this.print(this.redact(`  ${text}`));
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
    checkService,
    python: Bun.which('python3'),
    hostLimitMs: HOST_ANSWER_LIMIT_MS,
    ladderLimitMs: LADDER_LIMIT_MS,
    systemctl: 'systemctl',
    launchctl: 'launchctl',
    envLimitMs: ENV_LIMIT_MS,
    recipeLimitMs: RECIPE_LIMIT_MS,
  },
): Promise<number> {
  if (ctx.argv.length > 0) {
    ctx.err('connectome: usage: connectome doctor');
    return 2;
  }
  const root = ctx.root!;

  let service: ServiceRecord | null = null;
  let serviceError: string | null = null;
  try {
    service = readServiceRecord(root);
  } catch (error) {
    serviceError = errorText(error);
  }
  const work = service?.workingDirectory ?? join(root, '..');
  let recipeRead: { document: RecipeDocument } | { error: unknown } | null = null;
  if (service !== null) {
    try {
      recipeRead = { document: await within(parts.recipeLimitMs, readRecipeDocument(service.hostArgs[0]!),
        'the fetch of it didn\'t answer in time') };
    } catch (error) {
      recipeRead = { error };
    }
  }
  const banner = `connectome doctor: the install at ${root}`;
  let secrets: Secret[] = [...PROVIDER_SECRETS, 'DISCORD_TOKEN']
    .flatMap((name) => process.env[name] ? [{ name, value: process.env[name]! }] : []);
  let guessed: string[] = [];
  const redact = (text: string): string => {
    const bytes = Buffer.from(text, 'utf-8');
    const replaced = new Set<string>();
    const shown = redactWindow(bytes, 0, bytes.length, secrets, replaced).text;
    const hidden = guessed.filter((name) => replaced.has(name) || text.includes(`<${name}>`)).sort();
    if (hidden.length === 0) return shown;
    const mark = Buffer.from(` (it holds ${hidden.length === 1 ? 'a value' : 'values'} of ` +
      `${hidden.map((name) => `\`${name}\``).join(' and ')}, which doctor hides while the names list is missing, so it ` +
      'isn\'t shown as a command to run)', 'utf-8');
    return shown + redactWindow(mark, 0, mark.length, secrets, new Set()).text;
  };
  let env: Record<string, string | undefined>;
  let storedNames: string[] | null;
  try {
    storedNames = new StoredSecrets(join(work, '.setup')).read();
    const named = secretNames(join(work, '.setup'), join(work, '.env'));
    guessed = named.guessed;
    const known = (from: Record<string, string | undefined>): Secret[] => storedSecrets(work, from);
    secrets = [...secrets, ...known(process.env)];
    const document = recipeRead !== null && 'document' in recipeRead ? recipeRead.document : null;
    env = serviceEnv(work, root, managerEnv(service, [...named.names, 'MODEL', AGENT_OVERLAY_FILE_ENV, 'DISCORD_GUILD_ID',
      'DISCORD_FILTERS_FILE', 'NODE_ENV', ...dotenvReferences(work), ...(document === null ? [] : namesIn(document))], parts),
      parts.envLimitMs);
    secrets = [...secrets, ...known(env)].flatMap(withSentForms)
      .filter((s, i, all) => all.findIndex((t) => t.name === s.name && t.value === s.value) === i);
  } catch (error) {
    ctx.out(redact(banner));
    ctx.out(redact(`  ✗ ${errorText(error)}`));
    ctx.out(redact('Doctor stops here: it can\'t tell which values are secret, so it prints no check\'s output.'));
    return 1;
  }
  const report = new Report(ctx.out, redact);
  ctx.out(report.redact(banner));

  let host: HostClient | NoHost = { reason: 'it wasn\'t asked', down: false };
  let stopped = false;
  const startCommand = `${typedCommand(root)} service start`;
  let dataDir: string | null = null;
  try {
    dataDir = dataDirOf(root);
  } catch {}
  try {
    report.section('Service');
    if (serviceError !== null) {
      report.problem(`${serviceError} \`connectome service install <recipe>\` writes it again, and checks it.`);
    } else if (service === null) {
      report.problem(`No service is recorded for this install (${join(root, 'service.json')}): ` +
        '`connectome service install <recipe>` writes one and checks it.');
    } else {
      await checked(report, 'The service check', async () => {
        const result = await parts.checkService(root, undefined, true);
        for (const line of result.lines) report.line(line);
        if (!result.passed) report.problem('The service check above didn\'t pass.');
        if (result.stopped === true) {
          stopped = true;
          report.line(`It's stopped: \`${startCommand}\` starts it.`);
        }
      });
    }

    report.section('Host');
    try {
      host = await openHost(root);
    } catch (error) {
      host = { reason: errorText(error), down: false };
    }
    if ('reason' in host && stopped && host.down) {
      report.line('No host answers, since its service is stopped.');
    } else if ('reason' in host) {
      report.problem(`No host answers: ${host.reason}.`);
      if (host.down && service !== null) {
        await checked(report, 'Reading the service record again', () => {
          for (const line of serviceLines(root) ?? []) report.line(line);
        });
      }
    } else {
      report.ok(`The host answers: pid ${host.ready.pid}, recipe ${host.ready.recipe}.`);
      host.subscribe([]);
    }
    if (dataDir !== null && !existsSync(dataDir)) {
      report.problem(`The install record names ${dataDir} as the resident's data directory, and it isn't there. It holds ` +
        'the resident\'s history and memory, and a host started now would begin on an empty one, so put it back if you ' +
        'have it, or ask for help, before starting the service.');
    }
    const running = host;
    const asked = (op: keyof typeof CHECKS): Promise<HostEvent | null> | null =>
      'reason' in running ? null : running.request({ type: 'panel-request', op }, parts.hostLimitMs);
    const read = async <T>(op: keyof typeof CHECKS, answering: Promise<HostEvent | null> | null): Promise<{ data: T } | null> => {
      if (answering === null) return null;
      const answer = await answering;
      if (answer === null) {
        report.problem(`The host didn't answer ${CHECKS[op]} within ${parts.hostLimitMs / 1000} s, or its connection ` +
          'closed first.');
        return null;
      }
      if (answer.ok !== true) {
        const error = String(answer.error ?? 'no reason given');
        report.problem(`The host refused ${CHECKS[op]}: ${error}.` + (!error.startsWith('unknown panel op') ? ''
          : ' The running host is an older release than this command, so it doesn\'t know this check: restarting the ' +
            'service starts it on this release.'));
        return null;
      }
      return { data: answer.data as T };
    };
    const counting = asked('count-check');
    counting?.catch(() => {});

    report.section('Recipe');
    let recipe: Recipe | null = null;
    let uses: Map<string, string[]> | null = null;
    if (service === null) {
      report.line('Which recipe the service runs is in its record, so it isn\'t checked without one.');
    } else {
      const path = service.hostArgs[0]!;
      const warned: string[] = [];
      const warn = console.warn;
      console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(' ')); };
      try {
        if (recipeRead === null || 'error' in recipeRead) throw recipeRead?.error;
        const detailed = await within(parts.recipeLimitMs, loadRecipeDocument(recipeRead.document, path, { env }),
          'the fetch of its system prompt didn\'t answer in time');
        recipe = detailed.recipe;
        uses = namedOutsideServers(detailed.persistable);
        report.ok(`${path} loads.`);
      } catch (error) {
        report.problem(error instanceof Late ? `${path} didn't load within ${parts.recipeLimitMs / 1000} s: ${error.message}.`
          : `${path} doesn't load: ${errorText(error)}`);
      } finally {
        console.warn = warn;
      }
      for (const line of warned) report.line(line);
    }
    const loaded = recipe;
    let emptyCompressionSaid = false;
    if (loaded !== null) {
      await checked(report, 'The fit check', async () => {
        const model = recipeModel(loaded, env.MODEL);
        const counted = await besideOf(counting, model, effectiveContextBudgetTokens(loaded, model), recipeDigest(loaded));
        const fit = runningFit(loaded, env.MODEL, 'tokens' in counted ? counted.tokens : undefined);
        if (!fit.checked) report.line(fit.line);
        else if (!fit.fits) report.problem(fit.refusal);
        else if ('tokens' in counted && fit.spare !== undefined) {
          report.ok(`It fits ${model}'s window with about ${n(fit.spare)} tokens to spare, by context-manager's estimate of ` +
            `the conversation, before what modules add at each turn: the system prompt and tools the host sends count ` +
            `${n(counted.tokens)}.`);
        } else {
          report.ok(`It fits ${model}'s window.`);
          if ('why' in counted) {
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

    report.section('Token counts');
    if ('reason' in host) report.line('count_tokens wasn\'t asked: that needs the host running.');
    else {
      await checked(report, 'The token counts', async () => {
        const answer = await read<CountCheck>('count-check', counting);
        if (answer !== null) countLines(report, answer.data, work, emptyCompressionSaid);
      });
    }

    report.section('Servers');
    if ('reason' in host) report.line('The shell\'s real call wasn\'t made: that needs the host running.');
    else {
      await checked(report, 'The shell\'s call', async () => {
        const answer = await read<ShellCheck>('shell-check', asked('shell-check'));
        if (answer !== null) shellLines(report, answer.data);
      });
    }
    let servers: Server[] | null = null;
    let unknown = serviceError !== null
      ? 'which servers run is in the recipe the service record names, and the service\'s record can\'t be read'
      : service === null ? 'which servers run is in the recipe the service record names, and there\'s no record'
        : 'which servers run is in the recipe, which didn\'t load';
    if (recipe !== null) {
      try {
        servers = serversForRecipe(recipe.mcpServers, join(work, 'mcpl-servers.json'), agentOverlayPath(work, env))
          .loaded as Server[];
      } catch (error) {
        report.problem(`The recipe's server list doesn't resolve: ${errorText(error)}`);
        unknown = 'the recipe\'s server list doesn\'t resolve';
      }
    }
    await checked(report, 'The stored secrets\' check',
      () => storedSecretLines(report, work, env, servers, uses, unknown, storedNames));

    report.section('Discord');
    if (servers === null) report.line(`Discord isn't checked: ${unknown}.`);
    else {
      const discord = servers.filter((s) => [s.command, ...(Array.isArray(s.args) ? s.args : [])]
        .some((part) => typeof part === 'string' && part.includes('discord-mcpl')));
      if (discord.length === 0) report.line('No server the recipe runs is Discord\'s.');
      for (const server of discord) {
        try {
          const checked = await checkDiscord(childEnv(server, env), { fetch: parts.fetch, workingDir: work });
          for (const line of checked.lines) report.line(line);
          report.problems += checked.problems.length;
        } catch (error) {
          report.problem(`The Discord check of ${server.id} failed: ${errorText(error)}`);
        }
      }
    }
  } finally {
    if (!('reason' in host)) host.close();
  }

  const closed = await channelsClosed(join(work, 'logs', 'failures.log'));
  if (typeof closed === 'string' || closed.length > 0) {
    report.section('Channels the subscription GC closed (logs/failures.log):');
    if (typeof closed === 'string') {
      report.line(`${join(work, 'logs', 'failures.log')} can't be read (${closed}), so which channels the subscription GC ` +
        'closed isn\'t shown.');
    }
    for (const close of typeof closed === 'string' ? [] : closed) {
      report.line(`Channel ${close.channelId} was auto-closed at ${close.at}, over ${close.limitChars} characters of messages ` +
        'that didn\'t mention the resident since it last ran. If it\'s still closed, ask the resident to run its ' +
        `${close.restore} to reopen it; to stop it closing again, ask the resident to raise or turn off that channel's ` +
        'limit with its agent_settings tool (channel_idle_limits).');
    }
  }

  let ladderRan = false;
  if (serviceError !== null) {
    report.section('The ladder reads the service\'s unit, which its record names, so it doesn\'t run while the record ' +
      'can\'t be read.');
  } else if (service === null) {
    report.section('The ladder reads the service\'s unit and log, so it runs once a service is recorded.');
  } else if (service.manager !== 'systemd-user') {
    report.section('The ladder reads systemd\'s units and journal, so it doesn\'t run for this install, whose service ' +
      'runs under launchd.');
  } else if (parts.python === null) {
    report.section('The pipeline ladder needs python3, which isn\'t on PATH. The checks above don\'t.');
  } else if (dataDir === null) {
    report.section('The ladder reads the host\'s data directory, and where that is can\'t be told (said above), so it ' +
      'doesn\'t run.');
  } else {
    ladderRan = true;
    report.section('Where an incoming message got to (scripts/connectome-doctor):');
    const ran = spawnSync(parts.python, [LADDER, '--findings-json', '--data-dir', dataDir, work, service.units.host.name], {
      encoding: 'utf-8',
      timeout: parts.ladderLimitMs,
      env: {
        ...process.env,
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}`,
        CONNECTOME_DOCTOR_WITHHOLD: JSON.stringify(secrets.map((s) => [s.name, s.value])),
      },
    });
    const said = (ran.stdout ?? '').split('\n');
    const at = said.map((line) => line.startsWith(FINDINGS)).lastIndexOf(true);
    const findings = at < 0 ? null : said.splice(at, 1)[0].slice(FINDINGS.length);
    for (const line of [...said, ...(ran.stderr ?? '').split('\n')]) if (line !== '') report.line(line);
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

  const unmade = [
    ...('reason' in host ? ['the host\'s checks weren\'t made'] : []),
    ...(ladderRan ? [] : ['the ladder didn\'t run']),
    ...(storedNames === null ? ['it couldn\'t check the stored secrets'] : []),
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

async function channelsClosed(file: string): Promise<GcClose[] | string> {
  const latest = new Map<string, GcClose>();
  let handle;
  try {
    handle = await open(file, 'r');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : errorText(error);
  }
  try {
    for await (const line of handle.readLines()) {
      if (!line.includes('"subscription-gc-close"')) continue;
      let record: Partial<Record<keyof GcClose | 'kind', unknown>>;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record?.kind === 'subscription-gc-close' && typeof record.channelId === 'string' && record.channelId !== '' &&
        typeof record.at === 'string' && typeof record.restore === 'string' && typeof record.limitChars === 'number') {
        latest.set(record.channelId, record as GcClose);
      }
    }
  } catch (error) {
    return errorText(error);
  } finally {
    await handle.close().catch(() => {});
  }
  return [...latest.values()];
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

interface CountCheck {
  agent: { model: string | null; countModel: string | null; source: string };
  compression: { model: string; countModel: string | null; source: string } | null;
  beside?: { tokens: number | null; source: string; error?: string };
  budget?: number | null;
  recipeDigest?: string;
}

interface ShellCheck {
  shells: Array<{ server: string; answered: true; sessions: number | null } | { server: string; answered: false; error: string }>;
  notConnected: Array<{ id: string; retrying: boolean; refused: string | null }>;
  closedTabs: string[];
}

const REPLACE_CREDENTIAL = ' Replace that credential where the service gets it, and restart the service.';
const NO_CREDENTIAL = 'count_tokens had no Anthropic credential to send: the host looks for its subscription login, ' +
  'then ANTHROPIC_AUTH_TOKEN, then ANTHROPIC_API_KEY, and has none.';

function countFailure(source: string): string {
  if (source === 'count_tokens_failed_401') {
    return 'count_tokens refused the credential the host sent (401): its subscription login when it has one, else ' +
      'ANTHROPIC_AUTH_TOKEN, else ANTHROPIC_API_KEY';
  }
  const status = /^count_tokens_failed_(\d+)$/.exec(source)?.[1];
  if (status !== undefined) return `count_tokens answered ${status}`;
  if (source === 'count_tokens_error') {
    return 'the count_tokens request failed, didn\'t answer within 30 s, or answered with what couldn\'t be read';
  }
  return source;
}

function countLines(report: Report, check: CountCheck, work: string, emptyCompressionSaid: boolean): void {
  const { agent, compression } = check;
  if (agent.source === 'count_tokens') report.ok(`count_tokens counts with ${agent.countModel}.`);
  else if (agent.source === 'count_tokens_no_credential') report.line(`${NO_CREDENTIAL} So the context's makeup shows no exact total.`);
  else if (agent.source === 'count_tokens_unsupported_model') {
    report.line(`count_tokens isn't asked: ${agent.model === null ? 'the agent names no model'
      : `${agent.model} isn't a Claude model it counts`}.`);
  } else {
    report.problem(`count_tokens couldn't count with ${agent.countModel}: ${countFailure(agent.source)}. So the ` +
      'context\'s makeup shows no exact total.' + (agent.source === 'count_tokens_failed_401' ? REPLACE_CREDENTIAL : '') +
      (agent.source !== 'count_tokens_failed_404' ? '' : ' A retired ' +
      'model answers 404, and the endpoint count_tokens asks (Anthropic\'s API, or the one ANTHROPIC_BASE_URL names) ' +
      'may answer it for a model it doesn\'t serve: set COUNT_TOKENS_MODEL in ' +
      `${join(work, '.env')} to a current Claude model, and restart the service, since the host reads it when it starts. ` +
      `${BEFORE_ENV}: where one sets it, set it there instead.`));
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
    report.problem(`count_tokens couldn't count with the compression model, ${compression.model}: ` +
      `${countFailure(compression.source)}.` + (compression.source === 'count_tokens_failed_401' ? REPLACE_CREDENTIAL : '') +
      (compression.source !== 'count_tokens_failed_404' ? '' : ' A retired ' +
      'model answers 404, and with a retired compression model folding stalls and the context can\'t compress under ' +
      'the window: change the recipe\'s agent.strategy.compressionModel to a current model' +
      (agent.source !== 'count_tokens' || agent.countModel !== agent.model || compression.model === agent.model ? ''
        : ', or leave it out to compress with the agent\'s model,') +
      ' and restart the service. The endpoint count_tokens asks (Anthropic\'s API, or the one ANTHROPIC_BASE_URL names) ' +
      'may answer 404 for a model it doesn\'t serve too, and then the 404 doesn\'t mean it\'s retired.'));
  }
}

function shellLines(report: Report, shell: ShellCheck): void {
  for (const server of shell.notConnected) {
    report.problem(`The server ${server.id} isn't connected` + (server.refused !== null
      ? `: the host refuses its configuration: ${server.refused}.`
      : server.retrying
        ? '; the host is still retrying it.'
        : `, and the host isn't retrying it. Its stderr is in the data directory, in sessions/<session>/mcpl-stderr/${server.id}.log.`));
  }
  for (const id of shell.closedTabs) {
    report.line(`The server ${id} is a closed tab: the host connects it when an agent opens it, so its connection isn't checked.`);
  }
  if (shell.shells.length === 0) {
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
        'that isn\'t running.');
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
): void {
  if (names === null) {
    const { guessed } = secretNames(join(work, '.setup'), join(work, '.env'));
    report.line(`There's no ${new StoredSecrets(join(work, '.setup')).file}, so which secrets setup stored isn't known and ` +
      'doctor can\'t check them' +
      (guessed.length === 0 ? '' : `, and it hides every value of a name setup doesn't know: ${[...guessed].sort().join(', ')}`) +
      '. Write it as a JSON list of the name of every secret, those in .env and any the host is given through its ' +
      'environment, and doctor checks them' +
      (guessed.length === 0 ? '.' : ' and shows the other values.'));
  }
  const inEnvFile = readEnvFile(join(work, '.env'));
  const provider: readonly string[] = PROVIDER_SECRETS;
  const mapped: string[] = [];
  for (const name of names ?? []) {
    if (!env[name] && !inEnvFile.has(name)) {
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
      report.problem(`${name} is in setup's list of stored secrets, and no server gets it: no server the host starts is ` +
        `given it in its env or args, no server it dials names it in its token or url, and the recipe names it nowhere ` +
        `outside its servers. ` + mappingRemedy(name, name === 'DISCORD_TOKEN'));
    }
  }
  if (unchecked.length > 0) report.line(`Which servers see ${unchecked.join(', ')} isn't checked: ${unknown}.`);
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

function withSentForms(secret: Secret): Secret[] {
  if (secret.name !== 'DISCORD_TOKEN') return [secret];
  const sent = sentToken(secret.value);
  return [secret, ...[sent, sent.trim()].filter((value) => value !== '').map((value) => ({ name: secret.name, value }))];
}

function failure(ran: SpawnSyncReturns<string>, limitMs: number): string | null {
  if (ran.error !== undefined) {
    return (ran.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? `it didn't answer within ${limitMs / 1000} s`
      : ran.error.message;
  }
  if (ran.status === 0) return null;
  return (ran.stderr ?? '').trim() || (ran.status === null ? `it was ended by ${ran.signal}` : `exit ${ran.status}`);
}

function managerEnv(service: ServiceRecord | null, names: string[], parts: DoctorParts): Record<string, string> {
  const out: Record<string, string> = {};
  if (service?.manager === 'systemd-user') {
    const ran = spawnSync(parts.systemctl, ['--user', 'show-environment'], {
      encoding: 'utf-8',
      timeout: parts.envLimitMs,
      env: { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}` },
    });
    const failed = failure(ran, parts.envLimitMs);
    if (failed !== null) {
      throw new Error('systemctl --user show-environment failed, so what the user manager gives the service can\'t be ' +
        `read: ${failed}`);
    }
    for (const line of ran.stdout.split('\n')) {
      const at = line.indexOf('=');
      if (at <= 0) continue;
      const value = line.slice(at + 1);
      out[line.slice(0, at)] = value.startsWith('$\'') && value.endsWith('\'') && value.length >= 3
        ? unquoted(value.slice(2, -1)) : value;
    }
  } else if (service?.manager === 'launchd') {
    for (const name of new Set(names)) {
      const ran = spawnSync(parts.launchctl, ['getenv', name], { encoding: 'utf-8', timeout: parts.envLimitMs });
      const failed = failure(ran, parts.envLimitMs);
      if (failed !== null) {
        throw new Error(`launchctl getenv ${name} failed, so what launchd gives the service can't be read: ${failed}`);
      }
      const value = ran.stdout.endsWith('\n') ? ran.stdout.slice(0, -1) : ran.stdout;
      if (value !== '') out[name] = value;
    }
  }
  return out;
}

// systemctl show-environment prints a value holding a space, or a character the shell gives a meaning, as $'…', with a
// backslash before \ and ', and a control character, or a byte that isn't UTF-8, as C escapes it, \ooo where C has no
// letter for it (systemd v257, shell_maybe_quote and cescape_char in src/basic/escape.c).
function unquoted(text: string): string {
  const named: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34, '\'': 39 };
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

/** Bun loads .env, .env.local and the like in the working directory itself, filling only what the process doesn't
 *  have (Bun 1.4.4), so the host's environment is asked of Bun. */
function serviceEnv(work: string, root: string, manager: Record<string, string>, limitMs: number):
  Record<string, string | undefined> {
  const base: Record<string, string> = {};
  for (const name of SYSTEM_VARIABLES) if (process.env[name] !== undefined) base[name] = process.env[name]!;
  Object.assign(base, manager, { [SUPERVISED_ENV]: '1', [INSTALL_ROOT_ENV]: root });
  try {
    base.DATA_DIR = dataDirOf(root);
  } catch {}
  const ran = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], {
    cwd: work,
    env: base,
    encoding: 'utf-8',
    timeout: limitMs,
  });
  if ((ran.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
    throw new Error(`Bun didn't finish reading the service's environment in ${work} within ${limitMs / 1000} s: something ` +
      'it runs as it starts, such as a bunfig.toml preload, didn\'t end. `bun -e 0`, run there, shows whether it ends.');
  }
  if (ran.error !== undefined) {
    throw new Error(`Bun couldn't be run in ${work} to read the service's environment: ${ran.error.message}`);
  }
  if (ran.status !== 0) {
    throw new Error(`Bun ${ran.status === null ? `was ended by ${ran.signal}` : `exited ${ran.status}`} in ${work} as it read ` +
      'the service\'s environment, and its error isn\'t shown, since it can hold .env\'s values: run `bun -e 0` there to ' +
      'see it.');
  }
  try {
    return JSON.parse(ran.stdout) as Record<string, string>;
  } catch {
    throw new Error(`Bun's answer in ${work} wasn't an environment doctor could read: something else wrote to its ` +
      'output, as a bunfig.toml preload can.');
  }
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
  if (answer.ok !== true) return { why: 'the host refused its token counts' };
  const data = answer.data as Partial<CountCheck> | undefined;
  const beside = data?.beside;
  if (beside === undefined) return { why: 'the running host doesn\'t count them: it\'s an older release than this command' };
  if (beside.source === 'count_tokens' && typeof beside.tokens === 'number') {
    if (typeof data?.agent?.model === 'string' && data.agent.model !== model) {
      return { why: `the running host runs ${data.agent.model}, not ${model}, so its count isn't of this recipe as it runs` };
    }
    if (typeof data?.budget === 'number' && data.budget !== budget) {
      return { why: `the running host's budget is ${n(data.budget)}, not the ${n(budget)} this recipe gives it, as agent ` +
        'settings or a change since its start can leave it' };
    }
    if (data?.recipeDigest !== digest) {
      return { why: 'the recipe doesn\'t load now as it did for the running host, as an edit since its start can leave it' };
    }
    return { tokens: beside.tokens };
  }
  if (beside.source === 'preview_failed') {
    return { why: `the request a turn sends couldn't be built: ${beside.error ?? 'no reason given'}` };
  }
  if (beside.source === 'count_tokens_no_credential') return { why: 'count_tokens had no Anthropic credential to send' };
  if (beside.source === 'count_tokens_unsupported_model') return { why: 'count_tokens doesn\'t count with the agent\'s model' };
  if (beside.source === 'count_tokens') return { why: 'count_tokens answered with no count' };
  return { why: countFailure(beside.source) };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
