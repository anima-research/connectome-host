/**
 * connectWhenAccepting, the IPC tests' connect: it waits out a socket path that
 * exists before anything accepts on it, as a headless process's can while it
 * starts, and gives up at its deadline.
 */
import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectWhenAccepting } from './ipc-connect.js';

/** What a connect to a path nothing accepts on fails with: ECONNREFUSED under
 *  Node and Bun 1.4, ENOENT under Bun 1.3. */
const REFUSALS = ['ECONNREFUSED', 'ENOENT'];
const codeOf = (err: Error): string => (err as NodeJS.ErrnoException).code ?? String(err);

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ipc-connect-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function listening(path: string): Promise<Server> {
  const server: Server = createServer((socket) => socket.end());
  cleanups.push(() => server.close());
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return server;
}

/** A socket path that exists with nothing accepting on it: a child listened
 *  there and was killed, which leaves the path behind. */
async function refusingPath(): Promise<string> {
  const path = join(tempDir(), 'ipc.sock');
  const child = spawn(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(path)}); setInterval(() => {}, 1000)`], { stdio: 'ignore' });
  cleanups.push(() => { child.kill('SIGKILL'); });
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error('the child never listened');
    await Bun.sleep(5);
  }
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
  return path;
}

test('a connect refused, then failing on a path not there yet, is tried again until the server accepts', async () => {
  const path = await refusingPath();
  const failures: Array<{ code: string; afterUnlink: boolean }> = [];
  let unlinked = false;
  let refused!: () => void;
  let absent!: () => void;
  const sawRefusal = new Promise<void>((resolve) => { refused = resolve; });
  const sawAbsence = new Promise<void>((resolve) => { absent = resolve; });
  const connecting = connectWhenAccepting(path, {
    timeoutMs: 10_000,
    onFailedConnect: (err) => {
      failures.push({ code: codeOf(err), afterUnlink: unlinked });
      (unlinked ? absent : refused)();
    },
  });
  // The server comes up only after a connect has been refused, and then one
  // has found no path at all. This continuation runs as soon as the refusal
  // is heard, before the helper's timer for its next connect can fire, so the
  // path is gone before that connect.
  await sawRefusal;
  unlinkSync(path);
  unlinked = true;
  await sawAbsence;
  await listening(path);
  const socket = await connecting;
  socket.destroy();
  expect(REFUSALS).toContain(failures[0].code);
  expect(failures.find((f) => f.afterUnlink)?.code).toBe('ENOENT');
}, 15_000);

test('a connect still refused at its deadline fails with the last error, trying again after a pause', async () => {
  const path = await refusingPath();
  const heard: Array<{ err: Error; at: number }> = [];
  const started = Date.now();
  const failure = await connectWhenAccepting(path, { timeoutMs: 1_000, onFailedConnect: (err) => heard.push({ err, at: performance.now() }) })
    .then(() => null, (err: Error) => err);
  const waited = Date.now() - started;
  expect(failure).toBe(heard.at(-1)!.err);
  expect(REFUSALS).toContain(codeOf(failure!));
  expect(waited).toBeGreaterThanOrEqual(1_000);
  // Each try after the first waits out the pause, 20 ms, where a loop
  // without it tries again at once.
  expect(heard.length).toBeGreaterThan(1);
  const gaps = heard.slice(1).map((h, i) => h.at - heard[i]!.at);
  expect(Math.min(...gaps)).toBeGreaterThanOrEqual(15);
}, 15_000);

test('with no deadline given, a connect still refused fails after about 3 s', async () => {
  const path = await refusingPath();
  const started = Date.now();
  const failure = await connectWhenAccepting(path).then(() => null, (err: Error) => err);
  const waited = Date.now() - started;
  expect(REFUSALS).toContain(codeOf(failure!));
  expect(waited).toBeGreaterThanOrEqual(3_000);
  // Far enough past 3 s for a loaded host, and short of a 10 s default.
  expect(waited).toBeLessThan(8_000);
}, 15_000);

test('the socket it returns has the allowHalfOpen it was given, and ignores a later error', async () => {
  const path = join(tempDir(), 'ipc.sock');
  await listening(path);
  for (const allowHalfOpen of [true, false, undefined]) {
    const socket = await connectWhenAccepting(path, allowHalfOpen === undefined ? {} : { allowHalfOpen });
    expect(socket.allowHalfOpen).toBe(allowHalfOpen ?? false);
    // With no listener of the test's own, an 'error' would throw here.
    expect(() => socket.emit('error', new Error('a reset after the connect'))).not.toThrow();
    socket.destroy();
  }
});
