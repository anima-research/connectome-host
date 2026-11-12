import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bunBelowFloor } from '../bun-floor.js';
import {
  ContractError, askedBy, childrenFilePath, installPaths, isChildEntry, isSwitchQuiesce, lastCopy, readCurrent, readJournal,
  readRecord, readWithoutWaiting, realOrResolved, releaseDir, SUPERVISED_ENV, unsyncedText, writeMark, writeTextAtomic,
  type ChildrenFile,
} from './contract.js';
import type { ReleaseHere } from './host.js';
import { EXACT_VERSION, hostProblem, installRelease, machineInstallOps, type InstallOps } from './install.js';
import { RELEASE_HOST, goBackOffer, isUnder, readInstallRecord } from './launcher.js';
import { installCommandAt } from '../cli/install-command.js';
import {
  NOT_THE_SWITCHS, SERVING, lookAtChildren, quiesceForSwitch, resumeAfterSwitchQuiesce, type QuiesceFramework,
  type SwitchFleet,
} from './quiesce.js';
import { candidateOf, rangeOf, readReleases, registryOf, type Release } from './releases.js';
import { readTrialLog } from './trial-log.js';
import {
  ARMED_RETRY, ASKS_NOBODY, COMMAND_WAYS, GO_BACK_UNREAD, LAST_SWITCH, PHASE, QUIET_MOMENT, TOOL_CANCEL, TOOL_WAYS, armedName,
  bunUpgrade, busyLines, cliWays, deprecatedLine,
  notAnInstall, noticeLines, notesUrl, personWay, restartName, toolWays, type ArmedSwitch, type Check, type HostQuiet, type ReadCheck,
  type RestartState,
  type SwitchOutcome, type UpdateStatus, type UpdateWays,
} from '../web/update-text.js';

const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const RESTART_QUIESCE_MS = 120_000;
const WAIT_LONGER_MS = 600_000;
// Each try quiesces every fleet child, and agent-framework 0.32.0 waits up to
// a second for a busy host to drain before it answers (QUIESCE_TIMEOUT_MIN_MS),
// holding that child's new turns until the try ends its quiesce. One try a
// minute bounds that hold on a busy child to about a second a minute.
const ARMED_RETRY_MS = 60_000;

export type SwitchFramework = QuiesceFramework & {
  listMcplServers(): ReadonlyArray<{ id: string; connected: boolean }>;
};

export interface UpdateHost {
  framework(): SwitchFramework;
  fleet(): SwitchFleet | null;
}

export interface HostStop {
  supervised: boolean;
  stop(reason: string, farewell: string): void;
  stopping?(): boolean;
}

export interface UpdateSetup {
  here: ReleaseHere | null;
  running: string;
  host: UpdateHost;
  headless?: boolean;
  env?: Record<string, string | undefined>;
  bun?: string;
  fetchManifest?: typeof fetch;
  installOps?: InstallOps;
  now?: () => Date;
  log?: (line: string) => void;
  waits?: { restartMs: number; longerMs: number; armedRetryMs?: number };
}

export interface UpdateAnswer {
  done: boolean;
  lines: string[];
}

const said = (error: unknown): string => error instanceof Error ? error.message : String(error);
const refused = (...lines: string[]): UpdateAnswer => ({ done: false, lines });
const done = (...lines: string[]): UpdateAnswer => ({ done: true, lines });
const list = (versions: string[]): string => versions.join(', ');

const notesPath = (root: string, version: string): string => join(releaseDir(root, version), RELEASE_HOST, 'CHANGELOG.md');
const NOTES_HEADING = /^## (\S+)(?:\s|$)/;

function notesSections(text: string): Array<{ version: string; text: string }> {
  const sections: Array<{ version: string; lines: string[] }> = [];
  let open: { version: string; lines: string[] } | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      const version = NOTES_HEADING.exec(line)?.[1] ?? '';
      open = EXACT_VERSION.test(version) ? { version, lines: [] } : null;
      if (open !== null) sections.push(open);
    }
    open?.lines.push(line);
  }
  return sections.map(({ version, lines }) => ({ version, text: lines.join('\n').trimEnd() }));
}

// agent-framework 0.32.0 keeps a tool's answer whole in the agent's context
// only up to 24,000 characters (DEFAULT_TOOL_RESULT_INLINE_MAX_CHARS), and
// keeps no more than that where no workspace mount is writable.
const NOTES_BUDGET = 24_000;

const characters = (count: number): string => `${count.toLocaleString('en-US')} characters`;

function notesAnswer(path: string, running: string, installed: string, version?: string): UpdateAnswer {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (error) {
    return refused(`No notes were given: ${installed}'s notes can't be read from ${path} (${said(error)}): ` +
      `${notesUrl(installed)} has them.`);
  }
  const sections = notesSections(text)
    .filter(({ version: v }) => Bun.semver.order(v, running) > 0 && Bun.semver.order(v, installed) <= 0);
  if (sections.length === 0) {
    return refused(`No notes were given: ${path} has no notes for the releases after ${running} up to ${installed}: ` +
      `${notesUrl(installed)} has ${installed}'s.`);
  }
  const fits = (answer: UpdateAnswer): boolean => answer.lines.join('\n').length <= NOTES_BUDGET;
  if (version === undefined) {
    const whole = done(`The notes of ${list(sections.map(({ version: v }) => v))}, from ${path}:`,
      sections.map(({ text: body }) => body).join('\n\n'));
    if (fits(whole)) return whole;
    if (sections.length > 1) {
      return done(`The notes of the releases after ${running} up to ${installed} come to more than one answer carries ` +
        `(${characters(NOTES_BUDGET)}), so here is each release's size, from ${path}. Ask for one release's notes with ` +
        'lifecycle--update notes with its `version`:',
        ...sections.map(({ version: v, text: body }) => `- ${v}: ${characters(body.length)}`));
    }
  }
  const one = version === undefined ? sections[0]! : sections.find(({ version: v }) => v === version);
  if (one === undefined) {
    return refused(`No notes were given: ${path} has no notes for ${version} among the releases after ${running} up to ` +
      `${installed}. Those it has notes for: ${list(sections.map(({ version: v }) => v))}.`);
  }
  const whole = done(`The notes of ${one.version}, from ${path}:`, one.text);
  if (fits(whole)) return whole;
  const head = (shown: number): string => `The notes of ${one.version}, from ${path}, cut: the first ` +
    `${shown.toLocaleString('en-US')} of its ${characters(one.text.length)}. The rest is in that file, and at ` +
    `${notesUrl(one.version)}:`;
  const shown = NOTES_BUDGET - head(NOTES_BUDGET).length - 1;
  return done(head(shown), one.text.slice(0, shown));
}

