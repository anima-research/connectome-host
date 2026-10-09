# Headless mode & the fleet protocol

Reference for the headless daemon runtime (`src/headless.ts`), the JSONL IPC it
speaks over a Unix socket, and the `FleetModule` (`src/modules/fleet-module.ts`)
that supervises headless children from a parent host.

Headless mode has two jobs in practice:

- **Running a resident.** A single long-lived agent runs `--headless` under
  systemd or launchd with nobody attached to the socket; the WebUI is its
  operator surface (see [`DEPLOYMENTS.md`](./DEPLOYMENTS.md)).
- **Being a fleet child.** A parent host with `modules.fleet` spawns children
  headless, connects to each socket, and folds their event streams into one
  agent tree (see [`recipes/TRIUMVIRATE-SETUP.md`](../recipes/TRIUMVIRATE-SETUP.md)).

This replaces the protocol sections of the original plans, now kept verbatim in
[`history/HEADLESS-FLEET-PLAN.md`](./history/HEADLESS-FLEET-PLAN.md) and
[`history/UNIFIED-TREE-PLAN.md`](./history/UNIFIED-TREE-PLAN.md). Where the code
and the plans disagree, the code wins; the differences are listed in
[`history/README.md`](./history/README.md).

---

## 1. Headless mode

```
bun src/index.ts <recipe> --headless [--exit-when-idle] [--socket-path <path>]
```

| Flag | Effect |
|---|---|
| `--headless` | Start the framework as usual, then run the headless runtime instead of the TUI or the piped loop. Takes precedence over `--no-tui`. |
| `--exit-when-idle` | One-shot: after the first work→quiet transition (see `lifecycle:idle` below), shut down gracefully with exit code 0. FleetModule never passes this flag. |
| `--socket-path <p>` | Override the socket location. FleetModule never passes this either; it always expects `{dataDir}/ipc.sock`. |

**Put the recipe first.** The recipe argument is the *first argument that does
not start with `--`*, so `--socket-path /x.sock recipe.json` loads `/x.sock` as
the recipe.

**Files in `DATA_DIR`** (default `./data`, resolved against the CWD):

| File | Purpose |
|---|---|
| `ipc.sock` | The Unix socket. A leftover socket is unlinked unconditionally at startup (no liveness check), so run one instance per data dir. A fleet parent won't launch into a dataDir that still has one (§4.3). |
| `headless.log` | Append-only. `process.stdout.write` and `process.stderr.write` are redirected here before anything else runs, so **nothing structured goes to stdout** — the socket is the only protocol channel. |
| `headless.pid` | The child's PID; removed on graceful shutdown. Adoption uses the PID persisted in the parent's own state; the parent reads this file only to confirm a leftover belongs to the dead child it tracks before removing it (§4.3). |
| `startup.log` | Written by the *parent's* FleetModule: the spawned child's stdio points here, so crashes before the redirect (bad recipe, missing key, import error) are captured. |

**Connection model.** One client at a time; a new connection closes the
previous one. On every connection the subscription resets to `['*']` and the
child emits `lifecycle:ready`. A client disconnecting does not stop the child.
Events emitted while no client is connected are dropped, not buffered.

**Shutdown.** Triggered by `{"type":"shutdown"}`, by `/quit` sent as a
`command`, by SIGTERM or SIGINT, or by `--exit-when-idle`. The child emits
`lifecycle:exiting`, waits ~50 ms for it to flush, calls `framework.stop()`
(which cancels in-flight streams rather than letting them finish), closes the
server, unlinks the socket and pid file, and exits 0. `graceful: false` only
changes the reason string.

---

## 2. Wire protocol

JSON Lines in both directions, one object per `\n`-terminated line.

- The child logs and drops malformed lines. Unknown `type`s and invalid fields
  are logged and **get no reply**.
- Lines are dispatched as they arrive, without waiting for the previous one to
  finish: correlate replies by `corrId`, not by order.
- Every outgoing object is stamped with `ts: Date.now()` (overwriting any `ts`
  the event already carried).

### 2.1 Parent → child

Types live in `IncomingCommand` (`src/modules/fleet-types.ts`).

