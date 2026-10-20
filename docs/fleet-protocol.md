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
| `ipc.sock` | The Unix socket. A leftover socket is unlinked unconditionally at startup (no liveness check), so run one instance per data dir. A fleet parent won't launch into a dataDir that still has one, or that another of its children is starting or ready in (§4.3). |
| `headless.log` | Append-only. Once the child has loaded its recipe and built its framework, the headless runtime redirects `process.stdout.write` and `process.stderr.write` here, before it logs anything itself, so **nothing structured goes to stdout** — the socket is the only protocol channel. It holds the runtime's own lines (its start, recipe warnings, socket events, shutdown), written through a stream that a fast exit can cut short. Bun's `console.*` doesn't go through those methods, so a fleet child's console lines go to `startup.log` instead. |
| `headless.pid` | The child's PID; removed on graceful shutdown. Adoption uses the PID persisted in the parent's own state; the parent reads this file only to confirm a leftover belongs to the dead child it tracks before removing it (§4.3). |
| `startup.log` | Opened by the *parent's* FleetModule as a fleet child's stdout and stderr, after a `--- launch …` line per launch. Bun's `console.*` writes to those descriptors directly (Bun 1.3.14 and 1.4.3), not through the redirected methods, so every console line the child prints goes to the file the parent opened here, for the child's whole life: a bad recipe, a missing key, an import error, and a fatal error after the redirect. The parent opens it without waiting for a FIFO's reader, and hands it on only as a regular file that took the launch's header; otherwise the child's console output goes nowhere, and the host's log says why. A link there is followed, when the parent opens the file and when it reads it. A launch that fails after the spawn quotes the end of what the child wrote here during it, or says why it can't, unless the parent is detaching and leaves the child running (§4.3). |

**Connection model.** One client at a time; a new connection closes the
previous one. On every connection the subscription resets to `['*']` and the
child emits `lifecycle:ready`. A client disconnecting does not stop the child.
Events emitted while no client is connected are dropped, not buffered.

**Shutdown.** Triggered by `{"type":"shutdown"}`, by `/quit` sent as a
`command`, by SIGTERM or SIGINT, or by `--exit-when-idle`. The child emits
`lifecycle:exiting`, waits ~50 ms for it to flush, calls `framework.stop()`
(which cancels in-flight streams rather than letting them finish), closes the
server, unlinks the socket and pid file, and exits once `headless.log` has
taken its last lines: 0, or 1 if `framework.stop()` failed. It waits at
most 2 s, then exits anyway with a line on its stderr. What it writes
through `process.stdout.write` and `process.stderr.write` once the log has
ended goes to its stderr too; Bun's `console.*` writes to its stdout and
stderr directly, before and after. `graceful: false` only changes the
reason string.

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
against the CWD. A `dataDir` is kept and compared resolved, a restored
record's too, so `data/x/` and `data/x` are one directory. Resolving is
lexical: a path through a symlink is another directory's path.

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
| `fleet--restart` | `name` | Kill, then relaunch with the same recipe, dataDir, subscription, `env` and `autoRestart`. Cancels a pending automatic restart and starts a fresh retry budget (§4.6), as a `fleet--launch` of the same name does. |
| `fleet--relay` | `from, to, prefix?` | Send `from`'s last `inference:speech` to `to`. |
| `fleet--await` | `names[], timeoutMs?=300000, requireAll?=true` | Block until the named children emit `lifecycle:idle`; fails fast on crash/exit, partial result on timeout. |

The conductor is not fed fleet state in its context and is not woken by fleet
events; it learns about children by calling these tools.

### 4.3 Launch

A child is `<process.execPath> <process.argv[1]> <recipePath> --headless`,
spawned detached with env `{...process.env, ...env, AGENT_TIMEZONE, DATA_DIR}`.
The parent waits for the socket file, connects, sends `subscribe`, and waits
for `lifecycle:ready`.

