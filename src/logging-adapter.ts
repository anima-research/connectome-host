// AnthropicAdapter wrapper that appends each LLM call's RAW request, RAW
// response, and any error to a JSONL log file. Restores the Hermes-era
// `llm-calls.<iso>.jsonl` visibility we lose on the connectome stack by
// default. Successful calls keep a compact request summary; the full raw
// request is retained only for refusals, anomalous responses and errors,
// where forensic inspection matters (a keepalive poke's only with full
// payloads: see below). Serializing the full raw + normalized request on every tool-loop
// turn previously created several simultaneous copies of a large context and
// contributed to production OOMs.
//
// "Raw" means the actual Anthropic API payload (post-buildRequest, including
// `thinking`, tool definitions in Anthropic shape, etc.) and the raw provider
// response — not the membrane-normalized intermediate. We hook the membrane's
// `options.onRequest` callback (called inside anthropic.ts with the built
// request) and read `ProviderResponse.raw` for the response. Normalized
// representations are kept under separate keys for occasional cross-reference.
//
// The summary also carries `effort` when the wire request set
// `output_config.effort`, so a reasoning_effort change is checkable here,
// and `lineage`, membrane's cache lineage key of the wire request (model,
// system and tools), which the call ledger measures cache gaps within. A
// call that fails before membrane builds its request names none, and a
// keepalive row names its receipt's key.
//
// One file per process lifetime (timestamped at construction). Each line is a
// JSON object with shape:
//   { type: 'call'|'error', kind: 'complete'|'stream'|'keepalive', timestamp, durationMs,
//     messageId?, requestId?, requestSummary, rawRequest?, rawResponse, anomaly?,
//     error?, errorType?, httpStatus?, providerErrorCode?, retryable?, errorChars?, truncated? }
// A failure's `error` is { name, message, stack } with its text bounded, or
// a non-Error's text (logging-error-fields.ts). The request summary leaves
// out only the parts it can't read; a record whose response can't be read
// keeps only the head fields (summaryUnavailable: true). Logging never
// changes what the caller gets, with one older exception: the capture hook
// keeps an error thrown by a caller's own onRequest hook from failing the
// call. Logging runs after the provider call, outside its try.
// A keepalive row also carries `keepalive: { key, lane, startedAt }`: the
// lineage it refreshed, its lane, and when its send began. It keeps the
// replayed request only with full payloads on, whatever its outcome.
// Every line, newline included, stays within the shared 16 MiB UTF-8 cap
// (logging-record.ts): an oversized or unserializable record drops its raw
// request first, its raw response only if the line still doesn't fit, then
// its summaries, and `truncated` says what was dropped. Every step keeps
// `anomaly`, `messageId` and `requestId`.
//
// A complete() or stream() row also carries, when the provider response (or
// a failed call's error) exposes them, `messageId` (the provider's message
// id) and `requestId` (the provider's request id, the handle a provider needs
// to look a call up), so a call can be reported upstream without its
// content. Only this adapter's complete() and stream() rows do: keepalive
// rows, the Bedrock adapter's and the generic wrapper's don't.
//
// An anomalous response keeps its full raw request too, and its row carries
// `anomaly` (see responseAnomaly) plus one timestamped stderr line that says
// whether the row with the request was written, so the call can be replayed
// and reported. Anomalous: a response holding a client `tool_use` block
// whose stop reason is anything but 'tool_use' (observed 2026-10-19 as
// `end_turn` with a complete tool call). The row is the provider's response
// as this adapter received it: membrane with membrane#168 runs complete
// calls under `end_turn` or no stop reason; earlier membrane, and any
// membrane under other stop reasons, don't.

import { AnthropicAdapter, cacheLineageKey } from '@animalabs/membrane';
import type {
  ProviderRequest,
  ProviderResponse,
  ProviderRequestOptions,
  StreamCallbacks,
  KeepaliveCall,
} from '@animalabs/membrane';
import { appendFileSync } from 'node:fs';
import { parseLoggedCall, summarizeCacheControls, type ProviderCallRecord } from './call-ledger.js';
import { describeErrorObject } from './logging-error-fields.js';
import { serializeRecordOutcome, type RecordKept } from './logging-record.js';

/** Live read of the current reasoning setting. The host wires this to
 *  `SettingsModule.getReasoning()` so toggles via the `agent_settings` tool's
 *  reasoning_enabled field take effect on the next call without restart. */
export type ReasoningGetter = () => {
  enabled: boolean;
  budgetTokens: number;
  display?: 'summarized' | 'omitted';
  effort?: 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
};

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Whether `model` accepts `output_config.effort` at `level`. An unsupported
 *  effort is a 400 on every turn — and the agent would have no turn left to
 *  undo the setting with — so anything not known to accept it is dropped.
 *  Opus 4.5 takes low/medium/high only; the 4.6 pair adds max; xhigh arrived
 *  with Opus 4.7. Sonnet 4.5, Haiku 4.5 and older reject the parameter. A
 *  level outside the known set (a corrupt or outdated saved setting) is never
 *  sent, whatever the model. */
