/**
 * ActivityModule — surfaces agent composition activity (typing indicators)
 * to a configurable set of MCPL channels while inference is active.
 *
 * Recipe-seeded initial channels; agent can add/remove at runtime via tools.
 * State persists via Chronicle. Typing refresh is owned by the framework's
 * ChannelRegistry (~7s interval, matches Discord/Zulip expiry).
 *
 * Jam notices (opt-in, `modules.activity.jamNotices`): when the host is
 * jammed — spent subscription quota, expired/rejected credential, pending
 * login, hard-down — a subscribed channel that receives a message gets ONE
 * host-attributed "cannot respond right now" line per episode, and one
 * "back" line when the jam clears. The people who pinged the agent would
 * otherwise see nothing at all: a parked or failing inference never starts,
 * so not even the typing indicator appears. Channels with no traffic during
 * the jam get nothing.
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
  WorkspaceModule,
} from '@animalabs/agent-framework';
import { open } from 'node:fs/promises';

export interface ActivityModuleConfig {
  initialChannels?: string[];
  /** Post host-attributed jam notices into active subscribed channels. */
  jamNotices?: boolean;
  /** The agent whose activity this is (alerts for other agents are ignored). */
  agentName?: string;
  now?: () => number;
}

/** Alert kinds that mean "the agent cannot answer right now". `provider-hold`
 *  is reserved for a framework that announces its holds. */
export const JAM_KINDS: ReadonlySet<string> = new Set([
  'quota-spent', 'auth-expired', 'auth-rejected', 'auth-login-required', 'hard-down', 'provider-hold',
]);

/** A channel notified this long ago may be told again if the jam persists
 *  past its announced end (or has none). */
const RENOTIFY_MS = 30 * 60_000;

interface JamEpisode {
  kind: string;
  message: string;
  since: number;
  until?: number;
  /** channelId → epoch ms of the last notice posted there. */
  notified: Map<string, number>;
  markerWritten: boolean;
}

