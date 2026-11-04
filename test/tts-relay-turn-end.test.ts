import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { ModuleContext, TraceEvent } from '@animalabs/agent-framework';
import { TtsRelayModule, type TtsRelayModuleConfig } from '../src/modules/tts-relay-module.js';

type RelayMessage = { type: string } & Record<string, unknown>;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

async function harness(config: Partial<TtsRelayModuleConfig> = {}) {
  const received: RelayMessage[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      return srv.upgrade(req) ? undefined : new Response('no', { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        const msg = JSON.parse(String(raw)) as RelayMessage;
        if (msg.type === 'auth') ws.send(JSON.stringify({ type: 'auth_ok' }));
        else received.push(msg);
      },
    },
  });
  let listener: ((e: TraceEvent) => void) | null = null;
  const ctx = {
    getAgents: () => [{ name: 'Wren' }],
    onTrace: (cb: (e: TraceEvent) => void) => { listener = cb; return () => { listener = null; }; },
  } as unknown as ModuleContext;
  const module = new TtsRelayModule({ url: `ws://127.0.0.1:${server.port}/bot`, token: 't', reconnectIntervalMs: 50, ...config });
  await module.start(ctx);
  cleanups.push(async () => { await module.stop(); server.stop(true); });
  const connected = () =>
    (module as unknown as { client: { isConnected(): boolean } | null }).client?.isConnected() ?? false;
  await waitFor(connected, 'the relay to authenticate the module');
  const emit = (event: Record<string, unknown>) => listener?.({ agentName: 'Wren', ...event } as unknown as TraceEvent);
  return { received, emit };
}

const CHANNEL = 'discord:guild:123';

describe('a turn a tool ended', () => {
  test('ends its activation as complete, and the next turn opens its own', async () => {
    const { received, emit } = await harness();
    const kinds = () => received.map((m) => `${m.type}${m.reason ? `:${String(m.reason)}` : ''}`);

    emit({ type: 'inference:started', channelId: CHANNEL });
    emit({ type: 'inference:tokens', content: 'Nothing to add.', blockType: 'text', blockIndex: 0, channelId: CHANNEL });
    emit({ type: 'inference:turn_ended' });
    await waitFor(() => kinds().includes('activation_end:complete'), 'the activation end');
    expect(kinds()).toEqual(['activation_start', 'activation_end:complete']);
    expect(received[1]).toMatchObject({ channelId: '123', username: 'Wren' });

    emit({ type: 'inference:started', channelId: CHANNEL });
    emit({ type: 'inference:completed' });
    await waitFor(() => received.length === 4, 'the second turn');
    expect(kinds().slice(2)).toEqual(['activation_start', 'activation_end:complete']);
  }, 30_000);

  test('another agent\'s turn a tool ended leaves this agent\'s activation open', async () => {
    const { received, emit } = await harness();
    const kinds = () => received.map((m) => `${m.type}${m.reason ? `:${String(m.reason)}` : ''}`);
    emit({ type: 'inference:started', channelId: CHANNEL });
    emit({ type: 'inference:turn_ended', agentName: 'spawn-research-1' });
    emit({ type: 'inference:published', serverId: 'discord', channelId: CHANNEL, inferenceId: 'i1', index: 0, text: 'Still here.' });
    await waitFor(() => kinds().includes('block_complete'), 'the message after the other agent\'s end');
    emit({ type: 'inference:completed' });
    await waitFor(() => kinds().includes('activation_end:complete'), 'the activation end');
    expect(kinds()).toEqual(['activation_start', 'block_start', 'chunk', 'block_complete', 'activation_end:complete']);
  }, 30_000);

  test('a turn that sends both ends, in either order, ends its activation once', async () => {
    const { received, emit } = await harness();
    for (const ends of [['inference:completed', 'inference:turn_ended'], ['inference:turn_ended', 'inference:completed']]) {
      emit({ type: 'inference:started', channelId: CHANNEL });
      for (const type of ends) emit({ type });
    }
    emit({ type: 'inference:started', channelId: CHANNEL });
    emit({ type: 'inference:aborted' });
    await waitFor(() => received.some((m) => m.reason === 'abort'), 'the third turn\'s end');
    expect(received.map((m) => `${m.type}${m.reason ? `:${String(m.reason)}` : ''}`)).toEqual([
      'activation_start', 'activation_end:complete',
      'activation_start', 'activation_end:complete',
      'activation_start', 'activation_end:abort',
    ]);
  }, 30_000);
});