export function modelAcceptsEffort(model: string, level: EffortLevel): boolean {
  if (!(EFFORT_LEVELS as readonly string[]).includes(level)) return false;
  if (/claude-opus-4-5/.test(model)) return level === 'low' || level === 'medium' || level === 'high';
  if (/claude-(opus|sonnet)-4-6/.test(model)) return level !== 'xhigh';
  return /claude-(fable|mythos)-|claude-opus-(4-[7-9]|[5-9])|claude-sonnet-[5-9]/.test(model);
}
/** Whether `model` accepts `thinking: { type: 'adaptive' }`. Adaptive
 *  thinking arrived with the 4.6 pair; Haiku 4.5, Sonnet 4.5, Opus 4.5 and
 *  older reject it with a 400 ("adaptive thinking is not supported on this
 *  model"). The reasoning setting is host-wide, so without this gate every
 *  call through the shared membrane inherits it, including RetrievalModule's
 *  Haiku calls, which then fail on every compile. Unknown models are not
 *  sent the parameter, the same fail-safe posture as modelAcceptsEffort. */
export function modelAcceptsAdaptiveThinking(model: string): boolean {
  return /claude-(fable|mythos)-|claude-opus-(4-[6-9]|[5-9])|claude-sonnet-(4-6|[5-9])/.test(model);
}
export type ProviderCallObserver = (record: ProviderCallRecord) => void;

/** Exact first-system-block identity Anthropic requires on subscription
 *  (sk-ant-oat…) OAuth traffic. Verified 2026-07-09: any other first block —
 *  including this text with a suffix appended in the SAME block — is rejected
 *  with a masked 429 rate_limit_error; this block followed by arbitrary
 *  persona blocks is accepted (the mechanism the Agent SDK's
 *  system-prompt-append uses). */
const OAUTH_SYSTEM_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

/** Calls `get`, giving undefined where it throws. */
function guarded<T>(get: () => T): T | undefined {
  try { return get(); } catch { return undefined; }
}

/** Truthy env-flag parse: unset/''/'0'/'false' (any case) are off. */
function envFlag(value: string | undefined, name = 'LLM_CALLS_FULL_PAYLOADS'): boolean {
  // Fail-closed allowlist, same posture as gate-telemetry's flag (#119):
  // only an explicit 1/true (trimmed, case-insensitive) enables full
  // payloads in the local ledger; 'off', 'no' and typos must not.
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true') return true;
  if (!['', '0', 'false', 'off', 'no'].includes(normalized)) {
    console.error(
      `[llm-calls] ${name}=${JSON.stringify(value)} is not a recognized value — ` +
        `treating as DISABLED (fail-closed). Use ${name}=1 (or true) to enable.`,
    );
  }
  return false;
}

/** A response the provider shaped inconsistently, as its llm-calls row names it. */
export interface ResponseAnomaly {
  kind: 'tool_use_with_stop_reason';
  /** The stop reason membrane acts on: the raw response's when it names
   *  one, otherwise membrane's normalized one, which defaults a missing
   *  reason to 'end_turn' on complete() and stream() alike. Null only when
   *  neither names one. */
  stopReason: string | null;
  /** The provider's own terminal reason, before any default was applied:
   *  null when the provider reported none (a defaulted `end_turn` then
   *  reads as stopReason 'end_turn', providerStopReason null, on both
   *  paths). Absent when the response doesn't say. */
  providerStopReason?: string | null;
  /** Names of the response's client tool_use blocks, in order. */
  toolNames: string[];
}

/**
 * Whether a provider response is anomalous. A client `tool_use` block under
 * any stop reason but 'tool_use' is one: the provider asked for no tool
 * round. That includes `max_tokens` and `refusal` (a call cut off
 * mid-input) as well as `end_turn`, `stop_sequence` and a missing reason,
 * since such a call is worth a replayable record whatever stopped it.
 * Membrane before membrane#168 runs tool rounds only on 'tool_use', so these
 * calls were lost; membrane with membrane#168 runs complete calls under
 * `end_turn` or no reason. This reads the provider's response as the adapter
 * returns it, before membrane decides. Server-side tool blocks
 * (`server_tool_use`) are not client calls and don't count. Reading never
 * throws.
 */
