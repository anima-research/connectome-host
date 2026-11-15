import type { Recipe } from './recipe.js';
import { recipeModel, resolveProvider } from './recipe.js';
import { modelAcceptsEffort } from './logging-adapter.js';

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
 * What the gate's reply judge and suppression review are steered with: the
 * override, where there is one, and whether the route takes Anthropic's
 * `output_config` (gateOptionsFor sends `effort: 'none'` elsewhere).
 */
export function auxiliarySteering(recipe: Recipe): { model: string; anthropicEffort: boolean } | undefined {
  const model = auxiliaryModelOverride(recipe);
  if (model === undefined) return undefined;
  // The route takes `output_config`, and the model named takes an effort
  // (the host's own table: Haiku 4.5 and Sonnet 4.5 refuse it with a 400);
  // otherwise `effort: 'none'`, the model's default. (R3-2)
  return { model, anthropicEffort: servesAnthropicIds(recipe) && modelAcceptsEffort(model, 'low') };
}

/** Whether the host chose the model itself (the resident's), as against the recipe naming one. */
function hostChoseModel(recipe: Recipe): boolean {
  return !recipe.auxiliaryModel && !servesAnthropicIds(recipe);
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
 *   low reasoning effort, where the model is the one the host chose, the
 *   resident's, which takes it (the resident's turns run at `high`); a model
 *   the recipe named is sent as it is, since a non-reasoning model refuses a
 *   `reasoning` object (#650 R2-5). On Codex in subscription mode membrane
 *   sends no cap at all, so the room is a bound elsewhere only.
 */
export function auxiliaryRequest(recipe: Recipe, maxTokens: number): {
  config: { model: string; maxTokens: number };
  providerParams?: Record<string, unknown>;
} {
  const provider = resolveProvider(recipe);
  const responsesFamily = provider === 'openai-responses' || provider === 'openai-codex';
  const model = auxiliaryModel(recipe);
  // The caller's cap is for the Haiku 4.5 default alone. Any other Claude
  // id may think before it answers: Fable and Mythos on every call, and the
  // 4.6+ models whenever the host's adapter adds adaptive thinking to these
  // calls (LoggingAnthropicAdapter.complete, with the reasoning setting on).
  // Only generated tokens are billed, so the room costs nothing unused. (R3-4)
  const roomNeeded = !servesAnthropicIds(recipe) || model !== ANTHROPIC_AUXILIARY_MODEL;
  return {
    config: {
      model,
      maxTokens: roomNeeded ? Math.max(maxTokens, AUXILIARY_REASONING_ROOM) : maxTokens,
    },
    ...(responsesFamily && hostChoseModel(recipe) ? { providerParams: { reasoning: { effort: 'low' } } } : {}),
  };
}
