import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { type Socket } from 'node:net';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectWhenAccepting } from './ipc-connect.js';
import { writeHostModeRecord } from './host-mode-record.js';

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

const quiescedRefusal = (what: string): string => `${what} refused: this host is quiesced for a release switch. If that ` +
  'switch goes ahead, its stop can cut a change to the session off. Nothing changed; try again once that quiesce has ended.';

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

interface Host {
  tmpDir: string;
  child: ChildProcess;
  sock: Socket;
  reader: { events: Array<Record<string, unknown>>; stop: () => void };
}

async function startHost(operatorQuiesce?: string): Promise<Host> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'fkm-panelreq-'));
  writeFileSync(join(tmpDir, 'recipe.json'), JSON.stringify(MINIMAL_RECIPE), 'utf-8');
  if (operatorQuiesce === undefined) return launch(tmpDir);
  // The record lives in the active session's store, which only the host's first start can make: JsStore creates a
  // store only where its directory is absent.
  const first = await launch(tmpDir);
  const exited = new Promise((done) => first.child.once('exit', done));
  first.sock.write(JSON.stringify({ type: 'shutdown' }) + '\n');
  await exited;
  first.reader.stop();
  first.sock.destroy();
  writeHostModeRecord(tmpDir, operatorQuiesce);
  return launch(tmpDir);
}

