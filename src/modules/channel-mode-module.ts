/**
 * ChannelModeModule — flip a channel between "mentions-only" and
 * "every-message-debounced" attention in one call (item 5).
 *
 * The primitives already exist separately; the value here is bundling the three
 * moves that together define a channel's attention mode so the agent doesn't
 * have to remember (and keep in sync) all three:
 *
 *   debounced  (wake on every message, batched):
 *     1. subscribe to the channel's ambient traffic (`<toolPrefix>--subscribe_channel`)
 *     2. upsert a per-channel gate policy that DEBOUNCES the ambient tag
 *        (framework.addGatePolicy → gate.json, hot-reloaded) so a burst wakes the
 *        agent once after it settles
 *     3. pin subscription-gc to "off" for the channel, else a chatty channel
 *        auto-unsubscribes itself at the idle-char limit and silently leaves
 *        debounced mode
 *
 *   mentions  (revert to mentions/DMs only):
 *     1. remove the per-channel debounce gate policy
 *     2. unsubscribe from ambient traffic
 *     3. restore subscription-gc to its default limit
 *
 * The SAME `channelId` string is used for all three subsystems — it's the id the
 * gate sees on an incoming event (`GateEventInfo.channelId`) and the id
 * subscription-gc counts/unsubscribes, so they line up by construction (this is
 * exactly how SubscriptionGcModule already operates).
 *
 * Steps are best-effort with per-step reporting rather than a hard transaction:
 * the three subsystems can't be mutated atomically, so on partial failure the
 * tool returns which steps succeeded so the agent (or operator) can reconcile.
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
import type { AgentFramework } from '@animalabs/agent-framework';

export interface ChannelModeConfig {
  /** MCPL server id that owns subscriptions (default 'discord'). */
  serverId?: string;
  /** Tool-name prefix for that server (default `mcpl--<serverId>`). */
  toolPrefix?: string;
  /** subscription-gc module name, for pinning the idle limit (default 'subscription-gc'). */
  gcModuleName?: string;
  /** Default debounce window (ms) when the tool call omits `debounceMs`. */
  defaultDebounceMs?: number;
}

type ChannelMode = 'debounced' | 'mentions';

interface StepResult {
  step: string;
  ok: boolean;
  detail: string;
}

export class ChannelModeModule implements Module {
  readonly name = 'channel-mode';

  private ctx: ModuleContext | null = null;
  private framework: AgentFramework | null = null;
  private callSeq = 0;

  private readonly serverId: string;
  private readonly toolPrefix: string;
  private readonly gcModuleName: string;
  private readonly defaultDebounceMs: number;

  constructor(config: ChannelModeConfig = {}) {
    this.serverId = config.serverId ?? 'discord';
    this.toolPrefix = config.toolPrefix ?? `mcpl--${this.serverId}`;
    this.gcModuleName = config.gcModuleName ?? 'subscription-gc';
    this.defaultDebounceMs =
      typeof config.defaultDebounceMs === 'number' && config.defaultDebounceMs > 0
        ? Math.round(config.defaultDebounceMs)
        : 180_000;
  }

  /** Wired post-creation (like SubagentModule/ActivityModule) so the module can
   *  add/remove gate policies without reaching into the private EventGate. */
  setFramework(framework: AgentFramework): void {
    this.framework = framework;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
  }

