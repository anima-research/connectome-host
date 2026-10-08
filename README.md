# connectome-host

connectome-host runs long-lived agents. A **recipe** — one JSON file —
describes an agent: its name, model and provider, memory strategy, MCP
servers and modules. The host keeps that agent running: in a terminal, as a
headless daemon under systemd or launchd, or as one process in a supervised
fleet, with a browser console for whoever looks after it.

Most agents it runs are **residents**: agents with a name and a history who
live on Discord or Zulip for months, remembering in their own voice —
sometimes continuing a conversation that began on claude.ai, in Claude Code or
in Codex. Most of the host's work goes into what that takes: memory that folds
instead of truncating, prompt caches that stay warm at half-million-token
contexts, honest cost and subscription-quota accounting, an operator who can
see and repair a live context, and ways to bring an agent in from somewhere
else. It started as a knowledge-mining TUI, and those recipes still ship
([what we set out to build, and what became of it](docs/history/README.md)).

Built on the Connectome stack: [@animalabs/agent-framework](https://github.com/anima-research/agent-framework) + [@animalabs/context-manager](https://github.com/anima-research/context-manager) + [@animalabs/chronicle](https://github.com/anima-research/chronicle) + [@animalabs/membrane](https://github.com/anima-research/membrane).

## What people run on it

| Use | Start here |
|---|---|
| **A resident** — a persistent agent on Discord (or other surfaces), headless on a VPS, with autobiographical memory | [`docs/AGENT-ONBOARDING.md`](docs/AGENT-ONBOARDING.md), [`docs/DEPLOYMENTS.md`](docs/DEPLOYMENTS.md) |
| **A continued conversation** — bring a claude.ai conversation, a Claude Code session or a Codex rollout across and keep going | [`docs/claudeai-evacuation.md`](docs/claudeai-evacuation.md), [`docs/claude-code-ingest.md`](docs/claude-code-ingest.md), `scripts/import-codex-rollout.ts` |
| **A fleet** — a conductor agent supervising headless child processes, one agent tree in the TUI and WebUI | [`docs/fleet-protocol.md`](docs/fleet-protocol.md), [`recipes/TRIUMVIRATE-SETUP.md`](recipes/TRIUMVIRATE-SETUP.md) |
| **Knowledge mining** — miner / reviewer / clerk agents over Zulip and GitLab | [`recipes/SETUP.md`](recipes/SETUP.md), [`docs/LIBRARY-PIPELINE.md`](docs/LIBRARY-PIPELINE.md) |
| **A workbench** — a plain assistant with tools in your terminal | Quick start below |

All the documentation is indexed in [`docs/README.md`](docs/README.md); how
the host is put together is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Quick start

```bash
# Prerequisites: Bun and Node.js 20+ (Node builds the web UI), plus credentials
export ANTHROPIC_API_KEY=sk-ant-...     # or ANTHROPIC_AUTH_TOKEN (Claude subscription)

bun install                                   # also builds the web UI bundle
bun src/index.ts                              # generic assistant (or the last recipe you loaded)
bun src/index.ts recipes/mock-test.json       # zero-cost offline smoke run, no credentials needed
bun src/index.ts path/to/recipe.json          # load a recipe
bun src/index.ts https://example.com/r.json   # recipe from URL
```

Bun loads `.env` automatically; `.env.example` lists the common variables.

## Recipes

A recipe is a JSON file that configures everything specific to one agent:

```json
{
  "name": "My Agent",
  "description": "What this agent does",
  "agent": {
    "name": "researcher",
    "model": "claude-opus-4-6",
    "timezone": "America/Los_Angeles",
    "systemPrompt": "You are a ...",
    "maxTokens": 16384
  },
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["path/to/server.js"],
      "env": { "API_KEY": "${MY_SERVER_API_KEY}" }
    }
  },
  "modules": {
    "subagents": true,
    "workspace": { "mounts": [{ "name": "notes", "path": "./notes", "mode": "read-write" }] }
  },
  "sessionNaming": {
    "examples": ["Thread Archaeology", "Pipeline Debug"]
  }
}
```

Every string value may reference the environment as `${VAR}` or
`${VAR:-default}`; a missing required variable fails the load, naming it.
Values and combinations are validated at load time and fail loudly, naming
the key. Unrecognized keys, though, are generally *not* rejected — a
misspelled key (`mcplServers`, a leftover `modules.files`) is silently
ignored, so check spelling against this README and `src/recipe.ts`.

`agent.timezone` is an IANA zone used only for times rendered to the agent.
Chronicle and MCPL protocol timestamps remain epoch/UTC. If the recipe omits
it, `AGENT_TIMEZONE` is used, then the process timezone.

**Memory defaults**: `agent.strategy` may be omitted entirely. The default is
the autobiographical memory strategy with adaptive resolution, **KV-stable
folding** (compile plans that preserve prompt-cache prefixes), compression by
the agent's own model, and summaries voiced as the agent itself
(`summaryParticipant` defaults to `agent.name`). Set a `strategy` block only
to tune windows/budgets or opt into a different strategy type (`frontdesk`
for channel-staffing agents, `passthrough` for none) — see
`docs/AGENT-ONBOARDING.md` for sizing guidance on long-lived agents and
[`docs/AGENT-MEMORY-GUIDE.md`](docs/AGENT-MEMORY-GUIDE.md) for how it works.

### Prose routing

Plain assistant text (anything the model writes that is not a tool call) is
delivered by Agent Framework according to `agent.proseRouting`:

| Mode | Behavior |
|------|----------|
| `"locus"` (default) | Text is auto-published to the current locus — the channel that last woke the agent. Text emitted in a tool-call round is delivered live, as narration, unless that round also calls `skip_reply` or an explicit send tool. |
| `"hybrid"` | Like `locus`, but a leading `>>>destination` envelope routes that segment elsewhere through the authorized channel resolver. |
| `"explicit"` | Text must start with `>>#channel` / `>>@person` / `>>skip_reply`; unprefixed text is never delivered and bounces to a clipboard for a prefixed resend. |
| `"disabled"` | Text is never auto-published. The only way anything reaches a channel is an explicit send tool (`send_message`, `channel_publish`, `reply_message`, `send_dm`, ...). Authored text stays in Chronicle and the turn-end `[delivered] nothing` receipt tells the agent how many segments were withheld. |

Use `"disabled"` for agents that run multi-step tool tasks from a busy shared
channel: in `locus` mode a stray one-line narration between two tool calls
("checking page 2") is published to that channel as an ordinary message, and
the only mitigation is behavioral (never narrate in tool rounds, always end
tool-only turns with `skip_reply`). With `"disabled"` the agent replies by
calling a send tool, and nothing else leaks. Ephemeral subagents inherit the
caller's mode.

`agent.sameRoundThinkTextPolicy` (`"public"` default, or `"private"`) governs
only text emitted **beside a `think()` call** in the same round. It does not
cover tool-call rounds without `think()`; use `proseRouting: "disabled"` for
that. The think policy can be inspected and switched at runtime through the
agent's `agent_settings` tool and the web UI; `proseRouting` is fixed for the
process lifetime.

```json
{
  "agent": {
    "proseRouting": "disabled",
    "sameRoundThinkTextPolicy": "private"
  }
}
```

See Agent Framework's `docs/disabled-prose-routing.md`,
`docs/explicit-prose-routing.md`, and `docs/hybrid-prose-routing.md` for the
full semantics of each mode.

### Recipe loading

| Command | Behavior |
|---------|----------|
| `bun src/index.ts` | Reuse last saved recipe, or start with generic default |
| `bun src/index.ts <path>` | Load recipe from local file |
| `bun src/index.ts <url>` | Fetch recipe from HTTP URL |
| `bun src/index.ts --no-recipe` | Reset to default generic assistant |

The loaded recipe is saved to `$DATA_DIR/.recipe.json` (mode 0600) in its
**unresolved** form — `${VAR}` references kept, a URL system prompt kept as
the URL — and re-resolved against the current environment on each bare start,
so rotated credentials take effect on restart. The exceptions are fleet
children's `recipe` and extensions' `path`, which are stored resolved: keep
secrets out of them, since a `${TOKEN}` in a child-recipe URL lands in the
snapshot as the token itself. Treat the data directory as sensitive anyway —
it holds the agent's history, and a fleet parent currently persists its
children's resolved `env` there (#162). A variable that has disappeared since
fails the start loudly instead of falling back to the default recipe.

### System prompt from URL

If `systemPrompt` is an HTTP(S) URL (no spaces or newlines), it's fetched as plain text:

```json
{
  "agent": {
    "systemPrompt": "https://example.com/prompts/researcher.md"
  }
}
```

### MCP servers

A recipe's `mcpServers` decides which servers the agent gets. An entry can
define a server outright (`command` + `args`, or a `url`), or name
an id from **`mcpl-servers.json`** — a registry in the working directory
(edited with `/mcp add|remove|env`). Registry servers are **opt-in**: one
loads only when a recipe names its id. For a named id the registry supplies
the command, args and env, and the recipe entry may carry only policy fields —
no `command` or `url` needed: `channelSubscription`, `toolPrefix`, feature-set
and tool toggles, reconnect settings, a network `url`/`transport`/`token`,
`access`, `protocol`, `toolLifecycle` and `inheritEnv`
(`RECIPE_OVERRIDABLE_SERVER_FIELDS` in `src/mcpl-config.ts`).
An id-only entry the registry doesn't define is a startup error. Changes take
effect on restart.

Agents with `modules.mcplAdmin` can also deploy, restart and unload their own
servers; those are kept in `mcpl-servers.agent.json` and load regardless of
the recipe.

Per server, `requestTimeoutMs` raises the framework's JSON-RPC timeout (60 s
by default) for slow tools, and `agent.retry` passes a Membrane retry policy
through for flaky gateways.