**Failed launch.** Transient missing-socket and connection-refused errors are retried while the child sets up its socket. `socketWaitTimeoutMs` is checked between attempts, and each connect has its own 3 s timeout, so the final error can come up to 3 s after that deadline. A child that exits while its socket file is present, or after a refused connect, is reported as exiting before the parent could connect, with the refusal, since the file may be one a killed predecessor left. On a failure to set up the socket, `subscribe` or become ready, the parent sends SIGKILL to the process this launch spawned if it is still running (unless the parent is detaching, which leaves it running), then waits up to 2 s to observe its exit before returning the error. Unless the parent is detaching and leaves the child running, the error then quotes the end of what the child wrote to `startup.log` during this launch (§1), which names the cause when the stage can't, such as a recipe error or a missing key: its last 20 lines, at most 2,000 characters as printed, under a line naming the file, without escape sequences or control characters other than tab and newline. The parent reads the file as it sees the child exit (or, if it sees none, as it returns the error), since from then on the record allows another launch of the name, whose header and output come after; output written after the parent sees the exit, by anything that inherited the child's descriptor, isn't quoted. If the child wrote nothing, the error says so. A file shorter than where the launch began is quoted from its end under a line saying it was truncated, so what it holds may not be this launch's output. Another file at that path, such as one a link there names by then, isn't the file the child was given, which it goes on writing to through the descriptor it inherited, so the error says it was replaced and doesn't read it. When there's nothing to quote from, the error says why, with the error code where a call failed: when the child started, the parent couldn't open the file, found it wasn't a regular file, such as a FIFO there, or couldn't check it or write the launch's header to it, so the child's console output wasn't kept, which the host's log also says at the launch; or the file, when it's read, isn't a regular file or couldn't be read. A spawn that starts no process (Bun 1.3.14 and 1.4.3, Linux) either reports an error on a later tick, with no pid and no exit to follow, for a runtime that isn't there or that the parent may not run (`ENOENT`, `EACCES`), or throws, for a runtime the system can't execute (`ELOOP`, `ENOTDIR`, `ENOEXEC`), a NUL byte in an argument or an env value, an environment too large (`E2BIG`) or a bad descriptor. Either way the launch ends at once with the spawn's own error and its code, cut before any value it refused, since an env value may be a secret and the record's `exitReason` is saved. The parent then has nothing to stop or wait for, and records the child as `crashed` with that reason, so the name can be launched again. No automatic restart is tried, and for a child with `autoRestart`, `autoRestartStopped` says so. The error's way on follows the cause. A runtime that can't be started is for whoever runs the parent to fix, and calling `fleet--launch` again fails the same way until then. `fleet--launch` refuses a `name`, `recipe` or `dataDir` holding a NUL byte before anything starts, naming that field, as it does a missing one, and it drops env from the agent's input. So a value the spawn refuses comes from the parent's own configuration, such as an env value in its recipe, and only whoever runs the parent can change it, which takes effect when the parent restarts. Anything else, such as a limit the parent ran into, may not recur, and the error's step is `fleet--restart`, which keeps the record's env where `fleet--launch` drops it. A spawn that reports neither, starts no process and never binds the socket is reported the same way at the socket's timeout, as when the child's runtime can't be found. An error reported for a child that did start, such as a kill that failed, goes to the parent's log and changes nothing. The record's `exitReason` keeps the failure, without the quote, beside the exit (`child did not become ready: … (exit: SIGKILL)`), whichever came first. If termination remains unconfirmed, the error says so and the record stays `starting`, blocking another launch of that name until the exit is observed. The SIGKILL is a signal death and does not trigger autoRestart (§4.6), so a start the parent had to stop ends automatic restarts until a manual `fleet--launch` or `fleet--restart`, and `autoRestartStopped` says so, as it does for a signal from anywhere else; a child that exits non-zero on its own remains eligible under that section's conditions. An adopted process (§4.5) that fails its readiness check is not killed: it is left running. At the parent's start, its record stays blocked (`starting`, with the failure in `exitReason`); when a launch's own adoption fails, the record is left as it was, and the launch refuses with the leftover artifacts named.

**Interrupted launch.** A launch that starts while the parent is shutting down is refused at once. Otherwise every launch yields while it loads the recipe and reconciles leftovers, and it is refused, with nothing spawned, if during that time the parent began shutting down, a `fleet--kill` was acknowledged on the generation it replaces (a restart counts from its own start), another launch replaced that generation, or, for an automatic launch, its restart was cancelled; the error names which. A kill that fails (not attached, death unconfirmed) reports its error and refuses nothing. If the launch was adopting a living child, it stops that child rather than leave it unowned, unless it was refused because the parent is detaching. While one launch adopts a child, another launch of that name is refused, since the child keeps only its latest client. These checks guard the spawn: once a launch has spawned, a kill or shutdown acts on the new child like any running one.

