/**
 * Handler-level tests for WebUiModule against a stub AppContext — covers the
 * July 2026 fragility-audit fixes:
 *
 *   - quit-confirm requires a server-side pending-/quit token bound to the
 *     issuing connection (any authenticated frame could previously SIGTERM
 *     the host). process.kill is patched for the WHOLE file so a regression
 *     fails the test instead of killing the test run.
 *   - Welcome race: traces fired while a client's welcome is being built are
 *     buffered and flushed after the welcome frame (previously dropped), and
 *     trace frames carry a monotonic `seq`.
 *   - Fleet-request TTL fires from a timer, not just on the next request.
 *   - lessons-list frames are capped at the most recent 500 entries with
 *     `truncated`/`total` metadata.
 *   - WS backpressure: sustained non-positive ws.send() results close the
 *     client (unit-level via __sendFrameForTests; Bun offers no deterministic
 *     way to induce real WS backpressure in-process).
 *
 * One server per file (process-level singleton); each test binds its own stub
 * app via setApp() and opens a fresh WS connection.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import type { ModuleContext } from '@animalabs/agent-framework';
import {
  WebUiModule,
  __getSharedServerPortForTests,
  __resetSharedServerForTests,
  __sendFrameForTests,
  __getPendingFleetRequestsForTests,
  type WebUiAppRef,
  type SendFrameTarget,
} from '../src/modules/web-ui-module.js';

// ---------------------------------------------------------------------------
// process.kill guard — active for the entire file. A buggy quit path would
// otherwise SIGTERM the bun test process itself.
// ---------------------------------------------------------------------------
const killCalls: Array<{ pid: number; signal: unknown }> = [];
const realKill = process.kill;

let mod: WebUiModule;
let port: number;

type TraceCb = (event: { type: string; [k: string]: unknown }) => void;
/** Most recent onTrace callback registered through setApp(). */
let lastTraceCb: TraceCb | null = null;

interface StubModule { name: string; [k: string]: unknown }

function makeStubApp(modules: StubModule[] = []): WebUiAppRef {
  const framework = {
    getAllAgents: () => [],
    getAllModules: () => modules,
    getModule: () => undefined,
    onTrace: (cb: TraceCb) => { lastTraceCb = cb; },
  };
  return {
    framework,
    sessionManager: {
      getActiveSession: () => ({ id: 's1', name: 'test-session', manuallyNamed: true }),
    },
    recipe: { name: 'stub-recipe', agent: { name: 'agent' } },
    branchState: {},
    switchSession: async () => {},
  } as unknown as WebUiAppRef;
}

function makeFleetStub(extra: Record<string, unknown> = {}): StubModule {
  return {
    name: 'fleet',
    getChildren: () => new Map([['childA', { status: 'ready' }]]),
    onChildEvent: (_name: string, _cb: unknown) => () => {},
    requestDescribe: (_name: string, _corrId: string) => true,
    ...extra,
  };
}

interface WireFrame { type?: string; [k: string]: unknown }

interface TestClient {
  ws: WebSocket;
  messages: WireFrame[];
  waitFor(pred: (m: WireFrame) => boolean, timeoutMs?: number): Promise<WireFrame>;
  close(): void;
}

async function connectClient(): Promise<TestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { origin: `http://127.0.0.1:${port}` },
  } as unknown as undefined);
  const messages: WireFrame[] = [];
  ws.addEventListener('message', (ev) => {
    messages.push(JSON.parse(String((ev as MessageEvent).data)) as WireFrame);
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ws never opened')), 5000);
    ws.addEventListener('open', () => { clearTimeout(t); resolve(); });
    ws.addEventListener('error', (e) => { clearTimeout(t); reject(e as unknown as Error); });
  });
  return {
    ws,
    messages,
    async waitFor(pred, timeoutMs = 5000) {
      const start = Date.now();
      for (;;) {
        const found = messages.find(pred);
        if (found) return found;
        if (Date.now() - start > timeoutMs) {
          throw new Error(`timeout waiting for frame; got: ${messages.map(m => m.type).join(',')}`);
        }
        await new Promise(r => setTimeout(r, 20));
      }
    },
    close() { ws.close(); },
  };
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

beforeAll(async () => {
  (process as { kill: typeof process.kill }).kill = ((pid: number, signal?: string | number) => {
    killCalls.push({ pid, signal });
    return true;
  }) as typeof process.kill;

  mod = new WebUiModule({ port: 0, host: '127.0.0.1' });
  await mod.start({} as ModuleContext);
  const p = __getSharedServerPortForTests();
  if (!p) throw new Error('webui server not bound');
  port = p;
});

afterAll(async () => {
  await mod.stop();
  await __resetSharedServerForTests();
  // Give any stray scheduleShutdown timer (150ms) a chance to fire against
  // the patched kill before restoring the real one.
  await sleep(250);
  (process as { kill: typeof process.kill }).kill = realKill;
});

// ---------------------------------------------------------------------------
// [H] 1.7 — quit-confirm requires a pending /quit on the same connection
// ---------------------------------------------------------------------------