#### Modern MCP servers

The host speaks two protocol families:
- **Legacy**: MCP 2024-11-05 plus the MCPL extensions (channels, feature sets, push events, context hooks). This covers every server described above.
- **Modern**: MCP 2026-07-28, as current MCP servers speak it.

A server's configuration decides which family it uses:

| Entry | Family |
|---|---|
| `command` (stdio) | legacy |
| `command` + `"protocol": "modern"` | modern, over stdio |
| `url` with `ws://` / `wss://` | legacy (MCPL over WebSocket) |
| `url` with `http://` / `https://` | modern, over Streamable HTTP |

```json
{
  "mcpServers": {
    "search": { "url": "https://tools.example/mcp", "access": "example-audience" },
    "local-files": { "command": "npx", "args": ["-y", "some-mcp-server"], "protocol": "modern", "requestTimeoutMs": 120000 }
  }
}
```

The family is never guessed by probing the server. A modern server that refuses 2026-07-28 fails its connect with the server's own error. On the legacy side:
- A server that answers `initialize` with any revision other than 2024-11-05 is refused, and the error names what was offered and what came back.
- A server that rejects 2024-11-05 outright (error `-32022`) gets an error naming the revisions it supports, with a hint to set `protocol: "modern"`.

A modern server offers tools only: the model calls its tools, and modules and scripts can call them directly. Rules that come with that:
- **Tool policy.** `toolPrefix`, `enabledTools` and `disabledTools` work as for any server.
- **MCPL-only policy is an error.** On a modern server, feature sets, capabilities, `channelSubscription`, `toolLifecycle`, `allowHostCommands`, `autofetch` and `shouldTriggerInference` are refused. So is `protocol` on any URL server, since the scheme already decides.
- **Deadline.** `requestTimeoutMs` is one deadline per tool call, an integer from 1 to 2³¹−1; `0` is refused here.
- **On timeout.** The call is cancelled and reported as possibly completed, never retried.
- **Credentials.** `token` and `access` become a bearer `Authorization` header. An `access` credential is cached and fetched fresh when the server answers 401.
- **Results.** Images come inline. Audio, binary and embedded resources are saved to the workspace under `tool-results/`, and links are shown, not fetched. A structured result (`structuredContent`) reaches scripts whole.

