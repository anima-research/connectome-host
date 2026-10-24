/**
 * The host's side of updating an install (contract.ts): the notice, Update,
 * Restart and Go back, which the `/update` commands call, and the `update`
 * section of /healthz. One per process (hostUpdate): main()
 * configures it at start, and the mode the host runs in tells it how this
 * host stops (attachStop).
 *
 * - **The notice:** at start and every 24 h, the host reads the registry
 *   (releases.ts) and logs one `[update]` line for each newer release it
 *   sees, with what the releases between cost. CONNECTOME_UPDATE_CHECK=0 or
 *   NO_UPDATE_NOTIFIER turns that off. The fleet starts its children with
 *   the first, and a batch run doesn't read it.
 * - **Update** installs the newest release beside the running one
 *   (installRelease) once its checks pass, and changes nothing else.
 * - **Restart** quiesces this host and its fleet's children (quiesce.ts).
 *   Once they drain, or the operator chooses to stop now, it writes the mark
 *   and stops the host. A supervised host exits 75, and the service's next
 *   start switches through the launcher. A host no supervisor restarts stops
 *   as /quit does, and the operator starts it again. Until the mark is
 *   written, no start switches release: a crash or an agent's own restart
 *   before then starts the same release again.
 * - **Go back** is Restart toward the release the copy holds the data of
 *   (goBackOffer), keeping the newer data or restoring the copy.
 *
 * A host started without an install's entry point can't update itself. Its
 * notice points at DEPLOYMENTS.md's "Updating an install" instead.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { bunBelowFloor } from '../bun-floor.js';
import { installPaths, isSwitchQuiesce, readCurrent, readJournal, releaseDir, unsyncedText, writeMark } from './contract.js';
import type { ReleaseHere } from './host.js';
import { EXACT_VERSION, hostProblem, installRelease, machineInstallOps, type InstallOps } from './install.js';
import { goBackOffer } from './launcher.js';
import {
  quiesceForSwitch, resumeAfterSwitchQuiesce, type HostQuiet, type QuiesceFramework, type SwitchFleet,
} from './quiesce.js';
import { candidateOf, rangeOf, readReleases, registryOf, type Release } from './releases.js';
import { readTrialLog } from './trial-log.js';

/** How often a running host reads the registry again. */
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
/** How long Restart lets turns in progress end before asking the operator. */
const RESTART_QUIESCE_MS = 120_000;
/** How long "wait longer" waits. */
const WAIT_LONGER_MS = 600_000;

/** Where a release's notes are: its CHANGELOG at its tag. */
export function notesUrl(version: string): string {
  return `https://github.com/anima-research/connectome-host/blob/v${version}/CHANGELOG.md`;
}

const NOT_AN_INSTALL = 'This host wasn\'t started through an install\'s entry point, so it can\'t update itself. ' +
  'docs/DEPLOYMENTS.md, "Updating an install", says how to update it by hand, and how one setup makes an install ' +
  'update itself from then on.';

/** What Restart reaches of the host: whatever it runs now, since a session
 *  switch replaces the framework. */
export interface UpdateHost {
  framework(): QuiesceFramework;
  fleet(): SwitchFleet | null;
}

/** How this host stops for a restart, attached by the mode it runs in: a
 *  supervised stop exits for the service to start it again, and any other
 *  stops as /quit does, leaving the operator to start it. `farewell` is the
 *  line for whoever watches it go. */
export interface HostStop {
  supervised: boolean;
  stop(reason: string, farewell: string): void;
}

export interface UpdateSetup {
  here: ReleaseHere | null;
  /** This host's version. */
  running: string;
  host: UpdateHost;
  env?: Record<string, string | undefined>;
  bun?: string;
  fetchManifest?: typeof fetch;
  installOps?: InstallOps;
  now?: () => Date;
  /** A line for the host's log. */
  log?: (line: string) => void;
  /** How long Restart's quiesce and "wait longer" wait, for a test. */
  waits?: { restartMs: number; longerMs: number };
}

/** What one version in an update's range records of its cost. */
export type Cost = Pick<Release, 'version' | 'breaking' | 'cacheWrite'>;

