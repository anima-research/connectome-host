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
import { unknownToolResult } from './unknown-tool.js';
import { shown } from './shown.js';

export interface ChannelModeConfig {
  serverId?: string;
  /** @deprecated Lifecycle tools are host-generic; retained for config compatibility. */
  toolPrefix?: string;
  gcModuleName?: string;
  defaultDebounceMs?: number;
}

type ChannelMode = 'debounced' | 'mentions';

interface StepResult {
  step: string;
  ok: boolean;
  detail: string;
  unanswered?: true;
}

export class ChannelModeModule implements Module {
  readonly name = 'channel-mode';

  private ctx: ModuleContext | null = null;
  private framework: AgentFramework | null = null;
  private callSeq = 0;

  private readonly serverId: string;
  private readonly gcModuleName: string;
  private readonly defaultDebounceMs: number;

  constructor(config: ChannelModeConfig = {}) {
    this.serverId = config.serverId ?? 'discord';
    this.gcModuleName = config.gcModuleName ?? 'subscription-gc';
    // agent-framework's EventGate refuses a policy whose debounce is outside its
    // bounds, and the default goes to the gate whenever a call leaves debounceMs
    // out.
    const configured = config.defaultDebounceMs;
    if (typeof configured === 'number' && configured > 0) {
      const asked = Math.round(configured);
      this.defaultDebounceMs = Math.min(DEBOUNCE_MAX_MS, Math.max(DEBOUNCE_MIN_MS, asked));
      if (this.defaultDebounceMs !== asked) {
        console.error(
          `[gate] channel-mode's defaultDebounceMs ${configured} is outside the gate's ${DEBOUNCE_MIN_MS} to ` +
          `${DEBOUNCE_MAX_MS} ms; using ${this.defaultDebounceMs}.`,
        );
      }
    } else {
      this.defaultDebounceMs = FALLBACK_DEBOUNCE_MS;
      if (configured !== undefined) {
        const why = typeof configured === 'number' && !Number.isNaN(configured)
          ? "isn't above zero"
          : "isn't a number of milliseconds";
        console.error(
          `[gate] channel-mode's defaultDebounceMs ${String(configured)} ${why}; using ${FALLBACK_DEBOUNCE_MS}.`,
        );
      }
    }
  }

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
          '`mode: "debounced"` = wake on EVERY message but batched: it opens ' +
          'to the channel, adds a gate rule that debounces its ambient traffic ' +
          '(one wake after the burst settles), and pins the channel so it is never ' +
          'auto-closed for being chatty. `mode: "mentions"` reverts to ' +
          'direct-address-only: it removes that gate rule, closes, and restores ' +
          'the default auto-close limit. `debounceMs` (100–300000, default ' +
          `${this.defaultDebounceMs}) sets the quiet window for debounced mode.`,
        inputSchema: {
          type: 'object',
          properties: {
            channelId: { type: 'string', description: 'Channel id EXACTLY as it appears in incoming events (GateEventInfo.channelId). For Discord that is the MCPL-namespaced id discord:<guildId>:<channelId>, NOT the raw channel snowflake — passing the raw id silently never matches the gate, so debouncing/mode has no effect.' },
            mode: { type: 'string', enum: ['debounced', 'mentions'], description: 'Target attention mode.' },
            debounceMs: { type: 'number', description: 'Quiet window in ms for debounced mode (100–300000). Checked whenever it is given, in either mode.' },
          },
          required: ['channelId', 'mode'],
        },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    if (call.name !== 'set_channel_mode') return unknownToolResult(this, call.name);
    const input = (call.input ?? {}) as Record<string, unknown>;
    const channelId = input.channelId;
    const mode = input.mode;
    const given = input.debounceMs;
    const debounceMs = given === undefined
      ? this.defaultDebounceMs
      : typeof given === 'number' && Number.isFinite(given) ? Math.round(given) : NaN;
    const channelOk = typeof channelId === 'string' && channelId.length > 0;
    const modeOk = mode === 'debounced' || mode === 'mentions';
    const problems: string[] = [];
    if (!channelOk) {
      problems.push(
        channelId === undefined || channelId === ''
          ? "channelId is missing: give the channel's id exactly as its incoming events show it; for Discord " +
            "that's discord:<guildId>:<channelId>, since a bare channel id never matches"
          : `channelId must be the channel's id as text, not ${shown(channelId)}`,
      );
    }
    if (!modeOk) {
      problems.push(
        `mode must be "debounced" (wake on every message, batched) or "mentions" (wake only when addressed)` +
        (mode === undefined ? ', and none was given' : `, not ${shown(mode)}`),
      );
    }
    if (given !== undefined && !(debounceMs >= DEBOUNCE_MIN_MS && debounceMs <= DEBOUNCE_MAX_MS)) {
      problems.push(
        `debounceMs must be a number of milliseconds from ${DEBOUNCE_MIN_MS} to ${DEBOUNCE_MAX_MS}, ` +
        `not ${shown(given)}; leave it out for ${this.defaultDebounceMs}`,
      );
    }
    if (!channelOk || !modeOk || problems.length > 0) {
      return { success: false, error: `Nothing changed: ${problems.join('; ')}.`, isError: true };
    }
    if (!this.framework) {
      return {
        success: false,
        error:
          "channel-mode--set_channel_mode can't run here: this host never connected the channel-mode module to " +
          "its framework, so nothing changed, and calling again won't change that. Ask whoever runs this host.",
        isError: true,
      };
    }
    if (!this.ctx) {
      return {
        success: false,
        error:
          "Nothing changed: the channel-mode module isn't running right now, as while the host starts or stops. " +
          'Try again in a moment; if it keeps happening, ask whoever runs this host.',
        isError: true,
      };
    }

