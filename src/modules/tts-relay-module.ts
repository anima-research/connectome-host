/**
 * TtsRelayModule — sends what the agent publishes to a melodeus-tts-relay
 * server, so voice clients (Melodeus, the iOS app) can speak it.
 *
 * Pure trace-bus tap (docs/observability.md spirit: traces are the outbound
 * wire, they never drive agent logic). The module subscribes to the framework's
 * traces and re-emits the relay's bot-side protocol
 * (melodeus-tts-relay/PROTOCOL.md) over one outbound WebSocket:
 *
 *   inference:started                  → activation_start (on the turn's channel,
 *                                        read from it or the token traces)
 *   inference:published                → block_start / chunk / block_complete
 *   inference:completed / :turn_ended  → activation_end reason 'complete'
 *   inference:aborted                  → activation_end reason 'abort'
 *   inference:exhausted                → activation_end reason 'error'
 *
 * Only published speech is voiced. The framework emits `inference:published`
 * once a publish is confirmed, one per message, on the channel it was
 * published to. So text the agent withheld (a `skip_reply`, a silencing
 * send, a private `think`), a publish that failed, thinking and tool calls
 * never reach the relay. `inference:tokens` carries all of those as they are
 * written, so the module forwards nothing of it but reads its channel. A
 * message sent with a tool call, such as discord-mcpl's `send_message` or a
 * subconscious's `speak_in_channel`, isn't prose delivery, so it isn't
 * voiced either. Each published message is one text block, which the client
 * shows as one message and voices. The block is complete when it's sent, so
 * `inference:published_complete`, the stream's end for a channel, carries
 * nothing the module needs: the turn's end is the activation's.
 *
 * The activation is the agent's turn, the client's "thinking…". It goes to
 * the channel the framework's typing indicator uses, as `channelId` (the MCPL
 * composite id): `inference:started` carries it when the turn has a locus,
 * and the token traces carry it in every turn that routes prose, which in
 * explicit mode is the channel that woke the turn. When a turn's traces name
 * another channel mid-turn, as when the framework re-pins its locus to a
 * channel that addressed the agent, the turn moves there. A channel has one
 * activation at a time: the first turn there opens it, another agent's turn
 * there (such as a sync subagent's on its parent's locus) joins it, and it
 * ends when the last turn there ends, with that turn's reason, but for a
 * turn that moves or one let go (below), which end it as 'complete'. So an
 * earlier turn's abort or error there cancels nothing, and a turn that moves
 * leaves the channel, ending it as 'complete' if it was the last turn there.
 * `inference:failed` ends nothing: the framework then retries the turn, holds
 * it for a provider's wait, or ends it, so a held turn keeps its activation
 * until it resumes and ends.
 * agent-framework 0.22.2 sends no end at all for an ephemeral run its idle
 * watchdog disposes, nor for a failed attempt whose retry it drops (a held
 * one when its agent is disposed or the wake it answers is withdrawn). So
 * at each start and end of any turn, and when the relay is back, the module
 * lets go of every other turn whose agent the framework no longer has, as
 * it lets a disposed agent go, ending a channel no turn is left on as
 * 'complete'. For a subagent's run, one comes with its parent's turn, which
 * a sync run's failure returns to and an async run's failure wakes. A turn
 * whose agent stays, its retry's wake withdrawn, keeps its activation until
 * that agent's next turn ends or starts on another channel, or the module
 * stops. The relay speaks raw Discord snowflakes, so the composite's
 * last segment is what goes on the wire.
 *
 * The relay keeps nothing: it forwards each start and end to the clients
 * subscribed at that moment, and drops what a bot sends while disconnected.
 * The clients keep each activation from its start to its end, also across
 * the bot's drop. So the module keeps what it last told them of each
 * channel: which activations it opened through the relay and hasn't ended
 * (opened), and an end it couldn't send for one. When the relay
 * authenticates the module again, every end goes before any start: first
 * those of turns let go because their agents went while it was away, then
 * the ends the clients missed, then a start for each channel a turn is on
 * that isn't open. An activation that began and ended while the relay was
 * away sends nothing. Stopping the module ends each open activation, and
 * logs each it can't end because the relay is away, naming the channel left
 * open. Every block, start and end
 * carries the bot's one identity, since everything the bot posts is the
 * bot's on Discord, whichever agent wrote it.
 *
 * Interruptions (the one inbound message): a voice client reports the words
 * actually voiced before the user spoke over them. Unlike ChapterX — which
 * aborts the in-flight stream and substitutes spokenText as the completion —
 * connectome posts each message as it's delivered, so the message is usually
 * already on Discord. The module therefore EDITS the message being voiced
 * down to the words heard, via the discord MCPL's edit_message tool, and
 * drops a note into the agent's context so she knows she was cut off: the
 * next turn shouldn't believe the full paragraph landed.
 *
 * melodeus-ios keeps one spokenText per bot: every segment voiced since a
 * start on a channel it voices, or since any interruption, joined with no
 * separator. It voices only its active channel unless set to voice every
 * channel, and it may speak "<username> says:" before a message. The module
 * keeps, per channel, the messages it sent since that channel's last
 * delivered start (any interruption clears them all), each with the id its
 * `inference:published` carries, and reads spokenText across them in order,
 * comparing letters and digits only and passing over that announcement. The
 * messages it covers whole were voiced; the one it ends inside is trimmed to
 * the words heard; the ones after weren't voiced before the interruption,
 * and the note says so. That lines up with the client while it voices one
 * channel that stays active through the activation, though its spokenText
 * can run up to a sentence ahead of the audio, so a trim can keep words not
 * yet heard. It leaves a message as it is when the agent edited or deleted
 * it since posting it, or tried to, since a trim written from the published
 * text would undo an edit and can't edit a deleted message, and when
 * discord-mcpl may have posted it as several Discord messages, since the id
 * `inference:published` carries is the last one's. The module can't see
 * which channels a client voices, and the client's spokenText and its
 * cancels are the bot's, not a channel's.
 * So a channel's messages can't be lined up with the words once the relay
 * has taken a start or a message on another channel since, once a stopped
 * turn's end, on any channel, has made the client cancel the bot's audio it
 * hadn't played, or once a dropped connection may have lost an interruption.
 * Then, as when the words don't follow the messages or more were sent than
 * the module keeps, it edits nothing and the note says why.
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
import { unknownToolResult } from './unknown-tool.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface TtsRelayModuleConfig {
  /** Relay bot endpoint, e.g. "ws://localhost:8800/bot". */
  url: string;
  /** Shared secret for the relay's /bot auth (BOT_TOKENS). `${VAR}` it. */
  token: string;
  /** Relay-side bot identifier, which the voice client keys the bot's voice
   *  settings on. Defaults to the primary agent's name, read at start. */
  botId?: string;
  /** The Discord user id stamped on block and activation messages, as the
   *  id the blocks carry. The client keys voices on botId, not this.
   *  Defaults to botId. */
  userId?: string;
  /** Display name stamped on block and activation messages, which the client
   *  may speak before a message ("<username> says:"). Defaults to the primary
   *  agent's name. */
  username?: string;
  /** MCPL server id owning edit_message for interruption edits. Default 'discord'. */
  editServerId?: string;
  reconnectIntervalMs?: number;
  /** Drop a context note when an interruption cuts the agent off. Default
   *  true. */
  notifyOnInterruption?: boolean;
}

