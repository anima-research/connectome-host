/**
 * TtsRelayModule — streams the agent's live generation to a melodeus-tts-relay
 * server so voice clients (Melodeus, the iOS app) can speak it as it's born.
 *
 * Pure trace-bus tap (docs/observability.md spirit: traces are the outbound
 * wire, they never drive agent logic). The module subscribes to the framework's
 * existing streaming traces and re-emits the relay's bot-side protocol
 * (melodeus-tts-relay/PROTOCOL.md) over one outbound WebSocket:
 *
 *   inference:started                  → activation_start
 *   inference:tokens                   → chunk        (visible = blockType 'text')
 *   inference:content_block            → block_start / block_complete
 *   inference:completed                → activation_end reason 'complete'
 *   inference:aborted                  → activation_end reason 'abort'
 *   inference:failed / :exhausted      → activation_end reason 'error'
 *
 * Channel tagging rides the turn-frozen locus the framework already stamps on
 * those traces (`channelId`, the MCPL composite id). The relay speaks raw
 * Discord snowflakes, so the composite's last segment is what goes on the wire.
 * `block_complete.content` is reconstructed here by accumulating that block's
 * chunks — the trace deliberately doesn't duplicate block content.
 *
 * Interruptions (the one inbound message): a voice client reports the words
 * actually voiced before the user spoke over them. Unlike ChapterX — which
 * aborts the in-flight stream and substitutes spokenText as the completion —
 * connectome posts prose at tool-round boundaries, so the message is usually
 * already on Discord. We therefore EDIT it down to the voiced words (matching
 * the interruption against recent `mcpl:speech-routed` traces, which carry
 * channelId + messageId + text) via the discord MCPL's edit_message tool, and
 * drop a note into the agent's context so she knows she was cut off — the
 * next turn shouldn't believe the full paragraph landed.
 *
 * Nothing here touches the host loop: remove the recipe block and the tap is
 * gone. No tools are exposed to the agent (v1).
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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface TtsRelayModuleConfig {
  /** Relay bot endpoint, e.g. "ws://localhost:8800/bot". */
  url: string;
  /** Shared secret for the relay's /bot auth (BOT_TOKENS). `${VAR}` it. */
  token: string;
  /** Relay-side bot identifier. Defaults to the agent's name at first trace. */
  botId?: string;
  /** Discord user id to stamp on stream events (voice-config mapping key on
   *  the client side). Defaults to botId. */
  userId?: string;
  /** Display name stamped on stream events. Defaults to the agent's name. */
  username?: string;
  /** MCPL server id owning edit_message for interruption edits. Default 'discord'. */
  editServerId?: string;
  reconnectIntervalMs?: number;
  /** Drop a context note when an interruption truncates a posted message.
   *  Default true. */
  notifyOnInterruption?: boolean;
}

// ---------------------------------------------------------------------------
// Relay wire types (bot side of melodeus-tts-relay/PROTOCOL.md)
// ---------------------------------------------------------------------------

type BlockType = 'text' | 'thinking' | 'tool_call' | 'tool_result';

interface InterruptionEvent {
  channelId: string; // raw Discord snowflake
  spokenText: string;
  reason: 'user_speech' | 'manual' | 'timeout';
  timestamp: number;
}