  async stop(): Promise<void> {
    this.ctx = null;
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'set_channel_mode',
        description:
          'Set how a channel gets your attention, in one step. ' +
          '`mode: "debounced"` = wake on EVERY message but batched: it subscribes ' +
          'to the channel, adds a gate rule that debounces its ambient traffic ' +
          '(one wake after the burst settles), and pins the channel so it is never ' +
          'auto-unsubscribed for being chatty. `mode: "mentions"` reverts to ' +
          'mentions/DMs only: it removes that gate rule, unsubscribes, and restores ' +
          'the default auto-unsubscribe limit. `debounceMs` (100–300000, default ' +
          `${this.defaultDebounceMs}) sets the quiet window for debounced mode.`,
        inputSchema: {
          type: 'object',
          properties: {
            channelId: { type: 'string', description: 'Channel id (as it appears in events, e.g. the Discord channel id).' },
            mode: { type: 'string', enum: ['debounced', 'mentions'], description: 'Target attention mode.' },
            debounceMs: { type: 'number', description: 'Quiet window in ms for debounced mode (100–300000).' },
          },
          required: ['channelId', 'mode'],
        },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    if (call.name !== 'set_channel_mode') {
      return { success: false, error: `Unknown tool: ${call.name}`, isError: true };
    }
    const input = (call.input ?? {}) as Record<string, unknown>;
    const channelId = input.channelId;
    if (typeof channelId !== 'string' || channelId.length === 0) {
      return { success: false, error: 'channelId is required', isError: true };
    }
    const mode = input.mode;
    if (mode !== 'debounced' && mode !== 'mentions') {
      return { success: false, error: 'mode must be "debounced" or "mentions"', isError: true };
    }
    if (!this.framework) {
      return { success: false, error: 'channel-mode: framework not wired (setFramework not called)', isError: true };
    }
    if (!this.ctx) {
      return { success: false, error: 'channel-mode: module not started', isError: true };
    }

    const debounceMs =
      typeof input.debounceMs === 'number' && input.debounceMs > 0
        ? Math.round(input.debounceMs)
        : this.defaultDebounceMs;

    const steps: StepResult[] =
      mode === 'debounced'
        ? await this.applyDebounced(channelId, debounceMs)
        : await this.applyMentions(channelId);

    const failed = steps.filter((s) => !s.ok);
    const summary =
      failed.length === 0
        ? `Channel ${channelId} set to ${mode} mode.`
        : `Channel ${channelId} → ${mode}: ${steps.length - failed.length}/${steps.length} steps ok; ` +
          `failed: ${failed.map((s) => `${s.step} (${s.detail})`).join('; ')}.`;

    return {
      success: failed.length === 0,
      isError: failed.length > 0,
      ...(failed.length > 0 ? { error: summary } : {}),
      data: { channelId, mode, debounceMs: mode === 'debounced' ? debounceMs : undefined, steps, message: summary },
    };
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  // ── mode transitions ──

  private policyName(channelId: string): string {
    return `channel-mode:debounced:${channelId}`;
  }

  private async applyDebounced(channelId: string, debounceMs: number): Promise<StepResult[]> {
    const steps: StepResult[] = [];

    // 1. Subscribe to ambient traffic.
    steps.push(await this.callToolStep('subscribe', `${this.toolPrefix}--subscribe_channel`, { channelId }));

    // 2. Upsert the per-channel ambient debounce policy (prepend so it beats a
    //    broad ambient defer/debounce — first match wins). Validation lives in
    //    the gate; a bad debounceMs surfaces here as this step's failure.
    try {
      this.framework!.addGatePolicy(
        {
          name: this.policyName(channelId),
          match: { source: this.serverId, channel: channelId, tagsAny: ['chat:ambient'] },
          behavior: { debounce: debounceMs },
        },
        { position: 'prepend' },
      );
      steps.push({ step: 'gate-policy', ok: true, detail: `debounce ${debounceMs}ms on chat:ambient` });
    } catch (err) {
      steps.push({ step: 'gate-policy', ok: false, detail: errMsg(err) });
    }

    // 3. Pin subscription-gc off so a chatty channel doesn't auto-unsubscribe
    //    itself back out of debounced mode.
    steps.push(
      await this.callToolStep('gc-off', `${this.gcModuleName}--set_channel_idle_limit`, {
        channelId,
        limit: 'off',
      }),
    );

    return steps;
  }

  private async applyMentions(channelId: string): Promise<StepResult[]> {
    const steps: StepResult[] = [];

    // 1. Drop the debounce policy (delivers any pending batch first).
    try {
      const removed = this.framework!.removeGatePolicy(this.policyName(channelId));
      steps.push({ step: 'gate-policy', ok: true, detail: removed ? 'removed' : 'no rule to remove' });
    } catch (err) {
      steps.push({ step: 'gate-policy', ok: false, detail: errMsg(err) });
    }

    // 2. Unsubscribe from ambient traffic.
    steps.push(await this.callToolStep('unsubscribe', `${this.toolPrefix}--unsubscribe_channel`, { channelId }));

    // 3. Restore the default auto-unsubscribe limit.
    steps.push(
      await this.callToolStep('gc-default', `${this.gcModuleName}--set_channel_idle_limit`, {
        channelId,
        limit: 'default',
      }),
    );

    return steps;
  }

  private async callToolStep(
    step: string,
    name: string,
    toolInput: Record<string, unknown>,
  ): Promise<StepResult> {
    try {
      const result = await this.ctx!.callTool({ id: `chanmode-${this.callSeq++}`, name, input: toolInput });
      if (result && result.success) {
        return { step, ok: true, detail: name };
      }
      return { step, ok: false, detail: result?.error ?? `${name} returned failure` };
    } catch (err) {
      return { step, ok: false, detail: errMsg(err) };
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
