# connectome-host

A general-purpose agent host with recipe-based configuration. Point it at any use case by loading a recipe — a JSON file that defines the system prompt, MCP servers, modules, and agent settings. Interact through the web UI (browser operator console), the interactive TUI, or run headless under a fleet parent.

Built on the Connectome stack: [@animalabs/agent-framework](https://github.com/anima-research/agent-framework) + [@animalabs/context-manager](https://github.com/anima-research/context-manager) + [@animalabs/chronicle](https://github.com/anima-research/chronicle) + [@animalabs/membrane](https://github.com/anima-research/membrane).

## Quick start

```bash
# Prerequisites: Bun, Rust toolchain, and provider credentials
export ANTHROPIC_API_KEY=sk-ant-...

bun install
bun src/index.ts                              # generic assistant
bun src/index.ts recipes/zulip-miner.json     # load a recipe
bun src/index.ts https://example.com/r.json   # recipe from URL
```

## Recipes

A recipe is a JSON file that configures everything domain-specific:

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
      "env": { "API_KEY": "..." }
    }
  },
  "modules": {
    "wake": true,
    "files": { "namespace": "products" }
  },
  "sessionNaming": {
    "examples": ["Thread Archaeology", "Pipeline Debug"]
  }
}
```

`agent.timezone` is an IANA zone used only for times rendered to the agent.
Chronicle and MCPL protocol timestamps remain epoch/UTC. If the recipe omits
it, `AGENT_TIMEZONE` is used, then the process timezone.

**Memory defaults**: `agent.strategy` may be omitted entirely. The default is
the autobiographical memory strategy with adaptive resolution, **KV-stable
folding** (compile plans that preserve prompt-cache prefixes), compression by
the agent's own model, and summaries voiced as the agent itself
(`summaryParticipant` defaults to `agent.name`). Set a `strategy` block only
to tune windows/budgets or opt into a different strategy type — see
`docs/AGENT-ONBOARDING.md` for sizing guidance on long-lived agents.

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
calling a send tool, and nothing else leaks.

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

The loaded recipe is saved to `data/.recipe.json` and reused on subsequent bare starts.

### System prompt from URL

If `systemPrompt` is an HTTP(S) URL (no spaces or newlines), it's fetched as plain text:

```json
{
  "agent": {
    "systemPrompt": "https://example.com/prompts/researcher.md"
  }
}
```

### MCP server merging

A recipe loads a server from `mcpl-servers.json` by naming its id under `mcpServers`. The file supplies the spawn command and credentials. The recipe may override policy fields: `toolPrefix`, feature-set and tool toggles, reconnect settings, WebSocket transport, `access` and `toolLifecycle` (`RECIPE_OVERRIDABLE_SERVER_FIELDS` in `src/mcpl-config.ts`). The recipe entry for a file server may carry only policy fields; it needs no `command` or `url`. An id-only entry that the file doesn't define is a startup error. A recipe can also define a server the file doesn't have, by giving its own `command` or `url`.

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

- `observe` sends metadata (tool, class, provider, phase, duration). `{}` means every call. Narrow it with `tools` (name patterns, `*` = any run), `classes`, or `conversations` (agent names).
- `inputs` sends argument fields, but only the fields the server asks for with `tools/observe`. It needs a `tools` or `classes` term to deliver anything (`"default"` = computer, shell, files, web, media, body). It never carries `comms` or unclassed tools' arguments. `maxInputBytes` bounds the payload (default 16 KiB).

A tool's class comes from, in order:
1. the recipe's `toolClassOverrides`;
2. this host's table of its own module tools (`HOST_TOOL_CLASSES` in `src/tool-lifecycle-config.ts`) or the framework's built-ins;
3. the server's own `_meta["mcpl/class"]`.

Third-party MCP servers never declare a class, so class them in the recipe:

```json
"toolClassOverrides": {
  "cua--*": ["computer"],
  "blender--*": ["media"]
}
```

An unclassed tool is treated as the most restrictive class: observable that it ran, never what it was given.

Servers an agent deploys for itself (`mcpl-servers.agent.json`) can never hold either permission. The overlay denies `toolLifecycle` and strips any `toolLifecycle` block, as it already does for context hooks and server-initiated inference. To let such a server observe, the operator moves it into the recipe. These settings take effect with an agent-framework that includes tool lifecycle (anima-research/agent-framework#199); older ones ignore them.

### Included recipes

| Recipe | Description |
|--------|-------------|
| [`recipes/zulip-miner.json`](recipes/zulip-miner.json) | Knowledge extraction from Zulip workspaces |
| [`recipes/knowledge-miner.json`](recipes/knowledge-miner.json) | Multi-source extraction from Zulip + Notion + GitLab |

See [`recipes/SETUP.md`](recipes/SETUP.md) for a detailed setup guide for the knowledge-miner recipe.

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
subscription credits at a higher rate when applied.

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

## What it provides

- **Web UI**: browser operator console (`modules.webui`) — live chat with full interiority (thinking, tool calls, streaming), agent/fleet tree, context makeup + compression coverage, call ledger with cache verdicts and billing-grade costs, health/ops alerts, Chronicle branch tree, lessons, MCPL config, workspace files; scoped read-only observer access via device keys
- **TUI + readline modes**: OpenTUI interactive terminal or `--no-tui` for pipes/CI
- **Subagent forking** (opt-in, `modules.subagents` — **deprecated, not recommended**: its fleet-status HUD relies on context injection, see below): Spawn/fork parallel agents with fleet tree view (Tab to toggle)
- **Persistent lessons** (opt-in, `modules.lessons`): Knowledge store with confidence scores and tags. Automatic retrieval-injection of lessons into context (`modules.retrieval`) is a separate opt-in that is **deprecated and not recommended** — it relies on context injection (see below) and adds retrieval-model calls; prefer the lesson tools
- **Time-travel**: Chronicle-backed undo/redo, named checkpoints, branch exploration
- **Session management**: Isolated sessions with auto-naming
- **MCPL support**: Connect any MCP/MCPL server; wake subscriptions for selective event triggering
- **File products**: Write reports and documents, materialize to disk
- **Shared instructions** (opt-in, `modules.instructions` — **deprecated, not recommended**: it relies on context injection, see below; put stable instructions in `agent.systemPrompt`): a living instructions document (CLAUDE.md analogue) kept in a workspace mount and injected into every agent's context on every turn — the resident agent and all ephemeral subagents. Edits take effect on the next turn; nothing is persisted to history. Defaults: path `instructions/AGENTS.md`, `position: "system"`, 32 KiB cap (reads are bounded to the cap); a missing file is fail-open (no injection, warn once), while a path naming a nonexistent mount fails at recipe load — including on the implicit default workspace (`input` + `products`), whose mount set can never satisfy the default path, so declare an `instructions` mount explicitly. **Who edits, and how it propagates**: the module reads *disk*; agent `workspace--write`/`edit` land in Chronicle and reach disk only on an `autoMaterialize: true` mount — validation therefore requires it on a read-write instructions mount. On a read-only mount the flow reverses: human/deploy edits to disk reach the injection, but not `workspace--read` (which serves Chronicle) — prefer routing human feedback through conversation and letting the agent make the edit. Symlinks that lead outside the mount are rejected (realpath containment), never injected. **Cache note**: at `position: "system"` the block lives in every agent's prompt-cache prefix, so each edit is a fleet-wide cache cold start on the next turn — curate in batches, or use `afterUser` for cache-cheap, lower-salience injection. Compared to **lessons** (`modules.lessons`): lessons are a structured, confidence-scored store with model-driven retrieval; instructions are one free-form curated document, always present verbatim

> **Deprecated: context injection and the modules built on it.** `modules.subagents`, `modules.retrieval` and `modules.instructions` deliver content through context injection (module `gatherContext` / MCPL `beforeInference`), which is deprecated ([agent-framework#171](https://github.com/anima-research/agent-framework/issues/171)): injected blocks are per-compile overlays — never stored, re-anchored on every compile — so they break prompt-cache prefixes across activations (head-only cache hits on OpenAI lanes). They still work, and the host logs a `[deprecated]` line at startup for each one a recipe enables; don't enable them in new recipes.

For `openai-responses` and `openai-codex`, an object-valued
`modules.retrieval` can set `reasoningEffort` (`none`, `minimal`, `low`,
`medium`, `high`, `xhigh`, or `max`) independently of the primary agent.
Retrieval calls are independent one-shot requests, so there is no separate
retrieval reasoning-context setting. When `reasoningEffort` is configured,
`model` must also be set explicitly: the historical retrieval default is a
Claude model and cannot be sent through an OpenAI adapter. Anthropic/Claude
uses different native thinking controls and does not accept this OpenAI-shaped
option.

## Prerequisites

- [Node.js](https://nodejs.org/) 20+ and [Bun](https://bun.sh/) runtime
- An Anthropic API key, a Claude subscription OAuth token (`claude setup-token`), an OpenAI API key, or the Codex CLI signed in with ChatGPT

### Install

```bash
npm install
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | (required unless `ANTHROPIC_AUTH_TOKEN` is set) | Anthropic API key |
| `ANTHROPIC_AUTH_TOKEN` | — | Claude subscription OAuth token (`claude setup-token`); takes precedence over `ANTHROPIC_API_KEY` |
| `OPENAI_API_KEY` | — | OpenAI Platform key for `openai-responses` recipes |
| `OPENAI_COMPATIBLE_API_KEY` | — | Key for `openai-compatible` recipes (no `OPENAI_API_KEY` fallback by design); omit for local servers |
| `CODEX_BINARY` | `codex` | Codex CLI executable for `openai-codex` subscription auth |
| `CODEX_HOME` | `~/.codex` | Codex credential/config directory |
| `CODEX_BASE_URL` | ChatGPT Codex backend | Optional subscription transport override |
| `MODEL` | from recipe or provider default | Override model |
| `DATA_DIR` | `./data` | Session and recipe storage |

