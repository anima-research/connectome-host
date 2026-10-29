import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModuleContext } from '@animalabs/agent-framework';
import {
  WebUiModule,
  __getSharedServerPortForTests,
  stopWebUiServer,
} from '../src/modules/web-ui-module.js';

const USER = 'admin';
const PASS = 'open-sesame';
let dir: string;
let webUiModule: WebUiModule;
let port: number;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'webui-switch-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>t</title>');
  webUiModule = new WebUiModule({ port: 0, host: '127.0.0.1', basicAuth: { username: USER, password: PASS }, staticDir: dir });
  await webUiModule.start({} as ModuleContext);
  const bound = __getSharedServerPortForTests();
  if (!bound) throw new Error('webui server not bound');
  port = bound;
});

afterAll(async () => {
  await webUiModule.stop();
  await stopWebUiServer();
  rmSync(dir, { recursive: true, force: true });
});

const refusal = (what: string) =>
  `${what} refused: a session switch is under way. Nothing changed; try again once the switch has finished.`;

type Reply = Record<string, unknown> & { type: string; corrId?: string };

function hostApp(framework: Record<string, unknown>, switching: boolean, switched: string[] = []) {
  const sessions = [{ id: 's1', name: 'first', manuallyNamed: true }, { id: 's2', name: 'second', manuallyNamed: true }];
  const cm = { getAllMessages: () => [], currentBranch: () => ({ id: 'b1', name: 'main' }) };
  const agent = { name: 'main', model: 'test-model', state: { status: 'idle' }, getContextManager: () => cm };
  return {
    framework: {
      getAllAgents: () => [agent],
      getAgent: () => agent,
      getAllModules: () => [],
      getModule: () => undefined,
      getSessionUsage: () => { throw new Error('no usage in this harness'); },
      onTrace: () => () => {},
      getHostModeStatus: () => ({ quiesced: false }),
      ...framework,
    },
    sessionManager: {
      getActiveSession: () => sessions[0],
      findSession: (nameOrId: string) => sessions.find((s) => s.id === nameOrId || s.name === nameOrId),
    },
    recipe: { name: 'test', agent: { name: 'main' } },
    branchState: { checkpoints: new Map(), undoStack: [], redoStack: [] },
    switchSession: async (id: string) => { switched.push(id); },
    switching,
  };
}

const GIVE_UP_MS = 10_000;
const TEST_MS = 30_000;

async function connect(): Promise<{ send: (msg: object) => void; next: (what: string, match: (r: Reply) => boolean) => Promise<Reply>; close: () => void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: {
      origin: `http://127.0.0.1:${port}`,
      authorization: `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`,
    },
  } as unknown as undefined);
  const seen: Reply[] = [];
  const waiting: Array<{ match: (r: Reply) => boolean; resolve: (r: Reply) => void; timer: ReturnType<typeof setTimeout> }> = [];
  ws.addEventListener('message', (ev) => {
    const reply = JSON.parse(String(ev.data)) as Reply;
    const i = waiting.findIndex((w) => w.match(reply));
    if (i < 0) {
      seen.push(reply);
      return;
    }
    const [w] = waiting.splice(i, 1);
    clearTimeout(w.timer);
    w.resolve(reply);
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', (e) => reject(e as unknown as Error));
  });
  return {
    send: (msg) => ws.send(JSON.stringify(msg)),
    next: (what, match) => {
      const i = seen.findIndex(match);
      if (i >= 0) return Promise.resolve(seen.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const at = waiting.findIndex((w) => w.timer === timer);
          if (at >= 0) waiting.splice(at, 1);
          reject(new Error(`no ${what} came within ${GIVE_UP_MS} ms; what came instead: ${JSON.stringify(seen)}`));
        }, GIVE_UP_MS);
        waiting.push({ match, resolve, timer });
      });
    },
    close: () => ws.close(),
  };
}

describe("the web UI's own entry during a session switch", () => {
  test("a rollback is refused in its own reply form while the server holds the switching app, gets the not-ready answer once the old module has stopped, and reaches no framework", async () => {
    const rollbacks: unknown[] = [];
    const app = hostApp({ rollbackToMessage: async (...args: unknown[]) => { rollbacks.push(args); return {}; } }, true);
    webUiModule.setApp(app as never);
    const client = await connect();
    try {
      client.send({ type: 'rollback', corrId: 'before-stop', messageId: 'm1' });
      expect(await client.next('surgery-result for the rollback before the stop', (r) => r.corrId === 'before-stop')).toEqual({
        type: 'surgery-result', corrId: 'before-stop', op: 'rollback', ok: false, error: refusal('rollback'),
      });

      await webUiModule.stop();
      client.send({ type: 'rollback', corrId: 'after-stop', messageId: 'm1' });
      expect(await client.next('the not-ready error after the stop', (r) => r.type === 'error')).toEqual({ type: 'error', message: 'host not ready' });
      expect(rollbacks).toEqual([]);
    } finally {
      client.close();
    }
  }, TEST_MS);

  test('a refused host-quiesce is answered with its error, then the host mode, which releases the toggle', async () => {
    webUiModule.setApp(hostApp({}, true) as never);
    const client = await connect();
    try {
      client.send({ type: 'host-quiesce', corrId: 'quiesce' });
      expect(await client.next('the refusal error', (r) => r.corrId === 'quiesce')).toEqual({ type: 'error', corrId: 'quiesce', message: refusal('host-quiesce') });
      expect((await client.next('a host-mode after the refusal', (r) => r.type === 'host-mode')).hostMode).toMatchObject({ mode: 'serving' });
    } finally {
      client.close();
    }
  }, TEST_MS);

  test('a rollback still running holds off /session switch, naming it, and the switch starts once it has finished', async () => {
    let finish = () => {};
    const held = new Promise<void>((resolve) => { finish = resolve; });
    let reached = () => {};
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    const rollbackToMessage = async () => {
      reached();
      await held;
      return { sourceBranch: 'main', targetBranch: 'b2', messagesRemoved: 1, lastVisible: null };
    };
    const switched: string[] = [];
    webUiModule.setApp(hostApp({ rollbackToMessage }, false, switched) as never);
    const client = await connect();
    try {
      client.send({ type: 'rollback', corrId: 'held', messageId: 'm1' });
      const early = client.next("the held rollback's surgery-result", (r) => r.corrId === 'held');
      expect(await Promise.race([entered.then(() => 'reached'), early.then((r) => JSON.stringify(r))])).toBe('reached');
      client.send({ type: 'command', command: '/session switch second', corrId: 'too-soon' });
      expect((await client.next("the early /session switch's answer", (r) => r.corrId === 'too-soon')).lines).toEqual([
        { text: "rollback is still running, so the switch isn't started; try again once it has finished.", style: 'system' },
      ]);
      expect(switched).toEqual([]);

      finish();
      expect((await early).ok).toBe(true);
      client.send({ type: 'command', command: '/session switch second', corrId: 'now' });
      expect((await client.next("the later /session switch's answer", (r) => r.corrId === 'now')).switchToSessionId).toBe('s2');
      expect(switched).toEqual(['s2']);
    } finally {
      client.close();
    }
  }, TEST_MS);
});
