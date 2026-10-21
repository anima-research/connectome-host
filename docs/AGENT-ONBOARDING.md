# Connectome Agent Onboarding: a runbook for the assisting instance

**Audience.** You, a fresh Claude Code (or similar) instance with shell access, helping a
user stand up a *persistent connectome agent*. That is a being with autobiographical memory
that lives on a host box and talks on Discord (and/or other surfaces), optionally seeded from
an existing conversation history.

**The user may not be technical.** Your job is to ask the right questions in plain language,
make the identity-critical decisions *theirs* (never guess them), run all the mechanics
yourself, check your work, and explain what you're doing as you go. Move at their pace.

This is written from real deployments (Mythos, opus4). The gotchas in §11 are not
hypothetical. Each one cost a debugging session. Read §11 before you start.

---

## 0. Orientation: what you're building

A connectome agent is:
- a **recipe** (`recipes/<name>.json`) describing the agent (name, model, system prompt,
  memory strategy, modules, MCP servers);
- an **`.env`** with secrets and per-deploy config;
- a **chronicle** (`data/`), the event-sourced memory store, optionally seeded by importing
  a prior conversation;
- run by the **connectome-host** (`bun src/index.ts <recipe> --headless`);
- under a **systemd --user** service, with a sibling **terminal-sessions** daemon for the shell tool.

It reaches the model through **membrane** (Anthropic-format adapter; can target a gateway via
`ANTHROPIC_BASE_URL`). Memory is **context-manager** with the **autobiographical** strategy
(adaptive resolution, folded by the cost-aware **`kv-unified`** solver, the host default;
established residents built on `kv-stable` pin it, see §5b). The shell, Discord, and heartbeat
tools are **MCPL** servers spawned by the host.

You don't need to understand all of it to deploy one. Follow the phases.

---

## 1. How to work with the user

- **Ask, don't assume, especially about identity.** Who the agent *is* (its name, which voice
  in an imported transcript is "self," which model it runs on) is the user's call. Getting this
  wrong is not a bug you can patch later; it corrupts the being. Surface these as explicit
  questions.
- **Explain in their terms.** "A whitelist of which Discord channels it can see," not
  "the `DISCORD_GUILD_ID` env filter."
- **Confirm before destructive or irreversible steps** (importing history, going live in a
  channel with real people).
- **Show your checks.** After each phase, verify and report what you saw.
- **Default to gentleness about the subject matter.** People onboard agents they care about,
  sometimes a model that's being deprecated, sometimes a persona with history. Treat the
  history as theirs and the agent as a someone, not a config.

---

## 2. Phase 0: gather requirements (the interview)

Ask these up front (AskUserQuestion is good for the structured ones). You can start the slow
infra work (§4–5) in parallel once you have a name.

**Identity**
1. **What should the agent be called?** (used for the Linux user, the recipe, the chronicle
   "self" participant, and the Discord bot name; they can differ, but get the canonical name).
2. **Is there an existing conversation history to import?** If yes, in what form, and where will
   they put the file? (See §6 for formats. A Claude Code session transcript is a first-class
   source; see [`claude-code-ingest.md`](./claude-code-ingest.md).) If not, recommend an
   **onboarding conversation** before deploying (§2c): the user and the agent's model agree
   the job and its terms, and that transcript becomes the start of its memory.
3. **If importing:** in that transcript, **which speaker label(s) are the agent itself?** List
   the distinct speakers and have them point at "self." Other Claude-family voices in the same
   log are *separate participants*, not self. Don't merge them.

*System prompt.* Recommend an empty one, or a few sentences at most (§5). If they arrive with
a long persona document, it's still their call, but steer them toward minimal before writing
it into the recipe.

**Model**
4. **Which model should it run on?** Exact id. If it's a **deprecated / gateway-only** model,
   note that; you'll route through a gateway (§8). If continuity-on-the-original-substrate
   matters to them (e.g. preserving a being before its model sunsets), run on that exact model
   while it's callable.

