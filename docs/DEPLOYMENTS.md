# Connectome Deployments — Operations

**Status:** working notes. This document gathers operations patterns for running
Connectome agents. To set up the *code stack* (repositories, branches and
symlinks), see [`DEV-ENVIRONMENT.md`](./DEV-ENVIRONMENT.md). To set up a new
resident, use `connectome setup discord` and its guide,
[`AGENT-ONBOARDING.md`](./AGENT-ONBOARDING.md).

---

## TL;DR

An agent deployment is the Connectome stack (`connectome-host` +
`agent-framework` + MCPL servers) plus a per-agent install dir. Agents run
**headless** (`bun connectome-host/src/index.ts <recipe> --headless`),
each as its own OS user, supervised by launchd (macOS) or systemd-user (Linux).
Headless mode and the fleet protocol are specified in
[`fleet-protocol.md`](./fleet-protocol.md).

> **Model integrity matters.** Each agent has a *correct* model and must stay on
> it — feeding one model's chronicle to another is treated as a continuity
> violation. If an agent is ever contaminated onto the wrong model, delete the
> contaminated interlude and re-ingest the correct-model archive.

---

## Hosts

- **local (macOS)** — supervised with launchd (`gui/$(id -u)/…`). Dev checkouts
  live under `~/connectome-local/*` and are symlinked into the host (see
  DEV-ENVIRONMENT).
- **VPS (Linux)** — systemd **user** services (lingering enabled). If `sudo` is
  unavailable on the box, run everything as user services. A box reached only
  via a login user that differs from the agent user can be driven over SSH (or
  the terminal-sessions MCP).

---

## Shared infra (per host)

### Shell — terminal-sessions daemon
The shell tool is a per-agent MCP frontend talking to one shared, token-auth'd
session daemon. Each agent's recipe passes `SESSION_SERVER_TOKEN` (from its
`.env`); without it the daemon drops the socket ("Connection lost").

- Bind the daemon to **loopback** (`127.0.0.1:<port>`), never a public
  interface. Reach it (and any loopback service) by SSH-tunnelling through a
  login account, not by exposing a port.
- Tokens differ per host — each daemon is independent; don't share tokens
  across machines. Values live in the `.env` files — **not** in this doc.

### Debug context API
`GET /debug/context` (no inference, no message writes) is served by the `webui`
module. Keep it on **loopback** and reach it via SSH tunnel. See
[`debug-context-api.md`](./debug-context-api.md).

---

## Operating an agent

In a shell command, put each path or value that you fill in between single quotes. A space or a shell character in it then stays part of it. Write each `'` inside such a value as `'\''`.

**Recipe / config / data live in the install dir:**
- `recipes/<agent>.json` — agent def, model, MCP servers (absolute paths to each
  `dist/`), wake-gate policies, modules.
- `.env` — `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`, an OAuth/subscription
  bearer token that takes precedence over the key), `DISCORD_TOKEN`,
  `DISCORD_GUILD_ID`, `DISCORD_MCPL_DEBUG_LOG`, `DISCORD_SUBSCRIPTIONS_FILE`,
  `SESSION_SERVER_TOKEN`, `HEARTBEAT_CONFIG_FILE`; the WebUI credentials the
  recipe's `${VAR}`s name (e.g. `WEBUI_USER` / `WEBUI_PASS`); optionally
  `CONNECTOME_OPS_WEBHOOK` (ops alerts, below). The host reads `.env`, but a
  stdio MCPL server sees only the variables its entry maps in `env` (plus a
  small system allowlist, the host's `AGENT_TIMEZONE` and agent-framework's
  default `DISCORD_SUPPRESSED_REACTIONS_BASELINE`), unless the entry sets
  `inheritEnv: true`, which passes the host's whole environment: an unmapped
  `DISCORD_GUILD_ID` is unset for discord-mcpl, which then serves every
  channel the bot is invited to. With `inheritEnv`, a
  `DISCORD_SUPPRESSED_REACTIONS_BASELINE` with tokens in the host's
  environment replaces agent-framework's default. See DEV-ENVIRONMENT for
  file-defined servers.
- `data/` — chronicle store + per-session `config/gate.json` (wake policies;
  append-only reconcile, so reorder the **live** file, not just the recipe).

**Start / stop / restart:**