| `type` | Fields | Behavior / reply |
|---|---|---|
| `subscribe` | `events: string[]` | **Replaces** the filter (not additive; `[]` blocks every non-exempt event). No reply. |
| `text` | `content` | Pushes an `external-message` with `source: 'headless'` and triggers inference. The agent is told the message has no channel locus, so a plain-prose reply won't reach a chat surface. |
| `command` | `command` (e.g. `"/status"`) | Runs through the slash-command handler (`src/commands.ts`). Each output line comes back as a `command-output` event. `/quit` triggers shutdown. |
| `shutdown` | `graceful?` | See Shutdown above. |
| `describe` | `corrId?` | → `snapshot` |
| `request-lessons` | `corrId?` | → `lessons-snapshot` |
| `request-workspace-mounts` | `corrId?` | → `workspace-mounts-snapshot` |
| `request-workspace-tree` | `mount`, `corrId?` | → `workspace-tree-snapshot` |
| `request-workspace-file` | `path`, `corrId?` | → `workspace-file-snapshot` (≤5000 lines, with `truncated`, or `error`) |
| `cancel-subagent` | `name`, `corrId?` | → `cancel-subagent-result`. The only way to stop a subagent that lives inside a child. |
| `panel-request` | `op`, `params?`, `corrId?` | → `panel-response`, via the same `runPanelOp` the WebUI runs in-process (§3). |

### 2.2 Child → parent

**Framework traces.** Every `framework.onTrace()` event is forwarded verbatim,
subject to the subscription filter: `inference:*`, `tool:*`, `usage:updated`,
`ops:alert`, and so on.

**Events added by the headless runtime:**

| Event | Payload | When |
|---|---|---|
| `lifecycle` (`phase: "ready"`) | `pid, dataDir, recipe` | On every socket accept, sent before the parent's `subscribe` can arrive. `recipe` is the recipe's display name, not a path. |
| `lifecycle` (`phase: "idle"`) | — | When every framework agent has been idle for ≥500 ms after at least one `inference:started`. Fires once per work→quiet transition. |
| `lifecycle` (`phase: "exiting"`) | `reason` | `shutdown:graceful`, `shutdown:immediate`, `command:/quit`, `SIGTERM`, `SIGINT`, `exit-when-idle`. A crash emits nothing. |
| `inference:speech` | `agentName, content` | Primary agent only: the text of an inference round that ended without tool calls. Used by `fleet--relay`. |
| `command-output` | `text, style` | One per line of a `command` reply. A response, not telemetry (see below). |

**Responses** — `snapshot`, `lessons-snapshot`, `workspace-mounts-snapshot`,
`workspace-tree-snapshot`, `workspace-file-snapshot`, `cancel-subagent-result`,
`panel-response` — each echo `corrId`; `command-output` lines answer a
`command` and carry none. A response goes only to the connection that sent the
request: if that connection closes or is replaced while the work is pending,
the reply is dropped and `headless.log` records its type and the reason.
Shapes are in `fleet-types.ts`. A
snapshot looks like:

```jsonc
{"type":"snapshot","corrId":"agg-1","asOfTs":1727700000000,
 "child":{"name":"<recipe.name>","pid":123,"recipe":"<recipe.name>","startedAt":1727690000000},
 "tree":{"nodes":[/* flat AgentNode[] with parent pointers */],"callIdIndex":{"<callId>":"<agent>"}}}
```

`child.name` is the recipe's display name; the parent keys children by the
name it assigned.

### 2.3 Subscription filter

`matchesSubscription` in `fleet-types.ts`:

- `*` matches everything; an exact string matches that type.
- A pattern ending in `*` is a prefix match (`tool:*` covers `tool:started`,
  `tool:completed`, `tool:failed`). There are no mid-string globs.
- `lifecycle` is one event type with a `phase` field — subscribe to
  `lifecycle`; `lifecycle:*` does **not** match it.

The eight response types — the seven `corrId` replies and `command-output` —
bypass the filter, so a `command` gets its reply even under `[]`. `lifecycle`
and `inference:speech` do **not**; a narrowed subscription must list them.

---

## 3. Panel ops

