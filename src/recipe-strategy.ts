/** Built-in recipe strategy boundary; extension factories receive their own config verbatim. */
import { validateCompressionInstructions } from '@animalabs/context-manager';
import type { RecipeStrategy } from './recipe.js';
import { isBuiltinStrategyType } from './extensions.js';

export const PASSTHROUGH_KEYS = [
  'enforceBudget',
  'maxSpeculativeL1s',
  'compressionRefusalCurveFallbacks',
  'compressionContextBudgetTokens',
  'compressionSourceOnly',
  'compressionSourceOnlyFallback',
  'compressionMergeSourceOnly',
  'compressionMergeSourceOnlyFallback',
  'compressionToolProseFallback',
  'compressionSplitFallback',
  'compressionSplitPlaceholder',
  'compressionSplitMaxCallsPerChunk',
  'compressionSplitMaxCallsPer10Min',
  'compressionRecallBudgetTokens',
  'recoverLiteralThinkingWrappedCompression',
  'positionedRecallPairs',
  'recallHeaderTemplate',
  'carrierPolicy',
  'targetChunkTokens',
  'mergeThreshold',
  'mergeMaxSourceSpanMessages',
  'summaryTargetTokens',
  'productionBudgetTokens',
  'l1BudgetTokens',
  'l2BudgetTokens',
  'l3BudgetTokens',
  'toolResultMaxLastN',
  'toolUseInputMaxTokens',
  'maxLiveImages',
  'imageStripDepthTokens',
  'maxLiveImageBytes',
  'adaptiveResolution',
  'kvStableReachTokens',
  'kvStableQualityGapRatio',
  'compressionSlackRatio',
  'overBudgetGraceRatio',
  'foldingStrategy',
  'kvUnified',
  'speculativeProduction',
  'l1HoldbackChunks',
  'summaryParticipant',
  'summarySystemPrompt',
  'summaryUserPrompt',
  'summaryContextLabel',
  'witnessedBeforeSequence',
  'witnessedInstruction',
  'compressionInstructions',
  'identityReminder',
  'witnessedIdentityReminder',
] as const satisfies ReadonlyArray<keyof RecipeStrategy>;

export function validateBuiltinStrategy(strategy: Record<string, unknown>): void {
  const type = strategy.type ?? 'autobiographical';
  // A custom factory owns validation and receives the entire strategy object.
  if (typeof type !== 'string' || !isBuiltinStrategyType(type)) return;
  // The forwarding list is not an admission schema for unrelated recipe keys.
  if (strategy.compressionInstructions === undefined) return;
  if (type !== 'autobiographical') {
    throw new TypeError('Recipe compressionInstructions requires an autobiographical strategy.');
  }
  validateCompressionInstructions(strategy.compressionInstructions);
  // CM's cross-option constructor conflict is outside its nested validator.
  if (strategy.witnessedInstruction && strategy.compressionInstructions.templates?.witnessedChunk !== undefined) {
    throw new TypeError('Conflicting witnessed instruction configuration');
  }
}