export class HostUpdate {
  private setup: UpdateSetup | null = null;
  private stopper: HostStop | null = null;
  private serving: (() => void) | null = null;
  private notices: ((line: string) => void) | null = null;
  private check: Check | null = null;
  private readonly logged = new Set<string>();
  private installing: string | null = null;
  private lastInstall: UpdateStatus['lastInstall'] = null;
  private restart: RestartState | null = null;
  private quiescedFramework: SwitchFramework | null = null;
  private endingSwitchQuiesce = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private serviceLine = false;
  private armed: ArmedSwitch | null = null;
  private armedDropped: UpdateStatus['armedDropped'] = null;
  private trying = false;

  configure(setup: UpdateSetup): void {
    this.setup = setup;
    this.serviceLine = (setup.env ?? process.env)[SUPERVISED_ENV] === '1';
    this.armedDropped = setup.here === null ? null : takeDroppedArm(installPaths(setup.here.root).armedDropped, (line) => { this.log(line); });
  }

  recordStop(reason: string): string | null {
    const armed = this.armed;
    const here = this.setup?.here ?? null;
    if (armed === null || here === null) return null;
    const { to, why, keepData, since } = armed;
    const dropped = { to, why, keepData, since, at: this.now().toISOString(), reason: `the host stopped first (${reason}).` };
    try {
      writeTextAtomic(installPaths(here.root).armedDropped, `${JSON.stringify(dropped)}\n`);
    } catch (error) {
      return `${armedName(armed)} armed at ${since} is dropped by this stop, and the record of that for the next start ` +
        `couldn't be written: ${said(error)}`;
    }
    return `${armedName(armed)} armed at ${since} is dropped by this stop, and the next start's check says so.`;
  }

  attachStop(stop: HostStop): void {
    this.stopper = stop;
    const serve = this.serving;
    this.serving = null;
    serve?.();
  }

  whenStopAttached(serve: () => void): void {
    if (this.stopper !== null) serve();
    else this.serving = serve;
  }

  attachNotices(log: (line: string) => void): void {
    this.notices = log;
  }

  /** Whether the host reads the registry on its own: not when
   *  CONNECTOME_UPDATE_CHECK is 0 or NO_UPDATE_NOTIFIER is set non-empty. */
  checksOn(): boolean {
    const env = this.need().env ?? process.env;
    return env.CONNECTOME_UPDATE_CHECK !== '0' && !env.NO_UPDATE_NOTIFIER;
  }

  startChecks(): void {
    if (this.timer !== null || !this.checksOn()) return;
    void this.readRegistry();
    this.timer = setInterval(() => { void this.readRegistry(); }, CHECK_EVERY_MS);
    this.timer.unref?.();
  }

  async readRegistry(): Promise<Check> {
    const setup = this.need();
    const at = this.now().toISOString();
    try {
      this.check = this.checkFrom(await this.releases(), at);
    } catch (error) {
      this.check = { at, ok: false, error: said(error) };
      this.log(`[update] Whether a newer connectome-host is out can't be told: ${said(error)}`);
      return this.check;
    }
    const candidate = this.check.candidate;
    if (candidate !== null && !this.logged.has(candidate)) {
      let installed: string | null = null;
      let unread: string | null = null;
      if (setup.here !== null) {
        try {
          installed = this.installedTarget();
        } catch (error) {
          unread = said(error);
        }
      }
      if (unread === null) this.logged.add(candidate);
      const lines = noticeLines(this.check, setup.running, setup.here !== null, this.hostWays(), installed);
      if (unread !== null) {
        lines.push(`Which releases are installed couldn't be read, so ${candidate} may be installed already: ${unread}`);
      }
      for (const line of lines) this.log(`[update] ${line}`);
    }
    return this.check;
  }

  async install(ways: UpdateWays = COMMAND_WAYS): Promise<UpdateAnswer> {
    const begun = await this.beginInstall(ways);
    return 'refusal' in begun ? begun.refusal : begun.installed;
  }

  async startInstall(ways: UpdateWays): Promise<UpdateAnswer> {
    const begun = await this.beginInstall(ways);
    if ('refusal' in begun) return begun.refusal;
    void begun.installed;
    return done(`Installing ${begun.version} beside ${this.need().running}, which runs on. ${ways.check} shows when it's done.`);
  }

