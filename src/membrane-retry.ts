/**
 * The retry config connectome-host builds its Membrane with.
 *
 * agent-framework retries an agent's turns itself, passing `retry: false`, so
 * this config reaches only the host's other calls through its Membrane:
 * compression and merging, retrieval, session naming and the TUI's status
 * line. Membrane's `overloaded` schedule (seven attempts over five to ten
 * minutes at a 529) stays off for them: context-manager paces its own retries
 * after a failed compression call, and retrieval runs inside agent-framework's
 * context gather, whose 15 s limit that schedule's waits would far outlast.
 * So a 529 is retried as any other retryable failure: the base schedule's
 * three sends, 1 s then 2 s apart. A recipe's `agent.retry` sets every field,
 * its `overloaded` schedule included.
 */
import type { MembraneConfig } from '@animalabs/membrane';

export type HostRetryConfig = NonNullable<MembraneConfig['retry']>;

export function hostMembraneRetry(recipeRetry?: MembraneConfig['retry']): HostRetryConfig {
  return {
    ...(recipeRetry ?? {}),
    overloaded: { maxRetries: 0, ...(recipeRetry?.overloaded ?? {}) },
  };
}
