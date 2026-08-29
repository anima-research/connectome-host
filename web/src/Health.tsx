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
import type { CallLedgerRow } from '@conhost/web/protocol';

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
/** Rendered composition of the last compile — what was actually SENT. */
export interface ContextComposition {
  head?: { messages: number; tokens: number };
  tail?: { messages: number; tokens: number };
  middleRaw?: { messages: number; tokens: number };
  summaries?: Record<string, { count: number; tokens: number }>;
  total?: { messages: number; tokens: number };
}

/** One provider call. Aliased to the wire type so the two cannot drift; only
 *  the fields this panel aggregates are read. */
export type LedgerRow = CallLedgerRow;

export interface HealthSnapshot {
  at?: string;
  contextComposition?: Record<string, ContextComposition>;
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

  /** cm's single-authority debt reduction (getCompressionDebt) — the QUEUE

   * of closed-but-uncompressed chunks. Distinct from contextComposition:

   * composition says what the last compile RENDERED (summaries L1 = 0 there

   * means "no L1 tokens in the window", often healthy consolidation);

   * this block says what the memory organ still OWES. Absent per-agent

   * entry = the stack predates the reduction — render that as

   * "not reported", never as zero (misread twice on 2026-08-29). */

  compressionDebt?: Record<string, {

    state?: 'healthy' | 'degraded' | 'critical';

    pendingChunks?: number;

    oldestPendingAgeMs?: number | null;

    mergeQueueDepth?: number;

    mergeQuarantineCount?: number;

    compressionQuarantineCount?: number;

  }>;
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


const n0 = (v: number) => v.toLocaleString();

function CallStats(props: { rows: LedgerRow[] }) {
  /** Newest first — the interesting call is the one that just happened. */
  const recent = () => [...props.rows].reverse().slice(0, 24);

  const clock = (ts: string) => {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(11, 19);
  };
  /** Fraction of the prompt that was reused rather than re-read. */
  const share = (r: LedgerRow) => {
    const sent = r.tokens.input + r.tokens.cacheRead;
    return sent > 0 ? Math.round((100 * r.tokens.cacheRead) / sent) : null;
  };

  return (
    <div>
      <div class="text-[10px] uppercase tracking-wider text-neutral-600 mb-1">
        llm calls — newest first ({props.rows.length} held)
      </div>
      <div class="overflow-x-auto">
        <table class="w-full font-mono text-[10px] whitespace-nowrap">
          <thead>
            <tr class="text-neutral-600 border-b border-neutral-800">
              <th class="text-left pr-2 font-normal">time</th>
              <th class="text-left pr-2 font-normal">origin</th>
              <th class="text-right pr-2 font-normal">msgs</th>
              <th class="text-right pr-2 font-normal">fresh</th>
              <th class="text-right pr-2 font-normal">cached</th>
              <th class="text-right pr-2 font-normal">%c</th>
              <th class="text-right pr-2 font-normal">write</th>
              <th class="text-right pr-2 font-normal">out</th>
              <th class="text-right pr-2 font-normal">bp</th>
              <th class="text-right pr-2 font-normal">ms</th>
              <th class="text-left font-normal">verdict</th>
            </tr>
          </thead>
          <tbody>
            <For each={recent()}>
              {(r) => {
                const main = r.originEstimate === 'turn~';
                return (
                  <tr class={`border-b border-neutral-900 ${
                    r.error || r.stopReason === 'refusal' ? 'bg-red-950/30' : ''
                  }`}>
                    <td class="pr-2 text-neutral-500">{clock(r.timestamp)}</td>
                    <td class={`pr-2 ${main ? 'text-cyan-400' : 'text-orange-400'}`}>
                      {main ? 'turn' : 'compr'}
                    </td>
                    <td class="pr-2 text-right text-neutral-400">{r.messages}</td>
                    <td class="pr-2 text-right text-neutral-100">{n0(r.tokens.input)}</td>
                    <td class="pr-2 text-right text-sky-300">{n0(r.tokens.cacheRead)}</td>
                    <td class="pr-2 text-right text-neutral-400">
                      {share(r) === null ? '—' : `${share(r)}%`}
                    </td>
                    <td class="pr-2 text-right text-violet-300">
                      {r.tokens.cacheWrite ? n0(r.tokens.cacheWrite) : '·'}
                    </td>
                    <td class="pr-2 text-right text-neutral-400">{n0(r.tokens.output)}</td>
                    <td class="pr-2 text-right text-neutral-600">{r.cache.breakpoints ?? '·'}</td>
                    <td class="pr-2 text-right text-neutral-600">{n0(r.durationMs)}</td>
                    <td class={verdictTone(r.verdict)} title={r.cause}>
                      {r.verdict}
                      <Show when={r.stopReason === 'refusal'}>
                        <span class="text-red-300"> refusal</span>
                      </Show>
                      <Show when={r.error}>
                        <span class="text-red-300"> err</span>
                      </Show>
                    </td>
                  </tr>
                );
              }}
            </For>
          </tbody>
        </table>
      </div>
      <div class="text-[9px] text-neutral-600 mt-1 leading-relaxed">
        <span class="text-cyan-400">turn</span> = main inference,
        <span class="text-orange-400"> compr</span> = compression/summarizer — inferred from
        stream-vs-complete, not a definitive tag (hence <span class="font-mono">~</span> upstream).
        One turn may appear as a turn row plus several compr rows.
        <span class="font-mono"> fresh</span> = tokens billed as new input;
        <span class="font-mono"> cached</span> = read from cache;
        <span class="font-mono"> %c</span> = cached ÷ (fresh+cached);
        <span class="font-mono"> bp</span> = cache breakpoints.
      </div>
    </div>
  );
}

/** Verdict colouring: reuse is good, rewrites cost a full re-read. */
function verdictTone(v: string): string {
  if (v === 'HIT' || v === 'hit+extend') return 'text-emerald-300';
  if (v === 'first-write') return 'text-violet-300';
  if (v === 'uncached') return 'text-neutral-400';
  if (v === 'ERROR' || v === 'empty') return 'text-red-300';
  return 'text-amber-300';
}

function CompositionBlock(props: { c: ContextComposition }) {
  const rows = () => {
    const c = props.c;
    const out: Array<[string, number]> = [
      ['head (verbatim)', c.head?.tokens ?? 0],
      ['middle raw', c.middleRaw?.tokens ?? 0],
    ];
    for (const [lvl, v] of Object.entries(c.summaries ?? {})) {
      out.push([`summaries ${lvl.toUpperCase()}`, v?.tokens ?? 0]);
    }
    out.push(['tail (verbatim)', c.tail?.tokens ?? 0]);
    return out;
  };
  const total = () => props.c.total?.tokens ?? rows().reduce((s, [, v]) => s + v, 0);

  return (
    <div>
      <div class="text-[10px] uppercase tracking-wider text-neutral-600 mb-1">
        context composition (last compile)
      </div>
      <table class="w-full font-mono text-[10px]">
        <tbody>
          <For each={rows()}>
            {([k, v]) => (
              <tr>
                <td class="text-neutral-500 pr-2">{k}</td>
                <td class="text-neutral-200 text-right tabular-nums">{n0(v)}</td>
                <td class="text-neutral-600 text-right pl-2 w-10">
                  {total() > 0 ? `${Math.round((100 * v) / total())}%` : ''}
                </td>
                <td class="pl-2 w-1/3">
                  <span class="inline-block h-1.5 bg-cyan-800 rounded"
                        style={{ width: `${total() > 0 ? Math.round((100 * v) / total()) : 0}%` }} />
                </td>
              </tr>
            )}
          </For>
          <tr class="border-t border-neutral-800">
            <td class="text-neutral-400 pr-2">total rendered</td>
            <td class="text-neutral-100 text-right tabular-nums">{n0(total())}</td>
            <td colSpan={2} />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function HealthPanel(props: {
  health: HealthSnapshot | null;
  /** Recent provider calls. Already on the client via the call-ledger frame. */
  ledger?: LedgerRow[];
  /** Non-null when the last /healthz fetch failed; '403' means scope-denied. */
  error: string | null;
  onRefresh(): void;
}) {
  const agents = () => props.health?.agents ?? [];
  const quarantine = (name: string) => props.health?.compressionQuarantine?.[name];
  const debt = (name: string) => props.health?.compressionDebt?.[name];
  const settings = (name: string) => props.health?.runtimeSettings?.[name];
  const composition = (name: string) => props.health?.contextComposition?.[name];

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
            {/* the INFERENCE queue (requests waiting to run) — not compression
                debt; that lives per-agent below. A bare "queued" invited the
                misread, hence the explicit label. */}
            <span>{props.health!.pendingRequests} inference queued</span>
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

            {/* Compression debt: the organ's QUEUE, not the render composition.
                An old stack that reports nothing must say so — absence
                rendered as zero invites misreads. */}
            <Show when={debt(a.name)} fallback={
              <div class="text-neutral-600">compression debt: not reported by this stack</div>
            }>
              <div class={
                debt(a.name)!.state === 'critical' ? 'text-rose-300'
                : debt(a.name)!.state === 'degraded' ? 'text-amber-300/90'
                : 'text-neutral-500'
              }>
                compression debt: {debt(a.name)!.state ?? '?'}
                {' · '}{debt(a.name)!.pendingChunks ?? 0} chunk(s) pending
                <Show when={(debt(a.name)!.pendingChunks ?? 0) > 0}>
                  <span>
                    {debt(a.name)!.oldestPendingAgeMs != null
                      ? ` · oldest ${Math.round(debt(a.name)!.oldestPendingAgeMs! / 60000)}m`
                      : ' · age unknown'}
                  </span>
                </Show>
                <Show when={(debt(a.name)!.mergeQueueDepth ?? 0) > 0}>
                  <span> · merge queue {debt(a.name)!.mergeQueueDepth}</span>
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

            {/* What was actually SENT, and how it split. Composition is
                in-process render stats (free); call stats come from the ledger
                the client already holds. */}
            <Show when={composition(a.name)}>
              {(c) => (
                <div class="border-t border-neutral-900 pt-1.5">
                  <CompositionBlock c={c()} />
                </div>
              )}
            </Show>

            <Show when={(props.ledger?.length ?? 0) > 0}>
              <div class="border-t border-neutral-900 pt-1.5">
                <CallStats rows={props.ledger!} />
              </div>
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
