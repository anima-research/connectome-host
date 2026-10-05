# Connectome Dev Environment — Setup Guide

**Status:** Working notes. Dev layout originally captured 2026-05-30 (all feature branches in the original table have since merged to `main`); versions refreshed 2026-09-30 for connectome-host 0.9.0, except the MCPL-side repos (marked †), which are still the 2026-07-22 snapshot.
**Goal:** Reproduce the current development state — every component as a local git
checkout, wired together so the host runs against editable source.

---

## TL;DR

The whole stack is a **pseudo-monorepo of sibling git checkouts** under one parent
directory (canonically `~/connectome-local/`). The `@animalabs/*` libraries are
**symlinked into each other's `node_modules`** so there is exactly ONE instance of
each at runtime (sharing a single `membrane` instance is mandatory — two copies
break `instanceof` / module singletons). The host itself has no build step —
bun runs its `src/` directly — and under bun it loads `membrane`,
`context-manager` and `agent-framework` from their `src/index.ts` (each declares
a `bun` export condition; `main`/`dist/` is for Node consumers). The MCPL servers
run under node from `dist/`, so **they must be built**; `chronicle` is a native
napi-rs package whose npm copy ships prebuilt binaries (a checkout needs a Rust
build). See §2.

Each agent lives in a separate **install dir** (`<agent>-cm`, e.g. `example-cm`)
that holds a recipe + `.env` + chronicle data and references the code by absolute path.

---

## Projects & branches (current state)

All cloned as siblings under `~/connectome-local/`:

