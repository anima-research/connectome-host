# Triumvirate Setup Guide

A step-by-step guide to setting up the **Knowledge Mining Triumvirate** — three specialist AI agents (miner, reviewer, clerk) running under a single conductor in one terminal. Each agent has its own recipe, its own Chronicle data store, and its own role in a shared knowledge pipeline.

This guide assumes you're comfortable in a terminal and editing JSON files, but not that you know TypeScript or the internals of the connectome framework.

## What you get

One terminal, four AI agents cooperating:

- **Conductor** (in the TUI, the one you talk to) — supervises the other three, reports status, intervenes only when asked.
- **Miner** — reads your team's Zulip conversations, extracts structured knowledge, writes **Draft** documents to `library-mined/`.
- **Reviewer** — critiques the miner's drafts for accuracy, flags unsupported claims, writes **reviews** and SME checklists to `library-reviewed/`.
- **Clerk** — sits on the Zulip channel you name in `ZULIP_CHANNEL` (`#${ZULIP_CHANNEL}` below), answers questions by quoting the library, files knowledge-request tickets when the library is insufficient.

The three specialists coordinate with each other via a **shared filesystem** and **shared Zulip channels** — not through the conductor. Files flow: `library-mined/` → `library-reviewed/` (via reviewer) → cited in clerk's Zulip answers. Knowledge gaps flow: clerk → `knowledge-requests/` (the miner wakes on each new ticket and mines it).

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

### The clerk's channel (`#${ZULIP_CHANNEL}`)

The clerk agent staffs one specific channel — whichever one you name in `ZULIP_CHANNEL` (Step 5). It responds to questions posted there by quoting the library.

1. In Zulip, create a new channel for it (any name, e.g. `knowledge-desk`); you'll put that name in `.env` in Step 5.
2. Subscribe your bot account to that channel.
3. Optionally: tell your team this is where they ask library questions.

### Channels for the miner to read

The miner reads other channels to extract knowledge. By default, the recipe has the miner starting with manual channel subscription — meaning the agent itself decides which channels to listen to based on the conversation with the user. You don't need to pre-subscribe it anywhere; you'll direct it in the TUI.

If you want some channels open from the start, edit `recipes/knowledge-miner.json` → `mcpServers.zulip.channelSubscription` and replace `"manual"` with an allow-list such as `["zulip:platform-design"]` (the same `zulip:<stream>` form `clerk.json` uses). The list only seeds a new session; after that the agent opens and closes channels itself (`channel_open` / `channel_close`).

## Step 5: Fill in secrets in `.env`

Secrets — API keys, tokens, service endpoints — live in `.env` at the connectome-host root. Recipes in `recipes/` reference them via `${VAR_NAME}` placeholders, and the framework substitutes at recipe-load time. Your recipe files stay commit-safe; your secrets stay gitignored.

Copy the example and edit:

```bash
cp .env.example .env
```

Required for every run (`.env.example` has no `ZULIP_CHANNEL` line — add it yourself):

```ini
ANTHROPIC_API_KEY=sk-ant-...

# The Zulip channel the clerk staffs.  Set to the channel name
# you created in Step 4 (e.g. `tracker-miner-f`, `knowledge-desk`,
# `q-and-a` — whatever you picked).  clerk.json and the conductor's
# prompt in triumvirate.json substitute this at load time; if it's
# unset, neither recipe loads.
ZULIP_CHANNEL=your-channel-name
```

Optional — **only** if you want the miner to extract from GitLab (otherwise remove the `gitlab` block from `recipes/knowledge-miner.json` and skip these):

```ini
# GitLab (knowledge-miner.json: gitlab)
GITLAB_TOKEN=glpat-...
GITLAB_API_URL=https://gitlab.example.com/api/v4
```

Strongly recommended — the conductor's web UI is protected by Basic-Auth that defaults to `admin` / `admin`, and `triumvirate.json` binds it on **all interfaces** (`0.0.0.0:7340`). From the first launch, anyone who can reach this machine on port 7340 — including other devices on the same Wi-Fi — can log in with those defaults and see and steer every agent. Set your own credentials before launching:

```ini
WEBUI_USERNAME=...
WEBUI_PASSWORD=...
```

If you only need the UI on this machine, also bind it to loopback: in `recipes/triumvirate.json`, add `"host": "127.0.0.1"` to the `webui` block. Loopback is the one bind the server will start on without `basicAuth`, but this recipe still configures it, and configured credentials are enforced on every bind — so you'll still get a login prompt. Remove the `basicAuth` block as well if you want a credential-free local UI.

