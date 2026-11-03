import type { ProcessEvent } from '@animalabs/agent-framework';

/**
 * A message addressed to the agent from a channel it hasn't opened, such as a
 * mention in a closed channel, a reply or a first DM, arrives as
 * `mcpl:push-event` rather than `mcpl:channel-incoming`. The framework
 * expands the tags at entry, so `chat:mention`, `chat:reply` and `chat:dm`
 * arrive with `chat:addressed`. discord-mcpl tags a person's message
 * `chat:from-human` and a bot's `chat:from-bot`. The channel is the origin's
 * `mcplChannelId`, the composite id the framework registers and routes by.
 */
export function addressedPush(event: ProcessEvent): { channelId: string; origin: Record<string, unknown> } | undefined {
  if (event.type !== 'mcpl:push-event') return undefined;
  const e = event as unknown as { tags?: unknown; origin?: Record<string, unknown> | null };
  if (!Array.isArray(e.tags) || !e.tags.includes('chat:addressed')) return undefined;
  if (!e.tags.includes('chat:from-human')) return undefined;
  const channelId = e.origin?.mcplChannelId;
  if (!e.origin || typeof channelId !== 'string' || !channelId) return undefined;
  return { channelId, origin: e.origin };
}
