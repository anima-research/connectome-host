- **Recipe authors:** a recipe with `"tuneOut": { "enabled": true }` is
  refused at load, naming agent-framework 0.33.0's removal of tune-out
  without a reader (agent-framework #959), and the store audit stops at it,
  a saved recipe's too (the data directory's hidden `.recipe.json`), until
  it is fixed. The audit's refusal of a recipe names its file, where it
  said only what was wrong with it. On 0.22.0, with agent-framework 0.32,
  such a recipe loaded and ran. **Migration:** remove `tuneOut.enabled`
  (from `.recipe.json` too, for a directory started with that recipe),
  and configure a `subconscious` to keep `tune_out`.
  `"enabled": false`, which agent-framework still accepts and ignores, and
  `tuneOut.announce` still load.