## Running

```bash
bun src/index.ts                    # Interactive TUI
bun src/index.ts --no-tui           # Readline mode
bun src/index.ts --headless         # Daemon: JSONL IPC over unix socket, no terminal
echo "Hello" | bun src/index.ts     # Piped mode
bun --watch src/index.ts            # Dev mode
```

## Web UI

Enable with `"modules": { "webui": true }` (or `{ "port": 7340, "host": "0.0.0.0" }`)
in the recipe. The host serves the SPA and its WebSocket protocol on port 7340;
non-loopback binds require basic-auth credentials. Build the SPA bundle once with
`bun run build:web` (also runs on `npm install` via postinstall).

- Chat with full interiority: thinking blocks, tool calls + results, live streaming
- Sidebar: agent/fleet tree, lessons, MCPL servers, workspace files, context makeup + compression coverage, health (runtime settings, failure streaks, compression quarantine)
- Header branch chip opens the Chronicle branch lineage tree (checkout from the UI)
- Ops alerts (compression quarantine, refusal streaks, inference-exhausted) render as persistent banner rows
- Usage panel: per-agent costs and a billing-grade call ledger with cache verdicts
- `/curve` — compression-curve visualization; `/healthz` — liveness JSON for doctor/fleet tooling
- `/debug/retrieval/view` — operator-only per-run lesson selection viewer (see `docs/retrieval-traces.md`)
- Read-only observer access via Ed25519 device keys with per-grant scopes (see `docs/webui-deployment.md`)