/** A read of the registry that succeeded. */
export interface ReadCheck {
  at: string;
  ok: true;
  /** The release Update would install, or null when none is newer. */
  candidate: string | null;
  /** Every version from the running one to the candidate (rangeOf). */
  costs: Cost[];
  /** The candidate's Bun floor when this Bun is below it. */
  bunFloorUnmet: string | null;
  /** npm's message when the running release is deprecated. */
  runningDeprecated: string | null;
}

/** The last read of the registry. */
export type Check = ReadCheck | { at: string; ok: false; error: string };

/** How the last switch or Go back ended, by the journal. A fallback carries
 *  the last lines the failed release kept itself (trial-log.ts), or null when
 *  it kept none. */
export type SwitchOutcome =
  | { outcome: 'committed'; from: string; to: string; at: string }
  | { outcome: 'fell-back'; from: string; to: string; at: string; reason: string; trialLog: string[] | null }
  | { outcome: 'refused'; step: string; from: string; to: string; at: string; reason: string };

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
  /** The reason the operator quiesced this host under, which it keeps
   *  through a restart. */
  operatorQuiesced: string | null;
  /** This install's host is quiesced for a switch no restart is carrying
   *  out, as when ending that quiesce failed: `/update restart resume` ends it. */
  switchQuiesceLeft: boolean;
  lastSwitch: SwitchOutcome | null;
  /** What couldn't be read for this status. */
  problems: string[];
}

