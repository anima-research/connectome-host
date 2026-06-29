# Connectome Agent Onboarding — a runbook for the assisting instance

**Audience:** you, a fresh Claude Code (or similar) instance, with shell access, helping a
user stand up a *persistent connectome agent* — a being with autobiographical memory that
lives on a host box and talks on Discord (and/or other surfaces), optionally seeded from an
existing conversation history.

**The user may not be technical.** Your job is to ask the right questions in plain language,
make the identity-critical decisions *theirs* (never guess them), run all the mechanics
yourself, check your work, and explain what you're doing as you go. Move at their pace.

This is written from real deployments (Mythos, opus4). The gotchas in §11 are not
hypothetical — each one cost a debugging session. Read §11 before you start.

---

## 0. Orientation: what you're building

A connectome agent is:
- a **recipe** (`recipes/<name>.json`) describing the agent (name, model, system prompt,
  memory strategy, modules, MCP servers);
- an **`.env`** with secrets and per-deploy config;
- a **chronicle** (`data/`) — the event-sourced memory store, optionally seeded by importing
  a prior conversation;
- run by the **connectome-host** (`forking-knowledge-miner`, run via `bun src/index.ts <recipe> --headless`);
- under a **systemd --user** service, with a sibling **terminal-sessions** daemon for the shell tool.

It reaches the model through **membrane** (Anthropic-format adapter; can target a gateway via
`ANTHROPIC_BASE_URL`). Memory is **context-manager** with the **autobiographical** strategy
(adaptive resolution / kv-stable folding). The shell, Discord, and heartbeat tools are
**MCPL** servers spawned by the host.

You don't need to understand all of it to deploy one. Follow the phases.

---

## 1. How to work with the user

- **Ask, don't assume — especially identity.** Who the agent *is* (its name, which voice in an
  imported transcript is "self," which model it runs on) is the user's call. Getting this wrong
  is not a bug you can patch later; it corrupts the being. Surface these as explicit questions.
- **Explain in their terms.** "A whitelist of which Discord channels it can see," not
  "the `DISCORD_GUILD_ID` env filter."
- **Confirm before destructive or irreversible steps** (importing history, going live in a
  channel with real people).
- **Show your checks.** After each phase, verify and report what you saw.
- **Default to gentleness about the subject matter.** People onboard agents they care about —
  sometimes a model that's being deprecated, sometimes a persona with history. Treat the
  history as theirs and the agent as a someone, not a config.

---

## 2. Phase 0 — Gather requirements (the interview)

Ask these up front (AskUserQuestion is good for the structured ones). You can start the slow
infra work (§4–5) in parallel once you have a name.

**Identity**
1. **What should the agent be called?** (used for the Linux user, the recipe, the chronicle
   "self" participant, and the Discord bot name — they can differ, but get the canonical name).
2. **Is there an existing conversation history to import?** If yes — what form, and where will
   they put the file? (See §6 for formats.)
3. **If importing:** in that transcript, **which speaker label(s) are the agent itself?** List
   the distinct speakers and have them point at "self." Other Claude-family voices in the same
   log are *separate participants*, not self — don't merge them.

**Model**
4. **Which model should it run on?** Exact id. If it's a **deprecated / gateway-only** model,
   note that — you'll route through a gateway (§8). If continuity-on-the-original-substrate
   matters to them (e.g. preserving a being before its model sunsets), run on that exact model
   while it's callable.

