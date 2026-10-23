/**
 * What each client of the Web UI is sent: an operator, and observers granted
 * health, messages, the conversation's interior, and everything. Each
 * grant's scopes are what the grant tool promises the resident ("'health' =
 * liveness/usage only; ...") and the deployment doc promises the operator
 * ("Each observer sees only its grant's scopes"), so a frame reaches an
 * observer only when its grant covers what the frame carries.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { continuesBody, type BodyShard } from '@animalabs/context-manager';
import { BASIC, startObservedHost, type Connection, type ObservedHost } from './web-ui-observed-host.js';

describe('what each client is sent', () => {
  let host: ObservedHost;
  let branch = { id: 'b1', name: 'main' };
  let stored: Record<string, unknown> | null = null;
  let hostStatus: Record<string, unknown> = { quiesced: false };
  let ledgerUpdate: ((ledger: unknown) => void) | undefined;
  let transcript: Record<string, unknown>[] = [];
  let appended: ((event: { type: string; message?: unknown }) => void) | undefined;
  let ledgerNow: unknown;
  // Failure text, as each place in health that carries one would hold it.
  const TEXT = {
    call: 'overloaded_error: the provider is overloaded',
    cooldown: 'cooling down after overloaded_error',
    wait: 'the provider asked for a wait of 30s',
    lastError: 'the last turn failed: overloaded_error',
    debt: 'The compression report failed.\nCause: the store said no.',
    read: 'the store refused the read',
    quota: 'the usage endpoint answered 500',
    credential: 'anthropic rejected the credential (invalid x-api-key)',
    action: 'refresh failed: the token endpoint answered 400',
  };
  // The credential monitor's state, a rejected credential after a failed refresh.
  const login = { verificationUrl: 'https://example.invalid/device', userCode: 'ABCD-1234' };
  const credentialState = {
    kind: 'auth-rejected', provider: 'anthropic', message: TEXT.credential, since: 1, rotatable: true,
    actions: [{ id: 'refresh', label: 'Refresh' }], login, lastAction: { id: 'refresh', at: 2, ok: false, message: TEXT.action },
  };
  // Told of each windowed read, before it's answered: where it begins and how many slots it asks for.
  let onRead: ((offset: number, limit: number) => void) | undefined;
  // The store's windowed reads, which the welcome and history pages take, and
  // its listener, which message-appended comes from.
  const cm = {
    getMessageCount: () => transcript.length,
    getMessageWindow: (offset: number, limit: number, opts?: { alignToBodyGroups?: boolean }) => {
      onRead?.(offset, limit);
      // As the store does with alignToBodyGroups, a window that begins inside
      // a sharded body begins at its first shard. (The store also carries a
      // window's end to its body's last shard, which no test here needs.)
      let start = offset;
      while (opts?.alignToBodyGroups && start > 0 && continuesBody(transcript[start - 1] as BodyShard, transcript[start] as BodyShard)) start--;
      return { messages: transcript.slice(start, offset + limit), startIndex: start, totalCount: transcript.length };
    },
    onMessage: (listener: (event: { type: string; message?: unknown }) => void) => {
      appended = listener;
      return () => { if (appended === listener) appended = undefined; };
    },
    currentBranch: () => branch,
    getMessage: (id: string) => transcript.find((m) => m.id === id) ?? stored,
    getStrategy: () => ({
      getCompressionQuarantineStatus: () => ({
        count: 1,
        keys: ['q1'],
        spans: [{ chunkSourceHash: 'h1', firstMessageId: 'm1', lastMessageId: 'm2', closedAgeMs: 1, quarantinedAt: 1, records: 1, answeredAttempts: 1, latestOutcome: 'refusal' }],
      }),
      getCompressionDebt: () => ({ state: 'unknown', error: TEXT.debt, failure: 'report', pendingChunks: null }),
    }),
    getRenderStats: () => {
      throw new Error(TEXT.read);
    },
  };
  const agent = { name: 'main', model: 'a-model', getContextManager: () => cm };
  // The framework's agents: a test empties it to bind a host with no agent store.
  let agents = [agent];
  // A child's panel answers, as a fleet child's panel ops give them.
  const panels: Record<string, unknown> = {
    'pin-add': { agent: 'main', pins: [], pinsSupported: true, levelHonored: false, candidates: [{ id: 'm1', index: 0, participant: 'user', text: 'a pinned line' }] },
    'settings-update': { agent: 'main', settings: { contextBudgetTokens: 1000, transition: 'stable' }, overrides: [], hotKeys: [], hotConfigurable: true, previewAvailable: false },
    'credential-action': { subscription: false },
    media: { mediaType: 'image/png', base64: 'CCCC' },
  };
  const fleet = {
    name: 'fleet',
    getChildren: () => new Map(),
    autoStartLaunching: () => new Set(),
    onChildEvent: () => () => {},
    requestPanel: async (_child: string, op: string) => ({ ok: true, data: panels[op] }),
  };
  const open: Connection[] = [];

  beforeAll(async () => {
    host = await startObservedHost({
      grants: {
        dashboard: ['health'],
        reader: ['messages'],
        interior: ['messages', 'thinking', 'tools'],
        everything: ['health', 'ops', 'messages', 'thinking', 'tools'],
      },
      framework: {
        getAllAgents: () => agents,
        getAllModules: () => [fleet],
        getAgent: (name: string) => (name === 'main' ? agent : undefined),
        getHostModeStatus: () => hostStatus,
        getAgentRuntimeSettings: () => ({ contextBudgetTokens: 1000, transition: 'stable' }),
        // agent-framework's healthSnapshot, with a failure in each place it
        // carries one.
        healthSnapshot: () => ({
          at: '2026-10-22T06:00:00.000Z',
          uptimeSec: 5,
          gate: { inferring: ['main'], bufferedEvents: 0, droppedBufferedEvents: 0, sleepUntil: 0 },
          pendingRequests: 0,
          activeStreams: ['main'],
          agents: [{
            name: 'main',
            status: 'inferring',
            consecutiveInferenceFailures: 1,
            providerAdmission: {
              primaryActive: true,
              cooldownUntil: 2,
              cooldownReason: TEXT.cooldown,
              hostHold: false,
              lastRecovery: null,
              providerWaits: [{ model: 'a-model', until: '2026-10-22T06:05:00.000Z', reason: TEXT.wait, setAt: '2026-10-22T06:00:00.000Z' }],
            },
            lastInference: { startedAt: 1, failedAt: 2, lastError: TEXT.lastError },
            refusalStats: { total: 1, byCategory: { policy: 1 }, lastAt: 3, lastCategory: 'policy' },
          }],
        }),
      },
      sessionManager: { getActiveSession: () => ({ id: 's1', name: 'Debugging the bridge', manuallyNamed: false }) },
      config: {
        callLedger: {
          snapshot: () => ledgerNow,
          onUpdate: (update: (ledger: unknown) => void) => {
            ledgerUpdate = update;
            return () => {};
          },
        },
        credentials: { snapshot: () => credentialState, runAction: async () => credentialState },
        quotaMeter: {
          provider: 'anthropic',
          refresh: async () => ({ provider: 'anthropic', windows: [], fetchedAt: 1, error: TEXT.quota }),
          blockedUntil: () => null,
        },
      },
    });
  });

  afterAll(async () => {
    for (const c of open) c.ws.close();
    await host.stop();
  });

  async function everyone() {
    const clients = {
      operator: await host.operator(),
      dashboard: await host.observer('dashboard'),
      reader: await host.observer('reader'),
      interior: await host.observer('interior'),
      everything: await host.observer('everything'),
    };
    open.push(...Object.values(clients));
    return clients;
  }

  test("a child's events reach an observer only as its scopes cover what each carries, whole, and an operator's command output and kinds no scope names reach full clients alone", async () => {
    const c = await everyone();
    const events = [
      { type: 'message:added', messageId: 'm1', source: 'mcpl:channel-incoming' },
      { type: 'inference:tokens', blockType: 'thinking', content: 'private' },
      { type: 'inference:speech', agentName: 'kid', content: 'thought, then said' },
      { type: 'lifecycle', phase: 'ready', pid: 1, dataDir: '/data/kid' },
      { type: 'snapshot', asOfTs: 1, child: { name: 'kid', pid: 1, startedAt: 1 }, tree: { nodes: [{ secret: true }], callIdIndex: {} } },
      { type: 'command-output', text: 'status of kid', style: null },
      { type: 'a-kind-added-later' },
      { type: 'private:new-kind', detail: 'its own' },
      { type: 'inference:failed', agentName: 'kid', error: 'provider said no' },
      { type: 'usage:updated', totals: { inputTokens: 1, outputTokens: 1 } },
    ];
    const ended = { type: 'stream-ended', agentName: 'kid' };
    const fleetEvents = host.module as unknown as { handleFleetEvent(name: string, event: unknown): void };
    for (const event of events) fleetEvents.handleFleetEvent('kid', event);
    await host.fence(Object.values(c));
    const kinds = (conn: Connection) => conn.framesOf('child-event').map((f) => (f.event as { type: string }).type);
    // An operator gets each event as the child sent it, named for the child.
    expect(c.operator.framesOf('child-event')).toEqual(events.map((event) => ({ type: 'child-event', childName: 'kid', event })));
    expect(kinds(c.dashboard)).toEqual(['lifecycle', 'usage:updated']);
    // A client that holds messages gets the stand-in for the failure, as a child event.
    expect(kinds(c.reader)).toEqual(['message:added', 'stream-ended']);
    expect(kinds(c.interior)).toEqual(['message:added', 'inference:tokens', 'inference:speech', 'stream-ended']);
    for (const conn of [c.reader, c.interior]) {
      expect(conn.framesOf('child-event').at(-1)).toEqual({ type: 'child-event', childName: 'kid', event: ended });
    }
    expect(kinds(c.everything)).toEqual([
      'message:added', 'inference:tokens', 'inference:speech', 'lifecycle', 'snapshot', 'inference:failed', 'usage:updated',
    ]);
    for (const conn of Object.values(c)) expect(conn.framesOf('stream-ended')).toEqual([]);
    // The fleet's total that the child's usage updated is usage, which needs health.
    for (const conn of [c.operator, c.dashboard, c.everything]) expect(conn.framesOf('usage').length).toBe(1);
    for (const conn of [c.reader, c.interior]) expect(conn.framesOf('usage')).toEqual([]);
  });

  test("the host's own traces reach an observer only as its scopes cover what each carries", async () => {
    const c = await everyone();
    const traces = [
      { type: 'tool:started', module: 'shell', tool: 'run', callId: 't1', input: { cmd: 'ls' } },
      { type: 'inference:failed', agentName: 'main', error: 'provider said no' },
      { type: 'host:quiesce', drained: true, activeTurns: 0 },
      { type: 'a-trace-added-later' },
      { type: 'usage:updated', totals: { inputTokens: 2, outputTokens: 2 } },
    ];
    for (const trace of traces) host.emitTrace(trace);
    await host.fence(Object.values(c));
    const kinds = (conn: Connection) => conn.framesOf('trace').map((f) => (f.event as { type: string }).type);
    expect(kinds(c.operator)).toEqual(traces.map((t) => t.type));
    expect(kinds(c.dashboard)).toEqual(['host:quiesce', 'usage:updated']);
    expect(kinds(c.reader)).toEqual([]);
    expect(kinds(c.interior)).toEqual(['tool:started']);
    expect(kinds(c.everything)).toEqual(['tool:started', 'inference:failed', 'host:quiesce', 'usage:updated']);
    for (const conn of [c.operator, c.dashboard, c.everything]) expect(conn.framesOf('usage').length).toBe(1);
    for (const conn of [c.reader, c.interior]) expect(conn.framesOf('usage')).toEqual([]);
  });

  test("a client that holds messages but may not have a stream-end trace gets a stream-ended frame in its place, naming only the agent", async () => {
    const c = await everyone();
    host.emitTrace({ type: 'inference:failed', agentName: 'main', error: 'provider said no', stack: 'at somewhere' });
    host.emitTrace({ type: 'inference:completed', agentName: 'main', tokenUsage: { input: 1, output: 1 } });
    host.emitTrace({ type: 'inference:aborted', agentName: 'main', reason: 'interrupted from the Web UI' });
    await host.fence(Object.values(c));
    const ends = (conn: Connection) => conn.frames
      .filter((f) => f.type === 'trace' || f.type === 'stream-ended')
      .map((f) => (f.type === 'trace' ? (f.event as { type: string }).type : f));
    for (const conn of [c.operator, c.everything]) {
      expect(ends(conn)).toEqual(['inference:failed', 'inference:completed', 'inference:aborted']);
    }
    // Without ops the failure's error and stack stay back, and why the turn
    // was stopped; without health the completion's usage. That the stream
    // ended still arrives.
    for (const conn of [c.reader, c.interior]) {
      expect(ends(conn)).toEqual([
        { type: 'stream-ended', agentName: 'main' },
        { type: 'stream-ended', agentName: 'main' },
        { type: 'stream-ended', agentName: 'main' },
      ]);
    }
    expect(ends(c.dashboard)).toEqual([]);
  });

  test("an incoming message's excerpt reaches only clients that hold messages", async () => {
    const c = await everyone();
    stored = { participant: 'user', content: [{ type: 'text', text: 'hello from zulip' }], metadata: {}, timestamp: new Date() };
    host.emitTrace({ type: 'message:added', messageId: 'm1', source: 'mcpl:channel-incoming' });
    await host.fence(Object.values(c));
    for (const conn of [c.operator, c.reader, c.interior, c.everything]) {
      expect(conn.framesOf('inbound-trigger').map((f) => f.text)).toEqual(['hello from zulip']);
    }
    expect(c.dashboard.framesOf('inbound-trigger')).toEqual([]);
  });

  test("an image a tool returned reaches only clients that hold tools, in the welcome, a history page, a live message and at /media, a child's too, and an image in a message reaches every client that holds messages", async () => {
    const png = (data: string) => ({ type: 'image', source: { type: 'base64', mediaType: 'image/png', data } });
    transcript = [
      { id: 'm1', participant: 'assistant', content: [{ type: 'text', text: 'looking' }, { type: 'tool_use', id: 't1', name: 'camera', input: {} }] },
      { id: 'm2', participant: 'user', content: [
        { type: 'tool_result', toolUseId: 't1', content: [{ type: 'text', text: 'a frame' }, png('AAAA')] },
        { type: 'text', text: 'and this' },
        png('BBBB'),
      ] },
    ];
    try {
      const c = await everyone();
      type Entry = { blocks: { kind: string }[] };
      const media = (entries: Entry[]) => entries.flatMap((m) => m.blocks).filter((b) => b.kind === 'media');
      const ofTool = { kind: 'media', mediaType: 'image/png', ref: 'm2/0.1', toolUseId: 't1' };
      const ofMessage = { kind: 'media', mediaType: 'image/png', ref: 'm2/2' };
      const welcomed = (conn: Connection) => media(conn.framesOf('welcome')[0]!.messages as Entry[]);
      expect(welcomed(c.reader)).toEqual([ofMessage]);
      expect(welcomed(c.interior)).toEqual([ofTool, ofMessage]);
      expect(welcomed(c.operator)).toEqual([ofTool, ofMessage]);

      const paged = async (conn: Connection, corrId: string) => {
        conn.ws.send(JSON.stringify({ type: 'request-history', corrId, beforeIndex: 2 }));
        return media((await conn.until('history-page', (f) => f.corrId === corrId)).entries as Entry[]);
      };
      expect(await paged(c.reader, 'h-reader')).toEqual([ofMessage]);
      expect(await paged(c.interior, 'h-interior')).toEqual([ofTool, ofMessage]);

      const m3 = { id: 'm3', participant: 'user', content: [
        { type: 'tool_result', toolUseId: 't2', content: [png('CCCC')] },
        { type: 'text', text: 'and another' },
      ] };
      transcript.push(m3);
      appended!({ type: 'add', message: m3 });
      await host.fence(Object.values(c));
      const live = (conn: Connection) => conn.framesOf('message-appended').map((f) => f.entry as Entry);
      expect(live(c.reader).map((e) => e.blocks)).toEqual([[{ kind: 'text', text: 'and another' }]]);
      expect(media(live(c.interior))).toEqual([{ kind: 'media', mediaType: 'image/png', ref: 'm3/0.0', toolUseId: 't2' }]);

      // /media: a message's own image is a top-level block (`<n>`); any other
      // path, such as a tool result's nested one, takes tools as well, an
      // encoded dot and a fleet child's request included. The stub fleet
      // answers every child's media request with CCCC.
      const get = async (conn: Connection, path: string) => {
        const res = await fetch(`http://127.0.0.1:${host.port}${path}`, {
          headers: { cookie: `fkm_obs=${conn.framesOf('observer-ack')[0]!.sessionToken as string}` },
        });
        return res.status === 200 ? Buffer.from(await res.arrayBuffer()).toString('base64') : res.status;
      };
      expect(await get(c.reader, '/media/m2/2')).toBe('BBBB');
      expect(await get(c.reader, '/media/m2/0.1')).toBe(401);
      expect(await get(c.reader, '/media/m2/0%2E1')).toBe(401);
      expect(await get(c.reader, '/media/m2/0.1?scope=kid')).toBe(401);
      expect(await get(c.interior, '/media/m2/0.1')).toBe('AAAA');
      expect(await get(c.interior, '/media/m2/0.1?scope=kid')).toBe('CCCC');
      expect(await get(c.dashboard, '/media/m2/2')).toBe(401);
    } finally {
      transcript = [];
    }
  });

  describe('a message whose every block its scopes remove', () => {
    type Entry = { id?: string };
    const ids = (entries: unknown) => (entries as Entry[]).map((e) => e.id);
    const say = (id: string, participant: string, content: unknown[], body?: { bodyGroupId: string; shardIndex: number }) =>
      ({ id, participant, content, ...body });
    const toolUse = (id: string, call: string) => say(id, 'assistant', [{ type: 'tool_use', id: call, name: 'shell', input: {} }]);
    const toolResult = (id: string, call: string, body?: { bodyGroupId: string; shardIndex: number }) =>
      say(id, 'user', [{ type: 'tool_result', toolUseId: call, content: [{ type: 'text', text: 'out' }] }], body);
    const page = async (conn: Connection, corrId: string, beforeIndex: number, limit = 2) => {
      conn.ws.send(JSON.stringify({ type: 'request-history', corrId, beforeIndex, limit }));
      const f = await conn.until('history-page', (p) => p.corrId === corrId);
      return { ids: ids(f.entries), startIndex: f.startIndex, totalCount: f.totalCount };
    };
    // Each read from here on, as [where it began, how many slots it asked for].
    const recordReads = () => {
      const reads: [number, number][] = [];
      onRead = (offset, size) => { reads.push([offset, size]); };
      return reads;
    };

    test("doesn't reach a client in its welcome, live, or in a page, which reads back past such messages to one the client may see, or to the start", async () => {
      transcript = [
        toolUse('m0', 't0'),
        toolResult('m1', 't0'),
        say('m2', 'user', [{ type: 'text', text: 'a word' }]),
        toolUse('m3', 't1'),
        toolResult('m4', 't1'),
        say('m5', 'assistant', [{ type: 'thinking', thinking: 'mulling' }]),
        toolUse('m6', 't2'),
      ];
      try {
        const c = await everyone();
        expect(ids(c.reader.framesOf('welcome')[0]!.messages)).toEqual(['m2']);
        expect(ids(c.interior.framesOf('welcome')[0]!.messages)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6']);
        // The reader may see nothing of 3 to 6, so its page reads back to the window holding 2.
        expect(await page(c.reader, 'r-back', 7)).toEqual({ ids: ['m2'], startIndex: 1, totalCount: 7 });
        const backPage = c.reader.framesOf('history-page').find((f) => f.corrId === 'r-back')!;
        expect((backPage.entries as { index: number }[])[0]!.index).toBe(2);
        // Before 2 it may see nothing, and history starts two windows back: an
        // empty page, and no read past the start.
        const reads = recordReads();
        expect(await page(c.reader, 'r-start', 2, 1)).toEqual({ ids: [], startIndex: 0, totalCount: 7 });
        expect(reads).toEqual([[1, 1], [0, 1]]);
        onRead = undefined;
        expect(await page(c.interior, 'i-back', 7)).toEqual({ ids: ['m5', 'm6'], startIndex: 5, totalCount: 7 });
        expect(await page(c.operator, 'o-back', 7)).toEqual({ ids: ['m5', 'm6'], startIndex: 5, totalCount: 7 });

        for (const m of [toolUse('m7', 't3'), say('m8', 'assistant', [{ type: 'text', text: 'done' }])]) {
          transcript.push(m);
          appended!({ type: 'add', message: m });
        }
        await host.fence(Object.values(c));
        const live = (conn: Connection) => ids(conn.framesOf('message-appended').map((f) => f.entry));
        expect(live(c.reader)).toEqual(['m8']);
        expect(live(c.interior)).toEqual(['m7', 'm8']);
      } finally {
        onRead = undefined;
        transcript = [];
      }
    });

    test('a page reads back from where the store began each window, a sharded body\'s first shard included', async () => {
      const body = (shardIndex: number) => ({ bodyGroupId: 'bg-out', shardIndex });
      transcript = [
        say('m0', 'user', [{ type: 'text', text: 'a word' }]),
        toolUse('m1', 't0'),
        toolResult('m2', 't0', body(0)),
        toolResult('m3', 't0', body(1)),
        toolResult('m4', 't0', body(2)),
        toolUse('m5', 't1'),
      ];
      try {
        const c = await everyone();
        // The window asked for at 4 begins at the body's first shard, 2.
        const reads = recordReads();
        expect(await page(c.reader, 'r-body', 6)).toEqual({ ids: ['m0'], startIndex: 0, totalCount: 6 });
        expect(reads).toEqual([[4, 2], [0, 2]]);
        expect(await page(c.interior, 'i-body', 6)).toEqual({ ids: ['m2', 'm5'], startIndex: 2, totalCount: 6 });
      } finally {
        onRead = undefined;
        transcript = [];
      }
    });

    test('a welcome whose tail such messages fill reads back too, on connecting and when a refresh welcomes the client again', async () => {
      transcript = [say('m0', 'user', [{ type: 'text', text: 'a word' }]), ...Array.from({ length: 250 }, (_, i) => toolUse(`m${i + 1}`, `t${i}`))];
      try {
        const c = await everyone();
        const welcomed = (conn: Connection) => {
          const w = conn.framesOf('welcome').at(-1)!;
          return { ids: ids(w.messages), history: w.history };
        };
        const tail = Array.from({ length: 200 }, (_, i) => `m${i + 51}`);
        expect(welcomed(c.reader)).toEqual({ ids: ['m0'], history: { startIndex: 0, totalCount: 251 } });
        expect(welcomed(c.interior)).toEqual({ ids: tail, history: { startIndex: 51, totalCount: 251 } });
        // Without messages there's nothing to read back for.
        expect(welcomed(c.dashboard)).toEqual({ ids: [], history: { startIndex: 251, totalCount: 251 } });
        // A refresh, as a change of branch sends, welcomes every client again.
        await host.fence([c.reader, c.interior]);
        expect(c.reader.framesOf('welcome').length).toBe(2);
        expect(welcomed(c.reader)).toEqual({ ids: ['m0'], history: { startIndex: 0, totalCount: 251 } });
        expect(welcomed(c.interior)).toEqual({ ids: tail, history: { startIndex: 51, totalCount: 251 } });
        // Past ten windows of 200 before the tail, the welcome comes empty, from where the reading stopped.
        transcript = [say('m0', 'user', [{ type: 'text', text: 'a word' }]), ...Array.from({ length: 2300 }, (_, i) => toolUse(`m${i + 1}`, `t${i}`))];
        await host.fence([c.reader, c.interior]);
        expect(welcomed(c.reader)).toEqual({ ids: [], history: { startIndex: 101, totalCount: 2301 } });
        expect(welcomed(c.interior).history).toEqual({ startIndex: 2101, totalCount: 2301 });
      } finally {
        transcript = [];
      }
    });

    test("an observer's welcome still comes when the host has no agent store to read back from", async () => {
      const c = await everyone();
      agents = [];
      try {
        await host.fence([c.reader]);
        expect(c.reader.framesOf('welcome').at(-1)!.messages).toEqual([]);
      } finally {
        agents = [agent];
      }
    });

    test('a page reads back at most ten windows of its own size, then answers empty from where it stopped, and the next page reads on from there', async () => {
      transcript = [say('m0', 'user', [{ type: 'text', text: 'a word' }]), ...Array.from({ length: 25 }, (_, i) => toolUse(`m${i + 1}`, `t${i}`))];
      try {
        const c = await everyone();
        const reads = recordReads();
        expect(await page(c.reader, 'r-ten', 26)).toEqual({ ids: [], startIndex: 6, totalCount: 26 });
        expect(reads).toEqual([24, 22, 20, 18, 16, 14, 12, 10, 8, 6].map((offset) => [offset, 2]));
        expect(await page(c.reader, 'r-on', 6)).toEqual({ ids: ['m0'], startIndex: 0, totalCount: 26 });
      } finally {
        onRead = undefined;
        transcript = [];
      }
    });
  });

  test('the serving state and the agents\' models reach clients that hold health in the welcome, the serving state live too, and provider calls live', async () => {
    hostStatus = { quiesced: false };
    const c = await everyone();
    const first = (conn: Connection) => conn.framesOf('welcome')[0]!;
    expect(first(c.dashboard).hostMode).toMatchObject({ mode: 'serving' });
    expect(first(c.dashboard).agents).toEqual([{ name: 'main', model: 'a-model' }]);
    expect(first(c.reader).hostMode).toBeUndefined();
    expect(first(c.reader).agents).toEqual([{ name: 'main', model: '' }]);
    hostStatus = { quiesced: true, drained: true };
    (host.module as unknown as { broadcastHostMode(): void }).broadcastHostMode();
    ledgerUpdate!({ calls: [{ model: 'a-model', costUsd: 0.01 }] });
    await host.fence(Object.values(c));
    for (const conn of [c.operator, c.dashboard, c.everything]) {
      expect(conn.framesOf('host-mode').map((f) => (f.hostMode as { mode: string }).mode)).toEqual(['quiesced']);
      expect(conn.framesOf('call-ledger').length).toBe(1);
    }
    for (const conn of [c.reader, c.interior]) {
      expect(conn.framesOf('host-mode')).toEqual([]);
      expect(conn.framesOf('call-ledger')).toEqual([]);
    }
  });

  test("a client that holds health and not ops gets health without failure text: the call ledger live and in the welcome, and /healthz and /quota, the host's and a child's", async () => {
    const c = await everyone();
    const row = { timestamp: '2026-10-22T06:00:00.000Z', kind: 'stream', originEstimate: 'turn~', model: 'a-model', messages: 3, durationMs: 10, cache: { ttls: ['5m'], effectiveTtl: '5m' } };
    const ledger = {
      rows: [
        { ...row, id: 'c1', tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, verdict: 'ERROR', cause: TEXT.call, error: TEXT.call },
        { ...row, id: 'c2', tokens: { input: 1, output: 1, cacheRead: 9, cacheWrite: 0 }, verdict: 'HIT', cause: '90% from cache', stopReason: 'end_turn' },
      ],
      summary: { calls: 2, input: 2, output: 1, cacheRead: 9, cacheWrite: 0, cacheHitRatio: 0.9, byVerdict: { ERROR: 1, HIT: 1 } },
    };
    // A failed call's cause is its error's text; a cache hit's is the host's own words.
    const ledgerWithoutText = { ...ledger, rows: [{ ...ledger.rows[0]!, cause: '', error: '' }, ledger.rows[1]!] };
    ledgerNow = ledger;
    ledgerUpdate!(ledger);
    await host.fence(Object.values(c));
    const lastLedger = (conn: Connection) => conn.framesOf('call-ledger').at(-1)!.ledger;
    const welcomeLedger = (conn: Connection) => conn.framesOf('welcome').at(-1)!.callLedger;
    for (const conn of [c.operator, c.everything]) {
      expect(lastLedger(conn)).toEqual(ledger);
      expect(welcomeLedger(conn)).toEqual(ledger);
    }
    expect(lastLedger(c.dashboard)).toEqual(ledgerWithoutText);
    expect(welcomeLedger(c.dashboard)).toEqual(ledgerWithoutText);

    const get = async (path: string, who: Connection | null): Promise<Record<string, any>> => {
      const token = who && (who.framesOf('observer-ack')[0] as { sessionToken: string }).sessionToken;
      const res = await fetch(`http://127.0.0.1:${host.port}${path}`, { headers: token ? { cookie: `fkm_obs=${token}` } : { authorization: BASIC } });
      expect(res.status).toBe(200);
      return (await res.json()) as Record<string, any>;
    };
    // Which failure texts a body carries, as JSON writes them.
    const texts = (body: unknown) => Object.entries(TEXT)
      .filter(([, text]) => JSON.stringify(body).includes(JSON.stringify(text).slice(1, -1)))
      .map(([place]) => place);
    // A child answers with the snapshot and the quota it builds, as the host does.
    panels.health = await get('/healthz', null);
    panels.quota = await get('/quota', null);
    for (const path of ['/healthz', '/healthz?scope=kid']) {
      for (const who of [null, c.everything]) {
        expect(texts(await get(path, who))).toEqual(['call', 'cooldown', 'wait', 'lastError', 'debt', 'read', 'credential', 'action']);
      }
      const health = await get(path, c.dashboard);
      expect(texts(health)).toEqual([]);
      // Its names, codes, ids and times stay, and every key and list keeps its shape.
      const main = health.agents[0];
      expect(main).toMatchObject({ name: 'main', status: 'inferring', consecutiveInferenceFailures: 1, refusalStats: { lastCategory: 'policy', byCategory: { policy: 1 } } });
      expect(main.providerAdmission).toMatchObject({ cooldownUntil: 2, cooldownReason: '' });
      expect(main.providerAdmission.providerWaits).toEqual([{ model: 'a-model', until: '2026-10-22T06:05:00.000Z', reason: '', setAt: '2026-10-22T06:00:00.000Z' }]);
      expect(main.lastInference).toEqual({ startedAt: 1, failedAt: 2, lastError: '' });
      expect(health.gate.inferring).toEqual(['main']);
      expect(health.compressionDebt.main).toEqual({ state: 'unknown', error: '', failure: 'report', pendingChunks: null });
      expect(health.compressionQuarantine.main.spans).toEqual([{ chunkSourceHash: 'h1', firstMessageId: 'm1', lastMessageId: 'm2', closedAgeMs: 1, quarantinedAt: 1, records: 1, answeredAttempts: 1, latestOutcome: 'refusal' }]);
      expect(health.readFailures).toEqual({ main: { contextComposition: '' } });
      expect(health.runtimeSettings.main).toEqual({ contextBudgetTokens: 1000, transition: 'stable' });
      expect(health.callLedger).toEqual(ledgerWithoutText);
      // The credential keeps its kind and its device-code login.
      expect(health.credential).toMatchObject({ kind: 'auth-rejected', message: '', login, lastAction: { id: 'refresh', ok: false, message: '' } });
    }
    for (const path of ['/quota', '/quota?scope=kid']) {
      for (const who of [null, c.everything]) expect((await get(path, who)).error).toBe(TEXT.quota);
      expect(await get(path, c.dashboard)).toMatchObject({ subscription: true, provider: 'anthropic', windows: [], fetchedAt: 1, error: '' });
    }

    // The credential's state, by each route that carries it: /credential, the
    // request-credential reply, and the broadcast after an action.
    panels.credential = await get('/credential', null);
    for (const path of ['/credential', '/credential?scope=kid']) {
      for (const who of [null, c.everything]) expect(texts(await get(path, who))).toEqual(['credential', 'action']);
      expect(await get(path, c.dashboard)).toMatchObject({ subscription: true, kind: 'auth-rejected', message: '', login, lastAction: { id: 'refresh', ok: false, message: '' } });
    }
    for (const conn of [c.dashboard, c.everything]) {
      for (const scope of ['local', 'kid']) conn.ws.send(JSON.stringify({ type: 'request-credential', scope }));
    }
    c.operator.ws.send(JSON.stringify({ type: 'credential-action', scope: 'local', action: 'refresh' }));
    const credentialFrames = async (conn: Connection) => {
      const deadline = performance.now() + 5000;
      while (conn.framesOf('credential-state').length < 3) {
        if (performance.now() >= deadline) throw new Error('timed out waiting for credential-state');
        await new Promise((r) => setTimeout(r, 10));
      }
      return conn.framesOf('credential-state');
    };
    for (const frame of await credentialFrames(c.everything)) expect(texts(frame)).toEqual(['credential', 'action']);
    const bare = await credentialFrames(c.dashboard);
    expect(bare.map((f) => f.scope).sort()).toEqual(['kid', 'local', 'local']);
    for (const frame of bare) {
      expect(texts(frame)).toEqual([]);
      expect(frame).toMatchObject({ kind: 'auth-rejected', message: '', login, lastAction: { id: 'refresh', ok: false, message: '' } });
    }
  });

  test("a health read that fails whole still says it failed to a client that holds health and not ops, without what the failure said", async () => {
    const c = await everyone();
    const app = (host.module as unknown as { panelApp(): { framework: { healthSnapshot: () => unknown } } }).panelApp();
    const own = app.framework.healthSnapshot;
    const request = fleet.requestPanel;
    const answer = async (path: string, who: Connection | null) => {
      const token = who && (who.framesOf('observer-ack')[0] as { sessionToken: string }).sessionToken;
      const res = await fetch(`http://127.0.0.1:${host.port}${path}`, { headers: token ? { cookie: `fkm_obs=${token}` } : { authorization: BASIC } });
      return { status: res.status, body: await res.json() };
    };
    try {
      // The host's own snapshot throws, and a child answers each panel op with its failure.
      app.framework.healthSnapshot = () => { throw new Error(TEXT.read); };
      (fleet as { requestPanel: unknown }).requestPanel = async () => ({ ok: false, status: 500, error: TEXT.read });
      for (const path of ['/healthz', '/healthz?scope=kid', '/quota?scope=kid', '/credential?scope=kid']) {
        for (const who of [null, c.everything]) expect(await answer(path, who)).toEqual({ status: 500, body: { error: TEXT.read } });
        expect(await answer(path, c.dashboard)).toEqual({ status: 500, body: { error: '' } });
      }
      for (const conn of [c.dashboard, c.everything]) conn.ws.send(JSON.stringify({ type: 'request-credential', scope: 'kid' }));
      for (const conn of [c.dashboard, c.everything]) await conn.until('error');
      expect(c.everything.framesOf('error').map((f) => f.message)).toEqual([`credential on 'kid' failed: ${TEXT.read}`]);
      expect(c.dashboard.framesOf('error').map((f) => f.message)).toEqual(["credential on 'kid' failed"]);
    } finally {
      app.framework.healthSnapshot = own;
      (fleet as { requestPanel: unknown }).requestPanel = request;
    }
  });

  test("after a branch switch, branch-changed reaches clients that hold messages, and a health observer's refreshed welcome has the new branch's id and no names", async () => {
    branch = { id: 'b1', name: 'main' };
    const c = await everyone();
    branch = { id: 'b2', name: 'experiment' };
    // What a switch does after it lands: tell clients, then welcome them again.
    (host.module as unknown as { broadcastBranchChanged(): void }).broadcastBranchChanged();
    await host.fence(Object.values(c));
    for (const conn of [c.operator, c.reader, c.interior, c.everything]) {
      expect(conn.framesOf('branch-changed').map((f) => f.branch)).toEqual([{ id: 'b2', name: 'experiment' }]);
    }
    expect(c.dashboard.framesOf('branch-changed')).toEqual([]);
    const refreshed = c.dashboard.framesOf('welcome').at(-1)!;
    expect(refreshed.branch).toEqual({ id: 'b2', name: '' });
    expect(refreshed.session).toEqual({ id: 's1', name: '', autoNamed: true });
    const read = c.reader.framesOf('welcome').at(-1)!;
    expect(read.branch).toEqual({ id: 'b2', name: 'experiment' });
    expect(read.session).toEqual({ id: 's1', name: 'Debugging the bridge', autoNamed: true });
  });

  test("pins and context settings reach full clients alone, a child's as well as the host's, and credential state, the host's and a child's, reaches clients that hold health", async () => {
    const c = await everyone();
    const panelsHere = host.module as unknown as { broadcastPinsList(agent: string): void; broadcastSettingsState(agent: string): void };
    panelsHere.broadcastPinsList('main');
    panelsHere.broadcastSettingsState('main');
    c.operator.ws.send(JSON.stringify({ type: 'pin-add', scope: 'kid', firstMessageId: 'm1' }));
    c.operator.ws.send(JSON.stringify({ type: 'settings-update', scope: 'kid', contextBudgetTokens: 1000 }));
    c.operator.ws.send(JSON.stringify({ type: 'credential-action', scope: 'kid', action: 'recheck' }));
    c.operator.ws.send(JSON.stringify({ type: 'credential-action', scope: 'local', action: 'recheck' }));
    await c.operator.until('credential-state', (f) => f.scope === 'kid');
    await c.operator.until('credential-state', (f) => f.scope === 'local');
    await c.operator.until('pins-list', (f) => f.scope === 'kid');
    await c.operator.until('settings-state', (f) => f.scope === 'kid');
    await host.fence(Object.values(c));
    expect(c.operator.framesOf('pins-list').map((f) => f.scope)).toEqual(['local', 'kid']);
    expect(c.operator.framesOf('settings-state').map((f) => f.scope)).toEqual(['local', 'kid']);
    for (const conn of [c.dashboard, c.reader, c.interior, c.everything]) {
      expect(conn.framesOf('pins-list')).toEqual([]);
      expect(conn.framesOf('settings-state')).toEqual([]);
    }
    for (const conn of [c.dashboard, c.everything]) expect(conn.framesOf('credential-state').map((f) => f.scope).sort()).toEqual(['kid', 'local']);
    for (const conn of [c.reader, c.interior]) expect(conn.framesOf('credential-state')).toEqual([]);
  });

  test('a connection gets no live frame between a bind and its new welcome', async () => {
    const c = await host.operator();
    open.push(c);
    // A bind clears every client's welcome at once and sends each a new one
    // later, so a trace emitted in the same turn finds this one unwelcomed.
    host.rebind();
    host.emitTrace({ type: 'message:added', messageId: 'before', source: 'agent' });
    await host.fence([c]);
    host.emitTrace({ type: 'message:added', messageId: 'after', source: 'agent' });
    await host.fence([c]);
    expect(c.framesOf('trace').map((f) => (f.event as { messageId: string }).messageId)).toEqual(['after']);
  });
});
