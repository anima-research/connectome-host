import { describe, expect, test } from 'bun:test';
import type { AgentFramework } from '@animalabs/agent-framework';
import { handleCommand } from '../src/commands.js';
import { trackOperatorWork } from '../src/session-switch.js';
import { sessionRefusalFor, switchRefusalFor } from '../src/modules/web-ui-module.js';
import { isClientMessage, type WebUiClientMessage } from '../src/web/protocol.js';

type App = Parameters<typeof handleCommand>[1];

function switchingApp(): App {
  return new Proxy({} as App, {
    get(_target, property) {
      if (property === 'switching') return true;
      throw new Error(`app.${String(property)} was read during a session switch`);
    },
    set(_target, property) {
      throw new Error(`app.${String(property)} was set during a session switch`);
    },
  });
}

function readableApp(switching: boolean): App {
  const agent = { name: 'main', maxStreamTokens: 150_000, lastStreamInputTokens: 30_000, state: { status: 'idle' } };
  const sessions = [
    { id: 's1', name: 'first', manuallyNamed: true },
    { id: 's2', name: 'second', manuallyNamed: true },
  ];
  return {
    framework: { getAllAgents: () => [agent] } as unknown as AgentFramework,
    sessionManager: {
      listSessions: () => sessions,
      getActiveSession: () => sessions[0],
    } as never,
    recipe: { name: 'test' } as never,
    branchState: { checkpoints: new Map([['before', { branchName: 'main' }]]), undoStack: [], redoStack: [] } as never,
    switchSession: async () => {},
    switching,
  };
}

const refusal = (what: string) =>
  `${what} refused: a session switch is under way. Nothing changed; try again once the switch has finished.`;

describe('a command that would change the session is refused while a session switch is under way', () => {
  for (const [command, cmd] of [
    ['/undo', 'undo'],
    ['/redo', 'redo'],
    ['/checkout main', 'checkout'],
    ['/branchto 42', 'branchto'],
    ['/newtopic a fresh start', 'newtopic'],
    ['/nudge', 'nudge'],
    ['/puppet some_tool {}', 'puppet'],
    ['/checkpoint before the move', 'checkpoint'],
    ['/restore before the move', 'restore'],
    ['/budget 50000', 'budget'],
    ['/session rename a new name', 'session rename'],
    ['/session delete second --confirm', 'session delete'],
    ['/session rm second --confirm', 'session rm'],
    ['/fleet stop child', 'fleet stop'],
    ['/fleet kill child', 'fleet kill'],
    ['/fleet restart child', 'fleet restart'],
  ] as const) {
    test(`${command} says it changed nothing, and nothing of the app is read or set`, () => {
      const result = handleCommand(command, switchingApp());
      expect(result.lines.map((line) => line.text)).toEqual([refusal(`/${cmd}`)]);
      expect(result.asyncWork).toBeUndefined();
      expect(result.switchToSessionId).toBeUndefined();
    });
  }
});

describe('while a session switch is under way, a read answers as it does without one', () => {
  const reads: Array<[string, string]> = [
    ['/checkpoint', 'Saved checkpoints: before'],
    ['/restore', '  before'],
    ['/budget', '  main: 150.0k (last: 30.0k, 20%)'],
    ['/session list', '  first [s1] *'],
    ['/help', '--- Commands ---'],
  ];
  for (const [command, shown] of reads) {
    test(`${command} shows ${JSON.stringify(shown)}`, () => {
      const during = handleCommand(command, readableApp(true));
      expect(during.lines.map((line) => line.text)).toContain(shown);
      expect(during).toEqual(handleCommand(command, readableApp(false)));
    });
  }
});

