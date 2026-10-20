import {
  AutobiographicalStrategy,
  PassthroughStrategy,
  type ContextStrategy,
  type ConversationRouterConfig,
} from '@animalabs/agent-framework';
import type { Recipe, RecipeKvUnifiedConfig, RecipeStrategy } from './recipe.js';
import { anthropicCacheReadMultiplier, openaiCacheMultipliers } from './call-pricing.js';
import { effectiveContextBudgetTokens, resolvePromptCaching } from './framework-agent-config.js';
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

/** Verbatim tail for a recipe that omits `strategy.recentWindowTokens`, as a
 *  share of the compile budget: 120k of the default 300k. */
export const DEFAULT_RECENT_WINDOW_RATIO = 0.4;

/**
 * The kv-unified block a recipe gets when it selects kv-unified (or leaves
 * the solver to the default) without writing one. The policy is the one
 * every kv-unified production resident runs; only the cache prices vary,
 * because they must match what the provider actually bills, as multiples of
 * the model's base input price:
 *  - Anthropic writes: 2x on the 1-hour cache, 1.25x on the 5-minute one
 *    (Bedrock only has the 5-minute cache); reads: the model's rate from the
 *    pricing table (0.025x Fable 5.1 / Mythos 5.1, 0.05x Opus 5.5, 0.1x
 *    elsewhere). Sonnet 5.5 is billed 0.05x but takes 0.1x here, as the
 *    table's Sonnet 5 entry explains;
 *  - OpenAI: by model and transport (openaiCacheMultipliers): API writes
 *    1.25x on the GPT-5.6 / GPT-6 families, 1x otherwise and on Codex;
 *  - prompt caching off (`agent.promptCaching: false`, or a Bedrock model
 *    without caching): 1 and 1, every token at the base price, so no layout
 *    is preferred for cache savings the agent never gets.
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
    recentWindowTokens: strategyConfig?.recentWindowTokens
      ?? Math.round(effectiveContextBudgetTokens(recipe) * DEFAULT_RECENT_WINDOW_RATIO),
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
  // - foldingStrategy 'kv-unified', with the standard block: the cost-aware
  //   solver every new resident runs. The library's own fallback is
  //   'flat-profile', which replans layouts without regard for the prompt
  //   cache. Residents built on kv-stable pin it explicitly. (Only meaningful
  //   under adaptive resolution, so gate on it.)
  // - a kv-unified selection without a kvUnified block gets the same standard
  //   block. Context Manager stays fail-closed (no defaults of its own); the
  //   host always hands it a complete one.
  // - summaryParticipant <agent name>: the library falls back to the literal
  //   'Claude', which voices self-recollections as a stranger for any agent
  //   not named Claude. Summaries should speak as the agent itself.
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