For SPA development: `cd web && bun run dev` proxies the Vite dev server onto a
locally running host.

## Slash commands

| Command | Effect |
|---------|--------|
| `/help` | List all commands |
| `/recipe` | Show current recipe info |
| `/status` | Show agent state, branch, queue depth |
| `/lessons` | Show lesson library sorted by confidence |
| `/newtopic [context]` | Reset context window for a new topic |
| `/clear` | Clear conversation display |
| `/undo` | Revert to state before last agent turn |
| `/redo` | Re-apply undone action |
| `/checkpoint <name>` | Save current state |
| `/restore <name>` | Restore to checkpoint |
| `/branches` | List Chronicle branches |
| `/checkout <name>` | Switch to branch |
| `/history` | Show recent message history |
| `/mcp list` | List MCPL servers |
| `/mcp add <id> <cmd> [args...]` | Add or overwrite a server |
| `/mcp remove <id>` | Remove a server |
| `/mcp env <id> KEY=VALUE [...]` | Set env vars on a server |
| `/budget [tokens]` | Show/set stream token budget |
| `/fast [on\|off\|status]` | Toggle Codex subscription Fast mode |
| `/session list\|new\|switch\|rename\|delete` | Session management |
| `/quit` | Exit |

## TUI controls

| Key | Action |
|-----|--------|
| `Enter` | Send message or command |
| `Esc` | Interrupt agent (chat) / back (fleet/peek) |
| `Tab` | Toggle fleet view (subagent tree) |
| `Ctrl+V` | Toggle verbose mode |
| `Ctrl+C` | Exit |

**Fleet view** (Tab):

| Key | Action |
|-----|--------|
| Up/Down | Navigate tree |
| Enter/Right | Expand/collapse |
| Left | Collapse |
| `p` | Peek the selected node's live stream — local subagents, fleet children, or a single agent/subagent inside a fleet child |
| `Delete` | Stop a running subagent |

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed technical documentation.

## Dependencies

| Package | Source | Role |
|---------|--------|------|
| `@animalabs/agent-framework` | [npm](https://www.npmjs.com/package/@animalabs/agent-framework) | Event-driven agent orchestration |
| `@animalabs/context-manager` | [npm](https://www.npmjs.com/package/@animalabs/context-manager) | Context window management and compression |
| `@animalabs/chronicle` | [npm](https://www.npmjs.com/package/@animalabs/chronicle) | Branchable event store (Rust + N-API) |
| `@animalabs/membrane` | [npm](https://www.npmjs.com/package/@animalabs/membrane) | LLM provider abstraction |
| `@opentui/core` | [npm](https://www.npmjs.com/package/@opentui/core) | Terminal UI (Zig native core) |
