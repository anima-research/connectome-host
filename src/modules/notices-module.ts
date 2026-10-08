/**
 * NoticesModule — tells the people in an agent's chat channels when the host
 * cannot answer them, through the same channels, without a working model.
 *
 * A sink of the framework's `ops:alert` trace stream (the same stream the
 * Discord ops webhook and the WebUI alert strip read). Nothing here looks at
 * raw `inference:failed` events: the framework's own breakers decide when a
 * failure is an outage (`hard-down` after N consecutive failures, credential
 * state transitions, `mcpl-down` after 5 attempts, …) and this module only
 * decides WHERE and HOW LOUDLY to say so.
 *
 * Three audiences, by tier:
 *   - `silent` — log only (the alert still reaches failures.log / webhook).
 *   - `status` — the recipe's status channels get the operator-grade message.
 *   - `reply`  — additionally, a person who writes to the agent while the
 *                outage is on gets one canned "cannot respond right now" line
 *                in the channel they wrote in, and the channel whose message
 *                triggered the failing turn is told the same. Reply scope is a
 *                list of channel-id patterns, so "reply on Zulip, never on
 *                Discord" is `reply: { in: ['zulip:*'] }`.
 *
 * Episode semantics (not time debounce): an episode opens on the first
 * qualifying alert, is extended by same/different kinds, and closes on the
 * kind's `-clear` alert — or, for framework kinds that have no clear
 * (`hard-down`, refusals), on the agent's next completed inference. One notice
 * per (episode, channel); a channel is told again only when the announced end
 * has passed and the outage is still on. Channels that were told get one
 * "back" line on close. Status posts wait `quietMs` for a clear, so a flap
 * that resolves in seconds says nothing; replies never wait — a human is.
 *
 * The chat MCPL server may itself be down. Channel ids are opaque here and
 * resolved at post time through the ChannelRegistry; a post that fails because
 * the channel or server is absent is parked on the episode and retried when a
 * server (re)connects while the episode is still open, else dropped silently.
 */

import type {
  AgentFramework,
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
  TraceEvent,
} from '@animalabs/agent-framework';

export type NoticeTier = 'silent' | 'status' | 'reply';

export interface NoticesModuleConfig {
  /** The agent whose outages these are. Alerts for other agents are ignored
   *  (component alerts such as `mcpl-down` are keyed by component instead). */
  agentName?: string;
  /** Channels that always get the operator-grade message for `status` and
   *  `reply` kinds. */
  statusChannels?: string[];
  /** Where reactive / waker replies may go — channel-id patterns, `*` wildcard
   *  (`zulip:*`, `discord:guild-1:*`, exact ids). Default `['*']`. */
  replyIn?: string[];
  /** Carve-outs from `replyIn`. */
  replyNot?: string[];
  /** Tier per alert kind, `*` wildcard on the kind (`auth-*`). Merged over
   *  DEFAULT_TIERS; unknown kinds are silent. */
  kinds?: Record<string, NoticeTier>;
  /** Status posts wait this long for a clear before posting (default 60 s). */
  quietMs?: number;
  /** A channel told this long ago may be told again if the outage persists
   *  past its announced end (default 30 min). */
  renotifyMs?: number;
  /** A failed turn's channel is told only if the alert arrives within this
   *  long of the failure (default 10 min). */
  wakerWindowMs?: number;
  /** Configured MCPL server ids, for a one-time startup warning about literal
   *  channel ids whose server is not in the recipe. */
  knownServers?: string[];
  now?: () => number;
  /** Timer injection for tests. */
  timers?: { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (h: unknown) => void };
}

/** Tier each framework / host alert kind gets unless the recipe says otherwise. */
export const DEFAULT_TIERS: Readonly<Record<string, NoticeTier>> = Object.freeze({
  // The agent cannot answer: tell the people waiting.
  'hard-down': 'reply',
  'quota-spent': 'reply',
  'auth-expired': 'reply',
  'auth-rejected': 'reply',
  'auth-login-required': 'reply',
  'provider-hold': 'reply',
  // Degraded, or an operator matter: status channels only.
  'context-refusal': 'status',
  'mcpl-down': 'status',
  'quota-unreadable': 'status',
  'auth-expiring': 'status',
  'refusal-offpath': 'status',
  'context-maintenance-failed': 'status',
  'compression-quarantine': 'status',
  // Normal operation noise.
  'refusal': 'silent',
});

/** Framework kinds with no `-clear` producer: a completed inference by the
 *  agent is the recovery signal. Everything else waits for its clear. */