describe('quit-confirm token gating', () => {
  test('quit-confirm with no prior /quit is rejected and schedules no kill', async () => {
    mod.setApp(makeStubApp([makeFleetStub()]));
    const client = await connectClient();
    await client.waitFor(m => m.type === 'welcome');

    const killsBefore = killCalls.length;
    client.ws.send(JSON.stringify({ type: 'quit-confirm', action: 'detach' }));
    const err = await client.waitFor(m => m.type === 'error');
    expect(String(err.message)).toContain('quit-confirm rejected');

    // The dangerous path defers SIGTERM by 150ms; wait past that window.
    await sleep(400);
    expect(killCalls.length).toBe(killsBefore);
    client.close();
  });

  test('after /quit with running children, quit-confirm from the SAME client proceeds', async () => {
    // No lessons module → /quit returns plain Goodbye without export side-effects.
    mod.setApp(makeStubApp([makeFleetStub()]));
    const client = await connectClient();
    await client.waitFor(m => m.type === 'welcome');

    client.ws.send(JSON.stringify({ type: 'command', command: '/quit', corrId: 'q1' }));
    const prompt = await client.waitFor(m => m.type === 'quit-confirm-required');
    expect(prompt.children).toEqual(['childA']);

    const killsBefore = killCalls.length;
    client.ws.send(JSON.stringify({ type: 'quit-confirm', action: 'detach' }));
    // scheduleShutdown fires after ~150ms; poll for the recorded SIGTERM.
    const start = Date.now();
    while (killCalls.length === killsBefore && Date.now() - start < 2000) await sleep(25);
    expect(killCalls.length).toBe(killsBefore + 1);
    expect(killCalls[killCalls.length - 1]!.signal).toBe('SIGTERM');
    client.close();
  });

  test('the token is single-use: a second quit-confirm is rejected', async () => {
    mod.setApp(makeStubApp([makeFleetStub()]));
    const client = await connectClient();
    await client.waitFor(m => m.type === 'welcome');

    client.ws.send(JSON.stringify({ type: 'command', command: '/quit', corrId: 'q2' }));
    await client.waitFor(m => m.type === 'quit-confirm-required');

    // First response consumes the token (cancel = keep running, no kill).
    client.ws.send(JSON.stringify({ type: 'quit-confirm', action: 'cancel' }));
    await sleep(100);
    const killsBefore = killCalls.length;
    // Second attempt must be rejected — the arming died with the first use.
    client.ws.send(JSON.stringify({ type: 'quit-confirm', action: 'detach' }));
    const err = await client.waitFor(m => m.type === 'error');
    expect(String(err.message)).toContain('quit-confirm rejected');
    await sleep(400);
    expect(killCalls.length).toBe(killsBefore);
    client.close();
  });
});

// ---------------------------------------------------------------------------
// [M] 4.2 — welcome-race trace buffering + monotonic seq
// ---------------------------------------------------------------------------

describe('trace seq + welcome-race buffering', () => {
  test('trace fired while welcome builds is delivered after the welcome, seq monotonic', async () => {
    mod.setApp(makeStubApp());
    const client = await connectClient();
    await client.waitFor(m => m.type === 'welcome');
    const framesBefore = client.messages.length;

    // Re-bind the app: setApp clears `welcomed`, arms the pending buffer, and
    // kicks off a fresh async welcome. Firing a trace synchronously right
    // after lands exactly in the welcome-construction window — pre-fix this
    // frame was silently dropped for the client.
    mod.setApp(makeStubApp());
    expect(lastTraceCb).not.toBeNull();
    lastTraceCb!({ type: 'custom:during-welcome', marker: 1 });

    await client.waitFor(
      m => m.type === 'trace' && (m.event as { type?: string })?.type === 'custom:during-welcome',
    );
    const newFrames = client.messages.slice(framesBefore);
    const welcomeIdx = newFrames.findIndex(m => m.type === 'welcome');
    const traceIdx = newFrames.findIndex(
      m => m.type === 'trace' && (m.event as { type?: string })?.type === 'custom:during-welcome',
    );
    expect(welcomeIdx).toBeGreaterThanOrEqual(0);
    expect(traceIdx).toBeGreaterThan(welcomeIdx); // buffered, flushed AFTER welcome

    const firstSeq = (newFrames[traceIdx] as { seq?: number }).seq;
    expect(typeof firstSeq).toBe('number');

    // A later trace must carry a strictly greater seq.
    lastTraceCb!({ type: 'custom:after-welcome', marker: 2 });
    const second = await client.waitFor(
      m => m.type === 'trace' && (m.event as { type?: string })?.type === 'custom:after-welcome',
    );
    expect((second as { seq?: number }).seq!).toBeGreaterThan(firstSeq!);
    client.close();
  });
});

// ---------------------------------------------------------------------------
// [M-L] 4.4a — fleet-request TTL expires via the timer, not the next click
// ---------------------------------------------------------------------------