/** An answer to a request: whether it did what was asked, and what to say. */
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
  private check: Check | null = null;
  private readonly logged = new Set<string>();
  private installing: string | null = null;
  private lastInstall: UpdateStatus['lastInstall'] = null;
  private restart: RestartState | null = null;
  /** The framework the restart's last quiesce was of. */
  private quiescedFramework: QuiesceFramework | null = null;
  /** A resume with no restart under way is ending a switch's quiesce. */
  private endingLeft = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  configure(setup: UpdateSetup): void {
    this.setup = setup;
  }

  attachStop(stop: HostStop): void {
    this.stopper = stop;
  }

  /** Whether the host reads the registry on its own. */
  checksOn(): boolean {
    const env = this.need().env ?? process.env;
    return env.CONNECTOME_UPDATE_CHECK !== '0' && !env.NO_UPDATE_NOTIFIER;
  }

  /** Read the registry now, unawaited, and every 24 h on a timer that
   *  doesn't keep the process alive, unless checks are off. */
  startChecks(): void {
    if (this.timer !== null || !this.checksOn()) return;
    void this.readRegistry();
    this.timer = setInterval(() => { void this.readRegistry(); }, CHECK_EVERY_MS);
    this.timer.unref?.();
  }

  /** Read the registry, keep what it says, and log the notice the first
   *  time each newer release is seen, or why the read failed. */
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

  /**
   * Update: read the registry again, and install the newest release beside
   * the running one, once its checks pass. A deprecated release is never
   * the candidate, nothing older than the running release is offered, and a
   * release whose Bun floor this Bun is below isn't installed.
   */
  async install(): Promise<UpdateAnswer> {
    const setup = this.need();
    if (setup.here === null) return refused(NOT_AN_INSTALL);
    if (this.installing !== null) return refused(`An install of ${this.installing} is under way.`);
    if (this.restart !== null) return refused(`A restart to ${this.restart.to} is under way.`);
    if (this.endingLeft) return refused(ENDING_LEFT);
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
          (check.runningDeprecated !== null ? ` ${setup.running} is deprecated on npm: ${check.runningDeprecated}` : ''));
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
        this.lastInstall = { version, at, ok: false, error: said(error) };
        return refused(said(error));
      }
      this.lastInstall = { version, at, ok: true };
      return done(`${version} is installed beside ${setup.running}, and nothing else has changed. Restart to run it: ` +
        '/update restart.');
    } finally {
      this.installing = null;
    }
  }

  /** Restart onto the newest release installed beside this one. */
  async restartToInstalled(): Promise<UpdateAnswer> {
    const refusal = this.restartRefusal();
    if (refusal !== null) return refused(refusal);
    let to: string | null;
    try {
      to = this.installedTarget();
    } catch (error) {
      return refused(`Which releases are installed can't be read: ${said(error)}`);
    }
    if (to === null) return refused(`No release newer than ${this.need().running} is installed: Update installs one first.`);
    return this.beginRestart({ to, why: 'update', keepData: false });
  }

  /** Go back to the release the copy holds the data of, keeping the newer
   *  data or restoring the copy. */
  async goBack(keepData: boolean): Promise<UpdateAnswer> {
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
    return this.beginRestart({ to: offer.to, why: 'go-back', keepData });
  }

  /** After a quiesce that didn't drain: wait up to 10 minutes more. */
  async waitLonger(): Promise<UpdateAnswer> {
    if (this.restart?.phase !== 'busy') return refused(NO_WAIT_RAN_OUT);
    return this.quiesceThenStop(this.need().waits?.longerMs ?? WAIT_LONGER_MS);
  }

  /** After a quiesce that didn't drain: stop now, cutting off the turns
   *  still in progress. */
  async stopNow(): Promise<UpdateAnswer> {
    if (this.restart?.phase !== 'busy') return refused(NO_WAIT_RAN_OUT);
    if (this.need().host.framework() !== this.quiescedFramework) return this.callOff(SESSION_CHANGED);
    return this.markAndStop();
  }

  /**
   * Try later: end the switch's quiesce on every host, calling off a restart
   * that waits on turns. With no restart under way, it ends a switch's
   * quiesce left standing, as when an earlier try couldn't.
   */
  async resume(): Promise<UpdateAnswer> {
    const restart = this.restart;
    if (restart !== null && restart.phase !== 'busy') return refused(`A restart to ${restart.to} is ${PHASE[restart.phase]}.`);
    if (restart !== null) return this.callOff(null);
    if (this.endingLeft) return refused(ENDING_LEFT);
    this.endingLeft = true;
    let ended;
    try {
      ended = await this.endQuiesce();
    } finally {
      this.endingLeft = false;
    }
    const on = ended.ended.length > 0 ? `The switch's quiesce is ended on ${list(ended.ended)}` : null;
    const first = ended.stuck > 0
      ? on !== null ? `${on}, but not on every host.` : 'No restart is waiting, and the switch\'s quiesce couldn\'t be ended.'
      : on !== null ? `${on}.` : 'No restart is waiting, and no host was quiesced for a switch.';
    return ended.stuck > 0 ? refused(first, ...ended.lines, RESUME_AGAIN) : done(first, ...ended.lines);
  }

  /** The update section of /healthz, and what `/update` shows. Never throws:
   *  what can't be read is named in `problems`. */
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
      // A fleet child's switch quiesce is its parent's restart's.
      switchQuiesceLeft: here !== null && quiesced?.quiesced === true && isSwitchQuiesce(quiesced.reason) && this.restart === null,
      lastSwitch: here === null ? null : read('the last switch', () => lastSwitchOf(here.root, problems)),
      problems,
    };
  }

  // -------------------------------------------------------------------------

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
    (this.need().log ?? ((text: string) => { console.error(text); }))(line);
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

  /** The newest release in releases/ that's newer than this one and whose
   *  host is in place there, or null. */
  private installedTarget(): string | null {
    const here = this.need().here!;
    const newer = readdirSync(installPaths(here.root).releases)
      .filter((name) => EXACT_VERSION.test(name) && Bun.semver.order(name, here.release) > 0 &&
        hostProblem(releaseDir(here.root, name), name) === null)
      .sort(Bun.semver.order);
    return newer.at(-1) ?? null;
  }

  /** Why no restart can begin now, or null. */
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
        ? `The restart to ${this.restart.to} is waiting on turns to end: wait longer, stop now, or resume.`
        : `A restart to ${this.restart.to} is ${PHASE[this.restart.phase]}.`;
    }
    if (this.endingLeft) return ENDING_LEFT;
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

  /** Quiesce for the switch and wait up to `timeoutMs`: once every host has
   *  drained, write the mark and stop; otherwise say who is still busy. */
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
      // A child may have quiesced before this host's own quiesce threw.
      return this.callOff(`its quiesce was refused: ${said(error)}`);
    }
    // A session switch meanwhile replaced what drained.
    if (setup.host.framework() !== framework) return this.callOff(SESSION_CHANGED);
    if (quiet.drained) return this.markAndStop();
    restart.phase = 'busy';
    restart.hosts = quiet.hosts;
    return refused(...busyLines(restart, timeoutMs));
  }

  /** Write the mark, then stop. A mark that can't be written calls the
   *  restart off, since nothing would switch. */
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

  /** Call the restart off: end the switch's quiesce on every host, saying any
   *  that stayed quiesced, with `why` it was called off, or null for the
   *  operator's resume. Nothing else acts on the restart meanwhile. */
  private async callOff(why: string | null): Promise<UpdateAnswer> {
    const restart = this.restart!;
    restart.phase = 'ending';
    restart.hosts = [];
    const ended = await this.endQuiesce();
    this.restart = null;
    const first = why === null
      ? `The restart to ${restart.to} is called off, and nothing switches.`
      : `The restart to ${restart.to} is called off, and nothing switches: ${why}`;
    if (ended.stuck > 0) return refused(first, ...ended.lines, RESUME_AGAIN);
    return why === null ? done(first, ...ended.lines) : refused(first, ...ended.lines);
  }

  /** End the switch's quiesce on each host: the hosts it ended, a line for
   *  each host with something to say, and how many stayed quiesced. */
  private async endQuiesce(): Promise<{ ended: string[]; lines: string[]; stuck: number }> {
    const setup = this.need();
    try {
      const { hosts } = await resumeAfterSwitchQuiesce(setup.host.framework(), setup.host.fleet());
      const said = (h: { host: string; why?: string }) => `${h.host}: ${(h.why ?? 'it didn\'t say why').replace(/\.$/, '')}.`;
      // A host that was serving has nothing to say. One whose quiesce isn't
      // the switch's keeps it, as it should, and one that resumed may still
      // have something to say, as when its resume failed after its quiesce
      // ended. The rest stayed quiesced for the switch.
      const told = hosts.filter((h) => h.why !== undefined && h.why !== SERVING);
      const stuck = told.filter((h) => !h.resumed && !h.why!.startsWith(NOT_THE_SWITCHS));
      return { ended: hosts.filter((h) => h.resumed).map((h) => h.host), lines: told.map(said), stuck: stuck.length };
    } catch (error) {
      return { ended: [], lines: [`Ending the switch's quiesce failed, so hosts may still be quiesced: ${said(error)}`], stuck: 1 };
    }
  }
}

