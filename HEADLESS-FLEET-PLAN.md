# Headless Daemon Mode & Fleet Orchestration — Plan

Status: draft • Authors: conversation between @tengro and Claude, 2026-04-21

## Goal

Run the Knowledge Mining Triumvirate (miner / reviewer / clerk) as a single orchestrated system in one terminal instead of three separate TUIs. The parent TUI runs a "conductor" agent with its own LLM that spawns and observes the three child recipes. Children run headless with JSONL IPC over Unix domain sockets. Inter-child communication stays what it is today — Zulip channels and shared workspace mounts — unchanged.

## High-level architecture

```
┌───────────── connectome-host (parent TUI) ────────────┐
│  recipe: triumvirate.json                             │
│  agent: "conductor" (LLM, own context)                │
│  modules:                                             │
│    - FleetModule ──┐                                  │
│    - workspace     │  tools: fleet--launch / list /   │
│    - lessons       │         status / send / command /│
│    - ...           │         peek / kill / restart /  │
│    - ...           │         relay / await            │
│  TUI: chat + fleet pane (per-child status + tail)     │
└────────────────┬──────────────────────────────────────┘
                 │ spawn (detached), connect Unix socket
     ┌───────────┼───────────┐
     ▼           ▼           ▼
 ┌────────┐  ┌────────┐  ┌────────┐
 │ miner  │  │reviewer│  │ clerk  │   connectome-host --headless
 │ DATA=  │  │ DATA=  │  │ DATA=  │   recipe per child
 │ data/m │  │ data/r │  │ data/c │   own Chronicle store
 └───┬────┘  └───┬────┘  └───┬────┘   ipc.sock per child
     │ JSONL    │           │
     └──────────┴───────────┘
      events out, commands in

     Cross-child: Zulip + shared workspace mounts (unchanged)
```

### Data flow

1. Parent TUI starts with `recipes/triumvirate.json`. FleetModule reads `modules.fleet.children` and spawns each `autoStart` child as a detached subprocess.
2. Each child runs `connectome-host --headless <recipe>`. It creates a Unix socket at `{DATA_DIR}/ipc.sock`, emits JSONL trace events, accepts JSONL commands.
3. Parent connects to each child's socket, parses events, maintains per-child state, surfaces it to the conductor agent (context injection) and TUI (fleet pane, peek).
4. Conductor agent uses `fleet--*` tools to observe / send / kill. User input in TUI routes to conductor by default; `@childname …` routes a line directly to a specific child.
5. On parent `/quit`: prompt — default stops all children, `/quit --detach` leaves them running.
6. On parent crash (Ctrl+C, SIGKILL): children survive (detached processes own their own sockets).
7. On parent re-launch: scan known data dirs for `ipc.sock`, probe liveness, reattach living children, respawn dead ones that are marked `autoStart`.

## Decisions (resolved)

### 1. Process model
**Q:** In-process subagents with different recipes, or separate processes?
**A:** Separate processes. Each child is its own `connectome-host` invocation with its own recipe, data dir, Chronicle store, and lifecycle.

### 2. Lifecycle shape
**Q:** One-shot, event-driven daemon, or task-bounded?
**A:** Event-driven daemon primarily. One-shot mode also supported via a per-child `--exit-when-idle` flag (or equivalent recipe setting).

### 3. Output contract
**Q:** Plain text, JSONL, or final blob?
**A:** JSONL. Every framework `TraceEvent` serialized as one line; plus lifecycle events added by the headless runtime. Enables the parent to reuse the same `onTrace` rendering logic it already uses in-process.

### 4. Data dir isolation per child
**Q:** Shared Chronicle under sub-namespaces, or separate fully?
**A:** Separate fully. Each child gets its own data dir, Chronicle store, sessions index, lessons store. Prevents conflicts and matches the existing separate-TUIs pattern.

### 5. Parent TUI shape
**Q:** New app, or recipe variant with a new module?
**A:** Recipe variant with a new module (`FleetModule`). The conductor agent has its own LLM and reasons about the fleet.

### 6. User interaction model
**Q:** Dashboard only, routed to specific child, or talk to parent agent?
**A:** Talk to parent agent by default (option III), `@childname …` as an escape hatch to target a specific child directly (option II). No mode toggle required.

### 7. Runtime
**Q:** Bun or something configurable?
**A:** Bun. Same binary (`bun src/index.ts --headless …`) for parent and children.

