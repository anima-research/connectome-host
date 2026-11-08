/** What one version in an update's range records of its cost: null where it
 *  records nothing. */
export interface Cost {
  version: string;
  breaking: boolean | null;
  cacheWrite: boolean | null;
}

/** A read of the registry that succeeded. */
export interface ReadCheck {
  at: string;
  ok: true;
  /** The release Update would install, or null when none is newer. */
  candidate: string | null;
  /** Every version after the running one up to the candidate, oldest
   *  first. */
  costs: Cost[];
  /** The candidate's Bun floor when this Bun is below it. */
  bunFloorUnmet: string | null;
  /** npm's message when the running release is deprecated. */
  runningDeprecated: string | null;
}

/** The last read of the registry. */
export type Check = ReadCheck | { at: string; ok: false; error: string };

/** How the last switch or Go back ended, by the journal. A fallback carries
 *  the last lines the failed release kept itself, or null when it kept
 *  none. */
export type SwitchOutcome =
  | { outcome: 'committed'; from: string; to: string; at: string }
  | { outcome: 'fell-back'; from: string; to: string; at: string; reason: string; trialLog: string[] | null }
  | { outcome: 'refused'; step: string; from: string; to: string; at: string; reason: string };

/** One host's state after a switch's quiesce: `host` is "this host" or the
 *  child's name. A host that can't be counted, such as a child that didn't
 *  answer or a host serving again, says why. */
export type HostQuiet =
  | {
    host: string; answered: true; drained: boolean; activeTurnAgents: string[]; backgroundScripts: number;
    operatorHold?: { reason?: string }; inFlight?: string[];
  }
  | { host: string; answered: false; why: string };

export interface RestartState {
  to: string;
  why: 'update' | 'go-back';
  keepData: boolean;
  /** quiescing: waiting for turns to end; busy: they didn't, and the operator
   *  chooses; stopping: the mark is written and the host is stopping; ending:
   *  the restart is being called off, ending the switch's quiesce. */
  phase: 'quiescing' | 'busy' | 'stopping' | 'ending';
  /** Each host's state when it didn't drain. */
  hosts: HostQuiet[];
}

/** What the update section of /healthz and `/update` show. */
export interface UpdateStatus {
  running: string;
  /** Whether this host can update itself. */
  install: boolean;
  /** Whether it reads the registry on its own: its reads were started. */
  checks: boolean;
  check: Check | null;
  installing: string | null;
  lastInstall: { version: string; at: string; ok: boolean; error?: string } | null;
  /** A release Restart would switch to. */
  installed: string | null;
  goBack: { to: string; since: string } | null;
  restart: RestartState | null;
  armed: ArmedSwitch | null;
  /** An armed restart or Go back that was dropped without going ahead, and
   *  the reason. */
  armedDropped: (Pick<ArmedSwitch, 'to' | 'why' | 'keepData' | 'since'> & { at: string; reason: string }) | null;
  /** The reason the operator quiesced this host under, which it keeps
   *  through a restart. */
  operatorQuiesced: string | null;
  /** This install's host is quiesced for a switch no restart is carrying
   *  out, as when ending that quiesce failed: Resume ends it. */
  switchQuiesceLeft: boolean;
  lastSwitch: SwitchOutcome | null;
  /** What couldn't be read for this status. */
  problems: string[];
}

export interface ArmedSwitch {
  to: string;
  why: 'update' | 'go-back';
  keepData: boolean;
  since: string;
  by: string | null;
  lastTry: { at: string; waited: string; hosts: HostQuiet[] } | null;
}

export interface UpdateWays {
  install: string;
  restart: string;
  wait: string;
  now: string;
  resume: string;
  back: string;
  keep: string;
  restore: string;
  check: string;
}

export const COMMAND_WAYS: UpdateWays = {
  install: '/update install',
  restart: '/update restart',
  wait: '/update restart wait',
  now: '/update restart now',
  resume: '/update restart resume',
  back: '/update back',
  keep: '/update back keep',
  restore: '/update back restore',
  check: '/update',
};

