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

/** A headless host on a stub framework (mock-headless-switch-answer-child.ts,
 *  in the state `mode` names) asked for a switch's quiesce over its socket,
 *  after `before`, and with `last`, then for the switch's last look; its
 *  answer to the last request, as a fleet parent gets it. */
export async function answerToQuiesce(
  mode: string, before: Array<Record<string, unknown>> = [], { last = false }: { last?: boolean } = {},
): Promise<Record<string, unknown>> {
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
    for (const message of before) socket.write(JSON.stringify(message) + '\n');
    socket.write(JSON.stringify({
      type: 'update-request', corrId: 'look', request: { op: 'quiesce', to: '9.9.9', waitMs: 0 },
    }) + '\n');
    await until(() => events.some((event) => event.corrId === 'look'), 'the answer');
    if (last) {
      socket.write(JSON.stringify({
        type: 'update-request', corrId: 'last',
        request: { op: 'quiesce', to: '9.9.9', waitMs: 0, last: { look: 'look-1', mark: join(dir, 'mark.json'), parent: process.pid } },
      }) + '\n');
      await until(() => events.some((event) => event.corrId === 'last'), 'the answer to the last look');
      socket.destroy();
      return events.find((event) => event.corrId === 'last')!;
    }
    socket.destroy();
    return events.find((event) => event.corrId === 'look')!;
  } finally {
    child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}
