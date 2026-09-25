import type { Recipe } from './recipe.js';

/**
 * Presentation name for an agent: the recipe's `agent.displayName` for the
 * recipe's own agent, otherwise the technical name unchanged. Use ONLY where
 * people read names (dashboard, human-facing status). Everything that
 * identifies (Chronicle participants, strategy namespaces, paths, routing,
 * tools, platform ids, integrity checks) uses the technical name.
 */
export function agentDisplayName(recipe: Pick<Recipe, 'agent'>, agentName: string): string {
  const display = recipe.agent?.displayName?.trim();
  return display && agentName === recipe.agent?.name ? display : agentName;
}
