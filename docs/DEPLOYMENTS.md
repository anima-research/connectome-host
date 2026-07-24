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
`GET /debug/context` (transparent: no inference/writes) is served by the `webui`
module. Keep it on **loopback** and reach it via SSH tunnel. See
[`debug-context-api.md`](./debug-context-api.md).

---

## Operating an agent

**Recipe / config / data live in the install dir:**
- `recipes/<agent>.json` — agent def, model, MCP servers (absolute paths to each
  `dist/`), wake-gate policies, modules.
- `.env` — `ANTHROPIC_API_KEY`, `DISCORD_TOKEN`, `DISCORD_GUILD_ID`,
  `DISCORD_MCPL_DEBUG_LOG`, `DISCORD_SUBSCRIPTIONS_FILE`, `SESSION_SERVER_TOKEN`,
  `HEARTBEAT_CONFIG_FILE`.
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

**Logs / observability:**
- discord-mcpl debug log: `data/discord-mcpl-debug.log` (incoming, attachments,
  `handlePublish`, wake metadata).
- host stdout/stderr: launchd → `data/launchd-stdout.log` / `launchd-stderr.log`;
  systemd → `journalctl --user -u <unit>`.
- routing decisions on stderr: `[routeSpeech] …`, `[routing] …`.
- raw model calls: `data/llm-calls.*.jsonl` (forensic; large).
- ⚠️ **Inference failures are under-logged in headless** — a model-call 400/error
  emits only a trace (no stderr line) + a buried JSONL field. An
  `[inference-failed]` chronicle marker + stderr line helps surface these.

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
  dist patch reverts if the package is reinstalled. The clean state is the
  symlinked-checkout layout (per DEV-ENVIRONMENT).
- **Backups** accumulate per install dir: `data.preremediation-*`,
  `data.bak-*`, per-session `*.bak-*`, and recipe `*.bak-*`. Safe to prune once a
  change is confirmed good.

## Known pending fixes (forward work)

1. **Image handling** — discord-mcpl base64-inlines attachments; an image whose
   base64 > 5 MB 400s the *entire* request. Need: downsample-on-ingest to a
   byte/pixel budget, fail-fast `[image too large]` note instead of a broken
   block, and the budgeting strategy to account for image payload. (Stopgap
   script: `scripts/strip-oversized-images.mjs` removes oversized blocks from a
   stopped agent's chronicle.)
2. **Inference-failure surfacing** — see the ⚠️ above.

## Helper scripts (per install dir)

- `scripts/ingest-multiuser.mjs` — multi-user chat export → chronicle (roster-
  attributed participants).
- `scripts/compress-fresh.mjs` — drain the compression queue offline before
  launch (uses the recipe's `compressionModel`).
- `scripts/strip-oversized-images.mjs` — remove >5 MB image blocks from the
  chronicle (agent must be stopped).
