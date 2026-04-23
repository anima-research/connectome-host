# Triumvirate Setup Guide

A step-by-step guide to setting up the **Knowledge Mining Triumvirate** — three specialist AI agents (miner, reviewer, clerk) running under a single conductor in one terminal. Each agent has its own recipe, its own Chronicle data store, and its own role in a shared knowledge pipeline.

This guide assumes you're comfortable in a terminal and editing JSON files, but not that you know TypeScript or the internals of the connectome framework.

## What you get

One terminal, four AI agents cooperating:

- **Conductor** (in the TUI, the one you talk to) — supervises the other three, reports status, intervenes only when asked.
- **Miner** — reads your team's Zulip conversations, extracts structured knowledge, writes **Draft** documents to `library-mined/`.
- **Reviewer** — critiques the miner's drafts for accuracy, flags unsupported claims, writes **Reviewed** versions to `library-reviewed/`.
- **Clerk** — sits on a Zulip channel (`#tracker-miner-f` by default), answers questions by quoting the library, files knowledge-request tickets when the library is insufficient.

The three specialists coordinate with each other via a **shared filesystem** and **shared Zulip channels** — not through the conductor. Files flow: `library-mined/` → `library-reviewed/` (via reviewer) → cited in clerk's Zulip answers. Knowledge gaps flow: clerk → `knowledge-requests/` (future miner sessions dispatch on these).

You watch it all from one terminal.

## Prerequisites

