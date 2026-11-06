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

type BlockType = 'text' | 'thinking' | 'tool_call' | 'tool_result';

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
  blocks: Map<number, string>;
  /** Its text blocks' tokens so far, which the relay voices. */
  said: string;
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
  /** Where it falls among the relay's publishes and announced activations. */
  order: number;
}

/** How many of a channel's latest publishes are kept to match its next interruption. */
const PUBLISHED_PER_CHANNEL_MAX = 32;
/** How many channels' texts (their publishes, and what was voiced there) are
 *  kept: those of the channels spoken in last. */
const TEXT_CHANNELS_MAX = 32;
/** How many of the heard words' characters a published message must start with. */
const HEARD_PROBE_CHARS = 80;

/** The agents whose activations were announced in a channel since its last
 *  interruption, in the order they were first announced, what each one's
 *  latest such activation said (its text blocks) while the channel's texts
 *  are kept (TEXT_CHANNELS_MAX), and whether the channel has had one. */
interface VoicedInChannel {
  agents: Set<string>;
  said: Map<string, Said>;
  interrupted: boolean;
}

/** An activation's text, and where its announcement fell (PublishedMessage.order). */
interface Said {
  text: string;
  order: number;
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
   *  its last interruption: the relay voices a turn's chunks after the turn
   *  has ended, so an interruption can come once its activation is gone, and
   *  while another agent's has started. Every channel voiced in keeps its
   *  voiced agents' names: one let go would name only an agent voiced there
   *  after it, though an earlier one's audio can still be queued. Each
   *  agent's latest activation text there is kept only while the channel is
   *  among the TEXT_CHANNELS_MAX spoken in last (spokeIn). */
  private voicedIn = new Map<string, VoicedInChannel>();
  /** Each raw channel's latest PUBLISHED_PER_CHANNEL_MAX publishes since its
   *  last interruption, oldest first, while it is among the
   *  TEXT_CHANNELS_MAX channels spoken in last. */
  private published = new Map<string, PublishedMessage[]>();
  /** The channels whose texts are kept, the one spoken in longest ago first. */
  private textsKeptFor = new Set<string>();
  /** Orders the publishes and the announced activations. */
  private order = 0;

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
    this.client?.disconnect();
    this.client = null;
    this.activations.clear();
    this.voicedIn.clear();
    this.published.clear();
    this.textsKeptFor.clear();
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
      st = { announced: false, blocks: new Map(), said: '', order: 0 };
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
      const voiced = this.voicedIn.get(st.rawChannelId) ?? { agents: new Set<string>(), said: new Map<string, Said>(), interrupted: false };
      voiced.agents.add(agentName);
      this.voicedIn.set(st.rawChannelId, voiced);
      this.client?.emit('activation_start', {
        channelId: st.rawChannelId,
        ...this.identity(agentName),
      });
    }
  }

  /** `channel` was spoken in: a publish there, or an activation's end. Past
   *  TEXT_CHANNELS_MAX channels, the texts of the one spoken in longest ago
   *  are let go, its publishes and what was voiced there together, and the
   *  names of the agents voiced there are kept. So its next interruption
   *  matches no message and edits nothing, and its note goes by those names
   *  (speakerOf). A publish still kept never lacks a later activation's text
   *  (voicedAfter): the texts of a channel go only all at once. */
  private spokeIn(channel: string): void {
    this.textsKeptFor.delete(channel);
    this.textsKeptFor.add(channel);
    if (this.textsKeptFor.size <= TEXT_CHANNELS_MAX) return;
    const [oldest] = this.textsKeptFor;
    this.textsKeptFor.delete(oldest!);
    this.published.delete(oldest!);
    this.voicedIn.get(oldest!)?.said.clear();
  }

  private endActivation(agentName: string, reason: 'complete' | 'abort' | 'error'): void {
    const st = this.activations.get(agentName);
    this.activations.delete(agentName);
    if (!st?.announced || !st.rawChannelId) return;
    const voiced = this.voicedIn.get(st.rawChannelId);
    if (voiced) {
      voiced.said.set(agentName, { text: st.said, order: st.order });
      this.spokeIn(st.rawChannelId);
    }
    this.client?.emit('activation_end', {
      channelId: st.rawChannelId,
      ...this.identity(agentName),
      reason,
    });
  }

  private onTraceEvent(event: TraceEvent): void {
    switch (event.type) {
      case 'inference:published': {
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
          order: ++this.order,
        });
        if (channel.length > PUBLISHED_PER_CHANNEL_MAX) channel.shift();
        this.published.set(raw, channel);
        this.spokeIn(raw);
        break;
      }

      case 'inference:started': {
        // A context-budget restart emits inference:started again mid-turn.
        const st = this.activation(event.agentName);
        this.adoptChannel(st, event.agentName, traceChannelId(event));
        break;
      }

      case 'inference:tokens': {
        const st = this.activation(event.agentName);
        this.adoptChannel(st, event.agentName, traceChannelId(event));
        if (!st.rawChannelId) break;
        st.blocks.set(event.blockIndex, (st.blocks.get(event.blockIndex) ?? '') + event.content);
        if (event.blockType === 'text') st.said += event.content;
        this.client?.emit('chunk', {
          channelId: st.rawChannelId,
          ...this.identity(event.agentName),
          text: event.content,
          blockIndex: event.blockIndex,
          blockType: event.blockType as BlockType,
          visible: event.blockType === 'text',
        });
        break;
      }

      case 'inference:content_block': {
        const st = this.activation(event.agentName);
        this.adoptChannel(st, event.agentName, traceChannelId(event));
        if (!st.rawChannelId) break;
        const base = {
          channelId: st.rawChannelId,
          ...this.identity(event.agentName),
          blockIndex: event.blockIndex,
          blockType: event.blockType as BlockType,
        };
        if (event.phase === 'block_start') {
          this.client?.emit('block_start', base);
        } else {
          // inference:content_block carries no content.
          const content = st.blocks.get(event.blockIndex) ?? '';
          st.blocks.delete(event.blockIndex);
          this.client?.emit('block_complete', { ...base, content });
        }
        break;
      }

      case 'inference:completed':
      case 'inference:turn_ended':
        this.endActivation(event.agentName, 'complete');
        break;
      case 'inference:aborted':
        this.endActivation(event.agentName, 'abort');
        break;
      case 'inference:failed':
      case 'inference:exhausted':
        this.endActivation(event.agentName, 'error');
        break;


      default:
        break;
    }
  }

  private async handleInterruption(ev: InterruptionEvent): Promise<void> {
    console.error(
      `[tts-relay] interruption in ${ev.channelId} (${ev.reason}): ${ev.spokenText.length} chars voiced`,
    );

    const matched = this.publishesHeard(ev);
    const best = this.interruptedMessage(ev, matched);
    // Heard words that start what another agent voiced in the channel after
    // the message could be that agent's: the message isn't trimmed to them,
    // and neither agent is told.
    const voicedAfter = best ? this.voicedAfter(ev, best) : [];
    const target = voicedAfter.length > 0 ? null : best;
    const speaker = voicedAfter.length > 0
      ? { why: `the heard words start a message published by ${best!.agentName} and what ${voicedAfter.join(', ')} voiced in that channel after it` }
      : this.speakerOf(ev, matched);
    // An interruption ends its channel's voicing: what was published there
    // before it isn't heard in a later one.
    this.voicedIn.set(ev.channelId, { agents: new Set(), said: new Map(), interrupted: true });
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
    } else if (voicedAfter.length > 0) {
      console.error(`[tts-relay] the heard words start ${best!.messageId ?? 'a published message'} and what ${voicedAfter.join(', ')} voiced after it — nothing edited`);
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
   *  channel's last interruption (the relay voices a turn after it ends).
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
   *  TEXT_CHANNELS_MAX channels spoken in last, whose text starts with the
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

  /** The agents other than `message`'s author whose activation in the
   *  interruption's channel was announced after `message` was published,
   *  since the channel's previous interruption, and whose text so far starts
   *  with the heard words' first HEARD_PROBE_CHARS characters: each live
   *  activation's, and each agent's latest that has ended. The relay can't
   *  tell which of these was being voiced. */
  private voicedAfter(ev: InterruptionEvent, message: PublishedMessage): string[] {
    const probe = collapseWs(ev.spokenText).slice(0, HEARD_PROBE_CHARS);
    const said = new Map(this.voicedIn.get(ev.channelId)?.said ?? []);
    for (const [agent, st] of this.activations) {
      if (st.announced && st.rawChannelId === ev.channelId) said.set(agent, { text: st.said, order: st.order });
    }
    return [...said]
      .filter(([agent, s]) => agent !== message.agentName && s.order > message.order && collapseWs(s.text).startsWith(probe))
      .map(([agent]) => agent);
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
