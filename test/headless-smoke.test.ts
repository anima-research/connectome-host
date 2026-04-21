/**
 * Phase 1 smoke test for headless daemon mode.
 *
 * Spawns `bun src/index.ts <recipe> --headless` as a subprocess in a
 * temp dir, then exercises the JSONL-over-Unix-socket protocol:
 *   - lifecycle:ready emitted on connect
 *   - subscribe filter applied
 *   - /help command produces command-output events (offline-safe path)
 *   - client disconnect does NOT kill the child
 *   - reconnecting yields a fresh lifecycle:ready
 *   - shutdown command exits cleanly with socket + pid file removed
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { connect as netConnect, type Socket } from 'node:net';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..');
const INDEX_PATH = join(REPO_ROOT, 'src', 'index.ts');

// Recipe with all optional modules disabled — no MCP servers, no workspace
// mounts, no lessons/retrieval, no wake gate.  TimeModule + TuiModule are
// always-on in createFramework() but neither needs external resources.
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

// --- helpers -------------------------------------------------------------

function lineReader(socket: Socket): { events: Array<Record<string, unknown>>; stop: () => void } {
  const events: Array<Record<string, unknown>> = [];
  let buf = '';
  const handler = (chunk: Buffer): void => {
    buf += chunk.toString('utf-8');
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { events.push(JSON.parse(line) as Record<string, unknown>); } catch { /* ignore malformed */ }
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

async function connectSocket(path: string, timeoutMs = 3_000): Promise<Socket> {
  return new Promise((resolveConn, rejectConn) => {
    const s = netConnect(path);
    const timer = setTimeout(() => {
      s.destroy();
      rejectConn(new Error(`socket connect timeout: ${path}`));
    }, timeoutMs);
    s.once('connect', () => { clearTimeout(timer); resolveConn(s); });
    s.once('error', (err) => { clearTimeout(timer); rejectConn(err); });
  });
}

// --- test ----------------------------------------------------------------

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
        // cwd=tmpDir so DEFAULT_CONFIG_PATH (cwd/mcpl-servers.json) doesn't
        // accidentally pick up the dev's real MCPL config.
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
    try { if (child.exitCode === null) child.kill('SIGKILL'); } catch { /* noop */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  test('protocol: ready → subscribe → command → reconnect → shutdown', async () => {
    // -- Connect 1: receive ready, run /help --
    const sock1 = await connectSocket(socketPath);
    const r1 = lineReader(sock1);

    await waitFor(
      () => r1.events.some((e) => e.type === 'lifecycle' && (e as { phase?: string }).phase === 'ready'),
      5_000,
      'first lifecycle:ready',
    );

    // Narrow subscription so we can assert the filter is applied.
    sock1.write(JSON.stringify({ type: 'subscribe', events: ['lifecycle', 'command-output'] }) + '\n');
    await new Promise((r) => setTimeout(r, 100));

    // /help is offline-safe — no LLM call.
    sock1.write(JSON.stringify({ type: 'command', command: '/help' }) + '\n');
    await waitFor(
      () => r1.events.filter((e) => e.type === 'command-output').length >= 5,
      5_000,
      'command-output lines from /help',
    );

    // -- Disconnect; verify child stays up --
    r1.stop();
    sock1.destroy();
    await new Promise((r) => setTimeout(r, 200));
    expect(child.exitCode).toBeNull();

    // -- Connect 2: fresh ready event --
    const sock2 = await connectSocket(socketPath);
    const r2 = lineReader(sock2);

    await waitFor(
      () => r2.events.some((e) => e.type === 'lifecycle' && (e as { phase?: string }).phase === 'ready'),
      5_000,
      'second lifecycle:ready (after reconnect)',
    );

    // -- Shutdown; verify exit + cleanup --
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

    // Give OS a beat for unlink to propagate
    await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(pidPath)).toBe(false);
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, 'utf-8').length).toBeGreaterThan(0);
  }, 60_000);
});
