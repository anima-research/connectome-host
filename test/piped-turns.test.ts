/**
 * Piped mode's wait for a line's turn (createPipedTurns): it ends at the
 * primary agent's settled-turn traces, a turn a tool ended included, and not
 * at a failure the framework may retry or hold, nor at another agent's end.
 * Every agent's prose still prints, and each stream's first end closes its
 * line.
 */
import { describe, expect, test } from 'bun:test';
import { createPipedTurns, switchFollowing, traceFollower, type TraceSource } from '../src/piped-turns.js';
import { STREAM_END_TRACES, TURN_SETTLED_TRACES } from '../src/state/turn-trace.js';

function setUp() {
  const out: string[] = [];
  const turns = createPipedTurns('clerk', {
    write: (text) => { out.push(`out:${text}`); },
    log: (line) => { out.push(`log:${line}`); },
    error: (line) => { out.push(`err:${line}`); },
  });
  const emit = (type: string, extra: Record<string, unknown> = {}) =>
    turns.onTrace({ type, agentName: 'clerk', ...extra });
  return { out, turns, emit };
}

/** Whether `wait` has settled after the microtasks queued so far run. */
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
      emit('inference:started');
      expect(await settled(wait)).toBe(false);
      emit(end, { error: 'x' });
      expect(await settled(wait)).toBe(true);
    });
  }

  test('a failure keeps it waiting, and the retry\'s end ends it', async () => {
    const { turns, emit, out } = setUp();
    const wait = turns.waitForTurn(60_000);
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
    emit('inference:started');
    emit('inference:failed', { error: 'bad request' });
    emit('inference:exhausted', { error: 'bad request' });
    expect(await settled(wait)).toBe(true);
    expect(out.filter((l) => l.includes('bad request'))).toEqual(['err:Error: bad request']);
  });

  test('another agent\'s end leaves it waiting', async () => {
    const { turns, emit } = setUp();
    const wait = turns.waitForTurn(60_000);
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
    emit('inference:started');
    emit('inference:completed');
    emit('inference:turn_ended');
    expect(await settled(first)).toBe(true);
    const second = turns.waitForTurn(60_000);
    emit('inference:turn_ended');
    expect(await settled(second)).toBe(false);
    expect(out).toEqual(['out:\n', 'out:\n']);
  });

  test('the cap ends it when nothing settles the turn, and says so', async () => {
    const { out, turns, emit } = setUp();
    const wait = turns.waitForTurn(300);
    emit('inference:started');
    emit('inference:failed', { error: 'held' });
    // Nothing else comes, so only the cap can end it; the test's own
    // timeout catches a wait that never ends. That a failure alone doesn't
    // end it is the test above's, with a cap no loaded run can reach.
    await wait;
    expect(out.at(-1)).toBe('err:(no answer after 0.3 s: going on without it)');
  });

  test('a turn that settles before the cap says nothing of it', async () => {
    const { out, turns, emit } = setUp();
    const wait = turns.waitForTurn(50);
    emit('inference:started');
    emit('inference:completed');
    await wait;
    await Bun.sleep(100);
    expect(out.some((line) => line.includes('no answer after'))).toBe(false);
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
    // `(turn ended: …)` is the primary's line alone: it says this line's own turn ended.
    expect(out).toEqual(['out:\n', 'out:\n', 'out:\n', 'out:\n', 'err:Error: Stream aborted: timeout']);
  });

  test('a turn that ends on stderr closes its prose line on stdout, so what prints next starts a line of its own', () => {
    const { emit, out, turns } = setUp();
    emit('inference:started');
    emit('inference:tokens', { content: 'Partial answer' });
    emit('inference:exhausted', { error: 'Stream aborted: timeout' });
    // A failure whose retries are spent: its exhausted, after failed, prints nothing more.
    emit('inference:started');
    emit('inference:tokens', { content: 'Another' });
    emit('inference:failed', { error: 'bad request' });
    emit('inference:exhausted', { error: 'bad request' });
    // Another agent's failure, too.
    turns.onTrace({ type: 'inference:started', agentName: 'spawn-c' });
    turns.onTrace({ type: 'inference:tokens', agentName: 'spawn-c', content: 'Half' });
    turns.onTrace({ type: 'inference:failed', agentName: 'spawn-c', error: 'overloaded' });
    expect(out).toEqual([
      'out:\n', 'out:Partial answer', 'out:\n', 'err:(turn ended: Stream aborted: timeout)',
      'out:\n', 'out:Another', 'out:\n', 'err:Error: bad request',
      'out:\n', 'out:Half', 'out:\n', 'err:Error: overloaded',
    ]);
  });

  test('a stop that cancels a failed attempt\'s retry prints nothing more', () => {
    // agent-framework sends `failed`, then `aborted` when a stop cancels the
    // retry or a quiesce abandons it (state/turn-trace.ts).
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

  test('how the primary\'s turn ended: a stop on stdout, a turn the framework ended as a failure on stderr', () => {
    // agent-framework's ends from 0.22.3: a stop ends with a lone `aborted`,
    // and a lone `exhausted` comes only from an abort whose reason isn't
    // `user`, which the framework counts as a failure.
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
  /** A framework's trace source: emit reaches its listeners until each unsubscribes. */
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

    // A switch that throws leaves the host on whatever it holds: followed again.
    seen.length = 0;
    await expect(switchFollowing(traces, async () => { throw new Error('no such session'); }, () => current))
      .rejects.toThrow('no such session');
    fresh.emit('after the failed switch');
    expect(seen).toEqual(['after the failed switch']);
  });
});
