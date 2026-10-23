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
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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

async function withChild(body: (open: () => Promise<Client>) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'headless-boot-replay-'));
  const sockets: Socket[] = [];
  const child = spawn(process.execPath, [new URL('./mock-headless-boot-child.ts', import.meta.url).pathname], {
    env: { ...process.env, DATA_DIR: dir }, stdio: 'ignore',
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
    await body(open);
  } finally {
    for (const socket of sockets) socket.destroy();
    if (!exited()) child.kill('SIGTERM');
    try { await until(exited, 'child shutdown'); }
    catch { child.kill('SIGKILL'); await until(exited, 'child forced shutdown'); }
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the first client hears the boot after ready, marked and in order; the next client does not', async () => {
  await withChild(async (open) => {
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

    // A live trace after the handover reaches the client unmarked.
    first.send({ type: 'command', command: '/puppet live {}' });
    await until(() => first.events.some(event => event.type === 'inference:started'), 'live trace');
    const liveTrace = first.events.find(event => event.type === 'inference:started')!;
    expect(liveTrace.replay).toBeUndefined();
    expect(liveTrace.timestamp).toBe(1_700_000_000_010);

    const second = await open();
    await Bun.sleep(50);
    expect(second.events.some(event => event.replay === true)).toBe(false);
    expect(second.events[0]).toMatchObject({ type: 'lifecycle', phase: 'ready' });
  });
});
