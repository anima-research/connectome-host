/**
 * WebUI live surgery and Discord awareness marks, over the real WebSocket
 * surface with a fake framework.
 *
 * After a field incident in which one web-UI rollback queued a 💤 reaction on
 * each of 918 removed Discord messages (agent-framework's marks contract,
 * room-225): marks are the operator's explicit choice, previewed first and
 * bound to the previewed messages; the framework's journal can be listed,
 * cancelled, retracted and released from the UI; and a framework too old to
 * take a choice is never handed one it would silently ignore.
 *
 * Bun runs each test file in its own process, so this file's module
 * singleton (the shared HTTP/WS server) is its own.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import type { ModuleContext } from '@animalabs/agent-framework';
import {
  WebUiModule,
  __getSharedServerPortForTests,
  __resetSharedServerForTests,
} from '../src/modules/web-ui-module.js';
import { observerStatement, saveObserversFile } from '../src/modules/web-ui-observers.js';

const USER = 'admin';
const PASS = 'open-sesame';
const ref = (messageId: string) => ({ serverId: 'discord', channelId: 'discord:g1:c1', messageId });

let port: number;
let tmp: string;
let webUiModule: WebUiModule;

/** Observer keys: one granted the ops scope, one only health. */
function makeKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return { id: `ed25519:${spki.subarray(spki.length - 32).toString('base64url')}`, privateKey };
}
type Keypair = ReturnType<typeof makeKeypair>;
const opsObserver = makeKeypair();
const healthObserver = makeKeypair();

/** Calls the fake framework received, for assertions. */
const received: Array<{ method: string; args: unknown[] }> = [];
/** What the host recorded in the operator log through the framework. */
const logged: Array<Record<string, unknown>> = [];
/** The fake agent's live branch, which a test may move. */
const liveBranch = { id: 'b1', name: 'main' };
/** The fake framework's store identity. */
const storeIdentity = { id: 'store-a' };

/** The fake's own expected-context check, as the framework runs it under its
 *  reservation: refused as stale against another store or branch. */
function checkExpected(args: unknown[]): void {
  const expected = (args[1] as { expected?: { storeId?: string; branch?: string } }).expected;
  if (expected && (expected.storeId !== storeIdentity.id || expected.branch !== liveBranch.name)) {
    throw Object.assign(new Error('resolved against another store or branch'), { code: 'stale' });
  }
}

interface FakeOptions {
  contract: boolean;
  /** false: the marks choice without the store-and-branch check (#250 alone). */
  storeIdentity?: boolean;
  /** A framework that breaks its own contract: a preview without `context`. */
  previewContext?: boolean;
  /** What a surgery with a marks choice reports. */
  markersStatus?: 'queued' | 'unresolved';
  /** getStoreIdentity throws, as a store that can't record its identity would. */
  storeIdentityThrows?: boolean;
  /** listDiscordAwareness throws. */
  journalThrows?: boolean;
  /** No live rollback or suppression at all. */
  noSurgery?: boolean;
}

