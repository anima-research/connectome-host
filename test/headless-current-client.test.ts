import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(10);
  }
}

/** A headless child on the real protocol, and clients of its socket. */
async function withChild(body: (h: {
  dir: string;
  log: () => string;
  open: (options?: { allowHalfOpen?: boolean; read?: boolean }) => Promise<{
    socket: Socket;
    events: Array<Record<string, unknown>>;
    send: (command: object) => void;
    hasReply: (text: string) => boolean;
  }>;
}) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'headless-current-client-'));
  const sockets: Socket[] = [];
  const child = spawn(process.execPath, [new URL('./mock-headless-command-child.ts', import.meta.url).pathname], {
    env: { ...process.env, DATA_DIR: dir }, stdio: 'ignore',
  });
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const log = () => (existsSync(join(dir, 'headless.log')) ? readFileSync(join(dir, 'headless.log'), 'utf8') : '');
  const open = async (options: { allowHalfOpen?: boolean; read?: boolean } = {}) => {
    const socket = connect({ path: join(dir, 'ipc.sock'), allowHalfOpen: options.allowHalfOpen ?? false });
    sockets.push(socket);
    const events: Array<Record<string, unknown>> = [];
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) events.push(JSON.parse(line));
      }
    });
    socket.on('error', () => { /* a reset is the point of one test */ });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    await until(() => events.some(event => event.type === 'lifecycle' && event.phase === 'ready'), 'ready');
    const send = (command: object) => socket.write(JSON.stringify(command) + '\n');
    const hasReply = (text: string) => events.some(event => event.type === 'command-output' && String(event.text).includes(text));
    return { socket, events, send, hasReply };
  };
  try {
    await until(() => existsSync(join(dir, 'ipc.sock')), 'socket');
    await body({ dir, log, open });
  } finally {
    for (const socket of sockets) socket.destroy();
    if (!exited()) child.kill('SIGTERM');
    try { await until(exited, 'child shutdown'); }
    catch { child.kill('SIGKILL'); await until(exited, 'child forced shutdown'); }
    rmSync(dir, { recursive: true, force: true });
  }
}

// Bun 1.3.14, the runtime connectome-host pins, closes the whole socket at
// end(), so a superseded client's later writes never reach the child. Bun
// 1.4.2 half-closes it, as Node does, and they arrive. The rule is the
// child's either way, and this test can only reach it where they arrive.
test.skipIf(Bun.semver.order(Bun.version, '1.4.2') < 0)("a superseded client's later commands are dropped, not run", async () => {
  await withChild(async ({ dir, log, open }) => {
    // The first client keeps its half of the socket open after the child
    // ends its own, as one whose writes were in flight would.
    const first = await open({ allowHalfOpen: true });
    const second = await open();
    second.send({ type: 'subscribe', events: [] });
    await until(() => log().includes('client connected') && log().split('client connected').length > 2, 'second client current');

    const release = join(dir, 'release');
    const done = join(dir, 'done');
    writeFileSync(release, 'go');
    first.send({ type: 'subscribe', events: ['*'] });
    first.send({ type: 'command', command: `/puppet delayed ${JSON.stringify({ release, done, result: 'SUPERSEDED' })}` });

    await until(() => log().includes('command dropped: command, requester superseded/closed'), 'the command dropped');
    expect(log()).toContain('command dropped: subscribe, requester superseded/closed');
    expect(log()).not.toContain('subscription set: *');
    expect(existsSync(done)).toBe(false);

    // The current client still commands the child.
    second.send({ type: 'command', command: '/still-current' });
    await until(() => second.hasReply('/still-current'), 'the current client answered');
  });
}, 20_000);

// The reset needs a client that never reads; python3 is on every CI runner.
test.skipIf(!Bun.which('python3'))('a client whose socket is reset without an end stops being current', async () => {
  await withChild(async ({ dir, log, open }) => {
    // A client that exits with the child's writes still unread in its
    // receive queue: on Linux the child then reads ECONNRESET, and its socket
    // closes without an 'end', as when a parent dies with events queued.
    const raw = spawn('python3', ['-c', [
      'import socket, sys, time',
      's = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)',
      's.connect(sys.argv[1])',
      'time.sleep(0.3)',
    ].join('\n'), join(dir, 'ipc.sock')], { stdio: 'ignore' });
    await new Promise<void>((resolve) => raw.once('exit', () => resolve()));

    await until(() => log().includes('client disconnected; child stays up'), 'the disconnect logged');
    const next = await open();
    next.send({ type: 'command', command: '/after-reset' });
    await until(() => next.hasReply('/after-reset'), 'the next client answered');
    expect(log()).not.toContain('closing previous client');
  });
}, 20_000);
