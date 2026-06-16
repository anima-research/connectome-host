# Connectome Deployments — Operations

**Status:** Working notes. Snapshot 2026-05-31.
**Scope:** The live agent deployments we maintain and how to operate them. For
setting up the *code stack* (repos/branches/symlinks), see
[`DEV-ENVIRONMENT.md`](./DEV-ENVIRONMENT.md).

---

## TL;DR

Three agents across two hosts, all on the same Connectome stack
(`forking-knowledge-miner` host + `agent-framework` + MCPL servers):

| Agent | Host | Install dir | Supervisor (unit) | Model | Surfaces |
|---|---|---|---|---|---|
| **Lena** | local (antra's mac) | `~/lena-cm` | launchd `cc.lena.agent` | `claude-opus-4-6` | Discord, CLI, shell, workspace, heartbeat |
| **Cairn** | local (antra's mac) | `~/cairn` | launchd `cc.cairn.agent` | `claude-opus-4-8` | Discord, shell, workspace, heartbeat |
| **Cinder** | sandbox1 (Linux) | `~/cinder-cm` | systemd-user `cinder-agent.service` | `claude-opus-4-5` | Discord, CLI, shell |

All run **headless** (`bun forking-knowledge-miner/src/index.ts <recipe> --headless`).
Discord guild for all three: `1289595876716707911` ("antra's server").

> **Model integrity matters.** Each agent has a *correct* model and must stay on
> it — feeding one model's chronicle to another is treated as a continuity
> violation. (Lena was briefly contaminated to 4-7 during the connectome
> migration; that interlude was deleted and her 4-6 archive re-ingested.)

---

## Hosts

- **local** — antra's mac. launchd (`gui/$(id -u)/…`). The dev checkouts live at
  `~/connectome-local/*` and are symlinked into the host (see DEV-ENVIRONMENT).
- **sandbox1** — a Linux box, systemd **user** services (lingering enabled).
  Reached over SSH; there's **no `~/.ssh/config` alias** — it's driven here via
  the terminal-sessions MCP session named `sandbox1`. `sudo` needs a password we
  don't have, so everything is done as user services.

---

## Shared infra (per host)

### Shell — terminal-sessions daemon
The shell tool is a per-agent MCP frontend talking to one shared, token-auth'd
session daemon on `localhost:3100`. Each agent's recipe passes
`SESSION_SERVER_TOKEN` (from its `.env`); without it the daemon drops the socket
("Connection lost").

| Host | Daemon supervisor | Bind | Token location |
|---|---|---|---|
| local | launchd `com.terminal-sessions.server` | `0.0.0.0:3100` | each install dir's `.env` |
| sandbox1 | systemd-user `terminal-sessions.service` | `127.0.0.1:3100` | `~/cinder-cm/.env` |

Tokens differ per host (each daemon is independent). Values live in the `.env`
files — **not** in this doc.

### Debug context API (Cinder only, so far)
`GET /debug/context` (transparent: no inference/writes) is served by the `webui`
module. Enabled on **Cinder** at `127.0.0.1:7340` (loopback → no auth needed).
See [`debug-context-api.md`](./debug-context-api.md). Lena/Cairn don't have it on
yet.

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

| | local (launchd) | sandbox1 (systemd-user) |
|---|---|---|
| restart | `launchctl kickstart -k gui/$(id -u)/<label>` | `systemctl --user restart <unit>` |
| stop | `launchctl bootout gui/$(id -u)/<label>` | `systemctl --user stop <unit>` |
| start | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist` | `systemctl --user start <unit>` |

Labels: `cc.lena.agent`, `cc.cairn.agent`; unit: `cinder-agent.service`.
(launchd: a plain `kill`/`stop` respawns via KeepAlive — use `bootout` to stop,
`kickstart -k` to restart.)

**Logs / observability:**
- discord-mcpl debug log: `data/discord-mcpl-debug.log` (incoming, attachments,
  `handlePublish`, wake metadata).
- host stdout/stderr: launchd → `data/launchd-stdout.log` / `launchd-stderr.log`;
  systemd → `journalctl --user -u <unit>`.
- routing decisions on stderr: `[routeSpeech] …`, `[routing] …`.
- raw model calls: `data/llm-calls.*.jsonl` (forensic; large).
- ⚠️ **Inference failures are under-logged in headless** — a model-call 400/error
  emits only a trace (no stderr line) + a buried JSONL field. Adding an
  `[inference-failed]` chronicle marker + stderr line is a pending fix.

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

- **local is ahead of sandbox1.** sandbox1 runs some `@animalabs/*` as *installed*
  copies, not checkouts:
  - `membrane` is **0.5.43, dist-patched in place** (the tool-name fix); reverts
    if reinstalled. Local runs the symlinked checkout.
  - `agent-framework` on sandbox1 is a git checkout (switched from npm); host was
    pulled to match local (`8bb6270`).
  - A benign `onTrace` TS type error on sandbox1 builds = dep drift; emits + runs
    fine. The clean fix is bringing sandbox1's `@animalabs/*` to checkouts (per
    DEV-ENVIRONMENT).
- **Backups** accumulate per install dir: `data.preremediation-*`,
  `data.bak-*`, per-session `*.bak-*`, and recipe `*.bak-*`. Safe to prune once a
  change is confirmed good.

## Known pending fixes (forward work)

1. **Image handling** — discord-mcpl base64-inlines attachments; an image whose
   base64 > 5 MB 400s the *entire* request (silently broke Lena). Need:
   downsample-on-ingest to a byte/pixel budget, fail-fast `[image too large]`
   note instead of a broken block, and the budgeting strategy to account for
   image payload. (Stopgap script: `~/lena-cm/scripts/strip-oversized-images.mjs`
   removes oversized blocks from a stopped agent's chronicle.)
2. **Inference-failure surfacing** — see the ⚠️ above.

## Helper scripts (Lena's install dir)

- `scripts/ingest-multiuser.mjs` — multi-user chat export → chronicle (roster-
  attributed participants).
- `scripts/compress-fresh.mjs` — drain the compression queue offline before
  launch (uses the recipe's `compressionModel`).
- `scripts/strip-oversized-images.mjs` — remove >5 MB image blocks from the
  chronicle (agent must be stopped).