async function launch(tmpDir: string): Promise<Host> {
  const recipePath = join(tmpDir, 'recipe.json');
  const socketPath = join(tmpDir, 'ipc.sock');
  const child = spawn(
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
  const sock = await connectWhenAccepting(socketPath);
  const reader = lineReader(sock);
  await waitFor(
    () => reader.events.some((e) => e.type === 'lifecycle' && (e as { phase?: string }).phase === 'ready'),
    5_000,
    'lifecycle:ready',
  );
  return { tmpDir, child, sock, reader };
}

async function stopHost(host: Host): Promise<void> {
  const exited = host.child.exitCode !== null || host.child.signalCode !== null
    ? Promise.resolve()
    : new Promise((done) => host.child.once('exit', done));
  try {
    host.sock.write(JSON.stringify({ type: 'shutdown' }) + '\n');
  } catch {
    host.child.kill('SIGKILL');
  }
  await exited;
  try { host.reader.stop(); host.sock.destroy(); } catch { }
  try { rmSync(host.tmpDir, { recursive: true, force: true }); } catch { }
}

async function ask(host: Host, message: Record<string, unknown>, answer: string): Promise<Record<string, unknown>> {
  host.sock.write(JSON.stringify(message) + '\n');
  const label = `${answer} for ${String(message.corrId)}`;
  await waitFor(() => host.reader.events.some((e) => e.type === answer && e.corrId === message.corrId), 10_000, label);
  return host.reader.events.find((e) => e.type === answer && e.corrId === message.corrId)!;
}

describe('headless daemon — panel-request / panel-response', () => {
  let host: Host;
  let sock: Socket;
  let reader: Host['reader'];
  let corrSeq = 0;

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

  async function switchRequest(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const corrId = `switch-test-${++corrSeq}`;
    sock.write(JSON.stringify({ type: 'update-request', request, corrId }) + '\n');
    await waitFor(
      () => reader.events.some((e) => e.type === 'update-response' && e.corrId === corrId),
      10_000,
      `update-response for op=${String(request.op)}`,
    );
    return reader.events.find((e) => e.type === 'update-response' && e.corrId === corrId)!;
  }

  async function command(text: string): Promise<string> {
    const corrId = `command-test-${++corrSeq}`;
    sock.write(JSON.stringify({ type: 'command', command: text, corrId }) + '\n');
    await waitFor(
      () => reader.events.some((e) => e.type === 'command-done' && e.corrId === corrId),
      10_000,
      `command-done for ${text}`,
    );
    return reader.events.filter((e) => e.type === 'command-output' && e.corrId === corrId).map((e) => String(e.text)).join('\n');
  }

  beforeAll(async () => {
    host = await startHost();
    ({ sock, reader } = host);
  });

  afterAll(async () => {
    await stopHost(host);
  });

  test('op=health returns the healthz assembly', async () => {
    const res = await panel('health');
    expect(res.ok).toBe(true);
    expect(res.op).toBe('health');
    const data = res.data as Record<string, unknown>;
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
    expect(data.live.length).toBe(0);
  });

  test('op=tool-classes reports effective classes, host table included', async () => {
    const res = await panel('tool-classes');
    expect(res.ok).toBe(true);
    const data = res.data as {
      agent: string | null;
      counts: Record<string, number>;
      tools: Array<{ tool: string; class: string[]; source: string }>;
    };
    expect(data.agent).toBeNull();
    expect(data.tools.length).toBeGreaterThan(0);
    expect(Object.values(data.counts).reduce((a, b) => a + b, 0)).toBe(data.tools.length);
    expect(data.tools.find((t) => t.tool === 'time--now')).toMatchObject({ class: ['control'], source: 'host' });

    const scoped = await panel('tool-classes', { agent: 'commander' });
    expect(scoped.ok).toBe(true);
    expect((scoped.data as { agent: string }).agent).toBe('commander');

    const unknown = await panel('tool-classes', { agent: 'nonexistent' });
    expect(unknown.ok).toBe(false);
    expect(unknown.status).toBe(404);
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

  test('op=context-maintenance reports the framework\'s own interval, 5000 ms, for a recipe without maintenanceIntervalMs', async () => {
    const res = await panel('context-maintenance');
    expect(res.ok).toBe(true);
    expect((res.data as { intervalMs?: unknown }).intervalMs).toBe(5000);
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

  test("a change to the session is refused while this host is quiesced for a release switch, and goes once it has resumed", async () => {
    const quiesced = await switchRequest({ op: 'quiesce', to: '9.9.9', waitMs: 0 });
    expect(quiesced.ok).toBe(true);
    try {
      for (const op of ['settings-update', 'settings-reset', 'settings-cancel-transition', 'pin-add', 'pin-remove']) {
        const res = await panel(op, { agent: 'commander' });
        expect({ op, ok: res.ok, status: res.status }).toEqual({ op, ok: false, status: 409 });
        expect(res.error).toBe(quiescedRefusal(op));
      }
      expect((await panel('settings')).ok).toBe(true);
    } finally {
      expect((await switchRequest({ op: 'resume' })).ok).toBe(true);
    }
    const after = await panel('settings-cancel-transition', { agent: 'commander' });
    expect(after.status).not.toBe(409);
  });

  test("a command that changes the session is refused while this host is quiesced for a release switch, changing nothing, and goes once it has resumed", async () => {
    const quiesced = await switchRequest({ op: 'quiesce', to: '9.9.9', waitMs: 0 });
    expect(quiesced.ok).toBe(true);
    try {
      expect(await command('/checkpoint held-by-switch')).toBe(quiescedRefusal('/checkpoint'));
      expect(await command('/checkpoint')).not.toContain('held-by-switch');
    } finally {
      expect((await switchRequest({ op: 'resume' })).ok).toBe(true);
    }
    expect(await command('/checkpoint held-by-switch')).toContain('Checkpoint "held-by-switch" saved');
    expect(await command('/checkpoint')).toContain('Saved checkpoints: held-by-switch');
  });

  test('panel-response bypasses subscription filter', async () => {
    sock.write(JSON.stringify({ type: 'subscribe', events: ['command-output'] }) + '\n');
    await new Promise((r) => setTimeout(r, 100));
    const res = await panel('health');
    expect(res.ok).toBe(true);
  });

  test("/session new and /session switch are refused while this host is quiesced for a release switch, making and opening no session", async () => {
    const quiesced = await switchRequest({ op: 'quiesce', to: '9.9.9', waitMs: 0 });
    expect(quiesced.ok).toBe(true);
    try {
      expect(await command('/session new held-by-switch')).toBe(quiescedRefusal('/session new'));
      expect(await command('/session create held-by-switch')).toBe(quiescedRefusal('/session create'));
      expect(await command('/session switch held-by-switch')).toBe(quiescedRefusal('/session switch'));
      expect(await command('/session sw held-by-switch')).toBe(quiescedRefusal('/session sw'));
      expect(await command('/session list')).not.toContain('held-by-switch');
    } finally {
      expect((await switchRequest({ op: 'resume' })).ok).toBe(true);
    }
  });
});

describe('headless daemon — panel-request on a host its operator quiesced', () => {
  let host: Host;

  beforeAll(async () => {
    host = await startHost('maintenance: disk swap');
  });

  afterAll(async () => {
    await stopHost(host);
  });

  test("a change to the session isn't refused on a host its operator quiesced: only a switch's quiesce refuses it", async () => {
    for (const op of ['settings-update', 'settings-reset', 'settings-cancel-transition', 'pin-add', 'pin-remove']) {
      const asked = { type: 'panel-request', op, params: { agent: 'commander' }, corrId: `op-${op}` };
      const res = await ask(host, asked, 'panel-response');
      expect({ op, refused: res.status === 409 }).toEqual({ op, refused: false });
    }
    const switchAsk = { type: 'update-request', request: { op: 'quiesce', to: '9.9.9', waitMs: 0 }, corrId: 'held' };
    const held = await ask(host, switchAsk, 'update-response');
    expect(held.data).toMatchObject({ operatorHold: { reason: 'maintenance: disk swap' } });
  });

  test("while it holds on the switch's last look, a command that changes the session is refused with the hold's words, /session new makes no session, and the next last look still finds it held", async () => {
    const HOLDING = "the release switch's last look has begun here, so nothing here changes until the install's host decides it. " +
      "If it calls the switch off, Resume works here again; if the switch goes ahead, this host stops. Where the install's host " +
      "can't reach this host, stopping the install's host or restarting this one ends the wait.";
    const heldRefusal = (what: string) => `${what} refused: ${HOLDING} Nothing changed; try again once the switch is decided.`;
    let seq = 0;
    const command = async (text: string): Promise<string> => {
      const corrId = `held-command-${++seq}`;
      await ask(host, { type: 'command', command: text, corrId }, 'command-done');
      return host.reader.events.filter((e) => e.type === 'command-output' && e.corrId === corrId).map((e) => String(e.text)).join('\n');
    };
    const lastLook = (look: string) => ({
      type: 'update-request', corrId: `last-${look}-${++seq}`,
      request: { op: 'quiesce', to: '9.9.9', waitMs: 0, last: { look, mark: join(host.tmpDir, 'no-mark.json'), parent: process.pid } },
    });
    expect((await ask(host, lastLook('look-1'), 'update-response')).data).toMatchObject({ held: true });
    try {
      expect(await command('/session new held-by-look')).toBe(heldRefusal('/session new'));
      expect(await command('/session switch held-by-look')).toBe(heldRefusal('/session switch'));
      expect(await command('/checkpoint held-by-look')).toBe(heldRefusal('/checkpoint'));
      expect(await command('/session list')).not.toContain('held-by-look');
      expect((await ask(host, lastLook('look-1'), 'update-response')).data).toMatchObject({ held: true });
    } finally {
      const release = { type: 'update-request', corrId: `release-${++seq}`, request: { op: 'release', look: 'look-1' } };
      expect((await ask(host, release, 'update-response')).ok).toBe(true);
    }
    expect(await command('/checkpoint after-the-look')).toContain('Checkpoint "after-the-look" saved');
  }, 30_000);
});
