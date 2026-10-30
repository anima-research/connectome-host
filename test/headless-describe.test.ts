import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { type Socket } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectWhenAccepting } from './ipc-connect.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

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
      [join(TEST_DIR, 'mock-runheadless-child.ts'), recipePath, '--headless'],
      {
        cwd: tmpDir,
        env: {
          ...process.env,
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

  test('describe returns a snapshot with the seeded framework agent', async () => {
    const sock = await connectWhenAccepting(socketPath);
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
    const sock = await connectWhenAccepting(socketPath);
    const r = lineReader(sock);

    await waitFor(
      () => r.events.some((e) => e.type === 'lifecycle' && (e as { phase?: string }).phase === 'ready'),
      5_000,
      'lifecycle:ready (filter test)',
    );

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
});
