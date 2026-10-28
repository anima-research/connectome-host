import {
  AutobiographicalStrategy,
  PassthroughStrategy,
  type ContextStrategy,
  type ConversationRouterConfig,
  type FrameworkConfig,
  type SubconsciousConfig,
} from '@animalabs/agent-framework';
import type { Recipe, RecipeKvUnifiedConfig, RecipeStrategy } from './recipe.js';
import { anthropicCacheReadMultiplier, openaiCacheMultipliers } from './call-pricing.js';
import { resolvePromptCaching } from './framework-agent-config.js';
import { defaultRecentWindowTokens, headWindowTokens } from './recipe-fit.js';
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
  'identityReminder',
  'witnessedIdentityReminder',
  'identityReminderSilent',
];

/**
 * Cache prices are multiples of the model's base input price, as the
 * provider bills them: Anthropic writes at 2x on the 1-hour cache and 1.25x
 * on the 5-minute one, and Bedrock has only the 5-minute cache. Reads, and
 * OpenAI's prices, come from the pricing table (anthropicCacheReadMultiplier,
 * openaiCacheMultipliers), where Sonnet 5.5 takes 0.1x, as its entry
 * explains.
 */
export function standardKvUnifiedConfig(recipe: Recipe, model: string): RecipeKvUnifiedConfig {
  const provider = recipe.agent.provider;
  const ttl = provider === 'bedrock' ? '5m' : (recipe.agent.cacheTtl ?? '1h');
  const uncached = resolvePromptCaching(recipe, model) === false;
  const prices = uncached
    ? { read: 1, write: 1 }
    : provider === 'openai-responses' || provider === 'openai-codex'
      ? openaiCacheMultipliers(model, provider === 'openai-codex' ? 'codex' : 'api')
      : { read: anthropicCacheReadMultiplier(model), write: ttl === '5m' ? 1.25 : 2 };
  return {
    policy: {
      alpha: 0.7,
      budgetLowRatio: 0.6,
      budgetHighRatio: 0.85,
      budgetUnderLambda: 1_000,
      budgetOverLambda: 4_000,
      cacheLambda: 1,
      cacheScale: 100_000,
      cacheReadPrice: prices.read,
      cacheWritePrice: prices.write,
      continuityLambda: 1,
      continuityScale: 100_000,
      continuityRecencyHalfLifeTokens: 100_000,
      continuityRecencyFloor: 0.2,
      continuityStableHalfLife: 16,
      continuityStableFloor: 0.25,
    },
    tokenBucketSize: 50_000,
    continuityBucketSize: 50_000,
    fidelityBucketSize: 100_000,
    labelCeiling: 100_000,
    adoptEpsilon: 3_000,
    treeifyNonContiguousSummaries: false,
    preserveGapBearingSummaries: false,
    hysteresisCertificate: true,
  };
}

export function strategyMessageCap(recipe: Recipe): number | undefined {
  const strategyConfig = recipe.agent.strategy;
  const strategyType = strategyConfig?.type ?? 'autobiographical';
  if (strategyType === 'passthrough') return undefined;
  if (!isBuiltinStrategyType(strategyType)) return strategyConfig?.maxMessageTokens;
  return strategyConfig?.maxMessageTokens ?? 10000;
}

export function buildFrameworkStrategy(
  recipe: Recipe,
  model: string,
  timeZone: string,
  extensions?: ExtensionRegistry,
): ContextStrategy {
  const strategyConfig = recipe.agent.strategy;
  const strategyType = strategyConfig?.type ?? 'autobiographical';

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
    headWindowTokens: headWindowTokens(recipe),
    recentWindowTokens: strategyConfig?.recentWindowTokens ?? defaultRecentWindowTokens(recipe, model),
    compressionModel: strategyConfig?.compressionModel ?? model,
    ...(strategyConfig?.compressionMaxTokens !== undefined
      ? { compressionMaxTokens: strategyConfig.compressionMaxTokens }
      : {}),
    autoTickOnNewMessage: true,
    maxMessageTokens: strategyMessageCap(recipe),
    ...(strategyType === 'frontdesk' ? { timeZone } : {}),
  };

  for (const key of PASSTHROUGH_KEYS) {
    const value = strategyConfig?.[key];
    if (value !== undefined) autobiographicalOpts[key] = value;
  }

  if (
    (strategyType === 'autobiographical' || strategyType === 'frontdesk') &&
    autobiographicalOpts.adaptiveResolution === undefined
  ) {
    autobiographicalOpts.adaptiveResolution = true;
  }

  // context-manager's own defaults, which these replace for a recipe that
  // leaves them out: under adaptive resolution its folding strategy is
  // 'flat-profile', which plans layouts without regard for the prompt cache;
  // kv-unified takes no defaults and refuses an incomplete kvUnified block;
  // and its summary participant is the literal 'Claude', which voices the
  // agent's own recollections as a stranger's.
  if (
    (strategyType === 'autobiographical' || strategyType === 'frontdesk') &&
    autobiographicalOpts.adaptiveResolution !== false &&
    autobiographicalOpts.foldingStrategy === undefined
  ) {
    autobiographicalOpts.foldingStrategy = 'kv-unified';
  }
  if (autobiographicalOpts.foldingStrategy === 'kv-unified' && autobiographicalOpts.kvUnified === undefined) {
    autobiographicalOpts.kvUnified = standardKvUnifiedConfig(recipe, model);
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
 * agent-framework gives a fork a passthrough strategy, with no compression,
 * when no strategyFactory is given, so the factory builds a new instance of
 * the recipe's strategy for each fork: a strategy instance holds state and
 * can't be shared between context managers.
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

/**
 * Map a recipe's `subconscious` block to the framework's SubconsciousConfig
 * (agent-framework#77, #232). The persistent reader passes through verbatim;
 * the framework owns its defaults. Reader forks get the one field a recipe
 * cannot state: `strategyFactory`, a FRESH instance of the recipe's strategy
 * per fork (the `conversations` pattern), so a fork reuses the resident's
 * fold state and rendering. Without it the framework refuses forks unless
 * the resident runs a passthrough strategy.
 */
export function buildSubconsciousConfig(
  recipe: Recipe,
  model: string,
  timeZone: string,
  extensions?: ExtensionRegistry,
): SubconsciousConfig | undefined {
  const sub = recipe.subconscious;
  if (!sub) return undefined;
  if (sub.reader !== 'forks') return sub;
  return { ...sub, strategyFactory: () => buildFrameworkStrategy(recipe, model, timeZone, extensions) };
}

/**
 * The Dendrite part of what the host hands AgentFramework.create()
 * (agent-framework#546): the reader (mapped above) and the `speech`,
 * `tuneOut` and `dendrite` blocks, each present only when the recipe states
 * it, so the framework's defaults apply to the rest. Spread into create()'s
 * argument as is.
 */
export function dendriteCreateOptions(
  recipe: Recipe,
  model: string,
  timeZone: string,
  extensions?: ExtensionRegistry,
): Pick<FrameworkConfig, 'subconscious' | 'speech' | 'tuneOut' | 'dendrite'> {
  const subconscious = buildSubconsciousConfig(recipe, model, timeZone, extensions);
  return {
    ...(subconscious ? { subconscious } : {}),
    ...(recipe.speech ? { speech: recipe.speech } : {}),
    ...(recipe.tuneOut ? { tuneOut: recipe.tuneOut } : {}),
    ...(recipe.dendrite ? { dendrite: recipe.dendrite } : {}),
  };
}