/**
 * Minimal WebSocket client for the relay's /bot endpoint. Ported from
 * chatperx/src/tts/relay-client.ts, WHATWG-ified (Bun's global WebSocket —
 * no `ws` dependency). Auto-reconnects except after an auth failure; every
 * send is fire-and-forget and drops silently while disconnected (the relay
 * spec's own semantics: no queueing).
 */
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
      try { this.ws.close(1000, 'module stopping'); } catch { /* already closed */ }
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.authenticated;
  }

  onInterruption(handler: (event: InterruptionEvent) => void): void {
    this.onInterruptionHandler = handler;
  }

  /** Send a typed relay message; botId + timestamp are stamped here. */
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
          // Bad token won't heal by retrying — stop, loudly.
          console.error(`[tts-relay] AUTH FAILED (${msg.error}) — relay tap disabled until restart`);
          this.shouldReconnect = false;
          try { ws.close(); } catch { /* noop */ }
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
          break; // unknown relay message — ignore
      }
    };

    ws.onclose = () => {
      this.authenticated = false;
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose follows and owns the reconnect; nothing to do here.
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

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

/** Per-agent state for the activation currently streaming. */
interface ActivationState {
  /** MCPL composite channel id from the traces (e.g. discord:guild:123). */
  mcplChannelId?: string;
  /** Raw surface id sent to the relay (last composite segment). */
  rawChannelId?: string;
  /** Whether activation_start has been emitted for this turn. */
  announced: boolean;
  /** Accumulated text per blockIndex, for block_complete.content. */
  blocks: Map<number, string>;
}

/** A recently routed prose segment — the edit target for an interruption. */
interface RoutedMessage {
  rawChannelId: string;
  mcplChannelId: string;
  messageId?: string;
  text: string;
  at: number;
}

const ROUTED_RING_MAX = 32;

/** `discord:<guild>:<id>` / `portal:<id>` / raw → the raw surface id. */
function rawChannelId(mcplId: string): string {
  const ix = mcplId.lastIndexOf(':');
  return ix === -1 ? mcplId : mcplId.slice(ix + 1);
}

const collapseWs = (s: string): string => s.replace(/\s+/g, ' ').trim();

export class TtsRelayModule implements Module {
  readonly name = 'tts-relay';

  private ctx: ModuleContext | null = null;
  private client: RelayBotClient | null = null;
  private offTrace: (() => void) | null = null;

  private activations = new Map<string, ActivationState>();
  private routed: RoutedMessage[] = [];
  /** Resolved lazily from the first trace when config omits botId/username. */
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
      // A trace listener must never throw into the framework's emit path.
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
    this.routed = [];
    this.ctx = null;
  }

  getTools(): ToolDefinition[] { return []; }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    return { success: false, isError: true, error: `Unknown tool: ${call.name}` };
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  // -------------------------------------------------------------------------
  // Trace → relay
  // -------------------------------------------------------------------------

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

  /** Adopt a channel from a trace and emit activation_start once we have one. */
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
      case 'inference:started': {
        // A context-budget restart re-emits inference:started mid-turn; the
        // existing activation (announced or not) simply carries on.
        const st = this.activation(event.agentName);
        this.adoptChannel(st, event.agentName, event.channelId);
        break;
      }

      case 'inference:tokens': {
        const st = this.activation(event.agentName);
        this.adoptChannel(st, event.agentName, event.channelId);
        if (!st.rawChannelId) break; // no locus — nothing to voice into
        st.blocks.set(event.blockIndex, (st.blocks.get(event.blockIndex) ?? '') + event.content);
        this.client?.emit('chunk', {
          channelId: st.rawChannelId,
          ...this.identity(event.agentName),
          text: event.content,
          blockIndex: event.blockIndex,
          blockType: event.blockType as BlockType,
          // Voice only spoken prose. Thinking/tool blocks still stream (the
          // protocol carries them for UI), but flagged invisible.
          visible: event.blockType === 'text',
        });
        break;
      }

      case 'inference:content_block': {
        const st = this.activation(event.agentName);
        this.adoptChannel(st, event.agentName, event.channelId);
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
          // Reconstructed from this block's chunks — the trace itself
          // deliberately omits block content.
          const content = st.blocks.get(event.blockIndex) ?? '';
          st.blocks.delete(event.blockIndex);
          this.client?.emit('block_complete', { ...base, content });
        }
        break;
      }

      case 'inference:completed':
        this.endActivation(event.agentName, 'complete');
        break;
      case 'inference:aborted':
        this.endActivation(event.agentName, 'abort');
        break;
      case 'inference:failed':
      case 'inference:exhausted':
        this.endActivation(event.agentName, 'error');
        break;

      case 'mcpl:speech-routed': {
        // Remember what landed where, so an interruption can find its edit
        // target: (channelId, messageId, text) per posted segment.
        this.routed.push({
          rawChannelId: rawChannelId(event.channelId),
          mcplChannelId: event.channelId,
          messageId: event.messageId,
          text: event.text,
          at: event.timestamp,
        });
        if (this.routed.length > ROUTED_RING_MAX) {
          this.routed.splice(0, this.routed.length - ROUTED_RING_MAX);
        }
        break;
      }

      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Interruption → edit the posted message down to the voiced words
  // -------------------------------------------------------------------------

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
      console.error('[tts-relay] no routed message matched the interruption — nothing edited');
    }

    // Tell the agent she was cut off — otherwise her next turn believes the
    // whole paragraph was heard. Plain context note, no inference request:
    // the voice client's transcript of what the human said is the activation.
    if (this.config.notifyOnInterruption !== false) {
      const note = edited
        ? `[voice] Your message was interrupted by ${ev.reason.replace('_', ' ')} — only this much was voiced, and the posted message was trimmed to match: "${ev.spokenText}"`
        : `[voice] Your reply was interrupted by ${ev.reason.replace('_', ' ')} after: "${ev.spokenText}" (the posted message could not be trimmed)`;
      this.ctx?.addMessage('user', [{ type: 'text', text: note }]);
    }
  }

  /**
   * Match the interruption to the posted segment being voiced when it hit:
   * newest-first, same channel, and the voiced words prefix-match the
   * segment's text (whitespace-collapsed — TTS clients normalize). Falls back
   * to the newest message in the channel: with ROUTED_RING_MAX recency that's
   * almost always the one being read aloud.
   */
  private findInterruptedMessage(ev: InterruptionEvent): RoutedMessage | null {
    const inChannel = this.routed.filter((r) => r.rawChannelId === ev.channelId).reverse();
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
