# Connectome Deployments — Operations

**Status:** Working notes. Generic operations patterns for running Connectome
agents. For setting up the *code stack* (repos/branches/symlinks), see
[`DEV-ENVIRONMENT.md`](./DEV-ENVIRONMENT.md); for standing up a new agent
end-to-end, see [`AGENT-ONBOARDING.md`](./AGENT-ONBOARDING.md).

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

Labels/units follow `cc.<agent>.agent` (launchd) / `<agent>-agent.service`
(systemd). (launchd: a plain `kill`/`stop` respawns via KeepAlive — use `bootout`
to stop, `kickstart -k` to restart.)

A restart can make auxiliary model calls before any user message: agent-framework
immediately drains restored Context Manager compression/merge debt. This happens only
when the store has pending maintenance, and it is visible in the new process's
`llm-calls.<iso>.jsonl`; it is not an agent wake or a user turn. To avoid it, stop the
resident first, then drain the debt offline with `bun scripts/warmup-session.ts
<session> --agent <recipe agent.name> --data-dir <DATA_DIR> --model <compressionModel>`.
Recipes that change `--l1-budget`, `--l2-budget`, `--l3-budget`, or
`--merge-threshold` must pass the same values to the warmup command.

**Logs / observability** (`data/` below is `DATA_DIR`, default `./data` under
the working directory):
- discord-mcpl debug log: `data/discord-mcpl-debug.log` (incoming, attachments,
  `handlePublish`, wake metadata).
- host stdout/stderr: wherever the plist/unit sends them — e.g. launchd
  `StandardOutPath`/`StandardErrorPath` (such as `data/launchd-stdout.log` /
  `launchd-stderr.log`), a unit's `StandardError=append:…/service-stderr.log`,
  or else `journalctl --user -u <unit>`. Those file names are plist/unit
  conventions; the host does not create them. `--headless` redirects
  `process.stdout.write` / `process.stderr.write` into `data/headless.log`
  (beside `headless.pid` and `ipc.sock`), but Bun's `console.*` bypasses those
  methods, so `console.error`/`console.log` lines — `[inference-failed]`,
  `[routeSpeech]`, `[webui] listening …` — still reach the supervisor's
  stdout/stderr. `headless.log` mostly holds the headless runtime's own lines.
- routing decisions on stderr: `[routeSpeech] …`, `[routing] …`.
- raw model calls: `data/llm-calls.<iso>.jsonl` — a new file per process start
  (forensic; large).
- `logs/failures.log` — JSONL failure/ops-alert records (below). Relative to
  the process **working directory**, not `DATA_DIR`.
- per session, `data/sessions/<id>/`: `operator-actions.jsonl` (who/why of
  operator mutations such as WebUI surgery — see
  [`webui-live-surgery.md`](./webui-live-surgery.md)) and
  `mcpl-stderr/<server>.log` (each MCPL server's stderr plus connect/close/error
  lines; rolls to `.1` at 10 MB).
- TUI mode: `data/tui-error.log`. Fleet children: `startup.log` in the
  child's data dir (default `./data/<child>/` under the parent's working
  directory) — the child's stdio, opened by the parent at spawn.
- **Inference failures** (agent-framework): when a turn's inference is
  exhausted after retries the framework prints
  `[inference-failed] agent=… consecutive=N: <reason>` to stderr, appends a
  JSONL record to `logs/failures.log`, and adds an `[inference-failed]` marker
  to the agent's chronicle so the agent learns why its turn produced nothing
  (`SUPPRESS_INFERENCE_FAILED_MARKER=1` disables the marker). At 3 consecutive
  failures it logs `[inference-hard-down]` and raises an ops alert: an
  `ops:alert` trace, plus a POST to `CONNECTOME_OPS_WEBHOOK` if set (throttled
  to one per agent and kind per 15 min). If those failures are
  `invalid_request` rejections of the history itself, a poison-history breaker
  sheds the newest complete exchange and retries, capped by
  `refusalHandling.maxRewinds` (default 3) per episode.
