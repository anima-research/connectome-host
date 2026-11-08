/**
 * WebUI wire protocol — JSON-over-WebSocket envelope for the web admin client.
 *
 * Versioning: v4. Breaking changes bump `WEB_PROTOCOL_VERSION`. On a
 * mismatch the Web UI page shows a banner saying what to do and keeps the
 * welcome, session and messages it had: `applyWelcome` returns before taking
 * any of them. The welcome's other readers still read it, among them the
 * usage, costs, call ledger and host mode, and the agent trees when they're
 * shown; later frames still apply, and its socket stays open.
 *
 * v2: an observer gets only the frames its grant's scopes cover, live as well
 * as in its welcome, and a `stream-ended` frame in place of a stream-end trace
 * its scopes don't cover, which a page has to handle to end a streamed turn.
 *
 * v3: the eight messages whose target the operator chose from a session's data
 * (`rollback`, `suppress`, `pin-add`, `pin-remove`, `settings-update`,
 * `settings-reset`, `settings-cancel-transition` and `cancel-subagent`) carry
 * `sessionId`, the session whose data the operator chose the change from, and
 * the server refuses one chosen in a session other than the one whose
 * framework is open. Rollback and suppress always carry it. A pin or settings
 * change carries it unless its `scope` names a fleet child, and a
 * `cancel-subagent` unless its `childName` does, since the page doesn't know a
 * child's session, and then carries none. The data they're chosen from says
 * whose it is: the welcome's `session`, and `sessionId` on a `history-page`,
 * on this process's `pins-list` and `settings-state`, and on the
 * `/debug/context` answer, each the session whose framework produced it. A
 * push such as `message-appended` carries no stamp: it goes only to a client
 * welcomed for the framework that sent it, so it belongs to the welcome before
 * it. The one exception is a switch whose new framework fails to start: the
 * clients keep the welcome of the framework before it, and a frame the server
 * sends from the new one in answer to an action, such as the `branch-changed`
 * after a command, reaches them before their next welcome. The new framework's
 * traces and stored messages don't, since the server follows a framework's
 * events only once it has started.
 *
 * v4: an undo and a redo leave the branch alone (agent-framework #291). The
 * page learns of them from the `window:undone` trace and the `undone-marks`
 * frame, and transcript entries carry `undone`, where a v3 host moved the
 * branch and sent `branch-changed` and a fresh welcome. The local
 * `pins-list` carries `candidates`, which the pin picker lists, where a v3
 * page listed the transcript's loaded rows. A v3 page on a v4 host would show
 * an undone turn as still in context, and a v4 page on a v3 host an empty
 * picker, so each shows the mismatch banner instead.
 */

import type { Line } from '../output-line.js';
import type { AgentPhaseState } from '../state/agent-phases.js';
import type { AgentPhase } from '../state/agent-tree-reducer.js';

export const WEB_PROTOCOL_VERSION = 4;

/** What an observer needs to be sent the agent trees, and so what a page
 *  needs to build and show them: every scope but 'debug'. A tree's nodes
 *  carry a subagent's task, each run's phase and how it ended, failures
 *  included, its counters and its token counts. */
export const AGENT_TREE_SCOPES = ['messages', 'thinking', 'tools', 'health', 'ops'] as const;