    const steps: StepResult[] =
      mode === 'debounced'
        ? await this.applyDebounced(channelId, debounceMs)
        : await this.applyMentions(channelId);

    const failed = steps.filter((s) => !s.ok);
    const worked = steps.filter((s) => s.ok);
    const unsure = failed.some((s) => s.unanswered);
    const failures = failed
      .map((s) => s.unanswered
        ? `${STEP_NAMES[s.step] ?? s.step} got no answer (${s.detail}), so it may or may not have taken effect`
        : `${STEP_NAMES[s.step] ?? s.step} failed (${s.detail})`)
      .join('; ');
    const retry =
      'Each step is safe to repeat, so call channel-mode--set_channel_mode again with the same channelId and ' +
      (mode === 'debounced' ? `mode, and debounceMs ${debounceMs},` : 'mode') +
      ' to retry; if it fails the same way, ask whoever runs this host.';
    const summary =
      failed.length === 0
        ? mode === 'debounced'
          ? `Channel ${channelId} set to debounced mode, with a ${debounceMs} ms quiet window.`
          : `Channel ${channelId} set to mentions mode.`
        : worked.length === 0
          ? `${unsure ? `Channel ${channelId} may not have changed` : `Nothing changed for channel ${channelId}`}: ` +
            `${failures}. ${retry}`
          : `Channel ${channelId} ${unsure ? 'may be' : 'is'} only partly in ${mode} mode: ` +
            `${listOf(worked.map(doneText))}, and ${failures}. ${retry}`;

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

  private policyName(channelId: string): string {
    return `channel-mode:debounced:${channelId}`;
  }

  private async applyDebounced(channelId: string, debounceMs: number): Promise<StepResult[]> {
    const steps: StepResult[] = [];

    steps.push(await this.callToolStep('open', 'channel_open', { channelId, serverId: this.serverId }));

    if (!this.ctx || !this.framework) {
      steps.push({ step: 'gate-policy', ok: false, detail: 'the channel-mode module stopped before this step' });
    } else {
      try {
        // Prepended: agent-framework's gate takes the first rule that matches.
        this.framework.addGatePolicy(
          {
            name: this.policyName(channelId),
            match: { source: this.serverId, channel: channelId, tagsAny: ['chat:ambient'] },
            behavior: { debounce: debounceMs },
          },
          { position: 'prepend' },
        );
        steps.push({ step: 'gate-policy', ok: true, detail: 'set' });
      } catch (err) {
        steps.push({ step: 'gate-policy', ok: false, detail: errMsg(err) });
      }
    }

    steps.push(
      await this.callToolStep('gc-pin', `${this.gcModuleName}--pin_channel_idle_limit`, {
        channelId,
        pinned: true,
      }),
    );

    return steps;
  }

  private async applyMentions(channelId: string): Promise<StepResult[]> {
    const steps: StepResult[] = [];

    // agent-framework sends a removed rule's pending batch.
    try {
      const removed = this.framework!.removeGatePolicy(this.policyName(channelId));
      steps.push({ step: 'gate-policy', ok: true, detail: removed ? 'removed' : 'no rule to remove' });
    } catch (err) {
      steps.push({ step: 'gate-policy', ok: false, detail: errMsg(err) });
    }

    steps.push(await this.callToolStep('close', 'channel_close', { channelId, serverId: this.serverId }));

    steps.push(
      await this.callToolStep('gc-unpin', `${this.gcModuleName}--pin_channel_idle_limit`, {
        channelId,
        pinned: false,
      }),
    );

    return steps;
  }

  private async callToolStep(
    step: string,
    name: string,
    toolInput: Record<string, unknown>,
  ): Promise<StepResult> {
    const ctx = this.ctx;
    if (!ctx) return { step, ok: false, detail: 'the channel-mode module stopped before this step' };
    try {
      const result = await ctx.callTool({ id: `chanmode-${this.callSeq++}`, name, input: toolInput });
      if (result && result.success) {
        return { step, ok: true, detail: name };
      }
      return { step, ok: false, detail: result?.error ?? `${name} returned failure` };
    } catch (err) {
      return { step, ok: false, detail: errMsg(err), unanswered: true };
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The gate's bounds on a debounce (agent-framework's EventGate). */
const DEBOUNCE_MIN_MS = 100;
const DEBOUNCE_MAX_MS = 300_000;
const FALLBACK_DEBOUNCE_MS = 180_000;

function doneText(s: StepResult): string {
  switch (s.step) {
    case 'open': return 'the channel is open';
    case 'close': return 'the channel is closed';
    case 'gate-policy':
      return s.detail === 'set' ? 'its debounce rule is set'
        : s.detail === 'removed' ? 'its debounce rule was removed'
        : 'it had no debounce rule to remove';
    case 'gc-pin': return 'it is pinned open';
    case 'gc-unpin': return "it isn't pinned";
    default: return `${s.step} worked`;
  }
}

const STEP_NAMES: Readonly<Record<string, string>> = {
  open: 'opening the channel',
  close: 'closing the channel',
  'gate-policy': "the channel's debounce gate rule",
  'gc-pin': 'pinning it open',
  'gc-unpin': 'releasing its pin',
};

function listOf(names: string[]): string {
  return names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
