/**
 * Speaks the bot side of melodeus-tts-relay's protocol (its PROTOCOL.md)
 * over one outbound WebSocket. The relay takes raw Discord channel ids, so
 * the MCPL composite id's last segment goes on the wire.
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
  TraceEvent,
} from '@animalabs/agent-framework';
import { unknownToolResult } from './unknown-tool.js';
import { hostNoteMetadata } from '../speaker.js';

export interface TtsRelayModuleConfig {
  url: string;
  token: string;
  botId?: string;
  userId?: string;
  username?: string;
  editServerId?: string;
  reconnectIntervalMs?: number;
  notifyOnInterruption?: boolean;
}

interface InterruptionEvent {
  channelId: string; // raw Discord snowflake
  spokenText: string;
  reason: 'user_speech' | 'manual' | 'timeout';
  timestamp: number;
}

class RelayBotClient {
  private ws: WebSocket | null = null;
  private authenticated = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;
  private onInterruptionHandler: ((event: InterruptionEvent) => void) | null = null;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly botId: string,
    private readonly reconnectIntervalMs: number,
  ) {}

  connect(): void {
    this.shouldReconnect = true;
    this.doConnect();
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.authenticated = false;
    if (this.ws) {
      try { this.ws.close(1000, 'module stopping'); } catch { }
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.authenticated;
  }

  onInterruption(handler: (event: InterruptionEvent) => void): void {
    this.onInterruptionHandler = handler;
  }

  emit(type: string, payload: Record<string, unknown>): void {
    if (!this.isConnected()) return;
    try {
      this.ws!.send(JSON.stringify({ type, botId: this.botId, ...payload, timestamp: Date.now() }));
    } catch (err) {
      console.error('[tts-relay] send failed:', err);
    }
  }

  private doConnect(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      console.error(`[tts-relay] cannot open ${this.url}:`, err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      try { ws.send(JSON.stringify({ type: 'auth', botId: this.botId, token: this.token })); }
      catch (err) { console.error('[tts-relay] auth send failed:', err); }
    };

    ws.onmessage = (ev: MessageEvent) => {
      let msg: { type?: string; error?: string } & Record<string, unknown>;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      switch (msg.type) {
        case 'auth_ok':
          this.authenticated = true;
          console.error(`[tts-relay] authenticated with ${this.url} as ${this.botId}`);
          break;
        case 'auth_error':
          console.error(`[tts-relay] AUTH FAILED (${msg.error}) — relay tap disabled until restart`);
          this.shouldReconnect = false;
          try { ws.close(); } catch { }
          break;
        case 'interruption':
          this.onInterruptionHandler?.({
            channelId: String(msg.channelId ?? ''),
            spokenText: String(msg.spokenText ?? ''),
            reason: (msg.reason as InterruptionEvent['reason']) ?? 'manual',
            timestamp: Number(msg.timestamp ?? Date.now()),
          });
          break;
        default:
          break;
      }
    };

    ws.onclose = () => {
      this.authenticated = false;
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // close follows, and onclose reconnects.
    };
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) this.doConnect();
    }, this.reconnectIntervalMs);
  }
}

interface ActivationState {
  mcplChannelId?: string;
  rawChannelId?: string;
  announced: boolean;
  /** Where its announcement fell, once announced. */
  order: number;
}

interface PublishedMessage {
  /** The agent whose prose this is, who is told when its voicing is cut off. */
  agentName: string;
  rawChannelId: string;
  mcplChannelId: string;
  messageId?: string;
  text: string;
  at: number;
}

/** How many of a channel's latest publishes are kept to match its next interruption. */
const PUBLISHED_PER_CHANNEL_MAX = 32;
/** How many channels' texts (their publishes, which are what the relay
 *  voices there) are kept: those of the channels published in last. */
const TEXT_CHANNELS_MAX = 32;
/** How many of the heard words' characters a published message must start with. */
const HEARD_PROBE_CHARS = 80;

/** The agents whose activations were announced in a channel since its last
 *  interruption, in the order they were first announced, and whether the
 *  channel has had one. */
interface VoicedInChannel {
  agents: Set<string>;
  interrupted: boolean;
}

function rawChannelId(mcplId: string): string {
  const ix = mcplId.lastIndexOf(':');
  return ix === -1 ? mcplId : mcplId.slice(ix + 1);
}

function commonPrefixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

function traceChannelId(event: unknown): string | undefined {
  const v = (event as { channelId?: unknown }).channelId;
  return typeof v === 'string' ? v : undefined;
}

const collapseWs = (s: string): string => s.replace(/\s+/g, ' ').trim();

export class TtsRelayModule implements Module {
  readonly name = 'tts-relay';

