# The Library Pipeline

A guide to running connectome-host as a self-dispatching, three-agent knowledge pipeline: **Clerk**, **Miner**, and **Reviewer** coexisting as independent processes, coordinating through a shared filesystem.

This is a non-obvious way to use connectome-host. Most recipes are one-shot: you start a session, talk to the agent, it does the work. The library pipeline is different — three long-running sessions answer to filesystem events, each one waking when the previous one produces output. Nobody types prompts at the mining or review agents; the Clerk types prompts at them by dropping files.

## What it is

Three agents, three recipes, three roles:

| Agent | Recipe | Role |
|-------|--------|------|
| **Clerk** | `clerk.json` | Sits on a Zulip channel. Answers questions from the library. Files a ticket when the library falls short. |
| **Miner** | `knowledge-miner.json` | Deep research across Zulip / GitLab / the public web (Notion and Scribe if you add them). Produces draft reports with confidence markers. |
| **Reviewer** | `knowledge-reviewer.json` | Critic pass over miner output. Produces SME checklists and review notes. |

The Clerk's recipe uses the `frontdesk` context strategy, a chat-oriented variant of autobiographical memory: each channel message carries a provenance header (channel, topic, author, time), and compression follows Zulip topics and keeps unanswered questions and @mentions.

The three are coupled by **file events**, not by IPC, HTTP, or a message queue. Each agent's output directory is another agent's watched input. A write on one end wakes an inference on the other.

```
           ┌────────────────────────── Zulip #${ZULIP_CHANNEL} ─────────────────────────┐
           │                                                                            │
           ▼                                                                            │
       ┌────────┐                    ┌─────────┐                    ┌──────────┐        │
       │ CLERK  │ ── ticket ──▶      │  MINER  │ ── draft ──▶       │ REVIEWER │        │
       │        │  knowledge-        │         │   output/          │          │        │
       │        │  requests/         │         │                    │          │        │
       │        │                    │         │                    │          │        │
       │        │  ◀─────────────── review ────────────────────────  │          │        │
       │        │     review-output/                                 │          │        │
       └────────┘                    └─────────┘                    └──────────┘        │
           │                                                                            │
           └────────────────────────── answer posted ──────────────────────────────────┘
```

Clerk reads both `output/` (mined drafts) and `review-output/` (reviewed material) as its "library"; writes tickets to `knowledge-requests/`. Miner reads `knowledge-requests/`, writes drafts to `output/`. Reviewer reads `output/`, writes to `review-output/`. All three also mount `library-approved/` read-only — human-sanctioned material they treat as ground truth; nothing in the pipeline writes to it. Every pair is a one-way wake loop: the producer materializes a file, the consumer's chokidar watcher fires, the consumer's event gate matches a wake policy, the consumer infers.

## Why run it this way

- **Separation of concerns.** Mining is deep and slow (large forks, heavy context). Reviewing is skeptical and linear (goes document by document). Fronting a chat channel must be fast and sourced. Collapsing these into one agent makes every one of them worse.
- **Loose coupling.** Filesystem-mediated handoffs mean each agent runs its own process, own session, own Chronicle store. You can restart or replace any one without touching the others.
- **Auditability.** Every handoff is a file on disk. You can read the ticket the Clerk filed, the report the Miner produced, the checklist the Reviewer wrote. Nothing is hidden in agent memory.

## Prerequisites

Start by reading [`../recipes/SETUP.md`](../recipes/SETUP.md) — it covers the credentials and MCP servers used by the Miner. The library pipeline needs the same setup plus a few extras.

You need all of:

- Bun, Node 20+, an Anthropic API key (from SETUP.md).
- **Zulip**: a bot account with API credentials, subscribed to the channel you want the Clerk to staff. Name that channel in `.env` as `ZULIP_CHANNEL` (e.g. `tracker-miner-f`) — `clerk.json` won't load without it. `.zuliprc` in the project directory.
- **Zulip MCP server** built and reachable at `../zulip_mcp/build/index.js`, the path both recipes reference (see SETUP.md Step 2).
- **Miner data sources**: the shipped miner recipe wires GitLab (set `GITLAB_TOKEN` / `GITLAB_API_URL` in `.env`, or remove the `gitlab` block) and DuckDuckGo web search (a sibling checkout). Notion and Scribe are opt-in — see SETUP.md.
- Three free terminal windows (or tmux panes, or `screen` windows) — one per agent. Or run all three under one conductor instead; see [the one-terminal alternative](#one-terminal-alternative-the-triumvirate) below.

## Directory layout

All three agents must launch with the **same working directory**, because their mounts all resolve relative to `process.cwd()`. They don't need to share their *data* directories — in fact they must not, because each agent's Chronicle store, sessions, and lessons are per-instance state.

A working layout:

```
connectome-host/
├── .zuliprc                        # Zulip bot credentials
├── recipes/
│   ├── clerk.json
│   ├── knowledge-miner.json
│   └── knowledge-reviewer.json
├── knowledge-requests/             # shared mount: tickets
├── output/                         # shared mount: mined drafts
├── review-output/                  # shared mount: reviewed artifacts
├── library-approved/               # shared read-only mount: human-approved material (you fill it)
├── input/                          # optional: seed material for miner
├── data-frontdesk/                 # Clerk's Chronicle, sessions, lessons
├── data-miner/                     # Miner's Chronicle, sessions, lessons
└── data-reviewer/                  # Reviewer's Chronicle, sessions, lessons
```

The three `data-*` directories are created on first run; you don't need to precreate them. The shared-mount directories can be empty — the agents populate all of them except `library-approved/`.

## The wake loop, concretely

Two mechanisms work together. If either is missing, the pipeline silently does nothing.

### 1. `autoMaterialize` on the producer side

By default, workspace writes in connectome-host stay in Chronicle and never hit disk until the agent calls `workspace--materialize`. That works for single-agent sessions, but it breaks cross-agent pipelines: a chokidar watcher on the consumer can only fire when a real file is written.

The producing mount must have `autoMaterialize: true`. Each `workspace--write` / `workspace--edit` / `workspace--delete` immediately reconciles to disk; the local watcher suppresses the self-echo so the producer doesn't wake on its own writes.

Verify in the recipe JSON:

- Clerk's `knowledge-requests` mount → `autoMaterialize: true` ✓
- Miner's `products` and `tickets` mounts → `autoMaterialize: true` ✓
- Reviewer's `products` mount → `autoMaterialize: true` ✓

### 2. `watch: 'always'` + `wakeOnChange` on the consumer side

The consumer mount must be watched and must declare which op types trigger a wake:

```json
{
  "name": "library-mined",
  "path": "./output",
  "mode": "read-only",
  "watch": "always",
  "wakeOnChange": ["created"]
}
```

(That's the Reviewer's view of the Miner's output.)

`wakeOnChange` takes an array of `"created" | "modified" | "deleted"`, or `true` for all three. The WorkspaceModule emits `workspace:created` / `workspace:modified` / `workspace:deleted` events carrying mount-prefixed paths.

### 3. A matching gate policy

An event arriving at the agent still has to pass the EventGate to cause an inference. Each recipe's `modules.wake.policies` contains the match rules. The important ones for the library pipeline:

```json
{
  "name": "new-reports",
  "match": {
    "scope": ["workspace:created"],
    "mount": "library-mined",
    "pathGlob": "library-mined/*.md"
  },
  "behavior": "always"
}
```

The `mount` field matches the mount name; `pathGlob` matches any of the event's paths. Both are optional but recommended — without them the policy fires on *every* file event for its scope.

The gate file lives on disk at `<DATA_DIR>/sessions/<session-id>/config/gate.json` — one per session. It is seeded from the recipe's `modules.wake` when the session first starts, then reconciled additively on every later start: recipe policies missing from the file are appended by name, while policies already there — including ones you added or edited — are left as they are (so is `default`). The gate re-reads the file when its mtime changes, checked at most once a second.

To change rules at runtime, prefer the framework's `wake_add_rule` / `wake_remove_rule` tools: they validate the rule, apply it immediately and persist it to that file. Recipes with `modules.workspace.configMount: true` (Miner and Clerk) also show the agent the directory as `_config/`, but that mount does not auto-materialize — a `workspace--edit _config/gate.json` stays in Chronicle and doesn't reach the file the gate reads until the mount is materialized.

### 4. Who wakes whom

| Trigger                                            | Fires in           | Policy name             |
|----------------------------------------------------|--------------------|-------------------------|
| Someone posts in Zulip `#${ZULIP_CHANNEL}`         | Clerk              | `tracker-channel`       |
| Clerk creates `knowledge-requests/*.md`            | Miner              | `new-tickets`           |
| Miner creates `output/*.md` (draft report)         | Reviewer           | `new-reports`           |
| Reviewer creates `review-output/*.md`              | Clerk              | `reviewed-responses`    |

The Clerk also carries a `ticket-resolutions` policy (wake on `workspace:modified` in `knowledge-requests/`), but nothing in the current flow modifies tickets — the Miner is told not to, and the Clerk's own edits don't wake it — so it fires only if a person or future tooling edits a ticket on disk.

Each agent's own wake policies are in its recipe — compare if you need to debug silent failures.

## Running the three

Launch each agent in its own terminal, same working directory, distinct `DATA_DIR`:

```bash
# Terminal 1 — Clerk (the one humans interact with through Zulip)
cd connectome-host
DATA_DIR=./data-frontdesk bun src/index.ts recipes/clerk.json

# Terminal 2 — Miner
cd connectome-host
DATA_DIR=./data-miner bun src/index.ts recipes/knowledge-miner.json

# Terminal 3 — Reviewer
cd connectome-host
DATA_DIR=./data-reviewer bun src/index.ts recipes/knowledge-reviewer.json
```

Order doesn't matter. The workspace's initial scan will catch any files that were written while an agent was offline: on startup each `watch: 'always'` mount does a one-shot `syncFromFs` diff against its Chronicle tree, firing `workspace:created` for files that are on disk but new to this session. So if the Miner was offline when the Clerk filed three tickets, the Miner will wake on those three tickets the moment it starts.

Nobody needs to type at the Miner or Reviewer, so you can run them with `--headless`: no TUI at all — the agent serves JSONL over `$DATA_DIR/ipc.sock` and logs to `$DATA_DIR/headless.log`. If you'd rather keep a prompt without OpenTUI taking over the terminal, `--no-tui` gives a plain readline interface instead.

### One-terminal alternative: the Triumvirate

`recipes/triumvirate.json` runs these same three recipes as fleet children under one conductor, from a single terminal: each child is its own process with its own data dir (`./data/miner`, `./data/reviewer`, `./data/clerk`), all launched from the conductor's working directory, so the mounts, wake policies and ticket contract on this page apply unchanged. Setup and day-to-day operation are in [`../recipes/TRIUMVIRATE-SETUP.md`](../recipes/TRIUMVIRATE-SETUP.md).

## The ticket contract

Agents coordinate through a schema, not a protocol. The ticket format is defined in `clerk.json`'s system prompt; the Miner and Reviewer prompts read from it but do not re-define it. Keep them in sync.

Filename: `YYYY-MM-DD-short-slug.md`, one ticket per file. The filename without `.md` is the ticket's `request_id`.

Frontmatter:

```yaml
---
request_id: 2026-04-20-retention-policy-for-packet-logs
filed: 2026-04-20T17:01:45Z
asker: Anton Kukushkin
asker_id: 12345
channel: tracker-miner-f
topic: general chat
origin: zulip#tracker-miner-f#general chat
message_link: <zulip message link or numeric ID>
status: open        # the Clerk only ever writes open
urgency: normal     # low | normal | high
---
```

Body sections (required, in order): `## Question`, `## Search Trail`, `## Specific Unknowns`, `## Notes`.

**Ownership:** the Clerk files tickets at `status: open` and doesn't change their status afterwards (it may append to `## Notes` when the same question comes up again). The Miner reads tickets but is told not to edit them — neither the frontmatter nor the file. Instead it writes one report per ticket, `products/<request_id>.md` in its view (`output/<request_id>.md` on disk), whose frontmatter copies the ticket's provenance (`request_id`, `asker`, `channel`, `topic`, `origin`, …). The Reviewer copies the same fields into its `review-<doc>.md`. Nothing in the current recipes closes tickets.

**Answers reach the asker via Zulip.** The path is Miner → Reviewer → Clerk: when a new file appears in `review-output/` the Clerk wakes (`reviewed-responses`), reads its frontmatter, and — if it carries a `request_id` and actually answers the question — posts on the original topic, @-mentioning the asker and citing the `library-reviewed:` path. Reviewed files without a `request_id` don't trigger a ping.

## Confidence markers — end-to-end

Every non-trivial claim in mined or reviewed material carries a marker:

| Marker | Meaning |
|--------|---------|
| `[SRC: source]` | Directly sourced from an internal system. Quote verbatim when citing. |
| `[WEB: url]` | Sourced from a public web page via the Miner's DuckDuckGo tools; the URL is the citation. Never overrides an internal `[SRC]` for an org-specific term. |
| `[INF]` | Inferred across sources. |
| `[GEN]` | General domain knowledge — no specific source. |
| `❓` | Knowledge gap — admission of "we don't know." |

Markers are written by the Miner, audited by the Reviewer (who looks especially for unmarked claims that *should* have been `[GEN]`), and preserved by the Clerk when citing in chat. **Never launder markers**: a `[GEN]` claim quoted without its tag becomes a confident assertion the Clerk didn't intend to make.

## Operational notes

### Adding a channel the Clerk listens to

Three things must line up — the Zulip subscription, the channel being open in the host, and a wake policy:

1. `mcpl--zulip--listen { channels: ["new-stream"] }` — subscribes the bot to the Zulip stream (server-side state, persists across restarts).
2. Make sure the channel is open on the host side. The Clerk's `channelSubscription` allow-list only covers `zulip:${ZULIP_CHANNEL}`, so other channels start closed unless the server marks them open. `channel_list` shows each channel's state; `channel_open { channelId: "zulip:new-stream" }` opens it (the id form may differ — use the one `channel_list` shows).
3. Add a wake policy with `wake_add_rule`:

   ```json
   {
     "name": "new-stream",
     "match": { "scope": ["mcpl:channel-incoming"], "channel": "zulip:new-stream" },
     "behavior": "always"
   }
   ```

An open channel without a policy means messages arrive in context but don't wake the Clerk; a policy without an open, subscribed channel means nothing arrives at all. `wake_add_rule` applies immediately — no restart.

The Clerk's own prompt covers steps 1 and 3 (`mcpl--zulip--listen`, then `wake_add_rule`) but not step 2, so if you ask the Clerk to add a channel, check `channel_list` as well as `gate_status` afterwards. A rule added this way persists in the session's `gate.json` across restarts. A recipe rule (such as `tracker-channel`) removed this way comes back at the next startup, because reconciliation re-appends recipe policies missing from the file.

### Removing a channel

Reverse order: remove the wake policy first (`wake_remove_rule { name: "new-stream" }`), then `channel_close` the channel so its messages stop reaching context, then `mcpl--zulip--unlisten` if the bot should leave the stream.

**Do not** unsubscribe the Clerk from `#${ZULIP_CHANNEL}` or remove the `tracker-channel` policy without explicit confirmation — it silences the only channel the Clerk is supposed to staff.

### Channel subscription blast radius

The Zulip MCPL server can register every public stream the bot can see — in a large org, 100+ streams. Every channel that is *open* feeds its messages into the agent's context, whether or not any policy wakes on them. Symptoms: an agent's next wake includes a 100K+ token burst of unrelated chat.

What opens channels initially is `channelSubscription` on the server entry:

```json
"zulip": {
  "command": "node",
  "args": ["../zulip_mcp/build/index.js"],
  "env": { "...": "..." },
  "channelSubscription": "manual"
}
```

Values: `"auto"` (everything opens), `"manual"` (nothing opens unless the server marks it open; the agent opens channels explicitly), or `string[]` (allow-list of channel ids). If the field is omitted, the framework now defaults to `"manual"`. The Clerk uses an allow-list, `["zulip:${ZULIP_CHANNEL}"]`, so only its own channel opens; the Miner is `"manual"`; the Reviewer has no Zulip server.

In agent-framework 0.21 the field is only a seed. Each channel's open/closed state is persisted in the session's Chronicle store, and after that the agent's `channel_open` / `channel_close` calls decide it — they outrank the recipe. Narrowing `channelSubscription` later won't close a channel an existing session already has open; close it with `channel_close`, or start a fresh session.

### Lessons don't cross agents

Each data dir has its own `lessons.json`. The Miner's extracted lessons are not visible to the Clerk. This is intentional — the library (files on disk) is the shared knowledge, not the lesson store. Use lessons for meta-observations about each role ("tickets about X usually need Y"), not facts that belong in the library.

## Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| Clerk files tickets but Miner never wakes | Producer missing `autoMaterialize`, or consumer missing `watch: 'always'` + `wakeOnChange` | `ls knowledge-requests/` — files on disk? If yes, check Miner's recipe for those two flags. |
| Miner wakes but never runs | Event reaching the gate but no policy matching it | In the Miner, run `gate_status`. If `defaultDecisions.byEventType["workspace:created"].skipped > 0` and no policy's `matchCount` went up, the policy's `mount` or `pathGlob` doesn't match. |
| Fresh session sees empty directories | Gate initial-scan didn't run, or the mount isn't `watch: 'always'` | Check `workspace--status` — `initialSyncDone: false` means watchers haven't started. |
| Clerk was silent through a known question | Zulip subscription, the channel's open state, or the `tracker-channel` policy was removed | `mcpl--zulip--listen` with no args shows subscribed streams; `channel_list` shows whether `zulip:${ZULIP_CHANNEL}` is still open; `gate_status` shows the active policies. |
| An agent's context is flooded with Zulip chat it doesn't care about | Channels were opened earlier (by the agent, or seeded by an `"auto"` policy) and stay open | `channel_list` to see them, `channel_close` to close them. Changing `channelSubscription` in the recipe won't close channels in an existing session. |
| Three-agent pipeline works on one machine, breaks on another | Agents launched from different working directories | All three must share `cwd`. `./knowledge-requests` resolves to three different paths otherwise. |
| Tickets pile up, Miner is "busy" but never writes reports | Miner is context-saturated, or wedged on a long fork | `/status` in the Miner's TUI; `Tab` for fleet view to see if forks are actually progressing. |
| Clerk posts answers but cites `[GEN]` claims as facts | Prompt drift; retrain or re-read the clerk prompt | The clerk prompt explicitly forbids this — if it happens, regenerate the session with `/session new` and re-verify. |

### Diagnosing a silent wake failure

Three specific things to check, in order:

1. **Is the file on disk?** `ls` the producer's output directory. If the producer's mount lacks `autoMaterialize`, the file exists only in Chronicle and no event will ever fire.
2. **Is the watcher running?** In the consumer, `workspace--status` should show `initialSyncDone: true` for the watched mount. If it's `false`, watcher setup didn't complete.
3. **Is the gate dropping the event?** In the consumer, `gate_status` returns per-policy `matchCount` and an aggregate `defaultDecisions.byEventType`. If `workspace:created`'s `skipped` count is non-zero but the target policy's `matchCount` didn't change, the policy is there but the match fields don't cover the actual event.

A non-zero `skipped` without a matching policy is the fingerprint of a mount-name or pathGlob mismatch — the event arrived, the gate looked at it, no policy claimed it.

## Extending the pipeline

The schema-through-files pattern generalizes. A few natural extensions:

- **Miner-manager** — polls `knowledge-requests/` for `status: open`, spawns a bounded number of miner sessions, marks tickets `in-progress`, and writes resolutions. Currently nothing does this: the one Miner wakes on every new ticket and leaves ticket status alone. A manager would make dispatch policy (priority, concurrency, deduplication) explicit and give tickets a real lifecycle.
- **Specialist miners** — one miner per source (Zulip-only, GitLab-only, Notion-only) with distinct recipes. The manager routes tickets by `topic` or by heuristics in the request body. Each specialist's lesson store accumulates source-specific expertise.
- **Synthesis reviewer** — a second reviewer that specifically checks cross-document consistency (the current reviewer is intra-document). Would watch `review-output/` and write to `review-output/meta/`.

The constraint for any new member: one mount points at the producer's output with `watch: 'always'` + `wakeOnChange`, and one gate policy matches that scope. That's the whole protocol.
