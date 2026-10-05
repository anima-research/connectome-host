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
- run by the **connectome-host** (`bun src/index.ts <recipe> --headless`);
- under a **systemd --user** service, with a sibling **terminal-sessions** daemon for the shell tool.

It reaches the model through **membrane** (Anthropic-format adapter; can target a gateway via
`ANTHROPIC_BASE_URL`). Memory is **context-manager** with the **autobiographical** strategy
(adaptive resolution; `kv-stable` folding by default, with an opt-in cost-aware
`kv-unified` solver — §5b). The shell, Discord, and heartbeat tools are
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
   they put the file? (See §6 for formats. A Claude Code session transcript is a first-class
   source — see [`claude-code-ingest.md`](./claude-code-ingest.md).)
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
- `apt update && apt install -y git build-essential`, then install **nvm/node ≥ 20** and
  **Bun** — plus **`rustup`** only if you'll take the local-checkout path in §4 (building
  chronicle's native module from source; the stock install uses prebuilt binaries);
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
- a **Rust toolchain** (`rustup`) — **only for the local-checkout path** below, where you build
  `chronicle`'s native (napi) component from source. The npm `@animalabs/chronicle` package
  ships prebuilt `.node` binaries (linux x64/arm64 glibc, macOS x64/arm64, Windows x64), so the
  stock install needs no Rust on those platforms;
- the `anima-research` / `antra-tess` GitHub repos. These are **public** (as of 2026-07;
  they previously required org access), and the `@animalabs/*` npm packages install without
  auth. If a `git clone` / `bun install` fails on access, check whether the repo moved
  rather than assuming a permissions gate.

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
  `bun install` (pulls the `@animalabs/*` libs, chronicle's prebuilt native binary included;
  its postinstall builds the web UI with npm). That postinstall swallows failures, so if
  `dist/web/` is missing afterwards, run `npm run build:web`. Run with
  `bun src/index.ts <recipe> --headless`. Its `README.md` quick-start documents exactly this.