  private ctx: ModuleContext | null = null;
  private client: RelayBotClient | null = null;
  private offTrace: (() => void) | null = null;

  private activations = new Map<string, ActivationState>();
  /** The agents whose activations were announced in each raw channel since
   *  its last interruption: the relay voices a turn's messages after the turn
   *  has ended, so an interruption can come once its activation is gone, and
   *  while another agent's has started. Every channel voiced in keeps its
   *  voiced agents' names: one let go would name only an agent voiced there
   *  after it, though an earlier one's audio can still be queued. */
  private voicedIn = new Map<string, VoicedInChannel>();
  /** Each raw channel's latest PUBLISHED_PER_CHANNEL_MAX publishes since its
   *  last interruption, oldest first, while it is among the
   *  TEXT_CHANNELS_MAX channels published in last. */
  private published = new Map<string, PublishedMessage[]>();
  /** The channels whose texts are kept, the one published in longest ago first. */
  private textsKeptFor = new Set<string>();
  /** Orders the announced activations. */
  private order = 0;
  private unvoicedServers = new Set<string>();

  constructor(private readonly config: TtsRelayModuleConfig) {}

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;

    const botId = this.config.botId ?? ctx.getAgents()[0]?.name ?? 'connectome';
    this.client = new RelayBotClient(
      this.config.url,
      this.config.token,
      botId,
      this.config.reconnectIntervalMs ?? 5000,
    );
    this.client.onInterruption((ev) => {
      void this.handleInterruption(ev).catch((err) =>
        console.error('[tts-relay] interruption handling failed:', err));
    });
    this.client.connect();