The same rules hold in `mcpl-servers.json`, the agent overlay and `mcpl_deploy`. The host checks every entry with agent-framework's own validation:
- a bad recipe or file entry stops startup;
- a bad overlay entry is skipped with a logged reason;
- `mcpl_deploy` refuses a bad entry before saving it.

`mcpl_list` and the web panel show each server's family, negotiated revision and transport (`modern@2026-07-28/http`).

Stdio servers do **not** inherit the host environment. A child gets agent-framework's allowlist (`CHILD_ENV_ALLOWLIST`: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `LANG`, `LC_*`, `TZ`, temp and XDG dirs, `DISPLAY`/`WAYLAND_DISPLAY`, TLS CA bundles, `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` in either case, and the Windows system variables), then the host's `DISCORD_SUPPRESSED_REACTIONS_BASELINE`, then the entry's `env`, then `AGENT_TIMEZONE`. A server that needs a value from `.env` must declare it, e.g. `"DISCORD_GUILD_ID": "${DISCORD_GUILD_ID}"`; a variable left only in `.env` is unset for the server.

Operator-owned recipe/file entries can set `inheritEnv: true` to pass the full host environment, including credentials. Prefer explicit `env` entries for needed variables. Explicit recipe `false` overrides file `true`; omission preserves the file's policy. Agent-owned `mcpl-servers.agent.json` overlays strip `inheritEnv`, including when replacing an operator-defined server. Put a full-inheritance grant in the recipe or operator server file instead.

Check legacy configuration variables before enabling full inheritance. For Discord MCPL, an inherited `DISCORD_SUPPRESS_REACTION_EMOJIS=""` seeds an explicit empty suppression list when its configured filters file does not yet exist; that durable file then overrides the protective baseline. Remove an unintended stale variable before the first startup, or configure the intended suppression in the filters file.

### Feature sets and tool names

An MCPL server declares feature sets, and each server entry chooses which of
them to enable:

- `enabledFeatureSets` **omitted**: every set the server declares is enabled,
  subject to the `uses` rule below.
- `enabledFeatureSets: []` in a recipe or in `mcpl-servers.json`: **no** set is
  enabled (deny-all). Only the agent's own `mcpl-servers.agent.json` reads an
  empty list as unset, since strict function calling makes some models send
  `[]` for "unspecified" (`resolveOverlayEntry` in `src/mcpl-config.ts`).
- A `*` in a pattern matches exactly one dot-separated segment (`memory.*`
  matches `memory.retrieval`, not `memory.a.b`). `disabledFeatureSets` wins
  over `enabledFeatureSets`.
- A set whose declaration has no `uses`, an empty one or an unrecognized
  value stays disabled whatever the lists say, as does one whose `uses` names
  a capability the server was not granted. Each such set is logged on stderr
  as `[mcpl] <server>/<set> disabled: …`.

The model sees an MCPL server's tools as **`mcpl--<serverId>--<tool>`**:
that is agent-framework's default prefix, and the host sets none of its own.
An entry's `toolPrefix` replaces the `mcpl--<serverId>` part. Tool-name
patterns elsewhere in a recipe match that model-facing form, so
`toolClassOverrides` keys and `toolLifecycle` `tools` narrowings are written
`mcpl--blender--*`, not `blender--*`. Host module tools are
`<module>--<tool>` (`fleet--send`). `enabledTools` and `disabledTools` are
the exception: they take bare names, as the server exports them.

### Tool lifecycle and tool classes (MCPL RFC-007 / RFC-008)

An MCPL server can follow the agent's calls to *other* tools: a desktop avatar picking up a prop while a shell command runs, or pointing where the agent clicks. It receives `tools/lifecycle` notifications (`started`, then `completed` / `failed` / `aborted`) and never tool results. Both permissions are **off by default**. A `toolLifecycle` block on the server's entry, in the recipe or in `mcpl-servers.json`, is the grant:

```json
"mcpServers": {
  "avatar": {
    "command": "node",
    "args": ["avatar-mcpl.mjs"],
    "toolLifecycle": {
      "observe": {},
      "inputs": { "classes": "default" }
    }
  }
}
```

- `observe` sends metadata (tool, class, provider, phase, duration). `{}` means every call. Narrow it with `tools` (patterns over model-facing names such as `mcpl--cua--*`, `*` = any run), `classes`, or `conversations` (agent names).
- `inputs` sends argument fields, but only the fields the server asks for with `tools/observe`. It needs a `tools` or `classes` term to deliver anything (`"default"` = computer, shell, files, web, media, body). It never carries `comms` or unclassed tools' arguments. `maxInputBytes` bounds the payload (default 16 KiB).

A tool's class comes from, in order:
1. the recipe's `toolClassOverrides`;
2. this host's table of its own module tools (`HOST_TOOL_CLASSES` in `src/tool-lifecycle-config.ts`) or the framework's built-ins;
3. the server's own `_meta["mcpl/class"]`.

Third-party MCP servers never declare a class, so class them in the recipe:

```json
"toolClassOverrides": {
  "mcpl--cua--*": ["computer"],
  "mcpl--blender--*": ["media"]
}
```

An unclassed tool is treated as the most restrictive class: observable that it ran, never what it was given.

To check what each tool ended up as, and which of the three sources decided it, run `/tools [agent]`, open the web UI's MCP tab, or `GET /debug/tool-classes`. With `mcplAdmin` enabled, the agent's `mcpl_list` shows the same for each server's tools.

