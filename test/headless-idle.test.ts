import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connectWhenAccepting } from './ipc-connect.ts';

const FIXTURE = join(import.meta.dir, 'mock-headless-self-restart-child.ts');
const REAL_FRAMEWORK = join(import.meta.dir, 'real-framework-headless-child.ts');
const CONFIRM_MS = 500;

function start(mode: 'quiet-exit' | 'quiet-idle' | 'text-exit', hold: string, env: Record<string, string> = {}, fixture = FIXTURE) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'headless-idle-')));
  const child = spawn(process.execPath, [fixture, mode, hold], {
    cwd: dir, env: { ...process.env, ...env, DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 12_000);
  let output = '';
  child.stdout!.on('data', (c) => { output += c; });
  child.stderr!.on('data', (c) => { output += c; });
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(watchdog);
      resolve({ code, signal });
    });
  });
  return { dir, child, closed, output: () => output };
}

async function processedAt(dir: string): Promise<number> {
  while (!existsSync(join(dir, 'processed-at'))) await Bun.sleep(10);
  return Number(readFileSync(join(dir, 'processed-at'), 'utf8'));
}

function quietFrom(dir: string): number {
  return Number(readFileSync(join(dir, 'quiet-from'), 'utf8'));
}

async function client(dir: string, closed: Promise<unknown>) {
  let exited = false;
  void closed.then(() => { exited = true; });
  const socketPath = join(dir, 'ipc.sock');
  while (!existsSync(socketPath)) {
    if (exited) throw new Error('the fixture ended before it listened');
    await Bun.sleep(10);
  }
  const socket = await connectWhenAccepting(socketPath);
  const lines: Array<Record<string, unknown>> = [];
  const waiting: Array<() => void> = [];
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      lines.push(JSON.parse(buffer.slice(0, at)));
      buffer = buffer.slice(at + 1);
    }
    for (const wake of waiting.splice(0)) wake();
  });
  const nextOf = async (matches: (e: Record<string, unknown>) => boolean, what: string, nth = 1): Promise<Record<string, unknown>> => {
    for (;;) {
      const found = lines.filter(matches)[nth - 1];
      if (found) return found;
      if (exited) throw new Error(`the fixture ended before ${what}`);
      await new Promise<void>((wake) => { waiting.push(wake); setTimeout(wake, 100); });
    }
  };
  const next = (phase: string, nth = 1) =>
    nextOf((e) => e.type === 'lifecycle' && e.phase === phase, `lifecycle ${phase}`, nth);
  return {
    next,
    count: (phase: string) => lines.filter((e) => e.type === 'lifecycle' && e.phase === phase).length,
    starts: (agent: string) => lines.filter((e) => e.type === 'inference:started' && e.agentName === agent).length,
    nextOf: (type: string) => nextOf((e) => e.type === type, type),
    seen: (type: string) => lines.filter((e) => e.type === type).length,
    said: () => lines.filter((e) => e.type === 'inference:speech'),
    arrivedBefore: (first: string, then: string) => {
      const at = (phase: string) => lines.findIndex((e) => e.type === 'lifecycle' && e.phase === phase);
      return at(first) >= 0 && at(first) < at(then);
    },
    send: (...lines: object[]) => socket.write(lines.map((line) => `${JSON.stringify(line)}\n`).join('')),
    close: () => socket.destroy(),
  };
}

async function firstIdle(dir: string, closed: Promise<unknown>): Promise<number> {
  const watching = await client(dir, closed);
  await watching.next('ready');
  writeFileSync(join(dir, 'go'), '');
  const idle = await watching.next('idle');
  watching.close();
  return Number(idle.ts);
}

