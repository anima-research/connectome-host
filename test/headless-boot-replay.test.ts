/**
 * The boot reaches the first client (agent-framework#546, connectome-host#334):
 * framework traces from before any client connected are kept and sent to the
 * first client after its `ready`, each marked `replay: true`, oldest first,
 * then a `replay-truncated` line when the boot outran the hold; live traces
 * after that are unmarked; a later client gets `ready` and no replay (it
 * sends `describe`). The agent tree folds the boot too, so a derived agent
 * the boot announced hangs under its source in the snapshot, as a framework
 * node.
 */
import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { type Socket } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

type Client = { socket: Socket; events: Array<Record<string, unknown>>; send: (command: object) => void };

async function withChild(
  body: (open: () => Promise<Client>, dir: string) => Promise<void>,
  env: Record<string, string> = {},
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'headless-boot-replay-'));
  const sockets: Socket[] = [];
  const child = spawn(process.execPath, [new URL('./mock-headless-boot-child.ts', import.meta.url).pathname], {
    env: { ...process.env, ...env, DATA_DIR: dir }, stdio: 'ignore',
  });
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const open = async (): Promise<Client> => {
    const socket = await connectWhenAccepting(join(dir, 'ipc.sock'), { allowHalfOpen: false });
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
    socket.on('error', () => { /* closed by the child when superseded */ });
    await until(() => events.some(event => event.type === 'lifecycle' && event.phase === 'ready'), 'ready');
    return { socket, events, send: (command: object) => { socket.write(JSON.stringify(command) + '\n'); } };
  };
  try {
    await until(() => existsSync(join(dir, 'ipc.sock')), 'socket');
    await body(open, dir);
  } finally {
    for (const socket of sockets) socket.destroy();
    if (!exited()) child.kill('SIGTERM');
    try { await until(exited, 'child shutdown'); }
    catch { child.kill('SIGKILL'); await until(exited, 'child forced shutdown'); }
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the first client hears the boot after ready, marked and in order; the next client does not', async () => {
  await withChild(async (open, dir) => {
    const first = await open();
    await until(() => first.events.filter(event => event.replay === true).length >= 3, 'boot replay');
    await until(() => first.events.some(event => event.type === 'lifecycle' && event.phase === 'replay-truncated'), 'truncation line');
    const types = first.events.map(event => `${event.type}${event.replay === true ? '*' : ''}`);
    expect(types.slice(0, 5)).toEqual(['lifecycle', 'dendrite:agent-created*', 'dendrite:agent-created*', 'dendrite:agent-ended*', 'lifecycle']);
    expect(first.events[4]).toMatchObject({ type: 'lifecycle', phase: 'replay-truncated', dropped: 2, kept: 3 });
    const replayed = first.events.filter(event => event.replay === true);
    // The events' own timestamps travel; `ts` is the send time, as for every event.
    expect(replayed.map(event => event.timestamp)).toEqual([1_700_000_000_001, 1_700_000_000_002, 1_700_000_000_003]);
    expect(replayed.every(event => typeof event.ts === 'number')).toBe(true);
    expect(replayed[1]!.agentName).toBe('fixture.reader-7');

    // The tree folded the boot: the fork the boot announced hangs under its source.
    first.send({ type: 'describe', corrId: 'd1' });
    await until(() => first.events.some(event => event.type === 'snapshot'), 'snapshot');
    const snapshot = first.events.find(event => event.type === 'snapshot') as { tree: { nodes: Array<Record<string, unknown>> } };
    const fork = snapshot.tree.nodes.find(node => node.name === 'fixture.reader-7');
    expect(fork?.parent).toBe('fixture');
    expect(fork?.kind).toBe('framework');
    expect(fork?.subagentType).toBeUndefined();
    expect(fork?.status).toBe('cancelled');

    // A live trace after the handover reaches the client unmarked.
    writeFileSync(join(dir, 'live'), '');
    await until(() => first.events.some(event => event.type === 'inference:started'), 'live trace');
    const liveTrace = first.events.find(event => event.type === 'inference:started')!;
    expect(liveTrace.replay).toBeUndefined();
    expect(liveTrace.timestamp).toBe(1_700_000_000_010);

    const second = await open();
    second.send({ type: 'describe', corrId: 'fence' });
    await until(() => second.events.some(event => event.type === 'snapshot' && event.corrId === 'fence'), 'the second client\'s snapshot');
    expect(second.events.some(event => event.replay === true)).toBe(false);
    expect(second.events[0]).toMatchObject({ type: 'lifecycle', phase: 'ready' });
  });
});