  private async beginInstall(ways: UpdateWays):
    Promise<{ refusal: UpdateAnswer } | { version: string; installed: Promise<UpdateAnswer> }> {
    const setup = this.need();
    if (setup.here === null) return { refusal: refused(notAnInstall(ways)) };
    if (this.installing !== null) return { refusal: refused(`An install of ${this.installing} is under way.`) };
    if (this.restart !== null) return { refusal: refused(`${restartName(this.restart, true)} is under way.`) };
    if (this.endingSwitchQuiesce) return { refusal: refused(ENDING_SWITCH_QUIESCE) };
    const here = setup.here;
    const at = this.now().toISOString();
    this.installing = 'the newest release';
    let check: ReadCheck;
    try {
      check = this.check = this.checkFrom(await this.releases(), at);
    } catch (error) {
      this.check = { at, ok: false, error: said(error) };
      this.installing = null;
      return { refusal: refused(`Nothing was installed: ${said(error)}`) };
    }
    if (check.candidate === null) {
      this.installing = null;
      return { refusal: refused(`No release newer than ${setup.running} is offered, so nothing was installed: Update offers ` +
        'final releases that aren\'t deprecated.' +
        (check.runningDeprecated !== null ? ` ${deprecatedLine(setup.running, check.runningDeprecated)}` : '')) };
    }
    if (check.bunFloorUnmet !== null) {
      this.installing = null;
      return { refusal: refused(`${check.candidate} needs Bun ${check.bunFloorUnmet}, and this host runs on Bun ${this.bun()}, ` +
        `so nothing was installed. ${bunUpgrade(ways)}`) };
    }
    const version = check.candidate;
    this.installing = version;
    const installed = (async (): Promise<UpdateAnswer> => {
      try {
        await installRelease(here, version, setup.installOps ?? machineInstallOps(), this.armed === null ? [] : [this.armed.to]);
      } catch (error) {
        const why = error instanceof ContractError ? said(error) : `Installing ${version} failed: ${said(error)}`;
        this.lastInstall = { version, at, ok: false, error: why };
        return refused(why);
      } finally {
        this.installing = null;
      }
      this.lastInstall = { version, at, ok: true };
      return done(`${version} is installed beside ${setup.running}, which runs on. Restart switches to the newest release ` +
        `installed: ${ways.restart}.`);
    })();
    return { version, installed };
  }

  async restartToInstalled(expected?: string, ways: UpdateWays = COMMAND_WAYS): Promise<UpdateAnswer> {
    const refusal = this.restartRefusal(ways);
    if (refusal !== null) return refused(refusal);
    let to: string | null;
    try {
      to = this.installedTarget();
    } catch (error) {
      return refused(`Which releases are installed can't be read: ${said(error)}`);
    }
    if (to === null) {
      return refused(`No release newer than ${this.need().running} is installed: ${ways.install} installs one first.`);
    }
    if (expected !== undefined && to !== expected) {
      return refused(`The release installed to restart onto is now ${to}, not ${expected}, so nothing is restarting. ` +
        `Look at what ${to} costs, then ask again.`);
    }
    return this.beginRestart({ to, why: 'update', keepData: false }, ways);
  }

  async goBack(keepData: boolean, expected?: string, ways: UpdateWays = COMMAND_WAYS): Promise<UpdateAnswer> {
    const refusal = this.restartRefusal(ways);
    if (refusal !== null) return refused(refusal);
    const here = this.need().here!;
    let offer: { to: string } | null;
    try {
      offer = goBackOffer(here.root, here.release);
    } catch (error) {
      return refused(`Whether a Go back is offered can't be told: ${said(error)}`);
    }
    if (offer === null) return refused('No Go back is offered: the copy doesn\'t hold another installed release\'s data.');
    if (expected !== undefined && offer.to !== expected) {
      return refused(`Going back is now offered to ${offer.to}, not ${expected}, so nothing is going back. Look at what ` +
        'each way does, then ask again.');
    }
    return this.beginRestart({ to: offer.to, why: 'go-back', keepData }, ways);
  }

  armRestart(by: string | null, expected?: string, ways: UpdateWays = toolWays(this.need().headless === true)): UpdateAnswer {
    const refusal = this.armRefusal(ways);
    if (refusal !== null) return refused(refusal);
    let to: string | null;
    try {
      to = this.installedTarget();
    } catch (error) {
      return refused(`Nothing was armed: which releases are installed can't be read: ${said(error)}`);
    }
    if (to === null) {
      return refused(`Nothing was armed: no release newer than ${this.need().running} is installed, and ` +
        `${ways.install} installs one first.`);
    }
    if (expected !== undefined && to !== expected) {
      return refused(`Nothing was armed: the release installed to restart onto is ${to}, not ${expected}. ` +
        `${ways.check} shows what's installed and what's out, and ${ways.install} installs the newest ` +
        'release offered.');
    }
    return this.arm({ to, why: 'update', keepData: false }, by, ways);
  }

  armGoBack(
    keepData: boolean, by: string | null, expected?: string, ways: UpdateWays = toolWays(this.need().headless === true),
  ): UpdateAnswer {
    const refusal = this.armRefusal(ways);
    if (refusal !== null) return refused(refusal);
    const here = this.need().here!;
    let offer: { to: string; since: string } | null;
    try {
      offer = goBackOffer(here.root, here.release);
    } catch (error) {
      return refused(`Nothing was armed: whether a Go back is offered can't be told: ${said(error)}`);
    }
    if (offer === null) return refused('Nothing was armed: no Go back is offered, since the copy doesn\'t hold another installed release\'s data.');
    if (expected !== undefined && offer.to !== expected) {
      return refused(`Nothing was armed: going back is offered to ${offer.to}, not ${expected}. ${ways.check} shows ` +
        'what\'s offered, and back without `data` says what each way does.');
    }
    if (!keepData) {
      const held = this.restoreRefusal(ways);
      if (held !== null) return refused(`Nothing was armed: ${held} ${ways.keep} is open to you.`);
    }
    const armed = this.arm({ to: offer.to, why: 'go-back', keepData }, by, ways);
    if (keepData) return armed;
    return { ...armed, lines: [...armed.lines, `The copy it restores is as it was at ${offer.since}.`] };
  }

  /** Why a resident's restore is the person's here, or null where it's the
   *  resident's to arm: the copy holds the install's fleet children's data with
   *  its own, so a host with a fleet child, running or listed, or a copy that
   *  lists one, or any of those that can't be read, leaves restore to the
   *  person. */
  private restoreRefusal(ways: UpdateWays): string | null {
    const setup = this.need();
    const command = (ways as Partial<{ person: UpdateWays }>).person?.restore ?? ways.restore;
    const person = (what: string) => `restoring ${what} is the person's, with ${command}.`;
    let children: string[];
    try {
      children = fleetChildren(setup.here!.root, setup.host.fleet());
    } catch (error) {
      return `whether the copy it would restore holds a fleet child's data can't be told (${said(error)}), so ${person('it')}`;
    }
    if (children.length === 0) return null;
    return `this host has fleet children, now or at the last switch (${children.join(', ')}), so ${person('the copy')}`;
  }