const CLOSES_ON_SUCCESS: ReadonlySet<string> = new Set([
  'hard-down', 'context-refusal', 'refusal', 'refusal-offpath', 'context-maintenance-failed',
]);

/** Alert kinds whose `agentName` is a component id (an MCPL server), not an
 *  agent. They get their own episode, status tier at most, and close when
 *  that component reconnects. */
const COMPONENT_KINDS: ReadonlySet<string> = new Set(['mcpl-down']);

const DEFAULT_QUIET_MS = 60_000;
const DEFAULT_RENOTIFY_MS = 30 * 60_000;
const DEFAULT_WAKER_WINDOW_MS = 10 * 60_000;

interface Episode {
  /** Alert `agentName`: our agent, or a component id. */
  key: string;
  kind: string;
  message: string;
  tier: NoticeTier;
  since: number;
  until?: number;
  /** channelId → epoch ms of the last notice posted there. */
  notified: Map<string, number>;
  /** Channels whose post failed for lack of a channel/server; retried on reconnect. */
  pending: Set<string>;
  /** At least one status channel carries this episode (delivered after the
   *  quiet window), so it is owed a clear line. */
  statusPosted: boolean;
  /** Pending quiet-window timer handle, if any. */
  quietTimer?: unknown;
  markerWritten: boolean;
}

