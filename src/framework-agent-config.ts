import { AgentFramework } from '@animalabs/agent-framework';
import type { Recipe } from './recipe.js';
import { DEFAULT_RECIPE_CLOCK } from './recipe.js';

type AgentConfig = Parameters<typeof AgentFramework.create>[0]['agents'][number];

export const DEFAULT_CONTEXT_BUDGET_TOKENS = 300_000;
const STREAM_HEADROOM_TOKENS = 20_000;
const FRAMEWORK_DEFAULT_MAX_STREAM_TOKENS = 150_000;

export function recipeModel(recipe: Recipe, envModel: string | undefined): string {
  return envModel || recipe.agent.model ||
    (recipe.agent.provider === 'openai-codex' ? 'gpt-5.4' : 'claude-opus-4-6');
}

export function effectiveContextBudgetTokens(recipe: Recipe): number {
  return recipe.agent.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
}

/**
 * An agent-framework that predates `agent.autoContinue` (agent-framework#744)
 * passes the key through and builds the agent without it, so turns end as
 * before with no other sign. One that supports it gives the built agent
 * (framework.getAgent) `autoContinue`, resolved.
 */
export function autoContinueSupportWarning(recipe: Recipe, agent: object | undefined): string | undefined {
  if (!recipe.agent.autoContinue || !agent) return undefined;
  if ((agent as { autoContinue?: unknown }).autoContinue !== undefined) return undefined;
  return '[agent-settings] agent.autoContinue is set, but the installed agent-framework predates it ' +
    '(agent-framework#744): turns end as before, without continuing, until it is upgraded.';
}

export type FrameworkAgentConfig = AgentConfig & {
  refusalHandling?: Recipe['agent']['refusalHandling'];
  sameRoundThinkTextPolicy?: 'public' | 'private';
  autoContinue?: Recipe['agent']['autoContinue'];
};

/**
 * Prompt caching went GA on Bedrock in April 2025 for 3.5 Haiku, 3.7 Sonnet,
 * and Claude 4+, but not for 3.5 Sonnet (either version): 1022 ("3.6") was
 * in the Dec 2024 preview and was dropped at GA, and Bedrock refuses it with
 * an account-level "your request did not allow prompt caching".
 */
export function bedrockModelSupportsPromptCaching(model: string): boolean {
  const id = model.toLowerCase();
  if (!id.includes('claude')) return false;
  return !/claude-(v2|instant|3-(opus|sonnet|haiku)|3-5-sonnet)(?![a-z0-9])/.test(id);
}

export function resolvePromptCaching(recipe: Recipe, model: string): boolean | undefined {
  if (recipe.agent.promptCaching !== undefined) return recipe.agent.promptCaching;
  if (recipe.agent.provider === 'bedrock') return bedrockModelSupportsPromptCaching(model);
  return undefined; // membrane default (on)
}

/**
 * Callers inside the agent's strategy, such as context-manager's
 * autobiographical compression and merge, send requests that don't set
 * promptCaching, which membrane's defaultPromptCaching then decides, so a
 * recipe's override is set at both layers.
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
    maxStreamTokens: recipe.agent.maxStreamTokens
      ?? (recipe.agent.contextBudgetTokens === undefined
        ? DEFAULT_CONTEXT_BUDGET_TOKENS + STREAM_HEADROOM_TOKENS
        : FRAMEWORK_DEFAULT_MAX_STREAM_TOKENS),
    contextBudgetTokens: effectiveContextBudgetTokens(recipe),
    // Bedrock offers only the default 5m cache, so cacheTtl isn't forwarded
    // there. agent-framework sends its own default ('1h') when the host omits it.
    ...(recipe.agent.cacheTtl && recipe.agent.provider !== 'bedrock'
      && { cacheTtl: recipe.agent.cacheTtl }),
    ...(promptCaching !== undefined && { promptCaching }),
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
    ...(recipe.agent.autoContinue !== undefined
      ? { autoContinue: recipe.agent.autoContinue }
      : {}),
    ...(recipe.agent.clock === false ? {} : { clock: recipe.agent.clock ?? { ...DEFAULT_RECIPE_CLOCK } }),
  };
}