Bun auto-loads `.env`, so nothing else to wire. If a recipe references a `${VAR}` you haven't set, the child's startup will fail with a clear message telling you which variable is missing and which recipe referenced it.

## Step 6: Decide which data sources you want

The miner child uses `recipes/knowledge-miner.json`, which comes pre-wired to talk to **Zulip, GitLab, and DuckDuckGo** (public web); **Notion** and **Scribe** (audio/video transcription) connections can be added — see their subsections below. The recipe itself references credentials via `${VAR}` placeholders — you don't edit the recipe to fill in secrets; you set the env vars in Step 5 and the framework substitutes at load time.

You decide which sources are active by whether you **set the matching env vars** and whether you **keep the matching mcpServers block in the recipe**.

### Zulip (required, already configured)

You set this up in Steps 2–4. The entry under `mcpServers.zulip` uses `../zulip_mcp/build/index.js` and reads `./.zuliprc`. Nothing to change.

### GitLab (optional)

To enable: create a GitLab Personal Access Token (User Settings → Access Tokens) with scopes `read_api` and `read_repository` (add `api` for write access to issues/comments), and set these in `.env`:

```ini
GITLAB_TOKEN=glpat-...
GITLAB_API_URL=https://gitlab.example.com/api/v4
```

No separate install — the recipe runs `npx @zereight/mcp-gitlab` (pinned to `2.1.25`) on demand.

To disable: remove the `gitlab` block from `recipes/knowledge-miner.json`. If you leave it in but don't set the env vars, the child will fail to start with a message like `Recipe "recipes/knowledge-miner.json" references environment variable ${GITLAB_TOKEN} which is not set.` — that's the system telling you to either fill in the env var or delete the block.

### Notion (optional, off by default)

The recipe ships **without** a Notion server — the adapter it was developed against (`syncntn`) is not publicly available, so a default block would only produce a startup failure. The miner's system prompt still describes the `mcpl--syncntn--*` tools; the agent simply won't have them until you wire a server in.

