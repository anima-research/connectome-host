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

/** Pull the parent process's full lesson library — sent on demand when the
 *  operator opens the Lessons tab. The response is a `lessons-list` envelope. */
export interface RequestLessonsMessage {
  type: 'request-lessons';
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
  | PingMessage;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Type guard for narrowing parsed JSON to a known client message. */
export function isClientMessage(value: unknown): value is WebUiClientMessage {
  if (!value || typeof value !== 'object') return false;
  const v = value as { type?: unknown };
  if (typeof v.type !== 'string') return false;
  return [
    'user-message', 'command', 'route-to-child',
    'interrupt', 'cancel-subagent', 'fleet-stop', 'fleet-restart',
    'subscribe-peek', 'quit-confirm', 'request-lessons', 'ping',
  ].includes(v.type);
}