describe('a session switch is not started while a command that changes the session, given earlier, is still running', () => {
  function appWithCheckout(): { app: App; finish: () => void; entered: Promise<void>; created: string[]; moves: string[] } {
    const created: string[] = [];
    const moves: string[] = [];
    let finish = () => {};
    const switched = new Promise<void>((resolve) => { finish = resolve; });
    let enter = () => {};
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const agent = {
      name: 'main',
      state: { status: 'idle' },
      getContextManager: () => ({ listBranches: () => [{ id: 'b2', name: 'side' }] }),
    };
    const sessions = [{ id: 's1', name: 'first' }, { id: 's2', name: 'second' }];
    const app: App = {
      framework: {
        getAllAgents: () => [agent],
        getAgent: () => agent,
        getStore: () => ({ currentBranch: () => ({ name: 'main' }) }),
        switchBranch: (branch: string) => {
          moves.push(branch);
          enter();
          return switched;
        },
      } as unknown as AgentFramework,
      sessionManager: {
        findSession: (nameOrId: string) => sessions.find((s) => s.id === nameOrId || s.name === nameOrId),
        getActiveSession: () => sessions[0],
        createSession: (name?: string) => {
          created.push(name ?? '');
          return sessions[1];
        },
      } as never,
      recipe: { name: 'test' } as never,
      branchState: { checkpoints: new Map(), undoStack: [], redoStack: [] } as never,
      switchSession: async () => {},
    };
    return { app, finish, entered, created, moves };
  }

  test('/session switch and /session new name the command and start nothing until it has finished', async () => {
    const { app, finish, entered, created, moves } = appWithCheckout();
    const checkout = handleCommand('/checkout side', app);
    expect(checkout.asyncWork).toBeDefined();
    await entered;
    expect(moves).toEqual(['side']);

    for (const command of ['/session switch second', '/session new third']) {
      const refused = handleCommand(command, app);
      expect(refused.lines.map((line) => line.text)).toEqual([
        "/checkout is still running, so the switch isn't started; try again once it has finished.",
      ]);
      expect(refused.switchToSessionId).toBeUndefined();
    }
    expect(created).toEqual([]);

    finish();
    await checkout.asyncWork;
    expect(handleCommand('/session switch second', app).switchToSessionId).toBe('s2');
    expect(handleCommand('/session new third', app).switchToSessionId).toBe('s2');
    expect(created).toEqual(['third']);
  });

  test("while work is running, /session switch still answers its own usage, not-found and already-on lines", async () => {
    const { app, finish, entered } = appWithCheckout();
    const checkout = handleCommand('/checkout side', app);
    await entered;
    const said = (command: string) => handleCommand(command, app).lines.map((line) => line.text);
    expect(said('/session switch second')).toEqual([
      "/checkout is still running, so the switch isn't started; try again once it has finished.",
    ]);
    expect(said('/session switch')).toEqual(['Usage: /session switch <name or id>']);
    expect(said('/session switch nowhere')).toEqual(['Session "nowhere" not found. Use /session list.']);
    expect(said('/session switch first')).toEqual(['Already on session "first".']);
    finish();
    await checkout.asyncWork;
  });

  test('a command whose work rejects no longer holds a switch off once it has rejected', async () => {
    const sessions = [{ id: 's1', name: 'first' }, { id: 's2', name: 'second' }];
    const fleet = { name: 'fleet', handleToolCall: () => Promise.reject(new Error('the child is gone')) };
    const app: App = {
      framework: { getAllModules: () => [fleet] } as unknown as AgentFramework,
      sessionManager: {
        findSession: (nameOrId: string) => sessions.find((s) => s.id === nameOrId || s.name === nameOrId),
        getActiveSession: () => sessions[0],
      } as never,
      recipe: { name: 'test' } as never,
      branchState: { checkpoints: new Map(), undoStack: [], redoStack: [] } as never,
      switchSession: async () => {},
    };
    const stop = handleCommand('/fleet stop child', app);
    await expect(stop.asyncWork).rejects.toThrow('the child is gone');
    expect(handleCommand('/session switch second', app).switchToSessionId).toBe('s2');
  });

  test("a command that changes no session, such as /auth login, doesn't hold a switch off while its work runs", async () => {
    const sessions = [{ id: 's1', name: 'first' }, { id: 's2', name: 'second' }];
    let enter = () => {};
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const app: App = {
      ...readableApp(false),
      sessionManager: {
        findSession: (nameOrId: string) => sessions.find((s) => s.id === nameOrId || s.name === nameOrId),
        getActiveSession: () => sessions[0],
      } as never,
      credentials: { runAction: () => { enter(); return new Promise(() => {}); } } as never,
    };
    const login = handleCommand('/auth login', app);
    expect(login.asyncWork).toBeDefined();
    await entered;
    expect(handleCommand('/session switch second', app).switchToSessionId).toBe('s2');
  });
});