- **Local-checkout / dev (what production boxes actually run):** clone **all** the repos above
  as siblings, build bottom-up (`npm install && npm run build` in each, order: `mcpl-core-ts` →
  `membrane`, `chronicle` → `context-manager` → `agent-framework` → the MCP servers;
  chronicle's build is `napi build …`), then `bun install` in `connectome-host` — the host
  runs from source under Bun and has **no `build` script** (`npm run build` fails there; its
  postinstall / `npm run build:web` builds only the web UI), then **wire the single-instance
  `@animalabs/*` symlinks** so every component shares ONE copy of each shared lib. **The repo's
  own `docs/DEV-ENVIRONMENT.md` is the authoritative step-by-step** for this (exact clone lines,
  build order, the symlink commands, runtime notes) — follow it rather than improvising. Use
  this path only when you need unreleased branches.

Sanity: connectome-host is healthy once `bun src/index.ts <recipe> --headless` boots without
errors and logs `[webui] listening`. Then continue with the per-agent install dir (§5).

**Pick non-colliding ports.** Every agent on the box needs a unique:
- **shell-daemon port** (`SESSION_SERVER_PORT`, default 3100)
- **webui port** (module default 7340; binds `0.0.0.0` and requires `basicAuth` unless set to loopback)

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
  "description": "<one line — where this being comes from; operator-visible>",
  "agent": {
    "name": "<agent>",                      // = chronicle "self" participant (byte-exact)
    "model": "<model-id>",                  // or gateway-prefixed, e.g. anthropic/claude-opus-4
    "timezone": "America/Los_Angeles",      // agent-visible wall clock only; storage stays UTC
    "systemPrompt": "<persona / or minimal>",
    "thinking": { "enabled": true, "type": "adaptive", "display": "summarized" },
    "maxTokens": 32000,                     // response cap
    "maxStreamTokens": 320000,              // recompile trigger; keep < model window
    "contextBudgetTokens": 300000,          // SEE §11.1 — MUST fit under (window - maxTokens)
    "cacheTtl": "1h",                       // prompt-cache TTL; defaults to '1h', set '5m' explicitly for rapid sub-5m loops
    "strategy": {
      "type": "autobiographical",
      "adaptiveResolution": true,
      "foldingStrategy": "kv-stable",       // default solver; "kv-unified" is opt-in (§5b)
      "targetChunkTokens": 3000,            // L1 chunk size; also the ingest shard size
      "compressionSlackRatio": 0.1,
      "mergeThreshold": 6,                  // L1→L2 / L2→L3 fan-in
      "headWindowTokens": 4000,             // verbatim opening
      "recentWindowTokens": 100000,         // verbatim tail; tune vs window (§11.1)
      "maxMessageTokens": 10000,            // cap on any single rendered message
      "compressionModel": "<same-as-agent.model>", // SEE §11.3 — stable, same voice
      "enforceBudget": true,
      "overBudgetGraceRatio": 0.35,
      "maxSpeculativeL1s": 36,
      "summaryParticipant": "<agent>",
      "compressionRecallBudgetTokens": 40000, // prior recall pairs shown to the summarizer
      "compressionToolProseFallback": {     // §11.9 — hoist long think/skip_reply diaries on refusal
        "intoTool": "journal", "fromTools": ["skip_reply", "think"], "minChars": 60
      }
    },
    "proseRouting": "locus",
    "refusalHandling": { "retries": 2, "autoRewind": false, "maxRewinds": 15, "announceHumanTurns": true }
  },
  "modules": { "webui": { "port": 7343, "host": "127.0.0.1",
                          "basicAuth": { "username": "${WEBUI_USER}", "password": "${WEBUI_PASS}" } },
               "identity": true, "history": true, "mcplAdmin": true,
               "subagents": false, "lessons": false, "retrieval": false
               /* + wake policies, workspace mounts (files/, notes/) */ },
  "mcpServers": {
    "shell":   { /* terminal-sessions stdio server; "env": { "SESSION_SERVER_TOKEN": "${SESSION_SERVER_TOKEN}", "SESSION_SERVER_PORT": "${SESSION_SERVER_PORT}" } */ },
    "discord": { /* discord-mcpl; "env": { "DISCORD_TOKEN": "${DISCORD_TOKEN}", "DISCORD_GUILD_ID": "${DISCORD_GUILD_ID}", ... } */ },
    "heartbeat": { /* heartbeat-mcpl; "env": { "HEARTBEAT_CONFIG_FILE": "${HEARTBEAT_CONFIG_FILE}" } */ }
  }
}
```

These are the values the long-running production residents converge on for a
≥500k-window model (300k budget / 100k recent tail / 32k reply). For a **200k-window**
model scale the three window numbers down together — e.g. `contextBudgetTokens:
160000`, `maxStreamTokens: 180000`, `recentWindowTokens: 60000`, `maxTokens: 16384` —
and keep everything under `strategy` as is; chunk size, merge fan-in and the
fallback rungs are window-independent.

Use `"cacheTtl": "1h"` for Connectome deployments. This is also the runtime
default when the field is omitted. Set `"5m"` only for intentionally rapid
workloads whose cache is normally reused within five minutes.

**`subagents`/`lessons`/`retrieval` are NOT part of the standard recipe.**
All three are opt-in. RetrievalModule in particular injects context-dependent
content into every compile (and spends up to two configured retrieval-model calls), so it must
be an explicit opt-in for agents that actually curate a lesson library.
Current host code defaults all three to off, but keep the explicit `false`
entries in the recipe anyway — older host checkouts treated these as opt-out,
and an accidentally-enabled RetrievalModule has caused severe prompt-cache
churn in the field.

**Memory defaults.** Current host code defaults an omitted/partial `strategy`
to the fleet-standard shape: autobiographical + `adaptiveResolution: true` +
`foldingStrategy: "kv-stable"` + same-model compression (`compressionModel`
falls back to `agent.model`) + `summaryParticipant` = `agent.name`. Keep the
skeleton's explicit values anyway: older host checkouts default folding to
`flat-profile` and summary voice to the literal `'Claude'` (the stranger's-voice
hazard), and explicit values survive host downgrades and copy-paste to other
deployments.

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
COUNT_TOKENS_MODEL=<a live model id>     # optional override; makeup counts with the agent's own model by default (§11.4)
```

