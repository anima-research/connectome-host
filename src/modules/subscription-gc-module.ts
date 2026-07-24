/**
 * SubscriptionGcModule — auto-close noisy ordinary channel traffic.
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
 *     is auto-closed via the host's generic `channel_close` tool. This
 *     bounds any one channel's context pollution to ~limit characters.
 *
 * Everything is durable across restarts: counters + per-channel overrides
 * persist to chronicle (a restart is NOT an activation, so counters must carry
 * across downtime — they only reset when the agent actually runs).
 *
 * Config (recipe `modules.subscriptionGc`): `defaultLimitChars` (20000),
 * `serverId` (`discord`), `toolPrefix` (`mcpl--<serverId>`). The agent can
 * override per channel at runtime through `agent_settings` (field
 * `channel_idle_limits`); other modules pin channels open through the
 * internal `pin_channel_idle_limit` tool.
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
  /** Default ambient-character budget per channel before auto-close. */
  defaultLimitChars?: number;
  /** MCPL server id that owns subscriptions (default 'discord'). */
  serverId?: string;
  /** @deprecated Lifecycle tools are host-generic; retained for config compatibility. */
  toolPrefix?: string;
}

/** `'off'` pins a channel (never auto-close); a number overrides the
 *  default limit; absence falls back to the default. */
type LimitOverride = number | 'off';

interface GcState {
  /** Agent-set per-channel limits. Cleared by agent_settings reset. */
  overrides: Record<string, LimitOverride>;
  /** System pins (never auto-close), set by other modules via
   *  pin_channel_idle_limit — e.g. ChannelModeModule's debounced mode.
   *  These encode mode invariants, not agent preferences, so
   *  agent_settings reset leaves them alone; only unpinning (a mode
   *  change) clears them. A pin wins over any override. */
  pins: Record<string, true>;
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

  private state: GcState = { overrides: {}, pins: {}, counters: {} };

