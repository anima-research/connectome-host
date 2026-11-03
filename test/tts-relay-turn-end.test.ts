import { afterEach, describe, expect, test } from 'bun:test';
import type { ModuleContext, TraceEvent } from '@animalabs/agent-framework';
import { TtsRelayModule } from '../src/modules/tts-relay-module.js';

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

async function harness() {
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
  const module = new TtsRelayModule({ url: `ws://127.0.0.1:${server.port}/bot`, token: 't', reconnectIntervalMs: 50 });
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
    emit({ type: 'inference:tokens', content: 'Weighing the route.', blockType: 'thinking', blockIndex: 0, channelId: CHANNEL });
    emit({ type: 'inference:tokens', content: 'An aside for no one. ', blockType: 'text', blockIndex: 1, channelId: CHANNEL });
    emit({ type: 'inference:tokens', content: '>> The ferry leaves at noon.', blockType: 'text', blockIndex: 1, channelId: CHANNEL });
    emit({ type: 'inference:content_block', phase: 'block_complete', blockType: 'text', blockIndex: 1, channelId: CHANNEL });
    const published = { serverId: 'discord', channelId: CHANNEL, inferenceId: 'i1' };
    emit({ type: 'inference:published', ...published, index: 0, text: 'The ferry leaves at noon.', messageId: 'm1' });
    emit({ type: 'inference:published', ...published, index: 1, text: '\n\nTake the coast road.', messageId: 'm2' });
    emit({ type: 'inference:completed' });
    await waitFor(() => received.some((m) => m.type === 'activation_end'), 'the turn\'s end');

    const all = JSON.stringify(received);
    for (const unpublished of ['Weighing', 'An aside', '>>']) expect(all).not.toContain(unpublished);
    expect(received.map((m) => m.type)).toEqual([
      'activation_start',
      'block_start', 'chunk', 'block_complete',
      'block_start', 'chunk', 'block_complete',
      'activation_end',
    ]);
    const blocks = received.filter((m) => m.blockType !== undefined);
    expect(blocks.every((m) => m.blockType === 'text' && m.channelId === '123')).toBe(true);
    expect(blocks.filter((m) => m.type === 'chunk').map((m) => [m.text, m.visible])).toEqual([
      ['The ferry leaves at noon.', true], ['Take the coast road.', true],
    ]);
    expect(blocks.filter((m) => m.type === 'block_complete').map((m) => m.content)).toEqual([
      'The ferry leaves at noon.', 'Take the coast road.',
    ]);
  }, 30_000);
});