/**
 * Cold-start payload, sent once a client connects (an observer, once its
 * `observer-hello` verifies). Contains everything needed to render a usable
 * view without any further roundtrips. Subsequent live updates arrive as
 * `trace` / `child-event` / etc.
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
  /** Paging metadata for `messages`. `startIndex` is the store slot index
   *  the tail window begins at (== the number of older messages not
   *  shipped); an observer's first entry can come after it, past messages
   *  its scopes empty. When its scopes empty the whole tail, an observer's
   *  welcome reads back as a `history-page` does, and `startIndex` is where
   *  that reading stopped. `totalCount` is the store size at snapshot
   *  time. */
  history: {
    startIndex: number;
    totalCount: number;
  };
  /**
   * Parent-local agent tree snapshot. Shape matches AgentTreeSnapshot from
   * `state/agent-tree-reducer.ts`.
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
     *  registration. Undefined when the recipe couldn't be loaded (e.g.
     *  URL recipe not yet fetched, or read error). */
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
   * 'operator-log' | 'user-images'. Absent on older hosts (nothing shown).
   */
  features?: string[];
  /** Host serving state when the framework supports quiesce (see HostModeSnapshot). */
  hostMode?: HostModeSnapshot;
  /** Each of this process's agents' phase now, by name (see AgentPhaseMessage). Left out for a client without `health`. */
  agentPhases?: Record<string, AgentPhaseState>;
  /** Cumulative session-wide token usage at connect time. */
  usage: TokenUsage;
  /** Per-agent cost breakdown for the parent process, present when the
   *  framework's usage tracker has data. Empty during cold start. */
  perAgentCost?: PerAgentCost[];
  /** Recent provider calls with cache verdicts. Present when the host's
   *  provider adapter exposes the call ledger. */
  callLedger?: CallLedgerSnapshot;
  /** The limits this host checks composer images against, from its own
   *  recipe (`imageLimitsFrom` fills what's absent). Absent on older hosts. */
  userImageLimits?: Partial<UserImageLimits>;
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
   *  bytes never ride the WebSocket. `toolUseId` names the tool call whose
   *  result the image came in, so it goes only where tool results go. */
  | { kind: 'media'; mediaType: string; ref?: string; toolUseId?: string };

export interface WelcomeMessageEntry {
  /** Stable id from the message store; clients can use this for keys. */
  id?: string;
  /** Store slot index — the paging cursor. For a coalesced shard run this is
   *  the first shard's index. */
  index: number;
  participant: 'user' | 'assistant' | 'system' | 'tool';
  /** Who a `user` entry reads as: `you` only for what came in as the host's
   *  own input, else the host by kind, a channel message's author with its
   *  channel, a push's author or else its server, or `user`. */
  speaker?: string;
  /** Ordered content blocks — the full internal life of the message. */
  blocks: MessageBlock[];
  /** Flattened text content (text blocks only). */
  text: string;
  /** Epoch-millis timestamp if available. */
  timestamp?: number;
  /** On a stored user message: the `corrId` of the composer send it came
   *  from, so that client can put it in place of the row it showed. */
  corrId?: string;
  /** The row is out of the conversation agent's window as an undone
   *  turn's (agent-framework #291): an undo (which /redo can reverse until
   *  the agent's next turn, a branch move or a restart, as agent-framework
   *  keeps the redo in memory only) or a shed after a refusal or failed
   *  inference (which it can't). Its next request is built without it,
   *  and the record, which the transcript shows, keeps it. Absent
   *  otherwise. */
  undone?: true;
}

/** A framework TraceEvent as it was emitted, except that the `data` of each
 *  `image` or `generated_image` block, at its top level or in its `source`, is
 *  replaced by a note of its length. Image data in any other shape, such as a
 *  `data:` URL in a provider's raw item, goes as it is. Clients typically pipe
 *  these into the same `AgentTreeReducer` the server uses. */
export interface TraceMessage {
  type: 'trace';
  /** TraceEvent shape — discriminated by inner `type` field. */
  event: { type: string; [k: string]: unknown };
}

/** A child's WireEvent as it arrived, except that image blocks' data is
 *  replaced by a note of its length, as in a TraceMessage. Scoped by child
 *  name so the client can route into the right reducer. */
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
  kind: 'complete' | 'stream' | 'keepalive';
  /** Honest call-class estimate; `~` means the trigger plumbing did not
   *  provide a definitive origin. Keepalive receipts identify their origin exactly. */
  originEstimate: 'turn~' | 'aux~' | 'keepalive';
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
  /** Why the call got its verdict. A failed call's (`ERROR`) is its error's
   *  text, which an observer without 'ops' gets empty. */
  cause: string;
  stopReason?: string;
  /** Present exactly when the call failed: its error's text, which an
   *  observer without 'ops' gets empty. */
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
  /** Present when the last read failed: what it said, which an observer
   *  without 'ops' gets empty. */
  error?: string;
  /** Epoch ms at which the last spent window resets, else null. A spent
   *  window is not by itself a parked agent — see `parked`. */
  blockedUntil?: number | null;
  /** The framework is holding an agent on the host's quota verdict. null when
   *  the framework predates the hook and cannot say. */
  parked?: boolean | null;
}