  constructor(config: SubscriptionGcConfig = {}) {
    this.defaultLimitChars =
      typeof config.defaultLimitChars === 'number' && config.defaultLimitChars > 0
        ? Math.round(config.defaultLimitChars)
        : 20000;
    this.serverId = config.serverId ?? 'discord';
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    const saved = ctx.getState<Partial<GcState>>();
    if (saved) {
      // Pre-pins state stored ChannelMode's programmatic 'off' pins in
      // `overrides`; they stay there as agent-level overrides and get
      // re-asserted as pins on the next mode change.
      this.state = {
        overrides: saved.overrides ?? {},
        pins: saved.pins ?? {},
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

  /** No agent-visible tools — idle limits live inside the framework's
   *  `agent_settings` tool via getAgentSettingsExtension() below (same
   *  consolidation as the reasoning controls). The former tools remain
   *  ROUTABLE though undeclared (module tool routing is prefix-based), so
   *  agent muscle memory keeps working. ChannelModeModule holds channels
   *  open via the internal `subscription-gc--pin_channel_idle_limit` tool
   *  — a separate layer from agent overrides, so agent_settings reset
   *  can't break debounced mode's invariant. */
  getTools(): ToolDefinition[] {
    return [];
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
          desc = 'off (never auto-close)';
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
      case 'pin_channel_idle_limit': {
        // Internal (module-to-module) verb: hold a channel open regardless of
        // agent-level overrides. Not part of the agent settings surface.
        const channelId = input.channelId;
        if (typeof channelId !== 'string' || channelId.length === 0) {
          return { success: false, error: 'channelId is required', isError: true };
        }
        if (typeof input.pinned !== 'boolean') {
          return { success: false, error: 'pinned must be a boolean', isError: true };
        }
        if (input.pinned) {
          this.state.pins[channelId] = true;
        } else {
          delete this.state.pins[channelId];
        }
        this.persistNow();
        return ok(
          input.pinned
            ? `Channel ${channelId} pinned open (never auto-close).`
            : `Channel ${channelId} unpinned; its agent override or the default limit applies again.`,
        );
      }
      case 'list_channel_idle_limits':
        return {
          success: true,
          isError: false,
          data: {
            defaultLimitChars: this.defaultLimitChars,
            overrides: this.state.overrides,
            pins: Object.keys(this.state.pins),
            counters: this.state.counters,
          },
        };
      default:
        return {
          success: false,
          error:
            `Unknown tool: ${call.name}. Idle-limit controls live in agent_settings ` +
            `(field channel_idle_limits).`,
          isError: true,
        };
    }
  }

  /**
   * Declare idle limits as an agent_settings extension: the framework merges
   * the field into the agent_settings tool and routes get/update/reset back
   * here. Same pattern as SettingsModule's reasoning fields. Update semantics
   * mirror the (undeclared but still routable) set_channel_idle_limit tool:
   * per entry, a positive number sets an override, "off" disables auto-close
   * for the channel, and "default"/null clears back to the global default.
   * Entries not mentioned in a patch are left untouched, and a patch applies
   * all-or-nothing: it is validated in full before any entry takes effect.
   *
   * `get` additionally reports read-only companions (the framework merges
   * ext.get() into the response but only routes declared `keys` on update):
   * `channel_idle_default`, live `channel_idle_counters`, and
   * `channel_idle_pinned` — system pins held by other modules, which sit
   * above these overrides and are not touched by update or reset.
   */
  getAgentSettingsExtension(): {
    properties: Record<string, unknown>;
    keys: string[];
    get(agentName: string): Record<string, unknown>;
    update(agentName: string, patch: Record<string, unknown>): Record<string, unknown>;
    reset(agentName: string, keys?: string[]): Record<string, unknown>;
  } {
    return {
      properties: {
        channel_idle_limits: {
          type: 'object',
          description:
            'Per-channel ambient auto-close budgets, as {"<channelId>": value}: ' +
            'a positive number of characters, "off" (never auto-close this ' +
            'channel), or "default"/null (clear the override). Channels not ' +
            `listed use the global default (${this.defaultLimitChars} chars of ` +
            'ambient traffic between your activations before auto-close). ' +
            'Patches merge per entry; unmentioned channels are untouched. ' +
            'get also reports the read-only channel_idle_default, ' +
            'channel_idle_counters (ambient chars since your last activation), ' +
            'and channel_idle_pinned (channels held open by a channel mode; ' +
            'not affected by update or reset — change the channel mode instead).',
        },
      },
      keys: ['channel_idle_limits'],
      get: () => this.settingsSnapshot(),
      update: (_agentName, patch) => {
        const raw = patch.channel_idle_limits;
        if (raw === undefined) return this.settingsSnapshot();
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new Error(
            'channel_idle_limits must be an object mapping channel ids to a ' +
            'positive number, "off", or "default"/null',
          );
        }
        // All-or-nothing: validate the full patch into a staging copy and
        // swap only if every entry passes. Mutating live state per-entry
        // would leave earlier entries active (limitFor reads the map
        // directly, and any later flush persists them) after a failure the
        // agent was told was rejected.
        const staged = { ...this.state.overrides };
        for (const [channelId, value] of Object.entries(raw as Record<string, unknown>)) {
          if (channelId.length === 0) throw new Error('channel id must be non-empty');
          const numeric =
            typeof value === 'number'
              ? value
              : typeof value === 'string' && /^\d+$/.test(value.trim())
                ? Number(value.trim())
                : NaN;
          if (value === 'default' || value === null) {
            delete staged[channelId];
          } else if (value === 'off') {
            staged[channelId] = 'off';
          } else if (Number.isFinite(numeric) && numeric > 0) {
            staged[channelId] = Math.round(numeric);
          } else {
            throw new Error(
              `channel_idle_limits[${JSON.stringify(channelId)}] must be a positive ` +
              'number, "off", or "default"/null (no entries were applied)',
            );
          }
        }
        this.state.overrides = staged;
        this.persistNow();
        return this.settingsSnapshot();
      },
      reset: (_agentName, keys) => {
        // Clears agent overrides only. Pins are mode invariants owned by
        // other modules (ChannelMode's debounced mode), not agent
        // preferences — a blanket `agent_settings reset` must not silently
        // reopen a debounced channel to auto-close.
        const all = !keys || keys.length === 0;
        if (all || keys?.includes('channel_idle_limits')) {
          this.state.overrides = {};
          this.persistNow();
        }
        return this.settingsSnapshot();
      },
    };
  }

  /** agent_settings view: the writable overrides plus read-only status. */
  private settingsSnapshot(): Record<string, unknown> {
    return {
      channel_idle_limits: { ...this.state.overrides },
      channel_idle_default: this.defaultLimitChars,
      channel_idle_counters: { ...this.state.counters },
      channel_idle_pinned: Object.keys(this.state.pins),
    };
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    const ambient = this.extractAmbient(event);
    if (!ambient || ambient.chars <= 0) return {};

    const { channelId, chars } = ambient;
    const limit = this.limitFor(channelId);
    const next = (this.state.counters[channelId] ?? 0) + chars;

    if (limit !== Infinity && next > limit) {
      // Cross the threshold → close and clear the counter.
      delete this.state.counters[channelId];
      this.persistNow();
      const result = await this.ctx
        ?.callTool({
          id: `gc-unsub-${this.callSeq++}`,
          name: 'channel_close',
          input: { channelId, serverId: this.serverId },
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
                    `[subscription-gc] Auto-closed channel ${channelId}: it emitted ` +
                    `over ${limit} characters of ambient traffic since your last activation without ` +
                    `engagement. Direct addresses there still reach you. Reopen with channel_open, ` +
                    `or raise/disable its limit via agent_settings (field channel_idle_limits).`,
                },
              ],
            },
          ],
        };
      }
      // Close failed — keep the channel counted so we retry on the next
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
    if (this.state.pins[channelId]) return Infinity;
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
      const channelId = origin.mcplChannelId ?? origin.channelId;
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
