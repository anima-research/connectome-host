/**
 * Recipe system — config-driven agent bootstrapping.
 *
 * A recipe defines everything domain-specific about an agent session:
 * system prompt, MCP servers, which modules to enable, and naming hints.
 *
 * Recipes can be loaded from:
 *   - HTTP(S) URLs
 *   - Local file paths
 *   - Saved state from a previous run (data/.recipe.json)
 *   - Built-in default (generic assistant)
 */

import { readFileSync, writeFileSync, existsSync, lstatSync, statSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { CodeExecutionConfig, MountConfig } from '@animalabs/agent-framework';
import { buildWorkspaceMounts } from './workspace-mounts.js';
import { validateToolClassTable, validateToolLifecycle } from './tool-lifecycle-config.js';
import { isLoopbackOrTailnetHost } from './history-semantic.js';
import { REASONING_EFFORTS, type ReasoningEffort } from './modules/settings-module.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecipeStrategy {
  /** Built-in strategy name, or a custom type registered by a
   *  `kind: "strategy"` extension (see `Recipe.extensions`). The
   *  `string & {}` arm keeps literal autocompletion while admitting
   *  extension-registered names. */
  type: 'autobiographical' | 'passthrough' | 'frontdesk' | (string & {});
  // Core window/compression sizing
  headWindowTokens?: number;
  /** Verbatim tail. When unset, 40% of the compile budget (120k of 300k). */
  recentWindowTokens?: number;
  compressionModel?: string;
  /** Cap compression `max_tokens` at the compression model's OUTPUT ceiling.
   *  Required for pre-4.x models (Claude 3 Opus caps at 4096) — without it the
   *  summarizer's 16k floor is rejected and the agent never folds. */
  compressionMaxTokens?: number;
  maxMessageTokens?: number;
  /** Maximum live image count, newest-first (default 6). Zero disables the count limit. */
  maxLiveImages?: number;
  /** Token depth from the tail beyond which images become placeholders (default 30000).
   * Zero disables depth-based stripping; surrounding text stays verbatim. */
  imageStripDepthTokens?: number;
  /** Cumulative base64 byte budget for live images (default 20 MiB).
   * Zero disables the byte limit. Count and depth limits still apply. */
  maxLiveImageBytes?: number;
  overBudgetGraceRatio?: number;
  // Compression/merge tuning passed through to the underlying
  // autobiographical strategy (and frontdesk, which extends it).
  // Declared here so a typo in a recipe (e.g. `l1BudgetTokes`) fails
  // at recipe validation rather than silently defaulting at strategy
  // construction. Keep in sync with `AutobiographicalConfig` in
  // @animalabs/context-manager; this interface is the source of truth
  // for what the recipe loader accepts under `agent.strategy`.
  enforceBudget?: boolean;
  maxSpeculativeL1s?: number;
  /** Number of coverage-equivalent recall curves to try after the canonical
   * autobiographical compression request is explicitly refused. Zero disables
   * fallback while retaining the canonical attempt. */
  compressionRefusalCurveFallbacks?: number;
  /** Complete provider-request admission ceiling for compression fallbacks,
   * including the output reserve. */
  compressionContextBudgetTokens?: number;
  /** Residence-scoped direct source-only L1 compression: the summarizer sees
   * only the compression marker + exact target chunk + directive (no head,
   * recall, or non-target raw recent material). One call, not a refusal
   * ladder. Source-preserving; L1 only. Default off. */
  compressionSourceOnly?: boolean;
  /** Preserve canonical + recall variants, then issue one source-only L1 request last. */
  compressionSourceOnlyFallback?: boolean;
  /** Legacy first-choice target-only merge request. */
  compressionMergeSourceOnly?: boolean;
  /** Preserve ordinary merge retries, then use target-only on the final attempt. */
  compressionMergeSourceOnlyFallback?: boolean;
  /**
   * Context Manager tool-prose hoist rung (default off). On an L1 refusal, retry
   * with long `fromTools` string arguments (e.g. a diary kept in
   * `skip_reply.reason`) moved into calls to `intoTool` — a note-taking tool the
   * agent really has (agent-framework `journal`). Skipped when `intoTool` is not
   * among the declared tools.
   */
  compressionToolProseFallback?: {
    intoTool: string;
    fromTools: string[];
    field?: string;
    result?: string;
    minChars?: number;
  };
  /** Context Manager split-stitch L1 fallback rung (default off). */
  compressionSplitFallback?: boolean;
  /** Allow a single-message placeholder inside a split-stitched L1 (default off). */
  compressionSplitPlaceholder?: boolean;
  /** Split-stitch: max sub-calls per chunk (default 40). */
  compressionSplitMaxCallsPerChunk?: number;
  /** Split-stitch: max sub-calls per strategy instance per 10-minute in-memory window (default 80). */
  compressionSplitMaxCallsPer10Min?: number;
  /** Token budget for prior recall-pair context in compression/merge
   * requests (Context Manager `compressionRecallBudgetTokens`). */
  compressionRecallBudgetTokens?: number;
  positionedRecallPairs?: boolean;
  recallHeaderTemplate?: string;
  /**
   * Where a summary's signed reasoning carriers (the compressor's own
   * thinking blocks, `responseContent`) are replayed (context-manager #81).
   * `'full'` (default): unchanged — carriers ride both the live window and
   * mint/merge recall pairs. `'live-strip'`: carriers are omitted from the
   * LIVE window only (whole blocks dropped, never mutated — signatures only
   * verify byte-identical) — the agent's own compiled context renders
   * recall pairs text-only, while compression/merge requests still carry
   * the full signed content unconditionally (measured load-bearing there:
   * some providers refuse a compress request without it). Useful when a
   * provider's classifier treats a replayed foreign-request signature
   * inside the LIVE window as reasoning extraction.
   */
  carrierPolicy?: 'full' | 'live-strip';
  targetChunkTokens?: number;
  mergeThreshold?: number;
  mergeMaxSourceSpanMessages?: number;
  summaryTargetTokens?: number;
  /** Standing production target: keep the summary forest deep enough to fit
   *  this budget, enabling a later live-budget descent with no fold-storm and
   *  a single KV invalidation (see context-manager productionBudgetTokens). */
  productionBudgetTokens?: number;
  l1BudgetTokens?: number;
  l2BudgetTokens?: number;
  l3BudgetTokens?: number;
  toolResultMaxLastN?: number;
  toolUseInputMaxTokens?: number;
  // Adaptive resolution (document-based gradual compression). For the
  // 'autobiographical' strategy type this defaults ON (see index.ts); set
  // `adaptiveResolution: false` to opt back to the count-based hierarchical
  // renderer. The remaining knobs only apply when adaptiveResolution is true.
  adaptiveResolution?: boolean;
  /** kv-stable: trust region P on per-turn perturbation (tokens re-read).
   *  See context-manager adaptive-resolution-design.md §13. */
  kvStableReachTokens?: number;
  /** kv-stable: quality-gap override threshold (§13.4). Default 0.35. */
  kvStableQualityGapRatio?: number;
  compressionSlackRatio?: number;
  /** Adaptive-resolution fold planner. An omitted value is 'kv-unified', the
   *  cost-aware solver (see buildFrameworkStrategy). A resident whose store
   *  was built under 'kv-stable' pins it here. 'flat-profile' /
   *  'oldest-first' are the legacy planners. */
  foldingStrategy?: 'flat-profile' | 'oldest-first' | 'kv-stable' | 'kv-unified';
  /** Policy for the kv-unified solver. Omitted, the host supplies its standard
   * block (standardKvUnifiedConfig), with cache prices matched to the
   * provider, cacheTtl and model. Written out, it must be complete: there is
   * no per-field merging, so a missing or misspelled field fails at load. */
  kvUnified?: RecipeKvUnifiedConfig;
  speculativeProduction?: boolean;
  /** L1 production holdback: keep the newest N closed chunks out of the
   *  speculative compression queue (default 1); demand still overrides. */
  l1HoldbackChunks?: number;
  // Self-voice / compression framing. The host defaults summaryParticipant to
  // `agent.name` (buildFrameworkStrategy), so self-recollections speak as the
  // agent itself. Set explicitly only to voice summaries as someone else —
  // a mismatched participant surfaces in the compiled prompt as another voice
  // speaking in first person about the agent.
  summaryParticipant?: string;
  summarySystemPrompt?: string;
  summaryUserPrompt?: string;
  summaryContextLabel?: string;
  /** As-of perspective pin: chunks wholly below this message sequence are
   *  compressed as inherited/witnessed record, not first-person memory.
   *  For residents continued from a shared log they joined partway through. */
  witnessedBeforeSequence?: number;
  /** Override wording for the witnessed-record instruction ({targetTokens}
   *  substituted). */
  witnessedInstruction?: string;
  /** Identity reminder appended to every compression/merge instruction.
   *  For agents in multi-resident channels (and older models especially):
   *  names the agent and directs attribution so pure-witness chunks don't
   *  flip the summarizer into another speaker's identity. */
  identityReminder?: string;
  /** Reminder for WHOLLY inherited targets (L1 chunks entirely before
   *  witnessedBeforeSequence; merges of all-witnessed sources). Lived and
   *  mixed targets keep identityReminder (context-manager
   *  witnessedIdentityReminder). */
  witnessedIdentityReminder?: string;
  /** Follow the reminder with an instruction to apply it silently. */
  identityReminderSilent?: boolean;
}

export interface RecipeKvUnifiedConfig {
  policy: {
    alpha: number;
    budgetLowRatio: number;
    budgetHighRatio: number;
    budgetUnderLambda: number;
    budgetOverLambda: number;
    cacheLambda: number;
    cacheScale: number;
    cacheReadPrice: number;
    cacheWritePrice: number;
    continuityLambda: number;
    continuityScale: number;
    continuityRecencyHalfLifeTokens: number;
    continuityRecencyFloor: number;
    continuityStableHalfLife: number;
    continuityStableFloor: number;
    /** Age bands per doubling for fidelity and continuity ages
     * (context-manager ≥ 0.17): an integer from 0 to 64, 0 prices exact ages.
     * Optional; a strategy built from a recipe takes 4 unless set. */
    ageBandSteps?: number;
  };
  tokenBucketSize: number;
  continuityBucketSize: number;
  fidelityBucketSize: number;
  labelCeiling: number;
  adoptEpsilon: number;
  treeifyNonContiguousSummaries: boolean;
  /** Preserve summaries spanning gaps instead of treeifying them. Mutually exclusive
   * with treeifyNonContiguousSummaries; both flags must be explicit. */
  preserveGapBearingSummaries: boolean;
  /** Skip the full Pareto pass when the previously accepted layout is provably
   * still selected (context-manager ≥ 0.14). Optional; from context-manager
   * 0.15 a strategy built from a recipe takes it on unless set to `false`. */
  hysteresisCertificate?: boolean;
  /** Which engine solves the forest (context-manager ≥ 0.17): `auto` (absent)
   * runs the subtree engine and falls back to the packed DAG engine past the
   * label ceiling; `subtree` and `dag` pin one. */
  engine?: 'auto' | 'subtree' | 'dag';
  /** How producible merges are measured against the live cut
   * (context-manager ≥ 0.17): `joint` unless set to `individual`. */
  latentDemandMode?: 'individual' | 'joint';
}

export interface RecipeAgent {
  name?: string;
  model?: string;
  /** IANA zone used when rendering wall-clock times to the agent. */
  timezone?: string;
  /** Provider transport. Omitted preserves the historical Anthropic default.
   * 'mock' wires membrane's MockAdapter — canned/echo responses, no API key,
   * no provider spend; for exercising the full host loop offline. */
  provider?: 'anthropic' | 'openai-responses' | 'openai-codex' | 'openrouter' | 'bedrock' | 'openai-compatible' | 'mock';
  /**
   * Base URL of an OpenAI-compatible chat-completions endpoint, e.g.
   * `http://localhost:11434/v1` (Ollama), a vLLM server, Together, Groq,
   * NanoGPT... Required with `provider: 'openai-compatible'`, rejected with
   * any other provider (those have their own `*_BASE_URL` env overrides).
   * The API key comes from `OPENAI_COMPATIBLE_API_KEY` only — deliberately no
   * `OPENAI_API_KEY` fallback, since `baseUrl` is recipe-controlled and a real
   * OpenAI credential must never travel silently to an arbitrary endpoint.
   * Local servers may need none. `agent.model` is required
   * too — there is no sensible default model for an arbitrary endpoint.
   */
  baseUrl?: string;
  /** Message formatter. 'native' (default) = structured user/assistant turns.
   * 'anthropic-xml' = classic prefill format ("participant: text" runs, XML
   * tools) — for migrating prefill-era bots (chapterx borgs) with their exact
   * prompting structure intact. */
  formatter?: 'native' | 'anthropic-xml';
  /**
   * Membrane retry policy for this agent's provider calls. Membrane's default
   * retries generic retryable errors ZERO times — only `529`/`overloaded_error`
   * gets its dedicated patient schedule — so a transient 5xx from a
   * non-Anthropic gateway (a 502 "Service temporarily unavailable") kills the
   * turn on first failure. `{ "maxRetries": 4 }` rides out such blips with
   * exponential backoff (retryDelayMs 1000, x2, capped at maxRetryDelayMs
   * 30000 by default). Passed to Membrane verbatim; see membrane's
   * `RetryConfigInput` for every field.
   */
  retry?: import('@animalabs/membrane').MembraneConfig['retry'];
  /** Prefill scaffold user message appended after the conversation (e.g.
   * chapterx CLI-sim's "<cmd>cat untitled.txt</cmd>"). Prefill formatter only. */
  prefillUserMessage?: string;
  systemPrompt: string;
  /** Agent Framework exact-name tool allowlist. Omitted preserves its 'all' default.
   * This configures tool visibility; dispatch enforcement belongs to the framework. */
  allowedTools?: 'all' | string[];
  maxTokens?: number;
  /**
   * Per-agent stream token budget — the accumulated-input ceiling at which the
   * framework breaks the stream and lets the strategy compress. Mirrors the
   * runtime `/budget` command. When unset: contextBudgetTokens + 20k if the
   * budget is unset too (320k), else 150k — a recipe that sets its own budget
   * may be on a 200k-window model.
   */
  maxStreamTokens?: number;
  /** Per-agent context compile budget (input tokens). When unset, 300k —
   *  sized for 1M-window models; set it lower on a smaller window
   *  (budget + maxTokens must fit). */
  contextBudgetTokens?: number;
  /** Prompt-cache TTL ('5m' | '1h') forwarded to the provider. Defaults to
   *  '1h'; set '5m' explicitly for high-frequency, sub-5-minute workloads.
   *  Not forwarded on bedrock — that transport only has the default 5m
   *  cache and rejects the ttl field. */
  cacheTtl?: '5m' | '1h';
  /**
   * Prompt-cache keepalive. With `cacheTtl: '1h'`, an idle agent's cached
   * prefix expires after an hour and its next wake pays a 2x cache write over
   * the whole context. Reading an entry refreshes its TTL at 0.1x, so a
   * periodic `max_tokens: 0` replay holds it warm for pennies.
   *
   * On by default for the anthropic provider (ignored elsewhere — bedrock has
   * no 1h cache). Measured on fable-cm 2026-08-11..22: 49.7M tokens of cache
   * writes followed a >1h idle gap, ~$944 of write premium at fable-5 rates
   * that this converts to ~$308 of reads.
   *
   * Cost is proportional to actual idleness, not to `maxIdleHours` — a busy
   * agent never fires one, because its own traffic already refreshes the TTL.
   */
  cacheKeepalive?: {
    /** Default true (anthropic provider only). */
    enabled?: boolean;
    /** Stop refreshing this long after the last REAL request. Default 24. */
    maxIdleHours?: number;
    /** Refresh once untouched this long. Must be < 60 with a 1h TTL. Default 45. */
    refreshAfterMinutes?: number;
  };
  /**
   * Explicit prompt-caching override. Unset means provider-appropriate
   * default: on for everything except bedrock models that predate caching
   * support there (see bedrockModelSupportsPromptCaching). Set false if a
   * transport/account rejects cache_control markers — AWS's "your request
   * did not allow prompt caching" can also be account/region-dependent.
   */
  promptCaching?: boolean;
  /**
   * Same-round routing policy for ordinary text emitted beside think().
   * Omitted preserves the compatibility carry-forward in Agent Framework.
   */
  sameRoundThinkTextPolicy?: 'public' | 'private';
  /**
   * Prose delivery mode (agent-framework docs/explicit-prose-routing.md).
   * 'explicit' = model prefixes plain text with `>>destination`; unprefixed
   * prose bounces to a clipboard instead of auto-routing.
   * 'hybrid' = unprefixed prose keeps the current locus while an exact leading
   * `>>>destination` envelope routes through the authorized channel registry.
   * Default 'locus'.
   */
  proseRouting?: 'locus' | 'explicit' | 'hybrid' | 'disabled';
  /** Default-off containment of whole-response prose wrappers for known tools. */
  toolWrapperProseGuard?: boolean;
  /**
   * Extra Anthropic beta flags sent as the `anthropic-beta` header on every
   * request (e.g. `["context-1m-2025-08-07"]` for the 1M context window on
   * models where it is opt-in, like claude-sonnet-4-5). Merged with any
   * transport-required betas (OAuth). Anthropic provider only.
   */
  anthropicBetas?: string[];
  strategy?: RecipeStrategy;
  /**
   * Native extended thinking. When `enabled: true`, the agent's API requests
   * include Anthropic's thinking config and responses carry signed `thinking`
   * blocks. Required for matching the cognitive mode of claude.ai web Sonnet.
   */
  thinking?: {
    enabled: boolean;
    budgetTokens?: number;
    /** 'enabled' (explicit budget, legacy) or 'adaptive' (model-managed;
     * required by opus-4-7+ / fable-5 era models). */
    type?: 'enabled' | 'adaptive';
    /** 'summarized' returns readable reasoning summaries in `thinking`;
     * 'omitted' returns empty text + signature only. Models 4.7+ default
     * to 'omitted' server-side. */
    display?: 'summarized' | 'omitted';
    /** Anthropic streaming effort baseline, independent of enabled. Explicit agent
     * settings override it until reset; compression calls are unaffected. Other
     * providers ignore this field; OpenAI uses responses.reasoningEffort. */
    effort?: ReasoningEffort;
  };
  /** OpenAI Responses settings. Reasoning applies to both OpenAI providers;
   * compaction and serviceTier are API-key transport settings. */
  responses?: {
    reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    reasoningContext?: 'current_turn' | 'all_turns';
    compactThreshold?: number;
    /** OpenAI Responses API processing tier. `priority` is the API-key
     * equivalent of Codex fast mode. */
    serviceTier?: 'auto' | 'default' | 'flex' | 'priority';
  };
  /** ChatGPT-subscription Codex settings. Only used with
   * `provider: "openai-codex"`. Runtime `/fast` overrides fastMode. */
  codex?: {
    fastMode?: boolean;
  };
  /** Mock-provider settings. Only used with `provider: "mock"`. See
   * RecipeMockConfig. */
  mock?: RecipeMockConfig;
  /**
   * Content-refusal handling, handed whole to agent-framework's
   * AgentConfig.refusalHandling (framework-agent-config.ts), where
   * agent-framework documents `retries`, `autoRewind` and `maxRewinds`.
   */
  refusalHandling?: {
    retries?: number;
    autoRewind?: boolean;
    maxRewinds?: number;
    /**
     * @deprecated No agent-framework release reads it, so on any release it
     * changes nothing. A recipe that still sets it loads as before.
     */
    announceHumanTurns?: boolean;
  };
}

