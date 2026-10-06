/**
 * WebUI wire protocol — JSON-over-WebSocket envelope for the web admin client.
 *
 * Both ends import these types so the messages stay in lockstep. The shape
 * deliberately mirrors the fleet IPC (`fleet-types.ts`) so a future external
 * aggregator can reuse the same parsers.
 *
 * Versioning: v1. Breaking changes bump `WEB_PROTOCOL_VERSION` and clients
 * refuse to connect on mismatch.
 *
 * v1 (2026-07): windowed history (welcome carries only a tail window plus
 * `history` metadata; older pages via request-history/history-page), ordered
 * `blocks` on message entries (thinking / tool_use / tool_result / media
 * surface in full), and `message-appended` live pushes of stored messages.
 */

import type { Line } from '../commands.js';
import type { LivenessSnapshot } from './liveness.js';

export const WEB_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

/**
 * Cold-start payload sent immediately after a client connects. Contains
 * everything needed to render a usable view without any further roundtrips.
 * Subsequent live updates arrive as `trace` / `child-event` / etc.
 */
export interface WelcomeMessage {
  type: 'welcome';
  protocolVersion: number;
  recipe: {
    name: string;
    description?: string;
    version?: string;
  };
  agents: Array<{ name: string; model: string }>;
  session: {
    id: string;
    name: string;
    autoNamed: boolean;
  };
  branch: {
    id: string;
    name: string;
  };
  /** Conversation history snapshot — the TAIL WINDOW only (see `history`).
   *  Clients fold live `trace` / `message-appended` events on top and page
   *  older messages via `request-history`. */
  messages: WelcomeMessageEntry[];
  /** Paging metadata for `messages`. `startIndex` is the store slot index of
   *  the first entry (== the number of older messages not shipped);
   *  `totalCount` is the store size at snapshot time. */
  history: {
    startIndex: number;
    totalCount: number;
  };
  /**
   * Parent-local agent tree snapshot. Shape matches AgentTreeSnapshot from
   * `state/agent-tree-reducer.ts` — kept structurally typed here to avoid
   * a cross-package import cycle and to let the client embed the same
   * reducer with no transitive dependency on framework internals.
   */
  localTree: {
    asOfTs: number;
    nodes: Array<Record<string, unknown>>;
    callIdIndex: Record<string, string>;
  };
  /**
   * Per-child snapshots when FleetModule + FleetTreeAggregator are mounted.
   * Each entry is a child name plus its current AgentTreeSnapshot. Empty
   * array when no fleet is configured.
   */
  childTrees: Array<{
    name: string;
    asOfTs: number;
    nodes: Array<Record<string, unknown>>;
    callIdIndex: Record<string, string>;
    /** Recipe summary for the child, parsed from its recipe file at fleet
     *  registration. Undefined when the recipe couldn't be loaded (e.g. URL
     *  recipe not yet fetched, or read error); SPA falls back to showing
     *  the child name only. */
    recipe?: {
      name: string;
      description?: string;
      version?: string;
      agentModel?: string;
    };
  }>;
  /**
   * Optional host capabilities the SPA feature-detects before showing an
   * affordance: 'rollback' | 'suppress' | 'quiesce' | 'media' |
   * 'operator-log'. Absent on older hosts (nothing shown).
   */
  features?: string[];
  /** Host serving state when the framework supports quiesce (see HostModeSnapshot). */
  hostMode?: HostModeSnapshot;
  /** Cumulative session-wide token usage at connect time. */
  usage: TokenUsage;
  /** Per-agent cost breakdown for the parent process, present when the
   *  framework's usage tracker has data. Empty during cold start. */
  perAgentCost?: PerAgentCost[];
  /** Recent provider calls with cache verdicts. Present when the host's
   *  provider adapter exposes the call ledger. */
  callLedger?: CallLedgerSnapshot;
  /** MCPL link + agent activity snapshot (see LivenessMessage). */
  liveness?: LivenessSnapshot;
}

/**
 * One content block of a stored message, in original order. This is the
 * viewer-facing projection of the membrane ContentBlock union: full
 * interiority (thinking, tool calls AND their results) survives, while
 * payloads are size-capped server-side (`truncated` flags) and media is
 * reduced to a type placeholder.
 */
export type MessageBlock =
  | { kind: 'text'; text: string; truncated?: boolean }
  | { kind: 'thinking'; text: string; truncated?: boolean }
  /** Provider-encrypted reasoning; only the payload size is surfaced. */
  | { kind: 'redacted_thinking'; bytes: number }
  | { kind: 'tool_use'; id: string; name: string; inputJson: string; truncated?: boolean }
  | { kind: 'tool_result'; toolUseId: string; text: string; isError?: boolean; truncated?: boolean }
  /** Image/document/audio/video or un-inflated blob_ref placeholder. `ref`
   *  is present for images the host can serve lazily at `/media/<ref>` —
   *  bytes never ride the WebSocket. */
  | { kind: 'media'; mediaType: string; ref?: string };

export interface WelcomeMessageEntry {
  /** Stable id from the message store; clients can use this for keys. */
  id?: string;
  /** Store slot index — the paging cursor. For a coalesced shard run this is
   *  the first shard's index. */
  index: number;
  participant: 'user' | 'assistant' | 'system' | 'tool';
  /** Ordered content blocks — the full internal life of the message. */
  blocks: MessageBlock[];
  /** Flattened text content (text blocks only), kept as a convenience and
   *  for degraded rendering by stale clients. */
  text: string;
  /** Epoch-millis timestamp if available. */
  timestamp?: number;
}

