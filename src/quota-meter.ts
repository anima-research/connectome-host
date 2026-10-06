/**
 * Subscription quota meter.
 *
 * A subscription credential (Claude OAuth token, ChatGPT/Codex login) is not
 * billed per token: it draws down several overlapping utilization windows
 * (5-hour, weekly, per-model weekly, ...). When one is exhausted the provider
 * answers 429 — which the pay-per-token machinery reads as a throttle and
 * retries into. The windows are readable out-of-band, at no inference cost,
 * so the meter POLLS them instead of scraping inference responses:
 *
 *   - display surfaces (TUI status line, WebUI) poll only while someone is
 *     looking (`watch()` / the `quota` panel op);
 *   - the provider-hold hook reads the cached snapshot synchronously and asks
 *     for a refresh, so a headless host learns "this 429 is a spent quota,
 *     park until it resets" without anyone watching.
 *
 * Both provider surfaces are private to their vendors' own CLIs. Every parse
 * here is defensive: an unreadable answer is "no reading", never a guess.
 */

/** One utilization window, provider-neutral. */
export interface QuotaWindow {
  /** Stable id: `five_hour`, `seven_day`, `seven_day_opus`, `weekly:<model>`, ... */
  key: string;
  /** Short label for a status line: `5h`, `weekly`, `opus wk`. */
  label: string;
  /** Percent of the window used, 0–100 (may exceed 100 on overage). */
  utilization: number;
  /** Epoch ms at which the window resets, when the provider says. */
  resetsAt?: number;
  /** Set on a model-scoped window (`opus`, `sonnet`, ...): it constrains only
   *  agents running a model whose id contains this token. */
  model?: string;
  /** Shown, but never grounds for a hold: whether it constrains this
   *  credential is not known. */
  advisory?: boolean;
}

export interface QuotaSnapshot {
  provider: string;
  windows: QuotaWindow[];
  /** Epoch ms of the last successful read. */
  fetchedAt: number;
  /** Last refresh failure since then, if any. The windows are then stale. */
  error?: string;
}

export interface QuotaSource {
  readonly provider: string;
  fetchWindows(): Promise<QuotaWindow[]>;
}

/** A window at or past this utilization is treated as spent. */
const EXHAUSTED_PCT = 100;
/** Floor between provider reads, whoever asks. The usage endpoints are
 *  themselves rate-limited; several viewers must not multiply the load. */
const MIN_REFRESH_INTERVAL_MS = 30_000;
const WATCH_INTERVAL_MS = 60_000;
/** Unwatched cadence while a window is spent — notices an early reset. */
const BLOCKED_INTERVAL_MS = 5 * 60_000;
const MAX_ERROR_BACKOFF_MS = 15 * 60_000;
/** A spent window with no reset time grounds a hold only on a reading this
 *  fresh; an old one may describe a window that has since rolled over. */
const UNKNOWN_RESET_TRUST_MS = 30 * 60_000;

export interface QuotaMeterOptions {
  now?: () => number;
  minRefreshIntervalMs?: number;
  watchIntervalMs?: number;
  blockedIntervalMs?: number;
}

export class QuotaMeter {
  private snapshot: QuotaSnapshot | null = null;
  private inFlight: Promise<QuotaSnapshot | null> | null = null;
  private lastAttemptAt = 0;
  private consecutiveErrors = 0;
  private watchers = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<(snapshot: QuotaSnapshot) => void>();
  private disposed = false;
  private readonly now: () => number;
  private readonly minRefreshIntervalMs: number;
  private readonly watchIntervalMs: number;
  private readonly blockedIntervalMs: number;

  constructor(private readonly source: QuotaSource, options: QuotaMeterOptions = {}) {
    this.now = options.now ?? Date.now;
    this.minRefreshIntervalMs = options.minRefreshIntervalMs ?? MIN_REFRESH_INTERVAL_MS;
    this.watchIntervalMs = options.watchIntervalMs ?? WATCH_INTERVAL_MS;
    this.blockedIntervalMs = options.blockedIntervalMs ?? BLOCKED_INTERVAL_MS;
  }

  get provider(): string {
    return this.source.provider;
  }

  getSnapshot(): QuotaSnapshot | null {
    return this.snapshot;
  }

