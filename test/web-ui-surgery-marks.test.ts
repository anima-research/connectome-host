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
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModuleContext } from '@animalabs/agent-framework';
import {
  WebUiModule,
  __getSharedServerPortForTests,
  __resetSharedServerForTests,
} from '../src/modules/web-ui-module.js';

const USER = 'admin';
const PASS = 'open-sesame';
const ref = (messageId: string) => ({ serverId: 'discord', channelId: 'discord:g1:c1', messageId });

let port: number;
let tmp: string;
let webUiModule: WebUiModule;

/** Calls the fake framework received, for assertions. */
const received: Array<{ method: string; args: unknown[] }> = [];
/** The fake agent's live branch, which a test may move. */
const liveBranch = { id: 'b1', name: 'main' };
/** The fake framework's store identity. */
const storeIdentity = { id: 'store-a' };

function fakeFramework(opts: { contract: boolean; storeIdentity?: boolean }) {
  const surgeryResult = (marks: unknown) => ({
    sourceBranch: 'main',
    targetBranch: 'rollback/resident/1',
    messagesRemoved: 3,
    lastVisible: null,
    ...(opts.contract
      ? {
          markers: marks && marks !== 'none'
            ? { scope: 'addressed', unmarked: 1, notRemoved: 0, status: 'queued', queued: 2, batchId: 'b1' }
            : { scope: 'none', unmarked: 3, notRemoved: 0, status: 'none', queued: 0 },
        }
      : {}),
  });
  const contextManager = {
    getAllMessages: () => [],
    currentBranch: () => ({ ...liveBranch }),
  };
  const framework: Record<string, unknown> = {
    getAllAgents: () => [{ name: 'resident', model: 'test', getContextManager: () => contextManager }],
    getAllModules: () => [],
    getModule: () => undefined,
    onTrace: () => {},
    getSessionUsage: () => { throw new Error('no usage in this harness'); },
    rollbackToMessage: async (...args: unknown[]) => {
      received.push({ method: 'rollbackToMessage', args });
      const expected = (args[1] as { expected?: { storeId?: string; branch?: string } }).expected;
      if (expected && (expected.storeId !== storeIdentity.id || expected.branch !== liveBranch.name)) {
        throw Object.assign(new Error('resolved against another store'), { code: 'stale' });
      }
      return surgeryResult((args[1] as { marks?: unknown }).marks);
    },
    suppressMessages: async (...args: unknown[]) => {
      received.push({ method: 'suppressMessages', args });
      return surgeryResult((args[1] as { marks?: unknown }).marks);
    },
  };
  if (opts.contract) {
    Object.assign(framework, {
      ...(opts.storeIdentity === false ? {} : { getStoreIdentity: () => storeIdentity.id }),
      previewSurgeryMarks: (...args: unknown[]) => {
        received.push({ method: 'previewSurgeryMarks', args });
        return {
          ...(opts.storeIdentity === false ? {} : { context: { storeId: storeIdentity.id, branch: liveBranch.name } }),
          messagesRemoved: 3,
          addressable: 3,
          emoji: '💤',
          scopes: {
            addressed: { count: 2, channels: [{ channelId: 'discord:g1:c1', count: 2 }], refs: [ref('a1'), ref('a2')] },
            all: { count: 3, channels: [{ channelId: 'discord:g1:c1', count: 3 }], refs: [ref('a1'), ref('a2'), ref('x1')] },
          },
        };
      },
      listDiscordAwareness: () => [
        { kind: 'batch', id: 'b1', status: 'active', scope: 'addressed', refs: 2, adds: { requested: 2 }, removals: {}, unresolvedAttempts: 0 },
      ],
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
        throw new Error('Discord awareness batch b1 is active, not held');
      },
    });
  }
  return framework;
}

function bind(contract: boolean, sessionId = 's1', storeIdentityCheck = true): void {
  webUiModule.setApp({
    framework: fakeFramework({ contract, storeIdentity: storeIdentityCheck }),
    recipe: { name: 'r', description: 'd', version: '1', agent: { name: 'resident' } },
    sessionManager: { getActiveSession: () => ({ id: sessionId, name: 's', manuallyNamed: false }) },
  } as never);
}

/** A connected, welcomed operator client that collects frames. */
async function connect(): Promise<{
  ws: WebSocket;
  welcome: Record<string, unknown>;
  /** The next frame of a type (and, when given, with that corrId): the
   *  journal is also broadcast unsolicited after surgeries and actions. */
  next(type: string, corrId?: string): Promise<Record<string, unknown>>;
  send(msg: unknown): void;
}> {
  const frames: Array<Record<string, unknown>> = [];
  const waiters: Array<{ type: string; corrId?: string; resolve: (f: Record<string, unknown>) => void }> = [];
  const matches = (f: Record<string, unknown>, type: string, corrId?: string) =>
    f.type === type && (corrId === undefined || f.corrId === corrId);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: {
      origin: `http://127.0.0.1:${port}`,
      authorization: `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`,
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
  const welcome = await next('welcome');
  return { ws, welcome, next, send: (msg) => ws.send(JSON.stringify(msg)) };
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'webui-marks-'));
  const staticRoot = join(tmp, 'web');
  mkdirSync(staticRoot, { recursive: true });
  writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><title>t</title>');
  webUiModule = new WebUiModule({
    port: 0,
    host: '127.0.0.1',
    basicAuth: { username: USER, password: PASS },
    staticDir: staticRoot,
  });
  await webUiModule.start({} as ModuleContext);
  port = __getSharedServerPortForTests()!;
});

afterAll(async () => {
  await webUiModule.stop();
  await __resetSharedServerForTests();
  rmSync(tmp, { recursive: true, force: true });
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

      // Without a choice the framework is told none explicitly.
      client.send({ type: 'suppress', messageIds: ['s3'], expectedContext: context, corrId: 'r2' });
      await client.next('surgery-result');
      const suppress = received.find((r) => r.method === 'suppressMessages')!;
      expect((suppress.args[1] as { marks: unknown }).marks).toBe('none');

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

      client.send({ type: 'awareness-action', action: 'cancel', target: 'b1', corrId: 'a2' });
      const cancelled = await client.next('awareness', 'a2');
      expect(cancelled.action).toBe('cancel');
      expect((cancelled.receipt as { cancelled: number }).cancelled).toBe(2);
      const cancelCall = received.find((r) => r.method === 'cancelDiscordAwareness')!;
      expect(cancelCall.args[0]).toBe('b1');
      expect((cancelCall.args[1] as { requester: { via: string } }).requester.via).toBe('webui');

      client.send({ type: 'awareness-action', action: 'release', target: 'b1', corrId: 'a3' });
      const refused = await client.next('awareness', 'a3');
      expect(refused.error).toMatch(/not held/);
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
    } finally {
      client.ws.close();
    }
  });
});
