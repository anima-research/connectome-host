/**
 * The switch's quiesce (src/update/quiesce.ts): every host quiesced under the
 * switch's reason before Restart stops the install's host, the operator's
 * view of who is still mid-turn, and the resume that leaves any other
 * quiesce.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import type { HostModeStatus } from '@animalabs/agent-framework';
import { isSwitchQuiesce, switchQuiesceReason } from '../src/update/contract.js';
import {
  type QuiesceFramework, type SwitchFleet, type SwitchRequest, answerSwitchRequest, quiesceForSwitch, resumeAfterSwitchQuiesce, resumeIfSwitch,
} from '../src/update/quiesce.js';

const SWITCH = switchQuiesceReason('0.14.0');

/** A framework as the switch's quiesce uses one: `holders` hold a turn, and
 *  `drainAfter` reads of its status pass before it says drained, or `drain()`
 *  ends their turns at a moment the test chooses, and `set()` puts any
 *  field of its status in place, from then on. `calls`
 *  records each quiesce that answers and each resume, and `entered` counts
 *  each quiesce as it's entered, one that fails included; `resumeBy` ends its
 *  quiesce from elsewhere after that many reads, and `reads` counts them. */
function fakeFramework(options: {
  quiesced?: boolean; reason?: string; holders?: string[]; drainAfter?: number; resumeFails?: 'before' | 'after'; quiesceFails?: Error;
  quiesceWaits?: Promise<void>; resumeBy?: number;
} = {}) {
  const calls: string[] = [];
  let reads = 0;
  let entered = 0;
  let mode = { quiesced: options.quiesced ?? false, reason: options.reason };
  let ended = false;
  let fields: Partial<HostModeStatus> = {};
  const status = (): HostModeStatus => ({
    ...mode, drained: ended || reads >= (options.drainAfter ?? 0), activeTurns: 0, parkedAdmissions: 0, gatedRequests: 0,
    backgroundScripts: 1, deferredWrites: 2, activeTurnAgents: ended ? [] : options.holders ?? [], ...fields,
  } as HostModeStatus);
  const framework: QuiesceFramework = {
    quiesce: async (opts = {}) => {
      entered += 1;
      await options.quiesceWaits;
      if (options.quiesceFails) throw options.quiesceFails;
      calls.push(`quiesce ${opts.reason} for ${opts.timeoutMs} ms`);
      if (!mode.quiesced) mode = { quiesced: true, reason: opts.reason };
      return status();
    },
    resume: async () => {
      calls.push('resume');
      if (options.resumeFails === 'before') throw new Error('resume refused: the feasibility gate refused it');
      mode = { quiesced: false, reason: undefined };
      if (options.resumeFails === 'after') throw new Error("EIO: the record of the quiesce's end couldn't be written");
      return status();
    },
    getHostModeStatus: () => {
      reads += 1;
      if (options.resumeBy !== undefined && reads >= options.resumeBy) mode = { quiesced: false, reason: undefined };
      return status();
    },
  };
  return {
    framework, calls, mode: () => mode, reads: () => reads, entered: () => entered,
    drain: () => { ended = true; }, set: (status: Partial<HostModeStatus>) => { fields = { ...fields, ...status }; },
  };
}

type Answer = { ok: boolean; data?: unknown; error?: string };

/** A fleet whose children answer as `answers` says, by name, each answer
 *  told how many times that child has been asked. `later` adds children to
 *  it once the first is asked. */
function fakeFleet(
  answers: Record<string, (times: number) => Answer | Promise<Answer>>, later: Record<string, (times: number) => Answer> = {},
) {
  const asked: Array<{ name: string; request: SwitchRequest; timeoutMs: number }> = [];
  const running = new Map(Object.entries(answers));
  const fleet: SwitchFleet = {
    runningChildren: () => [...running.keys()].map((name) => ({ name })),
    requestSwitch: async (name, request, timeoutMs) => {
      asked.push({ name, request, timeoutMs });
      for (const [laterName, answer] of Object.entries(later)) if (!running.has(laterName)) running.set(laterName, answer);
      return running.get(name)!(asked.filter((a) => a.name === name).length);
    },
  };
  return { fleet, asked, running };
}