/**
 * Settings for membrane's MockAdapter (`agent.provider: "mock"`). The default
 * (no block) echoes the last user message back — the most informative shape
 * for interactive smoke runs, since you can see your own words complete the
 * loop. `echoMode: false` returns `defaultResponse` instead, which gives
 * deterministic output for scripted tests. The timing knobs and the queue let
 * a run reproduce delay-sensitive behavior (event coalescing during a slow
 * turn, say) offline.
 *
 * Each reply is chosen in this order: the next `responseQueue` entry, then
 * the echo, then `defaultResponse`. Unset numbers keep membrane's defaults.
 */
export interface RecipeMockConfig {
  /** Echo the last user message (`[Echo] …`). Default true in this host. */
  echoMode?: boolean;
  /** Reply when not echoing and the queue is empty. */
  defaultResponse?: string;
  /** Delay before a non-streamed `complete()` reply, in ms (membrane
   *  default 10). Agent turns stream; compression and session naming don't. */
  completeDelayMs?: number;
  /** Delay between streamed chunks, in ms (membrane default 5). There is no
   *  delay before the first chunk: a streamed reply of `L` characters takes
   *  about `(ceil(L / streamChunkSize) - 1) * streamChunkDelayMs`. */
  streamChunkDelayMs?: number;
  /** Characters per streamed chunk; a positive integer (membrane default 10). */
  streamChunkSize?: number;
  /** Replies returned in order, one per provider call, before falling back
   *  to the echo / `defaultResponse`. Every call through the adapter takes
   *  one, auxiliary calls (compression, session naming) included. */
  responseQueue?: string[];
}

export interface RecipeMcpServer {
  /** Command to spawn (stdio transport). Mutually exclusive with url. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Opt in to the full host environment for stdio servers, including those
   * defined in mcpl-servers.json. Prefer declaring needed variables in env.
   * Requires an agent-framework version with inheritEnv support. */
  inheritEnv?: boolean;
  /**
   * Per-request timeout for this server's outbound JSON-RPC (tools/call,
   * tools/list, channels/*), in milliseconds. Passed through to the
   * framework's `McplServerConfig.requestTimeoutMs`. Raise it for tools that
   * legitimately outlive the 60s default (image-generation gateways, long
   * searches); `0` disables the timeout.
   */
  requestTimeoutMs?: number;
  /** WebSocket URL (WebSocket transport). Mutually exclusive with command. */
  url?: string;
  transport?: 'stdio' | 'websocket';
  /** Bearer token for WebSocket auth (appended as ?token= query param). */
  token?: string;
  /**
   * Name of a host-managed access grant (archipelago audience, e.g.
   * "eidoverse"). Requires the `identity` module. The host resolves fresh
   * credentials per dial; neither the recipe nor the agent holds one.
   */
  access?: string;
  /** Namespace for this server's model-facing tool names. Default
   *  `mcpl--<id>`, so tools surface as `mcpl--<id>--<tool>`. */
  toolPrefix?: string;
  /**
   * Feature-set allow-list (`*` matches one dot-separated segment). Omitted:
   * every declared set is a candidate. `[]`: none (deny-all), in a recipe or
   * mcpl-servers.json alike; only the agent's own overlay file reads `[]` as
   * unset. A set whose declaration has no valid `uses` stays disabled either
   * way (MCPL §6.4, fail-closed).
   */
  enabledFeatureSets?: string[];
  /** Feature-set deny-list; wins over enabledFeatureSets on overlap. */
  disabledFeatureSets?: string[];
  /**
   * Tool allow-list (bare tool names as the server exports them, no toolPrefix).
   * `*` is a substring wildcard (`read_*`, `*_file`, `*`).
   * If set, only matching tools are exposed to the model AND callable at dispatch.
   */
  enabledTools?: string[];
  /**
   * Tool deny-list (same syntax as enabledTools). Wins over enabledTools on overlap.
   * Denied tools are hidden from the model and rejected at dispatch — both, so a
   * model that imitates a prior call from message history can't sneak the call through.
   */
  disabledTools?: string[];
  reconnect?: boolean;
  /** Base reconnect interval; the framework doubles it per consecutive
   *  failure (with jitter) up to reconnectMaxIntervalMs. */
  reconnectIntervalMs?: number;
  /** Ceiling for the exponential reconnect backoff. Default: 5 minutes. */
  reconnectMaxIntervalMs?: number;
  /**
   * @deprecated One-time migration input for legacy recipes. Runtime channel
   * desired state is Chronicle-backed and changed with channel_open/close.
   */
  channelSubscription?: 'auto' | 'manual' | string[];
  /**
   * Optional install metadata for build/deploy tooling (e.g. connectome-cook).
   * Ignored by the recipe loader at runtime — agents don't need this; only
   * tools that produce deployable artifacts (Docker images, etc.) do.
   */
  source?: RecipeMcpServerSource;
  /**
   * Auxiliary credential / config files this MCP server needs at runtime
   * (e.g. `.zuliprc` for the Zulip adapter, `~/.netrc` for HTTP-auth APIs,
   * a `gcloud.json` service-account key for Google APIs).  Build tooling
   * collects values from the operator (env vars or interactive prompts),
   * writes the file, and bind-mounts it into the container.  The recipe
   * loader itself does NOT touch these — the runtime reads the file via
   * whatever path the MCP server expects (typically declared in `env`).
   *
   * Like `source`, this is build-tooling metadata.  Ignored at runtime.
   */
  credentialFiles?: RecipeCredentialFile[];
  /**
   * MCPL tool lifecycle (RFC-007) policy for this server: whether it may
   * observe the agent's OTHER tool calls (`observe`) and their requested
   * argument fields (`inputs`), each with an optional narrowing. Both are
   * denied by default; stating a block is the operator's grant. `inputs`
   * needs a `tools` or `classes` term to deliver anything, and never carries
   * `comms` or unclassed arguments. See src/tool-lifecycle-config.ts.
   */
  toolLifecycle?: RecipeToolLifecycle;
}

/** A narrowing for one tool-lifecycle path (RFC-007 §4.3). Every stated key
 *  must hold; patterns use the RFC-007 §6.2 grammar (`*` = any run). */
export interface RecipeToolLifecycleNarrowing {
  /** Patterns over the model-facing tool name: `mcpl--<serverId>--<tool>`
   *  for an MCPL server's tools unless its entry sets `toolPrefix`
   *  (`mcpl--cua--*`), `<module>--<tool>` for host modules. */
  tools?: string[];
  /** RFC-008 classes the tool must have one of; `"default"` = computer,
   *  shell, files, web, media, body. */
  classes?: string[] | 'default';
  /** Patterns over the conversation id (the agent name in this host). */
  conversations?: string[];
}

export interface RecipeToolLifecycle {
  observe?: RecipeToolLifecycleNarrowing;
  inputs?: RecipeToolLifecycleNarrowing;
  /** Serialized-size bound for argument payloads. Framework default 16 KiB. */
  maxInputBytes?: number;
}

/**
 * How to obtain and install an MCP server at deploy time.  Consumed by
 * build tooling like connectome-cook.  Exactly one of `url` (git form) or
 * `npm` (registry form) must be set; tools may require more depending on
 * the install pattern they're generating.
 */
export interface RecipeMcpServerSource {
  /** Git URL to clone from. Mutually exclusive with `npm`. */
  url?: string;
  /**
   * npm registry package spec (`pkg@version` / `@scope/pkg@version`) that
   * build tooling bakes via a global install instead of a git clone —
   * matches connectome-cook's `source.npm` grammar.  The git-form fields
   * (`ref`, `install`, `inContainer`, ...) don't apply.  Mutually
   * exclusive with `url`.
   */
  npm?: string;
  /**
   * Git ref: branch, tag, or commit SHA.  Default: "main".
   * If the value starts with "refs/" (e.g. "refs/pull/3/head"), it's
   * treated as an explicit refspec — tools fetch it then check out
   * FETCH_HEAD.  Useful for tracking PR heads on GitHub/GitLab.
   */
  ref?: string;
  /**
   * How to install inside the cloned dir at build time.
   *   "npm"           runs `npm install && npm run build`; implies node runtime.
   *   "pip-editable"  creates a venv at `.venv/` and runs `pip install -e .`;
   *                   implies python3 runtime.
   *   { run, runtime } runs an arbitrary shell command from the cloned dir;
   *                   `runtime` tells the tool which base packages to install
   *                   in the image (node / python3 / custom / bun = no defaults).
   * Omit entirely for sources that need no build step (e.g. the tool is
   * fetched at runtime by npx/uvx — the recipe's `command` is enough).
   */
  install?:
    | 'npm'
    | 'pip-editable'
    | { run: string; runtime: 'node' | 'python3' | 'custom' | 'bun' };
  /**
   * Build-arg name for an auth token if the URL is private.
   * Tools consuming `source` should mount this via BuildKit secrets
   * (so the token doesn't leak into image layers).  The same env var
   * name is typically already needed at runtime by the operator's
   * `.env`, so this field doesn't introduce new secret surface.
   */
  authSecret?: string;
  /**
   * True if the URL's TLS cert isn't in the container's trust store
   * (e.g. self-signed internal CAs on private GitLab/Gitea).  Tools
   * should add `-c http.sslVerify=false` to the git clone of this source.
   * Prefer installing a proper CA bundle in the image over using this flag.
   */
  sslBypass?: boolean;
  /**
   * Override the in-container path of the installed source.  Default:
   * `/<basename-of-url-without-.git-suffix>` (e.g. the URL
   * `https://github.com/x/zulip_mcp.git` places the source at `/zulip_mcp`).
   */
  inContainer?: { path: string };
  /**
   * Extra apt packages this source needs in the runtime image (e.g.
   * `ffmpeg`/`curl` for a tool that shells out to them).  Build tooling
   * appends these to the runtime stage's apt install; connectome-host
   * ignores the field at runtime (it doesn't build images).
   */
  systemPackages?: string[];
}

/**
 * One auxiliary credential or config file the MCP server reads at runtime.
 * Build tooling (cook, etc.) prompts the operator for the field values,
 * serializes them in the declared format, and writes the file at the
 * declared path so the bind-mounted file appears in the container.
 *
 * Example for Zulip's `.zuliprc`:
 * ```json
 * {
 *   "path": "./.zuliprc",
 *   "format": "ini",
 *   "section": "api",
 *   "mode": "0600",
 *   "fields": [
 *     { "name": "email", "envOverride": "ZULIP_EMAIL", "placeholder": "bot@example.zulipchat.com" },
 *     { "name": "key",   "envOverride": "ZULIP_KEY",   "placeholder": "abc123...", "secret": true },
 *     { "name": "site",  "envOverride": "ZULIP_SITE",  "placeholder": "https://example.zulipchat.com" }
 *   ]
 * }
 * ```
 */
export interface RecipeCredentialFile {
  /** Where the runtime expects the file.  In a Docker context this also
   *  determines the bind-mount target; the host-side path is `<outDir>` +
   *  basename(path).  Relative paths resolve against the conductor's CWD
   *  (typically `/app`); absolute paths land verbatim. */
  path: string;
  /** Serialization format.  `ini` writes `key=value` lines under an
   *  optional `[section]` header; `json` writes `{ "field": "value", ... }`;
   *  `env` writes `KEY=value` (no quoting). */
  format: 'ini' | 'json' | 'env';
  /** Optional INI section header (`[<section>]`) preceding the fields.
   *  Ignored by `json` / `env` formats. */
  section?: string;
  /** Filesystem mode as an octal string.  Default `0600` (typical for
   *  credentials).  Build tooling sets this on the host file before bind-
   *  mounting; the container inherits the mode through the mount. */
  mode?: string;
  /** Fields the operator must supply. */
  fields: RecipeCredentialFileField[];
}

export interface RecipeCredentialFileField {
  /** Field name as written in the file (e.g. `email`, `key`, `site`).
   *  For `ini` / `env` formats this is the literal key.  For `json` it
   *  becomes the JSON property name. */
  name: string;
  /** Optional env var name that, when set in `process.env` (or supplied
   *  via cook's `--env-file`), substitutes for prompting.  Lets the
   *  operator pre-set values in CI / scripted contexts. */
  envOverride?: string;
  /** Operator-facing description of what to enter (one short line). */
  description?: string;
  /** Placeholder shown next to the prompt (e.g. `bot@example.zulipchat.com`). */
  placeholder?: string;
  /** When true, build tooling masks the input (no echo while typing).
   *  Default `false`. */
  secret?: boolean;
}

/**
 * A recipe's workspace mount: every key of agent-framework's MountConfig but
 * those named in `MountKeyNotPassedOn`, passed to the framework as given but
 * for `path`, which is resolved
 * (workspace-mounts.ts), with `mode` and `watch` optional because the host
 * defaults them. The maximum file size is
 * operator-configurable because binary service artifacts may legitimately
 * exceed the conservative framework default.
 */
export interface RecipeWorkspaceMount {
  name: string;
  path: string;
  mode?: 'read-write' | 'read-only';
  watch?: 'always' | 'on-agent-action' | 'never';
  ignore?: string[];
  /** Maximum file size in bytes (defaults to the framework's 5 MiB limit). */
  maxFileSize?: number;
  /**
   * The most entries one walk of this mount takes: files, and links or other
   * entries that aren't directories (agent-framework's default, 5000, unless
   * set). A whole number from 1 to `Number.MAX_SAFE_INTEGER`, as
   * agent-framework takes it; anything else stops the recipe loading, naming
   * the mount. A sync that reaches the cap reports the rest as incomplete,
   * and the next sync of the same scope resumes after the last entry it took,
   * so repeated syncs cover a larger mount. agent-framework makes that place
   * durable with the store's next sync, so if the machine goes down before
   * then, a sync can start again from an earlier place. A watched mount's catch-up scan takes its
   * turn in the same rotation, so on a mount over the cap a change made while
   * the host was down waits for the rotation to reach it. Listings (`ls`,
   * `glob`, `grep`) and an `on-agent-action` scan take up to the cap from
   * their scope's start every time. It bounds what a walk observes, not its
   * work: directories don't count, and each one the walk visits is read
   * whole.
   */
  walkCap?: number;
  /**
   * Request inference when files in this mount change. Pair with
   * `watch: 'always'` so chokidar actually observes the mount.
   * - `true` — any of created | modified | deleted
   * - array — only the listed ops
   */
  wakeOnChange?: boolean | Array<'created' | 'modified' | 'deleted'>;
  /**
   * Persist every write/edit/delete to disk immediately. Required for mounts
   * shared across agents as a communication channel (tickets, reports, etc.)
   * so other agents' chokidar watchers actually see the change.
   */
  autoMaterialize?: boolean;
  /** With `watch: 'always'`, how long changes are gathered before the workspace looks at them, in ms (the framework's default is 300). */
  watchDebounceMs?: number;
  /** With `watch: 'always'`, how often the watcher checks that the mount's directory is still the one it watches, in ms (the framework's default is 2000). */
  watchRootPollMs?: number;
  /**
   * Passed to agent-framework's mount: whether the workspace follows a
   * symlink inside the mount (the framework's default is off), a file that
   * is itself a link and, from the framework's release with
   * anima-research/agent-framework#468, a link among a path's directories
   * too, which earlier releases follow either way. The framework still
   * doesn't read through a link whose target lies outside the mount.
   */
  followSymlinks?: boolean;
}

export interface RecipeModules {
  /**
   * Subagent forking (spawn/fork parallel agents). OPT-IN — defaults to off
   * and is not part of the standard recipe.
   */
  subagents?: boolean | { defaultModel?: string; defaultMaxTokens?: number };
  /**
   * Lesson library (persistent knowledge store + lesson tools). OPT-IN —
   * defaults to off and is not part of the standard recipe.
   */
  lessons?: boolean;
  /**
   * Lesson retrieval-injection (requires `lessons`). OPT-IN — defaults to off
   * and is deliberately not part of the standard recipe: it injects
   * context-dependent content into every compile and spends up to two
   * configured retrieval-model calls. Enable only for agents that actually
   * curate a lesson library.
   */
  retrieval?: boolean | {
    model?: string;
    maxInjected?: number;
    /**
     * Optional OpenAI Responses/Codex reasoning effort for both retrieval calls.
     * Requires an explicit retrieval model.
     */
    reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  };
  wake?: boolean | import('@animalabs/agent-framework').GateConfig;
  workspace?: boolean | { mounts: RecipeWorkspaceMount[]; configMount?: boolean };
  /**
   * Shared operating instructions. OPT-IN — off by default. Reads a living
   * instructions document (a CLAUDE.md analogue maintained in a workspace
   * mount) and injects its current content into EVERY agent's context on
   * EVERY turn — the resident agent and all ephemeral subagents — via the
   * gatherContext hook. Injections are per-turn overlays (not persisted to
   * Chronicle), so edits to the file take effect on the next turn.
   *
   * Requires `workspace` (the path below is a workspace mount path);
   * enabling this alongside `workspace: false` fails validation. The mount
   * named by the path is cross-checked at load time in every configuration
   * (explicit mounts and the implicit "input"+"products" default alike), so
   * a path naming a nonexistent mount is a load error, never a silent
   * no-injection. A read-write instructions mount must also set
   * `autoMaterialize: true`: workspace writes are Chronicle-first and the
   * injection reads disk, so without materialization an agent's own
   * curation edits would never reach the injection. A read-only mount is
   * the alternative when the file is maintained outside the agent (edits
   * then propagate to the injection but not to `workspace--read`, which
   * serves Chronicle). A missing FILE remains fail-open at runtime: no
   * injection, with a log line and an `instructions-unavailable` ops alert.
   *
   * Cache economics: with position 'system' the injected block sits in the
   * prompt-cache prefix of every agent, so each EDIT to the file is a
   * fleet-wide cache cold start on the next turn (steady state between
   * edits caches normally). Curate in batches rather than per-message;
   * 'afterUser' is the cache-cheap, lower-salience alternative.
   */
  instructions?: boolean | {
    /** Workspace path "<mountName>/<relativePath>". Default "instructions/AGENTS.md". */
    path?: string;
    /**
     * Heading line prepended to the injected block.
     * Default "# Shared operating instructions (live document)".
     */
    header?: string;
    /**
     * Truncate content beyond this many bytes, appending a
     * "[truncated: first N of M bytes]" marker (N may sit up to 3 bytes
     * under the cap when a multibyte character straddles it). Reads ask for
     * no more than this. Default 32768.
     */
    maxBytes?: number;
    /** Where the block lands: 'system' (default) | 'beforeUser' | 'afterUser'. */
    position?: 'system' | 'beforeUser' | 'afterUser';
  };
  /**
   * Surface agent composition activity (typing indicators) to one or more
   * MCPL channels while inference is active. Opt-in per recipe; channel IDs
   * use the MCPL format (e.g. `zulip:tracker-miner-f`). The agent can also
   * adjust the set at runtime via the `activity:show_in` / `activity:hide_in`
   * tools.
   */
  activity?: boolean | { channels?: string[] };
  /**
   * Outage notices: tell the people in the agent's channels, through those
   * channels, when the host cannot answer them. A sink of the framework's
   * `ops:alert` stream (hard-down, spent quota, expired/rejected credential,
   * pending login, provider hold, MCPL server down, …). Off by default:
   * writing into a channel is a bigger act than showing a typing indicator.
   *
   * - `statusChannels` — always get the operator-grade message (kind + error
   *   text) for `status` and `reply` kinds, after `quietMs` without a clear.
   * - `reply.in` / `reply.not` — channel-id patterns (`zulip:*`, exact ids)
   *   where a person who writes to the agent during an outage gets one canned
   *   "cannot respond right now" line, and where the channel whose message
   *   triggered the failing turn is told the same. Default `in: ['*']`.
   * - `kinds` — tier per alert kind (`silent` | `status` | `reply`), `*`
   *   wildcard allowed (`'auth-*': 'reply'`), merged over the built-in table;
   *   unknown kinds are silent.
   * - `quietMs` (default 60000), `renotifyMs` (default 1800000).
   *
   * `true` = reply anywhere the agent is subscribed, no status channels.
   */
  notices?: boolean | {
    statusChannels?: string[];
    reply?: { in?: string[]; not?: string[] };
    kinds?: Record<string, 'silent' | 'status' | 'reply'>;
    quietMs?: number;
    renotifyMs?: number;
  };
  /**
   * MCPL self-administration. Off by default. When enabled, the agent gets
   * `mcpl_list` / `mcpl_deploy` / `mcpl_restart` / `mcpl_unload` tools to
   * hot-manage its own MCPL servers without a host restart. Deployments
   * persist to `mcpl-servers.agent.json` (the agent overlay), merged over the
   * recipe/file server list at startup.
   *
   * SECURITY: `mcpl_deploy` spawns arbitrary commands as the host user —
   * enabling this module means trusting the agent with code execution.
   *
   * `{ surface: 'utilities' }` keeps the module but parks its four tools
   * behind the framework's single `utils` meta-tool (mcpl management is
   * rare; it needn't cost four schemas on every inference). `true` keeps
   * the historical first-class surface.
   */
  mcplAdmin?: boolean | { surface?: 'tools' | 'utilities' };

