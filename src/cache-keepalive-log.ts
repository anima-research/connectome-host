// Every keepalive event goes to STDERR. The host's systemd unit routes
// `StandardError` to `<data>/service-stderr.log` and leaves stdout on the
// journal, and that file is where an operator looks.

import { CacheKeepalive, type KeepaliveEvent } from '@animalabs/membrane';

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

/** The warning to print when the recipe asks for `agent.cacheKeepalive.persist`
 *  but this membrane can't save keepalive state (it came before `statePath`):
 *  the option would otherwise do nothing, silently. Null when all is well. */
export function keepalivePersistWarning(
  persist: boolean | undefined,
  keepalivePrototype: object = CacheKeepalive.prototype,
): string | null {
  if (persist !== true || 'persistPath' in keepalivePrototype) return null;
  return `${KEEPALIVE_LOG_PREFIX} agent.cacheKeepalive.persist is on, but this membrane can't save keepalive state `
    + '(it needs a membrane with cacheKeepalive.statePath), so a restart still starts the cache cold. Update membrane.';
}