  async cancelArmed(by: string | null = null, ways: UpdateWays = TOOL_WAYS): Promise<UpdateAnswer> {
    const armed = this.armed;
    if (armed === null) return done('Nothing was armed with lifecycle--update, so there was nothing to cancel.');
    if (this.trying) {
      return refused(`${armedName(armed)} is being tried now. Once the try has answered, ${ways.check} shows whether ` +
        'it went ahead, and cancel disarms it if it didn\'t.');
    }
    this.disarm(by ? `${by} cancelled it` : 'it was cancelled');
    const ended = await this.endLeftQuiesce();
    return done(`${armedName(armed)} is disarmed, and nothing restarts for it.` + (ended === null
      ? ' A switch\'s quiesce is being ended already, which also ends any quiesce an earlier try left.'
      : leftQuiesced(ended, false, ways)));
  }

  /** Whether this host is running a switch now: null where it can't tell, on a host with no install of its own,
   *  such as a fleet child, whose switch's quiesce comes from its parent. */
  switchUnderWay(): boolean | null {
    if (!this.setup?.here) return null;
    return this.restart !== null;
  }

  private hostWays(): UpdateWays {
    const setup = this.need();
    return setup.here !== null && setup.headless === true ? cliWays(installCommandAt(setup.here.root)) : COMMAND_WAYS;
  }

  armedSwitch(): ArmedSwitch | null {
    if (this.armed === null) return null;
    const last = this.armed.lastTry;
    return { ...this.armed, lastTry: last === null ? null : { ...last, hosts: [...last.hosts] } };
  }

  armedDue(): boolean {
    if (this.armed === null || this.trying) return false;
    if (this.armed.lastTry === null) return true;
    return this.now().getTime() - Date.parse(this.armed.lastTry.at) >= (this.need().waits?.armedRetryMs ?? ARMED_RETRY_MS);
  }

  async runArmed(stillQuiet: () => boolean): Promise<UpdateAnswer> {
    const armed = this.armed;
    if (armed === null || this.trying) return refused('No armed restart is waiting to be tried.');
    if (this.installing !== null) return this.stayArmed(`an install of ${this.installing} was under way.`, []);
    if (this.endingSwitchQuiesce) return this.stayArmed('a switch\'s quiesce was being ended.', []);
    this.trying = true;
    try {
      const setup = this.need();
      const here = setup.here!;
      const framework = setup.host.framework();
      const hold = operatorHold(framework.getHostModeStatus());
      if (hold !== null) return this.stayArmed(hold, []);
      const refusal = this.restartRefusal(this.hostWays());
      if (refusal !== null) return await this.dropArmed(refusal);
      let gone: string | null;
      try {
        const offered = armed.why === 'update' || goBackOffer(here.root, here.release)?.to === armed.to;
        const problem = offered ? hostProblem(releaseDir(here.root, armed.to), armed.to) : null;
        gone = !offered ? `going back to ${armed.to} is no longer offered.`
          : problem === null ? null : `${armed.to} can't be switched to: ${problem}`;
      } catch (error) {
        gone = `what it was armed for can't be read: ${said(error)}`;
      }
      if (gone !== null) return await this.dropArmed(gone);
      const held = armed.why === 'go-back' && !armed.keepData ? this.restoreRefusal(this.hostWays()) : null;
      if (held !== null) return await this.dropArmed(held);
      this.restart = { to: armed.to, why: armed.why, keepData: armed.keepData, phase: 'quiescing', hosts: [] };
      const fleet = setup.host.fleet();
      if ((fleet?.runningChildren().length ?? 0) > 0) {
        const children = await lookAtChildren(fleet, armed.to);
        if (setup.host.framework() !== framework) return await this.callOff(SESSION_CHANGED_AT_LOOK, this.hostWays());
        const childHeld = childHold(children);
        if (childHeld !== null) return await this.endAndStayArmed(children, childHeld);
        if (!children.every(settled)) {
          return await this.endAndStayArmed(children, operatorHold(framework.getHostModeStatus()));
        }
      }
      return await this.quiesceThenStop(0, stillQuiet, this.hostWays());
    } catch (error) {
      const why = `its try failed: ${said(error)}`;
      return this.restart !== null ? await this.callOff(why, this.hostWays()) : await this.dropArmed(why);
    } finally {
      this.trying = false;
    }
  }

  private arm(request: Pick<ArmedSwitch, 'to' | 'why' | 'keepData'>, by: string | null, ways: UpdateWays): UpdateAnswer {
    this.armed = { ...request, since: this.now().toISOString(), by, lastTry: null };
    this.armedDropped = null;
    return done(`${armedName(this.armed)} is armed. It begins at the host's first quiet moment, once ${QUIET_MOMENT}, ` +
      `${ASKS_NOBODY}. ${ARMED_RETRY} The host then stops, and its service starts it again on ${request.to}. If the host ` +
      'stops for any other reason first, nothing stays armed, and from its next start check says the ' +
      `${request.why === 'go-back' ? 'Go back' : 'restart'} didn't go ahead, with that stop as the reason, though a ` +
      'crash, a forced kill (SIGKILL) or a record the host can\'t write leaves no word of it. An operator\'s own ' +
      'Restart or Go back also takes its place. Until the host next starts, or until you arm another, check says when ' +
      'one didn\'t go ahead for another reason, and why. ' +
      `Until it begins, ${TOOL_CANCEL} disarms it. After the restart, ${ways.check} shows whether it committed or ` +
      'went back, and why' + (request.why === 'go-back'
        ? `, if ${request.to} has lifecycle--update; ${personWay(ways, 'check')} shows it either way.`
        : '.'));
  }