  /**
   * Agent-facing history browsing (HistoryModule, agent-framework#158). OPT-IN
   * — off by default. Adds `history--stats` / `history--extract` /
   * `history--search` / `history--overview` tools for querying the agent's
   * own uncompressed chronicle (native secondary indexes: stats, time/channel
   * extraction, regex search) and for browsing already-compressed spans via
   * existing summaries (no new LLM calls). Channel-filter arguments on all
   * four tools accept a live or historical channel label/address, not just
   * the raw internal channel id, when MCPL is configured (resolved via the
   * framework's `ChannelRegistry`).
   *
   * Object form adds `history--semantic_search`: meaning-based search over the
   * agent's raw messages (text + its own think/journal/skip_reply notes) and
   * every compression summary, backed by a shared remote embed-service (one
   * per fleet; the vector index lives server-side, keyed by `namespace`).
   * The host keeps that index in sync in the background (default every 60 s)
   * and catches up before each search. `token` goes through the recipe's
   * `${ENV}` substitution like every other secret.
   *
   * Namespace: always `<prefix>/<session id>`, where `namespace` (default: the
   * agent name) is only the PREFIX — message ids are sequential per store, so
   * two stores in one namespace would overwrite each other's entries. A
   * COPIED data dir (staging restore, a local run off a prod snapshot) keeps
   * the session id: give the copy a different `namespace` prefix, or no
   * token, or it will write into the original's index.
   *
   * Requires @animalabs/agent-framework >= 0.20.0; startup fails if the
   * installed HistoryModule does not offer semantic_search.
   *
   * Transport: sync ships raw message text and the token. `url` must be https,
   * or plain http to loopback / the tailnet (100.64.0.0/10, *.ts.net), where
   * WireGuard is the encryption; any other http needs `allowInsecureHttp: true`.
   *
   * What the remote index holds: with `includePrivateTools` at the
   * framework default (true), the agent's think/journal/skip_reply prose is
   * indexed too. Search hits are checked against the CURRENT branch, so
   * /undo, /checkout etc. hide undone turns from results, but the remote
   * copy stays; `/session delete` removes only the local store, not the
   * remote namespace (the client has no namespace delete).
   */
  history?: boolean | {
    semantic?: {
      url: string;
      token?: string;
      namespace?: string;
      syncIntervalMs?: number;
      maxSyncPerTick?: number;
      maxSyncBeforeSearch?: number;
      includePrivateTools?: boolean;
      /** Allow plaintext http to a host outside loopback/tailnet. Host-side only. */
      allowInsecureHttp?: boolean;
    };
  };

  /**
   * The agent's own archipelago-home identity (connectome docs/home-node.md):
   * an ed25519 keypair in the data dir, enrolled at the home node via an
   * operator invite, exchanged for fresh aid1 audience tokens on demand.
   * Utilities-only (`utils run identity--status/enroll/token`) — costs no
   * tool slots. `home` defaults to id.animalabs.ai; `audience` is the
   * default for `token` calls.
   */
  identity?: boolean | { home?: string; audience?: string };
  /**
   * Cross-process child fleet.  When true (shorthand), FleetModule is attached
   * with no pre-configured children.  When an object, declares children the
   * conductor supervises (auto-started by default on framework start) and
   * optionally an allowlist of recipe paths the conductor may spawn at will.
   * Recipes outside the allowlist require user approval.
   *
   * Recipe path resolution: relative paths in `children[].recipe` are resolved
   * at load time against the directory of the parent recipe file (or URL
   * base), NOT the process CWD. This lets a recipe bundle live anywhere on
   * disk and reference its siblings portably. Absolute paths and http(s)
   * URLs pass through unchanged.
   *
   * Note: this differs from runtime paths (workspace mounts, `dataDir`),
   * which stay CWD-relative because they describe where the running process
   * puts its state.
   */
  fleet?: boolean | RecipeFleet;

  /**
   * Web admin UI. Off by default. The default bind is 0.0.0.0:7340 (connectome
   * deployments are remote, not local), which hard-requires Basic-Auth: a
   * recipe that enables webui MUST supply `basicAuth`, or the host refuses to
   * start. Credentials should be `${VAR}`-substituted from .env, never literal.
   *
   * For remote admin, front this with a reverse proxy (Caddy/nginx) for TLS;
   * Basic-Auth is still required at the app layer. Set `host: '127.0.0.1'` to
   * bind loopback-only for local development, which skips the auth requirement.
   */
  webui?: boolean | RecipeWebUi;

  /**
   * Live TTS streaming tap (melodeus-tts-relay). Off by default. When set,
   * the host mirrors the agent's streaming generation — chunks, block
   * boundaries, activation start/end, tagged with the turn's channel — to the
   * relay's `/bot` WebSocket, where voice clients (Melodeus / iOS) speak it.
   * Also handles the relay's `interruption` events: the just-posted Discord
   * message is edited down to the words actually voiced, and a note lands in
   * the agent's context. Pure trace-bus tap — no effect on the agent loop.
   * `token` should be `${VAR}`-substituted from .env, never literal.
   */
  ttsRelay?: RecipeTtsRelay;

  /**
   * Auto-unsubscribe noisy ambient channels. On by default. Per subscribed
   * channel, the host counts ambient (non-mention, non-DM) characters since the
   * agent's last activation; when a channel crosses its limit before the next
   * activation, it's auto-unsubscribed (delivery stops, and the surface starts
   * tracking what's then missed). Counters reset on every activation — the
   * agent sees all subscribed channels in context, compressed if large — and
   * persist across restarts. The agent can override the per-channel limit at
   * runtime via `agent_settings` (field `channel_idle_limits`).
   *
   * `false` disables entirely. `defaultLimitChars` sets the global default
   * (20000 if omitted). `serverId`/`toolPrefix` target the MCPL surface that
   * owns subscriptions (defaults: `discord` / `mcpl--discord`).
   */
  subscriptionGc?:
    | boolean
    | { defaultLimitChars?: number; serverId?: string; toolPrefix?: string };

  /**
   * One-step channel attention modes (the `set_channel_mode` tool): flip a
   * channel between mentions-only and every-message-debounced. Debounced mode
   * bundles subscribe + a per-channel ambient debounce gate rule + pinning
   * subscription-gc off; mentions mode reverses all three. On by default when
   * the gate (`wake`) is enabled — it only ADDS a tool, inert until called.
   * `false` disables. `serverId`/`toolPrefix` target the MCPL surface that owns
   * subscriptions (defaults: `discord` / `mcpl--discord`); `defaultDebounceMs`
   * sets the debounced-mode quiet window (180000 if omitted).
   */
  channelMode?:
    | boolean
    | { serverId?: string; toolPrefix?: string; gcModuleName?: string; defaultDebounceMs?: number };

  /**
   * Self-restart (`lifecycle--restart`). Off by default. The agent can ask
   * its own host to restart: to pick up an edited recipe or rebuilt code, or
   * to get out of a wedged state. The restart waits for the asking turn to
   * end and nothing to be in flight (every agent idle, no turn, subagent run
   * or background script alive), then the host exits with code 75 and its
   * supervisor must start it again — launchd `KeepAlive`, systemd
   * `Restart=on-failure` or `always`, or a fleet parent's `autoRestart`. A
   * fleet parent restarts a child only when the child's entry sets
   * `autoRestart`, and counts each restart toward its cap of 3 in 60 s, so
   * `cooldownMinutes: 0` can leave a fast-restarting child down; a child the
   * parent adopted has no exit it sees, and stays down. A fleet parent's own
   * self-restart stops its children as any shutdown does, and the restarted
   * parent starts again only its `autoStart` children. Only
   * headless mode arms it; elsewhere the tool refuses. After the restart one
   * context line says which agent asked, when, why, and when the host came
   * back.
   *
   * `cooldownMinutes` (default 10) is the least time from one completed
   * self-restart to the next request; 0 turns the cooldown off. The request
   * and the last completed restart live in `DATA_DIR` as `self-restart.json`
   * and `self-restart.last.json`.
   *
   * Enable it only where a supervisor really restarts the host: without one,
   * the agent stays down after its own request.
   */
  selfRestart?: boolean | { cooldownMinutes?: number };
}

export interface RecipeWebUi {
  port?: number;
  host?: string;
  /**
   * Where the observer grant tools (observers--get/grant/revoke) surface:
   * 'tools' (default, historical) or 'utilities' (behind the `utils`
   * meta-tool — grant edits are rare). Consent semantics unchanged: the
   * agent holds the pen either way.
   */
  observersSurface?: 'tools' | 'utilities';
  /**
   * Basic-Auth credentials. Required whenever the bind host is non-loopback
   * (which is the default). `${VAR}`-substitutable from .env.
   */
  basicAuth?: { username: string; password: string };
  /**
   * Override the default Origin allowlist for the WebSocket upgrade. Default
   * is `http(s)://127.0.0.1:<port>` and `http(s)://localhost:<port>`. Add
   * your reverse-proxy origin (e.g. `https://admin.example.com`) here when
   * fronted by Caddy/nginx. Pass `[]` to disable the Origin check entirely
   * — only sensible when something else upstream is enforcing it.
   */
  allowedOrigins?: string[];
}

export interface RecipeTtsRelay {
  /** Relay bot endpoint, e.g. "ws://localhost:8800/bot". */
  url: string;
  /** Shared secret for the relay's /bot auth (its BOT_TOKENS). */
  token: string;
  /** Relay-side bot identifier. Defaults to the agent's name. */
  botId?: string;
  /** Discord user id stamped on stream events (client voice-config key).
   *  Defaults to botId. */
  userId?: string;
  /** Display name stamped on stream events. Defaults to the agent's name. */
  username?: string;
  /** MCPL server id owning `edit_message` for interruption trims. Default 'discord'. */
  editServerId?: string;
  reconnectIntervalMs?: number;
  /** Drop a context note when an interruption trims a posted message. Default true. */
  notifyOnInterruption?: boolean;
}

export interface RecipeFleet {
  /** Children to manage. autoStart children launch when the framework starts. */
  children?: RecipeFleetChild[];
  /**
   * Allowlist for `fleet--launch`.  If omitted, the list is implicitly the
   * set of recipe paths named in `children`.  A launch call targeting a
   * recipe outside the allowlist fails with an error the agent should
   * relay to the user (who can then approve and re-issue).
   *
   * Pattern syntax (intentionally minimal to keep matcher and intent aligned):
   *   - Literal exact match: `"recipes/miner.json"`
   *   - Single `"*"`: allow everything
   *   - Trailing `"*"` only (prefix match): `"recipes/*"` matches any path
   *     under `recipes/`.  A mid-string `*` is rejected at validation time
   *     — it would look like a glob but behave only as a literal.
   */
  allowedRecipes?: string[];
  /** Default subscription sent to each child at handshake if they don't specify their own. */
  defaultSubscription?: string[];
  /**
   * Spawn-readiness timeouts forwarded to FleetModule.  Bump these when a
   * child's startup work (heavy MCP servers, large state load) won't fit
   * inside the FleetModule defaults (15s / 10s / 10s / 5s respectively).
   */
  socketWaitTimeoutMs?: number;
  readyTimeoutMs?: number;
  gracefulShutdownMs?: number;
  sigtermEscalationMs?: number;
}

export interface RecipeFleetChild {
  name: string;
  /**
   * Recipe path or http(s) URL.  Relative paths are resolved at `loadRecipe`
   * time against the directory of the parent recipe file (or URL base), so
   * a sibling recipe is referenced by its filename regardless of where the
   * parent is launched from.  Absolute paths and URLs pass through
   * unchanged.
   */
  recipe: string;
  /** Data dir override; default `./data/<name>`. */
  dataDir?: string;
  /** Env overrides on top of parent env. */
  env?: Record<string, string>;
  /**
   * Event subscription at handshake (supports glob like `tool:*`).
   * Relevant synthetic events the parent may care about:
   *   - `lifecycle` (includes `ready` / `idle` / `exiting`) — required for fleet--await.
   *   - `inference:speech` — per-final-inference speech text, required for fleet--relay.
   *   - `inference:completed` / `inference:failed` / `tool:completed` / `tool:failed` — useful for status tracking.
   */
  subscription?: string[];
  /** Launch this child on framework start. Default: true. */
  autoStart?: boolean;
  /** Respawn on crash (Phase 5 honours this; schema accepts it now). */
  autoRestart?: boolean;
}

/**
 * A deployment-specific code extension: a local TS/JS module that registers
 * custom context strategies and/or framework modules at boot. See
 * src/extensions.ts for the loader and the `register(api, config)` contract.
 */
export interface RecipeExtension {
  /** Primary purpose. Gates validation (a non-built-in `agent.strategy.type`
   *  requires at least one `kind: "strategy"` extension) and informs build
   *  tooling; does not restrict what `register` may call. */
  kind: 'strategy' | 'module';
  /** Path to the extension entry module. Relative paths resolve against the
   *  recipe file's directory at load time; URL-loaded recipes must use
   *  absolute paths (the host never imports code over the network). */
  path: string;
  /** Opaque blob passed verbatim to the extension's `register` function and
   *  to module factory contexts. */
  config?: Record<string, unknown>;
  /** Build-tooling acquisition metadata (git url/ref/install pattern) —
   *  consumed by connectome-cook at build time, ignored at runtime. */
  source?: Record<string, unknown>;
  /** Build-only provenance: `source` demoted by build tooling into the
   *  shipped recipe. Ignored at runtime. */
  sourceMeta?: Record<string, unknown>;
}

/**
 * Client-side programmatic tool calling (af `code_execution` tool), passed to
 * the framework as written, so it is the framework's own config type.
 *
 * SECURITY: from agent-framework 0.24, model-authored JavaScript runs in a
 * QuickJS WebAssembly engine, in a child process of the host, and reaches
 * nothing but its agent's tools: no network, files or environment. The
 * framework claims no containment beyond its engine and glue: the child runs
 * as the host's user, with no operating-system sandbox around it. Enable
 * deliberately.
 */
export type RecipeCodeExecution = CodeExecutionConfig;

/**
 * What agent-framework 0.24's JavaScript runner refuses from the Python
 * runner's settings, with what to do instead: its isolateSettings' table,
 * which the package doesn't export. The host refuses them at recipe load, as
 * the framework does at create(), so such a recipe fails before the host
 * starts rather than at the framework's boot.
 */
const RETIRED_CODE_EXECUTION_KEYS: Readonly<Record<string, string>> = {
  pythonPath: 'scripts are JavaScript now, run by an engine built into agent-framework, so there is no interpreter to name; leave it out',
  idleReclaimMs: 'each script starts fresh and keeps nothing after it ends, so there is nothing to reclaim; leave it out',
  env: "a script's world holds only your agent's tools, with no environment; leave it out",
  inheritEnv: "a script's world holds only your agent's tools, with no environment; leave it out",
  scriptTimeoutMs: 'a script now yields at its bound and keeps running: set yieldMs for the bound',
  maxScriptTimeoutMs: 'set maxYieldMs, the most an agent may ask a run or a wait to wait',
  backgroundMaxLifetimeMs: 'every script now has one limit: set scriptLifetimeMs',
  maxBackgroundScripts: 'set maxRunningScripts, how many scripts an agent may have running at once, yielded ones included',
};
/** The runner's numeric settings, each a whole number of 0 or more; the
 *  framework checks their ranges when it builds the runner. */
const CODE_EXECUTION_NUMBER_KEYS = [
  'yieldMs', 'maxYieldMs', 'scriptLifetimeMs', 'maxRunningScripts', 'maxScriptChildren',
  'toolCallTimeoutMs', 'wakeMinIntervalMs', 'maxWakesPerScript', 'memoryMaxBytes',
] as const;

/**
 * The subconscious resident (agent-framework FrameworkConfig.subconscious,
 * issue agent-framework#77 — tune-out): a persistent same-model side-agent
 * that receives traffic from channels the resident has tuned out and
 * reports to them in its own voice. Passed through verbatim; the framework
 * owns the defaults (name `Subconscious`, model = the resident's).
 */
export interface RecipeSubconscious {
  /** Master switch. Without it the `tune_out` tool is not offered. */
  enabled: boolean;
  /** Registry + participant name (default 'Subconscious'). */
  name?: string;
  /** Model id (default: the resident's model — same-model side-process). */
  model?: string;
  /** The voice/criteria mode block: report-shaped, second person toward the
   *  resident. Co-authored with the resident; canary before fleet use. */
  systemPrompt: string;
  /** Allow `speak_in_channel` (default false until the voice block has
   *  passed its canary). */
  allowChannelSpeech?: boolean;
  /** WindowedPassthroughStrategy re-anchor fraction in (0, 1] (default 0.5). */
  reAnchorFraction?: number;
}

/**
 * Per-channel conversation routing (agent-framework ConversationRouter):
 * the recipe's agent becomes a dormant "trunk" template, and qualifying
 * incoming channel messages spawn per-channel fork agents seeded from the
 * trunk's current context. The host fills in what the framework needs but a
 * recipe can't say: `templateAgent` is always the recipe's own agent, and
 * `strategyFactory` builds a fresh instance of the recipe's `agent.strategy`
 * per fork (strategy instances are stateful and must never be shared).
 *
 * @deprecated Per-channel conversation routing is deprecated and will be
 * removed (agent-framework#235). Its 'mention' bind/trigger rule reads
 * `metadata.mentioned`, which discord-mcpl does not set, so on Discord
 * channels an @-mention neither binds a fork nor triggers a bound one. Still
 * works; the host logs a `[deprecated]` line at startup when it is set.
 */
export interface RecipeConversations {
  /** When an unbound channel acquires a fork.
   * Defaults: dm 'always', groupDm 'always', channel 'mention'. */
  bind?: {
    dm?: 'always' | 'mention' | 'never';
    groupDm?: 'always' | 'mention' | 'never';
    channel?: 'always' | 'mention' | 'never';
  };
  /** When a message on a bound channel triggers inference (it always lands
   * in the fork's context regardless).
   * Defaults: dm 'always', groupDm 'mention', channel 'mention'. */
  trigger?: {
    dm?: 'always' | 'mention';
    groupDm?: 'always' | 'mention';
    channel?: 'always' | 'mention';
  };
  /** Idle time before a binding expires and the fork runs its closure turn.
   * Default 12h. Expiry is checked at most about once a minute, so the sweep
   * usually notices an expired binding up to ~60s after the TTL elapses.
   * That is the usual extra delay, not a deadline for closing the fork: the
   * closure turn can be delayed further (e.g. while the host is quiesced, it
   * stays queued until resume). */
  idleTtlMs?: number;
  /** Final system-initiated user message sent to a fork on expiry. */
  closurePrompt?: string;
  /** Prefix for generated fork agent names (default 'conversation'). Also
   * the Chronicle namespace segment, so it is restricted to [A-Za-z0-9_-]. */
  agentPrefix?: string;
}