  onChange(listener: (snapshot: QuotaSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Read the provider unless a read happened within the floor (then the
   * cached snapshot is the answer). Single-flight. Never throws: a failed
   * read keeps the previous windows and records `error`.
   */
  refresh(): Promise<QuotaSnapshot | null> {
    if (this.disposed) return Promise.resolve(this.snapshot);
    if (this.inFlight) return this.inFlight;
    if (this.floorRemainingMs() > 0) {
      // Suppressed, not abandoned: a timer-driven caller has just spent its
      // timer, so re-arm for when the floor (or error backoff) lets a read through.
      this.schedule();
      return Promise.resolve(this.snapshot);
    }
    this.lastAttemptAt = this.now();
    this.inFlight = this.source.fetchWindows()
      .then((windows) => {
        this.consecutiveErrors = 0;
        this.snapshot = { provider: this.source.provider, windows, fetchedAt: this.now() };
      })
      .catch((err: unknown) => {
        this.consecutiveErrors++;
        const error = err instanceof Error ? err.message : String(err);
        this.snapshot = this.snapshot
          ? { ...this.snapshot, error }
          : { provider: this.source.provider, windows: [], fetchedAt: 0, error };
      })
      .then(() => {
        this.inFlight = null;
        const snapshot = this.snapshot!;
        for (const listener of this.listeners) {
          try { listener(snapshot); } catch { /* a display bug must not stop polling */ }
        }
        this.schedule();
        return snapshot;
      });
    return this.inFlight;
  }

  /**
   * Hold the meter at display cadence while a surface is visible. Returns the
   * release; polling stops when the last watcher releases (unless a window is
   * spent — see `schedule`).
   */
  watch(): () => void {
    this.watchers++;
    void this.refresh();
    this.schedule();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.watchers = Math.max(0, this.watchers - 1);
      this.schedule();
    };
  }

  /**
   * Epoch ms until which inference is pointless because a window is spent, or
   * undefined. Windows whose reset has already passed are ignored — the
   * snapshot predates the reset and says nothing about the new window.
   * A model-scoped window counts only for a `model` it applies to: a spent
   * Opus window must not park a Sonnet agent over an unrelated throttle.
   */
  blockedUntil(model?: string): number | undefined {
    const now = this.now();
    let until: number | undefined;
    for (const w of this.spentWindows(model)) {
      if (w.resetsAt === undefined || w.resetsAt <= now) continue;
      until = until === undefined ? w.resetsAt : Math.max(until, w.resetsAt);
    }
    return until;
  }

  spentWindows(model?: string): QuotaWindow[] {
    return (this.snapshot?.windows ?? []).filter((w) =>
      w.utilization >= EXHAUSTED_PCT && !w.advisory
      && (w.model === undefined || (model !== undefined && model.toLowerCase().includes(w.model))));
  }

  /** Ms until the refresh floor (stretched by error backoff) allows a read. */
  private floorRemainingMs(): number {
    if (this.lastAttemptAt === 0) return 0;
    const floor = this.consecutiveErrors > 0
      ? Math.min(MAX_ERROR_BACKOFF_MS, this.minRefreshIntervalMs * 2 ** this.consecutiveErrors)
      : this.minRefreshIntervalMs;
    return Math.max(0, floor - (this.now() - this.lastAttemptAt));
  }

  /** A spent window the provider gave no reset time for, on a reading recent
   *  enough to act on: grounds for one hold slice, then look again. */
  spentWithUnknownReset(model?: string): boolean {
    if (!this.snapshot || this.now() - this.snapshot.fetchedAt > UNKNOWN_RESET_TRUST_MS) return false;
    return this.spentWindows(model).some((w) => w.resetsAt === undefined);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.disposed) return;
    // Any spent window keeps the unwatched poll alive, model-scoped or not:
    // which agents it constrains is the hook's question, not the scheduler's.
    const now = this.now();
    const spent = (this.snapshot?.windows ?? []).some((w) =>
      w.utilization >= EXHAUSTED_PCT && !w.advisory && (w.resetsAt === undefined || w.resetsAt > now));
    const interval = this.watchers > 0 ? this.watchIntervalMs : spent ? this.blockedIntervalMs : 0;
    if (interval <= 0) return;
    this.timer = setTimeout(() => void this.refresh(), Math.max(interval, this.floorRemainingMs()));
    this.timer.unref?.();
  }
}

