/**
 * SubscriptionGcModule — auto-unsubscribe noisy ambient Discord channels.
 *
 * Problem: a subscribed channel delivers ambient (non-mention, non-DM) messages
 * into the agent's context whether or not the agent ever acts on them. A busy
 * channel the agent isn't engaging is pure context cost.
 *
 * Mechanic (host-side, because only the host sees activations):
 *   - Per subscribed channel, count ambient CHARACTERS as they arrive
 *     (`onProcess` over `mcpl:push-event` / `mcpl:channel-incoming`).
 *   - Every agent ACTIVATION (`inference:started` trace) zeroes ALL counters —
 *     the agent saw every subscribed channel in that context (compressed if
 *     large; nothing is dropped), so the slate is clean.
 *   - The instant a channel's since-last-activation count crosses its limit, it
 *     is auto-unsubscribed via the surface's `unsubscribe_channel` tool. This
 *     bounds any one channel's context pollution to ~limit characters.
 *
 * Everything is durable across restarts: counters + per-channel overrides
 * persist to chronicle (a restart is NOT an activation, so counters must carry
 * across downtime — they only reset when the agent actually runs).
 *
 * Config (recipe `modules.subscriptionGc`): `defaultLimitChars` (20000),
 * `serverId` (`discord`), `toolPrefix` (`mcpl--<serverId>`). The agent can
 * override per channel at runtime with `set_channel_idle_limit`.
 */

import type {
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
} from '@animalabs/agent-framework';

export interface SubscriptionGcConfig {
  /** Default ambient-character budget per channel before auto-unsubscribe. */
  defaultLimitChars?: number;
  /** MCPL server id that owns subscriptions (default 'discord'). */
  serverId?: string;
  /** Tool-name prefix for that server (default `mcpl--<serverId>`). */
  toolPrefix?: string;
}

/** `'off'` pins a channel (never auto-unsubscribe); a number overrides the
 *  default limit; absence falls back to the default. */
type LimitOverride = number | 'off';

interface GcState {
  overrides: Record<string, LimitOverride>;
  /** Ambient chars accrued per channel since the last activation. */
  counters: Record<string, number>;
}

const FLUSH_DEBOUNCE_MS = 2000;

export class SubscriptionGcModule implements Module {
  readonly name = 'subscription-gc';

  private ctx: ModuleContext | null = null;
  private unsubscribeTrace: (() => void) | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private callSeq = 0;

  private readonly defaultLimitChars: number;
  private readonly serverId: string;
  private readonly toolPrefix: string;

  private state: GcState = { overrides: {}, counters: {} };

  constructor(config: SubscriptionGcConfig = {}) {
    this.defaultLimitChars =
      typeof config.defaultLimitChars === 'number' && config.defaultLimitChars > 0
        ? Math.round(config.defaultLimitChars)
        : 20000;
    this.serverId = config.serverId ?? 'discord';
    this.toolPrefix = config.toolPrefix ?? `mcpl--${this.serverId}`;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    const saved = ctx.getState<Partial<GcState>>();
    if (saved) {
      this.state = {
        overrides: saved.overrides ?? {},
        counters: saved.counters ?? {},
      };
    }
    // Reset all counters on every activation: the agent just saw the full
    // context, so every subscribed channel is "seen". This is the ONLY reset —
    // never on restart.
    this.unsubscribeTrace = ctx.onTrace((e) => {
      if (e.type === 'inference:started') {
        if (Object.keys(this.state.counters).length > 0) {
          this.state.counters = {};
          this.persistNow();
        }
      }
    });
  }

