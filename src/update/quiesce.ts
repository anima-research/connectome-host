/**
 * The quiesce persists through the stop, so the release that starts next
 * boots quiesced, connects its servers with their data planes paused, and
 * commits; startFramework then ends it (resumeIfSwitch).
 */
import { randomUUID } from 'node:crypto';
import type { HostModeStatus } from '@animalabs/agent-framework';
import type { HostQuiet } from '../web/update-text.js';
import { isSwitchQuiesce, readRecord, switchQuiesceReason, type Mark } from './contract.js';

/** What the switch's quiesce uses of a framework. Its status's
 *  `activeTurnAgents` lists the agents with a turn alive, a turn whose
 *  continuation is on its way to its start included, as `drained` counts
 *  them. `drained` also waits for a wake parked on provider admission,
 *  which names no agent, so a host can be undrained with none listed. */
export type QuiesceFramework = {
  quiesce(opts?: { reason?: string; timeoutMs?: number }): Promise<HostModeStatus>;
  resume(opts?: { force?: boolean }): Promise<HostModeStatus>;
  getHostModeStatus(): HostModeStatus;
};

/** A running child, with what names its process: a child started again
 *  under the same name has another incarnation. */
export interface RunningChild {
  name: string;
  incarnation: string;
}

export interface SwitchFleet {
  runningChildren(): RunningChild[];
  requestSwitch(name: string, request: SwitchRequest, timeoutMs: number): Promise<{ ok: boolean; data?: unknown; error?: string }>;
}

/** What the switch's last look tells a child: the look's id, the path of the
 *  mark that would decide it, and the pid of the install's host that asks. */
export interface LastLook {
  look: string;
  mark: string;
  parent: number;
}

/** A request the install's host makes of a fleet child: quiesce under the
 *  switch's reason for `to`, or, on the last look, only look and hold; end
 *  the switch's quiesce; or say that the look's decision is "not yet". */
export type SwitchRequest =
  | { op: 'quiesce'; to: string; waitMs: number; last?: LastLook }
  | { op: 'resume'; look?: string }
  | { op: 'release'; look: string };

/** A last look as its asker keeps it: its id, and the children it asked. */
export interface Looked {
  look: string;
  children: RunningChild[];
}

export interface SwitchQuiet {
  drained: boolean;
  hosts: HostQuiet[];
  look: Looked;
  /** When this host's quiesce began, as its status read after the last look
   *  gives it. */
  since?: number;
}

export interface SwitchResumed {
  hosts: Array<{ host: string; resumed: boolean; why?: string }>;
}

export const SERVING = 'it was serving';
export const NOT_THE_SWITCHS = 'its quiesce isn\'t the switch\'s';
const THIS_HOST = 'this host';
const DRAIN_POLL_MS = 200;
const ANSWER_MARGIN_MS = 10_000;
const SERVING_AGAIN = "its quiesce was ended during the switch's quiesce, so it was serving";
const SERVING_AT_LAST_LOOK = "it was serving at the switch's last look, which quiesces nothing";
const RESUMING_AT_LAST_LOOK = "a Resume asked here was under way at the switch's last look, so it may serve";
const NOT_HELD = "its answer to the switch's last look doesn't say that it holds, so it may run another release than the " +
  "install's host does: fleet--restart of it starts it on the host's release";
const EARLIER_LOOK = 'it holds for a later look of the switch, so this word from an earlier one changes nothing';
const HOLDING = "the release switch's last look has begun here, so nothing here changes until the install's host decides it. " +
  'If it calls the switch off, Resume works here again; if the switch goes ahead, this host stops. Where the install\'s host ' +
  "can't reach this host, stopping the install's host or restarting this one ends the wait.";
const BEGUN = "the release switch has begun, and it finishes at the install's host's next start.";
const said = (error: unknown): string => error instanceof Error ? error.message : String(error);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
/** The longest wait a request's timer can hold (a timer's delay is a signed
 *  32-bit number of milliseconds), less the margin a child's answer gets. */
const MAX_WAIT_MS = 2 ** 31 - 1 - ANSWER_MARGIN_MS;
const isWait = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_WAIT_MS;

function quiet(host: string, status: HostModeStatus): HostQuiet {
  if (!status.quiesced) return { host, answered: false, why: SERVING_AGAIN };
  return { host, answered: true, drained: status.drained, activeTurnAgents: status.activeTurnAgents, backgroundScripts: status.backgroundScripts };
}

/** agent-framework bounds its own part of the wait (1 second to 10 minutes),
 *  and a host quiesced already answers its quiesce at once, keeping the
 *  reason it has, so the rest of the wait reads the host's status here. */