function fakeFramework(opts: FakeOptions) {
  const surgeryResult = (marks: unknown) => ({
    sourceBranch: 'main',
    targetBranch: 'rollback/resident/1',
    messagesRemoved: 3,
    lastVisible: null,
    ...(opts.contract
      ? {
          markers: marks && marks !== 'none'
            ? opts.markersStatus === 'unresolved'
              ? { scope: 'addressed', unmarked: 1, notRemoved: 0, status: 'unresolved', queued: 0, batchId: 'b1', error: 'journal unreadable' }
              : { scope: 'addressed', unmarked: 1, notRemoved: 0, status: 'queued', queued: 2, batchId: 'b1' }
            : { scope: 'none', unmarked: 3, notRemoved: 0, status: 'none', queued: 0 },
        }
      : {}),
  });
  const contextManager = {
    getAllMessages: () => [],
    currentBranch: () => ({ ...liveBranch }),
  };
  let quiesced = false;
  const framework: Record<string, unknown> = {
    getAllAgents: () => [{ name: 'resident', model: 'test', getContextManager: () => contextManager }],
    getAllModules: () => [],
    getModule: () => undefined,
    onTrace: () => {},
    getSessionUsage: () => { throw new Error('no usage in this harness'); },
    rollbackToMessage: async (...args: unknown[]) => {
      received.push({ method: 'rollbackToMessage', args });
      checkExpected(args);
      return surgeryResult((args[1] as { marks?: unknown }).marks);
    },
    suppressMessages: async (...args: unknown[]) => {
      received.push({ method: 'suppressMessages', args });
      checkExpected(args);
      return surgeryResult((args[1] as { marks?: unknown }).marks);
    },
    recordOperatorAction: (entry: Record<string, unknown>) => { logged.push(entry); return entry; },
    quiesce: async (...args: unknown[]) => { received.push({ method: 'quiesce', args }); quiesced = true; },
    resume: async () => { quiesced = false; },
    getHostModeStatus: () => ({ quiesced, drained: true }),
  };
  if (opts.noSurgery) {
    delete framework.rollbackToMessage;
    delete framework.suppressMessages;
  }
  if (opts.contract) {
    Object.assign(framework, {
      ...(opts.storeIdentity === false ? {} : {
        getStoreIdentity: () => {
          if (opts.storeIdentityThrows) throw new Error('store identity unreadable');
          return storeIdentity.id;
        },
      }),
      previewSurgeryMarks: (...args: unknown[]) => {
        received.push({ method: 'previewSurgeryMarks', args });
        return {
          ...(opts.storeIdentity === false || opts.previewContext === false ? {} : { context: { storeId: storeIdentity.id, branch: liveBranch.name } }),
          messagesRemoved: 3,
          addressable: 3,
          emoji: '💤',
          scopes: {
            addressed: { count: 2, channels: [{ channelId: 'discord:g1:c1', count: 2 }], refs: [ref('a1'), ref('a2')] },
            all: { count: 3, channels: [{ channelId: 'discord:g1:c1', count: 3 }], refs: [ref('a1'), ref('a2'), ref('x1')] },
          },
        };
      },
      listDiscordAwareness: () => {
        if (opts.journalThrows) throw new Error('journal file unreadable');
        return [
          { kind: 'batch', id: 'b1', status: 'active', scope: 'addressed', refs: 2, adds: { requested: 2 }, removals: {}, unresolvedAttempts: 0 },
        ];
      },
      cancelDiscordAwareness: (...args: unknown[]) => {
        received.push({ method: 'cancelDiscordAwareness', args });
        return { target: args[0], kind: 'batch', cancelled: 2, heldDropped: 0, inFlight: 0, unknown: 0, confirmed: 0, unresolvedAttempts: 0, legacyOutcomesUnrecorded: 0 };
      },
      retractDiscordAwareness: (...args: unknown[]) => {
        received.push({ method: 'retractDiscordAwareness', args });
        return { requestId: 'r1', removalsQueued: 2, addsSuperseded: 0, keysWithUnresolvedAdds: 0, unresolvedAddAttempts: 0, keysWithLegacyUncertainty: 0 };
      },
      releaseDiscordAwareness: (...args: unknown[]) => {
        received.push({ method: 'releaseDiscordAwareness', args });
        // agent-framework wraps every journal action's failure as an
        // OperatorActionError('invalid', …) (awarenessOperatorAction).
        throw Object.assign(new Error('Discord awareness batch b1 is active, not held'), { name: 'OperatorActionError', code: 'invalid' });
      },
    });
  }
  return framework;
}

function bind(contract: boolean, sessionId = 's1', storeIdentityCheck = true, more: Partial<FakeOptions> = {}): void {
  webUiModule.setApp({
    framework: fakeFramework({ contract, storeIdentity: storeIdentityCheck, ...more }),
    recipe: { name: 'r', description: 'd', version: '1', agent: { name: 'resident' } },
    sessionManager: { getActiveSession: () => ({ id: sessionId, name: 's', manuallyNamed: false }) },
  } as never);
}

/** A connected, welcomed client that collects frames: a full operator, or
 *  an observer signed in with `observer`'s key. */
