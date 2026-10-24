/**
 * SettingsModule — runtime-tunable host settings the agent can toggle for
 * itself. State persists to chronicle via ModuleContext (`setState`/`getState`)
 * so changes survive restarts, and it's read there at each use, so it follows
 * the store's branches through undo, redo and checkout.
 *
 * First domain: **reasoning** (Anthropic extended thinking), surfaced to the
 * agent as `agent_settings` fields (reasoning_enabled /
 * reasoning_budget_tokens / reasoning_display / reasoning_effort) via the framework's settings-extension hook —
 * NOT as standalone tools (the former reasoning_status/enable/disable trio
 * was tool bloat for one boolean + number).
 *
 * The host's adapter wrapper (LoggingAnthropicAdapter) reads `getReasoning()`
 * on each call and injects `thinking: {type: 'adaptive', display}` into the
 * outgoing Anthropic request when enabled, on a model that takes adaptive
 * thinking (withReasoning) — keeping the cross-cutting "request mutator"
 * plumbing out of every call site. On a streamed call to a model that
 * returns its notes as thinking blocks, it then sends display 'updates'
 * where the request would leave 'omitted' (withProgressNotes).
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
import { unknownToolResult } from './unknown-tool.js';
import { shown } from './shown.js';

export interface ReasoningSettings {
  enabled: boolean;
  budgetTokens: number;
  /**
   * How thinking content comes back from the API: 'summarized' returns a
   * readable reasoning summary in the `thinking` field; 'omitted' returns an
   * empty `thinking` field with only the encrypted signature. Models 4.7+
   * default to 'omitted' server-side — we default to 'summarized' to restore
   * the pre-4.7 behavior (visible reasoning in stores, webui, estimators).
   * On the models modelReturnsNotesInThinking lists, a streamed call through
   * the Anthropic adapter sends 'omitted' as 'updates', so the notes between
   * tool calls come back as text while reasoning stays hidden
   * (LoggingAnthropicAdapter.withProgressNotes).
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
  /** Each malformed saved value already logged, so it's named once rather than on every read. */
  private readonly warned = new Set<string>();

  constructor(private readonly initialEffort: ReasoningEffort = 'default') {}

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
  }

  /**
   * The current branch's reasoning settings, and the effort the agent chose
   * there, read from module state at each call: undo, redo and checkout move
   * to another branch without restarting modules.
   */
  private current(): { reasoning: ReasoningSettings; effortOverride: ReasoningEffort | undefined } {
    const saved = this.ctx?.getState<{ reasoning?: unknown }>()?.reasoning;
    const baseline = { ...DEFAULTS.reasoning, effort: this.initialEffort };
    return { reasoning: restoreReasoning(saved, baseline, this.warned), effortOverride: savedEffortOverride(saved) };
  }

  async stop(): Promise<void> {
    this.ctx = null;
  }

  /** Read accessor for external consumers (e.g., the LLM adapter wrapper). */
  getReasoning(): ReasoningSettings {
    return this.current().reasoning;
  }

  /** No standalone tools — reasoning controls live inside the framework's
   *  `agent_settings` tool via getAgentSettingsExtension() below. The three
   *  former reasoning_* tools were pure tool bloat for one boolean + number. */
  getTools(): ToolDefinition[] {
    return [];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    return unknownToolResult(
      this,
      call.name,
      'Reasoning is set through agent_settings, in its fields reasoning_enabled, reasoning_budget_tokens, ' +
      'reasoning_display and reasoning_effort.',
    );
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
            'first token; no readable summary is recorded). Either way, when a thinking block is ' +
            'sent back to you, you get your full reasoning, not the summary: this changes only what ' +
            'is recorded as readable text. On Fable 5/5.1, Mythos 5.1, Opus 5.5 and Sonnet 5.5, the ' +
            "notes you write between tool calls come back as thinking blocks, so 'omitted' is sent " +
            "as 'updates' there: your reasoning stays unrecorded, and those notes are kept as text.",
        },
        reasoning_effort: {
          type: 'string',
          enum: [...REASONING_EFFORTS],
          description:
            "How much effort you put into your own turns (thinking depth and overall token spend): " +
            "'low', 'medium', 'high', 'xhigh', 'max', or 'default' (the model's own default). " +
            'Takes effect on your next inference call and persists across restarts; reset restores the recipe effort. Changing it ' +
            'makes the next call re-read your whole context uncached (one-time cost). Levels your ' +
            'model does not support are not sent. Memory compression is unaffected.',
        },
      },
      keys: ['reasoning_enabled', 'reasoning_budget_tokens', 'reasoning_display', 'reasoning_effort'],
      get: () => reasoningSettingsView(this.current().reasoning),
      update: (_agentName, patch) => {
        const { reasoning, effortOverride } = this.current();
        // Every field is checked before any applies, and every problem is
        // named, so one refusal shows all there is to fix.
        const next = { ...reasoning };
        const problems: string[] = [];
        if (patch.reasoning_enabled !== undefined) {
          if (typeof patch.reasoning_enabled !== 'boolean') {
            problems.push(`reasoning_enabled must be true or false, not ${shown(patch.reasoning_enabled)}`);
          } else {
            next.enabled = patch.reasoning_enabled;
          }
        }
        if (patch.reasoning_budget_tokens !== undefined) {
          const budget = patch.reasoning_budget_tokens;
          if (typeof budget !== 'number' || !Number.isFinite(budget)) {
            problems.push(
              `reasoning_budget_tokens must be a number of tokens, not ${shown(budget)} ` +
              '(the least it takes is 1024, and a smaller number counts as 1024)',
            );
          } else {
            next.budgetTokens = Math.max(1024, Math.round(budget));
          }
        }
        if (patch.reasoning_display !== undefined) {
          if (patch.reasoning_display !== 'summarized' && patch.reasoning_display !== 'omitted') {
            problems.push(`reasoning_display must be "summarized" or "omitted", not ${shown(patch.reasoning_display)}`);
          } else {
            next.display = patch.reasoning_display;
          }
        }
        if (patch.reasoning_effort !== undefined) {
          if (!REASONING_EFFORTS.includes(patch.reasoning_effort as ReasoningEffort)) {
            problems.push(
              `reasoning_effort must be one of ${REASONING_EFFORTS.map((e) => `"${e}"`).join(', ')}, ` +
              `not ${shown(patch.reasoning_effort)}`,
            );
          } else {
            next.effort = patch.reasoning_effort as ReasoningEffort;
          }
        }
        if (problems.length > 0) {
          throw new Error(`The reasoning settings weren't changed: ${problems.join('; ')}.`);
        }
        this.persist(next, patch.reasoning_effort !== undefined ? next.effort : effortOverride);
        return reasoningSettingsView(next);
      },
      reset: (_agentName, keys) => {
        const { reasoning, effortOverride } = this.current();
        const next = { ...reasoning };
        let override = effortOverride;
        const all = !keys || keys.length === 0;
        if (all || keys?.includes('reasoning_enabled')) next.enabled = DEFAULTS.reasoning.enabled;
        if (all || keys?.includes('reasoning_budget_tokens')) next.budgetTokens = DEFAULTS.reasoning.budgetTokens;
        if (all || keys?.includes('reasoning_display')) next.display = DEFAULTS.reasoning.display;
        if (all || keys?.includes('reasoning_effort')) {
          next.effort = this.initialEffort;
          override = undefined;
        }
        this.persist(next, override);
        return reasoningSettingsView(next);
      },
    };
  }

  /** Persist agent choices, leaving recipe-derived effort out of saved state. */
  private persist(settings: ReasoningSettings, effortOverride: ReasoningEffort | undefined): void {
    const { effort: _effort, ...reasoning } = settings;
    this.ctx?.setState({
      reasoning: {
        ...reasoning,
        ...(effortOverride === undefined ? {} : { effort: effortOverride, effortExplicit: true }),
      },
    });
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

}

