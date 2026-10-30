// AnthropicAdapter wrapper that appends each LLM call's RAW request, RAW
// response, and any error to a JSONL log file. Successful calls keep a
// compact request summary; the full raw request is retained only for
// refusals, anomalous responses and errors, where forensic inspection
// matters (a keepalive poke's only with full payloads: see below).
//
// "Raw" means the actual Anthropic API payload (post-buildRequest,
// including `thinking`, tool definitions in Anthropic shape, etc.) and the
// raw provider response — not the membrane-normalized intermediate.
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
// a non-Error's text. The request summary leaves out only the parts it
// can't read; a record whose response can't be read keeps only the head
// fields (summaryUnavailable: true). A keepalive row also carries
// `keepalive: { key, lane, startedAt }`: the lineage it refreshed, its
// lane, and when its send began. It keeps the replayed request only with
// full payloads on, whatever its outcome. Every line, newline included,
// stays within the shared 16 MiB UTF-8 cap: an oversized or unserializable
// record drops its raw request first, its raw response only if the line
// still doesn't fit, then its summaries, and `truncated` says what was
// dropped. Every step keeps `anomaly`, `messageId` and `requestId`.
//
// A complete() or stream() row also carries, when the provider response (or
// a failed call's error) exposes them, `messageId` (the provider's message
// id) and `requestId` (the provider's request id, the handle a provider needs
// to look a call up), so a call can be reported upstream without its
// content. Only this adapter's complete() and stream() rows do: keepalive
// rows, the Bedrock adapter's and the generic wrapper's don't.
//
// An anomalous response keeps its full raw request too, and its row carries
// `anomaly` (see responseAnomaly) plus one timestamped stderr line that
// says whether the row with the request was written, so the call can be
// replayed and reported. Anomalous: a response holding a client `tool_use`
// block whose stop reason is anything but 'tool_use'. The row is the
// provider's response as this adapter received it: membrane runs a round's
// complete calls when the provider stopped it with a literal `end_turn`
// (membrane#168), and none under any other reason or none.

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
 *  model"). */
export function modelAcceptsAdaptiveThinking(model: string): boolean {
  return /claude-(fable|mythos)-|claude-opus-(4-[6-9]|[5-9])|claude-sonnet-(4-6|[5-9])|claude-haiku-5-5(?!\d|-\d{1,2}(?!\d))/.test(model);
}

/** Whether `model` returns the notes it writes between tool calls ("found X,
 *  checking Y next") as signed `thinking` blocks instead of `text`, and
 *  accepts `thinking.display: 'updates'` to get their text back: Fable 5 and
 *  5.1, Mythos 5.1, Opus 5.5 and Sonnet 5.5 (Anthropic's migration docs; on
 *  Opus 5.5 and Sonnet 5.5, notes longer than a sentence or two). Thinking
 *  can't be turned off on any of them, and under the default display
 *  ('omitted') those notes come back empty. A later model isn't assumed to
 *  accept 'updates': an unaccepted display is a 400 on every turn, the same
 *  fail-safe posture as modelAcceptsEffort. So the ID may go on with a dated
 *  snapshot (`-20260301`, `@20260301`) or a suffix such as the 1M-context
 *  marker ([1m]), but not with a version: a digit (`opus-5-50`) or a hyphen
 *  and one or two digits (`fable-5-2`, `fable-5-10`). */
export function modelReturnsNotesInThinking(model: string): boolean {
  return /claude-(fable-5(-1)?|mythos-5-1|opus-5-5|sonnet-5-5)(?!\d|-\d{1,2}(?!\d))/.test(model);
}

/** What a model does with its signed thinking (anima-research/context-manager#155). */
export interface ModelThinking {
  /** A reply's thinking is bound to the request it was minted in: in a later
   *  request whose earlier conversation or head (system text, tools, model)
   *  differs, an enforcing account refuses the block, and others drop it. */
  binds: boolean;
  /** It takes `block_binding: { prefix_mismatch_behavior: 'drop_block' }`,
   *  which has the provider drop such a block rather than refuse the request. */
  dropBlock: boolean;
  /** It thinks, minting signed thinking, when a request carries no thinking
   *  config. */
  thinksWithoutConfig: boolean;
  /** The provider's own refusal of a longer prompt showed its context window. */
  windowShownByRefusal?: true;
}

