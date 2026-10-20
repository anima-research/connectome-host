/**
 * Recent provider-call ledger for the WebUI.
 *
 * The provider adapter feeds this tracker compact, content-free call records.
 * It reconstructs the cache verdict operators actually need (hit, first
 * write, expired rewrite, uncached auxiliary call) and retains a bounded
 * window. Older process logs are replayed on startup so a host restart does
 * not leave the dashboard blank.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CALL_LOG_READ_BUDGET, readLinesFromEnd } from './call-log-tail.js';
import type {
  CallLedgerRow,
  CallLedgerSnapshot,
  CallLedgerVerdict,
} from './web/protocol.js';
import { ANTHROPIC_PRICING_VERSION, priceAnthropicCall } from './call-pricing.js';

export interface ProviderCallRecord {
  timestamp: string;
  kind: 'complete' | 'stream' | 'keepalive';
  durationMs: number;
  model: string;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Provider-reported cache creation buckets. These remain separate because
   *  Anthropic charges different multipliers for 5m and 1h writes. */
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  /** True only when the split came from the response usage object. */
  cacheWriteBucketsAuthoritative?: boolean;
  inferenceGeo?: string;
  serviceTier?: string;
  /** Undefined for historical compact logs written before cache summaries. */
  cacheBreakpoints?: number;
  /** TTLs found on cache_control blocks. `default` means provider default. */
  cacheTtls?: string[];
  stopReason?: string;
  /** Present exactly when the call failed: its error text, which can be empty. */
  error?: string;
  /** membrane's key for the call's cache lineage: its model, system and
   *  tools. Undefined for rows written before it was recorded. */
  lineage?: string;
}

/** The cache lineages a ledger remembers the last activity of, the least
 *  recently active forgotten first: far more than the lineages a resident
 *  runs, one for each model, system prompt and tool list it calls with. One
 *  forgotten is measured as one not yet seen. */
const LINEAGES_REMEMBERED = 256;

export interface CallLedgerOptions {
  dataDir?: string;
  defaultTtl?: '5m' | '1h';
  maxRows?: number;
  hydrate?: boolean;
}

type Listener = (snapshot: CallLedgerSnapshot) => void;

export class CallLedger {
  private readonly rows: CallLedgerRow[] = [];
  private readonly maxRows: number;
  private readonly defaultTtl: '5m' | '1h';
  private readonly listeners = new Set<Listener>();
  private lastCacheActivityAt: number | null = null;
  /** The last cache activity of each lineage, least recent first. */
  private readonly lastCacheActivityByLineage = new Map<string, number>();
  private sequence = 0;

  constructor(opts: CallLedgerOptions = {}) {
    this.maxRows = opts.maxRows ?? 200;
    this.defaultTtl = opts.defaultTtl ?? '5m';
    if (opts.hydrate !== false && opts.dataDir) this.hydrate(opts.dataDir);
  }

  record(call: ProviderCallRecord): void {
    this.append(call, true);
  }

  onUpdate(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): CallLedgerSnapshot {
    const rows = this.rows.map((r) => ({
      ...r,
      tokens: { ...r.tokens },
      cache: { ...r.cache, ttls: [...r.cache.ttls] },
      ...(r.cost ? { cost: { ...r.cost, rates: { ...r.cost.rates } } } : {}),
    }));
    const byVerdict: Partial<Record<CallLedgerVerdict, number>> = {};
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let totalCost = 0;
    let pricedCalls = 0;
    for (const row of rows) {
      byVerdict[row.verdict] = (byVerdict[row.verdict] ?? 0) + 1;
      input += row.tokens.input;
      output += row.tokens.output;
      cacheRead += row.tokens.cacheRead;
      cacheWrite += row.tokens.cacheWrite;
      if (row.cost) {
        totalCost += row.cost.total;
        pricedCalls++;
      }
    }
    const cacheDenominator = input + cacheRead + cacheWrite;
    return {
      rows,
      summary: {
        calls: rows.length,
        input,
        output,
        cacheRead,
        cacheWrite,
        cacheHitRatio: cacheDenominator > 0 ? cacheRead / cacheDenominator : 0,
        cost: {
          total: totalCost,
          currency: 'USD',
          pricedCalls,
          unpricedCalls: rows.length - pricedCalls,
          pricingVersion: ANTHROPIC_PRICING_VERSION,
        },
        byVerdict,
      },
    };
  }

