/**
 * SubagentModule — spawn and fork ephemeral subagents.
 *
 * Tools:
 *   subagent--spawn  — Fresh agent with system prompt + task, no inherited context
 *   subagent--fork   — Agent inheriting parent's compiled context
 *   subagent--hud    — Toggle fleet status HUD overlay
 *
 * By default, spawn/fork are async: they return immediately and deliver
 * results as user messages + inference-request events. Pass `sync: true`
 * to block until completion.
 *
 * Sync tasks are detachable: the user can push one to the background
 * mid-flight with Ctrl+B in the TUI, and one still running at its `timeoutMs`
 * (default maxExecutionMs, 600 s) moves there itself. A run in the background
 * goes on until it ends and delivers its result as a message. An async
 * task's `timeoutMs` is a hard limit on its whole run, retries included,
 * counted from when it holds a concurrency slot; async tasks have none by
 * default.
 */

import type {
  Module,
  ModuleContext,
  ProcessState,
  ProcessEvent,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
  TraceEvent,
  ContextManager,
} from '@animalabs/agent-framework';
import type { Agent, AgentFramework } from '@animalabs/agent-framework';
import { KnowledgeStrategy } from '@animalabs/agent-framework';
import { isToolResultContent, isToolUseContent } from '@animalabs/membrane';
import type { ContentBlock } from '@animalabs/membrane';
import { emptyUsage, foldUsageSample, type UsageCounts, type UsageSample } from '../state/stream-usage.js';
import { traceError } from '../state/turn-trace.js';
import { shown } from './shown.js';
import { unknownToolResult } from './unknown-tool.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubagentModuleConfig {
  /** The provider transport the host built (recipe.ts resolveProvider).
   *  One adapter serves every stream in the process, so this is what every
   *  subagent runs on too; launch descriptions state it. Optional, so the
   *  module still builds with no config: absent, descriptions say the host
   *  didn't state it. */
  provider?: string;
  /** Maximum fork/spawn depth (default: 3) */
  maxDepth?: number;
  /** Current depth (incremented for child subagent modules) */
  currentDepth?: number;
  /** Default model for subagents */
  defaultModel?: string;
  /** Default max tokens per subagent inference */
  defaultMaxTokens?: number;
  /** Which parent agent this module serves (for fork context access) */
  parentAgentName?: string;
  /** Max concurrent subagent executions (default: 3) */
  maxConcurrent?: number;
  /** Max prompt tokens before failing fast (default: 190000) */
  maxPromptTokens?: number;
  /** Max execution time per subagent in ms (default: 600000 = 10 min) */
  maxExecutionMs?: number;
  /** Max restart attempts on transient errors (default: 2) */
  maxRetries?: number;
}

export interface SubagentResult {
  summary: string;
  findings: string[];
  issues: string[];
  toolCallsCount: number;
}

interface SpawnInput {
  name: string;
  systemPrompt: string;
  task: string;
  model?: string;
  maxTokens?: number;
  tools?: string[];
  sync?: boolean;
  timeoutMs?: number;
}

interface ForkInput {
  name: string;
  task: string;
  systemPrompt?: string;
  model?: string;
  maxTokens?: number;
  sync?: boolean;
  timeoutMs?: number;
}

/** Handle for an async (fire-and-forget) subagent. */
interface AsyncSubagentHandle {
  name: string;
  type: 'spawn' | 'fork';
  promise: Promise<SubagentResult>;
  parentAgentName: string;
}

/**
 * Handle for a sync subagent that can be detached mid-flight.
 * When detached, the blocking tool call resolves immediately and
 * the subagent continues running, delivering results async.
 */
interface DetachableHandle {
  name: string;
  type: 'spawn' | 'fork';
  promise: Promise<SubagentResult>;
  parentAgentName: string;
  detach: () => void;
}

/**
 * Non-retryable termination of a subagent. All abnormal-but-expected exits
 * (user cancel, zombie reclaim, depth limit, etc.) use this so the catch
 * path can distinguish "killed" from "transient network error".
 */
export class SubagentTerminated extends Error {
  constructor(
    public readonly reason: 'cancelled' | 'zombie' | 'killed',
    public readonly partialOutput: string,
    message?: string,
  ) {
    super(message ?? `Subagent terminated: ${reason}`);
    this.name = 'SubagentTerminated';
  }
}

/**
 * A subagent's failure that the module accounts for itself, such as its
 * prompt over the module's limit, a launch whose stream wouldn't read all
 * that the launch gives it, its run past its own time limit, or no
 * concurrency slot in time. Running the subagent again as it stands can't
 * change it, so the retry loop ends on one without reading its words.
 * (Before, the classifiers read these messages too, so a name or a number
 * in them could make one count as transient or as a rate limit: a subagent
 * named "migrate" holds "rate", a 1500 ms limit holds "500".) `why` says
 * what ended it and `remedy` what to do; failedRun puts them into the
 * account the agent reads, by whether anything ran.
 */
class SubagentFailure extends Error {
  override readonly name = 'SubagentFailure';
  constructor(readonly why: string, readonly remedy = '') {
    super(why);
  }
}

/** setTimeout's longest delay; a longer one fires at once. */
const MAX_TIMER_MS = 2_147_483_647;
const timerDelay = (ms: number): number => Math.min(MAX_TIMER_MS, Math.max(0, ms));
/** How early a timer may fire, by Date.now(): Node's timers can fire up to
 *  1 ms before the time they were set for (Bun 1.4.3's didn't, in a probe
 *  of 2,000). */
const TIMER_SLACK_MS = 2;

/** How long a running subagent may show no activity, with no stream, tool
 *  call or request in flight, before the reaper reclaims its slot and peek
 *  calls it a zombie. Postmortem 2026-05-28 F3: bumped from 30_000ms — 30s
 *  was too tight for Opus on 100–165K-token contexts with rate-limited MCP
 *  tools; single-round TTFT routinely exceeds it. The `requestInFlightSince`
 *  guard is the primary defence; the threshold bump is belt-and-braces for
 *  legitimate post-request pauses. */
const ZOMBIE_THRESHOLD_MS = 120_000;

/** A length of time as the agent reads it: milliseconds below a second,
 *  seconds from there. */
function duration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${Math.round(ms / 100) / 10} s`;
}

/** What a call refused for its inputs leaves undone, to open its refusal. */
const NOT_DONE: Record<string, string> = {
  spawn: 'Nothing was started',
  fork: 'Nothing was started',
  hud: "The fleet HUD wasn't changed",
  concurrency: "The concurrency limit wasn't changed",
  peek: 'Nothing was shown',
  return: 'Nothing was returned',
};

/** What to give for an input a call needs and didn't give, by tool. */
const GIVE_MISSING: Record<string, Record<string, string>> = {
  spawn: {
    name: 'give the subagent a short name',
    systemPrompt: "give the new subagent's system prompt (a spawn has no default; subagent--fork starts from your own prompt and conversation)",
    task: "give the subagent's task",
  },
  fork: {
    name: 'give the fork a short name',
    task: 'give the intention the fork pursues',
  },
  hud: {
    enabled: 'give true to show the fleet status summary before each inference, or false to hide it',
  },
};

/** The type a tool's schema declares for an input: the module's schemas use
 *  text, a number, a boolean, and one list, `tools`, of names. */
type DeclaredType = 'string' | 'number' | 'boolean' | 'array';

/** Whether `value` is of the type its schema declares. A number JSON can't
 *  hold (a JSON 1e400 parses as Infinity) isn't one, and the list holds
 *  names, so text. */
function isDeclaredType(value: unknown, declared: DeclaredType): boolean {
  switch (declared) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value) && value.every((item) => typeof item === 'string');
  }
}

/** What an input of a declared type must be, as a refusal says it. */
const TYPE_WORDS: Record<DeclaredType, string> = {
  string: 'text',
  number: 'a number',
  boolean: 'true or false',
  array: 'a list of names',
};

/** A call's inputs: an object, with any input given as null left out, so
 *  that wherever the module reads an input, null reads as not given. No
 *  input at all, or null for the whole input, gives {}. For a whole input
 *  that isn't an object, such as "go", it returns null: that names no
 *  input, so the call is refused rather than read as giving none. */
function inputsOf(input: unknown): Record<string, unknown> | null {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) return null;
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null));
}

/** The label a stopped run's result opens with. */
function stopLabel(reason: SubagentTerminated['reason']): string {
  switch (reason) {
    case 'cancelled': return 'Stopped by user';
    case 'zombie': return `Stopped: it showed no activity for over ${duration(ZOMBIE_THRESHOLD_MS)}, so the host reclaimed its slot`;
    default: return 'Stopped';
  }
}

/** The number every agent name the module makes ends in: the time in ms, or
 *  one past the last name's number once that has caught up with the time.
 *  agent-framework refuses to create an agent under a name it has seen in
 *  the framework's life, and a retry, or a new run under a name an earlier
 *  run used, can start in the same millisecond as an earlier attempt. */
let lastNameStamp = 0;
function nameStamp(): number {
  lastNameStamp = Math.max(Date.now(), lastNameStamp + 1);
  return lastNameStamp;
}

/** Persisted subagent state (stored in Chronicle module state).
 *  'cancelled' = terminal-but-benign (user cancel, zombie reclaim, supersession).
 *  Postmortem 2026-05-28 P1 #4: separated from 'failed' so the TUI subagent
 *  list and the web admin tree agree on terminal cause. */
interface PersistedSubagent {
  name: string;
  type: 'spawn' | 'fork';
  task: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  /**
   * Last time we saw a trace event addressed to this subagent (token, tool
   * call, completion, etc.). Used as the staleness metric for zombie
   * detection: `startedAt` alone can't distinguish a slow-but-progressing
   * subagent from one that has been silently stuck for hours. Bumped on
   * every inference-lifecycle event in the trace listener; persisted so
   * it survives branch ops and session restores.
   */
  lastActivityAt: number;
  completedAt?: number;
  toolCallsCount: number;
  findingsCount: number;
  statusMessage?: string;
  parent?: string;
}

/** Observable state of an active subagent, for TUI display. See
 *  PersistedSubagent.status — 'cancelled' is the same dedicated benign-
 *  terminal state introduced for the postmortem 2026-05-28 P1 #4 fix. */
export interface ActiveSubagent {
  name: string;
  type: 'spawn' | 'fork';
  task: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  /** Last addressed trace event timestamp. See PersistedSubagent.lastActivityAt. */
  lastActivityAt: number;
  completedAt?: number;
  statusMessage?: string;
  toolCallsCount: number;
  findingsCount: number;
}

/** Live state captured for peek observability. */
interface LiveSubagentState {
  frameworkAgentName: string;
  displayName: string;
  systemPrompt: string;
  contextManager: ContextManager;
  currentStream: string;
  pendingToolCalls: Array<{ name: string; input?: unknown }>;
  /** Track callIds from tool_calls_yielded so we can route tool:* events back. */
  activeCallIds: Set<string>;
  /** When set, an inference request has been dispatched but no token has
   *  arrived yet — i.e., the agent is provably alive waiting on the LLM
   *  provider. Postmortem 2026-05-28 F3: between `inference:started` /
   *  `inference:stream_resumed` and the first `inference:tokens`, both
   *  `currentStream` and `pendingToolCalls` are empty even though the
   *  request is on the wire. The reaper / peek predicates must treat this
   *  as a protected state, otherwise slow rounds (Opus on 100–165K-token
   *  contexts routinely exceed 30s TTFT) get reaped mid-request. Cleared
   *  on first token, completion, failure, or new tool yield. */
  requestInFlightSince?: number;
  /** The current stream's usage as of its latest sample (see stream-usage.ts). */
  streamUsage?: UsageCounts;
}

/** Streaming event pushed to peek subscribers. */
export type SubagentStreamEvent =
  | { type: 'inference:started' }
  | { type: 'tokens'; content: string }
  | { type: 'tool_calls'; calls: Array<{ name: string; input?: unknown }> }
  | { type: 'tool:started'; tool: string; input?: unknown }
  | { type: 'tool:completed'; tool: string; durationMs: number }
  | { type: 'tool:failed'; tool: string; error: string }
  | { type: 'inference:completed' }
  | { type: 'inference:turn_ended' }
  | { type: 'inference:aborted'; reason?: string }
  | { type: 'inference:failed'; error: string }
  | { type: 'inference:exhausted'; error: string }
  | { type: 'stream_resumed' }
  | { type: 'done'; summary: string; lastInputTokens?: number };

export type SubagentStreamCallback = (event: SubagentStreamEvent) => void;

/** Snapshot returned by peek(). */
export interface SubagentPeekSnapshot {
  name: string;
  type: 'spawn' | 'fork';
  task: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  elapsedMs: number;
  messageCount: number;
  lastMessageSnippet: string;
  currentStream: string;
  pendingToolCalls: Array<{ name: string; input?: unknown }>;
  toolCallsCount: number;
  /** True if the subagent appears stalled: running status, no active stream, elapsed > threshold. */
  isZombie: boolean;
}

// ---------------------------------------------------------------------------
// Fork materialisation
// ---------------------------------------------------------------------------

/**
 * Build the tool_result text the fork stream sees in place of the launch
 * receipt the parent stream sees (launchReceipt: accepted as a fork,
 * starting or waiting for a slot, then the launch description).
 *
 * The wording frames the fork as a parallel continuation of the same self
 * rather than a separate agent — both streams inherit everything, the fork
 * stream's job is to set aside the broader agenda and pursue one intention.
 *
 * This addresses fork-disorientation by naming the dual-stream situation
 * explicitly and salient-placing it as the matching tool_result of the
 * fork tool_use the model just emitted.
 */
export function buildIntentionFramedForkResult(
  name: string,
  task: string,
  depth: number,
  maxDepth: number,
  /** What this stream runs on (describeSubagentLaunch + the tool surface),
   *  stated before its first inference. */
  orientation?: string,
): string {
  return `${intentionFramedHead(depth, maxDepth, orientation)}\n\nYour intention for this stream: ${task}`;
}

/**
 * Everything in a fork's intention-framed result before the restated
 * intention: the dual-stream framing, the depth, the orientation and the
 * return instruction. A stream's message cap keeps a message's beginning,
 * so this part leads the result, and it must reach the stream whole: a cut
 * anywhere in it refuses the launch. Only the restated intention can be cut
 * without that, since the fork's own call (a tool call, which the cap
 * passes whole) carries all of it.
 */
export function intentionFramedHead(
  depth: number,
  maxDepth: number,
  orientation?: string,
): string {
  const depthLine = depth < maxDepth
    ? `You are at depth ${depth} of ${maxDepth} (${maxDepth - depth} sub-fork levels remaining).`
    : `You are at depth ${depth} of ${maxDepth} — at max depth, you cannot sub-fork.`;
  return (
    `Two parallel streams of you continue from this point, both inheriting everything you've done so far. ` +
    `An instance of you still runs as the parent stream, carrying on the broader agenda; ` +
    `the self reading this is the fork — set aside that broader agenda and focus exclusively on the intention ` +
    `you set for this stream in your subagent--fork call, restated at the end of this result.\n\n` +
    `${depthLine}\n\n` +
    (orientation ? `${orientation}\n\n` : '') +
    `When this intention is complete, return your findings via subagent--return so the parent stream can integrate them.`
  );
}

// ---------------------------------------------------------------------------
// Launch descriptions
// ---------------------------------------------------------------------------

/** Every subagent stream runs a fresh knowledge strategy with these windows,
 *  under this stream budget. They are launch inputs like any other: the
 *  caller's receipt and the stream's own first context both state them. */
const SUBAGENT_STRATEGY = {
  name: 'knowledge',
  headWindowTokens: 2_000,
  recentWindowTokens: 80_000,
  maxMessageTokens: 10_000,
} as const;
const SUBAGENT_STREAM_TOKENS = 500_000;

/**
 * What a launch must deliver to its stream, in the shape it composed it.
 * Each message in a stream's context is capped alone (SUBAGENT_STRATEGY's
 * maxMessageTokens): the cap counts its text and string tool results and
 * keeps its beginning; past the budget it cuts or drops text, and cuts a
 * string tool result or replaces it with an omission notice, while tool
 * calls and structured results pass whole. So what was stored can still be
 * missing from what the stream reads. A launch's check compiles the stream's
 * context the way its first inference will: the launch sets no context
 * budget, so both use the context manager's default, and both cap and
 * select the stored messages before any injection is added. What it reads
 * is the launch's own compile. Between the two, only the stream's own
 * compression can change what's selected, and it can reach a fork's call
 * and result only when their result message, with what's added after it
 * before the first request, is longer than the stream's recent window,
 * which context-manager 0.14.1 counts newest-first in its store's
 * estimates, raw until the stream's first call calibrates them
 * (getUnheldRecentWindowStart). agent-framework 0.22.3 adds up to two such
 * messages at the stream's first start: the prose-routing primer under
 * explicit or hybrid routing (maybePrimeProseMode), and a one-line routing
 * notice under locus or hybrid routing once the stream's channel resolves
 * (announceLocusIfChanged). A fork's restated task nearly as long as the
 * window would make that so.
 */
export type LaunchDelivery =
  /** A spawn's or a parentless fork's own first messages: the orientation,
   *  then the text that carries the task, each its own message and whole. */
  | { kind: 'message'; orientation: string; taskBlock: string }
  /** A fork's intention-framed result, found by its call's id: it begins
   *  with its head (framing, orientation and return instruction) whole, and
   *  that call carries the whole task. */
  | { kind: 'fork-result'; callId: string; head: string; task: string };

/**
 * What a launch promises that a stream's compiled first context lacks:
 * 'orientation' when the orientation isn't there whole: for a fork, when
 * its result is there but doesn't begin with its whole head (framing,
 * orientation and return instruction); 'task' when a spawn's or parentless
 * fork's task text isn't; 'call' when a fork's own call, which carries its
 * whole task, isn't there with that task, or its result isn't there at
 * all. Empty when everything arrived.
 */
export function undeliveredLaunchParts(
  messages: ReadonlyArray<{ content: ContentBlock[] }>,
  delivery: LaunchDelivery,
): Array<'orientation' | 'task' | 'call'> {
  const blocks = messages.flatMap((message) => message.content as unknown[]);
  const cut: Array<'orientation' | 'task' | 'call'> = [];
  if (delivery.kind === 'message') {
    const texts = blocks.flatMap((b) => {
      const block = b as { type?: unknown; text?: unknown };
      return block.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
    });
    if (!texts.includes(delivery.orientation)) cut.push('orientation');
    if (!texts.includes(delivery.taskBlock)) cut.push('task');
    return cut;
  }
  const result = blocks.find((b) => {
    const block = b as { type?: unknown; toolUseId?: unknown };
    return block.type === 'tool_result' && block.toolUseId === delivery.callId;
  }) as { content?: unknown } | undefined;
  const resultText = typeof result?.content === 'string'
    ? result.content
    : Array.isArray(result?.content)
      ? (result.content as Array<{ type?: unknown; text?: unknown }>)
          .map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : '')).join('')
      : '';
  // A fork's call and its result arrive or go together in a launch's first
  // compile (context-manager 0.14.1): the head window doesn't end between a
  // tool call and its result (getHeadWindowEnd, whose anchorHeadToCoverage
  // keeps that boundary while nothing owns a message, as in a launch's new
  // store), the recent window doesn't start at a tool result
  // (getUnheldRecentWindowStart) and drops a leading result whose call it
  // left out (emitRecentNewestFirst), and the cap passes a tool call whole
  // and keeps every tool result, cut or replaced by an omission notice. So
  // only the cap cuts a result that is there, and a result that isn't there
  // is the call's part to say.
  if (result !== undefined && !resultText.startsWith(delivery.head)) cut.push('orientation');
  const call = blocks.find((b) => {
    const block = b as { type?: unknown; id?: unknown };
    return block.type === 'tool_use' && block.id === delivery.callId;
  }) as { input?: { task?: unknown } } | undefined;
  if (result === undefined || call?.input?.task !== delivery.task) cut.push('call');
  return cut;
}
const FALLBACK_SUBAGENT_MODEL = 'claude-haiku-4-5-20251001';
const NO_PARENT_SYSTEM_PROMPT = 'You are a research assistant.';