describe('a failed attempt', () => {
  test('that the framework retries leaves the activation open, so what the turn published before it is still voiced', async () => {
    const { received, emit } = await harness();
    const kinds = () => received.map((m) => `${m.type}${m.reason ? `:${String(m.reason)}` : ''}`);
    emit({ type: 'inference:started', channelId: CHANNEL });
    emit({ type: 'inference:published', serverId: 'discord', channelId: CHANNEL, inferenceId: 'i1', index: 0, text: 'Let me check.', messageId: 'm1' });
    emit({ type: 'inference:failed', error: 'overloaded' });
    emit({ type: 'inference:started', channelId: CHANNEL });
    emit({ type: 'inference:published', serverId: 'discord', channelId: CHANNEL, inferenceId: 'i2', index: 0, text: 'It opens at nine.', messageId: 'm2' });
    emit({ type: 'inference:completed' });
    await waitFor(() => kinds().some((k) => k.startsWith('activation_end')), 'the turn\'s end');
    expect(kinds()).toEqual([
      'activation_start',
      'block_start', 'chunk', 'block_complete',
      'block_start', 'chunk', 'block_complete',
      'activation_end:complete',
    ]);
  }, 30_000);

  test('that the framework gives up on ends the activation as an error, once', async () => {
    const { received, emit } = await harness();
    const kinds = () => received.map((m) => `${m.type}${m.reason ? `:${String(m.reason)}` : ''}`);
    emit({ type: 'inference:started', channelId: CHANNEL });
    emit({ type: 'inference:failed', error: 'overloaded' });
    emit({ type: 'inference:exhausted', error: 'overloaded' });
    emit({ type: 'inference:started', channelId: CHANNEL });
    emit({ type: 'inference:completed' });
    await waitFor(() => received.length === 4, 'the next turn\'s end');
    expect(kinds()).toEqual([
      'activation_start', 'activation_end:error',
      'activation_start', 'activation_end:complete',
    ]);
  }, 30_000);
});