async function quiesceAndWait(framework: QuiesceFramework, reason: string, waitMs: number): Promise<HostModeStatus> {
  const deadline = Date.now() + waitMs;
  let status = await framework.quiesce({ reason, timeoutMs: waitMs });
  while (status.quiesced && !status.drained && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, Math.min(DRAIN_POLL_MS, deadline - Date.now())));
    status = framework.getHostModeStatus();
  }
  return status;
}

function childQuiet(name: string, answer: { ok: boolean; data?: unknown; error?: string }, last: boolean): HostQuiet {
  if (!answer.ok) return { host: name, answered: false, why: answer.error ?? 'it gave no reason' };
  const data = answer.data as Record<string, unknown> | undefined;
  if (data?.answered === false) return { host: name, answered: false, why: typeof data.why === 'string' ? data.why : "its answer doesn't say why" };
  const holders = data?.activeTurnAgents;
  if (!data || typeof data.drained !== 'boolean' || !Array.isArray(holders) || !holders.every((h) => typeof h === 'string') ||
    !isCount(data.backgroundScripts)) {
    return { host: name, answered: false, why: "its answer doesn't say whether it drained, who holds a turn and what scripts it runs" };
  }
  const work = data.inFlight === undefined ? [] : Array.isArray(data.inFlight) && data.inFlight.every((w) => typeof w === 'string')
    ? data.inFlight as string[] : ['work in flight that its answer doesn\'t name plainly'];
  const hold = data.operatorHold as { reason?: unknown } | undefined;
  if (hold !== undefined && (hold === null || typeof hold !== 'object' || Array.isArray(hold))) {
    return { host: name, answered: false, why: "its answer says it's held by its operator in a form this host can't read" };
  }
  const operatorHold = hold !== undefined ? { operatorHold: typeof hold.reason === 'string' ? { reason: hold.reason } : {} } : {};
  if (last && data.held !== true) return { host: name, answered: false, why: NOT_HELD };
  return {
    host: name, answered: true, drained: data.drained, activeTurnAgents: holders as string[], backgroundScripts: data.backgroundScripts,
    ...operatorHold, ...(work.length > 0 ? { inFlight: work } : {}),
  };
}

async function askChildren(fleet: SwitchFleet | null, to: string, waitMs: number): Promise<HostQuiet[]> {
  return Promise.all((fleet?.runningChildren() ?? []).map(async ({ name }) =>
    childQuiet(name, await fleet!.requestSwitch(name, { op: 'quiesce', to, waitMs }, waitMs + ANSWER_MARGIN_MS), false)));
}

// agent-framework 0.33.0 waits up to a second for a busy host to drain
// before it answers a quiesce (QUIESCE_TIMEOUT_MIN_MS).
export async function lookAtChildren(fleet: SwitchFleet | null, to: string): Promise<HostQuiet[]> {
  return askChildren(fleet, to, 0);
}

/** The switch's last look: each running child is asked at once whether it's
 *  quiesced, and one that is holds until this look is decided. The look
 *  quiesces nothing. */
export async function takeLastLook(fleet: SwitchFleet | null, to: string, mark: string): Promise<{ hosts: HostQuiet[]; look: Looked }> {
  const children = fleet?.runningChildren() ?? [];
  const last: LastLook = { look: randomUUID(), mark, parent: process.pid };
  const hosts = await Promise.all(children.map(async ({ name }) =>
    childQuiet(name, await fleet!.requestSwitch(name, { op: 'quiesce', to, waitMs: 0, last }, ANSWER_MARGIN_MS), true)));
  return { hosts, look: { look: last.look, children } };
}

/** Tell each running child that the look's decision is "not yet": its hold
 *  ends and its quiesce stays. A child the word doesn't reach is owed it by
 *  the fleet. */
export async function releaseHolds(fleet: SwitchFleet | null, look: string): Promise<void> {
  await Promise.all((fleet?.runningChildren() ?? []).map(({ name }) =>
    fleet!.requestSwitch(name, { op: 'release', look }, ANSWER_MARGIN_MS)));
}

/** What changed in the fleet since its last look asked it, by incarnation:
 *  null where every child it asked runs as it did and no other runs. */
export function fleetChanged(fleet: SwitchFleet | null, looked: Looked | null): string | null {
  const running = new Map((fleet?.runningChildren() ?? []).map((child) => [child.name, child.incarnation]));
  const asked = new Map((looked?.children ?? []).map((child) => [child.name, child.incarnation]));
  const changes = [
    ...[...asked].flatMap(([name, incarnation]) => !running.has(name) ? [`${name} stopped`]
      : running.get(name) !== incarnation ? [`${name} started again`] : []),
    ...[...running.keys()].filter((name) => !asked.has(name)).map((name) => `${name} started`),
  ];
  return changes.length === 0 ? null : changes.map((change) => `${change} during the switch's last look`).join('; ');
}

