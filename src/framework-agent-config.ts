import { AgentFramework } from '@animalabs/agent-framework';
import type { Recipe } from './recipe.js';
import { DEFAULT_RECIPE_CLOCK } from './recipe.js';

type AgentConfig = Parameters<typeof AgentFramework.create>[0]['agents'][number];

/** Compile budget for a recipe that omits `agent.contextBudgetTokens`. Sized
 *  for the 1M-window models; a recipe on a smaller window must set its own
 *  (budget + maxTokens has to fit under the window). */
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 300_000;

/** The model a recipe's agent runs: `envModel`, the environment's `MODEL`,
 *  when it's set, else the recipe's own, else its provider's default. */
export function recipeModel(recipe: Recipe, envModel: string | undefined): string {
  return envModel || recipe.agent.model ||
    (recipe.agent.provider === 'openai-codex' ? 'gpt-5.4' : 'claude-opus-4-6');
}

/** The compile budget the recipe configures: its own, else the default. A
 *  runtime override (agent settings) can still move the live budget. */
export function effectiveContextBudgetTokens(recipe: Recipe): number {
  return recipe.agent.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
}

export type FrameworkAgentConfig = AgentConfig & {
  // Forward recipe fields that newer Agent Framework releases understand
  // while remaining structurally compatible with older installs.
  refusalHandling?: Recipe['agent']['refusalHandling'];
  sameRoundThinkTextPolicy?: 'public' | 'private';
};

/**
 * Prompt caching went GA on Bedrock in April 2025 for 3.5 Haiku, 3.7
 * Sonnet, and Claude 4+ — but NOT for 3.5 Sonnet (either version). 1022
 * ("3.6") was in the Dec 2024 preview and was dropped at GA — that
 * account-level "your request did not allow prompt caching" is the error
 * observed here 2026-07-21 (antra's diagnosis, confirmed against the AWS
 * docs 2026-07-31; as of the same day's live probe every 3.5-era model
 * is EOL on Bedrock anyway). So the gate denies the pre-GA FAMILIES —
 * Claude v2/instant, Claude 3, 3.5 Sonnet — at the family boundary, so
 * dated ids, bare aliases, -latest, and inference-profile forms
 * (us.anthropic.claude-...) all resolve the same; 3.5 Haiku and 3.7
 * Sonnet stay distinct and on. Non-Claude Bedrock ids (Nova etc.) are
 * out of scope for this gate and conservatively off — membrane's
 * BedrockAdapter only accepts Claude ids today. recipe.agent.
 * promptCaching overrides in either direction for accounts/regions
 * whose entitlements differ from the GA table. (Connectome issue #35.)
 */
export function bedrockModelSupportsPromptCaching(model: string): boolean {
  const id = model.toLowerCase();
  if (!id.includes('claude')) return false;
  // (?![a-z0-9]) = family boundary: end of id, or a separator (-, ., :)
  // before a date/qualifier — matches the whole family, not one spelling.
  return !/claude-(v2|instant|3-(opus|sonnet|haiku)|3-5-sonnet)(?![a-z0-9])/.test(id);
}

export function resolvePromptCaching(recipe: Recipe, model: string): boolean | undefined {
  if (recipe.agent.promptCaching !== undefined) return recipe.agent.promptCaching;
  if (recipe.agent.provider === 'bedrock') return bedrockModelSupportsPromptCaching(model);
  return undefined; // membrane default (on)
}

/**
 * Membrane-level counterpart of resolvePromptCaching, spread into the
 * Membrane constructor config. The per-agent flag only governs agent
 * inference; internal callers (autobio compression, executeMerge) read
 * Membrane's defaultPromptCaching — so an explicit recipe override must
 * land at BOTH layers, on every provider, or `promptCaching: false` on
 * an Anthropic recipe would silently keep caching on for internal calls.
 */
export function membraneCachingOverride(
  recipe: Recipe,
  model: string,
): { defaultPromptCaching?: boolean } {
  const promptCaching = resolvePromptCaching(recipe, model);
  return promptCaching === undefined ? {} : { defaultPromptCaching: promptCaching };
}

