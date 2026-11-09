import { For, Show } from 'solid-js';
import type { CallLedgerRow } from '@conhost/web/protocol';
import { callFailed, callOriginLabel, callOriginTone } from './call-origin';
import { healthComposition, lastInferenceLine, latestInferenceError } from './composition-text';
import { credentialNote, healthEntry, lastActionText, readFailureLine } from '@conhost/web/health-lookup';
import { quarantineHeld } from '@conhost/web/quarantine-alert';
import { loadRepairLines, type LoadRepairReport } from '@conhost/web/load-repair-alert';
import { debtNextStep, debtSummary, debtTone, type CompressionDebt, type DebtTone } from '@conhost/web/compression-debt';
import type { UpdateStatus, UpdateWay } from '@conhost/web/update-text';
import { UpdateBlock } from './Update';

export interface OpsAlert {
  key: string;
  kind: string;
  agent: string;
  message: string;
  at: number;
  count: number;
  actions?: CredentialAction[];
  scope?: string;
}

export interface CredentialAction {
  id: string;
  label: string;
  hint?: string;
}

export interface CredentialInfo {
  subscription?: boolean;
  agent?: string;
  kind?: string;
  provider?: string;
  message?: string;
  since?: number;
  until?: number;
  windows?: string[];
  rotatable?: boolean;
  expiresAt?: number;
  actions?: CredentialAction[];
  login?: { verificationUrl: string; userCode: string };
  lastAction?: { id: string; at: number; ok: boolean; message: string };
}

export const CREDENTIAL_ALERT_KINDS = [
  'quota-spent', 'quota-unreadable', 'auth-expiring', 'auth-expired', 'auth-rejected', 'auth-login-required',
] as const;

export interface ContextComposition {
  head?: { messages: number; tokens: number };
  tail?: { messages: number; tokens: number };
  middleRaw?: { messages: number; tokens: number };
  summaries?: Record<string, { count: number; tokens: number }>;
  total?: { messages: number; tokens: number };
}

export type LedgerRow = CallLedgerRow;

export interface HealthSnapshot {
  at?: string;
  credential?: CredentialInfo;
  update?: UpdateStatus;
  contextComposition?: Record<string, ContextComposition>;
  contextCompositionNotKept?: string[];
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
      endedAt?: number;
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
  compressionQuarantine?: Record<string, { count?: number; keys?: string[]; spans?: unknown[] }>;
  loadRepair?: Record<string, LoadRepairReport>;

