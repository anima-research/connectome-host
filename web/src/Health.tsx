/**
 * Health surfaces — the operator-facing view of what /healthz and the
 * ops-alert stream already tell machines (fleet hub, connectome-doctor).
 *
 * Two pieces:
 *   - OpsAlertStrip: persistent banner rows under the header, one per active
 *     alert (compression quarantine, refusal streaks, inference-exhausted…).
 *     Fed live from `ops:alert` traces and reconciled against /healthz polls
 *     so a page opened mid-incident still shows the alarm.
 *   - HealthPanel: sidebar tab with per-agent runtime state — status, failure
 *     streaks, refusal stats, runtime settings (budget / tail / pace /
 *     convergence), compression quarantine, and process-level counters.
 *
 * Data access mirrors the Context panel: same-origin fetch of /healthz with
 * the session cookie; observers need the 'health' scope (403 renders as a
 * scope hint, not an error).
 */

import { For, Show } from 'solid-js';

/** One active operator alert, keyed `${agent}:${kind}`. `count` increments on
 *  every re-fire of the same key so a repeating klaxon reads as one row. */
export interface OpsAlert {
  key: string;
  kind: string;
  agent: string;
  message: string;
  /** Epoch millis of the latest firing. */
  at: number;
  count: number;
}

/** Shape of GET /healthz — framework healthSnapshot() plus the host's
 *  compressionQuarantine / runtimeSettings extensions. All fields optional
 *  and defensively read: health rendering must survive version skew. */
export interface HealthSnapshot {
  at?: string;
  uptimeSec?: number;
  gate?: Record<string, unknown> | null;
  pendingRequests?: number;
  activeStreams?: string[];
  agents?: Array<{
    name: string;
    status?: string;
    consecutiveInferenceFailures?: number;
    lastInference?: {
      startedAt?: number;
      completedAt?: number;
      failedAt?: number;
      lastError?: string;
    } | null;
    refusalStats?: {
      total?: number;
      byCategory?: Record<string, number>;
      lastAt?: number;
      lastCategory?: string;
    } | null;
  }>;
  compressionQuarantine?: Record<string, { count?: number; keys?: string[] }>;
  runtimeSettings?: Record<string, {
    contextBudgetTokens?: number;
    tailTokens?: number;
    transitionPaceTokens?: number;
    sameRoundThinkTextPolicy?: string;
    sameRoundThinkTextPolicySource?: string;
    transition?: string;
    transitionReason?: string;
  }>;
}

const fmtTokens = (n: number): string => {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'k';
  return (n / 1_000_000).toFixed(2) + 'M';
};

const fmtAgo = (ts: number): string => {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}h ${min % 60}m ago` : `${Math.floor(h / 24)}d ago`;
};

const fmtUptime = (sec: number): string => {
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86_400)}d ${Math.floor((sec % 86_400) / 3600)}h`;
};

/** Severity → row tone. Quarantine and hard-down are outage-class (rose);
 *  everything else on this channel is at least warning-class (amber). */
const alertTone = (kind: string): { row: string; dot: string } =>
  kind === 'compression-quarantine' || kind === 'inference-exhausted'
    ? { row: 'bg-rose-950/60 border-rose-900 text-rose-200', dot: 'bg-rose-500 animate-pulse' }
    : { row: 'bg-amber-950/60 border-amber-900 text-amber-200', dot: 'bg-amber-500' };

export function OpsAlertStrip(props: {
  alerts: OpsAlert[];
  onDismiss(key: string): void;
}) {
  return (
    <For each={props.alerts}>{(a) => {
      const tone = alertTone(a.kind);
      return (
        <div class={`border-b px-4 py-1.5 text-xs flex items-center gap-2 ${tone.row}`}>
          <span class={`w-2 h-2 rounded-full shrink-0 ${tone.dot}`} />
          <span class="font-mono font-semibold shrink-0">{a.agent}</span>
          <span class="font-mono text-[10px] uppercase tracking-wider opacity-70 shrink-0">{a.kind}</span>
          <span class="truncate" title={a.message}>{a.message}</span>
          <span class="ml-auto shrink-0 opacity-60 font-mono text-[10px]">
            {a.count > 1 ? `×${a.count} · ` : ''}{fmtAgo(a.at)}
          </span>
          <button
            type="button"
            class="shrink-0 px-1 opacity-60 hover:opacity-100"
            title="Dismiss (reappears if the alert re-fires)"
            onClick={() => props.onDismiss(a.key)}
          >
            ✕
          </button>
        </div>
      );
    }}</For>
  );
}

