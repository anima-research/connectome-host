/**
 * Who gave a command, in the framework's operator log (#485 bot review 6,
 * finding 4). The Web UI's command box names its basic-auth user, as the
 * surgery dialog on the same page does; a headless host's socket and a
 * fleet parent's fleet--command name themselves; the host's own console
 * (the TUI, and the readline and piped modes) is `host-console`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModuleContext } from '@animalabs/agent-framework';
import { handleCommand } from '../src/commands.js';
import { FleetModule } from '../src/modules/fleet-module.js';
import { WebUiModule, __getSharedServerPortForTests, stopWebUiServer } from '../src/modules/web-ui-module.js';
import { connectWhenAccepting } from './ipc-connect.js';
import { SurfaceAnswers } from '../src/surfaces.js';

const USER = 'admin';
const PASS = 'open-sesame';
const GIVE_UP_MS = 10_000;

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + GIVE_UP_MS;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** A host whose framework records who each operator action names, and refuses each move, so nothing moves. */
function recordingApp() {
  const asked: Array<[string, unknown]> = [];
  const refuse = (what: string) => (_target: unknown, opts: { requester?: unknown }) => {
    asked.push([what, opts.requester]);
    return Promise.reject(new Error(`${what} refused in this test`));
  };
  const cm = {
    getAllMessages: () => [],
    currentBranch: () => ({ id: 'b1', name: 'main' }),
    listBranches: () => [{ id: 'b1', name: 'main' }, { id: 'b2', name: 'side' }],
    queryMessages: () => ({ messages: [{ id: 'm1', participant: 'user', content: [] }, { id: 'm2', participant: 'main', content: [] }] }),
  };
  const agent = { name: 'main', model: 'test-model', state: { status: 'idle' }, getContextManager: () => cm };
  const app = {
    framework: {
      getAllAgents: () => [agent],
      getAgent: () => agent,
      getAllModules: () => [],
      getModule: () => undefined,
      getSessionUsage: () => { throw new Error('no usage in this harness'); },
      onTrace: () => () => {},
      getHostModeStatus: () => ({ quiesced: false }),
      getStore: () => ({ currentBranch: () => ({ name: 'main' }) }),
      undoLastTurn: (_agent: string, requester: unknown) => { asked.push(['undo', requester]); return { undone: false }; },
      redo: (_agent: string, requester: unknown) => { asked.push(['redo', requester]); return { redone: false }; },
      switchBranch: refuse('checkout'),
      rollbackToMessage: refuse('rollback'),
      nudgeAgent: (_agent: string | undefined, by: string) => { asked.push(['nudge', by]); return { ok: true, agentName: 'main', agentStatus: 'idle' }; },
    },
    frameworkSessionId: 's1',
    sessionManager: { getActiveSession: () => ({ id: 's1', name: 'first' }), findSession: () => undefined },
    recipe: { name: 'test', agent: { name: 'main' } },
    branchState: { checkpoints: new Map([['cp', { branchName: 'main', messageId: 'm1' }]]) },
    switchSession: async () => {},
    switching: false,
  };
  return { app, asked };
}

const COMMANDS = ['/undo', '/redo', '/checkout side', '/branchto m1', '/restore cp', '/nudge'];
const ASKED = ['undo', 'redo', 'checkout', 'rollback', 'rollback', 'nudge'];

describe("the requester of a command's operator action", () => {
  let dir: string;
  let webUi: WebUiModule;
  let port: number;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'commands-requester-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>t</title>');
    webUi = new WebUiModule({ surfaces: new SurfaceAnswers(), port: 0, host: '127.0.0.1', basicAuth: { username: USER, password: PASS }, staticDir: dir });
    await webUi.start({} as ModuleContext);
    const bound = __getSharedServerPortForTests();
    if (!bound) throw new Error('webui server not bound');
    port = bound;
  });

  afterAll(async () => {
    await webUi.stop();
    await stopWebUiServer();
    rmSync(dir, { recursive: true, force: true });
  });

  test("is the host's console for a command given there", async () => {
    const { app, asked } = recordingApp();
    for (const command of COMMANDS) await handleCommand(command, app as never).asyncWork;
    expect(asked).toEqual(ASKED.map((what, i) => [what, i === 5 ? 'host-console' : { via: 'host-console' }]));
  });

  test("is the Web UI's basic-auth user for a command typed in its command box, as for its surgery", async () => {
    const { app, asked } = recordingApp();
    webUi.setApp(app as never);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { origin: `http://127.0.0.1:${port}`, authorization: `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}` },
    } as unknown as undefined);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener('open', () => resolve());
        ws.addEventListener('error', (e) => reject(e as unknown as Error));
      });
      for (const [i, command] of COMMANDS.entries()) {
        ws.send(JSON.stringify({ type: 'command', command, corrId: `c${i}` }));
        await until(() => asked.length > i, `${command} to reach the framework`);
      }
      expect(asked).toEqual(ASKED.map((what, i) => [what, i === 5 ? `${USER} (webui)` : { via: 'webui', name: USER }]));
    } finally {
      ws.close();
    }
  });

  test("is the headless socket for a command sent on it, and the fleet for a parent's fleet--command", async () => {
    // The parent's frame says it is the fleet's.
    const fleet = new FleetModule({});
    const frames: string[] = [];
    (fleet as unknown as { children: Map<string, object> }).children.set('kid', {
      name: 'kid', status: 'ready', socket: { write: (line: string) => { frames.push(line); return true; } },
      events: [], subscription: ['*'],
    });
    expect((await fleet.handleToolCall({ id: 'c', name: 'command', input: { name: 'kid', command: '/nudge' } })).success).toBe(true);
    expect(frames.map((line) => JSON.parse(line))).toEqual([{ type: 'command', command: '/nudge', from: 'fleet' }]);

    // The child names whichever the frame says.
    const data = mkdtempSync(join(tmpdir(), 'commands-requester-headless-'));
    const child = spawn(process.execPath, [join(import.meta.dir, 'mock-headless-command-child.ts')], {
      env: { ...process.env, DATA_DIR: data }, stdio: 'ignore',
    });
    try {
      await until(() => existsSync(join(data, 'ipc.sock')), 'the socket');
      const socket = await connectWhenAccepting(join(data, 'ipc.sock'));
      const events: Array<Record<string, unknown>> = [];
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
          if (buffer.slice(0, at).trim()) events.push(JSON.parse(buffer.slice(0, at)));
          buffer = buffer.slice(at + 1);
        }
      });
      await until(() => events.some((e) => e.type === 'lifecycle' && e.phase === 'ready'), 'ready');
      const done = (corrId: string) => events.some((e) => e.type === 'command-done' && e.corrId === corrId);
      socket.write(`${JSON.stringify({ type: 'command', command: '/nudge', corrId: 'socket' })}\n`);
      await until(() => done('socket'), "the socket's command");
      socket.write(`${JSON.stringify({ type: 'command', command: '/nudge', corrId: 'parent', from: 'fleet' })}\n`);
      await until(() => done('parent'), "the parent's command");
      expect(readFileSync(join(data, 'nudged'), 'utf8')).toBe('headless\nfleet\n');
      socket.destroy();
    } finally {
      child.kill('SIGKILL');
      rmSync(data, { recursive: true, force: true });
    }
  }, 20_000);
});
