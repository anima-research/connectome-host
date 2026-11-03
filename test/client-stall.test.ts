import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchForStall, type StallClock } from '../src/client-stall.ts';

const DEADLINE_MS = 300_000;
const LINE = `${'x'.repeat(148)}\n`;
const opened: Array<() => void> = [];

afterEach(() => {
  for (const close of opened.splice(0)) close();
});

class HeldClock implements StallClock {
  started = 0;
  stopped = 0;
  private live: Array<{ run: () => void; ms: number; id: number }> = [];
  private ids = 0;

  get pending(): { run: () => void; ms: number; id: number } | null {
    if (this.live.length > 1) throw new Error(`${this.live.length} deadlines are running at once`);
    return this.live[0] ?? null;
  }

  start(run: () => void, ms: number): unknown {
    this.started += 1;
    this.ids += 1;
    this.live.push({ run, ms, id: this.ids });
    return this.ids;
  }

  stop(started: unknown): void {
    const at = this.live.findIndex((deadline) => deadline.id === started);
    if (at < 0) return;
    this.live.splice(at, 1);
    this.stopped += 1;
  }

  fire(): void {
    const due = this.pending;
    if (!due) throw new Error('no deadline is running');
    this.live = [];
    due.run();
  }
}

async function pair(allowHalfOpen = false): Promise<{ host: Socket; client: Socket }> {
  const dir = mkdtempSync(join(tmpdir(), 'client-stall-'));
  let accepted!: (socket: Socket) => void;
  const arrived = new Promise<Socket>((resolve) => { accepted = resolve; });
  const server: Server = createServer((socket) => accepted(socket));
  await new Promise<void>((resolve) => server.listen(join(dir, 's.sock'), resolve));
  const client = connect({ path: join(dir, 's.sock'), allowHalfOpen });
  const host = await arrived;
  host.on('error', () => {});
  client.on('error', () => {});
  opened.push(() => {
    client.destroy();
    host.destroy();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { host, client };
}

function fillUntilRefused(host: Socket, arm: () => void): void {
  for (let n = 0; n < 100_000; n += 1) {
    if (!host.write(LINE)) {
      arm();
      return;
    }
  }
  throw new Error('the host\'s writes were never refused');
}

const event = (socket: Socket, name: string) => new Promise<void>((resolve) => socket.once(name, () => resolve()));
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

test('a client that stops reading starts one deadline, of the length given, at its first refused write; later refused writes leave it running, and when the deadline fires the client is cut', async () => {
  const { host, client } = await pair();
  client.pause();
  const clock = new HeldClock();
  const cuts: number[] = [];
  const arm = watchForStall(host, DEADLINE_MS, (unsent) => cuts.push(unsent), clock);
  fillUntilRefused(host, arm);
  const first = clock.pending;
  for (let n = 0; n < 1_000; n += 1) {
    host.write(LINE);
    arm();
  }
  expect({ started: clock.started, ms: first?.ms, same: clock.pending === first }).toEqual({ started: 1, ms: DEADLINE_MS, same: true });
  clock.fire();
  expect(cuts).toHaveLength(1);
  expect(cuts[0]).toBeGreaterThan(0);
});

test('a client that keeps up clears its deadline, though one large write fills its queue', async () => {
  const { host, client } = await pair();
  let read = 0;
  client.on('data', (chunk) => { read += chunk.length; });
  const clock = new HeldClock();
  const cuts: number[] = [];
  const arm = watchForStall(host, DEADLINE_MS, (unsent) => cuts.push(unsent), clock);
  const big = 'y'.repeat(8 * 1024 * 1024);
  const drained = event(host, 'drain');
  expect(host.write(big)).toBe(false);
  arm();
  expect(clock.started).toBe(1);
  await drained;
  while (read < big.length) await tick();
  expect({ running: clock.pending, stopped: clock.stopped, cuts }).toEqual({ running: null, stopped: 1, cuts: [] });
});

test('a client that reads again clears the deadline its stall started', async () => {
  const { host, client } = await pair();
  client.pause();
  const clock = new HeldClock();
  const arm = watchForStall(host, DEADLINE_MS, () => {}, clock);
  fillUntilRefused(host, arm);
  const drained = event(host, 'drain');
  client.resume();
  await drained;
  expect({ running: clock.pending, stopped: clock.stopped, unsent: host.writableLength }).toEqual({ running: null, stopped: 1, unsent: 0 });
});

test('a client that drained and then stops reading again starts a new deadline, which cuts it', async () => {
  const { host, client } = await pair();
  client.pause();
  const clock = new HeldClock();
  const cuts: number[] = [];
  const arm = watchForStall(host, DEADLINE_MS, (unsent) => cuts.push(unsent), clock);
  fillUntilRefused(host, arm);
  const drained = event(host, 'drain');
  client.resume();
  await drained;
  expect({ running: clock.pending, stopped: clock.stopped }).toEqual({ running: null, stopped: 1 });
  client.pause();
  const chunk = 'w'.repeat(16 * 1024);
  while (!clock.pending) {
    if (!host.write(chunk)) arm();
    await tick();
  }
  clock.fire();
  expect({ started: clock.started >= 2, cuts: cuts.length }).toEqual({ started: true, cuts: 1 });
});

test('a client that reads but can\'t keep up keeps its deadline running', async () => {
  const { host, client } = await pair();
  let reads = 0;
  client.on('data', () => {
    reads += 1;
    client.pause();
    setTimeout(() => client.resume(), 50);
  });
  const clock = new HeldClock();
  const cuts: number[] = [];
  const arm = watchForStall(host, DEADLINE_MS, (unsent) => cuts.push(unsent), clock);
  const chunk = 'z'.repeat(64 * 1024);
  while (!clock.pending) {
    if (!host.write(chunk)) arm();
    await tick();
  }
  const first = clock.pending;
  const readsAtArm = reads;
  while (reads < readsAtArm + 3) {
    host.write(chunk);
    await tick();
  }
  expect({ same: clock.pending === first, stopped: clock.stopped }).toEqual({ same: true, stopped: 0 });
  clock.fire();
  expect(cuts).toHaveLength(1);
});

test('a client that closes clears its deadline', async () => {
  const { host, client } = await pair();
  client.pause();
  const clock = new HeldClock();
  const arm = watchForStall(host, DEADLINE_MS, () => {}, clock);
  fillUntilRefused(host, arm);
  const closed = event(host, 'close');
  client.destroy();
  await closed;
  expect({ running: clock.pending, stopped: clock.stopped }).toEqual({ running: null, stopped: 1 });
});

test('a client that takes everything after the host ends its connection, and keeps its own side open, clears its deadline', async () => {
  const { host, client } = await pair(true);
  client.on('data', () => {});
  client.pause();
  const clock = new HeldClock();
  const arm = watchForStall(host, DEADLINE_MS, () => {}, clock);
  const chunk = 'v'.repeat(16 * 1024);
  for (let n = 0; n < 256; n += 1) if (!host.write(chunk)) arm();
  const finished = event(host, 'finish');
  host.end();
  await tick();
  expect({ running: clock.pending !== null, unsent: host.writableLength > 0 }).toEqual({ running: true, unsent: true });
  client.resume();
  await finished;
  expect({ running: clock.pending, stopped: clock.stopped, unsent: host.writableLength, destroyed: host.destroyed })
    .toEqual({ running: null, stopped: 1, unsent: 0, destroyed: false });
});
