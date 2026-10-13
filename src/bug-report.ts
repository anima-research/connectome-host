/**
 * `/bug <text>`: a report someone in trouble can send us in one step, with
 * nothing in it they didn't mean to share.
 *
 * Reports go to connectome-host's public issues, so a report must not be
 * able to carry conversation text at all. The rule that gives that:
 * **nothing a session wrote, and nothing a user chose, goes in, except the
 * text the user wrote for the report.** Every other line is built from a
 * field with a known shape, read through an allowlist:
 * - versions, the commit, the runtime and the mode;
 * - the setup as structure: the provider, a model id only when it matches
 *   the provider's public id pattern, our built-in modules by name, budget
 *   numbers, and each MCP server by ordinal with its kind, transport,
 *   family and state;
 * - provider failures as classifications (time, status, membrane error
 *   type, retryable, a known provider code);
 * - host errors as shapes: how often each happened, a known class name, and
 *   where in our own code it was thrown, as package-relative `path:line`.
 *
 * No log line, error message, request, response, prompt, server name,
 * command, argument, url, env value or path is copied, and that holds for
 * the local file too. The error logs can't be cleaned of conversation text
 * reliably (they hold all of stderr, a server's included, and a provider can
 * echo a whole request in its error), so they are read only for shapes.
 *
 * Nothing is sent from here. The command shows the report, writes it to a
 * file, and gives a link to GitHub's new-issue form, filled in; the user
 * reads it there and submits it themselves, so no credentials are needed.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { applyAgentOverlay, loadMcplServers, mergeRecipeServers } from './mcpl-config.js';

// ---------------------------------------------------------------------------
// Where reports go, and what they're called
// ---------------------------------------------------------------------------

/** The one destination: connectome-host's public issues. */
export const BUG_REPORT_REPO = 'anima-research/connectome-host';
/** The issue form the link fills (.github/ISSUE_TEMPLATE/bug_report.yml). */
export const BUG_REPORT_TEMPLATE = 'bug_report.yml';
/** The report's first line: what made it and in which format. */
export const BUG_REPORT_MARKER = 'connectome-host /bug v1';
/** Prefilled links much longer than this risk GitHub's 414. */
export const BUG_REPORT_URL_CAP = 6_000;
/** What the issue title takes of the user's first line. */
const TITLE_CHARS = 80;

// ---------------------------------------------------------------------------
// Allowlists
// ---------------------------------------------------------------------------

const PROVIDERS = new Set(['anthropic', 'openai-responses', 'openai-codex', 'openrouter', 'bedrock', 'openai-compatible', 'mock']);

/**
 * A model id goes in only when every word of it is from this fixed
 * vocabulary of public model names, the rest being numbers, dates and
 * version marks. A pattern with a free tail would let a user's words
 * through after a public-looking prefix (`claude-<anything>`, which a proxy
 * behind the anthropic provider accepts); a fine-tune's or a custom
 * endpoint's name is the user's choice of words, and a Bedrock ARN holds an
 * account number.
 */
const MODEL_WORDS = new Set([
  // Anthropic, and Bedrock's spelling of it
  'claude', 'opus', 'sonnet', 'haiku', 'fable', 'mythos', 'instant', 'latest', 'anthropic', 'us', 'eu', 'apac', 'global',
  // OpenAI
  'gpt', 'chatgpt', 'codex', 'mini', 'nano', 'pro', 'turbo', 'preview', 'chat', 'max', 'high', 'low', 'medium',
  'instruct', 'search', 'audio', 'realtime', 'thinking',
  // Other vendors' families, as OpenRouter lists them
  'gemini', 'gemma', 'flash', 'lite', 'exp', 'llama', 'mistral', 'mixtral', 'large', 'small', 'codestral',
  'deepseek', 'coder', 'reasoner', 'qwen', 'qwq', 'grok', 'beta', 'vision', 'command', 'r', 'plus', 'free',
]);
/** OpenRouter vendors named as themselves; any other is `custom`. */
const OPENROUTER_VENDORS = new Set([
  'anthropic', 'openai', 'google', 'meta-llama', 'mistralai', 'deepseek', 'qwen', 'x-ai', 'cohere',
]);
/** A word that is a number, a date, a version mark or an OpenAI o-series name. */
const MODEL_NUMBER = /^(?:\d{1,8}|v\d{1,3}|o\d{1,2}|\d{1,3}[a-z]?)$/;

function modelWords(id: string): boolean {
  const words = id.split(/[-.:_]/);
  return words.length <= 12 && words.every((word) => MODEL_WORDS.has(word) || MODEL_NUMBER.test(word));
}

/** The first word a provider's public ids begin with. */
const MODEL_FAMILY: Record<string, (first: string) => boolean> = {
  anthropic: (first) => first === 'claude',
  bedrock: (first) => first === 'anthropic' || ['us', 'eu', 'apac', 'global'].includes(first),
  'openai-responses': (first) => ['gpt', 'chatgpt', 'codex'].includes(first) || /^o\d{1,2}$/.test(first),
  'openai-codex': (first) => ['gpt', 'codex'].includes(first) || /^o\d{1,2}$/.test(first),
};

/** Our built-in modules (RecipeModules' keys). Anything else is counted. */
const BUILT_IN_MODULES = [
  'subagents', 'lessons', 'retrieval', 'wake', 'workspace', 'instructions', 'activity', 'notices',
  'mcplAdmin', 'history', 'identity', 'fleet', 'webui', 'ttsRelay', 'subscriptionGc', 'channelMode',
];
/** The names our own modules register under (connectome-host's and
 *  agent-framework's), as a running framework lists them. Any other is an
 *  extension's, counted. */
const LIVE_MODULE_NAMES = new Set([
  'activity', 'api', 'channel-mode', 'discord', 'fleet', 'health', 'history', 'identity', 'instructions',
  'lessons', 'mcpl-admin', 'notices', 'observers', 'openai-codex', 'retrieval', 'settings', 'subagent',
  'subscription-gc', 'time', 'tts-relay', 'tui', 'webui', 'workspace',
]);

