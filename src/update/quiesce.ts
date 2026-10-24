/**
 * The switch's quiesce: before Restart stops the install's host to switch
 * release or go back, it quiesces the host and each running fleet child, so
 * no new turn starts, and waits for the turns in flight to end. The operator
 * sees which hosts drained and who is still mid-turn on each, and chooses:
 * wait longer (quiesceForSwitch again), try later (resumeAfterSwitchQuiesce),
 * or stop now, which the host's stop does as any stop does. A child's side is
 * answerSwitchRequest, over its socket.
 *
 * The quiesce persists through the stop, so the release that starts next
 * boots quiesced, connects its servers with their data planes paused, and
 * commits. startFramework then ends it once framework.start() has run
 * (resumeIfSwitch), in the install's host and in each child alike: only a
 * quiesce under the switch's reason, so one under any other reason stays.
 * That holds too when the same release comes back, after a crash or a
 * fallback.
 */
import type { HostModeStatus } from '@animalabs/agent-framework';
import { isSwitchQuiesce, switchQuiesceReason } from './contract.js';

/** What the switch's quiesce uses of a framework. Its status's
 *  `activeTurnAgents` lists the agents with a turn alive, a turn whose
 *  continuation is on its way to its start included, as `drained` counts
 *  them (agent-framework 0.26.1). `drained` also waits for a wake parked on
 *  provider admission, which names no agent, so a host can be undrained with
 *  none listed. */
export type QuiesceFramework = {
  quiesce(opts?: { reason?: string; timeoutMs?: number }): Promise<HostModeStatus>;
  resume(opts?: { force?: boolean }): Promise<HostModeStatus>;
  getHostModeStatus(): HostModeStatus;
};

/** The fleet as the switch reaches it: every child that may be running,
 *  which is each one starting or ready, whether or not this host has a
 *  connection to it; and a request to one, answered or failed within
 *  `timeoutMs`, never rejected. */
export interface SwitchFleet {
  runningChildren(): Array<{ name: string }>;
  requestSwitch(name: string, request: SwitchRequest, timeoutMs: number): Promise<{ ok: boolean; data?: unknown; error?: string }>;
}

/** A request the install's host makes of a fleet child (answerSwitchRequest):
 *  quiesce under the switch's reason for `to`, or end the switch's quiesce. */
export type SwitchRequest = { op: 'quiesce'; to: string; waitMs: number } | { op: 'resume' };

/** One host's state after the quiesce: `host` is "this host" or the child's
 *  name. A host that can't be counted, such as a child that didn't answer or
 *  a host serving again, says why. */
export type HostQuiet =
  | { host: string; answered: true; drained: boolean; activeTurnAgents: string[]; backgroundScripts: number }
  | { host: string; answered: false; why: string };

/** What quiesceForSwitch found: drained when every host answered drained. */
export interface SwitchQuiet {
  drained: boolean;
  hosts: HostQuiet[];
}

/** What resumeAfterSwitchQuiesce did on each host: `resumed` is false, with
 *  why, when the host didn't end the switch's quiesce or didn't say so in
 *  time. */
export interface SwitchResumed {
  hosts: Array<{ host: string; resumed: boolean; why?: string }>;
}

const THIS_HOST = 'this host';
/** How often the wait on a host that was quiesced already reads whether it has drained. */
const DRAIN_POLL_MS = 200;
/** How long a child's answer may take beyond the wait it was asked for, so
 *  one sent as its own wait ends still arrives. */
const ANSWER_MARGIN_MS = 10_000;
const SERVING_AGAIN = "its quiesce was ended during the switch's quiesce, so it was serving";
const said = (error: unknown): string => error instanceof Error ? error.message : String(error);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
/** The longest wait a request's timer can hold (a timer's delay is a signed
 *  32-bit number of milliseconds), less the margin a child's answer gets. */
const MAX_WAIT_MS = 2 ** 31 - 1 - ANSWER_MARGIN_MS;
const isWait = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_WAIT_MS;

/** A host's state after its quiesce: who holds a turn, and the scripts left
 *  running outside any turn, which a quiesce doesn't stop and a stop does. A
 *  host no longer quiesced can't be counted as drained. */
function quiet(host: string, status: HostModeStatus): HostQuiet {
  if (!status.quiesced) return { host, answered: false, why: SERVING_AGAIN };
  return { host, answered: true, drained: status.drained, activeTurnAgents: status.activeTurnAgents, backgroundScripts: status.backgroundScripts };
}

/** Quiesce under `reason`, and wait up to `waitMs` for every turn to end, or
 *  until the host is serving again. agent-framework bounds its own part of
 *  the wait (1 second to 10 minutes), and a host quiesced already answers its
 *  quiesce at once, keeping the reason it has, so the rest of the wait reads
 *  the host's status here. */
async function quiesceAndWait(framework: QuiesceFramework, reason: string, waitMs: number): Promise<HostModeStatus> {
  const deadline = Date.now() + waitMs;
  let status = await framework.quiesce({ reason, timeoutMs: waitMs });
  while (status.quiesced && !status.drained && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, Math.min(DRAIN_POLL_MS, deadline - Date.now())));
    status = framework.getHostModeStatus();
  }
  return status;
}

