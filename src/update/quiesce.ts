/**
 * The quiesce persists through the stop, so the release that starts next
 * boots quiesced, connects its servers with their data planes paused, and
 * commits; startFramework then ends it (resumeIfSwitch).
 */
import type { HostModeStatus } from '@animalabs/agent-framework';
import type { HostQuiet } from '../web/update-text.js';
import { isSwitchQuiesce, switchQuiesceReason } from './contract.js';

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

export interface SwitchFleet {
  runningChildren(): Array<{ name: string }>;
  requestSwitch(name: string, request: SwitchRequest, timeoutMs: number): Promise<{ ok: boolean; data?: unknown; error?: string }>;
}

/** A request the install's host makes of a fleet child: quiesce under the
 *  switch's reason for `to`, or end the switch's quiesce. */
export type SwitchRequest = { op: 'quiesce'; to: string; waitMs: number } | { op: 'resume' };

export interface SwitchQuiet {
  drained: boolean;
  hosts: HostQuiet[];
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

async function askChildren(fleet: SwitchFleet | null, to: string, waitMs: number): Promise<HostQuiet[]> {
  return Promise.all((fleet?.runningChildren() ?? []).map(async ({ name }) =>
    childQuiet(name, await fleet!.requestSwitch(name, { op: 'quiesce', to, waitMs }, waitMs + ANSWER_MARGIN_MS))));
}

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
  const before = framework.getHostModeStatus();
  const children = await askChildren(fleet, opts.to, 0);
  const after = framework.getHostModeStatus();
  const hosts = [quiet(THIS_HOST, !after.quiesced || (before.quiesced && before.drained) ? after : before), ...children];
  return { drained: hosts.every((h) => h.answered && h.drained), hosts };
}

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

export async function answerSwitchRequest(framework: QuiesceFramework, request: unknown): Promise<Record<string, unknown>> {
  const asked = request as Record<string, unknown> | null;
  if (asked?.op === 'resume') return resumeIfSwitch(framework);
  if (asked?.op === 'quiesce' && typeof asked.to === 'string' && asked.to !== '' && isWait(asked.waitMs)) {
    return quiet(THIS_HOST, await quiesceAndWait(framework, switchQuiesceReason(asked.to), asked.waitMs));
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
