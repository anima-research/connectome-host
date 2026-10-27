import type { Membrane } from '@animalabs/membrane';
import type { Recipe, RecipeAgent, RecipeModules } from './recipe.js';
import type { RetrievalModuleConfig } from './modules/retrieval-module.js';
import { SUBAGENT_MESSAGE_CAP } from './modules/subagent-module.js';
import { strategyMessageCap } from './framework-strategy.js';

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
  return {
    ...buildRetrievalModuleConfig(membrane, recipe.modules?.retrieval, recipe.agent.provider),
    maxMessageTokens: retrievalMessageCap(recipe),
  };
}

export function retrievalMessageCap(recipe: Recipe): number | undefined {
  const caps = [strategyMessageCap(recipe), recipe.modules?.subagents ? SUBAGENT_MESSAGE_CAP : undefined]
    .filter((cap): cap is number => cap !== undefined && cap > 0);
  return caps.length > 0 ? Math.min(...caps) : undefined;
}