- **`scripts/connectome-doctor [INSTALL_DIR] [UNIT]`** — one-shot "why isn't
  the agent responding?" (python3; systemd-user boxes). Prints service state,
  disk, journal staleness (and where the unit really logs), a last-seen ladder
  per pipeline stage (discord event → chronicle ingest → `llm-calls` →
  delivery), recent failures from the unit's log file and
  `INSTALL_DIR/logs/failures.log`, and a live gate dump via `SIGUSR2`. It
  assumes `INSTALL_DIR/data` and `INSTALL_DIR/logs`, i.e. the unit runs with
  the install dir as its working directory.

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
  recipe's entry for the child or a launch named another), the MCPL
  server settings it saves in its working directory (`mcpl-servers.json`
  and `mcpl-servers.agent.json`), and the files its MCPL servers keep
  their state in, such as heartbeat-mcpl's `HEARTBEAT_CONFIG_FILE` and
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
below says. A clone updates by hand.

**Setting it up, once.** In the directory the service runs the host in, with
`DATA_DIR` as the service gives the host:

```bash
DATA_DIR=... bun node_modules/@animalabs/connectome-host/src/update/setup.ts [--root DIR] [--extra-state PATH]...
```

It copies the install as the first release of an install root,
`./connectome-host` unless `--root` names another, and writes the entry point
`start.js` there. Give `--extra-state` for each place an MCPL server keeps its
state outside the data directory, so each update copies it with the data.
Then have the service start the host with `bun <root>/start.js`, followed by
the arguments it gives the host now, and restart it. Setup says whether the
service restarts the host when it exits with 75 and with 1, as a switch and
its fallback need: systemd's `Restart=on-failure` does.

**Updating.**
- **The notice:** the host reads npm's registry, or the one
  `npm_config_registry` names in its environment, at start and once a day.
  It doesn't read a registry set only in an `.npmrc`, and it sends no
  token, so for a mirror, set `npm_config_registry` in the service's
  environment; one that needs a token answers the read with its error,
  which `/update` shows. When a newer release
  is out, its log, `/update` and the `update` section of `/healthz` say so,
  with what the releases since cost: which are breaking, which write each
  resident's prompt cache in full once, and which say nothing of their cost.
  With `CONNECTOME_UPDATE_CHECK=0` or `NO_UPDATE_NOTIFIER` set, it doesn't read
  the registry on its own, and `/update` still does. A fleet child never does.
- **Update,** `/update install`, installs the newest release that isn't
  deprecated beside the running one, with nothing stopped, once the Bun it
  runs on meets that release's floor. Nothing else changes. When the floor
  is above it, upgrade Bun and start the host again first.
- **Restart,** `/update restart`, quiesces the host and its fleet children,
  each as the web UI's Quiesce quiesces one host, and gives turns in
  progress two minutes to end. If some don't, it says who is still mid-turn,
  and you choose: wait up to ten minutes more (`/update restart wait`), stop
  now and cut those turns off (`/update restart now`), or call it off
  (`/update restart resume`, which also ends a switch's quiesce left on a
  host after an earlier try). Scripts a turn left running in the background
  aren't waited for, and the stop ends them. Then the host stops, and its
  next start, which the service makes, copies the data, starts the new
  release on trial, and commits once that release has opened its stores and
  connected its servers. The host comes back quiesced and resumes once its
  agents have started; one you'd quiesced yourself stays quiesced. A host
  run in a terminal stops as `/quit` does: once it has stopped, start it
  again.
- **A release that ends before its commit** is undone at the next start: the
  copy is restored, what the new release changed is kept aside, and the
  release before starts. `/update` then says why, and shows the last 40
  lines the new release wrote through console's `log`, `info`, `warn`,
  `error` and `debug` and to its stdout and stderr, which it kept itself in
  `trial-log.json` in the install root. The service's log, or the terminal
  a host started by hand ran in, has what those leave out: console's other
  methods, an error Bun reported itself, everything from a release a signal
  ended (a stop, or the OOM killer) or whose code didn't load, and what its
  servers' processes wrote.
- **What each update copies:** the data directory, each fleet child's data
  directory, the MCPL settings files in the working directory, and the
  state setup recorded. A fleet child given `.` as its data directory makes
  the whole working directory part of that, so keep the install root outside
  it. The copy stays until the next switch replaces it.
- **A request refused before anything changed,** such as one that finds a
  fleet child still running or too little room for the copy, is dropped,
  and the log and `/update` say why: ask again once that has cleared.
- **Going back** after a commit: `/update back` says how old the copy is,
  and offers keeping the newer data (`/update back keep`), which loses
  residents nothing, or restoring the copy (`/update back restore`), which
  sets everything since aside, not deleted, and brings the host back
  quiesced or serving as the copy holds it, so a quiesce you made since
  doesn't come back. Either way the host quiesces first, as Restart does. If the older release ends before its commit on
  the newer data, as when its store audit refuses a store, the next start
  puts the newer release and its data back by itself, and restoring the
  copy is the way from there.
