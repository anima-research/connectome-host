/**
 * Shared wire-protocol types for the headless daemon ↔ FleetModule IPC.
 *
 * Both `src/headless.ts` (child runtime) and `src/modules/fleet-module.ts`
 * (parent module) import from here so the JSONL envelope shapes stay
 * identical at both ends.
 *
 * See HEADLESS-FLEET-PLAN.md for the full protocol spec.
 */

// ---------------------------------------------------------------------------
// Parent → Child: commands
// ---------------------------------------------------------------------------

export type IncomingCommand =
  /** Set which event types the child emits.  Supports glob: ["tool:*", "lifecycle"]. */
  | { type: 'subscribe'; events: string[] }
  /** Inject a user-like message; equivalent to typing in the child's TUI. */
  | { type: 'text'; content: string }
  /** Run a slash command in the child's commands.ts handler. */
  | { type: 'command'; command: string }
  /** Graceful (default) or immediate shutdown. */
  | { type: 'shutdown'; graceful?: boolean };

// ---------------------------------------------------------------------------
// Child → Parent: events
// ---------------------------------------------------------------------------

/** Lifecycle events added by the headless runtime (not framework TraceEvents). */
export type LifecycleEvent =
  | { type: 'lifecycle'; phase: 'ready'; pid: number; dataDir: string; recipe?: string; ts?: number }
  | { type: 'lifecycle'; phase: 'idle'; ts?: number }
  | { type: 'lifecycle'; phase: 'exiting'; reason: string; ts?: number };

/** Output line from a slash-command run, surfaced as an event. */
export interface CommandOutputEvent {
  type: 'command-output';
  text: string;
  style: string | null;
  ts?: number;
}

/**
 * A wire event from the child.  In practice this is either a framework
 * TraceEvent (typed loosely as Record<string,unknown>), or one of our
 * lifecycle / command-output additions.
 */
export type WireEvent =
  | LifecycleEvent
  | CommandOutputEvent
  | (Record<string, unknown> & { type: string });

// ---------------------------------------------------------------------------
// Subscription matching (used by both ends)
// ---------------------------------------------------------------------------

/**
 * Match an event type against a subscription set.  Supports:
 *   - exact match: "inference:completed"
 *   - prefix wildcard: "tool:*"  (matches "tool:started", "tool:completed", ...)
 *   - global wildcard: "*"
 */
export function matchesSubscription(eventType: string, subscription: Set<string>): boolean {
  if (subscription.has('*')) return true;
  if (subscription.has(eventType)) return true;
  for (const pattern of subscription) {
    if (pattern.endsWith('*') && eventType.startsWith(pattern.slice(0, -1))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Direct-routing helper for TUI input
// ---------------------------------------------------------------------------

export interface FleetRoute {
  /** Target child's name as parsed from the prefix. */
  childName: string;
  /** Message body after the prefix. */
  content: string;
}

/**
 * Parse a "@childname rest of message" line as a direct-route command,
 * bypassing the conductor agent.  Returns null if the line is not an
 * @-prefixed route (so TUI falls back to the default chat-to-conductor path).
 *
 * Accepted forms:
 *   "@miner hello there"     → { childName: "miner",  content: "hello there" }
 *   "@miner: hello"          → { childName: "miner",  content: "hello" }
 *   "@my-bot list channels"  → { childName: "my-bot", content: "list channels" }
 *
 * Rejected:
 *   "@miner"                 → null (no payload)
 *   "no prefix"              → null
 *   "@@escaped"              → null (literal @, e.g. paste of an email)
 */
export function parseFleetRoute(input: string): FleetRoute | null {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('@') || trimmed.startsWith('@@')) return null;
  const match = /^@([a-zA-Z0-9_.-]+)(?::|\s)\s*(.+)$/s.exec(trimmed);
  if (!match) return null;
  const childName = match[1]!;
  const content = match[2]!.trim();
  if (!content) return null;
  return { childName, content };
}