  private armRefusal(ways: UpdateWays): string | null {
    if (this.need().here === null) return NO_INSTALL_OF_ITS_OWN;
    if (this.stopper === null) return NO_STOP;
    if (this.stopper.stopping?.() === true) return STOPPING_NOW;
    if (!this.stopper.supervised) return IN_A_TERMINAL;
    if (!this.serviceLine) return NO_SERVICE;
    if (this.armed !== null) {
      return `Nothing was armed: ${armedName(this.armed, false)} is armed already, since ${this.armed.since}, and ` +
        `${TOOL_CANCEL} disarms it.`;
    }
    if (this.installing !== null) {
      return `Nothing was armed: an install of ${this.installing} is under way. Ask again once ${ways.check} shows ` +
        'it has ended.';
    }
    const refusal = this.restartRefusal(ways);
    return refusal === null ? null : `Nothing was armed: ${refusal.charAt(0).toLowerCase()}${refusal.slice(1)}`;
  }

  private async endAndStayArmed(hosts: HostQuiet[], hold: string | null = null): Promise<UpdateAnswer> {
    const restart = this.restart!;
    restart.phase = 'ending';
    restart.hosts = [];
    const ended = await this.endQuiesce();
    this.restart = null;
    const holding = hosts.filter((h) => !settled(h));
    const held = [
      ...(holding.some((h) => !h.answered) ? ['a host couldn\'t be counted'] : []),
      ...(holding.some((h) => h.answered && !h.drained) ? ['turns were still going'] : []),
      ...(holding.some((h) => h.answered && h.drained && h.backgroundScripts > 0) ? ['scripts were running outside any turn'] : []),
      ...(holding.some((h) => h.answered && h.inFlight !== undefined) ? ['a fleet child had work going outside any turn'] : []),
    ];
    const what = held.length > 1 ? `${held.slice(0, -1).join(', ')} and ${held.at(-1)}` : held[0] ?? 'this host had work in flight again';
    const waited = (hold ?? (ended.stuck === 0 ? `${what}, so the switch's quiesce ended.` : `${what}.`)) + leftQuiesced(ended, true, this.hostWays());
    return this.stayArmed(waited, hold !== null ? [] : holding);
  }

  private stayArmed(waited: string, hosts: HostQuiet[]): UpdateAnswer {
    const armed = this.armed!;
    armed.lastTry = { at: this.now().toISOString(), waited, hosts };
    return refused(`${armedName(armed)} stays armed for another quiet moment: ${waited}`);
  }

  private async dropArmed(reason: string): Promise<UpdateAnswer> {
    const armed = this.armed!;
    this.disarm(reason);
    const ended = await this.endLeftQuiesce();
    const dropped = this.armedDropped!;
    if (ended !== null) dropped.reason += leftQuiesced(ended, false, this.hostWays());
    return refused(`${armedName(armed)} didn't go ahead: ${dropped.reason}`);
  }

  private async endLeftQuiesce(): Promise<{ lines: string[]; stuck: number } | null> {
    if (this.endingSwitchQuiesce) return null;
    this.endingSwitchQuiesce = true;
    try {
      return await this.endQuiesce();
    } finally {
      this.endingSwitchQuiesce = false;
    }
  }

  private disarm(reason: string): void {
    const { to, why, keepData, since } = this.armed!;
    this.armed = null;
    this.armedDropped = { to, why, keepData, since, at: this.now().toISOString(), reason: reason.replace(/\.?$/, '.') };
  }

  async waitLonger(ways: UpdateWays = COMMAND_WAYS): Promise<UpdateAnswer> {
    if (this.restart?.phase !== 'busy') return refused(NO_WAIT_RAN_OUT);
    return this.quiesceThenStop(this.need().waits?.longerMs ?? WAIT_LONGER_MS, undefined, ways);
  }

  async stopNow(ways: UpdateWays = COMMAND_WAYS): Promise<UpdateAnswer> {
    if (this.restart?.phase !== 'busy') return refused(NO_WAIT_RAN_OUT);
    if (this.need().host.framework() !== this.quiescedFramework) return this.callOff(SESSION_CHANGED, ways);
    return this.markAndStop(ways);
  }

  async resume(ways: UpdateWays = COMMAND_WAYS): Promise<UpdateAnswer> {
    const restart = this.restart;
    if (restart !== null && restart.phase !== 'busy') return refused(`${restartName(restart, true)} is ${PHASE[restart.phase]}.`);
    if (restart !== null) return this.callOff(null, ways);
    if (this.endingSwitchQuiesce) return refused(ENDING_SWITCH_QUIESCE);
    this.endingSwitchQuiesce = true;
    let ended;
    try {
      ended = await this.endQuiesce();
    } finally {
      this.endingSwitchQuiesce = false;
    }
    const on = ended.ended.length > 0 ? `The switch's quiesce is ended on ${list(ended.ended)}` : null;
    const first = ended.stuck > 0
      ? on !== null ? `${on}, but not on every host.` : 'No restart is waiting, and the switch\'s quiesce couldn\'t be ended.'
      : on !== null ? `${on}.` : 'No restart is waiting, and no host was quiesced for a switch.';
    return ended.stuck > 0 ? refused(first, ...ended.lines, resumeAgain(ways)) : done(first, ...ended.lines);
  }

