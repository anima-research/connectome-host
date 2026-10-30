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
| `--exit-when-idle` | One-shot: once the host has said `lifecycle:idle` (below) and nothing at all has been in flight for ≥500 ms, a running background script included, shut down gracefully with exit code 0. An armed self-restart (`modules.selfRestart`) takes its place and exits 75 instead; if it is cancelled, the host exits 0 once nothing at all has been in flight for 500 ms after the poll, every 100 ms, that sees the cancel. FleetModule never passes this flag. |
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
| `self-restart.json`, `self-restart.last.json` | With `modules.selfRestart`: a pending `lifecycle--restart` request (stamped with how the process exited), and the last completed one, which the cooldown is measured from. The next process's lifecycle module moves the first to the second at start. |
| `startup.log` | Opened by the *parent's* FleetModule as a fleet child's stdout and stderr, after a `--- launch …` line per launch. Bun's `console.*` writes to those descriptors directly (Bun 1.3.14 and 1.4.3), not through the redirected methods, so every console line the child prints goes to the file the parent opened here, for the child's whole life: a bad recipe, a missing key, an import error, and a fatal error after the redirect. The parent opens it without waiting for a FIFO's reader, and hands it on only as a regular file that took the launch's header; otherwise the child's console output goes nowhere, and the host's log says why. A link there is followed, when the parent opens the file and when it reads it. A launch that fails after the spawn quotes the end of what the child wrote here during it, or says why it can't, unless the parent is detaching and leaves the child running (§4.3). |
| `mcpl-servers.agent.child.json` | A fleet child's own agent overlay: the servers it deployed and unloaded for itself with `modules.mcplAdmin`. The parent writes it at a launch that finds none there, before the child's start reads it, and names it in `MCPL_AGENT_OVERLAY_FILE`. Its name is never the working directory's overlay's, `mcpl-servers.agent.json`, so it's the child's own whatever its data dir is, the working directory included. A child launched into its data dir before, whose `startup.log` is there, starts from a copy of the overlay in the working directory as it stands at that launch, which every child read as its own before children had their own, tombstones included; a new child starts from an empty one, even in a data dir made for it ahead of time, `.` included, and so does a child from before this version whose `startup.log` is gone. It's made its owner's alone, never wider than 0600, and a copy never wider than the original, since it can hold the tokens its deploys carry. From then on the file is the child's, and the parent's own deployments no longer reach it: empty it (`{"mcplServers": {}}`) to start the child with none of them, since a launch that finds the file gone copies the working directory's again, where the child's `startup.log` is there. Relative `./` args in it resolve against the working directory, which the child shares with the parent. A link someone makes at a child's own overlay file is kept as made. |

**Connection model.** One client at a time; a new connection closes the
previous one. On every connection the subscription resets to `['*']` and the
child emits `lifecycle:ready`. A client disconnecting does not stop the child.
A client must keep reading. The child sees only its own queue for a client:
once a write to the client is refused, the child gives it five minutes to
empty that queue, and a client whose queue it still holds then is closed,
with the child's log saying how much was left unsent. What has gone into the
socket's buffers is beyond the child's sight, so a client that stops reading
with no more than that unread isn't closed for it. A client that keeps up is
never closed; one that reads but can't keep up with the events is. A client
the child writes nothing more to, because it was superseded or because it
ended its own side, is watched only while a deadline it already had runs: one
that stops reading with no deadline running stays open until it closes
itself, holding no more than its socket's buffers and the child's queue below
the point where writes are refused.
Framework events from before the first client ever connected — the boot,
including what `create()` replays about a restart (a resumed tune-out epoch,
a fork a stop cut off) — are kept, the first 1,000 of them, and sent to that
first client after its `ready`, each with `replay: true`; if more were
emitted, the replay ends with `lifecycle` `replay-truncated` saying how many
were cut. After that, events emitted while no client is connected are
dropped, not buffered: a later client sends `describe` for a `snapshot`.

