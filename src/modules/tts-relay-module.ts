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

const PUBLISHED_RING_MAX = 32;
/** How many channels' last voiced agent is kept (voicedIn), the oldest let go first. */
const VOICED_CHANNELS_MAX = 32;

function rawChannelId(mcplId: string): string {
  const ix = mcplId.lastIndexOf(':');
  return ix === -1 ? mcplId : mcplId.slice(ix + 1);
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
  /** The agent whose activation was last announced in each raw channel: the
   *  relay voices a turn's chunks after the turn has ended, so an
   *  interruption can come once its activation is gone. */
  private voicedIn = new Map<string, string>();
  private published: PublishedMessage[] = [];

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
    this.published = [];
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
      st = { announced: false, blocks: new Map() };
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
      this.voicedIn.delete(st.rawChannelId);
      this.voicedIn.set(st.rawChannelId, agentName);
      if (this.voicedIn.size > VOICED_CHANNELS_MAX) this.voicedIn.delete(this.voicedIn.keys().next().value!);
      this.client?.emit('activation_start', {
        channelId: st.rawChannelId,
        ...this.identity(agentName),
      });
    }
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
        // mcpl:speech-routed also reports publishes that aren't this prose, so the
        // edit targets come from inference:published.
        this.published.push({
          agentName: event.agentName,
          rawChannelId: rawChannelId(event.channelId),
          mcplChannelId: event.channelId,
          messageId: event.messageId,
          text: event.text,
          at: event.timestamp,
        });
        if (this.published.length > PUBLISHED_RING_MAX) {
          this.published.splice(0, this.published.length - PUBLISHED_RING_MAX);
        }
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

    const target = this.findInterruptedMessage(ev);
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
      const speaker = this.speakerOf(ev, target);
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
   *  one whose published message the interruption was matched to; with none
   *  matched, the one voicing in the interruption's channel: the agent whose
   *  activation there is live, or, with none live, the one whose activation
   *  was last announced there (the relay voices a turn after it ends). Two
   *  live activations in the channel name none, and so does an agent that
   *  is no longer registered. */
  private speakerOf(ev: InterruptionEvent, target: PublishedMessage | null): { agent: string } | { why: string } {
    const registered = new Set(this.ctx?.getAgents().map((agent) => agent.name) ?? []);
    const named = (agent: string, as: string): { agent: string } | { why: string } =>
      registered.has(agent) ? { agent } : { why: `${agent}, ${as}, is no longer registered` };
    if (target) return named(target.agentName, 'whose published message it was matched to');
    const live = [...this.activations]
      .filter(([, st]) => st.announced && st.rawChannelId === ev.channelId)
      .map(([agent]) => agent);
    if (live.length > 1) return { why: `no published message matched it, and ${live.join(', ')} are each voicing in that channel` };
    const voiced = live[0] ?? this.voicedIn.get(ev.channelId);
    if (voiced === undefined) return { why: 'no published message matched it, and no agent was voiced in that channel' };
    return named(voiced, live.length === 1 ? 'voicing in that channel' : 'the last voiced in that channel');
  }

  /** The latest message published in the interruption's channel whose text
   *  the heard words start, or none. A publish the words don't start is not
   *  taken: it would be edited to words it never said, and its author told
   *  of an interruption that cut off another agent. */
  private findInterruptedMessage(ev: InterruptionEvent): PublishedMessage | null {
    const spoken = collapseWs(ev.spokenText);
    if (spoken.length === 0) return null;
    const probe = spoken.slice(0, 80);
    for (let i = this.published.length - 1; i >= 0; i--) {
      const r = this.published[i]!;
      if (r.rawChannelId === ev.channelId && collapseWs(r.text).startsWith(probe)) return r;
    }
    return null;
  }
}