### 8. Environment / credentials
**Q:** Inherit parent env, or per-recipe env files?
**A:** Inherit parent env by default. Recipe's fleet entry can override via an `env` block.

### 9. Parent-restart behavior
**Q:** Adopt live children, respawn, or refuse to start?
**A:** Adopt (option a) via Unix socket IPC. Dead orphans (socket exists, PID gone) get cleaned up and respawned if `autoStart`.

### 10. Conductor authority to spawn
**Q:** Recipe-config-only, or LLM-callable?
**A:** LLM-callable, but bounded by a recipe-level `allowedRecipes` allowlist (defaults to the recipe paths listed under `fleet.children`). Out-of-allowlist spawn calls pause and prompt the user for confirmation via the TUI.

### 11. Trace event volume
**Q:** Filter or send everything?
**A:** Filter. Subscription at handshake — child only emits event types the parent asked for. Parent also fans out internally so each consumer (conductor context, TUI pane, peek view) can get a different slice from the same subscription.

### 12. IPC transport
**Q:** stdio pipes or sockets? (Derived from #9)
**A:** Unix domain socket at `{DATA_DIR}/ipc.sock`. Stdio would die with the parent and preclude adoption-on-restart. Children use `detached: true` + `stdio: 'ignore'` so they survive parent death; stdout/stderr go to `{DATA_DIR}/headless.log`.

## Decisions (deferred)

- **Log rotation policy** for `{DATA_DIR}/headless.log`. Start with append-only, revisit when files get big.
- **Conductor wake policies for fleet events** — initial default is "wake on crash / unexpected exit, don't wake on routine child activity" to keep the conductor's context lean. Final policy set to be tuned from real usage.
- **Windows support** for Unix domain sockets. Project currently Linux/WSL; revisit if needed.
- **Per-child auto-restart backoff** (default: off; if on, exponential backoff with cap). Ship without, add when we see crash patterns.

## Components & files

### A. Headless daemon mode (child capability)

**Files to touch:**
- `src/index.ts` — add `--headless` flag parsing; route to new `runHeadless()` instead of `runPiped()`.
- `src/headless.ts` (new) — headless runtime: socket server, JSONL framing, subscription filter, lifecycle events, graceful shutdown, SIGTERM handler, stderr redirect.
- `src/modules/tui-module.ts` — accept `source: 'headless'` alongside `cli` / `tui` / `system`.

**Flags:**
- `--headless` — enter headless mode; create socket at `{DATA_DIR}/ipc.sock`.
- `--exit-when-idle` — one-shot; exit after first `runUntilIdle`-style quiescence (no pending events, no wake subscriptions active).
- `--socket-path <path>` — override default socket location (optional).

### B. FleetModule (parent's new module)

**Files:**
- `src/modules/fleet-module.ts` (new) — module class, tool handlers, subprocess lifecycle manager, socket client, per-child state, Chronicle persistence, restart/adopt logic.
- `src/modules/fleet-types.ts` (new) — wire protocol types shared with `headless.ts`.

**Tools (exposed to conductor agent):**
- `fleet--launch {name, recipe, dataDir?, env?, autoRestart?}` — launch a child (separate OS process, distinct from `subagent--spawn`). Checks `allowedRecipes`, prompts user if out-of-list.
- `fleet--list` — enumerate children with status.
- `fleet--status {name?}` — detailed status for one or all.
- `fleet--send {name, content}` — send user-like message to child.
- `fleet--command {name, command}` — send slash command to child.
- `fleet--peek {name, lines?}` — last N events from child's rolling buffer.
- `fleet--kill {name}` — graceful shutdown → SIGTERM → SIGKILL escalation.
- `fleet--restart {name}` — kill then respawn.

**Per-child state (persisted to Chronicle module state):**
`{ name, recipePath, dataDir, pid, status, startedAt, lastEventAt, autoStart, autoRestart, socketPath, subscription }`.

**`gatherContext()`** — injects a compact fleet-status block (similar to subagent HUD) before each conductor inference, if enabled.

**`onProcess()`** — handles `fleet:child-event` scope events for conductor wake policies.

### C. Recipe schema extension

**Files:**
- `src/recipe.ts` — extend `RecipeModules` with `fleet` type, validate, resolve child recipe paths relative to the parent recipe file.

**Schema:**
```jsonc
"modules": {
  "fleet": {
    "children": [
      {
        "name": "miner",
        "recipe": "recipes/zulip-miner.json",
        "dataDir": "./data/miner",
        "autoStart": true,
        "autoRestart": false,
        "env": { "OPTIONAL_OVERRIDE": "value" },
        "subscription": ["lifecycle", "inference:completed", "tool:completed", "tool:failed", "inference:failed"]
      }
    ],
    "allowedRecipes": ["recipes/*.json", "https://trusted.example.com/*"],
    "defaultSubscription": ["lifecycle", "inference:completed", "tool:completed", "tool:failed", "inference:failed"]
  }
}
```

### D. TUI integration

**Files:**
- `src/tui.ts` — new view mode `fleet-process` (distinct from the existing subagent fleet tree); input routing for `@childname`; peek variant that tails a child process stream.
- `src/commands.ts` — new slash commands: `/fleet list | start <name> | stop <name> | restart <name> | peek <name>`.

**Interaction:**
- Default: user input → conductor agent (unchanged from today).
- `@miner look at #router-dev` → `fleet--send {name:"miner", content:"look at #router-dev"}` executed directly, bypassing conductor.
- Tab cycles view modes: chat → subagent-fleet → process-fleet → peek → chat.

### E. Triumvirate meta-recipe

**File:**
- `recipes/triumvirate.json` (new) — conductor system prompt + fleet children entries for miner / reviewer / clerk.

Conductor prompt themes:
- Your three children coordinate among themselves via Zulip and shared workspace mounts; stay out of their way by default.
- Observe via `fleet--peek`, intervene via `fleet--send` only when the user explicitly asks or a child signals a crash.
- Spawning recipes outside `allowedRecipes` requires user confirmation; don't surprise the user.

## Protocol specs

### Child → Parent (events, JSONL)

One JSON object per line. All events include `type`; most include `ts` (epoch ms).

**Framework trace events (pass-through):**
```json
{"type":"inference:started","agentName":"miner","ts":1713700000000}
{"type":"inference:tokens","agentName":"miner","content":"..."}
{"type":"inference:tool_calls_yielded","agentName":"miner","calls":[{"id":"...","name":"...","input":{}}]}
{"type":"tool:started","tool":"workspace--read","callId":"...","input":{}}
{"type":"tool:completed","callId":"...","tool":"workspace--read","durationMs":142}
{"type":"tool:failed","callId":"...","tool":"...","error":"..."}
{"type":"inference:completed","agentName":"miner","tokenUsage":{"input":1234,"output":567}}
{"type":"inference:failed","agentName":"miner","error":"..."}
{"type":"message:added","source":"...","participant":"...","content":[...]}
```

**Lifecycle events (added by headless runtime):**
```json
{"type":"lifecycle","phase":"ready","pid":12345,"recipe":"recipes/zulip-miner.json","dataDir":"./data/miner"}
{"type":"lifecycle","phase":"idle"}
{"type":"lifecycle","phase":"exiting","reason":"shutdown-command|sigterm|crash"}
```

### Parent → Child (commands, JSONL)

```json
{"type":"subscribe","events":["lifecycle","inference:completed","tool:*"]}
{"type":"text","content":"Please resummarize last week"}
{"type":"command","command":"/status"}
{"type":"shutdown","graceful":true}
```

- `subscribe` is idempotent. Typically sent once right after connection. Supports simple glob (`tool:*`, `inference:*`).
- `text` produces an `external-message` event with `source: 'headless'` — same effect as user typing into the child's own TUI.
- `command` routes through the child's `commands.ts` handler exactly as if typed locally.
- `shutdown` sets `graceful`; child completes in-flight inference, then exits. `graceful: false` is equivalent to SIGTERM.

### Connection lifecycle

1. Parent opens socket at known path. If connect fails: check PID file → alive = retry with backoff; dead = respawn (if autoStart) or mark dead.
2. Parent sends `subscribe` immediately after connect.
3. Child sends `lifecycle:ready` once framework is fully up.
4. Normal steady-state event flow.
5. On parent `/quit` (default): parent sends `shutdown {graceful:true}` to each child, waits up to 30s, then SIGTERM.
6. On parent `/quit --detach`: parent closes socket without `shutdown`; children stay up.
7. On parent crash: sockets get closed at OS level; children notice via `'end'` event on their accept socket, continue running, accept a new connection when parent comes back.

## Phased implementation

### Phase 1 — Headless daemon mode (child-only capability)

**Deliverables:**
- `src/headless.ts` implementing the protocol above.
- `--headless` flag in `src/index.ts`.
- Unit tests: socket server starts, accepts one connection, `subscribe` filters outgoing events, `shutdown` exits cleanly.

**Acceptance:**
- `bun src/index.ts --headless recipes/zulip-miner.json` starts; socket exists at `data/ipc.sock`.
- Test client connects, sends `{"type":"subscribe","events":["*"]}`, then `{"type":"text","content":"hello"}`; receives inference event stream.
- Client sends `{"type":"shutdown"}`; child exits 0; socket file removed.
- SIGTERM: child exits gracefully; socket removed.
- Client disconnect: child stays up; another client can connect.
- `stderr` lands in `{DATA_DIR}/headless.log`; `stdout` is JSONL only.

### Phase 2 — FleetModule (core, no durability)

**Deliverables:**
- `src/modules/fleet-module.ts` with spawn / list / status / send / command / peek / kill tools.
- Detached subprocess launch, socket connect, JSONL parse, per-child rolling buffer (last 500 events).
- No Chronicle persistence, no autoRestart, no reattach yet.

**Acceptance:**
- In a test parent instance, conductor calls `fleet--launch {name:"test", recipe:"recipes/zulip-miner.json"}` → subprocess starts, socket connects.
- `fleet--status {name:"test"}` returns `ready`.
- `fleet--send {name:"test", content:"say hi"}` → child runs inference; `fleet--peek {name:"test"}` shows the events.
- `fleet--kill {name:"test"}` → child exits; status becomes `exited`.

### Phase 3 — TUI fleet pane

**Deliverables:**
- New view mode rendering children list + status + last-event snippet.
- `@childname` input routing in `tui.ts`.
- Peek mode tailing a child's live stream.
- `/fleet …` slash commands in `commands.ts`.

**Acceptance:**
- Run a minimal parent that spawns two children; fleet pane shows both, color-coded.
- `@miner help` routes directly to miner; the conductor does not see or process it.
- Peek mode updates in real time as the child streams tokens.

### Phase 4 — Recipe schema + triumvirate.json

**Deliverables:**
- `fleet` config parsing + validation in `src/recipe.ts`.
- `autoStart` wiring: children launch when parent framework starts.
- `allowedRecipes` enforcement with user-prompt flow for out-of-list spawns.
- `recipes/triumvirate.json` with conductor prompt + three children configured.

**Acceptance:**
- `bun src/index.ts recipes/triumvirate.json` boots parent TUI + three children automatically.
- TUI shows all three children ready within a few seconds.
- Conductor can enumerate them via `fleet--list`.
- Smoke test: ask conductor "are the children healthy?" — gets a sensible answer based on fleet state.

### Phase 5 — Durability & polish

**Deliverables:**
- Chronicle persistence of fleet state (per-child record).
- Reattach-on-restart: scan data dirs, probe sockets + PID files, adopt live children.
- `autoRestart` on crash with simple policy (immediate retry, up to N times, fail hard after).
- Event subscription fan-out: different filtered streams for conductor context vs. TUI pane vs. peek.
- `/quit` prompt: "Stop children? [Y/n/detach]" — default stop.
- `--exit-when-idle` one-shot mode for children.

**Acceptance:**
- Kill the parent mid-session; restart; children appear re-adopted with live streams resuming.
- Crash a child (e.g. forced kill); with `autoRestart: true`, it respawns; without, status shows `crashed`.
- Conductor's context does not include streaming tokens (filtered); TUI peek shows them (not filtered).

## Out of scope

- Multi-machine orchestration (everything is local, single-host Unix sockets).
- Children hosting their own fleets (no recursive FleetModule).
- Config hot-reload (parent restart required to change fleet composition).
- Windows native support (Linux/WSL2 initially; socket path semantics are the main blocker).
- Log rotation (append-only until size issues arise).
- A GUI / web dashboard (terminal only; CLI tools can use the JSONL protocol directly if they want).

## References

- `src/index.ts` — current `runPiped` path, starting point for `runHeadless`.
- `src/modules/tui-module.ts` — pattern for external-message-handling modules.
- `src/modules/subagent-module.ts` — pattern for modules that manage child agents + implement `gatherContext` + persist state to Chronicle.
- `src/recipe.ts` — schema validation precedent.
- `agent-framework/src/api/server.ts` — message/event shape precedent (conceptually adjacent to what we need, but over WebSocket instead of Unix socket; not reused directly to keep the FKM work self-contained).
