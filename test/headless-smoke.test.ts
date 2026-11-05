import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, lstatSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { type Socket } from 'node:net';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectWhenAccepting } from './ipc-connect.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..');
const INDEX_PATH = join(REPO_ROOT, 'src', 'index.ts');

const MINIMAL_RECIPE = {
  name: 'Smoke Test',
  agent: {
    name: 'smoke',
    systemPrompt: 'never asked to infer in this test',
  },
  modules: {
    subagents: false,
    lessons: false,
    retrieval: false,
    wake: false,
    workspace: false,
  },
};

function lineReader(socket: Socket): { events: Array<Record<string, unknown>>; stop: () => void } {
  const events: Array<Record<string, unknown>> = [];
  socket.setEncoding('utf8');
  let buf = '';
  const handler = (chunk: string): void => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { events.push(JSON.parse(line) as Record<string, unknown>); } catch { }
    }
  };
  socket.on('data', handler);
  return { events, stop: (): void => { socket.off('data', handler); } };
}

async function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}`);
}

describe('headless daemon — Phase 1', () => {
  let tmpDir: string;
  let recipePath: string;
  let socketPath: string;
  let pidPath: string;
  let logPath: string;
  let child: ChildProcess;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fkm-headless-'));
    recipePath = join(tmpDir, 'recipe.json');
    socketPath = join(tmpDir, 'ipc.sock');
    pidPath = join(tmpDir, 'headless.pid');
    logPath = join(tmpDir, 'headless.log');
    writeFileSync(recipePath, JSON.stringify(MINIMAL_RECIPE), 'utf-8');

    child = spawn(
      'bun',
      [INDEX_PATH, recipePath, '--headless'],
      {
        cwd: tmpDir,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: 'sk-test-headless-smoke',
          DATA_DIR: tmpDir,
        },
        stdio: ['ignore', 'ignore', 'ignore'],
      },
    );

    await waitFor(() => existsSync(socketPath), 15_000, 'socket file appears');
  });

  afterAll(() => {
    try { if (child.exitCode === null) child.kill('SIGKILL'); } catch { }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { }
  });

  test('protocol: ready → subscribe → command → reconnect → shutdown', async () => {
    const sock1 = await connectWhenAccepting(socketPath);
    const r1 = lineReader(sock1);

    await waitFor(
      () => r1.events.some((e) => e.type === 'lifecycle' && (e as { phase?: string }).phase === 'ready'),
      5_000,
      'first lifecycle:ready',
    );

    sock1.write(JSON.stringify({ type: 'subscribe', events: ['lifecycle', 'command-output'] }) + '\n');
    await new Promise((r) => setTimeout(r, 100));

    sock1.write(JSON.stringify({ type: 'command', command: '/help' }) + '\n');
    await waitFor(
      () => r1.events.filter((e) => e.type === 'command-output').length >= 5,
      5_000,
      'command-output lines from /help',
    );

    r1.stop();
    sock1.destroy();
    await new Promise((r) => setTimeout(r, 200));
    expect(child.exitCode).toBeNull();

    const sock2 = await connectWhenAccepting(socketPath);
    const r2 = lineReader(sock2);

    await waitFor(
      () => r2.events.some((e) => e.type === 'lifecycle' && (e as { phase?: string }).phase === 'ready'),
      5_000,
      'second lifecycle:ready (after reconnect)',
    );

    sock2.write(JSON.stringify({ type: 'shutdown' }) + '\n');

    await waitFor(
      () => r2.events.some((e) => e.type === 'lifecycle' && (e as { phase?: string }).phase === 'exiting'),
      3_000,
      'lifecycle:exiting',
    );

    const exitCode = await new Promise<number | null>((resolveExit) => {
      if (child.exitCode !== null) { resolveExit(child.exitCode); return; }
      child.once('exit', (code) => resolveExit(code));
    });

    r2.stop();
    sock2.destroy();

    expect(exitCode).toBe(0);

    await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(pidPath)).toBe(false);
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, 'utf-8').length).toBeGreaterThan(0);
  }, 60_000);
});

describe('headless daemon: its data directory', () => {
  test('a host creates its data directory, and a directory above it, readable by its owner alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fkm-headless-datadir-'));
    const dataDir = join(dir, 'agent', 'data');
    try {
      await startUntilItsSocketFails(dir, dataDir);
      expect(lstatSync(join(dir, 'agent')).mode & 0o777).toBe(0o700);
      expect(lstatSync(dataDir).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('a host leaves a data directory that is already there its mode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fkm-headless-datadir-'));
    const dataDir = join(dir, 'data');
    try {
      mkdirSync(dataDir);
      chmodSync(dataDir, 0o755);
      await startUntilItsSocketFails(dir, dataDir);
      expect(lstatSync(dataDir).mode & 0o777).toBe(0o755);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("a host whose data directory can't be made stops, naming it", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fkm-headless-datadir-'));
    const dataDir = join(realpathSync(dir), 'data');
    let child: ChildProcess | undefined;
    try {
      writeFileSync(dataDir, 'a file where the data directory goes\n');
      const recipe = join(dir, 'recipe.json');
      writeFileSync(recipe, JSON.stringify(MINIMAL_RECIPE), 'utf-8');
      child = spawn('bun', [INDEX_PATH, recipe, '--headless', '--socket-path', join(dir, 'ipc.sock')], {
        cwd: dir,
        env: { ...process.env, ANTHROPIC_API_KEY: 'sk-test-headless-datadir', DATA_DIR: 'data' },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr!.on('data', (chunk) => { stderr += chunk; });
      const exited = child;
      const code = await new Promise<number | null>((resolveExit) => exited.once('close', (c) => resolveExit(c)));
      expect(code).toBe(1);
      expect(stderr).toContain(`The host can't make its data directory ${dataDir}, so it stops: `);
      expect(stderr).toMatch(/, so it stops: E[A-Z]+: /);
      expect(stderr).toContain('Set DATA_DIR to a path where this user has or can make a directory');
      expect(stderr).not.toContain('Fatal error');
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  async function startUntilItsSocketFails(dir: string, dataDir: string): Promise<void> {
    let child: ChildProcess | undefined;
    const umask = process.umask(0o022);
    try {
      const recipe = join(dir, 'recipe.json');
      writeFileSync(recipe, JSON.stringify(MINIMAL_RECIPE), 'utf-8');
      const socketPath = join(dir, 'ipc.sock');
      mkdirSync(join(socketPath, 'taken'), { recursive: true });
      child = spawn('bun', [INDEX_PATH, recipe, '--headless', '--socket-path', socketPath], {
        cwd: dir,
        env: { ...process.env, ANTHROPIC_API_KEY: 'sk-test-headless-datadir', DATA_DIR: dataDir },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr!.on('data', (chunk) => { stderr += chunk; });
      const exited = child;
      const code = await new Promise<number | null>((resolveExit) => exited.once('exit', (c) => resolveExit(c)));
      if (code !== 1) throw new Error(`the host exited ${code}, not 1; its stderr: ${stderr}`);
      expect(readFileSync(join(dataDir, 'headless.log'), 'utf-8')).toContain('server error:');
    } finally {
      process.umask(umask);
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }
});

describe('headless daemon: a fatal error', () => {
  test('exits once headless.log holds what was written before it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fkm-headless-fatal-'));
    let child: ChildProcess | undefined;
    try {
      const recipe = join(dir, 'recipe.json');
      writeFileSync(recipe, JSON.stringify(MINIMAL_RECIPE), 'utf-8');
      // A directory at the socket's path makes listening fail.
      mkdirSync(join(dir, 'ipc.sock', 'taken'), { recursive: true });
      child = spawn('bun', ['--preload', join(TEST_DIR, 'slow-log-writes.ts'), INDEX_PATH, recipe, '--headless'], {
        cwd: dir,
        env: { ...process.env, ANTHROPIC_API_KEY: 'sk-test-headless-fatal', DATA_DIR: dir, SLOW_LOG_WRITES_MS: '100' },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr!.on('data', (chunk) => { stderr += chunk; });
      const exited = child;
      const code = await new Promise<number | null>((resolveExit) => exited.once('exit', (c) => resolveExit(c)));
      if (code !== 1) throw new Error(`the host exited ${code}, not 1; its stderr: ${stderr}`);
      expect(readFileSync(join(dir, 'headless.log'), 'utf-8')).toContain('server error:');
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
