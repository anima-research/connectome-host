# Changelog

## Unreleased

### Added

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