/**
 * Deprecation notices for a recipe's `conversations` block, one
 * human-readable line each (empty when it is absent). Pure — the host prints
 * these at startup with a `[deprecated]` prefix.
 */
export function deprecatedConversationsNotices(conversations: RecipeConversations | undefined): string[] {
  if (!conversations) return [];
  return [
    'conversations (per-channel conversation routing) is deprecated and not recommended for new ' +
      'recipes; it will be removed in a later release (agent-framework#235). Its \'mention\' ' +
      'bind/trigger rule reads metadata.mentioned, which discord-mcpl does not set, so on Discord ' +
      'channels an @-mention neither binds a fork nor triggers a bound one. Routing still works ' +
      'as before for now.',
  ];
}

export interface Recipe {
  name: string;
  description?: string;
  version?: string;
  agent: RecipeAgent;
  mcpServers?: Record<string, RecipeMcpServer>;
  modules?: RecipeModules;
  /** Deployment-specific code extensions, keyed by a human-readable name. */
  extensions?: Record<string, RecipeExtension>;
  sessionNaming?: { examples?: string[] };
  /** Client-side programmatic tool calling (code_execution tool). */
  codeExecution?: RecipeCodeExecution;
  /**
   * Per-channel conversation routing — fork-per-channel from this agent.
   *
   * @deprecated Deprecated and will be removed (agent-framework#235); see
   * `RecipeConversations`. Still works; the host logs a `[deprecated]` line
   * at startup when it is set.
   */
  conversations?: RecipeConversations;
  /** Tune-out's subconscious resident (agent-framework#77). */
  subconscious?: RecipeSubconscious;
  /**
   * MCPL RFC-008 operator class overrides: tool-name pattern → classes. The
   * highest-precedence source of a tool's class, and the way to class
   * third-party MCP servers (blender, computer use, …) that will never
   * declare `_meta["mcpl/class"]`. Replaces, never merges with, what the
   * server declared. First matching pattern wins. Patterns match the
   * model-facing name, so an MCPL server's tools are
   * `mcpl--<serverId>--<tool>` (`"mcpl--blender--*": ["media"]`) unless its
   * entry sets `toolPrefix`.
   */
  toolClassOverrides?: Record<string, string[]>;
}

export type RecipeProvider = NonNullable<RecipeAgent['provider']>;

/** The provider transport the host actually builds for this recipe. One
 *  adapter serves every stream in the process (resident, subconscious,
 *  forks), so this is also what any subagent stream runs on. */
export function resolveProvider(recipe: Recipe): RecipeProvider {
  return recipe.agent.provider ?? 'anthropic';
}

// ---------------------------------------------------------------------------
// Default recipe
// ---------------------------------------------------------------------------

export const DEFAULT_RECIPE: Recipe = {
  name: 'Agent',
  description: 'General-purpose assistant with tool access',
  agent: {
    name: 'agent',
    cacheTtl: '1h',
    // Empty on purpose: identity comes from what the agent lives through,
    // and the tools describe themselves (docs/AGENT-ONBOARDING.md §5).
    systemPrompt: '',
    // No strategy: the host defaults (buildFrameworkStrategy) give
    // autobiographical + adaptive resolution + kv-unified with the standard
    // block, a 300k budget and a 120k verbatim tail.
  },
  modules: {
    // subagents + lessons + retrieval deliberately omitted — all opt-in only
    // (retrieval additionally adds per-turn context churn + retrieval-model costs);
    // see the RecipeModules field docs.
    wake: true,
    workspace: true,
  },
};

// ---------------------------------------------------------------------------
// Environment variable substitution
// ---------------------------------------------------------------------------

/** A `${VAR}` or `${VAR:-default}` reference, as substituteEnvVars reads one. */
const ENV_REFERENCE = String.raw`\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}`;

/** Whether text holds a `${VAR}` reference: the form a recipe substitutes
 *  from the environment. An agent overlay entry passes it on as written. */
export function namesEnvReference(text: string): boolean {
  return new RegExp(ENV_REFERENCE).test(text);
}

/**
 * Walk a parsed-JSON value tree and substitute `${VAR_NAME}` patterns in
 * string values with `process.env.VAR_NAME`.  Applied at recipe-load time,
 * before schema validation, so secrets can live in `.env` (gitignored) while
 * the recipe itself stays commit-safe.
 *
 * Patterns:
 *   - `${FOO}` — required.  Throws if FOO is unset (empty string OK).
 *   - `${FOO:-default}` — optional.  Uses FOO when set and non-empty,
 *     otherwise the literal default text.  Default may be empty
 *     (`${FOO:-}`) to mean "use FOO or just empty string, never throw".
 *   - VAR name: `[A-Za-z_][A-Za-z0-9_]*`.
 *   - Default text: any chars except `}`.  No nested `${...}` parsing
 *     and no escape syntax — keep recipes JSON-friendly.
 *   - Multiple occurrences in a single string are all substituted.
 *   - Non-string values (numbers, booleans, nulls) pass through unchanged.
 *   - Arrays and objects are walked recursively.
 *
 * No escape syntax yet — a literal `${...}` in recipe JSON is not a supported
 * case.  If that becomes needed, add `$$` → `$` unwrapping as a pre-pass.
 */
export function substituteEnvVars(value: unknown, source: string): unknown {
  if (typeof value === 'string') {
    return value.replace(
      new RegExp(ENV_REFERENCE, 'g'),
      (_match, name: string, defaultValue: string | undefined) => {
        const v = process.env[name];
        if (defaultValue !== undefined) {
          // ${VAR:-default} — use VAR if set + non-empty, else default.
          return v !== undefined && v !== '' ? v : defaultValue;
        }
        // ${VAR} — required; empty string is allowed if explicitly set.
        if (v === undefined) {
          throw new Error(
            `Recipe "${source}" references environment variable \${${name}} which is not set. ` +
            `Add it to your .env file, supply a default with \${${name}:-...}, ` +
            `or delete the section of the recipe that uses it ` +
            `(e.g. remove the mcpServers entry for a source you don't have).`,
          );
        }
        return v;
      },
    );
  }
  if (Array.isArray(value)) {
    return value.map((v) => substituteEnvVars(v, source));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteEnvVars(v, source);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Base for resolving recipe-relative paths (currently: `children[].recipe`).
 * `file` sources use the recipe file's directory; `url` sources use the URL
 * base so a child like `"child.json"` on an `https://example.com/parent.json`
 * load resolves to `https://example.com/child.json`.
 */
type RecipeSourceBase = { kind: 'file'; dir: string } | { kind: 'url'; base: string };

/**
 * A loaded recipe plus the form of it that is safe to persist.
 *
 * `recipe` is fully resolved: `${VAR}` env references substituted, relative
 * child/extension paths made absolute, URL systemPrompt fetched. It is what
 * the running host consumes — and it can contain secrets (API tokens pulled
 * from the environment), so it must never be written to disk.
 *
 * `persistable` is the raw pre-substitution recipe JSON with only the
 * source-relative paths (`modules.fleet.children[].recipe`,
 * `extensions[*].path`) resolved to their final absolute form — those need
 * the original source base, which a resumed session no longer has. Every
 * `${VAR}` reference and any URL systemPrompt stay unresolved, so the file
 * `saveRecipe` writes carries no secret material and re-resolves against the
 * *current* environment on resume.
 */
export interface LoadedRecipe {
  recipe: Recipe;
  persistable: Record<string, unknown>;
}

/**
 * Load a recipe from a URL or local file path.
 * If the systemPrompt value is an HTTP(S) URL, fetches the text.
 * Recipe string values containing `${VAR}` patterns are substituted against
 * `process.env` before validation — see substituteEnvVars().
 * Relative `modules.fleet.children[].recipe` paths are resolved against the
 * parent recipe's directory (or URL base) so sibling recipes are portable.
 */
export async function loadRecipe(source: string): Promise<Recipe> {
  return (await loadRecipeDetailed(source)).recipe;
}

/**
 * Like loadRecipe, but also returns the persistable (unresolved) form —
 * see LoadedRecipe. Callers that snapshot the recipe to disk (index.ts's
 * resolveRecipe) must save `persistable`, never `recipe`.
 */
export async function loadRecipeDetailed(source: string): Promise<LoadedRecipe> {
  let raw: unknown;
  let sourceBase: RecipeSourceBase;

  if (source.startsWith('http://') || source.startsWith('https://')) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Failed to fetch recipe from ${source}: ${res.status} ${res.statusText}`);
    raw = await res.json();
    sourceBase = { kind: 'url', base: source };
  } else {
    const path = resolve(source);
    if (!existsSync(path)) throw new Error(`Recipe file not found: ${path}`);
    raw = JSON.parse(readFileSync(path, 'utf-8'));
    sourceBase = { kind: 'file', dir: dirname(path) };
  }

  // Snapshot the pre-substitution form before substituteEnvVars walks the
  // object — this is what gets persisted, so resolved secrets never do.
  const persistable = structuredClone(raw) as Record<string, unknown>;

  raw = substituteEnvVars(raw, source);
  const recipe = validateRecipe(raw);
  resolveChildRecipePaths(recipe, sourceBase);
  resolveExtensionPaths(recipe, sourceBase);
  const resolved = await resolveSystemPrompt(recipe);
  copyResolvedPathsIntoRaw(persistable, resolved);
  return { recipe: resolved, persistable };
}

/**
 * Copy the resolved `modules.fleet.children[].recipe` and
 * `extensions[*].path` values from the resolved recipe into the raw
 * pre-substitution snapshot. Those fields are resolved against the recipe's
 * original source base (its directory or URL), which is gone by resume time
 * — so the persisted form must carry them already-absolute. Substitution
 * never changes object shape (it is a per-string replacement), so the two
 * trees align index-for-index and key-for-key. Paths are not treated as
 * secret: an env value that was interpolated into a child-recipe or
 * extension path IS persisted in resolved form.
 */
function copyResolvedPathsIntoRaw(raw: Record<string, unknown>, recipe: Recipe): void {
  const fleet = recipe.modules?.fleet;
  const resolvedChildren = (typeof fleet === 'object' && fleet !== null) ? fleet.children : undefined;
  if (Array.isArray(resolvedChildren)) {
    const rawModules = raw.modules as Record<string, unknown> | undefined;
    const rawFleet = rawModules?.fleet as Record<string, unknown> | undefined;
    const rawChildren = (typeof rawFleet === 'object' && rawFleet !== null) ? rawFleet.children : undefined;
    if (Array.isArray(rawChildren)) {
      for (let i = 0; i < rawChildren.length && i < resolvedChildren.length; i++) {
        const rawChild = rawChildren[i] as Record<string, unknown> | null;
        if (rawChild && typeof rawChild === 'object' && typeof resolvedChildren[i]?.recipe === 'string') {
          rawChild.recipe = resolvedChildren[i].recipe;
        }
      }
    }
  }

  const rawExtensions = raw.extensions as Record<string, unknown> | undefined;
  for (const [name, ext] of Object.entries(recipe.extensions ?? {})) {
    const rawExt = rawExtensions?.[name] as Record<string, unknown> | undefined;
    if (rawExt && typeof rawExt === 'object') {
      rawExt.path = ext.path;
    }
  }
}

/**
 * Resolve a single `children[].recipe` value against the parent recipe's
 * source base.  Returns unchanged if absolute or http(s) URL.
 */
export function resolveRecipeRelative(child: string, base: RecipeSourceBase): string {
  if (child.startsWith('http://') || child.startsWith('https://')) return child;
  if (isAbsolute(child)) return child;
  if (base.kind === 'file') return resolve(base.dir, child);
  // URL base: resolve the child against the parent URL.
  return new URL(child, base.base).href;
}

function resolveChildRecipePaths(recipe: Recipe, base: RecipeSourceBase): void {
  const fleet = recipe.modules?.fleet;
  if (!fleet || typeof fleet !== 'object') return;
  if (!fleet.children) return;
  for (const child of fleet.children) {
    child.recipe = resolveRecipeRelative(child.recipe, base);
  }
}

/**
 * Resolve relative `extensions[].path` values against the recipe file's
 * directory. URL-loaded recipes cannot carry relative extension paths — the
 * host never fetches code over the network, so there is nothing local to
 * resolve them against.
 */
function resolveExtensionPaths(recipe: Recipe, base: RecipeSourceBase): void {
  for (const [name, ext] of Object.entries(recipe.extensions ?? {})) {
    if (isAbsolute(ext.path)) continue;
    if (base.kind === 'url') {
      throw new Error(
        `extensions.${name}.path "${ext.path}" is relative, but the recipe was loaded from a URL. ` +
        `Extension code is never fetched remotely — use an absolute path to a local install.`,
      );
    }
    ext.path = resolve(base.dir, ext.path);
  }
}

/**
 * If systemPrompt is an HTTP(S) URL, fetch its contents as plain text.
 * Only treated as a URL if it looks like a single URL (no spaces/newlines).
 */
async function resolveSystemPrompt(recipe: Recipe): Promise<Recipe> {
  const prompt = recipe.agent.systemPrompt;
  const isUrl = (prompt.startsWith('http://') || prompt.startsWith('https://'))
    && !prompt.includes(' ') && !prompt.includes('\n');
  if (isUrl) {
    const res = await fetch(prompt);
    if (!res.ok) throw new Error(`Failed to fetch system prompt from ${prompt}: ${res.status} ${res.statusText}`);
    return {
      ...recipe,
      agent: { ...recipe.agent, systemPrompt: await res.text() },
    };
  }
  return recipe;
}

function validateKvUnifiedConfig(strategy: Record<string, unknown>): void {
  const type = strategy.type ?? 'autobiographical';
  // An omitted foldingStrategy is kv-unified under adaptive resolution
  // (buildFrameworkStrategy), so a kvUnified block there is in use.
  const selected = strategy.foldingStrategy === 'kv-unified' || (
    strategy.foldingStrategy === undefined &&
    strategy.adaptiveResolution !== false &&
    (type === 'autobiographical' || type === 'frontdesk')
  );
  const raw = strategy.kvUnified;
  if (!selected) {
    if (raw !== undefined) {
      throw new Error('Recipe agent.strategy.kvUnified requires foldingStrategy "kv-unified".');
    }
    return;
  }
  // Omitted: the host supplies its standard block (standardKvUnifiedConfig).
  if (raw === undefined) return;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      'Recipe agent.strategy.kvUnified must be a complete object when present (omit it for the standard block).',
    );
  }
  const config = raw as Record<string, unknown>;
  if (!config.policy || typeof config.policy !== 'object' || Array.isArray(config.policy)) {
    throw new Error('Recipe agent.strategy.kvUnified.policy must be a complete object.');
  }
  const policy = config.policy as Record<string, unknown>;
  const policyNumbers = [
    'alpha', 'budgetLowRatio', 'budgetHighRatio', 'budgetUnderLambda',
    'budgetOverLambda', 'cacheLambda', 'cacheScale', 'cacheReadPrice',
    'cacheWritePrice', 'continuityLambda', 'continuityScale',
    'continuityRecencyHalfLifeTokens', 'continuityRecencyFloor',
    'continuityStableHalfLife', 'continuityStableFloor',
  ] as const;
  for (const key of policyNumbers) {
    if (typeof policy[key] !== 'number' || !Number.isFinite(policy[key])) {
      throw new Error(`Recipe agent.strategy.kvUnified.policy.${key} must be a finite number.`);
    }
  }
  const nonNegative = [
    'alpha', 'budgetUnderLambda', 'budgetOverLambda', 'cacheLambda',
    'cacheReadPrice', 'cacheWritePrice', 'continuityLambda',
  ] as const;
  for (const key of nonNegative) {
    if ((policy[key] as number) < 0) {
      throw new Error(`Recipe agent.strategy.kvUnified.policy.${key} must be non-negative.`);
    }
  }
  for (const key of [
    'cacheScale', 'continuityScale', 'continuityRecencyHalfLifeTokens',
    'continuityStableHalfLife',
  ] as const) {
    if ((policy[key] as number) <= 0) {
      throw new Error(`Recipe agent.strategy.kvUnified.policy.${key} must be positive.`);
    }
  }
  const low = policy.budgetLowRatio as number;
  const high = policy.budgetHighRatio as number;
  if (low < 0 || high > 1 || low > high) {
    throw new Error('Recipe kvUnified budget ratios must satisfy 0 <= low <= high <= 1.');
  }
  for (const key of ['continuityRecencyFloor', 'continuityStableFloor'] as const) {
    const value = policy[key] as number;
    if (value < 0 || value > 1) {
      throw new Error(`Recipe agent.strategy.kvUnified.policy.${key} must be in [0, 1].`);
    }
  }
  // Mirror context-manager 0.17: src/adaptive/kv-unified-policy.ts (MAX_AGE_BAND_STEPS).
  if (
    policy.ageBandSteps !== undefined &&
    (!Number.isInteger(policy.ageBandSteps) || (policy.ageBandSteps as number) < 0 || (policy.ageBandSteps as number) > 64)
  ) {
    throw new Error('Recipe agent.strategy.kvUnified.policy.ageBandSteps must be an integer from 0 to 64 when present.');
  }
  for (const key of [
    'tokenBucketSize', 'continuityBucketSize', 'fidelityBucketSize', 'labelCeiling',
  ] as const) {
    const value = config[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Recipe agent.strategy.kvUnified.${key} must be a positive safe integer.`);
    }
  }
  if (
    typeof config.adoptEpsilon !== 'number' ||
    !Number.isFinite(config.adoptEpsilon) ||
    config.adoptEpsilon < 0
  ) {
    throw new Error('Recipe agent.strategy.kvUnified.adoptEpsilon must be a finite non-negative number.');
  }
  // Mirror context-manager 0.11.0: src/adaptive/strategies/kv-unified.ts validateExplicitOptions.
  for (const key of ['treeifyNonContiguousSummaries', 'preserveGapBearingSummaries'] as const) {
    if (typeof config[key] !== 'boolean') {
      throw new Error(`Recipe agent.strategy.kvUnified.${key} must be an explicit boolean.`);
    }
  }
  if (config.treeifyNonContiguousSummaries && config.preserveGapBearingSummaries) {
    throw new Error(
      'Recipe agent.strategy.kvUnified.treeifyNonContiguousSummaries and preserveGapBearingSummaries are mutually exclusive.',
    );
  }
  if (config.hysteresisCertificate !== undefined && typeof config.hysteresisCertificate !== 'boolean') {
    throw new Error('Recipe agent.strategy.kvUnified.hysteresisCertificate must be a boolean when present.');
  }
  // A typo here doesn't fail in context-manager: an engine it doesn't know
  // runs as `auto`, and a mode other than `joint` ranks individually.
  if (config.engine !== undefined && !['auto', 'subtree', 'dag'].includes(config.engine as string)) {
    throw new Error('Recipe agent.strategy.kvUnified.engine must be "auto", "subtree" or "dag" when present.');
  }
  if (config.latentDemandMode !== undefined && !['individual', 'joint'].includes(config.latentDemandMode as string)) {
    throw new Error('Recipe agent.strategy.kvUnified.latentDemandMode must be "individual" or "joint" when present.');
  }
}

// ---------------------------------------------------------------------------
// Unknown keys (#167)
// ---------------------------------------------------------------------------

/**
 * The keys each recipe level reads. The type check below keeps these lists in
 * step with Recipe, RecipeAgent, RecipeModules, RecipeMockConfig and
 * RecipeKvUnifiedConfig with its policy: a key added to an interface and not
 * here (or listed here and gone from the interface) fails to compile.
 */
