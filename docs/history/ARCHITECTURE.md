# connectome-host

A general-purpose agent TUI host with recipe-based configuration. Point it at any use case by loading a recipe — a JSON file that defines the system prompt, MCP servers, modules, and agent settings. Built on the Connectome stack (Agent Framework + Context Manager + Membrane + Chronicle).

## Goals

1. **Recipe-driven configuration** — a single JSON file defines the entire agent personality: system prompt, model, MCP servers, module toggles, context strategy, session naming hints
2. **Parallel exploration** — spawn and fork subagents to work on multiple tasks concurrently, with fleet tree view and live peeking
3. **Semantic memory** — persistent lesson store with confidence scoring, plus LLM-as-retriever pipeline for automatic context injection
4. **Reversibility** — Chronicle-backed undo/redo, named checkpoints, branch exploration via slash commands
5. **Session management** — isolated Chronicle stores per session, auto-naming via Haiku
6. **Dogfood the AF** — stress-test the agent framework's module system, MCPL integration, context strategies, and multi-agent capabilities

## Architecture

```
                         ┌──────────────┐
                         │   OpenTUI    │  ScrollBox, TextRenderable,
                         │   (tui.ts)   │  InputRenderable, status bar
                         └──────┬───────┘
                                │ pushEvent('external-message')
                         ┌──────┴───────┐
                         │  TuiModule   │  event bridge: TUI → context messages
                         └──────┬───────┘
                                │
                    ┌───────────┴───────────┐
                    │   Agent Framework     │
                    │  ┌─────────────────┐  │
                    │  │  recipe agent   │  │  name, model, prompt from recipe
                    │  │  (event loop)   │  │
                    │  └────────┬────────┘  │
                    │           │            │
                    │  ┌────────┴────────┐  │
                    │  │   Modules       │  │  (recipe-toggleable)
                    │  │  - subagent     │──┼── spawn/fork ephemeral agents
                    │  │  - lessons      │──┼── CRUD knowledge store (Chronicle)
                    │  │  - retrieval    │──┼── LLM-as-retriever (Haiku)
                    │  │  - workspace    │──┼── mount-based filesystem (Chronicle-backed)
                    │  │  - tui          │  │  (always-on)
                    │  └────────┬────────┘  │
                    │           │            │
                    │  ┌────────┴────────┐  │
                    │  │  MCPL Servers   │  │  from recipe + mcpl-servers.json
                    │  │  (stdio or ws)  │──┼── any MCP/MCPL server
                    │  └─────────────────┘  │
                    └───────────────────────┘
```

### Core data flow

1. User types a message in the TUI
2. `TuiModule` converts it to a context message + triggers inference
3. The agent reads the conversation, calls tools (MCPL servers, subagent, lessons, etc.)
4. Before each inference, `RetrievalModule` and `LessonsModule` inject relevant knowledge via `gatherContext()`
5. Trace events (`inference:tokens`, `tool:started`, etc.) drive the TUI's streaming display

## Project Structure

```
connectome-host/
  src/
    index.ts                 Entry point, recipe resolution, framework factory
    tui.ts                   OpenTUI-based terminal interface (@opentui/core)
    commands.ts              Slash command handler (Chronicle reversibility, /mcp, /session, etc.)
    recipe.ts                Recipe loading, validation, persistence, CLI parsing
    mcpl-config.ts           File-driven MCPL server config (mcpl-servers.json)
    session-manager.ts       Session index, isolation, migration
    synesthete.ts            Auto-naming sessions via Haiku
    modules/
      tui-module.ts          Event bridge: external-message → context + inference
      subagent-module.ts     Spawn, fork, peek, hud, concurrency, return
      lessons-module.ts      Knowledge CRUD + gatherContext injection
      retrieval-module.ts    3-step LLM-as-retriever pipeline
      time-module.ts         Session-start timestamp + time:now tool
    strategies/              (reserved for future domain-specific strategies)
    types/
      bun-ffi.d.ts           Bun FFI type declarations
  recipes/
    zulip-miner.json         Knowledge extraction from Zulip workspaces
    knowledge-miner.json     General-purpose knowledge extraction
    mcpl-editor-test.json    Collaborative markdown editor testing via WebSocket MCPL
```

## Components

### Recipe System (`recipe.ts`)

Recipes are JSON files that configure everything domain-specific. See [README.md](README.md) for the full recipe schema.

**Loading precedence**:
1. CLI argument (`bun src/index.ts recipes/foo.json` or `bun src/index.ts https://...`)
2. Saved recipe from last run (`data/.recipe.json`)
3. Built-in default (generic assistant with all modules enabled)

**System prompt from URL**: If `agent.systemPrompt` is an HTTP(S) URL (no spaces/newlines), the text is fetched at load time.