**Shutdown.** Triggered by `{"type":"shutdown"}`, by `/quit` sent as a
`command`, by SIGTERM or SIGINT, by `--exit-when-idle`, or by an agent's
armed self-restart (`modules.selfRestart`), which goes once the host has said
`lifecycle:idle` (below) and nothing at all has been in flight for ≥500 ms, a
running background script included. The child emits
`lifecycle:exiting`; from then on it starts no session switch, and one under
way that hasn't installed its new framework stops at its next step, stopping a
framework it has made rather than starting it (one already installing
finishes). It waits ~50 ms for the line to flush, and for a switch under way
to settle, logging that it waits if the switch is still running then, for as
long as the switch takes: connecting each server is bounded, but an
extension's `register()`, or an MCPL server's tool listing under
`requestTimeoutMs: 0`, isn't. Then it calls `framework.stop()`
(which cancels in-flight streams rather than letting them finish), closes the
server, unlinks the socket and pid file, and exits once `headless.log` has
taken its last lines: 0 (75 for a self-restart), or 1 if `framework.stop()`, or stopping what the switch made, failed. It waits at
most 2 s, then exits anyway with a line on its stderr. What it writes
through `process.stdout.write` and `process.stderr.write` once the log has
ended goes to its stderr too; Bun's `console.*` writes to its stdout and
stderr directly, before and after. `graceful: false` only changes the
reason string.

---

## 2. Wire protocol

JSON Lines in both directions, one object per `\n`-terminated line.

- The child logs and drops malformed lines. Unknown `type`s and invalid fields
  are logged and **get no reply**, except that a `panel-request` for an op the
  child doesn't know or with params it can't read, and an `update-request` it
  can't read, are answered `ok: false` with why, and a `command` with a
  `corrId` whose `command` isn't a string is answered with its `command-done`,
  with `error`.
- Lines are dispatched as they arrive, without waiting for the previous one to
  finish: correlate replies by `corrId`, not by order.
- Every outgoing object is stamped with `ts: Date.now()` (overwriting any `ts`
  the event already carried).

### 2.1 Parent → child

Types live in `IncomingCommand` (`src/modules/fleet-types.ts`).

| `type` | Fields | Behavior / reply |
|---|---|---|
| `subscribe` | `events: string[]` | **Replaces** the filter (not additive; `[]` blocks every non-exempt event). No reply. |
| `text` | `content`, `from?` | Pushes an `external-message`, which requests inference; a recipe's wake gate may decline it, and then no turn starts. Without `from`, its `source` is `'headless'`, and the agent is told the message has no channel locus, so a plain-prose reply won't reach a chat surface. With `from: "console"`, as `connectome send` sends it, its `source` is `'cli'`, as batch mode's lines are, with no such note. A received text counts as activity, and stays in flight until a framework has processed it: the next `lifecycle:turn-work-done` and `lifecycle:idle` cover it (their `texts`). In a session switch, a text the replaced framework hadn't taken from its queue, and one the stopped framework refuses, goes to the new session's framework when the host follows the switch. If the switch fails, no framework runs, so those texts stay in flight, neither comes, and an `--exit-when-idle` host doesn't exit on its own. While a switch is under way the host isn't quiet, and a second switch is refused until it has finished, before any session is made or made active. |
| `command` | `command` (e.g. `"/status"`), `corrId?` | Runs through the slash-command handler (`src/commands.ts`). Each output line comes back as a `command-output` event. With a `corrId`, each line carries it and a `command-done` ends the answer, after any follow-up the command awaits; without one, nothing marks the last line. `/quit` triggers shutdown, after the `command-done`. |
| `shutdown` | `graceful?` | See Shutdown above. |
| `describe` | `corrId?` | → `snapshot` |
| `request-lessons` | `corrId?` | → `lessons-snapshot` |
| `request-workspace-mounts` | `corrId?` | → `workspace-mounts-snapshot` |
| `request-workspace-tree` | `mount`, `corrId?` | → `workspace-tree-snapshot` |
| `request-workspace-file` | `path`, `corrId?` | → `workspace-file-snapshot` (≤5000 lines, with `truncated`, or `error`) |
| `cancel-subagent` | `name`, `corrId?` | → `cancel-subagent-result`. The only way to stop a subagent that lives inside a child. |
| `panel-request` | `op`, `params?`, `corrId?` | → `panel-response`, via the same `runPanelOp` the WebUI runs in-process (§3). |
| `update-request` | `request`, `corrId` | → `update-response`. A switch's request from the install's host (`src/update/quiesce.ts`): `{op: 'quiesce', to, waitMs}` quiesces the child under the switch's reason for `to` and waits up to `waitMs` for its turns to end (a `waitMs` under a second still waits up to a second, agent-framework's least), answering whether it drained, which agents hold a turn and how many scripts run outside a turn, or, for a child whose quiesce was ended meanwhile, that it can't be counted; `{op: 'resume'}` ends the switch's quiesce, leaving any other. A request it can't read is answered `ok: false` with why. |