/** Plain words for the channel, by alert kind. */
function jamReason(kind: string, message: string): string {
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

export function jamNoticeText(agent: string, jam: { kind: string; message: string; until?: number }): string {
  const when = jam.until !== undefined ? ` Expected back after ${fmtUntil(jam.until)}.` : '';
  return `⚠ [host notice] ${agent} cannot respond right now: ${jamReason(jam.kind, jam.message)}.${when} An operator has been alerted.`;
}

export function jamClearText(agent: string): string {
  return `✓ [host notice] ${agent} can respond again.`;
}

interface ActivityState {
  channels: string[];
}

/**
 * Parse a loose origin hint out of a file's top lines. Used when an inference
 * is triggered by a workspace file rather than an incoming channel message:
 * if the file's head declares the conversation it's replying to, we route the
 * typing indicator to that topic. Returns null if no hint is found.
 *
 * Recognized shapes:
 *   - `origin: zulip#<channel>#<topic>`
 *   - `reply-to: zulip:<channel>/<topic>`
 *   - YAML frontmatter (delimited by leading `---` ... `---`) containing both
 *     `channel: <name>` and `topic: <name>` — matches the clerk's existing
 *     knowledge-request ticket convention. Loose `channel:`/`topic:` lines
 *     outside a frontmatter block are ignored to avoid mis-routing on prose
 *     files (e.g. README headings, mined artifacts quoting Zulip metadata).
 *
 * All platform hints currently resolve to `zulip:<channel>` — extend here when
 * another MCPL server wants in on origin-routing.
 */
function parseOriginHint(text: string): { channelId: string; topic: string } | null {
  const compact = text.match(/origin:\s*zulip#([^\s#]+)#(\S+)/i);
  if (compact) return { channelId: `zulip:${compact[1]}`, topic: compact[2] };

  const replyTo = text.match(/reply-to:\s*zulip:([^\s/]+)\/(\S+)/i);
  if (replyTo) return { channelId: `zulip:${replyTo[1]}`, topic: replyTo[2] };

  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (frontmatter) {
    const block = frontmatter[1];
    const channelMatch = block.match(/^channel:\s*(\S+)\s*$/m);
    const topicMatch = block.match(/^topic:\s*(.+?)\s*$/m);
    if (channelMatch && topicMatch) {
      return { channelId: `zulip:${channelMatch[1]}`, topic: topicMatch[1] };
    }
  }

  return null;
}

export class ActivityModule implements Module {
  readonly name = 'activity';

  private ctx: ModuleContext | null = null;
  private framework: AgentFramework | null = null;
  private channels = new Set<string>();
  private typingActive = false;
  private jam: JamEpisode | null = null;
  private readonly now: () => number;

  /** Most recent incoming-message metadata per channel. Handed back to the
   *  originating server on each typing notification so routing hints (e.g.
   *  Zulip topic) land where the conversation is active. */
  private lastMetadata = new Map<string, Record<string, unknown>>();

  constructor(private readonly config: ActivityModuleConfig = {}) {
    this.now = config.now ?? Date.now;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;

    const saved = ctx.getState<ActivityState>();
    if (saved?.channels) {
      this.channels = new Set(saved.channels);
    } else if (this.config.initialChannels && this.config.initialChannels.length > 0) {
      this.channels = new Set(this.config.initialChannels);
      this.persist();
    }
  }

  async stop(): Promise<void> {
    this.stopAllTyping();
    this.ctx = null;
    this.framework = null;
  }

  /** Called from the host after framework creation, like SubagentModule. */
  setFramework(framework: AgentFramework): void {
    this.framework = framework;
    framework.onTrace((event: TraceEvent) => {
      if (event.type === 'inference:started') this.onInferenceStarted();
      else if (event.type === 'inference:completed') this.onInferenceCompleted();
      // A failed or exhausted turn ends composition too; leaving the
      // indicator on would show "typing…" over an agent that produced nothing.
      else if (event.type === 'inference:failed' || event.type === 'inference:exhausted') this.onInferenceCompleted();
      else if (event.type === 'ops:alert') this.onOpsAlert(event as unknown as Record<string, unknown>);
    });
  }

  /** Current jam episode, for tests and the panel. */
  jamState(): { kind: string; since: number; until?: number; notified: string[] } | null {
    if (!this.jam) return null;
    return { kind: this.jam.kind, since: this.jam.since, ...(this.jam.until !== undefined ? { until: this.jam.until } : {}), notified: [...this.jam.notified.keys()] };
  }

  private onOpsAlert(event: Record<string, unknown>): void {
    if (!this.config.jamNotices) return;
    const kind = typeof event.kind === 'string' ? event.kind : '';
    const agent = typeof event.agentName === 'string' ? event.agentName : '';
    if (this.config.agentName && agent && agent !== this.config.agentName) return;
    if (kind.endsWith('-clear')) {
      const base = kind.slice(0, -'-clear'.length);
      if (!this.jam || this.jam.kind !== base) return;
      // Superseded (auth-expiring → auth-expired) is not recovery: the next
      // alert re-arms the episode; only a clear to "ok" posts the all-clear.
      const message = typeof event.message === 'string' ? event.message : '';
      const superseded = /^superseded by /.test(message);
      const notified = [...this.jam.notified.keys()];
      this.jam = null;
      if (superseded || notified.length === 0) return;
      const who = this.config.agentName ?? agent ?? 'the agent';
      for (const channelId of notified) void this.post(channelId, jamClearText(who));
      return;
    }
    if (!JAM_KINDS.has(kind)) return;
    const data = (event.data ?? {}) as { until?: unknown };
    const until = typeof data.until === 'number' && Number.isFinite(data.until) ? data.until : undefined;
    const message = typeof event.message === 'string' ? event.message : '';
    if (this.jam && this.jam.kind === kind) {
      this.jam.message = message;
      this.jam.until = until;
      return;
    }
    // A different jam kind starts a new episode; channels told about the old
    // one are told again only when they are active again.
    this.jam = { kind, message, since: this.now(), until, notified: new Map(), markerWritten: false };
  }

  /** Incoming traffic on a subscribed channel while jammed: say so, once. */
  private async noticeIfJammed(channelId: string): Promise<void> {
    const jam = this.jam;
    if (!jam || !this.config.jamNotices || !this.channels.has(channelId)) return;
    const last = jam.notified.get(channelId);
    const now = this.now();
    if (last !== undefined) {
      const pastEnd = jam.until === undefined || jam.until <= now;
      if (!pastEnd || now - last < RENOTIFY_MS) return;
    }
    jam.notified.set(channelId, now);
    const who = this.config.agentName ?? 'the agent';
    const text = jamNoticeText(who, jam);
    const ok = await this.post(channelId, text);
    if (!ok) {
      jam.notified.delete(channelId);
      return;
    }
    if (!jam.markerWritten) {
      jam.markerWritten = true;
      this.writeMarker(jam, channelId, text);
    }
  }

  private async post(channelId: string, text: string): Promise<boolean> {
    const registry = this.framework?.channels as
      | { publishForAgent?: (channelId: string, text: string, agentName: string) => Promise<{ success: boolean; error?: string }> }
      | undefined;
    if (!registry?.publishForAgent) return false;
    try {
      const result = await registry.publishForAgent(channelId, text, this.config.agentName ?? 'host');
      if (!result.success) console.error(`[activity] jam notice to ${channelId} failed: ${result.error ?? 'unknown error'}`);
      return result.success;
    } catch (err) {
      console.error(`[activity] jam notice to ${channelId} failed:`, err instanceof Error ? err.message : err);
      return false;
    }
  }

  /** One chronicle marker per episode so the agent learns, on recovery,
   *  that the host spoke in its channel while it could not. System-flagged:
   *  no inference is requested (same as the framework's own markers). */
  private writeMarker(jam: JamEpisode, channelId: string, text: string): void {
    if (!this.config.agentName) return;
    try {
      const agent = this.framework?.getAgent(this.config.agentName);
      agent?.getContextManager().addMessage(
        'user',
        [{
          type: 'text',
          text: `[host-notice] While you could not respond (${jam.kind}), the host posted this in ${channelId}: "${text}"`,
        }],
        { system: true, kind: 'host-notice', jamKind: jam.kind, channelId } as unknown as Record<string, unknown>,
      );
    } catch (err) {
      console.error('[activity] could not record the jam-notice marker:', err instanceof Error ? err.message : err);
    }
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'show_in',
        description:
          'Subscribe a channel to your composition-activity indicator (e.g. Zulip "is typing"). ' +
          'This is a SET-AND-FORGET POLICY — call it once to opt a channel in, and the host will ' +
          'automatically start the indicator before each inference and stop it when the inference ' +
          'ends. You do NOT need to call this before each reply. Do NOT bracket messages with ' +
          'show_in / send / hide_in — that pattern produces confusing UX because message sends ' +
          'do not clear Zulip typing indicators, so you end up flashing your own indicator on and ' +
          'off unnecessarily. Use hide_in only if you want to permanently stop indicating in that ' +
          'channel. Channel IDs use the MCPL format, e.g. "zulip:tracker-miner-f". Idempotent.',
        inputSchema: {
          type: 'object',
          properties: {
            channel: { type: 'string', description: 'MCPL channel id' },
          },
          required: ['channel'],
        },
      },
      {
        name: 'hide_in',
        description:
          'Unsubscribe a channel from your composition-activity indicator. Use this ONLY when you ' +
          'want to PERMANENTLY stop surfacing your activity in that channel (e.g. if a user asks ' +
          'you to, or you decide the channel should no longer see your thinking). Do NOT call this ' +
          'after sending a message in a normal reply flow — the host already stops the indicator ' +
          "when inference completes. Doesn't affect other channels. Idempotent.",
        inputSchema: {
          type: 'object',
          properties: {
            channel: { type: 'string', description: 'MCPL channel id' },
          },
          required: ['channel'],
        },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    const channel = typeof (call.input as { channel?: unknown }).channel === 'string'
      ? ((call.input as { channel: string }).channel)
      : null;
    if (!channel) {
      return { success: false, isError: true, error: 'channel (string) is required' };
    }

    if (call.name === 'show_in') {
      const added = !this.channels.has(channel);
      this.channels.add(channel);
      this.persist();
      if (this.typingActive) {
        this.framework?.channels?.startTyping(channel, this.lastMetadata.get(channel));
      }
      return {
        success: true,
        data: added
          ? `Now showing composition activity in ${channel}.`
          : `Already showing composition activity in ${channel}.`,
      };
    }

    if (call.name === 'hide_in') {
      const removed = this.channels.delete(channel);
      this.persist();
      this.framework?.channels?.stopTyping(channel);
      return {
        success: true,
        data: removed
          ? `No longer showing composition activity in ${channel}.`
          : `Was not showing composition activity in ${channel}.`,
      };
    }

    return { success: false, isError: true, error: `Unknown tool: ${call.name}` };
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    // Track the most recent incoming-message metadata per channel so typing
    // notifications can echo it back to the originating server as routing hints.
    if (event.type === 'mcpl:channel-incoming') {
      const e = event as unknown as {
        channelId: string;
        threadId?: string;
        metadata?: Record<string, unknown>;
      };
      const merged: Record<string, unknown> = { ...(e.metadata ?? {}) };
      if (e.threadId !== undefined && merged.threadId === undefined) {
        merged.threadId = e.threadId;
      }
      this.lastMetadata.set(e.channelId, merged);
      await this.noticeIfJammed(e.channelId);
    }
    // Workspace-triggered inferences have no incoming-message metadata, so
    // peek at the file's head for an origin hint and populate routing metadata
    // if found. Best-effort; failures are silent.
    else if (event.type === 'workspace:created' || event.type === 'workspace:modified') {
      const e = event as unknown as { paths: string[] };
      await this.extractOriginFromFiles(e.paths);
    }
    return {};
  }

  private async extractOriginFromFiles(mountPaths: string[]): Promise<void> {
    const workspace = this.ctx?.getModule<WorkspaceModule>('workspace');
    if (!workspace) return;

    for (const mountPath of mountPaths) {
      const abs = workspace.resolveAbsolutePath(mountPath);
      if (!abs) continue;

      try {
        const fd = await open(abs, 'r');
        try {
          const buf = Buffer.alloc(2048);
          const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
          const head = buf.toString('utf8', 0, bytesRead);

          const origin = parseOriginHint(head);
          if (origin && this.channels.has(origin.channelId)) {
            // Merge with any existing metadata so other keys (e.g. senderEmail)
            // survive if the origin refresh is subsequent to an incoming message.
            const prior = this.lastMetadata.get(origin.channelId) ?? {};
            this.lastMetadata.set(origin.channelId, { ...prior, topic: origin.topic });
          }
        } finally {
          await fd.close();
        }
      } catch {
        // File unreadable / gone / etc. — silently skip.
      }
    }
  }

  private onInferenceStarted(): void {
    this.typingActive = true;
    const registry = this.framework?.channels;
    if (!registry) return;
    for (const ch of this.channels) {
      registry.startTyping(ch, this.lastMetadata.get(ch));
    }
  }

  private onInferenceCompleted(): void {
    this.typingActive = false;
    this.stopAllTyping();
  }

  private stopAllTyping(): void {
    const registry = this.framework?.channels;
    if (!registry) return;
    for (const ch of this.channels) registry.stopTyping(ch);
  }

  private persist(): void {
    this.ctx?.setState<ActivityState>({ channels: [...this.channels] });
  }
}