  status(): UpdateStatus {
    const setup = this.need();
    const problems: string[] = [];
    const read = <T>(what: string, run: () => T): T | null => {
      try {
        return run();
      } catch (error) {
        problems.push(`${what}: ${said(error)}`);
        return null;
      }
    };
    const here = setup.here;
    const quiesced = read('the host\'s serving state', () => setup.host.framework().getHostModeStatus());
    return {
      running: setup.running,
      install: here !== null,
      checks: this.timer !== null,
      check: this.check,
      installing: this.installing,
      lastInstall: this.lastInstall,
      installed: here === null ? null : read('which releases are installed', () => this.installedTarget()),
      goBack: here === null ? null : read(GO_BACK_UNREAD, () => goBackOffer(here.root, here.release)),
      restart: this.restart === null ? null : { ...this.restart, hosts: [...this.restart.hosts] },
      armed: this.armedSwitch(),
      armedDropped: this.armedDropped,
      operatorQuiesced: quiesced?.quiesced && !isSwitchQuiesce(quiesced.reason) ? quiesced.reason ?? 'no reason given' : null,
      switchQuiesceLeft: here !== null && quiesced?.quiesced === true && isSwitchQuiesce(quiesced.reason) && this.restart === null,
      lastSwitch: here === null ? null : read(LAST_SWITCH, () => lastSwitchOf(here.root, problems)),
      problems,
    };
  }

  private need(): UpdateSetup {
    if (this.setup === null) throw new Error('The host\'s update isn\'t set up: main() configures it at start.');
    return this.setup;
  }

  private now(): Date {
    return this.need().now?.() ?? new Date();
  }

  private bun(): string {
    return this.need().bun ?? Bun.version;
  }

  private log(line: string): void {
    (this.need().log ?? this.notices ?? ((text: string) => { console.error(text); }))(line);
  }

  private async releases(): Promise<Release[]> {
    const setup = this.need();
    return readReleases(registryOf(setup.env ?? process.env), setup.fetchManifest ?? fetch);
  }

  private checkFrom(releases: Release[], at: string): ReadCheck {
    const running = this.need().running;
    const candidate = candidateOf(releases, running);
    const costs = candidate === null ? [] : rangeOf(releases, running, candidate.version)
      .map(({ version, breaking, cacheWrite }) => ({ version, breaking, cacheWrite }));
    return {
      at, ok: true, candidate: candidate?.version ?? null, costs,
      bunFloorUnmet: candidate !== null && bunBelowFloor(candidate.bunFloor, this.bun()) === true ? candidate.bunFloor : null,
      runningDeprecated: releases.find((r) => r.version === running)?.deprecated ?? null,
    };
  }

  notesPointer(installed: string | null): string[] {
    const setup = this.need();
    if (setup.here === null || installed === null) return [];
    return [`For the notes of each release after ${setup.running} up to ${installed}: lifecycle--update notes reads ` +
      `them from ${notesPath(setup.here.root, installed)}.`];
  }

  installedNotes(version?: string, ways: UpdateWays = TOOL_WAYS): UpdateAnswer {
    const setup = this.need();
    if (setup.here === null) return refused(`No notes were given: ${notAnInstall(ways)}`);
    let installed: string | null;
    try {
      installed = this.installedTarget();
    } catch (error) {
      return refused(`No notes were given: which releases are installed can't be read: ${said(error)}`);
    }
    if (installed === null) {
      return refused(`No notes were given: no release newer than ${setup.running} is installed. ${ways.check} ` +
        'says what\'s out, with its notes link.');
    }
    return notesAnswer(notesPath(setup.here.root, installed), setup.running, installed, version);
  }

  private installedTarget(): string | null {
    const here = this.need().here!;
    const newer = readdirSync(installPaths(here.root).releases)
      .filter((name) => EXACT_VERSION.test(name) && Bun.semver.order(name, here.release) > 0 &&
        hostProblem(releaseDir(here.root, name), name) === null)
      .sort(Bun.semver.order);
    return newer.at(-1) ?? null;
  }

  private restartRefusal(ways: UpdateWays = COMMAND_WAYS): string | null {
    const here = this.need().here;
    if (here === null) return notAnInstall(ways);
    if (this.stopper === null) {
      return 'This host has no stop a restart can use: a batch run ends on its own, and the next start, once it has, ' +
        'runs whatever release is installed and asked for.';
    }
    if (this.installing !== null) return `An install of ${this.installing} is under way. Restart once it has ended.`;
    if (this.restart !== null) {
      return this.restart.phase === 'busy'
        ? `${restartName(this.restart, true)} is waiting on turns to end: ${ways.wait}, ${ways.now} or ` +
          `${ways.resume}.`
        : `${restartName(this.restart, true)} is ${PHASE[this.restart.phase]}.`;
    }
    if (this.endingSwitchQuiesce) return ENDING_SWITCH_QUIESCE;
    let current: string | null;
    try {
      current = readCurrent(here.root);
    } catch (error) {
      return `Which release the install runs on can't be read: ${said(error)}`;
    }
    if (current !== here.release) {
      return `This host runs ${here.release}, and the install's data runs on ${current ?? 'no release'}, so it ` +
        'can\'t restart onto another until a start of it commits.';
    }
    return null;
  }

  private async beginRestart(request: Pick<RestartState, 'to' | 'why' | 'keepData'>, ways: UpdateWays): Promise<UpdateAnswer> {
    this.restart = { ...request, phase: 'quiescing', hosts: [] };
    if (this.armed !== null) this.disarm(`an operator's ${request.why === 'go-back' ? 'Go back' : 'Restart'} took its place.`);
    return this.quiesceThenStop(this.need().waits?.restartMs ?? RESTART_QUIESCE_MS, undefined, ways);
  }

  private async quiesceThenStop(timeoutMs: number, armedQuiet: (() => boolean) | undefined, ways: UpdateWays): Promise<UpdateAnswer> {
    const setup = this.need();
    const restart = this.restart!;
    restart.phase = 'quiescing';
    restart.hosts = [];
    const framework = setup.host.framework();
    this.quiescedFramework = framework;
    let quiet;
    try {
      quiet = await quiesceForSwitch(framework, setup.host.fleet(), { to: restart.to, timeoutMs });
    } catch (error) {
      return this.callOff(`its quiesce was refused: ${said(error)}`, ways);
    }
    if (setup.host.framework() !== framework) return this.callOff(SESSION_CHANGED, ways);
    if (armedQuiet !== undefined) {
      const hold = operatorHold(framework.getHostModeStatus()) ?? childHold(quiet.hosts);
      if (hold !== null) return this.endAndStayArmed(quiet.hosts, hold);
      return quiet.drained && quiet.hosts.every(settled) && armedQuiet() ? this.markAndStop(ways) : this.endAndStayArmed(quiet.hosts);
    }
    if (quiet.drained) return this.markAndStop(ways);
    restart.phase = 'busy';
    restart.hosts = quiet.hosts;
    return refused(...busyLines(restart, timeoutMs, ways));
  }

