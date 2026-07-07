# Changelog

## Unreleased

### Fragility audit hardening (Jul 2026)

Fixes for ~25 findings from the five-way fragility audit
(`UNTESTED-ROUTES-TEST-PLAN.md`, Groups 1–4 + 6.4). Highlights:

- **Lifecycle/shutdown**: SIGTERM/SIGINT now run the graceful path in TUI
  and `--no-tui` modes (previously headless-only); headless refuses to
  double-start on a live data dir (PID probe); graceful shutdown races
  `framework.stop()` against a 15 s deadline and always unlinks pid/socket;
  a second signal force-exits; `/session switch` rolls back on failure and
  re-binds trace forwarding (headless sockets previously went dark).
- **Fleet/subagent**: autoRestart flap cap survives respawns; fork
  materialisation no longer synthesizes orphaned sibling `tool_use` blocks;
  error classification no longer keys on bare substrings (`"502"` inside a
  token count, `"rate"` inside "generate"); zombie reclaim no longer
  double-releases concurrency slots; stale `returnedResults` no longer leak
  into later same-named subagents; adopted fleet children get pid-liveness
  crash detection; `handleLaunch` duplicate-name TOCTOU closed; aggregator
  describe latch times out and child subtrees reset on exit.
- **Lessons/retrieval**: shared `lessons.json` saves are read-merge-write +
  atomic (tmp+rename) — no more cross-process last-writer-wins clobber;
  corrupt files are backed up (`.corrupt-<ts>`), never silently overwritten;
  full-UUID lesson ids; `create` clamps confidence; global saves debounced
  with flush-on-stop; retrieval serves cached empty results, requests a 15 s
  `contextTimeoutMs` budget, cancels stale pipelines, and fails closed on
  validator parse failure (previously injected top-5 keyword matches).
- **Web UI**: `quit-confirm` now requires a server-side pending-quit token
  (any authed frame could previously SIGTERM the host); trace frames carry
  seq numbers and traces fired during welcome construction are buffered, not
  dropped; WS backpressure closes stuck clients; fleet-request timeouts fire
  on a timer; lessons frames capped at 500 entries.
- **Unbounded growth (6.4)**: llm-calls JSONL rotates at 10 MB; TUI
  transcript/peek-log maps capped; reducer `callIdIndex` evicts on terminal
  tool events; typing indicator clears on `inference:failed`/`exhausted`/
  `aborted` (previously stuck "typing" after any failed retry chain).

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