    this.offTrace = ctx.onTrace((event) => {
      try { this.onTraceEvent(event); }
      catch (err) { console.error('[tts-relay] trace handler error:', err); }
    });
  }

  async stop(): Promise<void> {
    this.offTrace?.();
    this.offTrace = null;
    for (const agentName of [...this.activations.keys()]) this.endActivation(agentName, 'abort');
    this.client?.disconnect();
    this.client = null;
    this.voicedIn.clear();
    this.published.clear();
    this.textsKeptFor.clear();
    this.unvoicedServers.clear();
    this.ctx = null;
  }

  getTools(): ToolDefinition[] { return []; }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    return unknownToolResult(this, call.name);
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  private identity(agentName: string): { userId: string; username: string } {
    const username = this.config.username ?? agentName;
    const userId = this.config.userId ?? this.config.botId ?? agentName;
    return { userId, username };
  }

  private activation(agentName: string): ActivationState {
    let st = this.activations.get(agentName);
    if (!st) {
      st = { announced: false, order: 0 };
      this.activations.set(agentName, st);
    }
    return st;
  }

  private adoptChannel(st: ActivationState, agentName: string, mcplChannelId?: string): void {
    if (mcplChannelId && !st.mcplChannelId) {
      st.mcplChannelId = mcplChannelId;
      st.rawChannelId = rawChannelId(mcplChannelId);
    }
    if (!st.announced && st.rawChannelId) {
      st.announced = true;
      st.order = ++this.order;
      const voiced = this.voicedIn.get(st.rawChannelId) ?? { agents: new Set<string>(), interrupted: false };
      voiced.agents.add(agentName);
      this.voicedIn.set(st.rawChannelId, voiced);
      this.client?.emit('activation_start', {
        channelId: st.rawChannelId,
        ...this.identity(agentName),
      });
    }
  }

  /** `channel` was published in, which is what the relay voices. Past
   *  TEXT_CHANNELS_MAX channels, the publishes of the one published in
   *  longest ago are let go, and the names of the agents voiced there are
   *  kept. So its next interruption matches no message and edits nothing,
   *  and its note goes by those names (speakerOf). */
  private spokeIn(channel: string): void {
    this.textsKeptFor.delete(channel);
    this.textsKeptFor.add(channel);
    if (this.textsKeptFor.size <= TEXT_CHANNELS_MAX) return;
    const [oldest] = this.textsKeptFor;
    this.textsKeptFor.delete(oldest!);
    this.published.delete(oldest!);
  }

  private endActivation(agentName: string, reason: 'complete' | 'abort' | 'error'): void {
    const st = this.activations.get(agentName);
    this.activations.delete(agentName);
    if (!st?.announced || !st.rawChannelId) return;
    this.client?.emit('activation_end', {
      channelId: st.rawChannelId,
      ...this.identity(agentName),
      reason,
    });
  }

  private onTraceEvent(event: TraceEvent): void {
    switch (event.type) {
      case 'inference:published': {
        // The relay takes one server's raw channel ids, the server its edits go to.
        // Another server's channel id can cut down to the same raw id.
        if (event.serverId !== (this.config.editServerId ?? 'discord')) {
          this.logUnvoiced(event.serverId);
          break;
        }
        const content = event.text.replace(/^\n+/, '');
        if (!content.trim()) break;
        // mcpl:speech-routed also reports publishes that aren't this prose, so the
        // edit targets come from inference:published.
        const raw = rawChannelId(event.channelId);
        // Kept by channel: one ring for every channel let another
        // channel's traffic push out a publish an interruption here can
        // still match, so a match by two agents read as one agent's.
        const channel = this.published.get(raw) ?? [];
        channel.push({
          agentName: event.agentName,
          rawChannelId: raw,
          mcplChannelId: event.channelId,
          messageId: event.messageId,
          text: event.text,
          at: event.timestamp,
        });
        if (channel.length > PUBLISHED_PER_CHANNEL_MAX) channel.shift();
        this.published.set(raw, channel);
        this.spokeIn(raw);
        // Only published prose is voiced: agent-framework's contract for a
        // relay that voices the agent's prose. Each message is a whole text
        // block, so the client voices its last sentence when it's posted.
        const block = {
          channelId: raw,
          ...this.identity(event.agentName),
          blockIndex: event.index,
          blockType: 'text' as const,
        };
        this.client?.emit('block_start', block);
        this.client?.emit('chunk', { ...block, text: content, visible: true });
        this.client?.emit('block_complete', { ...block, content });
        break;
      }

      case 'inference:started': {
        // A context-budget restart emits inference:started again mid-turn.
        const st = this.activation(event.agentName);
        this.adoptChannel(st, event.agentName, traceChannelId(event));
        break;
      }

      // The model's text, thinking and tool calls as written aren't what was
      // published (an explicit-mode aside, a `>>` prefix, a held draft): the
      // token traces are read for the turn's channel only. So what an agent
      // wrote and didn't publish holds back no interruption's edit.
      case 'inference:tokens':
      case 'inference:content_block': {
        const st = this.activation(event.agentName);
        this.adoptChannel(st, event.agentName, traceChannelId(event));
        break;
      }

      case 'inference:completed':
      case 'inference:turn_ended':
        this.endActivation(event.agentName, 'complete');
        break;
      case 'inference:aborted':
        this.endActivation(event.agentName, 'abort');
        break;
      // inference:failed ends one attempt, not the turn: the framework then
      // retries it, holds it for a provider's wait, or ends it with
      // inference:exhausted or inference:aborted. Ending the activation there
      // would cancel the client's audio of what the turn already published.
      case 'inference:exhausted':
        this.endActivation(event.agentName, 'error');
        break;


      default:
        break;
    }
  }

  private logUnvoiced(serverId: string): void {
    if (this.unvoicedServers.has(serverId)) return;
    this.unvoicedServers.add(serverId);
    const voiced = this.config.editServerId === undefined
      ? "'discord', the default when modules.ttsRelay.editServerId is unset"
      : `'${this.config.editServerId}', which modules.ttsRelay.editServerId names`;
    console.error(
      `[tts-relay] messages published on server '${serverId}' aren't voiced: the relay voices only server ${voiced}. Later ones on '${serverId}' aren't logged.`,
    );
  }

  private async handleInterruption(ev: InterruptionEvent): Promise<void> {
    console.error(
      `[tts-relay] interruption in ${ev.channelId} (${ev.reason}): ${ev.spokenText.length} chars voiced`,
    );

    // What the relay voiced in the channel since its last interruption is
    // the messages published there (#317): another agent's voicing that the
    // heard words also start is one of `matched`, so no one is told.
    const matched = this.publishesHeard(ev);
    const target = this.interruptedMessage(ev, matched);
    const speaker = this.speakerOf(ev, matched);
    // An interruption ends its channel's voicing: what was published there
    // before it isn't heard in a later one. An activation still live there
    // goes on, and what it publishes there is voiced, so it is voiced there
    // since, in the order the activations were announced.
    const live = [...this.activations]
      .filter(([, st]) => st.announced && st.rawChannelId === ev.channelId)
      .sort(([, a], [, b]) => a.order - b.order)
      .map(([agent]) => agent);
    this.voicedIn.set(ev.channelId, { agents: new Set(live), interrupted: true });
    this.published.delete(ev.channelId);
    this.textsKeptFor.delete(ev.channelId);
    let edited = false;

    if (target?.messageId && ev.spokenText.trim().length > 0) {
      const result = await this.ctx!.callTool({
        id: `tts-relay-interrupt-${Date.now()}`,
        name: `mcpl--${this.config.editServerId ?? 'discord'}--edit_message`,
        input: {
          channelId: target.rawChannelId,
          messageId: target.messageId,
          content: ev.spokenText,
        },
      });
      edited = result.success === true;
      if (!edited) {
        console.error(`[tts-relay] edit_message failed for ${target.messageId}:`, result.error);
      }
    } else if (!target?.messageId) {
      console.error('[tts-relay] no published message matched the interruption — nothing edited');
    }

    // The note is for the agent that spoke (#291): with residents sharing a
    // slot, an untargeted note would be shown to every one of them, so one
    // whose speaker can't be named isn't written.
    if (this.config.notifyOnInterruption !== false) {
      if ('why' in speaker) {
        console.error(`[tts-relay] the interruption in ${ev.channelId} is told to no agent: ${speaker.why}`);
        return;
      }
      const note = edited
        ? `[voice] Your message was interrupted by ${ev.reason.replace('_', ' ')} — only this much was voiced, and the posted message was trimmed to match: "${ev.spokenText}"`
        : `[voice] Your reply was interrupted by ${ev.reason.replace('_', ' ')} after: "${ev.spokenText}" (the posted message could not be trimmed)`;
      this.ctx?.addMessage('user', [{ type: 'text', text: note }], hostNoteMetadata('voice-interruption'), { forAgent: speaker.agent });
    }
  }

  /** The agent an interruption cut off, or why none can be named. It is the
   *  author of the published messages the heard words start (`matched`);
   *  with none matched, the one voiced in the interruption's channel: the
   *  agent whose activation there is live or was announced there since the
   *  channel's last interruption (the relay voices a turn's messages after
   *  it ends).
   *  Matched messages by more than one agent name none, as do two or more
   *  agents voiced in the channel, and so does an agent that is no longer
   *  registered. */
  private speakerOf(ev: InterruptionEvent, matched: PublishedMessage[]): { agent: string } | { why: string } {
    const registered = new Set(this.ctx?.getAgents().map((agent) => agent.name) ?? []);
    const named = (agent: string, as: string): { agent: string } | { why: string } =>
      registered.has(agent) ? { agent } : { why: `${agent}, ${as}, is no longer registered` };
    if (matched.length > 0) {
      const authors = [...new Set([...matched].reverse().map((r) => r.agentName))];
      if (authors.length > 1) return { why: `the heard words start messages published by ${authors.join(', ')}` };
      return named(authors[0]!, 'whose published message it was matched to');
    }
    const live = [...this.activations]
      .filter(([, st]) => st.announced && st.rawChannelId === ev.channelId)
      .map(([agent]) => agent);
    const since = this.voicedIn.get(ev.channelId);
    const voiced = [...new Set([...(since?.agents ?? []), ...live])];
    const where = `in that channel${since?.interrupted ? ' since its previous interruption' : ''}`;
    if (voiced.length > 1) return { why: `no published message matched it, and ${voiced.join(', ')} were each voiced ${where}` };
    if (voiced.length === 0) return { why: `no published message matched it, and no agent was voiced ${where}` };
    return named(voiced[0]!, live.length === 1 ? 'voicing in that channel' : `voiced ${where}`);
  }

  /** The messages published in the interruption's channel since its previous
   *  interruption, its latest PUBLISHED_PER_CHANNEL_MAX while it is among the
   *  TEXT_CHANNELS_MAX channels published in last, whose text starts with the
   *  heard words' first HEARD_PROBE_CHARS characters, newest first.
   *  A publish they don't start is not taken: it would be edited to words it
   *  never said, and its author told of an interruption that cut off another
   *  agent. */
  private publishesHeard(ev: InterruptionEvent): PublishedMessage[] {
    const spoken = collapseWs(ev.spokenText);
    if (spoken.length === 0) return [];
    const probe = spoken.slice(0, HEARD_PROBE_CHARS);
    const matched: PublishedMessage[] = [];
    const channel = this.published.get(ev.channelId) ?? [];
    for (let i = channel.length - 1; i >= 0; i--) {
      const r = channel[i]!;
      if (collapseWs(r.text).startsWith(probe)) matched.push(r);
    }
    return matched;
  }

  /** Of `matched` (newest first), the one whose text shares the longest
   *  opening with the whole of the heard words, the newest of those that
   *  share as much; none when nothing matched. */
  private interruptedMessage(ev: InterruptionEvent, matched: PublishedMessage[]): PublishedMessage | null {
    const spoken = collapseWs(ev.spokenText);
    let best: PublishedMessage | null = null;
    let bestShared = -1;
    for (const r of matched) {
      const shared = commonPrefixLength(collapseWs(r.text), spoken);
      if (shared > bestShared) { best = r; bestShared = shared; }
    }
    return best;
  }
}