type ProseRouting = 'locus' | 'explicit' | 'hybrid' | 'disabled';

/** What each prose-routing mode does with a stream's plain text, as
 *  agent-framework documents the mode (AgentConfig.proseRouting). As terse
 *  as AF's own mode primer, since a spawn's orientation is a user-role
 *  message: explicit's is the primer's own (agent-framework 0.22.3
 *  proseModePrimer), whose prose_help pointer proseRoutingEffect adds only
 *  for a stream that is shown the tool. */
const PROSE_ROUTING_EFFECT: Record<ProseRouting, string> = {
  locus: 'plain text is published to the channel the framework infers for each turn, if there is one',
  explicit: 'plain text is delivered only with a destination prefix line, such as ">>#channel"',
  hybrid: 'unprefixed plain text is published to the channel the framework infers for each turn, if there is one; ' +
    'a leading ">>>destination" envelope routes that text to the destination it names instead',
  disabled: 'plain text is never published, even with a prefix; only explicit send tools reach a channel',
};

/** What a mode does to the stream's plain text, naming the prose_help tool
 *  only where the stream is shown it: the framework shows it under explicit
 *  routing only to a stream whose rules allow it. */
function proseRoutingEffect(mode: ProseRouting, shownHelp: boolean): string {
  return PROSE_ROUTING_EFFECT[mode] + (mode === 'explicit' && shownHelp ? '; the prose_help tool shows the syntax' : '');
}

/** How long a launch waits for a concurrency slot before it ends with an error. */
const SLOT_TIMEOUT_MS = 120_000;

/**
 * What a forked or spawned stream is launched with, resolved once at the
 * call, its tool rules included, and kept through the slot wait and every
 * retry. The stream is created from these inputs, and both the caller's
 * receipt and the stream's own first context render them, so the two can't
 * describe different launches. The parent's values are as they
 * were at the call; a value the parent doesn't report stays undefined and
 * is said to be uncompared, never assumed equal.
 */
export interface SubagentLaunch {
  kind: 'fork' | 'spawn';
  name: string;
  /** Depth the new stream runs at, and the module's maximum. */
  depth: number;
  maxDepth: number;
  /** The fork call's tool_use id (forks only). */
  forkPoint?: string;
  /** Absent when the host didn't state it (SubagentModuleConfig.provider). */
  provider?: string;
  model: string;
  systemPrompt: string;
  systemPromptSource: 'parent' | 'override' | 'caller' | 'default';
  maxTokens: number;
  maxStreamTokens: number;
  strategy: {
    name: string;
    headWindowTokens: number;
    recentWindowTokens: number;
    maxMessageTokens: number;
    compressionModel: string;
  };
  /** The calling stream's prose routing, which the stream inherits;
   *  undefined when there is no calling stream, so the framework's default
   *  applies (stated when the stream starts). */
  proseRouting?: ProseRouting;
  /** The tool rules the stream is created with, resolved at the call by
   *  filterToolNames; the stream's first context then states the surface
   *  they actually produced. */
  tools: {
    /** What the stream is created with: the calling stream's own rules
     *  (see `parent`), narrowed by a spawn's list, less the subagent tools at
     *  the depth limit, with subagent--return; 'all' only for a launch
     *  without a list, short of the depth limit, whose calling stream is
     *  unrestricted or absent. */
    allowed: 'all' | string[];
    /** The spawn caller's own list, as given: `allowed` is what gets
     *  subagent--return. */
    requested?: string[];
    /** The names of `allowed` the process offers at the call, which is
     *  what the description can say the stream gets; present when `allowed`
     *  is a list. Short of the depth limit `allowed` keeps every name, so a
     *  tool registered later still reaches the stream. */
    granted?: string[];
    /** At the sub-fork depth limit: only what the process offers at the
     *  call, and no subagent tools but subagent--return. */
    depthLimited: boolean;
  };
  /** The calling stream as it was at the call: the caller, else the
   *  configured parent agent; null when there is neither, or when the
   *  configured parent agent isn't registered. */
  parent: null | {
    stream: string;
    model: string;
    maxTokens: number;
    maxStreamTokens: number;
    /** Its runtime settings' context budget. */
    contextBudgetTokens: number;
    /** Its strategy's recent raw tail, when the strategy reports one. */
    tailTokens?: number;
    /** Its strategy's name and message cap, when the strategy reports them. */
    strategy?: string;
    maxMessageTokens?: number;
    allowedTools: 'all' | string[];
  };
  /** The calling stream's agent as resolved at the call (not rendered): a
   *  fork compiles this agent's context, never another later registered
   *  under its name. Null when there is none. */
  parentAgent: Agent | null;
}

/** What happened when the stream was created: known only then, so stated
 *  only in the stream's own first context, after the launch block. */
export interface SubagentStart {
  inherited:
    | { kind: 'cut-at-call' }
    | { kind: 'compiled-at-start'; reason: 'call-not-in-context' | 'no-call-id' }
    | { kind: 'none'; reason: 'no-parent' | 'spawn' };
  /** The stream's runtime settings' context budget, as created. */
  contextBudgetTokens: number;
  /** The stream's prose routing, as created; stated here only when the
   *  launch didn't set it. */
  proseRouting: ProseRouting;
  /** The tools the stream is shown, as the board stands when the launch
   *  composes its first context. */
  tools: string[];
  /** What the calling stream (`SubagentLaunch.parent`) is shown now;
   *  undefined when it can't be read, or when the launch has no calling
   *  stream. */
  parentTools?: string[];
  /** The agent settings the stream was created with, each rendered. */
  agentSettings: AgentSettings;
  /** The parent's (a fork's) or the caller's (a spawn's) agent settings at
   *  the start, each rendered, read from the agent the launch resolved at
   *  the call even once it has left the framework; undefined only when the
   *  launch has no calling stream (`SubagentLaunch.parent` is null). */
  parentAgentSettings?: AgentSettings;
}

/**
 * The agent settings a stream's agent doesn't take from its launch. It's
 * built from the launch alone (ephemeralAgentConfig), so each is the
 * framework's default, whatever the parent's or caller's is. Each is
 * rendered without values that could be
 * long or private: the prefill message as set or not, provider parameters by
 * their keys.
 */
export type AgentSettings = Record<string, string>;

/** How a setting that couldn't be read is rendered. */
const UNREADABLE = 'unreadable';

export function agentSettingsOf(agent: {
  thinking?: { enabled?: boolean; type?: string } | undefined;
  providerParams?: Record<string, unknown> | undefined;
  promptCaching?: boolean;
  cacheTtl?: string;
  prefillUserMessage?: string | undefined;
  refusalHandling?: unknown;
  toolResultGuard?: { enabled?: boolean };
  toolWrapperProseGuard?: boolean;
  /** agent-framework's resolved `AgentConfig.clock` (`Agent.clock`). */
  clock?: { intervalSeconds: number; precision?: string } | undefined;
  getRuntimeSettings?(): { sameRoundThinkTextPolicy?: string };
}): AgentSettings {
  const onOff = (v: boolean | undefined) => (v ? 'on' : 'off');
  const keys = Object.keys(agent.providerParams ?? {}).sort();
  let thinkText: string | undefined;
  try { thinkText = agent.getRuntimeSettings?.().sameRoundThinkTextPolicy; } catch { thinkText = UNREADABLE; }
  return {
    'extended thinking': agent.thinking?.enabled ? (agent.thinking.type ?? 'enabled') : 'off',
    'provider parameters': keys.length > 0 ? `set (${joinAll(keys)})` : 'none',
    'prompt caching': onOff(agent.promptCaching),
    'prompt-cache TTL': agent.cacheTtl ?? 'unset',
    'prefill user message': agent.prefillUserMessage ? 'set' : 'none',
    'same-round think-text policy': thinkText ?? 'unset',
    'refusal handling': agent.refusalHandling ? 'set' : 'none',
    'tool-result guard': onOff(agent.toolResultGuard?.enabled),
    'tool-wrapper prose guard': onOff(agent.toolWrapperProseGuard),
    'clock rows': agent.clock ? clockRows(agent.clock) : 'off',
  };
}

/** A clock setting as the orientation names it: its interval, in minutes
 *  when it is whole minutes, else in seconds, since `Agent.clock` keeps only
 *  seconds and the unit the recipe gave can't be told; and ", read to the
 *  second" where its precision is seconds at a whole-minute interval, the one
 *  precision that isn't its interval's default (agent-framework's
 *  resolveClockConfig). */
function clockRows(clock: { intervalSeconds: number; precision?: string }): string {
  const seconds = clock.intervalSeconds;
  if (seconds % 60 !== 0) return `every ${seconds === 1 ? '1 second' : `${seconds} seconds`}`;
  const minutes = seconds / 60;
  const every = `every ${minutes === 1 ? '1 minute' : `${minutes} minutes`}`;
  return clock.precision === 'seconds' ? `${every}, read to the second` : every;
}

const formatTokens = (n: number): string => `${n.toLocaleString('en-US')} tokens`;

/** Whether two tool-rule lists hold the same names, whatever their order or
 *  repeats. */
function sameNames(a: readonly string[], b: readonly string[]): boolean {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((name) => y.has(name));
}

/** "a", "a and b", "a, b and c" */
function joinAll(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** A partial list: up to SOME_NAMES named and the rest counted ("a, b, …
 *  and 890 more"). It's for the caller's restriction and the caller's
 *  rules a stream isn't given, which describe another stream, and for the
 *  tools a fork has beyond its parent's, which its request defines in full
 *  anyway. Everything else an orientation lists is named in full with
 *  joinAll: a spawn's or parentless fork's whole surface, the names a
 *  spawn's caller listed, and the parent's tools a fork lacks. So a spawn's
 *  long orientation comes from its own tools, and a shorter tools list
 *  shortens it. */
const SOME_NAMES = 10;
function joinSome(items: readonly string[]): string {
  if (items.length <= SOME_NAMES) return joinAll(items);
  return `${items.slice(0, SOME_NAMES).join(', ')} and ${items.length - SOME_NAMES} more`;
}

/** How a fork's tools differ from its parent's: every tool it lacks, since
 *  its inherited context may show the parent using them, and the tools it
 *  has beyond the parent's in part, since its request defines them all. */
export function toolDifferences(extra: readonly string[], missing: readonly string[]): string {
  const parts: string[] = [];
  if (extra.length > 0) parts.push(`it also has ${joinSome(extra)}`);
  if (missing.length > 0) parts.push(`it doesn't have ${joinAll(missing)}`);
  return parts.join(', and ');
}

/**
 * The launch inputs as one neutral block, rendered identically in the
 * caller's receipt and in the stream's first context. Each setting names
 * the stream's value and the caller's at the call, or says the caller's
 * isn't reported. A fork's summary sorts every setting into differs, same,
 * and not compared, so no equality is claimed that wasn't checked.
 */
export function describeSubagentLaunch(launch: SubagentLaunch): string {
  const fork = launch.kind === 'fork';
  const p = launch.parent;
  const them = fork ? 'the parent' : 'the caller';
  const call = fork ? 'subagent--fork' : 'subagent--spawn';
  const s = launch.strategy;
  const lines: string[] = [
    `Launch of ${launch.kind} '${launch.name}', as resolved at its ${call} call${launch.forkPoint ? ` (${launch.forkPoint})` : ''}:`,
  ];

  if (!p) {
    lines.push(fork
      ? `- Lineage: no parent stream, so this fork inherits no context; depth ${launch.depth} of ${launch.maxDepth}.`
      : `- Lineage: no calling stream; depth ${launch.depth} of ${launch.maxDepth}.`);
  } else if (fork) {
    lines.push(
      `- Lineage: forked from stream "${p.stream}"; depth ${launch.depth} of ${launch.maxDepth}. ` +
        "When the fork starts, it inherits that stream's compiled context, even if the stream has ended by then: " +
        "through this call's exchange if the call is in that context then, and otherwise all of it as it is then.",
    );
  } else {
    lines.push(
      `- Lineage: spawned by stream "${p.stream}" as a separate agent with its own system prompt and task; ` +
        `it inherits none of the caller's context; depth ${launch.depth} of ${launch.maxDepth}.`,
    );
  }

  // Every setting in one list, in reading order. With a calling stream,
  // each is compared (same: true/false) or says why it isn't (uncompared).
  type Setting = { name: string; line: string; same?: boolean; uncompared?: 'unreported' | 'at-start' };
  const settings: Setting[] = [];
  const tokens = (name: string, label: string, mine: number, theirs: number | undefined): void => {
    if (!p) {
      settings.push({ name, line: `- ${label}: ${formatTokens(mine)}.` });
    } else if (theirs === undefined) {
      settings.push({ name, uncompared: 'unreported', line: `- ${label}: ${formatTokens(mine)} (${them}'s isn't reported).` });
    } else {
      const same = mine === theirs;
      settings.push({
        name,
        same,
        line: `- ${label}: ${formatTokens(mine)}${same ? `, the same as ${them}'s` : ` (${them}'s: ${formatTokens(theirs)})`}.`,
      });
    }
  };

  if (p) {
    const same = launch.model === p.model;
    settings.push({ name: 'model', same, line: `- Model: ${launch.model}${same ? `, the same as ${them}'s` : ` (${them}'s: ${p.model})`}.` });
    // One membrane adapter serves every stream in the process, so the
    // connection is the same by construction.
    settings.push({ name: 'provider connection', same: true, line: `- Provider: ${launch.provider ?? 'not stated by the host'}, on the same connection as ${them}'s.` });
  } else {
    settings.push({ name: 'model', line: `- Model: ${launch.model}.` });
    settings.push({ name: 'provider connection', line: `- Provider: ${launch.provider ?? 'not stated by the host'}.` });
  }

  const promptText: Record<SubagentLaunch['systemPromptSource'], string> = {
    parent: "- System prompt: the parent's.",
    // A fork with no parent has no prompt to override.
    override: p ? '- System prompt: overridden for this fork.' : '- System prompt: set for this fork.',
    caller: '- System prompt: supplied by the caller for this spawn.',
    default: '- System prompt: the default research-assistant prompt.',
  };
  settings.push({
    name: 'system prompt',
    ...(fork && p ? { same: launch.systemPromptSource === 'parent' } : {}),
    line: promptText[launch.systemPromptSource],
  });

  const notInherited = fork && p
    ? " It doesn't inherit the parent's summaries or strategy state, though summary text already in the parent's compiled context comes with that context."
    : '';
  if (!p) {
    settings.push({ name: 'strategy type', line: `- Strategy: a fresh ${s.name} instance.` });
  } else if (p.strategy === undefined) {
    settings.push({
      name: 'strategy type',
      uncompared: 'unreported',
      line: `- Strategy: a fresh ${s.name} instance (${them}'s strategy doesn't report a name).${notInherited}`,
    });
  } else {
    const same = p.strategy === s.name;
    settings.push({
      name: 'strategy type',
      same,
      line: `- Strategy: a fresh ${s.name} instance${same ? `, the same type as ${them}'s` : ` (${them}'s: ${p.strategy})`}.${notInherited}`,
    });
  }
  tokens('head window', 'Head window', s.headWindowTokens, undefined);
  tokens('recent window', 'Recent window', s.recentWindowTokens, p?.tailTokens);
  tokens('message cap', 'Message cap', s.maxMessageTokens, p?.maxMessageTokens);
  settings.push({
    name: 'compression model',
    ...(p ? { uncompared: 'unreported' as const } : {}),
    line: `- Compression model: ${s.compressionModel}${p ? ` (${them}'s isn't reported)` : ''}.`,
  });
  settings.push({
    name: 'context budget',
    ...(p ? { uncompared: 'at-start' as const } : {}),
    line: "- Context budget: not set by this launch, so the framework's default for a new stream applies, stated when the stream starts" +
      (p ? ` (${them}'s: ${formatTokens(p.contextBudgetTokens)})` : '') + '.',
  });
  tokens('stream budget', 'Stream budget', launch.maxStreamTokens, p?.maxStreamTokens);
  tokens('output limit', 'Output limit', launch.maxTokens, p?.maxTokens);

  // What the stream is created with (tools.allowed): the caller's own rules,
  // narrowed by a spawn's list, all resolved at the call; at the depth limit
  // only what the process offered of them then, less the subagent tools but
  // subagent--return. What the process offered of them is `granted`, which is
  // what this names.
  const allowed = launch.tools.allowed;
  const requested = launch.tools.requested;
  const callerRules = p?.allowedTools ?? 'all';
  // filterToolNames' ensureReturn adds subagent--return to a restricted
  // caller's rules, or a spawn's list, that lack it; each line says where
  // it was added.
  const addsReturn = callerRules !== 'all' && !callerRules.includes('subagent--return');
  const listAddsReturn = requested !== undefined && !requested.includes('subagent--return');
  const granted = launch.tools.granted ?? (allowed === 'all' ? [] : allowed);
  const depth = launch.tools.depthLimited;
  const explicit = launch.proseRouting === 'explicit';
  // prose_help isn't on the board: explicit prose routing shows it to a
  // stream whose rules allow it (agent-framework's
  // availableToolsForPresentation checks canUseTool), so a
  // stream gets it though the process doesn't offer it at the call. The
  // depth limit's rules, built from what the process offers, never hold it.
  const shownHelp = explicit && allowed !== 'all' && allowed.includes('prose_help');

  // The stream runs its caller's prose routing, so with a calling stream it
  // is the same by construction; without one the framework's default
  // applies, and the stream's start states it.
  const routing = launch.proseRouting;
  settings.push(routing === undefined
    ? {
        name: 'prose routing',
        ...(p ? { uncompared: 'at-start' as const } : {}),
        line: "- Prose routing: not set by this launch, so the framework's default applies, stated when the stream starts.",
      }
    : {
        name: 'prose routing',
        ...(p ? { same: true } : {}),
        line: `- Prose routing: ${routing}${p ? `, inherited from ${them}` : ''}: ` +
          `${proseRoutingEffect(routing, allowed === 'all' || shownHelp)}.`,
      });

  // What the stream gets of its rules: what the process offered at the call,
  // subagent--return among it, and prose_help where explicit prose routing
  // shows it.
  const gets = (fromList: string, offeredAt: string): string => {
    if (!shownHelp) {
      return granted.length === 1 ? 'only subagent--return' : `only these ${granted.length}${fromList}${offeredAt}: ${joinAll(granted)}`;
    }
    const offered = granted.length === 1
      ? 'subagent--return, as the process offered it at the call'
      : `${joinAll(granted)}, as the process offered them at the call`;
    return `only these ${granted.length + 1}${fromList}: ${offered}, and prose_help, which explicit prose routing shows`;
  };
  // The names the stream's rules came from, a spawn's list or else the
  // caller's own rules, that it isn't given at the call, in one list: kept
  // in its rules for a tool the process doesn't offer yet, or left out of
  // them. The stream can't act on which, and the caller, who could, chose
  // them.
  const notGiven = (held: readonly string[]): string[] =>
    [...new Set(held)].filter((name) => !granted.includes(name) && !(shownHelp && name === 'prose_help'));
  let toolRule: string;
  // The rules are the caller's own: the line says so itself.
  let inherited = false;
  if (allowed === 'all') {
    // Only a launch without a list, short of the depth limit, whose calling
    // stream is unrestricted or absent, is unrestricted.
    toolRule = 'no restriction';
  } else if (requested !== undefined) {
    // What the list grants, not the list: subagent--return named once, and
    // said to be added where the list lacks it. The grant is the board at
    // the call; the stream's own Tools line says what it's shown when it
    // starts.
    const onlyReturn = granted.length === 1 && !shownHelp;
    toolRule = onlyReturn
      ? `only subagent--return${listAddsReturn ? ', added' : ''}${requested.length === 0 ? ': the caller listed no tools' : ''}`
      : gets(
        ` from the caller's list${listAddsReturn ? ', with subagent--return added' : ''}`,
        ', as the process offered them at the call',
      );
    const missing = notGiven(requested);
    // "also" where the line has already named something from the list.
    const also = onlyReturn && listAddsReturn ? '' : 'also ';
    if (missing.length > 0) toolRule += `; the caller's list ${also}names ${joinAll(missing)}, which this stream isn't given at the call`;
    if (depth) toolRule += '; at this depth, no subagent tool but subagent--return';
  } else if (callerRules !== 'all') {
    // A fork, or a spawn without a list, keeps a restricted caller's rules,
    // with subagent--return: at the depth limit only what the process
    // offers of them, less the subagent tools but subagent--return. Either
    // way the line says where subagent--return was added.
    inherited = true;
    const n = callerRules.length;
    // Short of the depth limit it keeps the rules whole, with subagent--return
    // added where they lack it, and is given what the process offers of
    // them: two facts, so that a stream given only subagent--return isn't
    // read as keeping only that.
    toolRule = `${them} is restricted to ${n === 0 ? 'no tools' : n}, and ` +
      (depth
        ? `at this depth it keeps only what the process offers of that at the call, less the subagent tools${addsReturn ? ', with subagent--return added' : ' but subagent--return'}: ${gets('', '')}`
        : `this stream keeps those rules${addsReturn ? ', with subagent--return added' : ''}; it's given ${gets('', ', as the process offered them at the call')}`);
    const missing = notGiven(callerRules);
    if (missing.length > 0) toolRule += `; ${them}'s rules also allow ${joinSome(missing)}, which this stream isn't given at the call`;
  } else {
    // An unrestricted caller's launch at the depth limit.
    toolRule = 'every tool the process offers at the call except the subagent tools, keeping subagent--return: no further forks or spawns at this depth';
  }
  if (p) {
    // A launch without a list is the same as its caller's when the stream is
    // created with the caller's rules: both unrestricted, or the same names
    // once the depth limit and ensureReturn have had their say, so a
    // subagent--return that ensureReturn adds makes them differ.
    const same = requested === undefined && (allowed === 'all'
      ? callerRules === 'all'
      : callerRules !== 'all' && sameNames(allowed, callerRules));
    const theirs = p.allowedTools === 'all'
      ? `${them} has no restriction`
      : p.allowedTools.length === 0
        ? `${them} is restricted to no tools`
        : `${them} is restricted to ${p.allowedTools.length}: ${joinSome(p.allowedTools)}`;
    const relation = inherited ? '' : same ? `, the same as ${them}` : `; ${theirs}`;
    settings.push({ name: 'tool rules', same, line: `- Tool rules: ${toolRule}${relation}.` });
  } else {
    settings.push({ name: 'tool rules', line: `- Tool rules: ${toolRule}.` });
  }

  if (fork && p) {
    const differs = settings.filter((x) => x.same === false).map((x) => x.name);
    const same = settings.filter((x) => x.same === true).map((x) => x.name);
    const unreported = settings.filter((x) => x.uncompared === 'unreported').map((x) => x.name);
    const atStart = settings.filter((x) => x.uncompared === 'at-start').map((x) => x.name);
    const parts: string[] = [];
    if (differs.length > 0) parts.push(`Differs in ${joinAll(differs)}.`);
    if (same.length > 0) parts.push(`Same: ${joinAll(same)}.`);
    const uncompared: string[] = [];
    if (unreported.length > 0) {
      uncompared.push(`${joinAll(unreported)} (the parent doesn't report ${unreported.length === 1 ? 'it' : 'them'})`);
    }
    if (atStart.length > 0) uncompared.push(`${joinAll(atStart)} (set when the stream starts)`);
    if (uncompared.length > 0) parts.push(`Not compared: ${uncompared.join(', and ')}.`);
    lines.push(`- Against the parent at the call: ${parts.join(' ')}`);
  }
  for (const x of settings) lines.push(x.line);
  return lines.join('\n');
}

