# Changelog

## Unreleased

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