/** How resumeIfSwitch (quiesce.ts) answers for a host that was serving, and
 *  begins its answer for one quiesced by someone else, which keeps it. */
const SERVING = 'it was serving';
const NOT_THE_SWITCHS = 'its quiesce isn\'t the switch\'s';

/** What status() names an unreadable Go back offer by. */
const GO_BACK_UNREAD = 'whether a Go back is offered';

const SESSION_CHANGED = 'the session changed while turns were ending, so this host now serves one the restart didn\'t ' +
  'quiesce. Ask again.';
const RESUME_AGAIN = 'For a host still quiesced, /update restart resume tries again, as does the host\'s next start.';
const ENDING_LEFT = 'A switch\'s quiesce is being ended. Ask again once that has answered.';
/** Wait longer and stop now are for a restart whose wait has run out. */
const NO_WAIT_RAN_OUT = 'No restart\'s wait for turns to end has run out, so there is nothing to wait longer for or ' +
  'stop now.';

/** What a restart is doing, in each phase but busy, which says more. */
const PHASE: Record<Exclude<RestartState['phase'], 'busy'>, string> = {
  quiescing: 'waiting for turns to end, with new turns held',
  stopping: 'stopping the host, for its next start',
  ending: 'being called off, ending the switch\'s quiesce',
};

/** The process's update: main() configures it, a mode attaches its stop. */
export const hostUpdate = new HostUpdate();

// ---------------------------------------------------------------------------
// What it says
// ---------------------------------------------------------------------------