/** Verbatim framework TraceEvent. Clients typically pipe these into the
 *  same `AgentTreeReducer` the server uses. */
export interface TraceMessage {
  type: 'trace';
  /** TraceEvent shape — discriminated by inner `type` field. */
  event: { type: string; [k: string]: unknown };
}

/** Per-child WireEvent passthrough. Scoped by child name so the client
 *  can route into the right reducer. */
export interface ChildEventMessage {
  type: 'child-event';
  childName: string;
  event: { type: string; [k: string]: unknown };
}

/** Output from a slash command — mirrors CommandResult from commands.ts. */
export interface CommandResultMessage {
  type: 'command-result';
  /** Echo of the corrId from the originating client `command` message. */
  corrId?: string;
  lines: Line[];
  quit?: boolean;
  branchChanged?: boolean;
  switchToSessionId?: string;
  /** True when an asyncWork follow-up is incoming as a separate command-result. */
  pending?: boolean;
}

/** Periodic token-usage update; mirrors TUI's right-side meter. */
export interface UsageMessage {
  type: 'usage';
  usage: TokenUsage;
  perAgentCost?: PerAgentCost[];
}

/** Live replacement snapshot emitted after each provider call. */
export interface CallLedgerMessage {
  type: 'call-ledger';
  ledger: CallLedgerSnapshot;
}

export type CallLedgerVerdict =
  | 'HIT'
  | 'hit+extend'
  | 'uncached'
  | 'rewrite:expired'
  | 'rewrite:prefix-mutated'
  | 'rewrite:prefix-truncated'
  | 'rewrite:unexplained'
  | 'first-write'
  | 'ERROR'
  | 'empty'
  | 'unknown';

export interface CallLedgerRow {
  id: string;
  timestamp: string;
  kind: 'complete' | 'stream';
  /** Honest call-class estimate; `~` means the trigger plumbing did not
   *  provide a definitive origin. */
  originEstimate: 'turn~' | 'aux~';
  model: string;
  messages: number;
  durationMs: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cost?: CallCostBreakdown;
  cache: {
    /** Undefined for older compact logs that predate marker summaries. */
    breakpoints?: number;
    ttls: string[];
    effectiveTtl: '5m' | '1h';
  };
  verdict: CallLedgerVerdict;
  cause: string;
  stopReason?: string;
  error?: string;
}

export interface CallCostBreakdown {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  total: number;
  currency: 'USD';
  /** `billing` means every charged usage bucket and pricing modifier was
   *  known. Unknown/mixed buckets are left unpriced rather than estimated. */
  grade: 'billing';
  pricingVersion: string;
  rates: {
    inputPerMillion: number;
    outputPerMillion: number;
    cacheWrite5mPerMillion: number;
    cacheWrite1hPerMillion: number;
    cacheReadPerMillion: number;
  };
}

export interface CallLedgerSnapshot {
  /** Oldest to newest; clients may reverse for display. */
  rows: CallLedgerRow[];
  summary: {
    calls: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cacheHitRatio: number;
    cost?: {
      total: number;
      currency: 'USD';
      pricedCalls: number;
      unpricedCalls: number;
      pricingVersion: string;
    };
    byVerdict: Partial<Record<CallLedgerVerdict, number>>;
  };
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Estimated cost for this scope. Currency is provider-derived (USD for
   *  Anthropic). Optional because not every adapter / cached usage frame
   *  carries pricing data. */
  cost?: { total: number; currency: string };
}

/** `/quota` answer. `subscription: false` = pay-per-token host: keep showing
 *  dollars and stop polling. Windows are provider-neutral, longest first. */
export interface QuotaSnapshotData {
  subscription: boolean;
  provider?: string;
  windows: Array<{
    key: string;
    label: string;
    /** Percent used, 0–100. */
    utilization: number;
    /** Epoch ms. */
    resetsAt?: number;
    model?: string;
    advisory?: boolean;
  }>;
  fetchedAt?: number;
  error?: string;
  /** Epoch ms at which the last spent window resets, else null. A spent
   *  window is not by itself a parked agent — see `parked`. */
  blockedUntil?: number | null;
  /** The framework is holding an agent on the host's quota verdict. null when
   *  the framework predates the hook and cannot say. */
  parked?: boolean | null;
}

/** Per-agent cost slice used by the WebUI usage panel to label rows. Only
 *  surfaces parent-process agents — fleet-child agents track their own
 *  usage in their own UsageTracker and aren't aggregated cross-process. */
export interface PerAgentCost {
  name: string;
  cost: { total: number; currency: string };
  inferenceCount: number;
}

/** Sent when the active branch changes (undo/redo/checkout). Clients should
 *  re-fetch their conversation by reconnecting or treating subsequent traces
 *  as authoritative. */
export interface BranchChangedMessage {
  type: 'branch-changed';
  branch: { id: string; name: string };
}

/** One Chronicle branch with its lineage. `parentId`/`branchPoint` are
 *  undefined for the root branch; together they place the fork in the
 *  parent's sequence so the SPA can render a lineage tree. */
export interface BranchRow {
  id: string;
  name: string;
  /** Head sequence number of the branch. */
  head: number;
  parentId?: string;
  /** Sequence in the PARENT at which this branch forked. */
  branchPoint?: number;
  /** Epoch millis creation time. */
  created: number;
}

/** Full branch listing with lineage — response to `request-branches`, routed
 *  only to the requesting client. The SPA refreshes it after every
 *  `branch-changed` while its branch panel is open. */
export interface BranchesListMessage {
  type: 'branches-list';
  branches: BranchRow[];
  /** id of the branch the agent is currently on. */
  currentId: string;
}

