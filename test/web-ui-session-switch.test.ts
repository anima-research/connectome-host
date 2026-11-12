import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModuleContext } from '@animalabs/agent-framework';
import {
  WebUiModule,
  __getSharedServerPortForTests,
  stopWebUiServer,
  switchQuiesceRefusalFor,
} from '../src/modules/web-ui-module.js';
import { switchQuiesceReason } from '../src/update/contract.js';
import { answerSwitchRequest } from '../src/update/quiesce.js';

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

function hostApp(
  framework: Record<string, unknown>,
  switching: boolean,
  switched: string[] = [],
  { open = 's1', index = open, cm: more = {} }: { open?: string; index?: string; cm?: Record<string, unknown> } = {},
) {
  const sessions = [{ id: 's1', name: 'first', manuallyNamed: true }, { id: 's2', name: 'second', manuallyNamed: true }];
  const cm = { getAllMessages: () => [], currentBranch: () => ({ id: 'b1', name: 'main' }), ...more };
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
    frameworkSessionId: open,
    sessionManager: {
      getActiveSession: () => sessions.find((s) => s.id === index),
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
      client.send({ type: 'rollback', corrId: 'before-stop', messageId: 'm1', sessionId: 's1' });
      expect(await client.next('surgery-result for the rollback before the stop', (r) => r.corrId === 'before-stop')).toEqual({
        type: 'surgery-result', corrId: 'before-stop', op: 'rollback', ok: false, error: refusal('rollback'),
      });

      await webUiModule.stop();
      client.send({ type: 'rollback', corrId: 'after-stop', messageId: 'm1', sessionId: 's1' });
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

  test("a host-quiesce while a switch's quiesce holds the host is refused, saying so, and the switch's quiesce stays", async () => {
    const quiesces: unknown[] = [];
    let mode: { quiesced: boolean; reason?: string; drained: boolean } = { quiesced: true, reason: switchQuiesceReason('0.15.0'), drained: true };
    webUiModule.setApp(hostApp({
      getHostModeStatus: () => mode,
      quiesce: async (opts: { reason?: string }) => { quiesces.push(opts); mode = { quiesced: true, reason: opts.reason, drained: true }; return mode; },
      resume: async () => { mode = { quiesced: false, drained: true }; return mode; },
    }, false) as never);
    const client = await connect();
    try {
      client.send({ type: 'host-quiesce', corrId: 'quiesce', reason: 'maintenance' });
      const answer = await client.next('the refusal error', (r) => r.corrId === 'quiesce');
      expect(answer).toMatchObject({ type: 'error', corrId: 'quiesce' });
      expect(String(answer.message)).toStartWith('host-quiesce refused: ');
      expect(String(answer.message)).toContain('switch');
      expect(quiesces).toEqual([]);
      expect(mode).toEqual({ quiesced: true, reason: switchQuiesceReason('0.15.0'), drained: true });
    } finally {
      client.close();
    }
  }, TEST_MS);

  test("while a switch's quiesce holds the host, its own rollback, suppress, pin and settings changes are refused and change nothing, while a read and a Resume aren't, and a rollback goes once it has resumed", async () => {
    const quiescedRefusal = (what: string) => `${what} refused: this host is quiesced for a release switch. If that switch ` +
      'goes ahead, its stop can cut a change to the session off. Nothing changed; try again once that quiesce has ended.';
    const reached: string[] = [];
    let mode: { quiesced: boolean; reason?: string; drained: boolean } = { quiesced: true, reason: switchQuiesceReason('0.15.0'), drained: true };
    webUiModule.setApp(hostApp({
      getHostModeStatus: () => mode,
      rollbackToMessage: async () => { reached.push('rollback'); return { sourceBranch: 'main', targetBranch: 'b2', messagesRemoved: 1, lastVisible: null }; },
      suppressMessages: async () => { reached.push('suppress'); return {}; },
      updateAgentRuntimeSettings: () => { reached.push('settings-update'); },
      resetAgentRuntimeSettings: () => { reached.push('settings-reset'); },
      cancelAgentRuntimeSettingsTransition: () => { reached.push('settings-cancel-transition'); },
      resume: async () => { mode = { quiesced: false, drained: true }; return mode; },
    }, false, [], {
      cm: {
        pinRange: () => { reached.push('pin-add'); return 'pin-1'; },
        unpin: () => { reached.push('pin-remove'); return true; },
        listPins: () => [],
      },
    }) as never);
    const client = await connect();
    try {
      for (const op of ['rollback', 'suppress'] as const) {
        client.send({ type: op, corrId: op, messageId: 'm1', ...(op === 'suppress' ? { messageIds: ['m1'] } : {}), sessionId: 's1' });
        expect(await client.next(`the ${op} refusal`, (r) => r.corrId === op)).toEqual({
          type: 'surgery-result', corrId: op, op, ok: false, error: quiescedRefusal(op),
        });
      }
      const fields: Record<string, Record<string, unknown>> = {
        'pin-add': { firstMessageId: 'm1' }, 'pin-remove': { pinId: 'pin-0' }, 'settings-update': { tailTokens: 4000 },
      };
      for (const op of ['pin-add', 'pin-remove', 'settings-update', 'settings-reset', 'settings-cancel-transition']) {
        client.send({ type: op, ...fields[op], sessionId: 's1' });
        expect(await client.next(`the ${op} refusal`, (r) => r.type === 'error' && String(r.message).startsWith(`${op} refused`))).toEqual({
          type: 'error', message: quiescedRefusal(op),
        });
      }
      expect(reached).toEqual([]);
      client.send({ type: 'request-host-mode' });
      expect((await client.next('the host mode, a read', (r) => r.type === 'host-mode')).hostMode).toMatchObject({ mode: 'quiesced' });
      client.send({ type: 'host-resume', corrId: 'resume' });
      await client.next('the host mode after Resume', (r) => r.type === 'host-mode' && (r.hostMode as { mode?: string }).mode === 'serving');
      expect(mode.quiesced).toBe(false);
      client.send({ type: 'rollback', corrId: 'after', messageId: 'm1', sessionId: 's1' });
      expect(await client.next('the rollback after Resume', (r) => r.corrId === 'after')).toMatchObject({ type: 'surgery-result', ok: true });
      expect(reached).toContain('rollback');
    } finally {
      client.close();
    }
  }, TEST_MS);

  test("a Resume from the page while this host holds for a switch's last look is refused with the hold's words, the page reads the host mode again, and the host stays quiesced", async () => {
    const HOLDING = "the release switch's last look has begun here, so nothing here changes until the install's host decides it. " +
      "If it calls the switch off, Resume works here again; if the switch goes ahead, this host stops. Where the install's host " +
      "can't reach this host, stopping the install's host or restarting this one ends the wait.";
    let mode: { quiesced: boolean; reason?: string; drained: boolean } = { quiesced: true, reason: switchQuiesceReason('0.15.0'), drained: true };
    const resumed: string[] = [];
    const app = hostApp({
      getHostModeStatus: () => mode,
      resume: async () => { resumed.push('resume'); mode = { quiesced: false, drained: true }; return mode; },
    }, false);
    const { gateResume } = await import('../src/update/resume-gate.js');
    gateResume(app.framework as never);
    webUiModule.setApp(app as never);
    const look = { op: 'quiesce', to: '0.15.0', waitMs: 0, last: { look: 'look-1', mark: join(dir, 'mark.json'), parent: process.pid } };
    expect(await answerSwitchRequest(app.framework as never, look)).toMatchObject({ held: true });
    const client = await connect();
    try {
      client.send({ type: 'host-resume', corrId: 'held' });
      expect(await client.next('the refusal', (r) => r.corrId === 'held')).toEqual({ type: 'error', corrId: 'held', message: `resume failed: ${HOLDING}` });
      expect((await client.next('the host mode after the refusal', (r) => r.type === 'host-mode')).hostMode).toMatchObject({ mode: 'quiesced' });
      expect(resumed).toEqual([]);
      expect(mode.quiesced).toBe(true);
    } finally {
      client.close();
      await answerSwitchRequest(app.framework as never, { op: 'release', look: 'look-1' });
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
      client.send({ type: 'rollback', corrId: 'held', messageId: 'm1', sessionId: 's1' });
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

function recorder() {
  const reached: string[] = [];
  const waiting: Array<{ entry: string; resolve: () => void }> = [];
  const record = (entry: string): void => {
    reached.push(entry);
    for (const w of waiting.filter((w) => w.entry === entry)) w.resolve();
  };
  const when = (entry: string): Promise<void> => reached.includes(entry)
    ? Promise.resolve()
    : new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${entry} didn't reach the session within ${GIVE_UP_MS} ms; what did: ${JSON.stringify(reached)}`)), GIVE_UP_MS);
      waiting.push({ entry, resolve: () => { clearTimeout(timer); resolve(); } });
    });
  return { reached, record, when };
}

describe('a change chosen in one session, sent once another is open', () => {
  const other = (what: string) =>
    `${what} refused: it was chosen in session "first" [s1], and session "second" [s2] is open now. Nothing changed; choose again in session "second" [s2].`;

  function recordingApp({ record: push }: ReturnType<typeof recorder>, sessions: { open?: string; index?: string } = { open: 's2' }) {
    const framework = {
      rollbackToMessage: async (_agent: string, opts: { messageId: string }) => {
        push(`rollback ${opts.messageId}`);
        return { sourceBranch: 'main', targetBranch: 'b2', messagesRemoved: 1, lastVisible: null };
      },
      suppressMessages: async (_agent: string, opts: { messageIds: string[] }) => {
        push(`suppress ${opts.messageIds.join(',')}`);
        return { sourceBranch: 'main', targetBranch: 'b3', messagesRemoved: 1 };
      },
      updateAgentRuntimeSettings: () => { push('settings-update'); },
      resetAgentRuntimeSettings: () => { push('settings-reset'); },
      cancelAgentRuntimeSettingsTransition: () => { push('settings-cancel-transition'); },
      getAllModules: () => [{ name: 'subagent', cancelSubagent: (name: string) => { push(`cancel-subagent ${name}`); return true; } }],
    };
    const cm = {
      pinRange: (first: string) => { push(`pin-add ${first}`); return 'pin-1'; },
      markDocument: (first: string) => { push(`document ${first}`); return 'pin-1'; },
      unpin: (id: string) => { push(`pin-remove ${id}`); return true; },
      listPins: () => [],
    };
    return hostApp(framework, false, [], { ...sessions, cm });
  }

  type Change = [Record<string, unknown>, (r: Reply) => boolean, (text: string) => Reply, string];
  const changes: Change[] = [
    [
      { type: 'rollback', corrId: 'rb', messageId: 'm1' },
      (r) => r.corrId === 'rb',
      (error) => ({ type: 'surgery-result', corrId: 'rb', op: 'rollback', ok: false, error }),
      'rollback',
    ],
    [
      { type: 'suppress', corrId: 'sp', messageIds: ['m1'] },
      (r) => r.corrId === 'sp',
      (error) => ({ type: 'surgery-result', corrId: 'sp', op: 'suppress', ok: false, error }),
      'suppress',
    ],
    ...(['pin-add', 'pin-remove', 'settings-update', 'settings-reset', 'settings-cancel-transition'] as const).map(
      (type): Change => [
        { type, ...{ 'pin-add': { firstMessageId: 'm1' }, 'pin-remove': { pinId: 'pin-0' }, 'settings-update': { tailTokens: 4000 } }[type as string] },
        (r) => r.type === 'error' && String(r.message).startsWith(type),
        (message) => ({ type: 'error', message }),
        type,
      ],
    ),
    [
      { type: 'cancel-subagent', name: 'helper' },
      (r) => r.type === 'command-result',
      (text) => ({ type: 'command-result', lines: [{ text, style: 'tool' }] }),
      'cancel-subagent helper',
    ],
  ];

  for (const [change, isAnswer, refusal, what] of changes) {
    test(`${change.type} chosen in the session before a switch is refused in its own reply form, and reaches nothing of the open session`, async () => {
      const rec = recorder();
      webUiModule.setApp(recordingApp(rec) as never);
      const client = await connect();
      try {
        client.send({ ...change, sessionId: 's1' });
        const answer = await client.next(`the stale ${change.type}'s answer`, (r) => isAnswer(r) || r.type === 'pins-list' || r.type === 'settings-state');
        expect(rec.reached).toEqual([]);
        expect(answer).toEqual(refusal(other(what)));
      } finally {
        client.close();
      }
    }, TEST_MS);
  }

  const reaches: Record<string, string> = {
    rollback: 'rollback m1',
    suppress: 'suppress m1',
    'pin-add': 'pin-add m1',
    'pin-remove': 'pin-remove pin-0',
    'settings-update': 'settings-update',
    'settings-reset': 'settings-reset',
    'settings-cancel-transition': 'settings-cancel-transition',
    'cancel-subagent': 'cancel-subagent helper',
  };

  for (const [change] of changes) {
    test(`${change.type} chosen in the open session reaches it`, async () => {
      const rec = recorder();
      webUiModule.setApp(recordingApp(rec) as never);
      const client = await connect();
      try {
        client.send({ ...change, sessionId: 's2' });
        await rec.when(reaches[change.type as string]);
        expect(rec.reached).toEqual([reaches[change.type as string]]);
      } finally {
        client.close();
      }
    }, TEST_MS);
  }

  const chosenInTheIndexes = (what: string) =>
    `${what} refused: it was chosen in session "second" [s2], and session "first" [s1] is open now. Nothing changed; choose again in session "first" [s1].`;

  for (const [change, isAnswer, refusal, what] of changes) {
    test(`${change.type} is checked against the session whose framework is open, not the one the session index names`, async () => {
      const rec = recorder();
      webUiModule.setApp(recordingApp(rec, { open: 's1', index: 's2' }) as never);
      const client = await connect();
      try {
        client.send({ ...change, sessionId: 's2' });
        const answer = await client.next(`the answer to the ${change.type} chosen in the session the index names`,
          (r) => isAnswer(r) || r.type === 'pins-list' || r.type === 'settings-state');
        expect(rec.reached).toEqual([]);
        expect(answer).toEqual(refusal(chosenInTheIndexes(what)));
        client.send({ ...change, sessionId: 's1' });
        await rec.when(reaches[change.type as string]);
        expect(rec.reached).toEqual([reaches[change.type as string]]);
      } finally {
        client.close();
      }
    }, TEST_MS);
  }

  test("the pins list a change sends afterwards carries the session whose framework made the change", async () => {
    const rec = recorder();
    webUiModule.setApp(recordingApp(rec, { open: 's1', index: 's2' }) as never);
    const client = await connect();
    try {
      await client.next('the welcome', (r) => r.type === 'welcome');
      client.send({ type: 'pin-remove', pinId: 'pin-0', sessionId: 's1' });
      await rec.when('pin-remove pin-0');
      expect((await client.next('the pins list after the removal', (r) => r.type === 'pins-list')).sessionId).toBe('s1');
    } finally {
      client.close();
    }
  }, TEST_MS);

  test("a change that doesn't say which session it was chosen in is refused as malformed and reaches nothing", async () => {
    const rec = recorder();
    webUiModule.setApp(recordingApp(rec) as never);
    const client = await connect();
    try {
      client.send({ type: 'rollback', corrId: 'unstamped', messageId: 'm1' });
      expect(await client.next('the malformed answer', (r) => r.type === 'error')).toEqual({ type: 'error', message: 'unknown message shape' });
      expect(rec.reached).toEqual([]);
    } finally {
      client.close();
    }
  }, TEST_MS);
});

describe('what the page chooses a change from says whose session it is', () => {
  function servingApp() {
    const cm = {
      listPins: () => [{ id: 'pin-0', firstMessageId: 'm1', lastMessageId: 'm1', kind: 'pin', created: 1 }],
      getMessageCount: () => 0,
      getMessageWindow: () => ({ messages: [], startIndex: 0, totalCount: 0 }),
    };
    const framework = {
      getAgentRuntimeSettings: () => ({ contextBudgetTokens: 100_000 }),
      previewActivation: async () => ({ messages: [] }),
      getRequestToolPresentation: () => null,
    };
    return hostApp(framework, false, [], { open: 's1', index: 's2', cm });
  }

  test("the welcome, a history page, the pins list and the settings state each carry the session whose framework answered, even while the session index names another", async () => {
    webUiModule.setApp(servingApp() as never);
    const client = await connect();
    try {
      const welcome = await client.next('the welcome', (r) => r.type === 'welcome');
      expect((welcome.session as { id: string }).id).toBe('s1');
      client.send({ type: 'request-history', corrId: 'h1', beforeIndex: 0 });
      expect((await client.next('the history page', (r) => r.type === 'history-page')).sessionId).toBe('s1');
      client.send({ type: 'request-pins' });
      expect((await client.next('the pins list', (r) => r.type === 'pins-list')).sessionId).toBe('s1');
      client.send({ type: 'request-settings' });
      expect((await client.next('the settings state', (r) => r.type === 'settings-state')).sessionId).toBe('s1');
    } finally {
      client.close();
    }
  }, TEST_MS);

  test('a read carrying a stray sessionId is answered as one without it', async () => {
    webUiModule.setApp(servingApp() as never);
    const client = await connect();
    try {
      client.send({ type: 'request-pins' });
      const plain = await client.next('the pins list', (r) => r.type === 'pins-list' || r.type === 'error');
      client.send({ type: 'request-pins', sessionId: 's9' });
      const stray = await client.next('the pins list', (r) => r.type === 'pins-list' || r.type === 'error');
      expect(plain.type).toBe('pins-list');
      expect(stray).toEqual(plain);
      expect(stray.sessionId).toBe('s1');
    } finally {
      client.close();
    }
  }, TEST_MS);

  test("the welcome still comes, naming the session by its id, when the session index has no entry for the open framework's session, can't be read, or finds another session for its id", async () => {
    const missing = hostApp({}, false, [], { open: 's3', index: 's2' });
    const unreadable = { ...missing, sessionManager: { ...missing.sessionManager, findSession: () => { throw new Error('sessions.json is truncated'); } } };
    const another = { ...missing, sessionManager: { ...missing.sessionManager, findSession: () => ({ id: 's2', name: 's3', manuallyNamed: true }) } };
    for (const app of [missing, unreadable, another]) {
      webUiModule.setApp(app as never);
      const client = await connect();
      try {
        expect((await client.next('the welcome', (r) => r.type === 'welcome')).session).toEqual({ id: 's3', name: 's3', autoNamed: true });
      } finally {
        client.close();
      }
    }
  }, TEST_MS);

  test('the context the Context view shows carries the session whose framework built it', async () => {
    webUiModule.setApp(servingApp() as never);
    const res = await fetch(`http://127.0.0.1:${port}/debug/context`, {
      headers: { authorization: `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}` },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { sessionId?: string }).sessionId).toBe('s1');
  }, TEST_MS);
});

test("a host-quiesce over a switch's quiesce that no switch is still running is refused, saying the quiesce was left behind and that Resume ends it", () => {
  const app = { framework: { getHostModeStatus: () => ({ quiesced: true, reason: switchQuiesceReason('0.15.0') }) } };
  const answer = switchQuiesceRefusalFor(app, { type: 'host-quiesce', corrId: 'quiesce', reason: 'maintenance' } as never, false);
  expect(answer).toMatchObject({ type: 'error', corrId: 'quiesce' });
  const message = String((answer as { message?: unknown }).message);
  expect(message).toStartWith('host-quiesce refused: ');
  expect(message).toContain('a switch that isn\'t going ahead');
  expect(message).toContain('Resume ends the switch\'s quiesce');
  expect(message).not.toContain('once the switch has gone ahead or ended');
});

test("a host-quiesce over a switch's quiesce on a host that can't tell whether the switch still runs is refused, naming the top bar's control that ends it there and what it costs", () => {
  const app = { framework: { getHostModeStatus: () => ({ quiesced: true, reason: switchQuiesceReason('0.15.0') }) } };
  const answer = switchQuiesceRefusalFor(app, { type: 'host-quiesce', corrId: 'quiesce', reason: 'maintenance' } as never, null);
  expect(answer).toMatchObject({ type: 'error', corrId: 'quiesce' });
  const message = String((answer as { message?: unknown }).message);
  expect(message).toStartWith('host-quiesce refused: ');
  expect(message).toContain('may still be under way or may have ended and left this quiesce behind');
  expect(message).toContain('clicking "⏸ quiesced" in the top bar ends it, and then quiesce again');
  expect(message).toContain("That click also ends it while the switch waits, and that try then doesn't go ahead; during " +
    "the switch's last look this host holds, and the click is refused until the switch is decided.");
  expect(message).not.toContain('while the switch is under way');
  expect(message).not.toContain('Resume');
});
