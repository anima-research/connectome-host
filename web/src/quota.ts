import { createEffect, createSignal, on, onCleanup, onMount, type Accessor } from 'solid-js';
import type { QuotaSnapshotData } from '@conhost/web/protocol';

const POLL_MS = 60_000;

export function createQuotaPoll(scope: Accessor<string | null> = () => 'local'): Accessor<QuotaSnapshotData | null> {
  const [quota, setQuota] = createSignal<QuotaSnapshotData | null>(null);
  let timer: number | undefined;
  let stopAsking = false;

  const looking = (): boolean => document.visibilityState === 'visible' && document.hasFocus();

  const load = async (): Promise<void> => {
    const asked = scope();
    if (asked === null) return;
    try {
      const query = asked !== 'local' ? `?scope=${encodeURIComponent(asked)}` : '';
      const res = await fetch(`/quota${query}`, { credentials: 'same-origin' });
      if (asked !== scope()) return;
      if (res.status === 403 || res.status === 404) { stopAsking = true; return; }
      if (!res.ok) return;
      if (!(res.headers.get('content-type') ?? '').includes('json')) { stopAsking = true; return; }
      const data = (await res.json()) as QuotaSnapshotData;
      if (!data.subscription) stopAsking = true;
      setQuota(data);
    } catch {
    }
  };

  const sync = (): void => {
    const want = looking() && !stopAsking && scope() !== null;
    if (want && timer === undefined) {
      void load();
      timer = window.setInterval(() => {
        if (stopAsking) sync(); else void load();
      }, POLL_MS);
    } else if (!want && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };

  createEffect(on(scope, () => {
    stopAsking = false;
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
 * "Parked" is claimed only when agent-framework says it holds an agent: a
 * spent window parks nothing until a call fails on it.
 */
export function quotaStatus(q: QuotaSnapshotData): string | null {
  if (!q.blockedUntil) return q.parked ? 'inference parked on a spent quota window' : null;
  const at = new Date(q.blockedUntil).toLocaleString();
  return q.parked ? `inference parked until ${at}` : `quota window spent — resets ${at}`;
}

export function quotaReadout(q: QuotaSnapshotData): string {
  return q.windows.map((w) => `${Math.floor(w.utilization)}% ${w.label}`).join(' | ');
}

export function quotaTone(q: QuotaSnapshotData): string {
  const worst = Math.max(0, ...q.windows.filter((w) => !w.advisory).map((w) => w.utilization));
  return worst >= 90 ? 'text-rose-400' : worst >= 75 ? 'text-amber-400' : 'text-emerald-300';
}

export function quotaUnreadable(q: QuotaSnapshotData | null): boolean {
  return q?.subscription === true && q.windows.length === 0 && q.error !== undefined;
}

export function quotaTitle(q: QuotaSnapshotData): string {
  const lines = q.windows.map((w) =>
    `${w.label}: ${Math.floor(w.utilization)}% used`
    + (w.resetsAt ? ` · resets ${new Date(w.resetsAt).toLocaleString()}` : ''));
  const status = quotaStatus(q);
  if (status) lines.push(status);
  if (q.error !== undefined) lines.push(q.error ? `Last refresh failed: ${q.error}` : 'Last refresh failed');
  return `Subscription quota (${q.provider ?? 'provider'})\n${lines.join('\n')}`;
}