test('after a session switch, what the new framework replays from its create() reaches the connected client unmarked, and the tree folds it', async () => {
  await withChild(async (open, dir) => {
    const client = await open();
    await until(() => client.events.some(event => event.type === 'lifecycle' && event.phase === 'replay-truncated'), 'boot replay');
    writeFileSync(join(dir, 'switch'), '');
    await until(() => client.events.some(event => event.type === 'dendrite:agent-ended' && event.agentName === 'fixture.reader-9'), 'the switched-to session\'s replay');
    const restored = client.events.find(event => event.agentName === 'fixture.reader-9')!;
    expect(restored.replay).toBeUndefined();
    expect(restored.timestamp).toBe(1_700_000_000_020);
    writeFileSync(join(dir, 'live'), '');
    client.send({ type: 'describe', corrId: 'd2' });
    await until(() => client.events.some(event => event.type === 'snapshot'), 'snapshot');
    const snapshot = client.events.find(event => event.type === 'snapshot') as { tree: { nodes: Array<Record<string, unknown>> } };
    expect(snapshot.tree.nodes.find(node => node.name === 'fixture.reader-9')).toMatchObject({ status: 'cancelled' });
    expect(client.events.filter(event => event.agentName === 'fixture.reader-9')).toHaveLength(1);
    await until(() => existsSync(join(dir, 'live-emitted')), 'the replaced framework\'s trace');
    client.send({ type: 'describe', corrId: 'd3' });
    await until(() => client.events.some(event => event.type === 'snapshot' && event.corrId === 'd3'), 'a later snapshot');
    expect(client.events.some(event => event.type === 'inference:started')).toBe(false);
  });
});

test('a session switch before any client connects leaves the first client the new session\'s boot, with its own count of what its replay didn\'t keep', async () => {
  await withChild(async (open, dir) => {
    writeFileSync(join(dir, 'switch'), '');
    await until(() => existsSync(join(dir, 'switched')), 'the switch');
    const client = await open();
    await until(() => client.events.some(event => event.type === 'lifecycle' && event.phase === 'replay-truncated'), 'truncation line');
    expect(client.events.filter(event => event.replay === true).map(event => event.agentName)).toEqual(['fixture.reader-9']);
    expect(client.events.find(event => event.phase === 'replay-truncated')).toMatchObject({ dropped: 250, kept: 1 });
  });
});

test('a turn the framework ran and finished at boot, before the socket listened, ends in an idle the first client meets: ready says idle, or lifecycle:idle follows it', async () => {
  await withChild(async (open, dir) => {
    const client = await open();
    const ready = client.events.find(event => event.type === 'lifecycle' && event.phase === 'ready')!;
    expect(ready.turnWork).toBe(false);
    await until(() => ready.idle === true || client.events.some(event => event.type === 'lifecycle' && event.phase === 'idle'), 'an idle after the boot turn');
    const idle = ready.idle === true ? ready : client.events.find(event => event.type === 'lifecycle' && event.phase === 'idle')!;
    expect(Number(idle.ts) - Number(readFileSync(join(dir, 'handed-over'), 'utf8'))).toBeGreaterThanOrEqual(500);
  }, { FIXTURE_BOOT_TURN: 'over' });
});

const lifecycle = (events: Array<Record<string, unknown>>, phase: string): number =>
  events.findIndex(event => event.type === 'lifecycle' && event.phase === phase);

test('a turn the framework ran at boot after the boot hold was full still ends in an idle the first client meets, 500 ms after the handover, with turn-work-done before a live idle', async () => {
  await withChild(async (open, dir) => {
    const client = await open();
    const ready = client.events.find(event => event.type === 'lifecycle' && event.phase === 'ready')!;
    await until(() => ready.idle === true || lifecycle(client.events, 'idle') >= 0, 'an idle after the boot turn');
    const idle = ready.idle === true ? ready : client.events[lifecycle(client.events, 'idle')]!;
    expect(Number(idle.ts) - Number(readFileSync(join(dir, 'handed-over'), 'utf8'))).toBeGreaterThanOrEqual(500);
    if (ready.idle !== true) {
      const done = lifecycle(client.events, 'turn-work-done');
      expect(done).toBeGreaterThanOrEqual(0);
      expect(done).toBeLessThan(lifecycle(client.events, 'idle'));
    }
  }, { FIXTURE_BOOT_TURN: 'overflowed' });
});