/** Sent when the active session changes. Clients should soft-reconnect. */
export interface SessionChangedMessage {
  type: 'session-changed';
  session: { id: string; name: string };
}

/** Live peek stream for one subagent (Phase 5). Multiplexed by `scope`. */
export interface PeekMessage {
  type: 'peek';
  scope: string;
  event: { type: string; [k: string]: unknown };
}

/** Lesson library snapshot — response to RequestLessonsMessage. Empty array
 *  when LessonsModule isn't loaded, with `loaded: false` so the SPA can
 *  surface a "module not loaded" hint rather than appearing broken. */
export interface LessonsListMessage {
  type: 'lessons-list';
  /** Which process this snapshot describes: 'local' or a fleet-child name.
   *  Lets the SPA drop stale replies after a scope switch instead of
   *  rendering child A's data under child B's header. */
  scope?: string;
  loaded: boolean;
  lessons: Array<{
    id: string;
    content: string;
    confidence: number;
    tags: string[];
    deprecated: boolean;
    deprecationReason?: string;
    created?: number;
    updated?: number;
  }>;
}

/** Workspace mount summary — response to request-workspace-mounts. */
export interface WorkspaceMountsMessage {
  type: 'workspace-mounts';
  /** Process this snapshot describes ('local' or fleet-child name). */
  scope?: string;
  /** True iff WorkspaceModule is loaded in the recipe. */
  loaded: boolean;
  mounts: Array<{
    name: string;
    /** Filesystem path the mount maps to. */
    path: string;
    /** 'read-only' | 'read-write' (or any other future mode). */
    mode: string;
  }>;
}

/** Recursive file listing for one mount — response to request-workspace-tree. */
export interface WorkspaceTreeMessage {
  type: 'workspace-tree';
  /** Process this listing came from ('local' or fleet-child name). */
  scope?: string;
  mount: string;
  entries: Array<{ path: string; size: number }>;
}

/** File content — response to request-workspace-file. Content is
 *  line-numbered (cat -n style) as returned by the workspace `read` tool. */
export interface WorkspaceFileMessage {
  type: 'workspace-file';
  /** Process this file came from ('local' or fleet-child name). */
  scope?: string;
  path: string;
  totalLines: number;
  fromLine: number;
  toLine: number;
  content: string;
  /** True if the response was capped at the line limit; the SPA can warn
   *  that the file is larger than what's shown. */
  truncated: boolean;
}

/** MCPL server config snapshot — response to request-mcpl, mcpl-add, etc.
 *  Sent only to the requesting client; mutations don't broadcast since
 *  changes are file-only and require restart anyway. */
export interface McplListMessage {
  type: 'mcpl-list';
  /** Process whose MCPL view this is ('local' or fleet-child name). The
   *  registry FILE is shared cwd-wide, but which entries a process actually
   *  loads is per-recipe — see `live`. */
  scope?: string;
  /** Path to the config file (informational — operator may want to grep
   *  for it locally). */
  configPath: string;
  servers: Array<{
    id: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    toolPrefix?: string;
    reconnect?: boolean;
    enabledFeatureSets?: string[];
    disabledFeatureSets?: string[];
  }>;
  /** Servers the scoped process actually LOADED (recipe opt-in + agent
   *  overlay), with live connection status from its framework. Absent on
   *  older hosts. This is the per-scope truth the file registry can't give:
   *  a conductor with zero MCPLs and a clerk with five share one file. */
  live?: Array<{
    id: string;
    connected: boolean;
    toolCount: number;
    toolPrefix?: string;
    /** command or url — whatever the transport targets. */
    target?: string;
  }>;
}

/**
 * Protected ranges (pins / documents) for one agent.
 *
 * BROADCAST on change: pins alter what the next compile folds, so two operators
 * must not hold divergent views of them.
 */
export interface PinsListMessage {
  type: 'pins-list';
  /** Process these pins live in ('local' or fleet-child name). */
  scope?: string;
  agent: string;
  pins: Array<{
    id: string;
    firstMessageId: string;
    lastMessageId: string;
    kind: 'pin' | 'document';
    name?: string;
    created: number;
    /** Pinned AT exactly this fold level (0 = raw). */
    level?: number;
    /** Hard cap on fold depth. */
    maxLevel?: number;
  }>;
  /** False when the active strategy has no pin support — panel goes read-only. */
  pinsSupported: boolean;
  /** False when `level` would silently degrade to raw (non-kv-stable folding). */
  levelHonored: boolean;
  /** Deepest fold level currently present, so the UI can bound level inputs. */
  deepestLevel?: number;
  /** Recent pinnable messages (REAL store ids) from the scoped process.
   *  Shipped for fleet-child scopes, where the SPA has no message window of
   *  its own to build a picker from; local scope keeps using the client-side
   *  candidate list. */
  candidates?: Array<{ id: string; index: number; participant: string; text: string }>;
}

/**
 * Runtime context-settings snapshot.
 *
 * BROADCAST to every welcomed client on change — unlike `mcpl-list`, these are
 * live process state, not a config file, so two operators must not see
 * divergent values.
 */