- **When the new release keeps exiting after its commit,** it's never up to
  ask. Each start's log names the command instead: `bun <root>/start.js
  --go-back`, with `--keep-data` to keep the newer data. It waits up to a
  minute for the host to give up the install's lock, which one that keeps
  exiting does between starts, writes the request, and the service's next
  start goes back. If the service isn't running, start it. A release that
  stays up longer than a minute before each exit can hold the lock through
  the wait: stop the service, run the command, and start the service.

**By hand.** An install of the published package (`npm install
@animalabs/connectome-host`, or `bun add`) changes version only when npm or
bun is run to change it, `npm update` and `bun update` included, and a
clone of connectome-host when you check out another tag. An install
resolves the libraries' ranges as they stand that day, so it can run
library releases newer than the ones the release's own lockfile pins,
while a clone installs from its tag's `bun.lock`. So:

- **Before updating,** read the new version's `CHANGELOG.md`
  (`https://github.com/anima-research/connectome-host/blob/v<version>/CHANGELOG.md`)
  back to the version you run, Breaking first, and what its entries say
  about going back. Check `node --version` and `bun --version` against the
  new version's floors, which a Breaking entry names when they rise.
- **To update,** copy the install's `package.json` and its lockfile
  (`package-lock.json`, or `bun.lock` for an install made with bun), or in a
  clone note the tag you're on (`git describe --tags`). Note the versions
  `npm ls @animalabs/agent-framework @animalabs/context-manager
  @animalabs/chronicle` names, and the version of any MCPL server the notes
  say to update. Stop every agent that runs from the install, and its fleet
  children, as "Updating checkouts" says, and any MCPL server an agent
  reaches by `url` whose state the copy takes, wherever it's defined, the
  agent's own deploys (`mcpl-servers.agent.json`) included: it runs apart
  from the host. Then install the new version: `npm install
  @animalabs/connectome-host@<version>`, or `bun add
  @animalabs/connectome-host@<version>`, or in a clone `git fetch --tags`,
  `git checkout v<version>` and `bun install`. In a clone, `bun install` also
  builds the Web UI unless install scripts are off. If it says that build
  failed, or scripts were off, run `bun run build:web` before starting:
  until a build succeeds, the Web UI serves whatever `dist/web` holds, if
  anything, which isn't this version's build. If that fails too, the host
  still runs without this version's Web UI, and going back, below, restores
  the one you had.