const drained = (holders: string[] = []) => () => ({ ok: true, data: { drained: true, activeTurnAgents: holders, backgroundScripts: 0 } });

/** A promise and the function that settles it. */
function held<T = void>(): { promise: Promise<T>; settle: (value: T) => void } {
  let settle!: (value: T) => void;
  return { promise: new Promise<T>((done) => { settle = done; }), settle };
}

async function until(check: () => boolean, label: string): Promise<void> {
  for (let tries = 0; !check(); tries++) {
    if (tries > 200) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(5);
  }
}

describe("the switch's reason", () => {
  test("marks the switch's quiesce apart from any other", () => {
    expect(SWITCH).toBe('connectome-host update: stopping to switch to 0.14.0');
    expect(isSwitchQuiesce(SWITCH)).toBe(true);
    expect(isSwitchQuiesce('operator: maintenance')).toBe(false);
    expect(isSwitchQuiesce(undefined)).toBe(false);
  });
});

describe('quiesceForSwitch', () => {
  test('quiesces this host and every running child, waits, then looks again at each, and drains only when every host is drained', async () => {
    const { framework, calls } = fakeFramework({ holders: [] });
    const { fleet, asked } = fakeFleet({
      kid: drained(),
      busy: () => ({ ok: true, data: { drained: false, activeTurnAgents: ['helper'], backgroundScripts: 3 } }),
      mute: () => ({ ok: false, error: "the switch's quiesce timed out" }),
    });
    const result = await quiesceForSwitch(framework, fleet, { to: '0.14.0', timeoutMs: 2_000 });
    expect(calls).toEqual([`quiesce ${SWITCH} for 2000 ms`]);
    expect(asked.map((a) => [a.name, a.request, a.timeoutMs])).toEqual([
      ...['kid', 'busy', 'mute'].map((name) => [name, { op: 'quiesce', to: '0.14.0', waitMs: 2_000 }, 12_000]),
      ...['kid', 'busy', 'mute'].map((name) => [name, { op: 'quiesce', to: '0.14.0', waitMs: 0 }, 10_000]),
    ]);
    expect(result).toEqual({
      drained: false,
      hosts: [
        { host: 'this host', answered: true, drained: true, activeTurnAgents: [], backgroundScripts: 1 },
        { host: 'kid', answered: true, drained: true, activeTurnAgents: [], backgroundScripts: 0 },
        { host: 'busy', answered: true, drained: false, activeTurnAgents: ['helper'], backgroundScripts: 3 },
        { host: 'mute', answered: false, why: "the switch's quiesce timed out" },
      ],
    });
  });

  test("asks every child at once, while this host's own quiesce is still waiting", async () => {
    const own = held();
    const answers = { a: held<Answer>(), b: held<Answer>() };
    const { framework, entered } = fakeFramework({ quiesceWaits: own.promise });
    const { fleet, asked } = fakeFleet({
      a: (times) => (times === 1 ? answers.a.promise : drained()()), b: (times) => (times === 1 ? answers.b.promise : drained()()),
    });
    const quiet = quiesceForSwitch(framework, fleet, { to: '0.14.0', timeoutMs: 1_000 });
    await until(() => entered() === 1 && asked.length === 2, "this host's quiesce is entered and both children are asked");
    for (const child of [answers.a, answers.b]) child.settle(drained()());
    own.settle();
    expect((await quiet).drained).toBe(true);
  });

  test("an undrained host, or a child that didn't answer, keeps the whole from draining", async () => {
    const busyHost = fakeFramework({ drainAfter: 1_000_000, holders: ['agent'] });
    expect((await quiesceForSwitch(busyHost.framework, fakeFleet({ kid: drained() }).fleet, { to: '0.14.0', timeoutMs: 0 })).drained).toBe(false);
    const mute = fakeFleet({ kid: drained(), mute: () => ({ ok: false, error: 'no answer' }) });
    expect((await quiesceForSwitch(fakeFramework().framework, mute.fleet, { to: '0.14.0', timeoutMs: 0 })).drained).toBe(false);
  });

  test('drains when this host and every child answer drained', async () => {
    const { framework } = fakeFramework();
    const { fleet } = fakeFleet({ kid: drained() });
    expect((await quiesceForSwitch(framework, fleet, { to: '0.14.0', timeoutMs: 1_000 })).drained).toBe(true);
    expect((await quiesceForSwitch(framework, null, { to: '0.14.0', timeoutMs: 1_000 })).drained).toBe(true);
  });

  test('a host quiesced already keeps its reason and is waited on until it drains', async () => {
    const { framework } = fakeFramework({ quiesced: true, reason: 'operator: maintenance', drainAfter: 3 });
    const result = await quiesceForSwitch(framework, null, { to: '0.14.0', timeoutMs: 5_000 });
    expect(result.drained).toBe(true);
    expect(framework.getHostModeStatus().reason).toBe('operator: maintenance');
  });

  test("a host that doesn't drain stays quiesced once the wait is up, and a second call waits again", async () => {
    const { framework, mode } = fakeFramework({ drainAfter: 1_000_000, holders: ['agent'] });
    for (const round of [1, 2]) {
      const started = Date.now();
      const result = await quiesceForSwitch(framework, null, { to: '0.14.0', timeoutMs: 500 });
      expect(Date.now() - started, `round ${round}`).toBeGreaterThanOrEqual(480);
      expect(result.hosts[0]).toMatchObject({ drained: false, activeTurnAgents: ['agent'] });
      expect(result.drained).toBe(false);
    }
    expect(mode()).toEqual({ quiesced: true, reason: SWITCH });
  });

  test("a host whose quiesce is ended while the switch waits can't be counted, and the wait stops on it", async () => {
    const { framework, reads } = fakeFramework({ drainAfter: 1_000_000, holders: ['agent'], resumeBy: 2 });
    const result = await quiesceForSwitch(framework, null, { to: '0.14.0', timeoutMs: 5_000 });
    // The wait's second read finds it serving, and the look reads it twice more.
    expect(reads()).toBe(4);
    expect(result).toEqual({
      drained: false,
      hosts: [{ host: 'this host', answered: false, why: "its quiesce was ended during the switch's quiesce, so it was serving" }],
    });
  });

  test('a child that appears or connects while this host still waits is quiesced at the look, and counted as it is then', async () => {
    const own = held();
    const { framework, entered } = fakeFramework({ quiesceWaits: own.promise });
    const { fleet, asked } = fakeFleet(
      { kid: drained(), unconnected: (times) => (times === 1 ? { ok: false, error: "child 'unconnected' is still starting" } : drained()()) },
      { late: drained(['late-agent']) },
    );
    const quiet = quiesceForSwitch(framework, fleet, { to: '0.14.0', timeoutMs: 5_000 });
    await until(() => entered() === 1 && asked.length === 2, 'the first two children are asked while this host waits');
    own.settle();
    const result = await quiet;
    expect(asked.map((a) => [a.name, (a.request as { waitMs: number }).waitMs])).toEqual([
      ['kid', 5_000], ['unconnected', 5_000], ['kid', 0], ['unconnected', 0], ['late', 0],
    ]);
    expect(result.hosts.slice(1)).toEqual([
      { host: 'kid', answered: true, drained: true, activeTurnAgents: [], backgroundScripts: 0 },
      { host: 'unconnected', answered: true, drained: true, activeTurnAgents: [], backgroundScripts: 0 },
      { host: 'late', answered: true, drained: true, activeTurnAgents: ['late-agent'], backgroundScripts: 0 },
    ]);
    expect(result.drained).toBe(true);
  });

  test("an answer from the wait that no longer holds at the look isn't counted, for a child or for this host", async () => {
    // A child drained during the wait, then resumed and taking a turn: the
    // look quiesces it again, and it answers busy.
    const busy = { ok: true, data: { drained: false, activeTurnAgents: ['kid-agent'], backgroundScripts: 0 } };
    const { fleet } = fakeFleet({ kid: (times) => (times === 1 ? drained()() : busy) });
    const child = await quiesceForSwitch(fakeFramework().framework, fleet, { to: '0.14.0', timeoutMs: 1_000 });
    expect(child.hosts[1]).toEqual({ host: 'kid', answered: true, drained: false, activeTurnAgents: ['kid-agent'], backgroundScripts: 0 });
    expect(child.drained).toBe(false);

    // This host drains at once, and is resumed from elsewhere while a child's
    // answer is still out, during the wait and then during the look: it's
    // read last, as it is.
    for (const during of [1, 2]) {
      const answer = held<Answer>();
      const host = fakeFramework();
      const late = fakeFleet({ kid: (times) => (times === during ? answer.promise : drained()()) });
      const quiet = quiesceForSwitch(host.framework, late.fleet, { to: '0.14.0', timeoutMs: 1_000 });
      await until(() => host.calls.length === 1 && late.asked.length === during, "this host has quiesced and the child's answer is out");
      await host.framework.resume();
      answer.settle(drained()());
      const result = await quiet;
      expect(result.hosts[0], `resumed during ${during === 1 ? 'the wait' : 'the look'}`)
        .toEqual({ host: 'this host', answered: false, why: "its quiesce was ended during the switch's quiesce, so it was serving" });
      expect(result.drained).toBe(false);
    }
  });

  describe('this host counts as drained only when it was quiesced and drained as the look starts, and is still quiesced at its end', () => {
    /** Quiesce `host` with one child, hold the child's answer to the look,
     *  and do `meanwhile` while it's held. */
    async function look(host: ReturnType<typeof fakeFramework>, meanwhile: (kids: ReturnType<typeof fakeFleet>) => Promise<void> | void) {
      const answer = held<Answer>();
      const kids = fakeFleet({ kid: (times) => (times === 2 ? answer.promise : drained()()) });
      const quiet = quiesceForSwitch(host.framework, kids.fleet, { to: '0.14.0', timeoutMs: 0 });
      await until(() => kids.asked.length === 2, "the child's answer to the look is out");
      await meanwhile(kids);
      answer.settle(drained()());
      return { result: await quiet, kids };
    }

    test("one with a turn alive as the look starts is counted as it was then, though the turn ends during the look, since it could launch a child the look doesn't list", async () => {
      const host = fakeFramework({ drainAfter: Number.POSITIVE_INFINITY, holders: ['agent'] });
      const { result, kids } = await look(host, (fleet) => {
        host.drain();
        fleet.running.set('late', drained());
      });
      expect(kids.asked.map((a) => a.name)).toEqual(['kid', 'kid']);
      expect(result.hosts.map((h) => h.host)).toEqual(['this host', 'kid']);
      expect(result.hosts[0]).toEqual({ host: 'this host', answered: true, drained: false, activeTurnAgents: ['agent'], backgroundScripts: 1 });
      expect(result.drained).toBe(false);
    });

    test('one quiesced and drained as the look starts is counted as it is at its end', async () => {
      // A script left running outside any turn ends during the look.
      const scripts = fakeFramework();
      const { result } = await look(scripts, () => scripts.set({ backgroundScripts: 0 }));
      expect(result.hosts[0]).toEqual({ host: 'this host', answered: true, drained: true, activeTurnAgents: [], backgroundScripts: 0 });
      expect(result.drained).toBe(true);

      // A turn alive at its end, as one resumed and quiesced again within the
      // look could have, keeps it from draining.
      const turn = fakeFramework();
      const busy = await look(turn, () => turn.set({ drained: false, activeTurnAgents: ['late-agent'] }));
      expect(busy.result.hosts[0]).toEqual({ host: 'this host', answered: true, drained: false, activeTurnAgents: ['late-agent'], backgroundScripts: 1 });
      expect(busy.result.drained).toBe(false);
    });

    test("one with a turn alive as the look starts and resumed during it can't be counted", async () => {
      const host = fakeFramework({ drainAfter: Number.POSITIVE_INFINITY, holders: ['agent'] });
      const { result } = await look(host, () => host.framework.resume().then(() => undefined));
      expect(result.hosts[0]).toEqual({ host: 'this host', answered: false, why: "its quiesce was ended during the switch's quiesce, so it was serving" });
      expect(result.drained).toBe(false);
    });

    test("one serving as the look starts can't be counted, though it's quiesced and drained by its end", async () => {
      const host = fakeFramework();
      const answers = [held<Answer>(), held<Answer>()];
      const kids = fakeFleet({ kid: (times) => answers[times - 1]!.promise });
      const quiet = quiesceForSwitch(host.framework, kids.fleet, { to: '0.14.0', timeoutMs: 1_000 });
      await until(() => host.calls.length === 1 && kids.asked.length === 1, "this host has quiesced and the child's answer is out");
      await host.framework.resume();
      answers[0]!.settle(drained()());
      // While the child's answer to the look is out, this host is quiesced
      // again, from elsewhere.
      await until(() => kids.asked.length === 2, "the child's answer to the look is out");
      await host.framework.quiesce({ reason: 'operator', timeoutMs: 1_000 });
      answers[1]!.settle(drained()());
      const result = await quiet;
      expect(host.mode()).toEqual({ quiesced: true, reason: 'operator' });
      expect(result.hosts[0]).toEqual({ host: 'this host', answered: false, why: "its quiesce was ended during the switch's quiesce, so it was serving" });
      expect(result.drained).toBe(false);
    });
  });

  test('the longest wait a timer can hold with the margin is taken', async () => {
    const longest = 2 ** 31 - 1 - 10_000;
    const { framework, calls } = fakeFramework();
    const { fleet, asked } = fakeFleet({ kid: drained() });
    expect((await quiesceForSwitch(framework, fleet, { to: '0.14.0', timeoutMs: longest })).drained).toBe(true);
    expect(calls).toEqual([`quiesce ${SWITCH} for ${longest} ms`]);
    expect(asked[0]!.timeoutMs).toBe(2 ** 31 - 1);
    expect(await answerSwitchRequest(fakeFramework().framework, { op: 'quiesce', to: '0.14.0', waitMs: longest })).toMatchObject({ answered: true });
  });

  test("a wait that isn't a number of milliseconds a timer can hold is refused before anything is quiesced", async () => {
    // A request's timer holds the wait and ten seconds' margin, so a wait
    // that fits a timer only without the margin is refused too.
    for (const timeoutMs of [Number.POSITIVE_INFINITY, Number.NaN, -1, 2 ** 31, 2 ** 31 - 1 - 10_000 + 1]) {
      const { framework, entered } = fakeFramework();
      const { fleet, asked } = fakeFleet({ kid: drained() });
      await expect(quiesceForSwitch(framework, fleet, { to: '0.14.0', timeoutMs }), String(timeoutMs)).rejects.toThrow(RangeError);
      expect(entered()).toBe(0);
      expect(asked).toEqual([]);
    }
  });

  test('a quiesce this host refuses is thrown once the children have answered', async () => {
    const answer = held<Answer>();
    const { framework, entered } = fakeFramework({ quiesceFails: new Error("the deferred writes can't reach disk") });
    const { fleet, asked } = fakeFleet({ kid: () => answer.promise });
    let thrown = false;
    const quiet = quiesceForSwitch(framework, fleet, { to: '0.14.0', timeoutMs: 1_000 }).catch((error: unknown) => { thrown = true; throw error; });
    await until(() => entered() === 1 && asked.length === 1, "this host's quiesce has failed and the child's answer is out");
    // A tick lets a rejection already made reach the catch above.
    await Bun.sleep(0);
    expect(thrown).toBe(false);
    answer.settle(drained()());
    await expect(quiet).rejects.toThrow("can't reach disk");
  });

  test("a child's answer that doesn't say whether it drained, who holds a turn and what scripts it runs counts as no answer", async () => {
    const why = "its answer doesn't say whether it drained, who holds a turn and what scripts it runs";
    for (const data of [
      { drained: true, backgroundScripts: 0 },
      { drained: 'yes', activeTurnAgents: [], backgroundScripts: 0 },
      { drained: true, activeTurnAgents: [7], backgroundScripts: 0 },
      { drained: true, activeTurnAgents: [] },
      { drained: true, activeTurnAgents: [], backgroundScripts: -1 },
      { drained: true, activeTurnAgents: [], backgroundScripts: 'none' },
      { drained: true, activeTurnAgents: [], backgroundScripts: 0.5 },
    ]) {
      const { fleet } = fakeFleet({ odd: () => ({ ok: true, data }) });
      expect((await quiesceForSwitch(fakeFramework().framework, fleet, { to: '0.14.0', timeoutMs: 0 })).hosts[1])
        .toEqual({ host: 'odd', answered: false, why });
    }
  });

  test("a child that can't be counted says why, and so does one whose answer gives no reason", async () => {
    const { fleet } = fakeFleet({
      serving: () => ({ ok: true, data: { host: 'this host', answered: false, why: "its quiesce was ended during the switch's quiesce, so it was serving" } }),
      silent: () => ({ ok: true, data: { answered: false } }),
    });
    expect((await quiesceForSwitch(fakeFramework().framework, fleet, { to: '0.14.0', timeoutMs: 0 })).hosts.slice(1)).toEqual([
      { host: 'serving', answered: false, why: "its quiesce was ended during the switch's quiesce, so it was serving" },
      { host: 'silent', answered: false, why: "its answer doesn't say why" },
    ]);
  });
});

