/**
 * `agent.strategy.compressionProvider`: memory writes (compression, merges,
 * transition summaries) on another provider or credential than the agent's
 * own turns. A resident can keep its turns on one credential (a subscription
 * token, say) while its summaries go through an API key or a gateway.
 *
 * The host builds a second membrane for it and hands it to agent-framework as
 * AgentConfig.compressionMembrane, which passes it on to context-manager.
 * Everything else about compression (compressionModel, the ladder, the
 * compression lane's backoff) is unchanged; only where the calls go is.
 */
import { Membrane, OpenAICompatibleAdapter, OpenAIResponsesAPIAdapter, OpenRouterAdapter } from '@animalabs/membrane';
import type { Recipe } from './recipe.js';
import { recipeFormatter } from './recipe-formatter.js';
import { membraneCachingOverride } from './framework-agent-config.js';
import { hostMembraneRetry } from './membrane-retry.js';
import { LoggingAnthropicAdapter, type ReasoningGetter } from './logging-adapter.js';
import { LoggingProviderAdapter } from './logging-provider-wrapper.js';
import { compressionKeyEnv, type RecipeCompressionProvider } from './compression-provider-config.js';

export type { RecipeCompressionProvider } from './compression-provider-config.js';

export interface CompressionMembraneOptions {
  recipe: Recipe;
  spec: RecipeCompressionProvider;
  /** The model compression calls name (the strategy's compressionModel). */
  model: string;
  /** The agent's name: the assistant participant, as on the primary. */
  assistantParticipant: string;
  llmLogPath: string;
  getReasoning?: ReasoningGetter;
  env?: NodeJS.ProcessEnv;
}

/**
 * The membrane memory writes go through. Its calls land in the same llm-calls
 * log as the agent's own. It keeps no cache warm (keepalive is the primary
 * lane's) and takes the recipe's retry, formatter and caching settings, as
 * the primary does. Throws when the credential's variable is unset.
 */
export function buildCompressionMembrane(opts: CompressionMembraneOptions): Membrane {
  const { spec, recipe, llmLogPath } = opts;
  const env = opts.env ?? process.env;
  const keyEnv = compressionKeyEnv(spec);
  const apiKey = env[keyEnv];
  if (!apiKey && spec.provider !== 'openai-compatible') {
    throw new Error(`agent.strategy.compressionProvider: ${keyEnv} is not set (the ${spec.provider} credential for compression).`);
  }
  const adapter = spec.provider === 'anthropic'
    ? new LoggingAnthropicAdapter(
        {
          apiKey,
          baseURL: spec.baseUrl,
          ...(recipe.agent.anthropicBetas?.length
            ? { defaultHeaders: { 'anthropic-beta': recipe.agent.anthropicBetas.join(',') } }
            : {}),
          cacheKeepalive: { enabled: false },
        },
        llmLogPath,
        opts.getReasoning,
      )
    : new LoggingProviderAdapter(
        spec.provider === 'openai-responses'
          ? new OpenAIResponsesAPIAdapter({ apiKey, baseURL: spec.baseUrl })
          : spec.provider === 'openrouter'
            ? new OpenRouterAdapter({ apiKey, baseURL: spec.baseUrl, xTitle: recipe.agent.name ?? recipe.name })
            : new OpenAICompatibleAdapter({ baseURL: spec.baseUrl!, apiKey: apiKey || undefined, providerName: 'openai-compatible' }),
        llmLogPath,
      );
  return new Membrane(adapter, {
    retry: hostMembraneRetry(recipe.agent.retry),
    formatter: recipeFormatter(recipe, spec.provider, opts.model),
    ...membraneCachingOverride(recipe, opts.model),
    assistantParticipant: opts.assistantParticipant,
  });
}

/** One line for the startup log: where compression goes, never the key. */
export function describeCompressionProvider(spec: RecipeCompressionProvider): string {
  return `${spec.provider}${spec.baseUrl ? ` at ${spec.baseUrl}` : ''}, credential from ${compressionKeyEnv(spec)}`;
}