| | local (launchd) | VPS (systemd-user) |
|---|---|---|
| restart | `launchctl kickstart -k gui/$(id -u)/<label>` | `systemctl --user restart <unit>` |
| stop | `launchctl bootout gui/$(id -u)/<label>` | `systemctl --user stop <unit>` |
| start | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist` | `systemctl --user start <unit>` |

Labels and units are named `cc.<agent>.agent` (launchd) and
`<agent>-agent.service` (systemd). Under launchd, KeepAlive starts an agent
again after a plain `kill` or `stop`: use `bootout` to stop it, and
`kickstart -k` to restart it. A service that `connectome service install` writes
is named after the install's working directory instead:
`com.animalabs.connectome.<name>` or `connectome-<name>.service`. Its shell
daemon is `com.animalabs.connectome.<name>.shell` or
`connectome-<name>.shell.service`. `<name>` is the directory's name in lower
case, with each run of characters other than `a` to `z` and `0` to `9` made one
`-`, and no `-` at either end. `connectome` alone shows its own stop and start
commands, and how to follow its log. When a stop runs past the platform's
timeout, SIGKILL ends it, and what was still in flight is cut off. On macOS,
that timeout is the exit timeout that `launchctl print gui/$(id -u)/<label>`
shows: 5 s for these agents on macOS 26. Under systemd, it is the unit's
`TimeoutStopSec`, 90 s by default. The host's own stop has no time limit.

Under the systemd unit, a host's fleet children end when the host exits. The
unit's `KillMode=mixed` sends a stop's SIGTERM to the host alone. Once the host
exits, it sends SIGKILL to each process that is left, a child that the host
detached included. So when a fleet's parent exits without stopping its children,
as at a crash, the children are killed in the middle of their work.

On macOS, the host's log, `logs/agent.log`, and the shell daemon's log,
`logs/shell.log`, grow until someone cuts them. launchd appends to each log and
holds it open. So if you delete a log while its service runs, nothing writes to
it again until the next load. To cut a log, stop the service with its stop line,
move or delete the log, and then start the service with its start line.

A restart can make auxiliary model calls before any user message:
agent-framework at once drains the compression and merge debt of the restored
Context Manager. This happens only when the store has pending maintenance. The
calls show in the new process's `llm-calls.<iso>.jsonl`. They are not an agent
wake or a user turn.

**Moving a resident off heartbeat-mcpl.** The heartbeat is now part of agent-framework, as `modules.heartbeat`. A recipe that turns it on can't also name `mcpServers.heartbeat`. The host refuses such a recipe at load, since both would wake the agent, and their tools share the names `heartbeat--…`. To move a resident over, replace its `mcpServers.heartbeat` with `"heartbeat": { "importFrom": { "configPath": "<its HEARTBEAT_CONFIG_FILE>", "remindersPath": "<its HEARTBEAT_REMINDERS_FILE>" } }` under `modules`. The first start that finds no heartbeat state of the framework's own then brings the server's schedule and reminders along. Once the framework has kept its own state, it reads that state and imports nothing. The resident's wake rules for `source: "heartbeat"` keep applying, since the framework's ticks and reminders reach the gate as the server's pushes did ([ATTENTION-AND-GATING.md](./ATTENTION-AND-GATING.md)).

**Logs and observability** (below, `data/` is `DATA_DIR`, by default `./data`
under the working directory):
- The discord-mcpl debug log is `data/discord-mcpl-debug.log`. It holds incoming
  events, attachments, `handlePublish` and wake metadata.
- The host's stdout and stderr go wherever the plist or the unit sends them: for
  example launchd's `StandardOutPath` and `StandardErrorPath` (such as
  `data/launchd-stdout.log` and `launchd-stderr.log`), a unit's
  `StandardError=append:…/service-stderr.log`, or else
  `journalctl --user -u <unit>`. Those file names are conventions of the plist
  or the unit, and the host does not create them. `--headless` sends
  `process.stdout.write` and `process.stderr.write` to `data/headless.log`,
  beside `headless.pid` and `ipc.sock`. But Bun's `console.*` bypasses those
  methods. So `console.error` and `console.log` lines, such as
  `[inference-failed]`, `[routeSpeech]` and `[webui] listening …`, still reach
  the supervisor's stdout and stderr. `headless.log` holds mostly the headless
  runtime's own lines.
- Routing decisions go to stderr, as `[routeSpeech] …` and `[routing] …` lines.
  In readline mode they go to `data/readline-error.log` instead (below).
- Raw model calls go to `data/llm-calls.<iso>.jsonl`, a new file at each start
  of the process. The file is for forensics, and it is large.
- `logs/failures.log` holds JSONL records of failures and ops alerts (below).
  Its path is relative to the process's **working directory**, not to
  `DATA_DIR`.
- Each session's `data/sessions/<id>/` holds two logs. `operator-actions.jsonl`
  records who changed a session as an operator, and why, such as by surgery in
  the WebUI (see [`webui-live-surgery.md`](./webui-live-surgery.md)).
  `mcpl-stderr/<server>.log` holds each MCPL server's stderr, with a line for
  each connect, close and error. It rolls over to `.1` at 10 MB.
- Readline mode (`--no-tui` with stdin on a terminal) logs to
  `data/readline-error.log`. The log takes what the process writes through
  `process.stderr.write`, `console.error` and `console.warn`, such as library
  diagnostics, `[routeSpeech]`, `[routing]` and `[inference-failed]`. It takes
  them from readline mode's banner until the host has stopped. For setup's host,
  it starts before the host's extensions load. The host creates the log so that
  only its owner can read it, and writes each line to it as the line comes. What
  the person at the terminal needs still prints there, each on a line of its
  own: a turn's failure and how the turn ended, a slash command's failure, the
  host's own ops alerts (as the TUI words them; a fleet child's alerts don't
  print there), an update notice, a self-restart's failure to close the Web UI's
  server, and the log's path at start, when the log opened. A crash prints on
  the terminal too. If the log can't be opened or written, the host says so.
  From then on, the lines that the log would have taken print on the terminal,
  as before. Batch mode keeps stderr as it is.
- TUI mode logs to `data/tui-error.log`. A fleet child's stdio goes to
  `startup.log` in the child's data directory (by default `./data/<child>/`
  under the parent's working directory). The parent opens that file when it
  spawns the child.
- **Inference failures** (agent-framework). When a turn's inference fails after
  its retries, the framework does three things. It prints
  `[inference-failed] agent=… consecutive=N type=… status=… code=…: <reason>`
  to stderr (in readline mode, to `data/readline-error.log`). Each label is
  there only where the error has it. It appends a JSONL record to
  `logs/failures.log`. And it adds an `[inference-failed]` marker to the agent's
  chronicle, so that the agent learns that its turn failed
  (`SUPPRESS_INFERENCE_FAILED_MARKER=1` turns the marker off). The marker names
  at most the error's type and HTTP status. It gives a reason only where
  agent-framework, membrane's progress bounds or context-manager wrote the
  failure's message, such as a progress bound's cut. At 3 consecutive
  failures, it logs `[inference-hard-down]` and raises an ops alert. The alert
  is an `ops:alert` trace, and also a POST to `CONNECTOME_OPS_WEBHOOK` if that
  is set, at most one per agent and kind in 15 min. If those failures are
  `invalid_request` rejections of the history itself, a poison-history breaker
  sheds the newest complete exchange and tries again.
  `refusalHandling.maxRewinds` (default 3) caps how many times it does so in one
  episode.
- **`scripts/connectome-doctor [--data-dir DIR] [INSTALL_DIR] [UNIT]`** answers
  "why isn't the agent responding?" in one run. It needs python3 and a
  systemd-user box. It prints the service's state, the disk, a ladder of when
  each pipeline stage was last seen (discord event → chronicle ingest →
  `llm-calls` → delivery), recent failures, and a live dump of the gate through
  `SIGUSR2`. When `connectome doctor` finds no problem on a systemd install, its
  last line is the line that runs this script, with the install's working
  directory and unit. That line adds `--data-dir` where the data directory isn't
  the working directory's `data`. In an install that setup made, the script is
  `<install>/current/node_modules/@animalabs/connectome-host/scripts/connectome-doctor`.
  The script reads the host's lines from the first `StandardOutput=` or
  `StandardError=` path (`file:` or `append:`) in the unit file's text, a
  commented line included. Without such a path, it reads
  `INSTALL_DIR/logs/agent.log`, unless that file was last written before the
  unit started. Failing that, it reads the unit's journal. From the journal it
  takes the lines since the unit's latest start that hold a delivery or a
  failure, which journalctl's `-g` picks out, and the time of the journal's last
  entry. If journalctl refuses `-g`, those stages stay unseen, and the script
  says so. The same holds for a unit whose start time systemd doesn't give. An
  earlier start's inference failures are in `INSTALL_DIR/logs/failures.log`.
  Recent failures come from that file too: its records in its last 400 KB, of
  every kind but the subscription GC's `subscription-gc-close`. The script shows
  the last five failures from each place that it reads, and how many older ones
  it leaves out. Chronicle ingest comes from the active session's `records.log`,
  as `sessions.json` names it. The Discord stages come from
  `DATA_DIR/discord-mcpl-debug.log`, which discord-mcpl writes only when
  `DISCORD_MCPL_DEBUG_LOG` names it. The inference stage is the newest turn's
  call in the newest `llm-calls` file (each start of the host opens a new one):
  that is, the file's newest streamed call. A subagent's turn is a streamed call
  too, and so is a streamed inference that an MCPL server asks for. So on a host
  with either, the stage's time and stop can be that call's, and not the
  resident's. Other calls, such as the start-up thinking-binding probe and
  compression, are only counted. Their count shows in "no turn's model call
  since the host last started", when there is no turn's call. A stage that the
  ladder can't see reads "can't be seen here", with the reason. The script sends
  `SIGUSR2` only to a host whose `/proc/PID/status` says that it catches the
  signal. A host that hasn't built its framework yet has no listener, and the
  signal's default action would end it. The script waits up to 5 s for the
  host's `[diagnostics]` line. `--data-dir` names the host's data directory,
  `INSTALL_DIR/data` when left out. The ladder cuts a message's preview at 40
  characters, a model call's error at 80, and each line of its recent failures
  at 150. It quotes whole the line of a reply whose delivery failed or wasn't
  confirmed, and hides nothing.

---

## A resident's memory: sizing, folding and repair

A new resident runs on the host's defaults, and the section "The recipe" of [AGENT-ONBOARDING.md](./AGENT-ONBOARDING.md) leaves them alone. This section is for three tasks: tuning a long-lived resident, moving one onto another solver, and repairing a store. `AutobiographicalConfig`, in context-manager's `src/types/strategy.ts`, describes every option of the autobiographical strategy, and context-manager's package carries that file.

### The context budget and the model's window

The autobiographical strategy fills the context up to `contextBudgetTokens` less `maxTokens`, which it keeps for the reply. The system prompt and the tools' definitions come on top. If that prompt is over the model's context window, every reply fails ("prompt is too long") once the conversation fills the budget. Compression calls, whose contexts are small, still succeed. So the resident seems to think but not speak.
- **The hard limit:** `(contextBudgetTokens − maxTokens) × (1 + overBudgetGraceRatio) + system prompt + tools < model window`. A compile aims at `contextBudgetTokens − maxTokens`, but it refuses only past a grace, `overBudgetGraceRatio` (0.02 unless set). So any layout can come out up to that much over.
- **The working rule** leaves room for the reply too: `contextBudgetTokens + system prompt + tools ≤ model window`. A long turn's tool results add to the prompt between compiles. So a budget over the working rule leaves a turn less room before the API refuses its prompt. `maxStreamTokens` counts uncached input only, so with prompt caching on, it doesn't bound a turn.
- **What the host checks:** on Anthropic's API, the host knows the window of some models. For such a model, a recipe that sets no budget gets the smaller of two values: 300k, or the window less the system prompt and 32k for the tools. Loading refuses three things, naming the numbers: a budget whose prompt, without the tools, would pass the window; a budget that leaves too little room for the head and the verbatim tail once `maxTokens` is kept for the reply; and a `maxTokens` over the model's maximum output. On any other provider, or for a model whose window the host doesn't know, the host says once at start that it didn't check the fit (a line that starts `[fit] Not checked`). The rules are then yours to keep.
- **The defaults,** for what a recipe leaves out: `maxTokens` is 16,384. The budget is as above, else 300k. `headWindowTokens` is 4,000. `recentWindowTokens` is 40% of the budget. Where the head and 40% of the budget wouldn't fit beside `maxTokens` within the grace, it is 40% of the budget less `maxTokens`. `maxStreamTokens` is the budget plus 20k when the budget is left out too, else 150k. The host works that tail out once, from the recipe's budget. So if you lower the budget at runtime on a recipe without a tail of its own, lower `tailTokens` with it. Otherwise compiles fail once the history fills the tail.
- **Watching it:** `/debug/context/makeup` ([debug-context-api.md](./debug-context-api.md)) counts the next request as its preview builds it, without what modules add at each turn. That total with `maxTokens` must stay under the window, with room for what modules add. The view gives no total when it can't get the count ("Compression and token counts", below). Trim the budget or `recentWindowTokens` before the total gets there.

### The folding solver

At each compile, the solver decides which summaries to present and which messages to keep raw, so that the context fits the budget.
- **`kv-unified`** is the host's default for an autobiographical or frontdesk recipe that names no solver and leaves adaptive resolution on. Adaptive resolution is on unless the recipe sets `adaptiveResolution: false`. kv-unified scores candidate layouts on budget fit, cache cost, continuity and fidelity, and it picks the cheapest acceptable one. Cache cost is what a change of layout costs in cache writes against reads, at the model's prices. context-manager has no defaults for kv-unified, so the host passes a complete block. A recipe without a `kvUnified` block gets the host's standard one, `standardKvUnifiedConfig` in `src/framework-strategy.ts`. Its `cacheReadPrice` and `cacheWritePrice` are ratios to the model's uncached input price. They come from the host's pricing table (`src/call-pricing.ts`), for the model, its provider and the recipe's `cacheTtl`. On the `anthropic`, `bedrock`, `openai-responses` and `openai-codex` providers, they match what the provider bills, except where an entry in the table says otherwise. Sonnet 5.5's reads are such an exception: 0.1 where the pricing page gives 0.05. An `openrouter` or `openai-compatible` recipe gets Anthropic's ratios, whatever its endpoint bills. For its reads, the host takes an `anthropic/` or `anthropic.` prefix off the model id. It then takes the ratio of the table's first entry whose id the model id starts with. So a dotted id such as `anthropic/claude-opus-5.5` takes Opus 5's 0.1, not Opus 5.5's 0.05. An id that starts with no entry's id takes 0.1. On any provider, two kinds of recipe get 1 for both ratios, since none of their input is cached: a recipe with `agent.promptCaching: false`, and one for a Bedrock model without prompt caching that doesn't set `agent.promptCaching`. Write the block yourself only to change the policy, and then set the prices to match. That function shows what the host picks.
- **`kv-stable`** keeps the presented layout as stable as it can between compiles, so that the cached prefix survives. It folds deeper only when it must. Residents built before kv-unified still run it, and such a resident pins `"foldingStrategy": "kv-stable"`. A recipe that names no solver gets the host's default, above, on its next start under this host.
- **The block's checks:** at load, the host refuses a `kvUnified` block whose `treeifyNonContiguousSummaries` or `preserveGapBearingSummaries` isn't an explicit boolean, or that sets both to `true`. It checks the optional keys when they are set: `hysteresisCertificate` is a boolean (on unless `false`); `policy.ageBandSteps` is an integer from 0 to 64 (4 unless set); `latentDemandMode` is `"individual"` or `"joint"` (`"joint"` unless set); and `engine` is `"auto"`, `"subtree"` or `"dag"`. The host passes the block on whole. A block that the recipe gives replaces the standard one whole, so write every field that it has. A startup warning names each key under `kvUnified` or its `policy` that the host doesn't read, with the key that it was probably meant to be, where one is close.

**Before moving a resident onto kv-unified:**
- A move of an established resident's solver changes its layout, so expect a full write of its prompt cache.
- kv-unified's solve assumes that each summary covers a contiguous run of messages. A store whose summaries cross doesn't open under the default topology policy, whatever the solver. Audit and repair it first ("Crossed summaries: auditing and repairing a store", below). If you set `preserveGapBearingSummaries` or `treeifyNonContiguousSummaries`, such a store opens and reports instead, with `compressionDebt` critical. But the solver then works around holes, where its search can pass `labelCeiling`. That solve takes the cut with the fewest tokens instead, and the host warns once: `[kv-unified] labelCeiling <N> exceeded at <M> labels`. The warning says that a high enough `labelCeiling` lets the search fit. `treeifyNonContiguousSummaries` solves fast, but it drops the deepest summaries, and the floor can land above the budget.
- Rehearse with the cache live, not only cold. The host supplies a `kvUnifiedImmutablePrefixHash` at each compile. A dry compile of a copy from a script of your own passes none, so it never takes the solver's cache-live path. Rehearse on a copy with the hash that the live host would pass.

### Compression and token counts

**The compression model** writes the summaries. By default it is the agent's own model (`agent.strategy.compressionModel` unset), and it writes in the agent's voice (`summaryParticipant`, the agent's name unless set). Context-manager's default label introduces each summary, unless the recipe sets its own (`summaryContextLabel`). If that model is flaky or being retired, folding stalls, summaries pile up, and the context can't be folded under the budget. A stable model can compress for an agent that speaks on a more fragile one, since the two are separate settings, and the summaries stay in the agent's name. A move of compression off the agent's own model touches the agent's identity a little, so tell the resident's person.

**Exact counts** in the makeup view come from Anthropic's `count_tokens`, at `ANTHROPIC_BASE_URL` when that is set. The view asks for the agent's own model, with a provider prefix taken off (`anthropic/claude-opus-4` counts as `claude-opus-4`). `COUNT_TOKENS_MODEL` names a model to count with in place of the agent's. Set it in `.env`, or in the earlier source that sets it (the section "Secrets" of [AGENT-ONBOARDING.md](./AGENT-ONBOARDING.md)), to a current Claude model. You need it in two cases. One is when the endpoint can't count the agent's model and answers with an error status, as Anthropic's does for a retired model, and as a gateway's may for a model that only it serves. The other is when the model's name, without its prefix, isn't a Claude model's: then the view doesn't ask at all. In both cases the makeup view shows no exact total (`countSource` is `count_tokens_failed_<status>` or `count_tokens_unsupported_model`). With no Anthropic credential (no subscription login, `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`), the view still asks, since a gateway at `ANTHROPIC_BASE_URL` may add its own credential. A 401 to that ask is `count_tokens_failed_401`.

### When a compile can't fit

With either solver, a compile can reach a floor above the budget. context-manager then refuses the compile with `OverBudgetError`, and kv-unified reports `budgetMet: false` with the floor that it reached. What helps depends on the cause:
- **Summary production lags behind the reading.** Let it catch up: the background drain goes on compressing while the resident runs. Lowering `recentWindowTokens` doesn't help here. Compression takes only messages older than the recent window. So a smaller window moves messages, still raw, to where compression has yet to reach them, and with a slow summarizer a smaller window can refuse sooner.
- **The conversation is very large, and its summaries have caught up.** Lowering `recentWindowTokens` lowers the floor, once compression has summarized the messages that it moves out of the window.
- **On kv-unified,** check that the summaries are contiguous ("Crossed summaries: auditing and repairing a store", below) before you touch `treeifyNonContiguousSummaries`.

### Crossed summaries: auditing and repairing a store

An audit refusal from an earlier release names this section as §11.8 of AGENT-ONBOARDING.md.

Since context-manager 0.12.0, every load audits the summaries for crossed ownership. A summary's ownership is crossed when its messages aren't one contiguous run in store order. Merges across eras, restores and branches that interleave, and hand surgery can leave such a summary. Under the default topology policy, `reject`, the open throws `StoreTopologyError`, and the resident doesn't start. The store keeps its history. Under `report`, the load logs the crossings and opens the store, and `/healthz` shows them as `compressionDebt.<agent>.topologyViolations`, with `state: critical`. A `kvUnified` block with `preserveGapBearingSummaries` or `treeifyNonContiguousSummaries` set to `true` defaults to `report`. This host doesn't pass a `strategy.topologyPolicy` key on, and doesn't warn about one. So a recipe can't follow the error's "set topologyPolicy: 'report'": repair a copy of the store instead, as below. Separately, a merge that would make a crossed summary is refused, into the merge quarantine (`compressionDebt.<agent>.topologyRefusals`).

**Before any update** that brings a context-manager of 0.12.0 or later, run the host's store audit after the copy, as "Updating an install" and "Updating checkouts" do. The audit opens each store as a start would, under each resident's own policy.

**Auditing one store.** context-manager's scripts are in its `dist/scripts/`, under the `node_modules` that the host runs from. Each script's own header describes it whole. Run them on a copy of the stopped store: a full or reflinked copy, never hard links, since opening a store writes to it.

```bash
node '<context-manager>/dist/scripts/audit-topology.js' '<store-copy>' --namespace 'agents/<agent>' --json > audit.json
```

The script exits 2 when it finds crossings, 1 when it couldn't open the store, and 0 when it found none. A warning that it saw nothing to audit means one of four things: a wrong `--namespace`, a copy without the strategy's state, a store with no summaries yet, or chunks that no summary owns. The script opens the store audit-only. That skips a step that a start takes before its check: chunking the messages not yet in a chunk. So the script can pass a store that a start refuses. The host's store audit is the one that opens a store as a start does. Neither audit covers agent-framework's own state in the store, which a start reads as well. The script lists the summaries that no merge can take. That listing reads the resident's merge settings, which the store doesn't hold. So give the script those settings as the resident has them (`--merge-threshold`, `--merge-max-span`, `--merge-hold`, `--no-speculative-production`). The same holds for the repair.

**Repairing.** Repair a fresh copy of the stopped store, made the same way, never the store itself.

```bash
node '<context-manager>/dist/scripts/repair-topology.js' '<store-copy>' --namespace 'agents/<agent>'
```

- The repair is a dry run, which prints its plan, unless you add `--apply`. After `--apply`, it reopens the copy under `reject` to check it. It exits 0 when nothing crossed is left, or when the dry run's plan leaves nothing crossed. It exits 2 when the plan is incomplete or the check failed, and 1 on a usage or open error.
- The default mode, `lossless`, only detaches. So no summary claims what it didn't see, but the pyramid unravels around each fragment. Add `--mode compact` to keep depth, at the price of gaps in the summaries' prose. Add `--mode rebuild` to dissolve each summary whose span touches a crossed region, with its ancestors, back to level-1 summaries. The merge ladder then folds them again with real summarizer calls. With `rebuild`, add `--rebuild-since '<messageId|ISO date>'` to rebuild only the crossings from that message on, and to compact older ones.
- After a `rebuild`, fold the same copy again with the offline drain. The drain writes summaries with real model calls. It takes `ANTHROPIC_AUTH_TOKEN` from its environment, or `ANTHROPIC_API_KEY` where no token is set, and `ANTHROPIC_BASE_URL` where that is set. The repair prints the drain's command:

```bash
node '<context-manager>/dist/scripts/drain-autobiographical.js' '<store-copy>' 'agents/<agent>' --apply --model='<model>' --participant='<agent>' --recipe='<recipe.json>' --tools-log='<llm-calls.jsonl>'
```

- The drain takes the resident's tool definitions from `--tools-log`: from the last streamed call there whose kept raw request holds tool definitions. So that call has to be the resident's own, not a subagent's, though the same log holds both. The log has to come from a host on the `anthropic` provider. Such a host keeps an ordinary call's raw request only when it was started with `LLM_CALLS_FULL_PAYLOADS=1`. So, if the resident still runs on a release that opens its store, restart it with that variable set, and stop it just after one of its turns, before you copy the store. The turn is a real one, and the store keeps it. A call whose log record would pass 16 MiB is kept without its raw request (`MAX_RECORD_BYTES` in `src/logging-record.ts`). So a turn whose calls' records are that large gives the drain no definitions. Pass the log that the restart began: each start of the host begins a new `llm-calls.<iso>.jsonl` in the data directory. Without the definitions, the drain can't compress a chunk with tool calls. When the model is a Fable or Mythos model, it can't compress any chunk. Choose `lossless` or `compact` then, which need no drain. A drain that stops short exits 1 and says why (`not drained (max-steps)`, at `--max-steps`, 200 unless given). When you run it again with the same flags on the same copy, leaving out any `--clear-merge-quarantine`, it goes on from where it stopped. A drain that finishes with quarantines left also exits 1, and says how many. A merge's quarantine clears with `--clear-merge-quarantine=<key>` on the next run. `audit-topology` names the key of a merge quarantine that stands beside a stranded summary. A compression quarantine has no command in this host, as `audit-topology` says, so a drain that ends with one can't exit 0. Run the drain until it exits 0.
- Then audit the copy again, with the same `--namespace`. The copy takes the store's place only when three runs each exited 0: the repair with `--apply`, the drain's last run after a `rebuild`, and the audit. Read the repair's output and the drain's. Put the copy in the store's place, and keep the original beside it untouched. Then run the host's store audit before you start the resident, since the scripts open the copy audit-only. Run that audit as "Updating an install" says under "Then run the new version's store audit". That section covers two kinds of fleet child. The recipe's run audits a child that the recipe names. A run on its own directory audits a child that `fleet--launch` started. Start the resident only when the host's audit exits 0. If it doesn't, put the original back. If the repair or the audit doesn't exit 0, or a drain can't be brought to exit 0 that way, discard the copy: the store is as it was when you copied it.

Two traps. First, any open of a store with a normal strategy configuration chunks its newest messages under that configuration. So check a store only on a copy, with the host's audit or the audit-only scripts. Never open a live store from a script of your own. Second, a copy of a running store reads whatever state was last written to disk, so copy a stopped store.

### Refusals and signed thinking

**Refusals.** Anthropic's safety classifier can end a request with `stop_reason: refusal` and the category `reasoning_extraction`. It halts two kinds of resident more than others: residents built from dense reasoning transcripts, and residents that keep diaries in long tool arguments. The recipe-level mitigations are three. `agent.refusalHandling.retries` is one; agent-framework's `AgentConfig.refusalHandling` documents it, in the framework's types (`dist/src/types/agent.d.ts`). `agent.strategy.compressionToolProseFallback` into a `journal` tool is another, for long `think` or `skip_reply` arguments. The third is `agent.strategy.carrierPolicy: "live-strip"`, when the live window refuses but compression doesn't. The section "5. If you hit `reasoning_extraction` refusals" of [claude-code-ingest.md](./claude-code-ingest.md) has the symptoms, a triage table and how to find the trigger. It applies to any resident. Never quote a suspected trigger into a channel that the resident reads.

**Signed thinking is bound to its model.** A transcript's signed thinking blocks replay only on the model that made them, and any other model refuses the request. The API also refuses a request that changes the shape of a turn around a thinking block that it keeps, such as by splitting the turn, reordering it or inserting something before the block: "thinking blocks cannot be modified".

**On Fable 5.1 and 5.2, Opus 5.5, Sonnet 5.5 and Haiku 5.5, and, by the host's table, the Mythos models, a block is bound to its request too:** to the conversation and the head (system text, tools, model) that it was minted under. Once those differ, as after a fold, an account that enforces the binding refuses a request that carries the block. context-manager leaves out the thinking that a fold invalidates (anima-research/context-manager#155). Through the Anthropic API, the host also sends the first five models the drop control on agent turns, so that the provider drops such a block rather than refusing the request. It also passes each model's window. With both, agent-framework doesn't break a turn's stream at `maxStreamTokens` (or the `/budget` command's value). The stream breaks mid-turn for its size only where its next request would pass the window, and a fresh compile carries the turn on.

Not every account binds: some still show the model such a block. So at start, the host checks each such model that the recipe uses (the agent's model, and its subagents' default). It mints one block and replays it under a changed system text, in a few small requests that `[thinking-binding]` lines in its log report on. It skips the check when the recipe's `agent.formatter` is `anthropic-xml`, when the provider is the mock, and when `THINKING_BINDING_PROBE` is `off`, `0`, `false` or `no`. Where the account showed the block, the agent and its subagents send their thinking as stored. They send it without the drop control, since the control would have the block dropped. That holds only on the Anthropic route, for a model that takes the control. If a gateway later moves the agent to an account that refuses such a block, the first refusal turns the control on for the rest of the run, and the host sends the request again. Where the account refused or dropped the block, the agent and its subagents leave such thinking out, as above. A start at which the check can't tell uses what the check last found on the same route (`$DATA_DIR/thinking-binding.json`), or else leaves such thinking out. `THINKING_BINDING_PROBE=off` skips the check.

### Health

`/healthz` holds these, for each agent:
- `compressionQuarantine`;
- `compressionDebt`, with `topologyViolations` and `topologyRefusals` among it;
- `contextComposition`: the head, raw middle, summaries and tail, as the last live compile rendered them. It has no entry for an agent that has had no live compile since its context was loaded, or whose strategy keeps none (`contextCompositionNotKept` names those agents);
- `runtimeSettings`;
- `loadRepair`: the newest load repair that the agent's strategy made, absent while it has made none;
- `readFailures`: present only when one of those reads threw, with what it said.

---

## Updating checkouts

A box that runs the stack from checkouts of `main` (the
[DEV-ENVIRONMENT](./DEV-ENVIRONMENT.md) layout) takes each change as it
pulls, with no release in between. Some of the stack's repositories stop
their releases while an issue labelled `release-hold` is open in them.
Such an issue says that `main` as it stands would harm someone running
it, and what has to happen first. A pull doesn't stop for it. So:

- **Before pulling,** look for open holds. The layout's repositories
  belong to anima-research and antra-tess, and one search covers both. It
  needs no login:
  ```
  https://github.com/search?q=label%3Arelease-hold+is%3Aissue+is%3Aopen+org%3Aanima-research+user%3Aantra-tess&type=issues
  ```
  With `gh` logged in, this shows the same:
  ```bash
  gh search issues --owner anima-research --owner antra-tess --label release-hold --state open
  ```
  While a hold applies to your box, keep every
  checkout on the commit it has, since the host and its libraries move
  together. If you can't read the list, treat a hold as open until you
  can. Then read what each checkout would take. Where the repository keeps
  a changelog, this shows its released sections and pending fragments:
  ```bash
  git fetch && git diff HEAD origin/main -- CHANGELOG.md changelog.d
  ```
  Where a repository keeps none, read its commits with
  `git log --oneline HEAD..origin/main` after the fetch.
- **If a hold names a commit you already run,** go back, below, to
  commits from before it. In a checkout that contains the commit,
  `git merge-base --is-ancestor <commit> HEAD` exits 0. The commits you
  noted may already contain it; `git reflog` shows earlier ones. Going back
  past your last update, the copy holds what the agents had just before
  that update, which code newer than the commits you go back to may have
  written. Before you restore it, read the hold's issue, which says what
  has to happen first.
- **To update,** note the commit each checkout is on with
  `git rev-parse HEAD`, and first stop every agent that runs from these
  checkouts, with the shell daemon if its checkout will move, and any MCPL
  server an agent reaches by `url` whose state the copy takes, wherever
  it's defined, the agent's own deploys (`mcpl-servers.agent.json`)
  included: such a server runs apart from the host, so stopping the agent
  leaves it running. Stopping an agent stops the fleet children it
  launched. For one
  left running, after a TUI quit that detached it or a parent that was
  killed outright, `kill` the PID in `headless.pid` in its data directory,
  which shuts it down as a stop does, and wait until it has exited
  (`kill -0 <pid>` then fails). bun runs the host's `src/` directly and
  imports some modules only when they're first needed, so files that
  change under a running agent can mix new code into it. The daemon serves
  every agent on the box, so stopping it ends their shell sessions too.
  Then copy
  what each agent keeps while it's stopped: its data directory
  (`DATA_DIR`, or `./data` in its working directory), its fleet children's
  data directories (`data/<child>` under its working directory, unless the
  recipe's entry for the child or a launch named another), which hold each
  child's own `mcpl-servers.agent.child.json`, with any tokens its deploys
  carry, the MCPL
  server settings it saves in its working directory (`mcpl-servers.json`
  and `mcpl-servers.agent.json`, or in that file's place the agent overlay
  the agent's `MCPL_AGENT_OVERLAY_FILE` names, where it names one), and
  the files its MCPL servers keep
  their state in, such as heartbeat-mcpl's `HEARTBEAT_CONFIG_FILE` (or,
  with `modules.heartbeat` on, the heartbeat's `heartbeat.json`, in the
  data directory unless `statePath` names another) and
  those discord-mcpl's README lists under
  [Stored state](https://github.com/anima-research/discord-mcpl#stored-state).
  Make full or reflinked copies, never hardlinks, which share files the
  agents write, and keep the copy as it was for as long as you might go
  back. Copy at every update, and once an update's copy is complete, let
  it replace the last: newer code can write a store, or the host's or a
  library's other files, in a form older code can't read, as chronicle
  0.3.0's notes say of its own, and the entries can miss saying so.
  Then update
  the host and the libraries it loads together (`git switch main` first
  in a checkout left detached), since the host's code expects the library
  versions beside it. Install and build them bottom-up as
  [DEV-ENVIRONMENT §2](./DEV-ENVIRONMENT.md#2-install--build-bottom-up)
  does: each `dist/`, chronicle's native build when chronicle changed, and
  the host's Web UI. An `npm install` in agent-framework or context-manager
  brings back their own `@animalabs/*` copies, so relink them as
  [§3](./DEV-ENVIRONMENT.md#3-wire-single-instance-symlinks-the-crucial-part)
  says. Then, before starting any agent, run the host's store audit once
  for each agent you start, in the directory it starts in, where Bun loads
  its `.env`, with any variable its service sets for it exported: `bun
  <host checkout>/src/index.ts --audit-stores --recipe <recipe> <data
  directory>`, with the recipe its start names and its `DATA_DIR` as its
  `.env` or service sets it, or `./data` there when neither does; your
  shell has neither unless you set them. For a start that names no
  recipe, leave `--recipe` out, and the audit reads the one its last start
  saved, or the default one, as that start would. The audit opens each
  store in place, as a start of the new code would, so the copy is what
  puts them back. A fleet child a launch started, which isn't in the
  recipe, needs a run of its own on its data directory, without
  `--recipe`, which reads the recipe its last start saved: `bun <host
  checkout>/src/index.ts --audit-stores <its data directory>`. "Updating
  an install" says
  what else the audit covers and what each line it prints asks of you; for
  a store it refused or couldn't audit, that's going back, below, or a
  repair or correction and the audit again. Then start the servers you
  stopped, and the agents.
- **To go back,** stop the agents again, with any fleet children still
  running, the daemon if its checkout moved, and the MCPL servers reached
  by `url` that you stopped before the copy. Check the noted commits out
  again (which leaves each checkout detached), rebuild the same way, and
  put back any recipe or `.env` change you made for the newer code. Then
  restore the copy of what each agent keeps in place of what's there now,
  not over it, so files the newer code added go too. That discards
  everything the agents recorded since the copy was made, and only that.
  For the commits you go back past that the box ran before the copy, as
  when going back past your last update, or for all of them where no copy
  was taken, read their entries for what going back does with what they
  stored, as agent-framework 0.22.1's notes say for going back to 0.22.0.
  Then start the servers you stopped, and the agents.

## Updating an install

An install of the published package can update itself once it's set up: the
host says when a newer release is out and what it costs, installs it beside
the release it runs, and switches when you restart it, going back by itself
if the new release fails before it starts its agents. Setting it up is one
step by hand, after taking the release that brings it by hand as "By hand"
below says. A clone updates by hand, or moves to an install, as "Moving from a
clone to an install", below, says.

**Setting it up, once.** In the directory the service runs the host in, with
`DATA_DIR` as the service gives the host:

```bash
DATA_DIR=... bun node_modules/@animalabs/connectome-host/src/update/setup.ts [--root DIR] [--extra-state PATH]...
```

The script copies the install as the first release of an install root,
`./connectome-host` unless `--root` names another. It writes the entry point
`start.js` there, with the install's own command, `connectome`, beside it. That
command's `connectome setup` works in the directory that holds the install root,
and reads and writes its `.env`, `.setup`, `package.json` and `node_modules`
there. It knows an install there only by a root named `connectome-host`. So to
use it, keep the default root, `./connectome-host`. For a root of that name
elsewhere, it sets up the root's parent instead. For a root with another name,
it refuses where it hasn't run before. Give `--extra-state` for each place where
an MCPL server keeps its state outside the data directory, so that each update
copies that state with the data. Then have the service start the host with
`bun '<root>/start.js'`, followed by the arguments that the service gives the
host now, and restart the service. In a systemd unit, write each `%` in a path
as `%%` and each `$` as `$$`: systemd reads `%` as a specifier, and `${...}` as
a variable, even between quotes. In the unit, as in a shell, write each `'` in
the path as `'\''`. In the unit alone, write each `\` as `\\` too, since systemd
reads a backslash as an escape even between single quotes. A switch and its
fallback need the service to restart the host when the host exits with 75 and
with 1. Setup says whether the service does. systemd's `Restart=on-failure`
does.

**A resident's own update.** An agent with `lifecycle--update` arms a restart
only on a headless host whose environment at its start holds
`CONNECTOME_SUPERVISED=1`. Whoever writes the host's service sets that line. By
setting it, they say that the service starts the host again in two cases. One is
when the host exits with 75, as a switch's restart does. The other is when it
exits with 1, as a trial that ends before its commit does, so that its fallback
runs. Under systemd, `Restart=on-failure` does both, unless `SuccessExitStatus=`
or `RestartPreventExitStatus=` names 75 or 1. Under launchd, `KeepAlive` with
`SuccessfulExit` false does both. `connectome service install` writes such a
service, and sets the line only for a service that restarts the host in both
cases. A service written by hand needs the line and both restarts. A host
without the line, or one run in a terminal, refuses the agent's restart and says
why. The person's own `/update` and buttons don't need the line. While the
agent's restart stays armed, it tries about once a minute. Each try connects
again to a fleet child whose socket another client took, and a child's socket
keeps one client. So a person connected to a fleet child's socket loses that
connection at each try. That goes on until the restart goes ahead, or until the
agent's `lifecycle--update cancel` or the person's own Restart ends the wait.

**Updating.** Update, Restart (with its three ways on when turns don't end) and
Go back are each an `/update` command, and in the Web UI a button. Restart's and
Go back's buttons send the release that their dialog showed
(`/update restart 0.14.0`, `/update back keep 0.13.1`). The release that the
host would act on may have changed since. Then the host refuses, with nothing
quiesced. Read what the dialog shows for the release, then ask again. Typed
without a release, each command acts on the release that the host holds. A
banner under the header shows the update's most pressing state, such as a
restart waiting on turns, a release installed, or one that's out, with its
buttons. Health's update block shows what `/update` shows, with a button for
each way open now, Go back's included. Restart and Go back say what they'll do
before you confirm them. An observer whose grant holds `health` sees the words
without the buttons. Unless the grant holds `ops` too, the observer sees no
errors or reasons either.
- **The notice:** the host reads npm's registry, or the registry that
  `npm_config_registry` names in its environment, at start and once a day. It
  doesn't read a registry set only in an `.npmrc`, and it sends no token. So for
  a mirror, set `npm_config_registry` in the service's environment. A registry
  that needs a token answers the read with its error, which `/update` shows.
  When a newer release is out, the host's log, `/update`, the Web UI's banner
  and the `update` section of `/healthz` say so. They say what the releases
  since then cost: which are breaking, which write each resident's prompt cache
  in full once, and which say nothing of their cost. The log's line that says
  how to take the release names a command. Someone reads a headless host's log
  in a shell, so for such a host the line names the install's own command by its
  full path (`<install>/connectome update install`). For a host in a terminal,
  which takes `/update` commands, it is `/update …`. With
  `CONNECTOME_UPDATE_CHECK=0` or `NO_UPDATE_NOTIFIER` set, the host doesn't read
  the registry on its own, but `/update` still reads it. A fleet child never
  reads it.
- **Update,** `/update install`, installs the newest release that isn't
  deprecated beside the running one, with nothing stopped. It does so once the
  Bun that the host runs on meets that release's floor. The running release runs
  on. Once the install has switched release at least once, Update first removes
  each release that nothing needs any more, including one installed earlier that
  the host hasn't yet restarted onto. If the new install then fails, Update
  doesn't put back what it removed, and the next Update installs the newest
  release again. When the floor is above the host's Bun, upgrade Bun and start
  the host again first.
- **Restart,** `/update restart`, quiesces the host and its fleet children, each
  as the Web UI's Quiesce quiesces one host. It gives turns in progress two
  minutes to end. If some don't end, it says who is still mid-turn, and you
  choose one of three ways. Wait up to ten minutes more
  (`/update restart wait`). Stop now and cut those turns off
  (`/update restart now`). Or call it off (`/update restart resume`), which also
  ends a switch's quiesce left on a host after an earlier try. Restart doesn't
  wait for scripts that a turn left running in the background, and the stop ends
  them. Just before the stop, the switch asks its fleet children once more. It
  doesn't wait for a turn that a child begins after that look asked the
  children, or for a turn on a child that a resume reached after that look. That resume can be the child's
  person's, or one that this host sent earlier, such as at its start. An MCPL
  server can ask for a quiesce with `host/command` while the switch's quiesce
  holds a host. That quiesce is taken into the switch's, since agent-framework
  keeps the reason that a quiesced host already has. So ending the switch's
  quiesce ends it too. Then the host stops. Its next start, which the service
  makes, copies the data and starts the new release on trial. The release
  commits once it has opened its stores and connected its MCPL servers. The
  servers that it must connect are the configured ones that the release before
  it had connected when it stopped for the switch, closed tabs aside. A server
  that was already down then doesn't hold the commit. If the server is still
  down, the new release's log names it. These cases wait for every configured
  server instead, as before: a request asked by a release that doesn't record
  its servers, as releases before this rule don't; a request to such a release,
  whose own check ignores the record; a Go back asked from a shell, which has no
  running host to ask; and a request whose record can't be read. The host comes
  back quiesced, and resumes once its agents have started. A host that you had
  quiesced yourself stays quiesced. A host run in a terminal stops as `/quit`
  does: once it has stopped, start it again.
- **A release that ends before its commit** is undone at the next start. The
  copy is restored, what the new release changed is kept aside, and the release
  before it starts. `/update` then says why. It shows the last 40 lines that the
  new release wrote through console's `log`, `info`, `warn`, `error` and
  `debug`, and to its stdout and stderr. The release kept those lines itself, in
  `trial-log.json` in the install root. What those lines leave out is in the
  service's log, or in the terminal of a host started by hand: console's other
  methods, an error that Bun reported itself, and what the release's servers'
  processes wrote. So is everything from a release that a signal ended (a stop,
  or the OOM killer), or whose code didn't load.
- **What each update copies:** the data directory, each fleet child's data
  directory, the MCPL settings file in the working directory, the agent overlay
  that the host reads (in the working directory, unless
  `MCPL_AGENT_OVERLAY_FILE` names another), and the state that setup recorded. A
  fleet child given `.` as its data directory makes the whole working directory
  part of the copy, so keep the install root outside it. The copy stays until
  the next switch replaces it.
- **A request refused before anything changed** is dropped, such as one that
  finds a fleet child still running, or too little room for the copy. The log
  and `/update` say why. Ask again once the cause has cleared.
- **Going back** after a commit: `/update back` says how old the copy is, and
  offers two ways. Keeping the newer data (`/update back keep`) loses residents
  nothing. It brings the host back as it is now: answering new turns, or holding
  them if its operator quiesced it. A switch's quiesce left behind ends at that
  start. Restoring the copy (`/update back restore`) sets everything since the
  copy aside, without deleting it. It brings the host back answering new turns.
  The exception is a host whose operator had quiesced it, from the Web UI or
  through an MCPL server, before the Restart that took the copy. Such a host
  comes back holding new turns, and clicking "⏸ quiesced" in the Web UI's top
  bar lets them through. Whether the host is quiesced now makes no difference.
  Either way, the host first holds new turns and gives turns in progress up to 2
  min to end, as Restart does. Where the older release reads the record, the
  host also records its connected servers for that release's commit, as Restart
  does. The older release can end before its commit on the newer data, as when
  its store audit refuses a store. Then the next start puts the newer release
  and its data back by itself. Restoring the copy is the way on from there.
- **When the new release keeps exiting after its commit,** it is never up long
  enough to ask. Each start's log names the command instead:
  `bun <root>/start.js --go-back`, with `--keep-data` to keep the newer data. A
  host that keeps exiting gives up the install's lock between its starts, and
  the command waits up to a minute for that. Then it writes the request, and the
  service's next start goes back. If the service isn't running, start it. A
  release that stays up longer than a minute before each exit can hold the lock
  through the wait. Then stop the service, run the command, and start the
  service.

**By hand.** An install of the published package (`npm install
@animalabs/connectome-host`, or `bun add`) changes version only when npm or
bun is run to change it, `npm update` and `bun update` included, and a
clone of connectome-host when you check out another tag. An install
resolves the libraries' ranges as they stand that day, so it can run
library releases newer than the ones the release's own lockfile pins,
while a clone installs from its tag's `bun.lock`. So:

- **Before updating,** read the new version's `CHANGELOG.md`
  (`https://github.com/anima-research/connectome-host/blob/v<version>/CHANGELOG.md`)
  back to the version that you run. Read the Breaking entries first, and what
  the entries say about going back. Check `node --version` and `bun --version`
  against the new version's floors. A Breaking entry names a floor when it
  rises.
- **To update,** copy the install's `package.json` and its lockfile
  (`package-lock.json`, or `bun.lock` for an install made with bun). In a clone,
  note the tag that you're on (`git describe --tags`) instead. Note the versions
  that
  `npm ls @animalabs/agent-framework @animalabs/context-manager @animalabs/chronicle`
  names, and the version of each MCPL server that the notes say to update. Stop
  every agent that runs from the install, and its fleet children, as "Updating
  checkouts" says. Also stop each MCPL server that an agent reaches by `url` and
  whose state the copy takes, since such a server runs apart from the host. That
  holds wherever the server is defined, the agent's own deploys
  (`mcpl-servers.agent.json`) included. Then install the new version. Use
  `npm install @animalabs/connectome-host@<version>`, or
  `bun --no-env-file add @animalabs/connectome-host@<version>`. On Bun 1.4.4 and
  later, `--no-env-file` keeps the folder's `.env` from install scripts; on
  1.4.3 it doesn't. In a clone, run `git fetch --tags`,
  `git checkout v<version>`, `bun install` and `bun run build:web`. Until that
  build succeeds, the Web UI serves whatever `dist/web` holds, if anything, and
  that isn't this version's build. If the build fails, the host still runs
  without this version's Web UI, and going back, below, restores the Web UI that
  you had.
- **Before starting them,** run `npm ls` as before and compare. For each of the
  three libraries that moved, read its notes between the two versions
  (`https://github.com/anima-research/<library>/blob/main/CHANGELOG.md`) for
  what they say about going back. Do the same for each MCPL server that you'll
  update, between the version that you noted and the new one. Read its own
  changelog, or its commits if it keeps none. Then:
  - **Copy what each agent keeps,** at every update. "Updating checkouts" says
    what to copy, how, and why.
  - **Then run the new version's store audit,** after the copy and before you
    start any agent, with the agents and their fleet children still stopped. The
    audit opens each store in place, as the new version's start would. So it
    changes the stores as that start would, and the copy is what puts them back.
    Run it the way that you start the host: from the new version, in the
    directory and environment that the host starts in, since relative
    directories resolve from there. Give `--audit-stores` in place of the
    recipe's options:
    `bun node_modules/@animalabs/connectome-host/src/index.ts --audit-stores --recipe <recipe> <data directory>`,
    or `bun src/index.ts --audit-stores …` in a clone. Use the host's
    `DATA_DIR`, or `./data` in that directory when `DATA_DIR` isn't set. A
    `DATA_DIR` that the service or `.env` gives the host doesn't reach the shell
    that you type the command in. Nor does any other variable that the service
    sets, so export those. Give `--recipe` the recipe that your start command
    names, so that the audit opens the stores under the recipe that the start
    would load. Without `--recipe`, the audit reads the recipe that the host's
    last start saved, as a start given no recipe does. With no recipe saved, it
    reads the default recipe. Run the audit once for each agent that you start.
    It audits every session's store in the data directory. It also audits each
    fleet child that the recipe's `modules.fleet.children` names and whose data
    directory exists. It audits each such child in a process of its own, as the
    fleet launches it: under the recipe that the child's entry names, and in the
    environment that the fleet starts it with. The child's audit has 5 minutes
    to end, or the minutes that `CONNECTOME_FLEET_CHILD_AUDIT_MINUTES` gives in
    the audit's environment. A number above 0 gives that many minutes, and a
    number larger than a timer holds (about 35,791 minutes, Infinity included)
    gives the longest that a timer holds. A value of 0 or below, or one that
    isn't a number, gives 5. A child launched by `fleet--launch` isn't in the
    recipe. Run the audit on its directory too: the `dataDir` that its launch
    named, given as `--audit-stores <directory>`. That run reads the recipe that
    the child's last start saved, in the audit's environment. The audit can open
    a store under more than one agent name: the recipe's name or the default,
    and each session's own. On stderr, it prints a line for each store under
    each such name. It prints a line too for a store that it doesn't open. It
    exits 0 when no store was refused and every store there was audited. A
    session can name a store in its data directory that isn't there yet. Such a
    store gets a line and no failure, since a start makes an empty one.
    Otherwise, each line that says `refused`, or that starts `Couldn't audit`,
    names a store or a directory that the new version didn't open, and why. Then
    go back, below, which restores the copy. A store that lies outside its data
    directory, or that holds a link to something outside it, isn't opened, since
    the copy doesn't hold what it reaches. Its line says how to go on. Some
    lines say that a strategy called a model while opening a store. No audit can
    answer for such a store; only a start can. Whether to start on it is your
    call. A store can be refused for crossed summaries, and its line then says
    `store topology rejected`. Such a store can instead be repaired on a copy of
    the stopped store, as ["Crossed summaries: auditing and repairing a
    store"](#crossed-summaries-auditing-and-repairing-a-store), above, says.
    Then put the repaired copy in the store's place, keep the original, and run
    the audit again before you start. The repair's own check opens the copy
    `auditOnly`, which can pass a store that a start refuses. For anything else
    that a line names, correct it and run the audit again, or go back.
  - **Then** update each MCPL server that the notes name, the way that you
    installed it, and start the servers that you stopped.

  Then start the agents.
- **To go back,** stop the agents again, with any fleet children still
  running, and the MCPL servers reached by `url` that you stopped before
  the copy. Restore the copied `package.json` and lockfile together, then
  run `npm ci`, or `bun install --frozen-lockfile`. The install rewrote
  the version in `package.json`, so a lockfile restored alone is refused.
  In a clone,
  check out the tag you noted and run `bun install`, then `bun run
  build:web`. Put
  back the version of any MCPL server you updated, and any recipe or `.env`
  change you made for the newer version. Then restore the copy of what each
  agent keeps in place of what's there now, not over it, so files the newer
  version added go too. That discards what the agents recorded since the
  copy was made. Where no copy was taken, read the notes between the two
  versions for what going back does with what the newer one stored. Then
  start the servers you stopped, and the agents.

### Moving from a clone to an install

These steps move a host from a clone of connectome-host to an install from npm.
An install has its own `connectome` command, and it can update itself. After the
move, the host's code comes from the package, and its service comes from
`connectome service install`. The resident keeps its data, its recipe, `.env`
and its MCPL servers. The resident stops at step 5 and starts again at step 9. A
clone runs the library versions in its lockfile. An install runs the versions
that npm chooses, and these can be newer. So the move can update the libraries
too. This section gives steps for Linux with a systemd user unit. It doesn't
cover a Mac, an old service that is a system unit, a host with fleet children,
or an MCPL server that runs apart from the host.

Run each step as the user that runs the resident. From another account, use a
login shell of that user, such as `sudo -iu <user>`. `service install` needs
that user's own `USER` and `HOME`. Without `XDG_RUNTIME_DIR`, `systemctl
--user` can't find the user's systemd. If the shell doesn't set it, set it
first: `export XDG_RUNTIME_DIR=/run/user/$(id -u)`.

1. **Choose the version.** The move needs 0.26.0 or later, the first release
   with `service install` and `doctor`. In the clone, run `git describe --tags`.
   It prints a tag, such as `v0.27.1`, or a tag and how far the clone is past
   it, such as `v0.27.0-6-ga6047e20`. Run `git status --short` too. Each line of
   its output names a path that the clone changed, deleted or added. A change to
   the host's own code won't be in the install.
   - For a tag alone, install that version. The host then runs the same host
     code as now. Its libraries can be newer, and step 3 checks them.
   - For a clone past a tag, run `git fetch --tags`, then
     `git tag --contains HEAD --sort=v:refname`. It lists the tags that hold the
     clone's code, oldest first. `npm view @animalabs/connectome-host versions`
     lists the versions on npm. Of those tags, take the oldest one with a
     version on npm. Install that version. Then read the release notes from the
     clone's tag up to that version. See "By hand" for how to read them.
   - If npm has none of those versions, no release holds the clone's code yet.
     Keep the clone until a release holds that code. Don't move to an older
     release, since its older code would read data that newer code wrote.
   - For a version older than 0.26.0, install 0.26.0 or a later release
     instead. First read the release notes from the clone's version up to the
     one you install.
2. **Read the old service.** Run `systemctl --user cat <unit>` to see the unit's
   file and its drop-ins. Note the unit's `WorkingDirectory`, which is where the
   install goes. Note what the start command gives the host, too. Then run
   `systemctl --user is-enabled <unit>`, and note whether the unit is enabled,
   for step 12.
   - This section doesn't cover an old unit without a `WorkingDirectory`. It
     also doesn't cover a working directory with a `package.json` or
     `node_modules` for something else, such as an MCPL server.
   - `service install` needs linger, so that the user's units run without a
     login. Check that `/var/lib/systemd/linger/<user>` exists. If it doesn't,
     have root run `loginctl enable-linger <user>` before step 5.
   - Read the data directory from the running host. The host's `DATA_DIR` can
     come from the unit, from the unit's environment files or from a `.env`
     file. The host holds `headless.log` open in its data directory. This
     command prints the file's path, unless the file is a link:
     `ls -l /proc/$(systemctl --user show -p MainPID --value <unit>)/fd | grep headless.log`.
   - If the start command runs a script, `MainPID` can be the script's pid. Then
     `systemctl --user status <unit>` lists the unit's processes. Use the host's
     pid from that list in the `/proc` command.
   - The new units are `connectome-<name>.service` and
     `connectome-<name>.shell.service`, with `<name>` as step 8 says. Run
     `systemctl --user cat connectome-<name>.service connectome-<name>.shell.service`
     to check that both names are free. It prints `No files found for …` for
     each free name. If a unit already has either name, this section doesn't
     cover the move. The old unit counts too.
   - The new unit starts the host with the recipe and `--headless` alone. If
     the old start command gives the host other options, such as
     `--socket-path`, keep a service of your own instead: see
     "A service of your own", below.
   - If the start command gives no recipe, the host resumes its saved recipe.
     The host saved it at its last load, in `<data directory>/.recipe.json`. At
     each start with a recipe, the host writes that recipe to this file. So give
     the new service a copy. Copy the file into the working directory, such as
     to `<name>.json`, and take out its `"$unresolved": true` line. Use the copy
     as `<recipe>` in steps 6 and 9. A saved file without that line is an older
     one. It holds the values of the recipe's variables, secrets included. So
     make the copy readable only by its user, with `chmod 600`. In the saved
     file, the paths to extensions are full paths. If a path leads into the
     clone, copy that file into the working directory too. If it uses files
     beside it, copy those too. Then change the path in the copy to name the new
     file.
   - If the start command has `--no-recipe`, or no `.recipe.json` exists, the
     host runs its built-in default recipe. `service install` needs a recipe
     file. So first write one with the same contents as `DEFAULT_RECIPE` in
     `src/recipe.ts`. With that file, the host keeps its agent's name and its
     modules.
   - The recipe can lie in the clone, with the working directory elsewhere. In
     that case, the new service would still need the clone. So copy the recipe
     into the working directory, and use the copy as `<recipe>` in steps 6
     and 9. An extension's path is relative to the recipe's own file. So copy
     the extension's file into the working directory too, and change its path in
     the recipe's copy. If it uses files beside it, copy those too. The recipe's
     other relative paths start from the working directory already.
   - The working directory can be the clone itself, as after the README's quick
     start. The install can't go there, since the clone's `package.json` is the
     host's own. In that case, also follow "When the working directory is the
     clone", below.
3. **Install the package, with the host still running.** Run this command in the
   working directory:
   ```bash
   npm install --prefix "$PWD" @animalabs/connectome-host@<version>
   ```
   `--prefix` makes npm install here, not into a project in a directory above.
   Use npm for this install, not `bun add` or another tool. With Bun 1.4.3,
   `bun add` gives the folder's `.env` to install scripts, as "By hand" says.
   After the install, check that
   `node_modules/@animalabs/connectome-host/package.json` names the version.
   Then run
   `npm ls @animalabs/agent-framework @animalabs/context-manager @animalabs/chronicle`
   here and in the clone. For each library whose version moved, read its release
   notes, as "By hand" says.
4. **Make the install root, with the host still running.** Run the setup script
   that "Setting it up, once" shows. Give it the `DATA_DIR` from step 2. An MCPL
   server can keep its state outside the data directory. For each such place,
   give setup an `--extra-state`. Setup leaves a running host as it is. It
   prints
   `Set up <root> as the install of <version> that serves <data directory>.`
   - If setup prints `… as before.` instead, it found an install root in the
     working directory and kept that root's release. If an earlier try of this
     move made that root, remove `connectome-host`, and run setup again. This
     section doesn't cover a root from another install.
   - Setup and "Setting it up, once" also tell you to change the service's start
     command. Leave the old service as it is, since steps 7 to 9 replace it.
5. **Stop the host, and copy the resident's files.** Choose a moment when the
   resident is idle, since a stop cuts off a turn in progress. Stop the host
   with `systemctl --user stop <unit>`. Then copy the files that "Updating
   checkouts" lists. Copy `.env` too, since step 9 can add the shell daemon's
   port and token to it. Copy the old service's recipe file too, since step 11
   can edit it. Put the copy outside the working directory, such as in
   `~/pre-move-copy`. If the copy ends with an error, start the old service
   again with `systemctl --user start <unit>`, and stop the move there.
6. **Run the store audit from the install.** See "By hand" for the whole audit.
   First export each variable that the old service sets. Then run
   `bun node_modules/@animalabs/connectome-host/src/index.ts --audit-stores --recipe <recipe> <data directory>`.
   - If the command exits with a status other than 0, go back by step 12. Look
     for lines that say `refused` or start with `Couldn't audit`. Each such line
     names a cause.
   - If a line says `memory changed at load`, the store lost summaries. The
     installed version removed them when the audit opened the store. Its first
     start would remove them too. The line also gives words that you can say to
     the resident. To keep the memory as it was, go back by step 12.
7. **Take the old service away, and keep its file.** Run
   `systemctl --user disable --now <unit>`. Move its unit file into the copy. If
   it has a drop-in directory (`<unit>.d`), move that too. Then run
   `systemctl --user daemon-reload`. `service install` refuses while systemd has
   loaded another unit with the same `WorkingDirectory`, since both units would
   start the host at a boot.
8. **Carry over the old unit's own lines.** The new unit is
   `connectome-<name>.service`. For `<name>`, take the working directory's name
   in lower case. Keep each character from `a` to `z` and `0` to `9`. Each run
   of other characters becomes one `-`. Then drop a `-` at the start or the end.
   `service install` refuses a directory whose `<name>` comes out empty. The new
   unit sets the start command, `WorkingDirectory`, `PATH`, `DATA_DIR`,
   `CONNECTOME_SUPERVISED=1`, `Restart=on-failure` and `KillMode=mixed`. The old
   unit's file and drop-in files are now in the copy. Compare them with that
   list. Put each other line that the machine still needs into this drop-in:
   `~/.config/systemd/user/connectome-<name>.service.d/<file>.conf`. Put each
   line under its section header from the old unit, such as `[Unit]` or
   `[Service]`. systemd ignores a line with no header above it.
   - Look for what the host waits for (`Wants=`, `Requires=`, `After=`), a
     command before its start (`ExecStartPre=`), a restart delay
     (`RestartSec=`), and its environment (`Environment=`,
     `EnvironmentFile=`).
   - An environment file's `DATA_DIR` overrides the new unit's `DATA_DIR`. So
     this section covers such a file only if both name the same directory.
   - Keep a restart delay in the drop-in. Without one, systemd's defaults stop
     the restarts after a few failed starts in a row, such as at a boot before
     the network is up. The unit then stays failed, and the resident stays down.
   - Leave out the `ExecStart=` and `WorkingDirectory=` lines. In an
     `Environment=` line, leave out the `DATA_DIR` assignment. Keep the line's
     other assignments. Also leave out each line that stops a restart on exit 75
     or exit 1. Such lines include a `SuccessExitStatus=` or
     `RestartPreventExitStatus=` line that names 75 or 1. An update of the
     install needs systemd to restart the host after exit 75 and after exit 1.
     The part "A resident's own update" says why.
   - For example, one host needed a tunnel, a shell daemon and DNS at its start.
     Its drop-in got `Wants=` and `After=` lines for the tunnel's unit and the
     daemon's unit. It also got an `ExecStartPre=` that waits for DNS, and
     `RestartSec=10`.
9. **Install the new service.** Run
   `connectome-host/connectome service install <recipe>`. It writes the unit and
   reloads systemd, which reads the drop-in too. Then it starts the unit, and it
   waits for the host to answer. It prints `Its host answers: pid …, recipe …`.
   Then check that systemd uses the drop-in. `systemctl --user cat <new unit>`
   shows the drop-in's lines after the unit's own. systemd doesn't read a
   drop-in under a wrong name.
10. **Check the move.** Run `connectome-host/connectome doctor`, which says
    `Doctor found no problem.` Then `connectome-host/connectome send '<a line>'`
    prints the resident's reply. If the resident answers only in a channel or
    with a tool, `send` prints no reply. Instead, `send` says that the resident
    may have answered somewhere else.
11. **If you choose, let the resident update itself.** Set `"selfUpdate": true`
    in the recipe's `modules`. If the recipe's `agent.allowedTools` is a list,
    add `lifecycle--update` to it. Then run step 9's command again, which
    restarts the host. The resident can then update its own host with
    `lifecycle--update`. The new tool changes the resident's prompt. So with
    prompt caching on, the resident's next turn writes its whole prompt cache
    once.
12. **To go back:** the copy holds the resident's files as they were at step 5.
    From step 9 on, the resident records new things in its files. Going back
    discards them.
    - After step 5 and before step 7, restore the copy, as "By hand" says.
      Then start the old service again with `systemctl --user start <unit>`.
    - From step 7 on, take these steps in order. If step 9 ran, run
      `systemctl --user disable --now <new unit>`. It stops and disables the new
      unit. Do the same for `connectome-<name>.shell.service`, the shell
      daemon's unit, if step 9 wrote one. Remove the new units' files and the
      new drop-in directory. Then move the old unit's file and drop-in directory
      back from the copy. Run `systemctl --user daemon-reload`. Then restore the
      resident's files from the copy, as "By hand" says. If the copy holds no
      `.env`, remove the `.env` that step 9 made. Then start the old unit with
      `systemctl --user enable --now <unit>`, since step 7 disabled it. If
      step 2 found it disabled, use `systemctl --user start <unit>`.
    - Remove the install root that step 4 made. It is `connectome-host` in the
      directory where step 4 ran. Setup doesn't change the release of an install
      root that already exists. So a later move would start that release,
      whatever version npm installs. The install's other files can stay, since a
      host that starts from the clone doesn't use them.
    - Workspace directories in the working directory, such as `output`, aren't
      in the copy. So they keep the new host's writes.

**When the working directory is the clone.** This is the case after the README's
quick start. The resident then moves to a directory of its own. The steps change
in these ways:

- Choose the new directory, such as `~/resident`, and make it. The new
  directory's name gives `<name>` in steps 2 and 8. Then run step 3 in the new
  directory.
- Before step 5, list the relative paths in the recipe, in `.env`, in the old
  unit's environment, in `mcpl-servers.json` and in the agent overlay. After the
  move, a path relative to the working directory starts from the new directory.
  So the file or directory at such a path goes into the new directory too. The
  bullets below move or copy each one after step 5.
- An extension's path is relative to the recipe's own file instead. So when you
  copy the recipe after step 5, copy each extension's file with it. Keep the
  file at the same place relative to the recipe. Copy the files that it uses
  too.
- Some files are in the working directory without a path that names them. The
  workspace is on unless the recipe turns it off. When the recipe names no
  mounts, the workspace has two in the working directory: `input` and `output`.
  The `sleep` tool reads its privileged users from `sleep-privileged.json` in
  the working directory, unless `SLEEP_PRIVILEGED_FILE` names another file.
- Run step 4 after step 5. After the copy in step 5, move these from the
  clone into the new directory: the data directory, `mcpl-servers.json`,
  `mcpl-servers.agent.json` and the agent overlay. A data directory outside the
  clone stays where it is.
- Then copy these from the clone into the new directory. The clone keeps its
  own copies for step 12.
  - `.env`, the other `.env` files that Bun reads, such as `.env.local`, and
    `sleep-privileged.json`.
  - The recipe, with the files that it names.
  - What the other relative paths name, such as `input` and `output`.
- Then run step 4 in the new directory, with the data directory's new path as
  `DATA_DIR`. Steps 6 to 11 run there too.
- Step 12 puts each part of the copy back where it came from, such as into the
  clone or a data directory outside it. Then move the new directory aside, such
  as to `~/resident.moved`. A later move then starts in an empty directory.

**A service of your own.** This section covers the service that
`connectome service install` writes. If you use a service of your own, steps 1
to 6 give you the install. Then change your unit so that it starts the new host.
The steps for that are in "Setting it up, once", not here.

---

## Wake gating (loop fix)

Each recipe's `modules.wake` policies, in order (first-match-wins):
`heartbeat-wake → [discord-send-failed-skip] → discord-explicit-mention →
discord-bot-skip → discord-direct-address → discord-ambient → cli-input`.
Net effect: a bot wakes a peer bot **only by an explicit @mention** (not a
reply), which breaks auto-reply loops; humans still wake via mention/reply/DM;
ambient channel chatter enters context without waking.

---

## Current divergences / caveats

- **Dev boxes can drift ahead of prod.** A prod box may run some `@animalabs/*`
  as *installed* copies (or dist-patched in place) rather than checkouts; a
  dist patch reverts if the package is reinstalled — and current
  `membrane`/`context-manager`/`agent-framework` packages resolve to `src/`
  under bun (a `bun` export condition), so a `dist/`-only patch never reaches
  the host. The clean state is the symlinked-checkout layout (per
  DEV-ENVIRONMENT).
- **Backups** accumulate per install dir: `data.preremediation-*`,
  `data.bak-*`, per-session `*.bak-*`, and recipe `*.bak-*`. Safe to prune once a
  change is confirmed good.

## Known pending fixes (forward work)

1. **Image handling** — discord-mcpl base64-inlines attachments. What exists
   now: context-manager's compile can keep only so many live images
   (`maxLiveImages`), strip images deeper than a token depth
   (`imageStripDepthTokens`) and keep cumulative inline image base64 under a
   byte budget (`maxLiveImageBytes`), replacing the rest with placeholders;
   all three are off unless a recipe sets them (context-manager 0.25.2; they
   were 6 images, 30 000 tokens and 20 MiB), and its ceilings of 500 images
   and 24 MiB still apply; membrane
   degrades API-rejected media types (SVG, TIFF, …) to a visible placeholder
   and fails loudly, before the API call, when a request exceeds its byte cap
   (28 MB, `MEMBRANE_MAX_REQUEST_BYTES`); agent-framework's `read_image`
   rejects files over 5 MB. Still missing: nothing downsamples or
   size-checks an individual image on ingest (membrane's `images.autoResize` /
   `maxSizeBytes` config is declared but unused), so one image over the
   provider's per-image limit still 400s the request while it stays live —
   the poison-history breaker only sheds newest exchanges. Recipes can tune
   the three image keys under `agent.strategy` (autobiographical and
   frontdesk). A depth of zero turns depth stripping off; a count or byte
   limit of zero means up to context-manager's ceilings, 500 images and
   24 MiB, and a larger one is held to them. (Stopgap: a per-install
   `strip-oversized-images.mjs`, below.)

## Helper scripts (per install dir)

These live in an install dir's own `scripts/` and are **not shipped in this
repo**:

- `scripts/ingest-multiuser.mjs` turns a multi-user chat export into a
  chronicle, with participants attributed by roster. It has no shipped
  equivalent. The shipped importers cover claude.ai exports
  (`scripts/import-claudeai-export.ts`) and Codex rollouts
  (`scripts/import-codex-rollout.ts`).
- `scripts/compress-fresh.mjs` drains the compression queue offline before
  launch, with the recipe's `compressionModel`. Its shipped counterpart is
  `scripts/warmup-session.ts '<session>'` (in an install that setup made, under
  `<install>/current/node_modules/@animalabs/connectome-host/`). That script
  drives a session's autobiographical compression to convergence offline, with
  the model that `--model` gives, not the recipe's. It leaves the work that
  waits on tool definitions, and names it.
- `scripts/strip-oversized-images.mjs` removes image blocks over 5 MB from the
  chronicle. The agent must be stopped. It has no shipped equivalent.