| Dir | GitHub repo | Branch | Ver | Role |
|---|---|---|---|---|
| `forking-knowledge-miner` | `anima-research/connectome-host` | `main` | 0.9.0 | the host app (run via **bun**) |
| `agent-framework` | `anima-research/agent-framework` | `main` | 0.21.0 | host runtime: gate, MCPL orchestration, locus routing, `think` |
| `discord-mcpl` | `anima-research/discord-mcpl` | `main` | 0.1.4 † | Discord surface (MCPL server) |
| `heartbeat-mcpl` | `anima-research/heartbeat-mcpl` | `main` | 0.1.3 † | periodic self-wake (MCPL server) |
| `terminal-sessions-mcp` | `antra-tess/terminal-sessions-mcp` ⚠️ | `main` | 1.6.0 † | shell: session daemon (ws://localhost:3100) + per-agent MCP stdio frontend |
| `membrane` | `antra-tess/membrane` ⚠️ | `main` | 0.5.86 | LLM client lib — **single shared instance required** |
| `context-manager` | `anima-research/context-manager` | `main` | 0.13.0 | context compilation / autobiographical memory |
| `chronicle` | `anima-research/chronicle` | `main` | 0.4.0 | record / chronicle store (Rust, napi-rs bindings) |
| `mcpl-core-ts` | `anima-research/mcpl-core-ts` | `main` | 0.2.1 † | MCPL protocol types |

> Versions drift. The host and `@animalabs/*` library versions are what
> connectome-host `main` (package version 0.9.0) installs; † marks versions last recorded 2026-07-22 —
> check that repo's `package.json`. The published npm
> releases now track `main` closely (typically within a patch), so the
> stock `bun install` path is sufficient for host-level work — use the
> checkout layout below when editing the libraries themselves.

> ⚠️ **Org note:** `terminal-sessions-mcp` and `membrane` still live under the
> personal `antra-tess` org, not `anima-research`. Consider migrating them for
> consistency (as was done for discord-mcpl / heartbeat-mcpl).

> The host repo is `connectome-host` on GitHub but is historically checked out into
> a directory named `forking-knowledge-miner`. That name is legacy — nothing in
> this repo depends on it. The clone and symlink commands below assume it; if you
> clone into `connectome-host` instead, substitute that name throughout.

---

## 1. Clone

```bash
mkdir -p ~/connectome-local && cd ~/connectome-local

git clone git@github.com:anima-research/connectome-host.git forking-knowledge-miner
git clone git@github.com:anima-research/agent-framework.git
git clone git@github.com:anima-research/discord-mcpl.git
git clone git@github.com:anima-research/heartbeat-mcpl.git
git clone git@github.com:antra-tess/terminal-sessions-mcp.git
git clone git@github.com:antra-tess/membrane.git
git clone git@github.com:anima-research/context-manager.git
git clone git@github.com:anima-research/chronicle.git
git clone git@github.com:anima-research/mcpl-core-ts.git
```

---

## 2. Install + build (bottom-up)

Install leaf libs first, then the framework, then the host:

```
membrane → chronicle → context-manager → agent-framework → connectome-host
mcpl-core-ts → discord-mcpl
heartbeat-mcpl
terminal-sessions-mcp
```

What "build" means differs by package:

- **`membrane`, `context-manager`, `agent-framework`** — `npm install && npm run
  build` (`tsc` → `dist/`). Under bun the host resolves their `bun` export
  condition to `src/index.ts`, so edits to their `src/` take effect without a
  rebuild; `dist/` is what Node consumers (their own tests, tooling) load.
- **`chronicle`** — a Rust crate with napi-rs bindings: `main` is `index.js`,
  which loads a platform `chronicle.*.node` binary, and `npm run build` is
  `napi build` (needs a Rust toolchain). Only needed when you change chronicle;
  the npm package ships prebuilt binaries (macOS arm64/x64, Linux arm64/x64
  glibc, Windows x64).
- **MCPL servers** (`discord-mcpl`, `heartbeat-mcpl`, `terminal-sessions-mcp`)
  — `npm install && npm run build`; recipes run their `dist/` under node.
- **`connectome-host`** — no `main` and no build step: bun runs `src/`
  directly. `bun install` runs `postinstall`, which builds the WebUI SPA into
  `dist/web` (`bun run build:web` to rebuild it).

> `discord-mcpl` now depends on `@animalabs/mcpl-core` as a regular npm
> dependency (the old `file:../mcpl-core-ts` path dep is gone). A sibling
> `mcpl-core-ts` checkout is only needed when changing mcpl-core itself.

---

## 3. Wire single-instance symlinks (the crucial part)

The host imports `@animalabs/{agent-framework,membrane,context-manager,chronicle}`,
`agent-framework` *also* imports `@animalabs/{membrane,context-manager,chronicle}`,
and `context-manager` imports `@animalabs/{membrane,chronicle}` (membrane at
runtime, e.g. its `NativeFormatter`). These must resolve to the SAME physical
copy, or you get two `membrane` instances and subtle breakage. Replace the
npm-installed copies with symlinks to the siblings.

```bash
# Host resolves the framework + shared libs from the sibling checkouts:
cd ~/connectome-local/forking-knowledge-miner/node_modules/@animalabs
for d in agent-framework membrane context-manager; do
  rm -rf "$d"; ln -sfn "../../../$d" "$d"
done
# (chronicle can remain the npm-installed copy — versions match — or symlink it too.)

# agent-framework shares the SAME membrane / context-manager instance as the host:
cd ~/connectome-local/agent-framework/node_modules/@animalabs
for d in membrane context-manager chronicle; do
  rm -rf "$d"
  ln -sfn "../../../forking-knowledge-miner/node_modules/@animalabs/$d" "$d"
done

# context-manager's own install carries its own membrane / chronicle — relink those too:
cd ~/connectome-local/context-manager/node_modules/@animalabs
for d in membrane chronicle; do
  rm -rf "$d"
  ln -sfn "../../../forking-knowledge-miner/node_modules/@animalabs/$d" "$d"
done
```

Verify each symlink resolves and reports the expected version (run in each
relinked `node_modules/@animalabs`):
```bash
for d in membrane context-manager chronicle; do
  echo -n "$d -> "; readlink -f "$d"; grep '"version"' "$d/package.json" | head -1
done
```

> This is the layout in use on a checkout-based box. On a fresh box, `npm
> install` inside `agent-framework` (and `context-manager`) will pull its own
> `@animalabs/*` copies first — run it, THEN replace them with the symlinks above.

---

## 4. Shell daemon (terminal-sessions-mcp)

The shell tool is two parts: a **per-agent MCP stdio frontend** (spawned by the
recipe) that connects over WebSocket to a **shared session daemon**. Run the daemon
as a supervised, token-protected service on `localhost:3100`:

```bash
node ~/connectome-local/terminal-sessions-mcp/dist/src/server/start-session-server.js \
  --host localhost --headless --token <SESSION_SERVER_TOKEN>
```
- Supervise it: launchd `com.terminal-sessions.server` (macOS) /
  systemd-user `terminal-sessions.service` (Linux, needs `loginctl enable-linger`).
- The token is required — each agent's shell frontend must present it as
  `SESSION_SERVER_TOKEN` or the daemon closes the socket ("Connection lost").
- Each host/box runs its OWN daemon + token (don't share tokens across machines).

---

## 5. Agent install dir (e.g. `<agent>-cm`)

Separate from the code — holds config + data, references code by absolute path.

```
<agent>-cm/
  recipes/<agent>.json   # agent def, mcpServers (ABSOLUTE paths to each dist/),
                         #   wake-gate policies, modules, strategy
  .env                   # secrets + paths (see below)
  data/                  # chronicle store + per-session config/gate.json
  launch.sh              # optional convenience launcher
```

**`.env` keys:**
```
ANTHROPIC_API_KEY=...
DISCORD_TOKEN=...
DISCORD_GUILD_ID=...                 # comma-separated; empty = all guilds
DISCORD_MCPL_DEBUG_LOG=<abs>/data/discord-mcpl-debug.log
DISCORD_SUBSCRIPTIONS_FILE=<abs>/data/discord-subscriptions.json
SESSION_SERVER_TOKEN=<same token the shell daemon was started with>
HEARTBEAT_CONFIG_FILE=<abs>/data/heartbeat-config.json
```

The host reads `.env`, but stdio MCPL servers see only what their recipe entry
maps in `env` (plus a small system allowlist), e.g.
`"DISCORD_GUILD_ID": "${DISCORD_GUILD_ID}"`. A variable left only in `.env` is
unset for the server.

**Run the host (headless), supervised:**
```bash
bun ~/connectome-local/forking-knowledge-miner/src/index.ts \
  ~/connectome-local/<agent>-cm/recipes/<agent>.json --headless
```
- macOS: launchd agent (e.g. `cc.<agent>.agent`) — stop with `launchctl bootout`,
  restart with `launchctl kickstart -k gui/$(id -u)/<label>`.
- Linux: systemd-user (e.g. `<agent>-agent.service`) —
  `systemctl --user restart <unit>`; needs lingering enabled.

---

## 6. Runtimes

- **bun** — runs the host (`bun src/index.ts …`).
- **node ≥ 20** — runs the MCPL servers (node 22 also fine). nvm fine locally.
- **Rust toolchain** — only to build `chronicle` from a checkout; the npm
  package ships prebuilt binaries.

---

## Gotchas (carry these over)

1. **Recipe MCP paths are absolute.** Each `mcpServers.*.args[0]` points at a
   `dist/src/index.js` by absolute path — they must match the new env's checkout
   location, or templatize them.
2. **`gate.json` is per-session and append-only.** The recipe's `modules.wake`
   seeds a fresh session's `data/sessions/<id>/config/gate.json` verbatim, but on a
   *resumed* session the gate only *appends* recipe policies it doesn't already
   have (by name) — it does NOT reorder. Since the gate is first-match-wins, to
   change wake ordering you must edit the **live** `gate.json`, not just the recipe.
3. **Single `membrane` instance** (see §3) — the #1 source of weird runtime errors
   if you skip the symlink wiring and end up with two copies.
4. **Prod vs dev divergence.** Production boxes may run `@animalabs/*` as
   npm-installed pinned copies rather than checkouts. "Mirroring current dev
   state" means the symlinked-checkout layout in this doc.
5. **Two repos still under `antra-tess`** (`membrane`, `terminal-sessions-mcp`) —
   not yet migrated to `anima-research`.

---

## Architecture cross-references

- [`history/LOCUS-ROUTING-DESIGN.md`](./history/LOCUS-ROUTING-DESIGN.md) — the
  original design for host-owned output routing (why stickiness/`think` live in
  the framework, not in a surface adapter); kept verbatim as history.
- Output routing: `agent-framework/src/framework.ts` (turn completion →
  `ChannelRegistry.routeSpeech`), `src/mcpl/channel-registry.ts`.
- Wake gate: `agent-framework/src/gate/event-gate.ts` (+ recipe `modules.wake`).
- Discord surface signals (`isExplicitMention` / `isReplyToBot` / `isBot`):
  `discord-mcpl/src/server.ts`.