describe('resuming', () => {
  test("try later ends the switch's quiesce on each child and on this host, and says what each did", async () => {
    const { framework, calls } = fakeFramework({ quiesced: true, reason: SWITCH });
    const { fleet, asked } = fakeFleet({
      kid: () => ({ ok: true, data: { resumed: true } }),
      held: () => ({ ok: true, data: { resumed: false, why: "its quiesce isn't the switch's (operator: x), so it stays" } }),
      mute: () => ({ ok: false, error: "child 'mute' has exited, so it isn't running" }),
      odd: () => ({ ok: true, data: {} }),
    });
    expect(await resumeAfterSwitchQuiesce(framework, fleet)).toEqual({
      hosts: [
        { host: 'this host', resumed: true },
        { host: 'kid', resumed: true },
        { host: 'held', resumed: false, why: "its quiesce isn't the switch's (operator: x), so it stays" },
        { host: 'mute', resumed: false, why: "child 'mute' has exited, so it isn't running" },
        { host: 'odd', resumed: false, why: "its answer doesn't say" },
      ],
    });
    expect(asked.map((a) => [a.request, a.timeoutMs])).toEqual(Array(4).fill([{ op: 'resume' }, 10_000]));
    expect(calls).toEqual(['resume']);
  });

  test("try later on a host whose resume is refused says why, as it says of a child", async () => {
    const { framework } = fakeFramework({ quiesced: true, reason: SWITCH, resumeFails: 'before' });
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await resumeAfterSwitchQuiesce(framework, null)).toEqual({
        hosts: [{ host: 'this host', resumed: false, why: 'it stays quiesced, since agent-framework refused its resume (resume refused: the feasibility gate refused it); a later resume, such as try later or the next start, can succeed once that is resolved' }],
      });
    } finally {
      errors.mockRestore();
    }
  });

  test("a serving host has no quiesce to end, and an operator's is left as it is", async () => {
    const serving = fakeFramework();
    expect(await resumeIfSwitch(serving.framework)).toEqual({ resumed: false, why: 'it was serving' });
    const operator = fakeFramework({ quiesced: true, reason: 'operator: maintenance' });
    expect(await resumeIfSwitch(operator.framework)).toEqual({ resumed: false, why: "its quiesce isn't the switch's (operator: maintenance), so it stays" });
    expect([...serving.calls, ...operator.calls]).toEqual([]);
  });

  test("a resume the framework refuses leaves the switch's quiesce, says why and logs it", async () => {
    const { framework, mode } = fakeFramework({ quiesced: true, reason: SWITCH, resumeFails: 'before' });
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    const why = 'it stays quiesced, since agent-framework refused its resume (resume refused: the feasibility gate refused it); a later resume, such as try later or the next start, can succeed once that is resolved';
    try {
      expect(await resumeIfSwitch(framework)).toEqual({ resumed: false, why, refused: true });
      expect(errors.mock.calls.map((c) => String(c[0]))).toEqual([`[update] This host's switch quiesce didn't end: ${why}`]);
    } finally {
      errors.mockRestore();
    }
    expect(mode().quiesced).toBe(true);
  });

  test("a resume that fails once the host serves again says it's serving", async () => {
    const { framework, mode } = fakeFramework({ quiesced: true, reason: SWITCH, resumeFails: 'after' });
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    const why = "it's serving, though agent-framework's resume failed after the quiesce ended: EIO: the record of the quiesce's " +
      "end couldn't be written";
    try {
      expect(await resumeIfSwitch(framework)).toEqual({ resumed: true, why });
      expect(errors.mock.calls.map((c) => String(c[0]))).toEqual([`[update] This host's switch quiesce ended, with an error: ${why}`]);
    } finally {
      errors.mockRestore();
    }
    expect(mode().quiesced).toBe(false);
  });
});