const BINDS_WITH_CONTROL: ModelThinking = { binds: true, dropBlock: true, thinksWithoutConfig: true, windowShownByRefusal: true };
const BINDS_WITHOUT_CONTROL: ModelThinking = { binds: true, dropBlock: false, thinksWithoutConfig: true };
const THINKS_UNBOUND: ModelThinking = { binds: false, dropBlock: false, thinksWithoutConfig: true };
const NEITHER: ModelThinking = { binds: false, dropBlock: false, thinksWithoutConfig: false };
const UNREACHED: ModelThinking = { binds: true, dropBlock: false, thinksWithoutConfig: false };

const MODEL_THINKING: ReadonlyArray<readonly [string, ModelThinking]> = [
  ['fable-5-1', BINDS_WITH_CONTROL],
  ['opus-5-5', BINDS_WITH_CONTROL],
  ['sonnet-5-5', BINDS_WITH_CONTROL],
  ['haiku-5-5', BINDS_WITH_CONTROL],
  // Membrane's changelog records the Mythos family refusing thinking configs
  // with a 400, so it isn't sent the control untried.
  ['mythos-5-1', BINDS_WITHOUT_CONTROL],
  ['mythos-5', BINDS_WITHOUT_CONTROL],
  ['mythos-preview', BINDS_WITHOUT_CONTROL],
  ['fable-5', THINKS_UNBOUND],
  ['opus-5', THINKS_UNBOUND],
  ['sonnet-5', THINKS_UNBOUND],
  ['opus-4-8', NEITHER],
  ['opus-4-7', NEITHER],
  ['opus-4-6', NEITHER],
  ['opus-4-5', NEITHER],
  ['sonnet-4-6', NEITHER],
  ['sonnet-4-5', NEITHER],
  ['haiku-4-5', NEITHER],
  ['opus-4-1', NEITHER],
  ['opus-4-0', NEITHER],
  ['opus-4', NEITHER],
  ['sonnet-4-0', NEITHER],
  ['sonnet-4', NEITHER],
];
const MODEL_THINKING_PATTERNS = MODEL_THINKING.map(
  ([name, facts]) => [new RegExp(`claude-${name}(?!\\d|-\\d{1,2}(?!\\d))`), facts] as const,
);

export function modelThinking(model: string): ModelThinking {
  const id = model.toLowerCase().replace(/(\d)\.(\d)/g, '$1-$2');
  if (!/(^|[/.:])claude-/.test(id)) return NEITHER;
  // Before Claude 4, Anthropic's ids named the version before the family
  // (claude-3-5-sonnet, claude-2-1, Bedrock's claude-v2), or were Instant.
  if (/(^|[/.:])claude-([1-3]|v[12]|instant)(?!\d)/.test(id)) return NEITHER;
  return MODEL_THINKING_PATTERNS.find(([pattern]) => pattern.test(id))?.[1] ?? UNREACHED;
}

/** What this process's account does with a signed thinking block whose
 *  earlier conversation changed, as the start-up probe found it
 *  (thinking-binding-probe.ts): refuses the request, drops the block on its
 *  own, or still shows it to the model. */
export type AccountBinding = 'refuses' | 'drops' | 'shows';

const accountBindings = new Map<string, AccountBinding>();

/** One key per row of the model record, so a dated snapshot, a routing prefix
 *  or a [1m] suffix reads what was found for its model; a Claude model the
 *  record doesn't list is its own key. */
export function accountBindingKey(model: string): string {
  const id = model.toLowerCase().replace(/(\d)\.(\d)/g, '$1-$2');
  const row = MODEL_THINKING_PATTERNS.findIndex(([pattern]) => pattern.test(id));
  return row >= 0 ? `row:${MODEL_THINKING[row]![0]}` : `id:${id.replace(/\[[^\]]*\]$/, '')}`;
}