/** The extension's wire view of reasoning settings (flat agent_settings keys). */
function reasoningSettingsView(r: ReasoningSettings): Record<string, unknown> {
  return {
    reasoning_enabled: r.enabled,
    reasoning_budget_tokens: r.budgetTokens,
    reasoning_display: r.display,
    reasoning_effort: r.effort,
  };
}

/**
 * Restored reasoning settings, field by field. Saved state is not trusted: an
 * older version or a hand edit can leave a value the API rejects, and since
 * display and effort are sent on every turn, one bad value would fail every
 * turn, leaving the agent no turn to fix the setting with. Such a value falls
 * back to the baseline, which is the default except for an effort the recipe
 * sets, and the host logs the value it uses instead, once for each saved value
 * it meets.
 */
function restoreReasoning(saved: unknown, baseline = DEFAULTS.reasoning, warned?: Set<string>): ReasoningSettings {
  const restored = clone(baseline);
  if (!saved || typeof saved !== 'object') return restored;
  const s = saved as Record<string, unknown>;
  const ignore = (field: keyof ReasoningSettings, value: unknown) => {
    const line = `[settings] ignoring saved reasoning.${field}=${JSON.stringify(value)}: not a valid value; using ${JSON.stringify(restored[field])}`;
    if (warned?.has(line)) return;
    warned?.add(line);
    console.error(line);
  };
  if (s.enabled !== undefined) {
    if (typeof s.enabled === 'boolean') restored.enabled = s.enabled;
    else ignore('enabled', s.enabled);
  }
  if (s.budgetTokens !== undefined) {
    if (typeof s.budgetTokens === 'number' && Number.isFinite(s.budgetTokens)) restored.budgetTokens = s.budgetTokens;
    else ignore('budgetTokens', s.budgetTokens);
  }
  if (s.display !== undefined) {
    if (s.display === 'summarized' || s.display === 'omitted') restored.display = s.display;
    else ignore('display', s.display);
  }
  if (s.effort !== undefined) {
    if (REASONING_EFFORTS.includes(s.effort as ReasoningEffort)) {
      restored.effort = savedEffortOverride(s) ?? baseline.effort;
    } else ignore('effort', s.effort);
  }
  return restored;
}

/** Legacy nondefault effort was an agent choice; legacy default means unset. */
function savedEffortOverride(saved: unknown): ReasoningEffort | undefined {
  if (!saved || typeof saved !== 'object') return undefined;
  const s = saved as Record<string, unknown>;
  if (!REASONING_EFFORTS.includes(s.effort as ReasoningEffort)) return undefined;
  return s.effort !== 'default' || s.effortExplicit === true ? s.effort as ReasoningEffort : undefined;
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}
