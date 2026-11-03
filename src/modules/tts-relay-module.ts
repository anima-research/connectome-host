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
  rawChannelId: string;
  mcplChannelId: string;
  messageId?: string;
  text: string;
  at: number;
}

const PUBLISHED_RING_MAX = 32;

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
  private published: PublishedMessage[] = [];
  private agentName: string | null = null;

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
    this.agentName ??= agentName;
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

    if (this.config.notifyOnInterruption !== false) {
      const note = edited
        ? `[voice] Your message was interrupted by ${ev.reason.replace('_', ' ')} — only this much was voiced, and the posted message was trimmed to match: "${ev.spokenText}"`
        : `[voice] Your reply was interrupted by ${ev.reason.replace('_', ' ')} after: "${ev.spokenText}" (the posted message could not be trimmed)`;
      this.ctx?.addMessage('user', [{ type: 'text', text: note }], hostNoteMetadata('voice-interruption'));
    }
  }

  private findInterruptedMessage(ev: InterruptionEvent): PublishedMessage | null {
    const inChannel = this.published.filter((r) => r.rawChannelId === ev.channelId).reverse();
    if (inChannel.length === 0) return null;
    const spoken = collapseWs(ev.spokenText);
    if (spoken.length > 0) {
      const probe = spoken.slice(0, 80);
      const match = inChannel.find((r) => collapseWs(r.text).startsWith(probe));
      if (match) return match;
    }
    return inChannel[0];
  }
}
