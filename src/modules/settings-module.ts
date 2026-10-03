/**
 * SettingsModule — runtime-tunable host settings the agent can toggle for
 * itself. State persists to chronicle via ModuleContext (`setState`/`getState`)
 * so changes survive restarts.
 *
 * First domain: **reasoning** (Anthropic extended thinking), surfaced to the
 * agent as `agent_settings` fields (reasoning_enabled /
 * reasoning_budget_tokens / reasoning_display / reasoning_effort) via the framework's settings-extension hook —
 * NOT as standalone tools (the former reasoning_status/enable/disable trio
 * was tool bloat for one boolean + number).
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
  /**
   * How thinking content comes back from the API: 'summarized' returns a
   * readable reasoning summary in the `thinking` field; 'omitted' returns an
   * empty `thinking` field with only the encrypted signature. Models 4.7+
   * default to 'omitted' server-side — we default to 'summarized' to restore
   * the pre-4.7 behavior (visible reasoning in stores, webui, estimators).
   */
  display: 'summarized' | 'omitted';
  /**
   * Reasoning effort for the agent's own turns, sent as Anthropic
   * `output_config.effort`. 'default' sends nothing, leaving the model's
   * server-side default in force. Independent of `enabled`: on models where
   * thinking is always on, effort is the only depth control.
   */
  effort: ReasoningEffort;
}

export const REASONING_EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface SettingsState {
  reasoning: ReasoningSettings;
}

const DEFAULTS: SettingsState = {
  reasoning: { enabled: false, budgetTokens: 8192, display: 'summarized', effort: 'default' },
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

  /** No standalone tools — reasoning controls live inside the framework's
   *  `agent_settings` tool via getAgentSettingsExtension() below. The three
   *  former reasoning_* tools were pure tool bloat for one boolean + number. */
  getTools(): ToolDefinition[] {
    return [];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    return {
      success: false,
      error:
        `Unknown tool: ${call.name}. Reasoning controls moved into agent_settings ` +
        `(fields reasoning_enabled / reasoning_budget_tokens).`,
      isError: true,
    };
  }

  /**
   * Declare reasoning as an agent_settings extension: the framework merges
   * these fields into the agent_settings tool and routes get/update/reset for
   * them back here. Framework versions predating the hook simply never call
   * this — in that case reasoning is temporarily not agent-tunable (the
   * adapter still honors persisted state).
   */
  getAgentSettingsExtension(): {
    properties: Record<string, unknown>;
    keys: string[];
    get(agentName: string): Record<string, unknown>;
    update(agentName: string, patch: Record<string, unknown>): Record<string, unknown>;
    reset(agentName: string, keys?: string[]): Record<string, unknown>;
  } {
    return {
      properties: {
        reasoning_enabled: {
          type: 'boolean',
          description:
            'Extended thinking (reasoning) on subsequent inference calls.',
        },
        reasoning_budget_tokens: {
          type: 'number',
          description: 'Token budget for thinking blocks (min 1024).',
        },
        reasoning_display: {
          type: 'string',
          enum: ['summarized', 'omitted'],
          description:
            "How your thinking is returned: 'summarized' (a readable summary of your reasoning " +
            "is recorded alongside the signature) or 'omitted' (signature only, slightly faster " +
            'first token; your reasoning is not visible to anyone, including you on replay).',
        },
        reasoning_effort: {
          type: 'string',
          enum: [...REASONING_EFFORTS],
          description:
            "How much effort you put into your own turns (thinking depth and overall token spend): " +
            "'low', 'medium', 'high', 'xhigh', 'max', or 'default' (the model's own default). " +
            'Takes effect on your next inference call and persists across restarts. Changing it ' +
            'makes the next call re-read your whole context uncached (one-time cost). Levels your ' +
            'model does not support are not sent. Memory compression is unaffected.',
        },
      },
      keys: ['reasoning_enabled', 'reasoning_budget_tokens', 'reasoning_display', 'reasoning_effort'],
      get: () => this.reasoningSettingsView(),
      update: (_agentName, patch) => {
        const next = { ...this.state.reasoning };
        if (patch.reasoning_enabled !== undefined) {
          if (typeof patch.reasoning_enabled !== 'boolean') {
            throw new Error('reasoning_enabled must be a boolean');
          }
          next.enabled = patch.reasoning_enabled;
        }
        if (patch.reasoning_budget_tokens !== undefined) {
          const budget = Number(patch.reasoning_budget_tokens);
          if (!Number.isFinite(budget)) {
            throw new Error('reasoning_budget_tokens must be a number');
          }
          next.budgetTokens = Math.max(1024, Math.round(budget));
        }
        if (patch.reasoning_display !== undefined) {
          if (patch.reasoning_display !== 'summarized' && patch.reasoning_display !== 'omitted') {
            throw new Error("reasoning_display must be 'summarized' or 'omitted'");
          }
          next.display = patch.reasoning_display;
        }
        if (patch.reasoning_effort !== undefined) {
          if (!REASONING_EFFORTS.includes(patch.reasoning_effort as ReasoningEffort)) {
            throw new Error(`reasoning_effort must be one of: ${REASONING_EFFORTS.join(', ')}`);
          }
          next.effort = patch.reasoning_effort as ReasoningEffort;
        }
        this.state.reasoning = next;
        this.ctx?.setState(this.state);
        return this.reasoningSettingsView();
      },
      reset: (_agentName, keys) => {
        const all = !keys || keys.length === 0;
        if (all || keys?.includes('reasoning_enabled')) {
          this.state.reasoning.enabled = DEFAULTS.reasoning.enabled;
        }
        if (all || keys?.includes('reasoning_budget_tokens')) {
          this.state.reasoning.budgetTokens = DEFAULTS.reasoning.budgetTokens;
        }
        if (all || keys?.includes('reasoning_display')) {
          this.state.reasoning.display = DEFAULTS.reasoning.display;
        }
        if (all || keys?.includes('reasoning_effort')) {
          this.state.reasoning.effort = DEFAULTS.reasoning.effort;
        }
        this.ctx?.setState(this.state);
        return this.reasoningSettingsView();
      },
    };
  }

  /** The extension's wire view of reasoning state (flat agent_settings keys). */
  private reasoningSettingsView(): Record<string, unknown> {
    return {
      reasoning_enabled: this.state.reasoning.enabled,
      reasoning_budget_tokens: this.state.reasoning.budgetTokens,
      reasoning_display: this.state.reasoning.display,
      reasoning_effort: this.state.reasoning.effort,
    };
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}
