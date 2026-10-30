import { afterEach, expect, spyOn, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetModule, type FleetModuleConfig } from '../src/modules/fleet-module.js';
import { FleetTreeAggregator } from '../src/state/fleet-tree-aggregator.js';
import { connectWhenAccepting } from './ipc-connect.js';

type Result = { success: boolean; error?: string; data?: unknown };
type Event = { type?: string; phase?: string; content?: string };
type Child = Record<string, unknown> & {
  socket: Socket | null; lastCompletedSpeech: string; events: Event[]; reopening?: Promise<void>;
};
type Fleet = {
  children: Map<string, Child>;
  connectChildSocket(child: object): Promise<void>;
  sendToChild(child: object, cmd: object): void;
  requestPanel(name: string, op: string): Promise<{ ok: boolean; error?: string; status?: number }>;
  requestSwitch(name: string, request: object, timeoutMs: number): Promise<{ ok: boolean; data?: unknown; error?: string }>;
  handleToolCall(call: { id: string; name: string; input: unknown }): Promise<Result>;
  getChildren(): Map<string, Child>;
  onChildEvent(name: string, callback: (name: string, event: Event) => void): () => void;
  setDetachMode(on: boolean): void;
  stop(): Promise<void>;
  reopenWindowMs: number;
  connectAnswerMs: number;
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until(check: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(10);
  }
}