async function connect(observer?: Keypair): Promise<{
  ws: WebSocket;
  welcome: Record<string, unknown>;
  /** The next frame of a type (and, when given, with that corrId): the
   *  journal is also broadcast unsolicited after surgeries and actions. */
  next(type: string, corrId?: string): Promise<Record<string, unknown>>;
  /** Frames of a type received and not yet taken by next(). */
  waiting(type: string): Array<Record<string, unknown>>;
  send(msg: unknown): void;
}> {
  const frames: Array<Record<string, unknown>> = [];
  const waiters: Array<{ type: string; corrId?: string; resolve: (f: Record<string, unknown>) => void }> = [];
  const matches = (f: Record<string, unknown>, type: string, corrId?: string) =>
    f.type === type && (corrId === undefined || f.corrId === corrId);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: {
      origin: `http://127.0.0.1:${port}`,
      ...(observer ? {} : { authorization: `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}` }),
    },
  } as unknown as undefined);
  ws.addEventListener('message', (ev) => {
    const frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
    const index = waiters.findIndex((w) => matches(frame, w.type, w.corrId));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(frame);
    else frames.push(frame);
  });
  const next = (type: string, corrId?: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const index = frames.findIndex((f) => matches(f, type, corrId));
    if (index >= 0) { resolve(frames.splice(index, 1)[0]); return; }
    const timer = setTimeout(() => reject(new Error(`no ${type} frame`)), 5000);
    waiters.push({ type, corrId, resolve: (f) => { clearTimeout(timer); resolve(f); } });
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', (e) => reject(e as unknown as Error));
  });
  if (observer) {
    await next('observer-auth-required');
    const host = `127.0.0.1:${port}`;
    const timestamp = new Date().toISOString();
    const proof = cryptoSign(null, Buffer.from(observerStatement(host, timestamp), 'utf8'), observer.privateKey);
    ws.send(JSON.stringify({ type: 'observer-hello', identity: { scheme: 'ed25519', id: observer.id, proof: proof.toString('base64url'), timestamp } }));
    await next('observer-ack');
  }
  const welcome = await next('welcome');
  return {
    ws, welcome, next,
    waiting: (type) => frames.filter((f) => f.type === type),
    send: (msg) => ws.send(JSON.stringify(msg)),
  };
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'webui-marks-'));
  const staticRoot = join(tmp, 'web');
  mkdirSync(staticRoot, { recursive: true });
  writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><title>t</title>');
  const observersPath = join(tmp, 'observers.json');
  saveObserversFile(observersPath, {
    observers: [
      { key: opsObserver.id, label: 'ops-observer', scopes: ['health', 'ops'] },
      { key: healthObserver.id, label: 'health-observer', scopes: ['health'] },
    ],
  });
  webUiModule = new WebUiModule({
    port: 0,
    host: '127.0.0.1',
    basicAuth: { username: USER, password: PASS },
    staticDir: staticRoot,
    observersPath,
  });
  await webUiModule.start({} as ModuleContext);
  port = __getSharedServerPortForTests()!;
});

afterAll(async () => {
  await webUiModule.stop();
  await __resetSharedServerForTests();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  received.length = 0;
  logged.length = 0;
  liveBranch.id = 'b1';
  liveBranch.name = 'main';
  storeIdentity.id = 'store-a';
});