export async function quiesceForSwitch(
  framework: QuiesceFramework, fleet: SwitchFleet | null, opts: { to: string; timeoutMs: number; mark: string },
): Promise<SwitchQuiet> {
  if (!isWait(opts.timeoutMs)) {
    throw new RangeError(`The switch's wait is ${opts.timeoutMs}, where it takes a number of milliseconds from 0 to ${MAX_WAIT_MS}.`);
  }
  const [own, waited] = await Promise.allSettled([
    quiesceAndWait(framework, switchQuiesceReason(opts.to), opts.timeoutMs),
    askChildren(fleet, opts.to, opts.timeoutMs),
  ]);
  if (own.status === 'rejected') throw own.reason;
  if (waited.status === 'rejected') throw waited.reason;
  const before = framework.getHostModeStatus();
  const { hosts: children, look } = await takeLastLook(fleet, opts.to, opts.mark);
  const after = framework.getHostModeStatus();
  const hosts = [quiet(THIS_HOST, !after.quiesced || (before.quiesced && before.drained) ? after : before), ...children];
  return { drained: hosts.every((h) => h.answered && h.drained), hosts, look, since: after.since };
}

export async function resumeAfterSwitchQuiesce(framework: QuiesceFramework, fleet: SwitchFleet | null, look?: string): Promise<SwitchResumed> {
  const request: SwitchRequest = look === undefined ? { op: 'resume' } : { op: 'resume', look };
  const children = await Promise.all((fleet?.runningChildren() ?? []).map(async ({ name }) =>
    ({ name, answer: await fleet!.requestSwitch(name, request, ANSWER_MARGIN_MS) })));
  const own = await resumeIfSwitch(framework);
  return {
    hosts: [
      { host: THIS_HOST, resumed: own.resumed, ...(own.why !== undefined ? { why: own.why } : {}) },
      ...children.map(({ name, answer }) => {
        const data = answer.data as { resumed?: unknown; why?: unknown } | undefined;
        if (!answer.ok || typeof data?.resumed !== 'boolean') return { host: name, resumed: false, why: answer.error ?? "its answer doesn't say" };
        return { host: name, resumed: data.resumed, ...(typeof data.why === 'string' ? { why: data.why } : {}) };
      }),
    ],
  };
}

export async function resumeLeftChildren(fleet: SwitchFleet, children: Array<{ name: string }>): Promise<void> {
  await Promise.all(children.map(async ({ name }) => {
    let answer: { ok: boolean; data?: unknown; error?: string };
    try {
      answer = await fleet.requestSwitch(name, { op: 'resume' }, ANSWER_MARGIN_MS);
    } catch (error) {
      answer = { ok: false, error: said(error) };
    }
    const data = answer.data as { refused?: unknown; why?: unknown } | undefined;
    if (answer.ok && data?.refused !== true) return;
    const what = answer.ok
      ? `it refused (${typeof data?.why === 'string' ? data.why : 'its answer doesn\'t say why'})`
      : `it didn't answer (${answer.error ?? 'no reason given'})`;
    console.error(`[update] Fleet child ${JSON.stringify(name)} was asked at this start to end a switch's quiesce the ` +
      `last stop may have left, and ${what}, so it may still be holding its new turns until a resume reaches it, such as ` +
      'an operator\'s Resume, or until its own next start.');
  }));
}

const isLook = (value: unknown): value is string => typeof value === 'string' && value !== '';

function readLastLook(value: unknown): LastLook | null {
  const last = value as Record<string, unknown> | null;
  return last !== null && typeof last === 'object' && isLook(last.look) && isLook(last.mark) &&
    typeof last.parent === 'number' && Number.isSafeInteger(last.parent) && last.parent > 0
    ? { look: last.look, mark: last.mark, parent: last.parent } : null;
}

function answerOf(status: HostModeStatus): Record<string, unknown> {
  const operator = status.quiesced && !isSwitchQuiesce(status.reason);
  return { ...quiet(THIS_HOST, status), ...(operator ? { operatorHold: status.reason ? { reason: status.reason } : {} } : {}) };
}

/** A fleet child's hold on the switch's last look. While it holds, a Resume
 *  its own person asks for is refused. It lives in memory only, so a restart
 *  of the child ends it. */
export class SwitchHold {
  private last: LastLook | null = null;
  private resuming = 0;

  held(): boolean {
    return this.last !== null;
  }

  /** The words that refuse a Resume asked here, or null where none is
   *  refused. With the install's host's process gone and no mark of the
   *  look in place, the hold ends and none is refused. */
  refusal(): string | null {
    const last = this.last;
    if (last === null) return null;
    let mark: Mark | null;
    try {
      mark = readRecord<Mark>(last.mark, 'mark');
    } catch {
      return HOLDING;
    }
    if (mark?.look === last.look) return BEGUN;
    if (processRuns(last.parent)) return HOLDING;
    this.last = null;
    return null;
  }