/** Per-agent cost slice used by the WebUI usage panel to label rows.
 *  Only surfaces parent-process agents. */
export interface PerAgentCost {
  name: string;
  cost: { total: number; currency: string };
  inferenceCount: number;
}

/** Sent when the active branch changes (checkout, restore, branchto, a
 *  rollback). A fresh `welcome` with the new branch's messages follows it. */
export interface BranchChangedMessage {
  type: 'branch-changed';
  branch: { id: string; name: string };
}

/** After an undo or a redo on the conversation agent's window
 *  (agent-framework #291, the `window:undone` trace), or a shed from it
 *  (`presentation:retracted`, reason `shed`), and right after each welcome:
 *  which of the transcript's rows from `fromIndex` on are out of that window
 *  as undone (`WelcomeMessageEntry.undone`), by store id. A row from there
 *  that isn't named isn't undone. This host sends `fromIndex` 0, every row
 *  of the record, so a page marks each row it holds, however far back its
 *  history reaches, the rows older than a welcome's tail that the page keeps
 *  across a reconnect included. A row before `fromIndex` would keep its
 *  mark. The one after a welcome moved no window, so the page reads its
 *  panels again at neither. */
export interface UndoneMarksMessage {
  type: 'undone-marks';
  agent: string;
  fromIndex: number;
  undone: string[];
}

/** That an agent's stream ended, with nothing of how or why: sent in place
 *  of a stream-end trace (STREAM_END_TRACES, state/turn-trace.ts) to a client
 *  whose scopes hold 'messages' but not what that trace carries, such as
 *  `inference:failed`'s error to an observer without 'ops'. A client ends
 *  the agent's streamed turn on it, as on the trace. */
export interface StreamEndedMessage {
  type: 'stream-ended';
  /** The agent whose stream ended, as the trace named it. */
  agentName?: string;
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

/** Not sent by this host: a session switch re-welcomes every client instead,
 *  with the new session. */
export interface SessionChangedMessage {
  type: 'session-changed';
  session: { id: string; name: string };
}

/** Live peek stream for one subagent. Multiplexed by `scope`. */
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
  /** Which process this snapshot describes: 'local' or a fleet-child
   *  name. */
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
 *  Sent only to the requesting client; mutations don't broadcast. */
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
   *  older hosts. */
  live?: Array<{
    id: string;
    connected: boolean;
    toolCount: number;
    toolPrefix?: string;
    /** command or url — whatever the transport targets. */
    target?: string;
    closedTab?: boolean;
  }>;
  /** Every tool the scoped process offers, with its effective MCPL class
   *  (RFC-008) and the source that decided it: `override` (recipe
   *  toolClassOverrides), `host` (this host's or the framework's own table),
   *  `server` (the MCPL server's `_meta`), `none` (unclassed). Sorted by tool
   *  name. Absent on hosts or frameworks that don't report classes. */
  toolClasses?: Array<{
    tool: string;
    /** Empty for an unclassed tool. */
    class: string[];
    source: 'override' | 'host' | 'server' | 'none';
    /** The providing MCPL server, for MCPL tools. */
    serverId?: string;
  }>;
}

/**
 * Protected ranges (pins / documents) for one agent.
 *
 * BROADCAST to full clients on change. No observer gets them, as none may
 * request them.
 */
export interface PinsListMessage {
  type: 'pins-list';
  /** Process these pins live in ('local' or fleet-child name). */
  scope?: string;
  /** The session whose framework answered, on this process's list; absent
   *  on a fleet child's. */
  sessionId?: string;
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
  /** False when `level` would silently degrade to raw. */
  levelHonored: boolean;
  /** Deepest fold level currently present, so the UI can bound level inputs. */
  deepestLevel?: number;
  /** Recent pinnable messages (REAL store ids) from the scoped process, the
   *  local one's as well as a fleet child's: the record's last 200 rows,
   *  less a row out of the agent's window as undone and a row whose audience
   *  stamp leaves the agent out (another resident's on a shared store), or,
   *  on a legacy window, which reads no stamp, the rows the resident's view
   *  leaves out instead (held traffic, suppressed rows, another agent's
   *  stored injections). */
  candidates?: Array<{ id: string; index: number; participant: string; text: string }>;
  /** Why the candidates couldn't be read; `candidates` is then absent. */
  candidatesError?: string;
}