describe('with no session switch under way', () => {
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    test(`/${name} is an unknown command, as before`, () => {
      expect(handleCommand(`/${name}`, readableApp(false)).lines.map((line) => line.text)).toEqual([
        `Unknown command: /${name}. Type /help.`,
      ]);
    });
  }

  test('/nudge reaches the framework as before', () => {
    const calls: Array<string | undefined> = [];
    const app: App = {
      ...readableApp(false),
      framework: {
        nudgeAgent: (name: string | undefined) => {
          calls.push(name);
          return { ok: true, agentName: 'main', agentStatus: 'idle' };
        },
      } as unknown as AgentFramework,
    };
    const result = handleCommand('/nudge', app);
    expect(calls).toEqual([undefined]);
    expect(result.lines[0]?.text).toMatch(/Nudged main/);
  });
});

describe("another entry's work holds off a session switch until it settles", () => {
  function plainApp(): App {
    const sessions = [{ id: 's1', name: 'first' }, { id: 's2', name: 'second' }];
    return {
      framework: {} as unknown as AgentFramework,
      sessionManager: {
        findSession: (nameOrId: string) => sessions.find((s) => s.id === nameOrId || s.name === nameOrId),
        getActiveSession: () => sessions[0],
      } as never,
      recipe: { name: 'test' } as never,
      branchState: { checkpoints: new Map(), undoStack: [], redoStack: [] } as never,
      switchSession: async () => {},
    };
  }

  test('two works still running are named, and the switch starts once both have settled, the one that rejects included', async () => {
    const app = plainApp();
    let finishRollback = () => {};
    let failRestart = (_error: Error) => {};
    const rollback = trackOperatorWork(app, 'rollback', new Promise<void>((resolve) => { finishRollback = resolve; }));
    const restart = trackOperatorWork(app, 'restart child', new Promise<void>((_resolve, reject) => { failRestart = reject; }));

    expect(handleCommand('/session switch second', app).lines.map((line) => line.text)).toEqual([
      "rollback, restart child are still running, so the switch isn't started; try again once they have finished.",
    ]);

    finishRollback();
    await rollback;
    expect(handleCommand('/session switch second', app).lines.map((line) => line.text)).toEqual([
      "restart child is still running, so the switch isn't started; try again once it has finished.",
    ]);

    failRestart(new Error('the child is gone'));
    await expect(restart).rejects.toThrow('the child is gone');
    expect(handleCommand('/session switch second', app).switchToSessionId).toBe('s2');
  });

  test('two works of the same name each hold the switch off: one settling leaves the other holding it', async () => {
    const app = plainApp();
    let finishFirst = () => {};
    let finishSecond = () => {};
    const first = trackOperatorWork(app, 'rollback', new Promise<void>((resolve) => { finishFirst = resolve; }));
    const second = trackOperatorWork(app, 'rollback', new Promise<void>((resolve) => { finishSecond = resolve; }));
    const still = "rollback is still running, so the switch isn't started; try again once it has finished.";

    expect(handleCommand('/session switch second', app).lines.map((line) => line.text)).toEqual([still]);
    finishFirst();
    await first;
    expect(handleCommand('/session switch second', app).lines.map((line) => line.text)).toEqual([still]);
    finishSecond();
    await second;
    expect(handleCommand('/session switch second', app).switchToSessionId).toBe('s2');
  });
});

