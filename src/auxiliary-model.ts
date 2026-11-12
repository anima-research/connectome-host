import type { Recipe } from './recipe.js';
import { recipeModel, resolveProvider } from './recipe.js';

/** The small Anthropic model the host's auxiliary calls went to, on every provider, before #649. */
export const ANTHROPIC_AUXILIARY_MODEL = 'claude-haiku-4-5-20251001';

/**
 * The cap on a short auxiliary answer where the model may reason before it
 * answers: on the Responses API the cap counts reasoning tokens, and on
 * OpenRouter a reasoning model's `max_tokens` does too, so a 30-token cap
 * there can be spent before the first word of the answer. The callers'
 * length checks keep the answer short; this only leaves the room.
 */
export const AUXILIARY_REASONING_ROOM = 1024;

/**
 * Whether the recipe's provider serves Anthropic's model ids as such: the
 * `anthropic` route, and Bedrock, whose adapter maps a Claude id to its
 * inference profile. Where it does, agent-framework's and the retrieval
 * module's own Haiku defaults are servable and the host leaves them alone.
 */
export function servesAnthropicIds(recipe: Recipe): boolean {
  const provider = resolveProvider(recipe);
  return provider === 'anthropic' || provider === 'bedrock';
}

/**
 * The model the host steers its own small calls to when it must: the
 * recipe's `auxiliaryModel` where one is named, else the resident's own
 * model on a provider that doesn't serve Anthropic's ids (Codex refused the
 * Haiku id with "model is not supported", OpenRouter with "not a valid model
 * ID", #649), else `undefined`: on `anthropic` and Bedrock each call keeps
 * the small-model default it had.
 */
export function auxiliaryModelOverride(recipe: Recipe): string | undefined {
  if (recipe.auxiliaryModel) return recipe.auxiliaryModel;
  return servesAnthropicIds(recipe) ? undefined : recipeModel(recipe, process.env.MODEL);
}

/**
 * The model the session name (synesthete) and the TUI's fleet-view activity
 * summaries go to: the override above, or the Haiku id those calls always
 * sent on the `anthropic` route.
 */
export function auxiliaryModel(recipe: Recipe): string {
  return auxiliaryModelOverride(recipe) ?? ANTHROPIC_AUXILIARY_MODEL;
}

/**
 * The request fields of one of the host's own short calls (a session name,
 * a status phrase), as the recipe's provider takes them:
 * - the model, from `auxiliaryModel`;
 * - no temperature: Anthropic's current models and every `gpt-5`+ model
 *   refuse one with a 400, and the naming call's 0.8 was not worth that on
 *   any route; the model's default samples;
 * - `maxTokens`: the caller's cap on the `anthropic` and Bedrock routes, else
 *   at least AUXILIARY_REASONING_ROOM, so a model that reasons before it
 *   answers has an answer left;
 * - on the Responses-family routes (`openai-responses`, `openai-codex`), a
 *   low reasoning effort, as the retrieval module's own small calls set,
 *   where the resident's turns run at `high`.
 */
export function auxiliaryRequest(recipe: Recipe, maxTokens: number): {
  config: { model: string; maxTokens: number };
  providerParams?: Record<string, unknown>;
} {
  const provider = resolveProvider(recipe);
  const responsesFamily = provider === 'openai-responses' || provider === 'openai-codex';
  return {
    config: {
      model: auxiliaryModel(recipe),
      // Anthropic's models reason only when asked to (thinking), and these requests don't ask.
      maxTokens: servesAnthropicIds(recipe) ? maxTokens : Math.max(maxTokens, AUXILIARY_REASONING_ROOM),
    },
    ...(responsesFamily ? { providerParams: { reasoning: { effort: 'low' } } } : {}),
  };
}
