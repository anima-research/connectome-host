import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { type Socket } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectWhenAccepting } from './ipc-connect.js';

const DEADLINE_MS = 500;
const KEEP_UP_DEADLINE_MS = 1_000;
const SUPERSEDE_DEADLINE_MS = 2_000;

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(10);
  }
}

type Client = { socket: Socket; lines: () => number; closed: () => boolean };
type Flood = { open: () => Promise<Client>; log: () => string; burst: () => Promise<number> };

async function withFlood(deadlineMs: number | undefined, body: (flood: Flood) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'headless-client-stall-'));
  const sockets: Socket[] = [];
  const env: Record<string, string | undefined> = { ...process.env, DATA_DIR: dir };
  delete env.STOPPED_READING_MS;
  if (deadlineMs !== undefined) env.STOPPED_READING_MS = String(deadlineMs);
  const child = spawn(process.execPath, [new URL('./mock-headless-flood-child.ts', import.meta.url).pathname], {
    env, stdio: 'ignore',
  });
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const log = () => existsSync(join(dir, 'headless.log')) ? readFileSync(join(dir, 'headless.log'), 'utf8') : '';
  let bursts = 0;
  const burst = async (): Promise<number> => {
    bursts += 1;
    writeFileSync(join(dir, `burst-${bursts}`), '');
    const sent = join(dir, `burst-${bursts}-sent`);
    await until(() => existsSync(sent) && readFileSync(sent, 'utf8') !== '', `burst ${bursts}`);
    return Number(readFileSync(sent, 'utf8'));
  };
  const open = async (): Promise<Client> => {
    const socket = await connectWhenAccepting(join(dir, 'ipc.sock'), { allowHalfOpen: false });
    sockets.push(socket);
    let lines = 0;
    let head = '';
    let closed = false;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      lines += chunk.split('\n').length - 1;
      if (head.length < 4_096) head += chunk.slice(0, 4_096);
    });
    socket.on('close', () => { closed = true; });
    socket.on('error', () => {});
    await until(() => head.includes('"phase":"ready"'), 'ready');
    return { socket, lines: () => lines, closed: () => closed };
  };
  try {
    await until(() => existsSync(join(dir, 'ipc.sock')), 'socket');
    await body({ open, log, burst });
  } finally {
    for (const socket of sockets) socket.destroy();
    if (!exited()) child.kill('SIGTERM');
    try { await until(exited, 'child shutdown'); }
    catch { child.kill('SIGKILL'); await until(exited, 'child forced shutdown'); }
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a client that stops reading is closed once its deadline passes, the log says what it left unsent, and the child takes a new client', async () => {
  await withFlood(DEADLINE_MS, async ({ open, log, burst }) => {
    const client = await open();
    client.socket.pause();
    await burst();
    await until(() => /client hadn't taken what was queued for it within 0\.5 s; closed with [1-9]\d* bytes unsent/.test(log()), 'the cut');
    expect(log()).not.toContain('superseded client');
    client.socket.resume();
    await until(client.closed, 'the client seeing its connection closed');
    await until(() => log().includes('client disconnected; child stays up'), 'the host releasing it');
    const next = await open();
    expect(next.closed()).toBe(false);
  });
}, 15_000);

test('a client superseded while it isn\'t reading is closed at its own deadline, and the client after it stays', async () => {
  await withFlood(SUPERSEDE_DEADLINE_MS, async ({ open, log, burst }) => {
    const first = await open();
    first.socket.pause();
    await burst();
    const second = await open();
    await until(() => log().includes('superseded client hadn\'t taken what was queued for it within 2 s'), 'the superseded cut');
    first.socket.resume();
    await until(first.closed, 'the superseded client seeing its connection closed');
    const seen = second.lines();
    await burst();
    await until(() => second.lines() >= seen + 8_000, 'the next client\'s events after the cut');
    expect({ second: second.closed(), currentClosed: log().includes('client disconnected; child stays up') })
      .toEqual({ second: false, currentClosed: false });
  });
}, 15_000);

test('a client that ends its own side while it isn\'t reading is closed at its deadline as a client, not a superseded one', async () => {
  await withFlood(DEADLINE_MS, async ({ open, log, burst }) => {
    const client = await open();
    client.socket.pause();
    await burst();
    client.socket.end();
    await until(() => log().includes('hadn\'t taken what was queued for it within 0.5 s'), 'the cut');
    const released = log().indexOf('client disconnected; child stays up');
    expect({ releasedFirst: released >= 0 && released < log().indexOf('hadn\'t taken'), superseded: log().includes('superseded client') })
      .toEqual({ releasedFirst: true, superseded: false });
    client.socket.resume();
    await until(client.closed, 'the client seeing its connection closed');
  });
}, 15_000);

test('a client that keeps up through refused writes stays connected past its deadline', async () => {
  await withFlood(KEEP_UP_DEADLINE_MS, async ({ open, log, burst }) => {
    const client = await open();
    const seen = client.lines();
    let refused = 0;
    for (let n = 0; n < 4; n += 1) {
      refused = await burst();
      await Bun.sleep(KEEP_UP_DEADLINE_MS / 2);
    }
    await until(() => client.lines() >= seen + 32_000 || log().includes('hadn\'t taken'), 'every burst read, or a cut');
    expect({ refusedSome: refused > 0, cut: log().includes('hadn\'t taken'), closed: client.closed(), read: client.lines() >= seen + 32_000 })
      .toEqual({ refusedSome: true, cut: false, closed: false, read: true });
  });
}, 15_000);

test('with no deadline given, the host doesn\'t cut a client whose writes it refused within two seconds', async () => {
  await withFlood(undefined, async ({ open, log, burst }) => {
    const client = await open();
    client.socket.pause();
    const refused = await burst();
    await Bun.sleep(2_000);
    expect({ refusedSome: refused > 0, cut: log().includes('hadn\'t taken'), closed: client.closed() })
      .toEqual({ refusedSome: true, cut: false, closed: false });
  });
}, 15_000);