export const PAGE_WAYS: UpdateWays = {
  install: 'Update',
  restart: 'Restart',
  wait: 'Wait longer',
  now: 'Stop now',
  resume: 'Resume',
  back: 'Go back',
  keep: 'Keep the newer data',
  restore: 'Restore the copy',
  check: 'Check now',
};

export function cliWays(typed: string): UpdateWays {
  return {
    install: `${typed} update install`,
    restart: `${typed} update restart`,
    wait: `${typed} update restart wait`,
    now: `${typed} update restart now`,
    resume: `${typed} update restart resume`,
    back: `${typed} update back`,
    keep: `${typed} update back keep`,
    restore: `${typed} update back restore`,
    check: `${typed} update check`,
  };
}

export const TOOL_WAYS: UpdateWays = {
  install: 'lifecycle--update install',
  restart: 'lifecycle--update restart',
  wait: `the person's ${cliWays('connectome').wait}`,
  now: `the person's ${cliWays('connectome').now}`,
  resume: `the person's ${cliWays('connectome').resume}`,
  back: 'lifecycle--update back',
  keep: 'lifecycle--update back with data keep',
  restore: 'lifecycle--update back with data restore',
  check: 'lifecycle--update check',
};

export function toolWays(headless: boolean, command = 'connectome'): UpdateWays {
  const person = headless ? cliWays(command) : COMMAND_WAYS;
  return {
    ...TOOL_WAYS,
    wait: `the person's ${person.wait}`,
    now: `the person's ${person.now}`,
    resume: `the person's ${person.resume}`,
  };
}

export const QUIET_MOMENT = 'nothing the host counts as in flight is still going here, such as a turn, subagent run, ' +
  'background script, session switch, operator\'s work or credential action, and each fleet child says nothing is ' +
  'going there, such as a turn, background script, operator\'s work or credential action';

export const ASKS_NOBODY = 'however long that takes, so it goes only once every host has said no turn is running ' +
  'there, and asks nobody';

export const ARMED_RETRY = 'A try that finds something still going waits at least a minute before the next.';

export const TOOL_CANCEL = 'lifecycle--update cancel';

export const LAST_SWITCH = 'the last switch';

export const QUOTED = '  ';

const WROTE_LAST = ', as it kept it (the service\'s log, or the terminal it was started in, also has what this leaves ' +
  'out, such as an error Bun reported itself):';

export const BUN_UPGRADE = 'Upgrade Bun (`bun upgrade`, or the package manager that installed it), start the host ' +
  'again, then Update.';

export const BUN_FIRST = 'upgrade Bun first, and Update installs nothing until then.';

export function inShellWords(text: string, command: string): string {
  return text.split('\n').map((line) => line.startsWith(QUOTED) ? line
    : line.replace(/(^|[^\w/])\/update(?![\w/-])/g, (_, before: string) => `${before}${command} update`)).join('\n');
}

