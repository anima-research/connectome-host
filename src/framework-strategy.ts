import {
  AutobiographicalStrategy,
  PassthroughStrategy,
  type ContextStrategy,
  type ConversationRouterConfig,
} from '@animalabs/agent-framework';
import type { Recipe, RecipeStrategy } from './recipe.js';
import { FrontdeskStrategy } from './strategies/frontdesk-strategy.js';
import { isBuiltinStrategyType, type ExtensionRegistry } from './extensions.js';

const PASSTHROUGH_KEYS: ReadonlyArray<keyof RecipeStrategy> = [
  'enforceBudget',
  'maxSpeculativeL1s',
  'compressionRefusalCurveFallbacks',
  'compressionContextBudgetTokens',
  'compressionSourceOnly',
  'compressionSourceOnlyFallback',
  'compressionMergeSourceOnly',
  'compressionMergeSourceOnlyFallback',
  'compressionSplitFallback',
  'compressionSplitPlaceholder',
  'compressionRecallBudgetTokens',
  'positionedRecallPairs',
  'recallHeaderTemplate',
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
  'identityReminder',
];

export function buildFrameworkStrategy(
  recipe: Recipe,
  model: string,
  timeZone: string,
  extensions?: ExtensionRegistry,
): ContextStrategy {
  const strategyConfig = recipe.agent.strategy;
  const strategyType = strategyConfig?.type ?? 'autobiographical';

  // Non-built-in types resolve through the extension registry. Validation
  // already required a strategy-kind extension to be declared; this catches
  // the declared-but-didn't-register case with a precise error.
  if (!isBuiltinStrategyType(strategyType)) {
    const factory = extensions?.strategies.get(strategyType);
    if (!factory) {
      const known = extensions ? Array.from(extensions.strategies.keys()) : [];
      throw new Error(
        `strategy type "${strategyType}" is not built-in and no loaded extension registered it. ` +
        `Registered custom types: ${known.length ? known.join(', ') : '(none)'}.`,
      );
    }
    return factory({
      config: (strategyConfig ?? {}) as RecipeStrategy & Record<string, unknown>,
      model,
      timeZone,
    });
  }
  const autobiographicalOpts: Record<string, unknown> = {
    headWindowTokens: strategyConfig?.headWindowTokens ?? 4000,
    recentWindowTokens: strategyConfig?.recentWindowTokens ?? 30000,
    compressionModel: strategyConfig?.compressionModel ?? model,
    ...(strategyConfig?.compressionMaxTokens !== undefined
      ? { compressionMaxTokens: strategyConfig.compressionMaxTokens }
      : {}),
    autoTickOnNewMessage: true,
    maxMessageTokens: strategyConfig?.maxMessageTokens ?? 10000,
    ...(strategyType === 'frontdesk' ? { timeZone } : {}),
  };

  for (const key of PASSTHROUGH_KEYS) {
    const value = strategyConfig?.[key];
    if (value !== undefined) autobiographicalOpts[key] = value;
  }

  // Autobiographical AND frontdesk agents default to adaptive resolution
  // unless a recipe opts out. Frontdesk historically kept the hierarchical
  // renderer; that geometry has no tail reservation and no way to shed
  // summary mass, so a long-lived agent saturates a fixed budget into a
  // terminal context refusal (2026-08-03 boter clerk outage). The adaptive
  // picker solves a frontier to fit — recipes can still pin
  // `adaptiveResolution: false` as a rollback lever.
  if (
    (strategyType === 'autobiographical' || strategyType === 'frontdesk') &&
    autobiographicalOpts.adaptiveResolution === undefined
  ) {
    autobiographicalOpts.adaptiveResolution = true;
  }

  // Reasonable memory defaults for recipes that omit strategy tuning:
  //
  // - foldingStrategy 'kv-stable': the library's own fallback is
  //   'flat-profile', which replans compile layouts without regard for
  //   prompt-cache stability. Long-lived agents want cache-stable folds by
  //   default; recipes can still pin 'flat-profile'/'oldest-first' explicitly.
  //   (Only meaningful under adaptive resolution, so gate on it.)
  // - summaryParticipant <agent name>: the library falls back to the literal
  //   'Claude', which voices self-recollections as a stranger for any agent
  //   not named Claude. Summaries should speak as the agent itself.
  if (
    (strategyType === 'autobiographical' || strategyType === 'frontdesk') &&
    autobiographicalOpts.adaptiveResolution !== false &&
    autobiographicalOpts.foldingStrategy === undefined
  ) {
    autobiographicalOpts.foldingStrategy = 'kv-stable';
  }
  if (autobiographicalOpts.summaryParticipant === undefined && recipe.agent.name) {
    autobiographicalOpts.summaryParticipant = recipe.agent.name;
  }

  return strategyType === 'passthrough'
    ? new PassthroughStrategy()
    : strategyType === 'frontdesk'
      ? new FrontdeskStrategy(autobiographicalOpts)
      : new AutobiographicalStrategy(autobiographicalOpts);
}

/**
 * Map a recipe's `conversations` block to the framework's
 * ConversationRouterConfig. The host supplies the two fields a recipe
 * cannot: `templateAgent` is the recipe's own (sole) agent, and
 * `strategyFactory` builds a FRESH instance of the recipe's configured
 * strategy per fork — strategy instances are stateful and must never be
 * shared between ContextManagers (without a factory the framework would
 * silently give forks passthrough, i.e. no compression).
 */
export function buildConversationsConfig(
  recipe: Recipe,
  agentName: string,
  model: string,
  timeZone: string,
  extensions?: ExtensionRegistry,
): ConversationRouterConfig | undefined {
  const conv = recipe.conversations;
  if (!conv) return undefined;
  return {
    templateAgent: agentName,
    ...(conv.bind !== undefined ? { bind: conv.bind } : {}),
    ...(conv.trigger !== undefined ? { trigger: conv.trigger } : {}),
    ...(conv.idleTtlMs !== undefined ? { idleTtlMs: conv.idleTtlMs } : {}),
    ...(conv.closurePrompt !== undefined ? { closurePrompt: conv.closurePrompt } : {}),
    ...(conv.agentPrefix !== undefined ? { agentPrefix: conv.agentPrefix } : {}),
    strategyFactory: () => buildFrameworkStrategy(recipe, model, timeZone, extensions),
  };
}