test('a primary\'s turn whose start the full boot hold dropped says only its own words: the speech gathered before it doesn\'t carry over', async () => {
  await withChild(async (open, dir) => {
    const client = await open();
    await until(() => client.events.some(event => event.type === 'lifecycle' && event.phase === 'ready'), 'ready');
    writeFileSync(join(dir, 'live'), '');
    await until(() => client.events.some(event => event.type === 'inference:speech'), 'the turn\'s speech');
    expect(client.events.filter(event => event.type === 'inference:speech').map(event => event.content)).toEqual(['NEW']);
  }, { FIXTURE_BOOT_TURN: 'overflowed-speech' });
});

test('a subagent\'s turn the framework ran at boot after the boot hold was full ends in an idle with no turn-work-done before it', async () => {
  await withChild(async (open) => {
    const client = await open();
    const ready = client.events.find(event => event.type === 'lifecycle' && event.phase === 'ready')!;
    await until(() => ready.idle === true || lifecycle(client.events, 'idle') >= 0, 'an idle after the boot turn');
    expect(lifecycle(client.events, 'turn-work-done')).toBe(-1);
  }, { FIXTURE_BOOT_TURN: 'overflowed-subagent' });
});

test('a turn the framework began at boot and still runs when the first client connects: ready says turn work and not idle, and lifecycle:idle comes once the turn has been over for 500 ms', async () => {
  await withChild(async (open, dir) => {
    const client = await open();
    const ready = client.events.find(event => event.type === 'lifecycle' && event.phase === 'ready')!;
    expect({ turnWork: ready.turnWork, idle: ready.idle }).toEqual({ turnWork: true, idle: false });
    writeFileSync(join(dir, 'turn-end'), '');
    await until(() => client.events.some(event => event.type === 'lifecycle' && event.phase === 'idle'), 'an idle after the boot turn');
    const idle = client.events.find(event => event.type === 'lifecycle' && event.phase === 'idle')!;
    expect(Number(idle.ts) - Number(readFileSync(join(dir, 'turn-ended'), 'utf8'))).toBeGreaterThanOrEqual(500);
  }, { FIXTURE_BOOT_TURN: 'running' });
});

const BOOT_TURN_EXTENSION = `
export function register(api) {
  api.registerModule(() => ({
    name: 'boot-turn',
    getTools() { return []; },
    setFramework(framework) {
      framework.pushEvent({ type: 'external-message', source: 'cli', content: 'boot', metadata: {}, triggerInference: true });
    },
    async start() {},
    async stop() {},
    async handleToolCall() { return { success: false, error: 'no tools' }; },
    async onProcess() { return {}; },
  }));
}
`;

test('on the real host, a turn the framework runs as it starts ends in an idle the first client meets', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'headless-boot-turn-')));
  writeFileSync(join(dir, 'boot-turn.ts'), BOOT_TURN_EXTENSION);
  writeFileSync(join(dir, 'recipe.json'), JSON.stringify({
    name: 'Boot turn',
    agent: { name: 'agent', provider: 'mock', systemPrompt: 'boot turn test', mock: { echoMode: true } },
    modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
    extensions: { bootTurn: { kind: 'module', path: join(dir, 'boot-turn.ts') } },
  }));
  const host = spawn(process.execPath, [join(import.meta.dir, '..', 'src', 'index.ts'), join(dir, 'recipe.json'), '--headless'], {
    cwd: dir, env: { ...process.env, DATA_DIR: dir }, stdio: 'ignore',
  });
  const closed = new Promise((resolve) => host.once('close', resolve));
  const waitUntil = async (check: () => boolean, label: string): Promise<void> => {
    const deadline = Date.now() + 30_000;
    while (!check()) {
      if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
      await Bun.sleep(25);
    }
  };
  try {
    await waitUntil(() => existsSync(join(dir, 'ipc.sock')), 'the socket');
    const socket = await connectWhenAccepting(join(dir, 'ipc.sock'), { allowHalfOpen: false });
    const events: Array<Record<string, unknown>> = [];
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        events.push(JSON.parse(buffer.slice(0, at)));
        buffer = buffer.slice(at + 1);
      }
    });
    socket.on('error', () => {});
    await waitUntil(() => events.some(event => event.type === 'lifecycle' && event.phase === 'ready'), 'ready');
    const ready = events.find(event => event.type === 'lifecycle' && event.phase === 'ready')!;
    await waitUntil(() => ready.idle === true || events.some(event => event.type === 'lifecycle' && event.phase === 'idle'), 'an idle after the boot turn');
    await waitUntil(() => events.some(event => event.type === 'inference:started' && event.replay === true), 'the boot turn\'s start, replayed');
    socket.destroy();
  } finally {
    host.kill('SIGTERM');
    await closed;
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