const FORMATTERS = new Set(['native', 'anthropic-xml']);
const PROSE_ROUTING = new Set(['locus', 'explicit', 'hybrid', 'disabled']);
const CACHE_TTLS = new Set(['5m', '1h']);

/** Membrane's error types (MembraneErrorType). */
const MEMBRANE_ERROR_TYPES = new Set([
  'rate_limit', 'context_length', 'invalid_request', 'auth', 'server', 'network', 'timeout', 'abort',
  'safety', 'unsupported', 'unknown',
]);

/** Provider error codes as their APIs document them. Any other code is
 *  "other": a code is the provider's string, and can be anything. */
const PROVIDER_ERROR_CODES = new Set([
  // Anthropic
  'invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error', 'request_too_large',
  'rate_limit_error', 'api_error', 'overloaded_error', 'billing_error', 'timeout_error',
  // OpenAI
  'rate_limit_exceeded', 'insufficient_quota', 'context_length_exceeded', 'invalid_api_key', 'model_not_found',
  'server_error', 'content_filter',
  // Bedrock
  'ThrottlingException', 'ValidationException', 'ServiceUnavailableException', 'ModelTimeoutException',
  'AccessDeniedException', 'ModelNotReadyException', 'ModelErrorException', 'InternalServerException',
  'ResourceNotFoundException', 'ServiceQuotaExceededException', 'ModelStreamErrorException',
]);

/** The error classes a report names; any other is "another error class". */
const ERROR_CLASSES = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError', 'AggregateError',
  'MembraneError', 'McplRequestError', 'McplProtocolVersionError', 'McplUnreapedLaunchError',
  'McplResponseSerializationError', 'CoalesceError', 'OverBudgetError', 'DiscordAwarenessAccountingError',
  'HandshakeCleanupError', 'AbortError', 'TimeoutError',
]);

/**
 * The bracketed tags our own code starts a log line with (connectome-host,
 * agent-framework, membrane, context-manager). An MCP server's stderr lands
 * in the same log and can start with any bracketed text, so only these are
 * named; every other tag is counted as "other".
 */
export const HOST_LOG_TAGS = new Set([
  'agent-settings', 'anthropic-credentials', 'autobiographical', 'batch', 'budget-preflight',
  'cache-keepalive', 'channel', 'cm-cache', 'coalescing', 'compression-quarantine', 'context-maintenance',
  'credential', 'credential-monitor', 'deprecated', 'diagnostics', 'discord', 'discord-awareness', 'echo',
  'estimator-calibration', 'fleet', 'framework', 'gate', 'gate-telemetry', 'heartbeat', 'host', 'host-command',
  'host-mode', 'host-notice', 'identity', 'image', 'inference-dropped', 'inference-failed',
  'inference-hard-down', 'inference-refusal', 'inference-rewind', 'inference-stale',
  'kv-continuity-relaxation', 'kv-diag', 'kv-escalation', 'kv-overlap', 'kv-timing', 'kv-unified',
  'liveness-watchdog', 'llm-calls', 'mcp', 'mcpl', 'membrane', 'membrane-oversize', 'membrane:bedrock',
  'membrane:content', 'membrane:cost', 'membrane:gemini', 'membrane:normalize-tool-pairs',
  'membrane:openrouter', 'membrane:usage', 'merge-quarantine', 'merge-topology', 'message-store',
  'mint-preimage', 'notices', 'nudge', 'openai-codex', 'operator', 'operator-log', 'ops-alert',
  'picker-config-drift', 'picker-dead-ids', 'picker-unrealizable', 'prose', 'provider-admission',
  'provider-cooldown', 'puppet', 'push-event-rejected', 'reasoning', 'reasoning-effort', 'refusal-retry',
  'refusal-rewind', 'rfc005', 'routespeech', 'routing', 'section', 'self-wake', 'settings', 'shutdown',
  'sleep', 'spill', 'store-topology', 'subagent', 'subscription-gc', 'thinking', 'tool', 'tool-boundary',
  'tool-result-guard', 'tool_result', 'tools', 'tts-relay', 'unstick', 'voice', 'webui', 'webui-observers',
  'windowed-passthrough', 'workspace',
]);

/** The directories a package's own code lives in: frames elsewhere aren't named. */
const CODE_DIRECTORIES = ['src', 'dist'];
/** The dependencies whose frames a report names (under node_modules/@animalabs). */
const OUR_PACKAGES = ['agent-framework', 'membrane', 'context-manager', 'mcpl-core', 'chronicle'];

// ---------------------------------------------------------------------------
// What a report is made of
// ---------------------------------------------------------------------------

export type RuntimeMode = 'tui' | 'headless' | 'readline' | 'batch';

export interface BugReportFacts {
  now: Date;
  mode: RuntimeMode;
  host: { version: string | null; commit: { sha: string; modified: boolean | null } | null };
  packages: Array<{ name: string; version: string | null }>;
  runtime: { os: string; release: string | null; arch: string; bun: string | null; node: string | null };
  setup: {
    provider: string | null;
    model: string | null;
    formatter: string | null;
    maxTokens: number | null;
    contextBudgetTokens: number | null;
    cacheTtl: string | null;
    proseRouting: string | null;
    thinking: boolean | null;
    modules: string[];
    customModules: number;
  };
  servers: ServerRow[];
  /** Why some server configurations are missing, without paths. */
  configNotes: string[];
  /** Null when this process keeps no provider-call log. */
  providerCalls: ProviderCallSummary | null;
  /** Null when this mode keeps no error log (readline and batch print to the terminal). */
  hostErrors: HostErrorSummary | null;
}

export interface ServerRow {
  kind: string;
  transport: 'stdio' | 'websocket' | 'http' | 'unknown';
  family: 'legacy' | 'modern' | 'unknown';
  connected: boolean;
  retrying: boolean;
  refused: boolean;
  toolCount: number;
}

