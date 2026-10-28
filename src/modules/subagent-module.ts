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
import { KnowledgeStrategy, formatZonedDateTime, resolveTimeZone, storedInjectionMarkOf } from '@animalabs/agent-framework';
import { compiledWithoutStoredInjections } from '../stored-injection.js';
import { isToolResultContent, isToolUseContent } from '@animalabs/membrane';
import type { ContentBlock } from '@animalabs/membrane';
import { emptyUsage, foldUsageSample, type UsageCounts, type UsageSample } from '../state/stream-usage.js';
import { traceError } from '../state/turn-trace.js';
import { shown } from './shown.js';
import { unknownToolResult } from './unknown-tool.js';
import { hostNoteMetadata } from '../speaker.js';
import { hasFoldLine, systemPromptFor, thinkingBindingSettings } from '../framework-agent-config.js';

export interface SubagentModuleConfig {
  provider?: string;
  formatter?: 'native' | 'anthropic-xml';
  maxDepth?: number;
  currentDepth?: number;
  defaultModel?: string;
  defaultMaxTokens?: number;
  parentAgentName?: string;
  maxConcurrent?: number;
  maxPromptTokens?: number;
  maxExecutionMs?: number;
  maxRetries?: number;
  timeZone?: string;
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

interface AsyncSubagentHandle {
  name: string;
  type: 'spawn' | 'fork';
  promise: Promise<SubagentResult>;
  parentAgentName: string;
}

interface DetachableHandle {
  name: string;
  type: 'spawn' | 'fork';
  promise: Promise<SubagentResult>;
  parentAgentName: string;
  detach: () => void;
}

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

class SubagentFailure extends Error {
  override readonly name = 'SubagentFailure';
  constructor(readonly why: string, readonly remedy = '') {
    super(why);
  }
}

/** setTimeout's longest delay; a longer one fires at once. */
const MAX_TIMER_MS = 2_147_483_647;
const timerDelay = (ms: number): number => Math.min(MAX_TIMER_MS, Math.max(0, ms));
/** How early a timer may fire, by Date.now(): Node's timers can fire up
 *  to 1 ms before the time they were set for. */
const TIMER_SLACK_MS = 2;

const ZOMBIE_THRESHOLD_MS = 120_000;

function duration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${Math.round(ms / 100) / 10} s`;
}

const NOT_DONE: Record<string, string> = {
  spawn: 'Nothing was started',
  fork: 'Nothing was started',
  hud: "The fleet HUD wasn't changed",
  concurrency: "The concurrency limit wasn't changed",
  peek: 'Nothing was shown',
  return: 'Nothing was returned',
};

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
    enabled: 'give true to show the fleet status summary, or false to stop showing it',
  },
};

type DeclaredType = 'string' | 'number' | 'boolean' | 'array';

/** JSON.parse reads a number too large to hold, such as 1e400, as
 *  Infinity. */
function isDeclaredType(value: unknown, declared: DeclaredType): boolean {
  switch (declared) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value) && value.every((item) => typeof item === 'string');
  }
}

const TYPE_WORDS: Record<DeclaredType, string> = {
  string: 'text',
  number: 'a number',
  boolean: 'true or false',
  array: 'a list of names',
};

function inputsOf(input: unknown): Record<string, unknown> | null {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) return null;
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null));
}

function stopLabel(reason: SubagentTerminated['reason']): string {
  switch (reason) {
    case 'cancelled': return 'Stopped by user';
    case 'killed': return "Stopped: its session stopped, as at a session switch or the host's exit";
    case 'zombie': return `Stopped: it showed no activity for over ${duration(ZOMBIE_THRESHOLD_MS)}, so the host reclaimed its slot`;
    default: return 'Stopped';
  }
}

/** agent-framework refuses to create an agent under a name it has seen in
 *  the framework's life, and a retry, or a new run under a name an earlier
 *  run used, can start in the same millisecond as an earlier attempt. */
let lastNameStamp = 0;
function nameStamp(): number {
  lastNameStamp = Math.max(Date.now(), lastNameStamp + 1);
  return lastNameStamp;
}

interface PersistedSubagent {
  name: string;
  type: 'spawn' | 'fork';
  task: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  lastActivityAt: number;
  completedAt?: number;
  toolCallsCount: number;
  findingsCount: number;
  statusMessage?: string;
  parent?: string;
}

export interface ActiveSubagent {
  name: string;
  type: 'spawn' | 'fork';
  task: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  lastActivityAt: number;
  completedAt?: number;
  statusMessage?: string;
  toolCallsCount: number;
  findingsCount: number;
}

interface LiveSubagentState {
  frameworkAgentName: string;
  displayName: string;
  systemPrompt: string;
  contextManager: ContextManager;
  currentStream: string;
  pendingToolCalls: Array<{ name: string; input?: unknown }>;
  activeCallIds: Set<string>;
  requestInFlightSince?: number;
  streamUsage?: UsageCounts;
}

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
  isZombie: boolean;
}

export function buildIntentionFramedForkResult(
  name: string,
  task: string,
  depth: number,
  maxDepth: number,
  orientation?: string,
): string {
  return `${intentionFramedHead(depth, maxDepth, orientation)}\n\nYour intention for this stream: ${task}`;
}

/**
 * The part of a fork's result that must reach the stream whole, so it leads
 * the result: the message cap keeps a message's beginning, and passes the
 * fork's own call, which carries the whole intention, whole.
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

const SUBAGENT_STRATEGY = {
  name: 'knowledge',
  headWindowTokens: 2_000,
  recentWindowTokens: 80_000,
  maxMessageTokens: 10_000,
} as const;
const SUBAGENT_STREAM_TOKENS = 500_000;
const FRAMEWORK_DEFAULT_MAX_TOKENS = 4096;

const UNNAMED_LAUNCHER = 'agent';

// agent-framework stores an injection under participant
// `system_context:<namespace>`.
const FLEET_NAMESPACE = 'subagent-fleet';
const FLEET_PARTICIPANT = `system_context:${FLEET_NAMESPACE}`;
const FLEET_HEADING = /^\[Fleet Status(, as of [^\]]*)?\]$/;

export const SUBAGENT_MESSAGE_CAP = SUBAGENT_STRATEGY.maxMessageTokens;

/**
 * context-manager caps each message in a stream's context alone
 * (SUBAGENT_STRATEGY's maxMessageTokens) and keeps its beginning: past the
 * budget it cuts or drops text, and cuts a string tool result or replaces it
 * with an omission notice, while tool calls and structured results pass
 * whole. So what was stored can still be missing from what the stream reads.
 */
export type LaunchDelivery =
  | { kind: 'message'; orientation: string; taskBlock: string }
  | { kind: 'fork-result'; callId: string; head: string; task: string };

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
  // In a launch's first compile, from a new store, context-manager keeps a
  // fork's call and its result together: its head window doesn't end, nor its
  // recent window start, between a tool call and its result, and its cap
  // passes a tool call whole and keeps every tool result, cut or replaced by
  // an omission notice. So only the cap cuts a result that is there.
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
 *  as its own mode primer (proseModePrimer), since a spawn's orientation is
 *  a user-role message too, where agent-framework found the full grammar
 *  drew a provider's refusal. */
const PROSE_ROUTING_EFFECT: Record<ProseRouting, string> = {
  locus: 'plain text is published to the channel the framework infers for each turn, if there is one',
  explicit: 'plain text is delivered only with a destination prefix line, such as ">>#channel"',
  hybrid: 'unprefixed plain text is published to the channel the framework infers for each turn, if there is one; ' +
    'a leading ">>>destination" envelope routes that text to the destination it names instead',
  disabled: 'plain text is never published, even with a prefix; only explicit send tools reach a channel',
};

function proseRoutingEffect(mode: ProseRouting, shownHelp: boolean): string {
  return PROSE_ROUTING_EFFECT[mode] + (mode === 'explicit' && shownHelp ? '; the prose_help tool shows the syntax' : '');
}

const SLOT_TIMEOUT_MS = 120_000;

export interface SubagentLaunch {
  kind: 'fork' | 'spawn';
  name: string;
  depth: number;
  maxDepth: number;
  forkPoint?: string;
  provider?: string;
  model: string;
  systemPrompt: string;
  systemPromptSource: 'parent' | 'override' | 'caller' | 'default';
  systemPromptFoldLine?: 'added' | 'removed';
  maxTokens: number;
  maxStreamTokens: number;
  strategy: {
    name: string;
    headWindowTokens: number;
    recentWindowTokens: number;
    maxMessageTokens: number;
    compressionModel: string;
  };
  proseRouting?: ProseRouting;
  tools: {
    allowed: 'all' | string[];
    requested?: string[];
    granted?: string[];
    depthLimited: boolean;
  };
  parent: null | {
    stream: string;
    model: string;
    maxTokens: number;
    maxStreamTokens: number;
    contextBudgetTokens: number;
    tailTokens?: number;
    strategy?: string;
    maxMessageTokens?: number;
    allowedTools: 'all' | string[];
  };
  parentAgent: Agent | null;
}

export interface SubagentStart {
  inherited:
    | { kind: 'cut-at-call' }
    | { kind: 'compiled-at-start'; reason: 'call-not-in-context' | 'no-call-id' }
    | { kind: 'none'; reason: 'no-parent' | 'spawn' };
  contextBudgetTokens: number;
  proseRouting: ProseRouting;
  tools: string[];
  parentTools?: string[];
  agentSettings: AgentSettings;
  parentAgentSettings?: AgentSettings;
}

export type AgentSettings = Record<string, string>;

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
  clock?: { intervalSeconds: number; precision?: string } | undefined;
  autoContinue?: { maxConsecutive: number } | undefined;
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
    'auto-continue': agent.autoContinue ? `on (up to ${agent.autoContinue.maxConsecutive} in a row)` : 'off',
  };
}

/** `Agent.clock` keeps only seconds, so the unit the recipe gave can't be
 *  told: an interval reads in minutes when it is whole minutes, else in
 *  seconds. Seconds precision at a whole-minute interval is the one
 *  precision that isn't its interval's default (agent-framework's
 *  resolveClockConfig), so only it is named. */
function clockRows(clock: { intervalSeconds: number; precision?: string }): string {
  const seconds = clock.intervalSeconds;
  if (seconds % 60 !== 0) return `every ${seconds === 1 ? '1 second' : `${seconds} seconds`}`;
  const minutes = seconds / 60;
  const every = `every ${minutes === 1 ? '1 minute' : `${minutes} minutes`}`;
  return clock.precision === 'seconds' ? `${every}, read to the second` : every;
}

const formatTokens = (n: number): string => `${n.toLocaleString('en-US')} tokens`;

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((name) => y.has(name));
}

function joinAll(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const SOME_NAMES = 10;
function joinSome(items: readonly string[]): string {
  if (items.length <= SOME_NAMES) return joinAll(items);
  return `${items.slice(0, SOME_NAMES).join(', ')} and ${items.length - SOME_NAMES} more`;
}

export function toolDifferences(extra: readonly string[], missing: readonly string[]): string {
  const parts: string[] = [];
  if (extra.length > 0) parts.push(`it also has ${joinSome(extra)}`);
  if (missing.length > 0) parts.push(`it doesn't have ${joinAll(missing)}`);
  return parts.join(', and ');
}

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
    settings.push({ name: 'provider connection', same: true, line: `- Provider: ${launch.provider ?? 'not stated by the host'}, on the same connection as ${them}'s.` });
  } else {
    settings.push({ name: 'model', line: `- Model: ${launch.model}.` });
    settings.push({ name: 'provider connection', line: `- Provider: ${launch.provider ?? 'not stated by the host'}.` });
  }

  const foldLine = launch.systemPromptFoldLine === 'added'
    ? ", with the host's paragraph on folds added"
    : launch.systemPromptFoldLine === 'removed'
      ? ", with the host's paragraph on folds taken off"
      : '';
  const promptText: Record<SubagentLaunch['systemPromptSource'], string> = {
    parent: `- System prompt: the parent's${foldLine}.`,
    override: p ? `- System prompt: overridden for this fork${foldLine}.` : `- System prompt: set for this fork${foldLine}.`,
    caller: `- System prompt: supplied by the caller for this spawn${foldLine}.`,
    default: `- System prompt: the default research-assistant prompt${foldLine}.`,
  };
  settings.push({
    name: 'system prompt',
    ...(fork && p ? { same: launch.systemPromptSource === 'parent' && launch.systemPromptFoldLine === undefined } : {}),
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

  const allowed = launch.tools.allowed;
  const requested = launch.tools.requested;
  const callerRules = p?.allowedTools ?? 'all';
  const addsReturn = callerRules !== 'all' && !callerRules.includes('subagent--return');
  const listAddsReturn = requested !== undefined && !requested.includes('subagent--return');
  const granted = launch.tools.granted ?? (allowed === 'all' ? [] : allowed);
  const depth = launch.tools.depthLimited;
  const explicit = launch.proseRouting === 'explicit';
  // prose_help isn't on the board: explicit prose routing shows it to a
  // stream whose rules allow it (agent-framework's
  // availableToolsForPresentation checks canUseTool), so a stream gets
  // it though the process doesn't offer it at the call.
  const shownHelp = explicit && allowed !== 'all' && allowed.includes('prose_help');

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

  const gets = (fromList: string, offeredAt: string): string => {
    if (!shownHelp) {
      return granted.length === 1 ? 'only subagent--return' : `only these ${granted.length}${fromList}${offeredAt}: ${joinAll(granted)}`;
    }
    const offered = granted.length === 1
      ? 'subagent--return, as the process offered it at the call'
      : `${joinAll(granted)}, as the process offered them at the call`;
    return `only these ${granted.length + 1}${fromList}: ${offered}, and prose_help, which explicit prose routing shows`;
  };
  const notGiven = (held: readonly string[]): string[] =>
    [...new Set(held)].filter((name) => !granted.includes(name) && !(shownHelp && name === 'prose_help'));
  let toolRule: string;
  let inherited = false;
  if (allowed === 'all') {
    toolRule = 'no restriction';
  } else if (requested !== undefined) {
    const onlyReturn = granted.length === 1 && !shownHelp;
    toolRule = onlyReturn
      ? `only subagent--return${listAddsReturn ? ', added' : ''}${requested.length === 0 ? ': the caller listed no tools' : ''}`
      : gets(
        ` from the caller's list${listAddsReturn ? ', with subagent--return added' : ''}`,
        ', as the process offered them at the call',
      );
    const missing = notGiven(requested);
    const also = onlyReturn && listAddsReturn ? '' : 'also ';
    if (missing.length > 0) toolRule += `; the caller's list ${also}names ${joinAll(missing)}, which this stream isn't given at the call`;
    if (depth) toolRule += '; at this depth, no subagent tool but subagent--return';
  } else if (callerRules !== 'all') {
    inherited = true;
    const n = callerRules.length;
    toolRule = `${them} is restricted to ${n === 0 ? 'no tools' : n}, and ` +
      (depth
        ? `at this depth it keeps only what the process offers of that at the call, less the subagent tools${addsReturn ? ', with subagent--return added' : ' but subagent--return'}: ${gets('', '')}`
        : `this stream keeps those rules${addsReturn ? ', with subagent--return added' : ''}; it's given ${gets('', ', as the process offered them at the call')}`);
    const missing = notGiven(callerRules);
    if (missing.length > 0) toolRule += `; ${them}'s rules also allow ${joinSome(missing)}, which this stream isn't given at the call`;
  } else {
    toolRule = 'every tool the process offers at the call except the subagent tools, keeping subagent--return: no further forks or spawns at this depth';
  }
  if (p) {
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

export function describeSubagentStart(launch: SubagentLaunch, start: SubagentStart): string {
  const fork = launch.kind === 'fork';
  const p = launch.parent;
  const them = fork ? 'the parent stream' : 'the calling stream';
  const lines = ['At the start of this stream:'];

  const inh = start.inherited;
  if (inh.kind === 'cut-at-call') {
    lines.push(
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

  const ours = start.agentSettings;
  const names = Object.keys(ours);
  const theirSettings = p ? start.parentAgentSettings : undefined;
  if (theirSettings === undefined) {
    lines.push(
      `- Agent settings, the framework's defaults: ${names.map((n) => `${n} ${ours[n]}`).join(', ')}` +
        '.',
    );
  } else {
    const differ = names.filter((n) => theirSettings[n] !== ours[n] || ours[n] === UNREADABLE);
    lines.push(differ.length === 0
      ? `- Agent settings: the framework's defaults, the same as ${them}'s now (${joinAll(names)}).`
      : `- Agent settings not carried from ${them}, so the framework's defaults apply: ` +
          `${differ.map((n) => `${n} ${ours[n]} (${them}'s: ${theirSettings[n]})`).join(', ')}. ` +
          `The rest match: ${joinAll(names.filter((n) => !differ.includes(n)))}.`);
  }

  const mine = start.tools;
  if (!fork || !p || start.parentTools === undefined) {
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

interface MinimalMessage {
  participant: string;
  content: ContentBlock[];
}

export function materialiseStructuralFork(
  compiled: ReadonlyArray<MinimalMessage>,
  callToolUseId: string,
  forkName: string,
  forkTask: string,
  depth: number,
  maxDepth: number,
  orientation?: string,
): MinimalMessage[] | null {
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

  let matchingResultIdx = -1;
  for (let i = forkAssistantIdx + 1; i < compiled.length; i++) {
    const m = compiled[i];
    if (!Array.isArray(m.content)) continue;
    const hit = m.content.some(b => isToolResultContent(b) && b.toolUseId === callToolUseId);
    if (hit) { matchingResultIdx = i; break; }
    if (m.content.some(b => isToolUseContent(b))) break;
  }

  const out: MinimalMessage[] = [];

  for (let i = 0; i < forkAssistantIdx; i++) {
    out.push({ participant: compiled[i].participant, content: compiled[i].content });
  }

  const trimmedAssistantContent = forkAssistantMsg.content
    .filter(b => !(isToolUseContent(b) && b.name === 'subagent--fork' && siblingForkIds.has(b.id)))
    .map((b): ContentBlock => (siblingForkIds.size > 0 && isToolUseContent(b) && b.rawXml !== undefined ? withoutRawXml(b) : b));
  out.push({ participant: forkAssistantMsg.participant, content: trimmedAssistantContent });

  const intentionFramed = buildIntentionFramedForkResult(forkName, forkTask, depth, maxDepth, orientation);
  if (matchingResultIdx >= 0) {
    const matchingMsg = compiled[matchingResultIdx];
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

  return out;
}

function withoutRawXml<T extends { rawXml?: string }>(block: T): T {
  const copy = { ...block };
  delete copy.rawXml;
  return copy;
}

function giveBackWhenCreated(creating: Promise<{ cleanup: () => void }>, name: string): void {
  creating.then(
    (created) => {
      try {
        created.cleanup();
      } catch (err) {
        console.error(`[subagent] ${name}: giving back an agent created after its run was stopped failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    () => { },
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

  private configuredMaxConcurrent: number;
  private effectiveConcurrent: number;
  private heldSlots = new Set<object>();
  private waitQueue: Array<(slot: object) => void> = [];
  private slotOf = new WeakMap<ActiveSubagent, object>();
  private consecutiveSuccesses = 0;
  private throttled = false;
  private rateLimitCooldownMs = 30_000;

  private reaperTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly REAPER_INTERVAL_MS = 60_000;

  private maxPromptTokens: number;

  private maxExecutionMs: number;

  private maxRetries: number;
  private readonly timeZone: string;

  readonly activeSubagents = new Map<string, ActiveSubagent>();

  readonly parentMap = new Map<string, string>();

  private readonly launcherShownOf = new Map<string, string>();

  private returnedResults = new Map<string, string | undefined>();

  private liveSubagents = new Map<string, LiveSubagentState>();
  private frameworkNameIndex = new Map<string, string>();
  private runOfAttempt = new Map<string, string>();
  private callIdIndex = new Map<string, string>();
  private streamSubscribers = new Map<string, Set<SubagentStreamCallback>>();
  private lastInputTokens = new Map<string, number>();
  private cancellationHandles = new Map<string, { reject: (err: Error) => void }>();
  private agentDepths = new Map<string, number>();

  constructor(config: SubagentModuleConfig = {}) {
    this.config = config;
    this.maxDepth = config.maxDepth ?? 3;
    this.currentDepth = config.currentDepth ?? 0;
    this.configuredMaxConcurrent = config.maxConcurrent ?? 5;
    this.effectiveConcurrent = this.configuredMaxConcurrent;
    this.maxPromptTokens = config.maxPromptTokens ?? 190_000;
    this.maxExecutionMs = config.maxExecutionMs ?? 600_000;
    this.maxRetries = config.maxRetries ?? 2;
    this.timeZone = resolveTimeZone(config.timeZone);
  }

  setFramework(framework: AgentFramework): void {
    this.framework = framework;

    framework.onTrace((event: TraceEvent) => {
      const agentName = 'agentName' in event ? (event as { agentName: string }).agentName : null;

      if (agentName) {
        const displayName = this.frameworkNameIndex.get(agentName);
        if (!displayName) return;
        const live = this.liveSubagents.get(displayName);
        if (!live) return;

        const sa = this.runningEntry(displayName);
        if (sa) sa.lastActivityAt = Date.now();

        if ((event as { type: string }).type === 'inference:usage') {
          this.noteUsageSample(live, (event as { tokenUsage?: UsageSample }).tokenUsage);
          return;
        }

        switch (event.type) {
          case 'inference:started':
            live.currentStream = '';
            live.pendingToolCalls = [];
            live.activeCallIds.clear();
            live.requestInFlightSince = Date.now();
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
    this.restoreFromStore();

    this.reaperTimer = setInterval(() => {
      try {
        const reclaimed = this.reclaimZombieSlots();
        if (reclaimed > 0) {
          this.persistState();
        }
      } catch (error) {
        console.error('[subagent] periodic reaper error:', error);
      }
    }, SubagentModule.REAPER_INTERVAL_MS);
    if (typeof (this.reaperTimer as { unref?: () => void }).unref === 'function') {
      (this.reaperTimer as { unref: () => void }).unref();
    }
  }

  async stop(): Promise<void> {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
    // framework.stop() rejects every ephemeral run before it stops modules,
    // so no attempt is live here.
    for (const name of [...this.cancellationHandles.keys()]) this.stopTree(name, 'killed');
    this.ctx = null;
  }

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
    // setState replaces the module's state, so the rest of it, such as
    // the hud tool's hudEnabled, is carried over.
    this.ctx.setState({ ...(this.ctx.getState<Record<string, unknown>>() ?? {}), agents });
  }

  restoreFromStore(): void {
    if (!this.ctx) return;
    const persisted = this.ctx.getState<{ agents?: Record<string, PersistedSubagent> }>();
    if (!persisted?.agents) return;

    this.activeSubagents.clear();
    this.parentMap.clear();
    this.launcherShownOf.clear();

    for (const [key, pa] of Object.entries(persisted.agents)) {
      const sa: ActiveSubagent = {
        name: pa.name,
        type: pa.type,
        task: pa.task,
        status: pa.status === 'running' ? 'cancelled' : pa.status,
        startedAt: pa.startedAt,
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
              description: 'Tool names the subagent can use (default: inherit the caller\'s allowed tools). An explicit list can only narrow the caller\'s tools. To give the subagent a tool from the built-in "settings" toolset, list toolsets--open, toolsets--act and the tool\'s own name (module--name). Note: subagent--return is always included automatically.',
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
        description: 'Toggle the subagent fleet HUD. When enabled, a compact status of the subagents running or waiting is added to your context, and again at your next start after one starts or ends. Disabling it stops new ones; a status already in your context stays there, as history.',
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
        const result = input.result as string | undefined;
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
    if (event.type === 'inference-request' && 'source' in event && event.source === 'subagent') {
      return { requestInference: [(event as { agentName: string }).agentName] };
    }
    return {};
  }

  async gatherContext(agentName: string): Promise<import('@animalabs/context-manager').ContextInjection[]> {
    if (!this.ctx) return [];
    const persisted = this.ctx.getState<{ hudEnabled?: boolean }>() ?? {};
    if (!persisted.hudEnabled) return [];

    const allowed = this.scopeOf(agentName);

    // agent-framework stores this status in the agent's window, and stores it
    // again only when its text differs from the newest copy: one a start stored
    // that no request has sent, or else what the last request rendered.
    const lines: string[] = [];
    const scoped = [...this.activeSubagents.values()].filter((sa) => allowed.has(sa.name));
    let latestChange: number | undefined;
    for (const sa of scoped) {
      const changedAt = sa.completedAt ?? sa.startedAt;
      if (latestChange === undefined || changedAt > latestChange) latestChange = changedAt;
    }
    const asOfDay = latestChange !== undefined ? this.clockDay(latestChange) : undefined;
    for (const sa of scoped) {
      if (sa.status !== 'running') continue;
      const parent = this.parentMap.get(sa.name) ?? 'agent';
      const parentShort = this.launcherShownOf.get(sa.name) ?? parent;
      const task = sa.task.length > 50 ? sa.task.slice(0, 47) + '...' : sa.task;
      const startDay = this.clockDay(sa.startedAt);
      const since = startDay === asOfDay ? this.clockTime(sa.startedAt) : `${startDay} ${this.clockTime(sa.startedAt)}`;
      lines.push(`  ${sa.name} [${sa.type}] running since ${since} parent:${parentShort} "${task}"`);
    }

    for (const [name] of this.asyncHandles) {
      if (!allowed.has(name)) continue;
      if (!this.runningEntry(name)) lines.push(`  ${name} [async] pending`);
    }

    if (lines.length === 0) {
      if (!this.newestStatusListsRun(agentName)) return [];
      lines.push('  (none running)');
    }

    const asOf = latestChange !== undefined ? `, as of ${asOfDay} ${this.clockTime(latestChange)} ${this.timeZone}` : '';
    return [{
      namespace: FLEET_NAMESPACE,
      position: 'afterUser',
      content: [{ type: 'text', text: `[Fleet Status${asOf}]\n${lines.join('\n')}` }],
    }];
  }

  // context-manager stores a long status in shards, in order, each carrying
  // the mark, so the newest row is its last shard, whose lines are runs'
  // whenever the status lists one.
  private newestStatusListsRun(agentName: string): boolean {
    const rows = this.ctx!.queryMessages({ participant: FLEET_PARTICIPANT }, { forAgent: agentName }).messages;
    for (let i = rows.length - 1; i >= 0; i--) {
      const mark = storedInjectionMarkOf(rows[i]!.metadata);
      if (mark?.namespace !== FLEET_NAMESPACE || mark.agent !== agentName) continue;
      const text = rows[i]!.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
      return text.split('\n').some((line) => {
        const shown = line.trim();
        return shown !== '' && !FLEET_HEADING.test(shown) && shown !== '(none running)';
      });
    }
    return false;
  }

  private clockTime(at: number): string {
    return formatZonedDateTime(at, this.timeZone).slice(11, 19);
  }

  private clockDay(at: number): string {
    return formatZonedDateTime(at, this.timeZone).slice(0, 10);
  }

  private async acquireSlot(
    kind: 'spawn' | 'fork',
    slotTimeoutMs = SLOT_TIMEOUT_MS,
    cancelled?: Promise<never>,
    ticket?: { queued: boolean },
  ): Promise<{ waitedMs: number; slot: object }> {
    if (this.activeConcurrent < this.effectiveConcurrent) return { waitedMs: 0, slot: this.takeSlot() };

    this.reclaimZombieSlots();
    if (this.activeConcurrent < this.effectiveConcurrent) return { waitedMs: 0, slot: this.takeSlot() };

    if (ticket) ticket.queued = true;
    const startWait = Date.now();
    return new Promise<{ waitedMs: number; slot: object }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.reclaimZombieSlots();
        const idx = this.waitQueue.indexOf(onSlot);
        if (idx < 0) return;
        this.waitQueue.splice(idx, 1);

        const holders = this.describeSlotHolders();
        const holderLines = holders.length > 0
          ? `\nSlots held by:\n${holders.map(h => `  - ${h}`).join('\n')}`
          : '';
        const others = this.waitQueue.length;
        const holder = holders.length > 0 ? 'one of the subagents below' : 'a running subagent';
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
      cancelled?.catch((err: unknown) => {
        const idx = this.waitQueue.indexOf(onSlot);
        if (idx < 0) return;
        this.waitQueue.splice(idx, 1);
        clearTimeout(timer);
        reject(err);
      });
    });
  }

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

  private reclaimZombieSlots(): number {
    let reclaimed = 0;

    for (const [displayName, live] of this.liveSubagents) {
      const entry = this.runningEntry(displayName);
      if (!entry) continue;

      const silentMs = Date.now() - entry.lastActivityAt;
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

        try {
          const agent = this.getFramework().getAgent(live.frameworkAgentName);
          if (agent) this.stopRun(agent);
        } catch { }

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

        entry.status = 'cancelled';
        entry.completedAt = Date.now();
        entry.statusMessage = 'zombie — slot reclaimed';

        const slot = this.slotOf.get(entry);
        if (slot) this.releaseSlot(slot);
        reclaimed++;
      }
    }

    return reclaimed;
  }

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

  private releaseSlot(slot: object): void {
    if (!this.heldSlots.delete(slot)) return;
    this.admitWaiters();
  }

  private admitWaiters(): void {
    while (this.waitQueue.length > 0 && this.activeConcurrent < this.effectiveConcurrent) {
      this.waitQueue.shift()!(this.takeSlot());
    }
  }

  private stopRun(agent: Agent): void {
    agent.cancelStream();
  }

  private concurrencyNotice(waitedMs: number): string {
    if (waitedMs <= 0) return '';
    const secs = (waitedMs / 1000).toFixed(1);
    return `[Concurrency notice: this agent waited ${secs}s for a slot ` +
      `(${this.effectiveConcurrent} concurrent limit). ` +
      `To avoid delays, limit parallel forks/spawns to ${this.effectiveConcurrent}.]\n\n`;
  }

  private onSubagentSuccess(): void {
    this.consecutiveSuccesses++;
    if (this.consecutiveSuccesses >= 3 && this.effectiveConcurrent < this.configuredMaxConcurrent) {
      this.effectiveConcurrent++;
      this.consecutiveSuccesses = 0;
    }
    if (this.effectiveConcurrent >= this.configuredMaxConcurrent) this.throttled = false;
    this.admitWaiters();
  }

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

  private cancelFor(name: string): { promise: Promise<never>; throwIfFired(): void; dispose(): void } {
    let reject!: (err: Error) => void;
    let fired: Error | null = null;
    const promise = new Promise<never>((_, r) => { reject = r; });
    promise.catch(() => { });
    const handle = { reject: (err: Error) => { fired ??= err; reject(err); } };
    this.cancellationHandles.set(name, handle);
    return {
      promise,
      throwIfFired: () => { if (fired) throw fired; },
      dispose: () => { this.cancellationHandles.delete(name); },
    };
  }

  private endTerminated(name: string, entry: ActiveSubagent, err: SubagentTerminated, waitedMs: number, started: boolean): SubagentResult {
    entry.status = 'cancelled';
    entry.completedAt = Date.now();
    entry.statusMessage = err.reason;
    const notice = this.concurrencyNotice(waitedMs);
    const output = err.partialOutput || (started ? '(no output yet)' : '(no output: it was stopped before its run began, so nothing ran)');
    const summary = notice + `[${stopLabel(err.reason)}] ` + output;
    this.emit(name, { type: 'done', summary, lastInputTokens: this.lastInputTokens.get(name) });
    return { summary, findings: [], issues: [], toolCallsCount: entry.toolCallsCount };
  }

  private claimName(name: string, parent: string | undefined): void {
    this.lastInputTokens.delete(name);
    if (parent) {
      this.parentMap.set(name, parent);
      this.launcherShownOf.set(name, this.shownName(parent));
    } else {
      this.unlinkParent(name);
    }
  }

  private unlinkParent(name: string): void {
    this.parentMap.delete(name);
    this.launcherShownOf.delete(name);
  }

  private forgetAttempts(name: string): void {
    for (const [agentName, run] of this.runOfAttempt) if (run === name) this.runOfAttempt.delete(agentName);
  }

  private endQueued(name: string, err: SubagentTerminated): SubagentResult {
    const summary = `[${stopLabel(err.reason)}] (no output: it was still waiting for a concurrency slot, and never started)`;
    this.emit(name, { type: 'done', summary });
    return { summary, findings: [], issues: [], toolCallsCount: 0 };
  }

  /** agent-framework quotes the ephemeral agent's name in its own messages
   *  ("Ephemeral agent \"spawn-migrate-…\" failed to start inference …"), and
   *  the name is the agent's choice, so it's taken out before the classifiers
   *  read the words. */
  private classifiedText(err: Error, agentName?: string): string {
    const text = agentName ? err.message.split(agentName).join('') : err.message;
    return text.toLowerCase();
  }

  private isRateLimitError(err: unknown, agentName?: string): boolean {
    if (!(err instanceof Error)) return false;
    const msg = this.classifiedText(err, agentName);
    return /(?<![a-z])rate[\s_-]?(limit|exceeded)/.test(msg)
      || /\b429\b/.test(msg)
      || /too many (\w+ )?requests/.test(msg);
  }

  /** agent-framework rejects a run whose provider asked for a wait it won't
   *  sleep with its ProviderWaitNotSleptError, read here by its name, which a
   *  second copy of the package gives its own class too. */
  private isUnsleptProviderWait(err: Error): boolean {
    return err.name === 'ProviderWaitNotSleptError';
  }

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
      /\b(500|502|503|529)\b/.test(msg) ||
      this.isRateLimitError(err, agentName)
    );
  }

  setConcurrency(n: number): void {
    this.configuredMaxConcurrent = Math.max(1, n);
    if (!this.throttled || this.effectiveConcurrent > this.configuredMaxConcurrent) {
      this.effectiveConcurrent = this.configuredMaxConcurrent;
    }
    if (this.effectiveConcurrent >= this.configuredMaxConcurrent) this.throttled = false;
    this.admitWaiters();
  }

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

  cancelSubagent(displayName: string): boolean {
    const found = this.cancellationHandles.has(displayName);
    this.stopTree(displayName);
    return found;
  }

  isSubagentAgent(frameworkAgentName: string): boolean {
    return this.frameworkNameIndex.has(frameworkAgentName);
  }

  cancelAll(): number {
    let count = 0;
    for (const name of [...this.cancellationHandles.keys()]) count += this.stopTree(name);
    return count;
  }

  private stopTree(displayName: string, reason: 'cancelled' | 'killed' = 'cancelled'): number {
    let stopped = 0;
    for (const child of this.childrenOf(displayName)) stopped += this.stopTree(child, reason);

    const handle = this.cancellationHandles.get(displayName);
    if (!handle) return stopped;

    const live = this.liveSubagents.get(displayName);
    const partial = live?.currentStream ?? '';
    if (live) {
      try {
        const agent = this.getFramework().getAgent(live.frameworkAgentName);
        if (agent) this.stopRun(agent);
      } catch { }
    }

    const cause = reason === 'cancelled' ? 'cancelled by user' : 'stopped as its module stopped';
    handle.reject(new SubagentTerminated(reason, partial, `Subagent "${displayName}" ${cause}`));
    this.cancellationHandles.delete(displayName);
    return stopped + 1;
  }

  private getDescendantDisplayNames(rootFrameworkAgentName: string): Set<string> {
    const result = new Set<string>();
    this.collectDescendants(rootFrameworkAgentName, this.runOfAttempt.get(rootFrameworkAgentName), result);
    return result;
  }

  private collectDescendants(attempt: string | undefined, run: string | undefined, into: Set<string>): void {
    const goingOn = new Set(this.runOfAttempt.values());
    const pending: Array<{ attempt: string | undefined; run: string | undefined }> = [{ attempt, run }];
    while (pending.length > 0) {
      const next = pending.shift()!;
      for (const [child, parent] of this.parentMap) {
        if (into.has(child)) continue;
        const launched = parent === next.attempt || (next.run !== undefined && this.runOfAttempt.get(parent) === next.run);
        if (!launched) continue;
        into.add(child);
        if (goingOn.has(child)) pending.push({ attempt: undefined, run: child });
      }
    }
  }

  private scopeOf(agentFrameworkName: string): Set<string> {
    const scope = this.getDescendantDisplayNames(agentFrameworkName);
    if (agentFrameworkName !== this.config.parentAgentName) return scope;
    const goingOn = new Set(this.runOfAttempt.values());
    for (const child of this.orphanedRuns()) {
      if (scope.has(child)) continue;
      scope.add(child);
      if (goingOn.has(child)) this.collectDescendants(undefined, child, scope);
    }
    return scope;
  }

  private orphanedRuns(): string[] {
    if (!this.ctx) return [];
    const listed = new Set(this.ctx.getAgents().map((agent) => agent.name));
    const orphans: string[] = [];
    for (const [child, parent] of this.parentMap) {
      if (!listed.has(parent) && !this.runOfAttempt.has(parent)) orphans.push(child);
    }
    return orphans;
  }

  private childrenOf(displayName: string): string[] {
    const children: string[] = [];
    for (const [childName, parentFrameworkName] of this.parentMap) {
      if (this.runOfAttempt.get(parentFrameworkName) === displayName) children.push(childName);
    }
    return children;
  }

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
    const live = this.liveSubagents.get(displayName);
    if (live) {
      for (const callId of live.activeCallIds) {
        this.callIdIndex.delete(callId);
      }
    }
    this.liveSubagents.delete(displayName);
    this.frameworkNameIndex.delete(frameworkAgentName);
  }

  private noteUsageSample(live: LiveSubagentState, sample: UsageSample | undefined): void {
    if (!sample) return;
    const step = foldUsageSample(live.streamUsage, sample);
    live.streamUsage = step.total;
    if (step.prompt !== undefined) this.lastInputTokens.set(live.displayName, step.prompt);
  }

  private emit(displayName: string, event: SubagentStreamEvent): void {
    for (const key of [displayName, '*']) {
      const subs = this.streamSubscribers.get(key);
      if (!subs) continue;
      for (const cb of subs) {
        try { cb(event); } catch { }
      }
    }
  }

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

  async peek(name?: string, callerFrameworkAgentName?: string): Promise<SubagentPeekSnapshot[]> {
    const allowed = callerFrameworkAgentName
      ? this.scopeOf(callerFrameworkAgentName)
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

    const entry = this.runningEntry(displayName);

    let messageCount = 0;
    let lastMessageSnippet = '';
    try {
      // A dry compile: unlike a real one, it commits none of the stream's fold
      // state, queues no compression, and returns a plan over the budget it
      // compiles at rather than refusing it.
      const compiled = await live.contextManager.compile(undefined, undefined, { dryRun: true });
      const said = compiledWithoutStoredInjections(compiled);
      messageCount = said.length;
      if (said.length > 0) {
        const last = said[said.length - 1];
        const textBlocks = last.content
          .filter((b: ContentBlock) => b.type === 'text')
          .map((b: ContentBlock) => (b as { type: 'text'; text: string }).text);
        const fullText = textBlocks.join(' ');
        lastMessageSnippet = fullText.length > 500 ? fullText.slice(-500) : fullText;
      }
    } catch {
    }

    const elapsedMs = entry ? Date.now() - entry.startedAt : 0;

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

  private resolveMaxTokens(callMaxTokens: number | undefined, parentAgentName?: string): number {
    if (callMaxTokens !== undefined) return callMaxTokens;
    if (this.config.defaultMaxTokens !== undefined) return this.config.defaultMaxTokens;
    const parentName = parentAgentName ?? this.config.parentAgentName;
    if (parentName) {
      const parent = this.framework?.getAgent(parentName);
      if (parent) return parent.maxTokens;
    }
    return FRAMEWORK_DEFAULT_MAX_TOKENS;
  }

  /** agent-framework's startup watchdog for an attempt ends no later than the
   *  deadline (watchdogsFor), and its timer can fire before this one, so a
   *  failure at the deadline is reported as the time limit, whichever settled
   *  it. */
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

  private timedOut(kind: 'spawn' | 'fork', limitMs: number): SubagentFailure {
    return new SubagentFailure(
      `its time limit of ${duration(limitMs)} ran out`,
      `To give it longer, call subagent--${kind} again with a larger timeoutMs; an async ${kind} with no timeoutMs has no limit.`,
    );
  }

  /** agent-framework rejects an attempt whose inference hasn't started within
   *  its startup watchdog, 30 s unless given, so one held past the deadline
   *  (behind a provider wait, say) is rejected rather than started after the
   *  run was reported timed out. */
  private watchdogsFor(deadline: number | undefined): { startupTimeoutMs: number } | undefined {
    if (deadline === undefined) return undefined;
    return { startupTimeoutMs: Math.max(1, Math.min(30_000, deadline - Date.now())) };
  }

  private estimatePromptTokens(
    systemPrompt: string,
    messages: Array<{ content: ContentBlock[] }>,
    tools: ToolDefinition[],
  ): number {
    let tokens = Math.ceil(systemPrompt.length / 4) + 50;

    for (const msg of messages) {
      tokens += 50;
      for (const block of msg.content) {
        tokens += Math.ceil(JSON.stringify(block).length / 4);
      }
    }

    for (const tool of tools) {
      tokens += 100;
      tokens += Math.ceil(JSON.stringify(tool).length / 4);
    }

    return tokens;
  }

  private resolveLaunch(
    kind: 'fork' | 'spawn',
    input: ForkInput | SpawnInput,
    callerAgentName: string | undefined,
    callerDepth: number,
    callToolUseId?: string,
  ): SubagentLaunch {
    const framework = this.getFramework();
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
    } else if (
      input.systemPrompt !== undefined
      && (!parentAgent || systemPromptFor(input.systemPrompt, model, this.config.formatter) !== systemPromptFor(parentAgent.systemPrompt, model, this.config.formatter))
    ) {
      systemPrompt = input.systemPrompt;
      systemPromptSource = 'override';
    } else if (parentAgent) {
      systemPrompt = parentAgent.systemPrompt;
      systemPromptSource = 'parent';
    } else {
      systemPrompt = NO_PARENT_SYSTEM_PROMPT;
      systemPromptSource = 'default';
    }

    const given = systemPromptFor(systemPrompt, model, this.config.formatter);

    const requestedTools = kind === 'spawn' ? (input as SpawnInput).tools : undefined;
    const allowed = this.filterToolNames(requestedTools, callerDepth, parentAgent);
    const offered = this.offeredNames();

    let parentStrategy: string | undefined;
    let parentMessageCap: number | undefined;
    try {
      const strategy = parentAgent?.getContextManager().getStrategy() as
        { name?: unknown; maxMessageTokens?: unknown } | undefined;
      if (typeof strategy?.name === 'string') parentStrategy = strategy.name;
      if (typeof strategy?.maxMessageTokens === 'number') parentMessageCap = strategy.maxMessageTokens;
    } catch { }
    const parentRuntime = parentAgent?.getRuntimeSettings();

    // Without a caller, the stream takes agent-framework's default, 'locus'.
    const proseRouting = parentAgent?.proseRouting;
    return {
      kind,
      name: input.name,
      depth: callerDepth + 1,
      maxDepth: this.maxDepth,
      ...(kind === 'fork' && callToolUseId ? { forkPoint: callToolUseId } : {}),
      ...(this.config.provider !== undefined ? { provider: this.config.provider } : {}),
      model,
      systemPrompt: given,
      systemPromptSource,
      ...(hasFoldLine(given) !== hasFoldLine(systemPrompt)
        ? { systemPromptFoldLine: hasFoldLine(given) ? 'added' as const : 'removed' as const }
        : {}),
      maxTokens: this.resolveMaxTokens(input.maxTokens, callerAgentName),
      maxStreamTokens: SUBAGENT_STREAM_TOKENS,
      strategy: { ...SUBAGENT_STRATEGY, compressionModel: model },
      ...(proseRouting !== undefined ? { proseRouting } : {}),
      tools: {
        allowed: allowed === 'all' ? 'all' : [...allowed],
        ...(requestedTools !== undefined ? { requested: [...requestedTools] } : {}),
        ...(allowed !== 'all' ? { granted: [...new Set(allowed)].filter((name) => name === 'subagent--return' || offered.has(name)) } : {}),
        depthLimited: this.atDepthLimit(callerDepth),
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

  private ephemeralAgentConfig(launch: SubagentLaunch, agentName: string) {
    return {
      name: agentName,
      model: launch.model,
      systemPrompt: launch.systemPrompt,
      maxTokens: launch.maxTokens,
      ...(launch.proseRouting !== undefined ? { proseRouting: launch.proseRouting } : {}),
      maxStreamTokens: launch.maxStreamTokens,
      ...thinkingBindingSettings(launch.model, launch.provider),
      strategy: new KnowledgeStrategy({
        headWindowTokens: launch.strategy.headWindowTokens,
        recentWindowTokens: launch.strategy.recentWindowTokens,
        compressionModel: launch.strategy.compressionModel,
        autoTickOnNewMessage: true,
        maxMessageTokens: launch.strategy.maxMessageTokens,
        summaryParticipant: agentName,
      }),
      allowedTools: launch.tools.allowed === 'all' ? 'all' as const : [...launch.tools.allowed],
    };
  }

  /**
   * agent-framework builds an agent's tool list from the shared board filtered
   * by its permissions, less what its own toolsets present out of the list
   * (the built-in "settings" toolset and servers shown as tabs, from 0.29.0;
   * presentedTools), plus prose_help under explicit prose routing when they
   * allow it (availableToolsForPresentation). It reads the board again when it
   * assembles the first request, and it lists an ephemeral agent only once its
   * run starts, so listToolClasses can't be asked yet.
   */
  private streamSurface(agent: { name?: string; canUseTool(name: string): boolean; proseRouting: ProseRouting }): string[] {
    const framework = this.getFramework();
    let tools = framework.getAllTools().filter((t) => agent.canUseTool(t.name));
    if (agent.name) {
      const canUseMeta = agent.canUseTool('toolsets--open') && agent.canUseTool('toolsets--act');
      tools = framework.presentedTools(agent.name, tools, canUseMeta);
    }
    const names = tools.map((t) => t.name);
    if (agent.proseRouting === 'explicit' && agent.canUseTool('prose_help')) names.push('prose_help');
    return names;
  }

  private spawnInstead(canSpawn: boolean, withCap = false): string {
    if (!canSpawn) return "do it in this stream instead, since subagent--spawn isn't among your tools";
    const cap = withCap ? ` (${formatTokens(SUBAGENT_STRATEGY.maxMessageTokens)})` : '';
    return 'launch it as subagent--spawn instead, with a name, a systemPrompt, a short tools list and a task ' +
      `that fits one message${cap} and says what it needs to know`;
  }

  private launchRefusal(
    kind: 'spawn' | 'fork',
    cut: ReadonlyArray<'orientation' | 'task' | 'call'>,
    delivery: LaunchDelivery,
    canSpawn: boolean,
  ): SubagentFailure {
    const inheritsContext = delivery.kind === 'fork-result' && canSpawn;
    const cap = formatTokens(SUBAGENT_STRATEGY.maxMessageTokens);
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
    const parentAgent = launch.parentAgent;
    if (launch.parent && parentAgent) {
      if (framework.getAgent(parentAgent.name) === parentAgent) {
        try {
          parentTools = framework.listToolClasses(parentAgent.name).map((t) => t.tool);
        } catch { }
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

    const launcher = callerAgentName ?? this.config.parentAgentName;
    const parentAgentName = launcher ?? UNNAMED_LAUNCHER;
    const launcherShown = launcher === undefined ? undefined : this.shownName(launcher);
    let launch: SubagentLaunch;
    try {
      launch = this.resolveLaunch('spawn', input, callerAgentName, callerDepth);
    } catch (error) {
      return { success: false, isError: true, error: error instanceof Error ? error.message : String(error) };
    }
    const ticket = { queued: false };

    const inUse = this.nameInUse(input.name);
    if (inUse) return inUse;

    if (input.sync) {
      const promise = this.runSpawn(launch, input, callerAgentName, callerDepth, undefined, ticket);
      return await this.runDetachable(input.name, 'spawn', promise, launcher, input.timeoutMs ?? this.maxExecutionMs, launch);
    }

    const promise = this.runSpawn(launch, input, callerAgentName, callerDepth, input.timeoutMs, ticket);
    this.asyncHandles.set(input.name, { name: input.name, type: 'spawn', promise, parentAgentName });

    promise
      .then(
        result => this.deliverAsyncResult(input.name, result, launcher, launcherShown),
        err => this.deliverAsyncError(input.name, err, launcher, launcherShown),
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

    const launcher = callerAgentName ?? this.config.parentAgentName;
    const parentAgentName = launcher ?? UNNAMED_LAUNCHER;
    const launcherShown = launcher === undefined ? undefined : this.shownName(launcher);
    let launch: SubagentLaunch;
    try {
      launch = this.resolveLaunch('fork', input, callerAgentName, callerDepth, callToolUseId);
    } catch (error) {
      return { success: false, isError: true, error: error instanceof Error ? error.message : String(error) };
    }
    const ticket = { queued: false };

    const inUse = this.nameInUse(input.name);
    if (inUse) return inUse;

    if (input.sync) {
      const promise = this.runFork(launch, input, callerAgentName, callerDepth, undefined, callToolUseId, ticket);
      return await this.runDetachable(input.name, 'fork', promise, launcher, input.timeoutMs ?? this.maxExecutionMs, launch);
    }

    const promise = this.runFork(launch, input, callerAgentName, callerDepth, input.timeoutMs, callToolUseId, ticket);
    this.asyncHandles.set(input.name, { name: input.name, type: 'fork', promise, parentAgentName });

    promise
      .then(
        result => this.deliverAsyncResult(input.name, result, launcher, launcherShown),
        err => this.deliverAsyncError(input.name, err, launcher, launcherShown),
      )
      .catch(err => console.error(`[subagent] delivering ${input.name}'s result: ${err instanceof Error ? err.message : String(err)}`));

    // runFork ran synchronously up to its slot wait, so `ticket` already
    // says whether this launch is starting or queued.
    return { success: true, data: this.launchReceipt(launch, `Subagent '${input.name}' accepted as a fork.`, ticket) };
  }

  private shownName(agentName: string): string {
    return this.runOfAttempt.get(agentName) ?? agentName;
  }

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

  private deliverAsyncResult(name: string, result: SubagentResult, launcher: string | undefined, launcherShown = launcher): void {
    this.asyncHandles.delete(name);
    if (!this.ctx) return;

    const wake = this.addForLauncher(launcher, launcherShown, name, 'returned', result.summary);
    if (wake === null) return;
    this.ctx.pushEvent({
      type: 'inference-request',
      agentName: wake,
      reason: `subagent-completed:${name}`,
      source: 'subagent',
    });
  }

  private deliverAsyncError(name: string, err: unknown, launcher: string | undefined, launcherShown = launcher): void {
    this.asyncHandles.delete(name);
    if (!this.ctx) return;

    const message = err instanceof Error ? err.message : String(err);
    const wake = this.addForLauncher(launcher, launcherShown, name, 'failed', `Error: ${message}`);
    if (wake === null) return;
    this.ctx.pushEvent({
      type: 'inference-request',
      agentName: wake,
      reason: `subagent-failed:${name}`,
      source: 'subagent',
    });
  }

  private addForLauncher(launcher: string | undefined, launcherShown: string | undefined, name: string, outcome: 'returned' | 'failed', body: string): string | null {
    const ctx = this.ctx!;
    const say = (forWhom: string, forAgent?: string): void => {
      const content = [{ type: 'text' as const, text: `[Subagent '${name}' ${outcome}${forWhom}]\n\n${body}` }];
      const note = hostNoteMetadata(`subagent-${outcome}`);
      if (forAgent !== undefined) ctx.addMessage('user', content, note, { forAgent });
      else ctx.addMessage('user', content, note);
    };
    // The empty name is none, as claimName reads it, and agent-framework
    // refuses it as a write's target even where an agent is registered under it.
    if (launcher === undefined || launcher === '') {
      say('');
      return UNNAMED_LAUNCHER;
    }
    const listed = new Set(ctx.getAgents().map((agent) => agent.name));
    const shown = launcherShown ?? launcher;
    if (listed.has(launcher)) {
      say(launcher === this.config.parentAgentName ? '' : `, for '${shown}'`, launcher);
      return launcher;
    }
    // agent-framework lists an attempt's agent only while that attempt runs,
    // and refuses a write for an agent it doesn't list.
    const run = this.runOfAttempt.get(launcher);
    if (run !== undefined) {
      const current = this.liveSubagents.get(run)?.frameworkAgentName;
      if (current !== undefined && listed.has(current)) {
        say(`, for '${shown}': launched by an earlier attempt`, current);
        return current;
      }
      say(`, for '${shown}': launched by an attempt that has ended`);
      return null;
    }
    say(`, for '${shown}', which has ended`);
    return null;
  }

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

  private async runDetachable(
    name: string,
    type: 'spawn' | 'fork',
    promise: Promise<SubagentResult>,
    launcher: string | undefined,
    autoDetachMs?: number,
    launch?: SubagentLaunch,
  ): Promise<ToolResult> {
    const launchText = launch ? describeSubagentLaunch(launch) : undefined;
    const parentAgentName = launcher ?? UNNAMED_LAUNCHER;
    const launcherShown = launcher === undefined ? undefined : this.shownName(launcher);
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

      this.asyncHandles.set(name, { name, type, promise, parentAgentName });
      promise
        .then(
          result => this.deliverAsyncResult(name, result, launcher, launcherShown),
          err => this.deliverAsyncError(name, err, launcher, launcherShown),
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

  detachSubagent(name: string): boolean {
    const handle = this.detachableHandles.get(name);
    if (!handle) return false;
    handle.detach();
    return true;
  }

  detachAll(): number {
    let count = 0;
    for (const handle of this.detachableHandles.values()) {
      handle.detach();
      count++;
    }
    return count;
  }

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
    const run = { started: false, attempts: 0 };
    let acquired: { waitedMs: number; slot: object };
    try {
      acquired = await this.acquireSlot('spawn', undefined, cancel.promise, ticket);
    } catch (err) {
      cancel.dispose();
      this.unlinkParent(input.name);
      if (err instanceof SubagentTerminated) return this.endQueued(input.name, err);
      throw this.failedRun(input.name, 'spawn', err, run);
    }
    const { waitedMs, slot } = acquired;
    const childDepth = callerDepth + 1;
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
        this.returnedResults.delete(input.name);
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

        this.agentDepths.set(agentName, childDepth);

        this.registerLive(input.name, agentName, launch.systemPrompt, contextManager);

        try {
          // The orientation, then the task, each its own message: the cap
          // applies to each message alone, so each has all of it.
          const orientation = this.orientationFor(launch, agent, { kind: 'none', reason: 'spawn' });
          contextManager.addMessage('user', [{ type: 'text', text: orientation }]);
          contextManager.addMessage('user', [{ type: 'text', text: input.task }]);

          // A real compile, not a dry one: a dry compile returns an
          // over-budget plan where a real one refuses it, and the stream's
          // context is fresh, so its first request's compile starts from what
          // this one leaves.
          const { messages } = await Promise.race([contextManager.compile(), cancel.promise]);
          cancel.throwIfFired();
          const delivery: LaunchDelivery = { kind: 'message', orientation, taskBlock: input.task };
          const cut = undeliveredLaunchParts(messages, delivery);
          if (cut.length > 0) throw this.launchRefusal('spawn', cut, delivery, true);

          const tools = framework.getAllTools().filter(t => agent.canUseTool(t.name));
          const est = this.estimatePromptTokens(agent.systemPrompt, messages, tools);
          if (est > this.maxPromptTokens) {
            throw new SubagentFailure(
              `its prompt would be about ${est} tokens, over this host's limit of ${this.maxPromptTokens}`,
              'Shorten its task or systemPrompt, or pass tools naming only the tools it needs, since every ' +
                "tool's definition counts.",
            );
          }

          if (deadline !== undefined && Date.now() >= deadline) throw this.timedOut('spawn', executionTimeoutMs!);

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

          if (lastError instanceof SubagentTerminated) return this.endTerminated(input.name, entry, lastError, waitedMs, run.started);

          if (lastError instanceof SubagentFailure) break;
          if (this.isUnsleptProviderWait(lastError)) break;
          if (this.isRateLimitError(lastError, agentName)) {
            const stopped = await this.waitOrStop(this.onRateLimitHit(deadline), cancel.promise);
            if (stopped) return this.endTerminated(input.name, entry, stopped, waitedMs, run.started);
          }
          if (!this.isTransientError(lastError, agentName) || attempt === this.maxRetries) break;

          const delay = Math.min(5_000 * (attempt + 1), 30_000);
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
      if (entry.status === 'running') {
        entry.status = 'failed';
        entry.completedAt = Date.now();
        entry.statusMessage = err instanceof Error ? err.message : String(err);
      }
      throw this.failedRun(input.name, 'spawn', err, run);
    } finally {
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
    const run = { started: false, attempts: 0 };
    let acquired: { waitedMs: number; slot: object };
    try {
      acquired = await this.acquireSlot('fork', undefined, cancel.promise, ticket);
    } catch (err) {
      cancel.dispose();
      this.unlinkParent(input.name);
      if (err instanceof SubagentTerminated) return this.endQueued(input.name, err);
      throw this.failedRun(input.name, 'fork', err, run);
    }
    const { waitedMs, slot } = acquired;
    const childDepth = callerDepth + 1;
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

      const parentAgent = launch.parentAgent;
      const canSpawn = parentAgent?.canUseTool('subagent--spawn') ?? true;
      let lastError: Error | null = null;

      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        run.attempts = attempt + 1;
        const suffix = attempt === 0 ? `d${childDepth}-${nameStamp()}` : `d${childDepth}-retry${attempt}-${nameStamp()}`;
        const agentName = `${input.name}-${suffix}`;
        this.runOfAttempt.set(agentName, input.name);
        this.returnedResults.delete(input.name);

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

        this.agentDepths.set(agentName, childDepth);

        this.registerLive(input.name, agentName, launch.systemPrompt, contextManager);

        try {
          const orient = (inherited: SubagentStart['inherited']): string =>
            this.orientationFor(launch, agent, inherited);
          let delivery: LaunchDelivery;
          if (parentAgent) {
            const parentCM = parentAgent.getContextManager();
            // A dry compile: unlike a real one, it commits none of the
            // parent's fold state, queues no compression on its behalf, and
            // returns a plan over the budget rather than refusing it.
            const compiled = compiledWithoutStoredInjections(await Promise.race([
              parentCM.compile(undefined, undefined, { dryRun: true }),
              cancel.promise,
            ]));
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
            // The orientation and the task, each its own message as for a
            // spawn, since the cap applies to each message alone.
            const orientation = `${orient({ kind: 'none', reason: 'no-parent' })}\n\n` +
              'When this intention is complete, return your findings via subagent--return. Your intention for this stream follows.';
            contextManager.addMessage('user', [{ type: 'text', text: orientation }]);
            contextManager.addMessage('user', [{ type: 'text', text: input.task }]);
            delivery = { kind: 'message', orientation, taskBlock: input.task };
          }

          // A real compile, as a spawn's is, so an over-budget first context is
          // refused here, before the run starts.
          const { messages } = await Promise.race([contextManager.compile(), cancel.promise]);
          cancel.throwIfFired();
          const cut = undeliveredLaunchParts(messages, delivery);
          if (cut.length > 0) throw this.launchRefusal('fork', cut, delivery, canSpawn);

          const tools = framework.getAllTools().filter(t => agent.canUseTool(t.name));
          const est = this.estimatePromptTokens(agent.systemPrompt, messages, tools);
          if (est > this.maxPromptTokens) {
            const spawn = this.spawnInstead(canSpawn, true);
            throw new SubagentFailure(
              `it would begin at about ${est} tokens, over this host's limit of ${this.maxPromptTokens}` +
                (parentAgent ? ', because a fork carries your whole conversation' : ''),
              `${spawn.charAt(0).toUpperCase()}${spawn.slice(1)}${parentAgent && canSpawn ? ', though a spawn inherits none of it' : ''}.`,
            );
          }

          if (deadline !== undefined && Date.now() >= deadline) throw this.timedOut('fork', executionTimeoutMs!);

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

          if (lastError instanceof SubagentTerminated) return this.endTerminated(input.name, entry, lastError, waitedMs, run.started);

          if (lastError instanceof SubagentFailure) break;
          if (this.isUnsleptProviderWait(lastError)) break;
          if (this.isRateLimitError(lastError, agentName)) {
            const stopped = await this.waitOrStop(this.onRateLimitHit(deadline), cancel.promise);
            if (stopped) return this.endTerminated(input.name, entry, stopped, waitedMs, run.started);
          }
          if (!this.isTransientError(lastError, agentName) || attempt === this.maxRetries) break;

          const delay = Math.min(5_000 * (attempt + 1), 30_000);
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
      if (entry.status === 'running') {
        entry.status = 'failed';
        entry.completedAt = Date.now();
        entry.statusMessage = err instanceof Error ? err.message : String(err);
      }
      throw this.failedRun(input.name, 'fork', err, run);
    } finally {
      this.releaseSlot(slot);
      cancel.dispose();
      this.forgetAttempts(input.name);
      this.persistState();
    }
  }

  private extractLastAssistantText(contextManager: ContextManager): string {
    try {
      const messages = contextManager.getAllMessages();
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.participant === 'user' || msg.participant === 'User') continue;
        if (storedInjectionMarkOf(msg.metadata) !== undefined) continue;
        const texts = msg.content
          .filter((b: ContentBlock) => b.type === 'text')
          .map((b: ContentBlock) => (b as { type: 'text'; text: string }).text);
        if (texts.length > 0) return texts.join('\n');
      }
    } catch {
    }
    return '(no text output)';
  }

  private offeredNames(): Set<string> {
    const framework = this.getFramework();
    const utilities = (framework as AgentFramework & {
      getAllUtilities?: () => ToolDefinition[];
    }).getAllUtilities?.() ?? [];
    return new Set([...framework.getAllTools(), ...utilities].map((t) => t.name));
  }

  private atDepthLimit(callerDepth: number): boolean {
    return callerDepth + 1 >= this.maxDepth;
  }

  private filterToolNames(requestedTools: string[] | undefined, callerDepth: number, parent: Agent | null): 'all' | string[] {
    const inheritedTools = parent?.allowedTools ?? 'all';
    const allowedTools = inheritedTools === 'all'
      ? requestedTools?.slice()
      : (requestedTools === undefined
        ? [...inheritedTools]
        : requestedTools.filter(name => inheritedTools.includes(name)));
    const ensureReturn = (list: string[]) =>
      list.includes('subagent--return') ? [...list] : [...list, 'subagent--return'];

    if (this.atDepthLimit(callerDepth)) {
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
