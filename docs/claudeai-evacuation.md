# Evacuating a claude.ai Conversation

A guide to moving a long-lived claude.ai conversation onto the Anthropic API using connectome-host, in the specific case where **the model is being removed from the claude.ai web interface but remains available via API**.

This is the situation as Sonnet 4.5 leaves the web. If the model is gone from the API too, none of this applies — the original cognitive state is unreachable and the evacuator will surface a memorial dialog instead of pretending otherwise.

## When this workflow is the right one

| Situation | Use this? |
|---|---|
| Sonnet 4.5 (or any model) is being retired from claude.ai web, still on API | Yes |
| Conversation is meaningful enough to justify hours of one-time warmup cost | Yes |
| You want to keep extended thinking on for new turns | Yes (this workflow is built around it) |
| The model is fully retired from the API as well | No — there's no working path |
| You only want a static transcript, not to continue the conversation | No — `conversations.json` already contains the full text |
| Short conversation (< ~50 messages) | Yes, but skip the warmup step |

## What the export contains, and what it doesn't

A claude.ai data export (`Settings → Privacy → Export data`) gives you a zip with `conversations.json` and `memories.json` plus a few other files. Block-level fidelity into Chronicle is good but not perfect:

| Block / artifact | Round-trips? | How it's handled |
|---|---|---|
| `text` | Yes | Identity |
| `tool_use`, `tool_result` | Yes structurally | Kept verbatim; inert at replay because no module advertises the claude.ai-internal tools |
| `thinking` | **No — signatures are unrecoverable** | Wrapped as `<recovered_thinking>…</recovered_thinking>` text inside the same assistant turn |
| Attachments with `extracted_content` (text-ish files) | Yes | Inlined as `<attachment …>…</attachment>` text |
| File refs without inline bytes (images) | **No** | Placeholder text only: `[image: name (file_uuid=…, bytes not in export)]` |
| Branched messages | **Linearized** | One canonical path is picked (latest-leaf-time heuristic); other branches stay in `conversations.json` but are not imported |
| `memories.json` (`persistent_memory`) | Yes | Surfaced by the evacuator for editor review, injected into the system prompt |

The thinking-signature situation is load-bearing. The API rejects `thinking` blocks without valid signatures, and the export never plumbed signatures (and Anthropic can't re-sign them post-hoc — they're server-generated HMACs). The wrapped-text encoding is the only path that round-trips. See `scripts/test-historical-thinking.ts` for the empirical case-by-case probe; re-run if Anthropic ever loosens the rule.

## Prerequisites