export function armedName(armed: Pick<ArmedSwitch, 'to' | 'why' | 'keepData'>, opening = true): string {
  const name = armed.why === 'go-back'
    ? `a Go back to ${armed.to}, ${armed.keepData ? 'keeping the newer data' : 'restoring the copy'},`
    : `a restart onto ${armed.to}`;
  return opening ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

export function notesUrl(version: string): string {
  return `https://github.com/anima-research/connectome-host/blob/v${version}/CHANGELOG.md`;
}

const TO_AN_INSTALL = 'Installed from npm, it can: run the package\'s src/update/setup.ts with bun once, from the ' +
  'directory you start the host in and with the DATA_DIR you start it with ' +
  '(`bun node_modules/@animalabs/connectome-host/src/update/setup.ts` when it\'s installed there); setup then says how ' +
  'to start the host. A clone updates by hand: docs/DEPLOYMENTS.md, "Updating an install", "By hand".';

export const NOT_AN_INSTALL = 'This host wasn\'t started through an install\'s entry point, so it can\'t update itself. ' +
  TO_AN_INSTALL;

const AGENT_WORDS: ReadonlyArray<readonly [string, string]> = [
  [BUN_UPGRADE, 'Only the person who runs your host can upgrade its Bun (`bun upgrade`, or the package manager that ' +
    `installed it) and start the host again; then ${TOOL_WAYS.install} can install it.`],
  [BUN_FIRST, `the person who runs your host upgrades Bun first, and ${TOOL_WAYS.install} installs nothing until then.`],
  [TO_AN_INSTALL, 'Nothing you call changes that: only the person who runs your host can, by making it an install ' +
    'with setup or by updating it by hand.'],
];

const HOST_LINES = 'Those quoted lines are your host\'s, written to the person who runs it: what they ask of that person ' +
  'is theirs to do, so pass it on. Where they say a store was refused, trying that release again before what they ask is ' +
  'done falls back the same way.';

export function inAgentWords(text: string): string {
  const said: string[] = [];
  let kept: 'none' | 'heading' | 'quoted' = 'none';
  for (const line of text.split('\n')) {
    if (line.startsWith(QUOTED)) {
      said.push(line);
      if (kept === 'heading') kept = 'quoted';
      continue;
    }
    if (kept === 'quoted') said.push(HOST_LINES);
    kept = line.endsWith(WROTE_LAST) ? 'heading' : 'none';
    said.push(AGENT_WORDS.reduce((words, [person, agent]) => words.split(person).join(agent), line));
  }
  if (kept === 'quoted') said.push(HOST_LINES);
  return said.join('\n');
}

export const GO_BACK_UNREAD = 'whether a Go back is offered';

export const PHASE: Record<Exclude<RestartState['phase'], 'busy'>, string> = {
  quiescing: 'waiting for turns to end, with new turns held',
  stopping: 'stopping the host, for its next start',
  ending: 'being called off, ending the switch\'s quiesce',
};

const list = (versions: string[]): string => versions.join(', ');

export function restartName(restart: Pick<RestartState, 'to' | 'why'>, opening = false): string {
  const name = restart.why === 'go-back' ? `the Go back to ${restart.to}` : `the restart to ${restart.to}`;
  return opening ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

const told = (head: string, text: string | undefined, end = '.'): string =>
  text ? `${head}: ${text}` : `${head}${end}`;

export const deprecatedLine = (running: string, message: string): string =>
  `${running} is deprecated on npm${message ? ` (${message})` : ''}.`;

function costLines(costs: Cost[]): string[] {
  const where = (pick: (cost: Cost) => boolean) => costs.filter(pick).map((cost) => cost.version);
  const breaking = where((c) => c.breaking === true);
  const unrecorded = where((c) => c.breaking === null);
  const rewrites = where((c) => c.cacheWrite === true);
  const unmeasured = where((c) => c.breaking !== null && c.cacheWrite === null);
  const lines = [breaking.length > 0
    ? `Breaking: ${list(breaking)}. Read its notes before updating.`
    : unrecorded.length === 0 ? 'None of the releases since this one is breaking.' : 'None that records it is breaking.'];
  if (rewrites.length > 0) lines.push(`Each resident's prompt cache is written in full once: ${list(rewrites)}.`);
  if (unrecorded.length > 0) lines.push(`Cut before releases recorded what they cost, so read their notes: ${list(unrecorded)}.`);
  if (unmeasured.length > 0) lines.push(`Says nothing of whether it rewrites residents' prompt caches: ${list(unmeasured)}.`);
  return lines;
}

export function noticeLines(
  check: ReadCheck, running: string, install: boolean, ways: UpdateWays = COMMAND_WAYS, installed: string | null = null,
): string[] {
  if (check.candidate === null) return [];
  const lines = [`connectome-host ${check.candidate} is out; this host runs ${running}.`];
  if (check.runningDeprecated !== null) lines.push(deprecatedLine(running, check.runningDeprecated));
  lines.push(...costLines(check.costs));
  if (check.bunFloorUnmet !== null) {
    lines.push(`${check.candidate} needs Bun ${check.bunFloorUnmet}: ${BUN_FIRST}`);
  }
  lines.push(`Notes: ${notesUrl(check.candidate)}`);
  lines.push(!install ? NOT_AN_INSTALL
    : installed === check.candidate ? `To take it: ${ways.restart}.` : `To take it: ${ways.install}, then ${ways.restart}.`);
  return lines;
}

export function busyLines(restart: RestartState, waitedMs: number, ways: UpdateWays = COMMAND_WAYS): string[] {
  return [
    `Turns didn't all end within ${Math.round(waitedMs / 60_000)} min, so ${restartName(restart)} is waiting, with ` +
      'new turns held. Still busy:',
    ...busyHostLines(restart.hosts),
    `${ways.wait} waits up to 10 min more, ${ways.now} cuts those off and stops, and ${ways.resume} calls the ` +
      'restart off, to try later.',
  ];
}

function busyHostLines(hosts: HostQuiet[], scriptsEnd = 'which a stop ends'): string[] {
  const lines: string[] = [];
  for (const host of hosts) {
    if (!host.answered) {
      lines.push(host.why ? `- ${host.host}: can't be counted (${host.why})` : `- ${host.host}: can't be counted`);
    } else if (!host.drained) {
      // drained also waits for a wake parked on provider admission, which
      // names no agent (agent-framework's parkedAdmissions).
      const parts = [
        host.activeTurnAgents.length > 0
          ? `mid-turn: ${list(host.activeTurnAgents)}`
          : 'not drained, though no agent holds a turn: a wake is waiting on an auxiliary call before its turn starts',
        // Drain doesn't wait for them.
        ...(host.backgroundScripts > 0
          ? [`${host.backgroundScripts} background script${host.backgroundScripts === 1 ? '' : 's'}, ${scriptsEnd}`]
          : []),
      ];
      lines.push(`- ${host.host}: ${parts.join('; ')}`);
    }
  }
  return lines;
}

export function statusLines(status: UpdateStatus, ways: UpdateWays = COMMAND_WAYS): string[] {
  const lines = [`connectome-host ${status.running}.`];
  const check = status.check;
  if (check === null) {
    lines.push(`${status.checks ? 'The registry hasn\'t been read yet' : 'This host doesn\'t read the registry on its ' +
      'own'}: ${ways.check} reads it.`);
  } else if (!check.ok) {
    lines.push(told(`Reading the registry failed at ${check.at}`, check.error));
  } else if (check.candidate === null) {
    lines.push(`No newer release is offered (read at ${check.at}): Update offers final releases that aren't deprecated.`);
    if (check.runningDeprecated !== null) lines.push(deprecatedLine(status.running, check.runningDeprecated));
  } else {
    lines.push(...noticeLines(check, status.running, status.install, ways, status.installed));
  }
  if (!status.install) {
    if (check === null || !check.ok || check.candidate === null) lines.push(NOT_AN_INSTALL);
    return [...lines, ...problemLines(status.problems)];
  }
  if (status.installing !== null) lines.push(`Installing ${status.installing}.`);
  else if (status.lastInstall?.ok === false) lines.push(failedInstall(status.lastInstall));
  if (status.installed !== null) {
    lines.push(retrying(status)
      ? `${status.installed} is installed, and ended before its commit at its last try: ${ways.restart} tries it again.`
      : `${status.installed} is installed: ${ways.restart} switches to it.`);
    if (!check?.ok || check.candidate === null) lines.push(`Notes: ${notesUrl(status.installed)}`);
  }
  if (status.goBack !== null) {
    lines.push(`Going back to ${status.goBack.to} is offered, with the copy of its data taken ${status.goBack.since}: ` +
      `${ways.back} says what each way does.`);
  }
  const restart = status.restart;
  if (restart !== null) {
    if (restart.phase === 'busy') {
      lines.push(`${restartName(restart, true)} is waiting on turns to end, with new turns held. Busy when its wait ` +
        'ran out:', ...busyHostLines(restart.hosts), `${ways.wait}, ${ways.now} or ${ways.resume}.`);
    } else {
      lines.push(`${restartName(restart, true)} is ${PHASE[restart.phase]}.`);
    }
  }
  const armed = status.armed ?? null;
  if (armed !== null) {
    lines.push(`${armedName(armed)} is armed since ${armed.since}${armed.by !== null ? `, asked for by ${armed.by}` : ''}: it ` +
      `begins at the host's first quiet moment, once ${QUIET_MOMENT}.` + (armed.lastTry === null ? ` ${ARMED_RETRY}` : ''));
    const last = armed.lastTry;
    if (last !== null) {
      lines.push(told(`Its try at ${last.at} didn't go ahead`, last.waited) + ' It tries again at a quiet moment at ' +
        'least a minute later.');
      const holding = last.hosts.flatMap((host) => {
        if (!host.answered || !host.drained) {
          return busyHostLines([host], 'which the switch waits for')
            .map((line) => host.answered && host.inFlight !== undefined ? `${line}; ${list(host.inFlight)}` : line);
        }
        const parts = [...host.inFlight ?? [], ...(host.backgroundScripts > 0
          ? [`${host.backgroundScripts} background script${host.backgroundScripts === 1 ? '' : 's'} running outside any turn`]
          : [])];
        return parts.length > 0 ? [`- ${host.host}: ${parts.join('; ')}`] : [];
      });
      if (holding.length > 0) lines.push('Holding it then:', ...holding);
    }
    const instead = [...status.installed !== null ? [ways.restart] : [], ...status.goBack !== null ? [ways.keep, ways.restore] : []];
    lines.push(ways.check === TOOL_WAYS.check || instead.length === 0
      ? `${ways.check === TOOL_WAYS.check ? '' : 'The agent\'s own '}${TOOL_CANCEL} disarms it.`
      : `The agent's own ${TOOL_CANCEL} disarms it, and ${instead.length > 1 ? `${instead.slice(0, -1).join(', ')} or ` +
        instead.at(-1) : instead[0]} here goes ahead in its place.`);
  }
  const dropped = status.armedDropped ?? null;
  if (dropped !== null) {
    lines.push(told(`${armedName(dropped)} armed at ${dropped.since} didn't go ahead at ${dropped.at}`, dropped.reason));
  }
  if (status.operatorQuiesced !== null) {
    lines.push(`This host is quiesced${status.operatorQuiesced ? ` (${status.operatorQuiesced})` : ''}: a restart, or ` +
      'a Go back that keeps the data, keeps it so. Restoring the copy brings back the copy\'s own state instead.');
  }
  if (status.switchQuiesceLeft) {
    lines.push(`This host is quiesced for a switch that isn't going ahead: ${ways.resume} ends it.`);
  }
  if (status.lastSwitch !== null) lines.push(...lastSwitchLines(status.lastSwitch));
  return [...lines, ...problemLines(status.problems)];
}

export function lastSwitchLines(last: SwitchOutcome): string[] {
  if (last.outcome === 'committed') return [`Last switch: ${last.from} to ${last.to}, committed at ${last.at}.`];
  if (last.outcome === 'refused') return [told(`Last request: to ${last.to}, didn't go ahead at ${last.at}`, last.reason)];
  const head = `Last switch: ${last.from} came back with its data at ${last.at}, from a try of ${last.to}` +
    (last.reason ? `: ${last.reason}.` : '.');
  const kept = keptLines(last);
  if (kept.length === 0) return [`${head} ${MORE_IN_LOG}`];
  return [`${head} What ${last.to} wrote last${WROTE_LAST}`, ...kept.map((line) => `${QUOTED}${line}`)];
}

function failedInstall(install: { version: string; error?: string }): string {
  return install.error ? `Last install: ${install.error}` : `Installing ${install.version} failed.`;
}

const MORE_IN_LOG = 'The service\'s log, or the terminal the host was started in, says more.';

function keptLines(last: Extract<SwitchOutcome, { outcome: 'fell-back' }>): string[] {
  return last.trialLog !== null && last.trialLog.some((line) => line !== '') ? last.trialLog : [];
}

function retrying(status: UpdateStatus): boolean {
  return status.lastSwitch?.outcome === 'fell-back' && status.lastSwitch.to === status.installed;
}

function problemLines(problems: string[]): string[] {
  const said = problems.filter((problem) => problem !== '');
  const unsaid = problems.length - said.length;
  return unsaid === 0 ? said
    : [...said, `${unsaid} part${unsaid === 1 ? '' : 's'} of this status couldn't be read.`];
}

export function goBackUnread(status: UpdateStatus): string | undefined {
  return status.problems.find((problem) => problem.startsWith(GO_BACK_UNREAD));
}

export function goBackLines(status: UpdateStatus, ways: UpdateWays = COMMAND_WAYS): string[] {
  if (!status.install) return [NOT_AN_INSTALL];
  if (status.goBack === null) {
    const unread = goBackUnread(status);
    return [unread !== undefined
      ? `Whether a Go back is offered can't be told: ${unread.slice(GO_BACK_UNREAD.length + 2)}`
      : 'No Go back is offered: the copy doesn\'t hold another installed release\'s data.'];
  }
  const { to, since } = status.goBack;
  return [
    `Going back to ${to}, whose data the copy holds as it was at ${since}. Two ways:`,
    `- ${ways.keep}: ${to} runs on the data as it is now, so residents lose nothing. It comes back as the host is ` +
      'now: answering new turns, or holding them if its operator quiesced it, though a switch\'s quiesce left behind ' +
      `ends at that start. If ${to} can't read the data, its start goes back to ${status.running} by itself, and ` +
      `${ways.restore} is the way then.`,
    `- ${ways.restore}: the copy is restored, and everything since ${since} is set aside, not deleted. For ` +
      'residents, that is everything they have lived since then. The host comes back answering new turns, unless ' +
      'it had been quiesced from the Web UI before the Restart that took the copy: then it comes back holding them, ' +
      `and ${ways.check === TOOL_WAYS.check ? 'the person\'s click on' : 'clicking'} "⏸ quiesced" in the Web UI's ` +
      'top bar lets them through. Whether it\'s quiesced now makes no difference.',
    ways.check === TOOL_WAYS.check
      ? 'Either way, on a headless host started with `CONNECTOME_SUPERVISED=1`, it begins at the host\'s first quiet ' +
        `moment, ${ASKS_NOBODY}. ${ARMED_RETRY} Anywhere else, back refuses and arms nothing.`
      : 'Either way new turns are held first, and turns in progress get up to 2 min to end, as Restart does.',
  ];
}

export function restartLines(status: UpdateStatus): string[] | null {
  const to = status.installed;
  if (to === null) return null;
  const lines = [`Restart onto ${to}: new turns are held, and turns in progress get up to 2 min to end. If they do, ` +
    `the host stops, and its next start switches to ${to}. If they don't, Health lists who is busy, beside ` +
    `${PAGE_WAYS.wait}, ${PAGE_WAYS.now} and ${PAGE_WAYS.resume}.`];
  const check = status.check;
  const upTo = check?.ok ? check.costs.findIndex((cost) => cost.version === to) : -1;
  lines.push(...(check?.ok && upTo >= 0
    ? costLines(check.costs.slice(0, upTo + 1))
    : [`What the releases up to ${to} cost wasn't read from the registry, so read the notes before restarting.`]));
  const last = status.lastSwitch;
  if (retrying(status) && last?.outcome === 'fell-back') {
    lines.push(keptLines(last).length > 0
      ? `Its last try ended before its commit: Health shows what ${to} wrote last.`
      : `Its last try ended before its commit. ${MORE_IN_LOG}`);
  }
  if (last?.outcome === 'refused' && last.to === to) lines.push(told(`The last request to switch to ${to} didn't go ahead`, last.reason));
  if (status.operatorQuiesced !== null) {
    lines.push(`This host is quiesced${status.operatorQuiesced ? ` (${status.operatorQuiesced})` : ''}, and comes back ` +
      'quiesced.');
  }
  lines.push(`Notes: ${notesUrl(to)}`);
  return lines;
}

export type UpdateWay = keyof UpdateWays;

function updateOffered(status: UpdateStatus): boolean {
  const check = status.check;
  return status.install && check?.ok === true && check.candidate !== null && check.candidate !== status.installed &&
    check.bunFloorUnmet === null;
}

export function openWays(status: UpdateStatus): UpdateWay[] {
  const restart = status.restart;
  if (restart !== null) return restart.phase === 'busy' ? ['wait', 'now', 'resume'] : [];
  const ways: UpdateWay[] = status.switchQuiesceLeft ? ['resume'] : [];
  if (status.installing !== null) return ways;
  if (updateOffered(status)) ways.push('install');
  if (status.installed !== null) ways.push('restart');
  if (status.goBack !== null) ways.push('back');
  ways.push('check');
  return ways;
}

export function dialogStill(open: 'restart' | 'back' | null, status: UpdateStatus | null): 'restart' | 'back' | null {
  return open !== null && status !== null && openWays(status).includes(open) ? open : null;
}

export function commandFor(way: UpdateWay, status: UpdateStatus): string | null {
  if (way === 'restart') return status.installed === null ? null : `${COMMAND_WAYS.restart} ${status.installed}`;
  if (way === 'keep' || way === 'restore') return status.goBack === null ? null : `${COMMAND_WAYS[way]} ${status.goBack.to}`;
  return COMMAND_WAYS[way];
}

export interface Banner {
  line: string;
  ways: Array<'install' | 'restart' | 'wait' | 'resume'>;
  dismissable: boolean;
}

export function bannerOf(status: UpdateStatus): Banner | null {
  const ways = PAGE_WAYS;
  const restart = status.restart;
  if (restart !== null) {
    return restart.phase === 'busy'
      ? {
        line: `${restartName(restart, true)} is waiting on turns to end, with new turns held. Health says who was ` +
          `busy when its wait ran out, beside ${ways.now}.`,
        ways: ['wait', 'resume'],
        dismissable: false,
      }
      : { line: `${restartName(restart, true)} is ${PHASE[restart.phase]}.`, ways: [], dismissable: false };
  }
  if (status.switchQuiesceLeft) {
    return { line: 'This host is quiesced for a switch that isn\'t going ahead.', ways: ['resume'], dismissable: false };
  }
  if (status.installing !== null) return { line: `Installing ${status.installing}.`, ways: [], dismissable: false };
  if (status.installed !== null) {
    const last = status.lastSwitch;
    const line = retrying(status) && last?.outcome === 'fell-back'
      ? `${status.installed} ended before its commit at its last try, so ${last.from} came back. ` +
        (keptLines(last).length > 0 ? 'Health shows what it wrote last.' : MORE_IN_LOG)
      : last?.outcome === 'refused' && last.to === status.installed
        ? told(`${status.installed} is installed, and the last request to switch to it didn't go ahead`, last.reason) +
          (last.reason ? '.' : '')
        : `${status.installed} is installed.`;
    return { line, ways: ['restart'], dismissable: true };
  }
  if (status.lastInstall?.ok === false) {
    return { line: failedInstall(status.lastInstall), ways: updateOffered(status) ? ['install'] : [], dismissable: true };
  }
  const check = status.check;
  if (check?.ok && check.candidate !== null) {
    const notice = noticeLines(check, status.running, status.install, ways)
      .filter((line) => !line.startsWith('Notes: ') && !line.startsWith('To take it: '));
    return {
      line: notice.join(' '),
      ways: updateOffered(status) ? ['install'] : [],
      dismissable: true,
    };
  }
  if (check?.ok && check.runningDeprecated !== null) {
    return { line: deprecatedLine(status.running, check.runningDeprecated), ways: [], dismissable: true };
  }
  return null;
}

export function shownBanner(status: UpdateStatus | null, dismissed: string | null): Banner | null {
  const banner = status === null ? null : bannerOf(status);
  return banner !== null && !(banner.dismissable && banner.line === dismissed) ? banner : null;
}

export function keptDismissal(status: UpdateStatus | null, dismissed: string | null): string | null {
  return dismissed !== null && status !== null && bannerOf(status)?.line === dismissed ? dismissed : null;
}