/** The notice for a check that found a newer release. */
export function noticeLines(check: ReadCheck, running: string, install: boolean): string[] {
  if (check.candidate === null) return [];
  const lines = [`connectome-host ${check.candidate} is out; this host runs ${running}.`];
  const where = (pick: (cost: Cost) => boolean) => check.costs.filter(pick).map((cost) => cost.version);
  const breaking = where((c) => c.breaking === true);
  const unrecorded = where((c) => c.breaking === null);
  const rewrites = where((c) => c.cacheWrite === true);
  const unmeasured = where((c) => c.breaking !== null && c.cacheWrite === null);
  lines.push(breaking.length > 0
    ? `Breaking: ${list(breaking)}. Read its notes before updating.`
    : unrecorded.length === 0 ? 'None of the releases since this one is breaking.' : 'None that records it is breaking.');
  if (rewrites.length > 0) lines.push(`Each resident's prompt cache is written in full once: ${list(rewrites)}.`);
  if (unrecorded.length > 0) lines.push(`Cut before releases recorded what they cost, so read their notes: ${list(unrecorded)}.`);
  if (unmeasured.length > 0) lines.push(`Says nothing of whether it rewrites residents' prompt caches: ${list(unmeasured)}.`);
  if (check.bunFloorUnmet !== null) {
    lines.push(`${check.candidate} needs Bun ${check.bunFloorUnmet}: upgrade Bun first, and Update installs nothing until then.`);
  }
  lines.push(`Notes: ${notesUrl(check.candidate)}`);
  lines.push(install ? 'To take it: /update install, then /update restart.' : NOT_AN_INSTALL);
  return lines;
}

/** Who is still busy after a quiesce, and the operator's three ways on. */
function busyLines(restart: RestartState, waitedMs: number): string[] {
  const lines = [`Turns didn't all end within ${Math.round(waitedMs / 60_000)} min, so the restart to ${restart.to} ` +
    'is waiting, with new turns held. Still busy:'];
  for (const host of restart.hosts) {
    if (!host.answered) {
      lines.push(`- ${host.host}: can't be counted (${host.why})`);
    } else if (!host.drained) {
      // drained also waits for a wake parked on provider admission, which
      // names no agent (agent-framework's parkedAdmissions).
      const parts = [
        host.activeTurnAgents.length > 0
          ? `mid-turn: ${list(host.activeTurnAgents)}`
          : 'not drained, though no agent holds a turn: a wake is waiting on an auxiliary call before its turn starts',
        // Drain doesn't wait for them, and the stop ends them.
        ...(host.backgroundScripts > 0
          ? [`${host.backgroundScripts} background script${host.backgroundScripts === 1 ? '' : 's'}, which a stop ends`]
          : []),
      ];
      lines.push(`- ${host.host}: ${parts.join('; ')}`);
    }
  }
  lines.push('Wait longer (/update restart wait, up to 10 min), stop now and cut those off (/update restart now), ' +
    'or resume and try later (/update restart resume).');
  return lines;
}

