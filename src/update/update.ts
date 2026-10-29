import { readdirSync, readFileSync } from 'node:fs';
import { bunBelowFloor } from '../bun-floor.js';
import {
  ContractError, installPaths, isSwitchQuiesce, readCurrent, readJournal, releaseDir, unsyncedText, writeMark,
} from './contract.js';
import type { ReleaseHere } from './host.js';
import { EXACT_VERSION, hostProblem, installRelease, machineInstallOps, type InstallOps } from './install.js';
import { goBackOffer } from './launcher.js';
import {
  NOT_THE_SWITCHS, SERVING, quiesceForSwitch, resumeAfterSwitchQuiesce, type QuiesceFramework, type SwitchFleet,
} from './quiesce.js';
import { candidateOf, rangeOf, readReleases, registryOf, type Release } from './releases.js';
import { readTrialLog } from './trial-log.js';
import {
  COMMAND_WAYS, GO_BACK_UNREAD, NOT_AN_INSTALL, PHASE, busyLines, deprecatedLine, noticeLines, restartName, type Check,
  type ReadCheck,
  type RestartState,
  type SwitchOutcome, type UpdateStatus,
} from '../web/update-text.js';

const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const RESTART_QUIESCE_MS = 120_000;
const WAIT_LONGER_MS = 600_000;

export interface UpdateHost {
  framework(): QuiesceFramework;
  fleet(): SwitchFleet | null;
}

export interface HostStop {
  supervised: boolean;
  stop(reason: string, farewell: string): void;
}

export interface UpdateSetup {
  here: ReleaseHere | null;
  running: string;
  host: UpdateHost;
  env?: Record<string, string | undefined>;
  bun?: string;
  fetchManifest?: typeof fetch;
  installOps?: InstallOps;
  now?: () => Date;
  log?: (line: string) => void;
  waits?: { restartMs: number; longerMs: number };
}

export interface UpdateAnswer {
  done: boolean;
  lines: string[];
}

const said = (error: unknown): string => error instanceof Error ? error.message : String(error);
const refused = (...lines: string[]): UpdateAnswer => ({ done: false, lines });
const done = (...lines: string[]): UpdateAnswer => ({ done: true, lines });
const list = (versions: string[]): string => versions.join(', ');

export class HostUpdate {
  private setup: UpdateSetup | null = null;
  private stopper: HostStop | null = null;
  private notices: ((line: string) => void) | null = null;
  private check: Check | null = null;
  private readonly logged = new Set<string>();
  private installing: string | null = null;
  private lastInstall: UpdateStatus['lastInstall'] = null;
  private restart: RestartState | null = null;
  private quiescedFramework: QuiesceFramework | null = null;
  private endingSwitchQuiesce = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  configure(setup: UpdateSetup): void {
    this.setup = setup;
  }