// ---------------------------------------------------------------------------
// Readout
// ---------------------------------------------------------------------------

/**
 * `10% weekly | 99% 5h` — every window the provider reports, longest first.
 * Null when there is no reading (callers fall back to whatever they showed
 * before; a subscription host must not print a made-up dollar figure).
 */
export function formatQuotaReadout(snapshot: QuotaSnapshot | null): string | null {
  if (!snapshot || snapshot.windows.length === 0) return null;
  const parts = snapshot.windows.map((w) => `${Math.floor(w.utilization)}% ${w.label}`);
  return parts.join(' | ') + (snapshot.error ? ' (stale)' : '');
}

// ---------------------------------------------------------------------------
// Provider-hold hook
// ---------------------------------------------------------------------------

export interface ProviderHold {
  holdMs: number;
  reason: string;
}

/** The framework re-consults the hook when a hold expires, so a long wait is
 *  served in slices: an early reset (plan change, manual reset) is noticed
 *  within one slice instead of after days. */
const MAX_HOLD_SLICE_MS = 10 * 60_000;

/**
 * Build the framework `providerHold` hook: a rate-limit failure while a quota
 * window is spent parks the agent until the window resets, instead of
 * retrying a request that cannot succeed and recording each attempt as a
 * failed turn. Synchronous over the cached snapshot; every consultation also
 * kicks a (rate-floored) refresh, so a stale or empty snapshot is corrected
 * by the ordinary retry that follows.
 */