describe("the web UI's actions that change the session are refused while a session switch is under way", () => {
  const switching = { switching: true };
  const idle = { switching: false };
  const cases: Array<[WebUiClientMessage, unknown]> = [
    [
      { type: 'rollback', corrId: 'c1', messageId: 'm1' } as WebUiClientMessage,
      { type: 'surgery-result', corrId: 'c1', op: 'rollback', ok: false, error: refusal('rollback') },
    ],
    [
      { type: 'suppress', corrId: 'c2', messageIds: ['m1'] } as WebUiClientMessage,
      { type: 'surgery-result', corrId: 'c2', op: 'suppress', ok: false, error: refusal('suppress') },
    ],
    [
      { type: 'fleet-stop', name: 'child' },
      { type: 'command-result', lines: [{ text: refusal('fleet-stop child'), style: 'tool' }] },
    ],
    [
      { type: 'fleet-restart', name: 'child' },
      { type: 'command-result', lines: [{ text: refusal('fleet-restart child'), style: 'tool' }] },
    ],
    [
      { type: 'host-quiesce', corrId: 'c3' } as WebUiClientMessage,
      { type: 'error', corrId: 'c3', message: refusal('host-quiesce') },
    ],
    [
      { type: 'host-resume', corrId: 'c4' },
      { type: 'error', corrId: 'c4', message: refusal('host-resume') },
    ],
    [{ type: 'pin-add', firstMessageId: 'm1' } as WebUiClientMessage, { type: 'error', message: refusal('pin-add') }],
    [{ type: 'pin-remove', pinId: 'p1' } as WebUiClientMessage, { type: 'error', message: refusal('pin-remove') }],
    [{ type: 'settings-update', tailTokens: 4000 } as WebUiClientMessage, { type: 'error', message: refusal('settings-update') }],
    [{ type: 'settings-reset' } as WebUiClientMessage, { type: 'error', message: refusal('settings-reset') }],
    [
      { type: 'settings-cancel-transition' } as WebUiClientMessage,
      { type: 'error', message: refusal('settings-cancel-transition') },
    ],
  ];
  for (const [message, reply] of cases) {
    test(`${message.type} is answered in its own reply form, saying nothing changed`, () => {
      expect(switchRefusalFor(switching, message)).toEqual(reply as never);
      expect(switchRefusalFor(idle, message)).toBeNull();
    });
  }

  test("a pin or settings change for a fleet child isn't refused: the child's session isn't the one switching", () => {
    expect(switchRefusalFor(switching, { type: 'pin-add', scope: 'child', firstMessageId: 'm1' } as WebUiClientMessage)).toBeNull();
    expect(switchRefusalFor(switching, { type: 'settings-update', scope: 'child', tailTokens: 4000 } as WebUiClientMessage)).toBeNull();
  });

  test("reads, messages and stopping work aren't refused", () => {
    for (const message of [
      { type: 'request-pins' },
      { type: 'request-settings' },
      { type: 'request-branches' },
      { type: 'user-message', content: 'hello' },
      { type: 'route-to-child', childName: 'child', content: 'hello' },
      { type: 'interrupt' },
      { type: 'cancel-subagent', name: 'helper', sessionId: 's1' },
      { type: 'cancel-subagent', name: 'helper', childName: 'child' },
    ] as WebUiClientMessage[]) {
      expect(switchRefusalFor(switching, message)).toBeNull();
    }
  });
});

