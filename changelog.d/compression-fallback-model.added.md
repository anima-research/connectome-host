- **`agent.strategy.compressionFallbackModel`** (unset by default) passes
  context-manager's option of the same name: once `compressionModel` has
  refused a compression or a merge on every rung that keeps it writing the
  memory in full, the canonical request goes once more to the named model,
  before the split rung and before quarantine. The recipe refuses a value
  that isn't a non-empty string. It takes context-manager 0.28.0, which this
  release's dependency range starts at.