export function responseAnomaly(response: unknown): ResponseAnomaly | undefined {
  return guarded(() => {
    const r = response as {
      content?: unknown;
      stopReason?: unknown;
      providerStopReason?: unknown;
      raw?: { content?: unknown; stop_reason?: unknown } | null;
    } | null | undefined;
    if (!r || typeof r !== 'object') return undefined;
    const raw = r.raw && typeof r.raw === 'object' ? r.raw : undefined;
    const blocks = Array.isArray(raw?.content) ? raw!.content as unknown[]
      : Array.isArray(r.content) ? r.content as unknown[] : [];
    const toolNames = blocks
      .filter((b): b is { type: string; name?: unknown } =>
        !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_use')
      .map((b) => (typeof b.name === 'string' ? b.name : '?'));
    // The raw response's reason when it names one; otherwise membrane's
    // normalized one. complete()'s raw response is the API message, whose
    // stop_reason is null when the provider sent none, while stream()'s raw
    // carries membrane's defaulted 'end_turn': reading on to the normalized
    // reason gives both paths 'end_turn' for the same case.
    const rawStop = typeof raw?.stop_reason === 'string' ? raw.stop_reason : r.stopReason;
    const stopReason = typeof rawStop === 'string' ? rawStop : null;
    if (toolNames.length === 0 || stopReason === 'tool_use') return undefined;
    const anomaly: ResponseAnomaly = { kind: 'tool_use_with_stop_reason', stopReason, toolNames };
    if ('providerStopReason' in r) {
      anomaly.providerStopReason = typeof r.providerStopReason === 'string' ? r.providerStopReason : null;
    }
    return anomaly;
  });
}

/** The provider's message id and request id, where the response exposes
 *  them: membrane's raw response (the API message on complete(), whose
 *  request id the SDK attaches as `_request_id`), or fields a provider
 *  adapter adds (`request_id`, `requestId`). Each is a non-empty string or
 *  absent. Reading never throws. */
export function responseIds(response: unknown): { messageId?: string; requestId?: string } {
  const out: { messageId?: string; requestId?: string } = {};
  guarded(() => {
    const r = response as { raw?: Record<string, unknown> | null; requestId?: unknown } | null | undefined;
    const raw = r?.raw && typeof r.raw === 'object' ? r.raw : undefined;
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
    const messageId = str(raw?.id);
    const requestId = str(raw?.request_id) ?? str(raw?.requestId) ?? str(raw?._request_id) ?? str(r?.requestId);
    if (messageId) out.messageId = messageId;
    if (requestId) out.requestId = requestId;
  });
  return out;
}

/** The provider's request id a failed call's error carries, where it does:
 *  the error itself (`requestID`, `request_id`, `requestId`) or, for a
 *  membrane error, the provider SDK error it wraps (`rawError`), including
 *  its `request-id` response header. A non-empty string or undefined.
 *  Reading never throws. */
export function errorRequestId(error: unknown): string | undefined {
  return guarded(() => {
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
    const fromObject = (o: unknown): string | undefined => {
      if (!o || typeof o !== 'object') return undefined;
      const e = o as { requestID?: unknown; request_id?: unknown; requestId?: unknown; _request_id?: unknown; headers?: unknown };
      const direct = guarded(() => str(e.requestID) ?? str(e.request_id) ?? str(e.requestId) ?? str(e._request_id));
      if (direct) return direct;
      return guarded(() => {
        const h = e.headers as { get?: (name: string) => unknown } & Record<string, unknown> | null | undefined;
        if (!h || typeof h !== 'object') return undefined;
        return typeof h.get === 'function' ? str(h.get('request-id')) : str(h['request-id']);
      });
    };
    return fromObject(error) ?? fromObject((error as { rawError?: unknown } | null | undefined)?.rawError);
  });
}

/** What became of a row's write, as `log()` reports it: written, and which
 *  step of the size guard its line came from (logging-record.ts), or not
 *  written, and why. */
export type LogOutcome =
  | { written: true; kept: RecordKept; truncated?: string }
  | { written: false; error: string };

/** What the anomaly alert says of the row's request: kept only when the row
 *  that holds it was written whole. */
function requestFate(saved: LogOutcome | undefined, requestCaptured: boolean): string {
  if (!requestCaptured) return 'no request was captured for this call';
  if (!saved) return 'full request kept in this call\'s llm-calls row';
  if (!saved.written) return `request could not be saved: the llm-calls write failed (${saved.error})`;
  if (saved.kept === 'whole') return 'full request kept in this call\'s llm-calls row';
  return `request not kept: ${saved.truncated ?? saved.kept}`;
}

/** The one stderr line an anomalous call prints, timestamped so it can be
 *  placed in an append-mode log that stamps nothing itself. It names the
 *  provider's response this adapter received, says what membrane does with
 *  such calls, and says whether the request was saved (`saved`: the row's
 *  write outcome; `requestCaptured`: whether there was a request to save). */
export function anomalyLogLine(
  timestamp: string,
  kind: 'complete' | 'stream',
  model: unknown,
  anomaly: ResponseAnomaly,
  ids: { messageId?: string; requestId?: string },
  saved?: LogOutcome,
  requestCaptured = true,
): string {
  const provider = anomaly.providerStopReason === undefined ? ''
    : ` (provider: ${anomaly.providerStopReason ?? 'none'})`;
  const fate = anomaly.stopReason === 'end_turn' || anomaly.stopReason === null
    ? 'membrane with membrane#168 may have run these calls; earlier membrane drops them'
    : 'membrane runs no calls under this stop reason';
  return `[llm-calls] ${timestamp} ANOMALY tool_use with stop_reason=${anomaly.stopReason ?? 'none'}${provider}`
    + ` kind=${kind} model=${typeof model === 'string' ? model : '?'}`
    + ` tools=${anomaly.toolNames.join(',') || '-'}`
    + (ids.requestId ? ` request=${ids.requestId}` : '')
    + (ids.messageId ? ` message=${ids.messageId}` : '')
    + ` — provider response; ${fate} — ${requestFate(saved, requestCaptured)}`;
}

/** What the off-path refusal dragnet hears of one refused call. */
export interface OffPathRefusal {
  kind: 'complete';
  category?: string;
  model: string;
  messages: number;
  /** The whole prompt the call sent: uncached input, cache reads and cache writes. */
  inputTokens: number;
}

/**
 * The ops alert for an off-path refusal: its kind, its message, and its data.
 * The data names the call's kind `call`, since failures.log spreads the data
 * after the alert's own `kind`, which must stay 'refusal-offpath'.
 */
export function offPathRefusalAlert(info: OffPathRefusal): {
  kind: 'refusal-offpath';
  message: string;
  data: Record<string, unknown>;
} {
  const category = info.category ?? 'unknown';
  const size = `~${Math.round(info.inputTokens / 1000)}k tok`;
  const message = `off-path refusal (category=${category}) on a ${info.messages}-message complete() call ` +
    `(${size}) — likely compression/summarizer`;
  const { kind: call, ...rest } = info;
  return { kind: 'refusal-offpath', message, data: { call, ...rest } };
}

export class LoggingAnthropicAdapter extends AnthropicAdapter {
  private readonly logPath: string;
  private readonly getReasoning?: ReasoningGetter;
  private readonly onCall?: ProviderCallObserver;
  /** True when authenticated with an OAuth/Bearer token instead of an API
   *  key; requests then need the identity block prepended (see above). */
  private readonly oauthMode: boolean;
  /** LLM_CALLS_FULL_PAYLOADS=1: retain the full raw request on EVERY call,
   *  not just refusals/errors, within the 16 MiB a log line may take
   *  (logging-record.ts). Purpose: pass/refusal contrast corpora — a
   *  refusal's payload is only interpretable next to the passing payloads
   *  around it (classifier-forensics finding, 2026-07-27: verdicts are a
   *  near-deterministic function of the payload, so adjacent pairs isolate
   *  the differentiator). Costs disk, and at each write a string the size of
   *  the whole record, serialized before the cap applies (the raw request
   *  itself is already captured per-call for the summary); pair with
   *  llm-calls rotation. */
  private readonly fullPayloads: boolean = envFlag(process.env.LLM_CALLS_FULL_PAYLOADS);

  constructor(
    config: ConstructorParameters<typeof AnthropicAdapter>[0],
    logPath: string,
    getReasoning?: ReasoningGetter,
    onCall?: ProviderCallObserver,
  ) {
    // The background replay bypasses complete/stream by design. Observe its
    // terminal receipt instead of rebuilding or re-sending the cached payload.
    let observeKeepalive: ((call: KeepaliveCall) => void) | undefined;
    const callerOnCall = config?.cacheKeepalive?.onCall;
    super({
      ...config,
      cacheKeepalive: {
        ...config?.cacheKeepalive,
        onCall(call) {
          // Log before calling the caller's observer, which owns its copy and
          // may mutate it. Failure in either observer must not suppress the other.
          try { observeKeepalive?.(call); } catch { /* observability is isolated */ }
          // Membrane isolates sync errors and returned promise rejections. The
          // caller's observer runs with the `this` membrane gives this one, as
          // it did when membrane called it directly.
          return callerOnCall?.call(this, call);
        },
      },
    });
    observeKeepalive = (call) => this.logKeepaliveCall(call);
    this.logPath = logPath;
    this.getReasoning = getReasoning;
    this.onCall = onCall;
    this.oauthMode = Boolean(config?.authToken);
  }

  /** Under OAuth subscription auth, prepend the required identity block to the
   *  system prompt (converting a string system to blocks). No-op under API-key
   *  auth or when the identity block is already first. The block is plain
   *  (no cache_control) and a stable prefix, so caching is unaffected. */
  private withOAuthIdentity(request: ProviderRequest): ProviderRequest {
    if (!this.oauthMode) return request;
    const sys = request.system;
    const blocks: unknown[] =
      typeof sys === 'string' && sys.length > 0
        ? [{ type: 'text', text: sys }]
        : Array.isArray(sys) ? sys : [];
    const first = blocks[0] as { type?: string; text?: string } | undefined;
    if (first?.type === 'text' && first.text === OAUTH_SYSTEM_IDENTITY) return request;
    return {
      ...request,
      system: [{ type: 'text', text: OAUTH_SYSTEM_IDENTITY }, ...blocks],
    };
  }

  /** If reasoning is enabled, inject `thinking` into the request before the
   *  adapter builds the Anthropic payload. The Anthropic adapter forwards
   *  provider-specific params carried in `request.extra`, so that's the hook
   *  point. We return a shallow clone to avoid surprising callers. */
  private withReasoning(request: ProviderRequest): ProviderRequest {
    const r = this.getReasoning?.();
    if (!r || !r.enabled) return request;
    if (!modelAcceptsAdaptiveThinking(request.model)) {
      if (!this.warnedThinking.has(request.model)) {
        this.warnedThinking.add(request.model);
        console.error(
          `[reasoning] ${request.model} does not accept adaptive thinking — not sent ` +
            `(reasoning stays enabled for models that do).`,
        );
      }
      return request;
    }
    // Use ADAPTIVE thinking, not the legacy { type:'enabled', budget_tokens }
    // form. Current Anthropic models (opus-4-6/4-7/4-8, …) reject the legacy
    // form with: `"thinking.type.enabled" is not supported for this model.
    // Use "thinking.type.adaptive"`. Under adaptive the model sizes its own
    // thinking, so `budgetTokens` is no longer sent (it still shows in
    // agent_settings as an informational hint).
    //
    // membrane's `ProviderRequest` doesn't type a top-level `thinking` field
    // (membrane is 0.5.68 — agent-framework is the package that went 0.6.0;
    // the old `as … ProviderRequest['thinking']` cast only ever compiled via a
    // stale nested membrane copy that lockfile dedup removed). But the Anthropic
    // adapter applies `request.extra` to the API params verbatim
    // (`complete()`: `const { normalizedMessages, prompt, ...rest } =
    // request.extra; Object.assign(params, rest)`), so we route thinking
    // through the typed `extra` bag — no type assertion, and it survives the
    // next dependency reshuffle instead of hiding it from the compiler.
    //
    // `display`: models 4.7+ default to 'omitted' (empty `thinking` text,
    // signature only). We pass the setting through — default 'summarized' —
    // so reasoning summaries are visible again (stores, webui, estimators).
    return {
      ...request,
      extra: {
        ...request.extra,
        thinking: { type: 'adaptive', display: r.display ?? 'summarized' },
      },
    };
  }

  /** Apply the agent's reasoning_effort setting as `output_config.effort`.
   *  Called for stream() only: agent turns stream, while compression and
   *  maintenance calls go through complete() — a resident turning effort down
   *  for conversation must not silently thin the summaries its memory is made
   *  of. 'default'/unset sends nothing. Merges into any `output_config`
   *  already in `extra` (structured-output format) rather than replacing it. */
  private withEffort(request: ProviderRequest): ProviderRequest {
    const effort = this.getReasoning?.()?.effort;
    if (!effort || effort === 'default') return request;
    if (!modelAcceptsEffort(request.model, effort)) {
      const key = `${request.model}:${effort}`;
      if (!this.warnedEffort.has(key)) {
        this.warnedEffort.add(key);
        console.error(
          `[reasoning-effort] ${request.model} does not accept effort=${effort} — not sent ` +
            `(reasoning_effort stays set; the model default applies).`,
        );
      }
      return request;
    }
    const existing = (request.extra as { output_config?: Record<string, unknown> } | undefined)?.output_config;
    return {
      ...request,
      extra: {
        ...request.extra,
        output_config: { ...existing, effort },
      },
    };
  }

  private readonly warnedEffort = new Set<string>();
  private readonly warnedThinking = new Set<string>();

  /** Append the record's line; never throws. Says whether the line was
   *  written and, if it was, which step of the size guard it came from. */
  private log(record: Record<string, unknown>): LogOutcome {
    try {
      const { line, kept, truncated } = serializeRecordOutcome(record);
      appendFileSync(this.logPath, line);
      return truncated === undefined ? { written: true, kept } : { written: true, kept, truncated };
    } catch (err) {
      // never throw from logging
      const message = guarded(() => (err instanceof Error ? err.message : String(err)));
      return { written: false, error: typeof message === 'string' && message ? message.slice(0, 200) : 'unknown error' };
    }
  }

  /** One row per timer-driven send, including SDK retries, with terminal usage. */
  private logKeepaliveCall(call: KeepaliveCall): void {
    const raw = call.request;
    const cache = summarizeCacheControls(raw);
    const response = call.outcome === 'success' ? call.response : undefined;
    // A failed poke's error takes the shape complete and stream rows give
    // theirs: bounded text, with the classification a membrane error carries.
    const errorFields = call.outcome === 'error' ? describeErrorObject(call.error, true) : undefined;
    const effort = (raw.output_config as { effort?: unknown } | undefined)?.effort;
    const record: Record<string, unknown> = {
      type: call.outcome === 'success' ? 'call' : 'error',
      kind: 'keepalive',
      timestamp: new Date(call.startedAt + call.durationMs).toISOString(),
      durationMs: call.durationMs,
      keepalive: { key: call.key, lane: call.lane, startedAt: call.startedAt },
      requestSummary: {
        model: raw.model,
        maxTokens: raw.max_tokens,
        messages: Array.isArray(raw.messages) ? raw.messages.length : 0,
        tools: Array.isArray(raw.tools) ? raw.tools.length : 0,
        ...(typeof effort === 'string' ? { effort } : {}),
        cacheBreakpoints: cache.count,
        cacheTtls: cache.ttls,
        lineage: call.key,
      },
      // A poke replays its lineage's latest real request every refresh
      // interval, so a row keeps it only with full payloads on, failed and
      // refused pokes' rows included, where a turn's failed or refused row
      // keeps its own.
      rawRequest: this.fullPayloads ? raw : undefined,
      ...(response ? { rawResponse: response } : {}),
      ...errorFields,
    };
    this.log(record);
    // A poke spends the same credential as a turn, so the credential monitor
    // hears it too: an idle resident's rejected credential shows at its next
    // poke rather than at its next turn (membrane pokes an idle lineage for a
    // day after its last real request by default: cacheKeepalive.maxIdleHours),
    // and a poke that succeeds settles an auth alert as a turn would.
    try {
      if (call.outcome === 'error') this.onProviderError?.(call.error, 'keepalive');
      else this.onProviderSuccess?.('keepalive');
    } catch { /* observers never affect provider traffic */ }
    // Share the log decoder so live and rehydrated spend use identical vendor
    // fields (including cache-write buckets, geography, and service tier).
    // The ledger comes last, so a throwing ledger observer skips nothing here,
    // and the guard in the constructor's onCall keeps it from the caller's.
    const observed = parseLoggedCall(record);
    if (observed) this.onCall?.(observed);
  }

  /** The request's summary, each part read on its own: a part that can't be
   *  read is undefined, which the record leaves out, and costs only itself.
   *  Built once per call, for the record and the ledger's live row alike. */
  private requestSummary(request: ProviderRequest, rawRequest: unknown): Record<string, unknown> {
    const cache = rawRequest ? guarded(() => summarizeCacheControls(rawRequest)) : undefined;
    const effort = guarded(() => (rawRequest as { output_config?: { effort?: unknown } } | null | undefined)?.output_config?.effort);
    // membrane's key for the request's cache lineage (model, system and
    // tools), which the keepalive names a poke's lineage by: membrane records
    // the lineage from the same request it hands onRequest.
    const lineage = rawRequest && typeof rawRequest === 'object'
      ? guarded(() => cacheLineageKey(rawRequest as Record<string, unknown>))
      : undefined;
    return {
      model: guarded(() => request.model),
      maxTokens: guarded(() => request.maxTokens),
      messages: guarded(() => request.messages.length),
      tools: guarded(() => request.tools?.length ?? 0),
      ...(typeof effort === 'string' ? { effort } : {}),
      ...(cache ? { cacheBreakpoints: cache.count, cacheTtls: cache.ttls } : {}),
      ...(typeof lineage === 'string' ? { lineage } : {}),
    };
  }

  /**
   * Off-path refusal dragnet (observability M3). The main inference driver
   * instruments its own refusals (agent-framework noteRefusal), but that
   * covers ONLY streamed agent turns. Every other model call in the process
   * — compression/summarizer drains, maintenance — flows through this
   * adapter's complete() and previously refused in silence; the 2026-07-15
   * mythos cascade STARTED there and alerted nowhere. Fired ONLY for
   * kind==='complete' — agent turns stream, so this never double-reports a
   * refusal the main driver already escalated. A refused keepalive poke is
   * logged and fires nothing; a streamed turn the provider refuses is the
   * framework's to report, as every refused turn is.
   */
  onRefusal?: (info: OffPathRefusal) => void;

  /** Credential-monitor taps: every failed call (auth verdicts are what the
   *  monitor keys on) and every successful one (clears a standing auth
   *  alarm). Observers never affect provider traffic. */
  onProviderError?: (error: unknown, kind: 'complete' | 'stream' | 'keepalive') => void;
  onProviderSuccess?: (kind: 'complete' | 'stream' | 'keepalive') => void;

  /**
   * Tell the observers about one call. A call failed exactly when `outcome`
   * carries `error`, whatever its value: a rejection with undefined is a
   * failure, and so is an error whose text is empty. The ledger row's error
   * text is the record's own, bounded (`errorText`), and its model, message
   * count, cache summary and lineage are the record's request summary's
   * (`summary`), so a row restored from the record after a restart reads
   * the same. A part the summary couldn't read leaves the model empty or
   * the count 0, in both. Without a raw request it could read, the live row's cache
   * summary is unknown, and so is the restored row's, unless the raw request
   * the record keeps (a failure's, a refusal's, or any call's with full
   * payloads) can be summarized there: one that reads differently from how
   * it serializes (a toJSON, a throwing getter that isn't an own enumerable
   * property), which membrane's built request never does. The tokens, stop
   * reason and cache-write fields come from membrane's own response.
   */
  private observeCall(
    kind: 'complete' | 'stream',
    timestamp: string,
    durationMs: number,
    request: ProviderRequest,
    summary: Record<string, unknown>,
    outcome: { response: ProviderResponse } | { error: unknown },
    errorText: string | undefined,
  ): void {
    try {
      if ('error' in outcome) this.onProviderError?.(outcome.error, kind);
      else this.onProviderSuccess?.(kind);
    } catch { /* observers never affect provider traffic */ }
    const response = 'response' in outcome ? outcome.response : undefined;
    const raw0 = (response as { raw?: { stop_reason?: string; stop_details?: { category?: string } } } | undefined)?.raw;
    if (kind === 'complete' && raw0?.stop_reason === 'refusal' && this.onRefusal) {
      try {
        this.onRefusal({
          kind,
          category: raw0.stop_details?.category,
          model: request.model,
          messages: request.messages.length,
          // The whole prompt the call sent: most of a compression call's is
          // often read from cache.
          inputTokens: (response?.usage.inputTokens ?? 0) + (response?.usage.cacheReadTokens ?? 0)
            + (response?.usage.cacheCreationTokens ?? 0),
        });
      } catch { /* observers never affect provider traffic */ }
    }
    if (!this.onCall) return;
    const raw = (response as { raw?: Record<string, unknown> } | undefined)?.raw;
    const rawUsage = raw?.usage as Record<string, unknown> | undefined;
    const cacheCreation = rawUsage?.cache_creation as Record<string, unknown> | undefined;
    const finite = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    const text = (value: unknown): string | undefined =>
      typeof value === 'string' && value.length > 0 ? value : undefined;
    try {
      this.onCall({
        timestamp,
        kind,
        durationMs,
        // As the ledger's restore reads them from the record.
        model: typeof summary.model === 'string' ? summary.model : '',
        messages: typeof summary.messages === 'number' ? summary.messages : 0,
        inputTokens: response?.usage.inputTokens ?? 0,
        outputTokens: response?.usage.outputTokens ?? 0,
        cacheReadTokens: response?.usage.cacheReadTokens ?? 0,
        cacheWriteTokens: response?.usage.cacheCreationTokens ?? 0,
        cacheWrite5mTokens: finite(cacheCreation?.ephemeral_5m_input_tokens),
        cacheWrite1hTokens: finite(cacheCreation?.ephemeral_1h_input_tokens),
        cacheWriteBucketsAuthoritative: cacheCreation !== undefined,
        inferenceGeo: text(rawUsage?.inference_geo) ?? text(raw?.inference_geo),
        serviceTier: text(rawUsage?.service_tier) ?? text(raw?.service_tier),
        cacheBreakpoints: summary.cacheBreakpoints as number | undefined,
        cacheTtls: summary.cacheTtls as string[] | undefined,
        stopReason: response?.stopReason,
        error: errorText,
        lineage: text(summary.lineage),
      });
    } catch {
      // A dashboard observer is never allowed to affect provider traffic.
    }
  }

  /** The raw request a successful call's row keeps: every call's with full
   *  payloads on, otherwise a refusal's or an anomalous response's (see
   *  responseAnomaly), the calls someone will need to replay or report. */
  private retainedRawRequest(
    response: ProviderResponse,
    rawRequest: unknown,
    anomaly: ResponseAnomaly | undefined = responseAnomaly(response),
  ): unknown {
    if (this.fullPayloads) return rawRequest;
    const raw = (response as { raw?: { stop_reason?: string } }).raw;
    return raw?.stop_reason === 'refusal' || anomaly ? rawRequest : undefined;
  }

  /** Wrap options to capture the raw provider request via the membrane
   *  onRequest hook, then chain to any caller-supplied onRequest. */
  private captureRawRequest(
    options: ProviderRequestOptions | undefined,
    sink: { rawRequest: unknown },
  ): ProviderRequestOptions {
    const callerOnRequest = options?.onRequest;
    return {
      ...options,
      onRequest: (req: unknown) => {
        sink.rawRequest = req;
        try { callerOnRequest?.(req as never); } catch { /* never block on caller hook */ }
      },
    } as ProviderRequestOptions;
  }

  /**
   * Record one call's outcome and tell the observers. A call failed exactly
   * when `outcome` carries `error`, whatever its value. Nothing here can
   * replace the provider's response or its error. The error's fields and the
   * request's summary are each read once, part by part, for the record and
   * the ledger alike, so a part that can't be read costs only itself. A
   * record that can't be built even so (a response that can't be read) is
   * written minimal instead (`summaryUnavailable: true`), with its kind and
   * timing, so the call still has a record. The credential taps hear of the
   * call whatever became of its record.
   */
  private recordCall(
    kind: 'complete' | 'stream',
    request: ProviderRequest,
    t0: number,
    rawRequest: unknown,
    outcome: { response: ProviderResponse } | { error: unknown },
  ): void {
    try {
      const timestamp = new Date().toISOString();
      const durationMs = Date.now() - t0;
      // Read once, for the record and the ledger alike; reading never throws.
      const errorFields = 'error' in outcome ? describeErrorObject(outcome.error, true) : undefined;
      const summary = this.requestSummary(request, rawRequest);
      const head = { type: errorFields ? 'error' : 'call', kind, timestamp, durationMs };
      // Read once each; reading never throws.
      const anomaly = 'response' in outcome ? responseAnomaly(outcome.response) : undefined;
      const errorId = 'error' in outcome ? errorRequestId(outcome.error) : undefined;
      const ids = 'response' in outcome ? responseIds(outcome.response) : errorId ? { requestId: errorId } : {};
      let record: Record<string, unknown>;
      try {
        record = 'response' in outcome
          ? {
              ...head,
              ...ids,
              requestSummary: summary,
              rawRequest: this.retainedRawRequest(outcome.response, rawRequest, anomaly),
              rawResponse: (outcome.response as { raw?: unknown }).raw ?? null,
              ...(anomaly ? { anomaly } : {}),
            }
          : { ...head, ...ids, requestSummary: summary, rawRequest, ...errorFields };
      } catch {
        record = { ...head, ...ids, summaryUnavailable: true, ...errorFields };
      }
      const saved = this.log(record);
      if (anomaly) {
        try {
          const captured = rawRequest !== null && rawRequest !== undefined;
          console.error(anomalyLogLine(timestamp, kind, summary.model, anomaly, ids, saved, captured));
        } catch { /* never throw from logging */ }
      }
      try {
        const error = errorFields?.error;
        const errorText = error === undefined ? undefined
          : typeof error === 'string' ? error : (error as { message: string }).message;
        this.observeCall(kind, timestamp, durationMs, request, summary, outcome, errorText);
      } catch { /* observers never affect provider traffic */ }
    } catch {
      // Logging must never break inference, nor change what it returns or throws.
    }
  }

  override async complete(
    request: ProviderRequest,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    const t0 = Date.now();
    const effective = this.withOAuthIdentity(this.withReasoning(request));
    const sink: { rawRequest: unknown } = { rawRequest: null };
    const wrapped = this.captureRawRequest(options, sink);
    let response: ProviderResponse;
    try {
      response = await super.complete(effective, wrapped);
    } catch (err) {
      this.recordCall('complete', request, t0, sink.rawRequest, { error: err });
      throw err;
    }
    // Outside the try: a logging failure can't be taken for the provider's.
    this.recordCall('complete', request, t0, sink.rawRequest, { response });
    return response;
  }

  override async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    const t0 = Date.now();
    const effective = this.withOAuthIdentity(this.withEffort(this.withReasoning(request)));
    const sink: { rawRequest: unknown } = { rawRequest: null };
    const wrapped = this.captureRawRequest(options, sink);
    let response: ProviderResponse;
    try {
      response = await super.stream(effective, callbacks, wrapped);
    } catch (err) {
      this.recordCall('stream', request, t0, sink.rawRequest, { error: err });
      throw err;
    }
    // Outside the try: a logging failure can't be taken for the provider's.
    this.recordCall('stream', request, t0, sink.rawRequest, { response });
    return response;
  }
}
