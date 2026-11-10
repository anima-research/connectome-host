import type { Recipe } from './recipe.js';
import { recipeModel, resolveProvider } from './recipe.js';

/** The small Anthropic model the host's auxiliary calls went to, on every provider, before #649. */
export const ANTHROPIC_AUXILIARY_MODEL = 'claude-haiku-4-5-20251001';

/**
 * The model the host's own small calls go to: the session name (synesthete),
 * the TUI's fleet-view activity summaries. They go through the host's one
 * membrane, so the model has to be one the recipe's provider serves:
 * `configured` (a recipe's choice) when given, else Claude Haiku on the
 * `anthropic` route, else the resident's own model, which the provider
 * certainly serves. Before, every provider was sent the Haiku id: Codex
 * refused it ("model is not supported"), OpenRouter too ("not a valid model
 * ID"), and the callers swallowed the error, so a Codex or OpenRouter host
 * never named a session and wrote an error row to llm-calls for each try.
 */
export function auxiliaryModel(recipe: Recipe, configured?: string): string {
  if (configured) return configured;
  if (resolveProvider(recipe) === 'anthropic') return ANTHROPIC_AUXILIARY_MODEL;
  return recipeModel(recipe, process.env.MODEL);
}