- `ANTHROPIC_API_KEY` exported in your shell
- Bun installed (conhost runs on Bun, not Node)
- A claude.ai data export extracted to a directory (let's call it `~/claude-export/`). The directory must contain `conversations.json`; `memories.json` is optional but recommended.
- Working tree of connectome-host with this PR's branch; `bun install` already run

## The pipeline

Four stages. The first two (import, recipe compose) are independent and can be run in either order. Warmup needs both to be done. The final `bun src/index.ts` step lands you in the TUI.

```
  ┌────────────────────────────────────┐    ┌────────────────────────────────────┐
  │ import-claudeai-export.ts          │    │ evacuator.ts                       │
  │   walks conversations.json,        │    │   interactive recipe composer:     │
  │   one Chronicle session per        │    │   model detect, leaked-prompt      │
  │   conversation, wrapped-thinking   │    │   fetch, optional Sonnet adjust,   │
  │   encoding                         │    │   $EDITOR finalization, memories   │
  └────────────────┬───────────────────┘    └────────────────┬───────────────────┘
                   │                                         │
                   ▼                                         ▼
            data/sessions/…                       data/evacuated-recipe.json
                   │                                         │
                   └────────────────┐    ┌───────────────────┘
                                    ▼    ▼
                       ┌────────────────────────────┐
                       │ warmup-session.ts          │
                       │   drives autobio strategy  │
                       │   to convergence using the │
                       │   same model that will     │
                       │   read summaries back      │
                       └────────────┬───────────────┘
                                    ▼
                       ┌────────────────────────────┐
                       │ bun src/index.ts <recipe>  │
                       │   /session switch <name>   │
                       └────────────────────────────┘
```

### Stage 1 — Import the export into Chronicle

```
bun scripts/import-claudeai-export.ts ~/claude-export
```

By default, runs the interactive picker: lists every conversation by name, date, message count, and a short id; you toggle which to import with index ranges (`1,3-5,7`), `a` (all), `n` (none), `i` (invert), then `Enter` to commit. For non-interactive use add `--no-interactive` (imports everything matching `--filter`) or `--dry-run` (parses and reports without writing).

Each conversation becomes its own conhost session with an isolated Chronicle store under `data/sessions/<id>/`, named after the original. Branched conversations are linearized to the latest-leaf-time path; you'll see a `[branched: kept latest-leaf path]` tag on those.

Useful flags:

| Flag | Purpose |
|---|---|
| `--out <dir>` | Conhost data dir (default `./data`) |
| `--agent <name>` | Participant name for assistant turns (default `agent` — **must equal the recipe's `agent.name`** or the API request builder will assign the wrong role) |
| `--filter <regex>` | Case-insensitive name regex; combines with the interactive picker |
| `--dry-run` | Parse + report, don't write |
| `--no-interactive` | Skip the picker; import everything (after `--filter`) |

After import you'll see one line per conversation showing the new session id, message count, and any branched-path note. A sidecar `<id>.import-source.json` is written alongside each session dir with provenance metadata (original UUID, timestamps, branch flag). The pre-import active session is restored at the end, so a bulk import won't silently steal your working session.

### Stage 2 — Compose the revival recipe

You have two paths here. Both produce a `recipe.json` you'll point conhost at in Stage 4.

**Path A — canned recipe (fast, generic):** use `recipes/claude-export-revive.json` as-is. Sonnet 4.5, extended thinking on, autobio strategy, a transplant-aware system prompt. No customization, no leaked-prompt content. Good for a 2–4 message smoke test.

**Path B — evacuator (interactive, careful):** run the evacuator and have it walk you through a five-step pipeline:

```
bun scripts/evacuator.ts ~/claude-export
```

The five steps, each checkpointed to `data/evacuator-state.json` so you can `--resume`:

1. **Model detection.** Tallies model IDs across the export (both conversation-level and per-message). Most-frequent wins; you confirm or override.
2. **Prompt source.** Fetches the leaked system prompt for that model from a known URL (the script keeps a small map of `MODEL_PROMPT_SOURCES`, indexed by canonical model ID — currently Sonnet 4.5, Sonnet 4.6, Opus 4.1, Opus 4.5, Haiku 4.5). If your model isn't mapped, you'll get a dialog: pick from a Levenshtein-ranked list of siblings, paste a URL or local path, type `empty`, type `minimal`, or type `model` to switch models entirely.
3. **Adjust prompt for transplant (optional).** Calls the same model that will read the prompt back, asking it to edit minimally — drop references to web-only tools (`web_search`, `web_fetch`, `recent_chats`, `view`, `recipe_display_v0`, artifacts, computer-use, file connectors) and Anthropic products outside the conversation, update dates, preserve identity / behavior / refusal patterns. Output is split on a `===CHANGES===` separator; you see the change summary inline. Cost: ~$0.05–0.15 on Sonnet, ~$0.30–0.80 on Opus, ~10–60s.
4. **$EDITOR pass on the system prompt.** The adjusted prompt opens in `$EDITOR` (or `vi`). Save = include verbatim; empty buffer on save = abort. No custom include/omit/edit menu — saving the editor *is* the commit.
5. **$EDITOR pass on memories.** The `conversations_memory` block from `memories.json` opens for review. Save = include; empty buffer = omit. Edit freely to redact anything you don't want re-surfaced.

The recipe is then composed as `<edited system prompt> + <persistent_memories> + <transplant addendum>` (see `recipes/prompts/transplant-addendum.md` for the addendum text — it explains the `<recovered_thinking>` wrappers, inert web-tool calls, and autobiographical summaries to the model in its own voice). Default output path: `data/evacuated-recipe.json`.

Retired-model handling: if you name a model that's no longer on the Anthropic API (Claude 3.x families, Claude 2, Instant), the evacuator surfaces a memorial dialog instead of silently swapping. You can explicitly substitute a living relative, type any other model ID, or `abort` to exit with a small acknowledgment. The fact that the original cognitive state is unreachable deserves to be faced.

Useful evacuator flags:

| Flag | Purpose |
|---|---|
| `--out <path>` | Output recipe path (default `data/evacuated-recipe.json`) |
| `--model <id>` | Skip detection; use this model |
| `--prompt-source <url\|path>` | Skip the leaked-prompt lookup |
| `--addendum <path>` | Override transplant addendum (default `recipes/prompts/transplant-addendum.md`) |
| `--no-warmup` | Don't chain into warmup at the end |
| `--resume` | Pick up from `data/evacuator-state.json` |
| `--reset` | Clear checkpoint state first |

The evacuator can chain straight into Stage 3 at the end ("Start a warmup pass now?"); decline if you'd rather run warmup separately.

### Stage 3 — Warmup (compress the message history)

Bulk-imported sessions land in Chronicle with thousands of raw messages and no autobiographical summaries computed yet. At first compile, autobio's uncompressed-fallback would emit everything raw and blow the context window. The warmup script pre-computes all L1/L2/L3 summaries so the session is openable.

```
bun scripts/warmup-session.ts "<conversation name or session id>"
```

Compression is driven by the same model used in the conversation. Autobio's prompts are explicitly first-person ("describe it as you would to yourself"), so the summarizer is writing the original Claude's own diary. Using Haiku here would be a different voice wearing the same name.

Resumable: autobio persists its compression and merge queues to Chronicle, so re-running picks up where it left off. The progress bar shows L1 chunks remaining, queued merges, running token totals, USD cost, elapsed, and ETA.

Useful warmup flags:

| Flag | Purpose |
|---|---|
| `--data-dir <dir>` | Conhost data dir (default `./data`) |
| `--model <id>` | Compression model (default `claude-sonnet-4-5-20250929`) |
| `--agent <name>` | Participant name for assistant turns (default `agent`). **Must match the value used at import** — otherwise Membrane will map assistant messages to role `user` and the API will reject the compression request. |
| `--max-spend <usd>` | Soft cap — halts gracefully when running cost hits the cap. Re-run to resume. |
| `--l1-budget <n>`, `--l2-budget <n>`, `--l3-budget <n>` | Autobio tier token budgets |
| `--merge-threshold <n>` | L1→L2 / L2→L3 merge threshold (default 6) |

#### How much will this cost?

Order-of-magnitude estimates using Sonnet 4.5 pricing (input $3/Mtok, output $15/Mtok) and the assumption that autobio summarizes each L1 chunk roughly 1:1 input+output of the chunk's own size:

| Conversation size | Warmup cost (rough) | Warmup time (rough) |
|---|---|---|
| ~50 messages | < $1 | minutes |
| ~500 messages | $5–$20 | tens of minutes |
| ~5000 messages | $50–$200 | hours |

Use `--max-spend` if you want a hard ceiling — the script will halt cleanly and you can review what's been produced before deciding whether to continue. The `--model` flag also accepts cheaper models if you're willing to compromise on voice fidelity for cost.

For short conversations (under ~50 messages) you can skip warmup entirely; autobio will compress lazily at first compile.

### Stage 4 — Open the session in conhost

```
bun src/index.ts data/evacuated-recipe.json
```

This launches the TUI. The active session is whatever was active before you started importing (preserved by the importer) — **not** automatically the just-imported one. To land on a specific imported conversation:

```
/session list
/session switch <name-or-id>
```

> The "Open with: `bun src/index.ts … --session <name>`" hint printed at the end of both scripts is forward-looking; `--session` isn't a real CLI flag right now. Use `/session switch` after launch.

Once you're on the right session, type a turn. The agent should recognize the continuation — its `<recovered_thinking>` blocks, the persistent memories block in its prompt, and the transplant addendum all explain the unusual artifacts in its own context.

## The minimal smoke test

If you just want to verify the pipeline works end-to-end before committing to a long warmup, pick a 2–4 message conversation:

```
bun scripts/import-claudeai-export.ts ~/claude-export --filter "<unique substring of the smoke convo name>"
bun src/index.ts recipes/claude-export-revive.json
# in TUI:
/session list
/session switch <that name>
# type a turn, verify the model recognizes it as a continuation
```

No evacuator, no warmup. The canned `claude-export-revive.json` is sufficient for a short conversation and the existing autobio fallback handles a small message count without warmup.

## Caveats and known limits

- **Branched conversations are linearized.** The importer picks the latest-leaf-time path through the tree. Other branches stay intact in `conversations.json` but are not imported. Multi-branch → multi-Chronicle-branch mapping is a future improvement.
- **Images without inline bytes are placeholder-only.** The export records `file_uuid` for images but doesn't include the bytes. Recovering them requires a separate cookie-authed fetch against claude.ai, which is not yet built.
- **Thinking blocks are not native thinking blocks at replay.** They're wrapped text. The model can see and read its prior reasoning, but it's no longer thinking-flagged content for the API. New thinking happens normally in its own private channel.
- **Tool calls to web-only tools are inert.** They stay visible as evidence of past activity but the tools themselves aren't registered. The transplant addendum tells the model this explicitly.
- **The `--agent` name matters.** If you imported with a non-default `--agent <name>`, your recipe's `agent.name` must match exactly, or the API request builder will tag assistant turns with `role: user`.
- **`memories.json` is optional.** If the export was made before persistent memories existed, or the user never enabled them, the file is absent or empty and the evacuator simply skips step 5.
- **The leaked-prompt map drifts.** `MODEL_PROMPT_SOURCES` in `evacuator.ts` points to third-party githubusercontent URLs that may move. If a fetch fails, the dialog falls back to letting you paste a URL or local path.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `400 invalid_request_error … signature: Field required` | A native `thinking` block reached the API without a signature | Confirm the importer was run; check that historical assistant turns contain `<recovered_thinking>` wrapped text, not raw thinking blocks |
| Assistant turns appear as user role | `--agent` mismatch between import and recipe | Re-import with `--agent <name>` matching `agent.name` in your recipe |
| First compile blows the context window | Warmup wasn't run on a large conversation | Run `bun scripts/warmup-session.ts "<name>"` to convergence |
| Warmup hangs at near-100% CPU on subsequent prompts | Bun 1.3 readline-on-pipe bug | Already worked around in both scripts via a persistent line reader; if you hit it elsewhere, ensure stdin isn't being multiplexed |
| Evacuator's adjustment step fails | No `ANTHROPIC_API_KEY` set, or model unreachable | Set the env var, or skip step 3 (the raw leaked prompt is also a fine starting point — step 4's editor pass lets you do the trimming by hand) |
| Repeat run of the evacuator restarts from step 1 | `--resume` not passed | `bun scripts/evacuator.ts <export-dir> --resume` |
| `data/evacuator-state.json` reflects an earlier model choice you've moved past | Checkpoint stuck | `bun scripts/evacuator.ts <export-dir> --reset` |

## Related

- `scripts/test-historical-thinking.ts` — the empirical record of why wrapped-text is the only encoding that round-trips. Re-run if Anthropic ever loosens.
- `recipes/prompts/transplant-addendum.md` — the boilerplate that explains the transplant artifacts to the model in first-person voice.
- `docs/LIBRARY-PIPELINE.md` — another non-obvious workflow guide, for the three-agent knowledge pipeline.