/** A child's answer to a quiesce, read as the child sent it. */
function childQuiet(name: string, answer: { ok: boolean; data?: unknown; error?: string }): HostQuiet {
  if (!answer.ok) return { host: name, answered: false, why: answer.error ?? 'it gave no reason' };
  const data = answer.data as Record<string, unknown> | undefined;
  if (data?.answered === false) return { host: name, answered: false, why: typeof data.why === 'string' ? data.why : "its answer doesn't say why" };
  const holders = data?.activeTurnAgents;
  if (!data || typeof data.drained !== 'boolean' || !Array.isArray(holders) || !holders.every((h) => typeof h === 'string') ||
    !isCount(data.backgroundScripts)) {
    return { host: name, answered: false, why: "its answer doesn't say whether it drained, who holds a turn and what scripts it runs" };
  }
  return { host: name, answered: true, drained: data.drained, activeTurnAgents: holders as string[], backgroundScripts: data.backgroundScripts };
}

/** Ask each child that may be running to quiesce for the switch to `to`,
 *  waiting up to `waitMs`, at once, and read each answer. */
async function askChildren(fleet: SwitchFleet | null, to: string, waitMs: number): Promise<HostQuiet[]> {
  return Promise.all((fleet?.runningChildren() ?? []).map(async ({ name }) =>
    childQuiet(name, await fleet!.requestSwitch(name, { op: 'quiesce', to, waitMs }, waitMs + ANSWER_MARGIN_MS))));
}

/**
 * Quiesce this host and each fleet child that may be running under the
 * switch's reason, at once, and wait up to `timeoutMs` for each to drain.
 * Then look again at every host, which is what's returned. The look
 * quiesces each child again, since a child answers only a quiesce, so a child
 * launched, connected or resumed during the wait, as a turn this host was
 * ending can launch one, is quiesced then and counted as it is; one not yet
 * connected can't be counted. This host is read as the look starts and again
 * once its children have answered, and counts as drained only when it was
 * quiesced and drained at the start and is still quiesced at the end. One
 * serving at the end, or at the start, can't be counted. One not drained at
 * the start is counted as it was then, with the agents that held a turn then,
 * since a turn alive then could launch a child the look doesn't list. What
 * changes between the look and the caller's stop isn't seen. A child that
 * doesn't answer holds the call for its margin past the wait, and again at
 * the look. A host that doesn't drain stays quiesced, as does one the
 * operator had quiesced, under its own reason. A second call is "wait
 * longer". A quiesce this host refuses, such as a QuiesceBlockedError where
 * its deferred writes can't reach disk, is thrown once the children have
 * answered, with this host's mode as it was.
 */
export async function quiesceForSwitch(
  framework: QuiesceFramework, fleet: SwitchFleet | null, opts: { to: string; timeoutMs: number },
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
  // A child quiesced already answers at once, so the look takes a round trip
  // for each, and up to a second for a child it quiesces now.
  const before = framework.getHostModeStatus();
  const children = await askChildren(fleet, opts.to, 0);
  const after = framework.getHostModeStatus();
  const hosts = [quiet(THIS_HOST, !after.quiesced || (before.quiesced && before.drained) ? after : before), ...children];
  return { drained: hosts.every((h) => h.answered && h.drained), hosts };
}

/** Try later: end the switch's quiesce on each child that may be running and
 *  on this host, leaving any other quiesce. A child that isn't running ends
 *  it at its next start. A child that sends no answer within ten seconds, as
 *  one whose resume waits for its context maintenance can, is reported not
 *  resumed, with the fleet's reason; the resume it received goes on. */
export async function resumeAfterSwitchQuiesce(framework: QuiesceFramework, fleet: SwitchFleet | null): Promise<SwitchResumed> {
  const children = await Promise.all((fleet?.runningChildren() ?? []).map(async ({ name }) =>
    ({ name, answer: await fleet!.requestSwitch(name, { op: 'resume' }, ANSWER_MARGIN_MS) })));
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

/** A fleet child's answer to its parent's switch request, which comes over
 *  its socket. A request it can't read is refused, saying so. */
export async function answerSwitchRequest(framework: QuiesceFramework, request: unknown): Promise<Record<string, unknown>> {
  const asked = request as Record<string, unknown> | null;
  if (asked?.op === 'resume') return resumeIfSwitch(framework);
  if (asked?.op === 'quiesce' && typeof asked.to === 'string' && asked.to !== '' && isWait(asked.waitMs)) {
    return quiet(THIS_HOST, await quiesceAndWait(framework, switchQuiesceReason(asked.to), asked.waitMs));
  }
  throw new Error(`This fleet child can't read the switch's request (${JSON.stringify(request)?.slice(0, 200)}), so it did ` +
    "nothing. It may run another release than the install's host does: fleet--restart of it starts it on the host's release.");
}

/** End a quiesce that is the switch's own, and leave any other. A resume
 *  agent-framework refuses leaves the host quiesced, says why and logs it,
 *  with `refused` set; one that fails after the host serves again says so. */
export async function resumeIfSwitch(framework: QuiesceFramework): Promise<{ resumed: boolean; why?: string; refused?: true }> {
  const status = framework.getHostModeStatus();
  if (!status.quiesced) return { resumed: false, why: 'it was serving' };
  if (!isSwitchQuiesce(status.reason)) return { resumed: false, why: `its quiesce isn't the switch's (${status.reason ?? 'no reason'}), so it stays` };
  try {
    await framework.resume();
    return { resumed: true };
  } catch (error) {
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