export function buildFrameworkAgentConfig(
  recipe: Recipe,
  agentName: string,
  model: string,
  strategy: FrameworkAgentConfig['strategy'],
): FrameworkAgentConfig {
  const promptCaching = resolvePromptCaching(recipe, model);
  let thinking: FrameworkAgentConfig['thinking'];
  if (recipe.agent.thinking) {
    // Effort is a host setting sent as output_config.effort, never as thinking.effort.
    const { effort: _hostEffort, ...providerThinking } = recipe.agent.thinking;
    thinking = providerThinking;
  }
  return {
    name: agentName,
    ...(recipe.agent.toolPresentation ? {toolPresentation: recipe.agent.toolPresentation} : {}),
    model,
    systemPrompt: recipe.agent.systemPrompt,
    ...(recipe.agent.allowedTools !== undefined
      ? { allowedTools: recipe.agent.allowedTools }
      : {}),
    maxTokens: recipe.agent.maxTokens ?? 16384,
    // An omitted maxStreamTokens follows the budget (+20k) only when the
    // budget is the host default too. A recipe that sets its own budget may be
    // on a 200k-window model, where budget + 20k would let a stream grow past
    // the window; it keeps the framework's historical 150k.
    maxStreamTokens: recipe.agent.maxStreamTokens
      ?? (recipe.agent.contextBudgetTokens === undefined ? DEFAULT_CONTEXT_BUDGET_TOKENS + 20_000 : 150_000),
    contextBudgetTokens: effectiveContextBudgetTokens(recipe),
    // cacheTtl is withheld at the HOST layer on bedrock: the transport
    // only has the default 5m cache, and older membrane releases forward
    // the ttl field Bedrock rejects. Note this is not the whole story —
    // Agent Framework still supplies its own default ('1h') downstream
    // when the host omits the field, and membrane ≥0.5.77 strips it at
    // the provider boundary before wire dispatch. Requests are safe, but
    // pre-adapter config is NOT cache-TTL telemetry; the wire truth lives
    // at the adapter.
    ...(recipe.agent.cacheTtl && recipe.agent.provider !== 'bedrock'
      && { cacheTtl: recipe.agent.cacheTtl }),
    ...(promptCaching !== undefined && { promptCaching }),
    // Prefill scaffold (anthropic-xml formatter), e.g. chapterx CLI-sim's
    // '<cmd>cat untitled.txt</cmd>' — part of migrating prefill-era bots.
    ...(recipe.agent.prefillUserMessage && { prefillUserMessage: recipe.agent.prefillUserMessage }),
    ...((recipe.agent.provider === 'openai-responses' || recipe.agent.provider === 'openai-codex') && {
      providerParams: {
        reasoning: {
          effort: recipe.agent.responses?.reasoningEffort ?? 'high',
          context: recipe.agent.responses?.reasoningContext ?? 'all_turns',
        },
        ...(recipe.agent.provider === 'openai-responses' ? {
          ...(recipe.agent.responses?.serviceTier ? {
            service_tier: recipe.agent.responses.serviceTier,
          } : {}),
          ...(recipe.agent.responses?.compactThreshold ? {
            context_management: [{
              type: 'compaction',
              compact_threshold: recipe.agent.responses.compactThreshold,
            }],
          } : {}),
        } : {}),
      },
    }),
    strategy,
    ...(thinking && { thinking }),
    ...(recipe.agent.refusalHandling && { refusalHandling: recipe.agent.refusalHandling }),
    ...(recipe.agent.sameRoundThinkTextPolicy !== undefined
      ? { sameRoundThinkTextPolicy: recipe.agent.sameRoundThinkTextPolicy }
      : {}),
    ...(recipe.agent.proseRouting !== undefined
      ? { proseRouting: recipe.agent.proseRouting }
      : {}),
    ...(recipe.agent.toolWrapperProseGuard !== undefined
      ? { toolWrapperProseGuard: recipe.agent.toolWrapperProseGuard }
      : {}),
    // Ten-minute clock rows unless the recipe names its own or turns them off (false).
    ...(recipe.agent.clock === false ? {} : { clock: recipe.agent.clock ?? { ...DEFAULT_RECIPE_CLOCK } }),
  };
}