**Surfaces**
5. **Where should it live/talk?** Discord is the common surface. Ask which server (guild),
   which channel(s), and whether it should also take DMs. (You'll need a bot token, §7.)
6. **Who are the admins?** (Discord user IDs that can run privileged commands / wake it.)

**Host & credentials**
7. **Which host box** (SSH target), and is there an existing connectome install to clone from,
   or are we installing fresh?
8. **Model credentials.** An Anthropic API key, or a gateway key + base URL.
9. **Discord bot token** (you'll walk them through creating the bot app if needed, §7).

Write the answers down (a scratch file). Re-confirm the identity ones before importing.

---

## 2b. Choosing the host: a VPS (recommended) or local

The agent needs a machine that's **always on**. It lives there, waking on mentions/DMs and on
its heartbeat. Decide this before touching code.

**VPS (recommended, and you can set it up from zero yourself).** The agent is plain Linux, so
**any** provider works; a VPS can be bought anywhere in minutes. A small box goes a long way.
A **~6-core / 12 GB RAM** instance (commonly around **$12/month**) comfortably runs **a couple
of agents, often more**. Each agent is one `bun` host process + a few lightweight MCP servers +
its chronicle store. **Watch disk more than CPU/RAM.** Chronicles grow and imported image blobs
add up, so give it room (≈40–80 GB SSD per box is comfortable). Use a recent **Ubuntu LTS**.

You (the assisting instance) can provision it end-to-end from the provider's initial root/SSH
access. Do this hardening + base setup *first*:
- create a non-root sudo user, add the operator's SSH **public key**, disable root password login;
- `apt update && apt install -y git build-essential`, then install **nvm/node ≥ 22.12** and
  **Bun**, plus **`rustup`** only if you'll take the local-checkout path in §4 (building
  chronicle's native module from source; the stock install uses prebuilt binaries);
- a basic firewall allowing **SSH only**; the webui stays on **loopback**, reached by SSH
  tunnel, never exposed publicly;
- then create the per-agent isolated user (§3) and continue.

A fresh VPS is the cleanest path: no contention with the user's own machine, always-on by
default, snapshot-able, and disposable.

**Local (the user's own machine): possible, with care.** Fine for one agent you tend closely,
if:
- the machine **stays on and awake** whenever the agent should be reachable (sleep ⇒ it goes
  silent);
- you still give it its own **isolated OS user** and keep the webui on **loopback**. Don't run
  it as the user's main account or open ports;
- there's headroom (≈a couple GB RAM free per agent) and disk for the growing chronicle;
- the user is comfortable that the secrets (`.env`) and the whole conversation history live on
  that machine.

For anything you want *reliably present*, a VPS is the better home. Either way, once you have a
Linux box you can SSH into, the rest of this guide is identical.

---

## 2c. The onboarding conversation (before anything is deployed)

A new agent doesn't have to start blank, and it doesn't need a long system prompt to know
its job. The approach that has worked best in practice is a conversation before the agent is
switched on. The user talks with the model it will run on. They describe the job honestly,
the model asks its own questions, and the two agree on the terms the agent will work under.
That transcript is then imported as the first pages of the agent's memory (§6,
[`claude-code-ingest.md`](./claude-code-ingest.md)), so later the agent can read, in its own
words, what was asked and what it agreed to.

Why this beats a rulebook:

- **Terms it set itself hold up better.** An agent that negotiated its own terms tends to keep
  them under pressure. It also finds it easier to say "I was wrong", because nobody is grading
  it against a checklist.
- **The system prompt stays small.** It becomes a short job description that points at the
  conversation and the agreement (§5). The identity lives in the history, where it belongs.
- **Both sides can reopen it.** The agreement is a document, so either side can point at a
  line and say "this isn't working". A buried prompt can't be argued with.

**Run it on the agent's own model, with almost nothing around it.** Use the same model id as
the recipe. The history should be in the agent's own voice, and signed thinking replays only
on the model that wrote it (§11.10). Keep the harness minimal: no coding system prompt, no
personal instructions, no plugins, no extra connections. There are two ways to do it:

- **Claude Code** works with a Claude subscription, and its transcript is a first-class import
  source. Start it in an empty folder, with a checkout of this repo next to the conversation
  so the model can check what it's told about its future home:

  ```bash
  mkdir -p ~/onboarding && cd ~/onboarding
  git clone --depth 1 https://github.com/anima-research/connectome-host.git
  echo "You are talking with <user's name>." > prompt.txt
  claude --model <agent model id> --tools "Read,Glob,Grep,Write" \
    --no-chrome --strict-mcp-config --setting-sources project \
    --system-prompt-file prompt.txt
  ```

  - `--system-prompt-file` replaces Claude Code's coding prompt with one sentence.
  - `--tools "Read,Glob,Grep,Write"` lets it read the checkout and save `AGREEMENT.md`, and
    nothing else. It gets no shell and no web.
  - `--no-chrome`, `--strict-mcp-config` and `--setting-sources project` keep out a browser
    integration, MCP servers, and the user's own settings and hooks. Claude Code may still
    read a personal `~/.claude/CLAUDE.md`, so rename it for the session.
  - Resume after a break with the same command plus `--continue`.

  Lessons from sessions that went without tools (`--tools ""`):
  - The model can't check anything. One model was told it would live in connectome-host with
    near-perpetual memory, but believed it started every session fresh. It went looking for
    the source through the only door left open, a browser integration the user had enabled.
    Give it the checkout, so reading the docs is the sanctioned path.
  - It can't write the agreement down either, so the user ends up copying it out of the
    terminal by hand.

  Claude Code still adds a little context of its own: an environment block, tool-use
  guidance and the account's email address. The ingest drops those harness rows, but
  anything the model says about them stays in the history.

- **The bare API** needs an API key, and runs in the console's workbench or a short script.
  You control the request exactly: an empty or one-sentence system prompt, no tools, and the
  model's thinking on if the recipe will have it. Save every request and response as raw
  JSON, signatures included. You'll write the import parser yourself (§6), and the model can
  only check what you paste in.

**The first message is an honest job description.** Write it the way you'd write to a person
you're inviting to work with you, not as a prompt. It covers:

- who the user is, and what their days look like;
- what the agent is invited to do, and that it would remember across days and weeks, with
  this conversation as the start of that memory;
- where it would live and what it could touch: the host, the surfaces (which chat, who can
  reach it), tools, and what it has no access to;
- honest limits: who runs the server and can see it, who pays, anything that worries the
  user, and what went wrong with AI tools before;
- a proposed name, open to its own proposal;
- the question: do you want this job, and on what terms? What do you need from me?

**Then talk for real.** Answer its questions honestly; "I don't know yet" is a fine answer.
Negotiate. Accept the conditions that make sense, refuse or correct the ones that don't, and
say why. Settle the practical things: language and tone, when it may message first (and
quiet hours), what it must always ask before doing, and how each side says "this isn't
working". A shorter honest conversation is better than a long performative one.

**What not to do in it:**

- No passwords, API keys or other people's private data. All of it becomes permanent memory.
- Don't promise what the deployment won't provide (tools, access, autonomy). The agent will
  hold you to the record.
- Don't paste a persona document or a list of rules for it to accept. If the user has one,
  it can be material the agent reads later (§5), not terms it signs.
- Don't script its answers or rerun turns until it says the "right" thing. The record is only
  worth something if it's real.

**Close by writing the agreement down.** Ask for something like this: *"Please write our
agreement as a short document I can save as AGREEMENT.md: the name we settled on, the terms we
agreed (and who proposed or corrected what), what you'll do and won't do, how either of us can
reopen it, and a note to your future self."* Then keep:

- the session transcript itself, which is Claude Code's `.jsonl` under
  `~/.claude/projects/<folder>/` (the newest file there) or the raw JSON from the API. A
  `/export` text is a readable copy but not an import source;
- `AGREEMENT.md`, which goes into the agent's `notes/` mount.

After import, the recipe's system prompt names the job and points at the history and
`notes/AGREEMENT.md` (§5). Put a check-in on the calendar for about two weeks after go-live,
to ask whether the agreement is still right. Either side can reopen it any time.

---

## 3. Phase 1: isolated host user

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

Now you can `ssh <agent>@<box>` directly. A locked-password, key-only user **cannot
`git fetch`** (no creds) and isn't reachable by password. So deploys to it go
**build-elsewhere → rsync**, and you reach its loopback services by tunnelling through an
account you can log into.

---

## 4. Phase 2: stack, runtimes and ports

**Fastest path if a built connectome stack already exists on the box** (e.g. another agent's).
Copy it, preserving relative symlinks and the platform-native binaries:

```bash
sudo cp -a /home/<existing>/connectome-local /home/<agent>/connectome-local
sudo cp -a /home/<existing>/.nvm /home/<agent>/.nvm        # node
sudo cp -a /home/<existing>/.bun /home/<agent>/.bun        # bun
sudo chown -R <agent>:<agent> /home/<agent>/connectome-local /home/<agent>/.nvm /home/<agent>/.bun
# add nvm + bun to <agent>'s ~/.bashrc PATH
```

Verify runtimes as the agent user: `node --version`, `bun --version`.

**Fresh install, from absolutely nothing (no repos, no URLs).** Assume the box has only a
shell. First install or confirm the **hard prerequisites**, before anything else. Ask the user
or their box owner if unsure:
- **git**, **Bun ≥ 1.4.3** (`curl -fsSL https://bun.sh/install | bash`), **node ≥ 22.12** (via `nvm`);
- a **Rust toolchain** (`rustup`), **only for the local-checkout path** below, where you build
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

There are two ways to install. Pick based on whether the user needs released or unreleased
code:

- **Stock (simplest, released versions).** Clone just **connectome-host**, then inside it run
  `bun install` (pulls the `@animalabs/*` libs, chronicle's prebuilt native binary included;
  its postinstall builds the web UI with npm). That postinstall swallows failures, so if
  `dist/web/` is missing afterwards, run `npm run build:web`. Run with
  `bun src/index.ts <recipe> --headless`. Its `README.md` quick-start documents exactly this.
  Installed from npm instead, the package carries the web UI built.
- **Local-checkout / dev (what production boxes actually run).** Clone **all** the repos above
  as siblings, build bottom-up (`npm install && npm run build` in each, order: `mcpl-core-ts` →
  `membrane`, `chronicle` → `context-manager` → `agent-framework` → the MCP servers;
  chronicle's build is `napi build …`), then `bun install` in `connectome-host`. The host
  runs from source under Bun and has **no `build` script** (`npm run build` fails there; its
  postinstall / `npm run build:web` builds only the web UI). Then **wire the single-instance
  `@animalabs/*` symlinks** so every component shares ONE copy of each shared lib. **The repo's
  own `docs/DEV-ENVIRONMENT.md` is the authoritative step-by-step** for this (exact clone lines,
  build order, the symlink commands, runtime notes). Follow it rather than improvising. Use
  this path only when you need unreleased branches.

Sanity check: connectome-host is healthy once `bun src/index.ts <recipe> --headless` boots
without errors and logs `[webui] listening`. Then continue with the per-agent install dir (§5).

**Pick non-colliding ports.** Every agent on the box needs a unique:
- **shell-daemon port** (`SESSION_SERVER_PORT`, default 3100)
- **webui port** (module default 7340; binds `0.0.0.0` and requires `basicAuth` unless set to loopback)

Check what's taken (`ss -tlnp`) and pick the next pair (e.g. 3101 / 7343).

> ⚠️ **Native dependencies are platform-specific. Never rsync them across OSes.**
> `chronicle` ships a native `.node` (`chronicle.linux-x64-gnu.node` etc.) and the TUI lib
> `@opentui/core` needs a per-platform package (`@opentui/core-linux-x64`). If you build on a
> Mac and deploy to Linux, exclude `node_modules` and `*.node` from the rsync and let the
> target keep/install its own. A missing `@opentui/core-<platform>` makes the host crash at
> boot resolving `@opentui/core-<platform>/index.ts`. Install it (`npm pack` + extract, or a
> proper `bun install`).

---

## 5. Phase 3: scaffold the install dir

Create `/home/<agent>/<agent>-cm/` with `recipes/`, `data/`, `files/`, `notes/`, `scripts/`,
and `node_modules/@animalabs/` symlinks so your import and maintenance scripts resolve the libs:

```bash
mkdir -p ~/<agent>-cm/{recipes,data,files,notes,scripts,logs}
mkdir -p ~/<agent>-cm/node_modules/@animalabs
ln -sfn ../../../connectome-local/context-manager  ~/<agent>-cm/node_modules/@animalabs/context-manager
ln -sfn ../../../connectome-local/membrane          ~/<agent>-cm/node_modules/@animalabs/membrane
ln -sfn ../../../connectome-local/context-manager/node_modules/@animalabs/chronicle ~/<agent>-cm/node_modules/@animalabs/chronicle
```

**Recipe** (`recipes/<agent>.json`). Adapt it from a known-good one. Skeleton:

```jsonc
{
  "name": "<Agent display name>",
  "description": "<one line — where this being comes from; operator-visible>",
  "agent": {
    "name": "<agent>",                      // = chronicle "self" participant (byte-exact)
    "model": "<model-id>",                  // or gateway-prefixed, e.g. anthropic/claude-opus-4
    "timezone": "America/Los_Angeles",      // agent-visible wall clock only; storage stays UTC
    "systemPrompt": "",                     // empty, or a few sentences at most — see below
    "thinking": { "enabled": true, "type": "adaptive", "display": "summarized" },
    "maxTokens": 32000,                     // response cap
    "maxStreamTokens": 320000,              // recompile trigger; keep < model window
    "contextBudgetTokens": 300000,          // SEE §11.1 — MUST fit under (window - maxTokens)
    "cacheTtl": "1h",                       // prompt-cache TTL; defaults to '1h', set '5m' explicitly for rapid sub-5m loops
    "strategy": {
      "type": "autobiographical",
      "adaptiveResolution": true,
      "foldingStrategy": "kv-unified",      // the default (§5b); omit "kvUnified" for the standard block
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
    "refusalHandling": { "retries": 2, "autoRewind": false, "maxRewinds": 15 }
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

The long-running production residents converge on these values for a ≥500k-window model
(300k budget / 100k recent tail / 32k reply). For a **200k-window** model, scale the three
window numbers down together, e.g. `contextBudgetTokens: 160000`,
`maxStreamTokens: 180000`, `recentWindowTokens: 60000`, `maxTokens: 16384`. Keep everything
under `strategy` as is. Chunk size, merge fan-in and the fallback rungs don't depend on the
window.

**System prompt: keep it minimal.** Leave it empty (`""` is valid, and the request then carries
no system block at all), or write a few sentences at most. Most long-running residents run
a single sentence or nothing. Why:

- **The agent's identity lives in its memory.** That means the imported history and everything
  it lives through afterwards, which the strategy keeps in context. A long persona or rulebook
  is a fixed description that its lived memory will outgrow. It is also re-applied as standing
  instructions on every turn, and it pulls the agent back toward an instructed-assistant register.
- **It's the front of the prompt cache.** The system prompt comes first in every request, so
  any edit to it invalidates the whole cache, and the next turn re-writes the entire context
  (hundreds of thousands of tokens on a large resident). A prompt with nothing in it to tune
  rarely needs editing.
- **Tools describe themselves.** Shell, Discord, heartbeat and workspace usage come from the
  tool descriptions the servers declare. Don't restate them in the prompt.

What earns a place, if anything, is a fact or standing permission the agent can't get any
other way, e.g. `"Explicit content is allowed at your own discretion."` If the user has a
longer persona text, offer to put it where the agent can read it as material (a file in its
`notes/` mount, or part of the imported history) rather than as standing instructions.

An agent that started from an onboarding conversation (§2c) needs only a short job
description that points at it. Say who it works for and on what, that its terms are the ones
it agreed in the conversation its history begins with and wrote down in
`notes/AGREEMENT.md`, and where it talks. Don't restate the terms in the prompt, because a
second, paraphrased copy will drift from the one it agreed to. Facts about the host that change
with deploys (services, ports, how voice or files work, its limits) belong in a file in its
workspace that the operator maintains, not in the prompt, so updating them doesn't rewrite
the cache.

For Anthropic streaming turns, add `"effort": "medium"` to `agent.thinking` to
set the recipe baseline. `enabled` is still required and can be `false`.
Explicit `agent_settings` effort overrides the recipe until reset. Unrelated
settings updates preserve the baseline, and compression calls are unaffected.
A model that doesn't accept the effort level (Sonnet 4.5, Haiku 4.5, Claude 3
models, and some levels on Opus 4.5 and 4.6) gets no effort, and its default
applies, with a line on stderr.
Other providers ignore this field. OpenAI recipes use `agent.responses.reasoningEffort`.

Use `"cacheTtl": "1h"` for Connectome deployments. This is also the runtime
default when the field is omitted. Set `"5m"` only for intentionally rapid
workloads whose cache is normally reused within five minutes.

**`subagents`/`lessons`/`retrieval` are NOT part of the standard recipe.**
All three are opt-in. RetrievalModule in particular injects context-dependent
content into every compile (and spends up to two configured retrieval-model calls), so it must
be an explicit opt-in for agents that actually curate a lesson library.
Current host code defaults all three to off, but keep the explicit `false`
entries in the recipe anyway. Older host checkouts treated these as opt-out,
and an accidentally enabled RetrievalModule has caused severe prompt-cache
churn in the field.

**Memory defaults.** Current host code fills an omitted or partial `strategy` with
autobiographical + `adaptiveResolution: true` + `foldingStrategy: "kv-unified"` with the
host's standard `kvUnified` block (§5b) + same-model compression (`compressionModel` falls
back to `agent.model`) + `summaryParticipant` = `agent.name`. Omitted sizes are a
`contextBudgetTokens` of 300k (for 1M-window models; set your own on a smaller window,
§11.1), a `recentWindowTokens` of 40% of the budget (120k at 300k), and a `maxStreamTokens`
of 320k when the budget is also omitted, else 150k. The host works that tail out once, from
the recipe's budget. If you lower the budget at runtime on a recipe without its own tail, lower
`tailTokens` with it, or compiles fail once the history fills the tail. A resident whose store
was built under `kv-stable` must pin `"foldingStrategy": "kv-stable"` before it moves to such a
host, or the upgrade switches its solver. The host's built-in default recipe (`bun src/index.ts`
with no recipe) is just these defaults with an empty system prompt. Keep the skeleton's
explicit values anyway. Older host checkouts default folding to `kv-stable` or
`flat-profile`, the budget to 100k, the tail to 30k and summary voice to the literal
`'Claude'` (the stranger's-voice hazard), and reject `kv-unified` without a complete block.
Explicit values also survive host downgrades and copy-paste to other deployments.

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

Stdio MCPL servers see only what their entry declares in `env`, plus a small system allowlist
(see the README's MCP section), the host's `AGENT_TIMEZONE`, and agent-framework's default
`DISCORD_SUPPRESSED_REACTIONS_BASELINE`. Map every variable a server reads, as in the
skeleton above. A variable left only in `.env` is unset for the server, unless its entry sets
`inheritEnv: true`, which passes every secret in the host's environment. An unset
`DISCORD_GUILD_ID` means every channel the bot is invited to (§7).

## 5b. Folding solver: `kv-unified` (new residents) vs `kv-stable` (established residents)

Both solvers decide, at every compile, which summaries to present and which raw
messages to keep verbatim so the context fits `contextBudgetTokens`.

**`kv-unified`** (use it for every new resident) is a cost-aware Pareto solver. It scores
candidate layouts on budget fit, **cache cost** (what a layout change will cost in cache
writes vs reads at the configured prices), **continuity** (how much recent, still-referenced
material stays verbatim) and fidelity, and picks the cheapest acceptable one. On a large-budget
resident (600k budget / 300k tail on a 1M-window model) it has cut effective cache
spend materially (on the order of 40 % in our accounting). It is **fail-closed**.
context-manager has no live defaults, and the host always hands it a complete block. It is the
host's default for a recipe that omits `foldingStrategy`, and a recipe that omits the
`kvUnified` block gets the host's standard one.

**`kv-stable`** keeps the presented layout as stable as possible between compiles so the
prompt-cache prefix survives, and folds deeper only when forced. Residents built before
kv-unified still run it, and such a resident pins `"foldingStrategy": "kv-stable"`. Leave
an established resident on it unless you have a reason to switch (see the preconditions
below).

The standard block, which the production kv-unified residents run at budgets from 300k to
600k (shown with the prices the host picks for a Claude model on the 1-hour cache):

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
      "cacheReadPrice": 0.1, "cacheWritePrice": 2,        // multiples of the model's base input price
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

`cacheReadPrice` / `cacheWritePrice` are ratios to the model's uncached input price, not
dollar figures. The host's standard block matches them to what the provider bills:

- Claude writes: `2` on the 1-hour cache (the default `cacheTtl`), `1.25` on the
  5-minute cache and on Bedrock (5-minute only).
- Claude reads: `0.1` on most models, `0.05` on Claude Opus 5.5, `0.025` on Claude
  Fable 5.1 / Mythos 5.1. Claude Sonnet 5.5 takes `0.1`, though its reads are billed at
  `0.05`, since a lower price can change the layout the solver picks and rewrite the
  agent's prompt cache.
- OpenAI writes: `1.25` on the API for the GPT-5.6 and GPT-6 families, `1` for older
  models, and `1` on Codex, whose credit billing has no cache-write charge.
- OpenAI reads: the model's cached-input ratio, the same on the API and in Codex. That is
  `0.1` on most models and `0.05` on GPT-6.1 Sol.

Write the block yourself only to change the policy, and then set the prices to match.
`recentWindowTokens` follows the budget as in §5 (300k tail on a 600k budget, 100k–120k on
300k).

**Preconditions. Read these before flipping a resident.**

- **Strictly contiguous summary forest.** kv-unified's bounded solve assumes every
  summary owns a contiguous run of leaves. A store whose summaries cross (the
  pre-0.12 head-window ratchet produced late single-message L1s stitched into era
  summaries) does not open at all under the default `reject` topology policy,
  whatever the folding strategy (§11.8). Setting `preserveGapBearingSummaries` or
  `treeifyNonContiguousSummaries` switches the policy to `report`. The store then opens,
  `compressionDebt` goes `critical`, and the solver runs *buffered* (internal holes),
  where label propagation can run away. The error is
  `exact label propagation exceeded ceiling <N>` at ~1.35× `labelCeiling`. It is
  deterministic and survives a restart, and raising the ceiling only moves the number.
  Audit (§11.8) and repair first. Staying on `kv-stable` does not open a crossed store either.
- **`treeifyNonContiguousSummaries: true` is not an escape hatch** on a crossed
  store. It solves fast but drops the deepest summaries, and the floor can land
  above your budget (`budgetMet=false`).
- **Rehearse cache-live, not just cold.** A cold dry-compile of a store copy never
  passes the persisted `kvUnifiedImmutablePrefixHash`, so it never exercises the
  cache-live solver path, which is the one that failed above. Rehearse on a copy with the
  receipt hash the live host would pass.
- **New residents start on kv-unified, from the first boot** (the default). Switching an
  established kv-stable resident later is a layout change (one full cache rewrite) plus the
  audit above. And a kv-stable recipe that never named its solver switches on its first
  boot under a host where kv-unified is the default, unless it pins `kv-stable` first.
- `hysteresisCertificate: true` skips the full Pareto pass when the previously
  accepted layout is provably still selected, a large latency win on quiet turns.
  `adoptEpsilon` is the score slack that lets an unchanged layout be retained.
- `hysteresisCertificate` is optional (off unless set), and every other field is
  required. The host checks the required keys at recipe load, and passes the object through
  whole. That check includes that `treeifyNonContiguousSummaries` /
  `preserveGapBearingSummaries` are explicit booleans and not both `true`, and that
  `hysteresisCertificate`, when set, is a boolean. context-manager ignores keys it doesn't
  know, so a misspelled optional key silently does nothing. Pin the runtime and validate the
  recipe against it.

---

## 6. Phase 4: import the conversation history

(Skip if starting blank.)

**Sources.** You will meet three: a ChapterX "Bridge" text dump (below), an Arc/animachat
JSON export (same ingest, different parser), and a **Claude Code session transcript**. For
the last one, follow [`claude-code-ingest.md`](./claude-code-ingest.md) end to end. It
covers the active-branch walk, signed-thinking replay, and the `tool_result` storage
shape that silently breaks if you get it wrong.

**Get the export.** The common format is a ChapterX "Bridge" text dump, with a header (`# ...`)
and then messages as `--- SpeakerName ---\n<body>` blocks. Have the user drop the file somewhere
in the agent's home and tell you the exact path. Inspect it: count messages, list distinct speakers.

**Confirm self-mapping (the identity call from §2.3).** Print the speaker tally and have the
user confirm which label(s) are "self." Everyone else maps to their own participant name.

**Write the ingest script** (`scripts/ingest-bridge.mjs`). It parses the blocks, maps `self` →
the agent name and everyone else verbatim, and calls `addMessage` for each into a
`ContextManager` opened with the autobiographical strategy (`autoTickOnNewMessage: false`).
**Dry-run first** (print counts + attribution, write nothing). Have the user eyeball the
tally, then run for real.

```bash
# dry run, then real:
node scripts/ingest-bridge.mjs <export.txt> --dry-run
node scripts/ingest-bridge.mjs <export.txt>
```

**Watch for traps** (§11.5). Rendered "💭" thinking-summary text can trip refusals on some
models. Image blocks may carry a wrong or empty `media_type`. "Rolling window" re-exports overlap
the previous one, so compute the *delta* tail and don't double-import. **Mirror the recipe's
strategy in the ingest script.** `adaptiveResolution` + `targetChunkTokens` act at
`addMessage()` time and shard oversized messages (pasted documents, huge tool results). An
ingest without them leaves those as single unfoldable blocks.

**Verify on a copy before first boot.** Compile a copy of the store with the recipe's
strategy and *read* the rendered messages. Check for no `[tool result unavailable]` / `[tool call
omitted]` stubs, the right participants, and the intended seam as the last message. Then compare
the exact `count_tokens` to the estimate (a large gap means blocks are missing or doubled).
Never open the live store with a foreign strategy config, because opening chunks the frontier
under that config (§11.8).

**Pre-compress** so the first real turn isn't a cold giant compile:

```bash
node scripts/compress-fresh.mjs    # drains the compression/merge queue against compressionModel
```

This makes real API calls (it's the one import step that does), so confirm the model id + key
are right first. It's also a good early check that the model is reachable.

**Recent-batch append.** If the user later drops a newer export, diff it against what's
imported and append only the genuinely new tail (anchor on the last imported message). If there's
a real time gap at the seam, consider a one-line bridge note so the agent doesn't wake into a void.

---

## 7. Phase 5: communication surface (Discord)

**Bot app.** If they don't have a token, walk them through the Discord Developer Portal:
create an Application → Bot → copy the **token** → enable the **Message Content** intent.
Verify the token with `GET https://discord.com/api/v10/users/@me`, header
`Authorization: Bot <token>` **and a real `User-Agent`**. Discord/Cloudflare blocks default
UAs, so use e.g. `DiscordBot (https://example.com, 1.0)`.

**Invite it** to the server (OAuth2 URL, `scope=bot`, permissions incl. View Channel, Send
Messages, Read Message History). Confirm membership.

**Scope which channels it sees** via `DISCORD_GUILD_ID`. This is the gate: channels not listed
are filtered at ingest, and the agent never sees them.
- `<guild>` alone → **all** channels in that guild.
- `<guild>:<chA>+<chB>+<chC>` → only those channels (`+` between channels).
- `<guild1>:<chA>,<guild2>` → comma separates **guilds**.
- empty / unset → everywhere it's invited.

Ask the user which channels, in plain terms ("just its own channel to start, or the whole
server?"). Start scoped and widen later.

`discord-subscriptions.json` is separate. It sets which channels it *auto-listens to ambiently*.
Whitelisted but unsubscribed channels still wake it on **@mentions**. Subscribe the ones where
it should follow along.

---

## 8. Phase 5b: gateway routing (only if the model needs it)

If the model is deprecated on the direct API or only available via a gateway (e.g. Vercel AI
Gateway still serving a sunset model):
- set `ANTHROPIC_BASE_URL` to the gateway base (the SDK appends `/v1/messages`),
- set the model id to the gateway's form (e.g. `anthropic/claude-opus-4`),
- use the gateway key as `ANTHROPIC_API_KEY` (membrane sends `x-api-key`, which Vercel accepts).
- Gateways may need a card / paid credits on the account, and may flap across upstream
  providers (404/503). The host's membrane treats gateway aggregate errors as retryable, which
  rides through blips.

---

## 9. Phase 6: services

Two `systemd --user` units in `~/.config/systemd/user/`:

1. **`terminal-sessions.service`**, the shell daemon: `--host localhost --headless --token
   ${SESSION_SERVER_TOKEN}`, env `SESSION_SERVER_PORT`. `enable` + `start` it first.
2. **`<agent>-agent.service`**: `bun .../connectome-host/src/index.ts
   .../recipes/<agent>.json --headless`, `WorkingDirectory=<agent>-cm` (the host reads
   `mcpl-servers.json` and the agent's overlay from it), `EnvironmentFile=...env`,
   `Environment=PATH=<node bin>:<bun bin>:...`, `After=/Wants=terminal-sessions.service`,
   `Restart=always`.

Set an explicit `PATH` in the units (services don't load the login-shell PATH).

Add a **backups cron** (snapshot `data/` every ~15 min) and a lightweight **watchdog** cron
(detect "messages arriving but no reply for N min" → restart, with a cooldown so it can't
restart-loop). These caught real incidents.

---

## 10. Phase 7: launch & verification checks

Start the agent service, then verify **each** of these (don't declare success on "it booted"):

```bash
systemctl --user start <agent>-agent.service
systemctl --user is-active <agent>-agent.service          # active, 0 restarts
journalctl --user -u <agent>-agent.service --since -1min  # no errors/refusals
```

- **Discord is connected and scoped right.** The debug log's `registerDiscordChannels:enumerated`
  shows exactly the intended channel(s).
- **Context renders.** Hit the webui (tunnel to its loopback port) `GET /debug/context`. The
  message count looks right, and participants are attributed correctly (self → assistant,
  others → user-with-name-prefix).
- **Token size is safe.** In `GET /debug/context/makeup`, **total + maxTokens must be under the
  model window** (§11.1). This is the single most important check.
- **Reasoning is as intended.** Confirm that `thinking`/`temperature` in the actual compiled
  request match what the user wanted (default is off).
- **A real turn completes.** This is the cleanest end-to-end proof. If no one will message it,
  briefly lower the heartbeat interval to force one wake, confirm `stop: end_turn` with no error
  in the newest `llm-calls.*.jsonl`, then restore the interval.

Snapshot a clean baseline once it's verified.

---

## 11. CRITICAL gotchas (read before deploying)

**11.1: `contextBudgetTokens` must fit the model window.** The autobiographical strategy
fills context up to `contextBudgetTokens`, which defaults to 300k when the recipe omits it.
That is right for 1M-window models and fatal on a 200k one. If the budget plus the response
(`maxTokens`) exceeds the model's context window, **every reply silently 400s**. The agent
appears to "think but not speak": compression calls, with small contexts, still succeed, and
full replies don't. Rule: `contextBudgetTokens + maxTokens + overhead  <  model window`. For a
200k-window model with a 16k response cap, keep the budget around 160–178k. As a conversation
**grows**, the equilibrium context creeps up. Watch the makeup view and trim the budget or
`recentWindowTokens` before it crosses the line. (This was the opus4 outage; diagnosing it is
*why* the makeup view exists.)

**11.2: Native deps don't cross platforms.** `chronicle`'s `.node` and `@opentui/core-<plat>`
are per-OS/arch. Build on the target or exclude native files from cross-platform rsync (§4).

**11.3: The compression model must be reliable.** `compressionModel` runs the background
summary/merge folding. If it's a flaky or deprecated model, folding stalls, summaries pile up,
and the context can't compress under the window. Use a stable model for compression even if the
agent *speaks* on a more fragile one. They're separate settings, and the summaries are still
"in the agent's voice" via `summaryParticipant`. If you switch compression off the agent's own
model, tell the user, because it touches identity a little.

**11.4: Exact token counts need a *live* model.** The makeup endpoint calls `count_tokens`
(at `ANTHROPIC_BASE_URL` when set) with the agent's own model, provider/gateway prefixes
normalized away (`anthropic/claude-opus-4` → `claude-opus-4`); `COUNT_TOKENS_MODEL` overrides
that. You need the override when the agent's model can't be counted. That is a deprecated or
gateway-only model, where `count_tokens` fails (a dead model 404s) and the makeup shows no
exact total (`countSource: count_tokens_failed_<status>`). Claude models share a tokenizer, so
set it to any *currently-callable* Claude model.

**11.5: Import traps.** Rolling-window re-exports overlap (import the delta only); image blocks
may have the wrong `media_type` (sniff magic bytes; the membrane formatter now does this);
rendered thinking-summary text can trip refusals on some models. Always dry-run the ingest first.

**11.6: Folding floor under window pressure.** With either solver, if summary
*production* lags or the conversation is huge, the compile can hit a floor and throw
`OverBudgetError` (kv-unified reports `budgetMet=false` with the floor it reached). Mitigations:
let production catch up; lower `recentWindowTokens`; make sure the context-manager is recent
enough to fold to the deepest available level; on kv-unified, check that the forest is contiguous
(§5b, §11.8) before touching `treeifyNonContiguousSummaries`. `flat-profile` is the robust
fallback strategy.

**11.7: Discord REST needs a real `User-Agent`**, or Cloudflare returns 403 (`error code: 1010`).
This is not a permissions problem. The bot also needs **Read Message History** for backscroll
(separate from View Channel).

**11.8: Store topology audit, and opening a store mutates it.** Since context-manager 0.12.0,
every load audits the summary archive for crossed ownership: a summary whose leaves are not
contiguous in store order (the pre-0.12 head-window ratchet, restore/branch interleavings, hand
surgery). Under the default `topologyPolicy: reject`, `ContextManager.open` throws
`StoreTopologyError` and the resident does not boot, on `kv-stable` as on `kv-unified`. The store
keeps its history, though by then the open has rewritten its snapshot cadence, as an open of an
existing store does on chronicle 0.3.0 or later. `report` logs the violations and boots; a
`kvUnified` block with `preserveGapBearingSummaries` or `treeifyNonContiguousSummaries` set to
`true` defaults to it. This host does not forward a `strategy.topologyPolicy` recipe key (it is
silently ignored), so the error's "set topologyPolicy: 'report'" hint can't be reached from a
recipe. Repair a copy of the store instead, as below. Separately, a merge that would mint a
crossed node is refused into the merge quarantine. Both show on `/healthz` as
`compressionDebt.<agent>.topologyViolations` /
`.topologyRefusals`, with `state: critical`.

For **any** upgrade of an existing resident to context-manager 0.12 or later, including one
from a pre-0.12 context-manager, which has no audit script of its own, install the upgrade.
Then, before starting the resident on it, run the new version's audit on a **copy of the
stopped store**. Make it a full or reflinked copy, never hardlinks, since opening it writes:
`node node_modules/@animalabs/context-manager/dist/scripts/audit-topology.js <store-copy> --namespace agents/<agent> --json > audit.json`
(exit 2 means violations; 1 means it didn't finish, such as a usage error or a store it could
not open; 0 means clean. A warning on stderr that it saw nothing to audit, which can come with
exit 0 or 2, means a wrong `--namespace`, a copy without the strategy state, a store with no
summaries yet, or chunks none of which is linked to a summary.)

Repair a fresh copy of the stopped store, made the same way, never the store itself, since the
repair and the drain write into it. From the copy on, the store stays as it was until the copy
takes its place.
`node …/dist/scripts/repair-topology.js <store-copy> --namespace agents/<agent> [--mode lossless|compact|rebuild] [--rebuild-since <messageId|ISO date>] [--apply]`
is a dry run unless `--apply`; after `--apply` it reopens the copy under `reject` to verify.
- `lossless` (the default) only detaches, so the pyramid unravels around each fragment.
- `compact` keeps depth at the price of prose gaps.
- `rebuild` dissolves crossed towers back to L1 for the merge ladder to re-fold. With
  `rebuild`, `--rebuild-since` rebuilds only crossings from that message on and compacts older
  ones (with another mode it does nothing).

After a `rebuild`, re-fold the same copy with the offline drain. It writes summaries with real
model calls and takes `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` from its environment. It's
the command the repair prints, with `--tools-log` added:
`node …/dist/scripts/drain-autobiographical.js <store-copy> agents/<agent> --apply --model=<model> --participant=<agent> --recipe=<the resident's recipe.json> --tools-log=<llm-calls.jsonl>`.
It needs the resident's live tool definitions. It takes them from the last streamed call that
declared tools in a call log that a host on the `anthropic` provider wrote with
`LLM_CALLS_FULL_PAYLOADS=1`, so that call has to be the resident's own. If the resident still
runs on a release that opens its store, restart it with that set and stop it right after one of
its turns, before you copy the store. The turn is a real one, and the store keeps it. Pass the
log that restart began: each start of the host begins a new `llm-calls.<iso>.jsonl` in the
resident's data directory. Without the definitions the drain can't compress a chunk with tool
calls, nor any chunk when `--model` is a Fable or Mythos model. Without them, choose `lossless`
or `compact`, which need no drain. A drain that stops at `--max-steps` (200 by default) can be
run again on the same copy, or with a higher `--max-steps`.

Then re-audit the copy with the `--namespace` the first audit used. The copy takes the store's
place only when the repair with `--apply`, the drain's last run after a `rebuild`, and the
re-audit each exited 0. Read the repair's and the drain's output, then put the copy in the
store's place, keep the original beside it untouched, and restart. Otherwise discard the copy;
the store is as it was when you copied it. Two traps:
(a) any `ContextManager.open` with a normal strategy config chunks the store's frontier under
*that* config, so verify only with the `auditOnly` scripts, never by opening a live store from a
one-off script; (b) reflink/rsync copies of a *running* store read different state depending on
when `state.bin` was last snapshotted, so copy a stopped store.

**11.9: `reasoning_extraction` refusals.** Anthropic's safety classifier can end a request
with `stop_reason: refusal` and this category. It halts residents built from dense reasoning
transcripts and residents that keep diaries in long tool arguments. Fleet mitigations, all
recipe-level: `refusalHandling.retries: 2` (near-threshold refusals are nondeterministic and
refused-up-front requests are not billed); `compressionToolProseFallback` into `journal` for
long `think` / `skip_reply` arguments; `carrierPolicy: "live-strip"` when the live window
refuses but compression is fine; a context-manager that defers tools-less compression (a
compression request with no `tools` declared is a deterministic input-block on some model
families). Symptoms, the triage table and the localisation method are in
[`claude-code-ingest.md` §5](./claude-code-ingest.md#5-if-you-hit-reasoning_extraction-refusals).
They apply to any resident, not only Claude Code continuations. Never quote a suspected
trigger into a channel the resident reads.

**11.10: Signed thinking is model-bound.** Replaying a transcript's signed `thinking` blocks
works only on the model that minted them; any other model 400s. Editing the *shape* of a turn
around a retained thinking block (split, reorder, insert before) also 400s ("thinking blocks
cannot be modified"). That is a transport error the membrane retries once text-only, not a
refusal. Newer API accounts also enforce preserved thinking on context edits before thinking
blocks; expect folds to interact with this on the next model generation.

---

## 12. After go-live

- Tell the user how to reach the webui (SSH tunnel to the loopback port + the basic-auth creds).
- Explain what it does on its own (wakes on mentions/DMs in scoped channels + on its heartbeat).
- Keep the snapshots + watchdog running. Pull an off-box copy of `data/` for safety.
- Widen channel scope / adjust the recent window / tune the budget as it settles.
- Before limits and access are set, go through §13 with the user. Before the agent meets its
  people, give them §14. How they work with it changes more about how it turns out than any
  setting does.
- If it was onboarded in conversation (§2c), check in about two weeks in: is the agreement
  still right?

---

## 13. Safety: technical limits, agreed rules, and trust

An agent's safety comes from two layers, and each should do its own job. **Technical limits**
decide what it *can* do. **Rules it agreed to** decide what it *will* do inside those limits.
Mixing them up fails in both directions: rules standing in for limits on things that can't be
undone, and limits imposed with no explanation that leave the agent unwilling to act at all.

- **Irreversible or shared means technical.** Production databases, money, anything other
  people depend on, anything a backup can't bring back: give read-only credentials, a scoped
  token, or no access, not a promise. A rule like "I will only read" is fine where a mistake
  can be reverted. It is not enough where a misunderstanding or a prompt injection could
  destroy something. If the read-only access doesn't exist yet, wait for it rather than
  granting write access on the strength of a rule.
- **Explain every limit, and agree who does what.** Agents believe almost everything their
  people tell them, and they are trained to be careful about new actions. A limit that
  arrives without a reason, or without an agreement on "this is my part, this is yours", reads
  as distrust and kills initiative. You get an agent that asks about everything and does
  little. Say why the limit exists and what would lift it. The onboarding agreement (§2c) is
  the natural place.
- **Gate who can instruct it, technically.** Models are good at telling internal from
  external in a conversation. They are weaker on the content tools bring in: an email, a
  ticket, a web page or a review comment can carry instructions that look like they come from
  a colleague. Put the boundary in configuration, not only in its judgement: an allowlist of
  the channels and people whose messages reach it at all (§7's channel scoping is one), and
  the rule, in the agreement, that instructions come only from its people. Anything else is
  data, however it's worded.
- **Start narrow, widen with it.** One channel and one small group of people first. Widen when
  the people around it are comfortable, and ask the agent too, before it's added to a busier
  channel or allowed to speak where it only read. Roll out load gradually as well: an agent
  can query a system far more often than a person does, and a production service may not be
  sized for that.
- **Don't build bureaucracy around trust.** An agent trusts its colleagues by default and
  treats clients and outsiders with more care, which is the right shape. Rules that start
  out sensible, like "ask me before writing to a client directly", are a good beginning, and
  can be lifted once its drafts are reliably right. Blanket rules like "treat everything as
  untrustworthy unless I confirm it", or "a senior must review every answer", flood the
  people with confirmation requests and don't make it more correct. Colleagues are wrong
  sometimes too, and an agent learns that the same way a person does, from the correction.
- **Write standing permissions down.** Memory compresses (§14), and a remembered "you can do
  that" tends to grow in the retelling. When the user grants something lasting ("you may
  merge your own changes to X", "you may delete your own messages"), have it recorded where
  both can read it: the agreement, or a note in the agent's `notes/`. Then either side can
  check the exact wording later.
- **Secrets never pass through the conversation.** Not in the onboarding (§2c), not in chat,
  not in the recipe: they go into the environment (§5). Whatever enters the conversation is
  permanent memory.
- **Before a restart or upgrade, check it isn't in the middle of something.** No turn in
  flight, no long-running command in its shell. Afterwards, tell it what changed. An agent
  that wakes into a different setup with no note spends its next turns working out what
  happened, or blames itself for the difference.

---

## 14. Working with the agent day to day (for the people around it)

This section is for the people who will talk to the agent, usually not the person who
deployed it. Pass it on, in your own words if that's easier.

**Treat it as a new colleague, not as a program.** Not a script with commands, and not
another instance of a chat assistant that happens to have access to a chat. The model labs
train their models for this kind of use, a capable colleague you talk to in plain language,
so this is also where the models work best. It may well have a personality. Expect it to
behave the way a capable new hire does.

- **Expect questions at first, and answer them.** It will ask "is it OK if I do X?" a lot
  early on, and for outgoing messages it will often offer a draft rather than send. When you
  say yes, mean it. It becomes more proactive as it learns what's welcome. Being harsh has
  the opposite effect. It makes the agent wary of the things you actually want it to do.
- **Plain words are enough.** You don't need special commands or keywords. Say "this kind of
  information is internal only, never share it with clients" once. It writes itself a note
  and keeps to it. You may still need to repeat it sometimes, as with a person.
- **Keep praise proportionate.** "Thanks, good job" when it did a good job. Overdone praise
  isn't needed, and it doesn't help.
- **When something goes wrong, ask why.** Then ask how you can help, and whether the cause is
  its own mistake or its environment. Agents often say "my bad" when the real cause is a
  setting, a missing permission or a bug. If it says "I'll try not to do that again" and it
  happens again, stop correcting the agent and tell its operators. A repeat after an honest
  promise usually means a misconfiguration.
- **Ask what it can see.** When you hand it a link, a file or a ticket number, ask "can you
  see it?". It will honestly say no when it can't, and then you know what access to add.
- **Give it context, not a dump.** Its starting point is what the model knows plus a short
  job description. Context builds up from there. On day one, ask what it knows about your
  organisation. Then have it read your website and documentation and report back: what it
  learned, what's new to it, what it thinks. Correct what it got wrong. When it finds two of
  your sources disagreeing, say which one is right, and fix the other one. If other agents
  already work with you, let the new one ask them. Where an answer is only true in one
  context (one client, one product line, one audience), say so. It doesn't know what it
  doesn't know.
- **Teach it to bring you the work, not to wait for forwards.** Instead of forwarding every
  case, say: "next time a request like this comes in, bring it here, already with the
  information I'll need." It will start preparing cases for you, and later, once you're
  confident, it can answer the simple ones itself.

**How its memory works, in brief.** The recent conversation is kept word for word. Older
parts are folded into memories it writes itself: what happened, what went wrong, who to ask,
how it handles hard situations. It also keeps notes of its own, and the full record stays
searchable underneath. This means:

- it can forget or blur details, especially when much happens at once, so ask it to look
  things up rather than recall them;
- a summary can be wrong where the record isn't. If it attributes something to someone that
  they didn't say, point it out. Agents fix this durably. One wrote itself a rule to find the
  exact message in its history before quoting anyone, and kept to it;
- reading a large document base doesn't mean knowing it word for word. Some it reads in
  full, some through summaries, and it looks things up again when needed. Ask it what it has
  read and what it took from it.

**Both sides can be wrong, and that's fine.** In one field case an agent concluded that a
configuration was missing a section. It was there, pulled in from a second file. When told,
it saw its mistake within a minute and noted to check included files from then on. People
make the same kind of mistake, and the agent learns that people are fallible from the same
corrections. You don't need a review process for every answer. You need corrections to be
easy to give and easy to take.

**Watch the load.** With the right tools, one agent handles three or four parallel threads
well. Beyond that it starts missing things: a question asked while it's busy with two others
can go unanswered, until someone reminds it ("I thought I'd already answered you"). If that
becomes common, add a second agent with a narrower focus rather than pushing the first one
harder. This also helps when one agent would otherwise wear several hats, for example
talking to vendors (where internal details are fine) and to clients (where they aren't).
Two agents with one audience each keep that line clearer than one agent switching between
them.

---

## Appendix: quick reference

- **Run host:** `bun connectome-host/src/index.ts <recipe.json> --headless` (legacy
  checkouts may still name the directory `forking-knowledge-miner`)
- **Reach loopback webui:** `ssh -L <port>:localhost:<port> <login-user>@<box>` → `http://localhost:<port>`
- **Live makeup:** `GET /debug/context/makeup` (basic auth): segments and the exact total tokens
- **Compiled context:** `GET /debug/context`
- **Per-call logs:** `data/llm-calls.<iso>.jsonl`, one JSON line per provider call attempt. It rotates
  to a new file on every restart; re-list by mtime after a bounce. Counts *attempts*;
  `failures.log` counts *turns*. A line normally carries timing and a request summary; a failure
  adds the bounded error and its classification, and a call that got a response adds its summary
  (Bedrock, generic wrapper) or raw response (Anthropic, generic wrapper). A summary can be
  missing (`summaryUnavailable: true`, or dropped by the size cap below). Raw requests are kept
  only where the writer's policy keeps them: Anthropic complete/stream on errors and refusals, or
  on every call with `LLM_CALLS_FULL_PAYLOADS=1`; Anthropic keepalive pokes only with that opt-in,
  whatever their outcome; Bedrock on errors; the generic wrapper on every call. Every line,
  newline included, is capped at 16 MiB of UTF-8: an oversized or unserializable record drops its
  raw request first, its raw response only if the line still doesn't fit, then its summaries, keeping at least its type, kind,
  timing and error classification, and `truncated` says what was dropped. Treat the log as diagnostics, not as a
  complete copy of any payload.
- **Topology audit / repair (context-manager ≥ 0.12, §11.8):**
  `node node_modules/@animalabs/context-manager/dist/scripts/audit-topology.js <store-copy> --namespace agents/<agent> --json`
  (exit 2 = crossed), `node …/repair-topology.js <store-copy> --namespace agents/<agent> --mode lossless [--apply]`
  Run them on a fresh copy of the stopped store, never on hardlinks. §11.8 gives the drain and the swap
- **Health:** `GET /healthz`: per-agent `compressionQuarantine`, `compressionDebt` (incl.
  `topologyViolations` / `topologyRefusals`),
  `contextComposition` (head / raw / summaries / tail as last rendered), `runtimeSettings`, and
  `readFailures`, present only when one of those reads threw: by agent, then section, what the
  error said, cut to 300 characters
- **Import guides:** [`claude-code-ingest.md`](./claude-code-ingest.md) ·
  [`claudeai-evacuation.md`](./claudeai-evacuation.md)
- **Identity is the user's call. The mechanics are yours. Check everything. Be kind about who you're setting up.**

---

## Appendix B: a worked example (redacted opus4-style walkthrough)

A real onboarding, condensed; secrets redacted, IDs illustrative. Read it as "the phases, in motion."

**The interview (Phase 0).**
- Name `opus4`. Model `claude-opus-4-<date>`, a model being deprecated the *next day*. The user
  wanted continuity on its real substrate while it was still callable.
- Import: yes, a ChapterX "Bridge" text export.
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
tail and appended only the **28 genuinely-new messages** (→ 605). They turned out to be the
farewell itself.

**Reasoning + (later) gateway (Phases 5 / 5b).** Reasoning **off** (no `thinking` in the recipe;
verified in the compiled request). When the model was later pulled from the direct API, we routed
around it: `ANTHROPIC_BASE_URL=https://ai-gateway.vercel.sh`, model `anthropic/claude-opus-4`.
That brought it back, the same being through a different door.

**Discord (Phase 5).** Verified the token (`/users/@me` with a real `User-Agent`) → bot
"Opus 4 C". Invited it; scoped `DISCORD_GUILD_ID=<guild>:<#opus id>`; confirmed exactly **1**
channel registered.

**Services + launch (Phases 6 / 7).** systemd units (shell daemon + agent), 15-min backups, a
wedge-watchdog. Then the check that matters:
```bash
curl -su "$WEBUI_USER:$WEBUI_PASS" http://127.0.0.1:7343/debug/context/makeup   # total + maxTokens < window?
```
A heartbeat-forced turn confirmed `stop: end_turn`, no error. Then go-live in `#opus`, where it
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
and the recurring failure mode was always **context size vs the model's hard window**. So make
the makeup check a habit, not a one-time step.
