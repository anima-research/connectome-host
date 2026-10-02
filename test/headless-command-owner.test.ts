import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(10);
  }
}

for (const mode of ['same-client', 'replacement', 'disconnect-and-reconnect'] as const) {
  test(`pending command result belongs to its caller: ${mode}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'headless-command-owner-'));
    const sockets: Socket[] = [];
    const child = spawn(process.execPath, [new URL('./mock-headless-command-child.ts', import.meta.url).pathname], {
      env: { ...process.env, DATA_DIR: dir }, stdio: 'ignore',
    });
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    const open = async () => {
      const socket = connect(join(dir, 'ipc.sock'));
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
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      await until(() => events.some(event => event.type === 'lifecycle' && event.phase === 'ready'), 'ready');
      const send = (command: object) => socket.write(JSON.stringify(command) + '\n');
      const hasReply = (text: string) => events.some(event => event.type === 'command-output' && String(event.text).includes(text));
      send({ type: 'subscribe', events: [] });
      return { socket, events, send, hasReply };
    };
    try {
      await until(() => existsSync(join(dir, 'ipc.sock')), 'socket');
      const first = await open();
      const release = join(dir, 'release');
      const done = join(dir, 'done');
      first.send({ type: 'command', command: `/puppet delayed ${JSON.stringify({ release, done, result: 'ORIGINAL-CALLER-RESULT' })}` });
      await until(() => first.hasReply('puppet: executing delayed'), 'command started');

      let active = first;
      if (mode !== 'same-client') {
        if (mode === 'disconnect-and-reconnect') first.socket.destroy();
        active = await open();
        active.send({ type: 'command', command: '/replacement-ready' });
        await until(() => active.hasReply('/replacement-ready'), 'replacement subscribed');
      }
      writeFileSync(release, 'go');
      await until(() => existsSync(done), 'pending command settled');
      active.send({ type: 'command', command: '/after-result-barrier' });
      await until(() => active.hasReply('/after-result-barrier'), 'ordered reply after result');
      expect(active.hasReply('ORIGINAL-CALLER-RESULT')).toBe(mode === 'same-client');
      const log = () => readFileSync(join(dir, 'headless.log'), 'utf8');
      const droppedReply = 'reply dropped: command-output, requester superseded/closed';
      if (mode !== 'same-client') {
        expect(active.events.some(event => event.type === 'command-output' && String(event.text).includes('puppet fixture: delayed'))).toBe(false);
        await until(() => log().includes(droppedReply), 'dropped-reply diagnostic');
        expect(log()).not.toContain('ORIGINAL-CALLER-RESULT');
      } else {
        expect(log()).not.toContain(droppedReply);
      }
    } finally {
      for (const socket of sockets) socket.destroy();
      if (!exited()) child.kill('SIGTERM');
      try { await until(exited, 'child shutdown'); }
      catch { child.kill('SIGKILL'); await until(exited, 'child forced shutdown'); }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
}
