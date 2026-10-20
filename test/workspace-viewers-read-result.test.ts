/**
 * Both file viewers show a workspace `read` result's page, whether its fields
 * come in `data` (today's shape) or in `structured`, beside the page as text
 * blocks in `data`. The web UI's viewer runs in-process; a fleet child's runs
 * in a real headless child behind its socket.
 */
import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { type Socket } from 'node:net';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebUiModule } from '../src/modules/web-ui-module.js';
import { connectWhenAccepting } from './ipc-connect.js';
import { READ_FIELDS, READ_PAGE, readResultShapes } from './workspace-read-shapes.js';

const shapes = Object.keys(readResultShapes) as Array<keyof typeof readResultShapes>;

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(10);
  }
}

describe("the web UI's file viewer", () => {
  for (const shape of shapes) {
    test(`shows the page when the read's fields are in ${shape}`, async () => {
      const viewer = new WebUiModule({ port: 0 }) as unknown as {
        workspaceMod(): Promise<unknown>;
        send(client: unknown, message: unknown): void;
        sendWorkspaceFileRead(client: unknown, path: string): Promise<void>;
      };
      const asked: unknown[] = [];
      const sent: unknown[] = [];
      viewer.workspaceMod = async () => ({
        handleToolCall: async (call: unknown) => { asked.push(call); return readResultShapes[shape]; },
      });
      viewer.send = (_client, message) => { sent.push(message); };
      await viewer.sendWorkspaceFileRead({}, READ_FIELDS.path);
      expect(asked).toHaveLength(1);
      expect(sent).toEqual([{
        type: 'workspace-file',
        scope: 'local',
        path: READ_FIELDS.path,
        totalLines: 3,
        fromLine: 1,
        toLine: 2,
        content: READ_PAGE,
        truncated: true,
      }]);
    });
  }
});

describe("a fleet child's file viewer", () => {
  for (const shape of shapes) {
    test(`answers request-workspace-file with the page when the read's fields are in ${shape}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'workspace-viewer-'));
      const child = spawn(process.execPath, [new URL('./mock-headless-workspace-child.ts', import.meta.url).pathname], {
        env: { ...process.env, DATA_DIR: dir, READ_SHAPE: shape }, stdio: 'ignore',
      });
      const exited = () => child.exitCode !== null || child.signalCode !== null;
      let socket: Socket | undefined;
      try {
        await until(() => existsSync(join(dir, 'ipc.sock')), 'socket');
        socket = await connectWhenAccepting(join(dir, 'ipc.sock'));
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
        socket.write(JSON.stringify({ type: 'request-workspace-file', path: READ_FIELDS.path, corrId: 'read-1' }) + '\n');
        await until(() => events.some((event) => event.type === 'workspace-file-snapshot'), 'snapshot');
        // The child's emit() adds the time it wrote the event.
        const { ts, ...snapshot } = events.find((event) => event.type === 'workspace-file-snapshot')!;
        expect(typeof ts).toBe('number');
        expect(snapshot).toEqual({
          type: 'workspace-file-snapshot',
          corrId: 'read-1',
          path: READ_FIELDS.path,
          totalLines: 3,
          fromLine: 1,
          toLine: 2,
          content: READ_PAGE,
          truncated: true,
        });
      } finally {
        socket?.destroy();
        if (!exited()) child.kill('SIGTERM');
        try { await until(exited, 'child shutdown'); }
        catch { child.kill('SIGKILL'); await until(exited, 'child forced shutdown'); }
        rmSync(dir, { recursive: true, force: true });
      }
    }, 20_000);
  }
});
