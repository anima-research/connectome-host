import {
  AutobiographicalStrategy,
  PassthroughStrategy,
  type ContextStrategy,
} from '@animalabs/agent-framework';
import type { Recipe, RecipeStrategy } from './recipe.js';
import { FrontdeskStrategy } from './strategies/frontdesk-strategy.js';

const PASSTHROUGH_KEYS: ReadonlyArray<keyof RecipeStrategy> = [
  'enforceBudget',
  'maxSpeculativeL1s',
  'compressionRefusalCurveFallbacks',
  'compressionContextBudgetTokens',
  'positionedRecallPairs',
  'recallHeaderTemplate',
  'targetChunkTokens',
  'mergeThreshold',
  'summaryTargetTokens',
  'l1BudgetTokens',
  'l2BudgetTokens',
  'l3BudgetTokens',
  'toolResultMaxLastN',
  'toolUseInputMaxTokens',
  'adaptiveResolution',
  'kvStableReachTokens',
  'kvStableQualityGapRatio',
  'compressionSlackRatio',
  'overBudgetGraceRatio',
  'foldingStrategy',
  'speculativeProduction',
  'l1HoldbackChunks',
  'summaryParticipant',
  'summarySystemPrompt',
  'summaryUserPrompt',
  'summaryContextLabel',
];

export function buildFrameworkStrategy(
  recipe: Recipe,
  model: string,
  timeZone: string,
): ContextStrategy {
  const strategyConfig = recipe.agent.strategy;
  const strategyType = strategyConfig?.type ?? 'autobiographical';
  const autobiographicalOpts: Record<string, unknown> = {
    headWindowTokens: strategyConfig?.headWindowTokens ?? 4000,
    recentWindowTokens: strategyConfig?.recentWindowTokens ?? 30000,
    compressionModel: strategyConfig?.compressionModel ?? model,
    autoTickOnNewMessage: true,
    maxMessageTokens: strategyConfig?.maxMessageTokens ?? 10000,
    ...(strategyType === 'frontdesk' ? { timeZone } : {}),
  };

  for (const key of PASSTHROUGH_KEYS) {
    const value = strategyConfig?.[key];
    if (value !== undefined) autobiographicalOpts[key] = value;
  }

  // Autobiographical agents default to adaptive resolution unless a recipe
  // opts out; frontdesk keeps its historical hierarchical renderer default.
  if (strategyType === 'autobiographical' && autobiographicalOpts.adaptiveResolution === undefined) {
    autobiographicalOpts.adaptiveResolution = true;
  }

  return strategyType === 'passthrough'
    ? new PassthroughStrategy()
    : strategyType === 'frontdesk'
      ? new FrontdeskStrategy(autobiographicalOpts)
      : new AutobiographicalStrategy(autobiographicalOpts);
}
