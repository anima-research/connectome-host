/**
 * TimeModule — provides the agent with wall-clock awareness.
 *
 * On fresh session start, injects a message stating the session's start time.
 * Exposes `time:now` tool so the agent can check the current time on demand.
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
} from '@animalabs/agent-framework';

interface TimeState {
  sessionStartAnnounced?: boolean;
}

function formatNow(date: Date = new Date()): {
  iso: string;
  local: string;
  timezone: string;
  unixMs: number;
} {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    iso: date.toISOString(),
    local: date.toString(),
    timezone,
    unixMs: date.getTime(),
  };
}

export class TimeModule implements Module {
  readonly name = 'time';

  private ctx: ModuleContext | null = null;

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;

    const state = ctx.getState<TimeState>() ?? {};
    if (state.sessionStartAnnounced) return;

    const now = formatNow();
    const text =
      `The time at the start of this session is: ${now.iso} ` +
      `(local: ${now.local}, timezone: ${now.timezone}).`;

    ctx.addMessage('user', [{ type: 'text', text }]);
    ctx.setState<TimeState>({ ...state, sessionStartAnnounced: true });
  }

  async stop(): Promise<void> {
    this.ctx = null;
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'now',
        description: 'Return the current wall-clock time as ISO 8601, local string, timezone, and unix milliseconds.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    if (call.name === 'now') {
      return { success: true, data: formatNow() };
    }
    return { success: false, isError: true, error: `Unknown tool: ${call.name}` };
  }
}
