- **Recipe authors:** a recipe with `"tuneOut": { "enabled": true }` is
  refused at load, naming agent-framework 0.33.0's removal of tune-out
  without a reader (agent-framework #959), and the store audit stops at it,
  a saved recipe's too, until it is fixed. On 0.22.0, with agent-framework
  0.32, such a recipe loaded and ran. **Migration:** remove
  `tuneOut.enabled`, and configure a `subconscious` to keep `tune_out`.
  `"enabled": false`, which agent-framework still accepts and ignores, and
  `tuneOut.announce` still load.