const RECIPE_KEYS = [
  'name', 'description', 'version', 'agent', 'mcpServers', 'modules', 'extensions',
  'sessionNaming', 'codeExecution', 'conversations', 'subconscious', 'toolClassOverrides',
] as const;
const RECIPE_AGENT_KEYS = [
  'allowedTools',
  'name', 'model', 'timezone', 'provider', 'baseUrl', 'formatter', 'retry', 'prefillUserMessage',
  'systemPrompt', 'maxTokens', 'maxStreamTokens', 'contextBudgetTokens', 'cacheTtl',
  'cacheKeepalive', 'promptCaching', 'sameRoundThinkTextPolicy', 'proseRouting',
  'toolWrapperProseGuard', 'anthropicBetas', 'strategy', 'thinking', 'responses', 'codex', 'mock',
  'refusalHandling',
] as const;
const RECIPE_AGENT_MOCK_KEYS = [
  'echoMode', 'defaultResponse', 'completeDelayMs', 'streamChunkDelayMs', 'streamChunkSize',
  'responseQueue',
] as const;
const RECIPE_MODULE_KEYS = [
  'subagents', 'lessons', 'retrieval', 'wake', 'workspace', 'instructions', 'activity', 'notices',
  'mcplAdmin', 'history', 'identity', 'fleet', 'webui', 'ttsRelay', 'subscriptionGc',
  'channelMode', 'selfRestart',
] as const;
const RECIPE_KV_UNIFIED_KEYS = [
  'policy', 'tokenBucketSize', 'continuityBucketSize', 'fidelityBucketSize', 'labelCeiling',
  'adoptEpsilon', 'treeifyNonContiguousSummaries', 'preserveGapBearingSummaries',
  'hysteresisCertificate', 'engine', 'latentDemandMode',
] as const;
const RECIPE_KV_UNIFIED_POLICY_KEYS = [
  'alpha', 'budgetLowRatio', 'budgetHighRatio', 'budgetUnderLambda', 'budgetOverLambda',
  'cacheLambda', 'cacheScale', 'cacheReadPrice', 'cacheWritePrice', 'continuityLambda',
  'continuityScale', 'continuityRecencyHalfLifeTokens', 'continuityRecencyFloor',
  'continuityStableHalfLife', 'continuityStableFloor', 'ageBandSteps',
] as const;
type ListsExactly<K extends string, L extends readonly string[]> =
  [Exclude<K, L[number]>] extends [never] ? ([Exclude<L[number], K>] extends [never] ? true : false) : false;
// "Type 'true' is not assignable to type 'false'" here means a key was added
// to (or removed from) one of the interfaces without the list above following.
const recipeKeyListsInStep: [
  ListsExactly<keyof Recipe & string, typeof RECIPE_KEYS>,
  ListsExactly<keyof RecipeAgent & string, typeof RECIPE_AGENT_KEYS>,
  ListsExactly<keyof RecipeModules & string, typeof RECIPE_MODULE_KEYS>,
  ListsExactly<keyof RecipeMockConfig & string, typeof RECIPE_AGENT_MOCK_KEYS>,
  ListsExactly<keyof RecipeKvUnifiedConfig & string, typeof RECIPE_KV_UNIFIED_KEYS>,
  ListsExactly<keyof RecipeKvUnifiedConfig['policy'] & string, typeof RECIPE_KV_UNIFIED_POLICY_KEYS>,
] = [true, true, true, true, true, true];
void recipeKeyListsInStep;

const RECIPE_WORKSPACE_KEYS = ['mounts', 'configMount'] as const;
const MOUNT_MODES = ['read-write', 'read-only'] as const;
const MOUNT_WATCH_VALUES = ['always', 'on-agent-action', 'never'] as const;
const MOUNT_WAKE_OPS = ['created', 'modified', 'deleted'] as const;
/** The longest delay a timer keeps: Bun's and Node's run a longer or negative one at once. */
const TIMER_MS_MAX = 2147483647;

/** Values in a sentence: `"a" or "b"`, `"a", "b" or "c"`. */
function listed(values: readonly string[]): string {
  const quoted = values.map((v) => `"${v}"`);
  return quoted.length > 1 ? `${quoted.slice(0, -1).join(', ')} or ${quoted[quoted.length - 1]}` : quoted.join('');
}

/** What a value must be, for the refusal's words, or null when it is that. */
type MountValueCheck = (value: unknown) => string | null;
const oneOf = (values: readonly string[]): MountValueCheck => (v) => values.includes(v as string) ? null : listed(values);
const nonEmptyText: MountValueCheck = (v) => typeof v === 'string' && v !== '' ? null : 'a non-empty string';
const trueOrFalse: MountValueCheck = (v) => typeof v === 'boolean' ? null : 'true or false';
/**
 * A whole number of milliseconds from `min` to the longest delay a timer
 * keeps. A timer truncates a fraction, so a fraction isn't the delay that runs.
 */
const timerMs = (min: number): MountValueCheck => (v) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= TIMER_MS_MAX ? null
    : `a whole number of milliseconds from ${min} to ${TIMER_MS_MAX}`;

/**
 * Mount keys an agent-framework release adds before the host passes them on:
 * `include`, from agent-framework #536, and `backend`, from agent-framework
 * #564. The checks below and the recipe's mount type leave them out, so this
 * file typechecks against a framework with the keys and against one without
 * them, and a recipe that gives one is refused as an unknown key, as before.
 * The host's step to the release that carries a key gives it a check here,
 * adds it to `RecipeWorkspaceMount`, and takes it out of this list. For
 * `backend`, that step also decides a direct mount's `mode`, since the mount
 * builder defaults it to `'read-write'` (workspace-mounts.ts), which
 * agent-framework #564 refuses on a direct mount.
 */
type MountKeyNotPassedOn = 'include' | 'backend';

/**
 * Each workspace mount key, with what its value must be: what the framework
 * reads as the recipe means it. It's typed by the framework's `MountConfig`,
 * so a framework release that adds a mount key fails this typecheck until
 * either the key has a check here, and the mount builder then passes it on
 * unchanged (workspace-mounts.ts), or it is named in `MountKeyNotPassedOn`.
 * A key these checks don't name stops the recipe loading (#275), one named
 * in `MountKeyNotPassedOn` included.
 */
const MOUNT_KEY_CHECKS: { readonly [K in Exclude<keyof MountConfig, MountKeyNotPassedOn>]-?: MountValueCheck } = {
  name: nonEmptyText,
  path: nonEmptyText,
  mode: oneOf(MOUNT_MODES),
  watch: oneOf(MOUNT_WATCH_VALUES),
  // 0 is no wait, which the framework runs as that.
  watchDebounceMs: timerMs(0),
  // A poll of 0 runs as often as one of 1: the framework has no "off" for it.
  watchRootPollMs: timerMs(1),
  ignore: (v) => Array.isArray(v) && v.every((p) => typeof p === 'string') ? null : 'an array of strings',
  followSymlinks: trueOrFalse,
  // A cap of 0 refuses every file that isn't empty: the framework has no "no limit".
  maxFileSize: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1 ? null : 'a whole number of bytes, 1 or more',
  // The framework refuses anything else when the workspace is built.
  walkCap: (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 ? null
    : `a whole number of entries from 1 to ${Number.MAX_SAFE_INTEGER}`,
  wakeOnChange: (v) => typeof v === 'boolean' || (Array.isArray(v) && v.every((op) => (MOUNT_WAKE_OPS as readonly unknown[]).includes(op)))
    ? null : `true, false, or a list of ${listed(MOUNT_WAKE_OPS)}`,
  autoMaterialize: trueOrFalse,
};
const RECIPE_MOUNT_KEYS = Object.keys(MOUNT_KEY_CHECKS) as Array<Exclude<keyof MountConfig, MountKeyNotPassedOn> & string>;
/** The keys a recipe's mount must give; the builder supplies `mode` and `watch`. */
const REQUIRED_MOUNT_KEYS: readonly string[] = ['name', 'path'];

type IsNever<T> = [T] extends [never] ? true : false;
// "Type 'true' is not assignable to type 'false'" here means agent-framework's
// MountConfig gained or lost a key or a value the host's types and checks
// don't follow yet.
const mountListsInStep: [
  ListsExactly<keyof Extract<RecipeModules['workspace'], object> & string, typeof RECIPE_WORKSPACE_KEYS>,
  ListsExactly<keyof RecipeWorkspaceMount & string, Array<Exclude<keyof MountConfig, MountKeyNotPassedOn> & string>>,
  ListsExactly<MountConfig['mode'], typeof MOUNT_MODES>,
  ListsExactly<Exclude<MountConfig['watch'], undefined>, typeof MOUNT_WATCH_VALUES>,
  ListsExactly<Extract<Exclude<MountConfig['wakeOnChange'], undefined>, readonly unknown[]>[number], typeof MOUNT_WAKE_OPS>,
  IsNever<Exclude<MountConfig['wakeOnChange'], undefined | boolean | readonly unknown[]>>,
] = [true, true, true, true, true, true];
void mountListsInStep;
// "Type 'true' is not assignable to type 'false'" here means agent-framework's
// CodeExecutionConfig gained or lost a setting CODE_EXECUTION_NUMBER_KEYS
// doesn't follow yet.
const codeExecutionKeysInStep: ListsExactly<
  Exclude<keyof CodeExecutionConfig, 'enabled'> & string, typeof CODE_EXECUTION_NUMBER_KEYS
> = true;
void codeExecutionKeysInStep;

/**
 * A key a section doesn't have, refused with what to write instead, when the
 * key is a known mistake, or else the nearest key it does have, when there is
 * one.
 */
function unknownKeyError(where: string, key: string, known: readonly string[], instead?: string): Error {
  const near = instead === undefined ? nearestRecipeKey(key, known) : null;
  const hint = instead !== undefined ? ` (${instead})` : near ? ` (did you mean "${near}"?)` : '';
  return new Error(`${where} has unknown key ${JSON.stringify(key)}${hint}; known: ${known.join(', ')}`);
}

/** A mount key recipes have used that the host never read, with what says it. */
const MOUNT_KEY_INSTEAD: Record<string, string> = {
  readOnly: 'mode: "read-only" makes a mount read-only, and a mount is read-write without it',
};

/** Keys that were renamed or removed, with what replaced them. */
const RETIRED_RECIPE_KEYS: Record<string, string> = {
  'modules.files': 'modules.workspace',
};

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = Math.min(up + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length]!;
}

/** The known key a typo most likely meant, when one is close enough to suggest. */
function nearestRecipeKey(key: string, known: readonly string[]): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of known) {
    const d = editDistance(key.toLowerCase(), candidate.toLowerCase());
    if (d < bestDistance) { bestDistance = d; best = candidate; }
  }
  return best !== null && bestDistance <= Math.max(2, Math.floor(key.length / 3)) ? best : null;
}

/**
 * The keys a recipe carries that the host never reads — at the top level,
 * under `agent`, `agent.mock`, `agent.strategy.kvUnified` and its `policy`,
 * and `modules` — each with what it was probably
 * meant to be. A misspelled key doesn't fail, it just doesn't happen (#167);
 * for now they are warned about, not rejected, so recipes carrying leftovers
 * keep loading (the strict schema is #91's direction).
 */
export function unknownRecipeKeys(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const obj = raw as Record<string, unknown>;
  const found: string[] = [];
  const check = (prefix: string, value: unknown, known: readonly string[]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const key of Object.keys(value)) {
      if (known.includes(key)) continue;
      const path = `${prefix}${key}`;
      // Own properties only: `constructor` or `__proto__` must not find Object's.
      const retired = Object.hasOwn(RETIRED_RECIPE_KEYS, path) ? RETIRED_RECIPE_KEYS[path] : undefined;
      const near = retired ? null : nearestRecipeKey(key, known);
      found.push(retired ? `${path} (replaced by ${retired})` : near ? `${path} (did you mean ${prefix}${near}?)` : path);
    }
  };
  check('', obj, RECIPE_KEYS);
  check('agent.', obj.agent, RECIPE_AGENT_KEYS);
  const isObject = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  if (isObject(obj.agent)) {
    check('agent.mock.', obj.agent.mock, RECIPE_AGENT_MOCK_KEYS);
    // context-manager reads the kvUnified block as written, so a misspelled
    // optional key there (`latentDemandMod`) silently takes the default.
    const kvUnified = isObject(obj.agent.strategy) ? obj.agent.strategy.kvUnified : undefined;
    check('agent.strategy.kvUnified.', kvUnified, RECIPE_KV_UNIFIED_KEYS);
    if (isObject(kvUnified)) {
      check('agent.strategy.kvUnified.policy.', kvUnified.policy, RECIPE_KV_UNIFIED_POLICY_KEYS);
    }
  }
  check('modules.', obj.modules, RECIPE_MODULE_KEYS);
  return found;
}

/**
 * Warnings from recipe validation, kept for the runtime that takes stderr over
 * later (the TUI's tui-error.log, headless.log): the recipe is validated before
 * either redirect, so the console line alone would never reach those logs.
 * Bounded, for a long-running host that keeps loading recipes (fleet, WebUI).
 */
const pendingRecipeWarnings: string[] = [];
const MAX_PENDING_RECIPE_WARNINGS = 50;

/** The recipe warnings not yet taken, oldest first; taking them clears them. */
export function takeRecipeWarnings(): string[] {
  return pendingRecipeWarnings.splice(0);
}

/**
 * Validate raw JSON and fill defaults.
 */
