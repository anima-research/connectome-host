// Every keepalive event goes to STDERR. The host's systemd unit routes
// `StandardError` to `<data>/service-stderr.log` and leaves stdout on the
// journal, and that file is where an operator looks.

import type { KeepaliveEvent } from '@animalabs/membrane';

export const KEEPALIVE_LOG_PREFIX = '[cache-keepalive]';

export function formatKeepaliveEvent(event: KeepaliveEvent): string {
  return `${KEEPALIVE_LOG_PREFIX} ${JSON.stringify(event)}`;
}

export function logKeepaliveEvent(
  event: KeepaliveEvent,
  sink: (line: string) => void = (line) => console.error(line),
): void {
  sink(formatKeepaliveEvent(event));
}

export const KEEPALIVE_STATE_FILE = 'cache-keepalive.json';

/** The adapter's keepalive, as the host reads it: membrane's `CacheKeepalive`,
 *  whose `persistPath` getter exists only from the release that adds
 *  `cacheKeepalive.statePath`, and reads undefined once it has given up the
 *  file (another process took it over, or a save failed). */
export type KeepaliveRef = { persistPath?: string } | undefined | null;

/**
 * The warning for a recipe that sets `agent.cacheKeepalive.persist` where it
 * can't work, decided from the adapter's own keepalive instance (null when
 * all is well):
 * - a 5-minute cache: the keepalive only keeps 1-hour entries warm;
 * - no keepalive: the provider isn't Anthropic, or the keepalive is off;
 * - a keepalive without `persistPath`: this membrane can't save its state;
 * - `persistPath` undefined: it gave up saving (one host per data directory).
 */
export function keepalivePersistWarning(
  persist: boolean | undefined,
  keepalive: KeepaliveRef,
  cacheTtl?: '5m' | '1h',
): string | null {
  if (persist !== true) return null;
  const head = `${KEEPALIVE_LOG_PREFIX} agent.cacheKeepalive.persist is on, but`;
  if (cacheTtl === '5m') {
    return `${head} it has no effect with agent.cacheTtl '5m': the keepalive only keeps 1-hour cache entries warm.`;
  }
  if (!keepalive) {
    return `${head} it has no effect: the cache keepalive is off for this provider or recipe.`;
  }
  if (!('persistPath' in keepalive)) {
    return `${head} this membrane can't save keepalive state; persist needs a membrane with cacheKeepalive.statePath, `
      + 'so a restart keeps nothing warm.';
  }
  if (keepalive.persistPath === undefined) {
    return `${head} the keepalive has stopped saving its state (see the persist-error line; `
      + 'is another host running on this data directory?).';
  }
  return null;
}

/** /healthz's cacheKeepalivePersist: whether the keepalive is saving its state,
 *  absent unless the recipe asks for it. */
export function keepalivePersistHealth(persist: boolean | undefined, keepalive: KeepaliveRef): Record<string, unknown> | null {
  if (persist !== true) return null;
  const supported = !!keepalive && 'persistPath' in keepalive;
  const path = supported ? keepalive!.persistPath : undefined;
  return { saving: path !== undefined, ...(path !== undefined ? { path } : {}), ...(supported ? {} : { reason: keepalive ? 'membrane-unsupported' : 'no-keepalive' }) };
}
