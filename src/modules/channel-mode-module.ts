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
  /**
   * @deprecated Ignored: each call's server is the channel id's prefix
   * (`zulip:…`, `discord:…`). Retained for config compatibility.
   */
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
  /** Exact channel ids with a call in progress: one call per id at a time. */
  private readonly inFlight = new Set<string>();

  private readonly gcModuleName: string;
  private readonly defaultDebounceMs: number;

  constructor(config: ChannelModeConfig = {}) {
    if (config.serverId !== undefined) {
      console.error(
        `[gate] channel-mode's serverId ${shown(config.serverId)} is ignored: set_channel_mode takes each ` +
        'channel\'s server from the prefix of its id (zulip:<stream>, discord:<guildId>:<channelId>).',
      );
    }
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
          'the default auto-close limit. The open, the rule\'s source and the close use ' +
          'the MCPL server named by the channel id\'s prefix. `debounceMs` (100–300000, default ' +
          `${this.defaultDebounceMs}) sets the quiet window for debounced mode.`,
        inputSchema: {
          type: 'object',
          properties: {
            channelId: { type: 'string', description: 'The channel\'s registered id EXACTLY, as channel_list shows it and its channel messages carry it, such as zulip:<stream>, slack:<conversationId> or discord:<guildId>:<channelId>. The text before the first colon is taken as the MCPL server, so this works only for ids of the form <serverId>:<channel> whose prefix is the id of a server this host knows; an id without one, such as a raw Discord snowflake, is refused, and so is an id containing *, which the gate would read as a wildcard. A server whose id differs from its channel ids\' prefix, or contains a colon, can\'t be reached by this tool; ask whoever runs this host.' },
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
    const colon = channelOk ? channelId.indexOf(':') : -1;
    const prefixOk = colon > 0 && colon < (channelId as string).length - 1;
    // agent-framework's gate reads `*` in a rule's source or channel as a
    // wildcard (its only glob character), so such a rule would also match
    // other servers or channels.
    const literalOk = channelOk && !channelId.includes('*');
    const modeOk = mode === 'debounced' || mode === 'mentions';
    const problems: string[] = [];
    if (!channelOk) {
      problems.push(
        channelId === undefined || channelId === ''
          ? `channelId is missing: ${EXPECTED_FORM}`
          : `channelId must be the channel's id as text, not ${shown(channelId)}`,
      );
    } else if (!prefixOk) {
      problems.push(`channelId ${shown(channelId)} has no server prefix: ${EXPECTED_FORM}`);
    }
    if (channelOk && !literalOk) {
      problems.push(
        `channelId ${shown(channelId)} contains *, which the gate reads as a wildcard, so its rule could match ` +
        'other channels or servers; channel mode takes one exact channel id, with no * in its server or channel',
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
    if (!channelOk || !prefixOk || !literalOk || !modeOk || problems.length > 0) {
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

    // The id's prefix is the server; nothing else chooses it.
    const serverId = channelId.slice(0, colon);
    const known = this.framework.listMcplServers().map((server) => server.id);
    if (!known.includes(serverId)) {
      return {
        success: false,
        error:
          `Nothing changed: channelId ${channelId} names MCPL server "${serverId}", which this host doesn't know ` +
          `(it knows ${known.length > 0 ? listOf([...known].sort()) : 'none'}); ${EXPECTED_FORM}.`,
        isError: true,
      };
    }
    if (this.inFlight.has(channelId)) {
      return {
        success: false,
        error:
          `Nothing changed: another channel-mode--set_channel_mode call for channel ${channelId} is still in progress. ` +
          'Wait for its result, then call again if it is still needed.',
        isError: true,
      };
    }

    this.inFlight.add(channelId);
    let steps: StepResult[];
    try {
      steps = mode === 'debounced'
        ? await this.applyDebounced(channelId, serverId, debounceMs)
        : await this.applyMentions(channelId, serverId);
    } finally {
      this.inFlight.delete(channelId);
    }

    const failed = steps.filter((s) => !s.ok);
    const worked = steps.filter((s) => s.ok);
    const unsure = failed.some((s) => s.unanswered);
    // A lifecycle step can fail after agent-framework recorded its decision,
    // as on a disconnected server: the registry's desired state says so.
    const lifecycle = mode === 'debounced' ? 'open' : 'close';
    const target = mode === 'debounced' ? 'open' : 'closed';
    const channels = this.framework.channels;
    const recorded = failed.some((s) => s.step === lifecycle) &&
      channels?.getDesiredState(serverId, channelId) === target;
    const isOpen = channels?.isChannelOpen({ serverId, channelId }) === true;
    const pending = recorded && isOpen !== (mode === 'debounced');
    const connected = this.framework.listMcplServers().find((server) => server.id === serverId)?.connected;
    const done = [
      ...(recorded
        ? [mode === 'debounced'
          ? `its open is recorded ${pending ? "but the channel isn't open yet" : 'and the channel is open'}`
          : `its close is recorded ${pending ? "but the channel isn't closed yet" : 'and the channel is closed'}`]
        : []),
      ...worked.map(doneText),
    ];
    const failures = failed
      .map((s) => s.unanswered
        ? `${STEP_NAMES[s.step] ?? s.step} got no answer (${s.detail}), so it may or may not have taken effect`
        : `${STEP_NAMES[s.step] ?? s.step} failed (${s.detail})`)
      .join('; ');
    const later = pending && connected === false
      ? ` It ${mode === 'debounced' ? 'opens' : 'closes'} once the "${serverId}" server reconnects and registers this ` +
        'channel, if this host may open and close its channels then.'
      : '';
    const retry =
      'Each step is safe to repeat, so call channel-mode--set_channel_mode again with the same channelId and ' +
      (mode === 'debounced' ? `mode, and debounceMs ${debounceMs},` : 'mode') +
      ' to retry; if it fails the same way, ask whoever runs this host.';
    // Steps ran, so a failed one may still have changed something: only the
    // refusals above say "Nothing changed".
    const summary =
      failed.length === 0
        ? mode === 'debounced'
          ? `Channel ${channelId} set to debounced mode, with a ${debounceMs} ms quiet window.`
          : `Channel ${channelId} set to mentions mode.`
        : done.length === 0
          ? `${unsure ? `Channel ${channelId} may not have changed` : `No step for channel ${channelId} reported success`}: ` +
            `${failures}.${later} ${retry}`
          : `Channel ${channelId} ${unsure ? 'may be' : 'is'} only partly in ${mode} mode: ` +
            `${listOf(done)}, and ${failures}.${later} ${retry}`;

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

  // Never closes or rolls back: a failed later step leaves the open in place.
  private async applyDebounced(channelId: string, serverId: string, debounceMs: number): Promise<StepResult[]> {
    const steps: StepResult[] = [];

    steps.push(await this.callToolStep('open', 'channel_open', { channelId, serverId }));

    if (!this.ctx || !this.framework) {
      steps.push({ step: 'gate-policy', ok: false, detail: 'the channel-mode module stopped before this step' });
    } else {
      try {
        // Reusing the name replaces an earlier rule for this id, including one
        // an older release installed with source discord.
        // Prepended: agent-framework's gate takes the first rule that matches.
        this.framework.addGatePolicy(
          {
            name: this.policyName(channelId),
            match: { source: serverId, channel: channelId, tagsAny: ['chat:ambient'] },
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

  private async applyMentions(channelId: string, serverId: string): Promise<StepResult[]> {
    const steps: StepResult[] = [];

    // agent-framework sends a removed rule's pending batch.
    try {
      const removed = this.framework!.removeGatePolicy(this.policyName(channelId));
      steps.push({ step: 'gate-policy', ok: true, detail: removed ? 'removed' : 'no rule to remove' });
    } catch (err) {
      steps.push({ step: 'gate-policy', ok: false, detail: errMsg(err) });
    }

    steps.push(await this.callToolStep('close', 'channel_close', { channelId, serverId }));

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

const EXPECTED_FORM =
  'give it as <serverId>:<channel>, exactly as channel_list shows it (for example zulip:<stream> or ' +
  'discord:<guildId>:<channelId>), where <serverId> is the MCPL server that owns the channel';

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