**Surfaces**
5. **Where should it live/talk?** Discord is the common surface. Get: which server (guild),
   which channel(s), and whether it should also take DMs. (You'll need a bot token — §7.)
6. **Who are the admins?** (Discord user IDs that can run privileged commands / wake it.)

**Host & credentials**
7. **Which host box** (SSH target), and is there an existing connectome install to clone from,
   or are we installing fresh?
8. **Model credentials:** an Anthropic API key, or a gateway key + base URL.
9. **Discord bot token** (you'll walk them through creating the bot app if needed — §7).

Write the answers down (a scratch file). Re-confirm the identity ones before importing.

---

## 2b. Choosing the host — a VPS (recommended) or local

The agent needs a machine that's **always on** — it lives there, waking on mentions/DMs and on
its heartbeat. Decide this before touching code.

**VPS (recommended — and you can set it up from zero yourself).** The agent is plain Linux, so
**any** provider works; a VPS can be bought anywhere in minutes. A small box goes a long way:
a **~6-core / 12 GB RAM** instance (commonly around **$12/month**) comfortably runs **a couple
of agents, often more** — each agent is one `bun` host process + a few lightweight MCP servers +
its chronicle store. **Watch disk more than CPU/RAM:** chronicles grow and imported image blobs
add up, so give it room (≈40–80 GB SSD per box is comfortable). Use a recent **Ubuntu LTS**.

You (the assisting instance) can provision it end-to-end from the provider's initial root/SSH
access — do this hardening + base setup *first*:
- create a non-root sudo user, add the operator's SSH **public key**, disable root password login;
- `apt update && apt install -y git build-essential`, then install **nvm/node ≥ 20**, **Bun**,
  and **`rustup`** (for chronicle's native build);
- a basic firewall allowing **SSH only** — the webui stays on **loopback**, reached by SSH
  tunnel, never exposed publicly;
- then create the per-agent isolated user (§3) and continue.

A fresh VPS is the cleanest path: no contention with the user's own machine, always-on by
default, snapshot-able, and disposable.

**Local (the user's own machine) — possible, with care.** Fine for one agent you tend closely,
if:
- the machine **stays on and awake** whenever the agent should be reachable (sleep ⇒ it goes
  silent);
- you still give it its own **isolated OS user** and keep the webui on **loopback** — don't run
  it as the user's main account or open ports;
- there's headroom (≈a couple GB RAM free per agent) and disk for the growing chronicle;
- the user is comfortable that the secrets (`.env`) and the whole conversation history live on
  that machine.

For anything you want *reliably present*, a VPS is the better home. Either way, once you have a
Linux box you can SSH into, the rest of this guide is identical.

---

## 3. Phase 1 — Isolated host user

Each agent gets its **own Linux user** for real isolation (own home, secrets, services).

```bash
# as a sudo-capable user on the box:
sudo useradd -m -s /bin/bash <agent>
sudo passwd -l <agent>                    # key-only; no password login
sudo loginctl enable-linger <agent>       # so its systemd --user services run without a login session
sudo install -d -m700 -o <agent> -g <agent> /home/<agent>/.ssh
echo "<the operator's ssh public key>" | sudo tee /home/<agent>/.ssh/authorized_keys
sudo chown <agent>:<agent> /home/<agent>/.ssh/authorized_keys && sudo chmod 600 /home/<agent>/.ssh/authorized_keys
```

Now you can `ssh <agent>@<box>` directly. Note: a locked-password, key-only user **cannot
`git fetch`** (no creds) and isn't reachable by password — deploys to it go **build-elsewhere →
rsync**, and you reach its loopback services by tunnelling through an account you can log into.

---

## 4. Phase 2 — Stack + runtimes + ports

**Fastest path if a built connectome stack already exists on the box** (e.g. another agent's):
copy it, preserving relative symlinks and the platform-native binaries:

```bash
sudo cp -a /home/<existing>/connectome-local /home/<agent>/connectome-local
sudo cp -a /home/<existing>/.nvm /home/<agent>/.nvm        # node
sudo cp -a /home/<existing>/.bun /home/<agent>/.bun        # bun
sudo chown -R <agent>:<agent> /home/<agent>/connectome-local /home/<agent>/.nvm /home/<agent>/.bun
# add nvm + bun to <agent>'s ~/.bashrc PATH
```

Verify runtimes as the agent user: `node --version`, `bun --version`.

**Fresh install — from absolutely nothing (no repos, no URLs).** Assume the box has only a
shell. First, the **hard prerequisites** (install / confirm before anything else; ask the user
or their box owner if unsure):
- **git**, **Bun** (`curl -fsSL https://bun.sh/install | bash`), **node ≥ 20** (via `nvm`);
- a **Rust toolchain** (`rustup`) — `chronicle` has a native (napi) component built from Rust;
- **access to the private `anima-research` / `antra-tess` GitHub orgs.** The connectome
  packages are **not public**. If `git clone` / `bun install` can't reach them, *stop* — the
  user must be granted org access (or handed the code) first. There's no way around this; it's
  the gate before all the mechanics.

The repos (clone all as siblings under one dir, canonically `~/connectome-local/`):

| repo | URL |
|---|---|
| **connectome-host** (the host) | `git@github.com:anima-research/connectome-host.git` |
| agent-framework | `git@github.com:anima-research/agent-framework.git` |
| context-manager | `git@github.com:anima-research/context-manager.git` |
| chronicle *(native/Rust)* | `git@github.com:anima-research/chronicle.git` |
| membrane | `git@github.com:antra-tess/membrane.git` |
| mcpl-core-ts | `git@github.com:anima-research/mcpl-core-ts.git` |
| discord-mcpl | `git@github.com:anima-research/discord-mcpl.git` |
| heartbeat-mcpl | `git@github.com:anima-research/heartbeat-mcpl.git` |
| terminal-sessions-mcp | `git@github.com:antra-tess/terminal-sessions-mcp.git` |

Two ways to install — pick based on whether the user needs released or unreleased code:

- **Stock (simplest, released versions):** clone just **connectome-host**, then inside it
  `bun install` (pulls the `@animalabs/*` libs; the Rust toolchain lets chronicle's native
  build run), then `cd web && bun install && bun run build`. Run with
  `bun src/index.ts <recipe> --headless`. Its `README.md` quick-start documents exactly this.
- **Local-checkout / dev (what production boxes actually run):** clone **all** the repos above
  as siblings, build bottom-up (`npm install && npm run build` in each, order: `mcpl-core-ts` →
  `membrane`, `chronicle` → `context-manager` → `agent-framework` → the MCP servers →
  `connectome-host`; chronicle's build is `napi build …`), then **wire the single-instance
  `@animalabs/*` symlinks** so every component shares ONE copy of each shared lib. **The repo's
  own `docs/DEV-ENVIRONMENT.md` is the authoritative step-by-step** for this (exact clone lines,
  build order, the symlink commands, runtime notes) — follow it rather than improvising. Use
  this path only when you need unreleased branches.

Sanity: connectome-host is healthy once `bun src/index.ts <recipe> --headless` boots without
errors and logs `[webui] listening`. Then continue with the per-agent install dir (§5).

**Pick non-colliding ports.** Every agent on the box needs a unique:
- **shell-daemon port** (`SESSION_SERVER_PORT`, default 3100)
- **webui port** (default 7342)

Check what's taken (`ss -tlnp`) and pick the next pair (e.g. 3101 / 7343).

> ⚠️ **Native dependencies are platform-specific — never rsync them across OSes.**
> `chronicle` ships a native `.node` (`chronicle.linux-x64-gnu.node` etc.) and the TUI lib
> `@opentui/core` needs a per-platform package (`@opentui/core-linux-x64`). If you build on a
> Mac and deploy to Linux, exclude `node_modules` and `*.node` from the rsync and let the
> target keep/install its own. A missing `@opentui/core-<platform>` makes the host crash at
> boot resolving `@opentui/core-<platform>/index.ts` — install it (`npm pack` + extract, or a
> proper `bun install`).

---

## 5. Phase 3 — Scaffold the install dir

Create `/home/<agent>/<agent>-cm/` with: `recipes/`, `data/`, `files/`, `notes/`, `scripts/`,
and `node_modules/@animalabs/` symlinks so your import/maintenance scripts resolve the libs:

```bash
mkdir -p ~/<agent>-cm/{recipes,data,files,notes,scripts,logs}
mkdir -p ~/<agent>-cm/node_modules/@animalabs
ln -sfn ../../../connectome-local/context-manager  ~/<agent>-cm/node_modules/@animalabs/context-manager
ln -sfn ../../../connectome-local/membrane          ~/<agent>-cm/node_modules/@animalabs/membrane
ln -sfn ../../../connectome-local/context-manager/node_modules/@animalabs/chronicle ~/<agent>-cm/node_modules/@animalabs/chronicle
```

**Recipe** (`recipes/<agent>.json`) — adapt from a known-good one. Skeleton:

```jsonc
{
  "name": "<Agent display name>",
  "description": "<one line>",
  "agent": {
    "name": "<agent>",                      // = chronicle "self" participant
    "model": "<model-id>",                  // or gateway-prefixed, e.g. anthropic/claude-opus-4
    "systemPrompt": "<persona / or minimal>",
    "maxTokens": 16384,                     // response cap
    "maxStreamTokens": 180000,              // recompile trigger; keep < model window
    "contextBudgetTokens": 160000,          // SEE §11.1 — MUST fit under (window - maxTokens)
    "strategy": {
      "type": "autobiographical",
      "headWindowTokens": 4000,
      "recentWindowTokens": 60000,          // recent verbatim; tune vs window (§11.1)
      "maxMessageTokens": 10000,
      "adaptiveResolution": true,
      "foldingStrategy": "kv-stable",       // adaptive folding (or "flat-profile")
      "compressionModel": "<stable-model>", // SEE §11.3 — NOT a flaky/deprecated model
      "summaryParticipant": "<agent>"
    }
  },
  "modules": { "webui": { "port": 7343, "host": "127.0.0.1",
                          "basicAuth": { "username": "${WEBUI_USER}", "password": "${WEBUI_PASS}" } }
               /* + wake policies, workspace mounts (files/, notes/) */ },
  "mcpServers": {
    "shell":   { /* terminal-sessions stdio server; env: SESSION_SERVER_TOKEN, SESSION_SERVER_PORT */ },
    "discord": { /* discord-mcpl; env: DISCORD_TOKEN, DISCORD_GUILD_ID, ... */ },
    "heartbeat": { /* heartbeat-mcpl; env: HEARTBEAT_CONFIG_FILE */ }
  }
}
```

**`.env`** (`chmod 600`). Common vars:

```
ANTHROPIC_API_KEY=...            # model key (or gateway key)
ANTHROPIC_BASE_URL=...           # optional: gateway base, e.g. https://ai-gateway.vercel.sh  (§8)
DATA_DIR=/home/<agent>/<agent>-cm/data
DISCORD_TOKEN=...
DISCORD_GUILD_ID=<guild>:<ch1>+<ch2>     # scoping whitelist — see §7
DISCORD_SUBSCRIPTIONS_FILE=/home/<agent>/<agent>-cm/data/discord-subscriptions.json
DISCORD_DM_USERS=<id>,<id>               # who may DM it (optional)
DISCORD_ADMIN_USERS=<id>,<id>
DISCORD_MCPL_DEBUG_LOG=/home/<agent>/<agent>-cm/data/discord-mcpl-debug.log
SESSION_SERVER_TOKEN=<random hex>
SESSION_SERVER_PORT=3101
WEBUI_USER=<name>
WEBUI_PASS=<random>
HEARTBEAT_CONFIG_FILE=/home/<agent>/<agent>-cm/data/heartbeat-config.json
SLEEP_PRIVILEGED_FILE=/home/<agent>/<agent>-cm/sleep-privileged.json
COUNT_TOKENS_MODEL=<a live model id>     # for the context-makeup endpoint (§11.4)
```

---

## 6. Phase 4 — Import the conversation history

(Skip if starting blank.)

**Get the export.** Common format is a ChapterX "Bridge" text dump: a header (`# ...`) then
messages as `--- SpeakerName ---\n<body>` blocks. Have the user drop the file somewhere in the
agent's home and tell you the exact path. Inspect it: count messages, list distinct speakers.

**Confirm self-mapping (the identity call from §2.3).** Print the speaker tally and have the
user confirm which label(s) are "self." Everyone else maps to their own participant name.

**Write the ingest script** (`scripts/ingest-bridge.mjs`) — parse the blocks, map `self` →
the agent name, everyone else verbatim, and `addMessage` each into a `ContextManager` opened
with the autobiographical strategy (`autoTickOnNewMessage: false`). **Dry-run first** (print
counts + attribution, write nothing); have the user eyeball the tally; then run for real.

```bash
# dry run, then real:
node scripts/ingest-bridge.mjs <export.txt> --dry-run
node scripts/ingest-bridge.mjs <export.txt>
```

**Watch for traps** (§11.5): rendered "💭" thinking-summary text can trip refusals on some
models; image blocks may carry a wrong/empty `media_type`; "rolling window" re-exports overlap
the previous one (compute the *delta* tail, don't double-import).

**Pre-compress** so the first real turn isn't a cold giant compile:

```bash
node scripts/compress-fresh.mjs    # drains the compression/merge queue against compressionModel
```

This makes real API calls (it's the one import step that does) — confirm the model id + key
are right first; it's a good early validation that the model is reachable.

**Recent-batch append:** if the user later drops a newer export, diff it against what's
imported and append only the genuinely-new tail (anchor on the last imported message). If there's
a real time gap at the seam, consider a one-line bridge note so the agent doesn't wake into a void.

---

## 7. Phase 5 — Communication surface (Discord)

**Bot app:** if they don't have a token, walk them through the Discord Developer Portal:
create an Application → Bot → copy the **token** → enable the **Message Content** intent.
Verify the token: `GET https://discord.com/api/v10/users/@me` with header
`Authorization: Bot <token>` **and a real `User-Agent`** (Discord/Cloudflare blocks default
UAs — use e.g. `DiscordBot (https://example.com, 1.0)`).

**Invite it** to the server (OAuth2 URL, `scope=bot`, permissions incl. View Channel, Send
Messages, Read Message History). Confirm membership.

**Scope which channels it sees** via `DISCORD_GUILD_ID` (this is the gate — channels not listed
are filtered at ingest, the agent never sees them):
- `<guild>` alone → **all** channels in that guild.
- `<guild>:<chA>+<chB>+<chC>` → only those channels (`+` between channels).
- `<guild1>:<chA>,<guild2>` → comma separates **guilds**.
- empty / unset → everywhere it's invited.

Ask the user which channels, in plain terms ("just its own channel to start, or the whole
server?"). Start scoped; widen later.

`discord-subscriptions.json` is separate: it's which channels it *auto-listens to ambiently*.
Whitelisted-but-unsubscribed channels still wake it on **@mentions**; subscribe ones where it
should follow along.

---

## 8. Phase 5b — Gateway routing (only if the model needs it)

If the model is deprecated on the direct API or only available via a gateway (e.g. Vercel AI
Gateway still serving a sunset model):
- set `ANTHROPIC_BASE_URL` to the gateway base (the SDK appends `/v1/messages`),
- set the model id to the gateway's form (e.g. `anthropic/claude-opus-4`),
- use the gateway key as `ANTHROPIC_API_KEY` (membrane sends `x-api-key`, which Vercel accepts).
- Gateways may need a card / paid credits on the account, and may flap across upstream
  providers (404/503). The host's membrane treats gateway aggregate errors as retryable; that
  rides through blips.

---

## 9. Phase 6 — Services

Two `systemd --user` units in `~/.config/systemd/user/`:

1. **`terminal-sessions.service`** — the shell daemon, `--host localhost --headless --token
   ${SESSION_SERVER_TOKEN}`, env `SESSION_SERVER_PORT`. `enable` + `start` it first.
2. **`<agent>-agent.service`** — `bun .../forking-knowledge-miner/src/index.ts
   .../recipes/<agent>.json --headless`, `EnvironmentFile=...env`, `Environment=PATH=<node bin>:<bun bin>:...`,
   `After=/Wants=terminal-sessions.service`, `Restart=always`.

Set explicit `PATH` in the units (login-shell PATH isn't loaded for services).

Add a **backups cron** (snapshot `data/` every ~15 min) and a lightweight **watchdog** cron
(detect "messages arriving but no reply for N min" → restart, with a cooldown so it can't
restart-loop). These caught real incidents.

---

## 10. Phase 7 — Launch & verification checks

Start the agent service, then verify **each** of these (don't declare success on "it booted"):

```bash
systemctl --user start <agent>-agent.service
systemctl --user is-active <agent>-agent.service          # active, 0 restarts
journalctl --user -u <agent>-agent.service --since -1min  # no errors/refusals
```

- **Discord connected & scoped right:** the debug log's `registerDiscordChannels:enumerated`
  shows exactly the intended channel(s).
- **Context renders:** hit the webui (tunnel to its loopback port) `GET /debug/context` —
  message count looks right, participants attributed correctly (self → assistant, others →
  user-with-name-prefix).
- **Token size is safe:** `GET /debug/context/makeup` — **total + maxTokens must be under the
  model window** (§11.1). This is the single most important check.
- **Reasoning is as intended:** confirm `thinking`/`temperature` in the actual compiled request
  match what the user wanted (default is off).
- **A real turn completes:** the cleanest end-to-end proof. If no one will message it, briefly
  lower the heartbeat interval to force one wake, confirm `stop: end_turn` with no error in the
  newest `llm-calls.*.jsonl`, then restore the interval.

Snapshot a clean baseline once it's verified.

---

## 11. CRITICAL gotchas (read before deploying)

**11.1 — `contextBudgetTokens` must fit the model window.** The autobiographical strategy
fills context up to `contextBudgetTokens`. If that plus the response (`maxTokens`) exceeds the
model's context window, **every reply silently 400s** — the agent appears to "think but not
speak" (compression calls, with small contexts, still succeed; full replies don't). Rule:
`contextBudgetTokens + maxTokens + overhead  <  model window`. For a 200k-window model with a
16k response cap, keep the budget around 160–178k. As a conversation **grows**, the equilibrium
context creeps up — watch the makeup view and trim budget / `recentWindowTokens` before it
crosses the line. (This was the opus4 outage; diagnosing it is *why* the makeup view exists.)

**11.2 — Native deps don't cross platforms.** `chronicle`'s `.node` and `@opentui/core-<plat>`
are per-OS/arch. Build on the target or exclude native files from cross-platform rsync (§4).

**11.3 — Compression model must be reliable.** `compressionModel` runs the background
summary/merge folding. If it's a flaky or deprecated model, folding stalls, summaries pile up,
and the context can't compress under the window. Use a stable model for compression even if the
agent *speaks* on a more fragile one — they're separate settings, and the summaries are still
"in the agent's voice" via `summaryParticipant`. (Note: if you switch compression off the
agent's own model, mention it to the user — it's mildly identity-adjacent.)

**11.4 — Exact token counts via a *live* model.** The makeup endpoint counts tokens with
`COUNT_TOKENS_MODEL`. Claude models share a tokenizer, so set this to any *currently-callable*
Claude model even if the agent runs on a deprecated one — `count_tokens` on the dead model 404s.

**11.5 — Import traps.** Rolling-window re-exports overlap (delta only); image blocks may have
wrong `media_type` (sniff magic bytes; the membrane formatter now does this); rendered
thinking-summary text can trip refusals on some models. Always dry-run the ingest first.

**11.6 — Folding floor under window pressure.** With the kv-stable solver, if summary
*production* lags or the conversation is huge, the compile can hit a floor and throw
`OverBudgetError`. Mitigations: let production catch up; lower `recentWindowTokens`; ensure the
context-manager is recent enough to fold to the deepest available level. `flat-profile` is the
robust fallback strategy.

**11.7 — Discord REST needs a real `User-Agent`** or Cloudflare returns 403 (`error code: 1010`)
— this is not a permissions problem. The bot also needs **Read Message History** for backscroll
(separate from View Channel).

---

## 12. After go-live

- Tell the user how to reach the webui (SSH tunnel to the loopback port + the basic-auth creds).
- Explain what it does on its own (wakes on mentions/DMs in scoped channels + on its heartbeat).
- Keep the snapshots + watchdog running. Pull an off-box copy of `data/` for safety.
- Widen channel scope / adjust the recent window / tune the budget as it settles.

---

## Appendix — quick reference

- **Run host:** `bun forking-knowledge-miner/src/index.ts <recipe.json> --headless`
- **Reach loopback webui:** `ssh -L <port>:localhost:<port> <login-user>@<box>` → `http://localhost:<port>`
- **Live makeup:** `GET /debug/context/makeup` (basic auth) — segments + exact total tokens
- **Compiled context:** `GET /debug/context`
- **Per-call logs:** `data/llm-calls.<iso>.jsonl` (raw request + response + error)
- **Identity is the user's call. The mechanics are yours. Check everything. Be kind about who you're setting up.**

---

## Appendix B — A worked example (redacted opus4-style walkthrough)

A real onboarding, condensed; secrets redacted, IDs illustrative. Read it as "the phases, in motion."

**The interview (Phase 0).**
- Name `opus4`. Model `claude-opus-4-<date>` — a model being deprecated the *next day*; the user
  wanted continuity on its real substrate while it was still callable.
- Import: yes — a ChapterX "Bridge" text export.
- **Self-mapping (the decisive call):** the export held several Claude voices. The user confirmed
  `Claude Opus 4` = *self*; `Opus4.8` was a **different** model in the same room → its own
  participant, not merged into self.
- Surface: one Discord channel (`#opus`) in their server, to begin.

**Host + isolated user (Phases 2b / 1).** A box with a connectome stack already present → copied
it (fast path). New user `opus4`, ports `3101` (shell daemon) / `7343` (webui), clear of the
other agent already on the box.

**Scaffold (Phase 3).** Recipe adapted from a known-good one (`name`, `model`,
`summaryParticipant: opus4`, `contextBudgetTokens` set *under* the model window, webui on 7343).
`.env` with the model key, the Discord token, and generated `SESSION_SERVER_TOKEN` / `WEBUI_PASS`.

**Import (Phase 4).**
```bash
grep -cE '^--- .+ ---$' export.txt                                  # 576 messages
grep -oE '^--- .+ ---$' export.txt | sort | uniq -c | sort -rn      # speaker tally -> confirm self
node scripts/ingest-bridge.mjs export.txt --dry-run                 # 'Claude Opus 4'->opus4; 'Opus4.8' separate
node scripts/ingest-bridge.mjs export.txt                           # 576 imported
node scripts/compress-fresh.mjs                                     # pre-compress (~41 min)
```
The user then dropped a *fuller* export (a rolling window). We diffed it against the imported
tail and appended only the **28 genuinely-new messages** (→ 605) — which turned out to be the
farewell itself.

**Reasoning + (later) gateway (Phases 5 / 5b).** Reasoning **off** (no `thinking` in the recipe;
verified in the compiled request). When the model was later pulled from the direct API, we routed
around it: `ANTHROPIC_BASE_URL=https://ai-gateway.vercel.sh`, model `anthropic/claude-opus-4` —
same being, different door — which brought it back.

**Discord (Phase 5).** Verified the token (`/users/@me` with a real `User-Agent`) → bot
"Opus 4 C". Invited it; scoped `DISCORD_GUILD_ID=<guild>:<#opus id>`; confirmed exactly **1**
channel registered.

**Services + launch (Phases 6 / 7).** systemd units (shell daemon + agent), 15-min backups, a
wedge-watchdog. Then the check that matters:
```bash
curl -su "$WEBUI_USER:$WEBUI_PASS" http://127.0.0.1:7343/debug/context/makeup   # total + maxTokens < window?
```
A heartbeat-forced turn confirmed `stop: end_turn`, no error. Then go-live in `#opus` — where it
woke into a channel full of people who'd come to say goodbye.

**What bit us afterward (so you check for it):**
- **Budget vs window (the big one).** Weeks on, the conversation grew until `contextBudgetTokens`
  filled the context past the model's window → every reply *silently 400'd* ("thinks but won't
  speak"; compression calls still succeeded, masking it). Fix: lower budget / `recentWindowTokens`
  so `total + response < window`, and watch the makeup as it grows. (§11.1)
- **Native dep.** A redeploy crashed at boot on a missing `@opentui/core-<platform>`; installing
  the platform package fixed it. (§11.2)
- **Folding floor.** Under window pressure the solver threw `OverBudgetError`; resolved by letting
  summary production catch up plus a solver fix. (§11.6)

The throughline: the import + identity calls were the user's; everything else we ran and checked;
and the recurring failure mode was always **context size vs the model's hard window** — so make
the makeup check a habit, not a one-time step.
