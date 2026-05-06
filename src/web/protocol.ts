/**
 * WebUI wire protocol — JSON-over-WebSocket envelope for the web admin client.
 *
 * Both ends import these types so the messages stay in lockstep. The shape
 * deliberately mirrors the fleet IPC (`fleet-types.ts`) so a future external
 * aggregator can reuse the same parsers.
 *
 * Versioning: v0. Breaking changes bump `WEB_PROTOCOL_VERSION` and clients
 * refuse to connect on mismatch.
 */

import type { Line } from '../commands.js';

export const WEB_PROTOCOL_VERSION = 0;

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
  /** Conversation history snapshot. Kept lean — clients should fold live
   *  `trace` events on top for live updates. */
  messages: WelcomeMessageEntry[];
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
  /** Cumulative session-wide token usage at connect time. */
  usage: TokenUsage;
  /** Per-agent cost breakdown for the parent process, present when the
   *  framework's usage tracker has data. Empty during cold start. */
  perAgentCost?: PerAgentCost[];
}

export interface WelcomeMessageEntry {
  /** Stable id from the message store; clients can use this for keys. */
  id?: string;
  participant: 'user' | 'assistant' | 'system' | 'tool';
  /** Flattened text content of the message; tool-call details ride on `toolCalls`. */
  text: string;
  /** Tool calls associated with an assistant message, if any. */
  toolCalls?: Array<{ id: string; name: string; input: unknown }>;
  /** ISO timestamp if available. */
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
  mount: string;
  entries: Array<{ path: string; size: number }>;
}

/** File content — response to request-workspace-file. Content is
 *  line-numbered (cat -n style) as returned by the workspace `read` tool. */
export interface WorkspaceFileMessage {
  type: 'workspace-file';
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

export type WebUiServerMessage =
  | WelcomeMessage
  | TraceMessage
  | ChildEventMessage
  | CommandResultMessage
  | UsageMessage
  | BranchChangedMessage
  | SessionChangedMessage
  | PeekMessage
  | InboundTriggerMessage
  | QuitConfirmRequiredMessage
  | LessonsListMessage
  | McplListMessage
  | WorkspaceMountsMessage
  | WorkspaceTreeMessage
  | WorkspaceFileMessage
  | ErrorMessage;

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

/** Cancel one specific in-process subagent by display name. */
export interface CancelSubagentMessage {
  type: 'cancel-subagent';
  name: string;
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

/** Pull the configured MCPL servers from mcpl-servers.json. Response is an
 *  `mcpl-list` envelope. Recipe-defined servers are excluded — those live in
 *  the recipe file and aren't editable from here. */
export interface RequestMcplMessage {
  type: 'request-mcpl';
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

export type WebUiClientMessage =
  | UserMessageMessage
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
  | McplAddMessage
  | McplRemoveMessage
  | McplSetEnvMessage
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
    case 'request-mcpl':
      return true;
    case 'user-message':
      return typeof v.content === 'string';
    case 'command':
      return typeof v.command === 'string'
        && (v.corrId === undefined || typeof v.corrId === 'string');
    case 'route-to-child':
      return isNonEmptyString(v.childName) && typeof v.content === 'string';
    case 'cancel-subagent':
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
    case 'request-workspace-mounts':
      return v.scope === undefined || typeof v.scope === 'string';
    case 'request-workspace-tree':
      return isNonEmptyString(v.mount)
        && (v.scope === undefined || typeof v.scope === 'string');
    case 'request-workspace-file':
      return isNonEmptyString(v.path)
        && (v.scope === undefined || typeof v.scope === 'string');
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
