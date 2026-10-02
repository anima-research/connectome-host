# connectome-host — architecture

How the host is built and what each part does, as of 0.9.0. For what it is
*for* and how to run it, start with the [README](README.md); for the
documents this one replaced, and what became of their plans, see
[`docs/history/`](docs/history/README.md).

## In one paragraph

connectome-host is one process that runs one agent described by a recipe.
It reads the recipe, picks a provider transport, builds the agent's memory
strategy, attaches the modules the recipe asks for, connects the MCPL
servers that give the agent its surfaces (Discord, Zulip, a shell, a
heartbeat), and then hands everything to agent-framework's event loop. Around
that loop it adds the things an *operator* needs to keep an agent healthy for
months: a terminal UI, a browser console, a headless socket, cost and quota
accounting, logs, and a supervisor for child processes. Most agent behavior —
the event loop, gating, channels, memory, provider wire formats, storage —
lives in the four `@animalabs/*` libraries; the host is the part that turns a
JSON file into a running, observable, reversible agent.

## Layers

```
  operator ──┬── TUI (src/tui.ts)                  ┐  slash commands: src/commands.ts
             ├── WebUI (modules/web-ui-module.ts)  ├  panel ops:      src/web/panel-data.ts
             └── parent host over a Unix socket    ┘  agent tree:     src/state/*
                              │
   connectome-host ── recipe → providers, strategy, modules, MCPL config,
                      logging, call ledger, quota meter, fleet supervisor
                              │
   @animalabs/agent-framework ── event loop, EventGate, MCPL + channels,
                      prose routing, workspace, history, conversations,
                      subconscious, agent_settings, surgery, ops alerts
       ├── @animalabs/context-manager ── autobiographical memory, folding, pins
       ├── @animalabs/membrane ──────── provider adapters, formatters, caching
       └── @animalabs/chronicle ─────── branchable event store (Rust, N-API)
                              │
   MCPL servers (separate repos/processes): discord-mcpl, zulip_mcp,
   heartbeat-mcpl, terminal-sessions-mcp, …
```

Where a responsibility lives matters when something goes wrong, and a lot of
it has moved upstream over time:

| Concern | Lives in |
|---|---|
| Recipe schema, validation, `${VAR}` substitution, persistence | host (`src/recipe.ts`) |
| Choosing and wrapping a provider transport; wire logs; cost/quota | host (`src/index.ts`, `src/logging-*.ts`, `src/call-ledger.ts`, `src/quota-meter.ts`) |
| Operator surfaces (TUI, WebUI, headless IPC, slash commands) | host |
| Fleet of child processes | host (`src/modules/fleet-module.ts`, `src/headless.ts`) |
| Event loop, wake gating, channel locus and prose routing | agent-framework |
| Workspace mounts, history search, conversations, subconscious, `agent_settings`, rollback/suppress/quiesce, ops alerts | agent-framework |
| What the model sees: compression, folding, budgets, pins | context-manager |
| Wire formats, prompt caching, keepalive, retries | membrane |
| Durable, branchable storage | chronicle |

## Runtimes

`src/index.ts` picks one of three front ends after the framework is up:

| Mode | Selected by | What it is |
|---|---|---|
| TUI | default on a TTY | OpenTUI terminal app (`src/tui.ts`): chat, a fleet tree, per-agent peek. Needs Bun (OpenTUI's core is native). |
| Readline / piped | `--no-tui`, or stdin is not a TTY | A readline loop; piped input is processed line by line, waiting for each inference. For scripts and CI. |
| Headless | `--headless` | No terminal. JSONL over `$DATA_DIR/ipc.sock`, logs to `$DATA_DIR/headless.log`. How production residents run (under systemd or launchd) and how fleet children run. See [`docs/fleet-protocol.md`](docs/fleet-protocol.md). |

The WebUI is not a runtime: it is a module that can be attached to any of the
three, and in practice is how headless residents are operated.

## Startup

1. **Resolve the recipe** — CLI path or URL, else the saved
   `$DATA_DIR/.recipe.json`, else the built-in default (a plain assistant
   with the gate and workspace on). `--no-recipe` clears the saved one.
2. **Check credentials** for the recipe's provider, fail fast if missing.
3. **Build cross-cutting services:** the settings module (read per call by
   the adapter), the `llm-calls.<iso>.jsonl` log path, the call ledger
   (Anthropic), the quota meter (subscription auth), and the provider adapter
   chain (§Providers).
4. **Open the session** — `SessionManager` picks the active session's
   Chronicle store under `$DATA_DIR/sessions/<id>/`, migrating legacy layouts.
5. **Resolve the agent's name** — the recipe wins, then an importer's sidecar,
   then a default.
6. **Build Membrane** with the right formatter (native, Anthropic-XML prefill,
   or OpenAI Responses), retry policy and caching defaults.
7. **`createFramework()`** — load recipe extensions, build the module list,
   merge MCP servers, build the memory strategy and agent config, then
   `AgentFramework.create()` with the gate, provider hold, code execution,
   conversations and subconscious configuration. Post-create hooks bind the
   history module, wire the compression-quarantine alarm to ops alerts, and
   hand the framework to modules that need it.
8. **Start** the framework, the session auto-namer, per-server MCPL stderr
   logs, and the chosen runtime.

**Switching sessions** (`/session switch`) stops the framework and runs
`createFramework()` again against the new store, reusing the same Membrane,
adapter, settings, ledger, quota meter and agent name. The WebUI's HTTP/WS
server is a process-level singleton and survives the switch.

## Recipes

A recipe is JSON; the full key set is typed and validated in
`src/recipe.ts`, and the README documents the commonly used parts.

- **Substitution.** Every string value may use `${VAR}` or
  `${VAR:-default}`. A missing required variable is a load error. Bun loads
  `.env` automatically.
- **Persistence.** The recipe is saved to `$DATA_DIR/.recipe.json` in its
  *unresolved* form (`${VAR}` kept, a URL system prompt kept as the URL),
  mode 0600, and re-resolved against the current environment on resume — so
  rotations take effect on restart. Two fields are stored resolved instead:
  fleet children's `recipe` and extensions' `path`, which must be made
  absolute against the original source directory. A `${VAR}` interpolated
  into one of them (a token in a child-recipe URL, say) is written to the
  snapshot as its value, so keep secrets out of those two fields. Other state
  in the data dir can hold secrets too — the identity key, and fleet
  children's resolved `env` (#162).
- **Validation checks values, not spelling.** Bad values, impossible
  combinations (e.g. an instructions path on a mount that can't be written)
  and partial policies are rejected at load, naming the key. Unrecognized keys
  are generally not rejected (a few blocks, such as `subconscious`, refuse
  unknown fields), so a misspelled key is silently ignored.
- **Paths.** Fleet child recipes resolve relative to the parent recipe file;
  runtime paths (data dirs, workspace mounts) resolve against the CWD.
- **Extensions.** `extensions` maps names to local modules that register
  extra context strategies or framework modules; they run in-process against
  the host's own `@animalabs/*` copies.

## Providers

`agent.provider` selects the transport. Every path goes through a logging
decorator, so every call lands in `llm-calls.<iso>.jsonl`.

| Provider | Adapter | Auth |
|---|---|---|
| `anthropic` (default) | `LoggingAnthropicAdapter` | `ANTHROPIC_API_KEY`, or `ANTHROPIC_AUTH_TOKEN` (Claude subscription; wins when set — adds the OAuth beta header and the required identity block). `ANTHROPIC_BASE_URL` for a gateway. Cache keepalive, call ledger, gate telemetry headers and the quota meter apply here. |
| `bedrock` | `LoggingBedrockAdapter` | `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (`AWS_REGION`), `BEDROCK_BASE_URL` for a gateway. Prompt caching gated per model. Used to keep models alive after they leave the first-party API. |
| `openai-codex` | `CodexSubscriptionAdapter` | ChatGPT subscription via the Codex CLI's login (`CODEX_BINARY`, `CODEX_HOME`, `CODEX_BASE_URL`). `/fast` toggle; quota meter. |
| `openai-responses` | membrane `OpenAIResponsesAPIAdapter` | `OPENAI_API_KEY`, `OPENAI_BASE_URL`. |
| `openrouter` | membrane `OpenRouterAdapter` | `OPENROUTER_API_KEY`. |
| `openai-compatible` | membrane `OpenAICompatibleAdapter` | `agent.baseUrl` (required), `OPENAI_COMPATIBLE_API_KEY` (optional; deliberately no fallback to `OPENAI_API_KEY`). |
| `mock` | membrane `MockAdapter` | none — echoes or returns a scripted reply; for zero-cost smoke runs. |

The model is `MODEL`, else `agent.model`, else `claude-opus-4-6`
(`gpt-5.4` for `openai-codex`). `agent.formatter: "anthropic-xml"` with
`agent.prefillUserMessage` reproduces classic prefill-era prompting for
migrated bots.

**Cost and quota.** `src/call-ledger.ts` keeps a content-free window of recent
calls with a cache verdict per call (hit, first write, expired rewrite,
uncached auxiliary), replaying earlier logs on start; `src/call-pricing.ts`
prices them. On subscription auth `src/quota-meter.ts` polls the provider's
quota windows instead (no inference spend), the UIs show percentages rather
than dollars, and a 429 on a spent window *parks* the agent until the window
resets (agent-framework's provider hold) instead of retrying into it.

**Gateway telemetry.** With `GATE_TELEMETRY=1` and an `ANTHROPIC_BASE_URL`,
calls carry `x-gate-*` headers (compression debt; for turns, why the turn
fired and on which channel) for an inference gateway to record. Both
conditions are required so the headers can never reach a vendor endpoint.

## Memory

`src/framework-strategy.ts` builds the context strategy from
`agent.strategy`:

- **`autobiographical`** (default) — context-manager's
  `AutobiographicalStrategy`. The host turns on **adaptive resolution** and
  **kv-stable folding** unless the recipe says otherwise: the raw tail stays
  verbatim, and the middle is folded — each stretch rendered raw or as an
  L1…L8 memory — just enough to fit the context budget, by a solver that
  disturbs the already-cached prefix as little as it can. Memories are written by the agent's own model
  (`compressionModel` defaults to `agent.model`) in the agent's own voice
  (`summaryParticipant` defaults to `agent.name`). Host defaults:
  `headWindowTokens` 4000, `recentWindowTokens` 30000, `maxMessageTokens`
  10000. About 45 further context-manager keys pass through verbatim.
  `foldingStrategy: "kv-unified"` is an opt-in cost-aware solver.
- **`frontdesk`** (`src/strategies/frontdesk-strategy.ts`) — the same, plus
  channel provenance headers, topic-aware chunk boundaries and preservation of
  unanswered questions and @mentions. For agents that staff a channel.
- **`passthrough`** — no compression.
- **Extension strategies** registered through `extensions`.

Three keys are hot at runtime — `contextBudgetTokens`, `tailTokens`,
`transitionPaceTokens` — changeable by the agent (`agent_settings`) or the
operator (WebUI Settings), persisted in Chronicle and winning over the recipe.
Raising the budget applies at once; lowering it converges gradually. Operators
can also **pin** ranges (keep raw, cap the fold level, or fix a level) from the
WebUI. How this feels from the inside is in
[`docs/AGENT-MEMORY-GUIDE.md`](docs/AGENT-MEMORY-GUIDE.md); sizing for
long-lived agents is in [`docs/AGENT-ONBOARDING.md`](docs/AGENT-ONBOARDING.md).

## Modules

Built in `createFramework()`. Tools are exposed as `<module>--<tool>`.

| Module | Recipe key | Default | Tools / effect |
|---|---|---|---|
| `TuiModule` | — | always | Turns external input (TUI, readline, WebUI, headless) into user messages. |
| `TimeModule` | — | always | `time--now`; session-start timestamp in the agent's timezone. |
| `SettingsModule` | — | always | Adds reasoning controls to `agent_settings`. |
| EventGate (framework) | `wake` | **on** | Per-session `config/gate.json`; `sleep`/`wake`, `wake_add_rule`/`wake_remove_rule`, `gate_status`, `event_tags`. See [`docs/ATTENTION-AND-GATING.md`](docs/ATTENTION-AND-GATING.md). |
| `WorkspaceModule` (framework) | `workspace` | **on** | Mounted filesystem backed by Chronicle (`workspace--read/write/edit/ls/glob/grep/…`). Defaults: `input` (read-only `./input`), `products` (read-write `./output`). |
| `SubscriptionGcModule` | `subscriptionGc` | **on** | Auto-closes channels whose ambient traffic since the agent last ran exceeds a limit (20k chars). |
| `ChannelModeModule` | `channelMode` | **on** with the gate | `channel-mode--set_channel_mode`: mentions-only ↔ debounced ambient. |
| `HistoryModule` (framework) | `history` | off | `history--stats/extract/search/overview` over the agent's own uncompressed record. |
| `InstructionsModule` | `instructions` | off | A shared living instructions file injected into every agent every turn. |
| `SubagentModule` | `subagents` | off | `subagent--spawn/fork/peek/hud/concurrency/return`: in-process ephemeral agents (depth ≤3, adaptive concurrency). |
| `LessonsModule` | `lessons` | off | `lessons--create/update/query/list/boost/demote/deprecate`: a confidence-scored store. Storage only. |
| `RetrievalModule` | `retrieval` | off | Needs lessons. Model-driven selection of up to 5 lessons, injected after the last user message. |
| `FleetModule` | `fleet` | off | `fleet--launch/list/status/send/command/peek/kill/restart/relay/await`: supervises headless children. |
| `ActivityModule` | `activity` | off | `activity--show_in/hide_in`: typing indicators. |
| `McplAdminModule` | `mcplAdmin` | off | `mcpl_list/deploy/restart/unload`: the agent manages its own MCPL servers. |
| `IdentityModule` | `identity` | off | The agent's own archipelago identity key; exchanges key-proofs for access tokens so credentials never enter the agent's context. |
| `WebUiModule` + `ObserversModule` | `webui` | off | Browser console (below); `observers--get/grant/revoke` let the agent manage who may watch. |
| `TtsRelayModule` | `ttsRelay` | off | Streams live generation to a TTS relay; trims posted messages when a voice client is interrupted. |

Framework features configured by top-level recipe keys rather than modules:
`conversations` (per-channel conversation forks from a dormant trunk agent),
`subconscious` (a secondary agent with `tune_out`), `codeExecution`.

## MCPL servers

- **Opt-in per recipe.** `mcpl-servers.json` (CWD) is a registry: a server in
  it loads only when the recipe names its id under `mcpServers`. The file
  supplies the command, args and env; the recipe entry may be id-only or
  override policy (`channelSubscription`, `toolPrefix`, feature sets,
  enabled/disabled tools, reconnect, transport, `access`, `toolLifecycle`).
  An id-only entry the file doesn't define is a startup error. A recipe may
  also define servers the file doesn't have. `/mcp add|remove|env` edits the
  file; changes apply on restart.
- **Tool lifecycle.** A `toolLifecycle` grant lets a server observe the
  agent's calls to other tools (MCPL RFC-007), classed per RFC-008 by the
  recipe's `toolClassOverrides`, the host's `HOST_TOOL_CLASSES`
  (`src/tool-lifecycle-config.ts`) and the server's own `_meta`. Off by
  default; needs an agent-framework with tool lifecycle
  (anima-research/agent-framework#199). See the README.
- **Agent overlay.** `mcpl-servers.agent.json` holds servers the agent deployed
  for itself (`mcplAdmin`); they load unconditionally, and tombstones in it
  suppress servers the agent unloaded. The overlay can never grant
  `toolLifecycle`.
- **Child env.** Stdio servers inherit the host env plus the entry's env and
  a few house defaults. Each server's stderr goes to
  `sessions/<id>/mcpl-stderr/<server>.log` (rotated at 10 MB).

## Operator surfaces

All three surfaces share two layers, so they cannot drift apart:
`src/commands.ts` (every slash command, whichever surface typed it) and
`src/web/panel-data.ts` (`runPanelOp`: settings, pins, health, quota, context
makeup/coverage/curve/preview, MCPL status, media — run in-process by the
WebUI and inside a child on a fleet `panel-request`). The agent tree shown by
both UIs is folded from trace events by `src/state/agent-tree-reducer.ts`,
one reducer per process.

- **TUI** — chat with streaming, thinking and tool lines (Ctrl+V for
  verbose); a fleet tree of local subagents, fleet children and their agents
  with context gauges; per-agent peek; status bar with context, cost or
  quota, and the worst active ops alert.
- **WebUI** — a Solid SPA (`web/`, built to `dist/web`) served by the host on
  port 7340, over one WebSocket (`/ws`) plus HTTP endpoints. Panels: chat
  with full interiority, agent/fleet tree, lessons, MCPL, workspace files,
  context makeup and document view, Settings with dry runs, Pins, Health
  (alerts, call ledger, compression debt), usage/quota, branch lineage, and
  live surgery (roll back to a message, suppress messages, quiesce) with an
  operator log. HTTP: `/healthz`, `/quota`, `/media/…`, `/files/…`,
  `/curve`, `/debug/context[/makeup|coverage|curve|preview|maintenance]`,
  `/debug/retrieval[/view]`. `/healthz`, `/quota`, `/media/…` and the
  `/debug/context*` endpoints accept `?scope=<child>` to ask a fleet child
  instead (`/curve` passes it through to its data fetch); `/files/…` and
  `/debug/retrieval*` always answer for the local process. Non-loopback binds require
  basic auth; read-only **observers** authenticate with Ed25519 device keys
  and per-grant scopes. See [`docs/webui-deployment.md`](docs/webui-deployment.md).
- **Headless IPC** — see [`docs/fleet-protocol.md`](docs/fleet-protocol.md).

## Fleet

A parent recipe with `modules.fleet` spawns each child as
`bun src/index.ts <child-recipe> --headless` with its own data dir, connects
to its socket, and keeps one agent-tree reducer per child, resynced by
`describe` → `snapshot` on every (re)connect. Children may not themselves run
fleets. Children survive a parent crash and are re-adopted on restart; an
orderly exit stops them unless the operator detaches. The full protocol,
schema and tool list are in [`docs/fleet-protocol.md`](docs/fleet-protocol.md).

## Reversibility

- **Host commands** — `/undo`, `/redo`, `/checkpoint`, `/restore`,
  `/branches`, `/checkout`, `/branchto`, `/newtopic` move the head over
  Chronicle branches. They are refused while a turn is in flight. Checkpoints
  are held in memory for the session.
- **Framework surgery** (WebUI) — roll back to a message or suppress messages
  by forking and switching branches; quiesce/resume the host. Every action is
  appended to `sessions/<id>/operator-actions.jsonl`.

The two mechanisms coexist: the host's `/undo` predates the framework's
surgery and still uses its own branch stacks.

## Failure handling and observability

- **Wire logs** — `llm-calls.<iso>.jsonl` per process (request summaries,
  usage, timing, errors; raw requests on errors, or always with
  `LLM_CALLS_FULL_PAYLOADS=1`).
- **Ops alerts** (agent-framework) — compression quarantine, refusal streaks,
  inference exhaustion, context refusals, GC closes: an `ops:alert` trace
  (shown as banners in both UIs), a record in `logs/failures.log`, and a
  webhook when `CONNECTOME_OPS_WEBHOOK` is set.
- **Prompt-cache keepalive** — idle agents on a 1 h cache get a prefill-only
  refresh before expiry (membrane), logged to stderr.
- **`scripts/connectome-doctor`** — walks the "why isn't the agent
  responding" ladder for an install dir.

## Data on disk

Under `$DATA_DIR` (default `./data`):

| Path | What |
|---|---|
| `.recipe.json` | Unresolved recipe snapshot (0600). |
| `sessions.json`, `sessions/<id>/` | Session index; one Chronicle store per session. |
| `sessions/<id>/config/gate.json` | Wake policies (seeded from the recipe, then append-only reconciled). |
| `sessions/<id>/operator-actions.jsonl` | Operator surgery log. |
| `sessions/<id>/mcpl-stderr/<server>.log` | MCPL server stderr. |
| `sessions/<id>.import-source.json` | Provenance sidecar written by the importers. |
| `llm-calls.<iso>.jsonl` | Provider call log, one per process. |
| `lessons.json` | Lesson store (shared by every session in the data dir). |
| `observers.json`, `identity-key.pem` | WebUI observer grants; identity keypair. |
| `ipc.sock`, `headless.log`, `headless.pid` | Headless mode. |
| `tui-error.log` | TUI-mode stderr. |

Relative to the CWD: `mcpl-servers.json`, `mcpl-servers.agent.json`,
`sleep-privileged.json`, `logs/failures.log`, the default workspace mounts
`./input` and `./output`, fleet children's `./data/<name>`.

## Scripts

| Script | Purpose |
|---|---|
| `import-claudeai-export.ts` | claude.ai data export → one session per conversation ([guide](docs/claudeai-evacuation.md)). |
| `evacuator.ts` | Interactive revival-recipe composer for a claude.ai export. |
| `import-codex-rollout.ts` | Codex rollout transcript → a session. |
| `warmup-session.ts` | Pre-compute memories for an imported session before first boot. |
| `test-historical-thinking.ts` | Probe which encodings of historical thinking the API accepts. |
| `audit-module-optins.ts` | Report which recipes/data dirs are affected by the subagents/lessons/retrieval opt-in change. |
| `connectome-doctor` | Liveness/diagnosis ladder for a deployed agent. |
| `release-changelog.ts` | `npm version` hook: folds `changelog.d/` into `CHANGELOG.md`. |

Claude Code transcripts are ingested by the procedure in
[`docs/claude-code-ingest.md`](docs/claude-code-ingest.md).

## Source map

| Path | Role |
|---|---|
| `src/index.ts` | Entry point, provider selection, `createFramework()`, session switching, runtime dispatch. |
| `src/recipe.ts` | Recipe types, defaults, substitution, validation, persistence, CLI parsing. |
| `src/framework-strategy.ts`, `src/framework-agent-config.ts` | Recipe → memory strategy / agent config. |
| `src/extensions.ts`, `src/workspace-mounts.ts`, `src/retrieval-config.ts`, `src/agent-name.ts` | Recipe helpers shared by runtime and validation. |
| `src/mcpl-config.ts` | Server registry, agent overlay, child env. |
| `src/session-manager.ts`, `src/synesthete.ts` | Sessions; auto-naming (after the third user message). |
| `src/logging-adapter.ts`, `src/logging-bedrock-adapter.ts`, `src/logging-provider-wrapper.ts` | Wire logging per provider. |
| `src/codex-subscription-adapter.ts` | ChatGPT-subscription transport. |
| `src/call-ledger.ts`, `src/call-pricing.ts`, `src/quota-meter.ts` | Cost, cache verdicts, subscription quota. |
| `src/gate-telemetry.ts`, `src/cache-keepalive-log.ts` | Gateway headers; keepalive logging. |
| `src/tui.ts`, `src/commands.ts` | Terminal UI; slash commands. |
| `src/headless.ts` | Headless runtime. |
| `src/state/` | Agent-tree reducer and per-child aggregator. |
| `src/web/` | WebUI wire protocol and the shared panel layer. |
| `src/modules/` | Host modules (table above), plus WebUI pages and retrieval traces. |
| `src/strategies/frontdesk-strategy.ts` | Channel-staffing memory strategy. |
| `web/src/` | The WebUI SPA. |
| `test/` | ~95 Bun test files: recipe validation, fleet/headless, WebUI protocol, providers and ledger, modules, commands, importers. |

## Runtime and dependencies

- **Bun** runs the host (OpenTUI's native core requires it; Bun also loads
  `.env`). **Node/npm** builds the WebUI (`postinstall` / `bun run build:web`).
- `@animalabs/agent-framework`, `context-manager`, `membrane` and
  `chronicle` come from npm; chronicle ships prebuilt native binaries, so no
  Rust toolchain is needed unless you build it from source. For working on the
  libraries themselves, see [`docs/DEV-ENVIRONMENT.md`](docs/DEV-ENVIRONMENT.md).
- `@opentui/core` for the terminal UI.