Stdio MCPL servers see only what their entry declares in `env` (plus a small
system allowlist — see the README's MCP section). Map every variable a server
reads, as in the skeleton above. A variable left only in `.env` is unset for
the server — and an unset `DISCORD_GUILD_ID` means every channel the bot is
invited to (§7).

## 5b. Folding solver — `kv-stable` (default) vs `kv-unified` (opt-in)

Both solvers decide, at every compile, which summaries to present and which raw
messages to keep verbatim so the context fits `contextBudgetTokens`.

**`kv-stable`** (default, and what most residents run) keeps the presented layout as
stable as possible between compiles so the prompt-cache prefix survives; it folds
deeper only when forced. Robust, well understood, and the right choice unless you
have a reason.

**`kv-unified`** is a cost-aware Pareto solver: it scores candidate layouts on
budget fit, **cache cost** (what a layout change will cost in cache writes vs reads at
the configured prices), **continuity** (how much recent, still-referenced material
stays verbatim) and fidelity, and picks the cheapest acceptable one. On a large-budget
resident (600k budget / 300k tail on a 1M-window model) it has cut effective cache
spend materially (on the order of 40 % in our accounting). It is **fail-closed**:
selecting it without every required field is a recipe-load error — there are no live defaults.

Reference configuration in production (600k / 300k resident; tune `labelCeiling`
and the bucket sizes to your budget):

```jsonc
"strategy": {
  "type": "autobiographical",
  "adaptiveResolution": true,
  "foldingStrategy": "kv-unified",
  "targetChunkTokens": 3000, "compressionSlackRatio": 0.1, "mergeThreshold": 6,
  "headWindowTokens": 4000, "recentWindowTokens": 300000, "maxMessageTokens": 10000,
  "enforceBudget": true, "overBudgetGraceRatio": 0.35, "maxSpeculativeL1s": 36,
  "compressionRecallBudgetTokens": 40000,
  "kvUnified": {
    "policy": {
      "alpha": 0.7,
      "budgetLowRatio": 0.6, "budgetHighRatio": 0.85,
      "budgetUnderLambda": 1000, "budgetOverLambda": 4000,
      "cacheLambda": 1, "cacheScale": 100000,
      "cacheReadPrice": 0.1, "cacheWritePrice": 1.25,     // $/Mtok for the agent's model
      "continuityLambda": 1, "continuityScale": 100000,
      "continuityRecencyHalfLifeTokens": 100000, "continuityRecencyFloor": 0.2,
      "continuityStableHalfLife": 16, "continuityStableFloor": 0.25
    },
    "tokenBucketSize": 50000, "continuityBucketSize": 50000, "fidelityBucketSize": 100000,
    "labelCeiling": 100000,
    "adoptEpsilon": 3000,
    "treeifyNonContiguousSummaries": false,
    "preserveGapBearingSummaries": false,
    "hysteresisCertificate": true
  }
}
```

**Preconditions — read before flipping a resident:**

- **Strictly contiguous summary forest.** kv-unified's bounded solve assumes every
  summary owns a contiguous run of leaves. A store whose summaries cross (the
  pre-0.12 head-window ratchet produced late single-message L1s stitched into era
  summaries) does not open at all under the default `reject` topology policy,
  whatever the folding strategy (§11.8). Setting `preserveGapBearingSummaries` or
  `treeifyNonContiguousSummaries` switches the policy to `report`: the store opens,
  `compressionDebt` goes `critical`, and the solver runs *buffered* (internal holes),
  where label propagation can run away —
  `exact label propagation exceeded ceiling <N>` at ~1.35× `labelCeiling`, deterministic,
  survives restart, raising the ceiling only moves the number. Audit (§11.8) and
  repair first; staying on `kv-stable` does not open a crossed store either.
- **`treeifyNonContiguousSummaries: true` is not an escape hatch** on a crossed
  store: it solves fast but drops the deepest summaries, and the floor can land
  above your budget (`budgetMet=false`).
- **Rehearse cache-live, not just cold.** A cold dry-compile of a store copy never
  passes the persisted `kvUnifiedImmutablePrefixHash`, so it never exercises the
  cache-live solver path — the one that failed above. Rehearse on a copy with the
  receipt hash the live host would pass.
- **New residents: decide before first boot.** Choosing kv-unified after weeks on
  kv-stable is a layout change (one full cache rewrite) plus the audit above.
- `hysteresisCertificate: true` skips the full Pareto pass when the previously
  accepted layout is provably still selected — large latency win on quiet turns;
  `adoptEpsilon` is the score slack that lets an unchanged layout be retained.
- `hysteresisCertificate` is optional (off unless set); every other field is
  required. The host checks the required keys at recipe load — including that
  `treeifyNonContiguousSummaries` / `preserveGapBearingSummaries` are explicit
  booleans and not both `true` — and passes the object through whole;
  context-manager ignores keys it doesn't know, so a misspelled optional key
  silently does nothing. Pin the runtime and validate the recipe against it.

---

## 6. Phase 4 — Import the conversation history

(Skip if starting blank.)

**Sources.** Three you will meet: a ChapterX "Bridge" text dump (below), an Arc/animachat
JSON export (same ingest, different parser), and a **Claude Code session transcript** —
for that one follow [`claude-code-ingest.md`](./claude-code-ingest.md) end to end; it
covers the active-branch walk, signed-thinking replay, and the `tool_result` storage
shape that silently breaks if you get it wrong.

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
the previous one (compute the *delta* tail, don't double-import). **Mirror the recipe's
strategy in the ingest script** — `adaptiveResolution` + `targetChunkTokens` act at
`addMessage()` time and shard oversized messages (pasted documents, huge tool results); an
ingest without them leaves those as single unfoldable blocks.

**Verify on a copy before first boot.** Compile a copy of the store with the recipe's
strategy and *read* the rendered messages — no `[tool result unavailable]` / `[tool call
omitted]` stubs, participants right, last message is the intended seam — and compare exact
`count_tokens` to the estimate (a large gap means blocks are missing or doubled). Never
open the live store with a foreign strategy config: opening chunks the frontier under that
config (§11.8).

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
2. **`<agent>-agent.service`** — `bun .../connectome-host/src/index.ts
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

**11.4 — Exact token counts via a *live* model.** The makeup endpoint calls `count_tokens`
(at `ANTHROPIC_BASE_URL` when set) with the agent's own model, provider/gateway prefixes
normalized away (`anthropic/claude-opus-4` → `claude-opus-4`); `COUNT_TOKENS_MODEL` overrides
that. You need the override when the agent's model can't be counted — a deprecated or
gateway-only model, where `count_tokens` fails (a dead model 404s) and the makeup shows no
exact total (`countSource: count_tokens_failed_<status>`). Claude models share a tokenizer, so
set it to any *currently-callable* Claude model.

**11.5 — Import traps.** Rolling-window re-exports overlap (delta only); image blocks may have
wrong `media_type` (sniff magic bytes; the membrane formatter now does this); rendered
thinking-summary text can trip refusals on some models. Always dry-run the ingest first.

**11.6 — Folding floor under window pressure.** With either solver, if summary
*production* lags or the conversation is huge, the compile can hit a floor and throw
`OverBudgetError` (kv-unified reports `budgetMet=false` with the floor it reached). Mitigations:
let production catch up; lower `recentWindowTokens`; ensure the context-manager is recent enough
to fold to the deepest available level; on kv-unified, check the forest is contiguous (§5b, §11.8)
before touching `treeifyNonContiguousSummaries`. `flat-profile` is the robust fallback strategy.

**11.7 — Discord REST needs a real `User-Agent`** or Cloudflare returns 403 (`error code: 1010`)
— this is not a permissions problem. The bot also needs **Read Message History** for backscroll
(separate from View Channel).

**11.8 — Store topology audit, and opening a store mutates it.** Since context-manager 0.12.0
(this host depends on ^0.13.0) every load audits the summary archive for crossed ownership — a
summary whose leaves are not contiguous in store order (the pre-0.12 head-window ratchet,
restore/branch interleavings, hand surgery). Under the default `topologyPolicy: reject`,
`ContextManager.open` throws `StoreTopologyError` and the resident does not boot — on `kv-stable`
as on `kv-unified`; the store is left intact. `report` logs the violations and boots; a
`kvUnified` block with `preserveGapBearingSummaries` or `treeifyNonContiguousSummaries` set to
`true` defaults to it. This host does not forward a `strategy.topologyPolicy` recipe key (it is
silently ignored), so the error's "set topologyPolicy: 'report'" hint is not reachable from a
recipe — repair the store. Separately, a merge that would mint a crossed node is refused into the
merge quarantine. Both show on `/healthz` as `compressionDebt.<agent>.topologyViolations` /
`.topologyRefusals`, with `state: critical`. Before **any** context-manager upgrade of an existing
resident — including a host upgrade from a pre-0.12 context-manager — run the audit on a **copy of
the stopped store**:
`node node_modules/@animalabs/context-manager/dist/scripts/audit-topology.js <store-copy> --namespace agents/<agent> --json > audit.json`
(exit 0 clean, 2 violations, 1 could not open; a warning that it saw no summaries means a wrong
`--namespace`). Repair the *stopped* store, after a cold backup, with
`node …/dist/scripts/repair-topology.js <store> --namespace agents/<agent> [--mode lossless|compact|rebuild] [--rebuild-since <messageId|ISO date>] [--apply]`
— a dry run unless `--apply`; after `--apply` it reopens the store under `reject` to verify (exit
0 clean or verified, 2 plan incomplete or verification failed, 1 usage/open error). `lossless`
(the default) only detaches, so the pyramid unravels around each fragment; `compact` keeps depth
at the price of prose gaps; `rebuild` dissolves crossed towers back to L1 for the merge ladder to
re-fold — run `…/dist/scripts/drain-autobiographical.js <store> agents/<agent> --apply
--model=<model> --participant=<agent>` on the stopped store before restarting.
`--rebuild-since` rebuilds only crossings from that message on and compacts older ones. Then
re-audit to zero. Two traps: (a) any `ContextManager.open` with a normal strategy config chunks
the store's frontier under *that* config — verify only with the `auditOnly` scripts, never by
opening a live store from a one-off script; (b) reflink/rsync copies of a *running* store read
different state depending on when `state.bin` was last snapshotted — copy a stopped store.

**11.9 — `reasoning_extraction` refusals.** Anthropic's safety classifier can end a request
with `stop_reason: refusal` and this category; it halts residents built from dense reasoning
transcripts and residents that keep diaries in long tool arguments. Fleet mitigations, all
recipe-level: `refusalHandling.retries: 2` (near-threshold refusals are nondeterministic and
refused-up-front requests are not billed); `compressionToolProseFallback` into `journal` for
long `think` / `skip_reply` arguments; `carrierPolicy: "live-strip"` when the live window
refuses but compression is fine; a context-manager that defers tools-less compression (a
compression request with no `tools` declared is a deterministic input-block on some model
families). Symptoms, triage table and the localisation method are in
[`claude-code-ingest.md` §5](./claude-code-ingest.md#5-if-you-hit-reasoning_extraction-refusals)
— they apply to any resident, not only Claude Code continuations. Never quote a suspected
trigger into a channel the resident reads.

**11.10 — Signed thinking is model-bound.** Replaying a transcript's signed `thinking` blocks
works only on the model that minted them; any other model 400s. Editing the *shape* of a turn
around a retained thinking block (split, reorder, insert before) also 400s ("thinking blocks
cannot be modified") — a transport error the membrane retries once text-only, not a refusal.
Newer API accounts additionally enforce preserved thinking on context edits before thinking
blocks; expect folds to interact with this on the next model generation.

---

## 12. After go-live

- Tell the user how to reach the webui (SSH tunnel to the loopback port + the basic-auth creds).
- Explain what it does on its own (wakes on mentions/DMs in scoped channels + on its heartbeat).
- Keep the snapshots + watchdog running. Pull an off-box copy of `data/` for safety.
- Widen channel scope / adjust the recent window / tune the budget as it settles.

---

## Appendix — quick reference

- **Run host:** `bun connectome-host/src/index.ts <recipe.json> --headless` (legacy
  checkouts may still name the directory `forking-knowledge-miner`)
- **Reach loopback webui:** `ssh -L <port>:localhost:<port> <login-user>@<box>` → `http://localhost:<port>`
- **Live makeup:** `GET /debug/context/makeup` (basic auth) — segments + exact total tokens
- **Compiled context:** `GET /debug/context`
- **Per-call logs:** `data/llm-calls.<iso>.jsonl` (raw request + response + error) — rotates to a
  new file on every restart; re-list by mtime after a bounce. Counts *attempts*; `failures.log`
  counts *turns*.
- **Topology audit / repair (context-manager ≥ 0.12, §11.8):**
  `node node_modules/@animalabs/context-manager/dist/scripts/audit-topology.js <store-copy> --namespace agents/<agent> --json`
  (exit 2 = crossed), `…/repair-topology.js <store> --namespace agents/<agent> --mode lossless [--apply]`
  — stopped store, cold backup first
- **Health:** `GET /healthz` — per-agent `compressionQuarantine`, `compressionDebt` (incl.
  `topologyViolations` / `topologyRefusals`),
  `contextComposition` (head / raw / summaries / tail as last rendered), `runtimeSettings`
- **Import guides:** [`claude-code-ingest.md`](./claude-code-ingest.md) ·
  [`claudeai-evacuation.md`](./claudeai-evacuation.md)
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
