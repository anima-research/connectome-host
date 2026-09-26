import type { Membrane } from '@animalabs/membrane';
import type { RecipeAgent, RecipeModules } from './recipe.js';
import type { RetrievalModuleConfig } from './modules/retrieval-module.js';

type RetrievalRecipeConfig = Exclude<RecipeModules['retrieval'], boolean | undefined>;

/** Translate the recipe's retrieval block into the module's runtime config. */
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
    maxCandidates: config.maxCandidates,
  };
}