export function recordAccountBinding(model: string, binding: AccountBinding): void {
  accountBindings.set(accountBindingKey(model), binding);
}

/** What the probe found for `model` on this account; undefined when it wasn't probed or couldn't tell. */
export function accountBinding(model: string): AccountBinding | undefined {
  return accountBindings.get(accountBindingKey(model));
}

/** For tests. */
export function clearAccountBindings(): void {
  accountBindings.clear();
}

/** The provider's refusal of a signed thinking block minted for a different conversation. */
export function isBindingRefusal(error: unknown): boolean {
  const e = error as { httpStatus?: number; status?: number; rawError?: { status?: number } } | null;
  const status = e?.httpStatus ?? e?.status ?? e?.rawError?.status;
  const message = String((error as { message?: unknown } | null)?.message ?? error);
  return status === 400 && /bound to a different conversation|invalid `?signature`? in `?thinking`? block/i.test(message);
}

/** Whether an agent on `model` leaves out thinking whose earlier conversation
 *  changed: its thinking binds, and the account wasn't found to show such a
 *  block anyway. */
export function leavesOutChangedThinking(model: string): boolean {
  return modelThinking(model).binds && accountBinding(model) !== 'shows';
}

const DROP_BLOCK = { prefix_mismatch_behavior: 'drop_block' } as const;
export type ProviderCallObserver = (record: ProviderCallRecord) => void;

/** Exact first-system-block identity Anthropic requires on subscription
 *  (sk-ant-oat…) OAuth traffic. Any other first block — including this text
 *  with a suffix appended in the SAME block — is rejected with a masked 429
 *  rate_limit_error; this block followed by arbitrary persona blocks is
 *  accepted (the mechanism the Agent SDK's system-prompt-append uses). */
const OAUTH_SYSTEM_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

function guarded<T>(get: () => T): T | undefined {
  try { return get(); } catch { return undefined; }
}