  async stop(): Promise<void> {
    if (this.unsubscribeTrace) {
      this.unsubscribeTrace();
      this.unsubscribeTrace = null;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.persistNow(); // flush any pending counter changes before teardown
    this.ctx = null;
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'set_channel_idle_limit',
        description:
          'Set how many characters of ambient (non-mention, non-DM) traffic a ' +
          'subscribed channel may emit between your activations before it is ' +
          'auto-unsubscribed. `limit` is a number of characters, "default" to ' +
          `use the global default (${this.defaultLimitChars}), or "off" to ` +
          'never auto-unsubscribe this channel.',
        inputSchema: {
          type: 'object',
          properties: {
            channelId: { type: 'string', description: 'Discord channel ID' },
            limit: {
              type: 'string',
              description: 'A character count (e.g. "20000"), "default", or "off".',
            },
          },
          required: ['channelId', 'limit'],
        },
      },
      {
        name: 'list_channel_idle_limits',
        description:
          'Show the auto-unsubscribe configuration: the global default limit, ' +
          'per-channel overrides, and the current since-last-activation ambient ' +
          'character counts per channel.',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    const input = (call.input ?? {}) as Record<string, unknown>;
    switch (call.name) {
      case 'set_channel_idle_limit': {
        const channelId = input.channelId;
        if (typeof channelId !== 'string' || channelId.length === 0) {
          return { success: false, error: 'channelId is required', isError: true };
        }
        // `limit` accepts "default", "off", a number, or a numeric string.
        const limit = input.limit;
        const numeric =
          typeof limit === 'number'
            ? limit
            : typeof limit === 'string' && /^\d+$/.test(limit.trim())
              ? Number(limit.trim())
              : NaN;
        let desc: string;
        if (limit === 'default') {
          delete this.state.overrides[channelId];
          desc = `default (${this.defaultLimitChars})`;
        } else if (limit === 'off') {
          this.state.overrides[channelId] = 'off';
          desc = 'off (never auto-unsubscribe)';
        } else if (Number.isFinite(numeric) && numeric > 0) {
          this.state.overrides[channelId] = Math.round(numeric);
          desc = `${Math.round(numeric)} characters`;
        } else {
          return {
            success: false,
            error: 'limit must be a positive number, "default", or "off"',
            isError: true,
          };
        }
        this.persistNow();
        return ok(`Idle limit for ${channelId} set to ${desc}.`);
      }
      case 'list_channel_idle_limits':
        return {
          success: true,
          isError: false,
          data: {
            defaultLimitChars: this.defaultLimitChars,
            overrides: this.state.overrides,
            counters: this.state.counters,
          },
        };
      default:
        return { success: false, error: `Unknown tool: ${call.name}`, isError: true };
    }
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    const ambient = this.extractAmbient(event);
    if (!ambient || ambient.chars <= 0) return {};

    const { channelId, chars } = ambient;
    const limit = this.limitFor(channelId);
    const next = (this.state.counters[channelId] ?? 0) + chars;

    if (limit !== Infinity && next > limit) {
      // Cross the threshold → unsubscribe and clear the counter.
      delete this.state.counters[channelId];
      this.persistNow();
      const result = await this.ctx
        ?.callTool({
          id: `gc-unsub-${this.callSeq++}`,
          name: `${this.toolPrefix}--unsubscribe_channel`,
          input: { channelId },
        })
        .catch((err: unknown) => ({
          success: false,
          error: err instanceof Error ? err.message : String(err),
          isError: true,
        }));

      if (result && result.success) {
        return {
          addMessages: [
            {
              participant: 'system',
              content: [
                {
                  type: 'text',
                  text:
                    `[subscription-gc] Auto-unsubscribed from channel ${channelId}: it emitted ` +
                    `over ${limit} characters of ambient traffic since your last activation without ` +
                    `engagement. Mentions and DMs there still reach you. Resubscribe with ` +
                    `${this.toolPrefix}--subscribe_channel, raise/disable its limit with ` +
                    `set_channel_idle_limit, or check what you're missing with ${this.toolPrefix}--channel_missed.`,
                },
              ],
            },
          ],
        };
      }
      // Unsubscribe failed — keep the channel counted so we retry on the next
      // ambient message rather than silently giving up.
      this.state.counters[channelId] = next;
      this.persistNow();
      return {};
    }

    this.state.counters[channelId] = next;
    this.scheduleFlush();
    return {};
  }

  // ── internals ──

  private limitFor(channelId: string): number {
    const o = this.state.overrides[channelId];
    if (o === 'off') return Infinity;
    if (typeof o === 'number') return o;
    return this.defaultLimitChars;
  }

  /** Pull (channelId, ambient char count) out of an MCPL message event for our
   *  target server, or null if it isn't ambient traffic we should count. */
  private extractAmbient(event: ProcessEvent): { channelId: string; chars: number } | null {
    if (event.type === 'mcpl:push-event') {
      if (event.serverId !== this.serverId) return null;
      const origin = (event.origin ?? {}) as Record<string, unknown>;
      if (origin.isMention || origin.isDM) return null;
      const channelId = origin.channelId;
      if (typeof channelId !== 'string' || channelId.length === 0) return null;
      return { channelId, chars: textLen(event.content) };
    }
    if (event.type === 'mcpl:channel-incoming') {
      if (event.serverId !== this.serverId) return null;
      const md = (event.metadata ?? {}) as Record<string, unknown>;
      if (md.isMention || md.isDM) return null;
      if (typeof event.channelId !== 'string' || event.channelId.length === 0) return null;
      return { channelId: event.channelId, chars: textLen(event.content) };
    }
    return null;
  }

  private persistNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.ctx?.setState(this.state);
  }

  /** Debounced persistence so a firehose channel doesn't drive a chronicle
   *  write per message. Durability target: a clean restart flushes via stop();
   *  a hard crash loses at most the debounce window of counter increments. */
  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.ctx?.setState(this.state);
    }, FLUSH_DEBOUNCE_MS);
  }
}

/** Total length of text content blocks (non-text blocks count as 0). */
function textLen(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content) {
    if (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text') {
      const t = (b as { text?: unknown }).text;
      if (typeof t === 'string') n += t.length;
    }
  }
  return n;
}

function ok(message: string): ToolResult {
  return { success: true, data: { message }, isError: false };
}