- **Before starting them,** run `npm ls` as before and compare. For each of
  the three libraries that moved, read its notes between the two versions,
  `https://github.com/anima-research/<library>/blob/main/CHANGELOG.md`, for
  what they say about going back. Read the same in the notes of any MCPL
  server you'll update, between the version you noted and the new one: its
  own changelog, or its commits if it keeps none. Then:
  - **Copy what each agent keeps** at every update: "Updating checkouts"
    says what to copy, how, and why.
  - **Then run the new version's store audit,** after the copy and before
    starting any agent, with the agents and their fleet children still
    stopped. It opens each store in place, as the new version's start
    would, so it changes the stores as that start would, and the copy is
    what puts them back. Run it the way you start the host, from the new
    version, in the directory and environment the host starts in, since
    relative directories resolve from there, with `--audit-stores` in place
    of the recipe's options: `bun
    node_modules/@animalabs/connectome-host/src/index.ts --audit-stores
    --recipe <recipe> <data directory>`, or `bun src/index.ts
    --audit-stores …` in a clone, with the host's `DATA_DIR`, or `./data`
    in that directory when it isn't set. A `DATA_DIR` that the service or
    `.env` gives the host doesn't reach the shell you type the command in,
    and nor does any other variable the service sets, so export those.
    Give `--recipe` the recipe your start command names, so the
    audit opens the stores under the recipe that start would load; without
    it, the audit reads the one the host's last start saved, as a start
    given none does, and with none saved, the default one. Run it once for
    each agent you start. It audits every session's store in the data
    directory, and each fleet child the recipe's `modules.fleet.children`
    names whose data directory exists, in a process of its own, as the
    fleet launches it: under the recipe its entry names, in the environment
    the fleet starts it with, given 5 minutes to end, or the minutes
    `CONNECTOME_FLEET_CHILD_AUDIT_MINUTES` in the audit's environment gives:
    a number above 0, a larger one than a timer holds (about 35,791
    minutes, Infinity included) giving the longest it does; 0 or below, or
    not a number, gives 5.
    A child launched by `fleet--launch` isn't in
    the recipe: run the audit on its directory too, the `dataDir` its launch
    named, `--audit-stores <directory>`, which reads the recipe its last
    start saved, in the audit's environment. The audit prints a line on
    stderr for each store under each agent name it opens it under, the
    recipe's or the default and each session's own, or one for a store it
    doesn't open, and exits 0 when no store was refused and every
    store there was audited. A store a session names in its data directory
    that isn't there yet gets a line and no failure, since a start makes an
    empty one. Otherwise each
    line that says `refused`, or starts `Couldn't audit`, names a store or a
    directory the new version didn't open, and why: go back, below, which
    restores the copy. A store that lies outside its data directory, or
    holds a link to what does, isn't opened, since the copy doesn't hold
    what it reaches; its line says how to go on. A line saying a strategy
    called a model while opening a store means no audit can answer for that
    store, only a start: whether to start on it is yours. A store refused
    for crossed summaries, whose line says `store topology rejected`, can
    instead be repaired on a copy of the stopped store as
    [AGENT-ONBOARDING §11.8](./AGENT-ONBOARDING.md#11-critical-gotchas-read-before-deploying)
    says. Then put the repaired copy in the store's place, keeping the
    original, and run the audit again before starting, since the repair's
    own check opens the copy `auditOnly`, which can pass a store a start
    refuses. For anything else a line names, correct it and run the audit
    again, or go back.
  - **Then** update any MCPL server the notes name, the way you installed
    it, and start the servers you stopped.

  Then start the agents.
- **To go back,** stop the agents again, with any fleet children still
  running, and the MCPL servers reached by `url` that you stopped before
  the copy. Restore the copied `package.json` and lockfile together, then
  run `npm ci`, or `bun install --frozen-lockfile`. The install rewrote
  the version in `package.json`, so a lockfile restored alone is refused.
  In a clone,
  check out the tag you noted and run `bun install`, then `bun run
  build:web` if it says the Web UI's build failed or scripts were off. Put
  back the version of any MCPL server you updated, and any recipe or `.env`
  change you made for the newer version. Then restore the copy of what each
  agent keeps in place of what's there now, not over it, so files the newer
  version added go too. That discards what the agents recorded since the
  copy was made. Where no copy was taken, read the notes between the two
  versions for what going back does with what the newer one stored. Then
  start the servers you stopped, and the agents.

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
   now: context-manager's compile keeps at most 6 live images
   (`maxLiveImages`), strips images deeper than 30 000 tokens
   (`imageStripDepthTokens`) and keeps cumulative inline image base64 under
   20 MiB (`maxLiveImageBytes`), replacing the rest with placeholders; membrane
   degrades API-rejected media types (SVG, TIFF, …) to a visible placeholder
   and fails loudly, before the API call, when a request exceeds its byte cap
   (28 MB, `MEMBRANE_MAX_REQUEST_BYTES`); agent-framework's `read_image`
   rejects files over 5 MB. Still missing: nothing downsamples or
   size-checks an individual image on ingest (membrane's `images.autoResize` /
   `maxSizeBytes` config is declared but unused), so one image over the
   provider's per-image limit still 400s the request while it stays live —
   the poison-history breaker only sheds newest exchanges. Recipes can tune
   the three image keys under `agent.strategy` (autobiographical and
   frontdesk; zero disables each limit independently). (Stopgap: a per-install
   `strip-oversized-images.mjs`, below.)

## Helper scripts (per install dir)

These live in an install dir's own `scripts/` and are **not shipped in this
repo**:

- `scripts/ingest-multiuser.mjs` — multi-user chat export → chronicle (roster-
  attributed participants). No shipped equivalent; the shipped importers cover
  claude.ai exports (`scripts/import-claudeai-export.ts`) and Codex rollouts
  (`scripts/import-codex-rollout.ts`).
- `scripts/compress-fresh.mjs` — drain the compression queue offline before
  launch (uses the recipe's `compressionModel`). Shipped counterpart:
  `scripts/warmup-session.ts <session>`, which drives a session's
  autobiographical compression to convergence offline (model via `--model`,
  not read from the recipe).
- `scripts/strip-oversized-images.mjs` — remove >5 MB image blocks from the
  chronicle (agent must be stopped). No shipped equivalent.