export interface ProviderFailure {
  at: string;
  kind: 'complete' | 'stream' | null;
  provider: string | null;
  status: number | null;
  type: string | null;
  retryable: boolean | null;
  code: string | null;
}

export interface ProviderCallSummary {
  calls: number;
  failed: number;
  /** Newest first. */
  recent: ProviderFailure[];
  /** Failures older than the newest kept. */
  omitted: number;
  /** Records that couldn't be read: not JSON, no valid time, or a time ahead of now. */
  skipped: number;
  /** Whether only the file's last part was read. */
  truncated: boolean;
  readable: boolean;
}

export interface HostErrorShape {
  className: string;
  frames: string[];
  count: number;
  signature: string;
}

export interface HostErrorSummary {
  log: 'tui-error.log' | 'headless.log';
  readable: boolean;
  /** Whether only the log's last part was read. */
  truncated: boolean;
  tags: Array<[string, number]>;
  otherTags: number;
  errors: HostErrorShape[];
}

// ---------------------------------------------------------------------------
// Reading values through the allowlists
// ---------------------------------------------------------------------------

/** A version's numeric core only: a prerelease tag in an edited
 *  package.json, or a self-built kernel's local version, could be words. */
const VERSION = /^\d{1,6}(?:\.\d{1,6}){1,3}/;
const SHA = /^[0-9a-f]{7,40}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function version(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return VERSION.exec(value)?.[0] ?? null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** The provider's model id when it reads as a public one, else `custom`. */
export function publicModelId(provider: string | null, model: unknown): string | null {
  if (typeof model !== 'string' || model === '') return null;
  if (model.length > 100) return 'custom';
  if (provider === 'openrouter') {
    const slash = model.indexOf('/');
    if (slash < 0) return 'custom';
    const vendor = model.slice(0, slash);
    if (!OPENROUTER_VENDORS.has(vendor)) return 'custom';
    return modelWords(model.slice(slash + 1)) ? model : `${vendor}/custom`;
  }
  const family = provider ? MODEL_FAMILY[provider] : undefined;
  return family && family(model.split(/[-.:_]/)[0]!) && modelWords(model) ? model : 'custom';
}

// ---------------------------------------------------------------------------
// The setup, from the recipe and the live servers
// ---------------------------------------------------------------------------

interface RecipeLike {
  agent?: {
    provider?: unknown; model?: unknown; formatter?: unknown; maxTokens?: unknown; contextBudgetTokens?: unknown;
    cacheTtl?: unknown; proseRouting?: unknown; thinking?: unknown;
  };
  modules?: object;
  extensions?: object;
}

export interface ServerConfigLike {
  command?: unknown;
  url?: unknown;
  transport?: unknown;
  protocol?: unknown;
  source?: { npm?: unknown; url?: unknown };
}

/** A live server, as `listMcplServers()` gives it (fields read on their own).
 *  Newer frameworks also give its family, transport, command and url; the
 *  command and url are read for presence only. */
export interface LiveServerLike {
  id: string;
  connected?: unknown;
  retrying?: unknown;
  toolCount?: unknown;
  refused?: unknown;
  family?: unknown;
  transport?: unknown;
  command?: unknown;
  url?: unknown;
}

/** Our own MCP server packages: a spec names one only when it is one of
 *  these, at a numeric version. Any other name under the scope is still a
 *  name someone chose. */
const OUR_SERVER_PACKAGES = ['discord-mcpl', 'slack-mcpl', 'heartbeat-mcpl', 'portal-mcpl', 'mcpl-harness'];
const OUR_PACKAGE_SPEC = new RegExp(`^@animalabs/(?:${OUR_SERVER_PACKAGES.join('|')})@\\d{1,6}(?:\\.\\d{1,6}){2}$`);

/**
 * What the running host uses, read from it rather than from the recipe,
 * which the host resolves further: MODEL in the environment and a default
 * pick the model, settings change live, and some modules are on unless a
 * recipe turns them off. Each value still goes through its allowlist.
 */
export interface LiveSetup {
  /** The main agent's own fields. */
  agent?: { model?: unknown; maxTokens?: unknown; thinking?: unknown; proseRouting?: unknown; cacheTtl?: unknown; contextBudgetTokens?: unknown };
  /** The names of the modules the framework has registered. */
  modules?: readonly string[];
  /** Whether the wake gate is on: it is a framework option, not a module. */
  wake?: boolean;
}

export function setupFacts(recipe: RecipeLike, live: LiveSetup = {}): BugReportFacts['setup'] {
  const agent = recipe.agent ?? {};
  const running = live.agent ?? {};
  // A field the running agent gives wins over the recipe's.
  const pick = <K extends keyof NonNullable<LiveSetup['agent']>>(key: K): unknown =>
    running[key] !== undefined ? running[key] : (agent as Record<string, unknown>)[key];
  const provider = typeof agent.provider === 'string' && PROVIDERS.has(agent.provider)
    ? agent.provider
    : agent.provider === undefined ? 'anthropic' : 'other';
  const modules = (recipe.modules ?? {}) as Record<string, unknown>;
  const enabled = (value: unknown): boolean => value !== undefined && value !== false && value !== null;
  const thinkingValue = pick('thinking');
  const thinking = thinkingValue && typeof thinkingValue === 'object'
    ? (thinkingValue as { enabled?: unknown }).enabled === true
    : null;
  const cacheTtl = pick('cacheTtl');
  const proseRouting = pick('proseRouting');
  let named: string[];
  let custom: number;
  if (live.modules) {
    named = [...new Set(live.modules.filter((name) => LIVE_MODULE_NAMES.has(name)))].sort();
    if (live.wake) named = ['wake', ...named];
    custom = live.modules.filter((name) => !LIVE_MODULE_NAMES.has(name)).length;
  } else {
    named = BUILT_IN_MODULES.filter((name) => Object.hasOwn(modules, name) && enabled(modules[name]));
    custom = Object.keys(recipe.extensions ?? {}).length
      + Object.keys(modules).filter((name) => !BUILT_IN_MODULES.includes(name) && enabled(modules[name])).length;
  }
  return {
    provider,
    model: publicModelId(provider, pick('model')),
    formatter: typeof agent.formatter === 'string' && FORMATTERS.has(agent.formatter) ? agent.formatter : null,
    maxTokens: count(pick('maxTokens')),
    contextBudgetTokens: count(pick('contextBudgetTokens')),
    cacheTtl: typeof cacheTtl === 'string' && CACHE_TTLS.has(cacheTtl) ? cacheTtl : null,
    proseRouting: typeof proseRouting === 'string' && PROSE_ROUTING.has(proseRouting) ? proseRouting : null,
    thinking,
    modules: named,
    customModules: custom,
  };
}

/**
 * Each server's configuration as startup composes it (index.ts), by the
 * same functions: the servers file's entries, the recipe's servers merged
 * with them (mergeRecipeServers: a recipe can adopt a file server and
 * override its policy, url and transport), then the agent overlay
 * (applyAgentOverlay: an agent-deployed server, or one replacing an
 * operator's). A stage that fails is named in `notes`, without a path.
 */
export function composedServerConfigs(
  recipeServers: Record<string, object> | undefined,
  configPath: string,
  overlayPath: string,
): { configFor: (id: string) => ServerConfigLike | undefined; notes: string[] } {
  const notes: string[] = [];
  let fileServers: ReturnType<typeof loadMcplServers> = [];
  try {
    fileServers = loadMcplServers(configPath);
  } catch {
    notes.push("the servers file couldn't be read");
  }
  let merged: Array<{ id: string } & Record<string, unknown>> = [];
  try {
    merged = mergeRecipeServers(
      (recipeServers ?? {}) as Record<string, Record<string, unknown>>,
      fileServers as unknown as Array<{ id: string } & Record<string, unknown>>,
    ) as unknown as Array<{ id: string } & Record<string, unknown>>;
  } catch {
    notes.push("the recipe's servers couldn't be composed with the servers file");
  }
  let final: Array<{ id: string } & Record<string, unknown>> = merged;
  try {
    final = applyAgentOverlay(merged, overlayPath);
  } catch {
    notes.push("the agent overlay couldn't be read");
  }
  const byId = new Map(final.map((server) => [server.id, server as ServerConfigLike]));
  return { configFor: (id) => byId.get(id), notes };
}

/** Each live server by ordinal: no id, command, argument or url, since a
 *  name the user chose can say what they're doing. */
export function serverRows(
  live: readonly LiveServerLike[],
  configFor: (id: string) => ServerConfigLike | undefined,
): ServerRow[] {
  return live.map((server) => {
    // An agent-deployed server lives in the overlay, with no recipe or
    // servers-file entry: then the live entry says whether it has a command
    // or a url, by presence only.
    const config = configFor(server.id) ?? {};
    const npm = config.source && typeof config.source.npm === 'string' ? config.source.npm : undefined;
    const hasUrl = (typeof config.url === 'string' && config.url !== '') || (typeof server.url === 'string' && server.url !== '');
    const hasCommand = typeof config.command === 'string' || (typeof server.command === 'string' && server.command !== '');
    const kind = npm && OUR_PACKAGE_SPEC.test(npm)
      ? npm
      : npm ? 'a registry package'
      : hasUrl ? 'a url server'
      : hasCommand ? 'a local command'
      : 'unknown';
    // The framework's own reading when it gives one (a newer framework dials
    // an https url as modern MCP over HTTP); otherwise the configuration's,
    // as an older framework reads it: any url is a WebSocket.
    // A framework that gives the field but leaves it null (agent-framework
    // #262, for a refused server) means it has no usable value: unknown.
    const transport: ServerRow['transport'] = server.transport === 'stdio' || server.transport === 'websocket' || server.transport === 'http'
      ? server.transport
      : Object.hasOwn(server, 'transport') ? 'unknown'
      : config.transport === 'websocket' || (hasUrl && config.transport !== 'stdio')
        ? 'websocket'
        : config.transport === 'stdio' || hasCommand ? 'stdio' : 'unknown';
    const family: ServerRow['family'] = server.family === 'legacy' || server.family === 'modern'
      ? server.family
      : Object.hasOwn(server, 'family') ? 'unknown'
      : config.protocol === 'modern' ? 'modern' : 'legacy';
    return {
      kind,
      transport,
      family,
      connected: server.connected === true,
      retrying: server.retrying === true,
      // `refused` (agent-framework #262's listMcplServers; older frameworks
      // list no refused server) is a sentence naming the server and its url:
      // only whether there is one goes in.
      refused: server.refused !== undefined && server.refused !== null && server.refused !== false,
      toolCount: count(server.toolCount) ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Provider failures, from this process's llm-calls file
// ---------------------------------------------------------------------------

/**
 * The last hour's provider calls, as counts and classifications. A record's
 * request, response and error text are never read into the report.
 * `fallbackProvider` names the provider of records that carry none: the
 * Anthropic and Bedrock writers write no `provider` key, the generic one does.
 */
export function summarizeProviderCalls(
  lines: readonly string[],
  now: Date,
  opts: { recentMax?: number; fallbackProvider?: string | null } = {},
): Omit<ProviderCallSummary, 'truncated' | 'readable'> {
  const recentMax = opts.recentMax ?? 50;
  const since = now.getTime() - 60 * 60 * 1000;
  let calls = 0;
  let failed = 0;
  let skipped = 0;
  const failures: ProviderFailure[] = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { skipped++; continue; }
      record = parsed as Record<string, unknown>;
    } catch {
      skipped++;
      continue;
    }
    const at = typeof record.timestamp === 'string' && ISO.test(record.timestamp) ? record.timestamp : null;
    if (!at || Date.parse(at) > now.getTime() + 60_000) { skipped++; continue; }
    if (Date.parse(at) < since) continue;
    if (record.type !== 'call' && record.type !== 'error') continue;
    calls++;
    if (record.type !== 'error') continue;
    failed++;
    const status = typeof record.httpStatus === 'number' && Number.isInteger(record.httpStatus)
      && record.httpStatus >= 100 && record.httpStatus <= 599 ? record.httpStatus : null;
    const provider = typeof record.provider === 'string'
      ? PROVIDERS.has(record.provider) ? record.provider : null
      : opts.fallbackProvider ?? null;
    failures.push({
      at: at.replace(/\.\d+Z$/, 'Z'),
      kind: record.kind === 'complete' || record.kind === 'stream' ? record.kind : null,
      provider,
      status,
      type: typeof record.errorType === 'string' && MEMBRANE_ERROR_TYPES.has(record.errorType) ? record.errorType : null,
      retryable: typeof record.retryable === 'boolean' ? record.retryable : null,
      code: typeof record.providerErrorCode === 'string'
        ? PROVIDER_ERROR_CODES.has(record.providerErrorCode) ? record.providerErrorCode : 'other'
        : null,
    });
  }
  const recent = failures.slice(-recentMax).reverse();
  return { calls, failed, skipped, recent, omitted: failures.length - recent.length };
}

// ---------------------------------------------------------------------------
// Host errors, from the error log, as shapes
// ---------------------------------------------------------------------------

/** The line that marks where a run's error log begins (the TUI's and
 *  headless's own logs both write it). */
export function sessionMarker(now: Date): string {
  return `--- session ${now.toISOString()} ---`;
}

const SESSION_MARKER = /^--- session \d{4}-\d{2}-\d{2}T[\d:.]+Z ---$/;
const LEADING_STAMP = /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\]\s*/;
const TAG = /^\[([A-Za-z0-9:_./-]{1,40})\]/;
const FRAME_LINE = /^\s+at\s+/;
const ERROR_HEADER = /(?:^|[\s(\[])((?:[A-Z][A-Za-z0-9]*)?Error)(?::|\s*$)/;

/** A frame line's file and line number, read from its end: the last
 *  parenthesised location, or what follows "at". A path may hold spaces
 *  or parentheses; it must be absolute. */
export function frameLocation(line: string): { path: string; line: string } | null {
  if (!FRAME_LINE.test(line)) return null;
  const trimmed = line.trim();
  // `at name (location)`: the location opens at the first parenthesis
  // followed by an absolute path, and runs to the line's last character.
  const open = trimmed.search(/ \((?:\/|file:\/\/\/)/);
  const location = open >= 0 && trimmed.endsWith(')')
    ? trimmed.slice(open + 2, -1)
    : trimmed.replace(/^at\s+/, '');
  const match = /^(.*?):(\d{1,7})(?::\d{1,7})?$/.exec(location);
  if (!match) return null;
  const path = match[1]!;
  if (!path.startsWith('/') && !path.startsWith('file:///')) return null;
  return { path, line: match[2]! };
}

/**
 * Where our own code is, for naming frames: connectome-host's root, the
 * files git tracks there when it runs from a checkout, and the roots our
 * dependencies are installed at, each by its real path. `realpath` gives a
 * file's real path, or null when it doesn't exist.
 */
export interface FrameScope {
  hostRoot: string;
  /** Root-relative paths git tracks, when the host runs from a checkout. */
  tracked: ReadonlySet<string> | null;
  /** Each of our dependencies by name, at the root it is installed at. */
  packageRoots: ReadonlyMap<string, string>;
  realpath: (file: string) => string | null;
}

function realpathOrNull(file: string): string | null {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
}

/** The scope for the host installed at `root`. Git runs once, bounded at
 *  a second, on the command's thread. */
export function frameScope(root: string): FrameScope {
  const hostRoot = realpathOrNull(root) ?? root;
  let tracked: Set<string> | null = null;
  if (existsSync(join(root, '.git'))) {
    const listed = spawnSync('git', ['-C', root, 'ls-files', '-z', '--', ...CODE_DIRECTORIES], { encoding: 'utf8', timeout: 1000 });
    tracked = new Set(listed.status === 0 ? listed.stdout.split('\0').filter((name) => name !== '') : []);
  }
  const packageRoots = new Map<string, string>();
  for (const pkg of OUR_PACKAGES) {
    const found = dependencyRoot(`@animalabs/${pkg}`, root);
    const real = found ? realpathOrNull(found) : null;
    if (real) packageRoots.set(pkg, real);
  }
  return { hostRoot, tracked, packageRoots, realpath: realpathOrNull };
}

/** A frame's location inside our own code, `package/path:line`, or null
 *  for any other frame. The file must exist, and by its real path lie in a
 *  code directory (src/ or dist/) of connectome-host's root or of a root
 *  one of our dependencies is installed at: a directory merely named
 *  node_modules/@animalabs/… elsewhere is not one, and neither is a
 *  checkout's data directory, where a session can write files under names
 *  from the conversation. From a checkout, the file must also be one git
 *  tracks. */
export function ourFrame(path: string, line: string, scope: FrameScope): string | null {
  if (!/^\d{1,7}$/.test(line)) return null;
  let file: string;
  try {
    file = path.startsWith('file://') ? fileURLToPath(path) : path;
  } catch {
    return null;
  }
  const real = scope.realpath(file);
  if (!real) return null;
  const within = (root: string): string[] | null => {
    if (!real.startsWith(root + sep)) return null;
    const rest = relative(root, real).split(sep);
    return rest.length >= 2 && CODE_DIRECTORIES.includes(rest[0]!) && !rest.includes('node_modules') && !rest.includes('..') ? rest : null;
  };
  let located: string | null = null;
  for (const [pkg, root] of scope.packageRoots) {
    const rest = within(root);
    if (rest) { located = `@animalabs/${pkg}/${rest.join('/')}`; break; }
  }
  if (!located) {
    const rest = within(scope.hostRoot);
    if (rest && (!scope.tracked || scope.tracked.has(rest.join('/')))) located = `connectome-host/${rest.join('/')}`;
  }
  if (!located || !/^[@A-Za-z0-9_./-]{1,200}$/.test(located)) return null;
  return `${located}:${line}`;
}

/** The error-log text of this run: after its last session marker. */
export function currentSession(text: string): string {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (SESSION_MARKER.test(lines[i]!.trim())) return lines.slice(i + 1).join('\n');
  }
  return text;
}

/**
 * The shapes in an error log: how many lines each of our tags began, how
 * many began with any other tag, and each distinct error by class and where
 * it was thrown in our code. No text of any line is kept.
 */
export function parseErrorLog(
  text: string,
  scope: FrameScope,
): { tags: Map<string, number>; otherTags: number; errors: HostErrorShape[] } {
  const tags = new Map<string, number>();
  let otherTags = 0;
  const shapes = new Map<string, HostErrorShape>();
  // The error being read: its class (empty when no header named one), its
  // frames in our code, and whether its frames have begun.
  let current: { className: string; frames: string[]; framed: boolean } | null = null;
  const close = (): void => {
    if (current && (current.className !== '' || current.frames.length > 0)) {
      const className = current.className || 'an unnamed error';
      const key = `${className}|${current.frames.join('|')}`;
      const seen = shapes.get(key);
      if (seen) seen.count++;
      else shapes.set(key, { className, frames: current.frames, count: 1, signature: createHash('sha256').update(key).digest('hex').slice(0, 8) });
    }
    current = null;
  };
  for (const raw of text.split('\n')) {
    const frame = frameLocation(raw);
    if (frame) {
      if (!current) current = { className: '', frames: [], framed: true };
      current.framed = true;
      if (current.frames.length < 3) {
        const where = ourFrame(frame.path, frame.line, scope);
        if (where && !current.frames.includes(where)) current.frames.push(where);
      }
      continue;
    }
    const line = raw.replace(LEADING_STAMP, '');
    const tag = TAG.exec(line);
    // An error's header names its class before a colon. Only a known class
    // is named; the rest of the line is never read.
    const header = ERROR_HEADER.exec(line);
    // A multi-line message: every line after a header and before its
    // frames stays with it, until a new record begins (a tagged or stamped
    // line, a new error, or a new run).
    const newRecord = tag !== null || header !== null || LEADING_STAMP.test(raw) || SESSION_MARKER.test(raw.trim());
    if (current && !current.framed && !newRecord) continue;
    close();
    if (tag) {
      const name = tag[1]!.toLowerCase();
      if (HOST_LOG_TAGS.has(name)) tags.set(name, (tags.get(name) ?? 0) + 1);
      else otherTags++;
    }
    if (header) current = { className: ERROR_CLASSES.has(header[1]!) ? header[1]! : 'another error class', frames: [], framed: false };
  }
  close();
  const errors = [...shapes.values()].sort((a, b) => b.count - a.count);
  return { tags, otherTags, errors };
}

// ---------------------------------------------------------------------------
// The report's text and its link
// ---------------------------------------------------------------------------

export interface BugReport {
  title: string;
  /** The user's text, verbatim: the form's "What happened". */
  what: string;
  /** The assembled report: the form's "Report". */
  report: string;
}

const LEFT_OUT = 'Left out: every log line and error message; llm-calls requests, responses and errors; '
  + 'the system prompt and all other recipe text; the names of the recipe, of servers, of custom modules and '
  + 'custom models, and of packages other than our own MCP servers; commands, args, URLs and env values; '
  + 'and file paths outside our own code. We may ask whether you can share more.';

/** How much a report shows: everything, or lists collapsed to a bounded
 *  size to fit the link (servers as counts by state, the top five tags and
 *  three errors, no failure list or frames). */
type Detail = 'full' | 'brief';

/** Lists in the saved file stop here, saying how many more there were. */
const FULL_LIST = 50;

function onOff(value: boolean | null): string {
  return value === null ? 'unknown' : value ? 'on' : 'off';
}

function points(text: string): string[] {
  return [...text];
}

/** Text without lone surrogates, which a URL can't carry. */
export function wellFormed(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

export function formatBugReport(text: string, facts: BugReportFacts, detail: Detail = 'full'): BugReport {
  const what = wellFormed(text);
  const firstLine = what.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
  const titlePoints = points(firstLine);
  const titleText = titlePoints.length > TITLE_CHARS ? `${titlePoints.slice(0, TITLE_CHARS - 1).join('')}…` : firstLine;
  const lines: string[] = [];
  const more = (n: number, what: string): void => { if (n > 0) lines.push(`  (${n} more ${what} not listed)`); };
  lines.push(`${BUG_REPORT_MARKER} · ${facts.now.toISOString().replace(/\.\d+Z$/, 'Z')}`);
  lines.push('This part was assembled by /bug. "What happened" is the reporter\'s own words.');
  lines.push('');
  lines.push('Environment');
  const commit = facts.host.commit
    ? ` (commit ${facts.host.commit.sha.slice(0, 12)}, modified: ${facts.host.commit.modified === null ? 'unknown' : facts.host.commit.modified ? 'yes' : 'no'})`
    : '';
  lines.push(`  connectome-host ${facts.host.version ?? 'unknown'}${commit} · mode: ${facts.mode}`);
  lines.push(`  ${facts.packages.map((p) => `${p.name.replace('@animalabs/', '')} ${p.version ?? 'unknown'}`).join(' · ')}`);
  const rt = facts.runtime;
  lines.push(`  ${rt.bun ? `bun ${rt.bun}` : 'no bun'}${rt.node ? ` (node ${rt.node})` : ''} · ${rt.os}${rt.release ? ` ${rt.release}` : ''} ${rt.arch}`);
  lines.push('');
  lines.push('Setup');
  const s = facts.setup;
  lines.push(`  provider: ${s.provider ?? 'unknown'} · model: ${s.model ?? 'unknown'}${s.formatter ? ` · formatter: ${s.formatter}` : ''}`);
  lines.push(`  maxTokens: ${s.maxTokens ?? 'default'} · contextBudgetTokens: ${s.contextBudgetTokens ?? 'default'} · cacheTtl: ${s.cacheTtl ?? 'default'} · proseRouting: ${s.proseRouting ?? 'default'} · thinking: ${s.thinking === null ? 'default' : onOff(s.thinking)}`);
  lines.push(`  modules: ${s.modules.length > 0 ? s.modules.join(', ') : 'none'}${s.customModules > 0 ? ` · custom: ${s.customModules}` : ''}`);
  lines.push('');
  const state = (row: ServerRow): string => (row.refused ? 'refused' : row.connected ? 'connected' : row.retrying ? 'retrying' : 'not connected');
  if (detail === 'full') {
    lines.push(`MCP servers${facts.servers.length === 0 ? ': none' : ''}`);
    facts.servers.forEach((row, index) => {
      lines.push(`  server ${index + 1}: ${row.kind} · ${row.transport} · ${row.family} · ${state(row)} · ${row.toolCount} tools`);
    });
  } else if (facts.servers.length === 0) {
    lines.push('MCP servers: none');
  } else {
    const byState = new Map<string, number>();
    for (const row of facts.servers) byState.set(state(row), (byState.get(state(row)) ?? 0) + 1);
    lines.push(`MCP servers: ${facts.servers.length} (${[...byState].map(([name, n]) => `${name} ${n}`).join(', ')})`);
  }
  for (const note of facts.configNotes) lines.push(`  (${note})`);
  lines.push('');
  const pc = facts.providerCalls;
  if (!pc) {
    lines.push('Provider calls: no call log in this process');
  } else if (!pc.readable) {
    lines.push('Provider calls: this process\'s call log couldn\'t be read');
  } else {
    lines.push(`Provider calls, last hour: ${pc.calls}, ${pc.failed} failed`);
    if (pc.truncated) lines.push('  (only the call log\'s last 4 MiB were read)');
    if (pc.skipped > 0) lines.push(`  (${pc.skipped} records couldn't be read)`);
    if (detail === 'full') {
      const shown = pc.recent.slice(0, FULL_LIST);
      for (const f of shown) {
        lines.push(`  ${f.at} ${f.kind ?? '?'} ${f.provider ?? '?'} ${f.status ?? '?'} ${f.type ?? '?'}${f.retryable === null ? '' : f.retryable ? ' retryable' : ' not retryable'}${f.code ? ` ${f.code}` : ''}`);
      }
      more(pc.recent.length - shown.length + pc.omitted, 'failures');
    } else if (pc.failed > 0) {
      lines.push(`  (the failures are listed in the saved report, not in this link)`);
    }
    const newest = pc.recent[0];
    if (newest) lines.push(`  signature: ${newest.provider ?? '?'}/${newest.status ?? '?'}/${newest.type ?? '?'}/${newest.code ?? '-'}`);
  }
  lines.push('');
  const he = facts.hostErrors;
  if (!he) {
    lines.push('Host errors: this mode keeps no error log (it prints to the terminal)');
  } else if (!he.readable) {
    lines.push(`Host errors: ${he.log} couldn't be read`);
  } else {
    lines.push(`Host errors this run (${he.log})`);
    if (he.truncated) lines.push(`  (only ${he.log}'s last 4 MiB were read)`);
    const tagList = detail === 'full' ? he.tags : he.tags.slice(0, 5);
    const tagText = tagList.map(([name, n]) => `${name} ${n}`);
    const otherTags = he.otherTags + he.tags.slice(tagList.length).reduce((sum, [, n]) => sum + n, 0);
    if (otherTags > 0) tagText.push(`other ${otherTags}`);
    lines.push(`  tags: ${tagText.length > 0 ? tagText.join(', ') : 'none'}`);
    if (he.errors.length === 0) lines.push('  errors: none');
    const shown = he.errors.slice(0, detail === 'full' ? FULL_LIST : 3);
    for (const error of shown) {
      lines.push(`  ${error.className} ×${error.count} · sig ${error.signature}`);
      if (detail === 'full') for (const frame of error.frames) lines.push(`    ${frame}`);
    }
    more(he.errors.length - shown.length, 'distinct errors');
  }
  lines.push('');
  lines.push(LEFT_OUT);
  return { title: `[/bug] ${titleText}`, what, report: lines.join('\n') };
}

/** The new-issue link, filled in by field id. Never `labels=`: GitHub
 *  answers 404 to a reporter without permission to label. */
export function bugReportUrl(report: BugReport): string {
  const params = new URLSearchParams({
    template: BUG_REPORT_TEMPLATE,
    title: report.title,
    what: report.what,
    report: report.report,
  });
  return `https://github.com/${BUG_REPORT_REPO}/issues/new?${params.toString()}`;
}

/**
 * The report and its link, within the link's cap as measured on the link
 * itself. Past it, the lists collapse first, to a size that doesn't grow
 * with the setup, then the user's own text is cut, each saying so; the
 * saved file keeps the whole report.
 */
export function buildBugReport(text: string, facts: BugReportFacts): { full: BugReport; linked: BugReport; url: string; cut: string[] } {
  const full = formatBugReport(text, facts, 'full');
  const fits = (report: BugReport): boolean => bugReportUrl(report).length <= BUG_REPORT_URL_CAP;
  let linked = full;
  const cut: string[] = [];
  if (!fits(linked)) {
    const brief = formatBugReport(text, facts, 'brief');
    if (brief.report !== linked.report) {
      linked = brief;
      cut.push('the server rows, the failure list and the error frames');
    }
  }
  if (!fits(linked)) {
    // Keep as much of the reporter's text as the link has room for,
    // measured on the link: the longest prefix, by code points, that fits.
    const all = points(linked.what);
    const note = (omitted: number): string => `\n\n[${omitted} characters cut to fit the link; the whole text is in the report file]`;
    let lo = 0;
    let hi = all.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits({ ...linked, what: `${all.slice(0, mid).join('')}${note(all.length - mid)}` })) lo = mid;
      else hi = mid - 1;
    }
    linked = { ...linked, what: `${all.slice(0, lo).join('')}${note(all.length - lo)}` };
    cut.push('part of "What happened"');
  }
  return { full, linked, url: bugReportUrl(linked), cut };
}

// ---------------------------------------------------------------------------
// Gathering the facts
// ---------------------------------------------------------------------------

/** How this process runs, by index.ts's own rule: headless with
 *  --headless; otherwise batch when stdin isn't a terminal, readline with
 *  --no-tui, and the TUI by default. */
export function runtimeMode(argv: readonly string[] = process.argv, stdinIsTTY = !!process.stdin.isTTY): RuntimeMode {
  if (argv.includes('--headless')) return 'headless';
  if (!stdinIsTTY) return 'batch';
  if (argv.includes('--no-tui')) return 'readline';
  return 'tui';
}

/** This process's llm-calls file, as index.ts names it when it creates it. */
let callLogPath: string | null = null;

/** Named by index.ts: the llm-calls file this process writes. */
export function setCallLogPath(path: string): void {
  callLogPath = path;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Where a dependency is installed: the nearest node_modules that has it,
 *  as Node resolves a package from `from`. */
function dependencyRoot(name: string, from: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir) return null;
  }
}

/** A dependency's version, from where it is installed. */
function dependencyVersion(name: string, from: string): string | null {
  const root = dependencyRoot(name, from);
  return root ? version(readJson(join(root, 'package.json'))?.version) : null;
}

/** The commit this checkout is at, and whether tracked files are modified.
 *  Each git call runs synchronously on the command's thread, bounded at a
 *  second. */
function hostCommit(root: string): BugReportFacts['host']['commit'] {
  if (!existsSync(join(root, '.git'))) return null;
  const head = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 1000 });
  const sha = head.status === 0 ? head.stdout.trim() : '';
  if (!SHA.test(sha)) return null;
  const status = spawnSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8', timeout: 1000 });
  return { sha, modified: status.status === 0 ? status.stdout.trim() !== '' : null };
}

