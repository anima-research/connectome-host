import type { NormalizedRequest } from '@animalabs/membrane';
import type { Recipe } from './recipe.js';
import { auxiliaryRequest } from './auxiliary-model.js';

/**
 * The TUI fleet view's status-phrase request for one agent's recent
 * activity: the host's auxiliary model (auxiliaryRequest: the model, cap and
 * reasoning effort the recipe's provider takes) asked for 5-10 words on
 * `window`, the newest stretch of the agent's transcript.
 */
export function activitySummaryRequest(recipe: Recipe, window: string): NormalizedRequest {
  return {
    messages: [{
      participant: 'user',
      content: [{ type: 'text', text: `Agent activity stream:\n\n${window}\n\nWhat is this agent doing right now? Answer in 5-10 words.` }],
    }],
    system: 'You distill an agent\'s activity into a terse status phrase. 5-10 words max. No punctuation. Specific, not generic.',
    ...auxiliaryRequest(recipe, 40),
  };
}