**MCP server merging**: Recipe servers merge with `mcpl-servers.json`. The file wins on conflict, so `/mcp add` can override recipe defaults.

**Transport support**: Recipe MCP servers support both stdio (`command` + `args`) and WebSocket (`url` + `transport: 'websocket'` + optional `token`).

### TUI (`tui.ts`)

Built on [OpenTUI](https://github.com/anomalyco/opentui) (`@opentui/core`) — the same terminal UI library that powers OpenCode. Requires the Bun runtime.

**Layout**:
```
┌─────────────────────────────────────────────────────┐
│  ScrollBoxRenderable (flexGrow, stickyScroll)       │
│  └─ TextRenderable per message/stream chunk         │
├──────────────────────────────────────┬──────────────┤
│  [✓ idle | tool | N sub]            │ 1.2kin 0.5kout│
├──────────────────────────────────────┴──────────────┤
│  InputRenderable                                    │
└─────────────────────────────────────────────────────┘
```

- **Conversation area**: `ScrollBoxRenderable` with `stickyScroll: true` — auto-scrolls as content is added. Each message or tool notification is a `TextRenderable` child node.
- **Status bar**: Two `TextRenderable` nodes in a `BoxRenderable` with `justifyContent: 'space-between'`. Left side shows agent state, current tool, and subagent count. Right side shows cumulative token usage across the session (all agents).
- **Input**: `InputRenderable` with `ENTER` event for submitting messages and commands.
- **Keyboard**: Tab toggles fleet view (subagent tree). Esc interrupts the agent. Ctrl+V toggles verbose mode. Ctrl+B detaches a sync subagent to background. Ctrl+C exits.

**Streaming**: Tokens arrive via `inference:tokens` trace events. A plain string buffer tracks accumulated text and assigns the full string to `TextRenderable.content` each time (the `.content` property is a `StyledText` object, not a string — `+=` would break).

**Token tracking**: `usage:updated` trace events (from all agents) feed a session-wide counter tracking input tokens, output tokens, cache reads, and cache writes. Displayed compactly: `1.2kin 0.5kout 3.4kcache`.

**Dual mode**: If stdout is not a TTY (piped/CI), falls back to a plain readline loop with `waitForInference` promise gating. No OpenTUI dependency on this path.

### Subagent Module (`subagent-module.ts`)

Enables the agent to delegate work to parallel ephemeral agents.

**Tools**:
| Tool | Behavior |
|------|----------|
| `subagent--spawn` | Fresh agent with system prompt + task. Async by default (returns immediately). |
| `subagent--fork` | Agent inheriting parent's compiled context. Async by default. |
| `subagent--hud` | Toggle fleet status HUD overlay (injected before each inference). |
| `subagent--concurrency` | View/adjust concurrency ceiling (auto-adapts to rate limits). |
| `subagent--peek` | Live state of a running subagent (status, messages, streaming output). |
| `subagent--return` | Subagent calls this to deliver results back to parent and exit. |

**Async by default**: Spawn and fork return immediately; results arrive as messages + inference-request events. Pass `sync: true` to block until completion. Sync tasks are detachable (Ctrl+B or `timeoutMs` auto-detach).

**Interaction model** (parallel-async-await): When the LLM emits multiple spawn/fork calls in a single turn, the AF dispatches them concurrently. The parent blocks on `waiting_for_tools` until all results arrive together — natural fan-out without explicit orchestration.

**Isolation**: Each ephemeral agent gets its own temporary Chronicle store (temp directory, cleaned up on completion). This prevents message leakage between parent and children.

**Depth limiting**: Constructor takes `maxDepth` (default 3). At the depth limit, subagent tools are stripped from the child's tool set.

**Concurrency**: Adaptive concurrency control — halves on HTTP 429, recovers after consecutive successes.

**Terminology**: "Fork" and "branch" are distinct concepts:
- **Fork** = spawning a subagent that inherits the parent's compiled messages (agent-level, message copy)
- **Branch** = Chronicle state branch for undo/redo/checkpointing (storage-level, user-facing)

### EventGate

MCPL event gating is a core Agent Framework feature. Configuration is file-based (`{storePath}/config/gate.json`) and controlled via `GateOptions` in `FrameworkConfig`. The recipe's `modules.wake` key controls whether gating is enabled and can provide initial policy config.

### Workspace Module (from AF)

Mount-based filesystem access backed by Chronicle, imported from `@connectome/agent-framework`. Replaces the former `FilesModule` + `LocalFilesModule`.

**Default mounts** (when recipe doesn't specify):
- `input` — read-only, `./input`
- `products` — read-write, `./output`

**Recipe-configurable**: `modules.workspace.mounts` overrides the default mounts. `modules.workspace.configMount: true` adds a special `_config` mount that version-controls gate config via Chronicle.

Disabled entirely with `modules.workspace: false` (no filesystem access at all).

### Lessons Module (`lessons-module.ts`)

Persistent knowledge store backed by Chronicle state snapshots.

**Data model**:
```typescript
interface Lesson {
  id: string;           // Short UUID
  content: string;      // The knowledge itself
  confidence: number;   // 0.0–1.0
  tags: string[];       // people, process, decision, technical, ...
  evidence: string[];   // Source references (stream:topic:messageId)
  created: number;
  updated: number;
  deprecated: boolean;
  deprecationReason?: string;
}
```

**Tools**: `create`, `update`, `deprecate`, `query` (text + tags + confidence filter), `list`, `boost`, `demote`.

**Confidence dynamics**: `boost` applies diminishing-returns growth (`+0.1 * (1 - c)`); `demote` applies diminishing-returns decay (`-0.1 * c`). Lessons below 0.3 confidence are excluded from context injection.

**Context injection**: `gatherContext()` injects the top 10 active lessons (by confidence) as a `## Knowledge Library` block in the system position.

### Retrieval Module (`retrieval-module.ts`)

Semantic memory lookup using a three-step LLM-as-retriever pipeline. Runs in `gatherContext()` before each main-agent inference.

```
 Step 1: Flag concepts        Step 2: Keyword query      Step 3: Validate
 ┌──────────────────┐         ┌──────────────────┐       ┌──────────────────┐
 │ Recent messages   │──Haiku──│ Concept keywords │──DB──│ Candidate lessons │──Haiku──│ Relevant only │
 │ → "What concepts  │         │ ["RFC", "auth"]  │      │ (top 20 by conf.) │        │ (filtered IDs)│
 │   need background │         └──────────────────┘      └──────────────────┘        └───────────────┘
 │   knowledge?"     │
 └──────────────────┘
```

- Steps 1 and 3 use Haiku (~$0.001 each)
- Step 2 is mechanical keyword matching (no LLM call)
- Results cached by context hash — skips entirely if conversation hasn't changed
- Fails open: on error, returns empty (never blocks inference)
- Short-circuits: if only 3 or fewer candidates, skips validation step

### Session Manager (`session-manager.ts`)

Each session is an isolated Chronicle store under `{dataDir}/sessions/{id}/`. A JSON index (`sessions.json`) tracks metadata.

**Features**: create, delete, rename, switch, find (by name or ID prefix), legacy store migration.

### Synesthete (`synesthete.ts`)

Auto-generates session names via a Haiku call after the 3rd user message. Produces 2–4 word names. Recipe can provide naming examples to steer the style.

### Slash Commands (`commands.ts`)

| Command | Effect |
|---------|--------|
| `/help` | List all commands |
| `/quit`, `/q` | Exit |
| `/status` | Agent state, branch, queue depth |
| `/clear` | Clear conversation display |
| `/lessons` | Show lesson library sorted by confidence |
| `/undo` | Branch at the message before the last agent turn, switch to it |
| `/redo` | Pop from redo stack, switch back |
| `/checkpoint <name>` | Save `(branchId, branchName)` as named point |
| `/restore <name>` | Switch to checkpoint's branch |
| `/branches` | List all Chronicle branches with head positions |
| `/checkout <name>` | Switch to named branch |
| `/history` | Show last 20 messages in summary form |
| `/mcp list` | List MCPL servers from `mcpl-servers.json` |
| `/mcp add <id> <cmd> [args...]` | Add or overwrite a server |
| `/mcp remove <id>` | Remove a server |
| `/mcp env <id> KEY=VALUE [...]` | Set env vars on a server |
| `/budget [tokens]` | Show/set stream token budget (e.g. `/budget 150k`, `/budget 1m`) |
| `/session` | Show current session |
| `/session list` | List all sessions |
| `/session new [name]` | Create and switch to new session |
| `/session switch <name>` | Switch to session (by name or ID) |
| `/session rename <name>` | Rename current session |
| `/session delete <name>` | Delete a session |
| `/recipe` | Show current recipe info |
| `/newtopic [context]` | Reset head window (auto-summarize or with user context) |
| `/usage` | Show session token usage and cost breakdown |

## Framework Integration

The app runs on the `mcpl-first-class` branch of the Agent Framework, which embeds MCPL server management directly in the framework core.

**Key AF extensions used**:
- `createEphemeralAgent()` — creates an agent + context manager with an isolated temp Chronicle store; returns a cleanup function
- `runEphemeralToCompletion()` — temporarily registers an ephemeral agent in the framework's agent map, triggers inference through the normal event loop (full trace events, logging, tool dispatch), resolves when the agent returns to idle
- `executeToolCall()` — routes tool calls to module registry or MCPL servers (used by subagents to access tools)
- `KnowledgeStrategy` — context strategy used for subagent fork/spawn context (from `@connectome/agent-framework`)

**Configuration** is recipe-driven — see `createFramework()` in `index.ts`. The framework factory:
1. Builds the module list based on recipe toggles (subagent, lessons, retrieval, workspace)
2. Merges recipe MCP servers with `mcpl-servers.json` (file wins)
3. Configures EventGate via `GateOptions` (file-based, per-session)
4. Selects context strategy from recipe (`autobiographical` or `passthrough`, defaults to autobiographical)

## Environment

```
ANTHROPIC_API_KEY         Required. API key for Membrane.
MODEL                     Override model for the main agent. Default: from recipe or claude-opus-4-6
DATA_DIR                  Data directory for sessions and recipes. Default: ./data
```

## Runtime

**Bun** (not Node.js). OpenTUI's native Zig core requires Bun. Chronicle's N-API bindings are validated under Bun (56 tests in `bun-compat/`).

## Running

```bash
# Interactive TUI (requires TTY)
bun src/index.ts

# Load a recipe
bun src/index.ts recipes/zulip-miner.json

# Piped mode (CI / testing)
echo -e "/help\n/status\n/quit" | bun src/index.ts

# Dev mode with watch
bun --watch src/index.ts
```

## Dependencies

| Package | Source |
|---------|--------|
| `@connectome/agent-framework` | `../agent-framework` (local) |
| `@connectome/context-manager` | `../context-manager` (local) |
| `chronicle` | `../chronicle` (Rust + N-API bindings, local) |
| `membrane` | `../membrane` (local) |
| `@opentui/core` | npm (native Zig terminal UI, powers OpenCode) |

## Roadmap

### 1. TUI rework for branch operations
The TUI is imperative (OpenTUI) and builds display state incrementally from trace events. After a Chronicle branch switch (undo/redo/checkpoint restore), the display stays stale — it doesn't re-query the store. Needs:
- A `refreshFromStore()` path that clears the conversation view and reloads from `queryMessages()` without tearing down the framework
- Called after any branch operation (`/undo`, `/redo`, `/restore`, `/branch switch`)
- Preserve branch-independent state (view mode, expanded nodes, layout) while rebuilding message display

### 2. Hierarchical compression in AutobiographicalStrategy
The context-manager's `AutobiographicalStrategy` currently does single-level compression (raw → diary). Upgrade to moltbot-style 3-level pyramid:
- **Merge logic in `tick()`**: when N unmerged summaries accumulate at level K, merge into one at level K+1
- **Anti-redundancy in `select()`**: exclude a summary if all its children are expanded at the level below
- **Budget carryover**: unused token budget at higher levels flows down (L3 → L2 → L1)
- **Self-voice framing**: summaries injected as assistant messages (the model's own recollections), not Q&A pairs
- **Source range tracking**: each compressed chunk records which message sequences it covers (Chronicle is lossless, but we need the mapping)

### 3. Domain-specific context strategies
Recipe-aware compression strategies that understand domain semantics. For example, a knowledge extraction strategy that prioritizes lesson-relevant messages, research leads, and synthesis differently from generic conversation. Builds on top of the hierarchical compression work.

### 4. Undo/redo at the framework level
Currently each app builds its own undo/redo on top of Chronicle branching. Should be a first-class framework feature:
- Auto-record the Chronicle sequence number before each inference turn
- Expose `undoLastTurn(agentName)` / `redo()` on `AgentFramework`
- Branch at the recorded sequence, switch to the new branch
- Emit trace events so TUI/UI layers know to refresh

### 5. MCPL integration depth
connectome-host has config-level MCPL support and wake subscriptions, but deeper integration is needed:
- Visibility into MCPL server status and activity in the TUI
- MCPL-triggered inference distinguished from user-triggered in the conversation view
- Interaction model for how MCPL-pushed content appears and is handled

## TUI Evolution

1. **Ink/React** — first attempt, clunky rendering, interleaved output
2. **Custom ANSI** — raw escape sequences, cursor tracking; fixed interleave but letters disappeared during typing
3. **OpenTUI** — production-quality terminal rendering (Zig core), handles cursor/input/scroll natively

## Gotchas

- **`TextRenderable.content` is a `StyledText` object**, not a string. Using `+=` silently breaks (stringifies as `[object Object]`). Always track text in a plain string buffer and assign the full string via `=`.
- **Bun auto-loads `.env`** — no `dotenv` package needed.
- **`child_process.spawn`** works in Bun (needed for MCPL server connections).
- **Tool name separator**: module tools use `--` separator (e.g. `subagent--fork`, `wake--subscribe`), not `:`.