export interface SettingsStateMessage {
  type: 'settings-state';
  /** Process these settings belong to ('local' or fleet-child name). */
  scope?: string;
  agent: string;
  /** Live values. `transition` is 'converging' while a paced descent runs. */
  settings: {
    contextBudgetTokens: number;
    tailTokens?: number;
    transitionPaceTokens?: number;
    sameRoundThinkTextPolicy?: string;
    sameRoundThinkTextPolicySource?: string;
    transition: 'stable' | 'converging' | 'blocked';
    /** Why a descent is stuck: pace below floor, or protected context too big. */
    transitionReason?: string;
  };
  /** Keys currently overridden away from the recipe (i.e. persisted). */
  overrides: string[];
  /** Which keys this build can apply live. Everything else needs a restart —
   *  the UI must show that split rather than implying all knobs are hot. */
  hotKeys: string[];
  /** False when the strategy is not hot-configurable at all (e.g. passthrough):
   *  the panel should go read-only rather than offer controls that will throw. */
  hotConfigurable: boolean;
  /** True when this build's context-manager exposes dry-run preview. Older
   *  context-manager versions resolve without it, and the panel must say
   *  "preview unavailable" rather than silently showing nothing. */
  previewAvailable: boolean;
}

/** A page of older history — response to `request-history`, routed only to
 *  the requesting client and correlated by `corrId`. */
export interface HistoryPageMessage {
  type: 'history-page';
  corrId: string;
  /** Entries in store order (oldest first), ending just before the
   *  requested `beforeIndex`. */
  entries: WelcomeMessageEntry[];
  /** Slot index of the first entry — the next page's `beforeIndex`. */
  startIndex: number;
  /** Store size at read time. */
  totalCount: number;
}

/** A message was appended to the store (any participant — including
 *  assistant turns and tool results, which never surface as trace
 *  `message:added` events). Clients dedupe by `entry.id` against messages
 *  they already rendered optimistically or via streaming. */
export interface MessageAppendedMessage {
  type: 'message-appended';
  entry: WelcomeMessageEntry;
}

/** Server-side error response. Non-fatal; the client stays connected. */
export interface ErrorMessage {
  type: 'error';
  /** corrId echo if the error was triggered by a specific request. */
  corrId?: string;
  message: string;
}

/**
 * /quit was issued while one or more fleet children are still running.
 * The server holds the shutdown until the operator confirms what to do
 * with them. Mirrors the TUI's three-way prompt — kill/cancel/detach.
 */
export interface QuitConfirmRequiredMessage {
  type: 'quit-confirm-required';
  /** Names of fleet children currently in 'ready' or 'starting' state. */
  children: string[];
}

/**
 * An external message just landed in the agent's context — e.g. an MCPL push
 * (zulip notification, etc.) or channel incoming. The TUI quietly switches to
 * "thinking" when this happens; the WebUI surfaces it as a labeled box so the
 * operator can see *why* the agent is suddenly active.
 *
 * Not emitted for inputs typed in the WebUI itself (those are already
 * optimistically rendered as a user message).
 */
