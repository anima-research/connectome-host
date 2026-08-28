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
    "maxTokens": 16384,
    "retirement": {
      "enabled": true,
      "confirmationDelayMs": 60000
    }
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

`agent.retirement.enabled` installs Connectome Host's protected
`resident--lifecycle` tool for this configured resident. The Host owns the
wording, fresh challenge, expiry, memory-health checks, and separate
confirmation turn; Agent Framework owns only the neutral irreversible seal and
enforcement primitive. The cooling-off floor is 60 seconds by default and
there is no human approval step. Set
`confirmationDelayMs` to another positive value below `confirmationTtlMs` when
the residence needs a different policy. Confirmation prevents future inference
while retaining Chronicle, messages, workspace files, and other history. It is
separate from end-turn, sleep, and session deletion. Omit the block to leave the
tool absent. The protected tool cannot be invoked by `puppetToolCall`, code
execution, programmatic dispatch, ephemeral subagents, or conversation forks.
For autobiographical residents, the host also defers challenge
issuance and confirmation while compression quarantine is non-empty, so a known
degraded context cannot bind the irreversible transition. The host refuses to
start an opted-in recipe when the installed Agent Framework does not yet provide
both retirement enforcement and the protected live-tool surface. Only a
successful terminal seal is sent to the ops notification channel; a request is
never turned into a human approval workflow. See
[Resident retirement](docs/resident-retirement.md).

**Memory defaults**: `agent.strategy` may be omitted entirely. The default is
the autobiographical memory strategy with adaptive resolution, **KV-stable
folding** (compile plans that preserve prompt-cache prefixes), compression by
the agent's own model, and summaries voiced as the agent itself
(`summaryParticipant` defaults to `agent.name`). Set a `strategy` block only
to tune windows/budgets or opt into a different strategy type — see
`docs/AGENT-ONBOARDING.md` for sizing guidance on long-lived agents.

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

Recipe servers merge with `mcpl-servers.json`. The file wins on conflict, so users can `/mcp add` extra servers or override recipe defaults.

### Included recipes

| Recipe | Description |
|--------|-------------|
| [`recipes/zulip-miner.json`](recipes/zulip-miner.json) | Knowledge extraction from Zulip workspaces |
| [`recipes/knowledge-miner.json`](recipes/knowledge-miner.json) | Multi-source extraction from Zulip + Notion + GitLab |

See [`recipes/SETUP.md`](recipes/SETUP.md) for a detailed setup guide for the knowledge-miner recipe.

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

## What it provides

- **Web UI**: browser operator console (`modules.webui`) — live chat with full interiority (thinking, tool calls, streaming), agent/fleet tree, context makeup + compression coverage, call ledger with cache verdicts and billing-grade costs, health/ops alerts, Chronicle branch tree, lessons, MCPL config, workspace files; scoped read-only observer access via device keys
- **TUI + readline modes**: OpenTUI interactive terminal or `--no-tui` for pipes/CI
- **Subagent forking** (opt-in, `modules.subagents`): Spawn/fork parallel agents with fleet tree view (Tab to toggle)
- **Persistent lessons** (opt-in, `modules.lessons`): Knowledge store with confidence scores and tags. Automatic retrieval-injection of lessons into context (`modules.retrieval`) is a separate opt-in — it adds per-turn context churn and retrieval-model calls, so enable it only for agents that actually curate a lesson library
- **Time-travel**: Chronicle-backed undo/redo, named checkpoints, branch exploration
- **Session management**: Isolated sessions with auto-naming
- **MCPL support**: Connect any MCP/MCPL server; wake subscriptions for selective event triggering
- **File products**: Write reports and documents, materialize to disk
- **Shared instructions** (opt-in, `modules.instructions`): a living instructions document (CLAUDE.md analogue) kept in a workspace mount and injected into every agent's context on every turn — the resident agent and all ephemeral subagents. Edits take effect on the next turn; nothing is persisted to history. Defaults: path `instructions/AGENTS.md`, `position: "system"`, 32 KiB cap (reads are bounded to the cap); a missing file is fail-open (no injection, warn once), while a path naming a nonexistent mount fails at recipe load — including on the implicit default workspace (`input` + `products`), whose mount set can never satisfy the default path, so declare an `instructions` mount explicitly. **Who edits, and how it propagates**: the module reads *disk*; agent `workspace--write`/`edit` land in Chronicle and reach disk only on an `autoMaterialize: true` mount — validation therefore requires it on a read-write instructions mount. On a read-only mount the flow reverses: human/deploy edits to disk reach the injection, but not `workspace--read` (which serves Chronicle) — prefer routing human feedback through conversation and letting the agent make the edit. Symlinks that lead outside the mount are rejected (realpath containment), never injected. **Cache note**: at `position: "system"` the block lives in every agent's prompt-cache prefix, so each edit is a fleet-wide cache cold start on the next turn — curate in batches, or use `afterUser` for cache-cheap, lower-salience injection. Compared to **lessons** (`modules.lessons`): lessons are a structured, confidence-scored store with model-driven retrieval; instructions are one free-form curated document, always present verbatim

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
- An Anthropic API key, OpenAI API key, or the Codex CLI signed in with ChatGPT

### Install

```bash
npm install
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | (required) | Anthropic API key |
| `OPENAI_API_KEY` | — | OpenAI Platform key for `openai-responses` recipes |
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