describe("a fleet child's answer", () => {
  test('a quiesce answers whether it drained and who holds a turn; a resume, what it did', async () => {
    const { framework, calls } = fakeFramework({ holders: ['kid-agent'] });
    expect(await answerSwitchRequest(framework, { op: 'quiesce', to: '0.14.0', waitMs: 0 })).toEqual({
      host: 'this host', answered: true, drained: true, activeTurnAgents: ['kid-agent'], backgroundScripts: 1,
    });
    expect(await answerSwitchRequest(framework, { op: 'resume' })).toEqual({ resumed: true });
    expect(calls).toEqual([`quiesce ${SWITCH} for 0 ms`, 'resume']);
  });

  test("a request it can't read is refused, and changes nothing", async () => {
    for (const request of [
      null, {}, { op: 'resum' }, { op: 'quiesce', waitMs: 0 }, { op: 'quiesce', to: '', waitMs: 0 },
      { op: 'quiesce', to: '0.14.0' }, { op: 'quiesce', to: '0.14.0', waitMs: -1 }, { op: 'quiesce', to: '0.14.0', waitMs: Number.NaN },
      { op: 'quiesce', to: '0.14.0', waitMs: 2 ** 31 - 1 - 10_000 + 1 },
    ]) {
      const { framework, calls } = fakeFramework({ quiesced: true, reason: SWITCH });
      await expect(answerSwitchRequest(framework, request), JSON.stringify(request)).rejects.toThrow("This fleet child can't read the switch's request");
      expect(calls).toEqual([]);
    }
    await expect(answerSwitchRequest(fakeFramework().framework, null)).rejects.toThrow(
      "This fleet child can't read the switch's request (null), so it did nothing. It may run another release than the install's " +
      "host does: fleet--restart of it starts it on the host's release.",
    );
  });
});