  private append(call: ProviderCallRecord, notify: boolean): void {
    const at = Date.parse(call.timestamp);
    const ttl = effectiveTtl(call.cacheTtls, this.defaultTtl);
    const ttlSeconds = ttl === '1h' ? 3600 : 300;
    const hasKnownFlags = call.cacheBreakpoints !== undefined;
    const hasCacheControls = (call.cacheBreakpoints ?? 0) > 0;
    // A call's gap runs from the last cache activity in its lineage. Another
    // lineage's calls or keepalive pokes say nothing of whether this one's
    // entry expired. A lineage not seen yet, as after a change to the system
    // prompt or the tools, and a row that names none, are measured from the
    // last activity of any: a changed prefix still reads as one while that
    // gap is inside the call's TTL, and as expired past it. For a lineage the
    // ledger doesn't hold, the cause says the gap is any lineage's, since a
    // new agent's first call, or a lineage last active before what the
    // ledger holds, reads the same.
    const ownCacheAt = call.lineage !== undefined ? this.lastCacheActivityByLineage.get(call.lineage) : undefined;
    const priorCacheAt = ownCacheAt ?? this.lastCacheActivityAt;
    const gapFromAnyLineage = call.lineage !== undefined && ownCacheAt === undefined;
    const gapSeconds = priorCacheAt !== null && Number.isFinite(at)
      ? Math.max(0, Math.round((at - priorCacheAt) / 1000))
      : undefined;

    const { verdict, cause } = classifyCall({
      call,
      hasKnownFlags,
      hasCacheControls,
      ttlSeconds,
      gapSeconds,
      gapFromAnyLineage,
    });

    const write5m = call.cacheWrite5mTokens ?? 0;
    const write1h = call.cacheWrite1hTokens ?? 0;
    const reportedSplit = write5m + write1h;
    const splitMismatch = call.cacheWriteTokens > 0 && (
      !call.cacheWriteBucketsAuthoritative || reportedSplit !== call.cacheWriteTokens
    );
    // A failure is priced at nothing, whatever its text: an empty one too.
    const cost = call.error !== undefined ? undefined : priceAnthropicCall(call.model, call.timestamp, {
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      cacheReadTokens: call.cacheReadTokens,
      cacheWrite5mTokens: write5m,
      cacheWrite1hTokens: write1h,
      unclassifiedCacheWriteTokens: splitMismatch
        ? Math.max(1, Math.abs(call.cacheWriteTokens - reportedSplit))
        : 0,
      inferenceGeo: call.inferenceGeo,
      serviceTier: call.serviceTier,
    });

    const row: CallLedgerRow = {
      id: `${call.timestamp}:${++this.sequence}`,
      timestamp: call.timestamp,
      kind: call.kind,
      originEstimate: call.kind === 'keepalive' ? 'keepalive' : call.kind === 'stream' ? 'turn~' : 'aux~',
      model: call.model,
      messages: call.messages,
      durationMs: call.durationMs,
      tokens: {
        input: call.inputTokens,
        output: call.outputTokens,
        cacheRead: call.cacheReadTokens,
        cacheWrite: call.cacheWriteTokens,
      },
      ...(cost ? { cost } : {}),
      cache: {
        breakpoints: call.cacheBreakpoints,
        ttls: call.cacheTtls?.length ? [...new Set(call.cacheTtls)] : [],
        effectiveTtl: ttl,
      },
      verdict,
      cause,
      ...(call.stopReason ? { stopReason: call.stopReason } : {}),
      ...(call.error !== undefined ? { error: call.error } : {}),
    };

    this.rows.push(row);
    if (this.rows.length > this.maxRows) this.rows.splice(0, this.rows.length - this.maxRows);
    this.noteCacheActivity(call);

    if (notify) {
      const snapshot = this.snapshot();
      for (const listener of this.listeners) {
        try { listener(snapshot); } catch { /* observability must not break inference */ }
      }
    }
  }

