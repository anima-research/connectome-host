/**
 * SettingsModule — runtime-tunable host settings the agent can toggle for
 * itself. State persists to chronicle via ModuleContext (`setState`/`getState`)
 * so changes survive restarts.
 *
 * First domain: **reasoning** (Anthropic extended thinking). Tools:
 *   - reasoning_status                    → show current state
 *   - reasoning_enable {budgetTokens?}    → turn on with optional budget
 *   - reasoning_disable                   → turn off
 *
 * The host's adapter wrapper (LoggingAnthropicAdapter) reads `getReasoning()`
 * on each call and injects `thinking: {type:'enabled', budget_tokens: N}` into
 * the outgoing Anthropic request when enabled — keeping the cross-cutting
 * "request mutator" plumbing out of every call site.
 *
 * Designed to be extensible: new domains add their own slice in
 * `SettingsState` + a few tools + a typed accessor. Bundled with the host;
 * recipes opt in by including `SettingsModule` in moduleInstances.
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

export interface ReasoningSettings {
  enabled: boolean;
  budgetTokens: number;
}

export interface SettingsState {
  reasoning: ReasoningSettings;
}

const DEFAULTS: SettingsState = {
  reasoning: { enabled: false, budgetTokens: 8192 },
};

export class SettingsModule implements Module {
  readonly name = 'settings';

  private ctx: ModuleContext | null = null;
  private state: SettingsState = clone(DEFAULTS);

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    const saved = ctx.getState<Partial<SettingsState>>();
    if (saved) {
      // Shallow-merge each domain so future-added fields fall back to defaults
      // for state persisted by older versions.
      this.state = {
        reasoning: { ...DEFAULTS.reasoning, ...(saved.reasoning ?? {}) },
      };
    }
  }

  async stop(): Promise<void> {
    this.ctx = null;
  }

  /** Read accessor for external consumers (e.g., the LLM adapter wrapper). */
  getReasoning(): ReasoningSettings {
    return { ...this.state.reasoning };
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'reasoning_status',
        description:
          'Show whether extended thinking (reasoning) is currently enabled and the token budget.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'reasoning_enable',
        description:
          'Enable extended thinking (reasoning) on your subsequent inference calls. ' +
          'Optional budgetTokens in tokens (default: current value, initially 8192; min 1024).',
        inputSchema: {
          type: 'object',
          properties: {
            budgetTokens: {
              type: 'number',
              description: 'Token budget for thinking blocks (min 1024).',
            },
          },
        },
      },
      {
        name: 'reasoning_disable',
        description:
          'Disable extended thinking (reasoning). Subsequent inference calls will not request thinking blocks.',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    const input = (call.input ?? {}) as Record<string, unknown>;
    switch (call.name) {
      case 'reasoning_status':
        return ok(this.reasoningStatusText());
      case 'reasoning_enable': {
        const budget =
          typeof input.budgetTokens === 'number'
            ? Math.max(1024, Math.round(input.budgetTokens))
            : this.state.reasoning.budgetTokens;
        this.state.reasoning = { enabled: true, budgetTokens: budget };
        this.ctx?.setState(this.state);
        return ok('Reasoning enabled. ' + this.reasoningStatusText());
      }
      case 'reasoning_disable':
        this.state.reasoning = { ...this.state.reasoning, enabled: false };
        this.ctx?.setState(this.state);
        return ok('Reasoning disabled. ' + this.reasoningStatusText());
      default:
        return { success: false, error: `Unknown tool: ${call.name}`, isError: true };
    }
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  private reasoningStatusText(): string {
    const r = this.state.reasoning;
    return `reasoning=${r.enabled ? 'ENABLED' : 'disabled'}, budgetTokens=${r.budgetTokens}`;
  }
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

function ok(message: string): ToolResult {
  return { success: true, data: { message }, isError: false };
}
