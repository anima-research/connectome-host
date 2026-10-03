/**
 * Integration test for the 'panel-request' IPC verb against a REAL headless
 * child (full framework, no inference): the same runPanelOp dispatcher the
 * WebUI host uses locally must answer over the socket, so every operator
 * panel (mcpl / settings / pins / health / context debug) works for fleet
 * children exactly as it does for the host.
 *
 * Also verifies panel-response bypasses subscription filtering — a narrowed
 * event stream must never eat a request/response pair.
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
  name: 'Panel Test',
  agent: {
    name: 'commander',
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

describe('headless daemon — panel-request / panel-response', () => {
  let tmpDir: string;
  let socketPath: string;
  let child: ChildProcess;
  let sock: Socket;
  let reader: { events: Array<Record<string, unknown>>; stop: () => void };
  let corrSeq = 0;

  /** Send one panel-request and await its panel-response. */
  async function panel(op: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const corrId = `panel-test-${++corrSeq}`;
    sock.write(JSON.stringify({ type: 'panel-request', op, ...(params ? { params } : {}), corrId }) + '\n');
    await waitFor(
      () => reader.events.some((e) => e.type === 'panel-response' && e.corrId === corrId),
      10_000,
      `panel-response for op=${op}`,
    );
    return reader.events.find((e) => e.type === 'panel-response' && e.corrId === corrId)!;
  }

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fkm-panelreq-'));
    const recipePath = join(tmpDir, 'recipe.json');
    socketPath = join(tmpDir, 'ipc.sock');
    writeFileSync(recipePath, JSON.stringify(MINIMAL_RECIPE), 'utf-8');

    child = spawn(
      'bun',
      [INDEX_PATH, recipePath, '--headless'],
      {
        cwd: tmpDir,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: 'sk-test-panel',
          DATA_DIR: tmpDir,
        },
        stdio: ['ignore', 'ignore', 'ignore'],
      },
    );

    await waitFor(() => existsSync(socketPath), 15_000, 'socket file appears');
    sock = await connectSocket(socketPath);
    reader = lineReader(sock);
    await waitFor(
      () => reader.events.some((e) => e.type === 'lifecycle' && (e as { phase?: string }).phase === 'ready'),
      5_000,
      'lifecycle:ready',
    );
  });

  afterAll(async () => {
    try { sock.write(JSON.stringify({ type: 'shutdown' }) + '\n'); } catch { /* noop */ }
    await new Promise((r) => setTimeout(r, 500));
    try { reader.stop(); sock.destroy(); } catch { /* noop */ }
    try { if (child.exitCode === null) child.kill('SIGKILL'); } catch { /* noop */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  test('op=health returns the healthz assembly', async () => {
    const res = await panel('health');
    expect(res.ok).toBe(true);
    expect(res.op).toBe('health');
    const data = res.data as Record<string, unknown>;
    // Same shape /healthz serves: framework snapshot + the panel-data extras.
    expect(data.agents ?? data.runtimeSettings ?? data.contextComposition).toBeDefined();
  });

  test('op=settings returns the primary agent runtime settings', async () => {
    const res = await panel('settings');
    expect(res.ok).toBe(true);
    const data = res.data as { agent: string; settings: Record<string, unknown>; hotKeys: string[] };
    expect(data.agent).toBe('commander');
    expect(typeof data.settings).toBe('object');
    expect(Array.isArray(data.hotKeys)).toBe(true);
  });

  test('op=mcpl returns registry + live server view', async () => {
    const res = await panel('mcpl');
    expect(res.ok).toBe(true);
    const data = res.data as { configPath: string; servers: unknown[]; live: unknown[] };
    expect(typeof data.configPath).toBe('string');
    expect(Array.isArray(data.servers)).toBe(true);
    expect(Array.isArray(data.live)).toBe(true);
    expect(data.live.length).toBe(0); // minimal recipe opts into no MCPLs
  });

  test('op=pins returns a snapshot with candidates when asked', async () => {
    const res = await panel('pins', { withCandidates: true });
    expect(res.ok).toBe(true);
    const data = res.data as { agent: string; pins: unknown[]; pinsSupported: boolean; candidates?: unknown[] };
    expect(data.agent).toBe('commander');
    expect(Array.isArray(data.pins)).toBe(true);
    expect(typeof data.pinsSupported).toBe('boolean');
    expect(Array.isArray(data.candidates)).toBe(true);
  });

  test('op=context-coverage names the agent and its branch', async () => {
    const res = await panel('context-coverage');
    expect(res.ok).toBe(true);
    const data = res.data as { agent: string; branch: string; totals: Record<string, number> };
    expect(data.agent).toBe('commander');
    expect(typeof data.branch).toBe('string');
    expect(typeof data.totals.chunks).toBe('number');
  });

  test('unknown agent comes back ok:false with 404', async () => {
    const res = await panel('context-coverage', { agent: 'nonexistent' });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(res.error).toContain('nonexistent');
  });

  test('unknown op comes back ok:false with 400', async () => {
    const res = await panel('no-such-op');
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(res.error).toContain('unknown panel op');
  });

  test('panel-response bypasses subscription filter', async () => {
    sock.write(JSON.stringify({ type: 'subscribe', events: ['command-output'] }) + '\n');
    await new Promise((r) => setTimeout(r, 100));
    const res = await panel('health');
    expect(res.ok).toBe(true);
  });
});