  /** A call that read or wrote the cache is its lineage's, and the
   *  process's, latest cache activity. */
  private noteCacheActivity(call: ProviderCallRecord): void {
    const at = Date.parse(call.timestamp);
    if (!(call.cacheReadTokens > 0 || call.cacheWriteTokens > 0) || !Number.isFinite(at)) return;
    this.lastCacheActivityAt = at;
    if (call.lineage === undefined) return;
    this.lastCacheActivityByLineage.delete(call.lineage);
    this.lastCacheActivityByLineage.set(call.lineage, at);
    if (this.lastCacheActivityByLineage.size > LINEAGES_REMEMBERED) {
      this.lastCacheActivityByLineage.delete(this.lastCacheActivityByLineage.keys().next().value!);
    }
  }

  private hydrate(dataDir: string): void {
    let files: string[];
    try {
      files = readdirSync(dataDir)
        .filter((name) => /^llm-calls\..*\.jsonl$/.test(name))
        .map((name) => join(dataDir, name))
        .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
        .slice(-4);
    } catch {
      return;
    }

    // The newest file first, all four within one budget, so the newest calls
    // are read whole, up to the writers' line bound. A line longer than what's
    // left of the budget ends the restore there, and older files go unread.
    const calls: ProviderCallRecord[] = [];
    let budget = CALL_LOG_READ_BUDGET;
    for (const file of files.reverse()) {
      let read;
      try {
        read = readLinesFromEnd(file, budget, (line) => {
          try {
            const parsed = parseLoggedCall(JSON.parse(line) as Record<string, unknown>);
            if (parsed) calls.push(parsed);
          } catch {
            // A line that isn't a call record is skipped on its own.
          }
        });
      } catch {
        // A file that can't be read is passed over. One that fails part way
        // keeps the calls read from it, and what it read isn't counted
        // against the budget.
        continue;
      }
      budget -= read.bytes;
      if (budget <= 0) break;
    }
    // Back into the order the logs hold them, oldest first, so calls that
    // share a time keep it through the sort below.
    calls.reverse();
    // A call whose time can't be read sorts first, the rest in time order:
    // a comparator that answered NaN for it would leave the calls around it
    // out of order, and a lineage's clock could then step backwards.
    const at = (call: ProviderCallRecord): number => {
      const time = Date.parse(call.timestamp);
      return Number.isFinite(time) ? time : -Infinity;
    };
    calls.sort((a, b) => {
      const x = at(a);
      const y = at(b);
      return x < y ? -1 : x > y ? 1 : 0;
    });
    // The rows kept are the newest, but every call read that read or wrote
    // the cache is its lineage's activity, as it was for the process that
    // logged it.
    const kept = Math.max(0, calls.length - this.maxRows);
    for (const call of calls.slice(0, kept)) this.noteCacheActivity(call);
    for (const call of calls.slice(kept)) this.append(call, false);
  }
}

function classifyCall(opts: {
  call: ProviderCallRecord;
  hasKnownFlags: boolean;
  hasCacheControls: boolean;
  ttlSeconds: number;
  gapSeconds?: number;
  /** The gap runs from any lineage's last activity, since the ledger holds
   *  none of this call's lineage. */
  gapFromAnyLineage?: boolean;
}): { verdict: CallLedgerVerdict; cause: string } {
  const { call, hasKnownFlags, hasCacheControls, ttlSeconds, gapSeconds, gapFromAnyLineage } = opts;
  // A call failed exactly when it carries an error, whatever its text.
  if (call.error !== undefined) return { verdict: 'ERROR', cause: call.error || 'the error carried no text' };
  if (hasKnownFlags && !hasCacheControls) {
    return { verdict: 'uncached', cause: 'no cache_control flags in request' };
  }
  if (call.cacheReadTokens > 0 && call.cacheWriteTokens > 0) {
    const pct = cachePercent(call);
    return { verdict: 'hit+extend', cause: `${pct}% from cache; wrote ${formatTokens(call.cacheWriteTokens)} more` };
  }
  if (call.cacheReadTokens > 0) {
    return { verdict: 'HIT', cause: `${cachePercent(call)}% from cache` };
  }
  if (call.cacheWriteTokens > 0) {
    if (gapSeconds === undefined) {
      return { verdict: 'first-write', cause: `created ${formatTokens(call.cacheWriteTokens)} cache tokens` };
    }
    const anyLineage = gapFromAnyLineage
      ? '; the ledger holds no earlier cache activity of this lineage, so the gap runs from any lineage\'s last'
      : '';
    if (gapSeconds > ttlSeconds) {
      return { verdict: 'rewrite:expired', cause: `gap ${gapSeconds}s > ttl ${ttlSeconds}s${anyLineage}` };
    }
    return {
      verdict: 'rewrite:unexplained',
      cause: gapFromAnyLineage
        ? `cache miss inside ttl (${gapSeconds}s <= ${ttlSeconds}s)${anyLineage}: a changed prefix, a new agent's first call, or a lineage last active before what the ledger holds`
        : `cache miss inside ttl (${gapSeconds}s <= ${ttlSeconds}s); prefix changed or was truncated`,
    };
  }
  if (!hasKnownFlags) {
    return { verdict: 'unknown', cause: 'older log has no cache_control summary' };
  }
  return { verdict: 'empty', cause: 'cache flags present; provider reported no cache activity' };
}

