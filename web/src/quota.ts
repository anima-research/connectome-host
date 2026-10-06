/**
 * Subscription quota readout, polled only while someone is looking.
 *
 * On a subscription credential the host's dollar estimate is fiction; what
 * matters is how much of each utilization window is left. The server answers
 * `/quota` from a rate-floored meter, so this poll is what keeps the meter
 * warm: a hidden or unfocused tab asks for nothing.
 */

import { createEffect, createSignal, on, onCleanup, onMount, type Accessor } from 'solid-js';
import type { QuotaSnapshotData } from '@conhost/web/protocol';

const POLL_MS = 60_000;

/**
 * `scope` names the process whose credential is read: 'local' (the parent) or
 * a fleet child, through the host's `?scope=` proxy. A fleet can mix
 * subscription and pay-per-token processes, so each is asked for itself.
 * A null scope idles the poll (nothing is showing it).
 */
export function createQuotaPoll(scope: Accessor<string | null> = () => 'local'): Accessor<QuotaSnapshotData | null> {
  const [quota, setQuota] = createSignal<QuotaSnapshotData | null>(null);
  let timer: number | undefined;
  let metered = false;

  const looking = (): boolean => document.visibilityState === 'visible' && document.hasFocus();

  const load = async (): Promise<void> => {
    const asked = scope();
    if (asked === null) return;
    try {
      const query = asked !== 'local' ? `?scope=${encodeURIComponent(asked)}` : '';
      const res = await fetch(`/quota${query}`, { credentials: 'same-origin' });
      if (asked !== scope()) return; // scope switched mid-flight — stale
      // Only a definite answer ends the polling. A 401 can be the observer
      // session cookie not written yet, a 503 the host still binding, a 5xx a
      // child restarting: all of them are "ask again next tick".
      if (res.status === 403 || res.status === 404) { metered = true; return; }
      if (!res.ok) return;
      // An older host answers the SPA shell here: no readout, stop asking.
      if (!(res.headers.get('content-type') ?? '').includes('json')) { metered = true; return; }
      const data = (await res.json()) as QuotaSnapshotData;
      // A pay-per-token host never becomes a subscription host mid-session.
      if (!data.subscription) metered = true;
      setQuota(data);
    } catch {
      // Transient network failure: keep the last reading, try next tick.
    }
  };

  const sync = (): void => {
    const want = looking() && !metered && scope() !== null;
    if (want && timer === undefined) {
      void load();
      timer = window.setInterval(() => {
        if (metered) sync(); else void load();
      }, POLL_MS);
    } else if (!want && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };

  // A different process is a different credential: forget the old answer.
  createEffect(on(scope, () => {
    metered = false;
    setQuota(null);
    if (timer !== undefined) { window.clearInterval(timer); timer = undefined; }
    sync();
  }, { defer: true }));

  onMount(() => {
    sync();
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('focus', sync);
    window.addEventListener('blur', sync);
  });
  onCleanup(() => {
    document.removeEventListener('visibilitychange', sync);
    window.removeEventListener('focus', sync);
    window.removeEventListener('blur', sync);
    if (timer !== undefined) window.clearInterval(timer);
  });

  return quota;
}

/**
 * What a spent window means right now. "Parked" is claimed only when the
 * framework says it is holding an agent; a spent window by itself parks
 * nothing (the hold arms on a 429, and only on a framework with the hook).
 */
export function quotaStatus(q: QuotaSnapshotData): string | null {
  if (!q.blockedUntil) return q.parked ? 'inference parked on a spent quota window' : null;
  const at = new Date(q.blockedUntil).toLocaleString();
  return q.parked ? `inference parked until ${at}` : `quota window spent — resets ${at}`;
}

/** `10% weekly | 99% 5h` */
export function quotaReadout(q: QuotaSnapshotData): string {
  return q.windows.map((w) => `${Math.floor(w.utilization)}% ${w.label}`).join(' | ');
}

/** Worst window drives the colour: amber from 75%, rose from 90%. */
export function quotaTone(q: QuotaSnapshotData): string {
  const worst = Math.max(0, ...q.windows.filter((w) => !w.advisory).map((w) => w.utilization));
  return worst >= 90 ? 'text-rose-400' : worst >= 75 ? 'text-amber-400' : 'text-emerald-300';
}

export function quotaTitle(q: QuotaSnapshotData): string {
  const lines = q.windows.map((w) =>
    `${w.label}: ${Math.floor(w.utilization)}% used`
    + (w.resetsAt ? ` · resets ${new Date(w.resetsAt).toLocaleString()}` : ''));
  const status = quotaStatus(q);
  if (status) lines.push(status);
  if (q.error) lines.push(`Last refresh failed: ${q.error}`);
  return `Subscription quota (${q.provider ?? 'provider'})\n${lines.join('\n')}`;
}