/** What a log read gave: its last `bytes` as lines (the first, likely
 *  partial, dropped when it was cut), whether it was cut, and whether it
 *  could be read. Null when the file doesn't exist. */
export function tailLines(path: string, bytes: number): { lines: string[]; truncated: boolean; readable: boolean } | null {
  if (!existsSync(path)) return null;
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    fd = openSync(path, 'r');
    readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    return { lines: start > 0 ? lines.slice(1) : lines, truncated: start > 0, readable: true };
  } catch {
    return { lines: [], truncated: false, readable: false };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const LOG_WINDOW = 4 * 1024 * 1024;

export interface GatherOptions {
  now?: Date;
  mode: RuntimeMode;
  dataDir: string;
  recipe: RecipeLike;
  liveServers: readonly LiveServerLike[];
  /** Server configurations by id, as the host composed them. */
  serverConfig: (id: string) => ServerConfigLike | undefined;
  /** Why some configurations are missing (a file that couldn't be read), without paths. */
  configNotes?: string[];
  /** This process's llm-calls file; by default the one index.ts named. */
  callLog?: string | null;
  /** What the running host uses, where it differs from the recipe. */
  live?: LiveSetup;
  /** The checkout or install to report on; this one by default. */
  root?: string;
}

export function gatherBugReportFacts(opts: GatherOptions): BugReportFacts {
  const now = opts.now ?? new Date();
  const root = opts.root ?? ROOT;
  const pkg = readJson(join(root, 'package.json'));
  const packages = ['@animalabs/agent-framework', '@animalabs/membrane', '@animalabs/context-manager', '@animalabs/chronicle']
    .map((name) => ({ name, version: dependencyVersion(name, root) }));
  const setup = setupFacts(opts.recipe, opts.live);
  const callLog = opts.callLog === undefined ? callLogPath : opts.callLog;
  let providerCalls: ProviderCallSummary | null = null;
  if (callLog) {
    const read = tailLines(callLog, LOG_WINDOW);
    if (read) {
      const summary = summarizeProviderCalls(read.lines, now, {
        fallbackProvider: setup.provider === 'anthropic' || setup.provider === 'bedrock' ? setup.provider : null,
      });
      providerCalls = { ...summary, truncated: read.truncated, readable: read.readable };
    }
  }
  const errorLogName = opts.mode === 'tui' ? 'tui-error.log' : opts.mode === 'headless' ? 'headless.log' : null;
  let hostErrors: HostErrorSummary | null = null;
  if (errorLogName) {
    const read = tailLines(join(opts.dataDir, errorLogName), LOG_WINDOW);
    const parsed = parseErrorLog(currentSession((read?.lines ?? []).join('\n')), frameScope(root));
    hostErrors = {
      log: errorLogName,
      readable: read ? read.readable : true,
      truncated: read ? read.truncated : false,
      tags: [...parsed.tags.entries()].sort((a, b) => b[1] - a[1]),
      otherTags: parsed.otherTags,
      errors: parsed.errors,
    };
  }
  return {
    now,
    mode: opts.mode,
    host: { version: version(pkg?.version), commit: hostCommit(root) },
    packages,
    runtime: {
      os: platform(),
      release: version(release()),
      arch: arch(),
      bun: version(process.versions.bun),
      node: version(process.versions.node),
    },
    setup,
    servers: serverRows(opts.liveServers, opts.serverConfig),
    configNotes: opts.configNotes ?? [],
    providerCalls,
    hostErrors,
  };
}
