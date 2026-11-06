import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectWhenAccepting } from './ipc-connect.js';

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(10);
  }
}

async function answerToQuiesce(mode: string): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), 'headless-switch-answer-'));
  const child = spawn(process.execPath, [new URL('./mock-headless-switch-answer-child.ts', import.meta.url).pathname], {
    env: { ...process.env, DATA_DIR: dir, ANSWER_MODE: mode }, stdio: 'ignore',
  });
  try {
    await until(() => existsSync(join(dir, 'ipc.sock')), 'socket');
    const socket = await connectWhenAccepting(join(dir, 'ipc.sock'));
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
    await until(() => events.some((event) => event.type === 'lifecycle' && event.phase === 'ready'), 'ready');
    socket.write(JSON.stringify({ type: 'subscribe', events: [] }) + '\n');
    socket.write(JSON.stringify({
      type: 'update-request', corrId: 'look', request: { op: 'quiesce', to: '9.9.9', waitMs: 0 },
    }) + '\n');
    await until(() => events.some((event) => event.corrId === 'look'), 'the answer');
    socket.destroy();
    return events.find((event) => event.corrId === 'look')!;
  } finally {
    child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a fleet child with nothing in flight answers the switch\'s quiesce drained, with no work in flight beside it', async () => {
  const answer = await answerToQuiesce('quiet');
  expect(answer.ok).toBe(true);
  expect(answer.data).toMatchObject({ drained: true, activeTurnAgents: [], backgroundScripts: 0 });
  expect((answer.data as Record<string, unknown>).inFlight).toBeUndefined();
}, 20_000);

for (const [mode, named] of [
  ['credential', 'a credential action'],
  ['operator', 'an operator\'s work'],
  ['subagents', 'subagent runs'],
  ['switch-begun', 'a session switch'],
] as const) {
  test(`a fleet child with ${named} in flight says so in its answer to the switch's quiesce, beside the framework's drained`, async () => {
    const answer = await answerToQuiesce(mode);
    expect(answer.ok).toBe(true);
    expect(answer.data).toMatchObject({ drained: true, inFlight: [named] });
  }, 20_000);
}
