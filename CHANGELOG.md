# Changelog

Entries land with the change that causes them, as fragment files in
[`changelog.d/`](changelog.d/) that are folded into a version section at
release time — see [CONTRIBUTING.md](CONTRIBUTING.md#changelog).

## Unreleased

## 0.10.0 — 2026-10-13

### Added

- Recipes can tune `agent.strategy.maxLiveImages`, `imageStripDepthTokens`, and `maxLiveImageBytes` for autobiographical and frontdesk strategies. Values must be non-negative safe integers; zero disables the corresponding limit. Omitted values keep context-manager's defaults.

- `/bug <what happened>` assembles a bug report for connectome-host's public
  issues. It shows the report, saves it under `DATA_DIR`, and gives a link
  that opens GitHub's new-issue form with it filled in. Nothing is sent: the
  reporter reads it in the form and submits it under their own GitHub
  account, so it needs no credentials of the host's.
  - Besides the reporter's own words, the report holds only fields with a
    known shape: versions and commit, runtime and mode, the setup as
    structure (provider, a model id only when every word of it is a public
    model name, built-in modules, budgets, each MCP server by ordinal with
    its kind, transport and state), this process's provider failures as
    classifications, and this run's host errors as known class names and
    code locations in our own packages.
  - No log line, error message, request, response, prompt or recipe text is
    copied, into the report or the saved file, and no name a user chose
    (recipe, servers, custom modules, custom models, other packages), nor
    commands, arguments, URLs, env values or paths outside our own code.
    The error logs and provider errors can quote conversation text, so they
    are read only for these shapes.
  - Only a person runs it: the fleet's command tool refuses `/bug`.
  - A new issue form, `.github/ISSUE_TEMPLATE/bug_report.yml`, labels these
    reports `bug`.
  - `headless.log` now marks where each run begins, as `tui-error.log`
    already did, so a report reads only the current run's errors.

- Recipes can set **`agent.strategy.carrierPolicy: "live-strip"`** (context-manager
  #81, shipped since context-manager 0.8.0, but never reachable from a recipe
  until now). `'live-strip'` omits a summary's signed reasoning carriers
  (`responseContent` thinking blocks) from the agent's own live-compiled
  window only — compression/merge requests still carry them unconditionally,
  where they're measured load-bearing for some providers. Useful when a
  provider's classifier treats a compressor-signed reasoning block replayed
  inside the live window (rather than the request that minted it) as
  reasoning extraction. Default `'full'` is unchanged/behavior-preserving.

- `openai-codex` can run through an inference gate that holds the ChatGPT
  logins (the gate's `/codex` leg): set `CODEX_GATE_TOKEN` and point
  `CODEX_BASE_URL` at the gate. No Codex CLI or login runs on the host, the
  gate chooses the account, and a gate token is never sent without an
  explicit `CODEX_BASE_URL`. The subscription quota meter is off in this
  mode (the gate tracks utilization per login).

- Recipe `agent.strategy.compressionToolProseFallback: { intoTool, fromTools,
  field?, result?, minChars? }` — validated loudly (a malformed value is an
  error, never a silently disabled rung) and passed through to Context
  Manager's tool-prose hoist fallback, which retries a refused L1 compression
  with long `fromTools` arguments (e.g. a diary kept in `skip_reply.reason`)
  moved into calls to a note-taking tool the agent really has
  (agent-framework's `journal`). Requires the context-manager and
  agent-framework versions that carry the rung and the tool.

- **Subscription credential alerts with operator actions.** A host on a
  subscription credential (`ANTHROPIC_AUTH_TOKEN`, the new
  `ANTHROPIC_OAUTH_CREDENTIALS_FILE`, or provider `openai-codex`) now names
  what is wrong with it — `quota-spent`, `quota-unreadable`, `auth-expiring`,
  `auth-expired`, `auth-rejected`, `auth-login-required` — through the
  existing ops-alert pipeline (failures.log, `ops:alert` trace, webhook), so
  the TUI status bar, the WebUI alert strip and fleet parents all see it. Each
  alert carries the actions the host can run for it; the WebUI renders them
  as buttons on the alert row and in a new Health-tab credential section, the
  TUI names the matching `/auth refresh | login | recheck | token <tok>`
  command. Nothing rotates on its own: membrane's 401 retry gets the same
  token unless `ANTHROPIC_OAUTH_AUTO_REFRESH=1`. A credentials file with a
  refresh token (Claude Code's shape, or flat `accessToken`/`refreshToken`/
  `expiresAt`) makes the Anthropic credential host-rotatable and warns 30 min
  before expiry; a bare token offers "paste new token" only. New panel ops
  `credential` / `credential-action` (WS `request-credential` /
  `credential-action`, HTTP `GET /credential`) work fleet-wide over the
  panel IPC. The header quota readout now says `quota: unreadable` instead
  of rendering nothing when a subscription meter has never read. Behind an
  inference gateway the surface narrows to what the host can actually do: a
  Codex host on `CODEX_GATE_TOKEN` gets an observe-only credential source
  (a gate 401 raises `auth-rejected` naming the gate, Re-check only), and an
  Anthropic host on a gate API key gets no credential monitor at all.
- **Activity module: honest typing.** The typing indicator now also stops on
  `inference:failed` / `inference:exhausted`, not only on a completed turn.

- `modules.history` accepts an object form, `{ semantic: { url, token?, namespace?,
  syncIntervalMs?, maxSyncPerTick?, maxSyncBeforeSearch?, includePrivateTools?,
  allowInsecureHttp? } }`, which adds `history--semantic_search`: meaning-based
  search over the agent's raw messages and compression summaries via a shared
  remote embed-service (agent-framework#173). **Requires
  `@animalabs/agent-framework` >= 0.20.0**; startup throws if the installed
  HistoryModule offers no `semantic_search`. `token` goes through the recipe's
  `${ENV}` substitution. The index namespace is always `<prefix>/<session id>`;
  `namespace` sets the prefix (default: the agent name). Validation is loud at
  load: unknown keys at either level, a URL without a host or with
  credentials/query/fragment, plaintext http outside loopback/tailnet without
  `allowInsecureHttp: true`, budgets below 1, and `syncIntervalMs` other than 0
  or >= 5000 all fail the recipe.

- Recipes can set `agent.thinking.effort` before the first Anthropic streaming request, for example `"thinking": { "enabled": false, "effort": "medium" }`. The recipe remains the effort baseline across unrelated settings updates and restarts. Explicit agent effort overrides it until reset, including an explicit `"default"`; legacy saved `"default"` is treated as unset. A model that doesn't accept the effort level, such as Sonnet 4.5, Haiku 4.5 or a Claude 3 model, gets no effort and its default applies, with a line on stderr. Subagents stream through the same provider adapter, so on a model that accepts the effort they run at the recipe's effort too, as they already did at an effort the agent set. Other providers ignore this field; OpenAI recipes use `agent.responses.reasoningEffort`. Compression calls are unaffected.

- Recipes can set membrane `MockAdapter`'s timing and scripted replies under
  `agent.mock`: `completeDelayMs`, `streamChunkDelayMs` (non-negative
  numbers), `streamChunkSize` (positive integer) and `responseQueue` (non-empty
  strings, returned one per provider call before the echo or
  `defaultResponse`). Offline runs can now reproduce delay-sensitive behavior
  such as event coalescing during a slow turn. Unknown keys under
  `agent.mock` join the recipe's unknown-key warning.

- **Outage notices: the host speaks in the agent's channels when the agent
  cannot.** New opt-in `modules.notices`, a sink of the framework's
  `ops:alert` stream. Each alert kind resolves to a tier — `reply` (hard-down,
  spent quota, expired/rejected credential, pending login, provider hold),
  `status` (context refusal, MCPL server down, unreadable quota, expiring
  credential, …) or `silent` (refusals, unknown kinds) — overridable per kind
  with `*` globs (`"auth-*": "reply"`). For `reply` kinds, a person who writes
  to the agent during the outage gets one canned host-attributed "cannot
  respond right now" line per episode in channels matching `reply.in` minus
  `reply.not` (channel-id patterns: `zulip:*`, exact ids — "notify on Zulip,
  never on Discord" is one line), the channel whose message triggered the
  failing turn is told the same, and every channel told gets one "can respond
  again" line on recovery. `statusChannels` get the operator-grade message
  (kind + error text) for `status` and `reply` kinds after `quietMs` (default
  60 s) without a clear. Episodes close on the kind's `-clear`, on the agent's
  next completed inference for framework kinds that have none, or on
  reconnect for `mcpl-down`. A notice whose chat server is itself absent is
  parked and delivered if the server comes back while the outage is on. One
  chronicle marker per episode tells the agent the host spoke for it. The
  recipe validates channel lists, tiers and timings at load.

- Operators can see each tool's effective MCPL class (RFC-008) and where it
  came from: the recipe's `toolClassOverrides`, the host's own table, the
  server's `_meta["mcpl/class"]`, or nowhere (unclassed). The new
  `/tools [agent]` command lists them in the TUI, readline, web UI and
  headless; `GET /debug/tool-classes[?agent=]` (also a `tool-classes` panel
  op, so `?scope=<child>` works) serves them as JSON; the web UI's MCP tab
  shows per-source counts and the per-tool list; and the agent's `mcpl_list`
  groups each server's tools by class and source.

- Recipes and `mcpl-servers.json` can grant an MCPL server MCPL tool-lifecycle
  observation (RFC-007) with a `toolLifecycle` block on its entry
  (`observe`, `inputs`, optional `tools` / `classes` / `conversations`
  narrowing, `maxInputBytes`). The block is validated at load: an
  "off-looking" value such as `observe: false` is an error, not a grant.
  `toolLifecycle` is also a recipe-overridable field for servers taken from
  `mcpl-servers.json`, which previously dropped it.
- Recipes can set `toolClassOverrides` (tool-name pattern → RFC-008 classes)
  to class third-party MCP tools. The host now passes the classes of its
  own module tools (`HOST_TOOL_CLASSES`) to the framework. Both need an
  agent-framework release that includes tool lifecycle (#199); older
  frameworks ignore them.
- Servers an agent deploys for itself (`mcpl-servers.agent.json`) are denied
  `toolLifecycle`, and any `toolLifecycle` block in the overlay is stripped:
  observing other tools' calls stays an operator grant.
- A recipe `mcpServers` entry may now name a server from `mcpl-servers.json`
  by id with only policy fields, and no `command` / `url`. Validation used to
  reject this. An id-only entry the file doesn't define is a startup error
  rather than being silently skipped.

- WebUI: "⤢ all <tool>" on any tool block (and "all thinking" on thinking
  blocks) expands or collapses every block of that kind across the loaded
  history; individual blocks can still be toggled against the kind. The
  older-history control gains bulk loads (200 / 1k / 5k / all, chained in
  server-sized pages with progress and a stop button) beside scroll-to-load.

### Changed

- Depend on `@animalabs/agent-framework` ^0.21.0 and `@animalabs/context-manager` ^0.13.0. AF 0.21.0 lets stdio MCPL children inherit CA-bundle and proxy variables again (lost in 0.20.0's env allowlist); CM 0.13.0 adds optional compression-hold timeouts and render/diagnostic fixes.

- **The recipe `conversations` block is deprecated** (per-channel conversation
  routing, agent-framework#235). Its `'mention'` bind/trigger rule, the default
  for channels, reads `metadata.mentioned`, which discord-mcpl does not set, so
  on Discord channels an @-mention neither binds a fork nor triggers a bound
  one. Behavior is unchanged: routing still works, and the host logs one
  `[deprecated]` line at startup when a recipe sets `conversations`
  (`deprecatedConversationsNotices()` in `recipe.ts`). `Recipe.conversations`
  and `RecipeConversations` carry `@deprecated`, and the `idleTtlMs` docs now
  note that expiry is checked at most about once a minute, so the sweep usually
  notices an expired binding up to ~60s after the TTL; that is not a deadline
  for closing the fork, whose closure turn can be delayed further (e.g. while
  the host is quiesced).

- Depend on released `@animalabs/agent-framework` 0.18.0 and
  `@animalabs/context-manager` 0.11.0. kv-unified compiles no longer grow with
  the summary forest once a provider cache is relevant (CM #105/#110): on a
  production store, turn 2 went from out-of-memory at 6 GB to about 200 ms.

- Depend on released `@animalabs/agent-framework` 0.19.0. MCPL servers that
  announce a new channel from inside a tool call no longer deadlock against
  the host (agent-framework #160): in zulip-mcp, a stream the bot joined after
  startup stayed `Unknown channel` until a restart. Also brings the private
  `journal` tool beside `think` and `skip_reply`.

- Depend on released `@animalabs/agent-framework` 0.22.0,
  `@animalabs/context-manager` 0.14.0 and `@animalabs/membrane` 0.5.87.
  - **Prompt cache, once:** agent-framework 0.22's workspace tools (`ls`,
    `glob`, `grep`, `sync`, `materialize`, `delete`) have new descriptions and
    parameters, so the first request after the upgrade misses the cache from
    its tool block on.
  - **Workspace:** listings report what is on disk, `sync` without a path no
    longer replaces a workspace draft, and `materialize` no longer overwrites a
    file another writer changed (agent-framework 0.22's changelog has the
    details).
  - **Stores:** under `kv-unified`, context-manager 0.14 stores its
    presentation receipt run-length encoded, so `records.log` no longer grows
    quadratically with session length. Stores written by 0.13 still load.
  - **Makeup panel:** a native agent's exact count now carries its
    `prefillUserMessage` as the synthetic leading user turn, because membrane
    0.5.87's native formatter sends it there (it used to send `[continuing]`).

- docs: documentation brought in line with what the host does today. The
  README opens with what it is used for (long-lived residents, continued
  conversations, fleets, knowledge mining) and its reference sections were
  corrected against the code — MCP servers are recipe opt-in, `"webui": true`
  alone refuses to start off loopback, no Rust toolchain is needed, and the
  full provider, environment-variable, slash-command, key-binding and recipe
  tables. `ARCHITECTURE.md` is rewritten as-built. The original architecture
  document and the headless-fleet, unified-tree and locus-routing plans move
  verbatim to [`docs/history/`](docs/history/README.md), with notes on what
  became of each; the living headless/fleet protocol they contained is now
  [`docs/fleet-protocol.md`](docs/fleet-protocol.md). New
  [`docs/README.md`](docs/README.md) indexes every guide. Drift fixed across
  the memory and gating guides (adaptive resolution, L1…L8, what the
  compression pass actually sees, `gate_status`, `wake_add_rule`), the
  deployment, dev-environment, WebUI and debug-API guides, and the recipe
  setup guides (the TUI's chat ↔ fleet views, the `[y/N/d]` quit prompt).
  Source comments and the no-subfleets error now point at the new locations.

- docs: new [`docs/claude-code-ingest.md`](docs/claude-code-ingest.md) — continuing a
  Claude Code session transcript as a resident (active-branch walk, verbatim signed
  thinking, `tool_result` storage shape, verify-on-a-copy, and a `reasoning_extraction`
  refusal triage + mitigation section). `AGENT-ONBOARDING.md`: recipe skeleton updated to
  the tuned production values (300k/100k/32k, chunk 3000, merge 6, recall 40k, tool-prose
  fallback, `refusalHandling`), new §5b on `kv-stable` vs `kv-unified` with the reference
  kv-unified configuration and its preconditions, and new gotchas §11.8 (topology audit /
  open-mutates-store), §11.9 (`reasoning_extraction`), §11.10 (model-bound signed thinking).

- README documents `enabledFeatureSets` (omitted = every declared set; `[]` in
  a recipe or `mcpl-servers.json` = none, while the agent's overlay file reads
  `[]` as unset; a set without valid `uses` stays disabled) and model-facing
  MCPL tool names (`mcpl--<serverId>--<tool>`). The `toolClassOverrides`
  examples now use that form; `cua--*` and `blender--*` matched nothing.
- The shipped `knowledge-miner.json` and `clerk.json` prompts, and the setup
  guides, name the MCPL tools as the model sees them (`mcpl--zulip--listen`,
  `mcpl--gitlab--get_issue`, `mcpl--ddg--search`, `mcpl--syncntn--*`,
  `mcpl--scribe--*`) rather than without the `mcpl--` prefix.
- `mcpl_deploy`'s description and the overlay comments no longer call
  `disabledFeatureSets: ["*"]` deny-all: in feature-set patterns `*` matches
  exactly one dot-separated segment, so denying every set takes a pattern per
  depth (`["*", "*.*", "*.*.*"]`). `disabledTools: ["*"]` is deny-all for
  tools, as before.

### Fixed

- Fleet state snapshots no longer persist resolved child environment overrides. Adopted children recover restart overrides from the current matching recipe configuration, including `autoStart: false` entries; legacy persisted env is ignored. A child with no matching configured name, recipe, and data directory gets no overrides. A same-name recipe or data-directory mismatch logs the mismatched fields and withheld restart overrides without logging their values. Existing Chronicle history and backups may still contain previously saved secrets; operators should rotate affected credentials and handle historical copies according to their retention policy. Running child processes keep their existing environment until restarted.
- Evacuator-generated recipes pin the imported participant before host construction, keeping the live framework and Membrane role anchor aligned through `/session switch`. Name resolution uses `--agent`, then the chosen warmup session's sidecar, then `Claude`; the same name is passed explicitly to warmup. For custom imports without a selected warmup session or sidecar, supply `--agent`. Existing generated recipes need their hardcoded `agent` name corrected. Warmup selection rejects duplicate titles and ambiguous ID prefixes with candidate IDs; the guide and CLI explicitly require selecting the intended imported store before chatting under the revival identity. Replacing an output recipe with a different participant emits a warning, including when a resumed run falls back from a custom name to `Claude`.
- Headless command replies bypass event subscriptions like other protocol responses. Fleet commands and direct socket clients receive `command-output` even with narrow or empty subscriptions; unrelated telemetry remains filtered. Protocol replies stay with the requesting connection and are discarded if that connection closes or is replaced while work is pending. The headless log reports the dropped response type and reason, without its payload.
- The WebUI and fleet WebUI smoke-test recipes bind to `127.0.0.1`, so their unauthenticated local servers pass the existing bind-safety check. The fleet parent uses port 8788 and its child uses 8787 to avoid competing for one listener.
- The clerk recipe's channel-management procedures use `wake_add_rule` and `wake_remove_rule` for live, persisted gate changes, while retaining Zulip subscriptions and protected default policies. They no longer direct the clerk to edit a Chronicle workspace copy or promise a timed reload. The prompt distinguishes recipe-shipped rules restored at startup from runtime-only rules whose removal survives restart.
- The generic provider logging wrapper forwards an adapter's optional `toolResultImageMediaTypes` capability, preserving its native tool-image policy. Older adapters keep their existing behavior; Gemini HEIC/HEIF history preservation requires a membrane version containing antra-tess/membrane#92.

- **`GATE_TELEMETRY` now parses fail-closed** (#119). The env-flag parser
  treated every non-empty string except `0`/`false` as ON, so `off`, `no` and
  ordinary typos ENABLED the telemetry headers — with a configured base URL,
  the exact data-boundary leak the double gate exists to close. Only an
  allowlisted affirmative (`1` or `true`, trimmed, case-insensitive) enables
  it now; recognized negatives stay silent and any other value warns once,
  naming the accepted forms. The same fail-open parser copy guarding
  `LLM_CALLS_FULL_PAYLOADS` in the llm-calls logger is hardened identically.

- Recipes warn about keys the host never reads, at the top level, under
  `agent` and under `modules`, naming what each was probably meant to be
  (`mcplServers` → `mcpServers`; `modules.files` was replaced by
  `modules.workspace`) (#167). A warning, not an error, so recipes carrying
  leftovers keep loading. The known-key lists are type-checked against the
  `Recipe`, `RecipeAgent` and `RecipeModules` interfaces, so a key added to
  one can't be forgotten in the other.
- Shipped recipes lose their dead keys: `claude-export-revive.json`'s
  `mcplServers` (now `mcpServers`), `mcpl-editor-test.json`'s `modules.files`
  (now `workspace: false`) and its hybrid Sonnet model id (now
  `claude-sonnet-4-6`); `knowledge-miner.json`'s description no longer
  advertises the Notion and audio/video sources 0.8.0 removed (#167).

- With reasoning enabled, requests to models that do not support adaptive
  thinking (Haiku 4.5, Sonnet 4.5, Opus 4.5 and older) no longer carry
  `thinking: { type: 'adaptive' }` and 400. The setting is host-wide, so
  RetrievalModule's default Haiku calls were failing on every compile.
  Those models are logged once and sent without `thinking`.

- Per-agent token counts now count each provider call once. agent-framework's
  `inference:usage` sample is the stream's running total (membrane sums every
  call so far), and `inference:completed` carries the total again, but the
  agent tree added every sample and the completion. So a multi-call stream's
  earlier calls were counted again with each later sample and once more at
  completion. This affected the Web UI sidebar's `out` badges, the parent's
  included, since it sums its agents, and the Usage panel's per-agent and
  breakdown rows. The session totals (the TUI's `Σ` and the Usage panel's
  parent row) and the call ledger don't come from these samples, so they don't
  change.
- Context-size readouts show the latest call's prompt: its fresh input plus
  its cache reads and writes. That sum holds for a provider adapter that
  declares its cache convention; membrane passes an `unknown` adapter's
  counts through as they come, and where that input already includes the
  cached span (Gemini's very likely does), a cache hit reads high. They had
  shown the stream's summed fresh input, which is neither one call's prompt
  nor the context size. This covers the TUI's `ctx:N/budget` gauge and
  per-agent `…ctx`, the Web UI sidebar's `…cx`, a finished subagent's context
  size, and an agent's `input` in the Usage panel. That `input` is the
  agent's own context, plus its subagents' for an agent that has them, since
  the panel sums a subtree. While a call streams, a local agent's `…ctx` in
  the TUI still adds an estimate of the output streamed so far.

- Batch mode (stdin not a TTY, no `--headless`) now says what it is doing: a
  `[batch]` line at the start says the run ends when stdin closes and names
  `--headless` as the way to keep serving, and a line before the teardown
  names the MCPL servers it closes. Each server's `mcpl-stderr` log gets a
  `[host] closing: batch run complete` line ahead of its `connection closed`.
  When the web UI is on, a last line says it stays up with the agent stopped.
- Batch runs exit as soon as they finish. The 120 s cap on waiting for each
  reply was never cleared, so the process lingered for two minutes after
  `Done.`.

- llm-calls records from the Anthropic and Bedrock paths bound a failed call's error text as the generic logging wrapper's records do, so a provider error that echoes the whole rejected request no longer writes it into the record a second time beside the raw request. The `error` object keeps its shape: `name`, cut at 128 characters; `message`, cut at 4,000 to its head and tail around a marker stating the omission; and on the Anthropic path `stack`, whose header names the message above instead of repeating it when that header is the error's own "Name: message" line, and which is cut at 4,000 as well. `errorChars` gives the whole message's length when it was cut. For an `Error` carrying them, the provider's classification (`errorType`, `httpStatus`, `providerErrorCode`, `retryable`) sits beside it. On the Anthropic path the call ledger's ERROR cause, live and restored after a restart, reads this same bounded message, and a failure whose message is empty is an ERROR too, where the ledger used to price it as a success. The ledger's live row also takes its model, message count and cache summary from the record's request summary, which a row restored after a restart reads too.
- Logging on these two paths no longer changes what a call returns or throws. It runs after the provider call, outside its try, and neither reading a hostile error nor summarizing the request can throw into it. As before, the Anthropic writer's capture hook keeps an error thrown by a caller's own `onRequest` hook from failing the call. On the Anthropic path the request summary leaves out only a part it can't read. A record that can't be built even so gets a minimal record (`summaryUnavailable: true`) with its kind and timing, and for a failure its bounded error, so the call still has a record: on the Anthropic path that's a call whose response can't be read, and on the Bedrock path one whose request or response can't be summarized. A rejection with `undefined` is recorded as the failure it is, and on the Anthropic path it reaches the credential monitor and the call ledger as one.

- The web console's context curve panel now compiles the resident's context as a dry run. The compile is only displayed, never sent, so its select no longer commits fold resolutions or queues compression from the plan each time the panel renders, mid-stream included. Once context-manager's thinking binding is released, a committed compile that's never sent would also fence the replies the resident is streaming, and a dry run won't. With context-manager 0.13, a dry compile still records the adaptive estimate, arms calibration and overwrites the render stats until the next real compile; context-manager #161 removes these. Like any hold query, it releases a compression hold whose deadline has passed, never one that hasn't.
- When the context's plan is over budget at the plan check, the curve now plots it and says it's over budget, with the verdict the settings panel's feasibility preview reports: whether the plan fits, and whether the next real compile would refuse it. During a paced budget descent the curve and its verdict are at the descent's target, and the page says so rather than predicting the next compile. It used to fail to load. A budget too small for the head and tail reservations, or a plan the emission check finds over, still fails the panel, as before.
- `FrontdeskStrategy` passes its select options through to the autobiographical select, so a dry run (a preview, the context curve) is no longer run as a committing one for frontdesk agents.

- The context curve page gives a summary's first and last dates by time. It used to order them by their text, weekday first, so a summary of a Wednesday's and a Friday's messages showed the Friday as its first date.

- `llm-calls` error records from the generic logging wrapper bound their error text to 4,000 characters. That wrapper serves the `openai-responses`, `openai-compatible`, `openai-codex`, `openrouter` and `mock` providers; `anthropic` and `bedrock` log through their own classes, whose records are bounded by a separate entry. The text is cut to its head and tail around a marker stating how many of how many characters were omitted, and no surrogate pair of well-formed text is split. A provider can echo the whole rejected request in its error body (one OpenAI-compatible 400 echoed ~1.7 MB), and the record already keeps that request as `rawRequest`, except when the record is over the 16 MiB size guard, which drops the raw bodies and keeps the bounded text. When the error is an `Error` carrying them, a record now also carries `errorType`, `httpStatus`, `providerErrorCode` and `retryable`, plus `errorChars` when the text was cut; `errorType` and `providerErrorCode` are cut the same way at 128 characters. A small error's text is recorded byte for byte as before.
- An error whose fields cannot be read (a throwing getter) no longer makes the wrapper throw the getter's error in place of the provider's. Each field is read on its own: an unreadable `message` is recorded as `[message could not be read]` after the error's name, keeping the classification; an unreadable or wrongly typed classification field is left out, keeping the text; and a value that cannot be read at all, such as a revoked Proxy, is recorded as `[error could not be read]`. The original error is always rethrown.
- Logging no longer changes what a successful call returns. A record that couldn't be built used to replace the provider's response with the logging error, and to be written as an error. Now a call whose request or response can't be summarized gets a minimal record (`summaryUnavailable: true`) with its provider, kind and timing, and for a failure its bounded error, so no call goes unrecorded. A null block or tool is summarized rather than thrown on. A rejection with `undefined` is recorded as an error, not as a successful call, and a record whose raw bodies can't be serialized (a cycle, a BigInt) is written without them, as for the size guard.

- `postinstall` now reports a failed optional Web UI build. It used to end with `|| true`, so when `npm --prefix web install` or `run build` failed, the install succeeded and the host added nothing to npm's own output: no summary of the failure and no retry command. The install still succeeds (exit 0), but the script now reports the failure on stderr, naming the retry command (`npm run build:web`). It does not claim what the Web UI will do: a bundle from an earlier build may still be in place, so whether one is missing is reported at start. Without a `web/` directory it stays silent, and a working build prints nothing extra.
- The host also says once at start, on stderr, when an enabled Web UI finds no bundle at its resolved path. That covers a build that was skipped rather than failed (for example `--ignore-scripts`). The page keeps its 503 and its remedy.

- Fleet preserves unresolved launch artifacts and recovers matching tracked children only after confirmed PID death, bounded regular PID metadata, and an absent or refusing Unix socket with artifact identity rechecks. Fresh parents without a record still refuse cleanup. Adopted restart records confirmed death without inventing an exit code, honors SIGKILL wait failure, and failed adoption can be retried on boot, launch, or restart. Refusals name artifact paths and existing recovery operations. Confirmed terminal records are never adopted solely because their old PID is live again. These checks do not provide cross-process locking.
- Stale Unix socket probes use the existing Node.js prerequisite to retain native errors; Bun versions that normalize resource errors cannot authorize cleanup. Missing Node, timeout, and spawn errors preserve artifacts.

- Fleet manual restarts preserve environment overrides, autoRestart, and subscriptions. Failed socket setup, subscription, or readiness now terminates the owned child before returning failure; unconfirmed termination stays blocked and is reported explicitly. The record's `exitReason` keeps the launch failure beside the exit, whichever came first.
- Fleet automatic replacements retain crash history, advance the existing backoff, and stop after three retries within 60 seconds, where a crash-looping child used to be replaced forever. `fleet--status` shows the stop as `autoRestartStopped`. A manual restart, or a launch of the same name, resets that retry budget, and kill, restart, launch or shutdown cancels a pending automatic replacement; a manual restart or launch also cancels one under way that hasn't spawned, and one refused later leaves the child down, which `autoRestartStopped` says. A signal exit, including a start the parent has to stop, isn't retried, as before, and `autoRestartStopped` now says so, as it does for a kill; a replacement that exits non-zero on its own is retried up to the cap.
- Fleet launches, manual and automatic, are refused without spawning when the parent is shutting down, or when, during their awaits, it begins to, a kill is acknowledged on the generation they replace (a restart counts from its own start), or another launch replaces it. The refusal names which. A launch adopting a living child that is interrupted stops that child instead of leaving it unowned, unless the parent is detaching, and a second launch of the name is refused meanwhile. A detaching shutdown no longer kills a child that is still starting.
- Fleet restarts also work for adopted children after confirmed shutdown. Startup tolerates transient stale-socket refusals while the replacement binds, and reports a child that exits after a refused connect with that refusal. A natural nonzero exit racing failed-launch cleanup retains its automatic retry.

- A headless child stops treating a client as current once its socket ends or
  closes, including a reset with no `end`, such as a parent that died with
  events still unread, and writes no telemetry to a socket that has ended or
  errored. Commands the child reads from a client after a newer client has
  replaced it are dropped: the first is logged, and the client's disconnect
  line counts them. A command admitted while its client was current still
  finishes, with its answers dropped. Both mattered on runtimes with Node's
  socket semantics, such as Bun 1.4.2. There a reset socket stayed current,
  so telemetry kept going to it until the next client connected, and only a
  socket error was logged, never the disconnect. A superseded client's
  `subscribe` replaced the new client's filter, its `text` reached the agent,
  whose output then went to the new client, and its other commands ran, with
  the answers `reply()` sends dropped. Bun 1.3.14 gives a reset socket an
  `end` and closes a superseded socket whole, so neither happened there.
- A fleet parent lets go of a child's socket at its `close` as well as its
  `end`. After a reset with no `end` (on Bun 1.4.2, a child that died with
  the parent's commands unread), the fleet's requests to that child, such as
  `requestDescribe`, report it unreachable instead of writing into the dead
  socket. A spawned child's exit already let go of it; an adopted child has
  no exit event to.

- `identity--request` sends `PATCH`. Its method list, in both the advertised schema and the handler's check, stopped at GET/POST/PUT/DELETE, so a resident's PATCH was refused before it reached the service, and PATCH-only routes such as orrery's node update (starring, archiving, a curator's note) were out of reach. A PATCH carries a JSON `body` or a `fromFile` upload exactly as POST and PUT do. The service allowlist with host-attached access stays the boundary, and each service still authorizes the request.
- `identity--request` refuses a `body` or a `fromFile` with GET, naming the methods that send one. `method` defaults to GET, so a write that left out its method used to be sent as a read, its body dropped, while the call reported success.
- `identity--request` reports an empty response, such as a 204, as `{ status, body: "" }`. It used to describe it as an omitted binary response and advise repeating the request with `saveAs`, which for a write would send it again.

- Makeup panel: an anthropic-xml agent's exact `count_tokens` figure includes the agent's `prefillUserMessage` where inference sends it: first, in place of the formatter's default opener, whenever the request would otherwise open with the assistant's turn, as a prefill transcript usually does. The count used to carry that default instead (`[Start]`, or for an agent with no system prompt, the CLI-simulation system block and its `<cmd>` pair).

- Makeup panel: the exact `count_tokens` figure now counts the request the agent's own formatter would send — built through `buildMessages` (participant prefixes where the formatter places them, tool-pair normalization, same-role merging, native tools) so every block the formatter sends counts, which for the native formatter includes signed `thinking` / `redacted_thinking`, `tool_use`, `tool_result` and images — instead of a text-only flattening that omitted most of a keep-all model's prompt (read up to ~10× below billed). The response also carries `lastBilledInputTokens`: the provider's fresh + cache-read + cache-creation total of the agent's last call, a free exact reading that needs no request.

- A server deployed with `mcpl_deploy` now gets the environment every boot-loaded server gets. That includes the refusal-reaction baseline, `DISCORD_SUPPRESSED_REACTIONS_BASELINE`, as a default its own env can override, which a deployed Discord adapter used to start without.
- `mcpl_deploy` judges each field as given, and refuses a wrong kind with nothing saved, where it used to drop or coerce it: an `env` given as text, a number or true/false, `args` that weren't a list, a `toolPrefix`, `token` or `access` that wasn't text, a `reconnect` that wasn't true or false, or a tool or feature-set list given as text all vanished, and a `null` arg was saved as `"null"`. A field left out, `null`, `""` (or only spaces) for text, or `[]` for a list is unspecified, as strict function calling sends it, so an empty or blank `toolPrefix` is no longer saved for the framework to keep in place of its default prefix. A tool or feature-set list holding an empty name, an allow-list that matches nothing, is refused. Numbers and true/false in a list are saved as their text. The id `__proto__` is refused: JavaScript reads it as an object's prototype, so its entry was never saved, though the deploy said it was.
- Saving `mcpl-servers.json` or `mcpl-servers.agent.json` keeps the root's keys besides `mcplServers`, such as an entry under a misspelled key, which every save used to drop, and never overwrites a file that doesn't parse.
- `mcpl_unload` reads the overlay before it disconnects, so a file the boot would stop on refuses the unload with the server still loaded. It disconnects only a server that's listed. An id the overlay alone names has its entry removed, or its tombstone kept, and an operator's server that isn't loaded is tombstoned, each with a receipt saying it wasn't loaded in this session. A disconnect that fails leaves the overlay as it was, and says so. If the overlay can't be read or saved after a disconnect that succeeded, the receipt says the server is gone and nothing was recorded, and unloading it again records it. Deploys, restarts and unloads of one server run one at a time, in the order they're called, so a deploy made while an unload disconnects runs after it and keeps its entry. A session-only unload says what the next host start loads, read from the overlay: a tombstone, the agent's entry, the operator's definition, or nothing. A tombstone for an id the operator defines says how that definition comes back.
- `mcpl_list` no longer labels a recipe server named like an inherited key, such as `constructor`, as a file server.

- `mcpl_deploy` refuses a server that would send a credential over unencrypted `ws://` to a host other than this machine, where anyone on the network between could read it. It recognizes four carriers: the `token` field, the credential an `access` grant attaches, a user or password in the url, and a `token` parameter in the url, the one agent-framework's transport sends. No other query parameter is recognized. A blank token is no credential, but a grant counts whatever its name. The refusal says to use `wss://`, or, if that network is private, to ask the operator to add the server to the recipe, and it says when a server already configured under that id is left as it was. A recipe server like that, or an overlay entry deployed before this change, still loads, with a warning at startup; there a grant counts only when the recipe's identity attaches its credential. This machine is `localhost`, 127.0.0.0/8, `::1`, IPv4-mapped 127.0.0.0/8 addresses, and `0.0.0.0`, `::` and `::ffff:0.0.0.0`. Any other name, `localhost.` and names under `.localhost` included, counts as another machine, since a resolver may not answer it with this one. The tool's `url`, `token` and `access` descriptions say what it takes over `ws://`.

- `mcpl_restart` keeps its overlay note when the restart throws, and an `mcpl-servers.agent.json` that can't be read no longer turns a successful restart into "mcpl_restart failed": the receipt reports the restart, says the file couldn't be read as an overlay and that the next host start will stop on it until it's fixed, and doesn't quote it. When the live server's overlay entry is one the boot skips, the restart's note says so and what the next start loads. For a tombstoned id, it says the overlay keeps the server unloaded and how to bring it back: for an id the operator defines, that's removing the tombstone from the file, since `mcpl_deploy` would load the agent's own entry instead. The overlay-replacement receipts no longer report `AGENT_TIMEZONE`, which the host sets over every server's mapping, as lacking, and they do report a replacement that names a different `access` grant as lacking the operator's, comparing each grant as it's dialled, as written. A token counts as present on either side whenever agent-framework would send it.
- `mcpl-servers.agent.json` entries are read the same way by the boot, the startup warnings, `mcpl_list`, `mcpl_restart` and `mcpl_unload`. The boot passes each entry to agent-framework as it did before, except where the old handling broke, and the startup log names each such place: `args` holding numbers or true/false read as their text, where the start used to stop; a tool or feature-set list given as one name reads as a list of one, where it used to be read character by character, so a one-name deny list denied nothing; a capability list given as one name, which used to be ignored, does too; a `toolPrefix` that's a number or true/false reads as its text, and one that's an object or a list as absent, so calls to the server's tools reach it; and a capability that can't be read as text denies nothing, where the start used to stop. The log also names a `transport` other than `stdio` or `websocket`, which agent-framework ignores, and an entry its transport can't open, a websocket one with no `url` or a stdio one with no `command`, which still replaces any operator definition, as before.
- `disabled: true` tombstones a server whatever else its entry holds; the agent's unload wins. The boot skips an entry that isn't an object, has `args` that aren't a list of text, numbers or true/false, names neither a `command` nor a `url`, or has a `disabled` that's truthy but not `true`. It logs why, and loads the operator's definition, if any. Two of these used to stop the host from starting: a `null` entry, and `args` that aren't a list of text. The others were skipped without a word. `mcpl_list` names a skipped entry as malformed, and no receipt counts it as replacing anything. For an id the operator defines, the advice says that `mcpl_unload` tombstones the operator's server, which the boot loaded in the entry's place. `mcpl_list` no longer calls a server unloaded while it's still connected under a tombstone written since it started.
- `mcpl_deploy` refuses an `env` that isn't a map of text, numbers or true/false, saving nothing, where a `null` env value used to be saved before the deploy threw. An empty list as `env`, which strict function calling sends for "unspecified", deploys with no env.
- A file that isn't valid JSON, or whose root is `null`, still stops the start, now with an error naming the file and advising a fix: moving it aside would load every server the agent unloaded. Every other root and `mcplServers` starts the host as before. A root that isn't an object, or an `mcplServers` that's text, a number or true/false, loads nothing, and an `mcplServers` that's a list holds its items as entries named by position; the startup log names each. It also names keys besides `mcplServers`, since a misspelled key would drop the agent's tombstones. `mcpl_unload` reads the file again after its disconnect, so an entry another call wrote meanwhile for another id isn't lost, and an inherited name such as `constructor` is no longer taken for an entry.
- A replacement whose `access` names a host variable is named, as one whose `token` does. `mcpl_restart`'s note on a replacing entry says that it describes the file as it is now, since the restart reconnects with the configuration of the server's last connect: a hand edit made since then takes effect at the next host start, unless a later `mcpl_deploy` replaces it. The receipts read an entry by the connection agent-framework opens for it, which an explicit `transport` decides. `mcpl_list`'s source label reads the overlay file as it is now, and its target label is a server's command, else its url, as before, since agent-framework's status doesn't say which of the two it opened.

- **`mcpl_restart` and `mcpl_deploy` no longer report a server as working when it isn't, and the MCPL admin receipts say what an agent-overlay entry doesn't carry.**
  - Both now fail when the server isn't connected afterwards. Before, a restart reported success while its own text read "NOT connected", and a deploy said "connected" without checking. A WebSocket server whose first dial fails comes back as a stub that keeps retrying, without the call throwing, so either could happen.
  - An agent-overlay entry under the id of a recipe or `mcpl-servers.json` server replaces that definition whole: its text is literal, and it never inherits the host environment. So the operator's value for anything the entry doesn't declare never reaches the server. A stdio child gets the entry's own env, plus the host's values for a short allowlist such as `PATH` and `HOME`. A server that needs the operator's value can look healthy until its first call. `mcpl_deploy`, `mcpl_restart` and `mcpl_list` now say when a server runs such a replacement, and name what it lacks: env names (never values), a token, an `access` grant, or `inheritEnv`. `mcpl_unload` of a replacement says the operator's definition loads again at the next start.
  - A `${VAR}` reference in an overlay entry reaches the server as literal text, since only a recipe substitutes it. `mcpl_deploy` and `mcpl_restart` now say which parts of an entry name a host variable, and a replacement's env value that names one counts as lacking.
  - The host logs both at startup.

- Operator ledger: price `claude-opus-5`, which matched no prefix in the rate
  table and so showed no cost at all — every call on it, including subagents
  spawned at the Opus-tier default, priced as nothing.
- Operator ledger: charge Claude Fable 5.1 and Claude Mythos 5.1 cache reads
  at 0.025x base input ($0.25/MTok) instead of the 0.1x every other model uses. A long-lived agent
  that re-reads a large cached prefix on every call spends most of its bill on
  cache reads, so the flat multiplier overstated its total several-fold. Cache
  reads on all other models, and input, output, and cache writes on the 5.1
  pair, are unchanged.
- Operator ledger: price Claude Sonnet 5 at $2/$10 for every call. The table
  still switched it to $3/$15 on 2026-09-01, but that scheduled increase was
  withdrawn and the introductory rate became the standard one, so every
  Sonnet 5 call since September 1 was overstated by half.
- `ANTHROPIC_PRICING_VERSION` moves to `anthropic-public-2026-09-21`, so
  replayed JSONL is re-priced under a version string that says which table
  produced it.

- A saved reasoning setting the API would reject (for example `effort: "minimal"` or an unknown `display`) no longer fails every turn: invalid values fall back to their defaults when settings are restored, with a log line, and the adapter never sends an effort level outside the known set.

- WebUI: the rollback / suppress row actions now sit inside the message row
  (top-right, labelled) instead of hanging off its left edge, where the
  scroll pane's overflow clipping made them nearly invisible; the Context
  document's "roll back to here" is faintly visible before hover. The static
  server now sends `Cache-Control: no-cache` for `index.html` and
  `immutable` for hashed `assets/`, so a stale tab can no longer pin an old
  index/bundle pair across a bundle swap.
- **Recipe authors using `kv-unified`:** `agent.strategy.kvUnified.preserveGapBearingSummaries` must now be an explicit boolean, and cannot be `true` together with `treeifyNonContiguousSummaries`. Add the flag to older recipes. Both requirements already apply in context-manager; invalid configurations now fail at recipe load instead of the first solve. Valid explicit policies and other folding strategies are unchanged.
- MCPL server definitions in `mcpl-servers.json` now preserve `inheritEnv`, and recipes can override it (including explicit `false`) for file-defined servers. Recipes and server files reject non-boolean values. Agent-owned overlays strip `inheritEnv` entirely, including when replacing an operator-defined server; full host-environment access is an operator grant. Full environment inheritance requires an agent-framework version containing its PR #175; the host's locked 0.19.0 predates that control and remains unchanged.

## 0.9.0 — 2026-09-21

### Added

- Recipes can set **`modules.history: true`** to attach agent-framework's
  `HistoryModule` (agent-framework 0.16.0): `history--stats` / `history--extract`
  / `history--search` / `history--overview` tools for querying an agent's own
  uncompressed chronicle via native secondary indexes, and for browsing
  already-compressed spans via existing compression summaries (no new LLM
  calls). `bind()` is wired post-creation with the agent's live
  `ContextManager` and the framework's `ChannelRegistry` (when MCPL is
  configured), so channel-filter arguments on all four tools accept a live or
  historical channel label/address, not just the raw internal channel id.
  Bumps `@animalabs/agent-framework` to `^0.16.0` and
  `@animalabs/context-manager` to `^0.10.0` (both required for `HistoryModule`
  and its summary-overview support) and `@animalabs/chronicle` to `^0.4.0`
  (native secondary-index support the history tools depend on).

- Recipes can set **`agent.retry`** (Membrane's retry policy, passed through
  verbatim) and **`mcpServers.<id>.requestTimeoutMs`** (the framework's
  per-server JSON-RPC timeout). Both knobs existed underneath — Membrane's
  `MembraneConfig.retry` and `McplServerConfig.requestTimeoutMs` — but the host
  never surfaced them, so a gateway 502 killed a turn on first failure
  (Membrane retries generic retryable errors zero times by default; only
  `529`/`overloaded_error` has a dedicated schedule) and a tool slower than the
  60s default (image generation) could only ever time out. Both validate at
  recipe-load time.

- Subscription hosts (Claude OAuth token via `ANTHROPIC_AUTH_TOKEN`, Codex
  login via `openai-codex`) show quota windows instead of a dollar estimate:
  the TUI status line and the WebUI header read `10% weekly | 99% 5h`, one
  entry per window the provider reports (5-hour, weekly, per-model weekly),
  and the WebUI usage panel lists each window with its reset time.
  List-price dollars were fiction on a subscription. Pay-per-token hosts are
  unchanged.
  - The windows are polled out-of-band (no inference spend) by a new
    `QuotaMeter`: the TUI polls while it runs, the WebUI only while its tab
    is visible and focused (`GET /quota`, panel op `quota`, observer scope
    `health`), floored at one provider read per 30s however many viewers.
  - A 429 while a window is spent is now recognised as a quota, not a
    throttle: the agent parks until the window resets instead of retrying
    into it and recording a failed turn per attempt. Needs an
    agent-framework with `providerHold`; on older frameworks the option is
    inert and behaviour is as before.
  - Both provider surfaces are private to the vendors' own CLIs and may
    change; an unreadable answer shows no readout rather than a guess.

- WebUI live surgery, quiesce toggle, inline images, operator log
  (requires agent-framework with `rollbackToMessage`/`suppressMessages`;
  quiesce needs agent-framework #122 — every affordance is feature-detected
  from `welcome.features`, so the bundle is safe against older hosts):
  - **Roll back to a message** (hover ⏪ in Chat, "roll back to here" on raw
    boxes in the Context document): forks at that message and makes the fork
    the live branch; confirm dialog names what leaves the context.
  - **Suppress messages** (hover ⊘ enters multi-select, floating bar to
    confirm): fork at head, redact on the fork, switch. Parent keeps them.
  - **Quiesce/resume** header switch showing the host's serving state; a
    busy-agent refusal offers "quiesce, then retry".
  - **Images render** in Chat and Context views with a lightbox. Chat frames
    carry a `ref` and the browser fetches bytes lazily from
    `GET /media/<messageId>/<blockPath>` (observer scope `messages`,
    `?scope=` proxies to fleet children) — base64 never rides the WebSocket.
    Tool-result images (read_image, cameras) render too.
  - **Operator log** in the branch panel: the host's durable
    `operator-actions.jsonl`, live-refreshed on `operator:action` traces.
  - New WS frames: `rollback`, `suppress`, `host-quiesce`, `host-resume`,
    `request-host-mode`, `request-operator-log` → `surgery-result`,
    `host-mode`, `operator-log`; `welcome.features` + `welcome.hostMode`.
    Panel op `media`.

### Changed

- Depends on `@animalabs/agent-framework` ^0.17.0, `@animalabs/context-manager`
  ^0.10.1 and `@animalabs/membrane` ^0.5.86. With AF 0.17 the quota meter's
  `providerHold` is live: a subscription 429 on a spent quota window parks the
  agent until the window resets instead of retrying into it (older AF ignored
  the option). CM 0.10.1 carries the kv-unified stale-receipt fix (CM #97);
  membrane 0.5.86 makes the ChatGPT-subscription prompt cache hit (stable
  `session_id` header). `package-lock.json` had drifted to AF 0.13 / CM 0.8 /
  chronicle 0.3 and is regenerated alongside `bun.lock`.

- The `frontdesk` strategy no longer adds its provenance header to a message
  whose server already rendered who, where, when and the id into the body
  (metadata `attributed: true`, as zulip-mcp now stamps); its question and
  mention salience scans the body with the server's `attributionHeader`
  prefix removed. Unstamped MCPL messages keep the header. Without this, a
  frontdesk agent on a current zulip-mcp reads two headers per message.

- Route ChatGPT subscription inference through Membrane's shared Responses adapter, preserving Codex app-server login, token refresh, endpoint configuration, and Fast mode controls in the host. Provider usage now declares the cache-inclusive convention and is normalized by Membrane.
- Preserve cache-usage and formatter capabilities through the logging decorator, fixing duplicate cached-input accounting for both subscription and API-key Responses calls. Keep participant names in auxiliary calls and mark logged usage with its convention while retaining the `openai-codex` provider label.
- Serialize a forced Codex token refresh behind any in-flight non-refresh acquisition, coalescing concurrent refresh callers without reusing a stale token.

- README documents `agent.proseRouting` (`locus` / `hybrid` / `explicit` /
  `disabled`) and `agent.sameRoundThinkTextPolicy`, and recommends
  `proseRouting: "disabled"` for tool-heavy agents woken from shared channels,
  where stray same-round narration otherwise auto-publishes to the sticky
  channel (#128).

### Fixed

- Subscription quota meter, review follow-up:
  - the meter no longer stops polling after consecutive failed reads (a
    timer tick suppressed by the error backoff left no timer armed — two
    failures froze the TUI readout for the life of the process);
  - the WebUI keeps asking after a transient `/quota` failure (401 before
    the observer session exists, 503 while the host binds, 5xx); only a
    definite answer ends the polling;
  - "inference parked" is shown only when the framework reports a host
    hold; a spent window otherwise reads "quota window spent — resets …";
  - the usage panel of a fleet child reads that child's own quota
    (`/quota?scope=`), so a pay-per-token child keeps its dollars;
  - the hold uses the failing agent's own model when the framework supplies
    it; a spent window with no reset time holds one slice on a fresh
    reading; numeric `resets_at` and Codex `rateLimitsByLimitId.codex` are
    parsed; per-agent dollars are hidden and call-ledger dollars labelled
    as list-price equivalents on a subscription; a TUI session switch no
    longer brings the dollar readout back.

## 0.8.1 — 2026-09-10

### Added

- Recipe `subconscious` block (tune-out, agent-framework#77): `enabled`,
  `systemPrompt` (required — the subconscious's mode block), optional `name`,
  `model`, `allowChannelSpeech`, `reAnchorFraction`. Validated at recipe load
  (unknown fields refused by name) and passed through verbatim to
  `FrameworkConfig.subconscious`; the framework owns the defaults. Requires
  agent-framework with tune-out (#115).

- Add validated recipe plumbing for Agent Framework's default-off `agent.toolWrapperProseGuard` containment boundary.

### Changed

- Gate telemetry reads `x-gate-channel` from the turn's routing locus or,
  for gate-batched wakes that set none, from the framework's telemetry-only
  `wakeChannelId` (agent-framework ≥0.14). On residents with a subconscious
  the stamp now follows the primary (the exactly-one-agent guard had
  silenced it), and — because one provider adapter serves every agent — the
  origin trio is stamped only while the primary is the only agent with a
  turn in flight; overlap withholds rather than misattributes. Compression
  debt is read from the primary as well.

### Fixed

- Recipes' `agent.strategy.mergeMaxSourceSpanMessages` now reaches the Context
  Manager (it was accepted but never passed through, so the CM default applied
  regardless of the recipe). Also plumbs and validates the Context Manager's
  `compressionSplitFallback`, `compressionSplitPlaceholder`,
  `compressionSplitMaxCallsPerChunk` and `compressionSplitMaxCallsPer10Min`
  keys (all default off / CM defaults).

- Gate telemetry classifies EventGate-batched wakes (`gate:debounce`, source
  `gate`) as origin `event` instead of passing the raw reason through.

- Name-taking commands (`/checkpoint`, `/restore`, `/checkout`,
  `/session switch`, `/session delete`) parse the rest of the line instead of
  only the first token, so multi-word names round-trip with
  `/session rename` instead of silently truncating (`/checkpoint my test
  point` used to save a checkpoint named `my`).
- `/session delete` requires `--confirm`: the bare command echoes exactly
  which session matched (name, id, message count) before anything
  irreversible happens. `/help` documents that switch/delete accept ids.
- Head-moving commands (`/undo`, `/redo`, `/checkout`, `/restore`,
  `/branchto`, `/newtopic`) are refused while a turn is in flight — moving
  the head mid-stream committed the streaming reply onto the wrong branch,
  detached from its request (orphaned Chronicle nodes), including when the
  move came from a second client on the same session.
- `/mcp add` on an existing server preserves its env vars and `toolPrefix`
  (and reports the kept env keys); previously a command update silently
  wiped the server's env, which only surfaced when the server next started
  without its tokens.
- Checkpoints are visible: `/branches` lists them alongside branches, and
  bare `/checkpoint` lists existing checkpoints (matching bare `/restore`).
- `/budget` displays small values exactly instead of flooring to `0k`
  (`/budget 50` used to report "set to 0k" while rejecting `/budget 0`).
- `/clear` clears the WebUI transcript view (client-side, like the TUI's
  scrollback wipe) instead of appending a "(cleared)" line while clearing
  nothing; `/help` and the headless reply now say what `/clear` actually
  does — display only, history and context kept.

- The WebUI HTTP surface answers honestly: unknown `/debug/*` paths (typos,
  casing, trailing slashes) return a JSON 404 instead of the SPA shell with
  a 200; missing `/assets/*` files return 404 instead of HTML (which
  produced a blank page with a MIME error on stale bundle hashes); non-GET
  methods get 405 with an `Allow` header. SPA client-side routes still fall
  back to the shell.
- The context-makeup panel's exact token count calls `count_tokens` with the
  model the agent actually runs (provider/Bedrock prefixes normalized away)
  instead of a hardcoded id that 404'd on every install and silently nulled
  `exactTotalTokens`. `COUNT_TOKENS_MODEL` remains as an explicit override;
  non-Anthropic models report `count_tokens_unsupported_model` instead of
  counting against the wrong tokenizer.

## 0.8.0 — 2026-09-05

### Added

- Recipes accept `agent.proseRouting: "disabled"` for tool-only external publication when paired with a supporting Agent Framework release.
- **`modules.instructions`** — a shared living-instructions file (a CLAUDE.md
  analogue kept in a workspace mount) injected into every agent's context on
  every turn, ephemeral subagents included. `true` for defaults
  (`instructions/AGENTS.md`, 32 KB cap, `system` position) or
  `{ path, header, maxBytes, position }`. Reads resolve through the workspace
  mount (scoping + traversal guard apply), are bounded to `maxBytes`, reject
  symlinks leading outside the mount (realpath containment), are cached by
  `(realpath, mtime, size)`, and fail open — a missing file never blocks
  inference. Recipe validation cross-checks the path's mount prefix against
  the effective workspace mounts (explicit and implicit alike) at load time,
  requires `autoMaterialize: true` on a read-write instructions mount so
  agent curation edits actually reach the disk-side injection, and rejects
  the host-managed `_config` mount (it materializes only on branch-changing
  commands). Validation and the runtime share one mount builder
  (`src/workspace-mounts.ts`), so the two cannot drift.

- Recipes accept the default-off `agent.strategy.compressionSourceOnly` flag and pass it through to Context Manager's residence-scoped L1 compression request builder (#103).

- Gate telemetry stamps why the turn fired: `x-gate-origin` (heartbeat |
  event | mail | operator | raw reason), `x-gate-channel` and
  `x-gate-counterparty` (adapter-namespaced ids, never content or display
  names) ride the stream lane under the same `GATE_TELEMETRY=1` + base-URL
  gate as the debt stamp; background calls on the complete lane carry debt
  only (#113).

- Gate-bound Anthropic calls carry an `x-gate-debt-chunks` header with the
  live compression-debt pending-chunk count (membrane `dynamicHeaders`,
  antra-tess/membrane#65) — the gateway records it per ledger row and strips
  it before the vendor. Double-gated on `GATE_TELEMETRY=1` AND a configured
  `ANTHROPIC_BASE_URL`, so the stamp can never reach a vendor endpoint;
  unreadable state sends no header rather than a guess (#109).

- Health tab renders the per-agent compression-debt reduction (state, pending
  chunks, oldest age, merge queue) and says "not reported by this stack" when
  absent — the queue is now distinct from context composition, and the top
  line reads "inference queued" (#110).

- Add complete fail-closed recipe validation and strategy passthrough for `foldingStrategy: "kv-unified"`; partial policies, invalid occupancy bands, unsafe approximation grids, and implicit treeification are rejected at load time.

- **`agent.provider: 'openai-compatible'`** — run an agent against any
  OpenAI chat-completions endpoint (Ollama, vLLM, Together, Groq, NanoGPT,
  ...) via membrane's existing `OpenAICompatibleAdapter`, which no host ever
  wired. The recipe names the endpoint (`agent.baseUrl`, validated as an
  absolute http(s) URL at load) and the model (required — no default for an
  arbitrary endpoint); the key comes from `OPENAI_COMPATIBLE_API_KEY`
  only (no `OPENAI_API_KEY` fallback — `baseUrl` is recipe-controlled, so a
  fallback would silently send a real OpenAI credential to an arbitrary
  endpoint) and may be absent for local servers.
  `agent.baseUrl` with any other provider is rejected at load time.

- Recipes can pass the Context Manager source-only compression controls through Host/FKM, including the new default-off L1 and merge final-fallback modes, with boolean validation and cross-agent isolation.

### Added

- **`agent.cacheKeepalive` — hold an idle agent's 1h prompt cache warm.** With
  `cacheTtl: "1h"`, an idle agent's cached prefix expires after an hour and its
  next wake pays a **2x cache write** over the entire context. Reading an entry
  restarts its clock, so membrane now replays the last request with
  `max_tokens: 0` (prefill only) to refresh it at cache-**read** price (0.1x).
  On by default for the anthropic provider; `{ "enabled": false }` opts out.
  - **Cost is proportional to actual idleness, not to `maxIdleHours`.** A poke
    fires only when the entry is genuinely near expiry, so a busy agent never
    fires one — its own traffic already refreshed the TTL. Measured on mythos
    llm-calls over 36h: 563 of 637 gaps were under 5 minutes, only 5 exceeded
    1h.
  - Knobs: `maxIdleHours` (default 24, measured from the last **real** request
    so pokes cannot extend their own mandate) and `refreshAfterMinutes`
    (default 45). Recipe validation **rejects `refreshAfterMinutes >= the cache
    TTL`** — such a keepalive always fires after the entry has already expired,
    paying a full cache write on every poke while still looking like a healthy
    successful call.
  - Events land in `service-stderr.log`, warn-level for `ineffective` and
    `disabled`, so a background spender is legible without opening a billing
    dashboard.
  - Sizing, from fable-cm's 11-day log (~500k-token prefix): 49.7M tokens of
    `cache_creation` landed on turns following a >1h idle gap — ~$944 of write
    premium at fable-5 rates that this converts to ~$308 of reads.

- **`provider: "mock"` — run the whole host with zero provider spend and no
  credentials.** Wires membrane's existing `MockAdapter` (previously
  unreachable from any recipe) as a first-class provider: echoes the last
  user message by default, or returns `agent.mock.defaultResponse` with
  `agent.mock.echoMode: false` for deterministic scripted output. No API
  key is required or read. Mock calls still ride the generic logging
  decorator, so `llm-calls.*.jsonl` receipts work exactly as they do for
  real providers. `recipes/mock-test.json` is a ready-made offline smoke
  recipe (loopback webui, everything else off).

### Added

- **Hybrid prose routing.** Recipes may set `agent.proseRouting: "hybrid"`: unprefixed text keeps ordinary frozen-locus delivery, while a leading `>>>destination` publication envelope routes through Agent Framework’s existing authorized cross-surface resolver. Source text retains the envelope; recipients see only the body; success/failure returns to resident context.

- **`conversations` recipe block — per-channel conversation forks.** Maps to
  agent-framework's `ConversationRouter`: the recipe's agent becomes a dormant
  trunk template, and qualifying incoming channel messages spawn per-channel
  fork agents seeded from the trunk's current context. Recipe surface: `bind` /
  `trigger` rules per channel kind (`dm`/`groupDm`/`channel`), `idleTtlMs`
  (default 12h), `closurePrompt`, and `agentPrefix`. The host fills
  `templateAgent` from the recipe and creates a fresh stateful strategy instance
  for each fork. Absent block means no routing and no behavior change.

- **Protective reaction-suppression baseline for Discord adapters.** Stdio
  MCPL children now receive `DISCORD_SUPPRESSED_REACTIONS_BASELINE` — the
  agent-framework's exported refusal-annotation set (`REFUSAL_REACTION_BASELINE`,
  comma-joined) — so a never-configured Discord adapter defaults to
  suppressing exactly the markers this host's framework stamps, instead of
  defaulting to nothing. An operator-set value on the server entry
  supersedes the house baseline, and the adapter's own precedence (filters-file
  key including explicit `[]` → legacy operator env → baseline) governs
  enforcement; lost configuration stays stale rather than re-defaulting.
  Requires an agent-framework release carrying the `REFUSAL_REACTION_BASELINE`
  export.

- **Standing autobiographical production target.** Recipes may set `agent.strategy.productionBudgetTokens` to keep the summary forest deep enough for a later live context-budget descent without a fold storm. This is a context-token target passed through to Context Manager, not a provider-spend ceiling; omission preserves Context Manager defaults.

- **`mcpl_list` reports manifest freshness.** Each loaded server now shows the
  last validated manifest revision plus fetch and grant-negotiation timestamps.
  Older Agent Framework versions remain legible as `manifest=unknown`, and the
  server-authored revision is quoted and bounded before reaching model-facing
  text.

- **`BEDROCK_BASE_URL` env hook** for the bedrock provider — mirrors
  `ANTHROPIC_BASE_URL`, routing bedrock-runtime calls through an inference
  gateway (gate.animalabs.ai/bedrock/<credSet>). The gate reads the agent
  token from the SigV4 Credential (`AWS_ACCESS_KEY_ID` slot), discards the
  client signature, and re-signs with real AWS creds. First user: Princess,
  moved off the first-party Anthropic API (classifier "bio" false-positive
  streak) onto Bedrock Sonnet 4.5 via gate apse1 — needs membrane ≥1dcd4e3
  for `global.` inference-profile id pass-through.

### Changed

- **Dependency floor: agent-framework `^0.10.0`, chronicle `^0.3.0`,
  membrane `^0.5.78`.** af 0.10.0 brings `ConversationRouter` (the
  per-channel conversation-fork machinery this release’s `conversations`
  recipe surface targets, and includes the current `hybrid` prose router) and exports `nudgeAgent`, which `/nudge` has
  called since it landed — on every published af before 0.9.0 that call
  was a guaranteed `TypeError`, so the floor also makes `/nudge` actually
  work. Chronicle `^0.3.0` aligns the whole tree on one chronicle copy
  (previously context-manager `0.6.3` nested its own `0.3.0` next to the
  host's `0.2.x`). Operators: run a clean `npm ci` — a stale
  `node_modules` predating the lock is the known failure mode here.

- **The public triumvirate recipes boot from a fresh clone.**
  `knowledge-miner.json` no longer ships a `syncntn` (Notion) block pointing at
  an org-internal adapter that isn't publicly available — with `NOTION_*` env
  vars unset the block failed recipe load, and with them set it died at spawn
  on the dangling `../syncntn` path. The `scribe` block is dropped for the
  same reason: it hard-required `GEMINI_API_KEY` and a `../scribe-mcp`
  sibling checkout, neither mentioned anywhere in the setup guides — a
  guide-following fresh install always got a crashed miner. Notion and
  Scribe are now add-a-block opt-ins, documented in SETUP.md and
  TRIUMVIRATE-SETUP.md (the miner prompt's tool-name contracts are
  unchanged). `triumvirate.json` declares
  webui Basic-Auth defaulting to `admin`/`admin` (override via
  `WEBUI_USERNAME` / `WEBUI_PASSWORD` in `.env`) instead of bare
  `"webui": true`, which the non-loopback bind guard refuses to start.

- **agent-framework `^0.11.0`** (was `^0.10.0`). Activates `proseRouting:
  "disabled"` for recipes that set it (#100 accepted the key; the runtime now
  implements it — generated prose is never published externally, only explicit
  tools speak), plus AF 0.11's Windows workspace-mount fix and the
  org-acceleration 429 cooldown. Clears the last two standing cross-package
  `tsc` errors — the typecheck is fully clean at this lock.

- Changelog entries now land as per-change fragment files in `changelog.d/`
  (`<slug>.<breaking|added|changed|fixed>.md`), folded into the version
  section at release time — concurrent PRs no longer conflict in
  `CHANGELOG.md`. Editing `## Unreleased` directly still works and is merged
  at the same point.

- **membrane `^0.5.80`** (was `^0.5.78`, lockfile-resolved 0.5.79). Two
  latent cache behaviors the host already configures become ACTIVE with this
  relock: the prompt-cache keepalive (`agent.cacheKeepalive`, on by default —
  previously passed to an adapter version with no such field and silently
  ignored, so idle gaps over the 1h TTL repaid a full cache write on wake)
  and the floating cache marker (incremental prompt caching inside the native
  tool loop, membrane's default-on). Both reduce cost; neither changes
  visible agent behavior. Also clears two of the four standing cross-package
  `tsc` errors (the membrane-typing pair).

- Depend on `@animalabs/agent-framework` ^0.12.0 and `@animalabs/membrane` ^0.5.82 —
  the published versions that implement the active-turn trigger and the
  lane-aware `dynamicHeaders` the wake-cause stamp (#113) relies on; the
  compatibility cast and optional lookup are gone, and an adapter-level test
  proves a stream call carries the origin trio while a complete call carries
  debt only.

### Fixed

- **Prompt-cache keepalive events all go to stderr**, so every one of them lands
  in `service-stderr.log` beside `[inference-refusal]` instead of being split by
  severity across two sinks. Routine `refreshed` events previously went to
  stdout — which the host unit leaves on the journal — so the log an operator
  actually greps showed nothing. Observed on fable-cm 2026-08-23: the keepalive
  refreshed a 523,102-token prefix three times, correctly and with zero cache
  writes, while a monitor tailing `service-stderr.log` reported no activity for
  three hours. A background spender that can't be found in the operator's log is
  indistinguishable from one that never ran.

- Plumb `agent.strategy.compressionRecallBudgetTokens` through recipe validation and Framework strategy construction, with positive-integer validation instead of silently accepting an inert key.

- **Saved recipe snapshots no longer contain resolved secrets.** `loadRecipe`
  substitutes every `${VAR}` — API tokens included — and the host then wrote
  that fully resolved recipe to `$DATA_DIR/.recipe.json` at default file mode:
  plaintext credentials in the exact directory deployments bind-mount and back
  up (found by an external recipe review that verified live tokens in a backed
  up `data/` directory on a production VM). The snapshot now keeps the
  pre-substitution form — `${VAR}` references literal, a URL `systemPrompt`
  kept as the URL — and a resumed session re-runs substitution, validation,
  and the prompt fetch against the *current* environment, so secret rotation
  and remote prompt updates take effect on restart without re-cooking. The
  file is written 0600 and re-chmod'd 0600 on every save. Legacy resolved
  snapshots (no `$unresolved` marker) still load verbatim, with no
  substitution, so a literal `${...}` surviving in prose cannot fail them;
  resuming an unresolved snapshot whose required env var has since disappeared
  fails loudly naming the variable instead of silently starting the default
  recipe.

- **Ephemeral subagents inherit the caller's `proseRouting` mode.** They
  previously always ran AF's `'locus'` default regardless of the recipe, so a
  resident running `proseRouting: "disabled"` still spawned subagents whose
  between-tool-calls prose published live into its open channel as parent
  speech (field-confirmed on a deployed resident, 2026-08-26 — including
  after the recipe adopted `"disabled"`, which reached only the resident).

### Fixed

- **`mcpServers.<id>.source` accepts cook's npm registry form.**
  `validateRecipe` demanded `source.url`, but connectome-cook's source grammar
  also has `{ "npm": "pkg@version" }` — which the shipped knowledge-miner
  recipe uses for its gitlab server, so that recipe failed to load
  (`mcpServers.gitlab.source.url must be a non-empty string`). Exactly one of
  `url` / `npm` is now required; the field remains build-tooling metadata,
  ignored at runtime.

## 0.7.4 — 2026-08-03

### Changed

- **Frontdesk agents ride the adaptive path.** `frontdesk` strategies now
  default to adaptive resolution + kv-stable folding, same as
  `autobiographical` (a recipe can pin `adaptiveResolution: false` to keep the
  old hierarchical renderer). The hierarchical renderer reserves nothing for
  the raw tail and cannot shed summary mass, so a long-lived frontdesk agent
  eventually saturates its fixed context budget into a terminal
  `UncoveredDropError` refusal loop — the 2026-08-03 boter clerk outage.
  Details and deltas:
  - Topic-aware chunking now rides context-manager's `chunkBoundaryHint` seam
    (requires CM ≥0.6.3) instead of a fork of `rebuildChunks` that silently
    bypassed chunk-record persistence and the fail-closed orphan guard.
  - Existing frontdesk stores carry no chunk records (the fork never wrote
    them); context-manager's `migrateChunkRecords` backfills them from L1
    `sourceIds` on first load, so upgraded stores do not re-compress lived
    history. First boot re-plans folds (one-time KV churn, possibly a burst of
    L1 production for the un-summarized frontier).
  - The salience-biased L1 emission order is retired (it was a hierarchical-
    renderer concept); unanswered questions/@mentions are still preserved
    verbatim through the compression prompt.
  - Witnessed chunks now get the base witnessed compression prompt; the fork
    predated witnessed prompts and overrode them.

### Added

- **Every WebUI inspection panel now works per fleet child.** One persistent
  scope dropdown in the sidebar header ("inspecting: …") replaces the
  per-tab pill rows Lessons/Files carried — MCPL, Context, Settings, Pins,
  Health, and the main-pane Context document all follow it, instead of the
  previous split where only Lessons/Files could switch (statefully, via
  duplicated pickers), Context 404'd by mis-sending the child name as an
  `?agent=` param, and MCPL/Settings/Pins/Health were silently locked to the
  fleetmaster. Backed by one generic fleet IPC verb pair
  (`panel-request`/`panel-response`) dispatching into a shared panel layer
  (`src/web/panel-data.ts`) that both the WebUI host and headless children
  run — a new panel op needs no protocol change to work fleet-wide.
  Details:
  - `/debug/context/{,makeup,coverage,curve,preview,maintenance}` and
    `/healthz` accept `?scope=<child>` — the host proxies to the child over
    the fleet IPC and answers with its JSON verbatim (still curl-able;
    connectome-doctor / fleet hub can now watch children through the host).
    `/curve?scope=<child>` passes through to the scoped JSON.
  - The MCPL tab shows the scoped process's **live** loaded servers
    (connection status, tool counts — the long-missing fleet mcpl snapshot)
    above the shared registry file; registry edits stay host-scope (the
    file is one cwd-shared registry, so a "child-local edit" would be a
    lie) and the panel says so instead of hiding the fact.
  - Settings mutations, dry-run previews (single-flight guard now lives in
    the target process), and pin add/remove run inside the scoped child;
    child pins snapshots ship picker candidates (real store ids) since the
    SPA has no window into a child's message store.
  - Scoped WS responses (`lessons-list`, `workspace-*`, `mcpl-list`,
    `settings-state`, `pins-list`) now echo their `scope`, and the SPA
    drops replies that arrive after the operator switched — fixing a
    pre-existing race where a slow child's lessons/files could render under
    another child's header.
  - Child health snapshots include the child's recent provider-call ledger.
- **TUI: context budget gauge.** The status bar's `ctx:` readout and the fleet
  tree's per-agent readouts show `142k/180k` against the *live* runtime budget
  (runtime overrides win over the recipe), and the status segment goes yellow at
  75% / red at 90% — "how close to compression/trouble" at a glance instead of a
  bare number.
- **TUI: fleet view viewport.** The tree now scrolls with the cursor
  (`┈ N lines above/below ┈` markers) instead of clipping past the bottom of the
  terminal — previously a large fleet let the cursor walk below the fold and
  Del:stop targeted rows the operator couldn't see.
- **TUI: fleet view opens with a summary header** — agent counts
  (running/done/failed/cancelled across local subagents *and* fleet children),
  children up/crashed, session cost — plus the active ops alerts in full (the
  status bar only has room for a count).
- **TUI: event timestamps.** Alerts, tool batches, subagent results, wake
  triggers, branch switches, errors and user messages get an `HH:MM` prefix, so
  scrollback read an hour later still answers "when".
- **TUI: root-agent tool completions are visible.** Verbose shows every
  `✓ tool (1.2s)`; terse shows the slow ones (≥2s). Slow *running* tools show a
  live elapsed in the status bar after 5s — "still executing" and "stuck" no
  longer look identical.
- **TUI: the status bar names the worst active alert** (`⚠ 2 ·
  compression-quarantine`), with quarantine and inference-exhausted outranking
  the merely-recent.

### Changed

- **TUI: thinking honors the Ctrl+V verbose toggle.** Terse mode collapses live
  thinking to a counting one-liner (`💭 thinking… ~1.2k tok`) and replayed
  history thinking to one truncated line per block — the toggle's label always
  claimed this.
- **TUI: session-history replay caps at the last 50 messages** (marker points at
  the web UI for the rest) instead of flooding scrollback with the whole session.
- **TUI: elapsed times are humane everywhere** — `5m48s`, not `348s`; the fleet
  tree and both peek views now agree.
- **TUI: peek-proc renders child `ops:alert` events properly** (red `⚠ kind:
  message`, cyan for `-clear`) instead of a dim `· ops:alert` dot line, and no
  longer prints dot lines for per-block/per-round bookkeeping events.
- **TUI: the status-left segment truncates to fit** the terminal width instead of
  shoving the tokens/mem segment off the row.

### Fixed

- `cancel-subagent-result` was missing from the headless runtime's
  subscription-filter exemptions: a parent that narrowed the event stream
  could never see its own cancel confirmations.
- The Vite dev server proxies `/debug`, `/healthz`, `/curve`, and `/files`
  to the running host — previously every HTTP panel fetch 404'd under
  `bun run dev`.
- **TUI: "Branch switched" announcements survive.** The line was printed *before*
  `refreshFromStore()` cleared the scrollbox, so it was destroyed unread.

### Upgrade notes

- **subagents/lessons/retrieval are now opt-in** (they were opt-out, and
  DEFAULT_RECIPE enabled all three). A recipe that omits them ran them under
  v0.7.2 and stops running them on this upgrade — that is the fix for
  "lessons injected despite following the onboarding guide" (Discord issue
  #32) working as intended. A recipe that *explicitly* enables them keeps
  them, deliberately: a defaults change cannot tell old boilerplate from a
  real choice. Before upgrading an existing deployment, run

      bun scripts/audit-module-optins.ts <recipes-and-data-dirs...>

  It reports every explicit enable, every omission that changes behavior,
  and every retrieval-without-lessons combination that would go silently
  inert — and modifies nothing; the decisions stay with the operator.
  Persisted `data/.recipe.json` files are launch-time snapshots, not
  authoritative sources — the audit lists them separately as pointers back
  to the source recipe. Retrieved-lesson injection also moved from the
  system prompt to after the last user message, which keeps the stable
  prefix KV-cacheable.

### Added

- **Operator retrieval traces.** The Web UI now exposes operator-only,
  process-memory retrieval traces at `/debug/retrieval` and a readable
  lesson-selection viewer at `/debug/retrieval/view`, including invoking-agent
  attribution, mechanical candidates, relevance decisions, cache provenance,
  and the exact injected lesson block. Exact conversation/model inputs remain
  opt-in via literal `includeInputs=1`.

### Fixed

- **OpenAI retrieval reasoning effort.** Recipes using `openai-responses` or
  `openai-codex` can set `modules.retrieval.reasoningEffort` independently of
  the primary agent. Unsupported providers fail recipe validation instead of
  receiving an invalid OpenAI-shaped request, and reasoning-enabled retrieval
  requires an explicit model instead of falling through to the Claude default.
  
- **`mcpl_list` reports the live MCPL policy boundary.** Each server now shows
  connected/retrying state, whether its initial policy was established, its
  effective grant, host-masked and deny-by-default capability paths, and the
  separate host-owned `host/command` authority. During a rolling upgrade,
  fields unavailable from an older agent-framework render as `unknown` rather
  than as a misleading empty grant.

## 0.7.3 — 2026-08-01

### Changed

- **Prompt caching enabled on Bedrock for models that support it**
  (Discord issue #35). The previous transport-wide `promptCaching: false`
  was a workaround for "your request did not allow prompt caching" —
  which turned out to be the account-level denial for 3.5 Sonnet v2
  (caching there was preview-only and dropped at Bedrock's GA), not a
  transport property. Caching is now gated per model
  (`bedrockModelSupportsPromptCaching`): on for the Bedrock caching-GA
  lineup (3.5 Haiku, 3.7 Sonnet, Claude 4+), off for the pre-GA families
  (Claude v2/instant, Claude 3, 3.5 Sonnet — matched at the family
  boundary, so bare aliases and `-latest` forms gate the same as dated
  ids; non-Claude Bedrock ids are conservatively off). New recipe field
  `agent.promptCaching: boolean` overrides the gate in either direction
  on any provider, and lands at both layers — per-agent config and
  Membrane's default for internal callers (compression/merge) — for
  accounts/regions whose entitlements differ from the GA table.
  `cacheTtl` is withheld at the host layer on bedrock (Agent Framework
  still supplies its own default downstream; membrane ≥ 0.5.77 strips
  the ttl field at the provider boundary, so the wire request never
  carries it either way). Verified live 2026-07-31: every currently
  invokable Claude on Bedrock (all 4-era; 3.5-era and opus-4-0514 are
  EOL there) writes and reads the cache cleanly. Requires
  `@animalabs/membrane` ≥ 0.5.77 (cache_control ttl strip, stream cache
  usage capture, 4-era inference-profile model mapping); the dependency
  and lockfile are bumped accordingly in this change.

- **Subscription-GC closes carry honest provenance and respect explicit
  opens** (Discord issue #5, the Mythos "channel settings keep resetting"
  mechanism). GC closes are now recorded as `subscription-gc`, never
  `agent-tool`; a channel the resident/operator explicitly opened is no
  longer auto-closed under the *default* budget — a configured per-channel
  numeric budget in `agent_settings.channel_idle_limits` counts as an
  explicit idle lease and still closes at that budget. (The override state
  records no actor — agent, operator, or imported are all possible — so
  receipts say `configured-budget`, claiming no more than the state
  proves.) Pins and policy-opened channels behave as before. Requires
  agent-framework with machine-close provenance; against an older
  framework GC behaves as it did.
- **GC closes emit an operator-side ops receipt** (`subscription-gc-close`
  via the framework ops channel: failures.log + `ops:alert` trace +
  webhook) naming channel, threshold, decision source, and the restore
  action — ids and thresholds only, no content. A durable listening-state
  change no longer looks spontaneous from outside the transcript.

## 0.7.2 — 2026-07-27

### Added

- **`LLM_CALLS_FULL_PAYLOADS` env flag** — retain the raw request on every
  llm-call log entry, not only on refusal/error. Debugging aid; off by
  default (the logs grow gigabytes fast with it on).

## 0.7.1 — 2026-07-26

### Changed

- **Health call stats are now per-call, not cumulative.** The previous version
  rolled everything into two totals (main / compression), which hid exactly what
  you want to see — how an individual turn behaved. Now one row per call, newest
  first: time, origin, messages, fresh input, cached tokens, cached share, cache
  write, output, breakpoints, duration and verdict, with refusals and errors
  highlighted. Cumulative totals for the session remain in the Usage panel.

## 0.7.0 — 2026-07-26

### Added

- **Health panel: recent LLM call stats, split main vs compression.** Aggregates
  the call ledger the client already receives — fresh input, cache read/write,
  **cached share** (cacheRead ÷ input+cacheRead: what fraction of the prompt was
  reused rather than re-read), prefix-reuse rate, output, average cache
  breakpoints, cost, and errors/refusals — separately for `turn~` (main) and
  `aux~` (compression/summarizer). Includes the last 8 fresh-input values per
  group, so a budget descent can be seen trending down.
  - The `~` is honest: origin is inferred from stream-vs-complete (turns stream,
    compression uses `complete()`), not a definitive tag. Stated in the panel.
- **Health panel: context composition of the last compile** — head / raw middle /
  summaries by level / tail, with shares and bars. Sourced from `/healthz`, which
  now carries the strategy's in-process render stats: unlike
  `/debug/context/makeup` this costs nothing and makes no `count_tokens` network
  call, so it is safe on the 15s health poll.

## 0.6.1 — 2026-07-26

### Fixed

- **Pin id picker sourced the wrong ids.** It read `/debug/context/curve`, which
  looked right but isn't: on a live store 0 of 208 raw entries carried a
  `sourceMessageId`, and the 26 entries that *did* have an `id` were summaries,
  whose ids (`L3-544`) are not message ids. Pinning with one would have created a
  pin matching no message and silently done nothing. The picker now uses the
  client's own message list, where `WelcomeMessageEntry.id` is the store id and
  server-sourced rows are exactly those carrying a store `index`; it also gains a
  text/id filter. Caught by checking the endpoint against a real store before
  anyone used the panel.

## 0.6.0 — 2026-07-26

### Added

- **Pins panel** — operator control over protected ranges, using the pin surface
  that already existed in context-manager (`pinRange` / `markDocument` / `unpin`
  / `listPins`). No cm or af change was needed.
  - Three semantics kept visibly distinct rather than collapsed into one "pin",
    because they do different things to the fold plan: **raw** (never folded),
    **max L<sub>k</sub>** (fold no deeper than k; k=0 ≡ raw), and **at
    L<sub>k</sub>** (pinned at exactly k — the frontier cut passes through that
    node).
  - `at L_k` is honored **only** by `foldingStrategy: 'kv-stable'`; elsewhere it
    degrades to raw. The panel detects this and warns, rather than letting a
    request silently mean something else.
  - Ids are pickable from `/debug/context/curve` (~14ms, the cheapest debug
    endpoint and the only one exposing per-entry store ids with a text preview),
    so ranges are selected from the live context instead of pasted by hand.
    Entries without a store id — merged summaries — are omitted, since a pin
    needs a message id.
  - New `request-pins` / `pin-add` / `pin-remove`, server frame `pins-list`,
    broadcast on change like `settings-state`: pins alter what the next compile
    folds, so operators must not hold divergent views. Full-auth only via
    `observerMaySend`'s default-deny. `level` and `maxLevel` together is rejected
    at the wire as ambiguous.
  - Pins take effect on the next compile — no restart — and pair with dry run,
    which is now ~1.6s rather than minutes.

### Fixed

- Dry-run cost text said "~8s"; measured ~1.6s after the context-manager solver
  fixes. Corrected rather than left pessimistic.

## 0.5.4 — 2026-07-26

### Corrected after release

- The `0.5.4` note below claimed the entry projection fixed the 110s stall. **It
  did not.** Re-measuring after the change showed 121,855ms — unchanged. The
  projection cut payload (megabytes → 265KB) and removed the blob-inlining heap
  exposure, both worth keeping, but the time was never serialization. The actual
  cause was an O(members × groupSize) cliff in three kv-control solver loops,
  triggered whenever a head/tail boundary falls inside a deep summary group —
  fixed in context-manager (`1c4c436`, `7f2d5e1`; see
  `docs/incremental-compile-problem.md` §9.3). Measured after that fix: dry run
  **1.56s**, dry run + render **1.69s**, live compile 22.5s → 2.4s.

### Fixed

- **`dry run + show context` was a 110-second agent stall.** Measured 110,348ms
  against ~8s for the numbers-only dry run. `select()` builds the rendered
  entries either way, so the extra ~102s was pure serialization of 353 full
  entries — content the pane never showed, since it truncated every body past
  600 chars. The server now projects to `{i, who, chars, media, truncated,
  text}` with text capped at 1,200 chars; content blocks never leave the
  process and media is counted rather than inlined, which also removes the
  blob-resolution heap exposure `/curve` warns about.
- The cost disclosure was understated by ~20× and in the dangerous direction
  ("seconds… briefly pauses the agent"). It now states that the compile runs on
  the agent's thread and the agent does nothing else meanwhile, quotes the
  measured cost, and notes runs are serialized so a second click is refused
  rather than queueing another pause.

## 0.5.3 — 2026-07-26

### Added

- **Dry-run buttons, and the resulting context in the main pane.** Settings now
  has explicit `dry run` and `dry run + show context` buttons; the latter
  renders the context those settings WOULD produce in a new main-pane view,
  behind an unmissable "dry run — not applied" banner. Entries come from
  context-manager's dry-run select, so it is the actual layout, not an estimate.
- Dry runs report how long they took, and the panel states the cost up front: a
  full compile, seconds on a large store, briefly pausing the agent.

### Fixed

- **Preview no longer fires on every keystroke.** It was debounced-on-input, but
  a dry run is a real compile and `select()` is synchronous — so each one blocks
  the agent's event loop (no heartbeat, no Discord, no MCPL). Typing a budget
  stacked those stalls and made the UI look hung. It is now operator-initiated
  only, with server-side single-flight and a 3s cooldown that returns 429 rather
  than queueing more agent pauses.
- `middleChunkCount` was labelled "middle chunks" but the adaptive picker's unit
  is the MESSAGE (14,057 for a store with 800 chunks). Relabelled "middle
  messages (picker units)".
- The sidebar was `w-72` (288px) and clipped the dense numeric tables; now
  `w-96`, wider still on xl displays.

## 0.5.2 — 2026-07-26

### Fixed

- **Settings preview reported unreachable budgets as fitting.** context-manager's
  `PreviewResult.budgetTokens` is the *rejection* budget —
  `(requested - reserve) * (1 + overBudgetGraceRatio)` — and its `fits` means
  "would not throw `OverBudgetError`", not "fits the budget you asked for". On
  Mythos (`overBudgetGraceRatio: 0.35`) those differ by a third: previewing
  250k reported `fits: true` at 273,828 tokens, a budget the picker had in fact
  exhausted trying to reach. The endpoint now returns an `accounting` block
  separating `fitsRequested` / `withinGrace` / `unreachable`, and the panel
  renders three distinct verdicts (fits / over-requested-but-graced /
  would-hard-fail) plus the full budget derivation.

## 0.5.1

### Added

- **llm-calls logging for every provider**: `LoggingProviderAdapter`, a
  provider-agnostic decorator over any `ProviderAdapter`, wraps the
  openai-codex, openrouter, and openai-responses transports — which
  previously had NO wire visibility (found post-deploy on Mica: zero
  llm-calls files, requests undiagnosable). Full raw request + response
  summary + usage + timing + error per call, size-guarded against
  pathological payloads. Anthropic/Bedrock keep their purpose-built
  logging classes.

## 0.5.0 — 2026-07-26

### Added

- **Context settings panel** (webui `Settings` tab) — live control of the
  agent's compile window, replacing the stop → edit the `framework/state`
  Chronicle slot → start dance. Edits `contextBudgetTokens`, `tailTokens` and
  `transitionPaceTokens`; Apply / reset-to-recipe / revert-edits, plus cancel
  for an in-flight descent.
  - New client messages `request-settings`, `settings-update`,
    `settings-reset`, `settings-cancel-transition`; new server frame
    `settings-state`. No protocol version bump (additive).
  - `settings-state` is **broadcast** to every welcomed client, unlike
    `mcpl-list` — these are live process values, so two operators must not see
    divergent budgets.
  - Mutations are full-auth only for free: `observerMaySend` denies by default,
    so new message types are never reachable by scoped observers.
  - `persist: false` applies ephemerally (live now, reverts on restart) for
    operator experiments. `notify: true` optionally pushes a notice to the
    agent; **off by default**, because the notice is new text in the very
    context being tuned — it invalidates the KV prefix and is itself
    classifier-visible. The agent can always pull current settings via its own
    `agent_settings` tool instead.
  - The panel is explicit about three things that would otherwise mislead:
    raising the budget applies at once but **lowering starts a paced
    convergence** (shown as `converging` / `blocked`, with the blocked reason
    spelled out); only a few keys are hot, so `targetChunkTokens`,
    `headWindowTokens`, `mergeThreshold`, `foldingStrategy` and friends are
    listed under "restart only" rather than offered as controls; and preview
    requires a context-manager with dry-run support, so an older build reports
    "preview unavailable" instead of rendering an empty result.
- **`GET /debug/context/preview?budget=&tail=[&agent=]`** — non-committing
  preview of the fold plan at a hypothetical window. Persists no fold
  resolutions, enqueues no compression, advances no transition bookkeeping
  (the guarantee lives in context-manager's dry-run select). An infeasible
  budget is reported as `fits: false` with per-component diagnostics rather
  than an error — learning a budget cannot work is the reason to preview
  instead of applying and taking the outage. Returns 501 when the resolved
  context-manager predates dry-run support. Requires the `debug` scope.

### Fixed

- `/debug/context/curve` compiled against `app.recipe.agent.contextBudgetTokens`
  — the **stale recipe** value. Runtime overrides live in the `framework/state`
  Chronicle slot and win over the recipe, so the curve was plotted at the wrong
  budget for any agent whose budget had ever been changed at runtime. Now reads
  the live `getAgentRuntimeSettings`, falling back to the recipe.

## 0.4.0

### Changed

- **context-manager ^0.6.0** — the fatal coverage invariant: a compile
  refuses (`OverBudgetError` / `UncoveredDropError`) rather than shipping a
  context with silently-dropped messages, and recall-pair pricing includes
  reasoning carriers (fixes the permanent compile wedge / silent middle loss
  on carrier-bearing stores). Default `overBudgetGraceRatio` is now 0.02.
- **agent-framework ^0.7.0** — host-side recovery for context refusals: the
  OverBudget drain breaker also kicks for `UncoveredDropError`, and a
  `context-refusal` ops alert fires immediately (fleet-watch) with the
  recovery knobs named. Plus the context-settings preview surface and the
  workspace read cap.

### Added

- `compressionMaxTokens` recipe passthrough — cap compression output for
  models with low output ceilings (2c78936).

### Fixed

- **TUI bug sweep** (#64): operator-safety and observability fixes.
  - `/quit` confirm no longer treats arbitrary input as consent — only an
    explicit `y`/`yes` (or re-typed `/quit`) kills fleet children, `d`
    detaches, anything else cancels; a typed-through message is restored to
    the input (paste referents intact) instead of discarded. Ctrl+C now goes
    through the same confirmation; a second Ctrl+C force-quits.
  - `/checkpoint` records the message position and `/restore` branches back
    to it (previously restored to the branch head — rolling back nothing);
    repeat restores at the same position are a no-op, and an unreachable
    position degrades to the branch head with an explicit note.
  - Session switch fully resets TUI observability state (tree aggregator,
    stream subscriptions, per-agent caches) — fleet subtrees no longer
    freeze after `/session switch`.
  - Memory: peek logs / transcripts / scrollback capped, and detached
    renderables are `destroy()`ed so their native text buffers are actually
    freed (the fleet view leaked one buffer per line per 500ms repaint).
  - Agent-name resolution is exact (`shortAgentName`, fork `-d{depth}`
    scheme included) instead of substring matching that cross-wired agents
    with prefix-overlapping names; peek tails no longer clip the newest
    lines; fleet-view kill/restart failures are surfaced; per-round context
    size (`ctx:`) and session totals (`Σ`) are separate status segments;
    synesthete summaries moved off the render path and back off 30s after
    a failed call instead of retrying at 2 Hz.
  - Smaller UX: peek works on finished subagents (final runtime shown),
    fork `done` summaries always print a chat line, Esc/Ctrl+B work from
    the fleet view, paste placeholders survive `]` in the pasted text,
    `/help` documents `/find` and `/branchto`, `/clear` with arguments
    clears.

### Docs

- Synced stale documentation with the current build: repos marked public
  (AGENT-ONBOARDING), `forking-knowledge-miner` → `connectome-host`
  naming, webui default port corrected to 7340, DEV-ENVIRONMENT
  branch/version table refreshed (all feature branches merged),
  LOCUS-ROUTING and both root plan docs marked implemented.

### Changed

- **Tool-bloat reduction**: subscription-gc's `set_channel_idle_limit` /
  `list_channel_idle_limits` tools folded into `agent_settings` as the
  `channel_idle_limits` field (per-entry merge; number / `"off"` /
  `"default"`-or-null to clear), following the reasoning-controls
  precedent. The old tool names remain routable (undeclared), so agent
  muscle memory keeps working; agents just no longer carry the two extra
  tool schemas. `get` also reports read-only `channel_idle_default`,
  `channel_idle_counters`, and `channel_idle_pinned`, preserving what
  `list_channel_idle_limits` exposed. Updates are all-or-nothing: a patch
  with any invalid entry applies none of its entries.
- **GC pins split from agent overrides**: ChannelModeModule now holds
  debounced channels open via an internal `pin_channel_idle_limit` verb
  and a separate pins layer, instead of writing an `"off"` override.
  Consequences: a blanket `agent_settings reset` clears only agent-set
  limits — it can no longer silently re-enable auto-close on a channel in
  debounced mode — and a pre-existing agent override now survives a
  debounced→mentions round-trip rather than being reset to default.
  (Pins persisted by earlier builds as `"off"` overrides stay agent-level
  until the next mode change re-asserts them as pins.)

## 0.3.10 — 2026-07-21

### Added

- **Provider transports**: `provider: "bedrock"` for legacy Claude models
  (3.5 Sonnet 0620/1022, Opus 3) surviving on AWS APAC after Anthropic API
  retirement — AWS_* env credentials, model-ID mapping via membrane, prompt
  caching forced off (legacy models reject `cache_control`; verified live).
  `provider: "openai-codex"` (ChatGPT subscription, device-code login,
  `/fast` toggle) and `provider: "openrouter"` formalized with validation.
- **Bedrock wire logging**: `LoggingBedrockAdapter` writes
  `llm-calls.<iso>.jsonl` on the bedrock path — tool names per request,
  stop_reason + block shapes per response, raw request retained on errors.
- **Prefill-era bot migration**: recipe `agent.formatter: "anthropic-xml"`
  (membrane classic prefill) + `agent.prefillUserMessage` scaffold — together
  reproduce a chapterx borg's exact prompting structure inside a resident
  (first used for the Supreme Sonnet isekai, 2026-07-21).

- Contribution policy: `CONTRIBUTING.md` (how changes land, review process,
  AI-attribution convention, changelog rules — binding for PRs and direct
  pushes, humans and AIs alike) and a PR template.
- CI `changelog` check: PRs touching `src/` must also touch `CHANGELOG.md`,
  opt out with the `no-changelog` label. The publish workflow now refuses to
  release a `vX.Y.Z` tag with no matching `## X.Y.Z` changelog section.
- Release mechanics automated: `npm version <level>` cuts `Unreleased` into
  `## X.Y.Z — date` via the `version` hook (`scripts/release-changelog.ts`),
  and on release tags CI creates the GitHub release with that section as
  its notes — independent of the npm publish job, so notes exist for
  github-clone consumers even when a publish fails.
- **Web UI observability catch-up**: `ops:alert` traces render as persistent
  banner rows in the SPA (compression quarantine, refusal streaks,
  inference-exhausted; `<kind>-clear` stands them down); a Health sidebar tab
  polls `/healthz` for per-agent status, failure streaks, refusal stats,
  runtime settings, and quarantine, and reconciles durable-state alerts on
  connect. New protocol frames `request-branches`/`branches-list` back a
  Chronicle branch-lineage panel opened from the header branch chip, with
  checkout via the existing `/checkout` command path (read-only for
  observers; listing rides the `messages` scope). The `/curve` link now
  lives in the Context panel header.
- **TUI modernization**: `p` on an agent inside a fleet child opens an
  honest per-agent peek — the child's event stream filtered by `agentName`,
  covering the child's root agent and its subagents (sub-subagents of the
  parent), with phase/tokens/task header from the tree reducer. `ops:alert`
  traces from the local framework AND from every fleet child surface as red
  chat lines plus a persistent `⚠ N alerts` status-bar segment; all-clears
  stand alerts down. The token line now shows the session cost estimate
  when priced.

### Fixed

- Dead `PlaceholderPanel` removed from the SPA; stale doc pointers
  (`WEBUI-PLAN.md`, knowledge-miner references) corrected; README now
  documents the web UI, headless mode, and current TUI peek semantics.

## 0.3.2 — 2026-07-14

Retro-filed: 0.3.1–0.3.9 predate the changelog policy and were released
without cutting this file; only the entry below was recorded at the time.

### Breaking (recipe authors only)

- `modules.fleet.children[].recipe` paths now resolve at recipe-load time
  against the **directory of the parent recipe file** (or URL base) rather
  than `process.cwd()`. Absolute paths and `http(s)://` URLs pass through
  unchanged. This makes recipe bundles portable: a parent file and its
  sibling children can live anywhere on disk and be launched from any CWD.

  **Who needs to act**: anyone maintaining a forked or custom
  triumvirate-style recipe that hard-codes child paths with a `recipes/`
  prefix (or any prefix anchored at `connectome-host/`'s CWD). After
  upgrade, `"recipes/knowledge-miner.json"` inside
  `<somewhere>/my-recipe.json` resolves to
  `<somewhere>/recipes/knowledge-miner.json`, which is almost certainly
  not what's intended.

  **Migration**: drop the `recipes/` prefix so the child is referenced as a
  sibling of the parent file (e.g. `"knowledge-miner.json"` or
  `"./knowledge-miner.json"`). No files need to move on disk. The
  in-tree `recipes/triumvirate.json` has already been updated.

  **Unchanged**: `dataDir`, workspace mount paths, and child process CWD
  stay CWD-relative (these are runtime paths, not authoring references).
  `fleet--launch` invocations from the conductor are still matched
  CWD-relative at dispatch time, so existing system prompts that document
  CWD-relative paths continue to work.
