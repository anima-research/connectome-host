/**
 * The retry config connectome-host builds its Membrane with.
 *
 * Since membrane 0.7, membrane is the one retry layer under the framework: the
 * Anthropic SDK client's own retries are off, and membrane's schedules run on
 * every call path, `streamYielding()` included, the path agent-framework runs
 * its turns on, which membrane didn't retry before. Its `overloaded` schedule
 * (seven attempts over about ten minutes at a 529) would then run inside each
 * of agent-framework's own attempts at a turn, out of the framework's sight.
 * Until agent-framework owns its turns' retries (passing `retry: false` and
 * deciding with membrane's `retryDecision`), the host turns that schedule off,
 * so a 529 is retried as any other retryable failure: the base schedule's
 * three sends, 1 s then 2 s apart, what the SDK client sent inside each
 * attempt before. A recipe's `agent.retry` still sets every field, its
 * `overloaded` schedule included.
 */
import type { MembraneConfig } from '@animalabs/membrane';

export type HostRetryConfig = NonNullable<MembraneConfig['retry']>;

export function hostMembraneRetry(recipeRetry?: MembraneConfig['retry']): HostRetryConfig {
  return {
    ...(recipeRetry ?? {}),
    overloaded: { maxRetries: 0, ...(recipeRetry?.overloaded ?? {}) },
  };
}
