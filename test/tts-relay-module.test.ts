/**
 * TtsRelayModule against a stand-in for the relay's /bot endpoint: it voices
 * only what the framework published (`inference:published`), one text block per
 * message on the channel it went to, and nothing of `inference:tokens` or
 * `inference:content_block`, which carry withheld text, thinking and tool
 * calls as they are written. A channel's activation lasts while any turn is
 * there, a start or end the relay didn't take goes when it's back, and an
 * interruption is read across the messages voiced on its channel since that
 * channel's last delivered start or the last interruption.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { ModuleContext, TraceEvent } from '@animalabs/agent-framework';
import { TtsRelayModule, mayBeSplit, readInterruption } from '../src/modules/tts-relay-module.js';

type RelayMessage = { type: string } & Record<string, unknown>;

interface Harness {
  received: RelayMessage[];
  /** The module's edit_message calls, and the notes it adds to the context. */
  edits: Array<Record<string, unknown>>;
  notes: string[];
  emit: (event: Record<string, unknown>) => void;
  /** The framework lets the agent go, as 0.22.2 does when an ephemeral
   *  run ends, an idle watchdog's disposal included, which sends no end. */
  dispose: (agentName: string) => void;
  /** The relay reports an interruption, as a voice client's would arrive. */
  interrupt: (event: { channelId: string; spokenText: string; reason?: string }) => void;
  stop: () => Promise<void>;
  /** Stop the module alone, leaving the relay up to see what it sends. */
  stopModule: () => Promise<void>;
  /** Close the relay's connections, leaving its server up, so the module
   *  reconnects. */
  dropConnections: () => void;
  /** The relay goes away: it drops the module's connection and answers no
   *  auth until `back`, so the module stays disconnected however fast it
   *  reconnects. */
  away: () => Promise<void>;
  /** The relay answers the module's auth again, and the module is back. */
  back: () => Promise<void>;
  /** The module's next send of this type fails with the relay still up, as
   *  a send that throws on an open socket does. */
  failNextSend: (type: string) => void;
  connected: () => boolean;
}

interface HarnessOptions {
  userId?: string;
  username?: string;
  /** What edit_message answers. Default success. */
  editResult?: { success: boolean; error?: string };
  reconnectIntervalMs?: number;
  notifyOnInterruption?: boolean;
  editServerId?: string;
}

const running: Harness[] = [];
afterEach(async () => {
  while (running.length > 0) await running.pop()!.stop();
});

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

/** A relay that answers the module's auth and records what it is sent, and
 *  the module started on a context whose traces the test emits. */
async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const { editResult = { success: true }, ...config } = options;
  const received: RelayMessage[] = [];
  const edits: Array<Record<string, unknown>> = [];
  const notes: string[] = [];
  const sockets = new Set<{ send(data: string): unknown; close(): void }>();
  let authHeld = false;
  const authWaiting: Array<{ send(data: string): unknown }> = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      return srv.upgrade(req) ? undefined : new Response('no', { status: 400 });
    },
    websocket: {
      open(ws) { sockets.add(ws); },
      close(ws) { sockets.delete(ws); },
      message(ws, raw) {
        const msg = JSON.parse(String(raw)) as RelayMessage;
        if (msg.type !== 'auth') received.push(msg);
        else if (authHeld) authWaiting.push(ws);
        else ws.send(JSON.stringify({ type: 'auth_ok' }));
      },
    },
  });
  let listener: ((e: TraceEvent) => void) | null = null;
  // The framework's agents: the primary first, and each agent from its
  // turn's start until it's disposed. A later end doesn't bring it back, as
  // a late end of a disposed agent's run doesn't; a later start does, as a
  // new agent of that name.
  const present = new Set(['Wren']);
  const ctx = {
    getAgents: () => [...present].map((name) => ({ name })),
    onTrace: (cb: (e: TraceEvent) => void) => { listener = cb; return () => { listener = null; }; },
    callTool: async (call: { name: string; input: Record<string, unknown> }) => {
      edits.push({ tool: call.name, ...call.input });
      return editResult;
    },
    addMessage: (_role: string, content: Array<{ text: string }>) => { notes.push(content.map((c) => c.text).join('')); },
  } as unknown as ModuleContext;
  const module = new TtsRelayModule({ url: `ws://127.0.0.1:${server.port}/bot`, token: 't', botId: 'wren', ...config });
  // Registered before the auth wait, so a wait that times out still stops
  // the module and the server.
  const h: Harness = {
    received,
    edits,
    notes,
    emit: (event) => {
      if (event.type === 'inference:started' && typeof event.agentName === 'string') present.add(event.agentName);
      listener?.({ timestamp: Date.now(), ...event } as unknown as TraceEvent);
    },
    dispose: (agentName) => { present.delete(agentName); },
    interrupt: (event) => {
      for (const ws of sockets) ws.send(JSON.stringify({ type: 'interruption', reason: 'user_speech', timestamp: Date.now(), ...event }));
    },
    stop: async () => { await module.stop(); server.stop(true); },
    stopModule: () => module.stop(),
    dropConnections: () => { for (const ws of [...sockets]) ws.close(); },
    away: async () => {
      authHeld = true;
      h.dropConnections();
      await waitFor(() => !h.connected(), 'the module to see the relay gone');
    },
    back: async () => {
      authHeld = false;
      for (const ws of authWaiting.splice(0)) ws.send(JSON.stringify({ type: 'auth_ok' }));
      await waitFor(() => h.connected(), 'the module to reconnect');
    },
    failNextSend: (type) => {
      const ws = (module as unknown as { client: { ws: WebSocket } }).client.ws;
      const send = ws.send.bind(ws);
      ws.send = ((data: string) => {
        if (JSON.parse(data).type !== type) return send(data);
        ws.send = send;
        throw new Error('send failed');
      }) as typeof ws.send;
    },
    connected: () => (module as unknown as { client: { isConnected(): boolean } | null }).client?.isConnected() ?? false,
  };
  running.push(h);
  await module.start(ctx);
  await waitFor(() => h.connected(), 'the relay to authenticate the module');
  return h;
}

const LOCUS = 'discord:guild:111';
const ELSEWHERE = 'discord:guild:222';
const TRIGGER = 'discord:guild:333';

