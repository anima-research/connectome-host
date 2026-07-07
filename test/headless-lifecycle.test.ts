/**
 * Lifecycle chaos drills (fragility audit Group 1), process-level.
 *
 *  - 1.2: a second headless instance on the same DATA_DIR must refuse to
 *    start while the first is alive (PID liveness probe), instead of
 *    stealing the socket and double-writing the Chronicle store.
 *  - 1.5: headless trace forwarding must survive `/session new` — the
 *    switch replaces app.framework, and the socket previously went dark.
 *  - 1.1: SIGTERM in --no-tui mode must run the graceful path (previously
 *    the runtime default handler killed the process outright).
 *
 * Harness mirrors test/headless-smoke.test.ts.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { connect as netConnect, type Socket } from 'node:net';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..');
const INDEX_PATH = join(REPO_ROOT, 'src', 'index.ts');

const MINIMAL_RECIPE = {
  name: 'Lifecycle Test',
  agent: {
    name: 'lifecycle',
    systemPrompt: 'never expected to produce useful inference in this test',
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

function spawnHost(args: string[], cwd: string, extraOpts: { stdin?: 'pipe' | 'ignore' } = {}): ChildProcess {
  return spawn('bun', [INDEX_PATH, ...args], {
    cwd,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: 'sk-test-headless-lifecycle',
      DATA_DIR: cwd,
    },
    stdio: [extraOpts.stdin ?? 'ignore', 'pipe', 'pipe'],
  });
}

describe('headless lifecycle drills', () => {
  let tmpDir: string;
  let recipePath: string;
  let socketPath: string;
  let child: ChildProcess;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fkm-lifecycle-'));
    recipePath = join(tmpDir, 'recipe.json');
    socketPath = join(tmpDir, 'ipc.sock');
    writeFileSync(recipePath, JSON.stringify(MINIMAL_RECIPE), 'utf-8');

    child = spawnHost([recipePath, '--headless'], tmpDir);
    await waitFor(() => existsSync(socketPath), 15_000, 'first instance socket appears');
  });

  afterAll(() => {
    try { if (child.exitCode === null) child.kill('SIGKILL'); } catch { /* noop */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  test('1.2: second instance on the same DATA_DIR refuses to start', async () => {
    const second = spawnHost([recipePath, '--headless'], tmpDir);
    const exitCode = await new Promise<number | null>((resolveExit) => {
      const t = setTimeout(() => { second.kill('SIGKILL'); resolveExit(null); }, 20_000);
      second.once('exit', (code) => { clearTimeout(t); resolveExit(code); });
    });

    // Refused: non-zero exit, and the first instance is untouched — still
    // alive, socket still present and still answering.
    expect(exitCode).not.toBe(0);
    expect(exitCode).not.toBeNull();
    expect(child.exitCode).toBeNull();
    expect(existsSync(socketPath)).toBe(true);
    const probe = await connectSocket(socketPath);
    const r = lineReader(probe);
    await waitFor(
      () => r.events.some((e) => e.type === 'lifecycle' && (e as { phase?: string }).phase === 'ready'),
      5_000,
      'first instance still emits ready after refused double-start',
    );
    r.stop();
    probe.destroy();
  }, 60_000);

  test('1.5: trace forwarding survives /session new', async () => {
    const sock = await connectSocket(socketPath);
    const r = lineReader(sock);
    await waitFor(
      () => r.events.some((e) => e.type === 'lifecycle' && (e as { phase?: string }).phase === 'ready'),
      5_000,
      'ready before session switch',
    );

    sock.write(JSON.stringify({ type: 'command', command: '/session new lifecycle-two' }) + '\n');
    await waitFor(
      () => r.events.some((e) => e.type === 'command-output' && String(e.text).includes('Session switched')),
      20_000,
      'session switched confirmation',
    );

    // Push a message that triggers inference. The fake API key means the
    // inference will fail — but the trace stream (message:added /
    // inference:*) must still arrive on the socket. Before the rebind fix,
    // the child emitted zero trace events after a switch.
    const before = r.events.length;
    sock.write(JSON.stringify({ type: 'text', content: 'are you alive?' }) + '\n');
    await waitFor(
      () => r.events.slice(before).some((e) => {
        const t = String(e.type ?? '');
        return t.startsWith('inference:') || t === 'message:added';
      }),
      15_000,
      'trace events still flowing after /session new',
    );

    r.stop();
    sock.destroy();
  }, 60_000);
});

describe('piped-mode signal handling', () => {
  test('1.1: SIGTERM in --no-tui mode triggers graceful shutdown (exit 0)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fkm-piped-'));
    const recipePath = join(dir, 'recipe.json');
    writeFileSync(recipePath, JSON.stringify(MINIMAL_RECIPE), 'utf-8');

    const proc = spawnHost([recipePath, '--no-tui'], dir, { stdin: 'pipe' });
    let stdout = '';
    proc.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf-8'); });

    try {
      // Recipe load logs before framework creation; give the framework a
      // moment to finish starting after that line appears.
      await waitFor(() => stdout.includes('Loaded recipe'), 15_000, 'piped host booted');
      await new Promise((r) => setTimeout(r, 2_500));

      proc.kill('SIGTERM');
      const result = await new Promise<{ code: number | null; signal: string | null }>((resolveExit) => {
        const t = setTimeout(() => { proc.kill('SIGKILL'); resolveExit({ code: null, signal: 'test-timeout' }); }, 25_000);
        proc.once('exit', (code, signal) => { clearTimeout(t); resolveExit({ code, signal }); });
      });

      // Graceful handler ran: clean exit code, not death-by-signal
      // (the pre-fix behavior was code=null, signal=SIGTERM).
      expect(result.signal).toBeNull();
      expect(result.code).toBe(0);
    } finally {
      try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch { /* noop */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
    }
  }, 60_000);
});