/**
 * What the stream's own first context adds after the launch block: what it
 * actually inherited, its context budget as created, its prose routing when
 * the launch left that to the framework, and the tools it is shown, read
 * from the board as the launch composes its context, beside what its caller
 * is shown now. All
 * of it is known only when the stream is created, which can be well after
 * the call if the launch waited for a slot.
 */
export function describeSubagentStart(launch: SubagentLaunch, start: SubagentStart): string {
  const fork = launch.kind === 'fork';
  const p = launch.parent;
  const them = fork ? 'the parent stream' : 'the calling stream';
  const lines = ['At the start of this stream:'];

  const inh = start.inherited;
  if (inh.kind === 'cut-at-call') {
    // What materialiseStructuralFork keeps: everything before the call's
    // assistant message; that message and its result message with their
    // other blocks; nothing else after the call.
    lines.push(
      // As the parent's compiled context had them when this stream started,
      // which for a queued fork is after the slot wait; addMsg drops an exact
      // repeat, as it always has.
      "- Inherited: the parent's compiled context through the fork call's exchange. Messages before the call " +
        'are as that context had them when this stream started, except that an exact repeat of an earlier ' +
        "message is dropped, and this stream's own strategy caps and selects them as it does every message. " +
        "The call's assistant message keeps its other blocks, with sibling fork calls removed. Its result " +
        "message keeps the turn's other results, with sibling forks' results removed, and leads with this " +
        "call's result rewritten as this message, so if that message is over the cap, what's cut is what comes " +
        "after it. If the parent's context held no result message for the call, one is made holding this " +
        "call's result alone. No other message after the call is included.",
    );
  } else if (inh.kind === 'compiled-at-start') {
    lines.push(
      "- Inherited: the parent's whole compiled context as it was when this stream started, because " +
        // A sync fork's call, or one whose round isn't stored yet, was never
        // in that context.
        (inh.reason === 'no-call-id' ? 'the fork call had no id to cut at' : "the fork call wasn't in that context") +
        '. It can include turns that came after the call. An exact repeat of an earlier message is dropped, ' +
        "and this stream's own strategy caps and selects what remains as it does every message.",
    );
  } else if (inh.reason === 'spawn') {
    lines.push("- Inherited: nothing; a spawn starts from its task.");
  } else {
    lines.push('- Inherited: nothing; there is no parent stream.');
  }

  lines.push(
    `- Context budget: ${formatTokens(start.contextBudgetTokens)}` +
      (p ? ` (${fork ? 'the parent' : 'the caller'}'s at the call: ${formatTokens(p.contextBudgetTokens)})` : '') + '.',
  );
  if (launch.proseRouting === undefined) {
    lines.push(`- Prose routing: ${start.proseRouting}, the framework's default: ` +
      `${proseRoutingEffect(start.proseRouting, start.tools.includes('prose_help'))}.`);
  }

  // Settings the stream's agent takes as the framework's defaults, set
  // against the parent's or caller's as it is now.
  const ours = start.agentSettings;
  const names = Object.keys(ours);
  const theirSettings = p ? start.parentAgentSettings : undefined;
  if (theirSettings === undefined) {
    lines.push(
      `- Agent settings, the framework's defaults: ${names.map((n) => `${n} ${ours[n]}`).join(', ')}` +
        '.',
    );
  } else {
    // A value that couldn't be read is never counted as matching.
    const differ = names.filter((n) => theirSettings[n] !== ours[n] || ours[n] === UNREADABLE);
    lines.push(differ.length === 0
      ? `- Agent settings: the framework's defaults, the same as ${them}'s now (${joinAll(names)}).`
      : `- Agent settings not carried from ${them}, so the framework's defaults apply: ` +
          `${differ.map((n) => `${n} ${ours[n]} (${them}'s: ${theirSettings[n]})`).join(', ')}. ` +
          `The rest match: ${joinAll(names.filter((n) => !differ.includes(n)))}.`);
  }

  const mine = start.tools;
  if (!fork || !p || start.parentTools === undefined) {
    // A spawn isn't its caller, and with no parent there is nothing to set
    // the surface against: name all of it.
    lines.push(`- Tools: ${mine.length} available to this stream: ${joinAll(mine)}.` +
      (fork && p && start.parentTools === undefined
        ? " The parent stream's tools couldn't be read for comparison."
        : ''));
    return lines.join('\n');
  }
  const theirs = start.parentTools;
  const extra = mine.filter((n) => !theirs.includes(n));
  const missing = theirs.filter((n) => !mine.includes(n));
  if (extra.length === 0 && missing.length === 0) {
    lines.push(`- Tools: ${mine.length} available to this stream, the same set ${them} has now.`);
  } else {
    lines.push(`- Tools: ${mine.length} available to this stream. Compared with what ${them} has now, ${toolDifferences(extra, missing)}.`);
  }
  return lines.join('\n');
}

/** Structural subset of context-manager's Message — accepting this wider
 *  shape lets the helper be unit-tested without importing the framework. */
interface MinimalMessage {
  participant: string;
  content: ContentBlock[];
}

/**
 * Transform parent's compiled context into the fork stream's inherited view:
 *   1. find the assistant turn containing the fork tool_use with id === callToolUseId
 *   2. strip sibling subagent--fork tool_use blocks from that assistant turn
 *   3. find (or synthesise) the matching tool_result user turn; strip sibling
 *      fork tool_results from it; rewrite the matching one with intention framing
 *   4. drop every message after the matching tool_result (post-fork tail —
 *      peek calls, zombie returns, parent narrative — is the other major
 *      load-bearing source of parent-coherent evidence)
 *
 * Returns null if the matching tool_use cannot be located (e.g. compressed
 * away by the parent's strategy). Callers should fall back to wholesale
 * copy + synthetic intention-framed append in that case.
 */
export function materialiseStructuralFork(
  compiled: ReadonlyArray<MinimalMessage>,
  callToolUseId: string,
  forkName: string,
  forkTask: string,
  depth: number,
  maxDepth: number,
  orientation?: string,
): MinimalMessage[] | null {
  // 1. Locate the assistant turn whose content includes the fork tool_use we're materialising.
  let forkAssistantIdx = -1;
  for (let i = 0; i < compiled.length; i++) {
    const content = compiled[i].content;
    if (!Array.isArray(content)) continue;
    const hit = content.some(b =>
      isToolUseContent(b) && b.id === callToolUseId && b.name === 'subagent--fork',
    );
    if (hit) { forkAssistantIdx = i; break; }
  }
  if (forkAssistantIdx < 0) return null;

  const forkAssistantMsg = compiled[forkAssistantIdx];
  const siblingForkIds = new Set<string>();
  for (const b of forkAssistantMsg.content) {
    if (!isToolUseContent(b)) continue;
    if (b.name === 'subagent--fork' && b.id !== callToolUseId) {
      siblingForkIds.add(b.id);
    }
  }

  // 2. Find the next user-side message holding the matching tool_result (if any).
  // Stop searching at the next assistant turn — the matching tool_result must
  // be in the immediately following tool-result turn or it's not there yet.
  let matchingResultIdx = -1;
  for (let i = forkAssistantIdx + 1; i < compiled.length; i++) {
    const m = compiled[i];
    if (!Array.isArray(m.content)) continue;
    const hit = m.content.some(b => isToolResultContent(b) && b.toolUseId === callToolUseId);
    if (hit) { matchingResultIdx = i; break; }
    // If this message contains any tool_use, it's a new assistant turn — bail.
    if (m.content.some(b => isToolUseContent(b))) break;
  }

  const out: MinimalMessage[] = [];

  // Pre-fork history verbatim. Blocks are shared by reference everywhere in
  // the framework's context flow — no cloning here either.
  for (let i = 0; i < forkAssistantIdx; i++) {
    out.push({ participant: compiled[i].participant, content: compiled[i].content });
  }

  // Fork assistant turn with sibling fork tool_use blocks stripped. The
  // matching tool_use is excluded from siblingForkIds by construction, so
  // this filter always keeps at least one block. In XML tool mode every
  // call of a round carries the round's raw <function_calls> text (rawXml,
  // agent-framework 0.22.3), which membrane's anthropic-xml formatter
  // replays in place of the blocks, siblings included. So beside a removed
  // sibling, the calls kept drop it and are rendered from their blocks.
  const trimmedAssistantContent = forkAssistantMsg.content
    .filter(b => !(isToolUseContent(b) && b.name === 'subagent--fork' && siblingForkIds.has(b.id)))
    .map((b): ContentBlock => (siblingForkIds.size > 0 && isToolUseContent(b) && b.rawXml !== undefined ? withoutRawXml(b) : b));
  out.push({ participant: forkAssistantMsg.participant, content: trimmedAssistantContent });

  // Matching tool_result user turn — rewritten with intention framing; siblings stripped.
  const intentionFramed = buildIntentionFramedForkResult(forkName, forkTask, depth, maxDepth, orientation);
  if (matchingResultIdx >= 0) {
    const matchingMsg = compiled[matchingResultIdx];
    // The fork's own result leads its message, ahead of the turn's other
    // results: every message is capped and the cap keeps a message's
    // beginning, so a sibling's length can't push out the framed result's
    // head (its orientation). It's named as the framework names the results
    // it stores from a tool round (agent-framework 0.22.3 keeps toolName for
    // XML replay's <tool_name>): in XML tool mode a result carries no call id,
    // so its name is what tells it apart when it leads results whose calls
    // come first.
    const trimmedResultContent: ContentBlock[] = [{
      type: 'tool_result',
      toolUseId: callToolUseId,
      toolName: 'subagent--fork',
      content: intentionFramed,
    }];
    for (const b of matchingMsg.content) {
      if (isToolResultContent(b) && (siblingForkIds.has(b.toolUseId) || b.toolUseId === callToolUseId)) continue;
      trimmedResultContent.push(b);
    }
    out.push({ participant: matchingMsg.participant, content: trimmedResultContent });
  } else {
    // Parent's tool_result for this fork isn't in compiled context yet — synthesise it.
    out.push({
      participant: 'user',
      content: [{
        type: 'tool_result',
        toolUseId: callToolUseId,
        toolName: 'subagent--fork',
        content: intentionFramed,
      }],
    });
  }

  // Post-fork tail intentionally dropped.
  return out;
}

/** A block without the raw XML text of the round it was parsed from. */
function withoutRawXml<T extends { rawXml?: string }>(block: T): T {
  const copy = { ...block };
  delete copy.rawXml;
  return copy;
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

/** A cancel that wins the race with creating a run's agent leaves the
 *  creation running. The agent it gives is still the module's, so it's
 *  given back when it comes; a creation that fails leaves nothing. */
function giveBackWhenCreated(creating: Promise<{ cleanup: () => void }>, name: string): void {
  creating.then(
    (created) => {
      try {
        created.cleanup();
      } catch (err) {
        console.error(`[subagent] ${name}: giving back an agent created after its run was stopped failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    () => { /* a creation that failed leaves nothing to give back */ },
  );
}

export class SubagentModule implements Module {
  readonly name = 'subagent';

  private ctx: ModuleContext | null = null;
  private config: SubagentModuleConfig;
  private framework: AgentFramework | null = null;
  private maxDepth: number;
  private currentDepth: number;
  private asyncHandles = new Map<string, AsyncSubagentHandle>();
  private detachableHandles = new Map<string, DetachableHandle>();

  // Concurrency control — adaptive rate-limit-aware semaphore
  private configuredMaxConcurrent: number;   // User's ceiling
  private effectiveConcurrent: number;       // Current effective limit (may be reduced)
  /** The slots runs hold, one each. A slot is released once, however its
   *  run ends, so the count never falls below the runs holding one. */
  private heldSlots = new Set<object>();
  private waitQueue: Array<(slot: object) => void> = [];
  /** The slot each running subagent holds, for a zombie reclaim to release. */
  private slotOf = new WeakMap<ActiveSubagent, object>();
  private consecutiveSuccesses = 0;
  /** A rate limit has held the effective limit down, at or below the
   *  configured ceiling, and successes haven't yet brought it back up to it.
   *  A rate limit at an effective limit of 1 sets it too: the provider has
   *  just pushed back. While it holds, raising the ceiling leaves the
   *  effective limit to recover toward it, one step per three successes. */
  private throttled = false;
  private rateLimitCooldownMs = 30_000;      // Delay after rate limit before releasing next slot

  // Periodic zombie reaper. The pre-existing reaper only ran on-demand
  // inside acquireSlot, which meant zombies persisted indefinitely when
  // no new spawns happened — production traces showed a stale subagent
  // holding a slot for 7 days before a fresh spawn finally tripped the
  // demand-driven reap. This interval gives us a steady heartbeat reap
  // independent of spawn activity.
  private reaperTimer: ReturnType<typeof setInterval> | null = null;
  // Postmortem 2026-05-28 F3: bumped from 30_000ms. With the in-flight guard
  // closing the "request on wire" false-positive window, the threshold is
  // less load-bearing — but 30s was still tight enough that JIT pauses, GC,
  // or transient hiccups under heavy fleet load could trip the reaper on a
  // genuinely-progressing-but-pausing agent. 60s sweep cadence is also
  // friendlier when the fleet is already throttled by 429s (reaping under
  // throttling is counterproductive — the slot isn't stuck, it's queued).
  private static readonly REAPER_INTERVAL_MS = 60_000;

  // Prompt size guard
  private maxPromptTokens: number;

  // Per-subagent execution deadline
  private maxExecutionMs: number;

  // Retry on transient errors
  private maxRetries: number;

  /** Observable registry of active/recent subagents for TUI display. */
  readonly activeSubagents = new Map<string, ActiveSubagent>();

  /** Parent agent name for each subagent (for fleet tree reconstruction). */
  readonly parentMap = new Map<string, string>();

  // Stashed results from subagent--return tool calls, keyed by framework agent name
  private returnedResults = new Map<string, string | undefined>();

  // Live state for peek observability
  private liveSubagents = new Map<string, LiveSubagentState>();          // keyed by displayName
  private frameworkNameIndex = new Map<string, string>();                 // frameworkAgentName → displayName
  /** Each attempt's agent name → its run's display name, for the run's
   *  life, so a cancel reaches the children any attempt spawned, between
   *  attempts too. frameworkNameIndex holds only the live attempt. */
  private runOfAttempt = new Map<string, string>();
  private callIdIndex = new Map<string, string>();                        // toolCallId → displayName
  private streamSubscribers = new Map<string, Set<SubagentStreamCallback>>();  // displayName → callbacks
  private lastInputTokens = new Map<string, number>();  // displayName → context size: its latest call's prompt
  private cancellationHandles = new Map<string, { reject: (err: Error) => void }>();  // displayName → cancel
  private agentDepths = new Map<string, number>();  // framework agent name → fork depth

  constructor(config: SubagentModuleConfig = {}) {
    this.config = config;
    this.maxDepth = config.maxDepth ?? 3;
    this.currentDepth = config.currentDepth ?? 0;
    this.configuredMaxConcurrent = config.maxConcurrent ?? 5;
    this.effectiveConcurrent = this.configuredMaxConcurrent;
    this.maxPromptTokens = config.maxPromptTokens ?? 190_000;
    this.maxExecutionMs = config.maxExecutionMs ?? 600_000;
    this.maxRetries = config.maxRetries ?? 2;
  }

  /** Set the framework reference. Must be called after framework creation. */
  setFramework(framework: AgentFramework): void {
    this.framework = framework;

    // Subscribe to traces for peek observability + streaming fanout
    framework.onTrace((event: TraceEvent) => {
      // Events with agentName: inference lifecycle
      const agentName = 'agentName' in event ? (event as { agentName: string }).agentName : null;

      if (agentName) {
        const displayName = this.frameworkNameIndex.get(agentName);
        if (!displayName) return;
        const live = this.liveSubagents.get(displayName);
        if (!live) return;

        // Bump lastActivityAt on every addressed event. This is the staleness
        // metric the periodic reaper consults — without it, the only signal
        // is `startedAt`, which can't distinguish a 10-hour-but-progressing
        // subagent from one that has been silently stuck. Look up the
        // ActiveSubagent record by entry-key (a separate index, since
        // displayName isn't the activeSubagents key directly).
        const sa = this.runningEntry(displayName);
        if (sa) sa.lastActivityAt = Date.now();

        // inference:usage is emitted at runtime but not in the TraceEvent union — handle it first
        if ((event as { type: string }).type === 'inference:usage') {
          this.noteUsageSample(live, (event as { tokenUsage?: UsageSample }).tokenUsage);
          return;
        }

        // Postmortem 2026-05-28 F3: track the request-in-flight window.
        // `inference:started` and `inference:stream_resumed` dispatch a new
        // LLM request; the first `inference:tokens`, `inference:completed`,
        // `inference:failed`, or `inference:tool_calls_yielded` signals the
        // provider has responded. Between those, the reaper / peek predicates
        // treat `requestInFlightSince` as proof the agent isn't stuck.
        switch (event.type) {
          case 'inference:started':
            live.currentStream = '';
            live.pendingToolCalls = [];
            live.activeCallIds.clear();
            live.requestInFlightSince = Date.now();
            // A new stream: its usage samples count from zero.
            live.streamUsage = emptyUsage();
            this.emit(displayName, { type: 'inference:started' });
            break;
          case 'inference:tokens': {
            const content = (event as { content?: string }).content ?? '';
            live.currentStream += content;
            live.requestInFlightSince = undefined;
            this.emit(displayName, { type: 'tokens', content });
            break;
          }
          case 'inference:tool_calls_yielded': {
            const calls = (event as { calls?: Array<{ id: string; name: string; input?: unknown }> }).calls ?? [];
            live.pendingToolCalls = calls.map(c => ({ name: c.name, input: c.input }));
            live.currentStream = '';
            live.requestInFlightSince = undefined;
            // Index callIds so we can route tool:* events back
            for (const c of calls) {
              live.activeCallIds.add(c.id);
              this.callIdIndex.set(c.id, displayName);
            }
            this.emit(displayName, { type: 'tool_calls', calls: calls.map(c => ({ name: c.name, input: c.input })) });
            break;
          }
          case 'inference:stream_resumed':
            live.currentStream = '';
            live.pendingToolCalls = [];
            live.requestInFlightSince = Date.now();
            this.emit(displayName, { type: 'stream_resumed' });
            break;
          case 'inference:completed': {
            this.noteUsageSample(live, (event as { tokenUsage?: UsageSample }).tokenUsage);
            live.requestInFlightSince = undefined;
            this.emit(displayName, { type: 'inference:completed' });
            break;
          }
          case 'inference:failed': {
            live.requestInFlightSince = undefined;
            this.emit(displayName, { type: 'inference:failed', error: traceError(event) });
            break;
          }
          // The stream's other ends (state/turn-trace.ts), passed on so the
          // peek panel shows each. requestInFlightSince stays as it was.
          case 'inference:turn_ended':
            this.emit(displayName, { type: 'inference:turn_ended' });
            break;
          case 'inference:aborted': {
            const reason = (event as { reason?: unknown }).reason;
            this.emit(displayName, {
              type: 'inference:aborted',
              ...(typeof reason === 'string' && reason !== '' ? { reason } : {}),
            });
            break;
          }
          case 'inference:exhausted':
            this.emit(displayName, { type: 'inference:exhausted', error: traceError(event) });
            break;
        }
        return;
      }

      // Events with callId: tool lifecycle (no agentName)
      const callId = 'callId' in event ? (event as { callId: string }).callId : null;
      if (callId) {
        const displayName = this.callIdIndex.get(callId);
        if (!displayName) return;

        switch (event.type) {
          case 'tool:started': {
            const e = event as { tool: string; input?: unknown };
            this.emit(displayName, { type: 'tool:started', tool: e.tool, input: e.input });
            break;
          }
          case 'tool:completed': {
            const e = event as { tool: string; durationMs: number };
            this.callIdIndex.delete(callId);
            this.emit(displayName, { type: 'tool:completed', tool: e.tool, durationMs: e.durationMs });
            break;
          }
          case 'tool:failed': {
            const e = event as { tool: string; error: string };
            this.callIdIndex.delete(callId);
            this.emit(displayName, { type: 'tool:failed', tool: e.tool, error: e.error });
            break;
          }
        }
      }
    });
  }

  private getFramework(): AgentFramework {
    if (!this.framework) throw new Error('SubagentModule: framework not set. Call setFramework() after creating the framework.');
    return this.framework;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    // Restore in-memory state from Chronicle (for session restore / branch switch)
    this.restoreFromStore();

    // Periodic zombie reap independent of acquireSlot demand. See reaperTimer
    // comment above. Wrapped in try/catch — a reap-loop bug must not crash
    // the module.
    this.reaperTimer = setInterval(() => {
      try {
        const reclaimed = this.reclaimZombieSlots();
        if (reclaimed > 0) {
          // Persist updated statuses so chronicle reflects the reap.
          this.persistState();
        }
      } catch (error) {
        console.error('[subagent] periodic reaper error:', error);
      }
    }, SubagentModule.REAPER_INTERVAL_MS);
    // Don't keep the event loop alive just for the reaper.
    if (typeof (this.reaperTimer as { unref?: () => void }).unref === 'function') {
      (this.reaperTimer as { unref: () => void }).unref();
    }
  }

  async stop(): Promise<void> {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
    this.ctx = null;
  }

  /**
   * Persist subagent registry to Chronicle module state.
   * Called after each lifecycle transition so branch ops get correct fleet.
   */
  private persistState(): void {
    if (!this.ctx) return;
    const agents: Record<string, PersistedSubagent> = {};
    for (const [key, sa] of this.activeSubagents) {
      agents[key] = {
        name: sa.name,
        type: sa.type,
        task: sa.task,
        status: sa.status,
        startedAt: sa.startedAt,
        lastActivityAt: sa.lastActivityAt,
        completedAt: sa.completedAt,
        toolCallsCount: sa.toolCallsCount,
        findingsCount: sa.findingsCount,
        statusMessage: sa.statusMessage,
        parent: this.parentMap.get(sa.name),
      };
    }
    this.ctx.setState({ agents });
  }

  /**
   * Restore activeSubagents + parentMap from Chronicle module state.
   * Marks any 'running' entries as 'cancelled' since the actual processes are gone.
   * Postmortem 2026-05-28 P1 #4: use 'cancelled' (not 'completed') so the
   * operator can tell host-interruption from genuine completion in the TUI.
   */
  restoreFromStore(): void {
    if (!this.ctx) return;
    const persisted = this.ctx.getState<{ agents?: Record<string, PersistedSubagent> }>();
    if (!persisted?.agents) return;

    this.activeSubagents.clear();
    this.parentMap.clear();

    for (const [key, pa] of Object.entries(persisted.agents)) {
      const sa: ActiveSubagent = {
        name: pa.name,
        type: pa.type,
        task: pa.task,
        status: pa.status === 'running' ? 'cancelled' : pa.status,
        startedAt: pa.startedAt,
        // Fallback for records from versions before lastActivityAt was added:
        // treat them as if their last activity was their start time. Affects
        // only the staleness heuristic, which will simply flag them as stale
        // immediately on next reaper sweep — correct, because by definition
        // the process owning them is gone.
        lastActivityAt: pa.lastActivityAt ?? pa.startedAt,
        completedAt: pa.completedAt ?? (pa.status === 'running' ? Date.now() : undefined),
        toolCallsCount: pa.toolCallsCount,
        findingsCount: pa.findingsCount,
        statusMessage: pa.status === 'running' ? 'interrupted (branch/session switch)' : pa.statusMessage,
      };
      this.activeSubagents.set(key, sa);
      if (pa.parent) {
        this.parentMap.set(pa.name, pa.parent);
      }
    }
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'spawn',
        description: 'Spawn a fresh subagent with a system prompt and task. Async by default — returns immediately and delivers results as a message. Pass sync:true to block until completion.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short name for the subagent' },
            systemPrompt: { type: 'string', description: 'System prompt for the subagent' },
            task: { type: 'string', description: 'The task for the subagent to perform' },
            model: { type: 'string', description: 'Model override (optional)' },
            maxTokens: { type: 'number', description: 'Max output tokens per inference (optional). Defaults to the recipe-level subagent default, else the parent agent\'s maxTokens.' },
            tools: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tool names the subagent can use (default: inherit the caller\'s allowed tools). An explicit list can only narrow the caller\'s tools. To give the subagent a utility, list `utils` and the utility\'s own name (module--name). Note: subagent--return is always included automatically.',
            },
            sync: { type: 'boolean', description: 'If true, block until subagent completes (default: false)' },
            timeoutMs: { type: 'number', description: `Milliseconds. A sync task still running then moves to the background and delivers its result as a message when it ends (default ${this.maxExecutionMs}). An async task is stopped once it has run that long, counted from when it starts after any wait for a concurrency slot, retries included; async tasks have no limit by default, so set one only for a hard deadline.` },
          },
          required: ['name', 'systemPrompt', 'task'],
        },
      },
      {
        name: 'fork',
        description:
          "Fork the current conversation into two parallel streams that share all memory of what you've done so far. " +
          "Both streams are continuations of the same self — one carries on with the broader agenda, the other focuses " +
          "exclusively on a new intention (the `task`). The tool_result you receive identifies which stream you are. " +
          "Async by default; pass sync:true to block until completion.",
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short name for the forked stream' },
            task: { type: 'string', description: 'The intention this fork stream should pursue' },
            systemPrompt: { type: 'string', description: 'Override system prompt (optional, defaults to parent)' },
            model: { type: 'string', description: 'Model override (optional)' },
            maxTokens: { type: 'number', description: 'Max output tokens per inference (optional). Defaults to the recipe-level subagent default, else the parent agent\'s maxTokens.' },
            sync: { type: 'boolean', description: 'If true, block until fork completes (default: false)' },
            timeoutMs: { type: 'number', description: `Milliseconds. A sync task still running then moves to the background and delivers its result as a message when it ends (default ${this.maxExecutionMs}). An async task is stopped once it has run that long, counted from when it starts after any wait for a concurrency slot, retries included; async tasks have no limit by default, so set one only for a hard deadline.` },
          },
          required: ['name', 'task'],
        },
      },
      {
        name: 'hud',
        description: 'Toggle the subagent fleet HUD overlay. When enabled, a compact fleet status summary is injected before each inference.',
        inputSchema: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean', description: 'Enable or disable the fleet HUD' },
          },
          required: ['enabled'],
        },
      },
      {
        name: 'concurrency',
        description: 'View or adjust subagent concurrency. Omit maxConcurrent to just view status. Concurrency auto-adapts to rate limits (halves on 429, recovers after successes).',
        inputSchema: {
          type: 'object',
          properties: {
            maxConcurrent: { type: 'number', description: 'Set new concurrency ceiling (min 1)' },
          },
        },
      },
      {
        name: 'peek',
        description: 'Peek at a running subagent\'s live state: status, elapsed time, message count, last message snippet, current streaming output, and pending tool calls. Omit name to peek at all running subagents.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Subagent name to peek at (omit for all)' },
          },
        },
      },
      {
        name: 'return',
        description: 'Return results from a fork or spawn back to the parent agent. Call this when you have completed your task. Your result text will be delivered to the parent as the tool result of the fork/spawn call. This ends your execution.',
        inputSchema: {
          type: 'object',
          properties: {
            result: { type: 'string', description: 'Your findings, summary, or results to return to the parent' },
          },
          required: ['result'],
        },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    const caller = call.callerAgentName;
    const input = inputsOf(call.input);
    if (input === null) {
      return Object.hasOwn(NOT_DONE, call.name)
        ? { success: false, isError: true, error: `${NOT_DONE[call.name]}: the input must be an object of named inputs, not ${shown(call.input)}.` }
        : unknownToolResult(this, call.name);
    }
    const refused = this.inputRefusal(call.name, input);
    if (refused) return refused;
    switch (call.name) {
      case 'spawn':
        return this.handleSpawn(input as unknown as SpawnInput, caller);
      case 'fork':
        return this.handleFork(input as unknown as ForkInput, caller, call.id);
      case 'hud':
        return this.handleHud(input as { enabled: boolean });
      case 'concurrency':
        return this.handleConcurrency(input as { maxConcurrent?: number });
      case 'peek':
        return this.handlePeek(input as { name?: string }, caller);
      case 'return': {
        // Stash the result keyed by the tool call ID. The completion path
        // in runSpawn/runFork will pick it up via the callIdIndex → displayName.
        const result = input.result as string | undefined;
        // Find which subagent is calling this via the callIdIndex
        const callerName = this.callIdIndex.get(call.id);
        if (callerName) {
          this.returnedResults.set(callerName, result);
        }
        return { success: true, data: 'Result received.', endTurn: true };
      }
      default:
        return unknownToolResult(this, call.name);
    }
  }

  /** The refusal for a call whose inputs aren't of the types its tool's
   *  schema declares, naming every problem with its value or what to give;
   *  null when they are, or when the module has no such tool. An input not
   *  given is a problem where the schema requires it, apart from return's
   *  result, whose absence the handler reads as the subagent's last words.
   *  Ranges, and inputs a schema doesn't declare, are left as they are. */
  private inputRefusal(tool: string, input: Record<string, unknown>): ToolResult | null {
    const schema = this.getTools().find((t) => t.name === tool)?.inputSchema as
      | { properties: Record<string, { type: DeclaredType }>; required?: string[] }
      | undefined;
    if (!schema) return null;
    const problems: string[] = [];
    for (const [key, declared] of Object.entries(schema.properties)) {
      const value = input[key];
      if (value === undefined) {
        if (schema.required?.includes(key) && !(tool === 'return' && key === 'result')) {
          const give = GIVE_MISSING[tool]?.[key];
          problems.push(`${key} is missing${give ? `: ${give}` : ''}`);
        }
      } else if (!isDeclaredType(value, declared.type)) {
        problems.push(`${key} must be ${TYPE_WORDS[declared.type]}, not ${shown(value)}`);
      }
    }
    return problems.length === 0
      ? null
      : { success: false, isError: true, error: `${NOT_DONE[tool]}: ${problems.join('; ')}.` };
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    // When an async subagent completes, deliverAsyncResult() pushes an
    // inference-request event.  Convert it into a proper requestInference
    // response so the framework (and EventGate) can route it normally.
    if (event.type === 'inference-request' && 'source' in event && event.source === 'subagent') {
      return { requestInference: [(event as { agentName: string }).agentName] };
    }
    return {};
  }

  async gatherContext(agentName: string): Promise<import('@animalabs/context-manager').ContextInjection[]> {
    if (!this.ctx) return [];
    const persisted = this.ctx.getState<{ hudEnabled?: boolean }>() ?? {};
    if (!persisted.hudEnabled) return [];

    // Postmortem 2026-05-28 P3 #8: scope the Fleet Status HUD to the
    // calling agent's descendants. Pre-fix the HUD injected the whole
    // fleet roster every turn, which (a) encouraged peer-coordination
    // anti-patterns and (b) amplified false zombie/failed flags across
    // the orchestrator's context.
    const allowed = this.getDescendantDisplayNames(agentName);

    const lines: string[] = [];
    for (const [, sa] of this.activeSubagents) {
      if (!allowed.has(sa.name)) continue;
      const elapsed = sa.completedAt
        ? Math.floor((sa.completedAt - sa.startedAt) / 1000)
        : Math.floor((Date.now() - sa.startedAt) / 1000);
      const parent = this.parentMap.get(sa.name) ?? 'agent';
      const parentShort = parent.replace(/^(spawn|fork)-/, '').replace(/-d\d+-\d+$/, '').replace(/-retry\d+$/, '');
      const task = sa.task.length > 50 ? sa.task.slice(0, 47) + '...' : sa.task;
      lines.push(`  ${sa.name} [${sa.type}] ${sa.status} ${elapsed}s ${sa.toolCallsCount}calls parent:${parentShort} "${task}"`);
    }

    // Also show async handles still running, but only those owned by the
    // caller (or its descendants — but async handles aren't parent-indexed
    // separately, so conservatively skip them when scoping is in effect
    // and the caller has no descendants to begin with).
    for (const [name] of this.asyncHandles) {
      if (!allowed.has(name)) continue;
      if (!this.activeSubagents.has(name) && !this.activeSubagents.has(`spawn-${name}`)) {
        lines.push(`  ${name} [async] pending`);
      }
    }

    if (lines.length === 0) return [];

    return [{
      namespace: 'subagent-fleet',
      position: 'afterUser',
      content: [{ type: 'text', text: `[Fleet Status]\n${lines.join('\n')}` }],
    }];
  }

  // =========================================================================
  // Concurrency Control (adaptive, rate-limit-aware)
  // =========================================================================

  /**
   * Acquire a concurrency slot. Returns how long the caller waited (0 = immediate).
   * Throws a SubagentFailure if the slot is not acquired within
   * `slotTimeoutMs`, saying how to call `kind` again, and rejects with the
   * run's SubagentTerminated if `cancelled`, the run's cancel from
   * cancelFor, fires while it waits.
   */
  private async acquireSlot(
    kind: 'spawn' | 'fork',
    slotTimeoutMs = SLOT_TIMEOUT_MS,
    /** The run's cancel (cancelFor): it takes a caller still waiting out of
     *  the queue. */
    cancelled?: Promise<never>,
    /** Set synchronously, before the first await, when the caller has to
     *  queue: run*() reaches this call without awaiting, so handle*() can
     *  say in its receipt whether the launch is starting or waiting for a
     *  slot. */
    ticket?: { queued: boolean },
  ): Promise<{ waitedMs: number; slot: object }> {
    if (this.activeConcurrent < this.effectiveConcurrent) return { waitedMs: 0, slot: this.takeSlot() };

    // Before queueing, try to reclaim slots from zombie subagents. What a
    // reclaim frees goes to the spawns already waiting first.
    this.reclaimZombieSlots();
    if (this.activeConcurrent < this.effectiveConcurrent) return { waitedMs: 0, slot: this.takeSlot() };

    if (ticket) ticket.queued = true;
    const startWait = Date.now();
    return new Promise<{ waitedMs: number; slot: object }>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Last-chance zombie reclamation before failing. What it frees goes
        // to the queue in order, this spawn included.
        this.reclaimZombieSlots();
        const idx = this.waitQueue.indexOf(onSlot);
        if (idx < 0) return; // a freed slot has reached it
        this.waitQueue.splice(idx, 1);

        // Surface which subagents currently hold the slots, with silence
        // and total runtime. Without this the caller only sees "5/5 in
        // use" and has no signal for which to cancel. In production this
        // lack of detail meant the parent agent couldn't self-rescue —
        // it had to wait days for the demand-driven reaper to fire on
        // its own.
        const holders = this.describeSlotHolders();
        const holderLines = holders.length > 0
          ? `\nSlots held by:\n${holders.map(h => `  - ${h}`).join('\n')}`
          : '';
        const others = this.waitQueue.length;
        const holder = holders.length > 0 ? 'one of the subagents below' : 'a running subagent';
        // While `throttled` holds, as it does after a rate limit at a limit
        // of 1 too, a higher ceiling leaves the limit where it is
        // (setConcurrency), so only waiting helps. Below the ceiling, the
        // concurrency tool's note says how the limit recovers.
        const { note } = this.getConcurrencyStatus();
        const remedy = this.throttled
          ? `${note ?? "A rate limit was hit at this limit, so raising it wouldn't take effect at once."} ` +
            `Wait for ${holder} to finish, then call subagent--${kind} again.`
          : `Wait for ${holder} to finish, or raise the limit with subagent--concurrency, then call subagent--${kind} again.`;

        reject(new SubagentFailure(
          `no concurrency slot opened within ${duration(slotTimeoutMs)} (${this.activeConcurrent} running against ` +
          `a limit of ${this.effectiveConcurrent}, ${others} other${others === 1 ? '' : 's'} waiting)`,
          `${remedy} Start no more than ${this.effectiveConcurrent} at a time here.` +
          holderLines,
        ));
      }, slotTimeoutMs);

      const onSlot = (slot: object) => {
        clearTimeout(timer);
        resolve({ waitedMs: Date.now() - startWait, slot });
      };

      this.waitQueue.push(onSlot);
      // A cancel while it waits takes it out of the queue. One that comes
      // after a slot reached it ends the run in its setup, before its
      // attempt starts, or in the attempt's race once it has.
      cancelled?.catch((err: unknown) => {
        const idx = this.waitQueue.indexOf(onSlot);
        if (idx < 0) return;
        this.waitQueue.splice(idx, 1);
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /**
   * Summarize subagents currently holding concurrency slots. Used to enrich
   * the slot-acquisition timeout error so the calling agent can decide
   * which stale forks to cancel rather than helplessly waiting on the
   * demand-driven reaper.
   */
  private describeSlotHolders(): string[] {
    const lines: string[] = [];
    const now = Date.now();
    for (const sa of this.activeSubagents.values()) {
      if (sa.status !== 'running') continue;
      const silentS = Math.floor((now - sa.lastActivityAt) / 1000);
      const runtimeS = Math.floor((now - sa.startedAt) / 1000);
      const live = this.liveSubagents.get(sa.name);
      const streamState = live?.currentStream ? 'streaming' :
        live?.pendingToolCalls?.length ? `awaiting ${live.pendingToolCalls.length} tool(s)` :
        'idle';
      lines.push(
        `${sa.name} [${sa.type}] runtime=${runtimeS}s silent=${silentS}s ${streamState}`
      );
    }
    return lines;
  }

  /**
   * Scan for zombie subagents and force-release their concurrency slots.
   * A zombie is a subagent in 'running' status whose `lastActivityAt` is
   * older than ZOMBIE_THRESHOLD_MS AND has no active inference stream AND
   * no pending tool calls. Using `lastActivityAt` instead of `startedAt`
   * lets us distinguish a 10-hour-but-progressing subagent from one that
   * has been silently stuck for hours — the latter is what kept locking
   * concurrency slots for days in production.
   *
   * Returns the number of slots reclaimed.
   */
  private reclaimZombieSlots(): number {
    let reclaimed = 0;

    for (const [displayName, live] of this.liveSubagents) {
      const entry = this.runningEntry(displayName);
      if (!entry) continue;

      const silentMs = Date.now() - entry.lastActivityAt;
      // Postmortem 2026-05-28 F3: `!live.requestInFlightSince` protects the
      // "request dispatched, awaiting first token" window. Before this, the
      // guard `!currentStream && pendingToolCalls.length===0` was true while
      // the next round's request was on the wire, and the reaper killed
      // progressing agents mid-request. Forensic signature in production:
      // last message in store is an unconsumed `tool_result`.
      const isZombie = silentMs > ZOMBIE_THRESHOLD_MS
        && !live.currentStream
        && live.pendingToolCalls.length === 0
        && !live.requestInFlightSince;

      if (isZombie) {
        const elapsedTotal = Date.now() - entry.startedAt;
        console.error(
          `[subagent] Reclaiming zombie slot: "${displayName}" ` +
          `(silent for ${(silentMs / 1000).toFixed(0)}s, total runtime ` +
          `${(elapsedTotal / 1000).toFixed(0)}s, no active stream)`
        );

        // Cancel the zombie's framework agent
        try {
          const agent = this.getFramework().getAgent(live.frameworkAgentName);
          if (agent) this.stopRun(agent);
        } catch { /* best-effort */ }

        // Cancel via cancellation handle (unblocks the Promise.race in runSpawn/runFork)
        const handle = this.cancellationHandles.get(displayName);
        if (handle) {
          const partial = live.currentStream ?? '';
          handle.reject(new SubagentTerminated(
            'zombie',
            partial,
            `Zombie detected: "${displayName}" silent for ${(silentMs / 1000).toFixed(0)}s ` +
            `(total runtime ${(elapsedTotal / 1000).toFixed(0)}s). Slot reclaimed.`,
          ));
          this.cancellationHandles.delete(displayName);
        }

        // Postmortem 2026-05-28 P1 #4: zombie reclaim is terminal-but-benign,
        // not a fault. Land on 'cancelled' so the TUI and the reducer-driven
        // web tree agree (the reducer maps the trace-side `inference:aborted`
        // emitted by the cancellation handle to 'cancelled' as well).
        entry.status = 'cancelled';
        entry.completedAt = Date.now();
        entry.statusMessage = 'zombie — slot reclaimed';

        // Release the zombie's own slot. Its run's finally releases the same
        // slot, which by then is free, so nothing is released twice.
        const slot = this.slotOf.get(entry);
        if (slot) this.releaseSlot(slot);
        reclaimed++;
      }
    }

    return reclaimed;
  }

  /** The running entry for a display name. Spawn and fork entries are
   *  keyed differently and stay after they end, so a finished entry of the
   *  other type can share the name; the first match by name alone could be
   *  that one. */
  private runningEntry(displayName: string): ActiveSubagent | undefined {
    for (const e of this.activeSubagents.values()) {
      if (e.name === displayName && e.status === 'running') return e;
    }
    return undefined;
  }

  private get activeConcurrent(): number {
    return this.heldSlots.size;
  }

  private takeSlot(): object {
    const slot = {};
    this.heldSlots.add(slot);
    return slot;
  }

  /** Release `slot`, if it's still held, and let waiting spawns start. */
  private releaseSlot(slot: object): void {
    if (!this.heldSlots.delete(slot)) return; // a zombie reclaim released it already
    this.admitWaiters();
  }

  /** Start waiting spawns, in order, while the limit allows. Called wherever
   *  a slot frees or the limit rises. */
  private admitWaiters(): void {
    while (this.waitQueue.length > 0 && this.activeConcurrent < this.effectiveConcurrent) {
      this.waitQueue.shift()!(this.takeSlot());
    }
  }

  /** Stop a run: cancel its live stream and set its agent idle.
   *  agent-framework 0.22.3's Agent.cancelStream cancels a stream wherever
   *  the agent holds one, at a tool boundary too, and the framework records
   *  the stop as a deliberate cancel, not a failure. A tool call already
   *  running isn't stopped: it finishes, and the framework drops its
   *  result. */
  private stopRun(agent: Agent): void {
    agent.cancelStream();
  }

  /** Format a concurrency notice for tool results (empty string if no wait). */
  private concurrencyNotice(waitedMs: number): string {
    if (waitedMs <= 0) return '';
    const secs = (waitedMs / 1000).toFixed(1);
    return `[Concurrency notice: this agent waited ${secs}s for a slot ` +
      `(${this.effectiveConcurrent} concurrent limit). ` +
      `To avoid delays, limit parallel forks/spawns to ${this.effectiveConcurrent}.]\n\n`;
  }

  /** Call on successful subagent completion — gradually recovers concurrency. */
  private onSubagentSuccess(): void {
    this.consecutiveSuccesses++;
    // After 3 consecutive successes, try increasing by 1
    if (this.consecutiveSuccesses >= 3 && this.effectiveConcurrent < this.configuredMaxConcurrent) {
      this.effectiveConcurrent++;
      this.consecutiveSuccesses = 0;
    }
    if (this.effectiveConcurrent >= this.configuredMaxConcurrent) this.throttled = false;
    this.admitWaiters();
  }

  /** Call on rate limit error — halves concurrency, and gives the cooldown
   *  the run then waits, keeping its slot. A run with a deadline cools down
   *  no later than its deadline; the halving holds either way. */
  private onRateLimitHit(deadline?: number): number {
    const prev = this.effectiveConcurrent;
    this.effectiveConcurrent = Math.max(1, Math.floor(this.effectiveConcurrent / 2));
    this.consecutiveSuccesses = 0;
    this.throttled = true;
    const coolMs = deadline === undefined
      ? this.rateLimitCooldownMs
      : Math.max(0, Math.min(this.rateLimitCooldownMs, deadline - Date.now()));
    console.error(
      `[subagent] Rate limit hit — concurrency ${prev} → ${this.effectiveConcurrent}, ` +
      `cooling down ${coolMs}ms`
    );
    return coolMs;
  }

  /** Wait `ms`, unless the run's cancel comes first; then its error. */
  private async waitOrStop(ms: number, cancelled: Promise<never>): Promise<SubagentTerminated | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([new Promise((resolve) => { timer = setTimeout(resolve, ms); }), cancelled]);
      return null;
    } catch (err) {
      if (err instanceof SubagentTerminated) return err;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** A cancel for one run, by its name, from before the run queues. A name
   *  means one live run (nameInUse refuses a second), so the name finds it.
   *  cancelSubagent and the zombie reaper reject it and drop it, and the
   *  run's end drops it (dispose). Everything the run waits on races it:
   *  the slot queue, an attempt's setup (creating the agent, a fork's read
   *  of its parent's context, compiling its prompt), each attempt's race and
   *  the waits between attempts. A cancel that lands just as compiling
   *  settles, once the race has taken compile's result, is thrown before the
   *  attempt starts (throwIfFired). */
  private cancelFor(name: string): { promise: Promise<never>; throwIfFired(): void; dispose(): void } {
    let reject!: (err: Error) => void;
    let fired: Error | null = null;
    const promise = new Promise<never>((_, r) => { reject = r; });
    promise.catch(() => { /* raced wherever the run waits; one may be idle */ });
    const handle = { reject: (err: Error) => { fired ??= err; reject(err); } };
    this.cancellationHandles.set(name, handle);
    return {
      promise,
      throwIfFired: () => { if (fired) throw fired; },
      // The name is this run's until its result has come back, which is
      // after this (nameInUse), so the handle under it is this run's or
      // none, and deleting it can't drop another run's cancel.
      dispose: () => { this.cancellationHandles.delete(name); },
    };
  }

  /** End a run a cancel or the reaper stopped: 'cancelled', with what it
   *  had said so far. `started` says whether an attempt reached its run
   *  (failedRun), so a stop before that says nothing ran, as one while it
   *  queued does (endQueued). */
  private endTerminated(name: string, entry: ActiveSubagent, err: SubagentTerminated, waitedMs: number, started: boolean): SubagentResult {
    // Postmortem 2026-05-28 P1 #4: terminal-but-benign — 'cancelled', not
    // 'completed'. Before this, the TUI subagent list rendered these as
    // "done" while the reducer-driven web tree rendered them red.
    entry.status = 'cancelled';
    entry.completedAt = Date.now();
    entry.statusMessage = err.reason;
    const notice = this.concurrencyNotice(waitedMs);
    const output = err.partialOutput || (started ? '(no output yet)' : '(no output: it was stopped before its run began, so nothing ran)');
    const summary = notice + `[${stopLabel(err.reason)}] ` + output;
    this.emit(name, { type: 'done', summary, lastInputTokens: this.lastInputTokens.get(name) });
    return { summary, findings: [], issues: [], toolCallsCount: entry.toolCallsCount };
  }

  /** What a run under a name starts from, as it queues: no context size an
   *  earlier run under the name reported, and its own parent link (or none),
   *  so a parent's cancel reaches it while it waits. Each attempt clears
   *  the `return` stash as it starts. nameInUse means no other run holds
   *  the name. */
  private claimName(name: string, parent: string | undefined): void {
    this.lastInputTokens.delete(name);
    if (parent) this.parentMap.set(name, parent);
    else this.parentMap.delete(name);
  }

  /** Drop a run's attempts from the index as the run ends: nameInUse keeps
   *  its name until its result has come back, after this, so every entry
   *  under the name is this run's. */
  private forgetAttempts(name: string): void {
    for (const [agentName, run] of this.runOfAttempt) if (run === name) this.runOfAttempt.delete(agentName);
  }

  /** End a run cancelled while it waited for a slot: it never started. */
  private endQueued(name: string, err: SubagentTerminated): SubagentResult {
    const summary = `[${stopLabel(err.reason)}] (no output: it was still waiting for a concurrency slot, and never started)`;
    this.emit(name, { type: 'done', summary });
    return { summary, findings: [], issues: [], toolCallsCount: 0 };
  }

  /** The words the classifiers read: the failure's message without the
   *  ephemeral agent's name, which the framework quotes in its own messages
   *  ("Ephemeral agent \"spawn-migrate-…\" failed to start inference …") and
   *  which holds the name the agent chose. agent-framework 0.22.3 gives an
   *  ephemeral run's failure no other structure to read: it rejects with an
   *  Error carrying the text, apart from its ProviderWaitNotSleptError,
   *  which isUnsleptProviderWait reads by name. */
  private classifiedText(err: Error, agentName?: string): string {
    const text = agentName ? err.message.split(agentName).join('') : err.message;
    return text.toLowerCase();
  }

  private isRateLimitError(err: unknown, agentName?: string): boolean {
    if (!(err instanceof Error)) return false;
    const msg = this.classifiedText(err, agentName);
    // Rate-limit phrases, not words: "rate" with no letter before it and
    // "limit" or "exceeded" after it, so "generate", "moderate" or "rated"
    // isn't a rate limit and "upstream_rate_limit_exceeded" is; "too many
    // requests", not "too many", which also opens "too many tokens"; and
    // the status code as a whole number, so a duration such as 14290ms
    // isn't one.
    return /(?<![a-z])rate[\s_-]?(limit|exceeded)/.test(msg)
      || /\b429\b/.test(msg)
      || /too many (\w+ )?requests/.test(msg);
  }

  /** The framework ended the run rather than sleep the stated wait of a
   *  retryable failure: one longer than an ephemeral run sleeps, or one it
   *  can't read as a number. Either way the provider asked for a wait the
   *  run won't sit out, so a restart would only call it again too soon.
   *  agent-framework 0.22.3 rejects such a run with its
   *  `ProviderWaitNotSleptError`, read here by its name, which a second copy
   *  of the package gives its own class too. */
  private isUnsleptProviderWait(err: Error): boolean {
    return err.name === 'ProviderWaitNotSleptError';
  }

  /** Transient = worth retrying the whole subagent from scratch. */
  private isTransientError(err: Error, agentName?: string): boolean {
    if (this.isUnsleptProviderWait(err)) return false;
    const msg = this.classifiedText(err, agentName);
    return (
      msg.includes('timeout') ||
      msg.includes('idle') ||
      msg.includes('econnreset') ||
      msg.includes('socket hang up') ||
      msg.includes('network') ||
      msg.includes('stream aborted') ||
      msg.includes('overloaded') ||
      // Whole numbers, so a duration such as 15000ms isn't an HTTP 500.
      /\b(500|502|503|529)\b/.test(msg) ||
      this.isRateLimitError(err, agentName)
    );
  }

  /** Set the concurrency ceiling at runtime. The effective limit follows it,
   *  up or down, except that while a rate limit's halving holds, a higher
   *  ceiling leaves the effective limit to recover toward it after
   *  successes. Spawns waiting for a slot start as the limit allows. */
  setConcurrency(n: number): void {
    this.configuredMaxConcurrent = Math.max(1, n);
    if (!this.throttled || this.effectiveConcurrent > this.configuredMaxConcurrent) {
      this.effectiveConcurrent = this.configuredMaxConcurrent;
    }
    if (this.effectiveConcurrent >= this.configuredMaxConcurrent) this.throttled = false;
    this.admitWaiters();
  }

  /** Get current concurrency status for observability. */
  getConcurrencyStatus(): { configured: number; effective: number; active: number; queued: number; note?: string } {
    const held = this.throttled && this.effectiveConcurrent < this.configuredMaxConcurrent;
    return {
      configured: this.configuredMaxConcurrent,
      effective: this.effectiveConcurrent,
      active: this.activeConcurrent,
      queued: this.waitQueue.length,
      ...(held ? {
        note: `A rate limit holds the limit at ${this.effectiveConcurrent}. It rises by one after every three ` +
          `subagents that finish without error, up to ${this.configuredMaxConcurrent}.`,
      } : {}),
    };
  }

  // =========================================================================
  // Subagent Cancellation
  // =========================================================================

  /**
   * Force-stop a subagent: one running, between attempts, or still waiting
   * for a concurrency slot. Stops its live stream, if it has one, and makes
   * runSpawn/runFork return a "[Stopped by user]" result. Returns true if
   * the subagent was found and cancelled.
   */
  cancelSubagent(displayName: string): boolean {
    const found = this.cancellationHandles.has(displayName);
    this.stopTree(displayName);
    return found;
  }

  /** Whether the framework agent named is a subagent's live attempt: an
   *  operator's interrupt takes its turn to the follower before cancelAll
   *  stops its run (interruptSubagents). */
  isSubagentAgent(frameworkAgentName: string): boolean {
    return this.frameworkNameIndex.has(frameworkAgentName);
  }

  /**
   * Cancel all running subagents (e.g. on user Esc).
   * Returns the number of subagents cancelled, each once: a child stopped
   * through its parent counts there, and its own name then finds nothing.
   */
  cancelAll(): number {
    let count = 0;
    for (const name of [...this.cancellationHandles.keys()]) count += this.stopTree(name);
    return count;
  }

  /** Stop the run named, its children first (bottom-up, so their results
   *  propagate before the parent's), and return how many runs this stopped. */
  private stopTree(displayName: string): number {
    let stopped = 0;
    for (const child of this.childrenOf(displayName)) stopped += this.stopTree(child);

    const handle = this.cancellationHandles.get(displayName);
    if (!handle) return stopped;

    // Abort the active inference stream (cancels the HTTP request)
    const live = this.liveSubagents.get(displayName);
    const partial = live?.currentStream ?? '';
    if (live) {
      try {
        const agent = this.getFramework().getAgent(live.frameworkAgentName);
        if (agent) this.stopRun(agent);
      } catch { /* best-effort */ }
    }

    // End the run wherever it waits: the slot queue, an attempt or a back-off
    handle.reject(new SubagentTerminated('cancelled', partial, `Subagent "${displayName}" cancelled by user`));
    this.cancellationHandles.delete(displayName);
    return stopped + 1;
  }

  /**
   * Compute the set of descendant display names rooted at the given framework
   * agent name. Walks `parentMap` (displayName → callerFrameworkAgentName)
   * top-down. Excludes the root itself.
   *
   * Postmortem 2026-05-28 P3 #8: used by peek() and gatherContext() to
   * scope observability surfaces to the caller's subtree. Prevents peer
   * agents from inspecting each other and saturating context with
   * cross-fleet roster information they have no legitimate use for.
   */
  private getDescendantDisplayNames(rootFrameworkAgentName: string): Set<string> {
    const result = new Set<string>();
    const queue: string[] = [rootFrameworkAgentName];
    while (queue.length > 0) {
      const parentFw = queue.shift()!;
      for (const [childDisplayName, parentName] of this.parentMap) {
        if (parentName === parentFw && !result.has(childDisplayName)) {
          result.add(childDisplayName);
          const childLive = this.liveSubagents.get(childDisplayName);
          if (childLive) queue.push(childLive.frameworkAgentName);
        }
      }
    }
    return result;
  }

  /** The direct children of the run named: the parentMap entries whose
   *  parent is the framework agent of any of its attempts (runOfAttempt),
   *  queued children included, since a run takes its parent link when it
   *  queues. */
  private childrenOf(displayName: string): string[] {
    const children: string[] = [];
    for (const [childName, parentFrameworkName] of this.parentMap) {
      if (this.runOfAttempt.get(parentFrameworkName) === displayName) children.push(childName);
    }
    return children;
  }

  // =========================================================================
  // Peek Observability
  // =========================================================================

  private registerLive(
    displayName: string,
    frameworkAgentName: string,
    systemPrompt: string,
    contextManager: ContextManager,
  ): void {
    this.liveSubagents.set(displayName, {
      frameworkAgentName,
      displayName,
      systemPrompt,
      contextManager,
      currentStream: '',
      pendingToolCalls: [],
      activeCallIds: new Set(),
    });
    this.frameworkNameIndex.set(frameworkAgentName, displayName);
  }

  private unregisterLive(displayName: string, frameworkAgentName: string): void {
    // Clean up callId index entries for this subagent
    const live = this.liveSubagents.get(displayName);
    if (live) {
      for (const callId of live.activeCallIds) {
        this.callIdIndex.delete(callId);
      }
    }
    this.liveSubagents.delete(displayName);
    this.frameworkNameIndex.delete(frameworkAgentName);
  }

  /** Fold a usage sample into the subagent's context size (`lastInputTokens`).
   *  A sample is the stream's usage so far, so the context size is the prompt
   *  of the call it adds (see stream-usage.ts). */
  private noteUsageSample(live: LiveSubagentState, sample: UsageSample | undefined): void {
    if (!sample) return;
    const step = foldUsageSample(live.streamUsage, sample);
    live.streamUsage = step.total;
    if (step.prompt !== undefined) this.lastInputTokens.set(live.displayName, step.prompt);
  }

  /** Fan out a stream event to all subscribers for this subagent + wildcard. */
  private emit(displayName: string, event: SubagentStreamEvent): void {
    for (const key of [displayName, '*']) {
      const subs = this.streamSubscribers.get(key);
      if (!subs) continue;
      for (const cb of subs) {
        try { cb(event); } catch { /* subscriber error — don't break the loop */ }
      }
    }
  }

  /**
   * Subscribe to a running subagent's live stream. Receives all inference
   * and tool events as they happen. Returns an unsubscribe function.
   *
   * If name is '*', subscribes to events from ALL subagents (events are
   * the same type — use peek() to get the subagent name if needed).
   */
  onPeekStream(name: string, callback: SubagentStreamCallback): () => void {
    if (!this.streamSubscribers.has(name)) {
      this.streamSubscribers.set(name, new Set());
    }
    this.streamSubscribers.get(name)!.add(callback);

    return () => {
      const subs = this.streamSubscribers.get(name);
      if (subs) {
        subs.delete(callback);
        if (subs.size === 0) this.streamSubscribers.delete(name);
      }
    };
  }

  /**
   * Peek at a running subagent's live state: full context, streaming output,
   * pending tool calls. Returns null if the subagent is not running.
   * If name is omitted, returns snapshots for all running subagents.
   *
   * Postmortem 2026-05-28 P3 #8: when a `callerFrameworkAgentName` is
   * supplied (the normal tool-call path threads it through `handlePeek`),
   * the result is scoped to the caller's descendants — peers/cousins are
   * filtered out. Internal callers without a known identity (omit the arg)
   * keep the global view for backward compatibility.
   */
  async peek(name?: string, callerFrameworkAgentName?: string): Promise<SubagentPeekSnapshot[]> {
    const allowed = callerFrameworkAgentName
      ? this.getDescendantDisplayNames(callerFrameworkAgentName)
      : null;
    if (name) {
      if (allowed && !allowed.has(name)) return [];
      const snapshot = await this.peekOne(name);
      return snapshot ? [snapshot] : [];
    }
    const results: SubagentPeekSnapshot[] = [];
    for (const displayName of this.liveSubagents.keys()) {
      if (allowed && !allowed.has(displayName)) continue;
      const snapshot = await this.peekOne(displayName);
      if (snapshot) results.push(snapshot);
    }
    return results;
  }

  private async peekOne(displayName: string): Promise<SubagentPeekSnapshot | null> {
    const live = this.liveSubagents.get(displayName);
    if (!live) return null;

    // The matching ActiveSubagent entry for status/metadata
    const entry = this.runningEntry(displayName);

    let messageCount = 0;
    let lastMessageSnippet = '';
    try {
      // A dry compile: a peek only reads, so it mustn't commit the stream's
      // fold state or queue its compression, as a real compile would. A plan
      // over the budget it compiles at is returned, where a real compile
      // refuses it.
      const compiled = await live.contextManager.compile(undefined, undefined, { dryRun: true });
      messageCount = compiled.messages.length;
      // Extract a short snippet from the last message for observability
      // without dumping the entire context into the caller's window.
      if (compiled.messages.length > 0) {
        const last = compiled.messages[compiled.messages.length - 1];
        const textBlocks = last.content
          .filter((b: ContentBlock) => b.type === 'text')
          .map((b: ContentBlock) => (b as { type: 'text'; text: string }).text);
        const fullText = textBlocks.join(' ');
        lastMessageSnippet = fullText.length > 500 ? fullText.slice(-500) : fullText;
      }
    } catch {
      // Context manager may be mid-modification; return what we have
    }

    const elapsedMs = entry ? Date.now() - entry.startedAt : 0;

    // Zombie detection. Postmortem 2026-05-28 F2: this previously keyed off
    // `startedAt`, which flagged any subagent >30s old as a zombie the moment
    // it was between tokens — saturating peers' context with false alarms and
    // driving an orchestrator-level retry storm. Now keyed off `lastActivityAt`
    // and gated by `!requestInFlightSince` to match the reaper.
    const silentMs = entry ? Date.now() - entry.lastActivityAt : 0;
    const isZombie = (entry?.status === 'running')
      && silentMs > ZOMBIE_THRESHOLD_MS
      && !live.currentStream
      && live.pendingToolCalls.length === 0
      && !live.requestInFlightSince;

    return {
      name: displayName,
      type: entry?.type ?? 'spawn',
      task: entry?.task ?? '',
      status: entry?.status ?? 'running',
      startedAt: entry?.startedAt ?? 0,
      elapsedMs,
      messageCount,
      lastMessageSnippet,
      currentStream: live.currentStream,
      pendingToolCalls: live.pendingToolCalls,
      toolCallsCount: entry?.toolCallsCount ?? 0,
      isZombie,
    };
  }

  // =========================================================================
  // Execution Timeout
  // =========================================================================

  /**
   * Resolve a subagent's maxTokens budget through the cascade:
   *   1. per-call `maxTokens` on the fork/spawn input
   *   2. recipe-level `defaultMaxTokens` on this module's config
   *   3. parent agent's `maxTokens` (by default, subagents inherit their caller's budget)
   *   4. last-resort framework fallback (4096) — only reached if there's no parent at all
   */
  private resolveMaxTokens(callMaxTokens: number | undefined, parentAgentName?: string): number {
    if (callMaxTokens !== undefined) return callMaxTokens;
    if (this.config.defaultMaxTokens !== undefined) return this.config.defaultMaxTokens;
    const parentName = parentAgentName ?? this.config.parentAgentName;
    if (parentName) {
      const parent = this.framework?.getAgent(parentName);
      if (parent) return parent.maxTokens;
    }
    return 4096;
  }

  /** Race an attempt against its run's time limit: `limitMs` long, ending
   *  at `deadline`, so every attempt shares one limit. At the deadline,
   *  `stop` ends the run itself, and the error is the module's own, which
   *  the retry loop doesn't retry. A stop that throws is logged, and the
   *  limit still ends the attempt. The framework's startup watchdog for the
   *  attempt ends at the deadline too (watchdogsFor), and its timer can
   *  fire first, so a failure that ends the attempt at the deadline is
   *  reported as the time limit, whichever settled it. The timer ends with
   *  the attempt, so a finished run is never stopped late. */
  private withTimeout<T>(promise: Promise<T>, name: string, kind: 'spawn' | 'fork', limitMs: number | undefined, deadline: number | undefined, stop: () => void): Promise<T> {
    if (limitMs === undefined || deadline === undefined) return promise;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        try {
          stop();
        } catch (err) {
          console.error(`[subagent] ${name}: stopping the run at its time limit failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        reject(this.timedOut(kind, limitMs));
      }, timerDelay(deadline - Date.now()));
    });
    const attempt = promise.catch((err: unknown) => {
      throw deadline - Date.now() <= TIMER_SLACK_MS ? this.timedOut(kind, limitMs) : err;
    });
    return Promise.race([attempt, limit]).finally(() => clearTimeout(timer));
  }

  /** An async run's time limit, which only its own timeoutMs sets. */
  private timedOut(kind: 'spawn' | 'fork', limitMs: number): SubagentFailure {
    return new SubagentFailure(
      `its time limit of ${duration(limitMs)} ran out`,
      `To give it longer, call subagent--${kind} again with a larger timeoutMs; an async ${kind} with no timeoutMs has no limit.`,
    );
  }

  /** The framework's watchdogs for an attempt of a run with a deadline: its
   *  startup watchdog no later than the deadline, so a run whose inference
   *  hasn't started by then (held behind a provider wait, say) is dropped by
   *  the framework rather than started after the run was reported timed
   *  out. Without a deadline, the framework's own. */
  private watchdogsFor(deadline: number | undefined): { startupTimeoutMs: number } | undefined {
    if (deadline === undefined) return undefined;
    return { startupTimeoutMs: Math.max(1, Math.min(30_000, deadline - Date.now())) };
  }

  // =========================================================================
  // Prompt Size Estimation
  // =========================================================================

  private estimatePromptTokens(
    systemPrompt: string,
    messages: Array<{ content: ContentBlock[] }>,
    tools: ToolDefinition[],
  ): number {
    let tokens = Math.ceil(systemPrompt.length / 4) + 50; // system + overhead

    for (const msg of messages) {
      tokens += 50; // per-message overhead (role, formatting)
      for (const block of msg.content) {
        tokens += Math.ceil(JSON.stringify(block).length / 4);
      }
    }

    for (const tool of tools) {
      tokens += 100; // per-tool overhead
      tokens += Math.ceil(JSON.stringify(tool).length / 4);
    }

    return tokens;
  }

  // =========================================================================
  // Tool Handlers
  // =========================================================================

  /**
   * Resolve everything a new stream is launched with, once, at the call.
   * run*() creates the stream from this description verbatim, and the
   * receipt and the stream's first context both render it.
   */
  private resolveLaunch(
    kind: 'fork' | 'spawn',
    input: ForkInput | SpawnInput,
    callerAgentName: string | undefined,
    callerDepth: number,
    callToolUseId?: string,
  ): SubagentLaunch {
    const framework = this.getFramework();
    // The caller (recursive forks and spawns), else the configured parent
    // agent. A caller named but not found is refused, before any slot.
    const parentName = callerAgentName ?? this.config.parentAgentName;
    const parentAgent = parentName === undefined ? null : (framework.getAgent(parentName) ?? null);
    if (callerAgentName !== undefined && !parentAgent) {
      throw new Error(`Cannot resolve subagent caller: ${callerAgentName}`);
    }
    const model = input.model ?? this.config.defaultModel ?? FALLBACK_SUBAGENT_MODEL;

    let systemPrompt: string;
    let systemPromptSource: SubagentLaunch['systemPromptSource'];
    if (kind === 'spawn') {
      systemPrompt = (input as SpawnInput).systemPrompt;
      systemPromptSource = 'caller';
    } else if (input.systemPrompt !== undefined && input.systemPrompt !== parentAgent?.systemPrompt) {
      systemPrompt = input.systemPrompt;
      systemPromptSource = 'override';
    } else if (parentAgent) {
      systemPrompt = parentAgent.systemPrompt;
      systemPromptSource = 'parent';
    } else {
      // No prompt of its own (any it names differs from a missing
      // parent's, so it took the override branch) and no parent.
      systemPrompt = NO_PARENT_SYSTEM_PROMPT;
      systemPromptSource = 'default';
    }

    const requestedTools = kind === 'spawn' ? (input as SpawnInput).tools : undefined;
    // The caller's own tool rules, narrowed by the spawn's list (at the
    // depth limit, only what the process offers of them, less the subagent
    // tools): resolved now and kept through the slot wait and every retry.
    const allowed = this.filterToolNames(requestedTools, callerDepth, parentAgent);
    // What the process offers now, which the description can say the stream
    // gets.
    const offered = this.offeredNames();

    // The parent's context settings at the call, from supported surfaces
    // only: its runtime settings (budget, and the strategy's recent tail when
    // the strategy reports one) and the strategy's own name and message cap.
    // Anything else (head window, compression model) isn't reported, and the
    // description says so rather than assuming a match.
    let parentStrategy: string | undefined;
    let parentMessageCap: number | undefined;
    try {
      const strategy = parentAgent?.getContextManager().getStrategy() as
        { name?: unknown; maxMessageTokens?: unknown } | undefined;
      if (typeof strategy?.name === 'string') parentStrategy = strategy.name;
      if (typeof strategy?.maxMessageTokens === 'number') parentMessageCap = strategy.maxMessageTokens;
    } catch { /* a strategy that can't be read reports nothing */ }
    const parentRuntime = parentAgent?.getRuntimeSettings();

    // Agent defaults to 'locus'. A resolved caller's mode is inherited, so
    // children of a 'disabled' caller can't leak prose into its live channel.
    const proseRouting = parentAgent?.proseRouting;
    return {
      kind,
      name: input.name,
      depth: callerDepth + 1,
      maxDepth: this.maxDepth,
      ...(kind === 'fork' && callToolUseId ? { forkPoint: callToolUseId } : {}),
      ...(this.config.provider !== undefined ? { provider: this.config.provider } : {}),
      model,
      systemPrompt,
      systemPromptSource,
      maxTokens: this.resolveMaxTokens(input.maxTokens, callerAgentName),
      maxStreamTokens: SUBAGENT_STREAM_TOKENS,
      strategy: { ...SUBAGENT_STRATEGY, compressionModel: model },
      ...(proseRouting !== undefined ? { proseRouting } : {}),
      tools: {
        allowed: allowed === 'all' ? 'all' : [...allowed],
        ...(requestedTools !== undefined ? { requested: [...requestedTools] } : {}),
        // Each name once: the stream gets a tool once however often its list
        // names it (canUseTool tests membership).
        ...(allowed !== 'all' ? { granted: [...new Set(allowed)].filter((name) => name === 'subagent--return' || offered.has(name)) } : {}),
        // filterToolNames' own threshold.
        depthLimited: callerDepth + 1 >= this.maxDepth,
      },
      parent: parentAgent
        ? {
            stream: parentAgent.name,
            model: parentAgent.model,
            maxTokens: parentAgent.maxTokens,
            maxStreamTokens: parentAgent.maxStreamTokens,
            contextBudgetTokens: parentRuntime!.contextBudgetTokens,
            ...(parentRuntime?.tailTokens !== undefined ? { tailTokens: parentRuntime.tailTokens } : {}),
            ...(parentStrategy !== undefined ? { strategy: parentStrategy } : {}),
            ...(parentMessageCap !== undefined ? { maxMessageTokens: parentMessageCap } : {}),
            allowedTools: Array.isArray(parentAgent.allowedTools) ? [...parentAgent.allowedTools] : 'all',
          }
        : null,
      parentAgent,
    };
  }

  /** The ephemeral agent a launch describes. Nothing here is re-resolved:
   *  each value comes from the launch as resolved at the call, its tool
   *  rules included. */
  private ephemeralAgentConfig(launch: SubagentLaunch, agentName: string) {
    return {
      name: agentName,
      model: launch.model,
      systemPrompt: launch.systemPrompt,
      maxTokens: launch.maxTokens,
      ...(launch.proseRouting !== undefined ? { proseRouting: launch.proseRouting } : {}),
      maxStreamTokens: launch.maxStreamTokens,
      strategy: new KnowledgeStrategy({
        headWindowTokens: launch.strategy.headWindowTokens,
        recentWindowTokens: launch.strategy.recentWindowTokens,
        compressionModel: launch.strategy.compressionModel,
        autoTickOnNewMessage: true,
        maxMessageTokens: launch.strategy.maxMessageTokens,
      }),
      allowedTools: launch.tools.allowed === 'all' ? 'all' as const : [...launch.tools.allowed],
    };
  }

  /**
   * The tools an ephemeral stream is shown, as the board stands when the
   * launch composes its first context. The framework reads the board again
   * when it assembles the first request, so a server that changes its tools
   * in between isn't reflected here; the request's own tool list is what
   * the stream can call. The framework builds that surface
   * (agentToolSurface) from the shared board filtered by the agent's own
   * permissions, plus prose_help under explicit
   * prose routing when those permissions allow it (agent-framework 0.22.3's
   * availableToolsForPresentation). An ephemeral agent has no presentation
   * and isn't the subconscious, so nothing else applies, and it isn't
   * registered until its run starts, so listToolClasses can't be asked yet.
   * The orientation tests set this against listToolClasses once the stream
   * is registered, and against the request it sends, so a change in the
   * framework's rule fails them.
   */
  private streamSurface(agent: { canUseTool(name: string): boolean; proseRouting: ProseRouting }): string[] {
    const names = this.getFramework().getAllTools()
      .filter((t) => agent.canUseTool(t.name))
      .map((t) => t.name);
    if (agent.proseRouting === 'explicit' && agent.canUseTool('prose_help')) names.push('prose_help');
    return names;
  }

  /** A refused fork's way out: a spawn, where the caller's tool rules allow
   *  one. It takes a systemPrompt, which a fork's caller needn't have given,
   *  and its own orientation and task must each fit one message, or it's
   *  refused in turn. A caller whose rules don't allow subagent--spawn is
   *  told to do the work in its own stream, rather than sent to a tool it
   *  can't call. */
  private spawnInstead(canSpawn: boolean, withCap = false): string {
    if (!canSpawn) return "do it in this stream instead, since subagent--spawn isn't among your tools";
    const cap = withCap ? ` (${formatTokens(SUBAGENT_STRATEGY.maxMessageTokens)})` : '';
    return 'launch it as subagent--spawn instead, with a name, a systemPrompt, a short tools list and a task ' +
      `that fits one message${cap} and says what it needs to know`;
  }

  /** Why a launch is refused when its stream wouldn't read what it
   *  promises: each part that was cut, and the way out for it. A fork takes
   *  no tools list, so its way out for a long orientation, or for a call the
   *  context lost, is a spawn with a short one, so that the spawn's own
   *  orientation fits, and a spawn inherits nothing: worth saying when the
   *  fork would have inherited its parent's context, as a fork with a call
   *  does. */
  private launchRefusal(
    kind: 'spawn' | 'fork',
    cut: ReadonlyArray<'orientation' | 'task' | 'call'>,
    delivery: LaunchDelivery,
    /** Whether the caller's tool rules allow subagent--spawn: a fork's way
     *  out names a spawn only then. */
    canSpawn: boolean,
  ): SubagentFailure {
    const inheritsContext = delivery.kind === 'fork-result' && canSpawn;
    const cap = formatTokens(SUBAGENT_STRATEGY.maxMessageTokens);
    // A spawn's task is a message of its own, which the cap can cut, as a
    // parentless fork's is; a fork with a parent carries its task whole in
    // its call, so the spawn it becomes needs a task that fits one message.
    const inherits = inheritsContext ? ', though a spawn inherits none of this context' : '';
    const reasons = cut.map((part) => {
      if (part === 'orientation') {
        return kind === 'spawn'
          ? `its orientation, which names the spawn's tools in full, is longer than one message holds (${cap}): give the spawn a shorter tools list`
          : `its orientation is longer than one message holds (${cap}): ${this.spawnInstead(canSpawn)}${inherits}`;
      }
      if (part === 'task') {
        return `its task is longer than one message holds (${cap}): shorten or split it, or put the detail in a file, ` +
          `${kind === 'spawn' ? 'give the spawn a tool that can read it' : 'make sure its tools can read it'}, and pass the path`;
      }
      return `the fork call that carries its task, or its result, isn't in the context it would start from: ${this.spawnInstead(canSpawn, true)}${inherits}`;
    });
    return new SubagentFailure(reasons.join('; and '));
  }

  /** The stream's own orientation: the launch block as resolved at the
   *  call, then what happened when the stream was created. */
  private orientationFor(
    launch: SubagentLaunch,
    agent: Omit<Parameters<typeof agentSettingsOf>[0], 'getRuntimeSettings'> & {
      canUseTool(name: string): boolean;
      getRuntimeSettings(): { contextBudgetTokens: number; sameRoundThinkTextPolicy?: string };
      proseRouting: ProseRouting;
    },
    inherited: SubagentStart['inherited'],
  ): string {
    const framework = this.getFramework();
    let parentTools: string[] | undefined;
    let parentAgentSettings: AgentSettings | undefined;
    // The parent the launch was resolved against at the call, as the fork's
    // context is: never another agent later registered under its name.
    // listToolClasses looks agents up by name, so its surface is read only
    // while the framework's agent of that name is still this one.
    const parentAgent = launch.parentAgent;
    if (launch.parent && parentAgent) {
      if (framework.getAgent(parentAgent.name) === parentAgent) {
        try {
          parentTools = framework.listToolClasses(parentAgent.name).map((t) => t.tool);
        } catch { /* stated as unreadable */ }
      }
      parentAgentSettings = agentSettingsOf(parentAgent as unknown as Parameters<typeof agentSettingsOf>[0]);
    }
    const start: SubagentStart = {
      inherited,
      contextBudgetTokens: agent.getRuntimeSettings().contextBudgetTokens,
      proseRouting: agent.proseRouting,
      tools: this.streamSurface(agent),
      ...(parentTools !== undefined ? { parentTools } : {}),
      agentSettings: agentSettingsOf(agent),
      ...(parentAgentSettings !== undefined ? { parentAgentSettings } : {}),
    };
    return `${describeSubagentLaunch(launch)}\n${describeSubagentStart(launch, start)}`;
  }

  /** The caller's receipt: whether the launch started or is waiting for a
   *  slot, then the launch description. */
  private launchReceipt(launch: SubagentLaunch, head: string, ticket: { queued: boolean }): string {
    const slot = ticket.queued
      ? `Every subagent slot (${this.effectiveConcurrent}) is in use, so it waits for one to free, for up to ${Math.round(SLOT_TIMEOUT_MS / 1000)} s; if none does, it ends with an error, delivered as its result would be.`
      : 'Starting in background.';
    return `${head} ${slot}\n\n${describeSubagentLaunch(launch)}`;
  }
  private async handleSpawn(input: SpawnInput, callerAgentName?: string): Promise<ToolResult> {
    const callerDepth = callerAgentName ? (this.agentDepths.get(callerAgentName) ?? 0) : 0;
    if (callerDepth >= this.maxDepth) {
      return {
        success: false,
        isError: true,
        error: `Max subagent depth ${this.maxDepth} reached (caller at depth ${callerDepth})`,
      };
    }

    const parentAgentName = callerAgentName ?? this.config.parentAgentName ?? 'agent';
    // Resolved once, before any slot, and kept through the slot wait and
    // every retry: the caller's settings, context and tool rules as they are
    // now. A caller that can't be resolved, or a module with no framework
    // yet, answers with an error, never a throw.
    let launch: SubagentLaunch;
    try {
      launch = this.resolveLaunch('spawn', input, callerAgentName, callerDepth);
    } catch (error) {
      return { success: false, isError: true, error: error instanceof Error ? error.message : String(error) };
    }
    const ticket = { queued: false };

    const inUse = this.nameInUse(input.name);
    if (inUse) return inUse;

    // Sync mode: block until completion, but detachable mid-flight. At
    // timeoutMs (default maxExecutionMs) the run moves to the background and
    // goes on; a sync run has no hard limit.
    if (input.sync) {
      const promise = this.runSpawn(launch, input, callerAgentName, callerDepth, undefined, ticket);
      return await this.runDetachable(input.name, 'spawn', promise, parentAgentName, input.timeoutMs ?? this.maxExecutionMs, launch);
    }

    // Async mode (default): fire-and-forget, deliver result as message.
    // No default timeout — async agents run until they finish unless
    // the caller explicitly sets timeoutMs.
    const promise = this.runSpawn(launch, input, callerAgentName, callerDepth, input.timeoutMs, ticket);
    this.asyncHandles.set(input.name, { name: input.name, type: 'spawn', promise, parentAgentName });

    promise
      .then(
        result => this.deliverAsyncResult(input.name, result, parentAgentName),
        err => this.deliverAsyncError(input.name, err, parentAgentName),
      )
      .catch(err => console.error(`[subagent] delivering ${input.name}'s result: ${err instanceof Error ? err.message : String(err)}`));

    // runSpawn ran synchronously up to its slot wait, so `ticket` already
    // says whether this launch is starting or queued.
    return { success: true, data: this.launchReceipt(launch, `Subagent '${input.name}' accepted as a spawn.`, ticket) };
  }

  private async handleFork(input: ForkInput, callerAgentName?: string, callToolUseId?: string): Promise<ToolResult> {
    const callerDepth = callerAgentName ? (this.agentDepths.get(callerAgentName) ?? 0) : 0;
    if (callerDepth >= this.maxDepth) {
      return {
        success: false,
        isError: true,
        error: `Max subagent depth ${this.maxDepth} reached (caller at depth ${callerDepth})`,
      };
    }

    const parentAgentName = callerAgentName ?? this.config.parentAgentName ?? 'agent';
    // Resolved once, before any slot, and kept through the slot wait and
    // every retry: the caller's settings, context and tool rules as they are
    // now. A caller that can't be resolved, or a module with no framework
    // yet, answers with an error, never a throw.
    let launch: SubagentLaunch;
    try {
      launch = this.resolveLaunch('fork', input, callerAgentName, callerDepth, callToolUseId);
    } catch (error) {
      return { success: false, isError: true, error: error instanceof Error ? error.message : String(error) };
    }
    const ticket = { queued: false };

    const inUse = this.nameInUse(input.name);
    if (inUse) return inUse;

    // Sync mode: block until completion, but detachable mid-flight. At
    // timeoutMs (default maxExecutionMs) the run moves to the background and
    // goes on; a sync run has no hard limit.
    if (input.sync) {
      const promise = this.runFork(launch, input, callerAgentName, callerDepth, undefined, callToolUseId, ticket);
      return await this.runDetachable(input.name, 'fork', promise, parentAgentName, input.timeoutMs ?? this.maxExecutionMs, launch);
    }

    // Async mode (default): fire-and-forget, deliver result as message.
    // No default timeout — async agents run until they finish unless
    // the caller explicitly sets timeoutMs.
    const promise = this.runFork(launch, input, callerAgentName, callerDepth, input.timeoutMs, callToolUseId, ticket);
    this.asyncHandles.set(input.name, { name: input.name, type: 'fork', promise, parentAgentName });

    promise
      .then(
        result => this.deliverAsyncResult(input.name, result, parentAgentName),
        err => this.deliverAsyncError(input.name, err, parentAgentName),
      )
      .catch(err => console.error(`[subagent] delivering ${input.name}'s result: ${err instanceof Error ? err.message : String(err)}`));

    // runFork ran synchronously up to its slot wait, so `ticket` already
    // says whether this launch is starting or queued.
    return { success: true, data: this.launchReceipt(launch, `Subagent '${input.name}' accepted as a fork.`, ticket) };
  }

  /** A refusal when a subagent already has this name. A name means one
   *  subagent from its spawn until its result has come back: the agent
   *  cancels, peeks at and waits for subagents by name, and the module keys
   *  them by it. Until then an admitted run is in detachableHandles (a sync
   *  run still blocking its caller, until the call returns or the run moves
   *  to the background) or asyncHandles (an async run, or a sync one moved to
   *  the background, until its result is delivered). A run that no longer
   *  has its cancel was cancelled or reclaimed, or has ended, so it's
   *  finishing, whatever its entry still says. */
  private nameInUse(name: string): ToolResult | null {
    if (!this.asyncHandles.has(name) && !this.detachableHandles.has(name)) return null;
    const entry = this.runningEntry(name);
    const state = !this.cancellationHandles.has(name)
      ? 'is still finishing'
      : entry
        ? `is already running (for ${Math.round((Date.now() - entry.startedAt) / 1000)} s)`
        : 'is already waiting for a concurrency slot';
    return {
      success: false,
      isError: true,
      error:
        `Nothing was started: a subagent named '${name}' ${state}, and a name means one subagent ` +
        `until its result has come back. Choose another name, or wait for that one's result.`,
    };
  }

  private deliverAsyncResult(name: string, result: SubagentResult, parentAgentName: string): void {
    this.asyncHandles.delete(name);
    if (!this.ctx) return;

    this.ctx.addMessage('user', [{
      type: 'text',
      text: `[Subagent '${name}' returned]\n\n${result.summary}`,
    }]);
    this.ctx.pushEvent({
      type: 'inference-request',
      agentName: parentAgentName,
      reason: `subagent-completed:${name}`,
      source: 'subagent',
    });
  }

  private deliverAsyncError(name: string, err: unknown, parentAgentName: string): void {
    this.asyncHandles.delete(name);
    if (!this.ctx) return;

    const message = err instanceof Error ? err.message : String(err);
    this.ctx.addMessage('user', [{
      type: 'text',
      text: `[Subagent '${name}' failed]\n\nError: ${message}`,
    }]);
    this.ctx.pushEvent({
      type: 'inference-request',
      agentName: parentAgentName,
      reason: `subagent-failed:${name}`,
      source: 'subagent',
    });
  }

  /** A spawn's or fork's failure as the agent reads it, in the call's answer
   *  or the async notice: whether anything ran, what ended it, and what to
   *  do. The module's own failures say what ended them and what to do
   *  (SubagentFailure); anything else is the run's own error. A run started
   *  once an attempt reached runEphemeralToCompletion, the only place a
   *  subagent acts. */
  private failedRun(name: string, kind: 'spawn' | 'fork', err: unknown, run: { started: boolean; attempts: number }): Error {
    const who = kind === 'fork' ? `Fork '${name}'` : `Subagent '${name}'`;
    const own = err instanceof SubagentFailure ? err : null;
    const why = (own ? own.why : err instanceof Error ? err.message : String(err)).replace(/[\s.]+$/, '');
    const remedy = own?.remedy ? ` ${own.remedy}` : '';
    if (!run.started) return new Error(`${who} didn't start, so nothing ran: ${why}.${remedy}`);
    const tries = run.attempts > 1 ? ` after ${run.attempts} attempts` : '';
    return new Error(
      `${who} stopped${tries} and returned no result: ${why}. What it did before then stays done, and ` +
      `${kind === 'fork' ? 'forking' : 'spawning'} it again starts its task over.${remedy}`,
    );
  }

  // =========================================================================
  // Detachable sync → async transition
  // =========================================================================

  /**
   * Run a sync subagent with the ability to detach mid-flight.
   * Returns a ToolResult — either the completed result (if it finishes in time)
   * or a "moved to background" acknowledgment (if detached by user or timeout).
   */
  private async runDetachable(
    name: string,
    type: 'spawn' | 'fork',
    promise: Promise<SubagentResult>,
    parentAgentName: string,
    autoDetachMs?: number,
    /** Rendered into both returns, so a sync caller gets the same launch
     *  description an async caller's receipt carries. */
    launch?: SubagentLaunch,
  ): Promise<ToolResult> {
    const launchText = launch ? describeSubagentLaunch(launch) : undefined;
    let detachResolve: ((value: 'detached') => void) | null = null;
    const detachPromise = new Promise<'detached'>(resolve => { detachResolve = resolve; });

    const handle: DetachableHandle = {
      name,
      type,
      promise,
      parentAgentName,
      detach: () => detachResolve?.('detached'),
    };
    this.detachableHandles.set(name, handle);

    // Optional auto-detach timeout (sync → async after N ms)
    let autoTimer: ReturnType<typeof setTimeout> | null = null;
    if (autoDetachMs !== undefined) {
      autoTimer = setTimeout(() => {
        if (this.detachableHandles.has(name)) {
          handle.detach();
        }
      }, timerDelay(autoDetachMs));
    }

    type RaceResult =
      | { kind: 'completed'; result: SubagentResult }
      | { kind: 'error'; error: unknown }
      | { kind: 'detached' };

    try {
      const winner: RaceResult = await Promise.race([
        promise.then(
          (result): RaceResult => ({ kind: 'completed', result }),
          (err): RaceResult => ({ kind: 'error', error: err }),
        ),
        detachPromise.then((): RaceResult => ({ kind: 'detached' })),
      ]);

      if (autoTimer) clearTimeout(autoTimer);
      this.detachableHandles.delete(name);

      if (winner.kind === 'completed') {
        return {
          success: true,
          data: launchText ? { ...winner.result, launch: launchText } : winner.result,
        };
      }

      if (winner.kind === 'error') {
        const err = winner.error;
        return {
          success: false,
          isError: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      // Detached: transition to async — wire up result delivery
      this.asyncHandles.set(name, { name, type, promise, parentAgentName });
      promise
        .then(
          result => this.deliverAsyncResult(name, result, parentAgentName),
          err => this.deliverAsyncError(name, err, parentAgentName),
        )
        .catch(err => console.error(`[subagent] delivering ${name}'s result: ${err instanceof Error ? err.message : String(err)}`));

      return {
        success: true,
        data: `Subagent '${name}' moved to background. Results will be delivered as a message when complete.` +
          (launchText ? `\n\n${launchText}` : ''),
      };
    } catch {
      if (autoTimer) clearTimeout(autoTimer);
      this.detachableHandles.delete(name);
      return { success: false, isError: true, error: `Unexpected error in detachable handler for '${name}'` };
    }
  }

  /**
   * Detach a currently-blocking sync subagent, converting it to async.
   * Returns true if the subagent was found and detached.
   */
  detachSubagent(name: string): boolean {
    const handle = this.detachableHandles.get(name);
    if (!handle) return false;
    handle.detach();
    return true;
  }

  /**
   * Detach all currently-blocking sync subagents.
   * Returns the number of subagents detached.
   */
  detachAll(): number {
    let count = 0;
    for (const handle of this.detachableHandles.values()) {
      handle.detach();
      count++;
    }
    return count;
  }

  /**
   * Check if any sync subagents are currently blocking (and thus detachable).
   */
  hasDetachable(): boolean {
    return this.detachableHandles.size > 0;
  }

  private handleHud(input: { enabled: boolean }): ToolResult {
    if (!this.ctx) return { success: false, isError: true, error: 'Module not started' };
    const persisted = this.ctx.getState<{ agents?: unknown; hudEnabled?: boolean }>() ?? {};
    this.ctx.setState({ ...persisted, hudEnabled: input.enabled });
    return { success: true, data: { hudEnabled: input.enabled } };
  }

  private handleConcurrency(input: { maxConcurrent?: number }): ToolResult {
    if (input.maxConcurrent !== undefined) {
      this.setConcurrency(input.maxConcurrent);
    }
    return { success: true, data: this.getConcurrencyStatus() };
  }

  private async handlePeek(input: { name?: string }, caller?: string): Promise<ToolResult> {
    const snapshots = await this.peek(input.name, caller);
    if (snapshots.length === 0) {
      return {
        success: true,
        data: {
          message: input.name
            ? `No subagent of yours named '${input.name}' is running now. It may have finished (an async subagent's ` +
              'result arrives as a message), or not have started yet, such as while it waits for a concurrency slot. ' +
              'subagent--peek with no name lists the ones running now.'
            : 'None of your subagents is running now.',
        },
      };
    }
    return { success: true, data: snapshots };
  }

  // =========================================================================
  // Subagent Execution
  // =========================================================================

  private async runSpawn(
    launch: SubagentLaunch,
    input: SpawnInput,
    _callerAgentName?: string,
    callerDepth = 0,
    executionTimeoutMs?: number,
    ticket?: { queued: boolean },
  ): Promise<SubagentResult> {
    const cancel = this.cancelFor(input.name);
    this.claimName(input.name, _callerAgentName);
    // Whether an attempt reached its run, the only place a subagent acts,
    // and how many attempts began: what a failure's account says (failedRun).
    const run = { started: false, attempts: 0 };
    let acquired: { waitedMs: number; slot: object };
    try {
      acquired = await this.acquireSlot('spawn', undefined, cancel.promise, ticket);
    } catch (err) {
      cancel.dispose();
      // A run that never started leaves no parent link behind, whether a
      // cancel or the slot's timeout ended its wait.
      this.parentMap.delete(input.name);
      if (err instanceof SubagentTerminated) return this.endQueued(input.name, err);
      throw this.failedRun(input.name, 'spawn', err, run);
    }
    const { waitedMs, slot } = acquired;
    const childDepth = callerDepth + 1;
    // One limit for the whole run, retries included, from when it starts.
    const deadline = executionTimeoutMs === undefined ? undefined : Date.now() + executionTimeoutMs;

    const now = Date.now();
    const entry: ActiveSubagent = {
      name: input.name, type: 'spawn', task: input.task,
      status: 'running', startedAt: now, lastActivityAt: now,
      toolCallsCount: 0, findingsCount: 0,
    };
    const entryKey = `spawn-${input.name}`;

    try {
      this.activeSubagents.set(entryKey, entry);
      this.slotOf.set(entry, slot);
      this.persistState();

      const framework = this.getFramework();
      let lastError: Error | null = null;

      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        run.attempts = attempt + 1;
        const agentName = `spawn-${input.name}-${nameStamp()}`;
        this.runOfAttempt.set(agentName, input.name);
        // An attempt starts with no result an earlier attempt, or an earlier
        // run under the name, stashed with return.
        this.returnedResults.delete(input.name);
        // Setup races the run's cancel too, so a cancel ends a run whose
        // setup never finishes. A reclaim does once the run is registered
        // (registerLive, below), since the reaper reads registered runs only.
        let created: Awaited<ReturnType<AgentFramework['createEphemeralAgent']>>;
        const creating = framework.createEphemeralAgent(this.ephemeralAgentConfig(launch, agentName));
        try {
          created = await Promise.race([creating, cancel.promise]);
        } catch (err) {
          if (err instanceof SubagentTerminated) {
            giveBackWhenCreated(creating, input.name);
            return this.endTerminated(input.name, entry, err, waitedMs, run.started);
          }
          throw err;
        }
        const { agent, contextManager, cleanup } = created;

        // Track depth for recursive fork/spawn calls from this agent
        this.agentDepths.set(agentName, childDepth);

        // Register live state for peek observability
        this.registerLive(input.name, agentName, launch.systemPrompt, contextManager);

        try {
          // What this stream runs on (the launch as resolved at the call,
          // and the tool surface it actually has now), then the task, each
          // its own message: the cap applies to each message alone, so each
          // has all of it. The native formatter merges the two into one user
          // turn after the cap; the anthropic-xml and openai-responses
          // formatters send them as two consecutive user turns. The delivery
          // check below refuses a stream that wouldn't read either whole.
          const orientation = this.orientationFor(launch, agent, { kind: 'none', reason: 'spawn' });
          contextManager.addMessage('user', [{ type: 'text', text: orientation }]);
          contextManager.addMessage('user', [{ type: 'text', text: input.task }]);

          // The stream must read what the launch promises: refuse it when
          // its orientation or its whole task isn't in the launch's compile
          // of its first context. It's a real compile, not a dry one: a dry
          // compile returns an over-budget plan where a real one refuses it,
          // and the stream's context is fresh, so its first request's compile
          // starts from what this one leaves.
          const { messages } = await Promise.race([contextManager.compile(), cancel.promise]);
          // The race takes compile's result when compiling settles first, so
          // a cancel that lands just after is thrown here: the run ends
          // before its attempt starts, whatever the checks below would find.
          // Nothing below awaits before the attempt's race.
          cancel.throwIfFired();
          const delivery: LaunchDelivery = { kind: 'message', orientation, taskBlock: input.task };
          const cut = undeliveredLaunchParts(messages, delivery);
          if (cut.length > 0) throw this.launchRefusal('spawn', cut, delivery, true);

          // Pre-validate prompt size
          const tools = framework.getAllTools().filter(t => agent.canUseTool(t.name));
          const est = this.estimatePromptTokens(agent.systemPrompt, messages, tools);
          if (est > this.maxPromptTokens) {
            throw new SubagentFailure(
              `its prompt would be about ${est} tokens, over this host's limit of ${this.maxPromptTokens}`,
              'Shorten its task or systemPrompt, or pass tools naming only the tools it needs, since every ' +
                "tool's definition counts.",
            );
          }

          // The attempt's setup runs outside the limit's timer; a run whose
          // deadline passed during it isn't started.
          if (deadline !== undefined && Date.now() >= deadline) throw this.timedOut('spawn', executionTimeoutMs!);

          // Race execution against both timeout and the run's cancel
          run.started = true;
          let { speech, toolCallsCount } = await Promise.race([
            this.withTimeout(
              framework.runEphemeralToCompletion(agent, contextManager, this.watchdogsFor(deadline)),
              input.name,
              'spawn',
              executionTimeoutMs,
              deadline,
              () => this.stopRun(agent),
            ),
            cancel.promise,
          ]);

          // Prefer explicit return over speech capture
          const returned = this.returnedResults.get(input.name);
          if (returned) {
            speech = returned;
            this.returnedResults.delete(input.name);
          } else if (!speech.trim()) {
            speech = this.extractLastAssistantText(contextManager);
          }

          entry.status = 'completed';
          entry.completedAt = Date.now();
          entry.toolCallsCount = toolCallsCount;
          this.onSubagentSuccess();
          const notice = this.concurrencyNotice(waitedMs);
          const finalSummary = notice + speech;
          this.emit(input.name, { type: 'done', summary: finalSummary, lastInputTokens: this.lastInputTokens.get(input.name) });
          return { summary: finalSummary, findings: [], issues: [], toolCallsCount };
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));

          // Non-retryable termination (user cancel, zombie reclaim, etc.).
          // Postmortem 2026-05-28 P1 #4: terminal-but-benign — 'cancelled',
          // not 'completed'. Before this, the TUI subagent list rendered these
          // as "done" while the reducer-driven web tree rendered them red.
          if (lastError instanceof SubagentTerminated) return this.endTerminated(input.name, entry, lastError, waitedMs, run.started);

          // The module's own failures end the loop before any words are read.
          if (lastError instanceof SubagentFailure) break;
          // So does a provider's stated wait the framework won't sleep: the
          // run is never tried again, so neither the rate-limit cooldown nor
          // a halved concurrency would serve it.
          if (this.isUnsleptProviderWait(lastError)) break;
          if (this.isRateLimitError(lastError, agentName)) {
            const stopped = await this.waitOrStop(this.onRateLimitHit(deadline), cancel.promise);
            if (stopped) return this.endTerminated(input.name, entry, stopped, waitedMs, run.started);
          }
          if (!this.isTransientError(lastError, agentName) || attempt === this.maxRetries) break;

          const delay = Math.min(5_000 * (attempt + 1), 30_000);
          // A retry starts only if it can start within the run's limit.
          if (deadline !== undefined && Date.now() + delay >= deadline) break;
          console.error(
            `[subagent] ${input.name} attempt ${attempt + 1}/${this.maxRetries + 1} failed: ` +
            `${lastError.message}. Restarting in ${delay}ms...`
          );
          entry.statusMessage = `Retry ${attempt + 1}: ${lastError.message}`;
          const stopped = await this.waitOrStop(delay, cancel.promise);
          if (stopped) return this.endTerminated(input.name, entry, stopped, waitedMs, run.started);
        } finally {
          this.agentDepths.delete(agentName);
          this.unregisterLive(input.name, agentName);
          cleanup();
        }
      }

      entry.status = 'failed';
      entry.completedAt = Date.now();
      entry.statusMessage = lastError!.message;
      throw lastError!;
    } catch (err) {
      // A failure outside an attempt's own handling (the framework refusing
      // to create the agent, say) ends the run too.
      if (entry.status === 'running') {
        entry.status = 'failed';
        entry.completedAt = Date.now();
        entry.statusMessage = err instanceof Error ? err.message : String(err);
      }
      throw this.failedRun(input.name, 'spawn', err, run);
    } finally {
      // The slot first, so nothing after it can keep it held.
      this.releaseSlot(slot);
      cancel.dispose();
      this.forgetAttempts(input.name);
      this.persistState();
    }
  }

  private async runFork(
    launch: SubagentLaunch,
    input: ForkInput,
    callerAgentName?: string,
    callerDepth = 0,
    executionTimeoutMs?: number,
    callToolUseId?: string,
    ticket?: { queued: boolean },
  ): Promise<SubagentResult> {
    const cancel = this.cancelFor(input.name);
    this.claimName(input.name, callerAgentName);
    // Whether an attempt reached its run, the only place a subagent acts,
    // and how many attempts began: what a failure's account says (failedRun).
    const run = { started: false, attempts: 0 };
    let acquired: { waitedMs: number; slot: object };
    try {
      acquired = await this.acquireSlot('fork', undefined, cancel.promise, ticket);
    } catch (err) {
      cancel.dispose();
      // A run that never started leaves no parent link behind, whether a
      // cancel or the slot's timeout ended its wait.
      this.parentMap.delete(input.name);
      if (err instanceof SubagentTerminated) return this.endQueued(input.name, err);
      throw this.failedRun(input.name, 'fork', err, run);
    }
    const { waitedMs, slot } = acquired;
    const childDepth = callerDepth + 1;
    // One limit for the whole run, retries included, from when it starts.
    const deadline = executionTimeoutMs === undefined ? undefined : Date.now() + executionTimeoutMs;

    const now = Date.now();
    const entry: ActiveSubagent = {
      name: input.name, type: 'fork', task: input.task,
      status: 'running', startedAt: now, lastActivityAt: now,
      toolCallsCount: 0, findingsCount: 0,
    };
    try {
      this.activeSubagents.set(input.name, entry);
      this.slotOf.set(entry, slot);
      this.persistState();

      const framework = this.getFramework();

      // The parent the launch was resolved against at the call (the caller,
      // which enables recursive forks, else the configured parent agent),
      // whose context is compiled now. A launch that found no parent at the
      // call stays without one, and one that found a parent uses that agent,
      // never another later registered under its name: the receipt and the
      // stream's orientation describe the parent at the call.
      const parentAgent = launch.parentAgent;
      // A refused fork's way out is a spawn only for a caller whose rules
      // allow one; with no parent stream there's no rule to read.
      const canSpawn = parentAgent?.canUseTool('subagent--spawn') ?? true;
      let lastError: Error | null = null;

      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        run.attempts = attempt + 1;
        // Unique agent name: include depth and nameStamp()'s number to prevent
        // collisions when a child fork uses the same display name as its parent
        // (e.g. both called "fork-level-2"). Without this, the child overwrites
        // the parent in the framework's agents Map, and the parent's completion
        // promise never resolves.
        const suffix = attempt === 0 ? `d${childDepth}-${nameStamp()}` : `d${childDepth}-retry${attempt}-${nameStamp()}`;
        const agentName = `${input.name}-${suffix}`;
        this.runOfAttempt.set(agentName, input.name);
        // An attempt starts with no result an earlier attempt, or an earlier
        // run under the name, stashed with return.
        this.returnedResults.delete(input.name);

        // Setup races the run's cancel too, so a cancel ends a run whose
        // setup never finishes. A reclaim does once the run is registered
        // (registerLive, below), since the reaper reads registered runs only.
        let created: Awaited<ReturnType<AgentFramework['createEphemeralAgent']>>;
        const creating = framework.createEphemeralAgent(this.ephemeralAgentConfig(launch, agentName));
        try {
          created = await Promise.race([creating, cancel.promise]);
        } catch (err) {
          if (err instanceof SubagentTerminated) {
            giveBackWhenCreated(creating, input.name);
            return this.endTerminated(input.name, entry, err, waitedMs, run.started);
          }
          throw err;
        }
        const { agent, contextManager, cleanup } = created;

        // Track depth for recursive fork/spawn calls from this agent
        this.agentDepths.set(agentName, childDepth);

        // Register live state for peek observability
        this.registerLive(input.name, agentName, launch.systemPrompt, contextManager);

        try {
          // What this stream runs on, stated before its first inference: the
          // launch as resolved at the call, then what actually happened here
          // (which inheritance path ran, budget as created, tools now).
          const orient = (inherited: SubagentStart['inherited']): string =>
            this.orientationFor(launch, agent, inherited);
          // Each branch says what its stream must read, in the shape it composed.
          let delivery: LaunchDelivery;
          // Materialise the fork's inherited context structurally:
          //  - locate the parent's matching subagent--fork tool_use by id
          //  - strip sibling fork tool_use blocks (and their tool_results) from
          //    the parent's last assistant turn — they read as fleet-dispatch
          //    evidence and convince the model it's the parent
          //  - rewrite the matching tool_result with intention-stream framing
          //    that names the dual-self situation explicitly
          //  - drop everything after that tool_result (post-fork peek/wait
          //    turns are the other big chunk of parent-coherence signal)
          // If parent context is compressed past the fork point and the
          // matching tool_use can't be located, fall back to wholesale copy
          // plus a synthetic intention-framed fork tool_use/tool_result.
          if (parentAgent) {
            const parentCM = parentAgent.getContextManager();
            // A dry compile: the fork reads the parent's context as a real
            // compile would give it, without committing the parent's fold
            // state or queuing its compression on the parent's behalf. A plan
            // over the budget it compiles at, the manager's default, is
            // returned, where a real compile refused it and failed the fork;
            // the fork's own launch check, a real compile of its own context,
            // still refuses a first context the fork can't use.
            const { messages: compiled } = await Promise.race([
              parentCM.compile(undefined, undefined, { dryRun: true }),
              cancel.promise,
            ]);
            const cutAtCall = orient({ kind: 'cut-at-call' });
            const transformed = callToolUseId
              ? materialiseStructuralFork(
                  compiled,
                  callToolUseId,
                  input.name,
                  input.task,
                  childDepth,
                  this.maxDepth,
                  cutAtCall,
                )
              : null;

            const seen = new Set<string>();
            const addMsg = (msg: { participant: string; content: ContentBlock[] }) => {
              const key = msg.participant + '\0' + JSON.stringify(msg.content);
              if (seen.has(key)) return;
              seen.add(key);
              const participant = msg.participant === parentAgent.name ? agentName : msg.participant;
              contextManager.addMessage(participant, msg.content);
            };

            if (transformed) {
              for (const msg of transformed) addMsg(msg);
              delivery = {
                kind: 'fork-result',
                callId: callToolUseId!,
                head: intentionFramedHead(childDepth, this.maxDepth, cutAtCall),
                task: input.task,
              };
            } else {
              // Fallback path: matching tool_use not located (parent compressed it
              // away, or no callToolUseId). Wholesale copy is safe here because
              // the cascade-bait — the matching fork tool_use and its siblings —
              // got compressed away with the rest of the assistant turn. Append
              // a synthetic intention-framed result so the child still gets the
              // dual-stream framing as the salient last message.
              for (const msg of compiled) addMsg(msg);

              const fallbackForkId = `fork-${input.name}-${crypto.randomUUID()}`;
              const atStart = orient({ kind: 'compiled-at-start', reason: callToolUseId ? 'call-not-in-context' : 'no-call-id' });
              contextManager.addMessage(agentName, [{
                type: 'tool_use',
                id: fallbackForkId,
                name: 'subagent--fork',
                input: { name: input.name, task: input.task },
              }] as ContentBlock[]);
              contextManager.addMessage('user', [{
                type: 'tool_result',
                toolUseId: fallbackForkId,
                toolName: 'subagent--fork',
                content: buildIntentionFramedForkResult(input.name, input.task, childDepth, this.maxDepth, atStart),
              }] as ContentBlock[]);
              delivery = {
                kind: 'fork-result',
                callId: fallbackForkId,
                head: intentionFramedHead(childDepth, this.maxDepth, atStart),
                task: input.task,
              };
            }
          } else {
            // No parent stream: nothing to inherit, and no fork call to
            // answer. The stream still gets its intention and its
            // orientation as its first message, rather than starting with an
            // empty context and no task at all.
            // The orientation and the return instruction, then the task alone,
            // each its own message, as for a spawn, so each has the whole cap
            // and the task check measures the task itself.
            const orientation = `${orient({ kind: 'none', reason: 'no-parent' })}\n\n` +
              'When this intention is complete, return your findings via subagent--return. Your intention for this stream follows.';
            contextManager.addMessage('user', [{ type: 'text', text: orientation }]);
            contextManager.addMessage('user', [{ type: 'text', text: input.task }]);
            delivery = { kind: 'message', orientation, taskBlock: input.task };
          }

          // The stream must read what the launch promises: refuse it when
          // its orientation or its whole task isn't in the launch's compile
          // of its first context. A fork with a call reads its whole task in
          // that call. It's a real compile, as a spawn's is, so an over-budget
          // first context is refused here, before the run starts.
          const { messages } = await Promise.race([contextManager.compile(), cancel.promise]);
          // The race takes compile's result when compiling settles first, so
          // a cancel that lands just after is thrown here: the run ends
          // before its attempt starts, whatever the checks below would find.
          // Nothing below awaits before the attempt's race.
          cancel.throwIfFired();
          const cut = undeliveredLaunchParts(messages, delivery);
          if (cut.length > 0) throw this.launchRefusal('fork', cut, delivery, canSpawn);

          // Pre-validate prompt size
          const tools = framework.getAllTools().filter(t => agent.canUseTool(t.name));
          const est = this.estimatePromptTokens(agent.systemPrompt, messages, tools);
          if (est > this.maxPromptTokens) {
            // A parentless fork carries no conversation, so only a fork with
            // a parent is told it's the cause, and that a spawn leaves it.
            const spawn = this.spawnInstead(canSpawn, true);
            throw new SubagentFailure(
              `it would begin at about ${est} tokens, over this host's limit of ${this.maxPromptTokens}` +
                (parentAgent ? ', because a fork carries your whole conversation' : ''),
              `${spawn.charAt(0).toUpperCase()}${spawn.slice(1)}${parentAgent && canSpawn ? ', though a spawn inherits none of it' : ''}.`,
            );
          }

          // The attempt's setup runs outside the limit's timer; a run whose
          // deadline passed during it isn't started.
          if (deadline !== undefined && Date.now() >= deadline) throw this.timedOut('fork', executionTimeoutMs!);

          // Race execution against both timeout and the run's cancel
          run.started = true;
          let { speech, toolCallsCount } = await Promise.race([
            this.withTimeout(
              framework.runEphemeralToCompletion(agent, contextManager, this.watchdogsFor(deadline)),
              input.name,
              'fork',
              executionTimeoutMs,
              deadline,
              () => this.stopRun(agent),
            ),
            cancel.promise,
          ]);

          // Prefer explicit return over speech capture
          const returned = this.returnedResults.get(input.name);
          if (returned) {
            speech = returned;
            this.returnedResults.delete(input.name);
          } else if (!speech.trim()) {
            speech = this.extractLastAssistantText(contextManager);
          }

          entry.status = 'completed';
          entry.completedAt = Date.now();
          entry.toolCallsCount = toolCallsCount;
          this.onSubagentSuccess();
          const notice = this.concurrencyNotice(waitedMs);
          const finalSummary = notice + speech;
          this.emit(input.name, { type: 'done', summary: finalSummary, lastInputTokens: this.lastInputTokens.get(input.name) });
          return { summary: finalSummary, findings: [], issues: [], toolCallsCount };
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));

          // Non-retryable termination (user cancel, zombie reclaim, etc.).
          // See P1 #4 comment in runSpawn — 'cancelled', not 'completed'.
          if (lastError instanceof SubagentTerminated) return this.endTerminated(input.name, entry, lastError, waitedMs, run.started);

          // The module's own failures end the loop before any words are read.
          if (lastError instanceof SubagentFailure) break;
          // So does a provider's stated wait the framework won't sleep: the
          // run is never tried again, so neither the rate-limit cooldown nor
          // a halved concurrency would serve it.
          if (this.isUnsleptProviderWait(lastError)) break;
          if (this.isRateLimitError(lastError, agentName)) {
            const stopped = await this.waitOrStop(this.onRateLimitHit(deadline), cancel.promise);
            if (stopped) return this.endTerminated(input.name, entry, stopped, waitedMs, run.started);
          }
          if (!this.isTransientError(lastError, agentName) || attempt === this.maxRetries) break;

          const delay = Math.min(5_000 * (attempt + 1), 30_000);
          // A retry starts only if it can start within the run's limit.
          if (deadline !== undefined && Date.now() + delay >= deadline) break;
          console.error(
            `[subagent] ${input.name} attempt ${attempt + 1}/${this.maxRetries + 1} failed: ` +
            `${lastError.message}. Restarting in ${delay}ms...`
          );
          entry.statusMessage = `Retry ${attempt + 1}: ${lastError.message}`;
          const stopped = await this.waitOrStop(delay, cancel.promise);
          if (stopped) return this.endTerminated(input.name, entry, stopped, waitedMs, run.started);
        } finally {
          this.agentDepths.delete(agentName);
          this.unregisterLive(input.name, agentName);
          cleanup();
        }
      }

      entry.status = 'failed';
      entry.completedAt = Date.now();
      entry.statusMessage = lastError!.message;
      throw lastError!;
    } catch (err) {
      // A failure outside an attempt's own handling (the framework refusing
      // to create the agent, say) ends the run too.
      if (entry.status === 'running') {
        entry.status = 'failed';
        entry.completedAt = Date.now();
        entry.statusMessage = err instanceof Error ? err.message : String(err);
      }
      throw this.failedRun(input.name, 'fork', err, run);
    } finally {
      // The slot first, so nothing after it can keep it held.
      this.releaseSlot(slot);
      cancel.dispose();
      this.forgetAttempts(input.name);
      this.persistState();
    }
  }

  /**
   * Extract the last assistant text from a context manager's messages.
   * Fallback when the streaming speech capture is empty (e.g., agent's
   * last action was a tool call, or speech was reset on stream_resumed).
   */
  private extractLastAssistantText(contextManager: ContextManager): string {
    try {
      const messages = contextManager.getAllMessages();
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.participant === 'user' || msg.participant === 'User') continue;
        const texts = msg.content
          .filter((b: ContentBlock) => b.type === 'text')
          .map((b: ContentBlock) => (b as { type: 'text'; text: string }).text);
        if (texts.length > 0) return texts.join('\n');
      }
    } catch {
      // best-effort
    }
    return '(no text output)';
  }

  /** The tool names the process offers now: the board, and each utility's
   *  own allowlist name where the framework lists utilities. What a launch
   *  description can say a stream gets, and all the depth limit keeps. */
  private offeredNames(): Set<string> {
    const framework = this.getFramework();
    // Published older Framework releases have only the collapsed utils surface.
    // The paired permission release exposes each utility's own allowlist name.
    const utilities = (framework as AgentFramework & {
      getAllUtilities?: () => ToolDefinition[];
    }).getAllUtilities?.() ?? [];
    return new Set([...framework.getAllTools(), ...utilities].map((t) => t.name));
  }

  /**
   * Build the allowedTools list for a subagent.
   * Inherits or narrows the caller's tools. At the depth limit it keeps only
   * the tools the process offers now, less the subagent tools.
   */
  private filterToolNames(requestedTools: string[] | undefined, callerDepth: number, parent: Agent | null): 'all' | string[] {
    const inheritedTools = parent?.allowedTools ?? 'all';
    const allowedTools = inheritedTools === 'all'
      ? requestedTools?.slice()
      : (requestedTools === undefined
        ? [...inheritedTools]
        : requestedTools.filter(name => inheritedTools.includes(name)));
    // Always include subagent--return — subagents need it to deliver results
    // A copy: the list may be the caller's own (a spawn's `tools`, or the
    // launch description's), which must keep saying what was asked for.
    const ensureReturn = (list: string[]) =>
      list.includes('subagent--return') ? [...list] : [...list, 'subagent--return'];

    // Use per-agent depth (from caller) rather than the module's static depth
    if (callerDepth + 1 >= this.maxDepth) {
      const filtered = [...this.offeredNames()].filter(name => !name.startsWith('subagent--'));
      if (allowedTools) {
        const allowed = new Set(allowedTools);
        return ensureReturn(filtered.filter(n => allowed.has(n)));
      }
      return ensureReturn(filtered);
    }
    return allowedTools ? ensureReturn(allowedTools) : 'all';
  }

}