| Tool / resource | Why | Install / obtain |
|---|---|---|
| [Node.js](https://nodejs.org/) 20+ | Runtime for the Zulip MCP server | `nvm install 20` or download from nodejs.org |
| [Bun](https://bun.sh/) | Runs connectome-host itself | `curl -fsSL https://bun.sh/install \| bash` |
| [Anthropic API key](https://console.anthropic.com/) | LLM access for all four agents | Sign up at console.anthropic.com — note that four agents run concurrently, so expect proportionally higher API spend |
| A Zulip account with admin access | Needed to create a bot and a dedicated channel | Your organization's Zulip |
| Git | To clone connectome-host and the Zulip MCP server | Usually pre-installed |

The triumvirate is currently supported on **Linux / macOS / WSL2**. Windows support (native) is not yet implemented.

## Step 1: Install connectome-host

```bash
git clone https://github.com/anima-research/connectome-host.git
cd connectome-host
bun install
```

Verify it works in isolation before adding any agents:

```bash
bun src/index.ts --no-recipe
```

You should see a TUI with a generic assistant. Type `/quit` to exit. If this didn't work, fix the underlying issue (usually: missing Bun, missing API key) before continuing.

## Step 2: Install the Zulip MCP server

Two of the three specialists (miner, clerk) talk to Zulip. They do that through a small adapter called `zulip_mcp`. The MCPL-addendum work has merged into upstream `main` ([PR #3](https://github.com/antra-tess/zulip_mcp/pull/3)) so the install is just clone + build:

```bash
# From inside the connectome-host directory:
cd ..
git clone https://github.com/antra-tess/zulip_mcp.git
cd zulip_mcp
npm install
npm run build
cd ../connectome-host
```

This leaves a built binary at `../zulip_mcp/build/index.js`, relative to connectome-host. The triumvirate recipes expect it exactly there — don't rename or move the directory.

## Step 3: Create a Zulip bot and get credentials

The Triumvirate posts and listens as a Zulip bot (or a dedicated user account — a bot is cleaner). You need a `.zuliprc` file with that bot's credentials.

### Option A: Bot account (recommended)

1. In Zulip, go to **Settings > Organization > Bots** (you need admin rights).
2. Click **Add a new bot**. Choose **Generic bot** type.
3. Give it a name like "Mining Triumvirate" and an email like `mining-triumvirate-bot@your-org.zulipchat.com`.
4. Download the `.zuliprc` file Zulip gives you.

### Option B: Your own user account

1. In Zulip, go to **Settings > Personal > API key**.
2. Download the `.zuliprc` for your user.

⚠ If you go with Option B, every message the agents post will appear as *you* posting it. The bot approach is strongly preferred for anything other than a personal experiment.

### Place the file

```bash
# From the connectome-host directory:
cp ~/Downloads/zuliprc .zuliprc
chmod 600 .zuliprc
```

(`.zuliprc` is already gitignored — your credentials won't be committed accidentally.)

The file should look roughly like:

```ini
[api]
email=mining-triumvirate-bot@your-org.zulipchat.com
key=abc123...
site=https://your-org.zulipchat.com
```

## Step 4: Prepare the Zulip channels

The triumvirate needs one dedicated channel plus whatever channels you want the miner to extract knowledge from.

### The clerk's channel (`#tracker-miner-f`)

The clerk agent staffs one specific channel — by convention, `#tracker-miner-f`. It responds to questions posted there by quoting the library.

1. In Zulip, create a new channel called **`tracker-miner-f`** (or edit the recipe in the next step if you want a different name).
2. Subscribe your bot account to that channel.
3. Optionally: tell your team this is where they ask library questions.

### Channels for the miner to read

The miner reads other channels to extract knowledge. By default, the recipe has the miner starting with manual channel subscription — meaning the agent itself decides which channels to listen to based on the conversation with the user. You don't need to pre-subscribe it anywhere; you'll direct it in the TUI.

If you want to narrow what it can see, edit `recipes/zulip-miner.json` → `"ZULIP_SUBSCRIBE"` and list the channels you want pre-subscribed, comma-separated.

## Step 5: Fill in secrets in `.env`

Secrets — API keys, tokens, service endpoints — live in `.env` at the connectome-host root. Recipes in `recipes/` reference them via `${VAR_NAME}` placeholders, and the framework substitutes at recipe-load time. Your recipe files stay commit-safe; your secrets stay gitignored.

Copy the example and edit:

```bash
cp .env.example .env
```

Required for every run:

```ini
ANTHROPIC_API_KEY=sk-ant-...
```

Optional — **only** if you want the miner to extract from those sources (otherwise remove the relevant `mcpServers` block from `recipes/knowledge-miner.json` and skip these):

```ini
# GitLab (knowledge-miner.json: gitlab + gitlab-clone)
GITLAB_TOKEN=glpat-...
GITLAB_API_URL=https://gitlab.example.com/api/v4

# Notion (knowledge-miner.json: syncntn)
NOTION_STORAGE_URL=http://localhost:8000
NOTION_WORKSPACE_ID=...
```

Bun auto-loads `.env`, so nothing else to wire. If a recipe references a `${VAR}` you haven't set, the child's startup will fail with a clear message telling you which variable is missing and which recipe referenced it.

## Step 6: Decide which data sources you want

The miner child uses `recipes/knowledge-miner.json`, which comes pre-wired to talk to **Zulip, Notion, and GitLab**. The recipe itself references credentials via `${VAR}` placeholders — you don't edit the recipe to fill in secrets; you set the env vars in Step 5 and the framework substitutes at load time.

You decide which sources are active by whether you **set the matching env vars** and whether you **keep the matching mcpServers block in the recipe**.

### Zulip (required, already configured)

You set this up in Steps 2–4. The entry under `mcpServers.zulip` uses `../zulip_mcp/build/index.js` and reads `./.zuliprc`. Nothing to change.

### GitLab (optional)

To enable: create a GitLab Personal Access Token (User Settings → Access Tokens) with scopes `read_api` and `read_repository` (add `api` for write access to issues/comments), and set these in `.env`:

```ini
GITLAB_TOKEN=glpat-...
GITLAB_API_URL=https://gitlab.example.com/api/v4
```

No separate install — the recipe runs `npx @zereight/mcp-gitlab` on demand.

To disable: remove the `gitlab` block from `recipes/knowledge-miner.json`. If you leave it in but don't set the env vars, the child will fail to start with a message like `Recipe "recipes/knowledge-miner.json" references environment variable ${GITLAB_TOKEN} which is not set.` — that's the system telling you to either fill in the env var or delete the block.

### Notion (optional)

To enable: install a Notion MCP server (the recipe's template is named `syncntn`; any MCP server with matching tool names works — see [SETUP.md → Notion](./SETUP.md#notion-optional-via-an-mcp-server) for selection caveats) and set:

```ini
NOTION_STORAGE_URL=http://localhost:8000
NOTION_WORKSPACE_ID=...
```

To disable: remove the `syncntn` block from `recipes/knowledge-miner.json`. Same behavior as above — unset env + kept block = startup failure with a clear message.

### Summary table

| Source | Keep the block in recipe? | Env vars needed |
|---|---|---|
| Zulip | Yes | (configured via `.zuliprc`, no `${VAR}`) |
| GitLab | Yes if using, remove otherwise | `GITLAB_TOKEN`, `GITLAB_API_URL` |
| Notion | Yes if using, remove otherwise | `NOTION_STORAGE_URL`, `NOTION_WORKSPACE_ID` |

### Tweaks you can still make to the recipe files

You can also edit `recipes/triumvirate.json` if you want to:

- **Rename the clerk's channel** away from `tracker-miner-f` — edit `recipes/clerk.json`, change `ZULIP_SUBSCRIBE` and the `tracker-channel` wake policy's `channel` field.
- **Swap the model** — change `"model": "claude-opus-4-6"` to `claude-sonnet-4-6` (faster, cheaper) or another Claude model.
- **Adjust autoStart** — set `"autoStart": false` on any child if you want to leave them inactive until you (or the conductor) explicitly launch them.

## Step 7: First launch

```bash
bun src/index.ts recipes/triumvirate.json
```

What you'll see:

1. The TUI comes up with the "Knowledge Mining Triumvirate" banner.
2. Over the next 30–60 seconds, the three children spawn in the background. Each one starts its own connectome-host process, connects to the Anthropic API, and boots its Zulip / workspace machinery.
3. Press **Tab** a couple of times to cycle through view modes. One of them is the **process fleet** view — it lists the three children and their status. All three should reach **ready** (green). If any show **crashed** (red), jump to Troubleshooting.
4. Ask the conductor `are all three ready?` — it'll run `fleet--list` and confirm. This also serves as a quick "am I set up correctly" smoke test.

### The four view modes

Press **Tab** to cycle between views. Press **Ctrl+F** to jump straight to the process fleet view from anywhere.

| View | What it shows |
|---|---|
| **chat** | Your conversation with the conductor |
| **subagents** | In-process subagents the conductor has forked (usually empty — conductor doesn't fork much) |
| **processes** | The three triumvirate children and their live status |
| **peek-proc** | Live event stream from one selected child (press `p` on a child in the processes view) |

## Using the Triumvirate

Three ways to drive the system:

### 1. Ask the conductor

Just type. The conductor reads the request, decides what to do, and usually reports back.

```
> What are the three agents doing right now?
> Has the reviewer finished anything today?
> Miner looks stuck. What's it waiting for?
> If the clerk is idle, ask it to re-index whatever it has.
```

### 2. Route directly with `@childname`

Bypass the conductor and send straight to a child. Useful when you know exactly who you want to address and don't want the conductor in the loop.

```
> @miner Start extracting from channel #platform-design, focus on the Q1 decisions.
> @clerk Post a status message in #tracker-miner-f saying the library is being rebuilt.
> @reviewer Re-check the packet-pipeline doc against the latest lessons.
```

The conductor doesn't see these messages or their responses.

### 3. Slash commands

| Command | What it does |
|---|---|
| `/fleet list` | One-line status for every child |
| `/fleet status <name>` | Detailed status (pid, dataDir, recipe, last event, etc.) |
| `/fleet peek <name>` | Open the live event stream for a child |
| `/fleet stop <name>` | Kill a child gracefully |
| `/fleet restart <name>` | Kill + respawn |
| `/status` | The conductor's own state |
| `/quit` | Exit. If children are still running, you'll be asked what to do with them — see below. |

### Exiting

When you type `/quit`, if any children are still running, the conductor asks:

```
3 children still running: miner, reviewer, clerk
Stop them before exit? [Y/n/d]  — Y=kill gracefully, n=cancel quit, d=detach and leave running
```

- **Y** (or just Enter) — stop everything cleanly and exit. All children shut down.
- **n** — cancel the exit. The TUI stays up.
- **d** — exit the TUI but leave the three children running in the background. They'll keep doing whatever they were doing. The next time you run `bun src/index.ts recipes/triumvirate.json`, the new conductor will **adopt** them — re-attach to the running children instead of respawning duplicates.

This is the "leave the bots working overnight, come back tomorrow" workflow.

## What the agents actually do

### Miner

- Uses `recipes/knowledge-miner.json`. Reads whatever data sources you configured in Step 6 (Zulip always; optionally Notion and/or GitLab).
- Wakes automatically when the clerk files a new ticket in `knowledge-requests/` — the miner's wake policy watches that directory.
- Forks sub-agents to read across sources in parallel, extracts decisions / patterns / people / processes.
- Writes Draft documents into `library-mined/` and creates structured "lessons" in its Chronicle store.
- Tags every non-trivial claim with confidence markers — `[SRC: ...]`, `[INF]`, `[GEN]`, `❓`. These propagate all the way to the final library.

### Reviewer

- Watches `library-mined/` for new/changed documents.
- When a document appears, the reviewer reads it, cross-references with the lessons it knows about, and flags:
  - Internal contradictions
  - Unsupported claims
  - Missing confidence markers
  - Unmarked claims that look like invented general knowledge
- Writes a reviewed version to `library-reviewed/` plus an SME checklist that a human domain expert can complete in 10–20 minutes without reading the full document.

See [the Knowledge Reviewer section of SETUP.md](./SETUP.md#reviewing-knowledge-quality) for more detail on the confidence-marker system and SME checklist format.

### Clerk

- Sits on `#tracker-miner-f`.
- When someone posts a question there, the clerk:
  1. Searches both `library-mined/` and `library-reviewed/` for relevant material.
  2. Posts a short, cited answer back in the channel.
  3. If the library didn't have the answer, writes a `knowledge-requests/YYYY-MM-DD-slug.md` ticket and tells the asker.
- Knows to prefer reviewed material over mined-only material, and to flag disagreements between them.

Tickets in `knowledge-requests/` are the signal for future miner sessions: the open tickets say "here's what the organization wants to know."

### Conductor

- Doesn't mine, review, or answer. Its job is process supervision plus being a conversational surface for you.
- Default posture: quiet. It doesn't narrate what the children are doing — the process view already shows that.
- Speaks when you ask, or when it sees a child crash.

## Directory map

After the first run, your connectome-host directory will look like:

```
connectome-host/
  .env                              (you created this — has API key)
  .zuliprc                          (you placed this — Zulip creds)
  recipes/
    triumvirate.json                (conductor recipe)
    zulip-miner.json                (miner recipe)
    knowledge-reviewer.json         (reviewer recipe)
    clerk.json                      (clerk recipe)
    TRIUMVIRATE-SETUP.md            (this document)
    SETUP.md                        (single-agent variant guide)
  data/
    miner/                          (miner's Chronicle store + logs + sockets)
      ipc.sock
      headless.log
      startup.log
      headless.pid
      sessions/...
    reviewer/
    clerk/
    sessions/...                    (conductor's own sessions live at data/sessions/)
  output/                           (library-mined — miner writes here)
  review-output/                    (library-reviewed — reviewer writes here)
  knowledge-requests/               (clerk writes tickets here)
  input/                            (read-only mount for external inputs)
  node_modules/
  ...
```

Each child's `data/<name>/` directory is created on first run. You don't need to pre-create them.

## Daily operation

### Letting it run

The triumvirate is designed to be long-running. Once the children are spawned, they wake on events (Zulip messages, filesystem changes) and do work whether you're watching or not. A typical pattern:

- Launch in the morning: `bun src/index.ts recipes/triumvirate.json`
- Detach at the end of the day: `/quit`, then `d`.
- Re-attach the next morning: run the same command. The conductor adopts the children and picks up where it left off.

### Checking progress

In any order:

- **TUI process view** (Tab or Ctrl+F) — are all three still green?
- **Conductor ask**: `status check` — plain-language summary.
- **Peek a child**: `/fleet peek miner` — live trace of what that child is doing, including inference rounds and tool calls.
- **Filesystem**: `ls -la output/`, `ls -la review-output/`, `ls -la knowledge-requests/` — the actual artifacts produced.

### When something breaks

If a child goes red / crashed:

1. `/fleet status <name>` — see the exit code and reason.
2. `tail -n 50 data/<name>/headless.log` — the child's runtime log.
3. `tail -n 50 data/<name>/startup.log` — earlier failures (API key check, recipe parse errors, etc.).
4. Fix whatever caused it.
5. `/fleet restart <name>` — bring it back.

If the conductor itself becomes unresponsive, `Ctrl+C` and relaunch. Children stay alive through a parent crash (they're detached), and the next conductor adopts them — so you don't lose in-flight work.

## Troubleshooting

| Problem | Fix |
|---|---|
| "ANTHROPIC_API_KEY not set" | Make sure `.env` is in the connectome-host directory and contains a valid key. Bun auto-loads it. |
| Child status stays "starting" forever | It timed out reaching ready. Check `data/<name>/headless.log` and `startup.log`. Most often: missing / invalid Zulip creds, or missing `../zulip-mcp/build/index.js`. |
| A child is crashed with "API error 401" | Zulip credentials are wrong or expired. Regenerate the bot's API key, update `.zuliprc`, `/fleet restart <child>`. |
| Clerk says "I don't see any messages in tracker-miner-f" | Check that the bot is actually subscribed to `#tracker-miner-f` in Zulip. Subscription happens on clerk startup via `ZULIP_SUBSCRIBE` — if the stream doesn't exist, it silently fails. |
| Miner or clerk launches keep crashing right away | Usually a missing `.zuliprc`, an unset env var, or an MCP server (Notion) that isn't running. Check `data/<child>/startup.log` first — it'll have a clear message like `references environment variable ${GITLAB_TOKEN} which is not set`. Either add the missing value to `.env` or delete the matching `mcpServers` block from the recipe. To isolate: run the recipe standalone with `bun src/index.ts recipes/knowledge-miner.json` (or `recipes/clerk.json`) in the same directory — the same errors come back in the interactive TUI. |
| "Recipe references environment variable ${FOO} which is not set" | The recipe has `${FOO}` in one of its values but your `.env` doesn't define `FOO`. Either add `FOO=...` to `.env` (if you want the source that references it) or delete the `mcpServers` / module block that uses it (if you don't). |
| Process view shows fewer children than expected | Check the conductor's own `data/tui-error.log` for errors during child spawn. One child failing shouldn't prevent the others from starting. |
| Children reappear after I thought I quit | If you chose `d` (detach) instead of `Y` (kill) last time, they're still running. `/fleet list` on startup will show them as adopted. Use `Y` to actually stop. |
| The bill is higher than expected | All four agents run concurrently and all except the reviewer (Sonnet) default to Opus. Switch the conductor or miner to Sonnet by editing the relevant recipe's `"model"` field. |

For issues specific to one agent in isolation (miner, reviewer), see [SETUP.md](./SETUP.md).

## Customization

### Adding or removing data sources later

Data sources for the miner (Zulip, Notion, GitLab) are configured in `recipes/knowledge-miner.json` under `mcpServers`. To add one you hadn't set up before or remove one you no longer want, edit that block following the instructions in [Step 6](#step-6-configure-the-miners-data-sources) and `/fleet restart miner` — the miner respawns with the new MCP server set.

### Running only part of the trio

Edit `recipes/triumvirate.json`. Set `"autoStart": false` on any child you want to keep dormant. You can still launch it on demand via `fleet--launch` from the conductor — the recipe is in the allowlist implicitly because it's listed under `children`.

### Adding a fourth (or fifth) specialist

1. Write a new child recipe, e.g. `recipes/archivist.json`.
2. Add it to `recipes/triumvirate.json` under `"children"`.
3. Update the conductor's system prompt in `recipes/triumvirate.json` so the conductor knows the new role exists (otherwise it'll be confused when the fleet view shows four names).
4. Restart the conductor.

If the new recipe isn't in the autoStart list but you want the conductor to be able to spawn it ad-hoc, add its path to `allowedRecipes` in `recipes/triumvirate.json`.

### Pointing at a different Zulip instance

Every agent that uses Zulip reads credentials from `.zuliprc`. Just swap the file (don't forget `chmod 600`).

### Changing where files go

The paths `./output/`, `./review-output/`, `./knowledge-requests/`, and `./input/` are declared in each child's recipe under `modules.workspace.mounts`. They're resolved relative to the conductor's working directory. If you want them elsewhere, edit the mounts in each affected child recipe (miner + reviewer + clerk) — they all have to agree, since that's how the three siblings communicate.

## Where to go next

- **Single-agent workflows** (just the miner, or a mining + reviewing pass without the clerk): see [SETUP.md](./SETUP.md).
- **Design rationale and protocol spec**: [HEADLESS-FLEET-PLAN.md](../HEADLESS-FLEET-PLAN.md) at the repo root.
- **Architecture overview for the host itself**: [ARCHITECTURE.md](../ARCHITECTURE.md).

## What this is *not*

The Triumvirate is a **production-leaning demo** of the fleet module. It works well for its specific three-role scenario. It is not:

- A general knowledge management platform — it's pipeline-shaped; you extract, you review, you answer, you file gaps.
- A drop-in replacement for a team wiki — the library it builds is Draft material until a human reviews the SME checklists.
- Self-maintaining — someone needs to close knowledge-request tickets and triage the reviewer's flagged findings.

Used within those bounds, it gives you a meaningful cut of what a specialist-agent team can actually do today, with enough structure that you can extend it to other three- and four-agent compositions (see the fleet module documentation for general composition patterns).
