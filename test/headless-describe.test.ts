/**
 * Integration test for the 'describe' IPC verb.
 *
 * Spawns a headless daemon, sends {type:'describe'}, and asserts the
 * child responds with a single 'snapshot' event whose tree shape matches
 * AgentTreeReducer's output. Also verifies snapshot bypasses subscription
 * filtering — the parent should always be able to recover state regardless
 * of how it has narrowed the event stream.
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
  name: 'Describe Test',
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

describe('headless daemon — describe / snapshot', () => {
  let tmpDir: string;
  let recipePath: string;
  let socketPath: string;
  let child: ChildProcess;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fkm-describe-'));
    recipePath = join(tmpDir, 'recipe.json');
    socketPath = join(tmpDir, 'ipc.sock');
    writeFileSync(recipePath, JSON.stringify(MINIMAL_RECIPE), 'utf-8');

    child = spawn(
      'bun',
      [INDEX_PATH, recipePath, '--headless'],
      {
        cwd: tmpDir,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: 'sk-test-describe',
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

  test('describe returns a snapshot with the seeded framework agent', async () => {
    const sock = await connectSocket(socketPath);
    const r = lineReader(sock);

    await waitFor(
      () => r.events.some((e) => e.type === 'lifecycle' && (e as { phase?: string }).phase === 'ready'),
      5_000,
      'lifecycle:ready',
    );

    sock.write(JSON.stringify({ type: 'describe', corrId: 'test-1' }) + '\n');

    await waitFor(
      () => r.events.some((e) => e.type === 'snapshot'),
      3_000,
      'snapshot response',
    );

    const snap = r.events.find((e) => e.type === 'snapshot') as Record<string, unknown>;
    expect(snap.corrId).toBe('test-1');
    expect(typeof snap.asOfTs).toBe('number');

    const childMeta = snap.child as Record<string, unknown>;
    expect(childMeta.name).toBe('Describe Test');
    expect(typeof childMeta.pid).toBe('number');
    expect(typeof childMeta.startedAt).toBe('number');

    const tree = snap.tree as { nodes: Array<Record<string, unknown>>; callIdIndex: Record<string, string> };
    expect(Array.isArray(tree.nodes)).toBe(true);
    expect(tree.nodes.length).toBeGreaterThanOrEqual(1);
    const commander = tree.nodes.find(n => n.name === 'commander');
    expect(commander).toBeDefined();
    expect(commander!.kind).toBe('framework');
    expect(commander!.phase).toBe('idle');

    r.stop();
    sock.destroy();
  });

  test('snapshot bypasses subscription filter', async () => {
    const sock = await connectSocket(socketPath);
    const r = lineReader(sock);

    await waitFor(
      () => r.events.some((e) => e.type === 'lifecycle' && (e as { phase?: string }).phase === 'ready'),
      5_000,
      'lifecycle:ready (filter test)',
    );

    // Narrow the subscription to something snapshot is not part of.
    sock.write(JSON.stringify({ type: 'subscribe', events: ['command-output'] }) + '\n');
    await new Promise((r) => setTimeout(r, 100));

    const eventsBefore = r.events.length;
    sock.write(JSON.stringify({ type: 'describe', corrId: 'filter-test' }) + '\n');

    await waitFor(
      () => r.events.slice(eventsBefore).some((e) => e.type === 'snapshot'),
      3_000,
      'snapshot delivered despite narrow subscription',
    );

    r.stop();
    sock.destroy();
  });

  test('cleanup', async () => {
    // Final shutdown so afterAll doesn't have to SIGKILL.
    const sock = await connectSocket(socketPath);
    sock.write(JSON.stringify({ type: 'shutdown' }) + '\n');
    await new Promise((r) => setTimeout(r, 500));
    sock.destroy();
  });
});