export function validateRecipe(raw: unknown): Recipe {
  if (!raw || typeof raw !== 'object') throw new Error('Recipe must be a JSON object');
  const obj = raw as Record<string, unknown>;

  if (typeof obj.name !== 'string' || !obj.name) {
    throw new Error('Recipe must have a "name" string');
  }
  if (!obj.agent || typeof obj.agent !== 'object') {
    throw new Error('Recipe must have an "agent" object');
  }

  // Nothing below reads an unknown key: say so, and what it was probably meant to be.
  const unknownKeys = unknownRecipeKeys(obj);
  if (unknownKeys.length > 0) {
    const warning = `Recipe "${obj.name}" has keys the host does not read (ignored): ${unknownKeys.join(', ')}.`;
    console.warn(warning);
    pendingRecipeWarnings.push(warning);
    if (pendingRecipeWarnings.length > MAX_PENDING_RECIPE_WARNINGS) pendingRecipeWarnings.shift();
  }

  const agent = obj.agent as Record<string, unknown>;
  // Absent or empty systemPrompt is a valid configuration: '' is dropped at
  // the provider boundary (membrane omits falsy `system`), so the wire
  // request carries no system block at all.
  if (agent.systemPrompt === undefined || agent.systemPrompt === null) {
    agent.systemPrompt = '';
  } else if (typeof agent.systemPrompt !== 'string') {
    throw new Error('Recipe agent "systemPrompt" must be a string when present');
  }

  if (agent.allowedTools !== undefined && agent.allowedTools !== 'all' &&
      (!Array.isArray(agent.allowedTools) ||
       !Array.from(agent.allowedTools).every((tool) => typeof tool === 'string'))) {
    throw new Error("Recipe agent.allowedTools must be 'all' or an array of tool-name strings.");
  }

  if (agent.provider !== undefined &&
      agent.provider !== 'anthropic' &&
      agent.provider !== 'openai-responses' &&
      agent.provider !== 'openai-codex' &&
      agent.provider !== 'openrouter' &&
      agent.provider !== 'bedrock' &&
      agent.provider !== 'openai-compatible' &&
      agent.provider !== 'mock') {
    throw new Error(
      `Recipe agent.provider must be 'anthropic', 'openai-responses', 'openai-codex', 'openrouter', 'bedrock', 'openai-compatible', or 'mock', ` +
      `got ${JSON.stringify(agent.provider)}.`,
    );
  }

  if (
    agent.proseRouting !== undefined &&
    agent.proseRouting !== 'locus' &&
    agent.proseRouting !== 'explicit' &&
    agent.proseRouting !== 'hybrid' &&
    agent.proseRouting !== 'disabled'
  ) {
    throw new Error(`Recipe agent.proseRouting must be 'locus', 'explicit', 'hybrid', or 'disabled', got ${JSON.stringify(agent.proseRouting)}.`);
  }

  if (agent.toolWrapperProseGuard !== undefined && typeof agent.toolWrapperProseGuard !== 'boolean') {
    throw new Error(`Recipe agent.toolWrapperProseGuard must be a boolean, got ${JSON.stringify(agent.toolWrapperProseGuard)}.`);
  }

  if (agent.timezone !== undefined) {
    if (typeof agent.timezone !== 'string' || !agent.timezone.trim()) {
      throw new Error('Recipe agent.timezone must be a non-empty IANA time zone string.');
    }
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: agent.timezone }).format(new Date(0));
    } catch {
      throw new Error(`Recipe agent.timezone is not a valid IANA time zone: ${JSON.stringify(agent.timezone)}.`);
    }
  }

  if (agent.responses !== undefined) {
    if (!agent.responses || typeof agent.responses !== 'object' || Array.isArray(agent.responses)) {
      throw new Error('Recipe agent.responses must be an object.');
    }
    const responses = agent.responses as Record<string, unknown>;
    const efforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
    if (responses.reasoningEffort !== undefined && !efforts.includes(String(responses.reasoningEffort))) {
      throw new Error(`Invalid agent.responses.reasoningEffort ${JSON.stringify(responses.reasoningEffort)}.`);
    }
    if (responses.reasoningContext !== undefined && responses.reasoningContext !== 'current_turn' && responses.reasoningContext !== 'all_turns') {
      throw new Error(`Invalid agent.responses.reasoningContext ${JSON.stringify(responses.reasoningContext)}.`);
    }
    if (responses.serviceTier !== undefined && (typeof responses.serviceTier !== 'string' || !responses.serviceTier.trim())) {
      throw new Error('Recipe agent.responses.serviceTier must be a non-empty string.');
    }
    if (responses.compactThreshold !== undefined &&
        (typeof responses.compactThreshold !== 'number' || responses.compactThreshold <= 0)) {
      throw new Error('Recipe agent.responses.compactThreshold must be a positive number.');
    }
    const serviceTiers = ['auto', 'default', 'flex', 'priority'];
    if (responses.serviceTier !== undefined && !serviceTiers.includes(String(responses.serviceTier))) {
      throw new Error(`Invalid agent.responses.serviceTier ${JSON.stringify(responses.serviceTier)}.`);
    }
  }

  if (agent.codex !== undefined) {
    if (!agent.codex || typeof agent.codex !== 'object' || Array.isArray(agent.codex)) {
      throw new Error('Recipe agent.codex must be an object.');
    }
    const codex = agent.codex as Record<string, unknown>;
    if (codex.fastMode !== undefined && typeof codex.fastMode !== 'boolean') {
      throw new Error('Recipe agent.codex.fastMode must be a boolean.');
    }
  }

  if (agent.mock !== undefined) {
    if (!agent.mock || typeof agent.mock !== 'object' || Array.isArray(agent.mock)) {
      throw new Error('Recipe agent.mock must be an object.');
    }
    const mock = agent.mock as Record<string, unknown>;
    if (mock.echoMode !== undefined && typeof mock.echoMode !== 'boolean') {
      throw new Error('Recipe agent.mock.echoMode must be a boolean.');
    }
    if (mock.defaultResponse !== undefined &&
        (typeof mock.defaultResponse !== 'string' || !mock.defaultResponse.trim())) {
      throw new Error('Recipe agent.mock.defaultResponse must be a non-empty string.');
    }
    for (const key of ['completeDelayMs', 'streamChunkDelayMs'] as const) {
      const v = mock[key];
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
        throw new Error(`Recipe agent.mock.${key} must be a non-negative finite number (milliseconds).`);
      }
    }
    // MockAdapter advances by streamChunkSize per chunk: 0 never advances (an
    // endless loop) and a fraction makes uneven or empty chunks.
    if (mock.streamChunkSize !== undefined &&
        (typeof mock.streamChunkSize !== 'number' || !Number.isSafeInteger(mock.streamChunkSize) ||
          mock.streamChunkSize < 1)) {
      throw new Error('Recipe agent.mock.streamChunkSize must be a positive integer (characters per chunk).');
    }
    if (mock.responseQueue !== undefined &&
        (!Array.isArray(mock.responseQueue) ||
          !mock.responseQueue.every((r) => typeof r === 'string' && r.trim() !== ''))) {
      throw new Error('Recipe agent.mock.responseQueue must be an array of non-empty strings.');
    }
  }

  if (agent.maxStreamTokens !== undefined && (typeof agent.maxStreamTokens !== 'number' || agent.maxStreamTokens <= 0)) {
    throw new Error('Recipe agent.maxStreamTokens must be a positive number.');
  }

  // Recipes are runtime JSON; a typo'd TTL ("1hr", "60m") would otherwise
  // surface as a 400 from Anthropic at the agent's first inference.
  if (agent.cacheTtl !== undefined && agent.cacheTtl !== '5m' && agent.cacheTtl !== '1h') {
    throw new Error(`Recipe agent.cacheTtl must be '5m' or '1h', got ${JSON.stringify(agent.cacheTtl)}.`);
  }
  agent.cacheTtl ??= '1h';

  if (agent.retry !== undefined) {
    const retry = agent.retry as Record<string, unknown> | null;
    if (typeof retry !== 'object' || retry === null || Array.isArray(retry)) {
      throw new Error(`Recipe agent.retry must be an object, got ${JSON.stringify(agent.retry)}.`);
    }
    const RETRY_KEYS = ['maxRetries', 'retryDelayMs', 'backoffMultiplier', 'maxRetryDelayMs'] as const;
    // Reject unknown keys: `{ maxRetires: 4 }` would otherwise validate clean,
    // Membrane would ignore it, and the agent would sit at zero retries —
    // exactly the hard-down mode this knob exists to close, wearing a config
    // that looks like it fixed it.
    for (const key of Object.keys(retry)) {
      if (!(RETRY_KEYS as readonly string[]).includes(key) && key !== 'overloaded') {
        throw new Error(`Recipe agent.retry has unknown key ${JSON.stringify(key)} (known: ${RETRY_KEYS.join(', ')}, overloaded).`);
      }
    }
    for (const key of ['maxRetries', 'retryDelayMs', 'backoffMultiplier', 'maxRetryDelayMs'] as const) {
      const v = retry[key];
      if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v) && v >= 0)) {
        throw new Error(`Recipe agent.retry.${key} must be a non-negative number, got ${JSON.stringify(v)}.`);
      }
    }
    if (retry.overloaded !== undefined) {
      const overloaded = retry.overloaded as Record<string, unknown> | null;
      if (typeof overloaded !== 'object' || overloaded === null || Array.isArray(overloaded)) {
        throw new Error(`Recipe agent.retry.overloaded must be an object, got ${JSON.stringify(retry.overloaded)}.`);
      }
      for (const key of Object.keys(overloaded)) {
        if (!(RETRY_KEYS as readonly string[]).includes(key)) {
          throw new Error(`Recipe agent.retry.overloaded has unknown key ${JSON.stringify(key)} (known: ${RETRY_KEYS.join(', ')}).`);
        }
        const v = overloaded[key];
        if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v) && v >= 0)) {
          throw new Error(`Recipe agent.retry.overloaded.${key} must be a non-negative number, got ${JSON.stringify(v)}.`);
        }
      }
    }
  }

  // openai-compatible: an endpoint the host knows nothing about, so the recipe
  // must say where it is and which model to ask for. Fail at load time, not as
  // a fetch to 'undefined/chat/completions' at first inference.
  if (agent.provider === 'openai-compatible') {
    if (typeof agent.baseUrl !== 'string' || !agent.baseUrl.trim()) {
      throw new Error("Recipe agent.baseUrl is required when agent.provider is 'openai-compatible' (e.g. \"http://localhost:11434/v1\").");
    }
    let parsed: URL;
    try {
      parsed = new URL(agent.baseUrl);
    } catch {
      throw new Error(`Recipe agent.baseUrl must be an absolute http(s) URL, got ${JSON.stringify(agent.baseUrl)}.`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Recipe agent.baseUrl must use http or https, got ${JSON.stringify(agent.baseUrl)}.`);
    }
    if (typeof agent.model !== 'string' || !agent.model.trim()) {
      throw new Error("Recipe agent.model is required when agent.provider is 'openai-compatible' (no default model for an arbitrary endpoint).");
    }
  } else if (agent.baseUrl !== undefined) {
    throw new Error(
      `Recipe agent.baseUrl only applies to agent.provider 'openai-compatible' (got provider ${JSON.stringify(agent.provider ?? 'anthropic')}); ` +
      'other providers take their endpoint from ANTHROPIC_BASE_URL / OPENAI_BASE_URL / BEDROCK_BASE_URL.',
    );
  }

  // A keepalive that fires AFTER the entry has already expired is the worst of
  // both worlds: it pays a full 2x cache write on every poke, forever, and
  // reports success while doing it. Refuse the config rather than discover it
  // in a bill. (The runtime also self-checks — see membrane cache-keepalive —
  // but a typo'd recipe should never get that far.)
  const keepalive = agent.cacheKeepalive;
  if (keepalive !== undefined) {
    if (typeof keepalive !== 'object' || keepalive === null) {
      throw new Error(`Recipe agent.cacheKeepalive must be an object, got ${JSON.stringify(keepalive)}.`);
    }
    const { maxIdleHours, refreshAfterMinutes } = keepalive as {
      maxIdleHours?: unknown;
      refreshAfterMinutes?: unknown;
    };
    if (refreshAfterMinutes !== undefined) {
      if (typeof refreshAfterMinutes !== 'number' || !(refreshAfterMinutes > 0)) {
        throw new Error(`Recipe agent.cacheKeepalive.refreshAfterMinutes must be a positive number, got ${JSON.stringify(refreshAfterMinutes)}.`);
      }
      const ttlMinutes = agent.cacheTtl === '1h' ? 60 : 5;
      if (refreshAfterMinutes >= ttlMinutes) {
        throw new Error(
          `Recipe agent.cacheKeepalive.refreshAfterMinutes (${refreshAfterMinutes}) must be less than the ${agent.cacheTtl} cache TTL (${ttlMinutes}m), ` +
          'or every keepalive would land after the entry expired and pay a full cache write instead of a read.',
        );
      }
    }
    if (maxIdleHours !== undefined && (typeof maxIdleHours !== 'number' || !(maxIdleHours > 0))) {
      throw new Error(`Recipe agent.cacheKeepalive.maxIdleHours must be a positive number, got ${JSON.stringify(maxIdleHours)}.`);
    }
  }

  if (agent.promptCaching !== undefined && typeof agent.promptCaching !== 'boolean') {
    throw new Error(
      `Recipe agent.promptCaching must be a boolean, got ${JSON.stringify(agent.promptCaching)}.`,
    );
  }

  if (
    agent.sameRoundThinkTextPolicy !== undefined &&
    agent.sameRoundThinkTextPolicy !== 'public' &&
    agent.sameRoundThinkTextPolicy !== 'private'
  ) {
    throw new Error(
      `Recipe agent.sameRoundThinkTextPolicy must be 'public' or 'private', got ${JSON.stringify(agent.sameRoundThinkTextPolicy)}.`,
    );
  }

  // Validate agent.thinking if present. Catches typos and constraint
  // violations (notably max_tokens > budget_tokens) at recipe-load time
  // rather than as a 400 from Anthropic at first inference.
  if (agent.thinking !== undefined) {
    if (!agent.thinking || typeof agent.thinking !== 'object' || Array.isArray(agent.thinking)) {
      throw new Error('Recipe agent.thinking must be an object with "enabled" and optional "budgetTokens".');
    }
    const thinking = agent.thinking as Record<string, unknown>;
    if (typeof thinking.enabled !== 'boolean') {
      throw new Error('Recipe agent.thinking.enabled must be a boolean.');
    }
    if (thinking.budgetTokens !== undefined && (typeof thinking.budgetTokens !== 'number' || thinking.budgetTokens <= 0)) {
      throw new Error('Recipe agent.thinking.budgetTokens must be a positive number.');
    }
    if (thinking.type !== undefined && thinking.type !== 'enabled' && thinking.type !== 'adaptive') {
      throw new Error('Recipe agent.thinking.type must be "enabled" or "adaptive".');
    }
    if (thinking.display !== undefined && thinking.display !== 'summarized' && thinking.display !== 'omitted') {
      throw new Error('Recipe agent.thinking.display must be "summarized" or "omitted".');
    }
    if (thinking.effort !== undefined && (
      typeof thinking.effort !== 'string' || !REASONING_EFFORTS.includes(thinking.effort as ReasoningEffort)
    )) {
      throw new Error(`Recipe agent.thinking.effort must be one of: ${REASONING_EFFORTS.join(', ')}.`);
    }
    if (thinking.enabled === true && typeof thinking.budgetTokens === 'number' && typeof agent.maxTokens === 'number') {
      if (thinking.budgetTokens >= agent.maxTokens) {
        throw new Error(
          `Recipe agent.thinking.budgetTokens (${thinking.budgetTokens}) must be less than agent.maxTokens (${agent.maxTokens}) ` +
            `(Anthropic requires max_tokens > thinking.budget_tokens).`,
        );
      }
    }
  }

  // Validate the extensions block if present (before the strategy check,
  // which consults it to admit custom strategy types).
  let hasStrategyExtension = false;
  if (obj.extensions !== undefined) {
    if (!obj.extensions || typeof obj.extensions !== 'object' || Array.isArray(obj.extensions)) {
      throw new Error('Recipe "extensions" must be an object mapping names to extension entries.');
    }
    for (const [name, entry] of Object.entries(obj.extensions as Record<string, unknown>)) {
      if (!name) throw new Error('Recipe extensions keys must be non-empty names.');
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`extensions.${name} must be an object.`);
      }
      const ext = entry as Record<string, unknown>;
      if (ext.kind !== 'strategy' && ext.kind !== 'module') {
        throw new Error(`extensions.${name}.kind must be "strategy" or "module", got ${JSON.stringify(ext.kind)}.`);
      }
      if (typeof ext.path !== 'string' || !ext.path) {
        throw new Error(`extensions.${name}.path must be a non-empty string.`);
      }
      if (ext.config !== undefined && (!ext.config || typeof ext.config !== 'object' || Array.isArray(ext.config))) {
        throw new Error(`extensions.${name}.config must be an object.`);
      }
      for (const metaKey of ['source', 'sourceMeta'] as const) {
        if (ext[metaKey] !== undefined && (!ext[metaKey] || typeof ext[metaKey] !== 'object' || Array.isArray(ext[metaKey]))) {
          throw new Error(`extensions.${name}.${metaKey} must be an object.`);
        }
      }
      if (ext.kind === 'strategy') hasStrategyExtension = true;
    }
  }

  // Validate strategy type if present
  if (agent.strategy) {
    const strategy = agent.strategy as Record<string, unknown>;
    if (
      strategy.type &&
      strategy.type !== 'autobiographical' &&
      strategy.type !== 'passthrough' &&
      strategy.type !== 'frontdesk' &&
      !hasStrategyExtension
    ) {
      throw new Error(
        `Invalid strategy type "${strategy.type}". Must be "autobiographical", "passthrough", ` +
        `or "frontdesk" — or a custom type registered by a "kind": "strategy" entry in the ` +
        `recipe's "extensions" block (none is declared).`,
      );
    }
    if (
      strategy.foldingStrategy !== undefined &&
      strategy.foldingStrategy !== 'flat-profile' &&
      strategy.foldingStrategy !== 'oldest-first' &&
      strategy.foldingStrategy !== 'kv-stable' &&
      strategy.foldingStrategy !== 'kv-unified'
    ) {
      throw new Error(
        `Recipe agent.strategy.foldingStrategy is invalid: ${JSON.stringify(strategy.foldingStrategy)}.`,
      );
    }
    if (strategy.foldingStrategy === 'kv-unified' && strategy.type === 'passthrough') {
      throw new Error('Recipe foldingStrategy "kv-unified" requires an autobiographical or frontdesk strategy.');
    }
    // Recipes are runtime JSON: the interface's union is not a check. Context
    // Manager treats every value other than the exact string 'live-strip' as
    // 'full', so a typo would silently keep replaying the reasoning carriers
    // this key exists to strip. Fail at load, like foldingStrategy.
    if (
      strategy.carrierPolicy !== undefined &&
      strategy.carrierPolicy !== 'full' &&
      strategy.carrierPolicy !== 'live-strip'
    ) {
      throw new Error(
        `Recipe agent.strategy.carrierPolicy is invalid: ${JSON.stringify(strategy.carrierPolicy)}. ` +
        `Must be "full" or "live-strip".`,
      );
    }
    validateKvUnifiedConfig(strategy);
    // These controls belong to the built-in memory strategies. Extensions
    // receive their own config verbatim and may use different conventions.
    const strategyType = strategy.type ?? 'autobiographical';
    if (strategyType === 'autobiographical' || strategyType === 'frontdesk') {
      // Context Manager uses zero to disable each image limit independently.
      for (const key of ['maxLiveImages', 'imageStripDepthTokens', 'maxLiveImageBytes'] as const) {
        const value = strategy[key];
        if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) {
          throw new Error(`Recipe agent.strategy.${key} must be a non-negative safe integer.`);
        }
      }
    }
    if (
      strategy.compressionRefusalCurveFallbacks !== undefined
      && (
        typeof strategy.compressionRefusalCurveFallbacks !== 'number'
        || !Number.isSafeInteger(strategy.compressionRefusalCurveFallbacks)
        || strategy.compressionRefusalCurveFallbacks < 0
      )
    ) {
      throw new Error('Recipe agent.strategy.compressionRefusalCurveFallbacks must be a non-negative safe integer.');
    }
    if (
      strategy.compressionContextBudgetTokens !== undefined
      && (
        typeof strategy.compressionContextBudgetTokens !== 'number'
        || !Number.isSafeInteger(strategy.compressionContextBudgetTokens)
        || strategy.compressionContextBudgetTokens <= 0
      )
    ) {
      throw new Error('Recipe agent.strategy.compressionContextBudgetTokens must be a positive safe integer.');
    }
    for (const key of [
      'compressionSourceOnly',
      'compressionSourceOnlyFallback',
      'compressionMergeSourceOnly',
      'compressionMergeSourceOnlyFallback',
      'compressionSplitFallback',
      'compressionSplitPlaceholder',
    ] as const) {
      if (strategy[key] !== undefined && typeof strategy[key] !== 'boolean') {
        throw new Error(`Recipe agent.strategy.${key} must be a boolean.`);
      }
    }
    if (strategy.compressionToolProseFallback !== undefined) {
      // Fail loudly: CM silently treats a malformed value as "rung off", which
      // on a resident whose compressions are refusing is an outage, not a default.
      const hoist = strategy.compressionToolProseFallback as Record<string, unknown> | null;
      const where = 'Recipe agent.strategy.compressionToolProseFallback';
      if (!hoist || typeof hoist !== 'object' || Array.isArray(hoist)) {
        throw new Error(`${where} must be an object { intoTool, fromTools, field?, result?, minChars? }.`);
      }
      if (typeof hoist.intoTool !== 'string' || !hoist.intoTool) {
        throw new Error(`${where}.intoTool must be a non-empty string.`);
      }
      if (
        !Array.isArray(hoist.fromTools) || hoist.fromTools.length === 0
        || hoist.fromTools.some((name) => typeof name !== 'string' || !name)
      ) {
        throw new Error(`${where}.fromTools must be a non-empty array of tool names.`);
      }
      if ((hoist.fromTools as string[]).includes(hoist.intoTool)) {
        throw new Error(`${where}.fromTools must not contain intoTool.`);
      }
      for (const key of ['field', 'result'] as const) {
        if (hoist[key] !== undefined && (typeof hoist[key] !== 'string' || !hoist[key])) {
          throw new Error(`${where}.${key} must be a non-empty string.`);
        }
      }
      if (
        hoist.minChars !== undefined
        && (typeof hoist.minChars !== 'number' || !Number.isSafeInteger(hoist.minChars) || hoist.minChars < 0)
      ) {
        throw new Error(`${where}.minChars must be a non-negative safe integer.`);
      }
      const unknown = Object.keys(hoist).filter((key) => !['intoTool', 'fromTools', 'field', 'result', 'minChars'].includes(key));
      if (unknown.length > 0) throw new Error(`${where} has unknown key(s): ${unknown.join(', ')}.`);
    }
    for (const key of ['compressionSplitMaxCallsPerChunk', 'compressionSplitMaxCallsPer10Min'] as const) {
      const value = strategy[key];
      if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)) {
        throw new Error(`Recipe agent.strategy.${key} must be a positive safe integer.`);
      }
    }
    if (
      strategy.compressionRecallBudgetTokens !== undefined
      && (
        typeof strategy.compressionRecallBudgetTokens !== 'number'
        || !Number.isSafeInteger(strategy.compressionRecallBudgetTokens)
        || strategy.compressionRecallBudgetTokens <= 0
      )
    ) {
      throw new Error('Recipe agent.strategy.compressionRecallBudgetTokens must be a positive safe integer.');
    }
  }

  const refusalHandling = agent.refusalHandling as Record<string, unknown> | undefined;
  if (refusalHandling && Object.hasOwn(refusalHandling, 'primarySummaryFallback')) {
    throw new Error('Recipe agent.refusalHandling.primarySummaryFallback was removed and is unsupported.');
  }

  // Validate mcpServers entries if present
  if (obj.mcpServers && typeof obj.mcpServers === 'object') {
    for (const [id, entry] of Object.entries(obj.mcpServers as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') {
        throw new Error(`mcpServers.${id} must be an object`);
      }
      const server = entry as Record<string, unknown>;
      // An entry with neither command nor url names a server defined in
      // mcpl-servers.json and sets only policy fields on it; it is resolved
      // (or rejected, if the file has no such id) at startup by
      // mergeRecipeServers. When present, each must be a non-empty string.
      if (server.command !== undefined && !(typeof server.command === 'string' && server.command)) {
        throw new Error(`mcpServers.${id}.command must be a non-empty string`);
      }
      if (server.url !== undefined && !(typeof server.url === 'string' && server.url)) {
        throw new Error(`mcpServers.${id}.url must be a non-empty string`);
      }
      if (server.args !== undefined && !Array.isArray(server.args)) {
        throw new Error(`mcpServers.${id}.args must be an array`);
      }
      if (server.inheritEnv !== undefined && typeof server.inheritEnv !== 'boolean') {
        throw new Error(`mcpServers.${id}.inheritEnv must be a boolean`);
      }
      if (server.requestTimeoutMs !== undefined
          && !(typeof server.requestTimeoutMs === 'number' && Number.isFinite(server.requestTimeoutMs) && server.requestTimeoutMs >= 0)) {
        throw new Error(`mcpServers.${id}.requestTimeoutMs must be a non-negative number (ms; 0 disables)`);
      }
      if (server.source !== undefined) {
        if (typeof server.source !== 'object' || server.source === null) {
          throw new Error(`mcpServers.${id}.source must be an object`);
        }
        const src = server.source as Record<string, unknown>;
        const hasSrcUrl = typeof src.url === 'string' && src.url;
        const hasSrcNpm = typeof src.npm === 'string' && src.npm;
        if (hasSrcUrl && hasSrcNpm) {
          throw new Error(`mcpServers.${id}.source must not set both "url" and "npm"`);
        }
        if (!hasSrcUrl && !hasSrcNpm) {
          throw new Error(
            `mcpServers.${id}.source must have a non-empty "url" (git clone) ` +
            `or "npm" (registry package spec) string`,
          );
        }
        if (src.ref !== undefined && typeof src.ref !== 'string') {
          throw new Error(`mcpServers.${id}.source.ref must be a string`);
        }
        if (src.install !== undefined) {
          const install = src.install;
          const isShorthand = install === 'npm' || install === 'pip-editable';
          const isCustom =
            typeof install === 'object' && install !== null
            && typeof (install as Record<string, unknown>).run === 'string'
            && ['node', 'python3', 'custom', 'bun'].includes(
              (install as Record<string, unknown>).runtime as string,
            );
          if (!isShorthand && !isCustom) {
            throw new Error(
              `mcpServers.${id}.source.install must be 'npm', 'pip-editable', ` +
              `or { run: string, runtime: 'node' | 'python3' | 'custom' | 'bun' }`,
            );
          }
        }
        if (src.authSecret !== undefined && typeof src.authSecret !== 'string') {
          throw new Error(`mcpServers.${id}.source.authSecret must be a string`);
        }
        if (src.sslBypass !== undefined && typeof src.sslBypass !== 'boolean') {
          throw new Error(`mcpServers.${id}.source.sslBypass must be a boolean`);
        }
        if (src.systemPackages !== undefined) {
          // The regex bounds these to Debian package names — build tooling
          // pastes them into an `apt-get install` line, so an unbounded string
          // is a command-injection vector. Kept in sync with cook's vendored
          // copy (connectome-cook src/vendor/recipe.ts).
          if (!Array.isArray(src.systemPackages)
            || !(src.systemPackages as unknown[]).every(
              (p) => typeof p === 'string' && /^[a-z0-9][a-z0-9+.\-]+$/.test(p),
            )) {
            throw new Error(`mcpServers.${id}.source.systemPackages must be an array of Debian package names`);
          }
        }
        if (src.inContainer !== undefined) {
          if (typeof src.inContainer !== 'object' || src.inContainer === null) {
            throw new Error(`mcpServers.${id}.source.inContainer must be an object`);
          }
          if (typeof (src.inContainer as Record<string, unknown>).path !== 'string') {
            throw new Error(`mcpServers.${id}.source.inContainer.path must be a string`);
          }
        }
      }
      for (const field of ['enabledTools', 'disabledTools'] as const) {
        if (server[field] === undefined) continue;
        if (!Array.isArray(server[field]) || !(server[field] as unknown[]).every((p) => typeof p === 'string' && p)) {
          throw new Error(`mcpServers.${id}.${field} must be an array of non-empty strings`);
        }
      }
      if (server.toolLifecycle !== undefined) {
        validateToolLifecycle(server.toolLifecycle, `mcpServers.${id}.toolLifecycle`);
      }
      if (server.credentialFiles !== undefined) {
        if (!Array.isArray(server.credentialFiles)) {
          throw new Error(`mcpServers.${id}.credentialFiles must be an array`);
        }
        const seenPaths = new Set<string>();
        for (let i = 0; i < server.credentialFiles.length; i++) {
          const cf = server.credentialFiles[i] as Record<string, unknown>;
          if (!cf || typeof cf !== 'object') {
            throw new Error(`mcpServers.${id}.credentialFiles[${i}] must be an object`);
          }
          if (typeof cf.path !== 'string' || !cf.path) {
            throw new Error(`mcpServers.${id}.credentialFiles[${i}].path must be a non-empty string`);
          }
          if (seenPaths.has(cf.path)) {
            throw new Error(`mcpServers.${id}.credentialFiles[${i}].path "${cf.path}" is duplicated within the same server`);
          }
          seenPaths.add(cf.path);
          if (cf.format !== 'ini' && cf.format !== 'json' && cf.format !== 'env') {
            throw new Error(`mcpServers.${id}.credentialFiles[${i}].format must be 'ini', 'json', or 'env'`);
          }
          if (cf.section !== undefined && typeof cf.section !== 'string') {
            throw new Error(`mcpServers.${id}.credentialFiles[${i}].section must be a string`);
          }
          if (cf.mode !== undefined && (typeof cf.mode !== 'string' || !/^0?[0-7]{3,4}$/.test(cf.mode))) {
            throw new Error(`mcpServers.${id}.credentialFiles[${i}].mode must be an octal string like "0600"`);
          }
          if (!Array.isArray(cf.fields) || cf.fields.length === 0) {
            throw new Error(`mcpServers.${id}.credentialFiles[${i}].fields must be a non-empty array`);
          }
          const seenFieldNames = new Set<string>();
          for (let j = 0; j < cf.fields.length; j++) {
            const f = cf.fields[j] as Record<string, unknown>;
            if (!f || typeof f !== 'object') {
              throw new Error(`mcpServers.${id}.credentialFiles[${i}].fields[${j}] must be an object`);
            }
            if (typeof f.name !== 'string' || !f.name) {
              throw new Error(`mcpServers.${id}.credentialFiles[${i}].fields[${j}].name must be a non-empty string`);
            }
            if (seenFieldNames.has(f.name)) {
              throw new Error(`mcpServers.${id}.credentialFiles[${i}].fields[${j}].name "${f.name}" is duplicated`);
            }
            seenFieldNames.add(f.name);
            if (f.envOverride !== undefined && (typeof f.envOverride !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(f.envOverride))) {
              throw new Error(`mcpServers.${id}.credentialFiles[${i}].fields[${j}].envOverride must be a valid env var name`);
            }
            for (const optStr of ['description', 'placeholder'] as const) {
              if (f[optStr] !== undefined && typeof f[optStr] !== 'string') {
                throw new Error(`mcpServers.${id}.credentialFiles[${i}].fields[${j}].${optStr} must be a string`);
              }
            }
            if (f.secret !== undefined && typeof f.secret !== 'boolean') {
              throw new Error(`mcpServers.${id}.credentialFiles[${i}].fields[${j}].secret must be a boolean`);
            }
          }
        }
      }
    }
  }

  // A `modules` that isn't an object would read every module setting as
  // absent and build the default mounts, read-write `products` included.
  // `null` is refused too, as for `extensions`.
  if (obj.modules !== undefined && (typeof obj.modules !== 'object' || obj.modules === null || Array.isArray(obj.modules))) {
    throw new Error('modules must be an object of module settings, not null or a list');
  }

  // Validate workspace mounts if present
  if (obj.modules && typeof obj.modules === 'object') {
    const mods = obj.modules as Record<string, unknown>;
    // Anything else would build the default mounts, read-write `products`
    // included (a string such as "off"), or crash the mount builder (null).
    if (mods.workspace !== undefined && typeof mods.workspace !== 'boolean'
        && (typeof mods.workspace !== 'object' || mods.workspace === null || Array.isArray(mods.workspace))) {
      throw new Error('modules.workspace must be true, false or an object of settings, not null or a list');
    }
    if (mods.workspace && typeof mods.workspace === 'object') {
      const ws = mods.workspace as Record<string, unknown>;
      // A key the host doesn't read stops the load: a mount's keys decide
      // what an agent can read and write, and a misspelt one would otherwise
      // leave the mount as it would be without it (`readOnly: true` left a
      // mount read-write).
      for (const key of Object.keys(ws)) {
        if (!(RECIPE_WORKSPACE_KEYS as readonly string[]).includes(key)) throw unknownKeyError('workspace', key, RECIPE_WORKSPACE_KEYS);
      }
      if (ws.configMount !== undefined && typeof ws.configMount !== 'boolean') {
        throw new Error('workspace.configMount must be true or false');
      }
      if (!Array.isArray(ws.mounts) || ws.mounts.length === 0) {
        throw new Error('workspace.mounts must be a non-empty array');
      }
      for (let i = 0; i < ws.mounts.length; i++) {
        const m = ws.mounts[i] as Record<string, unknown>;
        const where = `workspace.mounts[${i}]`;
        if (!m || typeof m !== 'object') {
          throw new Error(`${where} must be an object`);
        }
        for (const key of Object.keys(m)) {
          if (Object.hasOwn(MOUNT_KEY_CHECKS, key)) continue;
          throw unknownKeyError(where, key, RECIPE_MOUNT_KEYS, Object.hasOwn(MOUNT_KEY_INSTEAD, key) ? MOUNT_KEY_INSTEAD[key] : undefined);
        }
        // Each key it gives, and the two it must have. `null` is no value of
        // any key's kind, so it's refused like any other.
        for (const key of RECIPE_MOUNT_KEYS) {
          if (m[key] === undefined && !REQUIRED_MOUNT_KEYS.includes(key)) continue;
          const mustBe = MOUNT_KEY_CHECKS[key](m[key]);
          if (mustBe) throw new Error(`${where}.${key} must be ${mustBe}`);
        }
      }
    }

    // Validate instructions if present. It reads through a workspace mount,
    // so pairing it with `workspace: false` is a config contradiction — fail
    // at load, not with a silent no-injection at runtime.
    if (mods.instructions !== undefined && mods.instructions !== false) {
      if (mods.instructions !== true
          && (typeof mods.instructions !== 'object' || Array.isArray(mods.instructions))) {
        throw new Error('modules.instructions must be a boolean or object');
      }
      if (mods.workspace === false) {
        throw new Error(
          'modules.instructions requires modules.workspace: the instructions file is ' +
          'read through a workspace mount, but this recipe sets workspace: false.',
        );
      }
      if (typeof mods.instructions === 'object') {
        const ins = mods.instructions as Record<string, unknown>;
        const allowedInstructionKeys = new Set(['path', 'header', 'maxBytes', 'position']);
        for (const key of Object.keys(ins)) {
          if (!allowedInstructionKeys.has(key)) {
            throw new Error(
              `modules.instructions has unknown field ${JSON.stringify(key)} ` +
              `(expected one of: ${[...allowedInstructionKeys].join(', ')}).`,
            );
          }
        }
        if (ins.path !== undefined) {
          if (typeof ins.path !== 'string' || !ins.path.trim()) {
            throw new Error('modules.instructions.path must be a non-empty string');
          }
          const slashIdx = ins.path.indexOf('/');
          if (slashIdx <= 0 || slashIdx === ins.path.length - 1) {
            throw new Error(
              'modules.instructions.path must be a workspace path of the form ' +
              `"<mountName>/<relativePath>", got ${JSON.stringify(ins.path)}.`,
            );
          }
        }
        if (ins.header !== undefined && typeof ins.header !== 'string') {
          throw new Error('modules.instructions.header must be a string');
        }
        if (ins.maxBytes !== undefined
            && (typeof ins.maxBytes !== 'number' || !Number.isInteger(ins.maxBytes) || ins.maxBytes <= 0)) {
          throw new Error('modules.instructions.maxBytes must be a positive integer');
        }
        if (ins.position !== undefined
            && ins.position !== 'system' && ins.position !== 'beforeUser' && ins.position !== 'afterUser') {
          throw new Error(
            `modules.instructions.position must be 'system', 'beforeUser', or 'afterUser', ` +
            `got ${JSON.stringify(ins.position)}.`,
          );
        }
      }

      // The mount the instructions path names is knowable at load time in
      // EVERY configuration — explicit mounts from the declaration, the
      // implicit default workspace from the fixed input/products pair the
      // host builds — so a typo, the default "instructions/…" path with no
      // matching mount, or `instructions: true` on the implicit workspace
      // (whose mount set can never contain "instructions") all fail here
      // instead of as a silent no-injection at runtime.
      //
      // A read-write instructions mount additionally requires
      // autoMaterialize: workspace write/edit are Chronicle-first and reach
      // disk only when the mount materializes, while this module reads disk
      // — without it, an agent's own curation edits would never appear in
      // the injection (and its workspace read would show the new content,
      // hiding the drift entirely). Read-only mounts are exempt: disk is
      // their only write path.
      {
        const effectivePath =
          typeof mods.instructions === 'object'
              && typeof (mods.instructions as { path?: unknown }).path === 'string'
            ? (mods.instructions as { path: string }).path
            : 'instructions/AGENTS.md'; // keep in sync with DEFAULT_INSTRUCTIONS_PATH
        const mountName = effectivePath.slice(0, effectivePath.indexOf('/'));
        // Reason over the SAME mount construction the runtime uses — one
        // builder, no validator-vs-host drift (the storePath placeholder is
        // irrelevant here; only names/modes/flags are consulted).
        const declaredExplicitly =
          !!mods.workspace && typeof mods.workspace === 'object' &&
          !!(mods.workspace as { mounts?: unknown }).mounts;
        const effectiveMounts =
          buildWorkspaceMounts(mods.workspace as RecipeModules['workspace'], '.') ?? [];
        const match = effectiveMounts.find((m) => m.name === mountName);
        if (!match) {
          throw new Error(
            `modules.instructions.path ${JSON.stringify(effectivePath)} names workspace mount ` +
            `${JSON.stringify(mountName)}, but the ${declaredExplicitly ? 'declared' : 'implicit default'} ` +
            `mounts are: ${effectiveMounts.map((m) => JSON.stringify(m.name)).join(', ')}. ` +
            `(The default path "instructions/AGENTS.md" requires a workspace mount named ` +
            `"instructions" — declare one under modules.workspace.mounts.)`,
          );
        }
        if (match.name === '_config') {
          throw new Error(
            `modules.instructions.path ${JSON.stringify(effectivePath)} reads through the ` +
            `host-managed "_config" mount, which does NOT auto-materialize: agent edits stay ` +
            `Chronicle-side and only reach disk after branch-changing commands, so the ` +
            `instructions injection would silently serve stale content. Use a dedicated ` +
            `instructions mount instead.`,
          );
        }
        if (match.mode !== 'read-only' && match.autoMaterialize !== true) {
          throw new Error(
            `modules.instructions.path ${JSON.stringify(effectivePath)} uses read-write mount ` +
            `${JSON.stringify(mountName)} without autoMaterialize. Workspace writes are ` +
            `Chronicle-first and reach disk only when the mount materializes, while the ` +
            `instructions injection reads disk — agent edits to the file would silently never ` +
            `take effect. Set autoMaterialize: true on the mount` +
            `${declaredExplicitly ? '' : ' (the implicit default workspace cannot; declare explicit mounts)'}, ` +
            `or make the mount read-only if the file is maintained outside the agent.`,
          );
        }
      }
    }

    // History: boolean, or { semantic: { url, ... } } for embedding search.
    // Unknown keys are rejected at both levels: `{ sematic: … }` or
    // `syncIntervalMS` would otherwise validate clean and silently do nothing.
    const history = mods.history;
    if (history !== undefined && typeof history !== 'boolean') {
      if (!history || typeof history !== 'object' || Array.isArray(history)) {
        throw new Error('Recipe modules.history must be a boolean or object.');
      }
      const HISTORY_KEYS = ['semantic'];
      for (const key of Object.keys(history)) {
        if (!HISTORY_KEYS.includes(key)) {
          throw new Error(`Recipe modules.history has unknown key ${JSON.stringify(key)} (known: ${HISTORY_KEYS.join(', ')}).`);
        }
      }
      const sem = (history as Record<string, unknown>).semantic;
      if (sem !== undefined) {
        if (!sem || typeof sem !== 'object' || Array.isArray(sem)) {
          throw new Error('Recipe modules.history.semantic must be an object.');
        }
        const semCfg = sem as Record<string, unknown>;
        const SEMANTIC_KEYS = ['url', 'token', 'namespace', 'syncIntervalMs', 'maxSyncPerTick', 'maxSyncBeforeSearch', 'includePrivateTools', 'allowInsecureHttp'];
        for (const key of Object.keys(semCfg)) {
          if (!SEMANTIC_KEYS.includes(key)) {
            throw new Error(`Recipe modules.history.semantic has unknown key ${JSON.stringify(key)} (known: ${SEMANTIC_KEYS.join(', ')}).`);
          }
        }
        if (semCfg.allowInsecureHttp !== undefined && typeof semCfg.allowInsecureHttp !== 'boolean') {
          throw new Error('modules.history.semantic.allowInsecureHttp must be a boolean when set.');
        }
        // Parse, don't regex: `http://` has no host (the client would build
        // `http:///v1/…`, which WHATWG reads as host `v1`), and a query or
        // fragment in the base swallows the appended API path.
        let parsed: URL | null = null;
        if (typeof semCfg.url === 'string') { try { parsed = new URL(semCfg.url); } catch { parsed = null; } }
        if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname
            || typeof semCfg.url !== 'string' || /^https?:\/\/\//i.test(semCfg.url)) {
          throw new Error('modules.history.semantic.url must be an http(s) URL with a host (the embed-service base URL).');
        }
        if (parsed.username || parsed.password || parsed.search || parsed.hash || semCfg.url.includes('?') || semCfg.url.includes('#')) {
          throw new Error('modules.history.semantic.url must not carry credentials, a query or a fragment (use `token` for auth).');
        }
        // Sync ships raw messages (incl. private notes by default) and the
        // bearer token. Plain http is fine where the network is the
        // encryption (loopback, the tailnet's WireGuard); anywhere else it
        // takes an explicit opt-in.
        if (parsed.protocol === 'http:' && !isLoopbackOrTailnetHost(parsed.hostname) && semCfg.allowInsecureHttp !== true) {
          throw new Error(
            `modules.history.semantic.url ${JSON.stringify(semCfg.url)} is plaintext http to a host that is neither loopback nor tailnet ` +
            '(100.64.0.0/10, *.ts.net): history and the token would cross the network unencrypted. ' +
            'Use https, or set allowInsecureHttp: true if the path is otherwise private.',
          );
        }
        for (const k of ['token', 'namespace'] as const) {
          if (semCfg[k] !== undefined && (typeof semCfg[k] !== 'string' || !(semCfg[k] as string).trim())) {
            throw new Error(`modules.history.semantic.${k} must be a non-empty string when set.`);
          }
        }
        for (const k of ['maxSyncPerTick', 'maxSyncBeforeSearch'] as const) {
          if (semCfg[k] !== undefined && (!Number.isInteger(semCfg[k]) || (semCfg[k] as number) < 1)) {
            throw new Error(`modules.history.semantic.${k} must be an integer >= 1 when set.`);
          }
        }
        // 0 = no background sync (search still catches up); otherwise a floor,
        // so a typo can't become a 1 ms setInterval against a shared service.
        const si = semCfg.syncIntervalMs;
        if (si !== undefined && (!Number.isInteger(si) || ((si as number) !== 0 && (si as number) < 5000))) {
          throw new Error('modules.history.semantic.syncIntervalMs must be 0 (no background sync) or an integer >= 5000 when set.');
        }
        if (semCfg.includePrivateTools !== undefined && typeof semCfg.includePrivateTools !== 'boolean') {
          throw new Error('modules.history.semantic.includePrivateTools must be a boolean when set.');
        }
      }
    }

    // Validate retrieval provider reasoning when configured.
    const retrieval = mods.retrieval;
    if (retrieval !== undefined && typeof retrieval !== 'boolean') {
      if (!retrieval || typeof retrieval !== 'object' || Array.isArray(retrieval)) {
        throw new Error('Recipe modules.retrieval must be a boolean or object.');
      }
      const retrievalConfig = retrieval as Record<string, unknown>;
      if (retrievalConfig.reasoningContext !== undefined) {
        throw new Error(
          'modules.retrieval.reasoningContext is not supported: retrieval model calls ' +
          'are independent one-shot requests with no earlier reasoning items.',
        );
      }
      const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
      if (retrievalConfig.reasoningEffort !== undefined &&
          (typeof retrievalConfig.reasoningEffort !== 'string'
            || !efforts.includes(retrievalConfig.reasoningEffort))) {
        throw new Error(`Invalid modules.retrieval.reasoningEffort ${JSON.stringify(retrievalConfig.reasoningEffort)}.`);
      }
      if (retrievalConfig.reasoningEffort !== undefined
          && agent.provider !== 'openai-responses'
          && agent.provider !== 'openai-codex') {
        throw new Error(
          'modules.retrieval.reasoningEffort requires agent.provider ' +
          '"openai-responses" or "openai-codex".',
        );
      }
      if (retrievalConfig.reasoningEffort !== undefined
          && (typeof retrievalConfig.model !== 'string'
            || !retrievalConfig.model.trim())) {
        throw new Error(
          'modules.retrieval.model must be a non-empty string when ' +
          'modules.retrieval.reasoningEffort is configured.',
        );
      }
    }

    // Validate notices if present: channel ids and tiers are the whole
    // contract, and a typo here means an outage nobody is told about.
    if (mods.notices !== undefined && mods.notices !== false && mods.notices !== true) {
      if (mods.notices === null || typeof mods.notices !== 'object' || Array.isArray(mods.notices)) {
        throw new Error('modules.notices must be a boolean or object');
      }
      const n = mods.notices as Record<string, unknown>;
      const strList = (v: unknown, name: string): void => {
        if (v === undefined) return;
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x)) {
          throw new Error(`modules.notices.${name} must be an array of non-empty strings`);
        }
      };
      for (const key of Object.keys(n)) {
        if (!['statusChannels', 'reply', 'kinds', 'quietMs', 'renotifyMs'].includes(key)) {
          throw new Error(`modules.notices has unknown field ${JSON.stringify(key)}`);
        }
      }
      strList(n.statusChannels, 'statusChannels');
      if (n.reply !== undefined) {
        if (typeof n.reply !== 'object' || n.reply === null || Array.isArray(n.reply)) {
          throw new Error('modules.notices.reply must be an object ({ in?, not? })');
        }
        const r = n.reply as Record<string, unknown>;
        for (const key of Object.keys(r)) {
          if (key !== 'in' && key !== 'not') throw new Error(`modules.notices.reply has unknown field ${JSON.stringify(key)}`);
        }
        strList(r.in, 'reply.in');
        strList(r.not, 'reply.not');
      }
      if (n.kinds !== undefined) {
        if (typeof n.kinds !== 'object' || n.kinds === null || Array.isArray(n.kinds)) {
          throw new Error('modules.notices.kinds must be an object of kind → tier');
        }
        for (const [kind, tier] of Object.entries(n.kinds as Record<string, unknown>)) {
          if (tier !== 'silent' && tier !== 'status' && tier !== 'reply') {
            throw new Error(`modules.notices.kinds[${JSON.stringify(kind)}] must be 'silent', 'status', or 'reply'`);
          }
        }
      }
      for (const key of ['quietMs', 'renotifyMs'] as const) {
        const v = n[key];
        if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
          throw new Error(`modules.notices.${key} must be a non-negative number`);
        }
      }
    }

    // Validate selfRestart if present: a typo'd cooldown would otherwise
    // let an agent restart in a loop, or never.
    if (mods.selfRestart !== undefined && mods.selfRestart !== false && mods.selfRestart !== true) {
      if (mods.selfRestart === null || typeof mods.selfRestart !== 'object' || Array.isArray(mods.selfRestart)) {
        throw new Error('modules.selfRestart must be true, false or an object ({ cooldownMinutes? })');
      }
      const sr = mods.selfRestart as Record<string, unknown>;
      for (const key of Object.keys(sr)) {
        if (key !== 'cooldownMinutes') {
          throw new Error(`modules.selfRestart has unknown field ${JSON.stringify(key)}`);
        }
      }
      const cd = sr.cooldownMinutes;
      if (cd !== undefined && (typeof cd !== 'number' || !Number.isFinite(cd) || cd < 0)) {
        throw new Error('modules.selfRestart.cooldownMinutes must be a non-negative number of minutes');
      }
    }

    // Validate ttsRelay if present — url + token are load-bearing, and a
    // recipe that names the module but can't reach a relay should fail at
    // load, not silently stream nowhere.
    if (mods.ttsRelay !== undefined && mods.ttsRelay !== false) {
      if (typeof mods.ttsRelay !== 'object' || mods.ttsRelay === null) {
        throw new Error('modules.ttsRelay must be an object ({ url, token, ... })');
      }
      const tr = mods.ttsRelay as Record<string, unknown>;
      if (typeof tr.url !== 'string' || !/^wss?:\/\//.test(tr.url)) {
        throw new Error('modules.ttsRelay.url must be a ws:// or wss:// URL');
      }
      if (typeof tr.token !== 'string' || !tr.token) {
        throw new Error('modules.ttsRelay.token must be a non-empty string (use ${VAR} substitution)');
      }
    }

    // Validate fleet if present (object form only — boolean is trivially valid).
    if (mods.fleet && typeof mods.fleet === 'object') {
      const fleet = mods.fleet as Record<string, unknown>;
      if (fleet.children !== undefined) {
        if (!Array.isArray(fleet.children)) {
          throw new Error('fleet.children must be an array');
        }
        const seenNames = new Set<string>();
        for (let i = 0; i < fleet.children.length; i++) {
          const c = fleet.children[i] as Record<string, unknown>;
          if (!c || typeof c !== 'object') {
            throw new Error(`fleet.children[${i}] must be an object`);
          }
          if (typeof c.name !== 'string' || !c.name) {
            throw new Error(`fleet.children[${i}].name must be a non-empty string`);
          }
          if (seenNames.has(c.name)) {
            throw new Error(`fleet.children[${i}].name "${c.name}" is duplicated`);
          }
          seenNames.add(c.name);
          if (typeof c.recipe !== 'string' || !c.recipe) {
            throw new Error(`fleet.children[${i}].recipe must be a non-empty string`);
          }
          if (c.subscription !== undefined && !Array.isArray(c.subscription)) {
            throw new Error(`fleet.children[${i}].subscription must be an array of strings`);
          }
          if (c.autoStart !== undefined && typeof c.autoStart !== 'boolean') {
            throw new Error(`fleet.children[${i}].autoStart must be a boolean`);
          }
        }
      }
      if (fleet.allowedRecipes !== undefined) {
        if (!Array.isArray(fleet.allowedRecipes) || !fleet.allowedRecipes.every((r) => typeof r === 'string')) {
          throw new Error('fleet.allowedRecipes must be an array of strings');
        }
        // Prefix-match-only: reject mid-string `*` so the pattern can't look
        // like a glob while silently behaving as a literal.
        for (const pattern of fleet.allowedRecipes as string[]) {
          if (pattern === '*' || !pattern.includes('*')) continue;
          if (pattern.indexOf('*') !== pattern.length - 1) {
            throw new Error(
              `fleet.allowedRecipes entry "${pattern}" has a mid-string "*". ` +
              `Only trailing "*" (prefix match) or a bare "*" (allow all) are supported.`,
            );
          }
        }
      }
      if (fleet.defaultSubscription !== undefined) {
        if (!Array.isArray(fleet.defaultSubscription) || !fleet.defaultSubscription.every((s) => typeof s === 'string')) {
          throw new Error('fleet.defaultSubscription must be an array of strings');
        }
      }
      for (const k of ['socketWaitTimeoutMs', 'readyTimeoutMs', 'gracefulShutdownMs', 'sigtermEscalationMs'] as const) {
        if (fleet[k] !== undefined && (typeof fleet[k] !== 'number' || (fleet[k] as number) < 0)) {
          throw new Error(`fleet.${k} must be a non-negative number`);
        }
      }
    }
  }

  if (obj.codeExecution !== undefined) {
    if (!obj.codeExecution || typeof obj.codeExecution !== 'object' || Array.isArray(obj.codeExecution)) {
      throw new Error('Recipe codeExecution must be an object.');
    }
    const ce = obj.codeExecution as Record<string, unknown>;
    if (typeof ce.enabled !== 'boolean') {
      throw new Error('Recipe codeExecution.enabled must be a boolean.');
    }
    // As in the framework, a block that isn't on has nothing else read.
    if (ce.enabled) {
      for (const [key, instead] of Object.entries(RETIRED_CODE_EXECUTION_KEYS)) {
        if (ce[key] !== undefined && ce[key] !== null) {
          throw new Error(`Recipe codeExecution.${key} is no longer read (agent-framework 0.24): ${instead}.`);
        }
      }
      for (const k of CODE_EXECUTION_NUMBER_KEYS) {
        if (ce[k] !== undefined && (typeof ce[k] !== 'number' || !Number.isSafeInteger(ce[k]) || (ce[k] as number) < 0)) {
          throw new Error(`Recipe codeExecution.${k} must be a whole number of 0 or more.`);
        }
      }
    }
  }

  if (obj.toolClassOverrides !== undefined) {
    validateToolClassTable(obj.toolClassOverrides, 'Recipe toolClassOverrides');
  }

  if (obj.subconscious !== undefined) {
    if (!obj.subconscious || typeof obj.subconscious !== 'object' || Array.isArray(obj.subconscious)) {
      throw new Error('Recipe subconscious must be an object.');
    }
    const sub = obj.subconscious as Record<string, unknown>;
    const allowedSubconsciousKeys = new Set([
      'enabled', 'name', 'model', 'systemPrompt', 'allowChannelSpeech', 'reAnchorFraction',
    ]);
    for (const key of Object.keys(sub)) {
      if (!allowedSubconsciousKeys.has(key)) {
        throw new Error(
          `Recipe subconscious has unknown field ${JSON.stringify(key)} ` +
          `(expected one of: ${[...allowedSubconsciousKeys].join(', ')}).`,
        );
      }
    }
    if (typeof sub.enabled !== 'boolean') {
      throw new Error('Recipe subconscious.enabled must be a boolean.');
    }
    // The mode block is the subconscious's whole character; an enabled
    // subconscious without one would run on an empty system prompt.
    if (typeof sub.systemPrompt !== 'string' || !sub.systemPrompt.trim()) {
      throw new Error('Recipe subconscious.systemPrompt must be a non-empty string.');
    }
    for (const k of ['name', 'model'] as const) {
      if (sub[k] !== undefined && (typeof sub[k] !== 'string' || !(sub[k] as string).trim())) {
        throw new Error(`Recipe subconscious.${k} must be a non-empty string.`);
      }
    }
    if (sub.allowChannelSpeech !== undefined && typeof sub.allowChannelSpeech !== 'boolean') {
      throw new Error('Recipe subconscious.allowChannelSpeech must be a boolean.');
    }
    if (sub.reAnchorFraction !== undefined) {
      const f = sub.reAnchorFraction;
      if (typeof f !== 'number' || !(f > 0 && f <= 1)) {
        throw new Error('Recipe subconscious.reAnchorFraction must be a number in (0, 1].');
      }
    }
  }

  if (obj.conversations !== undefined) {
    if (!obj.conversations || typeof obj.conversations !== 'object' || Array.isArray(obj.conversations)) {
      throw new Error('Recipe conversations must be an object.');
    }
    const conv = obj.conversations as Record<string, unknown>;
    const allowedConversationKeys = new Set(['bind', 'trigger', 'idleTtlMs', 'closurePrompt', 'agentPrefix']);
    for (const key of Object.keys(conv)) {
      if (!allowedConversationKeys.has(key)) {
        throw new Error(
          `Recipe conversations has unknown field ${JSON.stringify(key)} ` +
          `(expected one of: ${[...allowedConversationKeys].join(', ')}).`,
        );
      }
    }
    const kinds = ['dm', 'groupDm', 'channel'] as const;
    for (const [field, allowed] of [
      ['bind', ['always', 'mention', 'never']],
      ['trigger', ['always', 'mention']],
    ] as Array<[string, string[]]>) {
      const rules = conv[field];
      if (rules === undefined) continue;
      if (!rules || typeof rules !== 'object' || Array.isArray(rules)) {
        throw new Error(`Recipe conversations.${field} must be an object.`);
      }
      for (const [kind, rule] of Object.entries(rules as Record<string, unknown>)) {
        if (!(kinds as readonly string[]).includes(kind)) {
          throw new Error(
            `Recipe conversations.${field} has unknown channel kind ${JSON.stringify(kind)} ` +
            `(expected one of: ${kinds.join(', ')}).`,
          );
        }
        if (typeof rule !== 'string' || !allowed.includes(rule)) {
          throw new Error(
            `Recipe conversations.${field}.${kind} must be one of ${allowed.map(r => `'${r}'`).join(', ')}, ` +
            `got ${JSON.stringify(rule)}.`,
          );
        }
      }
    }
    if (conv.idleTtlMs !== undefined &&
        (typeof conv.idleTtlMs !== 'number' || !Number.isFinite(conv.idleTtlMs) ||
         !Number.isInteger(conv.idleTtlMs) || conv.idleTtlMs <= 0)) {
      throw new Error('Recipe conversations.idleTtlMs must be a positive finite integer.');
    }
    if (conv.closurePrompt !== undefined && (typeof conv.closurePrompt !== 'string' || !conv.closurePrompt.trim())) {
      throw new Error('Recipe conversations.closurePrompt must be a non-empty string.');
    }
    if (conv.agentPrefix !== undefined &&
        (typeof conv.agentPrefix !== 'string' || !/^[A-Za-z0-9_-]+$/.test(conv.agentPrefix))) {
      throw new Error(
        'Recipe conversations.agentPrefix must be a non-empty string of [A-Za-z0-9_-] ' +
        '(it names fork agents and their Chronicle namespaces).',
      );
    }
  }

  return obj as unknown as Recipe;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function savedRecipePath(dataDir: string): string {
  return resolve(dataDir, '.recipe.json');
}