describe('fleet-request prune timer', () => {
  test('a wedged child request times out without a second request', async () => {
    // Fleet stub that accepts the lessons dispatch but never replies (wedged).
    mod.setApp(makeStubApp([
      makeFleetStub({ requestLessons: (_scope: string, _corrId: string) => true }),
    ]));
    const client = await connectClient();
    await client.waitFor(m => m.type === 'welcome');

    client.ws.send(JSON.stringify({ type: 'request-lessons', scope: 'childA' }));
    // The entry lands with a 30s TTL; shrink it so the 5s sweep catches it.
    const startWait = Date.now();
    let pending = __getPendingFleetRequestsForTests();
    while ((pending?.size ?? 0) === 0 && Date.now() - startWait < 3000) {
      await sleep(20);
      pending = __getPendingFleetRequestsForTests();
    }
    expect(pending!.size).toBe(1);
    for (const entry of pending!.values()) entry.expiresAt = Date.now() - 1;

    // No further client activity — only the interval sweep can fire this.
    const err = await client.waitFor(m => m.type === 'error', 12_000);
    expect(String(err.message)).toContain('timed out');
    expect(pending!.size).toBe(0);
    client.close();
  }, 20_000);
});

// ---------------------------------------------------------------------------
// [M-L] 4.4b — lessons-list frame cap
// ---------------------------------------------------------------------------

describe('lessons-list cap', () => {
  test('a large library is capped at 500 most-recent with truncated/total', async () => {
    const lessons = Array.from({ length: 620 }, (_, i) => ({
      id: `lesson-${i}`,
      content: `content ${i}`,
      confidence: 0.5,
      tags: [],
      deprecated: false,
      created: 1_000 + i, // strictly increasing recency by index
    }));
    mod.setApp(makeStubApp([{ name: 'lessons', getLessons: () => lessons }]));
    const client = await connectClient();
    await client.waitFor(m => m.type === 'welcome');

    client.ws.send(JSON.stringify({ type: 'request-lessons' }));
    const frame = await client.waitFor(m => m.type === 'lessons-list');
    const list = frame.lessons as Array<{ id: string }>;
    expect(list.length).toBe(500);
    expect(frame.truncated).toBe(true);
    expect(frame.total).toBe(620);
    // Most recent 500 = indexes 120..619, original order preserved.
    expect(list[0]!.id).toBe('lesson-120');
    expect(list[list.length - 1]!.id).toBe('lesson-619');
    client.close();
  });

  test('a small library ships whole, no truncated flag', async () => {
    const lessons = [{
      id: 'only', content: 'x', confidence: 1, tags: [], deprecated: false, created: 1,
    }];
    mod.setApp(makeStubApp([{ name: 'lessons', getLessons: () => lessons }]));
    const client = await connectClient();
    await client.waitFor(m => m.type === 'welcome');

    client.ws.send(JSON.stringify({ type: 'request-lessons' }));
    const frame = await client.waitFor(m => m.type === 'lessons-list');
    expect((frame.lessons as unknown[]).length).toBe(1);
    expect(frame.truncated).toBeUndefined();
    client.close();
  });
});

// ---------------------------------------------------------------------------
// [M] 4.3 — WS backpressure accounting (unit-level, fake ws)
// ---------------------------------------------------------------------------

describe('sendFrame backpressure', () => {
  function makeFakeClient(sendResult: () => number): SendFrameTarget & { closed: Array<{ code?: number; reason?: string }> } {
    const closed: Array<{ code?: number; reason?: string }> = [];
    return {
      id: 99,
      backpressureCount: 0,
      closed,
      ws: {
        send: (_data: string) => sendResult(),
        close: (code?: number, reason?: string) => { closed.push({ code, reason }); },
      },
    };
  }

  test('sustained -1 results close the client exactly once at the threshold', () => {
    const client = makeFakeClient(() => -1);
    for (let i = 0; i < 49; i++) {
      __sendFrameForTests(client, { type: 'ping' } as never);
    }
    expect(client.closed.length).toBe(0); // below threshold: still open
    __sendFrameForTests(client, { type: 'ping' } as never); // 50th
    expect(client.closed.length).toBe(1);
    expect(client.closed[0]!.code).toBe(1013);
    // Further sends past the threshold don't re-close.
    __sendFrameForTests(client, { type: 'ping' } as never);
    expect(client.closed.length).toBe(1);
  });

  test('a successful send resets the counter — intermittent backpressure never closes', () => {
    let results: number[] = [];
    const client = makeFakeClient(() => results.shift() ?? 100);
    results = [...Array(49).fill(-1), 100, ...Array(49).fill(-1), 100];
    for (let i = 0; i < 100; i++) {
      __sendFrameForTests(client, { type: 'ping' } as never);
    }
    expect(client.closed.length).toBe(0);
    expect(client.backpressureCount).toBe(0);
  });

  test('dropped sends (0) count toward the threshold too', () => {
    const client = makeFakeClient(() => 0);
    for (let i = 0; i < 50; i++) {
      __sendFrameForTests(client, { type: 'ping' } as never);
    }
    expect(client.closed.length).toBe(1);
  });
});