/** `*`-glob → anchored RegExp. */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}$`);
}

function matchesAny(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((p) => p.test(value));
}

/** Plain words for the channel, by alert kind. */
function plainReason(kind: string, message: string): string {
  switch (kind) {
    case 'quota-spent': return 'its subscription quota is spent';
    case 'auth-expired': return 'its provider credential has expired';
    case 'auth-rejected': return 'its provider credential was rejected';
    case 'auth-login-required': return 'its provider login must be redone';
    case 'hard-down': return 'its model calls keep failing';
    case 'provider-hold': return 'the provider is holding its requests';
    default: return message || kind;
  }
}

function fmtUntil(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

/** The canned line a public channel gets: no error text, just the reason. */
export function replyNoticeText(agent: string, ep: { kind: string; message: string; until?: number }): string {
  const when = ep.until !== undefined ? ` Expected back after ${fmtUntil(ep.until)}.` : '';
  return `⚠ [host notice] ${agent} cannot respond right now: ${plainReason(ep.kind, ep.message)}.${when} An operator has been alerted.`;
}

export function replyClearText(agent: string): string {
  return `✓ [host notice] ${agent} can respond again.`;
}

/** The operator-grade line a status channel gets: kind + message. */
export function statusNoticeText(subject: string, ep: { kind: string; message: string; until?: number }): string {
  const when = ep.until !== undefined ? ` Expected back after ${fmtUntil(ep.until)}.` : '';
  const msg = ep.message ? `: ${ep.message.slice(0, 500)}` : '';
  return `⚠ [host notice] ${subject} — ${ep.kind}${msg}.${when}`;
}

export function statusClearText(subject: string, kind: string, message: string): string {
  const msg = message ? ` (${message.slice(0, 200)})` : '';
  return `✓ [host notice] ${subject} — ${kind} cleared${msg}.`;
}

interface Registry {
  publishForAgent?: (channelId: string, text: string, agentName: string) => Promise<{ success: boolean; error?: string }>;
}

export class NoticesModule implements Module {
  readonly name = 'notices';

  private framework: AgentFramework | null = null;
  private readonly now: () => number;
  private readonly timers: NonNullable<NoticesModuleConfig['timers']>;
  private readonly statusChannels: string[];
  private readonly replyIn: RegExp[];
  private readonly replyNot: RegExp[];
  private readonly defaultTiers: Array<{ re: RegExp; exact: string | null; tier: NoticeTier }>;
  private readonly overrideTiers: Array<{ re: RegExp; exact: string | null; tier: NoticeTier }>;
  private readonly quietMs: number;
  private readonly renotifyMs: number;
  private readonly wakerWindowMs: number;
  private episodes = new Map<string, Episode>();
  /** Outbound locus of the agent's current / most recent turn. */
  private currentWake: string | undefined;
  /** The channel of the most recent FAILED turn, with its time. */
  private failedWake: { channelId: string; at: number } | undefined;
  private unsubscribe: (() => void) | null = null;
  private warnedServers = false;

  constructor(private readonly config: NoticesModuleConfig = {}) {
    this.now = config.now ?? Date.now;
    this.timers = config.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    this.statusChannels = [...new Set(config.statusChannels ?? [])];
    this.replyIn = (config.replyIn ?? ['*']).map(globToRegExp);
    this.replyNot = (config.replyNot ?? []).map(globToRegExp);
    const compile = (table: Record<string, NoticeTier>) =>
      Object.entries(table).map(([k, tier]) => ({ re: globToRegExp(k), exact: k.includes('*') ? null : k, tier }));
    this.defaultTiers = compile(DEFAULT_TIERS);
    this.overrideTiers = compile(config.kinds ?? {});
    this.quietMs = config.quietMs ?? DEFAULT_QUIET_MS;
    this.renotifyMs = config.renotifyMs ?? DEFAULT_RENOTIFY_MS;
    this.wakerWindowMs = config.wakerWindowMs ?? DEFAULT_WAKER_WINDOW_MS;
  }

  async start(_ctx: ModuleContext): Promise<void> {
    this.warnUnknownServers(this.config.knownServers);
  }

  async stop(): Promise<void> {
    for (const ep of this.episodes.values()) this.cancelQuiet(ep);
    this.episodes.clear();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.framework = null;
  }

  /** Called from the host after framework creation, like ActivityModule. */
  setFramework(framework: AgentFramework): void {
    this.framework = framework;
    this.unsubscribe?.();
    this.unsubscribe = framework.onTrace((event: TraceEvent) => this.onTrace(event as unknown as Record<string, unknown>));
  }

  /** Server ids known to the host — call once they are resolved. */
  setKnownServers(ids: string[]): void {
    this.warnUnknownServers(ids);
  }

  /** Tier a kind resolves to: the recipe table wins over the built-in one,
   *  and within a table an exact entry beats a glob. Unknown ⇒ silent. */
  tierFor(kind: string): NoticeTier {
    const lookup = (table: Array<{ re: RegExp; exact: string | null; tier: NoticeTier }>): NoticeTier | undefined => {
      let glob: NoticeTier | undefined;
      for (const t of table) {
        if (t.exact === kind) return t.tier;
        if (t.exact === null && glob === undefined && t.re.test(kind)) glob = t.tier;
      }
      return glob;
    };
    return lookup(this.overrideTiers) ?? lookup(this.defaultTiers) ?? 'silent';
  }

  /** Whether a reply notice may be posted in this channel. */
  mayReplyIn(channelId: string): boolean {
    return matchesAny(channelId, this.replyIn) && !matchesAny(channelId, this.replyNot);
  }

  /** Current episodes, for tests and the panel. */
  episodeState(): Array<{ key: string; kind: string; tier: NoticeTier; since: number; until?: number; notified: string[]; pending: string[]; statusPosted: boolean }> {
    return [...this.episodes.values()].map((ep) => ({
      key: ep.key, kind: ep.kind, tier: ep.tier, since: ep.since,
      ...(ep.until !== undefined ? { until: ep.until } : {}),
      notified: [...ep.notified.keys()], pending: [...ep.pending], statusPosted: ep.statusPosted,
    }));
  }

  getTools(): ToolDefinition[] { return []; }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    return { success: false, isError: true, error: `Unknown tool: ${call.name}` };
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type === 'mcpl:channel-incoming') {
      const e = event as unknown as { channelId: string };
      await this.replyIfDown(e.channelId);
    }
    return {};
  }

  // ---------------------------------------------------------------- traces

  private onTrace(event: Record<string, unknown>): void {
    const type = event.type as string;
    const agentName = typeof event.agentName === 'string' ? event.agentName : undefined;
    const mine = !this.config.agentName || !agentName || agentName === this.config.agentName;
    switch (type) {
      case 'ops:alert':
        this.onOpsAlert(event);
        return;
      case 'inference:started':
        if (!mine) return;
        this.currentWake = typeof event.channelId === 'string' ? event.channelId : undefined;
        return;
      case 'inference:exhausted':
        if (!mine) return;
        if (this.currentWake) {
          this.failedWake = { channelId: this.currentWake, at: this.now() };
          // The alert may already be open (hard-down re-fires per failure):
          // tell the channel whose turn just died.
          void this.replyToWaker();
        }
        return;
      case 'inference:completed':
        if (!mine) return;
        this.failedWake = undefined;
        {
          const ep = this.agentEpisode();
          if (ep && CLOSES_ON_SUCCESS.has(ep.kind)) {
            this.closeEpisode(ep, { message: 'inference completed', superseded: false });
          }
        }
        return;
      case 'mcpl:server-reconnected':
      case 'module:added': {
        // `module:added` is re-emitted for a reconnected MCPL server with the
        // server id as moduleName.
        const serverId = typeof event.serverId === 'string' ? event.serverId
          : typeof event.moduleName === 'string' ? event.moduleName : undefined;
        if (serverId) {
          const ep = this.episodes.get(serverId);
          if (ep && COMPONENT_KINDS.has(ep.kind)) this.closeEpisode(ep, { message: 'reconnected', superseded: false });
        }
        void this.flushPending();
        return;
      }
      default:
        return;
    }
  }

  private onOpsAlert(event: Record<string, unknown>): void {
    const kind = typeof event.kind === 'string' ? event.kind : '';
    if (!kind) return;
    const key = typeof event.agentName === 'string' ? event.agentName : '';
    const message = typeof event.message === 'string' ? event.message : '';
    const base = kind.endsWith('-clear') ? kind.slice(0, -'-clear'.length) : null;

    if (base !== null) {
      const ep = this.episodes.get(key);
      if (!ep || ep.kind !== base) return;
      // Superseded (auth-expiring → auth-expired) is not recovery: the next
      // alert re-arms a fresh episode; only a clear to "ok" posts the all-clear.
      this.closeEpisode(ep, { message, superseded: /^superseded by /.test(message) });
      return;
    }

    const component = COMPONENT_KINDS.has(kind);
    if (!component && this.config.agentName && key && key !== this.config.agentName) return;
    let tier = this.tierFor(kind);
    if (component && tier === 'reply') tier = 'status';
    if (tier === 'silent') return;

    const data = (event.data ?? {}) as { until?: unknown };
    const until = typeof data.until === 'number' && Number.isFinite(data.until) ? data.until : undefined;

    const existing = this.episodes.get(key);
    if (existing && existing.kind === kind) {
      existing.message = message;
      existing.until = until;
      existing.tier = tier;
      return;
    }
    if (existing) {
      // A different kind continues the episode for the channels already told:
      // they are not told twice, and still get the "back" line when it ends.
      // The status channels learn the new reason (after the quiet window).
      existing.kind = kind;
      existing.message = message;
      existing.until = until;
      existing.tier = tier;
      if (existing.statusPosted) {
        existing.statusPosted = false;
        this.scheduleStatus(existing);
      }
      void this.replyToWaker();
      return;
    }
    const ep: Episode = {
      key, kind, message, tier, since: this.now(), until,
      notified: new Map(), pending: new Set(), statusPosted: false, markerWritten: false,
    };
    this.episodes.set(key, ep);
    this.scheduleStatus(ep);
    void this.replyToWaker();
  }

  // -------------------------------------------------------------- episodes

  private agentEpisode(): Episode | undefined {
    const ep = this.config.agentName ? this.episodes.get(this.config.agentName) : undefined;
    if (ep) return ep;
    if (this.config.agentName) return undefined;
    // No agent name configured: the first non-component episode.
    for (const e of this.episodes.values()) if (!COMPONENT_KINDS.has(e.kind)) return e;
    return undefined;
  }

  private closeEpisode(ep: Episode, opts: { message: string; superseded: boolean }): void {
    this.cancelQuiet(ep);
    this.episodes.delete(ep.key);
    if (opts.superseded) return;
    const subject = ep.key || this.config.agentName || 'the agent';
    const replyTold = [...ep.notified.keys()].filter((ch) => !this.statusChannels.includes(ch));
    for (const ch of replyTold) void this.post(ch, replyClearText(subject), ep, { track: false });
    if (ep.statusPosted) {
      for (const ch of this.statusChannels) void this.post(ch, statusClearText(subject, ep.kind, opts.message), ep, { track: false });
    }
  }

  private scheduleStatus(ep: Episode): void {
    if (this.statusChannels.length === 0) return;
    this.cancelQuiet(ep);
    const fire = () => {
      ep.quietTimer = undefined;
      if (this.episodes.get(ep.key) !== ep) return;
      for (const ch of this.statusChannels) void this.postStatus(ep, ch);
    };
    if (this.quietMs <= 0) { fire(); return; }
    ep.quietTimer = this.timers.setTimeout(fire, this.quietMs);
  }

  private cancelQuiet(ep: Episode): void {
    if (ep.quietTimer !== undefined) {
      this.timers.clearTimeout(ep.quietTimer);
      ep.quietTimer = undefined;
    }
  }

  // --------------------------------------------------------------- replies

  /** Incoming traffic on a channel while the agent is down: say so, once. */
  private async replyIfDown(channelId: string): Promise<void> {
    const ep = this.agentEpisode();
    if (!ep || ep.tier !== 'reply') return;
    if (!this.mayReplyIn(channelId)) return;
    // A status channel already carries the operator message.
    if (this.statusChannels.includes(channelId)) return;
    const last = ep.notified.get(channelId);
    const now = this.now();
    if (last !== undefined) {
      // One notice per episode. The only reason to speak again is that the
      // announced end has passed and the outage is still on — the notice was
      // wrong about "expected back after". No announced end ⇒ nothing to
      // correct ⇒ silence until the clear.
      const announcedEndPassed = ep.until !== undefined && ep.until <= now;
      if (!announcedEndPassed || now - last < this.renotifyMs) return;
    }
    await this.postReply(ep, channelId);
  }

  /** The channel whose turn just failed is told, within the waker window. */
  private async replyToWaker(): Promise<void> {
    const ep = this.agentEpisode();
    const fw = this.failedWake;
    if (!ep || ep.tier !== 'reply' || !fw) return;
    if (this.now() - fw.at > this.wakerWindowMs) return;
    if (!this.mayReplyIn(fw.channelId) || this.statusChannels.includes(fw.channelId)) return;
    if (ep.notified.has(fw.channelId)) return;
    await this.postReply(ep, fw.channelId);
  }

  private async postStatus(ep: Episode, channelId: string): Promise<void> {
    const subject = ep.key || this.config.agentName || 'the agent';
    const ok = await this.post(channelId, statusNoticeText(subject, ep), ep, { track: true });
    if (ok) ep.statusPosted = true;
  }

  private async postReply(ep: Episode, channelId: string): Promise<void> {
    const subject = ep.key || this.config.agentName || 'the agent';
    const text = replyNoticeText(subject, ep);
    ep.notified.set(channelId, this.now());
    const ok = await this.post(channelId, text, ep, { track: true });
    if (!ok) ep.notified.delete(channelId);
  }

  /** Retry channels parked on an absent server, if their episode is still open. */
  private async flushPending(): Promise<void> {
    for (const ep of [...this.episodes.values()]) {
      for (const channelId of [...ep.pending]) {
        ep.pending.delete(channelId);
        if (this.episodes.get(ep.key) !== ep) break;
        if (this.statusChannels.includes(channelId)) await this.postStatus(ep, channelId);
        else await this.postReply(ep, channelId);
      }
    }
  }

  /**
   * Publish as the host. `track` parks the channel on the episode when the
   * failure is "channel/server not found" — the chat server may simply not be
   * up yet — so a reconnect during the episode can deliver it.
   */
  private async post(channelId: string, text: string, ep: Episode, opts: { track: boolean }): Promise<boolean> {
    const registry = this.framework?.channels as Registry | undefined;
    if (!registry?.publishForAgent) return false;
    let result: { success: boolean; error?: string };
    try {
      result = await registry.publishForAgent(channelId, text, this.config.agentName ?? 'host');
    } catch (err) {
      result = { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (result.success) {
      if (opts.track && !ep.markerWritten) {
        ep.markerWritten = true;
        this.writeMarker(ep, channelId, text);
      }
      return true;
    }
    const absent = /not found/i.test(result.error ?? '');
    if (opts.track && absent && this.episodes.get(ep.key) === ep) ep.pending.add(channelId);
    else console.error(`[notices] post to ${channelId} failed: ${result.error ?? 'unknown error'}`);
    return false;
  }

  /** One chronicle marker per episode so the agent learns, on recovery,
   *  that the host spoke in its channel while it could not. System-flagged:
   *  no inference is requested (same as the framework's own markers). */
  private writeMarker(ep: Episode, channelId: string, text: string): void {
    if (!this.config.agentName || COMPONENT_KINDS.has(ep.kind)) return;
    try {
      const agent = this.framework?.getAgent(this.config.agentName);
      agent?.getContextManager().addMessage(
        'user',
        [{
          type: 'text',
          text: `[host-notice] While you could not respond (${ep.kind}), the host posted this in ${channelId}: "${text}"`,
        }],
        { system: true, kind: 'host-notice', alertKind: ep.kind, channelId } as unknown as Record<string, unknown>,
      );
    } catch (err) {
      console.error('[notices] could not record the host-notice marker:', err instanceof Error ? err.message : err);
    }
  }

  private warnUnknownServers(ids: string[] | undefined): void {
    if (!ids || this.warnedServers) return;
    this.warnedServers = true;
    const known = new Set(ids);
    const literal = [...this.statusChannels, ...(this.config.replyIn ?? []), ...(this.config.replyNot ?? [])]
      .filter((p) => !p.includes('*') && p.includes(':'));
    const missing = [...new Set(literal.map((id) => id.slice(0, id.indexOf(':'))))].filter((s) => !known.has(s));
    if (missing.length > 0) {
      console.warn(`[notices] channel ids name MCPL servers not in this recipe: ${missing.join(', ')} — notices there will never be delivered`);
    }
  }
}
