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
} from '@animalabs/agent-framework';

export interface ActivityModuleConfig {
  initialChannels?: string[];
}

interface ActivityState {
  channels: string[];
}

export class ActivityModule implements Module {
  readonly name = 'activity';

  private ctx: ModuleContext | null = null;
  private framework: AgentFramework | null = null;
  private channels = new Set<string>();
  private typingActive = false;

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
    }
    return {};
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