function cachePercent(call: ProviderCallRecord): number {
  const total = call.inputTokens + call.cacheReadTokens + call.cacheWriteTokens;
  return total > 0 ? Math.round(call.cacheReadTokens / total * 100) : 0;
}

function effectiveTtl(ttls: string[] | undefined, fallback: '5m' | '1h'): '5m' | '1h' {
  if (ttls?.includes('1h')) return '1h';
  if (ttls?.includes('5m') || ttls?.includes('default')) return '5m';
  return fallback;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Decode the vendor fields shared by live background receipts and log replay. */
export function parseLoggedCall(record: Record<string, unknown>): ProviderCallRecord | null {
  const kind = record.kind;
  const timestamp = record.timestamp;
  const summary = record.requestSummary as Record<string, unknown> | undefined;
  if ((kind !== 'complete' && kind !== 'stream' && kind !== 'keepalive') || typeof timestamp !== 'string' || !summary) return null;
  const rawResponse = record.rawResponse as Record<string, unknown> | null | undefined;
  const usage = rawResponse?.usage as Record<string, unknown> | undefined;
  const cacheCreation = usage?.cache_creation as Record<string, unknown> | undefined;
  const rawRequest = record.rawRequest;
  const summarized = rawRequest ? summarizeCacheControls(rawRequest) : undefined;
  const error = record.error as Record<string, unknown> | string | undefined;
  return {
    timestamp,
    kind,
    durationMs: number(record.durationMs),
    model: string(summary.model),
    messages: number(summary.messages),
    inputTokens: number(usage?.input_tokens),
    outputTokens: number(usage?.output_tokens),
    cacheReadTokens: number(usage?.cache_read_input_tokens),
    cacheWriteTokens: number(usage?.cache_creation_input_tokens),
    cacheWrite5mTokens: optionalNumber(cacheCreation?.ephemeral_5m_input_tokens),
    cacheWrite1hTokens: optionalNumber(cacheCreation?.ephemeral_1h_input_tokens),
    cacheWriteBucketsAuthoritative: cacheCreation !== undefined,
    inferenceGeo: optionalString(usage?.inference_geo) ?? optionalString(rawResponse?.inference_geo),
    serviceTier: optionalString(usage?.service_tier) ?? optionalString(rawResponse?.service_tier),
    cacheBreakpoints: optionalNumber(summary.cacheBreakpoints) ?? summarized?.count,
    cacheTtls: stringArray(summary.cacheTtls) ?? summarized?.ttls,
    stopReason: typeof rawResponse?.stop_reason === 'string' ? rawResponse.stop_reason : undefined,
    lineage: optionalString(summary.lineage),
    error: typeof error === 'string'
      ? error
      : typeof error?.message === 'string' ? error.message : undefined,
  };
}

/** Content-free cache_control inventory from an actual provider payload. */
export function summarizeCacheControls(raw: unknown): { count: number; ttls: string[] } {
  let count = 0;
  const ttls: string[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const obj = value as Record<string, unknown>;
    if (obj.cache_control && typeof obj.cache_control === 'object') {
      count++;
      const ttl = (obj.cache_control as Record<string, unknown>).ttl;
      ttls.push(typeof ttl === 'string' ? ttl : 'default');
    }
    for (const [key, child] of Object.entries(obj)) {
      if (key !== 'cache_control') visit(child);
    }
  };
  visit(raw);
  return { count, ttls };
}

const number = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) ? v : 0;
const string = (v: unknown): string => typeof v === 'string' ? v : '';
const optionalNumber = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const optionalString = (v: unknown): string | undefined => typeof v === 'string' && v.length > 0 ? v : undefined;
const stringArray = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? v as string[] : undefined;