describe('TtsRelayModule', () => {
  test('voices each published message as one text block, and nothing written but not published', async () => {
    const h = await harness();
    h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
    // Written as the model streams: a reply it then keeps private, and its
    // thinking. None of it may reach the relay.
    h.emit({ type: 'inference:content_block', agentName: 'Wren', channelId: LOCUS, blockIndex: 0, blockType: 'thinking', phase: 'block_start' });
    h.emit({ type: 'inference:tokens', agentName: 'Wren', channelId: LOCUS, blockIndex: 0, blockType: 'thinking', content: 'private reasoning' });
    h.emit({ type: 'inference:content_block', agentName: 'Wren', channelId: LOCUS, blockIndex: 0, blockType: 'thinking', phase: 'block_complete' });
    h.emit({ type: 'inference:tokens', agentName: 'Wren', channelId: LOCUS, blockIndex: 1, blockType: 'text', content: 'words kept back by skip_reply' });
    // Published: two messages to the locus and one elsewhere. A later message
    // to the same channel opens with the stream's paragraph break.
    h.emit({ type: 'inference:published', agentName: 'Wren', channelId: LOCUS, inferenceId: 'inf_a', index: 0, text: 'First message.' });
    h.emit({ type: 'inference:published', agentName: 'Wren', channelId: ELSEWHERE, inferenceId: 'inf_a', index: 1, text: 'Over here.' });
    h.emit({ type: 'inference:published', agentName: 'Wren', channelId: LOCUS, inferenceId: 'inf_a', index: 2, text: '\n\nSecond message.' });
    h.emit({ type: 'inference:published_complete', agentName: 'Wren', channelId: LOCUS, inferenceId: 'inf_a', text: 'First message.\n\nSecond message.' });
    h.emit({ type: 'inference:completed', agentName: 'Wren', channelId: LOCUS });
    await waitFor(() => h.received.some((m) => m.type === 'activation_end'), 'activation_end');

    const wire = h.received.map((m) => [m.type, m.channelId, m.text ?? m.content ?? m.reason ?? null]);
    expect(wire).toEqual([
      ['activation_start', '111', null],
      ['block_start', '111', null],
      ['chunk', '111', 'First message.'],
      ['block_complete', '111', 'First message.'],
      ['block_start', '222', null],
      ['chunk', '222', 'Over here.'],
      ['block_complete', '222', 'Over here.'],
      ['block_start', '111', null],
      ['chunk', '111', 'Second message.'],
      ['block_complete', '111', 'Second message.'],
      ['activation_end', '111', 'complete'],
    ]);
    const blocks = h.received.filter((m) => m.type !== 'activation_start' && m.type !== 'activation_end');
    for (const m of blocks) expect(m.blockType).toBe('text');
    for (const m of h.received.filter((m) => m.type === 'chunk')) expect(m.visible).toBe(true);
    // Each published message is its own block: its block_start, chunk and
    // block_complete share one index.
    expect(blocks.map((m) => m.blockIndex)).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2]);
    expect(JSON.stringify(h.received)).not.toContain('private reasoning');
    expect(JSON.stringify(h.received)).not.toContain('kept back');
  });

  test('a turn that publishes nothing sends only its activation', async () => {
    const h = await harness();
    h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
    h.emit({ type: 'inference:tokens', agentName: 'Wren', channelId: LOCUS, blockIndex: 0, blockType: 'text', content: 'never sent' });
    h.emit({ type: 'inference:aborted', agentName: 'Wren', channelId: LOCUS });
    await waitFor(() => h.received.some((m) => m.type === 'activation_end'), 'activation_end');
    expect(h.received.map((m) => [m.type, m.reason ?? null])).toEqual([
      ['activation_start', null],
      ['activation_end', 'abort'],
    ]);
  });

  test('a turn a tool ends (turn_ended, with no completed) ends its activation', async () => {
    const h = await harness();
    h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
    h.emit({ type: 'inference:published', agentName: 'Wren', channelId: LOCUS, inferenceId: 'inf_c', index: 0, text: 'Said, then skip_reply.' });
    h.emit({ type: 'inference:turn_ended', agentName: 'Wren' });
    await waitFor(() => h.received.some((m) => m.type === 'activation_end'), 'activation_end');
    expect(h.received.map((m) => [m.type, m.reason ?? null])).toEqual([
      ['activation_start', null],
      ['block_start', null],
      ['chunk', null],
      ['block_complete', null],
      ['activation_end', 'complete'],
    ]);
  });

  test("a message published after its turn's activation ended is still voiced, on its own channel", async () => {
    const h = await harness();
    // A tool ends the turn before its queued delivery runs: the framework
    // emits turn_ended or completed before it awaits the turn's speech.
    h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
    h.emit({ type: 'inference:completed', agentName: 'Wren', channelId: LOCUS });
    h.emit({ type: 'inference:published', agentName: 'Wren', channelId: ELSEWHERE, inferenceId: 'inf_b', index: 0, text: 'Late but posted.' });
    await waitFor(() => h.received.some((m) => m.type === 'block_complete'), 'block_complete');
    expect(h.received.map((m) => [m.type, m.channelId])).toEqual([
      ['activation_start', '111'],
      ['activation_end', '111'],
      ['block_start', '222'],
      ['chunk', '222'],
      ['block_complete', '222'],
    ]);
  });

  test("an explicit-mode turn's activation goes to the channel that woke it, read from the token traces", async () => {
    const h = await harness();
    // Explicit mode: inference:started has no locus, and the token traces
    // carry the trigger channel, where the typing indicator shows.
    h.emit({ type: 'inference:started', agentName: 'Wren' });
    h.emit({ type: 'inference:content_block', agentName: 'Wren', channelId: TRIGGER, blockIndex: 0, blockType: 'text', phase: 'block_start' });
    h.emit({ type: 'inference:tokens', agentName: 'Wren', channelId: TRIGGER, blockIndex: 0, blockType: 'text', content: 'written, not yet published' });
    h.emit({ type: 'inference:published', agentName: 'Wren', channelId: ELSEWHERE, inferenceId: 'inf_x', index: 0, text: 'Posted where the agent chose.' });
    h.emit({ type: 'inference:completed', agentName: 'Wren' });
    await waitFor(() => h.received.some((m) => m.type === 'activation_end'), 'activation_end');
    expect(h.received.map((m) => [m.type, m.channelId])).toEqual([
      ['activation_start', '333'],
      ['block_start', '222'],
      ['chunk', '222'],
      ['block_complete', '222'],
      ['activation_end', '333'],
    ]);
    expect(JSON.stringify(h.received)).not.toContain('written, not yet published');
  });

  test('a silent turn, whose traces name no channel, opens no activation', async () => {
    const h = await harness();
    h.emit({ type: 'inference:started', agentName: 'Wren', silent: true });
    h.emit({ type: 'inference:tokens', agentName: 'Wren', blockIndex: 0, blockType: 'text', content: 'kept quiet' });
    h.emit({ type: 'inference:completed', agentName: 'Wren' });
    // Something after it, so the wait shows the relay got everything before.
    h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
    await waitFor(() => h.received.length > 0, 'the next turn');
    expect(h.received.map((m) => [m.type, m.channelId])).toEqual([['activation_start', '111']]);
  });

  test('token traces without a turn started open nothing', async () => {
    const h = await harness();
    h.emit({ type: 'inference:tokens', agentName: 'Wren', channelId: LOCUS, blockIndex: 0, blockType: 'text', content: 'late' });
    h.emit({ type: 'inference:published', agentName: 'Wren', channelId: LOCUS, inferenceId: 'inf_l', index: 0, text: 'Still voiced.' });
    await waitFor(() => h.received.some((m) => m.type === 'block_complete'), 'block_complete');
    expect(h.received.map((m) => m.type)).toEqual(['block_start', 'chunk', 'block_complete']);
  });

  test('a context-budget restart, which re-emits inference:started, keeps the one activation', async () => {
    const h = await harness();
    h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
    h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
    h.emit({ type: 'inference:completed', agentName: 'Wren' });
    await waitFor(() => h.received.some((m) => m.type === 'activation_end'), 'activation_end');
    expect(h.received.map((m) => m.type)).toEqual(['activation_start', 'activation_end']);
  });

  test("another agent's turn on the same channel, a sync subagent's, neither restarts nor ends the activation", async () => {
    const h = await harness();
    h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
    // The subagent inherits the parent's locus.
    h.emit({ type: 'inference:started', agentName: 'Wren-sub', channelId: LOCUS });
    h.emit({ type: 'inference:tokens', agentName: 'Wren-sub', channelId: LOCUS, blockIndex: 0, blockType: 'text', content: 'subagent working' });
    h.emit({ type: 'inference:completed', agentName: 'Wren-sub' });
    h.emit({ type: 'inference:published', agentName: 'Wren', channelId: LOCUS, inferenceId: 'inf_p', index: 0, text: 'The parent answers.' });
    h.emit({ type: 'inference:completed', agentName: 'Wren' });
    await waitFor(() => h.received.some((m) => m.type === 'activation_end'), 'activation_end');
    expect(h.received.map((m) => [m.type, m.username ?? null])).toEqual([
      ['activation_start', 'Wren'],
      ['block_start', 'Wren'],
      ['chunk', 'Wren'],
      ['block_complete', 'Wren'],
      ['activation_end', 'Wren'],
    ]);
  });

  test("another agent's turn on the same channel, which opened it, doesn't end the activation while the parent's runs", async () => {
    const h = await harness();
    // The sync subagent's turn reaches the channel first, as when the
    // parent's own traces haven't named it yet.
    h.emit({ type: 'inference:started', agentName: 'Wren-sub', channelId: LOCUS });
    h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
    h.emit({ type: 'inference:completed', agentName: 'Wren-sub' });
    h.emit({ type: 'inference:published', agentName: 'Wren', channelId: LOCUS, inferenceId: 'inf_q', index: 0, text: 'The parent answers.' });
    h.emit({ type: 'inference:completed', agentName: 'Wren' });
    await waitFor(() => h.received.some((m) => m.type === 'activation_end'), 'activation_end');
    expect(h.received.map((m) => [m.type, m.channelId])).toEqual([
      ['activation_start', '111'],
      ['block_start', '111'],
      ['chunk', '111'],
      ['block_complete', '111'],
      ['activation_end', '111'],
    ]);
  });

  test('an earlier turn on the channel ending in an abort cancels nothing: the last turn there ends the activation, with its own reason', async () => {
    const h = await harness();
    h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
    h.emit({ type: 'inference:started', agentName: 'Kestrel', channelId: LOCUS });
    h.emit({ type: 'inference:aborted', agentName: 'Kestrel' });
    h.emit({ type: 'inference:completed', agentName: 'Wren' });
    await waitFor(() => h.received.some((m) => m.type === 'activation_end'), 'activation_end');
    expect(h.received.map((m) => [m.type, m.reason ?? null])).toEqual([
      ['activation_start', null],
      ['activation_end', 'complete'],
    ]);
  });

  test('a turn the framework moves to another channel mid-turn moves its activation there', async () => {
    const h = await harness();
    h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
    // Someone addressed the agent from ELSEWHERE: the framework re-pins the
    // turn's locus there, and its token traces carry the new channel.
    h.emit({ type: 'inference:tokens', agentName: 'Wren', channelId: ELSEWHERE, blockIndex: 0, blockType: 'text', content: 'answering there' });
    h.emit({ type: 'inference:completed', agentName: 'Wren' });
    await waitFor(() => h.received.filter((m) => m.type === 'activation_end').length === 2, 'both ends');
    expect(h.received.map((m) => [m.type, m.channelId, m.reason ?? null])).toEqual([
      ['activation_start', '111', null],
      ['activation_end', '111', 'complete'],
      ['activation_start', '222', null],
      ['activation_end', '222', 'complete'],
    ]);
  });

  test("a turn that moves away leaves the channel's activation to the turn still there", async () => {
    const h = await harness();
    h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
    h.emit({ type: 'inference:started', agentName: 'Kestrel', channelId: LOCUS });
    h.emit({ type: 'inference:started', agentName: 'Wren', channelId: ELSEWHERE });
    h.emit({ type: 'inference:completed', agentName: 'Wren' });
    h.emit({ type: 'inference:completed', agentName: 'Kestrel' });
    await waitFor(() => h.received.filter((m) => m.type === 'activation_end').length === 2, 'both ends');
    expect(h.received.map((m) => [m.type, m.channelId])).toEqual([
      ['activation_start', '111'],
      ['activation_start', '222'],
      ['activation_end', '222'],
      ['activation_end', '111'],
    ]);
  });

  test('a failure the framework retries keeps the activation, and the turn it exhausts ends it with reason error', async () => {
    const h = await harness();
    h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
    h.emit({ type: 'inference:published', agentName: 'Wren', channelId: LOCUS, inferenceId: 'inf_f', index: 0, text: 'Still being read.' });
    // A retried failure: inference:failed, then the retry's own start.
    h.emit({ type: 'inference:failed', agentName: 'Wren', error: '429' });
    h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
    h.emit({ type: 'inference:failed', agentName: 'Wren', error: '500' });
    h.emit({ type: 'inference:exhausted', agentName: 'Wren', error: '500' });
    await waitFor(() => h.received.some((m) => m.type === 'activation_end'), 'activation_end');
    expect(h.received.map((m) => [m.type, m.reason ?? null])).toEqual([
      ['activation_start', null],
      ['block_start', null],
      ['chunk', null],
      ['block_complete', null],
      ['activation_end', 'error'],
    ]);
  });

  test('an explicit-mode turn reads its channel from the token traces alone, or from the content-block traces alone', async () => {
    const h = await harness();
    h.emit({ type: 'inference:started', agentName: 'Wren' });
    h.emit({ type: 'inference:tokens', agentName: 'Wren', channelId: TRIGGER, blockIndex: 0, blockType: 'text', content: 'written' });
    h.emit({ type: 'inference:completed', agentName: 'Wren' });
    h.emit({ type: 'inference:started', agentName: 'Kestrel' });
    h.emit({ type: 'inference:content_block', agentName: 'Kestrel', channelId: ELSEWHERE, blockIndex: 0, blockType: 'text', phase: 'block_start' });
    h.emit({ type: 'inference:completed', agentName: 'Kestrel' });
    await waitFor(() => h.received.filter((m) => m.type === 'activation_end').length === 2, 'both ends');
    expect(h.received.map((m) => [m.type, m.channelId])).toEqual([
      ['activation_start', '333'],
      ['activation_end', '333'],
      ['activation_start', '222'],
      ['activation_end', '222'],
    ]);
  });

  test("an explicit-mode restart, whose re-emitted start names no channel, keeps the activation the token traces opened", async () => {
    const h = await harness();
    h.emit({ type: 'inference:started', agentName: 'Wren' });
    h.emit({ type: 'inference:tokens', agentName: 'Wren', channelId: TRIGGER, blockIndex: 0, blockType: 'text', content: 'before the restart' });
    h.emit({ type: 'inference:started', agentName: 'Wren' });
    h.emit({ type: 'inference:tokens', agentName: 'Wren', channelId: TRIGGER, blockIndex: 0, blockType: 'text', content: 'after it' });
    h.emit({ type: 'inference:completed', agentName: 'Wren' });
    await waitFor(() => h.received.some((m) => m.type === 'activation_end'), 'activation_end');
    expect(h.received.map((m) => [m.type, m.channelId])).toEqual([
      ['activation_start', '333'],
      ['activation_end', '333'],
    ]);
  });

  test("block indices continue across streams, though each stream numbers its own from 0", async () => {
    const h = await harness();
    h.emit({ type: 'inference:published', agentName: 'Wren', channelId: LOCUS, inferenceId: 'inf_1', index: 0, text: 'From the first stream.' });
    h.emit({ type: 'inference:published', agentName: 'Wren', channelId: LOCUS, inferenceId: 'inf_2', index: 0, text: 'From the second.' });
    await waitFor(() => h.received.filter((m) => m.type === 'block_complete').length === 2, 'two blocks');
    expect(h.received.filter((m) => m.type === 'block_complete').map((m) => [m.blockIndex, m.content])).toEqual([
      [0, 'From the first stream.'],
      [1, 'From the second.'],
    ]);
  });

  test('blocks and activations carry the configured userId and username', async () => {
    const h = await harness({ userId: '999', username: 'Wren Voice' });
    h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
    h.emit({ type: 'inference:published', agentName: 'Wren', channelId: LOCUS, inferenceId: 'inf_u', index: 0, text: 'Hello.' });
    h.emit({ type: 'inference:completed', agentName: 'Wren' });
    await waitFor(() => h.received.some((m) => m.type === 'activation_end'), 'activation_end');
    expect(h.received).toHaveLength(5);
    for (const m of h.received) {
      expect(m.userId).toBe('999');
      expect(m.username).toBe('Wren Voice');
      expect(m.botId).toBe('wren');
    }
  });

  test('a published message with no text, only a paragraph break, or only spaces sends nothing', async () => {
    const h = await harness();
    h.emit({ type: 'inference:published', agentName: 'Wren', channelId: LOCUS, inferenceId: 'inf_e', index: 0, text: '' });
    h.emit({ type: 'inference:published', agentName: 'Wren', channelId: LOCUS, inferenceId: 'inf_e', index: 1, text: '\n\n' });
    h.emit({ type: 'inference:published', agentName: 'Wren', channelId: LOCUS, inferenceId: 'inf_e', index: 2, text: '\n\n   ' });
    h.emit({ type: 'inference:published', agentName: 'Wren', channelId: LOCUS, inferenceId: 'inf_e', index: 3, text: 'Then words.' });
    // Waits for the message with words, so anything the empty ones sent
    // before it is on the list too.
    await waitFor(() => h.received.some((m) => m.type === 'block_complete' && m.content === 'Then words.'), 'the block with words');
    expect(h.received.map((m) => [m.type, m.blockIndex])).toEqual([
      ['block_start', 0],
      ['chunk', 0],
      ['block_complete', 0],
    ]);
  });

  test('a message sent with a tool call, which reaches the module only as mcpl:speech-routed, sends nothing', async () => {
    const h = await harness();
    h.emit({ type: 'mcpl:speech-routed', conversationId: 'subconscious', serverId: 'discord', channelId: LOCUS, text: 'A note from below.' });
    h.emit({ type: 'mcpl:speech-routed', conversationId: 'Wren', serverId: 'discord', channelId: LOCUS, delivered: true, text: 'The sleep announcement.', messageId: 'm-sleep' });
    h.emit({ type: 'inference:published', agentName: 'Wren', channelId: LOCUS, inferenceId: 'inf_s', index: 0, text: 'Published prose.' });
    await waitFor(() => h.received.some((m) => m.type === 'block_complete'), 'block_complete');
    expect(h.received.map((m) => [m.type, m.text ?? m.content ?? null])).toEqual([
      ['block_start', null],
      ['chunk', 'Published prose.'],
      ['block_complete', 'Published prose.'],
    ]);
  });

  test("a message published while the relay is away isn't voiced or queued, the module says so, and an interruption can't trim it", async () => {
    const h = await harness({ reconnectIntervalMs: 20 });
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      await h.away();
      h.emit({ type: 'inference:published', agentName: 'Wren', channelId: LOCUS, inferenceId: 'inf_d', index: 0, text: 'Unheard.', messageId: 'm-unheard' });
      await h.back();
      // Something sent after the reconnect, so the wait shows nothing came
      // before it.
      h.emit({ type: 'inference:published', agentName: 'Wren', channelId: ELSEWHERE, inferenceId: 'inf_d', index: 1, text: 'Heard elsewhere.' });
      await waitFor(() => h.received.some((m) => m.type === 'block_complete'), 'block_complete');
      h.interrupt({ channelId: '111', spokenText: 'Unhe' });
      await waitFor(() => h.notes.length > 0, 'the note to the agent');
    } finally {
      console.error = original;
    }
    expect(logged.some((l) => l.includes("wasn't sent to the relay") && l.includes('111'))).toBe(true);
    expect(h.received.map((m) => [m.type, m.channelId])).toEqual([
      ['block_start', '222'],
      ['chunk', '222'],
      ['block_complete', '222'],
    ]);
    expect(h.edits).toEqual([]);
    expect(h.notes[0]).toContain('this host has no record of what was voiced here');
  });

  test("a start the relay didn't take is sent when it's back, and the channel is read from that start", async () => {
    const h = await harness({ reconnectIntervalMs: 20 });
    await h.away();
    h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
    await h.back();
    await waitFor(() => h.received.some((m) => m.type === 'activation_start'), 'the start, once the relay is back');
    h.emit({ type: 'inference:published', agentName: 'Wren', channelId: LOCUS, inferenceId: 'inf_r', index: 0, text: 'After the outage.', messageId: 'm-a' });
    await waitFor(() => h.received.some((m) => m.type === 'block_complete'), 'the block');
    h.interrupt({ channelId: '111', spokenText: 'After the' });
    await waitFor(() => h.notes.length > 0, 'the note to the agent');
    expect(h.received.map((m) => [m.type, m.channelId])).toEqual([
      ['activation_start', '111'],
      ['block_start', '111'],
      ['chunk', '111'],
      ['block_complete', '111'],
    ]);
    expect(h.edits.map((e) => [e.messageId, e.content])).toEqual([['m-a', 'After the']]);
  });

  test("an end the relay didn't take is sent, with its reason, when it's back", async () => {
    const h = await harness({ reconnectIntervalMs: 20 });
    h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
    await waitFor(() => h.received.some((m) => m.type === 'activation_start'), 'the start');
    await h.away();
    h.emit({ type: 'inference:aborted', agentName: 'Wren' });
    await h.back();
    await waitFor(() => h.received.some((m) => m.type === 'activation_end'), 'the end, once the relay is back');
    expect(h.received.map((m) => [m.type, m.channelId, m.reason ?? null])).toEqual([
      ['activation_start', '111', null],
      ['activation_end', '111', 'abort'],
    ]);
  });

  test("a turn that starts and ends while the relay is away sends nothing when it's back", async () => {
    const h = await harness({ reconnectIntervalMs: 20 });
    await h.away();
    h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
    h.emit({ type: 'inference:completed', agentName: 'Wren' });
    await h.back();
    // Something sent after the reconnect, so the wait shows nothing came
    // before it.
    h.emit({ type: 'inference:published', agentName: 'Wren', channelId: ELSEWHERE, inferenceId: 'inf_w', index: 0, text: 'Later.' });
    await waitFor(() => h.received.some((m) => m.type === 'block_complete'), 'the later block');
    expect(h.received.map((m) => m.type)).toEqual(['block_start', 'chunk', 'block_complete']);
  });

  test('stopping the module ends the activations the relay saw open, as complete when no end was kept', async () => {
    const h = await harness();
    h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
    await waitFor(() => h.received.some((m) => m.type === 'activation_start'), 'the start');
    await h.stopModule();
    await waitFor(() => h.received.some((m) => m.type === 'activation_end'), 'the end');
    expect(h.received.map((m) => [m.type, m.channelId, m.reason ?? null])).toEqual([
      ['activation_start', '111', null],
      ['activation_end', '111', 'complete'],
    ]);
  });

  test("an end the relay missed is sent when it's back, and a turn that began and ended while it was away sends nothing", async () => {
    const h = await harness({ reconnectIntervalMs: 20 });
    h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
    await waitFor(() => h.received.some((m) => m.type === 'activation_start'), 'the start');
    await h.away();
    h.emit({ type: 'inference:aborted', agentName: 'Wren' });
    h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
    h.emit({ type: 'inference:completed', agentName: 'Wren' });
    await h.back();
    // Something sent after the reconnect, so the wait shows nothing more came
    // before it.
    h.emit({ type: 'inference:published', agentName: 'Wren', channelId: ELSEWHERE, inferenceId: 'inf_e', index: 0, text: 'Later.' });
    await waitFor(() => h.received.some((m) => m.type === 'block_complete'), 'the later block');
    expect(h.received.filter((m) => m.type.startsWith('activation')).map((m) => [m.type, m.channelId, m.reason ?? null])).toEqual([
      ['activation_start', '111', null],
      ['activation_end', '111', 'abort'],
    ]);
  });

  test("a turn on a channel whose end the relay missed gets its start after that end, when the relay is back", async () => {
    const h = await harness({ reconnectIntervalMs: 20 });
    h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
    await waitFor(() => h.received.some((m) => m.type === 'activation_start'), 'the start');
    await h.away();
    h.emit({ type: 'inference:aborted', agentName: 'Wren' });
    h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
    await h.back();
    await waitFor(() => h.received.filter((m) => m.type === 'activation_start').length === 2, 'the second start');
    expect(h.received.map((m) => [m.type, m.channelId, m.reason ?? null])).toEqual([
      ['activation_start', '111', null],
      ['activation_end', '111', 'abort'],
      ['activation_start', '111', null],
    ]);
  });

  test('a turn that moves away and back while the relay is away ends and starts its channel again when it is back', async () => {
    const h = await harness({ reconnectIntervalMs: 20 });
    h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
    await waitFor(() => h.received.some((m) => m.type === 'activation_start'), 'the start');
    await h.away();
    h.emit({ type: 'inference:tokens', agentName: 'Wren', channelId: ELSEWHERE, tokens: 'x' });
    h.emit({ type: 'inference:tokens', agentName: 'Wren', channelId: LOCUS, tokens: 'y' });
    await h.back();
    await waitFor(() => h.received.filter((m) => m.type === 'activation_start').length === 2, 'the start again');
    expect(h.received.map((m) => [m.type, m.channelId, m.reason ?? null])).toEqual([
      ['activation_start', '111', null],
      ['activation_end', '111', 'complete'],
      ['activation_start', '111', null],
    ]);
  });

  test("stopping the module sends an end it kept after a send of it failed, with its own reason, and 'complete' for the others", async () => {
    const h = await harness();
    h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
    h.emit({ type: 'inference:started', agentName: 'Wren/sub-1', channelId: ELSEWHERE });
    await waitFor(() => h.received.filter((m) => m.type === 'activation_start').length === 2, 'both starts');
    // The relay stays up, but the abort's end fails to send, so the module
    // keeps it.
    h.failNextSend('activation_end');
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      h.emit({ type: 'inference:aborted', agentName: 'Wren', channelId: LOCUS });
    } finally {
      console.error = original;
    }
    // The send failed, so the module kept the abort's end.
    expect(logged.some((l) => l.includes('the activation_end for 111 is sent when it'))).toBe(true);
    await h.stopModule();
    await waitFor(() => h.received.filter((m) => m.type === 'activation_end').length === 2, 'both ends');
    expect(h.received.filter((m) => m.type === 'activation_end').map((m) => [m.channelId, m.reason])).toEqual([
      ['111', 'abort'],
      ['222', 'complete'],
    ]);
  });

  test('stopping the module while the relay is away names each channel it leaves open', async () => {
    const h = await harness({ reconnectIntervalMs: 20 });
    h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
    await waitFor(() => h.received.some((m) => m.type === 'activation_start'), 'the start');
    await h.away();
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      await h.stopModule();
    } finally {
      console.error = original;
    }
    expect(logged.some((l) => l.includes('the activation on 111 is left open there'))).toBe(true);
  });

  test('when the relay is back, every end it missed goes before any start', async () => {
    const h = await harness({ reconnectIntervalMs: 20 });
    h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
    h.emit({ type: 'inference:started', agentName: 'Kestrel', channelId: ELSEWHERE });
    await waitFor(() => h.received.filter((m) => m.type === 'activation_start').length === 2, 'both starts');
    await h.away();
    h.emit({ type: 'inference:aborted', agentName: 'Wren' });
    h.emit({ type: 'inference:aborted', agentName: 'Kestrel' });
    h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
    h.emit({ type: 'inference:started', agentName: 'Kestrel', channelId: ELSEWHERE });
    await h.back();
    await waitFor(() => h.received.filter((m) => m.type === 'activation_start').length === 4, 'the starts again');
    expect(h.received.slice(2).map((m) => [m.type, m.channelId, m.reason ?? null])).toEqual([
      ['activation_end', '111', 'abort'],
      ['activation_end', '222', 'abort'],
      ['activation_start', '111', null],
      ['activation_start', '222', null],
    ]);
  });

  test("a subagent the framework disposes with no end doesn't hold its channel's activation open", async () => {
    const h = await harness();
    h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
    h.emit({ type: 'inference:started', agentName: 'Wren/sub-1', channelId: LOCUS });
    h.dispose('Wren/sub-1');
    h.emit({ type: 'inference:aborted', agentName: 'Wren' });
    await waitFor(() => h.received.some((m) => m.type === 'activation_end'), 'the end');
    expect(h.received.map((m) => [m.type, m.channelId, m.reason ?? null])).toEqual([
      ['activation_start', '111', null],
      ['activation_end', '111', 'abort'],
    ]);
  });

  test("a turn let go with no end is logged with its agent and channel, and its own end, coming next after its agent went, keeps its reason", async () => {
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      const h = await harness();
      h.emit({ type: 'inference:started', agentName: 'Wren/sub-1', channelId: ELSEWHERE });
      h.emit({ type: 'inference:started', agentName: 'Wren/sub-2', channelId: LOCUS });
      h.dispose('Wren/sub-1');
      h.dispose('Wren/sub-2');
      // sub-2's own abort arrives after the framework let its agent go.
      h.emit({ type: 'inference:aborted', agentName: 'Wren/sub-2' });
      await waitFor(() => h.received.filter((m) => m.type === 'activation_end').length === 2, 'both ends');
      expect(h.received.filter((m) => m.type === 'activation_end').map((m) => [m.channelId, m.reason])).toEqual([
        ['222', 'complete'],
        ['111', 'abort'],
      ]);
      expect(logged.some((l) => l.includes("Wren/sub-1's turn on 222 is let go with no end"))).toBe(true);
      expect(logged.some((l) => l.includes('Wren/sub-2') && l.includes('let go'))).toBe(false);
    } finally {
      console.error = original;
    }
  });

  test('a turn whose agent went while the relay was away is let go when it is back, and logged: its channel ends, and no start is sent for it', async () => {
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      const h = await harness({ reconnectIntervalMs: 20 });
      h.emit({ type: 'inference:started', agentName: 'Wren/sub-1', channelId: ELSEWHERE });
      await waitFor(() => h.received.some((m) => m.type === 'activation_start'), 'the start');
      await h.away();
      // One subagent goes while it holds an open activation, and another
      // starts and goes while the relay is away, with no trace after either.
      h.emit({ type: 'inference:started', agentName: 'Wren/sub-2', channelId: LOCUS });
      h.dispose('Wren/sub-1');
      h.dispose('Wren/sub-2');
      await h.back();
      await waitFor(() => h.received.some((m) => m.type === 'activation_end'), 'the end');
      // A start on a third channel, sent after the reconnect: any start for
      // the gone turn would have come before it.
      h.emit({ type: 'inference:started', agentName: 'Wren', channelId: '333' });
      await waitFor(() => h.received.some((m) => m.type === 'activation_start' && m.channelId === '333'), 'the later start');
      expect(h.received.map((m) => [m.type, m.channelId, m.reason ?? null])).toEqual([
        ['activation_start', '222', null],
        ['activation_end', '222', 'complete'],
        ['activation_start', '333', null],
      ]);
      expect(logged.some((l) => l.includes("Wren/sub-1's turn on 222 is let go with no end"))).toBe(true);
      expect(logged.some((l) => l.includes("Wren/sub-2's turn on 111 is let go with no end"))).toBe(true);
    } finally {
      console.error = original;
    }
  });

  test('a channel held only by a disposed subagent ends at the next start, as complete', async () => {
    const h = await harness();
    h.emit({ type: 'inference:started', agentName: 'Wren/sub-1', channelId: ELSEWHERE });
    h.dispose('Wren/sub-1');
    h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
    await waitFor(() => h.received.filter((m) => m.type.startsWith('activation')).length === 3, 'the end and the new start');
    expect(h.received.map((m) => [m.type, m.channelId, m.reason ?? null])).toEqual([
      ['activation_start', '222', null],
      ['activation_end', '222', 'complete'],
      ['activation_start', '111', null],
    ]);
  });

  test("a subagent's blocks, and an end it sends as the last turn to leave, carry the bot's identity", async () => {
    const h = await harness();
    h.emit({ type: 'inference:started', agentName: 'Wren-sub', channelId: LOCUS });
    h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
    h.emit({ type: 'inference:published', agentName: 'Wren-sub', channelId: LOCUS, inferenceId: 'inf_i', index: 0, text: 'From the subagent.' });
    h.emit({ type: 'inference:completed', agentName: 'Wren' });
    h.emit({ type: 'inference:completed', agentName: 'Wren-sub' });
    await waitFor(() => h.received.some((m) => m.type === 'activation_end'), 'activation_end');
    expect(h.received.map((m) => m.type)).toEqual(['activation_start', 'block_start', 'chunk', 'block_complete', 'activation_end']);
    for (const m of h.received) {
      expect(m.userId).toBe('wren');
      expect(m.username).toBe('Wren');
    }
  });

  // melodeus-ios's spokenText is everything it voiced for the bot since a
  // start on a channel it voices or the last interruption, its sentences
  // joined with no space between them and perhaps "Wren says:" before a
  // message, so it's read across the messages sent there, in order.
  describe('interruptions', () => {
    async function turnOf(messages: Array<{ text: string; messageId?: string }>, options: HarnessOptions = {}): Promise<Harness> {
      const h = await harness(options);
      h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
      messages.forEach((m, index) => {
        h.emit({ type: 'inference:published', agentName: 'Wren', channelId: LOCUS, inferenceId: 'inf_t', index, text: index === 0 ? m.text : `\n\n${m.text}`, ...(m.messageId ? { messageId: m.messageId } : {}) });
      });
      await waitFor(() => h.received.filter((m) => m.type === 'block_complete').length === messages.length, 'every block');
      return h;
    }

    test('the message the words end inside is trimmed to the words heard; the ones before were voiced', async () => {
      const h = await turnOf([
        { text: 'First part of the reply.', messageId: 'm-1' },
        { text: 'Second part, which the user cut.', messageId: 'm-2' },
        { text: 'Third part.', messageId: 'm-3' },
      ]);
      h.interrupt({ channelId: '111', spokenText: 'First part of the reply.Second part, which' });
      await waitFor(() => h.notes.length > 0, 'the note to the agent');
      expect(h.edits).toEqual([{ tool: 'mcpl--discord--edit_message', channelId: '111', messageId: 'm-2', content: 'Second part, which' }]);
      expect(h.notes[0]).toContain('trimmed to match: "Second part, which"');
      expect(h.notes[0]).toContain('about this much was voiced (the voice client can count a sentence whole as soon as it starts playing)');
      expect(h.notes[0]).toContain("Your next message here wasn't voiced before the interruption.");
    });

    test('a message discord-mcpl may have posted as several Discord messages is left as it is, and the note says why', async () => {
      const long = `Opening words ${'x'.repeat(1900)}`;
      const h = await turnOf([{ text: long, messageId: 'm-last-part' }]);
      h.interrupt({ channelId: '111', spokenText: 'Opening words' });
      await waitFor(() => h.notes.length > 0, 'the note to the agent');
      expect(h.edits).toEqual([]);
      expect(h.notes[0]).toContain("Discord may show it as several messages, and this host has only the last one's id, so it still has its full text");
    });

    test("a later message's paragraph break counts toward the split", async () => {
      // Its text after the break is 1899 characters, under the split alone.
      // The framework puts the break in the trace's text only, but the module
      // can't tell it from newlines the prose itself begins with, which
      // discord-mcpl does count, so it counts the break too.
      const h = await turnOf([{ text: 'Short.', messageId: 'm-1' }, { text: `Near ${'y'.repeat(1894)}`, messageId: 'm-2' }]);
      h.interrupt({ channelId: '111', spokenText: 'Short.Near y' });
      await waitFor(() => h.notes.length > 0, 'the note to the agent');
      expect(h.edits).toEqual([]);
      expect(h.notes[0]).toContain('Discord may show it as several messages');
    });

    test('a message the agent edited since posting it is left as it is, and so is one it deleted', async () => {
      for (const tool of ['edit_message', 'delete_message']) {
        const h = await turnOf([
          { text: 'First part.', messageId: 'm-1' },
          { text: 'Second part, which the user cut.', messageId: 'm-2' },
        ]);
        h.emit({ type: 'tool:started', module: 'mcpl:discord', tool, callId: `c-${tool}`, input: { channelId: '111', messageId: 'm-2', content: 'Second part, revised.' } });
        h.interrupt({ channelId: '111', spokenText: 'First part.Second part, which' });
        await waitFor(() => h.notes.length > 0, 'the note to the agent');
        expect(h.edits).toEqual([]);
        expect(h.notes[0]).toContain('(you edited or deleted the posted message since, or tried to, so it was left as it is)');
        await h.stop();
      }
    });

    test("with another edit server, that server's edit holds the trim back, and the default server's doesn't", async () => {
      for (const [module, held] of [['mcpl:discord-alt', true], ['mcpl:discord', false]] as const) {
        const h = await turnOf([
          { text: 'First part.', messageId: 'm-1' },
          { text: 'Second part, which the user cut.', messageId: 'm-2' },
        ], { editServerId: 'discord-alt' });
        h.emit({ type: 'tool:started', module, tool: 'edit_message', callId: 'c1', input: { messageId: 'm-2' } });
        h.interrupt({ channelId: '111', spokenText: 'First part.Second part, which' });
        await waitFor(() => h.notes.length > 0, 'the note to the agent');
        expect(h.edits.map((e) => e.messageId)).toEqual(held ? [] : ['m-2']);
        await h.stop();
      }
    });

    test("another server's edit, another tool, or an edit of another message doesn't hold the trim back", async () => {
      const h = await turnOf([
        { text: 'First part.', messageId: 'm-1' },
        { text: 'Second part, which the user cut.', messageId: 'm-2' },
      ]);
      h.emit({ type: 'tool:started', module: 'mcpl:slack', tool: 'edit_message', callId: 'c1', input: { messageId: 'm-2' } });
      h.emit({ type: 'tool:started', module: 'mcpl:discord', tool: 'send_message', callId: 'c2', input: { messageId: 'm-2' } });
      h.emit({ type: 'tool:started', module: 'mcpl:discord', tool: 'edit_message', callId: 'c3', input: { messageId: 'm-1' } });
      h.interrupt({ channelId: '111', spokenText: 'First part.Second part, which' });
      await waitFor(() => h.notes.length > 0, 'the note to the agent');
      expect(h.edits.map((e) => e.messageId)).toEqual(['m-2']);
    });

    test('markup and spacing the client drops still line up, and the trim keeps the message\'s own text', async () => {
      const h = await turnOf([{ text: '**Bold** start,   then  more words.', messageId: 'm-b' }]);
      h.interrupt({ channelId: '111', spokenText: 'Bold start, then mo' });
      await waitFor(() => h.notes.length > 0, 'the note to the agent');
      expect(h.edits.map((e) => e.content)).toEqual(['**Bold** start,   then  mo']);
    });

    test('words that end between messages trim nothing, and the note names the messages not voiced', async () => {
      const h = await turnOf([
        { text: 'One.', messageId: 'm-1' },
        { text: 'Two.', messageId: 'm-2' },
        { text: 'Three.', messageId: 'm-3' },
      ]);
      h.interrupt({ channelId: '111', spokenText: 'One.' });
      await waitFor(() => h.notes.length > 0, 'the note to the agent');
      expect(h.edits).toEqual([]);
      expect(h.notes[0]).toContain('the ones before were voiced, though their last sentence may still have been playing, and nothing was trimmed.');
      expect(h.notes[0]).toContain("Your 2 later messages here weren't voiced before the interruption.");
    });

    test("words that don't follow what the relay sent edit nothing, though another agent's message was posted there with an id", async () => {
      const h = await turnOf([{ text: 'Hello there.', messageId: 'm-wren' }]);
      h.emit({ type: 'mcpl:speech-routed', conversationId: 'subconscious', serverId: 'discord', channelId: LOCUS, delivered: true, text: 'A note from below.', messageId: 'm-sub' });
      h.interrupt({ channelId: '111', spokenText: 'A note from' });
      await waitFor(() => h.notes.length > 0, 'the note to the agent');
      expect(h.edits).toEqual([]);
      expect(h.notes[0]).toContain("those words don't follow what this host sent here");
    });

    test("the client's spoken announcement of the bot before a message doesn't stop the trim", async () => {
      const h = await turnOf([
        { text: 'Hello there.', messageId: 'm-1' },
        { text: 'And a second thought.', messageId: 'm-2' },
      ]);
      h.interrupt({ channelId: '111', spokenText: 'Wren says:Hello there.Wren says:And a sec' });
      await waitFor(() => h.notes.length > 0, 'the note to the agent');
      expect(h.edits.map((e) => [e.messageId, e.content])).toEqual([['m-2', 'And a sec']]);
    });

    test('words that end at the last message trim nothing and add no note', async () => {
      const h = await turnOf([{ text: 'One.', messageId: 'm-1' }, { text: 'Two.', messageId: 'm-2' }]);
      const logged: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
      try {
        h.interrupt({ channelId: '111', spokenText: 'One.Two.' });
        // The handler logs its reading and then adds its note, if any, with
        // nothing awaited between.
        await waitFor(() => logged.some((l) => l.includes('came between messages')), 'the interruption to be read');
      } finally {
        console.error = original;
      }
      expect(h.edits).toEqual([]);
      expect(h.notes).toEqual([]);
    });

    test("a turn there that completes leaves its messages to be read, and one that's stopped doesn't", async () => {
      const done = await turnOf([{ text: 'A finished reply.', messageId: 'm-1' }]);
      done.emit({ type: 'inference:completed', agentName: 'Wren' });
      await waitFor(() => done.received.some((m) => m.type === 'activation_end'), 'the end');
      done.interrupt({ channelId: '111', spokenText: 'A finished' });
      await waitFor(() => done.notes.length > 0, 'the note to the agent');
      expect(done.edits.map((e) => [e.messageId, e.content])).toEqual([['m-1', 'A finished']]);

      const stopped = await turnOf([{ text: 'Cut short by an abort.', messageId: 'm-1' }]);
      stopped.emit({ type: 'inference:aborted', agentName: 'Wren' });
      await waitFor(() => stopped.received.some((m) => m.type === 'activation_end'), 'the end');
      stopped.interrupt({ channelId: '111', spokenText: 'Cut short' });
      await waitFor(() => stopped.notes.length > 0, 'the note to the agent');
      expect(stopped.edits).toEqual([]);
      expect(stopped.notes[0]).toContain('a turn was stopped since');
    });

    test('a turn the framework gave up on stops the reading too', async () => {
      const h = await turnOf([{ text: 'Cut short by an error.', messageId: 'm-1' }]);
      h.emit({ type: 'inference:exhausted', agentName: 'Wren', error: 'overloaded' });
      await waitFor(() => h.received.some((m) => m.type === 'activation_end'), 'the end');
      h.interrupt({ channelId: '111', spokenText: 'Cut short' });
      await waitFor(() => h.notes.length > 0, 'the note to the agent');
      expect(h.edits).toEqual([]);
      expect(h.notes[0]).toContain('a turn was stopped since');
    });

    test("a stopped turn's end on another channel stops this channel's reading, since the client's cancel is the bot's", async () => {
      const h = await harness();
      // The other channel's turn starts first, so its start marks no record.
      h.emit({ type: 'inference:started', agentName: 'Kestrel', channelId: ELSEWHERE });
      h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
      h.emit({ type: 'inference:published', agentName: 'Wren', channelId: LOCUS, inferenceId: 'inf_s', index: 0, text: 'Said here first.', messageId: 'm-1' });
      h.emit({ type: 'inference:aborted', agentName: 'Kestrel' });
      await waitFor(() => h.received.filter((m) => m.type === 'activation_end').length === 1, 'the other channel\'s end');
      h.interrupt({ channelId: '111', spokenText: 'Said here' });
      await waitFor(() => h.notes.length > 0, 'the note to the agent');
      expect(h.edits).toEqual([]);
      expect(h.notes[0]).toContain('a turn was stopped since');
    });

    test("a start on another channel since stops this channel's reading, since the client starts the bot's words afresh there", async () => {
      const h = await turnOf([{ text: 'Said here first.', messageId: 'm-1' }]);
      h.emit({ type: 'inference:started', agentName: 'Kestrel', channelId: ELSEWHERE });
      await waitFor(() => h.received.filter((m) => m.type === 'activation_start').length === 2, 'the other channel\'s start');
      h.interrupt({ channelId: '111', spokenText: 'Said here' });
      await waitFor(() => h.notes.length > 0, 'the note to the agent');
      expect(h.edits).toEqual([]);
      expect(h.notes[0]).toContain('this bot started or spoke on another channel since');
    });

    test("a message on another channel since stops this channel's reading, and the note says why", async () => {
      const h = await turnOf([{ text: 'Said here first.', messageId: 'm-1' }]);
      h.emit({ type: 'inference:published', agentName: 'Wren', channelId: ELSEWHERE, inferenceId: 'inf_x', index: 0, text: 'Said there.', messageId: 'm-2' });
      await waitFor(() => h.received.filter((m) => m.type === 'block_complete').length === 2, 'both blocks');
      h.interrupt({ channelId: '111', spokenText: 'Said here' });
      await waitFor(() => h.notes.length > 0, 'the note to the agent');
      expect(h.edits).toEqual([]);
      expect(h.notes[0]).toContain('this bot started or spoke on another channel since');
      // Words were heard: the note quotes them, and says why they can't be read.
      expect(h.notes[0]).toContain('after "Said here"');
      expect(h.notes[0]).toContain("so those words can't be lined up with what was sent, and nothing was trimmed");
      expect(h.notes[0]).not.toContain('no words voiced');
    });

    test("a stopped turn's mark outlasts a reconnect, since it says more", async () => {
      const h = await turnOf([{ text: 'Stopped, then the relay dropped.', messageId: 'm-1' }], { reconnectIntervalMs: 20 });
      h.emit({ type: 'inference:aborted', agentName: 'Wren' });
      await waitFor(() => h.received.some((m) => m.type === 'activation_end'), 'the end');
      await h.away();
      await h.back();
      h.interrupt({ channelId: '111', spokenText: 'Stopped' });
      await waitFor(() => h.notes.length > 0, 'the note to the agent');
      expect(h.notes[0]).toContain('a turn was stopped since');
    });

    test("a turn the relay never saw, stopped while it was away, doesn't count as stopping the reading", async () => {
      const h = await turnOf([{ text: 'Said before the drop.', messageId: 'm-1' }], { reconnectIntervalMs: 20 });
      await h.away();
      h.emit({ type: 'inference:started', agentName: 'Kestrel', channelId: ELSEWHERE });
      h.emit({ type: 'inference:aborted', agentName: 'Kestrel' });
      await h.back();
      h.interrupt({ channelId: '111', spokenText: 'Said before' });
      await waitFor(() => h.notes.length > 0, 'the note to the agent');
      expect(h.notes[0]).toContain('lost its connection to the relay');
      expect(h.notes[0]).not.toContain('stopped');
    });

    test("after the relay connection drops, a channel's words edit nothing until it starts again", async () => {
      const dropped = await turnOf([{ text: 'Said before the drop.', messageId: 'm-1' }], { reconnectIntervalMs: 20 });
      await dropped.away();
      await dropped.back();
      dropped.interrupt({ channelId: '111', spokenText: 'Said before' });
      await waitFor(() => dropped.notes.length > 0, 'the note to the agent');
      expect(dropped.edits).toEqual([]);
      expect(dropped.notes[0]).toContain('lost its connection to the relay');

      const restarted = await turnOf([{ text: 'Said before the drop.', messageId: 'm-1' }], { reconnectIntervalMs: 20 });
      await restarted.away();
      await restarted.back();
      restarted.emit({ type: 'inference:completed', agentName: 'Wren' });
      restarted.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
      restarted.emit({ type: 'inference:published', agentName: 'Wren', channelId: LOCUS, inferenceId: 'inf_n', index: 0, text: 'A new turn.', messageId: 'm-2' });
      await waitFor(() => restarted.received.filter((m) => m.type === 'block_complete').length === 2, 'the new block');
      restarted.interrupt({ channelId: '111', spokenText: 'A new' });
      await waitFor(() => restarted.notes.length > 0, 'the note to the agent');
      expect(restarted.edits.map((e) => [e.messageId, e.content])).toEqual([['m-2', 'A new']]);
    });

    test("an interruption starts every channel's record afresh, as the client does", async () => {
      const h = await harness();
      h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
      h.emit({ type: 'inference:published', agentName: 'Wren', channelId: LOCUS, inferenceId: 'inf_h', index: 0, text: 'Here.', messageId: 'm-1' });
      h.emit({ type: 'inference:started', agentName: 'Kestrel', channelId: ELSEWHERE });
      h.emit({ type: 'inference:published', agentName: 'Kestrel', channelId: ELSEWHERE, inferenceId: 'inf_k', index: 0, text: 'There.', messageId: 'm-2' });
      await waitFor(() => h.received.filter((m) => m.type === 'block_complete').length === 2, 'both blocks');
      h.interrupt({ channelId: '111', spokenText: 'He' });
      await waitFor(() => h.notes.length === 1, 'the first note');
      // Read from 222's messages since the interruption alone, so its earlier
      // message, which the client's spokenText no longer holds, isn't read.
      h.emit({ type: 'inference:published', agentName: 'Kestrel', channelId: ELSEWHERE, inferenceId: 'inf_k', index: 1, text: 'Again.', messageId: 'm-3' });
      await waitFor(() => h.received.filter((m) => m.type === 'block_complete').length === 3, 'the third block');
      h.interrupt({ channelId: '222', spokenText: 'Ag' });
      await waitFor(() => h.notes.length === 2, 'the second note');
      expect(h.edits.map((e) => [e.messageId, e.content])).toEqual([['m-3', 'Ag']]);
    });

    test('an interruption with nothing voiced since the last one says nothing was voiced', async () => {
      const h = await turnOf([{ text: 'Before the user spoke.', messageId: 'm-1' }]);
      h.interrupt({ channelId: '111', spokenText: 'Before the' });
      await waitFor(() => h.notes.length === 1, 'the first note');
      h.interrupt({ channelId: '111', spokenText: '' });
      await waitFor(() => h.notes.length === 2, 'the second note');
      expect(h.notes[1]).toContain('before any of it was voiced, so nothing was trimmed.');
      expect(h.notes[1]).not.toContain('no record');
    });

    test("a channel's first message after another channel's message since its start can't be lined up", async () => {
      const h = await harness();
      h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
      h.emit({ type: 'inference:started', agentName: 'Kestrel', channelId: ELSEWHERE });
      h.emit({ type: 'inference:published', agentName: 'Kestrel', channelId: ELSEWHERE, inferenceId: 'inf_k', index: 0, text: 'Said there.', messageId: 'm-k' });
      h.emit({ type: 'inference:published', agentName: 'Wren', channelId: LOCUS, inferenceId: 'inf_w', index: 0, text: 'Said here first.', messageId: 'm-1' });
      await waitFor(() => h.received.filter((m) => m.type === 'block_complete').length === 2, 'both blocks');
      h.interrupt({ channelId: '111', spokenText: 'Said here' });
      await waitFor(() => h.notes.length > 0, 'the note to the agent');
      expect(h.edits).toEqual([]);
      expect(h.notes[0]).toContain('this bot started or spoke on another channel since');
      // The interruption starts the words afresh: the next message here lines
      // up again, the other channel's message being before it.
      h.emit({ type: 'inference:published', agentName: 'Wren', channelId: LOCUS, inferenceId: 'inf_w', index: 1, text: 'Then this.', messageId: 'm-2' });
      await waitFor(() => h.received.filter((m) => m.type === 'block_complete').length === 3, 'the third block');
      h.interrupt({ channelId: '111', spokenText: 'Then' });
      await waitFor(() => h.notes.length === 2, 'the second note');
      expect(h.edits.map((e) => [e.messageId, e.content])).toEqual([['m-2', 'Then']]);
    });

    test("another channel's message before this channel's start leaves its record lined up", async () => {
      const h = await harness();
      h.emit({ type: 'inference:started', agentName: 'Kestrel', channelId: ELSEWHERE });
      h.emit({ type: 'inference:published', agentName: 'Kestrel', channelId: ELSEWHERE, inferenceId: 'inf_k', index: 0, text: 'Said there.', messageId: 'm-k' });
      h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
      h.emit({ type: 'inference:published', agentName: 'Wren', channelId: LOCUS, inferenceId: 'inf_w', index: 0, text: 'Said here first.', messageId: 'm-1' });
      await waitFor(() => h.received.filter((m) => m.type === 'block_complete').length === 2, 'both blocks');
      h.interrupt({ channelId: '111', spokenText: 'Said here' });
      await waitFor(() => h.notes.length === 1, 'the note');
      expect(h.edits.map((e) => [e.messageId, e.content])).toEqual([['m-1', 'Said here']]);
    });

    test("another channel's message after this channel's start but before the last interruption leaves the record made after it lined up", async () => {
      const h = await harness();
      h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
      h.emit({ type: 'inference:started', agentName: 'Kestrel', channelId: ELSEWHERE });
      h.emit({ type: 'inference:published', agentName: 'Kestrel', channelId: ELSEWHERE, inferenceId: 'inf_k', index: 0, text: 'Said there.', messageId: 'm-k' });
      await waitFor(() => h.received.filter((m) => m.type === 'block_complete').length === 1, 'the block there');
      // The interruption, not the channel's start, is the reset point here.
      h.interrupt({ channelId: '222', spokenText: 'Said' });
      await waitFor(() => h.notes.length === 1, 'the first note');
      h.emit({ type: 'inference:published', agentName: 'Wren', channelId: LOCUS, inferenceId: 'inf_w', index: 0, text: 'Said here first.', messageId: 'm-1' });
      await waitFor(() => h.received.filter((m) => m.type === 'block_complete').length === 2, 'the block here');
      h.interrupt({ channelId: '111', spokenText: 'Said here' });
      await waitFor(() => h.notes.length === 2, 'the second note');
      expect(h.edits.map((e) => [e.messageId, e.content])).toEqual([['m-k', 'Said'], ['m-1', 'Said here']]);
    });

    test("a message on another channel since the start marks the first message's record, though a start elsewhere came after it", async () => {
      const h = await harness();
      h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
      h.emit({ type: 'inference:started', agentName: 'Kestrel', channelId: ELSEWHERE });
      h.emit({ type: 'inference:published', agentName: 'Kestrel', channelId: ELSEWHERE, inferenceId: 'inf_k', index: 0, text: 'Said there.', messageId: 'm-k' });
      h.emit({ type: 'inference:started', agentName: 'Robin', channelId: '333' });
      h.emit({ type: 'inference:published', agentName: 'Wren', channelId: LOCUS, inferenceId: 'inf_w', index: 0, text: 'Said here first.', messageId: 'm-1' });
      await waitFor(() => h.received.filter((m) => m.type === 'block_complete').length === 2, 'both blocks');
      h.interrupt({ channelId: '111', spokenText: 'Said here' });
      await waitFor(() => h.notes.length > 0, 'the note');
      expect(h.edits).toEqual([]);
      expect(h.notes[0]).toContain('this bot started or spoke on another channel since');
    });

    test("no words on a record that can't line up say this host can't tell what was heard, and quote nothing", async () => {
      for (const spokenText of ['', ' … - ']) {
        const h = await turnOf([{ text: 'Said here first.', messageId: 'm-1' }]);
        h.emit({ type: 'inference:published', agentName: 'Wren', channelId: ELSEWHERE, inferenceId: 'inf_t', index: 1, text: 'Said there.', messageId: 'm-2' });
        await waitFor(() => h.received.filter((m) => m.type === 'block_complete').length === 2, 'both blocks');
        h.interrupt({ channelId: '111', spokenText });
        await waitFor(() => h.notes.length > 0, 'the note to the agent');
        expect(h.edits).toEqual([]);
        expect(h.notes[0]).toContain('with no words voiced since the voice client last started over');
        expect(h.notes[0]).toContain("this host can't tell which of your messages here were heard");
        expect(h.notes[0]).not.toContain('after "');
      }
    });

    test('words with no letter or digit on a record that lines up say nothing was voiced', async () => {
      const h = await turnOf([{ text: 'Said here first.', messageId: 'm-1' }]);
      h.interrupt({ channelId: '111', spokenText: ' … - ' });
      await waitFor(() => h.notes.length > 0, 'the note to the agent');
      expect(h.edits).toEqual([]);
      expect(h.notes[0]).toContain("before any of it was voiced, so nothing was trimmed: your message here wasn't voiced before the interruption.");
    });

    test('the note counts the messages not voiced: one, or several', async () => {
      const one = await turnOf([{ text: 'Only this.', messageId: 'm-1' }]);
      one.interrupt({ channelId: '111', spokenText: '' });
      await waitFor(() => one.notes.length > 0, 'the note for one');
      expect(one.notes[0]).toContain(": your message here wasn't voiced before the interruption.");
      const two = await turnOf([{ text: 'This.', messageId: 'm-1' }, { text: 'And this.', messageId: 'm-2' }]);
      two.interrupt({ channelId: '111', spokenText: '' });
      await waitFor(() => two.notes.length > 0, 'the note for two');
      expect(two.notes[0]).toContain(': none of your 2 messages here was voiced before the interruption.');
    });

    test('a turn stopped while the relay is away keeps the reading stopped once it is back', async () => {
      const h = await turnOf([{ text: 'Stopped while away.', messageId: 'm-1' }], { reconnectIntervalMs: 20 });
      await h.away();
      h.emit({ type: 'inference:aborted', agentName: 'Wren' });
      await h.back();
      await waitFor(() => h.received.some((m) => m.type === 'activation_end'), 'the missed end');
      h.interrupt({ channelId: '111', spokenText: 'Stopped' });
      await waitFor(() => h.notes.length > 0, 'the note to the agent');
      expect(h.edits).toEqual([]);
      expect(h.notes[0]).toContain('a turn was stopped since');
    });

    test("the first reason a record can't line up is the one the note gives", async () => {
      // A stopped turn, then another channel's start and message: stopped.
      const stopped = await turnOf([{ text: 'Said here first.', messageId: 'm-1' }]);
      stopped.emit({ type: 'inference:aborted', agentName: 'Wren' });
      stopped.emit({ type: 'inference:started', agentName: 'Kestrel', channelId: ELSEWHERE });
      stopped.emit({ type: 'inference:published', agentName: 'Kestrel', channelId: ELSEWHERE, inferenceId: 'inf_k', index: 0, text: 'Said there.' });
      await waitFor(() => stopped.received.filter((m) => m.type === 'block_complete').length === 2, 'both blocks');
      stopped.interrupt({ channelId: '111', spokenText: 'Said here' });
      await waitFor(() => stopped.notes.length > 0, 'the stopped note');
      expect(stopped.notes[0]).toContain('a turn was stopped since');
      // A message on another channel, then a stopped turn: elsewhere.
      const elsewhere = await turnOf([{ text: 'Said here first.', messageId: 'm-1' }]);
      elsewhere.emit({ type: 'inference:published', agentName: 'Wren', channelId: ELSEWHERE, inferenceId: 'inf_t', index: 1, text: 'Said there.' });
      await waitFor(() => elsewhere.received.filter((m) => m.type === 'block_complete').length === 2, 'both blocks');
      elsewhere.emit({ type: 'inference:aborted', agentName: 'Wren' });
      await waitFor(() => elsewhere.received.some((m) => m.type === 'activation_end'), 'the end');
      elsewhere.interrupt({ channelId: '111', spokenText: 'Said here' });
      await waitFor(() => elsewhere.notes.length > 0, 'the elsewhere note');
      expect(elsewhere.notes[0]).toContain('this bot started or spoke on another channel since');
    });

    test('every note that quotes the words heard quotes their last 200 characters', async () => {
      const long = `${'word '.repeat(60)}end`;
      const tail = `"…${[...long].slice(-200).join('')}"`;
      // A cut message with no id, and a failed edit.
      const noId = await turnOf([{ text: `${long} and more after it.` }]);
      noId.interrupt({ channelId: '111', spokenText: long });
      await waitFor(() => noId.notes.length > 0, 'the no-id note');
      expect(noId.notes[0]).toContain(tail);
      const failed = await turnOf([{ text: `${long} and more after it.`, messageId: 'm-1' }], { editResult: { success: false, error: 'gone' } });
      failed.interrupt({ channelId: '111', spokenText: long });
      await waitFor(() => failed.notes.length > 0, 'the failed-edit note');
      expect(failed.notes[0]).toContain(tail);
      // A record that can't line up, and words that don't follow what was sent.
      const unaligned = await turnOf([{ text: `${long} and more after it.`, messageId: 'm-1' }]);
      unaligned.emit({ type: 'inference:published', agentName: 'Wren', channelId: ELSEWHERE, inferenceId: 'inf_t', index: 1, text: 'Said there.' });
      await waitFor(() => unaligned.received.filter((m) => m.type === 'block_complete').length === 2, 'both blocks');
      unaligned.interrupt({ channelId: '111', spokenText: long });
      await waitFor(() => unaligned.notes.length > 0, 'the unaligned note');
      expect(unaligned.notes[0]).toContain(`after ${tail}`);
      const unmatched = await turnOf([{ text: 'Something else entirely.', messageId: 'm-1' }]);
      unmatched.interrupt({ channelId: '111', spokenText: long });
      await waitFor(() => unmatched.notes.length > 0, 'the unmatched note');
      expect(unmatched.notes[0]).toContain(`after ${tail}`);
    });

    test('a long cut is quoted by its end, as every note quotes the words heard', async () => {
      const long = `${'word '.repeat(60)}end`;
      const h = await turnOf([{ text: `${long} and more after it.`, messageId: 'm-1' }]);
      h.interrupt({ channelId: '111', spokenText: long });
      await waitFor(() => h.notes.length > 0, 'the note to the agent');
      expect(h.edits.map((e) => e.content)).toEqual([long]);
      expect(h.notes[0]).toContain(`trimmed to match: "…${[...long].slice(-200).join('')}"`);
    });

    test('past the messages a channel keeps, words that end in the kept ones still trim, and the rest count as unvoiced', async () => {
      const messages = Array.from({ length: 66 }, (_, i) => ({ text: `Message number ${i + 1}.`, messageId: `m-${i + 1}` }));
      const h = await turnOf(messages);
      h.interrupt({ channelId: '111', spokenText: 'Message number 1.Message num' });
      await waitFor(() => h.notes.length > 0, 'the note to the agent');
      expect(h.edits.map((e) => [e.messageId, e.content])).toEqual([['m-2', 'Message num']]);
      expect(h.notes[0]).toContain("Your 64 later messages here weren't voiced before the interruption.");
    });

    test("words that run past the messages a channel keeps edit nothing, and say why", async () => {
      const messages = Array.from({ length: 65 }, (_, i) => ({ text: `Line ${i + 1}.`, messageId: `m-${i + 1}` }));
      const h = await turnOf(messages);
      const spoken = messages.slice(0, 64).map((m) => m.text).join('') + 'Line 6';
      h.interrupt({ channelId: '111', spokenText: spoken });
      await waitFor(() => h.notes.length > 0, 'the note to the agent');
      expect(h.edits).toEqual([]);
      expect(h.notes[0]).toContain('more messages were voiced here than this host keeps');
      // The note quotes only the end of a long text.
      expect(h.notes[0]).toContain(`after "…${[...spoken].slice(-200).join('')}"`);
    });

    test('the edit goes to the configured server, and no note is added when notes are off', async () => {
      const h = await turnOf([{ text: 'Trimmed without a note.', messageId: 'm-1' }], { editServerId: 'discord-alt', notifyOnInterruption: false });
      h.interrupt({ channelId: '111', spokenText: 'Trimmed' });
      await waitFor(() => h.edits.length === 1, 'the edit');
      // The handler adds its note right after the edit's answer, in a
      // microtask, which runs before this timer.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(h.edits).toEqual([{ tool: 'mcpl--discord-alt--edit_message', channelId: '111', messageId: 'm-1', content: 'Trimmed' }]);
      expect(h.notes).toEqual([]);
    });

    test('only what was voiced since the channel\'s activation started is read', async () => {
      const h = await harness();
      h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
      h.emit({ type: 'inference:published', agentName: 'Wren', channelId: LOCUS, inferenceId: 'inf_o', index: 0, text: 'An earlier turn.', messageId: 'm-old' });
      h.emit({ type: 'inference:completed', agentName: 'Wren' });
      h.emit({ type: 'inference:started', agentName: 'Wren', channelId: LOCUS });
      h.emit({ type: 'inference:published', agentName: 'Wren', channelId: LOCUS, inferenceId: 'inf_n', index: 0, text: 'This turn speaks.', messageId: 'm-new' });
      await waitFor(() => h.received.filter((m) => m.type === 'block_complete').length === 2, 'both blocks');
      h.interrupt({ channelId: '111', spokenText: 'This turn sp' });
      await waitFor(() => h.notes.length > 0, 'the note to the agent');
      expect(h.edits.map((e) => [e.messageId, e.content])).toEqual([['m-new', 'This turn sp']]);
    });

    test('after an interruption, the next words are read from the messages sent after it', async () => {
      const h = await turnOf([{ text: 'Before the user spoke.', messageId: 'm-1' }]);
      h.interrupt({ channelId: '111', spokenText: 'Before the' });
      await waitFor(() => h.notes.length === 1, 'the first note');
      h.emit({ type: 'inference:published', agentName: 'Wren', channelId: LOCUS, inferenceId: 'inf_t', index: 5, text: 'After it.', messageId: 'm-2' });
      await waitFor(() => h.received.filter((m) => m.type === 'block_complete').length === 2, 'the second block');
      h.interrupt({ channelId: '111', spokenText: 'After' });
      await waitFor(() => h.notes.length === 2, 'the second note');
      expect(h.edits.map((e) => [e.messageId, e.content])).toEqual([['m-1', 'Before the'], ['m-2', 'After']]);
    });

    test('words with no letter or digit edit nothing', async () => {
      const h = await turnOf([{ text: 'Never heard.', messageId: 'm-1' }]);
      h.interrupt({ channelId: '111', spokenText: '  … ' });
      await waitFor(() => h.notes.length > 0, 'the note to the agent');
      expect(h.edits).toEqual([]);
      expect(h.notes[0]).toContain('before any of it was voiced');
      expect(h.notes[0]).toContain("your message here wasn't voiced before the interruption");
      expect(h.notes[0]).not.toContain('later');
    });

    test('a cut message with no id is left as it is, and the note says why', async () => {
      const h = await turnOf([{ text: 'Posted by a server that returns no id.' }]);
      h.interrupt({ channelId: '111', spokenText: 'Posted by' });
      await waitFor(() => h.notes.length > 0, 'the note to the agent');
      expect(h.edits).toEqual([]);
      expect(h.notes[0]).toContain('has no id to edit');
    });

    test('a failed edit is told as a failed trim', async () => {
      const h = await turnOf([{ text: 'The edit of this one fails.', messageId: 'm-1' }], { editResult: { success: false, error: 'Missing Access' } });
      h.interrupt({ channelId: '111', spokenText: 'The edit' });
      await waitFor(() => h.notes.length > 0, 'the note to the agent');
      expect(h.edits.map((e) => e.messageId)).toEqual(['m-1']);
      expect(h.notes[0]).toContain('trimming the posted message failed');
    });
  });
});