  compressionDebt?: Record<string, CompressionDebt>;
  runtimeSettings?: Record<string, {
    contextBudgetTokens?: number;
    tailTokens?: number;
    transitionPaceTokens?: number;
    sameRoundThinkTextPolicy?: string;
    sameRoundThinkTextPolicySource?: string;
    transition?: string;
    transitionReason?: string;
  }>;
  readFailures?: Record<string, Record<string, string>>;
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

const HARD_DOWN_KINDS = new Set([
  'compression-quarantine', 'inference-exhausted', 'hard-down',
  'quota-spent', 'auth-expired', 'auth-rejected', 'auth-login-required',
]);
const alertTone = (kind: string): { row: string; dot: string } =>
  HARD_DOWN_KINDS.has(kind)
    ? { row: 'bg-rose-950/60 border-rose-900 text-rose-200', dot: 'bg-rose-500 animate-pulse' }
    : { row: 'bg-amber-950/60 border-amber-900 text-amber-200', dot: 'bg-amber-500' };

const DEBT_TONE_CLASS: Record<DebtTone, string> = {
  alarm: 'text-rose-300',
  unread: 'text-rose-300/90',
  warn: 'text-amber-300/90',
  quiet: 'text-neutral-500',
};

export function CredentialActionButtons(props: {
  actions: CredentialAction[] | undefined;
  onAction(actionId: string): void;
  disabled?: boolean;
}) {
  return (
    <Show when={props.actions && props.actions.length > 0}>
      <span class="flex items-center gap-1 shrink-0">
        <For each={props.actions}>{(act) => (
          <button
            type="button"
            class="px-1.5 py-0.5 rounded border border-current/40 hover:bg-white/10 font-mono text-[10px] disabled:opacity-40"
            title={act.hint ?? act.label}
            disabled={props.disabled}
            onClick={() => props.onAction(act.id)}
          >
            {act.label}
          </button>
        )}</For>
      </span>
    </Show>
  );
}

export function OpsAlertStrip(props: {
  alerts: OpsAlert[];
  onDismiss(key: string): void;
  onAction?(alert: OpsAlert, actionId: string): void;
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
          <Show when={props.onAction}>
            <CredentialActionButtons actions={a.actions} onAction={(id) => props.onAction!(a, id)} />
          </Show>
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
  const recent = () => [...props.rows].reverse().slice(0, 24);

  const clock = (ts: string) => {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(11, 19);
  };
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
                return (
                  <tr class={`border-b border-neutral-900 ${
                    callFailed(r) || r.stopReason === 'refusal' ? 'bg-red-950/30' : ''
                  }`}>
                    <td class="pr-2 text-neutral-500">{clock(r.timestamp)}</td>
                    <td class={`pr-2 ${callOriginTone(r.originEstimate)}`}>
                      {callOriginLabel(r.originEstimate)}
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
                      <Show when={callFailed(r)}>
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
        <span class={callOriginTone('turn~')}>{callOriginLabel('turn~')}</span> = main inference,
        <span class={callOriginTone('aux~')}> {callOriginLabel('aux~')}</span> = compression/summarizer — inferred from
        stream-vs-complete, not a definitive tag (hence <span class="font-mono">~</span> upstream).
        One turn may appear as a turn row plus several compr rows.
        <span class={callOriginTone('keepalive')}> {callOriginLabel('keepalive')}</span> = a cache keepalive poke, which replays a lineage's
        last request while the agent is idle; exact, from its receipt.
        <span class="font-mono"> fresh</span> = tokens billed as new input;
        <span class="font-mono"> cached</span> = read from cache;
        <span class="font-mono"> %c</span> = cached ÷ (fresh+cached);
        <span class="font-mono"> bp</span> = cache breakpoints.
      </div>
    </div>
  );
}

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
        context composition (last live compile)
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

export function CredentialSection(props: {
  credential: CredentialInfo | undefined;
  onAction(actionId: string): void;
}) {
  const c = () => props.credential;
  const kind = () => c()?.kind ?? 'ok';
  const tone = () => kind() === 'ok' ? 'text-emerald-400' : HARD_DOWN_KINDS.has(kind()) ? 'text-rose-300' : 'text-amber-300';
  const iso = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
  return (
    <Show when={c()?.subscription !== false && c()}>
      <section class="border border-neutral-800 rounded px-2.5 py-2 space-y-1">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-neutral-100">credential</span>
          <span class="text-neutral-500">{c()!.provider ?? '?'}</span>
          <span class={tone()}>{kind()}</span>
          <span class="ml-auto">
            <CredentialActionButtons
              actions={kind() === 'ok' ? [{ id: 'recheck', label: 'Re-check' }] : c()!.actions}
              onAction={props.onAction}
            />
          </span>
        </div>
        <Show when={credentialNote(c()!)}>
          {(note) => <div class={`${tone()} break-words`}>{note()}</div>}
        </Show>
        <div class="text-neutral-500">
          {c()!.expiresAt !== undefined
            ? `expires ${iso(c()!.expiresAt!)} · ${c()!.rotatable ? 'host can refresh' : 'no refresh token — paste a new one when it expires'}`
            : `expiry unknown · ${c()!.rotatable ? 'host can refresh' : 'not host-rotatable'}`}
        </div>
        <Show when={c()!.login}>
          <div class="text-amber-200">
            login: open <a class="underline" href={c()!.login!.verificationUrl} target="_blank" rel="noreferrer">{c()!.login!.verificationUrl}</a>
            {' '}and enter code <span class="font-semibold">{c()!.login!.userCode}</span>
          </div>
        </Show>
        <Show when={c()!.lastAction}>
          <div class={c()!.lastAction!.ok ? 'text-neutral-400' : 'text-rose-300'}>
            last action: {lastActionText(c()!.lastAction!, fmtAgo(c()!.lastAction!.at))}
          </div>
        </Show>
      </section>
    </Show>
  );
}

export function HealthPanel(props: {
  health: HealthSnapshot | null;
  ledger?: LedgerRow[];
  error: string | null;
  onRefresh(): void;
  credential?: CredentialInfo | null;
  onCredentialAction?(actionId: string): void;
  update?: UpdateStatus | null;
  onUpdateWay?(way: UpdateWay): void;
}) {
  const agents = () => props.health?.agents ?? [];
  const quarantine = (name: string) => healthEntry(props.health?.compressionQuarantine, name);
  const loadRepair = (name: string) => healthEntry(props.health?.loadRepair, name);
  const debt = (name: string) => healthEntry(props.health?.compressionDebt, name);
  const settings = (name: string) => healthEntry(props.health?.runtimeSettings, name);
  const failures = (name: string) => healthEntry(props.health?.readFailures, name);
  const compositionView = (name: string) => healthComposition(props.health, name);
  const compositionStats = (name: string) => {
    const view = compositionView(name);
    return view && 'stats' in view ? view.stats : undefined;
  };
  const compositionLine = (name: string) => {
    const view = compositionView(name);
    return view && 'line' in view ? view.line : undefined;
  };

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
            <span>{props.health!.pendingRequests} inference queued</span>
          </Show>
          <Show when={props.health!.activeStreams !== undefined}>
            <span>{props.health!.activeStreams!.length} streaming</span>
          </Show>
        </div>

        <Show when={props.update}>
          {(update) => <UpdateBlock status={update()} onWay={props.onUpdateWay} />}
        </Show>

        <Show when={props.onCredentialAction}>
          <CredentialSection
            credential={props.credential ?? props.health!.credential}
            onAction={(id) => props.onCredentialAction!(id)}
          />
        </Show>

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

            <Show when={latestInferenceError(a.lastInference)}>
              {(error) => (
                <div class="text-rose-300/80 truncate" title={error()}>
                  last error: {error()}
                </div>
              )}
            </Show>
            <Show when={lastInferenceLine(a.lastInference, fmtAgo)}>
              {(line) => <div class="text-neutral-500">{line()}</div>}
            </Show>

            <Show when={quarantine(a.name) && (quarantine(a.name)!.count ?? 0) > 0}>
              <div class="text-rose-300 bg-rose-950/30 border border-rose-900/50 rounded px-2 py-1">
                ⚠ {quarantineHeld(quarantine(a.name)!)} — raw spans
                accumulate until the window can't fit. Inspect, then branch, pin, or clear.
                <Show when={(quarantine(a.name)!.keys?.length ?? 0) > 0}>
                  <div class="text-rose-400/70 truncate" title={quarantine(a.name)!.keys!.join(', ')}>
                    {quarantine(a.name)!.keys!.join(', ')}
                  </div>
                </Show>
              </div>
            </Show>

            <Show when={loadRepair(a.name)}>
              {(r) => (
                <div class="text-amber-200 bg-amber-950/30 border border-amber-900/50 rounded px-2 py-1 break-words space-y-1">
                  <div>⚠ Memory load repair (latest this session)</div>
                  <For each={loadRepairLines(r(), a.name)}>
                    {(line) => <div>{line}</div>}
                  </For>
                </div>
              )}
            </Show>

            <Show when={failures(a.name)}>
              {(f) => (
                <div class="text-rose-300/90">
                  <For each={Object.entries(f())}>
                    {([section, message]) => (
                      <div class="truncate" title={message || undefined}>{readFailureLine(section, message)}</div>
                    )}
                  </For>
                </div>
              )}
            </Show>

            <Show when={debt(a.name)} fallback={
              <Show when={healthEntry(failures(a.name), 'compressionDebt') === undefined}>
                <div class="text-neutral-600">compression debt: not reported by this stack</div>
              </Show>
            }>
              {(d) => (
                <div class={DEBT_TONE_CLASS[debtTone(d())]}>
                  {debtSummary(d())}
                  <Show when={d().error}>
                    {(error) => <div class="text-rose-300/90 whitespace-pre-line break-words">{error()}</div>}
                  </Show>
                  <Show when={debtNextStep(d())}>
                    {(step) => <div class="text-neutral-300 whitespace-normal break-words">{step()}</div>}
                  </Show>
                </div>
              )}
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

            <Show
              when={compositionStats(a.name)}
              fallback={
                <Show when={compositionLine(a.name)}>
                  {(line) => (
                    <div class="border-t border-neutral-900 pt-1.5 text-[10px] text-neutral-500">{line()}</div>
                  )}
                </Show>
              }
            >
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