describe('surgery marks over the WebUI', () => {
  test('a contract framework: preview, a choice bound to previewed refs, the receipt, and the journal controls', async () => {
    bind(true);
    received.length = 0;
    const client = await connect();
    try {
      expect(client.welcome.features).toEqual(expect.arrayContaining(['rollback', 'suppress', 'marks', 'awareness']));

      client.send({ type: 'surgery-preview', op: 'rollback', messageId: 's9', corrId: 'p1' });
      const preview = await client.next('surgery-preview');
      expect(preview.ok).toBe(true);
      expect(preview.corrId).toBe('p1');
      expect((preview.preview as { scopes: { addressed: { count: number } } }).scopes.addressed.count).toBe(2);
      expect(received[0]).toEqual({ method: 'previewSurgeryMarks', args: ['resident', { rollbackTo: 's9' }] });

      expect(preview.branchId).toBe('b1');
      expect(preview.sessionId).toBe('s1');

      expect(preview.preview).toMatchObject({ context: { storeId: 'store-a', branch: 'main' } });
      const context = (preview.preview as { context: Record<string, string> }).context;

      // Without the preview's whole context, nothing runs: none, an empty
      // one, or one missing either field (malformed frames are dropped by
      // validation and answered with an error frame, not run).
      client.send({ type: 'rollback', messageId: 's9', marks: 'none', corrId: 'r0' });
      const unbound = await client.next('surgery-result', 'r0');
      expect(unbound.ok).toBe(false);
      expect(unbound.code).toBe('stale');
      for (const partial of [{}, { storeId: 'store-a' }, { branch: 'main' }]) {
        client.send({ type: 'rollback', messageId: 's9', marks: 'none', expectedContext: partial, corrId: 'rp' });
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(received.some((r) => r.method === 'rollbackToMessage')).toBe(false);

      const marks = { scope: 'addressed', refs: [ref('a1'), ref('a2')] };
      client.send({
        type: 'rollback', messageId: 's9', marks, expectedSessionId: 's1', expectedBranchId: 'b1',
        expectedContext: context, corrId: 'r1',
      });
      const result = await client.next('surgery-result', 'r1');
      // Every operator sees the journal change.
      expect((await client.next('awareness')).corrId).toBeUndefined();
      expect(result.ok).toBe(true);
      expect((result.markers as { status: string; queued: number }).status).toBe('queued');
      const call = received.find((r) => r.method === 'rollbackToMessage')!;
      expect((call.args[1] as { marks: unknown }).marks).toEqual(marks);
      expect((call.args[1] as { expected: unknown }).expected).toEqual(context);

      // Without a choice the framework is told none explicitly; a suppression
      // carries the preview's context to the framework just as a rollback does.
      client.send({ type: 'suppress', messageIds: ['s3'], expectedContext: context, corrId: 'r2' });
      expect((await client.next('surgery-result', 'r2')).ok).toBe(true);
      const suppress = received.find((r) => r.method === 'suppressMessages')!;
      expect((suppress.args[1] as { marks: unknown }).marks).toBe('none');
      expect((suppress.args[1] as { expected: unknown }).expected).toEqual(context);

      // A confirmation bound to a preview of another branch is refused
      // before the framework sees it.
      liveBranch.id = 'b2';
      const calls = received.length;
      client.send({ type: 'rollback', messageId: 's9', marks, expectedSessionId: 's1', expectedBranchId: 'b1', expectedContext: context, corrId: 'r-stale' });
      const stale = await client.next('surgery-result', 'r-stale');
      expect(stale.ok).toBe(false);
      expect(stale.code).toBe('stale');
      expect(received.length).toBe(calls);
      liveBranch.id = 'b1';

      client.send({ type: 'request-awareness', corrId: 'a1' });
      const listed = await client.next('awareness', 'a1');
      expect((listed.batches as unknown[]).length).toBe(1);
      const instance = listed.frameworkInstanceId as string;
      expect(typeof instance).toBe('string');

      client.send({ type: 'awareness-action', action: 'cancel', target: 'b1', expectedFrameworkInstanceId: instance, corrId: 'a2' });
      const cancelled = await client.next('awareness', 'a2');
      expect(cancelled.action).toBe('cancel');
      expect((cancelled.receipt as { cancelled: number }).cancelled).toBe(2);
      expect(cancelled.frameworkInstanceId).toBe(instance);
      const cancelCall = received.find((r) => r.method === 'cancelDiscordAwareness')!;
      expect(cancelCall.args[0]).toBe('b1');
      expect((cancelCall.args[1] as { requester: { via: string } }).requester.via).toBe('webui');
      // Every operator sees the journal after an action, as after a surgery.
      expect((await client.next('awareness')).corrId).toBeUndefined();

      client.send({ type: 'awareness-action', action: 'release', target: 'b1', expectedFrameworkInstanceId: instance, corrId: 'a3' });
      const refused = await client.next('awareness', 'a3');
      expect(refused.error).toMatch(/not held/);
      // The framework's refusal code comes through with its message.
      expect(refused.code).toBe('invalid');

      // An action that names no journal it was chosen from is malformed and
      // never reaches the framework (frames are handled in order, so the
      // later listing's answer means the action has been handled).
      client.send({ type: 'awareness-action', action: 'retract', target: 'all', corrId: 'a4' });
      client.send({ type: 'request-awareness', corrId: 'a5' });
      await client.next('awareness', 'a5');
      expect(received.some((r) => r.method === 'retractDiscordAwareness')).toBe(false);
    } finally {
      client.ws.close();
    }
  });

  test('a confirmation bound to one session is refused after the host rebinds to another, even with matching ids', async () => {
    bind(true, 'session-a');
    received.length = 0;
    const client = await connect();
    try {
      client.send({ type: 'surgery-preview', op: 'rollback', messageId: '2', corrId: 'p' });
      const preview = await client.next('surgery-preview', 'p');
      expect(preview.sessionId).toBe('session-a');
      // The supported session switch: a new framework on another store, whose
      // branch and message ids happen to be the same.
      bind(true, 'session-b');
      await client.next('welcome');
      const context = (preview.preview as { context: Record<string, string> }).context;
      client.send({
        type: 'rollback', messageId: '2', marks: 'none',
        expectedSessionId: preview.sessionId, expectedBranchId: preview.branchId, expectedContext: context, corrId: 'r',
      });
      const result = await client.next('surgery-result', 'r');
      expect(result.ok).toBe(false);
      expect(result.code).toBe('stale');
      expect(received.some((r) => r.method === 'rollbackToMessage')).toBe(false);

      // Even where the host's own check can't tell (a client that omits its
      // session and branch), the framework refuses another store's context.
      storeIdentity.id = 'store-b';
      client.send({ type: 'rollback', messageId: '2', marks: 'none', expectedContext: context, corrId: 'r2' });
      const refused = await client.next('surgery-result', 'r2');
      expect(refused.ok).toBe(false);
      expect(refused.code).toBe('stale');
      storeIdentity.id = 'store-a';
    } finally {
      client.ws.close();
    }
  });

  test('a framework with the marks choice but no store-and-branch check (AF #250 alone) gets no live surgery either', async () => {
    bind(true, 's1', false);
    received.length = 0;
    const client = await connect();
    try {
      expect(client.welcome.features as string[]).not.toContain('marks');
      client.send({ type: 'surgery-preview', op: 'rollback', messageId: 's9', corrId: 'p' });
      expect((await client.next('surgery-preview', 'p')).ok).toBe(false);
      client.send({ type: 'rollback', messageId: 's9', marks: 'none', expectedContext: { storeId: 'x', branch: 'main' }, corrId: 'r' });
      const refused = await client.next('surgery-result', 'r');
      expect(refused.ok).toBe(false);
      expect(refused.code).toBe('unsupported');
      expect(received.some((r) => r.method === 'rollbackToMessage')).toBe(false);
    } finally {
      client.ws.close();
    }
  });

  test('an older framework, which would mark regardless of any choice, gets no live surgery: upgrade required', async () => {
    bind(false);
    received.length = 0;
    const client = await connect();
    try {
      const features = client.welcome.features as string[];
      expect(features).toContain('rollback');
      expect(features).not.toContain('marks');

      // Every form is refused before anything changes: a scope it can't
      // honor, an omitted choice, and an explicit none alike.
      const attempts: Array<[string, Record<string, unknown>]> = [
        ['r1', { type: 'rollback', messageId: 's9', marks: { scope: 'all' } }],
        ['r2', { type: 'rollback', messageId: 's9' }],
        ['r3', { type: 'suppress', messageIds: ['s3'], marks: 'none' }],
      ];
      for (const [corrId, msg] of attempts) {
        client.send({ ...msg, corrId });
        const refused = await client.next('surgery-result', corrId);
        expect(refused.ok).toBe(false);
        expect(refused.code).toBe('unsupported');
        expect(String(refused.error)).toMatch(/upgrade @animalabs\/agent-framework/);
      }
      expect(received.some((r) => r.method === 'rollbackToMessage' || r.method === 'suppressMessages')).toBe(false);

      client.send({ type: 'surgery-preview', op: 'rollback', messageId: 's9', corrId: 'p1' });
      const preview = await client.next('surgery-preview');
      expect(preview.ok).toBe(false);
      expect(String(preview.error)).toMatch(/upgrade @animalabs\/agent-framework/);

      // The journal and its controls say what's missing, rather than failing on it.
      client.send({ type: 'request-awareness', corrId: 'j1' });
      expect((await client.next('awareness', 'j1')).error).toMatch(/no awareness journal controls/);
      client.send({ type: 'awareness-action', action: 'cancel', target: 'b1', expectedFrameworkInstanceId: 'fw-x', corrId: 'j2' });
      const control = await client.next('awareness', 'j2');
      expect(String(control.error)).toMatch(/no awareness cancel — upgrade @animalabs\/agent-framework/);
      expect(control.code).toBeUndefined();
    } finally {
      client.ws.close();
    }
  });

  test('a suppression is bound to its preview as a rollback is: another session, branch or store refuses it', async () => {
    bind(true, 'session-a');
    const client = await connect();
    try {
      client.send({ type: 'surgery-preview', op: 'suppress', messageIds: ['s3'], corrId: 'p' });
      const preview = await client.next('surgery-preview', 'p');
      const context = (preview.preview as { context: Record<string, string> }).context;
      const bound = { expectedSessionId: preview.sessionId, expectedBranchId: preview.branchId, expectedContext: context };

      // The host's own check: the branch moved since the preview.
      liveBranch.id = 'b2';
      client.send({ type: 'suppress', messageIds: ['s3'], marks: 'none', ...bound, corrId: 's1' });
      expect((await client.next('surgery-result', 's1')).code).toBe('stale');
      expect(received.some((r) => r.method === 'suppressMessages')).toBe(false);
      liveBranch.id = 'b1';

      // The framework's check, which holds where the host's can't tell (a
      // client that omits its session and branch): another store, then
      // another branch, each refused with the preview's context in hand.
      storeIdentity.id = 'store-b';
      client.send({ type: 'suppress', messageIds: ['s3'], marks: 'none', expectedContext: context, corrId: 's2' });
      const otherStore = await client.next('surgery-result', 's2');
      expect(otherStore.ok).toBe(false);
      expect(otherStore.code).toBe('stale');
      storeIdentity.id = 'store-a';
      liveBranch.name = 'elsewhere';
      client.send({ type: 'suppress', messageIds: ['s3'], marks: 'none', expectedContext: context, corrId: 's3' });
      const otherBranch = await client.next('surgery-result', 's3');
      expect(otherBranch.ok).toBe(false);
      expect(otherBranch.code).toBe('stale');
      liveBranch.name = 'main';
      const calls = received.filter((r) => r.method === 'suppressMessages');
      expect(calls.length).toBe(2);
      for (const call of calls) expect((call.args[1] as { expected: unknown }).expected).toEqual(context);

      // After the host rebinds to another session, it refuses before the
      // framework sees anything.
      bind(true, 'session-b');
      await client.next('welcome');
      client.send({ type: 'suppress', messageIds: ['s3'], marks: 'none', ...bound, corrId: 's4' });
      expect((await client.next('surgery-result', 's4')).code).toBe('stale');
      expect(received.filter((r) => r.method === 'suppressMessages').length).toBe(2);
    } finally {
      client.ws.close();
    }
  });

  test('a journal action reaches only the framework instance it was listed from, whatever the session label says', async () => {
    bind(true, 'session-a');
    const client = await connect();
    try {
      client.send({ type: 'request-awareness', corrId: 'l1' });
      const firstInstance = (await client.next('awareness', 'l1')).frameworkInstanceId as string;

      // Another framework bound under the same session label: what a session
      // switch looks like from the label while it creates the new framework
      // (the new session is active before its framework is bound).
      bind(true, 'session-a');
      await client.next('welcome');
      client.send({ type: 'awareness-action', action: 'retract', target: 'all', expectedFrameworkInstanceId: firstInstance, corrId: 'x1' });
      const refused = await client.next('awareness', 'x1');
      expect(refused.code).toBe('stale');
      expect(String(refused.error)).toMatch(/no longer serves/);
      expect(received.some((r) => r.method === 'retractDiscordAwareness')).toBe(false);
      // The refusal lists the live journal under its own instance, and is
      // recorded as the framework records its own refusals.
      const liveInstance = refused.frameworkInstanceId as string;
      expect(liveInstance).not.toBe(firstInstance);
      expect((refused.batches as unknown[]).length).toBe(1);
      expect(logged).toContainEqual({
        kind: 'awareness-retract', agent: '*', requester: expect.objectContaining({ via: 'webui' }),
        params: { target: 'all' }, error: refused.error,
      });

      // Chosen from the live journal, it acts.
      client.send({ type: 'awareness-action', action: 'retract', target: 'all', expectedFrameworkInstanceId: liveInstance, corrId: 'x2' });
      expect((await client.next('awareness', 'x2')).error).toBeUndefined();
      expect(received.filter((r) => r.method === 'retractDiscordAwareness').map((r) => r.args[0])).toEqual(['all']);

      // A switch to another session, likewise.
      bind(true, 'session-b');
      await client.next('welcome');
      client.send({ type: 'awareness-action', action: 'cancel', target: 'b1', expectedFrameworkInstanceId: liveInstance, corrId: 'x3' });
      expect((await client.next('awareness', 'x3')).code).toBe('stale');
      expect(received.some((r) => r.method === 'cancelDiscordAwareness')).toBe(false);
    } finally {
      client.ws.close();
    }
  });

  test("a retry's quiesce is bound to the session and store its surgery was previewed on", async () => {
    bind(true, 'session-a');
    const client = await connect();
    try {
      expect(client.welcome.features).toEqual(expect.arrayContaining(['quiesce']));

      // Another store behind the previewed session label: refused before
      // anything is paused, recorded, and answered with the live host mode
      // (which settles a client waiting on its quiesce).
      storeIdentity.id = 'store-b';
      client.send({ type: 'host-quiesce', reason: 'rollback via webui', expectedSessionId: 'session-a', expectedStoreId: 'store-a', corrId: 'q1' });
      expect(String((await client.next('error', 'q1')).message)).toMatch(/nothing was paused/);
      expect(((await client.next('host-mode', 'q1')).hostMode as { mode: string }).mode).toBe('serving');
      expect(received.some((r) => r.method === 'quiesce')).toBe(false);
      expect(logged).toContainEqual(expect.objectContaining({
        kind: 'quiesce', note: 'rollback via webui',
        params: { expectedSessionId: 'session-a', expectedStoreId: 'store-a' },
        error: expect.stringMatching(/nothing was paused/),
      }));
      storeIdentity.id = 'store-a';

      // Another session: refused likewise.
      bind(true, 'session-b');
      await client.next('welcome');
      client.send({ type: 'host-quiesce', expectedSessionId: 'session-a', expectedStoreId: 'store-a', corrId: 'q2' });
      expect(String((await client.next('error', 'q2')).message)).toMatch(/nothing was paused/);
      expect(received.some((r) => r.method === 'quiesce')).toBe(false);

      // Still the previewed session and store: it quiesces.
      client.send({ type: 'host-quiesce', expectedSessionId: 'session-b', expectedStoreId: 'store-a', corrId: 'q3' });
      expect(((await client.next('host-mode', 'q3')).hostMode as { mode: string }).mode).toBe('quiesced');
      expect(received.filter((r) => r.method === 'quiesce').length).toBe(1);

      // A store whose identity can't be read can't be shown to be the
      // previewed one: refused, and answered.
      bind(true, 'session-b', true, { storeIdentityThrows: true });
      await client.next('welcome');
      client.send({ type: 'host-quiesce', expectedSessionId: 'session-b', expectedStoreId: 'store-a', corrId: 'q4' });
      expect(String((await client.next('error', 'q4')).message)).toMatch(/nothing was paused/);
      expect(received.filter((r) => r.method === 'quiesce').length).toBe(1);
    } finally {
      client.ws.close();
    }
  });

  test('refusals the host makes before the framework sees a surgery are recorded as the framework records its own', async () => {
    bind(false);
    const client = await connect();
    try {
      // An older framework: unsupported.
      client.send({ type: 'rollback', messageId: 's9', note: ' why not ', marks: { scope: 'all', refs: [ref('a1')] }, corrId: 'u' });
      const unsupported = await client.next('surgery-result', 'u');
      expect(unsupported.code).toBe('unsupported');
      expect(logged.at(-1)).toEqual({
        kind: 'rollback', agent: 'resident', requester: expect.objectContaining({ via: 'webui' }), note: 'why not',
        params: { messageId: 's9', marks: { scope: 'all', authorizedRefs: 1 } },
        error: unsupported.error,
      });

      bind(true, 'session-a');
      await client.next('welcome');
      // No preview context.
      client.send({ type: 'suppress', messageIds: ['s3', 's4'], corrId: 'm' });
      const unpreviewed = await client.next('surgery-result', 'm');
      expect(unpreviewed.code).toBe('stale');
      expect(logged.at(-1)).toEqual({
        kind: 'suppress', agent: 'resident', requester: expect.objectContaining({ via: 'webui' }),
        params: { messageIds: ['s3', 's4'], marks: 'none' }, error: unpreviewed.error,
      });

      // Previewed on another session.
      client.send({
        type: 'rollback', messageId: 's9', marks: 'none', expectedSessionId: 'session-z',
        expectedContext: { storeId: 'store-a', branch: 'main' }, corrId: 's',
      });
      const stale = await client.next('surgery-result', 's');
      expect(stale.code).toBe('stale');
      expect(logged.at(-1)).toMatchObject({ kind: 'rollback', agent: 'resident', params: { messageId: 's9', marks: 'none' }, error: stale.error });

      // Each records what was asked and why it didn't run: never a result.
      expect(logged.length).toBe(3);
      expect(logged.every((entry) => !('result' in entry))).toBe(true);
      expect(received.some((r) => r.method === 'rollbackToMessage' || r.method === 'suppressMessages')).toBe(false);

      // A framework without live surgery at all is recorded the same way.
      bind(false, 's1', true, { noSurgery: true });
      await client.next('welcome');
      client.send({ type: 'suppress', messageIds: ['s3'], corrId: 'x' });
      const none = await client.next('surgery-result', 'x');
      expect(String(none.error)).toMatch(/no live suppress — upgrade/);
      expect(logged.at(-1)).toMatchObject({ kind: 'suppress', params: { messageIds: ['s3'], marks: 'none' }, error: none.error });
      expect(logged.length).toBe(4);
    } finally {
      client.ws.close();
    }
  });

  test('a receipt whose scheduling is unresolved still sends every operator the journal', async () => {
    bind(true, 's1', true, { markersStatus: 'unresolved' });
    const client = await connect();
    try {
      client.send({ type: 'surgery-preview', op: 'rollback', messageId: 's9', corrId: 'p' });
      const preview = await client.next('surgery-preview', 'p');
      const context = (preview.preview as { context: Record<string, string> }).context;
      client.send({ type: 'rollback', messageId: 's9', marks: { scope: 'addressed', refs: [ref('a1')] }, expectedContext: context, corrId: 'r' });
      expect(((await client.next('surgery-result', 'r')).markers as { status: string }).status).toBe('unresolved');
      expect((await client.next('awareness')).corrId).toBeUndefined();
    } finally {
      client.ws.close();
    }
  });

  test("a preview without the framework's own context is refused: nothing could be bound to it", async () => {
    bind(true, 's1', true, { previewContext: false });
    const client = await connect();
    try {
      client.send({ type: 'surgery-preview', op: 'rollback', messageId: 's9', corrId: 'p' });
      const preview = await client.next('surgery-preview', 'p');
      expect(preview.ok).toBe(false);
      expect(String(preview.error)).toMatch(/without its store and branch/);
    } finally {
      client.ws.close();
    }
  });

  test('a journal that throws is answered with the reason', async () => {
    bind(true, 's1', true, { journalThrows: true });
    const client = await connect();
    try {
      client.send({ type: 'request-awareness', corrId: 'j' });
      const answer = await client.next('awareness', 'j');
      expect(answer.batches).toEqual([]);
      expect(String(answer.error)).toBe('awareness journal unavailable: journal file unreadable');
    } finally {
      client.ws.close();
    }
  });

  test('the journal is operator state: an observer with the ops scope may ask for it, and no observer is sent it unasked', async () => {
    bind(true, 's1');
    const operator = await connect();
    const ops = await connect(opsObserver);
    const health = await connect(healthObserver);
    try {
      ops.send({ type: 'request-awareness', corrId: 'o' });
      expect(((await ops.next('awareness', 'o')).batches as unknown[]).length).toBe(1);
      health.send({ type: 'request-awareness', corrId: 'h' });
      expect(String((await health.next('error')).message)).toMatch(/forbidden/);

      // A surgery that queues marks: every full operator gets the journal.
      operator.send({ type: 'surgery-preview', op: 'rollback', messageId: 's9', corrId: 'p' });
      const preview = await operator.next('surgery-preview', 'p');
      const context = (preview.preview as { context: Record<string, string> }).context;
      operator.send({ type: 'rollback', messageId: 's9', marks: { scope: 'addressed', refs: [ref('a1')] }, expectedContext: context, corrId: 'r' });
      expect((await operator.next('surgery-result', 'r')).ok).toBe(true);
      expect((await operator.next('awareness')).corrId).toBeUndefined();
      // The broadcast is one synchronous pass over the clients, so any copy an
      // observer was sent is on its socket before the answer to anything it
      // asks next: once that answer arrives, its buffer holds every copy.
      ops.send({ type: 'request-awareness', corrId: 'after' });
      await ops.next('awareness', 'after');
      health.send({ type: 'request-awareness', corrId: 'after' });
      await health.next('error');
      expect(ops.waiting('awareness')).toEqual([]);
      expect(health.waiting('awareness')).toEqual([]);
    } finally {
      operator.ws.close();
      ops.ws.close();
      health.ws.close();
    }
  });
});
