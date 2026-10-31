/** Recipe turn policy, separate from hostMembraneRetry's non-turn defaults. */
import { DefaultErrorPolicy } from '@animalabs/agent-framework';
import { DEFAULT_RETRY_CONFIG, type MembraneConfig, type RetryConfig } from '@animalabs/membrane';
import { membraneRetrySettings } from '@animalabs/membrane/retry';

/**
 * Membrane 0.8.0 exports its defaults and settings builder, but not its
 * resolveRetryConfig. Mirror that private resolver's field-by-field completion
 * and validation here (undefined means omitted, including nested fields).
 * The create-call tests pin this against Membrane's actual constructor so a
 * change to its defaults or resolution cannot silently diverge.
 */
function completeRetryConfig(given: MembraneConfig['retry']): RetryConfig {
  function fields<T extends { [K in keyof T]: number }>(defaults: T, partial: Partial<T> | undefined, path: string): T {
    const resolved = { ...defaults };
    for (const key of Object.keys(defaults) as (keyof T & string)[]) {
      const value: unknown = partial?.[key];
      if (value === undefined) continue;
      if (typeof value !== 'number') {
        throw new TypeError(`[membrane] ${path}.${key} must be a number, got ${value === null ? 'null' : typeof value}`);
      }
      if (!Number.isFinite(value) || value < 0) {
        throw new RangeError(`[membrane] ${path}.${key} must be a finite number of at least 0, got ${value}`);
      }
      resolved[key] = value as T[typeof key];
    }
    return resolved;
  }
  const { overloaded, ...base } = given ?? {};
  const { overloaded: overloadedDefaults, ...baseDefaults } = DEFAULT_RETRY_CONFIG;
  return {
    ...fields(baseDefaults, base, 'retry'),
    overloaded: fields(overloadedDefaults, overloaded, 'retry.overloaded'),
  };
}

/** Spread into create(): absent and empty recipes must omit the property. */
export function frameworkErrorPolicy(retry: MembraneConfig['retry']): { errorPolicy?: DefaultErrorPolicy } {
  if (!retry || Object.keys(retry).length === 0) return {};
  return { errorPolicy: new DefaultErrorPolicy(membraneRetrySettings(completeRetryConfig(retry))) };
}
