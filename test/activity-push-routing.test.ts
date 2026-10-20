/**
 * ActivityModule's routing hints: typing in a channel echoes the newest
 * message's metadata back to its server. A message addressed to the agent
 * from a channel it hasn't opened arrives as an `mcpl:push-event`, and its
 * origin carries the hints, such as zulip_mcp's topic.
 */
import { expect, test } from 'bun:test';
import type { ModuleContext, TraceEvent } from '@animalabs/agent-framework';
import { ActivityModule } from '../src/modules/activity-module.js';

async function setUp() {
  const typing: Array<[string, Record<string, unknown> | undefined]> = [];
  const listeners = new Set<(e: TraceEvent) => void>();
  const framework = {
    onTrace: (cb: (e: TraceEvent) => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    channels: {
      startTyping: (ch: string, metadata?: Record<string, unknown>) => { typing.push([ch, metadata]); },
      stopTyping: () => {},
    },
  };
  const module = new ActivityModule({ initialChannels: ['zulip:general'] });
  const ctx = { getState: () => null, setState: () => {}, getModule: () => undefined } as unknown as ModuleContext;
  await module.start(ctx);
  module.setFramework(framework as never);
  const turn = () => { for (const l of [...listeners]) l({ type: 'inference:started', agentName: 'clerk' } as unknown as TraceEvent); };
  const push = (origin: Record<string, unknown>, tags: string[]) =>
    module.onProcess({
      type: 'mcpl:push-event', serverId: 'zulip', featureSet: 'zulip.messaging', eventId: 'zulip_msg_4',
      content: [{ type: 'text', text: '@bot ping' }], origin, tags,
    } as never, {} as never);
  return { typing, turn, push };
}

test("a mention pushed from a closed stream names its topic when typing shows there", async () => {
  const { typing, turn, push } = await setUp();
  await push(
    { source: 'zulip', mcplChannelId: 'zulip:general', stream: 'general', topic: 'standup', isMention: true },
    ['chat:mention', 'chat:from-human', 'chat:addressed'],
  );
  turn();
  expect(typing).toEqual([['zulip:general', expect.objectContaining({ topic: 'standup' })]]);
});

test("a push that isn't a person's message addressed to the agent leaves the hints as they were", async () => {
  const { typing, turn, push } = await setUp();
  await push(
    { source: 'zulip', mcplChannelId: 'zulip:general', stream: 'general', topic: 'standup', isMention: true },
    ['chat:mention', 'chat:from-human', 'chat:addressed'],
  );
  // A person's ambient message, zulip_mcp's catch-up summary of missed
  // messages (no topic, no sender tag), and a bot's mention.
  await push({ source: 'zulip', mcplChannelId: 'zulip:general', topic: 'chatter' }, ['chat:ambient', 'chat:from-human']);
  await push({ source: 'zulip', mcplChannelId: 'zulip:general', missed: true }, ['zulip:missed', 'chat:mention', 'chat:addressed']);
  await push({ source: 'zulip', mcplChannelId: 'zulip:general', topic: 'bots', isMention: true }, ['chat:mention', 'chat:from-bot', 'chat:addressed']);
  turn();
  expect(typing).toEqual([['zulip:general', expect.objectContaining({ topic: 'standup' })]]);
});
