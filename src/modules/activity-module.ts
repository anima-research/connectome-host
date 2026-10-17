/**
 * ActivityModule — surfaces agent composition activity (typing indicators)
 * to a configurable set of MCPL channels while inference is active.
 *
 * Recipe-seeded initial channels; agent can add/remove at runtime via tools.
 * State persists via Chronicle. Typing refresh is owned by the framework's
 * ChannelRegistry (~7s interval, matches Discord/Zulip expiry).
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
import { unknownToolResult } from './unknown-tool.js';
import { shown } from './shown.js';

export interface ActivityModuleConfig {
  initialChannels?: string[];
}

/** Trace events that end a turn's stream. A turn's tool rounds stay inside
 *  its one stream, so `inference:completed` comes once, at a turn's normal
 *  end; `inference:turn_ended` ends one a tool closed; and an aborted, failed
 *  or exhausted stream ends with its own event. A failed attempt that the
 *  framework retries starts again with `inference:started`, and a failure
 *  can send `failed` and then `exhausted`. */
const TURN_END_TRACES: ReadonlySet<string> = new Set([
  'inference:completed',
  'inference:turn_ended',
  'inference:aborted',
  'inference:failed',
  'inference:exhausted',
]);

interface ActivityState {
  channels: string[];
}

/** How much of a file's head the origin hint is read from. */
const ORIGIN_HEAD_BYTES = 2048;

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
  /** Whether a turn is under way, as far as typing shows it. One flag for
   *  every agent: the framework itself clears every channel's typing when
   *  any turn's stream reaches its end, so a turn's end, whoever's, is when
   *  the channels stop showing it. */
  private typingActive = false;
  /** The framework's trace subscription, ended in stop(), as onTrace's
   *  contract asks, and when setFramework replaces the framework. */
  private unsubscribeTrace: (() => void) | null = null;

  /** Most recent incoming-message metadata per channel. Handed back to the
   *  originating server on each typing notification so routing hints (e.g.
   *  Zulip topic) land where the conversation is active. */
  private lastMetadata = new Map<string, Record<string, unknown>>();

  constructor(private readonly config: ActivityModuleConfig = {}) {}

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
    this.unsubscribeTrace?.();
    this.unsubscribeTrace = null;
    this.stopAllTyping();
    this.ctx = null;
    this.framework = null;
  }

  /** Called from the host after framework creation, like SubagentModule.
   *  The host builds a module per framework; a framework handed over here
   *  replaces any earlier one as stop() ends it: no more of its traces, and
   *  no typing left on its channels. */
  setFramework(framework: AgentFramework): void {
    this.unsubscribeTrace?.();
    this.stopAllTyping();
    this.framework = framework;
    this.typingActive = false;
    this.unsubscribeTrace = framework.onTrace((event: TraceEvent) => {
      if (event.type === 'inference:started') {
        // A silent wake's prose is suppressed. agent-framework's own Discord
        // module shows no typing for one either.
        if ((event as { silent?: unknown }).silent === true) return;
        this.onInferenceStarted();
      } else if (TURN_END_TRACES.has(event.type)) {
        // Any end, failed or aborted ones included: leaving the flag on
        // would have show_in start "typing…" when no turn is under way.
        this.onInferenceEnded();
      }
    });
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
    if (call.name !== 'show_in' && call.name !== 'hide_in') return unknownToolResult(this, call.name);
    const given = (call.input as { channel?: unknown } | undefined)?.channel;
    if (typeof given !== 'string' || given.length === 0) {
      return {
        success: false,
        isError: true,
        error:
          `Nothing changed: activity--${call.name} needs channel, the channel's MCPL id exactly as its ` +
          `incoming events show it, such as "zulip:tracker-miner-f"` +
          (given === undefined || given === '' ? '.' : `, not ${shown(given)}.`),
      };
    }
    const channel = given;

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

    return unknownToolResult(this, call.name);
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
      try {
        // readFileFromDisk refuses a file that is itself a link unless the
        // mount follows links, reads a file only if its canonical path lies
        // inside the mount, and is asked for no more than the head the hint
        // needs.
        const { bytes } = await workspace.readFileFromDisk(mountPath, { maxBytes: ORIGIN_HEAD_BYTES });
        // agent-framework 0.22.2 reads a file that grows after the read's
        // size check whole, so the head is cut here too. Once the host's
        // agent-framework floor includes anima-research/agent-framework#409,
        // readFileFromDisk keeps maxBytes itself, and this cut can go.
        const origin = parseOriginHint(bytes.subarray(0, ORIGIN_HEAD_BYTES).toString('utf8'));
        if (origin && this.channels.has(origin.channelId)) {
          // Merge with any existing metadata so other keys (e.g. senderEmail)
          // survive if the origin refresh is subsequent to an incoming message.
          const prior = this.lastMetadata.get(origin.channelId) ?? {};
          this.lastMetadata.set(origin.channelId, { ...prior, topic: origin.topic });
        }
      } catch {
        // Unreadable, gone, or refused by the mount: silently skip.
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

  private onInferenceEnded(): void {
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
