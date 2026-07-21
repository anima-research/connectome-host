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
    "strategy": {
      "type": "autobiographical",
      "headWindowTokens": 4000,
      "recentWindowTokens": 30000
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
    "subagents": true,
    "lessons": true,
    "retrieval": true,
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
- **Subagent forking**: Spawn/fork parallel agents with fleet tree view (Tab to toggle)
- **Persistent lessons**: Knowledge store with confidence scores, tags, and semantic retrieval
- **Time-travel**: Chronicle-backed undo/redo, named checkpoints, branch exploration
- **Session management**: Isolated sessions with auto-naming
- **MCPL support**: Connect any MCP/MCPL server; wake subscriptions for selective event triggering
- **File products**: Write reports and documents, materialize to disk

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