To enable: install a Notion MCP server (any server whose tool names match what the prompt references — see [SETUP.md → Notion](./SETUP.md#notion-optional-via-an-mcp-server--not-included-by-default) for selection caveats), then add a block to `recipes/knowledge-miner.json` under `mcpServers`:

```jsonc
"syncntn": {
  "command": "../your-notion-mcp/start.sh",   // however your server is launched
  "env": {
    "STORAGE_SERVICE_URL": "${NOTION_STORAGE_URL}",
    "WORKSPACE_ID": "${NOTION_WORKSPACE_ID}"
  }
}
```

and set the referenced vars in `.env`:

```ini
NOTION_STORAGE_URL=http://localhost:8000
NOTION_WORKSPACE_ID=...
```

### DuckDuckGo web search (optional, enabled by default)

The miner is wired to [`nickclyde/duckduckgo-mcp-server`](https://github.com/nickclyde/duckduckgo-mcp-server) as `ddg`. No API key — DuckDuckGo's public HTML search, scraped at request time.

To enable: install the server once as a sibling of `connectome-host/`:

```bash
cd ..
git clone https://github.com/nickclyde/duckduckgo-mcp-server.git
cd duckduckgo-mcp-server
python3 -m venv .venv
.venv/bin/pip install -e .
cd ../connectome-host
```

The recipe expects the entry-point at `../duckduckgo-mcp-server/.venv/bin/duckduckgo-mcp-server`. No env vars required.

Web hits get tagged `[WEB: <url>]` in mined reports — internal `[SRC]` always wins over `[WEB]` for org-specific terms; the reviewer flags collisions.

To disable: remove the `ddg` block from `recipes/knowledge-miner.json`. The agent will skip the public web.

### Scribe — audio/video transcription (optional, off by default)

The miner's prompt knows how to use [`dariakroshka/scribe-mcp`](https://github.com/dariakroshka/scribe-mcp) to transcribe recordings (via Google's Gemini API — media leaves your machine). The recipe ships without the block: it requires a Gemini API key and a sibling checkout, neither of which a demo should demand.

To enable: install the server as a sibling of `connectome-host/`:

```bash
cd ..
git clone https://github.com/dariakroshka/scribe-mcp.git
cd scribe-mcp
bun install
cd ../connectome-host
```

then add this block to `recipes/knowledge-miner.json` under `mcpServers`:

```jsonc
"scribe": {
  "command": "bun",
  "args": ["../scribe-mcp/src/index.ts"],
  "env": {
    "GEMINI_API_KEY": "${GEMINI_API_KEY}",
    "NOTION_API_KEY": "${NOTION_API_KEY:-}",           // only mcpl--scribe--scribe_notion_page needs it
    "SCRIBE_GLOSSARY_PATH": "./input/glossary.txt",
    "SCRIBE_GLOSSARY_URL": "${SCRIBE_GLOSSARY_URL:-}"  // optional domain glossary
  },
  "source": {
    "url": "https://github.com/dariakroshka/scribe-mcp.git",
    "install": { "runtime": "bun", "run": "bun install --frozen-lockfile" },
    "inContainer": { "path": "/scribe-mcp" }
  }
}
```

and set `GEMINI_API_KEY=...` in `.env`.

### Summary table

| Source | Block in recipe? | Env vars needed |
|---|---|---|
| Zulip | Yes (default) | (configured via `.zuliprc`, no `${VAR}`) |
| GitLab | Yes (default) — remove if not using | `GITLAB_TOKEN`, `GITLAB_API_URL` |
| Notion | **No** — add a `syncntn` block if using | `NOTION_STORAGE_URL`, `NOTION_WORKSPACE_ID` |
| DuckDuckGo | Yes (default) — remove if not using | none (no API key) |
| Scribe | **No** — add a `scribe` block if using | `GEMINI_API_KEY` (+ optional `NOTION_API_KEY`, `SCRIBE_GLOSSARY_URL`) |

### Tweaks you can still make to the recipe files

You can also edit the recipe files if you want to:

- **Rename the clerk's channel** — change `ZULIP_CHANNEL` in `.env`. `recipes/clerk.json` uses it everywhere the channel appears: `ZULIP_SUBSCRIBE`, the `channelSubscription` allow-list, the typing-indicator channel and the `tracker-channel` wake policy. An existing clerk session keeps the `tracker-channel` policy it was first seeded with (restarts only add policies that are missing by name), so ask the clerk (`@clerk …`) to update that policy with its `wake_add_rule` tool.
- **Swap a model** — the conductor and clerk pin `"model": "claude-opus-4-6"`, the reviewer `claude-sonnet-4-6`; change the field in the relevant recipe. `recipes/knowledge-miner.json` has no `model` field, so the miner runs `claude-opus-4-6` until you add one. Setting `MODEL` in `.env` overrides the model of every agent — the children inherit the conductor's environment.
- **Adjust autoStart** — in `recipes/triumvirate.json`, set `"autoStart": false` on any child if you want to leave them inactive until you (or the conductor) explicitly launch them.

## Step 7: First launch

```bash
bun src/index.ts recipes/triumvirate.json
```

What you'll see:

1. The TUI comes up with the "Knowledge Mining Triumvirate" banner.
2. Over the next 30–60 seconds, the three children spawn in the background. Each one starts its own connectome-host process, connects to the Anthropic API, and boots its Zulip / workspace machinery.
3. Press **Tab** to switch to the **fleet** view — one tree with the conductor at the top and the three children under it, each with its status. All three should reach **ready** (or show what they're busy with). If any show **crashed** (red), jump to Troubleshooting.
4. Ask the conductor `are all three ready?` — it'll run `fleet--list` and confirm. This also serves as a quick "am I set up correctly" smoke test.

The conductor also serves a **web UI** on port 7340 (all interfaces, Basic-Auth). Credentials default to `admin` / `admin` unless you set `WEBUI_USERNAME` / `WEBUI_PASSWORD` in `.env` — see Step 5. Open `http://localhost:7340` to watch the fleet from a browser.

### The four view modes

**Tab** (or **Ctrl+F**, or `/fleet view`) toggles between chat and the fleet view. The two peek views are reached from the fleet view (or with `/fleet peek`).

| View | What it shows |
|---|---|
| **chat** | Your conversation with the conductor |
| **fleet** | One tree: the conductor (plus any in-process subagents it forks — none here, since `triumvirate.json` sets `"subagents": false`), then the three children, each of which unfolds into its own agents and subagents |
| **peek-proc** | Live event stream from one child (press `p` on the child, or `/fleet peek <name>`); `p` on one of a child's agents narrows the stream to that agent |
| **peek** | Live stream from a local in-process subagent (`p` on a subagent) — unused here, since the conductor has none |

Fleet-view keys: **↑/↓** move, **Enter** or **→** fold/unfold, **←** collapse, **p** peek, **Del/Backspace** stop the selected child, **r** restart it, **Esc** back to chat. In a peek view, **Esc** or **p** returns to the fleet view.

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
> @clerk Post a status message in #${ZULIP_CHANNEL} saying the library is being rebuilt.
> @reviewer Re-check the packet-pipeline doc against the latest lessons.
```

The conductor doesn't see these messages or their responses.

### 3. Slash commands

| Command | What it does |
|---|---|
| `/fleet list` | One-line status for every child |
| `/fleet view` | Open the fleet view (same as Tab) |
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
Stop them before exit? [y/N/d]  — y=kill gracefully, d=detach and leave running, anything else cancels
```

- **y** (or `yes`, or `/quit` again) — stop everything cleanly and exit. All children shut down.
- **n** (or just Enter) — cancel the exit. The TUI stays up. If you type an ordinary message at the prompt, the exit is cancelled and your text is put back in the input.
- **d** — exit the TUI but leave the three children running in the background. They'll keep doing whatever they were doing. The next time you run `bun src/index.ts recipes/triumvirate.json`, the new conductor will **adopt** them — re-attach to the running children instead of respawning duplicates.

This is the "leave the bots working overnight, come back tomorrow" workflow.

**Ctrl+C** brings up the same prompt. Pressing Ctrl+C again while it's showing exits and stops the children.

## What the agents actually do

### Miner

- Uses `recipes/knowledge-miner.json`. Reads whatever data sources you configured in Step 6 (Zulip always; optionally Notion, GitLab, and DuckDuckGo web search).
- Wakes automatically when the clerk files a new ticket in `knowledge-requests/` — the miner's wake policy watches that directory.
- Forks sub-agents to read across sources in parallel, extracts decisions / patterns / people / processes.
- Writes Draft documents into `./output/` — one `<request_id>.md` per ticket — which the reviewer and clerk see as `library-mined/`, and creates structured "lessons" in its own data dir.
- Tags every non-trivial claim with confidence markers — `[SRC: ...]` for internal sources, `[WEB: ...]` for public web hits, plus `[INF]`, `[GEN]`, and `❓`. These propagate all the way to the final library.

### Reviewer

- Watches `library-mined/` for new/changed documents.
- When a document appears, the reviewer reads it, cross-references with the lessons it knows about, and flags:
  - Internal contradictions
  - Unsupported claims
  - Missing confidence markers
  - Unmarked claims that look like invented general knowledge
- Writes its findings (`review-<doc>.md`, carrying over the miner report's ticket provenance) to `library-reviewed/`, plus an SME checklist that a human domain expert can complete in 10–20 minutes without reading the full document.

See [the Knowledge Reviewer section of SETUP.md](./SETUP.md#reviewing-knowledge-quality) for more detail on the confidence-marker system and SME checklist format.

### Clerk

- Sits on `#${ZULIP_CHANNEL}`.
- When someone posts a question there, the clerk:
  1. Searches `library-approved/`, `library-reviewed/` and `library-mined/` for relevant material.
  2. Posts a short, cited answer back in the channel.
  3. If the library didn't have the answer, writes a `knowledge-requests/YYYY-MM-DD-slug.md` ticket and tells the asker.
- Knows to prefer approved material, then reviewed over mined-only material, and to flag disagreements between them.
- Wakes when a new review lands in `library-reviewed/`; if it answers one of its tickets, pings the asker on the original Zulip topic.

Tickets in `knowledge-requests/` are the signal for the miner: the open tickets say "here's what the organization wants to know."

### Conductor

- Doesn't mine, review, or answer. Its job is process supervision plus being a conversational surface for you.
- Default posture: quiet. It doesn't narrate what the children are doing — the fleet view already shows that.
- Speaks when you ask, or when it sees a child crash.

## Directory map

After the first run, your connectome-host directory will look like:

```
connectome-host/
  .env                              (you created this — has API key)
  .zuliprc                          (you placed this — Zulip creds)
  recipes/
    triumvirate.json                (conductor recipe)
    knowledge-miner.json            (miner recipe)
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
  library-approved/                 (human-approved material — all three read it; you create and fill it)
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

- **TUI fleet view** (Tab or Ctrl+F) — are all three still up, none red / crashed?
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

If the conductor itself becomes unresponsive, `Ctrl+C` brings up the exit prompt — answer `d` to keep the children running, then relaunch; the next conductor adopts them, so you don't lose in-flight work. An orderly exit that isn't a detach (`y`, or a second Ctrl+C) stops the children. They outlive the conductor otherwise only if its process dies without an orderly exit — e.g. you `kill -9` a TUI that no longer reacts to keys — and the next conductor adopts those too.

## Troubleshooting

| Problem | Fix |
|---|---|
| `Missing ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN)` | Make sure `.env` is in the connectome-host directory and contains a valid key. Bun auto-loads it. |
| Child status stays "starting" forever | It timed out reaching ready. Check `data/<name>/headless.log` and `startup.log`. Most often: missing / invalid Zulip creds, or missing `../zulip_mcp/build/index.js`. |
| A child is crashed with "API error 401" | Zulip credentials are wrong or expired. Regenerate the bot's API key, update `.zuliprc`, `/fleet restart <child>`. |
| Clerk says "I don't see any messages in ${ZULIP_CHANNEL}" | Check that the bot is actually subscribed to `#${ZULIP_CHANNEL}` in Zulip. Subscription happens on clerk startup via `ZULIP_SUBSCRIBE` — if the stream doesn't exist, it silently fails. |
| Miner or clerk launches keep crashing right away | Usually a missing `.zuliprc`, an unset env var, or an MCP server (Notion) that isn't running. Check `data/<child>/startup.log` first — it'll have a clear message like `references environment variable ${GITLAB_TOKEN} which is not set`. Either add the missing value to `.env` or delete the matching `mcpServers` block from the recipe. To isolate: run the recipe standalone with `bun src/index.ts recipes/knowledge-miner.json` (or `recipes/clerk.json`) in the same directory — the same errors come back in the interactive TUI. |
| "Recipe references environment variable ${FOO} which is not set" | The recipe has `${FOO}` in one of its values but your `.env` doesn't define `FOO`. Either add `FOO=...` to `.env` (if you want the source that references it) or delete the `mcpServers` / module block that uses it (if you don't). |
| Fleet view shows fewer children than expected | Check the conductor's own `data/tui-error.log` for errors during child spawn. One child failing shouldn't prevent the others from starting. |
| Children reappear after I thought I quit | If you chose `d` (detach) instead of `y` (kill) last time, they're still running. `/fleet list` on startup will show them as adopted. Use `y` to actually stop. |
| The bill is higher than expected | All four agents run concurrently and all except the reviewer (Sonnet) run on Opus. Switch the conductor or clerk to Sonnet by editing its recipe's `"model"` field; for the miner, add a `"model"` field to `knowledge-miner.json` (it has none, so it falls back to `claude-opus-4-6`). |

For issues specific to one agent in isolation (miner, reviewer), see [SETUP.md](./SETUP.md).

## Customization

### Adding or removing data sources later

Data sources for the miner (Zulip, Notion, GitLab) are configured in `recipes/knowledge-miner.json` under `mcpServers`. To add one you hadn't set up before or remove one you no longer want, edit that block following the instructions in [Step 6](#step-6-decide-which-data-sources-you-want) and `/fleet restart miner` — the miner respawns with the new MCP server set.

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

The paths `./output/`, `./review-output/`, `./knowledge-requests/`, `./library-approved/`, and `./input/` are declared in each child's recipe under `modules.workspace.mounts`. They're resolved relative to the conductor's working directory. If you want them elsewhere, edit the mounts in each affected child recipe (miner + reviewer + clerk) — they all have to agree, since that's how the three siblings communicate.

## Where to go next

- **Single-agent workflows** (just the miner, or a mining + reviewing pass without the clerk): see [SETUP.md](./SETUP.md).
- **How the three hand work to each other through files** (mounts, wake policies, the ticket contract): [LIBRARY-PIPELINE.md](../docs/LIBRARY-PIPELINE.md).
- **Headless mode and the fleet protocol**: [fleet-protocol.md](../docs/fleet-protocol.md). The original design rationale is kept in [history/HEADLESS-FLEET-PLAN.md](../docs/history/HEADLESS-FLEET-PLAN.md).
- **Architecture overview for the host itself**: [ARCHITECTURE.md](../ARCHITECTURE.md).

## What this is *not*

The Triumvirate is a **production-leaning demo** of the fleet module. It works well for its specific three-role scenario. It is not:

- A general knowledge management platform — it's pipeline-shaped; you extract, you review, you answer, you file gaps.
- A drop-in replacement for a team wiki — the library it builds is Draft material until a human reviews the SME checklists.
- Self-maintaining — someone needs to close knowledge-request tickets and triage the reviewer's flagged findings.

Used within those bounds, it gives you a meaningful cut of what a specialist-agent team can actually do today, with enough structure that you can extend it to other three- and four-agent compositions (see the fleet module documentation for general composition patterns).