**Leftover artifacts.** A launch never spawns into a dataDir that still holds
`ipc.sock` or `headless.pid`. If the parent tracks a child of that name with
the same dataDir and recipe, it first retries adoption (§4.5) when the record
allows it and the PID and socket look alive. Failing that, it removes the two
files only if the tracked PID is confirmed gone, `headless.pid` holds exactly
that PID, and the socket is absent or refuses connections. The refusal check
runs under `node`; a missing `node`, a timeout or any other answer leaves the
files in place. If either file remains, the launch is refused, naming the file
and what can help: with the parent's record of that name in the dataDir,
`fleet--status` and launching again with its recipe, which reattaches once that
child has finished starting and clears the files once the parent can confirm
they're a stopped child's; with another child's record there, that child's
name; with none, another `dataDir` or the host's operator. A parent with no
record of the child never removes them; an operator has to. A launch is also
refused while another of the parent's children is `starting` or `ready` in the
same dataDir and its pid is in use, since that child may be running there
before its files show it. That holds for every launch: a `fleet--restart`, an
automatic restart, whose refusal `autoRestartStopped` records, and an
autoStart. So is a launch of a name whose record the parent isn't attached to,
such as one restored at its start whose child hasn't answered yet, while that
record says `starting` or `ready` and its pid is in use, whatever dataDir it
gives: it would start a second process beside that child, or leave it running
untracked. These checks narrow races but are not a cross-process lock.

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
  removes nothing. If the probe fails, the record's `exitReason` is `adoption
  unresolved; …`, and if the handshake fails, `adopt failed: …`. Either way
  the record stays `starting` while it's from this boot and its PID is in use,
  and becomes `crashed` otherwise: when the PID is confirmed gone or isn't a
  usable one, or when the record is from an earlier boot, whatever holds its
  PID now, since no process outlives a boot. A record keeps the boot id it
  launched under, where Linux gives one (`/proc/sys/kernel/random/boot_id`),
  and an adoption gives it this boot's; another id means another boot. A
  record without one, or a host that can't read one, compares the record's
  start time with the machine's uptime, with a minute of slack. That rests on
  the clock: a clock stepped forward by more than a minute after a launch, as
  one without a battery is when it syncs after booting, makes that record look
  older than the boot, and a clock that booted behind makes an earlier boot's
  record look like this boot's. On such a machine, start the host once its
  clock is set. `fleet--restart` on that name, or `fleet--launch` with the
  record's recipe and dataDir, retries, reattaching once the child answers on
  its socket; while the record stays `starting` and its child doesn't answer,
  no other copy of it starts (§4.3). Records that ended for any other reason
  are kept for `status`/`list` but never adopted, even if their old PID is
  alive again.
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

Attempt history carries across automatic replacements, so a crash loop advances the backoff and reaches the cap. When the cap stops automatic restarts, `fleet--status` says so in `autoRestartStopped`, beside `autoRestart`. `fleet--kill`, `fleet--restart`, a `fleet--launch` of the same name and parent shutdown cancel a pending restart, and `fleet--restart` and `fleet--launch` start a fresh budget. A manual launch or restart also cancels an automatic replacement that is under way but hasn't spawned; once one has spawned, a launch answers that the child is already starting, and a restart replaces it. A manual launch takes over before its own checks, so one that is then refused leaves the child down, and `autoRestartStopped` says a manual launch took over. `autoRestartStopped` also names a kill, a signal exit (§4.3), and an automatic replacement that was refused or failed before it spawned. The history and `autoRestartStopped` are kept in the parent's memory, not persisted, so a child adopted by a new parent process starts with a fresh budget.

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
  snapshots don't, but nothing prunes the old ones, so rotate any credentials
  they carried.
- **Narrow subscriptions hide things.** `recipes/triumvirate.json` does not
  subscribe its children to `ops:alert`, so child ops alerts don't reach the
  parent's TUI.

---

**Sources.** `src/headless.ts`, `src/index.ts`, `src/recipe.ts`,
`src/commands.ts`, `src/tui.ts`, `src/modules/{fleet-types,fleet-module,tui-module,web-ui-module}.ts`,
`src/state/{agent-tree-reducer,fleet-tree-aggregator}.ts`, `src/web/panel-data.ts`.
Behavior is pinned by the `test/headless-*` and `test/fleet-*` suites.