describe('a web UI change chosen in one session is never made in another', () => {
  const named = [{ id: 's1', name: 'first' }, { id: 's2', name: 'second' }];
  const sessions = (open: string) => ({
    frameworkSessionId: open,
    sessionManager: {
      findSession: (nameOrId: string) => named.find((s) => s.id === nameOrId || s.name === nameOrId) ?? null,
    },
  });
  const other = (what: string) =>
    `${what} refused: it was chosen in session "first" [s1], and session "second" [s2] is open now. Nothing changed; choose again in session "second" [s2].`;
  const changes: Array<[WebUiClientMessage, (text: string) => unknown]> = [
    [
      { type: 'rollback', corrId: 'c1', messageId: 'm1', sessionId: 's1' },
      (error) => ({ type: 'surgery-result', corrId: 'c1', op: 'rollback', ok: false, error }),
    ],
    [
      { type: 'suppress', corrId: 'c2', messageIds: ['m1'], sessionId: 's1' },
      (error) => ({ type: 'surgery-result', corrId: 'c2', op: 'suppress', ok: false, error }),
    ],
    [{ type: 'pin-add', firstMessageId: 'm1', sessionId: 's1' }, (message) => ({ type: 'error', message })],
    [{ type: 'pin-remove', pinId: 'pin-0', sessionId: 's1' }, (message) => ({ type: 'error', message })],
    [{ type: 'settings-update', tailTokens: 4000, sessionId: 's1' }, (message) => ({ type: 'error', message })],
    [{ type: 'settings-reset', sessionId: 's1' }, (message) => ({ type: 'error', message })],
    [{ type: 'settings-cancel-transition', sessionId: 's1' }, (message) => ({ type: 'error', message })],
  ];
  for (const [message, reply] of changes) {
    test(`${message.type} chosen in another session is answered in its own reply form, naming both sessions and saying nothing changed`, () => {
      expect(isClientMessage(message)).toBe(true);
      expect(sessionRefusalFor(sessions('s2'), message)).toEqual(reply(other(message.type)) as never);
      expect(sessionRefusalFor(sessions('s1'), message)).toBeNull();
    });

    const scopes = message.type === 'rollback' || message.type === 'suppress' ? [undefined] : [undefined, 'local', ''];
    test(`${message.type} that doesn't say which session it was chosen in isn't a message the server takes, at any scope meaning this process`, () => {
      const { sessionId: _chosenIn, ...unstamped } = message as WebUiClientMessage & { sessionId: string };
      for (const scope of scopes) {
        const local = scope === undefined ? unstamped : { ...unstamped, scope };
        expect(isClientMessage(local)).toBe(false);
        expect(isClientMessage({ ...local, sessionId: '' })).toBe(false);
        expect(isClientMessage({ ...local, sessionId: 's1' })).toBe(true);
      }
    });
  }

  test("a change chosen in another session is refused by ids when the session index can't be read for their names", () => {
    const message = { type: 'pin-remove', pinId: 'pin-0', sessionId: 's1' } as WebUiClientMessage;
    const unreadable = { frameworkSessionId: 's2', sessionManager: { findSession: () => { throw new Error('sessions.json is truncated'); } } };
    expect(sessionRefusalFor(unreadable, message)).toEqual({
      type: 'error',
      message: 'pin-remove refused: it was chosen in session s1, and session s2 is open now. Nothing changed; choose again in session s2.',
    });
    expect(sessionRefusalFor({ ...unreadable, frameworkSessionId: 's1' }, message)).toBeNull();
  });

  test("a refusal names a session by its id alone when the index has no entry for it or finds another session for its id", () => {
    const message = { type: 'pin-remove', pinId: 'pin-0', sessionId: 's1' } as WebUiClientMessage;
    const indexes = [
      { findSession: () => null },
      { findSession: (nameOrId: string) => ({ id: nameOrId === 's1' ? 's2' : 's1', name: nameOrId }) },
    ];
    for (const sessionManager of indexes) {
      expect(sessionRefusalFor({ frameworkSessionId: 's3', sessionManager }, message)).toEqual({
        type: 'error',
        message: 'pin-remove refused: it was chosen in session s1, and session s3 is open now. Nothing changed; choose again in session s3.',
      });
    }
  });

  test('a subagent cancel chosen in another session is answered as a command result naming the subagent and both sessions, and one chosen in the open session passes', () => {
    const message = { type: 'cancel-subagent', name: 'helper', sessionId: 's1' } as WebUiClientMessage;
    expect(isClientMessage(message)).toBe(true);
    expect(sessionRefusalFor(sessions('s2'), message)).toEqual({
      type: 'command-result',
      lines: [{ text: other('cancel-subagent helper'), style: 'tool' }],
    });
    expect(sessionRefusalFor(sessions('s1'), message)).toBeNull();
  });

  test("a subagent cancel for this process that doesn't say which session it was chosen in isn't a message the server takes", () => {
    expect(isClientMessage({ type: 'cancel-subagent', name: 'helper' })).toBe(false);
    expect(isClientMessage({ type: 'cancel-subagent', name: 'helper', sessionId: '' })).toBe(false);
  });

  test("a subagent cancel for a fleet child carries no session, since the page knows none of a child's, and isn't checked", () => {
    const message = { type: 'cancel-subagent', name: 'helper', childName: 'child' };
    expect(isClientMessage(message)).toBe(true);
    expect(isClientMessage({ ...message, sessionId: 's1' })).toBe(false);
    expect(sessionRefusalFor(sessions('s2'), message as WebUiClientMessage)).toBeNull();
  });

  test("a pin or settings change for a fleet child carries no session, since the page knows none of a child's, and isn't checked", () => {
    for (const message of [
      { type: 'pin-add', scope: 'child', firstMessageId: 'm1' },
      { type: 'pin-remove', scope: 'child', pinId: 'pin-0' },
      { type: 'settings-update', scope: 'child', tailTokens: 4000 },
      { type: 'settings-reset', scope: 'child' },
      { type: 'settings-cancel-transition', scope: 'child' },
    ]) {
      expect(isClientMessage(message)).toBe(true);
      expect(isClientMessage({ ...message, sessionId: 's1' })).toBe(false);
      expect(sessionRefusalFor(sessions('s2'), message as WebUiClientMessage)).toBeNull();
    }
  });

  test('a message that changes no session is never refused for a session it carries', () => {
    for (const message of [
      { type: 'request-pins' },
      { type: 'request-settings' },
      { type: 'fleet-stop', name: 'child' },
      { type: 'host-quiesce' },
      { type: 'host-resume' },
      { type: 'user-message', content: 'hello' },
    ]) {
      expect(sessionRefusalFor(sessions('s2'), { ...message, sessionId: 's1' } as WebUiClientMessage)).toBeNull();
    }
  });
});
