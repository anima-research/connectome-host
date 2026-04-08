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
npm install
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
git clone https://github.com/anima-research/zulip_mcp.git ../zulip_mcp
cd ../zulip_mcp && npm install && npm run build && cd -
```

### GitLab

Works with both gitlab.com and self-hosted GitLab instances.

1. Go to your GitLab instance > **User Settings > Access Tokens**
2. Create a personal access token with scopes: `read_api`, `read_repository`
   - Add `api` scope if you want write access (creating issues, comments)
3. Note your token and your GitLab API URL

No separate installation needed — the recipe uses `npx` to run `@zereight/mcp-gitlab` on demand.

### Notion (via syncntn)

Notion access uses [syncntn](https://github.com/anima-research/syncntn), which syncs Notion pages into a local search index.

1. Set up syncntn following its README
2. Start the syncntn storage service (typically `http://localhost:8000`)
3. Note your workspace ID from the syncntn dashboard

```bash
git clone https://github.com/anima-research/syncntn.git ../syncntn
# Follow syncntn setup instructions
```

## Step 3: Configure the recipe

Copy the template recipe and fill in your credentials:

```bash
cp recipes/knowledge-miner.json my-recipe.json
```

Edit `my-recipe.json` and replace the placeholder values in `mcpServers`:

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
      }
    },
    "syncntn": {
      "command": "../syncntn/services/mcp/start_mcp_local.sh",
      "env": {
        "STORAGE_URL": "http://localhost:8000",
        "WORKSPACE_ID": "YOUR_WORKSPACE_ID"    // <-- replace this
      }
    },
    "gitlab": {
      "command": "npx",
      "args": ["-y", "@zereight/mcp-gitlab"],
      "env": {
        "GITLAB_PERSONAL_ACCESS_TOKEN": "YOUR_GITLAB_TOKEN",  // <-- replace
        "GITLAB_API_URL": "https://gitlab.example.com/api/v4" // <-- replace
      }
    }
  }
}
```

**Don't need all three?** Just remove the server entries you don't have. The agent works with any combination.

## Step 4: Set your API key

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Or add it to a `.env` file in the project directory.

## Step 5: Run

```bash
bun src/index.ts my-recipe.json
```

On subsequent runs, just `bun src/index.ts` — the recipe is remembered.

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
| `/mcp list` | Show connected data sources |
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

Instead of editing the recipe, you can override server config in `mcpl-servers.json`:

```bash
# Add or override a server (persists across restarts)
/mcp add gitlab npx -y @zereight/mcp-gitlab
/mcp env gitlab GITLAB_PERSONAL_ACCESS_TOKEN=glpat-xxx GITLAB_API_URL=https://gitlab.myco.com/api/v4
```

Changes require a restart to take effect.

### Read-only GitLab

If you want the agent to only read from GitLab (no issue creation, no MR comments):

```json
"gitlab": {
  "command": "npx",
  "args": ["-y", "@zereight/mcp-gitlab"],
  "env": {
    "GITLAB_PERSONAL_ACCESS_TOKEN": "YOUR_TOKEN",
    "GITLAB_API_URL": "https://gitlab.example.com/api/v4",
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

Or just quit — lessons are auto-exported on exit. This creates `./output/lessons-export.json` and `./output/lessons-export.md`.

### Step 2: Run the Reviewer

Use a separate data directory so the Reviewer gets its own sessions and Chronicle store:

```bash
DATA_DIR=./review-data bun src/index.ts recipes/knowledge-reviewer.json
```

The Reviewer reads the Miner's output (documents + exported lessons) and produces:
- **Critic findings** per document — internal contradictions, unsupported claims, missing markers
- **SME checklist** — a focused list of items for domain experts to verify

Ask it:
```
> Review all documents in input/. Generate the SME checklist.
```

### Step 3: Human review

Open `./review-output/sme-checklist.md`. It contains a prioritized list:
- **High risk** — `[GEN]` claims (general knowledge, no source)
- **Medium risk** — `[INF]` claims on system boundaries
- **Knowledge gaps** — `❓` markers needing expert input
- **Unmarked suspicious claims** — the most dangerous: plausible but unsourced

A domain expert can complete this checklist in 10-20 minutes without reading the full document.

### The confidence markers

The Knowledge Miner tags document claims with `[SRC]`, `[INF]`, `[GEN]`, or `❓`. The Reviewer audits these. If the Miner missed markers (unmarked claims that look like general knowledge), the Reviewer flags them.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `ANTHROPIC_API_KEY not set` | `export ANTHROPIC_API_KEY=sk-ant-...` |
| Zulip tools not appearing | Check `.zuliprc` path and that zulip_mcp is built |
| GitLab 401 errors | Verify your token has the right scopes and hasn't expired |
| syncntn connection refused | Make sure the syncntn storage service is running on the configured port |
| Agent seems stuck | Press `Esc` to interrupt, then ask it to try a different approach |
| Sub-agents not returning | Press `Tab` to check fleet view — they may still be working |