`PANEL_OPS` in `src/web/panel-data.ts` — the shared operator-panel layer that
both the WebUI host and headless children run, so a new panel works fleet-wide
without a protocol change.

`runPanelOp` never throws: failures come back as `{ok:false, error, status}`
(400 bad op/params, 404 unknown agent, 429 preview cooldown, 501 unsupported
by the installed libraries). `params.agent` defaults to the primary agent.

| Op | Params (besides `agent`) |
|---|---|
| `mcpl` | — |
| `tool-classes` | — (`agent` scopes to that agent's tools; omitted = every tool offered, not the primary agent) |
| `settings` | — |
| `settings-update` | `contextBudgetTokens`, `tailTokens`, `transitionPaceTokens`, `immediate`, `persist` (default true), `notify` |
| `settings-reset` | `keys?`, `persist`, `notify` |
| `settings-cancel-transition` | — |
| `pins` | `withCandidates` |
| `pin-add` | `firstMessageId`, `lastMessageId`, `name`, `level`, `maxLevel`, `kind`, `withCandidates` |
| `pin-remove` | `pinId`, `withCandidates` |
| `health` | — |
| `quota` | — |
| `context-makeup` | — |
| `context-coverage` | — |
| `context-curve` | — |
| `context-preview` | `budget` (required), `tail?`, `render?` — serialized, with a cooldown |
| `context-maintenance` | — |
| `debug-context` | `injections` (`true` is **not** transparent: it may run inference or MCPL hooks) |
| `media` | `messageId`, `path` (`<n>` or `<n>.<m>`); images only |

---

## 4. The fleet module

### 4.1 Recipe schema

`"fleet": true` attaches the module with no children and **no allowlist** —
the agent may launch any recipe. The object form:

```jsonc
"modules": { "fleet": {
  "children": [{
    "name": "miner",                  // required, unique
    "recipe": "knowledge-miner.json", // required; relative → the parent recipe's directory (or URL base)
    "dataDir": "./data/miner",        // default ./data/<name>, CWD-relative
    "env": { "K": "v" },              // merged over the parent env; recipe-only
    "subscription": ["lifecycle", "inference:speech", "tool:*"],
    "autoStart": true,                // default true; false = allowlisted but not launched
    "autoRestart": false              // default false
  }],
  "allowedRecipes": ["recipes/*", "https://trusted.example.com/*"],
  "defaultSubscription": ["*"],       // default ['*']
  "socketWaitTimeoutMs": 15000, "readyTimeoutMs": 10000,
  "gracefulShutdownMs": 10000, "sigtermEscalationMs": 5000
}}
```

Validation rejects a mid-string `*` in `allowedRecipes` (only a bare `*` or a
trailing `*` is allowed — `"recipes/*.json"` fails).

**Paths.** `children[].recipe` resolves at recipe-load time against the parent
recipe file's directory (or URL base); absolute paths and URLs pass through.
`dataDir`, and any `recipe` the agent passes to `fleet--launch`, resolve
against the CWD.

**Allowlist.** Active when `allowedRecipes` is set or any child is declared; it
then contains `allowedRecipes` plus every declared child recipe (including
`autoStart: false` ones). A launch outside it returns a tool error telling the
agent to ask the user to extend `allowedRecipes` — there is no interactive
prompt. autoStart, autoRestart and `fleet--restart` bypass the check.

### 4.2 Agent tools

| Tool | Input | Summary |
|---|---|---|
| `fleet--launch` | `name, recipe, dataDir?, subscription?, autoRestart?` | Spawn a headless child; resolves once it reports `ready`. Agents cannot pass `env`. |
| `fleet--list` | — | One row per known child. |
| `fleet--status` | `name?` | Detailed record (shows the *requested* subscription, before the forced union below). |
| `fleet--send` | `name, content` | Send a `text` command. |
| `fleet--command` | `name, command` | Send a `command`; returns immediately — output arrives as `command-output` events (see `fleet--peek`). |
| `fleet--peek` | `name, lines?=50` | Last N raw events from the child's 500-event ring buffer. |
| `fleet--kill` | `name` | `shutdown`, wait `gracefulShutdownMs`, SIGTERM, wait `sigtermEscalationMs`, SIGKILL. |
| `fleet--restart` | `name` | Kill, then relaunch with the same recipe, dataDir, subscription, `env` and `autoRestart`. Cancels a pending automatic restart and starts a fresh retry budget (§4.6). |
| `fleet--relay` | `from, to, prefix?` | Send `from`'s last `inference:speech` to `to`. |
| `fleet--await` | `names[], timeoutMs?=300000, requireAll?=true` | Block until the named children emit `lifecycle:idle`; fails fast on crash/exit, partial result on timeout. |

The conductor is not fed fleet state in its context and is not woken by fleet
events; it learns about children by calling these tools.

### 4.3 Launch

A child is `<process.execPath> <process.argv[1]> <recipePath> --headless`,
spawned detached with env `{...process.env, ...env, AGENT_TIMEZONE, DATA_DIR}`.
The parent waits for the socket file, connects, sends `subscribe`, and waits
for `lifecycle:ready`.

**Failed launch.** Transient missing-socket and connection-refused errors are retried while the child sets up its socket, using `socketWaitTimeoutMs` as the retry deadline. On a startup socket, `subscribe` or readiness failure, the parent sends SIGKILL to the process this launch spawned if it is still running, then waits up to 2 s to observe its exit before returning the error. If termination remains unconfirmed, the error says so and the record stays `starting`, blocking another launch of that name until the exit is observed. The SIGKILL is a signal death and does not trigger autoRestart (§4.6); a natural non-zero exit remains eligible under that section's conditions.

**Leftover artifacts.** A launch never spawns into a dataDir that still holds
`ipc.sock` or `headless.pid`. If the parent tracks a child of that name with
the same dataDir and recipe, it first retries adoption (§4.5) when the record
allows it and the PID and socket look alive. Failing that, it removes the two
files only if the tracked PID is confirmed gone, `headless.pid` holds exactly
that PID, and the socket is absent or refuses connections. The refusal check
runs under `node`; a missing `node`, a timeout or any other answer leaves the
files in place. If either file remains, the launch fails with an error naming
both paths and the way out: `fleet--status`, then `fleet--launch` or
`fleet--restart` to retry, or `fleet--kill` for an attached live child. A
parent with no record of the child never removes them; an operator has to.
These checks narrow races but are not a cross-process lock.

**No subfleets.** Every launch path first loads the child recipe in the parent;
if it declares `modules.fleet` (`true` or an object), the launch is refused
before any process starts. If the recipe can't be loaded at all, the check is
skipped and the normal spawn-time failure surfaces instead. Depth-1 keeps the
cross-process agent tree tractable; rationale in
[`history/UNIFIED-TREE-PLAN.md`](./history/UNIFIED-TREE-PLAN.md) §6.

### 4.4 Subscription floor

Every `subscribe` the parent sends passes through `sendToChild`, which (unless
the list already contains `*`) adds any event the tree reducer needs that no
existing pattern covers. That set, `REDUCER_REQUIRED_EVENTS`, is derived from
the reducer's handlers in `src/state/agent-tree-reducer.ts` — adding a handler
extends it with no recipe edits — plus `usage:updated`, which the host forces.
A recipe's `subscription` therefore means "events I want *in addition to* what
rendering needs".

**Not forced:** `lifecycle` (needed by `fleet--await`), `inference:speech`
(needed by `fleet--relay`) and `ops:alert`. A narrowed recipe must list the
ones it wants. `command-output` needs no entry: it bypasses the child's filter
(§2.3).

### 4.5 Persistence, adoption, detach

- **Persistence.** On every status change the module writes each child's
  record (recipe path, dataDir, socket, pid, status, timestamps, exit info,
  subscription, autoRestart) to its module state in the current session's
  Chronicle store. Env overrides are runtime-only and never persisted: an
  adopted child recovers them from the current configured child with the same
  name, recipe and dataDir, `autoStart: false` entries included, and a
  mismatch logs the differing fields and withholds the overrides, without
  logging their values (#180).
- **Adopt on start.** For each persisted child whose record allows it (`ready`
  or `starting` with no exit time, or `crashed` by an earlier failed
  adoption): check the pid is alive and the socket path is a socket, connect,
  re-subscribe, wait for `ready`, and require `ready.pid` to equal the
  persisted pid (guards against PID reuse). A failure kills nothing and
  removes nothing. If the probe fails, the record becomes `crashed` when the
  PID is confirmed gone and stays `starting` otherwise, with `exitReason`
  `adoption unresolved; …`. If the handshake fails, it stays `starting` with
  `adopt failed: …`. `fleet--launch` or `fleet--restart` on that name
  retries. Records that ended for any other reason are kept for
  `status`/`list` but never adopted, even if their old PID is alive again.
  autoStart children that weren't adopted go through a normal launch, which
  may adopt, clean up or refuse (§4.3); a refusal is logged.
- **Normal exit** stops every child (`fleet--kill`), with a `process.on('exit')`
  SIGKILL as backstop. Only a hard crash of the parent orphans children.
- **Detach** (the `d` answer at the quit prompt) leaves children running; the
  next parent adopts them.

### 4.6 autoRestart

Restarts only on a **non-zero exit code** (signal deaths don't count), and
never when the child was asked to stop or the parent is shutting down. Backoff
is roughly 1 s, 3 s, 10 s plus jitter; after 3 attempts within 60 s,
restarting is disabled for that child.

Attempt history carries across automatic replacements, so a crash loop advances the backoff and reaches the cap. `fleet--kill`, `fleet--restart` and parent shutdown cancel a pending restart, and `fleet--restart` starts a fresh budget. The history is kept in the parent's memory, not persisted, so a child adopted by a new parent process starts with a fresh budget.

### 4.7 The unified tree

`FleetTreeAggregator` (`src/state/fleet-tree-aggregator.ts`) keeps one
`AgentTreeReducer` per child. It sends `describe` whenever a child reports
`lifecycle:ready` (cold start, reconnect, restart) and applies the `snapshot`
by wiping and reseeding that child's tree; afterwards, events with
`ts < asOfTs` are dropped. `fleet--launch` calls add a parent edge from the
conductor to the child. The TUI and the WebUI each build their own aggregator;
the local process's own agents are still tracked by the TUI's inline state, not
by a reducer.

### 4.8 Operator surfaces

- **`/fleet`** — `list|ls` (default), `status [name]`, `view`, `peek <name>`,
  `stop|kill <name>`, `restart <name>`.
- **TUI** — `@child message` (or `@child: message`) sends straight to a child,
  bypassing the conductor (`@@` escapes a literal `@`). Tab or Ctrl+F toggles
  chat ↔ fleet tree. With children running, `/quit` or Ctrl+C asks
  `Stop them before exit? [y/N/d]`: `y` kills, `d` detaches, Enter/`n`
  cancels, other text cancels and is restored to the input; a second Ctrl+C
  force-quits.
- **WebUI `?scope=<child>`** — `/debug/context{,/makeup,/coverage,/curve,/preview,/maintenance}`,
  `/healthz`, `/quota` and `/media` accept `?scope=<child>` and are answered by
  that child through `FleetModule.requestPanel()` (404 unknown child, 502 not
  running, 504 after the 30 s default timeout; otherwise the child's own
  status). WebSocket panel messages carry `scope` the same way, and the
  sidebar's "inspecting:" selector drives it.

---

## 5. Known caveats

Behavior of the code as it stands, worth knowing before relying on it:

- **Snapshots saved before #180 may still hold resolved `children[].env`
  values** in the session's Chronicle history and in backups. Current
  snapshots don't, but the old ones remain until they're pruned, so rotate
  any credentials they carried.
- **Narrow subscriptions hide things.** `recipes/triumvirate.json` does not
  subscribe its children to `ops:alert`, so child ops alerts don't reach the
  parent's TUI.

---

**Sources.** `src/headless.ts`, `src/index.ts`, `src/recipe.ts`,
`src/commands.ts`, `src/tui.ts`, `src/modules/{fleet-types,fleet-module,tui-module,web-ui-module}.ts`,
`src/state/{agent-tree-reducer,fleet-tree-aggregator}.ts`, `src/web/panel-data.ts`.
Behavior is pinned by the `test/headless-*` and `test/fleet-*` suites.
