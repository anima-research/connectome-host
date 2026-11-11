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
  /** Legacy fallback for unregistered bare ids or its own namespace only (default: discord). */
  serverId?: string;
  /** @deprecated Lifecycle tools are host-generic; retained for config compatibility. */
  toolPrefix?: string;
  gcModuleName?: string;
  defaultDebounceMs?: number;
}

type ChannelMode = 'debounced' | 'mentions';
type ServerResolution = { serverId: string; connected: boolean } | { error: string };
interface ChannelModeState { owners: Record<string, string> }

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
  private pendingOwners = new Set<string>();

  private readonly fallbackServerId: string;
  private readonly gcModuleName: string;
  private readonly defaultDebounceMs: number;

  constructor(config: ChannelModeConfig = {}) {
    this.fallbackServerId = config.serverId ?? 'discord';
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
          'Set channel attention: `debounced` opens the channel, batches ambient messages into one wake after ' +
          'a quiet window, and pins it against auto-close. `mentions` removes the rule, closes, and unpins for ' +
          'direct-address-only attention, even if the owner is disconnected. Debounced needs a connected owner. ' +
          'Before changing owners, finish mentions cleanup on the saved owner. ' +
          `Quiet window: 100–300000 ms, default ${this.defaultDebounceMs}.`,
        inputSchema: {
          type: 'object',
          properties: {
            channelId: { type: 'string', description: 'Copy the exact incoming-event id: zulip:backend, slack:<conversationId> (slack:C0123ABCD), or discord:<guildId>:<channelId>, not a raw platform id. Bare legacy ids (no colon) may use the configured fallback. Unknown namespaces are refused.' },
            serverId: { type: 'string', description: 'Optional owning MCPL server, for ids registered on more than one server.' },
            mode: { type: 'string', enum: ['debounced', 'mentions'], description: 'Target attention mode.' },
            debounceMs: { type: 'number', description: 'Quiet window in ms (100–300000); validated in either mode.' },
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
    const serverId = input.serverId;
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
    if (serverId !== undefined && !(typeof serverId === 'string' && serverId.length > 0)) {
      problems.push(`serverId must be a nonempty MCPL server id as text, not ${shown(serverId)}`);
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

    // Module state follows the current Chronicle branch without restarting us.
    const owners = this.readOwners();
    const savedOwner = owners.get(channelId);
    const explicit = serverId as string | undefined;
    const entries = this.framework.channels?.listChannelsRaw() ?? [];
    const registered = entries.filter(entry => entry.descriptor.id === channelId);
    // Reuse the registry's refusal/hint, without running an open or any other step.
    if (mode === 'debounced' && explicit !== undefined && registered.length > 0 &&
        !registered.some(entry => entry.serverId === explicit)) {
      const refusal = this.framework.channels!.resolveChannel(channelId, explicit);
      if ('error' in refusal) return { success: false, isError: true, error: `Nothing changed: ${refusal.error}` };
    }
    const ownerMissing = savedOwner !== undefined &&
      !registered.some(entry => entry.serverId === savedOwner);
    const ownerServer = this.framework.listMcplServers().find(server => server.id === savedOwner);
    // An empty registry can mean startup, not deregistration. Disconnection
    // also makes registrations inconclusive; retain the binding until retry.
    const ownerPending = ownerMissing && ownerServer !== undefined &&
      (!ownerServer.connected || !entries.some(entry => entry.serverId === savedOwner));
    const ownerGone = ownerMissing && !ownerPending;
    const releaseOrphan = mode === 'mentions' && ownerMissing &&
      (ownerGone || explicit === savedOwner);
    if (savedOwner !== undefined && explicit !== undefined && explicit !== savedOwner && !releaseOrphan) {
      return { success: false, isError: true, error: `Nothing changed: channel ${channelId} is bound to saved owner ${savedOwner}. Complete mentions cleanup on that owner before selecting ${explicit}.` };
    }
    const resolved = releaseOrphan
      ? { serverId: savedOwner!, connected: false }
      : ownerPending
        ? mode === 'mentions'
          ? { serverId: savedOwner!, connected: ownerServer!.connected }
          : { error: `MCPL server ${savedOwner} for channel ${channelId} is disconnected or hasn't registered its channels yet. Retry once it is connected and has registered its channels.` }
        : ownerGone
          ? { error: `The saved owner ${savedOwner} no longer registers channel ${channelId} (deregistered or removed). Restore that server and its registration, or call mentions with or without serverId to remove the rule, unpin, and clear the record even if the old owner's close is unconfirmed.` }
          : this.resolveServer(channelId, explicit ?? savedOwner);
    if (mode === 'debounced') {
      const error = 'error' in resolved ? resolved.error : !resolved.connected
        ? `MCPL server ${resolved.serverId} for channel ${channelId} is disconnected. Connect that server before retrying.`
        : undefined;
      if (error) return { success: false, error: `Nothing changed: ${error}`, isError: true };
    }
    // Reserve capacity before the first await/effect, including concurrent opens.
    const reserveOwner = mode === 'debounced' && !owners.has(channelId);
    if (reserveOwner) {
      if (this.pendingOwners.has(channelId)) {
        return { success: false, isError: true, error: `Nothing changed: a debounced change for channel ${channelId} is in progress. Retry after it completes.` };
      }
      if (owners.size + this.pendingOwners.size >= MAX_OWNERS) {
        return { success: false, isError: true, error: `Nothing changed: channel-mode's ${MAX_OWNERS} live-owner capacity is full. Complete mentions cleanup for a tracked channel to free a slot (mentions can release deregistered or removed owners even if their close is unconfirmed).` };
      }
      this.pendingOwners.add(channelId);
    }
    let steps: StepResult[];
    try {
      steps = mode === 'debounced' && 'serverId' in resolved
        ? await this.applyDebounced(channelId, resolved.serverId, debounceMs)
        : await this.applyMentions(channelId, resolved, releaseOrphan, ownerPending && !releaseOrphan);
    } finally {
      if (reserveOwner) this.pendingOwners.delete(channelId);
    }

    const failed = steps.filter((s) => !s.ok);
    const worked = steps.filter((s) => s.ok);
    const unsure = failed.some((s) => s.unanswered);
    const failures = failed
      .map((s) => s.unanswered
        ? `${STEP_NAMES[s.step] ?? s.step} got no answer (${s.detail}), so it may or may not have taken effect`
        : `${STEP_NAMES[s.step] ?? s.step} failed (${s.detail})`)
      .join('; ');
    // Only a sole, answered close failure owns all retry guidance. Other
    // failures still need retry advice, even alongside a deferred close.
    const retry = mode === 'mentions' && failed.length === 1 && failed[0]!.step === 'close' && !failed[0]!.unanswered ? '' :
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
            `${failures}.${retry ? ` ${retry}` : ''}`
          : `Channel ${channelId} ${unsure ? 'may be' : 'is'} only partly in ${mode} mode: ` +
            `${listOf(worked.map(doneText))}, and ${failures}.${retry ? ` ${retry}` : ''}`;

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

  private resolveServer(channelId: string, preferredServerId?: string): ServerResolution {
    const framework = this.framework!;
    // Without an explicit/saved owner, registry ownership is authoritative:
    // channel ids need not begin with the connection id. GateEventInfo's source match also uses that serverId for
    // both channels/incoming and push events (agent-framework's admission path).
    const owners = framework.channels?.listChannelsRaw()
      .filter(entry => entry.descriptor.id === channelId) ?? [];
    const servers = framework.listMcplServers();
    if (preferredServerId !== undefined) {
      const server = servers.find(server => server.id === preferredServerId);
      if (!server && !owners.some(owner => owner.serverId === preferredServerId)) {
        return { error: `MCPL server ${preferredServerId} for channel ${channelId} is unknown. Pass serverId naming a known server or a registry owner.` };
      }
      return { serverId: preferredServerId, connected: server?.connected === true };
    }
    if (owners.length > 1) {
      return { error: `Channel ${channelId} is registered on multiple MCPL servers: ${owners.map(owner => owner.serverId).sort().join(', ')}. Pass serverId to select its owner.` };
    }
    const colon = channelId.indexOf(':');
    const prefix = colon >= 0 ? channelId.slice(0, colon) : undefined;
    // A legacy bare id may fall back, but an unknown namespace must never be
    // routed to a different server (nor leave a wrong-source rule and GC pin).
    const fallback = colon < 0 || prefix === this.fallbackServerId ? this.fallbackServerId : undefined;
    const serverId = owners[0]?.serverId
      ?? (prefix && servers.some(server => server.id === prefix) ? prefix : fallback);
    const server = servers.find(server => server.id === serverId);
    if (!owners.length && !server) {
      return { error: `Cannot resolve a known MCPL server for channel ${channelId}. Copy the exact registered channel id from incoming events; for legacy ids, ask your operator to configure modules.channelMode.serverId.` };
    }
    return { serverId: serverId!, connected: server?.connected === true };
  }

  private readOwners(): Map<string, string> {
    return new Map(Object.entries(this.ctx?.getState<ChannelModeState>()?.owners ?? {}));
  }

  private policyName(channelId: string): string {
    return `channel-mode:debounced:${channelId}`;
  }

  private async applyDebounced(channelId: string, serverId: string, debounceMs: number): Promise<StepResult[]> {
    const steps: StepResult[] = [];
    steps.push(await this.callToolStep('open', 'channel_open', { channelId, serverId }));

    if (!this.ctx || !this.framework) {
      steps.push({ step: 'gate-policy', ok: false, detail: 'the channel-mode module stopped before this step' });
    } else {
      try {
        // Reusing the name replaces even a legacy wrong-source rule.
        // Prepended: agent-framework's gate takes the first rule that matches.
        this.framework.addGatePolicy(
          {
            name: this.policyName(channelId),
            match: { source: serverId, channel: channelId, tagsAny: ['chat:ambient'] },
            behavior: { debounce: debounceMs },
          },
          { position: 'prepend' },
        );
        if (steps[0]!.ok) {
          const owners = this.readOwners();
          owners.set(channelId, serverId);
          this.ctx.setState<ChannelModeState>({ owners: Object.fromEntries(owners) });
        }
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

  private async applyMentions(channelId: string, resolved: ServerResolution, releaseOrphan = false, retainPending = false): Promise<StepResult[]> {
    const steps: StepResult[] = [];

    // agent-framework sends a removed rule's pending batch.
    try {
      const removed = this.framework!.removeGatePolicy(this.policyName(channelId));
      steps.push({ step: 'gate-policy', ok: true, detail: removed ? 'removed' : 'no rule to remove' });
    } catch (err) {
      steps.push({ step: 'gate-policy', ok: false, detail: errMsg(err) });
    }

    steps.push('serverId' in resolved
      ? await this.callToolStep('close', 'channel_close', { channelId, serverId: resolved.serverId })
      : { step: 'close', ok: false, detail: `skipped: ${resolved.error}` });

    steps.push(
      await this.callToolStep('gc-unpin', `${this.gcModuleName}--pin_channel_idle_limit`, {
        channelId,
        pinned: false,
      }),
    );

    // A disconnected close returns failure, but the registry durably records
    // it. Consult its structured desired state, not error-message wording.
    const closed = 'serverId' in resolved && (steps[1]!.ok ||
      this.framework!.channels?.getDesiredState?.(resolved.serverId, channelId) === 'closed');
    // Live owners still need a close; a missing GC tool does not retain them.
    // An unregistered owner's close may fail before recording desired state.
    // Release that orphan after rule cleanup AND unpin (or confirmed GC
    // absence), not a replacement close.
    const owners = this.readOwners();
    let released = false;
    if (!retainPending && steps[0]!.ok && (releaseOrphan ? steps[2]!.ok : closed) &&
        'serverId' in resolved && this.ctx && owners.get(channelId) === resolved.serverId) {
      owners.delete(channelId);
      this.ctx.setState<ChannelModeState>({ owners: Object.fromEntries(owners) });
      released = true;
    }
    if (releaseOrphan && !steps[1]!.ok && 'serverId' in resolved) {
      steps[1]!.detail = `Old owner ${resolved.serverId}'s close could not be confirmed. ` +
        `The saved owner record was ${released ? 'cleared' : 'retained'}. ` +
        'This does not confirm a close. ' +
        `Close attempt: ${steps[1]!.detail}`;
    }

    if (retainPending && !steps[1]!.ok) {
      steps[1]!.detail += ' The saved owner record was retained. Retry mentions after the saved owner connects and registers its channels; the close must be retried.';
    }

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
      // GC is optional and may have been removed since debounced setup. Only
      // confirmed module absence is a no-op; a present module's failure stays
      // a failure, even if its error happens to say "Module not found".
      if ((step === 'gc-unpin' || step === 'gc-pin') && ctx.getModule(this.gcModuleName) === null) {
        return { step, ok: true, detail: `no ${this.gcModuleName} module; ${step === 'gc-pin' ? 'nothing auto-closes it' : 'nothing to unpin'}` };
      }
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
/** Live ownership only; never evict an owner needed for safe cleanup. */
const MAX_OWNERS = 1024;

function doneText(s: StepResult): string {
  switch (s.step) {
    case 'open': return 'the channel is open';
    case 'close': return 'the channel is closed';
    case 'gate-policy':
      return s.detail === 'set' ? 'its debounce rule is set'
        : s.detail === 'removed' ? 'its debounce rule was removed'
        : 'it had no debounce rule to remove';
    case 'gc-pin': return s.detail.endsWith('; nothing auto-closes it') ? s.detail : 'it is pinned open';
    case 'gc-unpin': return s.detail.endsWith('; nothing to unpin') ? `there was no pin to release (${s.detail.split(';')[0]})` : "it isn't pinned";
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