  attachStop(stop: HostStop): void {
    this.stopper = stop;
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
      this.logged.add(candidate);
      for (const line of noticeLines(this.check, setup.running, setup.here !== null)) this.log(`[update] ${line}`);
    }
    return this.check;
  }

  async install(): Promise<UpdateAnswer> {
    const setup = this.need();
    if (setup.here === null) return refused(NOT_AN_INSTALL);
    if (this.installing !== null) return refused(`An install of ${this.installing} is under way.`);
    if (this.restart !== null) return refused(`${restartName(this.restart, true)} is under way.`);
    if (this.endingSwitchQuiesce) return refused(ENDING_SWITCH_QUIESCE);
    const here = setup.here;
    const at = this.now().toISOString();
    this.installing = 'the newest release';
    try {
      let check: ReadCheck;
      try {
        check = this.check = this.checkFrom(await this.releases(), at);
      } catch (error) {
        this.check = { at, ok: false, error: said(error) };
        return refused(`Nothing was installed: ${said(error)}`);
      }
      if (check.candidate === null) {
        return refused(`No release newer than ${setup.running} is offered, so nothing was installed: Update offers ` +
          'final releases that aren\'t deprecated.' +
          (check.runningDeprecated !== null ? ` ${deprecatedLine(setup.running, check.runningDeprecated)}` : ''));
      }
      if (check.bunFloorUnmet !== null) {
        return refused(`${check.candidate} needs Bun ${check.bunFloorUnmet}, and this host runs on Bun ${this.bun()}, so ` +
          'nothing was installed. Upgrade Bun (`bun upgrade`, or the package manager that installed it), start the ' +
          'host again, then Update.');
      }
      const version = check.candidate;
      this.installing = version;
      try {
        await installRelease(here, version, setup.installOps ?? machineInstallOps());
      } catch (error) {
        const why = error instanceof ContractError ? said(error) : `Installing ${version} failed: ${said(error)}`;
        this.lastInstall = { version, at, ok: false, error: why };
        return refused(why);
      }
      this.lastInstall = { version, at, ok: true };
      return done(`${version} is installed beside ${setup.running}, which runs on. Restart switches to the newest release ` +
        'installed: /update restart.');
    } finally {
      this.installing = null;
    }
  }

  async restartToInstalled(expected?: string): Promise<UpdateAnswer> {
    const refusal = this.restartRefusal();
    if (refusal !== null) return refused(refusal);
    let to: string | null;
    try {
      to = this.installedTarget();
    } catch (error) {
      return refused(`Which releases are installed can't be read: ${said(error)}`);
    }
    if (to === null) return refused(`No release newer than ${this.need().running} is installed: Update installs one first.`);
    if (expected !== undefined && to !== expected) {
      return refused(`The release installed to restart onto is now ${to}, not ${expected}, so nothing is restarting. ` +
        `Look at what ${to} costs, then ask again.`);
    }
    return this.beginRestart({ to, why: 'update', keepData: false });
  }

  async goBack(keepData: boolean, expected?: string): Promise<UpdateAnswer> {
    const refusal = this.restartRefusal();
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
    return this.beginRestart({ to: offer.to, why: 'go-back', keepData });
  }

  async waitLonger(): Promise<UpdateAnswer> {
    if (this.restart?.phase !== 'busy') return refused(NO_WAIT_RAN_OUT);
    return this.quiesceThenStop(this.need().waits?.longerMs ?? WAIT_LONGER_MS);
  }

  async stopNow(): Promise<UpdateAnswer> {
    if (this.restart?.phase !== 'busy') return refused(NO_WAIT_RAN_OUT);
    if (this.need().host.framework() !== this.quiescedFramework) return this.callOff(SESSION_CHANGED);
    return this.markAndStop();
  }

  async resume(): Promise<UpdateAnswer> {
    const restart = this.restart;
    if (restart !== null && restart.phase !== 'busy') return refused(`${restartName(restart, true)} is ${PHASE[restart.phase]}.`);
    if (restart !== null) return this.callOff(null);
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
    return ended.stuck > 0 ? refused(first, ...ended.lines, RESUME_AGAIN) : done(first, ...ended.lines);
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
      operatorQuiesced: quiesced?.quiesced && !isSwitchQuiesce(quiesced.reason) ? quiesced.reason ?? 'no reason given' : null,
      switchQuiesceLeft: here !== null && quiesced?.quiesced === true && isSwitchQuiesce(quiesced.reason) && this.restart === null,
      lastSwitch: here === null ? null : read('the last switch', () => lastSwitchOf(here.root, problems)),
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

  private installedTarget(): string | null {
    const here = this.need().here!;
    const newer = readdirSync(installPaths(here.root).releases)
      .filter((name) => EXACT_VERSION.test(name) && Bun.semver.order(name, here.release) > 0 &&
        hostProblem(releaseDir(here.root, name), name) === null)
      .sort(Bun.semver.order);
    return newer.at(-1) ?? null;
  }

  private restartRefusal(): string | null {
    const here = this.need().here;
    if (here === null) return NOT_AN_INSTALL;
    if (this.stopper === null) {
      return 'This host has no stop a restart can use: a batch run ends on its own, and the next start, once it has, ' +
        'runs whatever release is installed and asked for.';
    }
    if (this.installing !== null) return `An install of ${this.installing} is under way. Restart once it has ended.`;
    if (this.restart !== null) {
      return this.restart.phase === 'busy'
        ? `${restartName(this.restart, true)} is waiting on turns to end: ${COMMAND_WAYS.wait}, ${COMMAND_WAYS.now} or ` +
          `${COMMAND_WAYS.resume}.`
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

  private async beginRestart(request: Pick<RestartState, 'to' | 'why' | 'keepData'>): Promise<UpdateAnswer> {
    this.restart = { ...request, phase: 'quiescing', hosts: [] };
    return this.quiesceThenStop(this.need().waits?.restartMs ?? RESTART_QUIESCE_MS);
  }

  private async quiesceThenStop(timeoutMs: number): Promise<UpdateAnswer> {
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
      return this.callOff(`its quiesce was refused: ${said(error)}`);
    }
    if (setup.host.framework() !== framework) return this.callOff(SESSION_CHANGED);
    if (quiet.drained) return this.markAndStop();
    restart.phase = 'busy';
    restart.hosts = quiet.hosts;
    return refused(...busyLines(restart, timeoutMs));
  }

  private async markAndStop(): Promise<UpdateAnswer> {
    const setup = this.need();
    const restart = this.restart!;
    let unsynced: Error | null;
    try {
      ({ unsynced } = writeMark(setup.here!.root, { to: restart.to, why: restart.why, keepData: restart.keepData }, this.now()));
    } catch (error) {
      return this.callOff(`its mark couldn't be written: ${said(error)}`);
    }
    restart.phase = 'stopping';
    restart.hosts = [];
    const stopper = this.stopper!;
    const going = restart.why === 'go-back' ? `go back to ${restart.to}` : `switch to ${restart.to}`;
    const farewell = (stopper.supervised
      ? `Stopping to ${going}: the host's next start does it, which a service set up for updates makes by itself.`
      : `Stopping to ${going}: once it has stopped, start the host again, and that start does it.`) +
      (unsynced !== null ? ` ${unsyncedText(unsynced)}` : '');
    stopper.stop(`update: ${going}`, farewell);
    return done(farewell);
  }

  private async callOff(why: string | null): Promise<UpdateAnswer> {
    const restart = this.restart!;
    restart.phase = 'ending';
    restart.hosts = [];
    const ended = await this.endQuiesce();
    this.restart = null;
    const first = why === null
      ? `${restartName(restart, true)} is called off, and nothing switches.`
      : `${restartName(restart, true)} is called off, and nothing switches: ${why}`;
    if (ended.stuck > 0) return refused(first, ...ended.lines, RESUME_AGAIN);
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
const RESUME_AGAIN = 'For a host still quiesced, /update restart resume tries again, as does the host\'s next start.';
const ENDING_SWITCH_QUIESCE = 'A switch\'s quiesce is being ended. Ask again once that has answered.';
const NO_WAIT_RAN_OUT = 'No restart\'s wait for turns to end has run out, so there is nothing to wait longer for or ' +
  'stop now.';

export const hostUpdate = new HostUpdate();

export function lastSwitchOf(root: string, problems: string[] = []): SwitchOutcome | null {
  const lines = readJournal(root);
  for (let at = lines.length - 1; at >= 0; at--) {
    const line = lines[at]!;
    if (line.step === 'commit' && line.outcome === 'ok') return { outcome: 'committed', from: line.from, to: line.to, at: line.at };
    if (line.step === 'fallback' && line.outcome === 'ok') {
      let trialLog: string[] | null = null;
      try {
        trialLog = readTrialLog(root, line);
      } catch (error) {
        problems.push(`${line.from}'s last lines: ${said(error)}`);
      }
      return {
        outcome: 'fell-back', from: line.to, to: line.from, at: line.at, reason: line.reason ?? 'it gave no reason', trialLog,
      };
    }
    if (line.outcome !== 'ok') {
      return { outcome: 'refused', step: line.step, from: line.from, to: line.to, at: line.at, reason: line.reason ?? 'it gave no reason' };
    }
  }
  return null;
}

export function hostVersionOf(packageJson: URL): string {
  const version = (JSON.parse(readFileSync(packageJson, 'utf-8')) as { version?: unknown }).version;
  if (typeof version !== 'string') throw new Error(`${packageJson.pathname} names no version.`);
  return version;
}
