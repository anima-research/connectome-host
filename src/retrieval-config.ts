import type { RecipeModules } from './recipe.js';
import type { RetrievalModuleConfig } from './modules/retrieval-module.js';
import type { RetrievalModels } from './modules/retrieval-models.js';

type RetrievalRecipeConfig = Exclude<RecipeModules['retrieval'], boolean | undefined>;

/** Translate the recipe's retrieval block into the module's runtime config. */
export function buildRetrievalModuleConfig(
  models: RetrievalModels,
  retrieval: RecipeModules['retrieval'],
): RetrievalModuleConfig {
  const config: RetrievalRecipeConfig = typeof retrieval === 'object' ? retrieval : {};
  return {
    models,
    ...(config.maxInjected !== undefined ? { maxInjectedLessons: config.maxInjected } : {}),
    ...(config.maxCandidates !== undefined ? { maxCandidates: config.maxCandidates } : {}),
    ...(config.relevanceThreshold !== undefined ? { relevanceThreshold: config.relevanceThreshold } : {}),
  };
}