/**
 * Marker key stamped into saved `.recipe.json` snapshots that were written in
 * unresolved form (post-fix). Its presence tells loadSavedRecipe to run the
 * full substitute-and-validate pipeline on read; its absence means a legacy
 * snapshot saved fully resolved, which must be loaded verbatim — running
 * substitution over legacy content could hard-fail on a literal `${...}`
 * that survived in prose (e.g. a systemPrompt documenting env-var syntax).
 */
export const SAVED_RECIPE_UNRESOLVED_KEY = '$unresolved';

/**
 * Snapshot a recipe to `$DATA_DIR/.recipe.json` so a later run without a
 * recipe argument resumes the same configuration.
 *
 * Pass the `persistable` half of loadRecipeDetailed(), NOT the resolved
 * recipe: `$DATA_DIR` is typically host-mounted and backed up, so the file
 * must never contain substituted secrets. The snapshot keeps `${VAR}`
 * references (and any URL systemPrompt) unresolved; loadSavedRecipe
 * re-resolves them against the environment current at resume time.
 *
 * The file is written 0600 and chmod'd to 0600 even when it already exists,
 * as defense in depth for legacy resolved snapshots being overwritten.
 */
export function saveRecipe(dataDir: string, persistable: Record<string, unknown>): void {
  mkdirSync(dataDir, { recursive: true });
  const path = savedRecipePath(dataDir);
  const withMarker = { [SAVED_RECIPE_UNRESOLVED_KEY]: true, ...persistable };
  writeFileSync(path, JSON.stringify(withMarker, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  // writeFileSync's mode only applies on creation — enforce on overwrite too.
  chmodSync(path, 0o600);
}

/**
 * A directory at the saved recipe's path, itself or through a link, such as
 * one a Docker bind mount makes for a recipe file the host didn't have yet.
 * It was never a saved recipe. Moving or removing it is the fix that works
 * for both kinds, since a recipe file can't be written over a directory, even
 * through a link, and --no-recipe leaves a directory itself in place. So
 * startup says that in place of its usual ways out.
 */
export class SavedRecipeDirectoryError extends Error {}

/**
 * "it's a directory" or "it's a link to a directory" when a directory sits at
 * the saved recipe's path, itself or through a link; null for anything else,
 * and where that can't be told, as under a directory that can't be searched.
 * It reads what's there, whatever a failed read or write said about it: a
 * directory the host can't read fails a read with EACCES, not EISDIR.
 */
export function savedRecipeDirectory(dataDir: string): string | null {
  const path = savedRecipePath(dataDir);
  try {
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (entry?.isDirectory()) return "it's a directory";
    if (entry?.isSymbolicLink() && statSync(path, { throwIfNoEntry: false })?.isDirectory()) return "it's a link to a directory";
  } catch {
    // Nothing that can be looked at, such as a link to itself.
  }
  return null;
}

/**
 * Load the `.recipe.json` snapshot for a resumed session, or null when there
 * is none. A snapshot that's there but can't be used THROWS, saying why: one
 * that can't be read, isn't JSON, isn't a JSON object, or doesn't validate, in
 * either format. Returning null would start the default recipe in the resumed
 * agent's place, without a word.
 *
 * Snapshots carrying SAVED_RECIPE_UNRESOLVED_KEY are re-resolved through the
 * same pipeline loadRecipe uses — env substitution (so rotated secrets take
 * effect on restart), validation, and URL systemPrompt fetch. A missing
 * required `${VAR}` THROWS rather than returning null: silently falling back
 * to the default recipe would start a misconfigured agent, and the loud
 * failure names the variable to restore. A failed systemPrompt fetch throws
 * for the same reason.
 *
 * Legacy snapshots (no marker — saved fully resolved by older versions) are
 * validated and returned verbatim: no substitution, so a literal `${...}`
 * that survived resolution in prose cannot fail the load.
 */
export async function loadSavedRecipe(dataDir: string): Promise<Recipe | null> {
  const path = savedRecipePath(dataDir);
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Only nothing at the path is no saved recipe: a link to nothing is one
    // that can't be read.
    if (code === 'ENOENT' && lstatSync(path, { throwIfNoEntry: false }) === undefined) return null;
    const directory = savedRecipeDirectory(dataDir);
    if (directory !== null) throw new SavedRecipeDirectoryError(directory);
    throw new Error(`it can't be read (${code ?? (err instanceof Error ? err.message : String(err))})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // The parser's message can quote the file's text, and a snapshot from
    // before 0.8.0 can hold a key inline, so it isn't passed on.
    throw new Error("it isn't JSON");
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    const holds = raw === null ? 'null' : Array.isArray(raw) ? 'an array' : `a ${typeof raw}`;
    throw new Error(`it holds ${holds}, not a JSON object`);
  }

  if (!(SAVED_RECIPE_UNRESOLVED_KEY in raw)) {
    // Legacy resolved snapshot: load verbatim (no substitution).
    return validateRecipe(raw);
  }

  const { [SAVED_RECIPE_UNRESOLVED_KEY]: _marker, ...unresolved } = raw as Record<string, unknown>;
  // Deliberately outside a try/catch: substitution and validation errors on
  // a snapshot we wrote ourselves are actionable operator errors (a rotated
  // secret removed from the environment), not corruption to shrug off.
  const substituted = substituteEnvVars(unresolved, path);
  const recipe = validateRecipe(substituted);
  return resolveSystemPrompt(recipe);
}

/**
 * Remove whatever is at the saved recipe's path, so the next start without a
 * recipe argument starts the default: a file, or a link, one to nothing
 * included, and never a link's target. A directory there was never a saved
 * recipe, so it's left in place: rmSync refuses it, naming the path.
 */
export function clearSavedRecipe(dataDir: string): void {
  rmSync(savedRecipePath(dataDir), { force: true });
}

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

/**
 * Parse argv to find a recipe source. Returns null if none provided.
 * Skips known flags (--no-tui, --no-recipe).
 */
export function parseRecipeArg(argv: string[]): { source: string | null; noRecipe: boolean } {
  const noRecipe = argv.includes('--no-recipe');
  let source: string | null = null;

  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--')) continue;
    // First positional arg is the recipe source
    source = arg;
    break;
  }

  return { source, noRecipe };
}