async function idleAfterQuiet(hold: string): Promise<void> {
  const { dir, child, closed } = start('quiet-idle', hold);
  try {
    const idleAt = await firstIdle(dir, closed);
    expect(idleAt - quietFrom(dir)).toBeGreaterThanOrEqual(CONFIRM_MS);
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}

async function exitAfterQuiet(hold: string): Promise<void> {
  const { dir, closed, output } = start('quiet-exit', hold);
  const result = await closed;
  expect({ code: result.code, signal: result.signal, output: result.code === 0 ? '' : output() })
    .toEqual({ code: 0, signal: null, output: '' });
  expect(readFileSync(join(dir, 'stopped'), 'utf8')).toBe('idle');
  expect(readFileSync(join(dir, 'headless.log'), 'utf8')).toContain('shutdown: exit-when-idle');
}

const HOLDS = [
  ['turn', 'a turn the framework still counts alive, as one waiting to retry'],
  ['gated', 'a gated wake'],
  ['script', 'a running background script'],
  ['queue', 'an event not yet taken off the queue'],
  ['subagent-active', 'a subagent run holding a slot'],
  ['subagent-queued', 'a queued subagent run'],
  ['wake-gap', "a subagent's end, with its wake a loop pass behind,"],
] as const;

for (const [hold, what] of HOLDS) {
  if (hold !== 'script') {
    test.concurrent(`${what} holds lifecycle idle back until it has been over for the quiet's 500 ms, though every agent reads idle`,
      () => idleAfterQuiet(hold), 15_000);
  }

  test.concurrent(`under --exit-when-idle, ${what} holds the exit back until it has been over for 500 ms`,
    () => exitAfterQuiet(hold), 15_000);
}

test.concurrent('a background script left running doesn\'t hold lifecycle idle: it comes 500 ms after the turn, while the script runs', async () => {
  const { dir, child, closed } = start('quiet-idle', 'script-until-released');
  try {
    const idleAt = await firstIdle(dir, closed);
    expect(idleAt - Number(readFileSync(join(dir, 'turn-ended'), 'utf8'))).toBeGreaterThanOrEqual(CONFIRM_MS);
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}, 15_000);

test.concurrent('with nothing in flight, lifecycle idle comes, no sooner than 500 ms after the turn has ended, and --exit-when-idle exits 0 then',
  async () => {
    await idleAfterQuiet('none');
    await exitAfterQuiet('none');
  }, 15_000);

test.concurrent('a turn that starts and ends between two of the host\'s polls starts the quiet\'s 500 ms again', async () => {
  await idleAfterQuiet('blip');
  await exitAfterQuiet('blip');
}, 15_000);

test.concurrent('ready tells a client connecting whether the host has said idle since its last inference started', async () => {
  const { dir, child, closed } = start('quiet-idle', 'none');
  try {
    const before = await client(dir, closed);
    expect(await before.next('ready')).toMatchObject({ idle: false });
    writeFileSync(join(dir, 'go'), '');
    await before.next('idle');
    before.close();
    const after = await client(dir, closed);
    expect(await after.next('ready')).toMatchObject({ idle: true });
    after.close();
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}, 15_000);

test.concurrent('ready says idle only while the host is still quiet: an event queued after the idle makes it say not idle, and a new idle follows', async () => {
  const { dir, child, closed } = start('quiet-idle', 'late-queue');
  try {
    const first = await client(dir, closed);
    await first.next('ready');
    writeFileSync(join(dir, 'go'), '');
    await first.next('idle');
    first.close();
    writeFileSync(join(dir, 'queue-go'), '');
    const during = await client(dir, closed);
    expect(await during.next('ready')).toMatchObject({ idle: false });
    writeFileSync(join(dir, 'release-queue'), '');
    expect(await during.next('idle')).toMatchObject({ texts: 0 });
    during.close();
    const after = await client(dir, closed);
    expect(await after.next('ready')).toMatchObject({ idle: true });
    after.close();
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}, 15_000);

test.concurrent('a session switch under way holds the host from quiet: ready says not idle during it, and a new idle follows it', async () => {
  const { dir, child, closed } = start('quiet-idle', 'none');
  try {
    const first = await client(dir, closed);
    await first.next('ready');
    writeFileSync(join(dir, 'go'), '');
    await first.next('idle');
    first.close();
    writeFileSync(join(dir, 'switch-begun'), '');
    while (!existsSync(join(dir, 'switching'))) await Bun.sleep(10);
    const during = await client(dir, closed);
    expect(await during.next('ready')).toMatchObject({ idle: false });
    writeFileSync(join(dir, 'switch-ended'), '');
    expect(await during.next('idle')).toMatchObject({ texts: 0 });
    during.close();
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}, 15_000);

test.concurrent('ready says idle while only a background script left running goes on after the idle', async () => {
  const { dir, child, closed } = start('quiet-idle', 'script-until-released');
  try {
    const first = await client(dir, closed);
    await first.next('ready');
    writeFileSync(join(dir, 'go'), '');
    await first.next('idle');
    first.close();
    const during = await client(dir, closed);
    expect(await during.next('ready')).toMatchObject({ idle: true });
    during.close();
    writeFileSync(join(dir, 'release-script'), '');
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}, 15_000);

test.concurrent('a text the agent is given no turn for counts as activity: an idle that covers it comes 500 ms after it', async () => {
  const { dir, child, closed } = start('quiet-idle', 'none');
  try {
    const watching = await client(dir, closed);
    await watching.next('ready');
    writeFileSync(join(dir, 'go'), '');
    expect(await watching.next('idle')).toMatchObject({ texts: 0 });
    watching.send({ type: 'text', content: 'declined' });
    const second = await watching.next('idle', 2);
    expect(second).toMatchObject({ texts: 1 });
    expect(Number(second.ts) - quietFrom(dir)).toBeGreaterThanOrEqual(CONFIRM_MS);
    watching.close();
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}, 15_000);

test.concurrent('under --exit-when-idle, a host whose only text is given no turn exits 500 ms after it', async () => {
  const { dir, closed, output } = start('text-exit', 'none');
  const watching = await client(dir, closed);
  await watching.next('ready');
  watching.send({ type: 'text', content: 'declined' });
  const result = await closed;
  expect({ code: result.code, output: result.code === 0 ? '' : output() }).toEqual({ code: 0, output: '' });
  expect(readFileSync(join(dir, 'stopped'), 'utf8')).toBe('idle');
}, 15_000);

test.concurrent('after a session switch whose new framework starts a turn at once, the socket hears its start and idle comes again after it', async () => {
  const { dir, child, closed } = start('quiet-idle', 'none');
  try {
    const watching = await client(dir, closed);
    await watching.next('ready');
    writeFileSync(join(dir, 'go'), '');
    await watching.next('idle');
    expect(watching.seen('inference:started')).toBe(1);
    writeFileSync(join(dir, 'switch-busy'), '');
    await watching.next('idle', 2);
    expect(watching.seen('inference:started')).toBe(2);
    watching.close();
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}, 15_000);

test.concurrent('a text received on an old connection whose turn hasn\'t started yet keeps ready.idle false on the next', async () => {
  const { dir, child, closed } = start('quiet-idle', 'text-queued');
  try {
    const first = await client(dir, closed);
    await first.next('ready');
    writeFileSync(join(dir, 'go'), '');
    await first.next('idle');
    first.send({ type: 'text', content: 'queued' });
    while (!existsSync(join(dir, 'texts-taken'))) await Bun.sleep(10);
    first.close();
    const second = await client(dir, closed);
    expect(await second.next('ready')).toMatchObject({ idle: false });
    writeFileSync(join(dir, 'release-queue'), '');
    expect(await second.next('idle')).toMatchObject({ texts: 0 });
    second.close();
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}, 15_000);

test.concurrent('a text whose processing outlasts the quiet\'s 500 ms is covered only by an idle 500 ms after its processing ends', async () => {
  const { dir, child, closed } = start('quiet-idle', 'text-slow');
  try {
    const watching = await client(dir, closed);
    await watching.next('ready');
    writeFileSync(join(dir, 'go'), '');
    await watching.next('idle');
    watching.send({ type: 'text', content: 'slow to process' });
    const second = await watching.next('idle', 2);
    expect(second).toMatchObject({ texts: 1 });
    expect(Number(second.ts) - await processedAt(dir)).toBeGreaterThanOrEqual(CONFIRM_MS);
    watching.close();
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}, 15_000);

test.concurrent('a text the framework refuses goes to the next framework a switch installs, and the idle covers it once that has processed it', async () => {
  const { dir, child, closed } = start('quiet-idle', 'none');
  try {
    const watching = await client(dir, closed);
    await watching.next('ready');
    writeFileSync(join(dir, 'go'), '');
    await watching.next('idle');
    watching.send({ type: 'text', content: 'throws' });
    while (!existsSync(join(dir, 'texts-taken'))) await Bun.sleep(10);
    watching.send({ type: 'text', content: 'switch' });
    const second = await watching.next('idle', 2);
    expect(second).toMatchObject({ texts: 2 });
    expect(Number(second.ts) - await processedAt(dir)).toBeGreaterThanOrEqual(CONFIRM_MS);
    watching.close();
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}, 15_000);

test.concurrent('after the host\'s framework is replaced, as a session switch does, its texts still end in an idle', async () => {
  const { dir, child, closed } = start('quiet-idle', 'none');
  try {
    const watching = await client(dir, closed);
    await watching.next('ready');
    writeFileSync(join(dir, 'go'), '');
    await watching.next('idle');
    watching.send({ type: 'text', content: 'switch' });
    expect(await watching.next('idle', 2)).toMatchObject({ texts: 1 });
    watching.send({ type: 'text', content: 'after the switch' });
    const third = await watching.next('idle', 3);
    expect(third).toMatchObject({ texts: 2 });
    expect(Number(third.ts) - quietFrom(dir)).toBeGreaterThanOrEqual(CONFIRM_MS);
    watching.close();
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}, 15_000);

test.concurrent('after a session switch, describe gives the new session\'s agents, not the replaced one\'s', async () => {
  const { dir, child, closed } = start('quiet-idle', 'none');
  try {
    const watching = await client(dir, closed);
    await watching.next('ready');
    writeFileSync(join(dir, 'go'), '');
    await watching.next('idle');
    watching.send({ type: 'text', content: 'switch to a successor' });
    await watching.next('idle', 2);
    watching.send({ type: 'describe', corrId: 'after-switch' });
    const snapshot = await watching.nextOf('snapshot') as { tree: { nodes: Array<{ name: string }>; callIdIndex: object } };
    expect(snapshot.tree.nodes.map((node) => node.name)).toEqual(['successor']);
    expect(snapshot.tree.callIdIndex).toEqual({});
    watching.close();
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}, 15_000);

test.concurrent('after a session switch, the replaced framework\'s traces don\'t reach the socket, and the new one\'s do', async () => {
  const { dir, child, closed } = start('quiet-idle', 'none');
  try {
    const watching = await client(dir, closed);
    await watching.next('ready');
    writeFileSync(join(dir, 'go'), '');
    await watching.next('idle');
    watching.send({ type: 'text', content: 'switch, then the old framework traces' });
    await watching.nextOf('new-framework-trace');
    expect(watching.seen('replaced-framework-trace')).toBe(0);
    watching.close();
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}, 15_000);

test.concurrent('on the installed agent-framework, a text ends in an idle that covers it, once its modules have processed it', async () => {
  const { dir, child, closed } = start('quiet-idle', 'none', {}, REAL_FRAMEWORK);
  try {
    const watching = await client(dir, closed);
    await watching.next('ready');
    watching.send({ type: 'text', content: 'hello' });
    const idle = await watching.next('idle');
    expect(idle).toMatchObject({ texts: 1 });
    expect(Number(idle.ts) - await processedAt(dir)).toBeGreaterThanOrEqual(CONFIRM_MS);
    watching.close();
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}, 15_000);

test.concurrent('a text that comes right behind a framework\'s replacement, still processing, isn\'t dropped from flight', async () => {
  const { dir, child, closed } = start('quiet-idle', 'none');
  try {
    const watching = await client(dir, closed);
    await watching.next('ready');
    writeFileSync(join(dir, 'go'), '');
    await watching.next('idle');
    watching.send({ type: 'text', content: 'switch' }, { type: 'text', content: 'slow' });
    const idle = await watching.next('idle', 2);
    expect(idle).toMatchObject({ texts: 2 });
    expect(Number(idle.ts) - await processedAt(dir)).toBeGreaterThanOrEqual(CONFIRM_MS);
    watching.close();
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}, 15_000);

test.concurrent('texts the replaced framework hadn\'t finished go to the new framework, each once and in order, and the idle covers them once that has processed them', async () => {
  const { dir, child, closed } = start('quiet-idle', 'none');
  try {
    const watching = await client(dir, closed);
    await watching.next('ready');
    writeFileSync(join(dir, 'go'), '');
    await watching.next('idle');
    watching.send({ type: 'text', content: 'stuck first' }, { type: 'text', content: 'stuck second' });
    const pushes = join(dir, 'pushes');
    while (!existsSync(pushes) || readFileSync(pushes, 'utf8').split('\n').length < 3) await Bun.sleep(10);
    watching.send({ type: 'text', content: 'switch' });
    const second = await watching.next('idle', 2);
    expect(second).toMatchObject({ texts: 3 });
    expect(Number(second.ts) - await processedAt(dir)).toBeGreaterThanOrEqual(CONFIRM_MS);
    expect(readFileSync(pushes, 'utf8').split('\n').filter((line) => line.startsWith('1 '))).toEqual(['1 stuck first', '1 stuck second']);
    watching.close();
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}, 15_000);

async function turnWorkAndIdle(hold: string): Promise<{ done: number; idle: number; dones: number; doneFirst: boolean; scoutStarts: number; turnWorkFrom: number; quietFrom: number }> {
  const subagent = hold.startsWith('subagent');
  const { dir, child, closed } = start('quiet-idle', hold, subagent ? { FIXTURE_HOLD_UNTIL_RELEASED: '1' } : {});
  try {
    const watching = await client(dir, closed);
    await watching.next('ready');
    writeFileSync(join(dir, 'go'), '');
    const done = Number((await watching.next('turn-work-done')).ts);
    if (hold === 'subagent-streaming') {
      writeFileSync(join(dir, 'scout-go'), '');
      while (!existsSync(join(dir, 'scout-polled'))) await Bun.sleep(10);
    }
    if (subagent) writeFileSync(join(dir, 'release-hold'), '');
    const idle = Number((await watching.next('idle')).ts);
    const dones = watching.count('turn-work-done');
    const scoutStarts = watching.starts('spawn-scout');
    watching.close();
    const doneFirst = watching.arrivedBefore('turn-work-done', 'idle');
    return { done, idle, dones, doneFirst, scoutStarts, turnWorkFrom: Number(readFileSync(join(dir, 'turn-work-from'), 'utf8')), quietFrom: quietFrom(dir) };
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}

for (const [hold, what] of [
  ['subagent-active', 'a subagent run holding a slot'],
  ['subagent-streaming', 'a subagent run whose own agent streams'],
] as const) {
  test.concurrent(`${what} holds lifecycle idle but not turn-work-done, which comes 500 ms after the turn`, async () => {
    const seen = await turnWorkAndIdle(hold);
    expect(seen.done - seen.turnWorkFrom).toBeGreaterThanOrEqual(CONFIRM_MS);
    expect(seen.idle - seen.quietFrom).toBeGreaterThanOrEqual(CONFIRM_MS);
    expect(seen.dones).toBe(1);
    if (hold === 'subagent-streaming') expect(seen.scoutStarts).toBe(1);
  }, 15_000);
}

for (const [hold, what] of [
  ['turn', 'a turn the framework still counts alive'],
  ['gated', 'a gated wake'],
  ['parked', 'a wake parked on provider admission'],
  ['queue', 'an event not yet taken off the queue'],
] as const) {
  test.concurrent(`${what} holds turn-work-done back until it has been over for 500 ms`, async () => {
    const seen = await turnWorkAndIdle(hold);
    expect(seen.done - seen.turnWorkFrom).toBeGreaterThanOrEqual(CONFIRM_MS);
    expect(seen.doneFirst).toBe(true);
    expect(seen.dones).toBe(1);
  }, 15_000);
}

test.concurrent('a background script left running holds neither turn-work-done nor idle, and turn-work-done comes first', async () => {
  const { dir, child, closed } = start('quiet-idle', 'script-until-released');
  try {
    const watching = await client(dir, closed);
    await watching.next('ready');
    writeFileSync(join(dir, 'go'), '');
    const done = Number((await watching.next('turn-work-done')).ts);
    const idle = Number((await watching.next('idle')).ts);
    expect(done - Number(readFileSync(join(dir, 'turn-ended'), 'utf8'))).toBeGreaterThanOrEqual(CONFIRM_MS);
    expect(idle).toBeGreaterThanOrEqual(done);
    expect(watching.arrivedBefore('turn-work-done', 'idle')).toBe(true);
    watching.close();
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}, 15_000);

test.concurrent('ready tells a client connecting whether turn work is in flight: during a turn yes, while only a script runs no', async () => {
  for (const [hold, turnWork] of [['turn', true], ['script', false]] as const) {
    const { dir, child, closed } = start('quiet-idle', hold, { FIXTURE_HOLD_UNTIL_RELEASED: '1' });
    try {
      const first = await client(dir, closed);
      await first.next('ready');
      writeFileSync(join(dir, 'go'), '');
      while (!existsSync(join(dir, 'turn-ended'))) await Bun.sleep(10);
      first.close();
      const during = await client(dir, closed);
      expect(await during.next('ready'), hold).toMatchObject({ turnWork });
      during.close();
      writeFileSync(join(dir, 'release-hold'), '');
    } finally {
      child.kill('SIGTERM');
      await closed;
    }
  }
}, 20_000);

test.concurrent('a text the agent is given no turn for ends turn work too: a turn-work-done covering it comes 500 ms after it', async () => {
  const { dir, child, closed } = start('quiet-idle', 'none');
  try {
    const watching = await client(dir, closed);
    await watching.next('ready');
    writeFileSync(join(dir, 'go'), '');
    expect(await watching.next('turn-work-done')).toMatchObject({ texts: 0 });
    await watching.next('idle');
    watching.send({ type: 'text', content: 'declined' });
    const second = await watching.next('turn-work-done', 2);
    expect(second).toMatchObject({ texts: 1 });
    expect(Number(second.ts) - quietFrom(dir)).toBeGreaterThanOrEqual(CONFIRM_MS);
    watching.close();
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}, 15_000);

test.concurrent('turn work the host sees with no start or text of its own, such as a queued event, ends in a turn-work-done too', async () => {
  const { dir, child, closed } = start('quiet-idle', 'late-queue');
  try {
    const watching = await client(dir, closed);
    await watching.next('ready');
    writeFileSync(join(dir, 'go'), '');
    await watching.next('idle');
    writeFileSync(join(dir, 'queue-go'), '');
    while (!existsSync(join(dir, 'queue-seen'))) await Bun.sleep(10);
    writeFileSync(join(dir, 'release-queue'), '');
    const second = await watching.next('turn-work-done', 2);
    expect(Number(second.ts) - Number(readFileSync(join(dir, 'queue-released'), 'utf8'))).toBeGreaterThanOrEqual(CONFIRM_MS);
    watching.close();
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}, 15_000);

test.concurrent('ready names the agent as the framework runs it, the recipe\'s or, with none named, the one the host resolved, and the socket carries that agent\'s speech', async () => {
  for (const [env, agent] of [[{}, 'fixture'], [{ FIXTURE_UNNAMED_AGENT: '1' }, 'imported-name']] as const) {
    const { dir, child, closed } = start('quiet-idle', 'none', env);
    try {
      const watching = await client(dir, closed);
      expect(await watching.next('ready')).toMatchObject({ agent });
      writeFileSync(join(dir, 'speak'), '');
      await watching.next('idle');
      expect(watching.said()).toMatchObject([{ agentName: agent, content: 'Spoken.' }]);
      watching.close();
    } finally {
      child.kill('SIGTERM');
      await closed;
    }
  }
}, 20_000);

test.concurrent('a turn that starts and ends between two polls starts turn-work-done\'s 500 ms again too', async () => {
  const { dir, child, closed } = start('quiet-idle', 'blip');
  try {
    const watching = await client(dir, closed);
    await watching.next('ready');
    writeFileSync(join(dir, 'go'), '');
    const done = await watching.next('turn-work-done');
    expect(Number(done.ts) - Number(readFileSync(join(dir, 'turn-work-from'), 'utf8'))).toBeGreaterThanOrEqual(CONFIRM_MS);
    watching.close();
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}, 15_000);

test.concurrent('a text whose processing outlasts the quiet\'s 500 ms holds turn-work-done too, until 500 ms after its processing ends', async () => {
  const { dir, child, closed } = start('quiet-idle', 'none');
  try {
    const watching = await client(dir, closed);
    await watching.next('ready');
    writeFileSync(join(dir, 'go'), '');
    await watching.next('idle');
    watching.send({ type: 'text', content: 'slow' });
    const second = await watching.next('turn-work-done', 2);
    expect(second).toMatchObject({ texts: 1 });
    expect(Number(second.ts) - await processedAt(dir)).toBeGreaterThanOrEqual(CONFIRM_MS);
    watching.close();
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}, 15_000);
