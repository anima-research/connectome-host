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
import { formatZonedDateTime, resolveTimeZone } from '@animalabs/agent-framework';

interface TimeState {
  sessionStartAnnounced?: boolean;
}

export function formatNow(date: Date = new Date(), configuredTimeZone?: string): {
  iso: string;
  local: string;
  timezone: string;
  unixMs: number;
} {
  const timezone = resolveTimeZone(configuredTimeZone);
  const local = formatZonedDateTime(date, timezone);
  return {
    iso: local.slice(0, local.indexOf(' [')),
    local,
    timezone,
    unixMs: date.getTime(),
  };
}

export class TimeModule implements Module {
  readonly name = 'time';

  private ctx: ModuleContext | null = null;
  private readonly timeZone: string;

  constructor(timeZone?: string) {
    this.timeZone = resolveTimeZone(timeZone);
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;

    const state = ctx.getState<TimeState>() ?? {};
    if (state.sessionStartAnnounced) return;

    const now = formatNow(new Date(), this.timeZone);
    const text =
      `The local time at the start of this session is ${now.local}.`;

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
        description: 'Return the current wall-clock time in the agent-configured timezone, plus unix milliseconds.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    if (call.name === 'now') {
      return { success: true, data: formatNow(new Date(), this.timeZone) };
    }
    return { success: false, isError: true, error: `Unknown tool: ${call.name}` };
  }
}