function setup(config: FleetModuleConfig = {}) {
  const fleet = new FleetModule(config) as unknown as Fleet;
  const logged: string[] = [];
  const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  cleanups.push(() => spy.mockRestore());
  let calls = 0;
  const call = (name: string, input: unknown) => fleet.handleToolCall({ id: `call-${++calls}`, name, input });
  const failed = (name: string) => logged.filter((line) => line.includes(`connecting to child "${name}" again failed`)).length;
  const reconnected = (name: string) => logged.filter((line) => line.includes(
    `child "${name}" closed this host's connection while it ran, and this host connected to it again`)).length;

  const launch = async (name: string, { recordedPid, adoptedAlive, blockMs = 4_000, subscription = ['*'] }:
    { recordedPid?: number; adoptedAlive?: boolean; blockMs?: number; subscription?: string[] } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-reattach-'));
    const proc = spawn(process.execPath, [join(import.meta.dir, 'mock-fleet-reattach-child.ts')], {
      env: { ...process.env, DATA_DIR: dir, BLOCK_MS: String(blockMs) }, stdio: 'ignore',
    });
    const alive = () => proc.exitCode === null && proc.signalCode === null;
    cleanups.push(async () => {
      if (alive()) proc.kill('SIGKILL');
      await until(() => !alive(), 'the child ending');
      rmSync(dir, { recursive: true, force: true });
    });
    await until(() => existsSync(join(dir, 'ipc.sock')), 'the child listening');
    const adopted = recordedPid !== undefined || adoptedAlive === true;
    const child = {
      name, recipePath: join(dir, 'recipe.json'), dataDir: dir, socketPath: join(dir, 'ipc.sock'),
      pid: recordedPid ?? proc.pid, process: adopted ? null : proc, ...(adopted ? { adopted: true } : {}),
      socket: null, status: 'ready', startedAt: Date.now(), exitedAt: null, lastEventAt: null, exitCode: null,
      exitReason: null, events: [], buffer: '', subscription, idleSinceWork: false, textsSent: 0,
      autoRestart: false, killRequested: false, restartAttempts: [], lastCompletedSpeech: '',
    } as unknown as Child;
    fleet.children.set(name, child);
    const seen = { ready: 0, idle: 0, marker: 0, snapshot: 0 };
    cleanups.push(fleet.onChildEvent(name, (_, event) => {
      if (event.type === 'lifecycle' && event.phase === 'ready') seen.ready += 1;
      if (event.type === 'lifecycle' && event.phase === 'idle') seen.idle += 1;
      if (event.type === 'probe:marker') seen.marker += 1;
      if (event.type === 'snapshot') seen.snapshot += 1;
    }));
    const readies = () => seen.ready;
    await fleet.connectChildSocket(child);
    fleet.sendToChild(child, { type: 'subscribe', events: subscription });
    const log = () => existsSync(join(dir, 'headless.log')) ? readFileSync(join(dir, 'headless.log'), 'utf8') : '';
    const lines = (end: string) => log().split('\n').filter((line) => line.endsWith(end)).length;
    const connections = () => lines('client connected');
    const disconnections = () => lines('client disconnected; child stays up');
    const texts = () => existsSync(join(dir, 'texts')) ? readFileSync(join(dir, 'texts'), 'utf8') : '';
    const signal = async (file: string, answer: string, content = '') => {
      writeFileSync(join(dir, file), content);
      await until(() => existsSync(join(dir, answer)), answer);
    };
    let bursts = 0;
    let replies = 0;
    let markers = 0;
    const cuts = () => log().match(/hadn't taken what was queued for it within 0\.5 s; closed with [1-9]\d* bytes unsent/g)?.length ?? 0;
    const cut = async ({ thenBlock = false } = {}) => {
      const socket = child.socket!;
      const before = cuts();
      socket.pause();
      bursts += 1;
      await signal(`burst-${bursts}`, `burst-${bursts}-sent`);
      await until(() => cuts() === before + 1, 'the cut');
      if (thenBlock) await signal('block', 'blocking');
      socket.resume();
      await until(() => child.socket !== socket, 'the parent seeing the close');
    };
    const reply = async (content: string) => {
      replies += 1;
      writeFileSync(join(dir, `reply-${replies}`), content);
      await until(() => child.events.some((e) => e.type === 'inference:speech' && e.content === content), 'the reply');
    };
    const marker = async () => {
      markers += 1;
      writeFileSync(join(dir, `marker-${markers}`), '');
      await until(() => child.events.some((e) => e.content === `after marker ${markers}`), 'the token after the marker');
    };
    const takeover = async () => {
      const other = await connectWhenAccepting(join(dir, 'ipc.sock'));
      let closed = false;
      other.on('data', () => {});
      other.on('close', () => { closed = true; });
      cleanups.push(() => { other.destroy(); });
      return { closed: () => closed };
    };
    const unblocked = () => existsSync(join(dir, 'unblocked'));
    const release = () => writeFileSync(join(dir, 'release'), '');
    await until(() => connections() === 1, 'the first connection');
    return {
      child, proc, dir, alive, log, connections, disconnections, readies, seen, texts, signal, cut, reply, marker, takeover,
      unblocked, release,
    };
  };
  return { fleet, logged, failed, reconnected, call, launch };
}

test("a child that closes this host's connection for not reading is connected to again, and takes the next send", async () => {
  const { call, launch } = setup();
  const leaf = await launch('leaf');
  await leaf.cut();
  await until(() => leaf.connections() === 2 && leaf.child.socket !== null, 'the parent connecting again');
  expect(leaf.alive()).toBe(true);
  expect(await call('send', { name: 'leaf', content: 'after the cut' })).toMatchObject({ success: true });
  await until(() => leaf.texts().includes('after the cut'), 'the child taking the text');
}, 30_000);

test("a child whose connection another client takes is connected to again, which closes the other client's connection", async () => {
  const { call, launch } = setup();
  const leaf = await launch('leaf');
  const other = await leaf.takeover();
  await until(() => leaf.connections() === 3 && leaf.child.socket !== null, 'the parent connecting again');
  await until(other.closed, "the other client's connection closing");
  expect(await call('send', { name: 'leaf', content: 'after the takeover' })).toMatchObject({ success: true });
  await until(() => leaf.texts().includes('after the takeover'), 'the child taking the text');
}, 30_000);

test('a connection opened again carries the subscription the child was launched with', async () => {
  const { call, launch } = setup();
  const leaf = await launch('leaf', { subscription: ['lifecycle'] });
  expect(await call('send', { name: 'leaf', content: 'after the first subscribe' })).toMatchObject({ success: true });
  await until(() => leaf.texts().includes('after the first subscribe'), 'the child reading past the first subscribe');
  await leaf.marker();
  expect(leaf.child.events.some((e) => e.type === 'probe:marker')).toBe(false);
  await leaf.cut();
  await until(() => leaf.connections() === 2 && leaf.child.socket !== null, 'the parent connecting again');
  expect(await call('send', { name: 'leaf', content: 'after the subscribe' })).toMatchObject({ success: true });
  await until(() => leaf.texts().includes('after the subscribe'), 'the child reading past the subscribe');
  await leaf.marker();
  expect(leaf.child.events.some((e) => e.type === 'probe:marker')).toBe(false);
  const idles = leaf.seen.idle;
  writeFileSync(join(leaf.dir, 'reply-1'), 'a reply whose idle the subscription asks for');
  await until(() => leaf.seen.idle > idles, 'the idle after the reply');
}, 30_000);

test('a connection that closes again within 30 s of being opened again stays closed, and calls say until when', async () => {
  const { call, launch, logged, failed, reconnected } = setup();
  const leaf = await launch('leaf');
  await launch('leaf-2');
  await leaf.takeover();
  await until(() => leaf.connections() === 3 && leaf.child.socket !== null, 'the parent connecting again');
  const second = await leaf.takeover();
  await until(() => logged.some((line) => line.includes('"leaf"') && line.includes('another client may hold')), 'the bound');
  for (const [name, input] of [
    ['send', { name: 'leaf', content: 'held' }],
    ['command', { name: 'leaf', command: '/status' }],
    ['relay', { from: 'leaf', to: 'leaf-2' }],
    ['await', { names: ['leaf'], timeoutMs: 20_000 }],
  ] as const) {
    const result = await call(name, input);
    expect(result.success).toBe(false);
    expect(result.error).toContain('another client may hold');
    expect(result.error).toMatch(/at the first fleet--send, fleet--command, fleet--relay or fleet--await for it after \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
  }
  expect(reconnected('leaf')).toBe(1);
  expect(failed('leaf')).toBe(0);
  expect(second.closed()).toBe(false);
}, 30_000);

test("the release switch's requests try even within the bound", async () => {
  const { fleet, launch, logged, reconnected } = setup();
  const leaf = await launch('leaf');
  await leaf.takeover();
  await until(() => leaf.connections() === 3 && leaf.child.socket !== null, 'the parent connecting again');
  const second = await leaf.takeover();
  await until(() => logged.some((line) => line.includes('another client may hold')), 'the bound');
  expect(await fleet.requestSwitch('leaf', { op: 'resume' }, 5_000)).toMatchObject({ ok: true, data: { resumed: false } });
  expect(reconnected('leaf')).toBe(2);
  await until(second.closed, "the other client's connection closing");
}, 30_000);

test('a call within the bound waits for a connect the release switch has under way, and goes through on it', async () => {
  const { fleet, call, launch, logged } = setup();
  fleet.connectAnswerMs = 20_000;
  const leaf = await launch('leaf', { blockMs: 25_000 });
  await leaf.takeover();
  await until(() => leaf.connections() === 3 && leaf.child.socket !== null, 'the parent connecting again');
  await leaf.takeover();
  await until(() => logged.some((line) => line.includes('another client may hold')), 'the bound');
  await leaf.signal('block', 'blocking');
  const switching = fleet.requestSwitch('leaf', { op: 'resume' }, 10_000);
  await until(() => leaf.child.reopening !== undefined, "the switch's connect under way");
  const sending = call('send', { name: 'leaf', content: "on the switch's connect" });
  leaf.release();
  expect(await sending).toMatchObject({ success: true });
  expect(await switching).toMatchObject({ ok: true });
  await until(() => leaf.texts().includes("on the switch's connect"), 'the child taking the text');
}, 30_000);

test('the bound holds only within its window: a later close connects again, and after it a call tries once', async () => {
  const { fleet, call, launch, logged } = setup();
  const bounds = () => logged.filter((line) => line.includes('another client may hold')).length;
  const leaf = await launch('leaf');
  fleet.reopenWindowMs = 0;
  await leaf.takeover();
  await until(() => leaf.connections() === 3 && leaf.child.socket !== null, 'the parent connecting again');
  await leaf.takeover();
  await until(() => leaf.connections() === 5 && leaf.child.socket !== null, 'a close after the window connecting again');
  expect(bounds()).toBe(0);
  fleet.reopenWindowMs = 60_000;
  await Bun.sleep(50);
  const closing = Date.now();
  const holder = await leaf.takeover();
  await until(() => bounds() === 1, 'the bound');
  const bound = leaf.child.closingAgainUntil as number;
  expect(bound).toBeGreaterThanOrEqual(closing + 60_000);
  expect(bound).toBeLessThanOrEqual(Date.now() + 60_000);
  leaf.child.closingAgainUntil = Date.now();
  expect(await call('send', { name: 'leaf', content: 'after the window' })).toMatchObject({ success: true });
  await until(() => leaf.connections() === 7, "the call's connect");
  await leaf.takeover();
  await until(() => bounds() === 2, "the bound again, within the window of the call's connect");
  await until(holder.closed, "the holder's connection closing at the call's connect");
  await until(() => leaf.texts().includes('after the window'), 'the child taking the text');
}, 30_000);

test('a child that says it is exiting is not connected to again, and this host logs no attempt', async () => {
  const { fleet, call, launch, logged } = setup();
  const leaf = await launch('leaf');
  fleet.sendToChild(leaf.child, { type: 'shutdown' });
  await until(() => !leaf.alive() && leaf.child.socket === null, 'the child exiting');
  const sent = await call('send', { name: 'leaf', content: 'after the exit' });
  expect(sent.error).toContain("child 'leaf' said it was exiting before its connection to this host closed");
  expect(leaf.connections()).toBe(1);
  expect(logged.filter((line) => line.includes('"leaf"'))).toEqual([]);
}, 30_000);

test('a child too busy to answer the connect at the close is tried again by the next send, which goes through', async () => {
  const { call, launch, failed } = setup();
  const leaf = await launch('leaf');
  await leaf.cut({ thenBlock: true });
  await until(() => failed('leaf') === 1, 'the failed attempt');
  expect(leaf.child.socket).toBeNull();
  await until(leaf.unblocked, 'the child answering again');
  expect(await call('send', { name: 'leaf', content: 'after the block' })).toMatchObject({ success: true });
  await until(() => leaf.texts().includes('after the block'), 'the child taking the text');
}, 30_000);

test("after a failed connect, a Web UI panel's request and a relay to an unknown child don't connect, and the update switch's request does, once", async () => {
  const { fleet, launch, failed, reconnected } = setup();
  const leaf = await launch('leaf');
  await leaf.cut({ thenBlock: true });
  await until(() => failed('leaf') === 1, 'the failed attempt');
  await until(() => leaf.unblocked() && leaf.disconnections() === 2, "the child closing the failed attempt's connection");
  const panel = await fleet.requestPanel('leaf', 'coverage');
  expect(panel).toMatchObject({ ok: false, status: 502 });
  expect(panel.error).toContain('connecting to it again failed');
  expect(leaf.child.socket).toBeNull();
  expect(leaf.child.reopening).toBeUndefined();
  const relayed = await fleet.handleToolCall({ id: 'relay', name: 'relay', input: { from: 'leaf', to: 'nobody' } });
  expect(relayed.error).toStartWith("There's no child named 'nobody', so nothing was relayed.");
  expect(leaf.child.socket).toBeNull();
  expect(leaf.child.reopening).toBeUndefined();
  const resumed = await fleet.requestSwitch('leaf', { op: 'resume' }, 5_000);
  expect(resumed).toMatchObject({ ok: true, data: { resumed: false } });
  expect(reconnected('leaf')).toBe(1);
  expect(failed('leaf')).toBe(1);
}, 30_000);

test('a call made while a connect is under way waits for its outcome, and makes no connect of its own', async () => {
  const { call, launch, failed } = setup();
  const leaf = await launch('leaf');
  await leaf.cut({ thenBlock: true });
  await until(() => leaf.child.reopening !== undefined, 'the connect under way');
  expect(leaf.child.socket).toBeNull();
  const sent = await call('send', { name: 'leaf', content: 'during the connect' });
  expect(sent.success).toBe(false);
  expect(sent.error).toContain('connecting to it again failed');
  expect(failed('leaf')).toBe(1);
  await until(() => leaf.unblocked() && leaf.disconnections() === 2, "the child closing the failed attempt's connection");
  expect(leaf.connections()).toBe(2);
  expect(leaf.texts()).toBe('');
}, 30_000);

test('a connect that completes after this host began stopping is not taken', async () => {
  const { fleet, launch, logged } = setup();
  const leaf = await launch('leaf', { blockMs: 1_500 });
  await leaf.cut({ thenBlock: true });
  await until(() => leaf.child.reopening !== undefined, 'the connect under way');
  fleet.setDetachMode(true);
  await fleet.stop();
  await until(() => leaf.child.reopening === undefined, 'the connect ending');
  await until(() => leaf.disconnections() === 2, "the child closing the connect's connection");
  expect(leaf.child.socket).toBeNull();
  expect(leaf.connections()).toBe(2);
  expect(logged.filter((line) => line.includes('"leaf"'))).toEqual([]);
}, 30_000);

test('a socket that takes each connect and closes it before any ready gets one connect after the close, not a loop', async () => {
  const { fleet, logged } = setup();
  const dir = mkdtempSync(join(tmpdir(), 'fleet-reattach-'));
  let accepted = 0;
  const server = createServer((socket) => { accepted += 1; socket.destroy(); });
  await new Promise<void>((resolve) => server.listen(join(dir, 'ipc.sock'), resolve));
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  const child = {
    name: 'leaf', recipePath: join(dir, 'recipe.json'), dataDir: dir, socketPath: join(dir, 'ipc.sock'),
    pid: process.pid, process: null, adopted: true, socket: null, status: 'ready', startedAt: Date.now(), exitedAt: null,
    lastEventAt: null, exitCode: null, exitReason: null, events: [], buffer: '', subscription: ['*'], idleSinceWork: false,
    textsSent: 0, autoRestart: false, killRequested: false, restartAttempts: [], lastCompletedSpeech: '',
  } as unknown as Child;
  fleet.children.set('leaf', child);
  await fleet.connectChildSocket(child);
  await until(() => logged.some((line) => line.includes('"leaf"') && line.includes('failed')), 'the failed attempt');
  await Bun.sleep(500);
  expect(accepted).toBe(2);
  expect(logged.filter((line) => line.includes('"leaf"'))).toEqual([
    '[fleet] connecting to child "leaf" again failed: its connection closed before it said it was ready',
  ]);
}, 30_000);

test("a connection whose first line isn't a ready is refused, and nothing it carries reaches this host", async () => {
  const { fleet, logged } = setup();
  const dir = mkdtempSync(join(tmpdir(), 'fleet-reattach-'));
  let accepted = 0;
  const server = createServer((socket) => {
    accepted += 1;
    if (accepted === 1) { socket.destroy(); return; }
    socket.on('error', () => {});
    socket.write(`${JSON.stringify({ type: 'lifecycle', phase: 'idle' })}\n` +
      `${JSON.stringify({ type: 'inference:speech', content: 'not from the child' })}\n`);
  });
  await new Promise<void>((resolve) => server.listen(join(dir, 'ipc.sock'), resolve));
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  const child = {
    name: 'leaf', recipePath: join(dir, 'recipe.json'), dataDir: dir, socketPath: join(dir, 'ipc.sock'),
    pid: process.pid, process: null, adopted: true, socket: null, status: 'ready', startedAt: Date.now(), exitedAt: null,
    lastEventAt: null, exitCode: null, exitReason: null, events: [], buffer: '', subscription: ['*'], idleSinceWork: false,
    textsSent: 0, autoRestart: false, killRequested: false, restartAttempts: [], lastCompletedSpeech: '',
  } as unknown as Child;
  fleet.children.set('leaf', child);
  await fleet.connectChildSocket(child);
  await until(() => logged.some((line) => line.includes('"leaf"') && line.includes('failed')), 'the refused attempt');
  expect(logged.filter((line) => line.includes('"leaf"'))).toEqual([
    '[fleet] connecting to child "leaf" again failed: what answered on its socket didn\'t first say it was ready, ' +
    'as a connectome host does',
  ]);
  expect(child.socket).toBeNull();
  expect(child.events).toEqual([]);
  expect(child.lastCompletedSpeech).toBe('');
}, 30_000);

test('after a failed connect, fleet--await tries to connect once before it waits', async () => {
  const { call, launch, failed, reconnected } = setup();
  const leaf = await launch('leaf');
  await leaf.cut({ thenBlock: true });
  await until(() => failed('leaf') === 1, 'the failed attempt');
  await until(() => leaf.unblocked() && leaf.disconnections() === 2, "the child closing the failed attempt's connection");
  expect(reconnected('leaf')).toBe(0);
  const waited = await call('await', { names: ['leaf'], timeoutMs: 1_000 });
  expect(waited.success).toBe(false);
  expect(waited.error).toStartWith('fleet--await timed out after 1000 ms.');
  expect(reconnected('leaf')).toBe(1);
  expect(failed('leaf')).toBe(1);
}, 30_000);

test("fleet--await's timeout counts from the call, a connect under way included", async () => {
  const { fleet, call, launch } = setup();
  fleet.connectAnswerMs = 20_000;
  const leaf = await launch('leaf', { blockMs: 25_000 });
  await leaf.cut({ thenBlock: true });
  await until(() => leaf.child.reopening !== undefined, 'the connect under way');
  const waited = await call('await', { names: ['leaf'], timeoutMs: 500 });
  expect(waited.error).toStartWith('fleet--await timed out after 500 ms.');
  expect(leaf.child.reopening).not.toBeUndefined();
}, 30_000);

test("fleet--await answers for a child once its connect fails, while another child's connect is still under way", async () => {
  const { fleet, call, launch } = setup();
  fleet.connectAnswerMs = 20_000;
  const first = await launch('first', { adoptedAlive: true, blockMs: 25_000 });
  const second = await launch('second', { blockMs: 25_000 });
  await first.cut({ thenBlock: true });
  await second.cut({ thenBlock: true });
  const waiting = call('await', { names: ['first', 'second'], timeoutMs: 20_000 });
  expect(first.child.reopening).not.toBeUndefined();
  first.proc.kill('SIGKILL');
  const waited = await waiting;
  expect(waited.error).toStartWith("No idle of child 'first' can reach this host, since it is ready, but its connection");
  expect(waited.error).toContain('connecting to it again failed: its connection closed before it said it was ready');
  expect(second.child.reopening).not.toBeUndefined();
}, 30_000);

test('an await already waiting keeps the idle of a child that then loses its connection', async () => {
  const { fleet, call, launch, logged } = setup();
  fleet.connectAnswerMs = 20_000;
  const idle = await launch('idle');
  const slow = await launch('slow', { adoptedAlive: true, blockMs: 25_000 });
  await idle.reply('the work this host sent');
  await until(() => idle.seen.idle > 0, 'the idle');
  await slow.cut({ thenBlock: true });
  await until(() => slow.child.reopening !== undefined, "the slow child's connect under way");
  const waiting = call('await', { names: ['idle', 'slow'], timeoutMs: 20_000 });
  await idle.takeover();
  await until(() => idle.connections() === 3 && idle.child.socket !== null, 'the parent connecting to the idle child again');
  await idle.takeover();
  await until(() => logged.some((line) => line.includes('"idle"') && line.includes('another client may hold')), 'the bound');
  expect(slow.child.reopening).not.toBeUndefined();
  slow.proc.kill('SIGKILL');
  const waited = await waiting;
  expect(waited.error).toStartWith("No idle of child 'slow' can reach this host, since it is ready, but its connection");
  expect(waited.error).toEndWith("Idle so far: 'idle'.");
}, 30_000);

test('an await keeps the idle a new connection brought after that connection closes again', async () => {
  const { fleet, call, launch, logged } = setup();
  fleet.connectAnswerMs = 20_000;
  const back = await launch('back', { blockMs: 25_000 });
  const slow = await launch('slow', { adoptedAlive: true, blockMs: 25_000 });
  await back.reply('the work this host sent');
  await until(() => back.seen.idle > 0, 'the idle');
  await back.cut({ thenBlock: true });
  await slow.cut({ thenBlock: true });
  const waiting = call('await', { names: ['back', 'slow'], timeoutMs: 20_000 });
  const readies = back.readies();
  back.release();
  await until(() => back.readies() > readies, "the child's ready on its new connection");
  await back.takeover();
  await until(() => logged.some((line) => line.includes('"back"') && line.includes('another client may hold')), 'the bound');
  expect(slow.child.reopening).not.toBeUndefined();
  slow.proc.kill('SIGKILL');
  const waited = await waiting;
  expect(waited.error).toStartWith("No idle of child 'slow' can reach this host");
  expect(waited.error).toEndWith("Idle so far: 'back'.");
}, 30_000);

test("an await begun on a child with no connection counts the idle its new connection brings", async () => {
  const { fleet, call, launch } = setup();
  fleet.connectAnswerMs = 20_000;
  const leaf = await launch('leaf', { blockMs: 25_000 });
  await leaf.reply('the work this host sent');
  await until(() => leaf.seen.idle > 0, 'the idle');
  await leaf.cut({ thenBlock: true });
  await until(() => leaf.child.reopening !== undefined, 'the connect under way');
  const waiting = call('await', { names: ['leaf'], timeoutMs: 20_000 });
  leaf.release();
  expect(await waiting).toMatchObject({ success: true, data: { names: ['leaf'], completed: true } });
}, 30_000);

test('fleet--await begun on a child last seen idle on a lost connection counts no idle while its connect is under way', async () => {
  const { fleet, call, launch } = setup();
  fleet.connectAnswerMs = 20_000;
  const leaf = await launch('leaf', { blockMs: 25_000 });
  await leaf.reply('the work this host sent');
  await until(() => leaf.seen.idle > 0, 'the idle');
  await leaf.cut({ thenBlock: true });
  await until(() => leaf.child.reopening !== undefined, 'the connect under way');
  const waited = await call('await', { names: ['leaf'], timeoutMs: 500 });
  expect(waited.success).toBe(false);
  expect(waited.error).toStartWith('fleet--await timed out after 500 ms. Idle: none.');
}, 30_000);

test("fleet--await answers at once for a child no connect can reach, without waiting for another child's connect", async () => {
  const { fleet, call, launch, logged } = setup();
  fleet.connectAnswerMs = 20_000;
  const held = await launch('held');
  const slow = await launch('slow', { blockMs: 25_000 });
  await held.takeover();
  await until(() => held.connections() === 3 && held.child.socket !== null, 'the parent connecting again');
  await held.takeover();
  await until(() => logged.some((line) => line.includes('"held"') && line.includes('another client may hold')), 'the bound');
  await slow.cut({ thenBlock: true });
  await until(() => slow.child.reopening !== undefined, "the slow child's connect under way");
  const waited = await call('await', { names: ['slow', 'held'], timeoutMs: 20_000 });
  expect(waited.error).toStartWith("No idle of child 'held' can reach this host");
  expect(slow.child.reopening).not.toBeUndefined();
}, 30_000);

test('fleet--await for any of its children answers for one no connect can reach, though another is idle', async () => {
  const { call, launch, logged } = setup();
  const idle = await launch('idle');
  const held = await launch('held');
  await idle.reply('the work this host sent');
  await until(() => idle.seen.idle > 0, 'the idle');
  await held.takeover();
  await until(() => held.connections() === 3 && held.child.socket !== null, 'the parent connecting again');
  await held.takeover();
  await until(() => logged.some((line) => line.includes('"held"') && line.includes('another client may hold')), 'the bound');
  const waited = await call('await', { names: ['idle', 'held'], requireAll: false, timeoutMs: 20_000 });
  expect(waited.error).toStartWith("No idle of child 'held' can reach this host");
  expect(waited.error).toEndWith("Idle so far: 'idle'.");
}, 30_000);

test("a reconnected child's tree is described again on its new connection", async () => {
  const { fleet, launch } = setup();
  const leaf = await launch('leaf');
  const aggregator = new FleetTreeAggregator(fleet as unknown as FleetModule);
  cleanups.push(() => aggregator.dispose());
  aggregator.registerChild('leaf');
  await until(() => leaf.seen.snapshot >= 1, 'the first snapshot');
  const before = leaf.seen.snapshot;
  await leaf.cut();
  await until(() => leaf.connections() === 2 && leaf.child.socket !== null, 'the parent connecting again');
  await until(() => leaf.seen.snapshot > before, 'a snapshot on the new connection');
}, 30_000);

test("fleet--await on a child that can't be reached answers at once, while waiting and when it starts", async () => {
  const { call, launch } = setup();
  const leaf = await launch('leaf');
  const waiting = call('await', { names: ['leaf'], timeoutMs: 20_000 });
  await leaf.signal('unlink', 'unlinked');
  await leaf.cut();
  const during = await waiting;
  expect(during.success).toBe(false);
  expect(during.error).toStartWith("No idle of child 'leaf' can reach this host, since it is ready, but its connection");
  expect(during.error).toContain('connecting to it again failed');
  const after = await call('await', { names: ['leaf'], timeoutMs: 20_000 });
  expect(after.success).toBe(false);
  expect(after.error).toStartWith("No idle of child 'leaf' can reach this host, since it is ready, but its connection");
}, 30_000);

test('fleet--await on a child last seen idle, whose connection is lost and not won back, counts no idle from before', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-reattach-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const { fleet, call, failed } = setup({
    childIndexPath: join(import.meta.dir, 'mock-fleet-lifecycle-child.ts'),
    socketWaitTimeoutMs: 10_000, readyTimeoutMs: 10_000, gracefulShutdownMs: 100, sigtermEscalationMs: 100,
  });
  cleanups.push(() => fleet.stop());
  writeFileSync(join(dir, 'recipe.json'), JSON.stringify({ idle: true }));
  expect(await call('launch', { name: 'idle', recipe: join(dir, 'recipe.json'), dataDir: join(dir, 'idle') }))
    .toMatchObject({ success: true });
  expect(await call('await', { names: ['idle'], timeoutMs: 5_000 })).toMatchObject({ success: true });
  expect(await call('command', { name: 'idle', command: '/drop-closed' })).toMatchObject({ success: true });
  await until(() => failed('idle') === 1, 'the failed attempt');
  const waited = await call('await', { names: ['idle'], timeoutMs: 20_000 });
  expect(waited.success).toBe(false);
  expect(waited.error).toStartWith("No idle of child 'idle' can reach this host, since it is ready, but its connection");
}, 30_000);

test("fleet--relay passes on only a reply made since this host's connection to the child last opened", async () => {
  const { fleet, call, launch, failed } = setup();
  fleet.reopenWindowMs = 100;
  const leaf = await launch('leaf');
  const sibling = await launch('sibling');
  await leaf.reply('the reply before');
  expect(await call('relay', { from: 'leaf', to: 'sibling' })).toMatchObject({ success: true });
  await until(() => sibling.texts().includes('the reply before'), 'the sibling taking the relay');

  await leaf.cut();
  await until(() => leaf.connections() === 2 && leaf.child.socket !== null, 'the parent connecting again');
  const reopened = await call('relay', { from: 'leaf', to: 'sibling' });
  expect(reopened.success).toBe(false);
  expect(reopened.error).toContain("hasn't finished a reply since this host's connection to it last opened");

  await leaf.reply('the reply after');
  expect(await call('relay', { from: 'leaf', to: 'sibling' })).toMatchObject({ success: true });
  await until(() => sibling.texts().includes('the reply after'), 'the sibling taking the second relay');

  await leaf.reply('the reply before the loss');
  await leaf.signal('unlink', 'unlinked');
  await leaf.cut();
  await until(() => failed('leaf') === 1, 'the failed attempt');
  const unreachable = await call('relay', { from: 'leaf', to: 'sibling' });
  expect(unreachable.success).toBe(false);
  expect(unreachable.error).toContain('may not be the latest');
  expect(sibling.texts()).not.toContain('the reply before the loss');
}, 30_000);

test('after a failed connect, fleet--relay from the child tries once to connect to it', async () => {
  const { call, launch, failed, reconnected } = setup();
  const leaf = await launch('leaf');
  const sibling = await launch('sibling');
  await leaf.reply('the reply before');
  await leaf.cut({ thenBlock: true });
  await until(() => failed('leaf') === 1, 'the failed attempt');
  leaf.release();
  await until(() => leaf.unblocked() && leaf.disconnections() === 2, "the child closing the failed attempt's connection");
  expect(reconnected('leaf')).toBe(0);
  const relayed = await call('relay', { from: 'leaf', to: 'sibling' });
  expect(relayed.error).toContain("hasn't finished a reply since this host's connection to it last opened");
  expect(reconnected('leaf')).toBe(1);
  expect(failed('leaf')).toBe(1);
  expect(sibling.texts()).toBe('');
}, 30_000);

test("fleet--relay waits for a connect to its source that starts while it waits for its target's", async () => {
  const { fleet, call, launch } = setup();
  fleet.connectAnswerMs = 20_000;
  const leaf = await launch('leaf', { blockMs: 25_000 });
  const sibling = await launch('sibling', { blockMs: 25_000 });
  await leaf.reply('the reply before');
  await sibling.cut({ thenBlock: true });
  await until(() => sibling.child.reopening !== undefined, "the target's connect under way");
  const relaying = call('relay', { from: 'leaf', to: 'sibling' });
  await leaf.cut({ thenBlock: true });
  await until(() => leaf.child.reopening !== undefined, "the source's connect under way");
  sibling.release();
  await until(() => sibling.child.socket !== null, 'the target connected again');
  leaf.release();
  const relayed = await relaying;
  expect(relayed.error).toContain("hasn't finished a reply since this host's connection to it last opened");
  expect(sibling.texts()).toBe('');
}, 30_000);

for (const [state, arrange] of [
  ['being stopped', (fleet: Fleet, child: Child) => { child.killRequested = true; }],
  ['recorded as exited', (fleet: Fleet, child: Child) => { child.status = 'exited'; }],
  ['replaced by a newer record', (fleet: Fleet, child: Child) => { fleet.children.set(child.name as string, { ...child }); }],
  ['whose process this host saw end', (fleet: Fleet, child: Child) => { child.process = { exitCode: 1, signalCode: null }; }],
] as const) {
  test(`a child ${state} is not connected to again when its connection closes`, async () => {
    const { fleet, launch, failed, reconnected } = setup();
    const leaf = await launch('leaf');
    arrange(fleet, leaf.child);
    const first = leaf.child.socket;
    await leaf.takeover();
    await until(() => leaf.child.socket !== first, "the parent seeing the close");
    expect(leaf.child.socket).toBeNull();
    expect(leaf.child.reopening).toBeUndefined();
    expect(failed('leaf')).toBe(0);
    expect(reconnected('leaf')).toBe(0);
  }, 30_000);
}

test('a host stopping with its children left running connects to none of them again', async () => {
  const { fleet, call, launch, logged } = setup();
  const leaf = await launch('leaf');
  fleet.setDetachMode(true);
  await fleet.stop();
  await until(() => leaf.disconnections() === 1, "the child seeing this host's connection close");
  expect((await call('send', { name: 'leaf', content: 'while stopping' })).success).toBe(false);
  expect(leaf.child.reopening).toBeUndefined();
  expect(leaf.alive()).toBe(true);
  expect(leaf.connections()).toBe(1);
  expect(logged.filter((line) => line.includes('"leaf"'))).toEqual([]);
}, 30_000);

test("a process other than the recorded child answering on its socket is not taken for it, nor anything it sends", async () => {
  const { call, launch, failed } = setup();
  const sleeper: ChildProcess = spawn('sleep', ['30'], { stdio: 'ignore' });
  cleanups.push(() => { sleeper.kill('SIGKILL'); });
  const leaf = await launch('leaf', { recordedPid: sleeper.pid, subscription: ['lifecycle'] });
  await until(() => leaf.readies() === 1, 'the first ready');
  expect(await call('send', { name: 'leaf', content: 'after the subscribe' })).toMatchObject({ success: true });
  await until(() => leaf.texts().includes('after the subscribe'), 'the child reading past the subscribe');
  await leaf.signal('chatter', 'chattering');
  await leaf.cut();
  await until(() => failed('leaf') === 1, 'the refused attempt');
  expect(leaf.child.socket).toBeNull();
  expect(leaf.readies()).toBe(1);
  const sent = await call('send', { name: 'leaf', content: 'not for another process' });
  expect(sent.success).toBe(false);
  expect(sent.error).toContain(`not the recorded pid ${sleeper.pid}`);
  expect(leaf.readies()).toBe(1);
  expect(leaf.seen.marker).toBe(0);
  expect(leaf.texts()).toBe('after the subscribe\n');
}, 30_000);
