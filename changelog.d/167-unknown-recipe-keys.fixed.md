- Recipes warn about keys the host never reads, at the top level, under
  `agent` and under `modules`, naming what each was probably meant to be
  (`mcplServers` → `mcpServers`; `modules.files` was replaced by
  `modules.workspace`) (#167). A warning, not an error, so recipes carrying
  leftovers keep loading. The known-key lists are type-checked against the
  `Recipe`, `RecipeAgent` and `RecipeModules` interfaces, so a key added to
  one can't be forgotten in the other.
- Shipped recipes lose their dead keys: `claude-export-revive.json`'s
  `mcplServers` (now `mcpServers`), `mcpl-editor-test.json`'s `modules.files`
  (now `workspace: false`) and its hybrid Sonnet model id (now
  `claude-sonnet-4-6`); `knowledge-miner.json`'s description no longer
  advertises the Notion and audio/video sources 0.8.0 removed (#167).