describe('readInterruption', () => {
  const sent = [{ messageId: 'a', content: 'Ab, cd.' }, { messageId: 'b', content: 'Ef gh.' }];

  test('words past everything sent are unmatched', () => {
    expect(readInterruption(sent, 'Ab cd ef gh ij').kind).toBe('unmatched');
  });

  test('words that end with the last message leave nothing cut or unvoiced', () => {
    expect(readInterruption(sent, 'ab, cd. ef gh')).toEqual({ kind: 'between', unvoiced: 0 });
  });

  test('a cut keeps the message\'s text through its last heard letter', () => {
    expect(readInterruption(sent, 'Ab cd e')).toEqual({ kind: 'cut', message: sent[1], heard: 'E', unvoiced: 0 });
  });

  test('nothing sent is its own reading', () => {
    expect(readInterruption([], 'anything')).toEqual({ kind: 'nothing-sent' });
  });

  test('words with no letter or digit voiced nothing, with nothing sent too', () => {
    expect(readInterruption([], '')).toEqual({ kind: 'none-voiced', unvoiced: 0 });
  });

  test('words with no letter or digit voiced none of the messages', () => {
    expect(readInterruption(sent, ' … ')).toEqual({ kind: 'none-voiced', unvoiced: 2 });
  });

  test('a text past 1900 characters, once each @ grows by 22, may have been split', () => {
    expect(mayBeSplit('a'.repeat(1900))).toBe(false);
    expect(mayBeSplit('a'.repeat(1901))).toBe(true);
    // 1878 characters and one @: 1900 at most once pinged.
    expect(mayBeSplit(`@${'a'.repeat(1877)}`)).toBe(false);
    expect(mayBeSplit(`@${'a'.repeat(1878)}`)).toBe(true);
    // Each @ counts.
    expect(mayBeSplit(`@a @b ${'c'.repeat(1850)}`)).toBe(false);
    expect(mayBeSplit(`@a @b ${'c'.repeat(1851)}`)).toBe(true);
  });

  test("the client's announcement of the bot is passed over before the first message or a later one", () => {
    const announcement = 'Wren says:';
    expect(readInterruption(sent, 'Wren says:Ab, cd.Ef', { announcement })).toEqual({ kind: 'cut', message: sent[1], heard: 'Ef', unvoiced: 0 });
    expect(readInterruption(sent, 'Ab, cd.Wren says:Ef', { announcement })).toEqual({ kind: 'cut', message: sent[1], heard: 'Ef', unvoiced: 0 });
  });

  test('words that end in an announcement end before its message', () => {
    const announcement = 'Wren says:';
    expect(readInterruption(sent, 'Wren sa', { announcement })).toEqual({ kind: 'none-voiced', unvoiced: 2 });
    expect(readInterruption(sent, 'Ab, cd.Wren says:', { announcement })).toEqual({ kind: 'between', unvoiced: 1 });
  });

  test('messages not kept count as unvoiced after words that end in the kept ones', () => {
    expect(readInterruption(sent, 'Ab cd e', { notKept: 3 })).toEqual({ kind: 'cut', message: sent[1], heard: 'E', unvoiced: 3 });
    expect(readInterruption(sent, 'Ab cd', { notKept: 3 })).toEqual({ kind: 'between', unvoiced: 4 });
  });

  test('words past the kept messages, when some were not kept, run past the record', () => {
    expect(readInterruption(sent, 'Ab cd ef gh ij', { notKept: 1 })).toEqual({ kind: 'past-record' });
  });
});