/** `/update`'s text for a status. */
export function statusLines(status: UpdateStatus): string[] {
  const lines = [`connectome-host ${status.running}.`];
  const check = status.check;
  if (check === null) {
    lines.push(status.checks ? 'The registry hasn\'t been read yet.' : 'This host doesn\'t read the registry on its own.');
  } else if (!check.ok) {
    lines.push(`Reading the registry failed at ${check.at}: ${check.error}`);
  } else if (check.candidate === null) {
    lines.push(`No newer release is offered (read at ${check.at}): Update offers final releases that aren't deprecated.`);
    if (check.runningDeprecated !== null) lines.push(`${status.running} is deprecated on npm: ${check.runningDeprecated}`);
  } else {
    lines.push(...noticeLines(check, status.running, status.install));
  }
  if (!status.install) {
    if (check === null || !check.ok || check.candidate === null) lines.push(NOT_AN_INSTALL);
    return [...lines, ...status.problems];
  }
  if (status.installing !== null) lines.push(`Installing ${status.installing}.`);
  else if (status.lastInstall?.ok === false) lines.push(`Installing ${status.lastInstall.version} failed: ${status.lastInstall.error}`);
  if (status.installed !== null) {
    // A release whose trial just ended before its commit is still in place, and a retry is the operator's to ask.
    lines.push(status.lastSwitch?.outcome === 'fell-back' && status.lastSwitch.to === status.installed
      ? `${status.installed} is installed, and ended before its commit at its last try: /update restart tries it again.`
      : `${status.installed} is installed: /update restart switches to it.`);
  }
  if (status.goBack !== null) {
    lines.push(`Going back to ${status.goBack.to} is offered, with the copy of its data taken ${status.goBack.since}: ` +
      '/update back says what each way does.');
  }
  if (status.restart !== null) {
    lines.push(status.restart.phase === 'busy'
      ? `The restart to ${status.restart.to} is waiting on turns to end: /update restart wait, now or resume.`
      : `A restart to ${status.restart.to} is ${PHASE[status.restart.phase]}.`);
  }
  if (status.operatorQuiesced !== null) {
    lines.push(`This host is quiesced (${status.operatorQuiesced}): a restart, or a Go back that keeps the data, ` +
      'keeps it so. Restoring the copy brings back the copy\'s own state instead.');
  }
  if (status.switchQuiesceLeft) {
    lines.push('This host is quiesced for a switch that isn\'t going ahead: /update restart resume ends it.');
  }
  const last = status.lastSwitch;
  if (last?.outcome === 'committed') lines.push(`Last switch: ${last.from} to ${last.to}, committed at ${last.at}.`);
  if (last?.outcome === 'refused') lines.push(`Last request: to ${last.to}, didn't go ahead at ${last.at}: ${last.reason}`);
  if (last?.outcome === 'fell-back') {
    const head = `Last switch: ${last.to} ended before its commit, so ${last.from} came back with its data (${last.at}): ` +
      `${last.reason}.`;
    if (last.trialLog === null || last.trialLog.length === 0) {
      lines.push(`${head} The service's log, or the terminal it was started in, has what ${last.to} wrote as it ` +
        'ended.');
    } else {
      lines.push(`${head} What ${last.to} wrote last, as it kept it (the service's log, or the terminal it was started ` +
        'in, also has what this leaves out, such as an error Bun reported itself):',
      ...last.trialLog.map((line) => `  ${line}`));
    }
  }
  return [...lines, ...status.problems];
}

/** What `/update back` shows before the yes. */
export function goBackLines(status: UpdateStatus): string[] {
  if (!status.install) return [NOT_AN_INSTALL];
  if (status.goBack === null) {
    const unread = status.problems.find((problem) => problem.startsWith(GO_BACK_UNREAD));
    return [unread !== undefined
      ? `Whether a Go back is offered can't be told: ${unread.slice(GO_BACK_UNREAD.length + 2)}`
      : 'No Go back is offered: the copy doesn\'t hold another installed release\'s data.'];
  }
  const { to, since } = status.goBack;
  return [
    `Going back to ${to}, whose data the copy holds as it was at ${since}. Two ways:`,
    `- /update back keep: ${to} runs on the data as it is now, so residents lose nothing. If ${to} can't read it, ` +
      `its start goes back to ${status.running} by itself, and restore is the way then.`,
    `- /update back restore: the copy is restored, and everything since ${since} is set aside, not deleted. ` +
      'For residents, that is everything they have lived since then. The host comes back quiesced or serving as the ' +
      'copy holds it, so a quiesce made since then doesn\'t come back.',
    'Either way the host quiesces first, as Restart does.',
  ];
}

// ---------------------------------------------------------------------------
// The last switch, from the journal
// ---------------------------------------------------------------------------

/** How the journal's last request ended: committed, fallen back, or not gone
 *  ahead (a refusal, or a step that failed). A trial log that can't be read
 *  is named in `problems`, and the fallback is given without its lines. */
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

/** This host's version, from its package.json. */
export function hostVersionOf(packageJson: URL): string {
  const version = (JSON.parse(readFileSync(packageJson, 'utf-8')) as { version?: unknown }).version;
  if (typeof version !== 'string') throw new Error(`${packageJson.pathname} names no version.`);
  return version;
}
