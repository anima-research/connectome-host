# Changelog

## Unreleased

### Fixed

- **TUI bug sweep** (#64): operator-safety and observability fixes.
  - `/quit` confirm no longer treats arbitrary input as consent — only an
    explicit `y`/`yes` (or re-typed `/quit`) kills fleet children, `d`
    detaches, anything else cancels; a typed-through message is restored to
    the input (paste referents intact) instead of discarded. Ctrl+C now goes
    through the same confirmation; a second Ctrl+C force-quits.
  - `/checkpoint` records the message position and `/restore` branches back
    to it (previously restored to the branch head — rolling back nothing);
    repeat restores at the same position are a no-op, and an unreachable
    position degrades to the branch head with an explicit note.
  - Session switch fully resets TUI observability state (tree aggregator,
    stream subscriptions, per-agent caches) — fleet subtrees no longer
    freeze after `/session switch`.
  - Memory: peek logs / transcripts / scrollback capped, and detached
    renderables are `destroy()`ed so their native text buffers are actually
    freed (the fleet view leaked one buffer per line per 500ms repaint).
  - Agent-name resolution is exact (`shortAgentName`, fork `-d{depth}`
    scheme included) instead of substring matching that cross-wired agents
    with prefix-overlapping names; peek tails no longer clip the newest
    lines; fleet-view kill/restart failures are surfaced; per-round context
    size (`ctx:`) and session totals (`Σ`) are separate status segments;
    synesthete summaries moved off the render path and back off 30s after
    a failed call instead of retrying at 2 Hz.
  - Smaller UX: peek works on finished subagents (final runtime shown),
    fork `done` summaries always print a chat line, Esc/Ctrl+B work from
    the fleet view, paste placeholders survive `]` in the pasted text,
    `/help` documents `/find` and `/branchto`, `/clear` with arguments
    clears.

### Docs

- Synced stale documentation with the current build: repos marked public
  (AGENT-ONBOARDING), `forking-knowledge-miner` → `connectome-host`
  naming, webui default port corrected to 7340, DEV-ENVIRONMENT
  branch/version table refreshed (all feature branches merged),
  LOCUS-ROUTING and both root plan docs marked implemented.

## 0.3.10 — 2026-07-21

### Added

- **Provider transports**: `provider: "bedrock"` for legacy Claude models
  (3.5 Sonnet 0620/1022, Opus 3) surviving on AWS APAC after Anthropic API
  retirement — AWS_* env credentials, model-ID mapping via membrane, prompt
  caching forced off (legacy models reject `cache_control`; verified live).
  `provider: "openai-codex"` (ChatGPT subscription, device-code login,
  `/fast` toggle) and `provider: "openrouter"` formalized with validation.
- **Bedrock wire logging**: `LoggingBedrockAdapter` writes
  `llm-calls.<iso>.jsonl` on the bedrock path — tool names per request,
  stop_reason + block shapes per response, raw request retained on errors.
- **Prefill-era bot migration**: recipe `agent.formatter: "anthropic-xml"`
  (membrane classic prefill) + `agent.prefillUserMessage` scaffold — together
  reproduce a chapterx borg's exact prompting structure inside a resident
  (first used for the Supreme Sonnet isekai, 2026-07-21).

- Contribution policy: `CONTRIBUTING.md` (how changes land, review process,
  AI-attribution convention, changelog rules — binding for PRs and direct
  pushes, humans and AIs alike) and a PR template.
- CI `changelog` check: PRs touching `src/` must also touch `CHANGELOG.md`,
  opt out with the `no-changelog` label. The publish workflow now refuses to
  release a `vX.Y.Z` tag with no matching `## X.Y.Z` changelog section.
- Release mechanics automated: `npm version <level>` cuts `Unreleased` into
  `## X.Y.Z — date` via the `version` hook (`scripts/release-changelog.ts`),
  and on release tags CI creates the GitHub release with that section as
  its notes — independent of the npm publish job, so notes exist for
  github-clone consumers even when a publish fails.
- **Web UI observability catch-up**: `ops:alert` traces render as persistent
  banner rows in the SPA (compression quarantine, refusal streaks,
  inference-exhausted; `<kind>-clear` stands them down); a Health sidebar tab
  polls `/healthz` for per-agent status, failure streaks, refusal stats,
  runtime settings, and quarantine, and reconciles durable-state alerts on
  connect. New protocol frames `request-branches`/`branches-list` back a
  Chronicle branch-lineage panel opened from the header branch chip, with
  checkout via the existing `/checkout` command path (read-only for
  observers; listing rides the `messages` scope). The `/curve` link now
  lives in the Context panel header.
- **TUI modernization**: `p` on an agent inside a fleet child opens an
  honest per-agent peek — the child's event stream filtered by `agentName`,
  covering the child's root agent and its subagents (sub-subagents of the
  parent), with phase/tokens/task header from the tree reducer. `ops:alert`
  traces from the local framework AND from every fleet child surface as red
  chat lines plus a persistent `⚠ N alerts` status-bar segment; all-clears
  stand alerts down. The token line now shows the session cost estimate
  when priced.

### Fixed

- Dead `PlaceholderPanel` removed from the SPA; stale doc pointers
  (`WEBUI-PLAN.md`, knowledge-miner references) corrected; README now
  documents the web UI, headless mode, and current TUI peek semantics.

## 0.3.2 — 2026-07-14

Retro-filed: 0.3.1–0.3.9 predate the changelog policy and were released
without cutting this file; only the entry below was recorded at the time.

### Breaking (recipe authors only)

- `modules.fleet.children[].recipe` paths now resolve at recipe-load time
  against the **directory of the parent recipe file** (or URL base) rather
  than `process.cwd()`. Absolute paths and `http(s)://` URLs pass through
  unchanged. This makes recipe bundles portable: a parent file and its
  sibling children can live anywhere on disk and be launched from any CWD.

  **Who needs to act**: anyone maintaining a forked or custom
  triumvirate-style recipe that hard-codes child paths with a `recipes/`
  prefix (or any prefix anchored at `connectome-host/`'s CWD). After
  upgrade, `"recipes/knowledge-miner.json"` inside
  `<somewhere>/my-recipe.json` resolves to
  `<somewhere>/recipes/knowledge-miner.json`, which is almost certainly
  not what's intended.

  **Migration**: drop the `recipes/` prefix so the child is referenced as a
  sibling of the parent file (e.g. `"knowledge-miner.json"` or
  `"./knowledge-miner.json"`). No files need to move on disk. The
  in-tree `recipes/triumvirate.json` has already been updated.

  **Unchanged**: `dataDir`, workspace mount paths, and child process CWD
  stay CWD-relative (these are runtime paths, not authoring references).
  `fleet--launch` invocations from the conductor are still matched
  CWD-relative at dispatch time, so existing system prompts that document
  CWD-relative paths continue to work.
