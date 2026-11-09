import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { type Socket } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectWhenAccepting } from './ipc-connect.js';

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(10);
  }
}

async function withChild(body: (h: {
  dir: string;
  log: () => string;
  open: (options?: { allowHalfOpen?: boolean }) => Promise<{
    socket: Socket;
    events: Array<Record<string, unknown>>;
    send: (command: object) => void;
    answered: (corrId: string) => boolean;
  }>;
}) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'headless-current-client-'));
  const sockets: Socket[] = [];
  const child = spawn(process.execPath, [new URL('./mock-headless-command-child.ts', import.meta.url).pathname], {
    env: { ...process.env, DATA_DIR: dir }, stdio: 'ignore',
  });
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const log = () => (existsSync(join(dir, 'headless.log')) ? readFileSync(join(dir, 'headless.log'), 'utf8') : '');
  const open = async (options: { allowHalfOpen?: boolean } = {}) => {
    const socket = await connectWhenAccepting(join(dir, 'ipc.sock'), { allowHalfOpen: options.allowHalfOpen ?? false });
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
    socket.on('error', () => { });
    await until(() => events.some(event => event.type === 'lifecycle' && event.phase === 'ready'), 'ready');
    const send = (command: object) => socket.write(JSON.stringify(command) + '\n');
    const answered = (corrId: string) => events.some(event => event.corrId === corrId);
    return { socket, events, send, answered };
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

/** Where sockets behave as in Node: a reset gets no 'end', and end() only half-closes. */
const nodeSockets = Bun.semver.order(Bun.version, '1.4.2') >= 0;
const count = (text: string, needle: string) => text.split(needle).length - 1;

const pythonMissingOutsideCi = !Bun.which('python3') && !process.env.CI;
if (pythonMissingOutsideCi) console.warn('headless-current-client: python3 not found, so the reset test is skipped');

test('a client that ends cleanly stops being current, and its disconnect is logged once', async () => {
  await withChild(async ({ log, open }) => {
    const first = await open();
    first.socket.end();
    await until(() => log().includes('client disconnected; child stays up'), 'the disconnect logged');
    const next = await open();
    next.send({ type: 'describe', corrId: 'after-end' });
    await until(() => next.answered('after-end'), 'the next client answered');
    expect(count(log(), 'client disconnected; child stays up')).toBe(1);
    expect(log()).not.toContain('superseded client disconnected');
    expect(log()).not.toContain('closing previous client');
  });
}, 20_000);

test("a superseded client's disconnect leaves the newer client current", async () => {
  await withChild(async ({ log, open }) => {
    await open();
    const second = await open();
    await until(() => log().includes('superseded client disconnected'), 'the superseded disconnect logged');
    second.send({ type: 'describe', corrId: 'still-current' });
    await until(() => second.answered('still-current'), 'the current client answered');
    expect(log()).not.toContain('client disconnected; child stays up');
    expect(count(log(), 'superseded client disconnected')).toBe(1);
  });
}, 20_000);

test.skipIf(!nodeSockets)("a superseded client's later commands are dropped, not run", async () => {
  await withChild(async ({ dir, log, open }) => {
    const first = await open({ allowHalfOpen: true });
    const second = await open();
    second.send({ type: 'subscribe', events: [] });
    await until(() => count(log(), 'client connected') >= 2, 'second client current');

    first.send({ type: 'subscribe', events: ['*'] });
    first.send({ type: 'request-workspace-tree', corrId: 'superseded', mount: '/m' });
    first.send({ type: 'text', content: 'from the superseded client' });
    first.send({ type: 'shutdown', graceful: true });
    first.socket.end();

    await until(() => log().includes('superseded client disconnected; 4 command(s)'), 'the four commands counted');
    expect(count(log(), 'command dropped: ')).toBe(1);
    expect(log()).toContain('command dropped: subscribe; its client was superseded');
    expect(log()).not.toContain('subscription set: *');
    expect(log()).not.toContain('dispatchCommand threw');

    second.send({ type: 'describe', corrId: 'still-current' });
    await until(() => second.answered('still-current'), 'the current client answered');
    expect(existsSync(join(dir, 'started'))).toBe(false);
  });
}, 20_000);

// A client that exits with the child's writes unread resets its socket,
// which then gets an error and 'close' but no 'end'.
test.skipIf(pythonMissingOutsideCi)('a client whose socket is reset stops being current, and its disconnect is logged once', async () => {
  await withChild(async ({ dir, log, open }) => {
    const raw = spawn('python3', ['-c', [
      'import select, socket, sys, time',
      'deadline = time.time() + 10',
      'while True:',
      '    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)',
      '    try:',
      '        s.connect(sys.argv[1])',
      '        break',
      '    except (ConnectionRefusedError, FileNotFoundError):',
      '        s.close()',
      '        if time.time() > deadline: raise',
      '        time.sleep(0.02)',
      'select.select([s], [], [], 5)',
    ].join('\n'), join(dir, 'ipc.sock')], { stdio: 'ignore' });
    await new Promise<void>((resolve) => raw.once('exit', () => resolve()));

    await until(() => log().includes('client disconnected; child stays up'), 'the disconnect logged');
    const next = await open();
    next.send({ type: 'describe', corrId: 'after-reset' });
    await until(() => next.answered('after-reset'), 'the next client answered');
    expect(count(log(), 'client disconnected; child stays up')).toBe(1);
    expect(log()).not.toContain('superseded client disconnected');
    expect(log()).not.toContain('closing previous client');
    if (nodeSockets) expect(log()).toContain('ECONNRESET');
  });
}, 20_000);