// ---------------------------------------------------------------------------
// Relay wire types (bot side of melodeus-tts-relay/PROTOCOL.md)
// ---------------------------------------------------------------------------

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
 * send is fire-and-forget and is dropped while disconnected (the relay
 * spec's own semantics: no queueing). `emit` says whether it sent.
 */
class RelayBotClient {
  private ws: WebSocket | null = null;
  private authenticated = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;
  private onInterruptionHandler: ((event: InterruptionEvent) => void) | null = null;
  private onAuthenticatedHandler: (() => void) | null = null;

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

  /** Called each time the relay authenticates the bot, the first time and
   *  after every reconnect. */
  onAuthenticated(handler: () => void): void {
    this.onAuthenticatedHandler = handler;
  }

  /** Send a typed relay message; botId + timestamp are stamped here. False
   *  when it wasn't sent. */
  emit(type: string, payload: Record<string, unknown>): boolean {
    if (!this.isConnected()) return false;
    try {
      this.ws!.send(JSON.stringify({ type, botId: this.botId, ...payload, timestamp: Date.now() }));
      return true;
    } catch (err) {
      console.error('[tts-relay] send failed:', err);
      return false;
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
          this.onAuthenticatedHandler?.();
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

/** Per-agent state for the turn in progress. */
interface TurnState {
  /** The raw surface id of the channel the turn's activation is on, once a
   *  trace has named one. */
  rawChannelId?: string;
}

/** How a channel's activation ends on the wire. */
type EndReason = 'complete' | 'abort' | 'error';

/** A message the relay sent for voicing: what the client's spokenText is
 *  read against. */
export interface VoicedMessage {
  /** The posted message's id, from `inference:published`, when the channel's
   *  server returned one: what an interruption's edit names. */
  messageId?: string;
  /** The text sent, which the client voices. */
  content: string;
  /** Set when discord-mcpl may have posted it as several Discord messages
   *  (mayBeSplit), so its id names only the last. */
  maySplit?: true;
  /** Set when the agent called for an edit or a deletion of the posted
   *  message since, which the server may have refused: a trim written from
   *  the published text would undo an edit, and can't edit a deleted
   *  message. */
  changed?: true;
}

/** What the module holds of a channel since its last delivered start or the
 *  last interruption, whichever came later. */
interface ChannelRecord {
  /** The messages sent for voicing, oldest first, up to VOICED_MAX. */
  messages: VoicedMessage[];
  /** Messages sent past VOICED_MAX: counted, not kept. */
  notKept: number;
  /** Set, with the first reason that arose, when the client's spokenText
   *  may no longer line up with the messages: a stopped turn's end made it
   *  cancel the bot's audio it hadn't played, the connection to the relay
   *  dropped, which may have lost an interruption the client already reset
   *  at, or the relay took a start or a message on another channel, which
   *  the client may voice too. */
  unaligned?: 'stopped' | 'reconnected' | 'elsewhere';
}

/** An activation the module opened through the relay, for its clients, and
 *  hasn't ended: the relay took a start there and no end since. */
interface Opened {
  /** An end the module couldn't send for that activation, sent when the
   *  relay authenticates it again. */
  end?: EndReason;
}

/** The traces that end a turn here: each but inference:failed, which the
 *  framework follows with a retry, a hold or an end, unless it drops the
 *  retry (the header's last case). */
const TURN_ENDS: ReadonlySet<string> = new Set([
  'inference:completed',
  'inference:turn_ended',
  'inference:aborted',
  'inference:exhausted',
]);

/** How an interruption's words line up with the messages voiced on its
 *  channel since the activation there started. */
export type InterruptionReading =
  /** Nothing was sent there since the activation started. */
  | { kind: 'nothing-sent' }
  /** No message was voiced: the words hold no letter or digit, or only the
   *  client's announcement of the bot. */
  | { kind: 'none-voiced'; unvoiced: number }
  /** The words don't follow what was sent, in order. */
  | { kind: 'unmatched' }
  /** The words run past the messages kept, so where they end is unknown. */
  | { kind: 'past-record' }
  /** The words end where a message ends: those before were voiced, though
   *  the client may still have been playing the last one's last sentence. */
  | { kind: 'between'; unvoiced: number }
  /** The words end inside `message`, whose first part, `heard`, was voiced. */
  | { kind: 'cut'; message: VoicedMessage; heard: string; unvoiced: number };

/** A channel keeps the first messages sent since its activation started,
 *  where spokenText begins, up to this many, and counts the rest. Words that
 *  run past the kept ones can't be placed, so they edit nothing. */
const VOICED_MAX = 64;

/** discord-mcpl posts a message as several Discord messages once its text
 *  passes 1900 characters, with each `@handle` it pings written as `<@id>`
 *  or `<@&id>` first, and returns the last one's id (sendMessage's
 *  splitForDiscord and applyMentionCandidates, at discord-mcpl 9deb967). A
 *  ping is at most 22 characters longer than its handle: `<@&`, a 20-digit
 *  id and `>`, for `@x`. */
const DISCORD_SPLIT_AT = 1900;
const PING_GROWTH_MAX = 22;

/** Whether discord-mcpl may have posted this published text as several
 *  messages: its length, with every `@` grown to the longest ping, passes
 *  the split. */
export function mayBeSplit(text: string): boolean {
  let ats = 0;
  for (let i = text.indexOf('@'); i !== -1; i = text.indexOf('@', i + 1)) ats++;
  return text.length + PING_GROWTH_MAX * ats > DISCORD_SPLIT_AT;
}

/** The longest stretch of the words heard that a note quotes: their end. */
const QUOTE_MAX = 200;

/** `discord:<guild>:<id>` / `portal:<id>` / raw → the raw surface id. */
function rawChannelId(mcplId: string): string {
  const ix = mcplId.lastIndexOf(':');
  return ix === -1 ? mcplId : mcplId.slice(ix + 1);
}

/** Channel-bound inference traces carry `channelId` at runtime, but the
 *  framework's TraceEvent union doesn't declare it — read it through a cast. */
function traceChannelId(event: unknown): string | undefined {
  const v = (event as { channelId?: unknown }).channelId;
  return typeof v === 'string' ? v : undefined;
}

const isWordChar = (ch: string): boolean => /[\p{L}\p{N}]/u.test(ch);

/** A text's letters and digits, lower-cased, one entry per character, which
 *  is what the module compares: the client's spokenText joins its sentence
 *  segments without the spaces between them, and may drop markup. */
function wordChars(text: string): string[] {
  const out: string[] = [];
  for (const ch of text) if (isWordChar(ch)) out.push(ch.toLowerCase());
  return out;
}

/** `content` up to and including its `count`-th letter or digit. */
function prefixThrough(content: string, count: number): string {
  let seen = 0;
  let end = 0;
  for (const ch of content) {
    end += ch.length;
    if (isWordChar(ch) && ++seen === count) break;
  }
  return content.slice(0, end);
}

/** The first `n` of `prefix` equal `spoken` from `at`. */
function sameFrom(spoken: readonly string[], at: number, prefix: readonly string[], n: number): boolean {
  for (let k = 0; k < n; k++) if (prefix[k] !== spoken[at + k]) return false;
  return true;
}

/**
 * Read an interruption's spokenText across the messages voiced on its
 * channel since the activation there started, oldest first. Each message the
 * words cover whole was heard; the one they end inside was cut, and its
 * `heard` is the part voiced; the messages after were sent but not voiced,
 * the `notKept` ones past the record among them. Before any message the
 * client may have spoken `announcement` ("<username> says:"), which the
 * words pass over; words that end inside it end before that message.
 * Anything that doesn't line up is `unmatched`: a message the client didn't
 * voice, or one it voiced before the module's record of the channel began.
 */
export function readInterruption(
  sent: readonly VoicedMessage[],
  spokenText: string,
  { announcement = '', notKept = 0 }: { announcement?: string; notKept?: number } = {},
): InterruptionReading {
  const total = sent.length + notKept;
  const spoken = wordChars(spokenText);
  if (spoken.length === 0) return { kind: 'none-voiced', unvoiced: total };
  if (sent.length === 0) return { kind: 'nothing-sent' };
  const announced = wordChars(announcement);
  let at = 0;
  for (let i = 0; i < sent.length; i++) {
    const rest = spoken.length - at;
    if (announced.length > 0 && sameFrom(spoken, at, announced, Math.min(announced.length, rest))) {
      if (rest <= announced.length) {
        return i === 0 ? { kind: 'none-voiced', unvoiced: total } : { kind: 'between', unvoiced: total - i };
      }
      at += announced.length;
    }
    const own = wordChars(sent[i]!.content);
    const left = spoken.length - at;
    const n = Math.min(own.length, left);
    if (!sameFrom(spoken, at, own, n)) return { kind: 'unmatched' };
    if (left < own.length) {
      return { kind: 'cut', message: sent[i]!, heard: prefixThrough(sent[i]!.content, left), unvoiced: total - i - 1 };
    }
    at += own.length;
    if (at === spoken.length) return { kind: 'between', unvoiced: total - i - 1 };
  }
  return notKept > 0 ? { kind: 'past-record' } : { kind: 'unmatched' };
}

/** "Your next message here wasn't voiced before the interruption." for the
 *  note, or nothing. */
function unvoicedSentence(n: number): string {
  if (n === 0) return '';
  return n === 1
    ? ' Your next message here wasn\'t voiced before the interruption.'
    : ` Your ${n} later messages here weren't voiced before the interruption.`;
}

/** The end of the words heard, as a note quotes them. */
function quoteTail(text: string): string {
  const chars = [...text];
  return chars.length <= QUOTE_MAX ? text : `…${chars.slice(-QUOTE_MAX).join('')}`;
}

export class TtsRelayModule implements Module {
  readonly name = 'tts-relay';

  private ctx: ModuleContext | null = null;
  private client: RelayBotClient | null = null;
  private offTrace: (() => void) | null = null;
  /** The bot's identity on every block, start and end, fixed at start. */
  private identity = { userId: '', username: '' };

  /** The turn in progress, by agent name. */
  private turns = new Map<string, TurnState>();
  /** The turns on each channel, by raw channel id: the agents whose turns
   *  are there. The first to arrive opens its activation, and the last to
   *  leave ends it. */
  private holders = new Map<string, Set<string>>();
  /** Each channel's messages since its last delivered start or the last
   *  interruption, by raw channel id. A channel with none has no entry. */
  private records = new Map<string, ChannelRecord>();
  /** The activations open on the relay's clients, by raw channel id. */
  private opened = new Map<string, Opened>();
  /** A count of what the relay took, which orders a channel's reset point
   *  (its last delivered start, or the last interruption) against the other
   *  channels' messages. */
  private seq = 0;
  /** Each channel's last delivered start, as seq. */
  private startedAt = new Map<string, number>();
  /** The last interruption, as seq. */
  private clearedAt = 0;
  /** Each channel's last message sent for voicing, as seq. */
  private spokeAt = new Map<string, number>();
  /** The next block's index: one per published message, unique for the
   *  module's lifetime, since a turn's streams each number their own. */
  private blockSeq = 0;

  constructor(private readonly config: TtsRelayModuleConfig) {}

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;

    const primary = ctx.getAgents()[0]?.name ?? 'connectome';
    const botId = this.config.botId ?? primary;
    this.identity = { userId: this.config.userId ?? botId, username: this.config.username ?? primary };
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
    this.client.onAuthenticated(() => {
      try { this.onAuthenticated(); }
      catch (err) { console.error('[tts-relay] reconnect handling failed:', err); }
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
    // The relay keeps no activations, so its clients learn that one ended
    // only from an end: each open one gets 'complete', so posted messages
    // already queued still play, or the end it kept when a send of it
    // failed.
    for (const [raw, open] of this.opened) {
      if (!this.emitEnd(raw, open.end ?? 'complete')) {
        console.error(`[tts-relay] the relay is away, so the activation on ${raw} is left open there`);
      }
    }
    this.client?.disconnect();
    this.client = null;
    this.turns.clear();
    this.holders.clear();
    this.records.clear();
    this.opened.clear();
    this.startedAt.clear();
    this.spokeAt.clear();
    this.ctx = null;
  }

  getTools(): ToolDefinition[] { return []; }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    return unknownToolResult(this, call.name);
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  // -------------------------------------------------------------------------
  // Trace → relay
  // -------------------------------------------------------------------------

  /** The relay authenticated the module. Nothing is recorded before the
   *  first time, since nothing is sent; after a dropped connection, an
   *  interruption the client sent meanwhile was lost, though the client
   *  reset at it, so no record kept then can be read until its channel
   *  starts again. The turns whose agents went while it was away are let go
   *  first, so none is opened or kept for them. What the clients missed is
   *  sent now: every end, then the starts. */
  private onAuthenticated(): void {
    for (const record of this.records.values()) record.unaligned ??= 'reconnected';
    this.dropGoneTurns();
    for (const [raw, open] of [...this.opened]) {
      if (open.end === undefined) continue;
      if (!this.emitEnd(raw, open.end)) return;
      this.opened.delete(raw);
    }
    for (const raw of [...this.holders.keys()]) this.tellRelay(raw);
  }

  /** Tell the clients what's open on a channel, as far as it can be told
   *  now: an end they missed for the open activation, then a start, if a
   *  turn is there and none is open. While the relay is away, both wait for
   *  it to authenticate the module again. */
  private tellRelay(raw: string): void {
    const open = this.opened.get(raw);
    if (open?.end !== undefined) {
      if (!this.emitEnd(raw, open.end)) return;
      this.opened.delete(raw);
    }
    if (!this.holders.has(raw) || this.opened.has(raw)) return;
    if (!this.client?.emit('activation_start', { channelId: raw, ...this.identity })) {
      console.error(`[tts-relay] the relay is away, so the activation_start for ${raw} is sent when it's back`);
      return;
    }
    this.opened.set(raw, {});
    // The client starts the bot's spokenText afresh at a start on a channel
    // it voices: this channel's record starts again, and another's no longer
    // lines up.
    this.records.delete(raw);
    this.startedAt.set(raw, ++this.seq);
    this.unalignOthers(raw);
  }

  /** End the channel's open activation: now, or, while the relay is away,
   *  when it's back. An activation whose start the relay never took, or one
   *  that began after an open one whose end was missed, sends nothing. */
  private endActivation(raw: string, reason: EndReason): void {
    const open = this.opened.get(raw);
    if (open === undefined || open.end !== undefined) return;
    // A stopped turn's end makes the client cancel the bot's audio it hadn't
    // played, on every channel it voices, and nothing says how much.
    if (reason !== 'complete') {
      for (const record of this.records.values()) record.unaligned ??= 'stopped';
    }
    if (this.emitEnd(raw, reason)) {
      this.opened.delete(raw);
      return;
    }
    open.end = reason;
    console.error(`[tts-relay] the relay is away, so the activation_end for ${raw} is sent when it's back`);
  }

  private emitEnd(raw: string, reason: EndReason): boolean {
    return this.client?.emit('activation_end', { channelId: raw, ...this.identity, reason }) ?? false;
  }

  /** The client keeps one spokenText for the bot, and the module can't see
   *  which channels it voices: what the relay took on one channel can change
   *  it for any other, whose record then no longer lines up. */
  private unalignOthers(raw: string): void {
    for (const [channel, record] of this.records) {
      if (channel !== raw) record.unaligned ??= 'elsewhere';
    }
  }

  /** Put the turn's activation on the channel a trace names: the first that
   *  names one, and another when the framework moves the turn there. */
  private joinChannel(st: TurnState, agentName: string, mcplChannelId?: string): void {
    if (!mcplChannelId) return;
    const raw = rawChannelId(mcplChannelId);
    if (st.rawChannelId === raw) return;
    if (st.rawChannelId) this.leaveChannel(st.rawChannelId, agentName, 'complete');
    st.rawChannelId = raw;
    const there = this.holders.get(raw);
    if (there) {
      there.add(agentName);
      return;
    }
    this.holders.set(raw, new Set([agentName]));
    this.tellRelay(raw);
  }

  /** The turn leaves a channel: the last to leave ends its activation. */
  private leaveChannel(raw: string, agentName: string, reason: EndReason): void {
    const there = this.holders.get(raw);
    if (!there?.delete(agentName) || there.size > 0) return;
    this.holders.delete(raw);
    this.endActivation(raw, reason);
  }

  /** Let go of the turns whose agents the framework no longer has: an
   *  ephemeral run its idle watchdog disposes sends no end, and
   *  agent-framework 0.22.2 then lets its agent go (runEphemeralToCompletion).
   *  A channel no turn is left on ends as 'complete', so what's queued still
   *  plays. A trace's own agent is left to that trace, so its own end keeps
   *  its reason when it's the next start or end to come after its agent
   *  went. */
  private dropGoneTurns(except?: string): void {
    if (!this.ctx) return;
    const present = new Set(this.ctx.getAgents().map((agent) => agent.name));
    for (const [agentName, st] of [...this.turns]) {
      if (agentName === except || present.has(agentName)) continue;
      console.error(`[tts-relay] ${agentName}'s turn${st.rawChannelId ? ` on ${st.rawChannelId}` : ''} is let go with no end: the framework no longer has the agent`);
      this.endTurn(agentName, 'complete');
    }
  }

  private endTurn(agentName: string, reason: EndReason): void {
    const st = this.turns.get(agentName);
    this.turns.delete(agentName);
    if (st?.rawChannelId) this.leaveChannel(st.rawChannelId, agentName, reason);
  }

  /** One published message, as one text block on the channel it went to. A
   *  later message of the same stream to that channel opens with the paragraph
   *  break that joins a stream's chunks; a block stands alone, so it goes. */
  private voicePublished(mcplChannelId: string, text: string, messageId: string | undefined): void {
    const content = text.replace(/^\n+/, '');
    if (!content.trim()) return;
    const block = {
      channelId: rawChannelId(mcplChannelId),
      ...this.identity,
      blockIndex: this.blockSeq++,
      blockType: 'text',
    };
    // While the relay is reconnecting nothing is sent, and the relay protocol
    // keeps no queue, so the message goes unvoiced: say so.
    const client = this.client;
    const sent = client !== null
      && client.emit('block_start', block)
      && client.emit('chunk', { ...block, text: content, visible: true })
      && client.emit('block_complete', { ...block, content });
    if (!sent) {
      console.error(`[tts-relay] a message published to ${block.channelId} wasn't sent to the relay, so it wasn't voiced`);
      return;
    }
    const record = this.records.get(block.channelId) ?? this.newRecord(block.channelId);
    if (record.messages.length < VOICED_MAX) {
      record.messages.push({
        ...(messageId !== undefined ? { messageId } : {}),
        content,
        ...(mayBeSplit(text) ? { maySplit: true as const } : {}),
      });
    }
    else record.notKept++;
    this.records.set(block.channelId, record);
    this.spokeAt.set(block.channelId, ++this.seq);
    this.unalignOthers(block.channelId);
  }

  /** An edit or a deletion, by the edit server's tools, of a message a
   *  record holds marks it changed, so an interruption leaves it as it is.
   *  agent-framework traces an agent's MCPL call as `tool:started` with
   *  module `mcpl:<server id>`, the bare tool name and the call's input,
   *  before the server answers, so a call the server refused marks it too:
   *  the note says the agent changed it or tried to. */
  private noteChangedMessage(module: string, tool: string, input: unknown): void {
    if (module !== `mcpl:${this.config.editServerId ?? 'discord'}`) return;
    if (tool !== 'edit_message' && tool !== 'delete_message') return;
    const id = (input as { messageId?: unknown } | null | undefined)?.messageId;
    if (typeof id !== 'string') return;
    for (const record of this.records.values()) {
      for (const message of record.messages) if (message.messageId === id) message.changed = true;
    }
  }

  /** A channel's record, made by its first message since its reset point:
   *  its last delivered start, or the last interruption. Another channel's
   *  message sent since then may be in the client's words ahead of this
   *  channel's, so the record can't line up, even with a start elsewhere
   *  after it: a voiced start would drop it from the words, but one the
   *  client doesn't voice leaves it there, and the module can't tell which.
   *  A start elsewhere alone needs no mark, since a voiced one starts the
   *  words afresh and one not voiced adds nothing to them, nor does a
   *  stopped turn's end before the record's first message, since none of
   *  the record's messages had been sent for the client to cancel. */
  private newRecord(raw: string): ChannelRecord {
    const since = Math.max(this.startedAt.get(raw) ?? 0, this.clearedAt);
    const spokeElsewhere = [...this.spokeAt].some(([channel, at]) => channel !== raw && at > since);
    return { messages: [], notKept: 0, ...(spokeElsewhere ? { unaligned: 'elsewhere' as const } : {}) };
  }

  private onTraceEvent(event: TraceEvent): void {
    // `inference:published` is a message the framework published, sent once the
    // publish is confirmed, with the posted message's id when the channel's
    // server returned one. Read through the custom-trace cast, so the module
    // also builds against a framework whose TraceEvent union predates it.
    if ((event as { type: string }).type === 'inference:published') {
      const e = event as unknown as { channelId: string; text: string; messageId?: unknown };
      this.voicePublished(e.channelId, e.text, typeof e.messageId === 'string' ? e.messageId : undefined);
      return;
    }

    if (event.type === 'tool:started') {
      this.noteChangedMessage(event.module, event.tool, event.input);
      return;
    }

    if (event.type === 'inference:started' || TURN_ENDS.has(event.type)) {
      const own = (event as { agentName?: unknown }).agentName;
      this.dropGoneTurns(typeof own === 'string' ? own : undefined);
    }
    switch (event.type) {
      case 'inference:started': {
        // A context-budget restart or a retry re-emits inference:started
        // mid-turn: the turn, and its activation, carry on.
        let st = this.turns.get(event.agentName);
        if (!st) {
          st = {};
          this.turns.set(event.agentName, st);
        }
        this.joinChannel(st, event.agentName, traceChannelId(event));
        break;
      }

      // The token traces carry the channel of the turn's typing indicator, the
      // one that woke it in explicit mode, where inference:started has none.
      // Only that channel is read: their text may never be published. A trace
      // with no turn started is left alone, so it can't open an activation
      // that no end would close.
      case 'inference:tokens':
      case 'inference:content_block': {
        const st = this.turns.get(event.agentName);
        if (st) this.joinChannel(st, event.agentName, traceChannelId(event));
        break;
      }

      // A turn a tool ended (skip_reply and the like) emits turn_ended and
      // none of the others, so it ends the turn too. inference:failed ends
      // nothing: the framework then retries the turn, holds it for a
      // provider's wait, or ends it (the header names the turns 0.22.2
      // sends no end for).
      case 'inference:completed':
      case 'inference:turn_ended':
        this.endTurn(event.agentName, 'complete');
        break;
      case 'inference:aborted':
        this.endTurn(event.agentName, 'abort');
        break;
      case 'inference:exhausted':
        this.endTurn(event.agentName, 'error');
        break;

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
    const record = this.records.get(ev.channelId);
    // The client starts every bot's spokenText afresh after an interruption,
    // whichever channel it came from.
    this.records.clear();
    this.clearedAt = ++this.seq;
    const by = ev.reason.replace('_', ' ');
    const after = `after "${quoteTail(ev.spokenText)}"`;

    let note: string | null;
    if (record?.unaligned) {
      console.error(`[tts-relay] the words voiced in ${ev.channelId} can't be lined up with what was sent there (${record.unaligned}) — nothing edited`);
      const why = record.unaligned === 'stopped'
        ? 'a turn was stopped since, which can make the voice client drop audio it hadn\'t played'
        : record.unaligned === 'reconnected'
          ? 'this host lost its connection to the relay since'
          : 'this bot started or spoke on another channel since, which the voice client may voice too';
      // No words say nothing about messages voiced before the client last
      // started over, which the mark says may have happened unseen.
      note = wordChars(ev.spokenText).length > 0
        ? `[voice] Your reply was interrupted by ${by} ${after} (${why}, so those words can't be lined up with what was sent, and nothing was trimmed)`
        : `[voice] Your reply was interrupted by ${by}, with no words voiced since the voice client last started over (${why}, so this host can't tell which of your messages here were heard, and nothing was trimmed)`;
    } else {
      const reading = readInterruption(record?.messages ?? [], ev.spokenText, {
        announcement: `${this.identity.username} says:`,
        notKept: record?.notKept ?? 0,
      });
      switch (reading.kind) {
        case 'cut': {
          const { message, heard, unvoiced } = reading;
          if (!message.messageId) {
            console.error(`[tts-relay] the message cut off in ${ev.channelId} has no id to edit — nothing edited`);
            note = `[voice] Your message was interrupted by ${by} after "${quoteTail(heard)}" (the posted message has no id to edit, so it still has its full text).${unvoicedSentence(unvoiced)}`;
            break;
          }
          if (message.changed) {
            console.error(`[tts-relay] an edit or deletion of the message cut off in ${ev.channelId} was called for since it was posted — nothing edited`);
            note = `[voice] Your message was interrupted by ${by} after "${quoteTail(heard)}" (you edited or deleted the posted message since, or tried to, so it was left as it is).${unvoicedSentence(unvoiced)}`;
            break;
          }
          if (message.maySplit) {
            console.error(`[tts-relay] the message cut off in ${ev.channelId} may have been posted as several Discord messages — nothing edited`);
            note = `[voice] Your message was interrupted by ${by} after "${quoteTail(heard)}" (the posted message is long enough that Discord may show it as several messages, and this host has only the last one's id, so it still has its full text).${unvoicedSentence(unvoiced)}`;
            break;
          }
          const result = await this.ctx!.callTool({
            id: `tts-relay-interrupt-${Date.now()}`,
            name: `mcpl--${this.config.editServerId ?? 'discord'}--edit_message`,
            input: { channelId: ev.channelId, messageId: message.messageId, content: heard },
          });
          // agent-framework 0.22.2 reports every MCPL call its server answers
          // as a success, dropping the answer's isError (executeMcplToolCall),
          // so an edit the server refused reads as a trim here: the module
          // can't see the flag the framework drops.
          if (result.success === true) {
            note = `[voice] Your message was interrupted by ${by} — about this much was voiced (the voice client can count a sentence whole as soon as it starts playing), and the posted message was trimmed to match: "${quoteTail(heard)}"${unvoicedSentence(unvoiced)}`;
          } else {
            console.error(`[tts-relay] edit_message failed for ${message.messageId}:`, result.error);
            note = `[voice] Your message was interrupted by ${by} after "${quoteTail(heard)}" (trimming the posted message failed, so it still has its full text).${unvoicedSentence(unvoiced)}`;
          }
          break;
        }
        case 'between':
          console.error(`[tts-relay] the interruption in ${ev.channelId} came between messages — nothing to trim`);
          note = reading.unvoiced === 0
            ? null
            : `[voice] Your reply was interrupted by ${by} between messages: the ones before were voiced, though their last sentence may still have been playing, and nothing was trimmed.${unvoicedSentence(reading.unvoiced)}`;
          break;
        case 'none-voiced': {
          console.error(`[tts-relay] the interruption in ${ev.channelId} came before any message was voiced — nothing edited`);
          const n = reading.unvoiced;
          const which = n === 0 ? ''
            : n === 1 ? ': your message here wasn\'t voiced before the interruption'
            : `: none of your ${n} messages here was voiced before the interruption`;
          note = `[voice] Your reply was interrupted by ${by} before any of it was voiced, so nothing was trimmed${which}.`;
          break;
        }
        case 'nothing-sent':
          console.error(`[tts-relay] nothing was sent for voicing in ${ev.channelId} since its activation started — nothing edited`);
          note = `[voice] Your reply was interrupted by ${by} ${after} (this host has no record of what was voiced here, so nothing was trimmed)`;
          break;
        case 'past-record':
          console.error(`[tts-relay] the words voiced in ${ev.channelId} run past the ${VOICED_MAX} messages kept there — nothing edited`);
          note = `[voice] Your reply was interrupted by ${by} ${after} (more messages were voiced here than this host keeps, so it can't tell which one those words end in, and nothing was trimmed)`;
          break;
        case 'unmatched':
          console.error(`[tts-relay] the words voiced in ${ev.channelId} don't follow the messages sent there — nothing edited`);
          note = `[voice] Your reply was interrupted by ${by} ${after} (those words don't follow what this host sent here, as when the voice client voices another channel too, so nothing was trimmed)`;
          break;
      }
    }

    // Tell the agent she was cut off — otherwise her next turn believes the
    // whole paragraph was heard. Plain context note, no inference request:
    // the voice client's transcript of what the human said is the activation.
    if (note !== null && this.config.notifyOnInterruption !== false) {
      this.ctx?.addMessage('user', [{ type: 'text', text: note }]);
    }
  }
}
