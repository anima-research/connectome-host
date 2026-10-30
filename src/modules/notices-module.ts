/**
 * A sink of agent-framework's `ops:alert` trace stream: the framework decides
 * when a failure is an outage.
 */

import type {
  AgentFramework,
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  PublishRefusalReason,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
  TraceEvent,
} from '@animalabs/agent-framework';
import { unknownToolResult } from './unknown-tool.js';
import { addressedPush } from './addressed-push.js';

export type NoticeTier = 'silent' | 'status' | 'reply';

export interface NoticesModuleConfig {
  agentName?: string;
  statusChannels?: string[];
  replyIn?: string[];
  replyNot?: string[];
  kinds?: Record<string, NoticeTier>;
  quietMs?: number;
  renotifyMs?: number;
  wakerWindowMs?: number;
  knownServers?: string[];
  now?: () => number;
  timers?: { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (h: unknown) => void };
}

export const DEFAULT_TIERS: Readonly<Record<string, NoticeTier>> = Object.freeze({
  'hard-down': 'reply',
  'quota-spent': 'reply',
  'auth-expired': 'reply',
  'auth-rejected': 'reply',
  'auth-login-required': 'reply',
  'provider-hold': 'reply',
  'context-refusal': 'status',
  'mcpl-down': 'status',
  'quota-unreadable': 'status',
  'auth-expiring': 'status',
  'credential-unsaved': 'status',
  'refusal-offpath': 'status',
  'context-maintenance-failed': 'status',
  'compression-quarantine': 'status',
  'instructions-unavailable': 'status',
  'refusal': 'silent',
});

/** agent-framework raises these kinds with no `-clear` alert. */
const CLOSES_ON_SUCCESS: ReadonlySet<string> = new Set([
  'hard-down', 'context-refusal', 'refusal', 'refusal-offpath', 'context-maintenance-failed',
]);

/** Alert kinds whose `agentName` is a component id (an MCPL server), not an
 *  agent. */
const COMPONENT_KINDS: ReadonlySet<string> = new Set(['mcpl-down']);

type MarkerForm = 'unanswered' | 'status';

const DEFAULT_QUIET_MS = 60_000;
const OWED_LINES_CAP = 20;
const DEFAULT_RENOTIFY_MS = 30 * 60_000;
const DEFAULT_WAKER_WINDOW_MS = 10 * 60_000;

interface ActiveKind {
  message: string;
  tier: NoticeTier;
  until?: number;
  at: number;
  seq: number;
}

interface Episode {
  key: string;
  kinds: Map<string, ActiveKind>;
  since: number;
  notified: Map<string, number>;
  replyPosting: Set<string>;
  pending: Set<string>;
  statusHeard: Map<string, Set<string>>;
  statusPosting: Map<string, Map<string, number>>;
  statusOwedClear: Map<string, Set<string>>;
  nextSeq: number;
  quietTimer?: unknown;
  quietDue?: number;
  markedForms: Set<MarkerForm>;
}

interface OwedLine {
  text: string;
  key: string;
  clearedKind?: string;
}

const TIER_RANK: Record<NoticeTier, number> = { silent: 0, status: 1, reply: 2 };

function episodeTier(ep: Episode): NoticeTier {
  let best: NoticeTier = 'silent';
  for (const k of ep.kinds.values()) if (TIER_RANK[k.tier] > TIER_RANK[best]) best = k.tier;
  return best;
}

function primaryKind(ep: Episode): { kind: string; message: string; until?: number } {
  const tier = episodeTier(ep);
  let pick: [string, ActiveKind] | undefined;
  for (const entry of ep.kinds) {
    if (entry[1].tier !== tier) continue;
    if (!pick || entry[1].at >= pick[1].at) pick = entry;
  }
  const [kind, k] = pick ?? ['', { message: '', tier, at: 0 }];
  return { kind, message: k.message, ...(k.until !== undefined ? { until: k.until } : {}) };
}

