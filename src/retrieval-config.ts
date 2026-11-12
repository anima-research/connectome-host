import type { Membrane } from '@animalabs/membrane';
import type { Recipe, RecipeAgent, RecipeModules } from './recipe.js';
import type { RetrievalModuleConfig } from './modules/retrieval-module.js';
import { SUBAGENT_MESSAGE_CAP } from './modules/subagent-module.js';
import { strategyMessageCap } from './framework-strategy.js';
import { auxiliaryModelOverride } from './auxiliary-model.js';

type RetrievalRecipeConfig = Exclude<RecipeModules['retrieval'], boolean | undefined>;

export function buildRetrievalModuleConfig(
  membrane: Membrane,
  retrieval: RecipeModules['retrieval'],
  provider: RecipeAgent['provider'] = 'anthropic',
): RetrievalModuleConfig {
  const config: RetrievalRecipeConfig = typeof retrieval === 'object' ? retrieval : {};
  if (config.reasoningEffort
      && provider !== 'openai-responses'
      && provider !== 'openai-codex') {
    throw new Error(
      'modules.retrieval.reasoningEffort requires agent.provider ' +
      '"openai-responses" or "openai-codex".',
    );
  }
  if (config.reasoningEffort
      && (typeof config.model !== 'string' || !config.model.trim())) {
    throw new Error(
      'modules.retrieval.model must be a non-empty string when ' +
      'modules.retrieval.reasoningEffort is configured.',
    );
  }
  const retrievalReasoning = config.reasoningEffort
    ? { effort: config.reasoningEffort }
    : undefined;

  return {
    membrane,
    retrievalModel: config.model,
    retrievalReasoning,
    maxInjectedLessons: config.maxInjected,
  };
}

export function retrievalModuleConfig(membrane: Membrane, recipe: Recipe): RetrievalModuleConfig {
  const config = buildRetrievalModuleConfig(membrane, recipe.modules?.retrieval, recipe.agent.provider);
  return {
    ...config,
    // Where the recipe names no model and the provider doesn't serve the
    // module's own Haiku default, the host's auxiliary model: before, every
    // turn's concept extraction on Codex or OpenRouter sent the Haiku id,
    // was refused, and injected no lessons (#649).
    retrievalModel: config.retrievalModel ?? auxiliaryModelOverride(recipe),
    maxMessageTokens: retrievalMessageCap(recipe),
  };
}

export function retrievalMessageCap(recipe: Recipe): number | undefined {
  const caps = [strategyMessageCap(recipe), recipe.modules?.subagents ? SUBAGENT_MESSAGE_CAP : undefined]
    .filter((cap): cap is number => cap !== undefined && cap > 0);
  return caps.length > 0 ? Math.min(...caps) : undefined;
}
