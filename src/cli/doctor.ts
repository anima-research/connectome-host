import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compressionModelOf } from '../framework-strategy.js';
import { effectiveContextBudgetTokens, effectiveMaxTokens } from '../recipe-fit.js';
import { composeMcplChildEnv, openedBy, serversForRecipe } from '../mcpl-config.js';
import {
  ENV_REFERENCE, loadRecipeDocument, readRecipeDocument, recipeDigest, recipeModel, resolveProvider,
  runningFit, unknownRecipeKeys, type Recipe, type RecipeDocument,
} from '../recipe.js';
import {
  PROVIDER_SECRETS, StoredSecrets, dotenvNames, dotenvReferences, redactWindow, secretNames, storedSecrets, type Secret,
} from '../setup/secrets.js';
import { AGENT_OVERLAY_FILE_ENV, agentOverlayPath } from '../update/agent-overlay-path.js';
import { INSTALL_ROOT_ENV } from '../update/contract.js';
import type { CliContext } from './connectome.js';
import { BEFORE_ENV_FILE, checkDiscord, mappingRemedy, sentToken } from './discord-check.js';
import { dataDirOf, openHost, type HostClient, type HostEvent, type NoHost } from './host-socket.js';
import { typedCommand } from './install-command.js';
import { SUPERVISED_ENV, checkService, readServiceRecord, serviceLines, servicePid, type ServiceRecord } from './service.js';

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
  plutil: string;
  servicePid: (record: ServiceRecord) => Promise<{ pid: string } | { why: string }> | { pid: string } | { why: string };
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
    plutil: 'plutil',
    servicePid: (record) => servicePid(record),
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
  const recipePath = service === null ? null
    : /^https?:\/\//.test(service.hostArgs[0]!) ? service.hostArgs[0]! : resolve(work, service.hostArgs[0]!);
  let recipeRead: { document: RecipeDocument } | { error: unknown } | null = null;
  if (recipePath !== null) {
    try {
      recipeRead = { document: await within(parts.recipeLimitMs, readRecipeDocument(recipePath),
        'the fetch of it didn\'t answer in time') };
    } catch (error) {
      recipeRead = { error };
    }
  }
  const banner = `connectome doctor: the install at ${root}`;
  let secrets: Secret[] = [...PROVIDER_SECRETS, 'DISCORD_TOKEN']
    .flatMap((name) => process.env[name] ? [{ name, value: process.env[name]! }] : []).flatMap(withSentForms);
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
  const manager = service?.manager
    ?? (process.platform === 'darwin' ? 'launchd' : process.platform === 'linux' ? 'systemd-user' : null);
  let managerUnread: string | null = null;
  let envFiles: string[] = [];
  try {
    storedNames = new StoredSecrets(join(work, '.setup')).read();
    const named = secretNames(join(work, '.setup'), join(work, '.env'));
    guessed = named.guessed;
    const known = (from: Record<string, string | undefined>, probes: Record<string, string | undefined>): Secret[] =>
      storedSecrets(work, from, probes);
    secrets = [...secrets, ...known(process.env, systemVariables())].flatMap(withSentForms);
    const document = recipeRead !== null && 'document' in recipeRead ? recipeRead.document : null;
    const names = [...named.names, 'MODEL', AGENT_OVERLAY_FILE_ENV, 'DISCORD_GUILD_ID', 'DISCORD_FILTERS_FILE', 'NODE_ENV',
      ...dotenvReferences(work), ...(document === null ? [] : namesIn(document))];
    let managed: Record<string, string> = {};
    try {
      managed = managerEnv(manager, names, parts);
      secrets = [...secrets,
        ...named.names.flatMap((name) => managed[name] ? withSentForms({ name, value: managed[name] }) : [])];
    } catch (error) {
      if (service !== null || serviceError !== null) throw error;
      managerUnread = error instanceof ManagerUnread ? error.step : errorText(error);
    }
    const unit = service === null ? null : unitEnv(service, parts);
    if (unit !== null && 'why' in unit) {
      const { name, file } = service!.units.host;
      const why = unit.why.replace(/\.$/, '');
      throw new Error(service!.manager === 'launchd'
        ? `${file}, ${name}'s plist, couldn't be read for the environment it sets the service (${why}). Fix it, or ` +
          '`connectome service install` writes it anew.'
        : `systemd didn't say the environment ${name} sets the service (${why}). Run doctor again, or ` +
          '`connectome service install` writes the unit anew.');
    }
    envFiles = unit === null ? [] : unit.files;
    const built = serviceEnv(work, root, managed, unit === null ? null : unit.env, parts.envLimitMs);
    env = built.env;
    secrets = [...secrets, ...known(env, built.base)].flatMap(withSentForms)
      .filter((s, i, all) => all.findIndex((t) => t.name === s.name && t.value === s.value) === i);
  } catch (error) {
    ctx.out(redact(banner));
    ctx.out(redact(`  ✗ ${errorText(error)}`));
    ctx.out(redact('Doctor stops here: it can\'t tell which values are secret, so it prints no check\'s output.'));
    return 1;
  }
  ctx.out(redact(banner));
  const recipeWarnings: string[] = [];
  let recipeLoad: { recipe: Recipe; persistable: Record<string, unknown> } | { error: unknown } | null = null;
  if (recipePath !== null) {
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { recipeWarnings.push(args.map(String).join(' ')); };
    try {
      if (recipeRead === null || 'error' in recipeRead) throw recipeRead?.error;
      recipeLoad = await within(parts.recipeLimitMs, loadRecipeDocument(recipeRead.document, recipePath, { env }),
        'the fetch of its system prompt didn\'t answer in time');
    } catch (error) {
      recipeLoad = { error };
    } finally {
      console.warn = warn;
    }
  }
  let servers: Server[] | null = null;
  let serversError: unknown = null;
  if (recipeLoad !== null && !('error' in recipeLoad)) {
    try {
      servers = serversForRecipe(recipeLoad.recipe.mcpServers, join(work, 'mcpl-servers.json'), agentOverlayPath(work, env))
        .loaded as Server[];
      secrets = [...secrets, ...servers.flatMap((server) => {
        const token = childEnv(server, env).DISCORD_TOKEN;
        return token && !new RegExp(`^${ENV_REFERENCE}$`).test(token)
          ? withSentForms({ name: 'DISCORD_TOKEN', value: token }) : [];
      })];
    } catch (error) {
      serversError = error;
    }
  }

  const report = new Report(ctx.out, redact);
  if (managerUnread !== null) {
    const asked = manager === 'launchd' ? 'launchd' : 'systemd\'s user manager';
    report.line(`With no service record to name its manager, doctor asked ${asked}, which a service installed here would ` +
      `run under, and couldn't read it (${managerUnread.replace(/\.$/, '')}), so a value only that manager gives isn't ` +
      'known to doctor or hidden in what it prints.');
  }

  let host: HostClient | NoHost = { reason: 'it wasn\'t asked', down: false };
  let stopped = false;
  let fitUnchecked = false;
  let filesUnread = false;
  let pidUntold = false;
  let uncredentialed = false;
  let closedTabs = false;
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
          report.line('It\'s stopped.');
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
      report.line(`No host answers, since its service is stopped: \`${startCommand}\` starts it.`);
    } else if ('reason' in host) {
      report.problem(`No host answers: ${host.reason}.`);
      if (host.down && service !== null) {
        await checked(report, 'Reading the service record again', () => {
          for (const line of serviceLines(root) ?? []) report.line(line);
        });
      }
    } else if (stopped) {
      report.problem(`A host answers, pid ${host.ready.pid}, recipe ${host.ready.recipe}, though the service is stopped, so ` +
        'it isn\'t the service\'s: it was started some other way, such as by hand, and the checks below ' +
        `are of it. Stop it before \`${startCommand}\`, since a host the service starts takes this install's socket from ` +
        'one that holds it.');
      host.subscribe([]);
    } else {
      let own: { pid: string } | { why: string } | null = null;
      if (service !== null) {
        try {
          own = await parts.servicePid(service);
        } catch (error) {
          own = { why: errorText(error) };
        }
      }
      if (own !== null && 'pid' in own && own.pid !== String(host.ready.pid)) {
        report.problem(`A host answers, pid ${host.ready.pid}, recipe ${host.ready.recipe}, but ` +
          `${own.pid === '0' ? `${service!.units.host.name} has no main process` : `${service!.units.host.name}'s main process is ${own.pid}`}, ` +
          'so it isn\'t the service\'s: it was started some other way, such as by hand, and the checks below are of it. ' +
          'Stop it, since a host the service starts takes this install\'s socket from one that holds it, and the ' +
          `service's own host can't be reached while it does: \`kill ${host.ready.pid}\` stops it.`);
      } else if (own !== null && 'why' in own) {
        report.line(`The host answers: pid ${host.ready.pid}, recipe ${host.ready.recipe}. Whether it's the service's host can't ` +
          `be told: ${own.why.replace(/\.$/, '')}.`);
        pidUntold = true;
      } else {
        report.ok(`The host answers: pid ${host.ready.pid}, recipe ${host.ready.recipe}.`);
      }
      host.subscribe([]);
    }
    const dataState = dataDir === null ? null : pathState(dataDir);
    if (dataState === 'gone') {
      report.problem(`The install record names ${dataDir} as the resident's data directory, and it isn't there. It holds ` +
        'the resident\'s history and memory, and a host started now would begin on an empty one, so put it back if you ' +
        'have it, or ask for help, before starting the service.');
    } else if (dataState !== null && dataState !== 'there') {
      report.problem(`The install record names ${dataDir} as the resident's data directory, and it can't be looked at ` +
        `(${dataState.why}), so whether it's there can't be told.`);
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
    let emptyCompressionSaid = false;
    if (loaded !== null) {
      await checked(report, 'The fit check', async () => {
        const model = recipeModel(loaded, env.MODEL);
        const counted = await besideOf(counting, model, effectiveContextBudgetTokens(loaded, model), recipeDigest(loaded));
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
        if (answer !== null) {
          countLines(report, answer.data, work, emptyCompressionSaid, recipe !== null && resolveProvider(recipe) === 'anthropic');
          uncredentialed = [answer.data.agent.source, answer.data.compression?.source].includes('count_tokens_no_credential');
        }
      });
    }

    report.section('Servers');
    if ('reason' in host) report.line('The shell\'s real call wasn\'t made: that needs the host running.');
    else {
      await checked(report, 'The shell\'s call', async () => {
        const answer = await read<ShellCheck>('shell-check', asked('shell-check'));
        if (answer !== null) {
          shellLines(report, answer.data);
          closedTabs = answer.data.closedTabs.length > 0;
        }
      });
    }
    let unknown = serviceError !== null
      ? 'which servers run is in the recipe the service record names, and the service\'s record can\'t be read'
      : service === null ? 'which servers run is in the recipe the service record names, and there\'s no record'
        : 'which servers run is in the recipe, which didn\'t load';
    if (serversError !== null) {
      report.problem(`The recipe's server list doesn't resolve: ${errorText(serversError)}`);
      unknown = 'the recipe\'s server list doesn\'t resolve';
    }
    await checked(report, 'The stored secrets\' check', () => {
      filesUnread = storedSecretLines(report, work, env, servers, uses, unknown, storedNames, envFiles);
    });

    report.section('Discord');
    if (servers === null) report.line(`Discord isn't checked: ${unknown}.`);
    else {
      const discord = servers.filter((s) => [s.command, ...(Array.isArray(s.args) ? s.args : [])]
        .some((part) => typeof part === 'string' && part.includes('discord-mcpl')));
      if (discord.length === 0) report.line('No server the recipe runs is Discord\'s.');
      for (const server of discord) {
        if (discord.length > 1) report.line(`The entry ${server.id}:`);
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
  if (typeof closed === 'string' || closed.closes.length > 0 || closed.undecoded > 0) {
    report.section('Channels the subscription GC closed (logs/failures.log):');
    if (typeof closed === 'string') {
      report.line(`${join(work, 'logs', 'failures.log')} can't be read (${closed}), so which channels the subscription GC ` +
        'closed isn\'t shown.');
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
    report.section('Where an incoming message got to (scripts/connectome-doctor):');
    let ran: SpawnSyncReturns<string> | undefined;
    try {
      ran = spawnSync(parts.python, [LADDER, '--findings-json', '--data-dir', dataDir, work, service.units.host.name], {
        encoding: 'utf-8',
        timeout: parts.ladderLimitMs,
        env: {
          ...process.env,
          XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}`,
          CONNECTOME_DOCTOR_WITHHOLD: JSON.stringify(secrets.map((s) => [s.name, s.value])),
        },
      });
    } catch (error) {
      report.problem(`The ladder couldn't be started: ${errorText(error)}.`);
    }
    if (ran !== undefined) {
      ladderRan = true;
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
  }

  const unmade = [
    ...('reason' in host ? ['the host\'s checks weren\'t made'] : []),
    ...(ladderRan ? [] : ['the ladder didn\'t run']),
    ...(storedNames === null ? ['it couldn\'t check the stored secrets'] : []),
    ...(filesUnread ? ['the files its unit reads its environment from weren\'t read'] : []),
    ...(fitUnchecked ? ['the fit wasn\'t checked'] : []),
    ...(typeof closed === 'string' ? ['the channels the subscription GC closed couldn\'t be read'] : []),
    ...(uncredentialed ? ['count_tokens had no credential to count with'] : []),
    ...(closedTabs ? ['a closed tab\'s connection wasn\'t checked'] : []),
    ...(pidUntold ? ['whether the host that answers is the service\'s couldn\'t be told'] : []),
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
  if (source === 'count_tokens_timeout') return 'the count_tokens request didn\'t answer within 30 s';
  if (source === 'count_tokens_error') {
    return 'the count_tokens request failed, or answered with what couldn\'t be read or with no count';
  }
  return source;
}

function countLines(report: Report, check: CountCheck, work: string, emptyCompressionSaid: boolean,
  onAnthropic: boolean): void {
  const { agent, compression } = check;
  if (agent.source === 'count_tokens') report.ok(`count_tokens counts with ${agent.countModel}.`);
  else if (agent.source === 'count_tokens_no_credential') report.line(`${NO_CREDENTIAL} So the context's makeup shows no exact total.`);
  else if (agent.source === 'count_tokens_unsupported_model') {
    report.line(`count_tokens isn't asked: ${agent.model === null ? 'the agent names no model'
      : `${agent.model} isn't a Claude model it counts`}.`);
  } else {
    const said = `count_tokens couldn't count with ${agent.countModel}: ${countFailure(agent.source)}. So the ` +
      'context\'s makeup shows no exact total.' + (agent.source === 'count_tokens_failed_401' ? REPLACE_CREDENTIAL : '') +
      (agent.source !== 'count_tokens_failed_404' ? '' : ' A retired ' +
      'model answers 404, and the endpoint count_tokens asks (Anthropic\'s API, or the one ANTHROPIC_BASE_URL names) ' +
      'may answer it for a model it doesn\'t serve: set COUNT_TOKENS_MODEL in ' +
      `${join(work, '.env')} to a current Claude model, and restart the service, since the host reads it when it starts. ` +
      `${BEFORE_ENV}: where one sets it, set it there instead.`);
    if (onAnthropic && agent.source === 'count_tokens_failed_401') report.problem(said);
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
  envFiles: string[],
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
  for (const name of names ?? []) {
    if (!env[name] && envFiles.length > 0) {
      report.line(`${name} is in setup's list of stored secrets and has no value in what doctor reads of the service's ` +
        `environment, but its unit also reads ${envFiles.join(' and ')}, whose values doctor can't see, so whether the ` +
        'service has one isn\'t known.');
      filesUnread = true;
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
        `nowhere outside its servers. ` + mappingRemedy(name, name === 'DISCORD_TOKEN'));
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

function pathState(path: string): 'there' | 'gone' | { why: string } {
  try {
    statSync(path);
    return 'there';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'gone' : { why: errorText(error).replace(/\.$/, '') };
  }
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

class ManagerUnread extends Error {
  constructor(message: string, readonly step: string) {
    super(message);
  }
}

function managerEnv(manager: ServiceRecord['manager'] | null, names: string[], parts: DoctorParts): Record<string, string> {
  const out: Record<string, string> = {};
  if (manager === 'systemd-user') {
    const ran = spawnSync(parts.systemctl, ['--user', 'show-environment'], {
      encoding: 'utf-8',
      timeout: parts.envLimitMs,
      env: { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}` },
    });
    const failed = failure(ran, parts.envLimitMs);
    if (failed !== null) {
      throw new ManagerUnread('systemctl --user show-environment failed, so what the user manager gives the service ' +
        `can't be read: ${failed}. Run \`systemctl --user show-environment\` as this user to see why: it needs the user's ` +
        'manager running and XDG_RUNTIME_DIR naming its directory, as a login session sets it. Then run doctor again.',
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
          `Run \`launchctl getenv ${name}\` as this user to see why, then run doctor again.`,
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

function unitEnv(service: ServiceRecord, parts: DoctorParts):
  { env: Record<string, string>; files: string[] } | { why: string } {
  const name = service.units.host.name;
  let ran: SpawnSyncReturns<string>;
  try {
    ran = service.manager === 'systemd-user'
      ? spawnSync(parts.systemctl, ['--user', 'show', '--property=Environment', '--value', '--', name], {
        encoding: 'utf-8',
        timeout: parts.envLimitMs,
        env: { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}` },
      })
      : spawnSync(parts.plutil, ['-extract', 'EnvironmentVariables', 'json', '-o', '-', service.units.host.file],
        { encoding: 'utf-8', timeout: parts.envLimitMs });
  } catch (error) {
    return { why: errorText(error) };
  }
  const failed = failure(ran, parts.envLimitMs);
  if (failed !== null) return { why: failed };
  if (service.manager === 'systemd-user') {
    const out: Record<string, string> = {};
    for (const word of shownWords(ran.stdout.trim())) {
      const at = word.indexOf('=');
      if (at > 0) out[word.slice(0, at)] = word.slice(at + 1);
    }
    let listed: SpawnSyncReturns<string>;
    try {
      listed = spawnSync(parts.systemctl, ['--user', 'show', '--property=EnvironmentFiles', '--value', '--', name], {
        encoding: 'utf-8',
        timeout: parts.envLimitMs,
        env: { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}` },
      });
    } catch (error) {
      return { why: errorText(error) };
    }
    const unlisted = failure(listed, parts.envLimitMs);
    if (unlisted !== null) return { why: unlisted };
    // systemd 257 prints each file on a line of its own, as `<path> (ignore_errors=no)`.
    const files = listed.stdout.split('\n').map((line) => line.replace(/ \(ignore_errors=(?:yes|no)\)$/, ''))
      .filter((line) => line !== '');
    return { env: out, files };
  }
  try {
    return { env: stringValues(JSON.parse(ran.stdout)), files: [] };
  } catch {
    return { why: 'plutil\'s answer wasn\'t JSON' };
  }
}

function systemVariables(): Record<string, string> {
  const base: Record<string, string> = {};
  for (const name of SYSTEM_VARIABLES) if (process.env[name] !== undefined) base[name] = process.env[name]!;
  return base;
}

/** Bun loads .env, .env.local and the like in the working directory itself, filling only what the process doesn't
 *  have (Bun 1.4.4), so the host's environment is asked of Bun. */
function serviceEnv(work: string, root: string, manager: Record<string, string>, unit: Record<string, string> | null,
  limitMs: number): { env: Record<string, string | undefined>; base: Record<string, string> } {
  const base = { ...systemVariables(), ...manager };
  if (unit !== null) Object.assign(base, unit);
  else {
    base[SUPERVISED_ENV] = '1';
    try {
      base.DATA_DIR = dataDirOf(root);
    } catch {}
  }
  base[INSTALL_ROOT_ENV] = root;
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
    return { env: JSON.parse(ran.stdout) as Record<string, string>, base };
  } catch {
    throw new Error(`Bun's answer in ${work} wasn't an environment doctor could read: something else wrote to its ` +
      'output, as a bunfig.toml preload can. `bun -e 0`, run there, shows what writes; once nothing does, run doctor ' +
      'again.');
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