export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}$`);
}

function getSet<K, V>(map: Map<K, Set<V>>, key: K): Set<V> {
  let set = map.get(key);
  if (!set) { set = new Set(); map.set(key, set); }
  return set;
}

function matchesAny(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((p) => p.test(value));
}

function plainReason(kind: string): string {
  switch (kind) {
    case 'quota-spent': return 'its subscription quota is spent';
    case 'auth-expired': return 'its provider credential has expired';
    case 'auth-rejected': return 'its provider credential was rejected';
    case 'auth-login-required': return 'its provider login must be redone';
    case 'hard-down': return 'its model calls keep failing';
    case 'provider-hold': return 'the provider is holding its requests';
    default: return `it is temporarily unavailable (${kind})`;
  }
}

function fmtUntil(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export function replyNoticeText(agent: string, ep: { kind: string; until?: number }): string {
  const when = ep.until !== undefined ? ` Expected back after ${fmtUntil(ep.until)}.` : '';
  return `⚠ [host notice] ${agent} cannot respond right now: ${plainReason(ep.kind)}.${when} An operator has been alerted.`;
}

export function replyClearText(agent: string): string {
  return `✓ [host notice] ${agent} can respond again.`;
}

export function statusNoticeText(subject: string, ep: { kind: string; message: string; until?: number }): string {
  const when = ep.until !== undefined ? ` Expected back after ${fmtUntil(ep.until)}.` : '';
  const msg = ep.message ? `: ${ep.message.slice(0, 500)}` : '';
  return `⚠ [host notice] ${subject} — ${ep.kind}${msg}.${when}`;
}

export function statusClearText(subject: string, kind: string, message: string, still?: string): string {
  const msg = message ? ` (${message.slice(0, 200)})` : '';
  const rest = still ? ` Still: ${still}.` : '';
  return `✓ [host notice] ${subject} — ${kind} cleared${msg}.${rest}`;
}

interface Registry {
  publishForAgent?: (channelId: string, text: string, agentName: string) => Promise<PublishResult>;
}

type PublishResult = { success: boolean; error?: string; reason?: PublishRefusalReason };

/**
 * The refusals agent-framework gives when the chat server may simply not be
 * up: the channel isn't registered (yet), its server is gone, connecting or
 * down, or its connection refused the request before writing anything
 * (`not-sent`).
 */
const PARKED_REFUSALS: ReadonlySet<PublishRefusalReason> = new Set<PublishRefusalReason>([
  'channel-not-registered',
  'server-gone',
  'server-connecting',
  'server-down',
  'not-sent',
]);

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
  private currentWake: string | undefined;
  private failedWake: { channelId: string; at: number } | undefined;
  private unsubscribe: (() => void) | null = null;
  private warnedServers = false;
  private reconnectEpoch = 0;
  private owedLines = new Map<string, OwedLine[]>();
  private flushChain: Promise<void> = Promise.resolve();

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
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.framework = null;
  }

  setFramework(framework: AgentFramework): void {
    this.framework = framework;
    this.unsubscribe?.();
    this.unsubscribe = framework.onTrace((event: TraceEvent) => this.onTrace(event as unknown as Record<string, unknown>));
    for (const ep of this.episodes.values()) this.scheduleStatus(ep);
    if (this.episodes.size > 0 || this.owedLines.size > 0) void this.flushPending();
  }

  setKnownServers(ids: string[]): void {
    this.warnUnknownServers(ids);
  }

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

  mayReplyIn(channelId: string): boolean {
    return matchesAny(channelId, this.replyIn) && !matchesAny(channelId, this.replyNot);
  }

  owedState(): Record<string, string[]> {
    return Object.fromEntries([...this.owedLines].filter(([, l]) => l.length > 0).map(([ch, l]) => [ch, l.map((o) => o.text)]));
  }

  episodeState(): Array<{ key: string; kind: string; kinds: string[]; tier: NoticeTier; since: number; until?: number; notified: string[]; pending: string[]; statusHeard: Record<string, string[]> }> {
    return [...this.episodes.values()].map((ep) => {
      const primary = primaryKind(ep);
      const statusHeard: Record<string, string[]> = {};
      for (const [ch, kinds] of ep.statusHeard) if (kinds.size > 0) statusHeard[ch] = [...kinds];
      return {
        key: ep.key, kind: primary.kind, kinds: [...ep.kinds.keys()], tier: episodeTier(ep), since: ep.since,
        ...(primary.until !== undefined ? { until: primary.until } : {}),
        notified: [...ep.notified.keys()], pending: [...ep.pending], statusHeard,
      };
    });
  }

  getTools(): ToolDefinition[] { return []; }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    return unknownToolResult(this, call.name);
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type === 'mcpl:channel-incoming') {
      const e = event as unknown as { channelId: string };
      await this.replyIfDown(e.channelId);
    } else {
      const pushed = addressedPush(event);
      if (pushed) await this.replyIfDown(pushed.channelId);
    }
    return {};
  }

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
      case 'inference:aborted':
        if (!mine) return;
        this.currentWake = undefined;
        return;
      case 'inference:exhausted':
        if (!mine) return;
        if (this.currentWake) {
          this.failedWake = { channelId: this.currentWake, at: this.now() };
          // agent-framework's hard-down alert fires again with each failure, so it may
          // already be open.
          void this.replyToWaker();
        }
        return;
      case 'inference:completed':
      case 'inference:turn_ended':
        if (!mine) return;
        this.failedWake = undefined;
        {
          const ep = this.agentEpisode();
          if (ep) {
            for (const kind of [...ep.kinds.keys()]) {
              if (CLOSES_ON_SUCCESS.has(kind)) this.removeKind(ep, kind, { message: 'inference completed', superseded: false });
            }
          }
        }
        return;
      case 'mcpl:server-reconnected':
      case 'module:added': {
        const serverId = typeof event.serverId === 'string' ? event.serverId
          : typeof event.moduleName === 'string' ? event.moduleName : undefined;
        if (serverId) {
          const ep = this.episodes.get(serverId);
          if (ep) {
            for (const kind of [...ep.kinds.keys()]) {
              if (COMPONENT_KINDS.has(kind)) this.removeKind(ep, kind, { message: 'reconnected', superseded: false });
            }
          }
        }
        this.reconnectEpoch++;
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
      if (!ep || !ep.kinds.has(base)) return;
      this.removeKind(ep, base, { message, superseded: /^superseded by /.test(message) });
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
    if (existing) {
      const prior = existing.kinds.get(kind);
      existing.kinds.set(kind, { message, tier, until, at: prior?.at ?? this.now(), seq: prior?.seq ?? existing.nextSeq++ });
      if (prior) return;
      this.scheduleStatus(existing);
      void this.replyToWaker();
      return;
    }
    const ep: Episode = {
      key, kinds: new Map([[kind, { message, tier, until, at: this.now(), seq: 0 }]]), since: this.now(),
      notified: new Map(), replyPosting: new Set(), pending: new Set(), statusHeard: new Map(), statusPosting: new Map(), statusOwedClear: new Map(), nextSeq: 1, markedForms: new Set(),
    };
    this.episodes.set(key, ep);
    this.scheduleStatus(ep);
    void this.replyToWaker();
  }

  private agentEpisode(): Episode | undefined {
    const ep = this.config.agentName ? this.episodes.get(this.config.agentName) : undefined;
    if (ep) return ep;
    if (this.config.agentName) return undefined;
    for (const e of this.episodes.values()) if (![...e.kinds.keys()].some((k) => COMPONENT_KINDS.has(k))) return e;
    return undefined;
  }

  private removeKind(ep: Episode, kind: string, opts: { message: string; superseded: boolean }): void {
    const wasReply = episodeTier(ep) === 'reply';
    ep.kinds.delete(kind);
    const open = ep.kinds.size > 0;
    const stillReply = open && episodeTier(ep) === 'reply';
    if (!open) {
      this.cancelQuiet(ep);
      this.episodes.delete(ep.key);
      ep.pending.clear();
    }
    const subject = ep.key || this.config.agentName || 'the agent';
    const still = open ? primaryKind(ep).kind : undefined;
    const owedChannels = new Set<string>();
    for (const [ch, heard] of ep.statusHeard) if (heard.delete(kind)) owedChannels.add(ch);
    for (const [ch, owed] of ep.statusOwedClear) if (owed.delete(kind)) owedChannels.add(ch);
    if (!opts.superseded) {
      for (const ch of owedChannels) {
        void this.post(ch, statusClearText(subject, kind, opts.message, still), ep, { track: false, owe: { key: ep.key, clearedKind: kind } });
      }
    }
    if (opts.superseded || !wasReply || stillReply) return;
    for (const ch of ep.notified.keys()) {
      if (ep.replyPosting.has(ch)) continue;
      void this.post(ch, replyClearText(subject), ep, { track: false, owe: { key: ep.key } });
    }
    ep.notified.clear();
  }

  private scheduleStatus(ep: Episode): void {
    if (this.statusChannels.length === 0) return;
    if (this.episodes.get(ep.key) !== ep) return;
    const now = this.now();
    this.deliverStatus(ep);
    let next: number | undefined;
    for (const [kind, k] of ep.kinds) {
      const due = k.at + this.quietMs;
      if (due <= now) continue;
      const settled = this.statusChannels.every((ch) =>
        ep.statusHeard.get(ch)?.has(kind) || ep.statusPosting.get(ch)?.get(kind) === k.seq);
      if (settled) continue;
      if (next === undefined || due < next) next = due;
    }
    if (next === undefined) { this.cancelQuiet(ep); return; }
    if (ep.quietTimer !== undefined && ep.quietDue !== undefined && ep.quietDue <= next) return;
    this.cancelQuiet(ep);
    ep.quietDue = next;
    ep.quietTimer = this.timers.setTimeout(() => {
      ep.quietTimer = undefined;
      ep.quietDue = undefined;
      if (this.episodes.get(ep.key) !== ep) return;
      this.scheduleStatus(ep);
    }, next - now);
  }

  private deliverStatus(ep: Episode): void {
    const now = this.now();
    for (const [kind, k] of ep.kinds) {
      if (k.at + this.quietMs > now) continue;
      for (const ch of this.statusChannels) void this.postStatus(ep, ch, kind);
    }
  }

  private cancelQuiet(ep: Episode): void {
    if (ep.quietTimer !== undefined) {
      this.timers.clearTimeout(ep.quietTimer);
      ep.quietTimer = undefined;
      ep.quietDue = undefined;
    }
  }

  private async replyIfDown(channelId: string): Promise<void> {
    const ep = this.agentEpisode();
    if (!ep || episodeTier(ep) !== 'reply') return;
    if (!this.mayReplyIn(channelId)) return;
    if (this.statusChannels.includes(channelId)) return;
    const last = ep.notified.get(channelId);
    const now = this.now();
    if (last !== undefined) {
      const until = primaryKind(ep).until;
      const announcedEndPassed = until !== undefined && until <= now;
      if (!announcedEndPassed || now - last < this.renotifyMs) return;
    }
    await this.postReply(ep, channelId);
  }

  private async replyToWaker(): Promise<void> {
    const ep = this.agentEpisode();
    const fw = this.failedWake;
    if (!ep || episodeTier(ep) !== 'reply' || !fw) return;
    if (this.now() - fw.at > this.wakerWindowMs) return;
    if (!this.mayReplyIn(fw.channelId) || this.statusChannels.includes(fw.channelId)) return;
    if (ep.notified.has(fw.channelId)) return;
    await this.postReply(ep, fw.channelId);
  }

  private async postStatus(ep: Episode, channelId: string, kind: string): Promise<void> {
    const k = ep.kinds.get(kind);
    if (!k) return;
    const heard = getSet(ep.statusHeard, channelId);
    let posting = ep.statusPosting.get(channelId);
    if (!posting) { posting = new Map(); ep.statusPosting.set(channelId, posting); }
    if (heard.has(kind) || posting.get(kind) === k.seq) return;
    posting.set(kind, k.seq);
    const subject = ep.key || this.config.agentName || 'the agent';
    const r = await this.post(channelId, statusNoticeText(subject, { kind, message: k.message, ...(k.until !== undefined ? { until: k.until } : {}) }), ep, { track: true, kind });
    if (posting.get(kind) === k.seq) posting.delete(kind);
    if (r.reflush) this.reflush(ep, channelId);
    if (!r.ok) return;
    const live = this.episodes.get(ep.key) === ep ? ep.kinds.get(kind) : undefined;
    if (live?.seq === k.seq) { heard.add(kind); return; }
    if (live) { this.scheduleStatus(ep); return; }
    const still = this.episodes.get(ep.key) === ep && ep.kinds.size > 0 ? primaryKind(ep).kind : undefined;
    void this.post(channelId, statusClearText(subject, kind, 'cleared while posting', still), ep, { track: false, owe: { key: ep.key, clearedKind: kind } });
  }

  private async postReply(ep: Episode, channelId: string): Promise<void> {
    const subject = ep.key || this.config.agentName || 'the agent';
    const primary = primaryKind(ep);
    ep.notified.set(channelId, this.now());
    ep.replyPosting.add(channelId);
    const r = await this.post(channelId, replyNoticeText(subject, primary), ep, { track: true, kind: primary.kind });
    ep.replyPosting.delete(channelId);
    if (!r.ok) ep.notified.delete(channelId);
    if (r.reflush) this.reflush(ep, channelId);
    if (!r.ok) return;
    const live = this.agentEpisode();
    if (live === ep && episodeTier(ep) === 'reply') return;
    ep.notified.delete(channelId);
    if (live && episodeTier(live) === 'reply') {
      if (!live.notified.has(channelId)) live.notified.set(channelId, this.now());
      return;
    }
    void this.post(channelId, replyClearText(subject), ep, { track: false, owe: { key: ep.key } });
  }

  private reflush(ep: Episode, channelId: string): void {
    if (this.episodes.get(ep.key) === ep) ep.pending.add(channelId);
    void this.flushPending();
  }

  private flushPending(): Promise<void> {
    const run = this.flushChain.then(() => this.doFlushPending());
    this.flushChain = run.catch(() => undefined);
    return run;
  }

  private async doFlushPending(): Promise<void> {
    await this.flushOwed();
    for (const ep of [...this.episodes.values()]) {
      for (const channelId of [...ep.pending]) {
        if (this.episodes.get(ep.key) !== ep) break;
        ep.pending.delete(channelId);
        if (this.statusChannels.includes(channelId)) {
          const now = this.now();
          for (const [kind, k] of [...ep.kinds]) {
            if (k.at + this.quietMs <= now) await this.postStatus(ep, channelId, kind);
          }
        } else {
          await this.replyIfDown(channelId);
        }
      }
    }
  }

  private async flushOwed(): Promise<void> {
    for (const channelId of [...this.owedLines.keys()]) {
      const lines = this.owedLines.get(channelId);
      if (!lines) continue;
      this.owedLines.delete(channelId);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (this.absorbIfOvertaken(channelId, line)) continue;
        const r = await this.post(channelId, line.text, undefined, { track: false, owe: false });
        if (r.ok) continue;
        const meanwhile = this.owedLines.get(channelId) ?? [];
        this.owedLines.set(channelId, [...lines.slice(i), ...meanwhile].slice(-OWED_LINES_CAP));
        break;
      }
    }
  }

  private absorbIfOvertaken(channelId: string, line: OwedLine): boolean {
    const ep = this.episodes.get(line.key);
    if (!ep) return false;
    if (line.clearedKind === undefined) {
      if (episodeTier(ep) !== 'reply') return false;
      if (!ep.notified.has(channelId)) ep.notified.set(channelId, this.now());
      return true;
    }
    if (!ep.kinds.has(line.clearedKind)) return false;
    getSet(ep.statusOwedClear, channelId).add(line.clearedKind);
    return true;
  }

  private owe(channelId: string, line: OwedLine): void {
    const owed = this.owedLines.get(channelId) ?? [];
    this.owedLines.set(channelId, [...owed, line].slice(-OWED_LINES_CAP));
  }

  private async post(
    channelId: string,
    text: string,
    ep: Episode | undefined,
    opts: { track: boolean; kind?: string; owe?: { key: string; clearedKind?: string } | false },
  ): Promise<{ ok: boolean; reflush: boolean }> {
    const registry = this.framework?.channels as Registry | undefined;
    if (!registry?.publishForAgent) return { ok: false, reflush: false };
    const epoch = this.reconnectEpoch;
    let result: PublishResult;
    try {
      result = await registry.publishForAgent(channelId, text, this.config.agentName ?? 'host');
    } catch (err) {
      result = { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (result.success) {
      ep?.pending.delete(channelId);
      if (ep && opts.track && opts.kind !== undefined && !COMPONENT_KINDS.has(opts.kind)) {
        const form = this.markerForm(opts.kind);
        if (!ep.markedForms.has(form)) {
          ep.markedForms.add(form);
          this.writeMarker(ep, channelId, text, opts.kind, form);
        }
      }
      return { ok: true, reflush: false };
    }
    const absent = result.reason !== undefined && PARKED_REFUSALS.has(result.reason);
    if (!absent) {
      console.error(`[notices] post to ${channelId} failed: ${result.error ?? 'unknown error'}`);
      return { ok: false, reflush: false };
    }
    const reflush = this.reconnectEpoch !== epoch;
    if (opts.track) {
      if (ep && this.episodes.get(ep.key) === ep) ep.pending.add(channelId);
      return { ok: false, reflush };
    }
    if (reflush) return this.post(channelId, text, ep, opts);
    if (opts.owe) this.owe(channelId, { text, ...opts.owe });
    return { ok: false, reflush: false };
  }

  private markerForm(kind: string): MarkerForm {
    return this.tierFor(kind) === 'reply' || CLOSES_ON_SUCCESS.has(kind) ? 'unanswered' : 'status';
  }

  private writeMarker(ep: Episode, channelId: string, text: string, kind: string, form: MarkerForm): void {
    if (!this.config.agentName) return;
    const marker = form === 'unanswered'
      ? `[host-notice] While you could not respond (${kind}), the host posted this in ${channelId}: "${text}"`
      : `[host-notice] The host posted this status notice in ${channelId} about ${kind}, for whoever runs ` +
        `it; nothing in it needs you to act: "${text}"`;
    try {
      const agent = this.framework?.getAgent(this.config.agentName);
      agent?.getContextManager().addMessage(
        'user',
        [{
          type: 'text',
          text: marker,
        }],
        { system: true, kind: 'host-notice', alertKind: kind, channelId } as unknown as Record<string, unknown>,
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