  /** A resume of this host: refused while the hold stands, and otherwise
   *  run, with the last look meanwhile told that this host may serve. */
  async resumeHere<T>(resume: () => Promise<T>): Promise<{ refused: string } | { done: T }> {
    const refused = this.refusal();
    if (refused !== null) return { refused };
    this.resuming += 1;
    try {
      return { done: await resume() };
    } finally {
      this.resuming -= 1;
    }
  }

  /** The last look's answer: the status read, the hold and the answer are
   *  one step, with no await between. */
  look(framework: QuiesceFramework, last: LastLook): Record<string, unknown> {
    if (this.resuming > 0) return { host: THIS_HOST, answered: false, why: RESUMING_AT_LAST_LOOK };
    const status = framework.getHostModeStatus();
    if (!status.quiesced) return { host: THIS_HOST, answered: false, why: SERVING_AT_LAST_LOOK };
    this.last = last;
    return { ...answerOf(status), held: true };
  }

  /** Whether a word from the install's host for `look` reaches this hold:
   *  one for another look than the one held changes nothing. */
  ends(look: string | undefined): boolean {
    if (this.last === null || look === undefined || look === this.last.look) {
      this.last = null;
      return true;
    }
    return false;
  }
}

/** Whether `error` is the gate's refusal of a resume while the hold stands
 *  (resume-gate.ts). */
export function isHoldRefusal(error: unknown): error is Error {
  return error instanceof Error && (error as { switchHold?: unknown }).switchHold === true;
}

function processRuns(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** The refusal of `what`, a change to the session, while this host holds for
 *  the switch's last look, or null where it doesn't hold. */
export function refusedWhileHeld(what: string, hold: SwitchHold = switchHold): string | null {
  const text = hold.refusal();
  if (text === null) return null;
  return `${what} refused: ${text} Nothing changed${text === HOLDING ? '; try again once the switch is decided' : ''}.`;
}

/** This process's hold, which its answers to the switch and the gate on its
 *  framework's resume share. */
export const switchHold = new SwitchHold();

export async function answerSwitchRequest(
  framework: QuiesceFramework, request: unknown, hold: SwitchHold = switchHold,
): Promise<Record<string, unknown>> {
  const asked = request as Record<string, unknown> | null;
  if (asked?.op === 'resume' && (asked.look === undefined || isLook(asked.look))) {
    if (!hold.ends(asked.look as string | undefined)) return { resumed: false, why: EARLIER_LOOK };
    return resumeIfSwitch(framework);
  }
  if (asked?.op === 'release' && isLook(asked.look)) {
    return hold.ends(asked.look) ? { released: true } : { released: false, why: EARLIER_LOOK };
  }
  if (asked?.op === 'quiesce' && typeof asked.to === 'string' && asked.to !== '' && isWait(asked.waitMs)) {
    if (asked.last !== undefined) {
      const last = readLastLook(asked.last);
      if (last !== null) return hold.look(framework, last);
    } else {
      return answerOf(await quiesceAndWait(framework, switchQuiesceReason(asked.to), asked.waitMs));
    }
  }
  throw new Error(`This fleet child can't read the switch's request (${JSON.stringify(request)?.slice(0, 200)}), so it did ` +
    "nothing. It may run another release than the install's host does: fleet--restart of it starts it on the host's release.");
}

export async function resumeIfSwitch(framework: QuiesceFramework): Promise<{ resumed: boolean; why?: string; refused?: true }> {
  const status = framework.getHostModeStatus();
  if (!status.quiesced) return { resumed: false, why: SERVING };
  if (!isSwitchQuiesce(status.reason)) return { resumed: false, why: `${NOT_THE_SWITCHS} (${status.reason ?? 'no reason'}), so it stays` };
  try {
    await framework.resume();
    return { resumed: true };
  } catch (error) {
    if (isHoldRefusal(error)) return { resumed: false, why: error.message, refused: true };
    if (!framework.getHostModeStatus().quiesced) {
      // agent-framework ends the quiesce in memory before it writes that it
      // has, so a write that fails leaves the host serving.
      const why = `it's serving, though agent-framework's resume failed after the quiesce ended: ${said(error)}`;
      console.error(`[update] This host's switch quiesce ended, with an error: ${why}`);
      return { resumed: true, why };
    }
    const why = `it stays quiesced, since agent-framework refused its resume (${said(error)}); a later resume, ` +
      'such as try later or the next start, can succeed once that is resolved';
    console.error(`[update] This host's switch quiesce didn't end: ${why}`);
    return { resumed: false, why, refused: true };
  }
}
