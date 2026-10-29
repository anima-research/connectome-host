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
import { shown } from './shown.js';
import { settingsRoute, unknownToolResult } from './unknown-tool.js';

/** agent-framework applies each agent_settings extension in turn and then
 *  the core patch, so an extension's throw leaves the ones before it applied
 *  and the core patch not. */
const OTHER_SETTINGS =
  'Other settings given in the same call may not all have been applied: agent_settings with action "get" shows each as it stands.';

export interface SubscriptionGcConfig {
  defaultLimitChars?: number;
  serverId?: string;
  /** @deprecated Lifecycle tools are host-generic; retained for config compatibility. */
  toolPrefix?: string;
}

type LimitOverride = number | 'off';

interface GcState {
  overrides: Record<string, LimitOverride>;
  pins: Record<string, true>;
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
      this.state = {
        overrides: saved.overrides ?? {},
        pins: saved.pins ?? {},
        counters: saved.counters ?? {},
      };
    }
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
    this.persistNow();
    this.ctx = null;
  }

  /** agent-framework routes a call by its module prefix whether or not the
   *  tool is declared, so the former tools still answer here. */
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
        return unknownToolResult(
          this,
          call.name,
          'Idle-limit controls live in agent_settings (field channel_idle_limits); reach it with ' +
          `${settingsRoute('agent_settings')}.`,
        );
    }
  }

  /** agent-framework merges get()'s fields into agent_settings' answer, and
   *  routes only the declared `keys` to update. */
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
            "channel_idle_limits wasn't changed: it must be an object mapping channel ids to a " +
            `positive number, "off", or "default"/null, not ${shown(raw)}. ${OTHER_SETTINGS}`,
          );
        }
        const staged = { ...this.state.overrides };
        const bad: string[] = [];
        let emptyId = false;
        for (const [channelId, value] of Object.entries(raw as Record<string, unknown>)) {
          if (channelId.length === 0) {
            emptyId = true;
            continue;
          }
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
            bad.push(`${JSON.stringify(channelId)}: ${shown(value)}`);
          }
        }
        if (bad.length > 0 || emptyId) {
          const others = Object.keys(raw).length - bad.length - (emptyId ? 1 : 0);
          throw new Error(
            "channel_idle_limits wasn't changed, and none of its entries were applied." +
            (bad.length > 0
              ? ` ${bad.length === 1 ? 'This entry is' : 'These entries are'} neither a positive number, "off", nor "default"/null (a number given as text is digits only): ${bad.join(', ')}.`
              : '') +
            (emptyId ? ' A channel id is empty: give each channel by its id.' : '') +
            (others > 0 ? ` The other ${others === 1 ? 'entry was' : `${others} entries were`} fine as given.` : '') +
            ` ${OTHER_SETTINGS}`,
          );
        }
        this.state.overrides = staged;
        this.persistNow();
        return this.settingsSnapshot();
      },
      reset: (_agentName, keys) => {
        const all = !keys || keys.length === 0;
        if (all || keys?.includes('channel_idle_limits')) {
          this.state.overrides = {};
          this.persistNow();
        }
        return this.settingsSnapshot();
      },
    };
  }

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
      delete this.state.counters[channelId];
      this.persistNow();
      // agent-framework refuses a machine close of an explicitly opened channel
      // unless the close certifies an idle lease, which a budget configured for
      // the channel is, and refuses a tuned-out channel's close in any case.
      const hasConfiguredLease = typeof this.state.overrides[channelId] === 'number';
      const result = await this.ctx
        ?.callTool({
          id: `gc-unsub-${this.callSeq++}`,
          name: 'channel_close',
          input: {
            channelId,
            serverId: this.serverId,
            source: 'subscription-gc',
            overrideExplicitOpen: hasConfiguredLease,
          },
        })
        .catch((err: unknown) => ({
          success: false,
          error: err instanceof Error ? err.message : String(err),
          isError: true,
        }));

      if (result && result.success) {
        // ModuleContext.notifyOps is optional, and agent-framework's implementation
        // reads `this`, so it's called through the context.
        const opsCtx = this.ctx as unknown as {
          notifyOps?: (kind: string, agent: string, message: string, data?: Record<string, unknown>) => void;
        } | null;
        opsCtx?.notifyOps?.(
          'subscription-gc-close',
          this.ctx?.getAgents()[0]?.name ?? 'unknown',
          `subscription-gc auto-closed channel ${channelId} (over ${limit} ambient chars ` +
          `since last activation${hasConfiguredLease ? ', configured per-channel budget' : ', default budget'}). ` +
          `Restore: channel_open ${channelId}, or agent_settings channel_idle_limits.`,
          {
            channelId,
            limitChars: limit,
            decisionSource: 'subscription-gc',
            lease: hasConfiguredLease ? 'configured-budget' : 'default',
            restore: `channel_open ${channelId}`,
          },
        );
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
                    `or raise/disable its limit via agent_settings (field channel_idle_limits); reach it with ` +
                    `${settingsRoute('agent_settings')}.`,
                },
              ],
            },
          ],
        };
      }

      const refusal = (result as { data?: { refusal?: string } } | undefined)?.data?.refusal;
      if (refusal === 'explicit-open' || refusal === 'tuned-out') {
        return {};
      }

      this.state.counters[channelId] = next;
      this.persistNow();
      return {};
    }

    this.state.counters[channelId] = next;
    this.scheduleFlush();
    return {};
  }

  private limitFor(channelId: string): number {
    if (this.state.pins[channelId]) return Infinity;
    const o = this.state.overrides[channelId];
    if (o === 'off') return Infinity;
    if (typeof o === 'number') return o;
    return this.defaultLimitChars;
  }

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

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.ctx?.setState(this.state);
    }, FLUSH_DEBOUNCE_MS);
  }
}

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