### 2.2 Child → parent

**Framework traces.** Every `framework.onTrace()` event is forwarded verbatim,
subject to the subscription filter: `inference:*`, `tool:*`, `usage:updated`,
`ops:alert`, and so on.

**Events added by the headless runtime:**

| Event | Payload | When |
|---|---|---|
| `lifecycle` (`phase: "ready"`) | `pid, dataDir, recipe, idle, turnWork, agent` | On every socket accept, sent before the parent's `subscribe` can arrive. `recipe` is the recipe's display name, not a path. `idle` is whether the host has said `lifecycle:idle` since its last `inference:started` or `text` received and is still quiet as that idle reads it: every agent idle, with nothing in flight but a background script. When it has said idle and isn't quiet, the quiet that follows brings a new `lifecycle:idle`. `turnWork` is whether turn work is in flight as the client connects (the next row). `agent` is the name the framework runs the recipe's agent under (the recipe's, else the session import's, else `agent`), the one whose `inference:speech` the socket carries. A parent that sends texts on this connection counts them from zero. |
| any framework trace, with `replay: true` | the trace's own fields | To the first client only, right after its `ready`: the events from before it connected, oldest first. Timestamps are the events' own; `ts` is the send time. |
| `lifecycle` (`phase: "replay-truncated"`) | `dropped, kept` | After that replay, only when the boot outran the 1,000 kept: how many events were cut after them. |
| `lifecycle` (`phase: "turn-work-done"`) | `texts` | When, after turn work the host has seen (an `inference:started` of an agent that isn't a subagent's, a `text` received, or turn work in flight at a poll or at a client's `ready`), no turn work has been in flight for ≥500 ms. An armed self-restart isn't turn work. Turn work is a turn of an agent that isn't a subagent's run (one assembling, or waiting to retry, included), a wake on its way to a turn, a text whose processing (its modules' `onProcess`) is under way, or an event on the framework's queue. A running background script or subagent run isn't turn work, though a subagent's own request, counted host-wide among gated or parked wakes or on the queue, briefly is. A wake a recipe's wake-gate debounce holds isn't seen: agent-framework 0.30.0 doesn't count it, so `turn-work-done` can come before that turn. `texts` is as for `lifecycle:idle`. Fires once after each stretch of turn work the host sees. Where a stretch ends in `lifecycle:idle` too, `turn-work-done` comes first, since quiet holds only once turn work has ended. |
| `lifecycle` (`phase: "idle"`) | `texts` | When, after at least one `inference:started` or `text` received (or once a self-restart is armed), every framework agent has read idle with nothing in flight but a background script left running for ≥500 ms. An `inference:started`, a `text` received, arming or cancelling a self-restart, or a client's `ready` that reports turn work or finds the host not quiet after its idle, starts the 500 ms again. `texts` is how many texts the host has received on this connection, all of which this quiet covers. Nothing in flight means no turn the framework counts alive (one assembling, or waiting to retry, included), no gated wake, no event on the framework's queue, no `text` whose processing (every module's `onProcess`) is still under way, no subagent run, and no operator's work still under way: a `command`'s follow-up (such as `/newtopic`'s summary), from whichever entry sent the command; a credential action (such as `/auth login` waiting for its code to be entered, which the Codex subscription's login gives up on after 10 min by default); and an action that holds a session switch off (the Web UI's session-changing actions, a session-changing `panel-request`, a release switch's `quiesce`). A background script left running doesn't hold it: in agent-framework 0.28.0, a script that ends cleanly wakes no one. A text a recipe's wake-gate debounce holds isn't seen: agent-framework 0.30.0 doesn't count it, so the idle can come before that turn. Fires once, and again only after the next `inference:started` or `text` received, or a client's `ready` that finds the host not quiet. A text a wake gate declines still ends in an idle, once nothing has been in flight for 500 ms after its processing; texts that arrive together share one. |
| `lifecycle` (`phase: "exiting"`) | `reason` | `shutdown:graceful`, `shutdown:immediate`, `command:/quit`, `SIGTERM`, `SIGINT`, `exit-when-idle`, `self-restart`. A crash emits nothing. |
| `inference:speech` | `agentName, content` | Primary agent only: the text of an inference round that ended without tool calls. Used by `fleet--relay`. |
| `command-output` | `text, style, corrId?` | One per line of a `command` reply, carrying the command's `corrId` when it had one. A response, not telemetry (see below). |
| `command-done` | `corrId, error?, refused?` | The end of the answer to a `command` that carried a `corrId`, with `error` when the command threw, and `refused: true` when `/update` answered that it didn't do what was asked; its lines say why. Only `/update` marks an answer so, and another command's refusal, such as `/session new` or `/session switch` while a switch is under way, ends with a plain `command-done`. `/update` marks it for its refusals, such as an install with nothing newer offered, a restart whose turns didn't end in time or a `back keep` for a Go back no longer offered, for words it doesn't take, for a check whose read of the registry failed, and for `back` alone when it can't read the Go back offer or asks a host that isn't an install. |

**Responses** — `snapshot`, `lessons-snapshot`, `workspace-mounts-snapshot`,
`workspace-tree-snapshot`, `workspace-file-snapshot`, `cancel-subagent-result`,
`panel-response`, `update-response`, `command-done` — each echo `corrId`; `command-output` lines answer a
`command` and carry its `corrId` when it had one. A response goes only to the connection that sent the
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

The ten response types — the nine `corrId` replies and `command-output` —
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
| `fleet--await` | `names[], timeoutMs?=300000, requireAll?=true` | Block until the named children emit `lifecycle:idle`; fails fast on crash/exit, partial result on timeout. A child counts as idle while its last `lifecycle:idle` came after its last `inference:started` and covers every `text` this host has sent it on the connection (`texts`), read again on each of its events and every 200 ms. An idle with no `texts`, from an older child, counts. A text a wake-gate debounce holds can be covered before its turn (the idle row). An adopted or reconnected child counts as idle when its `ready` says `idle`. An await already waiting counts a child that went idle and then exited, or was restarted; one that exits before going idle fails the wait, and so does an await begun after a child has exited. A `command` isn't work: an await before a command's turn starts answers from the earlier idle. |

The conductor is not fed fleet state in its context and is not woken by fleet
events; it learns about children by calling these tools.

### 4.3 Launch

A child is `<process.execPath> <process.argv[1]> <recipePath> --headless`,
spawned detached with env `{...process.env, ...env, AGENT_TIMEZONE, DATA_DIR, CONNECTOME_UPDATE_CHECK=0, MCPL_AGENT_OVERLAY_FILE}`,
less `CONNECTOME_INSTALL_ROOT`, so a child is never an install's host, and `CONNECTOME_FLEET_BEGIN`, which the fleet sets again for a gated child, and
no `cwd`, so it runs in the parent's working directory.
The parent waits for the socket file, connects, sends `subscribe`, and waits
for `lifecycle:ready`.

**Failed launch.** Transient missing-socket and connection-refused errors are retried while the child sets up its socket. `socketWaitTimeoutMs` is checked between attempts, and each connect has its own 3 s timeout, so the final error can come up to 3 s after that deadline. A child that exits while its socket file is present, or after a refused connect, is reported as exiting before the parent could connect, with the refusal, since the file may be one a killed predecessor left. On a failure to keep the child's record at its spawn (§4.5: the store's write, its sync, or the children file), to set up the socket, `subscribe` or become ready, the parent sends SIGKILL to the process this launch spawned if it is still running (unless the parent is detaching, which leaves it running; a child the parent hadn't told to begin yet (§4.5) ends with the parent instead, having done nothing), then waits up to 2 s to observe its exit before returning the error. Unless the parent is detaching and leaves the child running, the error then quotes the end of what the child wrote to `startup.log` during this launch (§1), which names the cause when the stage can't, such as a recipe error or a missing key: its last 20 lines, at most 2,000 characters as printed, under a line naming the file, without escape sequences or control characters other than tab and newline. The parent reads the file as it sees the child exit (or, if it sees none, as it returns the error), since from then on the record allows another launch of the name, whose header and output come after; output written after the parent sees the exit, by anything that inherited the child's descriptor, isn't quoted. If the child wrote nothing, the error says so. A file shorter than where the launch began is quoted from its end under a line saying it was truncated, so what it holds may not be this launch's output. Another file at that path, such as one a link there names by then, isn't the file the child was given, which it goes on writing to through the descriptor it inherited, so the error says it was replaced and doesn't read it. When there's nothing to quote from, the error says why, with the error code where a call failed: when the child started, the parent couldn't open the file, found it wasn't a regular file, such as a FIFO there, or couldn't check it or write the launch's header to it, so the child's console output wasn't kept, which the host's log also says at the launch; or the file, when it's read, isn't a regular file or couldn't be read. A spawn that starts no process (Bun 1.3.14 and 1.4.3, Linux) either reports an error on a later tick, with no pid and no exit to follow, for a runtime that isn't there or that the parent may not run (`ENOENT`, `EACCES`), or throws, for a runtime the system can't execute (`ELOOP`, `ENOTDIR`, `ENOEXEC`), a NUL byte in an argument or an env value, an environment too large (`E2BIG`) or a bad descriptor. Either way the launch ends at once with the spawn's own error and its code, cut before any value it refused, since an env value may be a secret and the record's `exitReason` is saved. The parent then has nothing to stop or wait for, and records the child as `crashed` with that reason, so the name can be launched again. No automatic restart is tried, and for a child with `autoRestart`, `autoRestartStopped` says so. The error's way on follows the cause. A runtime that can't be started is for whoever runs the parent to fix, and calling `fleet--launch` again fails the same way until then. `fleet--launch` refuses a `name`, `recipe` or `dataDir` holding a NUL byte before anything starts, naming that field, as it does a missing one, and it drops env from the agent's input. So a value the spawn refuses comes from the parent's own configuration, such as an env value in its recipe, and only whoever runs the parent can change it, which takes effect when the parent restarts. Anything else, such as a limit the parent ran into, may not recur, and the error's step is `fleet--restart`, which keeps the record's env where `fleet--launch` drops it. A spawn that reports neither, starts no process and never binds the socket is reported the same way at the socket's timeout, as when the child's runtime can't be found. An error reported for a child that did start, such as a kill that failed, goes to the parent's log and changes nothing. The record's `exitReason` keeps the failure, without the quote, beside the exit (`child did not become ready: … (exit: SIGKILL)`), whichever came first. If termination remains unconfirmed, the error says so and the record stays `starting`, blocking another launch of that name until the exit is observed. The SIGKILL is a signal death and does not trigger autoRestart (§4.6), so a start the parent had to stop ends automatic restarts until a manual `fleet--launch` or `fleet--restart`, and `autoRestartStopped` says so, as it does for a signal from anywhere else; a child that exits non-zero on its own remains eligible under that section's conditions. An adopted process (§4.5) that fails its readiness check is not killed: it is left running. At the parent's start, its record stays blocked (`starting`, with the failure in `exitReason`); when a launch's own adoption fails, the record is left as it was, and the launch refuses with the leftover artifacts named.

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
  Chronicle store, from the moment a launch spawns the child, and syncs that
  first write to disk at once through the store sync its host gives it
  (`setStoreSync`). While it adopts children on start, it writes once, when
  every child it takes back is in its map, since a write before then would
  record the rest as gone. Env overrides are runtime-only and never persisted:
  an adopted child recovers them from the current configured child with the
  same name, recipe and dataDir, `autoStart: false` entries included, and a
  mismatch logs the differing fields and withholds the overrides, without
  logging their values (#180).
- **The children file.** A host started from an install (with
  `CONNECTOME_INSTALL_ROOT`) whose recipe has a fleet also keeps
  `<DATA_DIR>/fleet-children.json`, which the install's launcher reads before
  a switch: whether any child may still be running, and where each child's
  data is. The module writes it with each persist, after the store's write,
  and at a launch after the store's sync too, so it lists a child only once
  the store has kept it, but for a launch while the module adopts, whose
  child it lists before the adoption's write keeps the record. On such a
  host a child begins only once the file lists it: the module starts it with `CONNECTOME_FLEET_BEGIN` set and a pipe on its
  stdin, and writes a line there after that launch's write. A child whose
  stdin ends or fails before the line comes exits, having done nothing in its
  data directory; only what its runtime and imports print before it waits
  reaches `startup.log`, which the parent opened for it (§1)
  (`src/fleet-begin.ts`). Each entry has the child's name, data directory and
  boot id, and its pid while it's starting or ready. A child leads a process
  group of its own, whose id is its pid, and when the module sees a child end
  it sends what is left of that group SIGKILL, so a helper the child started
  there doesn't go on after it: on the child's exit event, or, stopping an
  adopted child, when its connection to the child was open as the stop began,
  which only the child's own process can hold. A child whose end the module
  didn't see, such as one that ended while no host ran, gets no signal, since
  that group may have emptied and its id been taken since. Either way the
  entry keeps its pid while the group has a member and the record is from
  this boot (told as adoption tells it, below), and the pid becomes null once
  the module finds the group empty: a signal that finds no process in it, a
  stop, which waits up to 2 s after its signal, a write 2 s after an exit it
  saw, or any later write once the child's end is recorded (an adopted child
  whose process ends unseen stays recorded as running until a stop or the
  next host's adoption). A process holding the child's own pid by then shows
  the group has ended, since a pid isn't handed out while a group with that
  id has a member. It stays
  null across a restart of the host, since the record keeps it. A process a
  SIGKILL can't reach or end, such as one under another user, stays, and so
  does the entry. `fleet--kill` of a child whose group still has a process,
  and a failed launch that leaves one, say so, and whether the module's
  signal went out, was refused or wasn't sent. A record whose group has
  ended isn't adopted. A write lists
  the module's own children and keeps what the file already holds that it
  doesn't replace, so it's the host's list across its sessions: another
  directory's entry, its pid kept only while a process of this boot, or a
  member of the group it leads, may hold it; another generation still running
  in a child's own directory; and an entry without a child's shape
  (`isChildEntry`), as it is. A file the module can't read is left as it is,
  and the write fails: at a launch's spawn the launch then fails, and every
  launch that spawns a child fails that way until whoever runs the host fixes
  the file, or removes it once no child it lists is running. A host on trial
  also lists there each fleet child's store audit while it runs (`<child>'s
  store audit`, with its pid), which the launcher's fallback waits for like a
  child (`src/update/audit-stores.ts`).
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
  the clock: a clock stepped forward after a launch by more than the time
  from the boot to that launch plus a minute, as one without a battery is when
  it syncs after booting, makes that record look older than the boot, and a clock that booted behind makes an earlier boot's
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
  SIGKILL as backstop: to a spawned child's process group while the child
  runs, and to an adopted child's while the module's connection to it is
  open, and otherwise to its pid. Only a hard crash of the parent orphans
  children.
- **Detach** (the `d` answer at the quit prompt) leaves children running; the
  next parent adopts them.

### 4.6 autoRestart

Restarts only on a **non-zero exit code** (signal deaths don't count), and
never when the child was asked to stop or the parent is shutting down. Backoff
is roughly 1 s, 3 s, 10 s plus jitter; after 3 attempts within 60 s,
restarting is disabled for that child. A child's self-restart (exit 75) is a
non-zero exit like any other: the parent restarts it only with `autoRestart`
set, and counts it toward the cap. A child the parent adopted (§4.5) has no
exit the parent sees, so it stays down after a self-restart. A parent's own
self-restart stops its children as any shutdown does: the restarted parent
starts its `autoStart` entries again, and any other child stays down until
it is launched again.

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
  that child through `FleetModule.requestPanel()` (404 unknown child, 502 for
  a child it can't reach or whose connection closed before it answered, 504
  after the 30 s default timeout; otherwise the child's own status). WebSocket panel messages carry `scope` the same way, and the
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
`src/commands.ts`, `src/tui.ts`, `src/modules/{fleet-types,fleet-module,fleet-socket-probe,tui-module,web-ui-module}.ts`,
`src/state/{agent-tree-reducer,fleet-tree-aggregator}.ts`, `src/web/panel-data.ts`.
Behavior is pinned by the `test/headless-*` and `test/fleet-*` suites.