  private async markAndStop(ways: UpdateWays): Promise<UpdateAnswer> {
    const setup = this.need();
    const restart = this.restart!;
    if (this.trying && this.stopper?.stopping?.() === true) return this.callOff(STOPPING_FIRST, ways);
    let unsynced: Error | null;
    try {
      const connected = this.quiescedFramework!.listMcplServers().filter((server) => server.connected).map((server) => server.id);
      ({ unsynced } = writeMark(setup.here!.root, {
        to: restart.to, why: restart.why, keepData: restart.keepData, connected, by: this.armed?.by ?? undefined,
      }, this.now()));
    } catch (error) {
      return this.callOff(`its mark couldn't be written: ${said(error)}`, ways);
    }
    restart.phase = 'stopping';
    restart.hosts = [];
    if (this.trying) this.armed = null;
    const stopper = this.stopper!;
    const going = restart.why === 'go-back' ? `go back to ${restart.to}` : `switch to ${restart.to}`;
    const farewell = (!stopper.supervised
      ? `Stopping to ${going}: once it has stopped, start the host again, and that start does it.`
      : this.serviceLine
        ? `Stopping to ${going}. The service starts the host again by itself, and that start does it.`
        : `Stopping to ${going}: the host's next start does it, which a service set up for updates makes by itself.`) +
      (unsynced !== null ? ` ${unsyncedText(unsynced)}` : '');
    stopper.stop(`update: ${going}`, farewell);
    return done(farewell);
  }

  private async callOff(why: string | null, ways: UpdateWays): Promise<UpdateAnswer> {
    const restart = this.restart!;
    restart.phase = 'ending';
    restart.hosts = [];
    const ended = await this.endQuiesce();
    this.restart = null;
    if (this.trying && this.armed !== null) {
      this.disarm((why ?? 'it was called off.').replace(/\.?$/, '.') + leftQuiesced(ended, false, this.hostWays()));
    }
    const first = why === null
      ? `${restartName(restart, true)} is called off, and nothing switches.`
      : `${restartName(restart, true)} is called off, and nothing switches: ${why}`;
    if (ended.stuck > 0) return refused(first, ...ended.lines, resumeAgain(ways));
    return why === null ? done(first, ...ended.lines) : refused(first, ...ended.lines);
  }

  private async endQuiesce(): Promise<{ ended: string[]; lines: string[]; stuck: number }> {
    const setup = this.need();
    try {
      const { hosts } = await resumeAfterSwitchQuiesce(setup.host.framework(), setup.host.fleet());
      const said = (h: { host: string; why?: string }) => `${h.host}: ${(h.why ?? 'it didn\'t say why').replace(/\.$/, '')}.`;
      const told = hosts.filter((h) => h.why !== undefined && h.why !== SERVING);
      const stuck = told.filter((h) => !h.resumed && !h.why!.startsWith(NOT_THE_SWITCHS));
      return { ended: hosts.filter((h) => h.resumed).map((h) => h.host), lines: told.map(said), stuck: stuck.length };
    } catch (error) {
      return { ended: [], lines: [`Ending the switch's quiesce failed, so hosts may still be quiesced: ${said(error)}`], stuck: 1 };
    }
  }
}

const SESSION_CHANGED = 'the session changed while turns were ending, so this host now serves one the restart didn\'t ' +
  'quiesce. Ask again.';
const SESSION_CHANGED_AT_LOOK = 'the session changed while the fleet\'s children were asked whether they were busy, ' +
  'before this host was quiesced, so the try ended there. Ask again.';
const resumeAgain = (ways: UpdateWays): string =>
  `For a host still quiesced, ${ways.resume} tries again, as does the host's next start.`;
const ENDING_SWITCH_QUIESCE = 'A switch\'s quiesce is being ended. Ask again once that has answered.';
const ASK_AGAIN = 'Asking again won\'t change that: whoever runs this host can.';
const NO_INSTALL_OF_ITS_OWN = 'Nothing was armed: this host has no install of its own to restart onto a release. A fleet ' +
  'child is updated with its parent\'s install where its parent has one, and any other host, or a child whose parent has ' +
  'none, by hand (docs/DEPLOYMENTS.md, "Updating an install"). ' +
  ASK_AGAIN;
const WRITES_ONE = '`connectome service install` writes such a service; docs/DEPLOYMENTS.md, "Updating an install", says ' +
  'what one written by hand needs.';
const IN_A_TERMINAL = 'Nothing was armed: this host runs in a terminal, not headless under a service, so a restart would ' +
  'stop it until someone started it again. A restart needs a headless host whose service sets ' +
  '`CONNECTOME_SUPERVISED=1` in its environment and starts it again when it exits with 75 and when it exits with 1. ' +
  `${WRITES_ONE} ${ASK_AGAIN}`;
const NO_SERVICE = 'Nothing was armed: nothing shows that a service starts this host again when it stops, so a restart ' +
  'could leave it down until someone starts it by hand. Ask whoever runs your host for a service that sets ' +
  '`CONNECTOME_SUPERVISED=1` in its environment, which says the service starts the host again when it exits with 75 ' +
  `and when it exits with 1. ${WRITES_ONE} ${ASK_AGAIN}`;
const NO_STOP = 'Nothing was armed: this host has no stop a restart can use, as in a batch run, which ends on its own. ' +
  ASK_AGAIN;
