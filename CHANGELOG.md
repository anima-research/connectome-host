# Changelog

## Unreleased

### Added

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
