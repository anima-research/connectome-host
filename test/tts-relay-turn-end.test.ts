/**
 * TtsRelayModule's activation for a turn a tool ended: `inference:turn_ended`
 * (skip_reply, sleep) ends the activation as `complete`, as a turn that
 * streams to its end does, so the next turn on the channel opens one of its
 * own. Driven against a stand-in for the relay's /bot endpoint.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { ModuleContext, TraceEvent } from '@animalabs/agent-framework';
import { TtsRelayModule } from '../src/modules/tts-relay-module.js';

type RelayMessage = { type: string } & Record<string, unknown>;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

/** Waits for something the relay is sent; the deadline only guards a wait
 *  that would otherwise never end, so it is far above the milliseconds a
 *  message takes. */
async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

/** A relay that answers the module's auth and records what it's sent, and
 *  the module started on a context whose traces the test emits. */
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
  // The module sends nothing until the relay's auth_ok has reached it.
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
    expect(kinds()).toEqual(['activation_start', 'chunk', 'activation_end:complete']);
    expect(received[2]).toMatchObject({ channelId: '123', username: 'Wren' });

    emit({ type: 'inference:started', channelId: CHANNEL });
    emit({ type: 'inference:completed' });
    await waitFor(() => received.length === 5, 'the second turn');
    expect(kinds().slice(3)).toEqual(['activation_start', 'activation_end:complete']);
  }, 30_000);

  test('another agent\'s turn a tool ended leaves this agent\'s activation open', async () => {
    const { received, emit } = await harness();
    const kinds = () => received.map((m) => `${m.type}${m.reason ? `:${String(m.reason)}` : ''}`);
    emit({ type: 'inference:started', channelId: CHANNEL });
    emit({ type: 'inference:turn_ended', agentName: 'spawn-research-1' });
    emit({ type: 'inference:tokens', content: 'Still here.', blockType: 'text', blockIndex: 0, channelId: CHANNEL });
    await waitFor(() => kinds().includes('chunk'), 'the chunk after the other agent\'s end');
    emit({ type: 'inference:completed' });
    await waitFor(() => kinds().includes('activation_end:complete'), 'the activation end');
    expect(kinds()).toEqual(['activation_start', 'chunk', 'activation_end:complete']);
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