function envFlag(value: string | undefined, name = 'LLM_CALLS_FULL_PAYLOADS'): boolean {
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
 * Membrane runs a round's complete calls when the provider stopped it with
 * a literal `end_turn` (membrane#168). This reads the provider's response
 * as the adapter returns it, before membrane decides. Server-side tool
 * blocks (`server_tool_use`) are not client calls and don't count. Reading
 * never throws.
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

export type LogOutcome =
  | { written: true; kept: RecordKept; truncated?: string }
  | { written: false; error: string };

function requestFate(saved: LogOutcome | undefined, requestCaptured: boolean): string {
  if (!requestCaptured) return 'no request was captured for this call';
  if (!saved) return 'full request kept in this call\'s llm-calls row';
  if (!saved.written) return `request could not be saved: the llm-calls write failed (${saved.error})`;
  if (saved.kept === 'whole') return 'full request kept in this call\'s llm-calls row';
  return `request not kept: ${saved.truncated ?? saved.kept}`;
}

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

export interface OffPathRefusal {
  kind: 'complete';
  category?: string;
  model: string;
  messages: number;
  inputTokens: number;
}

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
  private readonly oauthMode: boolean;
  /** LLM_CALLS_FULL_PAYLOADS=1 (or true, in any case): retain the full raw
   *  request on EVERY call, not just refusals/errors, within the 16 MiB a log
   *  line may take. Costs disk. */
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
          try { observeKeepalive?.(call); } catch { }
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

  /** The Anthropic adapter forwards provider-specific params carried in
   *  `request.extra`. */
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
    // thinking, so `budgetTokens` is no longer sent.
    //
    // `display`: models 4.7+ default to 'omitted' (empty `thinking` text,
    // signature only).
    return {
      ...request,
      extra: {
        ...request.extra,
        thinking: { type: 'adaptive', display: r.display ?? 'summarized' },
      },
    };
  }

  /** Membrane applies request.extra after the config it builds, so the
   *  reasoning setting's config replaces that one whole, control included:
   *  this step runs after withReasoning. With no thinking config, a model that
   *  thinks anyway is sent an adaptive 'omitted' config to carry the control:
   *  membrane sends none there. Needs membrane >= 0.7.0, which adds the
   *  `thinking-binding-controls-2026-08-01` beta whenever the body carries
   *  the control. */
  private withBinding(request: ProviderRequest): ProviderRequest {
    const facts = modelThinking(request.model);
    // An account that shows such a block is asked to drop it by the control.
    if (!facts.binds || !facts.dropBlock || accountBinding(request.model) === 'shows') return request;
    const extraThinking = (request.extra as { thinking?: unknown } | undefined)?.thinking;
    const current = (extraThinking ?? request.thinking) as Record<string, unknown> | null | undefined;
    let thinking: Record<string, unknown>;
    if (current) {
      const type = current.type ?? 'enabled';
      if (type !== 'adaptive' && type !== 'enabled') return request;
      if (current.block_binding !== undefined && current.block_binding !== null) return request;
      thinking = { ...current, block_binding: DROP_BLOCK };
    } else {
      if (!facts.thinksWithoutConfig) return request;
      thinking = { type: 'adaptive', display: 'omitted', block_binding: DROP_BLOCK };
    }
    return { ...request, extra: { ...request.extra, thinking } };
  }

  /** Needs membrane >= 0.7.0, which adds the
   *  `thinking-display-updates-2026-08-18` beta whenever the body it sends asks
   *  for 'updates'; without the beta the API refuses the value. */
  private withProgressNotes(request: ProviderRequest): ProviderRequest {
    if (!modelReturnsNotesInThinking(request.model)) return request;
    const extraThinking = (request.extra as { thinking?: unknown } | undefined)?.thinking;
    const current = (extraThinking ?? request.thinking) as Record<string, unknown> | null | undefined;
    if (current) {
      const type = current.type ?? 'enabled';
      if (type !== 'adaptive' && type !== 'enabled') return request;
      if (current.display === 'summarized' || current.display === 'updates') return request;
    }
    return {
      ...request,
      extra: {
        ...request.extra,
        thinking: { ...(current ?? { type: 'adaptive' }), display: 'updates' },
      },
    };
  }

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

  private log(record: Record<string, unknown>): LogOutcome {
    try {
      const { line, kept, truncated } = serializeRecordOutcome(record);
      appendFileSync(this.logPath, line);
      return truncated === undefined ? { written: true, kept } : { written: true, kept, truncated };
    } catch (err) {
      const message = guarded(() => (err instanceof Error ? err.message : String(err)));
      return { written: false, error: typeof message === 'string' && message ? message.slice(0, 200) : 'unknown error' };
    }
  }

  /** One row per timer-driven send, including SDK retries, with terminal usage. */
  private logKeepaliveCall(call: KeepaliveCall): void {
    const raw = call.request;
    const cache = summarizeCacheControls(raw);
    const response = call.outcome === 'success' ? call.response : undefined;
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
      rawRequest: this.fullPayloads ? raw : undefined,
      ...(response ? { rawResponse: response } : {}),
      ...errorFields,
    };
    this.log(record);
    // membrane pokes an idle lineage for a day after its last real request by
    // default (cacheKeepalive.maxIdleHours).
    try {
      if (call.outcome === 'error') this.onProviderError?.(call.error, 'keepalive');
      else this.onProviderSuccess?.('keepalive');
    } catch { }
    const observed = parseLoggedCall(record);
    if (observed) this.onCall?.(observed);
  }

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
   * Agent turns stream, and agent-framework reports their refusals itself
   * (noteRefusal), so this fires only for complete().
   */
  onRefusal?: (info: OffPathRefusal) => void;

  onProviderError?: (error: unknown, kind: 'complete' | 'stream' | 'keepalive') => void;
  onProviderSuccess?: (kind: 'complete' | 'stream' | 'keepalive') => void;

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
    } catch { }
    const response = 'response' in outcome ? outcome.response : undefined;
    const raw0 = (response as { raw?: { stop_reason?: string; stop_details?: { category?: string } } } | undefined)?.raw;
    if (kind === 'complete' && raw0?.stop_reason === 'refusal' && this.onRefusal) {
      try {
        this.onRefusal({
          kind,
          category: raw0.stop_details?.category,
          model: request.model,
          messages: request.messages.length,
          inputTokens: (response?.usage.inputTokens ?? 0) + (response?.usage.cacheReadTokens ?? 0)
            + (response?.usage.cacheCreationTokens ?? 0),
        });
      } catch { }
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
    }
  }

  private retainedRawRequest(
    response: ProviderResponse,
    rawRequest: unknown,
    anomaly: ResponseAnomaly | undefined = responseAnomaly(response),
  ): unknown {
    if (this.fullPayloads) return rawRequest;
    const raw = (response as { raw?: { stop_reason?: string } }).raw;
    return raw?.stop_reason === 'refusal' || anomaly ? rawRequest : undefined;
  }

  private captureRawRequest(
    options: ProviderRequestOptions | undefined,
    sink: { rawRequest: unknown },
  ): ProviderRequestOptions {
    const callerOnRequest = options?.onRequest;
    return {
      ...options,
      onRequest: (req: unknown) => {
        sink.rawRequest = req;
        try { callerOnRequest?.(req as never); } catch { }
      },
    } as ProviderRequestOptions;
  }

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
      const errorFields = 'error' in outcome ? describeErrorObject(outcome.error, true) : undefined;
      const summary = this.requestSummary(request, rawRequest);
      const head = { type: errorFields ? 'error' : 'call', kind, timestamp, durationMs };
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
        } catch { }
      }
      try {
        const error = errorFields?.error;
        const errorText = error === undefined ? undefined
          : typeof error === 'string' ? error : (error as { message: string }).message;
        this.observeCall(kind, timestamp, durationMs, request, summary, outcome, errorText);
      } catch { }
    } catch {
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
    this.recordCall('complete', request, t0, sink.rawRequest, { response });
    return response;
  }

  override async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    const t0 = Date.now();
    // What the request was shaped by: a refusal is answered from this, not from
    // a verdict another agent's refusal changed while this one was out.
    const sentWithoutControl = accountBinding(request.model) === 'shows';
    const effective = this.withOAuthIdentity(this.withEffort(this.withProgressNotes(this.withBinding(this.withReasoning(request)))));
    const sink: { rawRequest: unknown } = { rawRequest: null };
    const wrapped = this.captureRawRequest(options, sink);
    let delivered = false;
    const watched: StreamCallbacks = sentWithoutControl
      ? {
          ...callbacks,
          onChunk: (chunk) => { delivered = true; callbacks.onChunk(chunk); },
          ...(callbacks.onContentBlock ? { onContentBlock: (i: number, b: unknown) => { delivered = true; callbacks.onContentBlock!(i, b); } } : {}),
          ...(callbacks.onThinkingSignature ? { onThinkingSignature: (i: number, s: string) => { delivered = true; callbacks.onThinkingSignature!(i, s); } } : {}),
        }
      : callbacks;
    let response: ProviderResponse;
    try {
      response = await super.stream(effective, watched, wrapped);
    } catch (err) {
      this.recordCall('stream', request, t0, sink.rawRequest, { error: err });
      // Sent again only when nothing of it reached the caller, as membrane's own retries.
      if (!sentWithoutControl || delivered || !isBindingRefusal(err)) throw err;
      // The account was found at start to show such a block, and this one
      // refused it: a gateway moved the agent to another account. From here on
      // the control goes with every request (a 'shows' verdict is kept only
      // for a model that takes it), so the provider drops such a block instead
      // of refusing; the refusal came before anything streamed, so the request
      // is sent again. A restart checks the account again.
      recordAccountBinding(request.model, 'refuses');
      console.error(
        `[thinking-binding] ${request.model}: a signed thinking block whose earlier conversation changed was refused, ` +
        'though the account was found at start to show such blocks; the drop control goes with every request from now on.',
      );
      return this.stream(request, callbacks, options);
    }
    this.recordCall('stream', request, t0, sink.rawRequest, { response });
    return response;
  }
}