Servers an agent deploys for itself (`mcpl-servers.agent.json`) can never hold either permission. The overlay denies `toolLifecycle` and strips any `toolLifecycle` block, as it already does for context hooks and server-initiated inference. To let such a server observe, the operator moves it into the recipe. These settings take effect with an agent-framework that includes tool lifecycle (anima-research/agent-framework#199); older ones ignore them.

### Included recipes

| Recipe | What it is |
|--------|-------------|
| [`recipes/mock-test.json`](recipes/mock-test.json) | Offline smoke test: mock provider, no credentials, loopback web UI |
| [`recipes/claude-export-revive.json`](recipes/claude-export-revive.json) | Continue a conversation imported from claude.ai ([guide](docs/claudeai-evacuation.md)) |
| [`recipes/triumvirate.json`](recipes/triumvirate.json) | Conductor supervising miner + reviewer + clerk as fleet children ([guide](recipes/TRIUMVIRATE-SETUP.md)) |
| [`recipes/knowledge-miner.json`](recipes/knowledge-miner.json) | Knowledge extraction from Zulip + GitLab + web search ([guide](recipes/SETUP.md)) |
| [`recipes/knowledge-reviewer.json`](recipes/knowledge-reviewer.json) | Critic pass and SME checklists over mined documents |
| [`recipes/clerk.json`](recipes/clerk.json) | Frontdesk agent that answers from the mined library on a Zulip channel |
| [`recipes/zulip-miner.json`](recipes/zulip-miner.json) | Zulip-only knowledge extraction |
| [`recipes/mcpl-editor-test.json`](recipes/mcpl-editor-test.json), [`webui-test.json`](recipes/webui-test.json), [`webui-fleet-test.json`](recipes/webui-fleet-test.json) | Development test recipes |

The production residents' recipes live in their own install directories, not
here; [`docs/AGENT-ONBOARDING.md`](docs/AGENT-ONBOARDING.md) shows the shape.

### Claude subscription provider

The default `anthropic` provider also runs on a Claude subscription (Pro/Max)
instead of an API key. Install Claude Code, generate a long-lived OAuth token
with `claude setup-token`, and export it as `ANTHROPIC_AUTH_TOKEN`:

```bash
export ANTHROPIC_AUTH_TOKEN=sk-ant-oat...
```

No recipe change is needed — any `anthropic` recipe works. When
`ANTHROPIC_AUTH_TOKEN` is set it takes precedence over `ANTHROPIC_API_KEY`
(requests never carry both). Connectome then sends the `oauth-2025-04-20`
beta header (merged with any `agent.anthropicBetas`) and prepends the Claude
Code identity block the subscription endpoint requires ahead of the recipe's
system prompt. Usage draws down the subscription's 5-hour and weekly windows
rather than per-token billing; the TUI status line and WebUI show them. When
the quota meter already has a reading that shows a spent window, a 429 parks
the agent until the window resets instead of retrying; without a reading
(e.g. the first 429 in a headless run with no viewer, or an unreadable usage
endpoint) it follows the normal retry path.

### ChatGPT subscription provider

Install the Codex CLI, sign in with `codex login`, then select the subscription
transport in a recipe:

```json
{
  "agent": {
    "provider": "openai-codex",
    "model": "gpt-5.4",
    "codex": { "fastMode": false },
    "systemPrompt": "You are a helpful assistant."
  }
}
```

Connectome asks the Codex app-server to refresh the ChatGPT login and starts a
device-code flow if needed. No `OPENAI_API_KEY` is used for this provider. Use
`/fast on` or `/fast off` at runtime. Connectome requests Codex's Fast tier and
warns if the service reports that it fell back to Standard; Fast mode consumes
subscription credits at a higher rate when applied. Quota windows are shown
the same way as for the Claude subscription. See
[`docs/subscription-transport.md`](docs/subscription-transport.md).

### OpenAI-compatible endpoints (Ollama, vLLM, Together, Groq, NanoGPT, ...)

Any server speaking the OpenAI chat-completions API works through the generic
`openai-compatible` provider — the recipe names the endpoint and the model:

```json
{
  "agent": {
    "provider": "openai-compatible",
    "baseUrl": "http://localhost:11434/v1",
    "model": "qwen3:32b",
    "systemPrompt": "You are a helpful assistant."
  }
}
```

The API key is read from `OPENAI_COMPATIBLE_API_KEY` only — deliberately no
`OPENAI_API_KEY` fallback: `baseUrl` is recipe-controlled, and a real OpenAI
credential must never be sent silently to an arbitrary endpoint. Local
servers usually need none. `agent.model` is required —
there is no default model for an arbitrary endpoint. Tool calls use the
standard `tool_calls` format, so the endpoint must support function calling
for tool-using recipes. Provider-side prompt caching and cache accounting
depend on what the endpoint reports.

### Other providers

| `agent.provider` | Credentials | Notes |
|---|---|---|
| `bedrock` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` (default `us-west-2`) | Claude on AWS — including models retired from the first-party API. `BEDROCK_BASE_URL` routes through an inference gateway. Prompt caching is enabled per model where Bedrock supports it; `agent.promptCaching` overrides. |
| `openai-responses` | `OPENAI_API_KEY` (`OPENAI_BASE_URL` optional) | OpenAI Platform, Responses API. |
| `openrouter` | `OPENROUTER_API_KEY` | |
| `mock` | none | Echoes the last user message by default; scripted replies and timing are set under `agent.mock` ([below](#mock-provider)). Calls are still logged. |

Every provider's calls are logged to `$DATA_DIR/llm-calls.<iso>.jsonl`.
`agent.formatter: "anthropic-xml"` with `agent.prefillUserMessage` reproduces
classic prefill-style prompting for agents migrated from prefill-era bots.

### Mock provider

`agent.provider: "mock"` runs membrane's `MockAdapter`: the full host loop
with no credentials and no provider spend. `agent.mock` configures it:

| Key | Default | Meaning |
|---|---|---|
| `echoMode` | `true` | Reply `[Echo] <last user message>`. |
| `defaultResponse` | membrane's canned text | Reply when not echoing and the queue is empty. A non-empty string. |
| `responseQueue` | none | Replies returned in order, one per provider call, before the echo or `defaultResponse` takes over. Every call through the adapter takes one, including auxiliary calls such as compression and session naming. Non-empty strings. |
| `completeDelayMs` | `10` | Delay before a non-streamed reply, in ms. Agent turns stream; auxiliary calls take this path. |
| `streamChunkDelayMs` | `5` | Delay between streamed chunks, in ms. There is none before the first chunk. |
| `streamChunkSize` | `10` | Characters per streamed chunk. A positive integer. |

A streamed reply of `L` characters takes about
`(ceil(L / streamChunkSize) - 1) × streamChunkDelayMs`, so a slow agent turn
is a long reply with small chunks. This one holds the first turn for about
2 s, which leaves time to send more events while it is in flight and see how
they coalesce:

```json
"agent": {
  "provider": "mock",
  "mock": {
    "echoMode": false,
    "responseQueue": ["first reply", "second reply"],
    "defaultResponse": "done",
    "streamChunkSize": 1,
    "streamChunkDelayMs": 200
  }
}
```

Unknown keys under `agent.mock` are reported in the recipe's
unknown-key warning, like those at the other levels.

## What it provides

**Keeping one agent alive**

- **Autobiographical memory** — context-manager folds older history into
  memories the agent writes in its own voice, fitted to a context budget the
  agent and operator can change at runtime (`agent_settings`, WebUI
  Settings); nothing is deleted from Chronicle
- **Prompt-cache economics** — cache-stable folding, a 1-hour cache by
  default (`agent.cacheTtl`), and `agent.cacheKeepalive` (on by default for
  `anthropic`) refreshing an idle agent's cache before it expires
- **Cost and quota** — a billing-grade call ledger with a cache verdict per
  call; on subscriptions, quota windows instead of dollars and parking on a
  spent window
- **Attention** — the wake gate (`modules.wake`, on) decides which events
  start a turn; agents edit their own rules. `subscriptionGc` (on) closes
  channels that flood context; `channelMode` (on) switches a channel between
  mentions-only and debounced ambient. See
  [`docs/ATTENTION-AND-GATING.md`](docs/ATTENTION-AND-GATING.md)
- **Workspace** (`modules.workspace`, on) — mounted directories backed by
  Chronicle: the agent's durable, verbatim notes. Default mounts `input`
  (read-only `./input`) and `products` (read-write `./output`)
- **History** (opt-in, `modules.history`) — the agent searches and extracts
  from its own uncompressed record. The object form
  `{ "semantic": { "url": … } }` adds `history--semantic_search`:
  meaning-based search over raw messages and memories, through a shared
  embed service (startup fails if the installed agent-framework predates
  0.20). The
  index namespace is always `<prefix>/<session id>`, the prefix defaulting to
  the agent name; `token` takes `${VAR}`; plain `http` is refused outside
  loopback and the tailnet unless `allowInsecureHttp: true`; unknown keys fail
  the load. Sync sends the raw record — including the agent's private notes
  unless `includePrivateTools: false` — and `/session delete` does not remove
  the remote index
- **Shared instructions** (opt-in, `modules.instructions`) — see below
- **Identity** (opt-in, `modules.identity`) — the agent's own key-based
  identity, used to obtain access to services without credentials entering
  its context
- **Conversations** (top-level `conversations` — **deprecated, not
  recommended**) — per-channel conversation forks spawned from a dormant trunk
  agent. Being retired
  ([agent-framework#235](https://github.com/anima-research/agent-framework/issues/235)):
  its `'mention'` bind/trigger rule, the default for channels, reads
  `metadata.mentioned`, which discord-mcpl does not set, so on Discord
  channels an @-mention never binds or triggers a fork. Still works; the host
  logs a `[deprecated]` line at startup
- **Subconscious** (top-level `subconscious`) — a secondary agent that can
  `tune_out` channels; **code execution** (top-level `codeExecution`) — a
  Python tool runner
- **Activity** (`modules.activity`) typing indicators and a **TTS relay**
  (`modules.ttsRelay`) for voice clients
- **Extensions** (top-level `extensions`) — local modules that register
  custom context strategies or framework modules

**Looking after it**

- **Web UI** (`modules.webui`) — browser operator console, below
- **TUI, readline and batch modes** — OpenTUI interactive terminal, `--no-tui` for a plain prompt, or piped stdin for a one-shot batch run
- **Headless mode** — `--headless`: no terminal, JSONL over a Unix socket; how residents run under a supervisor
- **Time-travel** — Chronicle-backed undo/redo, checkpoints, branch exploration; in the web UI, rolling back to a message and suppressing messages
- **Session management** — isolated sessions with auto-naming
- **Ops alerts** — compression quarantine, refusal streaks, inference exhaustion and more surface as `ops:alert` traces, `logs/failures.log` records, and an optional webhook (`CONNECTOME_OPS_WEBHOOK`)
- **Importers** — claude.ai exports, Claude Code transcripts and Codex rollouts become sessions ([guides above](#what-people-run-on-it))

**More agents**

- **Fleets** (opt-in, `modules.fleet`) — a conductor launches and supervises other recipes as headless child processes; one agent tree across processes in both UIs ([`docs/fleet-protocol.md`](docs/fleet-protocol.md))
- **Subagent forking** (opt-in, `modules.subagents`) — spawn/fork parallel in-process agents, shown in the fleet tree (Tab)
- **Persistent lessons** (opt-in, `modules.lessons`) — knowledge store with confidence scores and tags. Automatic retrieval-injection of lessons into context (`modules.retrieval`) is a separate opt-in — it adds per-turn context churn and retrieval-model calls, so enable it only for agents that actually curate a lesson library

For `openai-responses` and `openai-codex`, an object-valued
`modules.retrieval` can set `reasoningEffort` (`none`, `minimal`, `low`,
`medium`, `high`, `xhigh`, or `max`) independently of the primary agent.
Retrieval calls are independent one-shot requests, so there is no separate
retrieval reasoning-context setting. When `reasoningEffort` is configured,
`model` must also be set explicitly: the historical retrieval default is a
Claude model and cannot be sent through an OpenAI adapter. Anthropic/Claude
uses different native thinking controls and does not accept this OpenAI-shaped
option.

### Shared instructions

`modules.instructions` keeps a living instructions document (CLAUDE.md
analogue) in a workspace mount and injects it into every agent's context on
every turn — the resident agent and all ephemeral subagents. Edits take effect
on the next turn; nothing is persisted to history. Defaults: path
`instructions/AGENTS.md`, `position: "system"`, 32 KiB cap (reads are bounded
to the cap); a missing file is fail-open (no injection, warn once), while a
path naming a nonexistent mount fails at recipe load — including on the
implicit default workspace (`input` + `products`), whose mount set can never
satisfy the default path, so declare an `instructions` mount explicitly.

**Who edits, and how it propagates**: the module reads *disk*; agent
`workspace--write`/`edit` land in Chronicle and reach disk only on an
`autoMaterialize: true` mount — validation therefore requires it on a
read-write instructions mount. On a read-only mount the flow reverses:
human/deploy edits to disk reach the injection, but not `workspace--read`
(which serves Chronicle) — prefer routing human feedback through conversation
and letting the agent make the edit. Symlinks that lead outside the mount are
rejected (realpath containment), never injected.

**Cache note**: at `position: "system"` the block lives in every agent's
prompt-cache prefix, so each edit is a fleet-wide cache cold start on the next
turn — curate in batches, or use `afterUser` for cache-cheap, lower-salience
injection. Compared to **lessons** (`modules.lessons`): lessons are a
structured, confidence-scored store with model-driven retrieval; instructions
are one free-form curated document, always present verbatim.

## Prerequisites

- [Bun](https://bun.sh/) runs the host; [Node.js](https://nodejs.org/) 20+ and npm build the web UI
- No Rust toolchain: `@animalabs/chronicle` ships prebuilt native binaries
- Credentials for one provider: an Anthropic API key, a Claude subscription
  OAuth token (`claude setup-token`), an OpenAI or OpenRouter key, AWS
  credentials for Bedrock, the Codex CLI signed in with ChatGPT — or none, for
  `mock` and keyless local endpoints

### Install

```bash
bun install      # or npm install; the postinstall step builds the web UI
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | (required for `anthropic` unless `ANTHROPIC_AUTH_TOKEN` is set) | Anthropic API key |
| `ANTHROPIC_AUTH_TOKEN` | — | Claude subscription OAuth token (`claude setup-token`); takes precedence over `ANTHROPIC_API_KEY` |
| `ANTHROPIC_BASE_URL` | Anthropic API | Route Anthropic calls through a gateway |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL` | — | `openai-responses` recipes |
| `OPENAI_COMPATIBLE_API_KEY` | — | Key for `openai-compatible` recipes (no `OPENAI_API_KEY` fallback by design); omit for local servers |
| `OPENROUTER_API_KEY` | — | `openrouter` recipes |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` | region `us-west-2` | `bedrock` recipes |
| `BEDROCK_BASE_URL` | — | Route Bedrock calls through a gateway |
| `CODEX_BINARY` | `codex` | Codex CLI executable for `openai-codex` subscription auth |
| `CODEX_HOME` | `~/.codex` | Codex credential/config directory |
| `CODEX_BASE_URL` | ChatGPT Codex backend | Optional subscription transport override |
| `MODEL` | from recipe, else `claude-opus-4-6` (`gpt-5.4` for `openai-codex`) | Override model (wins over the recipe) |
| `DATA_DIR` | `./data` | Session, recipe and log storage |
| `AGENT_TIMEZONE` | process timezone | Agent-facing clock when the recipe sets no `agent.timezone` |
| `SLEEP_PRIVILEGED_FILE` | `./sleep-privileged.json` | Who may wake the agent during `sleep` |
| `OBSERVERS_FILE` | `$DATA_DIR/observers.json` | Web UI observer grants |
| `IDENTITY_KEY_FILE`, `IDENTITY_HOME` | `$DATA_DIR/identity-key.pem`, `id.animalabs.ai` | `modules.identity` |
| `CONNECTOME_OPS_WEBHOOK` | — | Webhook for ops alerts |
| `COUNT_TOKENS_MODEL` | the agent's model | Override the model used for exact token counts in the context-makeup panel |
| `LLM_CALLS_FULL_PAYLOADS` | off | `1`/`true`: keep the full request on every llm-calls log entry (large) |
| `GATE_TELEMETRY` | off | `1`: send `x-gate-*` telemetry headers — only when `ANTHROPIC_BASE_URL` is also set |

Recipes may reference any further variables they need as `${VAR}` (for
example `WEBUI_USERNAME` / `WEBUI_PASSWORD`, `ZULIP_CHANNEL`, `GITLAB_TOKEN`
in the shipped recipes).

## Running

```bash
bun src/index.ts                    # Interactive TUI
bun src/index.ts --no-tui           # Readline mode
echo "Hello" | bun src/index.ts     # Batch mode: run each line, then stop
bun src/index.ts <recipe> --headless                     # Daemon: JSONL IPC over $DATA_DIR/ipc.sock, no terminal
bun src/index.ts <recipe> --headless --exit-when-idle    # One-shot: exit once the agent goes idle
bun src/index.ts <recipe> --headless --socket-path <p>   # Custom socket path
bun --watch src/index.ts            # Dev mode
```

Put the recipe before other arguments: the first argument that doesn't start
with `--` is taken as the recipe. Headless mode, its files and its protocol
are described in [`docs/fleet-protocol.md`](docs/fleet-protocol.md).

Whenever stdin is not a TTY and `--headless` is absent, the host runs in
**batch mode**, with or without `--no-tui`: it reads stdin to EOF, runs each
line, then stops the agent and closes its MCPL servers. `reconnect: true` does
not bring them back, because an explicit close is not a failure. That
includes a host started by a supervisor or `nohup` with stdin redirected, so
anything meant to keep serving needs `--headless`. The host prints a
`[batch]` line at the start and before the teardown. If the recipe enables
the web UI, its server outlives the agent by design, so the process keeps
running, with no agent data behind the page, until interrupted.

## Web UI

Enable it in the recipe. The host serves the SPA and its WebSocket protocol on
port 7340 and binds `0.0.0.0` by default; a non-loopback bind **refuses to
start without basic-auth credentials**, so either bind loopback for local use:

```json
"modules": { "webui": { "host": "127.0.0.1" } }
```

or supply credentials for a remote deployment:

```json
"modules": { "webui": { "basicAuth": { "username": "${WEBUI_USERNAME}", "password": "${WEBUI_PASSWORD}" } } }
```

Build the SPA bundle once with `bun run build:web` (also runs on install via
postinstall). Deployment behind a reverse proxy, observer access and all
endpoints are covered in [`docs/webui-deployment.md`](docs/webui-deployment.md).

- Chat with full interiority: thinking blocks, tool calls + results, live streaming, inline images
- Sidebar: agent/fleet tree, lessons, MCPL servers (live status, tool classes and registry), workspace files, context makeup + compression coverage, Settings (live context budget with dry runs), Pins (protected ranges), Health (alerts, per-call stats, compression debt) — each can inspect any fleet child via the "inspecting:" selector
- Live surgery: roll back to a message, suppress messages, quiesce/resume the host; every action is recorded in an operator log ([`docs/webui-live-surgery.md`](docs/webui-live-surgery.md))
- Header branch chip opens the Chronicle branch lineage tree (checkout from the UI)
- Ops alerts (compression quarantine, refusal streaks, inference-exhausted) render as persistent banner rows
- Usage panel: per-agent costs and a billing-grade call ledger with cache verdicts; quota windows on subscriptions
- `/healthz` (health JSON for doctor/fleet tooling), `/quota`, `/curve` (compression-curve visualization), `/debug/context/*` ([`docs/debug-context-api.md`](docs/debug-context-api.md)), `/debug/tool-classes` — authenticated like the rest of the surface, and answerable by a fleet child with `?scope=<child>`
- `/debug/retrieval/view` — operator-only per-run lesson selection viewer (see `docs/retrieval-traces.md`)
- Read-only observer access via Ed25519 device keys with per-grant scopes; the agent can grant and revoke observers itself

For SPA development: `cd web && bun run dev` proxies the Vite dev server onto a
locally running host.

## Slash commands

The same commands work in the TUI, readline mode, the web UI and over the
headless socket.

| Command | Effect |
|---------|--------|
| `/help` | List all commands |
| `/quit`, `/q` | Exit (exports lessons if the lessons module is loaded; asks first if fleet children are running) |
| `/recipe` | Show current recipe info |
| `/status` | Show agent state, branch, queue depth |
| `/usage` | Show session token usage and costs |
| `/clear` | Clear this client's display (history and context are kept) |
| `/lessons` | Show lesson library sorted by confidence |
| `/export` | Export lessons to `./output/` (JSON + markdown) |
| `/newtopic [context]` | Reset the head window for a new topic |
| `/nudge [agent]` | Run inference on the current context without a new event |
| `/puppet <tool> [json]` | Admin: execute a tool as the agent and store the call/result pair |
| `/undo` | Revert to state before last agent turn |
| `/redo` | Re-apply undone action |
| `/checkpoint [name]` | Save current state (no name: list checkpoints; held for this session) |
| `/restore [name]` | Restore to checkpoint |
| `/branches` | List Chronicle branches and checkpoints |
| `/checkout <name>` | Switch to branch |
| `/branchto <msgId>` | Branch from a specific message |
| `/history [n]` | Show recent state transitions |
| `/find <text>` | Search messages for text |
| `/mcp list` | List servers in `mcpl-servers.json` |
| `/mcp add <id> <cmd> [args...]` | Add or overwrite a registry server (keeps its env) |
| `/mcp remove <id>` | Remove a registry server |
| `/mcp env <id> KEY=VALUE [...]` | Set env vars on a registry server |
| `/tools [agent]` | Each tool's effective MCPL class and where it came from (recipe override, host table, server `_meta`, or unclassed) |
| `/budget [tokens]` | Show/set stream token budget |
| `/fast [on\|off\|status]` | Toggle Codex subscription Fast mode |
| `/session [list\|new\|switch\|rename\|delete]` | Session management; `delete` requires `--confirm` |
| `/fleet [list\|status\|view\|peek\|stop\|restart]` | Fleet children (see [`docs/fleet-protocol.md`](docs/fleet-protocol.md)) |

Commands that move the head (`/undo`, `/redo`, `/checkout`, `/restore`,
`/branchto`, `/newtopic`) are refused while a turn is in flight.

## TUI controls

| Key | Action |
|-----|--------|
| `Enter` | Send message or command |
| `Alt+Enter` / `Ctrl+J` | Newline |
| `Esc` | Interrupt agent (chat) / back (fleet/peek) |
| `Tab` / `Ctrl+F` | Toggle fleet view (when subagents or a fleet are enabled) |
| `Ctrl+B` | Send the running stream and sync subagents to the background |
| `Ctrl+V` | Toggle verbose mode |
| `Ctrl+C` | Exit (asks first if fleet children are running; press again to force) |
| `@child message` | Send a line straight to a fleet child, bypassing the conductor |

**Fleet view** (Tab):

| Key | Action |
|-----|--------|
| Up/Down | Navigate tree |
| Enter/Right | Expand/collapse |
| Left | Collapse |
| `p` | Peek the selected node's live stream — local subagents, fleet children, or a single agent/subagent inside a fleet child |
| `Delete` / `Backspace` | Stop the selected subagent or fleet child |
| `r` | Restart the selected fleet child |

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the host is built, and
[`docs/README.md`](docs/README.md) for every guide.

## Dependencies

| Package | Source | Role |
|---------|--------|------|
| `@animalabs/agent-framework` | [npm](https://www.npmjs.com/package/@animalabs/agent-framework) | Event-driven agent orchestration |
| `@animalabs/context-manager` | [npm](https://www.npmjs.com/package/@animalabs/context-manager) | Context window management and compression |
| `@animalabs/chronicle` | [npm](https://www.npmjs.com/package/@animalabs/chronicle) | Branchable event store (Rust + N-API, prebuilt) |
| `@animalabs/membrane` | [npm](https://www.npmjs.com/package/@animalabs/membrane) | LLM provider abstraction |
| `@opentui/core` | [npm](https://www.npmjs.com/package/@opentui/core) | Terminal UI (Zig native core) |