export function HealthPanel(props: {
  health: HealthSnapshot | null;
  /** Non-null when the last /healthz fetch failed; '403' means scope-denied. */
  error: string | null;
  onRefresh(): void;
}) {
  const agents = () => props.health?.agents ?? [];
  const quarantine = (name: string) => props.health?.compressionQuarantine?.[name];
  const settings = (name: string) => props.health?.runtimeSettings?.[name];

  const statusTone = (status?: string): string => {
    switch (status) {
      case 'idle': return 'text-emerald-400';
      case 'inferring':
      case 'streaming': return 'text-cyan-300';
      case 'waiting_for_tools':
      case 'ready': return 'text-amber-300';
      default: return 'text-neutral-400';
    }
  };

  return (
    <div class="p-2 text-[11px] font-mono text-neutral-300 space-y-3 overflow-y-auto h-full">
      <div class="flex items-center justify-between">
        <span class="text-neutral-400">Health</span>
        <button
          type="button"
          class="px-2 py-0.5 text-neutral-400 hover:text-neutral-100 border border-neutral-700 rounded"
          onClick={() => props.onRefresh()}
          title="Refresh /healthz now"
        >
          refresh
        </button>
      </div>

      <Show when={props.error}>
        <div class="text-rose-400">
          {props.error === '403'
            ? "healthz denied — your observer grant lacks the 'health' scope."
            : `healthz: ${props.error}`}
        </div>
      </Show>

      <Show when={props.health}>
        <div class="flex gap-4 text-neutral-500">
          <Show when={props.health!.uptimeSec !== undefined}>
            <span>up {fmtUptime(props.health!.uptimeSec!)}</span>
          </Show>
          <Show when={props.health!.pendingRequests !== undefined}>
            <span>{props.health!.pendingRequests} queued</span>
          </Show>
          <Show when={props.health!.activeStreams !== undefined}>
            <span>{props.health!.activeStreams!.length} streaming</span>
          </Show>
        </div>

        <For each={agents()}>{(a) => (
          <section class="border border-neutral-800 rounded px-2.5 py-2 space-y-1.5">
            <div class="flex items-center gap-2">
              <span class="text-neutral-100">{a.name}</span>
              <span class={statusTone(a.status)}>{a.status ?? '?'}</span>
              <Show when={(a.consecutiveInferenceFailures ?? 0) > 0}>
                <span class="ml-auto text-rose-400">
                  {a.consecutiveInferenceFailures} consecutive failure{a.consecutiveInferenceFailures === 1 ? '' : 's'}
                </span>
              </Show>
            </div>

            <Show when={a.lastInference?.lastError}>
              <div class="text-rose-300/80 truncate" title={a.lastInference!.lastError}>
                last error: {a.lastInference!.lastError}
              </div>
            </Show>
            <Show when={a.lastInference?.completedAt || a.lastInference?.failedAt}>
              <div class="text-neutral-500">
                last inference:{' '}
                {a.lastInference?.completedAt
                  ? `ok ${fmtAgo(a.lastInference.completedAt)}`
                  : `failed ${fmtAgo(a.lastInference!.failedAt!)}`}
              </div>
            </Show>

            <Show when={quarantine(a.name) && (quarantine(a.name)!.count ?? 0) > 0}>
              <div class="text-rose-300 bg-rose-950/30 border border-rose-900/50 rounded px-2 py-1">
                ⚠ {quarantine(a.name)!.count} chunk(s) in compression quarantine — raw spans
                accumulate until the window can't fit. Inspect, then branch, pin, or clear.
                <Show when={(quarantine(a.name)!.keys?.length ?? 0) > 0}>
                  <div class="text-rose-400/70 truncate" title={quarantine(a.name)!.keys!.join(', ')}>
                    {quarantine(a.name)!.keys!.join(', ')}
                  </div>
                </Show>
              </div>
            </Show>

            <Show when={a.refusalStats && (a.refusalStats.total ?? 0) > 0}>
              <div class="text-amber-300/90">
                refusals: {a.refusalStats!.total}
                <Show when={a.refusalStats!.lastCategory}>
                  <span class="text-amber-400/60"> · last {a.refusalStats!.lastCategory}</span>
                </Show>
                <Show when={a.refusalStats!.lastAt}>
                  <span class="text-neutral-500"> · {fmtAgo(a.refusalStats!.lastAt!)}</span>
                </Show>
              </div>
            </Show>

            <Show when={settings(a.name)}>
              {(s) => (
                <div class="border-t border-neutral-900 pt-1.5 space-y-0.5 text-neutral-400">
                  <div class="text-[10px] uppercase tracking-wider text-neutral-600">runtime settings</div>
                  <div>
                    budget <span class="text-neutral-200">{fmtTokens(s().contextBudgetTokens ?? 0)}</span>
                    <Show when={s().tailTokens !== undefined}>
                      <span> · tail <span class="text-neutral-200">{fmtTokens(s().tailTokens!)}</span></span>
                    </Show>
                    <Show when={s().transitionPaceTokens !== undefined}>
                      <span> · pace <span class="text-neutral-200">{fmtTokens(s().transitionPaceTokens!)}</span></span>
                    </Show>
                  </div>
                  <Show when={s().sameRoundThinkTextPolicy}>
                    <div>
                      think-text <span class="text-neutral-200">{s().sameRoundThinkTextPolicy}</span>
                      <span class="text-neutral-600"> ({s().sameRoundThinkTextPolicySource})</span>
                    </div>
                  </Show>
                  <Show when={s().transition && s().transition !== 'stable'}>
                    <div class={s().transition === 'blocked' ? 'text-rose-300' : 'text-amber-300'}>
                      budget {s().transition}
                      <Show when={s().transitionReason}>
                        <span class="opacity-70"> — {s().transitionReason}</span>
                      </Show>
                    </div>
                  </Show>
                </div>
              )}
            </Show>
          </section>
        )}</For>
      </Show>

      <Show when={!props.health && !props.error}>
        <div class="text-neutral-500">loading…</div>
      </Show>
    </div>
  );
}
