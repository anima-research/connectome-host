# Knowledge Miner Setup Guide

A step-by-step guide to setting up ConnectomeHost with the knowledge-miner recipe for extracting structured knowledge from your organization's Zulip, Notion, and GitLab.

## What you get

An AI research agent that can:
- **Read** your team's Zulip conversations, Notion docs, and GitLab issues/MRs/code
- **Fork** parallel sub-agents to investigate multiple sources simultaneously
- **Extract** persistent lessons — tagged, scored knowledge that survives across sessions
- **Write** reports and analysis documents to disk
- **Cross-reference** information across all three platforms

## Prerequisites

| Tool | Why | Install |
|------|-----|---------|
| [Node.js](https://nodejs.org/) 20+ | Runtime | `nvm install 20` or download from nodejs.org |
| [Bun](https://bun.sh/) | App runner | `curl -fsSL https://bun.sh/install \| bash` |
| [Anthropic API key](https://console.anthropic.com/) | LLM access | Sign up at console.anthropic.com |

## Step 1: Install ConnectomeHost

```bash
git clone https://github.com/anima-research/connectome-host.git
cd connectome-host
bun install        # npm install also works
```

## Step 2: Set up your data sources

You need credentials for each platform you want to connect. You can start with just one and add more later — the agent adapts to whatever tools are available.

### Zulip

You need a `.zuliprc` file with your bot or user credentials.

1. In your Zulip organization, go to **Settings > Personal > API key**
2. Download the `.zuliprc` file, or create one manually:

```ini
[api]
email=your-bot@your-org.zulipchat.com
key=YOUR_ZULIP_API_KEY
site=https://your-org.zulipchat.com
```

3. Place it in the connectome-host directory:

```bash
cp ~/Downloads/.zuliprc ./.zuliprc
```

4. Install the Zulip MCP server:

```bash
git clone https://github.com/antra-tess/zulip_mcp.git ../zulip_mcp
cd ../zulip_mcp && npm install && npm run build && cd -
```

### GitLab

Works with both gitlab.com and self-hosted GitLab instances.

1. Go to your GitLab instance > **User Settings > Access Tokens**
2. Create a personal access token with scopes: `read_api`, `read_repository`
   - Add `api` scope if you want write access (creating issues, comments)
3. Note your token and your GitLab API URL — they go in `.env` in Step 3

No separate installation needed — the recipe uses `npx` to run `@zereight/mcp-gitlab` (pinned to `2.1.25`) on demand.

### Notion (optional, via an MCP server — not included by default)

The recipe ships **without** a Notion server: the adapter its prompt was developed against (`syncntn`) is not publicly available. If you want the agent to read your Notion workspace, add an `mcpServers` entry pointing at any MCP server that exposes Notion search and page-read tools. The entry name `syncntn` is just a label, but the prompt depends on it: the agent sees each tool as `mcpl--<entry name>--<tool>`, and the system prompt references `mcpl--syncntn--search_pages`, `mcpl--syncntn--get_page_markdown` and friends. Any Notion MCP server works if you name its entry `syncntn` and it exports tools with those names (`search_pages`, `get_page_markdown`, …). If its tool names differ, update the prompt to match, or accept that the agent will discover the tools under whatever names they export.

Typical setup:

1. Install and start your Notion MCP server somewhere the recipe can launch it.
2. Note any configuration it needs (API credentials, workspace ID, storage URL).
3. Add a `syncntn` block with those values to the recipe in Step 3 below.

Don't have a Notion MCP server? Skip this — the agent adapts and works with whatever sources remain.

### DuckDuckGo web search (optional, but enabled by default)

The recipe ships with [`nickclyde/duckduckgo-mcp-server`](https://github.com/nickclyde/duckduckgo-mcp-server) wired as `ddg`. It gives the miner one public source — handy when a question has a regulatory, standards-body, or vendor-spec component the internal sources can't answer on their own. The agent emits `[WEB: <url>]` for any claim backed by a web hit, so the citation chain stays auditable.

Install once as a sibling of `connectome-host/`:

```bash
cd ..
git clone https://github.com/nickclyde/duckduckgo-mcp-server.git
cd duckduckgo-mcp-server
python3 -m venv .venv
.venv/bin/pip install -e .
cd ../connectome-host
```

The recipe expects the entry-point script at `../duckduckgo-mcp-server/.venv/bin/duckduckgo-mcp-server`. No API key needed. Don't want public-web access? Remove the `ddg` block from the recipe.

### Scribe — audio/video transcription (optional, not included by default)

The miner's prompt also knows how to drive [`dariakroshka/scribe-mcp`](https://github.com/dariakroshka/scribe-mcp) for transcribing recordings. It needs a Gemini API key (media is uploaded to Google's Gemini API) and a sibling checkout, so the shipped recipe omits it. To enable: clone scribe-mcp as a sibling of `connectome-host/`, run `bun install` in it, add a `scribe` block under `mcpServers` (see the [Triumvirate guide's Scribe section](./TRIUMVIRATE-SETUP.md#scribe--audiovideo-transcription-optional-off-by-default) for the exact JSON), and set `GEMINI_API_KEY` in `.env`.

## Step 3: Configure the recipe

The shipped recipe holds no secrets: it reads them from the environment through `${VAR}` placeholders, substituted when the recipe loads (`${VAR}` is required; `${VAR:-default}` falls back to the default when `VAR` is unset or empty). Put the GitLab values in `.env` in the project directory:

```ini
GITLAB_TOKEN=glpat-...
GITLAB_API_URL=https://gitlab.example.com/api/v4
```

If a required variable is unset, the recipe refuses to load with `Recipe "…" references environment variable ${GITLAB_TOKEN} which is not set.` — set it, or remove the block that uses it.

To change which sources are wired in, copy the template and edit the copy:

```bash
cp recipes/knowledge-miner.json my-recipe.json
```

Its `mcpServers` look like this (the shipped entries also carry `source` blocks — install metadata for build tooling, ignored at runtime):

```jsonc
{
  "mcpServers": {
    "zulip": {
      "command": "node",
      "args": ["../zulip_mcp/build/index.js"],
      "env": {
        "ENABLE_ZULIP": "true",
        "ENABLE_DISCORD": "false",
        "ZULIP_RC_PATH": "./.zuliprc"          // path to your .zuliprc
      },
      "channelSubscription": "manual"
    },
    "gitlab": {
      "command": "npx",
      "args": ["-y", "@zereight/mcp-gitlab@2.1.25"],
      "env": {
        "GITLAB_PERSONAL_ACCESS_TOKEN": "${GITLAB_TOKEN}",   // from .env
        "GITLAB_API_URL": "${GITLAB_API_URL}"                // from .env
      }
    },
    "ddg": {
      "command": "../duckduckgo-mcp-server/.venv/bin/duckduckgo-mcp-server"
      // no creds; public web. Remove this block to disable web search.
    },
    // Optional — NOT in the shipped recipe. Add only if you set up a
    // Notion MCP server (see Step 2 above), and set NOTION_STORAGE_URL /
    // NOTION_WORKSPACE_ID in .env:
    "syncntn": {
      "command": "../your-notion-mcp/start.sh",
      "env": {
        "STORAGE_SERVICE_URL": "${NOTION_STORAGE_URL}",
        "WORKSPACE_ID": "${NOTION_WORKSPACE_ID}"
      }
    }
  }
}
```

**Don't need all of them?** Just remove the server entries you don't have. The agent works with any combination.

## Step 4: Set your API key

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Or add it to a `.env` file in the project directory.

## Step 5: Run

```bash
bun src/index.ts my-recipe.json      # or recipes/knowledge-miner.json if you didn't copy it
```

On subsequent runs, just `bun src/index.ts` — the recipe is remembered.

The recipe doesn't pin a model, so the agent runs on `claude-opus-4-6` unless you set `MODEL` in `.env`. Besides writing reports to `./output/`, it creates and watches `./knowledge-requests/` (a new ticket file there wakes it — that's how the [Triumvirate](./TRIUMVIRATE-SETUP.md)'s clerk hands it work) and watches `./library-approved/` read-only for human-approved material (not created for you).

## Using the agent

Once running, you'll see a terminal interface. Type natural language requests:

```
> Map out the key architectural decisions made in the last month across Zulip and GitLab

> What does the team's Notion say about the deployment process? Cross-reference with
  recent Zulip discussions about deploy failures.

> Find all open GitLab issues tagged "tech-debt" and check if any were discussed in Zulip.
  Create a summary report.
```

The agent will:
1. **Scout** available sources (list Zulip streams, search Notion, browse GitLab)
2. **Fork** sub-agents to read specific threads, pages, and issues in parallel
3. **Synthesize** findings and cross-reference across platforms
4. **Extract** lessons and optionally write reports to `./output/`

### Useful commands

| Command | What it does |
|---------|-------------|
| `Tab` | Toggle fleet view — see sub-agents working in parallel |
| `/lessons` | Show all extracted knowledge, sorted by confidence |
| `/status` | Agent state, session info |
| `/undo` | Roll back the last agent turn |
| `/mcp list` | Show the servers saved in `mcpl-servers.json` (not the recipe's `mcpServers`) |
| `/newtopic [context]` | Reset context window for a new topic (compresses old context) |
| `/session new` | Start a fresh session (lessons persist) |
| `Esc` | Interrupt the agent mid-turn |

### Tips

- **Start broad, then narrow.** Ask "what streams/projects exist?" before diving deep.
- **Let it fork.** The agent is designed to run 2-4 sub-agents in parallel. Don't micromanage.
- **Check lessons periodically.** `/lessons` shows what's been extracted. You can ask the agent to revise or merge lessons.
- **Use the workspace.** Ask the agent to "write a report" and it produces files in `./output/`.
- **Switch topics cleanly.** Use `/newtopic` when changing research direction — it compresses old context and frees up the context window. Cheaper than a new session, and lessons carry over either way.

## Customization

### Using only some sources

Remove MCP server entries from the recipe for sources you don't have. The system prompt automatically adapts — the agent only uses tools that are available.

### Overriding servers at runtime

Instead of editing the recipe, you can keep a server's launch command and credentials in `mcpl-servers.json` (in the directory you launch from):

```bash
# Add or override a server (persists across restarts)
/mcp add gitlab npx -y @zereight/mcp-gitlab@2.1.25
/mcp env gitlab GITLAB_PERSONAL_ACCESS_TOKEN=glpat-xxx GITLAB_API_URL=https://gitlab.myco.com/api/v4
```

A file entry is used only when the recipe names the same id under `mcpServers` (the miner recipe does name `gitlab`). For that id the file supplies `command`, `args` and `env`; the recipe entry can still override policy fields such as `channelSubscription`, `toolPrefix`, tool/feature-set filters and reconnect settings. An empty `enabledFeatureSets: []` in either file enables no feature sets rather than all of them; see [Feature sets and tool names](../README.md#feature-sets-and-tool-names). The recipe is still loaded with `${VAR}` substitution first, so while its `gitlab` block references `${GITLAB_TOKEN}`, that variable must be set (or the `env` removed from the recipe's block) even though the file's values are the ones used.

A file entry can also name a network server with `url` (plus `token` or `access`), or run its `command` as a modern MCP server with `"protocol": "modern"`. An `http(s)://` URL is a modern MCP server over Streamable HTTP, and `ws(s)://` is MCPL over WebSocket. [Modern MCP servers](../README.md#modern-mcp-servers) covers what changes for them. An entry the framework would refuse stops startup, with the file and id named in the error.

Changes require a restart to take effect.

### Read-only GitLab

If you want the agent to only read from GitLab (no issue creation, no MR comments):

```json
"gitlab": {
  "command": "npx",
  "args": ["-y", "@zereight/mcp-gitlab@2.1.25"],
  "env": {
    "GITLAB_PERSONAL_ACCESS_TOKEN": "${GITLAB_TOKEN}",
    "GITLAB_API_URL": "${GITLAB_API_URL}",
    "GITLAB_READ_ONLY_MODE": "true"
  }
}
```

### Limiting GitLab tools

To only expose certain tool categories (e.g., issues and merge requests, not pipelines or wiki):

```json
"env": {
  "GITLAB_TOOLSETS": "issues,merge_requests,search,projects"
}
```

## Reviewing knowledge quality

After the Knowledge Miner produces documents, run the Reviewer agent for a quality audit.

### Step 1: Export lessons

In the Knowledge Miner session:
```
/export
```

Or just `/quit` — it exports lessons on the way out. This creates `./output/lessons-export.json` and `./output/lessons-export.md`.

Before quitting, run `/session new` in the miner too. Both agents use the same data dir (`./data` by default), and an agent launched there resumes whichever session is active — without this, the reviewer would open inside the miner's session. (`/session switch` brings the mining session back later.)

### Step 2: Run the Reviewer

```bash
bun src/index.ts recipes/knowledge-reviewer.json
```

The Reviewer reads the documents in `./output/`, mounted read-only as `library-mined/`, and sees the miner's lessons directly: lessons live in `./data/lessons.json`, shared by every session in the same data dir (`library-mined/lessons-export.md` is the human-readable copy). It produces:
- **Critic findings** per document — internal contradictions, unsupported claims, missing markers
- **SME checklist** — a focused list of items for domain experts to verify

Ask it:
```
> Review all documents in library-mined/. Generate the SME checklist.
```

It may start before you ask: a new session's first scan of `library-mined/` reports each existing `*.md` there as new, and the reviewer's `new-reports` wake policy acts on those.

### Step 3: Human review

Open `./review-output/sme-checklist.md`. It contains a prioritized list:
- **High risk** — `[GEN]` claims (general knowledge, no source)
- **Medium risk** — `[INF]` claims on system boundaries
- **Knowledge gaps** — `❓` markers needing expert input
- **Unmarked suspicious claims** — the most dangerous: plausible but unsourced

A domain expert can complete this checklist in 10-20 minutes without reading the full document.

### The confidence markers

The Knowledge Miner tags document claims with `[SRC]`, `[WEB]`, `[INF]`, `[GEN]`, or `❓`. The Reviewer audits these. If the Miner missed markers (unmarked claims that look like general knowledge), the Reviewer flags them.

- `[SRC: source]` — direct quote from an **internal** system (Zulip, Notion, GitLab)
- `[WEB: url]` — quote from a public web page via the DuckDuckGo MCP; the URL is the citation
- `[INF]` — inferred from multiple sources
- `[GEN]` — general domain knowledge with no citation (prefer `[WEB]` when checkable)
- `❓` — knowledge gap; needs a human expert

Internal `[SRC]` always wins over `[WEB]` when both speak to the same org-specific term — the miner is instructed to keep the two meanings visibly separate, and the reviewer flags collisions.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Missing ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN)` | `export ANTHROPIC_API_KEY=sk-ant-...`, or put it in `.env` |
| `Recipe "…" references environment variable ${…} which is not set` | Add the variable to `.env`, or remove the `mcpServers` block that uses it |
| Zulip tools not appearing | Check `.zuliprc` path and that zulip_mcp is built |
| GitLab 401 errors | Verify your token has the right scopes and hasn't expired |
| Notion tools not appearing or connection refused | Make sure your Notion MCP server is running and reachable at the command/URL the recipe expects |
| Agent seems stuck | Press `Esc` to interrupt, then ask it to try a different approach |
| Sub-agents not returning | Press `Tab` to check fleet view — they may still be working |
