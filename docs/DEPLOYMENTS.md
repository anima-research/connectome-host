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
pulls, with no release in between. agent-framework's and connectome-host's
releases stop while an issue labelled `release-hold` is open in their
repository. Such an issue says that `main` as it stands would harm someone
running it, and what has to happen first. A pull doesn't stop for it, and
the layout's other repositories have no holds. So:

- **Before pulling,** look at the open holds. The repositories are public,
  so their issue pages need no login:
  ```
  https://github.com/anima-research/agent-framework/issues?q=is%3Aissue+is%3Aopen+label%3Arelease-hold
  https://github.com/anima-research/connectome-host/issues?q=is%3Aissue+is%3Aopen+label%3Arelease-hold
  ```
  With `gh` logged in, `gh issue list --label release-hold` in each
  repository shows the same. While a hold applies to your box, keep every
  checkout on the commit it has, since the host and its libraries move
  together. If you can't read the list, treat a hold as open until you
  can. Then read what each checkout would take. Where the repository keeps
  a changelog, this shows its released sections and pending fragments:
  ```bash
  git fetch && git diff HEAD origin/main -- CHANGELOG.md changelog.d
  ```
  heartbeat-mcpl and mcpl-core-ts keep none, so read their commits with
  `git log --oneline HEAD..origin/main` after the fetch.
- **If a hold names a commit you already run,** go back, below, to
  commits from before it. In a checkout that contains the commit,
  `git merge-base --is-ancestor <commit> HEAD` exits 0. The commits you
  noted may already contain it; `git reflog` shows earlier ones.
- **To update,** note the commit each checkout is on with
  `git rev-parse HEAD`, and first stop every agent that runs from these
  checkouts, with the shell daemon if its checkout will move. Stopping an
  agent stops the fleet children it launched. For one left running, after
  a TUI quit that detached it or a parent that was killed outright, `kill`
  the PID in `headless.pid` in its data directory, which shuts it down as
  a stop does. bun runs the host's `src/` directly and imports some
  modules only when they're first needed, so files that change under a
  running agent can mix new code into it. The daemon serves every agent on
  the box, so stopping it ends their shell sessions too. If the entries
  say data the newer code writes doesn't read back on the older code, copy
  what each agent keeps while it's stopped: its data directory
  (`DATA_DIR`), its fleet children's data directories (`data/<child>`
  under its working directory, unless a launch named another), the MCPL
  server settings it saves in its working directory (`mcpl-servers.json`
  and `mcpl-servers.agent.json`), and the files its `.env` names, such as
  `HEARTBEAT_CONFIG_FILE` and `DISCORD_SUBSCRIPTIONS_FILE`. Then update
  the host and the libraries it loads together (`git switch main` first
  in a checkout left detached), since the host's code expects the library
  versions beside it. Install and build them bottom-up as
  [DEV-ENVIRONMENT §2](./DEV-ENVIRONMENT.md#2-install--build-bottom-up)
  does: each `dist/`, chronicle's native build when chronicle changed, and
  the host's Web UI. An `npm install` in agent-framework or context-manager
  brings back their own `@animalabs/*` copies, so relink them as
  [§3](./DEV-ENVIRONMENT.md#3-wire-single-instance-symlinks-the-crucial-part)
  says. Then start them.
- **To go back,** stop the agents again, with any fleet children still
  running, and the daemon if its checkout moved. Check the noted commits
  out again (which leaves each checkout detached), rebuild the same way,
  and put back any recipe or `.env` change you made for the newer code.
  If you copied the data, restore the copy before starting them. That
  discards everything the agents recorded since it was made. Then start
  them.
  agent-framework 0.22.1's notes, for example, say what going back to
  0.22.0 does with what 0.22.1 stored.

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