export interface InboundTriggerMessage {
  type: 'inbound-trigger';
  /** Trace-event source field — e.g. 'mcpl:channel-incoming', 'mcpl:push-event'. */
  source: string;
  /** Human-readable origin label like 'zulip#general' or 'discord/myserver'. */
  origin: string;
  /** Did this message wake the agent up? When false the message landed but
   *  the gate filtered it out (no inference triggered). */
  triggered: boolean;
  /** Author display name where applicable. */
  author?: string;
  /** Brief text excerpt — capped server-side to keep the wire frame small. */
  text: string;
  /** Server time when the message was added. */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Live operator surgery (rollback / suppress), host quiesce, operator log.
// ---------------------------------------------------------------------------

/** Host serving state, projected from the framework's host-mode status. */
export interface HostModeSnapshot {
  /** 'serving' | 'quiescing' | 'quiesced' — or whatever the framework reports. */
  mode: string;
  /** Epoch millis when the current mode was entered, if known. */
  since?: number;
  /** Operator-supplied reason for a quiesce, if any. */
  reason?: string;
  /** Turns still draining while quiescing, if reported. */
  activeTurns?: number;
  /** Everything else the framework reported, for the detail tooltip. */
  detail?: Record<string, unknown>;
}

export interface HostModeMessage {
  type: 'host-mode';
  corrId?: string;
  hostMode: HostModeSnapshot;
}

/** Outcome of a `rollback` / `suppress` request. On success the server also
 *  broadcasts `branch-changed` and re-welcomes every client with the new
 *  branch's messages. */
export interface SurgeryResultMessage {
  type: 'surgery-result';
  corrId?: string;
  op: 'rollback' | 'suppress';
  ok: boolean;
  error?: string;
  /** Framework refusal code when `ok` is false: 'agent-busy' means quiesce
   *  (or wait for idle) and retry; others are input problems. */
  code?: string;
  agent?: string;
  sourceBranch?: string;
  targetBranch?: string;
  messagesRemoved?: number;
  lastVisible?: { participant?: string; role?: string; preview?: string } | null;
}

/** One durable operator-log record (mirrors the framework's OperatorLogEntry). */
export interface OperatorLogEntryWire {
  at: string;
  kind: string;
  agent?: string;
  requester?: { via: string; name?: string; id?: string };
  note?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
}

export interface OperatorLogMessage {
  type: 'operator-log';
  corrId?: string;
  entries: OperatorLogEntryWire[];
  /** Where the host writes the log, when enabled. */
  path?: string;
}

/** MCPL connection state + last inbound / last agent activity times.
 *  Broadcast (throttled) on change and every ~30s as a heartbeat, so a
 *  snapshot whose `at` stops advancing means the host itself went quiet. */
export interface LivenessMessage {
  type: 'liveness';
  liveness: LivenessSnapshot;
}

export type WebUiServerMessage =
  | WelcomeMessage
  | LivenessMessage
  | TraceMessage
  | ChildEventMessage
  | CommandResultMessage
  | UsageMessage
  | CallLedgerMessage
  | BranchChangedMessage
  | BranchesListMessage
  | SessionChangedMessage
  | PeekMessage
  | InboundTriggerMessage
  | QuitConfirmRequiredMessage
  | LessonsListMessage
  | McplListMessage
  | SettingsStateMessage
  | PinsListMessage
  | WorkspaceMountsMessage
  | WorkspaceTreeMessage
  | WorkspaceFileMessage
  | HistoryPageMessage
  | MessageAppendedMessage
  | ObserverAuthRequiredMessage
  | ObserverAckMessage
  | HostModeMessage
  | SurgeryResultMessage
  | OperatorLogMessage
  | ErrorMessage;

// ---------------------------------------------------------------------------
// Observer identity (docs/observability.md M2) — additive to protocol v1.
// Basic-auth clients never see these frames; key-authenticated observers
// authenticate in-band over the WS before any data flows.
// ---------------------------------------------------------------------------

/** Sent to a connection that upgraded without basic auth (allowed only when
 *  observer grants exist): the client must reply with observer-hello before
 *  anything else is sent. `host` is what the server will verify the signed
 *  statement against — the Host header of the upgrade request. */
export interface ObserverAuthRequiredMessage {
  type: 'observer-auth-required';
  host: string;
}

/** Successful observer authentication. `sessionToken` is a short-lived
 *  bearer for HTTP routes (set as the `fkm_obs` cookie by the SPA);
 *  `scopes` is the grant's mask — the SPA adapts its UI to it. */
export interface ObserverAckMessage {
  type: 'observer-ack';
  scopes: string[];
  sessionToken: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

/** Plain user message; equivalent to typing in the TUI. Triggers inference. */
export interface UserMessageMessage {
  type: 'user-message';
  content: string;
}

/** Slash command. Server runs `handleCommand()` and replies with a
 *  `command-result` carrying the same `corrId`. */
export interface CommandMessage {
  type: 'command';
  command: string;
  corrId?: string;
}

/** @childname routing for fleet children; bypasses the conductor agent. */
export interface RouteToChildMessage {
  type: 'route-to-child';
  childName: string;
  content: string;
}

/** Cancel any in-flight inference (Esc parity in the TUI). */
export interface InterruptMessage {
  type: 'interrupt';
}

/** Cancel one specific in-process subagent by display name. If `childName`
 *  is set, the cancel is forwarded to that fleet child's headless runtime;
 *  otherwise the conductor's local SubagentModule is used. Required for
 *  subagents that live inside a fleet child (e.g. Clerk-spawned subagents) —
 *  the conductor typically has no SubagentModule loaded, so a non-routed
 *  cancel would hit "subagent module not loaded". */
export interface CancelSubagentMessage {
  type: 'cancel-subagent';
  name: string;
  childName?: string;
}

/** Stop a fleet child gracefully. */
export interface FleetStopMessage {
  type: 'fleet-stop';
  name: string;
}

/** Restart a fleet child. */
export interface FleetRestartMessage {
  type: 'fleet-restart';
  name: string;
}

/** Open or close a peek window for a specific subagent or fleet child. */
export interface SubscribePeekMessage {
  type: 'subscribe-peek';
  scope: string;
  /** True to open, false to close. */
  active: boolean;
}

/** Keepalive. Server replies with nothing; the round-trip is the proof. */
export interface PingMessage {
  type: 'ping';
}

/**
 * Operator's response to a quit-confirm-required prompt. The action mirrors
 * the TUI's [Y/n/d] choices: kill the children gracefully and exit, leave
 * them running and exit anyway, or cancel quit altogether.
 */
export interface QuitConfirmMessage {
  type: 'quit-confirm';
  action: 'kill-children' | 'detach' | 'cancel';
}

/** Pull a lesson library — defaults to the parent process; pass a fleet
 *  child name in `scope` to query that child instead. The response is a
 *  `lessons-list` envelope routed only to the requesting client (children
 *  don't broadcast). */
export interface RequestLessonsMessage {
  type: 'request-lessons';
  /** Fleet child name, or 'local'/undefined for the parent process. */
  scope?: string;
}

/** Pull the MCPL server view: the shared file registry plus the scoped
 *  process's LIVE loaded servers. Response is an `mcpl-list` envelope.
 *  Recipe-defined servers appear only in `live` — their definitions live in
 *  the recipe file and aren't editable from here. */
export interface RequestMcplMessage {
  type: 'request-mcpl';
  /** Fleet child name, or 'local'/undefined for the parent process. */
  scope?: string;
}

/** Pull the Chronicle branch listing. Response is a `branches-list` envelope
 *  routed only to the requesting client. Read-only; switching branches goes
 *  through the `/checkout` command (full-auth clients only). */
export interface RequestBranchesMessage {
  type: 'request-branches';
}

/** Add or overwrite an MCPL server entry in mcpl-servers.json. Restart is
 *  required for the host to pick up the change; the response is a fresh
 *  `mcpl-list` so the SPA reflects the new state. */
export interface McplAddMessage {
  type: 'mcpl-add';
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  toolPrefix?: string;
}

export interface McplRemoveMessage {
  type: 'mcpl-remove';
  id: string;
}

export interface McplSetEnvMessage {
  type: 'mcpl-set-env';
  id: string;
  /** Replaces the existing env block in full. Empty object clears it. */
  env: Record<string, string>;
}

/** Pull the agent's protected ranges. Response is a `pins-list` envelope.
 *  With a fleet-child `scope` the child also ships picker `candidates`
 *  (recent real store ids) since the SPA has no window into its store. */
export interface RequestPinsMessage {
  type: 'request-pins';
  /** Fleet child name, or 'local'/undefined for the parent process. */
  scope?: string;
  agent?: string;
}

/**
 * Create a protected range.
 *
 * Three distinct semantics, deliberately not collapsed into one "pin":
 *  - neither `level` nor `maxLevel` → classic pin: forced RAW, never folded
 *  - `maxLevel: k` → fold no deeper than L_k (`0` is equivalent to a classic pin)
 *  - `level: k`    → pin AT exactly L_k; the frontier cut passes through that
 *                    node, neither deeper nor shallower
 *
 * `kind: 'document'` marks a single message as a document instead of pinning a
 * range, and ignores `lastMessageId`.
 *
 * NOTE: `level` is honored only by `foldingStrategy: 'kv-stable'`. Other
 * strategies degrade it to raw — a safe superset, but not what was asked for.
 * `pins-list.levelHonored` reports which case the live agent is in.
 */
export interface PinAddMessage {
  type: 'pin-add';
  /** Fleet child name, or 'local'/undefined for the parent process. */
  scope?: string;
  agent?: string;
  kind?: 'pin' | 'document';
  firstMessageId: string;
  /** Ignored for `kind: 'document'`; defaults to `firstMessageId` for a pin. */
  lastMessageId?: string;
  level?: number;
  maxLevel?: number;
  name?: string;
}

export interface PinRemoveMessage {
  type: 'pin-remove';
  /** Fleet child name, or 'local'/undefined for the parent process. */
  scope?: string;
  agent?: string;
  pinId: string;
}

/** Pull the current runtime context settings for an agent, plus which knobs are
 *  live-appliable vs restart-only. Response is a `settings-state` envelope. */
export interface RequestSettingsMessage {
  type: 'request-settings';
  /** Fleet child name, or 'local'/undefined for the parent process. */
  scope?: string;
  /** Agent name; defaults to the scoped process's primary agent. */
  agent?: string;
}

/**
 * Apply runtime context settings live.
 *
 * Semantics that the UI must not misrepresent:
 *  - RAISING contextBudgetTokens applies immediately.
 *  - LOWERING it starts a PACED convergence (`transition: 'converging'`)
 *    rather than folding everything at once; it can be cancelled.
 *  - Only these keys are hot. Chunk size, head window, merge threshold and
 *    friends are recipe-and-restart only.
 *
 * `persist: false` makes the change ephemeral — live now, gone on restart —
 * which is the mode for operator experiments. Default persists.
 *
 * `notify: true` pushes a notice into the agent's context. OFF by default and
 * deliberately so: the notice is new text in the very context being tuned, so
 * it invalidates the KV prefix and can itself trip a refusal classifier. The
 * agent can always PULL current settings via its own `agent_settings` tool.
 */
export interface SettingsUpdateMessage {
  type: 'settings-update';
  /** Fleet child name, or 'local'/undefined for the parent process. */
  scope?: string;
  agent?: string;
  contextBudgetTokens?: number;
  tailTokens?: number;
  transitionPaceTokens?: number;
  /** Apply a budget DECREASE immediately (one-shot fold-down, KV
   *  invalidation paid this turn) instead of starting a paced descent.
   *  The emergency lever for refusal streaks / over-wall wedges. */
  immediate?: boolean;
  persist?: boolean;
  notify?: boolean;
}

/** Revert named settings to their recipe values (all four when omitted). */
export interface SettingsResetMessage {
  type: 'settings-reset';
  /** Fleet child name, or 'local'/undefined for the parent process. */
  scope?: string;
  agent?: string;
  keys?: string[];
  persist?: boolean;
  notify?: boolean;
}

/** Abandon an in-flight paced descent, holding the current frontier. */
export interface SettingsCancelTransitionMessage {
  type: 'settings-cancel-transition';
  /** Fleet child name, or 'local'/undefined for the parent process. */
  scope?: string;
  agent?: string;
  persist?: boolean;
}

/** Pull the list of workspace mounts. Response is `workspace-mounts`.
 *  Optional `scope` selects a fleet child instead of the parent. */
export interface RequestWorkspaceMountsMessage {
  type: 'request-workspace-mounts';
  scope?: string;
}

/** Pull a recursive flat listing of files in one mount. Response is
 *  `workspace-tree`. The flat shape mirrors what WorkspaceModule's `ls`
 *  tool returns; the SPA folds it into a hierarchy locally. */
export interface RequestWorkspaceTreeMessage {
  type: 'request-workspace-tree';
  mount: string;
  scope?: string;
}

/** Read a workspace file, capped to N lines so the wire frame stays small.
 *  Response is `workspace-file`. */
export interface RequestWorkspaceFileMessage {
  type: 'request-workspace-file';
  /** Mount-prefixed path (e.g. "tickets/2026-05-06-foo.md"). */
  path: string;
  scope?: string;
}

/** Page older conversation history. Response is a `history-page` with the
 *  same `corrId` (or an `error`). Entries returned end just before
 *  `beforeIndex`; pass the previous page's `startIndex` to keep walking
 *  backward. */
export interface RequestHistoryMessage {
  type: 'request-history';
  corrId: string;
  /** Fetch messages strictly before this store slot index. */
  beforeIndex: number;
  /** Page size; server clamps to its maximum (500). */
  limit?: number;
}

/** In-band observer authentication (docs/observability.md §3): the client
 *  signs `connectome-observer|v1|<host>|<timestamp>` with its ed25519 key.
 *  Challenge-less — the Host binding + freshness window replace a nonce. */
export interface ObserverHelloMessage {
  type: 'observer-hello';
  identity: {
    scheme: 'ed25519';
    /** `ed25519:<base64url raw 32-byte public key>` */
    id: string;
    /** base64url signature over the bound statement. */
    proof: string;
    /** ISO timestamp used in the statement (±5 min freshness). */
    timestamp: string;
    displayName?: string;
  };
}

/** Roll the live branch back so `messageId` (a store id from a wire entry)
 *  becomes its tail. Forks first; the source branch keeps everything. */
export interface RollbackMessage {
  type: 'rollback';
  messageId: string;
  /** Agent name; defaults to the recipe's primary agent. */
  agent?: string;
  /** Free-text reason, recorded in the operator log. */
  note?: string;
  corrId?: string;
}

/** Suppress specific messages from the live context: fork at head, redact
 *  them on the fork, switch to it. */
export interface SuppressMessage {
  type: 'suppress';
  messageIds: string[];
  agent?: string;
  note?: string;
  corrId?: string;
}

/** Pause serving (drain turns, hold wakes, keep maintenance hot). */
export interface HostQuiesceMessage {
  type: 'host-quiesce';
  reason?: string;
  corrId?: string;
}

/** Resume serving after a quiesce. */
export interface HostResumeMessage {
  type: 'host-resume';
  corrId?: string;
}

export interface RequestHostModeMessage {
  type: 'request-host-mode';
  corrId?: string;
}

export interface RequestOperatorLogMessage {
  type: 'request-operator-log';
  /** Newest N entries (default 100, max 1000). */
  limit?: number;
  corrId?: string;
}

export type WebUiClientMessage =
  | UserMessageMessage
  | ObserverHelloMessage
  | RollbackMessage
  | SuppressMessage
  | HostQuiesceMessage
  | HostResumeMessage
  | RequestHostModeMessage
  | RequestOperatorLogMessage
  | RequestHistoryMessage
  | CommandMessage
  | RouteToChildMessage
  | InterruptMessage
  | CancelSubagentMessage
  | FleetStopMessage
  | FleetRestartMessage
  | SubscribePeekMessage
  | QuitConfirmMessage
  | RequestLessonsMessage
  | RequestMcplMessage
  | RequestBranchesMessage
  | McplAddMessage
  | McplRemoveMessage
  | McplSetEnvMessage
  | RequestPinsMessage
  | PinAddMessage
  | PinRemoveMessage
  | RequestSettingsMessage
  | SettingsUpdateMessage
  | SettingsResetMessage
  | SettingsCancelTransitionMessage
  | RequestWorkspaceMountsMessage
  | RequestWorkspaceTreeMessage
  | RequestWorkspaceFileMessage
  | PingMessage;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Type guard for narrowing parsed JSON to a known client message. Per-variant
 * payload validation lives here so handlers downstream can trust field
 * shapes — without this, a malformed payload like `{type:'mcpl-add', id: 42,
 * command: null}` would slip through and propagate into disk writes / file
 * paths / spawn() args, where the eventual failure is far from the cause.
 */
export function isClientMessage(value: unknown): value is WebUiClientMessage {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.type !== 'string') return false;
  switch (v.type) {
    case 'ping':
    case 'interrupt':
    case 'request-branches':
      return true;
    case 'rollback':
      return isNonEmptyString(v.messageId)
        && (v.agent === undefined || isNonEmptyString(v.agent))
        && (v.note === undefined || typeof v.note === 'string')
        && (v.corrId === undefined || typeof v.corrId === 'string');
    case 'suppress':
      return Array.isArray(v.messageIds) && v.messageIds.length > 0
        && v.messageIds.every((id) => isNonEmptyString(id))
        && (v.agent === undefined || isNonEmptyString(v.agent))
        && (v.note === undefined || typeof v.note === 'string')
        && (v.corrId === undefined || typeof v.corrId === 'string');
    case 'host-quiesce':
      return (v.reason === undefined || typeof v.reason === 'string')
        && (v.corrId === undefined || typeof v.corrId === 'string');
    case 'host-resume':
    case 'request-host-mode':
      return v.corrId === undefined || typeof v.corrId === 'string';
    case 'request-operator-log':
      return (v.limit === undefined || (typeof v.limit === 'number' && Number.isFinite(v.limit)))
        && (v.corrId === undefined || typeof v.corrId === 'string');
    case 'request-mcpl':
      return isOptionalScope(v.scope);
    case 'user-message':
      return typeof v.content === 'string';
    case 'observer-hello': {
      const id = v.identity as Record<string, unknown> | undefined;
      return !!id && id.scheme === 'ed25519'
        && typeof id.id === 'string'
        && typeof id.proof === 'string'
        && typeof id.timestamp === 'string';
    }
    case 'command':
      return typeof v.command === 'string'
        && (v.corrId === undefined || typeof v.corrId === 'string');
    case 'route-to-child':
      return isNonEmptyString(v.childName) && typeof v.content === 'string';
    case 'cancel-subagent':
      return isNonEmptyString(v.name)
        && (v.childName === undefined || isNonEmptyString(v.childName));
    case 'fleet-stop':
    case 'fleet-restart':
      return isNonEmptyString(v.name);
    case 'subscribe-peek':
      return typeof v.scope === 'string' && typeof v.active === 'boolean';
    case 'quit-confirm':
      return v.action === 'kill-children' || v.action === 'detach' || v.action === 'cancel';
    case 'request-lessons':
      return v.scope === undefined || typeof v.scope === 'string';
    case 'mcpl-add':
      return isValidMcplId(v.id)
        && isNonEmptyString(v.command)
        && isOptionalStringArray(v.args)
        && isOptionalStringMap(v.env)
        && (v.toolPrefix === undefined || isNonEmptyString(v.toolPrefix));
    case 'mcpl-remove':
      return isValidMcplId(v.id);
    case 'mcpl-set-env':
      return isValidMcplId(v.id) && isStringMap(v.env);
    case 'request-pins':
      return isOptionalScope(v.scope) && isOptionalNonEmptyString(v.agent);
    case 'pin-add': {
      if (!isOptionalScope(v.scope)) return false;
      if (!isOptionalNonEmptyString(v.agent)) return false;
      if (!isNonEmptyString(v.firstMessageId)) return false;
      if (v.lastMessageId !== undefined && !isNonEmptyString(v.lastMessageId)) return false;
      if (v.kind !== undefined && v.kind !== 'pin' && v.kind !== 'document') return false;
      if (v.name !== undefined && !isNonEmptyString(v.name)) return false;
      // Fold levels are small non-negative integers (0 = raw). Reject strings
      // and fractions before they reach the strategy's pin normalizer.
      for (const k of ['level', 'maxLevel']) {
        const x = v[k];
        if (x === undefined) continue;
        if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < 0 || x > 32) return false;
      }
      // level and maxLevel are different semantics; asking for both is ambiguous.
      if (v.level !== undefined && v.maxLevel !== undefined) return false;
      return true;
    }
    case 'pin-remove':
      return isOptionalScope(v.scope) && isOptionalNonEmptyString(v.agent) && isNonEmptyString(v.pinId);
    case 'request-settings':
      return isOptionalScope(v.scope) && isOptionalNonEmptyString(v.agent);
    case 'settings-update': {
      if (!isOptionalScope(v.scope)) return false;
      if (!isOptionalNonEmptyString(v.agent)) return false;
      if (!isOptionalBool(v.persist) || !isOptionalBool(v.notify) || !isOptionalBool(v.immediate)) return false;
      // Positive-integer-or-absent for each knob. The semantic gate (budget must
      // exceed max response tokens; tail/pace need a hot-configurable strategy)
      // lives in Agent.validateRuntimeSettingsPatch — this only guarantees the
      // shape so that gate gets numbers instead of strings.
      for (const k of ['contextBudgetTokens', 'tailTokens', 'transitionPaceTokens']) {
        if (!isOptionalPositiveInt(v[k])) return false;
      }
      // Require at least one actual knob: an empty patch would throw downstream.
      return v.contextBudgetTokens !== undefined
        || v.tailTokens !== undefined
        || v.transitionPaceTokens !== undefined;
    }
    case 'settings-reset':
      return isOptionalScope(v.scope)
        && isOptionalNonEmptyString(v.agent)
        && isOptionalBool(v.persist)
        && isOptionalBool(v.notify)
        && isOptionalStringArray(v.keys);
    case 'settings-cancel-transition':
      return isOptionalScope(v.scope) && isOptionalNonEmptyString(v.agent) && isOptionalBool(v.persist);
    case 'request-workspace-mounts':
      return v.scope === undefined || typeof v.scope === 'string';
    case 'request-workspace-tree':
      return isNonEmptyString(v.mount)
        && (v.scope === undefined || typeof v.scope === 'string');
    case 'request-workspace-file':
      return isNonEmptyString(v.path)
        && (v.scope === undefined || typeof v.scope === 'string');
    case 'request-history':
      return isNonEmptyString(v.corrId)
        && Number.isInteger(v.beforeIndex) && (v.beforeIndex as number) >= 0
        && (v.limit === undefined
          || (Number.isInteger(v.limit) && (v.limit as number) >= 1 && (v.limit as number) <= 500));
    default:
      return false;
  }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** MCPL config keys end up as filesystem-adjacent identifiers (the spec
 *  treats them as opaque strings, but they're surfaced in error paths and
 *  may flow into other tooling). Reject path separators, control bytes, and
 *  anything that looks like it would escape JSON-key territory. */
function isValidMcplId(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 128) return false;
  if (v.includes('/') || v.includes('\\') || v.includes('\0')) return false;
  // Control chars are a robustness hole — reject 0x00-0x1f and 0x7f.
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

function isStringMap(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  for (const val of Object.values(v as Record<string, unknown>)) {
    if (typeof val !== 'string') return false;
  }
  return true;
}

function isOptionalStringMap(v: unknown): v is Record<string, string> | undefined {
  return v === undefined || isStringMap(v);
}

function isOptionalStringArray(v: unknown): v is string[] | undefined {
  if (v === undefined) return true;
  if (!Array.isArray(v)) return false;
  return v.every((x) => typeof x === 'string');
}

function isOptionalNonEmptyString(v: unknown): v is string | undefined {
  return v === undefined || isNonEmptyString(v);
}

/** Scope fields: 'local' or a fleet-child name. Same lax shape the existing
 *  lessons/workspace requests use — the server resolves unknown children to
 *  a clean error rather than the validator guessing the fleet roster. */
function isOptionalScope(v: unknown): v is string | undefined {
  return v === undefined || typeof v === 'string';
}

function isOptionalBool(v: unknown): v is boolean | undefined {
  return v === undefined || typeof v === 'boolean';
}

/** Token counts: safe positive integers only. Rejects strings, NaN, Infinity,
 *  fractions and negatives before they reach the settings validator. */
function isOptionalPositiveInt(v: unknown): v is number | undefined {
  return v === undefined || (typeof v === 'number' && Number.isSafeInteger(v) && v > 0);
}
