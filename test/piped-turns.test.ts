import { describe, expect, jest, test } from 'bun:test';
import { PIPED_TURN_CAP_MS, createPipedTurns, switchFollowing, traceFollower, type TraceSource } from '../src/piped-turns.js';
import { STREAM_END_TRACES, TURN_SETTLED_TRACES } from '../src/state/turn-trace.js';
import { TuiModule, onHostLineTakenIn } from '../src/modules/tui-module.js';

function setUp(showsItself?: (tool: string) => boolean) {
  const out: string[] = [];
  const turns = createPipedTurns('clerk', {
    write: (text) => { out.push(`out:${text}`); },
    log: (line) => { out.push(`log:${line}`); },
    error: (line) => { out.push(`err:${line}`); },
  }, undefined, showsItself);
  const emit = (type: string, extra: Record<string, unknown> = {}) =>
    turns.onTrace({ type, agentName: 'clerk', ...extra });
  return { out, turns, emit };
}

async function flushed(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function onFakeTimers(body: (advance: (ms: number) => Promise<void>, settledNow: (wait: Promise<void>) => Promise<boolean>) => Promise<void>): Promise<void> {
  jest.useFakeTimers();
  try {
    await body(
      async (ms) => { jest.advanceTimersByTime(ms); await flushed(); },
      async (wait) => {
        let done = false;
        void wait.then(() => { done = true; });
        await flushed();
        return done;
      },
    );
  } finally {
    jest.useRealTimers();
  }
}

async function settled(wait: Promise<void>): Promise<boolean> {
  let done = false;
  void wait.then(() => { done = true; });
  await Bun.sleep(0);
  return done;
}

describe('the wait for a line\'s turn', () => {
  for (const end of TURN_SETTLED_TRACES) {
    test(`${end} from the primary agent ends it`, async () => {
      const { turns, emit } = setUp();
      const wait = turns.waitForTurn(60_000);
      turns.takenIn();
      emit('inference:started');
      expect(await settled(wait)).toBe(false);
      emit(end, { error: 'x' });
      expect(await settled(wait)).toBe(true);
    });
  }

  test('a line taken in while a turn runs is owed a turn after it, even once its wait has run out, until one starts', async () => {
    await onFakeTimers(async (advance) => {
      const { turns, emit } = setUp();
      const settledTrace = [...TURN_SETTLED_TRACES][0]!;
      expect(turns.owed()).toBe(false);
      emit('inference:started');
      void turns.waitForTurn(400);
      turns.takenIn();
      expect(turns.owed()).toBe(true);
      await advance(400);
      emit(settledTrace);
      expect({ running: turns.running(), owed: turns.owed() }).toEqual({ running: false, owed: true });
      emit('inference:started');
      expect(turns.owed()).toBe(false);
      emit(settledTrace);
      expect({ running: turns.running(), owed: turns.owed() }).toEqual({ running: false, owed: false });
    });
  });

  test('a line\'s wait isn\'t ended by the turn of an earlier line taken in after that line\'s wait ran out', async () => {
    await onFakeTimers(async (advance, settledNow) => {
      const { turns, emit } = setUp();
      const settledTrace = [...TURN_SETTLED_TRACES][0]!;
      void turns.waitForTurn(400);
      await advance(400);
      const second = turns.waitForTurn(400);
      turns.takenIn();
      emit('inference:started');
      emit(settledTrace);
      expect(await settledNow(second)).toBe(false);
      turns.takenIn();
      emit('inference:started');
      emit(settledTrace);
      expect(await settledNow(second)).toBe(true);
    });
  });

  test('a turn that starts and settles before the line is taken in, such as an unrelated wake\'s, leaves its wait', async () => {
    const { turns, emit } = setUp();
    const settledTrace = [...TURN_SETTLED_TRACES][0]!;
    const wait = turns.waitForTurn(60_000);
    emit('inference:started');
    emit(settledTrace);
    expect(await settled(wait)).toBe(false);
    turns.takenIn();
    emit('inference:started');
    emit(settledTrace);
    expect(await settled(wait)).toBe(true);
  });

  test('a line is unanswered while its turn runs, and while it\'s owed one, even one whose wait ran out before it was taken in, as batch mode and the setup close both ask', async () => {
    await onFakeTimers(async (advance) => {
      const { turns, emit } = setUp();
      const settledTrace = [...TURN_SETTLED_TRACES][0]!;
      expect(turns.unanswered()).toBe(false);
      void turns.waitForTurn(400);
      await advance(400);
      expect({ running: turns.running(), unanswered: turns.unanswered() }).toEqual({ running: false, unanswered: true });
      turns.takenIn();
      expect(turns.unanswered()).toBe(true);
      emit('inference:started');
      expect(turns.unanswered()).toBe(true);
      emit(settledTrace);
      expect(turns.unanswered()).toBe(false);
    });
  });

  test('a line whose wait ran out before it was taken in is owed a turn until its take-in comes and a turn starts, and a switch forgets it', async () => {
    await onFakeTimers(async (advance) => {
      const { turns, emit } = setUp();
      void turns.waitForTurn(400);
      await advance(400);
      expect(turns.owed()).toBe(true);
      turns.takenIn();
      expect(turns.owed()).toBe(true);
      emit('inference:started');
      expect(turns.owed()).toBe(false);
      void turns.waitForTurn(400);
      await advance(400);
      expect(turns.owed()).toBe(true);
      turns.switched();
      expect(turns.owed()).toBe(false);
    });
  });

  test('a line whose wait ran out and the line after it, both taken in before one turn, are answered by that turn', async () => {
    await onFakeTimers(async (advance, settledNow) => {
      const { turns, emit } = setUp();
      const settledTrace = [...TURN_SETTLED_TRACES][0]!;
      void turns.waitForTurn(400);
      await advance(400);
      const second = turns.waitForTurn(400);
      turns.takenIn();
      turns.takenIn();
      emit('inference:started');
      expect(await settledNow(second)).toBe(false);
      emit(settledTrace);
      expect(await settledNow(second)).toBe(true);
      expect(turns.owed()).toBe(false);
    });
  });

  test('endAll ends every wait at once, and no cap fires after it', async () => {
    await onFakeTimers(async (advance, settledNow) => {
      const { out, turns, emit } = setUp();
      emit('inference:started');
      const first = turns.waitForTurn(400);
      const second = turns.waitForTurn(400);
      turns.endAll();
      expect([await settledNow(first), await settledNow(second)]).toEqual([true, true]);
      await advance(PIPED_TURN_CAP_MS);
      expect(out.filter((line) => line.includes('no answer after'))).toEqual([]);
    });
  });

  test('a turn that starts before the host\'s module takes the line in, such as a wake\'s, doesn\'t end its wait, and the next turn\'s end does', async () => {
    const { turns, emit } = setUp();
    const takeIn = (source: string) => new TuiModule().onProcess(
      { type: 'external-message', source, content: `from ${source}`, metadata: {}, triggerInference: true } as never, {} as never);
    const settledTrace = [...TURN_SETTLED_TRACES][0]!;
    onHostLineTakenIn(() => turns.takenIn());
    try {
      const wait = turns.waitForTurn(60_000);
      emit('inference:started');
      await takeIn('cli');
      emit(settledTrace);
      expect(await settled(wait)).toBe(false);
      emit('inference:started');
      await takeIn('tui');
      emit(settledTrace);
      expect(await settled(wait)).toBe(true);
    } finally {
      onHostLineTakenIn(null);
    }
  });

  test('a failure keeps it waiting, and the retry\'s end ends it', async () => {
    const { turns, emit, out } = setUp();
    const wait = turns.waitForTurn(60_000);
    turns.takenIn();
    emit('inference:started');
    emit('inference:failed', { error: 'overloaded' });
    expect(await settled(wait)).toBe(false);
    expect(out).toContain('err:Error: overloaded');
    emit('inference:started');
    emit('inference:tokens', { content: 'answer' });
    emit('inference:completed');
    expect(await settled(wait)).toBe(true);
  });

  test("an end whose error is empty or missing prints 'Unknown error'", async () => {
    const { turns, emit, out } = setUp();
    const wait = turns.waitForTurn(60_000);
    turns.takenIn();
    emit('inference:started');
    emit('inference:failed', { error: '' });
    expect(out).toContain('err:Error: Unknown error');
    emit('inference:started');
    emit('inference:exhausted', {});
    expect(await settled(wait)).toBe(true);
    expect(out).toContain('err:(turn ended: Unknown error)');
  });

  test('a failure the framework gives up on ends it at exhausted, printing the error once', async () => {
    const { turns, emit, out } = setUp();
    const wait = turns.waitForTurn(60_000);
    turns.takenIn();
    emit('inference:started');
    emit('inference:failed', { error: 'bad request' });
    emit('inference:exhausted', { error: 'bad request' });
    expect(await settled(wait)).toBe(true);
    expect(out.filter((l) => l.includes('bad request'))).toEqual(['err:Error: bad request']);
  });

  test('another agent\'s end leaves it waiting', async () => {
    const { turns, emit } = setUp();
    const wait = turns.waitForTurn(60_000);
    turns.takenIn();
    emit('inference:started');
    for (const end of STREAM_END_TRACES) {
      turns.onTrace({ type: 'inference:started', agentName: 'spawn-research-1' });
      turns.onTrace({ type: end, agentName: 'spawn-research-1', error: 'x' });
    }
    expect(await settled(wait)).toBe(false);
    emit('inference:turn_ended');
    expect(await settled(wait)).toBe(true);
  });

  test('a second end of a settled turn prints nothing and leaves the next line\'s wait alone', async () => {
    const { turns, emit, out } = setUp();
    const first = turns.waitForTurn(60_000);
    turns.takenIn();
    emit('inference:started');
    emit('inference:completed');
    emit('inference:turn_ended');
    expect(await settled(first)).toBe(true);
    const second = turns.waitForTurn(60_000);
    turns.takenIn();
    emit('inference:turn_ended');
    expect(await settled(second)).toBe(false);
    expect(out).toEqual(['out:\n', 'out:\n']);
  });

  test('a wait asked for while a turn runs isn\'t ended by that turn\'s end, but by the end of the turn after it', async () => {
    const { turns, emit } = setUp();
    const opening = turns.waitForTurn(60_000);
    turns.takenIn();
    emit('inference:started');
    const typed = turns.waitForTurn(60_000);
    turns.takenIn();
    emit('inference:failed', { error: 'held' });
    emit('inference:started');
    emit('inference:completed');
    expect(await settled(opening)).toBe(true);
    expect(await settled(typed)).toBe(false);
    emit('inference:started');
    emit('inference:completed');
    expect(await settled(typed)).toBe(true);
  });

  test('the cap of a wait asked for behind another counts from when that one ends: a line typed during the opening starts its cap at the opening\'s end', async () => {
    await onFakeTimers(async (advance, settledNow) => {
      const { out, turns, emit } = setUp();
      const opening = turns.waitForTurn(null);
      turns.takenIn();
      emit('inference:started');
      const typed = turns.waitForTurn(300);
      turns.takenIn();
      await advance(500);
      expect(await settledNow(typed)).toBe(false);
      expect(out.some((line) => line.includes('no answer after'))).toBe(false);
      emit('inference:completed');
      expect(await settledNow(opening)).toBe(true);
      await advance(299);
      expect(await settledNow(typed)).toBe(false);
      await advance(1);
      expect(await settledNow(typed)).toBe(true);
      expect(out.at(-1)).toBe('err:(no answer after 0.3 s: going on; it prints here when it comes)');
    });
  });

  test('a wait its cap ends starts the cap of the one behind it, so a turn that never ends holds no line past its cap', async () => {
    await onFakeTimers(async (advance, settledNow) => {
      const { out, turns, emit } = setUp();
      const first = turns.waitForTurn(200);
      emit('inference:started');
      const second = turns.waitForTurn(200);
      await advance(300);
      expect(await settledNow(first)).toBe(true);
      expect(await settledNow(second)).toBe(false);
      await advance(250);
      expect(await settledNow(second)).toBe(true);
      expect(out.filter((line) => line.includes('no answer after'))).toHaveLength(2);
    });
  });

  test('a turn that ends no wait, with none left, is told; one that ends a wait isn\'t', async () => {
    const told: string[] = [];
    const out: string[] = [];
    const turns = createPipedTurns('clerk', {
      write: (text) => { out.push(text); }, log: (line) => { out.push(line); }, error: (line) => { out.push(line); },
    }, undefined, undefined, () => told.push('settled'));
    const emit = (type: string) => turns.onTrace({ type, agentName: 'clerk' });
    const wait = turns.waitForTurn(60_000);
    turns.takenIn();
    emit('inference:started');
    emit('inference:completed');
    expect(await settled(wait)).toBe(true);
    expect(told).toEqual([]);
    emit('inference:started');
    emit('inference:completed');
    expect(told).toEqual(['settled']);
  });

  test('a wait\'s cap doesn\'t count the time its caps are held, as while the terminal asks the person something, and counts on from what was left of it', async () => {
    await onFakeTimers(async (advance, settledNow) => {
      const { out, turns, emit } = setUp();
      const typed = turns.waitForTurn(400);
      emit('inference:started');
      await advance(150);
      const release = turns.holdCaps();
      await advance(600);
      expect(await settledNow(typed)).toBe(false);
      expect(out.some((line) => line.includes('no answer after'))).toBe(false);
      release();
      await advance(249);
      expect(await settledNow(typed)).toBe(false);
      await advance(1);
      expect(await settledNow(typed)).toBe(true);
      expect(out.at(-1)).toBe('err:(no answer after 0.4 s: going on; it prints here when it comes)');
    });
  });

  test('a wait cancelled, as when its line never went in, leaves nothing behind it: the next line\'s cap counts from its own ask', async () => {
    await onFakeTimers(async (advance, settledNow) => {
      const { out, turns } = setUp();
      const failed = turns.waitForTurn(400);
      failed.cancel();
      expect(await settledNow(failed)).toBe(true);
      const next = turns.waitForTurn(400);
      await advance(399);
      expect(await settledNow(next)).toBe(false);
      await advance(1);
      expect(await settledNow(next)).toBe(true);
      expect(out.filter((line) => line.includes('no answer after'))).toEqual(['err:(no answer after 0.4 s: going on; it prints here when it comes)']);
    });
  });

  test('a wait asked for while caps are held starts its cap once they\'re released', async () => {
    await onFakeTimers(async (advance, settledNow) => {
      const { out, turns } = setUp();
      const release = turns.holdCaps();
      const typed = turns.waitForTurn(200);
      await advance(400);
      expect(await settledNow(typed)).toBe(false);
      release();
      await advance(199);
      expect(await settledNow(typed)).toBe(false);
      await advance(1);
      expect(await settledNow(typed)).toBe(true);
      expect(out.at(-1)).toBe('err:(no answer after 0.2 s: going on; it prints here when it comes)');
    });
  });

  test('waits asked for before a turn starts all end at its end', async () => {
    const { turns, emit } = setUp();
    const first = turns.waitForTurn(60_000);
    turns.takenIn();
    const second = turns.waitForTurn(60_000);
    turns.takenIn();
    emit('inference:started');
    emit('inference:completed');
    expect(await settled(first)).toBe(true);
    expect(await settled(second)).toBe(true);
  });

  test('the cap ends it when nothing settles the turn, and says so', async () => {
    const { out, turns, emit } = setUp();
    const wait = turns.waitForTurn(300);
    emit('inference:started');
    emit('inference:failed', { error: 'held' });
    await wait;
    expect(out.at(-1)).toBe('err:(no answer after 0.3 s: going on; it prints here when it comes)');
  });

  test('with no cap, only the turn\'s end, or the conversation closing, ends it, and nothing is said of a cap', async () => {
    await onFakeTimers(async (advance, settledNow) => {
      const { out, turns, emit } = setUp();
      const wait = turns.waitForTurn(null);
      turns.takenIn();
      emit('inference:started');
      emit('inference:failed', { error: 'held' });
      await advance(PIPED_TURN_CAP_MS * 10);
      expect(await settledNow(wait)).toBe(false);
      emit('inference:completed');
      expect(await settledNow(wait)).toBe(true);
      expect(out.some((line) => line.includes('no answer after'))).toBe(false);
    });
  });

  test('a cap held and released keeps the time it had left when the clock is set back meanwhile', async () => {
    await onFakeTimers(async (advance, settledNow) => {
      const { out, turns, emit } = setUp();
      const typed = turns.waitForTurn(300);
      emit('inference:started');
      await advance(200);
      jest.setSystemTime(Date.now() - 3_600_000);
      const release = turns.holdCaps();
      release();
      await advance(99);
      expect(await settledNow(typed)).toBe(false);
      await advance(2);
      expect(await settledNow(typed)).toBe(true);
      expect(out.at(-1)).toBe('err:(no answer after 0.3 s: going on; it prints here when it comes)');
    });
  });

  test('a turn that settles before the cap says nothing of it', async () => {
    const { out, turns, emit } = setUp();
    const wait = turns.waitForTurn(50);
    turns.takenIn();
    emit('inference:started');
    emit('inference:completed');
    await wait;
    await Bun.sleep(100);
    expect(out.some((line) => line.includes('no answer after'))).toBe(false);
  });
});

describe('a session switch', () => {
  test('ends every wait still pending, capped or not, and no cap fires for them after it', async () => {
    const { out, turns, emit } = setUp();
    const typed = turns.waitForTurn(100);
    turns.takenIn();
    emit('inference:started');
    const behind = turns.waitForTurn(null);
    turns.takenIn();
    turns.switched();
    expect(await settled(typed)).toBe(true);
    expect(await settled(behind)).toBe(true);
    await Bun.sleep(200);
    expect(out.some((line) => line.includes('no answer after'))).toBe(false);
    const next = turns.waitForTurn(60_000);
    turns.takenIn();
    emit('inference:started');
    emit('inference:completed');
    expect(await settled(next)).toBe(true);
  });
});

describe('what piped mode prints', () => {
  test('every agent\'s prose, with each stream\'s first end closing its line', () => {
    const { turns, emit, out } = setUp();
    emit('inference:started');
    emit('inference:tokens', { content: 'Let me ask.' });
    turns.onTrace({ type: 'inference:started', agentName: 'spawn-research-1' });
    turns.onTrace({ type: 'inference:tokens', agentName: 'spawn-research-1', content: 'Found it.' });
    turns.onTrace({ type: 'inference:turn_ended', agentName: 'spawn-research-1' });
    emit('inference:tokens', { content: 'Done.' });
    emit('inference:turn_ended');
    expect(out).toEqual([
      'out:\n', 'out:Let me ask.',
      'out:\n', 'out:Found it.', 'out:\n',
      'out:Done.', 'out:\n',
    ]);
  });

  test('another agent\'s aborted stream only closes its line, and its lone exhausted prints an Error: line on stderr, as its failed does', () => {
    const { turns, out } = setUp();
    turns.onTrace({ type: 'inference:started', agentName: 'spawn-a' });
    turns.onTrace({ type: 'inference:aborted', agentName: 'spawn-a', reason: 'user' });
    turns.onTrace({ type: 'inference:started', agentName: 'spawn-b' });
    turns.onTrace({ type: 'inference:exhausted', agentName: 'spawn-b', error: 'Stream aborted: timeout' });
    expect(out).toEqual(['out:\n', 'out:\n', 'out:\n', 'out:\n', 'err:Error: Stream aborted: timeout']);
  });

  test('a turn that ends on stderr closes its prose line on stdout, so what prints next starts a line of its own', () => {
    const { emit, out, turns } = setUp();
    emit('inference:started');
    emit('inference:tokens', { content: 'Partial answer' });
    emit('inference:exhausted', { error: 'Stream aborted: timeout' });
    emit('inference:started');
    emit('inference:tokens', { content: 'Another' });
    emit('inference:failed', { error: 'bad request' });
    emit('inference:exhausted', { error: 'bad request' });
    turns.onTrace({ type: 'inference:started', agentName: 'spawn-c' });
    turns.onTrace({ type: 'inference:tokens', agentName: 'spawn-c', content: 'Half' });
    turns.onTrace({ type: 'inference:failed', agentName: 'spawn-c', error: 'overloaded' });
    expect(out).toEqual([
      'out:\n', 'out:Partial answer', 'out:\n', 'err:(turn ended: Stream aborted: timeout)',
      'out:\n', 'out:Another', 'out:\n', 'err:Error: bad request', 'err:Turn ended after 1 attempt.',
      'out:\n', 'out:Half', 'out:\n', 'err:Error: overloaded',
    ]);
  });

  test('a stop that cancels a failed attempt\'s retry prints nothing more', () => {
    const { emit, out } = setUp();
    emit('inference:started');
    emit('inference:failed', { error: 'overloaded' });
    emit('inference:aborted', { reason: 'quiesce_abandoned' });
    expect(out).toEqual(['out:\n', 'out:\n', 'err:Error: overloaded']);
  });

  test('tool calls as before, a long input cut at 120 characters', () => {
    const { emit, out } = setUp();
    const long = JSON.stringify({ pattern: 'x'.repeat(200) });
    emit('inference:tool_calls_yielded', { calls: [{ name: 'read' }, { name: 'grep' }] });
    emit('tool:started', { tool: 'read', input: { path: 'a.txt' } });
    emit('tool:started', { tool: 'grep', input: { pattern: 'x'.repeat(200) } });
    emit('tool:started', { tool: 'list' });
    expect(out).toEqual([
      'log:\n[tools] read, grep',
      'log:[tool] read {"path":"a.txt"}',
      `log:[tool] grep ${long.slice(0, 120)}...`,
      'log:[tool] list',
    ]);
  });

  test('a tool that shows the person what it does itself gets no trace: a batch of only such calls just ends the line, and a mixed batch lists the others', () => {
    const { emit, out } = setUp((tool) => tool.startsWith('setup--'));
    emit('inference:tool_calls_yielded', { calls: [{ name: 'setup--run' }, { name: 'setup--ask_secret' }] });
    emit('tool:started', { tool: 'setup--run', input: { command: 'ls' } });
    emit('tool:started', { tool: 'setup--ask_secret', input: { name: 'DISCORD_TOKEN' } });
    emit('inference:tool_calls_yielded', { calls: [{ name: 'setup--run' }, { name: 'time--now' }] });
    emit('tool:started', { tool: 'setup--run', input: { command: 'ls' } });
    emit('tool:started', { tool: 'time--now' });
    expect(out).toEqual(['out:\n', 'log:\n[tools] time--now', 'log:[tool] time--now']);
  });

  test('how the primary\'s turn ended: a stop on stdout, a turn the framework ended as a failure on stderr', () => {
    const { emit, out } = setUp();
    emit('inference:started');
    emit('inference:aborted', { reason: 'user' });
    emit('inference:started');
    emit('inference:exhausted', { error: 'Stream aborted: timeout' });
    expect(out).toEqual([
      'out:\n', 'log:\n(turn aborted: user)',
      'out:\n', 'out:\n', 'err:(turn ended: Stream aborted: timeout)',
    ]);
  });
});

describe('following one framework at a time', () => {
  function source(): TraceSource & { emit(event: unknown): void } {
    const listeners = new Set<(event: unknown) => void>();
    return {
      onTrace(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      emit(event) { for (const l of listeners) l(event); },
    };
  }

  test('a framework left, by a switch or by stop, no longer reaches the listener', () => {
    const seen: unknown[] = [];
    const traces = traceFollower((event) => { seen.push(event); });
    const a = source(), b = source();
    traces.follow(a);
    a.emit('a1');
    traces.follow(b);
    a.emit('a2');
    b.emit('b1');
    traces.stop();
    b.emit('b2');
    traces.follow(b);
    b.emit('b3');
    expect(seen).toEqual(['a1', 'b1', 'b3']);
  });

  test('a turn the old framework starts after the switch is asked for is forgotten once it\'s no longer followed, so the new framework\'s first turn ends the opening\'s wait', async () => {
    const { turns } = setUp();
    const traces = traceFollower((event) => { turns.onTrace(event as { type: string }); });
    const old = source(), fresh = source();
    let current: TraceSource & { emit(event: unknown): void } = old;
    const settledTrace = [...TURN_SETTLED_TRACES][0]!;
    traces.follow(old);
    turns.switched();
    old.emit({ type: 'inference:started', agentName: 'clerk' });
    await switchFollowing(traces, async () => { current = fresh; }, () => current, () => turns.switched());
    const opening = turns.waitForTurn(null);
    turns.takenIn();
    fresh.emit({ type: 'inference:started', agentName: 'clerk' });
    fresh.emit({ type: settledTrace, agentName: 'clerk' });
    expect(await settled(opening)).toBe(true);
  });

  test('a session switch stops following first, and follows what the host holds after it, also when it throws', async () => {
    const seen: unknown[] = [];
    const traces = traceFollower((event) => { seen.push(event); });
    const old = source(), fresh = source();
    let current: TraceSource & { emit(event: unknown): void } = old;
    traces.follow(old);
    await switchFollowing(traces, async () => {
      old.emit('during the switch');
      current = fresh;
    }, () => current);
    fresh.emit('after');
    old.emit('the old one, stopped');
    expect(seen).toEqual(['after']);

    seen.length = 0;
    await expect(switchFollowing(traces, async () => { throw new Error('no such session'); }, () => current))
      .rejects.toThrow('no such session');
    fresh.emit('after the failed switch');
    expect(seen).toEqual(['after the failed switch']);
  });
});
