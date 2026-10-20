import type { ProcessEvent } from '@animalabs/agent-framework';

/**
 * The channel a person's message addressed to the agent came from, when it
 * arrived as an MCPL push event, and the server's origin for it; undefined
 * for any other event or push.
 *
 * A message addressed to the agent from a channel it hasn't opened, such as a
 * mention in a closed channel, a reply or a first DM, arrives as
 * `mcpl:push-event` rather than `mcpl:channel-incoming`. The framework
 * expands the tags at entry, so `chat:mention`, `chat:reply` and `chat:dm`
 * arrive with `chat:addressed`. It's a person's when it's tagged
 * `chat:from-human`, as discord-mcpl and zulip_mcp tag a person's message: a
 * bot's is `chat:from-bot`, and zulip_mcp's catch-up summary of missed
 * messages and its markers for an edited or deleted message carry neither.
 * The channel is the origin's `mcplChannelId`, the composite id the
 * framework registers and routes by, which zulip_mcp and every discord-mcpl
 * release set.
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