describe('what the relay is given to voice', () => {
  test("each message the agent published, as a whole text block on its channel; none of what the model wrote", async () => {
    const { received, emit } = await harness();
    emit({ type: 'inference:started', channelId: CHANNEL });
    emit({ type: 'inference:content_block', phase: 'block_start', blockType: 'thinking', blockIndex: 0, channelId: CHANNEL });
    emit({ type: 'inference:tokens', content: 'Weighing the route.', blockType: 'thinking', blockIndex: 0, channelId: CHANNEL });
    emit({ type: 'inference:content_block', phase: 'block_complete', blockType: 'thinking', blockIndex: 0, channelId: CHANNEL });
    emit({ type: 'inference:content_block', phase: 'block_start', blockType: 'text', blockIndex: 1, channelId: CHANNEL });
    emit({ type: 'inference:tokens', content: 'An aside for no one. ', blockType: 'text', blockIndex: 1, channelId: CHANNEL });
    emit({ type: 'inference:tokens', content: '>> The ferry leaves at noon.', blockType: 'text', blockIndex: 1, channelId: CHANNEL });
    emit({ type: 'inference:content_block', phase: 'block_complete', blockType: 'text', blockIndex: 1, channelId: CHANNEL });
    const publish = (channelId: string, index: number, text: string) =>
      emit({ type: 'inference:published', serverId: 'discord', channelId, inferenceId: 'i1', index, text, messageId: `m${index}` });
    publish(CHANNEL, 0, 'The ferry leaves at noon.');
    publish('discord:guild:456', 1, 'Take the coast road.');
    // agent-framework 0.32.0 can send a turn's publish after its inference:completed.
    emit({ type: 'inference:completed' });
    publish(CHANNEL, 2, '\n\n');
    publish(CHANNEL, 3, '\n\nOr wait for the bus.');
    await waitFor(() => received.filter((m) => m.type === 'block_complete').length === 3, 'the third message');

    const all = JSON.stringify(received);
    for (const unpublished of ['Weighing', 'An aside', '>>']) expect(all).not.toContain(unpublished);
    expect(received.map((m) => m.type)).toEqual([
      'activation_start',
      'block_start', 'chunk', 'block_complete',
      'block_start', 'chunk', 'block_complete',
      'activation_end',
      'block_start', 'chunk', 'block_complete',
    ]);
    const blocks = received.filter((m) => m.blockType !== undefined);
    expect(blocks.every((m) => m.blockType === 'text')).toBe(true);
    expect(blocks.filter((m) => m.type === 'block_start').map((m) => m.channelId)).toEqual(['123', '456', '123']);
    expect(blocks.filter((m) => m.type === 'chunk').map((m) => [m.channelId, m.text, m.visible])).toEqual([
      ['123', 'The ferry leaves at noon.', true], ['456', 'Take the coast road.', true], ['123', 'Or wait for the bus.', true],
    ]);
    expect(blocks.filter((m) => m.type === 'block_complete').map((m) => [m.channelId, m.content])).toEqual([
      ['123', 'The ferry leaves at noon.'], ['456', 'Take the coast road.'], ['123', 'Or wait for the bus.'],
    ]);
  }, 30_000);

  test("a message published to another server isn't voiced", async () => {
    const { received, emit } = await harness();
    emit({ type: 'inference:started', channelId: CHANNEL });
    emit({ type: 'inference:published', serverId: 'zulip', channelId: 'zulip:stream:123', inferenceId: 'i1', index: 0, text: 'Over on the other server.', messageId: 'z1' });
    emit({ type: 'inference:published', serverId: 'discord', channelId: CHANNEL, inferenceId: 'i1', index: 1, text: 'Here on Discord.', messageId: 'd1' });
    await waitFor(() => received.some((m) => m.type === 'block_complete'), 'the Discord message');
    expect(JSON.stringify(received)).not.toContain('Over on the other server.');
    expect(received.filter((m) => m.type === 'chunk').map((m) => [m.channelId, m.text])).toEqual([['123', 'Here on Discord.']]);
  }, 30_000);

  test("a server whose messages aren't voiced is logged once, naming the server the relay voices", async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { received, emit } = await harness();
      emit({ type: 'inference:started', channelId: CHANNEL });
      emit({ type: 'inference:published', serverId: 'zulip', channelId: 'zulip:stream:7', inferenceId: 'i1', index: 0, text: 'One.', messageId: 'z1' });
      emit({ type: 'inference:published', serverId: 'zulip', channelId: 'zulip:stream:7', inferenceId: 'i1', index: 1, text: 'Two.', messageId: 'z2' });
      emit({ type: 'inference:published', serverId: 'slack', channelId: 'slack:team:9', inferenceId: 'i1', index: 2, text: 'Three.', messageId: 's1' });
      emit({ type: 'inference:published', serverId: 'discord', channelId: CHANNEL, inferenceId: 'i1', index: 3, text: 'Here on Discord.', messageId: 'd1' });
      await waitFor(() => received.some((m) => m.type === 'block_complete'), 'the Discord message');
      const unvoiced = errors.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("aren't voiced"));
      expect(unvoiced).toEqual([
        "[tts-relay] messages published on server 'zulip' aren't voiced: the relay voices only server 'discord', the default when modules.ttsRelay.editServerId is unset. Later ones on 'zulip' aren't logged.",
        "[tts-relay] messages published on server 'slack' aren't voiced: the relay voices only server 'discord', the default when modules.ttsRelay.editServerId is unset. Later ones on 'slack' aren't logged.",
      ]);
    } finally {
      errors.mockRestore();
    }
  }, 30_000);

  test("with editServerId set, the log names the server it sets", async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { received, emit } = await harness({ editServerId: 'discord-main' });
      emit({ type: 'inference:started', channelId: 'discord-main:guild:123' });
      emit({ type: 'inference:published', serverId: 'discord', channelId: CHANNEL, inferenceId: 'i1', index: 0, text: 'Not here.', messageId: 'x1' });
      emit({ type: 'inference:published', serverId: 'discord-main', channelId: 'discord-main:guild:123', inferenceId: 'i1', index: 1, text: 'Here.', messageId: 'd1' });
      await waitFor(() => received.some((m) => m.type === 'block_complete'), 'the voiced message');
      expect(received.filter((m) => m.type === 'chunk').map((m) => [m.channelId, m.text])).toEqual([['123', 'Here.']]);
      const unvoiced = errors.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("aren't voiced"));
      expect(unvoiced).toEqual([
        "[tts-relay] messages published on server 'discord' aren't voiced: the relay voices only server 'discord-main', which modules.ttsRelay.editServerId names. Later ones on 'discord' aren't logged.",
      ]);
    } finally {
      errors.mockRestore();
    }
  }, 30_000);
});
