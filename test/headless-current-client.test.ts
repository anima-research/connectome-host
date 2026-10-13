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
  open: (options?: { allowHalfOpen?: boolean }) => Promise<{
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
  const open = async (options: { allowHalfOpen?: boolean } = {}) => {
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

/** Where sockets behave as in Node: a reset gets no 'end', and end() only half-closes. */
const nodeSockets = Bun.semver.order(Bun.version, '1.4.2') >= 0;
const count = (text: string, needle: string) => text.split(needle).length - 1;

// The reset tests need a client that never reads. On CI they must run, so a
// runner without python3 fails them; elsewhere they skip, and say so.
const noPython = !Bun.which('python3') && !process.env.CI;
if (noPython) console.warn('headless-current-client: python3 not found, so the reset test is skipped');

test('a client that ends cleanly stops being current, and its disconnect is logged once', async () => {
  await withChild(async ({ log, open }) => {
    const first = await open();
    first.socket.end();
    await until(() => log().includes('client disconnected; child stays up'), 'the disconnect logged');
    const next = await open();
    next.send({ type: 'command', command: '/after-end' });
    await until(() => next.hasReply('/after-end'), 'the next client answered');
    expect(count(log(), 'client disconnected; child stays up')).toBe(1);
    expect(log()).not.toContain('superseded client disconnected');
    expect(log()).not.toContain('closing previous client');
  });
}, 20_000);

test("a superseded client's disconnect leaves the newer client current", async () => {
  await withChild(async ({ log, open }) => {
    await open();
    const second = await open();
    // The child end()s the first when the second connects. Its socket then
    // closes (Bun 1.3.14) or ends when the client answers the end (Node's
    // semantics, Bun 1.4.2), either way while the second is current.
    await until(() => log().includes('superseded client disconnected'), 'the superseded disconnect logged');
    second.send({ type: 'command', command: '/still-current' });
    await until(() => second.hasReply('/still-current'), 'the current client answered');
    expect(log()).not.toContain('client disconnected; child stays up');
    expect(count(log(), 'superseded client disconnected')).toBe(1);
  });
}, 20_000);

// Bun 1.3.14, the runtime connectome-host's CI pins, closes the whole socket
// at end(), so a superseded client's later writes never arrive and the rule
// can't be reached: there this test is skipped. The house's cross-package
// check runs the suite on Bun 1.4.2, which half-closes the socket as Node
// does, so the writes arrive and the rule decides.
test.skipIf(!nodeSockets)("a superseded client's later commands are dropped, not run", async () => {
  await withChild(async ({ dir, log, open }) => {
    // The first client keeps its half of the socket open after the child
    // ends its own, as one whose writes were in flight would.
    const first = await open({ allowHalfOpen: true });
    const second = await open();
    second.send({ type: 'subscribe', events: [] });
    await until(() => count(log(), 'client connected') >= 2, 'second client current');

    const release = join(dir, 'release');
    const done = join(dir, 'done');
    writeFileSync(release, 'go');
    first.send({ type: 'subscribe', events: ['*'] });
    first.send({ type: 'command', command: `/puppet delayed ${JSON.stringify({ release, done, result: 'SUPERSEDED' })}` });
    first.send({ type: 'text', content: 'from the superseded client' });
    first.send({ type: 'shutdown', graceful: true });
    first.socket.end();

    // Its end follows its four lines, so the disconnect counts all four.
    await until(() => log().includes('superseded client disconnected; 4 command(s)'), 'the four commands counted');
    expect(count(log(), 'command dropped: ')).toBe(1);
    expect(log()).toContain('command dropped: subscribe; its client was superseded');
    expect(log()).not.toContain('subscription set: *');
    expect(log()).not.toContain('dispatchCommand threw');

    // The child is still up (its shutdown was dropped) and the current
    // client still commands it.
    second.send({ type: 'command', command: '/still-current' });
    await until(() => second.hasReply('/still-current'), 'the current client answered');
    await Bun.sleep(100);
    expect(existsSync(done)).toBe(false);
  });
}, 20_000);

// A client that exits with the child's writes unread in its receive queue
// resets its socket: on Linux the child reads ECONNRESET, as when a parent
// dies with events queued. Where sockets behave as in Node (Bun 1.4.2) the
// socket then closes with an error and no 'end', which only 'close' sees.
// Bun 1.3.14 gives it an 'end' instead, so there this test passes on main's
// source too: it shows the reset is handled, not that 'close' is needed.
test.skipIf(noPython)('a client whose socket is reset stops being current, and its disconnect is logged once', async () => {
  await withChild(async ({ dir, log, open }) => {
    const raw = spawn('python3', ['-c', [
      'import select, socket, sys',
      's = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)',
      's.connect(sys.argv[1])',
      // Exit once the child's ready event is waiting, unread.
      'select.select([s], [], [], 5)',
    ].join('\n'), join(dir, 'ipc.sock')], { stdio: 'ignore' });
    await new Promise<void>((resolve) => raw.once('exit', () => resolve()));

    await until(() => log().includes('client disconnected; child stays up'), 'the disconnect logged');
    const next = await open();
    next.send({ type: 'command', command: '/after-reset' });
    await until(() => next.hasReply('/after-reset'), 'the next client answered');
    expect(count(log(), 'client disconnected; child stays up')).toBe(1);
    expect(log()).not.toContain('superseded client disconnected');
    expect(log()).not.toContain('closing previous client');
    if (nodeSockets) expect(log()).toContain('ECONNRESET');
  });
}, 20_000);
