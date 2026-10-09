/**
 * The host's MockAdapter config from a recipe's `agent.mock` block (validated
 * in recipe.ts; see RecipeMockConfig for what each knob does).
 */
import type { MockAdapterConfig } from '@animalabs/membrane';
import type { RecipeMockConfig } from './recipe.js';

/**
 * Only keys the recipe sets are passed on: MockAdapter spreads its config
 * over its defaults, so an explicit `undefined` would erase a default (an
 * undefined `streamChunkSize` streams an empty reply). `echoMode` defaults to
 * true here, unlike membrane's false: the bare mock echoes.
 */
export function mockAdapterConfig(mock: RecipeMockConfig | undefined): MockAdapterConfig {
  const config: MockAdapterConfig = { echoMode: mock?.echoMode ?? true };
  if (mock?.defaultResponse !== undefined) config.defaultResponse = mock.defaultResponse;
  if (mock?.completeDelayMs !== undefined) config.completeDelayMs = mock.completeDelayMs;
  if (mock?.streamChunkDelayMs !== undefined) config.streamChunkDelayMs = mock.streamChunkDelayMs;
  if (mock?.streamChunkSize !== undefined) config.streamChunkSize = mock.streamChunkSize;
  if (mock?.responseQueue !== undefined) config.responseQueue = [...mock.responseQueue];
  return config;
}