export function quotaProviderHold(
  meter: QuotaMeter,
  modelFor: (agentName: string) => string | undefined = () => undefined,
  now: () => number = Date.now,
): (error: Error, agentName: string, context?: { model?: string }) => ProviderHold | undefined {
  return (error, agentName, context) => {
    if ((error as { type?: unknown }).type !== 'rate_limit') return undefined;
    void meter.refresh();
    // The framework names the failing agent's own model when it can (a
    // subconscious may run a different one than the recipe's agent).
    const model = context?.model ?? modelFor(agentName);
    const until = meter.blockedUntil(model);
    const spent = meter.spentWindows(model).map((w) => w.label);
    if (until === undefined) {
      if (!meter.spentWithUnknownReset(model)) return undefined;
      return {
        holdMs: MAX_HOLD_SLICE_MS,
        reason: `${meter.provider} subscription quota spent (${spent.join(', ')}); reset time not reported`,
      };
    }
    return {
      holdMs: Math.max(1_000, Math.min(MAX_HOLD_SLICE_MS, until - now())),
      reason: `${meter.provider} subscription quota spent (${spent.join(', ')}); resets ${new Date(until).toISOString()}`,
    };
  };
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** ISO 8601, or — as the vendor's own client also tolerates — epoch seconds. */
function isoToMs(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value * 1000 : undefined;
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Longest window first — the order the readout prints them in. */
const ANTHROPIC_WINDOWS: Array<[key: string, label: string, model?: string]> = [
  ['seven_day', 'weekly'],
  ['seven_day_opus', 'opus wk', 'opus'],
  ['seven_day_sonnet', 'sonnet wk', 'sonnet'],
  ['seven_day_oauth_apps', 'apps wk'],
  ['five_hour', '5h'],
];

/**
 * Parse the Claude subscription usage document: one `{utilization (0–100),
 * resets_at (ISO 8601)}` object per window, null/absent when the plan has no
 * such window, plus a `limits[]` array of model-scoped weekly windows.
 */
export function parseAnthropicUsage(body: unknown): QuotaWindow[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const doc = body as Record<string, unknown>;
  const windows: QuotaWindow[] = [];
  const push = (key: string, label: string, utilization: unknown, resetsAt: unknown, model?: string): void => {
    const pct = num(utilization);
    // The same model window can appear both as a named key and in limits[].
    if (pct === undefined || windows.some((w) => w.label === label)) return;
    const at = isoToMs(resetsAt);
    windows.push({
      key, label, utilization: pct,
      ...(at !== undefined ? { resetsAt: at } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(key === 'seven_day_oauth_apps' ? { advisory: true } : {}),
    });
  };
  for (const [key, label, scope] of ANTHROPIC_WINDOWS) {
    const w = doc[key];
    if (!w || typeof w !== 'object') continue;
    push(key, label, (w as Record<string, unknown>).utilization, (w as Record<string, unknown>).resets_at, scope);
    if (key !== 'seven_day') continue;
    // Model-scoped weekly windows sit with the other weekly readings.
    for (const raw of Array.isArray(doc.limits) ? doc.limits : []) {
      if (!raw || typeof raw !== 'object') continue;
      const limit = raw as Record<string, unknown>;
      const model = (limit.scope as { model?: { display_name?: unknown } } | undefined)?.model?.display_name;
      if (typeof model !== 'string' || !model) continue;
      const token = model.toLowerCase();
      push(`weekly:${token}`, `${token} wk`, limit.percent ?? limit.utilization, limit.resets_at, token);
    }
  }
  return windows;
}

export interface AnthropicOAuthQuotaSourceConfig {
  authToken: string;
  /** Same override the inference adapter honors. A gateway that does not
   *  proxy the usage path simply yields "no reading". */
  baseURL?: string;
  fetchImpl?: typeof fetch;
}

export class AnthropicOAuthQuotaSource implements QuotaSource {
  readonly provider = 'anthropic';
  constructor(private readonly config: AnthropicOAuthQuotaSourceConfig) {}

  async fetchWindows(): Promise<QuotaWindow[]> {
    const base = (this.config.baseURL ?? 'https://api.anthropic.com').replace(/\/+$/, '');
    const res = await (this.config.fetchImpl ?? fetch)(`${base}/api/oauth/usage`, {
      headers: {
        authorization: `Bearer ${this.config.authToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`usage endpoint answered HTTP ${res.status}`);
    return parseAnthropicUsage(await res.json());
  }
}

function codexWindowLabel(minutes: number | undefined, fallback: string): string {
  if (minutes === undefined) return fallback;
  if (minutes === 7 * 24 * 60) return 'weekly';
  if (minutes === 24 * 60) return 'day';
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/**
 * Parse a Codex app-server `account/rateLimits/read` result: `rateLimits`
 * (or, preferred when present, `rateLimitsByLimitId.codex`) carries up to two windows, each `{usedPercent, windowDurationMins,
 * resetsAt (epoch seconds)}`.
 */
export function parseCodexRateLimits(result: unknown): QuotaWindow[] {
  const doc = (result ?? {}) as { rateLimits?: unknown; rateLimitsByLimitId?: unknown };
  // Newer servers key the buckets by limit id; `rateLimits` is the legacy
  // single bucket, which is only ours when it is unlabelled or says `codex`.
  const keyed = (doc.rateLimitsByLimitId as Record<string, unknown> | null | undefined)?.codex;
  const legacy = doc.rateLimits as { limitId?: unknown; limitName?: unknown } | null | undefined;
  const legacyIsCodex = !!legacy && typeof legacy === 'object'
    && (legacy.limitId === 'codex' || (legacy.limitId == null && (legacy.limitName == null || legacy.limitName === 'codex')));
  const limits = keyed && typeof keyed === 'object' ? keyed : legacyIsCodex ? legacy : null;
  if (!limits) return [];
  const windows: QuotaWindow[] = [];
  for (const slot of ['primary', 'secondary'] as const) {
    const w = (limits as Record<string, unknown>)[slot];
    if (!w || typeof w !== 'object') continue;
    const rec = w as Record<string, unknown>;
    const pct = num(rec.usedPercent);
    if (pct === undefined) continue;
    const minutes = num(rec.windowDurationMins);
    const resetsAt = num(rec.resetsAt);
    windows.push({
      key: minutes !== undefined ? `${minutes}m` : slot,
      label: codexWindowLabel(minutes, slot),
      utilization: pct,
      ...(resetsAt !== undefined ? { resetsAt: resetsAt * 1000 } : {}),
    });
  }
  // Longest window first, matching the Anthropic readout.
  return windows.sort((a, b) => (parseInt(b.key, 10) || 0) - (parseInt(a.key, 10) || 0));
}

export class CodexQuotaSource implements QuotaSource {
  readonly provider = 'openai-codex';
  constructor(private readonly readRateLimits: () => Promise<unknown>) {}

  async fetchWindows(): Promise<QuotaWindow[]> {
    return parseCodexRateLimits(await this.readRateLimits());
  }
}
