/**
 * agent-framework's ChannelRegistry refreshes a channel's typing indicator
 * every 7 s while it shows.
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
import { STREAM_END_TRACES } from '../state/turn-trace.js';
import { addressedPush } from './addressed-push.js';

export interface ActivityModuleConfig {
  initialChannels?: string[];
}

interface ActivityState {
  channels: string[];
}

const ORIGIN_HEAD_BYTES = 2048;

/**
 * A workspace file's head can name the conversation it answers, and typing
 * for an inference the file triggers shows there. Recognized shapes:
 *   - `origin: zulip#<channel>#<topic>`
 *   - `reply-to: zulip:<channel>/<topic>`
 *   - YAML frontmatter (between leading `---` lines) holding both
 *     `channel: <name>` and `topic: <name>`; `channel:` and `topic:` lines
 *     outside a frontmatter block are ignored.
 * Every hint names `zulip:<channel>`. Returns null if the head holds none.
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
  /** One flag for every agent: agent-framework clears every channel's typing
   *  when any turn's stream ends, unless it hands the turn to a successor. */
  private typingActive = false;
  private unsubscribeTrace: (() => void) | null = null;

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

  setFramework(framework: AgentFramework): void {
    this.unsubscribeTrace?.();
    this.stopAllTyping();
    this.framework = framework;
    this.typingActive = false;
    this.unsubscribeTrace = framework.onTrace((event: TraceEvent) => {
      if (event.type === 'inference:started') {
        // agent-framework suppresses a silent wake's prose, and its own Discord
        // module shows no typing for one.
        if ((event as { silent?: unknown }).silent === true) return;
        this.onInferenceStarted();
      } else if (STREAM_END_TRACES.has(event.type)) {
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
    else if (event.type === 'mcpl:push-event') {
      const pushed = addressedPush(event);
      if (pushed) this.lastMetadata.set(pushed.channelId, { ...pushed.origin });
    }
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
        const { bytes } = await workspace.readFileFromDisk(mountPath, { maxBytes: ORIGIN_HEAD_BYTES });
        const origin = parseOriginHint(bytes.toString('utf8'));
        if (origin && this.channels.has(origin.channelId)) {
          const prior = this.lastMetadata.get(origin.channelId) ?? {};
          this.lastMetadata.set(origin.channelId, { ...prior, topic: origin.topic });
        }
      } catch {
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