/** Credential state of one process. Every field but `type`, `scope` and
 *  `subscription` is absent on an API-key host (`subscription: false`). */
export interface CredentialStateMessage {
  type: 'credential-state';
  scope?: string;
  subscription: boolean;
  /** Agent name the host's credential alerts are keyed on. */
  agent?: string;
  kind?: string;
  provider?: string;
  /** The state's alert text, which can hold the provider's rejection detail
   *  or a quota read's error: an observer without 'ops' gets it empty. */
  message?: string;
  since?: number;
  until?: number;
  windows?: string[];
  rotatable?: boolean;
  expiresAt?: number;
  actions?: Array<{ id: string; label: string; hint?: string }>;
  login?: { verificationUrl: string; userCode: string };
  /** The last operator action. Its `message`, which holds a failed action's
   *  reason, an observer without 'ops' gets empty. */
  lastAction?: { id: string; at: number; ok: boolean; message: string };
  /** While the last write of the credential to its file failed: the alert's
   *  text, which an observer without 'ops' gets empty. */
  unsaved?: string;
}

/**
 * Runtime context-settings snapshot.
 *
 * BROADCAST to every full client on change. No observer gets them, as none
 * may request them.
 */
export interface SettingsStateMessage {
  type: 'settings-state';
  /** Process these settings belong to ('local' or fleet-child name). */
  scope?: string;
  /** The session whose framework answered, on this process's state; absent
   *  on a fleet child's. */
  sessionId?: string;
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
  /** Keys currently overridden away from the recipe, persisted or not. */
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
 *  the requesting client and correlated by `corrId`. An observer's page
 *  leaves out the entries its scopes empty (an entry that had no blocks to
 *  begin with stays), and reads back past windows that leave it none, for
 *  at most ten windows of the request's size. So it comes back empty at the
 *  start of history, or where those ten windows ran out. */
export interface HistoryPageMessage {
  type: 'history-page';
  corrId: string;
  /** The session whose framework answered. */
  sessionId: string;
  /** Entries in store order (oldest first), ending just before the
   *  requested `beforeIndex`, or, for an observer, before the messages
   *  after them that its scopes empty. */
  entries: WelcomeMessageEntry[];
  /** Slot index where the reading stopped — the next page's `beforeIndex`.
   *  An observer's first entry can come after it. */
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

/** Server-side error response. Non-fatal; the client stays connected,
 *  except after a failed `observer-hello`, when the server closes the
 *  connection. */
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
 * (zulip notification, etc.) or channel incoming.
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

/** Host serving state, projected from the framework's host-mode status. */
export interface HostModeSnapshot {
  /** 'serving' | 'quiescing' | 'quiesced' — or whatever the framework reports. */
  mode: string;
  /** Epoch millis the quiesce began, while quiescing or quiesced, if known. */
  since?: number;
  /** Operator-supplied reason for a quiesce, if any. */
  reason?: string;
  /** Turns still draining while quiescing, if reported. */
  activeTurns?: number;
  /** Everything else the framework reported, for the detail tooltip. */
  detail?: Record<string, unknown>;
}

/**
 * An agent's phase changed: the tree's word for what it's doing, and when it
 * began, with no content. `sending` runs from a turn's start, through its hooks
 * and context compile, until its first token or a failed attempt. `health`'s, so
 * that a dashboard can show it without being granted the traces it comes from.
 * An agent that ends leaves the snapshots after it, with a last frame if ending
 * changed its phase. Covers this process's agents, not a fleet child's.
 */
export interface AgentPhaseMessage {
  type: 'agent-phase';
  agentName: string;
  phase: AgentPhase;
  since: number;
}

export interface HostModeMessage {
  type: 'host-mode';
  corrId?: string;
  hostMode: HostModeSnapshot;
}

/** Outcome of a `rollback` / `suppress` request. On success the server also
 *  sends `branch-changed` to every client whose scopes hold 'messages' and
 *  re-welcomes every client with the new branch's messages, as its scopes
 *  allow. */
export interface SurgeryResultMessage {
  type: 'surgery-result';
  corrId?: string;
  op: 'rollback' | 'suppress';
  ok: boolean;
  error?: string;
  /** Framework refusal code when `ok` is false: 'agent-busy' means quiesce
   *  (or wait for idle) and retry; 'failed' is an operational failure, which
   *  `error` describes; others are input problems. */
  code?: string;
  agent?: string;
  sourceBranch?: string;
  targetBranch?: string;
  messagesRemoved?: number;
  lastVisible?: { participant?: string; role?: string; preview?: string } | null;
  /** A rollback on a presented window (agent-framework #291): the rows after
   *  the target that stay in the record, out of the agent's window until its
   *  next turn starts, which presents them, or until a restart of the host
   *  before then, whose pass over every agent at rest does
   *  (rollbackToMessage's `returnedToArrivals`). Absent when there are none. */
  returnedToArrivals?: number;
  /** A rollback on a presented window: the rows after the target that one
   *  write presented with it, which stay in the agent's window, since a branch
   *  cut can't separate them; a suppression or a hide takes them out
   *  (rollbackToMessage's `keptInWindowAfterTarget`). Absent when there are
   *  none. */
  keptInWindowAfterTarget?: number;
  /** Why the Web UI's write of the `_config` mount, from the branch the
   *  store is on, failed, so the gate's files may still be the previous
   *  branch's. The answer comes once that write has run: after a surgery
   *  that landed, and after one that failed and left the store on the
   *  branch it made. Absent when it was written, or not tried. */
  mountError?: string;
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

export type WebUiServerMessage =
  | WelcomeMessage
  | TraceMessage
  | StreamEndedMessage
  | ChildEventMessage
  | CommandResultMessage
  | UsageMessage
  | CallLedgerMessage
  | BranchChangedMessage
  | UndoneMarksMessage
  | BranchesListMessage
  | SessionChangedMessage
  | PeekMessage
  | InboundTriggerMessage
  | QuitConfirmRequiredMessage
  | LessonsListMessage
  | McplListMessage
  | SettingsStateMessage
  | CredentialStateMessage
  | PinsListMessage
  | WorkspaceMountsMessage
  | WorkspaceTreeMessage
  | WorkspaceFileMessage
  | HistoryPageMessage
  | MessageAppendedMessage
  | ObserverAuthRequiredMessage
  | ObserverAckMessage
  | HostModeMessage
  | AgentPhaseMessage
  | SurgeryResultMessage
  | OperatorLogMessage
  | ErrorMessage;

/** Sent to a connection that upgraded without full authority (basic auth or
 *  a full session cookie), which is allowed only when observer grants exist:
 *  the client must reply with observer-hello before anything else is sent.
 *  `host` is what the server will verify the signed statement against — the
 *  Host header of the upgrade request. */
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

/** Plain user message; equivalent to typing in the TUI. Triggers inference. */
export interface UserMessageMessage {
  type: 'user-message';
  content: string;
  /** Images attached in the composer. Only sent to a host that advertises
   *  the 'user-images' feature: an older host ignores the field, and the
   *  images would be dropped without a word. */
  images?: UserMessageImage[];
  /** Names this send. Echoed on the `error` that refuses the message, and
   *  stored with the message it becomes, whose entry carries it back to
   *  every client, so it must be unique across clients (random, such as a
   *  UUID), not a per-client counter. */
  corrId?: string;
}

/** One composer image: raw base64 (no `data:` prefix) and the type the
 *  browser gave it. The host goes by the bytes, not the declared type. */
export interface UserMessageImage {
  mediaType: string;
  data: string;
}

/**
 * Limits on composer images. The SPA fits images to them before sending, and
 * the host checks them again (`userImageBlocks`), because an image the model
 * API refuses would fail every later inference on this branch, not just one,
 * until it leaves the context manager's live window.
 *
 * - `maxBase64Chars`: 5,000,000 base64 characters is 3.75 MB of image, within
 *   the per-image limit everywhere the model is served, the strictest being
 *   Bedrock's 5 MB of base64.
 * - `maxTotalBase64Chars`: what one message's images may come to, leaving
 *   room for its text in a frame of `MAX_WS_FRAME_BYTES`. The text isn't
 *   bounded by it, so the composer checks the whole frame too
 *   (`frameLimitNote`).
 * - `maxSidePx`: a side Claude's and OpenAI's APIs take whatever else a
 *   request carries: under the stricter limit Claude's vision docs set for a
 *   request with more than 20 image blocks, which those docs say 3,000 px on
 *   a side stays under on every platform, and under the 30,000 patches of
 *   32 px that OpenAI's docs allow one image.
 *
 * Under the host's own strategies, `autobiographical` and `frontdesk`, a host
 * advertises a smaller count when its recipe's live window is under 8, and
 * less base64 when its recipe sets `maxLiveImageBytes` under the defaults
 * (`userImageLimits` in the welcome); a strategy an extension registers gets
 * the defaults.
 *
 * https://platform.claude.com/docs/en/build-with-claude/vision
 * https://developers.openai.com/api/docs/guides/images-vision
 */
export interface UserImageLimits {
  maxCount: number;
  maxBase64Chars: number;
  maxTotalBase64Chars: number;
  maxSidePx: number;
}

export const USER_IMAGE_LIMITS: Readonly<UserImageLimits> = {
  maxCount: 8,
  maxBase64Chars: 5_000_000,
  maxTotalBase64Chars: 12 * 1024 * 1024,
  maxSidePx: 3000,
};

/** The limits to fit and check composer images against: each one a host
 *  advertised, where it's a positive whole number no looser than the
 *  default, and the default otherwise. */
export function imageLimitsFrom(advertised?: Partial<UserImageLimits> | null): UserImageLimits {
  const pick = (key: keyof UserImageLimits): number => {
    const v = advertised?.[key];
    return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= USER_IMAGE_LIMITS[key]
      ? v
      : USER_IMAGE_LIMITS[key];
  };
  return {
    maxCount: pick('maxCount'),
    maxBase64Chars: pick('maxBase64Chars'),
    maxTotalBase64Chars: pick('maxTotalBase64Chars'),
    maxSidePx: pick('maxSidePx'),
  };
}

/**
 * The most one WebSocket frame from a client can carry, in bytes of its JSON
 * as UTF-8. The host's server is set to it (`maxPayloadLength`), and Bun
 * closes a socket that sends a larger frame without an `error` frame, so
 * the message is lost. The composer checks each message the user sends
 * from it (`frameLimitNote`) and keeps one that's over, to shorten.
 */
export const MAX_WS_FRAME_BYTES = 16 * 1024 * 1024;

/** The bytes a client message takes as a frame: the SPA's wire client sends
 *  `JSON.stringify(message)`, which the socket carries as UTF-8. */
export function wsFrameBytes(message: WebUiClientMessage): number {
  return new TextEncoder().encode(JSON.stringify(message)).length;
}

/** A size in bytes, KiB or MiB, rounded up to a tenth, so a size over
 *  nothing never reads as 0. The unit follows the rounded figure, so a size
 *  just under a MiB reads 1.0 MiB, not 1024.0 KiB. */
function binarySize(bytes: number): string {
  if (bytes < 1024) return bytes === 1 ? '1 byte' : `${bytes} bytes`;
  const tenthsUp = (n: number): number => Math.ceil(n * 10) / 10;
  const kib = tenthsUp(bytes / 1024);
  return kib < 1024 ? `${kib.toFixed(1)} KiB` : `${tenthsUp(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** What the composer says when a message's frame is over
 *  `MAX_WS_FRAME_BYTES`, or null when it fits. Only a user message carries
 *  images, so only its note offers removing one. */
export function frameLimitNote(message: WebUiClientMessage): string | null {
  const bytes = wsFrameBytes(message);
  if (bytes <= MAX_WS_FRAME_BYTES) return null;
  const hasImages = message.type === 'user-message' && (message.images?.length ?? 0) > 0;
  return `not sent: this message is ${binarySize(bytes - MAX_WS_FRAME_BYTES)} over the ` +
    `${MAX_WS_FRAME_BYTES / (1024 * 1024)} MiB one message can carry; ` +
    (hasImages ? 'shorten the text or remove an image' : 'shorten the text');
}

/** Slash command. The server replies with a `command-result`
 *  carrying the same `corrId`. */
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
 *  otherwise the conductor's local SubagentModule is used. */
export interface CancelSubagentMessage {
  type: 'cancel-subagent';
  name: string;
  childName?: string;
  /** The session shown when the operator chose this cancel, whose subagents
   *  the page's tree showed. Required unless `childName` is set, and then
   *  absent. */
  sessionId?: string;
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

/** Pull the agent's protected ranges. Response is a `pins-list` envelope,
 *  with picker `candidates` (recent real store ids) for the local scope and
 *  a fleet-child `scope` alike. */
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
 * NOTE: context-manager honors `level` under `foldingStrategy` 'kv-stable' or
 * 'kv-unified' with adaptive resolution. Elsewhere it degrades to raw: a safe
 * superset, but not what was asked for. `pins-list.levelHonored` reports which
 * case the live agent is in.
 */
export interface PinAddMessage {
  type: 'pin-add';
  /** Fleet child name, or 'local'/undefined for the parent process. */
  scope?: string;
  /** The session of the data the operator chose this from, as the server
   *  stamped it on that data. Required unless `scope` names a fleet child,
   *  and then absent. */
  sessionId?: string;
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
  /** The session of the data the operator chose this from, as the server
   *  stamped it on that data. Required unless `scope` names a fleet child,
   *  and then absent. */
  sessionId?: string;
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
  /** The session of the data the operator chose this from, as the server
   *  stamped it on that data. Required unless `scope` names a fleet child,
   *  and then absent. */
  sessionId?: string;
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

/** Ask for the credential state (subscription hosts). Answered with
 *  `credential-state`; an API-key host answers `subscription: false`. */
export interface RequestCredentialMessage {
  type: 'request-credential';
  scope?: string;
}

/**
 * Run one operator credential action — the buttons on a `quota-spent` /
 * `auth-expired` / `auth-login-required` alert row, or the Health panel.
 * `token` is only read for `set-token`; it is applied in memory (and to the
 * credentials file when the host loaded one), never logged or echoed. The
 * answer is a `credential-state` broadcast: credentials are process state,
 * every operator sees the same outcome.
 */
export interface CredentialActionMessage {
  type: 'credential-action';
  scope?: string;
  action: 'refresh' | 'login' | 'set-token' | 'recheck';
  token?: string;
}

/** Revert named settings to their recipe values (all four when omitted). */
export interface SettingsResetMessage {
  type: 'settings-reset';
  /** Fleet child name, or 'local'/undefined for the parent process. */
  scope?: string;
  /** The session of the data the operator chose this from, as the server
   *  stamped it on that data. Required unless `scope` names a fleet child,
   *  and then absent. */
  sessionId?: string;
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
  /** The session of the data the operator chose this from, as the server
   *  stamped it on that data. Required unless `scope` names a fleet child,
   *  and then absent. */
  sessionId?: string;
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
 *  `beforeIndex`, or, for an observer, before the messages its scopes
 *  empty; pass the previous page's `startIndex` to keep walking backward. */
export interface RequestHistoryMessage {
  type: 'request-history';
  corrId: string;
  /** Fetch messages strictly before this store slot index. */
  beforeIndex: number;
  /** Page size; server clamps to its maximum (500). */
  limit?: number;
}

/** In-band observer authentication: the client signs
 *  `connectome-observer|v1|<host>|<timestamp>` with its ed25519 key. */
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
  /** The session of the messages the operator chose this from, as the
   *  server stamped it on them. */
  sessionId: string;
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
  /** The session of the messages the operator chose this from, as the
   *  server stamped it on them. */
  sessionId: string;
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
  | RequestCredentialMessage
  | CredentialActionMessage
  | RequestWorkspaceMountsMessage
  | RequestWorkspaceTreeMessage
  | RequestWorkspaceFileMessage
  | PingMessage;

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
        && isNonEmptyString(v.sessionId)
        && (v.agent === undefined || isNonEmptyString(v.agent))
        && (v.note === undefined || typeof v.note === 'string')
        && (v.corrId === undefined || typeof v.corrId === 'string');
    case 'suppress':
      return Array.isArray(v.messageIds) && v.messageIds.length > 0
        && v.messageIds.every((id) => isNonEmptyString(id))
        && isNonEmptyString(v.sessionId)
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
      return typeof v.content === 'string'
        && (v.corrId === undefined || typeof v.corrId === 'string')
        && (v.images === undefined || (Array.isArray(v.images) && v.images.every((img) => {
          const i = img as Record<string, unknown> | null;
          return !!i && typeof i === 'object' && typeof i.mediaType === 'string' && typeof i.data === 'string';
        })));
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
        && (v.childName === undefined
          ? isNonEmptyString(v.sessionId)
          : isNonEmptyString(v.childName) && v.sessionId === undefined);
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
      if (!isOptionalScope(v.scope) || !sessionFitsScope(v)) return false;
      if (!isOptionalNonEmptyString(v.agent)) return false;
      if (!isNonEmptyString(v.firstMessageId)) return false;
      if (v.lastMessageId !== undefined && !isNonEmptyString(v.lastMessageId)) return false;
      if (v.kind !== undefined && v.kind !== 'pin' && v.kind !== 'document') return false;
      if (v.name !== undefined && !isNonEmptyString(v.name)) return false;
      for (const k of ['level', 'maxLevel']) {
        const x = v[k];
        if (x === undefined) continue;
        if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < 0 || x > 32) return false;
      }
      if (v.level !== undefined && v.maxLevel !== undefined) return false;
      return true;
    }
    case 'pin-remove':
      return isOptionalScope(v.scope) && sessionFitsScope(v)
        && isOptionalNonEmptyString(v.agent) && isNonEmptyString(v.pinId);
    case 'request-settings':
      return isOptionalScope(v.scope) && isOptionalNonEmptyString(v.agent);
    case 'settings-update': {
      if (!isOptionalScope(v.scope) || !sessionFitsScope(v)) return false;
      if (!isOptionalNonEmptyString(v.agent)) return false;
      if (!isOptionalBool(v.persist) || !isOptionalBool(v.notify) || !isOptionalBool(v.immediate)) return false;
      for (const k of ['contextBudgetTokens', 'tailTokens', 'transitionPaceTokens']) {
        if (!isOptionalPositiveInt(v[k])) return false;
      }
      return v.contextBudgetTokens !== undefined
        || v.tailTokens !== undefined
        || v.transitionPaceTokens !== undefined;
    }
    case 'settings-reset':
      return isOptionalScope(v.scope)
        && sessionFitsScope(v)
        && isOptionalNonEmptyString(v.agent)
        && isOptionalBool(v.persist)
        && isOptionalBool(v.notify)
        && isOptionalStringArray(v.keys);
    case 'settings-cancel-transition':
      return isOptionalScope(v.scope) && sessionFitsScope(v)
        && isOptionalNonEmptyString(v.agent) && isOptionalBool(v.persist);
    case 'request-credential':
      return isOptionalScope(v.scope);
    case 'credential-action': {
      if (!isOptionalScope(v.scope)) return false;
      if (v.action !== 'refresh' && v.action !== 'login' && v.action !== 'set-token' && v.action !== 'recheck') return false;
      if (v.action === 'set-token') {
        return typeof v.token === 'string' && v.token.trim().length > 0 && v.token.length <= 8192;
      }
      return v.token === undefined;
    }
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

function isValidMcplId(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 128) return false;
  if (v.includes('/') || v.includes('\\') || v.includes('\0')) return false;
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

function isOptionalScope(v: unknown): v is string | undefined {
  return v === undefined || typeof v === 'string';
}

export function isChildScope(scope: string | undefined): scope is string {
  return scope !== undefined && scope !== '' && scope !== 'local';
}

function sessionFitsScope(v: Record<string, unknown>): boolean {
  return isChildScope(v.scope as string | undefined)
    ? v.sessionId === undefined
    : isNonEmptyString(v.sessionId);
}

function isOptionalBool(v: unknown): v is boolean | undefined {
  return v === undefined || typeof v === 'boolean';
}

function isOptionalPositiveInt(v: unknown): v is number | undefined {
  return v === undefined || (typeof v === 'number' && Number.isSafeInteger(v) && v > 0);
}
