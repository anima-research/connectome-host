/**
 * `agent.strategy.compressionProvider`'s shape and validation, apart from the
 * builder (compression-provider.ts) so recipe.ts can read it without importing
 * membrane or the host's adapters.
 */

export const COMPRESSION_PROVIDERS = ['anthropic', 'openai-responses', 'openai-compatible', 'openrouter'] as const;
export type CompressionProviderName = typeof COMPRESSION_PROVIDERS[number];

export interface RecipeCompressionProvider {
  provider: CompressionProviderName;
  /**
   * The environment variable holding the credential (never the credential
   * itself). Default: the provider's usual one, ANTHROPIC_API_KEY,
   * OPENAI_API_KEY, OPENAI_COMPATIBLE_API_KEY or OPENROUTER_API_KEY.
   */
  apiKeyEnv?: string;
  /** The endpoint, for a gateway. Required for openai-compatible. */
  baseUrl?: string;
}

export const DEFAULT_COMPRESSION_KEY_ENV: Record<CompressionProviderName, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  'openai-responses': 'OPENAI_API_KEY',
  'openai-compatible': 'OPENAI_COMPATIBLE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Throws on a malformed `agent.strategy.compressionProvider`. */
export function validateCompressionProvider(value: unknown, agent: { provider?: unknown; strategy?: Record<string, unknown> }): void {
  const at = 'Recipe agent.strategy.compressionProvider';
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${at} must be an object.`);
  }
  const spec = value as Record<string, unknown>;
  for (const key of Object.keys(spec)) {
    if (key !== 'provider' && key !== 'apiKeyEnv' && key !== 'baseUrl') {
      throw new Error(
        `${at}.${key} is not a known field (provider, apiKeyEnv, baseUrl). ` +
          'Name the credential by its environment variable with apiKeyEnv; the recipe never holds it.',
      );
    }
  }
  if (!COMPRESSION_PROVIDERS.includes(spec.provider as CompressionProviderName)) {
    throw new Error(`${at}.provider must be one of ${COMPRESSION_PROVIDERS.map((p) => `"${p}"`).join(', ')}.`);
  }
  if (spec.apiKeyEnv !== undefined && (typeof spec.apiKeyEnv !== 'string' || !ENV_NAME.test(spec.apiKeyEnv))) {
    throw new Error(`${at}.apiKeyEnv must be an environment variable name.`);
  }
  if (spec.baseUrl !== undefined) {
    if (typeof spec.baseUrl !== 'string' || !/^https?:\/\//.test(spec.baseUrl)) {
      throw new Error(`${at}.baseUrl must be an http(s) URL.`);
    }
  } else if (spec.provider === 'openai-compatible') {
    throw new Error(`${at}.baseUrl is required for provider "openai-compatible".`);
  }
  // Model names differ between providers ("claude-opus-5" on anthropic,
  // "anthropic/claude-opus-5" on OpenRouter), so on another provider than the
  // agent's, the compression model is named for it rather than taken from
  // agent.model.
  const agentProvider = typeof agent.provider === 'string' ? agent.provider : 'anthropic';
  if (spec.provider !== agentProvider && typeof agent.strategy?.compressionModel !== 'string') {
    throw new Error(
      `${at}.provider is "${spec.provider}", not the agent's "${agentProvider}": ` +
        'set agent.strategy.compressionModel to the model as that provider names it.',
    );
  }
}

/** The environment variable the compression credential is read from. */
export function compressionKeyEnv(spec: RecipeCompressionProvider): string {
  return spec.apiKeyEnv ?? DEFAULT_COMPRESSION_KEY_ENV[spec.provider];
}