const STOPPING_FIRST = 'the host began stopping for another reason first.';
const STOPPING_NOW = 'Nothing was armed: this host is stopping, so nothing armed now could begin. Ask again once ' +
  'it has started again.';
const settled = (host: HostQuiet): boolean =>
  host.answered && host.drained && host.backgroundScripts === 0 && host.inFlight === undefined;
const childHold = (hosts: HostQuiet[]): string | null => {
  const held = hosts.flatMap((h) => h.answered && h.operatorHold !== undefined
    ? [`fleet child ${h.host} is quiesced by its operator${h.operatorHold.reason ? ` (${h.operatorHold.reason})` : ''}`] : []);
  return held.length === 0 ? null : `${held.join('; ')}.`;
};
const operatorHold = (status: { quiesced: boolean; reason?: string }): string | null =>
  status.quiesced && !isSwitchQuiesce(status.reason)
    ? `this host is quiesced by its operator${status.reason ? ` (${status.reason})` : ''}.`
    : null;
const leftQuiesced = (ended: { lines: string[]; stuck: number }, tryingAgain: boolean, ways: UpdateWays): string =>
  ended.stuck === 0 ? '' : ` Ending the switch's quiesce didn't reach every host: ${ended.lines.join(' ')} ` +
    `${ways.reader === 'agent' ? ways.resume.charAt(0).toUpperCase() + ways.resume.slice(1) : `An operator's ${ways.resume}`} ` +
    'ends it, as does the ' +
    `host's next start${tryingAgain ? ', and so does this restart\'s next try' : ''}.`;
const NO_WAIT_RAN_OUT = 'No restart\'s wait for turns to end has run out, so there is nothing to wait longer for or ' +
  'stop now.';

function takeDroppedArm(path: string, log: (line: string) => void): UpdateStatus['armedDropped'] {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log(`[update] ${path}, the record of an armed switch the last stop dropped, couldn't be read, so check can't say ` +
        `whether one was: ${said(error)}`);
    }
    return null;
  }
  try {
    unlinkSync(path);
  } catch (error) {
    log(`[update] ${path}, the record of an armed switch the last stop dropped, couldn't be removed, so a later start ` +
      `may say the same again: ${said(error)}`);
  }
  let read: Record<string, unknown> | null = null;
  try {
    read = JSON.parse(text);
  } catch {}
  const { to, why, keepData, since, at, reason } = read ?? {};
  if (typeof to === 'string' && (why === 'update' || why === 'go-back') && typeof keepData === 'boolean' &&
    typeof since === 'string' && typeof at === 'string' && typeof reason === 'string') {
    return { to, why, keepData, since, at, reason };
  }
  log(`[update] ${path} doesn't hold the record of an armed switch the last stop dropped, so check can't say whether ` +
    'one was.');
  return null;
}

export const hostUpdate = new HostUpdate();

/** The fleet children whose data a restore of the copy would set aside: those
 *  running, those the live children file lists, and those the copy's own
 *  children file lists. Throws where one of them can't be read. */
function fleetChildren(root: string, fleet: SwitchFleet | null): string[] {
  const names = new Set((fleet?.runningChildren() ?? []).map((child) => child.name));
  const listed = (path: string, what: string): void => {
    const file = readRecord<ChildrenFile>(path, what);
    if (file === null) return;
    if (!Array.isArray(file.children) || !file.children.every(isChildEntry)) {
      throw new ContractError(`The ${what} at ${path} has no list of children this release can read.`);
    }
    for (const child of file.children) names.add(child.name);
  };
  const { dataDir } = readInstallRecord(root);
  listed(childrenFilePath(dataDir), "fleet's children file");
  const label = lastCopy(root);
  if (label !== null) {
    const data = realOrResolved(dataDir);
    const holds = (item: { path: string }) => item.path === data || isUnder(data, item.path);
    const item = label.items.find(holds);
    if (item !== undefined) {
      listed(childrenFilePath(join(installPaths(root).copy, item.name, relative(item.path, data))), "copy's fleet children file");
    } else if (!(label.absent ?? []).some(holds)) {
      throw new ContractError(`The copy's label lists no item that holds the data directory ${data}.`);
    }
  }
  return [...names].sort();
}

export function lastSwitchOf(root: string, problems: string[] = []): SwitchOutcome | null {
  const lines = readJournal(root);
  for (let at = lines.length - 1; at >= 0; at--) {
    const line = lines[at]!;
    if (line.step === 'commit' && line.outcome === 'ok') {
      let trial = at - 1;
      while (trial >= 0 && !(lines[trial]!.step === 'trial-start' && lines[trial]!.outcome === 'ok')) trial--;
      return { outcome: 'committed', from: line.from, to: line.to, at: line.at, ...askedBy(lines[trial]?.by) };
    }
    if (line.step === 'fallback' && line.outcome === 'ok') {
      let trialLog: string[] | null = null;
      try {
        trialLog = readTrialLog(root, line);
      } catch (error) {
        problems.push(`${line.from}'s last lines: ${said(error)}`);
      }
      return {
        outcome: 'fell-back', from: line.to, to: line.from, at: line.at, reason: line.reason ?? 'it gave no reason', trialLog,
        ...askedBy(line.by),
      };
    }
    if (line.outcome !== 'ok') {
      return {
        outcome: 'refused', step: line.step, from: line.from, to: line.to, at: line.at, reason: line.reason ?? 'it gave no reason',
        ...askedBy(line.by),
      };
    }
  }
  return null;
}

export function hostVersionOf(packageJson: URL): string {
  const path = fileURLToPath(packageJson);
  let text: string;
  try {
    text = readWithoutWaiting(path);
  } catch (error) {
    throw new Error(`${path} can't be read (${(error as Error).message})`);
  }
  const version = (JSON.parse(text) as { version?: unknown }).version;
  if (typeof version !== 'string') throw new Error(`${packageJson.pathname} names no version.`);
  return version;
}
